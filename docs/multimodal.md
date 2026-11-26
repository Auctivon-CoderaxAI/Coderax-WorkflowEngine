# Multimodal and creative intelligence

This layer adds image input and generated SVG/HTML handling. It does not add a
provider, a model selector or an execution path: every request still goes through
`src/models` for eligibility and quota, `src/orchestration` for submission and
settlement, and `src/execution` for the lease, fencing and cancellation that
already govern Work.

## Why it is stacked on the router

`feat/zero-cost-model-router` is the authoritative routing implementation: it
discovers providers, proves zero cost from a published price list or an exact
model attestation, classifies capabilities, reserves request and token budget,
enforces provider ceilings and opens circuits. Building image support beside it
would create a second way to choose a provider, which the repository forbids.

This layer therefore consumes the router. It adds one thing the router needs to
express a multimodal request: `requireVision` admission (including for an
explicitly pinned model, which previously skipped the capability check) and
`inputModalities` on the model descriptor so a client can see what discovery
actually established.

## Intake

`POST /v1/media` accepts one image as canonical base64 and returns an owner-scoped
descriptor.

| Check | Behavior |
| --- | --- |
| Transport size | `server.maxBodyBytes`, 8 MiB by default |
| Encoded size | at most 7.2M base64 characters |
| Decoded size | `media.maxBytes`, 4 MiB by default, hard maximum 5 MiB |
| Encoding | standard base64 only; whitespace, URL-safe alphabets and misplaced padding are refused |
| Format | PNG, JPEG, WebP or single-frame GIF, identified by magic bytes |
| Dimensions | read from the file header; `media.maxPixels` (40M by default) is enforced before any decoder sees the file |
| Animated input | animated GIF and animated WebP are refused explicitly |
| SVG, HTML, PDF | refused as media input; SVG and HTML can carry active content |
| Audio, video, documents | reported unavailable, never accepted and ignored |
| Declared type | a hint that must agree with the sniffed type (`image/jpg` normalizes to `image/jpeg`) |

The engine does not decompress the image. It parses the PNG IHDR, the JPEG SOF
segment, the GIF screen/image descriptors and the WebP chunk headers. That avoids
a decompression bomb in this process and bounds the memory a downstream decoder
can be asked to allocate. Format-specific parsers are bounded in segment/chunk/
block count, and a truncated or inconsistent header is `media_invalid`, not a
guess.

Media is stored under `(mediaId, ownerId)` and carries its data mode. A lookup
never omits the owner; an identifier belonging to another principal is reported
as `not_found`. MongoDB is the durable store when `persistence.driver` is
`mongo`; the in-memory driver is process-local, like the rest of that driver.

## Attachments and permissions

`ChatRequest.attachments` and `WorkSubmitRequest.attachments` name at most four
media ids. The service resolves them at submission and again at execution:

- the owner must match;
- the stored mode must equal the request mode;
- the attachment count and uniqueness are checked;
- an external agent (`opencode`, `freebuff`) is refused outright, because its
  isolation contract grants no conversations and no memory, and owner media would
  widen it without a scoped grant.

**Private mode.** `private` is a storage partition, not a claim that inference is
local. A hosted provider still receives the image, so private-mode attachments are
refused by default (`media.allowPrivateModeAttachments: false`). The capability
report exposes `privateModeAttachments` so a client does not have to discover this
from a failure. Enabling the switch is an explicit operator decision that accepts
provider processing; it is not inferred from a model identifier.

## Eligibility, quota and privacy

An image request sets `requireVision` and adds 1,024 estimated input tokens per
image. The router admits only a model whose provider metadata declared image
input, whose cost is proven zero, whose context fits the estimate, whose provider
is healthy and whose circuit is closed. Explicitly naming a text-only model is
refused with `model_missing`; it is never silently replaced by another model, and
a refusal never becomes a paid request.

