import { sampleRoom, sampleRoomFurnished } from '@reality/dev-scenarios';
import {
  erasureAvailability,
  erasureVolumes,
  retainedVolumes,
  shouldComposite,
  shouldErase,
  volumeCorners,
} from '@reality/spatial-engine';
import { ShellSchema, type Vec3 } from '@reality/contracts';
import { exampleShell } from '@reality/dev-scenarios';
import { MAX_SHELL_PLANES, planeOf, raycastShell, shellPlanes, uvAt } from './shell-planes';
import {
  buildPatch,
  fillAt,
  FILL_MARGIN,
  homographyAt,
  imageBounds,
  patchRoundTrip,
  planesOf,
  projectToImage,
  quadHomography,
  surfaceBehind,
  type CameraView,
} from './patch';
import { PatchStore, patchKey, type PatchState } from './patches';
import { MAX_FRAME_AGE_MS, TextureFrameStream, type TextureFrame, type TextureFrameSource } from './frame-textures';
import { ensureContextCanvas } from './gl-canvas';
import type { Scenario, StepResult } from './scenarios';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const request = { contextId: 1, frameId: 'room-frame', width: 320, height: 640 };
function bundle(sequence = 1): TextureFrame {
  return {
    version: 1, leaseId: `lease-${sequence}`, contextId: 1, frameId: request.frameId,
    generation: 1, sequence, timestamp: 1000 + sequence, nativeAgeMs: 5,
    viewportWidth: 320, viewportHeight: 640,
    cameraToWorld: identity, projection: identity, roomAnchor: identity,
    displayToImage: [1,0,0, 0,1,0, 0,0,1],
    videoRange: false, bt709: true, leasedSlots: 1, dropped: 0,
    textures: { luma: { id: 1, width: 640, height: 480 }, chroma: { id: 2, width: 320, height: 240 } },
  };
}
const check = (label: string, ok: boolean, detail?: string): StepResult => ({
  label,
  ok,
  detail: detail ?? (ok ? 'passed' : 'failed'),
});
const describe = (r: { status: string; refusal: string | null; message: string }) =>
  [r.status, r.refusal, r.message].filter(Boolean).join(' · ');
const floorId = (editor: { engine: { getSnapshot: () => { scene: { design: { surfaces: { id: string; class: string }[] } } } } }) =>
  editor.engine.getSnapshot().scene.design.surfaces.find((s) => s.class === 'floor')?.id ?? '';
function harness() {
  let time = 0;
  let next: unknown = bundle();
  const released: string[] = [];
  const source: TextureFrameSource = {
    acquire: async () => next,
    release: async id => { released.push(id); },
  };
  const stream = new TextureFrameStream(source, request, () => time);
  return { stream, released, set: (value: unknown) => { next = value; }, advance: (ms: number) => { time += ms; } };
}

const ERASURE_FRAME = { frameId: 'sample-world', hasDepth: true, hasForeground: true, ageMs: 20 };
const ERASURE_SHELL = { calibrationId: 'sample-calibration', calibrationRevision: 0, frameId: 'sample-world' };
const ready = (over: Partial<Parameters<typeof erasureAvailability>[0]> = {}) =>
  erasureAvailability({
    shell: ERASURE_SHELL,
    atlasReady: true,
    frame: ERASURE_FRAME,
    tracking: true,
    maxFrameAgeMs: MAX_FRAME_AGE_MS,
    ...over,
  });

