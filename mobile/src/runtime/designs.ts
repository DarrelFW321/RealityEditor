import type { MaterialClass, Template } from '@reality/contracts';

/**
 * Five hard-coded room designs, one per recognisable style.
 *
 * A design is a shopping list with placement and finish, and nothing else — no
 * coordinates and no sizes. Where each piece ends up is still the solver's answer against
 * the measured room, so one design produces a different arrangement in a different room
 * and is never wrong about clearances.
 *
 * MIXED ON PURPOSE. `catalogId` draws a real mesh; `family` is one of the five authored
 * templates and needs no catalog at all. Every item carries both, so a design degrades to
 * coloured boxes rather than failing when the catalog is unreachable or incomplete.
 *
 * COLOUR IS PART OF THE DESIGN, not decoration on top of it. `colour` is cosmetic and
 * taken from the material manifest's swatches, so a design reads as its style even when
 * every mesh falls back to a box. `materialClass` is STRUCTURAL and independent — it tells
 * the construction gate what the thing is made of, and a wrong value there is a load
 * rating nobody measured, not a wrong shade.
 *
 * PLACED MAXIMALLY, not atomically. The runner tries every item and keeps whatever fits,
 * because "add as much as will go" is the goal: a small room should get a partial living
 * room rather than nothing. It is also the only order in which stacking can work — the
 * cabinet has to be really in the room before the television can rest on it.
 */
export type DesignItem = {
  /** Local handle, so a later item can name this one as its support. */
  key: string;
  /** Preferred: a real mesh from the catalog. */
  catalogId?: string;
  /** Used when no catalog object suits, or the catalog is unavailable. */
  family?: Template;
  /** How many to place in this run. Defaults to 1. */
  count?: number;
  /**
   * Ceiling on how many of this thing may exist in the room, counting what is ALREADY
   * there. One television; three plants. Without it, running a design twice furnishes
   * the room twice, and "maximal" would mean a wall of televisions.
   */
  max?: number;
  /**
   * Lower goes first. Placement is best-effort against a filling room, so this is what
   * decides who gets the space: the sofa before the plant. Ties keep declaration order,
   * and a support is always placed before whatever rests on it regardless of priority.
   */
  priority?: number;
  /** `object` rests it on one of `on`, which must be keys of OTHER items in the design. */
  support: 'floor' | 'wall' | 'object';
  /** Candidate supports, in preference order. First one actually in the room wins. */
  on?: string[];
  /**
   * Where to go when the first choice cannot be had — no wall in the room, or every
   * candidate support failed to place. A television whose cabinet did not fit should
   * still end up somewhere rather than being dropped.
   */
  fallbackSupport?: 'floor' | 'wall';
  /** Cosmetic, hex. Swatches come from catalog/manifest.json's material sets. */
  colour?: string;
  /** Structural, and unrelated to `colour`. Omitted means the engineered-panel default. */
  materialClass?: MaterialClass;
};

export type Design = {
  id: string;
  /** Spoken back during narration and used as the arrangement's label. */
  label: string;
  /**
   * Walls and floor for the style. Surfaces only: no existing OBJECT is ever recoloured,
   * moved or removed by a design.
   */
  palette?: { walls?: string; floor?: string };
  items: DesignItem[];
};

// Swatches, named so a design reads as a palette rather than as hex soup.
const WARM_WHITE = '#f2ede4';
const CHALK = '#eceae5';
const PLASTER = '#bbb2a3';
const OAK_FLOOR = '#7f6042';
const OAK_LIGHT = '#a17e57';
const ASH_PALE = '#7e6240';
const WALNUT = '#423021';
const LINEN_OAT = '#c5af98';
const BOUCLE = '#e8d3bb';
const FELT_GREY = '#797670';
const CONCRETE = '#72695a';
const METAL_DARK = '#54493d';
const LEATHER_TAN = '#512d10';
const MARBLE = '#b19d7a';
const BAMBOO = '#d2ad80';
const VELVET = '#ad2d47';

/**
 * Ordered by importance within each design, because placement is best-effort and the room
 * fills up. The first item should be the one whose absence would read as unfurnished.
 */