Listing models or holding a valid API key is not inference readiness. Discovery
that succeeds does not prove the account may run a request, and the router's
pricing/attestation rules are what establish zero cost. If a provider rejects the
request, the run fails with a stable code; there is no paid fallback.

Concurrent requests reserve request and token budget before the provider call and
also share the provider's local concurrency ceiling. The integration test starts
two image requests against a one-request daily budget and asserts exactly one
provider call, one `budget_exhausted` response, and no second endpoint. Those
reservations and ceilings are process-local, as documented by the router; a
multi-replica deployment needs a shared limiter before treating them as global.

Provider privacy terms are the provider's. This layer adds no provider and sends
data only to the endpoint the router already selected. It does not implement local
inference, so it does not claim private-mode images stay on the owner's machine.

`GET /v1/media/capabilities` reports the truth for this deployment: image input is
available only when a verified-free vision model is currently routable. Audio,
video and document input are explicitly unavailable with a reason.

## Creative output

Agents may return fenced `svg` or `html` blocks. At settlement the service
extracts at most four, validates each with an allowlist scan, and stores the
result on `TaskStatus.result.creative` / `ChatReply.creative`:

- a safe artifact carries its content, its digest and `sandbox: 'required'`;
- an unsafe artifact carries its findings and **no content**, so a client cannot
  render it by accident.

`POST /v1/creative/validate` runs the same scan on a draft.

The scan accepts a small element and attribute vocabulary. It refuses scripts,
event-handler attributes, inline styles and `<style>`, external `href`/`src`
references (only same-document `#fragment` references are allowed), embedded
objects (`iframe`, `object`, `embed`), `foreignObject`, doctypes and entities
outside a fixed list, unquoted attributes, unbalanced markup, excessive nesting
and oversized documents. Unknown constructs are refused, not rewritten.

This is a gate, not a sanitizer. A document with a finding is never marked safe,
and a "safe" document is still expected to be rendered in a sandbox without
same-origin privileges. The scanner does not implement the full HTML or SVG content
models, so it is deliberately conservative: common decorative SVG and simple
static HTML pass, while anything that looks like an application does not.

## Contract and client compatibility

`CONTRACT_VERSION` is `1.1.0`. All changes are additive:

- operations: `getMediaCapabilities`, `uploadMedia`, `getMedia`,
  `validateCreative`;
- schemas: `MediaDescriptor`, `MediaUploadRequest`, `MediaUploadResult`,
  `MediaDownload`, `MediaCapabilities`, `CreativeValidation`,
  `CreativeArtifact`, `CreativeFinding`;
- fields: optional `attachments` on chat/work/messages, optional `creative` on
  replies and task results, optional `inputModalities` on a model descriptor;
- failure codes: `media_invalid`, `media_too_large`, `media_unsupported`;
  `media_unsupported` is also an engine failure code.

`@coderax/sdk` exposes `uploadMedia`, `media`, `mediaCapabilities` and
`validateCreative`, and parses every response with the same schemas the server
enforced. A client must read `mediaCapabilities` before offering image input and
must render `creative` content only when `safe` is true, in a sandbox.

## Limitations

- Audio, video and document understanding are not implemented and are reported
  unavailable. There is no OCR, transcription or PDF extraction.
- The creative scanner is not a full parser or sanitizer; it is an allowlist gate.
- Media has no retention policy or per-owner storage quota beyond the per-file
  ceiling; an owner with the token can fill the configured store.
- Budgets, rate limits and circuits are process-local (inherited from the router).
- Provider data-handling terms are external; private-mode attachments default to
  off because inference is hosted.

## Verification

```bash
npm ci && npm run verify
```

`tests/unit/media.test.ts` covers header parsing, pixel ceilings, animated input,
active formats, strict base64 and store authorization. `tests/unit/creative.test.ts`
covers the allowlist and withholding. `tests/integration/media.test.ts` covers the
HTTP-to-router path with a recording provider, text-only refusal, owner/mode
isolation, external-agent denial, concurrent budget enforcement, creative
settlement and MongoDB durability.
