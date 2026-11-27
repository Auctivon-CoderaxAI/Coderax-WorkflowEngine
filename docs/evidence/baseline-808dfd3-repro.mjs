/**
 * Baseline reproduction for docs/security-remediation.md.
 *
 * This script runs against commit 808dfd3, NOT against the current head. It uses
 * that revision's composition API (`gateway`, no provider registry), which was
 * replaced by the policy registry, so it is kept as evidence rather than as a
 * test in the suite.
 *
 * Usage:
 *   git worktree add /tmp/baseline 808dfd3
 *   cp docs/evidence/baseline-808dfd3-repro.mjs /tmp/baseline/repro.mjs
 *   cd /tmp/baseline && npm ci && npm run build && node repro.mjs
 *
 * Every `true` below is a defect present in the vulnerable implementation. The
 * same behaviours are asserted, and are false, in tests/security/remediation.test.ts
 * at the head of this branch.
 */
import { composeApplication } from './dist/src/bootstrap/compose.js';
import { createWorkspaces, baseConfig, OWNER_TOKEN } from './dist/tests/helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true };
const results = {};

function gateway(text) {
  let calls = 0;
  return {
    id: 'hosted-gateway',
    calls: () => calls,
    complete: async () => {
      calls += 1;
      return { text: text(), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function start(options = {}) {
  const workspace = createWorkspaces();
  const config = baseConfig(workspace, options.config);
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, ...(options.env ?? {}) },
    gateway: options.gateway ?? null,
    ...(options.externals ? { externals: options.externals } : {}),
  });
  await app.start();
  return { app, workspace };
}

// A: a private conversation reused for cloud work.
{
  const { app } = await start({ gateway: gateway(() => 'private answer') });
  const chat = await app.service.chat(principal, {
    message: 'a private secret', conversationId: 'conv_cross', mode: 'private', agent: 'coderax',
  });
  const crossed = await app.service.submitWork(principal, {
    objective: 'cloud follow-up', conversationId: 'conv_cross', mode: 'cloud', requireApproval: true,
  });
  results.A_private_conversation_crossed_into_cloud = chat.ok === true && crossed.ok === true;
  await app.stop();
}

// B: a private task dispatched to a hosted endpoint.
{
  const hosted = gateway(() => 'hosted answer');
  const { app } = await start({ gateway: hosted });
  const submitted = await app.service.submitWork(principal, {
    objective: 'private task', mode: 'private', requireApproval: true,
  });
  await app.dependencies.scheduler.idle();
  results.B_private_task_sent_to_hosted_gateway = submitted.ok === true && hosted.calls() > 0;
  await app.stop();
}

// C: an autonomous external agent runs without an owner approval.
{
  let runs = 0;
  const transport = {
    probe: async () => undefined,
    run: async () => { runs += 1; return { ok: true, summary: 'external' }; },
  };
  const { app } = await start({
    gateway: gateway(() => 'x'),
    env: { OPENCODE_PASSWORD: 'pw' },
    externals: { opencode: transport },
    config: { engines: { opencode: { enabled: true, baseURL: 'http://127.0.0.1:4096', model: 'local/model', passwordEnv: 'OPENCODE_PASSWORD' } } },
  });
  const submitted = await app.service.submitWork(principal, {
    objective: 'external work', agent: 'opencode', mode: 'cloud', requireApproval: true,
  });
  await app.dependencies.scheduler.idle();
  const status = await app.service.task(principal, submitted.ok ? submitted.value.taskId : '');
  results.C_requireApproval_agent_ran_without_grant =
    submitted.ok === true && status.ok === true && status.value.state === 'completed' && runs === 1;
  await app.stop();
}

// D: a credential and an owner path returned to the client.
{
  const { app } = await start({
    gateway: gateway(() => 'leak sk-abcdefghijklmnopqrstuvwx from /home/owner/project'),
  });
  const chat = await app.service.chat(principal, { message: 'hi', mode: 'cloud', agent: 'coderax' });
  const text = chat.ok ? chat.value.text : '';
  results.D_reply_contains_credential = /sk-abcdefghijklmnopqrstuvwx/.test(text);
  results.D_reply_contains_home_path = /\/home\/owner/.test(text);
  await app.stop();
}

// E: every conversation shares the mode workspace root.
{
  const roots = [];
  const { app } = await start({ gateway: gateway(() => 'ok') });
  const agent = app.dependencies.agents.get('coderax');
  agent.run = async (request) => {
    roots.push(request.workspaceRoot);
    return { ok: true, summary: 'done' };
  };
  await app.service.submitWork(principal, { objective: 'a', conversationId: 'conv_a', mode: 'cloud', requireApproval: true });
  await app.dependencies.scheduler.idle();
  await app.service.submitWork(principal, { objective: 'b', conversationId: 'conv_b', mode: 'cloud', requireApproval: true });
  await app.dependencies.scheduler.idle();
  results.E_two_conversations_share_one_workspace = roots.length === 2 && roots[0] === roots[1];
  await app.stop();
}

console.log(JSON.stringify(results, null, 2));
