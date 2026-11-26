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
  hud: string;
};

type Listener = (event: Record<string, unknown>) => void;

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
      hud: '',
    };
  }

  const width = 320;
  const height = 180;
  const raster = createRaster({ width, height });
  const listeners = new Map<string, Listener[]>();
  const frameQueue: { next: ((timestamp: number) => void) | null } = { next: null };

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
      querySelectorAll: () => [],
    },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      frameQueue.next = callback;
      return 1;
    },
    addEventListener: (type: string, listener: Listener) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
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
    const keydown = listeners.get('keydown')?.[0];
    if (keydown) keydown({ key: 'ArrowRight', preventDefault: () => undefined });

    let frames = 0;
    const limit = options.frames ?? 4;
    while (frames < limit) {
      const callback = frameQueue.next;
      if (!callback) break;
      frameQueue.next = null;
      callback(16 * (frames + 1));
      frames += 1;
    }
    const colors = raster.distinctColors();
    const hudText = hud.textContent;
    return {
      passed: frames >= 2 && colors >= 4 && hudText.includes('Level'),
      detail:
        frames < 2
          ? 'The animation loop never produced a frame.'
          : colors < 4
            ? 'The browser entry painted fewer than four colours.'
            : !hudText.includes('Level')
              ? 'The HUD never reported the level state.'
              : `The document booted ${scripts.length} inline scripts and painted ${frames} frames.`,
      scripts: scripts.length,
      frames,
      distinctColors: colors,
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
      hud: hud.textContent.slice(0, 120),
    };
  }
}
