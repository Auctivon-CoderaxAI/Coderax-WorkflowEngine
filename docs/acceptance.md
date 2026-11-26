# Acceptance record — 2026-11-26

## Candidate integration head

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Base: `main` at `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`
- Branch: `ci/permanent-quality-gates`
- Compare: https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine/compare/main...ci/permanent-quality-gates
- The surviving implementation is this branch. The parallel
  `ci/permanent-quality-gate` branch remains at
  `21015a7f7484dda8a6b9951e52782a8bd8921d01`; it was inspected, not overwritten.
  Its uniquely useful checks — pinned action SHAs, disabled install lifecycle
  scripts, lockfile/manifest integrity and the SDK/contract release range — were
  folded into this branch. There is one gate implementation, not three.

Verified code head: `3c7c0446026691bf34a67628d038b1fa7e549332`. The final
remote SHA is the branch head at publication and is restated in the handoff.
A later docs-only record commit changes the review head but not the code tree;
hosted exact-head CI is a separate, still-unavailable evidence item (see below).

## Exact-tree acceptance

Command: `npm run verify` with `CODERAX_TEST_MONGO_URI` pointing at a disposable
real MongoDB started for this run. Exit status: 0 at code head
`3c7c0446026691bf34a67628d038b1fa7e549332`.

| Gate | Tests | Result |
| --- | --- | --- |
| unit | 91 | 91 passed |
| integration (fake Mongo labelled) | 9 | 9 passed |
| security | 25 | 25 passed |
| adversarial | 19 | 19 passed |
| contract | 14 | 14 passed |
| architecture | 41 | 41 passed |
| artifacts | 10 | 10 passed |
| e2e | 3 | 3 passed |
| audit | command | 0 critical, 0 high, 0 moderate, 0 low, 0 info |
| openapi | command | `openapi.json` matches contracts |
| mongo-live (real database) | 8 | 8 passed, 0 skipped |

Total: 220 tests across 11 gates. Gate manifest: 37 compiled test files
assigned, none unclaimed. The live gate forces `CODERAX_REQUIRE_MONGO=1`; with no
URI it exits 1 with eight explicit failures and zero skips.

The new shutdown suite is part of the live gate (`tests/live/shutdown.test.ts`).
It was run six consecutive times against one disposable MongoDB: 6/6 runs
passed, each with 2/2 tests, 0 failures and 0 skips. It covers:

- concurrent `stop()` calls returning the same lifecycle promise;
- refusal of new execution with `not_ready` after admissions close;
- a fault-injected checkpoint `updateOne` delayed across shutdown, with the
  test failing if persistence closes before those promises settle.

The prior real-Mongo work remains in the same gate: connection/index bootstrap,
two-replica lease arbitration, completed-task restart, generation fencing, stale
generation recovery and notification durability.

## Shutdown lifecycle

`composeApplication().stop()` now:

1. calls `service.beginShutdown()`, closing admission for submit, resume, retry
   and chat, and stops scheduler admission;
2. closes the HTTP listener to new work while allowing in-flight responses;
3. aborts active run controllers and waits for scheduler jobs and tracked fenced
   checkpoint writes to settle;
4. settles receipts and preserves unresolved checkpoints; terminal lease release
   stays in the existing fenced run path;
5. closes persistence only after the service and listener drain.

`stop()` is idempotent and concurrency-safe: all callers share one promise.
Shutdown is bounded by `execution.shutdownGraceMs` (default 10s). If the deadline
is exceeded, `ShutdownTimeoutError` is raised and persistence is deliberately
left open; active leases are not silently released, so recovery/fencing remains
authoritative. Quarantine of an adapter that ignores abort is an operator
action; this repository does not have a supervisor-owned quarantine store on the
base branch.

## Consolidated quality-gate branch

Both remote branches were inspected at their exact heads:

- `ci/permanent-quality-gate` at `21015a7f7484dda8a6b9951e52782a8bd8921d01`:
  one-commit gate with a `quality-gate` and a sibling `database-regression` job,
  pinned action commits, dependency-manifest and release checks.
- `ci/permanent-quality-gates` (this branch): type-based capability and
  execution-boundary checks, semantic negative controls, mandatory live MongoDB
  inside the protected `verify` context, contract/SDK coverage, artifact
  determinism and the shutdown lifecycle.

This branch survives because only it puts the real-database lane inside the
required check and combines ownership enforcement with executable negative
controls. The competing branch's unique checks were integrated as described
above. It remains an untouched historical artifact.

## API and SDK contract

The base branch's single canonical contract is version 1.0.0. The gate checks:

- unique operation IDs, method/path pairs and `ROUTE_INDEX` entries;
- SDK operation coverage exactly equal to the route catalogue;
- package versions equal `CONTRACT_VERSION`;
- deterministic OpenAPI generation and no drift;
- SDK/contract runtime parsing, redirect refusal, token placement and error
  validation;
- reproducible package tarballs and checksums.

PR #7 (`pull/7/head` at `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f`) advertises
contract/SDK 1.1.0, not the requested 1.2.0. API/SDK 1.2.0 therefore cannot be
certified from the observed remote state. No competing 1.2.0 catalogue was
created on this branch. The release owner must publish the 1.2.0 catalogue,
update the version assertions and run this gate at that exact head before any
1.2.0 claim.

## Security regressions

The typed HTTP 413 correction remains covered by `tests/security/auth.test.ts`,
together with malformed payload validation, owner isolation, event replay,
approval scope/expiry, stale-generation fencing, workspace symlink confinement
and redaction. New tests in `tests/security/network.test.ts` reject plaintext
provider URLs, URL credentials, loopback/private/link-local/metadata addresses,
and force `redirect: 'error'` on provider requests.

This is a static destination guard. DNS rebinding and an approved hostname that
later resolves to a private address require a deployment egress allow-list or a
pinned-address dispatcher; neither exists on this base, so that residual risk is
not claimed as solved. No MCP/plugin implementation is present on this base, and
no shell-execution path is admitted outside the declared tool seam.

## Hosted CI, PR and approval state

- `main` is protected with required status-check context `verify` (read-only API
  observation). No protection setting was changed.
- The required `verify` job owns the pinned `mongo:7.0.14` service and the
  `mongo-live` step, so the protected check cannot pass without real-database
  evidence. Actions are pinned to full commit SHAs and install lifecycle scripts
  are disabled.
- There is no pull request for this branch. The read-only API found zero
  workflow runs at the checked heads; GitHub Actions only runs this workflow on
  pull requests and pushes to `main`.
- Creating the PR requires an authorized GitHub write integration. This host has
  no `gh` binary and no GitHub write credential; the unauthenticated API cannot
  create a pull request. No PR, self-approval or independent review was
  fabricated.
- The detailed protection endpoint returned HTTP 401, so required reviewer count,
  dismissal rules and bypass actors remain unverified. Independent approval is
  outstanding.

## Cross-repository boundary

Coderax and CoderaxCLI are not present in this workspace and no authorized
integration was available to read their exact heads. The repository gate proves
its own route catalogue, OpenAPI document, SDK operation map and runtime
contracts; it cannot certify a consumer repository or its release. The ecosystem
release owner must run the consumer-side compatibility gate against this exact
head and record Windows, macOS and Ubuntu CLI results separately. No redundant
cross-repository pipeline was created.

## Cost and safety

All testing used local cloud resources, the standard GitHub-hosted runner
definition, and a disposable MongoDB. No paid runner, database, inference or new
Vercel dependency was used. No production database, credential or owner data was
connected. No direct main push, force push or repository-setting change was made.
