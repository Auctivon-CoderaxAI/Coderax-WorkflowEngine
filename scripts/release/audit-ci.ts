import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { CiAuditReport, RepositoryAudit } from './audit.js';
import { auditWorkflow, countFindings } from './audit.js';
import { REPOSITORY } from './manifest.js';

/**
 * Reads the two client checkouts at their pinned commits and records a
 * checksummed audit of every workflow file. The release verifier re-reads the
 * same commits and refuses a report whose file hashes or findings differ.
 */

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} <directory> is required`);
  return path.resolve(value);
}

function auditRepository(directory: string, repository: string): RepositoryAudit {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const workflows = path.join(directory, '.github', 'workflows');
  const files = readdirSync(workflows)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) =>
      auditWorkflow({
        repository,
        path: `.github/workflows/${name}`,
        text: readFileSync(path.join(workflows, name), 'utf8'),
      }),
    );
  return { repository, commit, files };
}

function main(): void {
  const web = auditRepository(option('--web'), REPOSITORY.web);
  const cli = auditRepository(option('--cli'), REPOSITORY.cli);
  const summary = countFindings([...web.files, ...cli.files]);
  const report: CiAuditReport = {
    schema: 'coderax.ci-audit/1',
    generatedAt: new Date().toISOString(),
    repositories: { web, cli },
    summary,
  };
  const output = path.resolve(process.cwd(), 'release', 'ci-audit.json');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    [
      `audited ${web.repository}@${web.commit} (${web.files.length} workflows)`,
      `audited ${cli.repository}@${cli.commit} (${cli.files.length} workflows)`,
      `critical=${summary.critical} high=${summary.high} medium=${summary.medium} low=${summary.low}`,
      `wrote ${path.relative(process.cwd(), output)}`,
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`CI audit failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
