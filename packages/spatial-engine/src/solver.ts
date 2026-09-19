import type {
  ConstraintReport,
  EditorState,
  PoseV1,
  Vec3,
  ViolationResolved,
  Alternative,
} from '@reality/contracts';
import { prefersWall, q, searchRadiusM, searchStepM } from './clearances';
import {
  buildIndex,
  evaluatePlacement,
  inside,
  wallFacingYaw,
  type ObjectLike,
  type SceneIndex,
} from './geometry';

export type SolveBudget = {
  radiusM?: number;
  stepM?: number;
  deadlineMs?: number;
  /** The declared support, exempt from intersection checks. */
  supportId?: string;
  /** A drop starts above its support on purpose; settling closes that gap. */
  allowAboveSupport?: boolean;
};

export const emptyReport = (status: ConstraintReport['status']): ConstraintReport => ({
  status,
  applied_pose: null,
  requested_pose: null,
  adjustment_reason: null,
  adjustment_distance_m: 0,
  violations_resolved: [],
  remaining_notes: [],
  alternatives: [],
});

const pose = (value: PoseV1) => ({ position: [...value.position], yaw: value.yaw });

/** Highest first. Matches ConstraintSolver.violationPriority. */
const PRIORITY: ViolationResolved['type'][] = [
  'blocks_door_swing',
  'intersection',
  'out_of_bounds',
  'unsupported',
  'floating',
  'blocks_window',
  'blocks_walkway',
];

export function dominant(violations: ViolationResolved[]): ViolationResolved | null {
  let best: ViolationResolved | null = null;
  for (const violation of violations) {
    if (!best) {
      best = violation;
      continue;
    }
    const a = PRIORITY.indexOf(violation.type);
    const b = PRIORITY.indexOf(best.type);
    if (a < b || (a === b && violation.overlap_m > best.overlap_m + 1e-12)) best = violation;
  }
  return best;
}

/** One lowercase clause, no leading capital and no trailing period. */
export function reasonFor(
  violation: ViolationResolved,
  name: (id: string) => string,
  arcRadius: (id: string) => number | null,
): string {
  const centimetres = Math.round(violation.overlap_m * 100);
  switch (violation.type) {
    case 'blocks_door_swing': {
      const radius = arcRadius(violation.with);
      return radius
        ? `the ${name(violation.with)} needs ${Math.round(radius * 100)}cm to swing open`
        : `the ${name(violation.with)} needs room to open`;
    }
    case 'intersection':
      return `it was overlapping the ${name(violation.with)} by ${centimetres}cm`;
    case 'out_of_bounds':
      return 'it was outside the room';
    case 'floating':
      return violation.with
        ? `it was not resting on the ${name(violation.with)}`
        : `it was floating ${centimetres}cm off the floor`;
    case 'unsupported':
      return `it was hanging off the edge of the ${name(violation.with)}`;
    case 'blocks_window':
      return `it was covering the ${name(violation.with)}`;
    default:
      return 'it was in the way';
  }
}

function compass(normal: Vec3): string {
  if (normal[2] > 0.9) return 'north';
  if (normal[2] < -0.9) return 'south';
  if (normal[0] < -0.9) return 'east';
  if (normal[0] > 0.9) return 'west';
  return 'nearby';
}

function withPose<T extends ObjectLike>(object: T, next: PoseV1): T {
  return { ...object, pose: { position: [...next.position], yaw: next.yaw } };
}

function moved(a: PoseV1, b: PoseV1): boolean {
  const planar = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
  return planar > 0.05 || Math.abs(a.yaw - b.yaw) > 1e-3;
}

/**
 * Turns a requested pose into an applied one, or explains why it cannot.
 * Pure: it never mutates `scene`, the object, or the index.
 */
export function solvePlacement(
  scene: EditorState,
  targetId: string,
  requested: PoseV1,
  index?: SceneIndex,
  budget: SolveBudget = {},
): ConstraintReport {
  const stored = scene.design.objects.find((o) => o.id === targetId);
  const report = emptyReport('applied');
  if (!stored) {
    return { ...report, status: 'rejected', adjustment_reason: 'that object is not in the room' };
  }
  report.requested_pose = pose(requested);

  const scan = index ?? buildIndex(scene, targetId);
  const name = (id: string) => {
    const object = scene.design.objects.find((o) => o.id === id);
    if (object) return object.refined_class ?? object.class;
    const surface = scene.design.surfaces.find((s) => s.id === id);
    return surface ? surface.class : id;
  };
  const arcRadius = (id: string) =>
    scene.design.surfaces.find((s) => s.id === id)?.swing?.arc_radius ?? null;

  if (!stored.movable && moved({ position: stored.pose.position as Vec3, yaw: stored.pose.yaw }, requested))
    return {
      ...report,
      status: 'rejected',
      adjustment_reason: `the ${name(targetId)} is built in and cannot move`,
      alternatives: [],
    };

  const evaluate = (candidate: PoseV1, stopAtFirst: boolean) =>
    evaluatePlacement(scene, withPose(stored as ObjectLike, candidate), {
      index: scan,
      supportId: budget.supportId,
      allowAboveSupport: budget.allowAboveSupport,
      stopAtFirst,
      skipNotes: stopAtFirst,
    });

  const initial = evaluate(requested, false);
  if (!initial.violations.length)
    return {
      ...report,
      status: 'applied',
      applied_pose: pose(requested),
      remaining_notes: initial.notes,
    };

  const found = nudge(requested, (candidate) => evaluate(candidate, true).violations.length === 0, budget);
  if (found) {
    const settled = evaluate(found, false);
    const distance = q(
      Math.hypot(
        found.position[0] - requested.position[0],
        found.position[2] - requested.position[2],
      ),
    );
    const worst = dominant(initial.violations);
    return {
      ...report,
      status: 'adjusted',
      applied_pose: pose(found),
      adjustment_distance_m: distance,
      adjustment_reason: worst ? reasonFor(worst, name, arcRadius) : 'it did not fit',
      violations_resolved: initial.violations,
      remaining_notes: settled.notes,
    };
  }

  const worst = dominant(initial.violations);
  return {
    ...report,
    status: 'rejected',
    applied_pose: null,
    adjustment_distance_m: 0,
    adjustment_reason: worst ? reasonFor(worst, name, arcRadius) : 'it did not fit',
    violations_resolved: initial.violations,
    alternatives: alternatives(scene, stored as ObjectLike, requested, scan, budget),
  };
}

