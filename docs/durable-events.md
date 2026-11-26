# Durable events, notification mark-read and workspace quarantine

This branch closes the remaining durability and isolation gaps recorded in
[`parity-matrix.md`](parity-matrix.md) rows 18, 22 and 23. It is a reconciliation,
not a rewrite: the change set was authored against `51fd4ba`, preserved on
`feat/durable-events` as a base64 snapshot, and three-way merged onto the merged
`main` at `808dfd3`.

## What was already on main

Checked, not assumed, before anything was written:

- `a95e4bb`'s settlement shape: `try { ... } finally { releaseLease }`, the
  terminal event published before the transcript append and the notification,
  `.catch(() => undefined)` on both writes, one unified audit record.
- `text.replace { text: '' }` on resume and retry, and `checkpoint.text` reset in
  `reissue` (`mongo-tables.ts` and `tasks.ts`). All still present and unaltered.
- `src/execution/runner.ts` already exposes `onAbandoned`, `generation` and
  `workspaceRoot`. The hook existed with nothing registered against it; this
  branch supplies the registry, and **does not change the runner**.

## What this branch adds

### Durable execution events (row 22)

- `src/events/log.ts` — the `EventLog` port. Interface: `append`, `read`,
  `lastSeq`, `prune`, `close`. `append` returns `appended | duplicate |
  stale_generation`, so generation fencing is enforced at the storage boundary
  rather than trusted to callers.
- `src/persistence/mongo-events.ts` — the MongoDB implementation. A unique
  `(taskId, seq)` index makes a sequence number atomic; a unique `(taskId,
  eventId)` index catches redelivery; a `heads` row per task holds the highest
  generation and is advanced with `$max`, so a stale replica cannot lower it.
- `src/events/bus.ts` — the bus now persists. `flush` is the barrier, `hydrate`
  loads the durable watermark so a resumed task continues after it, `read` is the
  durable replay, `close` flushes on shutdown. A bounded pending queue sheds the
  oldest **non-terminal** events under backpressure; a terminal event is never
  dropped.
- `EventBus.read` is what `GET /v1/work/:id/events` now returns, so a reconnect
  after a restart replays what the previous process wrote instead of an empty
  in-process window. `Last-Event-ID` is honoured and the larger of the header and
  the `after` query wins, so a stale query cannot rewind a client.

### Settlement ordering

Three guarantees, in the order they take effect:

1. **Before** the terminal task write, `deps.events.flush(task.taskId)` runs. A
   task record cannot say a run finished while its stream is missing the events
   that led to it.
2. The transcript append re-checks `runToken` after the terminal write and writes
   nothing when the generation was superseded. The `catch` from `a95e4bb` is
   preserved, so a transcript failure still cannot strand a settled run.
3. In `finally`, the terminal event is flushed **before** `releaseLease`, so the
   lease cannot be reissued behind an unfinished stream. `finally` remains the
   only owner of the release.

`ensureTerminalEvent` repairs the one contradiction a crash can leave: a task
record that is terminal while the stream never received a terminal event. The
stream is completed from the authoritative task record, never the reverse.

### Notification mark-read (row 23)

`POST /v1/notifications/read` (`markNotificationsRead`) with
`NotificationReadRequest = { taskIds: TaskId[] }`, bounded to 1–100 entries. The
store only touches a row owned by the authenticated owner, so a guessed task id
clears nothing. Exposed on the SDK as `markNotificationsRead`.

### Workspace quarantine (execution isolation)

`src/execution/quarantine.ts` closes the gap a grace period cannot. A cancelled
adapter that ignores its abort keeps executing in-process; nothing there can kill
it. Three things already remove its authority — the lease is released under its
token, task writes are fenced, and reports from a non-current controller are
dropped. The remaining shared resource is the workspace directory.

`onAbandoned` now poisons that root for `execution.cancelQuarantineMs` (default
300 s). A new run in the same root is refused with `workspace_denied` at submit
and again at start, which is the same fail-closed answer a bad root already gets.
The entry expires on its own so a deployment recovers without an operator, and
`workspaces.quarantine` reports a non-required degraded health check while any
root is held.

## Coordination with PR #2 (`feat/intelligence-core`)

PR #2 adds the native tool loop, model router, MCP, retrieval and durable
approvals. The merge was **exercised**, not estimated: `git merge-tree` against
PR #2's head produces a merged tree and five conflicted files.

PR #2's head is not stable — it advanced from `2072df8` to `7a1036b` to `c8f9a34`
while this branch was being reconciled. Re-measure against its head at merge
time; the table below was measured at `c8f9a34`.

