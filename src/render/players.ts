/**
 * Player bodies: a humanoid built from simple shapes, in the player's colour,
 * holding the gun. Two levels of detail, from the quality profile: rounded
 * limbs, helmet and armour in Full; plain blocks and fewer parts in Light.
 *
 * Purely for show: the hit box is still the box the sim uses (32 wide, 56 tall),
 * which the body fills. Animated here from what the sim says each player is
 * doing: legs stride the way they're moving, the upper body and gun follow
 * their aim, the gun kicks when they fire, legs tuck in the air, and they fall
 * over when fragged and lie there until they respawn.
 *
 * Model space: +X forward (yaw 0), +Y left, +Z up, origin at the player's origin
 * (24 above the feet), like the sim.
 */
import * as THREE from "three";
import type { PlayerId } from "../sim/events";
import { MOVE, PLAYER_MINS } from "../sim/movement";
import type { WeaponId } from "../sim/weapons";

/** Team colours (1, 2); free-for-all players (team 0) each get one from PLAYER_COLORS by id. */
const TEAM_COLORS: Record<number, number> = { 1: 0xc84848, 2: 0x4878c8 };
const PLAYER_COLORS = [0xd2643c, 0x3cb4d2, 0x8ad23c, 0xd23c8a, 0xd2c83c, 0x9a6cff, 0x3cd28a, 0xe0e0e0];
const ARMOUR_COLOR = 0x30343c;
const GUN_COLOR = 0x23262c;
const VISOR_COLOR = 0x7fe8ff;
const HIT_FLASH_SECONDS = 0.12;

/** Feet, relative to the origin. */
const FEET = PLAYER_MINS.z;
/** Joint heights relative to the origin. */
const HIP_Z = FEET + 26;
const SHOULDER_Z = FEET + 43;
const NECK_Z = FEET + 45;
const HIP_Y = 5;
const THIGH = 13;
const SHIN = 13;
const LIMB_R = 3.2;
/** Units of travel per stride (one leg forward and back). */
const STRIDE = 96;
/** Seconds to topple when fragged. */
const FALL_SECONDS = 0.35;
const RECOIL_RECOVERY = 14; // per second

/** What the renderer tells a body each frame. */
export interface BodyState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Radians, positive looks up. */
  pitch: number;
  vx: number;
  vy: number;
  onGround: boolean;
  alive: boolean;
  /** Spawn protection: the body shimmers. */
  shielded: boolean;
  /** The weapon in their hands. */
  weapon: WeaponId;
}

interface Body {
  root: THREE.Group;
  /** Pivot at the feet, for falling over. */
  fall: THREE.Group;
  /** Turned towards the way the legs are walking. */
  legs: THREE.Group;
  hips: [THREE.Group, THREE.Group];
  knees: [THREE.Group, THREE.Group];
  /** Leans a little with the aim; holds head and arms. */
  chest: THREE.Group;
  head: THREE.Group;
  /** Shoulders, arms and gun: pitch with the aim. */
  aim: THREE.Group;
  gun: THREE.Group;
  /** One model per weapon inside `gun`; the one in hand is shown. */
  guns: Map<WeaponId, THREE.Group>;
  bodyMat: THREE.MeshLambertMaterial;
  state: BodyState;
  flash: number;
  phase: number;
  swing: number;
  legAngle: number;
  air: number;
  recoil: number;
  /** Seconds since fragged, or -1 while alive. */
  deadFor: number;
  /** Clock for the spawn protection shimmer. */
  shimmer: number;
}

const Z = new THREE.Vector3(0, 0, 1);

export class PlayerModels {
  private bodies = new Map<PlayerId, Body>();
  private geos = new Map<string, THREE.BufferGeometry>();
  private armourMat = new THREE.MeshLambertMaterial({ color: ARMOUR_COLOR });
  private gunMat = new THREE.MeshLambertMaterial({ color: GUN_COLOR });
  private visorMat = new THREE.MeshBasicMaterial({ color: VISOR_COLOR });
  private woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
  private redMat = new THREE.MeshLambertMaterial({ color: 0x8c2a22 });
  private railMat = new THREE.MeshBasicMaterial({ color: 0x7ff0ff });

  constructor(
    private scene: THREE.Scene,
    /** Full detail: rounded shapes and extra armour pieces. */
    private detailed = false,
    /** Bodies cast shadows (Full quality). */
    private castShadows = false,
    /** Weapons with glow strips and trim. */
    private detailedWeapons = false,
  ) {}

