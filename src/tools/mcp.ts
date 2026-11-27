import { connectMcpServer, createMcpTools } from '../mcp/client.js';
import type { McpAttachment, McpConnection, McpServerConfig } from '../mcp/client.js';
import type { Tool } from './types.js';

/**
 * Attaches the configured MCP servers and turns each connection into tools.
 *
 * This is the composition seam: `createMcpTools` is intentionally not a second
 * factory for the tool runtime. It projects one server's listing into the same
 * `Tool` shape every built-in and plugin tool uses, so one authorization path
 * covers all of them.
 */
export async function attachMcpServers(configs: McpServerConfig[]): Promise<McpAttachment> {
  const connections: McpConnection[] = [];
  const failures: Array<{ name: string; detail: string }> = [];
  const tools: Tool[] = [];

  for (const config of configs) {
    try {
      const connection = await connectMcpServer(config);
      connections.push(connection);
      tools.push(
        ...(await createMcpTools({
          connection,
          ...(config.source ? { source: config.source } : {}),
        })),
      );
    } catch {
      failures.push({
        name: sanitizeName(config.name),
        detail: 'The MCP server could not be attached.',
      });
    }
  }

  return {
    tools,
    names: connections.map((connection) => connection.name),
    failures,
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
    },
  };
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}
