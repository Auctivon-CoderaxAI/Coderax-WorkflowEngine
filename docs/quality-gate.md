# Quality gate

The acceptance gate is `npm run verify`. It is the same command locally and in
[`.github/workflows/verify.yml`](../.github/workflows/verify.yml), so a green
workflow and a green workstation run mean the same thing.

```bash
npm ci --ignore-scripts
npm run verify
```

`verify` runs the TypeScript project-reference build, every test suite, and the
static gates in one command. Each control is also available on its own so CI names
the failing concern rather than dumping one opaque failure.

## What each control proves

| Control | Gate | Command |
| --- | --- | --- |
| TypeScript compilation | `tsc -b` across contracts, SDK and engine | `npm run build` |
| Unit tests | `tests/unit` | `node --test "dist/tests/unit/*.test.js"` |
| Contract tests | `tests/contract` | `node --test "dist/tests/contract/*.test.js"` |
| Integration tests | fencing, crash recovery, replay | `node --test "dist/tests/integration/*.test.js"` |
| Security regression tests | isolation, redaction, cost policy, approvals | `node --test "dist/tests/security/*.test.js"` |
| Adversarial execution tests | hostile adapters and malformed outcomes | `node --test "dist/tests/adversarial/*.test.js"` |
| Architecture regression tests | boundaries, ownership, dependency wiring | `node --test "dist/tests/architecture/*.test.js"` |
| Real HTTP integration tests | SDK against a bound socket, end to end and registry accuracy | `tests/e2e`, `tests/architecture/capabilities.test.ts` |
| Capability registry accuracy | every composed adapter is listed with truthful availability and isolation | `tests/architecture/capabilities.test.ts` |
| OpenAPI drift | committed document equals the generator | `npm run gate:openapi` |
| SDK compatibility | every operation is called on its published method and path; no second contract | `npm run gate:sdk` |
| Route registration completeness | every catalogue operation has exactly one handler and is reachable | `npm run gate:registration` |
| Dependency wiring | the container names missing dependencies; composition selects the durable stores | `npm run test:architecture` |
| Unused or disconnected capability | unreachable modules and unreferenced runtime exports fail; there are no exemptions | `npm run gate:reachability` |
| Architecture boundaries and single authority | one router, supervisor, planner, scheduler, workflow engine, event bus, registry and per-domain store | `npm run gate:structure` |
| Release compatibility | package versions equal `CONTRACT_VERSION`, only `dist` is packed, and the SDK range accepts the contract version | `npm run gate:release` |
| Dependency vulnerability scan | `npm audit` at high and critical, runtime and development | `npm run gate:audit` |
| Dependency manifest and lockfile integrity | https resolution + integrity for every package, no install scripts, reviewed direct dependencies | `npm run gate:dependencies` |
| Package artifact integrity | entry points, emitted JS and declarations, resolvable imports, private packages | `npm run gate:artifacts` |
| Model cost-policy enforcement | paid model refused, `allowPaid` not representable, daily budget fails closed | `tests/security/cost.test.ts` |
| Private/cloud isolation | memory, workspace and agent isolation partitions | `tests/security/isolation.test.ts`, `tests/security/findings.test.ts` |
| Generation fencing | stale token and stale generation cannot write | `tests/integration/fencing.test.ts`, `tests/unit/fencing.test.ts` |
| Crash recovery | a dead lease becomes `interrupted`; resume works; a release failure does not strand | `tests/integration/recovery.test.ts` |
| Event ordering and replay | ordered, deduplicated, cursor-bounded replay; SSE closes on the terminal event | `tests/integration/replay.test.ts` |
| Approval enforcement | exact task/scope/resource, expiry, no implicit grant from `approval.required` | `tests/security/approval.test.ts` |
| Scheduling deduplication | two independently composed replicas cannot both acquire one lease; real MongoDB arbitration | `tests/integration/mongo-live.check.ts` |
| Cross-replica quota | **not yet enforceable on `main`**; the durable budget store arrives with PR #2 and the lane must be added there | blocked dependency |
| Durable termination claims | evidence is required before a run is reported terminated; supervisor work in PR #5 | dependency |

