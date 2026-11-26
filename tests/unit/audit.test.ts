import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditFromResult } from '../../scripts/gate/audit.js';

/**
 * The audit gate must fail closed.
 *
 * A dependency scan is evidence only when npm completed it and returned
 * metadata. A missing executable, unreadable output, registry error or absent
 * metadata block is a finding, never a clean pass; a high or critical advisory
 * is always fatal. These fixtures pin each path so a refactor cannot turn a
 * broken scan into a green gate.
 */

test('a failed npm spawn is a finding, not a pass', () => {
  const result = auditFromResult({ error: new Error('spawn npm ENOENT') });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.rule, 'audit-unavailable');
  assert.match(result.findings[0]?.detail ?? '', /spawn npm ENOENT/);
});

test('unreadable output fails closed and reports a redacted first stderr line', () => {
  const result = auditFromResult({
    stdout: 'not json at all',
    stderr: [
      'npm error //registry.npmjs.org/:_authToken=super-secret-token npm_abcdefghijklmnopqrstuvwxyz',
      'npm error second line is not reported',
    ].join('\n'),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.rule, 'audit-unreadable');
  const detail = result.findings[0]?.detail ?? '';
  assert.match(detail, /refusing to pass/);
  assert.match(detail, /\[redacted\]/);
  assert.doesNotMatch(detail, /super-secret-token/);
  assert.doesNotMatch(detail, /npm_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(detail, /second line/);
});

test('a truncated JSON object fails closed', () => {
  const result = auditFromResult({ stdout: '{"metadata":' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.rule, 'audit-unreadable');
});

test('a registry error object fails closed with its summary', () => {
  const result = auditFromResult({
    stdout: JSON.stringify({
      error: { summary: 'audit endpoint returned 503', detail: 'try later' },
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.rule, 'audit-registry');
  assert.match(result.findings[0]?.detail ?? '', /audit endpoint returned 503/);
});

test('a vulnerability map without metadata is not evidence of a clean scan', () => {
  const result = auditFromResult({
    stdout: JSON.stringify({
      vulnerabilities: {
        'left-pad': { severity: 'high', via: [{ title: 'Prototype pollution' }] },
      },
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.rule, 'audit-no-metadata');
});

test('a completed clean scan passes even when npm prints a notice first', () => {
  const result = auditFromResult({
    stdout: [
      'npm notice New minor version of npm available',
      JSON.stringify({
        vulnerabilities: {},
        metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
      }),
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.detail ?? '', /critical=0 high=0 moderate=0 low=0 info=0/);
});

test('high and critical advisories are fatal while a moderate one is reported', () => {
  const result = auditFromResult({
    stdout: JSON.stringify({
      vulnerabilities: {
        'left-pad': { severity: 'high', via: [{ title: 'Prototype pollution' }] },
        'old-lib': { severity: 'critical', via: ['Direct dependency vulnerability'] },
        'tiny-lib': { severity: 'moderate', via: [{ title: 'ReDoS' }] },
      },
      metadata: { vulnerabilities: { critical: 1, high: 1, moderate: 1, low: 0, info: 0 } },
    }),
  });
  assert.deepEqual(
    result.findings.map((finding) => finding.rule).sort(),
    ['audit-critical', 'audit-high'],
  );
  assert.ok(result.findings.some((finding) => finding.detail.includes('left-pad')));
  assert.ok(result.findings.some((finding) => finding.detail.includes('old-lib')));
  assert.ok(!result.warnings.some((warning) => warning.rule === 'audit-summary'));
});

test('moderate and low advisories warn but do not fail the gate', () => {
  const result = auditFromResult({
    stdout: JSON.stringify({
      vulnerabilities: {
        'tiny-lib': { severity: 'moderate', via: [{ title: 'ReDoS' }] },
        'old-shim': { severity: 'low', via: ['Transitive dependency'] },
      },
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 1, low: 1, info: 0 } },
    }),
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.rule).sort(),
    ['audit-low', 'audit-moderate', 'audit-summary'],
  );
});
