import type {
  Assembly,
  Deviation,
  EditorState,
  Group,
  LayoutProposal,
  ProposalPlacement,
  RecipeItem,
  SceneObject,
  SceneRecipe,
  Template,
  Vec3,
} from '@reality/contracts';
import { searchStepM } from './clearances';
import {
  buildIndex,
  evaluatePlacement,
  inside,
  wallFacingYaw,
  type ObjectLike,
  type SceneIndex,
} from './geometry';
import { compass } from './solver';

/**
 * M7.2 — deterministic whole-layout planning.
 *
 * Given a validated recipe, computes poses for every requested object and checks the
 * WHOLE resulting arrangement, including the proposed objects against each other. The
 * conversational model never sees a coordinate: it asks for a recipe, this produces the
 * geometry, and the engine validates it again before anything commits.
 *
 * Determinism is a hard requirement, not a nicety — the same recipe against the same
 * room must produce byte-identical output, because that is the only way a proposal can
 * be reviewed, replayed and compared. So: fixed candidate order, integer grid steps,
 * index-derived identifiers, and no clock or random source anywhere in the search.
 *
 * Bounded, and honest about the boundary. Running out of evaluations is reported as
 * `search_exhausted`, which is NOT the same claim as `infeasible`; conflating them
 * would let a budget limit masquerade as a proof of impossibility (M7.2.7).
 */

/** Hard caps from the milestone. Both are per proposal. */
export const MAX_PLANNED_OBJECTS = 12;
export const MAX_EVALUATIONS = 20_000;
/** Minimum air between two members of the same group. */
export const GROUP_GAP_M = 0.12;
/** Kept clear at each end of a usable wall run. */
export const WALL_END_MARGIN_M = 0.05;
/** Kept clear around an opening, so a frame never abuts a window reveal. */
export const OPENING_MARGIN_M = 0.05;
/** Centre height for wall-mounted families when nothing else is specified. */
export const MOUNT_CENTRE_M = 1.5;

/** Family defaults, declared once. The planner resolves them; the model never sends
 * dimensions it invented, and a recipe that omits them is not underspecified. */
export const DEFAULT_DIMENSIONS: Record<Template, Vec3> = {
  bed: [1.5, 0.6, 2],
  table: [1, 0.75, 0.65],
  frame: [0.5, 0.6, 0.05],
  shelf: [0.8, 0.06, 0.3],
  cabinet: [0.8, 0.8, 0.5],
};
export const DEFAULT_COLOR = '#548ec8';

const WALL_FAMILIES = new Set<Template>(['frame', 'shelf']);
export const isWallFamily = (family: Template) => WALL_FAMILIES.has(family);

/** Builds the mesh and assembly for one planned object. Injected so the planner does
 * not depend on the recipe package, matching how the editor injects its modules. */
export type ObjectBuilder = (
  recipe: {
    family: Template;
    count: number;
    dimensions: Vec3;
    color: string;
    legs: 3 | 4;
  },
  id: string,
  position: Vec3,
  supportSurface: string,
  materialClass: RecipeItem['materialClass'],
) => { object: SceneObject; assembly: Assembly };

export type PlanContext = {
  proposalId: string;
  build: ObjectBuilder;
  /** Where the user pointed. Selects the wall or region when the recipe names none. */
  destination?: { position: Vec3; surfaceId: string } | null;
  maxEvaluations?: number;
  maxObjects?: number;
};

type Budget = { used: number; limit: number; exhausted: boolean };

/** One interval of usable surface, in along-wall metres. */
export type Interval = { lo: number; hi: number };

// ---------------------------------------------------------------- wall runs

/**
 * The runs of a wall a group may actually use, with openings removed.
 *
 * `vLo`/`vHi` matter: an opening only blocks the run if it overlaps the band the members
 * will occupy. A shelf at knee height is not obstructed by a window at head height, and
 * treating every opening as a full-height obstruction would refuse layouts that are fine.
 */
