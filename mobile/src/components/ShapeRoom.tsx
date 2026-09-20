import { useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { InteractionContext } from '@reality/contracts';
import type { Editor } from '../runtime/editor';
import { GlassPanel, GlassPill } from './Glass';
import { RoomPortrait } from './RoomPortrait';

/**
 * The step between measuring a room and filling it.
 *
 * A scan is a record of the room you have, and the room you have is not always the one
 * you are asking about — a wall comes out, a doorway widens, the ceiling is wrong because
 * a beam confused the sweep. Going straight from the sweep into placing furniture assumes
 * the measurement is the question, when often it is the premise.
 *
 * Every edit here is a real one: `offset_wall`, `ceiling_height` and `resize_opening` all
 * existed in the engine and were reachable by speech, and none of them had ever had a
 * control. The solver validates them exactly as it validates everything else — a wall
 * that would land on the furniture is refused whole, and the refusal is what the caption
 * says.
 *
 * Deliberately shell-only. The furniture is hidden because this step is about the space
 * around it, and because a measured sofa in the way of the wall you are dragging invites
 * you to fix the wrong thing.
 */
export function ShapeRoom({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const snapshot = useSyncExternalStore(editor.engine.subscribe, editor.engine.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState(
    'Tap a wall to move it, or a door or window to resize it.',
  );

  const scene = snapshot.scene;
  const surface = scene.design.surfaces.find((s) => s.id === selected) ?? null;
  const walls = useMemo(
    () => scene.design.surfaces.filter((s) => s.class === 'wall' && s.state === 'present'),
    [scene.design.surfaces],
  );

  /** A context for an edit nobody pointed at: the target is carried on the intent. */
  const context = (): InteractionContext => ({
    turnId: `shape-${Date.now()}`,
    clock: 'epoch',
    timestamp: Date.now(),
    revision: scene.revision,
    frameId: scene.frameId,
    selectedId: selected,
    destination: null,
    viewer: null,
  });

  async function apply(intent: Record<string, unknown>) {
    const result = await editor.intent(intent, context());
    setMessage([result.message, ...result.conflicts].join(' ').trim());
  }

  const span = (id: string) => {
    const found = scene.design.surfaces.find((s) => s.id === id);
    if (!found) return { width: 0, height: 0 };
    const points = found.polygon.map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as const);
    let width = 0;
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        width = Math.max(width, Math.hypot(points[j]![0] - points[i]![0], points[j]![2] - points[i]![2]));
    const ys = points.map((p) => p[1]);
    return { width, height: Math.max(...ys) - Math.min(...ys) };
  };

  const isWall = surface?.class === 'wall';
  const isOpening = surface !== null && !isWall;

  return (
    <View style={styles.root}>
      {/* Turning while you are trying to hit a particular wall is maddening, so it stops
          the moment something is chosen and starts again when the choice is dropped. */}
      <View style={styles.stage}>
        <RoomPortrait
          scene={scene}
          showObjects={false}
          spin={selected === null}
          selectedId={selected}
          onSelect={setSelected}
        />
      </View>

      <View style={styles.controls}>
        <GlassPanel style={styles.card}>
          <Text style={styles.title}>
            {isWall
              ? 'Wall'
              : isOpening
                ? surface.class === 'window'
                  ? 'Window'
                  : 'Doorway'
                : 'Shape the room'}
          </Text>
          <Text style={styles.text}>{message}</Text>
          <Text style={styles.detail}>
            {scene.design.bounds.area_m2.toFixed(1)} m² · {walls.length} walls · ceiling{' '}
            {scene.design.bounds.ceiling_height.toFixed(2)} m
          </Text>
        </GlassPanel>

        <View style={styles.row}>
          {isWall && (
            <>
              {/* Positive metres pushes the wall INTO the room, which is the direction
                  that can be refused — the solver checks the furniture it would land on
                  even though none of it is drawn here. */}
              <GlassPill
                label="Move in"
                onPress={() =>
                  void apply({ action: 'structure', structure_kind: 'offset_wall', target_id: selected, metres: 0.1 })
                }
              />
              <GlassPill
                label="Move out"
                onPress={() =>
                  void apply({ action: 'structure', structure_kind: 'offset_wall', target_id: selected, metres: -0.1 })
                }
              />
            </>
          )}
          {isOpening && selected && (
            <>
              <GlassPill
                label="Wider"
                onPress={() => {
                  const { width, height } = span(selected);
                  void apply({
                    action: 'structure',
                    structure_kind: 'resize_opening',
                    target_id: selected,
                    width: width + 0.1,
                    height,
                  });
                }}
              />
              <GlassPill
                label="Narrower"
                onPress={() => {
                  const { width, height } = span(selected);
                  void apply({
                    action: 'structure',
                    structure_kind: 'resize_opening',
                    target_id: selected,
                    width: Math.max(0.3, width - 0.1),
                    height,
                  });
                }}
              />
              <GlassPill
                label="Taller"
                onPress={() => {
                  const { width, height } = span(selected);
                  void apply({
                    action: 'structure',
                    structure_kind: 'resize_opening',
                    target_id: selected,
                    width,
                    height: height + 0.1,
                  });
                }}
              />
            </>
          )}
          {surface === null && (
            <>
              <GlassPill
                label="Ceiling up"
                onPress={() =>
                  void apply({
                    action: 'structure',
                    structure_kind: 'ceiling_height',
                    target_id: scene.design.surfaces.find((s) => s.class === 'ceiling')?.id ?? 'ceiling',
                    metres: scene.design.bounds.ceiling_height + 0.1,
                  })
                }
              />
              <GlassPill
                label="Ceiling down"
                onPress={() =>
                  void apply({
                    action: 'structure',
                    structure_kind: 'ceiling_height',
                    target_id: scene.design.surfaces.find((s) => s.class === 'ceiling')?.id ?? 'ceiling',
                    metres: Math.max(1.8, scene.design.bounds.ceiling_height - 0.1),
                  })
                }
              />
            </>
          )}
          <GlassPill label="Undo" tone="quiet" onPress={() => void apply({ action: 'undo' })} />
        </View>

        <GlassPill label="Looks right" size="large" onPress={onDone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingBottom: 34 },
  stage: { flex: 1, minHeight: 220 },
  controls: { paddingHorizontal: 24, gap: 12, alignItems: 'center' },
  card: {
    alignSelf: 'stretch',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 26,
    overflow: 'hidden',
    gap: 6,
  },
  title: { color: '#f8fbff', fontSize: 20, fontWeight: '600' },
  text: { color: '#dde8f3', fontSize: 15, lineHeight: 21 },
  detail: { color: '#a9dcff', fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
});
