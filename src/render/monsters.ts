/**
 * Monster bodies (Horde mode). The shambler: a hunched, grey-green figure in
 * torn clothes, arms reaching forward. It shuffles towards you, rears back and
 * swipes (the wind-up shows, so you can step away), falls forward when killed
 * and sinks into the floor before the corpse goes.
 *
 * Model space as for players: +X forward, +Z up, origin at the monster's origin
 * (24 above its feet). Two levels of detail from the quality profile: rounded
 * limbs and a ragged shirt in Full, plain blocks in Light.
 */
import * as THREE from "three";
import { MOVE, PLAYER_MINS } from "../sim/movement";
import { CORPSE_TICKS, MONSTERS, type MonsterState } from "../sim/monsters";
import { TICK_RATE } from "../sim/tick";

const FEET = PLAYER_MINS.z;
const SKIN = 0x7d8a63;
const CLOTH = 0x5a4a3a;
const DARK = 0x2a2620;
const EYES = 0xffd24a;
const HIT_FLASH_SECONDS = 0.12;
/** A shuffle: short, slow strides. */
const STRIDE = 60;

interface Body {
  root: THREE.Group;
  fall: THREE.Group;
  hips: [THREE.Group, THREE.Group];
  chest: THREE.Group;
  arms: [THREE.Group, THREE.Group];
  skin: THREE.MeshLambertMaterial;
  phase: number;
  flash: number;
  /** For drawing between ticks. */
  x: number;
  y: number;
  z: number;
  seen: boolean;
}

export class MonsterModels {
  private bodies = new Map<number, Body>();
  private cloth = new THREE.MeshLambertMaterial({ color: CLOTH });
  private dark = new THREE.MeshLambertMaterial({ color: DARK });
  private eyes = new THREE.MeshBasicMaterial({ color: EYES });

  constructor(
    private scene: THREE.Scene,
    private detailed: boolean,
    private castShadows: boolean,
  ) {}

  /** Places every monster for this frame (interpolated between ticks) and animates it. */
  update(monsters: readonly MonsterState[], alpha: number, tick: number, dt: number) {
    for (const b of this.bodies.values()) b.seen = false;
    for (const m of monsters) {
      let b = this.bodies.get(m.id);
      if (!b) this.bodies.set(m.id, (b = this.build()));
      b.seen = true;
      b.x = m.prevOrigin.x + (m.origin.x - m.prevOrigin.x) * alpha;
      b.y = m.prevOrigin.y + (m.origin.y - m.prevOrigin.y) * alpha;
      b.z = m.prevOrigin.z + (m.origin.z - m.prevOrigin.z) * alpha;
      this.animate(b, m, tick, dt);
    }
    for (const [id, b] of this.bodies) {
      if (b.seen) continue;
      this.scene.remove(b.root);
      b.skin.dispose();
      this.bodies.delete(id);
    }
  }

  /** It was hit: a flash. */
  hit(id: number) {
    const b = this.bodies.get(id);
    if (b) b.flash = HIT_FLASH_SECONDS;
  }

  private animate(b: Body, m: MonsterState, tick: number, dt: number) {
    b.root.position.set(b.x, b.y, b.z);
    b.root.rotation.z = m.yaw;
    b.flash = Math.max(0, b.flash - dt);
    b.skin.emissiveIntensity = (b.flash / HIT_FLASH_SECONDS) * 0.9;
    if (!m.alive) {
      // Down on its face, then sinking out of sight.
      const since = (tick - m.diedTick) / TICK_RATE;
      const t = Math.min(1, since / 0.4);
      b.fall.rotation.y = t * t * (Math.PI / 2);
      const sinkFrom = CORPSE_TICKS / TICK_RATE - 1.2;
      b.fall.position.z = FEET - Math.max(0, since - sinkFrom) * 30;
      return;
    }
    b.fall.rotation.y = 0;
    b.fall.position.z = FEET;
    const speed = Math.hypot(m.velocity.x, m.velocity.y);
    b.phase += (speed * dt * Math.PI * 2) / STRIDE;
    const swing = Math.min(1, speed / (MOVE.maxSpeed * 0.3)) * 0.45;
    for (let i = 0; i < 2; i++) b.hips[i].rotation.y = -Math.sin(b.phase + i * Math.PI) * swing;
    // A lurch from side to side as it shuffles.
    b.chest.rotation.x = Math.sin(b.phase) * 0.08;
    // Arms: reaching forward, bobbing; winding up a swipe they rear back, then come down.
    const spec = MONSTERS[m.kind];
    const wind = m.windup > 0 ? 1 - m.windup / spec.windupTicks : 0;
    for (let i = 0; i < 2; i++) {
      const reach = -1.35 + Math.sin(b.phase * 0.5 + i) * 0.08;
      b.arms[i].rotation.y = m.windup > 0 ? reach - Math.sin(wind * Math.PI) * 1.6 : reach;
    }
  }

