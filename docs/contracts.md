# Contracts and SDK

## One authoritative description

`packages/contracts/src/routes.ts` is the single source of the HTTP surface. Each
entry declares:

- `operationId` — the stable name a client and the router share;
- `method` and `path` (OpenAPI-style `{param}` segments);
- `auth` — `owner` or `public`;
- optional `params`, `query` and `body` zod schemas;
- the success `response` (status, description, schema) and whether it streams.

From that list the engine derives:

1. **The OpenAPI 3.1 document** (`buildOpenApiDocument`), including JSON Schema
   converted from the same zod schemas. `openapi.json` is committed and regenerated
   by `npm run openapi:write`.
2. **The route table** the server can register. `createRouteRegistry` refuses an
   operation that is not in the catalogue and refuses a duplicate registration.
3. **The startup completion gate.** `composeApplication` fails when a documented
   operation has no handler, so a route cannot be documented but unimplemented.

Because request and response schemas come from the same zod objects, a documented
field cannot differ from an enforced field. The router validates the request and
the successful response; failures use the shared `Problem` body.

## Versioning

| Surface | Version | Where |
| --- | --- | --- |
| HTTP contracts | `CONTRACT_VERSION = '1.1.0'`, served at `/v1` | `primitives.ts` |
| Execution events | `EVENT_SCHEMA_VERSION = 1` | `events.ts` |
| Chat stream frames | `CHAT_STREAM_VERSION = 1` | `tasks.ts` |
| Contracts package | matches `CONTRACT_VERSION` | `packages/contracts/package.json` |
| SDK | matches `CONTRACT_VERSION` | `packages/sdk/package.json` |

`1.1.0` is additive over `1.0.0`: new operations and new optional request
fields only. A `1.0.0` client is therefore still accepted, and the handshake says
so (`negotiation: client_supported`). A newer minor is refused with
`negotiation: client_ahead` rather than failing one operation at a time, and a
new major with `unsupported_major`.

## Handshake and negotiation

`GET /v1/handshake?contract=<version>` is the only source a client should trust
about what a deployment serves.

- `operations` is built from the **route registry**, not the catalogue, so an
  operation with no handler cannot appear.
- Every capability flag is derived from those operations. A `false` means the
  operation is not published, never that it is planned.
- `eventSchemaVersion` and `chatStreamVersion` are reported separately because a
  consumer can be compatible with HTTP and incompatible with a stream.
- `limits` states the body, buffer, concurrency and artifact bounds the client
  must respect instead of discovering them as failures.

`checkCompatibility()` in `@coderax/sdk/compat` turns a handshake into a list of
concrete problems (contract major, supported versions, event/chat schema,
missing operations). Clients should call it once at startup.

Rules:

- Adding an optional request field or a new operation is backward compatible.
- Removing or renaming a field, changing a type, or changing a status code is
  breaking: bump `CONTRACT_VERSION`, add a new `/vN` prefix, and keep the old
  prefix until both clients have moved.
- An execution event payload change bumps `EVENT_SCHEMA_VERSION`; consumers must be
  able to ignore an unknown event type rather than fail the stream.

## Execution events

Every event is an envelope plus a payload:

```json
{
  "v": 1,
  "eventId": "evt_...",
  "taskId": "task_...",
  "seq": 7,
  "at": "2026-11-26T04:00:00.000Z",
  "agent": "coderax",
  "generation": 1,
  "type": "text.delta",
  "payload": { "text": "..." }
}
```

- `seq` is assigned only by the event bus and increases by one per task.
- A consumer that has already seen an `eventId` must ignore it.
- A consumer that receives `seq <= lastSeen` must ignore it and resync from
  `GET /v1/work/{taskId}/events?after=<lastSeen>`.
- A bounded per-task buffer means an old cursor can be truncated; the replay
  response says so, and the client must re-read task state.

## Chat streaming

`POST /v1/chat` is negotiated by `Accept`:

- `accept: text/event-stream` streams versioned `ChatStreamEvent` frames:
  `chat.started`, zero or more `chat.delta` / `chat.replace`, then exactly one of
  `chat.completed` (carrying the full `ChatReply`) or `chat.failed`;
- anything else returns the `ChatReply` as one JSON body.

Both paths run the same server code and persist the reply once. Every condition
that can be a `Problem` is decided **before** the first frame, so a caller never
receives `200 text/event-stream` followed by a failure it cannot branch on.

## Event replay and truncation

