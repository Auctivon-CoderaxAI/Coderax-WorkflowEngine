# Architecture ownership and compatibility matrix

This document is the review record for the permanent ownership gate. It is not a
merge instruction: active branches were inspected in detached worktrees and were
not modified. A finding is tied to the exact commit probed.

## Authoritative owners

| Capability | Authoritative owner | Contract |
| --- | --- | --- |
| Model routing and provider authorization | PR #4 `feat/zero-cost-model-router` | `src/models/router.ts` (`ModelRouter`/`Router`) |
| Native reasoning and planning | PR #3 `feat/native-reasoning-planner` | `src/agents/native/planner.ts` (`Planner`) |
| Execution supervision, fencing and termination | PR #5 `feat/execution-supervisor` | `src/execution/supervisor.ts` (`ExecutionSupervisor`) |
| Permission decisions | Security remediation plus PR #5's execution-scoped grant | `PermissionGate`; one decision chain after merge |
| Zero-cost quota ledger | PR #4 | `src/models/budget.ts` (`BudgetLedger`) |
| Durable artifacts | `feat/durable-artifacts` | `src/artifacts/service.ts` (`ArtifactService`) |
| Durable events and replay | `feat/durable-events-integration` | `src/events/log.ts` (`EventLog`), `src/events/bus.ts` (`EventBus`) |
| Durable scheduling | `feat/durable-scheduling` | `src/scheduling/engine.ts` (`ScheduleEngine`) |
| Multimodal media and creative generation | `feat/multimodal-creative-intelligence` | `src/media/service.ts`, `src/creative/service.ts` |
| Browser orchestration | Cloud Browser contract owner | no browser implementation is present in this repository yet |
| Shared SDK compatibility | `packages/sdk` | `SDK_OPERATIONS` must equal the route table |

The `AgentRegistry` is the one capability/agent discovery registry. Memory and
Mongo persistence drivers are not competing authorities; the same exception
applies to the permission-store and event-log drivers.

## Exact-head probe

Probe date: 2026-11-26. Method: detached worktree at the exact SHA, then
`checkArchitecture(loadRepository(root))` plus the type-based
`checkCapabilities(root)`. This is a static architecture probe, not a full test
run. `clean` means no architecture/capability finding, not that CI passed.

