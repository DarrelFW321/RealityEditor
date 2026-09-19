import { z } from 'zod';
import type { EditorState } from '@reality/contracts';
import type { ErasureVolume } from '@reality/spatial-engine';
import { buildPatch, imageBounds, planesOf, surfaceBehind, type CameraView, type Patch } from './patch';

/**
 * Asking a model what is behind a masked box, once, and keeping the answer.
 *
 * Transient display state, deliberately not part of `EditorState`. M8 puts committed
 * visibility intent in the spatial engine and renderer state in the renderer, and a
 * base64 photograph is not scene data — it is one viewpoint's answer to a question the
 * scene asked. The intent (which box is hidden) is committed and undoable; this is a
 * cache in front of it, discarded whenever the question changes.
 */

const CaptureSchema = z
  .object({
    pngBase64: z.string().min(64),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    timestamp: z.number().finite(),
    cameraToWorld: z.array(z.number().finite()).length(16),
    projection: z.array(z.number().finite()).length(16),
    intrinsics: z.array(z.number().finite()).length(9),
  })
  .strict();
export type Capture = z.infer<typeof CaptureSchema>;

export interface FrameCapture {
  capture(): Promise<unknown>;
}

/**
 * Where a patch's pixels came from.
 *
 * `local` is the captured photograph itself, with the region reconstructed in the
 * shader from the wall immediately around it. It needs no server, no reconstruction
 * and no inference, so it is on screen within a frame of the box being hidden.
 * `inpaint` is the model's answer, which is better and arrives about a minute later.
 */
export type PatchFill = 'local' | 'inpaint';

export type PatchState =
  | { state: 'idle' }
  | { state: 'capturing' }
  | { state: 'thinking'; since: number }
  | { state: 'ready'; patch: Patch; uri: string; fill: PatchFill; note?: string }
  | { state: 'failed'; reason: string };

export type PatchListener = (id: string, state: PatchState) => void;

/**
 * Cache key for one patch.
 *
 * A patch answers "what is behind THIS box, on THIS geometry". Moving or resizing the
 * box, or recalibrating, asks a different question, so the key carries the box's pose
 * and the frame identity. Anything stale is dropped rather than shown against geometry
 * it was not computed for — a patch registered to a room that has since moved is a
 * rectangle floating in mid-air.
 */
export function patchKey(volume: ErasureVolume, frameId: string): string {
  const round = (n: number) => Math.round(n * 1000);
  return [
    volume.id,
    frameId,
    ...volume.center.map(round),
    ...volume.size.map(round),
    round(volume.yaw),
  ].join(':');
}

export class PatchStore {
  private patches = new Map<string, { key: string; state: PatchState }>();
  private inFlight = new Set<string>();
  private listeners = new Set<PatchListener>();
  private disposed = false;

