import type { SceneObject } from '@reality/contracts';

/** Guidance, not building code. Violating one produces a note, never a rejection.
 * Ported from ios/SpatialCore/Sources/SpatialCore/Solver/Clearances.swift. Metres. */
export const Clearances = {
  primaryWalkway: 0.76,
  secondaryWalkway: 0.61,
  bedside: 0.61,
  drawerFront: 0.91,
  coffeeTableToSeating: [0.4, 0.45] as const,
  chairPullout: 0.45,
  diningChairClearance: 0.91,
  televisionViewingRatio: 1.6,
  windowSillClearance: 0.1,
  /** Closer than this to a wall counts as against it. Also the height-sharing band. */
  wallContactEpsilon: 0.05,
  adjacencyThreshold: 0.45,
} as const;

/** Penetration deeper than this is a collision. Swift: ConstraintSolver.touchToleranceM. */
export const touchToleranceM = 0.005;
/** Ring spacing for the nudge search, matching the occupancy grid resolution. */
export const searchStepM = 0.05;
export const searchRadiusM = 1.5;
/** Below this an adjustment is applied silently. Swift: narratableAdjustmentM. */
export const narratableAdjustmentM = 0.05;

/** Quantise to 0.1mm before every threshold test, so two runs agree exactly. */
export const q = (value: number): number => Math.round(value * 1e4) / 1e4;

type Kind = SceneObject['class'];

/** Recommended clearance in front of an object of this class. */
export function frontClearance(kind: Kind): number {
  switch (kind) {
    case 'storage':
    case 'refrigerator':
    case 'dishwasher':
    case 'oven':
    case 'washerDryer':
    case 'stove':
      return Clearances.drawerFront;
    case 'bed':
      return Clearances.bedside;
    case 'toilet':
    case 'sink':
    case 'bathtub':
      return Clearances.primaryWalkway;
    case 'sofa':
    case 'chair':
    case 'table':
      return Clearances.chairPullout;
    case 'television':
    case 'fireplace':
    case 'stairs':
      return Clearances.primaryWalkway;
    case 'frame':
    case 'shelf':
      return Clearances.secondaryWalkway;
    default:
      return Clearances.secondaryWalkway;
  }
}

/** A sofa floating 20cm off a wall is the clearest tell that a layout was generated. */
export function prefersWall(kind: Kind): boolean {
  return kind !== 'chair' && kind !== 'table';
}
