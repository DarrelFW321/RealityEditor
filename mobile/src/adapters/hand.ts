import { Matrix4, Vector3 } from 'three';
import { raycast } from '@reality/spatial-engine';
import type { Vec3, EditorState } from '@reality/contracts';
import type { TrackedFrame } from './roomplan';
import { applyToPoint, roomFromWorld } from './room-space';

/** Uses the pose paired with this landmark, never the newest unrelated pose. */
export function resolveHand(
  frame: TrackedFrame,
  scene: EditorState,
  /** Room-space origin in ARKit world coordinates, subtracted from the ray. */
  roomOrigin: Vec3,
  ignoreId?: string,
) {
  const hand = frame.hand;
  if (
    frame.tracking !== 'normal' ||
    hand?.x === undefined ||
    hand.y === undefined ||
    hand.latencyMs > 300 ||
    frame.frameId !== scene.frameId
  )
    return null;
  const inverseProjection = new Matrix4().fromArray(frame.projection).invert();
  const world = new Matrix4().fromArray(frame.cameraToWorld);
  const eye = new Vector3().setFromMatrixPosition(world);
  const target = new Vector3(hand.x * 2 - 1, 1 - hand.y * 2, 0.5)
    .applyMatrix4(inverseProjection)
    .applyMatrix4(world);
  // Move BOTH points into room space and derive the direction there. A relocalisation can
  // rotate the anchor, and rotating the endpoints is the only way to carry that through;
  // translating the origin alone would leave the ray pointing the old way.
  const toRoom = roomFromWorld(frame.roomAnchor, roomOrigin);
  applyToPoint(toRoom, eye);
  applyToPoint(toRoom, target);
  const direction = target.sub(eye).normalize();

  return raycast(
    ignoreId
      ? {
          ...scene,
          design: {
            ...scene.design,
            objects: scene.design.objects.filter((o) => o.id !== ignoreId),
          },
        }
      : scene,
    { origin: eye.toArray() as Vec3, direction: direction.toArray() as Vec3 },
  );
}
