import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  GatewayCompletion,
  GatewayRequest,
  ModelGateway,
  ProviderAdapter,
  ProviderCompletionRequest,
  ProviderSettings,
} from '../src/models/types.js';
import type { ExternalAgentTransport } from '../src/agents/adapters/external.js';
import { ProviderError } from '../src/models/types.js';
import type { ProviderPolicy } from '../src/models/policy.js';
import { PROCESSING_OPERATIONS } from '../src/models/policy.js';
import { composeApplication, type Application } from '../src/bootstrap/compose.js';
import { EngineConfigSchema, type EngineConfig } from '../src/configuration/schema.js';
import type { TaskRecord } from '../src/domain.js';

export const OWNER_TOKEN = 'test-owner-token-0123456789abcdef';
export const OWNER_ID = 'owner-test';

export type TestWorkspace = {
  root: string;
  privateRoot: string;
  cloudRoot: string;
  cleanup: () => void;
};

export function createWorkspaces(): TestWorkspace {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-engine-'));
  const privateRoot = path.join(root, 'private');
  const cloudRoot = path.join(root, 'cloud');
  mkdirSync(privateRoot);
  mkdirSync(cloudRoot);
  return {
    root,
    privateRoot,
    cloudRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A policy that authorizes the fixture provider for every operation in cloud
 * mode only. Private mode stays denied unless a test grants it explicitly, so a
 * missing operation classification cannot pass by accident.
 */
export function testProviderPolicy(
  providerId = 'free',
  overrides: Partial<ProviderPolicy> = {},
): ProviderPolicy {
  return {
    providerId,
    retention: 'transient',
    training: 'prohibited',
    location: 'owner-region',
    credentials: 'deployment-managed',
    modes: ['cloud', 'private'],
    grants: PROCESSING_OPERATIONS.map((operation) => ({
      operation,
      mode: 'cloud' as const,
      location: 'owner-region' as const,
    })),
    evidenceUrl: 'https://provider.example/terms',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

export function baseConfig(workspace: TestWorkspace, overrides?: Record<string, unknown>): EngineConfig {
  return EngineConfigSchema.parse({
    server: { host: '127.0.0.1', port: 0 },
    auth: { ownerId: OWNER_ID },
    workspaces: { privateRoot: workspace.privateRoot, cloudRoot: workspace.cloudRoot },
    models: {
      route: [{ providerId: 'free', modelId: 'coderax-small' }],
      policy: [testProviderPolicy()],
    },
    execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
    ...(overrides ?? {}),
  });
}

/**
 * A deterministic provider fixture. It reports a zero price list, so the real
 * router verifies it like any other provider; the fixture never bypasses cost,
 * context, budget or fallback logic.
 */
export function fakeProvider(input: {
  text?: string;
  beforeReturn?: () => Promise<void>;
  modelId?: string;
} = {}): ProviderAdapter & { calls: number } {
  const provider = {
    id: 'free',
    kind: 'openai' as const,
    calls: 0,
    discover: async () => [
      {
        ref: { providerId: 'free', modelId: input.modelId ?? 'coderax-small' },
        label: 'Free test model',
        contextTokens: 32_768,
        maxOutputTokens: 4_096,
        capabilities: { vision: true, toolCalling: true, reasoning: true, streaming: true },
        pricing: { prompt: '0', completion: '0', request: '0' },
      },
    ],
    complete: async ({ signal }: ProviderCompletionRequest) => {
      provider.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (signal.aborted) throw new ProviderError('cancelled', 'aborted', { retryable: false });
      return {
        text: input.text ?? 'A verified result.',
        toolCalls: [],
        usage: { inputTokens: 11, outputTokens: 13 },
      };
    },
  };
  return provider;
}

export function failingProvider(failures: number): ProviderAdapter & { calls: number } {
  const base = fakeProvider();
  const provider = {
    ...base,
    complete: async () => {
      provider.calls += 1;
      if (provider.calls <= failures) {
        throw new ProviderError('server', 'provider unavailable', { retryable: true });
      }
      return { text: 'Recovered result.', toolCalls: [], usage: { inputTokens: 3, outputTokens: 4 } };
    },
  };
  return provider;
}

/**
 * A gateway fixture for tests that exercise the agent loop without a provider
 * transport. The class under test still owns routing, budgets and policy when a
 * router is composed; this only replaces the transport for a unit-level turn.
 */
export function fakeGateway(
  input: { text?: string; beforeReturn?: () => Promise<void> } = {},
): ModelGateway & { calls: number } {
  const gateway = {
    id: 'fake-gateway',
    calls: 0,
    complete: async (request: GatewayRequest): Promise<GatewayCompletion> => {
      gateway.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (request.signal.aborted) throw new Error('The request was aborted.');
      return {
        text: input.text ?? 'A verified result.',
        toolCalls: [],
        model: request.model,
        attempts: [request.model],
        latencyMs: 0,
        usage: { inputTokens: 5, outputTokens: 7 },
      };
    },
  };
  return gateway;
}

export function slowProvider(delayMs: number): ProviderAdapter & { calls: number } {
  const provider = {
    ...fakeProvider(),
    calls: 0,
    complete: ({ signal }: ProviderCompletionRequest) =>
      new Promise<{ text: string; toolCalls: never[]; usage: { inputTokens: number; outputTokens: number } }>(
        (resolve, reject) => {
          provider.calls += 1;
          const timer = setTimeout(
            () =>
              resolve({
                text: 'Slow result.',
                toolCalls: [],
                usage: { inputTokens: 2, outputTokens: 2 },
              }),
            delayMs,
          );
          timer.unref();
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new ProviderError('cancelled', 'aborted', { retryable: false }));
            },
            { once: true },
          );
        },
      ),
  };
  return provider;
}

export async function startTestApp(options: {
  provider?: ProviderAdapter;
  /** Defaults to a local endpoint; a test may declare a hosted one. */
  providerSettings?: Partial<ProviderSettings>;
  /** A transport fixture for the agent loop; not a routing authority. */
  gateway?: ModelGateway | null;
  config?: Record<string, unknown>;
  externals?: Partial<Record<'opencode' | 'freebuff', ExternalAgentTransport>>;
  env?: Record<string, string>;
} = {}): Promise<{
  app: Application;
  url: string;
  workspace: TestWorkspace;
  close: () => Promise<void>;
}> {
  const workspace = createWorkspaces();
  const config = baseConfig(workspace, options.config);
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, ...(options.env ?? {}) },
    providers: [
      {
        adapter: options.provider ?? fakeProvider(),
        ...(options.providerSettings ? { settings: options.providerSettings } : {}),
      },
    ],
    ...(options.externals ? { externals: options.externals } : {}),
    ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
  });
  const { url } = await app.start();
  return {
    app,
    url,
    workspace,
    close: async () => {
      await app.stop();
      workspace.cleanup();
    },
  };
}

export async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function taskRecord(overrides?: Partial<TaskRecord>): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task_test',
    ownerId: OWNER_ID,
    tenantId: null,
    conversationId: 'conv_test',
    agent: 'coderax',
    engine: 'native',
    mode: 'cloud',
    objective: 'Do the thing',
    model: { providerId: 'free', modelId: 'coderax-small' },
    modelPinned: false,
    state: 'queued',
    generation: 1,
    runToken: null,
    steps: [],
    checkpoint: { completedSteps: [], text: '' },
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: null,
    cancelRequested: false,
    requireApproval: true,
    approval: null,
    budget: null,
    usage: null,
    result: null,
    failure: null,
    ...(overrides ?? {}),
  };
}
