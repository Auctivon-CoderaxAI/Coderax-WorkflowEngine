# Merge plan

This is the executable path from the current stack to a reconciled `main`. It is
derived from the exact heads in
[`docs/architecture-compatibility.md`](./architecture-compatibility.md) and from
the composition roots, not from branch names. Heads move; refresh the SHAs before
acting, and never merge a commit whose exact head has not run the gate.

## Principles

1. **The gate lands first.** It is the only branch that adds no product surface; it
   adds enforcement plus the verified Zod correction. Nothing else can be trusted
   until the gate is the thing reviewing it.
2. **One authority per responsibility.** Where two branches decide the same thing,
   the owner listed in the matrix wins and the other deletes its copy; the gate
   rejects the semantic duplicate rather than a textual conflict.
3. **Rebase, do not merge sideways.** Every PR is a sibling of the current `main`;
   a merge commit that keeps an old router, supervisor or contract surface would
   be rejected. Rebase onto the new `main`, delete the superseded implementation,
   rerun the gate.
4. **No circular dependency.** The gate does not require any implementation branch
   to exist. Each branch requires only the gate plus its listed predecessors.
5. **Each step is independently testable.** A step is done when its exact head
   passes `npm run verify`, the live MongoDB lane when it touches a durable store,
   and one independent approval.
6. **No direct `main` push, no force, no settings change.** Every step is a reviewed
   PR. This document cannot authorize itself.

## Dependency graph

```text
gate (CI + Zod)
 ├── router #4
 │    ├── security/remediation (rebase, drop duplicate router)
 │    │    └── supervisor #5 (one ExecutionSupervisor)
 │    │         └── teams #8 (drop copied supervisor + legacy router)
 │    ├── planner #3
 │    ├── intelligence #2 (drop legacy router; keep tools/approvals/quota)
 │    │    ├── teams #8
 │    │    └── multimodal-intelligence-core
 │    ├── creative/media (drop duplicate router)
 │    └── multimodal-integration (already merges #4 + artifacts)
 ├── contract v1.1 #7
 │    ├── scheduling #9 (engine only; contract stays in #7)
 │    ├── read-model-api (after persistent records)
 │    ├── artifacts / artifact intelligence / games
 │    └── durable schedules + memory + artifacts operations
 ├── durable recovery (event log + crash repair)
 │    └── persistent records
 │         └── read-model API
 └── operability evidence (docs; contains main)
      └── release certification (separate lane, rerun at final main)
```

`durable-recovery` is the newest durable-event head and supersedes both
`feat/durable-events-recovery` and `feat/durable-events-integration`; `feat/durable-events`
is stale (it does not contain the merged `main`).

## Step table

Acceptance column meaning: **baseline** = the head has a green hosted run of
`main`'s older workflow (build + tests + OpenAPI); **gate** = the head has run the
consolidated gate; **none** = not yet evaluated. No PR has an `APPROVED` review at
the time of this inspection; every review is `COMMENTED` (bots and owner).