  /** Make sure a body exists for each id in `ids`, and remove the rest. */
  sync(ids: Iterable<PlayerId>, teamOf: (id: PlayerId) => number) {
    const keep = new Set(ids);
    for (const [id, b] of this.bodies) {
      if (keep.has(id)) continue;
      this.scene.remove(b.root);
      b.bodyMat.dispose();
      this.bodies.delete(id);
    }
    for (const id of keep) {
      if (!this.bodies.has(id)) this.bodies.set(id, this.build(id, teamOf(id)));
    }
  }

  place(id: PlayerId, state: BodyState) {
    const b = this.bodies.get(id);
    if (b) b.state = state;
  }

  /** Puts a body on one render layer only (the local player's lives on the portal-only layer). */
  setLayer(id: PlayerId, layer: number) {
    const b = this.bodies.get(id);
    if (!b || b.root.userData.layer === layer) return;
    b.root.userData.layer = layer;
    b.root.traverse((o) => o.layers.set(layer));
  }

  hit(id: PlayerId) {
    const b = this.bodies.get(id);
    if (b) b.flash = HIT_FLASH_SECONDS;
  }

  /** Their gun went off: a kick back. */
  fired(id: PlayerId) {
    const b = this.bodies.get(id);
    if (b) b.recoil = 1;
  }

  update(dt: number) {
    for (const b of this.bodies.values()) this.animate(b, dt);
  }

  private animate(b: Body, dt: number) {
    const s = b.state;
    b.root.position.set(s.x, s.y, s.z);
    b.root.rotation.z = s.yaw;
    b.flash = Math.max(0, b.flash - dt);
    b.shimmer += dt;
    const glow = s.shielded && s.alive ? 0.3 + 0.2 * Math.sin(b.shimmer * 14) : 0;
    b.bodyMat.emissiveIntensity = Math.max(glow, (b.flash / HIT_FLASH_SECONDS) * 0.8);

    // Fragged: topple backwards and lie there until the respawn.
    if (!s.alive) {
      b.deadFor = b.deadFor < 0 ? 0 : b.deadFor + dt;
      const t = Math.min(1, b.deadFor / FALL_SECONDS);
      b.fall.rotation.y = -(t * t) * (Math.PI / 2);
      return;
    }
    if (b.deadFor >= 0) {
      b.deadFor = -1;
      b.fall.rotation.y = 0;
    }

    // Legs: stride the way they're moving (sideways and backwards too), harder the faster they go.
    const c = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    const forward = s.vx * c + s.vy * sn;
    const left = -s.vx * sn + s.vy * c;
    const speed = Math.hypot(forward, left);
    let angle = Math.atan2(left, forward);
    let dir = 1;
    if (Math.abs(angle) > Math.PI / 2) {
      angle -= Math.sign(angle) * Math.PI; // walking backwards: legs face forward, stride reversed
      dir = -1;
    }
    const ease = 1 - Math.exp(-12 * dt);
    if (speed > 20) b.legAngle += (angle - b.legAngle) * ease;
    b.legs.rotation.z = b.legAngle;
    const targetSwing = s.onGround ? Math.min(1, speed / MOVE.maxSpeed) * 0.7 : 0;
    b.swing += (targetSwing - b.swing) * ease;
    b.phase += ((speed * dt) / STRIDE) * Math.PI * 2 * dir;
    b.air += ((s.onGround ? 0 : 1) - b.air) * ease;
    for (let i = 0; i < 2; i++) {
      const p = b.phase + i * Math.PI;
      const hip = -Math.sin(p) * b.swing; // rotation about y: negative swings the leg forward
      const knee = Math.max(0, Math.sin(p + Math.PI / 2)) * b.swing * 1.3;
      b.hips[i].rotation.y = hip * (1 - b.air) - 0.6 * b.air;
      b.knees[i].rotation.y = knee * (1 - b.air) + 1.1 * b.air;
    }
    // A little bob as they run.
    b.fall.position.z = FEET - Math.abs(Math.sin(b.phase)) * 1.5 * b.swing;

    // Aim: the chest leans a quarter of the way, head and gun the rest.
    const pitch = Math.max(-1.2, Math.min(1.2, s.pitch));
    b.chest.rotation.y = -pitch * 0.25;
    b.head.rotation.y = -pitch * 0.75;
    b.aim.rotation.y = -pitch * 0.75;

    for (const [id, g] of b.guns) g.visible = id === s.weapon;
    // Recoil: the gun jumps back and settles.
    b.recoil = Math.max(0, b.recoil - RECOIL_RECOVERY * dt);
    b.gun.position.x = -2.5 * b.recoil;
  }

