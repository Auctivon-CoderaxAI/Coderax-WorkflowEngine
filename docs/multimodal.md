# Multimodal input and creative intelligence

This branch adds two capabilities without adding a second model router, artifact
authority, capability registry or execution engine:

1. **Validated image input** for Coderax Native: a still PNG, JPEG or WebP image
   may accompany one Chat turn or one durable Work task.
2. **Validated creative artifacts**: a Work task may ask for one Markdown, HTML
   fragment or SVG document, which the engine checks before returning it.

Raster image generation is **not implemented**. It is reported as unavailable
and there is no paid fallback. A model identifier, an account tier or a
model-listing response is never treated as proof that inference is free.

## The one request path

```text
HTTP body bound (6 MiB)
  -> declarations validated by packages/contracts
  -> src/media/intake.ts: bytes, magic, dimensions, animation, count, total
  -> src/models/router.ts: verified terms, observed inference, vision capability,
                           quota and per-model concurrency reservation
  -> src/models/budget.ts + persistence: durable owner request/token ceiling
  -> src/orchestration/service.ts: durable task (media bytes + metadata)
  -> src/execution/runner.ts: lease, heartbeat, cancellation, settlement
  -> src/agents/native: image content parts through the routed gateway
  -> src/media/creative.ts: deliverable validation at settlement
```

`src/models/router.ts` remains the only selection path and
`src/models/eligibility.ts` remains the only zero-cost decision point. This
branch extends their records; it does not fork them. The existing tool runtime,
permission store, task repository and execution runner are unchanged. A
creative artifact is returned in the task result; producing it does not write a
file and therefore does not need a `workspace.write` grant. A tool that does
write still asks the owner for approval against the exact resource.

## Evidence, not identifiers

`models.evidence` records evidence for one exact model. Four observations are
kept distinct:

| Field | Proves | Does not prove |
| --- | --- | --- |
| `terms` | The published price list was zero at observation time and is still current | That the model answers, or that an account is eligible |
| `inferenceSource` + `inferenceObservedAt` | A successful inference was observed recently (at most 30 days old) | That the provider will remain free or available |
| `privacySource` + `promptTraining` | The published privacy term that was recorded | That the provider enforces it |
| `requestsPer*`, `tokensPerDay`, `concurrentRequests` | The local ceiling reserved before dispatch | That the provider's live quota matches the record |

```json
{
  "providerId": "your-provider",
  "modelId": "your-model",
  "toolCalling": true,
  "multimodal": true,
  "contextTokens": 32768,
  "requestsPerMinute": 20,
  "requestsPerDay": 50,
  "tokensPerDay": 200000,
  "maxInputTokens": 32768,
  "concurrentRequests": 1,
  "terms": {
    "source": "https://provider.example/pricing",
    "observedAt": "2026-11-26T00:00:00.000Z",
    "expiresAt": "2026-12-26T00:00:00.000Z",
    "currency": "USD",
    "inputPerMillionTokens": 0,
    "outputPerMillionTokens": 0,
    "requestPerCall": 0
  },
  "privacySource": "https://provider.example/privacy",
  "promptTraining": "prohibited",
  "inferenceSource": "https://provider.example/console/usage",
  "inferenceObservedAt": "2026-11-26T00:10:00.000Z"
}
```

The router enforces all of the following on every selection:

- **Cost evidence is present and unexpired.** A route entry with no `terms` is
  reported as `paid` and is refused. An expired observation stops routing
  immediately, not at the next restart.
- **Inference was observed.** A model-listing call proves that a key
  authenticated. It does not prove that inference is authorized, available or
  free. `inferenceObservedAt` is a separate, owner-recorded observation and is
  rejected if it is missing, future-dated or older than 30 days.
- **The declared capability fits the request.** An image request is routed only
  to a model whose evidence declares `multimodal: true`. If no such model is
  eligible, the request fails with `model_missing` before any provider call.
- **The local quota can cover the reservation.** The request and estimated
  tokens (including a conservative per-image amount) are reserved before
  dispatch. A failed call releases the token reservation.
- **The concurrency ceiling has a slot.** `concurrentRequests` is checked and
  incremented in the same synchronous reservation. A second request cannot pass
  the check while the first is still in flight; settlement decrements it.

The provider's own 429/`RESOURCE_EXHAUSTED` response is never retried on a paid
model. It records the failure and retry window, releases the reservation, and
may try the next **verified-free** model; otherwise it fails closed.

### Limitations of the evidence

- Attestations are operator records. The engine cannot independently verify a
  provider's price, account eligibility or privacy term; it can only refuse
  when the record is missing, expired or unready and report what was recorded.