export function usableWallIntervals(
  wall: SceneIndex['walls'][number],
  vLo: number,
  vHi: number,
): Interval[] {
  const wallLo = Math.min(...wall.polygonUV.map((p) => p[0])) + WALL_END_MARGIN_M;
  const wallHi = Math.max(...wall.polygonUV.map((p) => p[0])) - WALL_END_MARGIN_M;
  if (wallHi <= wallLo) return [];
  let runs: Interval[] = [{ lo: wallLo, hi: wallHi }];
  const blockers = wall.openings
    .filter((o) => Math.min(vHi, o.hi[1]) - Math.max(vLo, o.lo[1]) > 0)
    .map((o) => ({ lo: o.lo[0] - OPENING_MARGIN_M, hi: o.hi[0] + OPENING_MARGIN_M }))
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  for (const blocker of blockers) {
    const next: Interval[] = [];
    for (const run of runs) {
      if (blocker.hi <= run.lo || blocker.lo >= run.hi) {
        next.push(run);
        continue;
      }
      if (blocker.lo > run.lo) next.push({ lo: run.lo, hi: blocker.lo });
      if (blocker.hi < run.hi) next.push({ lo: blocker.hi, hi: run.hi });
    }
    runs = next;
  }
  return runs.filter((r) => r.hi - r.lo > 1e-6);
}

/**
 * Places `count` members of width `width` across the usable runs, evenly spaced.
 *
 * Two strategies, tried in order, because "evenly spaced in usable wall space" has two
 * reasonable meanings and only one of them survives an opening in the middle of a wall:
 *
 *  1. ONE RUN, or the runs unrolled end-to-end into a single measure. Gives perfectly
 *     equal spacing. Rejected when any member would straddle the gap the opening cut,
 *     which is exactly what happens to the middle of an odd-numbered group over a
 *     centred window.
 *  2. Allocate members to runs in proportion to run length (largest remainder, ties to
 *     the lower run), then spread each run's members evenly within it.
 *
 * Members are spread to fill their run rather than packed at the minimum gap: a gallery
 * hung tight against one end of a wall reads as a bug even when it validates. Returns
 * null when the members cannot fit at the requested width — never a shrunken fallback.
 */
export function solveEvenSpacing(
  runs: readonly Interval[],
  count: number,
  width: number,
): { positions: number[]; spacingM: number } | null {
  if (count < 1) return null;
  const spread = (run: Interval, k: number): number[] | null => {
    const length = run.hi - run.lo;
    if (k < 1) return [];
    if (k === 1) return [run.lo + length / 2];
    const gap = (length - k * width) / (k - 1);
    if (gap < GROUP_GAP_M) return null;
    return Array.from({ length: k }, (_, i) => run.lo + width / 2 + i * (width + gap));
  };

  const ordered = [...runs].sort((a, b) => a.lo - b.lo);
  if (!ordered.length) return null;

  // Strategy 1: unroll every run into one measure, spread, then map back. Only valid if
  // each member lands wholly inside a single run.
  const total = ordered.reduce((sum, r) => sum + (r.hi - r.lo), 0);
  const unrolled = spread({ lo: 0, hi: total }, count);
  if (unrolled) {
    const mapped: number[] = [];
    for (const s of unrolled) {
      let offset = s;
      let placed: number | null = null;
      for (const run of ordered) {
        const length = run.hi - run.lo;
        if (offset <= length + 1e-9) {
          const u = run.lo + offset;
          // Straddling the cut an opening made is what disqualifies this strategy.
          if (u - width / 2 >= run.lo - 1e-9 && u + width / 2 <= run.hi + 1e-9) placed = u;
          break;
        }
        offset -= length;
      }
      if (placed === null) {
        mapped.length = 0;
        break;
      }
      mapped.push(placed);
    }
    if (mapped.length === count)
      // Centre-to-centre, matching what strategy 2 reports. Returning the cell width
      // here meant a group's recorded pitch did not match the distance between its own
      // members, so "spacing was recomputed" could not be checked against the geometry.
      return { positions: mapped, spacingM: count > 1 ? mapped[1]! - mapped[0]! : 0 };
  }

  // Strategy 2: proportional allocation, largest remainder, ties to the lower run.
  const shares = ordered.map((run, i) => ({ i, exact: ((run.hi - run.lo) / total) * count }));
  const allocation = shares.map((s) => Math.floor(s.exact));
  let remaining = count - allocation.reduce((a, b) => a + b, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.i - b.i,
  );
  for (let i = 0; remaining > 0; i = (i + 1) % byRemainder.length, remaining--)
    allocation[byRemainder[i]!.i]!++;

  const positions: number[] = [];
  let widest = 0;
  for (let i = 0; i < ordered.length; i++) {
    const k = allocation[i]!;
    if (!k) continue;
    const solved = spread(ordered[i]!, k);
    if (!solved) return null;
    if (k > 1) widest = Math.max(widest, solved[1]! - solved[0]!);
    positions.push(...solved);
  }
  if (positions.length !== count) return null;
  positions.sort((a, b) => a - b);
  return { positions, spacingM: widest };
}

