import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { useFrame, useThree } from '@react-three/fiber/native';
import { Matrix4, type Texture } from 'three';
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import type { Shell } from '@reality/contracts';
import type { ErasureVolume } from '@reality/spatial-engine';
import { nativeTextureSource, textureBridgeAvailable } from '../adapters/frame-textures';
import { TextureFrameStream, type TextureFrame } from '../runtime/frame-textures';
import { MAX_SHELL_PLANES, shellPlanes, type ShellPlane } from '../runtime/shell-planes';
import { ensureContextCanvas } from '../runtime/gl-canvas';

/**
 * M8-C: selective camera-pixel replacement.
 *
 * Draws the live camera, and inside the validated erasure region draws the registered
 * shell instead — so removing a real chair reveals the reconstructed wall behind it
 * rather than leaving the chair on screen.
 *
 * STRICTLY ADDITIVE AND OFF BY DEFAULT. It renders nothing unless a caller passes
 * volumes and an available verdict, and when it renders nothing the existing scene path
 * is untouched. Every uncertain pixel keeps the camera: a wrong erasure is a hole in the
 * user's room, while a missed one is merely the feature not firing.
 *
 * One pass, not two. The shell could be rendered to a colour target and sampled, but the
 * shell is a handful of planes and the ray-plane intersection is cheaper than the target,
 * its resize handling and its lifetime — and it samples the atlas at exactly the world
 * point the camera ray reaches, with no reprojection error introduced in between.
 *
 * UNVERIFIED ON HARDWARE. The geometry either side of this shader is checked headlessly
 * (`shell-planes` UV round-trip, `erasure` decision scenarios); the GLSL itself has not
 * run on a device and M8's gate is explicit that a JS export does not validate it.
 */

const MAX_VOLUMES = 8;

export type CompositorSample = {
  ageMs: number;
  erased: number;
  retained: number;
  planes: number;
  dropped: number;
  rejected: number;
  errors: number;
  /** A native bundle arrived at all. False means the bridge is not delivering. */
  frame: boolean;
  /** Scene depth is present. WITHOUT IT THE SHADER ERASES NOTHING, by design. */
  depth: boolean;
  foreground: boolean;
  /** A reconstruction atlas is bound; false means the surrounding-colour fill. */
  atlas: boolean;
  /** The compositing draw actually executed this reporting window. */
  drew: boolean;
};

