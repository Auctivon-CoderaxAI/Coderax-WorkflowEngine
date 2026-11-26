# Contract reconciliation, 2026-11-26

This is the coordination record for the authoritative v1.1.0 API and the one
shared SDK. It states what was merged, what was deliberately not merged, and the
exact commit each claim is measured at.

Recovery baseline: `contract/authoritative-v1.1` at
`ea660285b3c0a950067aa3b57f1764ccb509af8a`.
Integration head: `integration/v1.1-reconciliation`. The baseline was not
rewritten; consolidation happens on top of it.

## One contract

| Item | Value |
| --- | --- |
| Contract version | `1.1.0` |
| Engine version | `0.2.0` |
| SDK version | `1.1.0` |
| Event schema | `1` |
| Chat stream schema | `1` |
| Published operations | 30, in 11 domains |
| Owners | `packages/contracts/src/ownership.ts`, enforced by `tests/contract/ownership.test.ts` |
| OpenAPI | generated, `x-contract-version 1.1.0`, `x-engine-version 0.2.0` |

`OPERATION_DOMAINS` is exhaustive over the route catalogue in both directions.
A duplicate operation id fails the gate. An operation without a domain owner
fails the gate. A reserved operation cannot be published until its handler is
registered, and a superseded operation must name the published id that owns the
behaviour.

### Published operations

| Domain | Operations |
| --- | --- |
| platform | `getHealth`, `getReadiness`, `getHandshake` |
| discovery | `listAgents`, `listModels` |
| chat | `submitChat` |
| work | `submitWork`, `getTask`, `listTasks`, `cancelTask`, `resumeTask`, `retryTask` |
| events | `streamTaskEvents` |
| conversations | `listConversations`, `getConversation` |
| memory | `listMemory`, `putMemory` |
| permissions | `listPermissions`, `listPendingPermissions`, `decidePermission` |
| notifications | `listNotifications`, `markNotificationsRead` |
| scheduling | `listSchedules`, `createSchedule`, `getSchedule`, `cancelSchedule` |
| artifacts | `listTaskArtifacts`, `uploadTaskArtifact`, `getArtifact`, `getArtifactContent` |

### Withheld operations

These are declared by an unmerged branch and are `RESERVED_OPERATIONS` with the
exact head. They are not in OpenAPI and not in the SDK.

| Operation(s) | Owner | Status |
| --- | --- | --- |
| `listTools`, `getRouting`, `ingestKnowledge`, `listKnowledge`, `searchKnowledge` | PR #2 / `feat/intelligence-core` `e14e4b7` / `24c90e0` | blocked: no handler on this base |
| `submitTeam`, `getTeam`, `resumeTeam`, `cancelTeam`, `listTeamPermissions`, `decideTeamPermission` | PR #8 `ffec08f` | blocked: bounded team orchestration is unmerged |
| `updateSchedule`, `pauseSchedule`, `resumeSchedule`, `getScheduleUpcoming`, `listScheduleExecutions`, `triggerSchedule`, `dispatchScheduleEvent` | PR #9 `d1f4b50` | blocked: editing and occurrence history are unmerged |
| `markNotificationRead`, `writeMemory`, `controlSchedule`, `createArtifact`, `listArtifacts` | PR #7 `9b4cb5c` | superseded by `markNotificationsRead`, `putMemory`, `cancelSchedule`, `uploadTaskArtifact`, `listTaskArtifacts` |
| `deleteMemory`, `searchMemory` | PR #7 `9b4cb5c` | blocked: no implementation |

The handshake reports each unavailable capability as `unsupported` or
`unconfigured`; it never advertises a route the router did not register.

## Reconciliation decisions

Measured against `origin/main` at `808dfd3` and the heads below on 2026-11-26.

| Branch / PR | Head | Contract delta | Decision |
| --- | --- | --- | --- |
| `release` train (`freebuff/4fc2df…`) | `6e70c5d` | none | **adopted**. Its release gate is merged, repinned to 1.1.0 and kept authoritative for the three repositories. Its 1.0.0 SDK artifact and its three-file packer were removed in favour of the canonical package. |
| `feat/durable-events-integration` | `2554edc` | none (adds the event log behind `streamTaskEvents`) | **merged.** The nine textual conflicts were resolved in favour of the authoritative v1.1 catalogue while adopting the owner's `EventLog` port, MongoDB implementation, async bus, quarantine registry, settlement flush barriers and terminal-event repair. Capability is `available` under `persistence.driver=mongo`; the live two-replica suite proves replay from `after: 0` and a mid-stream cursor. |
| PR #2 / `feat/intelligence-core` | `e14e4b7` / `24c90e0` | reserves `ChatFrame`, `negotiated`, 5 intelligence operations | **not merged.** Its shapes were adopted; routes stay reserved. |
| PR #3 / `feat/native-reasoning-planner` | `90b87db` / `c241bae` | no new ids | **not merged.** Behavior-only change to the native agent. |
| PR #4 / `feat/zero-cost-model-router` | `b6e002b` / `43f3581` | no new ids | **not merged.** Router internals; provider eligibility and durable quotas remain its ownership. |
| PR #5 / `feat/execution-supervisor` | `13d4b4f` / `a4fabac` | no new ids; uses `decidePermission` | **not merged.** Durable approval and fencing behavior stay with it. |
| PR #7 | `9b4cb5c` | competing 1.1.0 with 27 ids, several aliases | **superseded.** Do not merge as a second contract; the operation names above were resolved in favour of one id per behaviour. |
| PR #8 | `ffec08f` | 6 team operations | **not merged.** Reserved. |
| PR #9 | `d1f4b50` | 7 schedule operations | **not merged.** Reserved. |
| `ci/permanent-quality-gate` | `676ad8c` | none | **not merged.** Overlaps the adopted release gate; its extra gate scripts should be reconciled into `scripts/release` rather than added as a second gate. |
| `security/remediation-808dfd3` | `74b1264` | none | **not merged.** Hardening; no contract delta. |

