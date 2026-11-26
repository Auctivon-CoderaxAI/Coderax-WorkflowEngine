import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderCompletionRequest } from '../../src/models/types.js';
import { fakeProvider, startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * A scripted zero-cost provider. It answers the plan prompt, acts with the real
 * fs.write tool, then finishes. It is a test double for the provider wire, not a
 * mock of the engine: cost verification, the tool runtime, the permission store,
 * the fence and the task record all run for real.
 */
function scriptedProvider() {
  const calls: string[] = [];
  const base = fakeProvider();
  const answer = (prompt: string): string => {
    if (prompt.includes('Return ONLY a JSON array')) {
      return '["Write the report", "Confirm completion"]';
    }
    if (prompt.includes('Current step (step-1):') && !prompt.includes('Tool fs.read')) {
      return JSON.stringify({ tool: 'fs.read', input: { path: 'baseline.txt' } });
    }
    if (prompt.includes('Current step (step-2):') && prompt.includes('Tool fs.write succeeded')) {
      return '{"final":"Confirmed."}';
    }
    if (!prompt.includes('Tool fs.write succeeded')) {
      return JSON.stringify({
        thought: 'Write the requested report into the workspace.',
        tool: 'fs.write',
        input: { path: 'report.txt', content: 'verified by the engine' },
      });
    }
    return JSON.stringify({ thought: 'The report exists.', final: 'Wrote report.txt.' });
  };
  return {
    id: 'free',
    kind: 'openai' as const,
    calls,
    discover: base.discover,
    complete: async (request: ProviderCompletionRequest) => {
      calls.push(request.prompt);
      return {
        text: answer(request.prompt),
        toolCalls: [],
        usage: { inputTokens: 7, outputTokens: 9 },
      };
    },
  };
}

test('a tool action suspends for approval, resumes and writes a real file', async () => {
  const provider = scriptedProvider();
  const started = await startTestApp({ provider });
  try {
    const baseline = path.join(started.workspace.cloudRoot, 'baseline.txt');
    await writeFile(baseline, 'original baseline');
    const { tasks } = started.app.dependencies;
    const update = tasks.updateFenced;
    const writes: string[] = [];
    tasks.updateFenced = async (input) => {
      if (input.patch.checkpoint && !input.patch.state) {
        await new Promise(resolve => setTimeout(resolve, 3_200));
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

    await writeFile(baseline, 'changed baseline');
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
    assert.deepEqual((await tasks.get(submitted.value.taskId))?.checkpoint.completedSteps, ['step-1']);
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
    const afterReplay = provider.calls.filter(prompt => prompt.includes('Tool fs.write succeeded'));
    assert.ok(afterReplay.some(prompt => prompt.includes('original baseline')));
    assert.ok(!provider.calls.some(prompt => prompt.includes('changed baseline')));
    const secondStep = provider.calls.filter(prompt => prompt.includes('Current step (step-2):'));
    assert.equal(secondStep.length, 2);
    assert.ok(secondStep.every(prompt => prompt.includes('Completed step results:') &&
      prompt.includes('Wrote report.txt.')));
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

    const routing = await started.app.service.routing('complex');
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

for (const partial of ['', 'First step complete.']) test(`suspended cancellation preserves history (partial: ${Boolean(partial)})`, async () => {
  const provider = scriptedProvider();
  const complete = provider.complete;
  provider.complete = request => partial && request.prompt.includes('Current step (step-1):')
    ? Promise.resolve({
        text: JSON.stringify({ final: partial }),
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 2 },
      })
    : complete(request);
  const started = await startTestApp({ provider });
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
    const messages = await started.app.dependencies.conversations.messages(submitted.value.conversationId);
    assert.deepEqual(messages.filter(m => m.role === 'assistant').map(m => m.text), partial ? [partial] : []);
    await assert.rejects(readFile(path.join(started.workspace.cloudRoot, 'report.txt')), { code: 'ENOENT' });
  } finally {
    await started.close();
  }
});

test('failed suspension persistence leaves the running task recoverable on lease expiry', async () => {
  const started = await startTestApp({ provider: scriptedProvider() });
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

test('cancellation after the runner returns wins over suspension while reports drain', async () => {
  const started = await startTestApp({ provider: scriptedProvider() });
  let releaseReports = (): void => {};
  const reports = new Promise<void>(resolve => { releaseReports = resolve; });
  let settlementStarted = false;
  try {
    const { tasks, runner, scheduler } = started.app.dependencies;
    const update = tasks.updateFenced;
    tasks.updateFenced = async (input) => {
      if (input.patch.steps && input.patch.updatedAt && !input.patch.state) await reports;
      return update(input);
    };
    const run = runner.run;
    runner.run = input => run({ ...input, settle: async current => {
      settlementStarted = true;
      await input.settle?.(current);
    } });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Write the report', mode: 'cloud', requireApproval: true,
    });
    assert.ok(submitted.ok);
    const { taskId } = submitted.value;
    await waitFor(async () => settlementStarted || null);
    const cancelled = await started.app.service.cancelTask(principal, taskId);
    assert.equal(cancelled.ok && cancelled.value.outcome, 'accepted');
    releaseReports();
    await scheduler.idle();
    assert.equal((await tasks.get(taskId))?.state, 'cancelled');
    assert.equal(started.app.dependencies.events.replay(taskId, 0).events.at(-1)?.type, 'task.cancelled');
  } finally {
    releaseReports();
    await started.close();
  }
});
