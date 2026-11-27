# Real MongoDB verification

On 2026-11-26 the production Mongo persistence path was exercised against a real
MongoDB 8.0.4 server, not the collection fake. The server ran workspace-local on
`127.0.0.1:27018` with a standalone data directory.

## What ran

1. `composeApplication` with `persistence.driver=mongo`, the real driver and a
   fresh database. Startup created the task, conversation, message, memory,
   notification and Work-run indexes.
2. The HTTP service submitted a Work task, waited for `completed`, and left the
   task, transcript and notification in MongoDB.
3. Two independent `MongoClient` connections raced `insertIfAbsent` for the same
   Work-run key. The unique index admitted exactly one: results `[true, false]`.
4. MongoDB was stopped and restarted on the same data directory. A new
   application process, with no in-memory state, read the task back as
   `completed`, the transcript as `["user", "assistant"]`, and one unread
   notification for the same task.

Exact IDs, results and limits are in `report.json`.

```
phase 1: task_c4721854-f5ec-453f-b165-df89b7fa60bc
         lease race [true,false], winner token-a
restart: old pid 16257 stopped, new pid 16632
phase 2: completed, ["user","assistant"], unread 1
```

## Game projects across a restart

A separate integration test now closes a composed engine, opens a fresh one over
the same workspace, finds the verified build in history, restores it with its
exact spec and reads the self-contained preview. That test passes, but the game
project/build store is **file-backed**, not MongoDB-backed: the authoritative
durable artifact service is still an unmerged branch. Cross-replica game-project
edits/restores and object-store durability are therefore not claimed.

## Limits

- Standalone local server, loopback only, no auth or TLS: a test instance, not a
  production deployment.
- No replica-set failover, Atlas, network partition or multi-node test.
- The MongoDB binary and `mongodb` driver were installed test-only in the
  workspace; the driver was not added to `package.json` or the lockfile.
- The engine's `mongo` path still requires the deployer to install a supported
  driver, as its startup error states.