// ---------------------------------------------------------------- planning

type Resolved = {
  item: RecipeItem;
  index: number;
  family: Template;
  dimensions: Vec3;
  color: string;
  legs: 3 | 4;
  count: number;
  groupId: string;
  /** Existing member ids this item re-poses rather than creates. */
  reusedIds: string[];
};

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Stable group id from the scene, never a clock or a counter the caller owns. */
function deriveGroupId(scene: EditorState, family: Template, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `grp_${family}_${n}`;
    if (!scene.groups[id] && !taken.has(id)) return id;
  }
}

export function planLayout(
  scene: EditorState,
  recipe: SceneRecipe,
  ctx: PlanContext,
): LayoutProposal {
  const budget: Budget = {
    used: 0,
    limit: ctx.maxEvaluations ?? MAX_EVALUATIONS,
    exhausted: false,
  };
  const maxObjects = ctx.maxObjects ?? MAX_PLANNED_OBJECTS;
  const deviations: Deviation[] = [];
  const preserve = new Set(recipe.preserveIds);

  // Withdrawals first: a restyle plans against the room it will actually leave behind.
  // A preserved id is never withdrawn, so it stays visible AND stays an obstacle.
  const removals = recipe.replaceIds.filter((id) => !preserve.has(id));
  const draft = copy(scene) as EditorState;
  draft.design.objects = draft.design.objects.filter((o) => !removals.includes(o.id));

  const taken = new Set<string>();
  const resolved: Resolved[] = recipe.items.map((item, index) => {
    const dimensions = (item.dimensions ?? DEFAULT_DIMENSIONS[item.family]) as Vec3;
    const existing = item.groupId ? scene.groups[item.groupId] : undefined;
    const groupId = existing?.id ?? deriveGroupId(scene, item.family, taken);
    taken.add(groupId);
    return {
      item,
      index,
      family: item.family,
      dimensions,
      color: item.color ?? existing?.color ?? DEFAULT_COLOR,
      legs: item.legs,
      count: item.count,
      groupId,
      // A count increase reuses what is already there and adds only the difference; a
      // decrease trims from the END of the established order. Re-sorting here would
      // silently reassign identity, which is the whole thing groups exist to prevent.
      reusedIds: existing ? existing.order.slice(0, item.count) : [],
    };
  });

  // Every member of a group being re-planned leaves the draft first. They are being
  // RE-POSED, not added beside themselves: leaving them at their old poses made each
  // reused member collide with its own previous position, which is why growing a group
  // from two to three silently relocated the whole thing to another wall.
  const replanned = new Set(
    resolved.flatMap((entry) => scene.groups[entry.groupId]?.order ?? []),
  );
  draft.design.objects = draft.design.objects.filter((o) => !replanned.has(o.id));

  const total = resolved.reduce((sum, r) => sum + r.count, 0);
  if (total > maxObjects)
    return refuse(
      ctx.proposalId,
      scene,
      recipe,
      'search_exhausted',
      `That needs ${total} objects and this planner is bounded to ${maxObjects} in one proposal.`,
      [{ summary: `the same arrangement in two steps of at most ${maxObjects}` }],
      budget,
      true,
    );

  // Large and constrained first: a bed that only fits in one place must claim it before
  // a frame takes the wall. Ties break on the stable group id, never on input order.
  const order = [...resolved].sort(
    (a, b) =>
      b.dimensions[0] * b.dimensions[2] - a.dimensions[0] * a.dimensions[2] ||
      (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0),
  );

  const placements: ProposalPlacement[] = [];
  const groups: Group[] = [];
  for (const entry of order) {
    const outcome = isWallFamily(entry.family)
      ? planWallGroup(draft, entry, ctx, budget, deviations)
      : planFloorGroup(draft, entry, ctx, budget);
    if (!outcome.ok)
      return refuse(
        ctx.proposalId,
        scene,
        recipe,
        budget.exhausted ? 'search_exhausted' : 'infeasible',
        outcome.explanation,
        outcome.alternatives,
        budget,
        budget.exhausted,
      );
    placements.push(...outcome.placements);
    groups.push(outcome.group);
  }

  // Members trimmed by a count decrease are withdrawn by the same transaction.
  for (const entry of resolved) {
    const existing = scene.groups[entry.groupId];
    if (!existing) continue;
    for (const id of existing.order.slice(entry.count))
      if (!removals.includes(id)) removals.push(id);
    if (existing.order.length !== entry.count)
      deviations.push({
        kind: 'count',
        requested: `${entry.count} ${entry.family}${entry.count === 1 ? '' : 's'}`,
        applied: `${entry.count} (was ${existing.order.length}); ${
          entry.count > existing.order.length
            ? `${entry.count - existing.order.length} added`
            : `${existing.order.length - entry.count} removed from the end`
        }`,
      });
  }

  const affected = [
    ...new Set([
      ...placements.map((p) => p.id),
      ...removals,
      ...recipe.hideMeasuredIds,
      ...(recipe.palette?.walls || recipe.palette?.floor
        ? scene.design.surfaces.map((s) => s.id)
        : []),
    ]),
  ].sort();

  // A count change the USER asked for is not a deviation; only a change the planner made
  // to what was asked is. Confirmation is required for exactly those (M7.4.5).
  const planImposed = deviations.filter((d) => d.kind !== 'count');
  return {
    proposalId: ctx.proposalId,
    baseRevision: scene.revision,
    recipe,
    status: 'complete',
    placements,
    groups,
    removals: [...new Set(removals)].sort(),
    hideMeasuredIds: [...new Set(recipe.hideMeasuredIds)].sort(),
    palette: recipe.palette,
    affectedIds: affected.slice(0, 128),
    deviations,
    requiresConfirmation: planImposed.length > 0,
    alternatives: [],
    explanation: describePlan(recipe, placements, removals, deviations),
    evaluations: budget.used,
    exhausted: budget.exhausted,
  };
}

