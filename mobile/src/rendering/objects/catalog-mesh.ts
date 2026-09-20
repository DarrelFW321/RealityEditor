import { useEffect, useState } from 'react';
import { Box3, Vector3, type Group } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { apiURL } from '../../runtime/api-url';
import { catalogEntry } from '../../runtime/object-catalog';
import { loadGlbFromUrl } from './load-glb';

export interface CatalogMesh {
  scene: Group;
  /** Uniform factor putting the mesh at the object's declared size. */
  scale: number;
  /** Lifts the mesh so it sits on y=0 and is centred on its own footprint. */
  offset: [number, number, number];
}

/**
 * One decode per distinct mesh for the app's lifetime, shared by every object using it.
 *
 * Two identical chairs must not each decode 8MB of textures. Nothing is disposed for
 * the same reason materials are not: releasing on unmount would blank the other users.
 */
const cache = new Map<string, Promise<GLTF>>();

function sharedGlb(sha256: string): Promise<GLTF> {
  let pending = cache.get(sha256);
  if (!pending) {
    pending = loadGlbFromUrl(`${apiURL()}/objects/assets/${sha256}.glb`).catch((error) => {
      cache.delete(sha256); // A failed fetch must not be cached as permanently broken.
      throw error;
    });
    cache.set(sha256, pending);
  }
  return pending;
}

/**
 * Null until loaded, and null forever if the asset cannot be fetched — callers fall
 * back to the procedural boxes, so a slow or missing mesh is never an empty space.
 */
export function useCatalogMesh(assetRef: string | null | undefined, size: [number, number, number]): CatalogMesh | null {
  const entry = catalogEntry(assetRef);
  const sha = entry?.sha256 ?? null;
  const [gltf, setGltf] = useState<GLTF | null>(null);

  useEffect(() => {
    if (!sha) {
      setGltf(null);
      return;
    }
    let cancelled = false;
    sharedGlb(sha)
      .then((loaded) => !cancelled && setGltf(loaded))
      .catch(() => !cancelled && setGltf(null));
    return () => {
      cancelled = true;
    };
  }, [sha]);

  if (!gltf) return null;

  // Uniform, never per-axis: stretching a mesh to a bounding box distorts both the
  // geometry and the baked texture. The declared size wins on the longest axis.
  const bounds = new Box3().setFromObject(gltf.scene);
  const measured = bounds.getSize(new Vector3());
  const longestMeasured = Math.max(measured.x, measured.y, measured.z);
  if (!Number.isFinite(longestMeasured) || longestMeasured <= 0) return null;
  const scale = Math.max(size[0], size[1], size[2]) / longestMeasured;

  const centre = bounds.getCenter(new Vector3());
  return {
    scene: gltf.scene as Group,
    scale,
    offset: [-centre.x * scale, -bounds.min.y * scale, -centre.z * scale],
  };
}
