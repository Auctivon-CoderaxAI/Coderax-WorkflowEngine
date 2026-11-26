# Reconciliation with the authoritative branches

This document records the state of the artifact-generation work against the
repository's other active branches. It exists so the next integration is based on
verified facts rather than on an assumption that this checkout contains the whole
engine.

## What this branch contains

`feat/artifact-intelligence` is based on `main` at
`808dfd3797f9b1d7647ebd14bd395806fc4ab9bd`. Its commit
`5a28a937d871c1b734adf82e01bdf8cf1b797321` adds:

- real DOCX, PDF, XLSX and PPTX writers with read-back verification;
- CSV/JSON dataset parsing, deterministic transformations, a reproducible
  recipe, profiling, and XLSX/CSV/JSON/PDF exports;
- source-tree generation with syntax and import-resolution checks;
- one toolkit shared by the owner API (`POST /v1/deliverables`) and Coderax
  Native Work tasks;
- 13 new unit/e2e tests. The full gate is 121 tests plus the OpenAPI drift
  check.

The branch deliberately does **not** add persistence, a capability registry, a
model router, a permissions store or an execution engine. It writes inside the
workspace it is given and returns descriptors.

## The other branches are real and are not in `main`

Fetched on 2026-11-26 with `git ls-remote` and a chat-scoped fetch:

| Ref | Head | GitHub PR | Scope |
| --- | --- | --- | --- |
| `feat/intelligence-core` | `3d4ac1c` | #2 (open) | native tool loop, zero-cost router, MCP, retrieval |
| `feat/native-reasoning-planner` | `90b87db` | #3 (open) | dependency-aware reasoning, verification, escalation |
| `feat/zero-cost-model-router` | `1cd780d` | #4 (open) | authoritative provider-independent router |
| `feat/execution-supervisor` | `13d4b4f` | #5 (open) | central supervisor and termination |
| `feat/durable-artifacts` | `2259248` | none listed | durable artifact service, Mongo blobs, versions, quota, 137 tests |
| `feat/multimodal-creative-intelligence` | `c0cfa99` | none listed | media input, capability registry, SVG/HTML validator, model providers |
| `ci/permanent-quality-gate` | `676ad8c` | none listed | permanent quality/security suites |

`feat/durable-artifacts` is the authoritative byte store. It defines
`ArtifactDescriptor`, `ArtifactUploadRequest`, owner/mode scoping, immutable
versions, retention, quota, download, export and delete, and refuses uploads
when the blob store is not durable. `feat/multimodal-creative-intelligence`
defines the media capability contract and the creative SVG/HTML validator. This
branch's earlier `Artifact` and `CapabilityReport` shapes overlap both, so they
must not be published as a second registry.

## Why this branch is not merged into those branches

A trial merge of `5a28a93` onto `2259248` (`feat/durable-artifacts`) was performed
on a throwaway branch and then discarded. It conflicted in seven files:

```
README.md
docs/artifacts.md
package-lock.json
packages/contracts/src/artifacts.ts   (add/add)
packages/sdk/src/index.ts
src/artifacts/media.ts                (add/add)
src/bootstrap/compose.ts
```

The textual conflicts are the smaller problem. The semantic ones are:

1. **Two artifact contracts.** Both branches add
   `packages/contracts/src/artifacts.ts`. Durable owns `ArtifactDescriptor`; this
   branch owns a workspace-relative `Artifact`. The latter must be deleted, not
   merged.
2. **Persistence is not optional.** Durable's service refuses uploads on a
   non-durable blob store. A deliverable therefore has to stage, verify, upload,
   and only then return descriptors. Returning a workspace path after a refused
   upload would be a false success.
3. **Flat filenames.** Durable accepts a bounded *filename*, not a path. A
   software source tree (`src/index.js`, `lib/index.js`) cannot be stored as
   separate path-named artifacts without a bundle or a flattened naming scheme.
   That is a product decision, not a mechanical rename.
4. **Editing.** This branch edits a document from a workspace-relative
   `.document.json`. Durable's cross-device continuity requires reading the model
   back by `artifactId`/version through the service. Supporting one while
   advertising the other would overstate the capability.
5. **Media is owned elsewhere.** `feat/multimodal-creative-intelligence` already
   defines image sniffing and the capability report. This branch's
   header-inspection and `/v1/capabilities` route duplicate it and must be
   removed rather than exposed.

Merging through those conflicts without the owners' PRs landing would either
produce a second artifact service or break the 121 tests this branch is required
to preserve. Neither is an acceptable "consolidation".

## Required integration order

1. Land/review #2 (intelligence core) first: it replaces the ad-hoc Native tool
   loop this branch's directive uses.
2. Land #4 (router) and #5 (supervisor); #3 builds on the planner contract.
3. Land `feat/durable-artifacts` and `feat/multimodal-creative-intelligence`.
4. Rebase this branch. Replace its `Artifact`/`CapabilityReport` with
   `ArtifactDescriptor` and the media capability contract.
5. Inject a persistence port into `ToolkitContext`:

   ```ts
   persist(input: {
     filename: string;
     mediaType: ArtifactMediaType;
     kind: ArtifactKind;
     bytes: Buffer;
     note?: string;
   }): Promise<ServiceResult<ArtifactDescriptor>>;
   ```

   The API adapter calls `artifactService.upload(principal, ...)`; the Native
   adapter calls it with the task's `taskId` and `conversationId`. The toolkit
   keeps writing only inside its confined workspace for verification, and the
   returned `Deliverable.artifacts` are durable descriptors.
6. Decide software-tree storage (flattened filenames, a JSON bundle, or a
   reviewed non-archive project format) before advertising project export.
7. Add editing by artifact id: download the retained model version, apply the
   edit, upload a new version, and keep the prior versions.
8. Re-run durable's 137 tests, this branch's 121 tests, independent OOXML/PDF
   parsing and the OpenAPI drift check at the final SHA.

## What was verified in this turn

- `main` is still `808dfd3`; this branch's commit is based on it.
- All seven refs above exist and were fetched read-only into
  `refs/chat/3946a9c0/*`; no shared branch or `main` was changed.
- GitHub lists five PRs: #2, #3, #4 and #5 are open; #1 is closed. No PR exists
  for this branch, `feat/durable-artifacts` or
  `feat/multimodal-creative-intelligence`.
- No GitHub Actions check run exists for `5a28a93`. The workflow is triggered by
  a pull request, and no PR exists, so there is no hosted run to cite.
- The durable branch's implementation and tests were read: it is a complete
  service with Mongo-backed blobs, not a stub.
- The multimodal branch's media contract and creative validator were read: it
  owns the registry this branch must not duplicate.

## Limitations of this record

No pull request was opened. This environment has no `gh` binary, no
`GITHUB_TOKEN`/`GH_TOKEN`, no credential helper and no authenticated GitHub API
path; `cloud_git` can only fetch, pull and push. Creating a PR needs a credential
that is not present here. The branch is published and the compare URL is:

`https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine/pull/new/feat/artifact-intelligence`

No independent approval was obtained, no hosted Actions run was produced, and no
merge of the authoritative branches was performed. Those are reported as
outstanding, not as completed.

## Cost

No paid inference, storage, conversion or new Vercel dependency was introduced.
The writers are deterministic OSS libraries already in `package-lock.json`
(`docx`, `exceljs`, `pdf-lib`, `pptxgenjs`). The durable and multimodal branches
are existing repository work, not new services.
