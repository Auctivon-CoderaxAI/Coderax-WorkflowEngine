# Multimodal consolidation and reconciliation

This branch is the consolidated multimodal implementation. It is based on the
authoritative zero-cost router, not on a second router. This document records
what was adopted, what was deliberately not merged, and the evidence required
before the remaining branches can be closed or retargeted.

## Branch inventory

| Branch | Head | Disposition |
| --- | --- | --- |
| `main` | `808dfd3` | Base. No multimodal implementation. |
| `feat/multimodal-creative-intelligence` | this branch | Consolidated media, creative and router integration. |
| `feat/multimodal-intelligence-core` | `5dd5e66` | The other multimodal implementation. Its APNG and truncation checks were adopted; its router is not adopted. |
| `feat/zero-cost-model-router` (PR #4) | `b6e002b` | Merged into this branch. It remains the only model router. |
| `contract/authoritative-v1.1` | `ea66028` | Merged. Its catalogue, SDK and handshake are canonical v1.1 on this branch. |
| `feat/durable-artifacts` | `fd0a4c1` | Merged through `fd5edef`: the versioned artifact descriptor, content-addressed blobs, reference counting, atomic quota admission and the real-Mongo lane. Its five later commits add leases, project trees/manifests and generators; those are not merged. |
| `feat/artifact-intelligence` | `c9bac16` | Not merged. Generators depend on the durable-artifacts schema. |
| `ci/permanent-quality-gate` | `21015a7` | Not merged. Its suites assume the pre-merge contract and router. |

The 189-test figure on `feat/multimodal-intelligence-core` was independently
reproduced in an isolated worktree at `5dd5e66`: `189 tests, 189 pass, 0 fail`.
That count covers the whole Intelligence Core stack, including a second router,
MCP, tools and knowledge retrieval; it is not 189 media tests. Its media-specific
work is `src/media/intake.ts`, `src/media/creative.ts` and the associated contract
schemas.

## What this branch adopted

### Authoritative router `b6e002b`

The merge preserves the router's operation-specific processing policy. Image
requests now resolve with `operation: 'multimodal'`; a `chat` or `work` grant is
not sufficient. Private media is refused unless the provider record has:

- an explicit private `multimodal` grant;
- a non-global processing location matching the grant;
- no stored retention (`none` or `transient`);
- training prohibited;
- an owner-managed credential.

`media.allowPrivateModeAttachments` remains `false` by default. Enabling it does
not bypass the provider policy; it only permits the request to reach it.

The router's reservation IDs, quota accounting, circuit breakers, fallback
bounds, attestation expiry and vision checks are retained. No local fallback
exists.

### Unique work from the other multimodal branch

- Animated PNG (`acTL`) is refused as a still image.
- PNG validation walks the chunk stream and requires image data and `IEND`, so a
  file truncated after `IHDR` is not accepted.
- JPEG validation requires an end-of-image marker after the frame header, so a
  truncated file is not treated as complete.

The other branch stores no durable media and publishes no upload/get operations.
Its deterministic media id, in-memory base64 carriage and Markdown creative
format were not adopted: media ids are owner-scoped in the durable store here,
and Markdown is plain text rather than an HTML/SVG rendering boundary.

## Consolidation decisions, and what remains

### One v1.1 artifact contract is canonical

The durable versioned descriptor from `feat/durable-artifacts` is the artifact
record:

```text
ArtifactDescriptor { artifactId, kind, filename, mediaType, bytes, sha256,
                     mode, version, versions, projectId, conversationId,
                     taskId, createdAt, updatedAt, expiresAt, inferenceExposure }
```

It is published once, at v1.1.0, with content-addressed blobs, reference
counting, atomic quota admission, retention and deletion. The task-scoped
`ArtifactRecord` from `contract/authoritative-v1.1` is not adopted: the
authoritative contract's catalogue, SDK and handshake are canonical, and its
artifact operations map onto the descriptor above. There is no second artifact
schema and no v1.2.

`feat/durable-artifacts` has since advanced from `fd5edef` to `fd0a4c1` with
expiring read leases, project trees and manifests, restore, and the generation
API, adding `docx`, `exceljs`, `pdf-lib` and `pptxgenjs`. Its artifact changes
are additive over this branch's contract, so the branches are compatible, but
generation is `feat/artifact-intelligence` work and is not merged here.

### The router budget is preserved

The contract branch predated the router's reservation-id budget API. The merge
kept the router's reservation ids, held estimates and dispatch-aware settlement
and mapped the authoritative contract's operations onto them. Quota accounting
is unchanged.

### Media is a view over the artifact authority

`/v1/media` owns no storage. `POST /v1/media` performs the media-specific
validation (magic bytes, canonical base64, pixel and attachment bounds, mode and
owner scoping) and then writes an immutable artifact version through
`ArtifactService`; the media id is the artifact id. Reads go back through the
artifact service, so the artifact descriptor is the only record of the bytes,
their retention and their quota.

`tests/integration/media-authority.test.ts` proves this on a real MongoDB: the
artifact descriptor and version list match the media, a version written through
`/v1/artifacts` is what `/v1/media` serves, a non-image artifact is not exposed
as media, deletion through the artifact API removes the media and its blobs, a
second engine reads the media from the server, and a media upload is refused
with `quota_exceeded` when the single artifact slot is already used.

## Capability matrix

States are exact. "Tested" means covered by this repository's suites; it does
not mean hosted inference was exercised.

| Capability | State | Evidence / limitation |
| --- | --- | --- |
| Image intake (PNG, JPEG, WebP, still GIF) | Implemented, tested | Header sniffing, canonical base64, byte/pixel/attachment bounds, mode and owner isolation. |
| Image understanding through a vision model | Implemented path, hosted inference unverified | Requests set `requireVision` and `multimodal`; fixtures prove routing and content-part forwarding. No provider credential was available for a real inference call. |
| Image generation | Unavailable | No verified zero-cost image-generation model. No route, no fabricated media. |
| Image editing | Unavailable | Depends on generation and a verified provider. |
| Optical character recognition | Unavailable | No local decoder or verified zero-cost OCR provider. |
| Audio transcription / understanding | Unavailable | Adapter path accepts images only; audio is not accepted or advertised. |
| Speech generation | Unavailable | No provider or route. |
| Video understanding | Unavailable | No decoder, provider or route. |
| Document understanding (PDF/DOCX/XLSX/PPTX) | Unavailable on this branch | `feat/artifact-intelligence` owns generators; no parser or inference path is integrated here. |
| Multimodal conversation | Implemented for cloud and explicit private | Chat and Work carry attachments; external agents are refused. |
| Creative SVG/HTML validation | Implemented, tested | Allowlist scan; unsafe bodies withheld; safe bodies still require `sandbox: 'required'`. Not a sanitizer. |
| Persistent media references | Implemented, tested on a real server | Media is stored as an artifact version; `media-authority` covers the real-Mongo path and the `mongodb` CI job requires a real server. |
| Durable artifact versions / quota / refcount | Integrated, tested on a real server | Versioned descriptor, reference counting and atomic quota admission from `feat/durable-artifacts`; real-Mongo durability, concurrency and media-quota tests run in the `mongodb` job. |

## Security evidence

- Structural image validation only. Nothing is decompressed; a valid header does
  not prove the pixels decode.
- PNG requires a bounded chunk stream, image data and `IEND`; APNG is refused.
- JPEG requires a bounded segment stream, a frame size and an end-of-image
  marker.
- GIF animation and animated WebP are refused.
- SVG, HTML, PDF and archives are never accepted as image input.
- Declared media type must match the sniffed type.
- Canonical base64 is re-encoded and compared; non-canonical tails are refused.
- Creative output is an allowlist scan: scripts, event handlers, styles, forms,
  entities, doctypes, embedded objects, external references and unknown
  elements produce findings. Unsafe content is not returned.
- Provider authorization is per operation, mode, location, retention, training
  and credential source.
- Credential redaction is applied before creative extraction and settlement.
- Residual risks: pixels and image metadata can contain instructions a model may
  follow; metadata is not parsed or stripped here, and the scanner is not a
  sanitizer. Clients must render creative output only in an isolated document or
  sandbox with no same-origin privileges.

## Verification

- Local: `npm run verify` with `CODERAX_REQUIRE_MONGODB=1` against a real
  MongoDB 8.0 — 273 tests, 273 pass, 0 skipped, OpenAPI drift clean.
- Hosted: the `verify` workflow, whose `mongodb` job runs the whole suite
  against a pinned `mongo:8.0` service with `CODERAX_REQUIRE_MONGODB=1`, so the
  real-database tests fail rather than skip there.
- No live provider inference, pricing check, eligibility check or privacy-terms
  fetch was performed: no provider credential exists in this environment. The
  router's discovery and policy fixtures are not a substitute for that evidence.
- Dependency audit: `npm audit --omit=dev --audit-level=high` reports one high
  advisory in `zod` 3.25.76 (GHSA-mrhx-c7xc-m3w5). The published fix is zod 4.6.7,
  a major upgrade from the pinned `^3.25.67`; it was not applied silently. Request
  bodies are bounded by `server.maxBodyBytes`, and collection schemas carry
  explicit maxima, but the advisory remains until the contract packages move to
  zod 4.
- Real MongoDB: the durability, concurrency and media-authority suites ran
  against a real MongoDB 8.0 server, and the `mongodb` CI job repeats that on
  every push. Replica-set behavior and failover are still not claimed: the server
  is a single node.

## Decisions recorded

1. **Artifact contract:** the durable versioned descriptor is canonical v1.1; the
   task-scoped record is not published. Recorded above.
2. **Media home:** `/v1/media` stays a thin, owner- and mode-scoped view over the
   artifact service, and media is expressed as the `image` artifact kind with
   media metadata. No version bump was required.
3. **Merge order:** router (#4) → authoritative contract (#7) → durable artifacts
   → artifact intelligence → this media layer. Retarget to `main` after #4, then
   remove the stack-scoped CI triggers.

`feat/multimodal-intelligence-core` should not be closed: its APNG and
truncation checks are incorporated here, but its owner may still want the
remaining stack. `feat/durable-artifacts` and `feat/artifact-intelligence` should
not be closed either; they own generators and generation this branch does not
duplicate.
