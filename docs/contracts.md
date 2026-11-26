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
| SDK | matches `CONTRACT_VERSION` | `packages/sdk/package.json` |

The version literal in the `/v1/health` response remains `1.0.0` so clients
using the original v1 schema can still parse it.

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

## Browser operations

`/v1/browser/*` is declared in the same catalogue and follows the same rules:

- `browserCapabilities` reports truthful availability; a provider is operational
  only after a versioned handshake with every feature and a free cost class.
- Session creation takes an exact origin allowlist and always runs in cloud
  infrastructure.
- `browserAction` performs one navigation, inspection, screenshot, accessible
  discovery, form, keyboard, mouse, tab, upload or download action.
- Sensitive categories use the permission store with `browser.control` or
  `browser.transfer`; a grant is single-use and bound to
  `browser:<sessionId>:<category>`.
- Screenshots, uploads and downloads are returned as artifacts whose SHA-256 is
  computed by the engine; page observations carry `trust: "untrusted"`.
- Receipts are a separate, bounded append-only window of what was attempted,
  refused or performed. Retention is per session; they are not execution events
  and do not enter a Work task stream.

`docs/browser.md` documents the provider protocol, the safety model and the
verification evidence required before the capability may be called operational.

## SDK rules

`@coderax/sdk` is the only client. It:

- sends `Authorization: Bearer <token>` on every owner operation;
- refuses redirects and keeps no cookie jar;
- parses every response and every event with the contract schemas, throwing
  `CoderaxContractError` rather than returning a shape the contract does not
  describe;
- throws `CoderaxApiError` with the stable `code`, HTTP `status`, `requestId` and
  `retryable` flag from the `Problem` body;
- never places the token in a URL or an error message.

Do not add a second client contract, a hand-written DTO, or a divergent copy of a
payload in either consuming repository.

## Adding an operation

1. Add the `RouteSpec` to `ROUTES`.
2. Register a handler in `src/api/routes.ts` and delegate to the service.
3. Extend `packages/sdk` if a client needs it.
4. `npm run openapi:write` and commit `openapi.json`.
5. Add a contract test. `npm run verify` must pass.

## Drift gate

```bash
npm run openapi:check
```

It fails when the committed document differs from the code, when a documented
operation has no handler (startup gate), or when a handler's response does not match
its declared schema (router). It was verified negatively: changing one title in
`openapi.json` makes the command exit 1.