export const DESIGNS: Design[] = [
  {
    id: 'scandinavian',
    label: 'a Scandinavian living room',
    palette: { walls: CHALK, floor: ASH_PALE },
    items: [
      { key: 'sofa', priority: 1, max: 1, catalogId: 'three-seat-sofa', family: 'bed', support: 'floor', colour: BOUCLE },
      { key: 'stand', priority: 2, max: 1, catalogId: 'two-door-cabinet', family: 'cabinet', support: 'floor', colour: OAK_LIGHT, materialClass: 'hardwood' },
      { key: 'shelving', priority: 3, max: 1, catalogId: 'tall-shelving-unit', family: 'cabinet', support: 'floor', colour: ASH_PALE, materialClass: 'hardwood' },
      // One television, and it will take any horizontal surface this design placed.
      { key: 'tv', priority: 4, max: 1, catalogId: 'television-on-stand', family: 'cabinet', support: 'object', on: ['stand', 'shelving', 'coffee'], fallbackSupport: 'floor', colour: METAL_DARK, materialClass: 'steel' },
      { key: 'coffee', priority: 5, max: 1, catalogId: 'round-coffee-table', family: 'table', support: 'floor', colour: OAK_LIGHT, materialClass: 'hardwood' },
      { key: 'lamp', priority: 6, max: 2, catalogId: 'tripod-floor-lamp', family: 'cabinet', support: 'floor', colour: LINEN_OAT },
      { key: 'art', priority: 7, max: 2, catalogId: 'framed-painting', family: 'frame', support: 'wall', colour: WARM_WHITE },
      { key: 'plant', priority: 8, max: 3, count: 2, catalogId: 'potted-plant', family: 'cabinet', support: 'floor', colour: WARM_WHITE },
    ],
  },
  {
    id: 'midcentury',
    label: 'a mid-century modern living room',
    palette: { walls: WARM_WHITE, floor: OAK_FLOOR },
    items: [
      { key: 'sofa', priority: 1, max: 1, catalogId: 'three-seat-sofa', family: 'bed', support: 'floor', colour: VELVET },
      { key: 'sideboard', priority: 2, max: 1, catalogId: 'two-door-cabinet', family: 'cabinet', support: 'floor', colour: WALNUT, materialClass: 'hardwood' },
      { key: 'tv', priority: 3, max: 1, catalogId: 'television-on-stand', family: 'cabinet', support: 'object', on: ['sideboard', 'coffee'], fallbackSupport: 'floor', colour: METAL_DARK, materialClass: 'steel' },
      { key: 'armchair', priority: 4, max: 2, catalogId: 'linen-armchair', family: 'bed', support: 'floor', colour: LEATHER_TAN },
      { key: 'coffee', priority: 5, max: 1, catalogId: 'round-coffee-table', family: 'table', support: 'floor', colour: WALNUT, materialClass: 'hardwood' },
      { key: 'lamp', priority: 6, max: 2, catalogId: 'tripod-floor-lamp', family: 'cabinet', support: 'floor', colour: OAK_LIGHT },
      { key: 'art', priority: 7, max: 2, catalogId: 'framed-painting', family: 'frame', support: 'wall', colour: WALNUT },
    ],
  },
  {
    id: 'japandi',
    label: 'a Japandi room',
    palette: { walls: WARM_WHITE, floor: BAMBOO },
    items: [
      { key: 'bed', priority: 1, max: 1, catalogId: 'platform-bed', family: 'bed', support: 'floor', colour: LINEN_OAT },
      { key: 'night', priority: 2, max: 2, catalogId: 'two-drawer-nightstand', family: 'cabinet', support: 'floor', colour: BAMBOO, materialClass: 'hardwood' },
      { key: 'low', priority: 3, max: 1, catalogId: 'low-bookshelf', family: 'cabinet', support: 'floor', colour: ASH_PALE, materialClass: 'hardwood' },
      { key: 'vase', priority: 4, max: 2, catalogId: 'tall-ceramic-vase', family: 'cabinet', support: 'object', on: ['night', 'low'], fallbackSupport: 'floor', colour: PLASTER },
      { key: 'chair', priority: 5, max: 1, catalogId: 'linen-armchair', family: 'bed', support: 'floor', colour: LINEN_OAT },
      { key: 'mirror', priority: 6, max: 1, catalogId: 'wall-mirror', family: 'frame', support: 'wall', colour: BAMBOO },
      { key: 'plant', priority: 7, max: 3, count: 2, catalogId: 'potted-plant', family: 'cabinet', support: 'floor', colour: FELT_GREY },
    ],
  },
  {
    id: 'industrial',
    label: 'an industrial loft',
    palette: { walls: CONCRETE, floor: METAL_DARK },
    items: [
      { key: 'sofa', priority: 1, max: 1, catalogId: 'three-seat-sofa', family: 'bed', support: 'floor', colour: LEATHER_TAN },
      { key: 'shelving', priority: 2, max: 2, catalogId: 'tall-shelving-unit', family: 'cabinet', support: 'floor', colour: METAL_DARK, materialClass: 'steel' },
      { key: 'desk', priority: 3, max: 1, catalogId: 'writing-desk', family: 'table', support: 'floor', colour: METAL_DARK, materialClass: 'steel' },
      { key: 'monitor', priority: 4, max: 1, catalogId: 'desk-monitor', family: 'cabinet', support: 'object', on: ['desk', 'shelving'], fallbackSupport: 'floor', colour: METAL_DARK, materialClass: 'steel' },
      { key: 'statue', priority: 5, max: 1, catalogId: 'stone-statue', family: 'cabinet', support: 'object', on: ['shelving', 'desk'], fallbackSupport: 'floor', colour: CONCRETE },
      { key: 'chair', priority: 6, max: 1, catalogId: 'task-chair', family: 'table', support: 'floor', colour: FELT_GREY, materialClass: 'steel' },
      { key: 'lamp', priority: 7, max: 2, catalogId: 'tripod-floor-lamp', family: 'cabinet', support: 'floor', colour: METAL_DARK, materialClass: 'steel' },
    ],
  },
  {
    id: 'minimal',
    label: 'a minimal room',
    palette: { walls: CHALK, floor: MARBLE },
    items: [
      { key: 'table', priority: 1, max: 1, catalogId: 'rectangular-dining-table', family: 'table', support: 'floor', colour: MARBLE, materialClass: 'hardwood' },
      { key: 'chairs', priority: 2, max: 4, count: 2, catalogId: 'oak-dining-chair', family: 'table', support: 'floor', colour: CHALK, materialClass: 'hardwood' },
      { key: 'sideboard', priority: 3, max: 1, catalogId: 'two-door-cabinet', family: 'cabinet', support: 'floor', colour: CHALK, materialClass: 'engineered_panel' },
      { key: 'vase', priority: 4, max: 1, catalogId: 'tall-ceramic-vase', family: 'cabinet', support: 'object', on: ['sideboard', 'table'], fallbackSupport: 'floor', colour: PLASTER },
      { key: 'mirror', priority: 5, max: 1, catalogId: 'wall-mirror', family: 'frame', support: 'wall', colour: CHALK },
      { key: 'plant', priority: 6, max: 2, catalogId: 'potted-plant', family: 'cabinet', support: 'floor', colour: FELT_GREY },
    ],
  },
];

