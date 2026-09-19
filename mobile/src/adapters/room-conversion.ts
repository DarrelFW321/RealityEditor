/**
 * Pure RoomPlan-to-scene conversion.
 *
 * Split out of `roomplan.tsx` because that file imports `react-native` and
 * `expo-modules-core` for the native view, which makes it unloadable outside a Metro
 * bundle. The M4 gate replays recorded captures through `roomToSession` with `npx tsx`,
 * so the conversion has to be reachable without React Native present. `roomplan.tsx`
 * re-exports everything here, so callers are unaffected.
 */
import { z } from 'zod';
import {
  KeyframeSchema,
  RsgSchema,
  SceneObjectClassSchema,
  type EditorState,
  type Keyframe,
  type Rsg,
  type Vec3,
} from '@reality/contracts';
import { evaluateCoverage, type CoverageMask, type CoverageReport } from '@reality/spatial-engine';

export type TrackedFrame = {
  timestamp: number;
  frameId: string;
  tracking: 'normal' | 'limited' | 'lost';
  trackingReason: string;
  sequence: number;
  fps: number;
  viewportWidth: number;
  viewportHeight: number;
  orientation: string;
  worldMapping: 'not_available' | 'limited' | 'extending' | 'mapped' | 'unknown';
  thermalState: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  memoryWarnings: number;
  receivedAt?: number;
  cameraToWorld: number[];
  projection: number[];
  /** ARKit's current transform for the anchor pinned at the room origin, column-major.
   * Absent until the anchor exists; see `roomFromWorld`. */
  roomAnchor?: number[];
  hand?: {
    visible: boolean;
    x?: number;
    y?: number;
    rawX?: number;
    rawY?: number;
    pinching: boolean;
    confidence: number;
    /** Vision returned a hand this sample, before any gate. */
    detected?: boolean;
    /** The fingertip landed inside the viewport. False means the transform put it
     * off-screen, which is the failure the confidence number cannot show. */
    inView?: boolean;
    /** Detection confidence before the in-view gate zeroes it. */
    rawConfidence?: number;
    /** Fingertip after `displayTransform`, reported even when out of view. */
    displayX?: number;
    displayY?: number;
    pinchRatio: number;
    processed: number;
    dropped: number;
    latencyMs: number;
  };
};

/**
 * Splits a native keyframe event into validated metadata plus its JPEG.
 *
 * `KeyframeSchema` is `.strict()`, so `jpegBase64` has to be separated before
 * parsing — the upload contract carries them as two fields
 * (`packages/adapters/src/reconstruction.ts`), not one object.
 *
 * Returns null rather than throwing: one malformed frame should cost one
 * reference, not the whole sweep.
 */
export function parseKeyframe(
  event: Keyframe & { jpegBase64: string },
): { metadata: Keyframe; jpegBase64: string } | null {
  const { jpegBase64, ...metadata } = event;
  const parsed = KeyframeSchema.safeParse(metadata);
  if (!parsed.success || typeof jpegBase64 !== 'string' || jpegBase64.length === 0) return null;
  return { metadata: parsed.data, jpegBase64 };
}

export type SpatialGateReport = {
  ready: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
};

export function evaluateSpatialFrame(
  frame: TrackedFrame | null,
  expectedViewport: { width: number; height: number } | null,
  now = Date.now(),
): SpatialGateReport {
  if (!frame) {
    return {
      ready: false,
      checks: [{ name: 'tracked frame', ok: false, detail: 'No native AR frame received.' }],
    };
  }
  const finite = (values: number[], count: number) =>
    values.length === count && values.every(Number.isFinite);
  const age = now - (frame.receivedAt ?? now);
  const viewportMatches =
    !expectedViewport ||
    (Math.abs(frame.viewportWidth - expectedViewport.width) <= 2 &&
      Math.abs(frame.viewportHeight - expectedViewport.height) <= 2);
  const checks = [
    {
      name: 'tracking',
      ok: frame.tracking === 'normal',
      detail: `${frame.tracking} (${frame.trackingReason})`,
    },
    {
      name: 'camera transform',
      ok: finite(frame.cameraToWorld, 16),
      detail: finite(frame.cameraToWorld, 16) ? '16 finite values' : 'invalid matrix',
    },
    {
      name: 'projection',
      ok: finite(frame.projection, 16) && Math.abs(frame.projection[0] ?? 0) > 0.01,
      detail: finite(frame.projection, 16) ? 'finite AR projection' : 'invalid matrix',
    },
    {
      name: 'viewport',
      ok: viewportMatches,
      detail: `${frame.viewportWidth}×${frame.viewportHeight} ${frame.orientation}`,
    },
    {
      name: 'freshness',
      ok: age <= 750,
      detail: `${Math.max(0, age)} ms since delivery`,
    },
    {
      name: 'frame cadence',
      ok: frame.fps >= 12,
      detail: `${frame.fps.toFixed(1)} fps native sample cadence`,
    },
  ];
  return { ready: checks.every((check) => check.ok), checks };
}
const NativeRoom = z.object({
  id: z.string(),
  surfaces: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['wall', 'floor', 'window', 'door', 'opening']),
      polygon: z.array(z.array(z.number()).length(3)),
      transform: z.array(z.number()).length(16),
      confidence: z.string(),
    }),
  ),
  objects: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      transform: z.array(z.number()).length(16),
      dimensions: z.array(z.number()).length(3),
    }),
  ),
});