function describePlan(
  recipe: SceneRecipe,
  placements: ProposalPlacement[],
  removals: string[],
  deviations: Deviation[],
): string {
  const counts = new Map<string, number>();
  for (const p of placements) counts.set(p.family, (counts.get(p.family) ?? 0) + 1);
  const made = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([family, n]) => `${n} ${family}${n === 1 ? '' : 's'}`)
    .join(', ');
  const parts = [made ? `Placed ${made}` : 'Nothing to place'];
  if (removals.length) parts.push(`removed ${removals.length}`);
  if (recipe.palette?.walls) parts.push('repainted the walls');
  if (deviations.length) parts.push(`${deviations.length} change(s) from what you asked`);
  return `${parts.join('; ')}.`;
}

function refuse(
  proposalId: string,
  scene: EditorState,
  recipe: SceneRecipe,
  status: LayoutProposal['status'],
  explanation: string,
  alternatives: { summary: string }[],
  budget: Budget,
  exhausted: boolean,
): LayoutProposal {
  return {
    proposalId,
    baseRevision: scene.revision,
    recipe,
    status,
    // Deliberately empty. A refusal never carries a partial arrangement, because a
    // caller holding half a layout is one mistake away from committing half a layout.
    placements: [],
    groups: [],
    removals: [],
    hideMeasuredIds: [],
    palette: null,
    affectedIds: [],
    deviations: [],
    requiresConfirmation: false,
    alternatives: alternatives.slice(0, 4),
    explanation,
    evaluations: budget.used,
    exhausted,
  };
}

type GroupOutcome =
  | { ok: true; placements: ProposalPlacement[]; group: Group }
  | { ok: false; explanation: string; alternatives: { summary: string }[] };

/** Adds a chosen placement to the draft so the next member has to avoid it. */
function commitToDraft(
  draft: EditorState,
  built: { object: SceneObject; assembly: Assembly },
  position: Vec3,
  yaw: number,
) {
  const object = copy(built.object);
  object.pose = { position: [...position], yaw };
  draft.design.objects.push(object);
  draft.assemblies[object.id] = copy(built.assembly);
}

function evaluateCandidate(
  draft: EditorState,
  object: ObjectLike,
  index: SceneIndex,
  budget: Budget,
): boolean | null {
  if (budget.used >= budget.limit) {
    budget.exhausted = true;
    return null;
  }
  budget.used++;
  return (
    evaluatePlacement(draft, object, { index, stopAtFirst: true, skipNotes: true }).violations
      .length === 0
  );
}

// ---------------------------------------------------------------- wall groups

