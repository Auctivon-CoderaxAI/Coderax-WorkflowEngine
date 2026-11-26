# Permanent quality gates

This document is the contract for the acceptance gate. It is intentionally
boring: every claim below names a command and a test file, and every gate is
either a compiled test or a command that exits non-zero on a real finding. CI
runs on standard `ubuntu-latest` GitHub-hosted runners only; there is no paid
runner, action, database or model in this path.

`npm run verify` (build + all gates, including the real-MongoDB gate + manifest
coverage) is the acceptance command. It requires `CODERAX_TEST_MONGO_URI` to
name a disposable MongoDB; there is no local-file or in-memory substitute. Use
`npm run gate -- unit` (or another gate id) for a subset without a database.
`node dist/scripts/run-gates.js list` is the authoritative gate list, and
`coverage` fails when a compiled test file is not assigned to exactly one gate.

## Gate matrix

| Requirement | Gate / CI step | Evidence |
| --- | --- | --- |
| TypeScript compilation | `npm run build` (`tsc -b`, project references) | compiler exit status |
| Unit tests | `unit` | `tests/unit/**` |
| Integration tests | `integration` | `tests/integration/**` (collection fake) |
| Real database integration | `mongo-live` (also part of `verify`; separate CI job) | `tests/live/mongo.test.ts` against a pinned `mongo:7.0.14` service |
| Security regression tests | `security` | `tests/security/**` |
| Adversarial execution tests | `adversarial` | `tests/adversarial/**` |
| OpenAPI drift | `openapi` | `dist/scripts/check-openapi.js` |
| SDK compatibility | `contract`, `artifacts` | `tests/contract/routes.test.ts`, `tests/artifacts/artifacts.test.ts` |
| Route registration completeness | `contract` | `tests/contract/routes.test.ts` |
| Dependency wiring | `architecture` | `tests/architecture/wiring.test.ts`, `dist/scripts/check-architecture.js` |
| Unused/disconnected capabilities | `architecture` | reachability and factory-consumer checks in the same pair |
| Capability ownership (type-based) | `architecture` | `dist/scripts/capabilities.js`, `tests/architecture/capabilities.test.ts` |
| Durable scheduling | `unit` (current in-process scheduler) | `tests/unit/scheduler.test.ts`; the durable scheduler owner must add a live test when it lands |
| Dependency vulnerabilities | `audit` | `dist/scripts/check-audit.js` (high and critical fail) |
| Model cost policy | `adversarial`, `unit` | `tests/adversarial/cost-policy.test.ts`, `tests/unit/models.test.ts` |
| Private/cloud isolation | `security` | `tests/security/isolation.test.ts`, `tests/security/regressions.test.ts` |
| Generation fencing | `adversarial`, `unit` | `tests/adversarial/fencing.test.ts`, `tests/unit/fencing.test.ts` |
| Crash recovery | `adversarial` | crash-to-interrupted-to-resume test in `tests/adversarial/fencing.test.ts` |
| Event replay | `adversarial`, `unit` | `tests/adversarial/replay.test.ts`, `tests/unit/events.test.ts` |
| Approval enforcement | `adversarial`, `security` | `tests/adversarial/approval.test.ts`, `[SEC-F5]` |
| Package artifact integrity | `artifacts` | `npm pack --dry-run`, entrypoints, reproducibility, no source/secrets |
| API-to-engine end to end | `e2e` | `tests/e2e/end-to-end.test.ts` |

The `mongo-live` gate is deliberately not folded into `integration`. A passing
collection fake proves repository semantics; it does not prove the official
driver, server indexes, two-connection arbitration, generation fencing, crash
recovery or notification durability. The live suite now covers those six paths
and the gate forces `CODERAX_REQUIRE_MONGO=1`, so a missing service fails instead
of silently skipping. The image is pinned to `mongo:7.0.14`; the service is
ephemeral and receives no production credentials. Quota, durable events,
approvals and artifacts cannot be claimed against a database until their owning
branches land; the gate will require their live tests then rather than treating
the in-memory path as evidence.

## Architecture regression tests

`dist/scripts/check-architecture.js`, `dist/scripts/capabilities.js`,
`tests/architecture/graph.test.ts` and `tests/architecture/capabilities.test.ts`
enforce:

- every `src/**/*.ts` module is reachable from `src/main.ts`;
- exactly one construction site for the workflow service, task runner, model
  catalog, event bus, route registry, HTTP server, scheduler and route catalogue;
