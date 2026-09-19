/**
 * Recorded RoomPlan captures, replayable without a device.
 *
 * These are the exact payload the native `onRoom` event hands JavaScript, so a capture
 * recorded on a phone can be dropped in here verbatim and the milestone gate will replay
 * it forever. Imported as JSON modules rather than read from disk so the same fixtures
 * work inside the Metro bundle and under `npx tsx`.
 *
 * The four below are SYNTHETIC: a hand-built 4x4m room, good enough to exercise every
 * branch of the conversion but not evidence that a real scan behaves this way. Replace
 * them with device recordings as those are captured; the gate does not change.
 */
import emptyRoom from '../../../contracts/fixtures/rooms/captures/empty-room.capture.json';
import furnishedRoom from '../../../contracts/fixtures/rooms/captures/furnished-room.capture.json';
import lowConfidenceWall from '../../../contracts/fixtures/rooms/captures/low-confidence-wall.capture.json';
import noFloor from '../../../contracts/fixtures/rooms/captures/no-floor.capture.json';
import twoWalls from '../../../contracts/fixtures/rooms/captures/two-walls.capture.json';
import offsetOrigin from '../../../contracts/fixtures/rooms/captures/offset-origin.capture.json';
import shellExample from '../../../contracts/fixtures/rooms/captures/shell.example.json';

export type CaptureName =
  | 'empty-room'
  | 'furnished-room'
  | 'low-confidence-wall'
  | 'no-floor'
  | 'two-walls'
  | 'offset-origin';

const captures: Record<CaptureName, unknown> = {
  'empty-room': emptyRoom,
  'furnished-room': furnishedRoom,
  'low-confidence-wall': lowConfidenceWall,
  'no-floor': noFloor,
  'two-walls': twoWalls,
  /** A room several metres from the ARKit origin, which is what every real scan looks
   * like unless the user happened to start in the exact centre of the room. */
  'offset-origin': offsetOrigin,
};

/**
 * A real `shell.json`, emitted by the Python worker from the synthetic room its self-test
 * renders. Checked in so the client's parsing and UV handling are gated without needing
 * the worker running, and so a change to either side that breaks the other is caught.
 */
export const exampleShell = () => shellExample as unknown;

/** `roomToSession` takes the raw string the native event carries, so hand it one. */
export const capture = (name: CaptureName): string => JSON.stringify(captures[name]);

/**
 * A camera-to-world matrix facing `yaw`, column-major, camera forward on -Z.
 *
 * Column 2 is the camera's +Z axis, so it holds the negated heading. Getting this
 * backwards silently mirrors every coverage result, which is why it lives in one place
 * rather than being rebuilt in each scenario.
 */
export function cameraFacing(yaw: number): number[] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, -c, 0, 0, 1.5, 0, 1];
}

/** Frames for a sweep of `degrees`, one per degree, as the tracker consumes them. */
export function sweepFrames(
  degrees: number,
  tracking: 'normal' | 'limited' | 'lost' = 'normal',
): { cameraToWorld: number[]; tracking: string }[] {
  const frames = [];
  for (let i = 0; i < degrees; i++)
    frames.push({ cameraToWorld: cameraFacing((i * Math.PI) / 180), tracking });
  return frames;
}
