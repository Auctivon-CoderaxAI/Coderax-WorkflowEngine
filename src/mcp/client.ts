import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z, type ZodTypeAny } from 'zod';
import type { ToolSource } from '@coderax/contracts';
import type { Tool } from '../tools/types.js';
import { authorizeUrl } from '../security/network.js';
import { bounded, failure, parametersToJsonSchema, success } from '../tools/types.js';

/**
 * A minimal MCP client. Only explicitly configured servers are contacted; a tool
 * is exposed under `mcp__<server>__<tool>` so one server can never shadow a
 * built-in. HTTP tools require `network.access`, stdio tools require
 * `command.execute`, and a browser/computer-use server additionally requires
 * `browser.use` with per-invocation approval. Server text is bounded and never
 * trusted as instructions.
 *
 * Discovery preserves each server's input schema; without it a model cannot know
 * the required fields, and the runtime would accept an argument object the server
 * rejects. Names are derived to fit the shared 120-character tool-name limit.
 */

export type McpServerConfig = {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  /** Header name -> environment variable name; the value is never in config. */
  headersEnv?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Environment variable name -> value from the parent environment. */
  envFrom?: string[];
  /** Where a plugin-declared server came from. */
  source?: ToolSource;
};

export type McpToolListing = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type McpConnection = {
  name: string;
  transport: 'http' | 'stdio';
  listTools: () => Promise<McpToolListing[]>;
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
const MAX_DISCOVERY_PAGES = 10;
const MAX_TOOL_NAME = 120;
const MAX_HTTP_RESPONSE_BYTES = 2_000_000;

/** Reads a response body through a hard byte ceiling before decoding it. */
async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error('The MCP server response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('The MCP server response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
}

/**
 * `mcp__<server>__<tool>` can exceed the contract limit when both parts are
 * long. Truncation plus a short digest keeps the name unique and inside the
 * limit, so the `/v1/tools` response still validates.
 */
function namespacedName(server: string, tool: string): string {
  const base = `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
  if (base.length <= MAX_TOOL_NAME) return base;
  const digest = createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_TOOL_NAME - digest.length - 1)}_${digest}`;
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

async function connectHttp(config: McpServerConfig) {
  if (!config.url) throw new Error('An MCP HTTP server needs a URL.');
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new Error('The MCP server URL is not valid.');
  }
  // A header credential may travel only over TLS, except to loopback. The same
  // policy that protects `http.fetch` also rejects a URL that resolves to a
  // private network or a cloud metadata service.
  const authorized = await authorizeUrl(config.url, {
    allowedHosts: [parsed.hostname],
    allowInsecureLoopback: true,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!authorized.ok) throw new Error('The MCP server URL is not a permitted destination.');
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
      const response = await fetch(config.url as string, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) throw new Error('The MCP server rejected the request.');
      const type = response.headers.get('content-type') ?? '';
      const text = await boundedResponseText(response);
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

function connectStdio(config: McpServerConfig) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const name of config.envFrom ?? []) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const child: ChildProcessWithoutNullStreams = spawn(config.command ?? '', config.args ?? [], {
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
  // One decoder for the whole stream: decoding each chunk independently corrupts
  // a multibyte character that spans a chunk boundary.
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
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

  try {
    await channel.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'coderax-workflow-engine', version: '0.1.0' },
    });
    await channel.notify('notifications/initialized', {});

    // Discovery follows the server's cursor page by page, bounded so a repeating
    // cursor cannot stall startup.
    const listed: McpToolListing[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const result: unknown = await channel.request('tools/list', cursor ? { cursor } : {});
      const body: { tools?: unknown; nextCursor?: unknown } =
        typeof result === 'object' && result !== null
          ? (result as { tools?: unknown; nextCursor?: unknown })
          : {};
      if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
          if (typeof tool !== 'object' || tool === null) continue;
          const typed = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
          if (typeof typed.name !== 'string') continue;
          listed.push({
            name: typed.name,
            description: bounded(
              typeof typed.description === 'string' ? typed.description : 'MCP tool',
              600,
            ),
            ...(typeof typed.inputSchema === 'object' && typed.inputSchema !== null
              ? { inputSchema: typed.inputSchema as Record<string, unknown> }
              : {}),
          });
        }
      }
      const next: unknown = body.nextCursor;
      if (typeof next !== 'string' || next.length === 0 || next === cursor) break;
      cursor = next;
    }

    return {
      name,
      transport: config.transport,
      listTools: async () => listed,
      callTool: async (toolName, args) => {
        const result = await channel.request('tools/call', { name: toolName, arguments: args ?? {} });
        return textFromResult(result);
      },
      close: channel.close,
    };
  } catch (error) {
    // The child or socket exists even though attachment failed. Closing it here
    // is what keeps a rejected server from surviving application shutdown.
    await channel.close().catch(() => undefined);
    throw error;
  }
}

/** A conservative validation schema derived from a server-provided inputSchema. */
export function schemaFromJsonSchema(input: Record<string, unknown> | undefined): ZodTypeAny {
  if (!input) return z.record(z.unknown());
  const properties =
    typeof input.properties === 'object' && input.properties !== null
      ? (input.properties as Record<string, unknown>)
      : null;
  if (!properties) return z.record(z.unknown());
  const required = Array.isArray(input.required)
    ? input.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const shape: Record<string, ZodTypeAny> = {};
  for (const name of required) shape[name] = z.unknown();
  // Unknown keys are passed through: the MCP server is the authority on its own
  // schema and validates again, while required fields are enforced here.
  return z.object(shape).passthrough();
}

/** Exposes one MCP server's tools to the runtime under a namespaced name. */
export function createMcpTools(input: {
  connection: McpConnection;
  /** Bounded so a hostile server cannot flood the prompt. */
  maxTools?: number;
  source?: ToolSource;
}): Promise<Tool[]> {
  return input.connection.listTools().then((listed) =>
    listed.slice(0, input.maxTools ?? 40).map((listedTool) => {
      const browser = isBrowserServer(input.connection.name) || isBrowserServer(listedTool.name);
      const name = namespacedName(input.connection.name, listedTool.name);
      return {
        name,
        description: bounded(listedTool.description, 600),
        source: input.source ?? 'mcp',
        scopes: browser
          ? ['browser.use']
          : input.connection.transport === 'stdio'
            ? ['command.execute']
            : ['network.access'],
        approval: browser ? 'always' : 'once',
        parameters: listedTool.inputSchema
          ? Object.fromEntries(
              Object.keys(
                (listedTool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
              ).map((key) => [key, 'unknown']),
            )
          : { input: 'object' },
        ...(listedTool.inputSchema ? { inputSchema: listedTool.inputSchema } : {}),
        schema: schemaFromJsonSchema(listedTool.inputSchema),
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
 * Connects every approved server. One unavailable server is reported and does
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
      tools.push(...(await createMcpTools({ connection, ...(config.source ? { source: config.source } : {}) })));
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

export { parametersToJsonSchema };
