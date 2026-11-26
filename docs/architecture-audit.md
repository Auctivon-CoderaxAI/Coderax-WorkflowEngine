# Coderax architecture audit (Phase 1)

Date: 2026-11-26
Method: cloned the private repositories, read the engine, persistence, worker,
CLI and policy files, and listed open pull requests. No file was modified in
either existing repository.

| Repository | Visibility | Default branch | Audited head | Language |
| --- | --- | --- | --- | --- |
| `Auctivon-CoderaxAI/Coderax` | private | `main` | `a5d237b0` | TypeScript |
| `Auctivon-CoderaxAI/CoderaxCLI` | private | `main` | `1b7c8e0` | JavaScript (Node 24, stdlib only) |
| `Auctivon-CoderaxAI/Coderax-WorkflowEngine` | private | `main` | created 2026-11-26 | TypeScript |

The CLI repository is named **`CoderaxCLI`**, without a hyphen. Its own README
still links to `Auctivon-CoderaxAI/Coderax-CLI`; that is a documentation defect in
the CLI repository, not a second repository. No duplicate repository was created.

## 1. What Coderax actually is

Coderax is a LibreChat-derived npm-workspaces monorepo. The layering is:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Legacy HTTP wiring | `api/` (CommonJS) | Express app, route registration, call into TypeScript modules |
| Backend behavior | `packages/api` (TypeScript) | engines, agents, tools, auth helpers, proxy, cloud mode |
| Database methods | `packages/data-schemas` | Mongoose models and shared methods, including Work run leases |
| Shared API types | `packages/data-provider` | config schema, endpoint keys, client/backend shared types |
| Web client | `client/` (React) | Chat, Work, sidebar, settings, execution progress |
| Shared UI primitives | `packages/client` | design system used by `client` |
| Edge | `worker/index.mjs` + `wrangler.jsonc` | Cloudflare Worker: static assets plus an `/api` proxy to the OCI backend |
| Desktop | `desktop/` | packaged Windows shell (private releases) |

`AGENTS.md` already states the intended boundary: behavior belongs in
`packages/api`, `/api` holds wiring only, and database contracts belong in
`packages/data-schemas`. That convention is the main reason this extraction is
tractable without a rewrite.

## 2. Existing workflow engine inventory

The engine is **already isolated** inside `packages/api/src/engines`. This was the
most important finding: the separation is a packaging and ownership problem, not a
greenfield build.

| Concern | Verified location | Behavior found |
| --- | --- | --- |
| Adapter contract | `engines/types.ts` | `EngineId = opencode \| openhands \| freebuff`; normalized events (`started`, `text_delta`, `text_replace`, `tool_call`, `tool_result`, `file_edit`, `approval_required`, `usage`, `completed`, `failed`, `cancelled`); typed failures with `retryable` and optional `cleanup` |
| Selection | `engines/registry.ts` | Fail-closed selection; a disabled/unavailable engine is refused, never replaced; `snapshot(forStart)` separates configuration admission from runtime readiness |
| Single-run arbitration | `engines/arbiter.ts` | A task key is owned by at most one engine; a second engine receives `busy` |
| Shared settlement | `engines/run.ts` | One settlement per run; timeout, cancellation and stream loss settle once; a stream that ends without a terminal event is a `protocol_error`, never a success |
| Workspace confinement | `engines/workspace.ts` | Real-path resolution; private and cloud roots must not overlap; symlink escape rejected |
| Bounded retry | `engines/retry.ts` | Same-engine only; requires an explicit pre-dispatch `retryable` flag and no pending cleanup; bounded attempts and delay |
| Configuration service | `engines/service.ts` | Reads the `engines` block; loads an SDK only when enabled; produces user-safe status without paths or credentials |
| Work ingress (external engines) | `engines/workChat.ts`, `engines/workChat/*` | Owner-only `POST /api/work/chat` branch; per-run directory under the cloud root; refuses non-owner, saved agent, regenerate/compact and added conversations; no fallback to Native |
| Durable leases (client side) | `engines/workChat/leases.ts` | 30 s TTL, 24 h retention, 100-row sweep bound; claim/renew/release/cancel/read/prune over a store port |
| Durable leases (storage) | `packages/data-schemas/src/methods/workRun.ts` | Unique `key` index; claim via upsert on `expiresAt <= now`; renewal fenced by `token` and live expiry; cancellation as a durable flag; expired-lease retirement; bounded prune with re-check |
| Conversation persistence | `engines/workChat/persistence.ts` | Saves Work conversation state and messages; supports `fenceWorkRun` so a superseded run's conversation write matches nothing |
| External adapters | `engines/opencode/`, `engines/openhands/`, `engines/freebuff/` | OpenCode attaches to an operator-run `opencode serve` over the official SDK; OpenHands is a remote Python Agent Server and is disabled; FreeBuff needs a source-built SDK and loopback provider |
| Inference path | `packages/api/src/cloud/*`, `docs/free-inference-routing.md` | Zero-cost routing rules, explicit Groq free-tier attestation and local daily budgets, private/cloud mode denial, secret redaction |
| Engine read route | `GET /api/work/engines` | Availability and reason per engine; no paths or credentials |
| Cancellation | `/api/work/tasks/:id/cancel` | Cancels the live engine run scoped to user and tenant |

