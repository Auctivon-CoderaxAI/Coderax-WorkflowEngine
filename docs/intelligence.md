# Coderax Native intelligence

This document describes the intelligence layer added on top of the durable
execution core. It is deliberately narrow: every capability below is wired to a
port, fails closed when its prerequisite is absent, and is covered by a test.

## Model routing

`src/models/router.ts` is the only module that decides which model serves a
request, and `src/models/eligibility.ts` is the only module that decides whether
a model is free. A model is admitted only when:

- its own record proves zero cost: an HTTPS `terms.source`, an `observedAt` that
  is not in the future, an `expiresAt` that has not passed within a 90-day
  window, currency `USD`, and every billed unit (input, output and per call) at
  exactly `0`;
- the router-derived `costClass` is `free` **and** the verdict is verified — a
  descriptor that says `free` without evidence is refused;
- the model reports itself available;
- no provider retry-after cooldown and no open circuit blocks it; and
- its local request and token quota has not been exhausted.

Unknown pricing is `paid`, not free. A configured route, a working API key or a
reachable endpoint proves authentication only. When Native is enabled and no
routed model has verified terms, composition throws a `StartupError` naming each
refused model and the reason, so the engine cannot start on an unproven route.

`allowPaid` remains a literal `false`; there is no configuration field that can
enable it. A requested paid or unpriced model is refused with
`paid_model_refused`, and an unknown or exhausted model with `model_missing`.
When nothing eligible remains, routing fails closed with
`No verified zero-cost model is available…` rather than trying a wider provider.

Routing modes rank the eligible set:

| Mode | Weights (coding / reasoning / speed) |
| --- | --- |
| `auto` | 0.35 / 0.35 / 0.30 |
| `fast` | 0.20 / 0.10 / 0.70 |
| `complex` | 0.40 / 0.45 / 0.15 |

A tool-capable model receives a 0.02 tie-break bonus, then context length, then
the model key break ties deterministically. `GET /v1/routing` reports the ranked
route and each provider's recorded evidence, quota and local usage.

Budget reservations are durable. `src/models/budget.ts` reserves one request and
the estimated input tokens before a call is dispatched, and
`src/persistence/budgets.ts` implements the window atomically — a conditional
`findOneAndUpdate` with `$inc`, so two replicas racing for the last slot cannot
both win. A settlement replaces the reservation with the usage the provider reported. A
call that failed after dispatch keeps its reservation as a conservative input
charge, because a timeout or 5xx is not proof that the provider spent nothing;
only an attempt that was never dispatched is released. Input accounting includes
the system prompt, the user prompt and the serialized tool catalogue
(`src/models/tokens.ts`); a provider that reports no usage is still charged the
estimate, and a streamed completion folds its usage frames before settlement.
The owner's daily request/token window is durable in MongoDB and therefore shared
across replicas; per-provider minute/day counters remain process-local and are a
discovery aid, not the spend ceiling.

`src/models/circuit.ts` opens a per-model and per-provider circuit after a
bounded number of consecutive failures and keeps it open for the provider's own
`retry-after` window, clamped locally. `src/models/routed.ts` implements the
gateway over the router. A retryable
provider failure (HTTP 408/425/429/5xx, timeout, connection reset) falls back to
the next approved free model, bounded by `models.maxFallbacks`. Authentication,
validation, 404/422 and abort failures never fall back, because retrying them
elsewhere would hide the real fault.

## Native loop

`src/agents/native/agent.ts` runs plan → act → observe → reflect:

1. **Plan.** A model-assisted plan is requested when `maxSteps > 1`; a malformed
   or failed plan falls back to the deterministic planner. On resume the
   persisted plan is reused, so step ids stay stable.
2. **Act.** When the model's evidence records tool support and the gateway can
   send tool definitions, Native uses native function calling. It verifies that
   support on the wire: a provider that rejects `tools` is answered through the
   JSON action protocol, which is an explicitly supported compatibility mode.
   Without native tools the model returns exactly one JSON object:
   `{"tool":"fs.read","input":{...}}` or `{"thought":"…","final":"…"}`. A
   plain-prose answer is accepted once; a malformed JSON object gets one repair
   attempt, then the run fails with `protocol_error`.
3. **Observe.** Every tool result or failure is appended to the step's bounded
   observation list.
