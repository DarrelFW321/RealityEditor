import type {
  EditorState,
  SceneObject,
  Vec3,
  Ray,
  Part,
  Bearing,
  ViolationResolved,
  RemainingNote,
  NoteSide,
} from '@reality/contracts';
import { Clearances, frontClearance, q, touchToleranceM } from './clearances';

export type P2 = [number, number];

/** Both SceneObject and its DeepReadonly form satisfy this. */
export type ObjectLike = {
  id: string;
  class: SceneObject['class'];
  dimensions: readonly number[];
  pose: { position: readonly number[]; yaw: number };
  pivot: SceneObject['pivot'];
  material_ref: string;
  state: SceneObject['state'];
  movable: boolean;
};

const GEOM_EPS = 1e-9;

/** Local -Z is forward at yaw 0, matching Swift's Yaw.forward and Three's rotation.y. */
export function forward(yaw: number): Vec3 {
  return [-Math.sin(yaw), 0, -Math.cos(yaw)];
}

/** Yaw that makes an object face along a wall's inward normal, i.e. away from the wall.
 * Negative zero is folded away: JSON round-tripping turns -0 into 0 and would
 * otherwise flip the result between -PI and PI across a copy. */
export function wallFacingYaw(normal: readonly number[]): number {
  return Math.atan2(-(normal[0] ?? 0) || 0, -(normal[2] ?? 0) || 0);
}

/** World position of the local frame origin that `parts` centres are measured from. */
export function baseOrigin(object: ObjectLike): Vec3 {
  const p = object.pose.position;
  const h = object.dimensions[1] ?? 0;
  const d = object.dimensions[2] ?? 0;
  const x = p[0] ?? 0;
  const y = p[1] ?? 0;
  const z = p[2] ?? 0;
  if (object.pivot === 'center') return [x, y - h / 2, z];
  if (object.pivot === 'base_back_center') {
    const f = forward(object.pose.yaw);
    return [x + f[0] * (d / 2), y, z + f[2] * (d / 2)];
  }
  return [x, y, z];
}

export function transform(point: Vec3, object: ObjectLike): Vec3 {
  const c = Math.cos(object.pose.yaw);
  const s = Math.sin(object.pose.yaw);
  const o = baseOrigin(object);
  return [
    o[0] + point[0] * c + point[2] * s,
    o[1] + point[1],
    o[2] - point[0] * s + point[2] * c,
  ];
}

export function parts(scene: EditorState, object: ObjectLike): Part[] {
  const existing = scene.assemblies[object.id]?.parts;
  if (existing) return existing;
  const [w, h, d] = [object.dimensions[0] ?? 0, object.dimensions[1] ?? 0, object.dimensions[2] ?? 0];
  return [
    {
      id: 'bounds',
      center: [0, h / 2, 0],
      size: [w, h, d],
      color: /^#[0-9a-f]{6}$/i.test(object.material_ref) ? object.material_ref : '#999999',
      structural: true,
    },
  ];
}

function partFootprint(object: ObjectLike, part: Part): P2[] {
  return ([
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const).map(([x, z]) => {
    const p = transform(
      [part.center[0] + (x * part.size[0]) / 2, part.center[1], part.center[2] + (z * part.size[2]) / 2],
      object,
    );
    return [p[0], p[2]] as P2;
  });
}

/** Whole-object footprint, ignoring part decomposition. */
export function footprint(object: ObjectLike): P2[] {
  const w = object.dimensions[0] ?? 0;
  const h = object.dimensions[1] ?? 0;
  const d = object.dimensions[2] ?? 0;
  return partFootprint(object, {
    id: 'bounds',
    center: [0, h / 2, 0],
    size: [w, h, d],
    color: '#999999',
    structural: true,
  });
}

function bounds2(polygon: P2[]): { lo: P2; hi: P2 } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { lo: [minX, minZ], hi: [maxX, maxZ] };
}

function apart(aLo: P2, aHi: P2, bLo: P2, bHi: P2): boolean {
  return aHi[0] < bLo[0] || bHi[0] < aLo[0] || aHi[1] < bLo[1] || bHi[1] < aLo[1];
}

/** Shallowest overlap of two CONVEX polygons, or 0 when separated.
 * A degenerate edge yields no usable axis and is skipped, never a false collision. */
export function penetration(a: P2[], b: P2[]): number {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const r = poly[(i + 1) % poly.length]!;
      const ex = r[0] - p[0];
      const ez = r[1] - p[1];
      const length = Math.hypot(ex, ez);
      if (length < GEOM_EPS) continue;
      const ax = -ez / length;
      const az = ex / length;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const v of a) {
        const d = v[0] * ax + v[1] * az;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (const v of b) {
        const d = v[0] * ax + v[1] * az;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap <= 0) return 0;
      if (overlap < best) best = overlap;
    }
  }
  return best === Infinity ? 0 : best;
}

