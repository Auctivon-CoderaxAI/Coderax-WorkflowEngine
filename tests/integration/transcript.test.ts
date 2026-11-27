import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelCompletionRequest } from '../../src/agents/native/types.js';
import { workRunKey } from '../../src/execution/lease.js';
import { startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * A gateway that keeps every prompt it was given, so the test can read what the
 * model actually saw rather than trusting that history was passed along.
 */
function recordingGateway(): {
  id: string;
  prompts: string[];
  complete: (request: ModelCompletionRequest) => Promise<{ text: string }>;
} {
  const gateway = {
    id: 'recording-gateway',
    prompts: [] as string[],
    complete: async (request: ModelCompletionRequest) => {
      gateway.prompts.push(request.prompt);
      const turn = `${request.system}\n${request.prompt}`;
      if (turn.includes('CODERAX_VERIFY_V1')) {
        const cited = [...turn.matchAll(/EVIDENCE ([A-Za-z0-9._-]+):/g)]
          .map((match) => match[1])
          .filter((id): id is string => typeof id === 'string');
        return {
          text: JSON.stringify({ passed: true, reason: 'evidence covers the objective', cited }),
        };
      }
      return { text: `answer-${gateway.prompts.length}` };
    },
  };
  return gateway;
}

test('a follow-up turn is prompted with the earlier exchange', async () => {
  const gateway = recordingGateway();
  const started = await startTestApp({ gateway });
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
    assert.equal(firstTurnPrompts, 2);
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
    assert.equal(followUpPrompts.length, 2);
    // Only the reasoning step needs conversational context; verification is
    // assessed from collected evidence, not from the transcript.
    const followUpStep = followUpPrompts[0] ?? '';
    assert.ok(followUpStep.includes('Earlier in this conversation:'));
    assert.ok(followUpStep.includes('Owner: First objective'));
    assert.ok(followUpStep.includes('Assistant: answer-1'));
    assert.equal(followUpStep.split('Follow-up objective').length - 1, 1);

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
  const started = await startTestApp({ gateway });
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
