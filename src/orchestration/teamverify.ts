import { createHash } from 'node:crypto';
import type { TeamRecord, TeamVerificationRecord } from '../domain.js';
import { structuralAssessment } from '../agents/native/verify.js';

/**
 * Team completion is decided here, from the engine's own observations.
 *
 * - Structural: every planned member is complete and every completed member has
 *   non-empty evidence in the checkpoint.
 * - Evidence checks: the named member's evidence exists.
 * - Artifact checks: the engine reads the real file, counts bytes and hashes it.
 * - Test checks: the engine reads the stored test result and requires a non-zero
 *   total with zero failures.
 *
 * No code path reads a model's `VERDICT: PASS`. Member text is evidence, never a
 * verdict, so a confident sentence cannot complete a team.
 */
export type ArtifactRead = { bytes: number; sha256: string; text: string } | null;

export async function verifyTeam(input: {
  record: TeamRecord;
  maxArtifactBytes: number;
  read: (path: string) => Promise<ArtifactRead>;
}): Promise<TeamVerificationRecord> {
  const { record } = input;
  const completed = new Set(record.checkpoint.completedMembers);
  const structural = structuralAssessment({
    plan: record.plan,
    completed,
    evidence: record.checkpoint.evidence,
  });

  const checks: TeamVerificationRecord['checks'] = [
    {
      checkId: 'structural',
      kind: 'evidence',
      passed: structural.passed,
      detail: structural.reason,
    },
  ];
  const artifacts: TeamVerificationRecord['artifacts'] = [];

  for (const check of record.checks) {
    if (check.kind === 'evidence') {
      const entry = record.checkpoint.evidence.find((item) => item.stepId === check.memberId);
      const member = record.members.find((item) => item.memberId === check.memberId);
      const passed =
        member?.state === 'completed' &&
        entry !== undefined &&
        entry.output.trim().length > 0 &&
        entry.citation.trim().length > 0;
      checks.push({
        checkId: `evidence:${check.memberId}`,
        kind: 'evidence',
        passed,
        detail: passed
          ? `Member "${check.memberId}" completed with evidence.`
          : `Member "${check.memberId}" has no completed evidence.`,
      });
      continue;
    }

    const artifact = await input.read(check.path);
    if (!artifact) {
      checks.push({
        checkId: `${check.kind}:${check.path}`,
        kind: check.kind,
        passed: false,
        detail: `The engine could not read "${check.path}".`,
      });
      continue;
    }
    if (artifact.bytes > input.maxArtifactBytes) {
      checks.push({
        checkId: `${check.kind}:${check.path}`,
        kind: check.kind,
        passed: false,
        detail: `"${check.path}" exceeds the verification size bound.`,
      });
      continue;
    }
    artifacts.push({ path: check.path, bytes: artifact.bytes, sha256: artifact.sha256 });

    if (check.kind === 'artifact') {
      if (check.sha256 !== undefined && artifact.sha256 !== check.sha256) {
        checks.push({
          checkId: `artifact:${check.path}`,
          kind: 'artifact',
          passed: false,
          detail: `"${check.path}" does not match the declared SHA-256.`,
        });
        continue;
      }
      if (check.minBytes !== undefined && artifact.bytes < check.minBytes) {
        checks.push({
          checkId: `artifact:${check.path}`,
          kind: 'artifact',
          passed: false,
          detail: `"${check.path}" is smaller than the declared minimum.`,
        });
        continue;
      }
      checks.push({
        checkId: `artifact:${check.path}`,
        kind: 'artifact',
        passed: true,
        detail: `"${check.path}" exists (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 12)}…).`,
      });
      continue;
    }

    if (check.sha256 !== undefined && artifact.sha256 !== check.sha256) {
      checks.push({
        checkId: `test:${check.path}`,
        kind: 'test',
        passed: false,
        detail: `"${check.path}" does not match the declared SHA-256.`,
      });
      continue;
    }
    const result = parseTestResult(artifact.text);
    if (!result.ok) {
      checks.push({ checkId: `test:${check.path}`, kind: 'test', passed: false, detail: result.reason });
      continue;
    }
    checks.push({
      checkId: `test:${check.path}`,
      kind: 'test',
      passed: true,
      detail: `"${check.path}" reports ${result.passed} passed, 0 failed of ${result.total}.`,
    });
  }

  const passed = checks.every((check) => check.passed);
  return {
    passed,
    reason: passed
      ? 'Every member completed with evidence and every objective check passed.'
      : (checks.find((check) => !check.passed)?.detail ?? 'Verification failed.'),
    checks,
    artifacts,
  };
}

export function parseTestResult(
  text: string,
): { ok: true; total: number; passed: number } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The test result is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'The test result is not an object.' };
  }
  const record = parsed as { total?: unknown; passed?: unknown; failed?: unknown };
  if (
    typeof record.total !== 'number' ||
    typeof record.passed !== 'number' ||
    typeof record.failed !== 'number' ||
    !Number.isInteger(record.total) ||
    !Number.isInteger(record.passed) ||
    !Number.isInteger(record.failed)
  ) {
    return { ok: false, reason: 'The test result needs integer total, passed and failed counts.' };
  }
  if (record.total <= 0) return { ok: false, reason: 'The test result reports no tests.' };
  if (record.failed !== 0 || record.passed !== record.total) {
    return {
      ok: false,
      reason: `The test result reports ${record.failed} failure(s) of ${record.total}.`,
    };
  }
  return { ok: true, total: record.total, passed: record.passed };
}

export function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