Also present, and **not** to be moved blindly: LibreChat's native agent
(`packages/api/src/agents/*`), MCP integration, tools, skills, subagents, file and
code execution, RAG, and the multi-provider model catalogue. The extraction must
consume these through interfaces rather than copy them.

## 3. API surface and route registration

- Registration is split: CommonJS Express files under `api/server/routes/**`
  require TypeScript handlers from `packages/api`; the TypeScript side registers
  Work engine routes (`/api/work/engines`, `/api/work/chat`, cancel, identities).
- The deployment publishes an OpenAPI 3.x document with Swagger UI; the CLI depends
  on it (`openapi`, `agents`, `models`, `call`).
- Edge routing: `worker/index.mjs` serves `client/dist` with SPA fallback and
  forwards `/api`, `/oauth`, `/health`, `/livez`, `/readyz` to
  `CODERAX_API_ORIGIN` with a proxy secret. Without a usable origin it answers 503
  instead of serving HTML — correct fail-closed behavior.
- `wrangler deploy` deletes undeclared plain-text variables; PR #309 adds
  `keep_vars` and a config gate. This is why the proxy origin kept disappearing.

**Assessment:** there is one route registration mechanism per layer, but no shared
typed contract between the engine's HTTP surface and its clients. The CLI discovers
routes at runtime, which is robust, while the web client uses typed helpers in
`packages/data-provider`. Those are two descriptions of one surface and they can
drift today.

## 4. Authentication and authorization

- Session auth is JWT-based (`packages/api/src/auth`); a burst-cached user document
  backs `req.user`, so user mutations must invalidate that cache.
- Work engine ingress requires the owner/admin role, refuses a non-owner with 403,
  and scopes run directories by tenant, user and conversation hash.
- The Worker proxy adds a shared secret header; the backend requires it.
- There are no memberships or customer tenants; the product is owner-only by
  design, even though LibreChat's plumbing still contains tenant fields.

## 5. Database contracts and persistence

- MongoDB via Mongoose. Conversations and messages are the durable record.
- Work run leases are a separate collection with a unique key index; the row
  outlives its lease for 24 h so a crashed run can still be reported as failed.
- Redis is optional and used for resumable streams across replicas.
- Legacy code leaks Mongoose types (`FilterQuery`, `Types.ObjectId`) into exported
  signatures in places; `AGENTS.md` already asks to stop widening that.

## 6. Memory

Memory and context live in the conversation/message store plus per-agent files and
workspaces. There is no standalone memory service and no memory API. The
private/cloud boundary is enforced in `packages/api/src/cloud/mode.ts` with an
explicit single-use export approval bound to a content hash.

## 7. Event streaming

- Chat and Work stream over SSE from Express routes; the client consumes
  `created` / text / `final` frames.
- External engine runs stream normalized engine events through the same handler.
- Resumable streams use Redis when enabled.
- There is no versioned event envelope and no per-event sequence number, so
  duplicate or out-of-order delivery cannot be detected by a client today.

## 8. Task scheduling and cloud execution

- Work runs are request-scoped: the run lives in the API process that accepted it.
  The lease makes a crash visible and restart-safe, but execution is still bound to
  an HTTP request's lifetime and to the web application process.
- `croner` schedules in-process schedules; `schedules` are stored in Mongo.
- Cloud workload execution is DeploymentPlatformAI where verified; the OCI Compose
  stack runs the API, the OpenCode server (unprivileged, read-only root, no
  published port) and MongoDB.

**This is the single most important gap for the stated objective:** a task does not
yet outlive the client *by construction*; it survives because the run continues in
the same process after the response closes. Moving execution into this engine makes
that guarantee structural.

## 9. CLI

`CoderaxCLI` is a Node 24, dependency-free client: `config`, `login`, `status`,
`chat`, `work`, `agents`, `models`, `health`, `openapi`, `call`, `products`,
`cloud`, `projects`, `doctor`. It:

