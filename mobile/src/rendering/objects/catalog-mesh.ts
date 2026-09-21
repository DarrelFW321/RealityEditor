import { useEffect, useMemo, useState } from 'react';
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

  /**
   * ONE NODE PER OBJECT, sharing one decode.
   *
   * An Object3D has exactly one parent. Handing the cached `gltf.scene` straight to two
   * `<primitive>` elements therefore did not draw it twice — the second mount REPARENTED
   * it and the first silently lost its mesh, so two of the same catalog object made each
   * other jump around the room. Cloning gives each instance its own transform node while
   * three keeps the geometry and materials shared by reference, which is where the eight
   * megabytes actually live, so the cache's whole purpose survives.
   */
  const scene = useMemo(() => (gltf ? (gltf.scene.clone() as Group) : null), [gltf]);

  /**
   * Measured once per clone rather than on every render.
   *
   * `setFromObject` walks the entire hierarchy. It was being run for every catalog object
   * on every re-render — and re-renders are frequent, because selection and destination
   * update at hand-tracking rate whenever voice is live.
   */
  const measured = useMemo(() => {
    if (!scene) return null;
    const bounds = new Box3().setFromObject(scene);
    const size3 = bounds.getSize(new Vector3());
    const longest = Math.max(size3.x, size3.y, size3.z);
    if (!Number.isFinite(longest) || longest <= 0) return null;
    return { longest, centre: bounds.getCenter(new Vector3()), minY: bounds.min.y };
  }, [scene]);

  if (!scene || !measured) return null;

  // Uniform, never per-axis: stretching a mesh to a bounding box distorts both the
  // geometry and the baked texture. The declared size wins on the longest axis.
  const scale = Math.max(size[0], size[1], size[2]) / measured.longest;
  return {
    scene,
    scale,
    offset: [-measured.centre.x * scale, -measured.minY * scale, -measured.centre.z * scale],
  };
}