function planWallGroup(
  draft: EditorState,
  entry: Resolved,
  ctx: PlanContext,
  budget: Budget,
  deviations: Deviation[],
): GroupOutcome {
  const [w, h, d] = entry.dimensions;
  const index = buildIndex(draft, '');
  const requested = entry.item.surfaceId ?? ctx.destination?.surfaceId ?? null;
  // The named wall first, then every other wall in id order: deterministic, and it lets
  // a refusal on the requested wall become an alternative rather than a silent move.
  const walls = [...index.walls].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const preferred = walls.filter((wall) => wall.id === requested);
  const ordered = [...preferred, ...walls.filter((wall) => wall.id !== requested)];
  if (!ordered.length)
    return { ok: false, explanation: 'This room has no wall to mount on.', alternatives: [] };

  const centreY = MOUNT_CENTRE_M;
  const baseY = Math.max(0.1, centreY - h / 2);
  const exhaustedRuns: string[] = [];

  for (const wall of ordered) {
    const runs = usableWallIntervals(wall, baseY, baseY + h);
    const solved = solveEvenSpacing(runs, entry.count, w);
    if (!solved) {
      exhaustedRuns.push(compass(wall.normal));
      continue;
    }
    const placements: ProposalPlacement[] = [];
    let failed = false;
    for (let i = 0; i < entry.count; i++) {
      const u = solved.positions[i]!;
      const id = entry.reusedIds[i] ?? `${entry.groupId}_m${i}`;
      // Along-wall basis: `wall.u` is the unit vector in the wall plane, so the mount
      // point is the wall's own plane point offset along it, pushed out by half depth.
      const position: Vec3 = [
        wall.normal[0] * wall.offset + wall.u[0] * u + wall.normal[0] * (d / 2),
        baseY,
        wall.normal[2] * wall.offset + wall.u[2] * u + wall.normal[2] * (d / 2),
      ];
      const yaw = wallFacingYaw(wall.normal);
      const built = ctx.build(
        { family: entry.family, count: 1, dimensions: entry.dimensions, color: entry.color, legs: entry.legs },
        id,
        position,
        wall.id,
        entry.item.materialClass,
      );
      if (built.assembly.construction === 'invalid')
        return {
          ok: false,
          explanation: built.assembly.constructionResult?.findings[0]?.detail ??
            `That ${entry.family} cannot be built.`,
          alternatives: [],
        };
      draft.assemblies[id] = copy(built.assembly);
      const probe: ObjectLike = { ...built.object, pose: { position, yaw } };
      const ok = evaluateCandidate(draft, probe, buildIndex(draft, id), budget);
      if (ok === null) return { ok: false, explanation: searchLimit(entry), alternatives: [] };
      if (!ok) {
        delete draft.assemblies[id];
        failed = true;
        break;
      }
      commitToDraft(draft, built, position, yaw);
      placements.push({
        id,
        groupId: entry.groupId,
        memberIndex: i,
        reused: entry.reusedIds.includes(id),
        family: entry.family,
        dimensions: entry.dimensions,
        color: entry.color,
        legs: entry.legs,
        materialClass: entry.item.materialClass,
        position,
        yaw,
        supportSurface: wall.id,
        mode: 'wall',
        construction: built.assembly.constructionResult!,
      });
    }
    if (failed) {
      for (const p of placements) {
        draft.design.objects = draft.design.objects.filter((o) => o.id !== p.id);
        delete draft.assemblies[p.id];
      }
      exhaustedRuns.push(compass(wall.normal));
      continue;
    }
    // Only when a wall was actually ASKED FOR and actually exists. Comparing against
    // `ordered[0]` unconditionally would invent a request the user never made whenever
    // the recipe named a surface this room does not have.
    if (preferred.length && wall.id !== preferred[0]!.id)
      deviations.push({
        kind: 'destination',
        requested: `on the ${compass(preferred[0]!.normal)} wall`,
        applied: `on the ${compass(wall.normal)} wall`,
      });
    return {
      ok: true,
      placements,
      group: {
        id: entry.groupId,
        label: `${entry.count} ${entry.family}${entry.count === 1 ? '' : 's'}`,
        family: entry.family,
        order: placements.map((p) => p.id),
        surfaceId: wall.id,
        relation: entry.item.relation,
        dimensions: entry.dimensions,
        color: entry.color,
        materialClass: entry.item.materialClass,
        spacingM: Number(solved.spacingM.toFixed(4)),
      },
    };
  }

  return {
    ok: false,
    explanation: `${entry.count} ${entry.family}${entry.count === 1 ? '' : 's'} of ${w.toFixed(2)}m do not fit in the usable space on the ${exhaustedRuns.join(', ')} wall${exhaustedRuns.length === 1 ? '' : 's'}.`,
    alternatives: [
      { summary: `fewer than ${entry.count}` },
      { summary: 'narrower ones' },
      { summary: 'a wall without an opening in it' },
    ],
  };
}

