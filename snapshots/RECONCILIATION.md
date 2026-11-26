# Reconciliation required before this change set lands

## What happened

- The snapshot patch was generated against **`51fd4ba`** (then the head of
  `feat/workflow-engine-foundation`).
- That branch has since advanced to **`a95e4bb`**, a CodeRabbit commit:
  `fix(engine): clear output on retry and resume, release leases on settlement
  failures, and broaden credential redaction`.
- The patch **must not** be force-applied to `a95e4bb`. One file it changes was
  rewritten underneath it.

## Files the newer commit touches

| path | in this snapshot? |
| --- | --- |
| `src/observability/redact.ts` | no |
| `src/orchestration/service.ts` | **yes - overlapping** |
| `src/persistence/mongo-tables.ts` | no |
| `src/persistence/tasks.ts` | no |
| `tests/integration/work.test.ts` | no |
| `tests/unit/mongo-stores.test.ts` | no |
| `tests/unit/redact.test.ts` | no |

The other 19 snapshot paths are untouched by `a95e4bb` and apply cleanly.

## Why `service.ts` conflicts

`a95e4bb` restructured `settle()`. The snapshot also changes `settle()` (it
adds a durable-event flush barrier before the terminal event). The two edits
occupy the same region, so the hunk context no longer matches.

`a95e4bb` semantics that **must survive** the reconciliation:

1. The whole post-settlement block is wrapped in `try { ... } finally { await
   releaseLease(task, token); }` - a lease is released even when a later step
   throws.
2. The terminal event (`task.completed` / `task.cancelled` / `task.failed`) is
   published **before** the transcript append and the notification.
3. `appendMessage` and `notifyTerminal` are awaited with `.catch(() =>
   undefined)`; a transcript or notification write failure must not strand a
   settled run or skip the audit record.
4. `execute()` starts from `let text = ''` instead of the persisted checkpoint
   text, and `resumeTask`/`retryTask` publish `text.replace { text: '' }` so a
   client cannot keep rendering the previous run's output.
5. `reissue` in both `mongo-tables.ts` and `tasks.ts` clears
   `checkpoint.text` while preserving `completedSteps`.

## How to reconcile

1. Check out `51fd4ba` in a clean clone.
2. Apply `pending.patch` (see `MANIFEST.md`) and confirm the 111/111 result.
3. Rebase the result onto `a95e4bb`. The only conflict should be
   `src/orchestration/service.ts`.
4. In `settle()`, keep the `try/finally` shape, the terminal-event-before-append
   ordering and the `.catch(() => undefined)` calls from `a95e4bb`, and insert
   the snapshot's flush barrier **before** the terminal event is published, so
   the event is durable before the settlement is announced.
5. Keep both `text.replace { text: '' }` calls from `a95e4bb`; the snapshot does
   not remove them.
6. Re-run `npm ci && npm run verify` on the rebased tree.

Until step 6 passes, the change set is preserved but **not** integrated.

## Status of this branch

The four snapshot parts are committed and each was confirmed byte-identical to
the authored file by comparing git blob hashes after upload. The sandbox that
authored them has since been reclaimed, so this branch is now the only copy.
