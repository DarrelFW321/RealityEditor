import type { EditorState, Vec3 } from '@reality/contracts';
import type { ErasureVolume } from '@reality/spatial-engine';

/**
 * Turning one inpainted photograph into a patch registered on the wall.
 *
 * The compositor approach replaced pixels in screen space every frame. This does the
 * opposite: it asks once what the wall behind a masked box looks like, then puts that
 * answer on the wall as ordinary 3D geometry. It stays aligned when the camera moves
 * because it IS aligned — a quad on the wall plane, not a patch on the screen.
 *
 * Everything here is pure and frame-independent, so the registration can be checked
 * numerically instead of by looking at a phone.
 *
 * THE CAMERA CONVENTION is ARKit's: the camera looks down its own -Z, +Y is up, and
 * `cameraToWorld` maps camera space into the room. Projection is the ARKit projection
 * matrix, column-major, as it arrives from the native bundle.
 */

export type CameraView = {
  /** Column-major 4x4, camera space to room space. */
  cameraToRoom: readonly number[];
  /** Column-major 4x4 ARKit projection. */
  projection: readonly number[];
  width: number;
  height: number;
};

// ---------------------------------------------------------------- linear algebra

const at = (m: readonly number[], row: number, col: number) => m[col * 4 + row]!;

/** Gauss-Jordan on a 4x4. Returns null when singular, which a caller must handle. */
export function invert4(m: readonly number[]): number[] | null {
  const a: number[][] = [];
  for (let r = 0; r < 4; r++) {
    a.push([]);
    for (let c = 0; c < 4; c++) a[r]!.push(at(m, r, c));
    for (let c = 0; c < 4; c++) a[r]!.push(r === c ? 1 : 0);
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const scale = 1 / a[col]![col]!;
    for (let c = 0; c < 8; c++) a[col]![c]! *= scale;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (!factor) continue;
      for (let c = 0; c < 8; c++) a[r]![c]! -= factor * a[col]![c]!;
    }
  }
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r]![c + 4]!;
  return out;
}

function apply(m: readonly number[], p: readonly number[], w: number): number[] {
  return [0, 1, 2, 3].map(
    (row) =>
      at(m, row, 0) * p[0]! + at(m, row, 1) * p[1]! + at(m, row, 2) * p[2]! + at(m, row, 3) * w,
  );
}

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const add = (a: readonly number[], b: readonly number[], k = 1): Vec3 => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];

// ---------------------------------------------------------------- projection

export function eyeOf(view: CameraView): Vec3 {
  return [at(view.cameraToRoom, 0, 3), at(view.cameraToRoom, 1, 3), at(view.cameraToRoom, 2, 3)];
}

/**
 * Room point to normalised image coordinates, or null when it is behind the camera.
 *
 * Normalised, not pixels: the captured frame and the returned inpaint are different
 * sizes (a 512px capture came back 1024px), so anything expressed in pixels would be
 * wrong by the time it was used.
 */
export function projectToImage(world: Vec3, view: CameraView): { x: number; y: number } | null {
  const roomToCamera = invert4(view.cameraToRoom);
  if (!roomToCamera) return null;
  return projectWith(world, roomToCamera, view);
}

/** Same, with the inverse already computed. Hot paths project many points. */
export function projectWith(
  world: Vec3,
  roomToCamera: readonly number[],
  view: CameraView,
): { x: number; y: number } | null {
  const camera = apply(roomToCamera, world, 1);
  // ARKit cameras look down -Z. A point at or behind the plane has no image position.
  if (camera[2]! > -1e-4) return null;
  const clip = apply(view.projection, camera, 1);
  const w = clip[3]!;
  if (Math.abs(w) < 1e-9) return null;
  return { x: (clip[0]! / w) * 0.5 + 0.5, y: 0.5 - (clip[1]! / w) * 0.5 };
}

/** The eight corners of an erasure volume, room space. `center` is the base centre. */
export function volumeCornersOf(volume: ErasureVolume): Vec3[] {
  const [w, h, d] = volume.size;
  const cos = Math.cos(volume.yaw);
  const sin = Math.sin(volume.yaw);
  const out: Vec3[] = [];
  for (const sx of [-0.5, 0.5])
    for (const sy of [0, 1])
      for (const sz of [-0.5, 0.5])
        out.push([
          volume.center[0] + sx * w * cos - sz * d * sin,
          volume.center[1] + sy * h,
          volume.center[2] + sx * w * sin + sz * d * cos,
        ]);
  return out;
}

