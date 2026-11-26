# Durable execution, event persistence and recovery

This change closes the durable-execution defects found reviewing `main` at
`808dfd3`. It is not a report: every row below has a test that reproduces the
defect and a code path that fixes it.

## The rule the design follows

The **task record is authoritative**. The execution event stream, the transcript
message and the notification are *derived* records. Any of them can be missing
after a crash, so recovery rebuilds them from the task record — never the other
way round. That is the durable-outbox shape used here instead of a multi-document
transaction, because the Mongo port is a driver-agnostic structural subset and a
transaction would require a replica set the deployment does not promise.

Every derived write is idempotent:

| Record | Idempotency key |
| --- | --- |
| Execution event | per-task `seq` (unique) and `eventId` (unique) |
| Terminal event added by repair | `repair_<taskId>_g<generation>` |
| Assistant transcript message | `<taskId>:g<generation>:assistant` |
| User prompt message | `<taskId>:user` |
| Notification | one row per `taskId` (upsert) |

## Defects and their fixes

| Defect | Fix | Test |
| --- | --- | --- |
| Ignored `after` event cursor | The router validated a coerced query and then passed the raw string map to the handler, so `after` was never a number. It now passes the parsed value, and `Last-Event-ID` is honoured, with the larger cursor winning. | `the event stream honours the after cursor and Last-Event-ID` |
| Replay-to-subscribe event gap | `EventBus.open` subscribes **before** the durable read and buffers; the replay and the buffered tail are delivered as one stream. | `opening a stream does not drop an event published during the durable read` |
| Event sequence resets after restart | `hydrate` loads the durable per-task watermark (sequence + generation) before a run publishes; `seq` continues instead of restarting at one. | `a restarted bus continues the durable sequence instead of resetting to one`, `a restart over a fake MongoDB store resumes the sequence and serves the replay` |
| Duplicate terminal events | The stream has a unique `(taskId, eventId)` and `(taskId, seq)`; repair uses a stable id and only appends when no terminal event exists. | `the same terminal event delivered twice is stored once` |
| Permanently lost notifications | A notification that failed during settlement is restored from the task record on the next start. | `a notification lost during settlement is repaired after a restart` |
| Unhandled persistence promise rejections | Step checkpoints are a serialized promise chain that is awaited before settlement and cannot reject the process; `void` writes are gone. | `a rejected checkpoint write is contained and the run still settles` |
| Crash-consistent task settlement | The fenced task write happens first; the terminal event is flushed after it; a crash between them is repaired from the record. | `a crash after the terminal task write is repaired from the record on restart` |
| Durable event and transcript repair | `repair` restores a missing terminal event, assistant message and notification per settled task in a bounded startup window, idempotently. | the two crash tests above |
| Generation-specific idempotency | A generation older than the durable watermark is refused before it consumes a sequence, in the store and on the bus. | `a stale generation is refused by the log and by the bus`, `a fake-Mongo append from a superseded generation is refused and leaves no row` |
| Stale-generation writes | `publish` returns `null` for a superseded generation and never writes it; the store uses a compensating delete for the narrow insert/head race. | same |
| Lease recovery and retention | A **missing** lease row is treated like an expired one, so a pruned row cannot leave a task `running` forever; `execution.retentionMs` is finally applied in a bounded startup sweep. | `a running task whose lease row was pruned is retired as interrupted`, `lease retention prunes an expired row at startup and keeps a live one` |
| Incorrect retry eligibility | Owner retry requires `retryable: true` **and** a pre-dispatch failure code; the bounded retry policy is now on the execution path for automatic attempts inside the same lease. | `a failure that is not retryable is refused a retry instead of replayed`, `a retryable pre-dispatch failure is replayed inside the same lease and generation` |
| Checkpoint persistence | Step boundaries persist the completed steps and the whole redacted step output; writes are ordered and awaited before settlement. | `a graceful stop interrupts an adapter that is still running and releases its lease` |
| Resumption repeats completed steps | `resume` carries `completedSteps` and the prior output; Native skips completed steps and seeds its summary with their output. | `a resume continues completed steps instead of repeating them` |
| Orphaned transcript messages after rejected submissions | The user prompt is written only after the lease and task record exist, with a task-derived id; a `busy` refusal writes nothing. | `a rejected submission leaves no orphaned user message` |
| Task interruption while adapters remain active | Shutdown aborts, waits a bounded grace, then retires every still-active run under its fence, releases its lease and records `interrupted` (never `cancelled`). | `a graceful stop interrupts an adapter that is still running and releases its lease` |

