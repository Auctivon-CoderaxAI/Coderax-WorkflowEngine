# Artifacts and deliverable intelligence

This engine produces real files and verifies them after writing. It is not a
renderer for HTML approximations and it does not report a capability it does not
have.

## Surface

| Operation | Method | Purpose |
| --- | --- | --- |
| `generateDeliverable` | `POST /v1/deliverables` | Produce and verify one deliverable in a workspace mode. |
| `listCapabilities` | `GET /v1/capabilities` | Artifact formats and media capabilities with truthful availability. |

Both are owner-only, validated against `packages/contracts/src/artifacts.ts`, and
included in the generated `openapi.json` and the shared SDK
(`client.deliver(...)`, `client.capabilities()`).

## Kinds

### `document`

- DOCX, PDF, Markdown and HTML from one persisted model
  (`<name>.document.json`).
- Blocks: headings, paragraphs, bulleted and numbered lists, quotes, code, tables
  and page breaks.
- **Editing** is model-based: send `base` (a `.document.json` from an earlier run)
  and `edits` (`append`, `replace`, `remove`, `setTitle`); every format is
  re-rendered from the edited model.
- **Analysis** reads the produced DOCX back: paragraphs, heading levels, tables,
  word and character counts.
- **Summarization** is extractive (term-frequency sentence selection). It is not a
  language model summary and does not claim to be.
- **Verification**: ZIP parts exist, the DOCX re-reads with the requested heading
  and table counts and contains the title, and the PDF has a valid header,
  cross-reference offset and trailer.

PDF text is encoded WinAnsi because only the PDF standard fonts are embedded.
Characters outside that repertoire are replaced with `?`; Unicode PDF output
requires embedding a font, which this engine does not do.

### `spreadsheet`

- XLSX with multiple worksheets, typed columns (text, number, currency, percent,
  date), number formats, frozen headers and a generated totals row.
- Real formulas: declared cells plus `SUBTOTAL` totals.
- Structured Excel tables with filters and a table style.
- **Native worksheet charts** (bar, line, pie): the chart, drawing, relationship
  and content-type parts are written as OOXML, not as a picture of a chart.
- **Verification** reloads the workbook with ExcelJS, checks worksheet and row
  counts, every declared formula in its cell, and reads each chart part.

Chart parts and drawings are structurally valid OOXML; they were not opened in
Microsoft Excel as part of this repository's checks. Excel is stricter than a
schema check, so treat first use in Excel as the compatibility test.

### `presentation`

- PPTX with an editable title, content, section and two-column layouts.
- Text, tables, native charts, autoshape flow diagrams and speaker notes.
- **Verification** reopens the ZIP, checks the slide count, each slide's title
  text, the chart graphic frames and the notes parts.

HTML slides are not produced: this is a PPTX writer, and it is not described as
full PowerPoint compatibility beyond what the parts prove.

### `dataset`

- CSV (quoted fields, embedded commas and newlines) or JSON (array of objects, or
  `{ rows: [...] }`).
- Type inference, missing values, duplicates and descriptive statistics
  (count, unique, min, max, mean, median, sample standard deviation).
- Declared transformations: `filter`, `select`, `rename`, `derive`, `sort`,
  `groupBy`, `dropMissing`, `dedupe`, `replace`, `trim`, `cast`.
- `derive` evaluates a small arithmetic language over columns (`+ - * /`,
  parentheses, `abs`, `round`, `floor`, `ceil`, `min`, `max`); it never evaluates
  JavaScript.
- The recipe (source digest + declared steps + applied descriptions) is persisted
  as `<name>.recipe.json` and its digest is reported.
- Exports: XLSX (data, profile and recipe sheets plus charts), CSV, JSON analysis
  and a PDF report.

### `software`

- A source tree plus generated `MANIFEST.json` with per-file digests.
- Optional scaffolds (`module`, `cli`, `service`) or supplied files.
- **Verification** parses every JavaScript file with Node's `--check` (compile
  only) and resolves every relative import to a file in the tree. TypeScript files
  are checked with the TypeScript compiler when it is present in the execution
  image; otherwise the request fails rather than claiming a check it did not run.
- The generated program is **not executed**. The engine has no code sandbox, and
  running arbitrary generated code with its credentials would be a security
  failure, not a feature.

### `media`

- `image.inspect`: deterministic header inspection for PNG, JPEG, GIF and WebP
  (format, bytes, pixel dimensions). No pixel decoding and no model inference.
- `image.generate`, `image.edit`, `audio.transcribe`, `speech.synthesize` and
  `video.understand` are reported as **unavailable** (`not_configured`). No
  verified zero-cost provider is configured, and paid routing is disabled. These
  capabilities are not simulated.

## Execution, permissions and receipts

The toolkit (`src/artifacts`) has no dependency on HTTP, persistence or
orchestration. It receives:

- a confined workspace root for the request's data mode;
- an authorization callback, called before a deliverable folder is created;
- a receipt sink.

There are two callers, not two runtimes:

1. `POST /v1/deliverables` resolves the mode root through
   `resolveEngineWorkspace`, authorizes the owner's own request, and records an
   audit receipt.
2. Coderax Native executes a fenced `deliverable` directive inside a Work task.
   The objective may contain:

   ````text
   ```deliverable
   { "kind": "document", "filename": "release-note", "title": "Release note",
     "formats": ["docx", "pdf"], "blocks": [ ... ] }
   ```
   ````

   The directive is validated against the same contract, removed from the text the
   model sees, reported as `tool.call` / `tool.result` events, and its artifacts
   are stored on the task result. Chat does not execute directives: a single Chat
   turn has no task record and stays side-effect free.

Native writes only into a **new** deliverable folder inside its confined
workspace. A path that already exists is refused with `permission_required`
rather than overwritten; widening that needs an owner-approved
`workspace.write` grant, which is not wired to the permission store yet.

Artifacts are stored as real files under `<workspace>/deliverables/` and recorded
on the task result as workspace-relative paths with `sha256:` digests. There is no
binary download operation in this contract; a client on the engine host reads the
file, and the digest is the integrity check. Deleting a deliverable is not
implemented and nothing in this subsystem deletes a file.

## Verification is the completion signal

A deliverable is returned only when every check passes. A failed check returns
`internal_error` with the first failing detail and records a refused receipt; the
files that were written remain on disk for inspection.

## Zero cost

Generation uses open-source libraries (`docx`, `exceljs`, `pptxgenjs`,
`pdf-lib`) running on the engine host. No model provider is called for artifact
generation, no paid service is involved, and the zero-cost model gate is
unchanged.