/**
 * The box's footprint in the image, as normalised bounds.
 *
 * Padded, because an inpainter given an exact silhouette tends to leave a rim of the
 * original object at the edge. Returns null when the box is not usefully in view;
 * asking a model to remove something off-screen wastes a call and a lot of seconds.
 */
export function imageBounds(
  volume: ErasureVolume,
  view: CameraView,
  padding = 0.04,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const roomToCamera = invert4(view.cameraToRoom);
  if (!roomToCamera) return null;
  const points = volumeCornersOf(volume)
    .map((corner) => projectWith(corner, roomToCamera, view))
    .filter((p): p is { x: number; y: number } => p !== null);
  // A box straddling the camera plane projects nonsense for the corners behind it.
  if (points.length < 8) return null;
  const x0 = Math.min(...points.map((p) => p.x)) - padding;
  const x1 = Math.max(...points.map((p) => p.x)) + padding;
  const y0 = Math.min(...points.map((p) => p.y)) - padding;
  const y1 = Math.max(...points.map((p) => p.y)) + padding;
  const clamped = {
    x0: Math.max(0, x0),
    y0: Math.max(0, y0),
    x1: Math.min(1, x1),
    y1: Math.min(1, y1),
  };
  if (clamped.x1 - clamped.x0 < 0.01 || clamped.y1 - clamped.y0 < 0.01) return null;
  return clamped;
}

// ---------------------------------------------------------------- the wall behind

export type SurfacePlane = { id: string; normal: Vec3; offset: number; polygon: Vec3[] };