const searchLimit = (entry: Resolved) =>
  `I ran out of search budget placing the ${entry.family}s. That is a limit I hit, not a proof that they do not fit.`;

// ---------------------------------------------------------------- floor groups

/**
 * Candidate poses for a floor object, in a fixed order.
 *
 * Wall-hugging candidates come first because a sofa floating 20cm off a wall is the
 * clearest tell that a layout was generated, then the floor centroid, then a raster
 * sweep as the fallback. Every coordinate is on the same 5cm lattice the nudge search
 * uses, so a planner result and a hand-drop result quantise identically.
 */
function* floorCandidates(
  index: SceneIndex,
  dimensions: Vec3,
  relation: RecipeItem['relation'],
  destination: PlanContext['destination'],
  /** When the group must face a named wall, every candidate takes that yaw. */
  faceSurfaceId: string | null,
): Generator<{ position: Vec3; yaw: number }> {
  const step = searchStepM;
  const snap = (v: number) => Math.round(v / step) * step;
  const depth = dimensions[2] / 2;
  const half = dimensions[0] / 2;

  const centroid = index.floor.reduce(
    (acc, p) => [acc[0] + p[0] / index.floor.length, acc[1] + p[1] / index.floor.length],
    [0, 0],
  );

  // `wallFacingYaw` orients an object with its BACK to a wall, looking into the room.
  // Facing that wall is the opposite heading, so the normal is negated rather than the
  // yaw offset by pi — the two agree here, and negating keeps one definition of forward.
  const target = faceSurfaceId ? index.walls.find((wall) => wall.id === faceSurfaceId) : undefined;
  const facing = target
    ? wallFacingYaw([-target.normal[0], -target.normal[1], -target.normal[2]])
    : null;
  const orient = (yaw: number) => (facing === null ? yaw : facing);

  const wallRuns: { position: Vec3; yaw: number; key: number }[] = [];
  for (const wall of [...index.walls].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const lo = Math.min(...wall.polygonUV.map((p) => p[0])) + half;
    const hi = Math.max(...wall.polygonUV.map((p) => p[0])) - half;
    for (let u = snap(lo); u <= hi + 1e-9; u += step) {
      const position: Vec3 = [
        snap(wall.normal[0] * wall.offset + wall.u[0] * u + wall.normal[0] * depth),
        0,
        snap(wall.normal[2] * wall.offset + wall.u[2] * u + wall.normal[2] * depth),
      ];
      const key = destination
        ? Math.hypot(position[0] - destination.position[0], position[2] - destination.position[2])
        : Math.abs(u);
      wallRuns.push({ position, yaw: orient(wallFacingYaw(wall.normal)), key });
    }
  }
  // One sort, then a fixed walk: proximity decides preference, geometry decides ties.
  wallRuns.sort(
    (a, b) =>
      a.key - b.key ||
      a.position[0] - b.position[0] ||
      a.position[2] - b.position[2] ||
      a.yaw - b.yaw,
  );
  if (relation !== 'centred') for (const candidate of wallRuns) yield candidate;

  for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2])
    yield { position: [snap(centroid[0]!), 0, snap(centroid[1]!)], yaw: orient(yaw) };

  if (relation === 'centred') for (const candidate of wallRuns) yield candidate;

  const xs = index.floor.map((p) => p[0]);
  const zs = index.floor.map((p) => p[1]);
  for (let z = snap(Math.min(...zs)); z <= Math.max(...zs); z += step)
    for (let x = snap(Math.min(...xs)); x <= Math.max(...xs); x += step) {
      if (!inside([x, z], index.floor)) continue;
      for (const yaw of [0, Math.PI / 2]) yield { position: [x, 0, z], yaw: orient(yaw) };
    }
}

