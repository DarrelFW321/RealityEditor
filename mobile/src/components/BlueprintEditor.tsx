import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { fitPage, viewToSheet, withinShape, type PlanSheet, type SheetPoint } from '@reality/blueprint';
import { BlueprintView } from './BlueprintView';

/**
 * The plan, touchable.
 *
 * A floor plan is the view in which "is there room for this" is obvious and the camera
 * view is not — you cannot see the far wall and the near wall at once through a phone.
 * So the drawing that was built for export doubles as a way in: the shapes already carry
 * the ids the scene graph uses, and `sheet.projection` already says how metres became
 * points, so the same page reads backwards with no second model of the room.
 *
 * It does NOT edit the drawing. Dragging a shape asks the solver to move the OBJECT, and
 * the solver answers as it always does — it may adjust the move, hold it for a yes, or
 * refuse it, and the plan simply redraws from whatever the scene became. A plan you could
 * edit directly would be a second source of truth for where the furniture is.
 */
export function BlueprintEditor({
  sheet,
  selectedId,
  onSelect,
  onMove,
}: {
  sheet: PlanSheet;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Metres, room space, relative to wherever the object is now. */
  onMove: (id: string, delta: [number, number]) => void;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  /**
   * Everything the responder reads, mirrored.
   *
   * `PanResponder.create` runs once; its handlers would otherwise close over the first
   * render's sheet and keep dragging shapes from a room that has since changed.
   */
  const live = useRef({ sheet, size, onSelect, onMove });
  live.current = { sheet, size, onSelect, onMove };
  /**
   * The gesture in progress, in a ref rather than in state.
   *
   * `drag` below exists to RENDER the ghost; this exists to decide what to do on
   * release. They cannot be the same thing: `PanResponder.create` runs once, so its
   * handlers close over the first render's `drag` forever — which is `null` — and a
   * release that read it would find nothing to move every single time.
   */
  const gesture = useRef({ id: null as string | null, moved: false, dx: 0, dy: 0 });

  /** Touch coordinates to sheet points, through the shared, checkable fit. */
  const toSheetPoint = (x: number, y: number): SheetPoint | null => {
    const box = live.current.size;
    if (!box) return null;
    const fit = fitPage(live.current.sheet, box);
    return fit.scale > 0 ? viewToSheet(fit, x, y) : null;
  };

  const shapes = () =>
    live.current.sheet.primitives.flatMap((p) =>
      p.kind === 'path' && p.id && p.closed ? [{ id: p.id, points: p.points }] : [],
    );

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const point = toSheetPoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
        gesture.current = { id: null, moved: false, dx: 0, dy: 0 };
        if (!point) return;
        // Last drawn wins. Furniture overlaps in plan, and the shape on top is the one
        // a finger is aiming at.
        const hit = [...shapes()].reverse().find((s) => withinShape(point, s.points));
        gesture.current.id = hit?.id ?? null;
        live.current.onSelect(hit?.id ?? null);
        if (hit) setDrag({ id: hit.id, dx: 0, dy: 0 });
      },
      onPanResponderMove: (_event, state) => {
        const page = live.current.sheet;
        const box = live.current.size;
        const id = gesture.current.id;
        if (!id || !box) return;
        const fit = fitPage(page, box).scale;
        if (Math.hypot(state.dx, state.dy) > 4) gesture.current.moved = true;
        gesture.current.dx = state.dx / fit;
        gesture.current.dy = state.dy / fit;
        setDrag({ id, dx: gesture.current.dx, dy: gesture.current.dy });
      },
      onPanResponderRelease: () => {
        const { id, moved, dx, dy } = gesture.current;
        setDrag(null);
        // A tap is a selection and nothing else. Without this every tap would post a
        // zero-length move, and the op log would fill with edits that changed nothing.
        if (!id || !moved) return;
        const scale = live.current.sheet.projection.scale;
        live.current.onMove(id, [dx / scale, dy / scale]);
      },
      onPanResponderTerminate: () => setDrag(null),
    }),
  ).current;

  const selected = sheet.primitives.find(
    (p) => p.kind === 'path' && p.id === (drag?.id ?? selectedId),
  );
  const outline = selected?.kind === 'path' ? selected.points : null;

  return (
    <View style={styles.root}>
      <View
        style={styles.page}
        onLayout={(event) => setSize(event.nativeEvent.layout)}
        {...responder.panHandlers}
      >
        <BlueprintView sheet={sheet} style={StyleSheet.absoluteFill} />
        {outline && (
          <Svg
            viewBox={`0 0 ${sheet.width} ${sheet.height}`}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            {/* Where it would land. Drawn over the page rather than by rebuilding the
                sheet: the sheet is what the room IS, and nothing should redraw it as
                though a move had already happened. */}
            <Polygon
              points={outline
                .map((p) => `${p[0] + (drag?.dx ?? 0)},${p[1] + (drag?.dy ?? 0)}`)
                .join(' ')}
              fill={drag ? 'rgba(45,120,190,0.24)' : 'none'}
              stroke="#2d78be"
              strokeWidth={1.8}
            />
          </Svg>
        )}
      </View>
      <Text style={styles.hint}>
        {drag
          ? 'Release to ask the solver to move it.'
          : selectedId
            ? 'Drag it on the plan, or say what to do with it.'
            : 'Tap a shape to select it. Drag to move it.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  page: {
    aspectRatio: 842 / 595,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    overflow: 'hidden',
  },
  hint: { color: '#c6d6e6', fontSize: 12, textAlign: 'center' },
});
