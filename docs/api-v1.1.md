# Authoritative API contract v1.1.0

Effective 2026-11-26. Owner: the contracts catalogue in
`packages/contracts/src/routes.ts`. This document is explanatory; the catalogue,
the zod schemas and the generated `openapi.json` are the authority.

## Why this exists

Commits `185b3f1` (ecosystem-contract-v1) and `d12a8b5` (CLI thin-client) are not
present in this repository or on its remote. They are not the base of this work.
The contract below was reconstructed from the implementation that is actually on
`main`, and every published operation has a registered handler and an HTTP test.
A subsystem that is not implemented on `main` is reported as unavailable rather
than published as a hypothetical endpoint.

## Version and capability handshake

`GET /v1/handshake` is public (it carries no owner data) and is the only supported
way for a client to decide whether it can talk to a deployment.

```json
{
  "engineName": "coderax-workflow-engine",
  "engineVersion": "0.2.0",
  "contractVersion": "1.1.0",
  "eventSchemaVersion": 1,
  "chatStreamSchemaVersion": 1,
  "minSdkVersion": "1.1.0",
  "sdkVersion": "1.1.0",
  "apiPrefix": "/v1",
  "capabilities": {
    "chat": { "state": "available", "detail": "..." },
    "chatStreaming": { "state": "available", "detail": "..." },
    "work": { "state": "available", "detail": "..." },
    "durableEvents": { "state": "unconfigured", "detail": "..." },
    "eventReplay": { "state": "available", "detail": "..." },
    "scheduling": { "state": "available", "detail": "..." },
    "artifacts": { "state": "available", "detail": "..." },
    "permissions": { "state": "available", "detail": "..." },
    "memory": { "state": "available", "detail": "..." },
    "rag": { "state": "unsupported", "detail": "..." },
    "multimodal": { "state": "unsupported", "detail": "..." },
    "multiAgent": { "state": "unsupported", "detail": "..." },
    "idempotency": { "state": "available", "detail": "..." },
    "reasoningPlanner": { "state": "available", "detail": "..." },
    "modelRouter": { "state": "available", "detail": "..." }
  },
  "operations": [
    { "operationId": "getHealth", "method": "GET", "path": "/v1/health", "tags": ["health"], "auth": "public", "stream": false }
  ]
}
```

`capabilities` names the domain; `operations` is the exact set the router
registered. A client must assert the operations it needs are present. States are:

- `available`: the operation exists and is tested over HTTP.
- `unsupported`: the engine does not implement it and no route is published.
- `unconfigured`: the route exists but a backing dependency is not enabled in this
  deployment (currently `durableEvents`, whose replay window is process-local on
  `main`).

`@coderax/sdk` calls this endpoint in `negotiate()` and throws
`CoderaxCompatibilityError` unless the contract major matches, the engine contract
is at least `1.1.0`, and the event schema is `1`.

## Canonical operations

Every operation is registered once. The router refuses an unknown or duplicate
operation id at startup, and `npm run openapi:check` fails if `openapi.json`
differs from the catalogue.