| # | Ref / PR | Exact head | Depends on | Competing implementation | Security / review finding | Acceptance | Hosted CI | Approval | Next remediation | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `ci/permanent-quality-gate` (no PR yet) | commit containing this document (see compare) | `main` | `ci/permanent-quality-gates` advanced to `d00156a` | Zod resolved; shutdown drain ported; no product surface | **gate** locally: verify + live Mongo 6/6 | run at pushed head (push `ci/**`); PR required for `pull_request` trigger | none (no PR) | open PR, request review; reconcile `d00156a`'s post-adoption commits before closing that branch | **merge first** |
| 2 | #4 `feat/zero-cost-model-router` | `ade0a292258ae2451e0bfe5678a91989798f22b8` | 1 | legacy `createRouter` in #2/#5/#8 | router is the single decision; no paid switch | baseline | success at previous head; new head not yet observed | none | rebase on `main` after 1; rerun gate | **merge** |
| 3 | `security/remediation` | `4b2ea758d9fab4d04bff380651ed8a6b38708912` | 1, 2 | contains merged #4 router; older head had `RunSupervisor` | isolation, revocation, redaction; must not drop | none | no PR, no runs | none | rebase on `main` + #4, drop duplicate router, open PR | **reconcile** |
| 4 | #5 `feat/execution-supervisor` | `13d4b4f7796f819e4e58bd18006efc4970929e6e` | 1, 2, 3 direction | `RunSupervisor` in `security/remediation-808dfd3` | one supervisor, verified termination | baseline | success at this head | none | rebase on #4/security, delete legacy router/catalog, keep `ExecutionSupervisor` | **merge after 3** |
| 5 | #7 `freebuff/5e5de30e…` v1.1 | `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f` | 1 | `contract/authoritative-v1.1` (`ea66028`); schedule ops in #9 | one API/SDK surface; remove committed dist tarballs if still present | baseline | success at this head | none | reconcile unique ops, add SDK probes, regenerate OpenAPI, coordinate artifacts/schedules | **merge** |
| 6 | #3 `feat/native-reasoning-planner` | `072c4371ed0190993468660e00fd20cf4827fccd` | 1, 2, 5 | none (one planner) | approval suspension before lease release | baseline | success at previous head; new head queued | none | rebase on #4/#7; add live coverage only if durable | **merge** |
| 7 | #2 `feat/intelligence-core` | `c1bcf66e2c6ddc8c71e0ce61efae3de065a2d2a5` | 1, 2, 5 | legacy `createRouter` + selector | durable approvals/quota, tools, MCP, retrieval | baseline | success at previous head; new head not observed | none | rebase on #4, delete router/selector, wire durable budget/approval live tests | **reconcile then merge** |
| 8 | #8 `feat/native-team-orchestration` | `62b5eda14ebdc7344f946d5377dd19df721fe16b` | 1, 2, 4, 7 | copied `ExecutionSupervisor`, legacy router | cancellation/quota races; checks pending | baseline | verify queued, CodeRabbit in progress at this head | none | rebase on #4/#5/#7, delete copies, rerun gate | **merge last of the intelligence chain** |
| 9 | #9 `feat/durable-scheduling` | `6e05f1b7d2d4840d656c6f29654eeb023d9ff4a9` | 1, 5 | schedule contract duplicated from #7 | cancellation ownership, no replay of interrupted run | baseline | success at previous head; new head not observed | none | rebase on #7; keep engine/repository, delete duplicate contracts, add live schedule case | **reconcile then merge** |
| 10 | #10 `feat/durable-recovery` | `c3e94d7e7bfb6e0f20ba3fbdb68eae991ef940b2` | 1, 4 | supersedes `durable-events`, `-recovery`, `-integration` | event persistence + crash repair | none | PR open; hosted baseline not evaluated against this gate | none | add live replay/restart case; rebase on supervisor | **merge as canonical event head** |
| 11 | `feat/persistent-records` | `b5818f447a5910af3867e81fc9e9675ab4e39784` | 1, 4, 10 | shares event-log/quarantine code with 10 | checkpoints, idempotency, retention | none | no PR | none | rebase on 10, deduplicate event log, add live cases | **merge** |
| 12 | `feat/read-model-api` | `4626b846f3a85f91708b78354c1fa9a049c89437` | 1, 5, 11 | duplicates 11's durable foundations | new read endpoints | none | no PR | none | rebase on 11, delete duplicated stores, add SDK probes | **reconcile then merge** |
| 13 | `feat/durable-artifacts` | `bf2e9b292257cae1247bd1df8f26630c2691205a` | 1, 5 | `multimodal-integration` also carries an artifact store | reference counting/capacity | none | no PR | none | choose one artifact implementation; add live ref-count case | **reconcile** |
| 14 | `feat/multimodal-integration` | `79851b2e0ea6f71acb0272523cf6a59b8e29666a` | 1, 2, 5, 13 | merges #4 + artifact service/toolkit | large surface; needs review | none | no PR | none | decide whether this is the artifact vehicle; delete either this or 13's duplicate store | **candidate integration vehicle** |
| 15 | `feat/multimodal-intelligence-core` | `5dd5e66c6501b6bda0ff2a051875dc5a566acb82` | 1, 2, 7 | overlaps tools/MCP from #2 | media intake | none | no PR | none | rebase on #2; keep media, delete duplicated tools | **reconcile** |
| 16 | `feat/multimodal-creative-intelligence` | `f1333f784cb01947965fdcab85331256f0648e58` | 1, 2 | adds `createModelRouter` | creative/media routes | none | no PR | none | rebase on #4, delete router, keep media | **reconcile** |
| 17 | `feat/artifact-intelligence` | `c9bac16b0bd78252d39282853bd9ef842b8f228c` | 1, 5, 13/14 | artifact toolkit also in 14 | deliverable generation | none | no PR | none | rebase on chosen artifact store; deduplicate toolkit | **reconcile** |
| 18 | `feat/native-game-studio-gaming-agent` | `ce271b9784c2267266eade8a6ad56912123bd65b` | 1, 5, 13/14 | own `ArtifactStore` | browser/game preview, large route surface | none | no PR | none | rebase on chosen artifact store, delete duplicate, add SDK probes | **reconcile** |
| 19 | `feat/operability-evidence` | `5d2afd10a000fe79fe7e61c9527336822492aa00` | all of the above | none (docs) | contains `main` | none | no PR | none | rebase last, record final evidence | **merge last** |
| 20 | release certification `freebuff/4fc2…` | `6e70c5dc11624a732fb4ec0990eae00560973162` | final `main` | none; separate lane | evidence is at `808dfd3`, stale | none | no PR | none | rerun `release-verify.yml` at final `main`; verify package provenance and CLI/web compatibility | **certify, do not gate** |
| 21 | #11 `freebuff/221aa2c8…` browser | `debdec0b1347ab3fbc568169df27e3b65b8de71d` | 1, 4, 5 | none (new surface) | fail-closed control plane; live path not verified here | none | PR open | none | merge after #5/#7; do not claim browser availability | **reconcile then merge** |
| 22 | #12 / #13 CI scanners | `a664a93a5c4ac5197a0d2cd14c9d5d213efe8d2e` / `65fdf37c9850cd050d4332d17c9172bcefa0aa1a` | 1 | none | CodeQL and gitleaks workflows only | none | PRs open | none | merge after 1; no product surface | **merge after gate** |
| — | `ci/permanent-quality-gates` | `d00156a1597e5d908d21d3886272f5710a0df721` | — | duplicate gate, advanced after adoption | original components are in step 1; post-adoption shutdown/network/gateway work is not | not a gate candidate | none | none | reconcile `d00156a` into step 1 or prove it duplicate; do not close yet | **supersede after reconciliation** |
| — | `security/remediation-808dfd3` | `74b1264c1b20df24f80e20cc6c0c7d08db02a7c5` | — | `RunSupervisor` vs #5 | older security head | none | no PR | none | port any unique fix into step 3, then close | **supersede** |
| — | `contract/authoritative-v1.1` | `ea660285b3c0a950067aa3b57f1764ccb509af8a` | — | second v1.1 surface | older contract head | none | no PR | none | reconcile unique ops into #7, then close | **supersede** |
| — | `feat/durable-events` / `-recovery` / `-integration` | `9b3fd7d` / `db289d2` / `2554edc` | — | three durable-event heads | superseded by `durable-recovery` | none | no PR | none | reconcile differences into 10, then close | **supersede** |

