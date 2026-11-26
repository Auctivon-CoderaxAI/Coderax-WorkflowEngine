# Durable artifacts

Artifacts are the files the owner uploads or the engine generates: documents,
PDFs, spreadsheets, presentations, images, audio, video, source code, project and
game files, visualizations and downloadable execution results. They are durable
for the same reason a Work task is: a conversation that survives a browser
refresh, a CLI reconnect or a device change cannot lose the file it refers to.

The engine previously had only `result.artifacts` metadata on a task and no
content store, so any artifact that lived in process memory disappeared with the
process. This service replaces that with authoritative metadata plus
content-addressed bytes in the database the engine already uses.

## Storage

| What | Where | Why |
| --- | --- | --- |
| Artifact descriptor | `artifact` collection | One authoritative row per artifact |
| Immutable versions | `artifact_versions` collection | History is auditable; a version is never rewritten |
| Content descriptor | `artifact_blobs` collection | Commit marker for one digest and its reference count |
| Content chunks | `artifact_chunks` collection | 1 MiB chunks keep each document under MongoDB's 16 MiB limit |
| Quota capacity | `artifact_capacity` collection | Atomic available bytes and artifacts per owner and mode |
| Admissions | `artifact_reservations` collection | Expiring, recoverable in-flight quota |

- **Durability requires `persistence.driver=mongo`.** With `memory`, the service
  reports `durable: false` and every write is refused with
  `503 storage_unavailable`. It does not accept a write it cannot keep.
- **No new storage vendor and no paid tier.** MongoDB is the engine's existing
  durable dependency; artifacts add collections, not a service. See
  `docs/governance.md` for the $0.00 constraint.
- **This is not an S3-compatible object store.** The bytes live in the
  authoritative database. `BlobStore` (`src/persistence/blobs.ts`) is the seam if
  a zero-cost object store is later verified; it must be proven durable before
  the service will use it.
- **Content addressing.** The storage key is built from owner, data mode and
  SHA-256. Nothing derives a path from a request, and identical content is
  stored once *within a partition*. Deliberately, the same bytes in `private`
  and `cloud` are stored twice: deduplicating across modes would create a
  cross-mode side channel.
- **Counted references.** Each retained version owns exactly one reference on
  its digest. The reference is acquired before the version row is written and
  released after it is removed. Deletion is a conditional delete at count zero,
  so a version that appears while a delete is in flight wins and keeps the
  bytes.

## Data model

An `ArtifactDescriptor` carries `artifactId`, `kind`, `filename`, `mediaType`,
`bytes`, `sha256`, `mode`, current `version`, retained `versions`, optional
`projectId` / `conversationId` / `taskId`, timestamps, optional `expiresAt`, and
`inferenceExposure: "none"`.

`kind` is one of `document`, `pdf`, `spreadsheet`, `presentation`, `image`,
`audio`, `video`, `source`, `project`, `game`, `visualization`, `execution`,
`data`. `project` and `game` require a `projectId`; a project is a namespace of
individual files, not an archive.

### Accepted media types

`text/plain`, `text/markdown`, `text/csv`, `text/tab-separated-values`,
`application/json`, `application/pdf`, Word/Excel/PowerPoint OOXML and the
OpenDocument equivalents, PNG, JPEG, GIF, WebP, MPEG/WAV/OGG/FLAC/MP4 audio,
MP4/WebM/OGG/QuickTime video.

`text/html`, `image/svg+xml`, executable formats and every generic archive type
are not on the list.

## Operations

| Operation | Method and path | Purpose |
| --- | --- | --- |
| `uploadArtifact` | `POST /v1/artifacts` | Store a new artifact from base64 bytes |
| `listArtifacts` | `GET /v1/artifacts` | Owner-scoped list plus quota |
| `getArtifact` | `GET /v1/artifacts/{artifactId}` | Metadata in one mode |
| `uploadArtifactVersion` | `POST /v1/artifacts/{artifactId}/versions` | Append an immutable version |
| `listArtifactVersions` | `GET /v1/artifacts/{artifactId}/versions` | Retained history |
| `downloadArtifact` | `GET /v1/artifacts/{artifactId}/content` | Exact bytes, verified on read |
| `exportArtifact` | `GET /v1/artifacts/{artifactId}/export` | Descriptor, version manifest and bytes |
| `deleteArtifact` | `POST /v1/artifacts/{artifactId}/delete` | Delete every retained version |
| `pruneArtifacts` | `POST /v1/artifacts/prune` | Enforce retention now |

