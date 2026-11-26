import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { connectMcpServer, createMcpTools } from '../../src/mcp/client.js';
import type { ToolContext } from '../../src/tools/types.js';

function context(): ToolContext {
  return {
    ownerId: 'owner-test',
    taskId: null,
    agent: 'coderax',
    mode: 'cloud',
    workspaceRoot: '',
    signal: new AbortController().signal,
    callId: 'call-1',
  };
}

test('an HTTP MCP server contributes namespaced tools that can be called', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      seen.push(message.method ?? '');
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'demo' } },
          }),
        );
        return;
      }
      if (message.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'echo', description: 'Echo the provided text' }] },
          }),
        );
        return;
      }
      if (message.method === 'tools/call') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: `echo:${String(message.params?.arguments?.text ?? '')}` }],
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const connection = await connectMcpServer({ name: 'demo', transport: 'http', url });
  try {
    const tools = await createMcpTools({ connection });
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.ok(tool);
    assert.equal(tool.name, 'mcp__demo__echo');
    assert.deepEqual(tool.scopes, ['network.access']);
    assert.equal(tool.approval, 'once');

    const result = await tool.run({ text: 'hello' }, context());
    assert.equal(result.ok && result.output, 'echo:hello');
    assert.deepEqual(seen, ['initialize', 'tools/list', 'tools/call']);
  } finally {
    await connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
