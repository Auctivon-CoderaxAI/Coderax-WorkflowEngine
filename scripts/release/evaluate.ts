import type { ClientManifest, Migration, ReleaseManifest } from './manifest.js';
import type { CiAuditReport, RepositoryAudit, Severity, WorkflowAudit } from './audit.js';
import { countFindings } from './audit.js';

export type RowStatus = 'pass' | 'fail';

export type ReleaseRow = {
  id: string;
  label: string;
  status: RowStatus;
  evidence: string[];
  blockers: string[];
};

export type ReleaseEvaluation = {
  train: string;
  verdict: 'ready' | 'blocked';
  rows: ReleaseRow[];
  blockers: string[];
  facts: {
    headCommit: string;
    online: boolean;
    engineWorkflowSummary: Record<Severity, number>;
    clientWorkflowSummary: Record<Severity, number>;
  };
};

export type ClientFacts = {
  role: 'web' | 'cli';
  /** true when the pinned commit was fetched from the remote, null when unchecked. */
  commitReachable: boolean | null;
  /** Hash mismatches between recorded evidence and the pinned client checkout. */
  evidenceProblems: string[];
  liveAudit: RepositoryAudit | null;
};

export type ReleaseFacts = {
  headCommit: string;
  online: boolean;
  engine: {
    ancestorOfHead: boolean;
    driftPaths: string[];
    dirtyPaths: string[];
    version: string;
    apiContract: string;
    sdkVersion: string;
    eventSchema: number;
    openapiSha256: string;
    openapiVersion: string | null;
    artifact: {
      exists: boolean;
      sha256: string | null;
      sha512: string | null;
      integrity: string | null;
      files: string[];
      problems: string[];
    };
    localEvidenceSha256: string | null;
    migrations: readonly Migration[];
    workflowAudits: WorkflowAudit[];
  };
  web: ClientFacts;
  cli: ClientFacts;
  ci: {
    auditReportSha256: string | null;
    recorded: CiAuditReport | null;
    recomputedSummary: Record<Severity, number> | null;
    auditProblems: string[];
  };
  probes: {
    web: {
      attempted: boolean;
      reachable: boolean;
      servedCommit: string | null;
      healthContractVersion: string | null;
      problems: string[];
    } | null;
    engine: {
      attempted: boolean;
      reachable: boolean;
      healthContractVersion: string | null;
      problems: string[];
    } | null;
  };
};

function push(row: ReleaseRow, condition: boolean, message: string): void {
  if (!condition) row.blockers.push(message);
}

function pass(row: ReleaseRow, evidence: string): void {
  row.evidence.push(evidence);
}

function makeRow(id: string, label: string): ReleaseRow {
  return { id, label, status: 'pass', evidence: [], blockers: [] };
}

