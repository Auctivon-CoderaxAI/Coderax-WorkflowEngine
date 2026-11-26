import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TeamRecord } from '../../src/domain.js';
import {
  createMongoTeamRepository,
  createTeamRepository,
  type TeamRepository,
} from '../../src/persistence/teams.js';
import { createFakeDatabase } from '../fakes/mongo.js';

const NOW = '2026-11-26T12:00:00.000Z';

function teamRecord(): TeamRecord {
  return {
    teamId: 'team_resume',
    ownerId: 'owner-test',
    tenantId: null,
    conversationId: 'conv-test',
    mode: 'cloud',
    objective: 'Suspend, cancel, then refuse resume',
    reasoning: 'complex',
    state: 'awaiting_approval',
    generation: 1,
    runToken: null,
    members: [],
    plan: { revision: 1, mode: 'complex', steps: [] },
    checks: [],
    limits: { maxMembers: 1, maxParallel: 1, maxDurationMs: 1_000, maxStepsPerMember: 1 },
    checkpoint: { completedMembers: [], outputs: {}, artifacts: [], evidence: [] },
    verification: null,
    failure: { code: 'approval_required', detail: 'Waiting for approval.', retryable: true },
    cancelRequested: false,
    budget: null,
    usage: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    heartbeatAt: NOW,
  };
}

const repositories: Array<[string, () => TeamRepository]> = [
  ['memory', () => createTeamRepository()],
  [
    'mongo',
    () => createMongoTeamRepository({ collection: createFakeDatabase().collection('teams') }),
  ],
];

for (const [driver, create] of repositories) {
  test(`a cancelled suspended team cannot be resumed through the ${driver} CAS`, async () => {
    const repo = create();
    assert.equal(await repo.create(teamRecord()), true);

    assert.equal(
      await repo.requestCancel({ ownerId: 'owner-test', teamId: 'team_resume', at: NOW }),
      true,
    );
    const cancelled = await repo.cancelInactive({
      ownerId: 'owner-test',
      teamId: 'team_resume',
      at: NOW,
    });
    assert.equal(cancelled?.state, 'cancelled');

    // Cancellation leaves the generation and run token unchanged, so resume
    // must refuse on state rather than relying on either of them.
    const resumed = await repo.resume({
      teamId: 'team_resume',
      ownerId: 'owner-test',
      expectedGeneration: 1,
      at: NOW,
    });
    assert.equal(resumed, null, 'a cancelled state is part of the resume CAS');
  });
}
