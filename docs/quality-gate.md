# Quality gate

The acceptance gate is `npm run verify`. It is the permanent, reviewable contract
for this repository: the same command runs locally and in
[`.github/workflows/verify.yml`](../.github/workflows/verify.yml).

```bash
npm ci --ignore-scripts
npm run verify
CODERAX_TEST_MONGO_URI=mongodb://127.0.0.1:27017/coderax_gate npm run test:mongo:live
```

`verify` runs the TypeScript project-reference build, every compiled test suite
and every static gate in one command. Each control is also available on its own so
a failing CI step names the concern instead of dumping one opaque failure. There
is no repository-wide exception, skip or lowered threshold in this path.

## What each control proves

| Control | Gate | Command |
| --- | --- | --- |
| TypeScript compilation | `tsc -b` across contracts, SDK and engine | `npm run build` |
| Unit tests | `tests/unit` | `node --test "dist/tests/unit/*.test.js"` |
| Contract tests | `tests/contract` | `node --test "dist/tests/contract/*.test.js"` |
| Integration tests | fencing, crash recovery, replay | `node --test "dist/tests/integration/*.test.js"` |
| Security regression tests | isolation, redaction, cost policy, approvals | `node --test "dist/tests/security/*.test.js"` |
| Adversarial execution tests | hostile adapters and malformed outcomes | `node --test "dist/tests/adversarial/*.test.js"` |
| Architecture regression tests | boundaries, ownership, semantic authority, dependency wiring | `node --test "dist/tests/architecture/*.test.js"` |
| Real HTTP integration | SDK against a bound socket, end to end and registry accuracy | `tests/e2e`, `tests/architecture/capabilities.test.ts` |
| Capability registry accuracy | every composed adapter is listed with truthful availability and isolation | `tests/architecture/capabilities.test.ts` |
| OpenAPI drift | committed document equals the generator | `npm run gate:openapi` |
| SDK compatibility | every operation is called on its published method and path; no second contract | `npm run gate:sdk` |
| Route registration completeness | every catalogue operation has exactly one handler and is reachable | `npm run gate:registration` |
| Architecture boundaries and cardinality | one declaration per decision authority; no illegal import edge; no import cycle | `npm run gate:structure` |
| Semantic capability authority | one value whose type satisfies each capability contract, regardless of factory name | `npm run gate:authority` |
| Gate coverage | every compiled test belongs to an executed layer; every live check is referenced | `npm run gate:coverage` |
| Unused or disconnected capability | unreachable modules and unreferenced runtime exports fail; no exemptions | `npm run gate:reachability` |
| Dependency vulnerability scan | machine-readable `npm audit`; high and critical fail; registry failure fails | `npm run gate:audit` |
| Dependency manifests and lockfile | https resolution + integrity for every package, no install scripts, reviewed direct dependencies | `npm run gate:dependencies` |
| Package artifact integrity | entry points, emitted JS and declarations, resolvable imports, private packages | `npm run gate:artifacts` |
| Release compatibility | versions equal `CONTRACT_VERSION`, only `dist` packed, SDK range accepts the contract | `npm run gate:release` |
| Real MongoDB | index bootstrap, two-replica leases, fencing, idempotency, isolation, recovery, notifications | `npm run test:mongo:live` |
| Model cost policy | paid model refused, `allowPaid` not representable, daily budget fails closed | `tests/security/cost.test.ts` |
| Private/cloud isolation | memory, workspace and agent isolation partitions | `tests/security/isolation.test.ts` |
| Generation fencing | stale token and stale generation cannot write | `tests/integration/fencing.test.ts`, `tests/unit/fencing.test.ts` |
| Crash recovery | a dead lease becomes `interrupted`; resume works | `tests/integration/recovery.test.ts`, live lane |
| Graceful shutdown | in-flight checkpoint writes drain before persistence closes; scheduler idles before the client closes | `tests/integration/mongo-live.check.ts` restart case |
| Event ordering and replay | ordered, deduplicated, cursor-bounded replay; SSE closes on the terminal event | `tests/integration/replay.test.ts` |
| Approval enforcement | exact task/scope/resource, expiry, no implicit grant | `tests/security/approval.test.ts` |
| Scheduling deduplication | two independently composed replicas cannot both acquire one lease | `tests/integration/mongo-live.check.ts` |

