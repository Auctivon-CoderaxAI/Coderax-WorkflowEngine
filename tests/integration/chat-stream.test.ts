import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatFrame } from '@coderax/contracts';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, baseConfig, createWorkspaces, fakeProvider } from '../helpers.js';
import { composeApplication } from '../../src/bootstrap/compose.js';

/**
 * Chat advertises `text/event-stream` in the contract, so the transport must
 * actually serve it. These tests drive the real HTTP server: one client asks for
 * SSE, the other does not, and both must receive a shape the published contract
 * describes.
 */

async function startChatApp(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const workspace = createWorkspaces();
  const app = await composeApplication({
    config: baseConfig(workspace),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    providers: [{ adapter: fakeProvider({ text: 'Streamed answer.' }) }],
  });
  const { url } = await app.start();
  return {
    url,
    close: async () => {
      await app.stop();
      workspace.cleanup();
    },
  };
}

test('chat answers SSE when the client accepts it', async () => {
  const app = await startChatApp();
  try {
    const response = await fetch(`${app.url}/v1/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ message: 'Say something.', mode: 'cloud', agent: 'coderax' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await response.text();
    const frames = body
      .split('\n\n')
      .filter((frame) => frame.trim().length > 0)
      .map((frame) => JSON.parse(frame.replace(/^data:\s*/, '')) as unknown);
    assert.ok(frames.length >= 2);
    for (const frame of frames) {
      assert.equal(ChatFrame.safeParse(frame).success, true);
    }
    assert.equal((frames[0] as { type: string }).type, 'chat.delta');
    assert.equal((frames[1] as { type: string }).type, 'chat.completed');
  } finally {
    await app.close();
  }
});

test('chat still answers JSON when the client does not accept SSE', async () => {
  const app = await startChatApp();
  try {
    const response = await fetch(`${app.url}/v1/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ message: 'Say something.', mode: 'cloud', agent: 'coderax' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await response.json()) as { text?: unknown };
    assert.equal(typeof body.text, 'string');
  } finally {
    await app.close();
  }
});

test('the shared SDK parses the chat stream through the same schema', async () => {
  const app = await startChatApp();
  try {
    const client = new CoderaxClient({ baseUrl: app.url, token: OWNER_TOKEN });
    const frames: ChatFrame[] = [];
    for await (const frame of client.chatStream({ message: 'Hello.', mode: 'cloud', agent: 'coderax' })) {
      frames.push(frame);
    }
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.type, 'chat.delta');
    const completed = frames[1];
    assert.equal(completed?.type, 'chat.completed');
    assert.equal(completed?.type === 'chat.completed' && completed.reply.text, 'Streamed answer.');
  } finally {
    await app.close();
  }
});