- Quota and concurrency counters are process-local. A multi-replica deployment
  needs a shared limiter before the counters are global; until then, replicas can
  each spend their own local allowance. This is a known limitation, not a hidden
  claim.
- No live provider inference or live MongoDB is exercised by the repository test
  suite. The tests use synthetic `provider.example` evidence and a scripted
  gateway.

## Media intake

`src/media/intake.ts` validates the entire attachment set atomically. One bad
item refuses the request; nothing is silently dropped.

| Control | Value |
| --- | --- |
| Formats | `image/png`, `image/jpeg`, `image/webp` (still images) |
| Count | at most 4 per request |
| Per image | 2 MiB decoded |
| Total | 4 MiB decoded |
| Dimensions | at most 8192 px per side and 16,777,216 pixels total |
| Transport | canonical base64, no `data:` prefix, no URL fetch |
| Animation | APNG and animated WebP refused |
| Disk | never written before validation |

The format is identified from the file's own signature and header, never from
the declared MIME type or file name. PNG dimensions come from IHDR, JPEG from a
frame header, and WebP from VP8/VP8L/VP8X. The declared type must match. SVG,
GIF, ZIP and gzip bytes are refused. The display name is sanitized and is never
used as a filesystem path.

Capping compressed bytes and header dimensions bounds the decompression a
provider can be asked to perform. The engine does not decode pixels itself; the
provider does, so the pixel bound is the protection against a decompression
bomb. The 6 MiB HTTP body bound is deliberately finite and only just above the
4 MiB decoded media allowance.

Work task media is stored with the task record so a resume on another replica
has the exact bytes. Chat stores attachment metadata in the transcript but not
the bytes: a later turn does not silently reuse an earlier image.

## Creative artifacts

A Work request may carry:

```json
{ "creative": { "format": "svg", "title": "Launch poster" } }
```

Coderax Native receives an engine-owned instruction to return one fenced block.
At settlement, `src/media/creative.ts` extracts and validates it. The artifact is
returned in `TaskStatus.result.artifacts` with a path under `artifacts/`, a
SHA-256 digest, its media type, and bounded `content`. It is not written to the
workspace.

Validation is fail-closed, not heuristic cleaning:

- **SVG**: must be a closed `<svg>` document. Scripts, `foreignObject`, embedded
  styles, event handlers, `data:`/`javascript:` URLs, CSS `url()`, entities,
  doctypes, comments and external `href`/`src` values are refused. Only local
  `#fragment` references are accepted.
- **HTML**: must be an inert fragment. Scripts, styles, frames, objects, forms,
  form controls, meta refresh, external `src`/`poster`/`background`/`srcset`,
  event handlers, `javascript:` and `vbscript:` URLs are refused.
- **Markdown**: executable HTML, `<img>` and external image loads are refused.
- Oversized content (262,144 characters or bytes) is refused.

A model that answers outside the requested format causes the task to fail with
`protocol_error`; prose is never presented as the requested artifact. A fenced
SVG inside a JSON `final` field is parsed correctly because the action parser
tries the JSON object before interpreting its inner fence.

A client must still render returned HTML or SVG in a scriptless sandbox. The
validator is the engine's boundary, not a substitute for the renderer's own
isolation.

## Unavailable capabilities

`GET /v1/models` includes an additive `media` report:

```json
{
  "imageInput": { "available": true, "models": ["..."] },
  "imageGeneration": {
    "available": false,
    "detail": "No verified zero-cost image-generation model is configured; Coderax does not fall back to a paid image provider."
  },
  "creativeText": { "available": true, "formats": ["markdown", "html", "svg"] }
}
```

`imageGeneration.available` is a literal `false` in the contract. External agents
advertise `imageInput: false` and an attachment addressed to one is refused with
`validation_failed`, never delivered without its media.

## Verification on this branch

- `npm run verify`: build, the full unit/contract/integration/security/e2e
  suite, and the OpenAPI drift gate. The branch passes 189/189 tests locally.
- New coverage: `tests/unit/media.test.ts`, `tests/unit/creative.test.ts`,
  `tests/unit/evidence.test.ts`, `tests/integration/multimodal.test.ts`, and
  `tests/contract/compat.test.ts`.
- The compatibility test proves a 1.0 Chat/Work request and a pre-media
  `ModelList`/`TaskStatus` response still parse; all media fields are optional.
- Not verified here: live provider inference, live provider quota responses,
  live MongoDB and hosted CI. See `docs/evidence-free-tier.md` for the provider
  facts that were checked and the ones that could not be.
