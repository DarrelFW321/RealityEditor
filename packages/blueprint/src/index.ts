import type { EditorState, Surface } from '@reality/contracts';
import { footprint, swingArcPolygon, type P2 } from '@reality/spatial-engine';
import {
  INK,
  PAGE,
  SCALE_LADDER,
  pointsPerMetre,
  textWidth,
  type PlanLayer,
  type PlanPrimitive,
  type PlanSheet,
  type PlanStroke,
  type SheetPoint,
} from './sheet';

export * from './sheet';

/**
 * The RSG, drawn as a floor plan.
 *
 * WHY THIS EXISTS AT ALL. RoomPlan measures a room and exports USD; it has no 2D floor
 * plan and no PDF, which Apple's own answer to the question confirms. So even with the
 * scan already done, something has to turn geometry into a drawing. It cannot be RoomPlan
 * even in principle: `CapturedRoom` only ever knows the room that was MEASURED, and the
 * whole point of this feature is exporting the room after you have put things in it.
 * Those things exist only in `design`.
 *
 * Pure, and free of React Native, so the milestone gate can build a sheet under plain node
 * and check it without a device — which is the only way any of this is verifiable, given
 * the page itself is drawn by Core Graphics on the phone.
 */

const MARGIN = 28;
/** Right-hand column: title block, legend, notes. */
const PANEL_WIDTH = 196;
/** Breathing room between the border and the plan, and around the plan for its labels. */
const GUTTER = 16;
const LABEL_ROOM = 30;

type Segment = { a: P2; b: P2 };

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: P2) => Math.hypot(v[0], v[1]);
const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function bbox(points: readonly P2[]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function centroid(points: readonly P2[]): P2 {
  if (!points.length) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** XZ of a room-space [x,y,z] corner. The plan is the room seen from directly above. */
const flat = (p: readonly number[]): P2 => [p[0] ?? 0, p[2] ?? 0];

/**
 * The two corners furthest apart in plan, which is a surface's run along its wall.
 *
 * SceneView takes `polygon[0]` and `polygon[1]` because a wall from `roomToSession` is
 * wound so those are the ends. A door cut into that wall, or a surface that has been
 * through `offset_wall`, carries no such promise, and picking the wrong pair silently
 * produces a 4cm-wide door. Measuring is cheap at four corners.
 */
function span(polygon: readonly (readonly number[])[]): Segment | null {
  const points = polygon.map(flat);
  let best: Segment | null = null;
  let bestLength = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const d = len(sub(b, a));
      if (d > bestLength) {
        bestLength = d;
        best = { a, b };
      }
    }
  }
  return bestLength > 1e-6 ? best : null;
}

/**
 * Rotation that keeps a label readable.
 *
 * Text rotated to a wall running right-to-left comes out upside down. Folding the angle
 * into (-90, 90] turns it back the right way up without moving it off the wall.
 */
function readableAngle(degrees: number): number {
  let d = degrees;
  while (d > 90) d -= 180;
  while (d <= -90) d += 180;
  return d;
}

const metres = (n: number) => n.toFixed(2);

/** A label for an object, preferring the VLM's refinement over RoomPlan's category. */
const nameOf = (object: { class: string; refined_class?: string | null }) =>
  object.refined_class ?? object.class;

export type PlanOptions = {
  /** Printed as the drawing's title. */
  title?: string;
  /** Epoch millis. Passed explicitly by the gate so a sheet is reproducible. */
  now?: number;
};

