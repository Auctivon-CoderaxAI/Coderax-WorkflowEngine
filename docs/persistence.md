# Persistent application data

`persistence.driver` selects one of two complete store sets. There is no mixed
mode: a lease cannot be durable while the task row it fences is process-local.

| Driver | Use | Restart behaviour |
| --- | --- | --- |
| `memory` | tests, a single disposable process | everything is lost |
| `mongo` | the production path | every store below survives a restart |

Selecting `mongo` without a connection string, without the `mongodb` driver, or
without a reachable, indexable database is a startup failure. There is no silent
downgrade.

## What is stored

| Record | Collection | Key / index | Contract surface |
| --- | --- | --- | --- |
| Work lease | `work_runs` | unique `key`, `expiresAt` | internal fencing |
| Task | `tasks` | unique `taskId`, `(ownerId, updatedAt, taskId)`, `state` | `GET /v1/work`, `GET /v1/work/{id}` |
| Conversation | `conversations` | unique `conversationId`, `(ownerId, updatedAt, conversationId)` | `GET /v1/conversations` |
| Message | `messages` | unique `messageId`, `(conversationId, createdAt)` | `GET /v1/conversations/{id}` |
| Execution event | `events` + `event_heads` | unique `(taskId, seq)`, unique `(taskId, eventId)`, monotonic generation head | `GET /v1/work/{id}/events` |
| Checkpoint | `checkpoints` | unique `checkpointId`, `(taskId, createdAt, checkpointId)` | recovery evidence |
| Memory | `memory` | unique `(ownerId, mode, key)` | `GET /v1/memory` |
| Notification | `notifications` | unique `taskId`, `(ownerId, createdAt, taskId)`, `(ownerId, read)` | `/v1/notifications` |
| Permission request | `permissions` | unique `requestId`, `(ownerId, taskId, requestedAt)` | `/v1/work/{id}/permissions` |
| Audit receipt | `audit_receipts` | unique `receipt`, `(actor, at)`, `(taskId, at)` | `GET /v1/work/{id}/receipts` |
| Idempotency record | `idempotency` | unique `(ownerId, key)`, `expiresAt` | `POST /v1/work` |

The collection names are prefixed by `persistence.collectionPrefix`, so one
database can host more than one deployment without sharing a row.

## Isolation

- Every read is scoped by `ownerId`; a foreign id is `not_found`, not `forbidden`,
  so existence is not leaked.
- Memory is partitioned by `(ownerId, mode, key)`; the mode is part of the key,
  not a filter a caller can forget.
- Naming an existing conversation requires the same data mode; a cloud task
  cannot adopt private history and a private task cannot read cloud history.
- The conversation store deletes only for the owning owner, and every cascade
  target exposes an owner-scoped delete. The HTTP deletion operation refuses
  while a task is live and performs the cascade in one service call.

## Bounded reads

Every list is cursor-paged with a hard page cap (200 rows, 500 for memory) and a
stable `(timestamp, id)` sort. `nextCursor` is opaque; an invalid cursor is a
`validation_failed` problem, never an unbounded scan. `total` is the count
matching the filter, independent of the page. Notifications always report the
owner's total unread count even when the page is smaller.

## Retention

`retention` configures one window per record class: notifications (30 d), audit
receipts (90 d), permissions (7 d), checkpoints (30 d) and idempotency records
(24 h). The sweep runs at startup and on `sweepIntervalMs`, removes at most
`batchSize` rows per pass (ten passes maximum), and is safe on every replica
because every delete is conditioned on the row's age. Conversations, tasks and
their messages are deliberately not on an automatic timer: they are removed only
by the owner-authorized conversation deletion, so a retention bug cannot erase
user history.

## Restart evidence

`tests/integration/mongo-restart.test.ts` is skipped without a live server. Run it
against a real MongoDB:

```sh
CODERAX_TEST_MONGODB_URI='mongodb://127.0.0.1:27019/?directConnection=true' \
  npm run test:mongo
```

It submits a task with an idempotency key, waits for completion, stops the whole
application, starts a second application against the same database, and verifies
the task, transcript, event tail, notification, memory entry, permission request,
checkpoints, audit receipts and idempotent replay. A fake collection is used for
adapter semantics only; it is not accepted as persistence evidence.
