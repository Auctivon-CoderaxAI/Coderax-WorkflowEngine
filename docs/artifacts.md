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
| Content descriptor | `artifact_blobs` collection | Commit marker, reference count and expiring read leases for one digest |
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
- **Reads use expiring leases, not permanent references.** A download or export
  takes a lease in one atomic update (`leaseCount` plus a `readLeases` entry),
  releases it in `finally`, and a process that dies leaves only a lease that
  expires. Expired leases are pruned by the conditional delete and by
  maintenance, so a crashed reader cannot pin a blob forever.
- **Leaked references are recoverable.** A reference with no version row and no
  reference change for a grace period is reclaimed by `reclaimLeaked`. That is
  the recovery path for a crash between metadata removal and reference release;
  an upload in flight updates its reference timestamp, so it is never mistaken
  for a leak.

## Data model

An `ArtifactDescriptor` carries `artifactId`, `kind`, `filename`, optional
`relativePath`, `mediaType`, `bytes`, `sha256`, `mode`, current `version`,
retained `versions`, optional `projectId` / `conversationId` / `taskId`,
timestamps, optional `expiresAt`, and `inferenceExposure: "none"`.

`kind` is one of `document`, `pdf`, `spreadsheet`, `presentation`, `image`,
`audio`, `video`, `source`, `software`, `project`, `game`, `visualization`,
`execution`, `data`, `dataset`, `other`. `project` and `game` require a
`projectId`; a project is a namespace of individual files, not an archive.
`software` is a source-tree file, `dataset` is tabular or JSON data, and `other`
is the escape hatch for an accepted media type with no closer kind. It never
widens the media allowlist.

`relativePath` is optional metadata for a file inside a multi-file project. It
is validated as a relative path: no absolute path, drive prefix, backslash, dot
segment, empty segment, control or bidirectional character, reserved device
name, leading or trailing dot/space, or more than 64 segments. Its final segment
must equal `filename`. It is never opened; storage keys remain digests. Combined
with `projectId`, it lets a generated source tree be listed and reconstructed by
artifact ID without giving the server a workspace path. A case-folded `pathKey`
is stored with the artifact so `README.md` and `readme.md` collide; the unique
project-path index arbitrates concurrent writes. A path that is both a file and
a directory is rejected.

`ArtifactProjectManifest` pins every file to an immutable artifact version and
carries a digest over the canonical entry list. Restoration (`restoreArtifactVersion`)
moves the artifact's current pointer to an older version without deleting newer
versions or moving bytes.

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
| `artifactProjectManifest` | `GET /v1/artifacts/manifest` | Version-pinned project manifest with a digest |
| `generateDeliverable` | `POST /v1/deliverables` | Generate, verify and persist a document, workbook, deck, dataset or software project |
| `uploadArtifactVersion` | `POST /v1/artifacts/{artifactId}/versions` | Append an immutable version |
| `restoreArtifactVersion` | `POST /v1/artifacts/{artifactId}/restore` | Point at an older version without deleting newer ones |
| `listArtifactVersions` | `GET /v1/artifacts/{artifactId}/versions` | Retained history |
| `downloadArtifact` | `GET /v1/artifacts/{artifactId}/content` | Exact bytes, verified on read |
| `exportArtifact` | `GET /v1/artifacts/{artifactId}/export` | Descriptor, version manifest and bytes |
| `deleteArtifact` | `POST /v1/artifacts/{artifactId}/delete` | Delete every retained version |
| `pruneArtifacts` | `POST /v1/artifacts/prune` | Enforce retention now |

Uploads use base64 inside the one validated JSON surface rather than a second
transport contract. The upload and generation operations raise the route's body
ceiling to 16 MiB; every other operation keeps the 1 MiB default. One version is
at most 10 MiB decoded.

`generateDeliverable` accepts document, spreadsheet, presentation, dataset and
software requests. It reads the data mode from the deliverable rather than a
second envelope field, renders into an isolated staging directory, verifies every
file by reading it back, and only then stores the bytes through the artifact
service. Each produced file is returned as an `ArtifactDescriptor`; a software
project also returns the store-derived manifest and the verification report that
records `executed: false`, so the result itself says the program was parsed and
never run.

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

Generation renders a real deliverable and persists it through the same adapter, so
the response names stored artifacts rather than workspace paths:

```ts
const generated = await client.deliver({
  kind: 'document',
  mode: 'cloud',
  filename: 'quarterly-report',
  title: 'Quarterly report',
  blocks: [{ type: 'paragraph', text: 'Revenue grew in every region.' }],
  formats: ['docx', 'pdf', 'markdown'],
});

// generated.artifacts: one stored descriptor per produced file.
// generated.source: the .document.json artifact a later edit revises by id.
// generated.verification.checks: the verification the producer actually ran.
```

