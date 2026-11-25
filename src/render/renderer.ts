/**
 * Draws the level and players with Three.js. Reads LevelData and sim state;
 * never writes to them. Scene is Z-up in map units, same as the simulation.
 */
import * as THREE from "three";
import type { Vec3 } from "../math/vec3";
import type { LevelData } from "../level/types";
import { TextureLibrary } from "./textures";

const HORIZONTAL_FOV_DEG = 100;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private textures: TextureLibrary;
  private lookTarget = new THREE.Vector3();

  constructor(
    private canvas: HTMLCanvasElement,
    textureRoot: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(90, 1, 2, 16384);
    this.camera.up.set(0, 0, 1);
    this.scene.background = new THREE.Color(0x0b0d12);
    this.textures = new TextureLibrary(textureRoot, this.renderer.capabilities.getMaxAnisotropy());
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
      mesh.userData.spin = true;
      mesh.userData.baseZ = p.origin.z;
      this.scene.add(mesh);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep horizontal FOV fixed so widescreen TVs don't zoom in.
    const hfov = (HORIZONTAL_FOV_DEG * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / this.camera.aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  render(eye: Vec3, yaw: number, pitch: number, timeSeconds: number) {
    this.camera.position.set(eye.x, eye.y, eye.z);
    const cp = Math.cos(pitch);
    this.lookTarget.set(eye.x + Math.cos(yaw) * cp, eye.y + Math.sin(yaw) * cp, eye.z + Math.sin(pitch));
    this.camera.lookAt(this.lookTarget);
    for (const obj of this.scene.children) {
      if (obj.userData.spin) {
        obj.rotation.z = timeSeconds * 2;
        obj.position.z = obj.userData.baseZ + Math.sin(timeSeconds * 3) * 4;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
