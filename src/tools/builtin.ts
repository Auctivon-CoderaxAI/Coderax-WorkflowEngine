import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DataMode, KnowledgeSearchResult, MemoryList } from '@coderax/contracts';
import type { Tool, ToolResult } from './types.js';
import { bounded, failure, success } from './types.js';
import { confinePath, isInside } from './paths.js';
import { validateCommand } from '../security/shell.js';
import { authorizeUrl, pinnedRequest } from '../security/network.js';

/**
 * Built-in tools are the capabilities Coderax Native owns directly. File access
 * is confined to the run's workspace and resolved through symlinks, shell and
 * network are disabled by default and always ask the owner, and every output is
 * bounded before it is allocated. Nothing here can reach a private workspace from
 * a cloud run: the context's root is already the mode root.
 */

export type ToolMemory = {
  list: (input: { ownerId: string; mode: DataMode }) => Promise<MemoryList>;
  put: (input: {
    ownerId: string;
    tenantId: string | null;
    mode: DataMode;
    key: string;
    value: string;
  }) => Promise<void>;
};

export type ToolKnowledge = {
  search: (input: {
    ownerId: string;
    mode: DataMode;
    query: string;
    k: number;
  }) => Promise<KnowledgeSearchResult>;
};

export type BuiltinToolOptions = {
  shellEnabled: boolean;
  allowedCommands: string[];
  networkEnabled: boolean;
  allowedHosts: string[];
  /** Loopback plaintext is for local development only; it is off by default. */
  allowInsecureLoopback?: boolean;
  maxOutputBytes: number;
  commandTimeoutMs: number;
  maxSearchFiles: number;
  memory: ToolMemory | null;
  knowledge: ToolKnowledge | null;
};

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.next']);

function output(result: string, limit: number): ToolResult {
  return success(bounded(result, limit));
}

async function directoryEntries(root: string, relative: string, depth: number): Promise<string[]> {
  const lines: string[] = [];
  async function walk(current: string, remaining: number): Promise<void> {
    if (remaining < 0 || lines.length > 400) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      // A symlink is shown as a link but never followed by a listing or a read.
      lines.push(
        `${entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir ' : 'file'} ${rel}`,
      );
      if (entry.isDirectory() && !entry.isSymbolicLink() && remaining > 0) await walk(full, remaining - 1);
      if (lines.length > 400) return;
    }
  }
  await walk(path.join(root, relative), depth);
  return lines.length > 0 ? lines : ['(empty)'];
}

