/**
 * The first-person weapon, drawn in its own scene after the world with a cleared
 * depth buffer so it never clips into walls. Camera space: -Z forward, +Y up.
 *
 * One model per weapon, built from boxes and cylinders (no model files). A new
 * weapon in hand drops the old one out of view and raises the new one. The
 * detailed models (Full quality) add glow strips, coils and trim.
 */
import * as THREE from "three";
import { SWITCH_TICKS, type WeaponId } from "../sim/weapons";
import { TICK_DT } from "../sim/tick";

const REST = new THREE.Vector3(4.4, -4.2, -13.5);
/** Fixed horizontal FOV, like the world camera, so the gun sits the same on any screen shape. */
const HORIZONTAL_FOV_DEG = 74;
const KICK_RECOVERY = 16; // per second, exponential
/** How far below the view a weapon goes while being swapped. */
const SWAP_DROP = 9;
const SWAP_SECONDS = SWITCH_TICKS * TICK_DT;

interface Model {
  group: THREE.Group;
  /** Where the muzzle flash shows (none for fists). */
  flashAt: THREE.Vector3 | null;
  flashColor: number;
  /** How hard a shot kicks it back and up. */
  kickBack: number;
  kickPitch: number;
  /** Fists: the right one jabs forward. */
  fist?: THREE.Object3D;
}

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
  private holder = new THREE.Group();
  private models = new Map<WeaponId, Model>();
  private current: WeaponId | null = null;
  private flash: THREE.Sprite;
  private kick = 0;
  private flashTime = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  /** 1 while the weapon is out of view (swapping), easing to 0 as it comes up. */
  private swap = 0;
  private jab = 0;

  constructor(detailed = true) {
    const metal = new THREE.MeshLambertMaterial({ color: 0x40454f });
    const dark = new THREE.MeshLambertMaterial({ color: 0x23262c });
    const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
    const red = new THREE.MeshLambertMaterial({ color: 0x8c2a22 });
    const cyan = new THREE.MeshBasicMaterial({ color: 0x4fd6ff });
    const orange = new THREE.MeshBasicMaterial({ color: 0xff7a3a });
    const rail = new THREE.MeshBasicMaterial({ color: 0x7ff0ff });
    const green = new THREE.MeshLambertMaterial({ color: 0x3d5a2a });
    const lime = new THREE.MeshBasicMaterial({ color: 0x9cff5a });

    const model = (id: WeaponId, m: Omit<Model, "group">, build: (part: Part) => void) => {
      const group = new THREE.Group();
      // Parts marked `extra` (trim, glow strips) are only built for the detailed models.
      const part: Part = (geo, mat, x, y, z, extra = true) => {
        if (!extra || detailed) {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(x, y, z);
          group.add(mesh);
          return mesh;
        }
        return new THREE.Object3D();
      };
      build(part);
      group.visible = false;
      this.holder.add(group);
      this.models.set(id, { group, ...m });
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    /** A cylinder along the view (z). */
    const tube = (part: Part, r0: number, r1: number, len: number, mat: THREE.Material, x: number, y: number, z: number, extra = false) => {
      const m = part(new THREE.CylinderGeometry(r0, r1, len, 12), mat, x, y, z, extra);
      m.rotation.x = Math.PI / 2;
      return m;
    };

    model("fists", { flashAt: null, flashColor: 0, kickBack: 0, kickPitch: 0 }, () => {});
    {
      // Gloved fists on forearms that come up from the bottom of the view; the right one punches.
      const fists = this.models.get("fists")!;
      const right = fistArm(1, detailed);
      right.position.set(0, 0, -2);
      const left = fistArm(-1, detailed);
      left.position.set(-9, 0.6, 1);
      left.rotation.z = 0.2;
      fists.group.add(right, left);
      // Smaller and lower than the guns, so they frame the view rather than fill it.
      fists.group.scale.setScalar(0.8);
      fists.group.position.set(0.5, -1.2, 0);
      fists.fist = right;
    }

    model("machinegun", { flashAt: new THREE.Vector3(0, 0.5, -11.2), flashColor: 0xffffff, kickBack: 1.8, kickPitch: 0.14 }, (part) => {
      part(box(2.4, 2.6, 9), metal, 0, 0, 0, false);
      part(box(1.9, 1.2, 7), dark, 0, 1.7, -0.5, false);
      tube(part, 0.55, 0.7, 6.5, dark, 0, 0.5, -7.4);
      part(box(0.35, 0.5, 6.5), cyan, 1.25, 0.55, -0.6);
      part(box(0.35, 0.5, 6.5), cyan, -1.25, 0.55, -0.6);
      const grip = part(box(1.7, 3.6, 2), dark, 0, -2.4, 2.4, false);
      grip.rotation.x = -0.35;
    });

    model("shotgun", { flashAt: new THREE.Vector3(0, 0.6, -13.4), flashColor: 0xffd090, kickBack: 3.2, kickPitch: 0.3 }, (part) => {
      part(box(2.8, 2.4, 7), metal, 0, 0, 0.5, false);
      tube(part, 0.6, 0.6, 10, dark, 0.6, 0.6, -8);
      tube(part, 0.6, 0.6, 10, dark, -0.6, 0.6, -8);
      part(box(2.2, 1.3, 4.5), wood, 0, -0.9, -6.5, false); // pump
      const stock = part(box(2.2, 3.2, 4), wood, 0, -1.4, 5, false);
      stock.rotation.x = -0.25;
      part(box(0.3, 0.4, 5), orange, 1.45, 0.7, 0.5);
    });

    model("grenadelauncher", { flashAt: new THREE.Vector3(0, 0.4, -11), flashColor: 0xffc070, kickBack: 2.6, kickPitch: 0.26 }, (part) => {
      part(box(2.6, 2.6, 8), metal, 0, 0, 0.5, false);
      tube(part, 1.25, 1.25, 7, dark, 0, 0.4, -6.5, false); // short wide barrel
      tube(part, 1.9, 1.9, 2.6, green, 0, -0.6, -1.5, false); // drum
      part(box(0.35, 0.5, 5), lime, 1.35, 1.1, -1);
      const grip = part(box(1.7, 3.6, 2), dark, 0, -2.4, 2.6, false);
      grip.rotation.x = -0.35;
    });

    model("rocketlauncher", { flashAt: new THREE.Vector3(0, 0.8, -11.5), flashColor: 0xffb060, kickBack: 2.4, kickPitch: 0.2 }, (part) => {
      tube(part, 1.35, 1.35, 14, metal, 0, 0.8, -3.5, false);
      tube(part, 1.6, 1.6, 1.2, red, 0, 0.8, -10, false); // front ring
      tube(part, 1.5, 1.5, 1, dark, 0, 0.8, 3);
      part(box(0.35, 0.5, 8), orange, 1.4, 1.2, -3.5);
      const grip = part(box(1.5, 3.2, 1.8), dark, 0, -2, 1.6, false);
      grip.rotation.x = -0.35;
      part(box(1.1, 1.1, 2.6), dark, 0, 2.4, -1); // sight
    });

    model("railgun", { flashAt: new THREE.Vector3(0, 0.4, -17), flashColor: 0x9ff4ff, kickBack: 3.6, kickPitch: 0.24 }, (part) => {
      part(box(2.2, 2.6, 10), dark, 0, 0, 0.5, false);
      tube(part, 0.45, 0.5, 13, metal, 0, 0.4, -10, false);
      // Coils round the barrel, lit.
      for (let i = 0; i < 4; i++) tube(part, 1.1, 1.1, 0.6, rail, 0, 0.4, -5.5 - i * 2.6, true);
      part(box(0.35, 0.5, 9), rail, 1.15, 1, 0.5);
      const grip = part(box(1.7, 3.6, 2), metal, 0, -2.4, 3, false);
      grip.rotation.x = -0.35;
    });

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const g = canvas.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,250,220,1)");
    grad.addColorStop(0.3, "rgba(255,200,90,0.9)");
    grad.addColorStop(1, "rgba(255,140,40,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const flashTex = new THREE.CanvasTexture(canvas);
    flashTex.colorSpace = THREE.SRGBColorSpace;
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.visible = false;
    this.holder.add(this.flash);

    this.holder.position.copy(REST);
    this.holder.scale.setScalar(0.8);
    this.scene.add(this.holder);
    this.scene.add(new THREE.HemisphereLight(0xd8e0ff, 0x4a4038, 2.6));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.6);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
    this.show("machinegun", false);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    const hfov = (HORIZONTAL_FOV_DEG * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /** A shot (or a punch) from the weapon in hand. */
  fire(weapon: WeaponId) {
    const m = this.models.get(weapon);
    if (!m) return;
    if (weapon !== this.current) this.show(weapon, false);
    if (m.fist) {
      this.jab = 1;
      return;
    }
    this.kick = 1;
    if (!m.flashAt) return;
    this.flashTime = 0.05;
    this.flash.position.copy(m.flashAt);
    this.flash.material.color.set(m.flashColor);
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar((weapon === "shotgun" ? 4.5 : 3) + Math.random() * 1.5);
  }

  private show(weapon: WeaponId, animate: boolean) {
    for (const [id, m] of this.models) m.group.visible = id === weapon;
    this.current = weapon;
    this.kick = 0;
    this.jab = 0;
    if (animate) this.swap = 1;
  }

  /** speedFraction: horizontal speed / max run speed. `weapon` is the one in hand. */
  update(dt: number, speedFraction: number, onGround: boolean, visible: boolean, weapon: WeaponId) {
    if (weapon !== this.current) this.show(weapon, true);
    this.holder.visible = visible;
    const m = this.models.get(weapon)!;
    this.kick *= Math.exp(-KICK_RECOVERY * dt);
    this.jab *= Math.exp(-KICK_RECOVERY * 0.8 * dt);
    this.swap = Math.max(0, this.swap - dt / SWAP_SECONDS);
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.flash.visible = this.flashTime > 0;

    const target = onGround ? Math.min(1, speedFraction) : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * 11 * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.35 * this.bobAmount;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.3 * this.bobAmount;
    const drop = SWAP_DROP * this.swap * this.swap;

    this.holder.position.set(REST.x + bobX, REST.y + bobY - drop, REST.z + this.kick * m.kickBack);
    this.holder.rotation.set(this.kick * m.kickPitch - this.swap * 0.5, 0, 0);
    // The jab: out and back, a little across.
    if (m.fist) m.fist.position.set(-this.jab * 2.5, this.jab * 0.8, -2 - Math.sin(Math.min(1, this.jab) * Math.PI) * 7);
  }
}

type Part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, extra?: boolean) => THREE.Object3D;

