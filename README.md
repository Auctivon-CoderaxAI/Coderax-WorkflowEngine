# Coderax WorkflowEngine

CoderaxAI's independent cloud-native intelligence, agent orchestration, durable
Work execution, model routing and integration engine.

This repository is the **execution platform** half of one personal AI operating
system. It owns Coderax Native intelligence, agent selection, task planning and
execution, durable state, model routing, permissions, events and health. It owns
no chat interface, no sidebar and no terminal UI: Coderax (web) and CoderaxCLI
are clients of the same versioned API.

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine` (private)
- Companion: [`Coderax`](https://github.com/Auctivon-CoderaxAI/Coderax) (web UI, Chat and Work)
- Companion: [`CoderaxCLI`](https://github.com/Auctivon-CoderaxAI/CoderaxCLI) (terminal client)
- Runtime: Node.js 24, TypeScript, zero paid dependencies, zero paid infrastructure

## What this repository proves today

| Capability | State | Evidence |
| --- | --- | --- |
| Versioned HTTP + event contracts | Implemented | `packages/contracts` |
| OpenAPI generated from those contracts | Implemented | `openapi.json`, `npm run openapi:check` |
| Shared SDK consumed by UI and CLI | Implemented | `packages/sdk` |
| Centralized route registration + completion gate | Implemented | `src/api/router.ts`, contract tests |
| Named-dependency composition root | Implemented | `src/bootstrap/container.ts`, `compose.ts` |
| Startup validation (config, auth, roots, agents, routes) | Implemented | `src/bootstrap/compose.ts` |
| Fail-closed agent selection, no substitution | Implemented | `src/agents/registry.ts` |
| Durable lease with unique fencing token | Implemented | `src/execution/lease.ts`, `src/persistence/work-runs.ts` |
| Atomic claim, renewal, durable cancel, prune | Implemented | `src/persistence/work-runs.ts` |
| Terminal-state fencing (stale run cannot overwrite) | Implemented | `src/persistence/tasks.ts`, fencing tests |
| Heartbeat, crash detection, interrupted-task recovery | Implemented | `src/execution/runner.ts`, `src/orchestration/service.ts` |
| Cancellation, resume, bounded same-engine retry | Implemented | `src/orchestration/service.ts`, e2e tests |
| Sequenced events, dedupe, out-of-order protection, replay | Implemented | `src/events/bus.ts` |
| Durable schedules: one-time, interval, hourly, daily/weekly calendar (IANA zone), monthly and named events | Implemented | `src/scheduling`, `src/persistence/schedules.ts` |
| Cross-replica schedule idempotency: unique receipt key, deterministic task id, Work lease | Implemented; Mongo adapter fake-verified, not live-verified | `src/scheduling/identity.ts`, `src/persistence/mongo-schedules.ts`, two-replica test |
| Schedule retry, missed-run recovery, pause/resume/cancel, edit, upcoming preview, priority, run and inference budgets | Implemented | `src/scheduling/engine.ts`, schedule tests |
| Schedule completion, failure, missed-run and refusal notices | Implemented | `/v1/notifications` (merged list and mark-read), schedule notice stores |
| Owner-only auth, scoped permissions, private/cloud memory split | Implemented | `src/security`, `src/permissions`, `src/memory` |
| Zero-cost model gate (paid refused, daily budget) | Implemented | `src/models/catalog.ts`, `src/models/budget.ts` |
| Secret redaction of adapter and provider text | Implemented | `src/observability/redact.ts` |
| MongoDB lease table + index bootstrap | Implemented, selected at startup; not live-verified | `src/persistence/mongo.ts`, `src/bootstrap/compose.ts` |
| Coderax Native agent | Implemented | `src/agents/native` |
| External agent adapters (OpenCode, FreeBuff) | Contract + isolation only | `src/agents/adapters/external.ts` |
| Durable lease persistence across replicas | Selected by `persistence.driver=mongo`; startup fails without a reachable collection; not live-verified | `src/bootstrap/compose.ts` |
| Task, conversation, memory, event and notification persistence | In-memory only | `src/persistence/*` |
| Cloud deployment of this engine | **Not done** | see `deploy/README.md` |
| Migration of Coderax UI and CLI onto this API | **Not done** | see `docs/migration-plan.md` |

Read the table literally. A green test suite here is not a claim that Coderax has
been migrated, that the engine is deployed, or that the external agents work.

`docs/parity-matrix.md` is the authoritative comparison against the engine
Coderax runs today, and `docs/pr-1-review.md` records what is preserved, what is
simplified and what is still missing.

## Quick start

```bash
npm install
npm run build
npm test                          # 162 tests: unit, contract, integration, security, e2e
npm run openapi:check             # fails if the published contract drifted
```

Run the engine (it refuses to start until every startup check passes):

```bash
export CODERAX_OWNER_ID=owner
export CODERAX_OWNER_TOKEN="$(openssl rand -hex 32)"
export CODERAX_INFERENCE_BASE_URL=https://your-zero-cost-endpoint/v1
export CODERAX_INFERENCE_KEY=...
# workspace roots must exist, be absolute and must not overlap
node -e "require('fs').mkdirSync('/srv/coderax/private',{recursive:true});require('fs').mkdirSync('/srv/coderax/cloud',{recursive:true})"
CODERAX_ENGINE_CONFIG=./engine.json npm start
```

`engine.json` carries the non-secret settings; environment variables win over it:

```json
{
  "auth": { "ownerId": "owner" },
  "workspaces": { "privateRoot": "/srv/coderax/private", "cloudRoot": "/srv/coderax/cloud" },
  "models": { "route": [{ "providerId": "openrouter", "modelId": "coderax:free" }] },
  "engines": { "default": "native" }
}
```

The engine binds `127.0.0.1` by default and is never public-facing.

## Architecture

```text
packages/contracts   versioned zod schemas, route catalogue, OpenAPI generator
packages/sdk         typed client; validates every response against contracts
src/bootstrap        composition root, named dependency container, startup gate
src/api              transport-agnostic router, route handlers, Node HTTP server
src/routing          dispatch through the registry (no fallback, no UI logic)
src/orchestration    Work lifecycle: submit, execute, cancel, resume, retry, recover
src/scheduling       zone-aware recurrence, durable schedule engine, occurrence identity
src/execution        leases, arbitration, heartbeat runner, retry, workspace confinement
src/persistence      task repository (fenced writes), lease tables, conversations
src/agents           registry, Coderax Native, isolated external adapters
src/models           verified catalogue, zero-cost route, daily budget ledger
src/events           ordered event log with dedupe and replay
src/permissions      scoped, single-use approval requests
src/memory           owner- and mode-partitioned memory
src/observability    health, readiness, append-only audit receipts
```

The dependency direction is one-way: `api -> orchestration -> execution/agents/
models/persistence`, and `packages/sdk -> packages/contracts`. No module reads
another module's internals, no route touches a repository, and nothing constructs
its own collaborators.

## Non-negotiables enforced in code

- **$0**: no paid model is representable (`allowPaid` is a literal `false`), and a
  daily request/token budget refuses rather than overruns.
- **Cloud-only execution**: the engine runs on its host; clients execute nothing.
- **Owner-only**: one principal, constant-time token comparison, no memberships.
- **No silent substitution**: an unavailable agent is refused, never swapped.
- **No private/cloud bleed**: memory and workspaces are partitioned by data mode.
- **Durable Work**: closing the browser or the CLI never ends an authorized task.
- **Fenced state**: an expired generation can never overwrite a newer one.

## Scheduling

Schedules persist across a restart only when `persistence.driver` is `mongo`.
With the default `memory` driver they are process-local, together with their
receipts and notices; scheduling is intended for the durable driver.

A schedule is a durable owner record, not a client timer. `POST /v1/schedules`
accepts a one-time instant, an interval, an hourly rule, a daily or weekly
calendar rule in an IANA time zone, a monthly rule, or a named event. An interval
with an explicit anchor is the custom recurrence. `GET /v1/schedules/{id}/upcoming`
previews the next occurrences without writing a receipt. The engine's own loop
discharges due occurrences even when no web or CLI client is connected.

- **One occurrence, one receipt, one task.** An occurrence is written as a receipt
  whose `executionKey` is unique before any Work is submitted. The task id is
  derived from the schedule, the occurrence and the attempt, so a recovered
  dispatch cannot create a second task. The existing conversation lease is the
  third guard.
- **Bounded by default.** `maxRunsPerDay`, `maxRunsTotal`, a per-run inference
  `budget`, the engine's `maxConcurrentRuns`, bounded retries and
  `pauseAfterFailures` refuse or park work instead of letting a schedule run away.
- **Missed runs are decisions, not storms.** A late occurrence is recorded once and
  the schedule advances beyond the outage; `missedRunPolicy: run_once` opts into a
  single catch-up run.
- **No widened autonomy.** The agent, mode, model and objective are the
  authorized execution identity; `PATCH /v1/schedules/{id}` cannot change them, so
  an edit cannot silently redirect an authorized schedule or expand its
  permissions. Changing them requires a new schedule and a new owner decision.
- **Ungated side effects are refused.** A schedule may only target an adapter that
  is either side-effect free or whose every action is gated by the permission
  store. An adapter that can act without a scoped owner decision is refused at
  creation and again at dispatch; a task-level `requireApproval` flag is not
  treated as a gate.
- **Time zones are resolved, not offset.** Calendar, hourly and monthly rules use
  `Intl` in the named zone, including the spring-forward gap and the repeated
  fall-back hour.

The engine exposes pause, resume, permanent cancel, edit, upcoming preview, a
deduplicated manual trigger, an event ingress, durable execution history and
durable notices. Notices appear in the one `/v1/notifications` list and its
mark-read operation, so clients keep a single unread indicator. `src/scheduling`
never writes task state itself: orchestration reconciles its receipts against the
authoritative task repository.

## Contributing

[`AGENTS.md`](AGENTS.md) is the contributor and agent policy. `main` is the only
persistent branch; every change reaches it through a reviewed pull request.
[`SECURITY.md`](SECURITY.md) covers the threat model and secret handling.
