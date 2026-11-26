import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_ID, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };
const PROMPT =
  'A side-view platformer about a lamplighter relighting beacons across a quiet town before nightfall.';

test('Game Studio builds, previews, exports and verifies a playable game over HTTP', async () => {
  const started = await startTestApp();
  try {
    const unauthenticated = await fetch(`${started.url}/v1/games/capabilities`);
    assert.equal(unauthenticated.status, 401);

    const capabilities = await started.app.service.gameCapabilities(principal);
    const studio = capabilities.capabilities.find((entry) => entry.id === 'native.game-studio');
    const agent = capabilities.capabilities.find((entry) => entry.id === 'native.gaming-agent');
    const external = capabilities.capabilities.find(
      (entry) => entry.id === 'native.gaming-agent.external',
    );
    assert.ok(studio && agent && external);
    assert.equal(studio.status, 'operational');
    assert.equal(studio.available, true);
    assert.equal(studio.isolation, null);
    assert.equal(agent.status, 'operational');
    assert.equal(agent.isolation, 'in-process-v8-context');
    assert.equal(external.status, 'blocked');
    assert.equal(external.available, false);
    assert.ok(external.blockedBy);

    const created = await started.app.service.createGame(principal, {
      name: 'Lamplighter',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const gameId = created.value.gameId;
    assert.equal(created.value.spec?.camera, 'side_view');

    const built = await started.app.service.buildGame(principal, gameId, {});
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.value.status, 'verified');
    assert.equal(built.value.verification.passed, true);
    assert.ok(built.value.verification.checks.every((check) => check.passed));
    assert.ok(built.value.verification.levels.every((level) => level.completed));
    assert.ok(built.value.files.some((file) => file.kind === 'html'));
    assert.ok(built.value.files.some((file) => file.kind === 'js'));
    assert.ok(built.value.files.some((file) => file.kind === 'svg'));

    const preview = await fetch(`${started.url}/v1/games/${gameId}/preview`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type') ?? '', /text\/html/);
    assert.match(
      preview.headers.get('content-security-policy') ?? '',
      /default-src 'none'/,
    );
    const html = await preview.text();
    assert.match(html, /<canvas/);
    assert.match(html, /Content-Security-Policy/);

    const exported = await started.app.service.exportGame(principal, gameId);
    assert.equal(exported.ok, true);
    if (exported.ok) {
      const archive = Buffer.from(exported.value.base64, 'base64');
      assert.equal(archive.subarray(0, 2).toString(), 'PK');
      assert.equal(exported.value.mediaType, 'application/zip');
    }
  } finally {
    await started.close();
  }
});

test('build history lists versions and restores a verified build with its exact spec', async () => {
  const started = await startTestApp();
  try {
    const created = await started.app.service.createGame(principal, {
      name: 'Lamplighter',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok || !created.value.spec) return;
    const gameId = created.value.gameId;

    const first = await started.app.service.buildGame(principal, gameId, {});
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // A second spec revision produces a distinct build without changing the game.
    const afterFirst = await started.app.service.getGame(principal, gameId);
    assert.equal(afterFirst.ok, true);
    if (!afterFirst.ok) return;
    const saved = await started.app.service.saveGameSpec(principal, gameId, {
      spec: created.value.spec,
      expectedRevision: afterFirst.value.revision,
    });
    assert.equal(saved.ok, true);
    const second = await started.app.service.buildGame(principal, gameId, {});
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.notEqual(first.value.buildId, second.value.buildId);

    const history = await started.app.service.listGameBuilds(principal, gameId);
    assert.equal(history.ok, true);
    if (!history.ok) return;
    const listed = history.value.builds.map((build) => build.buildId);
    assert.ok(listed.includes(first.value.buildId));
    assert.ok(listed.includes(second.value.buildId));
    assert.ok(history.value.builds.every((build) => build.status === 'verified' && build.verified));

    const current = await started.app.service.getGame(principal, gameId);
    assert.equal(current.ok, true);
    if (!current.ok) return;
    const restored = await started.app.service.restoreGameBuild(
      principal,
      gameId,
      first.value.buildId,
      { expectedRevision: current.value.revision },
    );
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.value.build?.buildId, first.value.buildId);
    assert.equal(restored.value.status, 'verified');
    assert.deepEqual(restored.value.spec, created.value.spec);

    const preview = await started.app.service.gamePreview(principal, gameId);
    assert.equal(preview.ok, true);
    if (preview.ok) assert.match(preview.value, /createOscillator/);

    const stale = await started.app.service.restoreGameBuild(
      principal,
      gameId,
      first.value.buildId,
      { expectedRevision: current.value.revision },
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'conflict');
  } finally {
    await started.close();
  }
});

test('the gaming agent completes a verified objective and records evidence', async () => {
  const started = await startTestApp();
  try {
    const created = await started.app.service.createGame(principal, {
      name: 'Lamplighter',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const built = await started.app.service.buildGame(principal, created.value.gameId, {});
    assert.equal(built.ok, true);

    const session = await started.app.service.createGameSession(principal, created.value.gameId, {
      objective: { kind: 'reach_goal', target: 1 },
      allowedActions: ['left', 'right', 'jump'],
      maxTicks: 20_000,
    });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    assert.ok(session.value.taskId);

    const finished = await waitFor(async () => {
      const current = await started.app.service.getGameSession(principal, session.value.sessionId);
      return current.ok && current.value.status === 'completed' ? current.value : null;
    });
    assert.equal(finished.verification?.achieved, true);
    assert.equal(finished.progress.levelsCleared, finished.progress.totalLevels);
    assert.ok(finished.logs.some((entry) => entry.event === 'level-cleared'));
    assert.ok(finished.memory.length > 0);

    const verification = await started.app.service.gameSessionVerification(
      principal,
      session.value.sessionId,
    );
    assert.equal(verification.ok, true);
    if (verification.ok) {
      assert.equal(verification.value.achieved, true);
      assert.equal(verification.value.checks.every((check) => check.passed), true);
      assert.ok(verification.value.artifactPaths.length > 0);
    }

    const task = await started.app.service.task(principal, session.value.taskId as string);
    assert.equal(task.ok, true);
    if (task.ok) assert.equal(task.value.state, 'completed');

    // The session could only run because creating it wrote a scoped grant.
    const grant = await started.app.service.permissions(
      principal,
      session.value.taskId as string,
    );
    assert.equal(grant.ok, true);
    if (!grant.ok) return;
    const approved = grant.value.requests.find(
      (request) =>
        request.scope === 'command.execute' &&
        request.resource === `game-session:${session.value.sessionId}`,
    );
    assert.ok(approved);
    assert.equal(approved.decision, 'approved');

    // The observation is a real rendered frame plus measured state.
    const observation = await started.app.service.observeGameSession(
      principal,
      session.value.sessionId,
    );
    assert.equal(observation.ok, true);
    if (observation.ok) {
      assert.ok(observation.value.state.levelCount >= 1);
      assert.equal(
        Buffer.from(observation.value.frame?.pngBase64 ?? '', 'base64').subarray(0, 2).toString('hex'),
        '8950',
      );
    }
  } finally {
    await started.close();
  }
});

test('the owner can pause, take over, feed bounded input and cancel a live session', async () => {
  const started = await startTestApp();
  try {
    const created = await started.app.service.createGame(principal, {
      name: 'Lamplighter',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const built = await started.app.service.buildGame(principal, created.value.gameId, {});
    assert.equal(built.ok, true);

    const session = await started.app.service.createGameSession(principal, created.value.gameId, {
      objective: { kind: 'score_at_least', target: 100_000 },
      allowedActions: ['left', 'right', 'jump'],
      maxTicks: 40_000,
    });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const sessionId = session.value.sessionId;

    const paused = await started.app.service.controlGameSession(principal, sessionId, {
      action: 'pause',
    });
    assert.equal(paused.ok, true);
    if (paused.ok) assert.equal(paused.value.status, 'paused');

    const observation = await waitFor(async () => {
      const current = await started.app.service.observeGameSession(principal, sessionId);
      return current.ok ? current.value : null;
    });
    assert.equal(observation.status, 'paused');

    const taken = await started.app.service.controlGameSession(principal, sessionId, {
      action: 'takeover',
    });
    assert.equal(taken.ok, true);
    if (taken.ok) assert.equal(taken.value.status, 'taken_over');

    const input = await started.app.service.controlGameSession(principal, sessionId, {
      action: 'input',
      input: {
        left: true,
        right: false,
        up: false,
        down: false,
        jump: false,
        fire: false,
        dash: false,
      },
    });
    assert.equal(input.ok, true);

    const released = await started.app.service.controlGameSession(principal, sessionId, {
      action: 'release',
    });
    assert.equal(released.ok, true);
    if (released.ok) assert.equal(released.value.status, 'running');

    const cancelled = await started.app.service.controlGameSession(principal, sessionId, {
      action: 'cancel',
      reason: 'owner stopped the run',
    });
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) {
      assert.equal(cancelled.value.status, 'cancelled');
      assert.equal(cancelled.value.failure?.code, 'cancelled');
    }

    const logs = await started.app.service.gameSessionLogs(principal, sessionId);
    assert.equal(logs.ok, true);
    if (logs.ok) {
      const events = logs.value.logs.map((entry) => entry.event);
      assert.ok(events.includes('paused'));
      assert.ok(events.includes('takeover'));
      assert.ok(events.includes('owner-input'));
      assert.ok(events.includes('cancelled'));
    }
  } finally {
    await started.close();
  }
});