| File | This branch | PR #2 | Measured result |
| --- | --- | --- | --- |
| `src/orchestration/service.ts` | imports, `ApplicationServiceDeps.quarantine`, `settle()`, `execute()`, `events()`, `markNotificationsRead` | imports, deps `tools`/`knowledge`/`modelRouter`, `approvalGate`, `nativeContext`, the `suspended` branch in `settle()`, history gating | **conflict** — deps type and `settle()` preamble |
| `src/bootstrap/compose.ts` | `createEventBus` gets the log, quarantine creation, `onAbandoned`, health check, container entry | model provider rewrite, tools/knowledge/MCP wiring | **conflict** — same builder region |
| `src/bootstrap/container.ts` | one new `quarantine` dependency | three new dependencies | **conflict** — adjacent lines in `InfrastructureDependencies` |
| `packages/contracts/src/routes.ts` | appends `markNotificationsRead` to `ROUTES` | inserts five routes after `listModels` | **conflict** — both edit the array |
| `docs/parity-matrix.md` | rows 18, 22, 23 and the summary counts | 13 changed lines for its own rows | **conflict** — same table |
| `src/api/routes.ts` | appends one handler | inserts handlers mid-file | auto-merges |
| `src/configuration/schema.ts` | two fields inside `execution` | new top-level blocks | auto-merges |
| `packages/contracts/src/permissions.ts` | adds `NotificationReadRequest` | adds scopes | auto-merges |
| `openapi.json` | regenerated | regenerated | auto-merges textually; regenerate after any resolution |

All five are the same kind of conflict: both sides append or extend one
structure. None is a disagreement about behaviour, and none requires dropping a
change from either side.

### The other branches in flight

Two more feature branches exist off `main` and were measured the same way. This
branch was written without knowledge of them, so the result is a useful
independence check:

| Branch | Head | Files it changes | Conflicts with this branch |
| --- | --- | --- | --- |
| `feat/native-reasoning-planner` | `37b5292` | `src/agents/native/**`, `src/domain.ts`, `src/execution/runner.ts`, `service.ts`, `compose.ts`, `configuration/schema.ts`, `permissions/gate.ts` | `docs/parity-matrix.md` only — every source file auto-merges |
| `feat/zero-cost-model-router` | `7ae5cbc` | `src/models/**`, `service.ts`, tests | `docs/parity-matrix.md` only — every source file auto-merges |

Both merge cleanly apart from the capability table. That is deliberate: this
branch adds no agent reasoning, no model routing and no provider transport, so it
has nothing to duplicate. `src/models/**`, `src/agents/**`, `src/tools/**` and
`src/mcp/**` are untouched here.

The capability table is the one universal conflict, because every change that
closes a row edits it. Resolve it by keeping every branch's row edits and
recounting the summary. Do not drop it from any branch: a matrix that still says
`Missing` for a shipped capability is a false record.

**Untouched by this branch:** `src/execution/runner.ts`, all of `src/agents/**`,
`src/models/**`, `src/tools/**`, `src/mcp/**`, `src/knowledge/**`,
`src/persistence/tasks.ts` and `src/persistence/mongo-tables.ts`. PR #2's agent,
router, tool and approval work is therefore not disturbed, and this branch adds no
second implementation of any of it. No file in this branch was changed by both
sides for a behavioural reason.

Resolution rule if both land:

1. `settle()` — keep PR #2's `suspended` branch **first**. It returns before any
   terminal write, so it needs no flush. Then this branch's pre-write flush, the
   terminal publish, the token re-check before the transcript append, the
   notification and the audit record, and this branch's flush-then-release
   `finally`. PR #2's `suspended` branch releases its own lease inside its own
   `finally`; that stays.
2. `container.ts` / `ApplicationServiceDeps` — keep all four: PR #2's `tools`,
   `knowledge`, `modelRouter` and this branch's `quarantine`, then add all four to
   `INFRASTRUCTURE_DEPENDENCIES`.
3. `compose.ts` — keep both. The bus gets `log` and `retain`; the container gets
   `quarantine`; `createTaskRunner` keeps `onAbandoned` alongside PR #2's
   gateway, router, tools, knowledge and MCP wiring.
4. `routes.ts` — keep all six added operations. Regenerate `openapi.json` with
   `npm run openapi:write` rather than merging it by hand.
5. `docs/parity-matrix.md` — keep PR #2's row edits and this branch's rows 18, 22
   and 23, then recount the summary table.

After resolving, `npm ci && npm run verify` must pass at the resolved head. A
merged tree from `git merge-tree` is not evidence; only a green run at the pushed
head is.

## Verification

At the pushed head, on top of `808dfd3`:

```
npm ci
npm run build          # tsc -b, exit 0
node --test "dist/tests/**/*.test.js"
ℹ tests 114   ℹ pass 114   ℹ fail 0
node dist/scripts/check-openapi.js
openapi.json matches the published contracts
```

`tests/unit/events-durable.test.ts` is the new suite (13 cases): sequence and
duplicate rejection, generation fencing, retention pruning, hydrate-after-restart,
terminal events surviving backpressure, notification isolation by owner, and
quarantine expiry and refusal. `tests/fakes/mongo.ts` gained the operator support
those tests need — `$lt`, `$gte`, `$max`, and a real upsert that keeps the
filter's equality fields.

**Not verified:** a live MongoDB (the same limitation as every other durable store
here), a multi-replica race, hosted CI on this branch at the time of writing, and
any deployment.

## Recovery artefacts

The authored change set is preserved on `feat/durable-events` under `snapshots/`
(`MANIFEST.md`, `RECONCILIATION.md`, `STATUS.md`, four base64 parts). That branch
also records the earlier, now-lost `a95e4bb`-reconciled patch. Keep it until this
branch is merged and verified on `main`; delete it in the commit that removes the
scaffolding.
