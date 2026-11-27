/**
 * Draws the level and players with Three.js. Reads LevelData and sim state;
 * never writes to them. Scene is Z-up in map units, same as the simulation.
 */
import * as THREE from "three";
import type { Vec3 } from "../math/vec3";
import type { LevelData } from "../level/types";
import type { PlayerId, SimEvent } from "../sim/events";
import { MOVE } from "../sim/movement";
import type { World } from "../sim/world";
import { Effects } from "./effects";
import { PlayerModels } from "./players";
import { PORTAL_ONLY_LAYER, PortalViews } from "./portals";
import type { QualityProfile } from "./quality";
import { playerPortalOwner, type PortalOwner, type PortalSlot } from "../sim/portals";
import { FIZZLE_COLOR, portalColor } from "./portalColors";
import { TextureLibrary } from "./textures";
import { ViewModel } from "./viewmodel";
import { visibleSurfaces } from "../level/visibleSurfaces";
import { MonsterModels } from "./monsters";
import { isMonsterId } from "../sim/monsters";
import { WEAPONS, type WeaponId } from "../sim/weapons";

/** Pickup shapes and colours: a spinning gem for health, armor and ammo, a little gun for weapons. */
const PICKUP_COLORS: Record<string, number> = {
  health: 0xff5050,
  armor: 0x50a0ff,
  ammo: 0xffc800,
  machinegun: 0xb0b8c8,
  shotgun: 0xd08a40,
  grenadelauncher: 0x6fbf4a,
  rocketlauncher: 0xff5a3a,
  railgun: 0x5fe6ff,
};
/** View punch per shot, radians. */
const SHOT_PUNCH: Record<WeaponId, number> = { fists: 0.004, machinegun: 0.006, shotgun: 0.03, grenadelauncher: 0.012, rocketlauncher: 0.014, railgun: 0.024 };
const RAIL_COLOR = 0x7ff0ff;

const HORIZONTAL_FOV_DEG = 100;
/** Extra horizontal FOV at full sprint speed and above (portal flings too), so speed reads on screen. */
const SPEED_FOV_KICK_DEG = 10;
/** How long a local shot's tracer takes to slide from the gun muzzle onto its true path. */
const TRACER_CONVERGE_SECONDS = 0.09;
const PUNCH_RECOVERY = 12; // per second
/** Light strengths: sky/ground fill everywhere, the shadowless sun for face contrast, each map light entity. */
const FILL_LIGHT = 1.6;
const SUN_LIGHT = 0.8;
const MAP_LIGHT = 4;