4. **Reflect and recover.** A failed tool is shown to the model so it can choose
   another action. A step that exhausts its four actions is summarised from what
   actually happened, never given a fabricated result.

Plans are dependency graphs, not ordered titles: `dependsOn` is validated for
unknown ids, duplicates and cycles, and a step whose prerequisites have not
completed is blocked rather than run early. The whole graph is persisted before
the first step, and completed results are fed back into later prompts. The engine
verifies completion against that durable plan; a run that skipped a planned step
fails with `verification_failed` instead of trusting the model's summary.

Step, action, wall-clock and per-task token/request ceilings are all bounded;
an identical repeated action is refused rather than looped. Every dispatched tool
call is recorded before the effect and settled after it, so a resume never
replays an unknown effect. Provider usage is accumulated across plan and steps,
and cancellation is checked before every model or tool call.

## Tools and permissions

`src/tools/runtime.ts` is the single execution path for built-in, MCP and plugin
tools. It validates input against the tool's schema, then asks the approval gate
for every declared scope against the **exact resource**. An approval is bound to
the execution slot (`callId`), the validated arguments and the policy; it is
single-use, so it cannot be replayed or widened to another resource. The Native
system prompt frames tool output, retrieved text and history as untrusted data;
none of it can grant a permission, add a tool or change the plan.

Built-ins:

| Tool | Scope | Approval | Notes |
| --- | --- | --- | --- |
| `fs.read`, `fs.list`, `fs.search` | `workspace.read` | never | symlink-resolved workspace confinement |
| `fs.write` | `workspace.write` | once | bounded content, sha256 receipt |
| `shell.run` | `command.execute` | always | disabled by default; allow-listed bare commands, argument validation, no shell |
| `http.fetch` | `network.access` | once | disabled by default; HTTPS, allow-listed hosts, pinned addresses, no redirects followed implicitly |
| `memory.search` / `memory.write` | `memory.read` / `memory.write` | never / once | owner + data-mode partition |
| `knowledge.search` | `knowledge.read` | never | owner + data-mode partition |

`src/tools/paths.ts` rejects absolute paths, lexical escapes and symlinks that
resolve outside the workspace. `src/security/shell.ts` rejects dispatch-only
commands, code-runner flags and host/parent paths before anything starts, and
`src/security/network.ts` resolves and pins public addresses, blocks loopback and
private ranges, and re-authorizes every redirect hop. Plaintext loopback is a
local-development option and is off by default.

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
mode. When `knowledge.embeddingModel` is set, `knowledge.embeddingVerifiedFree`
is explicitly recorded and a zero-cost HTTPS inference endpoint is configured,
chunks and queries are embedded through an OpenAI-compatible
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

Only owner-configured servers are attached. stdio is opt-in (`mcp.allowStdio`),
plugin-contributed servers execute only when named in `mcp.approvedServers`, and
a server destination is checked against the same SSRF policy as `http.fetch`;
responses are size-bounded. A browser/computer-use agent is therefore attachable
through a configured MCP server. No browser server is configured in this
repository, so cloud browser automation is **not live-verified**.

## Plugins

`src/plugins/manifest.ts` loads data-only `plugin.json` manifests from an
opt-in directory. A manifest may declare a name, version, description and MCP
servers; it cannot load code or add a tool implementation. Plugin MCP servers
may forward only `CODERAX_MCP_*` environment variables and are not approved by
being installed.

## Execution receipts

A terminal task carries an `ExecutionReceipt` built from the engine's plan,
completed steps and dispatched tool ledger, never from model text. It records
the generation, model, terminal state, usage, request count, per-step state and a
digest of the plan; tool arguments are represented by a digest. The receipt is
exposed on task status and covered by the published contract.

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

- No bounded multi-agent delegation. Native executes one dependency-aware plan;
  an agent cannot spawn another agent with its own task and permission scope.
- Per-provider minute/day counters in the router are process-local; the durable
  owner budget is the cross-replica spend ceiling, not a distributed provider quota.
- Schedules, live cloud browser, multimodal transport and a FreeBuff transport
  remain unimplemented or injection-only.
- OpenCode, MCP and MongoDB paths are tested against scripted/fake servers, not a
  live external deployment.
- No schedules, cloud browser server or multimodal model transport in this change.
