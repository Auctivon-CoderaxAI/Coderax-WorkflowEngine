import type { AgentIsolation, EngineCapabilities, ModelDescriptor } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import { createClock, createIdGenerator } from '../support/clock.js';
import { createOwnerAuth, AuthConfigurationError } from '../security/auth.js';
import { createNativeAgent } from '../agents/native/agent.js';
import { createOpenAiCompatibleGateway } from '../agents/native/gateway.js';
import type { ModelGateway } from '../agents/native/types.js';
import { createExternalAgentAdapter } from '../agents/adapters/external.js';
import type { ExternalAgentTransport } from '../agents/adapters/external.js';
import type { AgentAdapter } from '../agents/types.js';
import { createAgentRegistry } from '../agents/registry.js';
import { probeAgents } from '../agents/probe.js';
import { createModelCatalog } from '../models/catalog.js';
import { createBudgetLedger } from '../models/budget.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createHealthService } from '../observability/health.js';
import { createEventBus } from '../events/bus.js';
import { createTaskRunner } from '../execution/runner.js';
import { createQuarantineRegistry } from '../execution/quarantine.js';
import { createTaskScheduler } from '../scheduling/scheduler.js';
import { createApplicationService } from '../orchestration/service.js';
import type { ApplicationService } from '../orchestration/service.js';
import { createRouteRegistry, createRouter } from '../api/router.js';
import type { Router } from '../api/router.js';
import { registerRoutes } from '../api/routes.js';
import { createHttpServer } from '../api/server.js';
import type { HttpServer } from '../api/server.js';
import { validateWorkspaceRoots, workspaceRoots } from '../execution/workspace.js';
import {
  createApplicationContainer,
  createDependencyContainer,
  type ApplicationDependencies,
  type InfrastructureDependencies,
} from './container.js';
import { buildPersistence } from './persistence.js';
import { createRetentionService } from '../persistence/retention.js';
import { StartupError } from './startup-error.js';

export { StartupError } from './startup-error.js';

export type Application = {
  dependencies: ApplicationDependencies;
  service: ApplicationService;
  router: Router;
  server: HttpServer;
  /** Which lease table the validated persistence setting selected. */
  persistence: { driver: 'memory' | 'mongo'; durable: boolean };
  /** Everything is validated before this resolves. */
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
};

export type ComposeInput = {
  config: EngineConfig;
  env?: NodeJS.ProcessEnv;
  /** Test and future-adapter injection; nothing here changes production defaults. */
  gateway?: ModelGateway | null;
  externals?: Partial<Record<'opencode' | 'freebuff', ExternalAgentTransport>>;
  fetchImpl?: typeof fetch;
  /**
   * Persistence injection for tests and for a host that owns its own driver. A
   * deployment that selects `mongo` without either of these still has to supply
   * a reachable connection string; nothing here weakens the startup gate.
   */
  persistence?: {
    database?: MongoDatabase;
    connect?: MongoConnector;
  };
};

const EXTERNAL_CAPABILITIES: EngineCapabilities = {
  streaming: true,
  tools: true,
  cancellation: true,
  resume: false,
  modelSelection: true,
  durable: true,
};

const EXTERNAL_ISOLATION: AgentIsolation = {
  workspace: 'isolated',
  memory: 'none',
  credentials: 'none',
  conversations: 'none',
};