export interface RenderFrame {
  world: World;
  localId: PlayerId;
  /** 0..1 between the previous tick and the current one. */
  alpha: number;
  eye: Vec3;
  yaw: number;
  pitch: number;
  timeSeconds: number;
  dt: number;
  /**
   * Network game: your gun's kick and flash already played when you pressed fire
   * (localShot), so the server's report of the shot only adds its tracer.
   */
  predictedFire?: boolean;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private textures: TextureLibrary;
  private lookTarget = new THREE.Vector3();
  private effects: Effects;
  private players: PlayerModels;
  private viewModel: ViewModel;
  private monsters: MonsterModels;
  private portals: PortalViews;
  private pickupMeshes: THREE.Object3D[] = [];
  /** Local shots: offset from true path to the gun muzzle at the moment of firing. */
  private tracerOffsets = new Map<number, { offset: THREE.Vector3; born: number }>();
  /** Visual-only camera kick in radians (pitch up), from firing and taking hits. */
  private punchPitch = 0;
  private punchYaw = 0;
  /** Current speed FOV kick in degrees, eased. */
  private fovKick = 0;
  private debugLines: THREE.LineSegments | null = null;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(
    private canvas: HTMLCanvasElement,
    textureRoot: string,
    readonly quality: QualityProfile,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    if (quality.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // Shadows are worked out once a frame (in render), not again for every portal view.
      this.renderer.shadowMap.autoUpdate = false;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(90, 1, 2, 16384);
    this.camera.up.set(0, 0, 1);
    this.scene.background = new THREE.Color(0x0b0d12);
    this.textures = new TextureLibrary(textureRoot, Math.min(quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    this.effects = new Effects(this.scene, quality);
    this.players = new PlayerModels(this.scene, quality.detailedBodies, quality.shadows, quality.detailedWeapons);
    this.viewModel = new ViewModel(quality.detailedWeapons);
    this.monsters = new MonsterModels(this.scene, quality.detailedBodies, quality.shadows);
    this.portals = new PortalViews(this.scene, {
      maxViews: quality.maxPortalViews,
      scale: quality.portalViewScale,
      samples: quality.portalSamples,
    });
    this.resize();
  }

  loadLevel(level: LevelData) {
    // One mesh per texture keeps draw calls low (a handful per map).
    const byTexture = new Map<string, { pos: number[]; nrm: number[]; uv: number[]; idx: number[] }>();
    // Hidden and doubled faces left out (they'd flicker where brushes overlap).
    for (const s of visibleSurfaces(level)) {
      let g = byTexture.get(s.texture);
      if (!g) byTexture.set(s.texture, (g = { pos: [], nrm: [], uv: [], idx: [] }));
      const base = g.pos.length / 3;
      s.vertices.forEach((v, i) => {
        g!.pos.push(v.x, v.y, v.z);
        g!.nrm.push(s.plane.normal.x, s.plane.normal.y, s.plane.normal.z);
        // Map V runs down the image; three's V runs up.
        g!.uv.push(s.uvs[i][0], -s.uvs[i][1]);
      });
      for (let i = 1; i < s.vertices.length - 1; i++) g.idx.push(base, base + i, base + i + 1);
    }

    for (const [texture, g] of byTexture) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(g.nrm, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
      geo.setIndex(g.idx);
      const mat = new THREE.MeshLambertMaterial({ map: this.textures.get(texture) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = texture;
      mesh.castShadow = mesh.receiveShadow = this.quality.shadows;
      this.scene.add(mesh);
    }

    // Simple lighting until there's a lightmap pass: sky/ground fill, one sun
    // for face contrast, and a few map lights. Point lights are capped (by the
    // quality mode) because each one costs every pixel.
    // The map's lights carry real weight against the fill, so their shadows (Full) read clearly;
    // the same balance in both modes, so a map lit in one looks lit the same in the other.
    this.scene.add(new THREE.HemisphereLight(0xd8e0ff, 0x6a5e50, FILL_LIGHT));
    const sun = new THREE.DirectionalLight(0xfff4e0, SUN_LIGHT);
    this.placeSun(sun, level);
    this.scene.add(sun, sun.target);
    level.lights.slice(0, this.quality.maxLights).forEach((l, i) => {
      // Quake-style light radius: full strength near, fading to zero at the cutoff.
      const light = new THREE.PointLight(new THREE.Color(l.color[0], l.color[1], l.color[2]), MAP_LIGHT, l.intensity * 1.5, 0);
      light.position.set(l.origin.x, l.origin.y, l.origin.z);
      // Full quality: the first few lights cast shadows (indoors, the map's own lights are the ones that should).
      if (i < this.quality.shadowLights) {
        light.castShadow = true;
        light.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
        light.shadow.camera.near = 4;
        light.shadow.camera.far = l.intensity * 1.5;
        light.shadow.bias = -0.002;
        light.shadow.normalBias = 1;
      }
      this.scene.add(light);
    });

    // Pickups: placeholder shapes so map authors (and players) can tell them apart.
    for (const p of level.pickups) {
      const color = PICKUP_COLORS[p.kind] ?? 0xffffff;
      const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.4 });
      const isWeapon = WEAPONS.some((w) => w.id === p.kind);
      const mesh = isWeapon ? weaponPickupShape(mat) : new THREE.Mesh(new THREE.OctahedronGeometry(10), mat);
      mesh.position.set(p.origin.x, p.origin.y, p.origin.z);
      mesh.userData.baseZ = p.origin.z;
      this.scene.add(mesh);
      this.pickupMeshes.push(mesh);
    }
  }

  /** The sun: shadowless fill from up and to one side, for contrast between faces. */
  private placeSun(sun: THREE.DirectionalLight, level: LevelData) {
    const centre = new THREE.Vector3(
      (level.mins.x + level.maxs.x) / 2,
      (level.mins.y + level.maxs.y) / 2,
      (level.mins.z + level.maxs.z) / 2,
    );
    sun.position.copy(centre).add(new THREE.Vector3(0.4, 0.7, 1));
    sun.target.position.copy(centre);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov();
    this.viewModel.setAspect(this.camera.aspect);
  }

  private applyFov() {
    // Keep horizontal FOV fixed so widescreen TVs don't zoom in.
    const hfov = ((HORIZONTAL_FOV_DEG + this.fovKick) * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / this.camera.aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  render(frame: RenderFrame, events: readonly SimEvent[]) {
    const { world, localId, alpha, eye, timeSeconds, dt } = frame;
    const me = world.players.get(localId);

    this.punchPitch *= Math.exp(-PUNCH_RECOVERY * dt);
    this.punchYaw *= Math.exp(-PUNCH_RECOVERY * dt);
    const yaw = frame.yaw + this.punchYaw;
    const pitch = frame.pitch + this.punchPitch;
    this.camera.position.set(eye.x, eye.y, eye.z);
    const cp = Math.cos(pitch);
    this.forward.set(Math.cos(yaw) * cp, Math.sin(yaw) * cp, Math.sin(pitch));
    this.lookTarget.copy(this.camera.position).add(this.forward);
    this.camera.lookAt(this.lookTarget);
    this.right.set(Math.sin(frame.yaw), -Math.cos(frame.yaw), 0);
    this.up.crossVectors(this.right, this.forward);

    const myOwner = playerPortalOwner(localId);
    const colorOf = (owner: PortalOwner, slot: PortalSlot) => portalColor(owner === myOwner, slot);
    this.handleEvents(events, localId, timeSeconds, colorOf, !!frame.predictedFire);
    this.portals.update(world.portals, (p) => world.linkedPortal(p) !== null, (p) => colorOf(p.owner, p.slot), timeSeconds);

    // Players, interpolated between ticks. Your own body is only seen through portals.
    const everyone = [...world.players.values()];
    this.players.sync(everyone.map((p) => p.id), (id) => world.players.get(id)?.team ?? 0);
    this.players.setLayer(localId, PORTAL_ONLY_LAYER);
    for (const p of everyone) {
      this.v1.set(p.prevOrigin.x, p.prevOrigin.y, p.prevOrigin.z);
      this.v2.set(p.origin.x, p.origin.y, p.origin.z);
      this.v1.lerp(this.v2, alpha);
      this.players.place(p.id, {
        x: this.v1.x,
        y: this.v1.y,
        z: this.v1.z,
        yaw: p.yaw,
        pitch: p.pitch,
        vx: p.velocity.x,
        vy: p.velocity.y,
        onGround: p.onGround,
        alive: p.alive,
        shielded: world.tick < p.protectedUntil,
        weapon: WEAPONS[p.weapon]?.id ?? "machinegun",
      });
    }
    this.players.update(dt);
    this.monsters.update(world.monsters, alpha, world.tick, dt);

    // Tracers and rockets: interpolated, with local shots easing in from the gun muzzle.
    const tracers: { head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[] = [];
    const rockets: { id: number; head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[] = [];
    const grenades: { pos: THREE.Vector3; fuseLeft: number }[] = [];
    const live = new Set<number>();
    for (const pr of world.projectiles) {
      live.add(pr.id);
      const head = new THREE.Vector3(pr.prevOrigin.x, pr.prevOrigin.y, pr.prevOrigin.z).lerp(
        this.v2.set(pr.origin.x, pr.origin.y, pr.origin.z),
        alpha,
      );
      const dir = new THREE.Vector3(pr.velocity.x, pr.velocity.y, pr.velocity.z).normalize();
      const conv = this.tracerOffsets.get(pr.id);
      let travelled = Infinity;
      if (conv) {
        const age = timeSeconds - conv.born;
        head.addScaledVector(conv.offset, Math.max(0, 1 - age / TRACER_CONVERGE_SECONDS));
        travelled = age * Math.hypot(pr.velocity.x, pr.velocity.y, pr.velocity.z);
      }
      if (pr.weapon === "rocketlauncher") rockets.push({ id: pr.id, head, dir, travelled });
      else if (pr.weapon === "grenadelauncher") grenades.push({ pos: head, fuseLeft: Math.max(0, ((pr.fuse ?? world.tick) - world.tick) / 60) });
      else tracers.push({ head, dir, travelled });
    }
    for (const id of this.tracerOffsets.keys()) if (!live.has(id)) this.tracerOffsets.delete(id);
    this.effects.update(dt, tracers, rockets, grenades);

    // Pickups: hidden while waiting to respawn.
    world.pickups.forEach((pk, i) => {
      const mesh = this.pickupMeshes[i];
      if (mesh) mesh.visible = world.tick >= pk.availableAtTick;
    });
    for (const obj of this.pickupMeshes) {
      obj.rotation.z = timeSeconds * 2;
      obj.position.z = obj.userData.baseZ + Math.sin(timeSeconds * 3) * 4;
    }

    const speed = me ? Math.hypot(me.velocity.x, me.velocity.y) / MOVE.maxSpeed : 0;
    // Widen the view as you go faster than a normal run: full kick at sprint speed.
    const kick = Math.max(0, Math.min(1, (speed - 1.02) / (MOVE.sprintFactor - 1.02))) * SPEED_FOV_KICK_DEG;
    const eased = this.fovKick + (kick - this.fovKick) * (1 - Math.exp(-6 * dt));
    if (Math.abs(eased - this.fovKick) > 0.01) {
      this.fovKick = eased;
      this.applyFov();
    }
    this.viewModel.update(dt, speed, !!me?.onGround, !!me?.alive, WEAPONS[me?.weapon ?? 1]?.id ?? "machinegun");

    if (this.quality.shadows) this.renderer.shadowMap.needsUpdate = true;
    this.portals.renderViews(this.renderer, this.camera, world.portals, (p) => world.linkedPortal(p));
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.viewModel.scene, this.viewModel.camera);
  }

  /** Debug overlay: coloured line segments (pairs of points), drawn through walls. Replaces any earlier set. */
  setDebugLines(positions: number[], colors: number[]) {
    this.debugLines?.geometry.dispose();
    if (this.debugLines) this.scene.remove(this.debugLines);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthTest: false });
    this.debugLines = new THREE.LineSegments(geo, mat);
    this.debugLines.renderOrder = 10;
    this.scene.add(this.debugLines);
  }

  /** Your weapon going off: kick, view punch and muzzle flash (a punch has no flash). */
  localShot(weapon: WeaponId) {
    this.viewModel.fire(weapon);
    const punch = SHOT_PUNCH[weapon];
    this.punchPitch += punch;
    this.punchYaw += (Math.random() - 0.5) * punch * 0.7;
    if (weapon !== "fists") this.effects.muzzleFlash(this.muzzle(this.v2));
  }

  /** World position of the gun muzzle for the current view. */
  private muzzle(out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(this.camera.position)
      .addScaledVector(this.forward, 24)
      .addScaledVector(this.right, 7)
      .addScaledVector(this.up, -6);
  }

  private handleEvents(
    events: readonly SimEvent[],
    localId: PlayerId,
    now: number,
    colorOf: (owner: PortalOwner, slot: PortalSlot) => THREE.ColorRepresentation,
    predictedFire: boolean,
  ) {
    for (const e of events) {
      switch (e.type) {
        case "portalShot": {
          const from = e.player === localId ? this.muzzle(this.v1) : this.v1.set(e.origin.x, e.origin.y, e.origin.z);
          const to = this.v2.set(e.end.x, e.end.y, e.end.z);
          // The beam shows which end you fired, even when it fizzles; grey sparks say it didn't stick.
          const color = colorOf(e.owner, e.slot);
          this.effects.beam(from, to, color);
          const normal = new THREE.Vector3(e.normal.x, e.normal.y, e.normal.z);
          if (normal.lengthSq() > 0) this.effects.splash(to, normal, e.portal === null ? FIZZLE_COLOR : color, e.portal === null ? 10 : 28);
          if (e.player === localId) this.punchPitch += 0.003;
          break;
        }
        case "shotThroughPortal":
          // The tracer starts fresh out of the exit: no offset, tail grows from the exit.
          this.tracerOffsets.set(e.projectile, { offset: new THREE.Vector3(), born: now });
          break;
        case "fire":
          this.players.fired(e.player);
          if (e.player !== localId) break;
          if (!predictedFire) this.localShot(e.weapon);
          if (e.projectile < 0) break;
          this.muzzle(this.v1);
          // The shot really leaves the eye; draw it leaving the gun and drift onto the true path.
          this.tracerOffsets.set(e.projectile, {
            offset: this.v1.clone().sub(new THREE.Vector3(e.origin.x, e.origin.y, e.origin.z)),
            born: now,
          });
          break;
        case "impact": {
          const pos = new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z);
          const normal = new THREE.Vector3(e.normal.x, e.normal.y, e.normal.z);
          if (e.weapon === "fists") this.effects.dust(pos, normal);
          else this.effects.wallImpact(pos, normal);
          break;
        }
        case "explosion":
          this.effects.explosion(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), e.radius);
          if (e.owner === localId) this.punchPitch += 0.004;
          break;
        case "trail": {
          // Your own trail starts at your gun's muzzle, not your eye.
          const segments = e.segments.map(([a, b]) => [new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)] as [THREE.Vector3, THREE.Vector3]);
          if (e.player === localId && segments.length) segments[0][0] = this.muzzle(new THREE.Vector3());
          this.effects.trail(segments, RAIL_COLOR);
          break;
        }
        case "shielded":
          // Spawn protection soaked it up: sparks, no flinch.
          if (e.victim !== localId) this.effects.playerImpact(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), this.v2.copy(this.forward));
          break;
        case "hit":
          if (isMonsterId(e.victim)) this.monsters.hit(e.victim);
          else this.players.hit(e.victim);
          if (e.victim === localId) {
            this.punchPitch += 0.02;
            this.punchYaw += (Math.random() - 0.5) * 0.04;
          } else {
            this.v2.copy(this.forward);
            this.effects.playerImpact(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), this.v2);
          }
          break;
      }
    }
  }
}

/** A pickup that's a weapon: a little gun shape, about the size of the editor's box. */
function weaponPickupShape(mat: THREE.Material): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(22, 5, 6), mat);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 3), mat);
  barrel.position.set(14, 0, 1);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 8), mat);
  grip.position.set(-6, 0, -6);
  g.add(body, barrel, grip);
  return g;
}
