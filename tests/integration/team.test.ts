import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelCompletionRequest, BasicModelGateway as ModelGateway } from '../../src/agents/native/types.js';
import type { ExternalAgentTransport } from '../../src/agents/adapters/external.js';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { EngineConfigSchema } from '../../src/configuration/schema.js';
import { createFakeDatabase } from '../fakes/mongo.js';
import {
  OWNER_TOKEN,
  baseConfig,
  createWorkspaces,
  waitFor,
  type TestWorkspace,
} from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/** A zero-cost double: every member answers its own assignment, one step. */
function teamGateway() {
  const prompts: string[] = [];
  return {
    id: 'team-gateway',
    prompts,
    complete: async (request: ModelCompletionRequest) => {
      prompts.push(request.prompt);
      if (request.signal.aborted) throw new Error('aborted');
      const member = /Your assignment \(([^)]+)\)/.exec(request.prompt)?.[1] ?? 'member';
      return {
        text: JSON.stringify({ final: `completed ${member}` }),
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
  };
}

async function start(options: {
  workspace?: TestWorkspace;
  gateway?: ModelGateway;
  config?: Record<string, unknown>;
  externals?: { opencode?: ExternalAgentTransport; freebuff?: ExternalAgentTransport };
  database?: ReturnType<typeof createFakeDatabase>;
}): Promise<{
  app: Application;
  workspace: TestWorkspace;
  ownsWorkspace: boolean;
  close: () => Promise<void>;
}> {
  const workspace = options.workspace ?? createWorkspaces();
  const config = EngineConfigSchema.parse(
    baseConfig(workspace, {
      execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
      ...(options.config ?? {}),
    }),
  );
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: options.gateway ?? teamGateway(),
    ...(options.externals ? { externals: options.externals } : {}),
    ...(options.database ? { persistence: { database: options.database } } : {}),
  });
  await app.start();
  return {
    app,
    workspace,
    ownsWorkspace: options.workspace === undefined,
    close: async () => {
      await app.stop();
      if (options.workspace === undefined) workspace.cleanup();
    },
  };
}

