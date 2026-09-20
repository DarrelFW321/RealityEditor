import type { EditorState } from '@reality/contracts';
import { largestOpenRect } from '@reality/spatial-engine';
import type { LegacyPlan } from '../runtime/legacy-style';
import { apiURL } from '../runtime/api-url';

/**
 * Asks the server to furnish a room from a theme.
 *
 * Injected rather than imported by editor.ts: that module is loaded by the Node
 * milestone gate, and anything reaching apiURL pulls expo-constants and the whole
 * of React Native in with it.
 */
export async function requestStylePlan(state: EditorState, theme: string): Promise<LegacyPlan | null> {
  const objects = state.design.objects.filter((o) => o.state === 'present');
  const surfaces = state.design.surfaces.filter((s) => s.state === 'present');

  const body = {
    room_id: state.sessionId,
    theme,
    area_m2: state.design.bounds.area_m2,
    ceiling_height: state.design.bounds.ceiling_height,
    largest_open_rect: largestOpenRect(state.design.occupancy),
    objects: objects.map((o) => ({
      id: o.id,
      class: o.class,
      refined_class: o.refined_class ?? null,
      dims_m: o.dimensions,
      movable: o.movable,
    })),
    surfaces: surfaces.map((s) => ({ id: s.id, class: s.class, material_ref: s.material_ref })),
  };

  try {
    const response = await fetch(`${apiURL()}/plan_style`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return null;
    const plan = (await response.json()) as LegacyPlan;
    return Array.isArray(plan?.ops) ? plan : null;
  } catch {
    // Unreachable server, timeout, or a planner refusal: the caller falls back to
    // the procedural arrangement it would have built anyway.
    return null;
  }
}