- exactly one **value whose type satisfies** each capability contract
  (`ModelCatalog`/`ModelRouter`, `TaskRunner`, `TaskScheduler`,
  `PermissionGate`, `BudgetLedger`, `EventBus`, `ApplicationService`, HTTP
  `Router`, `RouteRegistry`, `Planner`, `ExecutionSupervisor`), regardless of
  factory name. Memory/Mongo persistence drivers are not authorities; the
  decision layer is;
- a provider adapter returning `ProviderAdapter` is not a model router, and the
  tool/MCP network seams are not classified as unauthorized inference; the
  synthetic tests prove both distinctions;
- the composed container has exactly the declared keys, so an indirectly
  registered extra service is a finding;
- only `src/orchestration/service.ts` starts a run, claims a lease or writes a
  terminal task;
- agents cannot import orchestration, API or persistence; models cannot import
  callers/executors; the SDK cannot import engine internals; contracts cannot
  import the engine or SDK;
- every exported `create*` factory has a consumer;
- the composed container supplies every named dependency and no route is
  unregistered;
- the SDK operation map equals the route catalogue, so an API operation without
  a client fails the contract gate.

Every rule has a negative control. `graph.test.ts` injects a duplicate runner, a
second HTTP server, a competing workflow engine, a duplicate model catalogue, an
orphan module, an unconsumed factory, a boundary violation and a second route
catalogue. `capabilities.test.ts` uses different factory names (`alpha`, `beta`,
`renamedButAuthoritative`, `queue`) and an indirectly constructed value, proves
the type checker rejects two owners, and proves a `ProviderAdapter` is not a
model router. The real checked-in repository is required to report no finding;
the PR #5 consolidated probe currently reports competing model-router
implementations and two planners, which is the gate doing its job, not a green
result.

## Previously reported independent findings

The review findings in [`docs/pr-1-review.md`](pr-1-review.md) are now named,
permanent tests. `tests/security/regressions.test.ts` fails if any finding loses
its test; the final test compares the registered IDs with F1–F11.

| Finding | Regression test | What it proves |
| --- | --- | --- |
| F1 redaction | `[SEC-F1]` | adapter/provider text is scrubbed before persistence, status and replay |
| F2 persistence | `[SEC-F2]` | `mongo` without a URI fails startup; no silent process-local downgrade |
| F3 external agents | `[SEC-F3]` | unavailable agent is refused, isolated and creates no task |
| F4 progress events | `[SEC-F4]` | every emitted event validates, ids are unique, sequence is monotonic |
| F5 approvals | `[SEC-F5]` | exact resource/scope, owner and task scoping, expiry, denial |
| F6 bounded cleanup | `[SEC-F6]` | cancellation grace bound; late report cannot reach the caller |
| F7 transcript prompt | `[SEC-F7]` | history is stored, bounded and excludes the current objective |
| F8 event vocabulary | `[SEC-F8]` | `file.edit` and optional `sessionId` validate; oversized paths fail |
| F9 workspace confinement | `[SEC-F9]` | real paths, symlink resolution and overlap refusal |
| F10 OpenHands | `[SEC-F10]` | the three-agent surface has no unported fourth agent |
| F11 readiness | `[SEC-F11]` | readiness is configuration admission and spends no provider call |

