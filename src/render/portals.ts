/**
 * Draws placed portals. A lone portal is a faint swirl. A linked one is a window:
 * each frame the scene is rendered from a camera carried through the pair into a
 * texture, and the portal surface shows that texture in screen space, so every
 * pixel of the opening shows exactly what lies beyond the partner.
 *
 * One level only: portals seen inside a portal view show their swirl, not
 * another view. Each view is a full extra scene render (scissored to the
 * opening), so the quality profile caps how many and how sharp.
 */
import * as THREE from "three";
import { PORTAL, type Portal } from "../sim/portals";

/** How long a new portal takes to open to full size. */
const OPEN_SECONDS = 0.18;
/** Draw just off the wall so it never fights the wall for depth. */
const SURFACE_LIFT = 0.6;
const ALONE_OPACITY = 0.28;
/** How many portal views to draw, how sharp: from the quality profile. */
export interface PortalViewOptions {
  /** Most views rendered per frame, nearest first. Others fall back to the swirl. */
  maxViews: number;
  /** Render target size as a fraction of the screen's. */
  scale: number;
  /** Multisampling inside the views (0 for none). */
  samples: number;
}
/**
 * The cup: the view continues this far behind the surface, so when your camera's
 * near plane slices through the portal (and the wall) as you step in, you still
 * see the view rather than the inside of the wall.
 */
const CUP_DEPTH = 12;
/** Exit-side clip, just in front of the exit surface so the wall behind it never shows. */
const CLIP_OFFSET = 0.25;
/** Layer for things only portal views see, like your own body. */
export const PORTAL_ONLY_LAYER = 1;

const VERTEX = /* glsl */ `
#include <clipping_planes_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform sampler2D swirlMap;
uniform sampler2D viewMap;
uniform vec2 resolution;
uniform vec3 color;
uniform float opacity;
uniform float viewMix;
uniform float angle;
varying vec2 vUv;
void main() {
  #include <clipping_planes_fragment>
  vec2 c = vUv - 0.5;
  float s = sin(angle), k = cos(angle);
  vec3 swirl = texture2D(swirlMap, vec2(k * c.x - s * c.y, s * c.x + k * c.y) + 0.5).rgb * color;
  vec3 view = texture2D(viewMap, gl_FragCoord.xy / resolution).rgb;
  // A thin wash of the portal's colour at the edge, so you can tell which end it is.
  view = mix(view, color, smoothstep(0.4, 0.5, length(c)) * 0.55);
  gl_FragColor = vec4(mix(swirl, view, viewMix), mix(opacity, 1.0, viewMix));
  #include <colorspace_fragment>
}
`;

