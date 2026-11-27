import type { AgentIsolation, DataMode, EngineCapabilities } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import { createClock, createIdGenerator } from '../support/clock.js';
import { createOwnerAuth, AuthConfigurationError } from '../security/auth.js';
import { createNativeAgent } from '../agents/native/agent.js';
import { createNativePlanner } from '../agents/native/planner.js';
import { createOpenCodeHttpTransport } from '../agents/adapters/opencode.js';
import { createExternalAgentAdapter } from '../agents/adapters/external.js';
import type { ExternalAgentTransport } from '../agents/adapters/external.js';
import type { AgentAdapter } from '../agents/types.js';
import { createAgentRegistry } from '../agents/registry.js';
import { createBrowserService } from '../orchestration/browser.js';
import { createBrowserStore } from '../browser/store.js';
import type { BrowserProvider } from '../browser/types.js';
import { buildBrowserProvider } from './browser.js';
import { validateInvariants } from '../configuration/load.js';
import { probeAgents } from '../agents/probe.js';
import { createBudgetLedger, createMemoryBudgetStore } from '../models/budget.js';
import { createMongoBudgetStore } from '../persistence/budgets.js';
import { BenchmarkFileError, loadBenchmarkScores } from '../models/benchmark.js';
import { createGeminiProvider } from '../models/providers/gemini.js';
import { createOpenAiProvider } from '../models/providers/openai.js';
import { createModelRouter, type ModelRouter } from '../models/router.js';
import { createProviderPolicyRegistry, type ProviderPolicy, type ProviderPolicyRegistry } from '../models/policy.js';
import type {
  BenchmarkScore,
  FreeTierAttestation,
  ModelGateway,
  ProviderAdapter,
  ProviderSettings,
  RegisteredProvider,
} from '../models/types.js';
import { createKnowledgeStore, createOpenAiEmbeddingProvider } from '../knowledge/store.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { createToolRuntime } from '../tools/runtime.js';
import { attachMcpServers } from '../mcp/client.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createPermissionGate } from '../permissions/gate.js';
import { createAuditLog } from '../observability/audit.js';
import { createHealthService } from '../observability/health.js';
import { createEventBus } from '../events/bus.js';
import { createTaskRunner } from '../execution/runner.js';
import { createExecutionSupervisor } from '../execution/supervisor.js';
import { createCapabilityBroker } from '../execution/capabilities.js';
import { createUnavailableIsolationProvider } from '../execution/termination.js';
import { createQuarantineRegistry } from '../execution/quarantine.js';
import { createTaskScheduler } from '../scheduling/scheduler.js';
import { createApplicationService } from '../orchestration/service.js';
import { createArtifactService } from '../artifacts/service.js';
import { createArtifactToolkit } from '../artifacts/toolkit.js';
import { createDeliverableService } from '../artifacts/deliver.js';
import type { ApplicationService } from '../orchestration/service.js';
import { createRouteRegistry, createRouter } from '../api/router.js';
import type { Router } from '../api/router.js';
import { registerRoutes } from '../api/routes.js';
import { createHttpServer } from '../api/server.js';
import type { HttpServer } from '../api/server.js';
import { validateWorkspaceRoots, workspaceRoots } from '../execution/workspace.js';
import { classifyEndpoint } from '../security/endpoint.js';
import {
  createApplicationContainer,
  createDependencyContainer,
  type ApplicationDependencies,
  type InfrastructureDependencies,
} from './container.js';
import { buildPersistence } from './persistence.js';
import { StartupError } from './startup-error.js';
import { createArtifactStore } from '../artifacts/store.js';
import { createGameStore } from '../games/store.js';
import { createGameStudio } from '../games/studio.js';
import { createDesignAssistant } from '../games/assistant.js';
import { createGameSessions } from '../games/session.js';

export { StartupError } from './startup-error.js';

export class ShutdownTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`Graceful shutdown exceeded ${deadlineMs}ms; persistence was left open`);
    this.name = 'ShutdownTimeoutError';
  }
}

export type Application = {
  dependencies: ApplicationDependencies;
  service: ApplicationService;
  router: Router;
  server: HttpServer;
  /** The single model router, exposed for the benchmark harness and health tests. */
  modelRouter: ModelRouter;
  providerPolicy: ProviderPolicyRegistry;
  /** Which lease table the validated persistence setting selected. */
  persistence: { driver: 'memory' | 'mongo' };
  /** Everything is validated before this resolves. */
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
};

