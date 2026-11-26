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
| Integration tests | `tests/integration` | `node --test "dist/tests/integration/*.test.js"` |
| Security regression tests | `tests/security` | `node --test "dist/tests/security/*.test.js"` |
| Adversarial execution tests | `tests/adversarial` | `node --test "dist/tests/adversarial/*.test.js"` |
| Architecture regression tests | `tests/architecture` | `node --test "dist/tests/architecture/*.test.js"` |
| End-to-end tests | `tests/e2e` | `node --test "dist/tests/e2e/*.test.js"` |
| OpenAPI drift | committed document equals the generator | `npm run gate:openapi` |
| SDK compatibility | every operation is called on its published method and path; no second contract | `npm run gate:sdk` |
| Route registration completeness | every catalogue operation has exactly one handler and is reachable | `npm run gate:registration` |
| Dependency wiring | the container names missing dependencies; composition selects the durable stores | `npm run test:architecture` |
| Unused or disconnected capability | unreachable modules and unreferenced runtime exports | `npm run gate:reachability` |
| Architecture boundaries | agents/storage/router/model-runner edges, single owners, no cycles | `npm run gate:structure` |
| Dependency vulnerability scan | `npm audit` at high and critical, runtime and development | `npm run gate:audit` |
| Dependency manifest and lockfile integrity | https resolution + integrity for every package, no install scripts, reviewed direct dependencies | `npm run gate:dependencies` |
| Model cost-policy enforcement | paid model refused, `allowPaid` not representable, daily budget fails closed | `tests/security/cost.test.ts` |
| Private/cloud isolation | memory, workspace and agent isolation partitions | `tests/security/isolation.test.ts`, `tests/security/findings.test.ts` |
| Generation fencing | stale token and stale generation cannot write | `tests/integration/fencing.test.ts`, `tests/unit/fencing.test.ts` |
| Crash recovery | a dead lease becomes `interrupted`; resume works; a release failure does not strand | `tests/integration/recovery.test.ts` |
| Event replay | ordered, deduplicated, cursor-bounded replay; SSE closes on the terminal event | `tests/integration/replay.test.ts` |
| Approval enforcement | exact task/scope/resource, expiry, no implicit grant from `approval.required` | `tests/security/approval.test.ts` |
| Package artifact integrity | entry points, emitted JS and declarations, resolvable imports, private packages | `npm run gate:artifacts` |

`npm run gate` runs all static gates in sequence; `verify` adds the build and the
test suites. `npm run gate:audit` needs registry access, so it is its own job.

## Architecture regressions the gate prevents

- A second model router: `createModelCatalog` and `createBudgetLedger` may be
  constructed only in the composition root; only `src/models` may read a cost
  class or decide a route.
- A competing workflow engine: only `src/orchestration/service.ts` may create a
  task, start a run or write task state; `createTaskRunner` is constructed only by
  the composition root; `createRouteRegistry`/`createRouter` exist once.
- An unregistered service: every factory and runtime export must be reachable from
  `src/main.ts`; a module or export that nothing references fails the gate.
- An incompatible API contract: OpenAPI must match the generator byte for byte;
  every operation must be registered and reachable; the SDK must call the
  catalogue paths and import its schemas from `@coderax/contracts`.
- A hand-written route path, a provider call outside the gateway, a process spawn,
  an environment read outside startup, an import cycle, or an agent reaching
  persistence or orchestration.

The gate is verified negatively in `tests/architecture/structure.test.ts`: a
synthetic agent-to-persistence import, a second route table, a second run starter,
a hand-written `/v1` path and a paid switch each produce a finding. A gate that
cannot fail is not a gate.

### Known disconnected capabilities

Two items are reported as warnings on every run, never silently hidden:

