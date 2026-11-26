import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_ID, startTestApp } from '../helpers.js';

const owner = { ownerId: OWNER_ID, isOwner: true as const };
const stranger = { ownerId: 'other-owner', isOwner: true as const };
const PROMPT =
  'A calm top-down puzzle about routing power through plant-like circuits without overloading them.';

test('game projects and sessions are scoped to their owner', async () => {
  const started = await startTestApp();
  try {
    const created = await started.app.service.createGame(owner, {
      name: 'Circuits',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const gameId = created.value.gameId;
    const built = await started.app.service.buildGame(owner, gameId, {});
    assert.equal(built.ok, true);

    assert.equal((await started.app.service.listGames(stranger, {})).projects.length, 0);
    assert.equal((await started.app.service.getGame(stranger, gameId)).ok, false);
    assert.equal((await started.app.service.gamePreview(stranger, gameId)).ok, false);
    assert.equal((await started.app.service.exportGame(stranger, gameId)).ok, false);
    const session = await started.app.service.createGameSession(stranger, gameId, {
      objective: { kind: 'reach_goal', target: 1 },
      allowedActions: ['left', 'right'],
      maxTicks: 600,
    });
    assert.equal(session.ok, false);
    if (!session.ok) assert.equal(session.code, 'not_found');
  } finally {
    await started.close();
  }
});

test('the owner can still read a game it created while another owner is refused', async () => {
  const started = await startTestApp();
  try {
    const created = await started.app.service.createGame(owner, {
      name: 'Circuits',
      prompt: PROMPT,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const mine = await started.app.service.getGame(owner, created.value.gameId);
    assert.equal(mine.ok, true);
    assert.equal(mine.ok && mine.value.name, 'Circuits');
  } finally {
    await started.close();
  }
});

test('disabling games reports the capabilities blocked and refuses new projects', async () => {
  const started = await startTestApp({ config: { games: { enabled: false } } });
  try {
    const capabilities = await started.app.service.gameCapabilities(owner);
    const studio = capabilities.capabilities.find((entry) => entry.id === 'native.game-studio');
    const agent = capabilities.capabilities.find((entry) => entry.id === 'native.gaming-agent');
    assert.ok(studio && agent);
    assert.equal(studio.available, false);
    assert.equal(studio.status, 'unsupported');
    assert.equal(agent.available, false);
    assert.equal(agent.status, 'unsupported');

    const created = await started.app.service.createGame(owner, {
      name: 'Circuits',
      prompt: PROMPT,
    });
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.code, 'engine_not_configured');
  } finally {
    await started.close();
  }
});