`GET /v1/work/{taskId}/events?after=<seq>` replays retained events from a
sequence cursor and then tails live ones. The stream closes on the terminal event.
If the cursor is older than the retained window the first frame is
`stream.truncated` with `{ after, oldestSeq }`, so a gap is reported rather than
silently rendered. A cursor at or past the terminal sequence closes immediately:
the engine will never publish another event for that task.

## Idempotent submission

`WorkSubmitRequest.idempotencyKey` makes a submission safe to retry. The key is
reserved before a lease is claimed or a budget slot is spent, so two concurrent
retries cannot both create a run and a network retry cannot exhaust the daily
budget. A repeat returns the original `TaskAccepted` with `replayed: true`.

The guarantee is process-local: keys are held in memory, so they do not survive a
restart and do not apply across replicas. A retry after a restart is handled as a
new submission.

## Schedules, artifacts and memory retrieval

- A schedule holds no lease and owns no run. A firing submits ordinary Work under
  an idempotency key derived from its slot, so an overlapping tick cannot submit
the same firing twice. `nextRunAt` always moves a full interval from the firing
  time, so a paused or busy period produces skipped firings, not a catch-up storm.
- An artifact's `digest` is `sha256:` over the bytes the engine stored. A caller
  never supplies `bytes` or `digest`; an owner attachment is hashed on arrival and
  a completed run's transcript is stored as `result.md`.
- `searchMemory` is lexical and deterministic. It is retrieval, not a model call,
  and it only ever sees the owner's single data-mode partition.

## SDK rules

`@coderax/sdk` is the only client. It:

- sends `Authorization: Bearer <token>` on every owner operation;
- validates every request body against the route catalogue before sending it, so
  the catalogue is the only description of a payload on both sides;
- refuses redirects and keeps no cookie jar;
- parses every response and every stream frame with the contract schemas, throwing
  `CoderaxContractError` rather than returning a shape the contract does not
  describe;
- throws `CoderaxApiError` with the stable `code`, HTTP `status`, `requestId` and
  `retryable` flag from the `Problem` body;
- never places the token in a URL or an error message.

Do not add a second client contract, a hand-written DTO, or a divergent copy of a
payload in either consuming repository.

### Entrypoints and distribution

| Import | Contains |
| --- | --- |
| `@coderax/sdk` | `CoderaxClient`, typed errors, `SDK_OPERATION_COVERAGE` |
| `@coderax/sdk/version` | `SDK_VERSION`, contract/event/chat versions |
| `@coderax/sdk/compat` | `checkCompatibility()` |

The package is distributed as a deterministic tarball committed at a versioned
path (`packages/sdk/artifacts/coderax-sdk-<version>.tgz`), with per-file and
whole-archive sha256 digests in `packages/sdk/sdk-artifact.json`. It is not
published to a registry, so installation costs nothing and resolves no mutable
tag. The tarball vendors `@coderax/contracts`, so only `zod` comes from a
registry.

The archive is byte-reproducible: sorted entries, zero mtime/uid/gid, fixed mode
and a zeroed gzip timestamp. `npm run sdk:check` rebuilds it in memory and fails
when the committed bytes, the manifest, or a package version has drifted.

The artifact must be produced from a **clean** build. TypeScript prints inferred
union members in a different order when it reuses an incremental `.tsbuildinfo`,
so a `.d.ts` emitted from an incremental build carries the same types but
different bytes. `sdk:bundle`, `sdk:check` and `verify` therefore run
`tsc -b --clean` before building. An artifact built from incremental output
passes a local check and fails a clean CI checkout; that is exactly the drift
these scripts now make impossible.

`SDK_OPERATION_COVERAGE` maps every published `operationId` to the client method
that serves it. `tests/contract/sdk-coverage.test.ts` fails when an operation has
no method or a method has no operation, and
`tests/integration/http-contract.test.ts` drives every operation over real HTTP
through those methods.

## Adding an operation

1. Add the `RouteSpec` to `ROUTES`.
2. Register a handler in `src/api/routes.ts` and delegate to the service.
3. Add the operation to `SDK_OPERATION_COVERAGE` and a client method in
   `packages/sdk`.
4. `npm run openapi:write` and commit `openapi.json`.
5. `npm run sdk:bundle` and commit the artifact and manifest.
6. Add a contract test. `npm run verify` must pass.

## Drift gate

```bash
npm run openapi:check
```

It fails when the committed document differs from the code, when a documented
operation has no handler (startup gate), or when a handler's response does not match
its declared schema (router). It was verified negatively: changing one title in
`openapi.json` makes the command exit 1.

`npm run sdk:check` is the same gate for the distributed client: it fails when
the committed tarball or manifest differs from a rebuild of the current source.
