# Deployment

## Current state: not deployed

This repository has **no deployment**. Nothing here is running in production, and
no deployment automation is included yet. The engine has only been exercised
locally by the test suite and a local HTTP server on loopback.

Do not infer deployment from a green build.

## Target architecture

| Component | Target | Cost | State |
| --- | --- | --- | --- |
| Coderax UI | Cloudflare Workers free plan (static assets + `/api` proxy) | $0 | Already deployed by Coderax |
| API ingress | The same Cloudflare Worker, authorized host allowlist, proxy secret | $0 | Already deployed by Coderax |
| Workflow engine | Authorized Oracle Always Free instance (the existing OCI host) | $0 | Not deployed |
| Database | The existing authorized MongoDB deployment | $0 | Available |
| Cloud workloads | DeploymentPlatformAI where verified | $0 | Not wired |
| Cloud browsers | Authorized zero-cost provider over browser protocol v1 | $0 | Contract + fail-closed adapter; no verified provider |
| Inference | Verified zero-cost OpenAI-compatible endpoint | $0 | Configured per deployment |

No Vercel dependency is introduced, no new paid service is used and no trial is
started.

## What must exist before the engine can start

The engine refuses to start until all of these pass, and reports each failure:

1. `CODERAX_OWNER_ID` and a token of at least 32 characters named by
   `CODERAX_OWNER_TOKEN_ENV`.
2. Two absolute, existing, non-overlapping workspace directories
   (`workspaces.privateRoot`, `workspaces.cloudRoot`).
3. A verified zero-cost model route. `models.route` is only a preference order:
   the router must discover at least one currently free model from provider pricing
   or an unexpired exact-model attestation. With no such model, readiness is false
   and startup is blocked — intentionally. A provider credential alone proves
   authentication, never price.
4. At least one registered handler per documented operation (automatic).
5. A heartbeat interval at most one third of the lease TTL (validated).

## Deployment steps (not yet executed)

1. Build on the host: `npm ci && npm run verify`.
2. Place a JSON configuration file containing no secrets (owner id, workspace
   roots, model route, providers by variable name, attestations, engine defaults).
3. Provide `CODERAX_OWNER_TOKEN` and the provider key variables
   (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY` or a
   configured `apiKeyEnv`) through the host's secret mechanism, never the
   repository.
4. Bind loopback and expose the port only to the existing reverse proxy; the engine
   is never public-facing.
5. Point the Worker's `/v1` (or a dedicated engine host) at the engine, keeping the
   current backend as the upstream for every other path.
6. Verify on the actual origin: health, readiness, an authenticated task, an
   unauthorized request, a cancelled task, and a task that completes while no
   client is connected.

## Migration gaps that block a real deployment

- The default lease table is process-local. Cross-replica durability requires the
  Mongo-backed table (`adaptMongoWorkRunMethods` wraps the already-verified
  `createWorkRunMethods`); it is not wired yet.
- Authentication is an owner bearer token. Integrating Coderax's JWT session so the
  web client does not hold a second credential is Phase 5 work.
- No TLS termination, process supervisor unit or backup policy is defined here.
  Those belong to the host configuration and must be recorded before go-live.
- DeploymentPlatformAI integration is not implemented.
- The cloud browser surface is implemented as a versioned contract with a
  fail-closed adapter; no provider is configured or verified, so every browser
  operation is refused. See `docs/browser.md` before claiming it works.

## Zero-cost guardrails

- No paid tier is configured anywhere.
- CI uses the free Actions allowance and must not purchase minutes.
- The daily request and token budget fails closed rather than overrunning a free
  tier.
