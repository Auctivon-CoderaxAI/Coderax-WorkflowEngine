import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DiscoveredModel,
  ProviderCompletion,
  ProviderCompletionRequest,
} from '../../src/models/types.js';
import { ProviderError } from '../../src/models/types.js';
import { composeApplication } from '../../src/bootstrap/compose.js';
import {
  baseConfig,
  createWorkspaces,
  fakeProvider,
  OWNER_TOKEN,
  testProviderPolicy,
} from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

function providerAt(id: string, fail: boolean, text: string) {
  const base = fakeProvider({ text });
  const model: DiscoveredModel = {
    ref: { providerId: id, modelId: id },
    label: id,
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: true, toolCalling: true, reasoning: true, streaming: true },
    pricing: { prompt: '0', completion: '0', request: '0' },
  };
  return {
    ...base,
    id,
    discover: async (): Promise<DiscoveredModel[]> => [model],
    complete: async (_request: ProviderCompletionRequest): Promise<ProviderCompletion> => {
      if (fail) throw new ProviderError('server', `${id} failed`, { retryable: true });
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

test('a durable automatic task records the fallback model that actually served it', async () => {
  const workspace = createWorkspaces();
  const app = await composeApplication({
    config: baseConfig(workspace, {
      models: {
        route: [
          { providerId: 'a', modelId: 'a' },
          { providerId: 'b', modelId: 'b' },
        ],
        policy: [testProviderPolicy('a'), testProviderPolicy('b')],
      },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    providers: [{ adapter: providerAt('a', true, 'from a') }, { adapter: providerAt('b', false, 'from b') }],
  });
  try {
    const submitted = await app.service.submitWork(principal, {
      objective: 'Explain the routing fallback',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await app.dependencies.scheduler.idle();

    const record = await app.dependencies.tasks.get(submitted.value.taskId);
    assert.equal(record?.state, 'completed');
    assert.equal(record?.model?.providerId, 'b');
    assert.equal(record?.model?.modelId, 'b');

    const replay = app.dependencies.events.replay(submitted.value.taskId, 0);
    const completed = replay.events.find((event) => event.type === 'task.completed');
    assert.ok(completed);
    const payload = completed.payload as { model?: { providerId: string; modelId: string } };
    assert.deepEqual(payload.model, { providerId: 'b', modelId: 'b' });
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});
