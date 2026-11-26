import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication } from '../../src/bootstrap/compose.js';
import type { ProviderAdapter, ProviderCompletionRequest } from '../../src/models/types.js';
import { createFakeDatabase } from '../fakes/mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeProvider,
  OWNER_ID,
  OWNER_TOKEN,
  pngBytes,
  testProviderPolicy,
  startTestApp,
  waitFor,
} from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

function recordingProvider(options: { vision?: boolean; delayMs?: number } = {}): ProviderAdapter & {
  calls: number;
  requests: ProviderCompletionRequest[];
} {
  const base = fakeProvider({ vision: options.vision });
  const requests: ProviderCompletionRequest[] = [];
  const provider = {
    ...base,
    requests,
    complete: async (request: ProviderCompletionRequest) => {
      provider.calls += 1;
      requests.push(request);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return base.complete(request);
    },
  };
  return provider;
}

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0af"/></svg>';

test('an uploaded image reaches a verified vision model through the real router', async () => {
  const provider = recordingProvider();
  const started = await startTestApp({ provider });
  const api = client(started.url);
  try {
    const capabilities = await api.mediaCapabilities();
    assert.equal(capabilities.inputs.find((entry) => entry.kind === 'image')?.available, true);
    assert.equal(capabilities.inputs.find((entry) => entry.kind === 'audio')?.available, false);

    const upload = await api.uploadMedia({
      mode: 'cloud',
      data: pngBytes(12, 8).toString('base64'),
      declaredType: 'image/png',
    });
    assert.equal(upload.media.mediaType, 'image/png');
    assert.equal(upload.media.width, 12);

    const reply = await api.chat({
      message: 'What is in this image?',
      agent: 'coderax',
      mode: 'cloud',
      attachments: [upload.media.mediaId],
    });
    assert.equal(reply.text, 'A verified result.');
    assert.equal(provider.calls, 1);
    const sent = provider.requests[0]?.messages?.[0];
    assert.equal(sent?.images?.length, 1);
    assert.match(sent?.images?.[0] ?? '', /^data:image\/png;base64,/);

    const conversation = await api.conversation(reply.conversationId);
    assert.deepEqual(conversation.messages[0]?.attachments, [upload.media.mediaId]);

    const downloaded = await api.media(upload.media.mediaId);
    assert.equal(downloaded.data, pngBytes(12, 8).toString('base64'));
  } finally {
    await started.close();
  }
});

test('a text-only route refuses image input and never falls through to paid inference', async () => {
  const provider = recordingProvider({ vision: false });
  const started = await startTestApp({ provider });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'cloud',
      data: pngBytes().toString('base64'),
    });

    const capabilities = await api.mediaCapabilities();
    assert.equal(capabilities.inputs.find((entry) => entry.kind === 'image')?.available, false);

    await assert.rejects(
      () =>
        api.chat({
          message: 'Describe this image',
          agent: 'coderax',
          mode: 'cloud',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'model_missing');
        return true;
      },
    );

    await assert.rejects(
      () =>
        api.chat({
          message: 'Describe this image',
          agent: 'coderax',
          mode: 'cloud',
          model: { providerId: 'free', modelId: 'coderax-small' },
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'model_missing');
        return true;
      },
    );

    assert.equal(provider.calls, 0);
  } finally {
    await started.close();
  }
});

test('a chat grant does not authorize image processing', async () => {
  const provider = recordingProvider();
  const started = await startTestApp({
    provider,
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [
          testProviderPolicy('free', {
            grants: [
              { operation: 'chat', mode: 'cloud', location: 'owner-region' },
              { operation: 'work', mode: 'cloud', location: 'owner-region' },
            ],
          }),
        ],
      },
    },
  });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'cloud',
      data: pngBytes().toString('base64'),
    });
    await assert.rejects(
      () =>
        api.chat({
          message: 'What is in this image?',
          agent: 'coderax',
          mode: 'cloud',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'model_missing');
        assert.match(error.message, /multimodal processing/);
        return true;
      },
    );
    assert.equal(provider.calls, 0);
  } finally {
    await started.close();
  }
});

test('private media is refused when the provider credential is deployment-managed', async () => {
  const provider = recordingProvider();
  const started = await startTestApp({
    provider,
    config: {
      media: { allowPrivateModeAttachments: true },
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [
          testProviderPolicy('free', {
            credentials: 'deployment-managed',
            retention: 'transient',
            training: 'prohibited',
            location: 'owner-region',
            grants: [
              { operation: 'chat', mode: 'cloud', location: 'owner-region' },
              { operation: 'multimodal', mode: 'private', location: 'owner-region' },
            ],
          }),
        ],
      },
    },
  });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'private',
      data: pngBytes().toString('base64'),
    });
    await assert.rejects(
      () =>
        api.chat({
          message: 'Read this private image',
          agent: 'coderax',
          mode: 'private',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'model_missing');
        assert.match(error.message, /owner-managed credential/);
        return true;
      },
    );
    assert.equal(provider.calls, 0);
  } finally {
    await started.close();
  }
});

