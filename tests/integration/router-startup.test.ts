import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import { baseConfig, createWorkspaces, OWNER_TOKEN, testProviderPolicy } from '../helpers.js';

const PROVIDER = {
  id: 'fixture',
  kind: 'openai' as const,
  baseURL: 'https://provider.example/v1',
  apiKeyEnv: 'FIXTURE_API_KEY',
};

function discovery(pricing: Record<string, unknown> | null): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'fixture-model',
            name: 'Fixture',
            context_length: 32_768,
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            ...(pricing === null ? {} : { pricing }),
            supported_parameters: ['tools'],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

test('a configured provider with a zero price list starts and is routable', async () => {
  const workspace = createWorkspaces();
  try {
    const app = await composeApplication({
      config: baseConfig(workspace, {
        models: {
          route: [{ providerId: 'fixture', modelId: 'fixture-model' }],
          providers: [PROVIDER],
          policy: [testProviderPolicy('fixture')],
        },
      }),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, FIXTURE_API_KEY: 'authenticated-but-not-free' },
      fetchImpl: discovery({ prompt: '0', completion: '0', request: '0' }),
    });
    try {
      assert.equal(app.modelRouter.hasVerifiedFreeRoute(), true);
      assert.deepEqual(app.modelRouter.route(), [
        { providerId: 'fixture', modelId: 'fixture-model' },
      ]);
      assert.equal(app.service.models().allowPaid, false);
    } finally {
      await app.stop();
    }
  } finally {
    workspace.cleanup();
  }
});

test('an API key with no price and no attestation fails startup closed', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: baseConfig(workspace, {
            models: {
              providers: [PROVIDER],
              policy: [testProviderPolicy('fixture')],
            },
          }),
          env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, FIXTURE_API_KEY: 'authenticated-but-not-free' },
          fetchImpl: discovery(null),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.issues.join('\n'), /No agent is available/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('an expired attestation does not rescue an unpriced provider at startup', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: baseConfig(workspace, {
            models: {
              providers: [PROVIDER],
              policy: [testProviderPolicy('fixture')],
              attestations: [
                {
                  providerId: 'fixture',
                  modelId: 'fixture-model',
                  evidenceUrl: 'https://provider.example/pricing',
                  verifiedAt: '2026-01-01T00:00:00.000Z',
                  expiresAt: '2026-02-01T00:00:00.000Z',
                },
              ],
            },
          }),
          env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, FIXTURE_API_KEY: 'key' },
          fetchImpl: discovery(null),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.issues.join('\n'), /No agent is available/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('a configured provider whose key variable is missing fails startup and names it', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: baseConfig(workspace, {
            models: { providers: [PROVIDER] },
          }),
          env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
          fetchImpl: discovery({ prompt: '0', completion: '0' }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.issues.join('\n'), /FIXTURE_API_KEY/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});
