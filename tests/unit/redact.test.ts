import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText, redactToolInput } from '../../src/observability/redact.js';

test('redaction removes bearer tokens, keys and JWTs', () => {
  const text =
    'upstream said: Authorization: Bearer abcdefghijklmnop1234 and key sk-live-abcdef1234567890 ' +
    'with jwt eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4';
  const output = redactText(text);
  assert.equal(output.includes('abcdefghijklmnop1234'), false);
  assert.equal(output.includes('sk-live-abcdef1234567890'), false);
  assert.equal(output.includes('eyJhbGciOiJI'), false);
  assert.match(output, /Bearer \[redacted\]/);
});

test('redaction removes query-string credentials and key=value pairs', () => {
  const output = redactText('GET /v1/models?api_key=supersecretvalue&x=1 password=hunter2hunter2');
  assert.equal(output.includes('supersecretvalue'), false);
  assert.equal(output.includes('hunter2hunter2'), false);
});

test('redaction removes absolute home paths but keeps the rest of the path', () => {
  const output = redactText('failed to read /home/nader/private/notes.md');
  assert.equal(output.includes('nader'), false);
  assert.match(output, /\[home\]\/private\/notes\.md/);
});

test('a configured secret is removed even when it matches no pattern', () => {
  const secret = 'plainvalue-that-is-long';
  const output = redactText(`provider rejected ${secret} for this model`, [secret]);
  assert.equal(output.includes(secret), false);
});

test('redaction is bounded and leaves ordinary text untouched', () => {
  const ordinary = 'The run failed because the workspace was unavailable.';
  assert.equal(redactText(ordinary), ordinary);
  assert.ok(redactText('x'.repeat(50_000)).length <= 4_000);
});

test('quoted JSON credentials are scrubbed, including escaped value quotes', () => {
  const diagnostic = JSON.stringify({ api_key: 'sample"private value' });
  assert.equal(redactText(diagnostic), '{"api_key":[redacted]}');
});

test('credential suffixes are scrubbed in text and nested tool inputs', () => {
  for (const key of ['access_token', 'client_secret', 'refresh_token', 'id_token', 'OPENAI_API_KEY']) {
    assert.equal(redactText(key + '=plainvalue1'), key + '=[redacted]');
    assert.equal(redactText(key + ': "plain value"'), key + ': [redacted]');
    assert.deepEqual(redactToolInput([{ [key]: 'plainvalue1', max_tokens: 4000 }]),
      [{ [key]: '[redacted]', max_tokens: 4000 }]);
  }
  assert.equal(redactText('max_tokens: 4000'), 'max_tokens: 4000');
});

test('authorization schemes hide their credentials as the header arrives', () => {
  for (const scheme of ['Basic', 'Digest', 'Token', 'Negotiate', 'Custom-Auth']) {
    const prefix = 'Authorization: ' + scheme + ' ';
    const value = scheme === 'Digest' ? 'username="sample", response="example"' : 'c2FtcGxl';
    assert.equal(redactText(prefix), 'Authorization: [redacted]');
    assert.equal(redactText(prefix + value), redactText(prefix));
  }
});
