/** fal image -> Meshy image-to-3D, untextured. The second geometry route. See README.md. */
import { config as loadEnv } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGlb } from '../../server/src/objects/glb.js';
import { PROMPTS } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
loadEnv({ path: join(ROOT, 'workers', 'furniture', '.env'), quiet: true });
loadEnv({ path: join(ROOT, 'server', '.env'), quiet: true });

const MESHES = join(HERE, 'meshes');
const INDEX = join(MESHES, 'index.json');
const CREDITS_PER_TASK = 20;

const FAL_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux/schnell';
const MESHY_IMAGE_TO_3D = 'https://api.meshy.ai/openapi/v1/image-to-3d';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

/** What the reference image must be for a reconstructor: one object, lit flat, nothing else. */
function imagePrompt(base: string): string {
  return `${base}, three-quarter view, entire object visible, centered, plain seamless light grey background, even studio lighting, no shadows on the backdrop, product photograph, sharp focus`;
}

async function falImage(prompt: string): Promise<{ bytes: Buffer; ms: number; url: string }> {
  const key = (process.env.FAL_KEY ?? '').trim();
  if (!key) throw new Error('FAL_KEY is not set in workers/furniture/.env');
  const started = Date.now();
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: 'square_hd', num_images: 1, num_inference_steps: 4 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`fal ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { images?: { url?: string }[] };
  const url = body.images?.[0]?.url;
  if (!url) throw new Error(`fal returned no image: ${JSON.stringify(body).slice(0, 300)}`);
  const image = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!image.ok) throw new Error(`fal image download ${image.status}`);
  return { bytes: Buffer.from(await image.arrayBuffer()), ms: Date.now() - started, url };
}

async function meshyFromImage(
  dataUri: string,
  onProgress: (p: number) => void,
): Promise<{ bytes: Buffer; taskId: string; credits: number | null; ms: number }> {
  const key = (process.env.MESHY_API_KEY ?? '').trim();
  if (!key || key.endsWith('...')) throw new Error('MESHY_API_KEY is not set in server/.env');
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const started = Date.now();

  const create = await fetch(MESHY_IMAGE_TO_3D, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_url: dataUri,
      // The whole point: geometry only, so our own PBR sets provide appearance.
      should_texture: false,
      should_remesh: true,
      topology: 'triangle',
      // Matches the text-to-3D run, so the comparison is shape and not density.
      target_polycount: 50_000,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!create.ok) throw new Error(`meshy create ${create.status}: ${(await create.text()).slice(0, 300)}`);
  const taskId = ((await create.json()) as { result?: string }).result;
  if (!taskId) throw new Error('meshy returned no task id');

  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    const poll = await fetch(`${MESHY_IMAGE_TO_3D}/${taskId}`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!poll.ok) throw new Error(`meshy poll ${poll.status}`);
    const task = (await poll.json()) as {
      status?: string; progress?: number;
      model_urls?: { glb?: string }; consumed_credits?: number;
      task_error?: { message?: string };
    };
    onProgress(task.progress ?? 0);
    if (task.status === 'FAILED' || task.status === 'CANCELED')
      throw new Error(`meshy ${task.status}: ${task.task_error?.message ?? 'no detail'}`);
    if (task.status !== 'SUCCEEDED') continue;
    const glb = task.model_urls?.glb;
    if (!glb) throw new Error('meshy succeeded with no glb url');
    const download = await fetch(glb, { signal: AbortSignal.timeout(180_000) });
    if (!download.ok) throw new Error(`meshy download ${download.status}`);
    return {
      bytes: Buffer.from(await download.arrayBuffer()),
      taskId,
      credits: task.consumed_credits ?? null,
      ms: Date.now() - started,
    };
  }
}

function hasUVs(bytes: Buffer): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  return (json.meshes ?? []).some((m: any) =>
    m.primitives.some((p: any) => p.attributes.TEXCOORD_0 !== undefined),
  );
}

async function readIndex(): Promise<{ dropUVs: boolean; meshes: any[] }> {
  try {
    return JSON.parse(await readFile(INDEX, 'utf8'));
  } catch {
    return { dropUVs: false, meshes: [] };
  }
}

async function main() {
  const targets = PROMPTS.filter((p) => !only || only.includes(`img-${p.key}`))
    .filter((p) => !existsSync(join(MESHES, `img-${p.key}.glb`)));

  console.log(`${targets.length} via ${FAL_MODEL} -> image-to-3d · ~${targets.length * CREDITS_PER_TASK} Meshy credits\n`);
  if (dryRun) {
    for (const t of targets) console.log(`--- img-${t.key}\n  ${imagePrompt(t.prompt)}\n`);
    return;
  }
  if (!targets.length) return;

  await mkdir(MESHES, { recursive: true });
  const index = await readIndex();
  let credits = 0;

  for (const [n, target] of targets.entries()) {
    const id = `img-${target.key}`;
    console.log(`[${n + 1}/${targets.length}] ${id}`);

    const image = await falImage(imagePrompt(target.prompt));
    await writeFile(join(MESHES, `${id}.png`), image.bytes);
    console.log(`  image ${(image.bytes.byteLength / 1e3).toFixed(0)}kB in ${(image.ms / 1000).toFixed(1)}s`);

    const dataUri = `data:image/${image.bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : 'jpeg'};base64,${image.bytes.toString('base64')}`;
    const mesh = await meshyFromImage(dataUri, (p) => process.stdout.write(`\r  geometry ${p}%   `));
    const meta = validateGlb(mesh.bytes);
    await writeFile(join(MESHES, `${id}.glb`), mesh.bytes);
    credits += mesh.credits ?? CREDITS_PER_TASK;

    const uv = hasUVs(mesh.bytes);
    console.log(
      `\r  ${(mesh.bytes.byteLength / 1e6).toFixed(1)}MB · ${meta.triangles?.toLocaleString() ?? '?'} tris` +
        ` · ${meta.textures ?? 0} textures · UVs ${uv ? 'present' : 'ABSENT'}` +
        ` · ${mesh.credits ?? '?'} credits · ${(mesh.ms / 1000).toFixed(0)}s` +
        `  (total ${((image.ms + mesh.ms) / 1000).toFixed(0)}s)`,
    );

    index.meshes = [
      ...index.meshes.filter((m) => m.id !== id),
      {
        id, file: `meshes/${id}.glb`, image: `meshes/${id}.png`,
        category: target.category, materialFamily: target.materialFamily,
        dimensionsM: target.dimensionsM, hasUVs: uv, source: 'generated-image',
        meshy: {
          taskId: mesh.taskId, credits: mesh.credits, triangles: meta.triangles,
          imageMs: image.ms, meshMs: mesh.ms, model: FAL_MODEL,
          builtAt: new Date().toISOString(),
        },
      },
    ];
    await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  }
  console.log(`\n${targets.length} generated · ${credits} Meshy credits spent`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