| Operation ID | Method and path | Success | Notes |
| --- | --- | --- | --- |
| `getHealth` | `GET /v1/health` | 200 `HealthReport` | public |
| `getReadiness` | `GET /v1/ready` | 200 `ReadinessReport` | public |
| `getHandshake` | `GET /v1/handshake` | 200 `EngineHandshake` | public |
| `listAgents` | `GET /v1/agents` | 200 `AgentList` | owner |
| `listModels` | `GET /v1/models` | 200 `ModelList` | owner; `allowPaid: false` |
| `submitChat` | `POST /v1/chat` | 200 `ChatReply` or SSE | owner; negotiated |
| `submitWork` | `POST /v1/work` | 202 `TaskAccepted` | owner; idempotent |
| `getTask` | `GET /v1/work/{taskId}` | 200 `TaskStatus` | owner |
| `listTasks` | `GET /v1/tasks` | 200 `TaskList` | owner; `limit`, `state` |
| `cancelTask` | `POST /v1/work/{taskId}/cancel` | 200 `TaskControlResult` | owner |
| `resumeTask` | `POST /v1/work/{taskId}/resume` | 200 `TaskControlResult` | owner |
| `retryTask` | `POST /v1/work/{taskId}/retry` | 200 `TaskControlResult` | owner |
| `streamTaskEvents` | `GET /v1/work/{taskId}/events` | 200 SSE | owner; `after` or `Last-Event-ID` |
| `listConversations` | `GET /v1/conversations` | 200 `ConversationList` | owner |
| `getConversation` | `GET /v1/conversations/{conversationId}` | 200 `Conversation` | owner |
| `listMemory` | `GET /v1/memory` | 200 `MemoryList` | owner; `mode` |
| `putMemory` | `POST /v1/memory` | 200 `MemoryEntry` | owner; exact key/value |
| `listPermissions` | `GET /v1/work/{taskId}/permissions` | 200 `PermissionList` | owner |
| `listPendingPermissions` | `GET /v1/permissions` | 200 `PermissionList` | owner |
| `decidePermission` | `POST /v1/work/{taskId}/permissions` | 200 `PermissionList` | owner |
| `listNotifications` | `GET /v1/notifications` | 200 `NotificationList` | owner |
| `markNotificationsRead` | `POST /v1/notifications/read` | 200 `NotificationList` | owner |
| `listSchedules` | `GET /v1/schedules` | 200 `ScheduleList` | owner |
| `createSchedule` | `POST /v1/schedules` | 201 `Schedule` | owner |
| `getSchedule` | `GET /v1/schedules/{scheduleId}` | 200 `Schedule` | owner |
| `cancelSchedule` | `POST /v1/schedules/{scheduleId}/cancel` | 200 `ScheduleControlResult` | owner |
| `listTaskArtifacts` | `GET /v1/work/{taskId}/artifacts` | 200 `ArtifactList` | owner |
| `uploadTaskArtifact` | `POST /v1/work/{taskId}/artifacts` | 201 `ArtifactRecord` | owner; base64, max 8 MiB decoded |
| `getArtifact` | `GET /v1/artifacts/{artifactId}` | 200 `ArtifactRecord` | owner |
| `getArtifactContent` | `GET /v1/artifacts/{artifactId}/content` | 200 `ArtifactContent` | owner; sha256 verified |

Every failure is the shared `Problem` body with a stable `code`, a `requestId`,
and `retryable`. Authentication is a constant-time owner bearer token; there is
no second principal.

## Streaming contracts

### Chat (negotiated SSE)

`POST /v1/chat` answers JSON unless the request carries
`Accept: text/event-stream`. The SSE frames are exactly:

```json
{ "type": "chat.delta", "text": "..." }
{ "type": "chat.completed", "reply": { "conversationId": "...", "messageId": "...", "text": "...", "agent": "coderax", "model": { "providerId": "...", "modelId": "..." }, "createdAt": "..." } }
```

An error happens before the stream opens and is a normal `Problem` response. The
SDK exposes `chatStream()`; `chat()` remains the JSON transport. This shape is
byte-compatible with the `ChatFrame` reserved on `feat/intelligence-core`.

### Work (durable SSE and cursor replay)

`GET /v1/work/{taskId}/events` replays retained events and then tails live ones.
Each frame carries an SSE `id:` equal to the event's per-task `seq`, and the body
is an `ExecutionEvent` envelope (`v: 1`, stable `eventId`, `seq`, `generation`).

- `?after=N` replays events with `seq > N`.
- `Last-Event-ID: N` is used when `after` is absent.
- The stream closes on a terminal event from the **current generation**. A
  `task.failed` from generation 1 does not close a stream after a generation 2
  retry.
- Response headers: `x-coderax-truncated` (`true` when the cursor predates the
  retained window), `x-coderax-last-seq`, `x-coderax-event-schema: 1`.
- Every frame is validated against `ExecutionEvent` before it is written. A
  producer that emits a shape the schema forbids breaks the stream instead of
  teaching a client an unpublished event.

