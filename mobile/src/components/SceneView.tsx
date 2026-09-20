import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber/native';
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
import { shouldComposite, DEFAULT_COLOR, type ErasureVolume } from '@reality/spatial-engine';
import type { Texture } from 'three';
import { useMaterialMaps } from '../rendering/objects/materials';

// `material_ref` holds either a hex colour (what buildObject writes) or a catalog
// material id (what CHANGE_MATERIAL writes). Only the latter has textures.
const MATERIAL_ID = /^mat_[a-z0-9_]+$/;

/** Used only where nobody has chosen anything, so a new object is not plain blue. */
const DEFAULT_MATERIAL: Record<string, string> = {
  bed: 'mat_boucle_cream',
  sofa: 'mat_boucle_cream',
  chair: 'mat_oak_light',
  table: 'mat_oak_light',
  shelf: 'mat_oak_light',
  storage: 'mat_oak_light',
  frame: 'mat_oak_light',
};

function materialFor(object: Parameters<typeof parts>[1]): string | null {
  const ref = object.material_ref ?? '';
  if (MATERIAL_ID.test(ref)) return ref;
  // A hex that is not the default means someone asked for that colour. Painting a
  // wood grain over it would be overriding a deliberate choice.
  if (ref && ref !== DEFAULT_COLOR) return null;
  return DEFAULT_MATERIAL[object.class] ?? null;
}

function ObjectParts({
  scene,
  object,
  emissive,
  transparent,
  opacity,
  depthWrite,
}: {
  scene: Parameters<typeof parts>[0];
  object: Parameters<typeof parts>[1];
  emissive: string;
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}) {
  // Null whenever there is no material, it has no textures, or the server is
  // unreachable — falling back to exactly the flat colour drawn before.
  const maps = useMaterialMaps(materialFor(object));
  return (
    <>
      {parts(scene, object).map((part) => (
        <mesh key={part.id} position={part.center}>
          <boxGeometry args={part.size} />
          <meshStandardMaterial
            // White under a texture: the albedo already carries the material's own
            // colour, and multiplying by part.color would darken it a second time.
            color={maps ? '#ffffff' : part.color}
            map={maps?.map ?? null}
            normalMap={maps?.normalMap ?? null}
            roughnessMap={maps?.roughnessMap ?? null}
            emissive={emissive}
            transparent={transparent}
            opacity={opacity}
            depthWrite={depthWrite}
          />
        </mesh>
      ))}
    </>
  );
}

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

/**
 * Where the camera stands when the phone is not deciding.
 *
 * Spherical rather than a position, because it is dragged: two fingers move a bearing and
 * an elevation, not an x and a y, and storing the result as a point would mean recovering
 * those two angles from it on every frame.
 *
 * The defaults are exactly the old fixed `[4, 5, 6]` — 8.77m out, 34.8 degrees up, 33.7
 * degrees round — so a room that is never dragged looks precisely as it always did.
 */
export type OrbitState = { azimuth: number; elevation: number; distance: number };

export const restingOrbit = (): OrbitState => ({
  azimuth: Math.atan2(4, 6),
  elevation: Math.asin(5 / Math.sqrt(77)),
  distance: Math.sqrt(77),
});

/** Under the floor and straight overhead are both useless; the second is also degenerate. */
export const ORBIT_LIMITS = { minElevation: 0.08, maxElevation: 1.45, minDistance: 1.2, maxDistance: 40 };

/**
 * Puts the camera back on its tripod, and lets the tripod be moved.
 *
 * `CameraPose` does not merely move the camera — it overwrites the PROJECTION with
 * ARKit's, straight from the frame. Stop feeding it and both are simply left wherever
 * the phone last was, so detaching from the live view drops you at head height inside a
 * wall, looking through a lens whose field of view belongs to a device you are no longer
 * holding. Mounted whenever there is no frame, which is the development room as well.
 *
 * Reads the orbit through a ref and applies it per frame rather than on change: the
 * gesture that drives it is a stream of touch events, and routing sixty of those a second
 * through React state would re-render the whole editor to move a camera.
 */
function DeskCamera({ orbit }: { orbit?: MutableRefObject<OrbitState> }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    // A perspective camera rebuilds its own projection from fov and aspect the moment
    // it is asked; nothing else can undo the matrix that was written over it.
    if ('isPerspectiveCamera' in camera && camera.isPerspectiveCamera) camera.updateProjectionMatrix();
  }, [camera]);
  useFrame(({ camera: live }) => {
    const seat = orbit?.current ?? restingOrbit();
    const flat = Math.cos(seat.elevation) * seat.distance;
    live.position.set(
      flat * Math.sin(seat.azimuth),
      Math.sin(seat.elevation) * seat.distance,
      flat * Math.cos(seat.azimuth),
    );
    // Slightly above the floor: furniture sits on it, so aiming at the plane itself puts
    // half the room above the middle of the screen.
    live.lookAt(0, 0.5, 0);
    live.updateMatrixWorld(true);
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
  orbit,
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
  /** Where the camera stands when there is no frame driving it. Ignored in the live view,
   * where ARKit owns the pose and a dragged one would fight it. */
  orbit?: MutableRefObject<OrbitState>;
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
      {!frame && <DeskCamera orbit={orbit} />}
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
              <ObjectParts
                scene={scene}
                object={object}
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
