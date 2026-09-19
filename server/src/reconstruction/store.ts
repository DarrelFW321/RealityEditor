import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyframe, ReconstructionJob } from '@reality/contracts';
import { assertConsistent, type ReconstructionInput, type ReconstructionProvider } from './provider.js';

type Session = {
  id: string;
  tokenHash: Buffer;
  expires: number;
  revision: number;
  frameId: string;
  frames: Map<string, Keyframe>;
  bytes: number;
  uploads: number;
  job: ReconstructionJob | null;
  controller: AbortController | null;
  deleted: boolean;
  assets: Map<string, string>;
};
const TTL = 24 * 60 * 60 * 1000;

/** Never the raw object: a provider error can carry a response body. */
const describe = (error: unknown) =>
  error instanceof Error ? error.message : 'non_error_thrown';

export class CalibrationStore {
  private sessions = new Map<string, Session>();
  constructor(
    private root: string,
    private provider: ReconstructionProvider | null,
    /** Reason strings only — no media, no credentials, no keyframe content. */
    private onDiagnostic?: (code: string, detail: string) => void,
  ) {}
  get providerId() {
    return this.provider?.id ?? null;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Sessions are deliberately ephemeral across server restarts. Remove only our UUID directories.
    for (const id of await readdir(this.root))
      if (/^[0-9a-f-]{36}$/.test(id))
        await rm(join(this.root, id), { recursive: true, force: true });
  }
  async create(revision: number, frameId: string) {
    await this.expire();
    if (this.sessions.size >= 32) throw new Error('capacity');
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const session: Session = {
      id,
      tokenHash: createHash('sha256').update(token).digest(),
      expires: Date.now() + TTL,
      revision,
      frameId,
      frames: new Map(),
      bytes: 0,
      uploads: 0,
      job: null,
      controller: null,
      deleted: false,
      assets: new Map(),
    };
    this.sessions.set(id, session);
    try {
      await mkdir(join(this.root, id), { mode: 0o700 });
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return { id, token, expiresAt: session.expires };
  }
  authorize(id: string, authorization: string | undefined): Session | null {
    const s = this.sessions.get(id);
    if (!s || s.deleted || s.expires <= Date.now() || !authorization?.startsWith('Bearer '))
      return null;
    const digest = createHash('sha256').update(authorization.slice(7)).digest();
    return timingSafeEqual(digest, s.tokenHash) ? s : null;
  }
  async upload(s: Session, metadata: Keyframe, bytes: Buffer) {
    if (s.job || s.deleted || metadata.frameId !== s.frameId) throw new Error('invalid_state');
    if (
      bytes.length > 4 * 1024 * 1024 ||
      s.frames.size >= 24 ||
      s.bytes + bytes.length > 48 * 1024 * 1024
    )
      throw new Error('capture_limit');
    if (s.frames.has(metadata.id)) throw new Error('duplicate_frame');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw new Error('expected_jpeg');
    s.frames.set(metadata.id, metadata);
    s.bytes += bytes.length;
    s.uploads++;
    try {
      await writeFile(join(this.root, s.id, `${metadata.id}.jpg`), bytes, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      s.frames.delete(metadata.id);
      s.bytes -= bytes.length;
      throw error;
    } finally {
      s.uploads--;
    }
    if (s.deleted) await rm(join(this.root, s.id), { recursive: true, force: true });
  }
  begin(s: Session, revision: number, frameId: string) {
    if (s.deleted || revision !== s.revision || frameId !== s.frameId)
      throw new Error('stale_calibration');
    if (!this.provider) throw new Error('provider_not_configured');
    if (s.uploads > 0) throw new Error('upload_in_progress');
    if (s.frames.size < 2) throw new Error('need_aligned_keyframes');
    if (s.job) return s.job; // one immutable reconstruction attempt per calibration
    const job: ReconstructionJob = {
      id: randomUUID(),
      calibrationId: s.id,
      revision,
      frameId,
      status: 'queued',
      stage: 'queued',
      error: null,
      result: null,
    };
    s.job = job;
    s.controller = new AbortController();
    // `run` is deliberately not awaited — the 202 returns immediately — but its `finally`
    // awaits an `rm`, and an unhandled rejection from a floating promise terminates Node.
    // The catch keeps a failed cleanup from taking the whole server down with it.
    void this.run(s, job).catch((error) => {
      job.status = 'failed';
      job.stage = 'failed';
      job.error = 'reconstruction_failed';
      this.onDiagnostic?.('reconstruction_crashed', describe(error));
    });
    return job;
  }
  private async run(s: Session, job: ReconstructionJob) {
    const controller = s.controller!;
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      job.status = 'running';
      job.stage = 'reconstructing';
      const keyframes = await Promise.all(
        [...s.frames.values()].map(async (metadata) => ({
          metadata,
          jpegBase64: (await readFile(join(this.root, s.id, `${metadata.id}.jpg`))).toString(
            'base64',
          ),
        })),
      );
      const input: ReconstructionInput = {
        calibrationId: s.id,
        calibrationRevision: s.revision,
        frameId: s.frameId,
        keyframes,
      };
      const output = await this.provider!.reconstruct(input, controller.signal);
      // Before a single byte is written. A provider that answers for a different
      // calibration, omits the shell, or references an artifact it did not send must not
      // be able to publish, whichever provider it is.
      assertConsistent(input, output);
      if (s.deleted || controller.signal.aborted) return;
      for (const asset of output.assets) {
        if (s.deleted || controller.signal.aborted) return;
        await writeFile(
          join(this.root, s.id, `artifact-${asset.key}`),
          Buffer.from(asset.dataBase64, 'base64'),
          { mode: 0o600 },
        );
        s.assets.set(asset.key, asset.mime);
      }
      if (s.deleted || controller.signal.aborted) return;
      job.result = output.manifest;
      job.status = 'completed';
      job.stage = 'ready';
    } catch (error) {
      if (!s.deleted) {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = controller.signal.aborted ? 'reconstruction_timeout' : 'reconstruction_failed';
        // The provider distinguishes eight failures — worker_revision_mismatch,
        // worker_incomplete_shell, worker_missing_artifact and five more. All of them used
        // to collapse into `reconstruction_failed` and were never logged anywhere, which
        // made a worker integration fault undebuggable from the server side. The client
        // still sees the coarse status; the operator now sees which one it was.
        this.onDiagnostic?.(job.error, describe(error));
      }
    } finally {
      clearTimeout(timeout);
      if (!s.deleted && controller.signal.aborted && job.status === 'running') {
        job.status = 'failed';
        // `stage` was left reading 'reconstructing' on this path while the catch-block
        // path set it to 'failed', so a timed-out job reported two different stages
        // depending on how it timed out.
        job.stage = 'failed';
        job.error = 'reconstruction_timeout';
      }
      if (s.deleted) await rm(join(this.root, s.id), { recursive: true, force: true });
    }
  }
  job(id: string, authorization: string | undefined) {
    for (const s of this.sessions.values())
      if (s.job?.id === id && this.authorize(s.id, authorization)) return s.job;
    return null;
  }
  async asset(s: Session, key: string) {
    const mime = s.assets.get(key);
    if (!mime || s.deleted) return null;
    try {
      return { mime, bytes: await readFile(join(this.root, s.id, `artifact-${key}`)) };
    } catch (error) {
      // The map said the artifact exists and the disk disagreed. Previously this threw
      // straight out of an un-try/catch'd route handler and became a 500; a missing file
      // is a 404 like any other.
      this.onDiagnostic?.('asset_unreadable', describe(error));
      return null;
    }
  }
  async remove(s: Session) {
    s.deleted = true;
    s.controller?.abort();
    if (s.job) {
      s.job.status = 'cancelled';
      s.job.result = null;
    }
    this.sessions.delete(s.id);
    await rm(join(this.root, s.id), { recursive: true, force: true });
  }
  async expire() {
    for (const s of this.sessions.values()) if (s.expires <= Date.now()) await this.remove(s);
  }
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => this.remove(s)));
  }
}
