# Acceptance record — 2026-11-26

## Final gate SHA

- **Final consolidated quality-gate implementation:**
  `d00156a1597e5d908d21d3886272f5710a0df721`
- **Passing hosted run at that exact SHA:** `45888790260` (`verify`, all 23
  steps successful, including the real-MongoDB step)
- The gate has one runner (`scripts/run-gates.ts`), one manifest
  (`scripts/gates.ts`), one workflow (`.github/workflows/verify.yml`) and one
  required job (`verify`). No `scripts/gate/*` implementation survives.
- The reconciliation on top of `d00156a` adds the competing branch's verified
  unique regression suites and the controls those suites proved missing. It does
  not change the gate runner, manifest, workflow or required-job shape. Two
  reconciliation rounds were merged: `821352f` (engine regressions) and its
  post-adoption head `a1f2319` (fail-closed audit tests). The `821352f` tree
  `c15091d13022a6a23d0a5bdb068846507a6cd64c` passed hosted run `45900429936`
  (single `verify` job, 23 steps); run `45888790260` covers `d00156a` only.

## Candidate integration head

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Base: `main` at `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`
- Branch: `ci/permanent-quality-gates`
- Compare: https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine/compare/main...ci/permanent-quality-gates
- The surviving implementation is this branch. The parallel
  `ci/permanent-quality-gate` branch was reconciled in two rounds at its last two
  observed heads, `821352f9002f6804cf7213e1cc09265aafcbba58` and its
  post-adoption head `a1f231900e619597a813e208cff06a38f870c3a6`; it had advanced
  through `21015a7`, `07e7220` and `b8143a6` while this branch was being verified.
  Both heads are merged into this branch and the branch was never checked out
  over this one, force-pushed, deleted or rewritten.
- Reconciliation was executed, not declared: every suite on that branch that
  exercises engine behaviour was compiled and run against this tree, and every
  passing case was preserved unless an existing test already covered it. The
  preserved unique coverage is 43 tests in six whole files plus five cases
  appended to existing suites. Those tests proved three engine controls and one
  gate fail-closed rule this branch was missing (below), which were ported. Its
  architecture suites depend on the rejected `scripts/gate/*` module, so they
  were compared check-by-check against this branch's stronger equivalents
  instead of copied. Its duplicate gate implementation and its already-covered
  suites were rejected.

Verified integration head: `d00156a1597e5d908d21d3886272f5710a0df721`. The
hosted `verify` job passed at this exact SHA in run `45888790260`, and the
earlier run `45888499599` passed at `d6f877c283b64e8a243b862789b3b6e4e5fb6082`.
The reconciliation merge `e49568b2df0e3b70ca63e756d4c1639aa6048977` and its
content commit `c15091d13022a6a23d0a5bdb068846507a6cd64c` passed run
`45900429936`; a later docs-only record commit changes the review head but not
that code tree.

## Exact-tree acceptance

Command: `npm run verify` with `CODERAX_TEST_MONGO_URI` pointing at a disposable
real MongoDB started for this run. Exit status: 0 on the reconciliation tree
recorded by this document. The same command passed at `d00156a` (221 tests, 37
files) in hosted run `45888790260`.

| Gate | Tests (reconciliation tree) | Result |
| --- | --- | --- |
| unit | 99 | 99 passed |
| integration (fake Mongo labelled) | 21 | 21 passed |
| security | 37 | 37 passed |
| adversarial | 30 | 30 passed |
| contract | 14 | 14 passed |
| architecture | 42 | 42 passed |
| artifacts | 10 | 10 passed |
| e2e | 3 | 3 passed |
| audit | command | 0 critical, 0 high, 0 moderate, 0 low, 0 info |
| openapi | command | `openapi.json` matches contracts |
| mongo-live (real database) | 8 | 8 passed, 0 skipped |

Total: 264 tests across 11 gates. Gate manifest: 43 compiled test files
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

Both remote branches were inspected at their exact heads. The competing branch
advanced from `21015a7` to `07e7220`, `b8143a6` and finally
`821352f9002f6804cf7213e1cc09265aafcbba58` during this work, then added the
post-adoption audit commit `a1f231900e619597a813e208cff06a38f870c3a6`; both were
reconciled.

- `ci/permanent-quality-gate` at `821352f`/`a1f2319`: a modular `scripts/gate/*` runner
  with eleven static checks, plus a `quality-gate` job, a sibling
  `database-regression` job and a `vulnerabilities` job.
- `ci/permanent-quality-gates` (this branch): type-based capability and
  execution-boundary checks, semantic negative controls, mandatory live MongoDB
  inside the protected `verify` context, contract/SDK coverage, artifact
  determinism and the shutdown lifecycle.

This branch survives because only it puts the real-database lane inside the
required check, publishes the protected context `verify`, and combines ownership
enforcement with executable negative controls. Its workflow also runs the gate at
its own `ci/**` head, so the extra `ci/permanent-quality-gate` workflow is a
second pipeline for the same gate rather than additional evidence.

### What was preserved from `821352f`

