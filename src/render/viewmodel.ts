/**
 * The first-person gun, drawn in its own scene after the world with a cleared
 * depth buffer so it never clips into walls. Camera space: -Z forward, +Y up.
 */
import * as THREE from "three";

const REST = new THREE.Vector3(4.4, -4.2, -13.5);
/** Fixed horizontal FOV, like the world camera, so the gun sits the same on any screen shape. */
const HORIZONTAL_FOV_DEG = 74;
const KICK_BACK = 1.8;
const KICK_PITCH = 0.14;
const KICK_RECOVERY = 16; // per second, exponential

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
  private gun = new THREE.Group();
  private flash: THREE.Sprite;
  private kick = 0;
  private flashTime = 0;
  private bobPhase = 0;
  private bobAmount = 0;

  constructor() {
    const metal = new THREE.MeshLambertMaterial({ color: 0x40454f });
    const dark = new THREE.MeshLambertMaterial({ color: 0x23262c });
    const glow = new THREE.MeshBasicMaterial({ color: 0x4fd6ff });
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.gun.add(m);
      return m;
    };
    part(new THREE.BoxGeometry(2.4, 2.6, 9), metal, 0, 0, 0);
    part(new THREE.BoxGeometry(1.9, 1.2, 7), dark, 0, 1.7, -0.5);
    const barrel = part(new THREE.CylinderGeometry(0.55, 0.7, 6.5, 12), dark, 0, 0.5, -7.4);
    barrel.rotation.x = Math.PI / 2;
    part(new THREE.BoxGeometry(0.35, 0.5, 6.5), glow, 1.25, 0.55, -0.6);
    part(new THREE.BoxGeometry(0.35, 0.5, 6.5), glow, -1.25, 0.55, -0.6);
    const grip = part(new THREE.BoxGeometry(1.7, 3.6, 2), dark, 0, -2.4, 2.4);
    grip.rotation.x = -0.35;

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
    this.flash.position.set(0, 0.5, -11.2);
    this.flash.visible = false;
    this.gun.add(this.flash);

    this.gun.position.copy(REST);
    this.gun.scale.setScalar(0.8);
    this.scene.add(this.gun);
    this.scene.add(new THREE.HemisphereLight(0xd8e0ff, 0x4a4038, 2.6));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.6);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    const hfov = (HORIZONTAL_FOV_DEG * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  fire() {
    this.kick = 1;
    this.flashTime = 0.05;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(3 + Math.random() * 1.5);
  }

  /** speedFraction: horizontal speed / max run speed. */
  update(dt: number, speedFraction: number, onGround: boolean, visible: boolean) {
    this.gun.visible = visible;
    this.kick *= Math.exp(-KICK_RECOVERY * dt);
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.flash.visible = this.flashTime > 0;

    const target = onGround ? Math.min(1, speedFraction) : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * 11 * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.35 * this.bobAmount;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.3 * this.bobAmount;

    this.gun.position.set(REST.x + bobX, REST.y + bobY, REST.z + this.kick * KICK_BACK);
    this.gun.rotation.set(this.kick * KICK_PITCH, 0, 0);
  }
}
