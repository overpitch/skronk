/**
 * Short-lived visuals driven by sim events: projectile tracers, impact sparks,
 * scorch marks and the muzzle flash light. Everything is pooled so firing
 * doesn't allocate per shot.
 */
import * as THREE from "three";

const MAX_TRACERS = 64;
const TRACER_LENGTH = 70;
const MAX_SPARKS = 512;
const MAX_DECALS = 96;
const SPARK_GRAVITY = 800;
const FLASH_SECONDS = 0.06;
const MAX_BEAMS = 8;
const BEAM_SECONDS = 0.16;

/** Soft round glow/scorch sprites drawn on a canvas, so there are no image assets. */
function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  readonly muzzleLight = new THREE.PointLight(0xffd080, 0, 420, 0);
  private flashTime = 0;

  private tracers: THREE.Mesh[] = [];

  private sparkPos = new Float32Array(MAX_SPARKS * 3);
  private sparkCol = new Float32Array(MAX_SPARKS * 3);
  private sparkBase = new Float32Array(MAX_SPARKS * 3);
  private sparkVel = new Float32Array(MAX_SPARKS * 3);
  private sparkLife = new Float32Array(MAX_SPARKS);
  private sparkMaxLife = new Float32Array(MAX_SPARKS);
  private sparkCursor = 0;
  private sparkGeo = new THREE.BufferGeometry();

  private decals: THREE.Mesh[] = [];
  private decalCursor = 0;

  /** Portal shot beams: a short-lived coloured line from gun to wall. */
  private beams: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number }[] = [];
  private beamCursor = 0;

  private tmpDir = new THREE.Vector3();
  private static readonly X = new THREE.Vector3(1, 0, 0);
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    scene.add(this.muzzleLight);

    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a0,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push(m);
    }

    this.sparkPos.fill(-1e6);
    this.sparkGeo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo.setAttribute("color", new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    const sparks = new THREE.Points(
      this.sparkGeo,
      new THREE.PointsMaterial({
        size: 3,
        map: radialTexture("rgba(255,255,255,1)", "rgba(255,255,255,0)"),
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    sparks.frustumCulled = false;
    scene.add(sparks);

    const decalGeo = new THREE.PlaneGeometry(7, 7);
    const decalMat = new THREE.MeshBasicMaterial({
      map: radialTexture("rgba(10,8,6,0.85)", "rgba(10,8,6,0)"),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    for (let i = 0; i < MAX_BEAMS; i++) {
      const mat = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.beams.push({ mesh, mat, life: 0 });
    }

    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new THREE.Mesh(decalGeo, decalMat);
      m.visible = false;
      scene.add(m);
      this.decals.push(m);
    }
  }

  muzzleFlash(at: THREE.Vector3) {
    this.muzzleLight.position.copy(at);
    this.flashTime = FLASH_SECONDS;
  }

  /** Sparks plus a scorch mark on the wall. */
  wallImpact(pos: THREE.Vector3, normal: THREE.Vector3) {
    this.burst(pos, normal, 9, [1, 0.75, 0.4], 220);
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    d.position.copy(pos).addScaledVector(normal, 0.2);
    d.quaternion.setFromUnitVectors(Effects.Z, normal);
    d.rotateZ(Math.random() * Math.PI * 2);
    d.scale.setScalar(0.8 + Math.random() * 0.5);
    d.visible = true;
  }

  /** Brighter, redder burst where a shot lands on a player. */
  playerImpact(pos: THREE.Vector3, shotDir: THREE.Vector3) {
    this.tmpDir.copy(shotDir).negate();
    this.burst(pos, this.tmpDir, 14, [1, 0.35, 0.3], 260);
  }

  /** A portal shot: a bright line that fades out quickly. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation) {
    const b = this.beams[this.beamCursor];
    this.beamCursor = (this.beamCursor + 1) % MAX_BEAMS;
    this.tmpDir.copy(to).sub(from);
    const len = this.tmpDir.length();
    if (len < 1) return;
    this.tmpDir.divideScalar(len);
    b.mesh.quaternion.setFromUnitVectors(Effects.X, this.tmpDir);
    b.mesh.scale.set(len, 1.6, 1.6);
    b.mesh.position.copy(from).lerp(to, 0.5);
    b.mat.color.set(color);
    b.mat.opacity = 1;
    b.life = BEAM_SECONDS;
    b.mesh.visible = true;
  }

  /** A burst of coloured sparks off a surface (portal opening, or a fizzle in grey). */
  splash(pos: THREE.Vector3, normal: THREE.Vector3, color: THREE.ColorRepresentation, count: number) {
    const c = new THREE.Color(color);
    this.burst(pos, normal, count, [c.r, c.g, c.b], 240);
  }

  private burst(pos: THREE.Vector3, normal: THREE.Vector3, count: number, color: [number, number, number], speed: number) {
    for (let n = 0; n < count; n++) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
      const s = speed * (0.35 + Math.random() * 0.65);
      const vx = normal.x * s + (Math.random() - 0.5) * speed;
      const vy = normal.y * s + (Math.random() - 0.5) * speed;
      const vz = normal.z * s + (Math.random() - 0.5) * speed + 60;
      this.sparkPos.set([pos.x, pos.y, pos.z], i * 3);
      this.sparkVel.set([vx, vy, vz], i * 3);
      this.sparkBase.set(color, i * 3);
      this.sparkLife[i] = this.sparkMaxLife[i] = 0.2 + Math.random() * 0.25;
    }
  }

  /** Per frame: draw tracers at the given positions and age sparks and the flash. */
  update(dt: number, tracers: { head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[]) {
    this.flashTime = Math.max(0, this.flashTime - dt);
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.mat.opacity = Math.max(0, b.life / BEAM_SECONDS);
      if (b.life <= 0) b.mesh.visible = false;
    }
    this.muzzleLight.intensity = this.flashTime > 0 ? 3.5 * (this.flashTime / FLASH_SECONDS) : 0;

    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = this.tracers[i];
      const t = tracers[i];
      if (!t) {
        m.visible = false;
        continue;
      }
      // Don't let the tail poke out behind the gun on the first frames.
      const len = Math.max(1, Math.min(TRACER_LENGTH, t.travelled));
      m.visible = true;
      m.quaternion.setFromUnitVectors(Effects.X, t.dir);
      m.scale.set(len, 1.1, 1.1);
      m.position.copy(t.head).addScaledVector(t.dir, -len / 2);
    }

    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      const k = i * 3;
      if (this.sparkLife[i] <= 0) {
        this.sparkPos[k] = this.sparkPos[k + 1] = this.sparkPos[k + 2] = -1e6;
        continue;
      }
      this.sparkVel[k + 2] -= SPARK_GRAVITY * dt;
      this.sparkPos[k] += this.sparkVel[k] * dt;
      this.sparkPos[k + 1] += this.sparkVel[k + 1] * dt;
      this.sparkPos[k + 2] += this.sparkVel[k + 2] * dt;
      const fade = this.sparkLife[i] / this.sparkMaxLife[i];
      this.sparkCol[k] = this.sparkBase[k] * fade;
      this.sparkCol[k + 1] = this.sparkBase[k + 1] * fade;
      this.sparkCol[k + 2] = this.sparkBase[k + 2] * fade;
    }
    this.sparkGeo.attributes.position.needsUpdate = true;
    this.sparkGeo.attributes.color.needsUpdate = true;
  }
}
