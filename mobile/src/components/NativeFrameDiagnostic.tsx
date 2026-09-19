import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { useFrame, useThree } from '@react-three/fiber/native';
import { Matrix4 } from 'three';
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import { nativeTextureSource } from '../adapters/frame-textures';
import { TextureFrameStream, type TextureFrame } from '../runtime/frame-textures';
import { ensureContextCanvas } from '../runtime/gl-canvas';

export type FrameDiagnosticMode = 'off' | 'camera' | 'depth' | 'confidence' | 'foreground';
export type FrameDiagnosticSample = {
  ageMs: number; leasedSlots: number; dropped: number; rejected: number; errors: number;
  depth: boolean; foreground: boolean;
};

/** M8-A spike only. Draws native color/depth/mask + same-bundle virtual anchors.
 * It does not perform furniture erasure and cannot turn on the product compositor. */
export function NativeFrameDiagnostic({ frameId, mode, onSample }: {
  frameId: string; mode: Exclude<FrameDiagnosticMode, 'off'>;
  onSample: (sample: FrameDiagnosticSample) => void;
}) {
  const { gl: renderer, size } = useThree();
  const gl = renderer.getContext() as ExpoWebGLRenderingContext;
  const streamRef = useRef<TextureFrameStream | null>(null);
  const setupErrors = useRef(0);
  const active = useRef(AppState.currentState === 'active');
  const resources = useRef<ReturnType<typeof createQuad> | null>(null);
  const matrices = useMemo(() => ({ camera: new Matrix4(), room: new Matrix4() }), []);
  const reportAt = useRef(0);
  const previousAutoClear = useRef(renderer.autoClear);
  useEffect(() => {
    const stream = new TextureFrameStream(nativeTextureSource, {
      contextId: gl.contextId, frameId, width: size.width, height: size.height,
    });
    streamRef.current = stream;
    try { if (active.current) resources.current = createQuad(gl); else stream.dispose(); }
    catch { setupErrors.current++; stream.dispose(); }
    const subscription = AppState.addEventListener('change', state => {
      active.current = state === 'active';
      // A stopped stream is intentionally not revived. Toggle the diagnostic after
      // resuming; this makes reacquisition/generation visible in the feasibility gate.
      if (!active.current) stream.dispose();
    });
    return () => {
      subscription.remove();
      // Native owns texture cleanup; it must still happen if a lost GL context
      // throws while disposing the JS renderer resources.
      stream.dispose();
      streamRef.current = null;
      try {
        resources.current?.dispose();
        if (active.current) { renderer.resetState(); gl.flushEXP(); }
      } catch { setupErrors.current++; }
      resources.current = null;
      renderer.autoClear = previousAutoClear.current;
    };
  }, [gl, renderer, frameId, size.width, size.height]);

  useFrame(({ scene, camera, clock }) => {
    // Blocking GL calls while Expo suspends its queue can hang the JS thread;
    // submitting GPU work in the background is also forbidden by iOS.
    if (!active.current) return;
    const stream = streamRef.current;
    const frame = active.current ? stream?.read() ?? null : null;
    if (active.current) void stream?.poll();
    // three's state reset reads `gl.canvas`, which expo-gl's context does not have.
    ensureContextCanvas(gl);
    renderer.resetState();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (frame && resources.current) {
      resources.current.draw(frame, mode);
      // Never mix the asynchronous metadata/hand stream with these pixels.
      matrices.room.fromArray(frame.roomAnchor).invert();
      matrices.camera.fromArray(frame.cameraToWorld).premultiply(matrices.room);
      matrices.camera.decompose(camera.position, camera.quaternion, camera.scale);
      camera.projectionMatrix.fromArray(frame.projection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      camera.updateMatrixWorld(true);
      renderer.resetState();
      renderer.autoClear = false;
      if (mode === 'camera') renderer.render(scene, camera);
      else gl.endFrameEXP();
    } else gl.endFrameEXP(); // Clear stale pixels; underlying native camera remains visible.
    gl.flushEXP(); // Submit all sampling before the lease can be released/replaced.
    if (clock.elapsedTime - reportAt.current > 0.5) {
      reportAt.current = clock.elapsedTime;
      onSample({ ageMs: stream?.ageMs ?? Infinity, leasedSlots: frame?.leasedSlots ?? 0,
        dropped: frame?.dropped ?? 0, rejected: stream?.rejected ?? 0, errors: (stream?.errors ?? 0) + setupErrors.current,
        depth: !!frame?.textures.depth, foreground: !!frame?.textures.foreground });
    }
  }, 1);
  return null;
}

function createQuad(gl: ExpoWebGLRenderingContext) {
  const vertex = `#version 300 es
    in vec2 position; out vec2 displayUV;
    void main() { gl_Position = vec4(position,0.,1.); displayUV = vec2(position.x*.5+.5,.5-position.y*.5); }`;
  const fragment = `#version 300 es
    precision highp float;
    in vec2 displayUV; out vec4 color;
    uniform mat3 displayToImage;
    uniform sampler2D luma; uniform sampler2D chroma; uniform sampler2D diagnostic;
    uniform int mode; uniform bool available; uniform bool videoRange; uniform bool bt709;
    void main() {
      vec2 uv = (displayToImage * vec3(displayUV,1.)).xy;
      if(any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.)))) { color=vec4(0.,0.,0.,1.); return; }
      if(mode != 0) {
        if(!available) { color=vec4(.4,0.,.4,1.); return; }
        float v=texture(diagnostic,uv).r;
        if(mode==1) v=clamp(v/5.,0.,1.);
        if(mode==2) v=clamp(v*255./2.,0.,1.);
        color=vec4(vec3(v),1.); return;
      }
      float y=texture(luma,uv).r;
      vec2 c=texture(chroma,uv).rg-vec2(128./255.);
      if(videoRange) { y=(y-16./255.)*255./219.; c*=255./224.; }
      vec3 rgb=bt709 ? vec3(y+1.5748*c.y,y-.187324*c.x-.468124*c.y,y+1.8556*c.x)
        : vec3(y+1.402*c.y,y-.344136*c.x-.714136*c.y,y+1.772*c.x);
      color=vec4(clamp(rgb,0.,1.),1.);
    }`;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Native-frame diagnostic shader allocation failed');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
      throw new Error(`Native-frame diagnostic shader: ${error}`);
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  let fs: WebGLShader;
  try { fs = compile(gl.FRAGMENT_SHADER, fragment); }
  catch (error) { gl.deleteShader(vs); throw error; }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs); gl.deleteShader(fs);
    throw new Error('Native-frame diagnostic program allocation failed');
  }
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program); gl.deleteProgram(program);
    throw new Error(`Native-frame diagnostic link: ${error}`);
  }
  const buffer = gl.createBuffer(), vao = gl.createVertexArray();
  if (!buffer || !vao) {
    gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteProgram(program);
    throw new Error('Native-frame diagnostic geometry allocation failed');
  }
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const uniforms = Object.fromEntries(['displayToImage','luma','chroma','diagnostic','mode',
    'available','videoRange','bt709'].map(name => [name, gl.getUniformLocation(program, name)]));
  return {
    draw(frame: TextureFrame, mode: Exclude<FrameDiagnosticMode, 'off'>) {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.depthMask(false); gl.useProgram(program); gl.bindVertexArray(vao);
      const bind = (name: string, slot: number, id: number) => {
        gl.activeTexture(gl.TEXTURE0 + slot);
        // Expo's own createCameraTextureAsync uses this process-local wrapper.
        gl.bindTexture(gl.TEXTURE_2D, { id } as WebGLTexture);
        gl.uniform1i(uniforms[name]!, slot);
      };
      bind('luma', 0, frame.textures.luma.id); bind('chroma', 1, frame.textures.chroma.id);
      const diagnostic = mode === 'camera' ? undefined : frame.textures[mode];
      bind('diagnostic', 2, diagnostic?.id ?? frame.textures.luma.id);
      gl.uniformMatrix3fv(uniforms.displayToImage!, false, frame.displayToImage);
      gl.uniform1i(uniforms.mode!, ['camera','depth','confidence','foreground'].indexOf(mode));
      gl.uniform1i(uniforms.available!, diagnostic ? 1 : 0);
      gl.uniform1i(uniforms.videoRange!, frame.videoRange ? 1 : 0);
      gl.uniform1i(uniforms.bt709!, frame.bt709 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null); gl.depthMask(true);
    },
    dispose() { gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); },
  };
}
