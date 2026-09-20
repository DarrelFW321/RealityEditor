import { config as loadEnv } from 'dotenv';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObjectPrompt,
  buildTexturePrompt,
  interpretPrompt,
  materialFromSpec,
  type CatalogEntry,
} from '@reality/object-spec';
import { validateGlb } from '../server/src/objects/glb.js';
import { MeshyObjectProvider } from '../server/src/objects/provider.js';
import { CATALOG_OBJECTS, type CatalogObject } from './catalog-objects.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The key lives in server/.env. Loading it by explicit path rather than by cwd, so
// this runs the same from the repo root as from anywhere else.
loadEnv({ path: join(ROOT, 'server', '.env'), quiet: true });

const CATALOG = join(ROOT, 'catalog', 'generated');
const MANIFEST = join(CATALOG, 'manifest.json');
const ASSETS = join(CATALOG, 'assets');
const CREDITS_PER_OBJECT = 30;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);

type Entry = CatalogEntry & {
  prompt?: string;
  texturePrompt?: string;
  meshy?: { previewTaskId?: string; refineTaskId?: string; credits?: number; builtAt?: string };
};

async function readManifest(): Promise<{ version: number; entries: Entry[] }> {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

/** Atomic: a crash mid-write must not destroy the record of what was already paid for. */
async function writeManifest(manifest: { version: number; entries: Entry[] }) {
  const temporary = `${MANIFEST}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, MANIFEST);
}

/** Derived from the analyzer so the entry cannot disagree with how it will be matched. */
function describe(object: CatalogObject) {
  const spec = interpretPrompt({ prompt: object.prompt });
  const material = materialFromSpec(spec);
  return { spec, material };
}

async function main() {
  const targets = CATALOG_OBJECTS.filter((o) => !only || only.includes(o.id));
  if (!targets.length) throw new Error('No matching objects');

  const manifest = await readManifest();
  const byId = new Map(manifest.entries.map((e) => [e.id, e]));
  const todo = targets.filter((o) => byId.get(o.id)?.status !== 'complete');

  console.log(`${targets.length} target(s), ${targets.length - todo.length} already complete, ${todo.length} to build.`);
  console.log(`Estimated cost: ${todo.length * CREDITS_PER_OBJECT} credits.\n`);

  if (dryRun) {
    for (const object of todo) {
      const { spec, material } = describe(object);
      console.log(`--- ${object.id} (${spec.category}, ${spec.size}, ${material.family})`);
      console.log(`  object : ${buildObjectPrompt(spec)}`);
      console.log(`  texture: ${buildTexturePrompt(spec, material)}\n`);
    }
    return;
  }

  const key = (process.env.MESHY_API_KEY ?? '').trim();
  if (!key || key.endsWith('...')) throw new Error('MESHY_API_KEY is not set');
  const provider = new MeshyObjectProvider(key);
  await mkdir(ASSETS, { recursive: true });

  for (const [index, object] of todo.entries()) {
    const { spec, material } = describe(object);
    const existing = byId.get(object.id);
    const label = `[${index + 1}/${todo.length}] ${object.id}`;
    console.log(`${label} ${spec.category}/${spec.size}/${material.family}`);

    const entry: Entry = {
      ...(existing ?? {}),
      id: object.id,
      status: 'building',
      category: spec.category,
      size: spec.size,
      materialFamily: material.family,
      baseFinish: object.baseFinish,
      tintable: object.tintable ?? true,
      keywords: [...object.keywords],
      structure: { compartmentCount: spec.structure.compartmentCount },
      dimensionsM: spec.dimensionsM ?? undefined,
      label: object.prompt,
      prompt: buildObjectPrompt(spec),
      texturePrompt: buildTexturePrompt(spec, material),
      sha256: existing?.sha256 ?? '',
      file: existing?.file ?? '',
      meshy: { ...(existing?.meshy ?? {}) },
    };
    byId.set(object.id, entry);
    manifest.entries = [...byId.values()];

    try {
      // Resume: a stored preview id is already paid for, so never buy it twice.
      let previewTaskId = entry.meshy?.previewTaskId;
      if (previewTaskId) {
        console.log(`  reusing preview ${previewTaskId}`);
      } else {
        const preview = await provider.preview({
          prompt: entry.prompt!,
          onProgress: (p) => process.stdout.write(`\r  geometry ${p}%   `),
        });
        previewTaskId = preview.taskId;
        entry.meshy = { ...entry.meshy, previewTaskId, credits: preview.consumedCredits ?? 20 };
        entry.status = 'preview';
        await writeManifest({ ...manifest, entries: [...byId.values()] });
        console.log(`\r  geometry done (${previewTaskId})`);
      }

      const refined = await provider.refine({
        previewTaskId,
        texturePrompt: entry.texturePrompt!,
        onProgress: (p) => process.stdout.write(`\r  texture ${p}%   `),
      });

      // Persist before validating: these bytes cost credits and the signed URL dies.
      const probe = validateGlb(refined.bytes);
      await writeFile(join(ASSETS, `${probe.sha256}.glb`), refined.bytes);

      entry.sha256 = probe.sha256;
      entry.file = `assets/${probe.sha256}.glb`;
      entry.bytes = probe.bytes;
      entry.triangles = probe.triangles;
      entry.textures = probe.textures;
      entry.status = 'complete';
      entry.meshy = {
        ...entry.meshy,
        refineTaskId: refined.taskId,
        credits: (entry.meshy?.credits ?? 20) + (refined.consumedCredits ?? 10),
        builtAt: new Date().toISOString(),
      };
      await writeManifest({ ...manifest, entries: [...byId.values()] });
      console.log(`\r  done: ${probe.triangles} tris, ${probe.textures} textures, ${(probe.bytes / 1048576).toFixed(2)} MB\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = 'failed';
      await writeManifest({ ...manifest, entries: [...byId.values()] });
      console.error(`\r  FAILED: ${message}\n`);
      // Out of credits is not a transient error; retrying just burns the rest.
      if (/\(402\)/.test(message)) throw new Error('Out of credits — aborting the run.');
    }
  }

  const complete = [...byId.values()].filter((e) => e.status === 'complete').length;
  console.log(`Catalog: ${complete}/${byId.size} complete.`);
}

await main();
