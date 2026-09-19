import { HttpReconstructionClient } from '@reality/adapters';
import type { Keyframe, ReconstructionJob, ReconstructionManifest } from '@reality/contracts';

/**
 * Drives one calibration's reconstruction: create the server session, upload the keyframes
 * the sweep produced, start the job, and follow it to a terminal state.
 *
 * Until now the six pose+intrinsics keyframes were captured, counted on screen, and
 * garbage-collected; the client, the Fastify routes, the store and the worker boundary all
 * existed and nothing called any of them.
 *
 * This owns the server-issued session id and token. Neither belongs on `EditorState` — the
 * token especially — so the scene learns only the id, and only through `onCalibrationId`.
 */
export type ReconstructionPhase =
  | { state: 'idle' }
  | { state: 'uploading'; done: number; total: number }
  | { state: 'reconstructing'; stage: string }
  | { state: 'ready'; manifest: ReconstructionManifest }
  | { state: 'failed'; reason: string }
  | { state: 'unavailable'; reason: string };

export type ReconstructionListener = (phase: ReconstructionPhase) => void;

export class ReconstructionRun {
  private client: HttpReconstructionClient;
  private controller = new AbortController();
  private listeners = new Set<ReconstructionListener>();
  private phase: ReconstructionPhase = { state: 'idle' };
  /** The server's id, which is not the RoomPlan room id the scene starts with. */
  private calibrationId: string | null = null;

  constructor(apiURL: string) {
    this.client = new HttpReconstructionClient(apiURL);
  }

  getPhase = (): ReconstructionPhase => this.phase;
  subscribe = (listener: ReconstructionListener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(phase: ReconstructionPhase) {
    this.phase = phase;
    this.listeners.forEach((l) => l(phase));
  }

  /**
   * Runs the whole sequence. Never throws: a reconstruction failure must leave the editor
   * exactly as it was, because the measured room is already usable without it.
   */
  async run(
    keyframes: { metadata: Keyframe; jpegBase64: string }[],
    revision: number,
    frameId: string,
    onCalibrationId?: (id: string) => void,
  ): Promise<void> {
    const signal = this.controller.signal;
    try {
      if (keyframes.length < 2) {
        // The server refuses fewer than two anyway; saying so here is more useful than a
        // 409 the user cannot act on.
        this.publish({ state: 'unavailable', reason: 'Too few registered views to reconstruct.' });
        return;
      }
      this.calibrationId = await this.client.create(revision, frameId, signal);
      onCalibrationId?.(this.calibrationId);

      this.publish({ state: 'uploading', done: 0, total: keyframes.length });
      for (const [index, keyframe] of keyframes.entries()) {
        if (signal.aborted) return;
        await this.client.upload(keyframe.metadata, keyframe.jpegBase64, signal);
        this.publish({ state: 'uploading', done: index + 1, total: keyframes.length });
      }

      const job = await this.client.reconstruct(this.calibrationId, revision, frameId, signal);
      this.publish({ state: 'reconstructing', stage: job.stage });
      const settled = await this.client.awaitJob(job, signal, (next) =>
        this.publish({ state: 'reconstructing', stage: next.stage }),
      );
      this.finish(settled);
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof Error ? error.message : 'reconstruction_failed';
      // Not having a worker configured is a deployment state, not a fault, and the user
      // should not be shown it as a failure.
      this.publish(
        reason === 'provider_not_configured'
          ? { state: 'unavailable', reason: 'No reconstruction worker is configured.' }
          : { state: 'failed', reason },
      );
    }
  }

  private finish(job: ReconstructionJob) {
    if (job.status === 'completed' && job.result) {
      this.publish({ state: 'ready', manifest: job.result });
      return;
    }
    this.publish({ state: 'failed', reason: job.error ?? job.status });
  }

  /** Bytes for one artifact the manifest named. */
  asset(key: string) {
    return this.client.asset(key, this.controller.signal);
  }

  /** Cancels in-flight work and asks the server to delete the session and its frames. */
  async dispose() {
    this.controller.abort();
    // A fresh controller: dispose must be able to issue its own DELETE after aborting.
    this.controller = new AbortController();
    try {
      await this.client.dispose();
    } catch {
      // The session expires server-side within 24h regardless. Failing to delete is worth
      // neither a crash nor a user-visible error.
    }
    this.listeners.clear();
  }
}
