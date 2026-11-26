import { createHash } from 'node:crypto';

/**
 * A deliberately small workflow scanner. It reads workflow text as data and
 * never executes it. The rules answer one question: can a workflow that a
 * contributor can influence reach a production credential or mutate
 * infrastructure? Comments are ignored so documentation such as "this workflow
 * never runs `wrangler deploy`" is not treated as a deploy command.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type AuditFinding = {
  rule: string;
  severity: Severity;
  line: number;
  message: string;
};

export type WorkflowAudit = {
  repository: string;
  path: string;
  sha256: string;
  triggers: string[];
  writePermissions: string[];
  jobWritePermissions: string[];
  secrets: string[];
  infraCommands: { line: number; command: string }[];
  findings: AuditFinding[];
};

export type CiAuditReport = {
  schema: 'coderax.ci-audit/1';
  generatedAt: string;
  repositories: {
    web: RepositoryAudit;
    cli: RepositoryAudit;
  };
  summary: Record<Severity, number>;
};

export type RepositoryAudit = {
  repository: string;
  commit: string;
  files: WorkflowAudit[];
};

const INFRA_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: 'wrangler-deploy', pattern: /\bwrangler\s+(?:deploy|versions\s+upload)\b/ },
  { rule: 'kubectl-mutation', pattern: /\bkubectl\s+(?:apply|create|delete|replace|patch|scale|rollback)\b/ },
  { rule: 'helm-mutation', pattern: /\bhelm\s+(?:upgrade|install|uninstall|rollback)\b/ },
  { rule: 'terraform-mutation', pattern: /\bterraform\s+(?:apply|destroy|import|taint)\b/ },
  { rule: 'cloud-mutation', pattern: /\b(?:aws|gcloud|az)\s+\S+\s+(?:create|update|delete|deploy|put|run|apply)\b/ },
  { rule: 'image-push', pattern: /\bdocker\s+push\b/ },
  { rule: 'package-publish', pattern: /\bnpm\s+publish\b/ },
  { rule: 'github-mutation', pattern: /\bgh\s+(?:release\s+create|workflow\s+run|api\b[^\n]*--method\s+(?:POST|PUT|PATCH|DELETE))/ },
  { rule: 'platform-deploy', pattern: /\b(?:vercel\s+deploy|vercel\s+--prod|fly(?:ctl)?\s+deploy)\b/ },
  { rule: 'remote-shell', pattern: /\bssh\s+(?:-\S+\s+)*[A-Za-z0-9._-]+@/ },
];

const PR_EXPOSED_TRIGGERS = new Set(['pull_request', 'pull_request_target']);
const INFRA_WRITE_SCOPES = new Set([
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'id-token',
  'packages',
  'security-events',
  'statuses',
]);
const METADATA_WRITE_SCOPES = new Set(['issues', 'pull-requests', 'discussions']);

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

function isComment(line: string): boolean {
  return /^\s*#/.test(line);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/** Reads the keys of the top-level `on:` trigger, without a YAML dependency. */
export function parseTriggers(text: string): string[] {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => /^on:\s*(?:#.*)?$/.test(line) || /^on:\s*\S/.test(line));
  if (start === -1) return [];

  const inline = lines[start]!.replace(/^on:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  if (inline !== '') return [unquote(inline)];

  const keys: { key: string; indent: number; line: number }[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || isComment(line)) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*):/);
    if (match) {
      keys.push({ key: match[2]!, indent: match[1]!.length, line: index + 1 });
    }
  }
  if (keys.length === 0) return [];
  const triggerIndent = Math.min(...keys.map((entry) => entry.indent));
  return [...new Set(keys.filter((entry) => entry.indent === triggerIndent).map((entry) => entry.key))];
}

/**
 * Workflow-level permissions apply to every job. Job-level permissions are
 * scoped to a job that may be tag- or dispatch-gated, so they are reported
 * separately instead of being treated as if every pull request received them.
 */
