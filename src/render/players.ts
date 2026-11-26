/**
 * Placeholder bodies for other players: a box the size of their hit box with
 * a glowing visor showing where they face. Flashes when hit.
 */
import * as THREE from "three";
import type { PlayerId } from "../sim/events";
import { EYE_HEIGHT, PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";

const TEAM_COLORS: Record<number, number> = { 0: 0xd2643c, 1: 0xc84848, 2: 0x4878c8 };
const HIT_FLASH_SECONDS = 0.12;

interface Body {
  group: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  flash: number;
}

export class PlayerModels {
  private bodies = new Map<PlayerId, Body>();
  private bodyGeo: THREE.BoxGeometry;
  private visorGeo = new THREE.BoxGeometry(6, 22, 7);
  private visorMat = new THREE.MeshBasicMaterial({ color: 0x7fe8ff });

  constructor(
    private scene: THREE.Scene,
    /** Bodies cast shadows (Full quality). */
    private castShadows = false,
  ) {
    const w = PLAYER_MAXS.x - PLAYER_MINS.x - 2;
    const h = PLAYER_MAXS.z - PLAYER_MINS.z - 2;
    this.bodyGeo = new THREE.BoxGeometry(w, w, h);
    this.bodyGeo.translate(0, 0, (PLAYER_MINS.z + PLAYER_MAXS.z) / 2);
  }

  /** Make sure a body exists for each id in `ids`, and remove the rest. */
  sync(ids: Iterable<PlayerId>, teamOf: (id: PlayerId) => number) {
    const keep = new Set(ids);
    for (const [id, b] of this.bodies) {
      if (!keep.has(id)) {
        this.scene.remove(b.group);
        b.bodyMat.dispose();
        this.bodies.delete(id);
      }
    }
    for (const id of keep) {
      if (this.bodies.has(id)) continue;
      const bodyMat = new THREE.MeshLambertMaterial({ color: TEAM_COLORS[teamOf(id)] ?? TEAM_COLORS[0], emissive: 0xffffff, emissiveIntensity: 0 });
      const group = new THREE.Group();
      group.add(new THREE.Mesh(this.bodyGeo, bodyMat));
      const visor = new THREE.Mesh(this.visorGeo, this.visorMat);
      visor.position.set(PLAYER_MAXS.x - 1, 0, EYE_HEIGHT);
      group.add(visor);
      if (this.castShadows) group.traverse((o) => (o.castShadow = true));
      this.scene.add(group);
      this.bodies.set(id, { group, bodyMat, flash: 0 });
    }
  }

  place(id: PlayerId, x: number, y: number, z: number, yaw: number, visible: boolean) {
    const b = this.bodies.get(id);
    if (!b) return;
    b.group.visible = visible;
    b.group.position.set(x, y, z);
    b.group.rotation.z = yaw;
  }

  /** Puts a body on one render layer only (the local player's lives on the portal-only layer). */
  setLayer(id: PlayerId, layer: number) {
    const b = this.bodies.get(id);
    if (!b || b.group.userData.layer === layer) return;
    b.group.userData.layer = layer;
    b.group.traverse((o) => o.layers.set(layer));
  }

  hit(id: PlayerId) {
    const b = this.bodies.get(id);
    if (b) b.flash = HIT_FLASH_SECONDS;
  }

  update(dt: number) {
    for (const b of this.bodies.values()) {
      b.flash = Math.max(0, b.flash - dt);
      b.bodyMat.emissiveIntensity = (b.flash / HIT_FLASH_SECONDS) * 0.8;
    }
  }
}
