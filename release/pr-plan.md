# Dependency-linked release changes

Four pull requests across the three existing repositories. Each one is separately
reviewable, separately revertible and linked to the PR it depends on. No PR
combines a contract change, a client switch and a deletion.

`Coderax-WorkflowEngine` is the only repository this workspace can push to. PR-1
is published from the chat branch. PR-2, PR-3 and PR-4 are prepared with exact
base commits, scopes and acceptance checks; they cannot be opened from this
workspace because only the engine repository is connected.

```text
PR-1 engine: release gate + matrix
  |
  +--> PR-2 web: remove production credentials from PR CI
  |      |
  |      +--> PR-3 web: route Work to the engine through @coderax/sdk
  |             |
  +-------------+--> PR-4 CLI: consume the same SDK artifact and engine origin
```

PR-1 and PR-2 are independent of each other in code, but the release train needs
both. PR-3 depends on PR-1's tested artifact and PR-2's CI policy. PR-4 depends
on PR-3's authoritative engine origin so both clients name the same fingerprint.

## PR-1 — engine: release verification system

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Base: `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` (`main`)
- Branch: the chat branch carrying this change
- Scope: `release/**`, `scripts/release/**`, `tests/release/**`,
  `.github/workflows/release-verify.yml`, `package.json`, `.gitignore`
- No change to `src/**`, `packages/**` or `openapi.json`; the audited engine
  surface is byte-identical to the base commit.
- Required checks: `verify` and `release-verify`, both at the pushed head.
- Acceptance:
  - `npm ci && npm run verify` → 142 tests, 0 failures, OpenAPI gate clean.
  - `npm run release:pack` reproduces the committed artifact checksums.
  - `npm run release:verify -- --online` exits non-zero and lists the substantive
    blockers; it does not silently pass.
- Rollback: revert the PR. There is no runtime dependency and no deployment.
- Depends on: nothing.

## PR-2 — web: remove credentials from pull-request CI

- Repository: `Auctivon-CoderaxAI/Coderax`
- Base: `a5d237b0ff672356374849d565363955df69d298`
- Scope: `.github/workflows/backend-review.yml`, `client.yml`,
  `data-provider.yml`, `data-schemas.yml`, `retry-docker-builds.yml`, and the
  engine policy entry that authorizes a release path.
- Change:
  1. Remove `MONGO_URI`, `OPENAI_API_KEY`, `JWT_SECRET`, `CREDS_KEY` and
     `CREDS_IV` from the `pull_request` path of `test-api`. Replace them with
     non-production test values, or split the production-environment run into a
     `push: main` or `workflow_dispatch` job that never checks out pull request
     code.
  2. Keep publish workflows on tag or dispatch triggers only. Name them in the
     engine's `authorizedDeployWorkflows` with a matching CI owner sign-off.
  3. Keep `retry-docker-builds.yml` from checking out or executing artifacts
     produced by an untrusted `workflow_run`.
- Required checks: `static-checks`, `coderax-deployment-readiness`,
  `cloudflare-production`, plus a workflow-policy test that proves no
  `pull_request` job references a production secret.
- Acceptance: `npm run release:audit` against the new head produces zero critical
  and zero high findings; the engine gate re-reads the same workflow hashes and
  agrees.
- Rollback: revert the PR; the previous workflows return. No data change.
- Depends on: PR-1 (the CI policy fields and audit rules).

## PR-3 — web: make the engine authoritative for Work

- Repository: `Auctivon-CoderaxAI/Coderax`
- Base: `a5d237b0ff672356374849d565363955df69d298` plus PR-2
- Scope: `worker/**`, `wrangler.jsonc`, the API proxy configuration, the Work
  client flag, and the dependency on the pinned SDK artifact.
- Change:
  1. Install `@coderax/sdk` from the artifact pinned in `release/train.json`
     (`release/artifacts/coderax-sdk-1.0.0.tgz`, SHA-256
     `88d2b5da…b3eb7a2`), not from a floating range and not from a copied DTO.
  2. Route Work submission, status and events for **new** tasks to the engine
     `/v1/work` surface through a dedicated engine origin. Keep the legacy
     `/api/work` path for existing tasks until Phase 9.
  3. Record the engine origin fingerprint once and pass the same value to the
     CLI release. Both clients must name it in their integration record.
  4. Keep Chat on its current path until Phase 7 parity; do not run two engines
     for the same conversation.
- Required checks: `static-checks`, `coderax-deployment-readiness`,
  `cloudflare-production`, and an end-to-end test that submits Work through the
  web path and reads the terminal task state and sequenced events from the
  engine.
- Acceptance:
  - Web health reports `contractVersion: 1.0.0` from the engine, not a cached
    literal.
  - A task completes while no browser is connected.
  - The served commit equals the pinned web commit.
  - The engine gate's web row becomes PASS with the same origin as the CLI.
- Rollback: flip the client flag back to `/api/work`; new engine tasks remain
  readable through the engine API and are not deleted.
- Depends on: PR-1 (artifact and matrix), PR-2 (CI policy).

## PR-4 — CLI: consume the same SDK and engine origin

- Repository: `Auctivon-CoderaxAI/CoderaxCLI`
- Base: `1b7c8e0a429755502f7563b16a8a09db899452d8`
- Scope: `src/config.js`, `src/client.js`, `src/product-commands.js`,
  `docs/CONTRACT.md`, `package.json`, `.github/workflows/ci.yml`.
- Change:
  1. Add `@coderax/sdk` from the same checksum-pinned artifact.
  2. Default Work to the engine `/v1/work` surface and the same engine origin as
     PR-3. Keep the OpenAPI discovery commands for the legacy deployment.
  3. Add `coderax doctor --json` reporting the engine origin and the
     `contractVersion` observed from `/v1/health`.
  4. Add `.github/CODEOWNERS` naming a CI owner; the repository currently has
     none, so its sign-off is recorded against the repository owner.
- Required checks: `ci`, plus a test that the Work command sends the SDK contract
  and refuses a mismatched contract version.
- Acceptance: `coderax doctor --json` against the deployed engine reports
  `contractVersion 1.0.0`; the CLI integration record in the engine manifest
  names the same origin and SDK artifact SHA-256 as the web.
- Rollback: reinstall the previous CLI release; it talks to the legacy
  deployment and is unaffected by the engine.
- Depends on: PR-1 (artifact), PR-3 (shared origin and contract).

## CI owner decisions required

| Repository | Owner | Decision |
| --- | --- | --- |
| Coderax-WorkflowEngine | `@nnabdelshahid` (CODEOWNERS) | Approve `verify` and `release-verify` as required checks at the exact head; confirm a zero-cost runner path because hosted Actions is billing-blocked. |
| Coderax | `@nnabdelshahid` (CODEOWNERS) | Remove the five production credentials from pull-request context; authorize the tag/dispatch publish workflows; sign the CI policy record. |
| CoderaxCLI | Repository owner (no CODEOWNERS) | Add a code owner, confirm `ci` is the required check, and sign the CI policy record. |

## Cutover rule

No production cutover until:

- all 14 matrix rows are PASS at the pinned commits;
- each component has an independent approval at its pinned head;
- the engine health endpoint reports contract `1.0.0` at the same origin both
  clients name;
- the CI audit has zero critical and zero high findings;
- the rollback target for each changed component is an immutable commit and
  deletes no data.

The verifier has no override. A blocked verdict stays blocked until the evidence
changes.
