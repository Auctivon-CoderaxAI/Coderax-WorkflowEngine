import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditWorkflow,
  compareAudits,
  countFindings,
  parseTriggers,
  parseWritePermissions,
} from '../../scripts/release/audit.js';

const REPO = 'Auctivon-CoderaxAI/Coderax';

function audit(text: string, authorized = false) {
  return auditWorkflow({ repository: REPO, path: '.github/workflows/x.yml', text, authorized });
}

test('a production credential on a pull request is critical', () => {
  const result = audit(`
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      MONGO_URI: \${{ secrets.MONGO_URI }}
    steps:
      - run: npm test
`);
  assert.ok(result.findings.some((finding) => finding.severity === 'critical'));
  assert.ok(result.secrets.includes('MONGO_URI'));
  assert.deepEqual(result.triggers, ['pull_request']);
});

test('a third-party service key on a pull request is reported, not called a production credential', () => {
  const result = audit(`
name: test
on: [pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      CODEGRAPH_TOKEN: \${{ secrets.CODEGRAPH_TOKEN }}
    steps:
      - run: npm test
`);
  const finding = result.findings.find((entry) => entry.rule === 'service-secret-on-pull-request');
  assert.equal(finding?.severity, 'medium');
  assert.ok(!result.findings.some((entry) => entry.severity === 'critical'));
});

test('a tag-gated job write scope is not treated as a workflow-wide pull-request grant', () => {
  const result = audit(`
name: desktop
on:
  pull_request:
  push:
    tags: ['desktop-v*']
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  release:
    if: startsWith(github.ref, 'refs/tags/')
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - run: gh release create desktop-v1
`);
  assert.deepEqual(result.writePermissions, []);
  assert.deepEqual(result.jobWritePermissions, ['contents']);
  assert.ok(!result.findings.some((finding) => finding.rule === 'infrastructure-write-on-pull-request'));
  assert.ok(result.findings.some((finding) => finding.rule === 'job-write-on-pull-request'));
  // The release command is still fail-closed: a pull-request-triggered workflow
  // that contains a release command needs to be split or reviewed.
  assert.ok(result.findings.some((finding) => finding.rule === 'infrastructure-mutation-on-pull-request'));
});

test('a workflow-level write scope on a pull request is critical', () => {
  const result = audit(`
name: dangerous
on:
  pull_request:
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: git push
`);
  assert.ok(result.findings.some((finding) => finding.severity === 'critical'));
});

test('pull_request_target is always critical', () => {
  const result = audit(`
name: dangerous
on:
  pull_request_target:
    types: [opened]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
  assert.ok(result.findings.some((finding) => finding.rule === 'pull-request-target' && finding.severity === 'critical'));
});

test('a commented deploy command is documentation, not a finding', () => {
  const result = audit(`
name: verify
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      # This workflow never runs: wrangler deploy
      - run: echo verified
`);
  assert.deepEqual(result.infraCommands, []);
  assert.equal(result.findings.filter((finding) => finding.severity === 'high').length, 0);
});

test('an active deploy on a release path needs owner authorization', () => {
  const unauthorized = audit(`
name: deploy
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler deploy
`);
  assert.ok(unauthorized.findings.some((finding) => finding.rule === 'infrastructure-mutation' && finding.severity === 'high'));

  const authorized = audit(
    `
name: deploy
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler deploy
`,
    true,
  );
  assert.ok(!authorized.findings.some((finding) => finding.severity === 'high'));
});

test('an action referenced by tag is not a full-SHA pin', () => {
  const result = audit(`
name: test
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@11bd71901bbe5b1630ceea73d27597364c9af683
`);
  const unpinned = result.findings.filter((finding) => finding.rule === 'unpinned-action');
  assert.equal(unpinned.length, 1);
  assert.match(unpinned[0]!.message, /actions\/checkout@v4/);
});

test('workflow triggers parse block and inline forms', () => {
  assert.deepEqual(parseTriggers('on:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n'), [
    'push',
    'pull_request',
  ]);
  assert.deepEqual(parseTriggers('on: [push, pull_request]\n'), ['push', 'pull_request']);
});

test('permissions parse separates workflow scope from job scope', () => {
  assert.deepEqual(parseWritePermissions('permissions:\n  contents: read\njobs:\n  j:\n    permissions:\n      contents: write\n'), {
    workflow: [],
    job: ['contents'],
  });
});

test('a changed workflow or finding makes the recorded audit stale', () => {
  const text = `
name: test
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const recorded = {
    repository: REPO,
    commit: 'a'.repeat(40),
    files: [auditWorkflow({ repository: REPO, path: '.github/workflows/x.yml', text })],
  };
  const same = structuredClone(recorded);
  assert.deepEqual(compareAudits(recorded, same), []);

  const changed = structuredClone(recorded);
  changed.files[0]!.sha256 = 'b'.repeat(64);
  assert.match(compareAudits(recorded, changed).join('\n'), /changed after the audit/);
});

test('countFindings counts every severity once', () => {
  const result = audit(`
name: test
on: [pull_request]
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      JWT_SECRET: \${{ secrets.JWT_SECRET }}
    steps:
      - uses: actions/checkout@v4
`);
  const summary = countFindings([result]);
  assert.ok(summary.critical >= 2);
  assert.equal(summary.medium, 1);
});
