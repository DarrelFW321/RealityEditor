import { useEffect, useMemo, useState } from 'react';
import { BufferAttribute, BufferGeometry, TextureLoader, type Texture } from 'three';
import type { Shell } from '@reality/contracts';

/**
 * Draws the reconstructed empty-room shell, registered in the room.
 *
 * Strictly additive: this renders only when a shell exists, and `SceneView`'s own floor
 * and wall meshes are untouched. With no shell the scene behaves exactly as before.
 *
 * This is M5's half of the split, not M8's. It draws the clean shell as 3D content aligned
 * to the tracked camera — the PRD's "first usable milestone". It does NOT replace camera
 * pixels, so in AR the real furniture is still visible behind it; that is M8's work and
 * the PRD is explicit that the two are not the same thing.
 */
export function ShellView({
  shell,
  atlasUri,
  visible = true,
  onAtlas,
}: {
  shell: Shell;
  atlasUri: string | null;
  /** The "Show empty room" comparison. Mounted either way so the atlas still loads
   * for the compositor: M8-D.6 keeps that comparison distinct from live erasure. */
  visible?: boolean;
  /** Reports the loaded atlas so the compositor can sample the same upload rather
   * than loading a second copy of the same image into a second GL texture. */
  onAtlas?: (texture: Texture | null) => void;
}) {
  const [loadedAtlas, setLoadedAtlas] = useState<{ uri: string; texture: Texture } | null>(null);
  // Do not render the previous room's texture while a new atlas is loading.
  const texture = loadedAtlas?.uri === atlasUri ? loadedAtlas.texture : null;
  useEffect(() => {
    onAtlas?.(texture);
    // Reported as gone on unmount, so a compositor cannot keep sampling a texture
    // whose owner has been disposed.
    return () => onAtlas?.(null);
  }, [texture, onAtlas]);

  useEffect(() => {
    setLoadedAtlas(null);
    if (!atlasUri) return;
    let cancelled = false;
    let ownedTexture: Texture | null = null;
    // R3F's native entry patches TextureLoader to resolve through expo-asset and upload
    // via EXGL. That path has been installed and unused since the project started; this
    // is its first consumer, which is why the atlas is handed over as a file URI rather
    // than as bytes.
    const loader = new TextureLoader();
    loader.load(
      atlasUri,
      (loaded) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        // The atlas is sampled by explicit UVs, so any wrapping would smear one surface's
        // texels into its neighbour's rectangle rather than tiling anything.
        loaded.flipY = false;
        ownedTexture = loaded;
        setLoadedAtlas({ uri: atlasUri, texture: loaded });
      },
      undefined,
      () => { if (!cancelled) setLoadedAtlas(null); },
    );
    return () => {
      cancelled = true;
      ownedTexture?.dispose();
    };
  }, [atlasUri]);

  const geometries = useMemo(
    () =>
      shell.surfaces.map((surface) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          'position',
          new BufferAttribute(new Float32Array(surface.positions.flat()), 3),
        );
        // The whole point of the shell being self-contained: the RSG `Surface` schema is
        // frozen and has nowhere to hold a UV, so they arrive with the mesh.
        geometry.setAttribute('uv', new BufferAttribute(new Float32Array(surface.uvs.flat()), 2));
        geometry.setIndex(surface.indices);
        geometry.computeVertexNormals();
        return { surface, geometry };
      }),
    [shell],
  );

  useEffect(
    () => () => {
      geometries.forEach(({ geometry }) => geometry.dispose());
    },
    [geometries],
  );

  if (!texture) return null;
  return (
    <group visible={visible}>
      {geometries.map(({ surface, geometry }) => (
        <mesh key={surface.id} geometry={geometry}>
          {/* Unlit: the atlas already contains the room's own baked lighting, so lighting
              it again would double every shadow that was photographed. */}
          <meshBasicMaterial
            map={texture}
            toneMapped={false}
            side={2}
            // A surface whose appearance is mostly invented is dimmed rather than drawn
            // as though it were photographed. Unknown space must not read as verified.
            color={surface.inferred ? '#9aa4ae' : '#ffffff'}
          />
        </mesh>
      ))}
    </group>
  );
}
