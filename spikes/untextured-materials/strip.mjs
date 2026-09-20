/** Rebuilds a catalog GLB as Meshy returns one with `should_texture: false`. See README.md. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CATALOG = join(ROOT, 'catalog', 'generated');
const OUT = join(HERE, 'meshes');

const dropUVs = process.argv.includes('--drop-uvs');

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const chunks = [];
  let at = 12;
  while (at < bytes.byteLength) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length + ((4 - (length % 4)) % 4);
  }
  const json = chunks.find((c) => c.type === 0x4e4f534a);
  const bin = chunks.find((c) => c.type === 0x004e4942);
  return { json: JSON.parse(new TextDecoder().decode(json.data)), bin: bin?.data };
}

/** Chunks are 4-byte aligned. JSON pads with spaces, BIN with zeroes. */
function writeGlb(json, bin) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (encoded.byteLength % 4)) % 4;
  const binPad = bin ? (4 - (bin.byteLength % 4)) % 4 : 0;
  const total = 12 + 8 + encoded.byteLength + jsonPad + (bin ? 8 + bin.byteLength + binPad : 0);
  const out = Buffer.alloc(total);
  const view = new DataView(out.buffer);
  out.write('glTF', 0, 'ascii');
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let at = 12;
  view.setUint32(at, encoded.byteLength + jsonPad, true);
  view.setUint32(at + 4, 0x4e4f534a, true);
  Buffer.from(encoded).copy(out, at + 8);
  out.fill(0x20, at + 8 + encoded.byteLength, at + 8 + encoded.byteLength + jsonPad);
  at += 8 + encoded.byteLength + jsonPad;
  if (bin) {
    view.setUint32(at, bin.byteLength + binPad, true);
    view.setUint32(at + 4, 0x004e4942, true);
    Buffer.from(bin).copy(out, at + 8);
  }
  return out;
}

function strip(json) {
  const removedImages = json.images?.length ?? 0;
  delete json.images;
  delete json.textures;
  delete json.samplers;
  json.materials = [{
    name: 'untextured',
    pbrMetallicRoughness: { baseColorFactor: [0.82, 0.82, 0.82, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  }];
  let removedUVs = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      primitive.material = 0;
      // Orphaned image bufferViews stay: renumbering every accessor to reclaim bytes
      // risks corrupting geometry, in a mesh that is thrown away.
      if (dropUVs && primitive.attributes.TEXCOORD_0 !== undefined) {
        delete primitive.attributes.TEXCOORD_0;
        removedUVs += 1;
      }
    }
  }
  return { removedImages, removedUVs };
}

/** One curved, one upholstered, one thin, one boxy, one spindly, one organic. */
const WANTED = ['stone-statue', 'linen-armchair', 'three-seat-sofa', 'two-door-cabinet', 'tripod-floor-lamp', 'potted-plant'];

const manifest = JSON.parse(readFileSync(join(CATALOG, 'manifest.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const index = [];
for (const entry of manifest.entries) {
  if (!WANTED.includes(entry.id)) continue;
  const source = readFileSync(join(CATALOG, entry.file));
  const { json, bin } = readGlb(source);
  const { removedImages, removedUVs } = strip(json);
  const out = writeGlb(json, bin);
  writeFileSync(join(OUT, `${entry.id}.glb`), out);
  index.push({
    id: entry.id,
    file: `meshes/${entry.id}.glb`,
    category: entry.category,
    materialFamily: entry.materialFamily,
    dimensionsM: entry.dimensionsM,
    hasUVs: !dropUVs,
    source: 'stripped',
  });
  console.log(
    `${entry.id.padEnd(20)} ${(source.byteLength / 1e6).toFixed(1)}MB -> ${(out.byteLength / 1e6).toFixed(1)}MB` +
      `  (${removedImages} images removed${removedUVs ? `, UVs dropped from ${removedUVs} primitive(s)` : ''})`,
  );
}

// Merge, never overwrite: generated entries are paid for and this script did not buy them.
let existing = [];
try {
  existing = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')).meshes ?? [];
} catch {}
const kept = existing.filter((m) => m.source !== 'stripped' && !index.some((n) => n.id === m.id));
writeFileSync(join(OUT, 'index.json'), `${JSON.stringify({ dropUVs, meshes: [...kept, ...index] }, null, 2)}\n`);
console.log(`\n${index.length} mesh(es) -> ${OUT}`);
