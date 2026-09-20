import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber/native';
import { ExtrudeGeometry, Shape, Vector2, type Group, type Mesh } from 'three';
import { parts } from '@reality/spatial-engine';
import type { EditorState } from '@reality/contracts';

/**
 * A room, as a portrait: the doll's-house cutaway everyone recognises.
 *
 * Deliberately a RENDER rather than an illustration. An illustration would be a picture
 * of somebody else's bedroom that stays a picture of somebody else's bedroom after you
 * have measured your own — and the whole promise of the first screen is that the thing
 * on it becomes yours. The same component draws the sample room before a scan and the
 * measured one after, from the same scene graph the editor edits.
 *
 * Near walls are dropped rather than modelled away. Which walls are near depends on where
 * the camera is, and the room turns, so it is decided every frame from the wall's own
 * inward normal — the one the RSG already stores — instead of being baked in.
 */

/**
 * Dark neutrals, used where a surface has no colour of its own.
 *
 * The room is looked at inside a dark app, over a dark page, next to a dark hero — a
 * cream doll's house in the middle of that reads as a different application. Values are
 * lifted just far enough off the page's own #0c1420 that the slab, the walls and the
 * floor stay distinguishable from each other and from the space around them.
 */
const PAPER = '#2b3646';
const TIMBER = '#3c3228';
const SLAB = 0.14;

const hex = (value: string | undefined, fallback: string) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

type WallPiece = {
  id: string;
  centre: [number, number, number];
  angle: number;
  width: number;
  height: number;
  normal: [number, number];
  colour: string;
};

type Surfaces = {
  /** Null hides the furniture, which is what shaping the space wants to see. */
  showObjects: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
};

