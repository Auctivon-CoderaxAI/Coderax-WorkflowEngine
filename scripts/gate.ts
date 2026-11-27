import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ARTIFACT_BODY_LIMIT_BYTES,
  CONTRACT_VERSION,
  MAX_ARTIFACT_BASE64_CHARS,
  ROUTES,
} from '@coderax/contracts';

/**
 * The permanent architectural gate.
 *
 * Every check here is a refusal, not a warning: the command exits non-zero and
 * prints what failed. A check that cannot read its input fails too — an
 * unreadable lockfile or source file is not evidence of compliance.
 *
 * Nothing in this file reaches the network. The dependency advisory check is the
 * one network-bound check and is opt-in (`--audit`), so it is enabled in CI where
 * a failure is actionable and stays out of a reproducible local build.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const failures: string[] = [];
const passes: string[] = [];

function fail(check: string, detail: string): void {
  failures.push(`${check}: ${detail}`);
}

function pass(check: string, detail: string): void {
  passes.push(`${check}: ${detail}`);
}

async function readJson(file: string, check: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    fail(check, `${path.relative(ROOT, file)} could not be read (${(error as Error).name})`);
    return null;
  }
}

async function walk(directory: string, filter: (file: string) => boolean): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await walk(absolute, filter)));
    else if (entry.isFile() && filter(absolute)) results.push(absolute);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Contract and handler coherence                                             */
/* -------------------------------------------------------------------------- */

