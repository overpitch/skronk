/**
 * Moves Horde mode's monsters. Each goes for the nearest player (bots included),
 * along a flow field: for each player being hunted, the travel time from every
 * spot on the walk graph to them, open portals included (worked out a few times a
 * second). A monster just takes the step that leads most quickly downhill, so a
 * crowd of forty costs little more than one. Close and in plain sight it walks
 * straight at you; within reach it stops and swipes. Monsters keep a little apart
 * so a crowd spreads rather than stacking.
 *
 * Like bots it only produces commands; the sim moves them.
 */
import { vec3, type Vec3 } from "../math/vec3";
import { EYE_HEIGHT, PLAYER_MAXS } from "../sim/movement";
import { MONSTERS, type MonsterCommand, type MonsterState } from "../sim/monsters";
import type { PlayerState, World } from "../sim/world";
import type { NavGraph } from "./nav";
import { portalLinks } from "./portalLinks";

/** A flow field is worked out again this often (ticks), or sooner if its player has moved to another spot. */
const FIELD_TICKS = 20;
const FIELD_MIN_TICKS = 6;
/** Closer than this, with a clear line, it walks straight at you. */
const DIRECT_RANGE = 450;
/** Monsters closer than this to each other push apart. */
const PERSONAL_SPACE = 40;

export class MonsterDirector {
  private fields = new Map<number, { node: number; tick: number; cost: Float64Array }>();

  constructor(private nav: NavGraph) {}

  /** This tick's command for every living monster. */
  commands(world: World): Map<number, MonsterCommand> {
    const out = new Map<number, MonsterCommand>();
    const players = [...world.players.values()].filter((p) => p.alive);
    for (const id of this.fields.keys()) if (!players.some((p) => p.id === id)) this.fields.delete(id);
    for (const m of world.monsters) {
      if (!m.alive) continue;
      out.set(m.id, this.command(world, m, players));
    }
    return out;
  }

  private command(world: World, m: MonsterState, players: PlayerState[]): MonsterCommand {
    const idle: MonsterCommand = { forward: 0, yaw: m.yaw, jump: false, attack: false };
    // The nearest player.
    let target: PlayerState | null = null;
    let best = Infinity;
    for (const p of players) {
      const d = Math.hypot(p.origin.x - m.origin.x, p.origin.y - m.origin.y, (p.origin.z - m.origin.z) * 2);
      if (d < best) {
        best = d;
        target = p;
      }
    }
    if (!target) return idle;
    const spec = MONSTERS[m.kind];
    const dx = target.origin.x - m.origin.x;
    const dy = target.origin.y - m.origin.y;
    const flat = Math.hypot(dx, dy);
    const toTarget = Math.atan2(dy, dx);

    // Within reach: stop and swipe.
    if (flat < PLAYER_MAXS.x * 2 + spec.reach * 0.8 && Math.abs(target.origin.z - m.origin.z) < 40) {
      return { forward: 0, yaw: toTarget, jump: false, attack: true };
    }

    // Close and in plain sight: straight at them. Otherwise downhill on the flow field.
    let aim: Vec3 | null = null;
    let jump = false;
    if (flat < DIRECT_RANGE && Math.abs(target.origin.z - m.origin.z) < 40 && this.clear(world, m.origin, target.origin)) {
      aim = target.origin;
    } else {
      const step = this.downhill(world, m, target);
      if (step) {
        aim = step.aim;
        jump = step.jump;
      } else {
        aim = target.origin; // no route known: head their way anyway
      }
    }
    let sx = aim.x - m.origin.x;
    let sy = aim.y - m.origin.y;
    const len = Math.hypot(sx, sy) || 1;
    sx /= len;
    sy /= len;
    // Keep a little apart from the rest of the crowd.
    for (const o of world.monsters) {
      if (o === m || !o.alive) continue;
      const ox = m.origin.x - o.origin.x;
      const oy = m.origin.y - o.origin.y;
      const d = Math.hypot(ox, oy);
      if (d > 0.01 && d < PERSONAL_SPACE) {
        const push = ((PERSONAL_SPACE - d) / PERSONAL_SPACE) * 0.8;
        sx += (ox / d) * push;
        sy += (oy / d) * push;
      }
    }
    return { forward: 1, yaw: Math.atan2(sy, sx), jump, attack: false };
  }

  /** The next step towards `target` on its flow field: where to steer, and whether that step needs a jump. */
  private downhill(world: World, m: MonsterState, target: PlayerState): { aim: Vec3; jump: boolean } | null {
    const here = this.nav.nearest(m.origin);
    if (here < 0) return null;
    const links = portalLinks(world, this.nav);
    const cost = this.field(world, target, links);
    let bestCost = cost[here];
    let aim: Vec3 | null = null;
    let jump = false;
    const through = links.get(here);
    for (const e of through ? [...this.nav.nodes[here].edges, ...through] : this.nav.nodes[here].edges) {
      const c = e.cost + cost[e.to];
      if (c >= bestCost) continue;
      bestCost = c;
      aim = e.portal !== undefined ? e.aim : this.nav.nodes[e.to].pos;
      jump = e.jump;
    }
    return aim ? { aim, jump } : null;
  }

  private field(world: World, target: PlayerState, links: ReturnType<typeof portalLinks>): Float64Array {
    const node = this.nav.nearest(target.origin);
    const have = this.fields.get(target.id);
    const age = have ? world.tick - have.tick : Infinity;
    if (have && (age < FIELD_MIN_TICKS || (have.node === node && age < FIELD_TICKS))) return have.cost;
    const cost = this.nav.costsTo(node, links);
    this.fields.set(target.id, { node, tick: world.tick, cost });
    return cost;
  }

  /** Nothing solid between the two at chest height. */
  private clear(world: World, a: Vec3, b: Vec3): boolean {
    const zero = vec3();
    return world.collision.traceBox(vec3(a.x, a.y, a.z + EYE_HEIGHT * 0.5), vec3(b.x, b.y, b.z + EYE_HEIGHT * 0.5), zero, zero).fraction === 1;
  }
}
