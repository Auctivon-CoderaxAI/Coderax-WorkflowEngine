import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GameCapabilityReport } from '@coderax/contracts';
import { composeApplication } from '../../src/bootstrap/compose.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  startTestApp,
  waitFor,
} from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };
const PROMPT =
  'A side-view platformer about a lamplighter relighting beacons across a quiet town before nightfall.';
// The acceptance gate runs compiled tests from dist/tests/integration.
const browserEvidence = new URL('../../../docs/evidence/browser/', import.meta.url);

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

test('a game project, build history and restore survive an engine restart', async () => {
  const workspace = createWorkspaces();
  const env = { CODERAX_OWNER_TOKEN: OWNER_TOKEN };
  let gameId = '';
  let buildId = '';
  try {
    const first = await composeApplication({
      config: baseConfig(workspace),
      env,
      gateway: fakeGateway(),
    });
    try {
      const created = await first.service.createGame(principal, {
        name: 'Lamplighter',
        prompt: PROMPT,
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      gameId = created.value.gameId;
      const built = await first.service.buildGame(principal, gameId, {});
      assert.equal(built.ok, true);
      if (!built.ok) return;
      buildId = built.value.buildId;
    } finally {
      await first.stop();
    }

    // A fresh application has no in-memory project state; it must read the
    // project and the verified build from the durable workspace.
    const second = await composeApplication({
      config: baseConfig(workspace),
      env,
      gateway: fakeGateway(),
    });
    try {
      const game = await second.service.getGame(principal, gameId);
      assert.equal(game.ok, true);
      if (!game.ok) return;
      assert.equal(game.value.build?.buildId, buildId);

      const history = await second.service.listGameBuilds(principal, gameId);
      assert.equal(history.ok, true);
      if (!history.ok) return;
      const listed = history.value.builds.find((build) => build.buildId === buildId);
      assert.ok(listed);
      assert.equal(listed.verified, true);

      const restored = await second.service.restoreGameBuild(principal, gameId, buildId, {
        expectedRevision: game.value.revision,
      });
      assert.equal(restored.ok, true);
      if (!restored.ok) return;
      assert.equal(restored.value.build?.buildId, buildId);
      assert.equal(restored.value.status, 'verified');

      const preview = await second.service.gamePreview(principal, gameId);
      assert.equal(preview.ok, true);
      if (preview.ok) assert.match(preview.value, /createOscillator/);
    } finally {
      await second.stop();
    }
  } finally {
    workspace.cleanup();
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

test('capability rows keep browser evidence, AI-assisted routing and cloud-browser play distinct', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/games/capabilities`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(response.status, 200);
    // Parsing with the published contract also proves the HTTP payload matches it.
    const report = GameCapabilityReport.parse(await response.json());
    assert.equal(
      new Set(report.capabilities.map((row) => row.id)).size,
      report.capabilities.length,
      'capability ids are unique',
    );
    for (const row of report.capabilities) {
      assert.ok(row.evidence.length > 0, `${row.id} names its evidence`);
      assert.equal(
        row.status === 'operational',
        row.available,
        `${row.id}: availability must match the status`,
      );
      if (row.status === 'blocked') assert.ok(row.blockedBy, `${row.id} must name its blocker`);
    }

    const browser = report.capabilities.find((row) => row.id === 'native.game-studio.browser');
    assert.ok(browser);
    assert.equal(browser.status, 'degraded');
    assert.equal(browser.available, false);
    assert.equal(browser.modelAssisted, false);
    assert.deepEqual(browser.environments, ['cloud-browser-chromium']);
    assert.equal(browser.isolation, 'owner-only-preview-origin');
    assert.match(browser.blockedBy ?? '', /per-build/);
    assert.ok(browser.evidence.every((entry) => entry.startsWith('docs/evidence/browser/')));

    // The row is only credible if the evidence it names exists and records the
    // measured result rather than a planned one.
    for (const name of [
      'README.md',
      'report.json',
      'platformer-desktop.png',
      'platformer-mobile.png',
      'platformer-level2.png',
      'puzzle-desktop.png',
      'puzzle-mobile.png',
    ]) {
      assert.ok(
        existsSync(new URL(name, browserEvidence)),
        `${name} is named by the row but missing`,
      );
    }
    const measured = JSON.parse(readFileSync(new URL('report.json', browserEvidence), 'utf8')) as {
      environment: {
        ownerAuth: { anonymousContextStatus: number; authenticatedStatus: number };
      };
      platformer: { win: { status: string } };
      puzzle: { autonomousController: { status: string } };
      limitations: string[];
    };
    assert.equal(measured.platformer.win.status, 'won');
    assert.equal(measured.puzzle.autonomousController.status, 'won');
    assert.equal(measured.environment.ownerAuth.anonymousContextStatus, 403);
    assert.equal(measured.environment.ownerAuth.authenticatedStatus, 200);
    assert.ok(
      measured.limitations.some((line) => /controller is acceptance-test code/.test(line)),
      'the evidence must not present the browser controller as the agent runtime',
    );

    const assisted = report.capabilities.find(
      (row) => row.id === 'native.game-studio.ai-assisted',
    );
    assert.ok(assisted);
    // The test app wires a gateway, so routing exists; participation is still
    // not claimed as verified.
    assert.equal(assisted.modelAssisted, true);
    assert.equal(assisted.status, 'degraded');
    assert.equal(assisted.available, false);
    assert.match(assisted.blockedBy ?? '', /executed model-assisted build/);
    assert.ok(assisted.evidence.some((entry) => entry.includes('src/games/assistant.ts')));

    const browserAgent = report.capabilities.find(
      (row) => row.id === 'native.gaming-agent.browser',
    );
    assert.ok(browserAgent);
    assert.equal(browserAgent.status, 'blocked');
    assert.equal(browserAgent.available, false);
    assert.deepEqual(browserAgent.environments, []);
    assert.equal(browserAgent.isolation, null);
    assert.match(browserAgent.blockedBy ?? '', /zero-cost cloud browser/);
    assert.ok(browserAgent.evidence.some((entry) => entry.includes('src/games/session.ts')));
  } finally {
    await started.close();
  }
});

test('an AI-assisted narrative is recorded by the project but does not make the row available', async () => {
  const gateway = fakeGateway({
    text: JSON.stringify({
      logline: 'A lamplighter relights the town one beacon at a time.',
      pillars: ['light', 'quiet'],
    }),
  });
  const started = await startTestApp({ gateway });
  try {
    const created = await started.app.service.createGame(principal, {
      name: 'Lamplighter',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.design?.modelAssisted, true);
    assert.equal(created.value.design?.logline, 'A lamplighter relights the town one beacon at a time.');
    assert.deepEqual(created.value.design?.pillars, ['light', 'quiet']);
    assert.ok(gateway.calls >= 1, 'the configured route was actually called');

    const built = await started.app.service.buildGame(principal, created.value.gameId, {});
    assert.equal(built.ok, true);
    if (built.ok) {
      assert.equal(built.value.status, 'verified');
      assert.equal(built.value.verification.passed, true);
    }

    const report = await started.app.service.gameCapabilities(principal);
    const assisted = report.capabilities.find(
      (row) => row.id === 'native.game-studio.ai-assisted',
    );
    assert.ok(assisted);
    assert.equal(assisted.modelAssisted, true);
    assert.equal(assisted.status, 'degraded');
    assert.equal(assisted.available, false);
  } finally {
    await started.close();
  }
});

test('without a model route the AI-assisted row is blocked by its prerequisite', async () => {
  const workspace = createWorkspaces();
  // The engine requires one available agent to compose. With no model gateway,
  // an injected external transport keeps the engine alive without changing the
  // fact that no model route exists.
  const app = await composeApplication({
    config: baseConfig(workspace, {
      engines: {
        opencode: {
          enabled: true,
          baseURL: 'https://opencode.invalid',
          model: 'test/model',
          passwordEnv: 'CODERAX_TEST_OPENCODE_PASSWORD',
        },
      },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: null,
    externals: {
      opencode: {
        probe: async () => undefined,
        run: async () => ({
          ok: false as const,
          code: 'not_configured',
          detail: 'The test transport does not run tasks.',
          retryable: false,
        }),
      },
    },
  });
  try {
    const report = await app.service.gameCapabilities(principal);
    const assisted = report.capabilities.find(
      (row) => row.id === 'native.game-studio.ai-assisted',
    );
    assert.ok(assisted);
    assert.equal(assisted.modelAssisted, false);
    assert.equal(assisted.status, 'blocked');
    assert.equal(assisted.available, false);
    assert.match(assisted.blockedBy ?? '', /zero-cost model credential/);

    const browser = report.capabilities.find((row) => row.id === 'native.game-studio.browser');
    assert.ok(browser);
    assert.equal(browser.status, 'degraded');

    const browserAgent = report.capabilities.find(
      (row) => row.id === 'native.gaming-agent.browser',
    );
    assert.ok(browserAgent);
    assert.equal(browserAgent.status, 'blocked');
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});