## Delivery increments

Each increment can be merged and verified without waiting for the rest.

**Increment A — enforcement and dependency remediation.**
Step 1. Acceptance: `npm run verify` (all gates including audit) and
`CODERAX_TEST_MONGO_URI=… npm run test:mongo:live` at the PR head. This makes every
later rebase reviewable.

**Increment B — one router.**
Step 2, then step 3 rebased. Acceptance: compile, architecture tests, SDK probes;
the gate rejects any branch that still declares `createRouter` in `src/models`.

**Increment C — one supervisor.**
Step 4, then step 8 after 7. Acceptance: one `ExecutionSupervisor`, termination and
cancellation tests, live lease/recovery lane.

**Increment D — one contract surface.**
Step 5, then steps 6/7 rebased. Acceptance: OpenAPI byte-identical, every new
operation has an SDK probe, release manifest gate, live memory/approval/quota
cases from step 7.

**Increment E — durable scheduling and artifacts.**
Steps 9 and 13/14 reconciled. Acceptance: one schedule contract, one artifact
store, live reference-count and schedule cases.

**Increment F — durable events, records and read models.**
Steps 10–12. Acceptance: live event replay across restart, idempotency, retention.

**Increment G — multimodal, intelligence and games.**
Steps 15–18. Acceptance: capability registry, route registration, no second
provider boundary, SDK probes for every operation.

**Increment H — evidence and certification.**
Steps 19–20. Acceptance: final `main` SHA recorded, release lane rerun, web/CLI
compatibility evidence attached. No production data or credentials in CI.

## What this plan does not do

- It does not push to `main`, force-push, change repository settings or bypass
  review. Those remain the owner's actions.
- It does not wait for every branch before landing useful increments.
- It does not treat a green run of the old workflow as gate acceptance, and it
  does not treat package creation as release readiness.
- It does not create a replacement router, supervisor, planner, scheduler or
  contract surface.
