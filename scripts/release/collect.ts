import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONTRACT_VERSION, EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import type { ReleaseManifest } from './manifest.js';
import { REPOSITORY } from './manifest.js';
import type { CiAuditReport, RepositoryAudit, WorkflowAudit } from './audit.js';
import { auditWorkflow, compareAudits, countFindings, sha256 } from './audit.js';
import { DATABASE_MIGRATIONS } from './migrations.js';
import type { ClientFacts, ReleaseFacts } from './evaluate.js';

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

const CiAuditReportSchema = z
  .object({
    schema: z.literal('coderax.ci-audit/1'),
    generatedAt: z.string(),
    repositories: z
      .object({
        web: z
          .object({
            repository: z.string(),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            files: z.array(
              z
                .object({
                  repository: z.string(),
                  path: z.string(),
                  sha256: z.string().regex(/^[0-9a-f]{64}$/),
                  triggers: z.array(z.string()),
                  writePermissions: z.array(z.string()),
                  jobWritePermissions: z.array(z.string()),
                  secrets: z.array(z.string()),
                  infraCommands: z.array(z.object({ line: z.number(), command: z.string() }).strict()),
                  findings: z.array(
                    z
                      .object({
                        rule: z.string(),
                        severity: SeveritySchema,
                        line: z.number(),
                        message: z.string(),
                      })
                      .strict(),
                  ),
                })
                .strict(),
            ),
          })
          .strict(),
        cli: z
          .object({
            repository: z.string(),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            files: z.array(
              z
                .object({
                  repository: z.string(),
                  path: z.string(),
                  sha256: z.string().regex(/^[0-9a-f]{64}$/),
                  triggers: z.array(z.string()),
                  writePermissions: z.array(z.string()),
                  jobWritePermissions: z.array(z.string()),
                  secrets: z.array(z.string()),
                  infraCommands: z.array(z.object({ line: z.number(), command: z.string() }).strict()),
                  findings: z.array(
                    z
                      .object({
                        rule: z.string(),
                        severity: SeveritySchema,
                        line: z.number(),
                        message: z.string(),
                      })
                      .strict(),
                  ),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
    summary: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        medium: z.number().int().nonnegative(),
        low: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function tryRun(cwd: string, command: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: run(cwd, command, args) };
  } catch {
    return { ok: false, output: '' };
  }
}

function hashFile(file: string): { sha256: string; sha512: string } {
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('hex'),
  };
}

function readWorkflowAudits(input: {
  root: string;
  repository: string;
  authorized: ReadonlySet<string>;
}): WorkflowAudit[] {
  const directory = path.join(input.root, '.github', 'workflows');
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  return files.map((name) => {
    const relative = `.github/workflows/${name}`;
    return auditWorkflow({
      repository: input.repository,
      path: relative,
      text: readFileSync(path.join(directory, name), 'utf8'),
      authorized: input.authorized.has(relative),
    });
  });
}

function authorizedSet(manifest: ReleaseManifest, repository: string): Set<string> {
  const prefix = `${repository}:`;
  return new Set(
    manifest.ci.authorizedDeployWorkflows
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length)),
  );
}

type PreparedClient = {
  facts: ClientFacts;
  liveAudit: RepositoryAudit | null;
};

async function prepareClient(input: {
  root: string;
  role: 'web' | 'cli';
  repository: string;
  commit: string;
  ref: string;
  manifest: ReleaseManifest;
  evidence: { path: string; sha256: string }[];
  online: boolean;
}): Promise<PreparedClient> {
  const evidenceProblems: string[] = [];
  if (!input.online) {
    return {
      facts: { role: input.role, commitReachable: null, evidenceProblems, liveAudit: null },
      liveAudit: null,
    };
  }

  const cacheRoot = path.join(input.root, '.release-evidence', 'online');
  mkdirSync(cacheRoot, { recursive: true });
  const directory = mkdtempSync(path.join(cacheRoot, `${input.role}-`));
  const url = `https://github.com/${input.repository}.git`;
  const sparseDirectories =
    input.role === 'web'
      ? ['.github', 'worker', 'api/server', 'packages/api/src']
      : ['.github', 'src', 'docs'];

  let reachable = false;
  try {
    run(directory, 'git', ['init', '-q']);
    run(directory, 'git', ['remote', 'add', 'origin', url]);
    run(directory, 'git', ['sparse-checkout', 'init', '--cone']);
    run(directory, 'git', ['sparse-checkout', 'set', ...sparseDirectories]);

    const fetched = tryRun(directory, 'git', [
      'fetch',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      'origin',
      input.commit,
    ]);
    if (!fetched.ok) {
      const byRef = tryRun(directory, 'git', [
        'fetch',
        '--quiet',
        '--depth=1',
        '--filter=blob:none',
        'origin',
        input.ref,
      ]);
      if (byRef.ok) {
        const fetchedHead = tryRun(directory, 'git', ['rev-parse', 'FETCH_HEAD']);
        if (fetchedHead.output !== input.commit) {
          evidenceProblems.push(
            `${input.repository} ${input.ref} is ${fetchedHead.output || 'unknown'}; the manifest pins ${input.commit}`,
          );
          return { facts: { role: input.role, commitReachable: false, evidenceProblems, liveAudit: null }, liveAudit: null };
        }
      } else {
        evidenceProblems.push(`${input.repository}@${input.commit} could not be fetched from ${url}`);
        return { facts: { role: input.role, commitReachable: false, evidenceProblems, liveAudit: null }, liveAudit: null };
      }
    }

    run(directory, 'git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    const head = run(directory, 'git', ['rev-parse', 'HEAD']);
    reachable = head === input.commit;
    if (!reachable) {
      evidenceProblems.push(`${input.repository} checkout is ${head}, not ${input.commit}`);
    }

    for (const evidence of input.evidence) {
      const resolved = path.resolve(directory, evidence.path);
      if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) {
        evidenceProblems.push(`${input.repository} evidence path escapes the checkout: ${evidence.path}`);
        continue;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        evidenceProblems.push(`${input.repository} evidence file is missing: ${evidence.path}`);
        continue;
      }
      const actual = hashFile(resolved).sha256;
      if (actual !== evidence.sha256) {
        evidenceProblems.push(`${input.repository} evidence changed after the audit: ${evidence.path}`);
      }
    }

    const liveAudit: RepositoryAudit = {
      repository: input.repository,
      commit: head,
      files: readWorkflowAudits({
        root: directory,
        repository: input.repository,
        authorized: authorizedSet(input.manifest, input.repository),
      }),
    };
    return {
      facts: { role: input.role, commitReachable: reachable, evidenceProblems, liveAudit },
      liveAudit,
    };
  } catch (error) {
    evidenceProblems.push(
      `${input.repository} online verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return {
      facts: { role: input.role, commitReachable: null, evidenceProblems, liveAudit: null },
      liveAudit: null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function getJson(url: string): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json' },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text: text.slice(0, 300) };
}

function objectField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | null {
  const field = objectField(value, key);
  return typeof field === 'string' && field.length > 0 ? field : null;
}

export async function collectFacts(input: {
  root: string;
  manifest: ReleaseManifest;
  online: boolean;
}): Promise<ReleaseFacts> {
  const { root, manifest } = input;
  const engine = manifest.engine;
  const headCommit = run(root, 'git', ['rev-parse', 'HEAD']);
  const ancestor = tryRun(root, 'git', ['merge-base', '--is-ancestor', engine.commit, 'HEAD']).ok;
  const drift = tryRun(root, 'git', [
    'diff',
    '--name-only',
    `${engine.commit}..HEAD`,
    '--',
    'src',
    'packages',
    'openapi.json',
  ]);
  const driftPaths = drift.ok && drift.output !== '' ? drift.output.split('\n') : drift.ok ? [] : ['<git unavailable>'];
  const status = tryRun(root, 'git', ['status', '--porcelain', '--untracked-files=all']);
  const dirtyPaths = status.ok
    ? status.output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : ['<git status unavailable>'];

  const enginePackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
  const sdkPackage = JSON.parse(
    readFileSync(path.join(root, 'packages', 'sdk', 'package.json'), 'utf8'),
  ) as { version?: string };
  const openapi = JSON.parse(readFileSync(path.join(root, 'openapi.json'), 'utf8')) as {
    info?: { version?: string };
  };

  const artifactPath = path.join(root, engine.sdkArtifact.path);
  let artifact = {
    exists: existsSync(artifactPath),
    sha256: null as string | null,
    sha512: null as string | null,
    integrity: null as string | null,
    files: [] as string[],
    problems: [] as string[],
  };
  if (artifact.exists) {
    const bytes = readFileSync(artifactPath);
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
    artifact.sha512 = createHash('sha512').update(bytes).digest('hex');
    artifact.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    try {
      artifact.files = run(root, 'tar', ['-tzf', artifactPath])
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .sort();
    } catch {
      artifact.problems.push('tar could not list the SDK artifact');
    }
    if (!artifact.files.includes('package/package.json')) {
      artifact.problems.push('package/package.json is missing');
    }
    if (!artifact.files.includes('package/dist/index.js')) {
      artifact.problems.push('package/dist/index.js is missing; the SDK was not built before packing');
    }
    if (!artifact.files.includes('package/dist/index.d.ts')) {
      artifact.problems.push('package/dist/index.d.ts is missing');
    }
    for (const entry of artifact.files) {
      if (
        entry.includes('node_modules/') ||
        entry.includes('package/src/') ||
        entry.endsWith('.env') ||
        entry.endsWith('.pem') ||
        entry.endsWith('.key') ||
        entry.includes('/.git/')
      ) {
        artifact.problems.push(`artifact contains a forbidden entry: ${entry}`);
      }
    }
  } else {
    artifact.problems.push('artifact file does not exist');
  }

  const localEvidencePath = path.join(root, engine.localVerification.path);
  const localEvidenceSha256 = existsSync(localEvidencePath)
    ? sha256(readFileSync(localEvidencePath, 'utf8'))
    : null;

  const engineAudits = readWorkflowAudits({
    root,
    repository: REPOSITORY.engine,
    authorized: authorizedSet(manifest, REPOSITORY.engine),
  });

  const auditReportPath = path.join(root, manifest.ci.audit.path);
  let recorded: CiAuditReport | null = null;
  let auditReportSha256: string | null = null;
  let recomputedSummary: Record<'critical' | 'high' | 'medium' | 'low', number> | null = null;
  if (existsSync(auditReportPath)) {
    const text = readFileSync(auditReportPath, 'utf8');
    auditReportSha256 = sha256(text);
    try {
      const parsed = CiAuditReportSchema.safeParse(JSON.parse(text) as unknown);
      if (parsed.success) {
        recorded = parsed.data as CiAuditReport;
        recomputedSummary = countFindings([
          ...recorded.repositories.web.files,
          ...recorded.repositories.cli.files,
        ]);
      }
    } catch {
      recorded = null;
    }
  }

  const web = await prepareClient({
    root,
    role: 'web',
    repository: REPOSITORY.web,
    commit: manifest.web.commit,
    ref: manifest.web.ref,
    manifest,
    evidence: manifest.web.evidence,
    online: input.online,
  });
  const cli = await prepareClient({
    root,
    role: 'cli',
    repository: REPOSITORY.cli,
    commit: manifest.cli.commit,
    ref: manifest.cli.ref,
    manifest,
    evidence: manifest.cli.evidence,
    online: input.online,
  });

  const auditProblems: string[] = [];
  if (recorded === null) {
    auditProblems.push('release/ci-audit.json is missing, unreadable or does not match its schema');
  } else {
    if (web.liveAudit) auditProblems.push(...compareAudits(recorded.repositories.web, web.liveAudit));
    else if (input.online) auditProblems.push('web workflows were not re-read from the pinned commit');
    if (cli.liveAudit) auditProblems.push(...compareAudits(recorded.repositories.cli, cli.liveAudit));
    else if (input.online) auditProblems.push('CLI workflows were not re-read from the pinned commit');
  }

  let webProbe: ReleaseFacts['probes']['web'] = null;
  if (input.online) {
    const origin = manifest.web.deployment.origin;
    if (origin === null) {
      webProbe = {
        attempted: true,
        reachable: false,
        servedCommit: null,
        healthContractVersion: null,
        problems: ['web deployment records no origin'],
      };
    } else {
      const problems: string[] = [];
      let reachable = false;
      let servedCommit: string | null = null;
      let healthContractVersion: string | null = null;
      try {
        const deployment = await getJson(`${origin}/deployment.json`);
        reachable = deployment.status === 200;
        servedCommit = stringField(deployment.body, 'commit');
        if (!reachable) problems.push(`web /deployment.json returned ${deployment.status}: ${deployment.text}`);
      } catch (error) {
        problems.push(`web /deployment.json failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      try {
        const health = await getJson(`${origin}/health`);
        healthContractVersion = stringField(health.body, 'contractVersion');
        if (health.status !== 200) {
          const message = stringField(health.body, 'error');
          problems.push(`web /health returned ${health.status}${message ? `: ${message}` : ''}`);
        }
      } catch (error) {
        problems.push(`web /health failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      webProbe = { attempted: true, reachable, servedCommit, healthContractVersion, problems };
    }
  }

  let engineProbe: ReleaseFacts['probes']['engine'] = null;
  if (input.online && manifest.authoritativeEngine.origin !== null) {
    const origin = manifest.authoritativeEngine.origin;
    const problems: string[] = [];
    let reachable = false;
    let healthContractVersion: string | null = null;
    for (const route of ['/v1/health', '/health']) {
      try {
        const health = await getJson(`${origin}${route}`);
        if (health.status === 404) continue;
        reachable = health.status === 200;
        healthContractVersion = stringField(health.body, 'contractVersion');
        if (!reachable) problems.push(`engine ${route} returned ${health.status}: ${health.text}`);
        break;
      } catch (error) {
        problems.push(`engine ${route} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    engineProbe = { attempted: true, reachable, healthContractVersion, problems };
  }

  return {
    headCommit,
    online: input.online,
    engine: {
      ancestorOfHead: ancestor,
      driftPaths,
      dirtyPaths,
      version: enginePackage.version ?? '',
      apiContract: CONTRACT_VERSION,
      sdkVersion: sdkPackage.version ?? '',
      eventSchema: EVENT_SCHEMA_VERSION,
      openapiSha256: sha256(readFileSync(path.join(root, 'openapi.json'), 'utf8')),
      openapiVersion: openapi.info?.version ?? null,
      artifact,
      localEvidenceSha256,
      migrations: DATABASE_MIGRATIONS,
      workflowAudits: engineAudits,
    },
    web: web.facts,
    cli: cli.facts,
    ci: { auditReportSha256, recorded, recomputedSummary, auditProblems },
    probes: { web: webProbe, engine: engineProbe },
  };
}