/**
 * Placement order: priority first, then declaration order — except that a support is
 * always emitted before anything that rests on it. Priority decides who gets the space in
 * a room that is filling up; the dependency rule is not negotiable, because a thing cannot
 * be put on something that is not there yet.
 */
export function orderedItems(design: Design): DesignItem[] {
  const byKey = new Map(design.items.map((i) => [i.key, i]));
  const ranked = design.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.priority ?? 50) - (b.item.priority ?? 50) || a.index - b.index)
    .map((e) => e.item);

  const out: DesignItem[] = [];
  const done = new Set<string>();
  const emit = (item: DesignItem, guard: Set<string>) => {
    if (done.has(item.key) || guard.has(item.key)) return;
    guard.add(item.key);
    // Supports first, in their own preference order.
    for (const key of item.on ?? []) {
      const support = byKey.get(key);
      if (support) emit(support, guard);
    }
    guard.delete(item.key);
    if (done.has(item.key)) return;
    done.add(item.key);
    out.push(item);
  };
  for (const item of ranked) emit(item, new Set());
  return out;
}

export const DESIGN_IDS = DESIGNS.map((d) => d.id);

export function designById(id: string | undefined | null): Design | null {
  if (!id) return null;
  return DESIGNS.find((d) => d.id === id) ?? null;
}
