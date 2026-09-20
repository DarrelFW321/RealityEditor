import { Box3, Mesh, Texture, Vector3, type Material, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface MeasuredBounds {
  /** Real metres, straight off the mesh — this is what the solver should place. */
  dimensionsM: { width: number; height: number; depth: number };
  /** Translation that puts the object centred on its own footprint, sitting on y=0. */
  offset: [number, number, number];
  triangles: number;
  meshes: number;
  materials: number;
  textures: number;
}

/**
 * Fetches and parses a GLB.
 *
 * `parseAsync` on an ArrayBuffer rather than `load(url)`: it skips three's FileLoader,
 * which React Native patches in a way that drops progress events.
 */
export async function loadGlbFromUrl(url: string, signal?: AbortSignal): Promise<GLTF> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status})`);
  return new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
}

export function measureBounds(scene: Object3D): MeasuredBounds {
  scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(scene);
  if (bounds.isEmpty()) throw new Error('Object has no visible geometry');
  const size = bounds.getSize(new Vector3());
  if (![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error('Object bounds are invalid');
  }

  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  let triangles = 0;
  let meshes = 0;
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    meshes += 1;
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });

  return {
    dimensionsM: { width: size.x, height: size.y, depth: size.z },
    offset: [
      -((bounds.min.x + bounds.max.x) / 2),
      -bounds.min.y,
      -((bounds.min.z + bounds.max.z) / 2),
    ],
    triangles: Math.round(triangles),
    meshes,
    materials: materials.size,
    textures: textures.size,
  };
}

/**
 * Releases everything a GLTF holds. Textures are the part that actually leaks:
 * each one owns a decoded image that GC will not reclaim on its own.
 */
export function disposeGltf(gltf: GLTF) {
  const geometries = new Set<Mesh['geometry']>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();

  for (const scene of gltf.scenes) {
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      }
    });
  }

  for (const texture of textures) {
    const image: unknown = texture.source.data;
    texture.dispose();
    if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
      (image as { close: () => void }).close();
    }
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
