import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRelease, type ReleaseFacts } from '../../scripts/release/evaluate.js';
import {
  parseReleaseManifest,
  REPOSITORY,
  type ReleaseManifest,
} from '../../scripts/release/manifest.js';
import type { CiAuditReport, WorkflowAudit } from '../../scripts/release/audit.js';

const ENGINE = 'a'.repeat(40);
const WEB = 'b'.repeat(40);
const CLI = 'c'.repeat(40);
const ARTIFACT = 'd'.repeat(64);
const ARTIFACT_512 = 'e'.repeat(128);
const AUDIT = 'f'.repeat(64);
const NOW = '2026-11-26T00:00:00.000Z';
const FILES = ['package/dist/index.d.ts', 'package/dist/index.js', 'package/package.json'];

function client(kind: 'web' | 'cli', commit: string): Record<string, unknown> {
  const required = kind === 'web' ? 'static-checks' : 'ci';
  return {
    repository: kind === 'web' ? REPOSITORY.web : REPOSITORY.cli,
    commit,
    ref: 'main',
    version: '1.0.0',
    integration: {
      status: 'integrated',
      reason: 'consumes @coderax/sdk against the authoritative engine',
      sdkVersion: '1.0.0',
      sdkArtifactSha256: ARTIFACT,
      apiContract: '1.0.0',
      eventSchema: 1,
      engineOrigin: 'https://engine.example.com',
    },
    evidence: [{ path: 'package.json', line: 1, statement: 'pinned', sha256: '5'.repeat(64) }],
    requiredChecks: [
      {
        workflow: required,
        job: 'test',
        required: true,
        headSha: commit,
        conclusion: 'success',
        url: 'https://github.com/Auctivon-CoderaxAI/example/actions/runs/1',
        checkedAt: NOW,
      },
    ],
    review: {
      author: 'author',
      reviewer: 'reviewer',
      status: 'approved',
      headSha: commit,
      reviewedAt: NOW,
    },
    deployment: {
      deployed: true,
      origin: kind === 'web' ? 'https://web.example.com' : null,
      servedCommit: commit,
      healthContractVersion: kind === 'web' ? '1.0.0' : null,
      verifiedAt: NOW,
    },
    rollback: {
      mode: 'pre-cutover-abort',
      targetCommit: null,
      dataDeletion: false,
      contractCompatible: true,
      notes: 'no cutover in this train',
    },
  };
}

