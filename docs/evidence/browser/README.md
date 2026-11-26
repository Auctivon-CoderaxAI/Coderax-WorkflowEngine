# Real-browser acceptance evidence

These results were captured on 2026-11-26 in the cloud Chromium browser against
the self-contained documents served by the preview host. They are **not** a
substitute for the deterministic verifier and they are **not** evidence that the
Native Gaming Agent can play arbitrary games.

## What was run

- Landing page, platformer and puzzle loaded from the owner-authenticated preview
  origin over HTTPS.
- Desktop Chromium at 1280×800 and mobile emulation at 390×844.
- Real Playwright keyboard and pointer events, plus dispatched `touchstart` /
  `touchend` events against the shipped handlers.
- An in-browser feedback controller for the puzzle (BFS over measured collision
  geometry, replanning on stalls) and a feedback controller for the platformer
  (gap probe, hazard/enemy probe, bounded key presses).
- Chrome DevTools Protocol metrics for task time, script time and JS heap.

## Owner-only access

| Request | Result |
| --- | --- |
| Fresh anonymous browser context → `/platformer.html` | **403** (`Preview`) |
| Owner-authenticated cloud browser → `/platformer.html` | **200** |

Authentication was not disabled or bypassed for the test. The preview host
injected a Cloudflare Insights beacon into the page; the generated CSP blocked
it. That is a host-injected script, not a script in the generated document: the
exported HTML has zero external script references.

## Measured results

| Area | Platformer | Puzzle |
| --- | --- | --- |
| Rendering | 1280×682 canvas, 872,960 opaque pixels | 1280×682 canvas, 698,368 opaque pixels |
| Keyboard | right +208 px, jump +115 px | not needed (top-down) |
| Mouse button | right +208 px | — |
| Touch (390×844) | right +112.7 px, jump +116.7 px | right +112.7 px |
| Mobile canvas | bitmap 390×698 = CSS 390×698, 2-line HUD | bitmap 390×652 vs CSS 390×651.5, 1-line HUD |
| Collision | landed, cleared 3 gaps, health 3→2 | 0 solid overlaps across the run |
| Scoring | 120 points, 2 pickups | 140 points, 4/4 pickups |
| Objective | switch on, goal unlocked, `won` | switch on, goal unlocked, `won` |
| Progression | level 1 → level 2 | level 1 → level 2 |
| Failure | 120 s timer expired → `lost` | no failure condition in this build |
| Restart | `R` from `lost` → `playing`, tick 21, x 40 | same restart path |
| Audio | AudioContext running; 1 oscillator on jump; mute toggles | same synthesized path |
| Performance | 0.307 s task, 0.039 s script, 5.2 MB heap over 3 s | — |

The platformer run took 6.3 s with 5 jumps; the puzzle took 12.0 s with 12
replans. Screenshots are `platformer-desktop.png`, `platformer-mobile.png`,
`platformer-level2.png` (captured immediately after completing level 1),
`puzzle-desktop.png` and `puzzle-mobile.png` in this directory. Both mobile
screenshots are 390×844 PNGs captured at device scale 1. Exact numbers are in
`report.json`.

## What this does not establish

- No Safari, Firefox, iOS or Android device was tested.
- Touch was dispatched against real handlers; it was not a physical touchscreen.
- Audio was verified as a live synthesis path, not recorded or listened to.
- The controller is test code. It is not the Native Gaming Agent, and it does not
  make cloud-browser autonomous play an operational capability.
- There is no zero-cost browser CI; the default `npm run verify` uses the DOM boot
  harness, not this browser run.

## HUD-wrap fix, re-measured

The earlier mobile platformer capture recorded a 390×713 canvas bitmap against a
390×698 CSS box (`platformerMobile` in `report.json`). The HUD wrapped to a
second line after boot, the stage shrank, and the bitmap was never resized, so
the browser stretched the image. The generated template now tracks the canvas
box with a `ResizeObserver` and sizes the bitmap in device pixels (capped at 2×).

The 390×844 viewport was re-captured at
`585ae28e36295edb2d69c044af045863f20179fe` against the regenerated documents:

- **Platformer:** bitmap 390×698 and CSS 390×698 (exact), two-line HUD 46 px
  high, no horizontal overflow, touch right +112.7 px, jump rise 116.7 px,
  health 3 and 0 deaths after the control run.
- **Puzzle:** bitmap 390×652 against a 390×651.5 CSS box (rounded to device
  pixels), one-line HUD 31 px high, no horizontal overflow, touch right
  +112.7 px.

Both documents loaded with **200** from the owner-authenticated origin; an
anonymous request received **403**. The desktop figures in this directory remain
the earlier `ce271b9` capture and were not re-run. The mobile re-capture used
device scale 1; the 2× device-pixel path is covered by the DOM boot harness,
which also fails a build whose bitmap does not follow a wrapped HUD.

The capability report keeps these distinctions explicit: `native.game-studio` is
operational for deterministic generation, `native.game-studio.browser` is
degraded (two reference builds verified, not a per-build guarantee),
`native.game-studio.ai-assisted` is blocked without a verified model
participation, and `native.gaming-agent.browser` remains blocked.