A client that already has bytes uploads each file with its `relativePath` and
the same `projectId`, then lists by project to reconstruct the manifest:

```ts
await client.uploadArtifact({
  filename: 'index.ts',
  relativePath: 'src/index.ts',
  mediaType: 'text/plain',
  kind: 'software',
  contentBase64: source.toString('base64'),
  mode: 'cloud',
  projectId: 'proj_generated',
});

const manifest = await client.artifacts({
  mode: 'cloud',
  projectId: 'proj_generated',
});
// manifest.artifacts: [{ relativePath: 'src/index.ts', sha256, artifactId, … }]
```

Edits address the `artifactId`, never a workspace path. A new version is an
immutable compare-and-set; two replicas cannot silently overwrite each other.

```ts
const manifest = await client.artifactManifest('proj_generated', 'cloud');
const restored = await client.restoreArtifactVersion(artifactId, {
  mode: 'cloud',
  version: 1,
  expectedVersion: 2,
});
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
  refused. `relativePath` is validated separately: it must stay relative, use
  forward slashes, contain no dot or empty segment, and end in exactly the
  descriptor's `filename`, and its case-folded identity must not collide with
  another file or with a directory prefix. Storage keys are digests.
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
Only a **definitive** store rejection releases the blob reference and the
admission before the error is returned. An ordinary thrown driver error is
ambiguous: the write may have committed, so the reference and reservation are
left in place. The reservation expires and the sweep checks whether its version
row exists; a reference with no version row is reclaimed after the grace period.
The e2e suite proves both the definitive cleanup and the ambiguous preservation.

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

At the artifact branch head, `npm run verify` passed **168/168 tests with zero
skips** against a real mongod, and `openapi:check` passed. The durable restart
test, the eleven real-Mongo concurrency/recovery tests, the generator integration
test, the HTTP/SDK generation contract test and the failure-injection tests are
the evidence for the claims above; no production database has been exercised.

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
- deleting an artifact while two readers hold read leases keeps the bytes
  readable and blocks the delete until both leases are released;
- a reader that takes a lease and then never returns does not pin the blob:
  once the lease expires, the conditional delete succeeds;
- an upload racing the last delete of the same digest still finds or re-puts
  the bytes, so the surviving artifact is readable;
- two replicas starting together reconcile the same committed usage, and both
  read the artifact afterwards;
- concurrent version creation across two replicas never loses or renumbers a
  committed version, and the capacity ledger equals the retained version bytes;
- restoring an older version moves the pointer without deleting the newer
  versions, and every version remains downloadable;
- a definitive metadata rejection releases its blob reference and admission,
  while an ambiguous driver error preserves both for recovery (the e2e suite
  proves both paths);
- maintenance reclaims a reference leaked by a crash after metadata removal,
  and an acquire racing the reclaim changes the exact reference count so the
  conditional delete loses;
- two replicas cannot create the same case-folded project path.

Startup maintenance also removes chunk rows whose descriptor never committed
and zero-reference descriptors older than a grace period. A crash between a
chunk write and its descriptor leaves an inert, reclaimable chunk rather than a
read that promises missing bytes.

## Artifact intelligence integration

`feat/artifact-intelligence` generates documents, workbooks, decks, PDFs and
source trees into a workspace folder. The stable contract for that generator is:

1. Persist every generated file through `POST /v1/artifacts` with `projectId`
   and `relativePath` (for example `src/index.ts`, `package.json`). Do not copy
   the workspace path into a descriptor.
2. Use `kind: "software"` for source files, `"dataset"` for CSV/JSON data, and
   `"other"` only for an accepted media type that has no closer kind. The media
   allowlist is unchanged: HTML, SVG and archives are still refused.
3. List by `projectId` to reconstruct the manifest. `relativePath` plus
   `sha256` is the file identity; the artifact ID is the edit handle.
4. Edit by uploading a new version to the existing artifact ID. Versions are
   immutable and compared-and-set, so two replicas cannot overwrite each other;
   a conflict is retried or reported, never merged silently.
5. A task result projects `relativePath ?? filename`, so a completed generation
   reports the tree it produced without a second metadata copy.

The repository ships the complete persistence adapter in `src/artifacts/tree.ts`
(`createArtifactTreeWriter`), the staging producer in `src/artifacts/toolkit.ts`
(`createArtifactToolkit`) and the delivery use case in `src/artifacts/deliver.ts`
(`createDeliverableService`). The toolkit renders DOCX, PDF, XLSX, PPTX, dataset
exports and software trees in isolated staging and verifies them; the use case
persists the verified batch through `src/artifacts/persist.ts`. The adapter
validates the whole batch, rejects duplicate, case-folded and file-directory path
conflicts, maps an existing path to `uploadArtifactVersion` rather than a second
file, uploads new files with project/conversation/task associations, and returns
the version-pinned manifest. A document revision is addressed by artifact id and
`expectedVersion`, so a concurrent edit is refused instead of overwritten.

`tests/e2e/deliverables.test.ts` runs the use case against a real MongoDB: it
generates the artifact forms, downloads their bytes, edits a document by a second
immutable version, races two edits to prove the conflict, restores version one,
compares the restored content byte-for-byte with the original, and asserts that a
software deliverable still reports that its program was never executed.
`tests/unit/deliverables.test.ts` covers the producer and tree rules without a
database.

The producer's staged file list is a generation-time shape. It maps to the
store's descriptor at the persistence boundary; it must not become a second
store, a second descriptor or a second quota ledger. `createArtifactToolkit` is
the internal seam, and `POST /v1/deliverables` with the SDK's `deliver` is its
canonical client surface. Document `base` paths and HTML output remain
unsupported because a workspace path is not an artifact identity and HTML is not
an accepted durable media type; a revision names an artifact id and an expected
version instead.

## Canonical API status

PR #7 at `9b4cb5c` is titled **1.1.0** and exposes three task-scoped operations
(`listArtifacts`, `createArtifact`, `getArtifact`) under
`/v1/work/{taskId}/artifacts`. It does not contain the 1.2.0 global catalogue
described in the integration request. This branch therefore keeps its global
artifact surface and adds the missing global `restoreArtifactVersion` and
`artifactProjectManifest`; it does not invent a competing 1.2.0 catalogue.
Reconciling PR #7's task-scoped compatibility projections with these global IDs
requires the API owner's merge, not a second contract.

## Production storage status

Production readiness remains **blocked**: no authorized production MongoDB URI,
plan, backup policy or spending boundary is available in this workspace. The real
mongod used by the tests is an ephemeral test server; it proves engine behavior,
not production hosting. No paid database or storage service was provisioned, and
Oracle Always Free / DeploymentPlatformAI eligibility has not been independently
verified.

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
- Read leases renew at one third of their TTL. A healthy slow download keeps its
  protection; if renewal fails and a delete wins, the download fails closed,
  never with partial bytes. A crashed process leaves a lease that expires and is
  reclaimed.
- A multi-file tree write is not one MongoDB transaction on a standalone
  deployment. New artifacts from a failed batch are removed; already-written
  versions remain. The manifest is coherent but may represent a partial edit.
  All-or-nothing tree edits require a transactional replica-set deployment.
- A crash between metadata removal and reference release leaves a blob and its
  quota until `reclaimLeaked` runs after a one-day grace. It is recovered, not
  corrupted, but it is not immediate.
- Coderax Web and CoderaxCLI live in other repositories and were not accessible
  here. They can use the shared SDK's artifact methods, but no client change or
  cross-client test was made in this repository.
- The Native agent still returns text; artifacts are stored when a client or a
  task uploads them, generates them through `POST /v1/deliverables` or
  associates them with a task. Generation is an explicit client operation, not
  yet an agent tool.
- The engine and the contracts package both pin `zod ^4.6.7`, which clears the
  earlier `zod 3.25.76` advisory; nothing is suppressed.
- `image-size` (via `pptxgenjs`) and `uuid` (via `exceljs`) were audit findings
  on the previous head. They are resolved by scoped overrides to patched
  releases: `image-size@2.2.0` (`GHSA-5p2g-fcmc-qvqq`, `GHSA-w3rx-r6r6-pgpr`;
  patched 2.0.3) and `uuid@11.1.1` (`GHSA-w5hq-g745-h8pq`; patched 11.1.1).
  PptxGenJS 4.0.1's bundles do not reference `image-size` (image sizing uses the
  optional `sizeof` require), and ExcelJS calls only `uuid.v4`, whose signature
  is unchanged in 11.x. Both overrides are covered by the passing generator
  tests.
- ExcelJS 4.4.0 has no patched upstream release for the CVE records published
  on 2026-11-13 (`CVE-2026-128338` through `CVE-2026-128348`, high except the
  medium ReDoS and low formula-injection records). They are parsing- and
  writer-side issues; this service only writes workbooks and re-reads bytes it
  generated, and no endpoint parses an uploaded workbook. Latest stable is 4.4.0
  (2023-10-19) and the 4.4.1 prerelease (2024-12-20) predates the records, so no
  upstream upgrade exists. A hardened fork, `exceljs-hardened@5.1.1` (published
  2026-11-16), carries patched versions of these advisories, but adopting a
  different package is a dependency substitution that needs an owner decision and
  API verification; it is not a semver-compatible change. This remains an
  unresolved dependency risk, reported rather than waived.
