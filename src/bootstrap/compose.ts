import type { AgentIsolation, EngineCapabilities } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import { createClock, createIdGenerator } from '../support/clock.js';
import { createOwnerAuth, AuthConfigurationError } from '../security/auth.js';
import { createNativeAgent } from '../agents/native/agent.js';
import { createExternalAgentAdapter } from '../agents/adapters/external.js';
import type { ExternalAgentTransport } from '../agents/adapters/external.js';
import type { AgentAdapter } from '../agents/types.js';
import { createAgentRegistry } from '../agents/registry.js';
import { probeAgents } from '../agents/probe.js';
import { createBudgetLedger } from '../models/budget.js';
import { BenchmarkFileError, loadBenchmarkScores } from '../models/benchmark.js';
import { createGeminiProvider } from '../models/providers/gemini.js';
import { createOpenAiProvider } from '../models/providers/openai.js';
import { createModelRouter, type ModelRouter } from '../models/router.js';
import type {
  BenchmarkScore,
  FreeTierAttestation,
  ProviderAdapter,
  ProviderSettings,
  RegisteredProvider,
} from '../models/types.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
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
import { buildPersistence } from './persistence.js';
import { StartupError } from './startup-error.js';

export { StartupError } from './startup-error.js';

export type Application = {
  dependencies: ApplicationDependencies;
  service: ApplicationService;
  router: Router;
  server: HttpServer;
  /** The single router, exposed for the benchmark harness and health tests. */
  modelRouter: ModelRouter;
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
  /** Benchmark scores for tests; production loads them from the configured file. */
  benchmarks?: BenchmarkScore[];
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

const PROVIDER_DEFAULTS: ProviderSettings = {
  requestsPerMinute: 15,
  tokensPerMinute: 100_000,
  maxConcurrency: 2,
  requestTimeoutMs: 60_000,
  discoveryIntervalMs: 600_000,
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
    registrations.push({
      adapter,
      settings: {
        requestsPerMinute: provider.requestsPerMinute,
        tokensPerMinute: provider.tokensPerMinute,
        maxConcurrency: provider.maxConcurrency,
        requestTimeoutMs: provider.requestTimeoutMs,
        discoveryIntervalMs,
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
      settings: { ...PROVIDER_DEFAULTS, discoveryIntervalMs },
    });
    configured.add(provider.id);
  }

  const customBase = input.env.CODERAX_INFERENCE_BASE_URL;
  const customKey = input.env.CODERAX_INFERENCE_KEY;
  if (customBase && customKey && !configured.has('custom')) {
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

  const budget = createBudgetLedger({
    maxRequestsPerDay: config.models.dailyRequestBudget,
    maxTokensPerDay: config.models.dailyTokenBudget,
  });

  const providerBuild = input.providers
    ? {
        registrations: input.providers.map((entry) => ({
          adapter: entry.adapter,
          settings: { ...PROVIDER_DEFAULTS, ...entry.settings, discoveryIntervalMs: entry.settings?.discoveryIntervalMs ?? config.models.routing.discoveryIntervalMs },
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

  const models: ModelRouter = createModelRouter({
    providers: providerBuild.registrations,
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

  const native = createNativeAgent({
    enabled: config.engines.native.enabled,
    gateway: providerBuild.registrations.length > 0 ? models : null,
    modelsAvailable: () => models.hasVerifiedFreeRoute(),
    unavailableDetail:
      providerBuild.registrations.length === 0
        ? 'No inference provider is configured; add a provider credential or models.providers entry. A key alone would not make a model free.'
        : 'No verified zero-cost model is currently routable.',
  });

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
    defaultAgent:
      config.engines.default === 'opencode'
        ? 'opencode'
        : config.engines.default === 'freebuff'
          ? 'freebuff'
          : 'coderax',
  });

  const persistence = await buildPersistence({
    config,
    env,
    clock,
    ...(input.persistence ?? {}),
  });
  const lease = persistence.lease;
  const tasks = persistence.tasks;
  const conversations = persistence.conversations;
  const memory = persistence.memory;
  const permissions = createPermissionStore({ clock, ids });
  const notifications = persistence.notifications;
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
    cleanupGraceMs: config.execution.cancelGraceMs,
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
            .agents.filter((agent) => agent.availability.available);
          return available.length > 0
            ? {
                status: 'ok' as const,
                detail: `${available.length} agent(s) available.`,
              }
            : {
                status: 'failed' as const,
                detail:
                  'No agent is available: verify a zero-cost model route or configure an injected external transport.',
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
    modelRouter: models,
    persistence: { driver: persistence.driver },
    start: async () => {
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
      await server.close();
      await persistence.close();
    },
  };
}

export { EXTERNAL_ISOLATION };
