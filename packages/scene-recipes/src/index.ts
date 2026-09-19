import {
  RecipeSchema,
  type Recipe,
  type Assembly,
  type Bearing,
  type Part,
  type SceneObject,
  type Vec3,
} from '@reality/contracts';

/** Controlled assembly builders, shared by renderer and collision queries. */
export function buildObject(
  input: Recipe,
  id: string,
  position: Vec3,
  supportSurface: string,
): { object: SceneObject; assembly: Assembly } {
  const recipe = RecipeSchema.parse(input);
  const [w, h, d] = recipe.dimensions;
  const parts: Part[] = [];
  const add = (name: string, center: Vec3, size: Vec3) =>
    parts.push({ id: name, center, size, color: recipe.color, structural: true });
  const supports: [number, number][] = [];
  let construction: Assembly['construction'] = 'plausible';
  const mounted = recipe.family === 'frame' || recipe.family === 'shelf';
  if (recipe.family === 'bed' || recipe.family === 'table') {
    const top = Math.min(h * 0.25, recipe.family === 'bed' ? 0.2 : 0.08);
    const leg = Math.min(w, d) * 0.1;
    const x = (w - leg) / 2,
      z = (d - leg) / 2;
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
      supports.push([px, pz]);
    });
    // Three legs require a specifically engineered load distribution. Do not
    // claim a generic rectangular bed supports edge loads on a triangular base.
    if (recipe.legs === 3 || w > 2.4 || d > 2.5 || h > 1.3 || h < 0.25) construction = 'unknown';
  } else if (recipe.family === 'cabinet') {
    const t = Math.min(w, h, d) * 0.08;
    add('left', [-(w - t) / 2, h / 2, 0], [t, h, d]);
    add('right', [(w - t) / 2, h / 2, 0], [t, h, d]);
    add('base', [0, t / 2, 0], [w, t, d]);
    add('top', [0, h - t / 2, 0], [w, t, d]);
    add('back', [0, h / 2, -(d - t) / 2], [w, h, t]);
    supports.push([-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]);
    if (h > 2 * Math.min(w, d)) construction = 'unknown';
  } else if (recipe.family === 'frame') {
    const t = Math.min(w, h) * 0.08;
    add('left', [-(w - t) / 2, h / 2, 0], [t, h, d]);
    add('right', [(w - t) / 2, h / 2, 0], [t, h, d]);
    add('top', [0, h - t / 2, 0], [w, t, d]);
    add('bottom', [0, t / 2, 0], [w, t, d]);
    add('print', [0, h / 2, 0], [w - t * 2, h - t * 2, d / 3]);
  } else {
    add('shelf', [0, h / 2, 0], [w, h, d]);
    if (w > 1.5 || d > 0.5) construction = 'unknown';
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
        mode: mounted ? 'wall' : 'floor',
        surfaceId: supportSurface,
        bearing,
        mountHeight: mounted ? (position[1] ?? null) : null,
      },
      construction,
      assumptions: [
        'Template geometry only; material strength and real load capacity are not verified.',
        ...(mounted ? ['Requires suitable real mounting hardware.'] : []),
      ],
    },
  };
}
