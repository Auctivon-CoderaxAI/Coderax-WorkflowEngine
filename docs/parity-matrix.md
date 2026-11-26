# Feature parity matrix: Coderax engine vs WorkflowEngine

Baseline: `Coderax@a5d237b0`, `packages/api/src/engines` and
`packages/data-schemas/src/methods/workRun.ts`.
Candidate: this repository at the head of `feat/workflow-engine-foundation`.

Status vocabulary:

- **Preserved** — same behavior, same failure semantics.
- **Strengthened** — same behavior with a stronger guarantee.
- **Simplified** — the behavior exists in a reduced form; the difference is named.
- **Missing** — no equivalent; the capability cannot be claimed.
- **Changed** — deliberately different, with the reason recorded.

| # | Capability | Coderax | WorkflowEngine | Status |
| --- | --- | --- | --- | --- |
| 1 | Normalized engine event contract | `engines/types.ts` (11 event types) | `packages/contracts/src/events.ts` (14 types, versioned envelope with `eventId` + `seq`) | Strengthened |
| 2 | `file.edit` progress event | `types.ts` | added in this review | Preserved |
| 3 | Engine session id on start | `started.sessionId` | `task.started.payload.sessionId` (optional) | Preserved |
| 4 | Fail-closed selection, never substitute | `registry.ts` | `src/agents/registry.ts` | Preserved |
| 5 | Configuration admission vs runtime readiness | `describe()` / `describeForStart()` | `availability()` only | Simplified — no live probe (review F11) |
| 6 | Live readiness probe (`/global/health`) | `opencode/adapter.ts` | none | Missing |
| 7 | Single-run arbitration per task | in-process `arbiter.ts` | lease uniqueness on `[tenant, owner, conversation]` | Strengthened — works across replicas |
| 8 | One settlement per run | `run.ts` | `src/execution/runner.ts` | Preserved |
| 9 | Stream ending without a terminal event is a failure | `run.ts` (`protocol_error`) | `runner.ts` | Preserved |
| 10 | Bounded cancellation cleanup (5 s) | `run.ts` | none | Missing (review F6) |
| 11 | Bounded same-engine retry, `retryable` + no cleanup, inside half the lease | `retry.ts` | `src/execution/retry.ts` | Preserved |
| 12 | Workspace confinement, symlink-resolved, mode-partitioned, Windows-safe | `workspace.ts` | `src/execution/workspace.ts` | Preserved |
| 13 | Confine a caller-supplied subdirectory | `resolveEngineWorkspace({requestedRoot})` | derives the root; no caller path | Simplified (review F9) |
| 14 | Durable lease: expired-only claim, token fence, durable cancel, prune | `workRun.ts` + `leases.ts` | `src/persistence/work-runs.ts` + `src/execution/lease.ts` | Preserved |
| 15 | Lease TTL / retention / sweep bound | 30 s / 24 h / 100 | same constants | Preserved |
| 16 | MongoDB-backed lease table | `createWorkRunMethods` (mongoose) | `src/persistence/mongo.ts` (driver-agnostic port) + index bootstrap | Preserved (verified against a fake; no live DB) |
| 17 | Fenced terminal write for the task record | `fenceWorkRun` on the conversation row | `TaskRepository.updateFenced` on the task row | Preserved |
| 18 | Fenced conversation write | `fenceWorkRun` | not implemented; conversations are written after settlement | Missing |
| 19 | Persistent task records | MongoDB (conversations + messages) | in-memory `TaskRepository` | Missing (review F2) |
| 20 | Persistent conversations and messages | MongoDB | in-memory `ConversationRepository` | Missing (review F2) |
| 21 | Persistent memory | conversation/agent files | in-memory, mode-partitioned | Missing (review F2) |
| 22 | Persistent events / replay across restart | Redis (optional) + Mongo | in-memory sequenced bus | Missing (review F2) |
| 23 | Completion notifications | client polling of conversation state | notification store + endpoint (in-memory) | Simplified |
| 24 | Prompt built from the transcript | `workChat/prompt.ts` | none; `objective` only | Missing (review F7) |
| 25 | Message content parts, `unfinished` / `error` flags | `workChat/persistence.ts` | plain text messages | Simplified |
| 26 | Owner gating for Work ingress (ADMIN + config flag + body shape) | `workChat/gating.ts` | single-owner auth on every route | Strengthened (no role model to bypass) |
| 27 | OpenCode transport (SDK, Basic auth, session, prompt, abort) | `opencode/adapter.ts`, `sdk.ts`, `auth.ts` | injected transport only | Missing (review F3) |
| 28 | OpenCode protocol mapping | `opencode/protocol.ts` | none | Missing |
| 29 | Zero-cost model plan with ordered candidates | `opencode/models.ts` | `src/models/catalog.ts` + `routing` | Simplified — no multi-candidate auto fallback |
| 30 | Automatic model fallback within one engine | `opencode/fallback.ts` | none | Missing |
| 31 | FreeBuff SDK loading, loopback restriction, context floor | `freebuff/adapter.ts` | injected transport only | Missing (review F3) |
| 32 | OpenHands adapter | `openhands/adapter.ts` (always `not_configured`) | not present | Changed — outside the three-agent model (review F10) |
| 33 | Coderax Native agent | LibreChat agent stack in `packages/api/src/agents` | new deterministic planner + gateway (`src/agents/native`) | Changed — not the same agent; see #34 |
| 34 | Native tools / MCP / skills / subagents / RAG / code execution | present in Coderax | absent; `tools: false` | Missing |
| 35 | Secret redaction of provider text | `cloud/redact.ts` | `src/observability/redact.ts` | Preserved (added in this review) |
| 36 | Private/cloud mode denial for providers | `cloud/mode.ts` | workspace + memory partitioning only | Simplified |
| 37 | Durable cancellation | lease flag | lease flag + service cancel | Preserved |
| 38 | Resume / retry of an interrupted task | partial (retry of start failures) | `resume` and `retry` on the service, with checkpoints | Strengthened |
| 39 | Checkpoints | none | `checkpoint.completedSteps` + accumulated text | Strengthened |
| 40 | Approval records bound to an exact resource | approvals store | permission store; adapter does not create the record | Simplified (review F5) |
| 41 | SSE streaming to a client | `workChat/handler.ts` | `src/api/server.ts` (SSE with `seq`/`eventId`) | Preserved |
| 42 | Health / readiness endpoints | `/health`, `/livez`, `/readyz` | `src/observability/health.ts` + routes | Preserved |
| 43 | Audit trail of execution receipts | none | `src/observability/audit.ts` | Strengthened |
| 44 | Schedules (cron) | `croner` + Mongo | none | Missing (Phase 7) |
| 45 | Cloud browser orchestration | none | none | Not started (both) |
| 46 | DeploymentPlatformAI integration | partial | none | Missing |
| 47 | Tool/plugin execution | Coderax tools | none | Missing |
| 48 | Versioned HTTP contract + generated OpenAPI | OpenAPI document published at runtime | `packages/contracts` + committed `openapi.json` + drift gate | Strengthened |
| 49 | Shared typed SDK for both clients | none (hand-written helpers) | `packages/sdk` | Strengthened |
| 50 | Startup dependency validation | none (config read at request time) | `src/bootstrap/compose.ts` refuses to start | Strengthened |

## Summary

| Status | Count |
| --- | --- |
| Preserved | 15 |
| Strengthened | 10 |
| Simplified | 7 |
| Missing | 15 |
| Changed (deliberate) | 2 |
| Not started (both) | 1 |

## What this means

The engine is a **better foundation** than Coderax for the things Coderax gets
wrong: one contract, one composition root, cross-replica leases, fenced terminal
writes, sequenced events, checkpoints, and an independent Native path.

It is **not yet a functional replacement**. Every row marked Missing is a
capability Coderax has today. Until rows 5, 6, 10, 18–22, 24, 27–30, 32–34, 36,
40, 44 and 47 are closed, migrating a client would remove functionality, which
the brief forbids.

Dependency order for closing them:

1. Persistence for tasks, conversations, memory, events, notifications (rows 18–22).
2. Prompt construction from the transcript (row 24).
3. Real OpenCode transport and model plan (rows 27–30), then FreeBuff (31).
4. Native tools (34) — the largest single item, and the one that decides whether
   Coderax Native can actually replace the LibreChat agent stack.
5. Approvals (40), bounded cleanup (10), live probes (5–6).
6. Schedules (44) and plugins (47).
7. Only then Phase 5/6 client migration, Phase 8 deployment, Phase 9 removal.
