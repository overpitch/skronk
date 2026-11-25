/**
 * Draws placed portals as glowing ovals on their surfaces. For now a portal is
 * a placeholder: a swirl, solid once its pair is linked and faint while it is
 * alone. Seeing through portals replaces the swirl in a later step.
 */
import * as THREE from "three";
import { PORTAL, type Portal } from "../sim/portals";

/** How long a new portal takes to open to full size. */
const OPEN_SECONDS = 0.18;
/** Draw just off the wall so it never fights the wall for depth. */
const SURFACE_LIFT = 0.6;
const LINKED_OPACITY = 0.92;
const ALONE_OPACITY = 0.28;

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
  fill: THREE.MeshBasicMaterial;
  rim: THREE.MeshBasicMaterial;
  born: number;
}

export class PortalViews {
  private views = new Map<number, View>();
  private disc = new THREE.CircleGeometry(1, 48);
  private swirl = swirlTexture();
  private rimTex = rimTexture();
  private basis = new THREE.Matrix4();
  private axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  constructor(private scene: THREE.Scene) {}

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
      const target = isLinked(p) ? LINKED_OPACITY : ALONE_OPACITY;
      view.fill.opacity += (target - view.fill.opacity) * 0.2;
      view.rim.opacity = 0.75 + 0.25 * Math.sin(timeSeconds * 5 + p.id);
    }
    for (const [id, view] of this.views) {
      if (live.has(id)) continue;
      this.scene.remove(view.group);
      view.fill.dispose();
      view.rim.dispose();
      this.views.delete(id);
    }
    this.swirl.rotation = -timeSeconds * 1.2;
  }

  private create(p: Portal, color: THREE.ColorRepresentation, now: number): View {
    const fill = new THREE.MeshBasicMaterial({
      map: this.swirl,
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
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
    const rimMesh = new THREE.Mesh(this.disc, rim);
    rimMesh.scale.set(PORTAL.halfWidth * 1.12, PORTAL.halfHeight * 1.07, 1);
    rimMesh.position.z = 0.1;

    const group = new THREE.Group();
    group.add(fillMesh, rimMesh);
    // Disc X/Y/Z become the portal's right/up/normal.
    const [r, u, n] = this.axes;
    r.set(p.right.x, p.right.y, p.right.z);
    u.set(p.up.x, p.up.y, p.up.z);
    n.set(p.normal.x, p.normal.y, p.normal.z);
    this.basis.makeBasis(r, u, n);
    group.quaternion.setFromRotationMatrix(this.basis);
    group.position.set(p.origin.x, p.origin.y, p.origin.z).addScaledVector(n, SURFACE_LIFT);
    this.scene.add(group);

    const view = { group, fill, rim, born: now };
    this.views.set(p.id, view);
    return view;
  }
}
