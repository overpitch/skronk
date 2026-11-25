/** Plain mutable 3D vector. Functions write into `out` to avoid allocation in hot paths. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const add = (a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number, out: Vec3 = vec3()): Vec3 => set(out, a.x * s, a.y * s, a.z * s);
/** out = a + b * s */
export const addScaled = (a: Vec3, b: Vec3, s: number, out: Vec3 = vec3()): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export function normalize(a: Vec3, out: Vec3 = vec3()): Vec3 {
  const len = length(a);
  return len > 0 ? scale(a, 1 / len, out) : set(out, 0, 0, 0);
}

export const lerp = (a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