export function buildPlan(scene: EditorState, options: PlanOptions = {}): PlanSheet {
  const design = scene.design;
  const primitives: PlanPrimitive[] = [];
  const path = (
    layer: PlanLayer,
    points: SheetPoint[],
    stroke: PlanStroke | null,
    fill: string | null = null,
    closed = false,
    id?: string,
  ) => {
    if (points.length >= 2 || (fill && points.length >= 3)) {
      primitives.push({ kind: 'path', layer, points, closed, stroke, fill, ...(id ? { id } : {}) });
    }
  };
  const text = (
    layer: PlanLayer,
    at: SheetPoint,
    body: string,
    sizePt: number,
    colour: string,
    extra: Partial<{ align: 'left' | 'centre' | 'right'; baseline: 'top' | 'middle'; rotationDeg: number; bold: boolean }> = {},
  ) => {
    primitives.push({
      kind: 'text',
      layer,
      at,
      text: body,
      sizePt,
      colour,
      align: extra.align ?? 'left',
      baseline: extra.baseline ?? 'top',
      rotationDeg: extra.rotationDeg ?? 0,
      bold: extra.bold ?? false,
    });
  };

  // ---------------------------------------------------------------- what is in the room
  const floor = design.bounds.floor_polygon.map(
    (p) => [p[0] ?? 0, p[1] ?? 0] as P2,
  );
  const present = (s: Surface) => s.state === 'present';
  const walls = design.surfaces.filter((s) => s.class === 'wall' && present(s));
  const openings = design.surfaces.filter(
    (s) => (s.class === 'door' || s.class === 'window' || s.class === 'opening') && present(s),
  );
  const objects = design.objects.filter((o) => o.state === 'present');
  const hulls = objects.map((object) => ({ object, hull: footprint(object) }));

  // ---------------------------------------------------------------- page and scale
  // An object pushed against a wall can overhang the floor polygon, and a plan that
  // clips furniture is wrong in the one way a drawing must never be.
  const extent = bbox([...floor, ...hulls.flatMap((h) => h.hull)]);
  const roomWidth = Math.max(extent.maxX - extent.minX, 0.01);
  const roomDepth = Math.max(extent.maxY - extent.minY, 0.01);

  const border = {
    x: MARGIN,
    y: MARGIN,
    width: PAGE.width - MARGIN * 2,
    height: PAGE.height - MARGIN * 2,
  };
  const panelX = border.x + border.width - PANEL_WIDTH;
  const draw = {
    x: border.x + GUTTER + LABEL_ROOM,
    y: border.y + GUTTER + LABEL_ROOM,
    width: panelX - border.x - (GUTTER + LABEL_ROOM) * 2,
    height: border.height - (GUTTER + LABEL_ROOM) * 2,
  };

  const ratio = SCALE_LADDER.find(
    (r) => roomWidth * pointsPerMetre(r) <= draw.width && roomDepth * pointsPerMetre(r) <= draw.height,
  );
  // A drawing that claims 1:50 and is not 1:50 is a lie a ruler can catch. A room too
  // large for every listed ratio is still worth drawing — it just may not be measured
  // off the page, and says so.
  const scale = ratio
    ? pointsPerMetre(ratio)
    : Math.min(draw.width / roomWidth, draw.height / roomDepth);
  const scaleLabel = ratio ? `1:${ratio}` : 'NOT TO SCALE';

  const roomCentre: P2 = [(extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2];
  const drawCentre: SheetPoint = [draw.x + draw.width / 2, draw.y + draw.height / 2];
  /**
   * Room metres to sheet points.
   *
   * Room +x goes right and room +z goes down the page, which puts room north — the -Z
   * the RSG measures yaw from — at the top, and does it without mirroring: viewed along
   * -Y, (+x right, +z down) is the same handedness the room has.
   */
  const at = (p: P2): SheetPoint => [
    drawCentre[0] + (p[0] - roomCentre[0]) * scale,
    drawCentre[1] + (p[1] - roomCentre[1]) * scale,
  ];

  // ---------------------------------------------------------------- the room itself
  const wallStroke: PlanStroke = { colour: INK.wall, width: 2.4 };
  path('wall', floor.map(at), wallStroke, '#f5f7f9', true);

  // Unmeasured structure must not read as measured structure. An inferred wall is
  // overdrawn dashed rather than drawn differently in the first place, so the room
  // outline stays one continuous shape.
  for (const wall of walls) {
    if (wall.provenance === 'real') continue;
    const run = span(wall.polygon);
    if (!run) continue;
    path('wall_inferred', [at(run.a), at(run.b)], {
      colour: INK.inferred,
      width: 2.4,
      dash: [5, 3],
    });
  }

  // ---------------------------------------------------------------- doors and windows
  let unverifiedSwings = 0;
  for (const opening of openings) {
    const run = span(opening.polygon);
    if (!run) continue;
    const a = at(run.a);
    const b = at(run.b);
    // Break the wall. Drawn in paper rather than by splitting the outline, because the
    // outline is one closed path and cutting holes in it would lose the fill.
    path('opening', [a, b], { colour: INK.paper, width: 3.4 });
    // Jambs: two short ticks square to the run, so a gap still reads as an opening.
    const along = sub(run.b, run.a);
    const runLength = len(along);
    const unit: P2 = [along[0] / runLength, along[1] / runLength];
    const normal: P2 = [-unit[1], unit[0]];
    for (const end of [a, b]) {
      path('opening', [
        [end[0] - normal[0] * 2.6, end[1] - normal[1] * 2.6],
        [end[0] + normal[0] * 2.6, end[1] + normal[1] * 2.6],
      ], { colour: INK.opening, width: 1.1 });
    }

    if (opening.class === 'window') {
      // Two thin lines across the gap: the pane, seen edge-on.
      for (const offset of [-1.3, 1.3]) {
        path('window', [
          [a[0] + normal[0] * offset, a[1] + normal[1] * offset],
          [b[0] + normal[0] * offset, b[1] + normal[1] * offset],
        ], { colour: INK.glass, width: 0.8 });
      }
      continue;
    }
    if (opening.class !== 'door') continue;

    const swing = opening.swing;
    if (!swing) {
      // Every device-captured door today. The engine already refuses to claim a
      // clearance it cannot see; the drawing refuses to draw an arc it cannot know.
      unverifiedSwings += 1;
      continue;
    }
    if (swing.direction === 'sliding') {
      // A leaf parked alongside the opening, offset into the room.
      const inward: P2 = [opening.plane.normal[0] ?? 0, opening.plane.normal[2] ?? 0];
      const push = len(inward) > 1e-6 ? 3.2 : 0;
      path('door', [
        [a[0] + inward[0] * push, a[1] + inward[1] * push],
        [b[0] + inward[0] * push, b[1] + inward[1] * push],
      ], { colour: INK.opening, width: 1.6 });
      continue;
    }
    const arc = swingArcPolygon(opening.polygon, swing, [
      opening.plane.normal[0] ?? 0,
      opening.plane.normal[1] ?? 0,
      opening.plane.normal[2] ?? 0,
    ]);
    // `swingArcPolygon` returns the hinge followed by the swept arc, so the leaf is the
    // hinge joined to where the arc starts and the sweep is the rest.
    const hinge = arc[0];
    const sweep = arc.slice(1);
    if (!hinge || sweep.length < 2) continue;
    // The leaf is drawn OPEN, at the far end of the sweep. Drawing it closed puts it
    // flat along the wall, where it is invisible against the wall line and the door
    // reads as a bare gap with a mysterious arc beside it.
    const open = sweep[sweep.length - 1]!;
    path('door', [at(hinge), at(open)], { colour: INK.opening, width: 1.6 });
    path('door', sweep.map(at), { colour: INK.opening, width: 0.7, dash: [3, 2] });
  }

  // ---------------------------------------------------------------- furniture
  let added = 0;
  for (const { object, hull } of hulls) {
    const isAdded = object.provenance === 'virtual';
    if (isAdded) added += 1;
    path(
      isAdded ? 'object_added' : 'object_measured',
      hull.map(at),
      { colour: isAdded ? INK.added : INK.measured, width: isAdded ? 1.3 : 0.9, ...(isAdded ? {} : { dash: [3, 2] }) },
      isAdded ? INK.addedFill : INK.measuredFill,
      true,
      object.id,
    );

    const layer: PlanLayer = isAdded ? 'object_added' : 'object_measured';
    const seat = centroid(hull);
    const [width = 0, , depth = 0] = object.dimensions;
    const longSide = Math.max(width, depth) * scale;
    const shortSide = Math.min(width, depth) * scale;
    /**
     * Furniture labels run along the object's long axis, the way a plan reads them.
     *
     * `transform` sends local +X to world (cos yaw, -sin yaw), which in sheet space — x
     * from x, y from z — is an angle of exactly -yaw. Local +Z is a quarter turn from it.
     * So the long axis is -yaw when the object is wider than it is deep and -yaw + 90
     * when it is deeper than it is wide, and not the other way around: a desk turned
     * against a wall then gets its label across the 60cm side instead of along the 120cm
     * one, and it overruns the shape it is naming.
     */
    const axisDeg = readableAngle((-object.pose.yaw * 180) / Math.PI + (width >= depth ? 0 : 90));
    /**
     * Longest name that still fits inside the shape, at the largest size that holds it.
     *
     * The fallback to `class` is what keeps a 45cm chair from becoming an anonymous box
     * at 1:50: 'desk chair' does not fit across 25pt but 'chair' does, and RoomPlan's
     * bare category is a worse label than the VLM's refinement but a far better one
     * than nothing.
     */
    const fitted = [
      [nameOf(object), 7],
      [nameOf(object), 5.5],
      [object.class, 5.5],
    ].find(([candidate, pt]) => textWidth(candidate as string, pt as number) <= longSide - 4);
    if (fitted) {
      const [label, size] = fitted as [string, number];
      const room = shortSide >= size * 2.6 + 4;
      const anchor = at(seat);
      /**
       * Stacking happens ACROSS the label, not down the page.
       *
       * Each line is rotated about its own anchor, so an offset in sheet space is an
       * offset along whatever direction the page happens to call down — which for a
       * quarter-turned object is the direction the text itself runs. Both lines then
       * sit in the same column and print through each other. Offsetting along the
       * label's own normal is the only version that survives rotation.
       */
      const radians = (axisDeg * Math.PI) / 180;
      const across: P2 = [-Math.sin(radians), Math.cos(radians)];
      const line = (offset: number): SheetPoint => [
        anchor[0] + across[0] * offset,
        anchor[1] + across[1] * offset,
      ];
      text(layer, line(room ? -size * 0.65 : 0), label, size, isAdded ? INK.added : INK.measured, {
        align: 'centre',
        baseline: 'middle',
        rotationDeg: axisDeg,
      });
      if (room) {
        text(
          layer,
          line(size * 0.7),
          `${metres(width)} x ${metres(depth)}`,
          Math.round(size * 0.85 * 10) / 10,
          INK.dimension,
          { align: 'centre', baseline: 'middle', rotationDeg: axisDeg },
        );
      }
    }
  }

  // ---------------------------------------------------------------- wall lengths
  const hub = centroid(floor);
  for (let i = 0; i < floor.length; i++) {
    const a = floor[i]!;
    const b = floor[(i + 1) % floor.length]!;
    const along = sub(b, a);
    const length = len(along);
    // Below this a label is longer than the wall it measures and only adds clutter.
    if (length < 0.4) continue;
    const unit: P2 = [along[0] / length, along[1] / length];
    const normal: P2 = [-unit[1], unit[0]];
    const centre = mid(a, b);
    // Away from the room, whichever way that is for this winding.
    const outward =
      len(sub([centre[0] + normal[0] * 0.1, centre[1] + normal[1] * 0.1], hub)) >
      len(sub([centre[0] - normal[0] * 0.1, centre[1] - normal[1] * 0.1], hub))
        ? normal
        : ([-normal[0], -normal[1]] as P2);
    const anchor = at(centre);
    text(
      'dimension',
      [anchor[0] + outward[0] * 12, anchor[1] + outward[1] * 12],
      `${metres(length)} m`,
      7.5,
      INK.dimension,
      {
        align: 'centre',
        baseline: 'middle',
        rotationDeg: readableAngle((Math.atan2(along[1], along[0]) * 180) / Math.PI),
      },
    );
  }

  // ---------------------------------------------------------------- north and scale bar
  const northX = draw.x + draw.width - 12;
  const northY = draw.y - 6;
  path('annotation', [
    [northX, northY - 20],
    [northX - 5, northY],
    [northX, northY - 5],
    [northX + 5, northY],
  ], { colour: INK.wall, width: 0.9 }, INK.wall, true);
  text('annotation', [northX, northY + 2], 'N', 8, INK.wall, { align: 'centre', bold: true });

  // Drawn in metres through the same transform as the plan, so it is a measurement of
  // the drawing rather than a statement about it.
  const barMetres = roomWidth >= 6 ? 5 : roomWidth >= 3 ? 2 : 1;
  const barUnit = scale;
  const barX = draw.x;
  const barY = draw.y + draw.height + 16;
  for (let i = 0; i < barMetres; i++) {
    path('annotation', [
      [barX + i * barUnit, barY],
      [barX + (i + 1) * barUnit, barY],
      [barX + (i + 1) * barUnit, barY + 4],
      [barX + i * barUnit, barY + 4],
    ], { colour: INK.wall, width: 0.6 }, i % 2 === 0 ? INK.wall : INK.paper, true);
  }
  text('annotation', [barX, barY + 7], '0', 6.8, INK.dimension, { align: 'centre' });
  text('annotation', [barX + barMetres * barUnit, barY + 7], `${barMetres} m`, 6.8, INK.dimension, {
    align: 'centre',
  });

  // ---------------------------------------------------------------- border and title block
  const frameStroke: PlanStroke = { colour: INK.frame, width: 1 };
  path('frame', [
    [border.x, border.y],
    [border.x + border.width, border.y],
    [border.x + border.width, border.y + border.height],
    [border.x, border.y + border.height],
  ], frameStroke, null, true);
  path('frame', [
    [panelX, border.y],
    [panelX, border.y + border.height],
  ], frameStroke);

  const inferredWalls = walls.filter((w) => w.provenance !== 'real').length;
  const stamp = new Date(options.now ?? Date.now()).toISOString().slice(0, 10);
  let cursor = border.y + 16;
  const left = panelX + 14;
  const right = border.x + border.width - 14;
  const rule = () => {
    path('title', [[left, cursor], [right, cursor]], { colour: INK.note, width: 0.5 });
    cursor += 12;
  };
  const row = (label: string, value: string) => {
    text('title', [left, cursor], label.toUpperCase(), 6.8, INK.note, { baseline: 'top' });
    text('title', [right, cursor], value, 8.5, INK.wall, { align: 'right', baseline: 'top' });
    cursor += 14;
  };

  text('title', [left, cursor], options.title ?? 'FLOOR PLAN', 13, INK.wall, { bold: true });
  cursor += 17;
  text('title', [left, cursor], `Room ${design.room_id}`, 7, INK.note);
  cursor += 12;
  rule();
  row('Scale', scaleLabel);
  row('Overall', `${metres(roomWidth)} x ${metres(roomDepth)} m`);
  row('Floor area', `${design.bounds.area_m2.toFixed(1)} m2`);
  row('Ceiling', `${metres(design.bounds.ceiling_height)} m`);
  row('Furniture', `${added} added / ${objects.length - added} measured`);
  row('Openings', `${openings.length}`);
  row('Drawn', stamp);
  rule();

  text('title', [left, cursor], 'LEGEND', 6.8, INK.note, { bold: true });
  cursor += 12;
  const swatch = (fill: string, stroke: PlanStroke, label: string) => {
    path('title', [
      [left, cursor + 1],
      [left + 16, cursor + 1],
      [left + 16, cursor + 8],
      [left, cursor + 8],
    ], stroke, fill, true);
    text('title', [left + 22, cursor], label, 7, INK.wall);
    cursor += 13;
  };
  swatch(INK.addedFill, { colour: INK.added, width: 1.3 }, 'Added in the editor');
  swatch(INK.measuredFill, { colour: INK.measured, width: 0.9, dash: [3, 2] }, 'Measured by the scan');
  path('title', [[left, cursor + 4], [left + 16, cursor + 4]], { colour: INK.inferred, width: 2.4, dash: [5, 3] });
  text('title', [left + 22, cursor], 'Inferred wall', 7, INK.wall);
  cursor += 13;
  path('title', [[left, cursor + 2], [left + 16, cursor + 2]], { colour: INK.glass, width: 0.8 });
  path('title', [[left, cursor + 6], [left + 16, cursor + 6]], { colour: INK.glass, width: 0.8 });
  text('title', [left + 22, cursor], 'Window', 7, INK.wall);
  cursor += 15;
  rule();

  text('title', [left, cursor], 'NOTES', 6.8, INK.note, { bold: true });
  cursor += 11;
  const notes = [
    'Measured with RoomPlan on device. Dimensions are',
    'scan-derived and are not a survey.',
  ];
  // Agreement, because "1 wall shown dashed were not measured" is the kind of sentence
  // that makes a reader doubt the measurements too.
  if (inferredWalls > 0)
    notes.push(
      inferredWalls === 1
        ? 'The wall shown dashed was not measured'
        : `The ${inferredWalls} walls shown dashed were not measured`,
      'directly.',
    );
  if (unverifiedSwings > 0)
    notes.push(
      unverifiedSwings === 1
        ? 'One door is drawn as a plain opening:'
        : `${unverifiedSwings} doors are drawn as plain openings:`,
      'the scan did not report a swing.',
    );
  for (const note of notes) {
    text('title', [left, cursor], note, 6.8, INK.note);
    cursor += 9.5;
  }

  return {
    width: PAGE.width,
    height: PAGE.height,
    scaleRatio: ratio ?? null,
    scaleLabel,
    // The same affine `at` applied, written down. Recomputing it anywhere else would be
    // a second definition of where the room is on the page.
    projection: {
      scale,
      offsetX: drawCentre[0] - roomCentre[0] * scale,
      offsetY: drawCentre[1] - roomCentre[1] * scale,
    },
    primitives,
  };
}
