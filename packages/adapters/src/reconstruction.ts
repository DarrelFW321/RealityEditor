import {
  JobSchema,
  KeyframeSchema,
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
    if (!response.ok) throw new Error(`reconstruction_http_${response.status}`);
    return response;
  }
  async create(revision: number, frameId: string, signal: AbortSignal) {
    if (this.session) throw new Error('Dispose the previous calibration before creating another.');
    const response = await this.request('/calibrations', {
      method: 'POST',
      body: JSON.stringify({ revision, frameId }),
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
