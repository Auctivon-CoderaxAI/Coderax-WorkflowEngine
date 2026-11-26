import { spawnSync } from 'node:child_process';

/**
 * Dependency vulnerability gate.
 *
 * Fails on a high or critical advisory in the installed tree. It reads the
 * machine-readable audit rather than a human summary so the threshold cannot be
 * lost in formatting, and a registry failure is a failure rather than a pass.
 */

const result = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

let report: {
  vulnerabilities?: Record<string, { severity?: string; via?: unknown[] }>;
  metadata?: { vulnerabilities?: Record<string, number> };
  error?: { summary?: string; detail?: string };
};

if (result.error) {
  process.stderr.write(`dependency audit could not start: ${result.error.message}\n`);
  process.exit(1);
}

try {
  report = JSON.parse(result.stdout || '{}');
} catch {
  process.stderr.write('dependency audit produced unreadable JSON; refusing to pass\n');
  process.exit(1);
}

// A missing registry response can produce an empty object with a zero exit.
// Absence of audit metadata is not evidence of a clean tree.
if (!report.metadata?.vulnerabilities && !report.vulnerabilities) {
  process.stderr.write('dependency audit returned no vulnerability metadata; refusing to pass\n');
  process.exit(1);
}

if (report.error) {
  process.stderr.write(
    `dependency audit could not run: ${report.error.summary ?? 'unknown registry error'}\n`,
  );
  process.exit(1);
}

const blocking = Object.entries(report.vulnerabilities ?? {}).filter(([, entry]) =>
  entry.severity === 'high' || entry.severity === 'critical',
);

if (blocking.length > 0) {
  for (const [name, entry] of blocking) {
    const titles = (entry.via ?? [])
      .map((via) => (typeof via === 'string' ? via : (via as { title?: string }).title ?? 'advisory'))
      .join('; ');
    process.stderr.write(`${entry.severity}: ${name} (${titles})\n`);
  }
  process.stderr.write('dependency audit failed: fix or upgrade, do not lower the threshold\n');
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
const summary = ['critical', 'high', 'moderate', 'low', 'info']
  .map((severity) => `${severity}=${counts[severity] ?? 0}`)
  .join(' ');
process.stdout.write(`dependency audit passed at high threshold (${summary})\n`);