function distanceToSegment(point: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < GEOM_EPS) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz));
}

export function distanceToBoundary(polygon: readonly number[][] | P2[], point: P2): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const d = distanceToSegment(point, [a[0]!, a[1]!], [b[0]!, b[1]!]);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

export function inside(point: P2 | readonly number[], polygon: readonly number[][]): boolean {
  const px = point[0]!;
  const pz = point[1]!;
  // On the boundary counts as inside. Measured by true distance, not by a cross
  // product, whose magnitude scales with edge length.
  if (distanceToBoundary(polygon, [px, pz]) < touchToleranceM) return true;
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a[1]! > pz !== b[1]! > pz &&
      px < ((b[0]! - a[0]!) * (pz - a[1]!)) / (b[1]! - a[1]!) + a[0]!
    )
      result = !result;
  }
  return result;
}

function signedArea(polygon: readonly number[][]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return sum / 2;
}

function clipConvex(subject: P2[], clip: P2[]): P2[] {
  let output = subject;
  const orientation = signedArea(clip) >= 0 ? 1 : -1;
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: P2) =>
      orientation * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const current = input[j]!;
      const previous = input[(j + input.length - 1) % input.length]!;
      const currentIn = side(current) >= -GEOM_EPS;
      const previousIn = side(previous) >= -GEOM_EPS;
      if (currentIn !== previousIn) {
        const t = side(previous) / (side(previous) - side(current));
        output.push([
          previous[0] + t * (current[0] - previous[0]),
          previous[1] + t * (current[1] - previous[1]),
        ]);
      }
      if (currentIn) output.push(current);
    }
  }
  return output;
}

function area(polygon: P2[]): number {
  return Math.abs(signedArea(polygon));
}

// ---------------------------------------------------------------- scene index

type Neighbour = {
  id: string;
  parts: { footprint: P2[]; minY: number; maxY: number }[];
  lo: P2;
  hi: P2;
  minY: number;
  maxY: number;
  bearing: { polygon: P2[]; y: number } | null;
  kind: SceneObject['class'];
  measured: boolean;
};

type DoorRegion = { id: string; polygon: P2[]; lo: P2; hi: P2; swingKnown: boolean };

type WallInfo = {
  id: string;
  normal: Vec3;
  offset: number;
  u: Vec3;
  polygonUV: P2[];
  openings: { id: string; cls: string; lo: P2; hi: P2 }[];
};

export type SceneIndex = {
  floor: P2[];
  ceiling: number;
  neighbours: Neighbour[];
  doors: DoorRegion[];
  walls: WallInfo[];
  windows: { id: string; sill: number; centre: Vec3; normal: Vec3; offset: number }[];
  floorSurfaceIds: string[];
  excludeId: string;
};

function normalise3(v: readonly number[]): Vec3 {
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  if (length < GEOM_EPS) return [0, 0, 1];
  return [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length];
}

function centroid3(polygon: readonly number[][]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of polygon) {
    x += p[0]!;
    y += p[1]!;
    z += p[2]!;
  }
  const n = Math.max(1, polygon.length);
  return [x / n, y / n, z / n];
}

function worldBearing(
  scene: EditorState,
  object: ObjectLike,
  bearing: Bearing | null,
): { polygon: P2[]; y: number } | null {
  if (!bearing) return null;
  const polygon = bearing.polygon.map((p) => {
    const w = transform([p[0], bearing.y, p[1]], object);
    return [w[0], w[2]] as P2;
  });
  return { polygon, y: baseOrigin(object)[1] + bearing.y };
}

function neighbourOf(scene: EditorState, object: ObjectLike, measured: boolean): Neighbour {
  const base = baseOrigin(object)[1];
  const list = parts(scene, object).map((part) => ({
    footprint: partFootprint(object, part),
    minY: base + part.center[1] - part.size[1] / 2,
    maxY: base + part.center[1] + part.size[1] / 2,
  }));
  const all = list.flatMap((p) => p.footprint);
  const { lo, hi } = bounds2(all);
  return {
    id: object.id,
    parts: list,
    lo,
    hi,
    minY: Math.min(...list.map((p) => p.minY)),
    maxY: Math.max(...list.map((p) => p.maxY)),
    bearing: worldBearing(scene, object, scene.assemblies[object.id]?.support?.bearing ?? null),
    kind: object.class,
    measured,
  };
}