function Room({ scene, spin, showObjects, selectedId, onSelect }: { scene: EditorState; spin: boolean } & Surfaces) {
  const design = scene.design;
  const floor = design.bounds.floor_polygon.map((p) => [p[0] ?? 0, p[1] ?? 0] as [number, number]);

  const geometry = useMemo(() => {
    if (floor.length < 3) return null;
    // Mirrored in v so the shape's +y becomes room -z, which is what the -90 degree
    // rotation below expects. Same mapping SceneView uses for the flat floor.
    const shape = new Shape(floor.map((p) => new Vector2(p[0], -p[1])));
    return new ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(floor)]);

  /**
   * The middle of the floor, which is what "inward" is measured against.
   *
   * The schema says a wall normal points into the room and the checked-in fixture
   * obliges, but `buildIndex` normalises wall winding at read time precisely because a
   * real capture does not always. A cutaway that trusted the stored direction would
   * remove the two walls you are looking THROUGH on such a room and leave you staring
   * at the back of the near ones.
   */
  const hub = useMemo<[number, number]>(() => {
    if (!floor.length) return [0, 0];
    return [
      floor.reduce((sum, p) => sum + p[0], 0) / floor.length,
      floor.reduce((sum, p) => sum + p[1], 0) / floor.length,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(floor)]);

  const walls = useMemo<WallPiece[]>(
    () =>
      design.surfaces
        .filter((s) => s.class === 'wall' && s.state === 'present' && s.polygon.length >= 4)
        .map((wall) => {
          const points = wall.polygon.map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as const);
          // The run along the floor, taken as the widest separation so a wall that has
          // been through an offset is measured rather than assumed.
          let a = points[0]!;
          let b = points[1]!;
          let longest = 0;
          for (let i = 0; i < points.length; i++)
            for (let j = i + 1; j < points.length; j++) {
              const d = Math.hypot(points[j]![0] - points[i]![0], points[j]![2] - points[i]![2]);
              if (d > longest) {
                longest = d;
                a = points[i]!;
                b = points[j]!;
              }
            }
          const height = Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]));
          const midX = (a[0] + b[0]) / 2;
          const midZ = (a[2] + b[2]) / 2;
          const stored: [number, number] = [wall.plane.normal[0] ?? 0, wall.plane.normal[2] ?? 0];
          // Turned to face the room if the capture handed it over facing away.
          const inward =
            stored[0] * (hub[0] - midX) + stored[1] * (hub[1] - midZ) >= 0
              ? stored
              : ([-stored[0], -stored[1]] as [number, number]);
          return {
            id: wall.id,
            centre: [midX, height / 2, midZ],
            angle: -Math.atan2(b[2] - a[2], b[0] - a[0]),
            width: longest,
            height: height > 0.2 ? height : design.bounds.ceiling_height,
            normal: inward,
            colour: hex(wall.material_ref, PAPER),
          } satisfies WallPiece;
        })
        .filter((w) => w.width > 0.2),
    [design.surfaces, design.bounds.ceiling_height, hub],
  );

  /** Doors and windows, as panels set into the wall they were cut from. */
  const openings = useMemo(
    () =>
      design.surfaces
        .filter(
          (s) =>
            (s.class === 'door' || s.class === 'window' || s.class === 'opening') &&
            s.state === 'present' &&
            s.polygon.length >= 3,
        )
        .map((surface) => {
          const points = surface.polygon.map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as const);
          let a = points[0]!;
          let b = points[1]!;
          let longest = 0;
          for (let i = 0; i < points.length; i++)
            for (let j = i + 1; j < points.length; j++) {
              const d = Math.hypot(points[j]![0] - points[i]![0], points[j]![2] - points[i]![2]);
              if (d > longest) {
                longest = d;
                a = points[i]!;
                b = points[j]!;
              }
            }
          const low = Math.min(...points.map((p) => p[1]));
          const high = Math.max(...points.map((p) => p[1]));
          return {
            id: surface.id,
            kind: surface.class,
            centre: [(a[0] + b[0]) / 2, (low + high) / 2, (a[2] + b[2]) / 2] as [number, number, number],
            angle: -Math.atan2(b[2] - a[2], b[0] - a[0]),
            width: longest,
            height: Math.max(high - low, 0.1),
          };
        })
        .filter((o) => o.width > 0.15),
    [design.surfaces],
  );

  const group = useRef<Group>(null);
  const panes = useRef<(Mesh | null)[]>([]);
  useFrame(({ camera }, delta) => {
    const turn = group.current;
    if (turn && spin) turn.rotation.y += delta * 0.14;
    const theta = turn?.rotation.y ?? 0;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // From the camera towards the room, flattened: only the horizontal bearing decides
    // which side of the room a wall is on.
    const towards = [-camera.position.x, -camera.position.z];
    const reach = Math.hypot(towards[0]!, towards[1]!) || 1;
    for (let i = 0; i < walls.length; i++) {
      const pane = panes.current[i];
      const wall = walls[i];
      if (!pane || !wall) continue;
      // Three's rotation.y sends (x, z) to (x cos + z sin, -x sin + z cos), which is the
      // same convention the engine's `transform` uses — so the stored normal turns with
      // the room without a second opinion about which way positive is.
      const nx = wall.normal[0] * cos + wall.normal[1] * sin;
      const nz = -wall.normal[0] * sin + wall.normal[1] * cos;
      // An inward normal pointing AWAY from the camera means this wall stands between
      // the viewer and the room. Those are the ones a cutaway removes.
      pane.visible = (nx * towards[0]! + nz * towards[1]!) / reach < 0.05;
    }
  });

  return (
    <group ref={group}>
      {/* Warm from one side, cool from the other, and enough ambient that dark
          surfaces do not collapse into the background they are drawn against. */}
      <ambientLight intensity={1.4} />
      <directionalLight position={[4, 9, 6]} intensity={2.1} color="#ffe6c4" />
      <directionalLight position={[-6, 4, -4]} intensity={1.0} color="#9dc4ff" />
      {/* A lamp nobody has to have bought. Warm, low, inside the room, falling off
          within a couple of metres — it is what stops a dark room reading as an unlit
          one, and it is light rather than furniture, so it invents nothing. */}
      <pointLight position={[0, 0.9, 0]} intensity={15} distance={6} decay={2} color="#ffbf78" />
      {geometry && (
        // Two materials: ExtrudeGeometry groups its caps first and its sides second, so
        // the floor can be lighter than the cut edge it stands on and the slab reads as
        // a solid object rather than a flat sticker.
        <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, -SLAB, 0]}>
          <meshStandardMaterial attach="material-0" color={TIMBER} roughness={0.8} />
          <meshStandardMaterial attach="material-1" color="#241d16" roughness={0.9} />
        </mesh>
      )}
      {walls.map((wall, index) => (
        <mesh
          key={wall.id}
          ref={(mesh) => {
            panes.current[index] = mesh;
          }}
          position={wall.centre}
          rotation={[0, wall.angle, 0]}
          onPointerDown={
            onSelect &&
            ((event) => {
              event.stopPropagation();
              onSelect(wall.id);
            })
          }
        >
          <boxGeometry args={[wall.width, wall.height, 0.08]} />
          <meshStandardMaterial
            color={wall.colour}
            roughness={0.95}
            emissive={selectedId === wall.id ? '#2f6fae' : '#000000'}
          />
          {/* Cove light along the top edge. A CHILD of the wall, so it is hidden with it
              — three hides a subtree when the parent is invisible, which means the
              cutaway needs no second opinion about which strips to draw. */}
          <mesh position={[0, wall.height / 2, 0]}>
            <boxGeometry args={[wall.width, 0.05, 0.13]} />
            <meshBasicMaterial color="#cfe4ff" />
          </mesh>
        </mesh>
      ))}
      {openings.map((opening) => (
        <mesh
          key={opening.id}
          position={opening.centre}
          rotation={[0, opening.angle, 0]}
          onPointerDown={
            onSelect &&
            ((event) => {
              event.stopPropagation();
              onSelect(opening.id);
            })
          }
        >
          {/* Proud of the wall by a couple of centimetres so it is visible from outside
              the cutaway as well as in, and so it is the thing a tap lands on. */}
          <boxGeometry args={[opening.width, opening.height, 0.14]} />
          <meshStandardMaterial
            color={opening.kind === 'window' ? '#7fb2e5' : '#8c6a4a'}
            roughness={0.5}
            emissive={selectedId === opening.id ? '#2f6fae' : '#000000'}
            transparent={opening.kind === 'window'}
            opacity={opening.kind === 'window' ? 0.55 : 1}
          />
        </mesh>
      ))}
      {showObjects && design.objects
        .filter((o) => o.state === 'present')
        .map((object) => (
          <group
            key={object.id}
            position={[
              object.pose.position[0] ?? 0,
              object.pose.position[1] ?? 0,
              object.pose.position[2] ?? 0,
            ]}
            rotation={[0, object.pose.yaw, 0]}
          >
            {parts(scene, object).map((part) => (
              <mesh key={part.id} position={part.center}>
                <boxGeometry args={part.size} />
                <meshStandardMaterial color={hex(part.color, TIMBER)} roughness={0.8} />
              </mesh>
            ))}
          </group>
        ))}
    </group>
  );
}

