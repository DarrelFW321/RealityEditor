import type { LoadCase, MaterialClass, Template, Vec3 } from '@reality/contracts';

/**
 * Authored construction templates.
 *
 * Everything here is DECLARED, not derived. The numbers are authored envelopes for
 * procedural furniture, chosen to be conservative; they are not engineering tables and
 * passing them is never a claim of certified strength or verified real load capacity.
 * That sentence travels with every result as an assumption, because a status of
 * `valid-within-template` means only that — valid within this template.
 *
 * Kept separate from `index.ts` so the limits can be read, reviewed and revised without
 * reading the mesh builders, and so a template revision is a visible diff.
 */

/** Bumped when authored geometry, limits, connections or load cases change. */
export const TEMPLATE_VERSIONS: Record<Template, string> = {
  bed: '1.0.0',
  table: '1.1.0',
  cabinet: '1.0.0',
  shelf: '1.0.0',
  frame: '1.0.0',
};

/**
 * Span and thickness limits for a horizontal member carrying its declared load.
 *
 * `unknown` is deliberately absent rather than permissive: a material nobody named has
 * no authored limits, so the validator returns `unknown` instead of inventing one.
 */
export type MaterialLimits = {
  /** Longest unsupported horizontal run between two supports. */
  maxSpanM: number;
  /** Thinnest acceptable structural member. */
  minThicknessM: number;
};
export const MATERIAL_LIMITS: Partial<Record<MaterialClass, MaterialLimits>> = {
  engineered_panel: { maxSpanM: 0.9, minThicknessM: 0.018 },
  softwood: { maxSpanM: 1.2, minThicknessM: 0.02 },
  hardwood: { maxSpanM: 1.6, minThicknessM: 0.02 },
  steel: { maxSpanM: 2.4, minThicknessM: 0.003 },
  glass: { maxSpanM: 0.8, minThicknessM: 0.01 },
};

/** The overall envelope a family's authored geometry is known to behave within. */
export type Envelope = {
  widthM: [number, number];
  heightM: [number, number];
  depthM: [number, number];
  /** Support counts this family has authored geometry AND load checks for. */
  supportCounts: number[];
  /**
   * How much the family's own bracing multiplies the bare material span.
   *
   * Without this a 1.5m bed fails the 0.9m panel limit, which is true of a bare panel
   * and false of a bed: the frame carries perimeter rails and slats. The factor is the
   * authored claim about the bracing, kept explicit so it can be argued with rather
   * than buried in a fudged material number.
   */
  spanFactor: number;
};
export const ENVELOPES: Record<Template, Envelope> = {
  // Four legs only. A three-legged bed is not a deleted leg (see `supportCounts`).
  bed: { widthM: [0.7, 2.4], heightM: [0.25, 1.3], depthM: [1.2, 2.5], supportCounts: [4], spanFactor: 2.2 },
  // Three IS authored here: a tripod table is a real design, and 1.1.0 adds the
  // triangular support polygon and the edge-load case that goes with it.
  table: { widthM: [0.3, 2.4], heightM: [0.3, 1.2], depthM: [0.3, 1.2], supportCounts: [3, 4], spanFactor: 1.6 },
  cabinet: { widthM: [0.3, 2.0], heightM: [0.3, 2.2], depthM: [0.2, 0.8], supportCounts: [4], spanFactor: 1.4 },
  shelf: { widthM: [0.2, 1.5], heightM: [0.02, 0.12], depthM: [0.1, 0.5], supportCounts: [0], spanFactor: 1 },
  frame: { widthM: [0.1, 1.6], heightM: [0.1, 1.6], depthM: [0.01, 0.12], supportCounts: [0], spanFactor: 1 },
};

/**
 * The loads each family is authored to carry, in newtons at a point in local XZ metres.
 *
 * The EDGE case is the one that matters and the one a naive template omits: a bed or a
 * table is loaded at its centre in the easy case and at its rim in the real one, and it
 * is the rim case that a three-support base fails. Omitting it would let a tripod bed
 * pass a check it has no business passing.
 */
export function loadCasesFor(family: Template, [w, , d]: Vec3): LoadCase[] {
  const edgeX = Math.max(0.05, w / 2 - 0.1);
  const edgeZ = Math.max(0.05, d / 2 - 0.1);
  switch (family) {
    case 'bed':
      return [
        { id: 'centre', at: [0, 0], newtons: 1500, description: 'Two occupants, distributed.' },
        { id: 'edge', at: [0, edgeZ], newtons: 800, description: 'One person sitting on the edge.' },
      ];
    case 'table':
      return [
        { id: 'centre', at: [0, 0], newtons: 400, description: 'Distributed tabletop load.' },
        { id: 'edge', at: [edgeX, 0], newtons: 200, description: 'Leaning on one edge.' },
      ];
    case 'cabinet':
      return [
        { id: 'centre', at: [0, 0], newtons: 600, description: 'Filled carcass, distributed.' },
        { id: 'door', at: [0, -edgeZ], newtons: 250, description: 'Open door with contents.' },
      ];
    case 'shelf':
      return [{ id: 'centre', at: [0, 0], newtons: 150, description: 'Books, distributed.' }];
    default:
      // A frame carries only itself; its risk is the fixing, which is an assumption.
      return [{ id: 'self', at: [0, 0], newtons: 30, description: 'Self weight only.' }];
  }
}

/** The declared assumptions every result of this family rests on. Never empty. */
export function assumptionsFor(family: Template, materialClass: MaterialClass): string[] {
  const base = [
    'Template geometry only; material strength and real load capacity are not verified.',
    `Authored ${family} template ${TEMPLATE_VERSIONS[family]} with ${materialClass} limits.`,
  ];
  if (family === 'frame' || family === 'shelf')
    base.push('Requires suitable real mounting hardware into a load-bearing wall.');
  if (materialClass === 'unknown')
    base.push('No structural material was declared, so span and thickness were not checked.');
  return base;
}

/**
 * Which supported alternative to offer when a requested variant has no authored
 * template. Returned rather than applied: M7 never silently substitutes.
 */
export function supportedAlternative(family: Template, legs: number): string | null {
  if (family === 'bed' && legs === 3)
    return 'a four-legged bed of the same size, or a three-legged table';
  if (!ENVELOPES[family].supportCounts.includes(legs) && ENVELOPES[family].supportCounts.length)
    return `a ${ENVELOPES[family].supportCounts[0]}-support ${family}`;
  return null;
}
