import type { Vec3 } from '@reality/contracts';

/**
 * World space to room space, for one frame, as a column-major 4x4.
 *
 * The room is recentred on its floor centroid, so anything drawn or targeted has to leave
 * ARKit world coordinates first. Two sources for that transform:
 *
 *  - `anchor`, ARKit's CURRENT transform for the anchor pinned at the room origin. ARKit
 *    revises anchor transforms whenever it improves its map, and following those revisions
 *    is what keeps a placed object on the real surface it was placed on. Prefer this.
 *  - the static origin captured at conversion time. Correct only until ARKit next revises
 *    its world estimate, after which the room slides. Used for the development room, for
 *    the frames before the anchor exists, and if an anchor ever arrives malformed.
 *
 * Returns a full matrix rather than a translation on purpose: a relocalisation can rotate
 * the anchor as well as move it, and a subtracted vector would silently drop that.
 *
 * No three.js here. An anchor transform is rigid, so the inverse is the transposed
 * rotation with a re-derived translation — cheaper than a general 4x4 invert, and it keeps
 * this module loadable by the milestone gate without dragging a renderer in.
 */
export function roomFromWorld(anchor: readonly number[] | undefined, fallback: Vec3): number[] {
  if (anchor?.length === 16 && anchor.every(Number.isFinite)) {
    const m = anchor;
    const [tx, ty, tz] = [m[12]!, m[13]!, m[14]!];
    return [
      m[0]!, m[4]!, m[8]!, 0,
      m[1]!, m[5]!, m[9]!, 0,
      m[2]!, m[6]!, m[10]!, 0,
      -(m[0]! * tx + m[1]! * ty + m[2]! * tz),
      -(m[4]! * tx + m[5]! * ty + m[6]! * tz),
      -(m[8]! * tx + m[9]! * ty + m[10]! * tz),
      1,
    ];
  }
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -fallback[0], -fallback[1], -fallback[2], 1];
}

/** Applies a column-major 4x4 to a point, in place. */
export function applyToPoint(m: readonly number[], p: { x: number; y: number; z: number }) {
  const { x, y, z } = p;
  p.x = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  p.y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  p.z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  return p;
}