export function parseWritePermissions(text: string): { workflow: string[]; job: string[] } {
  const workflow = new Set<string>();
  const job = new Set<string>();
  for (const line of linesOf(text)) {
    if (isComment(line)) continue;
    if (/^\s*permissions:\s*write-all\s*(?:#.*)?$/.test(line)) {
      (line.match(/^\s*/)?.[0].length ?? 0) === 0 ? workflow.add('write-all') : job.add('write-all');
      continue;
    }
    const match = line.match(/^(\s+)([a-z-]+):\s*write\s*(?:#.*)?$/);
    if (!match) continue;
    (match[1]!.length <= 2 ? workflow : job).add(match[2]!);
  }
  return { workflow: [...workflow].sort(), job: [...job].sort() };
}

export function parseSecrets(text: string): string[] {
  const names = new Set<string>();
  for (const line of linesOf(text)) {
    if (isComment(line)) continue;
    for (const match of line.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(match[1]!);
    }
  }
  return [...names].sort();
}

export function parseInfraCommands(text: string): { line: number; command: string }[] {
  const found: { line: number; command: string }[] = [];
  const lines = linesOf(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isComment(line)) continue;
    for (const rule of INFRA_RULES) {
      if (rule.pattern.test(line)) {
        found.push({ line: index + 1, command: rule.rule });
        break;
      }
    }
  }
  return found;
}

export function parseUnpinnedActions(text: string): { line: number; action: string }[] {
  const found: { line: number; action: string }[] = [];
  const lines = linesOf(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isComment(line)) continue;
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (!match) continue;
    const action = match[1]!;
    if (action.startsWith('./') || action.startsWith('../')) continue;
    if (/@[0-9a-f]{40}$/.test(action)) continue;
    found.push({ line: index + 1, action });
  }
  return found;
}

function isPrivilegedSecret(name: string): boolean {
  if (name === 'GITHUB_TOKEN' || name === 'NODE_MAX_OLD_SPACE_SIZE') return false;
  return /(?:TOKEN|KEY|SECRET|PASSWORD|PASS|URI|DSN|CRED)/i.test(name);
}

/**
 * A production credential controls data, identity, cost or infrastructure. A
 * third-party tool key is still a credential worth reviewing, but calling it a
 * production credential would overstate the finding.
 */
function isProductionSecret(name: string): boolean {
  return /(?:MONGO|DATABASE|JWT|CREDS|OPENAI|ANTHROPIC|CLOUDFLARE|AWS|GCP|DOCKERHUB|CODERAX_OWNER|CODERAX_INFERENCE|CODERAX_PROXY|SMOKE_TOKEN|SMOKE_PASSWORD)/i.test(
    name,
  );
}

export function auditWorkflow(input: {
  repository: string;
  path: string;
  text: string;
  authorized?: boolean;
}): WorkflowAudit {
  const text = input.text;
  const triggers = parseTriggers(text);
  const permissions = parseWritePermissions(text);
  const writePermissions = permissions.workflow;
  const jobWritePermissions = permissions.job;
  const secrets = parseSecrets(text);
  const infraCommands = parseInfraCommands(text);
  const findings: AuditFinding[] = [];
  const prExposed = triggers.some((trigger) => PR_EXPOSED_TRIGGERS.has(trigger));

  if (triggers.includes('pull_request_target')) {
    findings.push({
      rule: 'pull-request-target',
      severity: 'critical',
      line: Math.max(1, linesOf(text).findIndex((line) => /pull_request_target/.test(line)) + 1),
      message: 'pull_request_target runs with base-repository privileges; untrusted pull request content must never reach this context',
    });
  }
  if (triggers.includes('workflow_run')) {
    // A workflow_run job inherits a privileged token and can read the triggering
    // run. It is not pull_request context, but it still needs a trust review.
    findings.push({
      rule: 'workflow-run',
      severity: 'high',
      line: Math.max(1, linesOf(text).findIndex((line) => /workflow_run/.test(line)) + 1),
      message: 'workflow_run executes in a privileged context; verify it never checks out untrusted pull request code',
    });
  }

  for (const name of secrets) {
    if (!isPrivilegedSecret(name)) continue;
    const production = isProductionSecret(name);
    findings.push({
      rule: prExposed ? (production ? 'production-secret-on-pull-request' : 'service-secret-on-pull-request') : 'release-path-secret',
      severity: prExposed ? (production ? 'critical' : 'medium') : 'low',
      line: Math.max(1, linesOf(text).findIndex((line) => line.includes(`secrets.${name}`)) + 1),
      message: prExposed
        ? production
          ? `${name} is available to a workflow a pull request can trigger; pull request code must never receive a production credential`
          : `${name} is a third-party service credential available to a pull-request-triggered workflow`
        : `${name} is used by a release-path workflow; keep it out of pull-request contexts`,
    });
  }

  if (prExposed && writePermissions.length > 0) {
    const infraScopes = writePermissions.filter(
      (scope) => scope === 'write-all' || INFRA_WRITE_SCOPES.has(scope),
    );
    if (infraScopes.length > 0) {
      findings.push({
        rule: 'infrastructure-write-on-pull-request',
        severity: 'critical',
        line: Math.max(1, linesOf(text).findIndex((line) => /^\s*permissions:/.test(line)) + 1),
        message: `workflow-level pull-request context holds infrastructure write scope: ${infraScopes.join(', ')}`,
      });
    }
    const metadataScopes = writePermissions.filter((scope) => METADATA_WRITE_SCOPES.has(scope));
    if (metadataScopes.length > 0) {
      findings.push({
        rule: 'metadata-write-on-pull-request',
        severity: 'low',
        line: Math.max(1, linesOf(text).findIndex((line) => /^\s*permissions:/.test(line)) + 1),
        message: `pull-request context can write review metadata: ${metadataScopes.join(', ')}`,
      });
    }
  }
  if (prExposed && jobWritePermissions.length > 0) {
    findings.push({
      rule: 'job-write-on-pull-request',
      severity: 'medium',
      line: Math.max(1, linesOf(text).findIndex((line) => /^\s{4,}[a-z-]+:\s*write/.test(line)) + 1),
      message: `job-scoped write permission in a pull-request-triggered workflow (${jobWritePermissions.join(', ')}); verify that job cannot run on untrusted code`,
    });
  }

  for (const command of infraCommands) {
    findings.push({
      rule: prExposed ? 'infrastructure-mutation-on-pull-request' : 'infrastructure-mutation',
      severity: prExposed ? 'critical' : input.authorized === true ? 'low' : 'high',
      line: command.line,
      message: prExposed
        ? `${command.command} can run in a pull-request-triggered workflow`
        : input.authorized === true
          ? `${command.command} is on the CI owner's authorized release path`
          : `${command.command} mutates infrastructure without a recorded CI owner authorization`,
    });
  }

  for (const action of parseUnpinnedActions(text)) {
    findings.push({
      rule: 'unpinned-action',
      severity: 'medium',
      line: action.line,
      message: `${action.action} is not pinned to a full commit SHA`,
    });
  }

  if (!/^\s*permissions:/m.test(text)) {
    findings.push({
      rule: 'implicit-permissions',
      severity: 'low',
      line: 1,
      message: 'no top-level permissions block; declare the minimum token scope explicitly',
    });
  }

  return {
    repository: input.repository,
    path: input.path,
    sha256: sha256(text),
    triggers,
    writePermissions,
    jobWritePermissions,
    secrets,
    infraCommands,
    findings: findings.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule)),
  };
}