/** Rotate a horizontal vector about +Y, matching `transform`. */
function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** Quarter-turn door sweep. Convex, so SAT stays valid. Port of Surface.swingArcPolygon. */
export function swingArcPolygon(
  polygon: readonly number[][],
  swing: { hinge: 'left' | 'right'; direction: 'inward' | 'outward' | 'sliding'; arc_radius: number },
  inwardNormal: Vec3,
): P2[] {
  if (swing.direction === 'sliding') return [];
  const sorted = [...polygon].sort(
    (a, b) => a[1]! - b[1]! || a[0]! - b[0]! || a[2]! - b[2]!,
  );
  const first = sorted[0];
  const second = sorted[1];
  if (!first || !second) return [];
  const c0: P2 = [first[0]!, first[2]!];
  const c1: P2 = [second[0]!, second[2]!];
  const width = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  if (width < GEOM_EPS) return [];
  // "Left" seen from inside the room facing the door.
  const left: Vec3 = [-inwardNormal[2], 0, inwardNormal[0]];
  const t0 = c0[0] * left[0] + c0[1] * left[2];
  const t1 = c1[0] * left[0] + c1[1] * left[2];
  const hingeIsC0 = swing.hinge === 'left' ? t0 >= t1 : t0 < t1;
  const hinge = hingeIsC0 ? c0 : c1;
  const free = hingeIsC0 ? c1 : c0;
  const radius = swing.arc_radius > GEOM_EPS ? swing.arc_radius : width;
  const start: Vec3 = [
    ((free[0] - hinge[0]) / width) * radius,
    0,
    ((free[1] - hinge[1]) / width) * radius,
  ];
  const target: Vec3 =
    swing.direction === 'inward'
      ? inwardNormal
      : [-inwardNormal[0], -inwardNormal[1], -inwardNormal[2]];
  const positive = rotateY(start, Math.PI / 2);
  const negative = rotateY(start, -Math.PI / 2);
  const sign =
    positive[0] * target[0] + positive[2] * target[2] >=
    negative[0] * target[0] + negative[2] * target[2]
      ? 1
      : -1;
  const out: P2[] = [hinge];
  for (let i = 0; i <= 8; i++) {
    const v = rotateY(start, (sign * (Math.PI / 2) * i) / 8);
    out.push([hinge[0] + v[0], hinge[1] + v[2]]);
  }
  return out;
}

/** Conservative floor region in front of a door whose swing is unknown. */
function doorProxyPolygon(polygon: readonly number[][], inwardNormal: Vec3, depth: number): P2[] {
  const xs = polygon.map((p) => p[0]!);
  const zs = polygon.map((p) => p[2]!);
  const a: P2 = [Math.min(...xs), Math.min(...zs)];
  const b: P2 = [Math.max(...xs), Math.max(...zs)];
  const n: P2 = [inwardNormal[0] * depth, inwardNormal[2] * depth];
  return [a, b, [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]];
}

