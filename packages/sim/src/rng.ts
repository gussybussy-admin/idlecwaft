// Seeded, serializable PRNG (sfc32). Its whole state lives in the save, so a simulation
// replayed from the same state always produces the same outcome.
export type RngState = [number, number, number, number];

export function seedRng(seed: number): RngState {
  const s: RngState = [0x9e3779b9, 0x243f6a88, 0xb7e15162, seed >>> 0];
  for (let i = 0; i < 12; i++) next(s);
  return s;
}

/** Uniform float in [0, 1). Mutates the state. */
export function next(s: RngState): number {
  let [a, b, c, d] = s;
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  c = (c + t) >>> 0;
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
  return t / 4294967296;
}

/** Integer in [min, max] inclusive. */
export function int(s: RngState, min: number, max: number): number {
  return min + Math.floor(next(s) * (max - min + 1));
}

/** True with probability `percent` / 100. */
export function chance(s: RngState, percent: number): boolean {
  return next(s) * 100 < percent;
}