async function checkContractSurface(): Promise<void> {
  const check = 'contract-surface';

  const ids = ROUTES.map((route) => route.operationId);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) fail(check, `duplicate operation ids: ${duplicates.join(', ')}`);

  const keys = new Map<string, number>();
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  const collisions = [...keys.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  if (collisions.length > 0) {
    fail(check, `two operations claim one method and path: ${collisions.join(', ')}`);
  }

  // The registry refuses an unknown operation at startup, but only for the routes
  // a process actually reaches. This check is static: it compares the published
  // catalogue with the registrations in source, in both directions.
  let source: string;
  try {
    source = await readFile(path.join(ROOT, 'src', 'api', 'routes.ts'), 'utf8');
  } catch {
    fail(check, 'src/api/routes.ts could not be read');
    return;
  }
  const registered = new Set(
    [...source.matchAll(/registry\.register\('([^']+)'/g)].map((match) => match[1] as string),
  );
  const unregistered = ids.filter((id) => !registered.has(id));
  const unknown = [...registered].filter((id) => !ids.includes(id));
  if (unregistered.length > 0) {
    fail(check, `operations with no handler: ${unregistered.join(', ')}`);
  } else if (unknown.length > 0) {
    fail(check, `handlers with no published operation: ${unknown.join(', ')}`);
  } else {
    pass(check, `${ids.length} operations are declared once and registered once`);
  }

  const methods = new Set(ROUTES.map((route) => route.method));
  const unexpected = [...methods].filter((method) => !['GET', 'POST', 'PATCH'].includes(method));
  if (unexpected.length > 0) fail(check, `unsupported methods: ${unexpected.join(', ')}`);
}

async function checkContractVersion(): Promise<void> {
  const check = 'contract-version';
  const manifest = await readJson(path.join(ROOT, 'packages', 'contracts', 'package.json'), check);
  if (!manifest) return;
  if (manifest.version === CONTRACT_VERSION) {
    pass(check, `published contract version ${CONTRACT_VERSION} matches package metadata`);
  } else {
    fail(
      check,
      `package version ${String(manifest.version)} does not match CONTRACT_VERSION ${CONTRACT_VERSION}`,
    );
  }
}

/**
 * The advertised ceiling and the enforced ceiling are the same number.
 *
 * A contract-valid upload must never be refused by the transport, and only the
 * operations that carry encoded file content may raise the default bound.
 */
async function checkTransportCeilings(): Promise<void> {
  const check = 'transport-ceilings';
  if (ARTIFACT_BODY_LIMIT_BYTES <= MAX_ARTIFACT_BASE64_CHARS) {
    fail(
      check,
      `artifact body limit ${ARTIFACT_BODY_LIMIT_BYTES} cannot carry a contract-valid upload of ${MAX_ARTIFACT_BASE64_CHARS} base64 characters`,
    );
    return;
  }

  const contentOperations = ['uploadArtifact', 'uploadArtifactVersion', 'generateArtifact'];
  let checked = 0;
  for (const route of ROUTES) {
    if (route.maxBodyBytes !== undefined) {
      checked += 1;
      if (!route.tags.includes('artifacts')) {
        fail(check, `${route.operationId} raises the body ceiling outside the artifact family`);
      }
      if (route.maxBodyBytes < ARTIFACT_BODY_LIMIT_BYTES) {
        fail(
          check,
          `${route.operationId} allows ${route.maxBodyBytes} bytes but the contract advertises ${ARTIFACT_BODY_LIMIT_BYTES}`,
        );
      }
    }
    if (contentOperations.includes(route.operationId) && route.maxBodyBytes === undefined) {
      fail(check, `${route.operationId} accepts file content without a declared body ceiling`);
    }
  }
  if (checked === 0) fail(check, 'no operation declares a body ceiling');
  else pass(check, `${checked} content operations advertise the enforced ceiling`);
}

/* -------------------------------------------------------------------------- */
/* One authority per architectural responsibility                             */
/* -------------------------------------------------------------------------- */

const AUTHORITIES: ReadonlyArray<{ name: string; responsibility: string }> = Object.freeze([
  { name: 'createApplicationService', responsibility: 'use cases' },
  { name: 'createRouteRegistry', responsibility: 'route ownership' },
  { name: 'createRouter', responsibility: 'request dispatch' },
  { name: 'createHttpServer', responsibility: 'transport' },
  { name: 'createOwnerAuth', responsibility: 'authentication' },
  { name: 'createRunSupervisor', responsibility: 'execution supervision' },
  { name: 'createTaskRunner', responsibility: 'run ownership and settlement' },
  { name: 'createBudgetLedger', responsibility: 'model budget' },
  { name: 'createModelCatalog', responsibility: 'model selection' },
  { name: 'createArtifactRepository', responsibility: 'artifact metadata' },
  { name: 'createArtifactService', responsibility: 'artifact lifecycle' },
  { name: 'createScheduleRepository', responsibility: 'schedule records' },
  { name: 'createScheduleEngine', responsibility: 'schedule advancement' },
  { name: 'createPermissionStore', responsibility: 'permissions' },
  { name: 'createEventBus', responsibility: 'execution events' },
  { name: 'createMemoryStore', responsibility: 'memory' },
]);

async function checkSingleAuthorities(): Promise<void> {
  const check = 'single-authority';
  const sources = await walk(path.join(ROOT, 'src'), (file) => file.endsWith('.ts'));
  const contents = new Map<string, string>();
  for (const file of sources) contents.set(file, await readFile(file, 'utf8'));

  for (const authority of AUTHORITIES) {
    const definitions: string[] = [];
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const)\\s+${authority.name}\\b`,
    );
    for (const [file, content] of contents) {
      if (pattern.test(content)) definitions.push(path.relative(ROOT, file));
    }
    if (definitions.length === 1) {
      pass(`${check}.${authority.name}`, `${authority.responsibility} has one implementation`);
    } else if (definitions.length === 0) {
      fail(`${check}.${authority.name}`, `${authority.responsibility} has no implementation`);
    } else {
      fail(
        `${check}.${authority.name}`,
        `${authority.responsibility} is implemented ${definitions.length} times: ${definitions.join(', ')}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Capability and isolation rules                                             */
/* -------------------------------------------------------------------------- */

const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = Object.freeze([
  { label: 'paid routing enabled', pattern: /allowPaid\s*:\s*true/ },
  { label: 'local inference runtime', pattern: /\bollama\b/i },
  { label: 'local inference endpoint', pattern: /(?:localhost|127\.0\.0\.1):11434/ },
]);

async function checkForbiddenCapabilities(): Promise<void> {
  const check = 'capabilities';
  const sources = await walk(path.join(ROOT, 'src'), (file) => file.endsWith('.ts'));
  let violations = 0;
  for (const file of sources) {
    const content = await readFile(file, 'utf8');
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(content)) {
        fail(check, `${rule.label} in ${path.relative(ROOT, file)}`);
        violations += 1;
      }
    }
  }
  if (violations === 0) pass(check, `${FORBIDDEN.length} zero-cost and isolation rules hold`);
}

/* -------------------------------------------------------------------------- */
/* Silent skips                                                               */
/* -------------------------------------------------------------------------- */

