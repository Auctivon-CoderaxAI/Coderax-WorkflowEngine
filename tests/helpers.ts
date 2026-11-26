import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelGateway } from '../src/agents/native/types.js';
import type { ExternalAgentTransport } from '../src/agents/adapters/external.js';
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
 * Published zero-cost terms for the test model. Tests use a real record shape so
 * the eligibility gate is exercised rather than bypassed: the date window is
 * relative to now, and every billed unit is zero.
 */
export function verifiedTerms(overrides?: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    source: 'https://provider.example/pricing',
    observedAt: new Date(now - 3_600_000).toISOString(),
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    currency: 'USD',
    inputPerMillionTokens: 0,
    outputPerMillionTokens: 0,
    requestPerCall: 0,
    ...(overrides ?? {}),
  };
}

export function verifiedInference(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'https://provider.example/usage',
    observedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...(overrides ?? {}),
  };
}

export function baseConfig(workspace: TestWorkspace, overrides?: Record<string, unknown>): EngineConfig {
  return EngineConfigSchema.parse({
    server: { host: '127.0.0.1', port: 0 },
    auth: { ownerId: OWNER_ID },
    workspaces: { privateRoot: workspace.privateRoot, cloudRoot: workspace.cloudRoot },
    models: {
      route: [{ providerId: 'free', modelId: 'coderax-small' }],
      evidence: [
        {
          providerId: 'free',
          modelId: 'coderax-small',
          toolCalling: true,
          contextTokens: 32_000,
          terms: verifiedTerms(),
          privacySource: 'https://provider.example/privacy',
          promptTraining: 'prohibited',
          inferenceSource: 'https://provider.example/usage',
          inferenceObservedAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      ],
    },
    execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
    ...(overrides ?? {}),
  });
}

/**
 * A deterministic gateway for tests. It is a test double, not a provider: the
 * production path is `createOpenAiCompatibleGateway`, exercised separately.
 */
export function fakeGateway(input: {
  text?: string;
  beforeReturn?: () => Promise<void>;
} = {}): ModelGateway & { calls: number } {
  const gateway = {
    id: 'test-gateway',
    calls: 0,
    complete: async ({ signal }: { signal: AbortSignal }) => {
      gateway.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (signal.aborted) throw new Error('aborted');
      return {
        text: input.text ?? 'A verified result.',
        usage: { inputTokens: 11, outputTokens: 13 },
      };
    },
  };
  return gateway;
}

export function failingGateway(failures: number): ModelGateway & { calls: number } {
  const gateway = {
    id: 'failing-gateway',
    calls: 0,
    complete: async () => {
      gateway.calls += 1;
      if (gateway.calls <= failures) throw new Error('provider unavailable');
      return { text: 'Recovered result.', usage: { inputTokens: 3, outputTokens: 4 } };
    },
  };
  return gateway;
}

export function slowGateway(delayMs: number): ModelGateway & { calls: number } {
  const gateway = {
    id: 'slow-gateway',
    calls: 0,
    complete: ({ signal }: { signal: AbortSignal }) =>
      new Promise<{ text: string }>((resolve, reject) => {
        gateway.calls += 1;
        const timer = setTimeout(() => resolve({ text: 'Slow result.' }), delayMs);
        timer.unref();
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  };
  return gateway;
}

export async function startTestApp(options: {
  gateway?: ModelGateway;
  config?: Record<string, unknown>;
  externals?: Partial<Record<'opencode' | 'freebuff', ExternalAgentTransport>>;
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
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: options.gateway ?? fakeGateway(),
    ...(options.externals ? { externals: options.externals } : {}),
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
    state: 'queued',
    generation: 1,
    runToken: null,
    steps: [],
    media: [],
    creative: null,
    checkpoint: { completedSteps: [], text: '' },
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: null,
    cancelRequested: false,
    requireApproval: true,
    budget: null,
    usage: null,
    result: null,
    failure: null,
    ...(overrides ?? {}),
  };
}
