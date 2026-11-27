import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelGateway } from '../src/agents/native/types.js';
import type { BrowserProvider } from '../src/browser/types.js';
import type { MongoConnector, MongoDatabase } from '../src/persistence/mongo-connect.js';
import { composeApplication, type Application } from '../src/bootstrap/compose.js';
import { EngineConfigSchema, type EngineConfig } from '../src/configuration/schema.js';
import type { TaskRecord } from '../src/domain.js';
import type { ProviderPolicy } from '../src/models/policy.js';
import { PROCESSING_OPERATIONS } from '../src/models/policy.js';

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
    models: { route: [{ providerId: 'free', modelId: 'coderax-small' }] },
    execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
    ...(overrides ?? {}),
  });
}

export type FakePlan = { steps: Array<Record<string, unknown>>; note?: string };

export const DEFAULT_TEST_PLAN: FakePlan = {
  steps: [
    {
      id: 'plan-1',
      title: 'Analyze the objective',
      kind: 'reason',
      dependsOn: [],
      acceptance: 'State the constraints that shape the result.',
    },
    {
      id: 'plan-2',
      title: 'Produce the requested result',
      kind: 'reason',
      dependsOn: ['plan-1'],
      acceptance: 'Address the objective directly.',
    },
  ],
};

function citedFrom(prompt: string): string[] {
  return [...prompt.matchAll(/EVIDENCE ([A-Za-z0-9._-]+):/g)]
    .map((match) => match[1])
    .filter((id): id is string => typeof id === 'string');
}

function verificationText(
  prompt: string,
  choice?: { passed: boolean; reason?: string; cited?: string[] },
): string {
  if (choice?.passed === false) {
    return JSON.stringify({
      passed: false,
      reason: choice.reason ?? 'the evidence does not prove the objective',
      cited: [],
    });
  }
  return JSON.stringify({
    passed: true,
    reason: choice?.reason ?? 'evidence covers the objective',
    cited: choice?.cited ?? citedFrom(prompt),
  });
}

/**
 * A deterministic gateway for tests. It is a test double, not a provider: the
 * production path is `createOpenAiCompatibleGateway`, exercised separately. It
 * answers planning and verification turns with the structured JSON those turns
 * require, so a test exercises the real parsers instead of bypassing them.
 */
export function fakeGateway(input: {
  text?: string;
  beforeReturn?: () => Promise<void>;
  plan?: FakePlan;
  verification?: { passed: boolean; reason?: string; cited?: string[] };
} = {}): ModelGateway & { calls: number } {
  const gateway = {
    id: 'test-gateway',
    calls: 0,
    complete: async ({
      system,
      prompt,
      signal,
    }: {
      system: string;
      prompt: string;
      signal: AbortSignal;
    }) => {
      gateway.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (signal.aborted) throw new Error('aborted');
      const turn = `${system}\n${prompt}`;
      if (turn.includes('CODERAX_PLAN_V1')) {
        return {
          text: JSON.stringify(input.plan ?? DEFAULT_TEST_PLAN),
          usage: { inputTokens: 11, outputTokens: 13 },
        };
      }
      if (turn.includes('CODERAX_VERIFY_V1')) {
        return {
          text: verificationText(turn, input.verification),
          usage: { inputTokens: 11, outputTokens: 13 },
        };
      }
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
    complete: async ({ system, prompt }: { system: string; prompt: string }) => {
      gateway.calls += 1;
      if (gateway.calls <= failures) throw new Error('provider unavailable');
      const turn = `${system}\n${prompt}`;
      if (turn.includes('CODERAX_PLAN_V1')) {
        return { text: JSON.stringify(DEFAULT_TEST_PLAN), usage: { inputTokens: 3, outputTokens: 4 } };
      }
      if (turn.includes('CODERAX_VERIFY_V1')) {
        return { text: verificationText(turn), usage: { inputTokens: 3, outputTokens: 4 } };
      }
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
  browser?: BrowserProvider;
  env?: NodeJS.ProcessEnv;
  /** A shared database, so two app instances can prove they read the same rows. */
  persistence?: { database?: MongoDatabase; connect?: MongoConnector };
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
    gateway: options.gateway ?? fakeGateway(),
    ...(options.browser ? { browserProvider: options.browser } : {}),
    ...(options.persistence ? { persistence: options.persistence } : {}),
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
    reasoning: null,
    steps: [],
    checkpoint: { completedSteps: [], text: '', plan: null, evidence: [] },
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
