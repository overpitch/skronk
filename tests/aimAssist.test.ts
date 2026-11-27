import { describe, expect, it } from "vitest";
import { vec3 } from "../src/math/vec3";
import { AIM_ASSIST, aimAssist } from "../src/client/aimAssist";
import { stickResponse } from "../src/client/localInput";

const eye = vec3(0, 0, 0);
const DT = 1 / 60;
/** A target `d` ahead along +X, `side` to the left, moving at `vy` across your view. */
const target = (d: number, side = 0, vy = 0) => ({ centre: vec3(d, side, 0), velocity: vec3(0, vy, 0) });

describe("aim assist", () => {
  it("does nothing with no enemy near the crosshair", () => {
    expect(aimAssist(eye, 0, 0, [], 1, DT)).toEqual({ scale: 1, yaw: 0, pitch: 0 });
    // 30 degrees off: well outside the zone.
    expect(aimAssist(eye, 0, 0, [target(500, 290)], 1, DT).scale).toBe(1);
  });

  it("slows the stick right on a target, less towards the edge of its zone", () => {
    const on = aimAssist(eye, 0, 0, [target(500)], 0, DT);
    expect(on.scale).toBeCloseTo(AIM_ASSIST.slowest, 5);
    const near = aimAssist(eye, 0, 0, [target(500, 40)], 0, DT);
    expect(near.scale).toBeGreaterThan(on.scale);
    expect(near.scale).toBeLessThan(1);
  });

  it("never moves your view while the sticks are at rest", () => {
    const r = aimAssist(eye, 0, 0, [target(500, 30, 300)], 0, DT);
    expect([r.yaw, r.pitch]).toEqual([0, 0]);
  });

  it("pulls gently towards a target while you're aiming, no faster than its rate", () => {
    const r = aimAssist(eye, 0, 0, [target(500, 30)], 1, DT);
    expect(r.yaw).toBeGreaterThan(0); // the target is to the left: counter-clockwise
    expect(r.yaw).toBeLessThanOrEqual(AIM_ASSIST.pullRate * DT + 1e-9);
  });

  it("follows some of a target's sideways movement", () => {
    const still = aimAssist(eye, 0, 0, [target(500)], 1, DT);
    const moving = aimAssist(eye, 0, 0, [target(500, 0, 300)], 1, DT);
    expect(moving.yaw).toBeGreaterThan(still.yaw);
  });

  it("gives a bigger zone to a closer target", () => {
    // The same angle off the crosshair: inside the zone up close, outside far away.
    expect(aimAssist(eye, 0, 0, [target(300, 40)], 0, DT).scale).toBeLessThan(1);
    expect(aimAssist(eye, 0, 0, [target(2000, 40 * (2000 / 300))], 0, DT).scale).toBe(1);
  });
});

describe("stick response", () => {
  it("gives fine control near the centre and full speed at the edge", () => {
    expect(stickResponse(1)).toBe(1);
    expect(stickResponse(-1)).toBe(-1);
    expect(stickResponse(0.3)).toBeLessThan(0.1); // a small push turns slowly
    expect(stickResponse(0.5)).toBeGreaterThan(stickResponse(0.3));
  });
});