export function RoomPortrait({
  scene,
  spin = true,
  showObjects = true,
  selectedId,
  onSelect,
}: { scene: EditorState; spin?: boolean } & Partial<Surfaces>) {
  // A long lens from far away. A wide one at this angle bows the floor slab outwards and
  // the room stops reading as a model of a room and starts reading as a fisheye of one.
  const reach = useMemo(() => {
    const xs = scene.design.bounds.floor_polygon.map((p) => p[0] ?? 0);
    const zs = scene.design.bounds.floor_polygon.map((p) => p[1] ?? 0);
    const span = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...zs) - Math.min(...zs),
      scene.design.bounds.ceiling_height,
      1,
    );
    return span * 3.1;
  }, [scene.design.bounds]);
  return (
    <Canvas
      camera={{ position: [reach * 0.72, reach * 0.62, reach * 0.72], fov: 26 }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ camera, gl }) => {
        camera.lookAt(0, 0.6, 0);
        gl.setClearColor('#000000', 0);
      }}
    >
      {/* Tapping past everything is how a selection is cleared, so the canvas takes the
          miss rather than leaving the last choice stuck. */}
      <mesh position={[0, 0, -40]} onPointerDown={onSelect && (() => onSelect(null))}>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Room
        scene={scene}
        spin={spin}
        showObjects={showObjects}
        selectedId={selectedId ?? null}
        onSelect={onSelect}
      />
    </Canvas>
  );
}
