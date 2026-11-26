/**
 * A bot carrying out a portal plan (portalPlanner.ts), one tick at a time:
 *
 * 1. walk to where the exit can be shot from, stop, aim, fire;
 * 2. walk to where the entry wall can be shot from, aim, fire;
 * 3. head for the goal: the open pair is now a shortcut its route can take.
 *
 * A shot that doesn't land on its spot is tried once more, then the plan is
 * dropped (and that spot avoided for a while). The whole thing gives up after
 * JOB_TICKS, or if it can't get where it needs to stand.
 */
import type { Vec3 } from "../math/vec3";
import type { PlayerState, World } from "../sim/world";
import { closeTo, type NavGraph } from "./nav";
import type { Navigator, Steer } from "./navigator";
import { onSpot, type PortalPlan, type PortalShotAim, type PortalSpot } from "./portalPlanner";

/** Longest a portal job may take, start to finish. */
const JOB_TICKS = 25 * 60;
/** Aim this close (radians) before firing. */
const AIM_CLOSE = 0.012;
/** After pressing, how long to wait to hear whether the portal went up. */
const RESULT_TICKS = 4;
const MAX_TRIES = 2;
/** Standing still enough to shoot accurately. */
const STEADY_SPEED = 60;

const TAU = Math.PI * 2;
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);
const STAND: Steer = { dir: null, jump: false };

export interface JobTick {
  steer: Steer;
  /** Where to look (to aim a portal), or null to look where it's going. */
  look: { yaw: number; pitch: number } | null;
  /** Press the portal trigger this tick. */
  portal: boolean;
}

export class PortalJob {
  stage: "exit" | "entry" | "go" | "done" | "failed" = "exit";
  /** The spot that let it down, if it failed on a shot. */
  failedSpot: PortalSpot | null = null;
  private tries = 0;
  /** Tick the trigger was pressed, while waiting to see where the portal went. */
  private pressedAt = -1;
  private readonly started: number;

  constructor(
    readonly plan: PortalPlan,
    readonly goal: Vec3,
    tick: number,
  ) {
    this.started = tick;
  }

  get active(): boolean {
    return this.stage !== "done" && this.stage !== "failed";
  }

  tick(world: World, me: PlayerState, nav: Navigator, graph: NavGraph, view: { yaw: number; pitch: number }): JobTick {
    if (world.tick - this.started > JOB_TICKS) return this.fail(null);
    if (this.stage === "go") {
      nav.goTo(this.goal);
      if (nav.unreachable) return this.fail(null);
      if (nav.arrived || closeTo(me.origin, this.goal)) this.stage = "done";
      return { steer: nav.steer(world, me), look: null, portal: false };
    }
    if (!this.active) return { steer: STAND, look: null, portal: false };

    const spot = this.stage === "exit" ? this.plan.exit : this.plan.entry;
    const shot: PortalShotAim = this.stage === "exit" ? this.plan.exitShot : this.plan.entry.entry!;
    if (this.pressedAt >= 0) {
      // Where did it go?
      const fired = world.events.find((e) => e.type === "portalShot" && e.player === me.id);
      if (fired?.type === "portalShot") {
        this.pressedAt = -1;
        const placed = world.portals.find((p) => p.id === fired.portal);
        if (placed && onSpot(placed, spot)) {
          this.stage = this.stage === "exit" ? "entry" : "go";
          this.tries = 0;
          return { steer: STAND, look: null, portal: false };
        }
        if (++this.tries >= MAX_TRIES) return this.fail(spot);
      } else if (world.tick - this.pressedAt > RESULT_TICKS) {
        this.pressedAt = -1;
        if (++this.tries >= MAX_TRIES) return this.fail(spot);
      } else {
        return { steer: STAND, look: { yaw: shot.yaw, pitch: shot.pitch }, portal: false };
      }
    }

    // Get to where it's shot from.
    const stand = graph.nodes[shot.node].pos;
    if (!closeTo(me.origin, stand)) {
      nav.goTo(stand);
      if (nav.unreachable) return this.fail(null);
      return { steer: nav.steer(world, me), look: null, portal: false };
    }
    // There: stop, aim, and fire when steady and lined up.
    const aimed = Math.abs(wrap(view.yaw - shot.yaw)) < AIM_CLOSE && Math.abs(view.pitch - shot.pitch) < AIM_CLOSE;
    const steady = Math.hypot(me.velocity.x, me.velocity.y) < STEADY_SPEED && me.onGround;
    const press = aimed && steady && me.portalCooldown === 0 && !me.portalHeld;
    if (press) this.pressedAt = world.tick;
    return { steer: STAND, look: { yaw: shot.yaw, pitch: shot.pitch }, portal: press };
  }

  private fail(spot: PortalSpot | null): JobTick {
    this.stage = "failed";
    this.failedSpot = spot;
    return { steer: STAND, look: null, portal: false };
  }
}