  private build(id: PlayerId, team: number): Body {
    const d = this.detailed;
    const color = TEAM_COLORS[team] ?? PLAYER_COLORS[(id - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length];
    const bodyMat = new THREE.MeshLambertMaterial({ color, emissive: 0xffffff, emissiveIntensity: 0 });
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      return m;
    };
    /** A box `across` wide (y), `deep` front to back (x), `tall` high (z), centred at x, y, z. */
    const block = (across: number, deep: number, tall: number, mat: THREE.Material, x = 0, y = 0, z = 0) =>
      mesh(this.geo(`box:${across}:${deep}:${tall}`, () => new THREE.BoxGeometry(deep, across, tall)), mat, x, y, z);
    const limb = (from: THREE.Vector3, to: THREE.Vector3, radius: number, mat: THREE.Material) => {
      const m = mesh(this.limbGeo(from.distanceTo(to), radius), mat, from.x, from.y, from.z);
      m.quaternion.setFromUnitVectors(Z, to.clone().sub(from).normalize());
      return m;
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    const root = new THREE.Group();
    const fall = new THREE.Group();
    fall.position.z = FEET;
    root.add(fall);
    // Everything else is built relative to the origin; `inner` undoes the fall pivot's offset.
    const inner = new THREE.Group();
    inner.position.z = -FEET;
    fall.add(inner);

    // Legs, pivoting at the hips; knees bend the shins back.
    const legs = new THREE.Group();
    legs.position.z = HIP_Z;
    inner.add(legs);
    const hips: THREE.Group[] = [];
    const knees: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.y = HIP_Y * side;
      legs.add(hip);
      hip.add(limb(v(0, 0, 0), v(0, 0, -THIGH), LIMB_R + 0.4, bodyMat));
      const knee = new THREE.Group();
      knee.position.z = -THIGH;
      hip.add(knee);
      knee.add(limb(v(0, 0, 0), v(0, 0, -SHIN + 2), LIMB_R, d ? this.armourMat : bodyMat));
      knee.add(block(5, 9, 3, this.armourMat, 2, 0, -SHIN + 1.5)); // foot
      hips.push(hip);
      knees.push(knee);
    }

    // Body: hips to shoulders. The chest pivots at the waist.
    inner.add(block(14, 9, 5, this.armourMat, 0, 0, HIP_Z + 1)); // pelvis
    const chest = new THREE.Group();
    chest.position.z = HIP_Z + 3;
    inner.add(chest);
    const torsoH = SHOULDER_Z - HIP_Z - 1;
    chest.add(block(18, 10, torsoH, bodyMat, 0, 0, torsoH / 2));
    if (d) {
      chest.add(block(4, 10.6, torsoH - 4, this.armourMat, 0, 0, torsoH / 2)); // stripe down the front and back
      chest.add(block(15, 10.4, 2.5, this.armourMat, 0, 0, 1)); // belt
    }

    // Head on the neck, with the visor where the eyes are.
    const head = new THREE.Group();
    head.position.z = NECK_Z - chest.position.z;
    chest.add(head);
    if (d) {
      const helmet = mesh(this.geo("helmet", () => new THREE.SphereGeometry(5.5, 12, 8)), this.armourMat, 0, 0, 5);
      helmet.scale.set(1, 0.95, 1.05);
      head.add(helmet);
      head.add(block(8, 3, 2.6, this.visorMat, 4.6, 0, 6));
    } else {
      head.add(block(10, 10, 10, this.armourMat, 0, 0, 5));
      head.add(block(8, 1, 3, this.visorMat, 5.2, 0, 6));
    }

    // Shoulders, arms and gun pitch together with the aim.
    const aim = new THREE.Group();
    aim.position.z = SHOULDER_Z - chest.position.z;
    chest.add(aim);
    const gun = new THREE.Group();
    aim.add(gun);
    const guns = new Map<WeaponId, THREE.Group>();
    const model = (id: WeaponId, ...parts: (THREE.Object3D | false)[]) => {
      const g = new THREE.Group();
      for (const p of parts) if (p) g.add(p);
      g.visible = id === "machinegun";
      gun.add(g);
      guns.set(id, g);
    };
    const dw = this.detailedWeapons;
    model("fists"); // just the hands
    model(
      "machinegun",
      block(4, 20, 5, this.gunMat, 15, -3, -4), // body
      block(2.5, 10, 2.5, this.gunMat, 28, -3, -3.2), // barrel
      block(2.5, 3, 6, this.gunMat, 10, -3, -8.5), // grip
      dw && block(4.2, 4, 1.2, this.visorMat, 18, -3, -1.3), // glowing strip on top
    );
    model(
      "shotgun",
      block(4.5, 16, 4.5, this.gunMat, 14, -3, -4),
      block(4, 16, 2.4, this.gunMat, 29, -3, -3), // double barrel
      block(4.6, 6, 3, this.woodMat, 22, -3, -6), // pump
      block(3, 8, 5, this.woodMat, 4, -3, -6), // stock
    );
    model(
      "rocketlauncher",
      block(7, 30, 7, this.gunMat, 15, -3, -1.5), // tube
      block(7.6, 2.5, 7.6, this.redMat, 30, -3, -1.5), // front ring
      block(2.5, 3, 6, this.gunMat, 10, -3, -8), // grip
      dw && block(1, 18, 1, this.visorMat, 15, -6.8, 1.5),
    );
    model(
      "railgun",
      block(3.5, 22, 4.5, this.gunMat, 14, -3, -4),
      block(2, 18, 2, this.gunMat, 33, -3, -3.2), // long barrel
      block(2.5, 3, 6, this.gunMat, 10, -3, -8.5),
      block(3.8, 16, 1, this.railMat, 18, -3, -1.6), // lit coil strip
      dw && block(3.2, 1.2, 3.2, this.railMat, 30, -3, -3.2),
      dw && block(3.2, 1.2, 3.2, this.railMat, 36, -3, -3.2),
    );
    // Right arm to the grip, left arm to under the barrel.
    const rShoulder = v(0, -10, 0);
    const rElbow = v(4, -10, -9);
    const rHand = v(10, -3.5, -6);
    const lShoulder = v(0, 10, 0);
    const lElbow = v(9, 7, -8);
    const lHand = v(20, -2, -6.5);
    aim.add(limb(rShoulder, rElbow, LIMB_R - 0.4, bodyMat), limb(rElbow, rHand, LIMB_R - 0.6, bodyMat));
    aim.add(limb(lShoulder, lElbow, LIMB_R - 0.4, bodyMat), limb(lElbow, lHand, LIMB_R - 0.6, bodyMat));
    if (d) {
      // Shoulder pads and hands.
      aim.add(block(7, 8, 4, this.armourMat, 0, -10.5, 1.5), block(7, 8, 4, this.armourMat, 0, 10.5, 1.5));
      aim.add(block(3, 3, 3, this.armourMat, rHand.x, rHand.y, rHand.z), block(3, 3, 3, this.armourMat, lHand.x, lHand.y, lHand.z));
    }

    if (this.castShadows) root.traverse((o) => (o.castShadow = true));
    this.scene.add(root);
    return {
      root,
      fall,
      legs,
      hips: [hips[0], hips[1]],
      knees: [knees[0], knees[1]],
      chest,
      head,
      aim,
      gun,
      guns,
      bodyMat,
      state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, onGround: true, alive: true, shielded: false, weapon: "machinegun" },
      flash: 0,
      phase: 0,
      swing: 0,
      legAngle: 0,
      air: 0,
      recoil: 0,
      deadFor: -1,
      shimmer: 0,
    };
  }

  /** A limb along +Z from 0 to `length`: a capsule in Full detail, a block in Light. Shared between bodies. */
  private limbGeo(length: number, radius: number): THREE.BufferGeometry {
    return this.geo(`limb:${length.toFixed(2)}:${radius}`, () => {
      const g = this.detailed
        ? new THREE.CapsuleGeometry(radius, Math.max(0.1, length - 2 * radius), 3, 8)
        : new THREE.BoxGeometry(radius * 2, length, radius * 2);
      g.rotateX(Math.PI / 2); // along +Z
      g.translate(0, 0, length / 2);
      return g;
    });
  }

  private geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geos.get(key);
    if (!g) this.geos.set(key, (g = make()));
    return g;
  }
}
