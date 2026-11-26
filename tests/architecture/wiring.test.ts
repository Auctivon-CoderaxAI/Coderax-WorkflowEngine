import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import {
  APPLICATION_DEPENDENCIES,
  createApplicationContainer,
  createDependencyContainer,
  INFRASTRUCTURE_DEPENDENCIES,
} from '../../src/bootstrap/container.js';
import { baseConfig, createWorkspaces, fakeGateway, OWNER_TOKEN } from '../helpers.js';
import { createFakeDatabase } from '../fakes/mongo.js';

test('the container names every missing dependency instead of failing later', () => {
  const infrastructure = createDependencyContainer({});
  assert.equal(infrastructure.dependencies, null);
  assert.deepEqual(infrastructure.missing, [...INFRASTRUCTURE_DEPENDENCIES]);

  const application = createApplicationContainer({});
  assert.equal(application.dependencies, null);
  assert.deepEqual(application.missing, [...APPLICATION_DEPENDENCIES]);
  assert.ok(application.missing.includes('service'));
  assert.ok(application.missing.includes('router'));
});

test('the memory composition reports process-local persistence truthfully', async () => {
  const workspace = createWorkspaces();
  const app = await composeApplication({
    config: baseConfig(workspace),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: fakeGateway(),
  });
  try {
    assert.equal(app.persistence.driver, 'memory');
    const health = await app.service.health();
    const persistence = health.checks.find((check) => check.name === 'persistence');
    assert.match(persistence?.detail ?? '', /process-local/);
    assert.equal(health.status, 'ok');
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('selecting mongo wires the durable stores and boots the indexes', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const app = await composeApplication({
    config: baseConfig(workspace, {
      persistence: {
        driver: 'mongo',
        database: 'gate_db',
        collectionPrefix: 'gate_',
      },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: fakeGateway(),
    persistence: { database },
  });
  try {
    assert.equal(app.persistence.driver, 'mongo');
    const health = await app.service.health();
    const persistence = health.checks.find((check) => check.name === 'persistence');
    assert.match(persistence?.detail ?? '', /MongoDB/);
    for (const name of ['work_runs', 'tasks', 'conversations', 'messages', 'memory', 'notifications']) {
      assert.ok(database.collections.has(`gate_${name}`), `${name} collection was not opened`);
    }
    const workRuns = database.collections.get('gate_work_runs');
    assert.ok(workRuns?.indexes.some((index) => index.options?.unique === true));
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('startup refuses a missing owner token instead of serving unauthenticated', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      composeApplication({ config: baseConfig(workspace), env: {}, gateway: fakeGateway() }),
      (error: unknown) =>
        error instanceof StartupError &&
        error.issues.some((issue) => issue.includes('CODERAX_OWNER_TOKEN')),
    );
  } finally {
    workspace.cleanup();
  }
});

test('selecting mongo without a connection string is a startup failure, not a downgrade', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      composeApplication({
        config: baseConfig(workspace, {
          persistence: { driver: 'mongo', database: 'gate_db' },
        }),
        env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
        gateway: fakeGateway(),
      }),
      (error: unknown) =>
        error instanceof StartupError &&
        error.issues.some((issue) => issue.includes('CODERAX_MONGODB_URI')),
    );
  } finally {
    workspace.cleanup();
  }
});
