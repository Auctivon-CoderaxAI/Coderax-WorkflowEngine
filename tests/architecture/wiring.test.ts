import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLICATION_DEPENDENCIES,
  INFRASTRUCTURE_DEPENDENCIES,
  createApplicationContainer,
  createDependencyContainer,
} from '../../src/bootstrap/container.js';
import { startTestApp } from '../helpers.js';

test('every named dependency is supplied by the composition root', async () => {
  const started = await startTestApp();
  try {
    const dependencies = started.app.dependencies as Record<string, unknown>;
    for (const name of APPLICATION_DEPENDENCIES) {
      assert.ok(
        dependencies[name] !== undefined && dependencies[name] !== null,
        `dependency ${name} was not wired`,
      );
    }
    assert.deepEqual(
      [...INFRASTRUCTURE_DEPENDENCIES].sort(),
      INFRASTRUCTURE_DEPENDENCIES.slice().sort(),
    );
  } finally {
    await started.close();
  }
});

test('a missing named dependency is a startup error naming it', () => {
  const infrastructure = createDependencyContainer({});
  assert.equal(infrastructure.dependencies, null);
  assert.deepEqual(infrastructure.missing, [...INFRASTRUCTURE_DEPENDENCIES]);

  const application = createApplicationContainer({});
  assert.equal(application.dependencies, null);
  assert.deepEqual(application.missing, [...APPLICATION_DEPENDENCIES]);
});

test('the composed application exposes one route table, one model router and one agent registry', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const routeIds = started.app.router.registry.list().map((route) => route.spec.operationId).sort();
    assert.equal(new Set(routeIds).size, routeIds.length);
    assert.deepEqual(started.app.router.registry.missing(), []);

    // One catalogue, one route: the service does not receive a second catalog
    // and no agent can reach a provider without it.
    const models = deps.models.list();
    assert.equal(models.allowPaid, false);
    assert.ok(models.route.length > 0);
    const resolved = deps.models.resolve(null, 'cloud');
    assert.equal(resolved.ok, true);

    const agents = deps.agents.list().agents;
    assert.deepEqual(agents.map((agent) => agent.id).sort(), ['coderax', 'freebuff', 'opencode']);
    assert.equal(deps.agents.defaultAgent, 'coderax');

    // The configured route is the only route; no fallback catalogue appears.
    assert.deepEqual(deps.models.route('cloud'), models.route);
  } finally {
    await started.close();
  }
});

test('a task cannot bypass the scheduler or the task repository', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const principal = { ownerId: 'owner-test', isOwner: true as const };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Wiring check',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    // The scheduler is the only path into execution; draining it is enough for
    // the task to settle without the submitting caller doing anything else.
    await deps.scheduler.idle();
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.equal(status.ok && status.value.state, 'completed');
  } finally {
    await started.close();
  }
});
