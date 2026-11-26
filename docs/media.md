# Media intake

`POST /v1/media` is the canonical validation operation for image attachments. It
is owner-only, declared in `packages/contracts/src/routes.ts`, validated against
`MediaIntakeRequest`, returned as `MediaIntakeResult`, and exposed in the SDK as
`client.intakeMedia()`.

The request carries one to four images as canonical base64 (no `data:` prefix)
and a declared `image/png`, `image/jpeg` or `image/webp` type. The operation
validates each item from its own bytes, then returns immutable `MediaReference`
metadata only — the bytes are never echoed back.

| Limit | Value |
| --- | --- |
| Attachments per request | 4 |
| Bytes per image | 2 MiB |
| Total decoded bytes | 4 MiB |
| Longest side | 8192 px |
| Total pixels | 16,777,216 |
| JSON body ceiling | 6 MiB |

Refused: SVG, HTML, GIF/APNG animation, archives, spoofed or mismatched types,
non-canonical base64, missing image headers, header-only payloads, truncated
containers, oversized dimensions and pixel bombs. A refusal is a typed
`validation_failed` Problem; an oversized body is a `payload_too_large` 413 with
a `requestId`.

Validation is not sanitization. It refuses active or malformed content rather
than rewriting it, and it does not claim to sandbox a renderer.

## Chat turns

`submitChat` accepts the same `attachments` array. The engine validates the whole
set before it resolves a model or writes a turn, then requires a route whose model
declares image input; if none does, the turn fails instead of dropping the image.
The user message in the transcript stores `MediaReference` metadata only, and the
bytes travel inline to the selected provider as a content part on the first model
call. An external agent is refused image input rather than sent a stripped prompt.