export function buildIndex(scene: EditorState, excludeId: string): SceneIndex {
  const raw = scene.design.bounds.floor_polygon.map((p) => [p[0]!, p[1]!] as P2);
  // Normalise winding once. The measured path and the convex-hull fallback in
  // roomToSession disagree, and the nudge search derives inward directions from this.
  const floor = signedArea(raw) < 0 ? [...raw].reverse() : raw;
  const ceiling = scene.design.bounds.ceiling_height;
  const floorCentre = floor.reduce<P2>((acc, p) => [acc[0] + p[0] / floor.length, acc[1] + p[1] / floor.length], [0, 0]);

  const present = scene.design.surfaces.filter((s) => s.state === 'present');
  const walls: WallInfo[] = [];
  for (const surface of present) {
    if (surface.class !== 'wall') continue;
    const flat = normalise3([surface.plane.normal[0] ?? 0, 0, surface.plane.normal[2] ?? 0]);
    const centre = centroid3(surface.polygon);
    let normal = flat;
    // Do not trust the stored direction: RoomPlan gives a raw matrix column.
    const probe: P2 = [centre[0] + normal[0] * 0.1, centre[2] + normal[2] * 0.1];
    if (!inside(probe, floor)) normal = [-normal[0], -normal[1], -normal[2]];
    const offset = normal[0] * centre[0] + normal[1] * centre[1] + normal[2] * centre[2];
    const u: Vec3 = [-normal[2], 0, normal[0]];
    const polygonUV = surface.polygon.map(
      (p) => [p[0]! * u[0] + p[2]! * u[2], p[1]!] as P2,
    );
    walls.push({ id: surface.id, normal, offset, u, polygonUV, openings: [] });
  }

  const wallFor = (surface: { parent?: string | null; polygon: readonly number[][] }) => {
    if (surface.parent) {
      const named = walls.find((w) => w.id === surface.parent);
      if (named) return named;
    }
    const centre = centroid3(surface.polygon);
    let best: WallInfo | undefined;
    let bestDistance = Infinity;
    for (const wall of walls) {
      const d = Math.abs(
        wall.normal[0] * centre[0] + wall.normal[1] * centre[1] + wall.normal[2] * centre[2] - wall.offset,
      );
      if (d < bestDistance - 1e-12) {
        bestDistance = d;
        best = wall;
      }
    }
    return best;
  };

  const doors: DoorRegion[] = [];
  const windows: SceneIndex['windows'] = [];
  for (const surface of present) {
    if (!['window', 'door', 'opening'].includes(surface.class)) continue;
    const wall = wallFor(surface);
    if (!wall) continue;
    const uv = surface.polygon.map((p) => [p[0]! * wall.u[0] + p[2]! * wall.u[2], p[1]!] as P2);
    const box = bounds2(uv);
    wall.openings.push({ id: surface.id, cls: surface.class, lo: box.lo, hi: box.hi });
    if (surface.class === 'window') {
      windows.push({
        id: surface.id,
        sill: Math.min(...surface.polygon.map((p) => p[1]!)),
        centre: centroid3(surface.polygon),
        normal: wall.normal,
        offset: wall.offset,
      });
      continue;
    }
    if (surface.class !== 'door') continue;
    const swing = surface.swing ?? null;
    const arc = swing ? swingArcPolygon(surface.polygon, swing, wall.normal) : [];
    const polygon = arc.length >= 3 ? arc : doorProxyPolygon(surface.polygon, wall.normal, 0.8);
    if (polygon.length < 3) continue;
    const box2 = bounds2(polygon);
    doors.push({ id: surface.id, polygon, lo: box2.lo, hi: box2.hi, swingKnown: arc.length >= 3 });
  }

  const neighbours: Neighbour[] = [];
  for (const object of scene.design.objects)
    if (object.id !== excludeId && object.state === 'present')
      neighbours.push(neighbourOf(scene, object, false));
  for (const object of scene.measured.objects)
    if (
      object.id !== excludeId &&
      object.state === 'present' &&
      !scene.removedPhysicalIds.includes(object.id) &&
      !scene.design.objects.some((o) => o.id === object.id)
    )
      neighbours.push(neighbourOf(scene, object as ObjectLike, true));

  return {
    floor,
    ceiling,
    neighbours,
    doors,
    walls,
    windows,
    floorSurfaceIds: present.filter((s) => s.class === 'floor').map((s) => s.id),
    excludeId,
  };
}

// ---------------------------------------------------------------- evaluation

export type PlacementAspect =
  | 'bounds'
  | 'intersection'
  | 'doors'
  | 'support'
  | 'mount'
  | 'construction';

export type PlacementFinding = {
  violations: ViolationResolved[];
  notes: RemainingNote[];
  caveats: string[];
};

export type EvaluateOptions = {
  index?: SceneIndex;
  /** The declared support. Exempt from intersection and from the floor-contact rule. */
  supportId?: string;
  aspects?: readonly PlacementAspect[];
  stopAtFirst?: boolean;
  skipNotes?: boolean;
  /** Carrying and settling tolerate being off a support; committing does not. */
  allowAboveSupport?: boolean;
};

const ALL_ASPECTS: readonly PlacementAspect[] = [
  'bounds',
  'intersection',
  'doors',
  'support',
  'mount',
  'construction',
];

function subjectParts(scene: EditorState, object: ObjectLike) {
  const base = baseOrigin(object)[1];
  return parts(scene, object).map((part) => ({
    footprint: partFootprint(object, part),
    minY: base + part.center[1] - part.size[1] / 2,
    maxY: base + part.center[1] + part.size[1] / 2,
  }));
}

