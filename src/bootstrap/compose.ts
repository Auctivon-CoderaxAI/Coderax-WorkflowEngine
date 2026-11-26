import type { AgentIsolation, EngineCapabilities } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import { createClock, createIdGenerator } from '../support/clock.js';
import { createOwnerAuth, AuthConfigurationError } from '../security/auth.js';
import { createNativeAgent } from '../agents/native/agent.js';
import { createNativePlanner } from '../agents/native/planner.js';
import { createOpenAiCompatibleGateway } from '../agents/native/gateway.js';
import type { ModelGateway } from '../agents/native/types.js';
import { createOpenCodeHttpTransport } from '../agents/adapters/opencode.js';
import { createExternalAgentAdapter } from '../agents/adapters/external.js';
import type { ExternalAgentTransport } from '../agents/adapters/external.js';
import type { AgentAdapter } from '../agents/types.js';
import { createAgentRegistry } from '../agents/registry.js';
import { probeAgents } from '../agents/probe.js';
import { createRouterCatalog } from '../models/catalog.js';
import { createBudgetLedger } from '../models/budget.js';
import { createMongoQuotaStore } from '../models/quota.js';
import { createRouter as createModelRouter, type ProviderDescriptor } from '../models/router.js';
import { createRoutedGateway } from '../models/routed.js';
import { createKnowledgeStore, createOpenAiEmbeddingProvider } from '../knowledge/store.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { createToolRuntime } from '../tools/runtime.js';
import { attachMcpServers } from '../mcp/client.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createPermissionStore } from '../permissions/store.js';
import { createAuditLog } from '../observability/audit.js';
import { createHealthService } from '../observability/health.js';
import { createEventBus } from '../events/bus.js';
import { createTaskRunner } from '../execution/runner.js';
import { createExecutionSupervisor } from '../execution/supervisor.js';
import { createCapabilityBroker } from '../execution/capabilities.js';
import { createUnavailableIsolationProvider } from '../execution/termination.js';
import { createTaskScheduler } from '../scheduling/scheduler.js';
import { createTeamService } from '../orchestration/team.js';
import { createMemoryResourceLockStore, createMongoResourceLockStore } from '../execution/locks.js';
import { createApplicationService } from '../orchestration/service.js';
import type { ApplicationService } from '../orchestration/service.js';
import { createRouteRegistry, createRouter } from '../api/router.js';
import type { Router } from '../api/router.js';
import { registerRoutes } from '../api/routes.js';
import { createHttpServer } from '../api/server.js';
import type { HttpServer } from '../api/server.js';
import { validateWorkspaceRoots, workspaceRoots } from '../execution/workspace.js';
import { modelKey } from '@coderax/contracts';
import {
  createApplicationContainer,
  createDependencyContainer,
  type ApplicationDependencies,
  type InfrastructureDependencies,
} from './container.js';
import { buildPersistence } from './persistence.js';
import { StartupError } from './startup-error.js';

export { StartupError } from './startup-error.js';

