import { createHash } from 'node:crypto';

const ALLOWED_REQUIRED_EXTENSIONS = new Set([
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_texture_transform',
]);

export const GLB_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxTriangles: 400_000,
});

export interface GlbLimits {
  maxBytes?: number;
  maxTriangles?: number;
}

export interface GlbMetadata {
  sha256: string;
  bytes: number;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  images: number;
}

export interface GlbMaterialInput {
  family: string;
  colorHex: string;
  roughness: number;
  metalness: number;
  transmission: number;
}

type Accessor = { count?: number };
type Primitive = {
  mode?: number;
  indices?: number;
  material?: number;
  attributes?: { POSITION?: number };
};
type Pbr = {
  baseColorFactor?: number[];
  baseColorTexture?: { index: number };
  metallicFactor?: number;
  roughnessFactor?: number;
};
type GltfMaterial = { name?: string; pbrMetallicRoughness?: Pbr; extensions?: Record<string, unknown> };
type GltfDocument = {
  asset?: { version?: string };
  animations?: unknown[];
  skins?: unknown[];
  buffers?: { uri?: string }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  meshes?: { primitives?: Primitive[] }[];
  accessors?: Accessor[];
  materials?: GltfMaterial[];
  textures?: unknown[];
};

const MAGIC_GLTF = 0x46546c67;
const MAGIC_JSON = 0x4e4f534a;

export function validateGlb(bytes: Buffer, limits: GlbLimits = {}): GlbMetadata {
  const maxBytes = limits.maxBytes ?? GLB_LIMITS.maxBytes;
  if (!Buffer.isBuffer(bytes)) throw new TypeError('GLB input must be a Buffer');
  if (bytes.length < 28 || bytes.length > maxBytes) throw new Error('GLB size is invalid');
  if (bytes.readUInt32LE(0) !== MAGIC_GLTF) throw new Error('Not a GLB file');
  if (bytes.readUInt32LE(4) !== 2) throw new Error('Only GLB version 2 is supported');
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error('GLB declared length does not match file');

  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== MAGIC_JSON || jsonLength < 2 || 20 + jsonLength > bytes.length) {
    throw new Error('GLB JSON chunk is invalid');
  }
  let document: GltfDocument;
  try {
    document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  } catch {
    throw new Error('GLB JSON cannot be parsed');
  }
  if (document.asset?.version !== '2.0') throw new Error('glTF 2.0 asset metadata is required');
  if (document.animations?.length || document.skins?.length) {
    throw new Error('Animated or skinned assets are not supported yet');
  }
  if ((document.buffers ?? []).some((buffer) => buffer.uri)) throw new Error('External buffers are not allowed');
  if ((document.images ?? []).some((image) => image.uri)) throw new Error('External images are not allowed');

  // PNG/JPEG only. This is load-bearing for the phone, not just defensive: React
  // Native decodes those two and silently fails on WebP embedded in a GLB.
  const imageTypes = new Set(['image/png', 'image/jpeg']);
  if ((document.images ?? []).some((image) => !Number.isInteger(image.bufferView) || !imageTypes.has(image.mimeType ?? ''))) {
    throw new Error('Images must be embedded PNG or JPEG resources');
  }
  if ((document.extensionsRequired ?? []).some((name) => !ALLOWED_REQUIRED_EXTENSIONS.has(name))) {
    throw new Error('GLB requires an unsupported extension');
  }

  let triangles = 0;
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        throw new Error('Only triangle primitives are supported');
      }
      // Non-indexed primitives have no `indices`; their count comes from POSITION.
      const indexed = primitive.indices !== undefined ? document.accessors?.[primitive.indices] : undefined;
      const position = primitive.attributes?.POSITION !== undefined
        ? document.accessors?.[primitive.attributes.POSITION]
        : undefined;
      const count = (indexed ?? position)?.count;
      if (typeof count === 'number') triangles += Math.floor(count / 3);
    }
  }
  if (triangles > (limits.maxTriangles ?? GLB_LIMITS.maxTriangles)) throw new Error('Triangle limit exceeded');
  if ((document.materials?.length ?? 0) > 32) throw new Error('Material limit exceeded');
  if ((document.textures?.length ?? 0) > 16) throw new Error('Texture limit exceeded');

  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    meshes: document.meshes?.length ?? 0,
    triangles,
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    images: document.images?.length ?? 0,
  };
}

// glTF defines baseColorFactor in linear space, so an sRGB hex needs converting
// before it lands there — writing the raw channel value renders too dark.
export function srgbHexToLinear(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Material color must be a six-digit hex value');
  const channel = (byte: number) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [
    channel(Number.parseInt(hex.slice(1, 3), 16)),
    channel(Number.parseInt(hex.slice(3, 5), 16)),
    channel(Number.parseInt(hex.slice(5, 7), 16)),
  ];
}

function rewriteGlbJson(bytes: Buffer, mutate: (document: GltfDocument) => void, limits?: GlbLimits): Buffer {
  validateGlb(bytes, limits);
  const oldJsonLength = bytes.readUInt32LE(12);
  const document: GltfDocument = JSON.parse(bytes.subarray(20, 20 + oldJsonLength).toString('utf8').trim());
  mutate(document);

  const encoded = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(paddedJson);
  const tail = bytes.subarray(20 + oldJsonLength);
  const output = Buffer.alloc(20 + paddedJson.length + tail.length);
  output.writeUInt32LE(MAGIC_GLTF, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(MAGIC_JSON, 16);
  paddedJson.copy(output, 20);
  tail.copy(output, 20 + paddedJson.length);
  validateGlb(output, limits);
  return output;
}

export function applyMaterialToGlb(bytes: Buffer, material: GlbMaterialInput, limits: GlbLimits = GLB_LIMITS): Buffer {
  return rewriteGlbJson(bytes, (document) => {
    if (document.materials?.length) throw new Error('GLB already has materials; refusing to replace them');
    const [r, g, b] = srgbHexToLinear(material.colorHex);
    document.materials = [{
      name: `TextToObject ${material.family}`,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: material.metalness,
        roughnessFactor: material.roughness,
      },
      ...(material.transmission > 0
        ? { extensions: { KHR_materials_transmission: { transmissionFactor: material.transmission } } }
        : {}),
    }];
    for (const mesh of document.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) primitive.material = 0;
    }
    if (material.transmission > 0) {
      document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), 'KHR_materials_transmission'])];
    }
  }, limits);
}

export function tintGlbBaseColor(bytes: Buffer, colorHex: string, limits: GlbLimits = GLB_LIMITS): Buffer {
  const tint = srgbHexToLinear(colorHex);
  return rewriteGlbJson(bytes, (document) => {
    let tinted = 0;
    for (const material of document.materials ?? []) {
      const pbr = material.pbrMetallicRoughness;
      // Only textured materials: an untextured baseColorFactor is already the final
      // colour, so multiplying it would apply the prompt colour twice.
      if (!pbr?.baseColorTexture) continue;
      const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
      pbr.baseColorFactor = [
        (factor[0] ?? 1) * tint[0],
        (factor[1] ?? 1) * tint[1],
        (factor[2] ?? 1) * tint[2],
        factor[3] ?? 1,
      ];
      tinted += 1;
    }
    if (!tinted) throw new Error('GLB has no textured material to tint');
  }, limits);
}