| Branch / PR | SHA | Findings | Classification and owner action |
| --- | --- | --- | --- |
| `feat/intelligence-core` (PR #2) | `e14e4b714a5091b51cd2d0598b2b17cca56435f3` | `boundary_models` `routed.ts`; disconnected `arbiter`/`retry`; duplicate catalogue/router/planner; unused planner/MCP | Verified boundary and duplicate violations. Remove the superseded deterministic planner and legacy catalogue, move the routed model types behind the models port, adopt the retry removal, and wire or delete the MCP client. |
| `feat/native-reasoning-planner` (PR #3) | `90b87db7832cd948e801e01c3cf9ce97409bb068` | disconnected `arbiter`/`retry` | Superseded helpers; rebase after the main-branch removal. Capability-clean otherwise. |
| `feat/zero-cost-model-router` (PR #4) | `b6e002bc11c4a402c04d652681f75744cf428d65` | disconnected `arbiter`/`retry` | Superseded helpers; rebase. This is the declared model-routing owner and is capability-clean. |
| `feat/execution-supervisor` (PR #5) | `13d4b4f7796f819e4e58bd18006efc4970929e6e` | `boundary_models` `routed.ts`; disconnected `arbiter`/`retry`; unused planner/MCP/catalogue; duplicate planner/router | Verified duplicate violations. Keep the supervisor, remove the legacy catalogue/deterministic planner, and make the execution gateway the only provider path. |
| `pull/7/head` | `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f` | disconnected `arbiter`/`retry`; missing live artifact suite | Contract/artifact work branch; rebase the superseded helpers and add the standardized live artifact test before using it as a release input. |
| `feat/native-team-orchestration` (PR #8) | `3c6d1ce1c030f5f47792457fcab05135f301ef33` | `boundary_models` `quota.ts`/`routed.ts`; disconnected `arbiter`/`retry`; `single_run_dispatch` `team.ts`; unused planner/MCP/catalogue; duplicate planner/router; missing live event suite | Verified boundary, direct-dispatch and duplicate violations. Team dispatch must go through `ApplicationService`; team quota/routing types must not enter models directly; add the live event test. |
| `feat/durable-scheduling` (PR #9) | `e126c480074285708fbe3ed3828fad8ca659f8e4` | disconnected `arbiter`/`retry`; `single_construction_root` `service.ts`; missing live schedule suite | Verified composition-root violation and superseded helpers. Construct `ScheduleEngine` in the configuration root and expose a durable schedule port to orchestration; add the live deduplication/recovery test. |
| `feat/durable-recovery` | `f722ba35f79f33b0afb62d71715a2586202ec296` | missing live event suite | Architecture/capability-clean. Add the standardized replay/recovery live test; it is not an event-delivery owner until it does. |
| `feat/artifact-intelligence` | `c9bac16b0bd78252d39282853bd9ef842b8f228c` | disconnected `arbiter`/`retry`; missing live artifact suite | The subprocess in `artifacts/software.ts` is a legitimate software-generation adapter only behind the permission/supervision seam; add that runtime evidence. Rebase the superseded helpers and add the standardized live suite. |
| `feat/durable-artifacts` | `fd5edef2a2cfc83850fa43b19a813676c352bb92` | disconnected `arbiter`/`retry`; missing live artifact suite | Capability-clean, superseded helpers. Five real-Mongo concurrency tests were independently run at this SHA against a disposable real server: 5 passed, 0 failed, 0 skipped. They are still in the integration gate and use `CODERAX_TEST_MONGODB_URI`, so they can skip there; add `tests/live/artifacts.test.ts` with the standard `CODERAX_TEST_MONGO_URI` before merge. |
| `feat/durable-events` | `9b3fd7dacd4ad750989c621565c8168b1290134d` | disconnected `arbiter`/`retry` | Superseded helpers; event capability not yet integrated here. |
| `feat/durable-events-integration` | `2554edcfd99d85ab6e330f948663490460757017` | disconnected `arbiter`/`retry`; missing live event suite | Capability-clean after the Mongo event-log driver is treated as a driver. Add the live replay/notification test when this becomes the owner branch. |
| `feat/durable-events-recovery` | `db289d2a9f1a1648f1101666c0f15353f87b3925` | disconnected `arbiter`/`retry` | Superseded helpers; recovery evidence belongs with durable events. |
| `feat/multimodal-creative-intelligence` | `c0cfa993ef2d890b7abf4e2d33506c9f34214c85` | disconnected `arbiter`/`retry`; missing live media/creative suites | Capability-clean, superseded helpers. It has media/creative source but no standardized live tests; the live-coverage gate will require them on merge. |
| `feat/multimodal-intelligence-core` | `5dd5e66c6501b6bda0ff2a051875dc5a566acb82` | `boundary_models`; disconnected; duplicate catalogue/router/planner; unused planner/MCP | Superseded by the creative branch for this capability; do not merge both router/planner shapes. |
| `feat/native-game-studio-gaming-agent` | `ce271b9784c2267266eade8a6ad56912123bd65b` | disconnected; duplicate planner; missing live artifact suite | Rebase the helpers, choose the native planner owner, and add the artifact live test. |
| `feat/operability-evidence` | `5d2afd10a000fe79fe7e61c9527336822492aa00` | disconnected | Rebase the superseded helpers; capability-clean otherwise. |
| `feat/persistent-records` | `b5818f447a5910af3867e81fc9e9675ab4e39784` | disconnected | Rebase the superseded helpers; capability-clean otherwise. |
| `feat/read-model-api` | `4626b846f3a85f91708b78354c1fa9a049c89437` | disconnected | Rebase the superseded helpers; capability-clean otherwise. |
| `security/remediation-808dfd3` | `74b1264c1b20df24f80e20cc6c0c7d08db02a7c5` | disconnected | Security baseline; rebase the superseded helpers and preserve its runnable CVE proof. |
| `security/remediation` | `4b2ea758d9fab4d04bff380651ed8a6b38708912` | disconnected | Documentation/evidence branch based on an older integration; rebase the superseded helpers and use the current contract evidence, not its older route/report counts. |
| `contract/authoritative-v1.1` | `ea660285b3c0a950067aa3b57f1764ccb509af8a` | disconnected | Contract proposal; it must import the authoritative route catalogue rather than define a second one, and be rebased for the superseded helpers. |
| `ci/permanent-quality-gate` | `21015a7f7484dda8a6b9951e52782a8bd8921d01` | clean | Competing one-commit gate. Inspected and retained as historical evidence; its unique pinned-action, lockfile-integrity and release-range checks were integrated into the surviving `ci/permanent-quality-gates` gate. Not overwritten. |

`arbiter.ts`/`retry.ts` are superseded on every branch that has not rebased on
this branch's removal. They are reported as dead modules, not wired in merely to
make a check green. Legitimate retry/recovery belongs to the durable scheduling
and durable events owners.

The durable-artifacts probe used a disposable real MongoDB, because the branch's
fixture reads `CODERAX_TEST_MONGODB_URI` first. It ran only the five concurrency
tests, not the claimed 147-test total; 5/5 passed with zero skips. That is useful
coordination evidence, not a substitute for the owner's exact-head CI or the
standardized live lane.

## Negative controls

`tests/architecture/capabilities.test.ts` proves renamed factories, indirect
construction, class implementations and wrapper factories are still counted,
while a `ProviderAdapter` is not a router. `tests/architecture/graph.test.ts`
proves dynamic imports, factory aliases, alternate composition roots, HTTP
clients, provider SDKs and subprocesses are rejected; the inbound API server,
tools, MCP, provider adapters and artifact/media/browser seams remain legal.
`tests/architecture/wiring.test.ts` checks the runtime container's exact keys and
the single route/model/agent registration surface.

## What this matrix does not establish

It is not a full build/test result for any unmerged branch, and it does not
replace the hosted MongoDB lane. A branch classified `clean` still needs its own
exact-head CI, live database evidence and independent review. The WorkflowEngine
cannot certify Coderax or CoderaxCLI from this repository alone; the ecosystem
release owner must consume the shared contract/OpenAPI/SDK evidence and run the
consumer side.
