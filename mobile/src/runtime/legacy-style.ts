import type { EditorState, Template } from '@reality/contracts';
import type { RecipeIntent } from './editor';

/**
 * Legacy `/plan_style` compatibility (M7.6.4).
 *
 * The server endpoint predates M7 and still speaks in planned ops with a catalogue id
 * and a placement relation. It stays exactly as it is — that is the compatibility half.
 * This is the other half: where such a plan is CONSUMED, it expands into one recipe and
 * therefore into the same planner, the same whole-arrangement validation and the same
 * atomic transaction as a voice or touch restyle.
 *
 * What it deliberately does not do is run a second conversational model. The plan is
 * treated as data that arrived from somewhere; nothing here asks anything to interpret
 * it, and every id in it is checked against the real scene before it is used.
 */

export type LegacyOp = {
  type: 'CHANGE_MATERIAL' | 'CHANGE_COLOR' | 'REPLACE_OBJECT' | 'ADD_OBJECT' | 'MOVE_OBJECT';
  target_id: string;
  material_ref?: string | null;
  color_hex?: string | null;
  catalog_id?: string | null;
  relation?: string | null;
  anchor_id?: string | null;
  rationale?: string;
};

export type LegacyPlan = { summary: string; ops: LegacyOp[] };

export type Expansion = {
  recipe: RecipeIntent;
  /**
   * Ops that could not be expressed, with the reason. Never silently dropped: an op
   * that names a family we have no template for must be reported as unsupported, not
   * approximated with a box (M7.1.5).
   */
  skipped: { op: LegacyOp; reason: string }[];
};

const FAMILIES: Template[] = ['bed', 'table', 'frame', 'shelf', 'cabinet'];
/** Words a legacy catalogue uses for the five families we actually have templates for. */
const SYNONYMS: Record<string, Template> = {
  desk: 'table',
  nightstand: 'cabinet',
  dresser: 'cabinet',
  wardrobe: 'cabinet',
  storage: 'cabinet',
  bookshelf: 'shelf',
  picture: 'frame',
  artwork: 'frame',
  mirror: 'frame',
};

/** Resolves a catalogue id or an existing object's class onto an authored family. */
export function familyOf(scene: EditorState, op: LegacyOp): Template | null {
  const haystack = `${op.catalog_id ?? ''}`.toLowerCase();
  for (const family of FAMILIES) if (haystack.includes(family)) return family;
  for (const [word, family] of Object.entries(SYNONYMS)) if (haystack.includes(word)) return family;
  const existing = scene.design.objects.find((o) => o.id === op.target_id);
  const own = `${existing?.refined_class ?? existing?.class ?? ''}`.toLowerCase();
  for (const family of FAMILIES) if (own === family) return family;
  for (const [word, family] of Object.entries(SYNONYMS)) if (own.includes(word)) return family;
  return null;
}

const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

export function expandLegacyPlan(scene: EditorState, plan: LegacyPlan): Expansion {
  const skipped: { op: LegacyOp; reason: string }[] = [];
  const items: RecipeIntent['items'] = [];
  const replaceIds: string[] = [];
  const touched = new Set<string>();
  let wallColor: string | undefined;
  let floorColor: string | undefined;
  let objectColor: string | undefined;

  const surfaceIds = new Set(
    scene.design.surfaces.filter((s) => s.state === 'present').map((s) => s.id),
  );
  const objectIds = new Set(
    scene.design.objects.filter((o) => o.state === 'present').map((o) => o.id),
  );

  for (const op of plan.ops) {
    if (op.type === 'CHANGE_COLOR') {
      if (!isHex(op.color_hex)) {
        skipped.push({ op, reason: 'no valid colour' });
        continue;
      }
      const surface = scene.design.surfaces.find((s) => s.id === op.target_id);
      if (surface?.class === 'wall') wallColor = op.color_hex;
      else if (surface?.class === 'floor') floorColor = op.color_hex;
      else if (objectIds.has(op.target_id)) {
        // The recipe's object colour is a room palette, not a per-object override. One
        // object recoloured this way would repaint the others, so it is reported rather
        // than quietly widened into something the plan did not ask for.
        if (objectColor && objectColor !== op.color_hex)
          skipped.push({ op, reason: 'conflicts with another object colour in the same plan' });
        else objectColor = op.color_hex;
      } else skipped.push({ op, reason: 'target is not in the room' });
      continue;
    }
    if (op.type === 'CHANGE_MATERIAL') {
      // Legacy material refs are catalogue strings, not structural classes. Mapping one
      // onto `materialClass` would invent a load rating from a finish name.
      skipped.push({ op, reason: 'legacy material refs carry no structural class' });
      continue;
    }
    const family = familyOf(scene, op);
    if (!family) {
      skipped.push({
        op,
        reason: `no authored template for that object; it would only be an approximation`,
      });
      continue;
    }
    if (op.type !== 'ADD_OBJECT') {
      if (!objectIds.has(op.target_id)) {
        skipped.push({ op, reason: 'target is not in the room' });
        continue;
      }
      // A move or a replace withdraws the original and re-plans one of the same family:
      // the legacy vocabulary gives a relation and never a pose, so the position has to
      // be computed here regardless.
      replaceIds.push(op.target_id);
    }
    touched.add(op.target_id);
    const existing = scene.design.objects.find((o) => o.id === op.target_id);
    items.push({
      family,
      count: 1,
      ...(op.type === 'MOVE_OBJECT' && existing
        ? { dimensions: [...existing.dimensions] as [number, number, number] }
        : {}),
      ...(isHex(existing?.material_ref) ? { color: existing!.material_ref } : {}),
      ...(op.anchor_id && surfaceIds.has(op.anchor_id) ? { surface_id: op.anchor_id } : {}),
    });
  }

  return {
    recipe: {
      label: plan.summary.slice(0, 80) || 'restyle',
      // A recipe needs at least one item. A colour-only plan is still a real restyle, so
      // it is expressed as a palette with no items and handled by the caller.
      items,
      ...(wallColor ? { wall_color: wallColor } : {}),
      ...(floorColor ? { floor_color: floorColor } : {}),
      ...(objectColor ? { object_color: objectColor } : {}),
      replace_ids: [...new Set(replaceIds)],
      // Anything the plan did not mention stays, and stays in the way.
      preserve_ids: [...objectIds].filter((id) => !touched.has(id)).sort(),
    },
    skipped,
  };
}