test('media is bound to its owner and its data mode', async () => {
  const provider = recordingProvider();
  const started = await startTestApp({ provider });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'private',
      data: pngBytes().toString('base64'),
    });

    await assert.rejects(
      () =>
        api.chat({
          message: 'Use this image',
          agent: 'coderax',
          mode: 'cloud',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'forbidden');
        return true;
      },
    );
    assert.equal(provider.calls, 0);

    await assert.rejects(
      () =>
        api.chat({
          message: 'Keep this private',
          agent: 'coderax',
          mode: 'private',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'forbidden');
        assert.match(error.message, /Private-mode attachments are disabled/);
        return true;
      },
    );
    assert.equal(provider.calls, 0);

    const foreign = await started.app.service.mediaItem(
      { ownerId: 'owner-someone-else', isOwner: true },
      upload.media.mediaId,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');
  } finally {
    await started.close();
  }
});

test('external agents are denied owner media rather than inheriting it', async () => {
  const started = await startTestApp({
    config: {
      engines: {
        opencode: {
          enabled: true,
          baseURL: 'http://127.0.0.1:1',
          model: 'external-model',
          passwordEnv: 'CODERAX_OPENCODE_PASSWORD',
        },
      },
    },
    externals: {
      opencode: {
        probe: async () => undefined,
        run: async () => ({ ok: true, summary: 'external result' }),
      },
    },
  });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'cloud',
      data: pngBytes().toString('base64'),
    });
    await assert.rejects(
      () =>
        api.chat({
          message: 'Look at this',
          agent: 'opencode',
          mode: 'cloud',
          attachments: [upload.media.mediaId],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'forbidden');
        assert.match(error.message, /External agents never receive owner media/);
        return true;
      },
    );
  } finally {
    await started.close();
  }
});

test('concurrent image requests cannot exceed the verified budget ceiling', async () => {
  const provider = recordingProvider({ delayMs: 60 });
  const started = await startTestApp({
    provider,
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [testProviderPolicy()],
        dailyRequestBudget: 1,
        dailyTokenBudget: 2_000_000,
      },
    },
  });
  const api = client(started.url);
  try {
    const upload = await api.uploadMedia({
      mode: 'cloud',
      data: pngBytes().toString('base64'),
    });
    const results = await Promise.allSettled([
      api.chat({
        message: 'First',
        agent: 'coderax',
        mode: 'cloud',
        attachments: [upload.media.mediaId],
      }),
      api.chat({
        message: 'Second',
        agent: 'coderax',
        mode: 'cloud',
        attachments: [upload.media.mediaId],
      }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    const rejected = results.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const failure = rejected[0] as PromiseRejectedResult;
    assert.ok(failure.reason instanceof CoderaxApiError);
    assert.equal(failure.reason.code, 'budget_exhausted');
    assert.equal(provider.calls, 1);
  } finally {
    await started.close();
  }
});

test('creative work is validated at settlement and an unsafe body is withheld', async () => {
  const provider = fakeProvider({
    text: [
      'Draft drawing:',
      '```svg',
      SAFE_SVG,
      '```',
      'Draft page:',
      '```html',
      '<script>alert(1)</script>',
      '```',
    ].join('\n'),
  });
  const started = await startTestApp({ provider });
  const api = client(started.url);
  try {
    const accepted = await api.submitWork({
      objective: 'Produce a drawing and a page',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });
    const status = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });
    const creative = status.result?.creative ?? [];
    const safe = creative.find((artifact) => artifact.format === 'svg');
    assert.equal(safe?.safe, true);
    assert.equal(safe?.content, SAFE_SVG);
    const unsafe = creative.find((artifact) => artifact.format === 'html');
    assert.equal(unsafe?.safe, false);
    assert.equal(unsafe?.content, undefined);
    assert.ok(unsafe?.findings.some((finding) => finding.code === 'script'));

    const validation = await api.validateCreative({ format: 'svg', content: SAFE_SVG });
    assert.equal(validation.safe, true);
    assert.equal(validation.sandbox, 'required');
  } finally {
    await started.close();
  }
});

test('media survives a restart when MongoDB is the configured store', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const principal = { ownerId: OWNER_ID, isOwner: true as const };
  try {
    const first = await composeApplication({
      config: baseConfig(workspace, { persistence: { driver: 'mongo' } }),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
      providers: [{ adapter: fakeProvider() }],
      persistence: { database },
    });
    const uploaded = await first.service.uploadMedia(principal, {
      mode: 'cloud',
      data: pngBytes(5, 5).toString('base64'),
    });
    assert.equal(uploaded.ok, true);
    if (!uploaded.ok) return;
    await first.stop();

    assert.ok(
      database.collections.get('media')?.indexes.some(
        (index) => index.keys.mediaId === 1 && index.options?.unique === true,
      ),
    );

    const second = await composeApplication({
      config: baseConfig(workspace, { persistence: { driver: 'mongo' } }),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
      providers: [{ adapter: fakeProvider() }],
      persistence: { database },
    });
    try {
      const found = await second.service.mediaItem(principal, uploaded.value.media.mediaId);
      assert.equal(found.ok, true);
      if (found.ok) {
        assert.equal(found.value.media.width, 5);
        assert.equal(found.value.data, pngBytes(5, 5).toString('base64'));
      }
    } finally {
      await second.stop();
    }
  } finally {
    workspace.cleanup();
  }
});
