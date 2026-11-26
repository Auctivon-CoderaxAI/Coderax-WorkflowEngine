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
| `contract/authoritative-v1.1` | `ea66028` | Not merged. Conflicts with the router budget and defines a different artifact schema. |
| `feat/durable-artifacts` | `fd5edef` | Not merged. Defines a second, richer artifact schema and a Mongo blob store. |
| `feat/artifact-intelligence` | `c9bac16` | Not merged. Generators depend on the durable-artifacts schema. |
| `ci/permanent-quality-gate` | `21015a7` | Not merged. Its suites assume the pre-merge contract and router. |

The 189-test figure on `feat/multimodal-intelligence-core` covers the whole
Intelligence Core stack, including a second router, MCP, tools and knowledge
retrieval. It is not 189 media tests. Its media-specific work is
`src/media/intake.ts`, `src/media/creative.ts` and the associated contract
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

## What is blocked, and why

### The two v1.1 artifact contracts are incompatible

`contract/authoritative-v1.1` publishes a task-scoped artifact record:

```text
ArtifactRecord { artifactId, taskId, path, mediaType, bytes, digest, createdAt }
```

and stores bytes under `<workspace-root>/.coderax-artifacts`.

`feat/durable-artifacts` publishes a versioned, quota-accounted artifact:

```text
ArtifactDescriptor { artifactId, kind, filename, mediaType, bytes, sha256,
                     mode, version, versions, projectId, conversationId,
                     taskId, expiresAt, inferenceExposure }
```

with content-addressed blobs, reference counting, atomic quota admission,
retention, deletion and a real-Mongo concurrency lane.

Both call themselves `1.1.0`. Merging them requires an owner decision about
which record is canonical and how the other operations map onto it. Publishing
both would be exactly the incompatible duplicate v1.1 contract the task
prohibits.

### The contract branch predates the router budget

`acceptedFor`, `submitWork` and the schedule ticker on
`contract/authoritative-v1.1` use the pre-router budget API
(`reserve(ownerId, at)`, `release(ownerId, at)`, `consume`). The router uses
reservation ids, held token estimates and dispatch-aware settlement. Taking the
contract branch's service or budget would regress quota accounting. A probe
merge produced 10 conflicts across the service, routes, SDK, persistence,
composition and budget; resolving them is a service rewrite, not a merge.

### Media is not yet backed by the artifact authority

Media currently uses the owner- and mode-scoped `media` collection. That is
durable under MongoDB and is tested through the repository port, but it is a
second blob path alongside the artifact store. It must be folded into whichever
artifact service the owner selects before the storage sections of the task can
be claimed complete.

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
| Persistent media references | Implemented, tested through the store port | Mongo and in-memory repositories; real `mongod` is not installed in this environment, so distributed durability is not claimed. |
| Durable artifact versions / quota / refcount | Not integrated | Depends on the artifact-contract decision above. |

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

- Local: `npm run verify` — 209 tests, 209 pass, OpenAPI drift clean.
- Hosted: exact-HEAD GitHub Actions on this branch. Historical evidence:
  run `45877952215` at `c0cfa99`; run `45877479332` at `a22c496`. The run for the
  current head is linked from the pull request.
- No live provider inference, pricing check, eligibility check or privacy-terms
  fetch was performed: no provider credential exists in this environment. The
  router's discovery and policy fixtures are not a substitute for that evidence.

## Decisions requested from the owners

1. **Artifact contract:** adopt the authoritative task-scoped record or the
   durable versioned descriptor as canonical v1.1, and state how the other
   branch maps onto it.
2. **Media home:** keep `/v1/media` as a thin media view over the artifact
   service, or express media as artifact kinds with media metadata. This decides
   whether a version bump is required.
3. **Merge order:** router (#4) → authoritative contract (#7) → durable artifacts
   → artifact intelligence → this media layer. Retarget to `main` after #4, then
   remove the stack-scoped CI triggers.

Until those decisions are recorded, `feat/multimodal-intelligence-core` should
not be closed: its APNG and truncation checks are incorporated here, but its
owner may still want the remaining stack. `feat/durable-artifacts` and
`feat/artifact-intelligence` should not be closed either; they own functionality
this branch does not duplicate.