/** Opaque disc, dark in the middle and lighter out to the edge, with spiral arms. Grey so a material colour tints it. */
function swirlTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, "rgb(25,25,25)");
  grad.addColorStop(0.7, "rgb(70,70,70)");
  grad.addColorStop(1, "rgb(190,190,190)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = 3;
  for (let arm = 0; arm < 4; arm++) {
    g.beginPath();
    for (let t = 0; t <= 1; t += 0.02) {
      const a = arm * (Math.PI / 2) + t * Math.PI * 1.6;
      const r = t * c;
      if (t === 0) g.moveTo(c, c);
      else g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.center.set(0.5, 0.5);
  return tex;
}

/** A soft bright ring at the edge of the disc. */
function rimTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.8, "rgba(255,255,255,0)");
  grad.addColorStop(0.9, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface View {
  group: THREE.Group;
  fill: THREE.ShaderMaterial;
  rim: THREE.MeshBasicMaterial;
  born: number;
  target: THREE.WebGLRenderTarget | null;
}

interface Pass {
  view: View;
  from: Portal;
  to: Portal;
  distance: number;
}

export class PortalViews {
  private views = new Map<number, View>();
  private disc = new THREE.CircleGeometry(1, 48);
  private cup = cupGeometry();
  private swirl = swirlTexture();
  private rimTex = rimTexture();
  private blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  private basis = new THREE.Matrix4();
  private axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private swirlAngle = 0;
  // Scratch for the view passes.
  private virtual = new THREE.PerspectiveCamera();
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private size = new THREE.Vector2();
  private m1 = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private through = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private clip = new THREE.Plane();

  constructor(
    private scene: THREE.Scene,
    private options: PortalViewOptions,
  ) {
    this.blank.needsUpdate = true;
    this.virtual.matrixAutoUpdate = false;
    this.virtual.layers.enable(PORTAL_ONLY_LAYER);
  }

  update(
    portals: readonly Portal[],
    isLinked: (p: Portal) => boolean,
    colorOf: (p: Portal) => THREE.ColorRepresentation,
    timeSeconds: number,
  ) {
    const live = new Set<number>();
    for (const p of portals) {
      live.add(p.id);
      let view = this.views.get(p.id);
      if (!view) view = this.create(p, colorOf(p), timeSeconds);
      const open = Math.min(1, (timeSeconds - view.born) / OPEN_SECONDS);
      const ease = 1 - (1 - open) ** 3;
      view.group.scale.setScalar(Math.max(0.001, ease));
      const u = view.fill.uniforms;
      u.opacity.value += ((isLinked(p) ? 1 : ALONE_OPACITY) - u.opacity.value) * 0.2;
      view.rim.opacity = 0.75 + 0.25 * Math.sin(timeSeconds * 5 + p.id);
    }
    for (const [id, view] of this.views) {
      if (live.has(id)) continue;
      this.scene.remove(view.group);
      view.fill.dispose();
      view.rim.dispose();
      view.target?.dispose();
      this.views.delete(id);
    }
    this.swirlAngle = -timeSeconds * 1.2;
  }

  /**
   * Renders what each visible linked portal looks onto, into its texture.
   * Call after update() and before the main scene render, with the main camera placed.
   */
  renderViews(gl: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, portals: readonly Portal[], partnerOf: (p: Portal) => Portal | null) {
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.m1.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    gl.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.round(this.size.x * this.options.scale));
    const h = Math.max(1, Math.round(this.size.y * this.options.scale));

    const passes: Pass[] = [];
    for (const p of portals) {
      const view = this.views.get(p.id);
      if (!view) continue;
      view.fill.uniforms.angle.value = this.swirlAngle;
      view.fill.uniforms.resolution.value.copy(this.size);
      view.fill.uniforms.viewMix.value = 0;
      // Never leave a target bound while it might be drawn into (a WebGL feedback loop).
      view.fill.uniforms.viewMap.value = this.blank;
      const to = partnerOf(p);
      if (!to) continue;
      const n = this.v.copy(camera.position).sub(vec(p.origin)).dot(vec(p.normal));
      if (n <= 0) continue; // behind it: you can only look into a portal from the front
      this.sphere.set(vec(p.origin), PORTAL.halfHeight * 1.1);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      passes.push({ view, from: p, to, distance: camera.position.distanceTo(this.sphere.center) });
    }
    passes.sort((a, b) => a.distance - b.distance);
    passes.length = Math.min(passes.length, this.options.maxViews);
    if (passes.length === 0) return;

    // Inside a view, portals show their swirl; that's what stops the recursion.
    const savedTarget = gl.getRenderTarget();
    const savedClipping = gl.clippingPlanes;
    for (const pass of passes) {
      const { view, from, to } = pass;
      if (!view.target) {
        view.target = new THREE.WebGLRenderTarget(w, h, { samples: this.options.samples });
        view.target.texture.colorSpace = THREE.SRGBColorSpace;
      } else if (view.target.width !== w || view.target.height !== h) {
        view.target.setSize(w, h);
      }
      this.placeVirtual(camera, from, to);
      this.scissorTo(view.target, camera, from, w, h);

      // Clip everything behind the exit (its wall, and whatever is beyond), and hide the exit itself.
      this.clip.normal.copy(vec(to.normal));
      this.clip.constant = -this.clip.normal.dot(vec(to.origin)) - CLIP_OFFSET;
      gl.clippingPlanes = [this.clip];
      const exit = this.views.get(to.id);
      if (exit) exit.group.visible = false;
      gl.setRenderTarget(view.target);
      gl.clear();
      gl.render(this.scene, this.virtual);
      if (exit) exit.group.visible = true;
    }
    gl.clippingPlanes = savedClipping;
    gl.setRenderTarget(savedTarget);

    for (const { view } of passes) {
      view.fill.uniforms.viewMap.value = view.target!.texture;
      view.fill.uniforms.viewMix.value = 1;
    }
  }

  /** The main camera carried through `from` and out of `to`. */
  private placeVirtual(camera: THREE.PerspectiveCamera, from: Portal, to: Portal) {
    // Rotation: into from's frame (right, up, normal), turn half round about up, out in to's frame.
    const into = this.m1.makeBasis(vec(from.right), vec(from.up), vec(from.normal)).transpose();
    const out = this.m2.makeBasis(vec(to.right), vec(to.up), vec(to.normal));
    out.multiply(this.through.makeScale(-1, 1, -1)).multiply(into);
    // Translation: relative to from's origin in, relative to to's origin out.
    const t = this.through.makeTranslation(-from.origin.x, -from.origin.y, -from.origin.z);
    out.multiply(t);
    out.premultiply(this.m1.makeTranslation(to.origin.x, to.origin.y, to.origin.z));
    this.virtual.matrix.multiplyMatrices(out, camera.matrixWorld);
    this.virtual.updateMatrixWorld(true);
    this.virtual.projectionMatrix.copy(camera.projectionMatrix);
    this.virtual.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  }

  /** Only redraw the part of the screen the opening covers (the whole screen when close). */
  private scissorTo(target: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera, p: Portal, w: number, h: number) {
    target.scissorTest = false;
    const n = this.v.copy(camera.position).sub(vec(p.origin)).dot(vec(p.normal));
    if (n < CUP_DEPTH + camera.near * 4) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [r, u] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.v
        .copy(vec(p.origin))
        .addScaledVector(vec(p.right), r * PORTAL.halfWidth * 1.15)
        .addScaledVector(vec(p.up), u * PORTAL.halfHeight * 1.15);
      this.v.applyMatrix4(camera.matrixWorldInverse);
      if (this.v.z > -camera.near) return; // a corner behind the camera: no useful bound
      this.v.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, this.v.x); x1 = Math.max(x1, this.v.x);
      y0 = Math.min(y0, this.v.y); y1 = Math.max(y1, this.v.y);
    }
    const px = (ndc: number, size: number) => Math.max(0, Math.min(size, ((ndc + 1) / 2) * size));
    const left = Math.floor(px(x0, w)), right = Math.ceil(px(x1, w));
    const bottom = Math.floor(px(y0, h)), top = Math.ceil(px(y1, h));
    target.scissor.set(left, bottom, Math.max(1, right - left), Math.max(1, top - bottom));
    target.scissorTest = true;
  }

  private create(p: Portal, color: THREE.ColorRepresentation, now: number): View {
    const fill = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        swirlMap: { value: this.swirl },
        viewMap: { value: this.blank },
        resolution: { value: new THREE.Vector2(1, 1) },
        color: { value: new THREE.Color(color) },
        opacity: { value: 0 },
        viewMix: { value: 0 },
        angle: { value: 0 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      clipping: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const rim = new THREE.MeshBasicMaterial({
      map: this.rimTex,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const fillMesh = new THREE.Mesh(this.disc, fill);
    fillMesh.scale.set(PORTAL.halfWidth, PORTAL.halfHeight, 1);
    const cupMesh = new THREE.Mesh(this.cup, fill);
    cupMesh.scale.set(PORTAL.halfWidth, PORTAL.halfHeight, 1);
    const rimMesh = new THREE.Mesh(this.disc, rim);
    rimMesh.scale.set(PORTAL.halfWidth * 1.12, PORTAL.halfHeight * 1.07, 1);
    rimMesh.position.z = 0.1;

    const group = new THREE.Group();
    group.add(fillMesh, cupMesh, rimMesh);
    // Disc X/Y/Z become the portal's right/up/normal.
    const [r, u, n] = this.axes;
    r.set(p.right.x, p.right.y, p.right.z);
    u.set(p.up.x, p.up.y, p.up.z);
    n.set(p.normal.x, p.normal.y, p.normal.z);
    this.basis.makeBasis(r, u, n);
    group.quaternion.setFromRotationMatrix(this.basis);
    group.position.set(p.origin.x, p.origin.y, p.origin.z).addScaledVector(n, SURFACE_LIFT);
    this.scene.add(group);

    const view: View = { group, fill, rim, born: now, target: null };
    this.views.set(p.id, view);
    return view;
  }
}

const scratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
let scratchIndex = 0;
/** A sim Vec3 as a short-lived THREE.Vector3 (four in rotation; don't hold on to them). */
function vec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return scratch[scratchIndex++ & 3].set(v.x, v.y, v.z);
}

/**
 * Unit ellipse tube from the surface back CUP_DEPTH, closed at the back. Its uvs sit
 * at the centre so the edge tint stays on the front disc.
 */
function cupGeometry(): THREE.BufferGeometry {
  const tube = new THREE.CylinderGeometry(1, 1, CUP_DEPTH, 48, 1, true);
  tube.rotateX(Math.PI / 2); // axis along z
  tube.translate(0, 0, -CUP_DEPTH / 2 - SURFACE_LIFT);
  const back = new THREE.CircleGeometry(1, 48);
  back.translate(0, 0, -CUP_DEPTH - SURFACE_LIFT);
  const pos: number[] = [];
  for (const g of [tube, back]) {
    const src = g.toNonIndexed().getAttribute("position");
    for (let i = 0; i < src.count; i++) pos.push(src.getX(i), src.getY(i), src.getZ(i));
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0.5), 2));
  return geo;
}
