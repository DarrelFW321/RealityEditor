import type { EditorState, Occupancy, Scp, Vec3 } from '@reality/contracts';
import { baseOrigin, footprint, raycast, type ObjectLike, type P2 } from './geometry';

/**
 * Builds the Spatial Context Packet: what the model needs to resolve "that one" and
 * "over there" without doing any geometry itself.
 *
 * The schema is emphatic about two things and both shape this file:
 *
 *   "MUST stay under ~2KB serialised — at 10Hz a 4KB packet is 40KB/s of uplink competing
 *    with the audio stream, and the latency budget does not survive that."
 *   "The client scores candidates; the model only confirms. Never ask the model to do
 *    geometry."
 *
 * So every list is bounded, every number is rounded at the point of emission, and the
 * ranking is decided here. The model is given an ordered shortlist and, when the top two
 * are close, the client has already concluded it is ambiguous — the model's job is then
 * to ask, not to break the tie.
 */

/** Schema caps. Exceeding any of them is what breaks the size budget. */
const MAX_VISIBLE = 12;
const MAX_CANDIDATES = 5;
const MAX_SALIENCE = 6;
const MAX_WALL_CLEARANCES = 8;
/** Two candidates closer than this are a tie the client refuses to break. */
export const AMBIGUOUS_SCORE_GAP = 0.1;

export type ViewState = {
  /** Room space. */
  position: Vec3;
  /** Unit view direction in room space. */
  forward: Vec3;
  fovDeg: number;
  /** Normalised viewport point the deixis ray passes through. [0.5,0.5] is the crosshair. */
  screenPoint?: [number, number];
  pointingConfidence?: number;
  pointingSource?: 'hand' | 'phone';
};

export type AttentionState = {
  /** Entity ids, most recent first. Conversational recency, not geometry. */
  salienceStack?: string[];
  lastTap?: { entity: string | null; ageMs: number };
  lastFloorHit?: { point: Vec3 | null; ageMs: number };
};

const round = (value: number, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const norm = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Largest axis-aligned free rectangle, from the occupancy grid.
 *
 * Maximal-rectangle-in-a-histogram, one pass per row. The grid is already built and
 * committed, so this costs a scan rather than a re-rasterisation — which is what makes a
 * "does it fit" answer affordable at 10Hz when sending the grid itself would not be.
 */
export function largestOpenRect(occupancy: Occupancy): {
  center: [number, number];
  size: [number, number];
  yaw: number;
} {
  const [cols, rows] = [occupancy.size[0] ?? 0, occupancy.size[1] ?? 0];
  const empty = { center: [0, 0] as [number, number], size: [0, 0] as [number, number], yaw: 0 };
  if (!cols || !rows) return empty;

  // Expand the runs: they alternate starting FREE.
  const free = new Uint8Array(cols * rows);
  let index = 0;
  let isFree = true;
  for (const run of occupancy.grid_rle) {
    for (let i = 0; i < run && index < free.length; i++) free[index++] = isFree ? 1 : 0;
    isFree = !isFree;
  }

  const heights = new Int32Array(cols);
  let best = { area: 0, x: 0, z: 0, w: 0, h: 0 };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++)
      heights[col] = free[row * cols + col] ? (heights[col] ?? 0) + 1 : 0;
    // Monotonic stack over the histogram for this row.
    const stack: number[] = [];
    for (let col = 0; col <= cols; col++) {
      const height = col === cols ? 0 : (heights[col] ?? 0);
      while (stack.length && (heights[stack[stack.length - 1]!] ?? 0) >= height) {
        const top = stack.pop()!;
        const h = heights[top] ?? 0;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const w = col - left;
        if (h * w > best.area) best = { area: h * w, x: left, z: row - h + 1, w, h };
      }
      stack.push(col);
    }
  }
  if (!best.area) return empty;

  const step = occupancy.resolution_m;
  const originX = occupancy.origin[0] ?? 0;
  const originZ = occupancy.origin[1] ?? 0;
  return {
    center: [
      round(originX + (best.x + best.w / 2 - 0.5) * step),
      round(originZ + (best.z + best.h / 2 - 0.5) * step),
    ],
    size: [round(best.w * step), round(best.h * step)],
    // Axis-aligned by construction: the grid has no rotation to report.
    yaw: 0,
  };
}

