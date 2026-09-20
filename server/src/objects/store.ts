import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildObjectPrompt,
  buildTexturePrompt,
  interpretPrompt,
  matchCatalog,
  materialFromSpec,
  type CatalogEntry,
  type CatalogMatch,
  type DimensionsM,
  type ObjectMaterial,
  type ObjectSpec,
} from '@reality/object-spec';
import { applyMaterialToGlb, GLB_LIMITS, tintGlbBaseColor, validateGlb, type GlbMetadata } from './glb.js';
import type { ObjectProvider } from './provider.js';

export type JobStatus = 'queued' | 'generating-geometry' | 'texturing' | 'complete' | 'failed';

export interface ObjectAsset extends GlbMetadata {
  url: string;
  label: string;
  dimensionsM: DimensionsM | null;
  textured: boolean;
}

export interface ObjectJob {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  source: 'catalog' | 'generated';
  createdAt: string;
  updatedAt: string;
  prompt: string;
  spec: ObjectSpec;
  material: ObjectMaterial;
  catalog?: { id: string; score: number; matched: string[]; disclosures: string[] };
  previewAsset?: ObjectAsset;
  asset?: ObjectAsset;
  timings?: { previewMs: number; textureMs: number; totalMs: number };
  credits?: number;
}

interface Catalog {
  entries: CatalogEntry[];
  filesBySha: Map<string, string>;
  loadedAt: string | null;
  error: string | null;
}

const EMPTY_CATALOG: Catalog = { entries: [], filesBySha: new Map(), loadedAt: null, error: null };
const TINT_CACHE_LIMIT = 8;

const describe = (error: unknown) => (error instanceof Error ? error.message : 'non_error_thrown');

export class ObjectStore {
  private jobs = new Map<string, ObjectJob>();
  private tintCache = new Map<string, Buffer>();
  private catalog: Catalog = EMPTY_CATALOG;
  /** Serialised on purpose: parallel jobs mean parallel paid provider calls. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private root: string,
    private provider: ObjectProvider | null,
    private catalogDir: string | null = null,
    private onDiagnostic?: (code: string, detail: string) => void,
  ) {}

  get providerId() {
    return this.provider?.id ?? null;
  }

  get catalogInfo() {
    return { entries: this.catalog.entries.length, loadedAt: this.catalog.loadedAt, error: this.catalog.error };
  }

  get catalogEntries(): CatalogEntry[] {
    return this.catalog.entries;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.catalog = this.catalogDir ? await loadCatalog(this.catalogDir) : EMPTY_CATALOG;
    if (this.catalog.error) this.onDiagnostic?.('catalog_load_failed', this.catalog.error);
  }

  getJob(id: string) {
    return this.jobs.get(id) ?? null;
  }

  /** Resolves a content hash to a file, preferring the pre-built catalog. */
  fileFor(sha256: string) {
    return this.catalog.filesBySha.get(sha256) ?? join(this.root, `${sha256}.glb`);
  }

  async readAsset(sha256: string, tint?: string): Promise<Buffer> {
    const file = this.fileFor(sha256);
    if (!tint) return readFile(file);
    const key = `${sha256}:${tint}`;
    const cached = this.tintCache.get(key);
    if (cached) return cached;
    const bytes = tintGlbBaseColor(await readFile(file), `#${tint}`, GLB_LIMITS);
    this.tintCache.set(key, bytes);
    // These are multi-megabyte buffers; a large cache is a memory leak, not a win.
    if (this.tintCache.size > TINT_CACHE_LIMIT) {
      const oldest = this.tintCache.keys().next().value;
      if (oldest !== undefined) this.tintCache.delete(oldest);
    }
    return bytes;
  }

  create(rawPrompt: unknown): ObjectJob {
    const spec = interpretPrompt(rawPrompt);
    const material = materialFromSpec(spec);
    const now = new Date().toISOString();
    const job: ObjectJob = {
      id: randomUUID(),
      status: 'queued',
      progress: 0,
      message: 'Queued for generation…',
      source: 'generated',
      createdAt: now,
      updatedAt: now,
      prompt: spec.prompt,
      spec,
      material,
    };
    this.jobs.set(job.id, job);

    const hit = matchCatalog(this.catalog, spec, material);
    if (hit) {
      this.completeFromCatalog(job, hit);
      return job;
    }
    if (!this.provider) {
      this.update(job, 'failed', 'Object generation is not configured.', 100);
      return job;
    }
    this.queue = this.queue.then(() => this.run(job), () => this.run(job));
    return job;
  }

