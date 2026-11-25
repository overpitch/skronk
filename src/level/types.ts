/**
 * The loader interface. The simulation and renderer only ever see LevelData.
 * TrenchBroom .map files are one source; heightmap terrain or streamed chunks
 * would be other LevelLoader implementations producing the same shape.
 */
import type { Vec3 } from "../math/vec3";

/** Points p with dot(normal, p) <= dist are inside (solid side). Normal points out of the brush. */
export interface Plane {
  normal: Vec3;
  dist: number;
}

/** A drawable polygon on the surface of a brush. */
export interface Surface {
  plane: Plane;
  /** Convex polygon, counter-clockwise when viewed from the front (normal side). */
  vertices: Vec3[];
  /** Texture coordinates in texels (divide by texture size to get 0..1). */
  uvs: [number, number][];
  texture: string;
  portalFriendly: boolean;
  visible: boolean;
}

export interface CollisionPlane extends Plane {
  /** Index into LevelData.surfaces, or -1 for planes added only for collision (bevels). */
  surface: number;
}

/** A convex solid. Collision is the intersection of its planes' back half-spaces. */
export interface CollisionBrush {
  planes: CollisionPlane[];
  mins: Vec3;
  maxs: Vec3;
}

export interface SpawnPoint {
  origin: Vec3;
  /** Radians. */
  yaw: number;
  /** 0 = any team. */
  team: number;
}

export interface PickupMarker {
  /** e.g. "health", "armor", "ammo" (entity classname minus "pickup_"). */
  kind: string;
  origin: Vec3;
  properties: Record<string, string>;
}

export interface LightMarker {
  origin: Vec3;
  intensity: number;
  color: [number, number, number];
}

export interface LevelData {
  name: string;
  surfaces: Surface[];
  brushes: CollisionBrush[];
  spawns: SpawnPoint[];
  pickups: PickupMarker[];
  lights: LightMarker[];
  mins: Vec3;
  maxs: Vec3;
}

export interface LevelLoader {
  load(url: string): Promise<LevelData>;
}
