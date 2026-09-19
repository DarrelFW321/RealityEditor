import {
  JobSchema,
  KeyframeSchema,
  ReconstructionRoomSchema,
  type ReconstructionRoom,
  type Keyframe,
  type ReconstructionAdapter,
  type ReconstructionJob,
} from '@reality/contracts';

/** Session token is kept in memory and never included in diagnostics or URLs. */
export class HttpReconstructionClient implements ReconstructionAdapter {
  readonly id = 'fastify-reconstruction-v1';
  readonly capabilities = ['aligned-keyframes', 'jobs', 'cleanup'];
  private session: { id: string; token: string } | null = null;
  constructor(private apiURL: string) {}
  async start() {}
  async stop() {}
  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.apiURL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.session ? { Authorization: `Bearer ${this.session.token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      // The server names its refusals — duplicate_frame, capture_limit, stale_calibration,
      // provider_not_configured. Carrying the reason means a caller can decide whether a
      // retry is worth attempting instead of guessing from a status code.
      const reason = await response
        .json()
        .then((body) => (body as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(reason ?? `reconstruction_http_${response.status}`);
    }
    return response;
  }
  async create(
    revision: number,
    frameId: string,
    room: ReconstructionRoom,
    signal: AbortSignal,
  ) {
    if (this.session) throw new Error('Dispose the previous calibration before creating another.');
    const response = await this.request('/calibrations', {
      method: 'POST',
      // The room travels with the session it calibrates; the worker cannot project without
      // the planes, the volumes to reject, or the origin that reconciles pose frames.
      body: JSON.stringify({ revision, frameId, room: ReconstructionRoomSchema.parse(room) }),
      signal,
    });
    const data = (await response.json()) as { id?: string; token?: string };
    if (!data.id || !data.token) throw new Error('Invalid calibration response');
    this.session = { id: data.id, token: data.token };
    return data.id;
  }
  async upload(metadata: Keyframe, jpegBase64: string, signal: AbortSignal) {
    if (!this.session) throw new Error('Create a calibration first');
    // No API accepts an unregistered photo masquerading as a tracked frame.
    await this.request(`/calibrations/${this.session.id}/frames`, {
      method: 'POST',
      body: JSON.stringify({ metadata: KeyframeSchema.parse(metadata), jpegBase64 }),
      signal,
    });
  }
  async reconstruct(
    calibrationId: string,
    revision: number,
    frameId: string,
    signal: AbortSignal,
  ): Promise<ReconstructionJob> {
    if (this.session?.id !== calibrationId) throw new Error('Calibration mismatch');
    const response = await this.request(`/calibrations/${calibrationId}/reconstruct`, {
      method: 'POST',
      body: JSON.stringify({ revision, frameId }),
      signal,
    });
    const job = JobSchema.parse(await response.json());
    if (job.calibrationId !== calibrationId || job.revision !== revision || job.frameId !== frameId)
      throw new Error('Stale reconstruction response');
    return job;
  }
  /**
   * Fetches one artifact named by a completed manifest.
   *
   * `GET /calibrations/:id/assets/:key` has existed since the API was written and nothing
   * could reach it — there was no client method at all, so a manifest could be received
   * and never acted on. Returns bytes rather than a URL because the route needs the bearer
   * token, which deliberately never leaves this object.
   */
  async asset(key: string, signal: AbortSignal): Promise<{ mime: string; bytes: ArrayBuffer }> {
    if (!this.session) throw new Error('Create a calibration first');
    const response = await this.request(`/calibrations/${this.session.id}/assets/${key}`, {
      signal,
    });
    return {
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: await response.arrayBuffer(),
    };
  }

  /**
   * Polls until the job reaches a terminal state.
   *
   * `poll` is a single request by design — this is the loop around it. Backoff is capped
   * and the whole wait is bounded, because a job that never settles must surface as a
   * failure rather than as a spinner that runs until the session expires.
   */
  async awaitJob(
    job: ReconstructionJob,
    signal: AbortSignal,
    onStage?: (job: ReconstructionJob) => void,
  ): Promise<ReconstructionJob> {
    const deadline = Date.now() + 180_000;
    let wait = 250;
    let current = job;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('reconstruction_cancelled');
      if (current.status !== 'queued' && current.status !== 'running') return current;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('reconstruction_cancelled'));
          },
          { once: true },
        );
      });
      current = await this.poll(current, signal);
      onStage?.(current);
      wait = Math.min(wait * 2, 4_000);
    }
    throw new Error('reconstruction_timeout');
  }

  async poll(job: ReconstructionJob, signal: AbortSignal) {
    const response = await this.request(`/jobs/${job.id}`, { signal });
    const next = JobSchema.parse(await response.json());
    if (
      next.calibrationId !== job.calibrationId ||
      next.revision !== job.revision ||
      next.frameId !== job.frameId
    )
      throw new Error('Stale reconstruction result');
    return next;
  }
  async dispose() {
    if (!this.session) return;
    const session = this.session;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      await this.request(`/calibrations/${session.id}`, {
        method: 'DELETE',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      this.session = null;
    }
  }
}
