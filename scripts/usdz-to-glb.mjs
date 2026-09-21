/**
 * Converts a USDZ from the hand-curated catalogue into a GLB the app can already render.
 *
 * WHY CONVERT RATHER THAN TEACH THE APP USDZ. The renderer is GLB-only by way of one
 * function (`loadGlbFromUrl`), and every stage behind it — the `<sha256>.glb` asset route,
 * `validateGlb`, the catalog cache's `sha256` key, the tint route — is addressed by content
 * hash. Adding a second format meant a second loader, a second route, a nullable `sha256`
 * and a second cache key, to serve three objects. Converting once puts them on the path
 * that is already proven, and the app does not learn a new word.
 *
 * WHAT IS LOST: texture maps. Decoding them needs an image decoder that neither Node nor
 * this script has, so each mesh keeps its material's base colour and nothing else. That is
 * an honest trade here — these objects are tinted by the design palette anyway, and the
 * alternative for an unconvertible asset is the procedural box, which has the wrong
 * silhouette as well as the wrong colour.
 *
 * WHAT IS NOT LOST: geometry. The exported triangle counts match `poly_count` in
 * `catalog/manifest.json` exactly, and the bounding boxes match its measured `dims_m`.
 *
 * Usage:
 *   node scripts/usdz-to-glb.mjs <name> [<name> ...]
 * where <name> is the basename of a file in `catalog/usdz/`, e.g. `ottoman_leather_01`.
 * Writes `catalog/generated/assets/<sha256>.glb` and prints the manifest fields to paste.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// three's loaders and exporters assume a browser. Only these three globals are actually
// reached, and only on the texture path, which this script deliberately does not use.
globalThis.Image = class {
  set src(_value) {}
  addEventListener() {}
  removeEventListener() {}
};
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
/** GLTFExporter uses this solely to read its own Blob back as an ArrayBuffer. */
globalThis.FileReader = class {
  constructor() {
    this.onloadend = null;
    this.result = null;
  }
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const THREE = await import(join(root, 'node_modules/three/build/three.module.js'));
const { USDLoader } = await import(join(root, 'node_modules/three/examples/jsm/loaders/USDLoader.js'));
const { GLTFExporter } = await import(join(root, 'node_modules/three/examples/jsm/exporters/GLTFExporter.js'));

async function convert(name) {
  const source = join(root, 'catalog/usdz', `${name}.usdz`);
  const bytes = readFileSync(source);
  const group = new USDLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

  // Flatten to a colour-only standard material. An undecoded texture would otherwise be
  // carried into the export as a broken image reference and fail `validateGlb`.
  group.traverse((object) => {
    if (!object.isMesh) return;
    const original = Array.isArray(object.material) ? object.material[0] : object.material;
    object.material = new THREE.MeshStandardMaterial({
      color: original?.color ? original.color.clone() : new THREE.Color(0xcccccc),
      roughness: original?.roughness ?? 0.8,
      metalness: original?.metalness ?? 0,
    });
  });

  const glb = await new Promise((resolve, reject) =>
    new GLTFExporter().parse(group, resolve, reject, { binary: true }),
  );
  const buffer = Buffer.from(glb);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  writeFileSync(join(root, 'catalog/generated/assets', `${sha256}.glb`), buffer);

  group.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  let triangles = 0;
  group.traverse((object) => {
    if (!object.isMesh) return;
    triangles +=
      (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });

  return {
    name,
    sha256,
    bytes: buffer.length,
    triangles: Math.round(triangles),
    // MEASURED, not guessed. `catalog/manifest.json` carries RealityKit-measured `dims_m`
    // for these assets and the export agrees with it, so the declared size is the real one
    // and `useCatalogMesh` scales by ~1.0 instead of distorting the mesh to fit a default.
    dimensionsM: {
      width: Number(size.x.toFixed(4)),
      height: Number(size.y.toFixed(4)),
      depth: Number(size.z.toFixed(4)),
    },
  };
}

const names = process.argv.slice(2);
if (!names.length) {
  console.error('usage: node scripts/usdz-to-glb.mjs <name> [<name> ...]');
  process.exit(1);
}
for (const name of names) {
  const result = await convert(name);
  console.log(JSON.stringify(result));
}