/** Free depth outward from each wall face, walked over the same grid. */
function wallClearances(scene: EditorState, occupancy: Occupancy) {
  const [cols, rows] = [occupancy.size[0] ?? 0, occupancy.size[1] ?? 0];
  const free = new Uint8Array(cols * rows);
  let index = 0;
  let isFree = true;
  for (const run of occupancy.grid_rle) {
    for (let i = 0; i < run && index < free.length; i++) free[index++] = isFree ? 1 : 0;
    isFree = !isFree;
  }
  const step = occupancy.resolution_m;
  const originX = occupancy.origin[0] ?? 0;
  const originZ = occupancy.origin[1] ?? 0;
  const occupied = (x: number, z: number) => {
    const ix = Math.round((x - originX) / step);
    const iz = Math.round((z - originZ) / step);
    if (ix < 0 || iz < 0 || ix >= cols || iz >= rows) return true;
    return !free[iz * cols + ix];
  };

  return scene.design.surfaces
    .filter((s) => s.class === 'wall' && s.state === 'present' && s.polygon.length >= 2)
    .slice(0, MAX_WALL_CLEARANCES)
    .map((wall) => {
      const points = wall.polygon.map<P2>((p) => [p[0] ?? 0, p[2] ?? 0]);
      const mid: P2 = [
        points.reduce((a, p) => a + p[0], 0) / points.length,
        points.reduce((a, p) => a + p[1], 0) / points.length,
      ];
      const n = norm(wall.plane.normal as Vec3);
      let depth = 0;
      // March inward along the wall's own normal until the floor stops being free.
      for (let i = 1; i <= 240; i++) {
        const x = mid[0] + n[0] * step * i;
        const z = mid[1] + n[2] * step * i;
        if (occupied(x, z)) break;
        depth = step * i;
      }
      return { surface_id: wall.id, free_depth_m: round(depth) };
    });
}

/** Where an entity sits relative to the view: the terms the deixis score is made of. */
function describeEntity(scene: EditorState, object: ObjectLike, view: ViewState) {
  const base = baseOrigin(object);
  const height = object.dimensions[1] ?? 0;
  const centre: Vec3 = [base[0], base[1] + height / 2, base[2]];
  const toEntity: Vec3 = [
    centre[0] - view.position[0],
    centre[1] - view.position[1],
    centre[2] - view.position[2],
  ];
  const distance = Math.hypot(toEntity[0], toEntity[1], toEntity[2]) || 1e-6;
  const unit = norm(toEntity);
  const forward = norm(view.forward);
  const cosine = Math.min(1, Math.max(-1, unit[0] * forward[0] + unit[1] * forward[1] + unit[2] * forward[2]));
  const angle = (Math.acos(cosine) * 180) / Math.PI;

  // Solid angle approximated from the footprint's widest span and the object's height —
  // enough to separate "the big thing right there" from a distant thing at the same angle.
  const hull = footprint(object);
  const width = Math.max(...hull.map((p) => p[0])) - Math.min(...hull.map((p) => p[0]));
  const depth = Math.max(...hull.map((p) => p[1])) - Math.min(...hull.map((p) => p[1]));
  const span = Math.max(width, depth, 0.01);
  const apparent = (span * Math.max(height, 0.01)) / (distance * distance);
  const viewportArea = 2 * Math.tan((view.fovDeg * Math.PI) / 360) ** 2;
  return {
    distance,
    angle,
    areaFraction: Math.min(1, apparent / Math.max(viewportArea, 1e-6)),
  };
}

/**
 * The deixis score.
 *
 * Angular offset dominates, as the schema says it should: what the user is looking at
 * matters more than what is nearest or biggest. Distance and apparent size break ties
 * between things at a similar angle, and intrinsic salience carries the prior that big
 * furniture is a likelier referent than a light switch.
 */
function scoreFor(
  demonstrative: 'this' | 'that' | 'there' | 'it',
  entity: { angle: number; distance: number; areaFraction: number; salience: number; recency: number },
) {
  const centred = Math.max(0, 1 - entity.angle / 60);
  const near = Math.max(0, 1 - entity.distance / 6);
  switch (demonstrative) {
    case 'this':
      return 0.5 * centred + 0.3 * near + 0.1 * entity.areaFraction + 0.1 * entity.salience;
    case 'that':
      return 0.6 * centred + 0.1 * (1 - near) + 0.15 * entity.areaFraction + 0.15 * entity.salience;
    case 'it':
      // Anaphora: what was last talked about, with no geometry at all.
      return 0.8 * entity.recency + 0.2 * centred;
    case 'there':
      // Resolved from the floor hit, not from an entity.
      return 0.2 * centred;
  }
}

