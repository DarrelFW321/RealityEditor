import { useMemo, useRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber/native';
import { Shape, Matrix4, Vector2 } from 'three';
import { roomFromWorld } from '../adapters/room-space';
import { parts, type EngineSnapshot } from '@reality/spatial-engine';
import type { Vec3 } from '@reality/contracts';
import type { TrackedFrame } from '../adapters/roomplan';

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
  onRenderFps,
}: {
  snapshot: EngineSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPoint: (point: Vec3, surfaceId: string) => void;
  onRelease: () => void;
  frame?: MutableRefObject<TrackedFrame | null>;
  origin?: Vec3;
  diagnostics?: boolean;
  onRenderFps?: (fps: number) => void;
}) {
  const scene = snapshot.previewScene ?? snapshot.scene;
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
      {frame && <CameraPose frame={frame} origin={origin} />}
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
                    transparent={!!preview}
                    opacity={preview ? 0.65 : 1}
                  />
                </mesh>
              ))}
            </group>
          );
        })}
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
