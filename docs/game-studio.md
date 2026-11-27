# Native Game Studio and Native Gaming Agent

Two distinct capabilities under Coderax Native, behind the same capability
registry, model router, permission system, artifact service and execution
supervisor as every other engine capability.

- **Native Game Studio** turns a natural-language brief into an original,
  playable, verified game project with exportable source.
- **Native Gaming Agent** plays a verified studio build in an isolated cloud
  runtime, with observed state, bounded controls, pause/resume, owner takeover,
  cancellation, session memory, logs and measured completion.

Neither capability runs on the owner's computer. Builds, verification frames and
sessions are produced by the engine; the browser only receives HTML, JSON or a
frame.

## Capability status

`GET /v1/games/capabilities` is the authoritative, machine-readable report:

| Capability | Status | Boundary |
| --- | --- | --- |
| `native.game-studio` | operational | Generation, verification and export execute in the engine |
| `native.game-studio.browser` | degraded | Two reference builds passed real Chromium acceptance; not a per-build browser guarantee |
| `native.game-studio.ai-assisted` | **blocked** | No executed model-assisted build; a configured route or test narrative alone is not participation |
| `native.gaming-agent` | operational | Sessions run in the engine's in-process V8 context (`isolation: in-process-v8-context`) |
| `native.gaming-agent.browser` | **blocked** | The browser acceptance controller is test code, not an integrated cloud-browser agent runtime |
| `native.gaming-agent.external` | **blocked** | No verified zero-cost cloud browser and no independently verified DeploymentPlatformAI workload/browser interface |

The external row is a deliberate block, not a stub. The engine will not stream
an owner device, bypass anti-cheat or provider access controls, or report a
session it cannot isolate. When a zero-cost cloud browser and an authorized
provider interface are verified, that row is where the capability becomes
operational.

## Studio pipeline

1. **Specify** — `POST /v1/games` interprets the prompt deterministically into a
   validated `GameSpec`. Explicit genre, camera, mechanic, level-count and seed
   words map to fields; the model router is not required.
2. **Plan** — the spec is expanded into a `GameDesignPlan`: title, logline,
   pillars, mechanic purposes and systems, level arc, controls, scoring, palette
   and generated-original assets. If a verified zero-cost model is configured,
   it may add narrative only; its output is schema-validated and any failure
   falls back to the deterministic plan.
3. **Generate** — `POST /v1/games/{gameId}/build` generates original HTML, JS,
   JSON, SVG and a README. No canvas template is selected and no third-party art
   is copied; every asset is generated SVG or a palette colour, and audio cues
   are synthesized by the generated Web Audio module rather than downloaded.
4. **Verify** — the generated code is loaded into a V8 context with no
   `require`, `process`, `fetch` or filesystem access and is played by a
   deterministic bot. The exact preview document is also booted through its
   inlined scripts and `requestAnimationFrame` loop in a bounded DOM harness, so
   a preview that cannot paint is a failed build. The harness also shrinks the
   canvas box to emulate a wrapped HUD and requires the bitmap to track it, at
   the configured device scale, so a canvas sized once at boot does not pass.
   Playability is measured, not asserted.
5. **Preview and export** — `GET /preview` returns one self-contained HTML
   document: every generated module is inlined, so the CSP permits it and the
   endpoint needs to serve no other file. `GET /export` returns a deterministic
   ZIP archive whose `index.html` is the same document and whose `src/` tree is
   the readable source.
6. **Version, restore and continue** — `GET /v1/games/{gameId}/builds` lists
   the owner's build history. `POST /v1/games/{gameId}/builds/{buildId}/restore`
   restores a verified build together with the exact spec snapshot it was built
   from, so a later edit can be rolled back without rebuilding different bytes.
   Every build stays downloadable and every project remains retrievable across
   engine restarts and devices.

Edits go through `POST /v1/games/{gameId}/iterate`. A supported instruction
changes the spec (difficulty, level count, mechanics, genre, camera, reseed,
art direction), the project rebuilds at the new revision, and verification runs
again. An unrecognised instruction is refused with the supported list instead of
silently rebuilding a different game. Debug attempts are bounded and recorded.

### Composition, not templates

The generator composes a game from independent axes:

- **Genres (8):** `platformer`, `puzzle`, `shooter`, `arcade`, `strategy`,
  `role_playing`, `adventure`, `other`.
- **Movement models:** `platformer`, `top_down`.
- **Cameras:** `side_view`, `top_down`, `isometric`, `ui_only`.
- **Mechanics (12):** `gravity`, `jump`, `double_jump`, `dash`, `shoot`,
  `enemies`, `hazards`, `collectibles`, `moving_platforms`, `push_blocks`,
  `switches`, `timer`.
