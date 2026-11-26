import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelCompletionRequest } from '../../src/agents/native/types.js';
import { startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * A scripted zero-cost model. It answers the plan prompt, acts with the real
 * fs.write tool, then finishes. It is a test double for the provider wire, not a
 * mock of the engine: the tool, permission store, fence and task record all run.
 */
function scriptedGateway() {
  const calls: string[] = [];
  return {
    id: 'scripted-gateway',
    calls,
    complete: async (request: ModelCompletionRequest) => {
      calls.push(request.prompt);
      if (request.prompt.includes('Return ONLY a JSON array')) {
        return { text: '["Write the report", "Confirm completion"]', usage: { inputTokens: 5, outputTokens: 5 } };
      }
      if (request.prompt.includes('Current step (step-2):') && request.prompt.includes('Tool fs.write succeeded')) return { text: '{"final":"Confirmed."}' };
      if (!request.prompt.includes('Tool fs.write succeeded')) {
        return {
          text: JSON.stringify({
            thought: 'Write the requested report into the workspace.',
            tool: 'fs.write',
            input: { path: 'report.txt', content: 'verified by the engine' },
          }),
          usage: { inputTokens: 7, outputTokens: 9 },
        };
      }
      return {
        text: JSON.stringify({ thought: 'The report exists.', final: 'Wrote report.txt.' }),
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
  };
}

test('a tool action suspends for approval, resumes and writes a real file', async () => {
  const gateway = scriptedGateway();
  const started = await startTestApp({ gateway });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Write the report',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const awaiting = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    assert.equal(awaiting.failure?.code, 'approval_required');

    const pending = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const request = pending.value.requests.find((entry) => entry.decision === 'pending');
    assert.ok(request);
    assert.equal(request.scope, 'workspace.write');
    assert.equal(request.resource, 'report.txt');

    const decided = await started.app.service.decidePermission(
      principal,
      submitted.value.taskId,
      { requestId: request.requestId, decision: 'approved' },
    );
    assert.equal(decided.ok, true);

    const resumed = await started.app.service.resumeTask(
      principal,
      submitted.value.taskId,
      awaiting.generation,
    );
    assert.equal(resumed.ok && resumed.value.outcome, 'accepted');

    // Step two requests the identical write. It needs its own owner decision.
    const again = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'awaiting_approval' &&
        status.value.generation > awaiting.generation ? status.value : null;
    });
    const permissions = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.ok(permissions.ok);
    const next = permissions.value.requests.find(entry => entry.decision === 'pending');
    assert.ok(next);
    assert.notEqual(next.requestId, request.requestId);
    assert.ok((await started.app.service.decidePermission(principal, submitted.value.taskId,
      { requestId: next.requestId, decision: 'approved' })).ok);
    assert.ok((await started.app.service.resumeTask(principal, submitted.value.taskId, again.generation)).ok);

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.ok(completed.result?.summary?.includes('Confirmed.'));
    assert.deepEqual(completed.steps.map(step => step.state), ['completed', 'completed']);

    const content = await readFile(
      path.join(started.workspace.cloudRoot, 'report.txt'),
      'utf8',
    );
    assert.equal(content, 'verified by the engine');

    const events = started.app.dependencies.events.replay(submitted.value.taskId, 0);
    const types = events.events.map((event) => event.type);
    assert.ok(types.includes('approval.required'));
    assert.ok(types.includes('tool.call'));
    assert.ok(types.includes('tool.result'));
    assert.equal(types.at(-1), 'task.completed');
  } finally {
    await started.close();
  }
});

test('tools, routing and retrieval are substantive and zero-cost', async () => {
  const started = await startTestApp();
  try {
    const tools = started.app.service.tools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('fs.read'));
    assert.ok(names.includes('fs.write'));
    assert.ok(names.includes('memory.write'));
    assert.ok(names.includes('knowledge.search'));
    // Host-level capabilities stay off until the owner enables them.
    assert.equal(names.includes('shell.run'), false);
    assert.equal(names.includes('http.fetch'), false);

    const routing = started.app.service.routing('complex');
    assert.equal(routing.allowPaid, false);
    assert.ok(routing.route.length > 0);
    assert.ok(routing.providers.every((provider) => provider.costEvidence === 'verified-free'));

    const ingested = await started.app.service.ingestKnowledge(principal, {
      title: 'Engine note',
      text: 'Durable leases fence generation writes and resume interrupted tasks.',
      mode: 'cloud',
    });
    assert.equal(ingested.ok, true);
    const found = await started.app.service.searchKnowledge(
      principal,
      'durable leases',
      3,
      'cloud',
    );
    assert.equal(found.hits[0]?.title, 'Engine note');

    const privateOnly = await started.app.service.searchKnowledge(
      principal,
      'durable leases',
      3,
      'private',
    );
    assert.deepEqual(privateOnly.hits, []);
  } finally {
    await started.close();
  }
});

test('the owner can cancel a suspended task without executing its pending action', async () => {
  const started = await startTestApp({ gateway: scriptedGateway() });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Write the report', mode: 'cloud', requireApproval: true,
    });
    assert.ok(submitted.ok);
    const { taskId } = submitted.value;
    await waitFor(async () => {
      const task = await started.app.service.task(principal, taskId);
      return task.ok && task.value.state === 'awaiting_approval' ? task.value : null;
    });
    const cancelled = await started.app.service.cancelTask(principal, taskId);
    assert.ok(cancelled.ok);
    assert.equal(cancelled.value.state, 'cancelled');
    await assert.rejects(readFile(path.join(started.workspace.cloudRoot, 'report.txt')), { code: 'ENOENT' });
  } finally {
    await started.close();
  }
});