function buildGateway(input: ComposeInput): ModelGateway | null {
  if (input.gateway !== undefined) return input.gateway;
  const env = input.env ?? process.env;
  const baseURL = env.CODERAX_INFERENCE_BASE_URL;
  const apiKey = env.CODERAX_INFERENCE_KEY;
  if (!baseURL || !apiKey) return null;
  return createOpenAiCompatibleGateway({
    baseURL,
    apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

function modelDescriptors(input: {
  config: EngineConfig;
  gateway: ModelGateway | null;
}): ModelDescriptor[] {
  return input.config.models.route.map((ref) => ({
    ref,
    label: `${ref.providerId} ${ref.modelId}`,
    costClass: 'free' as const,
    toolCalling: false,
    streaming: false,
    availability: input.gateway
      ? { available: true, reason: 'ready' as const, detail: 'Verified zero-cost endpoint.' }
      : {
          available: false,
          reason: 'not_configured' as const,
          detail: 'No zero-cost inference endpoint is configured.',
        },
  }));
}

/**
 * The composition root.
 *
 * Order matters and is explicit: configuration, identity, agents, routing,
 * persistence, execution, then the service, the route table and the transport.
 * Startup fails closed — an invalid configuration, an unusable workspace root, a
 * missing dependency or an incomplete route table stops the engine before it
 * accepts a request, and says which check failed.
 */
export async function composeApplication(input: ComposeInput): Promise<Application> {
  const env = input.env ?? process.env;
  const { config } = input;
  const clock = createClock();
  const ids = createIdGenerator();

  let auth;
  try {
    auth = createOwnerAuth({ config: config.auth, env });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      throw new StartupError([error.message]);
    }
    throw error;
  }

  const gateway = buildGateway(input);
  const native = createNativeAgent({ enabled: config.engines.native.enabled, gateway });

  const opencode = createExternalAgentAdapter({
    agent: 'opencode',
    engine: 'opencode',
    label: 'OpenCode Agent',
    enabled: config.engines.opencode.enabled,
    transport: input.externals?.opencode ?? null,
    missingDetail:
      'The OpenCode adapter needs an injected transport; the engine does not spawn or bundle an OpenCode server.',
    capabilities: EXTERNAL_CAPABILITIES,
  });

  const freebuff = createExternalAgentAdapter({
    agent: 'freebuff',
    engine: 'freebuff',
    label: 'FreeBuff Agent',
    enabled: config.engines.freebuff.enabled,
    transport: input.externals?.freebuff ?? null,
    missingDetail:
      'The FreeBuff adapter needs an injected SDK transport; Coderax Native does not depend on it.',
    capabilities: EXTERNAL_CAPABILITIES,
  });

  const adapters: AgentAdapter[] = [native, opencode, freebuff];
  const agents = createAgentRegistry({
    adapters,
    defaultAgent: config.engines.default === 'opencode'
      ? 'opencode'
      : config.engines.default === 'freebuff'
        ? 'freebuff'
        : 'coderax',
  });

  const models = createModelCatalog({
    descriptors: modelDescriptors({ config, gateway }),
    route: config.models.route,
    allowPaid: false,
  });

  const budget = createBudgetLedger({
    maxRequestsPerDay: config.models.dailyRequestBudget,
    maxTokensPerDay: config.models.dailyTokenBudget,
  });

  const persistence = await buildPersistence({
    config,
    env,
    clock,
    ids,
    ...(input.persistence ?? {}),
  });
  const lease = persistence.lease;
  const tasks = persistence.tasks;
  const conversations = persistence.conversations;
  const memory = persistence.memory;
  const permissions = persistence.permissions;
  const notifications = persistence.notifications;
  const audit = persistence.audit;
  const checkpoints = persistence.checkpoints;
  const idempotency = persistence.idempotency;
  const retention = createRetentionService({
    clock,
    config: config.retention,
    notifications,
    audit,
    permissions,
    checkpoints,
    idempotency,
  });
  const events = createEventBus({
    bufferSize: config.execution.eventBufferSize,
    eventId: ids.eventId,
    iso: clock.iso,
    log: persistence.events,
    retain: config.execution.eventRetain,
  });
  const quarantine = createQuarantineRegistry({
    ttlMs: config.execution.cancelQuarantineMs,
  });
  const runner = createTaskRunner({
    lease,
    clock,
    leaseTtlMs: config.execution.leaseTtlMs,
    heartbeatIntervalMs: config.execution.heartbeatIntervalMs,
    cleanupGraceMs: config.execution.cancelGraceMs,
    onAbandoned: ({ scope, generation, workspaceRoot }) => {
      // The adapter ignored its abort and may still be running. Nothing can kill
      // it in-process, so the root it can still write is taken out of service
      // until the quarantine expires.
      quarantine.poison({
        root: workspaceRoot,
        generation,
        taskId: scope.conversationId,
        reason: 'A cancelled adapter did not stop within the grace period.',
        now: clock.now().getTime(),
      });
    },
  });
  const scheduler = createTaskScheduler({ maxConcurrent: config.execution.maxConcurrentTasks });

  const health = createHealthService({
    clock,
    engines: () =>
      agents.list().agents.map((agent) => ({
        id: agent.engine,
        capabilities: agent.capabilities,
        availability: agent.availability,
      })),
    probes: [
      {
        name: 'configuration',
        required: true,
        check: async () => ({ status: 'ok' as const, detail: 'Configuration validated.' }),
      },
      {
        name: 'auth',
        required: true,
        check: async () => ({
          status: 'ok' as const,
          detail: 'Owner token is configured.',
        }),
      },
      {
        name: 'workspaces',
        required: true,
        check: async () => {
          const roots = await validateWorkspaceRoots(workspaceRoots(config.workspaces));
          return roots.ok
            ? { status: 'ok' as const, detail: 'Workspace roots are absolute, disjoint and exist.' }
            : { status: 'failed' as const, detail: roots.detail };
        },
      },
      {
        name: 'persistence',
        required: true,
        check: async () => {
          const health = await persistence.ping();
          return {
            status: health.ok ? ('ok' as const) : ('failed' as const),
            detail: `${health.detail} Round trip ${health.latencyMs} ms.`,
          };
        },
      },
      {
        name: 'engine',
        required: true,
        check: async () => {
          const available = agents
            .list()
            .agents.filter((agent) => agent.availability.available);
          return available.length > 0
            ? {
                status: 'ok' as const,
                detail: `${available.length} agent(s) available.`,
              }
            : {
                status: 'failed' as const,
                detail:
                  'No agent is available: configure a zero-cost inference endpoint or an injected external transport.',
              };
        },
      },
      {
        // Optional on purpose: an enabled external agent being down degrades the
        // report without stopping an engine that still has Native.
        name: 'agents',
        required: false,
        check: () => probeAgents({ adapters, timeoutMs: 2_000 }),
      },
      {
        // A quarantined workspace means an abandoned adapter may still be
        // writing there. New work in that root is refused until it expires.
        name: 'workspaces.quarantine',
        required: false,
        check: async () => {
          const entries = quarantine.list(clock.now().getTime());
          return entries.length === 0
            ? { status: 'ok' as const, detail: 'No workspace is quarantined.' }
            : {
                status: 'degraded' as const,
                detail: `${entries.length} workspace root(s) quarantined after an adapter ignored cancellation.`,
              };
        },
      },
    ],
  });

  const container = createDependencyContainer({
    config,
    clock,
    ids,
    auth,
    agents,
    models,
    budget,
    lease,
    tasks,
    conversations,
    memory,
    permissions,
    notifications,
    audit,
    events,
    runner,
    scheduler,
    health,
    quarantine,
    checkpoints,
    idempotency,
    retention,
    persistencePing: persistence.ping,
  });
  if (!container.dependencies) {
    throw new StartupError(
      container.missing.map((name) => `dependency ${name} was not provided`),
    );
  }
  const infrastructure: InfrastructureDependencies = container.dependencies;

  const service = createApplicationService({
    ...infrastructure,
  });

  const registry = createRouteRegistry();
  registerRoutes(registry, service);
  const missingRoutes = registry.missing();
  if (missingRoutes.length > 0) {
    throw new StartupError(
      missingRoutes.map((operationId) => `route ${operationId} is documented but not registered`),
    );
  }

  const router = createRouter({
    registry,
    auth,
    requestId: ids.requestId,
    now: () => clock.now().getTime(),
  });

  const finalContainer = createApplicationContainer({
    ...infrastructure,
    service,
    router,
  });
  if (!finalContainer.dependencies) {
    throw new StartupError(
      finalContainer.missing.map((name) => `dependency ${name} was not provided`),
    );
  }

  const rootCheck = await validateWorkspaceRoots(workspaceRoots(config.workspaces));
  if (!rootCheck.ok) {
    throw new StartupError([rootCheck.detail]);
  }
  const startupIssues = await health.verifyStartup();
  if (startupIssues.length > 0) {
    throw new StartupError(startupIssues);
  }
  health.markReady();

  const server = createHttpServer({
    router,
    host: config.server.host,
    port: config.server.port,
  });

  return {
    dependencies: finalContainer.dependencies,
    service,
    router,
    server,
    persistence: { driver: persistence.driver, durable: persistence.driver === 'mongo' },
    start: async () => {
      const { url } = await server.listen();
      // Startup ownership verification: a task whose lease died with a previous
      // process is retired now, so no client sees it as running forever.
      await service.recoverInterrupted();
      // Retention runs at startup and then on a bounded interval, so a database
      // that has been offline for a week is trimmed without an operator.
      await retention.run().catch(() => undefined);
      retention.start();
      return { url };
    },
    stop: async () => {
      retention.stop();
      await service.shutdown();
      await server.close();
      await persistence.close();
    },
  };
}

export { EXTERNAL_ISOLATION };
