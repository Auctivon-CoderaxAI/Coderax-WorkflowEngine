# @coderax/sdk

The one typed client for Coderax and CoderaxCLI. Every response is parsed with
the same schema the engine validated against, so a deployment that drifts from
the contract fails at the client boundary with a named error.

**Version 1.3.0** — contract `1.3.0`, chat frames v1, execution events v1.

## Handshake first

```ts
import { CoderaxClient, checkCompatibility, SDK_VERSION } from '@coderax/sdk';

const api = new CoderaxClient({ baseUrl, token });
const handshake = await api.handshake({ contract: SDK_VERSION });
const report = checkCompatibility({ handshake, requiredOperations: ['submitChat'] });
if (!report.compatible) throw new Error(report.problems.join('; '));
```

`handshake.operations` is built from the server's registered route table, not a
wish list. A version string alone is not trusted: the contract fingerprint pins
the operation-id/method/path catalogue, and a same-number collision is refused
as `fingerprint_mismatch`. `./version` exports the SDK and contract versions;
`./compat` exports `checkCompatibility`.

## Media and attachments

```ts
const { media } = await api.intakeMedia({
  attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: png }],
});

const reply = await api.chat({
  message: 'What is in this image?',
  agent: 'coderax',
  mode: 'cloud',
  attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: png }],
});
```

Intake validates signature, MIME and dimensions from the bytes and returns
metadata only. A chat turn revalidates the attachment set before any model call,
requires a vision-capable route, and stores `MediaReference` metadata on the user
message — never the encoded bytes. An external agent refuses image input rather
than dropping it.

## Coverage

`SDK_OPERATION_COVERAGE` maps every published operation to its client method;
`tests/contract/sdk-coverage.test.ts` fails if the route catalogue and the SDK
disagree in either direction.