Uploads use base64 inside the one validated JSON surface rather than a second
transport contract. The artifact operations raise the route's body ceiling to
16 MiB; every other operation keeps the 1 MiB default. One version is at most
10 MiB decoded.

`encoding` is always canonical, unpadded-to-padded standard base64. A client may
send `sha256`; a mismatch rejects the upload instead of storing bytes the client
did not expect.

### SDK

```ts
const uploaded = await client.uploadArtifact({
  filename: 'chart.png',
  mediaType: 'image/png',
  contentBase64: png.toString('base64'),
  mode: 'cloud',
  projectId: 'proj_dashboard',
  taskId: accepted.taskId,
});

const bytes = Buffer.from(
  (await client.downloadArtifact(uploaded.artifact.artifactId, { mode: 'cloud' }))
    .contentBase64,
  'base64',
);
```

Every response is parsed with the contract schema. A task's `result.artifacts`
is projected from the artifact service at read time, so a completed execution
result is downloadable without a second metadata copy in the fenced task row.

## Security

- **Owner and mode are part of identity.** An artifact id that exists in the
  other mode is reported as `404 not_found`, not `403`: the response does not
  confirm that it exists. Every repository lookup and every blob key includes
  both fields.
- **Validation before storage.** Canonical base64, a signature sniff that must
  agree with the declared media type (PNG/JPEG/GIF/WebP/PDF/MP3/WAV/OGG/FLAC/
  MP4/WebM/OOXML/ODF), extension/media agreement, UTF-8 without NUL for text,
  real JSON parsing for `application/json`, and an optional client digest.