function manifestRaw(): Record<string, unknown> {
  return {
    schema: 'coderax.release-train/1',
    train: 'rc-test',
    createdAt: NOW,
    cutover: { executed: false, at: null },
    authoritativeEngine: {
      origin: 'https://engine.example.com',
      apiPrefix: '/v1',
      contractVersion: '1.0.0',
      eventSchema: 1,
    },
    engine: {
      repository: REPOSITORY.engine,
      commit: ENGINE,
      ref: 'main',
      version: '0.1.0',
      apiContract: '1.0.0',
      sdkVersion: '1.0.0',
      eventSchema: 1,
      sdkArtifact: {
        path: 'release/artifacts/coderax-sdk-1.0.0.tgz',
        sha256: ARTIFACT,
        sha512: ARTIFACT_512,
        integrity: 'sha512-AAAA',
        files: FILES,
      },
      openapi: { path: 'openapi.json', sha256: '1'.repeat(64) },
      migrations: [
        {
          id: 'mongo.work_runs.key',
          collection: 'work_runs',
          operation: 'createIndex',
          keys: { key: 1 },
          unique: true,
          name: 'work_run_key',
          required: true,
          reversible: true,
          rollback: 'drop the index',
        },
      ],
      requiredChecks: [
        {
          workflow: 'verify',
          job: 'verify',
          required: true,
          headSha: ENGINE,
          conclusion: 'success',
          url: 'https://github.com/Auctivon-CoderaxAI/example/actions/runs/1',
          checkedAt: NOW,
        },
      ],
      review: {
        author: 'author',
        reviewer: 'reviewer',
        status: 'approved',
        headSha: ENGINE,
        reviewedAt: NOW,
      },
      deployment: {
        deployed: true,
        origin: 'https://engine.example.com',
        servedCommit: ENGINE,
        healthContractVersion: '1.0.0',
        verifiedAt: NOW,
      },
      rollback: {
        mode: 'pre-cutover-abort',
        targetCommit: null,
        dataDeletion: false,
        contractCompatible: true,
        notes: 'no cutover in this train',
      },
      localVerification: {
        command: 'npm run verify',
        headCommit: ENGINE,
        exitCode: 0,
        tests: 1,
        failures: 0,
        ranAt: NOW,
        path: 'release/evidence/log',
        outputSha256: '2'.repeat(64),
      },
    },
    web: client('web', WEB),
    cli: client('cli', CLI),
    ci: {
      audit: { path: 'release/ci-audit.json', sha256: AUDIT },
      authorizedDeployWorkflows: [],
      ownerSignoffs: [
        {
          repository: REPOSITORY.engine,
          owner: '@owner',
          requiredChecks: ['verify'],
          status: 'signed',
          signedAt: NOW,
        },
        {
          repository: REPOSITORY.web,
          owner: '@owner',
          requiredChecks: ['static-checks'],
          status: 'signed',
          signedAt: NOW,
        },
        {
          repository: REPOSITORY.cli,
          owner: '@owner',
          requiredChecks: ['ci'],
          status: 'signed',
          signedAt: NOW,
        },
      ],
    },
    unpublished: [
      {
        repository: REPOSITORY.engine,
        branch: 'feat/excluded',
        commit: '3'.repeat(40),
        ahead: 1,
        behind: 0,
        disposition: 'excluded',
        summary: 'not part of this train',
        supersededBy: null,
        exclusion: { owner: '@owner', rationale: 'out of scope', recordedAt: NOW },
        evidence: [{ path: 'release/plan.md', line: 1, statement: 'excluded', sha256: '4'.repeat(64) }],
      },
    ],
  };
}

function manifest(): ReleaseManifest {
  return parseReleaseManifest(JSON.stringify(manifestRaw()));
}

function auditReport(): CiAuditReport {
  return {
    schema: 'coderax.ci-audit/1',
    generatedAt: NOW,
    repositories: {
      web: { repository: REPOSITORY.web, commit: WEB, files: [] },
      cli: { repository: REPOSITORY.cli, commit: CLI, files: [] },
    },
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
  };
}

function facts(): ReleaseFacts {
  const value = manifest();
  return {
    headCommit: ENGINE,
    online: true,
    engine: {
      ancestorOfHead: true,
      driftPaths: [],
      dirtyPaths: [],
      version: '0.1.0',
      apiContract: '1.0.0',
      sdkVersion: '1.0.0',
      eventSchema: 1,
      openapiSha256: '1'.repeat(64),
      openapiVersion: '1.0.0',
      artifact: {
        exists: true,
        sha256: ARTIFACT,
        sha512: ARTIFACT_512,
        integrity: 'sha512-AAAA',
        files: [...FILES],
        problems: [],
      },
      localEvidenceSha256: '2'.repeat(64),
      migrations: value.engine.migrations,
      workflowAudits: [],
    },
    web: { role: 'web', commitReachable: true, evidenceProblems: [], liveAudit: null },
    cli: { role: 'cli', commitReachable: true, evidenceProblems: [], liveAudit: null },
    ci: {
      auditReportSha256: AUDIT,
      recorded: auditReport(),
      recomputedSummary: { critical: 0, high: 0, medium: 0, low: 0 },
      auditProblems: [],
    },
    probes: {
      web: {
        attempted: true,
        reachable: true,
        servedCommit: WEB,
        healthContractVersion: '1.0.0',
        problems: [],
      },
      engine: { attempted: true, reachable: true, healthContractVersion: '1.0.0', problems: [] },
    },
  };
}

test('a coherent train passes every matrix row', () => {
  const evaluation = evaluateRelease(manifest(), facts());
  assert.deepEqual(
    evaluation.rows.filter((row) => row.status === 'fail').map((row) => row.id),
    [],
  );
  assert.equal(evaluation.verdict, 'ready');
  assert.equal(evaluation.rows.length, 14);
});

