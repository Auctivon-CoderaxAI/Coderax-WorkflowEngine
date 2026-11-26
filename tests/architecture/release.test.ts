import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptsContractRange,
  checkRelease,
  compareReleaseManifests,
} from '../../scripts/gate/release.js';

test('the workspace packages are release-compatible with the contract version', () => {
  assert.deepEqual(checkRelease().findings, []);
});

test('the release gate rejects version drift, source packing and a broken SDK range', () => {
  const findings = compareReleaseManifests(
    {
      name: '@coderax/contracts',
      version: '1.0.0',
      private: true,
      files: ['dist'],
      dependencies: { zod: '^3.25.67' },
    },
    {
      name: '@coderax/sdk',
      version: '2.0.0',
      private: true,
      files: ['src'],
      dependencies: { '@coderax/contracts': '^2.0.0' },
    },
  );
  assert.ok(findings.some((finding) => finding.rule === 'release-version'));
  assert.ok(findings.some((finding) => finding.rule === 'release-files'));
  assert.ok(findings.some((finding) => finding.rule === 'release-contracts-range'));
});

test('the SDK range check understands workspace, caret, tilde and exact ranges', () => {
  assert.equal(acceptsContractRange('*', '1.0.0'), true);
  assert.equal(acceptsContractRange('workspace:*', '1.0.0'), true);
  assert.equal(acceptsContractRange('^1.0.0', '1.4.2'), true);
  assert.equal(acceptsContractRange('~1.0.0', '1.0.9'), true);
  assert.equal(acceptsContractRange('1.0.0', '1.0.0'), true);
  assert.equal(acceptsContractRange('^2.0.0', '1.0.0'), false);
  assert.equal(acceptsContractRange('~1.1.0', '1.0.9'), false);
  assert.equal(acceptsContractRange('not-a-range', '1.0.0'), false);
});