export function CompositorView({
  frameId,
  shell,
  atlas,
  volumes,
  retained,
  minConfidence = 1,
  onSample,
  onUnavailable,
}: {
  frameId: string;
  /** Null until a reconstruction exists. The fill falls back to surrounding colour. */
  shell: Shell | null;
  /** The loaded atlas. Null means not ready, and then nothing is erased. */
  atlas: Texture | null;
  volumes: ErasureVolume[];
  retained: ErasureVolume[];
  minConfidence?: number;
  onSample?: (sample: CompositorSample) => void;
  /** Called once when the native bridge is not delivering. The caller must then stop
   * rendering this component, or the editor is left showing nothing. */
  onUnavailable?: () => void;
}) {
  const { gl: renderer, size } = useThree();
  const gl = renderer.getContext() as ExpoWebGLRenderingContext;
  const streamRef = useRef<TextureFrameStream | null>(null);
  const resources = useRef<ReturnType<typeof createCompositor> | null>(null);
  const setupErrors = useRef(0);
  const active = useRef(AppState.currentState === 'active');
  const matrices = useMemo(() => ({ room: new Matrix4(), cameraToRoom: new Matrix4(), inverseProjection: new Matrix4() }), []);
  const reportAt = useRef(0);
  const starved = useRef(0);
  const gaveUp = useRef(false);
  const planes = useMemo(() => (shell ? shellPlanes(shell) : []), [shell]);
  const previousAutoClear = useRef(renderer.autoClear);

  /**
   * The atlas's native texture id, or null.
   *
   * three.js owns the upload, so the id has to be read back out of its property map
   * after `initTexture` has actually created it. Under EXGL a WebGLTexture is a
   * process-local `{ id }` wrapper, which is the same shape the frame bundle uses.
   * Anything unexpected here yields null and erasure simply does not run — guessing an
   * id would sample whatever texture happens to live at it.
   */
  const atlasTextureId = useMemo(() => {
    if (!atlas) return null;
    try {
      renderer.initTexture(atlas);
      const handle = (renderer.properties.get(atlas) as { __webglTexture?: { id?: number } })
        ?.__webglTexture;
      return typeof handle?.id === 'number' ? handle.id : null;
    } catch {
      return null;
    }
  }, [atlas, renderer]);

  useEffect(() => {
    const stream = new TextureFrameStream(nativeTextureSource, {
      contextId: gl.contextId,
      frameId,
      width: size.width,
      height: size.height,
    });
    streamRef.current = stream;
    try {
      // Before anything resets GL state. three reads `gl.canvas` during that reset and
      // expo-gl's context has none, which throws inside the render loop and takes the
      // frame with it.
      ensureContextCanvas(gl);
      if (active.current) resources.current = createCompositor(gl);
      else stream.dispose();
    } catch {
      setupErrors.current++;
      stream.dispose();
    }
    const subscription = AppState.addEventListener('change', (state) => {
      active.current = state === 'active';
      // Leases and textures are released on backgrounding (M8-F.4). Not revived here:
      // reacquisition is the caller's decision, and a compositor that silently restarts
      // hides whether the lifecycle actually works.
      if (!active.current) stream.dispose();
    });
    return () => {
      subscription.remove();
      stream.dispose();
      streamRef.current = null;
      try {
        resources.current?.dispose();
        if (active.current) {
          renderer.resetState();
          gl.flushEXP();
        }
      } catch {
        setupErrors.current++;
      }
      resources.current = null;
      renderer.autoClear = previousAutoClear.current;
    };
  }, [gl, renderer, frameId, size.width, size.height]);

  useFrame(({ scene, camera, clock }) => {
    if (!active.current) return;
    const stream = streamRef.current;
    const frame = stream?.read() ?? null;
    void stream?.poll();

    // Cheap and idempotent, and here as well as in the setup effect because the loop
    // can reach this before effects have run.
    ensureContextCanvas(gl);
    renderer.resetState();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (frame && resources.current) {
      starved.current = 0;
      // Room space, from the same bundle as the pixels. Mixing an independently
      // advancing pose with these pixels is the one failure M8-A exists to prevent.
      matrices.room.fromArray(frame.roomAnchor).invert();
      matrices.cameraToRoom.fromArray(frame.cameraToWorld).premultiply(matrices.room);
      matrices.inverseProjection.fromArray(frame.projection).invert();

      resources.current.draw(frame, {
        cameraToRoom: matrices.cameraToRoom,
        inverseProjection: matrices.inverseProjection,
        // Depth is required; without it nothing is erased and this degrades to a plain
        // camera view rather than guessing from the box alone (M8-B.6, M8-C.4).
        // Neither depth nor an atlas gates this any more. A box is a known volume, so
        // the region is a ray-box question; depth only refines it where available.
        volumes,
        retained,
        planes,
        atlasTextureId,
        minConfidence,
      });

      // Virtual content on top, from the same bundle.
      matrices.cameraToRoom.decompose(camera.position, camera.quaternion, camera.scale);
      camera.projectionMatrix.fromArray(frame.projection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      camera.updateMatrixWorld(true);
      renderer.resetState();
      renderer.autoClear = false;
      renderer.render(scene, camera);
    } else {
      // NO FRESH BUNDLE. Never leave a detached patch on screen (M8-F.3), but never
      // leave a BLANK one either: this component owns the whole draw while it is
      // mounted, so ending the frame here and returning would show the user nothing.
      // The scene is still drawn, and after a second of starvation the caller is told
      // to take the normal path back.
      renderer.resetState();
      renderer.autoClear = false;
      renderer.render(scene, camera);
      starved.current += 1;
      if (starved.current > 60 && !gaveUp.current) {
        gaveUp.current = true;
        onUnavailable?.();
      }
    }
    gl.flushEXP();

    if (onSample && clock.elapsedTime - reportAt.current > 0.5) {
      reportAt.current = clock.elapsedTime;
      onSample({
        ageMs: stream?.ageMs ?? Infinity,
        erased: volumes.length,
        retained: retained.length,
        planes: planes.length,
        dropped: frame?.dropped ?? 0,
        rejected: stream?.rejected ?? 0,
        errors: (stream?.errors ?? 0) + setupErrors.current,
        frame: !!frame,
        depth: !!frame?.textures.depth,
        foreground: !!frame?.textures.foreground,
        atlas: atlasTextureId !== null,
        drew: !!frame && !!resources.current,
      });
    }
  }, 1);

  return null;
}

type DrawArgs = {
  cameraToRoom: Matrix4;
  inverseProjection: Matrix4;
  volumes: ErasureVolume[];
  retained: ErasureVolume[];
  planes: ShellPlane[];
  atlasTextureId: number | null;
  minConfidence: number;
};

function createCompositor(gl: ExpoWebGLRenderingContext) {
  const vertex = `#version 300 es
    in vec2 position; out vec2 displayUV;
    void main() {
      gl_Position = vec4(position, 0., 1.);
      displayUV = vec2(position.x * .5 + .5, .5 - position.y * .5);
    }`;

  const fragment = `#version 300 es
    precision highp float;
    in vec2 displayUV; out vec4 color;

    uniform mat3 displayToImage;
    uniform sampler2D luma; uniform sampler2D chroma;
    uniform sampler2D depthMap; uniform sampler2D confidenceMap; uniform sampler2D foregroundMap;
    uniform sampler2D atlas;
    uniform bool hasDepth; uniform bool hasConfidence; uniform bool hasForeground; uniform bool hasAtlas;
    uniform bool videoRange; uniform bool bt709;
    uniform float minConfidence;

    uniform mat4 cameraToRoom; uniform mat4 inverseProjection;

    uniform int eraseCount; uniform int retainCount; uniform int planeCount;
    // xyz = base centre, w = yaw.
    uniform vec4 eraseCentre[${MAX_VOLUMES}]; uniform vec3 eraseSize[${MAX_VOLUMES}];
    uniform vec4 retainCentre[${MAX_VOLUMES}]; uniform vec3 retainSize[${MAX_VOLUMES}];
    // xyz = unit normal, w = plane offset.
    uniform vec4 planeNormal[${MAX_SHELL_PLANES}];
    uniform vec3 planeOrigin[${MAX_SHELL_PLANES}];
    uniform vec2 planeOriginUV[${MAX_SHELL_PLANES}];
    uniform vec3 planeInvU[${MAX_SHELL_PLANES}];
    uniform vec3 planeInvV[${MAX_SHELL_PLANES}];

    vec3 cameraRGB(vec2 uv) {
      float y = texture(luma, uv).r;
      vec2 c = texture(chroma, uv).rg - vec2(128. / 255.);
      if (videoRange) { y = (y - 16. / 255.) * 255. / 219.; c *= 255. / 224.; }
      vec3 rgb = bt709
        ? vec3(y + 1.5748 * c.y, y - .187324 * c.x - .468124 * c.y, y + 1.8556 * c.x)
        : vec3(y + 1.402 * c.y, y - .344136 * c.x - .714136 * c.y, y + 1.772 * c.x);
      return clamp(rgb, 0., 1.);
    }

    // Axis-aligned in the volume's own frame, so only the yaw has to be undone.
    bool inside(vec3 p, vec4 centre, vec3 size, float skin) {
      vec3 d = p - centre.xyz;
      float c = cos(-centre.w), s = sin(-centre.w);
      float lx = d.x * c - d.z * s;
      float lz = d.x * s + d.z * c;
      return abs(lx) <= size.x * .5 + skin && abs(lz) <= size.z * .5 + skin
          && d.y >= -skin && d.y <= size.y + skin;
    }

    // Room-space ray for a display position. Needs no depth.
    void rayFor(vec2 display, out vec3 eye, out vec3 dir) {
      vec2 clip = vec2(display.x * 2. - 1., 1. - display.y * 2.);
      vec4 unprojected = inverseProjection * vec4(clip, -1., 1.);
      vec3 viewRay = unprojected.xyz / unprojected.w;
      eye = (cameraToRoom * vec4(0., 0., 0., 1.)).xyz;
      dir = normalize((cameraToRoom * vec4(viewRay, 0.)).xyz);
    }

    /**
     * Slab test against one oriented box. Returns the near hit distance, or -1.
     *
     * This is what lets a hand-drawn box work WITHOUT scene depth. The box is a known
     * volume, so whether a pixel looks into it is a ray-box question, not a depth
     * question. Depth is still used when present — it is the only way to tell that
     * an object is in FRONT of the box — but its absence must not mean no erasure at
     * all, which is what it meant before and is why nothing ever changed on a device
     * that could not provide it.
     */
    float rayBox(vec3 eye, vec3 dir, vec4 centre, vec3 size) {
      float c = cos(-centre.w), s = sin(-centre.w);
      vec3 d = eye - centre.xyz;
      vec3 o = vec3(d.x * c - d.z * s, d.y - size.y * .5, d.x * s + d.z * c);
      vec3 r = vec3(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);
      // Not named 'half': that is reserved in GLSL ES and fails to compile.
      vec3 extent = size * .5;
      float tmin = -1e9, tmax = 1e9;
      for (int axis = 0; axis < 3; axis++) {
        float ro = axis == 0 ? o.x : axis == 1 ? o.y : o.z;
        float rd = axis == 0 ? r.x : axis == 1 ? r.y : r.z;
        float h = axis == 0 ? extent.x : axis == 1 ? extent.y : extent.z;
        if (abs(rd) < 1e-6) { if (abs(ro) > h) return -1.; continue; }
        float t1 = (-h - ro) / rd, t2 = (h - ro) / rd;
        tmin = max(tmin, min(t1, t2));
        tmax = min(tmax, max(t1, t2));
      }
      if (tmax < max(tmin, 0.)) return -1.;
      return max(tmin, 0.);
    }

    // Whether this pixel should be replaced, and the world point it looks at.
    bool erasedAt(vec2 display, out vec3 world) {
      vec2 uv = (displayToImage * vec3(display, 1.)).xy;
      world = vec3(0.);
      if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return false;
      vec3 eye, dir;
      rayFor(display, eye, dir);

      // Nearest erase box along this ray.
      float boxT = 1e9;
      for (int i = 0; i < ${MAX_VOLUMES}; i++) {
        if (i >= eraseCount) break;
        float t = rayBox(eye, dir, eraseCentre[i], eraseSize[i] + vec3(0.04));
        if (t >= 0. && t < boxT) boxT = t;
      }
      if (boxT > 1e8) return false;
      world = eye + dir * boxT;

      float d = hasDepth ? texture(depthMap, uv).r : 0.;
      if (d > 0.) {
        // With depth: the surface actually seen must be at or beyond the box's near
        // face, or a real object stands in front of it and must be kept.
        vec4 unprojected = inverseProjection * vec4(vec2(display.x * 2. - 1., 1. - display.y * 2.), -1., 1.);
        vec3 viewRay = unprojected.xyz / unprojected.w;
        vec3 seen = (cameraToRoom * vec4(viewRay * (d / max(-viewRay.z, 1e-6)), 1.)).xyz;
        if (distance(seen, eye) < boxT - 0.05) return false;
        world = seen;
      }

      // Retained real furniture is never erased, whichever way the region was decided.
      for (int i = 0; i < ${MAX_VOLUMES}; i++) {
        if (i >= retainCount) break;
        if (inside(world, retainCentre[i], retainSize[i], 0.)) return false;
      }
      return true;
    }

    /**
     * The colour of the surface AROUND this pixel.
     *
     * Marches outward in eight directions and takes the first camera sample that is
     * not itself being erased, averaging what it finds. That is a live jump-flood: the
     * wall and floor immediately around the box are real photographed pixels, so the
     * fill picks up their actual colour and shading rather than a guess.
     *
     * Bounded by construction — eight rays, eight steps — so cost is fixed per erased
     * pixel and zero everywhere else. Returns false when every ray is still inside the
     * region, which happens when a box fills the screen; the caller then keeps the
     * camera rather than inventing a colour.
     */
    bool surroundingColour(vec2 display, out vec3 result) {
      vec3 total = vec3(0.);
      float weight = 0.;
      for (int ray = 0; ray < 8; ray++) {
        float angle = float(ray) * 0.7853981634;
        vec2 step = vec2(cos(angle), sin(angle)) * 0.012;
        for (int hop = 1; hop <= 8; hop++) {
          vec2 at = display + step * float(hop);
          if (any(lessThan(at, vec2(0.))) || any(greaterThan(at, vec2(1.)))) break;
          vec3 ignored;
          if (erasedAt(at, ignored)) continue;
          vec2 uv = (displayToImage * vec3(at, 1.)).xy;
          if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) break;
          // Nearer samples describe this pixel's surroundings better than far ones.
          float w = 1. / float(hop);
          total += cameraRGB(uv) * w;
          weight += w;
          break;
        }
      }
      if (weight <= 0.) return false;
      result = total / weight;
      return true;
    }

    void main() {
      vec2 uv = (displayToImage * vec3(displayUV, 1.)).xy;
      if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) {
        color = vec4(0., 0., 0., 1.); return;
      }
      vec3 camera = cameraRGB(uv);
      color = vec4(camera, 1.);
      if (eraseCount == 0) return;

      // A hand in front of the furniture is not the furniture (M8-C.8).
      if (hasForeground && texture(foregroundMap, uv).r > 0.5) return;
      // ARKit confidence is 0..2 in a byte. Only meaningful alongside depth.
      if (hasDepth && hasConfidence && texture(confidenceMap, uv).r * 255. < minConfidence) return;

      vec3 world;
      if (!erasedAt(displayUV, world)) return;

      // Nearest shell surface BEHIND the furniture, along the same ray.
      vec3 eye = (cameraToRoom * vec4(0., 0., 0., 1.)).xyz;
      vec3 dir = normalize(world - eye);
      float bestT = 1e9; vec2 bestUV = vec2(-1.);
      for (int i = 0; i < ${MAX_SHELL_PLANES}; i++) {
        if (i >= planeCount) break;
        float denom = dot(planeNormal[i].xyz, dir);
        if (abs(denom) < 1e-6) continue;
        float t = (planeNormal[i].w - dot(planeNormal[i].xyz, eye)) / denom;
        if (t <= 0.01 || t >= bestT) continue;
        vec3 hit = eye + dir * t;
        vec3 rel = hit - planeOrigin[i];
        vec2 auv = planeOriginUV[i] + vec2(dot(planeInvU[i], rel), dot(planeInvV[i], rel));
        if (any(lessThan(auv, vec2(0.))) || any(greaterThan(auv, vec2(1.)))) continue;
        bestT = t; bestUV = auv;
      }
      // The reconstructed wall is the better answer when there is one: it carries the
      // real texture, not just its average colour. Without it — no reconstruction yet,
      // or no shell surface along this ray — fall back to the colour of the
      // surroundings, which is what the user asked for and needs no worker at all.
      if (hasAtlas && bestUV.x >= 0.) {
        color = vec4(texture(atlas, bestUV).rgb, 1.);
        return;
      }
      vec3 surrounding;
      if (surroundingColour(displayUV, surrounding)) color = vec4(surrounding, 1.);
    }`;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Compositor shader allocation failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Compositor shader: ${error}`);
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  let fs: WebGLShader;
  try {
    fs = compile(gl.FRAGMENT_SHADER, fragment);
  } catch (error) {
    gl.deleteShader(vs);
    throw error;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Compositor program allocation failed');
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Compositor link: ${error}`);
  }

  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  if (!buffer || !vao) {
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    throw new Error('Compositor geometry allocation failed');
  }
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const names = [
    'displayToImage', 'luma', 'chroma', 'depthMap', 'confidenceMap', 'foregroundMap', 'atlas',
    'hasDepth', 'hasConfidence', 'hasForeground', 'hasAtlas', 'videoRange', 'bt709',
    'minConfidence', 'cameraToRoom', 'inverseProjection',
    'eraseCount', 'retainCount', 'planeCount',
    'eraseCentre', 'eraseSize', 'retainCentre', 'retainSize',
    'planeNormal', 'planeOrigin', 'planeOriginUV', 'planeInvU', 'planeInvV',
  ];
  const uniforms = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));

  // Reused every frame. Allocating these in `draw` would put three arrays per frame in
  // front of the collector at exactly the moment the frame budget matters.
  const centres = new Float32Array(MAX_VOLUMES * 4);
  const sizes = new Float32Array(MAX_VOLUMES * 3);
  const retainCentres = new Float32Array(MAX_VOLUMES * 4);
  const retainSizes = new Float32Array(MAX_VOLUMES * 3);
  const normals = new Float32Array(MAX_SHELL_PLANES * 4);
  const origins = new Float32Array(MAX_SHELL_PLANES * 3);
  const originUVs = new Float32Array(MAX_SHELL_PLANES * 2);
  const invUs = new Float32Array(MAX_SHELL_PLANES * 3);
  const invVs = new Float32Array(MAX_SHELL_PLANES * 3);

  const packVolumes = (list: ErasureVolume[], centre: Float32Array, size: Float32Array) => {
    const count = Math.min(list.length, MAX_VOLUMES);
    for (let i = 0; i < count; i++) {
      const v = list[i]!;
      centre.set([v.center[0], v.center[1], v.center[2], v.yaw], i * 4);
      size.set([v.size[0], v.size[1], v.size[2]], i * 3);
    }
    return count;
  };

  return {
    draw(frame: TextureFrame, args: DrawArgs) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.useProgram(program);
      gl.bindVertexArray(vao);

      const bind = (name: string, slot: number, id: number) => {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, { id } as WebGLTexture);
        gl.uniform1i(uniforms[name]!, slot);
      };
      // Every sampler is bound to something real even when unused: sampling an unbound
      // unit is undefined, and "undefined" on a GPU can mean the last frame's texture.
      const fallback = frame.textures.luma.id;
      bind('luma', 0, frame.textures.luma.id);
      bind('chroma', 1, frame.textures.chroma.id);
      bind('depthMap', 2, frame.textures.depth?.id ?? fallback);
      bind('confidenceMap', 3, frame.textures.confidence?.id ?? fallback);
      bind('foregroundMap', 4, frame.textures.foreground?.id ?? fallback);
      bind('atlas', 5, args.atlasTextureId ?? fallback);

      gl.uniformMatrix3fv(uniforms.displayToImage!, false, frame.displayToImage);
      gl.uniform1i(uniforms.hasDepth!, frame.textures.depth ? 1 : 0);
      gl.uniform1i(uniforms.hasConfidence!, frame.textures.confidence ? 1 : 0);
      gl.uniform1i(uniforms.hasForeground!, frame.textures.foreground ? 1 : 0);
      gl.uniform1i(uniforms.hasAtlas!, args.atlasTextureId !== null ? 1 : 0);
      gl.uniform1i(uniforms.videoRange!, frame.videoRange ? 1 : 0);
      gl.uniform1i(uniforms.bt709!, frame.bt709 ? 1 : 0);
      gl.uniform1f(uniforms.minConfidence!, args.minConfidence);
      gl.uniformMatrix4fv(uniforms.cameraToRoom!, false, args.cameraToRoom.elements);
      gl.uniformMatrix4fv(uniforms.inverseProjection!, false, args.inverseProjection.elements);

      const eraseCount = packVolumes(args.volumes, centres, sizes);
      const retainCount = packVolumes(args.retained, retainCentres, retainSizes);
      const planeCount = Math.min(args.planes.length, MAX_SHELL_PLANES);
      for (let i = 0; i < planeCount; i++) {
        const p = args.planes[i]!;
        normals.set([p.normal[0], p.normal[1], p.normal[2], p.offset], i * 4);
        origins.set(p.origin, i * 3);
        originUVs.set(p.originUV, i * 2);
        invUs.set(p.inverseU, i * 3);
        invVs.set(p.inverseV, i * 3);
      }
      gl.uniform1i(uniforms.eraseCount!, eraseCount);
      gl.uniform1i(uniforms.retainCount!, retainCount);
      gl.uniform1i(uniforms.planeCount!, planeCount);
      gl.uniform4fv(uniforms.eraseCentre!, centres);
      gl.uniform3fv(uniforms.eraseSize!, sizes);
      gl.uniform4fv(uniforms.retainCentre!, retainCentres);
      gl.uniform3fv(uniforms.retainSize!, retainSizes);
      gl.uniform4fv(uniforms.planeNormal!, normals);
      gl.uniform3fv(uniforms.planeOrigin!, origins);
      gl.uniform2fv(uniforms.planeOriginUV!, originUVs);
      gl.uniform3fv(uniforms.planeInvU!, invUs);
      gl.uniform3fv(uniforms.planeInvV!, invVs);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.depthMask(true);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