async function checkNoSilentSkips(): Promise<void> {
  const check = 'no-silent-skips';
  const suiteFiles = await walk(path.join(ROOT, 'tests'), (file) => file.endsWith('.ts'));
  let violations = 0;
  for (const file of suiteFiles) {
    const content = await readFile(file, 'utf8');
    const relative = path.relative(ROOT, file);
    // A whole-suite skip removes evidence. The object form is allowed only when
    // the reason names the environment that gates it, which is how the database
    // suites declare they cannot run.
    if (/\b(?:test|it|describe|suite)\.skip\s*\(/.test(content)) {
      fail(check, `${relative} skips a test unconditionally`);
      violations += 1;
    }
    // Only the test-option object form counts; a parameter or local named `skip`
    // is not a skip declaration.
    for (const match of content.matchAll(/\{\s*skip\s*:/g)) {
      const window = content.slice(match.index ?? 0, (match.index ?? 0) + 240);
      if (!/CODERAX_TEST_MONGODB_URI|CODERAX_REQUIRE_MONGODB|mongo/i.test(window)) {
        fail(check, `${relative} has a skip that is not environment-gated`);
        violations += 1;
      }
    }
  }
  if (violations === 0) {
    pass(check, `${suiteFiles.length} suites contain no unconditional skip`);
  }
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

const MANIFESTS = ['package.json', 'packages/contracts/package.json', 'packages/sdk/package.json'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

async function checkDependencies(): Promise<void> {
  const check = 'dependencies';
  const lock = await readJson(path.join(ROOT, 'package-lock.json'), check);
  if (!lock) return;
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  if (Object.keys(packages).length === 0) {
    fail(check, 'package-lock.json has no resolved packages');
    return;
  }
  let checked = 0;
  for (const relative of MANIFESTS) {
    const manifest = await readJson(path.join(ROOT, relative), check);
    if (!manifest) continue;
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(dependencies)) {
        checked += 1;
        if (range === 'latest') {
          fail(check, `${relative} requests ${name}@latest instead of a reviewed range`);
          continue;
        }
        if (range === '*' && !name.startsWith('@coderax/')) {
          fail(check, `${relative} has an unpinned range for ${name}`);
          continue;
        }
        const inLockfile =
          `node_modules/${name}` in packages ||
          (name.startsWith('@coderax/') && packages[`packages/${name.split('/')[1]}`] !== undefined);
        if (!inLockfile) {
          fail(check, `${relative} depends on ${name} but package-lock.json has no entry`);
        }
      }
    }
  }
  if (!failures.some((entry) => entry.startsWith(`${check}:`))) {
    pass(check, `${checked} declared dependencies are reproducible from package-lock.json`);
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = Object.freeze([
  { label: 'openai-style key', pattern: /\bsk-[A-Za-z0-9]{20,}/ },
  { label: 'github token', pattern: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { label: 'aws access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', pattern: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { label: 'slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
]);

async function checkSecrets(): Promise<void> {
  const check = 'secrets';
  const roots = ['src', 'packages', 'scripts', 'tests', 'deploy', 'docs', '.github'];
  const files: string[] = [];
  for (const directory of roots) {
    const absolute = path.join(ROOT, directory);
    if (!existsSync(absolute)) continue;
    files.push(
      ...(await walk(absolute, (file) =>
        /\.(?:ts|js|mjs|json|md|yml|yaml|sh|env|example)$/.test(file),
      )),
    );
  }
  let violations = 0;
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const rule of SECRET_PATTERNS) {
      if (rule.pattern.test(content)) {
        // The file and rule are named; the match is never printed.
        fail(check, `${rule.label} appears in ${path.relative(ROOT, file)}`);
        violations += 1;
      }
    }
  }
  if (violations === 0) pass(check, `${files.length} files contain no credential pattern`);
}

/* -------------------------------------------------------------------------- */
/* Dependency advisories (network, opt-in)                                    */
/* -------------------------------------------------------------------------- */

async function checkAdvisories(): Promise<void> {
  const check = 'advisories';
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const report = (stdout: string): void => {
    const parsed = JSON.parse(stdout) as {
      metadata?: { vulnerabilities?: Record<string, number> };
    };
    const counts = parsed.metadata?.vulnerabilities;
    if (!counts) {
      fail(check, 'audit output has no vulnerability summary; treating as unverifiable');
      return;
    }
    const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
    if (blocking > 0) fail(check, `${blocking} high or critical advisories remain`);
    else pass(check, 'no high or critical advisories');
  };

  try {
    const { stdout } = await run('npm', ['audit', '--json', '--audit-level=high'], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    report(stdout);
  } catch (error) {
    const candidate = error as { stdout?: string };
    // `npm audit` exits non-zero when it finds something; that is a finding, not
    // a transport error, so the report is parsed before deciding.
    if (typeof candidate.stdout === 'string' && candidate.stdout.trim().startsWith('{')) {
      try {
        report(candidate.stdout);
      } catch {
        fail(check, 'audit report could not be parsed');
      }
      return;
    }
    fail(check, 'advisory metadata is unavailable; refusing to certify dependencies');
  }
}

/* -------------------------------------------------------------------------- */

export async function runGate(options: { audit?: boolean } = {}): Promise<{
  ok: boolean;
  passes: string[];
  failures: string[];
}> {
  await checkContractSurface();
  await checkContractVersion();
  await checkTransportCeilings();
  await checkSingleAuthorities();
  await checkForbiddenCapabilities();
  await checkNoSilentSkips();
  await checkDependencies();
  await checkSecrets();
  if (options.audit) await checkAdvisories();
  return { ok: failures.length === 0, passes, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audit = process.argv.slice(2).includes('--audit');
  const result = await runGate({ audit });
  for (const line of result.passes) process.stdout.write(`ok   ${line}\n`);
  for (const line of result.failures) process.stderr.write(`FAIL ${line}\n`);
  if (!result.ok) {
    process.stderr.write(`\n${result.failures.length} gate check(s) failed.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\n${result.passes.length} gate checks passed.\n`);
  }
}
