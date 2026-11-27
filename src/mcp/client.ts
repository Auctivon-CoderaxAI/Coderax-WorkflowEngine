import { credentialEndpoint } from '../security/endpoint.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { scopedChildEnvironment } from '../security/environment.js';
import { z } from 'zod';
import type { Tool } from '../tools/types.js';
import { bounded, failure, success } from '../tools/types.js';

/**
 * A minimal MCP client. Only explicitly configured servers are contacted; a tool
 * is exposed under `mcp__<server>__<tool>` so one server can never shadow a
 * built-in. HTTP tools require `network.access`, stdio tools require
 * `command.execute`, and a browser/computer-use server additionally requires
 * `browser.use` with per-invocation approval. Server text is bounded and never
 * trusted as instructions.
 */

export type McpServerConfig =
  | {
      name: string;
      transport: 'http';
      url: string;
      /** Header name -> environment variable name; the value is never in config. */
      headersEnv?: Record<string, string>;
    }
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      /** Environment variable name -> value from the parent environment. */
      envFrom?: string[];
    };

export type McpConnection = {
  name: string;
  transport: 'http' | 'stdio';
  listTools: () => Promise<Array<{ name: string; description: string }>>;
  callTool: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
  close: () => Promise<void>;
};

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 20_000;

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
}

function isBrowserServer(name: string): boolean {
  return /browser|playwright|computer|puppeteer/i.test(name);
}

function textFromResult(result: unknown): { ok: boolean; text: string } {
  if (typeof result !== 'object' || result === null) return { ok: true, text: '' };
  const typed = result as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(typed.content)
    ? typed.content
        .map((part) => {
          if (typeof part === 'object' && part !== null) {
            const value = (part as { text?: unknown }).text;
            if (typeof value === 'string') return value;
          }
          return '';
        })
        .filter((part) => part.length > 0)
    : [];
  return { ok: typed.isError !== true, text: bounded(parts.join('\n'), 20_000) };
}

function createRpc(input: {
  send: (message: unknown) => void;
  closeTransport: () => Promise<void>;
}) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  function settle(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      // An MCP error message can echo a request body or a credential; keep the
      // boundary to a stable, user-safe detail.
      entry.reject(new Error('The MCP server returned an error.'));
    } else {
      entry.resolve(message.result);
    }
  }

  return {
    request: (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The MCP server did not answer in time.'));
        }, REQUEST_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          input.send({ jsonrpc: '2.0', id, method, params });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('The MCP server is not reachable.'));
        }
      }),
    notify: (method: string, params: unknown): void => {
      input.send({ jsonrpc: '2.0', method, params });
    },
    receive: settle,
    rejectAll: (detail: string): void => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(detail));
      }
      pending.clear();
    },
    close: input.closeTransport,
  };
}

async function connectHttp(config: Extract<McpServerConfig, { transport: 'http' }>) {
  const url = Object.keys(config.headersEnv ?? {}).length > 0
    ? credentialEndpoint(config.url).href : config.url;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  for (const [header, envName] of Object.entries(config.headersEnv ?? {})) {
    const value = process.env[envName];
    if (value) headers[header] = value;
  }

  async function post(body: unknown): Promise<JsonRpcResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) throw new Error('The MCP server rejected the request.');
      const type = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (type.includes('text/event-stream')) {
        const lines = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .filter((line) => line.length > 0);
        const last = lines[lines.length - 1];
        return last ? (JSON.parse(last) as JsonRpcResponse) : null;
      }
      return text.length > 0 ? (JSON.parse(text) as JsonRpcResponse) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method: string, params: unknown): Promise<unknown> {
    // HTTP transport is request/response, so the id is reserved here and the
    // matching frame is read directly instead of waiting on a stream.
    const body = { jsonrpc: '2.0', id: 1, method, params };
    const message = await post(body);
    if (!message) return null;
    if (message.error) throw new Error('The MCP server returned an error.');
    return message.result;
  }

  return {
    transport: 'http' as const,
    request,
    notify: async (method: string, params: unknown): Promise<void> => {
      await post({ jsonrpc: '2.0', method, params }).catch(() => null);
    },
    close: async () => undefined,
  };
}

