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
| Versioned HTTP + event contracts, including the capability handshake | Implemented | `packages/contracts`, `docs/api-v1.1.md` |
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
| Owner-only auth, scoped permissions, private/cloud memory split | Implemented | `src/security`, `src/permissions`, `src/memory` |
| Zero-cost model router (discovery, verification, modes, limits, fallback, health) | Implemented | `src/models/router.ts`, `src/models/providers`, tests |
| Reproducible quality benchmark harness | Implemented; live run requires provider credentials | `benchmarks/`, `scripts/benchmark.ts` |
| Multimodal image input and creative SVG/HTML validation | Implemented; image only, private-mode attachments off by default | `src/media`, `src/creative`, [`docs/multimodal.md`](docs/multimodal.md) |
| Secret redaction of adapter and provider text | Implemented | `src/observability/redact.ts` |
| MongoDB lease table + index bootstrap | Implemented, selected at startup; not live-verified | `src/persistence/mongo.ts`, `src/bootstrap/compose.ts` |
| Coderax Native agent | Implemented | `src/agents/native` |
| External agent adapters (OpenCode, FreeBuff) | Contract + isolation only | `src/agents/adapters/external.ts` |
| Durable lease persistence across replicas | Selected by `persistence.driver=mongo`; startup fails without a reachable collection; not live-verified | `src/bootstrap/compose.ts` |
| Durable artifacts (metadata, versions, content) | Implemented; MongoDB-backed, verified across a real engine restart and two-replica concurrency | `docs/artifacts.md`, `tests/integration/artifacts-durable.test.ts`, `tests/integration/artifacts-concurrency.test.ts` |
| Task, conversation, memory, event and notification persistence | In-memory only | `src/persistence/*` |
| Cloud deployment of this engine | **Not done** | see `deploy/README.md` |
| Migration of Coderax UI and CLI onto this API | **Not done** | see `docs/migration-plan.md` |

Read the table literally. A green test suite here is not a claim that Coderax has
been migrated, that the engine is deployed, or that the external agents work.

`docs/parity-matrix.md` is the authoritative comparison against the engine
Coderax runs today, and `docs/pr-1-review.md` records what is preserved, what is
simplified and what is still missing. `docs/artifacts.md` describes durable
artifact storage, its security boundaries and how durability is verified.

## Quick start

```bash
npm install
npm run build
npm run verify                    # build, reproducible SDK pack, 271 tests, OpenAPI drift gate
npm test                          # tests only: unit, contract, integration, security, e2e
npm run sdk:pack                  # reproducible tarballs + SHA256SUMS in dist-artifacts/
npm run openapi:check             # fails if the published contract drifted
```

Run the engine (it refuses to start until every startup check passes):

```bash
export CODERAX_OWNER_ID=owner
export CODERAX_OWNER_TOKEN="$(openssl rand -hex 32)"
# One or more provider keys. A key authenticates; it does not make a model free.
export OPENROUTER_API_KEY=...
export GEMINI_API_KEY=...
# workspace roots must exist, be absolute and must not overlap
node -e "require('fs').mkdirSync('/srv/coderax/private',{recursive:true});require('fs').mkdirSync('/srv/coderax/cloud',{recursive:true})"
CODERAX_ENGINE_CONFIG=./engine.json npm start
```

`engine.json` carries the non-secret settings; environment variables win over it:

```json
{
  "auth": { "ownerId": "owner" },
  "workspaces": { "privateRoot": "/srv/coderax/private", "cloudRoot": "/srv/coderax/cloud" },
  "models": {
    "route": [{ "providerId": "openrouter", "modelId": "inclusionai/ling-3.2-flash:free" }],
    "attestations": [],
    "policy": [
      {
        "providerId": "openrouter",
        "retention": "transient",
        "training": "prohibited",
        "location": "eu",
        "credentials": "deployment-managed",
        "modes": ["cloud"],
        "grants": [
          { "operation": "chat", "mode": "cloud", "location": "eu" },
          { "operation": "work", "mode": "cloud", "location": "eu" }
        ],
        "evidenceUrl": "https://openrouter.ai/docs/terms",
        "verifiedAt": "2026-11-26T00:00:00.000Z"
      }
    ]
  },
  "engines": { "default": "native" }
}
```

`models.route` is a preference order, not a free claim. The router discovers
models, verifies zero cost from the provider price list or a time-bounded
attestation, and refuses to start Native when no verified-free model is routable.
`models.policy` is a separate requirement: a provider receives no traffic until an
owner-approved record authorizes the exact processing operation and data mode.
Private mode refuses hosted inference without an explicitly approved private
grant, and fails closed rather than using local inference when none exists.
Gemini, Groq and Cerebras publish no machine-readable price and therefore need an
attestation per exact model. See [`docs/model-routing.md`](docs/model-routing.md)
for the verification rules, routing modes, budgets, rate limits, circuits,
fallback, streaming normalization and benchmarks.

The engine binds `127.0.0.1` by default and is never public-facing.

## Architecture

```text
packages/contracts   versioned zod schemas, route catalogue, OpenAPI generator
packages/sdk         typed client; validates every response against contracts
src/bootstrap        composition root, named dependency container, startup gate
src/api              transport-agnostic router, route handlers, Node HTTP server
src/routing          dispatch through the registry (no fallback, no UI logic)
src/orchestration    Work lifecycle: submit, execute, cancel, resume, retry, recover
src/execution        leases, arbitration, heartbeat runner, retry, workspace confinement
src/persistence      task repository (fenced writes), lease tables, conversations
src/agents           registry, Coderax Native, isolated external adapters
src/models           discovery, zero-cost verification, routing, limits, health, benchmarks
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

- **$0**: no paid model is representable (`allowPaid` is a literal `false`); free
  cost is proven from provider pricing or an unexpired exact-model attestation;
  unknown cost is refused; and a reserved request/token budget fails closed.
- **Cloud-only execution**: the engine runs on its host; clients execute nothing.
- **Data-processing policy**: cost, capability, retention, training, location,
  authorization, credential, quota and execution mode are separate eligibility
  dimensions. Private mode never leaves the process without an exact, owner-approved
  private grant, and fallback cannot widen that grant.
- **Owner-only**: one principal, constant-time token comparison, no memberships.
- **No silent substitution**: an unavailable agent is refused, never swapped.
- **No private/cloud bleed**: memory and workspaces are partitioned by data mode.
- **Durable Work**: closing the browser or the CLI never ends an authorized task.
- **Fenced state**: an expired generation can never overwrite a newer one.

## Contributing

[`AGENTS.md`](AGENTS.md) is the contributor and agent policy. `main` is the only
persistent branch; every change reaches it through a reviewed pull request.
[`SECURITY.md`](SECURITY.md) covers the threat model and secret handling.