- **Path traversal has no path to traverse.** Filenames are metadata only. A name
  containing `/`, `\`, a control character, a bidirectional override, a leading
  dot, a trailing dot or space, a reserved device name, or no extension is
  refused. Storage keys are digests.
- **Archives are never expanded.** A generic archive is rejected. Only an
  opaque OOXML/ODF container is accepted, and only when its internal marker
  matches the declared type. A zip bomb is therefore inert: no inflate, no
  entry listing, no filesystem write.
- **Integrity on read.** The byte length and SHA-256 are re-verified; a mismatch
  is an error, never a silently different file. Blob reads also require all
  declared chunks.
- **No implicit inference exposure.** The descriptor's `inferenceExposure` is the
  literal `"none"`, the artifact module has no dependency on an agent, model or
  gateway, and the e2e suite asserts the gateway call count is unchanged by
  uploads, downloads, exports and listings.
- **Audit without content.** `artifact.stored`, `artifact.versioned`,
  `artifact.deleted` and `artifact.pruned` record the mode, kind, byte count and
  a digest prefix. They never record the file name, the bytes or a path.

## Quota, versions, retention, deletion

Defaults (all overridable in `engine.json` under `artifacts`):

| Setting | Default | Bound |
| --- | --- | --- |
| `maxBytesPerArtifact` | 8 MiB | 10 MiB |
| `maxBytesPerOwner` | 256 MiB | 1 GiB |
| `maxArtifactsPerOwner` | 1,000 | 10,000 |
| `maxVersionsPerArtifact` | 20 | 100 |
| `defaultRetentionDays` | 0 (keep) | — |
| `maxRetentionDays` | 365 | 3,650 |
| `chunkBytes` | 1 MiB | 64 KiB–4 MiB |

Admission is **one conditional `$inc`** on the partition's capacity row, not a
usage read followed by a write. The filter requires enough available bytes and
artifacts and the increment spends them in the same server-side operation, so
two replicas racing the last slot cannot both be admitted. A refusal is
`507 quota_exceeded`, and a refusal never leaves a blob or a reservation behind.

Every admission also writes an expiring reservation before the capacity moves.
The sweep resolves an expired reservation against its claimed version: if the
version row exists the reservation is committed (the capacity is real usage); if
not, the capacity is released. A crash can therefore under-admit temporarily,
but it cannot permanently reserve quota or over-admit. A release marks the row
before refunding, so a crash during release loses a refund that startup
`reconcile` repairs rather than issuing the refund twice.

`reconcile` rebuilds availability from committed rows at startup and refuses to
run while another replica's reservation is live. Pruning an old version refunds
its bytes and releases its digest reference; deleting an artifact refunds its
current bytes and its artifact slot.

Retention is artifact-level. `POST /v1/artifacts/prune` enforces it on demand and
`app.start()` runs the same sweep, so an expired artifact does not wait for a
client request. Deletion is immediate and idempotent: the descriptor is removed
first, then the chunks, so a crash leaves inert chunks rather than a read that
promises missing bytes.

## Verified durability

`tests/integration/artifacts-durable.test.ts` does not use the in-memory store or
the driver fake:

1. It opens a real MongoDB server and a real `mongodb` driver connection.
2. One engine process uploads two versions.
3. That process stops and its connection closes.
4. A second engine process opens its own connection to the same deployment,
   reads the descriptor and version one, and gets byte-identical content.
5. It inspects the raw `artifact_blobs`, `artifact_versions` and
   `artifact_chunks` collections, then deletes the artifact and confirms the
   chunk rows are gone.

Run it against a real deployment with:

```bash
CODERAX_TEST_MONGODB_URI="mongodb+srv://…" node --test dist/tests/integration/artifacts-durable.test.js
```

or, with the optional test-only server (never a runtime dependency):

```bash
npm install --no-save mongodb-memory-server
node --test dist/tests/integration/artifacts-durable.test.js
```

When neither is available the test **skips with that reason**. A skip is not
evidence of durability and is reported as a skip, not as a pass. Setting
`CODERAX_REQUIRE_MONGODB=1` turns a missing server into a failure; the required
`verify` workflow sets it and runs against a pinned `mongo:7.0` service
container, so the real-database lane cannot silently disappear. Hosted execution
is evidence only when the `verify` workflow has actually run at the exact head;
a local green run does not imply a hosted run.

At the artifact branch head, `npm run verify` passed **147/147 tests with zero
skips** against a real mongod, and `openapi:check` passed. The durable restart
test and the five concurrency tests are the evidence for the claims above; no
production database has been exercised.

### Concurrency and recovery

`tests/integration/artifacts-concurrency.test.ts` runs two engine processes
against one real deployment and proves:

- an artifact written by one replica is listed and downloaded by the other;
- six concurrent uploads of identical bytes produce one blob row with six
  references, and deleting one leaves the other five readable;
- ten uploads racing a three-artifact byte quota admit exactly three, leave no
  reservation rows, and delete back to the full quota;
- an abandoned admission returns its capacity, while a reservation whose
  version exists is committed rather than refunded;
- a deleted chunk makes download and export fail as corruption, never return
  reconstructed bytes;
- deleting an artifact while a reader holds a temporary reference keeps the
  bytes readable until that reference is released.

Startup maintenance also removes chunk rows whose descriptor never committed
and zero-reference descriptors older than a grace period. A crash between a
chunk write and its descriptor leaves an inert, reclaimable chunk rather than a
read that promises missing bytes.

## Limits that remain

- Downloads are base64 JSON, not ranged or streamed responses. Large video should
  be stored elsewhere and referenced, not pushed through this surface.
- There is no background scheduler; retention runs at startup and on request.
- There is no archive extraction, by design.
- There is no sharing surface: Coderax has exactly one principal.
- Preview and filename search are **not exposed**. Listing filters by kind,
  project, conversation and task; every descriptor carries its digest, and a
  download re-verifies it. No endpoint advertises a capability that does not
  exist.
- The ledger and the metadata write are separate documents, not one transaction.
  A crash between them under-admits until the expiry sweep or startup reconcile;
  it never over-admits.
- Coderax Web and CoderaxCLI live in other repositories. They can use the shared
  SDK's artifact methods, but no client change or cross-client test was made in
  this repository.
- The Native agent returns text; artifacts are stored when a client or a task
  uploads them or associates them with a task. Nothing generates files on its
  own.

## Deliverables from the artifact toolkit

`src/artifacts/toolkit.ts` produces DOCX, PDF, Markdown, XLSX, PPTX, CSV, JSON
and source-tree deliverables. It stages and verifies each file inside the run's
confined workspace, then commits it through the durable service above; a
deliverable succeeds only when every file has an `ArtifactDescriptor`. The
toolkit owns no storage and exposes no second artifact shape.

Software is stored as one flattened artifact per file (`src__index.js`) because
the durable service accepts a bounded filename, not a path.

Generated HTML is staged for verification but stored as `text/plain`: the
durable media list deliberately excludes active content.
