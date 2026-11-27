import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayRequest } from '../../src/models/types.js';
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
    complete: async (request: GatewayRequest) => {
      calls.push(request.prompt);
      const reply = (text: string, usage?: { inputTokens: number; outputTokens: number }) => ({
        text,
        toolCalls: [],
        model: request.model,
        attempts: [request.model],
        latencyMs: 0,
        ...(usage ? { usage } : {}),
      });
      if (request.prompt.includes('Return ONLY a JSON array')) {
        return reply('["Write the report", "Confirm completion"]', { inputTokens: 5, outputTokens: 5 });
      }
      if (request.prompt.includes('Current step (step-2):') && request.prompt.includes('Tool fs.write succeeded')) {
        return reply('{"final":"Confirmed."}');
      }
      if (!request.prompt.includes('Tool fs.write succeeded')) {
        return reply(
          JSON.stringify({
            thought: 'Write the requested report into the workspace.',
            tool: 'fs.write',
            input: { path: 'report.txt', content: 'verified by the engine' },
          }),
          { inputTokens: 7, outputTokens: 9 },
        );
      }
      return reply(
        JSON.stringify({ thought: 'The report exists.', final: 'Wrote report.txt.' }),
        { inputTokens: 3, outputTokens: 4 },
      );
    },
  };
}

test('a tool action suspends for approval, resumes and writes a real file', async () => {
  const gateway = scriptedGateway();
  const started = await startTestApp({ gateway });
  try {
    const { tasks } = started.app.dependencies;
    const update = tasks.updateFenced;
    const writes: string[] = [];
    tasks.updateFenced = async (input) => {
      if (input.patch.checkpoint && !input.patch.state) {
        await new Promise(resolve => setTimeout(resolve, 40));
        writes.push('report');
      }
      if (input.patch.state === 'awaiting_approval') writes.push('suspend');
      return update(input);
    };
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

    assert.deepEqual(writes.slice(0, 3), ['suspend', 'report', 'suspend']);
    // The resumed run replays the suspended action and sees its tool result.
    const afterReplay = gateway.calls.filter(prompt => prompt.includes('Tool fs.write succeeded'));
    assert.ok(afterReplay.length > 0);
    const secondStep = gateway.calls.filter(prompt => prompt.includes('Current step (step-2):'));
    assert.equal(secondStep.length, 2);
    assert.ok(secondStep.every(prompt => prompt.includes('Completed step results:') &&
      prompt.includes('Wrote report.txt.')));
    // Each conversation owns a confined directory under the cloud root.
    const conversations = await readdir(path.join(started.workspace.cloudRoot, 'conversations'));
    assert.equal(conversations.length, 1);
    const content = await readFile(
      path.join(started.workspace.cloudRoot, 'conversations', conversations[0] as string, 'report.txt'),
      'utf8',
    );
    assert.equal(content, 'verified by the engine');

    const events = await started.app.dependencies.events.replay(submitted.value.taskId, 0);
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

test('failed suspension persistence leaves the running task recoverable on lease expiry', async () => {
  const started = await startTestApp({ gateway: scriptedGateway() });
  try {
    const { tasks, scheduler, clock } = started.app.dependencies;
    const update = tasks.updateFenced;
    tasks.updateFenced = async (input) => {
      if (input.patch.state === 'awaiting_approval') throw new Error('storage unavailable');
      return update(input);
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Write the report', mode: 'cloud', requireApproval: true,
    });
    assert.ok(submitted.ok);
    await scheduler.idle();
    const id = submitted.value.taskId;
    assert.equal((await tasks.get(id))?.state, 'running');
    clock.now = () => new Date(Date.now() + 60_000);
    const recovered = await started.app.service.task(principal, id);
    assert.equal(recovered.ok && recovered.value.state, 'interrupted');
  } finally {
    await started.close();
  }
});
