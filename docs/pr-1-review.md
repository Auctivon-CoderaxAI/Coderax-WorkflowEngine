# Review: WorkflowEngine PR #1

Reviewer: lead engineer (this session). Scope: all 86 changed files at
`a0811ab`, plus the follow-up commits on the same branch. Comparison baseline:
the verified engine in `Coderax` at `a5d237b0` (`packages/api/src/engines`,
`packages/data-schemas/src/methods/workRun.ts`).

## Verdict

The implementation is a sound **foundation** and a faithful extraction of the
durable-execution semantics. It is **not** a drop-in replacement for Coderax's
engine today, and the PR must not be read as one. Three of the seven engine
adapters' worth of behavior exist only as a contract; persistence is durable for
leases and in-memory for everything else; and the Native agent is a new,
deterministic planner rather than Coderax's LibreChat agent stack.

That is an acceptable state for a foundation PR **only if it is stated**. Several
claims in the original PR body were broader than the code supports. They are
corrected in `docs/parity-matrix.md`, which is the authoritative statement of what
is preserved, simplified and missing.

## What is genuinely preserved

| Invariant | Evidence in this repo | Evidence in Coderax |
| --- | --- | --- |
| Fail-closed agent selection, no substitution | `src/agents/registry.ts` | `engines/registry.ts` |
| One settlement per run; a stream that ends early is a failure, not a success | `src/execution/runner.ts` | `engines/run.ts` |
| Bounded retry, same engine, explicit `retryable`, no pending cleanup, inside half the lease | `src/execution/retry.ts` | `engines/retry.ts` |
| Workspace confinement by data mode, symlink-resolved, overlap refused, Windows case-insensitive | `src/execution/workspace.ts` | `engines/workspace.ts` |
| Durable lease: claim only when expired, token-fenced renew/release, durable cancel flag, expired cancel ⇒ interrupted, bounded prune | `src/persistence/work-runs.ts`, `src/execution/lease.ts` | `engines/workChat/leases.ts`, `data-schemas/src/methods/workRun.ts` |
| Terminal writes fenced by a unique generation token | `src/persistence/tasks.ts` | `workChat/persistence.ts` (`fenceWorkRun`) |
| Owner-only authorization, constant-time compare, foreign ids report `not_found` | `src/security/auth.ts`, `src/orchestration/service.ts` | `engines/workChat/gating.ts` |
| Private/cloud memory separation | `src/memory/store.ts` | `cloud/mode.ts` |
| Zero-cost enforcement | `src/models/catalog.ts`, `src/models/budget.ts` | `engines/opencode/models.ts` |

## Findings

Severity: **H** high, **M** medium, **L** low. Status is at the head of this
branch.

### F1 — H — No secret redaction on adapter/provider text (fixed)

`Coderax` scrubs provider output (`cloud/redact.ts`). This engine passed adapter
failure detail and tool output straight into stored state and events, so a
provider echoing a key or a home path would have persisted it and streamed it to
a client.

Fixed: `src/observability/redact.ts` scrubs bearer tokens, provider keys, JWTs,
GitHub tokens, query-string credentials, `key=value` secrets and absolute home
paths; configured secrets are removed first. Applied at the two places text
leaves the engine (`service.publish` for `task.failed`, `service.toStatus` for a
stored failure) and to tool output and approval descriptions. Covered by
`tests/unit/redact.test.ts`.

### F2 — H — Production persistence is not complete (partially fixed, open)

The default stores for tasks, conversations, memory, events and notifications are
process-local. A restart loses them. Only the Work run lease table now has a real
MongoDB implementation.

Fixed for leases: `src/persistence/mongo.ts` implements `WorkRunTable` over the
MongoDB collection API with the same atomicity as the verified Coderax methods —
claim via upsert on an expired row, unique-key arbitration, token-fenced renew and
release, durable cancel flag, re-checked bounded sweep — plus
`ensureWorkRunIndexes` (unique `key`, `expiresAt`). Verified against a
semantics-faithful collection fake (`tests/unit/mongo-work-runs.test.ts`,
including duplicate-key arbitration and a renewed row surviving a sweep).

It is no longer dead code: `persistence.driver` (`memory` | `mongo`) is a validated
setting, and `src/bootstrap/compose.ts` builds the lease store from it, bootstraps
the indexes, and fails startup when `mongo` is selected without the connection
string named by `persistence.uriEnv`, without a reachable collection, or without the
optional `mongodb` package on the host. There is no silent downgrade to
process-local leases. Covered by `tests/unit/persistence-wiring.test.ts`.

Open: tasks, conversations, memory, events and notifications are still in-memory;
no live database has been contacted, so nothing here is "production persistence
verified". The port is structural, so a driver `Collection` satisfies it without
adding a runtime dependency.

### F3 — H — External agents are contracts, not integrations (open)

`src/agents/adapters/external.ts` requires an injected transport and reports
`not_configured` without one. There is no OpenCode SDK transport, no FreeBuff SDK
loader, and no OpenHands adapter. Coderax has all three (OpenCode with session
creation, Basic auth, `/global/health` probe, protocol mapping and abort).

