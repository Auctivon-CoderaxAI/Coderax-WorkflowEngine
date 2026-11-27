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
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export function validateInvariants(config: EngineConfig): string[] {
  const issues: string[] = [];
  const { engines, execution, models, schedules, workspaces, browsers, tools } = config;

  if (config.artifacts.defaultRetentionDays > config.artifacts.maxRetentionDays) {
    issues.push("artifacts.defaultRetentionDays must not exceed artifacts.maxRetentionDays");
  }
  if (execution.heartbeatIntervalMs * 3 > execution.leaseTtlMs) {
    issues.push(
      `execution.heartbeatIntervalMs (${execution.heartbeatIntervalMs}) must be at most one third of execution.leaseTtlMs (${execution.leaseTtlMs})`,
    );
  }
  if (schedules.missedGraceMs < schedules.tickMs) {
    issues.push(
      `schedules.missedGraceMs (${schedules.missedGraceMs}) must be at least schedules.tickMs (${schedules.tickMs}); otherwise a healthy occurrence can be classified missed`,
    );
  }
  if (schedules.dispatchTimeoutMs < schedules.tickMs * 2) {
    issues.push(
      `schedules.dispatchTimeoutMs (${schedules.dispatchTimeoutMs}) must be at least twice schedules.tickMs (${schedules.tickMs}); otherwise recovery can preempt a live dispatch`,
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

  if (browsers.enabled && browsers.provider === 'http') {
    if (!browsers.remote.baseURL) {
      issues.push('browsers.remote.baseURL is required when browsers.provider is http');
    } else {
      const url = new URL(browsers.remote.baseURL);
      if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
        issues.push(
          'browsers.remote.baseURL must use https unless it names a loopback host',
        );
      }
      if (url.username || url.password || url.search || url.hash) {
        issues.push(
          'browsers.remote.baseURL must not contain credentials, a query or a fragment',
        );
      }
    }
    if (!browsers.remote.zeroCostAttested) {
      issues.push(
        'browsers.remote.zeroCostAttested must be true before a browser provider can be enabled',
      );
    }
    if (!browsers.remote.tokenEnv) {
      issues.push('browsers.remote.tokenEnv is required when browsers.provider is http');
    }
  }
  if (browsers.allowPaid !== false) {
    issues.push('browsers.allowPaid must remain false: Coderax does not use paid browser infrastructure');
  }

  for (const command of tools.allowedCommands) {
    if (/[\\/]/.test(command)) {
      issues.push(
        `tools.allowedCommands entry "${command}" must be a bare executable name, not a path`,
      );
    }
  }
  for (const host of tools.allowedHosts) {
    if (/[:/\\\s]/.test(host) || host.includes('@')) {
      issues.push(
        `tools.allowedHosts entry "${host}" must be a hostname or .suffix, not a URL`,
      );
    }
  }
  if (tools.shellEnabled && tools.allowedCommands.length === 0) {
    issues.push('tools.shellEnabled requires at least one tools.allowedCommands entry');
  }
  if (tools.networkEnabled && tools.allowedHosts.length === 0) {
    issues.push('tools.networkEnabled requires at least one tools.allowedHosts entry');
  }
  if (new Set(tools.mcp.map((server) => server.name)).size !== tools.mcp.length) {
    issues.push('tools.mcp lists a server name more than once');
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

  const providerIds = new Set<string>();
  for (const provider of models.providers) {
    if (providerIds.has(provider.id)) {
      issues.push(`models.providers lists ${provider.id} more than once`);
    }
    providerIds.add(provider.id);
  }
  for (const attestation of models.attestations) {
    const verifiedAt = Date.parse(attestation.verifiedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    const label = `${attestation.providerId}/${attestation.modelId}`;
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
      issues.push(`models.attestations for ${label} must expire after they were verified`);
      continue;
    }
    // Provider terms go stale. A record that claims a longer validity than the
    // verifier's maximum window would be refused at routing time anyway, so it
    // is a configuration error rather than a silent downgrade.
    if (expiresAt - verifiedAt > 90 * 24 * 60 * 60 * 1_000) {
      issues.push(
        `models.attestations for ${label} must not claim more than 90 days of validity`,
      );
    }
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
