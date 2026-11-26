# Architecture compatibility matrix

This is the reconciliation record for every published branch, not only the open
pull requests. It is the input to [`docs/merge-plan.md`](./merge-plan.md) and the
enforcement contract implemented by `scripts/gate/authority.ts`,
`scripts/gate/structure.ts` and `tests/architecture/authority.test.ts`.

Inspection date: 2026-11-26, refreshed after several PR heads moved. Every head
was fetched from `origin` and read at the exact commit below. `main` is
`808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`. Heads move; refresh before merging.

## Ancestry

Every feature/PR head is a **sibling** of `main`: its merge-base is `808dfd3`, and
no PR head is an ancestor of another. The single exception is
`feat/operability-evidence`, whose history contains `main` and adds documentation
only. Consequences:

- There is no forced merge order from Git ancestry; every order below is a
  coordination decision.
- Rebasing is expected, not optional: two branches that both modify
  `src/models/catalog.ts`, `src/models/router.ts` or `compose.ts` will conflict
  textually, and the gate rejects the semantic duplicate even if a textual merge
  succeeds.
- “Hosted CI green” at these heads was produced by `main`'s older workflow (build +
  all tests + OpenAPI), not by the consolidated gate. It is a baseline, not
  acceptance.

## Authority decisions

| Responsibility | Authoritative | Evidence | Competing / superseded |
| --- | --- | --- | --- |
| Model routing | **PR #4** `feat/zero-cost-model-router` | `createModelRouter` is the only decision; `catalog.ts` re-exports its read port | PR #2, #5, #8 carry a second 473-line `createRouter`; `feat/multimodal-creative-intelligence` also adds `createModelRouter` |
| API contract and SDK surface | **PR #7** `freebuff/5e5de30e…` (v1.1.0) | one versioned surface, shared SDK artifact, hosted CI green at head | `contract/authoritative-v1.1` (`ea66028`) is an older sibling surface; PR #9 also declares schedule operations |
| Execution supervisor | **PR #5** `ExecutionSupervisor` | one type, one factory, Chat + Work termination evidence | `security/remediation-808dfd3` defines `RunSupervisor`; PR #8 copies `ExecutionSupervisor` |
| Orchestration / durable events | `feat/durable-recovery` | newest head, event log + crash repair and 746 lines of recovery tests | `feat/durable-events-recovery` and `feat/durable-events-integration` are older siblings; `feat/durable-events` is stale (behind `main`, no PR) |
| Durable records | `feat/persistent-records` | checkpoints, idempotency, retention | `feat/read-model-api` duplicates checkpoints/idempotency/event log |
| Artifacts | `feat/durable-artifacts` | artifact repository, blob/capacity stores, versions | PR #7 declares artifact contracts; `artifact-intelligence` and the game branch assume a store |
| Scheduling | PR #7 owns the contract; PR #9 owns the engine | PR #9 has the durable repository/engine | PR #9 duplicates schedule operations already declared by PR #7 |
| Security remediation | `security/remediation` (`4b2ea75`) | newest head, isolation/revocation/redaction, already merged PR #4 | `security/remediation-808dfd3` (`74b1264`) keeps `RunSupervisor`; superseded |
| Release certification | `freebuff/4fc2…` (`6e70c5d`) | `release-verify.yml` + provenance manifests | none; it certifies an old `main`, so its evidence must be rerun |

The semantic gate treats a **catalogue** as the read port of a router once a
routing-decision contract exists. That is why PR #2/#5/#8's `createRouterCatalog`
is supporting while their `createRouter` and PR #4's `createModelRouter` are the
competing decisions.

## Matrix

Legend: **A** authoritative, **C** complementary, **D** duplicate that must be
removed on rebase, **S** superseded, **U** unavailable.

