import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelCompletionRequest } from '../../src/agents/native/types.js';
import { OWNER_ID, fakeGateway, startTestApp, verifiedTerms, waitFor } from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function png(width = 2, height = 2): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const attachment = {
  kind: 'image' as const,
  mediaType: 'image/png' as const,
  dataBase64: png(3, 4).toString('base64'),
  name: 'pixel.png',
  alt: 'a three by four test image',
};

function models(input: { vision: boolean }) {
  return {
    route: [{ providerId: 'free', modelId: 'coderax-small' }],
    evidence: [
      {
        providerId: 'free',
        modelId: 'coderax-small',
        toolCalling: true,
        multimodal: input.vision,
        contextTokens: 32_000,
        requestsPerMinute: 100,
        requestsPerDay: 10_000,
        tokensPerDay: 10_000_000,
        concurrentRequests: 4,
        terms: verifiedTerms(),
        privacySource: 'https://provider.example/privacy',
        promptTraining: 'prohibited',
        inferenceSource: 'https://provider.example/usage',
        inferenceObservedAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
  };
}

function recordingGateway(answer: string): {
  calls: number;
  requests: ModelCompletionRequest[];
  id: string;
  complete: (request: ModelCompletionRequest) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
} {
  const gateway = {
    id: 'recording-gateway',
    calls: 0,
    requests: [] as ModelCompletionRequest[],
    complete: async (request: ModelCompletionRequest) => {
      gateway.calls += 1;
      gateway.requests.push(request);
      const text = request.prompt.includes('Return ONLY a JSON array')
        ? '["Respond to the owner"]'
        : answer;
      return { text, usage: { inputTokens: 5, outputTokens: 7 } };
    },
  };
  return gateway;
}

test('Chat carries a validated image to a vision-capable model', async () => {
  const gateway = recordingGateway('{"final":"I can see a small test image."}');
  const started = await startTestApp({ gateway, config: { models: models({ vision: true }) } });
  try {
    const response = await started.app.service.chat(principal, {
      message: 'What do you see?',
      mode: 'cloud',
      agent: 'coderax',
      attachments: [attachment],
    });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.match(response.value.text, /small test image/);
    assert.equal(response.value.media?.[0]?.width, 3);

    const action = gateway.requests.find((request) =>
      request.prompt.includes('Return one JSON object now.'),
    );
    assert.ok(action);
    assert.equal(action.requiresVision, true);
    assert.equal(action.images?.length, 1);
    assert.ok(action.images?.[0]?.startsWith('data:image/png;base64,'));

    const conversation = await started.app.service.conversation(
      principal,
      response.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    if (!conversation.ok) return;
    const user = conversation.value.messages.find((message) => message.role === 'user');
    assert.equal(user?.media?.[0]?.width, 3);
    assert.equal(JSON.stringify(conversation.value).includes(attachment.dataBase64), false);
  } finally {
    await started.close();
  }
});

test('Work persists validated image bytes and routes them with vision', async () => {
  const gateway = recordingGateway('{"final":"The image is a 3 by 4 PNG."}');
  const started = await startTestApp({ gateway, config: { models: models({ vision: true }) } });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Describe the attached image',
      mode: 'cloud',
      requireApproval: true,
      attachments: [attachment],
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.match(completed.result?.summary ?? '', /3 by 4 PNG/);
    assert.deepEqual(
      completed.media?.map((entry) => [entry.mediaType, entry.width, entry.height]),
      [['image/png', 3, 4]],
    );

    const withImage = gateway.requests.filter((request) => (request.images?.length ?? 0) > 0);
    // The model planner and the action turn both see the attached image; neither
    // may be routed without declaring vision.
    assert.ok(withImage.length >= 1);
    assert.equal(withImage.every((request) => request.requiresVision === true), true);
    const stored = await started.app.dependencies.tasks.get(submitted.value.taskId);
    assert.equal(stored?.media[0]?.dataBase64, attachment.dataBase64);
  } finally {
    await started.close();
  }
});

test('an image is refused when no verified model declares vision, before inference', async () => {
  const gateway = fakeGateway();
  const started = await startTestApp({ gateway, config: { models: models({ vision: false }) } });
  try {
    const media = started.app.service.models().media;
    assert.equal(media?.imageInput.available, false);
    assert.equal(media?.imageGeneration.available, false);

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Describe the attached image',
      mode: 'cloud',
      requireApproval: true,
      attachments: [attachment],
    });
    assert.equal(submitted.ok, false);
    if (submitted.ok) return;
    assert.equal(submitted.code, 'model_missing');
    assert.equal(gateway.calls, 0);
  } finally {
    await started.close();
  }
});

test('a creative SVG is validated and returned as a durable task artifact', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456"/></svg>';
  const gateway = recordingGateway(JSON.stringify({ final: '```svg\n' + svg + '\n```' }));
  const started = await startTestApp({ gateway });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Draw a square',
      mode: 'cloud',
      requireApproval: true,
      creative: { format: 'svg', title: 'Square Card' },
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    const artifact = completed.result?.artifacts[0];
    assert.ok(artifact);
    assert.equal(artifact.mediaType, 'image/svg+xml');
    assert.equal(artifact.path, 'artifacts/square-card.svg');
    assert.equal(artifact.title, 'Square Card');
    assert.equal(artifact.sha256?.length, 64);
    assert.ok(artifact.content?.startsWith('<svg'));
    assert.equal(artifact.content?.includes('<script'), false);
    assert.equal((completed.result?.summary ?? '').includes('```svg'), true);
  } finally {
    await started.close();
  }
});

test('an unsafe creative document fails the task instead of being returned', async () => {
  const gateway = recordingGateway(
    JSON.stringify({ final: '```svg\n<svg><script>alert(1)</script></svg>\n```' }),
  );
  const started = await startTestApp({ gateway });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Draw a square',
      mode: 'cloud',
      requireApproval: true,
      creative: { format: 'svg' },
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const failed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'failed' ? status.value : null;
    });
    assert.equal(failed.failure?.code, 'protocol_error');
    assert.match(failed.failure?.detail ?? '', /SVG|scripting/);
    assert.equal(failed.result, undefined);
  } finally {
    await started.close();
  }
});

test('an enabled external agent is refused an attachment rather than receiving it without media', async () => {
  const started = await startTestApp({
    config: {
      engines: {
        freebuff: {
          enabled: true,
          baseURL: 'https://example.test/v1',
          sdkPath: '/tmp/freebuff-sdk',
          model: 'configured-model',
        },
      },
    },
    externals: {
      freebuff: {
        probe: async () => undefined,
        run: async () => ({ ok: true, summary: 'the external agent should not have run' }),
      },
    },
  });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Describe the attached image',
      mode: 'cloud',
      requireApproval: true,
      agent: 'freebuff',
      attachments: [attachment],
    });
    assert.equal(submitted.ok, false);
    if (submitted.ok) return;
    assert.equal(submitted.code, 'validation_failed');
    assert.match(submitted.detail, /only by Coderax Native/);
  } finally {
    await started.close();
  }
});
