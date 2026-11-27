# Real-browser acceptance evidence

These results were captured on 2026-11-26 in cloud Chromium against the
self-contained documents served by the owner-authenticated preview origin, at
source head `35d1883f22065851c31d29105b8ce13fcbf629c2`. The capture is
reproducible with [`scripts/browser-acceptance.mjs`](../../../scripts/browser-acceptance.mjs),
which writes `report.json`, the document digests and the screenshots. These are
**not** a substitute for the deterministic verifier and they are **not**
evidence that the Native Gaming Agent can play arbitrary games.

## What was run

- Both reference builds loaded from the owner-authenticated preview origin over
  HTTPS. The script verifies that the served bytes hash to the local documents:
  platformer `sha256:5b4c5cfbef428f512f648d0d0621c24d51b3abbbad628dbd2d481fdea1d22f58`,
  puzzle `sha256:bb7ef97fa429efc7dfed170bacd64a0b8053b702289cedfe522d5cbe25a9bb16`.
- Desktop Chromium at 1280×800 and mobile at 390×844, device scale 1.
- Real Playwright keyboard and pointer events, plus Chrome DevTools Protocol
  touch events against the shipped handlers.
- A feedback controller for the platformer (gap, hazard, enemy and pickup
  probes with bounded jumps) and a BFS controller for the puzzle over measured
  collision geometry, replanning on stalls.
- Chrome DevTools Protocol metrics for task time, script time and JS heap during
  3 s of level-2 gameplay input.
- The 120 s timer path advanced with Playwright's page clock (the shipped
  fixed-step loop still produced 7,201 ticks); `--real-timer` repeats it in wall
  time.

## Reproducing the report

```bash
npx playwright install chromium    # once; the browser needs its system libraries
node scripts/browser-acceptance.mjs \
  --base-url https://<preview-origin> \
  --storage-state .run/preview-storage-state.json \
  --expect-auth
```

`--storage-state` points at a Playwright storage-state file holding the owner's
preview session cookie. It is git-ignored and must never be committed. Without
it the script can only measure an origin that does not require owner auth.
`--expect-auth` asserts a fresh anonymous context gets **403** and the
authenticated context gets **200** with matching document digests. The
authenticated browser is never replaced by a disabled-auth origin.

`--merge` updates only the captured mode in an existing `report.json`, and
`--timer-only` re-measures just the timer path. The cloud browser sessions used
for this capture are time-limited, so the report was assembled from a desktop
phase, a mobile phase and a timer phase; `capture.phases` records that. A local
run does all three in one process.

The exact HUD wrap, and therefore the canvas height, depends on the installed
monospace font metrics. The recorded numbers come from the cloud Chromium that
produced this report; a local Chromium with different fonts can be a few pixels
taller or shorter. What the fix guarantees is `bitmap = round(CSS box × device
scale)`, and the script asserts that on every run.

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
| Keyboard | right +217 px over 50 ticks, jump +116 px | not needed (top-down) |
| Mouse button | right +217 px over 50 ticks | — |
| Touch (390×844) | right +121.3 px over 28 ticks, jump +115 px | right +125.7 px over 29 ticks |
| Mobile canvas | bitmap 390×698 = CSS 390×698, 2-line HUD 46 px | bitmap 390×652 vs CSS 390×651.5, 1-line HUD 31 px |
| Collision | landed, cleared 3 gaps, health 3→2 | 0 solid overlaps across the run |
| Scoring | 140 points, 4 pickups | 140 points, 4/4 pickups |
| Objective | switch on, goal unlocked, `won` | switch on, goal unlocked, `won` |
| Progression | level 1 → level 2 | level 1 → level 2 |
| Failure | 120 s timer expired at tick 7,201 → `lost` | no failure condition in this build |
| Restart | `R` from `lost` → `playing`, x 40 | same restart path |
| Audio | AudioContext running; 1 oscillator on jump; mute toggles | same synthesized path |
| Performance | 0.271 s task, 0.028 s script, 3.5 MB heap over 3 s | — |

The platformer run took 6.5 s with 6 jumps; the puzzle took 15.9 s with 11
replans and 0 collisions. Screenshots are `platformer-desktop.png`,
`platformer-mobile.png`, `platformer-level2.png` (captured immediately after
completing level 1), `puzzle-desktop.png` and `puzzle-mobile.png` in this
directory. Both mobile screenshots are 390×844 PNGs captured at device scale 1.
Exact numbers are in `report.json`.

## What this does not establish

- No Safari, Firefox, iOS or Android device was tested.
- Touch was exercised with CDP touch events against real handlers; it was not a
  physical touchscreen.
- Audio was verified as a live synthesis path, not recorded or listened to.
- The controller is test code. It is not the Native Gaming Agent, and it does not
  make cloud-browser autonomous play an operational capability.
- There is no zero-cost browser CI; the default `npm run verify` uses the DOM boot
  harness, not this browser run.
- The timer path used Playwright's page clock, not a two-minute wall-clock wait.
  The game's own timer produced 7,201 ticks; `--real-timer` verifies the same
  path in real time.

## HUD-wrap fix, re-measured

The earlier mobile platformer capture recorded a 390×713 canvas bitmap against a
390×698 CSS box. The HUD wrapped to a second line after boot, the stage shrank,
and the bitmap was never resized, so the browser stretched the image. The
generated template now tracks the canvas box with a `ResizeObserver` and sizes
the bitmap in device pixels (capped at 2×).

The 390×844 viewport was re-captured at
`35d1883f22065851c31d29105b8ce13fcbf629c2` against the regenerated documents:

- **Platformer:** bitmap 390×698 and CSS 390×698 (exact), two-line HUD 46 px
  high, no horizontal overflow, touch right +121.3 px over 28 ticks, jump rise
  115 px, health 3 and 0 deaths after the control run.
- **Puzzle:** bitmap 390×652 against a 390×651.5 CSS box (rounded to device
  pixels), one-line HUD 31 px high, no horizontal overflow, touch right
  +125.7 px over 29 ticks.

Both documents loaded with **200** from the owner-authenticated origin; an
anonymous request received **403**. The desktop figures were re-captured in the
same run, so the whole report now describes the current documents. The mobile
capture used device scale 1; the 2× device-pixel path is covered by the DOM boot
harness, which also fails a build whose bitmap does not follow a wrapped HUD.

The capability report keeps these distinctions explicit: `native.game-studio` is
operational for deterministic generation, `native.game-studio.browser` is
degraded (two reference builds verified, not a per-build guarantee),
`native.game-studio.ai-assisted` is blocked without a verified model
participation, and `native.gaming-agent.browser` remains blocked.
