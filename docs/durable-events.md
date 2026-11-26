# Durable execution events

Execution events are the stream a client replays to render a Work run. They are
sequenced by the bus and stored by the persistence layer, so a reconnect after an
API restart receives the events a previous process wrote.

## What is durable

| Concern | Where | Guarantee |
| --- | --- | --- |
| Event stream | `src/events/log.ts`, `src/persistence/mongo-events.ts` | One row per `(taskId, seq)`; a reused sequence or event id is refused |
| Generation fence | event head row, `$max` generation | A superseded generation cannot append after a newer one has written |
| Bus backpressure | `src/events/bus.ts` | Pending events are bounded; intermediate deltas are dropped, terminal events are not |
| Terminal barrier | `OrchestrationService.settle` | The terminal event is flushed before the task record says the run is over |
| Terminal repair | `ensureTerminalEvent` | A terminal task whose terminal event was lost gets it from the task record on read |
| Retention | `prune(taskId, keep)` | The newest `execution.eventRetain` events per task survive |
| Workspace quarantine | `src/execution/quarantine.ts` | An adapter that ignored its abort keeps its workspace out of service for a bounded window |

## Client contract

- `GET /v1/work/{taskId}/events?after=<seq>` replays and then tails.
- `Last-Event-ID` is accepted as an equivalent resume cursor; the larger cursor
  wins so a stale query cannot rewind a client.
- `truncated: true` means events between the caller's cursor and the retained
  window are gone; the client must re-read `GET /v1/work/{taskId}`.
- A duplicate `eventId` is ignored; a `seq` less than or equal to the last seen
  one is ignored.

## Restart behaviour

The bus hydrates its per-task watermark from the durable log before a resumed
generation publishes. A task that was queued but whose process died is retired as
`interrupted` by startup ownership verification; its stream is completed from the
authoritative task record if the terminal event is missing.

## Evidence

- `tests/unit/events-durable.test.ts` — restart replay, duplicate and stale
  generation refusal, retention truncation, backpressure and quarantine.
- `tests/unit/events.test.ts` — bus ordering and replay semantics.
- `tests/e2e/end-to-end.test.ts` — a client streams a completed run.

These tests exercise the log port directly and through the HTTP surface. A live
MongoDB replay is covered by the persistence integration suite rather than by a
fake collection.