/** Reads at most `bytes` from a file without allocating the whole file. */
async function readBounded(file: string, bytes: number): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(Math.max(1, bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createBuiltinTools(options: BuiltinToolOptions): Tool[] {
  const limit = options.maxOutputBytes;
  const tools: Tool[] = [
    {
      name: 'fs.read',
      description: 'Read a UTF-8 file inside the workspace.',
      source: 'builtin',
      scopes: ['workspace.read'],
      approval: 'never',
      parameters: { path: 'string', maxBytes: 'number?' },
      schema: z
        .object({ path: z.string().min(1).max(1024), maxBytes: z.number().int().min(1).max(200_000).optional() })
        .strict(),
      resource: (input) => (input as { path: string }).path,
      run: async (input, context) => {
        const { path: requested, maxBytes } = input as { path: string; maxBytes?: number };
        const confined = await confinePath(context.workspaceRoot, requested);
        if (!confined.ok) return failure('permission_required', confined.detail);
        const info = await stat(confined.path).catch(() => null);
        if (!info || !info.isFile()) return failure('not_found', 'That file does not exist.');
        const bytes = Math.min(maxBytes ?? limit, 200_000);
        const text = await readBounded(confined.path, bytes);
        if (text === null) return failure('tool_failed', 'That file could not be read as UTF-8.');
        return output(text, bytes);
      },
    },
    {
      name: 'fs.list',
      description: 'List workspace entries, optionally one directory and depth.',
      source: 'builtin',
      scopes: ['workspace.read'],
      approval: 'never',
      parameters: { path: 'string?', depth: 'number?' },
      schema: z
        .object({ path: z.string().max(1024).optional(), depth: z.number().int().min(0).max(3).optional() })
        .strict(),
      resource: (input) => (input as { path?: string }).path ?? '.',
      run: async (input, context) => {
        const { path: requested, depth } = input as { path?: string; depth?: number };
        const confined = await confinePath(context.workspaceRoot, requested ?? '.');
        if (!confined.ok) return failure('permission_required', confined.detail);
        return output((await directoryEntries(context.workspaceRoot, confined.relative, depth ?? 1)).join('\n'), limit);
      },
    },
    {
      name: 'fs.search',
      description: 'Search workspace text files for a literal string, with line numbers.',
      source: 'builtin',
      scopes: ['workspace.read'],
      approval: 'never',
      parameters: { query: 'string' },
      schema: z.object({ query: z.string().min(1).max(200) }).strict(),
      resource: (input) => (input as { query: string }).query,
      run: async (input, context) => {
        const { query } = input as { query: string };
        const needle = query.toLowerCase();
        const matches: string[] = [];
        const rootReal = await realpath(context.workspaceRoot).catch(() => null);
        if (rootReal === null) return failure('tool_failed', 'The workspace is unavailable.');
        // A stable local binding keeps the narrowed type inside the closure.
        const root: string = rootReal;
        let scanned = 0;
        async function walk(directory: string): Promise<void> {
          if (matches.length >= 50 || scanned >= options.maxSearchFiles) return;
          const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (matches.length >= 50 || scanned >= options.maxSearchFiles) return;
            // A symlink is never followed: it is the classic escape from a cloud
            // workspace into a private one. Directories are walked only when they
            // are real directories.
            if (entry.isSymbolicLink()) continue;
            if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) continue;
            if (entry.isDirectory()) {
              if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path.join(directory, entry.name));
              continue;
            }
            const full = path.join(directory, entry.name);
            const resolved = await realpath(full).catch(() => null);
            if (resolved === null || !isInside(resolved, root)) continue;
            const info = await stat(resolved).catch(() => null);
            if (!info || !info.isFile() || info.size > 1_000_000) continue;
            scanned += 1;
            const text = await readBounded(resolved, Math.min(info.size, 1_000_000));
            if (!text) continue;
            const rel = path.relative(root, resolved).split(path.sep).join('/');
            text.split(/\r?\n/).forEach((line, index) => {
              if (matches.length < 50 && line.toLowerCase().includes(needle)) {
                matches.push(`${rel}:${index + 1}: ${bounded(line.trim(), 240)}`);
              }
            });
          }
        }
        await walk(root);
        return output(matches.length > 0 ? matches.join('\n') : `No matches for ${query}.`, limit);
      },
    },
    {
      name: 'fs.write',
      description: 'Create or replace a UTF-8 file inside the workspace.',
      source: 'builtin',
      scopes: ['workspace.write'],
      approval: 'once',
      parameters: { path: 'string', content: 'string' },
      schema: z
        .object({ path: z.string().min(1).max(1024), content: z.string().max(500_000) })
        .strict(),
      resource: (input) => (input as { path: string }).path,
      run: async (input, context) => {
        const { path: requested, content } = input as { path: string; content: string };
        const confined = await confinePath(context.workspaceRoot, requested);
        if (!confined.ok) return failure('permission_required', confined.detail);
        await mkdir(path.dirname(confined.path), { recursive: true });
        // O_NOFOLLOW closes the race where a symlink is swapped in after the
        // confinement check. It is unavailable on Windows, where the resolved
        // parent check above remains the guard.
        const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
        const written = await writeFile(confined.path, content, {
          encoding: 'utf8',
          mode: 0o600,
          flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
        }).catch(() => null);
        if (written === null) return failure('tool_failed', 'That file could not be written safely.');
        const digest = createHash('sha256').update(content).digest('hex');
        return output(`Wrote ${confined.relative} (${Buffer.byteLength(content)} bytes, sha256 ${digest}).`, 400);
      },
    },
  ];

  if (options.shellEnabled) {
    tools.push({
      name: 'shell.run',
      description: 'Run one allow-listed command inside the workspace with no shell.',
      source: 'builtin',
      scopes: ['command.execute'],
      approval: 'always',
      parameters: { command: 'string', args: 'string[]' },
      schema: z
        .object({
          command: z.string().min(1).max(120),
          args: z.array(z.string().max(500)).max(40).default([]),
          timeoutMs: z.number().int().min(100).max(60_000).optional(),
        })
        .strict(),
      resource: (input) => {
        const typed = input as { command: string; args: string[] };
        return bounded([typed.command, ...typed.args].join(' '), 512);
      },
      run: async (input, context) => {
        const typed = input as { command: string; args: string[]; timeoutMs?: number };
        const validated = await validateCommand({
          command: typed.command,
          args: typed.args,
          allowedCommands: options.allowedCommands,
        });
        if (!validated.ok) return failure('permission_required', validated.detail);

        const home = path.join(context.workspaceRoot, '.home');
        const tmp = path.join(context.workspaceRoot, '.tmp');
        await mkdir(home, { recursive: true }).catch(() => undefined);
        await mkdir(tmp, { recursive: true }).catch(() => undefined);
        const timeoutMs = typed.timeoutMs ?? options.commandTimeoutMs;

        return new Promise<ToolResult>((resolve) => {
          let settled = false;
          let collected = '';
          const detached = process.platform !== 'win32';
          const child = spawn(validated.executable, validated.args, {
            cwd: context.workspaceRoot,
            shell: false,
            windowsHide: true,
            // HOME and TMPDIR point inside the workspace so an allow-listed tool
            // cannot quietly write into the engine account's home directory.
            env: {
              PATH: process.env.PATH ?? '',
              HOME: home,
              TMPDIR: tmp,
              LANG: 'C.UTF-8',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached,
          });
          let timer: NodeJS.Timeout | null = null;
          const finish = (result: ToolResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            context.signal.removeEventListener('abort', onAbort);
            resolve(result);
          };
          const killTree = (): void => {
            if (child.pid === undefined) return;
            try {
              if (detached) process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          };
          const onAbort = (): void => {
            killTree();
            finish(failure('cancelled', 'The run was cancelled.'));
          };
          timer = setTimeout(() => {
            killTree();
            finish(failure('tool_failed', `The command exceeded ${timeoutMs} ms.`));
          }, timeoutMs);
          timer.unref();
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener('abort', onAbort, { once: true });
          const collect = (chunk: Buffer): void => {
            if (Buffer.byteLength(collected) >= limit) return;
            collected += chunk.toString('utf8');
            if (Buffer.byteLength(collected) > limit) {
              collected = bounded(collected, limit);
            }
          };
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          child.on('error', () => finish(failure('tool_failed', 'The command could not start.')));
          child.on('close', (code) => {
            finish(
              success(
                bounded(
                  `exit=${code ?? 'unknown'}\n${collected.trim().length > 0 ? collected.trim() : '(no output)'}`,
                  limit,
                ),
              ),
            );
          });
        });
      },
    });
  }

  if (options.networkEnabled) {
    tools.push({
      name: 'http.fetch',
      description: 'Fetch an allow-listed HTTPS URL. The owner approves each destination.',
      source: 'builtin',
      scopes: ['network.access'],
      approval: 'once',
      parameters: { url: 'string', method: 'GET|POST' },
      schema: z
        .object({
          url: z.string().url().max(2000),
          method: z.enum(['GET', 'POST']).default('GET'),
          body: z.string().max(20_000).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          // Destination policy is checked before the owner is asked to approve:
          // an unapprovable URL must never become a durable permission request.
          let target: URL;
          try {
            target = new URL(value.url);
          } catch {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'The URL is invalid.' });
            return;
          }
          const loopback = target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';
          if (target.protocol !== 'https:' && !(options.allowInsecureLoopback && target.protocol === 'http:' && loopback)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Only HTTPS destinations are allowed.' });
          }
          if (target.username.length > 0 || target.password.length > 0) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'The URL may not carry credentials.' });
          }
          if (options.allowedHosts.length > 0 && !options.allowedHosts.includes(target.hostname)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'The host is not allow-listed.' });
          }
        }),
      resource: (input) => (input as { url: string }).url,
      run: async (input, context) => {
        if (context.signal.aborted) return failure('cancelled', 'The run was cancelled.');
        const typed = input as { url: string; method: 'GET' | 'POST'; body?: string };
        const policy = {
          allowedHosts: options.allowedHosts,
          ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
          maxBytes: limit,
          timeoutMs: 15_000,
        };
        let current = typed.url;
        let method: string = typed.method;
        let body: string | undefined = typed.body;

        for (let hop = 0; hop <= 2; hop += 1) {
          const authorized = await authorizeUrl(current, policy);
          if (!authorized.ok) {
            return failure('permission_required', authorized.detail);
          }
          let response;
          try {
            response = await pinnedRequest(
              {
                target: authorized.target,
                method,
                headers: {
                  accept: 'text/plain, application/json;q=0.9',
                  ...(body !== undefined ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
                },
                ...(body !== undefined ? { body } : {}),
              },
              policy,
            );
          } catch {
            return failure('tool_failed', 'The request failed.');
          }
          const location = response.headers.location;
          if (
            response.status >= 300 &&
            response.status < 400 &&
            typeof location === 'string' &&
            hop < 2
          ) {
            // Each redirect is authorized and pinned again; an unapproved hop is
            // refused rather than followed by the TLS client.
            current = new URL(location, current).toString();
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
              method = 'GET';
              body = undefined;
            }
            continue;
          }
          return output(
            `HTTP ${response.status}${response.truncated ? ' (truncated)' : ''}\n${response.text}`,
            limit,
          );
        }
        return failure('tool_failed', 'The request exceeded the redirect bound.');
      },
    });
  }

  if (options.memory) {
    const memory = options.memory;
    tools.push(
      {
        name: 'memory.search',
        description: 'Search the owner’s durable memory for this data mode.',
        source: 'builtin',
        scopes: ['memory.read'],
        approval: 'never',
        parameters: { query: 'string?', limit: 'number?' },
        schema: z
          .object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() })
          .strict(),
        resource: () => 'owner memory',
        run: async (input, context) => {
          const typed = input as { query?: string; limit?: number };
          const list = await memory.list({ ownerId: context.ownerId, mode: context.mode });
          const needle = (typed.query ?? '').toLowerCase();
          const entries = list.entries
            .filter((entry) => needle.length === 0 || entry.key.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle))
            .slice(0, typed.limit ?? 10)
            .map((entry) => `${entry.key}: ${bounded(entry.value, 600)}`);
          return output(entries.length > 0 ? entries.join('\n') : 'No matching memory entries.', limit);
        },
      },
      {
        name: 'memory.write',
        description: 'Store one durable memory entry for this owner and data mode.',
        source: 'builtin',
        scopes: ['memory.write'],
        approval: 'once',
        parameters: { key: 'string', value: 'string' },
        schema: z.object({ key: z.string().min(1).max(200), value: z.string().max(20_000) }).strict(),
        resource: (input) => `memory:${(input as { key: string }).key}`,
        run: async (input, context) => {
          const typed = input as { key: string; value: string };
          await memory.put({
            ownerId: context.ownerId,
            tenantId: null,
            mode: context.mode,
            key: typed.key,
            value: typed.value,
          });
          return output(`Stored memory ${typed.key}.`, 200);
        },
      },
    );
  }

  if (options.knowledge) {
    const knowledge = options.knowledge;
    tools.push({
      name: 'knowledge.search',
      description: 'Retrieve relevant passages from the owner’s stored documents.',
      source: 'builtin',
      scopes: ['knowledge.read'],
      approval: 'never',
      parameters: { query: 'string', k: 'number?' },
      schema: z
        .object({ query: z.string().min(1).max(2000), k: z.number().int().min(1).max(10).optional() })
        .strict(),
      resource: (input) => (input as { query: string }).query,
      run: async (input, context) => {
        const typed = input as { query: string; k?: number };
        const found = await knowledge.search({
          ownerId: context.ownerId,
          mode: context.mode,
          query: typed.query,
          k: typed.k ?? 4,
        });
        if (found.hits.length === 0) return output('No stored passage matched.', limit);
        return output(
          found.hits
            .map((hit) => `[${hit.title} · ${hit.score.toFixed(2)}]\n${bounded(hit.text, 1200)}`)
            .join('\n\n'),
          limit,
        );
      },
    });
  }

  return tools;
}
