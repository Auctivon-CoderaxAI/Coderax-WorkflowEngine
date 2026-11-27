# Feature parity matrix: Coderax engine vs WorkflowEngine

Baseline: `Coderax@a5d237b0`, `packages/api/src/engines` and
`packages/data-schemas/src/methods/workRun.ts`.
Candidate: this repository at the head of `feat/native-game-studio-gaming-agent`.

Status vocabulary:

- **Preserved** — same behavior, same failure semantics.
- **Strengthened** — same behavior with a stronger guarantee.
- **Simplified** — the behavior exists in a reduced form; the difference is named.
- **Missing** — no equivalent; the capability cannot be claimed.
- **Changed** — deliberately different, with the reason recorded.

| # | Capability | Coderax | WorkflowEngine | Status |
| --- | --- | --- | --- | --- |
| 1 | Normalized engine event contract | `engines/types.ts` (11 event types) | `packages/contracts/src/events.ts` (14 types, versioned envelope with `eventId` + `seq`) | Strengthened |
| 2 | `file.edit` progress event | `types.ts` | `packages/contracts/src/events.ts` | Preserved |
| 3 | Engine session id on start | `started.sessionId` | `task.started.payload.sessionId` (optional) | Preserved |
| 4 | Fail-closed selection, never substitute | `registry.ts` | `src/agents/registry.ts` | Preserved |
| 5 | Configuration admission vs runtime readiness | `describe()` / `describeForStart()` | `availability()` for admission + `probe()` per adapter | Preserved |
| 6 | Live readiness probe (`/global/health`) | `opencode/adapter.ts` | `src/agents/probe.ts`, non-required `agents` health check, 2 s bound | Preserved (no live agent contacted in tests) |
| 7 | Single-run arbitration per task | in-process `arbiter.ts` | lease uniqueness on `[tenant, owner, conversation]` | Strengthened — works across replicas |
| 8 | One settlement per run | `run.ts` | `src/execution/runner.ts` | Preserved |
| 9 | Stream ending without a terminal event is a failure | `run.ts` (`protocol_error`) | `runner.ts` | Preserved |
| 10 | Bounded cancellation cleanup (5 s) | `run.ts` | `src/execution/runner.ts` `cancelGraceMs` (5 s default) | Preserved |
| 11 | Bounded same-engine retry, `retryable` + no cleanup, inside half the lease | `retry.ts` | `src/execution/retry.ts` | Preserved |
| 12 | Workspace confinement, symlink-resolved, mode-partitioned, Windows-safe | `workspace.ts` | `src/execution/workspace.ts` | Preserved |
| 13 | Confine a caller-supplied subdirectory | `resolveEngineWorkspace({requestedRoot})` | derives the root; no caller path | Simplified (review F9) |
| 14 | Durable lease: expired-only claim, token fence, durable cancel, prune | `workRun.ts` + `leases.ts` | `src/persistence/work-runs.ts` + `src/execution/lease.ts` | Preserved |
| 15 | Lease TTL / retention / sweep bound | 30 s / 24 h / 100 | same constants | Preserved |
| 16 | MongoDB-backed lease table | `createWorkRunMethods` (mongoose) | `src/persistence/mongo.ts` (driver-agnostic port) + index bootstrap, selected at startup by `persistence.driver` | Preserved (verified against a fake; no live DB) |
| 17 | Fenced terminal write for the task record | `fenceWorkRun` on the conversation row | `TaskRepository.updateFenced` on the task row | Preserved |
| 18 | Fenced conversation write | `fenceWorkRun` | not implemented; conversations are written after settlement | Missing |
| 19 | Persistent task records | MongoDB (conversations + messages) | `src/persistence/mongo-tables.ts` (token + terminal check in the update filter) | Preserved (fake-verified; no live DB) |
| 20 | Persistent conversations and messages | MongoDB | `src/persistence/mongo-tables.ts` (unique conversation and message ids) | Preserved (fake-verified; no live DB) |
| 21 | Persistent memory | conversation/agent files | `src/persistence/mongo-tables.ts` (unique owner+mode+key) | Preserved (fake-verified; no live DB) |
| 22 | Persistent events / replay across restart | Redis (optional) + Mongo | `src/events/store.ts` (one row per event, unique `(taskId, seq)` and `eventId`, TTL retention) with the sequence allocated on the fenced task row and an SSE metadata frame | Preserved (fake-verified; no live DB, TTL expiry not exercised) |
| 23 | Completion notifications | client polling of conversation state | notification store + endpoint, persisted with the same driver | Preserved (mark-read has no HTTP operation yet) |
| 24 | Prompt built from the transcript | `workChat/prompt.ts` | `src/orchestration/transcript.ts` + `src/agents/native/prompt.ts` | Preserved (bounded turns; current turn excluded) |
| 25 | Message content parts, `unfinished` / `error` flags | `workChat/persistence.ts` | plain text messages | Simplified |
| 26 | Owner gating for Work ingress (ADMIN + config flag + body shape) | `workChat/gating.ts` | single-owner auth on every route | Strengthened (no role model to bypass) |
| 27 | OpenCode transport (SDK, Basic auth, session, prompt, abort) | `opencode/adapter.ts`, `sdk.ts`, `auth.ts` | injected transport only | Missing (review F3) |
| 28 | OpenCode protocol mapping | `opencode/protocol.ts` | none | Missing |
| 29 | Zero-cost model plan with ordered candidates | `opencode/models.ts` | `src/models/catalog.ts` + `routing` | Simplified — no multi-candidate auto fallback |
| 30 | Automatic model fallback within one engine | `opencode/fallback.ts` | none | Missing |
| 31 | FreeBuff SDK loading, loopback restriction, context floor | `freebuff/adapter.ts` | injected transport only | Missing (review F3) |
| 32 | OpenHands adapter | `openhands/adapter.ts` (always `not_configured`) | not present | Changed — outside the three-agent model (review F10) |
| 33 | Coderax Native agent | LibreChat agent stack in `packages/api/src/agents` | independent reasoning loop: model-assisted decomposition, dependency-aware parallel scheduling, bounded replanning, evidence verification and approval suspension (`src/agents/native`) | Changed — not the same agent; see #34 |
| 34 | Native tools / MCP / skills / subagents / RAG / code execution | present in Coderax | absent; `tools: false` | Missing |
| 35 | Secret redaction of provider text | `cloud/redact.ts` | `src/observability/redact.ts` | Preserved |
| 36 | Private/cloud mode denial for providers | `cloud/mode.ts` | workspace + memory partitioning only | Simplified |
| 37 | Durable cancellation | lease flag | lease flag + service cancel | Preserved |
| 38 | Resume / retry of an interrupted task | partial (retry of start failures) | `resume` and `retry` on the service, with checkpoints | Strengthened |
| 39 | Checkpoints | none | `checkpoint.completedSteps` + accumulated text | Strengthened |
| 40 | Approval records bound to an exact resource | approvals store | permission store; adapter does not create the record | Simplified (review F5) |
| 41 | SSE streaming to a client | `workChat/handler.ts` | `src/api/server.ts` (SSE with `seq`/`eventId`) | Preserved |
| 42 | Health / readiness endpoints | `/health`, `/livez`, `/readyz` | `src/observability/health.ts` + routes | Preserved |
| 43 | Audit trail of execution receipts | none | `src/observability/audit.ts` | Strengthened |
| 44 | Schedules (cron) | `croner` + Mongo, in-process | `src/scheduling` (once, interval, hourly, calendar in an IANA zone, monthly, named events) + durable receipts and Mongo store | Strengthened — cross-replica idempotency, missed-run policy, pause/resume/cancel, edit with an immutable execution identity, upcoming preview, priorities, run and inference budgets, notices merged into `/v1/notifications` |
| 45 | Cloud browser orchestration | none | contract v1, fail-closed adapter, approvals, receipts, takeover; no verified provider | Contract only |
| 46 | DeploymentPlatformAI integration | partial | none | Missing |
| 47 | Tool/plugin execution | Coderax tools | none | Missing |
| 48 | Versioned HTTP contract + generated OpenAPI | OpenAPI document published at runtime | `packages/contracts` + committed `openapi.json` + drift gate | Strengthened |
| 49 | Shared typed SDK for both clients | none (hand-written helpers) | `packages/sdk` | Strengthened |
| 50 | Startup dependency validation | none (config read at request time) | `src/bootstrap/compose.ts` refuses to start | Strengthened |
| 51 | Native Game Studio | project lifecycle + design brief only; every build capability hard-coded false (CX-32 Partial) | `src/games/studio.ts`: deterministic spec, plan, original source/assets/levels, 8 genres, procedural audio, self-contained preview, browser-boot and measured playability, export, iterations, persistence | Changed (deliberate) — lifecycle pattern migrated, executor newly built |
| 52 | Native Gaming Agent | no session runtime (CX-33 Blocked) | `src/games/session.ts`: durable sessions over verified, version-pinned builds, observation, bounded controls, pause/resume, takeover, cancel, memory, logs, measured completion | Changed (deliberate) |
| 53 | Gaming Agent — external game environments | none (blocked in the registry) | none; reported `blocked` with the exact prerequisite | Not started (both) |
| 54 | Build version history and restore | `revision`/`specRevision` only; no historical build bytes | `GET /v1/games/{gameId}/builds` plus exact-spec restore; traversal- and owner-checked | Changed (deliberate) |
| 55 | Real-browser acceptance of generated builds | none | platformer and puzzle rendered, controlled and completed in cloud Chromium; owner-only origin returned 403 anonymous / 200 owner | Changed (new evidence) — two reference builds, Chromium only |
| 56 | Autonomous cloud-browser gameplay | none | none; `native.gaming-agent.browser` reported blocked | Not started (both) |

