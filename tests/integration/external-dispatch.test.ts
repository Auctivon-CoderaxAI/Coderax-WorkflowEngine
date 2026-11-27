import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExternalAgentTransport } from '../../src/agents/adapters/external.js';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import { baseConfig, createWorkspaces, fakeProvider, OWNER_ID, OWNER_TOKEN, testProviderPolicy, waitFor } from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };
const routedPolicy = testProviderPolicy('free', {
  credentials: 'owner-managed',
  grants: [
    { operation: 'chat', mode: 'cloud', location: 'owner-region' },
    { operation: 'chat', mode: 'private', location: 'owner-region' },
    { operation: 'work', mode: 'private', location: 'owner-region' },
  ],
});
const externalPolicy = testProviderPolicy('opencode', {
  credentials: 'owner-managed',
  grants: [{ operation: 'external_agent', mode: 'private', location: 'owner-region' }],
});

async function fixture(input: {
  transport: ExternalAgentTransport;
  grant?: boolean;
  externalOnly?: boolean;
  noModel?: boolean;
}) {
  const workspace = createWorkspaces();
  try {
    const app = await composeApplication({
      config: baseConfig(workspace, {
        engines: {
          default: input.externalOnly ? 'opencode' : 'native',
          native: { enabled: !input.externalOnly },
          opencode: { enabled: true, baseURL: 'https://agent.example', model: 'fixture', passwordEnv: 'TEST_PASSWORD' },
        },
      }),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, TEST_PASSWORD: 'fixture' },
      providers: input.noModel ? [] : [{ adapter: fakeProvider() }],
      policies: [routedPolicy, ...(input.grant ? [externalPolicy] : [])],
      externals: { opencode: input.transport },
    });
    return { app, close: async () => { await app.stop(); workspace.cleanup(); } };
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

test('private Chat and Work require a grant for the external engine itself', async () => {
  const { app, close } = await fixture({
    transport: { probe: async () => {}, run: async () => { assert.fail('external content was dispatched'); } },
  });
  try {
    for (const result of [
      await app.service.chat(principal, { agent: 'opencode', mode: 'private', message: 'private chat' }),
      await app.service.submitWork(principal, { agent: 'opencode', mode: 'private', objective: 'private work', requireApproval: true }),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'model_missing');
    }
    assert.deepEqual(await app.service.conversations(principal), { conversations: [] });
  } finally {
    await close();
  }
});

test('external Chat and Work retain a token and request charge only after transport dispatch', async () => {
  for (const work of [false, true]) {
    for (const dispatched of [false, true]) {
      let probes = 0;
      let calls = 0;
      const { app, close } = await fixture({
        grant: true,
        transport: {
          probe: async () => {
            if (++probes > 1 && !dispatched) throw new Error('fixture preflight failed');
          },
          run: async (request) => {
            calls += 1;
            assert.equal(request.history, undefined);
            throw new Error('fixture transport failed');
          },
        },
      });
      try {
        if (work) {
          const result = await app.service.submitWork(principal, { agent: 'opencode', mode: 'private', objective: 'fixture work', requireApproval: false });
          assert.ok(result.ok);
          await waitFor(async () => {
            const state = await app.service.task(principal, result.value.taskId);
            return state.ok && state.value.state === 'failed' ? true : null;
          });
        } else if (dispatched) {
          // A transport failure is a failed result on the service contract; the
          // important assertion is that it was dispatched and accounted.
          const result = await app.service.chat(principal, { agent: 'opencode', mode: 'private', message: 'fixture chat' });
          assert.equal(result.ok, false);
        } else {
          const result = await app.service.chat(principal, { agent: 'opencode', mode: 'private', message: 'fixture chat' });
          assert.equal(result.ok, false);
        }
        assert.equal(calls, dispatched ? 1 : 0);
        const charged = await app.dependencies.budget.snapshot(OWNER_ID, app.dependencies.clock.now());
        assert.equal(charged.requests, dispatched ? 1 : 0);
        assert.equal(charged.outputTokens, dispatched ? 1_024 : 0);
        assert.equal(charged.inputTokens > 0, dispatched);
      } finally {
        await close();
      }
    }
  }
});

test('external only readiness still needs a verified model route', async () => {
  const transport = {
    probe: async () => {},
    run: async () => ({ ok: true as const, summary: 'fixture' }),
  };
  await assert.rejects(
    fixture({ transport, grant: true, externalOnly: true, noModel: true }),
    (error: unknown) => error instanceof StartupError && error.issues.some((issue) => /No agent is available/.test(issue)),
  );
  const { app, close } = await fixture({ transport, grant: true, externalOnly: true });
  try {
    const chat = await app.service.chat(principal, { agent: 'opencode', mode: 'private', message: 'fixture chat' });
    assert.ok(chat.ok);
    assert.equal(chat.value.model.providerId, 'free');
  } finally {
    await close();
  }
});

test('a Chat mode conflict cannot append content or replay the existing conversation', async () => {
  const { app, close } = await fixture({
    transport: { probe: async () => {}, run: async () => { assert.fail('unexpected external dispatch'); } },
  });
  try {
    const first = await app.service.chat(principal, { agent: 'coderax', mode: 'private', message: 'private content' });
    assert.ok(first.ok);
    const conversationId = first.value.conversationId;
    const before = await app.dependencies.conversations.messages({ ownerId: OWNER_ID, conversationId, mode: 'private' });
    const result = await app.service.chat(principal, { agent: 'coderax', mode: 'cloud', conversationId, message: 'different mode' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'conflict');
    assert.deepEqual(await app.dependencies.conversations.messages({ ownerId: OWNER_ID, conversationId, mode: 'private' }), before);
  } finally {
    await close();
  }
});