/**
 * Expanding square rings on a fixed integer lattice, yaw held constant.
 * Integer steps and a documented scan order keep two runs byte-identical.
 */
export function nudge(
  requested: PoseV1,
  legal: (candidate: PoseV1) => boolean,
  budget: SolveBudget = {},
): PoseV1 | null {
  const step = budget.stepM ?? searchStepM;
  const rings = Math.max(1, Math.round((budget.radiusM ?? searchRadiusM) / step));
  const deadline = Date.now() + (budget.deadlineMs ?? 120);
  for (let ring = 1; ring <= rings; ring++) {
    let best: PoseV1 | null = null;
    let bestDistance = Infinity;
    for (let dz = -ring; dz <= ring; dz++)
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        const candidate: PoseV1 = {
          position: [
            q(requested.position[0] + dx * step),
            requested.position[1],
            q(requested.position[2] + dz * step),
          ],
          yaw: requested.yaw,
        };
        if (!legal(candidate)) continue;
        const distance = Math.hypot(dx * step, dz * step);
        if (distance < bestDistance - 1e-12) {
          bestDistance = distance;
          best = candidate;
        }
      }
    if (best) return best;
    if (Date.now() > deadline) return null;
  }
  return null;
}

function alternatives(
  scene: EditorState,
  object: ObjectLike,
  requested: PoseV1,
  index: SceneIndex,
  budget: SolveBudget,
): Alternative[] {
  const candidates: { position: Vec3; yaw: number; summary: string }[] = [];
  for (const wall of index.walls) {
    const yaw = wallFacingYaw(wall.normal);
    const along =
      -wall.normal[2] * requested.position[0] + wall.normal[0] * requested.position[2];
    const base: Vec3 = [
      wall.normal[0] * wall.offset - wall.normal[2] * along,
      requested.position[1],
      wall.normal[2] * wall.offset + wall.normal[0] * along,
    ];
    const depth = (object.dimensions[2] ?? 0) / 2;
    candidates.push({
      position: [base[0] + wall.normal[0] * depth, base[1], base[2] + wall.normal[2] * depth],
      yaw,
      summary: `against the ${compass(wall.normal)} wall`,
    });
    for (const opening of wall.openings) {
      if (opening.cls !== 'window') continue;
      const u = (opening.lo[0] + opening.hi[0]) / 2;
      candidates.push({
        position: [
          wall.normal[0] * wall.offset - wall.normal[2] * u + wall.normal[0] * depth,
          requested.position[1],
          wall.normal[2] * wall.offset + wall.normal[0] * u + wall.normal[2] * depth,
        ],
        yaw,
        summary: `under the window on the ${compass(wall.normal)} wall`,
      });
    }
  }
  const centroid = index.floor.reduce(
    (acc, p) => [acc[0] + p[0] / index.floor.length, acc[1] + p[1] / index.floor.length],
    [0, 0],
  );
  candidates.push({
    position: [centroid[0]!, requested.position[1], centroid[1]!],
    yaw: requested.yaw,
    summary: 'in the open floor space',
  });

  const diagonal = Math.max(1e-6, Math.hypot(
    Math.max(...index.floor.map((p) => p[0])) - Math.min(...index.floor.map((p) => p[0])),
    Math.max(...index.floor.map((p) => p[1])) - Math.min(...index.floor.map((p) => p[1])),
  ));

  const scored: Alternative[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.summary)) continue;
    if (!inside([candidate.position[0], candidate.position[2]], index.floor)) continue;
    seen.add(candidate.summary);
    const target: PoseV1 = { position: candidate.position, yaw: candidate.yaw };
    const clean =
      evaluatePlacement(scene, { ...object, pose: { position: target.position, yaw: target.yaw } }, {
        index,
        supportId: budget.supportId,
        allowAboveSupport: budget.allowAboveSupport,
        stopAtFirst: true,
        skipNotes: true,
      }).violations.length === 0;
    const distance = Math.hypot(
      candidate.position[0] - requested.position[0],
      candidate.position[2] - requested.position[2],
    );
    const proximity = 1 - Math.min(1, distance / diagonal);
    const againstWall = candidate.summary !== 'in the open floor space';
    const fit = prefersWall(object.class) === againstWall ? 1 : 0.5;
    const score = q(Math.max(0, Math.min(1, 0.5 * proximity + 0.3 * fit + 0.2 * (clean ? 1 : 0))));
    if (!Number.isFinite(score)) continue;
    scored.push({
      position: [q(candidate.position[0]), q(candidate.position[1]), q(candidate.position[2])],
      yaw: q(candidate.yaw),
      score,
      summary: candidate.summary,
    });
  }

  // Legal candidates strictly preferred, then score, then a total order on the text.
  const legalOf = (a: Alternative) => (a.score >= 0.2 ? 1 : 0);
  scored.sort(
    (a, b) =>
      legalOf(b) - legalOf(a) ||
      b.score - a.score ||
      (a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0),
  );
  return scored.slice(0, 3);
}