The F5 review also records that an adapter-emitted `approval.required` event is
not yet backed by a permission-store record. That integration belongs to the
native-approval owner (PR #3); this gate does not claim it. The permission store's
authority — the part that can actually grant or deny — is covered exactly.
Likewise, cost-class attestation remains with the intelligence owner (PR #2);
this gate enforces the literal `allowPaid: false`, refusal of paid descriptors,
the ordered free route, discovery and the daily budget.

## Dependency vulnerability gate

`npm audit --json` is parsed by `dist/scripts/check-audit.js`; high and critical
advisories fail. The repository previously carried
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
(CVE-2023-54404) through zod 3; the advisory range is `<4.6.6` and the fixed
version is `4.6.7`. The root, contracts and SDK now resolve one deduplicated
zod `4.6.7`, and the security-remediation branch independently uses the same
version, so there is one migration line rather than competing majors. The
hand-written JSON-Schema converter was adapted to zod 4 internals;
`tests/unit/zod4.test.ts` covers runtime defaults, optional fields, strict
objects, discriminated unions, refinements and the generated schema shape.
`openapi.json` is byte-identical before and after the upgrade. There is no audit
exception or lowered threshold.

## Coordination with active owners

This work is additive on a short-lived branch. It does not modify any active
implementation branch. The inspected heads are intelligence/tools (PR #2),
native reasoning/approvals (PR #3), the standalone model router (PR #4) and the
execution supervisor plus intelligence merge (PR #5), plus the dedicated
durable-events, durable-artifacts, artifact-intelligence, multimodal and
security-remediation branches. PR #5 contains the same tools/knowledge routes as
PR #2, and its model catalogue has both `createModelCatalog` and
`createRouterCatalog`; the capability gate correctly reports those as competing
routers. The files most likely to need a rebase are
`src/bootstrap/compose.ts`, `src/bootstrap/container.ts`,
`src/configuration/schema.ts`, `src/orchestration/service.ts`,
`src/permissions/store.ts`, `src/models/router.ts` and `packages/contracts/`
sources.

There is also a separate remote `ci/permanent-quality-gate` branch with an
earlier one-commit gate implementation. It is a parallel artifact, not a source
of truth for this branch; it must not be overwritten. Reconcile its useful
checks through review rather than merging two competing gate implementations.
Cross-repository release certification stays outside this repository gate: the
release owner consumes the evidence from the exact `verify` head, while this
repository enforces only its own architecture and tests.

### Consolidated-head probe (2026-11-26)

The capability checker was run read-only against each current branch worktree;
no branch was checked out into this history or modified. These are findings, not
merge results:

| Branch | Capability/architecture probe | Owner action before merge |
| --- | --- | --- |
| `feat/intelligence-core` (PR #2) | competing router + planner; disconnected arbiter/retry; model→agent boundary | remove legacy catalog/deterministic planner, adopt the retry decision, and add the SDK map for five new routes |
| `feat/native-reasoning-planner` (PR #3) | clean after memory/Mongo permission drivers were classified as drivers; disconnected arbiter/retry | remove the two superseded execution helpers or rebase on their resolution |
| `feat/zero-cost-model-router` (PR #4) | capability-clean; disconnected arbiter/retry | rebase on the execution-helper resolution |
| `feat/execution-supervisor` (PR #5) | competing model routers and planners; disconnected arbiter/retry; unused MCP/catalog factories | consolidate the legacy catalog and deterministic planner, then add the SDK map |
| `security/remediation-808dfd3` | capability-clean; same zod `4.6.7` line | coordinate the zod converter/config conflict with this branch |
| `feat/durable-events-integration` | capability-clean; adds routes without the SDK map | add SDK operations and a live event-replay test when durable events land |
| `feat/durable-artifacts`, `feat/artifact-intelligence` | capability-clean; no live artifact durability test on this base | add a live artifact test in the owning branch |
| `feat/multimodal-creative-intelligence` | capability-clean | keep the media validation and live evidence with the owner |

A provider adapter is not a router and the memory/Mongo permission stores are
drivers, not competing authorities; the synthetic tests pin those distinctions.
The probe intentionally reports the PR #5 duplicate rather than blessing a
consolidated architecture that has not actually chosen one owner.

The SDK compatibility gate is intentionally strict: the tools, routing and
knowledge operations in PR #2/#5 must add matching `SDK_OPERATIONS` entries
(and client methods) before the contract gate can pass. That is the
incompatibility the gate exists to catch; it is not a test to be relaxed. The
zod upgrade changes no HTTP shape and should merge without requiring a change to
the intelligence, approval or supervisor logic.

## Execution helper resolution

`src/execution/arbiter.ts` was superseded by the durable lease key and was
removed. `src/execution/retry.ts` was also removed: the runner never called it,
the service only exposes owner-triggered `retryTask`, and importing its
constants into configuration only made the orphan look reachable. The gate now
reports an unreachable or unconsumed helper rather than accepting that kind of
wiring. No runtime behavior was replaced: the existing owner-triggered retry
path remains, and a future automatic retry must arrive with its own execution
tests and owner coordination.

## Real-MongoDB coverage

The live suite covers the paths that exist on this base: official-driver
connection and index bootstrap, two-connection lease arbitration, completed-task
restart, generation fencing across real task documents, expired-generation
recovery plus resume, and notification unread/mark-read durability. Quota,
durable events, approvals, artifacts and schedules are not claimed here because
their implementation branches are not on this base; the capability and live
gates are the place they must add evidence when they land.

## Zero-cost and hosted-CI state

- Runner: `ubuntu-latest` standard image, included minutes only.
- Database: pinned `mongo:7.0.14` service container, no managed database and no
  production URI. A missing service fails the required live gate.
- No paid model is called by any gate; the test gateway is a deterministic fake,
  and the live database test executes Native against that fake.
- No third-party action beyond `actions/checkout` and `actions/setup-node`.
- The repository's account-level hosted-Actions restriction recorded in
  [`docs/governance.md`](governance.md) may still prevent a hosted job from
  starting. That is an external account limitation, not a skipped gate: the same
  commands are run locally and their output belongs in the pull request.
