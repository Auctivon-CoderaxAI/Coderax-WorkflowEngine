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

test('a route may be empty because discovery, not configuration, grants free cost', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: {},
    });
    assert.deepEqual(config.models.route, []);
    assert.deepEqual(config.models.providers, []);
    assert.deepEqual(config.models.attestations, []);
  } finally {
    ws.cleanup();
  }
});

test('duplicate providers and inverted attestations are refused', () => {
  const ws = workspace();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: {
        providers: [
          {
            id: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKeyEnv: 'GROQ_API_KEY',
          },
          {
            id: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKeyEnv: 'GROQ_API_KEY',
          },
        ],
        attestations: [
          {
            providerId: 'groq',
            modelId: 'model',
            evidenceUrl: 'https://console.groq.com/docs/rate-limits',
            verifiedAt: '2026-11-26T00:00:00.000Z',
            expiresAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      },
    });
    const issues = validateInvariants(config);
    assert.ok(issues.some((issue) => issue.includes('models.providers lists groq more than once')));
    assert.ok(issues.some((issue) => issue.includes('must expire after they were verified')));
  } finally {
    ws.cleanup();
  }
});

test('a provider credential must be named, never inlined', () => {
  const ws = workspace();
  try {
    const parsed = EngineConfigSchema.safeParse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
      models: {
        providers: [
          {
            id: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKeyEnv: 'sk-not-an-env-name',
          },
        ],
      },
    });
    assert.equal(parsed.success, false);
  } finally {
    ws.cleanup();
  }
});

test('the persistence driver can be selected from the environment', () => {
  const ws = workspace();
  try {
    const config = loadConfig({
      env: { CODERAX_PERSISTENCE_DRIVER: 'mongo' },
      overrides: {
        auth: { ownerId: 'owner' },
        workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
        models: { route: [{ providerId: 'free', modelId: 'm' }] },
      },
    });
    assert.equal(config.persistence.driver, 'mongo');
    // The connection string is named, never inlined in configuration.
    assert.equal(config.persistence.uriEnv, 'CODERAX_MONGODB_URI');
  } finally {
    ws.cleanup();
  }
});

test('an unknown persistence driver in the environment names the field', () => {
  const ws = workspace();
  try {
    assert.throws(
      () =>
        loadConfig({
          env: { CODERAX_PERSISTENCE_DRIVER: 'postgres' },
          overrides: {
            auth: { ownerId: 'owner' },
            workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
            models: { route: [{ providerId: 'free', modelId: 'm' }] },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(error.issues.some((issue) => issue.startsWith('persistence.driver')));
        return true;
      },
    );
  } finally {
    ws.cleanup();
  }
});

test('provider URLs must be secure and must not smuggle a query or fragment', () => {
  const ws = workspace();
  try {
    const base = {
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: ws.privateRoot, cloudRoot: ws.cloudRoot },
    };
    const provider = (baseURL: string) => ({
      models: {
        providers: [{ id: 'p', baseURL, apiKeyEnv: 'P_API_KEY' }],
      },
    });
    assert.equal(EngineConfigSchema.safeParse({ ...base, ...provider('http://api.example.com/v1') }).success, false);
    assert.equal(EngineConfigSchema.safeParse({ ...base, ...provider('https://api.example.com/v1?key=x') }).success, false);
    assert.equal(EngineConfigSchema.safeParse({ ...base, ...provider('https://api.example.com/v1#fragment') }).success, false);
    assert.equal(EngineConfigSchema.safeParse({ ...base, ...provider('https://api.example.com/v1') }).success, true);
    assert.equal(EngineConfigSchema.safeParse({ ...base, ...provider('http://127.0.0.1:4096/v1') }).success, true);
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