export const compositingScenarios: Scenario[] = [
  {
    id: 'm8-erasure-intent',
    title: 'The erasure set is derived from committed state, never accumulated',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = () => editor.engine.getSnapshot().scene;
      const ctx = () => {
        const s = scene();
        return {
          turnId: 'erasure', clock: 'epoch' as const, timestamp: Date.now(),
          revision: s.revision, frameId: s.frameId, selectedId: null, destination: null, viewer: null,
        };
      };
      steps.push(check('an untouched room erases nothing', erasureVolumes(scene()).length === 0, 'no volumes'));

      await editor.intent({ action: 'hide', target_id: 'obj_bed_01' }, ctx());
      const hidden = erasureVolumes(scene());
      steps.push(check('an explicit hide produces one volume', hidden.length === 1 && hidden[0]!.id === 'obj_bed_01', hidden.map((v) => `${v.id}:${v.reason}`).join(',')));
      steps.push(check('it is erased at its MEASURED pose', Math.abs(hidden[0]!.center[0] - (-0.985)) < 1e-6, hidden[0]!.center.join(',')));

      // Undo restores the scene and the erasure set follows, because there is nothing
      // else for it to follow. The compositor keeps no history of its own (M8-D.5).
      await editor.intent({ action: 'undo' }, ctx());
      steps.push(check('undo removes the volume with no compositor bookkeeping', erasureVolumes(scene()).length === 0, 'derived, not accumulated'));

      // A real object that MOVED must have its original appearance erased (M8-D.1).
      const moved = await editor.intent(
        { action: 'move', target_id: 'obj_chair_01' },
        { ...ctx(), destination: { position: [-0.2, 0, 1.4], surfaceId: floorId(editor), kind: 'surface' as const } },
      );
      const afterMove = erasureVolumes(scene());
      steps.push(check('moving a real object erases where it was', moved.status !== 'rejected' && afterMove.some((v) => v.id === 'obj_chair_01' && v.reason === 'moved'), `${describe(moved)} -> ${afterMove.map((v) => `${v.id}:${v.reason}`).join(',')}`));
      const chair = afterMove.find((v) => v.id === 'obj_chair_01');
      steps.push(check('the volume stays at the original location', !!chair && Math.abs(chair.center[2] - (-1.0)) < 1e-6, chair?.center.join(',') ?? 'missing'));

      // A carry is transient and owned by the transaction, so it needs no commit.
      const carried = erasureVolumes(scene(), { carriedId: 'obj_table_01' });
      steps.push(check('a carried object erases transiently', carried.some((v) => v.id === 'obj_table_01' && v.reason === 'carried'), carried.map((v) => `${v.id}:${v.reason}`).join(',')));
      steps.push(check('dropping the carry restores it with no extra state', !erasureVolumes(scene()).some((v) => v.id === 'obj_table_01'), 'transient'));
      return steps;
    },
  },
  {
    id: 'm8-manual-mask',
    title: 'A hand-drawn box erases what the scan never recognised',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = () => editor.engine.getSnapshot().scene;
      const ctx = (destination: { position: Vec3; surfaceId: string; kind: 'surface' } | null = null) => {
        const s = scene();
        return {
          turnId: 'mask', clock: 'epoch' as const, timestamp: Date.now(),
          revision: s.revision, frameId: s.frameId, selectedId: null, destination, viewer: null,
        };
      };
      const floor = floorId(editor);
      const spot: Vec3 = [1.2, 0, 1.2];

      const placed = await editor.intent(
        { action: 'mask_area', width_m: 0.7, height_m: 1.6, depth_m: 0.6 },
        ctx({ position: spot, surfaceId: floor, kind: 'surface' }),
      );
      steps.push(check('a box is placed where the user pointed', placed.status === 'applied' && scene().maskVolumes.length === 1, describe(placed)));
      const box = scene().maskVolumes[0]!;
      steps.push(check('it sits on the pointed spot', box.center[0] === spot[0] && box.center[2] === spot[2], box.center.join(',')));
      steps.push(check('it takes the requested size', box.size.join(',') === '0.7,1.6,0.6', box.size.join(',')));

      // A freshly placed box is a MARKER, not an erasure. Sizing it happens while
      // looking at the thing inside, so erasing on placement would remove it.
      steps.push(check('a new box is marked, not yet hidden', box.hidden === false && !erasureVolumes(scene()).some((v) => v.reason === 'manual'), 'marked'));
      // The exact failure on device: "hide it" with no id and nothing selected. It
      // reported a missing target id for a box it had just created.
      const hid = await editor.intent({ action: 'hide' }, ctx());
      steps.push(check('"hide it" is what erases', hid.status === 'applied' && scene().maskVolumes[0]!.hidden === true, describe(hid)));
      steps.push(check('and says the pixels take the surrounding colour', /colour of the wall and floor around them/i.test(hid.message), hid.message.slice(0, 70)));
      steps.push(check('hiding twice is refused, not double-applied', (await editor.intent({ action: 'hide', target_id: box.id }, ctx())).status === 'rejected', 'already hidden'));
      steps.push(check('the placement reply names the box', /mask-1/.test(placed.message), placed.message.slice(0, 60)));
      steps.push(check('and tells the user hide is the next step', /hide it/i.test(placed.message), 'stated'));

      // The whole point: it erases without anything having detected anything.
      const volumes = erasureVolumes(scene());
      const manual = volumes.find((v) => v.reason === 'manual');
      steps.push(check('it becomes an erasure volume', !!manual && manual.id === box.id, volumes.map((v) => `${v.id}:${v.reason}`).join(',')));
      steps.push(check('a point inside it is erased', shouldErase([spot[0], 0.8, spot[2]], { volumes, retained: retainedVolumes(scene(), volumes), depthConfidence: 2, minConfidence: 1, foreground: 0 }), 'inside'));
      steps.push(check('a point outside it is not', !shouldErase([spot[0], 3.0, spot[2]], { volumes, retained: retainedVolumes(scene(), volumes), depthConfidence: 2, minConfidence: 1, foreground: 0 }), 'above the box'));

      // It is NOT an object: no collision, no placement effect, no assembly.
      steps.push(check('it is not a scene object', !scene().design.objects.some((o) => o.id === box.id), `${scene().design.objects.length} objects`));
      const placeThere = await editor.intent(
        { action: 'add', family: 'table', dimensions: [0.5, 0.5, 0.5] },
        ctx({ position: spot, surfaceId: floor, kind: 'surface' }),
      );
      steps.push(check('it blocks no placement', placeThere.status === 'applied', describe(placeThere)));

      // Resizing reuses the same id, so it is one undo step rather than two.
      const resized = await editor.intent(
        { action: 'mask_area', target_id: box.id, width_m: 1.4, height_m: 2.0, depth_m: 1.0 },
        ctx({ position: spot, surfaceId: floor, kind: 'surface' }),
      );
      steps.push(check('resizing replaces rather than adds', resized.status === 'applied' && scene().maskVolumes.length === 1 && scene().maskVolumes[0]!.size[0] === 1.4, `${scene().maskVolumes.length} box(es)`));
      steps.push(check('resizing a hidden box keeps it hidden', scene().maskVolumes[0]!.hidden === true, 'the fill does not flicker back'));

      const undone = await editor.intent({ action: 'undo' }, ctx());
      steps.push(check('undo restores the previous size', undone.status === 'applied' && scene().maskVolumes[0]?.size[0] === 0.7, scene().maskVolumes[0]?.size.join(',') ?? 'gone'));

      // The situation the feature exists for: nothing pointed at, nothing identified,
      // but the user is looking straight at the thing they want gone.
      const blind = await editor.intent(
        { action: 'mask_area', width_m: 0.3, height_m: 2.2, depth_m: 0.3 },
        {
          ...ctx(),
          viewer: { position: [0, 1.5, 0] as Vec3, forward: [0, 0, -1] as Vec3 },
        },
      );
      const drawn = scene().maskVolumes.find((v) => v.id !== box.id);
      steps.push(check('a box can be placed with nothing identified', blind.status === 'applied' && !!drawn, describe(blind)));
      steps.push(check('it lands in front of the viewer, on the floor', !!drawn && Math.abs(drawn.center[2] - -1.5) < 1e-6 && drawn.center[1] === 0, drawn?.center.join(',') ?? '-'));
      steps.push(check('a skinny screen shape is allowed', drawn?.size.join(',') === '0.3,2.2,0.3', drawn?.size.join(',') ?? '-'));
      steps.push(check('the reply says how to adjust it', /bigger|wider|taller/i.test(blind.message), blind.message.slice(0, 80)));

      // Adjusting by voice, with no numbers and no re-pointing.
      const bigger = await editor.intent(
        { action: 'resize', target_id: drawn!.id, width_delta_m: 0.4, height_delta_m: -0.2 },
        ctx(),
      );
      const grown = scene().maskVolumes.find((v) => v.id === drawn!.id);
      steps.push(check('a selected box resizes relatively', bigger.status === 'applied' && grown?.size[0] === 0.7 && grown?.size[1] === 2.0, grown?.size.join(',') ?? '-'));
      const movedBox = await editor.intent(
        { action: 'move', target_id: drawn!.id },
        ctx({ position: [-1, 0, -1] as Vec3, surfaceId: floor, kind: 'surface' }),
      );
      steps.push(check('and moves to where the user points', movedBox.status === 'applied' && scene().maskVolumes.find((v) => v.id === drawn!.id)?.center.join(',') === '-1,0,-1', describe(movedBox)));
      steps.push(check('moving with nowhere pointed asks', (await editor.intent({ action: 'move', target_id: drawn!.id }, ctx())).status === 'rejected', 'asks for a destination'));
      await editor.intent({ action: 'unmask_area', target_id: drawn!.id }, ctx());

      const cleared = await editor.intent({ action: 'unmask_area', target_id: box.id }, ctx());
      steps.push(check('it can be removed', cleared.status === 'applied' && scene().maskVolumes.length === 0, describe(cleared)));
      steps.push(check('and nothing is erased afterwards', erasureVolumes(scene()).every((v) => v.reason !== 'manual'), 'clean'));
      return steps;
    },
  },
  {
    id: 'm8-erasure-availability',
    title: 'Live erasure refuses rather than painting a confident hole',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const ok = ready();
      steps.push(check('a complete bundle is available', ok.available, ok.available ? ok.degraded.join(' ') || 'no degradation' : ok.reason));

      // Only these actually make it impossible. Depth is what BOUNDS the region and a
      // fresh frame is what it is drawn onto; neither has a substitute.
      const cases: [string, ReturnType<typeof ready>, RegExp][] = [
        ['tracking loss', ready({ tracking: false }), /tracking/i],
        ['no live frame', ready({ frame: null }), /camera/i],
        ['stale frame', ready({ frame: { ...ERASURE_FRAME, ageMs: MAX_FRAME_AGE_MS + 1 } }), /stale/i],
      ];
      for (const [label, result, pattern] of cases)
        steps.push(check(`${label} makes erasure unavailable`, !result.available && pattern.test(result.reason ?? ''), result.available ? 'AVAILABLE' : result.reason));

      // These used to refuse and now degrade. Requiring a reconstruction made erasure
      // unavailable in every session where nobody had run one, which was most of them.
      const soft: [string, ReturnType<typeof ready>, RegExp][] = [
        ['no reconstruction', ready({ shell: null }), /surrounding colour/i],
        ['atlas still loading', ready({ atlasReady: false }), /loading/i],
        ['shell from another calibration', ready({ frame: { ...ERASURE_FRAME, frameId: 'other-world' } }), /earlier calibration/i],
        // A hand-drawn box is a known volume, so which pixels look into it is a
        // ray-box question. Refusing without depth made erasure impossible on every
        // device that could not provide it.
        ['no scene depth', ready({ frame: { ...ERASURE_FRAME, hasDepth: false } }), /objects in front/i],
      ];
      for (const [label, result, pattern] of soft)
        steps.push(check(`${label} degrades rather than refuses`, result.available && result.degraded.some((d) => pattern.test(d)), result.available ? result.degraded.join(' ') : `REFUSED: ${result.reason}`));

      // The gate that decides whether the shader runs at all. It carried a shell
      // requirement long after the fill stopped needing one, so "hide it" committed
      // and the screen never changed. A shell must never appear in this list again.
      const live = { hasCameraFrame: true, diagnosticActive: false, bridgeUsable: true, erasing: 1 };
      steps.push(check('it composites with a frame and something to erase', shouldComposite(live), 'mounted'));
      steps.push(check('it needs no reconstruction to run', shouldComposite({ ...live, erasing: 2 }), 'no shell in the condition'));
      steps.push(check('nothing to erase means it stays out of the way', !shouldComposite({ ...live, erasing: 0 }), 'not mounted'));
      steps.push(check('a diagnostic view owns the draw instead', !shouldComposite({ ...live, diagnosticActive: true }), 'not mounted'));
      steps.push(check('no camera frame means the normal path renders', !shouldComposite({ ...live, hasCameraFrame: false }), 'not mounted'));
      steps.push(check('an unusable native bridge must not blank the editor', !shouldComposite({ ...live, bridgeUsable: false }), 'not mounted'));

      const degraded = ready({ frame: { ...ERASURE_FRAME, hasForeground: false } });
      steps.push(check('missing segmentation degrades rather than refuses', degraded.available && degraded.degraded.length === 1, degraded.available ? degraded.degraded.join(' ') : degraded.reason));
      return steps;
    },
  },
  {
    id: 'm8-inpaint-patch',
    title: 'One photograph becomes a patch registered on the wall',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      // Camera at (0,1.5,1) looking down -Z at the north wall, 60 degrees vertical.
      const f = 1 / Math.tan(Math.PI / 6);
      const view: CameraView = {
        cameraToRoom: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 1, 1],
        projection: [f / (4 / 3), 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0],
        width: 1024,
        height: 768,
      };
      const box = { id: 'mask-1', reason: 'manual' as const, center: [0, 0, -1.5] as Vec3, size: [0.8, 1.2, 0.5] as Vec3, yaw: 0 };

      const centre = projectToImage([0, 1.5, -1], view);
      steps.push(check('a point straight ahead is the image centre', !!centre && Math.abs(centre.x - 0.5) < 1e-6 && Math.abs(centre.y - 0.5) < 1e-6, centre ? `${centre.x.toFixed(4)}, ${centre.y.toFixed(4)}` : 'behind camera'));
      steps.push(check('a point behind the camera has no image position', projectToImage([0, 1.5, 3], view) === null, 'rejected'));

      const region = imageBounds(box, view);
      steps.push(check('the box has an image footprint', !!region && region.x1 > region.x0 && region.y1 > region.y0, region ? Object.values(region).map((v) => v.toFixed(3)).join(' ') : 'none'));

      const plane = surfaceBehind(box, view, planesOf(scene));
      steps.push(check('the wall behind the box is found', plane?.id === 'srf_wall_north', plane?.id ?? 'none'));

      const patch = buildPatch(box, view, plane!);
      steps.push(check('a patch is built', !!patch, patch ? `${patch.corners.length} corners on ${patch.surfaceId}` : 'none'));
      steps.push(check('it lies on that wall', !!patch && patch.corners.every((c) => Math.abs(c[2]! - -2) < 0.02), patch?.corners.map((c) => c[2]!.toFixed(3)).join(',') ?? '-'));

      // The registration argument: every corner samples the image where it actually
      // projects. A patch that fails this slides across the wall as the camera moves.
      const error = patch ? patchRoundTrip(patch, view) : Infinity;
      steps.push(check('texture and geometry agree exactly', error < 1e-9, `worst ${error.toExponential(2)}`));
      steps.push(check('every corner samples inside the photograph', !!patch && patch.uvs.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1), patch?.uvs.map((uv) => uv.map((n) => n.toFixed(2)).join('/')).join(' ') ?? '-'));

      // Moving the camera must not move the patch: it is on the wall, not the screen.
      const moved: CameraView = { ...view, cameraToRoom: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.7, 1.5, 1.2, 1] };
      const again = buildPatch(box, moved, plane!);
      steps.push(check('a second viewpoint puts it on the same wall', !!again && again.corners.every((c) => Math.abs(c[2]! - -2) < 0.02), again?.corners.map((c) => c[2]!.toFixed(3)).join(',') ?? '-'));

      // A box behind the camera must not cost an inference call.
      const behindMe = { ...box, center: [0, 0, 2.5] as Vec3 };
      steps.push(check('a box out of view is refused before any request', imageBounds(behindMe, view) === null, 'no footprint'));

      // Cache identity: the same question reuses, a moved box does not.
      steps.push(check('the same box reuses its patch', patchKey(box, scene.frameId) === patchKey({ ...box }, scene.frameId), 'same key'));
      steps.push(check('a moved box asks again', patchKey(box, scene.frameId) !== patchKey({ ...box, center: [0.3, 0, -1.5] as Vec3 }, scene.frameId), 'different key'));
      steps.push(check('a recalibrated room asks again', patchKey(box, scene.frameId) !== patchKey(box, 'other-frame'), 'different key'));

      // ---- the local fill: the region rebuilt from the wall outside it ----
      //
      // This is what makes hiding change pixels without a server, a reconstruction or
      // a minute of inference, so it is proven numerically rather than by eye.
      const H = quadHomography(patch!.uvs);
      steps.push(check('the quad has a solvable map onto the photograph', !!H, H ? 'solved' : 'degenerate'));

      // It must reproduce the quad exactly, or "just outside the edge" is measured
      // from the wrong rectangle and the fill samples the object it is covering.
      let corner = 0;
      ([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).forEach(([cs, ct], index) => {
        const [x, y] = homographyAt(H!, cs, ct);
        corner = Math.max(corner, Math.abs(x - patch!.uvs[index]![0]), Math.abs(y - patch!.uvs[index]![1]));
      });
      steps.push(check('it maps the unit square onto the quad exactly', corner < 1e-9, `worst ${corner.toExponential(2)}`));

      const uvX = patch!.uvs.map((uv) => uv[0]);
      const uvY = patch!.uvs.map((uv) => uv[1]);
      const outsideLeft = homographyAt(H!, -FILL_MARGIN, 0.5);
      const outsideBelow = homographyAt(H!, 0.5, -FILL_MARGIN);
      steps.push(check('a sample at s = -margin is beyond the left edge', outsideLeft[0] < Math.min(...uvX), `${outsideLeft[0].toFixed(4)} < ${Math.min(...uvX).toFixed(4)}`));
      steps.push(check('a sample at t = -margin is beyond the bottom edge', outsideBelow[1] < Math.min(...uvY), `${outsideBelow[1].toFixed(4)} < ${Math.min(...uvY).toFixed(4)}`));

      /**
       * A photograph of a plain wall with something dark standing against it. The
       * object fills the quad; the wall is everything outside. Anything the fill
       * returns that is not the wall colour is the object surviving the erase.
       */
      const WALL = [0.82, 0.78, 0.7] as const;
      const OBJECT = [0.1, 0.09, 0.12] as const;
      const photograph = (fs: number, ft: number) =>
        fs >= 0 && fs <= 1 && ft >= 0 && ft <= 1 ? OBJECT : WALL;
      let worstFill = 0;
      for (let i = 0; i <= 10; i++)
        for (let j = 0; j <= 10; j++) {
          const colour = fillAt(i / 10, j / 10, photograph);
          worstFill = Math.max(worstFill, ...colour.map((c, k) => Math.abs(c - WALL[k]!)));
        }
      steps.push(check('the fill returns wall, never the object it covers', worstFill < 1e-9, `worst channel error ${worstFill.toExponential(2)}`));

      // A seam is the failure everyone sees first, so the boundary is checked against
      // the pixel immediately outside it rather than against the average.
      const gradient = (fs: number, _ft: number) => [fs, fs, fs] as const;
      const atLeftEdge = fillAt(0, 0.5, gradient);
      const atRightEdge = fillAt(1, 0.5, gradient);
      steps.push(check('on the left edge it is the colour just left of it', Math.abs(atLeftEdge[0] - -FILL_MARGIN) < 2e-3, atLeftEdge[0].toFixed(5)));
      steps.push(check('on the right edge it is the colour just right of it', Math.abs(atRightEdge[0] - (1 + FILL_MARGIN)) < 2e-3, atRightEdge[0].toFixed(5)));
      steps.push(check('and it varies monotonically between them', atLeftEdge[0] < fillAt(0.5, 0.5, gradient)[0] && fillAt(0.5, 0.5, gradient)[0] < atRightEdge[0], 'no banding'));

      // A degenerate quad must not produce a matrix nobody can evaluate; the caller
      // falls back to the plain textured path.
      steps.push(check('a collapsed quad yields no map', quadHomography([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]) === null, 'rejected'));
      return steps;
    },
  },
  {
    id: 'm8-gl-canvas',
    title: "three's state reset needs a canvas expo-gl does not have",
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoom,
    run: async () => {
      const steps: StepResult[] = [];
      // `WebGLState.reset()` ends in `gl.scissor(0, 0, gl.canvas.width, ...)`. In a
      // browser `canvas` is a property of every WebGLRenderingContext; on native it is
      // not, and the throw happens inside the render loop where nothing catches it.
      // Every path that resets GL state was dead on device the moment it first ran.
      const native = { drawingBufferWidth: 1179, drawingBufferHeight: 2556 } as {
        drawingBufferWidth: number;
        drawingBufferHeight: number;
        canvas?: { width: number; height: number };
      };
      steps.push(check('an expo-gl context has no canvas to begin with', native.canvas === undefined, 'undefined'));
      steps.push(check('the shim gives it one', ensureContextCanvas(native), `${native.canvas?.width}x${native.canvas?.height}`));
      steps.push(check('which reports the drawing buffer', native.canvas?.width === 1179 && native.canvas?.height === 2556, `${native.canvas?.width}x${native.canvas?.height}`));

      // Live, not copied. A stored size is wrong after the first rotation, and this
      // sets a scissor rectangle.
      native.drawingBufferWidth = 2556;
      native.drawingBufferHeight = 1179;
      steps.push(check('and follows it through a rotation', native.canvas?.width === 2556 && native.canvas?.height === 1179, `${native.canvas?.width}x${native.canvas?.height}`));

      // Idempotent: it is called every frame, and on web it must leave the real canvas
      // of the real context alone.
      const before = native.canvas;
      ensureContextCanvas(native);
      steps.push(check('calling it again changes nothing', native.canvas === before, 'same object'));
      const web = { drawingBufferWidth: 800, drawingBufferHeight: 600, canvas: { width: 1600, height: 1200 } };
      ensureContextCanvas(web);
      steps.push(check('a real canvas is never replaced', web.canvas.width === 1600, `${web.canvas.width}`));

      // A context that refuses the property must report so rather than throw, or the
      // caller loses the frame to the very exception this exists to prevent.
      const frozen = Object.freeze({ drawingBufferWidth: 10, drawingBufferHeight: 10 });
      let threw = false;
      let answered = true;
      try {
        answered = ensureContextCanvas(frozen);
      } catch {
        threw = true;
      }
      steps.push(check('a context that refuses it says no rather than throwing', !threw && !answered, threw ? 'THREW' : `returned ${answered}`));
      return steps;
    },
  },
  {
    id: 'm8-patch-delivery',
    title: 'Hiding covers the box immediately, and a failed inpaint never uncovers it',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const volume = { id: 'mask-1', reason: 'manual' as const, center: [0, 0, -1.5] as Vec3, size: [0.8, 1.2, 0.5] as Vec3, yaw: 0 };
      const capture = {
        pngBase64: 'A'.repeat(128),
        width: 1024,
        height: 768,
        frameId: scene.frameId,
        generation: 0,
        timestamp: 1,
        cameraToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 1, 1],
        projection: [1.299, 0, 0, 0, 0, 1.732, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0],
        intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      };

      // The whole point of the local fill: no server at all, and the box is still
      // covered. `fetch` never resolves here, so nothing but the local path can pass.
      const seen: PatchState[] = [];
      const store = new PatchStore('http://127.0.0.1:1/never', { capture: async () => capture });
      store.subscribe((_id, state) => seen.push(state));
      const settled = await store.request(volume, scene);
      steps.push(check('a patch is published without any reply from the service', settled.state === 'ready', settled.state === 'failed' ? settled.reason : settled.state));
      steps.push(check('it is the local fill', settled.state === 'ready' && settled.fill === 'local', settled.state === 'ready' ? settled.fill : '-'));
      steps.push(check('it is drawable', store.ready().length === 1 && store.ready()[0]!.fill === 'local', `${store.ready().length} patch(es)`));
      steps.push(check('it says why it is not the better fill', settled.state === 'ready' && !!settled.note, settled.state === 'ready' ? settled.note ?? 'none' : '-'));

      // Order matters: the covering patch must be emitted BEFORE the request goes out,
      // or the user waits on the network for pixels that never needed it.
      const readyAt = seen.findIndex((state) => state.state === 'ready');
      const thinkingAt = seen.findIndex((state) => state.state === 'thinking');
      steps.push(check('the cover arrives before the request, not after it', readyAt >= 0 && thinkingAt > readyAt, seen.map((state) => state.state).join(' -> ')));

      // A failure must never withdraw the patch: that would put the furniture back.
      steps.push(check('a failed inpaint leaves the box covered', store.ready().length === 1, `${store.ready().length} patch(es)`));

      // And the things that legitimately have no patch still refuse cleanly.
      const noFrame = new PatchStore('http://127.0.0.1:1/never', { capture: async () => null });
      const refused = await noFrame.request({ ...volume, id: 'mask-2' }, scene);
      steps.push(check('no camera frame is a clean refusal', refused.state === 'failed' && /camera/i.test(refused.reason), refused.state));
      steps.push(check('and draws nothing', noFrame.ready().length === 0, `${noFrame.ready().length} patch(es)`));
      const stale = new PatchStore('http://127.0.0.1:1/never', {
        capture: async () => ({ ...capture, frameId: 'a-different-room' }),
      });
      const rejected = await stale.request({ ...volume, id: 'mask-3' }, scene);
      steps.push(check('a photograph of another room is rejected', rejected.state === 'failed' && /recalibrated/i.test(rejected.reason), rejected.state));
      store.dispose();
      noFrame.dispose();
      stale.dispose();
      return steps;
    },
  },
  {
    id: 'm8-shell-sampling',
    title: 'The shell is sampled at the world point the camera ray reaches',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const shell = ShellSchema.parse(exampleShell());
      const planes = shellPlanes(shell);
      steps.push(check('every surface yields a plane', planes.length === shell.surfaces.length, `${planes.length}/${shell.surfaces.length}`));

      // The compositor's whole claim is that a pixel gets the atlas colour belonging to
      // the world point behind it. That reduces to this map being exact, so it is
      // checked on every vertex the worker itself assigned a UV to.
      let worst = 0;
      let worstAt = '';
      for (const surface of shell.surfaces) {
        const plane = planes.find((p) => p.id === surface.id);
        if (!plane) continue;
        surface.positions.forEach((position, index) => {
          const got = uvAt(plane, position as Vec3);
          const want = surface.uvs[index]!;
          const error = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
          if (error > worst) {
            worst = error;
            worstAt = `${surface.id}[${index}]`;
          }
        });
      }
      steps.push(check('world to atlas UV round-trips exactly', worst < 1e-9, `worst ${worst.toExponential(2)}${worstAt ? ` at ${worstAt}` : ''}`));

      // A ray must find the surface it points at, and nothing when it points away.
      const floor = planes.find((p) => p.id === 'floor');
      const down = raycastShell(planes, [0, 1.2, 0], [0, -1, 0], 0.01);
      steps.push(check('a downward ray hits the floor', !!floor && down?.plane.id === 'floor', down ? `${down.plane.id} at ${down.distance.toFixed(3)}m` : 'miss'));
      steps.push(check('the hit lands inside the atlas rectangle', !!down && down.uv.every((v) => v >= 0 && v <= 1), down?.uv.map((v) => v.toFixed(3)).join(',') ?? '-'));
      const up = raycastShell(planes, [0, 1.2, 0], [0, 1, 0], 0.01);
      steps.push(check('a ray with no shell behind it misses', up === null, up ? `${up.plane.id}` : 'no hit, camera is kept'));

      // Degenerate input must be dropped rather than produce a plane nobody can sample.
      const degenerate = planeOf({
        ...shell.surfaces[0]!,
        positions: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as Vec3[],
        uvs: [[0, 0], [0, 0], [0, 0]],
      });
      steps.push(check('a degenerate surface yields no plane', degenerate === null, degenerate ? 'accepted' : 'rejected'));
      steps.push(check('planes are capped for the uniform block', shellPlanes(shell).length <= MAX_SHELL_PLANES, `${planes.length} <= ${MAX_SHELL_PLANES}`));
      return steps;
    },
  },
  {
    id: 'm8-erasure-region',
    title: 'A furniture box alone does not authorise replacing a pixel',
    milestone: 'M8',
    gate: 'erasure',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const bed = scene.measured.objects.find((o) => o.id === 'obj_bed_01')!;
      const volume = {
        id: bed.id, reason: 'hidden' as const,
        center: [bed.pose.position[0]!, bed.pose.position[1]!, bed.pose.position[2]!] as Vec3,
        size: [bed.dimensions[0]!, bed.dimensions[1]!, bed.dimensions[2]!] as Vec3,
        yaw: bed.pose.yaw,
      };
      const retained = retainedVolumes(scene, [volume]);
      const inside: Vec3 = [volume.center[0], volume.center[1] + 0.3, volume.center[2]];
      const outside: Vec3 = [volume.center[0], volume.center[1] + 3, volume.center[2]];
      const base = { volumes: [volume], retained, depthConfidence: 2, minConfidence: 1, foreground: 0 };

      steps.push(check('a point on the erased furniture is replaced', shouldErase(inside, base), 'inside'));
      steps.push(check('a point above it is not', !shouldErase(outside, base), 'outside'));
      steps.push(check('a hand in front of it is preserved', !shouldErase(inside, { ...base, foreground: 0.9 }), 'foreground protected'));
      steps.push(check('low-confidence depth is not trusted', !shouldErase(inside, { ...base, depthConfidence: 0 }), 'confidence below threshold'));
      steps.push(check('but with no depth at all there is no sample to distrust', shouldErase(inside, { ...base, depthConfidence: 0, hasDepth: false }), 'ray-box decides the region'));

      // Retained furniture wins ties. The bed overlaps nothing here, so this is checked
      // by erasing a volume that deliberately encloses the retained desk.
      const greedy = { ...volume, center: [0, 0, 0] as Vec3, size: [6, 3, 6] as Vec3, yaw: 0 };
      const desk = scene.measured.objects.find((o) => o.id === 'obj_table_01')!;
      const onDesk: Vec3 = [desk.pose.position[0]!, desk.pose.position[1]! + 0.3, desk.pose.position[2]!];
      steps.push(check(
        'a retained object is never erased by an overlapping volume',
        !shouldErase(onDesk, { ...base, volumes: [greedy], retained: retainedVolumes(scene, [greedy]) }),
        'retained wins',
      ));
      steps.push(check('the volume has eight corners in room space', volumeCorners(volume).length === 8, `${volumeCorners(volume).length} corners`));

      // A HAND-DRAWN BOX OVERRIDES PROTECTION. Retention exists so erasing one object
      // does not take the sofa beside it, which is an inference. A box the user drew
      // around a scanned bed is not an inference. Protecting the bed from it meant a
      // box over anything RoomPlan had detected erased nothing at all — the exact
      // symptom of "the mask appears and the pixels never change".
      const drawnOnBed = {
        id: 'mask-1', reason: 'manual' as const, yaw: bed.pose.yaw,
        center: volume.center, size: volume.size,
      };
      const stillProtected = retainedVolumes(scene, [drawnOnBed]);
      steps.push(check('a box drawn on the bed releases the bed', !stillProtected.some((v) => v.id === bed.id), stillProtected.map((v) => v.id).join(',') || 'nothing retained'));
      steps.push(check('and the bed is erased by it', shouldErase(inside, { ...base, volumes: [drawnOnBed], retained: stillProtected }), 'erased'));
      steps.push(check('other furniture keeps its protection', stillProtected.some((v) => v.id === 'obj_table_01'), stillProtected.map((v) => v.id).join(',')));

      // A small box on part of a big object counts too, or masking one end of a sofa
      // would be protected by the other end.
      const corner = {
        ...drawnOnBed, id: 'mask-2',
        center: [volume.center[0] + volume.size[0] / 4, volume.center[1], volume.center[2]] as Vec3,
        size: [0.2, 0.2, 0.2] as Vec3,
      };
      steps.push(check('a small box on a large object releases it as well', !retainedVolumes(scene, [corner]).some((v) => v.id === bed.id), 'released'));

      // But a box that merely passes near something must not unprotect it.
      const elsewhere = { ...drawnOnBed, id: 'mask-3', center: [2.2, 0, 2.2] as Vec3, size: [0.3, 0.3, 0.3] as Vec3 };
      steps.push(check('a box somewhere else protects everything as before', retainedVolumes(scene, [elsewhere]).length === retainedVolumes(scene, []).length, `${retainedVolumes(scene, [elsewhere]).length} retained`));
      // And an ordinary object erase still protects its neighbours, unchanged.
      steps.push(check('a scanned-object erase still protects the rest', retainedVolumes(scene, [volume]).some((v) => v.id === 'obj_table_01'), 'unchanged'));
      return steps;
    },
  },
  {
    id: 'm8-frame-identity', title: 'Native bundles reject mismatched identities and malformed metadata',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness();
      const invalid = [
        { ...bundle(), contextId: 2 }, { ...bundle(), frameId: 'other-frame' },
        { ...bundle(), viewportWidth: 640 }, { ...bundle(), cameraToWorld: [1] },
        { ...bundle(), projection: identity.map(() => NaN) }, { ...bundle(), leasedSlots: 4 },
        { ...bundle(), roomAnchor: identity.map(() => 0) },
        { ...bundle(), displayToImage: Array(9).fill(0) },
        { ...bundle(), cameraToWorld: Array(18).fill(1) },
        { ...bundle(), textures: { luma: bundle().textures.luma, chroma: bundle().textures.luma } },
      ];
      for (const value of invalid) { h.set(value); await h.stream.poll(); }
      const steps = [check('all malformed/mismatched frames rejected and released',
        h.stream.read() === null && h.released.length === invalid.length && h.stream.rejected === invalid.length)];
      h.set(bundle()); await h.stream.poll();
      steps.push(check('camera-only bundle is usable for diagnostics, not evidence of foreground support',
        h.stream.read()?.sequence === 1 && !h.stream.read()?.textures.foreground));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-freshness', title: 'Stale and reordered camera bundles never masquerade as live',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      h.advance(151);
      const steps = [check('old frame clears and releases even without new input',
        h.stream.read() === null && h.released.length === 1)];
      h.set(bundle(2)); await h.stream.poll();
      h.set({ ...bundle(3), timestamp: 1001 }); await h.stream.poll();
      steps.push(check('increasing request sequence cannot hide repeated/older AR pixels', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(4), generation: 0 }); await h.stream.poll();
      steps.push(check('older adapter generation rejected', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(5), nativeAgeMs: 200 }); await h.stream.poll();
      steps.push(check('native capture age participates in freshness', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(1), generation: 2 }); await h.stream.poll();
      steps.push(check('new adapter generation can restart sequence', h.stream.read()?.generation === 2));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-lifecycle', title: 'Texture requests are bounded and late results are disposed',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      let resolve!: (value: unknown) => void;
      let requested = 0;
      const released: string[] = [];
      const stream = new TextureFrameStream({
        acquire: () => { requested++; return new Promise(r => { resolve = r; }); },
        release: async id => { released.push(id); },
      }, request, () => 0);
      const pending = stream.poll(); await stream.poll(); await stream.poll();
      const steps = [check('only one request is in flight', requested === 1 && stream.busy)];
      stream.dispose(); resolve(bundle()); await pending;
      steps.push(check('late completion after context disposal is released, never shown',
        stream.read() === null && released.length === 1));
      await stream.poll();
      steps.push(check('disposed stream cannot silently resume', requested === 1));
      const h = harness();
      for (let i = 1; i <= 10; i++) { h.set(bundle(i)); await h.stream.poll(); }
      h.stream.dispose(); h.stream.dispose();
      steps.push(check('ten replacements/disposal release every lease exactly once',
        h.released.length === 10 && new Set(h.released).size === 10));
      return steps;
    },
  },
  {
    id: 'm8-frame-transit', title: 'Slow upload and transport failure degrade to unavailable',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      let time = 0, fail = false;
      const released: string[] = [];
      const stream = new TextureFrameStream({
        acquire: async () => { if (fail) throw new Error('offline'); time += 200; return bundle(); },
        release: async id => { released.push(id); },
      }, request, () => time);
      await stream.poll();
      const steps = [check('bridge transit is conservatively included in age', stream.read() === null && released.length === 1)];
      fail = true; await stream.poll();
      steps.push(check('transport error is counted without leaking a pending request', stream.errors === 1 && !stream.busy));
      stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-unavailable', title: 'Tracking loss clears a still-fresh displayed frame immediately',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      const steps = [check('fresh frame initially displayed', h.stream.read() !== null)];
      h.set(null); await h.stream.poll();
      steps.push(check('unavailable response clears and releases without waiting 150 ms',
        h.stream.read() === null && h.released.length === 1));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-duplicate-lease', title: 'Repeated lease tokens cannot destroy the displayed texture',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      await h.stream.poll();
      const steps = [check('exact duplicate is rejected without releasing the current lease',
        h.stream.read()?.sequence === 1 && h.released.length === 0)];
      h.set({ ...bundle(2), leaseId: 'lease-1' }); await h.stream.poll();
      steps.push(check('same token with newer metadata is still not a new resource',
        h.stream.read()?.sequence === 1 && h.released.length === 0));
      h.stream.dispose();
      steps.push(check('owner eventually releases token once', h.released.length === 1));
      return steps;
    },
  },
  {
    id: 'm8-frame-release-failure', title: 'Synchronous release failures cannot retain displayed state',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const stream = new TextureFrameStream({
        acquire: async () => bundle(),
        release: () => { throw new Error('native module already destroyed'); },
      }, request, () => 0);
      await stream.poll(); stream.dispose(); stream.dispose();
      return [check('dispose clears state and records one release failure without throwing',
        stream.read() === null && stream.errors === 1)];
    },
  },
  {
    id: 'm8-frame-optional-textures', title: 'Explicitly absent optional texture fields remain supported',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness();
      h.set({ ...bundle(), textures: { ...bundle().textures, depth: undefined, foreground: undefined } });
      await h.stream.poll();
      const steps = [check('camera-only optional fields do not throw during handle validation',
        h.stream.read() !== null && h.stream.errors === 0)];
      h.stream.dispose(); return steps;
    },
  },
];
