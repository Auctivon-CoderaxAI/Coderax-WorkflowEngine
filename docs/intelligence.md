# Coderax Native intelligence

This document describes the intelligence layer added on top of the durable
execution core. It is deliberately narrow: every capability below is wired to a
port, fails closed when its prerequisite is absent, and is covered by a test.

## Model routing

`src/models/router.ts` is the one authoritative router, `src/models/verify.ts` the
one cost verifier and `src/models/budget.ts` the one ledger.
`src/models/catalog.ts` is a thin projection over the router for `/v1/routing`; it
holds no ranking or eligibility logic of its own. Provider adapters report facts
and execute requests; they never decide anything.

A model is admitted only when:

- its own record proves zero cost: a published price list with every billed unit
  at exactly `0`, **or** an attestation for that exact model that names the
  account (`accountRef`), the billing boundary, `currency: "USD"`,
  `spendCapUsd: 0`, a published daily allowance, an HTTPS `evidenceUrl`, and a
  validity window that is current and no longer than 90 days;
- the router-derived `costClass` is `free` **and** the verdict is verified — a
  descriptor that says `free` without evidence is refused;
- it supports the requested operation (chat, work, native reasoning, multi-agent,
  memory, RAG, document, multimodal, MCP, external agent) under the provider
  policy, in the requested data mode;
- the model reports itself available, no retry-after cooldown or open circuit
  blocks it, and its local quota has not been exhausted; and
- the request fits inside the context window with the output ceiling attached.

Unknown pricing is `paid`, not free. A configured route, an administrator's pricing
evidence and a working API key each prove something narrower than free-tier
eligibility: a route is a preference, evidence is an observation, and a key is
authentication. A free allowance that sits behind a billing account which can
charge overage is not free, which is why the spend cap must be exactly zero. When
Native is enabled and no routed model is verified free, composition throws a
`StartupError` naming each refused model and the reason, so the engine cannot start
on an unproven route.

`allowPaid` remains a literal `false`; there is no configuration field that can
enable it. A requested paid or unpriced model is refused with
`paid_model_refused`; an empty verified-free set is `model_missing`; an exhausted
day is `budget_exhausted`. When nothing eligible remains, routing fails closed
rather than trying a wider provider.

Routing modes rank the eligible set (`fast`, `auto`, `complex`), with capability,
context and preference tie-breaks. A model the owner names is pinned; an
automatically chosen model may fall back inside the verified-free set, bounded by
`models.maxFallbacks`, and the task record stores the model that actually served
it so the fallback is auditable rather than invisible.

### Durable budget accounting

The ledger reserves one request slot and the estimated input plus output-ceiling
tokens before dispatch, in a per-owner UTC-day window and a per-task window. The
durable store (`src/persistence/budgets.ts`) admits a request only when a single
conditional `findOneAndUpdate` succeeds, so concurrent replicas cannot both take
the last slot; the updated document is the proof of admission, not a read-then-write
check.

Settlement policy is asymmetric on purpose:

- a call that **may have reached the provider** is charged the reserved amount
  (`release(id, { dispatched: true })`), because a timeout, a broken stream or a
  missing usage report never proves the provider did no work;
- a call that never dispatched is refunded in full;
- settlement and release are idempotent per reservation, so a duplicate report
  cannot double-charge;
- an abandoned reservation expires and is swept by the next admission on that
  window, refunding exactly once;
- actual usage above the estimate is charged as reported, and the window refuses
  further requests once it is over its ceiling.

`src/models/circuit.ts` opens a per-model and per-provider circuit after a bounded
number of consecutive failures and keeps it open for the provider's own
`retry-after` window, clamped locally. A retryable provider failure (HTTP
408/425/429/5xx, timeout, connection reset) falls back to the next approved free
model; authentication, validation, 404/422 and abort failures never fall back,
because retrying them elsewhere would hide the real fault.

Full detail: [`docs/model-routing.md`](model-routing.md). The distributed
guarantees are exercised against a driver fake, not a live replica set.

## Native loop

`src/agents/native/agent.ts` runs plan → act → observe → reflect:

1. **Plan.** A model-assisted plan is requested when `maxSteps > 1`; a malformed
   or failed plan falls back to the deterministic planner. On resume the
   persisted plan is reused, so step ids stay stable.
