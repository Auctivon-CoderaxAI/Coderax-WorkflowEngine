/**
 * Deterministic bytes for storage tests. A seeded linear congruential generator
 * keeps the fixture reproducible while still exercising multi-chunk payloads.
 */
export function cryptoRandomBytes(length: number, seed = 0x12345678): Buffer {
  const output = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = state & 0xff;
  }
  return output;
}
