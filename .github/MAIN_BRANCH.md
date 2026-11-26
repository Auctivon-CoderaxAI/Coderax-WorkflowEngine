# Main branch protection and releases

`main` is this repository's only persistent branch and the target for every pull
request. There is no `dev`, `canary` or promotion branch, and none should be
recreated. Feature branches are short-lived, exist only for the pull request they
carry, and are deleted after merge. [`AGENTS.md`](../AGENTS.md) is the contributor
policy; this page records the platform setup that policy depends on.

## Required protection (administrator)

Configure rulesets/branch protection for `main` with:

- Every change through a pull request; direct pushes denied, including for
  administrators.
- At least one independent approval, with approval of the most recent reviewable
  push by someone other than its author and stale approvals dismissed when the
  pull request changes.
- Required status checks for the `verify` workflow, evaluated at the exact head
  SHA. A passing run at an earlier head is not a pass.
- Code-owner review for `.github/workflows/`, `.github/CODEOWNERS` and
  `packages/contracts/`.
- All review threads resolved before merge.
- Force pushes and branch deletion disallowed.
- No administrator override, self-approval or force-merge.

`.github/CODEOWNERS` requests review from `@nnabdelshahid` for the whole
repository. With a sole code owner, that owner's own pull requests cannot satisfy
a code-owner requirement; an additional eligible owner is needed if those changes
are to merge through the normal path.

Where the hosting plan cannot enforce a rule, record the equivalent review step in
the pull request instead of claiming platform enforcement. Do not relax the
remaining rules to compensate.

**Verified on 2026-11-26:** this repository's plan returns HTTP 403 for both
`branches/main/protection` and `rulesets` ("Upgrade to GitHub Pro or make this
repository public"). Protection is therefore not enforceable here; the equivalent
process policy, the zero-cost reviewer options and the CI options are recorded in
[`docs/governance.md`](../docs/governance.md).

## Releases

Releases are cut from a reviewed `main` commit by pushing a `v<semver>` tag. A
release is only meaningful after the engine is deployed and verified; tagging is
not deployment evidence. Never move a tag or force-push `main`. Roll back code
with a new reviewed revert pull request.

## Verification gate

`npm run verify` must pass at the pushed head:

```bash
npm ci
npm run verify
```

Hosted CI is subject to the owner's Actions minute allowance. When hosted jobs
cannot start, run the same command locally, paste the result into the pull
request, and say plainly that hosted CI did not run. Do not purchase minutes.