export function evaluatePlacement(
  scene: EditorState,
  object: ObjectLike,
  options: EvaluateOptions = {},
): PlacementFinding {
  const aspects = options.aspects ?? ALL_ASPECTS;
  const violations: ViolationResolved[] = [];
  const caveats: string[] = [];
  const w = object.dimensions[0] ?? 0;
  const h = object.dimensions[1] ?? 0;
  const d = object.dimensions[2] ?? 0;
  const finite = [w, h, d, ...object.pose.position, object.pose.yaw].every(Number.isFinite);
  if (!finite || Math.min(w, h, d) <= 0)
    return {
      violations: [{ type: 'out_of_bounds', with: '', overlap_m: 0 }],
      notes: [],
      caveats: ['Invalid dimensions or pose'],
    };

  const index = options.index ?? buildIndex(scene, object.id);
  const assembly = scene.assemblies[object.id];
  const support = assembly?.support;
  const mine = subjectParts(scene, object);
  const hull = footprint(object);
  const hullBox = bounds2(hull);
  const minY = Math.min(...mine.map((p) => p.minY));
  const maxY = Math.max(...mine.map((p) => p.maxY));
  const stop = () => options.stopAtFirst === true && violations.length > 0;

  if (aspects.includes('construction') && assembly) {
    if (assembly.construction === 'unknown')
      caveats.push('Outside this template’s verified envelope; construction is not verified.');
    for (const assumption of assembly.assumptions) caveats.push(assumption);
  }

  if (aspects.includes('bounds')) {
    let worst = 0;
    for (const corner of hull)
      if (!inside(corner, index.floor))
        worst = Math.max(worst, distanceToBoundary(index.floor, corner));
    if (minY < -Clearances.wallContactEpsilon) worst = Math.max(worst, -minY);
    if (maxY > index.ceiling + Clearances.wallContactEpsilon)
      worst = Math.max(worst, maxY - index.ceiling);
    // One entry, not three: a rejection narrates the worst thing wrong with a pose.
    if (q(worst) > touchToleranceM)
      violations.push({ type: 'out_of_bounds', with: '', overlap_m: q(worst) });
  }

  if (aspects.includes('intersection') && !stop()) {
    for (const other of index.neighbours) {
      // One index serves many objects, so the subject can be in its own neighbour list.
      if (other.id === object.id || other.id === options.supportId) continue;
      if (apart(hullBox.lo, hullBox.hi, other.lo, other.hi)) continue;
      let deepest = 0;
      for (const a of mine)
        for (const b of other.parts) {
          const shared = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
          if (shared <= Clearances.wallContactEpsilon) continue;
          const depth = penetration(a.footprint, b.footprint);
          if (depth > deepest) deepest = depth;
        }
      if (q(deepest) > touchToleranceM) {
        violations.push({ type: 'intersection', with: other.id, overlap_m: q(deepest) });
        if (stop()) break;
      }
    }
  }

  if (aspects.includes('doors') && !stop()) {
    for (const door of index.doors) {
      if (apart(hullBox.lo, hullBox.hi, door.lo, door.hi)) continue;
      if (minY > index.ceiling) continue;
      const depth = penetration(hull, door.polygon);
      if (q(depth) > touchToleranceM) {
        violations.push({ type: 'blocks_door_swing', with: door.id, overlap_m: q(depth) });
        if (!door.swingKnown)
          caveats.push(
            `The swing of ${door.id} was not measured; a conservative clearance was used.`,
          );
        if (stop()) break;
      }
    }
  }

  if (aspects.includes('support') && !stop() && support?.mode !== 'wall') {
    const violation = evaluateSupport(index, object, support ?? null, mine, hull, minY, options);
    if (violation) violations.push(violation);
  }

  if (aspects.includes('mount') && !stop() && support?.mode === 'wall') {
    for (const violation of evaluateMount(index, object, support, hull, minY, maxY))
      violations.push(violation);
  }

  const notes =
    options.skipNotes || violations.length ? [] : softNotes(scene, index, object, maxY);

  violations.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.with < b.with ? -1 : a.with > b.with ? 1 : 0));
  return { violations, notes, caveats: [...new Set(caveats)] };
}

function evaluateSupport(
  index: SceneIndex,
  object: ObjectLike,
  support: { mode: string; surfaceId: string } | null,
  mine: { footprint: P2[]; minY: number; maxY: number }[],
  hull: P2[],
  minY: number,
  options: EvaluateOptions,
): ViolationResolved | null {
  if (options.allowAboveSupport) return null;
  const centre = baseOrigin(object);
  const centreXZ: P2 = [centre[0], centre[2]];

  if (support?.mode === 'object') {
    const supporter = index.neighbours.find(
      (n) => n.id === support.surfaceId && n.id !== object.id,
    );
    if (!supporter?.bearing)
      return { type: 'unsupported', with: support.surfaceId, overlap_m: 0 };
    const gap = q(Math.abs(minY - supporter.bearing.y));
    if (gap > Clearances.wallContactEpsilon)
      return { type: 'floating', with: supporter.id, overlap_m: gap };
    const centred = inside(centreXZ, supporter.bearing.polygon);
    const covered = area(clipConvex(hull, supporter.bearing.polygon));
    const total = area(hull);
    // Swift tests the centre only, which passes an object hanging 90% off.
    if (!centred || total <= 0 || covered / total < 0.6)
      return {
        type: 'unsupported',
        with: supporter.id,
        overlap_m: q(distanceToBoundary(supporter.bearing.polygon, centreXZ)),
      };
    return null;
  }

  if (q(minY) > Clearances.wallContactEpsilon)
    return { type: 'floating', with: '', overlap_m: q(minY) };
  return null;
}

