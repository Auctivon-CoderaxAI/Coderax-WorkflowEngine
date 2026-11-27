import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Dependency vulnerability gate.
 *
 * Fails on a high or critical advisory in the installed tree. It reads the
 * machine-readable audit rather than a human summary so the threshold cannot be
 * lost in formatting, and a registry failure is a failure rather than a pass:
 * the absence of advisory metadata is not evidence of a clean tree.
 *
 * The classifier is pure and exported so every fail-closed path has a unit test.
 * The fix for an advisory is an upgrade, never a lower threshold or a documented
 * suppression. A moderate or low advisory is reported but does not fail.
 */

type AuditVia = string | { title?: string; severity?: string; url?: string };

type AuditPayload = {
  vulnerabilities?: Record<string, { severity?: string; via?: AuditVia[] }>;
  metadata?: { vulnerabilities?: Record<string, number> };
  error?: { summary?: string; detail?: string };
};

export type AuditFinding = {
  rule: string;
  detail: string;
};

export type AuditReport = {
  findings: AuditFinding[];
  warnings: AuditFinding[];
};

export type AuditRun = {
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

function describe(entry: { via?: AuditVia[] }): string {
  return (entry.via ?? [])
    .map((via) => (typeof via === 'string' ? via : (via.title ?? via.url ?? 'advisory')))
    .join('; ');
}

/** A registry line can carry a token; only the first line is ever reported. */
function safeDiagnostic(value: string): string {
  return (
    value
      .replace(/\/\/[^\s]*:_authToken=[^\s]+/g, '[redacted]')
      .replace(/npm_[A-Za-z0-9]{20,}/g, '[redacted]')
      .split('\n')[0]
      ?.slice(0, 240) ?? ''
  );
}

/** npm can print a notice before the JSON report; the report starts at the first brace. */
function parseReport(stdout: string): AuditPayload | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as AuditPayload;
  } catch {
    return null;
  }
}

/** Classifies one audit result. Exported so every fail-closed path is testable. */
export function auditFromResult(result: AuditRun): AuditReport {
  if (result.error) {
    return {
      findings: [
        {
          rule: 'audit-unavailable',
          detail: `dependency audit could not start: ${result.error.message}`,
        },
      ],
      warnings: [],
    };
  }

  const parsed = parseReport(result.stdout || '');
  if (!parsed) {
    return {
      findings: [
        {
          rule: 'audit-unreadable',
          detail: `dependency audit produced unreadable JSON${result.stderr ? `: ${safeDiagnostic(result.stderr)}` : ''}; refusing to pass`,
        },
      ],
      warnings: [],
    };
  }

  if (parsed.error) {
    return {
      findings: [
        {
          rule: 'audit-registry',
          detail: `dependency audit could not run: ${parsed.error.summary ?? 'unknown registry error'}`,
        },
      ],
      warnings: [],
    };
  }

  // A vulnerability map alone is not proof the scan completed; only npm's
  // metadata block distinguishes a clean tree from a truncated report.
  if (!parsed.metadata?.vulnerabilities) {
    return {
      findings: [
        {
          rule: 'audit-no-metadata',
          detail: 'dependency audit returned no vulnerability metadata; refusing to pass',
        },
      ],
      warnings: [],
    };
  }

  const findings: AuditFinding[] = [];
  const warnings: AuditFinding[] = [];
  for (const [name, entry] of Object.entries(parsed.vulnerabilities ?? {})) {
    const severity = entry.severity ?? 'unknown';
    const finding = {
      rule: `audit-${severity}`,
      detail: `${name}: ${describe(entry)}`,
    };
    if (severity === 'high' || severity === 'critical') findings.push(finding);
    else warnings.push(finding);
  }

  const counts = parsed.metadata.vulnerabilities;
  const summary = ['critical', 'high', 'moderate', 'low', 'info']
    .map((severity) => `${severity}=${counts[severity] ?? 0}`)
    .join(' ');
  if (findings.length === 0 && ((counts.high ?? 0) > 0 || (counts.critical ?? 0) > 0)) {
    findings.push({
      rule: 'audit-inconsistent-counts',
      detail: `dependency audit reports high or critical vulnerabilities without matching details (${summary})`,
    });
  }
  if (findings.length === 0) {
    warnings.push({
      rule: 'audit-summary',
      detail: `high and critical threshold met (${summary})`,
    });
  }
  return { findings, warnings };
}

export function checkAudit(): AuditReport {
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return auditFromResult(result as AuditRun);
}

function main(): void {
  const report = checkAudit();
  if (report.findings.length > 0) {
    for (const finding of report.findings) process.stderr.write(`${finding.detail}\n`);
    process.stderr.write('dependency audit failed: fix or upgrade, do not lower the threshold\n');
    process.exit(1);
  }
  for (const warning of report.warnings) process.stdout.write(`${warning.detail}\n`);
  process.stdout.write('dependency audit passed at high threshold\n');
  process.exit(0);
}

// Importing this module (as a unit test does) must not run the audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
