import vm from 'node:vm';
import { createRaster } from './frame.js';

/**
 * A minimal browser boot for the generated entry document.
 *
 * This is not a real browser: it does not enforce the CSP, load from a network,
 * or provide a GPU canvas. It does execute the exact inlined scripts, in order,
 * with the DOM surface `main.js` uses, then drives its `requestAnimationFrame`
 * loop. That catches the class of defect a source-only check misses: a preview
 * that references files the endpoint never serves, a module that throws before
 * the first paint, or a HUD that never updates. Real-browser and mobile
 * verification remains a separate capability and is reported as blocked when no
 * zero-cost cloud browser is available.
 */

export type BrowserBoot = {
  passed: boolean;
  detail: string;
  scripts: number;
  frames: number;
  distinctColors: number;
  touchDelta: number;
  jumpVy: number;
  hud: string;
};

type Listener = (event: Record<string, unknown>) => void;

type FakeButton = {
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, listener: Listener) => void;
  fire: (type: string) => void;
};

type FakeCanvas = {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  getContext: (kind: string) => unknown;
};

export function bootGeneratedDocument(
  html: string,
  options: { frames?: number } = {},
): BrowserBoot {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) {
    return {
      passed: false,
      detail: 'The document has no inline scripts to boot.',
      scripts: 0,
      frames: 0,
      distinctColors: 0,
      touchDelta: 0,
      jumpVy: 0,
      hud: '',
    };
  }

  const width = 320;
  const height = 180;
  const raster = createRaster({ width, height });
  const frameQueue: { next: ((timestamp: number) => void) | null } = { next: null };
  const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);
  const buttons = new Map<string, FakeButton>();
  for (const action of actions) {
    const handlers = new Map<string, Listener[]>();
    buttons.set(action, {
      getAttribute: (name: string) => (name === 'data-action' ? action : null),
      addEventListener: (type: string, listener: Listener) => {
        handlers.set(type, [...(handlers.get(type) ?? []), listener]);
      },
      fire: (type: string) => {
        for (const listener of handlers.get(type) ?? []) {
          listener({ preventDefault: () => undefined });
        }
      },
    });
  }

  const canvas: FakeCanvas = {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    getContext: (kind: string) => (kind === '2d' ? raster.context : null),
  };
  const hud = { textContent: '' };
  const overlay = { textContent: '', style: { display: '' } };
  const mute = { textContent: '', addEventListener: (): void => undefined };
  const elements = new Map<string, unknown>([
    ['game', canvas],
    ['hud', hud],
    ['overlay', overlay],
    ['mute', mute],
  ]);

  const sandbox: Record<string, unknown> = {
    console,
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (selector: string) =>
        selector === '[data-action]' ? [...buttons.values()] : [],
    },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      frameQueue.next = callback;
      return 1;
    },
    addEventListener: () => undefined,
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox, {
    name: 'coderax-game-browser-boot',
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    for (const script of scripts) {
      vm.runInContext(script, context, { timeout: 2_000, filename: 'generated-inline.js' });
    }
    const hook = vm.runInContext('globalThis.__CODERAX_GAME__', context) as () => {
      state: { player: { x: number; vy: number } };
    };
    const right = buttons.get('right');
    const left = buttons.get('left');
    const rightStart = hook().state.player.x;
    right?.fire('mousedown');

    let frames = 0;
    const limit = Math.max(12, options.frames ?? 12);
    const stepFrames = (count: number): void => {
      for (let index = 0; index < count && frames < limit; index += 1) {
        const callback = frameQueue.next;
        if (!callback) return;
        frameQueue.next = null;
        callback(16 * (frames + 1));
        frames += 1;
      }
    };
    stepFrames(4);
    const rightDelta = hook().state.player.x - rightStart;
    right?.fire('mouseup');

    const leftStart = hook().state.player.x;
    left?.fire('mousedown');
    stepFrames(4);
    const leftDelta = leftStart - hook().state.player.x;
    left?.fire('mouseup');
    const touchDelta = Math.max(Math.abs(rightDelta), Math.abs(leftDelta));

    const jump = buttons.get('jump');
    jump?.fire('mousedown');
    stepFrames(2);
    const jumpVy = jump ? hook().state.player.vy : 0;
    jump?.fire('mouseup');

    const colors = raster.distinctColors();
    const hudText = hud.textContent;
    const healthReported = /Health 3\b/.test(hudText);
    const jumpPassed = jump ? jumpVy < 0 : true;
    const passed =
      frames >= 4 && colors >= 4 && hudText.includes('Level') && touchDelta > 2 && healthReported && jumpPassed;
    return {
      passed,
      detail:
        frames < 4
          ? 'The animation loop never produced enough frames.'
          : colors < 4
            ? 'The browser entry painted fewer than four colours.'
            : !hudText.includes('Level')
              ? 'The HUD never reported the level state.'
              : !healthReported
                ? 'The HUD did not report the player health.'
                : touchDelta <= 2
                  ? 'The on-screen control did not move the player.'
                  : !jumpPassed
                    ? 'The on-screen jump control did not apply an upward impulse.'
                    : `The document booted ${scripts.length} inline scripts, moved ${Math.round(touchDelta)} units from an on-screen control and painted ${frames} frames.`,
      scripts: scripts.length,
      frames,
      distinctColors: colors,
      touchDelta: Math.round(touchDelta * 100) / 100,
      jumpVy: Math.round(jumpVy),
      hud: hudText.slice(0, 120),
    };
  } catch (error) {
    return {
      passed: false,
      detail: `The document threw before it could play: ${
        error instanceof Error ? error.message : 'unknown error'
      }`.slice(0, 600),
      scripts: scripts.length,
      frames: 0,
      distinctColors: raster.distinctColors(),
      touchDelta: 0,
      jumpVy: 0,
      hud: hud.textContent.slice(0, 120),
    };
  }
}