test('a different engine origin for a client blocks compatibility', () => {
  const changed = manifest();
  changed.web.integration.engineOrigin = 'https://other-engine.example.com';
  const evaluation = evaluateRelease(changed, facts());
  assert.equal(evaluation.verdict, 'blocked');
  assert.equal(evaluation.rows.find((row) => row.id === 'web-compatibility')?.status, 'fail');
});

test('a changed SDK artifact hash blocks the release', () => {
  const changedFacts = facts();
  changedFacts.engine.artifact.sha256 = '9'.repeat(64);
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.rows.find((row) => row.id === 'sdk')?.status, 'fail');
});

test('shipped code drift from the audited commit blocks the release', () => {
  const changedFacts = facts();
  changedFacts.engine.driftPaths = ['src/orchestration/service.ts'];
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.rows.find((row) => row.id === 'commits')?.status, 'fail');
});

test('an uncommitted working tree cannot be certified', () => {
  const changedFacts = facts();
  changedFacts.engine.dirtyPaths = [' M src/orchestration/service.ts'];
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.rows.find((row) => row.id === 'commits')?.status, 'fail');
});

test('a required check that is not green at the pinned commit blocks the release', () => {
  const changed = manifest();
  changed.web.requiredChecks[0]!.conclusion = 'failure';
  const evaluation = evaluateRelease(changed, facts());
  assert.equal(evaluation.rows.find((row) => row.id === 'required-checks')?.status, 'fail');
});

test('self-approval is not independent review', () => {
  const changed = manifest();
  changed.cli.review.reviewer = 'author';
  const evaluation = evaluateRelease(changed, facts());
  assert.equal(evaluation.rows.find((row) => row.id === 'review')?.status, 'fail');
});

test('an unpublished integration branch blocks the release', () => {
  const changed = manifest();
  changed.unpublished[0]!.disposition = 'pending-merge';
  changed.unpublished[0]!.exclusion = null;
  const evaluation = evaluateRelease(changed, facts());
  assert.equal(evaluation.rows.find((row) => row.id === 'unpublished-integration')?.status, 'fail');
});

test('a critical CI finding blocks the release', () => {
  const changedFacts = facts();
  const finding: WorkflowAudit = {
    repository: REPOSITORY.web,
    path: '.github/workflows/pr.yml',
    sha256: '0'.repeat(64),
    triggers: ['pull_request'],
    writePermissions: [],
    jobWritePermissions: [],
    secrets: ['MONGO_URI'],
    infraCommands: [],
    findings: [
      {
        rule: 'production-secret-on-pull-request',
        severity: 'critical',
        line: 10,
        message: 'production credential in pull request context',
      },
    ],
  };
  changedFacts.ci.recorded!.repositories.web.files = [finding];
  changedFacts.ci.recomputedSummary = { critical: 1, high: 0, medium: 0, low: 0 };
  changedFacts.ci.recorded!.summary = { critical: 1, high: 0, medium: 0, low: 0 };
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.rows.find((row) => row.id === 'ci-safety')?.status, 'fail');
});

test('an unverified live web health contract blocks deployment readiness', () => {
  const changedFacts = facts();
  changedFacts.probes.web = {
    attempted: true,
    reachable: true,
    servedCommit: WEB,
    healthContractVersion: null,
    problems: ['web /health returned 503'],
  };
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.rows.find((row) => row.id === 'deployment')?.status, 'fail');
});

test('an offline run cannot certify commit reachability or CI safety', () => {
  const changedFacts = facts();
  changedFacts.online = false;
  changedFacts.web.commitReachable = null;
  changedFacts.cli.commitReachable = null;
  const evaluation = evaluateRelease(manifest(), changedFacts);
  assert.equal(evaluation.verdict, 'blocked');
  assert.equal(evaluation.rows.find((row) => row.id === 'commits')?.status, 'fail');
  assert.equal(evaluation.rows.find((row) => row.id === 'ci-safety')?.status, 'fail');
});
