import { useEffect, useMemo, useState } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix3,
  TextureLoader,
  type Texture,
} from 'three';
import { FILL_MARGIN, quadHomography, type Patch } from '../runtime/patch';
import type { PatchFill } from '../runtime/patches';

/**
 * Draws the patches on the walls they belong to.
 *
 * Ordinary R3F geometry: a quad, a texture, no native texture bridge, no scene depth.
 * That is the point. The compositor approach needed all three and each one was a place
 * the whole feature could silently do nothing; this needs only that the scene renders
 * at all, which it demonstrably does.
 *
 * It stays registered while the camera moves because the quad is ON the wall in room
 * space — the same reason the M5 shell stays put. Nothing here recomputes per frame.
 */
export function PatchView({ patches }: { patches: { patch: Patch; uri: string; fill: PatchFill }[] }) {
  return (
    <group>
      {patches.map(({ patch, uri, fill }) => (
        <PatchQuad key={patch.volumeId} patch={patch} uri={uri} fill={fill} />
      ))}
    </group>
  );
}

/**
 * The local fill: the region rebuilt from the wall immediately outside it.
 *
 * The texture is the UNMODIFIED photograph, so sampling it at the quad's own UVs would
 * draw the furniture straight back. Instead every fragment is reconstructed from four
 * samples taken just beyond the quad's four edges, weighted by how close the fragment
 * is to each — the boundary colour is reproduced exactly at the boundary and blends
 * smoothly across the interior. On a plain wall, or a wall meeting a floor, that is
 * indistinguishable from the surface continuing behind the object.
 *
 * "Just beyond the edge" is computed in the QUAD'S OWN frame, not in image space. The
 * quad is a rectangle on the wall but its image is a general quadrilateral, so stepping
 * left in image space can walk back across the object instead of off it. `homography`
 * maps the quad's unit square onto the photograph, so evaluating it at s = -margin is
 * genuinely outside the left edge from any viewing angle.
 *
 * `FILL_MARGIN` and the weighting below are shared with `fillAt`, which is the same
 * calculation in TypeScript — so the scenarios assert on the arithmetic this shader
 * actually performs rather than on a second copy of it.
 */
const FILL_VERTEX = `
  varying vec2 vPlane;
  attribute vec2 plane;
  void main() {
    vPlane = plane;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FILL_FRAGMENT = `
  precision highp float;
  uniform sampler2D photo;
  uniform mat3 homography;
  uniform float margin;
  varying vec2 vPlane;

  // The photograph at a point of the quad's own square, clamped so a quad against the
  // frame edge samples the edge pixel rather than wrapping to the far side.
  vec3 sampleAt(vec2 st) {
    vec3 h = homography * vec3(st, 1.0);
    if (abs(h.z) < 1e-6) return vec3(0.5);
    return texture2D(photo, clamp(h.xy / h.z, 0.0, 1.0)).rgb;
  }

  void main() {
    float s = clamp(vPlane.x, 0.0, 1.0);
    float t = clamp(vPlane.y, 0.0, 1.0);
    vec3 left = sampleAt(vec2(-margin, t));
    vec3 right = sampleAt(vec2(1.0 + margin, t));
    vec3 below = sampleAt(vec2(s, -margin));
    vec3 above = sampleAt(vec2(s, 1.0 + margin));
    // Inverse distance to each edge. The floor is 1e-3 rather than 0 so a fragment
    // sitting exactly on an edge stays finite instead of producing a NaN pixel.
    float wl = 1.0 / max(s, 1e-3);
    float wr = 1.0 / max(1.0 - s, 1e-3);
    float wb = 1.0 / max(t, 1e-3);
    float wa = 1.0 / max(1.0 - t, 1e-3);
    vec3 fill = (left * wl + right * wr + below * wb + above * wa) / (wl + wr + wb + wa);
    gl_FragColor = vec4(fill, 1.0);
  }
`;

function PatchQuad({ patch, uri, fill }: { patch: Patch; uri: string; fill: PatchFill }) {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    setTexture(null);
    let cancelled = false;
    let owned: Texture | null = null;
    // R3F's native entry resolves TextureLoader through expo-asset and uploads via
    // EXGL. A data: URI is what the patch arrives as, so nothing touches the
    // filesystem and there is no temporary file to clean up.
    new TextureLoader().load(
      uri,
      (loaded) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        owned = loaded;
        setTexture(loaded);
      },
      undefined,
      () => setTexture(null),
    );
    return () => {
      cancelled = true;
      owned?.dispose();
    };
  }, [uri]);

  const geometry = useMemo(() => {
    const buffer = new BufferGeometry();
    const positions = new Float32Array(patch.corners.flatMap((c) => [c[0], c[1], c[2]]));
    const uvs = new Float32Array(patch.uvs.flatMap(([u, v]) => [u, v]));
    buffer.setAttribute('position', new BufferAttribute(positions, 3));
    buffer.setAttribute('uv', new BufferAttribute(uvs, 2));
    // Where each corner sits in the quad's own square. `buildPatch` emits them as
    // (u0v0, u1v0, u0v1, u1v1), so this is the identity square in the same order and
    // the fill shader gets exact, perspective-correct plane coordinates for free.
    buffer.setAttribute(
      'plane',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    );
    // Two triangles wound the same way so the quad is visible from the side the camera
    // that made it was on.
    buffer.setIndex([0, 1, 2, 2, 1, 3]);
    buffer.computeVertexNormals();
    return buffer;
  }, [patch]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * The quad's square to the photograph. Null for a degenerate quad, which drops this
   * patch to the plain textured path rather than drawing a rectangle of grey.
   */
  const homography = useMemo(() => {
    const solved = quadHomography(patch.uvs);
    return solved ? new Matrix3().set(...(solved as [number, number, number, number, number, number, number, number, number])) : null;
  }, [patch]);

  // Built with the values already in them rather than assigned afterwards: an effect
  // runs after the first paint, which would leave one frame sampling an unset texture.
  // Rebuilt only when the patch or its texture changes, never per frame.
  const uniforms = useMemo(
    () => ({
      photo: { value: texture },
      homography: { value: homography ?? new Matrix3() },
      margin: { value: FILL_MARGIN },
    }),
    [texture, homography],
  );

  // Nothing is drawn until the texture is there. A patch quad with no map is a flat
  // white rectangle on the wall, which is worse than the object it was replacing.
  if (!texture) return null;
  // The inpainted image already has the region filled, so it is sampled directly. The
  // photograph does not, so it is reconstructed.
  const reconstruct = fill === 'local' && !!homography;
  return (
    <mesh geometry={geometry} renderOrder={-1}>
      {reconstruct ? (
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={FILL_VERTEX}
          fragmentShader={FILL_FRAGMENT}
          side={DoubleSide}
          toneMapped={false}
        />
      ) : (
        <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
      )}
    </mesh>
  );
}
