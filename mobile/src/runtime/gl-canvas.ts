/**
 * Giving an expo-gl context the `canvas` that three.js assumes every context has.
 *
 * `WebGLRenderer.resetState()` ends in `WebGLState.reset()`, whose last act is:
 *
 *     gl.scissor( 0, 0, gl.canvas.width, gl.canvas.height );
 *     gl.viewport( 0, 0, gl.canvas.width, gl.canvas.height );
 *
 * In a browser `canvas` is a standard read-only property of `WebGLRenderingContext`.
 * On native it is not: expo-gl's context is a plain object of GL entry points, and
 * React Three Fiber builds a canvas SHIM separately and hands it to the renderer as
 * `domElement` — the two are never introduced to each other. So `gl.canvas` is
 * `undefined` and the reset throws `Cannot read property 'width' of undefined`.
 *
 * Which made every path that resets GL state dead on device the moment it first ran.
 * Nothing catches it: it is thrown inside the render loop, so it takes the frame, and
 * the failure looks like the app rather than like the one line that caused it.
 *
 * The shim reports the DRAWING BUFFER rather than copying numbers once. A stored size
 * is wrong after the first rotation, and this is used to set a scissor rectangle.
 */

type ContextLike = {
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  canvas?: { width: number; height: number };
};

/**
 * True when the context has a usable `canvas` afterwards.
 *
 * Idempotent and safe to call every frame: an existing `canvas` is never replaced, so
 * on web the real one stays, and a context that refuses the property reports false
 * rather than throwing — leaving the caller to skip the reset rather than lose the
 * frame to an exception.
 */
export function ensureContextCanvas(gl: ContextLike): boolean {
  if (gl.canvas && typeof gl.canvas.width === 'number') return true;
  try {
    Object.defineProperty(gl, 'canvas', {
      configurable: true,
      value: {
        get width() {
          return gl.drawingBufferWidth;
        },
        get height() {
          return gl.drawingBufferHeight;
        },
      },
    });
  } catch {
    return false;
  }
  return !!gl.canvas && typeof gl.canvas.width === 'number';
}
