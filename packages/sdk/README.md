# @coderax/sdk

The one client for Coderax WorkflowEngine. Coderax (web) and CoderaxCLI must both
consume this package: neither repository may carry its own DTOs or a second
client contract.

## Entrypoints

| Import | Contains |
| --- | --- |
| `@coderax/sdk` | `CoderaxClient`, typed errors, `SDK_OPERATION_COVERAGE` |
| `@coderax/sdk/version` | `SDK_VERSION`, contract/event/chat versions, `sdkMetadata()` |
| `@coderax/sdk/compat` | `checkCompatibility(handshake)` |

## Install from the pinned artifact

The package is distributed as a deterministic tarball committed at a versioned
path. It is not published to a registry, so installing it spends nothing and
resolves no mutable tag.

```bash
npm install /path/to/Coderax-WorkflowEngine/packages/sdk/artifacts/coderax-sdk-1.1.0.tgz
```

Verify the artifact before installing:

```bash
sha256sum packages/sdk/artifacts/coderax-sdk-1.1.0.tgz
```

The digest must equal `sha256` in [`sdk-artifact.json`](./sdk-artifact.json). That
manifest also lists a digest per file. Regenerate both with `npm run sdk:bundle`;
`npm run sdk:check` fails when the committed artifact differs from the source, so
a stale tarball cannot be shipped.

Both scripts run `tsc -b --clean` first. An incremental TypeScript build emits the
same declarations with a different union-member order, which changes the digest
without changing the types, so only a clean build can reproduce the shipped bytes.

The tarball vendors `@coderax/contracts` inside its own `node_modules`, which is
why installing it needs only `zod` from the registry.

## Start a client

```ts
import { CoderaxClient } from '@coderax/sdk';
import { checkCompatibility } from '@coderax/sdk/compat';

const client = new CoderaxClient({
  baseUrl: 'http://127.0.0.1:8788',
  token: process.env.CODERAX_OWNER_TOKEN!,
});

const report = checkCompatibility({
  handshake: await client.handshake({ contract: '1.1.0' }),
});
if (!report.compatible) throw new Error(report.problems.join('\n'));
```

Every response and every streamed frame is parsed with the contract schemas, so a
deployment that drifts fails at the client boundary with `CoderaxContractError`
instead of producing a subtly wrong UI. A `Problem` response becomes a
`CoderaxApiError` carrying the stable `code`, `status`, `requestId` and
`retryable` flag.

## Chat streaming

```ts
for await (const frame of client.chatStream({ message: 'Hello' })) {
  if (frame.type === 'chat.delta') process.stdout.write(frame.text);
  if (frame.type === 'chat.completed') console.log('\n', frame.reply.messageId);
  if (frame.type === 'chat.failed') throw new Error(`${frame.code}: ${frame.detail}`);
}
```

`client.chat()` performs the same turn and returns the `chat.completed` reply as
one JSON body. Both paths run the same server code; only the transport differs.

## Work streaming and replay

```ts
const accepted = await client.submitWork({ objective: 'Summarize the repo' });
for await (const event of client.events(accepted.taskId, { after: 0 })) {
  if (event.type === 'stream.truncated') {
    throw new Error(`history before seq ${event.payload.oldestSeq} is gone`);
  }
  if (event.type === 'task.completed') break;
}
```

The cursor is a sequence number, not an index: pass the last `seq` you consumed
as `after` to resume exactly where you stopped. A resumed stream starts with
`stream.truncated` when the retained window no longer covers that cursor, so a
gap is reported rather than hidden.