Six whole suites (38 tests) were kept because every case passes on this tree and
none is replaced by an existing file:

| Suite | Tests | Unique behaviour |
| --- | --- | --- |
| `tests/security/findings.test.ts` | 12 | named SEC-1…SEC-10 regressions: pre-storage redaction, chat redaction, typed 413, TLS MongoDB, adapter throws, foreign-conversation injection |
| `tests/adversarial/execution.test.ts` | 6 | malformed adapter outcome, oversized summary, resolve-after-cancel, late report, concurrent conversation submits, traversal id |
| `tests/integration/fencing.test.ts` | 4 | stale generation resume/retry, pre-crash token, concurrent cancel, terminal task not rewritten |
| `tests/integration/recovery.test.ts` | 3 | lease expiry → interrupted → resume, idempotent recovery, settlement survives lease-release failure |
| `tests/integration/replay.test.ts` | 5 | SSE replay, close-on-terminal, unauthenticated stream, foreign-owner replay |
| `tests/unit/audit.test.ts` | 8 | every fail-closed audit path: missing npm, unreadable/truncated JSON, registry error, absent metadata, notices before JSON, fatal high/critical, non-fatal moderate/low, token redaction (`a1f2319`) |

Five further cases were appended to existing suites: `approval.required` grants
nothing by itself, a pending request is listed and cannot be decided elsewhere,
a paid model is refused in private mode, the request budget fails closed at the
service boundary, and an unknown model creates no task or conversation. The
remaining cases in those two files duplicate existing coverage and were not
copied.

Three engine controls and one gate rule were ported because the preserved tests
failed without them:

1. `isAgentOutcome` in `src/execution/runner.ts`: a malformed adapter value now
   settles as a typed `protocol_error` instead of an unread result.
2. Run- and chat-failure detail is redacted before it is stored
   (`src/orchestration/service.ts`), not only when it is read back.
3. Chat output is redacted before storage and before it is returned.
4. `scripts/check-audit.ts` now exports a pure `auditFromResult` classifier and
   requires npm's `metadata.vulnerabilities` block; a vulnerability map alone is
   no longer accepted as proof the scan completed, npm notices before the JSON
   are parsed, and registry tokens are redacted from the diagnostic.

### What was rejected

- `scripts/gate/*` and its `gate:*` npm scripts: a second runner and manifest for
  the same gate. Nothing under `scripts/gate/` survives; only the audit
  classifier logic was ported into the existing `scripts/check-audit.ts`.
- Its workflow: three jobs whose names are not the observed required context
  `verify`, with the live database in a sibling job the required check cannot
  see. This branch's single `verify` job is the one accepted.
- `tests/architecture/{authority,registration,release,sdk,structure}.test.ts`:
  already covered by this branch's stronger negative controls
  (`tests/architecture/graph.test.ts` and `capabilities.test.ts`),
  `tests/contract/routes.test.ts`, `tests/artifacts/artifacts.test.ts`,
  `tests/artifacts/dependencies.test.ts` and `tests/architecture/workflow.test.ts`.
- `tests/integration/mongo-live.check.ts`: duplicates this branch's eight-test
  live lane (`tests/live/mongo.test.ts`, `tests/live/shutdown.test.ts`).
- Its SDK surface without `SDK_OPERATIONS`, its 413 body-drain variant, its
  retry configuration keys and its `shutdown` shape: this branch already has a
  stricter or verified equivalent, and the removed `retry` module makes its
  retry keys inert.

The competing branch remains an owner artifact. Its history is merged here, but
it was not force-deleted or rewritten by this branch.

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

The typed HTTP 413 correction remains covered by `tests/security/auth.test.ts`
and is independently re-asserted by `[SEC-6]` in `tests/security/findings.test.ts`,
together with malformed payload validation, owner isolation, event replay,
approval scope/expiry, stale-generation fencing, workspace symlink confinement
and redaction. New tests in `tests/security/network.test.ts` reject plaintext
provider URLs, URL credentials, loopback/private/link-local/metadata addresses,
and force `redirect: 'error'` on provider requests. `[SEC-7]`/`[SEC-7b]` prove the
Mongo connector refuses a remote plaintext URI before connecting and forces a
direct loopback connection; `[SEC-1]`/`[SEC-1b]` prove failure and chat text is
redacted before storage as well as on read.

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
- There is no pull request for this branch. The workflow also triggers on
  pushes to `ci/**` so the gate branch can obtain exact-head hosted evidence;
  this does not create a second pipeline. Run `45888790260` completed with
  conclusion `success` at exact head
  `d00156a1597e5d908d21d3886272f5710a0df721`; its single `verify` job executed
  all 23 steps, including `Real MongoDB integration tests (required, no fake)`,
  and every step passed. Run `45888499599` passed earlier at
  `d6f877c283b64e8a243b862789b3b6e4e5fb6082`; run `45888302201` was cancelled
  when the branch advanced and is not counted. The reconciliation tree
  `c15091d13022a6a23d0a5bdb068846507a6cd64c` passed run `45900429936` with the
  same single `verify` job and all 23 steps; the record commit after it is
  docs-only.
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