No branch was rewritten, force-pushed or deleted.

## Persistence and idempotency evidence

Real MongoDB 7.0.14 on loopback, two independently composed engine applications
with separate driver connections and workspace roots, one database.

`tests/integration/mongo-live.test.ts` proves, over HTTP through the shared SDK:

- concurrent duplicate submissions with one idempotency key, one to each
  replica, return one `taskId`; both replicas list exactly one task and one
  transcript, and a notification acknowledgement on one replica is visible on
  the other;
- after the creating replica stops, a new replica reads the completed task, the
  two-message transcript, private memory, the pending approval (and decides it),
  the schedule (and cancels it), the notification, and artifact metadata;
- the same restarted replica replays the full execution stream from `after: 0`,
  then a mid-stream tail both from an explicit `after` cursor and from
  `Last-Event-ID`; the replayed events are ordered, belong to the task's one
  generation, and end at `task.completed`;
- the handshake advertises `durableEvents: available` under MongoDB, and the
  canonical SDK negotiates with each replica and validates every response.

It also pins the honest boundaries:

- artifact metadata is shared but bytes are per-replica; a second replica
  returns `404 not_found` for content. Durable Artifacts owns blob sharing and
  reference counting.
- the daily inference budget is a process-local ledger, so each replica enforces
  its own copy. Durable quotas belong to PR #4 and the consolidated Intelligence
  Core.

`tests/integration/http-contract.test.ts` remains the in-process HTTP contract
suite: authentication, negotiation, Chat JSON and SSE, Work, control, cursor
replay, permissions, memory, schedules, notifications, artifacts and read models.

## Gateway and CLI status

Both client repositories were read at their actual heads; neither is integrated.

`Auctivon-CoderaxAI/Coderax` `main` `a5d237b0ff672356374849d565363955df69d298`:
no `@coderax/sdk` dependency. The open branch
`feat/workflow-engine-gateway-v1` at `19bdb150f20da288b26f447b2b3ee6b20794b758`
mounts an authenticated gateway at `/api/gateway`, injects the engine credential
server-side and mirrors the engine contract by hand. That mirror is version
`1.0.0`, covers 17 operation ids and explicitly fails closed on scheduling. The
branch is not merged, and it keeps a second DTO layer.

`Auctivon-CoderaxAI/CoderaxCLI` `main`
`1b7c8e0a429755502f7563b16a8a09db899452d8`: no `@coderax/sdk`. PR #5
(`5ca4d70`) and PR #6 (`327d3ea`) add `packages/workflow-sdk` version `0.1.0`
targeting the Coderax deployment API (`/api/work/*`), which is a different
protocol from the engine's `/v1` surface.

What was verified here, and what was not:

- **Verified:** the canonical SDK drives the genuine engine through the
  `/api/gateway` prefix over real HTTP, including session-bearer translation,
  SSE pass-through, Work, replay, artifacts and memory
  (`tests/integration/gateway-prefix.test.ts`). This proves the mounting
  topology and the contract, not Coderax's handlers.
- **Not verified:** Coderax's Express handlers, the Coderax UI, the CLI command
  surface, and any full three-repository deployment. The release gate records
  both clients as FAIL.

## Quality gate

`npm run verify` at `9a386db` with `CODERAX_TEST_MONGODB_URI` set:

```text
tests 177
pass 177
fail 0
openapi.json matches the published contracts
```

That run includes the ownership gate, the two-replica MongoDB suite, the gateway
topology suite, the SDK package install/typecheck suite and the release-train
suite. The committed log is
`release/evidence/engine-verify-9a386db-merged.log`, pinned by SHA-256 in
`release/train.json`.

`npm run release:verify -- --online` at `87a765b` reports **BLOCKED, 7 PASS /
7 FAIL, 55 blockers**: all engine rows pass; web, CLI, hosted checks, independent
review, deployment, unpublished branches and CI credential safety fail. The gate
is the authority for those rows, not this document.

## Artifacts

```text
d2e76532244b84a5c445a98cc058fbaeeeaa795b835c3395049b25f101c967b9  coderax-contracts-1.1.0.tgz
c2599576231c85c3f6e68a31933ab2833627582e3f7d5f791fc46becacc79b33  coderax-sdk-1.1.0.tgz
```

The SDK tarball has 14 files: five runtime entrypoints, their declarations, the
manifest, errors, stream parser, README and the package manifest. The release
gate's copy is byte-identical to `dist-artifacts/coderax-sdk-1.1.0.tgz`.
Reproduce with `npm run sdk:pack`; do not hand-edit the generated artifact.

## Remaining blockers

1. No authorized GitHub session in this environment, so no pull request was
   opened and no hosted check ran at this head.
2. Partner repositories are not writable from this workspace; the gateway and CLI
   migrations are specified, not pushed.
3. Durable events, durable artifacts, advanced scheduling, RAG, teams, provider
   eligibility and durable quotas are owned by unmerged branches. Publishing
   their operations now would advertise behavior this base does not implement.
4. Coderax and CoderaxCLI must replace their mirrors with the canonical package
   and be verified against a running engine and a real deployment.
5. Hosted GitHub Actions is billing-blocked; independent review and deployment
   are absent by design until an owner acts.