function migrationsEqual(left: readonly Migration[], right: readonly Migration[]): boolean {
  const normalize = (entries: readonly Migration[]) =>
    [...entries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({ ...entry, keys: { ...entry.keys } }));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function checkClientProtocol(
  row: ReleaseRow,
  client: ClientManifest,
  manifest: ReleaseManifest,
  facts: ClientFacts,
): void {
  const integration = client.integration;
  push(row, integration.status === 'integrated', `${client.repository} is not integrated with the WorkflowEngine`);
  push(
    row,
    integration.apiContract === manifest.engine.apiContract,
    `${client.repository} declares API contract ${integration.apiContract ?? 'none'}; engine serves ${manifest.engine.apiContract}`,
  );
  push(
    row,
    integration.sdkVersion === manifest.engine.sdkVersion,
    `${client.repository} declares SDK ${integration.sdkVersion ?? 'none'}; engine publishes ${manifest.engine.sdkVersion}`,
  );
  push(
    row,
    integration.sdkArtifactSha256 === manifest.engine.sdkArtifact.sha256,
    `${client.repository} does not pin the checksum-verified SDK artifact`,
  );
  push(
    row,
    integration.eventSchema === manifest.engine.eventSchema,
    `${client.repository} declares event schema ${integration.eventSchema ?? 'none'}; engine emits ${manifest.engine.eventSchema}`,
  );
  push(
    row,
    integration.engineOrigin !== null &&
      integration.engineOrigin === manifest.authoritativeEngine.origin,
    `${client.repository} does not name the authoritative engine origin`,
  );
  push(
    row,
    facts.commitReachable === true,
    facts.commitReachable === null
      ? `${client.repository}@${client.commit} reachability was not verified; run with --online`
      : `${client.repository}@${client.commit} is not reachable from its remote`,
  );
  for (const problem of facts.evidenceProblems) {
    row.blockers.push(problem);
  }
  if (integration.status === 'integrated') {
    pass(
      row,
      `${client.repository}@${client.commit} declares ${integration.apiContract ?? '?'} / SDK ${integration.sdkVersion ?? '?'} / events ${integration.eventSchema ?? '?'} and pins the engine origin`,
    );
  } else {
    pass(row, `${client.repository} integration reason: ${integration.reason}`);
  }
}

function requiredCheckNames(component: { requiredChecks: { required: boolean; workflow: string }[] }): string[] {
  return component.requiredChecks.filter((check) => check.required).map((check) => check.workflow);
}

export function evaluateRelease(manifest: ReleaseManifest, facts: ReleaseFacts): ReleaseEvaluation {
  const rows: ReleaseRow[] = [];
  const engine = manifest.engine;

  const commits = makeRow('commits', 'Repository commit SHAs');
  push(commits, facts.engine.ancestorOfHead, `engine ${engine.commit} is not an ancestor of HEAD ${facts.headCommit}`);
  push(
    commits,
    facts.engine.driftPaths.length === 0,
    `shipped engine files differ from the audited commit: ${facts.engine.driftPaths.join(', ') || 'unknown'}`,
  );
  push(
    commits,
    facts.engine.dirtyPaths.length === 0,
    `working tree is not clean: ${facts.engine.dirtyPaths.slice(0, 8).join(', ')}${facts.engine.dirtyPaths.length > 8 ? ', …' : ''}`,
  );
  push(commits, facts.online, 'commit reachability requires --online');
  pass(commits, `engine pinned at ${engine.commit}; HEAD ${facts.headCommit}; shipped paths are identical`);
  pass(commits, `web pinned at ${manifest.web.commit}; cli pinned at ${manifest.cli.commit}`);
  commits.status = commits.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(commits);

  const engineVersion = makeRow('engine-version', 'Engine version');
  push(engineVersion, engine.version === facts.engine.version, `manifest ${engine.version}; package.json ${facts.engine.version}`);
  pass(engineVersion, `package.json version ${facts.engine.version}`);
  engineVersion.status = engineVersion.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(engineVersion);

  const contract = makeRow('api-contract', 'API contract version');
  push(contract, engine.apiContract === facts.engine.apiContract, `manifest ${engine.apiContract}; CONTRACT_VERSION ${facts.engine.apiContract}`);
  push(
    contract,
    facts.engine.openapiVersion === engine.apiContract,
    `openapi.json reports ${facts.engine.openapiVersion ?? 'no version'}; CONTRACT_VERSION is ${engine.apiContract}`,
  );
  push(
    contract,
    manifest.authoritativeEngine.contractVersion === engine.apiContract,
    `authoritative engine contract ${manifest.authoritativeEngine.contractVersion}; engine ${engine.apiContract}`,
  );
  pass(contract, `CONTRACT_VERSION ${facts.engine.apiContract}; openapi.json ${facts.engine.openapiVersion ?? '?'}`);
  contract.status = contract.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(contract);

  const sdk = makeRow('sdk', 'SDK version and artifact checksum');
  push(sdk, engine.sdkVersion === facts.engine.sdkVersion, `manifest SDK ${engine.sdkVersion}; package.json ${facts.engine.sdkVersion}`);
  push(sdk, engine.sdkVersion === engine.apiContract, `SDK ${engine.sdkVersion} does not match contract ${engine.apiContract}`);
  push(sdk, facts.engine.artifact.exists, `SDK artifact ${engine.sdkArtifact.path} is missing`);
  push(
    sdk,
    facts.engine.artifact.sha256 === engine.sdkArtifact.sha256,
    'SDK artifact SHA-256 does not match the manifest',
  );
  push(
    sdk,
    facts.engine.artifact.sha512 === engine.sdkArtifact.sha512,
    'SDK artifact SHA-512 does not match the manifest',
  );
  push(
    sdk,
    facts.engine.artifact.integrity === engine.sdkArtifact.integrity,
    'SDK artifact integrity does not match the manifest',
  );
  push(
    sdk,
    JSON.stringify([...facts.engine.artifact.files].sort()) ===
      JSON.stringify([...engine.sdkArtifact.files].sort()),
    'SDK artifact file list does not match the manifest',
  );
  for (const problem of facts.engine.artifact.problems) {
    sdk.blockers.push(`SDK artifact: ${problem}`);
  }
  pass(sdk, `${engine.sdkArtifact.path} sha256=${engine.sdkArtifact.sha256}`);
  sdk.status = sdk.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(sdk);

  const events = makeRow('event-schema', 'Event schema version');
  push(events, engine.eventSchema === facts.engine.eventSchema, `manifest ${engine.eventSchema}; EVENT_SCHEMA_VERSION ${facts.engine.eventSchema}`);
  push(
    events,
    manifest.authoritativeEngine.eventSchema === engine.eventSchema,
    `authoritative event schema ${manifest.authoritativeEngine.eventSchema}; engine ${engine.eventSchema}`,
  );
  pass(events, `EVENT_SCHEMA_VERSION ${facts.engine.eventSchema}`);
  events.status = events.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(events);

  const web = makeRow('web-compatibility', 'Web compatibility');
  checkClientProtocol(web, manifest.web, manifest, facts.web);
  web.status = web.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(web);

  const cli = makeRow('cli-compatibility', 'CLI compatibility');
  checkClientProtocol(cli, manifest.cli, manifest, facts.cli);
  cli.status = cli.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(cli);

  const migrations = makeRow('migrations', 'Database migration requirements');
  push(
    migrations,
    migrationsEqual(engine.migrations, facts.engine.migrations),
    'declared migrations differ from the migrations the engine actually creates',
  );
  for (const migration of engine.migrations) {
    push(migrations, migration.reversible, `${migration.id} has no verified reverse operation`);
    push(migrations, migration.rollback.length > 0, `${migration.id} has no documented rollback`);
  }
  pass(
    migrations,
    `${engine.migrations.length} index migrations (${engine.migrations.map((migration) => migration.name).join(', ')}); additive and reversible`,
  );
  migrations.status = migrations.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(migrations);

  const checks = makeRow('required-checks', 'Required GitHub Actions checks');
  for (const component of [engine, manifest.web, manifest.cli] as const) {
    const componentChecks = component.requiredChecks;
    push(checks, componentChecks.length > 0, `${component.repository} declares no required check`);
    for (const check of componentChecks.filter((entry) => entry.required)) {
      const passed = check.conclusion === 'success';
      push(
        checks,
        passed,
        `${component.repository} ${check.workflow}/${check.job} is ${check.conclusion}, not success`,
      );
      if (passed) {
        push(
          checks,
          check.headSha === component.commit,
          `${component.repository} ${check.workflow}/${check.job} passed at ${check.headSha ?? 'no head'}, not at ${component.commit}`,
        );
        push(
          checks,
          check.url !== null && check.checkedAt !== null,
          `${component.repository} ${check.workflow}/${check.job} has no run URL or timestamp`,
        );
      }
    }
    const signoff = manifest.ci.ownerSignoffs.find((entry) => entry.repository === component.repository);
    push(checks, signoff !== undefined && signoff.status === 'signed', `${component.repository} CI owner has not signed off`);
    if (signoff) {
      push(checks, signoff.signedAt !== null, `${component.repository} CI owner sign-off has no timestamp`);
      for (const name of requiredCheckNames(component)) {
        push(
          checks,
          signoff.requiredChecks.includes(name),
          `${component.repository} CI owner sign-off does not cover ${name}`,
        );
      }
    }
  }
  const local = engine.localVerification;
  push(checks, local.headCommit === engine.commit, `local verification ran at ${local.headCommit}, not ${engine.commit}`);
  push(checks, local.exitCode === 0 && local.failures === 0, 'local verification did not pass');
  push(checks, local.tests > 0, 'local verification recorded no tests');
  push(
    checks,
    facts.engine.localEvidenceSha256 === local.outputSha256,
    'local verification log is missing or its checksum does not match',
  );
  pass(checks, `local ${local.command}: ${local.tests} tests, ${local.failures} failures at ${local.headCommit}`);
  checks.status = checks.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(checks);

  const review = makeRow('review', 'Independent review status');
  for (const component of [engine, manifest.web, manifest.cli] as const) {
    push(
      review,
      component.review.status === 'approved',
      `${component.repository} is ${component.review.status}, not approved`,
    );
    push(review, component.review.reviewer !== null, `${component.repository} has no independent reviewer`);
    push(review, component.review.author !== null, `${component.repository} has no recorded author`);
    if (component.review.reviewer !== null && component.review.author !== null) {
      push(
        review,
        component.review.reviewer !== component.review.author,
        `${component.repository} review is self-approval, not independent`,
      );
    }
    push(
      review,
      component.review.headSha === component.commit,
      `${component.repository} review is not for ${component.commit}`,
    );
    push(review, component.review.reviewedAt !== null, `${component.repository} review has no timestamp`);
  }
  review.status = review.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(review);

  const deployment = makeRow('deployment', 'Deployment readiness');
  const engineDeployment = engine.deployment;
  push(deployment, engineDeployment.deployed, 'WorkflowEngine is not deployed');
  push(
    deployment,
    engineDeployment.origin !== null && engineDeployment.origin === manifest.authoritativeEngine.origin,
    'WorkflowEngine deployment does not name the authoritative origin',
  );
  push(
    deployment,
    engineDeployment.servedCommit === engine.commit,
    `WorkflowEngine serves ${engineDeployment.servedCommit ?? 'no commit'}, not ${engine.commit}`,
  );
  push(
    deployment,
    engineDeployment.healthContractVersion === engine.apiContract,
    `WorkflowEngine health reports contract ${engineDeployment.healthContractVersion ?? 'none'}, not ${engine.apiContract}`,
  );
  push(deployment, engineDeployment.verifiedAt !== null, 'WorkflowEngine deployment has no verification timestamp');

  if (manifest.web.deployment.deployed) {
    push(
      deployment,
      manifest.web.deployment.servedCommit === manifest.web.commit,
      `Web serves ${manifest.web.deployment.servedCommit ?? 'no commit'}, not ${manifest.web.commit}`,
    );
  } else {
    deployment.blockers.push('Web deployment is not recorded');
  }
  if (facts.probes.web === null || !facts.probes.web.attempted) {
    deployment.blockers.push('live web origin was not probed; run with --online');
  } else {
    push(deployment, facts.probes.web.reachable, 'live web origin is unreachable');
    push(deployment, facts.probes.web.servedCommit === manifest.web.commit, 'live web origin serves a different commit');
    push(
      deployment,
      facts.probes.web.healthContractVersion === engine.apiContract,
      `live web origin reports contract ${facts.probes.web.healthContractVersion ?? 'none'}, not ${engine.apiContract}`,
    );
    for (const problem of facts.probes.web.problems) deployment.blockers.push(problem);
  }
  if (manifest.authoritativeEngine.origin !== null) {
    if (facts.probes.engine === null || !facts.probes.engine.attempted) {
      deployment.blockers.push('authoritative engine origin was not probed');
    } else {
      push(deployment, facts.probes.engine.reachable, 'authoritative engine origin is unreachable');
      push(
        deployment,
        facts.probes.engine.healthContractVersion === engine.apiContract,
        'authoritative engine does not report the contract version',
      );
    }
  }
  if (manifest.cli.deployment.deployed) {
    push(
      deployment,
      manifest.cli.deployment.servedCommit === manifest.cli.commit,
      'CLI release is not built from the pinned commit',
    );
  } else {
    deployment.blockers.push('CLI release is not recorded');
  }
  pass(
    deployment,
    `engine deployed=${engineDeployment.deployed}; web served=${manifest.web.deployment.servedCommit ?? 'none'}; cli released=${manifest.cli.deployment.deployed}`,
  );
  deployment.status = deployment.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(deployment);

  const rollback = makeRow('rollback', 'Rollback compatibility');
  for (const component of [engine, manifest.web, manifest.cli] as const) {
    const plan = component.rollback;
    push(rollback, plan.dataDeletion === false, `${component.repository} rollback deletes data`);
    push(rollback, plan.contractCompatible, `${component.repository} rollback is not contract compatible`);
    if (manifest.cutover.executed) {
      push(rollback, plan.mode !== 'pre-cutover-abort', `${component.repository} proposes a pre-cutover abort after cutover`);
      push(rollback, plan.targetCommit !== null, `${component.repository} rollback has no immutable target commit`);
    } else {
      push(
        rollback,
        plan.mode === 'pre-cutover-abort' || plan.targetCommit !== null,
        `${component.repository} rollback is undefined`,
      );
    }
  }
  pass(rollback, 'no rollback path deletes data; the train has not executed a production cutover');
  rollback.status = rollback.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(rollback);

  const unpublished = makeRow('unpublished-integration', 'Unpublished integration commits');
  for (const entry of manifest.unpublished) {
    if (entry.disposition === 'pending-merge') {
      unpublished.blockers.push(
        `${entry.branch}@${entry.commit} is unpublished (${entry.ahead} ahead) and has no merge or exclusion decision`,
      );
    }
    if (entry.disposition === 'superseded') {
      push(unpublished, entry.supersededBy !== null, `${entry.branch} is superseded but names no replacement commit`);
    }
    if (entry.disposition === 'excluded') {
      push(unpublished, entry.exclusion !== null, `${entry.branch} is excluded without an owner rationale`);
    }
    pass(unpublished, `${entry.branch}@${entry.commit}: ${entry.disposition}`);
  }
  if (manifest.unpublished.length === 0) {
    unpublished.blockers.push('no reconciliation inventory for unpublished engine commits');
  }
  unpublished.status = unpublished.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(unpublished);

  const safety = makeRow('ci-safety', 'Cross-repository CI credential safety');
  push(safety, facts.online, 'CI workflows were not re-read from the pinned client commits; run with --online');
  push(safety, facts.ci.auditReportSha256 === manifest.ci.audit.sha256, 'CI audit report checksum does not match the manifest');
  if (facts.ci.recorded === null) {
    safety.blockers.push('CI audit report is missing or invalid');
  } else {
    push(
      safety,
      facts.ci.recorded.repositories.web.commit === manifest.web.commit,
      'web CI audit is not for the pinned web commit',
    );
    push(
      safety,
      facts.ci.recorded.repositories.cli.commit === manifest.cli.commit,
      'CLI CI audit is not for the pinned CLI commit',
    );
    const recomputed = facts.ci.recomputedSummary;
    if (recomputed === null) {
      safety.blockers.push('CI audit summary could not be recomputed');
    } else {
      for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        push(
          safety,
          facts.ci.recorded.summary[severity] === recomputed[severity],
          `CI audit ${severity} count ${facts.ci.recorded.summary[severity]} does not match the findings (${recomputed[severity]})`,
        );
      }
    }
    for (const repository of [facts.ci.recorded.repositories.web, facts.ci.recorded.repositories.cli]) {
      const summary = countFindings(repository.files);
      push(
        safety,
        summary.critical === 0,
        `${repository.repository} has ${summary.critical} critical CI findings`,
      );
      push(safety, summary.high === 0, `${repository.repository} has ${summary.high} high CI findings`);
    }
  }
  for (const problem of facts.ci.auditProblems) {
    safety.blockers.push(problem);
  }
  const engineWorkflowSummary = countFindings(facts.engine.workflowAudits);
  push(safety, engineWorkflowSummary.critical === 0, `engine CI has ${engineWorkflowSummary.critical} critical findings`);
  push(safety, engineWorkflowSummary.high === 0, `engine CI has ${engineWorkflowSummary.high} high findings`);
  for (const signoff of manifest.ci.ownerSignoffs) {
    push(safety, signoff.status === 'signed', `${signoff.repository} CI owner has not signed the workflow policy`);
  }
  pass(
    safety,
    `engine workflows: ${engineWorkflowSummary.critical} critical, ${engineWorkflowSummary.high} high; client results recorded and re-checked`,
  );
  safety.status = safety.blockers.length === 0 ? 'pass' : 'fail';
  rows.push(safety);

  const blockers = rows.flatMap((row) => row.blockers.map((blocker) => `${row.label}: ${blocker}`));
  return {
    train: manifest.train,
    verdict: blockers.length === 0 ? 'ready' : 'blocked',
    rows,
    blockers,
    facts: {
      headCommit: facts.headCommit,
      online: facts.online,
      engineWorkflowSummary,
      clientWorkflowSummary: facts.ci.recomputedSummary ?? { critical: 0, high: 0, medium: 0, low: 0 },
    },
  };
}