/** Test injection: the real router still performs verification and routing. */
export type InjectedProvider = {
  adapter: ProviderAdapter;
  settings?: Partial<ProviderSettings>;
};

export type ComposeInput = {
  config: EngineConfig;
  env?: NodeJS.ProcessEnv;
  /** Provider adapters for fixtures and future adapters; never a routing shortcut. */
  providers?: InjectedProvider[];
  /**
   * A gateway fixture for tests that exercise the agent loop without a provider
   * transport. It is an injection point, not an authority: production always
   * builds the router below, and a deployment never sets this.
   */
  gateway?: ModelGateway | null;
  /** Benchmark scores for tests; production loads them from the configured file. */
  benchmarks?: BenchmarkScore[];
  /** Provider policy records for fixtures; production reads `models.policy`. */
  policies?: readonly ProviderPolicy[];
  externals?: Partial<Record<'opencode' | 'freebuff', ExternalAgentTransport>>;
  /** Test and future-provider injection; the default is configuration-driven. */
  browserProvider?: BrowserProvider;
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

const PROVIDER_DEFAULTS: ProviderSettings = {
  requestsPerMinute: 15,
  tokensPerMinute: 100_000,
  maxConcurrency: 2,
  requestTimeoutMs: 60_000,
  discoveryIntervalMs: 600_000,
  requestsPerDay: 500,
  tokensPerDay: 500_000,
};

/**
 * Providers are configured by URL and credential-variable name. Standard
 * variables make a deployment work without a config entry, but a present key is
 * only authentication: the router still verifies that a model is free.
 */
const ENV_PROVIDERS: ReadonlyArray<{
  id: string;
  kind: 'openai' | 'gemini';
  baseURL: string;
  keyEnvs: readonly string[];
}> = Object.freeze([
  {
    id: 'openrouter',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnvs: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  },
  {
    id: 'gemini',
    kind: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    id: 'groq',
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnvs: ['GROQ_API_KEY'],
  },
  {
    id: 'cerebras',
    kind: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    keyEnvs: ['CEREBRAS_API_KEY'],
  },
]);

function buildProviders(input: {
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): { registrations: RegisteredProvider[]; issues: string[] } {
  const issues: string[] = [];
  const registrations: RegisteredProvider[] = [];
  const configured = new Set<string>();
  const discoveryIntervalMs = input.config.models.routing.discoveryIntervalMs;

  for (const provider of input.config.models.providers) {
    configured.add(provider.id);
    const key = input.env[provider.apiKeyEnv];
    if (!key) {
      issues.push(
        `models.providers ${provider.id} requires environment variable ${provider.apiKeyEnv}`,
      );
      continue;
    }
    const common = {
      id: provider.id,
      baseURL: provider.baseURL,
      apiKey: key,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };
    const adapter =
      provider.kind === 'gemini'
        ? createGeminiProvider(common)
        : createOpenAiProvider(common);
    const recorded = input.config.models.catalog.find(
      (entry) => entry.providerId === provider.id,
    );
    registrations.push({
      adapter,
      settings: {
        requestsPerMinute: provider.requestsPerMinute,
        tokensPerMinute: provider.tokensPerMinute,
        maxConcurrency: provider.maxConcurrency,
        requestTimeoutMs: provider.requestTimeoutMs,
        discoveryIntervalMs,
        ...(recorded
          ? {
              requestsPerDay: recorded.requestsPerDay,
              tokensPerDay: recorded.tokensPerDay,
            }
          : {}),
      },
    });
  }

  for (const provider of ENV_PROVIDERS) {
    if (configured.has(provider.id)) continue;
    const keyEnv = provider.keyEnvs.find((name) => Boolean(input.env[name]));
    if (!keyEnv) continue;
    const common = {
      id: provider.id,
      baseURL: provider.baseURL,
      apiKey: input.env[keyEnv] ?? '',
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };
    const adapter =
      provider.kind === 'gemini'
        ? createGeminiProvider(common)
        : createOpenAiProvider(common);
    registrations.push({
      adapter,
      settings: {
        ...PROVIDER_DEFAULTS,
        discoveryIntervalMs,
      },
    });
    configured.add(provider.id);
  }

  const customBase = input.env.CODERAX_INFERENCE_BASE_URL;
  const customKey = input.env.CODERAX_INFERENCE_KEY;
  if (customBase && customKey && !configured.has('custom')) {
    // This variable is not covered by the configuration schema, so the same
    // endpoint rule is applied here instead of trusting the value.
    const verdict = classifyEndpoint(customBase);
    if (!verdict.ok) {
      issues.push(`CODERAX_INFERENCE_BASE_URL ${verdict.reason}`);
    } else {
      registrations.push({
        adapter: createOpenAiProvider({
          id: 'custom',
          baseURL: customBase,
          apiKey: customKey,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
        settings: { ...PROVIDER_DEFAULTS, discoveryIntervalMs },
      });
    }
  }

  return { registrations, issues };
}

function buildBenchmarks(input: {
  config: EngineConfig;
  injected?: BenchmarkScore[];
}): BenchmarkScore[] {
  if (input.injected) return input.injected;
  const path = input.config.models.benchmarkResultsPath;
  if (!path) return [];
  try {
    return loadBenchmarkScores(path);
  } catch (error) {
    if (error instanceof BenchmarkFileError) {
      throw new StartupError([error.message]);
    }
    throw error;
  }
}

/**
 * The composition root.
 *
 * Order matters and is explicit: configuration, identity, model discovery,
 * agents, persistence, execution, then the service, the route table and the
 * transport. Startup fails closed — an invalid configuration, an unusable
 * workspace root, a missing provider credential, a missing dependency or an
 * incomplete route table stops the engine before it accepts a request.
 */
export async function composeApplication(input: ComposeInput): Promise<Application> {
  const env = input.env ?? process.env;
  const { config } = input;
  // `loadConfig` validates this for the normal entry point. Programmatic
  // callers must not be able to bypass the same fail-closed invariants.
  const invariantIssues = validateInvariants(config);
  if (invariantIssues.length > 0) {
    throw new StartupError(invariantIssues);
  }
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

  const persistence = await buildPersistence({
    config,
    env,
    clock,
    ...(input.persistence ?? {}),
  });
  const budget = createBudgetLedger({
    maxRequestsPerDay: config.models.dailyRequestBudget,
    maxTokensPerDay: config.models.dailyTokenBudget,
    // One ledger, two storage choices: the shared Mongo window when the driver
    // is durable, otherwise the same atomic window inside this process.
    store: persistence.budgetCollection
      ? createMongoBudgetStore(persistence.budgetCollection)
      : createMemoryBudgetStore(),
  });

  const providerBuild = input.providers
    ? {
        registrations: input.providers.map((entry) => ({
          adapter: entry.adapter,
          settings: {
            ...PROVIDER_DEFAULTS,
            ...entry.settings,
            discoveryIntervalMs:
              entry.settings?.discoveryIntervalMs ?? config.models.routing.discoveryIntervalMs,
          },
        })),
        issues: [] as string[],
      }
    : buildProviders({ config, env, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  if (providerBuild.issues.length > 0) {
    throw new StartupError(providerBuild.issues);
  }

  const benchmarks = buildBenchmarks({
    config,
    ...(input.benchmarks === undefined ? {} : { injected: input.benchmarks }),
  });
  const attestations: FreeTierAttestation[] = config.models.attestations.map((entry) => ({
    providerId: entry.providerId,
    modelId: entry.modelId,
    evidenceUrl: entry.evidenceUrl,
    verifiedAt: entry.verifiedAt,
    expiresAt: entry.expiresAt,
  }));

  const policy = createProviderPolicyRegistry(input.policies ?? config.models.policy);
  const externalPolicy = (engine: 'opencode' | 'freebuff', mode: DataMode) =>
    policy.evaluate({ providerId: engine, operation: 'external_agent', mode, at: clock.now() });
  // A configured provider without a policy record cannot route. Failing startup
  // is louder than a deployment that silently has no authorized inference.
  const unauthorized = providerBuild.registrations
    .map((registration) => registration.adapter.id)
    .filter((providerId) => policy.get(providerId) === null);
  if (unauthorized.length > 0) {
    throw new StartupError(
      unauthorized.map(
        (providerId) =>
          `models.policy has no owner-approved record for provider ${providerId}; hosted inference is refused until one exists`,
      ),
    );
  }

  const models: ModelRouter = createModelRouter({
    providers: providerBuild.registrations,
    policy,
    attestations,
    benchmarks,
    preferredRoute: config.models.route,
    budget,
    maxCandidates: config.models.routing.maxCandidates,
    maxFallbacks: config.models.routing.maxFallbacks,
    failureThreshold: config.models.routing.failureThreshold,
    cooldownMs: config.models.routing.cooldownMs,
    discoveryIntervalMs: config.models.routing.discoveryIntervalMs,
    defaultMaxOutputTokens: config.models.routing.defaultMaxOutputTokens,
    contextMarginTokens: config.models.routing.contextMarginTokens,
    now: () => clock.now(),
  });
  await models.refresh();

  // Production reaches inference only through the router above. A gateway
  // fixture is a test seam and never becomes a second production authority.
  const gateway: ModelGateway | null =
    input.gateway !== undefined
      ? input.gateway
      : providerBuild.registrations.length > 0
        ? models
        : null;

  const native = createNativeAgent({
    enabled: config.engines.native.enabled,
    gateway,
    planner: createNativePlanner(),
    // An injected transport is a test seam. A real provider registration only
    // counts once the router has verified a zero-cost route; a key alone never
    // makes a model free.
    modelsAvailable: () =>
      (input.gateway !== undefined && input.gateway !== null) || models.hasVerifiedFreeRoute(),
    unavailableDetail:
      providerBuild.registrations.length === 0
        ? 'No inference provider is configured; add a provider credential or models.providers entry. A key alone would not make a model free.'
        : 'No verified zero-cost model is currently routable.',
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
          ...(opencodeModel ? { model: opencodeModel } : {}),
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
    defaultAgent:
      config.engines.default === 'opencode'
        ? 'opencode'
        : config.engines.default === 'freebuff'
          ? 'freebuff'
          : 'coderax',
  });

  const lease = persistence.lease;
  const tasks = persistence.tasks;
  const conversations = persistence.conversations;
  const memory = persistence.memory;
  const permissions = createPermissionStore({
    clock,
    ids,
    ...(persistence.permissionCollection
      ? { collection: persistence.permissionCollection }
      : {}),
  });
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
  const artifactService = createArtifactService({
    artifacts: persistence.artifacts,
    blobs: persistence.blobs,
    capacity: persistence.capacity,
    ownerId: config.auth.ownerId,
    conversations,
    tasks,
    audit,
    clock,
    ids,
    settings: config.artifacts,
  });
  const artifactRoots = await validateWorkspaceRoots(workspaceRoots(config.workspaces));
  if (!artifactRoots.ok) {
    throw new StartupError([artifactRoots.detail]);
  }
  const deliverables = createDeliverableService({
    toolkit: createArtifactToolkit(),
    artifacts: artifactService,
    audit,
    clock,
    ids,
    roots: artifactRoots.value,
  });
  const browserProvider =
    input.browserProvider ??
    buildBrowserProvider({
      config,
      env,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  const browser = createBrowserService({
    config,
    clock,
    ids,
    permissions,
    audit,
    provider: browserProvider,
    store: createBrowserStore(),
  });
  const events = createEventBus({
    store: persistence.events,
    // The task row is the fenced sequence authority; the bus never numbers an
    // event on its own, so a superseded generation cannot append one.
    seq: tasks,
    pollMs: config.execution.eventPollMs,
    eventId: ids.eventId,
    iso: clock.iso,
  });
  const supervisor = createRunSupervisor({ clock });
  const runner = createTaskRunner({
    lease,
    clock,
    leaseTtlMs: config.execution.leaseTtlMs,
    heartbeatIntervalMs: config.execution.heartbeatIntervalMs,
    cleanupGraceMs: config.execution.cancelGraceMs,
    // The composition root is where supervision exists in production. An
    // adapter that ignored its abort may still be running; its capability and
    // workspace are revoked here even if the service already moved on.
    onAbandoned: async ({ token }) => {
      await supervisor.abandon({
        token,
        reason: 'A cancelled adapter did not stop within the grace period.',
      });
    },
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
        name: 'artifacts',
        required: persistence.driver === 'mongo',
        check: async () => {
          if (!persistence.blobs.durable) {
            // Consistent with the persistence probe: a memory deployment is a
            // known non-durable configuration, reported as ok-with-limitation
            // rather than as a fault. What matters is that it is never silent.
            return {
              status: 'ok' as const,
              detail:
                'Artifact storage is process-local; uploads are refused until persistence.driver=mongo is configured.',
            };
          }
          try {
            await persistence.blobs.check();
            return {
              status: 'ok' as const,
              detail: 'Artifact metadata and content are stored durably in MongoDB.',
            };
          } catch {
            return {
              status: 'failed' as const,
              detail: 'Artifact storage could not be read.',
            };
          }
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
        name: 'models',
        required: false,
        check: async () => {
          const snapshot = models.health();
          return snapshot.verifiedFree > 0
            ? {
                status: 'ok' as const,
                detail: `${snapshot.verifiedFree} verified zero-cost model(s) are routable.`,
              }
            : {
                status: 'failed' as const,
                detail:
                  'No verified zero-cost model is routable; paid endpoints are never used as a substitute.',
              };
        },
      },
      {
        name: 'engine',
        required: true,
        check: async () => {
          const available = agents
            .list()
            .agents.filter((agent) => {
              if (!agent.availability.available) return false;
              const engine = agent.engine;
              if (engine === 'native') return true;
              return (['cloud', 'private'] as const).some(
                (mode) =>
                  externalPolicy(engine, mode).allowed &&
                  (['chat', 'work'] as const).some(
                    (operation) => models.resolve(null, mode, { operation }).ok,
                  ),
              );
            });
          return available.length > 0
            ? {
                status: 'ok' as const,
                detail: `${available.length} agent(s) available.`,
              }
            : {
                status: 'failed' as const,
                detail:
                  'No agent is available: verify a zero-cost model route and, for an external engine, configure its transport and owner grant.',
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
          detail: `${tools.list().length} tool(s); ${models.health().route.length} routed model(s); ${
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
    artifactService,
    deliverables,
    schedules,
    scheduleNotices,
    audit,
    events,
    runner,
    supervisor,
    scheduler,
    health,
    quarantine,
    tools,
    knowledge,
    modelRouter: models,
  });
  if (!container.dependencies) {
    throw new StartupError(
      container.missing.map((name) => `dependency ${name} was not provided`),
    );
  }
  const infrastructure: InfrastructureDependencies = container.dependencies;

  const service = createApplicationService({
    ...infrastructure,
    externalPolicy,
  });

  const registry = createRouteRegistry();
  registerRoutes(registry, service, {
    server: { name: 'coderax-workflow-engine', version: '0.1.0', startedAt: clock.iso() },
    limits: {
      maxBodyBytes: ARTIFACT_BODY_LIMIT_BYTES,
      eventBufferSize: config.execution.eventBufferSize,
      maxConcurrentTasks: config.execution.maxConcurrentTasks,
      // The scheduler cannot fire a slot faster than its own tick, so that is
      // the smallest interval the engine can actually honour.
      scheduleMinIntervalMs: config.schedules.tickMs,
      artifactMaxBytes: config.artifacts.maxBytesPerArtifact,
      memoryMaxValueLength: 20_000,
    },
    externalAgents:
      config.engines.opencode.enabled || config.engines.freebuff.enabled,
  });
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

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      service.beginShutdown();
      // Stop accepting new HTTP work immediately; in-flight requests may finish
      // while the service drains, but they cannot admit new execution.
      const serverClosed = server.close();
      const drain = Promise.all([service.shutdown(), serverClosed]).then(() => persistence.close());
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          drain,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ShutdownTimeoutError(config.execution.shutdownGraceMs)),
              config.execution.shutdownGraceMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return stopPromise;
  };

  return {
    dependencies: finalContainer.dependencies,
    service,
    router,
    server,
    modelRouter: models,
    providerPolicy: policy,
    persistence: { driver: persistence.driver },
    start: async () => {
      // Rebuild quota availability from committed rows before the socket is
      // open, so an early request cannot be admitted against stale capacity.
      await service.artifacts.reconcile();
      const { url } = await server.listen();
      models.start();
      // Startup ownership verification: a task whose lease died with a previous
      // process is retired now, so no client sees it as running forever.
      await service.recoverInterrupted();
      return { url };
    },
    stop: async () => {
      models.stop();
      await service.shutdown();
      await mcp.close();
      await server.close();
      await persistence.close();
    },
  };
}

export { EXTERNAL_ISOLATION };
