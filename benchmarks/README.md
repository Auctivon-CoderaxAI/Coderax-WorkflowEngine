# Model quality benchmarks

This directory holds the fixed suite used to produce local, reproducible quality
evidence. The router does **not** trust provider benchmark marketing.

## Method

- Suite: `benchmarks/suite.json`, versioned and hashed with SHA-256.
- Sampling: every task once per model, temperature 0, top-p default, 512 output
  tokens, 90-second bound.
- Grading: deterministic local functions in `src/models/benchmark.ts`:
  - `exact` and `contains` use normalized text;
  - `numeric` compares a parsed number within an explicit tolerance;
  - `tool` requires the expected tool name and a matching argument subset.
- Generated code is **not executed** during grading.
- The artifact records the suite digest, capture time, model reference, sample
  count, pass rates and average latency.

## Run

The run needs live credentials for at least one verified-free provider and spends
free-tier quota:

```bash
npm run build
npm run benchmark -- --suite benchmarks/suite.json --out benchmarks/results/<date>.json
```

Only models that are currently routable and verified free are tested. A provider
whose free status is not proven is skipped; the benchmark cannot turn a paid model
into a free one.

## Evidence in this change

No live benchmark result is committed. The authoring environment has no inference
provider credential, so a live run would have been fabricated if it appeared here.
What is committed is:

- the deterministic suite and artifact schema;
- unit tests proving grading, digest stability, artifact validation and category
  scoring;
- the router tests proving benchmark scores affect Complex ranking and that a
  missing score is classified `unknown` rather than guessed;
- a real discovery capture in `docs/evidence-openrouter.json`.

The benchmark is therefore **harness-verified, not live-quality-verified**. Run the
command above on a host with provider credentials and commit the artifact to make a
quality claim.