`npm run gate` runs all static gates in sequence; `verify` adds the build and the
test suites. `npm run gate:audit` needs registry access, so it is its own job.

## Architecture regressions the gate prevents

- **A competing model router.** A model-routing declaration
  (`createModelCatalog`, `createModelRouter` or a model-scoped `createRouter`) may
  exist exactly once. Only the composition root constructs it. Provider SDKs and
  HTTP clients may live only under `src/models/providers/`; every other outbound
  `fetch` is a finding.
- **A duplicate execution supervisor.** At most one `create*Supervisor` may be
  declared or constructed. PR #5 and the security-remediation branch currently
  define different supervisors at the same path; exactly one may survive review.
- **Multiple orchestration authorities.** Only `src/orchestration/service.ts` may
  create a task, start a run or write task state. `createApplicationService`,
  `createTaskRunner`, `createEventBus` and `createAgentRegistry` are declared once
  and constructed only by `src/bootstrap/compose.ts`.
- **Competing planners and schedulers.** One `create*Planner` may exist under
  `src/agents/`, and one `createTaskScheduler` may exist. The planner's wave
  function is not a task scheduler and is not counted as one.
- **Duplicate persistence services.** A per-domain Mongo store
  (`createMongo*Repository|Store|Adapter|Log|Table`) may be declared once per
  domain. A second task, event, budget, media or execution store fails.
- **Unauthorized inference paths.** `allowPaid: true` is unrepresentable; only
  `src/models` may decide a route; environment variables are read only at startup;
  the model layer may not import a caller, executor or store.
- **Unregistered capabilities.** Every catalogue operation has exactly one
  registered, reachable handler; every composed adapter must be listed by the
  capability registry with truthful availability and isolation.
- **Disconnected implementations.** A module not reachable from `src/main.ts` or a
  runtime export nothing references is a failure, not a warning.
- **Incompatible API and SDK contracts.** OpenAPI must match the generator byte
  for byte; the SDK must call the catalogue paths and import schemas from
  `@coderax/contracts`; release manifests must agree on the contract version and
  ship only `dist`.
- **Private/cloud leakage, unauthorized paid inference and permission bypasses.**
  Isolation, cost and approval suites exercise the boundaries, while the static
  gate refuses an agent importing persistence, models, events, memory or
  permissions at runtime.
- **Stale-generation execution and unverified termination.** Fenced writes reject
  a superseded token; adversarial tests require a malformed adapter outcome to
  settle as `protocol_error`, never as success.

The gate is verified negatively in `tests/architecture/structure.test.ts`: two
routers, two supervisors, two planners, two schedulers, duplicate task
persistence, a fetch outside the provider layer, an agent-to-persistence import, a
second route table, a hand-written `/v1` path and a paid switch each produce a
finding. `tests/architecture/release.test.ts` does the same for version drift,
source packing and a broken SDK range. A gate that cannot fail is not a gate.

### Removed disconnected debt

The previous revision reported `src/execution/retry.ts` and
`adaptMongoWorkRunMethods` as warnings. Keeping an unwired module "for a future
migration" is still a capability the product cannot use, so both were removed and
the gate now fails on any replacement. The parity matrix records bounded retry as
**Missing** rather than Simplified; that is the honest state, and PR #5/#2 may
reintroduce it only with a caller and a test.

## Reconciliation with the active implementation stack

The gate is based on `main` at `808dfd3` and does not modify any implementation
branch. The active branches are stacked, not independent:

| PR | Branch | Relationship | Gate interaction |
| --- | --- | --- | --- |
| #4 | `feat/zero-cost-model-router` | base router | supplies the one model-routing authority and provider layer |
| #2 | `feat/intelligence-core` | contains router work | supplies durable budget store; cross-replica quota lane waits for it |
| #5 | `feat/execution-supervisor` | contains router + intelligence merge | supplies the one execution supervisor and termination evidence |
| #3 | `feat/native-reasoning-planner` | independent | replaces `planner.ts` with `plan.ts`; one planner declaration survives |
| — | `feat/durable-events-integration` | independent | adds the event log; only the service writes task/event state |
| — | `feat/multimodal-creative-intelligence` | contains router work | adds media providers under the one provider boundary |
| — | `security/remediation-808dfd3` | parallel supervisor implementation | defines `createRunSupervisor`; must reconcile with PR #5 before either merges |
| — | release certification | adds `release-verify.yml` | runs this `verify` then the cross-repo compatibility matrix; complementary, not competing |

Merge order that keeps every required check meaningful:

1. Security remediation (including the approved Zod decision) lands first.
2. This quality-gate PR lands; it is green on the remediated dependency tree.
3. Router (#4), then supervisor (#5), then intelligence (#2), planner (#3),
   durable events and multimodal.
4. Release certification evaluates the resulting `main` commit.

A second quality-gate branch, `ci/permanent-quality-gates`, exists. It carries a
Zod 4 major upgrade and a parallel gate implementation; this branch supersedes the
gate portion and does **not** adopt the dependency upgrade, which belongs to the
security owner. Two gates must not merge, and the earlier branch should be closed
as superseded once this one is reviewed.

## Fake MongoDB versus real MongoDB

These are separate layers and the output says which one ran.

| Layer | What it is | Command | Evidence |
| --- | --- | --- | --- |
| Fake collection | `tests/fakes/mongo.ts` enforces unique indexes and cursor semantics in memory | `npm run test:mongo:fake` (also part of the unit/integration suites) | adapter and wiring semantics only |
| Real MongoDB | `tests/integration/mongo-live.check.ts` against an actual `mongod` through the official driver | `npm run test:mongo:live` (requires `CODERAX_TEST_MONGO_URI`) | real unique-index arbitration, fenced update, durable task row, and two independently composed replicas racing for one lease |

The live file is intentionally **not** named `*.test.ts`, so the default glob
cannot list it as skipped or imply it passed. `test:mongo:live` fails when the
environment variable is absent. The workflow starts a standard `mongo:7` service
container (free on a hosted runner) and runs the live check there.

No live MongoDB was contacted from the environment that produced this change: it
has neither Docker nor `mongod`. That is stated as a limitation, not inferred from
a green fake suite. The cross-replica lease assertion is written but has not been
executed here; it will execute in the `real MongoDB integration` job.

## Zero-cost and hosted runners

Every job uses `ubuntu-latest` with pinned `actions/checkout` and
`actions/setup-node` commits. There is no paid runner, no purchased minute, no
third-party paid action and no matrix expansion. The MongoDB service container is
a standard GitHub service on the hosted runner.

`docs/governance.md` records that this account's hosted jobs have previously not
started because of a billing restriction. If that persists, the workflow definition
is still the gate but the jobs do not run; the pull request says so and includes the
local command and result. Purchasing minutes is prohibited by the charter.

## Dependency vulnerability state: CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5

The scan is enforcing high and critical. At this head it reports one high advisory:

```
zod < 4.6.6
GHSA-mrhx-c7xc-m3w5 — Zod can exhaust memory while validating oversized constrained collections
patched: 4.6.6 (npm proposes zod 4.6.7, a semver major)
```

Official sources:

- <https://github.com/advisories/GHSA-mrhx-c7xc-m3w5>
- <https://nvd.nist.gov/vuln/detail/CVE-2023-54404>
- <https://github.com/colinhacks/zod/pull/6652>

The advisory describes `$ZodArray` accumulating one issue per failing element when
an array schema has no length constraint, so memory grows with attacker input.
CVSS is 7.5 (v3) / 8.2 (v4). The CNA and VulnCheck have since **rejected**
CVE-2023-54404 as expected validator behavior that is only reachable without an
application request-size limit; the GitHub advisory remains published and has not
been withdrawn, and `npm audit` still flags it. This gate treats the advisory as
blocking rather than silently ignoring a disputed one.

What this engine already does:

- The HTTP server caps a request body at 1 MiB and returns a typed 413.
- Contracts are parsed after that cap; the SDK parses trusted engine responses.
- No schema upgrade is made here. A Zod 4 migration changes the contracts
  OpenAPI generator (it reads Zod 3 internals) and therefore the published
  document, so it is a **security-owner decision**, not a CI-side bump.

Required remediation checks, owned by the security owner and run by this gate
after the upgrade:

1. `npm run build` — schema types still compile.
2. `npm run test:contract` and `npm run test:security` — runtime payloads still
   accept and reject the same inputs.
3. `npm run gate:openapi` — the generated document is intentional and committed.
4. `npm run gate:sdk` and `npm run gate:release` — the SDK still calls the
   published contract and the package manifests still agree.
5. `npm pack --dry-run --workspace @coderax/contracts` and `.../@coderax/sdk` —
   the packed artifacts still contain only `dist`.

Until that lands, the `dependency vulnerability scan` job is red by design. Do not
lower the threshold and do not merge this gate ahead of the remediation.

## Limits, stated plainly

- Branch protection and rulesets are unavailable on this private repository's plan;
  the equivalent process policy is in `docs/governance.md`. CI cannot force a merge
  rule that the platform does not offer.
- The event bus is process-local. Replay is correct within a process and across a
  client reconnect; replay across a process restart is still missing (parity row 22).
  The durable-events PR supplies the store, not a claim in this gate.
- Cross-replica quota enforcement is **not** present on `main`. PR #2's Mongo budget
  store is the dependency; until it merges, this gate does not run a quota lane and
  does not claim distributed enforcement.
- Scheduling deduplication is proven at the lease layer by the live database check.
  The supervisor's duplicate-execution refusal (PR #5) is a separate, later lane.
- Termination is not claimed as verified on `main`; the supervisor PR supplies the
  evidence model and its tests.
- The real database job needs a hosted MongoDB service container. It was not run in
  the environment that authored this change.
- No hosted workflow run is claimed here. The local `npm run verify` result is the
  executed evidence; the workflow is the permanent gate for future pushes.

## Adding a capability

1. Declare the operation in `packages/contracts/src/routes.ts`.
2. Register it in `src/api/routes.ts`; the startup gate and `gate:registration` both
   fail if it is missing.
3. Extend `packages/sdk`; `gate:sdk` fails if an operation has no compatibility
   probe, so add the call to `scripts/gate/sdk.ts`.
4. Regenerate `openapi.json` with `npm run openapi:write`.
5. Wire collaborators by name in `src/bootstrap`; `gate:reachability` fails on an
   unreachable module or an unused runtime export.
6. Run `npm run verify`.

A new direct dependency must be added to the reviewed allowlist in
`scripts/gate/dependencies.ts` with a reason, and must be free of install scripts
and resolvable over https with an integrity hash in the lockfile.

## Ownership and coordination

The gate is CI-owned. It exercises execution, persistence, intelligence and SDK
through their public composition boundaries and does not modify their active
branches.

| Area | Gate coverage | Owner-facing note |
| --- | --- | --- |
| Execution and orchestration | fencing, recovery, replay, cancellation, adversarial adapters, one supervisor | PR #5 and the security branch must converge on one supervisor before merge |
| Persistence | fake versus real MongoDB, fenced writes, index bootstrap, per-domain store uniqueness | the live job needs a database; no fake result is called durable |
| Intelligence and models | cost policy, single route authority, provider egress, private mode, budget | PR #2 supplies durable quota; PR #4 supplies the router |
| Scheduling | one scheduler, lease arbitration across replicas | full supervisor deduplication is verified in PR #5 |
| SDK and contracts | OpenAPI drift, SDK path/method coverage, release manifests | adding an operation requires a probe, regenerated document and packed `dist` |
| Release certification | `gate:release` | complementary to `release-verify.yml`; this gate proves package/contract agreement, certification proves cross-repository compatibility |

Review ownership remains the repository-wide code-owner entry in
`.github/CODEOWNERS`; gate files are ordinary reviewed source.
