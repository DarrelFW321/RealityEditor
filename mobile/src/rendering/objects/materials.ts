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

/** Null until loaded, and null forever if the server is unreachable — callers fall back to flat colour. */
export function useMaterialMaps(id: string | null, repeat = 1): MaterialMaps | null {
  const [maps, setMaps] = useState<MaterialMaps | null>(null);
  useEffect(() => {
    if (!id) {
      setMaps(null);
      return;
    }
    let cancelled = false;
    let owned: MaterialMaps | undefined;
    loadMaterialMaps(id, repeat)
      .then((loaded) => {
        if (cancelled) {
          disposeMaterialMaps(loaded);
          return;
        }
        owned = loaded;
        setMaps(loaded);
      })
      .catch(() => setMaps(null));
    return () => {
      cancelled = true;
      if (owned) disposeMaterialMaps(owned);
      setMaps(null);
    };
  }, [id, repeat]);
  return maps;
}
