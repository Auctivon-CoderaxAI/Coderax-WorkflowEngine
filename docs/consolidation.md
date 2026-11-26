# Consolidation and merge plan

This branch, `integration/authoritative-runtime`, reconciles the durable execution
stack with the authoritative v1.1 contract and the durable persistence services.
It is a review vehicle, not a new long-lived branch: every change should reach
`main` through a reviewed pull request, and this branch should be closed once its
commits have landed.

## Ownership after reconciliation

| Responsibility | Authority | Evidence |
| --- | --- | --- |
| API contract, operation ids, OpenAPI, shared SDK | `contract/authoritative-v1.1` at `ea66028` | 35 registered operations; `tests/contract/*`; SDK coverage and package tests |
| Durable execution, tasks, events, checkpoints, receipts, idempotency | this stack (`feat/durable-events-recovery` and descendants) | restart and two-replica MongoDB suites; fencing in `updateFenced` |
| Fencing, termination and durable quarantine | PR #5 Execution Supervisor (`feat/execution-supervisor` at `13d4b4f`), integrated here | supervisor unit tests; restart execution record; two-replica quarantine refusal |
| Zero-cost budget reservation | PR #4 Model Router (`feat/zero-cost-model-router` at `7b4ec1d`) | shared Mongo reservation ledger; two-replica single-slot test |
| Artifact persistence | `feat/durable-artifacts` at `fd5edef` | artifact store and routes adopted, not duplicated |
| Scheduling | durable scheduling at `e126c48` | schedule store and timer adopted |
| Permissions | one store: `src/permissions/store.ts` + table ports | cross-replica atomic consumption in `mongo-replicas` |
| Security hardening | `security/remediation-...` at `4b2ea75` | request ids, redaction, constant-time auth preserved |
| Permanent gate | `ci/permanent-quality-gate` at `21015a7` | `verify.yml` plus the new required `mongo` job |

No competing route catalogue, event schema or SDK exists on this branch. The
v1.1 catalogue won; the five read-model operations this stack needed were added to
it rather than kept in a parallel router. The permission table port is the only
permission persistence. The supervisor's identity, termination and capability
primitives were adopted from PR #5, while its process-local workspace hold was
replaced by a shared durable quarantine store; its older permission-store draft
was rejected in favour of this branch's action-bound single-use lifecycle.

Budget reservations were adopted from PR #4's ledger shape and moved from a
process-local map to `budget_days` and `budget_reservations`, so two replicas
arbitrate the last request slot in one conditional update.

## Preserved published heads

These four branches were not rewritten, amended, force-pushed or deleted:

| Branch | Head | Status |
| --- | --- | --- |
| `feat/durable-events-recovery` | `db289d2` | preserved; content included in the integration branch |
| `feat/persistent-records` | `b5818f4` | preserved; content included |
| `feat/read-model-api` | `4626b84` | preserved; content included |
| `feat/operability-evidence` | `5d2afd1` | preserved; integration base |

Because a rewrite was prohibited, the v1.1 contract was merged into a new
integration branch instead of rebasing the four published heads. The published
branches remain separately reviewable as historical slices; they are not the
merge target.

## Dependency-linked merge order

1. **`contract/authoritative-v1.1`** (`ea66028`) first. It owns the route
   catalogue, SDK 1.1.0 and OpenAPI generator. Every later branch must consume it.
2. **`feat/durable-events-recovery`** (`db289d2`). Durable event delivery,
   terminal flush before lease release, watermark hydration.
3. **`feat/persistent-records`** (`b5818f4`). Table ports and MongoDB stores.
4. **`feat/read-model-api`** (`4626b84`). Read models, pagination, deletion.
5. **`feat/operability-evidence`** (`5d2afd1`). Request ids, redaction, metrics,
   lease counters, readiness, evidence generator.
6. **`integration/authoritative-runtime`** (this branch). The only branch that
   contains the reconciled result; it supersedes the five slices above once
   approved. Merging the slices and then this branch would replay the same
   commits and is not the recommended path.
7. **PR #5 Execution Supervisor** (`13d4b4f`) is integrated into this branch:
   identity, termination, capability revocation, durable quarantine and stale
   retirement. Do not merge it separately; close it as superseded after review.
8. **PR #2 Intelligence Core** (`e14e4b7`), **PR #3 Native Reasoning Planner**
   (PR head `90b87db`), **PR #4 Model Router** (`7b4ec1d`) after the contract
   branch. PR #4's reservation shape and shared counters are integrated here; the
   router branch still owns provider selection and should rebase onto this
   branch's `BudgetLedger` rather than reintroducing its in-memory map. The other
   branches own their domains; they must delete duplicate route entries and use
   the shared SDK rather than adding a second client.
9. **`feat/durable-artifacts`** (`fd5edef`), scheduling (`e126c48`), security
   (`4b2ea75`) and the permanent gate (`21015a7`) are either already represented
   here or should be retargeted onto `main` after the contract branch lands.
   Close them as superseded when their content is verified in the integration
   branch.

`feat/durable-events-integration` (`2554edc`) is superseded by steps 2–6; do not
merge it separately.

## Known dependency not resolved here

- **Cross-replica live revocation.** Workspace quarantine is durable and shared;
  the capability broker that revokes an in-flight attempt is still process-local.
  The supervisor reports `cross-replica-containment: bounded`, not enforced. A
  tool broker coordinated across replicas is required before claiming otherwise.
- **Client repositories.** Coderax Web and CoderaxCLI consume `@coderax/sdk`
  1.1.0 from `dist-artifacts/`. This repository cannot verify those private
  repositories from this environment; the SDK methods for discovery, events,
  permissions, cancellation, resume and results are covered by
  `tests/contract/sdk-coverage.test.ts`.
- **PR creation.** No GitHub authoring integration is available in this
  environment. The compare links below are retained instead of inventing a
  push or token.
- **Dependency advisory.** `npm audit --omit=dev` reports one high-severity
  issue: `zod <4.6.6` can exhaust memory on oversized constrained collections
  (GHSA-mrhx-c7xc-m3w5). The offered fix is the semver-major `zod@4.6.7`, which
  changes the schema API used throughout the contract package. It was not forced
  into this change. The engine is owner-only, has no public endpoint and caps
  request bodies, which limits but does not remove the exposure. Track the zod 4
  migration separately.

## Compare links

- `contract/authoritative-v1.1...integration/authoritative-runtime`
- `feat/durable-events-recovery...feat/durable-events-integration`
- `feat/durable-events-recovery...feat/persistent-records`
- `feat/durable-events-recovery...feat/read-model-api`
- `feat/durable-events-recovery...feat/operability-evidence`
- `integration/authoritative-runtime...feat/execution-supervisor`

## Verification at this head

- `npm run verify`: 163 tests, 163 passed, 0 failed, 0 skipped, OpenAPI drift
  clean, SDK tarballs reproducible.
- `npm run test:mongo` with `CODERAX_REQUIRE_MONGODB=1` against a real MongoDB:
  restart recovery, two-replica arbitration, durable quarantine, shared budget
  and supervisor execution records pass.
- Required lane without `CODERAX_TEST_MONGODB_URI`: fails with
  `CODERAX_REQUIRE_MONGODB=1 requires CODERAX_TEST_MONGODB_URI`; it cannot pass by
  skipping.