type Point2 = [number, number];

function signedArea(polygon: Point2[]): number {
  return (
    polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length]!;
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2
  );
}

function convexHull(points: Point2[]): Point2[] {
  const unique = Array.from(
    new Map(points.map((point) => [`${point[0].toFixed(3)}:${point[1].toFixed(3)}`, point])).values(),
  ).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length < 3) return [];
  const cross = (origin: Point2, a: Point2, b: Point2) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0]);
  const half = (input: Point2[]) => {
    const result: Point2[] = [];
    for (const point of input) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(unique);
  const upper = half([...unique].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** RoomPlan reports its own confidence per surface as `.high`, `.medium` or `.low`. Only a
 * low reading is demoted on its own: medium is RoomPlan's ordinary answer for a wall seen
 * once at an angle, and treating that as unmeasured would mark most of a real room inferred. */
const lowConfidence = (value: string) => value.toLowerCase().includes('low');

export function roomToSession(
  json: string,
  frameId: string,
  mask?: CoverageMask,
  /** Which capture this is within the app session. Was hardcoded 0 at every producer, so
   * the server's staleness check had nothing to compare and could never fire. */
  calibrationRevision = 0,
): { scene: EditorState; origin: Vec3; coverage: CoverageReport | null } {
  const data = NativeRoom.parse(JSON.parse(json));
  const walls = data.surfaces.filter((s) => s.kind === 'wall' && s.polygon.length >= 2);
  if (walls.length < 3) throw new Error('Show more room boundaries before editing.');
  const floors = data.surfaces.filter((s) => s.kind === 'floor' && s.polygon.length >= 3);
  const polygonArea = (surface: (typeof floors)[number]) =>
    Math.abs(signedArea(surface.polygon.map((point) => [point[0]!, point[2]!])));
  // A furnished room may be split into several floor surfaces. Use the largest
  // connected segment for M1 instead of trapping the user in measurement.
  const floor = [...floors].sort((a, b) => polygonArea(b) - polygonArea(a))[0];
  let offset: number;
  let polygon: Point2[];
  if (floor) {
    offset = floor.polygon.reduce((sum, point) => sum + point[1]!, 0) / floor.polygon.length;
    if (floor.polygon.some((point) => Math.abs(point[1]! - offset) > 0.04))
      throw new Error('A level floor is required for the current placement adapter.');
    polygon = floor.polygon.map((point) => [point[0]!, point[2]!]);
  } else {
    // Furniture often hides the floor from RoomPlan. The wall bases are still
    // metric observations, so use their median height and outer boundary rather
    // than forcing the user through another scan that may fail the same way.
    const wallBases = walls
      .map((wall) => Math.min(...wall.polygon.map((point) => point[1]!)))
      .sort((a, b) => a - b);
    offset = wallBases[Math.floor(wallBases.length / 2)]!;
    const basePoints = walls.flatMap((wall) => {
      const base = Math.min(...wall.polygon.map((point) => point[1]!));
      return wall.polygon
        .filter((point) => point[1]! <= base + 0.08)
        .map<Point2>((point) => [point[0]!, point[2]!]);
    });
    polygon = convexHull(basePoints);
    if (polygon.length < 3 || Math.abs(signedArea(polygon)) < 0.25)
      throw new Error('Not enough connected wall boundaries to infer the floor. Complete the room sweep.');
  }
  // THE ROOM ORIGIN IS THE FLOOR CENTROID, NOT WHERE THE USER HAPPENED TO BE STANDING.
  //
  // rsg.schema.json: "Origin sits at the centroid of the floor polygon, on the floor
  // plane." Only the Y offset used to be applied, leaving X and Z in ARKit world space —
  // and the ARKit origin is wherever the session started. On the sample fixture, which is
  // built centred on the origin, nothing looked wrong. On a real scan every room sat
  // metres off-origin, so `add` with no pointed destination placed at [0,0,0], outside the
  // floor polygon, and every object was refused with "Outside the calibrated room".
  //
  // `world_transform` is the room->ARKit transform and is where that displacement belongs.
  const centre = polygon.reduce(
    (sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length],
    [0, 0] as Point2,
  );
  /** Room-space from ARKit-world. Subtract once, here, and nowhere else. */
  const origin: Vec3 = [centre[0], offset, centre[1]];
  const toRoom = (point: readonly number[]): Vec3 => [
    point[0]! - origin[0],
    point[1]! - origin[1],
    point[2]! - origin[2],
  ];
  polygon = polygon.map<Point2>((point) => [point[0] - origin[0], point[1] - origin[2]]);

  const height = Math.max(...walls.flatMap((s) => s.polygon.map((p) => p[1]! - offset)));
  const inferredFloor = floor
    ? []
    : [
        {
          id: 'inferred-floor',
          class: 'floor' as const,
          polygon: polygon.map<Vec3>((point) => [point[0], 0, point[1]]),
          plane: { normal: [0, 1, 0] as Vec3, offset: 0 },
          material_ref: '#c5c8cc',
          provenance: 'inferred' as const,
          state: 'present' as const,
          parent: null,
          swing: null,
        },
      ];
  const scene: Rsg = {
    room_id: data.id,
    version: 0,
    frame: {
      units: 'm',
      up: [0, 1, 0],
      // Column-major; the last column is the translation that maps room space back to
      // the ARKit world frame.
      world_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...origin, 1],
    },
    bounds: {
      floor_polygon: polygon,
      ceiling_height: height,
      area_m2: Math.abs(signedArea(polygon)),
    },
    lighting: { ambient_cct: 4500, intensity: 850, preset: 'measured' },
    occupancy: { grid_rle: [], origin: [0, 0], resolution_m: 0.05, size: [0, 0] },
    relations: [],
    surfaces: [
      ...data.surfaces.map((s) => {
        const n: Vec3 =
          s.kind === 'floor'
            ? [0, 1, 0]
            : [s.transform[8]!, s.transform[9]!, s.transform[10]!];
        const local = s.polygon.map(toRoom);
        const p = local[0] ?? [0, 0, 0];
        return {
          id: s.id,
          class: s.kind === 'opening' ? ('door' as const) : s.kind,
          polygon: local,
          plane: {
            // Derived from the translated corner, or the plane would still describe the
            // surface's old position and every containment test would be off by `origin`.
            normal: n,
            offset: n[0] * p[0]! + n[1] * p[1]! + n[2] * p[2]!,
          },
          material_ref: '#c5c8cc',
          // RoomPlan's own doubt is the first input. Coverage adds the second, below, once
          // the walls exist and their angular spans can be measured.
          provenance: lowConfidence(s.confidence) ? ('inferred' as const) : ('real' as const),
          state: 'present' as const,
          parent: null,
          swing: null,
        };
      }),
      ...inferredFloor,
    ],
    objects: data.objects.map((o) => ({
      id: o.id,
      class: SceneObjectClassSchema.safeParse(o.category).success
        ? SceneObjectClassSchema.parse(o.category)
        : 'storage',
      refined_class: o.category,
      dimensions: o.dimensions,
      pose: {
        position: [
          o.transform[12]! - origin[0],
          o.transform[13]! - origin[1] - o.dimensions[1]! / 2,
          o.transform[14]! - origin[2],
        ],
        yaw: Math.atan2(o.transform[8]!, o.transform[10]!),
      },
      pivot: 'base_center',
      material_ref: '#8c9298',
      asset_ref: null,
      movable: true,
      provenance: 'real',
      state: 'present',
      salience: 0.5,
    })),
  };
  const measured = RsgSchema.parse(scene);
  const state: EditorState = {
    schemaVersion: 2,
    sessionId: data.id,
    calibrationId: data.id,
    frameId,
    revision: 0,
    calibrationRevision,
    provenance: 'observed',
    measured,
    design: JSON.parse(JSON.stringify(measured)),
    assemblies: {},
    removedPhysicalIds: [],
    removalMaskIds: [],
    removalMaskCalibration: null,
    maskVolumes: [],
    /** M7 groups start empty: a scan produces measured furniture, never a design group. */
    groups: {},
  };

  // WHAT THE SWEEP ACTUALLY SAW OUTRANKS WHAT ROOMPLAN CLAIMS.
  //
  // RoomPlan closes a room: after a 270 degree turn it still reports four walls, and it
  // reports them confidently, because it infers the fourth from the three it measured. The
  // milestone rule is that unknown space cannot silently become verified space, so a wall
  // the camera never faced is demoted here however sure RoomPlan is about it.
  //
  // Without a mask this is a replay of geometry alone and no demotion is possible; the
  // caller gets `coverage: null` rather than a fabricated all-clear.
  const coverage = mask ? evaluateCoverage(state, mask) : null;
  if (coverage) {
    const unmeasured = new Set(coverage.inferredWallIds);
    for (const surface of state.design.surfaces)
      if (unmeasured.has(surface.id)) surface.provenance = 'inferred';
    // `measured` is DeepReadonly to the compiler, but the same demotion has to reach it or
    // the observation would keep claiming a precision the design no longer does.
    for (const surface of (state.measured as Rsg).surfaces)
      if (unmeasured.has(surface.id)) surface.provenance = 'inferred';
  }

  // One inferred structural surface makes the whole shell inferred. This enum member existed
  // in the contract and had never been assigned by anything.
  if (state.design.surfaces.some((surface) => surface.provenance === 'inferred'))
    state.provenance = 'inferred';

  return { origin, scene: state, coverage };
}