  private build(): Body {
    const d = this.detailed;
    const skin = new THREE.MeshLambertMaterial({ color: SKIN, emissive: 0xffffff, emissiveIntensity: 0 });
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      return m;
    };
    /** across (y), deep (x), tall (z) */
    const block = (across: number, deep: number, tall: number, mat: THREE.Material, x = 0, y = 0, z = 0) => mesh(new THREE.BoxGeometry(deep, across, tall), mat, x, y, z);
    const limb = (len: number, r: number, mat: THREE.Material) => {
      const geo = d ? new THREE.CapsuleGeometry(r, Math.max(0.1, len - 2 * r), 4, 8) : new THREE.BoxGeometry(r * 2, r * 2, len);
      if (d) geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.z = -len / 2;
      return m;
    };

    const root = new THREE.Group();
    const fall = new THREE.Group();
    fall.position.z = FEET;
    root.add(fall);
    const inner = new THREE.Group();
    inner.position.z = -FEET;
    fall.add(inner);

    // Legs: knock-kneed, a little bent.
    const hips: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(0, side * 5, FEET + 25);
      inner.add(hip);
      hip.add(limb(25, 3, side > 0 ? this.cloth : skin));
      hip.add(block(5, 8, 3, this.dark, 2, 0, -24)); // foot
      hips.push(hip);
    }
    inner.add(block(14, 9, 7, this.cloth, 0, 0, FEET + 27)); // hips and rags

    // Torso, hunched well forward.
    const chest = new THREE.Group();
    chest.position.z = FEET + 30;
    chest.rotation.y = 0.45;
    inner.add(chest);
    chest.add(block(16, 10, 18, d ? this.cloth : skin, 0, 0, 9));
    if (d) {
      chest.add(block(15, 10.4, 6, skin, 0, 0, 16)); // bare shoulders above the torn shirt
      chest.add(block(4, 10.6, 9, skin, 1, 3, 6)); // a rip in the shirt
    }
    // Head lolling forward.
    const head = new THREE.Group();
    head.position.set(3, 0, 19);
    head.rotation.y = 0.35;
    chest.add(head);
    head.add(d ? mesh(new THREE.SphereGeometry(5, 10, 8), skin, 0, 0, 4) : block(9, 9, 9, skin, 0, 0, 4));
    head.add(block(1.5, 1, 1.5, this.eyes, 4.6, 2, 5), block(1.5, 1, 1.5, this.eyes, 4.6, -2, 5));
    head.add(block(4, 1, 1.4, this.dark, 4.6, 0, 1.5)); // mouth

    // Arms out in front, from the shoulders.
    const arms: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.position.set(0, side * 9.5, 16);
      chest.add(arm);
      arm.add(limb(24, 2.4, skin));
      arm.add(block(3.5, 3.5, 4, skin, 0, 0, -25)); // hand
      arms.push(arm);
    }

    if (this.castShadows) root.traverse((o) => (o.castShadow = true));
    this.scene.add(root);
    return { root, fall, hips: [hips[0], hips[1]], chest, arms: [arms[0], arms[1]], skin, phase: Math.random() * 6, flash: 0, x: 0, y: 0, z: 0, seen: true };
  }
}