| Area | Ref | Head | PR | Status | Gate interaction | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Quality gate | `ci/permanent-quality-gate` | this branch | none yet | **A** | all controls | merge first; `ci/permanent-quality-gates` advanced to `d00156a` after adoption and is not reconciled: do not close or merge it as a second gate |
| Authoritative router | `feat/zero-cost-model-router` | `ade0a292258ae2451e0bfe5678a91989798f22b8` | #4 | **A** | supplies the one model-routing authority | merge after gate |
| Intelligence core | `feat/intelligence-core` | `c1bcf66e2c6ddc8c71e0ce61efae3de065a2d2a5` | #2 | **D** router, **A** tools/MCP/retrieval/approvals/quota | duplicate model router + `ModelCatalog` selector; durable budget/approval need live cases | rebase on #4, delete `src/models/router.ts` and selector, keep durable budget/approvals |
| Native reasoning planner | `feat/native-reasoning-planner` | `072c4371ed0190993468660e00fd20cf4827fccd` | #3 | **A** planner | planner cardinality; contract rebase | rebase on #4/#7; keep one planner |
| Execution supervisor | `feat/execution-supervisor` | `13d4b4f7796f819e4e58bd18006efc4970929e6e` | #5 | **D** router/catalog, **A** supervisor | `ExecutionSupervisor` must be the only supervisor; legacy router must go | rebase on #4, drop router copy, merge after security convergence |
| Multi-agent orchestration | `feat/native-team-orchestration` | `62b5eda14ebdc7344f946d5377dd19df721fe16b` | #8 | **D** router, **D** supervisor copy, **A** teams | teams plus a copied supervisor and legacy router | rebase on #5 and #4, delete copies |
| Contract v1.1 / SDK | `freebuff/5e5de30e8775a8e9225cc0e2` | `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f` | #7 | **A** contract surface | SDK probes, OpenAPI, release manifests, live memory/schedule/artifact stores | land after domain owners agree on operation ownership; do not let it add competing services |
| Older contract v1.1 | `contract/authoritative-v1.1` | `ea660285b3c0a950067aa3b57f1764ccb509af8a` | none | **S** | would be a second API surface | close after reconciling unique operations into #7 |
| Durable scheduling | `feat/durable-scheduling` | `6e05f1b7d2d4840d656c6f29654eeb023d9ff4a9` | #9 | **D** schedule contract duplicates, **A** engine | schedule operations declared twice; one schedule store/engine | rebase on #7; #7 owns contract, #9 owns repository/engine |
| Durable events (preferred) | `feat/durable-recovery` | `c3e94d7e7bfb6e0f20ba3fbdb68eae991ef940b2` | #10 | **A** event log/crash repair | event log durability, replay across restart | merge after the supervisor; add live replay case |
| Durable events (older recovery) | `feat/durable-events-recovery` | `db289d2a9f1a1648f1101666c0f15353f87b3925` | none | **S** | superseded by `durable-recovery` | reconcile any unique test, then close |
| Durable events (sibling) | `feat/durable-events-integration` | `2554edcfd99d85ab6e330f948663490460757017` | none | **S** | 18-line service difference from the older recovery head | reconcile into `durable-recovery`, then close |
| Durable events (stale) | `feat/durable-events` | `9b3fd7dacd4ad750989c621565c8168b1290134d` | none | **S** | behind `main`; no PR | close |
| Multimodal integration | `feat/multimodal-integration` | `79851b2e0ea6f71acb0272523cf6a59b8e29666a` | none | **C** integration vehicle | already merges #4's router with artifact service/toolkit/blob stores | choose one artifact vehicle with `feat/durable-artifacts`; delete the duplicate store |
| Durable artifacts | `feat/durable-artifacts` | `bf2e9b292257cae1247bd1df8f26630c2691205a` | none | **A** artifact store | reference counting, versions, capacity | open PR after contract/artifact operations agree |
| Multimodal intelligence | `feat/multimodal-intelligence-core` | `5dd5e66c6501b6bda0ff2a051875dc5a566acb82` | none | **A** multimodal intake | overlaps tools/MCP from #2 | rebase on #2 and #4; keep media only |
| Creative/media intelligence | `feat/multimodal-creative-intelligence` | `f1333f784cb01947965fdcab85331256f0648e58` | none | **D** router, **A** media | adds `createModelRouter` | rebase on #4; keep media service |
| Artifact intelligence | `feat/artifact-intelligence` | `c9bac16b0bd78252d39282853bd9ef842b8f228c` | none | **A** artifact toolkits | needs the durable artifact store | rebase on durable artifacts |
| Native game studio + gaming agent | `feat/native-game-studio-gaming-agent` | `ce271b9784c2267266eade8a6ad56912123bd65b` | none | **D** ArtifactStore copy, **A** games | duplicating the artifact store, many new routes | rebase on durable artifacts and contract v1.1 |
| Persistent records | `feat/persistent-records` | `b5818f447a5910af3867e81fc9e9675ab4e39784` | none | **A** checkpoints/idempotency/retention | shares event-log/quarantine code with durable events | land after durable events; deduplicate |
| Read-model API | `feat/read-model-api` | `4626b846f3a85f91708b78354c1fa9a049c89437` | none | **D** durable foundations, **A** read endpoints | duplicates checkpoints/idempotency/event log | rebase on persistent records, delete duplicates |
| Security remediation | `security/remediation` | `4b2ea758d9fab4d04bff380651ed8a6b38708912` | none | **A** security fixes | contains a merged PR #4 router; must not reintroduce a second router | rebase on gate + #4; keep isolation/revocation/redaction |
| Older security remediation | `security/remediation-808dfd3` | `74b1264c1b20df24f80e20cc6c0c7d08db02a7c5` | none | **S** | `RunSupervisor` competes with PR #5 | close; port any unique fix |
| Operability evidence | `feat/operability-evidence` | `5d2afd10a000fe79fe7e61c9527336822492aa00` | none | **A** docs | none | merge last; contains `main` |
| Release certification | `freebuff/4fc2df7…` | `6e70c5dc11624a732fb4ec0990eae00560973162` | none | **C** separate lane | `release-verify.yml` reuses `verify` | rerun after the merge train; not a gate replacement |
| Cloud Browser / Computer Use | `freebuff/221aa2c8…` | `debdec0b1347ab3fbc568169df27e3b65b8de71d` | #11 | **C** proposed control plane | fail-closed browser control plane; not in this gate or on `main` | merge after #5/#7; do not claim browser availability until its live path is verified |

