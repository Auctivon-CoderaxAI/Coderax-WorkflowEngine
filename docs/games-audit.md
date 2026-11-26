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
| `Coderax` | `origin/main` at `a5d237b0` (PR #307 merged), full `packages/`, `api/`, `client/` trees | `packages/api/src/games/` (`index.ts`, `handlers.ts`, `handlers.spec.ts`), `packages/data-provider/src/games.ts`, `packages/data-schemas*`, `docs/product/CAPABILITY_REGISTRY.md`, open PRs #308–#319 |
| `Coderax-WorkflowEngine` | `main` at `808dfd3`; open PRs #2–#8; branches `feat/durable-artifacts`, `feat/artifact-intelligence`, `feat/durable-events*`, `feat/multimodal-*`, `feat/persistent-records` | `src/`, `packages/contracts`, `packages/sdk`, `tests/`, `docs/`, `.github/workflows/verify.yml` |

At the initial audit there was no game executor in either repository and no
feature branch on `origin` in Coderax. By delivery, WorkflowEngine has several
open, unmerged capability branches (listed above); none of them is on `main`, and
this change does not merge or silently reimplement them. A read-only clone of
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

## Re-audit at delivery (2026-11-26)

`Coderax@a5d237b0` still contains only the studio's first milestone:

- `packages/api/src/games/handlers.ts` exposes capabilities, list, create, get,
  update, delete and spec-save operations.
- `packages/data-provider/src/games.ts` still hard-codes
  `executor: 'unavailable'` with `builds`, `playtests` and `agentSessions` all
  `false`.
- There is no build, preview, export, playtest, session, observation or control
  handler anywhere in `packages/api/src/games/`.
- The only two client-facing capabilities remain CX-32 (Partial) and CX-33
  (Blocked).

`Coderax-WorkflowEngine@main` still has no game code; the game modules are added
by this branch. The following capability work is **open and unmerged**:

| PR / branch | What it owns | State |
| --- | --- | --- |
| #2 `feat/intelligence-core` | native tool loop, zero-cost router, MCP, retrieval, approvals | Open at `c1bcf66e2c6ddc8c71e0ce61efae3de065a2d2a5`, not merged |
| #3 `feat/native-reasoning-planner` | dependency-aware reasoning, verification, escalation | Open at `072c4371ed0190993468660e00fd20cf4827fccd`, not merged; GitHub reported the merge state as unstable |
| #4 `feat/zero-cost-model-router` | provider-independent zero-cost router | Open at `ade0a292258ae2451e0bfe5678a91989798f22b8`, not merged |
| #5 `feat/execution-supervisor` | central supervisor and verified termination | Open at `13d4b4f7796f819e4e58bd18006efc4970929e6e`, not merged |
| #7 `freebuff/5e5de30e8775a8e9225cc0e2` | versioned 1.1.0 API, SDK artifact and HTTP contract harness | Open at `9b4cb5ce4f8688cf232d006028e5e255eda6cb1f`, not merged |
| #8 `feat/native-team-orchestration` | bounded Native team orchestration | Open, not merged |
| `feat/durable-artifacts` | durable artifact service, repository, blobs, quota | Branch, no PR |
| `feat/artifact-intelligence` | artifact intelligence integration | Branch, no PR |
| `feat/durable-events*`, `feat/persistent-records`, `feat/multimodal-*` | durable events, records, multimodal work | Branches, no PR |

### Consolidation decision

The heads above were fetched from the remote and resolved to those exact SHAs.
Merging those branches into this feature branch would duplicate other owners'
work, couple a game change to several unreviewed architectures, and create a
conflict-heavy mega-PR. This change therefore does **not** claim they are
integrated. It binds to what `main` actually contains and leaves narrow,
replaceable seams:

- **Generation and design** use `src/models/catalog.ts` on `main`: one verified
  zero-cost route, `allowPaid: false`, and the daily budget ledger. A model may
  add narrative only; source, levels and rules are deterministic and verified.
- **Execution** uses the existing durable Work task, lease, fencing, heartbeat,
  event and cancellation path as `kind: 'game'`. It does not add an execution
  authority or a fourth agent identity.
- **Artifacts** are owner- and mode-scoped through `src/artifacts/store.ts` and
  the game project store. That is a temporary adapter, not the authoritative
  durable artifact service: replacing it is a mechanical change to the
  `ArtifactStore`/`GameStore` ports once `feat/durable-artifacts` lands. Claiming
  the replacement today would be false because the service is not on `main`.
- **Capabilities** are reported by `GET /v1/games/capabilities` with
  machine-readable status and evidence. There is no capability registry on
  `main` to register into; the report is the seam PR #2 must consume rather than
  a competing registry.
- **Shared API/SDK** is the only contract path: routes are declared once, the SDK
  parses the same schemas, and OpenAPI is generated and drift-checked.

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
| Fixed project/spec revision history | Extended into build history plus exact-spec restore | A revision number alone cannot restore the bytes that were verified |
| Genre vocabulary | Extended with explicit `arcade` and `adventure` | Coderax had no such genres; both now generate and verify like every other genre |

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
- `src/games/browser.ts`: a bounded DOM harness that executes the exact inline
  preview document and its animation loop, so a non-painting preview fails the
  build. It presses the shipped on-screen direction and jump controls, and
  asserts the HUD reports real health, after browser testing found both bugs.
- `docs/evidence/browser/`: the real Chromium acceptance report, method and
  screenshots for the platformer and puzzle.
- `src/games/templates.ts`: self-contained HTML entry, keyboard/mouse/touch
  controls, procedural Web Audio cues, original SVG theme.
- Build history and restore in `src/games/store.ts` and `src/games/studio.ts`,
  with the exact spec snapshot stored beside every verified build.
- `src/artifacts/store.ts`: owner- and mode-scoped artifacts for evidence frames
  and verification documents.
- Routes, SDK methods, OpenAPI, tests and evidence in this repository.

## Real-browser acceptance (new evidence)

The owner-authenticated preview was exercised in cloud Chromium on 2026-11-26.
The platformer and puzzle rendered, accepted keyboard/mouse/touch input, scored,
collided, advanced from level 1 to level 2 and restarted after failure. Measured
values, screenshots and limitations are in `docs/evidence/browser/`. A fresh
anonymous browser context received **403** and the owner context **200**, so the
preview boundary was verified rather than disabled.

The browser run found and drove three fixes that the DOM harness had missed: the
HUD read a non-existent `state.health`, on-screen buttons wrote action names
that `currentInput()` never read, and the exported preview was not actually
playable until every module was inlined. The first two now have regression
coverage in the boot harness. This is still Chromium-only evidence for two
reference builds, not a claim that every genre or browser is verified.

## What stays blocked

- External game environments (third-party or browser-hosted games) are reported
  `blocked` with the exact prerequisite: a verified zero-cost cloud browser plus
  an authorized game-provider interface. The engine will not stream an owner
  device, bypass anti-cheat, or claim a session it cannot isolate. This is
  distinct from the real-browser acceptance of the studio's own exported
  documents: that proves those two builds are playable, not that the Gaming
  Agent can autonomously play external games.
- DeploymentPlatformAI could not be independently verified: its repository
  returned `404` to an unauthenticated request, so it is either private or not
  available at the stated path. Coderax's charter and vision name it as a
  long-term execution platform, and its Oracle Always Free host is documented as
  the existing API host, but neither repository exposes a verified workload
  interface, browser interface, memory/CPU limit, network policy or termination
  contract. No external runtime is claimed on that basis.
- `first_person` camera and two-player specs are reported as unsupported at
  build time. They are not approximated by another camera or by a single-player
  stand-in.

## Verification of this audit's claims

- `tests/unit/games.test.ts` — generation, composition, determinism, isolation,
  measured playability, edits.
- `tests/integration/games.test.ts` — create, build, HTML preview, export, a
  verified session, pause/takeover/input/cancel, build history/restore and
  verified play over HTTP.
- `tests/security/games.test.ts` — owner scoping, traversal refusal and
  disabled-capability reporting.
- `docs/evidence/game-studio/` — rendered frames and the full check list from
  the shipped renderer, regenerated by `npm run game:evidence`.
- `docs/evidence/browser/` and `docs/evidence/mongo/` — real Chromium acceptance
  and a real MongoDB 8.0.4 restart/lease-race run. The game project store itself
  remains file-backed; the Mongo evidence covers the engine's durable Work,
  transcript, notification and lease path, not multi-replica game artifacts.
- `npm run verify` at the delivery head: **128/128 tests**, OpenAPI drift clean.
  No hosted CI run exists at the pushed head because the workflow triggers on a
  pull request or `main` push and no PR could be opened from this environment;
  the local gate is the executed evidence.
