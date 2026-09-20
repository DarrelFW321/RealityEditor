/**
 * Blueprint gate: `npm run gate:blueprint`, and part of `npm run gate`.
 *
 * The page is inked by Core Graphics on a phone, which no check here can reach. What it
 * can reach is every decision that put a line where it is — and that is deliberately all
 * of them, because `buildPlan` is pure and the two renderers are transcriptions. A wall
 * in the wrong place is a failure in this file; a wall that is the wrong shade of grey is
 * not, and is not pretended to be.
 *
 * Same shape as `workers/reconstruction/selftest.py`: a runner, not a test framework.
 */
import { sampleRoom, sampleRoomFurnished } from '@reality/dev-scenarios';
import { footprint } from '@reality/spatial-engine';
import type { EditorState, SceneObject } from '@reality/contracts';
import {
  buildPlan,
  fitPage,
  PAGE,
  pointsPerMetre,
  SCALE_LADDER,
  toRoom,
  toSheet,
  viewToSheet,
  withinShape,
  type PlanSheet,
} from './src/index';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

type Step = { label: string; ok: boolean; detail: string };
const steps: Step[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  steps.push({ label, ok, detail });
};

/** Fixed date so two runs of the gate produce the same bytes. */
const NOW = Date.parse('2026-01-01T00:00:00Z');
const plan = (scene: EditorState) => buildPlan(scene, { now: NOW });

const layers = (sheet: PlanSheet, layer: string) => sheet.primitives.filter((p) => p.layer === layer);
const texts = (sheet: PlanSheet) =>
  sheet.primitives.flatMap((p) => (p.kind === 'text' ? [p.text] : []));

/** A table the user placed, so the sheet has something that is not in the scan. */
function added(id: string, position: [number, number, number], yaw = 0): SceneObject {
  return {
    id,
    class: 'table',
    refined_class: 'table',
    provenance: 'virtual',
    state: 'present',
    pose: { position, yaw },
    dimensions: [1.2, 0.74, 0.7],
    pivot: 'base_center',
    material_ref: '#a98561',
    asset_ref: null,
    movable: true,
    salience: 0.5,
  };
}

// ---------------------------------------------------------------- an empty room
{
  const sheet = plan(sampleRoom());
  check('the page is A4 landscape', sheet.width === PAGE.width && sheet.height === PAGE.height,
    `${sheet.width} x ${sheet.height} pt`);
  check('a 4x4m room takes a standard ratio',
    sheet.scaleRatio !== null && (SCALE_LADDER as readonly number[]).includes(sheet.scaleRatio),
    sheet.scaleLabel);
  check('the room outline is drawn once and closed',
    layers(sheet, 'wall').length === 1 && layers(sheet, 'wall')[0]?.kind === 'path' &&
      (layers(sheet, 'wall')[0] as { closed: boolean }).closed,
    `${layers(sheet, 'wall').length} wall paths`);
  check('an empty room reports no furniture',
    texts(sheet).includes('0 added / 0 measured'),
    texts(sheet).find((t) => t.includes('added /')) ?? 'no furniture row');
  check('the drawing says what it is not',
    texts(sheet).some((t) => t.includes('not a survey')),
    'survey disclaimer present');
  // Every coordinate a renderer receives has to be on the page; Core Graphics will
  // silently clip and the preview will silently scale, so neither would ever say so.
  const points = sheet.primitives.flatMap((p) => (p.kind === 'path' ? p.points : [p.at]));
  const inside = points.every(
    (p) => p[0] >= 0 && p[0] <= sheet.width && p[1] >= 0 && p[1] <= sheet.height,
  );
  check('nothing is drawn off the page', inside, `${points.length} points`);
  check('no primitive is degenerate',
    sheet.primitives.every((p) =>
      p.kind === 'text' ? p.text.length > 0 && p.sizePt > 0 : p.points.length >= 2),
    `${sheet.primitives.length} primitives`);
}