export function planesOf(scene: EditorState): SurfacePlane[] {
  return scene.design.surfaces
    .filter((s) => (s.class === 'wall' || s.class === 'floor') && s.state === 'present')
    .filter((s) => s.polygon.length >= 3)
    .map((s) => {
      const normal: Vec3 = [s.plane.normal[0]!, s.plane.normal[1]!, s.plane.normal[2]!];
      const length = Math.hypot(...normal) || 1;
      const unit: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
      return {
        id: s.id,
        normal: unit,
        offset: s.plane.offset / length,
        polygon: s.polygon.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The surface a viewer sees behind the box.
 *
 * Cast through the box centre and take the nearest surface BEYOND it — the wall the
 * object is standing in front of, which is what has to be painted back in. Falls back
 * to the nearest surface by plane distance when the ray escapes, which happens when a
 * box sits under an opening.
 */
export function surfaceBehind(
  volume: ErasureVolume,
  view: CameraView,
  planes: readonly SurfacePlane[],
): SurfacePlane | null {
  if (!planes.length) return null;
  const eye = eyeOf(view);
  const centre: Vec3 = [volume.center[0], volume.center[1] + volume.size[1] / 2, volume.center[2]];
  const ray = sub(centre, eye);
  const length = Math.hypot(...ray) || 1;
  const dir: Vec3 = [ray[0] / length, ray[1] / length, ray[2] / length];

  let best: { plane: SurfacePlane; t: number } | null = null;
  for (const plane of planes) {
    const denominator = dot(plane.normal, dir);
    if (Math.abs(denominator) < 1e-6) continue;
    const t = (plane.offset - dot(plane.normal, eye)) / denominator;
    // Beyond the box, not in front of it: the point of the patch is what is behind.
    if (t <= length + 1e-3) continue;
    if (best && t >= best.t) continue;
    best = { plane, t };
  }
  if (best) return best.plane;

  let nearest: { plane: SurfacePlane; distance: number } | null = null;
  for (const plane of planes) {
    const distance = Math.abs(dot(plane.normal, centre) - plane.offset);
    if (!nearest || distance < nearest.distance) nearest = { plane, distance };
  }
  return nearest?.plane ?? null;
}

export type Patch = {
  volumeId: string;
  surfaceId: string;
  /** Four room-space corners, in triangle-strip order for the renderer. */
  corners: Vec3[];
  /** One UV per corner, into the inpainted image. */
  uvs: [number, number][];
};

/**
 * The quad to paint, and where to sample it from.
 *
 * Each of the box's eight corners is projected from the eye ONTO the surface behind
 * it, and the quad is the bounding rectangle of those points in the plane. That is
 * exactly the region the box occludes from this viewpoint, which is exactly the region
 * whose real appearance is unknown.
 *
 * The UVs come from projecting the quad's own corners back into the captured image, so
 * the texture lands where the photograph actually saw that piece of wall. Getting this
 * pair consistent is the whole registration argument, and `patchRoundTrip` checks it.
 */
export function buildPatch(
  volume: ErasureVolume,
  view: CameraView,
  plane: SurfacePlane,
  liftM = 0.012,
): Patch | null {
  const roomToCamera = invert4(view.cameraToRoom);
  if (!roomToCamera) return null;
  const eye = eyeOf(view);

  const onPlane: Vec3[] = [];
  for (const corner of volumeCornersOf(volume)) {
    const ray = sub(corner, eye);
    const denominator = dot(plane.normal, ray);
    if (Math.abs(denominator) < 1e-9) continue;
    const t = (plane.offset - dot(plane.normal, eye)) / denominator;
    if (!(t > 0)) continue;
    onPlane.push(add(eye, ray, t));
  }
  if (onPlane.length < 3) return null;

  // A 2D basis in the plane. `u` is horizontal where the plane allows it, so a wall
  // patch is axis-aligned with the room rather than tilted by an arbitrary seed.
  const up: Vec3 = Math.abs(plane.normal[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  let u: Vec3 = [
    up[1] * plane.normal[2] - up[2] * plane.normal[1],
    up[2] * plane.normal[0] - up[0] * plane.normal[2],
    up[0] * plane.normal[1] - up[1] * plane.normal[0],
  ];
  const uLength = Math.hypot(...u) || 1;
  u = [u[0] / uLength, u[1] / uLength, u[2] / uLength];
  const v: Vec3 = [
    plane.normal[1] * u[2] - plane.normal[2] * u[1],
    plane.normal[2] * u[0] - plane.normal[0] * u[2],
    plane.normal[0] * u[1] - plane.normal[1] * u[0],
  ];

  const origin = onPlane[0]!;
  const us = onPlane.map((p) => dot(sub(p, origin), u));
  const vs = onPlane.map((p) => dot(sub(p, origin), v));
  const u0 = Math.min(...us);
  const u1 = Math.max(...us);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return null;

  // Lifted toward the viewer so it does not z-fight with the wall it sits on.
  const lift = dot(plane.normal, sub(eye, origin)) >= 0 ? liftM : -liftM;
  const corner = (su: number, sv: number): Vec3 =>
    add(add(add(origin, u, su), v, sv), plane.normal, lift);

  /**
   * Shrink until the whole quad is inside the photograph.
   *
   * A box that runs off the bottom of the frame projects a corner to a negative UV,
   * and a texture sampled outside its own bounds clamps — smearing the edge pixel in
   * a long streak across the wall. Better to cover slightly less wall with real
   * pixels than more wall with a stretch.
   *
   * Bisection on a scale about the centre: the plane-to-image map is projective, so
   * there is no closed form, and twelve halvings resolve this far finer than a texel.
   */
  const midU = (u0 + u1) / 2;
  const midV = (v0 + v1) / 2;
  const cornersAt = (scale: number) => [
    corner(midU + (u0 - midU) * scale, midV + (v0 - midV) * scale),
    corner(midU + (u1 - midU) * scale, midV + (v0 - midV) * scale),
    corner(midU + (u0 - midU) * scale, midV + (v1 - midV) * scale),
    corner(midU + (u1 - midU) * scale, midV + (v1 - midV) * scale),
  ];
  const uvsFor = (points: Vec3[]): [number, number][] | null => {
    const out: [number, number][] = [];
    for (const point of points) {
      const projected = projectWith(point, roomToCamera, view);
      if (!projected) return null;
      out.push([projected.x, 1 - projected.y]);
    }
    return out;
  };
  const allInside = (uvs: [number, number][] | null) =>
    !!uvs && uvs.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1);

  let lo = 0;
  let hi = 1;
  if (!allInside(uvsFor(cornersAt(1)))) {
    for (let step = 0; step < 12; step++) {
      const mid = (lo + hi) / 2;
      if (allInside(uvsFor(cornersAt(mid)))) lo = mid;
      else hi = mid;
    }
    // Nothing usable is in frame. Asking for an inpaint of a box nobody can see
    // would spend a minute and produce a patch with no pixels behind it.
    if (lo < 0.2) return null;
  } else lo = 1;

  const corners = cornersAt(lo);
  const uvs = uvsFor(corners);
  if (!uvs) return null;
  return { volumeId: volume.id, surfaceId: plane.id, corners, uvs };
}

/**
 * Largest disagreement, in normalised image units, between where a patch corner says
 * it samples and where that corner actually projects. Zero is exact registration.
 */
export function patchRoundTrip(patch: Patch, view: CameraView): number {
  const roomToCamera = invert4(view.cameraToRoom);
  if (!roomToCamera) return Infinity;
  let worst = 0;
  patch.corners.forEach((point, index) => {
    const projected = projectWith(point, roomToCamera, view);
    if (!projected) {
      worst = Infinity;
      return;
    }
    const [u, v] = patch.uvs[index]!;
    worst = Math.max(worst, Math.abs(projected.x - u), Math.abs(1 - projected.y - v));
  });
  return worst;
}

/**
 * The map from the patch's own (s, t) square onto the photograph, as a 3x3 homography.
 *
 * The local fill needs to sample the wall JUST OUTSIDE the quad, and "outside" is only
 * meaningful in the quad's own frame: the quad is a rectangle on the wall, but its
 * image is a general quadrilateral, so stepping left in image space can walk back over
 * the object rather than off it. Evaluating this at s = -margin gives a point genuinely
 * beyond the quad's left edge, whatever the viewing angle.
 *
 * Returned in the row-major order `Matrix3.set` takes: `H * vec3(s, t, 1)`, then
 * divided through by its own third component, is a point in the same uv convention the
 * patch carries. Null when the four corners are degenerate, which leaves the caller on
 * the plain textured path.
 *
 * Heckbert's unit-square-to-quadrilateral solution, whose corner order runs around the
 * square — so the patch's own (0,0) (1,0) (0,1) (1,1) is read 0, 1, 3, 2.
 */
export function quadHomography(uvs: readonly [number, number][]): number[] | null {
  if (uvs.length !== 4) return null;
  const [p0, p1, p3, p2] = [uvs[0]!, uvs[1]!, uvs[2]!, uvs[3]!];
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  // An affine quad (a fronto-parallel wall) has no vanishing point and the projective
  // terms are exactly zero. Solving for them anyway divides by a determinant that is
  // also zero.
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12)
    return usable([x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]);
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / determinant;
  const h = (dx1 * sy - sx * dy1) / determinant;
  return usable([
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ]);
}

/**
 * Rejects a map nobody can step outside of.
 *
 * Finiteness is not enough: four coincident corners solve cleanly to a map that sends
 * the whole square to one point, so s = -margin samples the same pixel as s = 0.5 and
 * the "fill" is the object's own colour. The 2x2 leading block is the map's Jacobian,
 * and a quad with no area has no invertible one.
 */
function usable(matrix: number[]): number[] | null {
  if (!matrix.every(Number.isFinite)) return null;
  const jacobian = matrix[0]! * matrix[4]! - matrix[1]! * matrix[3]!;
  return Math.abs(jacobian) < 1e-12 ? null : matrix;
}

/** Evaluates `quadHomography`'s result. The headless counterpart of the fill shader. */
export function homographyAt(matrix: readonly number[], s: number, t: number): [number, number] {
  const w = matrix[6]! * s + matrix[7]! * t + matrix[8]!;
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [
    (matrix[0]! * s + matrix[1]! * t + matrix[2]!) / w,
    (matrix[3]! * s + matrix[4]! * t + matrix[5]!) / w,
  ];
}

/**
 * How far outside the quad the fill reads the wall, in QUAD WIDTHS.
 *
 * A fraction of the thing being covered scales with it, which a fixed pixel distance
 * does not: the same 20px reaches past a distant chair and lands in the middle of a
 * near one. Large enough to clear the rim of an object the drawn box under-covers,
 * small enough to stay on the same surface.
 */
export const FILL_MARGIN = 0.09;

/**
 * The local fill's colour for one point of the patch, expressed once so the shader and
 * the scenarios cannot drift — the same reason `shouldErase` lives in the engine.
 *
 * `sample` is the photograph, taking a point in the patch's own unit square and
 * returning whatever is there. The four samples are taken just OUTSIDE the square, so
 * they are wall and floor rather than the object, and each is weighted by how close the
 * point is to its edge. On the boundary the nearest sample dominates completely, which
 * is what makes the patch meet the surrounding wall without a seam.
 */
export function fillAt(
  s: number,
  t: number,
  sample: (s: number, t: number) => readonly [number, number, number],
  margin = FILL_MARGIN,
): [number, number, number] {
  const u = Math.min(Math.max(s, 0), 1);
  const v = Math.min(Math.max(t, 0), 1);
  const edges: [readonly [number, number, number], number][] = [
    [sample(-margin, v), 1 / Math.max(u, 1e-3)],
    [sample(1 + margin, v), 1 / Math.max(1 - u, 1e-3)],
    [sample(u, -margin), 1 / Math.max(v, 1e-3)],
    [sample(u, 1 + margin), 1 / Math.max(1 - v, 1e-3)],
  ];
  const total = edges.reduce((sum, [, weight]) => sum + weight, 0);
  return [0, 1, 2].map((channel) =>
    edges.reduce((sum, [colour, weight]) => sum + colour[channel]! * weight, 0) / total,
  ) as [number, number, number];
}
