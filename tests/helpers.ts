import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderAdapter, ProviderCompletionRequest } from '../src/models/types.js';
import { ProviderError } from '../src/models/types.js';
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

/**
 * A deterministic provider fixture. It reports a zero price list, so the real
 * router verifies it like any other provider; the fixture never bypasses cost,
 * context, budget or fallback logic.
 */
export function fakeProvider(input: {
  text?: string;
  beforeReturn?: () => Promise<void>;
  modelId?: string;
  vision?: boolean;
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
  config?: Record<string, unknown>;
  externals?: Parameters<typeof composeApplication>[0]['externals'];
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
    providers: [{ adapter: options.provider ?? fakeProvider() }],
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

export function pngBytes(width = 2, height = 2): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  buffer[26] = 0;
  buffer[27] = 0;
  buffer[28] = 0;
  return buffer;
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
    steps: [],
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
