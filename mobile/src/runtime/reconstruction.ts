import { HttpReconstructionClient } from '@reality/adapters';
import { File, Paths } from 'expo-file-system';
import { ShellSchema } from '@reality/contracts';
import type {
  Keyframe,
  ReconstructionJob,
  ReconstructionManifest,
  ReconstructionRoom,
  Shell,
} from '@reality/contracts';

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
  | { state: 'ready'; manifest: ReconstructionManifest; shell: Shell; atlasUri: string | null }
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
  /** Cached atlas on disk, deleted with the session. */
  private atlasFile: File | null = null;

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
    room: ReconstructionRoom,
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
      this.calibrationId = await this.client.create(revision, frameId, room, signal);
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
      await this.finish(settled);
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

  private async finish(job: ReconstructionJob) {
    if (job.status !== 'completed' || !job.result) {
      this.publish({ state: 'failed', reason: job.error ?? job.status });
      return;
    }
    const manifest = job.result;
    try {
      const shell = await this.loadShell(manifest);
      const atlasUri = await this.cacheAtlas(shell);
      this.publish({ state: 'ready', manifest, shell, atlasUri });
    } catch (error) {
      // The manifest is valid but its artifacts are not usable. The measured room is
      // unaffected either way, so this is a failed preview rather than a failed session.
      this.publish({
        state: 'failed',
        reason: error instanceof Error ? error.message : 'shell_unreadable',
      });
    }
  }

  private async loadShell(manifest: ReconstructionManifest): Promise<Shell> {
    const entry = manifest.artifacts.find((a) => a.role === 'shell');
    if (!entry) throw new Error('shell_missing');
    const { bytes } = await this.client.asset(entry.key, this.controller.signal);
    // Parsed, not trusted. The worker is a replaceable part and this is the only thing
    // standing between a malformed mesh and the renderer.
    return ShellSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }

  /**
   * Writes the atlas to a file and returns its URI.
   *
   * R3F's native TextureLoader resolves through expo-asset, which wants a URI rather than
   * bytes — so the PNG lands on disk once instead of being re-encoded into a data URL
   * that would double a multi-megabyte image in memory.
   */
  private async cacheAtlas(shell: Shell): Promise<string | null> {
    try {
      const { bytes } = await this.client.asset(shell.atlas.key, this.controller.signal);
      const file = new File(Paths.cache, `shell-${Date.now()}-${shell.atlas.key}`);
      file.create({ overwrite: true });
      file.write(new Uint8Array(bytes));
      this.atlasFile = file;
      return file.uri;
    } catch {
      // A shell without its texture still has correct geometry; the renderer simply has
      // nothing to draw with, and says so rather than showing an untextured box.
      return null;
    }
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
      this.atlasFile?.delete();
    } catch {
      // Cache file; the OS reclaims it.
    }
    this.atlasFile = null;
    try {
      await this.client.dispose();
    } catch {
      // The session expires server-side within 24h regardless. Failing to delete is worth
      // neither a crash nor a user-visible error.
    }
    this.listeners.clear();
  }
}
