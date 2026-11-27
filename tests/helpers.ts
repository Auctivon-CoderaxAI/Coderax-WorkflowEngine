import type { ModelGateway } from '../src/agents/native/types.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GatewayCompletion, GatewayRequest, ProviderAdapter, ProviderCompletionRequest, ProviderSettings } from '../src/models/types.js';
import { ProviderError } from '../src/models/types.js';
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
 * A deterministic provider fixture. It reports a zero price list, so the real
 * router verifies it like any other provider; the fixture never bypasses cost,
 * context, budget or fallback logic.
 */
function fixtureText(turn: string, input: { text?: string; plan?: FakePlan; verification?: { passed: boolean; reason?: string; cited?: string[] } }): string {
  if (turn.includes('CODERAX_PLAN_V1')) return JSON.stringify(input.plan ?? DEFAULT_TEST_PLAN);
  if (turn.includes('CODERAX_VERIFY_V1')) return verificationText(turn, input.verification);
  return input.text ?? 'A verified result.';
}

export function fakeProvider(input: {
  text?: string;
  beforeReturn?: () => Promise<void>;
  modelId?: string;
  vision?: boolean;
  plan?: FakePlan;
  verification?: { passed: boolean; reason?: string; cited?: string[] };
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
        capabilities: {
          vision: input.vision ?? true,
          toolCalling: true,
          reasoning: true,
          streaming: true,
        },
        pricing: { prompt: '0', completion: '0', request: '0' },
      },
    ],
    complete: async ({ signal, system, prompt, messages }: ProviderCompletionRequest) => {
      provider.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (signal.aborted) throw new ProviderError('cancelled', 'aborted', { retryable: false });
      const turn = [system, prompt, ...(messages ?? []).map((message) => message.text)].join('\n');
      return {
        text: fixtureText(turn, input),
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
  input: { text?: string; beforeReturn?: () => Promise<void>; plan?: FakePlan; verification?: { passed: boolean; reason?: string; cited?: string[] } } = {},
): ModelGateway & { calls: number } {
  const gateway = {
    id: 'fake-gateway',
    calls: 0,
    complete: async (request: GatewayRequest): Promise<GatewayCompletion> => {
      gateway.calls += 1;
      if (input.beforeReturn) await input.beforeReturn();
      if (request.signal.aborted) throw new Error('The request was aborted.');
      return {
        text: fixtureText(`${request.system}\n${request.prompt}`, input),
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

export function failingGateway(failures: number): ModelGateway & { calls: number } {
  const gateway = fakeGateway({ text: 'Recovered result.' });
  let calls = 0;
  return { id: 'failing-gateway', get calls() { return calls; },
    complete: async (request) => {
      if (++calls <= failures) throw new Error('provider unavailable');
      return gateway.complete(request);
    },
  };
}

export function slowGateway(delayMs: number): ModelGateway & { calls: number } {
  const gateway = fakeGateway({ text: 'Slow result.' });
  return {
    id: 'slow-gateway',
    get calls() { return gateway.calls; },
    complete: async (request) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
        const timer = setTimeout(() => {
          request.signal.removeEventListener('abort', abort);
          resolve();
        }, delayMs);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
      return gateway.complete(request);
    },
  };
}

export async function startTestApp(options: {
  provider?: ProviderAdapter;
  env?: NodeJS.ProcessEnv;
  browserProvider?: Parameters<typeof composeApplication>[0]['browserProvider'];
  browser?: Parameters<typeof composeApplication>[0]['browserProvider'];
  /** Defaults to a local endpoint; a test may declare a hosted one. */
  providerSettings?: Partial<ProviderSettings>;
  /** A transport fixture for the agent loop; not a routing authority. */
  gateway?: ModelGateway | null;
  config?: Record<string, unknown>;
  externals?: Parameters<typeof composeApplication>[0]['externals'];
  persistence?: Parameters<typeof composeApplication>[0]['persistence'];
} = {}): Promise<{
  app: Application;
  url: string;
  workspace: TestWorkspace;
  close: () => Promise<void>;
}> {
  const workspace = createWorkspaces();
  const config = baseConfig(workspace, {
    artifacts: { allowEphemeral: true },
    ...(options.config ?? {}),
  });
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, ...options.env },
    ...((options.browserProvider ?? options.browser) ? { browserProvider: options.browserProvider ?? options.browser } : {}),
    providers: [{ adapter: options.provider ?? fakeProvider(), ...(options.providerSettings ? { settings: options.providerSettings } : {}) }],
    ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
    ...(options.externals ? { externals: options.externals } : {}),
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

export function pngBytes(width = 2, height = 2): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13, 0);
  header.write('IHDR', 4, 'latin1');
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  header[16] = 8;
  header[17] = 2;
  const data = Buffer.alloc(16);
  data.writeUInt32BE(4, 0);
  data.write('IDAT', 4, 'latin1');
  Buffer.from([0x78, 0x9c, 0x03, 0x00]).copy(data, 8);
  const end = Buffer.alloc(12);
  end.write('IEND', 4, 'latin1');
  // The sniffer verifies chunk structure, not CRC values; these fixtures are
  // not decodable images and never claim to be.
  return Buffer.concat([signature, header, data, end]);
}

export function jpegBytes(width = 2, height = 2): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

export function webpBytes(width = 2, height = 2, animated = false): Buffer {
  const chunk = Buffer.alloc(10);
  chunk[0] = animated ? 0x02 : 0x00;
  chunk.writeUIntLE(width - 1, 4, 3);
  chunk.writeUIntLE(height - 1, 7, 3);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + 8 + chunk.length, 4);
  header.write('WEBP', 8, 'latin1');
  const metadata = Buffer.alloc(8);
  metadata.write('VP8X', 0, 'latin1');
  metadata.writeUInt32LE(chunk.length, 4);
  return Buffer.concat([header, metadata, chunk]);
}

export function gifBytes(width = 2, height = 2, frames = 1): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  const parts: Buffer[] = [header];
  for (let frame = 0; frame < frames; frame += 1) {
    parts.push(
      Buffer.from([
        0x2c, 0x00, 0x00, 0x00, 0x00,
        width & 0xff, (width >> 8) & 0xff,
        height & 0xff, (height >> 8) & 0xff,
        0x00,
        0x02, 0x02, 0x44, 0x01, 0x00,
      ]),
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
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
    attachments: [],
    model: { providerId: 'free', modelId: 'coderax-small' },
    modelPinned: false,
    state: 'queued',
    generation: 1,
    runToken: null,
    eventSeq: 0,
    reasoning: null,
    steps: [],
    checkpoint: { completedSteps: [], text: '', plan: null, evidence: [] },
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