function evaluateMount(
  index: SceneIndex,
  object: ObjectLike,
  support: { surfaceId: string; mountHeight: number | null },
  hull: P2[],
  minY: number,
  maxY: number,
): ViolationResolved[] {
  const out: ViolationResolved[] = [];
  const wall = index.walls.find((candidate) => candidate.id === support.surfaceId);
  if (!wall) return [{ type: 'unsupported', with: support.surfaceId, overlap_m: 0 }];

  // Exact at any yaw: the largest projection of a footprint corner onto the normal.
  const centre = baseOrigin(object);
  let reach = 0;
  for (const corner of hull)
    reach = Math.max(
      reach,
      Math.abs((corner[0] - centre[0]) * wall.normal[0] + (corner[1] - centre[2]) * wall.normal[2]),
    );
  const distance =
    wall.normal[0] * centre[0] + wall.normal[1] * centre[1] + wall.normal[2] * centre[2] - wall.offset;
  const gap = q(Math.abs(distance - reach));
  if (gap > 0.02) out.push({ type: 'unsupported', with: wall.id, overlap_m: gap });

  const cornersUV = hull.map(
    (corner) => [corner[0] * wall.u[0] + corner[1] * wall.u[2], 0] as P2,
  );
  const spanLo = Math.min(...cornersUV.map((c) => c[0]));
  const spanHi = Math.max(...cornersUV.map((c) => c[0]));
  const wallLo = Math.min(...wall.polygonUV.map((p) => p[0]));
  const wallHi = Math.max(...wall.polygonUV.map((p) => p[0]));
  const overhang = Math.max(wallLo - spanLo, spanHi - wallHi, 0);
  if (q(overhang) > touchToleranceM)
    out.push({ type: 'out_of_bounds', with: wall.id, overlap_m: q(overhang) });
  if (minY <= Clearances.wallContactEpsilon)
    out.push({ type: 'floating', with: wall.id, overlap_m: 0 });
  if (maxY > index.ceiling + Clearances.wallContactEpsilon)
    out.push({ type: 'out_of_bounds', with: '', overlap_m: q(maxY - index.ceiling) });

  for (const opening of wall.openings) {
    const overlapU = Math.min(spanHi, opening.hi[0]) - Math.max(spanLo, opening.lo[0]);
    const overlapV = Math.min(maxY, opening.hi[1]) - Math.max(minY, opening.lo[1]);
    if (overlapU > touchToleranceM && overlapV > touchToleranceM)
      out.push({
        type: opening.cls === 'door' ? 'blocks_door_swing' : 'blocks_window',
        with: opening.id,
        overlap_m: q(Math.min(overlapU, overlapV)),
      });
  }
  return out;
}

// ---------------------------------------------------------------- soft notes

/** Clear distance from the object's face to the first thing in the way. Shortfalls only. */
function freeDistance(index: SceneIndex, object: ObjectLike, direction: Vec3, hull: P2[]): number {
  const length = Math.hypot(direction[0], direction[2]);
  if (length < GEOM_EPS) return Infinity;
  const dir: P2 = [direction[0] / length, direction[2] / length];
  const centre = baseOrigin(object);
  const origin: P2 = [centre[0], centre[2]];
  const base = centre[1];
  const height = object.dimensions[1] ?? 0;
  let own = 0;
  for (const corner of hull)
    own = Math.max(own, (corner[0] - origin[0]) * dir[0] + (corner[1] - origin[1]) * dir[1]);

  let best = Infinity;
  for (const other of index.neighbours) {
    if (other.id === object.id) continue;
    const shared = Math.min(base + height, other.maxY) - Math.max(base, other.minY);
    if (shared <= Clearances.wallContactEpsilon) continue;
    for (const part of other.parts) {
      const t = rayPolygonEntry(origin, dir, part.footprint);
      if (t !== null && t < best) best = t;
    }
  }
  for (const wall of index.walls) {
    const den = wall.normal[0] * dir[0] + wall.normal[2] * dir[1];
    if (den > -GEOM_EPS) continue;
    const t = (wall.offset - (wall.normal[0] * origin[0] + wall.normal[2] * origin[1])) / den;
    if (t > 0 && t < best) best = t;
  }
  if (!Number.isFinite(best)) return Infinity;
  return Math.max(0, q(best - own));
}