- **Levels:** 1–8, seeded geometry constrained by the shipped physics, with
  collision, scoring, input and a level arc.
- **Presentation:** keyboard, mouse/touch buttons, a generated palette, an
  original SVG theme and synthesized Web Audio cues; no third-party asset.

`first_person` and two-player specs are rejected at build admission with named
errors. They are not mapped onto a supported camera or a single-player stand-in.

### Verification checks

Every build must pass all checks that apply to its mechanics:

| Area | Checks |
| --- | --- |
| Code | scripts compile; no ambient authority, randomness or clock; CSP present and permits the inlined scripts; assets original |
| Browser entry | every module is inlined; the exact document boots and paints frames through its animation loop |
| Audio | cues are synthesized by the build; the manifest records procedural audio; no audio file is fetched |
| Isolation | `require`, `process` and `fetch` are absent in the runtime context |
| Levels | requested level count; bot completes every level |
| Controls | granted input moves the player |
| Collision | solid wall stops the player; ground supports the player |
| Scoring | a pickup changes the score by its declared value |
| Mechanics | one measurement per shipped mechanic (gravity, jump, double jump, dash, shoot, enemies, hazards, switches, push blocks, moving platforms, timer) |
| Bounds | the player stays inside the world |
| Determinism | a replayed input sequence produces the same digest |
| Rendering | the shipped renderer paints distinct colours |

Evidence is written per level: a real PNG rendered by the generated game's own
renderer plus `verification.json`. `docs/evidence/game-studio/` also contains
the exact playable entry documents (`platformer.html`, `puzzle.html`) and a
landing `index.html`, so the reviewed bytes can be opened and played directly.
`npm run game:evidence` regenerates all of it.

### Deterministic versus AI-assisted generation

These are separate claims and the capability report keeps them separate:

- **Deterministic generation is operational.** The prompt reader, design plan,
  source emitter, level generator and verifier run without a model. They produce
  original code and levels from the validated spec, and every build must pass
  the measured checks above.
- **AI-assisted generation is blocked here.** `src/games/assistant.ts` has an
  optional, narrative-only model call through the verified zero-cost catalogue,
  with a schema check and deterministic fallback. No zero-cost model credential
  is configured in this deployment, and no model-assisted build was executed, so
  no model participation is claimed. A route being available in a catalogue is
  not evidence that a model wrote anything, and a narrative produced by a test
  double is not an executed build. The capability row therefore stays `blocked`
  whether or not a route is configured; only an executed and verified
  model-assisted build could change it.
- **Provenance is recorded, not inferred.** A model narrative is recorded as
  `GameDesignPlan.modelAssisted` with its logline and pillars on the project,
  and an iteration that uses no model records `modelAssisted: false`. The flag
  changes the plan only: source, levels, audio and the build manifest are
  byte-identical to deterministic generation for the same spec, which
  `tests/unit/games.test.ts` asserts.
- **Browser-verified playability is evidence for two reference builds.** The
  platformer and puzzle were rendered, controlled and completed in a real
  Chromium browser; the other six genres are covered by the deterministic
  verifier and the DOM boot harness, not by a real browser.
- **Autonomous gameplay is operational only for studio builds in the V8
  runtime.** Cloud-browser autonomous play remains blocked; the browser test
  controller is not the Native Gaming Agent.

### Real-browser acceptance

The exported `platformer.html` and `puzzle.html` were served from the
owner-authenticated preview origin and exercised in cloud Chromium on
2026-11-26 at `35d1883f22065851c31d29105b8ce13fcbf629c2`:

- **Rendering:** platformer 1280×682 / 872,960 opaque pixels; puzzle 1280×682 /
  698,368 opaque pixels, with no page errors.
- **Controls:** keyboard right moved +217 px over 50 ticks and jump rose 116 px;
  the on-screen mouse button moved +217 px; at 390×844 mobile touch moved
  +121.3 px over 28 ticks and touch jump rose 115 px. The DOM boot harness also
  presses the shipped on-screen buttons so a broken touch mapping fails the
  default gate.
- **Gameplay:** platformer won level 1 in 6.5 s (score 140, 4 pickups, health 2,
  6 jumps, 3 gap clears) and advanced to level 2; puzzle won in 15.9 s (score
  140, 4/4 pickups, switch on, goal unlocked, 0 collisions, 11 replans) and
  advanced to level 2. Timer expiry produced `lost` at tick 7,201; `R` restarted
  `playing` at x 40.
- **Audio:** the AudioContext was running and a jump created one oscillator;
  mute toggled false/true. Audible output was not captured.
