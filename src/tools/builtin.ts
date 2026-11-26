import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DataMode, KnowledgeSearchResult, MemoryList } from '@coderax/contracts';
import type { Tool, ToolResult } from './types.js';
import { bounded, failure, success } from './types.js';
import { confinePath } from './paths.js';

/**
 * Built-in tools are the capabilities Coderax Native owns directly. File access
 * is confined to the run's workspace, shell and network are disabled by default
 * and always ask the owner, and every output is bounded. Nothing here can reach a
 * private workspace from a cloud run: the context's root is already the mode root.
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
      lines.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${rel}`);
      if (entry.isDirectory() && remaining > 0) await walk(full, remaining - 1);
      if (lines.length > 400) return;
    }
  }
  await walk(path.join(root, relative), depth);
  return lines.length > 0 ? lines : ['(empty)'];
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return false;
  }
  if (host.includes(':') || host.endsWith('.local')) return false;
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('.')) return host.endsWith(allowed);
    return host === allowed;
  });
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
      parameters: { path: 'string' },
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
        const bytes = maxBytes ?? limit;
        const text = await readFile(confined.path, 'utf8').catch(() => null);
        if (text === null) return failure('tool_failed', 'That file could not be read as UTF-8.');
        return output(text.slice(0, bytes), bytes);
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
        let scanned = 0;
        async function walk(directory: string): Promise<void> {
          if (matches.length >= 50 || scanned >= options.maxSearchFiles) return;
          const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (matches.length >= 50 || scanned >= options.maxSearchFiles) return;
            if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) continue;
            if (entry.isDirectory()) {
              if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path.join(directory, entry.name));
              continue;
            }
            const full = path.join(directory, entry.name);
            const info = await stat(full).catch(() => null);
            if (!info || info.size > 1_000_000) continue;
            scanned += 1;
            const text = await readFile(full, 'utf8').catch(() => null);
            if (!text) continue;
            const rel = path.relative(context.workspaceRoot, full).split(path.sep).join('/');
            text.split(/\r?\n/).forEach((line, index) => {
              if (matches.length < 50 && line.toLowerCase().includes(needle)) {
                matches.push(`${rel}:${index + 1}: ${bounded(line.trim(), 240)}`);
              }
            });
          }
        }
        await walk(context.workspaceRoot);
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
        await writeFile(confined.path, content, 'utf8');
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
        if (!options.allowedCommands.includes(typed.command)) {
          return failure(
            'permission_required',
            `That command is not allow-listed. Allowed: ${options.allowedCommands.join(', ') || 'none'}.`,
          );
        }
        const timeoutMs = typed.timeoutMs ?? options.commandTimeoutMs;
        return new Promise<ToolResult>((resolve) => {
          let settled = false;
          let collected = '';
          const child = spawn(typed.command, typed.args, {
            cwd: context.workspaceRoot,
            shell: false,
            windowsHide: true,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
              LANG: 'C.UTF-8',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let timer: NodeJS.Timeout | null = null;
          const finish = (result: ToolResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            context.signal.removeEventListener('abort', onAbort);
            resolve(result);
          };
          const kill = (): void => {
            child.kill('SIGKILL');
          };
          const onAbort = (): void => {
            kill();
            finish(failure('cancelled', 'The run was cancelled.'));
          };
          timer = setTimeout(() => {
            kill();
            finish(failure('tool_failed', `The command exceeded ${timeoutMs} ms.`));
          }, timeoutMs);
          timer.unref();
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener('abort', onAbort, { once: true });
          child.stdout.on('data', (chunk: Buffer) => {
            if (collected.length < limit) collected += chunk.toString('utf8');
          });
          child.stderr.on('data', (chunk: Buffer) => {
            if (collected.length < limit) collected += chunk.toString('utf8');
          });
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
      description: 'Fetch an allow-listed HTTPS URL. The owner approves each host.',
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
        .strict(),
      resource: (input) => (input as { url: string }).url,
      run: async (input, context) => {
        const typed = input as { url: string; method: 'GET' | 'POST'; body?: string };
        let parsed: URL;
        try {
          parsed = new URL(typed.url);
        } catch {
          return failure('validation_failed', 'That URL is not valid.');
        }
        if (!hostAllowed(parsed.hostname, options.allowedHosts)) {
          return failure(
            'permission_required',
            'That host is not allow-listed for this deployment.',
          );
        }
        const controller = new AbortController();
        const onAbort = (): void => controller.abort();
        context.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(parsed, {
            method: typed.method,
            ...(typed.body ? { body: typed.body } : {}),
            signal: controller.signal,
            redirect: 'manual',
            headers: { accept: 'text/plain, application/json;q=0.9' },
          });
          const text = await response.text();
          return output(`HTTP ${response.status}\n${bounded(text, limit)}`, limit);
        } catch {
          return failure('tool_failed', 'The request failed.');
        } finally {
          clearTimeout(timer);
          context.signal.removeEventListener('abort', onAbort);
        }
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
