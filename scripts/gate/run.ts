import { checkArtifacts } from './artifacts.js';
import { checkAudit } from './audit.js';
import { checkAuthorities } from './authority.js';
import { checkCoverage } from './coverage.js';
import { checkDependencies } from './dependencies.js';
import { checkOpenApi } from './openapi.js';
import { checkReachability } from './reachability.js';
import { checkRelease } from './release.js';
import { checkRegistration } from './registration.js';
import { checkSdk } from './sdk.js';
import { checkStructure } from './structure.js';
import type { Report } from './files.js';

/**
 * One reviewable entry point for the static quality gates.
 *
 * Each gate is also exported so the architecture test suite runs the same code;
 * the CLI exists so a CI step names the concern it failed on.
 */

const CHECKS: Record<string, () => Report | Promise<Report>> = {
  structure: checkStructure,
  authority: checkAuthorities,
  reachability: checkReachability,
  coverage: checkCoverage,
  audit: checkAudit,
  registration: checkRegistration,
  sdk: checkSdk,
  openapi: checkOpenApi,
  dependencies: checkDependencies,
  artifacts: checkArtifacts,
  release: checkRelease,
};

const name = process.argv[2];
if (!name || !(name in CHECKS)) {
  process.stderr.write(`usage: node dist/scripts/gate/run.js <${Object.keys(CHECKS).join('|')}>\n`);
  process.exit(2);
}

function annotation(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

let result: Report;
try {
  result = await CHECKS[name]();
} catch (error) {
  const detail = (error as Error).message;
  process.stderr.write(`error: ${name} failed: ${detail}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::error title=${annotation(`${name}:error`)}::${annotation(detail)}\n`);
  }
  process.exit(1);
}

for (const warning of result.warnings) {
  process.stdout.write(`warning: ${warning.rule}: ${warning.detail}\n`);
}
for (const finding of result.findings) {
  process.stderr.write(`error: ${finding.rule}: ${finding.detail}\n`);
}
if (result.findings.length > 0) {
  // A hosted run keeps the step log behind repository admin rights. An
  // annotation is readable from the check run, so a failing gate names its
  // finding there instead of only exiting 1.
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const finding of result.findings.slice(0, 10)) {
      process.stdout.write(
        `::error title=${annotation(`${name}:${finding.rule}`)}::${annotation(finding.detail)}\n`,
      );
    }
  }
  process.stderr.write(`${name}: ${result.findings.length} finding(s)\n`);
  process.exit(1);
}
process.stdout.write(`${name}: clean\n`);