export function buildScp(
  scene: EditorState,
  view: ViewState,
  attention: AttentionState = {},
  timestamp = Date.now(),
): Scp {
  const forward = norm(view.forward);
  const objects = scene.design.objects.filter((o) => o.state === 'present');
  const stack = (attention.salienceStack ?? []).slice(0, MAX_SALIENCE);

  const described = objects
    .map((object) => {
      const geometry = describeEntity(scene, object as ObjectLike, view);
      const recencyIndex = stack.indexOf(object.id);
      return {
        id: object.id,
        class: object.refined_class ?? object.class,
        salience: object.salience,
        recency: recencyIndex < 0 ? 0 : 1 - recencyIndex / MAX_SALIENCE,
        ...geometry,
      };
    })
    // In front of the camera only; something behind you is not what "that" means.
    .filter((entity) => entity.angle <= view.fovDeg)
    .sort((a, b) => a.angle - b.angle)
    .slice(0, MAX_VISIBLE);

  const hit = raycast(scene, { origin: view.position, direction: forward });
  const floorHit = attention.lastFloorHit ?? { point: null, ageMs: 0 };

  // One demonstrative per packet is not enough — the user may say any of them — so each
  // candidate is scored for the demonstrative it fits best.
  const candidates = described
    .map((entity) => {
      const options = (['this', 'that', 'it'] as const).map((demonstrative) => ({
        demonstrative,
        score: scoreFor(demonstrative, entity),
      }));
      const best = options.reduce((a, b) => (b.score > a.score ? b : a));
      return { entity_id: entity.id, score: round(Math.min(1, Math.max(0, best.score)), 4), demonstrative: best.demonstrative };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  return {
    t: timestamp,
    camera: {
      position: view.position.map((n) => round(n)) as unknown as number[],
      forward: forward.map((n) => round(n)) as unknown as number[],
      fov_deg: round(view.fovDeg, 1),
    },
    crosshair_ray: {
      hit_entity: hit ? (hit.objectId ?? hit.surfaceId) : null,
      hit_point: hit ? (hit.position.map((n) => round(n)) as unknown as number[]) : null,
      hit_distance_m: hit
        ? round(
            Math.hypot(
              hit.position[0] - view.position[0],
              hit.position[1] - view.position[1],
              hit.position[2] - view.position[2],
            ),
          )
        : null,
      hit_type: hit ? (hit.objectId ? 'object' : hit.surfaceId.includes('floor') ? 'floor' : 'surface') : 'none',
    },
    pointing_ray: {
      screen_point: view.screenPoint ?? [0.5, 0.5],
      // Always 1 for the phone crosshair: the centre of the screen is not a guess.
      confidence: view.pointingSource === 'hand' ? round(view.pointingConfidence ?? 0, 2) : 1,
      source: view.pointingSource ?? 'phone',
    },
    last_floor_hit: {
      point: floorHit.point ? (floorHit.point.map((n) => round(n)) as unknown as number[]) : null,
      age_ms: Math.max(0, Math.round(floorHit.ageMs)),
    },
    last_tap: {
      entity: attention.lastTap?.entity ?? null,
      age_ms: Math.max(0, Math.round(attention.lastTap?.ageMs ?? 0)),
    },
    visible_entities: described.map((entity) => ({
      id: entity.id,
      class: entity.class,
      angular_offset_deg: round(entity.angle, 2),
      distance_m: round(entity.distance),
      screen_area_frac: round(entity.areaFraction, 4),
      salience: round(entity.salience, 2),
      // No depth buffer here, so occlusion is what the crosshair ray actually reached.
      occluded: hit?.objectId ? hit.objectId !== entity.id && entity.angle < 1 : false,
    })),
    salience_stack: stack,
    ranked_candidates: candidates,
    free_space_summary: {
      largest_open_rect: largestOpenRect(scene.design.occupancy),
      wall_clearances: wallClearances(scene, scene.design.occupancy),
    },
  } as Scp;
}

/** True when the client has already concluded the top two candidates are a tie. */
export function isAmbiguous(scp: Scp): boolean {
  const [first, second] = scp.ranked_candidates;
  if (!first || !second) return false;
  return first.score - second.score < AMBIGUOUS_SCORE_GAP;
}
