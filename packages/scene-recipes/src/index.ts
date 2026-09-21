import {
  RecipeSchema,
  type Recipe,
  type Assembly,
  type Bearing,
  type Connection,
  type MaterialClass,
  type Part,
  type SceneObject,
  type Vec3,
} from '@reality/contracts';
import { validateConstruction } from './construction';
import { ENVELOPES, TEMPLATE_VERSIONS, assumptionsFor, loadCasesFor } from './templates';

export * from './templates';
export * from './construction';

/**
 * Controlled assembly builders, shared by renderer and collision queries.
 *
 * Since M7 every assembly also carries the authored construction metadata the validator
 * needs — template version, structural material, part joins, ground-contact polygon and
 * declared load cases — so a construction result can be RE-DERIVED after a later resize
 * or support change rather than being frozen at build time.
 */
export function buildObject(
  input: Recipe,
  id: string,
  position: Vec3,
  supportSurface: string,
  /** Structural class. Independent of `recipe.color`, which is cosmetic only. */
  materialClass: MaterialClass = 'engineered_panel',
  /**
   * How this object is held up, overriding what the family would imply.
   *
   * The family is a good default and a poor rule: `frame` normally hangs, but a painting
   * propped on the floor and a television resting on a cabinet are both ordinary things
   * to ask for. When the caller states the support explicitly, that is the answer.
   */
  mode?: 'floor' | 'wall' | 'object',
): { object: SceneObject; assembly: Assembly } {
  const recipe = RecipeSchema.parse(input);
  const [w, h, d] = recipe.dimensions;
  const parts: Part[] = [];
  const connections: Connection[] = [];
  const add = (name: string, center: Vec3, size: Vec3, structural = true) =>
    parts.push({ id: name, center, size, color: recipe.color, structural });
  const join = (from: string, to: string, kind: Connection['kind']) =>
    connections.push({ from, to, kind });
  const supports: [number, number][] = [];
  const mounted = mode ? mode === 'wall' : recipe.family === 'frame' || recipe.family === 'shelf';
  if (recipe.family === 'bed' || recipe.family === 'table') {
    const top = Math.min(h * 0.25, recipe.family === 'bed' ? 0.2 : 0.08);
    const leg = Math.min(w, d) * 0.1;
    const x = (w - leg) / 2,
      z = (d - leg) / 2;
    // The three-support layout is authored ONLY where a template exists for it. The
    // validator refuses the families that have none; it is never a deleted leg.
    const points: [number, number][] =
      recipe.legs === 3
        ? [
            [-x, z],
            [x, z],
            [0, -z],
          ]
        : [
            [-x, -z],
            [x, -z],
            [x, z],
            [-x, z],
          ];
    add('top', [0, h - top / 2, 0], [w, top, d]);
    points.forEach(([px, pz], i) => {
      add(`leg-${i}`, [px, (h - top) / 2, pz], [leg, h - top, leg]);
      join(`leg-${i}`, 'top', 'bears_on');
      supports.push([px, pz]);
    });
  } else if (recipe.family === 'cabinet') {
    const t = Math.min(w, h, d) * 0.08;
    add('left', [-(w - t) / 2, h / 2, 0], [t, h, d]);
    add('right', [(w - t) / 2, h / 2, 0], [t, h, d]);
    add('base', [0, t / 2, 0], [w, t, d]);
    add('top', [0, h - t / 2, 0], [w, t, d]);
    add('back', [0, h / 2, -(d - t) / 2], [w, h, t]);
    join('base', 'left', 'bears_on');
    join('base', 'right', 'bears_on');
    join('top', 'left', 'spans');
    join('top', 'right', 'spans');
    join('back', 'left', 'fixed_to');
    join('back', 'right', 'fixed_to');
    supports.push([-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]);
  } else if (recipe.family === 'frame') {
    const t = Math.min(w, h) * 0.08;
    add('left', [-(w - t) / 2, h / 2, 0], [t, h, d]);
    add('right', [(w - t) / 2, h / 2, 0], [t, h, d]);
    add('top', [0, h - t / 2, 0], [w, t, d]);
    add('bottom', [0, t / 2, 0], [w, t, d]);
    // The print is glazing, not structure. Marking it structural made the thinnest-member
    // check measure the picture rather than the moulding and fail every frame.
    add('print', [0, h / 2, 0], [w - t * 2, h - t * 2, d / 3], false);
    join('top', 'left', 'spans');
    join('top', 'right', 'spans');
    join('bottom', 'left', 'spans');
    join('bottom', 'right', 'spans');
    join('print', 'left', 'fixed_to');
  } else {
    add('shelf', [0, h / 2, 0], [w, h, d]);
  }
  // A bed is not a shelf. Only templates with a usable flat top carry load.
  const bearing: Bearing | null =
    recipe.family === 'bed' || recipe.family === 'frame'
      ? null
      : (() => {
          const inset = Math.min(0.02, Math.min(w, d) * 0.05);
          const hw = Math.max(0.01, w / 2 - inset);
          const hd = Math.max(0.01, d / 2 - inset);
          return {
            polygon: [
              [-hw, -hd],
              [hw, -hd],
              [hw, hd],
              [-hw, hd],
            ],
            y: h,
          };
        })();

  const loadCases = loadCasesFor(recipe.family, recipe.dimensions);
  const constructionResult = validateConstruction({
    family: recipe.family,
    dimensions: recipe.dimensions,
    legs: ENVELOPES[recipe.family].supportCounts.includes(0) ? 0 : recipe.legs,
    materialClass,
    parts,
    connections,
    supports,
    loadCases,
    supportResolved: supportSurface.length > 0,
  });

  return {
    object: {
      id,
      class: recipe.family === 'cabinet' ? 'storage' : recipe.family,
      refined_class: recipe.family,
      dimensions: [w, h, d],
      pose: { position, yaw: 0 },
      pivot: 'base_center',
      asset_ref: null,
      material_ref: recipe.color,
      movable: true,
      provenance: 'virtual',
      salience: 0.5,
      state: 'present',
    },
    assembly: {
      template: recipe.family,
      parts,
      supports,
      mounting: mounted ? 'wall' : 'floor',
      supportSurface,
      support: {
        mode: mode ?? (mounted ? 'wall' : 'floor'),
        surfaceId: supportSurface,
        bearing,
        mountHeight: mounted ? (position[1] ?? null) : null,
      },
      construction: coarseConstruction(constructionResult.status),
      assumptions: assumptionsFor(recipe.family, materialClass),
      templateVersion: TEMPLATE_VERSIONS[recipe.family],
      materialClass,
      connections,
      supportPolygon: supports,
      loadCases,
      constructionResult,
    },
  };
}

/**
 * Folds an M7 status into the three-value flag the engine already gates on.
 *
 * Only `invalid` blocks a commit, and only `unsupported` maps to it: an unauthored
 * variant cannot be built, while a needs-adjustment result is a real object with a real
 * caveat and must still be placeable. Keeping the coarse field in step means no existing
 * caller had to learn the new vocabulary to stay correct.
 */
export function coarseConstruction(
  status: import('@reality/contracts').ConstructionStatus,
): Assembly['construction'] {
  if (status === 'unsupported') return 'invalid';
  if (status === 'valid-within-template') return 'plausible';
  return 'unknown';
}
