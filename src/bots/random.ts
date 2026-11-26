/** Small deterministic hash to 0..1, so bots vary without Math.random (same inputs, same game). */
export function hash(n: number): number {
  let x = Math.imul(n | 0, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** -1..1 from a hash. */
export const signedHash = (n: number) => hash(n) * 2 - 1;