export type Application = {
  dependencies: ApplicationDependencies;
  service: ApplicationService;
  router: Router;
  server: HttpServer;
  /** Which lease table the validated persistence setting selected. */
  persistence: { driver: 'memory' | 'mongo' };
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

/**
 * Providers are derived from the configured route. Every entry is free by
 * construction — there is no configuration field that can mark one paid — and
 * capability/quota evidence comes from `models.catalog` when the owner recorded
 * it. The router, not this function, decides which model serves a request.
 */
function modelProviders(input: {
  config: EngineConfig;
  gateway: ModelGateway | null;
}): ProviderDescriptor[] {
  const evidence = new Map(
    input.config.models.catalog.map((entry) => [
      `${entry.providerId}/${entry.modelId}`,
      entry,
    ]),
  );
  const providerIds = [...new Set(input.config.models.route.map((ref) => ref.providerId))];

  return providerIds.map((providerId) => {
    const models = input.config.models.route
      .filter((ref) => ref.providerId === providerId)
      .map((ref) => {
        const entry = evidence.get(modelKey(ref));
        return {
          ref,
          label: entry?.label ?? `${ref.providerId} ${ref.modelId}`,
          costClass: 'free' as const,
          profile: {
            coding: entry?.coding ?? 0.5,
            reasoning: entry?.reasoning ?? 0.5,
            speed: entry?.speed ?? 0.5,
            toolCalling: entry?.toolCalling ?? false,
            multimodal: entry?.multimodal ?? false,
            contextTokens: entry?.contextTokens ?? 8192,
          },
          availability: input.gateway
            ? { available: true, reason: 'ready' as const, detail: 'Verified zero-cost endpoint.' }
            : {
                available: false,
                reason: 'not_configured' as const,
                detail: 'No zero-cost inference endpoint is configured.',
              },
        };
      });
    const first = evidence.get(modelKey(models[0]?.ref ?? input.config.models.route[0]!));
    return {
      id: providerId,
      costEvidence: 'verified-free' as const,
      quota: {
        requestsPerMinute: first?.requestsPerMinute ?? 20,
        requestsPerDay: first?.requestsPerDay ?? 500,
        tokensPerDay: first?.tokensPerDay ?? 500_000,
      },
      models,
    };
  });
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
  const providers = modelProviders({ config, gateway });
  const modelRouter = createModelRouter({ providers });
  const gateways = new Map<string, ModelGateway>();
  if (gateway) {
    for (const provider of providers) gateways.set(provider.id, gateway);
  }
  const routedGateway =
    gateways.size > 0
      ? createRoutedGateway({
          router: modelRouter,
          gateways,
          maxFallbacks: config.models.maxFallbacks,
        })
      : null;
  const native = createNativeAgent({
    enabled: config.engines.native.enabled,
    gateway: routedGateway,
    planner: createNativePlanner(),
  });

  const opencodePassword = config.engines.opencode.passwordEnv
    ? env[config.engines.opencode.passwordEnv]
    : undefined;
  const opencodeModel = config.engines.opencode.model?.includes('/')
    ? {
        providerId: config.engines.opencode.model.split('/')[0] ?? '',
        modelId: config.engines.opencode.model.split('/').slice(1).join('/'),
      }
    : undefined;
  const opencodeTransport =
    input.externals?.opencode ??
    (config.engines.opencode.baseURL
      ? createOpenCodeHttpTransport({
          baseURL: config.engines.opencode.baseURL,
          ...(opencodePassword ? { password: opencodePassword } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
      : null);

  const opencode = createExternalAgentAdapter({
    agent: 'opencode',
    engine: 'opencode',
    label: 'OpenCode Agent',
    enabled: config.engines.opencode.enabled,
    transport: opencodeTransport,
    missingDetail:
      'The OpenCode adapter needs an injected transport or engines.opencode.baseURL; the engine does not spawn or bundle an OpenCode server.',
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

  const models = createRouterCatalog(modelRouter);
  // A configured OpenCode preference is still a model choice, so it must pass
  // the same zero-cost catalogue the run's resolved model passes. The adapter
  // itself honors `run.model` and never substitutes after admission.
  if (opencodeModel) {
    // Membership and cost are checked against the catalogue, not against the
    // Native gateway's readiness: an OpenCode transport can be healthy while
    // the Native inference endpoint is not.
    const preference = models.verify(opencodeModel);
    if (!preference.ok) {
      throw new StartupError([
        `engines.opencode.model does not resolve through the verified zero-cost catalogue (${preference.code}).`,
      ]);
    }
  }

  const persistence = await buildPersistence({
    config,
    env,
    clock,
    ...(input.persistence ?? {}),
  });
  // The quota store is chosen by the persistence driver: mongo shares one
  // durable account per owner and day across replicas, memory is the explicit
  // single-process mode.
  const budget = createBudgetLedger({
    maxRequestsPerDay: config.models.dailyRequestBudget,
    maxTokensPerDay: config.models.dailyTokenBudget,
    ...(persistence.quotaCollection
      ? { store: createMongoQuotaStore({ collection: persistence.quotaCollection }) }
      : {}),
  });
  const lease = persistence.lease;
  const tasks = persistence.tasks;
  const conversations = persistence.conversations;
  const memory = persistence.memory;
  const permissions = createPermissionStore({ clock, ids, ...(persistence.permissionCollection ? { collection: persistence.permissionCollection } : {}) });
  const notifications = persistence.notifications;

  const mcp = await attachMcpServers(config.mcp.servers);
  const embeddingBase = env.CODERAX_INFERENCE_BASE_URL;
  const embeddingKey = env.CODERAX_INFERENCE_KEY;
  const embeddings =
    config.knowledge.embeddingModel && embeddingBase && embeddingKey
      ? createOpenAiEmbeddingProvider({
          baseURL: embeddingBase,
          apiKey: embeddingKey,
          model: config.knowledge.embeddingModel,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
      : null;
  const knowledge = createKnowledgeStore({
    clock,
    ids,
    embeddings,
    maxDocuments: config.knowledge.maxDocuments,
  });
  const builtinTools = config.tools.enabled
    ? createBuiltinTools({
        shellEnabled: config.tools.shellEnabled,
        allowedCommands: config.tools.allowedCommands,
        networkEnabled: config.tools.networkEnabled,
        allowedHosts: config.tools.allowedHosts,
        maxOutputBytes: config.tools.maxOutputBytes,
        commandTimeoutMs: config.tools.commandTimeoutMs,
        maxSearchFiles: config.tools.maxSearchFiles,
        memory,
        knowledge: config.knowledge.enabled ? knowledge : null,
      })
    : [];
  const tools = createToolRuntime({ tools: [...builtinTools, ...mcp.tools] });

  const audit = createAuditLog({ clock, ids });
  const events = createEventBus({
    bufferSize: config.execution.eventBufferSize,
    eventId: ids.eventId,
    iso: clock.iso,
    log: persistence.events,
    retain: config.execution.eventRetain,
  });
  const runner = createTaskRunner({
    lease,
    clock,
    leaseTtlMs: config.execution.leaseTtlMs,
    heartbeatIntervalMs: config.execution.heartbeatIntervalMs,
    cleanupGraceMs: config.execution.cancelGraceMs,
  });
  const scheduler = createTaskScheduler({ maxConcurrent: config.execution.maxConcurrentTasks });
  // There is no workload-isolation integration in this deployment. The provider
  // says so instead of pretending an adapter promise proves a workload stopped;
  // the supervisor then records such executions as unverified and holds their
  // workspace rather than claiming containment.
  const isolation = createUnavailableIsolationProvider(
    'No deployment workload-isolation provider is configured, so a running workload cannot be verified as terminated.',
  );
  const supervisor = createExecutionSupervisor({
    clock,
    ids,
    executions: persistence.executions,
    capabilities: createCapabilityBroker(),
    isolation,
    containmentHoldMs: config.execution.containmentHoldMs,
    shutdownGraceMs: config.execution.cancelGraceMs,
    heartbeatIntervalMs: config.execution.heartbeatIntervalMs,
  });

  const locks = persistence.lockCollection
    ? createMongoResourceLockStore({ collection: persistence.lockCollection })
    : createMemoryResourceLockStore();
  const teams = createTeamService({
    config,
    clock,
    ids,
    agents,
    models,
    budget,
    permissions,
    events,
    supervisor,
    scheduler,
    teams: persistence.teams,
    locks,
  });

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
        check: async () => ({
          status: 'ok' as const,
          detail:
            persistence.driver === 'mongo'
              ? `Tasks, conversations, memory and leases are stored in MongoDB (${config.persistence.database}).`
              : 'Tasks, conversations, memory and leases are process-local; a restart loses them.',
        }),
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
        name: 'isolation',
        required: false,
        check: async () => {
          const report = supervisor.isolation();
          return { status: report.status, detail: report.detail };
        },
      },
      {
        name: 'intelligence',
        required: false,
        check: async () => ({
          status: 'ok' as const,
          detail: `${tools.list().length} tool(s); ${modelRouter.report(config.routing.defaultMode).route.length} routed model(s); ${
            mcp.names.length
          } MCP server(s)${mcp.failures.length > 0 ? `; ${mcp.failures.length} unavailable` : ''}.`,
        }),
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
    supervisor,
    scheduler,
    teams,
    health,
    tools,
    knowledge,
    modelRouter,
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
    persistence: { driver: persistence.driver },
    start: async () => {
      const { url } = await server.listen();
      // Startup ownership verification: a task whose lease died with a previous
      // process is retired now, so no client sees it as running forever.
      await service.recoverInterrupted();
      // A team owned by a replica that stopped is marked interrupted, never left
      // running forever. It stays resumable from its snapshot.
      await teams.reconcile();
      return { url };
    },
    stop: async () => {
      await teams.shutdown();
      await service.shutdown();
      await mcp.close();
      await server.close();
      await persistence.close();
    },
  };
}

export { EXTERNAL_ISOLATION };
