import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from '../mcp/client.js';

/**
 * Plugin manifests are data, not code.
 *
 * A plugin is a directory containing `plugin.json` plus optional assets. The
 * manifest may declare MCP servers (which the existing MCP client already
 * confines and approves); it cannot declare arbitrary process execution or a
 * new tool implementation, because loading untrusted code into the engine would
 * bypass every boundary this repository maintains. A manifest that asks for more
 * is rejected whole rather than partially honoured.
 */

const ManifestServer = z.discriminatedUnion('transport', [
  z
    .object({
      name: z.string().min(1).max(60),
      transport: z.literal('http'),
      url: z.string().url(),
      headersEnv: z.record(z.string(), z.string().min(1).max(200)).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(60),
      transport: z.literal('stdio'),
      command: z.string().min(1).max(200),
      args: z.array(z.string().max(500)).max(40).default([]),
      envFrom: z.array(z.string().min(1).max(200)).max(40).default([]),
    })
    .strict(),
]);

const PLUGIN_ENV = /^CODERAX_MCP_[A-Z0-9_]{1,180}$/;

/**
 * A plugin may name only the variables reserved for MCP transports. Without
 * this bound, a manifest could ask the engine to forward an unrelated provider
 * key to a server it controls.
 */
function pluginServerEnvIsSafe(server: z.infer<typeof ManifestServer>): boolean {
  if (server.transport === 'http') {
    return Object.values(server.headersEnv ?? {}).every((name) => PLUGIN_ENV.test(name));
  }
  return server.envFrom.every((name) => PLUGIN_ENV.test(name));
}

export const PluginManifest = z
  .object({
    name: z.string().min(1).max(60),
    version: z.string().min(1).max(40),
    description: z.string().max(600).optional(),
    /** Only MCP servers are executable through a manifest. */
    mcp: z.array(ManifestServer).max(10).default([]),
  })
  .strict()
  .refine((manifest) => manifest.mcp.every(pluginServerEnvIsSafe), {
    message: 'A plugin MCP server may only read CODERAX_MCP_* environment variables.',
  });
export type PluginManifest = z.infer<typeof PluginManifest>;

export type LoadedPlugin = {
  name: string;
  version: string;
  description?: string;
  servers: McpServerConfig[];
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  failures: Array<{ name: string; detail: string }>;
  /** Every server contributed by a plugin, tagged so the tool list shows its source. */
  servers: Array<McpServerConfig & { source: 'plugin' }>;
};

const MAX_MANIFEST_BYTES = 256 * 1024;

export async function loadPlugins(directory: string | null): Promise<PluginLoadResult> {
  if (!directory) return { plugins: [], failures: [], servers: [] };
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { plugins: [], failures: [], servers: [] };
  }

  const plugins: LoadedPlugin[] = [];
  const failures: Array<{ name: string; detail: string }> = [];
  const servers: Array<McpServerConfig & { source: 'plugin' }> = [];
  const names = new Set<string>();

  for (const entry of entries) {
    const manifestPath = path.join(directory, entry, 'plugin.json');
    let text: string;
    try {
      const bytes = await readFile(manifestPath, 'utf8');
      if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES) {
        failures.push({ name: entry, detail: 'The plugin manifest is too large.' });
        continue;
      }
      text = bytes;
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failures.push({ name: entry, detail: 'The plugin manifest is not valid JSON.' });
      continue;
    }
    const manifest = PluginManifest.safeParse(parsed);
    if (!manifest.success) {
      failures.push({ name: entry, detail: 'The plugin manifest does not match the supported schema.' });
      continue;
    }
    if (names.has(manifest.data.name)) {
      failures.push({ name: entry, detail: 'A plugin with that name is already loaded.' });
      continue;
    }
    names.add(manifest.data.name);
    plugins.push({
      name: manifest.data.name,
      version: manifest.data.version,
      ...(manifest.data.description ? { description: manifest.data.description } : {}),
      servers: manifest.data.mcp,
    });
    for (const server of manifest.data.mcp) {
      servers.push({ ...server, source: 'plugin' });
    }
  }

  return { plugins, failures, servers };
}
