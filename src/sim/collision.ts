/**
 * Swept axis-aligned box traces against convex brushes.
 * Each brush plane is pushed out by the box's extent along the plane normal
 * (a Minkowski sum), then the box centre is traced as a point.
 */
import { vec3, type Vec3 } from "../math/vec3";
import type { CollisionBrush, CollisionPlane } from "../level/types";

/** Stop this far short of a surface, so the next trace doesn't start inside it. */
const DIST_EPSILON = 1 / 32;

export interface TraceResult {
  /** 0..1, how far along start->end the box got. */
  fraction: number;
  endPos: Vec3;
  /** Normal of the surface hit (zero if nothing was hit). */
  normal: Vec3;
  plane: CollisionPlane | null;
  brush: number;
  /** The box started inside a brush. */
  startSolid: boolean;
  /** The box was inside a brush for the whole trace. */
  allSolid: boolean;
}

export class CollisionWorld {
  constructor(readonly brushes: CollisionBrush[]) {}

  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): TraceResult {
    const tr: TraceResult = {
      fraction: 1,
      endPos: vec3(),
      normal: vec3(),
      plane: null,
      brush: -1,
      startSolid: false,
      allSolid: false,
    };

    // Broadphase: bounds of the whole swept box.
    const sx0 = Math.min(start.x, end.x) + mins.x - 1;
    const sy0 = Math.min(start.y, end.y) + mins.y - 1;
    const sz0 = Math.min(start.z, end.z) + mins.z - 1;
    const sx1 = Math.max(start.x, end.x) + maxs.x + 1;
    const sy1 = Math.max(start.y, end.y) + maxs.y + 1;
    const sz1 = Math.max(start.z, end.z) + maxs.z + 1;

    for (let b = 0; b < this.brushes.length; b++) {
      const brush = this.brushes[b];
      if (
        brush.mins.x > sx1 || brush.maxs.x < sx0 ||
        brush.mins.y > sy1 || brush.maxs.y < sy0 ||
        brush.mins.z > sz1 || brush.maxs.z < sz0
      ) continue;
      traceBrush(tr, b, brush, start, end, mins, maxs);
      if (tr.allSolid) break;
    }

    const f = tr.fraction;
    tr.endPos.x = start.x + (end.x - start.x) * f;
    tr.endPos.y = start.y + (end.y - start.y) * f;
    tr.endPos.z = start.z + (end.z - start.z) * f;
    if (tr.plane) {
      tr.normal.x = tr.plane.normal.x;
      tr.normal.y = tr.plane.normal.y;
      tr.normal.z = tr.plane.normal.z;
    }
    return tr;
  }
}

function traceBrush(
  tr: TraceResult,
  brushIndex: number,
  brush: CollisionBrush,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
) {
  let enterFrac = -1;
  let leaveFrac = 1;
  let hit: CollisionPlane | null = null;
  let startOut = false;
  let getOut = false;

  for (const plane of brush.planes) {
    const n = plane.normal;
    // Corner of the box that reaches furthest into the plane's solid side.
    const offset =
      n.x * (n.x < 0 ? maxs.x : mins.x) + n.y * (n.y < 0 ? maxs.y : mins.y) + n.z * (n.z < 0 ? maxs.z : mins.z);
    const dist = plane.dist - offset;
    const d1 = start.x * n.x + start.y * n.y + start.z * n.z - dist;
    const d2 = end.x * n.x + end.y * n.y + end.z * n.z - dist;

    if (d2 > 0) getOut = true;
    if (d1 > 0) startOut = true;

    // Entirely in front of this plane: the trace misses the brush.
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
    // Entirely behind this plane: it doesn't limit the trace.
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      // Entering the brush through this plane.
      const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
      if (f > enterFrac) {
        enterFrac = f;
        hit = plane;
      }
    } else {
      // Leaving.
      const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startOut) {
    tr.startSolid = true;
    if (!getOut) {
      tr.allSolid = true;
      tr.fraction = 0;
      tr.brush = brushIndex;
    }
    return;
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction) {
    tr.fraction = enterFrac;
    tr.plane = hit;
    tr.brush = brushIndex;
  }
}
