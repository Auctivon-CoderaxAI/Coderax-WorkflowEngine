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
| Real database integration | `mongo-live` (also inside the required `verify` CI job) | `tests/live/mongo.test.ts` and `tests/live/shutdown.test.ts` against a pinned `mongo:7.0.14` service |
| Security regression tests | `security` | `tests/security/**` |
| Adversarial execution tests | `adversarial` | `tests/adversarial/**` |
| OpenAPI drift | `openapi` | `dist/scripts/check-openapi.js` |
| SDK compatibility | `contract`, `artifacts` | `tests/contract/routes.test.ts`, `tests/artifacts/artifacts.test.ts`, `tests/artifacts/dependencies.test.ts` |
| Route registration completeness | `contract` | `tests/contract/routes.test.ts` |
| Dependency wiring | `architecture` | `tests/architecture/wiring.test.ts`, `dist/scripts/check-architecture.js` |
| Unused/disconnected capabilities | `architecture` | reachability and factory-consumer checks in the same pair |
| Capability ownership (type-based) | `architecture` | `dist/scripts/capabilities.js`, `tests/architecture/capabilities.test.ts` |
| Execution boundaries | `architecture` | `scripts/architecture.ts`, `tests/architecture/graph.test.ts` |
| Future durable live coverage | `architecture` | `scripts/live-coverage.ts`, `tests/architecture/live-coverage.test.ts` |
| Workflow integrity | `architecture` | `tests/architecture/workflow.test.ts` |
| Durable scheduling | `unit` (current in-process scheduler) | `tests/unit/scheduler.test.ts`; the durable scheduler owner must add a live test when it lands |
| Dependency vulnerabilities | `audit` | `dist/scripts/check-audit.js` (high and critical fail) |
| Model cost policy | `adversarial`, `unit` | `tests/adversarial/cost-policy.test.ts`, `tests/unit/models.test.ts` |
| Private/cloud isolation | `security` | `tests/security/isolation.test.ts`, `tests/security/regressions.test.ts` |
| Generation fencing | `adversarial`, `unit` | `tests/adversarial/fencing.test.ts`, `tests/unit/fencing.test.ts` |
| Crash recovery | `adversarial`, `integration` | `tests/adversarial/fencing.test.ts`, `tests/integration/recovery.test.ts` |
| Event replay | `adversarial`, `integration`, `unit` | `tests/adversarial/replay.test.ts`, `tests/integration/replay.test.ts`, `tests/unit/events.test.ts` |
| Approval enforcement | `adversarial`, `security` | `tests/adversarial/approval.test.ts` (including `approval.required` grants nothing), `tests/security/findings.test.ts`, `[SEC-F5]` |
| Package artifact integrity | `artifacts` | `npm pack --dry-run`, entrypoints, reproducibility, no source/secrets |
| Dependency and lockfile integrity | `artifacts` | `tests/artifacts/dependencies.test.ts` (reviewed direct deps, private workspaces, https + integrity hashes, script-free lockfile) |
| Provider network safety | `security` | `tests/security/network.test.ts` (https-only, no URL credentials/private targets, redirects refused) |
| API-to-engine end to end | `e2e` | `tests/e2e/end-to-end.test.ts` |

The `mongo-live` gate is deliberately not folded into `integration`. A passing
collection fake proves repository semantics; it does not prove the official
driver, server indexes, two-connection arbitration, generation fencing, crash
recovery, notification durability or shutdown draining. The live suite now
covers those eight paths and the gate forces `CODERAX_REQUIRE_MONGO=1`, so a
missing service fails instead of silently skipping. The shutdown test is a real
database fault injection: a checkpoint `updateOne` is delayed across `stop()`,
and the test fails if persistence closes before every injected write settles. The image is pinned to `mongo:7.0.14`; the service is
ephemeral and receives no production credentials. Quota, durable events,
approvals and artifacts cannot be claimed against a database until their owning
branches land; the gate will require their live tests then rather than treating
the in-memory path as evidence.

The repository's protected `main` requires the check context `verify`. That live
gate is therefore a step in the required `verify` job, not merely a sibling
`mongo-live` job that branch protection cannot see. This uses the same pinned
service container and does not change repository protection settings.

