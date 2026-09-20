/** Buys untextured geometry from Meshy's preview stage. See README.md. */
import { config as loadEnv } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshyObjectProvider } from '../../server/src/objects/provider.js';
import { validateGlb } from '../../server/src/objects/glb.js';
import { PROMPTS } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
loadEnv({ path: join(ROOT, 'server', '.env'), quiet: true });

const MESHES = join(HERE, 'meshes');
const INDEX = join(MESHES, 'index.json');
const CREDITS_PER_PREVIEW = 20;


type Entry = {
  id: string; file: string; category: string; materialFamily: string;
  dimensionsM?: { width: number; height: number; depth: number };
  hasUVs: boolean; source: 'generated' | 'stripped';
  meshy?: { taskId: string; credits: number | null; triangles?: number; builtAt: string };
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

async function readIndex(): Promise<{ dropUVs: boolean; meshes: Entry[] }> {
  try {
    return JSON.parse(await readFile(INDEX, 'utf8'));
  } catch {
    return { dropUVs: false, meshes: [] };
  }
}

async function main() {
  const index = await readIndex();
  const targets = PROMPTS.filter((p) => !only || only.includes(`gen-${p.key}`))
    // Resume: geometry already paid for is never bought twice.
    .filter((p) => !existsSync(join(MESHES, `gen-${p.key}.glb`)));

  console.log(`${targets.length} to generate · ~${targets.length * CREDITS_PER_PREVIEW} credits\n`);
  if (dryRun) {
    for (const t of targets) console.log(`--- gen-${t.key} (${t.category}/${t.materialFamily})\n  ${t.prompt}\n`);
    return;
  }
  if (!targets.length) return;

  const key = (process.env.MESHY_API_KEY ?? '').trim();
  if (!key || key.endsWith('...')) throw new Error('MESHY_API_KEY is not set in server/.env');
  const provider = new MeshyObjectProvider(key);
  await mkdir(MESHES, { recursive: true });

  let spent = 0;
  for (const [n, target] of targets.entries()) {
    const id = `gen-${target.key}`;
    console.log(`[${n + 1}/${targets.length}] ${id}`);
    // preview, never refine: refine is the stage that bakes a texture, and a baked
    // texture is exactly what this spike exists to avoid.
    const result = await provider.preview({
      prompt: target.prompt,
      onProgress: (p) => process.stdout.write(`\r  geometry ${p}%   `),
    });
    const meta = validateGlb(result.bytes);
    await writeFile(join(MESHES, `${id}.glb`), result.bytes);
    spent += result.consumedCredits ?? CREDITS_PER_PREVIEW;

    const uv = hasUVs(result.bytes);
    console.log(
      `\r  ${(result.bytes.byteLength / 1e6).toFixed(1)}MB · ${meta.triangles?.toLocaleString() ?? '?'} tris` +
        ` · ${meta.textures ?? 0} textures · UVs ${uv ? 'present' : 'ABSENT'}` +
        ` · ${result.consumedCredits ?? '?'} credits · ${(result.elapsedMs / 1000).toFixed(0)}s`,
    );

    index.meshes = [
      ...index.meshes.filter((m) => m.id !== id),
      {
        id, file: `meshes/${id}.glb`,
        category: target.category, materialFamily: target.materialFamily,
        dimensionsM: target.dimensionsM, hasUVs: uv, source: 'generated',
        meshy: { taskId: result.taskId, credits: result.consumedCredits, triangles: meta.triangles, builtAt: new Date().toISOString() },
      },
    ];
    // Written after every object: a crash must not lose the record of what was paid for.
    await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  }
  console.log(`\n${targets.length} generated · ${spent} credits spent`);
}

/** The whole question for the material path: is there a UV layout to tile across? */
function hasUVs(bytes: Buffer): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  return (json.meshes ?? []).some((m: any) =>
    m.primitives.some((p: any) => p.attributes.TEXCOORD_0 !== undefined),
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
