import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError, loadConfig, validateInvariants } from '../../src/configuration/load.js';
import { EngineConfigSchema } from '../../src/configuration/schema.js';
import { createOwnerAuth, AuthConfigurationError } from '../../src/security/auth.js';
import { baseConfig, createWorkspaces, OWNER_TOKEN } from '../helpers.js';

function workspace() {
  return createWorkspaces();
}

test('an invalid configuration names the failing field', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.issues.some((issue) => /^auth(:|\.)/.test(issue)));
      return true;
    },
  );
});

test('a heartbeat that cannot sustain the lease is refused at startup', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: { route: [{ providerId: 'free', modelId: 'm' }] },
      execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 2_000 },
    });
    const issues = validateInvariants(config);
    assert.ok(issues.some((issue) => issue.includes('execution.heartbeatIntervalMs')));
  } finally {
    ws.cleanup();
  }
});

test('paid routing cannot be configured at all', () => {
  const ws = workspace();
  try {
    const parsed = EngineConfigSchema.safeParse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: { route: [{ providerId: 'free', modelId: 'm' }], allowPaid: true },
    });
    assert.equal(parsed.success, false);
  } finally {
    ws.cleanup();
  }
});

test('a default engine that is disabled is refused', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: { route: [{ providerId: 'free', modelId: 'm' }] },
      engines: { default: 'opencode' },
    });
    const issues = validateInvariants(config);
    assert.ok(issues.some((issue) => issue.includes('engines.default is opencode')));
  } finally {
    ws.cleanup();
  }
});

test('an enabled external engine must name its prerequisites', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: { route: [{ providerId: 'free', modelId: 'm' }] },
      engines: { opencode: { enabled: true } },
    });
    const issues = validateInvariants(config);
    assert.ok(issues.some((issue) => issue.includes('engines.opencode.baseURL')));
    assert.ok(issues.some((issue) => issue.includes('engines.opencode.passwordEnv')));
  } finally {
    ws.cleanup();
  }
});

test('duplicate zero-cost candidates are refused', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: {
        route: [
          { providerId: 'free', modelId: 'm' },
          { providerId: 'free', modelId: 'm' },
        ],
      },
    });
    assert.ok(validateInvariants(config).some((issue) => issue.includes('more than once')));
  } finally {
    ws.cleanup();
  }
});

test('a short owner token is refused instead of accepted as authentication', () => {
  const ws = workspace();
  try {
    const config = baseConfig(ws);
    assert.throws(
      () =>
        createOwnerAuth({
          config: config.auth,
          env: { CODERAX_OWNER_TOKEN: 'short' },
        }),
      (error: unknown) => error instanceof AuthConfigurationError,
    );
    const auth = createOwnerAuth({ config: config.auth, env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN } });
    assert.equal(auth.authenticate(undefined), null);
    assert.equal(auth.authenticate(`Bearer wrong-token-that-is-long-enough`), null);
    assert.deepEqual(auth.authenticate(`Bearer ${OWNER_TOKEN}`), {
      ownerId: config.auth.ownerId,
      isOwner: true,
    });
  } finally {
    ws.cleanup();
  }
});