- **Mobile:** at 390×844 the platformer canvas bitmap and CSS box were both
  390×698 after the HUD wrapped to two lines; the puzzle bitmap was 390×652
  against a 390×651.5 CSS box. Neither page had horizontal overflow and every
  on-screen button was visible.
- **Access:** a fresh anonymous browser context received **403**; the
  owner-authenticated browser received **200**. Authentication was not disabled.
- **Cost:** 3 s of level-2 platformer play used 0.271 s task time, 0.028 s script
  time and 3.5 MB JS heap on the cloud VM.

The capture is reproduced by `scripts/browser-acceptance.mjs`, which verifies
the served document digests, writes `report.json` and the five screenshots, and
drives the shipped controls. The timer path advances Playwright's page clock
unless `--real-timer` is passed; the game's fixed-step loop still produced 7,201
ticks. The measured report and five screenshots (desktop and 390×844 for both
builds, plus platformer level 2 after the level-1 win) are in
`docs/evidence/browser/`. This is Chromium-only evidence for the two reference
builds; there is no zero-cost browser CI or Safari/Firefox device matrix.

## Gaming Agent sessions

`POST /v1/games/{gameId}/sessions` requires a verified build. Creation writes a
scoped `command.execute` grant for `game-session:<id>`, then admits a durable
Work task with `kind: 'game'`. The task uses the existing lease, fencing,
heartbeat, event, retry and cancellation machinery; it is not a new agent
identity.

A session provides:

- **Version pinning** — a session names a verified build. It plays those exact
  bytes, even after the project is edited or an older build is restored.
- **Observation** — `GET /v1/game-sessions/{id}/observation` returns the
  measured state (level, tick, score, health, player, objective target) plus a
  PNG frame rendered by the shipped renderer.
- **Bounded controls** — only the actions granted at creation can be pressed.
  An ungranted action is refused.
- **Objective planning** — the objective is one of `reach_goal`,
  `complete_levels`, `score_at_least`, `defeat_enemies`; the plan is recorded in
  session memory.
- **Autonomous play** — the deterministic policy observes state each tick and
  picks from the granted actions. It yields periodically so control requests are
  serviced during a run.
- **Pause / resume** — the run holds its slot and stops consuming ticks while
  paused; a pause past the configured maximum fails the session.
- **Owner takeover** — the owner can take the controls, submit bounded input
  frames, and release back to the agent.
- **Cancellation** — the owner or the supervisor stops the run; the session and
  its task settle as cancelled.
- **Memory and logs** — plan lines, level results and control events are kept
  with timestamps.
- **Verified completion** — a session is `completed` only when measured game
  state satisfies the objective; `GET /verification` returns the checks,
  measurements, evidence paths and final digest. A run that cannot satisfy the
  objective fails; it never self-reports success.

## Isolation and authority

- Generated scripts run in an in-process V8 context created with no host
  bindings. The capability report names this boundary exactly:
  `in-process-v8-context`, not a container or a VM.
- Sessions use the engine's isolated artifact roots; no owner device, browser
  profile, credential or anti-cheat system is touched.
- Session creation requires an approved, resource-scoped permission grant.
- Projects, builds, frames and verification are owner-scoped; another owner gets
  `not_found`.
- The preview is served as `text/html` with
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`.
- The real-browser run confirmed the owner-only preview returns **403** to a
  fresh anonymous context and **200** to the owner. The generated document made
  no network requests; the preview host's injected Cloudflare beacon was blocked
  by the generated CSP.

## Limits

- Sessions play **studio builds** in the engine's runtime. External games remain
  blocked until a verified cloud browser and provider interface exist.
- The default gate's browser-boot check is a bounded DOM harness. It executes
  the exact inline document and now presses the shipped on-screen controls, but
  it does not enforce CSP or cover real devices. Real-browser acceptance is a
  separate Playwright run (`scripts/browser-acceptance.mjs`) for two reference
  builds; it is not part of the default gate, and Safari, Firefox and physical
  mobile devices are not claimed.
- `first_person` and two-player builds are unsupported by design.
- The studio ships original primitive-vector art driven by a generated palette
  and SVG theme; it does not fetch or copy third-party assets. Audio is
  synthesized, not sampled.
- The preview is a self-contained document intended for the engine's preview
  surface, not a hosted game portal.

## Configuration

`games.enabled`, `games.agentEnabled`, `games.maxProjectsPerOwner`,
`games.maxSessionTicks` and `games.maxPauseMs` are validated at startup.
Disabling games reports both capabilities `unsupported` and refuses new projects
and sessions without pretending they are operational.