## Summary

| Status | Count |
| --- | --- |
| Preserved | 24 |
| Strengthened | 10 |
| Simplified | 5 |
| Missing | 8 |
| Changed (deliberate) | 6 |
| Contract only (no verified provider) | 1 |
| Not started (both) | 2 |

## What this means

The engine is a **better foundation** than Coderax for the things Coderax gets
wrong: one contract, one composition root, cross-replica leases, fenced terminal
writes, sequenced events, checkpoints, and an independent Native path.

It is **not yet a functional replacement**. Every row marked Missing is a
capability Coderax has today. Until rows 18, 27–31, 34, 36, 40, 46 and 47 are
closed, migrating a client would remove functionality, which the brief forbids.
Scheduling (row 44) is implemented here and no longer blocks a client cut-over,
and persistent events with replay across restart (row 22) are durable as of the
event-log branch.

Dependency order for closing them:

1. Fenced conversation writes (row 18). Persistent events and replay across
   restart (row 22) are durable as of this branch.
2. Real OpenCode transport and model plan (rows 27–30), then FreeBuff (31).
3. Native tools, MCP, RAG and plugins (rows 34, 47) — the largest single item,
   and the one that decides whether Coderax Native can replace the LibreChat
   agent stack.
4. Approvals bound to a resource (40), provider mode denial (36), caller-supplied
   workspace confinement (13).
