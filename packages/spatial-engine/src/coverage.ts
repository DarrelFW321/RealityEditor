import type { EditorState, ReconstructionRoom, Vec3 } from '@reality/contracts';
import { compass } from './solver';
import type { P2 } from './geometry';

/**
 * What the camera actually looked at during a sweep.
 *
 * The milestone rule is that calibration "asks for missing views instead of treating a full
 * spin as sufficient", so completion cannot be a turn angle: spinning on the spot with the
 * lens covered satisfies 270° without observing anything. Coverage answers the different
 * question of which room boundaries were in front of the camera while tracking was good.
 *
 * This lives in TypeScript rather than Swift on purpose. `onFrame` already ships
 * `cameraToWorld` and `tracking` at 20Hz in every mode, so the evidence is already crossing
 * the bridge; forming the judgement here keeps it replayable from a recorded capture and
 * keeps a native rebuild off the path of every change to the rules.
 */

/** 15° each. Fine enough to tell one wall of a small room from its neighbour, coarse enough
 * that a hand tremor does not open a gap in an otherwise observed arc. */
export const SECTOR_COUNT = 24;
const SECTOR_RADIANS = (Math.PI * 2) / SECTOR_COUNT;

/** Below this the phone is pointed at the floor or ceiling and its yaw means nothing. The
 * same guard exists in the native sweep integrator for the same reason. */
const HORIZONTAL_EPS = 0.35;

export const sectorOf = (yaw: number): number => {
  const turns = yaw / (Math.PI * 2);
  return Math.floor((turns - Math.floor(turns)) * SECTOR_COUNT) % SECTOR_COUNT;
};

/** Yaw the camera is facing, from a column-major 4x4 camera-to-world matrix.
 *
 * Camera forward is -Z, so the world-space heading is column 2 negated. Returns null when
 * the phone is too close to vertical for a heading to be meaningful. */
export function headingOf(cameraToWorld: readonly number[]): number | null {
  const x = -(cameraToWorld[8] ?? 0);
  const z = -(cameraToWorld[10] ?? 0);
  if (Math.hypot(x, z) < HORIZONTAL_EPS) return null;
  return Math.atan2(x, z);
}

/** A sweep's observations. Serialisable on purpose: a recorded capture replays as this. */
export type CoverageMask = {
  /** One entry per sector, true when observed under normal tracking. */
  sectors: boolean[];
  /** Sectors seen only while tracking was limited or lost. Kept apart so a degraded look at
   * a wall is never counted as having measured it. */
  degraded: boolean[];
};

export const emptyMask = (): CoverageMask => ({
  sectors: Array<boolean>(SECTOR_COUNT).fill(false),
  degraded: Array<boolean>(SECTOR_COUNT).fill(false),
});

/** Accumulates a `CoverageMask` from the tracked-frame stream.
 *
 * Deliberately narrow input: the mobile `TrackedFrame` carries hand samples, thermal state
 * and viewport metadata that this package has no business knowing about. */
export class CoverageTracker {
  private mask = emptyMask();

  observe(frame: { cameraToWorld: readonly number[]; tracking: string }) {
    const heading = headingOf(frame.cameraToWorld);
    if (heading === null) return;
    const sector = sectorOf(heading);
    // Tracking quality decides which bucket, never whether to record. A sweep done entirely
    // under limited tracking must still be able to say where the user pointed.
    if (frame.tracking === 'normal') this.mask.sectors[sector] = true;
    else this.mask.degraded[sector] = true;
  }

  snapshot = (): CoverageMask => ({
    sectors: [...this.mask.sectors],
    degraded: [...this.mask.degraded],
  });

  reset() {
    this.mask = emptyMask();
  }
}

export type WallCoverage = {
  id: string;
  /** Compass word for the direction the user must face to see it. */
  side: string;
  /** Portion of the wall's angular span observed under normal tracking, 0..1. */
  fraction: number;
  /** Seen well enough to call the geometry measured rather than inferred. */
  measured: boolean;
  /** Barely seen at all. Worth interrupting the user for. */
  needsView: boolean;
  /** True when the only look at this wall happened under degraded tracking. */
  degradedOnly: boolean;
};