export function renderTable(evaluation: ReleaseEvaluation): string {
  const idWidth = Math.max(...evaluation.rows.map((row) => row.id.length), 2);
  const labelWidth = Math.max(...evaluation.rows.map((row) => row.label.length), 5);
  const lines: string[] = [];
  lines.push(`RELEASE ${evaluation.train}  VERDICT: ${evaluation.verdict.toUpperCase()}`);
  lines.push(
    `head ${evaluation.facts.headCommit}  online=${evaluation.facts.online}  engine CI critical/high=${evaluation.facts.engineWorkflowSummary.critical}/${evaluation.facts.engineWorkflowSummary.high}  client CI critical/high=${evaluation.facts.clientWorkflowSummary.critical}/${evaluation.facts.clientWorkflowSummary.high}`,
  );
  lines.push('');
  lines.push(`${'ROW'.padEnd(idWidth)}  ${'MATRIX ENTRY'.padEnd(labelWidth)}  STATUS`);
  lines.push(`${'-'.repeat(idWidth)}  ${'-'.repeat(labelWidth)}  ------`);
  for (const row of evaluation.rows) {
    lines.push(
      `${row.id.padEnd(idWidth)}  ${row.label.padEnd(labelWidth)}  ${row.status === 'pass' ? 'PASS' : 'FAIL'}`,
    );
  }
  lines.push('');
  if (evaluation.blockers.length === 0) {
    lines.push('No blockers. The release is ready for the authorized cutover.');
  } else {
    lines.push(`BLOCKERS (${evaluation.blockers.length})`);
    for (const blocker of evaluation.blockers) {
      lines.push(`- ${blocker}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
