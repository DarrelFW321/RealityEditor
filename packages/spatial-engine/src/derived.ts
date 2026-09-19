import type { EditorState, Vec3 } from '@reality/contracts';
import type { Occupancy, Relation } from '@reality/contracts';
import { footprint, inside, penetration, type ObjectLike, type P2 } from './geometry';
import { Clearances } from './clearances';

/**
 * Scene data that is DERIVED, never authored: the floor occupancy grid and the spatial
 * relations. Both are functions of committed geometry, so both are rebuilt from it rather
 * than edited alongside it.
 *
 * Until now `commit` blanked occupancy to `grid_rle: []`, `size: [0, 0]` with the comment
 * "Occupancy is derived. Never hand a consumer a stale grid." That was the right instinct
 * and the wrong half of the fix: no consumer ever got a stale grid because no consumer
 * ever got a grid at all. Relations were carried through from the fixture untouched and
 * went stale the moment anything moved.
 */

/** Fixed by the schema. Changing it invalidates every tuned clearance constant. */
const RESOLUTION = 0.05;
/** 5cm cells over a 12x12m room is 57,600 cells. Past that the RLE stops being cheap and
 * the room is beyond this milestone's single-room scope anyway. */
const MAX_CELLS = 240;

const bounds2 = (points: readonly (readonly number[])[]) => {
  const xs = points.map((p) => p[0] ?? 0);
  const zs = points.map((p) => p[1] ?? 0);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
};

/**
 * Rasterises the floor into the schema's run-length grid.
 *
 * A cell is OCCUPIED when it lies outside the floor polygon or under an object's
 * footprint. Outside-the-room counts as occupied because the grid answers "can something
 * stand here", and unknown space is not free space.
 *
 * `objects` is passed in rather than read from the scene so the caller decides which layer
 * this grid describes. The proposed design and the retained physical obstacles are
 * different questions and must not be merged: erasing a sofa from the design does not make
 * the floor it occupies physically clear.
 */
export function buildOccupancy(scene: EditorState, objects: readonly ObjectLike[]): Occupancy {
  const polygon = scene.design.bounds.floor_polygon as P2[];
  if (polygon.length < 3) return { resolution_m: RESOLUTION, origin: [0, 0], size: [1, 1], grid_rle: [0, 1] };

  const { minX, maxX, minZ, maxZ } = bounds2(polygon);
  const cellsX = Math.min(MAX_CELLS, Math.max(1, Math.ceil((maxX - minX) / RESOLUTION)));
  const cellsZ = Math.min(MAX_CELLS, Math.max(1, Math.ceil((maxZ - minZ) / RESOLUTION)));
  // The schema defines origin as the CENTRE of cell (0,0), not its corner.
  const origin: [number, number] = [minX + RESOLUTION / 2, minZ + RESOLUTION / 2];

  // Pre-compute each footprint and its bounding box so the inner loop rejects most
  // objects with four comparisons instead of a polygon test.
  const blockers = objects.map((object) => {
    const hull = footprint(object);
    return { hull, box: bounds2(hull) };
  });

  const cells = new Uint8Array(cellsX * cellsZ);
  for (let iz = 0; iz < cellsZ; iz++) {
    const z = origin[1] + iz * RESOLUTION;
    for (let ix = 0; ix < cellsX; ix++) {
      const x = origin[0] + ix * RESOLUTION;
      const index = iz * cellsX + ix;
      if (!inside([x, z], polygon)) {
        cells[index] = 1;
        continue;
      }
      for (const blocker of blockers) {
        if (x < blocker.box.minX || x > blocker.box.maxX || z < blocker.box.minZ || z > blocker.box.maxZ)
          continue;
        if (inside([x, z], blocker.hull)) {
          cells[index] = 1;
          break;
        }
      }
    }
  }

  // Runs ALTERNATE starting with FREE, so a grid whose first cell is occupied needs a
  // leading zero-length free run. The schema says so explicitly and the sum has to come
  // out at the cell count either way.
  const runs: number[] = [];
  let current = 0;
  let length = 0;
  for (let i = 0; i < cells.length; i++) {
    const value = cells[i] ?? 0;
    if (value === current) {
      length += 1;
      continue;
    }
    runs.push(length);
    current = value;
    length = 1;
  }
  runs.push(length);
  if (runs.length === 1 && current === 1) runs.unshift(0);

  return { resolution_m: RESOLUTION, origin, size: [cellsX, cellsZ], grid_rle: runs };
}

/** Free cells over total. Cheap enough to report in diagnostics, and the honest measure
 * of how much room a layout has left. */
export function freeFraction(occupancy: Occupancy): number {
  const total = (occupancy.size[0] ?? 0) * (occupancy.size[1] ?? 0);
  if (!total) return 0;
  let free = 0;
  occupancy.grid_rle.forEach((run, index) => {
    if (index % 2 === 0) free += run;
  });
  return free / total;
}

/**
 * Derives the spatial relations from current geometry.
 *
 * Only predicates with a defined geometric meaning are emitted. `blocks` stays unemitted
 * because it needs a circulation graph this project does not have — the same decision M2
 * recorded for `blocks_walkway`, and inventing it here would make a soft clearance note
 * look like a measured fact.
 *
 * Relations for entities that no longer exist are simply never produced: the list is
 * rebuilt from scratch, so a stale relation cannot survive a removal.
 */
