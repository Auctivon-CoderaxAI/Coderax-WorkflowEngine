import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeHttpTransport } from '../../src/agents/adapters/opencode.js';
import { createOpenAiCompatibleGateway } from '../../src/agents/native/gateway.js';
import { connectMcpServer } from '../../src/mcp/client.js';

test('credential-bearing transports reject remote plaintext endpoints before use', async () => {
  const baseURL = 'http://localhost.example';
  assert.throws(() => createOpenCodeHttpTransport({ baseURL, password: 'fixture' }), /HTTPS/);
  assert.throws(() => createOpenAiCompatibleGateway({ baseURL, apiKey: 'fixture' }), /HTTPS/);
  await assert.rejects(connectMcpServer({ name: 'demo', transport: 'http', url: baseURL,
    headersEnv: { authorization: 'MCP_TEST_HEADER' } }), /HTTPS/);
});