The failure mode is safe — an unavailable external agent is refused, never
substituted — but "OpenCode and FreeBuff support" is not a true capability claim
yet, and the PR body implied more. `docs/parity-matrix.md` states it correctly.

### F4 — M — Progress events have no producer (partially fixed)

The contract carried `tool.call`, `tool.result`, `approval.required` but no agent
could emit them, and `file.edit` was missing entirely, so a UI could not render
file changes the way Coderax does.

Fixed: `file.edit` added to the event contract, `sessionId` made available on
`task.started`, and the agent report union now includes `text.replace`,
`tool.call`, `tool.result`, `file.edit` and `approval.required`, all mapped into
the event bus. Native still reports `tools: false` and emits no tool events,
because it has no tools; inventing them would be a false capability claim.

Open: no adapter produces these events yet (see F3).

### F5 — M — Approvals are published, not recorded (open)

`approval.required` is streamed, but the adapter does not create the
corresponding record in `PermissionStore`, so a client cannot approve the exact
resource the agent is waiting on. The permission store is the authority; the event
must reference a record that exists. Wiring this belongs with the real adapter
work (F3).

### F6 — M — No bounded adapter cleanup (open)

Coderax bounds cancellation cleanup at 5 s so a dead transport cannot hold the
task lease indefinitely (`engines/run.ts`, `CLEANUP_TIMEOUT_MS`). This engine's
runner relies on the abort signal alone; a hung `run()` keeps the lease until the
TTL expires. Not a correctness hole — the lease still fences — but it delays
recovery and blocks a retry.

### F7 — M — No prompt construction from the conversation (fixed)

Coderax builds the engine prompt from the stored transcript (`workChat/prompt.ts`);
this engine passed `objective` only, so a follow-up turn had no history and the
Native agent answered each task in isolation.

Fixed: `src/orchestration/transcript.ts` builds history from the stored conversation
— completed `user`/`assistant` turns only, the current objective excluded so it is
not answered twice, oldest turns dropped before the budget, a single oversized newest
turn clipped rather than dropped — and `src/agents/native/prompt.ts` renders it into
every step prompt as `Earlier in this conversation:` ahead of the objective. History
is read from the store on each run, so a resume on another replica sees the same
exchange. Proven by `tests/integration/transcript.test.ts`: the follow-up turn's
prompts contain the first objective and the first answer, the current objective
appears exactly once, and the first turn is unchanged by the feature.

### F8 — L — Event vocabulary gap (fixed)

`file.edit` and a session id were missing. Both added; `openapi.json` is
unchanged because events are not HTTP paths.

### F9 — L — No requested-workspace confinement (open, low risk)

Coderax confines a caller-supplied directory inside the mode root. This engine
derives the directory from the mode root itself, so no caller can request an
arbitrary path — the attack surface is smaller, but a per-task subdirectory is not
supported yet.

### F10 — Info — OpenHands removed deliberately

Coderax exposes `openhands`, but it is `not_configured` by design (no Python
runtime is bundled) and the three-agent model in the brief is Native, OpenCode and
FreeBuff. Removing it is a scope decision, not a regression; it is recorded in the
parity matrix rather than silently dropped.

### F11 — Info — Readiness is configuration admission, not a live probe

Coderax probes `/global/health` before reporting an engine ready. This engine
reports availability from configuration and agent registration; there is no
per-adapter probe. Readiness therefore proves "configured", not "reachable".

## Security review

| Area | Result |
| --- | --- |
| Authentication | Owner bearer token, constant-time comparison, minimum length enforced at startup. No second principal. |
| Authorization | Every task read is owner-scoped; a foreign id returns `not_found`, so existence is not leaked. |
| Secrets | Read from the environment by variable name; never in config, a URL, a log line or an error body. Redaction added (F1). |
| Request bounds | 1 MiB body cap; schema-validated path, query and body. |
| SSRF | The inference endpoint comes from validated configuration, never from a request. |
| Injection | No SQL/NoSQL string interpolation: the Mongo port uses structured filters; SQL is absent. |
| Path traversal | Workspace roots are real-path resolved, must be absolute, must not overlap, and a symlink into the other mode is rejected. |
| Denial of service | Single owner by design; no rate limit. Acceptable for an owner-only service, and documented rather than implied. |
| Event integrity | Per-task sequence, duplicate rejection, bounded replay, explicit truncation signal. |
| Secret in repository | `.env.example` documents names only; CI has a grep gate for committed values. |

## Test evidence at this head

```
npm run build      → 0
node --test        → 60 tests, 60 pass, 0 fail
openapi:check      → matches
```

The count moved from 48 to 60 because this review added redaction tests, the
Mongo lease-table tests, and event-contract coverage. A higher count is not the
argument: the arguments are the findings above, most of which are still open.

## What this review changes about the plan

Phases 4–9 cannot be claimed from this repository alone. In dependency order:

1. Real adapter transports (F3) — without them the engine executes only Native.
2. Persistence for tasks, conversations, memory, events, notifications (F2).
3. Prompt construction from the transcript (F7) — required for continuity.
4. Approval records (F5) and bounded cleanup (F6).
5. Only then client migration, deployment, and removal of the legacy engine.
