import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeHttpTransport } from '../../src/agents/adapters/opencode.js';
import { createOpenAiCompatibleGateway } from '../../src/agents/native/gateway.js';

test('credential-bearing transports reject remote plaintext endpoints before use', () => {
  const baseURL = 'http://localhost.example';
  assert.throws(() => createOpenCodeHttpTransport({ baseURL, password: 'fixture' }), /https/i);
  assert.throws(() => createOpenAiCompatibleGateway({ baseURL, apiKey: 'fixture' }), /https/i);
});
