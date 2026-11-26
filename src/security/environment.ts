/**
 * The environment a child process is allowed to inherit.
 *
 * The engine reads its own credentials by variable name and keeps them in its own
 * process. A shell or an MCP server is a different trust domain, so it receives a
 * fixed baseline plus an explicit allow-list — never `process.env`. That makes
 * "credentials: none" an enforced property rather than a description: a command
 * that runs `env` cannot see an inference key, a database URI or an owner token.
 *
 * Only non-secret variables are in the baseline; nothing here names a credential.
 */

const BASELINE = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
] as const;

export type ChildEnvironmentInput = {
  /** Additional variable names, supplied by explicit configuration. */
  allow?: readonly string[];
  parent?: NodeJS.ProcessEnv;
};

export function scopedChildEnvironment(input: ChildEnvironmentInput = {}): NodeJS.ProcessEnv {
  const parent = input.parent ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASELINE) {
    const value = parent[name];
    if (value !== undefined && value.length > 0) env[name] = value;
  }
  for (const name of input.allow ?? []) {
    const value = parent[name];
    if (value !== undefined && value.length > 0) env[name] = value;
  }
  // A child never inherits an implicit node option that could load code into it.
  delete env.NODE_OPTIONS;
  return env;
}
