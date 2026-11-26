/**
 * Copying a world's state into a snapshot (on the server) and a snapshot into a
 * world (on a client). The client's World is a mirror: it's never stepped, just
 * overwritten, so the renderer and HUD draw it exactly as they draw a local game.
 */
import { set, vec3, type Vec3 } from "../math/vec3";
import type { World } from "../sim/world";
import type { PlayerSnap, V3, WorldSnapshot } from "./protocol";

const v3 = (v: Vec3): V3 => [v.x, v.y, v.z];
const into = (out: Vec3, a: V3) => set(out, a[0], a[1], a[2]);

export function captureSnapshot(world: World): WorldSnapshot {
  const players: PlayerSnap[] = [...world.players.values()].map((p) => ({
    id: p.id,
    team: p.team,
    origin: v3(p.origin),
    prev: v3(p.prevOrigin),
    velocity: v3(p.velocity),
    yaw: p.yaw,
    pitch: p.pitch,
    onGround: p.onGround,
    alive: p.alive,
    health: p.health,
    armor: p.armor,
    ammo: p.ammo,
    frags: p.frags,
    deaths: p.deaths,
    respawnTick: p.respawnTick,
    fireCooldown: p.fireCooldown,
    portalCooldown: p.portalCooldown,
    portalHeld: p.portalHeld,
  }));
  return {
    tick: world.tick,
    players,
    projectiles: world.projectiles.map((pr) => ({
      id: pr.id,
      owner: pr.owner,
      origin: v3(pr.origin),
      prev: v3(pr.prevOrigin),
      velocity: v3(pr.velocity),
      hops: pr.hops,
    })),
    portals: world.portals.map((p) => ({ ...p })),
    pickups: world.pickups.map((pk) => pk.availableAtTick),
    events: world.events,
  };
}

/** Makes `world` match the snapshot: players come and go, everything else is overwritten. */
export function applySnapshot(world: World, snap: WorldSnapshot) {
  world.tick = snap.tick;
  const present = new Set(snap.players.map((p) => p.id));
  for (const id of [...world.players.keys()]) if (!present.has(id)) world.removePlayer(id);
  for (const s of snap.players) {
    const p = world.players.get(s.id) ?? world.addPlayer(s.id, s.team);
    p.team = s.team;
    into(p.origin, s.origin);
    into(p.prevOrigin, s.prev);
    into(p.velocity, s.velocity);
    p.yaw = s.yaw;
    p.pitch = s.pitch;
    p.onGround = s.onGround;
    p.alive = s.alive;
    p.health = s.health;
    p.armor = s.armor;
    p.ammo = s.ammo;
    p.frags = s.frags;
    p.deaths = s.deaths;
    p.respawnTick = s.respawnTick;
    p.fireCooldown = s.fireCooldown;
    p.portalCooldown = s.portalCooldown;
    p.portalHeld = s.portalHeld;
  }
  world.projectiles.length = 0;
  for (const s of snap.projectiles) {
    world.projectiles.push({
      id: s.id,
      owner: s.owner,
      origin: into(vec3(), s.origin),
      prevOrigin: into(vec3(), s.prev),
      velocity: into(vec3(), s.velocity),
      hops: s.hops,
    });
  }
  world.restorePortals(snap.portals);
  snap.pickups.forEach((at, i) => {
    if (world.pickups[i]) world.pickups[i].availableAtTick = at;
  });
  world.events = snap.events;
}