export function buildRelations(scene: EditorState): Relation[] {
  const objects = scene.design.objects.filter((o) => o.state === 'present');
  const walls = scene.design.surfaces.filter((s) => s.class === 'wall' && s.state === 'present');
  const windows = scene.design.surfaces.filter((s) => s.class === 'window' && s.state === 'present');
  const relations: Relation[] = [];
  const q = (value: number) => Math.round(value * 1e4) / 1e4;

  for (const object of objects) {
    const hull = footprint(object as ObjectLike);
    const centre = (object.pose.position as Vec3) ?? [0, 0, 0];

    // against_wall: the nearest wall plane is within the contact band.
    let nearestWall: { id: string; distance: number } | null = null;
    for (const wall of walls) {
      const n = wall.plane.normal;
      const distance = Math.abs(
        (n[0] ?? 0) * (centre[0] ?? 0) + (n[1] ?? 0) * (centre[1] ?? 0) + (n[2] ?? 0) * (centre[2] ?? 0) -
          wall.plane.offset,
      );
      // Measured from the footprint's own extent, not its centre, or a wide object would
      // never read as against the wall it is touching.
      const reach = Math.max(...hull.map((p) => Math.abs((p[0] - (centre[0] ?? 0)) * (n[0] ?? 0) + (p[1] - (centre[2] ?? 0)) * (n[2] ?? 0))));
      const gap = distance - reach;
      if (!nearestWall || gap < nearestWall.distance) nearestWall = { id: wall.id, distance: gap };
    }
    if (nearestWall && nearestWall.distance <= Clearances.wallContactEpsilon)
      relations.push({
        subject: object.id,
        predicate: 'against_wall',
        object: nearestWall.id,
        distance: q(Math.max(0, nearestWall.distance)),
      });

    // under_window: the footprint overlaps a window's horizontal span on its wall.
    for (const window of windows) {
      const span = window.polygon.map<P2>((p) => [p[0] ?? 0, p[2] ?? 0]);
      if (span.length >= 2 && penetration(hull, span) > 0)
        relations.push({ subject: object.id, predicate: 'under_window', object: window.id, distance: 0 });
    }

    // on_top_of: the declared support, which is the only thing that may claim it. A
    // geometric guess here would resurrect exactly the "settling promotes an object onto
    // whatever lies beneath" behaviour M2 removed.
    const support = scene.assemblies[object.id]?.support;
    if (support?.mode === 'object' && objects.some((o) => o.id === support.surfaceId))
      relations.push({ subject: object.id, predicate: 'on_top_of', object: support.surfaceId, distance: 0 });

    for (const other of objects) {
      if (other.id === object.id) continue;
      const otherHull = footprint(other as ObjectLike);
      const otherCentre = (other.pose.position as Vec3) ?? [0, 0, 0];
      const gap = Math.hypot(
        (centre[0] ?? 0) - (otherCentre[0] ?? 0),
        (centre[2] ?? 0) - (otherCentre[2] ?? 0),
      );
      if (gap > Clearances.adjacencyThreshold + 1.5) continue;
      const separation = -penetration(hull, otherHull);
      if (separation <= Clearances.adjacencyThreshold)
        relations.push({ subject: object.id, predicate: 'adjacent_to', object: other.id, distance: q(Math.max(0, separation)) });

      // in_front_of: the other object lies within a cone ahead of this one. -Z is
      // forward at yaw 0, matching the engine's convention everywhere else.
      const yaw = object.pose.yaw;
      const forward: [number, number] = [-Math.sin(yaw), -Math.cos(yaw)];
      const toOther: [number, number] = [(otherCentre[0] ?? 0) - (centre[0] ?? 0), (otherCentre[2] ?? 0) - (centre[2] ?? 0)];
      const length = Math.hypot(toOther[0], toOther[1]);
      if (length > 1e-6 && gap <= Clearances.adjacencyThreshold + 1.5) {
        const cosine = (forward[0] * toOther[0] + forward[1] * toOther[1]) / length;
        if (cosine > 0.7)
          relations.push({ subject: object.id, predicate: 'in_front_of', object: other.id, distance: q(length) });
      }
    }
  }

  // Deterministic order: two identical scenes must produce byte-identical relations, or
  // the undo scenario's byte-for-byte comparison becomes a coin flip.
  return relations.sort((a, b) =>
    a.subject !== b.subject
      ? a.subject < b.subject
        ? -1
        : 1
      : a.predicate !== b.predicate
        ? a.predicate < b.predicate
          ? -1
          : 1
        : a.object < b.object
          ? -1
          : a.object > b.object
            ? 1
            : 0,
  );
}

/**
 * Recomputes every derived field on a candidate scene, in place, before it is committed.
 *
 * Design occupancy describes the PROPOSED layout only. The physical obstacles a restyle
 * has visually erased stay out of it deliberately — `buildIndex` consults
 * `measured.objects` against `removedPhysicalIds` separately, and merging the two here
 * would make erased furniture look like free floor to anything reading the grid.
 */
export function rebuildDerived(scene: EditorState): void {
  scene.design.occupancy = buildOccupancy(
    scene,
    scene.design.objects.filter((o) => o.state === 'present') as unknown as ObjectLike[],
  );
  scene.design.relations = buildRelations(scene);
}
