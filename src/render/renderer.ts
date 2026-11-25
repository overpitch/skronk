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
import { playerPortalOwner, type PortalOwner, type PortalSlot } from "../sim/portals";
import { FIZZLE_COLOR, portalColor } from "./portalColors";
import { TextureLibrary } from "./textures";
import { ViewModel } from "./viewmodel";

const HORIZONTAL_FOV_DEG = 100;
/** Extra horizontal FOV at full sprint speed and above (portal flings too), so speed reads on screen. */
const SPEED_FOV_KICK_DEG = 10;
/** How long a local shot's tracer takes to slide from the gun muzzle onto its true path. */
const TRACER_CONVERGE_SECONDS = 0.09;
const PUNCH_RECOVERY = 12; // per second

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
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private textures: TextureLibrary;
  private lookTarget = new THREE.Vector3();
  private effects: Effects;
  private players: PlayerModels;
  private viewModel = new ViewModel();
  private portals: PortalViews;
  private pickupMeshes: THREE.Mesh[] = [];
  /** Local shots: offset from true path to the gun muzzle at the moment of firing. */
  private tracerOffsets = new Map<number, { offset: THREE.Vector3; born: number }>();
  /** Visual-only camera kick in radians (pitch up), from firing and taking hits. */
  private punchPitch = 0;
  private punchYaw = 0;
  /** Current speed FOV kick in degrees, eased. */
  private fovKick = 0;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(
    private canvas: HTMLCanvasElement,
    textureRoot: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(90, 1, 2, 16384);
    this.camera.up.set(0, 0, 1);
    this.scene.background = new THREE.Color(0x0b0d12);
    this.textures = new TextureLibrary(textureRoot, this.renderer.capabilities.getMaxAnisotropy());
    this.effects = new Effects(this.scene);
    this.players = new PlayerModels(this.scene);
    this.portals = new PortalViews(this.scene);
    this.resize();
  }

  loadLevel(level: LevelData) {
    // One mesh per texture keeps draw calls low (a handful per map).
    const byTexture = new Map<string, { pos: number[]; nrm: number[]; uv: number[]; idx: number[] }>();
    for (const s of level.surfaces) {
      if (!s.visible) continue;
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
      this.scene.add(mesh);
    }

    // Simple lighting until there's a lightmap pass: sky/ground fill, one sun
    // for face contrast, and a few map lights. Point lights are capped because
    // each one costs every pixel, and the Xbox browser is the weakest target.
    this.scene.add(new THREE.HemisphereLight(0xd8e0ff, 0x6a5e50, 3.2));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    sun.position.set(0.4, 0.7, 1);
    this.scene.add(sun);
    for (const l of level.lights.slice(0, 4)) {
      // Quake-style light radius: full strength near, fading to zero at the cutoff.
      const light = new THREE.PointLight(new THREE.Color(l.color[0], l.color[1], l.color[2]), 1.5, l.intensity * 1.5, 0);
      light.position.set(l.origin.x, l.origin.y, l.origin.z);
      this.scene.add(light);
    }

    // Pickup markers: placeholder shapes so map authors can see where they are.
    const colors: Record<string, number> = { health: 0xff5050, armor: 0x50a0ff, ammo: 0xffc800 };
    for (const p of level.pickups) {
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(10),
        new THREE.MeshLambertMaterial({ color: colors[p.kind] ?? 0xffffff, emissive: colors[p.kind] ?? 0xffffff, emissiveIntensity: 0.4 }),
      );
      mesh.position.set(p.origin.x, p.origin.y, p.origin.z);
      mesh.userData.baseZ = p.origin.z;
      this.scene.add(mesh);
      this.pickupMeshes.push(mesh);
    }
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
    this.handleEvents(events, localId, timeSeconds, colorOf);
    this.portals.update(world.portals, (p) => world.linkedPortal(p) !== null, (p) => colorOf(p.owner, p.slot), timeSeconds);

    // Players, interpolated between ticks. Your own body is only seen through portals.
    const everyone = [...world.players.values()];
    this.players.sync(everyone.map((p) => p.id), (id) => world.players.get(id)?.team ?? 0);
    this.players.setLayer(localId, PORTAL_ONLY_LAYER);
    for (const p of everyone) {
      this.v1.set(p.prevOrigin.x, p.prevOrigin.y, p.prevOrigin.z);
      this.v2.set(p.origin.x, p.origin.y, p.origin.z);
      this.v1.lerp(this.v2, alpha);
      this.players.place(p.id, this.v1.x, this.v1.y, this.v1.z, p.yaw, p.alive);
    }
    this.players.update(dt);

    // Tracers: interpolated, with local shots easing in from the gun muzzle.
    const tracers: { head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[] = [];
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
      tracers.push({ head, dir, travelled });
    }
    for (const id of this.tracerOffsets.keys()) if (!live.has(id)) this.tracerOffsets.delete(id);
    this.effects.update(dt, tracers);

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
    this.viewModel.update(dt, speed, !!me?.onGround, !!me?.alive);

    this.portals.renderViews(this.renderer, this.camera, world.portals, (p) => world.linkedPortal(p));
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.viewModel.scene, this.viewModel.camera);
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
        case "fire":
          if (e.player !== localId) break;
          this.viewModel.fire();
          this.punchPitch += 0.006;
          this.punchYaw += (Math.random() - 0.5) * 0.004;
          this.muzzle(this.v1);
          this.effects.muzzleFlash(this.v1);
          // The shot really leaves the eye; draw it leaving the gun and drift onto the true path.
          this.tracerOffsets.set(e.projectile, {
            offset: this.v1.clone().sub(new THREE.Vector3(e.origin.x, e.origin.y, e.origin.z)),
            born: now,
          });
          break;
        case "impact":
          this.effects.wallImpact(
            new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z),
            new THREE.Vector3(e.normal.x, e.normal.y, e.normal.z),
          );
          break;
        case "hit":
          this.players.hit(e.victim);
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
