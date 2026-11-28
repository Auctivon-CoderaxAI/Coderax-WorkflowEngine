import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('the tool catalogue is substantive and host capabilities stay off', async () => {
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

    // Every advertised tool names the authority it needs and how it is approved.
    for (const tool of tools.tools) {
      assert.ok(tool.scopes.length >= 1, `${tool.name} declares no scope`);
      assert.ok(['never', 'once', 'always'].includes(tool.approval));
      assert.ok(tool.description.length > 0);
    }

    // A duplicate name would make execution depend on registration order.
    assert.equal(new Set(names).size, names.length);
  } finally {
    await started.close();
  }
});

test('knowledge is stored and retrieved per owner and data mode', async () => {
  const started = await startTestApp();
  try {
    const ingested = await started.app.service.ingestKnowledge(principal, {
      title: 'Engine note',
      text: 'Durable leases fence generation writes and resume interrupted tasks.',
      mode: 'cloud',
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.embedding, 'lexical');
    assert.ok(ingested.value.chunks >= 1);

    const found = await started.app.service.searchKnowledge(principal, 'durable leases', 3, 'cloud');
    assert.equal(found.hits[0]?.title, 'Engine note');
    assert.equal(found.embedding, 'lexical');

    // The partition is part of the lookup key, not a filter applied afterwards.
    const privateOnly = await started.app.service.searchKnowledge(principal, 'durable leases', 3, 'private');
    assert.deepEqual(privateOnly.hits, []);

    const listed = await started.app.service.listKnowledge(principal, 'cloud');
    assert.equal(listed.documents.length, 1);
    assert.equal(listed.documents[0]?.documentId, ingested.value.documentId);
    assert.equal(listed.documents[0]?.mode, 'cloud');

    const otherOwner = await started.app.service.listKnowledge(
      { ownerId: 'someone-else', isOwner: true as const },
      'cloud',
    );
    assert.deepEqual(otherOwner.documents, []);
  } finally {
    await started.close();
  }
});

test('a supervised work run records a verified execution identity', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Summarize the durable execution rules',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const { taskId } = submitted.value;

    await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    const history = await started.app.dependencies.supervisor.history(taskId);
    assert.equal(history.length, 1);
    const attempt = history[0];
    assert.ok(attempt);
    assert.equal(attempt.kind, 'work');
    assert.equal(attempt.cause, 'completed');
    assert.equal(attempt.termination?.status, 'verified');
    assert.equal(attempt.termination?.method, 'no-child-processes');
    assert.equal(attempt.processUseCount, 0);
    assert.ok(attempt.finishedAt !== null);

    // Nothing survives the settlement: the attempt is closed, not merely idle.
    assert.equal(started.app.dependencies.supervisor.isolation().activeExecutions, 0);
  } finally {
    await started.close();
  }
});
