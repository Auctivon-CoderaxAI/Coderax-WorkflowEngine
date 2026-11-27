import { createHash } from 'node:crypto';

/** A deterministic PRNG. No game or test may depend on `Math.random`. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

export function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function seedFrom(text: string): number {
  const hash = createHash('sha256').update(text).digest();
  return hash.readUInt32BE(0) >>> 1;
}

/** Derives a level seed without depending on wall-clock time. */
export function levelSeed(base: number, index: number): number {
  return (Math.imul(base ^ (index + 1), 2654435761) >>> 0) % 2_147_483_647;
}