export function countFindings(files: WorkflowAudit[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const file of files) {
    for (const finding of file.findings) {
      summary[finding.severity] += 1;
    }
  }
  return summary;
}

export function worstSeverity(files: WorkflowAudit[]): Severity | null {
  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  const summary = countFindings(files);
  return order.find((severity) => summary[severity] > 0) ?? null;
}

export function criticalFindings(files: WorkflowAudit[]): AuditFinding[] {
  return files.flatMap((file) => file.findings.filter((finding) => finding.severity === 'critical'));
}

/**
 * A live rescan must reproduce the recorded audit exactly. A changed workflow
 * file, a changed finding or a changed repository commit is a mismatch, never a
 * warning: the attestation is for one immutable commit.
 */
export function compareAudits(recorded: RepositoryAudit, live: RepositoryAudit): string[] {
  const problems: string[] = [];
  if (recorded.repository !== live.repository) {
    problems.push(`${recorded.repository} was rescanned as ${live.repository}`);
  }
  if (recorded.commit !== live.commit) {
    problems.push(
      `${recorded.repository} audit is pinned to ${recorded.commit} but the live checkout is ${live.commit}`,
    );
  }
  const recordedByPath = new Map(recorded.files.map((file) => [file.path, file]));
  const liveByPath = new Map(live.files.map((file) => [file.path, file]));
  for (const path of recordedByPath.keys()) {
    if (!liveByPath.has(path)) problems.push(`${recorded.repository}:${path} disappeared`);
  }
  for (const path of liveByPath.keys()) {
    if (!recordedByPath.has(path)) problems.push(`${recorded.repository}:${path} is not in the recorded audit`);
  }
  for (const [path, recordedFile] of recordedByPath) {
    const liveFile = liveByPath.get(path);
    if (!liveFile) continue;
    if (recordedFile.sha256 !== liveFile.sha256) {
      problems.push(`${recorded.repository}:${path} changed after the audit`);
    }
    const recordedFindings = recordedFile.findings.map(
      (finding) => `${finding.rule}:${finding.severity}:${finding.line}`,
    );
    const liveFindings = liveFile.findings.map(
      (finding) => `${finding.rule}:${finding.severity}:${finding.line}`,
    );
    if (recordedFindings.join('|') !== liveFindings.join('|')) {
      problems.push(`${recorded.repository}:${path} findings differ from the recorded audit`);
    }
  }
  return problems;
}