// ---------------------------------------------------------------- what was added shows up
{
  const scene = sampleRoom();
  const table = added('obj_added_table', [0.6, 0, -0.4], Math.PI / 6);
  scene.design.objects = [table];
  const sheet = plan(scene);

  const shapes = layers(sheet, 'object_added').filter((p) => p.kind === 'path');
  check('an object added to an empty room is drawn', shapes.length === 1, `${shapes.length} shapes`);
  check('it is labelled', texts(sheet).includes('table'), texts(sheet).join(' | ').slice(0, 60));
  check('its size is printed', texts(sheet).includes('1.20 x 0.70'), 'dimension label');
  check('the title block counts it', texts(sheet).includes('1 added / 0 measured'),
    texts(sheet).find((t) => t.includes('added /')) ?? 'missing');

  // THE ONE CHECK THAT MATTERS. The drawing must be the engine's geometry, not a
  // second opinion about it: same hull, same yaw, same pivot, through the transform
  // the scale implies. A plan that disagrees with the solver is worse than no plan.
  const hull = footprint(table);
  const ratio = sheet.scaleRatio ?? 0;
  const scale = pointsPerMetre(ratio);
  const drawn = (shapes[0] as { points: [number, number][] }).points;
  const edge = (points: readonly (readonly [number, number])[], i: number) => {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const sameShape =
    drawn.length === hull.length &&
    hull.every((_, i) => Math.abs(edge(drawn, i) - edge(hull, i) * scale) < 0.01);
  check('the footprint drawn is the footprint the engine computes', sameShape,
    `${drawn.length} corners, edges ${hull.map((_, i) => (edge(hull, i) * scale).toFixed(1)).join('/')}pt`);

  // A rotated object is the case a naive width/height box gets wrong, so the hull has
  // to be wider than the object is.
  const xs = drawn.map((p) => p[0]);
  check('rotation reaches the drawing',
    Math.max(...xs) - Math.min(...xs) > 1.2 * scale,
    `${((Math.max(...xs) - Math.min(...xs)) / scale).toFixed(2)}m across at 30 degrees`);
}

// ---------------------------------------------------------------- labels lie along the shape
{
  // A desk turned to face a wall: 1.2m wide, 0.6m deep, a quarter turn. The label has
  // 68pt to run along and 34pt across, and putting it across overruns the shape it
  // names. Checked because the off-by-a-quarter-turn version of this reads fine on an
  // unrotated fixture and only breaks on the objects a real scan is full of.
  const scene = sampleRoom();
  const turned = added('obj_turned', [0, 0, 0], Math.PI / 2);
  scene.design.objects = [turned];
  const sheet = plan(scene);
  const label = sheet.primitives.find((p) => p.kind === 'text' && p.text === 'table');
  const rotation = label && label.kind === 'text' ? label.rotationDeg : 0;
  check('a label runs along the long side, not across it',
    Math.abs(Math.abs(rotation) - 90) < 0.001,
    `${rotation.toFixed(1)} degrees for a quarter-turned desk`);

  const upright = sampleRoom();
  upright.design.objects = [added('obj_upright', [0, 0, 0], 0)];
  const uprightLabel = plan(upright).primitives.find((p) => p.kind === 'text' && p.text === 'table');
  check('and stays level on an unturned one',
    uprightLabel?.kind === 'text' && Math.abs(uprightLabel.rotationDeg) < 0.001,
    uprightLabel?.kind === 'text' ? `${uprightLabel.rotationDeg.toFixed(1)} degrees` : 'no label');

  // The name and the size are two lines and must separate ACROSS the text. Offsetting
  // them down the page instead puts both in one column on a turned object, where they
  // print through each other and neither is readable.
  const labels = sheet.primitives.filter((p) => p.kind === 'text' && p.layer === 'object_added');
  const [name, dims] = labels;
  const gap =
    name?.kind === 'text' && dims?.kind === 'text'
      ? Math.hypot(dims.at[0] - name.at[0], dims.at[1] - name.at[1])
      : 0;
  const along =
    name?.kind === 'text' && dims?.kind === 'text' && gap > 0
      ? Math.abs(
          ((dims.at[0] - name.at[0]) * Math.cos((rotation * Math.PI) / 180) +
            (dims.at[1] - name.at[1]) * Math.sin((rotation * Math.PI) / 180)) / gap,
        )
      : 1;
  check('its two lines stack across the label, not along it',
    labels.length === 2 && gap > 5 && along < 0.01,
    `${gap.toFixed(1)}pt apart, ${(along * 100).toFixed(0)}% of it along the text`);
}

// ---------------------------------------------------------------- the plan reads backwards
//
// Everything below is what the touchable plan in the development sheet stands on. A
// drawing that cannot be turned back into the room is a picture, and dragging a shape
// across it would move furniture to somewhere nobody pointed at.
{
  const scene = sampleRoom();
  const table = added('obj_reverse', [1.1, 0, -0.7], Math.PI / 3);
  scene.design.objects = [table];
  const sheet = plan(scene);
  const shape = sheet.primitives.find((p) => p.kind === 'path' && p.layer === 'object_added');

  check('a drawn object carries the id the scene knows it by',
    shape?.kind === 'path' && shape.id === 'obj_reverse',
    shape?.kind === 'path' ? (shape.id ?? 'no id') : 'no shape');

  // The published projection must BE the transform the page was drawn with, not a
  // second one that agrees about the middle and drifts at the edges.
  const drawn = shape?.kind === 'path' ? shape.points : [];
  const hull = footprint(table);
  const reprojected = hull.map((corner) => toSheet(sheet.projection, corner));
  const matches =
    drawn.length === reprojected.length &&
    drawn.every((p, i) => Math.hypot(p[0] - reprojected[i]![0], p[1] - reprojected[i]![1]) < 0.001);
  check('the published projection reproduces the drawing exactly', matches,
    `${drawn.length} corners within 0.001pt`);

  const there: [number, number] = [1.1, -0.7];
  const back = toRoom(sheet.projection, toSheet(sheet.projection, there));
  check('and inverts without drift',
    Math.hypot(back[0] - there[0], back[1] - there[1]) < 1e-9,
    `${back.map((n) => n.toFixed(6)).join(', ')}`);

  // The hit test the plan uses to decide what a finger landed on.
  const centre = toSheet(sheet.projection, there);
  const away = toSheet(sheet.projection, [there[0] + 1.5, there[1]]);
  check('a shape contains its own object and not the floor beside it',
    withinShape(centre, drawn) && !withinShape(away, drawn),
    'hit test agrees with the footprint');

  // A metre right in room space must be a metre right on the page, or a drag lands
  // somewhere the user did not aim.
  const moved = toSheet(sheet.projection, [there[0] + 1, there[1]]);
  check('a metre of room is one scale-step of page',
    Math.abs(moved[0] - centre[0] - sheet.projection.scale) < 1e-9 &&
      Math.abs(moved[1] - centre[1]) < 1e-9,
    `${sheet.projection.scale.toFixed(2)}pt per metre`);

  // The last link: a finger in a letterboxed view. SVG centres the page inside its box,
  // and a handler that forgets the bars is off by half of one everywhere — in the same
  // direction every time, which reads as the app being confidently wrong.
  const box = { width: 300, height: 400 };
  const fit = fitPage(sheet, box);
  const middle = viewToSheet(fit, box.width / 2, box.height / 2);
  check('a touch in the middle of a tall view is the middle of the page',
    Math.abs(middle[0] - sheet.width / 2) < 1e-9 && Math.abs(middle[1] - sheet.height / 2) < 1e-9,
    `letterboxed by ${fit.offsetY.toFixed(1)}pt top and bottom`);

  // And the whole chain at once: touch a shape, drag it, land where you aimed.
  const grabbed = viewToSheet(fit, box.width / 2, box.height / 2);
  const onObject = toSheet(sheet.projection, there);
  const toObject = [onObject[0] - grabbed[0], onObject[1] - grabbed[1]] as const;
  const dragged = viewToSheet(fit, box.width / 2 + toObject[0] * fit.scale, box.height / 2 + toObject[1] * fit.scale);
  check('view to page to room round-trips onto the object',
    withinShape(dragged, drawn),
    'a finger placed over the shape lands on the shape');
}

// ---------------------------------------------------------------- scanned rooms
{
  const scene = sampleRoomFurnished();
  const sheet = plan(scene);
  const measuredShapes = layers(sheet, 'object_measured').filter((p) => p.kind === 'path');
  check('every scanned shape is identified too',
    measuredShapes.every(
      (p) => p.kind === 'path' && !!p.id && scene.design.objects.some((o) => o.id === p.id),
    ),
    `${measuredShapes.length} shapes carry a scene id`);
  check('every scanned object is drawn',
    measuredShapes.length === scene.design.objects.filter((o) => o.state === 'present').length,
    `${measuredShapes.length} of ${scene.design.objects.length}`);
  check('measured and added are distinguishable',
    measuredShapes.every((p) => p.kind === 'path' && p.stroke?.dash !== undefined),
    'scanned furniture is dashed');

  const doors = scene.design.surfaces.filter((s) => s.class === 'door' && s.state === 'present');
  const withSwing = doors.filter((d) => d.swing);
  check('a door with a swing gets a leaf and an arc',
    withSwing.length === 0 || layers(sheet, 'door').length >= withSwing.length * 2,
    `${withSwing.length} swings, ${layers(sheet, 'door').length} door primitives`);
  // The leaf belongs at the open end of the sweep. Drawn closed it lies along the wall
  // line, invisible, and the door reads as a gap with an arc floating beside it.
  const [leaf, arc] = layers(sheet, 'door');
  const openEnd = arc?.kind === 'path' ? arc.points[arc.points.length - 1] : undefined;
  const leafEnd = leaf?.kind === 'path' ? leaf.points[1] : undefined;
  check('the leaf is drawn open, not flat against the wall',
    !!openEnd && !!leafEnd && Math.hypot(leafEnd[0] - openEnd[0], leafEnd[1] - openEnd[1]) < 0.01,
    leafEnd ? `leaf ends at ${leafEnd.map((n) => n.toFixed(0)).join(',')}` : 'no leaf');
  check('every opening breaks the wall',
    layers(sheet, 'opening').length >=
      scene.design.surfaces.filter(
        (s) => ['door', 'window', 'opening'].includes(s.class) && s.state === 'present',
      ).length,
    `${layers(sheet, 'opening').length} opening primitives`);

  // A door whose swing the scan never reported, which is every device-captured door.
  const unknown = sampleRoomFurnished();
  unknown.design.surfaces = unknown.design.surfaces.map((s) =>
    s.class === 'door' ? { ...s, swing: null } : s,
  );
  const unknownSheet = plan(unknown);
  check('an unreported swing is not invented',
    layers(unknownSheet, 'door').length === 0,
    `${layers(unknownSheet, 'door').length} door primitives`);
  check('and the drawing says the swing is unknown',
    texts(unknownSheet).some((t) => t.includes('did not report a swing')),
    'note present');
}

// ---------------------------------------------------------------- inferred structure
{
  const scene = sampleRoom();
  scene.design.surfaces = scene.design.surfaces.map((s, i) =>
    s.class === 'wall' && i % 2 === 0 ? { ...s, provenance: 'inferred' as const } : s,
  );
  const sheet = plan(scene);
  const inferred = layers(sheet, 'wall_inferred');
  check('an inferred wall is overdrawn dashed',
    inferred.length > 0 && inferred.every((p) => p.kind === 'path' && (p.stroke?.dash?.length ?? 0) > 0),
    `${inferred.length} inferred walls`);
  check('and the notes say how many, in agreeing English',
    texts(sheet).some((t) =>
      inferred.length === 1
        ? t === 'The wall shown dashed was not measured'
        : t === `The ${inferred.length} walls shown dashed were not measured`,
    ),
    texts(sheet).find((t) => t.includes('shown dashed')) ?? 'missing');
}

// ---------------------------------------------------------------- furniture is never clipped
{
  const scene = sampleRoom();
  // Hard against the wall and overhanging it, which is where a plan fitted to the floor
  // polygon alone would slice a corner off the drawing.
  scene.design.objects = [added('obj_overhang', [1.9, 0, 1.9])];
  const sheet = plan(scene);
  const shape = layers(sheet, 'object_added').find((p) => p.kind === 'path');
  const points = shape && shape.kind === 'path' ? shape.points : [];
  check('an object overhanging the room is still on the page',
    points.length > 0 && points.every((p) => p[0] >= 0 && p[0] <= sheet.width && p[1] >= 0 && p[1] <= sheet.height),
    `${points.length} corners`);
}

// ---------------------------------------------------------------- reproducibility
{
  const scene = sampleRoomFurnished();
  const a = JSON.stringify(plan(scene));
  const b = JSON.stringify(plan(scene));
  check('the same room draws the same sheet twice', a === b, `${a.length} bytes`);
  // Which is only meaningful because the date is the only thing that moves.
  const later = JSON.stringify(buildPlan(scene, { now: NOW + 86_400_000 }));
  check('only the date changes with the clock',
    later !== a && later.length === a.length,
    'one row differs');
}

const passed = steps.filter((s) => s.ok).length;
console.log('\nBlueprint gate');
for (const step of steps)
  console.log(`  ${step.ok ? `${GREEN}ok${OFF}` : `${RED}NO${OFF}`} ${step.label} ${DIM}- ${step.detail}${OFF}`);
console.log(`\n${passed}/${steps.length} passed`);
process.exit(passed === steps.length ? 0 : 1);
