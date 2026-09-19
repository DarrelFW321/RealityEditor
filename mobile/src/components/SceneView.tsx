import { useMemo, useRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber/native';
import { useCallback, useState } from 'react';
import { Shape, Matrix4, Vector2 } from 'three';
import { roomFromWorld } from '../adapters/room-space';
import { ShellView } from './ShellView';
import type { Shell } from '@reality/contracts';
import { parts, type EngineSnapshot } from '@reality/spatial-engine';
import type { Vec3 } from '@reality/contracts';
import type { TrackedFrame } from '../adapters/roomplan';
import { NativeFrameDiagnostic, type FrameDiagnosticMode, type FrameDiagnosticSample } from './NativeFrameDiagnostic';
import { CompositorView, type CompositorSample } from './CompositorView';
import { PatchView } from './PatchView';
import type { Patch } from '../runtime/patch';
import type { PatchFill } from '../runtime/patches';
import { textureBridgeAvailable } from '../adapters/frame-textures';
import { shouldComposite, type ErasureVolume } from '@reality/spatial-engine';
import type { Texture } from 'three';

function CameraPose({
  frame,
  origin,
}: {
  frame: MutableRefObject<TrackedFrame | null>;
  origin: Vec3;
}) {
  const matrix = useMemo(() => new Matrix4(), []);
  const toRoom = useMemo(() => new Matrix4(), []);
  useFrame(({ camera }) => {
    const current = frame.current;
    if (!current) return;
    // Follow the anchor rather than subtracting a fixed offset: ARKit revises the anchor
    // as it improves its map, and that revision is exactly the drift correction.
    toRoom.fromArray(roomFromWorld(current.roomAnchor, origin));
    matrix.fromArray(current.cameraToWorld).premultiply(toRoom);
    matrix.decompose(camera.position, camera.quaternion, camera.scale);
    camera.projectionMatrix.fromArray(current.projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld(true);
  });
  return null;
}

function RenderDiagnostics({ onSample }: { onSample: (fps: number) => void }) {
  const sample = useRef({ frames: 0, started: 0 });
  useFrame(({ clock }) => {
    const elapsed = clock.elapsedTime;
    if (sample.current.started === 0) sample.current.started = elapsed;
    sample.current.frames += 1;
    const duration = elapsed - sample.current.started;
    if (duration >= 1) {
      onSample(sample.current.frames / duration);
      sample.current = { frames: 0, started: elapsed };
    }
  });
  return null;
}
export function SceneView({
  snapshot,
  selectedId,
  onSelect,
  onPoint,
  onRelease,
  frame,
  origin = [0, 0, 0],
  diagnostics = false,
  shell,
  atlasUri,
  onRenderFps,
  frameDiagnostic = 'off',
  onFrameDiagnostic,
  showShell = true,
  patches,
  erasure,
  onCompositor,
}: {
  snapshot: EngineSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPoint: (point: Vec3, surfaceId: string) => void;
  onRelease: () => void;
  frame?: MutableRefObject<TrackedFrame | null>;
  origin?: Vec3;
  diagnostics?: boolean;
  /** The reconstructed empty-room shell, when one exists. Purely additive. */
  shell?: Shell | null;
  atlasUri?: string | null;
  onRenderFps?: (fps: number) => void;
  frameDiagnostic?: FrameDiagnosticMode;
  onFrameDiagnostic?: (sample: FrameDiagnosticSample) => void;
  /** M8-C live erasure. Absent, empty, or without a shell means it does not run and
   * this component behaves exactly as it did before. */
  /** Draw the shell as the "Show empty room" comparison. Independent of erasure. */
  showShell?: boolean;
  /** Wall patches, registered in room space. Drawn as ordinary geometry. */
  patches?: { patch: Patch; uri: string; fill: PatchFill }[];
  erasure?: { volumes: ErasureVolume[]; retained: ErasureVolume[] } | null;
  onCompositor?: (sample: CompositorSample) => void;
}) {
  const scene = snapshot.previewScene ?? snapshot.scene;
  // Every condition must hold. Erasure is opt-in at every level: no live frame, no
  // shell, no volumes or a diagnostic view showing means the ordinary path renders.
  const [atlas, setAtlasState] = useState<Texture | null>(null);
  // Stable identity: ShellView reports on every texture change, and an inline setter
  // would make that effect re-run every render.
  const setAtlas = useCallback((texture: Texture | null) => setAtlasState(texture), []);
  /**
   * Gated on a live frame and something to erase, and NOTHING ELSE.
   *
   * This previously also required a shell, which is only ever non-null once a
   * reconstruction has completed — so the compositor never mounted, the shader never
   * ran, and "hide it" changed state without changing a pixel. The shell is an
   * improvement to the fill, not a precondition for it: without one the shader fills
   * from the camera pixels surrounding the region.
   */
  const [bridgeFailed, setBridgeFailed] = useState(false);
  const compositing = shouldComposite({
    hasCameraFrame: !!frame,
    diagnosticActive: frameDiagnostic !== 'off',
    // The compositor owns the whole draw while mounted. Without a working native
    // texture bridge it has no camera pixels, so mounting it would replace a working
    // editor with an empty one.
    bridgeUsable: textureBridgeAvailable() && !bridgeFailed,
    erasing: erasure?.volumes.length ?? 0,
  });
  const floor = scene.design.surfaces.find((s) => s.class === 'floor');
  const shape = useMemo(
    () => new Shape(scene.design.bounds.floor_polygon.map((p) => new Vector2(p[0]!, -p[1]!))),
    [scene.design.bounds.floor_polygon],
  );
  const point = (event: ThreeEvent<PointerEvent>, id: string) => {
    event.stopPropagation();
    onPoint([event.point.x, event.point.y, event.point.z], id);
  };
  return (
    <Canvas
      camera={{ position: [4, 5, 6], fov: 50 }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ camera, gl }) => {
        camera.lookAt(0, 0, 0);
        gl.setClearColor('#0c1420', frame ? 0 : 1);
      }}
    >
      {/* The compositor drives the camera pose itself, from the same frame bundle as
          the pixels it draws, so the two must never both run. */}
      {frame && frameDiagnostic === 'off' && !compositing && <CameraPose frame={frame} origin={origin} />}
      {compositing && erasure && (
        <CompositorView
          frameId={snapshot.scene.frameId}
          shell={shell ?? null}
          atlas={atlas}
          volumes={erasure.volumes}
          retained={erasure.retained}
          onSample={onCompositor}
          onUnavailable={() => setBridgeFailed(true)}
        />
      )}
      {frame && frameDiagnostic !== 'off' && onFrameDiagnostic && (
        <NativeFrameDiagnostic frameId={snapshot.scene.frameId} mode={frameDiagnostic} onSample={onFrameDiagnostic} />
      )}
      {onRenderFps && <RenderDiagnostics onSample={onRenderFps} />}
      <ambientLight intensity={1.6} />
      <directionalLight position={[3, 8, 4]} intensity={2} />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={(e) => point(e, floor?.id ?? '')}
        onPointerMove={(e) => {
          if (snapshot.phase === 'held') point(e, floor?.id ?? '');
        }}
        onPointerUp={onRelease}
      >
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color="#576471" transparent opacity={frame ? 0.08 : 0.85} side={2} />
      </mesh>
      {scene.design.surfaces
        .filter((s) => s.class === 'wall' && s.polygon.length >= 4)
        .map((wall) => {
          const a = wall.polygon[0]!,
            b = wall.polygon[1]!;
          const width = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
          const height =
            Math.max(...wall.polygon.map((p) => p[1]!)) -
            Math.min(...wall.polygon.map((p) => p[1]!));
          if (width < 0.1) return null;
          return (
            <mesh
              key={wall.id}
              position={[(a[0]! + b[0]!) / 2, height / 2, (a[2]! + b[2]!) / 2]}
              rotation={[0, -Math.atan2(b[2]! - a[2]!, b[0]! - a[0]!), 0]}
              onPointerDown={(e) => point(e, wall.id)}
            >
              <boxGeometry args={[width, height, 0.01]} />
              <meshStandardMaterial
                color="#9facbf"
                transparent
                opacity={frame ? 0.04 : 0.14}
                depthWrite={false}
              />
            </mesh>
          );
        })}
      {scene.design.objects
        .filter((o) => o.state === 'present')
        .map((object) => {
          const preview = snapshot.preview?.targetId === object.id ? snapshot.preview.pose : null;
          const pose = preview ?? object.pose;
          /**
           * A REAL object is already on screen — the camera is showing it. Painting a
           * box over it hides the thing the user is looking at behind a grey
           * approximation of itself, which reads as the app having masked their
           * furnace rather than having recognised it.
           *
           * So in AR a measured object is drawn only when it needs to be: while it is
           * being carried, or while it is selected, and then faintly. It stays fully
           * pickable either way, because an invisible mesh still receives pointer
           * events, and it remains an obstacle in the index regardless of rendering.
           *
           * With no camera (the development room) there is nothing else to look at, so
           * everything is drawn exactly as before.
           */
          const measured = !!frame && object.provenance !== 'virtual';
          const highlighted = !!preview || selectedId === object.id;
          const ghosted = measured && !highlighted;
          return (
            <group
              key={object.id}
              position={pose.position as Vec3}
              rotation={[0, pose.yaw, 0]}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(object.id);
              }}
            >
              {parts(scene, object).map((part) => (
                <mesh key={part.id} position={part.center}>
                  <boxGeometry args={part.size} />
                  <meshStandardMaterial
                    color={part.color}
                    emissive={
                      // A carried object glows amber where it could not be released, so
                      // drop validity is readable without looking away from the object.
                      preview && snapshot.previewValidity?.ok === false
                        ? '#7a3a12'
                        : selectedId === object.id
                          ? '#214d77'
                          : '#000000'
                    }
                    transparent={ghosted || !!preview}
                    // Not `visible={false}`: an outline of what is selected has to
                    // survive, and a fully hidden mesh cannot show a carry preview.
                    opacity={ghosted ? 0 : measured ? 0.35 : preview ? 0.65 : 1}
                    depthWrite={!ghosted}
                  />
                </mesh>
              ))}
            </group>
          );
        })}
      {/* Hand-drawn erasure boxes. Shown as an outline so the user can see WHAT they
          are masking and aim the next one; the erasure itself happens in the
          compositor, which does not care whether this is drawn. `center` is the BASE
          centre, matching every other volume in the engine, so the mesh is lifted by
          half its height to sit on the floor the user pointed at. */}
      {scene.maskVolumes
        // Once hidden, the compositor is painting that region; drawing the outline on
        // top would put a cyan box over the fill that just replaced it.
        .filter((volume) => !volume.hidden || selectedId === volume.id)
        .map((volume) => (
        <mesh
          key={volume.id}
          position={[volume.center[0], volume.center[1] + volume.size[1] / 2, volume.center[2]]}
          rotation={[0, volume.yaw, 0]}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelect(volume.id);
          }}
        >
          <boxGeometry args={volume.size as Vec3} />
          <meshStandardMaterial
            color={volume.hidden ? '#f0b429' : selectedId === volume.id ? '#f0b429' : '#4fd1c5'}
            transparent
            opacity={volume.hidden ? 0.12 : selectedId === volume.id ? 0.3 : 0.16}
            depthWrite={false}
            wireframe={volume.hidden || selectedId !== volume.id}
          />
        </mesh>
      ))}
      {/* Drawn before the helpers and after the room so it sits behind editable content.
          Renders nothing at all when no shell has been reconstructed. */}
      {patches && patches.length > 0 && <PatchView patches={patches} />}
      {shell && <ShellView shell={shell} atlasUri={atlasUri ?? null} visible={showShell} onAtlas={setAtlas} />}
      {!frame && <gridHelper args={[8, 16, '#677d92', '#334254']} />}
      {diagnostics && (
        <group>
          <axesHelper args={[0.5]} />
          <mesh position={[0, 0.025, 0]}>
            <boxGeometry args={[0.12, 0.05, 0.12]} />
            <meshBasicMaterial color="#ff3b6b" />
          </mesh>
          {scene.design.bounds.floor_polygon.slice(0, 12).map((p, index) => (
            <mesh key={`boundary-${index}`} position={[p[0]!, 0.03, p[1]!]}>
              <sphereGeometry args={[0.035, 8, 8]} />
              <meshBasicMaterial color="#28e0a9" />
            </mesh>
          ))}
        </group>
      )}
    </Canvas>
  );
}