## Contract-surface check

Two v1.1 surfaces exist and they disagree, so this is not a cosmetic overlap:

- PR #7 adds handshake, task list, artifact list/create/get, memory write/delete/
  search, notification mark-read and schedule list/create/control/delete.
- `contract/authoritative-v1.1` adds handshake, task list, memory put, pending
  permissions, notification mark-read, schedule list/create/get/cancel, task
  artifact list/upload/content.
- PR #9 adds a broader schedule API (get/update/pause/resume/cancel/trigger/
  executions and a dispatch event).

One surface must survive: **PR #7**, because it is the reviewed PR with hosted
evidence. Before it merges, the contract owner must decide which unique operations
from the other two are required and add them once, with SDK probes and regenerated
OpenAPI. Domain owners then implement those operations without redeclaring them.

## How the gate evaluates this matrix

- `gate:structure` counts declarations and rejects a second supervisor, planner,
  scheduler, workflow engine, event bus, registry, model-routing decision or
  per-domain Mongo store.
- `gate:authority` uses the TypeScript checker so renaming a factory does not hide
  a second implementation, while adapters and read-port projections are not
  counted as authorities.
- `gate:reachability` rejects a branch that adds a capability nothing composes.
- `gate:registration`, `gate:sdk` and `gate:openapi` reject an operation with no
  handler, no client call or no published document.
- The live MongoDB lane is extended by the owner of each durable store; an
  in-memory implementation is never accepted as database evidence.