- enforces HTTPS except on loopback, refuses redirects, keeps no cookie jar;
- redacts the token from every output path, including a streaming redactor that
  holds back a token split across SSE deltas;
- discovers routes from the deployment's OpenAPI document rather than hardcoding
  them;
- maps failures to stable codes and exit codes (`2` usage, `3` auth, `4` network,
  `5` not found, `6` unavailable, `130` cancelled).

It contains no model router, no memory store and no workflow runtime, which already
satisfies the "lightweight client" requirement.

## 10. Duplication and risk register

| Risk | Evidence | Consequence |
| --- | --- | --- |
| Two descriptions of one API surface | OpenAPI document + `packages/data-provider` typed helpers | Client drift |
| Engine coupled to the web app | Engine run needs Express request scope, MongoDB methods and JWT | Cannot run or scale independently; a UI deploy can break execution |
| Execution bound to a request process | Work ingress is an Express route | A crash or deploy can strand a run (mitigated, not eliminated, by leases) |
| No event sequencing | SSE frames have no id or sequence | Duplicate/out-of-order frames are silently applied |
| Two `zod` majors | `packages/api` uses `zod ^3`, root/`client` use `zod ^4` | Schema behavior differs between layers during migration |
| Legacy CJS boundary | `api/` still holds wiring and some behavior | Behavior can be added in the wrong layer |
| Free-inference claims | Model "free" is partly inferred from catalog flags | A silently paid route is possible if a provider changes |
| Hosted CI blocked | GitHub Actions blocked before job steps (issue #141) | Local `npm run verify` is the only acceptance evidence |
| FreeBuff/OpenHands not turnkey | Need a source-built SDK / a Python Agent Server | Cannot be claimed as working capabilities |

## 11. Circular dependencies

Coderax runs a "Circular dependencies" static check (visible in PR #309's gate
output) and it passes on `main`. No new cycle is introduced by this repository: its
dependency direction is one-way and documented in `AGENTS.md`.

## 12. Broken or incomplete integrations found

- Hosted GitHub Actions cannot start jobs on Coderax (account billing restriction).
- The swarm coordination layer was removed on 2026-11-20 because no runtime
  constructed it; there is no swarm runtime.
- OpenHands returns `not_configured` by design: no Python runtime is bundled.
- FreeBuff requires a source-built SDK and a loopback OpenAI-compatible endpoint;
  the published npm SDK is rejected when it lacks the required exports.
- `wrangler` deleted the dashboard-set `CODERAX_API_ORIGIN`, producing 503s; PR
  #309 addresses it.
- Multi-agent certification is incomplete (`docs/MULTI_AGENT_CERTIFICATION.md`).

## 13. Active pull requests and coordination

| PR | Title | Overlapping area | Coordination decision |
| --- | --- | --- | --- |
| #308 | Revert "fix(ui): open schedule types from the Scheduled rail" | Sidebar, schedule launcher, Work welcome copy | Do not touch the client or sidebar |
| #309 | fix(cloudflare): keep dashboard variables across deploys | `wrangler.jsonc`, `worker/index.mjs`, `packages/api/src/engines/opencode/adapter.ts` | Do not touch the Worker or the engine adapters |

Both were open at audit time. Phase 1–3 work therefore happens **only** in the new
repository, and Coderax is unmodified. Nothing in this repository writes to Coderax
data, so there is no dual-write and no competing authoritative engine.

## 14. Dependency map

```text
Client (React) ──HTTP/SSE──┐
CoderaxCLI ─────HTTP/SSE──┤
                          v
            Cloudflare Worker (static + /api proxy)
                          │  x-coderax-proxy-secret
                          v
            Express wiring (api/) ──► packages/api (TypeScript)
                                          ├── engines/  (adapter contract, registry,
                                          │              arbiter, run pump, leases,
                                          │              workspace confinement)
                                          ├── agents/   (native agent, tools, MCP)
                                          ├── cloud/    (mode isolation, redaction,
                                          │              Groq free-tier path)
                                          └── auth/     (JWT, owner role)
                                          │
                                          v
                        packages/data-schemas ──► MongoDB
                                          └──────► Redis (optional streams)
```

Target dependency direction (this repository):

```text
Coderax (web) ─┐
CoderaxCLI ────┴──► @coderax/sdk ──► @coderax/contracts
                                          ▲
                                          │ generated
                              Coderax-WorkflowEngine
                                api ─► orchestration ─► execution
                                                   ├─► agents
                                                   ├─► models
                                                   ├─► persistence
                                                   └─► events
```
