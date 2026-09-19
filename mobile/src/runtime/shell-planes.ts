import type { Shell, Vec3 } from '@reality/contracts';

/**
 * The shell, flattened into something a fragment shader can intersect a ray with.
 *
 * `Shell` is a mesh — positions, UVs and indices — which is right for drawing it as
 * geometry and wrong for asking "what colour is the wall behind this pixel". The
 * compositor needs the second question, so each planar surface is reduced to a plane
 * plus the affine map from a point ON that plane to its atlas UV.
 *
 * Derived rather than assumed: the map is solved from three vertices of the surface,
 * so it is whatever the worker's projector actually produced. Hard-coding a corner and
 * two axes would silently disagree the moment the projector's parameterisation changed.
 */

export const MAX_SHELL_PLANES = 8;

export type ShellPlane = {
  id: string;
  /** Unit normal and plane constant: dot(normal, p) == offset. */
  normal: Vec3;
  offset: number;
  /** A point on the plane, and its atlas UV. The affine map is anchored here. */
  origin: Vec3;
  originUV: [number, number];
  /** Rows of the pseudo-inverse taking (p - origin) to (du, dv). */
  inverseU: Vec3;
  inverseV: Vec3;
  inferred: boolean;
};

function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * Solves one surface. Returns null when its vertices are degenerate or its UVs are
 * collinear — either makes the map unrecoverable, and a plane nobody can sample is
 * better dropped than sampled wrongly.
 */
export function planeOf(surface: Shell['surfaces'][number]): ShellPlane | null {
  const positions = surface.positions;
  const uvs = surface.uvs;
  if (positions.length < 3 || uvs.length !== positions.length) return null;

  // Three vertices whose UVs are not collinear. The first three usually qualify; a
  // triangle-fan quad with a repeated UV does not, so it is searched rather than assumed.
  let picked: [number, number, number] | null = null;
  for (let a = 0; a < positions.length && !picked; a++)
    for (let b = a + 1; b < positions.length && !picked; b++)
      for (let c = b + 1; c < positions.length && !picked; c++) {
        const du1 = uvs[b]![0] - uvs[a]![0];
        const dv1 = uvs[b]![1] - uvs[a]![1];
        const du2 = uvs[c]![0] - uvs[a]![0];
        const dv2 = uvs[c]![1] - uvs[a]![1];
        if (Math.abs(du1 * dv2 - du2 * dv1) > 1e-9) picked = [a, b, c];
      }
  if (!picked) return null;
  const [i0, i1, i2] = picked;
  const p0 = positions[i0]! as Vec3;
  const e1 = sub(positions[i1]!, p0);
  const e2 = sub(positions[i2]!, p0);
  const normalRaw = cross(e1, e2);
  const length = Math.hypot(...normalRaw);
  if (length < 1e-9) return null;
  const normal = scale(normalRaw, 1 / length);

  // World displacement per unit u and per unit v, from the 2x2 UV system.
  const du1 = uvs[i1]![0] - uvs[i0]![0];
  const dv1 = uvs[i1]![1] - uvs[i0]![1];
  const du2 = uvs[i2]![0] - uvs[i0]![0];
  const dv2 = uvs[i2]![1] - uvs[i0]![1];
  const det = du1 * dv2 - du2 * dv1;
  const axisU: Vec3 = [
    (e1[0] * dv2 - e2[0] * dv1) / det,
    (e1[1] * dv2 - e2[1] * dv1) / det,
    (e1[2] * dv2 - e2[2] * dv1) / det,
  ];
  const axisV: Vec3 = [
    (e2[0] * du1 - e1[0] * du2) / det,
    (e2[1] * du1 - e1[1] * du2) / det,
    (e2[2] * du1 - e1[2] * du2) / det,
  ];

  // Invert the 3x2 [axisU axisV] by the 2x2 normal equations. The axes are independent
  // because the UV determinant above is non-zero, so this system is never singular.
  const auu = dot(axisU, axisU);
  const auv = dot(axisU, axisV);
  const avv = dot(axisV, axisV);
  const gram = auu * avv - auv * auv;
  if (Math.abs(gram) < 1e-18) return null;
  const inverseU: Vec3 = [
    (avv * axisU[0] - auv * axisV[0]) / gram,
    (avv * axisU[1] - auv * axisV[1]) / gram,
    (avv * axisU[2] - auv * axisV[2]) / gram,
  ];
  const inverseV: Vec3 = [
    (auu * axisV[0] - auv * axisU[0]) / gram,
    (auu * axisV[1] - auv * axisU[1]) / gram,
    (auu * axisV[2] - auv * axisU[2]) / gram,
  ];

  return {
    id: surface.id,
    normal,
    offset: dot(normal, p0),
    origin: p0,
    originUV: [uvs[i0]![0], uvs[i0]![1]],
    inverseU,
    inverseV,
    inferred: surface.inferred,
  };
}

/** Every usable plane, capped and in a fixed order so the uniform block is stable. */
export function shellPlanes(shell: Shell): ShellPlane[] {
  return [...shell.surfaces]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(planeOf)
    .filter((plane): plane is ShellPlane => plane !== null)
    .slice(0, MAX_SHELL_PLANES);
}

/** The atlas UV a world point on this plane maps to. Mirrors the shader exactly. */
export function uvAt(plane: ShellPlane, point: Vec3): [number, number] {
  const d = sub(point, plane.origin);
  return [plane.originUV[0] + dot(plane.inverseU, d), plane.originUV[1] + dot(plane.inverseV, d)];
}

/**
 * Nearest shell hit along a ray, or null.
 *
 * The JS twin of the shader's loop, kept so the registration can be checked headlessly:
 * a known world point must round-trip to the UV the worker assigned it, and that is a
 * numeric assertion rather than a judgement about whether a texture looks aligned.
 */
export function raycastShell(
  planes: readonly ShellPlane[],
  origin: Vec3,
  direction: Vec3,
  minDistance = 0,
): { plane: ShellPlane; distance: number; uv: [number, number] } | null {
  let best: { plane: ShellPlane; distance: number; uv: [number, number] } | null = null;
  for (const plane of planes) {
    const denominator = dot(plane.normal, direction);
    if (Math.abs(denominator) < 1e-9) continue;
    const t = (plane.offset - dot(plane.normal, origin)) / denominator;
    if (!(t > minDistance) || (best && t >= best.distance)) continue;
    const point: Vec3 = [
      origin[0] + direction[0] * t,
      origin[1] + direction[1] * t,
      origin[2] + direction[2] * t,
    ];
    const uv = uvAt(plane, point);
    // Outside the atlas rectangle is not this surface, whatever the plane says.
    if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) continue;
    best = { plane, distance: t, uv };
  }
  return best;
}