## Architecture regression tests

`dist/scripts/check-architecture.js`, `dist/scripts/capabilities.js`,
`tests/architecture/graph.test.ts` and `tests/architecture/capabilities.test.ts`
enforce:

- every `src/**/*.ts` module is reachable from `src/main.ts`;
- exactly one construction root for the workflow service, task runner, event
  bus, route registry, HTTP server, scheduler and route catalogue; the model
  catalogue is at most one (PR #4 may replace it with a router), and factory
  aliases or an alternative `src/bootstrap/*` root are rejected;
- exactly one **value whose type satisfies** each capability contract
  (`ModelCatalog`/`ModelRouter`/model `Router`, `TaskRunner`, `TaskScheduler`,
  `ScheduleEngine`, `PermissionGate`/`CapabilityBroker`, `BudgetLedger`,
  `EventBus`, `EventLog`, `ArtifactService`, `AgentRegistry`, `MediaService`,
  `CreativeService`, `ApplicationService`, HTTP `Router`, `RouteRegistry`,
  `Planner`, `ExecutionSupervisor`/`RunSupervisor`), regardless of factory name,
  class, wrapper or indirect construction. Memory/Mongo persistence and
  event-log drivers are not authorities; the decision/routing layer is;
- a provider adapter returning `ProviderAdapter` is not a model router, and the
  tool/MCP network seams are not classified as unauthorized inference; the
  synthetic tests prove both distinctions;
- outbound `fetch`, alternate HTTP clients, provider SDKs and subprocesses are
  rejected outside the declared gateway/provider/tool/MCP/browser/media/artifact
  seams; the inbound `src/api/server.ts` may import `node:http`; dynamic imports
  are graph edges, and an unresolved or alternative-root dynamic import fails;
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
orphan module, an unconsumed factory, a boundary violation, a second route
catalogue, a factory alias, a dynamic alternative root, an alternate HTTP
client, a provider SDK and a subprocess. `capabilities.test.ts` uses different
factory names (`alpha`, `beta`, `renamedButAuthoritative`, `queue`), indirect
construction, a class implementation and a wrapper, proves the type checker
rejects two owners, and proves a `ProviderAdapter` is not a model router. The
real checked-in repository is required to report no finding; the exact-head
branch matrix is in [`architecture-ownership.md`](architecture-ownership.md).

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
native reasoning/approvals (PR #3), the standalone model router (PR #4), the
execution supervisor (PR #5), native teams (PR #8), durable scheduling (PR #9)
and the dedicated durable-events, durable-artifacts, artifact-intelligence,
multimodal, read-model, persistence, operability, gaming and security-remediation
branches. PR #5 still carries competing model-router and planner values, which
the capability gate correctly reports rather than blessing an unreviewed merge.
The files most likely to need a rebase are
`src/bootstrap/compose.ts`, `src/bootstrap/container.ts`,
`src/configuration/schema.ts`, `src/orchestration/service.ts`,
`src/permissions/store.ts`, `src/models/router.ts` and `packages/contracts/`
sources.

There is also a separate remote `ci/permanent-quality-gate` branch. It was
reconciled at `821352f9002f6804cf7213e1cc09265aafcbba58`, its latest observed
head; it remains unmodified. Its history is merged here and its verified unique
suites are preserved (see [`acceptance.md`](acceptance.md#what-was-preserved-from-821352f)).
Its pinned action SHAs, disabled install lifecycle scripts, dependency/lockfile
integrity check and release-range check were integrated earlier; its
`scripts/gate/*` runner, three-job workflow, architecture suites that duplicate
this branch's negative controls, and `mongo-live.check.ts` duplicate were not
copied. Its live database lane remains outside the context the protected
`verify` check sees, so its self-declared supersession of this branch is still
rejected. One surviving implementation remains, not two or three.
Cross-repository release certification stays outside this repository gate: the
release owner consumes the evidence from the exact `verify` head, while this
repository enforces only its own architecture and tests.

See [`architecture-ownership.md`](architecture-ownership.md) for the exact-SHA
matrix covering every active PR and relevant branch, the authoritative owner per
capability and the classification of each finding. The probe is read-only: no
branch was checked out into this history or modified. It reports the PR #5
duplicate rather than blessing a consolidated architecture that has not actually
chosen one owner.

The SDK compatibility gate is intentionally strict: the tools, routing and
knowledge operations in PR #2/#5 must add matching `SDK_OPERATIONS` entries
(and client methods) before the contract gate can pass. The gate also rejects a
contract package version that differs from `CONTRACT_VERSION`, so a fork cannot
advertise a different catalogue under the same package version. PR #7 currently
advertises 1.1.0; the requested API/SDK 1.2.0 is not present on any observed
remote head, so it is a release blocker rather than a claim made here. That is the
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

Removing `execution.maxAttempts` and `execution.retryDelayMs` is a visible
configuration break, not a silent one: the strict schema rejects those keys at
startup, and `tests/unit/config.test.ts` pins that behavior. A deployment still
setting them must remove them before upgrading; there is no ignored no-op that
would make an operator believe retry policy is active. No HTTP, event, OpenAPI or
SDK contract contained those fields, so published client contracts are unchanged.

## Real-MongoDB coverage

The live suite covers the paths that exist on this base: official-driver
connection and index bootstrap, two-connection lease arbitration, completed-task
restart, generation fencing across real task documents, expired-generation
recovery plus resume, and notification unread/mark-read durability. Quota,
durable events, approvals, artifacts and schedules are not claimed here because
their implementation branches are not on this base; `scripts/live-coverage.ts`
requires a standardized live suite as soon as an owning branch lands its source.

Independently, the durable-artifacts branch was probed in its own worktree at
`fd5edef2a2cfc83850fa43b19a813676c352bb92`: its five real-Mongo concurrency
tests (deduplication, quota admission, abandoned reservation, corruption report
and delete/read race) passed 5/5 with zero skips against a disposable real
server. Those tests are in its integration gate and use
`CODERAX_TEST_MONGODB_URI`; they still need a standardized live file before they
can satisfy this lane. The branch's claimed 147-test total was not re-run here.

## Provider network regressions

`tests/security/network.test.ts` proves that plaintext URLs, credentials in the
URL, loopback addresses, private ranges and the metadata address are refused,
and that the OpenAI-compatible gateway sets `redirect: 'error'`. DNS rebinding
and an approved hostname resolving to a private address are not solved by this
static check; they require a deployment egress allow-list or pinned-address
dispatcher. The gate reports that as a boundary rather than claiming SSRF is
fully eliminated.

## Hosted CI and protection state

Read-only checks on 2026-11-26 found `main` protected, with the required status
check context `verify` enforced for everyone. The repository has one active
workflow, `.github/workflows/verify.yml`; it is the only workflow in the tree.
The required `verify` job now contains the pinned MongoDB service and the live
gate, so the protected check cannot pass while the database lane fails.

The detailed protection endpoint (`/branches/main/protection`) requires
authentication and returned HTTP 401 to this host. Required review counts,
dismissal rules and the full settings were therefore not inspected, and no
protection setting was changed. No pull request exists for
`ci/permanent-quality-gates`. Run `45888790260` passed the single `verify` job at
exact head `d00156a1597e5d908d21d3886272f5710a0df721`, including the real-MongoDB
step; the reconciliation commit on top of that head has no hosted run yet.

## Zero-cost and hosted-CI state

- Runner: `ubuntu-latest` standard image, included minutes only.
- Database: pinned `mongo:7.0.14` service container inside the required `verify`
  job, no managed database and no production URI. A missing service fails the
  required live gate.
- No paid model is called by any gate; the test gateway is a deterministic fake,
  and the live database test executes Native against that fake.
- No third-party action beyond `actions/checkout` and `actions/setup-node`.
- The repository's account-level hosted-Actions restriction recorded in
  [`docs/governance.md`](governance.md) may still prevent a hosted job from
  starting. That is an external account limitation, not a skipped gate: the same
  commands are run locally and their output belongs in the pull request.
