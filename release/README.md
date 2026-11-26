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
FAIL with 57 explicit blockers**. Those blockers are listed below; the command
reproduces them from the pinned commits.

Last evaluated on 2026-11-26 at `87a765b73ade337917e463aa7ce785d7c900c195`:

| Component | Pinned commit | Version |
| --- | --- | --- |
| Coderax-WorkflowEngine | `9a386db9ff4970f59a300f5eb3d5f5b1627ef9b6` (contract commit; `HEAD` is a descendant) | `0.2.0`, contract `1.1.0`, SDK `1.1.0`, events `1` |
| Coderax (web) | `a5d237b0ff672356374849d565363955df69d298` | `v0.8.8` |
| CoderaxCLI | `1b7c8e0a429755502f7563b16a8a09db899452d8` | `0.1.0` |

| Matrix entry | State | Evidence |
| --- | --- | --- |
| Repository commit SHAs | **PASS** | three full 40-character SHAs; engine base is an ancestor of `HEAD`; shipped `src`, `packages`, `openapi.json` are byte-identical to the audited commit; working tree required clean |
| Engine version | **PASS** | `package.json` `0.2.0` |
| API contract version | **PASS** | `CONTRACT_VERSION = 1.1.0`; `openapi.json` `info.version = 1.1.0` |
| SDK version | **PASS** | `@coderax/sdk@1.1.0`; the canonical 14-file tarball matches its SHA-256, SHA-512 and integrity |
| Event schema version | **PASS** | `EVENT_SCHEMA_VERSION = 1` |
| Web compatibility | **FAIL** | Coderax `main` does not consume `@coderax/sdk`; its open gateway branch `feat/workflow-engine-gateway-v1@19bdb150` mirrors contract `1.0.0` with 17 operation ids and is not merged |
| CLI compatibility | **FAIL** | CoderaxCLI `main` targets a Coderax deployment (`/api/ask/agents`, `/api/work/chat`), not the engine `/v1` API; PR #5 and PR #6 add a private `packages/workflow-sdk` for that other API |
| Database migration requirements | **PASS** | all 26 additive, reversible indexes created by the engine's `ensure*Indexes` functions are declared, including execution events and their generation heads; the coupling test compares the full set, not a subset |
| Required GitHub Actions checks | **FAIL** | no successful run recorded at any pinned SHA; hosted Actions is billing-blocked on the engine; client conclusions are unknown |
| Independent review status | **FAIL** | no independent approval for any of the three commits |
| Deployment readiness | **FAIL** | engine is not deployed; live web `/health` returns `503 API proxy is not configured`; no CLI release |
| Rollback compatibility | **PASS** | pre-cutover abort for all three; no rollback path deletes data |
| Unpublished integration commits | **FAIL** | eight engine branches are unmerged; three are reserved by a named owner, five are pending a merge or an owner exclusion |
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

Seven engine branches are not ancestors of `main`. The durable-events
integration was merged into this integration branch; the remaining inventory is:

| Branch | Commit | Ahead/behind | Disposition |
| --- | --- | --- | --- |
| `feat/durable-events` | `9b3fd7d` | 8 / 1 | superseded by `2554edc` (base64 snapshot carrier; `2554edc` is merged here) |
| `feat/intelligence-core` | `24c90e0` | 7 / 0 | pending merge or owner exclusion (PR #2 head `e14e4b7`) |
| `feat/native-reasoning-planner` | `c241bae` | 4 / 0 | pending merge or owner exclusion (PR #3) |
| `feat/zero-cost-model-router` | `43f3581` | 3 / 0 | pending merge or owner exclusion (PR #4) |
| PR #7 (`origin/pr/7`) | `9b4cb5c` | 4 / 0 | superseded by `ea66028`; alternate operation ids are not republished |
| PR #8 (`origin/pr/8`) | `ffec08f` | 13 / 0 | pending merge; reserves the six team operations |
| PR #9 (`origin/pr/9`) | `d1f4b50` | 2 / 0 | pending merge; reserves seven schedule operations |

Measured with `git merge-tree`, the integration branch conflicts with
`feat/intelligence-core` in `packages/contracts/src/routes.ts`,
`src/bootstrap/compose.ts`, `src/bootstrap/container.ts`,
`src/orchestration/service.ts` and `docs/parity-matrix.md`. The merged
durable-events integration adds `POST /v1/notifications/read` and an SDK method;
it does not bump
`CONTRACT_VERSION` or `EVENT_SCHEMA_VERSION`, which is allowed for an additive
operation but must be reconciled before the contract surface is frozen.

`release/train.json` names each branch and commit. A pending branch blocks the
release until it is merged or an owner records an exclusion with a rationale.

### 4. Checks, reviews and deployment

The engine has never had a successful hosted Actions run; the repository's
`docs/governance.md` records the billing restriction. A local `npm run verify`
run at `9a386db` passed 177 tests with zero failures against a real MongoDB; its
log is committed at `release/evidence/engine-verify-9a386db-merged.log` and its
SHA-256 is pinned in the manifest. A local run is evidence, not a substitute for the required hosted
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

The engine creates 26 indexes across 12 collections: `work_runs`, `tasks`,
`idempotency`, `conversations`, `messages`, `memory`, `notifications`,
`permissions`, `schedules`, `artifacts`, `events` and `event_heads`. They cover
lease arbitration, task and transcript lookup, idempotency, memory partitions,
notifications, approvals, schedules, artifact metadata, and the durable event
stream (`event_task_seq` and `event_task_id` unique; `event_head_task` unique).
Every entry is additive and reversible; dropping one deletes no data. The
requirement is coupled to the actual bootstrap by
`tests/release/evidence.test.ts`, which executes every `ensure*Indexes` function
and compares the complete created set with the matrix, so the matrix cannot
claim a migration the engine does not apply or omit one it does.

## What would make this train ready

1. Merge or exclude the remaining pending engine branches
   (`feat/intelligence-core`, `feat/native-reasoning-planner`,
   `feat/zero-cost-model-router`, PR #8, PR #9), then re-stamp the manifest at
   the resulting `main` commit.
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
