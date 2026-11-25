/**
 * Player movement in the classic arena-shooter style: ground acceleration with
 * friction, weak air control that still allows air strafing, slide-along-walls,
 * and automatic stair stepping. All speeds are map units per second.
 */
import { add, addScaled, copy, cross, dot, set, vec3, type Vec3 } from "../math/vec3";
import type { Tracer } from "./collision";
import type { PlayerCommand } from "./command";

export const MOVE = {
  gravity: 800,
  maxSpeed: 320,
  /** Ground speed multiplier while sprinting forward. Air control is unchanged. */
  sprintFactor: 1.75,
  accelerate: 10,
  airAccelerate: 10,
  /** Cap on wish speed used for air acceleration; small value = air strafing, not air running. */
  airWishCap: 30,
  friction: 4,
  stopSpeed: 100,
  jumpSpeed: 270,
  stepHeight: 18,
  /** Surfaces with normal.z below this are too steep to stand on. */
  minWalkNormal: 0.7,
};

export const PLAYER_MINS: Readonly<Vec3> = Object.freeze(vec3(-16, -16, -24));
export const PLAYER_MAXS: Readonly<Vec3> = Object.freeze(vec3(16, 16, 32));
export const EYE_HEIGHT = 22;

export interface MoveState {
  origin: Vec3;
  velocity: Vec3;
  onGround: boolean;
  groundNormal: Vec3;
}

const STOP_EPSILON = 0.1;
const MAX_CLIP_PLANES = 5;

function clipVelocity(inVel: Vec3, normal: Vec3, out: Vec3, overbounce: number) {
  const backoff = dot(inVel, normal) * overbounce;
  out.x = inVel.x - normal.x * backoff;
  out.y = inVel.y - normal.y * backoff;
  out.z = inVel.z - normal.z * backoff;
  if (out.x > -STOP_EPSILON && out.x < STOP_EPSILON) out.x = 0;
  if (out.y > -STOP_EPSILON && out.y < STOP_EPSILON) out.y = 0;
  if (out.z > -STOP_EPSILON && out.z < STOP_EPSILON) out.z = 0;
}

/** Move along velocity for dt, sliding along anything hit. */
function slideMove(world: Tracer, s: MoveState, dt: number) {
  const original = vec3(s.velocity.x, s.velocity.y, s.velocity.z);
  const primal = vec3(s.velocity.x, s.velocity.y, s.velocity.z);
  const planes: Vec3[] = [];
  let timeLeft = dt;
  const end = vec3();

  for (let bump = 0; bump < 4; bump++) {
    addScaled(s.origin, s.velocity, timeLeft, end);
    const tr = world.traceBox(s.origin, end, PLAYER_MINS, PLAYER_MAXS);
    if (tr.allSolid) {
      set(s.velocity, 0, 0, 0);
      return;
    }
    if (tr.fraction > 0) {
      copy(s.origin, tr.endPos);
      copy(original, s.velocity);
      planes.length = 0;
    }
    if (tr.fraction === 1) return;

    timeLeft -= timeLeft * tr.fraction;
    if (planes.length >= MAX_CLIP_PLANES) {
      set(s.velocity, 0, 0, 0);
      return;
    }
    planes.push(vec3(tr.normal.x, tr.normal.y, tr.normal.z));

    // Find a velocity that runs parallel to every plane touched.
    let i = 0;
    for (; i < planes.length; i++) {
      clipVelocity(original, planes[i], s.velocity, 1);
      let j = 0;
      for (; j < planes.length; j++) if (j !== i && dot(s.velocity, planes[j]) < 0) break;
      if (j === planes.length) break;
    }
    if (i === planes.length) {
      // In a crease between two planes: slide along it.
      if (planes.length !== 2) {
        set(s.velocity, 0, 0, 0);
        return;
      }
      const dir = cross(planes[0], planes[1]);
      const d = dot(dir, s.velocity);
      set(s.velocity, dir.x * d, dir.y * d, dir.z * d);
    }
    // Don't bounce back the way we came (stops jitter in corners).
    if (dot(s.velocity, primal) <= 0) {
      set(s.velocity, 0, 0, 0);
      return;
    }
  }
}