2. **Act.** The model returns exactly one JSON object:
   `{"tool":"fs.read","input":{...}}` or `{"thought":"…","final":"…"}`. The
   protocol is provider-independent and works on models without native function
   calling. A plain-prose answer is accepted once as a final answer; a malformed
   JSON object gets one repair attempt, then the run fails with `protocol_error`.
3. **Observe.** Every tool result or failure is appended to the step's bounded
   observation list.
4. **Reflect and recover.** A failed tool is shown to the model so it can choose
   another action. A step that exhausts its four actions is summarised from what
   actually happened, never given a fabricated result.

Step and action counts are bounded, provider usage is accumulated across plan and
steps, and cancellation is checked before every model or tool call.

## Tools and permissions

`src/tools/runtime.ts` is the single execution path for built-in, MCP and plugin
tools. It validates input against the tool's schema, then asks the approval gate
for every declared scope against the **exact resource**.

Built-ins:

| Tool | Scope | Approval | Notes |
| --- | --- | --- | --- |
| `fs.read`, `fs.list`, `fs.search` | `workspace.read` | never | symlink-resolved workspace confinement |
| `fs.write` | `workspace.write` | once | bounded content, sha256 receipt |
| `shell.run` | `command.execute` | always | disabled by default; allow-listed commands, no shell |
| `http.fetch` | `network.access` | once | disabled by default; allow-listed hosts, no IP literals or localhost |
| `memory.search` / `memory.write` | `memory.read` / `memory.write` | never / once | owner + data-mode partition |
| `knowledge.search` | `knowledge.read` | never | owner + data-mode partition |

`src/tools/paths.ts` rejects absolute paths, lexical escapes and symlinks that
resolve outside the workspace.

### Durable approval suspension

When a tool needs a decision, the run does not block and does not fail
permanently. The agent emits `approval.required` with the durable request id, the
runner returns `suspended`, and the service writes `awaiting_approval` under the
same generation fence before releasing the lease. The owner decides with
`POST /v1/work/{taskId}/permissions`, then resumes the task. A resume claims a new
generation, reuses the persisted plan and completed steps, and the now-approved
tool runs. If approvals are disabled for the task, the action is denied rather
than auto-approved; a chat turn with no task is likewise denied.

## Retrieval

`src/knowledge/store.ts` chunks documents (paragraph-aware, 1200 characters with
150-character overlap, 500 chunks maximum) and partitions them by owner and data
mode. When `knowledge.embeddingModel` is set and a zero-cost inference endpoint
is configured, chunks and queries are embedded through an OpenAI-compatible
`/embeddings` endpoint and ranked by cosine similarity. Without embeddings,
ranking is lexical (TF-IDF with a phrase bonus) and the response says
`embedding: "lexical"` so a caller cannot mistake it for vector search.

`POST /v1/knowledge`, `GET /v1/knowledge` and `GET /v1/knowledge/search` are
owner-only. Retrieval for a run uses the run's data mode.

## MCP

`src/mcp/client.ts` implements JSON-RPC 2.0 over Streamable HTTP (including SSE
frames) and newline-delimited stdio. Only explicitly configured servers are
contacted. Tools are namespaced `mcp__<server>__<tool>`; HTTP tools require
`network.access`, stdio tools require `command.execute`, and a browser or
computer-use server requires `browser.use` with per-invocation approval. One
unavailable server is reported in health and contributes no tools; it does not
stop the engine. Server text is bounded and never treated as instructions.

A browser/computer-use agent is therefore attachable through a configured MCP
server. No browser server is configured in this repository, so cloud browser
automation is **not live-verified**.

## External agents

`src/agents/adapters/opencode.ts` is a real HTTP/SSE transport for an
already-running OpenCode server: readiness probe, session creation, message
dispatch, streamed text parts, abort and best-effort session deletion. The engine
never spawns or bundles OpenCode, and Coderax Native never depends on it.

The FreeBuff adapter still accepts an injected transport only. There is no
authorized FreeBuff agent endpoint or SDK in this workspace, and inventing one
would be a mocked capability; it is reported as `not_configured` until a real
transport is supplied.

## Remaining gaps

- No plugin manifest loader yet; `GET /v1/tools` lists built-ins and MCP tools.
- No multi-agent workflow DAG with per-step permission scopes. Native runs one
  plan; delegation between agents is not implemented.
- Events and the routing quota ledger are process-local. A restart loses the
  minute/day counters, and cross-replica quota accounting is not shared.
- OpenCode and MCP transports are tested against scripted servers, not a live
  external deployment.
- No schedules, cloud browser server or live MongoDB verification in this change.
