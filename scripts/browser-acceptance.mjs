#!/usr/bin/env node
/**
 * Real-browser acceptance for the two reference Game Studio builds.
 *
 * This script reproduces the capture recorded in `docs/evidence/browser/`:
 * it measures the canvas bitmap against its CSS box, drives the shipped
 * keyboard, pointer and touch handlers, plays both builds to a verified win,
 * samples Chromium performance metrics, writes the screenshots and rewrites
 * `report.json` with the SHA-256 digests of the exact documents it loaded.
 *
 * It is a development tool, not part of `npm run verify`: the default gate is
 * the bounded DOM harness and must stay dependency-free. Install Chromium once
 * with `npx playwright install chromium` (and the system libraries it needs).
 *
 * Usage:
 *   node scripts/browser-acceptance.mjs --base-url http://127.0.0.1:3001
 *   node scripts/browser-acceptance.mjs --base-url https://<preview-origin> \
 *     --storage-state .run/preview-storage-state.json --expect-auth
 *
 * The storage-state file holds the owner's preview session cookie. It is
 * git-ignored and must never be committed or printed. Authentication is never
 * disabled: an anonymous context must still receive 403.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = join(ROOT, 'docs', 'evidence', 'game-studio');
const DEFAULT_OUT = join(ROOT, 'docs', 'evidence', 'browser');
const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require('playwright/package.json').version;

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, hasTouch: true },
};

const LIMITATIONS = [
  'Chromium only; Safari, Firefox and real iOS/Android were not tested.',
  'Touch was exercised with Chrome DevTools Protocol touch events on the real handlers, not a physical touchscreen.',
  'Audio synthesis was verified by a running AudioContext and an oscillator created on jump; audible output was not captured.',
  'The browser controller is acceptance-test code, not the Native Gaming Agent runtime; it does not make the agent a cloud-browser player.',
  'Performance metrics come from Chrome DevTools Protocol on one desktop VM sample; they are not a cross-device benchmark.',
  'No hosted browser CI exists at zero cost, so this evidence is for the two reference builds at the recorded head.',
  'The browser controller reads the generated hook and the collision geometry; it is a scripted player, not an independent intelligence.',
  'The timer-expiry and restart check advanced Playwright\'s page clock by 121 s; the generated fixed-step loop still produced 7201 ticks. Run with --real-timer to repeat it in wall time.',
];

/* ------------------------------------------------------------------ */
/* Arguments and documents                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.BROWSER_EVIDENCE_BASE_URL ?? 'http://127.0.0.1:3001',
    storageState: process.env.BROWSER_EVIDENCE_STORAGE_STATE ?? '',
    expectAuth: false,
    mode: 'both',
    timerOnly: false,
    outDir: DEFAULT_OUT,
    merge: false,
    sourceHead: '',
    timerSeconds: 121,
    realTimer: false,
    headed: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--base-url': options.baseUrl = value(); break;
      case '--storage-state': options.storageState = value(); break;
      case '--expect-auth': options.expectAuth = true; break;
      case '--mode': options.mode = value(); break;
      case '--timer-only': options.timerOnly = true; break;
      case '--out': options.outDir = resolve(value()); break;
      case '--merge': options.merge = true; break;
      case '--source-head': options.sourceHead = value(); break;
      case '--timer-seconds': options.timerSeconds = Number(value()); break;
      case '--real-timer': options.realTimer = true; break;
      case '--headed': options.headed = true; break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!['both', 'desktop', 'mobile'].includes(options.mode)) {
    throw new Error('--mode must be both, desktop or mobile');
  }
  if (options.storageState) options.storageState = resolve(options.storageState);
  if (!Number.isFinite(options.timerSeconds) || options.timerSeconds < 0) {
    throw new Error('--timer-seconds must be a non-negative number');
  }
  return options;
}

function usage() {
  return `Usage: node scripts/browser-acceptance.mjs [options]

  --base-url <url>        Origin serving the generated documents (default http://127.0.0.1:3001)
  --storage-state <file>  Playwright storage state with the owner preview session; never commit it
  --expect-auth           Assert anonymous 403 and authenticated 200 before measuring
  --mode <mode>           both (default), desktop or mobile
  --timer-only            Only re-measure the timer expiry and merge it into report.json
  --out <dir>             Screenshot and report directory (default docs/evidence/browser)
  --merge                 Update only the captured modes in an existing report.json
  --source-head <sha>     Recorded source commit; defaults to git HEAD
  --timer-seconds <n>     Idle seconds for the platformer timer-expiry check (default 121; 0 skips)
  --real-timer            Wait in real time instead of advancing Playwright's page clock
  --headed                Run Chromium headed
`;
}

function documentSet() {
  const entries = {};
  for (const [key, file] of [
    ['platformer', 'platformer.html'],
    ['puzzle', 'puzzle.html'],
  ]) {
    const path = join(DOCUMENTS, file);
    const bytes = readFileSync(path);
    entries[key] = {
      file,
      path,
      bytes,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Small measurement helpers                                           */
/* ------------------------------------------------------------------ */

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function originOf(value) {
  return new URL(value).origin;
}

function recordedHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function waitReady(page, settle = 800) {
  await page.waitForFunction(() => typeof window.__CODERAX_GAME__ === 'function', null, {
    timeout: 15_000,
  });
  await page.waitForTimeout(settle);
}