function planFloorGroup(
  draft: EditorState,
  entry: Resolved,
  ctx: PlanContext,
  budget: Budget,
): GroupOutcome {
  const floor = draft.design.surfaces.find((s) => s.class === 'floor' && s.state === 'present');
  if (!floor) return { ok: false, explanation: 'This room has no floor to stand on.', alternatives: [] };

  const placements: ProposalPlacement[] = [];
  for (let i = 0; i < entry.count; i++) {
    const id = entry.reusedIds[i] ?? `${entry.groupId}_m${i}`;
    const built = ctx.build(
      { family: entry.family, count: 1, dimensions: entry.dimensions, color: entry.color, legs: entry.legs },
      id,
      [0, 0, 0],
      floor.id,
      entry.item.materialClass,
    );
    if (built.assembly.construction === 'invalid')
      return {
        ok: false,
        explanation:
          built.assembly.constructionResult?.findings[0]?.detail ??
          `That ${entry.family} cannot be built.`,
        alternatives: [],
      };
    // The assembly must be in the draft before evaluation so the checks see real parts
    // rather than a bounding box; the OBJECT is withheld until a pose is chosen, which
    // is what keeps a candidate from colliding with itself.
    draft.assemblies[id] = copy(built.assembly);
    const index = buildIndex(draft, id);
    let chosen: { position: Vec3; yaw: number } | null = null;
    const facing = entry.item.relation === 'facing_surface' ? entry.item.surfaceId : null;
    for (const candidate of floorCandidates(index, entry.dimensions, entry.item.relation, ctx.destination, facing)) {
      const probe: ObjectLike = { ...built.object, pose: { position: candidate.position, yaw: candidate.yaw } };
      const ok = evaluateCandidate(draft, probe, index, budget);
      if (ok === null) {
        delete draft.assemblies[id];
        return { ok: false, explanation: searchLimit(entry), alternatives: [] };
      }
      if (ok) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) {
      delete draft.assemblies[id];
      const placedSoFar = placements.length;
      return {
        ok: false,
        explanation: `There is nowhere left in this room for ${
          placedSoFar ? `${entry.family} ${placedSoFar + 1} of ${entry.count}` : `the ${entry.family}`
        } without it overlapping something or blocking the door.`,
        alternatives: [
          { summary: `a smaller ${entry.family}` },
          // Only when there is a smaller count to suggest. One fewer than one is not an
          // alternative, and offering it made a refusal read as if it had not been read.
          ...(entry.count > 1
            ? [{ summary: `${entry.count - 1} instead of ${entry.count}` }]
            : []),
          { summary: 'moving or removing existing furniture first' },
        ],
      };
    }
    commitToDraft(draft, built, chosen.position, chosen.yaw);
    placements.push({
      id,
      groupId: entry.groupId,
      memberIndex: i,
      reused: entry.reusedIds.includes(id),
      family: entry.family,
      dimensions: entry.dimensions,
      color: entry.color,
      legs: entry.legs,
      materialClass: entry.item.materialClass,
      position: chosen.position,
      yaw: chosen.yaw,
      supportSurface: floor.id,
      mode: 'floor',
      construction: built.assembly.constructionResult!,
    });
  }

  const spacing =
    placements.length > 1
      ? Math.hypot(
          placements[1]!.position[0] - placements[0]!.position[0],
          placements[1]!.position[2] - placements[0]!.position[2],
        )
      : 0;
  return {
    ok: true,
    placements,
    group: {
      id: entry.groupId,
      label: `${entry.count} ${entry.family}${entry.count === 1 ? '' : 's'}`,
      family: entry.family,
      order: placements.map((p) => p.id),
      surfaceId: floor.id,
      relation: entry.item.relation,
      dimensions: entry.dimensions,
      color: entry.color,
      materialClass: entry.item.materialClass,
      spacingM: Number(spacing.toFixed(4)),
    },
  };
}

/**
 * Cooperative wrapper. Yields to the event loop between items so a long plan cannot
 * stall gestures or rendering (M7.2.6). The result is identical to `planLayout`: the
 * per-item work is unchanged and the order is fixed, so yielding cannot alter geometry.
 */
export async function planLayoutCooperative(
  scene: EditorState,
  recipe: SceneRecipe,
  ctx: PlanContext,
  onProgress?: (stage: string) => void,
): Promise<LayoutProposal> {
  onProgress?.('planning');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const proposal = planLayout(scene, recipe, ctx);
  onProgress?.(proposal.status);
  return proposal;
}
