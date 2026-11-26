# Coderax WorkflowEngine contributor and agent guidance

This repository is the intelligence and execution platform for Coderax. It owns
durable Work execution, agent orchestration, model routing, permissions, events
and health. It does **not** own any user interface. Coderax (web) and CoderaxCLI
are clients of the API published here.

## Charter

Coderax is a private, owner-controlled personal AI operating system. This
repository is bound by that charter:

- Owner-only access. No signups, memberships, subscriptions, billing or B2B
  surfaces. Exactly one principal exists.
- Maximum additional spending: **$0.00**. No paid models, no paid infrastructure,
  no purchased CI minutes, no trials.
- Substantive compute is cloud-hosted. The owner's PC and WSL never run inference,
  agents, development workloads or databases for this system.
- No public repository visibility and no public-facing endpoint.
- No silent paid routing and no silent substitution between agents.
- No placeholder or mocked capability presented as a working feature.

Where a convention and the charter conflict, raise the conflict in the pull
request instead of choosing silently.

## Branching and pull requests

`main` is the only persistent branch and the target for every pull request. Branch
off `main` with a short-lived feature branch; pass `--base main` explicitly. Never
create `dev`, `canary` or another long-lived integration branch. Delete a feature
branch after its pull request merges.

Development is pull-request-only: never push directly to `main`, never force-push,
and never create duplicate pull requests. Every change reaches `main` through a
reviewed pull request with an independent approval and green required checks at
the exact pushed head. Do not weaken a gate to land work; fix the change.

`.github/MAIN_BRANCH.md` records the platform protection this policy depends on.

## Verification

`npm run verify` is the acceptance gate. It runs:

1. `npm run build` — TypeScript project references across contracts, SDK and engine.
2. `node --test "dist/tests/**/*.test.js"` — unit, contract, integration, security,
   adversarial, architecture and end-to-end suites.
3. `npm run gate` — OpenAPI drift, route registration, SDK compatibility,
   architecture boundaries and single ownership, unreachable modules, dependency
   manifests and lockfile integrity, and package artifact integrity.

The fake MongoDB collection suite is explicitly not live database evidence.
`npm run test:mongo:live` requires `CODERAX_TEST_MONGO_URI` and fails without it.
See `docs/quality-gate.md` for what each control proves and what it does not.

Paste the command and its actual result into the pull request's Testing section. A
component passing its own unit tests is not sufficient: the UI-to-API-to-engine
path is covered by `tests/e2e`, and that is the evidence a merge needs.

A green build is not a typecheck: the build **is** the typecheck here (`tsc -b`
with project references). Do not report a test as passing if it was skipped.

## Contracts are the single source of truth

- Every HTTP operation is declared once in `packages/contracts/src/routes.ts`.
- A handler can only be registered for a declared operation, and only once
  (`src/api/router.ts`). The registry refuses unknown or duplicate registrations.
- Request bodies, path parameters, query parameters and successful responses are
  validated against those schemas. An error response is the shared `Problem` body.
- Execution events are versioned separately (`EVENT_SCHEMA_VERSION`) and carry a
  stable `eventId` plus a per-task `seq`.
- `openapi.json` is generated. Never hand-edit it; run `npm run openapi:write`.
- `packages/sdk` parses every response with the same schemas. Do not add a second
  client contract, a hand-written DTO or a divergent copy of a payload.

Adding an operation means: add the route to the catalogue, register a handler,
extend the SDK if clients need it, regenerate `openapi.json`, and add a contract
test. Removing an operation is a breaking change and needs a version decision.

## Module boundaries

The dependency direction is one-way:

```text
api -> orchestration -> execution | agents | models | persistence | events
packages/sdk -> packages/contracts
```

- `src/api` holds wiring only. A handler validates nothing (the router did), makes
  no decision (the service does) and reaches no repository, adapter or provider.
- `src/orchestration` owns use cases and is the only place that combines a lease,
  a task record, an adapter and an event. No other module starts a run.
- `src/execution` owns ownership and settlement. Fencing is enforced in
  `src/persistence/tasks.ts`, not trusted to callers.
- `src/agents` may not import `src/orchestration`, `src/api` or persistence.
- `src/models` is the only place that decides which model is used. An adapter
  receives an already-resolved model reference.
- Nothing constructs its own collaborators. Receive them by name from the
  composition root (`src/bootstrap`).

## Durable execution rules

These are invariants, not suggestions. Changing them requires a test that fails
without the change.

1. A task's terminal state is written only by the generation that holds its unique
   `runToken`. `updateFenced` refuses a mismatch; never bypass it.
2. Never perform an unfenced terminal write. If ownership was lost, write nothing.
3. A lease renewal failure means the run is superseded: abort, do not settle.
4. A retry never changes engine, and only replays a failure the adapter explicitly
   marked `retryable` with nothing to clean up.
5. Cancellation is a durable flag, because the request may land on another replica.
6. A crashed run becomes `interrupted` and is safe to resume; it never stays
   `running` forever.
7. Events are ordered by the bus. A duplicate or out-of-order event is reported,
   not applied twice.
8. One live run per conversation, enforced by the lease key before task creation.

## Zero-cost and isolation rules

- `allowPaid` is a literal `false`. Do not add a configuration that can enable it.
- Model cost class is verified or reported as `paid`; do not infer `free` from an
  identifier.
- External agents (OpenCode, FreeBuff) are optional, explicitly selected and
  isolated: `memory: none`, `credentials: none`, `conversations: none`. Widening
  that requires an explicit, scoped, owner-approved grant.
- Coderax Native must never depend on FreeBuff or OpenCode to build, start or run.
- Private and cloud workspaces and memory must not overlap. Resolve real paths; do
  not trust a string comparison.

## Security

- Never commit a token, key, private hostname or absolute owner path.
- Read credentials by environment-variable name; never place a value in config,
  a URL, a log line or an error message.
- Error text reaching a client is user-safe: no stack, query, provider payload or
  filesystem path.
- Authentication is constant-time and owner-only. Do not add a second principal
  without an owner decision recorded in an issue.

## Code style

- TypeScript only, strict mode, ESM with explicit `.js` specifiers.
- Prefer flat early returns, pure functions and explicit types. No `any` in
  exported signatures.
- Short, single-word file names; group related modules in a single-word directory.
- Comments explain a non-obvious invariant or a boundary; they do not narrate code.
- Every user-facing failure is a stable code the UI can localize.

## Review

Read the inline review threads themselves; a summary comment omits findings. Fix
what is valid, reject what is obsolete with a reason, and reply on each resolved
thread with the resolving commit. After two actionable rounds, read the subsystem
by invariant instead of patching thread by thread.

A clean review is one completion signal, not the definition of done. Report the
pushed head, what you ran, CI state, the review result at that head, and any check
you could not run.