function connectStdio(config: Extract<McpServerConfig, { transport: 'stdio' }>) {
  // Explicit allow-list only; a server never inherits the engine's credentials.
  const env = scopedChildEnvironment({ allow: config.envFrom ?? [] });
  const child: ChildProcessWithoutNullStreams = spawn(config.command, config.args ?? [], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const rpc = createRpc({
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    closeTransport: async () => {
      child.kill('SIGKILL');
    },
  });

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          rpc.receive(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // A malformed frame is ignored; a pending request still times out.
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > 2_000_000) buffer = '';
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Drain stderr so a chatty server cannot block on a full pipe. Its text is
    // never logged: it can contain a token or an owner path.
    void chunk;
  });
  child.on('error', () => rpc.rejectAll('The MCP server could not start.'));
  child.on('close', () => rpc.rejectAll('The MCP server exited.'));

  return {
    transport: 'stdio' as const,
    request: (method: string, params: unknown) => rpc.request(method, params),
    notify: async (method: string, params: unknown) => {
      rpc.notify(method, params);
    },
    close: async () => {
      rpc.rejectAll('The MCP connection was closed.');
      await rpc.close();
    },
  };
}

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const channel = config.transport === 'http' ? await connectHttp(config) : connectStdio(config);
  const name = sanitizeName(config.name);

  let tools: unknown;
  try {
    await channel.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'coderax-workflow-engine', version: '0.1.0' },
    });
    await channel.notify('notifications/initialized', {});
    tools = await channel.request('tools/list', {});
  } catch (error) {
    // A server that started but failed the handshake is still a live child
    // process. Close it before rethrowing, or shutdown never learns about it
    // and the process outlives every execution that could have owned it.
    await channel.close().catch(() => undefined);
    throw error;
  }
  const listed =
    typeof tools === 'object' && tools !== null && Array.isArray((tools as { tools?: unknown }).tools)
      ? (tools as { tools: Array<{ name?: unknown; description?: unknown }> }).tools
      : [];

  return {
    name,
    transport: config.transport,
    listTools: async () =>
      listed
        .filter((tool): tool is { name: string; description?: unknown } => typeof tool.name === 'string')
        .map((tool) => ({
          name: tool.name,
          description: bounded(
            typeof tool.description === 'string' ? tool.description : 'MCP tool',
            600,
          ),
        })),
    callTool: async (toolName, args) => {
      const result = await channel.request('tools/call', { name: toolName, arguments: args ?? {} });
      return textFromResult(result);
    },
    close: channel.close,
  };
}

/** Exposes one MCP server's tools to the runtime under a namespaced name. */
function createMcpTools(input: {
  connection: McpConnection;
  /** Bounded so a hostile server cannot flood the prompt. */
  maxTools?: number;
}): Promise<Tool[]> {
  return input.connection.listTools().then((listed) =>
    listed.slice(0, input.maxTools ?? 40).map((listedTool) => {
      const browser = isBrowserServer(input.connection.name) || isBrowserServer(listedTool.name);
      const name = `mcp__${sanitizeName(input.connection.name)}__${sanitizeName(listedTool.name)}`;
      return {
        name,
        description: bounded(listedTool.description, 600),
        source: 'mcp' as const,
        scopes: browser
          ? ['browser.use']
          : input.connection.transport === 'stdio'
            ? ['command.execute']
            : ['network.access'],
        approval: browser ? 'always' : 'once',
        spawnsProcesses: input.connection.transport === 'stdio',
        parameters: { input: 'object' },
        schema: z.record(z.string(), z.unknown()),
        resource: () => `mcp:${input.connection.name}/${listedTool.name}`,
        run: async (args) => {
          const result = await input.connection.callTool(listedTool.name, args);
          if (!result.ok) return failure('tool_failed', bounded(result.text || 'The MCP tool failed.', 1000));
          return success(result.text);
        },
      } satisfies Tool;
    }),
  );
}

export type McpAttachment = {
  tools: Tool[];
  names: string[];
  failures: Array<{ name: string; detail: string }>;
  close: () => Promise<void>;
};

/**
 * Connects every configured server. One unavailable server is reported and does
 * not stop the engine: it simply contributes no tools.
 */
export async function attachMcpServers(configs: McpServerConfig[]): Promise<McpAttachment> {
  const connections: McpConnection[] = [];
  const failures: Array<{ name: string; detail: string }> = [];
  const tools: Tool[] = [];

  for (const config of configs) {
    try {
      const connection = await connectMcpServer(config);
      connections.push(connection);
      tools.push(...(await createMcpTools({ connection })));
    } catch {
      failures.push({ name: sanitizeName(config.name), detail: 'The MCP server could not be attached.' });
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
