import { apiURL } from '../../runtime/api-url';

export interface GeneratedAsset {
  url: string;
  sha256: string;
  triangles: number;
  bytes: number;
  textured: boolean;
  label: string;
}

export interface ObjectJob {
  id: string;
  status: 'queued' | 'generating-geometry' | 'texturing' | 'complete' | 'failed';
  progress: number;
  message: string;
  source: 'catalog' | 'generated';
  spec: { category: string; size: string; finish: { colorName: string }; disclosedDefaults: string[] };
  catalog?: { id: string; score: number; disclosures: string[] };
  previewAsset?: GeneratedAsset;
  asset?: GeneratedAsset;
  timings?: { previewMs: number; textureMs: number; totalMs: number };
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiURL()}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function assetURL(asset: GeneratedAsset): string {
  return `${apiURL()}${asset.url}`;
}

export async function startGeneration(prompt: string): Promise<ObjectJob> {
  const body = await json<{ job: ObjectJob }>('/objects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return body.job;
}

/**
 * Polls until the job settles, reporting each change.
 *
 * `onPreview` fires once, as soon as untextured geometry exists — the live path
 * takes a minute or more, and a grey mesh at 30s beats a progress bar.
 */
export async function awaitJob(
  id: string,
  handlers: { onUpdate?: (job: ObjectJob) => void; onPreview?: (asset: GeneratedAsset) => void },
  signal?: AbortSignal,
): Promise<ObjectJob> {
  let announcedPreview = false;
  for (;;) {
    if (signal?.aborted) throw new Error('cancelled');
    const { job } = await json<{ job: ObjectJob }>(`/objects/jobs/${id}`);
    handlers.onUpdate?.(job);
    if (!announcedPreview && job.previewAsset) {
      announcedPreview = true;
      handlers.onPreview?.(job.previewAsset);
    }
    if (job.status === 'failed') throw new Error(job.message);
    if (job.status === 'complete') return job;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}