The SDK exposes `openEvents()` (returns `{ truncated, lastSeq, events }`) and the
convenience generator `events()`.

## Idempotent task submission

`WorkSubmitRequest` accepts `idempotencyKey` (URL-safe, 8–200 characters). The key
is scoped to the owner and stored in a dedicated idempotency table with a unique
index. A replayed submission returns the task the first submission created (same
`taskId`, conversation and generation, current state) and creates no second task,
transcript or notification. The idempotency check is repeated after the
conversation lease is claimed, so two concurrent duplicates cannot both charge
the daily budget, and the task is written before its transcript so the losing
caller cannot append a second user message.
Schedules derive their key from `scheduleId` and due time, so a tick crash between
submission and recording cannot duplicate a run.

## Persistent permissions, schedules and artifacts

These were process-local or absent on `main` and are reconstructed here:

- Permission rows are stored through a table port backed by MongoDB when
  `persistence.driver = mongo`; a pending approval survives a restart. Decisions
  are owner-scoped, expire, and a second decision is `409 conflict`.
- Schedules are durable rows. A ticker fires due schedules, submits Work with a
  stable idempotency key, leaves a busy conversation due for retry, and records
  `lastTaskId`/`lastError`. One-shot schedules settle as `submitted`; repeating
  ones reschedule from the tick time. At most 50 active schedules per owner.
- Artifact metadata is durable; bytes are written under
  `<workspace-root>/.coderax-artifacts/<artifactId>.bin` at mode 0600, never at a
  caller-chosen path. The engine computes and re-verifies `sha256:<hex>`; `path`
  is a label only and traversal is rejected by the request schema.

## Unavailable capabilities (deliberately not published)

The following are **not** part of this contract because this branch has no server
implementation. Do not code against them:

| Capability | Why | Owner / branch |
| --- | --- | --- |
| RAG / knowledge retrieval | no embedding provider or vector index | PR #2 / `feat/intelligence-core` (`ingestKnowledge`, `listKnowledge`, `searchKnowledge`) |
| Tools and routing report | implementation lives on an unmerged branch | PR #2 / `feat/intelligence-core` (`listTools`, `getRouting`) |
| Multimodal input | no image or audio path | unassigned |
| Multi-agent collaboration | bounded team orchestration is unmerged | PR #8 (`submitTeam`, `getTeam`, `resumeTeam`, `cancelTeam`, `listTeamPermissions`, `decideTeamPermission`) |
| Durable event storage | replay is process-local on `main` | `feat/durable-events-integration` |
| Schedule editing and occurrence history | only create/list/get/cancel are implemented | PR #9 (`updateSchedule`, `pauseSchedule`, `resumeSchedule`, `getScheduleUpcoming`, `listScheduleExecutions`, `triggerSchedule`, `dispatchScheduleEvent`) |
| Model-driven reasoning planner | deterministic planner only | PR #3 / `feat/native-reasoning-planner` |

The handshake reports each of these as `unsupported` or `unconfigured`. When an
owner's branch merges, the capability state and the operation list change in the
same pull request that registers the handler.

## SDK distribution

The immutable artifact is two committed tarballs plus checksums:

```text
dist-artifacts/coderax-contracts-1.1.0.tgz
dist-artifacts/coderax-sdk-1.1.0.tgz
dist-artifacts/SHA256SUMS
dist-artifacts/manifest.json
```

Current SHA-256:

```text
d2e76532244b84a5c445a98cc058fbaeeeaa795b835c3395049b25f101c967b9  coderax-contracts-1.1.0.tgz
c2599576231c85c3f6e68a31933ab2833627582e3f7d5f791fc46becacc79b33  coderax-sdk-1.1.0.tgz
```

Reproduce them from the same source with `npm run sdk:pack`; entries are sorted
and every mtime/uid/gid is fixed, so the bytes and checksums are stable. A
consumer installs both tarballs from the same commit:

```sh
npm install ./coderax-contracts-1.1.0.tgz ./coderax-sdk-1.1.0.tgz
```

Then:

```ts
import { CoderaxClient } from '@coderax/sdk';

const client = new CoderaxClient({ baseUrl, token });
await client.negotiate(); // throws CoderaxCompatibilityError on drift
```

Runtime entrypoints: `@coderax/sdk`, `@coderax/sdk/client`,
`@coderax/sdk/version`, `@coderax/sdk/stream`, `@coderax/sdk/manifest`. Type
declarations ship beside every entrypoint. `SDK_COVERAGE` maps each published
operation id to a client method; the coverage test fails if either side drifts.
`tests/contract/sdk-package.test.ts` installs the tarballs into a clean temporary
project and runs both a runtime import and a `tsc --noEmit` declaration check.

Coderax and CoderaxCLI must depend on this package; they must not vendor a second
client or hand-write DTOs. Because the repository is private, the tarballs are the
authorized zero-cost channel; publish them to a registry only if the owner
authorizes that separately.

## Coordination with active owners

Audited on 2026-11-26. These branches are unmerged and were **not** rewritten or
force-pushed by this work:

| Branch | Head | Contract interaction |
| --- | --- | --- |
| `feat/intelligence-core` / PR #2 | `24c90e0` / `e14e4b7` | reserves `ChatFrame` and `negotiated`; adds tools/routing/knowledge routes |
| `feat/zero-cost-model-router` / PR #4 | `43f3581` / `b6e002b` | router internals; no new route ids |
| `feat/native-reasoning-planner` / PR #3 | `c241bae` / `90b87db` | permission producer; no new route ids |
| `feat/durable-events` | `9b3fd7d` | snapshots only |
| `feat/durable-events-integration` | `2554edc` | adds the persistent event log behind `streamTaskEvents`; not merged |
| `feat/execution-supervisor` / PR #5 | `a4fabac` / `13d4b4f` | supervisor internals; no new route ids |
| PR #7 | `9b4cb5c` | competing 1.1.0 surface; superseded by this catalogue |
| PR #8 | `ffec08f` | reserves six team operations |
| PR #9 | `d1f4b50` | reserves seven schedule operations |
| release train (`freebuff/4fc2df…`) | `6e70c5d` | adopted and repinned; no route ids |
| `ci/permanent-quality-gate` | `676ad8c` | gates; no route ids |
| `security/remediation-808dfd3` | `74b1264` | hardening; no route ids |

Three active shapes were adopted exactly rather than re-invented:
`ChatFrame` (as `ChatStreamFrame`, same fields), `negotiated` and the request
`accept` field, and `NotificationReadRequest { taskIds }` with
`markNotificationsRead`. The only rename is the TypeScript symbol
`ChatStreamFrame`, chosen because `ChatFrame` is already exported by the
intelligence branch; the wire shape is identical. The owner should drop the
duplicate symbol when merging.

### Ownership registry

`packages/contracts/src/ownership.ts` is the machine-readable half of the one
contract rule. `OPERATION_DOMAINS` maps every published id to exactly one domain;
`DOMAIN_OWNERS` names the runtime module and the audited head; and
`RESERVED_OPERATIONS` records every id proposed by an unmerged branch with its
exact head and either `blocked` or `superseded` status. A `superseded` id must
name the published id that owns the behaviour, so two names never describe one
operation. `tests/contract/ownership.test.ts` enforces exhaustiveness and refuses
a published/reserved collision.

The full branch-by-branch decisions, client status and persistence evidence are
in [`reconciliation.md`](reconciliation.md). Reserved ids are not to be added by
a client or gateway until their handler lands. When an owner branch rebases, it
should keep this catalogue as the single source of routes and delete its own
duplicate route entries; conflicts are expected in `routes.ts` and
`sdk/src/index.ts` and should be resolved in favour of one entry per operation.

The cross-repository harness is
`tests/integration/http-contract.test.ts`. It starts the real HTTP server and
drives the shared SDK through authentication, negotiation, Chat (JSON and SSE),
Work, streaming, cursor replay, cancellation, resume, retry, permissions, memory,
scheduling, notifications, artifacts and the read models. It is the executable
contract gateway and CLI owners can run before their integration:

```sh
npm ci
npm run verify
```