export type CoverageReport = {
  status: 'observing' | 'needs_view' | 'ready';
  /** Fraction of the full circle observed under normal tracking. Progress, not acceptance. */
  observedFraction: number;
  walls: WallCoverage[];
  /** Ids of boundaries barely seen at all. Empty unless `needs_view`. */
  missing: string[];
  /** Walls seen too poorly to call measured. These become `provenance: 'inferred'`, and
   * after the intended 270 degree sweep this is normally non-empty. */
  inferredWallIds: string[];
  /** One sentence naming what to do next, or null when ready. */
  prompt: string | null;
};

const centroidOf = (polygon: readonly (readonly number[])[]): P2 => {
  if (!polygon.length) return [0, 0];
  let x = 0;
  let z = 0;
  for (const p of polygon) {
    x += p[0] ?? 0;
    z += p[1] ?? 0;
  }
  return [x / polygon.length, z / polygon.length];
};

/** The smallest arc containing every heading, as `[start, sweep]` in radians.
 *
 * Found by taking the complement of the largest angular gap, which is the only way to get
 * this right across the +/-pi seam: a wall spanning north has headings near +pi and -pi that
 * a naive min/max would call a 350 degree arc. */
function arcOf(headings: number[]): [number, number] {
  if (!headings.length) return [0, 0];
  const sorted = [...headings].sort((a, b) => a - b);
  let gapStart = sorted[sorted.length - 1]!;
  let gap = sorted[0]! + Math.PI * 2 - gapStart;
  for (let i = 1; i < sorted.length; i++) {
    const candidate = sorted[i]! - sorted[i - 1]!;
    if (candidate > gap) {
      gap = candidate;
      gapStart = sorted[i - 1]!;
    }
  }
  return [gapStart + gap, Math.PI * 2 - gap];
}

/** Fraction of the sectors a wall occupies that were observed.
 *
 * Measuring the whole span rather than one representative sector is what makes the 270
 * degree sweep honest: the wall behind the user subtends roughly 90 degrees of a small
 * room, and leaving all of it unseen has to read as unseen. An earlier version tested the
 * midpoint sector with a +/-1 tolerance, which let a wall 15 degrees outside the swept arc
 * count as measured and reported a 270 degree sweep as complete. */
function observedFractionOf(mask: readonly boolean[], start: number, sweep: number): number {
  const first = Math.floor(start / SECTOR_RADIANS);
  const count = Math.max(1, Math.ceil(sweep / SECTOR_RADIANS));
  let seen = 0;
  for (let i = 0; i < count; i++)
    if (mask[(((first + i) % SECTOR_COUNT) + SECTOR_COUNT) % SECTOR_COUNT]) seen += 1;
  return seen / count;
}

/** Two thresholds, because "measured" and "worth interrupting for" are different questions.
 *
 * At or above MEASURED the wall was seen well enough to call it measured. Below that it is
 * still usable but its provenance becomes `inferred` - which is exactly what the deliberate
 * 270 degree sweep is supposed to produce for the wall the user started with their back to.
 * Blocking there would fight the intended flow; labelling it honestly is the requirement.
 *
 * NEEDS_VIEW is far lower. Only a boundary almost nobody looked at justifies stopping the
 * user and asking, and at that point the geometry is guesswork rather than a rough read. */
const MEASURED_SPAN_FRACTION = 0.75;
const NEEDS_VIEW_SPAN_FRACTION = 0.25;

/**
 * Judges a sweep against the room it produced.
 *
 * A wall counts as observed when the camera faced enough of it, from inside the room, under
 * normal tracking. Its angular span is measured from the floor centroid, which is where a
 * person standing in the room looks from.
 */
