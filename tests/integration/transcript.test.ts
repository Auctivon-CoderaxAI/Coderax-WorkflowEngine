import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderAdapter, ProviderCompletionRequest } from '../../src/models/types.js';
import { workRunKey } from '../../src/execution/lease.js';
import { startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * A gateway that keeps every prompt it was given, so the test can read what the
 * model actually saw rather than trusting that history was passed along.
 */
function recordingGateway(): ProviderAdapter & { prompts: string[] } {
  const gateway = {
    id: 'free',
    kind: 'openai' as const,
    prompts: [] as string[],
    discover: async () => [
      {
        ref: { providerId: 'free', modelId: 'recording' },
        label: 'Recording model',
        contextTokens: 32_768,
        maxOutputTokens: 4_096,
        capabilities: { vision: false, toolCalling: false, reasoning: true, streaming: true },
        pricing: { prompt: '0', completion: '0' },
      },
    ],
    complete: async (request: ProviderCompletionRequest) => {
      gateway.prompts.push(request.prompt);
      return {
        text: `answer-${gateway.prompts.length}`,
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    },
  };
  return gateway;
}

test('a follow-up turn is prompted with the earlier exchange', async () => {
  const gateway = recordingGateway();
  const started = await startTestApp({ provider: gateway });
  try {
    const first = await started.app.service.submitWork(principal, {
      objective: 'First objective',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const conversationId = first.value.conversationId;

    await waitFor(async () => {
      const status = await started.app.service.task(principal, first.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    // The terminal write lands before the lease is released, so wait for the
    // release rather than racing the second submission against a live lease.
    await waitFor(async () => {
      const lease = await started.app.dependencies.lease.read({
        key: workRunKey({ ownerId: principal.ownerId, tenantId: null, conversationId }),
        now: new Date(),
      });
      return lease === null ? true : null;
    });

    const firstTurnPrompts = gateway.prompts.length;
    assert.equal(firstTurnPrompts, 3);
    // The first turn has nothing to remember.
    assert.ok(gateway.prompts.every((prompt) => !prompt.includes('Earlier in this conversation:')));

    const second = await started.app.service.submitWork(principal, {
      objective: 'Follow-up objective',
      conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    await waitFor(async () => {
      const status = await started.app.service.task(principal, second.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    const followUpPrompts = gateway.prompts.slice(firstTurnPrompts);
    assert.equal(followUpPrompts.length, 3);
    for (const prompt of followUpPrompts) {
      assert.ok(prompt.includes('Earlier in this conversation:'));
      // The stored user turn and the stored assistant answer, in order.
      assert.ok(prompt.includes('Owner: First objective'));
      assert.ok(prompt.includes('Assistant: answer-1'));
      // The current objective is the objective, not a repeated history turn.
      assert.equal(prompt.split('Follow-up objective').length - 1, 1);
    }

    const conversation = await started.app.service.conversation(principal, conversationId);
    assert.equal(conversation.ok, true);
    if (conversation.ok) {
      assert.deepEqual(
        conversation.value.messages.map((message) => message.role),
        ['user', 'assistant', 'user', 'assistant'],
      );
    }
  } finally {
    await started.close();
  }
});

test('a chat follow-up is prompted with the earlier exchange', async () => {
  const gateway = recordingGateway();
  const started = await startTestApp({ provider: gateway });
  try {
    const first = await started.app.service.chat(principal, {
      message: 'First question',
      mode: 'cloud',
      agent: 'coderax',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = await started.app.service.chat(principal, {
      message: 'Second question',
      conversationId: first.value.conversationId,
      mode: 'cloud',
      agent: 'coderax',
    });
    assert.equal(second.ok, true);

    const prompt = gateway.prompts.at(-1) ?? '';
    assert.ok(prompt.includes('Owner: First question'));
    assert.ok(prompt.includes('Assistant: answer-1'));
    assert.equal(prompt.split('Second question').length - 1, 1);
  } finally {
    await started.close();
  }
});