async function gameState(page) {
  return page.evaluate(() => {
    const game = window.__CODERAX_GAME__();
    const state = game.state;
    return {
      levelId: game.level.id,
      status: state.status,
      tick: state.tick,
      score: state.score,
      collected: state.collected,
      health: state.player.health,
      deaths: state.deaths,
      timeLeft: state.timeLeft,
      player: {
        x: state.player.x,
        y: state.player.y,
        w: state.player.w,
        h: state.player.h,
        vx: state.player.vx,
        vy: state.player.vy,
        onGround: state.player.onGround,
      },
      hud: document.getElementById('hud').textContent,
    };
  });
}

async function layout(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('game');
    const hud = document.getElementById('hud');
    const range = document.createRange();
    range.selectNodeContents(hud);
    const hudLines = range.getClientRects().length;
    const canvasBox = canvas.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[data-action]')].map((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        action: button.getAttribute('data-action'),
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          box.width > 0 &&
          box.height > 0 &&
          box.bottom <= innerHeight + 1,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    });
    const mute = document.getElementById('mute');
    const muteBox = mute.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      deviceScaleFactor: devicePixelRatio,
      canvas: { bitmap: [canvas.width, canvas.height], css: [canvasBox.width, canvasBox.height] },
      hud: {
        lines: hudLines,
        height: hud.getBoundingClientRect().height,
        text: hud.textContent,
      },
      buttons,
      mute: {
        visible: muteBox.width > 0 && muteBox.height > 0 && muteBox.bottom <= innerHeight + 1,
        text: mute.textContent,
      },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

async function canvasMetrics(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('game');
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    const colours = new Set();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 0) {
        opaque += 1;
        if (colours.size < 4096) {
          colours.add(`${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`);
        }
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      opaquePixels: opaque,
      distinctColours: colours.size,
    };
  });
}

// Sampling by simulation tick rather than wall time keeps the measured delta
// stable when the browser throttles requestAnimationFrame in a background tab.
async function ticksAfter(page, startTick, ticks, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let sample = await gameState(page);
  while (sample.tick - startTick < ticks && Date.now() < deadline) {
    await page.waitForTimeout(16);
    sample = await gameState(page);
  }
  return sample;
}

async function keyboardDelta(page, keys, ticks) {
  for (const key of keys) await page.keyboard.down(key);
  // Baseline after the key is armed: delivery latency must not eat the sample.
  const armed = await gameState(page);
  const after = await ticksAfter(page, armed.tick, ticks);
  for (const key of keys) await page.keyboard.up(key);
  return {
    delta: Math.round(after.player.x - armed.player.x),
    ticks: after.tick - armed.tick,
  };
}

async function jumpRise(page) {
  const start = await gameState(page);
  let peak = start.player.y;
  await page.keyboard.down('Space');
  const endTick = start.tick + 40;
  const deadline = Date.now() + 6_000;
  let sample = start;
  while (sample.tick < endTick && Date.now() < deadline) {
    await page.waitForTimeout(16);
    sample = await gameState(page);
    peak = Math.min(peak, sample.player.y);
  }
  await page.keyboard.up('Space');
  return Math.round((start.player.y - peak) * 10) / 10;
}

async function holdPointer(page, selector, ticks) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no visible box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const armed = await gameState(page);
  const after = await ticksAfter(page, armed.tick, ticks);
  await page.mouse.up();
  return {
    delta: Math.round(after.player.x - armed.player.x),
    ticks: after.tick - armed.tick,
  };
}

async function touchHold(page, selector, ticks) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no visible box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }],
  });
  const armed = await gameState(page);
  const after = await ticksAfter(page, armed.tick, ticks);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  return {
    delta: Math.round((after.player.x - armed.player.x) * 10) / 10,
    ticks: after.tick - armed.tick,
  };
}

async function touchJumpRise(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no visible box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const start = await gameState(page);
  let peak = start.player.y;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 2 }],
  });
  await page.waitForTimeout(90);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const endTick = start.tick + 40;
  const deadline = Date.now() + 6_000;
  let sample = start;
  while (sample.tick < endTick && Date.now() < deadline) {
    await page.waitForTimeout(16);
    sample = await gameState(page);
    peak = Math.min(peak, sample.player.y);
  }
  await cdp.detach();
  return Math.round((start.player.y - peak) * 10) / 10;
}

function attachConsole(page) {
  const errors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error.message ?? error)));
  return {
    errors,
    pageErrors,
    summarise() {
      return {
        pageErrors: [...new Set(this.pageErrors)],
        consoleErrors: [...new Set(this.errors)].map((line) => line.slice(0, 240)),
      };
    },
  };
}

async function screenshot(page, outDir, name) {
  await page.screenshot({ path: join(outDir, name), fullPage: false });
  return name;
}

/* ------------------------------------------------------------------ */
/* Platformer controller                                               */
/* ------------------------------------------------------------------ */

async function platformerSnapshot(page) {
  return page.evaluate(() => {
    const game = window.__CODERAX_GAME__();
    const state = game.state;
    const rect = (entry) => ({
      x: entry.x, y: entry.y, w: entry.w, h: entry.h,
    });
    return {
      levelId: game.level.id,
      status: state.status,
      tick: state.tick,
      score: state.score,
      collected: state.collected,
      health: state.player.health,
      deaths: state.deaths,
      timeLeft: state.timeLeft,
      player: {
        x: state.player.x, y: state.player.y, w: state.player.w, h: state.player.h,
        vy: state.player.vy, onGround: state.player.onGround,
      },
      solids: state.solids.map(rect),
      hazards: state.hazards.map(rect),
      enemies: state.enemies.filter((enemy) => enemy.alive).map(rect),
      collectibles: state.collectibles.filter((item) => !item.taken).map(rect),
    };
  });
}