  private update(job: ObjectJob, status: JobStatus, message: string, progress: number) {
    job.status = status;
    job.message = message;
    job.progress = progress;
    job.updatedAt = new Date().toISOString();
  }

  private assetUrl(sha256: string, spec: ObjectSpec, textured: boolean) {
    // Tint is a path segment, not a query string: expo-asset derives its cache
    // filename from the extension, and a query breaks it.
    return textured && spec.finish.colorName !== 'neutral'
      ? `/objects/assets/${sha256}/${spec.finish.colorHex.slice(1)}.glb`
      : `/objects/assets/${sha256}.glb`;
  }

  // Whether a mesh needs a material is discoverable from the bytes: the preview
  // stage returns geometry with none, the refine stage a full PBR set.
  private async store(raw: Buffer, job: ObjectJob): Promise<ObjectAsset> {
    const probe = validateGlb(raw, GLB_LIMITS);
    const textured = probe.textures > 0;
    const bytes = textured ? raw : applyMaterialToGlb(raw, job.material, GLB_LIMITS);
    const metadata = textured ? probe : validateGlb(bytes, GLB_LIMITS);
    await writeFile(join(this.root, `${metadata.sha256}.glb`), bytes, { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return {
      ...metadata,
      url: this.assetUrl(metadata.sha256, job.spec, textured),
      label: job.prompt,
      dimensionsM: job.spec.dimensionsM,
      textured,
    };
  }

  private completeFromCatalog(job: ObjectJob, hit: CatalogMatch) {
    const { entry } = hit;
    const textured = entry.tintable !== false;
    job.source = 'catalog';
    job.catalog = { id: entry.id, score: hit.score, matched: hit.matched, disclosures: hit.disclosures };
    job.asset = {
      sha256: entry.sha256,
      bytes: entry.bytes ?? 0,
      meshes: 0,
      triangles: entry.triangles ?? 0,
      materials: 1,
      textures: entry.textures ?? 0,
      images: entry.textures ?? 0,
      url: this.assetUrl(entry.sha256, job.spec, textured),
      label: entry.label ?? job.prompt,
      dimensionsM: entry.dimensionsM ?? job.spec.dimensionsM,
      textured,
    };
    job.timings = { previewMs: 0, textureMs: 0, totalMs: Date.now() - Date.parse(job.createdAt) };
    this.update(job, 'complete', 'Served from the pre-built catalog.', 100);
  }

  private async run(job: ObjectJob) {
    if (!this.provider) return;
    try {
      this.update(job, 'generating-geometry', 'Shaping the geometry…', 8);
      const preview = await this.provider.preview({
        prompt: buildObjectPrompt(job.spec),
        onProgress: (p) => this.update(job, 'generating-geometry', 'Shaping the geometry…', 8 + Math.round(p * 0.42)),
      });
      job.previewAsset = await this.store(preview.bytes, job);

      this.update(job, 'texturing', 'Baking a 2K PBR texture…', 52);
      const refined = await this.provider.refine({
        previewTaskId: preview.taskId,
        texturePrompt: buildTexturePrompt(job.spec, job.material),
        onProgress: (p) => this.update(job, 'texturing', 'Baking a 2K PBR texture…', 52 + Math.round(p * 0.46)),
      });
      job.asset = await this.store(refined.bytes, job);

      job.timings = {
        previewMs: Math.round(preview.elapsedMs),
        textureMs: Math.round(refined.elapsedMs),
        totalMs: Date.now() - Date.parse(job.createdAt),
      };
      job.credits = (preview.consumedCredits ?? 0) + (refined.consumedCredits ?? 0);
      this.update(job, 'complete', `Ready in ${(job.timings.totalMs / 1000).toFixed(1)} seconds.`, 100);
    } catch (error) {
      this.onDiagnostic?.('generation_failed', describe(error));
      this.update(job, 'failed', describe(error), 100);
    }
  }
}

export async function loadCatalog(directory: string): Promise<Catalog> {
  let raw: string;
  try {
    raw = await readFile(join(directory, 'manifest.json'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { ...EMPTY_CATALOG } : { ...EMPTY_CATALOG, error: describe(error) };
  }
  try {
    const manifest = JSON.parse(raw) as { entries?: CatalogEntry[] };
    const entries = (manifest.entries ?? []).filter((entry) => entry.status === 'complete' && entry.sha256 && entry.file);
    return {
      entries,
      filesBySha: new Map(entries.map((entry) => [entry.sha256, join(directory, entry.file)])),
      loadedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return { ...EMPTY_CATALOG, error: `manifest.json is not valid JSON: ${describe(error)}` };
  }
}
