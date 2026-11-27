import path from 'node:path';
import { ARTIFACT_BODY_LIMIT_BYTES } from '@coderax/contracts';
import type { AgentIsolation, EngineCapabilities } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import { createClock, createIdGenerator } from '../support/clock.js';
import { createOwnerAuth, AuthConfigurationError } from '../security/auth.js';
import { createNativeAgent } from '../agents/native/agent.js';
import { createKnowledgeStore } from '../knowledge/store.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { createToolRuntime } from '../tools/runtime.js';
import type { ToolRuntime } from '../tools/types.js';
import { attachMcpServers } from '../tools/mcp.js';
import { loadPlugins } from '../plugins/manifest.js';
import { createApprovalGate } from '../permissions/approval.js';
import { createOpenAiCompatibleGateway } from '../agents/native/gateway.js';
import type { ModelGateway } from '../agents/native/types.js';
import { createExternalAgentAdapter } from '../agents/adapters/external.js';
import { createOpenCodeHttpTransport } from '../agents/adapters/opencode.js';
import type { ExternalAgentTransport } from '../agents/adapters/external.js';
import type { AgentAdapter } from '../agents/types.js';
import { createAgentRegistry } from '../agents/registry.js';
import { createBrowserService } from '../orchestration/browser.js';
import { createBrowserStore } from '../browser/store.js';
import type { BrowserProvider } from '../browser/types.js';
import { buildBrowserProvider } from './browser.js';
import { validateInvariants } from '../configuration/load.js';
import { probeAgents } from '../agents/probe.js';
import { createBudgetLedger } from '../models/budget.js';
import { BenchmarkFileError, loadBenchmarkScores } from '../models/benchmark.js';
import type { BenchmarkScore } from '../models/types.js';
import { createModelRouter } from '../models/router.js';
import { createProviderPolicyRegistry } from '../models/policy.js';
import { createOpenAiProvider } from '../models/providers/openai.js';
import { createGeminiProvider } from '../models/providers/gemini.js';
import type { ProviderAdapter, RegisteredProvider } from '../models/types.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createPermissionGate } from '../permissions/gate.js';
import { createAuditLog } from '../observability/audit.js';
import { createHealthService } from '../observability/health.js';
import { createEventBus } from '../events/bus.js';
import { createTaskRunner } from '../execution/runner.js';
import { createRunSupervisor } from '../execution/supervisor.js';
import { validateRemoteEndpoint } from '../configuration/endpoint.js';
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
  /** Measured benchmark scores for tests; production reads the configured file. */
  benchmarks?: BenchmarkScore[];
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
  // A key may only cross the network inside TLS. This is a startup gate: a
  // deployment that would send its credential in plaintext does not start.
  const endpoint = validateRemoteEndpoint({
    url: baseURL,
    name: 'CODERAX_INFERENCE_BASE_URL',
    carriesCredential: true,
  });
  if (!endpoint.ok) throw new StartupError([endpoint.detail]);
  return createOpenAiCompatibleGateway({
    baseURL,
    apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

/**
 * Adapts a programmatic gateway to the provider port.
 *
 * The route is discovered locally and deliberately publishes no price: a
 * caller-provided gateway is not evidence of a zero-cost tier, so the router
 * still requires an operator attestation for each model it may use.
 */
function gatewayProvider(input: {
  gateway: ModelGateway;
  config: EngineConfig;
}): ProviderAdapter {
  const route = input.config.models.route;
  return {
    id: route[0]?.providerId ?? 'gateway',
    kind: 'openai',
    discover: async () =>
      route.map((ref) => ({
        ref,
        label: `${ref.providerId} ${ref.modelId}`,
        contextTokens: 32_768,
        maxOutputTokens: 4_096,
        capabilities: {
          vision: false,
          toolCalling: true,
          reasoning: true,
          streaming: false,
        },
        pricing: null,
      })),
    complete: async (request) => {
      const completion = await input.gateway.complete({
        model: request.model,
        system: request.system,
        prompt: request.prompt,
        signal: request.signal,
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      });
      return {
        text: completion.text,
        toolCalls: [],
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    },
  };
}

/**
 * Registers the configured providers and, when one was supplied, the
 * programmatic gateway. A provider whose key variable is absent is not
 * registered at all; it is never replaced by a paid endpoint.
 */
function buildProviders(input: {
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  gateway: ModelGateway | null;
  fetchImpl?: typeof fetch;
}): RegisteredProvider[] {
  const registrations: RegisteredProvider[] = [];
  const discoveryIntervalMs = input.config.models.routing.discoveryIntervalMs;
  const common = (id: string, baseURL: string, apiKey: string) => ({
    id,
    baseURL,
    apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  for (const provider of input.config.models.providers) {
    const key = input.env[provider.apiKeyEnv];
    if (!key) continue;
    const adapter =
      provider.kind === 'gemini'
        ? createGeminiProvider(common(provider.id, provider.baseURL, key))
        : createOpenAiProvider(common(provider.id, provider.baseURL, key));
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

  if (input.gateway) {
    registrations.push({
      adapter: gatewayProvider({ gateway: input.gateway, config: input.config }),
      settings: {
        requestsPerMinute: 20,
        tokensPerMinute: 100_000,
        maxConcurrency: 2,
        requestTimeoutMs: 60_000,
        discoveryIntervalMs,
      },
    });
  }
  return registrations;
}

/**
 * Benchmark scores are optional evidence, never a default. A malformed file
 * stops startup instead of silently ranking on invented quality data.
 */
function loadBenchmarkInput(input: ComposeInput): BenchmarkScore[] {
  if (input.benchmarks) return [...input.benchmarks];
  const file = (input.env ?? process.env).CODERAX_BENCHMARK_SCORES_FILE;
  if (!file) return [];
  try {
    return loadBenchmarkScores(file);
  } catch (error) {
    if (error instanceof BenchmarkFileError) throw new StartupError([error.message]);
    throw error;
  }
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

  const gateway = buildGateway(input);

  const opencodePassword = config.engines.opencode.passwordEnv
    ? env[config.engines.opencode.passwordEnv]
    : undefined;
  const opencodeModelParts = config.engines.opencode.model?.split('/') ?? [];
  const opencodeModel =
    opencodeModelParts.length > 1
      ? {
          providerId: opencodeModelParts[0] ?? '',
          modelId: opencodeModelParts.slice(1).join('/'),
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

  // The reservation ledger is only as durable as its store, so persistence is
  // built first. One task may claim at most half the owner's daily allowance,
  // which stops a single runaway run from consuming the whole free budget.
  const persistence = await buildPersistence({
    config,
    env,
    clock,
    ids,
    ...(input.persistence ?? {}),
  });
  const budget = createBudgetLedger({
    store: persistence.budgets,
    maxRequestsPerDay: config.models.dailyRequestBudget,
    maxTokensPerDay: config.models.dailyTokenBudget,
    taskMaxRequests: Math.max(1, Math.ceil(config.models.dailyRequestBudget / 2)),
    taskMaxTokens: Math.max(1, Math.ceil(config.models.dailyTokenBudget / 2)),
  });

  // One model authority: the router owns discovery, zero-cost verification,
  // policy, provider limits, fallback and the durable reservation ledger.
  const providers = buildProviders({
    config,
    env,
    gateway,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const benchmarks = loadBenchmarkInput(input);
  const models = createModelRouter({
    providers,
    benchmarks,
    attestations: config.models.attestations,
    preferredRoute: config.models.route,
    budget,
    policy: createProviderPolicyRegistry(config.models.policy),
    ...config.models.routing,
    now: () => clock.now(),
  });
  models.start();
  // Startup verifies the route before the engine accepts a request: a
  // deployment with no verified free model fails closed at the first submit
  // instead of discovering availability later.
  await models.refresh();
  // Native reaches a provider through the configured gateway, exactly as before;
  // the router owns resolution, zero-cost verification and health. With no
  // provider registered, no route resolves and the agent is honestly unavailable.
  const agentGateway = gateway;

  const artifacts = createArtifactStore({ roots: workspaceRoots(config.workspaces) });
  const assistant = createDesignAssistant({ models, gateway: agentGateway, budget, clock });
  const studio = createGameStudio({
    store: createGameStore({ root: path.join(config.workspaces.cloudRoot, 'games') }),
    artifacts,
    clock,
    ids,
    assistant,
    maxProjects: config.games.maxProjectsPerOwner,
  });
  const gaming = createGameSessions({
    artifacts,
    clock,
    ids,
    maxPauseMs: config.games.maxPauseMs,
  });

  const lease = persistence.lease;
  const tasks = persistence.tasks;
  const conversations = persistence.conversations;
  const memory = persistence.memory;
  const permissions = persistence.permissions;
  const permissionsGate = createPermissionGate({ permissions, clock });

  // Tools are data plus one function, and only the ones admitted by configuration
  // are registered. MCP servers and plugin manifests contribute more tools through
  // the same runtime, so one authorization path covers every source.
  const knowledge: KnowledgeStore = createKnowledgeStore({
    clock,
    ids,
    embeddings: null,
    maxDocuments: config.tools.maxKnowledgeDocuments,
  });
  const plugins = await loadPlugins(config.tools.pluginDirectory);
  const mcp = await attachMcpServers([...config.tools.mcp, ...plugins.servers]);
  const tools: ToolRuntime | null = config.tools.enabled
    ? createToolRuntime({
        tools: [
          ...createBuiltinTools({
            shellEnabled: config.tools.shellEnabled,
            allowedCommands: config.tools.allowedCommands,
            networkEnabled: config.tools.networkEnabled,
            allowedHosts: config.tools.allowedHosts,
            allowInsecureLoopback: config.tools.allowInsecureLoopback,
            maxOutputBytes: config.tools.maxOutputBytes,
            commandTimeoutMs: config.tools.commandTimeoutMs,
            maxSearchFiles: config.tools.maxSearchFiles,
            memory,
            knowledge,
          }),
          ...mcp.tools,
        ],
        catalogueMaxChars: config.tools.catalogueMaxChars,
      })
    : null;
  const native = createNativeAgent({
    enabled: config.engines.native.enabled,
    gateway: agentGateway,
    authorizer: permissionsGate,
    tools,
    approvals: ({ ownerId, taskId }) =>
      createApprovalGate({ permissions, clock, ownerId, taskId, agent: 'coderax' }),
    limits: {
      maxSteps: config.engines.native.maxSteps,
      maxParallelSteps: config.engines.native.maxParallelSteps,
      maxReplans: config.engines.native.maxReplans,
      maxStepAttempts: config.engines.native.maxStepAttempts,
      maxIterations: config.engines.native.maxIterations,
    },
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
  const notifications = persistence.notifications;
  const schedules = persistence.schedules;
  const scheduleNotices = persistence.scheduleNotices;
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
      ...(config.browsers.enabled
        ? [
            {
              // Optional: no verified browser provider is required to run Work.
              // It is reported truthfully, and an unavailable one degrades rather
              // than blocks the engine.
              name: 'browser',
              required: false,
              check: async () => {
                const capabilities = await browser.capabilities();
                return capabilities.operational
                  ? {
                      status: 'ok' as const,
                      detail: `Browser provider ${capabilities.provider} is operational.`,
                    }
                  : { status: 'degraded' as const, detail: capabilities.detail };
              },
            },
          ]
        : []),
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
    scheduler,
    health,
    studio,
    sessions: gaming.sessions,
    gaming: gaming.agent,
    browser,
    supervisor,
    tools,
    knowledge,
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
      models.stop();
      // Stop accepting new HTTP work immediately; in-flight requests may finish
      // while the service drains, but they cannot admit new execution.
      const serverClosed = server.close();
      await mcp.close().catch(() => undefined);
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
    persistence: { driver: persistence.driver },
    start: async () => {
      // Rebuild quota availability from committed rows before the socket is
      // open, so an early request cannot be admitted against stale capacity.
      await service.artifacts.reconcile();
      const { url } = await server.listen();
      try {
        await service.recoverInterrupted();
        await service.artifacts.sweepExpiredArtifacts();
        await deliverables.sweepStaging();
        service.startSchedules();
      } catch (error) {
        try {
          await stop();
        } catch (stopError) {
          if (!(stopError instanceof ShutdownTimeoutError)) await persistence.close();
        }
        throw error;
      }
      return { url };
    },
    stop,
  };
}

export { EXTERNAL_ISOLATION };
