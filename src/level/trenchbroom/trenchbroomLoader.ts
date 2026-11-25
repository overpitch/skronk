import { vec3, type Vec3 } from "../../math/vec3";
import type {
  CollisionBrush,
  CollisionPlane,
  LevelData,
  LevelLoader,
  LightMarker,
  PickupMarker,
  SpawnPoint,
  Surface,
} from "../types";
import { buildBrushPolygons, computeUVs } from "./brushGeometry";
import { parseMap, type MapEntity } from "./mapParser";

/** Bit positions must match the order of "surfaceflags" in trenchbroom/Skronk/GameConfig.cfg. */
export const SURF_PORTAL = 1 << 0;
export const SURF_NODRAW = 1 << 1;

/** Entities whose brushes are treated as static world geometry. */
const WORLD_BRUSH_CLASSES = new Set(["worldspawn", "func_group", "func_detail"]);

const textureIsHidden = (tex: string) => {
  const base = tex.toLowerCase().split("/").pop() ?? "";
  return base === "clip" || base === "nodraw" || base === "skip";
};

function parseVec(s: string | undefined): Vec3 | null {
  if (!s) return null;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return vec3(parts[0], parts[1], parts[2]);
}

/** Axial planes on the brush bounds, so box traces don't snag on brush edges. */
function addBevels(planes: CollisionPlane[], mins: Vec3, maxs: Vec3) {
  const axes: [Vec3, number][] = [
    [vec3(1, 0, 0), maxs.x],
    [vec3(-1, 0, 0), -mins.x],
    [vec3(0, 1, 0), maxs.y],
    [vec3(0, -1, 0), -mins.y],
    [vec3(0, 0, 1), maxs.z],
    [vec3(0, 0, -1), -mins.z],
  ];
  for (const [normal, dist] of axes) {
    const exists = planes.some(
      (p) => p.normal.x * normal.x + p.normal.y * normal.y + p.normal.z * normal.z > 0.9999,
    );
    if (!exists) planes.push({ normal, dist, surface: -1 });
  }
}

export function buildLevel(name: string, entities: MapEntity[]): LevelData {
  const surfaces: Surface[] = [];
  const brushes: CollisionBrush[] = [];
  const spawns: SpawnPoint[] = [];
  const pickups: PickupMarker[] = [];
  const lights: LightMarker[] = [];
  const levelMins = vec3(Infinity, Infinity, Infinity);
  const levelMaxs = vec3(-Infinity, -Infinity, -Infinity);
  const warnings: string[] = [];

  for (const ent of entities) {
    const classname = ent.properties.classname ?? "";

    if (WORLD_BRUSH_CLASSES.has(classname)) {
      for (const brush of ent.brushes) {
        const { polygons } = buildBrushPolygons(brush.faces);
        if (polygons.length < 4) {
          warnings.push(`brush at line ${brush.line} is degenerate, skipped`);
          continue;
        }
        const mins = vec3(Infinity, Infinity, Infinity);
        const maxs = vec3(-Infinity, -Infinity, -Infinity);
        const collisionPlanes: CollisionPlane[] = [];
        for (const poly of polygons) {
          const face = brush.faces[poly.faceIndex];
          for (const p of poly.vertices) {
            mins.x = Math.min(mins.x, p.x);
            mins.y = Math.min(mins.y, p.y);
            mins.z = Math.min(mins.z, p.z);
            maxs.x = Math.max(maxs.x, p.x);
            maxs.y = Math.max(maxs.y, p.y);
            maxs.z = Math.max(maxs.z, p.z);
          }
          const surfaceIndex = surfaces.length;
          surfaces.push({
            plane: poly.plane,
            vertices: poly.vertices,
            uvs: computeUVs(poly.vertices, face, poly.plane.normal),
            texture: face.texture,
            portalFriendly: (face.surfaceFlags & SURF_PORTAL) !== 0,
            visible: (face.surfaceFlags & SURF_NODRAW) === 0 && !textureIsHidden(face.texture),
          });
          collisionPlanes.push({ ...poly.plane, surface: surfaceIndex });
        }
        addBevels(collisionPlanes, mins, maxs);
        brushes.push({ planes: collisionPlanes, mins, maxs });
        levelMins.x = Math.min(levelMins.x, mins.x);
        levelMins.y = Math.min(levelMins.y, mins.y);
        levelMins.z = Math.min(levelMins.z, mins.z);
        levelMaxs.x = Math.max(levelMaxs.x, maxs.x);
        levelMaxs.y = Math.max(levelMaxs.y, maxs.y);
        levelMaxs.z = Math.max(levelMaxs.z, maxs.z);
      }
      continue;
    }

    const origin = parseVec(ent.properties.origin);
    if (!origin) continue;
    if (classname === "player_spawn") {
      const angle = Number(ent.properties.angle ?? 0);
      spawns.push({
        origin,
        yaw: ((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180,
        team: Number(ent.properties.team ?? 0) || 0,
      });
    } else if (classname.startsWith("pickup_")) {
      const { classname: _c, origin: _o, ...properties } = ent.properties;
      pickups.push({ kind: classname.slice("pickup_".length), origin, properties });
    } else if (classname === "light") {
      const color = parseVec(ent.properties._color) ?? vec3(1, 1, 1);
      lights.push({
        origin,
        intensity: Number(ent.properties.light ?? 300) || 300,
        color: [color.x, color.y, color.z],
      });
    }
  }

  if (brushes.length === 0) throw new Error(`map '${name}' has no world brushes`);
  if (spawns.length === 0) warnings.push("no player_spawn entities; players will spawn at the map center");
  for (const w of warnings) console.warn(`[level ${name}] ${w}`);

  return { name, surfaces, brushes, spawns, pickups, lights, mins: levelMins, maxs: levelMaxs };
}

export class TrenchBroomLoader implements LevelLoader {
  async load(url: string): Promise<LevelData> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not load map ${url}: HTTP ${res.status}`);
    const text = await res.text();
    const name = url.split("/").pop()?.replace(/\.map$/, "") ?? url;
    return buildLevel(name, parseMap(text));
  }
}
