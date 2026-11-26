# Cross-repository audit: Native Game Studio and Native Gaming Agent

Audit date: 2026-11-26.
Scope: `Auctivon-CoderaxAI/Coderax` and `Auctivon-CoderaxAI/Coderax-WorkflowEngine`.

This audit was performed before any game code was written in WorkflowEngine, so
that working implementations could be recovered instead of re-invented. The
finding is that neither repository contained a game build executor or a game
session runtime. Coderax contains the first milestone of the studio, and both
capabilities are recorded as partial or blocked in its own capability registry.

## What was inspected

| Repository | Refs inspected | Surfaces |
| --- | --- | --- |
| `Coderax` | `origin/main` (the only remote branch), full `packages/`, `api/`, `client/` trees | `packages/api/src/games/`, `packages/data-provider/src/games.ts`, `packages/data-schemas*`, `api/server/routes/games.js`, `client/src/components/Games/`, `docs/product/CAPABILITY_REGISTRY.md` |
| `Coderax-WorkflowEngine` | `main` at the start of this work | `src/`, `packages/contracts`, `packages/sdk`, `tests/`, `docs/` |

No feature branch existed on `origin` in either repository. A read-only clone of
Coderax was used for the audit and is not part of this repository's deliverable.

## Findings in Coderax

### Game Studio (CX-32, recorded Partial)

- `packages/api/src/games/handlers.ts` implements an owner-gated project
  lifecycle: create, list, read, save a design brief, and a generation gate.
- `packages/data-provider/src/games.ts` defines `GAME_CAPABILITIES` with every
  build capability hard-coded `false`; the client renders build, playtest and
  agent tabs as unavailable.
- The UI has `/games`, `/games/new`, `/games/templates` and `/games/:gameId`,
  but the template screen offers fixed canvas templates rather than generated
  games.
- The registry requirement for CX-32 is explicit: "Queue one real build in a
  verified cloud executor and retain the artifact at a recorded SHA". No such
  executor or artifact exists in the repository.

### Gaming Agent (CX-33, recorded Blocked)

- The workspace agent tab is an honest unavailable state.
- There is no game-input environment, session adapter, observation channel,
  bounded control surface, takeover path or stop path.
- The registry requirement is to verify a permitted environment, bounded input,
  takeover and stop before claiming a session.

### DeploymentPlatformAI

DeploymentPlatformAI appears in Coderax documentation as a deployment executor
reference. The only runtime binding is a read-only CyVox status proxy
(`packages/api/src/cyvox/addon.ts`), which is not a workload API and not a
browser interface. Nothing in either repository independently verifies a
workload or browser interface, so no external game environment can be claimed.

## Findings in WorkflowEngine

At the start of the work there was no game contract, no game route, no game
module, no game task kind and no session concept. The multimodal session's report
that WorkflowEngine had no implementation is correct. That does not make the
capabilities absent from Coderax; the audit above establishes what does exist
there.

## Migration decisions

| Coderax element | Decision | Reason |
| --- | --- | --- |
| Owner-gated project lifecycle and persistence | Migrated as a file-backed, owner-scoped `GameProject` store in the engine | The pattern is sound; the storage moves to the authoritative engine |
| Revision-gated spec save and build admission | Migrated as `specRevision`/`expectedSpecRevision` with `conflict` on drift | Prevents a build from silently using a newer spec |
| Design brief / editable spec | Migrated and extended into a validated `GameSpec` plus a derived `GameDesignPlan` | The brief is the input to generation; the plan is the reviewable design |
| Honest unavailable states | Migrated as the machine-readable capability registry with `blocked`/`unsupported` rows | A capability claim must be checkable, not a doc sentence |
| Fixed canvas template gallery | Not migrated | The requirement is generated code, not a choice of three canvases |
| Any build/playtest/agent executor | Did not exist to migrate | The previous capability gates were false; inventing an executor would be fabrication |
| Browser-hosted game session | Not migrated (blocked) | No verified cloud browser or provider interface exists at zero cost |

## What was newly built, and where

- `packages/contracts/src/games.ts`: spec, plan, build, verification, project,
  session, observation, control and capability contracts.
- `src/games/`: deterministic spec reader, design planner, seeded level
  generator, source/asset generator, V8-isolated runtime loader, deterministic
  play policy, verification harness, project store, studio service, session
  service, capability report.
- `src/orchestration/service.ts`: the gaming workload runs through the existing
  lease, fencing, runner, event and cancellation path as a `kind: 'game'` Work
  task; it is not a fourth agent identity.
- `src/games/session.ts`: session creation writes a scoped `command.execute`
  grant for `game-session:<id>` before the task is enqueued.
- `src/artifacts/store.ts`: owner- and mode-scoped artifacts for evidence frames
  and verification documents.
- Routes, SDK methods, OpenAPI, tests and evidence in this repository.

## What stays blocked

- External game environments (third-party or browser-hosted games) are reported
  `blocked` with the exact prerequisite: a verified zero-cost cloud browser plus
  an authorized game-provider interface. The engine will not stream an owner
  device, bypass anti-cheat, or claim a session it cannot isolate.
- `first_person` camera and two-player specs are reported as unsupported at
  build time. They are not approximated by another camera or by a single-player
  stand-in.

## Verification of this audit's claims

- `tests/unit/games.test.ts` — generation, composition, determinism, isolation,
  measured playability, edits.
- `tests/integration/games.test.ts` — create, build, HTML preview, export, a
  verified session, and pause/takeover/input/cancel.
- `tests/security/games.test.ts` — owner scoping and disabled-capability
  reporting.
- `docs/evidence/game-studio/` — rendered frames and the full check list from
  the shipped renderer, regenerated by `npm run game:evidence`.
