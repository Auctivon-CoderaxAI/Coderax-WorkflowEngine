# Coordinated release verification

This directory is the release gate for the three existing Coderax repositories.
It is evidence, not a proposal: `release/train.json` pins the exact commits,
versions, migrations, checks, reviews and deployment state, and
`npm run release:verify -- --online` re-reads the repositories and refuses a
release that is not compatible.

The matrix is deliberately limited to `Coderax-WorkflowEngine`, `Coderax` and
`CoderaxCLI`. A fourth repository is not representable in the schema.

## Current verdict: BLOCKED

No production cutover has been performed and this tooling cannot perform one.
It never deploys, never reads a production secret and has read-only permissions.

The online run of `npm run release:verify -- --online` reports **7 PASS and 7
FAIL with 55 explicit blockers**. Those blockers are listed below; the command
reproduces them from the pinned commits.

Verified on 2026-11-26 against:

| Component | Pinned commit | Version |
| --- | --- | --- |
| Coderax-WorkflowEngine | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` | `0.1.0`, contract `1.0.0`, SDK `1.0.0`, events `1` |
| Coderax (web) | `a5d237b0ff672356374849d565363955df69d298` | `v0.8.8` |
| CoderaxCLI | `1b7c8e0a429755502f7563b16a8a09db899452d8` | `0.1.0` |

| Matrix entry | State | Evidence |
| --- | --- | --- |
| Repository commit SHAs | **PASS** | three full 40-character SHAs; engine base is an ancestor of `HEAD`; shipped `src`, `packages`, `openapi.json` are byte-identical to the audited commit; working tree required clean |
| Engine version | **PASS** | `package.json` `0.1.0` |
| API contract version | **PASS** | `CONTRACT_VERSION = 1.0.0`; `openapi.json` `info.version = 1.0.0` |
| SDK version | **PASS** | `@coderax/sdk@1.0.0`; checksum-verified artifact |
| Event schema version | **PASS** | `EVENT_SCHEMA_VERSION = 1` |
| Web compatibility | **FAIL** | Coderax does not consume `@coderax/sdk`; it proxies only `/api`, `/oauth` and health to `CODERAX_API_ORIGIN` |
| CLI compatibility | **FAIL** | CoderaxCLI targets a Coderax deployment (`/api/ask/agents`, `/api/work/chat`), not the engine `/v1` API |
| Database migration requirements | **PASS** | two additive, reversible `work_runs` indexes; a test proves they equal `ensureWorkRunIndexes` |
| Required GitHub Actions checks | **FAIL** | no successful run recorded at any pinned SHA; hosted Actions is billing-blocked on the engine; client conclusions are unknown |
| Independent review status | **FAIL** | no independent approval for any of the three commits |
| Deployment readiness | **FAIL** | engine is not deployed; live web `/health` returns `503 API proxy is not configured`; no CLI release |
| Rollback compatibility | **PASS** | pre-cutover abort for all three; no rollback path deletes data |
| Unpublished integration commits | **FAIL** | four engine branches are unmerged; the durable-events integration is pending a merge or owner exclusion |
| Cross-repository CI credential safety | **FAIL** | five production credentials are exposed to a pull-request-triggered job in Coderax; four release-path findings; no CI owner sign-off |

`npm run release:verify -- --online` prints the full blocker list. The current
blockers are substantive, not configuration noise:

### 1. Web and CLI do not talk to the WorkflowEngine

`Coderax@a5d237b`:

- `worker/index.mjs:162` reads `CODERAX_API_ORIGIN` and proxies `/api` traffic to
  the legacy OCI backend.
- `wrangler.jsonc:20` runs the Worker first only for `/api`, `/oauth` and health.
- `api/server/index.js:512` mounts Work than the legacy `/api/work` route.
- There is no `@coderax/sdk` dependency or import in the repository.

`CoderaxCLI@1b7c8e0`:

- `src/config.js:15` defaults to `/api/ask/agents`.
- `src/product-commands.js:219` calls `/api/work/chat`.
- `docs/CONTRACT.md:3` targets a Coderax deployment's OpenAPI document.
- There is no `@coderax/sdk` dependency or import in the repository.

Both clients therefore talk to the same **legacy** Coderax API. Neither talks to
the same authoritative WorkflowEngine, so the requirement is not satisfied.

The live web origin was probed read-only: `/deployment.json` returns commit
`a5d237b0ff672356374849d565363955df69d298`, and `/health` returns
`503 {"error":"API proxy is not configured"}`. A served revision is not a working
deployment.

### 2. CI can expose production credentials

`Coderax/.github/workflows/backend-review.yml` runs on `pull_request` and
`test-api` receives `MONGO_URI`, `OPENAI_API_KEY`, `JWT_SECRET`, `CREDS_KEY` and
`CREDS_IV` in its job environment. The workflow restricts some jobs to
same-repository branches, but pull request code still executes with those
credentials available. This is the exact pattern the release policy forbids.

Four high findings remain: three `npm publish` release paths with no recorded CI
owner authorization (`client.yml`, `data-provider.yml`, `data-schemas.yml`) and a
privileged `workflow_run` workflow (`retry-docker-builds.yml`). The full record,
including 230 medium unpinned-action findings, is `release/ci-audit.json`.

The engine's own workflows are audited live on every run. The new
`release-verify.yml` is SHA-pinned, read-only, secret-free and never deploys.

### 3. Unpublished integration commits

Five engine branches are not ancestors of `main`:

| Branch | Commit | Ahead/behind | Disposition |
| --- | --- | --- | --- |
| `feat/durable-events-integration` | `2554edc` | 2 / 0 | pending merge or owner exclusion |
| `feat/durable-events` | `9b3fd7d` | 8 / 1 | superseded by `2554edc` (base64 snapshot carrier) |
| `feat/intelligence-core` | `c8f9a34` | 3 / 0 | pending merge or owner exclusion |
| `feat/native-reasoning-planner` | `efd760a` | 2 / 0 | pending merge or owner exclusion |
| `feat/zero-cost-model-router` | `7ae5cbc` | 1 / 0 | pending merge or owner exclusion |

Measured with `git merge-tree`, the integration branch conflicts with
`feat/intelligence-core` in `packages/contracts/src/routes.ts`,
`src/bootstrap/compose.ts`, `src/bootstrap/container.ts`,
`src/orchestration/service.ts` and `docs/parity-matrix.md`. It conflicts with the
other two branches only in `docs/parity-matrix.md`. The integration branch adds
`POST /v1/notifications/read` and an SDK method; it does not bump
`CONTRACT_VERSION` or `EVENT_SCHEMA_VERSION`, which is allowed for an additive
operation but must be reconciled before the contract surface is frozen.

`release/train.json` names each branch and commit. A pending branch blocks the
release until it is merged or an owner records an exclusion with a rationale.

### 4. Checks, reviews and deployment

The engine has never had a successful hosted Actions run; the repository's
`docs/governance.md` records the billing restriction. A local `npm run verify`
run at `808dfd3` passed 108 tests with zero failures; its log is committed at
`release/evidence/engine-verify-808dfd3.log` and its SHA-256 is pinned in the
manifest. A local run is evidence, not a substitute for the required hosted
check. No independent reviewer is installed, and no component has an approval.
The engine is not deployed. These are recorded as FAIL, not waived.

## The gate

```bash
npm run release:verify -- --online
```

- `--online` is required for a release. It fetches each pinned client commit,
  re-hashes the cited evidence, re-audits every client workflow and probes the
  live web origin and the authoritative engine origin.
- `npm run release:pack` rebuilds the SDK, packs the built `dist` surface,
  verifies npm's integrity, and pins the SHA-256, SHA-512, integrity and file
  list in `release/train.json`. The committed tarball is checksum-verified by the
  test suite and by the gate.
- `npm run release:audit -- --web <checkout> --cli <checkout>` regenerates
  `release/ci-audit.json` at the pinned commits. The gate re-clones the same
  commits and refuses a report whose file hashes or findings differ.

A release is `ready` only when every row is PASS. The tool has no `--force`, no
waiver path and no deploy command.

## Database requirement

The engine creates two indexes on the `work_runs` collection:
`work_run_key` (unique, the arbiter of a concurrent claim) and
`work_run_expires` (the bounded sweep). Both are additive and reversible;
dropping either deletes no data. The requirement is coupled to the actual
bootstrap by `tests/release/evidence.test.ts`, so the matrix cannot claim a
migration the engine does not apply.

## What would make this train ready

1. Merge or exclude the four pending engine branches, then re-stamp the manifest
   at the resulting `main` commit.
2. Move the five production credentials out of the pull-request-triggered Coderax
   job, split release-only publish workflows, and have each CI owner record a
   sign-off and the authorized release paths.
3. Land the dependency-linked client PRs in `release/pr-plan.md`; both clients
   must consume the same checksum-pinned SDK artifact and name the same engine
   origin.
4. Deploy the engine, probe `/v1/health` for contract `1.0.0`, and record the
   served commit and timestamp.
5. Record a successful required check at each pinned commit and an independent
   approval whose head SHA matches that commit.

Until all five are true, the verdict is BLOCKED and no cutover is authorized.

## Limits

- Hosted GitHub Actions cannot run on the engine repository while the account is
  billing-restricted. The workflow exists so the check is defined; it is recorded
  as `not-run`, not as a pass.
- The web and CLI repositories are read over HTTPS at pinned commits. This chat
  has push access only to `Coderax-WorkflowEngine`, so the client PRs in
  `release/pr-plan.md` are prepared, not opened.
- The live probes are read-only GETs. They prove what the web origin serves and
  whether health reports a contract version; they do not exercise an
  authenticated Work task.