| Item | Why it is kept | Gap |
| --- | --- | --- |
| `src/execution/retry.ts` | the bounded same-engine retry policy is preserved for the migration | orchestration does not invoke it; parity row 11 records the runtime gap |
| `adaptMongoWorkRunMethods` | adapter for the already-verified Coderax Work-run methods | no caller has adopted it yet |

A new orphan fails the gate. Removing these warnings requires wiring the module or
deleting it in a reviewed change — not adding an entry here.

## Fake MongoDB versus real MongoDB

These are separate layers and the output says which one ran.

| Layer | What it is | Command | Evidence |
| --- | --- | --- | --- |
| Fake collection | `tests/fakes/mongo.ts` enforces unique indexes and cursor semantics in memory | `npm run test:mongo:fake` (also part of the unit/integration suites) | adapter and wiring semantics only |
| Real MongoDB | `tests/integration/mongo-live.check.ts` against an actual `mongod` through the official driver | `npm run test:mongo:live` (requires `CODERAX_TEST_MONGO_URI`) | real unique-index arbitration, fenced update, durable task row |

The live file is intentionally **not** named `*.test.ts`, so the default glob
cannot list it as skipped or imply it passed. `test:mongo:live` fails when the
environment variable is absent. The workflow starts a standard `mongo:7` service
container (free on a hosted runner) and runs the live check there.

No live MongoDB was contacted from the environment that produced this change: it
has neither Docker nor `mongod`. That is stated as a limitation, not inferred from
a green fake suite.

## Zero-cost and hosted runners

Every job uses `ubuntu-latest` with `actions/checkout` and `actions/setup-node`.
There is no paid runner, no purchased minute, no third-party paid action and no
matrix expansion. The MongoDB service container is a standard GitHub service on
the hosted runner.

`docs/governance.md` records that this account's hosted jobs have previously not
started because of a billing restriction. If that persists, the workflow definition
is still the gate but the jobs do not run; the pull request says so and includes the
local command and result. Purchasing minutes is prohibited by the charter.

## Dependency vulnerability state

The scan is enforcing high and critical. At the head of the quality-gate change it
reports one high advisory:

```
zod  <4.6.6
GHSA-mrhx-c7xc-m3w5 — Zod can exhaust memory while validating oversized constrained collections
fix available: zod 4.6.7 (semver major)
```

It is **not** ignored. `zod` is a direct runtime dependency of the contracts, the
SDK and the engine. The fix is a zod 4 major migration; the contracts OpenAPI
generator reads zod 3 schema internals, so that migration also changes the generated
document and needs a contract-version decision from the contracts and SDK owners.
It is outside a CI-only change and is reported as a blocking follow-up in the pull
request. The engine's 1 MiB request-body cap limits the server-side exposure; the
SDK parses trusted engine responses, which does not remove the dependency risk.

## Limits, stated plainly

- Branch protection and rulesets are unavailable on this private repository's plan;
  the equivalent process policy is in `docs/governance.md`. CI cannot force a merge
  rule that the platform does not offer.
- The event bus is process-local. Replay is correct within a process and across a
  client reconnect; replay across a process restart is still missing (parity row 22).
  The gate does not claim otherwise.
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

The gate is CI-owned and touches no execution, persistence, intelligence or SDK
implementation branch. It exercises those areas through their public composition
boundaries:

| Area | Gate coverage | Owner-facing note |
| --- | --- | --- |
| Execution and orchestration | fencing, recovery, replay, cancellation, adversarial adapters | the only services constructed twice or started outside orchestration fail `gate:structure` |
| Persistence | fake versus real MongoDB, fenced writes, index bootstrap, lockfile | the live job needs a database; no fake result is called durable |
| Intelligence and models | cost policy, route ownership, private mode, budget | a second router or a paid switch fails the gate |
| SDK and contracts | OpenAPI drift, SDK path/method coverage, second-contract detection | adding an operation requires a probe and a regenerated document |

Review ownership remains the repository-wide code-owner entry in
`.github/CODEOWNERS`; gate files are ordinary reviewed source.
