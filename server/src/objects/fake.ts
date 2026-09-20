import type { ObjectProvider, ObjectProviderResult } from './provider.js';

/** Builds a minimal but structurally valid GLB from a glTF JSON document. */
export function buildGlb(document: unknown, binary = Buffer.alloc(4)): Buffer {
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const paddedBin = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  binary.copy(paddedBin);

  const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + paddedBin.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(output, 20);
  output.writeUInt32LE(paddedBin.length, 20 + paddedJson.length);
  output.writeUInt32LE(0x004e4942, 24 + paddedJson.length);
  paddedBin.copy(output, 28 + paddedJson.length);
  return output;
}

/** Geometry only, no materials — what the real preview stage returns. */
export function fakePreviewGlb(triangles = 300): Buffer {
  return buildGlb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: triangles * 3 }],
  });
}

/** A single PBR material with three embedded JPEG maps — what refine returns. */
export function fakeTexturedGlb(triangles = 300): Buffer {
  return buildGlb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ count: triangles * 3 }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
      },
      normalTexture: { index: 2 },
      doubleSided: true,
    }],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    images: [
      { bufferView: 0, mimeType: 'image/jpeg' },
      { bufferView: 1, mimeType: 'image/jpeg' },
      { bufferView: 2, mimeType: 'image/jpeg' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 4 },
      { buffer: 0, byteOffset: 4, byteLength: 4 },
      { buffer: 0, byteOffset: 8, byteLength: 4 },
    ],
    buffers: [{ byteLength: 12 }],
  }, Buffer.alloc(12));
}

export type FakeBehaviour = 'succeed' | 'fail-preview' | 'fail-refine';

/**
 * Deterministic stand-in for Meshy. Spends nothing, needs no network, and returns
 * the two shapes the pipeline branches on: untextured preview, textured refine.
 */
export class FakeObjectProvider implements ObjectProvider {
  readonly id = 'fake';
  constructor(private behaviour: FakeBehaviour = 'succeed', private triangles = 300) {}

  async preview({ onProgress }: { prompt: string; onProgress?: (p: number) => void }): Promise<ObjectProviderResult> {
    if (this.behaviour === 'fail-preview') throw new Error('Meshy preview failed: fake failure');
    onProgress?.(100);
    return {
      bytes: fakePreviewGlb(this.triangles),
      taskId: 'fake-preview',
      task: { status: 'SUCCEEDED', progress: 100 },
      consumedCredits: 20,
      elapsedMs: 0,
    };
  }

  async refine({ onProgress }: { previewTaskId: string; texturePrompt: string; onProgress?: (p: number) => void }): Promise<ObjectProviderResult> {
    if (this.behaviour === 'fail-refine') throw new Error('Meshy refine failed: fake failure');
    onProgress?.(100);
    return {
      bytes: fakeTexturedGlb(this.triangles),
      taskId: 'fake-refine',
      task: { status: 'SUCCEEDED', progress: 100 },
      consumedCredits: 10,
      elapsedMs: 0,
    };
  }
}
