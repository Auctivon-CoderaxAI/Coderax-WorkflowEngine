# Acceptance record — 2026-11-26

## Published integration head

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Base: `main` at `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`
- Branch: `ci/permanent-quality-gates`
- Exact verified head: the branch head at the time of each clean-lockfile run;
  the remote SHA is recorded in the final handoff. Later docs-only commits do
  not change the verified code.
- Compare: https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine/compare/main...ci/permanent-quality-gates
- The branch is 5 commits ahead and 0 behind. The parallel
  `ci/permanent-quality-gate` branch remains at `21015a7f7484dda8a6b9951e52782a8bd8921d01`
  and was not overwritten.

## Exact-head local acceptance

Command: `npm run verify` with `CODERAX_TEST_MONGO_URI` pointing at a disposable
real MongoDB started for this run. Exit status: 0. The same command was re-run
at the final branch head (a docs-only commit) with the same result.

| Gate | Tests | Result |
| --- | --- | --- |
| unit | 90 | 90 passed |
| integration (fake Mongo labelled) | 9 | 9 passed |
| security | 22 | 22 passed |
| adversarial | 19 | 19 passed |
| contract | 13 | 13 passed |
| architecture | 40 | 40 passed |
| artifacts | 7 | 7 passed |
| e2e | 3 | 3 passed |
| audit | command | 0 critical, 0 high, 0 moderate, 0 low, 0 info |
| openapi | command | `openapi.json` matches contracts |
| mongo-live (real database) | 6 | 6 passed, 0 skipped |

Gate manifest: 34 test files assigned, none unclaimed. The live gate forces
`CODERAX_REQUIRE_MONGO=1`; with no URI it exits 1 with six explicit
`CODERAX_TEST_MONGO_URI must name a reachable MongoDB` failures and zero skips.

Shutdown stability: the fixed live suite was run 16 times consecutively after
the drain change (plus the preceding 8-run check), with 6/6 passing every time.
The change tracks fenced checkpoint writes in `execute()` and drains them before
shutdown, so a Mongo client is not closed under an in-flight write.

Additional cross-branch evidence: the durable-artifacts branch at
`fd5edef2a2cfc83850fa43b19a813676c352bb92` ran its five real-Mongo concurrency
tests against a disposable server in its own detached worktree: 5 passed, 0
failed, 0 skipped. It was not merged or modified.

## Architecture compatibility

The exact-SHA matrix is in [`architecture-ownership.md`](architecture-ownership.md).
It covers PR #2/#3/#4/#5/#7/#8/#9 and the relevant durable, multimodal, gaming,
read-model, persistence, operability, contract, security and CI branches. The
static probe is not a substitute for each owner's full CI.

## Hosted CI, PR and approval state

- `main` is protected with required status-check context `verify` (read-only API
  observation). No protection setting was changed.
- The required `verify` job now owns the pinned `mongo:7.0.14` service and the
  `mongo-live` step, so the protected check cannot pass without real-database
  evidence.
- There is no pull request for this branch. The read-only compare API reports
  zero workflow runs at `c6e022e`; GitHub Actions only runs this workflow on pull
  requests and pushes to `main`.
- Creating the PR requires an authorized GitHub write integration. This host has
  no `gh` binary and no GitHub write credential; the unauthenticated API cannot
  create a pull request. No PR, no self-approval and no review were fabricated.
- The detailed protection endpoint returned HTTP 401, so required reviewer count,
  dismissal rules and bypass actors remain unverified. Independent approval is
  outstanding.

## Cross-repository boundary

Coderax and CoderaxCLI are not present in this workspace and no authorized
integration was available to read their exact heads. The repository gate proves
its own route catalogue, OpenAPI document, SDK operation map and runtime
contracts; it cannot certify a consumer repository or its release. The ecosystem
release owner must run the consumer-side compatibility gate against this exact
head and record that result separately.

## Cost and safety

All testing used local cloud resources, the standard GitHub-hosted runner
definition, and a disposable MongoDB. No paid runner, database, inference or new
Vercel dependency was used. No production database, credential or owner data was
connected. No direct main push, force push or repository-setting change was made.
