import type { EditCommand, EditRefusal, EditorState, Vec3 } from '@reality/contracts';
import { q } from './clearances';
import { buildIndex } from './geometry';

type StructureCommand = Extract<EditCommand, { type: 'structure' }>;
export type StructureResult =
  | { ok: true; scene: EditorState; touched: string[] }
  | { ok: false; refusal: EditRefusal; message: string };

function signedArea(polygon: readonly number[][]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return sum / 2;
}

/** A self-intersecting or reflex floor plan is refused, never silently produced. */
function convex(polygon: readonly number[][]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const c = polygon[(i + 2) % polygon.length]!;
    const cross = (b[0]! - a[0]!) * (c[1]! - b[1]!) - (b[1]! - a[1]!) * (c[0]! - b[0]!);
    if (Math.abs(cross) < 1e-9) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign === 0) sign = next;
    else if (sign !== next) return false;
  }
  return true;
}

/**
 * Edits the proposed design only. `measured` is typed DeepReadonly, so the
 * compiler rejects any attempt to write observation here.
 */
export function applyStructuralChange(
  scene: EditorState,
  command: StructureCommand,
): StructureResult {
  const design = scene.design;
  const change = command.change;

  if (change.kind === 'ceiling_height') {
    const next = { ...scene, design: { ...design, bounds: { ...design.bounds } } };
    next.design.bounds.ceiling_height = q(change.metres);
    return { ok: true, scene: next, touched: design.objects.map((o) => o.id) };
  }

  const surface = design.surfaces.find((s) => s.id === command.targetId && s.state === 'present');
  if (!surface) return { ok: false, refusal: 'unknown_target', message: 'That surface is not in the room.' };

  const index = buildIndex(scene, '');

  if (change.kind === 'resize_opening') {
    if (!['window', 'door', 'opening'].includes(surface.class))
      return { ok: false, refusal: 'invalid_parameters', message: 'That is not an opening.' };
    const wall = index.walls.find((w) => w.openings.some((o) => o.id === surface.id));
    if (!wall) return { ok: false, refusal: 'unsupported_structure', message: 'This opening has no host wall.' };
    const us = surface.polygon.map((p) => p[0]! * wall.u[0] + p[2]! * wall.u[2]);
    const vs = surface.polygon.map((p) => p[1]!);
    const centreU = (Math.min(...us) + Math.max(...us)) / 2;
    const baseV = Math.min(...vs);
    const currentWidth = Math.max(...us) - Math.min(...us);
    const currentHeight = Math.max(...vs) - baseV;
    if (currentWidth < 1e-6 || currentHeight < 1e-6)
      return { ok: false, refusal: 'unsupported_structure', message: 'This opening has no measurable size.' };
    const scaleU = change.width / currentWidth;
    const scaleV = change.height / currentHeight;
    const polygon = surface.polygon.map((p) => {
      const u = p[0]! * wall.u[0] + p[2]! * wall.u[2];
      const nextU = centreU + (u - centreU) * scaleU;
      const delta = nextU - u;
      return [
        q(p[0]! + wall.u[0] * delta),
        q(baseV + (p[1]! - baseV) * scaleV),
        q(p[2]! + wall.u[2] * delta),
      ];
    });
    const surfaces = design.surfaces.map((s) =>
      s.id === surface.id ? { ...s, polygon, provenance: 'virtual' as const } : s,
    );
    const touched = design.objects
      .filter((o) => scene.assemblies[o.id]?.support?.surfaceId === wall.id)
      .map((o) => o.id);
    return { ok: true, scene: { ...scene, design: { ...design, surfaces } }, touched };
  }

  // offset_wall: positive metres moves the wall inward, along the resolved normal.
  if (surface.class !== 'wall')
    return { ok: false, refusal: 'invalid_parameters', message: 'Only a wall can be offset.' };
  const wall = index.walls.find((w) => w.id === surface.id);
  if (!wall) return { ok: false, refusal: 'unsupported_structure', message: 'That wall is not usable.' };
  const shift = change.metres;
  const move = (p: readonly number[]): number[] => [
    q(p[0]! + wall.normal[0] * shift),
    q(p[1]!),
    q(p[2]! + wall.normal[2] * shift),
  ];

  const children = design.surfaces.filter((s) => s.parent === surface.id);
  const childIds = new Set(children.map((s) => s.id));
  const surfaces = design.surfaces.map((s) => {
    if (s.id !== surface.id && !childIds.has(s.id)) return s;
    const polygon = s.polygon.map(move);
    const normal = s.id === surface.id ? wall.normal : (s.plane.normal as Vec3);
    const point = polygon[0] ?? [0, 0, 0];
    return {
      ...s,
      polygon,
      plane: {
        normal: [...normal],
        offset: q(normal[0]! * point[0]! + normal[1]! * point[1]! + normal[2]! * point[2]!),
      },
      provenance: 'virtual' as const,
    };
  });

  // Vertices on the old wall plane follow it; the rest stay put.
  const floor = design.bounds.floor_polygon.map((p) => {
    const distance =
      wall.normal[0] * p[0]! + wall.normal[2] * p[1]! - wall.offset;
    if (Math.abs(distance) > 0.05) return [p[0]!, p[1]!];
    return [q(p[0]! + wall.normal[0] * shift), q(p[1]! + wall.normal[2] * shift)];
  });
  const areaValue = Math.abs(signedArea(floor));
  if (areaValue < 0.5)
    return { ok: false, refusal: 'unsupported_structure', message: 'That would leave no usable floor.' };
  if (!convex(floor))
    return {
      ok: false,
      refusal: 'unsupported_structure',
      message: 'That wall move would fold the room in on itself.',
    };

  const touched = design.objects
    .filter((o) => {
      const support = scene.assemblies[o.id]?.support;
      if (support?.surfaceId === surface.id) return true;
      const p = o.pose.position;
      return Math.abs(wall.normal[0] * p[0]! + wall.normal[2] * p[2]! - wall.offset) < 2;
    })
    .map((o) => o.id);

  return {
    ok: true,
    scene: {
      ...scene,
      design: {
        ...design,
        surfaces,
        bounds: { ...design.bounds, floor_polygon: floor, area_m2: q(areaValue) },
      },
    },
    touched,
  };
}
