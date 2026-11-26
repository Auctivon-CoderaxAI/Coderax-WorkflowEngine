# Migration plan

The split is incremental. Coderax keeps its current engine authoritative until a
replacement capability is independently verified; this repository never writes to
Coderax data during the migration, so there are no dual writers and no second
authoritative engine.

## Status

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Repository creation, architecture audit, dependency map, migration plan | **Done** | This document, `docs/architecture-audit.md`, private repository |
| 2 | Shared contracts, configuration standard, SDK | **Done in this repo** | `packages/contracts`, `packages/sdk`, `openapi.json`, drift gate |
| 3 | Centralized routing, dependency injection, initialization | **Done in this repo** | `src/api/router.ts`, `src/bootstrap`, contract tests |
| 4 | Extract durable execution and Native agent | **Partially done** | Lease store, fencing, heartbeat runner, recovery, Native agent, zero-cost routing are implemented here; the real provider adapters and Mongo lease table are wired at deployment time |
| 5 | Integrate Coderax UI through the new API | **Not started** | Requires PRs #308/#309 to settle |
| 6 | Integrate CoderaxCLI through the same SDK | **Not started** | CLI consumes OpenAPI today; switching it is a small, separate PR |
| 7 | Migrate remaining capabilities, verify parity | **Not started** | Needs the parity matrix below |
| 8 | Cloud deployment and end-to-end validation | **Not started** | `deploy/README.md` |
| 9 | Remove redundant legacy implementations | **Not started** | Only after Phase 7 parity is proven |

Phases 2 and 3 are complete **for this repository**. They are not complete for the
system: Coderax still serves its own routes and its own engine. Saying otherwise
would equate a working engine with a migrated product.

## Phase 4: what is actually extracted

Extracted and reimplemented against explicit ports:

- Adapter contract, agent registry with fail-closed selection and no substitution.
- Single-run arbitration by task key.
- Durable lease with atomic claim, heartbeat renewal, durable cancel flag,
  token-fenced release and bounded prune. The semantics match the verified
  `workRun.ts` implementation, including "takeover only when expired" and "cancel
  an expired lease ⇒ interrupted".
- Unique per-claim fencing token and a task repository that refuses any terminal
  write from a superseded generation.
- Crash visibility: a run that stops heartbeating is retired as `interrupted`, on
  read and at startup.
- Cancellation, resume from checkpoint, and a retry that stays on the same engine.
- Sequenced events with dedupe, out-of-order rejection and bounded replay.
- Workspace confinement by data mode with real-path resolution.

Deliberately **not** extracted yet:

| Item | Why | Owner |
| --- | --- | --- |
| LibreChat native agent internals (tools, MCP, skills, subagents, RAG, code execution) | Large, working, and coupled to `packages/api` state; moving it wholesale would be a rewrite | Phase 7 |
| Real model provider adapters | Needs the verified provider list and secrets at deploy time; the port and a real OpenAI-compatible client exist | Phase 4/8 |
| Mongo lease table | The adapter exists (`adaptMongoWorkRunMethods`); the default here is the in-process table, which is honest but single-process | Phase 8 |
| OpenCode server transport | Needs the pinned `@opencode-ai/sdk` and an operator-run server | Phase 4 |
| FreeBuff SDK transport | Needs a trusted source-built SDK | Phase 4 |
| Cloud browser provider, DeploymentPlatformAI integration, plugins | Browser contract and fail-closed adapter exist; no verified provider yet. DeploymentPlatformAI and plugins are not implemented | Phase 7 |
| Scheduling (cron/schedules) | Still in Coderax and bound to Mongo | Phase 7 |

## Phase 5–6: client integration

1. Publish the engine behind the existing Worker proxy as an additional upstream,
   or as a second path prefix; keep the current backend serving everything else.
2. Add `@coderax/sdk` to Coderax and CoderaxCLI. Both must consume a compatible SDK
   version; the SDK version tracks `CONTRACT_VERSION`.
3. Route Work submission and task status for **new** tasks to the engine. Old tasks
   stay readable through their existing route until Phase 9.
4. Add the blue-dot indicator over the notifications endpoint.
5. Keep Chat on the current path until Phase 7 parity; do not run two engines for
   the same conversation.

**No dual write:** for a given conversation, exactly one system is authoritative at
a time. The switch is per capability, recorded in a PR, and reversible.

## Phase 7: parity matrix

Build this before deleting anything. Minimum rows:

| Capability | Current owner | Replacement | Parity test |
| --- | --- | --- | --- |
| Chat turn + streaming | Coderax | engine `/v1/chat` | Same transcript after reload |
| Work submit/cancel/resume | Coderax engine | engine `/v1/work` | Same terminal state and messages |
| Agent/model selection | Coderax | `/v1/agents`, `/v1/models` | Same visible options and refusals |
| Conversation history | Mongo | engine conversations | No message loss, no reordering |
| Memory | conversation/agent files | engine memory | Mode isolation preserved |
| Schedules | Coderax `croner` | engine scheduler | A scheduled task runs once after a restart |
| Human approval | Coderax approvals | engine permissions | A denied request cannot execute |

## Rollback per phase

| Phase | Rollback |
| --- | --- |
| 2–3 | Revert the contracts/SDK PR. No runtime dependency exists yet. |
| 4 | Do not deploy the engine. Coderax is unchanged, so nothing to undo. |
| 5 | Flip the client flag back to the legacy Work route. New tasks created in the engine remain readable through the engine API; do not delete them. |
| 6 | Revert the CLI release; the previous CLI talks to the legacy deployment. |
| 7 | Revert the capability switch; old and new stores are both read-only-compatible. |
| 8 | Point DNS/proxy back to the existing deployment. The engine database is additive and is not dropped. |
| 9 | Restore the deleted module from the revert commit. Deletions are separate PRs with no schema change in the same commit. |

Every rollback is a reviewed pull request. No rollback deletes data.

## Coordination rules

- Do not modify `client/**`, `worker/**`, `wrangler.jsonc` or
  `packages/api/src/engines/**` in Coderax while PRs #308 or #309 are unresolved.
- Re-check open PRs before starting a Coderax change; the audit snapshot is not
  permanent.
- One capability per PR. Do not combine a contract change, a UI switch and a legacy
  deletion.
- The engine's contract version is bumped for any breaking change, and both clients
  move in the same release train.

## Definition of done for the whole separation

- The engine is private, independently buildable and independently deployable.
- Coderax and CoderaxCLI both talk to it through compatible SDK versions.
- Native intelligence runs without FreeBuff or OpenCode.
- External agents stay optional and isolated.
- Existing conversations, tasks and memory are preserved.
- Route and wiring contracts are automatically verified.
- A Work task survives client disconnection **and** an API restart.
- Deployment works end to end and is verified on its actual origin.
- Required tests and approvals pass, and additional spending is still $0.00.
