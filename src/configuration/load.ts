import { readFileSync } from 'node:fs';
import { validateRemoteEndpoint } from './endpoint.js';
import { EngineConfigSchema, type EngineConfig } from './schema.js';

export class ConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export type LoadConfigInput = {
  env?: NodeJS.ProcessEnv;
  /** Optional JSON document; env wins over file values. */
  filePath?: string;
  overrides?: unknown;
};

function readFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigurationError([`configuration file ${filePath} could not be read`]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigurationError([
      `configuration file ${filePath} is not valid JSON: ${(error as Error).message}`,
    ]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * Environment overrides are limited to transport, secret names and the
 * persistence driver selection. Every one of them still lands on a validated
 * field below: an unknown driver is a configuration error, not a fallback.
 */
function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const host = env.CODERAX_ENGINE_HOST;
  const port = env.CODERAX_ENGINE_PORT;
  const ownerId = env.CODERAX_OWNER_ID;
  const tokenEnv = env.CODERAX_OWNER_TOKEN_ENV;
  const persistenceDriver = env.CODERAX_PERSISTENCE_DRIVER;
  if (host) out.server = { ...(out.server as object), host };
  if (port) out.server = { ...(out.server as object), port: Number(port) };
  if (ownerId || tokenEnv) {
    out.auth = {
      ...(ownerId ? { ownerId } : {}),
      ...(tokenEnv ? { tokenEnv } : {}),
    };
  }
  if (persistenceDriver) out.persistence = { driver: persistenceDriver };
  return out;
}

/**
 * Cross-field invariants that a per-field schema cannot express. Each message
 * names the field to fix; none of them is a warning that lets a broken
 * deployment start.
 */
export function validateInvariants(config: EngineConfig): string[] {
  const issues: string[] = [];
  const { engines, execution, models, workspaces } = config;

  if (execution.heartbeatIntervalMs * 3 > execution.leaseTtlMs) {
    issues.push(
      `execution.heartbeatIntervalMs (${execution.heartbeatIntervalMs}) must be at most one third of execution.leaseTtlMs (${execution.leaseTtlMs})`,
    );
  }
  if (workspaces.privateRoot === workspaces.cloudRoot) {
    issues.push('workspaces.privateRoot and workspaces.cloudRoot must be different directories');
  }
  if (engines.default === 'opencode' && !engines.opencode.enabled) {
    issues.push('engines.default is opencode but engines.opencode.enabled is false');
  }
  if (engines.default === 'freebuff' && !engines.freebuff.enabled) {
    issues.push('engines.default is freebuff but engines.freebuff.enabled is false');
  }
  if (engines.default === 'native' && !engines.native.enabled) {
    issues.push('engines.default is native but engines.native.enabled is false');
  }
  if (engines.opencode.enabled) {
    if (!engines.opencode.baseURL) issues.push('engines.opencode.baseURL is required when enabled');
    if (!engines.opencode.model) issues.push('engines.opencode.model is required when enabled');
    if (!engines.opencode.passwordEnv) {
      issues.push('engines.opencode.passwordEnv is required when enabled');
    }
    if (engines.opencode.baseURL) {
      const endpoint = validateRemoteEndpoint({
        url: engines.opencode.baseURL,
        name: 'engines.opencode.baseURL',
        carriesCredential: Boolean(engines.opencode.passwordEnv),
      });
      if (!endpoint.ok) issues.push(endpoint.detail);
    }
  }
  if (engines.freebuff.enabled) {
    if (!engines.freebuff.baseURL) issues.push('engines.freebuff.baseURL is required when enabled');
    if (!engines.freebuff.sdkPath) issues.push('engines.freebuff.sdkPath is required when enabled');
    if (!engines.freebuff.model) issues.push('engines.freebuff.model is required when enabled');
    if (engines.freebuff.baseURL) {
      const endpoint = validateRemoteEndpoint({
        url: engines.freebuff.baseURL,
        name: 'engines.freebuff.baseURL',
        carriesCredential: false,
      });
      if (!endpoint.ok) issues.push(endpoint.detail);
    }
  }

  const seen = new Set<string>();
  for (const ref of models.route) {
    const key = `${ref.providerId}/${ref.modelId}`;
    if (seen.has(key)) issues.push(`models.route lists ${key} more than once`);
    seen.add(key);
  }
  if (models.allowPaid !== false) {
    issues.push('models.allowPaid must remain false: Coderax does not use paid models');
  }
  return issues;
}

export function loadConfig(input: LoadConfigInput = {}): EngineConfig {
  const env = input.env ?? process.env;
  const file = input.filePath ? readFile(input.filePath) : {};
  if (!isRecord(file)) {
    throw new ConfigurationError([`configuration file must contain a JSON object`]);
  }
  const merged = deepMerge(file, fromEnv(env));
  const withOverrides =
    input.overrides && isRecord(input.overrides) ? deepMerge(merged, input.overrides) : merged;

  const parsed = EngineConfigSchema.safeParse(withOverrides);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      }),
    );
  }

  const invariants = validateInvariants(parsed.data);
  if (invariants.length > 0) {
    throw new ConfigurationError(invariants);
  }
  return parsed.data;
}
