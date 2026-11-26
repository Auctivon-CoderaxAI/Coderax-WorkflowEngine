import { spawnSync } from 'node:child_process';
import { report, type Finding, type Report } from './files.js';

/**
 * Dependency vulnerability gate.
 *
 * Fails on a high or critical advisory in the installed tree. It reads the
 * machine-readable audit rather than a human summary so the threshold cannot be
 * lost in formatting, and a registry failure is a failure rather than a pass:
 * the absence of advisory metadata is not evidence of a clean tree.
 *
 * The fix for an advisory is an upgrade, never a lower threshold or a documented
 * suppression. A moderate/low advisory is reported but does not fail; the
 * installed tree is still named so a later review can see it.
 */

type AuditVia = string | { title?: string; severity?: string; url?: string };

type AuditReport = {
  vulnerabilities?: Record<string, { severity?: string; via?: AuditVia[] }>;
  metadata?: { vulnerabilities?: Record<string, number> };
  error?: { summary?: string; detail?: string };
};

function describe(entry: { via?: AuditVia[] }): string {
  return (entry.via ?? [])
    .map((via) => (typeof via === 'string' ? via : (via.title ?? via.url ?? 'advisory')))
    .join('; ');
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/\/\/[^\s]*:_authToken=[^\s]+/g, '[redacted]')
    .replace(/npm_[A-Za-z0-9]{20,}/g, '[redacted]')
    .split('\n')[0]
    ?.slice(0, 240) ?? '';
}

/** npm can print a notice before the JSON report; the report starts at the first brace. */
function parseReport(stdout: string): AuditReport | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as AuditReport;
  } catch {
    return null;
  }
}

export function checkAudit(): Report {
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return report([
      {
        rule: 'audit-unavailable',
        detail: `dependency audit could not start: ${result.error.message}`,
      },
    ]);
  }

  const parsed = parseReport(result.stdout || '');
  if (!parsed) {
    return report([
      {
        rule: 'audit-unreadable',
        detail: `dependency audit produced unreadable JSON${result.stderr ? `: ${safeDiagnostic(result.stderr)}` : ''}; refusing to pass`,
      },
    ]);
  }

  if (parsed.error) {
    return report([
      {
        rule: 'audit-registry',
        detail: `dependency audit could not run: ${parsed.error.summary ?? 'unknown registry error'}`,
      },
    ]);
  }

  if (!parsed.metadata?.vulnerabilities && !parsed.vulnerabilities) {
    return report([
      {
        rule: 'audit-no-metadata',
        detail: 'dependency audit returned no vulnerability metadata; refusing to pass',
      },
    ]);
  }

  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  for (const [name, entry] of Object.entries(parsed.vulnerabilities ?? {})) {
    const severity = entry.severity ?? 'unknown';
    const finding = {
      rule: `audit-${severity}`,
      detail: `${name}: ${describe(entry)}`,
    };
    if (severity === 'high' || severity === 'critical') findings.push(finding);
    else warnings.push(finding);
  }

  const counts = parsed.metadata?.vulnerabilities ?? {};
  const summary = ['critical', 'high', 'moderate', 'low', 'info']
    .map((severity) => `${severity}=${counts[severity] ?? 0}`)
    .join(' ');
  if (findings.length === 0) {
    warnings.push({
      rule: 'audit-summary',
      detail: `high and critical threshold met (${summary})`,
    });
  }
  return report(findings, warnings);
}