function rayPolygonEntry(origin: P2, dir: P2, polygon: P2[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < GEOM_EPS) continue;
    const t = ((a[0] - origin[0]) * ez - (a[1] - origin[1]) * ex) / den;
    const s = ((a[0] - origin[0]) * dir[1] - (a[1] - origin[1]) * dir[0]) / -den;
    if (t > 0 && s >= 0 && s <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

function softNotes(
  scene: EditorState,
  index: SceneIndex,
  object: ObjectLike,
  maxY: number,
): RemainingNote[] {
  const out: RemainingNote[] = [];
  const hull = footprint(object);
  const yaw = object.pose.yaw;
  const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const left: Vec3 = [-right[0], 0, -right[2]];

  if (object.class === 'bed') {
    // One long side is enough to get into a bed. Demanding both refuses every
    // small bedroom, which is exactly what Clearances.bedside warns about.
    const leftGap = freeDistance(index, object, left, hull);
    const rightGap = freeDistance(index, object, right, hull);
    const best = Math.max(leftGap, rightGap);
    if (best < Clearances.bedside)
      out.push({
        type: 'circulation',
        side: leftGap >= rightGap ? 'left' : 'right',
        value_m: q(best),
        recommended_m: Clearances.bedside,
      });
  } else {
    const recommended = frontClearance(object.class);
    const front = freeDistance(index, object, forward(yaw), hull);
    if (front < recommended)
      out.push({ type: 'clearance', side: 'front', value_m: q(front), recommended_m: recommended });
    const sides: [Vec3, NoteSide][] = [
      [left, 'left'],
      [right, 'right'],
    ];
    for (const [direction, side] of sides) {
      const gap = freeDistance(index, object, direction, hull);
      // Flush against a wall is a choice, not a squeeze.
      if (gap <= Clearances.wallContactEpsilon || gap >= Clearances.secondaryWalkway) continue;
      out.push({
        type: 'circulation',
        side,
        value_m: q(gap),
        recommended_m: Clearances.secondaryWalkway,
      });
    }
  }

  const centre = baseOrigin(object);
  for (const window of index.windows) {
    const distance = Math.abs(
      window.normal[0] * centre[0] + window.normal[2] * centre[2] - window.offset,
    );
    if (distance > Clearances.adjacencyThreshold) continue;
    const alongU = -window.normal[2] * centre[0] + window.normal[0] * centre[2];
    const windowU = -window.normal[2] * window.centre[0] + window.normal[0] * window.centre[2];
    if (Math.abs(alongU - windowU) > (object.dimensions[0] ?? 0) / 2 + Clearances.adjacencyThreshold)
      continue;
    const headroom = q(window.sill - maxY);
    if (headroom < Clearances.windowSillClearance)
      out.push({
        type: 'sightline',
        side: 'above',
        value_m: Math.max(0, headroom),
        recommended_m: Clearances.windowSillClearance,
      });
  }

  if (object.class === 'table') {
    let nearest = Infinity;
    for (const other of index.neighbours) {
      if (other.kind !== 'sofa' && other.kind !== 'chair') continue;
      const gap = Math.hypot(centre[0] - (other.lo[0] + other.hi[0]) / 2, centre[2] - (other.lo[1] + other.hi[1]) / 2);
      if (gap < nearest) nearest = gap;
    }
    const lower = Clearances.coffeeTableToSeating[0];
    if (nearest < lower)
      out.push({ type: 'reach', side: 'front', value_m: q(nearest), recommended_m: lower });
  }

  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- sweep

/** One query for a whole vertical drop, replacing a per-substep placement evaluation. */
export function sweepDown(
  scene: EditorState,
  object: ObjectLike,
  fromY: number,
  toY: number,
  index: SceneIndex,
  supportId?: string,
): { blockedBy: string } | null {
  const height = object.dimensions[1] ?? 0;
  const hull = footprint(object);
  const box = bounds2(hull);
  const low = Math.min(fromY, toY);
  const high = Math.max(fromY, toY) + height;
  for (const other of index.neighbours) {
    if (other.id === object.id || other.id === supportId) continue;
    if (apart(box.lo, box.hi, other.lo, other.hi)) continue;
    const shared = Math.min(high, other.maxY) - Math.max(low, other.minY);
    if (shared <= Clearances.wallContactEpsilon) continue;
    for (const part of other.parts)
      if (penetration(hull, part.footprint) > touchToleranceM) return { blockedBy: other.id };
  }
  return null;
}

// ---------------------------------------------------------------- legacy shim

/** @deprecated Use evaluatePlacement. Retained so existing call sites keep compiling. */
export function validatePlacement(
  scene: EditorState,
  object: ObjectLike,
  allowAboveSupport = false,
): string[] {
  const finding = evaluatePlacement(scene, object, { allowAboveSupport, skipNotes: true });
  return finding.violations.map((v) => describeViolation(v));
}

export function describeViolation(violation: ViolationResolved): string {
  const centimetres = Math.round(violation.overlap_m * 100);
  switch (violation.type) {
    case 'intersection':
      return `Overlaps ${violation.with} by ${centimetres}cm`;
    case 'out_of_bounds':
      return violation.with ? `Extends past ${violation.with}` : 'Outside the calibrated room';
    case 'floating':
      return violation.with
        ? `Not resting on ${violation.with}`
        : `Floating ${centimetres}cm off the floor`;
    case 'blocks_door_swing':
      return `Blocks ${violation.with}`;
    case 'blocks_window':
      return `Covers ${violation.with}`;
    case 'unsupported':
      return violation.with ? `Unsupported on ${violation.with}` : 'Unsupported';
    default:
      return 'In the way';
  }
}

// ---------------------------------------------------------------- raycast

export type RayHit = {
  objectId: string | null;
  surfaceId: string;
  position: Vec3;
  kind: 'surface' | 'object';
};

export function raycast(scene: EditorState, ray: Ray): RayHit | null {
  let best = Infinity;
  let hit: RayHit | null = null;
  for (const object of scene.design.objects) {
    if (object.state !== 'present') continue;
    for (const part of parts(scene, object)) {
      const c = Math.cos(-object.pose.yaw);
      const s = Math.sin(-object.pose.yaw);
      const p = baseOrigin(object);
      const ox = ray.origin[0] - p[0];
      const oz = ray.origin[2] - p[2];
      const origin: Vec3 = [ox * c + oz * s, ray.origin[1] - p[1], -ox * s + oz * c];
      const direction: Vec3 = [
        ray.direction[0] * c + ray.direction[2] * s,
        ray.direction[1],
        -ray.direction[0] * s + ray.direction[2] * c,
      ];
      let near = 0;
      let far = Infinity;
      for (let i = 0; i < 3; i++) {
        const lo = part.center[i]! - part.size[i]! / 2;
        const hi = part.center[i]! + part.size[i]! / 2;
        if (Math.abs(direction[i]!) < 1e-8) {
          if (origin[i]! < lo || origin[i]! > hi) far = -1;
        } else {
          const a = (lo - origin[i]!) / direction[i]!;
          const b = (hi - origin[i]!) / direction[i]!;
          near = Math.max(near, Math.min(a, b));
          far = Math.min(far, Math.max(a, b));
        }
      }
      if (far >= near && near < best - 1e-12) {
        best = near;
        hit = {
          objectId: object.id,
          surfaceId: object.id,
          kind: 'object',
          position: ray.origin.map((v, i) => v + near * ray.direction[i]!) as Vec3,
        };
      }
    }
  }

  if (Math.abs(ray.direction[1]) > 1e-8) {
    const t = -ray.origin[1] / ray.direction[1];
    const p = ray.origin.map((v, i) => v + t * ray.direction[i]!) as Vec3;
    if (t > 0 && t < best - 1e-12 && inside([p[0], p[2]], scene.design.bounds.floor_polygon)) {
      const floors = scene.design.surfaces.filter(
        (s) => s.class === 'floor' && s.state === 'present',
      );
      // Several floor patches are normal in a furnished scan. Prefer the one the
      // hit actually lands in, so settling uses the right plane.
      const containing = floors.find(
        (s) => s.polygon.length >= 3 && inside([p[0], p[2]], s.polygon.map((v) => [v[0]!, v[2]!])),
      );
      best = t;
      hit = {
        objectId: null,
        surfaceId: (containing ?? floors[0])?.id ?? '',
        kind: 'surface',
        position: p,
      };
    }
  }

  for (const wall of scene.design.surfaces) {
    if (wall.class !== 'wall' || wall.state !== 'present') continue;
    const n = wall.plane.normal;
    const den = n.reduce((a, v, i) => a + v! * ray.direction[i]!, 0);
    if (Math.abs(den) < 1e-8) continue;
    // Reject hits on the back face; a ray leaving the room is not pointing at a wall.
    if (den > 0) continue;
    const t = (wall.plane.offset - n.reduce((a, v, i) => a + v! * ray.origin[i]!, 0)) / den;
    if (t <= 0 || t >= best - 1e-12) continue;
    const p = ray.origin.map((v, i) => v + t * ray.direction[i]!) as Vec3;
    if (
      [0, 1, 2].every(
        (i) =>
          p[i]! >= Math.min(...wall.polygon.map((v) => v[i]!)) - touchToleranceM &&
          p[i]! <= Math.max(...wall.polygon.map((v) => v[i]!)) + touchToleranceM,
      )
    ) {
      best = t;
      hit = { objectId: null, surfaceId: wall.id, kind: 'surface', position: p };
    }
  }
  return hit;
}