5. DeploymentPlatformAI (46) and a verified zero-cost browser
   provider for the contract in `docs/browser.md` (45).
6. Only then Phase 5/6 client migration, Phase 8 deployment, Phase 9 removal.

## Verification status

- `npm run verify` at this merge head: 398 tests, 398 passing, 0 failing, 0
  skipped with a real `mongod` reachable (`CODERAX_TEST_MONGODB_URI` set,
  `CODERAX_REQUIRE_MONGODB=1`), OpenAPI drift clean. The same command without a
  database reports 382 passing and 16 skipped, all of them MongoDB suites.
- Durable execution events are covered by store-contract, fenced-allocation,
  replay-across-restart and SSE-metadata tests, and by a real-MongoDB suite
  (`tests/integration/event-log-mongo.test.ts`) that proves the fenced `$inc`
  allocation, unique-sequence refusal, two replicas appending concurrently, and
  replay after an engine restart against a real `mongod`. TTL expiry is still not
  executed: the retention index is asserted on the server, not its deletion
  timing.
- Durable stores are verified against a semantics-faithful collection fake in
  the default offline run. The real-MongoDB suites run when
  `CODERAX_TEST_MONGODB_URI` is set (the CI lane supplies one) and are skipped,
  never passed, without it. The event-log suite was executed against a real
  `mongod` 7.0.14 for this merge: 398 tests, 398 passing, nothing skipped.
- No hosted CI run exists: the GitHub Actions job is blocked by account billing.
  The local run above is the only executed evidence.
- The Game Studio branch reports 132/132 passing tests and a clean OpenAPI drift check before integration.
- The branch reports separate MongoDB 8.0.4 durability and concurrency verification. See `docs/evidence/mongo/`.
- Game project and build bytes remain file-backed. Cross-replica game artifact concurrency is not claimed.
- Real Chromium acceptance was reported for the platformer and puzzle, including rendering, controls, scoring, collision, restart, audio and owner-only access.
- See `docs/evidence/browser/` for the acceptance reports.
- Safari, Firefox and physical mobile devices remain unverified.
- Autonomous cloud-browser gameplay remains blocked pending a verified zero-cost provider.
