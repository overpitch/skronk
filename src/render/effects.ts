/**
 * Short-lived visuals driven by sim events: projectile tracers, rockets and
 * their smoke, explosions, railgun trails, impact sparks, scorch marks and the
 * muzzle flash light. Everything is pooled so firing doesn't allocate per shot.
 */
import * as THREE from "three";

const MAX_TRACERS = 64;
const TRACER_LENGTH = 70;
const MAX_SPARKS = 512;
const MAX_DECALS = 96;
const SPARK_GRAVITY = 800;
const FLASH_SECONDS = 0.06;
const MAX_BEAMS = 32;
const BEAM_SECONDS = 0.16;
const MAX_ROCKETS = 16;
const ROCKET_FLAME_LENGTH = 34;
const MAX_SMOKE = 160;
const SMOKE_SECONDS = 0.9;
/** A smoke puff every this many units of rocket travel. */
const SMOKE_SPACING = 18;
const MAX_BLASTS = 8;
const MAX_GRENADES = 24;
const BLAST_SECONDS = 0.4;

/** What the effects can do; the quality mode switches the costly parts. */
export interface EffectsOptions {
  /** Point lights for explosions (0 for none). */
  explosionLights: number;
  smokeTrails: boolean;
  beamGlow: boolean;
}

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

  /** Portal shot beams and railgun trails: short-lived coloured lines. */
  private beams: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; seconds: number; opacity: number }[] = [];
  private beamCursor = 0;

  /** Rockets in flight: a glowing head and a flame behind it. */
  private rockets: { glow: THREE.Sprite; flame: THREE.Mesh }[] = [];
  /** Smoke left behind rockets (Full quality). */
  private smoke: { sprite: THREE.Sprite; life: number; grow: number }[] = [];
  private smokeCursor = 0;
  /** Where each rocket last dropped smoke, by projectile id. */
  private smokeFrom = new Map<number, THREE.Vector3>();
  /** Grenades: a dark ball with a blinking light. */
  private grenades: { ball: THREE.Mesh; blink: THREE.Sprite }[] = [];
  /** Fireballs. */
  private blasts: { sprite: THREE.Sprite; life: number; size: number }[] = [];
  private blastCursor = 0;
  private blastLights: { light: THREE.PointLight; life: number }[] = [];
  private blastLightCursor = 0;

  private tmpDir = new THREE.Vector3();
  private static readonly X = new THREE.Vector3(1, 0, 0);
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor(
    scene: THREE.Scene,
    private options: EffectsOptions = { explosionLights: 0, smokeTrails: false, beamGlow: false },
  ) {
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
      this.beams.push({ mesh, mat, life: 0, seconds: BEAM_SECONDS, opacity: 1 });
    }

    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new THREE.Mesh(decalGeo, decalMat);
      m.visible = false;
      scene.add(m);
      this.decals.push(m);
    }

    const glowTex = radialTexture("rgba(255,240,200,1)", "rgba(255,120,30,0)");
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a40, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    for (let i = 0; i < MAX_ROCKETS; i++) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.scale.setScalar(14);
      const flame = new THREE.Mesh(tracerGeo, flameMat);
      glow.visible = flame.visible = false;
      flame.frustumCulled = glow.frustumCulled = false;
      scene.add(glow, flame);
      this.rockets.push({ glow, flame });
    }
    if (options.smokeTrails) {
      const smokeTex = radialTexture("rgba(150,150,150,0.55)", "rgba(120,120,120,0)");
      for (let i = 0; i < MAX_SMOKE; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, depthWrite: false, transparent: true }));
        sprite.visible = false;
        scene.add(sprite);
        this.smoke.push({ sprite, life: 0, grow: 1 });
      }
    }
    const ballGeo = new THREE.SphereGeometry(3.2, 10, 8);
    const ballMat = new THREE.MeshLambertMaterial({ color: 0x3d5a2a });
    const blinkTex = radialTexture("rgba(255,80,60,1)", "rgba(255,40,20,0)");
    for (let i = 0; i < MAX_GRENADES; i++) {
      const ball = new THREE.Mesh(ballGeo, ballMat);
      const blink = new THREE.Sprite(new THREE.SpriteMaterial({ map: blinkTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      blink.scale.setScalar(7);
      ball.visible = blink.visible = false;
      ball.frustumCulled = blink.frustumCulled = false;
      scene.add(ball, blink);
      this.grenades.push({ ball, blink });
    }
    const fireTex = radialTexture("rgba(255,245,210,1)", "rgba(255,90,20,0)");
    for (let i = 0; i < MAX_BLASTS; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sprite.visible = false;
      scene.add(sprite);
      this.blasts.push({ sprite, life: 0, size: 1 });
    }
    for (let i = 0; i < options.explosionLights; i++) {
      const light = new THREE.PointLight(0xffa050, 0, 600, 1.5);
      scene.add(light);
      this.blastLights.push({ light, life: 0 });
    }
  }

  /** A rocket going off: a fireball, a shower of sparks, a scorch mark, and (Full) a flash of light. */
  explosion(pos: THREE.Vector3, radius: number) {
    const b = this.blasts[this.blastCursor];
    this.blastCursor = (this.blastCursor + 1) % MAX_BLASTS;
    b.sprite.position.copy(pos);
    b.sprite.material.rotation = Math.random() * Math.PI * 2;
    b.size = radius * 1.4;
    b.life = BLAST_SECONDS;
    b.sprite.visible = true;
    this.burst(pos, Effects.Z, 46, [1, 0.6, 0.25], 520);
    if (this.blastLights.length) {
      const l = this.blastLights[this.blastLightCursor];
      this.blastLightCursor = (this.blastLightCursor + 1) % this.blastLights.length;
      l.light.position.copy(pos);
      l.light.distance = radius * 4;
      l.life = BLAST_SECONDS;
    }
  }

  /** A railgun trail: a bright core along each piece of the path that fades slowly, with a soft glow round it in Full. */
  trail(segments: readonly [THREE.Vector3, THREE.Vector3][], color: THREE.ColorRepresentation) {
    for (const [from, to] of segments) {
      this.beam(from, to, color, 0.7, 1.1, 1);
      if (this.options.beamGlow) this.beam(from, to, color, 0.5, 5, 0.25);
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

  /** A portal shot: a bright line that fades out quickly (or slower and wider, for trails). */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, seconds = BEAM_SECONDS, width = 1.6, opacity = 1) {
    const b = this.beams[this.beamCursor];
    this.beamCursor = (this.beamCursor + 1) % MAX_BEAMS;
    this.tmpDir.copy(to).sub(from);
    const len = this.tmpDir.length();
    if (len < 1) return;
    this.tmpDir.divideScalar(len);
    b.mesh.quaternion.setFromUnitVectors(Effects.X, this.tmpDir);
    b.mesh.scale.set(len, width, width);
    b.mesh.position.copy(from).lerp(to, 0.5);
    b.mat.color.set(color);
    b.mat.opacity = opacity;
    b.opacity = opacity;
    b.seconds = seconds;
    b.life = seconds;
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

  /** A small puff of dust off a wall (a punch). */
  dust(pos: THREE.Vector3, normal: THREE.Vector3) {
    this.burst(pos, normal, 8, [0.7, 0.65, 0.55], 140);
  }

  /** Per frame: draw tracers and rockets at the given positions and age everything else. */
  update(
    dt: number,
    tracers: { head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[],
    rockets: { id: number; head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[] = [],
    grenades: { pos: THREE.Vector3; fuseLeft: number }[] = [],
  ) {
    for (let i = 0; i < MAX_GRENADES; i++) {
      const g = this.grenades[i];
      const t = grenades[i];
      g.ball.visible = g.blink.visible = !!t;
      if (!t) continue;
      g.ball.position.copy(t.pos);
      g.ball.rotation.x += dt * 8;
      g.blink.position.copy(t.pos).z += 3;
      // Blinks faster as the fuse runs down.
      const rate = 2 + 10 * Math.max(0, 1 - t.fuseLeft / 2);
      g.blink.visible = Math.sin(t.fuseLeft * rate * Math.PI * 2) > 0;
    }
    this.flashTime = Math.max(0, this.flashTime - dt);
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.mat.opacity = Math.max(0, (b.life / b.seconds) * b.opacity);
      if (b.life <= 0) b.mesh.visible = false;
    }
    this.updateRockets(dt, rockets);
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const t = 1 - Math.max(0, b.life) / BLAST_SECONDS;
      b.sprite.scale.setScalar(b.size * (0.35 + 0.65 * Math.sqrt(t)));
      b.sprite.material.opacity = 1 - t;
      if (b.life <= 0) b.sprite.visible = false;
    }
    for (const l of this.blastLights) {
      l.life = Math.max(0, l.life - dt);
      l.light.intensity = l.life > 0 ? 8 * (l.life / BLAST_SECONDS) : 0;
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

  private updateRockets(dt: number, rockets: { id: number; head: THREE.Vector3; dir: THREE.Vector3; travelled: number }[]) {
    const live = new Set<number>();
    for (let i = 0; i < MAX_ROCKETS; i++) {
      const r = this.rockets[i];
      const t = rockets[i];
      r.glow.visible = r.flame.visible = !!t;
      if (!t) continue;
      live.add(t.id);
      r.glow.position.copy(t.head);
      const len = Math.max(1, Math.min(ROCKET_FLAME_LENGTH, t.travelled));
      r.flame.quaternion.setFromUnitVectors(Effects.X, t.dir);
      r.flame.scale.set(len, 2.6, 2.6);
      r.flame.position.copy(t.head).addScaledVector(t.dir, -len / 2);
      if (!this.smoke.length) continue;
      // Smoke puffs left along the way.
      let from = this.smokeFrom.get(t.id);
      if (!from) this.smokeFrom.set(t.id, (from = t.head.clone()));
      const gap = from.distanceTo(t.head);
      if (gap > 200) from.copy(t.head); // through a portal: start again at the exit
      while (from.distanceTo(t.head) >= SMOKE_SPACING) {
        from.addScaledVector(this.tmpDir.copy(t.head).sub(from).normalize(), SMOKE_SPACING);
        this.puff(from);
      }
    }
    for (const id of this.smokeFrom.keys()) if (!live.has(id)) this.smokeFrom.delete(id);
    for (const p of this.smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const t = 1 - Math.max(0, p.life) / SMOKE_SECONDS;
      p.sprite.scale.setScalar(6 + 22 * t * p.grow);
      p.sprite.material.opacity = 1 - t;
      p.sprite.position.z += 12 * dt;
      if (p.life <= 0) p.sprite.visible = false;
    }
  }

  private puff(at: THREE.Vector3) {
    const p = this.smoke[this.smokeCursor];
    this.smokeCursor = (this.smokeCursor + 1) % this.smoke.length;
    p.sprite.position.copy(at);
    p.sprite.material.rotation = Math.random() * Math.PI * 2;
    p.life = SMOKE_SECONDS;
    p.grow = 0.7 + Math.random() * 0.6;
    p.sprite.visible = true;
  }
}
