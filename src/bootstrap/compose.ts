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
import { createModelCatalog } from '../models/catalog.js';
import { createBudgetLedger } from '../models/budget.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../persistence/work-runs.js';
import { createTaskRepository } from '../persistence/tasks.js';
import { createConversationRepository } from '../persistence/conversations.js';
import { createNotificationStore } from '../persistence/notifications.js';
import { createMemoryStore } from '../memory/store.js';
import { createPermissionStore } from '../permissions/store.js';
import { createAuditLog } from '../observability/audit.js';
import { createHealthService } from '../observability/health.js';
import { createEventBus } from '../events/bus.js';
import { createTaskRunner } from '../execution/runner.js';
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

export class StartupError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`The engine cannot start (${issues.length} blocking issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'StartupError';
    this.issues = issues;
  }
}

export type Application = {
  dependencies: ApplicationDependencies;
  service: ApplicationService;
  router: Router;
  server: HttpServer;
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

  const lease = createLeaseStore(createInMemoryWorkRunTable());
  const tasks = createTaskRepository();
  const conversations = createConversationRepository();
  const memory = createMemoryStore({ clock, maxValueLength: 20_000 });
  const permissions = createPermissionStore({ clock, ids });
  const notifications = createNotificationStore();
  const audit = createAuditLog({ clock, ids });
  const events = createEventBus({
    bufferSize: config.execution.eventBufferSize,
    eventId: ids.eventId,
    iso: clock.iso,
  });
  const runner = createTaskRunner({
    lease,
    clock,
    leaseTtlMs: config.execution.leaseTtlMs,
    heartbeatIntervalMs: config.execution.heartbeatIntervalMs,
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
        check: async () => ({ status: 'ok' as const, detail: 'Task and lease stores are available.' }),
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
    start: async () => {
      const { url } = await server.listen();
      // Startup ownership verification: a task whose lease died with a previous
      // process is retired now, so no client sees it as running forever.
      await service.recoverInterrupted();
      return { url };
    },
    stop: async () => {
      await service.shutdown();
      await server.close();
    },
  };
}

export { EXTERNAL_ISOLATION };
