import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMaterialToGlb, srgbHexToLinear, tintGlbBaseColor, validateGlb } from './glb.js';
import { buildGlb, fakePreviewGlb, fakeTexturedGlb } from './fake.js';

function documentOf(bytes: Buffer) {
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
}

const PAINTED_WOOD = { family: 'painted_wood', colorHex: '#2867b2', roughness: 0.52, metalness: 0, transmission: 0 };

test('accepts a minimal self-contained static GLB', () => {
  const metadata = validateGlb(buildGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }));
  assert.equal(metadata.meshes, 0);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
});

test('rejects external resources', () => {
  const bytes = buildGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/model.bin' }] });
  assert.throws(() => validateGlb(bytes), /External buffers/);
});

test('rejects malformed headers', () => {
  assert.throws(() => validateGlb(Buffer.alloc(28)), /Not a GLB/);
});

// React Native decodes PNG and JPEG but silently fails on WebP embedded in a GLB,
// so this check is what keeps generated assets renderable on the phone.
test('rejects image formats the phone cannot decode', () => {
  const webp = buildGlb({
    asset: { version: '2.0' },
    images: [{ bufferView: 0, mimeType: 'image/webp' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    buffers: [{ byteLength: 4 }],
  });
  assert.throws(() => validateGlb(webp), /embedded PNG or JPEG/);
});

test('converts sRGB hex to linear for baseColorFactor', () => {
  const [r, g, b] = srgbHexToLinear('#2867b2');
  // glTF baseColorFactor is linear; the naive sRGB values would be 0.157 / 0.404 / 0.698.
  assert.ok(Math.abs(r - 0.021219) < 1e-5, `red was ${r}`);
  assert.ok(Math.abs(g - 0.135633) < 1e-5, `green was ${g}`);
  assert.ok(Math.abs(b - 0.445201) < 1e-5, `blue was ${b}`);
  assert.deepEqual(srgbHexToLinear('#ffffff'), [1, 1, 1]);
  assert.deepEqual(srgbHexToLinear('#000000'), [0, 0, 0]);
});

test('embeds a local material in an untextured preview mesh', () => {
  const document = documentOf(applyMaterialToGlb(fakePreviewGlb(), PAINTED_WOOD));
  assert.equal(document.meshes[0].primitives[0].material, 0);
  assert.equal(document.materials[0].name, 'TextToObject painted_wood');
  assert.deepEqual(document.materials[0].pbrMetallicRoughness.baseColorFactor, [...srgbHexToLinear('#2867b2'), 1]);
});

test('refuses to replace materials that already exist', () => {
  assert.throws(() => applyMaterialToGlb(fakeTexturedGlb(), PAINTED_WOOD), /already has materials/);
});

test('tints a textured material without touching its images', () => {
  const input = fakeTexturedGlb();
  const before = documentOf(input);
  const after = documentOf(tintGlbBaseColor(input, '#2867b2'));
  assert.deepEqual(after.materials[0].pbrMetallicRoughness.baseColorFactor, [...srgbHexToLinear('#2867b2'), 1]);
  assert.ok(after.materials[0].pbrMetallicRoughness.baseColorTexture, 'baseColorTexture survives');
  assert.deepEqual(after.textures, before.textures);
  assert.deepEqual(after.images, before.images);
});

test('tint multiplies an existing baseColorFactor rather than replacing it', () => {
  const grey = buildGlb({
    asset: { version: '2.0' },
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 0, mimeType: 'image/jpeg' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    buffers: [{ byteLength: 4 }],
  });
  const after = documentOf(tintGlbBaseColor(grey, '#ffffff'));
  assert.deepEqual(after.materials[0].pbrMetallicRoughness.baseColorFactor, [0.5, 0.5, 0.5, 1]);
});

test('refuses to tint a GLB with no textured material', () => {
  const untextured = buildGlb({
    asset: { version: '2.0' },
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
  });
  assert.throws(() => tintGlbBaseColor(untextured, '#2867b2'), /no textured material/);
});

test('counts triangles for non-indexed primitives', () => {
  assert.equal(validateGlb(fakePreviewGlb(100)).triangles, 100);
});

test('non-indexed primitives cannot bypass the triangle cap', () => {
  assert.throws(() => validateGlb(fakePreviewGlb(500_000)), /Triangle limit exceeded/);
});