const GLOVE = new THREE.MeshLambertMaterial({ color: 0x5a4636 });
const KNUCKLE = new THREE.MeshLambertMaterial({ color: 0x3e3026 });
const SLEEVE = new THREE.MeshLambertMaterial({ color: 0x30343c });
const CUFF = new THREE.MeshLambertMaterial({ color: 0x23262c });
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * One gloved fist on its forearm (camera space: -Z forward, +Y up), for `side` 1 (right)
 * or -1 (left), the fist at the group's origin. Detailed: knuckle ridges, stitched cuff.
 */
function fistArm(side: 1 | -1, detailed: boolean): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // A rod from a to b (a cylinder turned to lie along it).
  const rod = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, mat: THREE.Material) => {
    const dir = b.clone().sub(a);
    const m = add(new THREE.CylinderGeometry(r1, r0, dir.length(), 10), mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    m.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
    return m;
  };
  // The back of the hand, and the fingers curled under at the front.
  add(new THREE.BoxGeometry(2.7, 2.2, 2.8), GLOVE, 0, 0.2, 0.1);
  add(new THREE.BoxGeometry(2.6, 1.6, 1.1), GLOVE, 0, -0.55, -1.35);
  // Thumb, folded across the inside of the fingers.
  const thumb = add(new THREE.BoxGeometry(0.9, 0.85, 1.9), GLOVE, -side * 1.15, -0.75, -0.55);
  thumb.rotation.y = side * 0.35;
  if (detailed) {
    // Knuckle ridges along the front.
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.55, 0.6, 0.6), KNUCKLE, (i - 1.5) * 0.65, 0.9, -1.2);
  }
  // Wrist cuff, then the forearm running back and down out of view.
  const wrist = new THREE.Vector3(0, -0.2, 1.6);
  const elbow = new THREE.Vector3(side * 2.4, -6, 11);
  rod(wrist, wrist.clone().lerp(elbow, 0.12), 1.55, 1.55, CUFF);
  rod(wrist.clone().lerp(elbow, 0.1), elbow, 1.25, 1.55, SLEEVE);
  if (detailed) rod(wrist.clone().lerp(elbow, 0.12), wrist.clone().lerp(elbow, 0.15), 1.6, 1.6, KNUCKLE); // a seam on the cuff
  return g;
}