export function evaluateCoverage(scene: EditorState, mask: CoverageMask): CoverageReport {
  const centre = centroidOf(scene.design.bounds.floor_polygon);
  const observedCount = mask.sectors.filter(Boolean).length;
  const walls: WallCoverage[] = scene.design.surfaces
    .filter((s) => s.class === 'wall' && s.state === 'present')
    .map((wall) => {
      const [start, sweep] = arcOf(
        wall.polygon.map((p) => Math.atan2((p[0] ?? 0) - centre[0], (p[2] ?? 0) - centre[1])),
      );
      const good = observedFractionOf(mask.sectors, start, sweep);
      const degraded = observedFractionOf(mask.degraded, start, sweep);
      return {
        id: wall.id,
        side: compass(wall.plane.normal as Vec3),
        fraction: good,
        measured: good >= MEASURED_SPAN_FRACTION,
        needsView: good < NEEDS_VIEW_SPAN_FRACTION,
        degradedOnly: good < MEASURED_SPAN_FRACTION && degraded >= MEASURED_SPAN_FRACTION,
      };
    })
    // Stable order so a report is comparable run to run.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const missing = walls.filter((w) => w.needsView);
  const report: Omit<CoverageReport, 'status' | 'prompt'> = {
    observedFraction: observedCount / SECTOR_COUNT,
    walls,
    missing: missing.map((w) => w.id),
    inferredWallIds: walls.filter((w) => !w.measured).map((w) => w.id),
  };

  // Nothing measured yet is still "observing"; a room with a known hole is a question.
  if (!walls.length)
    return { ...report, status: 'observing', prompt: 'Turn steadily to find the room boundaries.' };
  if (!missing.length) return { ...report, status: 'ready', prompt: null };
  return { ...report, status: 'needs_view', prompt: describeMissingView(missing) };
}

/** The ask, naming a direction rather than a surface id.
 *
 * "Show me srf_wall_east" is unusable; the point of the prompt is that the user can act on
 * it without knowing the scene graph. Degraded looks get different wording because the fix
 * is different: stand still and let tracking recover, rather than turn. */
export function describeMissingView(missing: readonly WallCoverage[]): string | null {
  if (!missing.length) return null;
  const first = missing[0]!;
  const rest = missing.length - 1;
  const more = rest > 0 ? ` Then ${rest} more boundar${rest === 1 ? 'y' : 'ies'}.` : '';
  if (first.degradedOnly)
    return `Hold steady and look at the ${first.side} wall again; tracking was unreliable there.${more}`;
  if (first.side === 'nearby')
    return `Step sideways so a boundary hidden by furniture comes into view.${more}`;
  return `Turn toward the ${first.side} wall so it can be measured.${more}`;
}

/**
 * The room, as the reconstruction worker needs to see it.
 *
 * Derived here rather than assembled at the call site so the mapping from scene to worker
 * input has one definition and can be checked without a server. Everything is in ROOM
 * space; `origin` is the only value in the world frame.
 *
 * Obstacles come from `measured`, not `design`. A sofa the user has already deleted from
 * the design is still in the photographs, so its pixels must still be rejected — the same
 * distinction the physical-obstacle collision layer makes.
 */
export function reconstructionRoom(scene: EditorState, origin: Vec3): ReconstructionRoom {
  const surfaces = scene.design.surfaces
    .filter((s) => (s.class === 'wall' || s.class === 'floor') && s.state === 'present')
    .filter((s) => s.polygon.length >= 3)
    .map((s) => ({
      id: s.id,
      class: s.class as 'wall' | 'floor',
      polygon: s.polygon.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3),
      normal: [s.plane.normal[0]!, s.plane.normal[1]!, s.plane.normal[2]!] as Vec3,
      inferred: s.provenance === 'inferred',
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const obstacles = scene.measured.objects
    .filter((o) => o.state === 'present')
    .map((o) => ({
      id: o.id,
      center: [o.pose.position[0]!, o.pose.position[1]!, o.pose.position[2]!] as Vec3,
      size: [o.dimensions[0]!, o.dimensions[1]!, o.dimensions[2]!] as Vec3,
      yaw: o.pose.yaw,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { origin, surfaces, obstacles };
}
