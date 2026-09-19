import { Matrix4, Vector3 } from 'three';
import { raycast } from '@reality/spatial-engine';
import type { Vec3, EditorState } from '@reality/contracts';
import type { TrackedFrame } from './roomplan';

/** Uses the pose paired with this landmark, never the newest unrelated pose. */
export function resolveHand(
  frame: TrackedFrame,
  scene: EditorState,
  floorOffset: number,
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
  const origin = new Vector3().setFromMatrixPosition(world);
  const target = new Vector3(hand.x * 2 - 1, 1 - hand.y * 2, 0.5)
    .applyMatrix4(inverseProjection)
    .applyMatrix4(world);
  const direction = target.sub(origin).normalize();
  origin.y -= floorOffset;
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
    { origin: origin.toArray() as Vec3, direction: direction.toArray() as Vec3 },
  );
}