The in-process `EngineRunArbiter` was unused. It is now acquired for
`<lease key>:<run token>` before an adapter starts and released in `finally`, so
the same generation cannot be started twice locally while a newer generation is
still free to take over (`the arbiter is on the execution path and refuses a
duplicate generation`).

## Event log

`src/events/log.ts` is the port; `src/events/bus.ts` is the only producer.

- `append` reports `appended | duplicate | out_of_order | stale_generation`. A
  refused write is never silently applied.
- `watermark` is `{ seq, generation }` per task. `seq` is monotonic across
  generations and restarts; `generation` only ever increases.
- MongoDB (`src/persistence/mongo-events.ts`) uses two collections: `events` with
  unique `(taskId, seq)` and `(taskId, eventId)`, and `event_heads` advanced with
  `$max` so a delayed replica cannot lower the watermark.
- Retention (`prune`) is bounded, time-based, and never removes the newest event
  of a task, so a reconnecting client always has an ending to replay.
- The bus never reports an event as durable before `flush` resolves. Settlement
  awaits that barrier before announcing the terminal state and before releasing
  the lease.

## Verification tiers

These are deliberately separate and are not interchangeable.

1. **In-memory** (`persistence.driver = memory`). The event log is a real
   implementation with the same ordering and fencing rules, but it lives in one
   process. A restart loses it. `the in-memory log survives only the process that
   owns it, and says so` asserts exactly that, and the driver is reported as
   `memory`.
2. **Fake MongoDB** (`tests/fakes/mongo.ts`). The stores, indexes and repository
   code are the production ones; only the driver is a fake that enforces declared
   unique indexes and the cursor operators used. Restart tests build a second
   application over the same fake database, which is a genuine re-creation of all
   process state. This proves the wiring and the semantics, **not** that a server
   stored a row.
3. **Actual MongoDB**. `a real MongoDB stores the stream and resumes its sequence
   after a restart` runs only when `CODERAX_MONGODB_URI` names an authorized
   database. Without it the test is **skipped** and reported as skipped; it is
   never counted as durable verification. No live MongoDB was contacted while
   authoring this change, and the PR says so.

## What is not verified here

- No live MongoDB was contacted, so no claim is made about a real server storing
  a row, index build timing, or replica behaviour.
- No multi-replica race was executed. The fencing and watermark rules are
  enforced by the store contract and tested against the fake, not across two
  processes.
- Hosted CI is reported only after this branch is pushed, at the exact head.
- No deployment was performed.

## Coordination

`src/orchestration/service.ts`, `src/bootstrap/compose.ts`,
`src/bootstrap/container.ts`, `src/bootstrap/persistence.ts`, `src/api/router.ts`,
`src/api/routes.ts`, `src/api/server.ts` and `docs/parity-matrix.md` overlap with
Intelligence Core PR #2 and with the `feat/durable-events-integration` branch.
The merge surface is measured against their heads with `git merge-tree` and
recorded in the pull request; behaviour from both sides is kept, and no second
implementation of the event bus is introduced. This branch replaces the
`feat/durable-events-integration` event-log design (that branch is based on an
earlier snapshot); its notification mark-read and workspace quarantine are out of
scope for this defect list and are not duplicated here.

## Rollback

Reverting the commit removes the durable log wiring and returns the bus to the
in-process window. No migration is required: the event collections are additive
and unused by the old code. A deployment can keep them for inspection or drop
`<prefix>events` and `<prefix>event_heads`.
