# Artifact integration

This document records how durable artifact storage, deliverable generation and
Coderax Native were consolidated onto one architecture, which commits it depends
on, and what is still outstanding.

## Ownership

| Concern | Owner |
| --- | --- |
| Artifact persistence, metadata, versions, quotas, retrieval, deletion | `feat/durable-artifacts` |
| Capability registry and media capability contracts | `feat/multimodal-creative-intelligence` |
| Document, spreadsheet, presentation, dataset and software generation, and their verification | this branch (`feat/artifact-integration`) |
| Planning and orchestration | Coderax Native (`feat/native-reasoning-planner`, `feat/intelligence-core`) |
| Client-facing contracts | `packages/sdk` over `packages/contracts` |

There is one artifact metadata authority: `ArtifactDescriptor` from
`packages/contracts/src/artifacts.ts`. Generation-specific request shapes live in
`packages/contracts/src/deliverables.ts`; that module declares no artifact
metadata of its own and no capability list.

## Dependency SHAs

| Ref | Commit |
| --- | --- |
| `main` (base) | `808dfd3797f9b1d7647ebd14bd395806fc4ab9bd` |
| `main` (first merge) | `ec4a707…` — durable artifacts (`dd5e1db`), games and contracts 1.2.0 |
| `main` (second merge) | `49cb999…` — permanent quality gates (PR #23) |
| `feat/durable-artifacts` (branch base) | `8eceaad36c0eb433aafd919e38ac893a2f331e76` |
| `feat/artifact-intelligence` (recovery baseline) | `c9bac16b0bd78252d39282853bd9ef842b8f228c` |
| `feat/multimodal-creative-intelligence` (not merged) | `c0cfa993ef2d890b7abf4e2d33506c9f34214c85` |
| `feat/native-reasoning-planner` (PR #3) | `90b87db7832cd948e801e01c3cf9ce97409bb068` |
| `feat/intelligence-core` (PR #2) | `e14e4b714a5091b51cd2d0598b2b17cca56435f3` |
| `feat/zero-cost-model-router` (PR #4) | `b6e002bc11c4a402c04d652681f75744cf428d65` |
| `feat/execution-supervisor` (PR #5) | `13d4b4f7796f819e4e58bd18006efc4970929e6e` |

The integration branch was stacked on `feat/durable-artifacts` at `8eceaad`,
because that branch owns persistence. It was first built on `fd5edef`, rebased
once for validated tree paths and the `software`/`dataset` kinds, and rebased
again for the durable project manifest, restore operation and generator tree
adapter. Because `main` has since merged that branch (`dd5e1db`), this branch is
now a merge of `main` at `49cb999` plus the deliverable integration, and every
persistence decision above is `main`'s rather than a second copy. The planner,
router, permissions and supervisor arrive through `main`; nothing here
duplicates them.

## The five semantic conflicts and their resolution

1. **Artifact contracts.** The old branch defined its own `Artifact`
   (`path`/`kind`/`format`) and a `CapabilityReport`. Both are gone. Requests
   moved to `deliverables.ts`; every produced file is described by the durable
   `ArtifactDescriptor`.
2. **Durable blob writes.** Generation writes into
   `<mode-root>/.deliverables/<receipt>/` — a mode-scoped, engine-owned staging
   directory — and returns verified bytes. `src/artifacts/persist.ts` uploads
   through `ArtifactService`, and a deliverable is reported as created only
   after the service returned descriptors. Staging is removed in a `finally`,
   and a startup sweep removes directories a crashed process left behind.
3. **Software source trees.** Generation writes files into staging, then hands
   the whole batch to the durable adapter, `createArtifactTreeWriter`
   (`src/artifacts/tree.ts`). The adapter validates every relative path and
   media type before writing, refuses duplicate, case-folded and
   file-versus-directory path conflicts, maps a path that already exists in the
   project to a new version of the same artifact, and uploads new paths with
   the project, conversation and task associations. There is **no manifest
   artifact**: the store derives `ArtifactProjectManifest` from the rows that
   carry the `projectId`, so the tree has one authority and a client reads it
   with `GET /v1/artifacts/manifest`. A software request may name an existing
   `projectId` to extend that tree; otherwise the deliverable opens one. Because
   the manifest is a query over rows and carries no verification, the parse-only
   disclosure lives in the result as `Deliverable.project.verification`.
4. **Cross-device editing.** `DocumentRequest.base` is
   `{ artifactId, mode, expectedVersion? }`. The engine downloads that version
   from the durable service into staging, parses it as a
   `DocumentSourceArtifact`, applies the edits, regenerates and verifies every
   requested format, and appends versions to the *same* artifact ids recorded in
   the source. A stale `expectedVersion` is refused with `conflict`.
5. **Capability registry.** The duplicate media registry and the media stubs are
   removed. This branch publishes no capability list. Registering the
   productivity producers with the multimodal registry is a dependency-linked
   follow-up: `feat/multimodal-creative-intelligence` has no merged registry to
   register into yet.

## Merging with the durable branch after it landed on `main`

`feat/durable-artifacts` reached `main` (`dd5e1db`) with its own generation
bridge while this branch was stacked on `8eceaad`. Merging `main` produced 24
conflicted files, plus a second round after PR #23 took `main` to `49cb999`. Each
conflict was resolved by keeping one implementation per concern:

1. **One generation surface.** `POST /v1/deliverables` (`generateDeliverable`)
   replaces the interim `POST /v1/artifacts/generate` (`generateArtifact`,
   `ArtifactGenerationRequest`, `ArtifactGenerationResult`). The deliverable
   service is a superset — five kinds, revision by artifact id and the
   never-executed disclosure — so keeping both would have been two
   implementations of one capability. `src/artifacts/generate.ts` and its two
   suites are removed; the SDK method is renamed to match the operation id, which
   the contract test enforces.
2. **One artifact store.** The durable service, repository, tree adapter, chunked
   blob store and quota admission stay exactly as `main` has them. `media.ts`
   keeps `main`'s structural OOXML central-directory check (it does not inflate
   attacker-controlled entries) and `zip.ts` keeps it plus this branch's
   `normalizePackage`.
3. **Main's newer runtime is preserved**, not reverted: games and the game
   studio, browser control plane, schedules and notices, notifications,
   handshake 1.2.0, zod 4 (`prefault({})` defaults) and the quality-gate
   workflow. Where the merge had duplicated a block (two `artifactService`
   constructions, two artifact handler sets, two `schedules` entries), the
   duplicate was deleted rather than the newer one.
4. **Contracts are `main`'s catalogue plus `generateDeliverable`.**
   `openapi.json` is regenerated with `npm run openapi:write`.
5. **Test-only MongoDB.** `mongodb-memory-server` stays a devDependency so the
   durability lanes run instead of skipping; the dependency gate records it as
   the one reviewed install-script exception and it ships in no runtime
   artifact.

## Contract changes to coordinate with the durable owner

`ArtifactVersionRequest` gained an optional `expectedVersion`. `addVersion`
refuses the append when the stored version differs, which is what makes
cross-device editing safe against a concurrent writer. The field is optional, so
existing clients are unaffected; the durable branch should adopt it (or the
integration branch rebases when that branch changes).

`Deliverable.artifacts` is `ArtifactDescriptor[]`; `Deliverable.source` names the
editable artifact that can be revised by id (`document.json`);
`Deliverable.receipt` is the audit receipt written after persistence succeeded.
`Deliverable.project.verification` reports what verification actually proved,
with `executed: false` for generated software.

## Security controls

- Artifact content never passes through a model or an adapter: the service has no
  path that submits it to inference, and descriptors say
  `inferenceExposure: 'none'`.
- The store's media-type allowlist still refuses `text/html`, `image/svg+xml`
  and archives. That is why document generation persists DOCX/PDF/Markdown and
  not HTML: HTML rendering remains in `document.ts` for library use but is never
  stored or served as an artifact.
- Generated OOXML is re-zipped with `[Content_Types].xml` first
  (`normalizePackage`). OOXML does not require a part order, and a consumer that
  identifies a package from its leading bytes must not reject a valid document
  because a table pushed that part past the first 8 KB.
- Text wrapping bounds the measurement window (`breakToken`) so a single
  20,000-character token is split in linear rather than quadratic time. A request
  that used to stall the renderer now either produces a file or fails on quota.
- Staging paths are resolved and checked against the staging root; symlinks
  cannot turn a relative path into an escape.
- Generated software is parsed (`node --check`, TypeScript transpile) and its
  relative imports resolved. It is **not executed**: no sandboxed execution
  supervisor is available on this branch, and
  `Deliverable.project.verification` records `executed: false` with the method
  actually used. The disclosure is part of the result, so it survives the tree
  being derived from stored rows instead of a manifest file.

## Verification evidence

At the branch head, `npm run verify` runs the permanent gate: `tsc -b` across
contracts, SDK and engine, then `node dist/scripts/run-gates.js all` and
`node dist/scripts/run-gates.js coverage`. The result at this tree:

- **11 gates passed, 0 failed, 0 skipped** — unit, integration (fake Mongo
explicitly labelled), security, adversarial, contract, OpenAPI drift,
architecture, package artifacts, end-to-end, dependency audit and the live
real-MongoDB lane;
- `gate coverage passed: 77 test file(s) assigned, none unclaimed`, so no suite
can be added and silently left unrun;
- the live lane ran against a real `mongod` (7.0.14) started with
`CODERAX_TEST_MONGO_URI` and `CODERAX_REQUIRE_MONGO=1`; `mongodb-memory-server`
is a dev dependency, so the same lanes start their own server locally instead of
skipping. `.github/workflows/verify.yml` pins the same flags, so a missing
database fails the required check rather than reporting a green skip;
- `openapi.json` matches the published contracts.

The generation suite reads files back instead of trusting the writer: DOCX parts
are unzipped and their headings, tables and text counted; XLSX parts are checked
for native chart and table parts and a real `<f>` formula; PPTX parts for slides,
notes and a chart; CSV/TSV are re-parsed and compared row for row. Visual layout
is **not** verified — no renderer is available here.

The end-to-end suite exercises generate → validate → persist → restart engine →
retrieve → edit → new version → retrieve the previous version → delete, plus a
concurrent/stale edit refusal, quota exhaustion with no artifacts left behind, a
cross-mode read that reports `not_found`, and owner-token refusal.

### A half-finished edit

An edit appends the output files first and the stored document source last, so
the source is the only concurrency token and the only thing a reader resolves.
If the source write fails after the outputs were appended (a storage fault, or a
racing writer that won the version), the request fails, the source stays on its
old version, and the orphaned output version is never named by the stored model
— nothing half-updated becomes visible. The test for this injects exactly one
refused `addVersion` on the source and asserts the state that remains.

Two edits that both read version 1 are resolved by the same rule: exactly one
appends the source and wins, the other is refused with `conflict`. Both may have
appended their outputs first, so the loser's output version exists but is never
named by the stored source; the test asserts the three-version history and that
the winner's version is the one the source points at.

A retry must still be possible after such a failure. Pinning each output append
to the version the *source* records made the next edit conflict forever, because
the output artifact was already one version ahead; the source version is the
concurrency token and the derived outputs now follow it. The same test proves
the retry at the original `expectedVersion` succeeds and that the new source
version names the retried outputs.

## Outstanding work

- XLSX and PPTX editing of an *existing* file. Documents are editable by artifact
  id; workbooks and decks are regenerated from their stored source model.
- Images inside DOCX and PPTX.
- Rendering and visual layout verification for documents and slides.
- Secure build/test execution of generated software through the execution
  supervisor (PR #5). Until then generation is parse-verified only, and says so.
- Registering productivity producers with the multimodal capability registry
  after `feat/multimodal-creative-intelligence` lands.
- Merging PRs #2–#5 and rebasing this branch onto the consolidated `main`.
- Hosted CI at the pushed SHA: the workflow runs only for pull requests to
  `main` and pushes to `main`, and no pull request could be opened from this
  environment (no `gh`, no token), so no run exists to report.