async function playPlatformer(page, { timeoutMs = 45_000 } = {}) {
  const start = Date.now();
  let jumps = 0;
  let gapJumps = 0;
  let lastJump = 0;
  await page.keyboard.down('ArrowRight');
  try {
    while (Date.now() - start < timeoutMs) {
      const game = await platformerSnapshot(page);
      if (game.status !== 'playing') break;

      const player = game.player;
      const aheadX = player.x + player.w + 55;
      const groundY = player.y + player.h + 8;
      const groundAhead = game.solids.some(
        (solid) =>
          aheadX >= solid.x &&
          aheadX <= solid.x + solid.w &&
          groundY >= solid.y &&
          groundY <= solid.y + solid.h + 8,
      );
      const gap = !groundAhead;
      const hazardAhead = game.hazards.some(
        (hazard) =>
          hazard.x + hazard.w > player.x + player.w &&
          hazard.x < player.x + player.w + 105 &&
          hazard.y < player.y + player.h &&
          hazard.y + hazard.h > player.y,
      );
      const enemyAhead = game.enemies.some(
        (enemy) =>
          enemy.x + enemy.w > player.x &&
          enemy.x < player.x + player.w + 165 &&
          enemy.y < player.y + player.h &&
          enemy.y + enemy.h > player.y,
      );
      const pickupAhead = game.collectibles.some(
        (item) =>
          item.x + item.w > player.x &&
          item.x < player.x + player.w + 85 &&
          item.y < player.y + 6,
      );
      const shouldJump = gap || hazardAhead || enemyAhead || pickupAhead;
      if (shouldJump && player.onGround && Date.now() - lastJump > 240) {
        await page.keyboard.down('Space');
        await page.waitForTimeout(70);
        await page.keyboard.up('Space');
        jumps += 1;
        if (gap) gapJumps += 1;
        lastJump = Date.now();
      }
      await page.waitForTimeout(35);
    }
  } finally {
    await page.keyboard.up('ArrowRight');
  }
  const finish = await platformerSnapshot(page);
  const elapsedMs = Date.now() - start;
  if (finish.status !== 'won') {
    throw new Error(
      `platformer controller did not win: status=${finish.status} tick=${finish.tick} x=${Math.round(
        finish.player.x,
      )} score=${finish.score}`,
    );
  }
  return {
    status: finish.status,
    score: finish.score,
    collected: finish.collected,
    health: finish.health,
    timeLeft: round(finish.timeLeft, 1),
    elapsedMs,
    jumps,
    gapJumps,
    deaths: finish.deaths,
  };
}

async function waitForLevel(page, levelId, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const game = await gameState(page);
    if (game.levelId === levelId) return game;
    await page.waitForTimeout(80);
  }
  const final = await gameState(page);
  throw new Error(`level did not advance to ${levelId}: ${final.levelId} (${final.status})`);
}

/* ------------------------------------------------------------------ */
/* Puzzle controller: BFS over the measured collision geometry         */
/* ------------------------------------------------------------------ */

function overlap(a, b, margin = 0) {
  return (
    a.x + a.w > b.x + margin &&
    a.x < b.x + b.w - margin &&
    a.y + a.h > b.y + margin &&
    a.y < b.y + b.h - margin
  );
}

