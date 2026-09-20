import { useEffect, useState } from 'react';
import { LinearSRGBColorSpace, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { apiURL } from '../../runtime/api-url';

export interface MaterialMaps {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

export interface CatalogMaterial {
  id: string;
  baseColorHex: string;
  styleTags: string[];
  maps: string[];
}

export async function listMaterials(): Promise<CatalogMaterial[]> {
  const response = await fetch(`${apiURL()}/objects/materials`);
  if (!response.ok) throw new Error(`Materials list failed (${response.status})`);
  return ((await response.json()) as { materials: CatalogMaterial[] }).materials;
}

function load(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    new TextureLoader().load(url, resolve, undefined, () => reject(new Error(`Texture failed: ${url}`)));
  });
}

/**
 * Loads one material's three maps.
 *
 * Colour space is the part that silently goes wrong: the albedo is authored in sRGB,
 * while normal and roughness carry raw numbers and must stay linear. Decoding those
 * two as sRGB washes out the lighting without ever erroring.
 */
export async function loadMaterialMaps(id: string, repeat = 1): Promise<MaterialMaps> {
  const base = `${apiURL()}/objects/materials/${id}`;
  const [map, normalMap, roughnessMap] = await Promise.all([
    load(`${base}/diff.jpg`),
    load(`${base}/nor_gl.jpg`),
    load(`${base}/rough.jpg`),
  ]);

  map.colorSpace = SRGBColorSpace;
  normalMap.colorSpace = LinearSRGBColorSpace;
  roughnessMap.colorSpace = LinearSRGBColorSpace;

  for (const texture of [map, normalMap, roughnessMap]) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(repeat, repeat);
    texture.needsUpdate = true;
  }
  return { map, normalMap, roughnessMap };
}

export function disposeMaterialMaps(maps: MaterialMaps) {
  for (const texture of [maps.map, maps.normalMap, maps.roughnessMap]) {
    const image: unknown = texture.source.data;
    texture.dispose();
    if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
      (image as { close: () => void }).close();
    }
  }
}

/**
 * One decoded copy per material for the app's lifetime.
 *
 * Every object asking for `mat_oak_light` shares these textures. Loading per object
 * instead would mean a fresh 1024² decode per map — about 12MB of GPU memory each
 * time the same oak appears in the room. Six materials fully loaded is the ceiling.
 */
const cache = new Map<string, Promise<MaterialMaps>>();

function sharedMaterialMaps(id: string): Promise<MaterialMaps> {
  let pending = cache.get(id);
  if (!pending) {
    pending = loadMaterialMaps(id).catch((error) => {
      cache.delete(id); // A failed load must not be cached as permanently broken.
      throw error;
    });
    cache.set(id, pending);
  }
  return pending;
}

/** Null until loaded, and null forever if the server is unreachable — callers fall back to flat colour. */
export function useMaterialMaps(id: string | null): MaterialMaps | null {
  const [maps, setMaps] = useState<MaterialMaps | null>(null);
  useEffect(() => {
    if (!id) {
      setMaps(null);
      return;
    }
    let cancelled = false;
    sharedMaterialMaps(id)
      .then((loaded) => {
        if (!cancelled) setMaps(loaded);
      })
      .catch(() => {
        if (!cancelled) setMaps(null);
      });
    // Nothing is disposed here: the textures are shared, so releasing them when one
    // object unmounts would blank every other object using the same material.
    return () => {
      cancelled = true;
    };
  }, [id]);
  return maps;
}
