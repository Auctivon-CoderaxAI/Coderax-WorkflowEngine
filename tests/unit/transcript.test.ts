import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredMessage } from '../../src/domain.js';
import { buildTranscript } from '../../src/orchestration/transcript.js';

function message(
  overrides: Partial<StoredMessage> & Pick<StoredMessage, 'role' | 'text'>,
): StoredMessage {
  return {
    messageId: `message-${Math.random().toString(16).slice(2)}`,
    conversationId: 'conv_test',
    createdAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

test('the current objective is excluded and the earlier exchange is kept', () => {
  const messages = [
    message({ role: 'user', text: 'Summarize the repository' }),
    message({ role: 'assistant', text: 'It is a workflow engine.' }),
    message({ role: 'user', text: 'Now list its packages' }),
  ];
  assert.deepEqual(buildTranscript({ messages, currentText: 'Now list its packages' }), [
    { role: 'user', text: 'Summarize the repository' },
    { role: 'assistant', text: 'It is a workflow engine.' },
  ]);
});

test('only the trailing current turn is removed, not an earlier identical one', () => {
  const messages = [
    message({ role: 'user', text: 'Status?' }),
    message({ role: 'assistant', text: 'Still running.' }),
    message({ role: 'user', text: 'Status?' }),
  ];
  assert.deepEqual(buildTranscript({ messages, currentText: 'Status?' }), [
    { role: 'user', text: 'Status?' },
    { role: 'assistant', text: 'Still running.' },
  ]);
});

test('tool rows, empty text and unfinished answers are not turns', () => {
  const messages = [
    message({ role: 'user', text: '  ' }),
    message({ role: 'tool', text: 'read_file: ok' }),
    message({ role: 'user', text: 'Do the work' }),
    message({ role: 'assistant', text: 'partial', unfinished: true }),
    message({ role: 'assistant', text: 'Done.' }),
  ];
  assert.deepEqual(buildTranscript({ messages, currentText: 'Follow-up' }), [
    { role: 'user', text: 'Do the work' },
    { role: 'assistant', text: 'Done.' },
  ]);
});

test('the newest turns survive the turn limit', () => {
  const messages = Array.from({ length: 6 }, (_, index) =>
    message({ role: index % 2 === 0 ? 'user' : 'assistant', text: `turn-${index}` }),
  );
  assert.deepEqual(buildTranscript({ messages, maxTurns: 2 }), [
    { role: 'user', text: 'turn-4' },
    { role: 'assistant', text: 'turn-5' },
  ]);
});

test('an oversized newest turn is clipped instead of dropped', () => {
  const messages = [
    message({ role: 'user', text: 'old' }),
    message({ role: 'assistant', text: 'x'.repeat(100) }),
  ];
  const transcript = buildTranscript({ messages, maxChars: 20 });
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.role, 'assistant');
  assert.equal(transcript[0]?.text.length, 20);
  assert.ok(transcript[0]?.text.endsWith('…'));
});

test('a conversation with nothing but the current turn yields no history', () => {
  const messages = [message({ role: 'user', text: 'First objective' })];
  assert.deepEqual(buildTranscript({ messages, currentText: 'First objective' }), []);
});

test('history is scrubbed before clipping, after comparing the original objective', () => {
  const messages = [
    message({ role: 'assistant', text: 'sk-' + 'a'.repeat(32) }),
    message({ role: 'user', text: 'password=sample' }),
  ];
  assert.deepEqual(
    buildTranscript({ messages, currentText: 'password=sample', maxChars: 8 }),
    [{ role: 'assistant', text: '[redact…' }],
  );
});