test('a team runs dependency waves and completes only on verified artifacts and test results', async () => {
  const gateway = teamGateway();
  const started = await start({
    gateway,
    config: {
      teams: {
        maxMembers: 4,
        maxParallel: 2,
        maxDurationMs: 20_000,
        maxStepsPerMember: 1,
      },
    },
  });
  try {
    await mkdir(path.join(started.workspace.cloudRoot, 'reports'), { recursive: true });
    await mkdir(path.join(started.workspace.cloudRoot, 'docs'), { recursive: true });
    await writeFile(path.join(started.workspace.cloudRoot, 'docs', 'spec.md'), 'the specification');
    await writeFile(
      path.join(started.workspace.cloudRoot, 'reports', 'tests.json'),
      JSON.stringify({ total: 3, passed: 3, failed: 0 }),
    );

    const submitted = await started.app.service.submitTeam(principal, {
      objective: 'Produce the report',
      mode: 'cloud',
      reasoning: 'complex',
      members: [
        { memberId: 'research', agent: 'coderax', objective: 'Read the spec', dependsOn: [], resources: [] },
        { memberId: 'report', agent: 'coderax', objective: 'Write the report', dependsOn: ['research'], resources: [] },
      ],
      checks: [
        { kind: 'evidence', memberId: 'research' },
        { kind: 'artifact', path: 'docs/spec.md', minBytes: 3 },
        { kind: 'test', path: 'reports/tests.json' },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const completed = await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.deepEqual(completed.members.map((member) => member.state), ['completed', 'completed']);
    assert.equal(completed.verification?.passed, true);
    assert.equal(completed.verification?.checks.length, 4);
    assert.ok(
      completed.verification?.checks.every((check) => check.passed),
      'every objective check passed',
    );
    assert.equal(completed.verification?.artifacts[0]?.path, 'docs/spec.md');
    assert.match(completed.verification?.artifacts[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok(
      gateway.prompts.some(
        (prompt) => prompt.includes('Dependency result 1') && prompt.includes('completed research'),
      ),
      'a dependent member receives the result produced earlier in the same run',
    );

    const events = await started.app.dependencies.events.replay(submitted.value.teamId, 0);
    const types = events.events.map((event) => event.type);
    assert.ok(types.includes('task.started') || types.includes('task.queued'));
    assert.ok(types.includes('task.completed'));
    assert.ok(types.includes('step.completed'));
  } finally {
    await started.close();
  }
});

test('member resource grants are exact, member-scoped and suspend the team until decided', async () => {
  const gateway = teamGateway();
  const started = await start({
    gateway,
    config: { teams: { maxMembers: 4, maxParallel: 2, maxDurationMs: 20_000, maxStepsPerMember: 1 } },
  });
  try {
    await writeFile(path.join(started.workspace.cloudRoot, 'a.txt'), 'alpha');
    await writeFile(path.join(started.workspace.cloudRoot, 'b.txt'), 'beta');

    const submitted = await started.app.service.submitTeam(principal, {
      objective: 'Two readings',
      mode: 'cloud',
      members: [
        { memberId: 'm1', agent: 'coderax', objective: 'Read a', dependsOn: [], resources: ['a.txt'] },
        { memberId: 'm2', agent: 'coderax', objective: 'Read b', dependsOn: [], resources: ['b.txt'] },
      ],
      checks: [{ kind: 'evidence', memberId: 'm1' }],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const awaiting = await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    assert.equal(awaiting.members.every((member) => member.state === 'queued'), true);
    assert.equal(gateway.prompts.length, 0, 'no member runs before the whole wave is authorized');

    const permissions = await started.app.service.teamPermissions(principal, submitted.value.teamId);
    assert.ok(permissions.ok);
    const requests = permissions.value.requests;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((entry) => entry.resource).sort(), ['a.txt', 'b.txt']);
    assert.equal(requests.every((entry) => entry.scope === 'workspace.read' && entry.decision === 'pending'), true);

    const a = requests.find((entry) => entry.resource === 'a.txt');
    assert.ok(a);
    assert.ok(
      (await started.app.service.decideTeamPermission(principal, submitted.value.teamId, {
        requestId: a.requestId,
        decision: 'approved',
      })).ok,
    );

    assert.ok((await started.app.service.resumeTeam(principal, submitted.value.teamId, awaiting.generation)).ok);
    const still = await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'awaiting_approval' && status.value.generation > awaiting.generation
        ? status.value
        : null;
    });
    assert.equal(gateway.prompts.length, 0, 'the second resource is still unauthorized');
    const pending = await started.app.service.teamPermissions(principal, submitted.value.teamId);
    assert.ok(pending.ok);
    const b = pending.value.requests.find((entry) => entry.resource === 'b.txt' && entry.decision === 'pending');
    assert.ok(b);
    assert.ok(
      (await started.app.service.decideTeamPermission(principal, submitted.value.teamId, {
        requestId: b.requestId,
        decision: 'approved',
      })).ok,
    );
    assert.ok((await started.app.service.resumeTeam(principal, submitted.value.teamId, still.generation)).ok);

    await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    // The grant for a.txt does not authorize b.txt, and a different member id
    // must ask again even for the same path.
    const second = await started.app.service.submitTeam(principal, {
      objective: 'Another reading',
      mode: 'cloud',
      members: [
        { memberId: 'm3', agent: 'coderax', objective: 'Read b again', dependsOn: [], resources: ['b.txt'] },
      ],
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    await waitFor(async () => {
      const status = await started.app.service.team(principal, second.value.teamId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    const fresh = await started.app.service.teamPermissions(principal, second.value.teamId);
    assert.ok(fresh.ok);
    assert.equal(fresh.value.requests.filter((entry) => entry.decision === 'pending').length, 1);
  } finally {
    await started.close();
  }
});

test('cancellation reaches every external member and each observes the abort', async () => {
  const abortCount = { started: 0, aborted: 0 };
  const transport: ExternalAgentTransport = {
    probe: async () => undefined,
    run: (request) =>
      new Promise((resolve) => {
        abortCount.started += 1;
        const finish = (): void => {
          abortCount.aborted += 1;
          resolve({ ok: false, code: 'cancelled', detail: 'aborted', retryable: false });
        };
        if (request.signal.aborted) return finish();
        request.signal.addEventListener('abort', finish, { once: true });
      }),
  };
  const started = await start({
    externals: { opencode: transport },
    config: {
      engines: { opencode: { enabled: true } },
      teams: { maxMembers: 2, maxParallel: 2, maxDurationMs: 20_000, maxStepsPerMember: 1 },
    },
  });
  try {
    const submitted = await started.app.service.submitTeam(principal, {
      objective: 'Two external members',
      mode: 'cloud',
      members: [
        { memberId: 'x', agent: 'opencode', objective: 'External x', dependsOn: [], resources: [] },
        { memberId: 'y', agent: 'opencode', objective: 'External y', dependsOn: [], resources: [] },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    await waitFor(async () => (abortCount.started === 2 ? true : null));
    const cancelled = await started.app.service.cancelTeam(principal, submitted.value.teamId);
    assert.equal(cancelled.ok, true);

    const terminal = await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'cancelled' ? status.value : null;
    });
    assert.equal(terminal.members.every((member) => member.state === 'cancelled'), true);
    await waitFor(async () => (abortCount.aborted === 2 ? true : null));
  } finally {
    await started.close();
  }
});

test('team execution is bounded by member count, parallelism and the deadline', async () => {
  const started = await start({
    config: { teams: { maxMembers: 2, maxParallel: 2, maxDurationMs: 5_000, maxStepsPerMember: 1 } },
  });
  try {
    const refused = await started.app.service.submitTeam(principal, {
      objective: 'Too many',
      mode: 'cloud',
      members: [
        { memberId: 'a', agent: 'coderax', objective: 'a', dependsOn: [], resources: [] },
        { memberId: 'b', agent: 'coderax', objective: 'b', dependsOn: [], resources: [] },
        { memberId: 'c', agent: 'coderax', objective: 'c', dependsOn: [], resources: [] },
      ],
    });
    assert.equal(refused.ok, false);
  } finally {
    await started.close();
  }

  let concurrent = 0;
  let maxConcurrent = 0;
  const slowGateway: ModelGateway = {
    id: 'slow-gateway',
    complete: async (request) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 80));
      concurrent -= 1;
      if (request.signal.aborted) throw new Error('aborted');
      return { text: JSON.stringify({ final: 'member result' }), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const parallel = await start({
    gateway: slowGateway,
    config: {
      teams: { maxMembers: 4, maxParallel: 2, maxDurationMs: 10_000, maxStepsPerMember: 1 },
    },
  });
  try {
    const submitted = await parallel.app.service.submitTeam(principal, {
      objective: 'Four external members',
      mode: 'cloud',
      members: ['a', 'b', 'c', 'd'].map((id) => ({
        memberId: id,
        agent: 'coderax' as const,
        objective: `External ${id}`,
        dependsOn: [],
        resources: [],
      })),
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await waitFor(async () => {
      const status = await parallel.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.ok(maxConcurrent <= 2, `parallelism stayed bounded (observed ${maxConcurrent})`);
  } finally {
    await parallel.close();
  }

  const suspended = await start({ workspace: createWorkspaces(), gateway: teamGateway() });
  try {
    await writeFile(path.join(suspended.workspace.cloudRoot, 'gated.txt'), 'gated');
    const submitted = await suspended.app.service.submitTeam(principal, {
      objective: 'Suspended work',
      mode: 'cloud',
      members: [
        { memberId: 'gated', agent: 'coderax', objective: 'Read gated', dependsOn: [], resources: ['gated.txt'] },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const awaiting = await waitFor(async () => {
      const status = await suspended.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    const cancelled = await suspended.app.service.cancelTeam(principal, submitted.value.teamId);
    assert.equal(cancelled.ok, true);
    const terminal = await waitFor(async () => {
      const status = await suspended.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'cancelled' ? status.value : null;
    });
    assert.equal(terminal.failure?.code, 'cancelled');
    const resumed = await suspended.app.service.resumeTeam(
      principal,
      submitted.value.teamId,
      awaiting.generation,
    );
    assert.equal(resumed.ok, false, 'a cancelled team cannot be resumed');
  } finally {
    await suspended.close();
  }

  const hanging: ExternalAgentTransport = {
    probe: async () => undefined,
    run: () => new Promise(() => undefined) as never,
  };
  const bounded = await start({
    externals: { opencode: hanging },
    config: {
      engines: { opencode: { enabled: true } },
      teams: { maxMembers: 2, maxParallel: 1, maxDurationMs: 1_500, maxStepsPerMember: 1 },
    },
  });
  try {
    const startedAt = Date.now();
    const submitted = await bounded.app.service.submitTeam(principal, {
      objective: 'A hanging member',
      mode: 'cloud',
      members: [{ memberId: 'hang', agent: 'opencode', objective: 'Never returns', dependsOn: [], resources: [] }],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const failed = await waitFor(async () => {
      const status = await bounded.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'failed' ? status.value : null;
    });
    assert.equal(failed.failure?.code, 'timeout');
    assert.ok(Date.now() - startedAt < 5_000, 'the team ended at its bound');
  } finally {
    await bounded.close();
  }
});

test('cancelling while a suspended team drains still settles it cancelled', async () => {
  const started = await start({ gateway: teamGateway() });
  let releaseFlush: () => void = () => undefined;
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  let reachedSuspendedFlush = false;
  let teamId = '';

  // Hold the flush that follows the `awaiting_approval` write. The execution
  // context is still in `active` here, but its run token is already null: this
  // is the window where cancellation must settle the team itself.
  const events = started.app.dependencies.events;
  const originalFlush = events.flush.bind(events);
  events.flush = async (flushingTeamId) => {
    if (flushingTeamId === teamId) {
      const status = await started.app.service.team(principal, flushingTeamId);
      if (status.ok && status.value.state === 'awaiting_approval') {
        reachedSuspendedFlush = true;
        await flushGate;
      }
    }
    return originalFlush(flushingTeamId);
  };

  try {
    await writeFile(path.join(started.workspace.cloudRoot, 'late.txt'), 'late');
    const submitted = await started.app.service.submitTeam(principal, {
      objective: 'Cancel while the context drains',
      mode: 'cloud',
      members: [
        { memberId: 'late', agent: 'coderax', objective: 'Read late', dependsOn: [], resources: ['late.txt'] },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    teamId = submitted.value.teamId;

    await waitFor(async () => (reachedSuspendedFlush ? true : null), 5_000);

    const cancellation = started.app.service.cancelTeam(principal, teamId);
    const terminal = await waitFor(async () => {
      const status = await started.app.service.team(principal, teamId);
      return status.ok && status.value.state === 'cancelled' ? status.value : null;
    }, 2_000);
    releaseFlush();
    const cancelled = await cancellation;
    assert.equal(cancelled.ok, true);
    assert.equal(terminal.failure?.code, 'cancelled');

    const resumed = await started.app.service.resumeTeam(principal, teamId, terminal.generation);
    assert.equal(resumed.ok, false, 'a late-cancelled team cannot be resumed');
  } finally {
    releaseFlush();
    await started.close();
  }
});

test('a lock held by another replica refuses the member that needs the resource', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const started = await start({
    workspace,
    database,
    gateway: teamGateway(),
    config: {
      persistence: { driver: 'mongo' },
      teams: { maxMembers: 2, maxParallel: 2, maxDurationMs: 5_000, maxStepsPerMember: 1 },
    },
  });
  try {
    await writeFile(path.join(workspace.cloudRoot, 'free.txt'), 'free');
    await writeFile(path.join(workspace.cloudRoot, 'shared.txt'), 'shared');
    const { createMongoResourceLockStore } = await import('../../src/execution/locks.js');
    const other = createMongoResourceLockStore({
      collection: database.collection('resource_locks'),
    });
    assert.equal(
      (await other.acquire({
        key: 'shared.txt',
        ownerId: 'owner-test',
        owner: 'another-replica',
        ttlMs: 60_000,
        now: new Date(),
      })).acquired,
      true,
    );

    const submitted = await started.app.service.submitTeam(principal, {
      objective: 'Read the shared file',
      mode: 'cloud',
      members: [
        { memberId: 'a-free', agent: 'coderax', objective: 'Read free', dependsOn: [], resources: ['free.txt'] },
        { memberId: 'z-shared', agent: 'coderax', objective: 'Read shared', dependsOn: [], resources: ['shared.txt'] },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await waitFor(async () => {
      const status = await started.app.service.team(principal, submitted.value.teamId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    const permissions = await started.app.service.teamPermissions(principal, submitted.value.teamId);
    assert.ok(permissions.ok);
    assert.equal(permissions.value.requests.length, 2);
    for (const grant of permissions.value.requests) {
      assert.ok(
        (await started.app.service.decideTeamPermission(principal, submitted.value.teamId, {
          requestId: grant.requestId,
          decision: 'approved',
        })).ok,
      );
    }
    const status = await started.app.service.team(principal, submitted.value.teamId);
    assert.ok(status.ok);
    assert.ok((await started.app.service.resumeTeam(principal, submitted.value.teamId, status.value.generation)).ok);
    const failed = await waitFor(async () => {
      const current = await started.app.service.team(principal, submitted.value.teamId);
      return current.ok && current.value.state === 'failed' ? current.value : null;
    });
    assert.equal(failed.failure?.code, 'resource_locked');
    // The first member acquired free.txt during preparation but never ran. Its
    // lock must be released when the wave is refused.
    const probe = createMongoResourceLockStore({
      collection: database.collection('resource_locks'),
    });
    assert.equal(
      (await probe.acquire({
        key: 'free.txt',
        ownerId: 'owner-test',
        owner: 'probe-after-failure',
        ttlMs: 5_000,
        now: new Date(),
      })).acquired,
      true,
      'locks taken by an undispatched wave are released',
    );
    assert.equal(failed.failure?.code, 'resource_locked');
  } finally {
    await started.close();
    workspace.cleanup();
  }
});

  test('agent budgets spend the durable quota shared by every replica', async () => {
    const workspace = createWorkspaces();
    const database = createFakeDatabase();
    const config = {
      persistence: { driver: 'mongo' },
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        dailyRequestBudget: 2,
        dailyTokenBudget: 1_000,
      },
      teams: { maxMembers: 2, maxParallel: 2, maxDurationMs: 10_000, maxStepsPerMember: 1 },
    };
    const first = await start({ workspace, database, config });
    const second = await start({ workspace, database, config });
    const team = await first.app.service.submitTeam(principal, {
      objective: 'Two bounded members',
      mode: 'cloud',
      members: [
        { memberId: 'one', agent: 'coderax', objective: 'First', dependsOn: [], resources: [] },
        { memberId: 'two', agent: 'coderax', objective: 'Second', dependsOn: [], resources: [] },
      ],
    });
    assert.ok(team.ok);
    await waitFor(async () => {
      const status = await second.app.service.team(principal, team.value.teamId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    // Both member slots were charged to the one shared account, so a Work task
    // on the other replica sees no remaining budget.
    const acrossReplicas = await second.app.service.budget(principal);
    assert.equal(acrossReplicas.used.requests, 2);
    assert.equal((acrossReplicas.used.usage.inputTokens ?? 0) > 0, true);
    const refused = await second.app.service.submitWork(principal, {
      objective: 'This must not be admitted',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, 'budget_exhausted');

    await first.app.stop();
    await second.app.stop();
    workspace.cleanup();
  });

  test('a team snapshot survives a process restart and resume skips completed members', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const gateway = teamGateway();
  await mkdir(workspace.cloudRoot, { recursive: true });
  await writeFile(path.join(workspace.cloudRoot, 'input.txt'), 'input');

  const first = await start({
    workspace,
    database,
    gateway,
    config: {
      persistence: { driver: 'mongo' },
      teams: { maxMembers: 4, maxParallel: 1, maxDurationMs: 20_000, maxStepsPerMember: 1 },
    },
  });
  let teamId = '';
  let generation = 1;
  try {
    const submitted = await first.app.service.submitTeam(principal, {
      objective: 'Survive a restart',
      mode: 'cloud',
      members: [
        { memberId: 'first', agent: 'coderax', objective: 'Do the first part', dependsOn: [], resources: [] },
        { memberId: 'second', agent: 'coderax', objective: 'Do the second part', dependsOn: ['first'], resources: ['input.txt'] },
      ],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    teamId = submitted.value.teamId;

    const suspended = await waitFor(async () => {
      const status = await first.app.service.team(principal, teamId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    generation = suspended.generation;
    assert.equal(suspended.members.find((member) => member.memberId === 'first')?.state, 'completed');
    assert.equal(gateway.prompts.filter((prompt) => prompt.includes('Your assignment (first)')).length, 1);
  } finally {
    await first.close();
  }

  const second = await start({
    workspace,
    database,
    gateway,
    config: {
      persistence: { driver: 'mongo' },
      teams: { maxMembers: 4, maxParallel: 1, maxDurationMs: 20_000, maxStepsPerMember: 1 },
    },
  });
  try {
    const restored = await second.app.service.team(principal, teamId);
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.value.state, 'awaiting_approval');
    assert.equal(restored.value.generation, generation);
    assert.equal(restored.value.members.find((member) => member.memberId === 'first')?.state, 'completed');

    const permissions = await second.app.service.teamPermissions(principal, teamId);
    assert.ok(permissions.ok);
    const pending = permissions.value.requests.find((entry) => entry.decision === 'pending');
    assert.ok(pending);
    assert.ok(
      (await second.app.service.decideTeamPermission(principal, teamId, {
        requestId: pending.requestId,
        decision: 'approved',
      })).ok,
    );
    assert.ok((await second.app.service.resumeTeam(principal, teamId, generation)).ok);

    const completed = await waitFor(async () => {
      const status = await second.app.service.team(principal, teamId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.equal(completed.members.every((member) => member.state === 'completed'), true);
    // The first member's checkpoint was reused: its assignment was not replayed.
    assert.equal(gateway.prompts.filter((prompt) => prompt.includes('Your assignment (first)')).length, 1);
    assert.equal(gateway.prompts.filter((prompt) => prompt.includes('Your assignment (second)')).length, 1);
  } finally {
    await second.close();
    workspace.cleanup();
  }
});
