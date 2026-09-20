const MESHY_TEXT_TO_3D_ENDPOINT = 'https://api.meshy.ai/openapi/v2/text-to-3d';

export interface MeshyTask {
  id?: string;
  status?: string;
  progress?: number;
  model_urls?: { glb?: string };
  consumed_credits?: number;
  task_error?: { message?: string };
}

export interface ObjectProviderResult {
  bytes: Buffer;
  taskId: string;
  task: MeshyTask;
  consumedCredits: number | null;
  elapsedMs: number;
}

export interface ObjectProvider {
  readonly id: string;
  preview(input: { prompt: string; onProgress?: (p: number) => void }): Promise<ObjectProviderResult>;
  refine(input: { previewTaskId: string; texturePrompt: string; onProgress?: (p: number) => void }): Promise<ObjectProviderResult>;
}

type FetchImpl = typeof fetch;

async function providerError(response: Response, stage: string) {
  const text = (await response.text()).slice(0, 800);
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed.message ?? parsed.error ?? parsed.errors?.join(', ') ?? text;
  } catch {
    // Non-JSON body; the raw text is the best message available.
  }
  return Object.assign(new Error(`${stage} request failed (${response.status})${message ? `: ${message}` : ''}`), {
    status: response.status,
  });
}

export function meshyPreviewBody(input: {
  prompt: string;
  aiModel?: string;
  shouldRemesh?: boolean;
  topology?: 'triangle' | 'quad';
  targetPolycount?: number;
}) {
  return {
    mode: 'preview',
    prompt: input.prompt,
    ai_model: input.aiModel ?? 'meshy-7.1',
    should_remesh: input.shouldRemesh ?? true,
    // Not optional: validateGlb rejects any primitive whose mode is not triangles.
    topology: input.topology ?? 'triangle',
    target_polycount: input.targetPolycount ?? 50_000,
    target_formats: ['glb'],
  };
}

export function meshyRefineBody(input: {
  previewTaskId: string;
  texturePrompt?: string;
  textureResolution?: '2k' | '4k' | '8k';
  enablePbr?: boolean;
}) {
  return {
    mode: 'refine',
    preview_task_id: input.previewTaskId,
    enable_pbr: input.enablePbr ?? true,
    // 2K, not 4K: a 4096² map is ~85MB on the GPU with mipmaps, and three of them
    // will exhaust an iPhone. Meshy charges the same 10 credits for both.
    texture_resolution: input.textureResolution ?? '2k',
    ...(input.texturePrompt ? { texture_prompt: input.texturePrompt } : {}),
    target_formats: ['glb'],
    // ai_model is omitted on purpose: refine inherits the preview's model, and a
    // mismatch between the two stages is a documented 400.
  };
}

// Signed download URLs expire, so a 403 means fetch the task again for a fresh one
// rather than giving up on geometry that has already been paid for.
async function downloadGlb(task: MeshyTask, readTask: () => Promise<MeshyTask>, fetchImpl: FetchImpl): Promise<Buffer> {
  let current = task;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = current.model_urls?.glb;
    if (!url) throw new Error('Meshy completed without a GLB');
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status !== 403 || attempt === 2) throw await providerError(response, 'Meshy download');
    current = await readTask();
  }
  throw new Error('Meshy download failed');
}

export class MeshyObjectProvider implements ObjectProvider {
  readonly id = 'meshy-7.1';
  constructor(
    private apiKey: string,
    private fetchImpl: FetchImpl = fetch,
    private pollIntervalMs = 2_000,
    private timeoutMs = 300_000,
  ) {}

  async preview({ prompt, onProgress }: { prompt: string; onProgress?: (p: number) => void }) {
    return this.run(meshyPreviewBody({ prompt }), onProgress);
  }

  async refine({ previewTaskId, texturePrompt, onProgress }: { previewTaskId: string; texturePrompt: string; onProgress?: (p: number) => void }) {
    return this.run(meshyRefineBody({ previewTaskId, texturePrompt }), onProgress);
  }

  private async run(body: { mode: string }, onProgress?: (p: number) => void): Promise<ObjectProviderResult> {
    if (!this.apiKey) throw new Error('MESHY_API_KEY is not configured');
    const started = performance.now();
    const response = await this.fetchImpl(MESHY_TEXT_TO_3D_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await providerError(response, `Meshy ${body.mode}`);
    const taskId = ((await response.json()) as { result?: string }).result;
    if (!taskId) throw new Error('Meshy did not return a task ID');

    const readTask = async (): Promise<MeshyTask> => {
      const statusResponse = await this.fetchImpl(`${MESHY_TEXT_TO_3D_ENDPOINT}/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!statusResponse.ok) throw await providerError(statusResponse, 'Meshy status');
      return statusResponse.json() as Promise<MeshyTask>;
    };

    let task: MeshyTask | undefined;
    while (performance.now() - started < this.timeoutMs) {
      task = await readTask();
      onProgress?.(Math.max(0, Math.min(100, Number(task.progress) || 0)));
      if (task.status === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELED', 'CANCELLED'].includes(task.status ?? '')) {
        const detail = task.task_error?.message ? `: ${task.task_error.message}` : '';
        throw new Error(`Meshy ${body.mode} ${(task.status ?? '').toLowerCase()}${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (task?.status !== 'SUCCEEDED') throw new Error(`Meshy ${body.mode} timed out`);

    return {
      bytes: await downloadGlb(task, readTask, this.fetchImpl),
      taskId,
      task,
      consumedCredits: task.consumed_credits ?? null,
      elapsedMs: performance.now() - started,
    };
  }
}