/** Ground movement: try a plain slide, and a slide lifted by a stair height; keep whichever goes further. */
function groundMove(world: Tracer, s: MoveState, dt: number) {
  s.velocity.z = 0;
  if (s.velocity.x === 0 && s.velocity.y === 0) return;

  const dest = vec3(s.origin.x + s.velocity.x * dt, s.origin.y + s.velocity.y * dt, s.origin.z);
  let tr = world.traceBox(s.origin, dest, PLAYER_MINS, PLAYER_MAXS);
  if (tr.fraction === 1) {
    copy(s.origin, tr.endPos);
    return;
  }

  const startOrigin = vec3(s.origin.x, s.origin.y, s.origin.z);
  const startVel = vec3(s.velocity.x, s.velocity.y, s.velocity.z);

  // Plain slide.
  slideMove(world, s, dt);
  const downOrigin = vec3(s.origin.x, s.origin.y, s.origin.z);
  const downVel = vec3(s.velocity.x, s.velocity.y, s.velocity.z);

  // Lifted slide.
  copy(s.origin, startOrigin);
  copy(s.velocity, startVel);
  const up = add(s.origin, vec3(0, 0, MOVE.stepHeight));
  tr = world.traceBox(s.origin, up, PLAYER_MINS, PLAYER_MAXS);
  if (!tr.startSolid && !tr.allSolid) copy(s.origin, tr.endPos);
  slideMove(world, s, dt);
  const down = vec3(s.origin.x, s.origin.y, s.origin.z - MOVE.stepHeight);
  tr = world.traceBox(s.origin, down, PLAYER_MINS, PLAYER_MAXS);

  const useDown = () => {
    copy(s.origin, downOrigin);
    copy(s.velocity, downVel);
  };
  if (tr.plane && tr.normal.z < MOVE.minWalkNormal) return useDown();
  if (!tr.startSolid && !tr.allSolid) copy(s.origin, tr.endPos);

  const dd = (downOrigin.x - startOrigin.x) ** 2 + (downOrigin.y - startOrigin.y) ** 2;
  const ud = (s.origin.x - startOrigin.x) ** 2 + (s.origin.y - startOrigin.y) ** 2;
  if (dd > ud) return useDown();
  s.velocity.z = downVel.z;
}

function categorizePosition(world: Tracer, s: MoveState) {
  if (s.velocity.z > 180) {
    s.onGround = false;
    return;
  }
  const below = vec3(s.origin.x, s.origin.y, s.origin.z - 0.25);
  const tr = world.traceBox(s.origin, below, PLAYER_MINS, PLAYER_MAXS);
  if (tr.plane && tr.normal.z >= MOVE.minWalkNormal) {
    s.onGround = true;
    copy(s.groundNormal, tr.normal);
    if (!tr.startSolid && !tr.allSolid) copy(s.origin, tr.endPos);
  } else {
    s.onGround = false;
  }
}

function applyFriction(s: MoveState, dt: number) {
  const v = s.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed < 1) {
    v.x = 0;
    v.y = 0;
    return;
  }
  if (!s.onGround) return;
  const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
  const drop = control * MOVE.friction * dt;
  const k = Math.max(0, speed - drop) / speed;
  v.x *= k;
  v.y *= k;
  v.z *= k;
}

function accelerate(s: MoveState, wishDir: Vec3, wishSpeed: number, accel: number, dt: number) {
  const add = wishSpeed - dot(s.velocity, wishDir);
  if (add <= 0) return;
  const accelSpeed = Math.min(add, accel * dt * wishSpeed);
  addScaled(s.velocity, wishDir, accelSpeed, s.velocity);
}

function airAccelerate(s: MoveState, wishDir: Vec3, wishSpeed: number, dt: number) {
  const capped = Math.min(wishSpeed, MOVE.airWishCap);
  const add = capped - dot(s.velocity, wishDir);
  if (add <= 0) return;
  const accelSpeed = Math.min(add, MOVE.airAccelerate * wishSpeed * dt);
  addScaled(s.velocity, wishDir, accelSpeed, s.velocity);
}

/**
 * Walking down stairs or a ramp would otherwise leave the ground every tick and
 * fall in tiny hops. Snap down by up to a stair height if there's floor there.
 */
function stickToGround(world: Tracer, s: MoveState) {
  const down = vec3(s.origin.x, s.origin.y, s.origin.z - MOVE.stepHeight);
  const tr = world.traceBox(s.origin, down, PLAYER_MINS, PLAYER_MAXS);
  if (tr.startSolid || tr.allSolid || !tr.plane || tr.fraction === 0) return;
  if (tr.normal.z < MOVE.minWalkNormal) return;
  copy(s.origin, tr.endPos);
}

/** Advance one player by one tick. Mutates `s`. */
export function playerMove(world: Tracer, s: MoveState, cmd: PlayerCommand, dt: number) {
  categorizePosition(world, s);

  if (cmd.jump && s.onGround) {
    s.onGround = false;
    s.velocity.z += MOVE.jumpSpeed;
  }

  applyFriction(s, dt);

  // Wish direction on the horizontal plane (pitch doesn't affect walking).
  const cy = Math.cos(cmd.yaw);
  const sy = Math.sin(cmd.yaw);
  const fwd = Math.max(-1, Math.min(1, cmd.forward));
  const right = Math.max(-1, Math.min(1, cmd.right));
  // forward = (cy, sy, 0), right = (sy, -cy, 0)
  const top = cmd.sprint && fwd > 0 ? MOVE.maxSpeed * MOVE.sprintFactor : MOVE.maxSpeed;
  const wish = vec3((cy * fwd + sy * right) * top, (sy * fwd - cy * right) * top, 0);
  let wishSpeed = Math.hypot(wish.x, wish.y);
  const wishDir = wishSpeed > 0 ? vec3(wish.x / wishSpeed, wish.y / wishSpeed, 0) : vec3();
  if (wishSpeed > top) wishSpeed = top;

  if (s.onGround) {
    s.velocity.z = 0;
    accelerate(s, wishDir, wishSpeed, MOVE.accelerate, dt);
    groundMove(world, s, dt);
    stickToGround(world, s);
  } else {
    airAccelerate(s, wishDir, wishSpeed, dt);
    s.velocity.z -= MOVE.gravity * dt;
    slideMove(world, s, dt);
  }

  categorizePosition(world, s);
}