`npm run gate` runs all static gates, including the audit. `verify` adds the build
and every test suite. The live MongoDB lane is a separate command and a separate
CI job because it needs a server; it is never presented as part of a green
in-memory run.

## One authority per decision

Two layers enforce ownership, because neither is sufficient alone:

- **Cardinality (`gate:structure`)** counts declarations across the tree. A second
  `create*Supervisor`, `create*Planner`, `createTaskScheduler`,
  `createApplicationService`, `createTaskRunner`, `createEventBus`,
  `createAgentRegistry`, model-routing declaration or per-domain Mongo store is a
  finding. It also counts construction sites: only `src/bootstrap/compose.ts`
  constructs an authority, and only `src/orchestration/service.ts` starts a run,
  claims a lease, creates a task or writes task state.
- **Semantic type analysis (`gate:authority`)** asks TypeScript's checker which
  exported values satisfy a capability contract (`ModelRouter`, `ModelCatalog`,
  `BudgetLedger`, `TaskRunner`, `TaskScheduler`, `EventBus`, `ApplicationService`,
  HTTP `Router`, `RouteRegistry`, `Planner`, `ExecutionSupervisor`,
  `RunSupervisor`). Renaming a factory cannot evade it; a provider adapter
  returning `ProviderAdapter` is not a router; the memory and Mongo persistence
  drivers share a repository type by design and are not decision authorities.

The capability list is additive: a contract that does not exist yet is skipped,
and enforcement begins the moment a branch introduces it. That is what lets this
gate land before the router and supervisor branches without failing for absence.

### Model router determination from the composition roots

This was inspected, not inferred from factory names:

- **PR #4 (`feat/zero-cost-model-router`) is the authoritative router.**
  `src/models/catalog.ts` no longer selects anything; it re-exports the router's
  read port (`export type { ModelCatalog } from './router.js'`), and the
  composition root constructs only `createModelRouter`.
- **PR #2/#5/#8 carry the older `createRouter`.** Their `createRouterCatalog(router)`
  is a read-only projection (list/route/resolve) over that router, so the gateway
  records it as supporting, not as a second decision. The decision is
  `createRouter`, and it competes with PR #4's `createModelRouter`.
- Therefore: catalogue + router are complementary; two decision contracts are not.
  The semantic gate rejects PR #2's router and PR #5/#8's copies once PR #4 lands,
  and a fixture test (`tests/architecture/authority.test.ts`) proves both the
  projection case and the competing-decision case.

## Consolidation of the two quality-gate branches

Two competing gate branches existed. Exact heads were fetched and compared:

| Branch | Head inspected | Verdict |
| --- | --- | --- |
| `ci/permanent-quality-gate` | `21015a7` (this branch before this document) | **surviving implementation** |
| `ci/permanent-quality-gates` | `c6baf77` (was `7ce5cd6` when first compared) | superseded after its unique work was adopted |

The surviving branch already had the broader suites (180 compiled tests), explicit
per-concern gates, fail-closed reachability, OpenAPI/SDK/registration/artifact
release checks and the real-Mongo lane. The superseded branch had four stronger
components, all now incorporated and verified here:

1. **Semantic capability ownership** through the TypeScript checker
   (`scripts/gate/authority.ts`), instead of relying only on regex cardinality.
2. **Gate coverage**: every compiled test must belong to an executed layer and a
   live check must be referenced by a script (`scripts/gate/coverage.ts`).
3. **Machine-readable dependency audit** that refuses to pass when the registry
   returns no metadata (`scripts/gate/audit.ts`).
4. **Zod 4 correction implementation** and additional live-database scenarios
   (index bootstrap, restart persistence, recovery, notifications), merged into
   the existing lane.