  constructor(
    private apiURL: string,
    private camera: FrameCapture,
    private now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: PatchListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(id: string, state: PatchState) {
    this.listeners.forEach((listener) => listener(id, state));
  }

  /** Every patch currently drawable, in a fixed order. */
  ready(): { patch: Patch; uri: string; fill: PatchFill }[] {
    return [...this.patches.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([, entry]) =>
        entry.state.state === 'ready'
          ? [{ patch: entry.state.patch, uri: entry.state.uri, fill: entry.state.fill }]
          : [],
      );
  }

  stateOf(id: string): PatchState {
    return this.patches.get(id)?.state ?? { state: 'idle' };
  }

  /**
   * Drops any patch whose question has changed, and reports what is still wanted.
   *
   * Called with the CURRENT hidden volumes every time the scene changes, so a box that
   * moved, resized or was unhidden loses its patch immediately rather than leaving a
   * rectangle behind where it used to be.
   */
  reconcile(volumes: readonly ErasureVolume[], frameId: string): ErasureVolume[] {
    const wanted = new Map(volumes.map((v) => [v.id, patchKey(v, frameId)]));
    for (const [id, entry] of [...this.patches]) {
      if (wanted.get(id) !== entry.key) {
        this.patches.delete(id);
        this.emit(id, { state: 'idle' });
      }
    }
    return volumes.filter((v) => !this.patches.has(v.id) && !this.inFlight.has(v.id));
  }

  /**
   * Captures, fills locally, then asks for something better.
   *
   * TWO ANSWERS, IN THAT ORDER. The local fill is published as soon as the geometry is
   * known, so hiding a box changes pixels immediately rather than after a minute of
   * inference — and, more importantly, whether or not the image service is reachable
   * at all. The inpaint then replaces it in place. An inpaint failure therefore
   * DEGRADES to the local fill and never withdraws it: taking the fill away to show a
   * failure message would put the furniture back on screen, which is the one outcome
   * the user asked us to prevent.
   */
  async request(volume: ErasureVolume, scene: EditorState): Promise<PatchState> {
    if (this.inFlight.has(volume.id)) return this.stateOf(volume.id);
    this.inFlight.add(volume.id);
    const key = patchKey(volume, scene.frameId);
    // Settles this request: stores the outcome, tells the listeners, and frees the id.
    // A torn-down store keeps nothing — its patches are already cleared and its
    // listeners unsubscribed, so writing an outcome into it would only resurrect an
    // entry nobody will ever read.
    const publish = (state: PatchState): PatchState => {
      this.inFlight.delete(volume.id);
      if (this.disposed) return { state: 'idle' };
      this.patches.set(volume.id, { key, state });
      this.emit(volume.id, state);
      return state;
    };
    const fail = (reason: string): PatchState => publish({ state: 'failed', reason });
    try {
      this.emit(volume.id, { state: 'capturing' });
      const raw = await this.camera.capture();
      if (raw == null) return fail('No camera frame available.');
      const parsed = CaptureSchema.safeParse(raw);
      if (!parsed.success) return fail('The camera frame was malformed.');
      const capture = parsed.data;
      // The pose in this photograph must describe the room the box lives in.
      if (capture.frameId !== scene.frameId) return fail('The room was recalibrated.');

      const view: CameraView = {
        cameraToRoom: capture.cameraToWorld,
        projection: capture.projection,
        width: capture.width,
        height: capture.height,
      };
      const region = imageBounds(volume, view);
      if (!region) return fail('Point the camera at the masked area and try again.');
      const plane = surfaceBehind(volume, view, planesOf(scene));
      if (!plane) return fail('There is no wall or floor behind that area.');
      // Built BEFORE the request: a box whose patch cannot be registered is one we
      // should not spend a minute of inference on.
      const patch = buildPatch(volume, view, plane);
      if (!patch) return fail('That area is not far enough inside the view.');

      // PIXELS CHANGE HERE, not after the round trip. The photograph is published as
      // the patch texture straight away and the fill shader reconstructs the region
      // from the wall around it, so the box is covered from this point on no matter
      // what the image service does next.
      const photograph = `data:image/png;base64,${capture.pngBase64}`;
      // Stored and announced, but the id stays IN FLIGHT: this request is not over,
      // and releasing it here would let the next reconcile start a second one.
      const local: PatchState = { state: 'ready', patch, uri: photograph, fill: 'local' };
      this.patches.set(volume.id, { key, state: local });
      this.emit(volume.id, local);

      // Keeps the covered box and records why it is not the better fill. Never `fail`:
      // that drops the patch, and dropping the patch puts the furniture back.
      const degrade = (note: string): PatchState => publish(degraded(local, note));

      this.emit(volume.id, { state: 'thinking', since: this.now() });
      const response = await fetch(`${this.apiURL}/inpaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: capture.pngBase64, region }),
      });
      if (!response.ok) {
        const reason = await response
          .json()
          .then((body) => (body as { error?: string }).error)
          .catch(() => undefined);
        return degrade(describeFailure(reason, response.status));
      }
      const body = (await response.json()) as { imageBase64?: string };
      if (!body.imageBase64) return degrade('The image service returned nothing.');
      return publish({
        state: 'ready',
        patch,
        uri: `data:image/png;base64,${body.imageBase64}`,
        fill: 'inpaint',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The patch could not be built.';
      // An unreachable server throws rather than answering, and that must degrade the
      // same way a rejection does: the box stays covered by the local fill and the
      // reason is recorded beside it.
      const covered = this.stateOf(volume.id);
      if (covered.state === 'ready')
        return publish(degraded(covered, `The image service could not be reached (${reason}).`));
      return fail(reason);
    }
  }

  dispose() {
    this.disposed = true;
    this.patches.clear();
    this.listeners.clear();
    this.inFlight.clear();
  }
}

/**
 * The same patch, annotated with why it is still the local fill.
 *
 * A note, never a failure. The box is covered either way, and withdrawing the patch to
 * report that the better fill did not arrive would put the furniture back on screen.
 */
function degraded(state: PatchState & { state: 'ready' }, note: string): PatchState {
  return { ...state, note: `${note} Filled from the surrounding wall instead.` };
}

/** One sentence per remedy, matching how the voice route names its refusals. */
export function describeFailure(reason: string | undefined, status: number): string {
  switch (reason) {
    case 'not_configured':
      return 'Image inpainting is not configured on the server.';
    case 'key_rejected':
      return "The image service rejected the server's key.";
    case 'rate_limited':
      return 'The image service is rate limited. Try again shortly.';
    case 'no_image_returned':
      return 'The image service did not return a picture.';
    case 'upstream_unreachable':
      return 'The server could not reach the image service.';
    default:
      return `The image service failed (${reason ?? `HTTP ${status}`}).`;
  }
}