function buildGrid(geometry) {
  const step = 6;
  const player = { w: 24, h: 34 };
  const obstacles = [...geometry.solids, ...geometry.blocks];
  const cols = Math.ceil(geometry.width / step) + 1;
  const rows = Math.ceil(geometry.height / step) + 1;
  const cell = (cx, cy) => ({ x: cx * step, y: cy * step, w: player.w, h: player.h });
  const free = (cx, cy) => {
    if (cx < 1 || cy < 1 || cx >= cols - 1 || cy >= rows - 1) return false;
    const box = cell(cx, cy);
    return !obstacles.some((obstacle) => overlap(box, obstacle, 1));
  };
  const neighbours = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const key = (cx, cy) => `${cx},${cy}`;

  const nearestFree = (cx, cy) => {
    if (free(cx, cy)) return [cx, cy];
    for (let radius = 1; radius < 20; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (const dy of [-radius, radius]) {
          if (free(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
      for (let dy = -radius + 1; dy < radius; dy += 1) {
        for (const dx of [-radius, radius]) {
          if (free(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  };

  const search = (start, targets) => {
    const startCell = nearestFree(start[0], start[1]);
    if (!startCell) return null;
    const targetSet = new Set(targets.map(([cx, cy]) => key(cx, cy)));
    const queue = [startCell];
    const previous = new Map([[key(...startCell), null]]);
    let found = null;
    for (let head = 0; head < queue.length && found === null; head += 1) {
      const [cx, cy] = queue[head];
      if (targetSet.has(key(cx, cy))) {
        found = [cx, cy];
        break;
      }
      for (const [dx, dy] of neighbours) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!free(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          if (!free(cx + dx, cy) || !free(cx, cy + dy)) continue;
        }
        const nextKey = key(nx, ny);
        if (previous.has(nextKey)) continue;
        previous.set(nextKey, [cx, cy]);
        queue.push([nx, ny]);
      }
    }
    if (!found) return null;
    const path = [];
    let cursor = found;
    while (cursor) {
      path.push(cursor);
      cursor = previous.get(key(...cursor));
    }
    return path.reverse();
  };

  const overlapsCell = (cx, cy, rect) => overlap(cell(cx, cy), rect);
  const targetsFor = (rect) => {
    const targets = [];
    for (let cx = 0; cx < cols; cx += 1) {
      for (let cy = 0; cy < rows; cy += 1) {
        if (free(cx, cy) && overlapsCell(cx, cy, rect)) targets.push([cx, cy]);
      }
    }
    return targets;
  };

  const visible = (from, to) => {
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const samples = Math.max(1, Math.ceil(distance / 3));
    for (let index = 0; index <= samples; index += 1) {
      const cx = Math.round(from[0] + ((to[0] - from[0]) * index) / samples);
      const cy = Math.round(from[1] + ((to[1] - from[1]) * index) / samples);
      if (!free(cx, cy)) return false;
    }
    return true;
  };

  const simplify = (path) => {
    if (!path || path.length === 0) return [];
    const waypoints = [path[0]];
    let index = 0;
    while (index < path.length - 1) {
      let next = index + 1;
      for (let probe = path.length - 1; probe > index; probe -= 1) {
        if (visible(path[index], path[probe])) {
          next = probe;
          break;
        }
      }
      waypoints.push(path[next]);
      index = next;
    }
    return waypoints;
  };

  return { step, cols, rows, free, search, targetsFor, simplify, cell };
}

async function puzzleGeometry(page) {
  return page.evaluate(() => {
    const game = window.__CODERAX_GAME__();
    const state = game.state;
    const rect = (entry) => ({ x: entry.x, y: entry.y, w: entry.w, h: entry.h });
    return {
      width: game.level.width,
      height: game.level.height,
      solids: state.solids.map(rect),
      blocks: state.blocks.map(rect),
      collectibles: state.collectibles.map((item) => ({ ...rect(item), taken: item.taken })),
      switches: state.switches.map((item) => ({ ...rect(item), pressed: item.on })),
      goal: { ...rect(state.goal), locked: state.goal.locked },
      player: rect(state.player),
      levelId: game.level.id,
      status: state.status,
      tick: state.tick,
      score: state.score,
      collected: state.collected,
    };
  });
}

async function playPuzzle(page, { timeoutMs = 60_000 } = {}) {
  const start = Date.now();
  let replans = 0;
  let collisions = 0;
  let plan = null;
  let waypoints = [];
  let targetIndex = -1;
  let lastReplan = 0;
  let lastProgress = Date.now();
  let lastPosition = null;
  const pressed = new Set();

  const setKey = async (key, down) => {
    if (down && !pressed.has(key)) {
      pressed.add(key);
      await page.keyboard.down(key);
    } else if (!down && pressed.has(key)) {
      pressed.delete(key);
      await page.keyboard.up(key);
    }
  };
  const releaseAll = async () => {
    for (const key of [...pressed]) await setKey(key, false);
  };

  try {
    while (Date.now() - start < timeoutMs) {
      const geometry = await puzzleGeometry(page);
      if (geometry.status !== 'playing') break;

      const player = geometry.player;
      const box = { x: player.x, y: player.y, w: player.w, h: player.h };
      if (geometry.solids.some((solid) => overlap(box, solid))) collisions += 1;

      const remaining = geometry.collectibles.filter((item) => !item.taken);
      const pendingSwitch = geometry.switches.find((item) => !item.pressed);
      let target = null;
      if (remaining.length > 0) {
        target = remaining
          .map((item) => ({ item, distance: Math.hypot(item.x - player.x, item.y - player.y) }))
          .sort((a, b) => a.distance - b.distance)[0].item;
      } else if (pendingSwitch) {
        target = pendingSwitch;
      } else {
        target = geometry.goal;
      }

      const targetKey = remaining.length > 0
        ? `collectible:${geometry.collectibles.indexOf(target)}`
        : pendingSwitch
          ? `switch:${geometry.switches.indexOf(pendingSwitch)}`
          : 'goal';
      const targetChanged = targetKey !== targetIndex;
      const stalled = Date.now() - lastProgress > 800;
      if (!plan || targetChanged || stalled || Date.now() - lastReplan > 2_000) {
        const grid = buildGrid(geometry);
        const startCell = [Math.round(player.x / grid.step), Math.round(player.y / grid.step)];
        const targets = grid.targetsFor(target);
        const path = targets.length > 0 ? grid.search(startCell, targets) : null;
        if (!path) {
          await releaseAll();
          await page.waitForTimeout(120);
          continue;
        }
        plan = { grid, target };
        waypoints = grid.simplify(path).map(([cx, cy]) => ({
          x: cx * grid.step,
          y: cy * grid.step,
        }));
        waypoints.shift();
        targetIndex = targetKey;
        lastReplan = Date.now();
        replans += 1;
        lastProgress = Date.now();
      }

      if (plan && waypoints.length > 0) {
        const waypoint = waypoints[0];
        const dx = waypoint.x - player.x;
        const dy = waypoint.y - player.y;
        if (Math.hypot(dx, dy) < 7) {
          waypoints.shift();
        } else {
          await setKey('ArrowRight', dx > 4);
          await setKey('ArrowLeft', dx < -4);
          await setKey('ArrowDown', dy > 4);
          await setKey('ArrowUp', dy < -4);
        }
      } else {
        await releaseAll();
        // Standing on the target still requires a step for pickups and switches.
        await page.waitForTimeout(80);
      }

      if (lastPosition && Math.hypot(player.x - lastPosition.x, player.y - lastPosition.y) > 2) {
        lastProgress = Date.now();
      }
      lastPosition = { x: player.x, y: player.y };
      if (stalled) {
        const nudge = pressed.has('ArrowDown') ? 'ArrowLeft' : 'ArrowDown';
        await setKey(nudge, true);
        await page.waitForTimeout(180);
        await setKey(nudge, false);
        lastProgress = Date.now();
      }
      await page.waitForTimeout(45);
    }
  } finally {
    await releaseAll();
  }

  const finish = await puzzleGeometry(page);
  const elapsedMs = Date.now() - start;
  if (finish.status !== 'won') {
    throw new Error(
      `puzzle controller did not win: status=${finish.status} tick=${finish.tick} x=${Math.round(
        finish.player.x,
      )} y=${Math.round(finish.player.y)} collected=${finish.collected}`,
    );
  }
  return {
    method: 'in-browser BFS over measured collision geometry, replanning on stalls',
    status: finish.status,
    score: finish.score,
    collected: finish.collected,
    switches: finish.switches.map((item) => item.pressed),
    goalLocked: finish.goal.locked,
    collisions,
    replans,
    elapsedMs,
    tick: finish.tick,
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function selectChecks(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = (name) => metrics.find((entry) => entry.name === name)?.value ?? 0;
    return {
      taskDuration: value('TaskDuration'),
      scriptDuration: value('ScriptDuration'),
      jsHeapUsedBytes: value('JSHeapUsedSize'),
      nodes: value('Nodes'),
    };
  };
  const before = await read();
  // Sample during actual play rather than while the level sits idle.
  await page.keyboard.down('ArrowRight');
  const started = Date.now();
  let lastJump = 0;
  while (Date.now() - started < 3_000) {
    if (Date.now() - lastJump > 500) {
      await page.keyboard.down('Space');
      await page.waitForTimeout(70);
      await page.keyboard.up('Space');
      lastJump = Date.now();
    }
    await page.waitForTimeout(50);
  }
  await page.keyboard.up('ArrowRight');
  const after = await read();
  await cdp.detach();
  return {
    sampleSeconds: 3,
    taskDurationSeconds: round(after.taskDuration - before.taskDuration, 6),
    scriptDurationSeconds: round(after.scriptDuration - before.scriptDuration, 6),
    jsHeapUsedBytes: Math.round(after.jsHeapUsedBytes),
    nodes: Math.round(after.nodes),
  };
}

async function captureDesktop(browser, contextOptions, options, documents, outDir) {
  const context = await browser.newContext({
    ...contextOptions,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const consoleLog = attachConsole(page);
  await page.addInitScript(() => {
    const Original = window.AudioContext || window.webkitAudioContext;
    if (!Original) return;
    window.__coderaxAudio = { oscillators: 0 };
    const create = Original.prototype.createOscillator;
    Original.prototype.createOscillator = function patchedCreateOscillator(...args) {
      window.__coderaxAudio.oscillators += 1;
      return create.apply(this, args);
    };
    const Wrapped = function WrappedAudioContext(...args) {
      const instance = new Original(...args);
      window.__coderaxAudio.context = instance;
      return instance;
    };
    Wrapped.prototype = Original.prototype;
    window.AudioContext = Wrapped;
    window.webkitAudioContext = Wrapped;
  });

  await page.goto(`${options.baseUrl}/platformer.html`, { waitUntil: 'load' });
  await waitReady(page, 900);
  const platformerLayout = await layout(page);
  const platformerCanvas = await canvasMetrics(page);
  const initial = await gameState(page);
  await screenshot(page, outDir, 'platformer-desktop.png');

  const keyMove = await keyboardDelta(page, ['ArrowRight'], 48);
  const keyboard = {
    rightDeltaPx: keyMove.delta,
    sampleTicks: keyMove.ticks,
    jumpRisePx: 0,
  };
  // Each control measurement starts from the spawn; a run from the moved
  // position would walk off the first gap and measure a fall instead.
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  keyboard.jumpRisePx = await jumpRise(page);
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  const mouseMove = await holdPointer(page, '[data-action="right"]', 48);
  const mouse = { rightDeltaPx: mouseMove.delta, sampleTicks: mouseMove.ticks };
  await page.keyboard.press('r');
  await page.waitForTimeout(300);

  await page.keyboard.press('p');
  const pausedBefore = await gameState(page);
  await page.waitForTimeout(500);
  const pausedAfter = await gameState(page);
  await page.keyboard.press('p');
  const pause = { tickDelta: pausedAfter.tick - pausedBefore.tick, sampleMs: 500 };

  const audioBefore = await page.evaluate(() => ({
    enabled: globalThis.CoderaxAudio?.enabled() ?? null,
    oscillators: window.__coderaxAudio?.oscillators ?? 0,
    contextState: window.__coderaxAudio?.context?.state ?? null,
  }));
  await page.keyboard.down('Space');
  await page.waitForTimeout(120);
  await page.keyboard.up('Space');
  await page.waitForTimeout(120);
  const audioAfterJump = await page.evaluate(() => ({
    oscillators: window.__coderaxAudio?.oscillators ?? 0,
    contextState: window.__coderaxAudio?.context?.state ?? null,
  }));
  const muteToggle = [];
  for (let click = 0; click < 2; click += 1) {
    await page.locator('#mute').click();
    muteToggle.push(await page.evaluate(() => globalThis.CoderaxAudio?.enabled() ?? null));
  }
  const audio = {
    audioContextState: audioAfterJump.contextState ?? audioBefore.contextState,
    oscillatorsOnJump: audioAfterJump.oscillators - audioBefore.oscillators,
    muteToggle,
  };

  const win = await playPlatformer(page);
  await page.waitForTimeout(120);
  const hud = {
    health: initial.health,
    healthRendered: initial.hud.match(/Health\s+\d+/)?.[0] ?? initial.hud,
  };

  const beforeLevel = await gameState(page);
  const advanced = await waitForLevel(page, 'level-2');
  await page.waitForTimeout(450);
  const level2 = await gameState(page);
  await screenshot(page, outDir, 'platformer-level2.png');
  const progression = {
    levelIndexBefore: Number(beforeLevel.levelId.split('-')[1]) - 1,
    levelIndexAfter: Number(advanced.levelId.split('-')[1]) - 1,
    levelIdAfter: advanced.levelId,
    statusAfter: level2.status,
    screenshot: 'docs/evidence/browser/platformer-level2.png',
  };

  const performance = { ...(await selectChecks(page)), during: 'level-2 gameplay input' };
  const consoleSummary = consoleLog.summarise();
  await context.close();

  // The timer check uses a fresh page so the 120 s budget is not spent twice.
  const { failure, restart } = await captureTimer(browser, contextOptions, options);

  return {
    platformer: {
      canvas: platformerCanvas,
      keyboard,
      mouse,
      pause,
      restart,
      hud,
      win,
      progression,
      failure,
      audio,
      performance,
      layout: {
        viewport: platformerLayout.viewport,
        deviceScaleFactor: platformerLayout.deviceScaleFactor,
        canvasCss: [round(platformerLayout.canvas.css[0]), round(platformerLayout.canvas.css[1])],
        hudLines: platformerLayout.hud.lines,
        hudHeight: round(platformerLayout.hud.height),
        horizontalOverflow: platformerLayout.horizontalOverflow,
      },
      console: consoleSummary,
    },
    puzzle: await capturePuzzleDesktop(browser, contextOptions, options, outDir),
  };
}

async function captureTimer(browser, contextOptions, options) {
  if (options.timerSeconds <= 0) return { failure: null, restart: null };
  const timerContext = await browser.newContext(contextOptions);
  const timerPage = await timerContext.newPage();
  // The page clock advances the shipped fixed-step loop without waiting two
  // real minutes; `--real-timer` performs the same check in wall time.
  if (!options.realTimer) await timerPage.clock.install();
  await timerPage.goto(`${options.baseUrl}/platformer.html`, { waitUntil: 'domcontentloaded' });
  await timerPage.waitForFunction(() => typeof window.__CODERAX_GAME__ === 'function', null, {
    timeout: 15_000,
  });
  if (options.realTimer) {
    await timerPage.waitForTimeout(200);
    await timerPage.waitForFunction(
      () => window.__CODERAX_GAME__().state.status === 'lost',
      null,
      { timeout: (options.timerSeconds + 30) * 1_000, polling: 500 },
    );
  } else {
    await timerPage.clock.runFor(options.timerSeconds * 1_000);
  }
  const lost = await gameState(timerPage);
  const failure = {
    condition: 'level timer expired',
    status: lost.status,
    observedTick: lost.tick,
    method: options.realTimer ? 'real-time' : 'playwright-page-clock',
  };
  await timerPage.keyboard.press('r');
  if (options.realTimer) await timerPage.waitForTimeout(350);
  else await timerPage.clock.runFor(350);
  const restarted = await gameState(timerPage);
  const restart = {
    statusBefore: lost.status,
    statusAfter: restarted.status,
    tickAfter: restarted.tick,
    xAfter: Math.round(restarted.player.x),
  };
  await timerContext.close();
  return { failure, restart };
}

async function capturePuzzleDesktop(browser, contextOptions, options, outDir) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleLog = attachConsole(page);
  await page.goto(`${options.baseUrl}/puzzle.html`, { waitUntil: 'load' });
  await waitReady(page, 900);
  const puzzleLayout = await layout(page);
  const canvas = await canvasMetrics(page);
  await screenshot(page, outDir, 'puzzle-desktop.png');
  const autonomousController = await playPuzzle(page);
  const beforeLevel = await gameState(page);
  const advanced = await waitForLevel(page, 'level-2');
  await page.waitForTimeout(450);
  const level2 = await gameState(page);
  const progression = {
    levelIndexBefore: Number(beforeLevel.levelId.split('-')[1]) - 1,
    levelIndexAfter: Number(advanced.levelId.split('-')[1]) - 1,
    levelIdAfter: advanced.levelId,
    statusAfter: level2.status,
  };
  const consoleSummary = consoleLog.summarise();
  await context.close();
  return {
    canvas,
    autonomousController,
    progression,
    layout: {
      viewport: puzzleLayout.viewport,
      deviceScaleFactor: puzzleLayout.deviceScaleFactor,
      canvasCss: [round(puzzleLayout.canvas.css[0]), round(puzzleLayout.canvas.css[1])],
      hudLines: puzzleLayout.hud.lines,
      hudHeight: round(puzzleLayout.hud.height),
      horizontalOverflow: puzzleLayout.horizontalOverflow,
    },
    console: consoleSummary,
  };
}

async function captureMobile(browser, contextOptions, options, outDir) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleLog = attachConsole(page);
  await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height });
  await page.goto(`${options.baseUrl}/platformer.html`, { waitUntil: 'load' });
  await waitReady(page, 1_000);
  const platformerLayout = await layout(page);
  const platformerCanvas = await canvasMetrics(page);
  const touchRight = await touchHold(page, '[data-action="right"]', 26);
  const platformerTouch = {
    touchRightDeltaPx: touchRight.delta,
    touchSampleTicks: touchRight.ticks,
    touchJumpRisePx: await touchJumpRise(page, '[data-action="jump"]'),
  };
  const platformerFinal = await gameState(page);
  await screenshot(page, outDir, 'platformer-mobile.png');

  const platformerMobile = {
    viewport: platformerLayout.viewport,
    deviceScaleFactor: platformerLayout.deviceScaleFactor,
    canvas: [platformerLayout.canvas.bitmap[0], platformerLayout.canvas.bitmap[1]],
    canvasCss: [
      round(platformerLayout.canvas.css[0]),
      round(platformerLayout.canvas.css[1]),
    ],
    bitmapMatchesCss:
      platformerLayout.canvas.bitmap[0] ===
        Math.round(platformerLayout.canvas.css[0] * platformerLayout.deviceScaleFactor) &&
      platformerLayout.canvas.bitmap[1] ===
        Math.round(platformerLayout.canvas.css[1] * platformerLayout.deviceScaleFactor),
    horizontalOverflow: platformerLayout.horizontalOverflow,
    touchButtons: platformerLayout.buttons.filter((button) => button.visible).map((button) => button.action),
    muteButton: platformerLayout.mute.visible,
    hud: {
      lines: platformerLayout.hud.lines,
      height: round(platformerLayout.hud.height),
      text: platformerLayout.hud.text,
    },
    touchRightDeltaPx: platformerTouch.touchRightDeltaPx,
    touchSampleTicks: platformerTouch.touchSampleTicks,
    touchJumpRisePx: platformerTouch.touchJumpRisePx,
    healthAfterTouch: platformerFinal.health,
    deathsAfterTouch: platformerFinal.deaths,
    status: platformerFinal.status,
    screenshot: 'platformer-mobile.png',
  };

  await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height });
  await page.goto(`${options.baseUrl}/puzzle.html`, { waitUntil: 'load' });
  await waitReady(page, 1_000);
  const puzzleLayout = await layout(page);
  const puzzleTouch = await touchHold(page, '[data-action="right"]', 26);
  const puzzleFinal = await gameState(page);
  await screenshot(page, outDir, 'puzzle-mobile.png');

  const puzzleMobile = {
    viewport: puzzleLayout.viewport,
    deviceScaleFactor: puzzleLayout.deviceScaleFactor,
    canvas: [puzzleLayout.canvas.bitmap[0], puzzleLayout.canvas.bitmap[1]],
    canvasCss: [round(puzzleLayout.canvas.css[0]), round(puzzleLayout.canvas.css[1])],
    bitmapMatchesCss:
      puzzleLayout.canvas.bitmap[0] ===
        Math.round(puzzleLayout.canvas.css[0] * puzzleLayout.deviceScaleFactor) &&
      puzzleLayout.canvas.bitmap[1] ===
        Math.round(puzzleLayout.canvas.css[1] * puzzleLayout.deviceScaleFactor),
    horizontalOverflow: puzzleLayout.horizontalOverflow,
    touchButtons: puzzleLayout.buttons.filter((button) => button.visible).map((button) => button.action),
    muteButton: puzzleLayout.mute.visible,
    hud: {
      lines: puzzleLayout.hud.lines,
      height: round(puzzleLayout.hud.height),
      text: puzzleLayout.hud.text,
    },
    touchRightDeltaPx: puzzleTouch.delta,
    touchSampleTicks: puzzleTouch.ticks,
    healthAfterTouch: puzzleFinal.health,
    status: puzzleFinal.status,
    screenshot: 'puzzle-mobile.png',
  };

  const consoleSummary = consoleLog.summarise();
  await context.close();
  return { platformerMobile, puzzleMobile, console: consoleSummary };
}

/* ------------------------------------------------------------------ */
/* Auth and report                                                     */
/* ------------------------------------------------------------------ */

async function ownerAuth(browser, options, documents) {
  if (!options.expectAuth) return null;
  const anonymous = await browser.newContext();
  try {
    const response = await anonymous.request.get(`${options.baseUrl}/platformer.html`);
    const body = await response.text();
    const title = body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    const status = response.status();
    if (status !== 403) {
      throw new Error(`anonymous preview request returned ${status}, expected 403`);
    }
    return { anonymousStatus: status, anonymousTitle: title.slice(0, 80), authenticatedStatus: null };
  } finally {
    await anonymous.close();
  }
}

async function authenticatedStatus(browser, contextOptions, options, documents) {
  const context = await browser.newContext(contextOptions);
  try {
    const response = await context.request.get(`${options.baseUrl}/platformer.html`);
    const status = response.status();
    const body = Buffer.from(await response.body());
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (status !== 200) throw new Error(`authenticated preview request returned ${status}`);
    if (digest !== documents.platformer.digest) {
      throw new Error(
        `served platformer digest ${digest} does not match ${documents.platformer.digest}`,
      );
    }
    const puzzleResponse = await context.request.get(`${options.baseUrl}/puzzle.html`);
    const puzzleDigest = `sha256:${createHash('sha256')
      .update(Buffer.from(await puzzleResponse.body()))
      .digest('hex')}`;
    if (puzzleResponse.status() !== 200 || puzzleDigest !== documents.puzzle.digest) {
      throw new Error(
        `served puzzle digest ${puzzleDigest} (${puzzleResponse.status()}) does not match ${documents.puzzle.digest}`,
      );
    }
    return status;
  } finally {
    await context.close();
  }
}

function documentFacts(documents) {
  const html = documents.platformer.bytes.toString('utf8');
  const scripts = html.match(/<script(?:\s[^>]*)?>/gi) ?? [];
  const external = scripts.filter((tag) => /\bsrc\s*=/i.test(tag)).length;
  const csp =
    html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]*)"/i)?.[1] ?? '';
  return {
    generatedExternalScripts: external,
    inlineScripts: scripts.length - external,
    csp,
  };
}

function baseReport({ options, documents, head, auth, browserLabel }) {
  return {
    capturedAt: new Date().toISOString(),
    sourceHead: options.sourceHead || head,
    capture: {
      script: 'scripts/browser-acceptance.mjs',
      command:
        `node scripts/browser-acceptance.mjs --base-url ${originOf(options.baseUrl)}` +
        `${options.expectAuth ? ' --expect-auth' : ''}`,
      playwright: PLAYWRIGHT_VERSION,
      browser: browserLabel,
      viewports: { desktop: '1280x800', mobile: '390x844' },
    },
    documentDigests: {
      'platformer.html': documents.platformer.digest,
      'puzzle.html': documents.puzzle.digest,
    },
    environment: {
      browser: browserLabel,
      previewUrl: originOf(options.baseUrl),
      desktopViewport: '1280x800',
      mobileViewport: '390x844',
      ownerAuth: {
        anonymousContextStatus: auth?.anonymousStatus ?? null,
        anonymousTitle: auth?.anonymousTitle ?? null,
        authenticatedStatus: auth?.authenticatedStatus ?? null,
      },
    },
    documents: {
      ...documentFacts(documents),
      hostInjectedScriptBlocked: null,
    },
    limitations: LIMITATIONS,
  };
}

async function captureAll(browser, options = {}) {
  const documents = documentSet();
  const head = recordedHead();
  const outDir = options.outDir ?? DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'report.json');
  const previous =
    (options.merge || options.timerOnly) && existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, 'utf8'))
      : null;
  if (options.timerOnly && !previous) {
    throw new Error('--timer-only needs an existing report.json in --out');
  }

  const contextOptions = {
    viewport: VIEWPORTS.desktop,
    deviceScaleFactor: 1,
    hasTouch: false,
  };
  if (options.storageState) {
    if (!existsSync(options.storageState)) {
      throw new Error(`storage state not found: ${options.storageState}`);
    }
    contextOptions.storageState = options.storageState;
  }

  let auth = await ownerAuth(browser, options, documents);
  if (auth) {
    auth.authenticatedStatus = await authenticatedStatus(browser, contextOptions, options, documents);
  }

  const browserLabel =
    options.browserLabel ??
    `Chromium ${browser.version()} (Playwright ${PLAYWRIGHT_VERSION}${options.headed ? ', headed' : ', headless'})`;
  const report = previous ?? baseReport({ options, documents, head, auth, browserLabel });
  if (previous) {
    report.capturedAt = new Date().toISOString();
    report.sourceHead = options.sourceHead || head;
    report.documentDigests = {
      'platformer.html': documents.platformer.digest,
      'puzzle.html': documents.puzzle.digest,
    };
    report.limitations = LIMITATIONS;
    report.environment = {
      ...previous.environment,
      ...(auth ? { ownerAuth: { ...auth } } : {}),
    };
    report.capture = {
      ...previous.capture,
      command:
        `node scripts/browser-acceptance.mjs --base-url ${originOf(options.baseUrl)}` +
        `${options.expectAuth ? ' --expect-auth' : ''}`,
      playwright: PLAYWRIGHT_VERSION,
      browser: browserLabel,
      phases: [
        ...new Set([
          ...(previous.capture.phases ?? []),
          ...(options.timerOnly ? ['timer'] : [options.mode]),
        ]),
      ],
    };
  } else {
    report.capture.phases = [options.mode];
  }

  if (options.timerOnly) {
    if (!report.platformer) throw new Error('--timer-only needs a desktop section in report.json');
    const timer = await captureTimer(browser, contextOptions, {
      ...options,
      timerSeconds: options.timerSeconds > 0 ? options.timerSeconds : 121,
    });
    report.platformer = { ...report.platformer, ...timer };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const consoleLines = [...(report.documents.consoleErrors ?? [])];

  if (options.mode !== 'mobile') {
    const desktop = await captureDesktop(browser, contextOptions, options, documents, outDir);
    report.platformer = desktop.platformer;
    report.puzzle = {
      canvas: desktop.puzzle.canvas,
      autonomousController: desktop.puzzle.autonomousController,
      progression: desktop.puzzle.progression,
      layout: desktop.puzzle.layout,
    };
    consoleLines.push(...desktop.platformer.console.consoleErrors, ...desktop.puzzle.console.consoleErrors);
    report.documents.pageErrors = [
      ...new Set([
        ...desktop.platformer.console.pageErrors,
        ...desktop.puzzle.console.pageErrors,
      ]),
    ];
    report.documents.consoleErrors = [...new Set(consoleLines)];
  }

  if (options.mode !== 'desktop') {
    const mobileContext = { ...contextOptions, ...VIEWPORTS.mobile };
    const mobile = await captureMobile(browser, mobileContext, options, outDir);
    report.platformerMobile = mobile.platformerMobile;
    if (!report.puzzle) report.puzzle = {};
    report.puzzle.mobile = mobile.puzzleMobile;
    consoleLines.push(...mobile.console.consoleErrors);
    report.documents.pageErrors = [
      ...new Set([...(report.documents.pageErrors ?? []), ...mobile.console.pageErrors]),
    ];
  }

  report.documents.consoleErrors = [...new Set(consoleLines)];
  const allConsole = report.documents.consoleErrors;
  report.documents.hostInjectedScriptBlocked = allConsole.some((line) =>
    /Content Security Policy.*cloudflareinsights|cloudflareinsights.*Content Security Policy/i.test(line),
  )
    ? 'https://static.cloudflareinsights.com/beacon.min.js/... was blocked by the generated CSP'
    : null;
  report.documents.consoleErrors = allConsole.filter(
    (line) => !/cloudflareinsights/i.test(line),
  );

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const report = await captureAll(browser, options);
    process.stdout.write(
      `wrote ${join(options.outDir, 'report.json')} at ${report.sourceHead} ` +
        `(platformer ${report.platformerMobile?.canvas?.join('x') ?? 'desktop only'}, ` +
        `desktop ${report.platformer?.canvas?.width ?? '?'}x${report.platformer?.canvas?.height ?? '?'})\n`,
    );
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { captureAll, parseArgs, documentSet };