No third gate branch was created. `ci/permanent-quality-gates` should be closed as
superseded; its head remains useful evidence but must not merge as a second gate.

## Dependency advisory resolution

The blocking advisory was verified against authoritative sources before the
upgrade, not against a summary:

- OSV/GitHub advisory **GHSA-mrhx-c7xc-m3w5**, alias **CVE-2023-54404**;
  package `zod`, affected `< 4.6.6`, fixed `4.6.6`, severity HIGH (CVSS 7.5 v3 /
  8.2 v4). OSV still lists it as published and GitHub-reviewed on 2026-10-23.
- npm `zod` latest is **4.6.7**; 4.6.6 is the first patched release.
- The CNA/VulnCheck dispute about the CVE classification is recorded, but it is not
  used to suppress the advisory.

Resolution in this branch:

- `zod` is `^4.6.7` in the root, `@coderax/contracts` and `@coderax/sdk`; the lock
  resolves 4.6.7.
- `packages/contracts/src/json-schema.ts` reads Zod 4's `_zod.def` (and still
  understands `_def`), so the OpenAPI generator cannot silently emit `{}` for an
  unfamiliar schema.
- Nested configuration defaults use `.prefault({})`, which Zod 4 requires before
  nested defaults are parsed.
- The 1 MiB HTTP body cap and typed 413 remain as defence in depth; the upgrade
  does not replace transport-level bounds.

Verified result at this head:

```text
npm run verify                          exit 0
tests 182, pass 182, fail 0, skipped 0
gate:openapi                            clean (openapi.json byte-identical)
gate:authority                          clean
gate:audit                              clean (critical=0 high=0 moderate=0 low=0)
npm run test:mongo:live                 6/6 against mongod 7.0.14
```

## Real MongoDB coverage

The lane is `tests/integration/mongo-live.check.ts`. It is deliberately not named
`*.test.ts`, so the default glob cannot list it as skipped. It requires
`CODERAX_TEST_MONGO_URI` and fails without it; there is no in-memory substitute in
this lane. The unit suites in `tests/unit/mongo-*.test.ts` use a fake collection and
are labelled as such.

| Required area | State in this lane |
| --- | --- |
| Concurrent replica execution | lease arbitration proven with two independently built persistence stacks; two simultaneous schedulers are not instrumented |
| Generation fencing | covered: stale token → `superseded`, terminal → `terminal`, two-store reissue race → one generation |
| Durable approvals | **blocked**: approvals are process-local on this base; PR #2/PR #7 own the durable store and must add the live case |
| Idempotent submissions | covered: duplicate task id → `exists`, second live task in one conversation → `conversation_busy` |
| Atomic quotas | **blocked**: the budget ledger is process-local; PR #2's Mongo budget store owns the live case |
| Artifact reference counting | **blocked**: no artifact store on this base; `feat/durable-artifacts` owns it |
| Crash recovery | covered: expired running generation is recovered to `interrupted`, then resumed to `completed` |
| Conversation isolation | covered: owner-scoped read, cross-owner id collision refused, messages scoped by conversation |
| Event replay | **blocked**: the event bus is process-local; `feat/durable-events-recovery`/`-integration` own the durable log |
| Scheduled execution | **blocked**: durable schedules arrive with PR #9/PR #7 |
| Notification recovery | covered: record on one replica, unread on a second, mark-read visible on the first |
| Distributed leases | covered: unique index, expired-only claim, token fence, durable cancel |

Index assertions (`work_run_key`, `task_id`, `conversation_id`, `message_id`,
`notification_task`, `memory_partition`) are part of the lane, so a store that
boots without its unique constraints fails. The CI job uses a standard `mongo:7`
service container on a hosted runner and an ephemeral database with no production
credentials or data.

## Hosted CI: what actually happens

The previous revision of this document said hosted Actions never ran. That was
wrong and is corrected here from the public API:

- The repository has one workflow, `verify`, state **active**, and **52 completed
  runs**. Green runs exist at the heads of PRs #2 (`e14e4b7`), #3 (`90b87db`),
  #4 (`b6e002b`), #5 (`13d4b4f`), #7 (`9b4cb5c`), #8 (`ffec08f`) and #9 (`d1f4b50`).
- There were zero runs at this branch's earlier head because the triggers were
  `pull_request` and `push: [main]`, and no pull request existed for the branch. A
  feature-branch push alone is not a trigger; that is an absence of a request, not
  an Actions outage, billing restriction or fork-approval problem.
- This change adds `ci/**` to the push trigger so a gate branch verifies at its
  exact head before it starts rejecting other branches.
- **A green run at an existing PR head does not prove this gate.** Until this
  branch merges, those PRs run `main`'s older workflow (build + all tests +
  `openapi:check`), which does not include the semantic authority, coverage, audit
  or live-database jobs. They will run the full gate only after rebasing onto the
  merged gate.

The result at the exact final head of this branch is recorded in the pull request
and must be read from the run, not inferred from an earlier SHA.

## Reconciliation and merge order

The complete branch matrix, exact SHAs, dependencies and conflicts are in
[`docs/architecture-compatibility.md`](./architecture-compatibility.md); the
executable order is in [`docs/merge-plan.md`](./merge-plan.md). The short form:

1. This gate (with the Zod remediation) lands first.
2. PR #4 lands as the one model-routing authority.
3. Security remediation rebases onto both; PR #5/#8 drop their router and converge
   on one supervisor (`ExecutionSupervisor`, not `RunSupervisor`).
4. Contract v1.1 (PR #7) reconciles its schedule/artifact/memory surface with the
   domain owners, then lands; PR #2/#3/#8/#9 rebase onto it.
5. Durable events, records/read models, artifacts, multimodal, artifact
   intelligence, games and operability follow in their stated order.
6. Release certification evaluates the resulting `main`; it is not a second gate.

No pull request is required to wait for every other branch: each increment is
independently testable against the gate after its stated dependencies.

## Limits, stated plainly

- Creating the pull request and obtaining an independent approval require the
  owner's GitHub credential; this environment has no PR-creation authorization.
  The compare link is the handoff. A branch push verifies, but it cannot approve.
- Branch protection and rulesets depend on the repository plan; the process policy
  is in `docs/governance.md`. CI cannot enforce a rule the platform does not offer.
- The event bus, budget ledger and approvals are process-local on this base. The
  live lane names those as blocked rather than claiming them.
- Cross-replica quota enforcement is not present on `main`; PR #2 supplies the
  durable ledger and must add its live assertion.
- Cloud Browser and Computer Use have no published branch; they are unavailable,
  not silently marked done.
- Successful packaging is not release readiness. `gate:release` proves manifest and
  contract agreement only; cross-repository certification remains the release
  owner's lane.

## Adding a capability

1. Declare the operation in `packages/contracts/src/routes.ts`.
2. Register it in `src/api/routes.ts`; startup and `gate:registration` fail if it
   is missing.
3. Extend `packages/sdk`; add the compatibility probe in `scripts/gate/sdk.ts`.
4. Regenerate `openapi.json` with `npm run openapi:write`; never hand-edit it.
5. Wire collaborators by name in `src/bootstrap`; `gate:reachability` fails on an
   unreachable module or an unused runtime export.
6. If it is a new decision authority, add its contract to `CAPABILITIES` in
   `scripts/gate/authority.ts` and a broken-fixture test.
7. Run `npm run verify` and, for a durable store, `npm run test:mongo:live`.

A new direct dependency must be added to the reviewed allowlist in
`scripts/gate/dependencies.ts` with a reason, and must be free of install scripts
and resolvable over https with an integrity hash in the lockfile.

## Ownership

The gate is CI-owned. It exercises execution, persistence, intelligence and SDK
through their composition boundaries and does not modify their active branches.
Review ownership remains the repository-wide code-owner entry in
`.github/CODEOWNERS`; gate files are ordinary reviewed source.
