import {
  capture,
  exampleShell,
  sampleRoom,
  sampleRoomFurnished,
  sampleRoomWithBuiltIn,
  sweepFrames,
} from '@reality/dev-scenarios';
import {
  buildIndex,
  CoverageTracker,
  evaluateCoverage,
  evaluatePlacement,
  MAX_EVALUATIONS,
  planLayout,
} from '@reality/spatial-engine';
import { buildObject } from '@reality/scene-recipes';
import { SceneRecipeSchema, ShellSchema } from '@reality/contracts';
import { expandLegacyPlan } from './legacy-style';
import { recipeTool, voiceTool } from './editor';
import { roomToSession } from '../adapters/room-conversion';
import { applyToPoint, roomFromWorld } from '../adapters/room-space';
import type { EditorState, EditResult, InteractionContext, Vec3 } from '@reality/contracts';
import { createEditor, type Editor } from './editor';
import { InputCoordinator, DESTINATION_MAX_AGE_MS } from './coordinator';
import { buildOccupancy, buildScp, isAmbiguous, largestOpenRect } from '@reality/spatial-engine';
import { ScpSchema } from '@reality/contracts';

export type StepResult = { label: string; ok: boolean; detail: string };
export type ScenarioResult = { id: string; title: string; steps: StepResult[]; ok: boolean };

export type Scenario = {
  id: string;
  title: string;
  /** Which milestone gate this scenario is evidence for. The two suites share every
   * helper below but prove different things, and M3 drives the carry state machine
   * directly rather than going through `editor.intent`. */
  milestone: 'M2' | 'M3' | 'M4' | 'M6' | 'M7';
  gate:
    | 'placement'
    | 'overlap'
    | 'support'
    | 'undo'
    | 'stale'
    | 'carry'
    | 'settle'
    | 'restore'
    | 'adjust'
    | 'atomic'
    | 'stacking'
    | 'interrupt'
    | 'voice'
    | 'capture'
    | 'obstacles'
    | 'inferred'
    | 'confidence'
    | 'incomplete'
    | 'recovery'
    | 'anchor'
    | 'shell'
    | 'binding'
    | 'ordering'
    | 'parity'
    | 'derived'
    | 'lifecycle'
    | 'context'
    // M7
    | 'recipe'
    | 'layout'
    | 'transaction'
    | 'construction'
    | 'budget'
    | 'palette'
    | 'legacy';
  scene: () => EditorState;
  run: (editor: Editor) => Promise<StepResult[]>;
};

function context(editor: Editor, destination: InteractionContext['destination'], selectedId: string | null = null): InteractionContext {
  const scene = editor.engine.getSnapshot().scene;
  return {
    turnId: 'scenario',
    clock: 'epoch',
    timestamp: Date.now(),
    revision: scene.revision,
    frameId: scene.frameId,
    selectedId,
    destination,
  };
}

const floorId = (editor: Editor) =>
  editor.engine.getSnapshot().scene.design.surfaces.find((s) => s.class === 'floor')?.id ?? '';

const onFloor = (editor: Editor, position: Vec3): InteractionContext['destination'] => ({
  position,
  surfaceId: floorId(editor),
  kind: 'surface',
});

function check(label: string, ok: boolean, detail: string): StepResult {
  return { label, ok, detail };
}

function describe(result: EditResult): string {
  const report = result.report;
  const parts: string[] = [result.status];
  if (result.refusal) parts.push(result.refusal);
  if (report?.adjustment_reason) parts.push(report.adjustment_reason);
  if (report?.adjustment_distance_m) parts.push(`${Math.round(report.adjustment_distance_m * 100)}cm`);
  if (result.conflicts.length) parts.push(result.conflicts.join('; '));
  if (report?.alternatives.length)
    parts.push(`alternatives: ${report.alternatives.map((a) => a.summary).join(', ')}`);
  return parts.join(' · ');
}

function canonical(value: unknown, drop: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, drop));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      if (drop.has(key)) continue;
      out[key] = canonical((value as Record<string, unknown>)[key], drop);
    }
    return out;
  }
  return value;
}

/** `version` is excluded because it counts edits, as Swift's canonicalData does. Occupancy
 * and relations are NO LONGER excluded: M6 rebuilds both from geometry on every commit, so
 * they are part of what an undo has to restore exactly rather than a cache to ignore. */
const canon = (scene: EditorState) =>
  JSON.stringify(canonical(scene.design, new Set(['version'])));


// ------------------------------------------------------------------ M3 carry helpers

/** Yields to real timers. The settling adapter integrates gravity against wall-clock
 * `setTimeout`, so an interruption test has to wait the same way it does. */
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const objectIn = (editor: Editor, id: string) =>
  editor.engine.getSnapshot().scene.design.objects.find((o) => o.id === id);

/** Every pose except the carried one, so a drop can be shown not to scatter the room. */
const othersOf = (editor: Editor, exceptId: string) =>
  JSON.stringify(
    editor.engine
      .getSnapshot()
      .scene.design.objects.filter((o) => o.id !== exceptId)
      .map((o) => [o.id, o.pose.position, o.pose.yaw]),
  );

// ------------------------------------------------------------------ M4 capture helpers

/** Replays a recorded sweep of `degrees` and returns the mask it produced. */
function sweep(degrees: number, tracking: 'normal' | 'limited' | 'lost' = 'normal') {
  const tracker = new CoverageTracker();
  for (const frame of sweepFrames(degrees, tracking)) tracker.observe(frame);
  return tracker.snapshot();
}

const provenanceOf = (scene: EditorState, id: string) =>
  scene.design.surfaces.find((s) => s.id === id)?.provenance ?? 'missing';

const wallIds = (scene: EditorState) =>
  scene.design.surfaces.filter((s) => s.class === 'wall').map((s) => s.id);

const carryTraces = (editor: Editor) =>
  editor.diagnostics
    .getSnapshot()
    .filter((e) => e.stage === 'carry')
    .map((e) => e.code);

export const scenarios: Scenario[] = [
  {
    id: 'placement',
    title: 'Valid placement',
    milestone: 'M2',
    gate: 'placement',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const result = await editor.intent(
        { action: 'add', family: 'table' },
        context(editor, onFloor(editor, [0.2, 0, 1.2])),
      );
      return [
        check(
          'a table on open floor is accepted',
          result.status === 'applied',
          describe(result),
        ),
        check(
          'no hard violations were reported',
          (result.report?.violations_resolved.length ?? 0) === 0,
          `${result.report?.violations_resolved.length ?? 0} violations, ${result.report?.remaining_notes.length ?? 0} notes`,
        ),
      ];
    },
  },
  {
    id: 'overlap',
    title: 'Rejected overlap and door swing',
    milestone: 'M2',
    gate: 'overlap',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene.revision;

      // The door is on the east wall. Dropping the chair into its arc must be caught.
      const intoDoor = await editor.intent(
        { action: 'move', target_id: 'obj_chair_01' },
        context(editor, onFloor(editor, [1.5, 0, 0.5]), 'obj_chair_01'),
      );
      const blockedDoor =
        intoDoor.report?.violations_resolved.some((v) => v.type === 'blocks_door_swing') ?? false;
      steps.push(
        check(
          'the door swing arc is enforced',
          blockedDoor,
          describe(intoDoor),
        ),
      );
      steps.push(
        check(
          'a solvable conflict is adjusted, not refused',
          intoDoor.status === 'adjusted',
          `status ${intoDoor.status}`,
        ),
      );
      if (editor.engine.getSnapshot().pending) editor.engine.cancel();

      // Far outside the room: no nudge within 1.5m can rescue it.
      const outside = await editor.intent(
        { action: 'move', target_id: 'obj_chair_01' },
        context(editor, onFloor(editor, [12, 0, 12]), 'obj_chair_01'),
      );
      steps.push(
        check(
          'an unsolvable drop is rejected',
          outside.status === 'rejected',
          describe(outside),
        ),
      );
      steps.push(
        check(
          'a rejection offers somewhere else',
          (outside.report?.alternatives.length ?? 0) > 0,
          `${outside.report?.alternatives.length ?? 0} alternatives`,
        ),
      );
      steps.push(
        check(
          'the rejected move changed nothing',
          editor.engine.getSnapshot().scene.revision === before,
          `revision ${editor.engine.getSnapshot().scene.revision}, was ${before}`,
        ),
      );
      return steps;
    },
  },
  {
    id: 'support',
    title: 'Explicit support',
    milestone: 'M2',
    gate: 'support',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];

      const table = await editor.intent(
        { action: 'add', family: 'table', dimensions: [1, 0.75, 0.6] },
        context(editor, onFloor(editor, [0.4, 0, 1.3])),
      );
      steps.push(check('a table is placed to support things', table.status === 'applied', describe(table)));
      const tableId = editor.engine
        .getSnapshot()
        .scene.design.objects.find((o) => o.refined_class === 'table')?.id;

      const shelf = await editor.intent(
        { action: 'add', family: 'cabinet', dimensions: [0.3, 0.3, 0.3], count: 1 },
        context(editor, onFloor(editor, [-0.6, 0, 1.3])),
      );
      const smallId = editor.engine
        .getSnapshot()
        .scene.design.objects.find((o) => o.dimensions[1] === 0.3)?.id;
      steps.push(check('a small item is placed on the floor', shelf.status === 'applied', describe(shelf)));

      if (tableId && smallId) {
        const top =
          editor.engine.getSnapshot().scene.assemblies[tableId]?.support.bearing?.y ?? 0.75;
        const tablePose = editor.engine
          .getSnapshot()
          .scene.design.objects.find((o) => o.id === tableId)!.pose.position;
        const onTable = await editor.intent(
          { action: 'move', target_id: smallId },
          context(
            editor,
            { position: [tablePose[0]!, top, tablePose[2]!] as Vec3, surfaceId: tableId, kind: 'object' },
            smallId,
          ),
        );
        steps.push(
          check('a small item may rest on a named table', onTable.status === 'applied', describe(onTable)),
        );

        const bed = await editor.intent(
          { action: 'move', target_id: 'obj_bed_01' },
          context(
            editor,
            { position: [tablePose[0]!, top, tablePose[2]!] as Vec3, surfaceId: tableId, kind: 'object' },
            'obj_bed_01',
          ),
        );
        steps.push(
          check(
            'a bed is never stacked on a table',
            bed.status === 'rejected' && bed.refusal === 'incompatible_support',
            describe(bed),
          ),
        );
      } else {
        steps.push(check('support fixtures were created', false, 'missing table or small item'));
      }
      return steps;
    },
  },
  {
    id: 'undo',
    title: 'Atomic undo and structural edits',
    milestone: 'M2',
    gate: 'undo',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const snapshot = canon(editor.engine.getSnapshot().scene);
      const before = editor.engine.getSnapshot().scene.revision;

      // The desk sits against the east wall; pulling that wall in must be refused whole.
      const big = await editor.intent(
        { action: 'structure', target_id: 'srf_wall_east', structure_kind: 'offset_wall', metres: 0.8 },
        context(editor, null),
      );
      steps.push(check('a wall move that traps furniture is refused', big.status === 'rejected', describe(big)));
      steps.push(
        check(
          'the refused room change left the design untouched',
          canon(editor.engine.getSnapshot().scene) === snapshot &&
            editor.engine.getSnapshot().scene.revision === before,
          `revision ${editor.engine.getSnapshot().scene.revision}`,
        ),
      );

      const small = await editor.intent(
        { action: 'structure', target_id: 'srf_wall_south', structure_kind: 'offset_wall', metres: 0.2 },
        context(editor, null),
      );
      steps.push(check('a wall move with room to spare is applied', small.status === 'applied', describe(small)));

      const undone = await editor.intent({ action: 'undo' }, context(editor, null));
      steps.push(check('undo is accepted', undone.status === 'applied', describe(undone)));
      steps.push(
        check(
          'undo restored the design exactly',
          canon(editor.engine.getSnapshot().scene) === snapshot,
          canon(editor.engine.getSnapshot().scene) === snapshot ? 'byte-identical' : 'design differs',
        ),
      );
      return steps;
    },
  },
  {
    id: 'stale',
    title: 'Stale and duplicate operations',
    milestone: 'M2',
    gate: 'stale',
    scene: sampleRoomWithBuiltIn,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const stale = context(editor, onFloor(editor, [0, 0, 1.4]));

      const first = await editor.intent({ action: 'add', family: 'table' }, stale, 'op-fixed');
      steps.push(check('the first edit applies', first.status === 'applied', describe(first)));

      const replay = await editor.intent({ action: 'add', family: 'table' }, stale, 'op-fixed');
      steps.push(
        check(
          'the same operation id is refused at an old revision',
          replay.status === 'rejected',
          describe(replay),
        ),
      );

      const fresh = context(editor, onFloor(editor, [0, 0, 1.4]));
      const duplicate = await editor.intent({ action: 'add', family: 'table' }, fresh, 'op-fixed');
      steps.push(
        check(
          'a duplicate operation id is refused at the current revision',
          duplicate.status === 'rejected' && duplicate.refusal === 'duplicate_operation',
          describe(duplicate),
        ),
      );

      const immovable = await editor.intent(
        { action: 'move', target_id: 'obj_wardrobe_builtin' },
        context(editor, onFloor(editor, [0, 0, -1.5]), 'obj_wardrobe_builtin'),
      );
      steps.push(
        check(
          'a built-in object refuses to move',
          immovable.status === 'rejected' && immovable.refusal === 'immovable',
          describe(immovable),
        ),
      );
      return steps;
    },
  },

  // ---------------------------------------------------------------- M3 carry/release
  {
    id: 'carry-free',
    title: 'Carry through objects and the doorway',
    milestone: 'M3',
    gate: 'carry',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = canon(editor.engine.getSnapshot().scene);
      const begun = editor.engine.begin('obj_chair_01');
      steps.push(check('a grab enters the held phase', begun.status === 'preview' && editor.engine.getSnapshot().phase === 'held', `${begun.status}, phase ${editor.engine.getSnapshot().phase}`));

      // The PRD is explicit that a carry may pass through anything; only the destination
      // is validated. Each of these poses would be refused on release.
      const route: { label: string; position: Vec3 }[] = [
        { label: 'through the queen bed', position: [-0.985, 0, -0.985] },
        { label: 'through the writing desk', position: [1.7, 0, -1] },
        { label: 'into the door swing', position: [1.5, 0, 0.5] },
        { label: 'outside the room', position: [12, 0, 12] },
      ];
      let obstructed = false;
      let explained = 0;
      for (const leg of route) {
        editor.engine.preview({ position: leg.position, yaw: 0 });
        const snapshot = editor.engine.getSnapshot();
        if (snapshot.phase !== 'held') obstructed = true;
        if (snapshot.previewValidity && !snapshot.previewValidity.ok && snapshot.previewValidity.reason)
          explained += 1;
      }
      steps.push(check('carrying is never obstructed along the route', !obstructed, obstructed ? 'the phase left held' : 'held throughout all four legs'));
      steps.push(check('each invalid destination is explained while held', explained === route.length, `${explained}/${route.length} legs reported a reason`));
      steps.push(check('a clear destination reports no obstacle', (editor.engine.preview({ position: [-1.2, 0, 1.2], yaw: 0 }), editor.engine.getSnapshot().previewValidity?.ok === true), editor.engine.getSnapshot().previewValidity?.reason ?? 'no obstacle'));
      steps.push(check('nothing was committed while carrying', canon(editor.engine.getSnapshot().scene) === before, canon(editor.engine.getSnapshot().scene) === before ? 'design byte-identical' : 'design changed'));
      return steps;
    },
  },
  {
    id: 'carry-settle',
    title: 'A valid release settles under gravity',
    milestone: 'M3',
    gate: 'settle',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene.revision;
      const othersBefore = othersOf(editor, 'obj_chair_01');
      editor.engine.begin('obj_chair_01');
      editor.engine.preview({ position: [-1.2, 0.9, 1.2], yaw: 0 });
      const result = await editor.engine.release(editor.nextId(), floorId(editor));
      const settled = objectIn(editor, 'obj_chair_01')!.pose;
      steps.push(check('the drop is accepted', result.status === 'applied', describe(result)));
      steps.push(check('gravity brings it to the floor', settled.position[1] === 0, `settled at y=${settled.position[1]}`));
      steps.push(check('it keeps the destination it was dropped at', settled.position[0] === -1.2 && settled.position[2] === 1.2, JSON.stringify(settled.position)));
      steps.push(check('the move advances the revision once', editor.engine.getSnapshot().scene.revision === before + 1, `revision ${before} to ${editor.engine.getSnapshot().scene.revision}`));
      steps.push(check('dropping one object does not scatter the room', othersOf(editor, 'obj_chair_01') === othersBefore, othersOf(editor, 'obj_chair_01') === othersBefore ? 'every other pose unchanged' : 'another object moved'));
      steps.push(check('the phase returns to committed', editor.engine.getSnapshot().phase === 'committed', `phase ${editor.engine.getSnapshot().phase}`));
      const settleTrace = editor.diagnostics.getSnapshot().find((e) => e.stage === 'carry' && e.code === 'settled');
      steps.push(check('the settle duration is recorded', typeof settleTrace?.durationMs === 'number', settleTrace ? `${settleTrace.durationMs}ms recorded` : 'no settle event'));
      return steps;
    },
  },
  {
    id: 'carry-restore',
    title: 'An invalid release restores the original pose',
    milestone: 'M3',
    gate: 'restore',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = canon(editor.engine.getSnapshot().scene);
      const revision = editor.engine.getSnapshot().scene.revision;
      editor.engine.begin('obj_chair_01');
      editor.engine.preview({ position: [12, 0, 12], yaw: 0 });
      const result = await editor.engine.release(editor.nextId(), floorId(editor));
      steps.push(check('an unreachable destination is refused', result.status === 'rejected', describe(result)));
      steps.push(check('the refusal explains itself', result.message.length > 0 && (result.report?.alternatives.length ?? 0) > 0, `${result.report?.alternatives.length ?? 0} alternatives offered`));
      steps.push(check('the design is byte-identical to before the carry', canon(editor.engine.getSnapshot().scene) === before, canon(editor.engine.getSnapshot().scene) === before ? 'byte-identical' : 'design differs'));
      steps.push(check('the revision did not advance', editor.engine.getSnapshot().scene.revision === revision, `revision ${editor.engine.getSnapshot().scene.revision}`));
      steps.push(check('the transaction is closed', editor.engine.getSnapshot().phase === 'committed' && editor.engine.getSnapshot().preview === null, `phase ${editor.engine.getSnapshot().phase}`));
      steps.push(check('the restore reason is recorded', carryTraces(editor).includes('restored_unsolvable'), carryTraces(editor).join(' > ')));
      return steps;
    },
  },
  {
    id: 'carry-adjust',
    title: 'A lateral adjustment is confirmed, not slipped in',
    milestone: 'M3',
    gate: 'adjust',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const revision = editor.engine.getSnapshot().scene.revision;
      editor.engine.begin('obj_chair_01');
      // Just inside the bed: solvable by a nudge, and far enough to need narrating.
      editor.engine.preview({ position: [-0.2, 0, -1.2], yaw: 0 });
      const offered = await editor.engine.release('carry-op', floorId(editor));
      steps.push(check('a solvable overlap is offered, not applied', offered.status === 'adjusted' && offered.refusal === 'awaiting_confirmation', describe(offered)));
      steps.push(check('nothing is committed before confirmation', editor.engine.getSnapshot().scene.revision === revision, `revision ${editor.engine.getSnapshot().scene.revision}`));
      const confirmed = await editor.engine.confirm('carry-op');
      steps.push(check('confirming commits under the original operation id', confirmed.status === 'adjusted' || confirmed.status === 'applied', describe(confirmed)));
      steps.push(check('the confirmed move advances the revision once', editor.engine.getSnapshot().scene.revision === revision + 1, `revision ${revision} to ${editor.engine.getSnapshot().scene.revision}`));

      // A retried tool call must not move it twice.
      editor.engine.begin('obj_chair_01');
      editor.engine.preview({ position: [-1.2, 0, 1.2], yaw: 0 });
      const replay = await editor.engine.release('carry-op', floorId(editor));
      steps.push(check('replaying the same operation id is refused', replay.status === 'rejected' && replay.refusal === 'duplicate_operation', describe(replay)));
      return steps;
    },
  },
  {
    id: 'carry-atomic',
    title: 'One move yields one undo',
    milestone: 'M3',
    gate: 'atomic',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = canon(editor.engine.getSnapshot().scene);
      const logged = editor.engine.getLog().length;
      editor.engine.begin('obj_chair_01');
      // Edits made mid-carry join the transaction rather than opening a second writer.
      const tinted = await editor.engine.execute({ type: 'color', targetId: 'obj_chair_01', color: '#ff3b6b' }, editor.nextId(), editor.engine.getSnapshot().scene.revision);
      const turned = await editor.engine.execute({ type: 'rotate', targetId: 'obj_chair_01', yaw: 1 }, editor.nextId(), editor.engine.getSnapshot().scene.revision);
      steps.push(check('a mid-carry edit previews rather than commits', tinted.status === 'preview' && turned.status === 'preview', `${tinted.status}, ${turned.status}`));
      steps.push(check('intermediate frames are not edits', editor.engine.getLog().length === logged, `${editor.engine.getLog().length - logged} ops logged so far`));
      editor.engine.preview({ position: [-1.2, 0, 1.2], yaw: 1 });
      const result = await editor.engine.release(editor.nextId(), floorId(editor));
      steps.push(check('the release commits', result.status === 'applied', describe(result)));
      const added = editor.engine.getLog().slice(logged);
      steps.push(check('the whole carry is exactly one operation', added.length === 1 && added[0]!.command.type === 'move', `${added.length} ops: ${added.map((o) => o.command.type).join(',')}`));
      const undone = await editor.engine.execute({ type: 'undo' }, editor.nextId(), editor.engine.getSnapshot().scene.revision);
      steps.push(check('one undo is accepted', undone.status === 'applied', describe(undone)));
      steps.push(check('one undo restores the pose, colour and angle together', canon(editor.engine.getSnapshot().scene) === before, canon(editor.engine.getSnapshot().scene) === before ? 'byte-identical' : 'design differs'));
      return steps;
    },
  },
  {
    id: 'carry-stacking',
    title: 'No unintended stacking',
    milestone: 'M3',
    gate: 'stacking',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];

      // Dropping onto floor coordinates that happen to sit above the bed must not land
      // the chair on the bed. The declared support decides, never whatever is beneath.
      const bed = objectIn(editor, 'obj_bed_01')!;
      editor.engine.begin('obj_chair_01');
      editor.engine.preview({ position: [bed.pose.position[0]!, 1, bed.pose.position[2]!], yaw: 0 });
      const onto = await editor.engine.release(editor.nextId(), floorId(editor));
      steps.push(check('a floor drop never lands on what lies beneath', onto.status === 'rejected', describe(onto)));
      steps.push(check('the obstruction is named', onto.conflicts.join(' ').includes('bed') || onto.message.length > 0, [...onto.conflicts, onto.message].join(' | ')));

      // A bed is not a shelf, however explicitly it is aimed at one.
      const desk = objectIn(editor, 'obj_table_01')!;
      editor.engine.begin('obj_bed_01');
      editor.engine.preview({ position: [desk.pose.position[0]!, 0.75, desk.pose.position[2]!], yaw: 0 });
      const stacked = await editor.engine.release(editor.nextId(), 'obj_table_01');
      steps.push(check('a bed is never stacked on a desk', stacked.status === 'rejected' && stacked.refusal === 'incompatible_support', describe(stacked)));

      // A small item on a SCANNED desk: proves the derived bearing, which is what makes
      // object support reachable at all for furniture a real RoomPlan capture produced.
      const added = await editor.intent(
        { action: 'add', family: 'cabinet', dimensions: [0.3, 0.3, 0.3] },
        context(editor, onFloor(editor, [-1.4, 0, 1.4])),
      );
      const small = editor.engine.getSnapshot().scene.design.objects.find((o) => o.dimensions[1] === 0.3);
      steps.push(check('a small item is placed on the floor', added.status === 'applied' && !!small, describe(added)));
      if (small) {
        editor.engine.begin(small.id);
        editor.engine.preview({ position: [desk.pose.position[0]!, 0.75, desk.pose.position[2]!], yaw: 0 });
        const rested = await editor.engine.release(editor.nextId(), 'obj_table_01');
        steps.push(check('a small item may rest on a scanned desk', rested.status === 'applied', describe(rested)));
        steps.push(check('the derived bearing is disclosed, not passed off as measured', rested.caveats.some((c) => c.includes('derived')), rested.caveats.join(' | ') || 'no caveats'));
      }
      return steps;
    },
  },
  {
    id: 'carry-interrupt',
    title: 'Re-grab cancels settling; tracking loss rolls back',
    milestone: 'M3',
    gate: 'interrupt',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = canon(editor.engine.getSnapshot().scene);

      // A 0.9m fall takes roughly 430ms at 60Hz, so one tick lands mid-settle reliably.
      editor.engine.begin('obj_chair_01');
      editor.engine.preview({ position: [-1.2, 0.9, 1.2], yaw: 0 });
      const inFlight = editor.engine.release(editor.nextId(), floorId(editor));
      await tick(80);
      steps.push(check('the drop is settling', editor.engine.getSnapshot().phase === 'settling', `phase ${editor.engine.getSnapshot().phase}`));
      const regrab = editor.engine.begin('obj_chair_01');
      steps.push(check('re-grabbing resumes the same transaction', regrab.status === 'preview' && editor.engine.getSnapshot().phase === 'held', `${regrab.message} (phase ${editor.engine.getSnapshot().phase})`));
      const abandoned = await inFlight;
      steps.push(check('the cancelled settle commits nothing', abandoned.status === 'rejected' && abandoned.refusal === 'no_transaction', describe(abandoned)));
      steps.push(check('the design is untouched after the interruption', canon(editor.engine.getSnapshot().scene) === before, canon(editor.engine.getSnapshot().scene) === before ? 'byte-identical' : 'design differs'));

      // Losing tracking mid-carry must roll back rather than commit a guess.
      editor.engine.setTracking(false);
      const lost = editor.engine.getSnapshot();
      steps.push(check('tracking loss rolls the carry back', lost.phase === 'committed' && lost.result?.refusal === 'tracking_lost', `phase ${lost.phase}, ${lost.result?.refusal}`));
      steps.push(check('the committed scene survives tracking loss', canon(lost.scene) === before, canon(lost.scene) === before ? 'byte-identical' : 'design differs'));
      steps.push(check('the rollback reason is recorded', carryTraces(editor).includes('restored_tracking_lost'), carryTraces(editor).join(' > ')));

      editor.engine.setTracking(true);
      const resumed = editor.engine.begin('obj_chair_01');
      steps.push(check('editing resumes once tracking recovers', resumed.status === 'preview', describe(resumed)));
      return steps;
    },
  },
  {
    id: 'carry-voice',
    title: 'A voice move uses the same carry path',
    milestone: 'M3',
    gate: 'voice',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene.revision;
      const logged = editor.engine.getLog().length;
      const moved = await editor.intent(
        { action: 'move', target_id: 'obj_chair_01' },
        context(editor, onFloor(editor, [-1.2, 0, 1.2]), 'obj_chair_01'),
      );
      steps.push(check('a spoken move is applied', moved.status === 'applied', describe(moved)));
      steps.push(check('it produces one undoable operation', editor.engine.getLog().length === logged + 1, `${editor.engine.getLog().length - logged} ops`));
      steps.push(check('it advances the revision once', editor.engine.getSnapshot().scene.revision === before + 1, `revision ${before} to ${editor.engine.getSnapshot().scene.revision}`));
      // The same held/resolving/settling trace a gesture produces: one state machine.
      const trace = carryTraces(editor);
      steps.push(check('it runs through the carry state machine', trace.includes('held') && trace.includes('resolving') && trace.includes('committed'), trace.join(' > ')));
      return steps;
    },
  },

  // ------------------------------------------------------------- M4 calibration journey
  //
  // These replay recorded RoomPlan captures rather than driving the editor, so the whole
  // calibration judgement is verifiable without a device. The scenario's own `scene` is an
  // ordinary sample room; the work happens against `roomToSession` inside `run`.
  {
    id: 'calib-empty',
    title: 'An empty-room capture converts as measured',
    milestone: 'M4',
    gate: 'capture',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const { scene, coverage } = roomToSession(capture('empty-room'), 'frame-1', sweep(360));
      steps.push(check('the capture converts', scene.design.surfaces.length > 0, `${scene.design.surfaces.length} surfaces`));
      steps.push(check('it is a 4x4m room with a ceiling', Math.abs(scene.design.bounds.area_m2 - 16) < 0.01 && scene.design.bounds.ceiling_height > 2, `${scene.design.bounds.area_m2.toFixed(1)}m2, ${scene.design.bounds.ceiling_height.toFixed(2)}m high`));
      steps.push(check('an empty room has no furniture to remove', scene.design.objects.length === 0, `${scene.design.objects.length} objects`));
      steps.push(check('a full sweep leaves nothing inferred', coverage?.status === 'ready' && coverage.inferredWallIds.length === 0, `${coverage?.status}, ${coverage?.inferredWallIds.length ?? '?'} inferred`));
      steps.push(check('a fully observed shell is labelled observed', scene.provenance === 'observed', `provenance ${scene.provenance}`));
      steps.push(check('every wall is measured', wallIds(scene).every((id) => provenanceOf(scene, id) === 'real'), wallIds(scene).map((id) => `${id}:${provenanceOf(scene, id)}`).join(' ')));
      return steps;
    },
  },
  {
    id: 'calib-origin',
    title: 'A room away from the ARKit origin is usable',
    milestone: 'M4',
    gate: 'capture',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      // Found on device: every added object was refused as "Outside the calibrated room".
      // The ARKit origin is wherever the session started, and only the Y offset was being
      // applied, so the room sat metres off-origin and `add` defaulted to [0,0,0].
      const { scene, origin } = roomToSession(capture('offset-origin'), 'frame-1', sweep(360));
      steps.push(check('the capture is genuinely off-origin', Math.hypot(origin[0], origin[2]) > 5, `room origin ${origin.map((n) => n.toFixed(1)).join(', ')} in world space`));
      steps.push(check('the room is recentred on its floor centroid', scene.design.bounds.floor_polygon.every((p) => Math.abs(p[0]!) <= 2.01 && Math.abs(p[1]!) <= 2.01), JSON.stringify(scene.design.bounds.floor_polygon.map((p) => p.map((n) => Math.round(n)))) ));
      steps.push(check('recentring preserves the measurements', Math.abs(scene.design.bounds.area_m2 - 16) < 0.01, `${scene.design.bounds.area_m2.toFixed(1)}m2`));
      steps.push(check('the world transform records the displacement', Math.abs(scene.design.frame.world_transform[12]! - origin[0]) < 1e-6 && Math.abs(scene.design.frame.world_transform[14]! - origin[2]) < 1e-6, `translation ${scene.design.frame.world_transform.slice(12, 15).map((n) => n.toFixed(1)).join(', ')}`));

      // The exact action that failed on device: add with nothing pointed at.
      const room = createEditor(scene);
      try {
        const added = await room.intent(
          { action: 'add', family: 'table' },
          { turnId: 'scenario', clock: 'epoch', timestamp: Date.now(), revision: scene.revision, frameId: scene.frameId, selectedId: null, destination: null },
        );
        steps.push(check('adding with no pointed destination works', added.status === 'applied', describe(added)));
        steps.push(check('the object is inside the room', room.engine.getSnapshot().scene.design.objects.length === 1, `${room.engine.getSnapshot().scene.design.objects.length} objects`));
      } finally {
        room.dispose();
      }
      return steps;
    },
  },
  {
    id: 'calib-anchor',
    title: 'The room follows ARKit corrections instead of drifting',
    milestone: 'M4',
    gate: 'anchor',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const origin: Vec3 = [7.3, 0, -4.1];
      const room = { x: 1, y: 0, z: 0.5 };
      const at = (m: readonly number[], p: typeof room) => applyToPoint(m, { ...p });
      const dist = (a: typeof room, b: typeof room) =>
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

      // ARKit revises its map: the world frame yaws 3 degrees and shifts 12cm. The anchor
      // moves with the real world, and so does the camera's report of the same point.
      const yaw = (3 * Math.PI) / 180;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const revision = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, 0.12, 0, -0.05, 1];
      const atScan = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...origin, 1];
      // anchorNow = revision * atScan, for a pure-translation atScan.
      const moved = applyToPoint(revision, { x: origin[0], y: origin[1], z: origin[2] });
      const anchorNow = [...revision.slice(0, 12), moved.x, moved.y, moved.z, 1];

      const world = { x: room.x + origin[0], y: room.y + origin[1], z: room.z + origin[2] };
      const observedNow = applyToPoint(revision, { ...world });

      const stale = at(roomFromWorld(undefined, origin), observedNow);
      const tracked = at(roomFromWorld(anchorNow, origin), observedNow);

      steps.push(check('a world revision really does move unanchored content', dist(stale, room) > 0.1, `${(dist(stale, room) * 100).toFixed(1)}cm of drift without an anchor`));
      steps.push(check('following the anchor cancels it', dist(tracked, room) < 1e-6, `${(dist(tracked, room) * 1000).toFixed(3)}mm residual`));
      steps.push(check('rotation is carried, not just translation', Math.abs(tracked.x - room.x) < 1e-6 && Math.abs(tracked.z - room.z) < 1e-6, 'yaw component recovered'));

      // With no anchor the fallback must still be exact, or the development room and the
      // frames before the anchor exists would be wrong.
      const undrifted = at(roomFromWorld(undefined, origin), world);
      steps.push(check('the no-anchor fallback is exact', dist(undrifted, room) < 1e-6, `${dist(undrifted, room).toExponential(1)}m`));
      steps.push(check('a malformed anchor falls back safely', dist(at(roomFromWorld([1, 2, 3], origin), world), room) < 1e-6, 'ignored, static origin used'));
      // The identity anchor must agree with the scan-time origin exactly.
      steps.push(check('an unrevised anchor matches the static origin', dist(at(roomFromWorld(atScan, origin), world), room) < 1e-6, 'agree to 1e-6'));
      return steps;
    },
  },
  {
    id: 'calib-shell',
    title: 'The reconstructed shell maps to real room geometry',
    milestone: 'M4',
    gate: 'shell',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const parsed = ShellSchema.safeParse(exampleShell());
      steps.push(check("the worker's own output validates", parsed.success, parsed.success ? 'accepted' : JSON.stringify(parsed.error?.issues[0])));
      if (!parsed.success) return steps;
      const shell = parsed.data;

      steps.push(check('it is in room space, not world space', shell.space === 'room', shell.space));
      steps.push(check('every surface has one UV per vertex', shell.surfaces.every((s) => s.positions.length === s.uvs.length), shell.surfaces.map((s) => `${s.positions.length}/${s.uvs.length}`).join(' ')));
      steps.push(check('UVs stay inside the atlas', shell.surfaces.every((s) => s.uvs.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1)), 'all within 0..1'));
      steps.push(check('indices address real vertices', shell.surfaces.every((s) => s.indices.every((i) => i < s.positions.length)), 'in range'));

      // The geometry must be the measured room, not an approximation of it: a 4x4m floor
      // and a wall of the right height, in the frame the editor already works in.
      const floor = shell.surfaces.find((s) => s.class === 'floor');
      const span = (points: number[][], axis: number) =>
        Math.max(...points.map((p) => p[axis]!)) - Math.min(...points.map((p) => p[axis]!));
      steps.push(check('the floor is the measured 4x4m', !!floor && Math.abs(span(floor.positions, 0) - 4) < 0.05 && Math.abs(span(floor.positions, 2) - 4) < 0.05, floor ? `${span(floor.positions, 0).toFixed(2)}m x ${span(floor.positions, 2).toFixed(2)}m` : 'no floor'));
      const wall = shell.surfaces.find((s) => s.class === 'wall');
      steps.push(check('the wall reaches the measured ceiling', !!wall && Math.abs(span(wall.positions, 1) - 2.5) < 0.05, wall ? `${span(wall.positions, 1).toFixed(2)}m tall` : 'no wall'));

      // Provenance has to survive to the renderer, which dims an inferred surface.
      steps.push(check('each surface reports how much was observed', shell.surfaces.every((s) => s.observedFraction > 0 && s.observedFraction <= 1), shell.surfaces.map((s) => `${s.id} ${(s.observedFraction * 100).toFixed(0)}%`).join(', ')));
      steps.push(check('a well-observed surface is not called inferred', shell.surfaces.every((s) => (s.observedFraction >= 0.5 ? !s.inferred : true)), 'provenance agrees with coverage'));
      steps.push(check('the completion method is recorded', shell.completion.length > 0, shell.completion));
      return steps;
    },
  },
  {
    id: 'calib-furnished',
    title: 'Scanned furniture stays a physical obstacle',
    milestone: 'M4',
    gate: 'obstacles',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const { scene } = roomToSession(capture('furnished-room'), 'frame-1', sweep(360));
      steps.push(check('the furnished capture keeps its objects', scene.design.objects.length === 3, `${scene.design.objects.length} objects`));
      steps.push(check('measured and design start identical', scene.measured.objects.length === scene.design.objects.length, `${scene.measured.objects.length} measured, ${scene.design.objects.length} design`));

      // Erasing a real object from the design must not erase it from the room. This is the
      // physical-obstacle layer: the bed is still there even once the design forgets it.
      const bed = scene.design.objects.find((o) => o.class === 'bed')!;
      const erased: EditorState = {
        ...scene,
        design: { ...scene.design, objects: scene.design.objects.filter((o) => o.id !== bed.id) },
      };
      const stillBlocking = buildIndex(erased, '').neighbours.some((n) => n.id === bed.id);
      steps.push(check('a design-erased object still blocks placement', stillBlocking, stillBlocking ? 'present as a measured obstacle' : 'vanished from the index'));

      // Only an explicit physical removal clears it.
      const removed: EditorState = { ...erased, removedPhysicalIds: [bed.id] };
      const gone = !buildIndex(removed, '').neighbours.some((n) => n.id === bed.id);
      steps.push(check('an explicitly removed object stops blocking', gone, gone ? 'cleared' : 'still blocking'));
      return steps;
    },
  },
  {
    id: 'calib-inferred',
    title: 'The unobserved wall is inferred, not measured',
    milestone: 'M4',
    gate: 'inferred',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      // RoomPlan closes the room and reports four confident walls either way. Only coverage
      // knows the user never faced one of them.
      const blind = roomToSession(capture('empty-room'), 'frame-1');
      steps.push(check('RoomPlan alone calls every wall measured', wallIds(blind.scene).every((id) => provenanceOf(blind.scene, id) === 'real'), wallIds(blind.scene).map((id) => provenanceOf(blind.scene, id)).join(',')));

      const { scene, coverage } = roomToSession(capture('empty-room'), 'frame-1', sweep(270));
      const inferred = wallIds(scene).filter((id) => provenanceOf(scene, id) === 'inferred');
      steps.push(check('a 270 degree sweep leaves a wall unmeasured', inferred.length > 0, inferred.length ? `${inferred.join(', ')} inferred` : 'every wall claimed as measured'));
      steps.push(check('the walls actually swept stay measured', inferred.length < wallIds(scene).length, `${wallIds(scene).length - inferred.length} of ${wallIds(scene).length} measured`));
      steps.push(check('the shell as a whole is labelled inferred', scene.provenance === 'inferred', `provenance ${scene.provenance}`));
      steps.push(check('observation is demoted too, not just the design', scene.measured.surfaces.some((s) => s.provenance === 'inferred'), 'measured surfaces carry the same provenance'));
      steps.push(check('270 degrees is still accepted, not blocked', coverage?.status === 'ready', `status ${coverage?.status}`));
      return steps;
    },
  },
  {
    id: 'calib-confidence',
    title: 'RoomPlan low confidence becomes inferred',
    milestone: 'M4',
    gate: 'confidence',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      // A full sweep, so coverage cannot be what demotes the wall.
      const { scene } = roomToSession(capture('low-confidence-wall'), 'frame-1', sweep(360));
      steps.push(check('a low-confidence wall is not called measured', provenanceOf(scene, 'wall-west') === 'inferred', `wall-west is ${provenanceOf(scene, 'wall-west')}`));
      steps.push(check('confident walls are unaffected', provenanceOf(scene, 'wall-east') === 'real' && provenanceOf(scene, 'wall-north') === 'real', `east ${provenanceOf(scene, 'wall-east')}, north ${provenanceOf(scene, 'wall-north')}`));
      steps.push(check('one doubtful surface makes the shell inferred', scene.provenance === 'inferred', `provenance ${scene.provenance}`));

      // The floor fallback is the other source of inferred structure.
      const derived = roomToSession(capture('no-floor'), 'frame-1', sweep(360));
      steps.push(check('a missing floor is derived from the wall bases', derived.scene.design.surfaces.some((s) => s.class === 'floor' && s.provenance === 'inferred'), derived.scene.design.surfaces.filter((s) => s.class === 'floor').map((s) => `${s.id}:${s.provenance}`).join(' ')));
      steps.push(check('the derived floor is the right size', Math.abs(derived.scene.design.bounds.area_m2 - 16) < 0.01, `${derived.scene.design.bounds.area_m2.toFixed(1)}m2`));
      return steps;
    },
  },
  {
    id: 'calib-incomplete',
    title: 'An incomplete sweep asks for the missing view',
    milestone: 'M4',
    gate: 'incomplete',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      const { scene } = roomToSession(capture('empty-room'), 'frame-1');
      const half = evaluateCoverage(scene, sweep(180));
      steps.push(check('half a turn is not accepted as a room', half.status === 'needs_view', `status ${half.status}`));
      steps.push(check('it names which boundary is missing', half.missing.length > 0 && !!half.prompt, half.prompt ?? 'no prompt'));
      steps.push(check('the prompt names a direction, not an id', !!half.prompt && !half.prompt.includes('wall-'), half.prompt ?? ''));

      const none = evaluateCoverage(scene, sweep(0));
      steps.push(check('no sweep at all reports nothing observed', none.observedFraction === 0 && none.status === 'needs_view', `${(none.observedFraction * 100).toFixed(0)}% observed, ${none.status}`));

      // Tracking quality is part of coverage, not a separate concern.
      const degraded = evaluateCoverage(scene, sweep(360, 'limited'));
      steps.push(check('a full turn under bad tracking does not count', degraded.status === 'needs_view', `status ${degraded.status}`));
      steps.push(check('it says the problem was tracking, not aim', !!degraded.prompt && degraded.prompt.toLowerCase().includes('tracking'), degraded.prompt ?? ''));

      const full = evaluateCoverage(scene, sweep(360));
      steps.push(check('a good full turn is accepted', full.status === 'ready' && full.prompt === null, `status ${full.status}`));
      return steps;
    },
  },
  {
    id: 'calib-recovery',
    title: 'A failed capture explains itself',
    milestone: 'M4',
    gate: 'recovery',
    scene: sampleRoomFurnished,
    run: async () => {
      const steps: StepResult[] = [];
      let message = '';
      try {
        roomToSession(capture('two-walls'), 'frame-1', sweep(360));
        message = '';
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      steps.push(check('too little geometry is refused', message.length > 0, message || 'accepted a two-wall room'));
      steps.push(check('the refusal says what to do about it', /more room boundaries/i.test(message), message));

      // Malformed input must fail the same way rather than producing a half-built room.
      let malformed = '';
      try {
        roomToSession('{"id":"x","surfaces":[],"objects":[]}', 'frame-1');
      } catch (error) {
        malformed = error instanceof Error ? error.message : String(error);
      }
      steps.push(check('an empty capture is refused, not half-converted', malformed.length > 0, malformed));

      // A good capture after a failure still works: nothing is left poisoned.
      const recovered = roomToSession(capture('empty-room'), 'frame-1', sweep(360));
      steps.push(check('a retry after failure converts normally', recovered.scene.design.surfaces.length > 0 && recovered.coverage?.status === 'ready', `${recovered.scene.design.surfaces.length} surfaces, ${recovered.coverage?.status}`));
      return steps;
    },
  },

  // ------------------------------------------------------- M6 coordinated inputs
  //
  // Driven through the coordinator with a scripted transport rather than a live model.
  // The milestone plan asks for exactly that: the behaviours under test are event
  // ordering, turn binding and idempotency, none of which a real provider makes
  // reproducible.
  {
    id: 'input-binding',
    title: 'A delayed tool acts on the object that was selected when you spoke',
    milestone: 'M6',
    gate: 'binding',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const floor = floorId(editor);

      // Select the chair, point at open floor, start speaking.
      input.select('obj_chair_01', 'touch');
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floor, kind: 'surface' }, 'hand');
      input.openTurn('turn-1');
      input.sealTurn('turn-1');

      // While the tool call is in flight the user selects a different object.
      input.select('obj_table_01', 'touch');
      steps.push(check('the live selection has moved on', input.getSelection() === 'obj_table_01', input.getSelection() ?? 'none'));

      const result = await input.command({ action: 'move' }, { turnId: 'turn-1', source: 'voice' });
      steps.push(check('the delayed move is applied', result.status === 'applied' || result.status === 'adjusted', describe(result)));
      const chair = editor.engine.getSnapshot().scene.design.objects.find((o) => o.id === 'obj_chair_01')!;
      const table = editor.engine.getSnapshot().scene.design.objects.find((o) => o.id === 'obj_table_01')!;
      steps.push(check('the chair moved, not the table', Math.abs(chair.pose.position[0]! + 1.2) < 0.5 && Math.abs(table.pose.position[0]! - 1.7) < 0.01, `chair at ${chair.pose.position.map((n) => n.toFixed(2)).join(',')}, table at ${table.pose.position.map((n) => n.toFixed(2)).join(',')}`));

      // The op log must say which utterance caused it.
      const op = editor.engine.getLog().at(-1);
      steps.push(check('the edit is attributed to its turn', op?.causedBy.turnId === 'turn-1' && op.causedBy.source === 'voice', `${op?.causedBy.source}/${op?.causedBy.turnId}`));
      return steps;
    },
  },
  {
    id: 'input-staleness',
    title: 'A stale destination is questioned, not guessed',
    milestone: 'M6',
    gate: 'binding',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      // A controllable clock, so "older than two seconds" is provable without waiting
      // two seconds or reaching into private state.
      let clock = 1000;
      const input = new InputCoordinator(editor, () => clock);
      input.select('obj_chair_01');

      // A turn with no destination at all.
      input.openTurn('turn-none');
      input.sealTurn('turn-none');
      const none = await input.command({ action: 'move' }, { turnId: 'turn-none', source: 'voice' });
      steps.push(check('no destination asks the user to point', none.status === 'rejected' && /point/i.test(none.message), describe(none)));

      // A destination that was fresh when pointed at, and stale by the time speech ended.
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floorId(editor), kind: 'surface' });
      input.openTurn('turn-old');
      clock += DESTINATION_MAX_AGE_MS + 500;
      input.sealTurn('turn-old');
      const stale = await input.command({ action: 'move' }, { turnId: 'turn-old', source: 'voice' });
      steps.push(check('a destination older than two seconds is refused', stale.status === 'rejected', describe(stale)));
      steps.push(check('nothing was committed', editor.engine.getSnapshot().scene.revision === 0, `revision ${editor.engine.getSnapshot().scene.revision}`));

      // The same destination, used promptly, is fine — the rule is age, not suspicion.
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floorId(editor), kind: 'surface' });
      input.openTurn('turn-fresh');
      clock += 200;
      input.sealTurn('turn-fresh');
      const fresh = await input.command({ action: 'move' }, { turnId: 'turn-fresh', source: 'voice' });
      steps.push(check('a fresh destination is accepted', fresh.status === 'applied' || fresh.status === 'adjusted', describe(fresh)));

      // A selection that did not hold across the utterance. Two candidate referents,
      // so the only honest answer is to ask which one.
      input.select('obj_chair_01');
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floorId(editor), kind: 'surface' });
      input.openTurn('turn-wobble');
      input.select('obj_table_01');
      input.sealTurn('turn-wobble');
      const wobbled = await input.command({ action: 'move' }, { turnId: 'turn-wobble', source: 'voice' });
      steps.push(check('a selection that moved mid-utterance is questioned', wobbled.status === 'rejected' && /which/i.test(wobbled.message), describe(wobbled)));
      steps.push(check('the clarification names the ambiguity', /selection changed/i.test(wobbled.message), wobbled.message));

      // An unknown turn cannot act at all.
      const ghost = await input.command({ action: 'move' }, { turnId: 'never-opened', source: 'voice' });
      steps.push(check('an unknown turn is refused', ghost.status === 'rejected', describe(ghost)));
      return steps;
    },
  },
  {
    id: 'input-ordering',
    title: 'Out-of-order and duplicate deliveries are safe',
    milestone: 'M6',
    gate: 'ordering',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const floor = floorId(editor);

      // Two turns, each with its own destination, responses arriving in reverse order.
      input.select('obj_chair_01');
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floor, kind: 'surface' });
      input.openTurn('turn-A');
      input.sealTurn('turn-A');
      input.attachResponse('turn-A', 'resp-A');

      input.point({ position: [-1.5, 0, 0.6], surfaceId: floor, kind: 'surface' });
      input.openTurn('turn-B');
      input.sealTurn('turn-B');
      input.attachResponse('turn-B', 'resp-B');

      steps.push(check('each response resolves to its own turn', input.turnForResponse('resp-A')?.turnId === 'turn-A' && input.turnForResponse('resp-B')?.turnId === 'turn-B', 'resp-A -> turn-A, resp-B -> turn-B'));
      steps.push(check('an unknown response resolves to nothing', input.turnForResponse('resp-ghost') === null, 'null'));

      // B answers first, then A. Each must use its own sealed destination.
      const b = await input.command({ action: 'move' }, { turnId: 'turn-B', callId: 'call-B', source: 'voice' });
      steps.push(check('the later turn commits', b.status === 'applied' || b.status === 'adjusted', describe(b)));

      // The same call id delivered twice must not execute twice.
      const logged = editor.engine.getLog().length;
      const replay = await input.command({ action: 'move' }, { turnId: 'turn-B', callId: 'call-B', source: 'voice' });
      steps.push(check('a duplicate delivery returns the original result', replay.status === b.status && replay.message === b.message, `${replay.status} — ${replay.message}`));
      steps.push(check('and commits nothing further', editor.engine.getLog().length === logged, `${editor.engine.getLog().length - logged} extra ops`));
      return steps;
    },
  },
  {
    id: 'input-confirmation',
    title: 'A delayed confirmation cannot approve a newer edit',
    milestone: 'M6',
    gate: 'ordering',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const floor = floorId(editor);
      input.select('obj_chair_01');

      // A move that needs confirming.
      input.point({ position: [-0.2, 0, -1.2], surfaceId: floor, kind: 'surface' });
      input.openTurn('turn-1');
      input.sealTurn('turn-1');
      const offered = await input.command({ action: 'move' }, { turnId: 'turn-1', source: 'voice' });
      steps.push(check('the overlap is offered for confirmation', offered.refusal === 'awaiting_confirmation', describe(offered)));

      // The user does something else instead; a second pending operation appears.
      editor.engine.cancel();
      input.point({ position: [-0.25, 0, -1.15], surfaceId: floor, kind: 'surface' });
      input.openTurn('turn-2');
      input.sealTurn('turn-2');
      const second = await input.command({ action: 'move' }, { turnId: 'turn-2', source: 'voice' });
      steps.push(check('a second edit is now pending', second.refusal === 'awaiting_confirmation', describe(second)));

      // The first turn's "yes" arrives late. It must not approve the second edit.
      const late = await input.confirm('turn-1');
      steps.push(check('the stale confirmation is refused', late.status === 'rejected', describe(late)));
      steps.push(check("the newer edit is still waiting", editor.engine.getSnapshot().pending !== null, editor.engine.getSnapshot().pending ? 'still pending' : 'wrongly resolved'));

      const owned = await input.confirm('turn-2');
      steps.push(check('its own turn can confirm it', owned.status === 'applied' || owned.status === 'adjusted', describe(owned)));
      return steps;
    },
  },
  {
    id: 'input-parity',
    title: 'Voice reaches every action, and joins the active carry',
    milestone: 'M6',
    gate: 'parity',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const before = canon(editor.engine.getSnapshot().scene);
      const logged = editor.engine.getLog().length;

      const named = await input.command({ action: 'select', target_id: 'desk chair' }, { source: 'voice' });
      steps.push(check('an object can be selected by name', named.status === 'applied', describe(named)));
      const invented = await input.command({ action: 'select', target_id: 'chaise longue' }, { source: 'voice' });
      steps.push(check('an invented name is refused, not guessed at', invented.status === 'rejected' && invented.refusal === 'unknown_target', describe(invented)));

      // A voice edit during a grab joins that transaction rather than opening a second.
      input.select('obj_chair_01');
      editor.engine.begin('obj_chair_01');
      const tint = await input.command({ action: 'color', color: '#ff3b6b' }, { source: 'voice' });
      steps.push(check('a voice recolour during a carry only previews', tint.status === 'preview', describe(tint)));
      steps.push(check('it does not open a competing commit', editor.engine.getLog().length === logged, `${editor.engine.getLog().length - logged} ops`));

      const other = await input.command({ action: 'color', target_id: 'obj_table_01', color: '#112233' }, { source: 'voice' });
      steps.push(check('editing a different object mid-carry is refused', other.status === 'rejected', describe(other)));

      editor.engine.preview({ position: [-1.2, 0, 1.2], yaw: 0 });
      const released = await editor.engine.release(editor.nextId(), floorId(editor));
      steps.push(check('the carry commits once', released.status === 'applied' && editor.engine.getLog().length === logged + 1, `${editor.engine.getLog().length - logged} ops`));

      const undone = await input.command({ action: 'undo' }, { source: 'voice' });
      steps.push(check('one undo restores pose and colour together', undone.status === 'applied' && canon(editor.engine.getSnapshot().scene) === before, canon(editor.engine.getSnapshot().scene) === before ? 'byte-identical' : 'design differs'));

      const cancelled = await input.command({ action: 'cancel' }, { source: 'voice' });
      steps.push(check('voice can cancel', cancelled.status === 'applied', describe(cancelled)));
      return steps;
    },
  },
  {
    id: 'input-derived',
    title: 'Occupancy and relations follow every committed state',
    milestone: 'M6',
    gate: 'derived',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const occupancy = () => editor.engine.getSnapshot().scene.design.occupancy;
      const sums = () => occupancy().grid_rle.reduce((a, b) => a + b, 0);
      const cells = () => (occupancy().size[0] ?? 0) * (occupancy().size[1] ?? 0);

      steps.push(check('the grid exists before any edit', cells() > 0 && sums() === cells(), `${occupancy().size.join('x')}, runs sum ${sums()}`));
      steps.push(check('it is the fixed 5cm resolution', occupancy().resolution_m === 0.05, String(occupancy().resolution_m)));

      const before = { free: sums() - 0, relations: editor.engine.getSnapshot().scene.design.relations.length };
      input.select('obj_bed_01');
      const removed = await input.command({ action: 'remove' }, { source: 'voice' });
      steps.push(check('removing the bed commits', removed.status === 'applied', describe(removed)));
      steps.push(check('the grid still sums to its cell count', sums() === cells(), `${sums()} of ${cells()}`));
      steps.push(check('relations for the removed object are gone', !editor.engine.getSnapshot().scene.design.relations.some((r) => r.subject === 'obj_bed_01' || r.object === 'obj_bed_01'), `${editor.engine.getSnapshot().scene.design.relations.length} relations, was ${before.relations}`));
      steps.push(check('no relation references a missing entity', editor.engine.getSnapshot().scene.design.relations.every((r) => editor.engine.getSnapshot().scene.design.objects.some((o) => o.id === r.subject && o.state === 'present') && (editor.engine.getSnapshot().scene.design.objects.some((o) => o.id === r.object) || editor.engine.getSnapshot().scene.design.surfaces.some((s) => s.id === r.object))), 'all resolve'));
      steps.push(check('blocks stays unemitted until a circulation model exists', !editor.engine.getSnapshot().scene.design.relations.some((r) => r.predicate === 'blocks'), 'no blocks predicate'));

      // Physical obstacles are a separate layer: erasing from the design must not make
      // the floor read as clear.
      const scene = editor.engine.getSnapshot().scene;
      steps.push(check('the erased object is still a physical obstacle', scene.removedPhysicalIds.includes('obj_bed_01') && scene.measured.objects.some((o) => o.id === 'obj_bed_01'), 'retained in measured'));
      return steps;
    },
  },
  {
    id: 'input-context',
    title: 'The spatial context packet is complete, ranked, and small',
    milestone: 'M6',
    gate: 'context',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      // Standing by the door, looking across the room at the furniture.
      const view = { position: [1.6, 1.5, 0.9] as Vec3, forward: [-0.8, -0.25, -0.55] as Vec3, fovDeg: 68 };
      const scp = buildScp(scene, view, { salienceStack: [], lastTap: { entity: null, ageMs: 0 }, lastFloorHit: { point: [0, 0, 0], ageMs: 300 } }, 1_758_153_600_000);

      steps.push(check('it validates against the frozen SCP schema', ScpSchema.safeParse(scp).success, ScpSchema.safeParse(scp).success ? 'accepted' : JSON.stringify(ScpSchema.safeParse(scp).error?.issues[0])));
      const bytes = JSON.stringify(scp).length;
      steps.push(check('it fits the 2KB budget', bytes < 2048, `${bytes} bytes`));

      steps.push(check('it describes what is in view', scp.visible_entities.length > 0, scp.visible_entities.map((v) => `${v.id} ${v.angular_offset_deg}deg`).join(', ')));
      steps.push(check('entities are ordered by how centred they are', scp.visible_entities.every((v, i, all) => i === 0 || (all[i - 1]!.angular_offset_deg ?? 0) <= v.angular_offset_deg), 'nearest-to-crosshair first'));
      steps.push(check('lists are bounded to the schema caps', scp.visible_entities.length <= 12 && scp.ranked_candidates.length <= 5 && scp.salience_stack.length <= 6 && scp.free_space_summary.wall_clearances.length <= 8, `${scp.visible_entities.length} visible, ${scp.ranked_candidates.length} candidates`));
      steps.push(check('candidates are ranked, best first', scp.ranked_candidates.every((c, i, all) => i === 0 || (all[i - 1]!.score ?? 0) >= c.score), scp.ranked_candidates.map((c) => `${c.entity_id}:${c.score}`).join(' ')));
      steps.push(check('every candidate names a real entity', scp.ranked_candidates.every((c) => scene.design.objects.some((o) => o.id === c.entity_id)), 'all resolve'));

      // The client decides ambiguity; the model is never asked to break a tie.
      const tie = { ...scp, ranked_candidates: [{ entity_id: 'a', score: 0.5, demonstrative: 'that' as const }, { entity_id: 'b', score: 0.45, demonstrative: 'that' as const }] };
      const clear = { ...scp, ranked_candidates: [{ entity_id: 'a', score: 0.9, demonstrative: 'that' as const }, { entity_id: 'b', score: 0.2, demonstrative: 'that' as const }] };
      steps.push(check('a close pair is declared ambiguous by the client', isAmbiguous(tie) && !isAmbiguous(clear), 'gap < 0.1 is a tie'));

      // Free space comes from the committed occupancy grid, so it tracks edits.
      const rect = scp.free_space_summary.largest_open_rect;
      steps.push(check('the largest open rectangle is real floor', rect.size[0]! > 0 && rect.size[1]! > 0 && rect.size[0]! * rect.size[1]! <= scene.design.bounds.area_m2, `${rect.size.join('x')}m at ${rect.center.join(',')}`));
      steps.push(check('it agrees with the checked-in fixture', Math.abs(rect.size[0]! - 4) < 0.06 && Math.abs(rect.size[1]! - 2.2) < 0.06, `${rect.size.join('x')} vs fixture 4x2.2`));
      steps.push(check('wall clearances are measured for every wall', scp.free_space_summary.wall_clearances.length === scene.design.surfaces.filter((s) => s.class === 'wall').length, `${scp.free_space_summary.wall_clearances.length} walls`));

      // Free space is derived, so clearing the floor must widen what the model is told.
      const emptied = buildOccupancy({ ...scene, design: { ...scene.design, objects: [] } }, []);
      const grown = largestOpenRect(emptied);
      const before = rect.size[0]! * rect.size[1]!;
      const after = grown.size[0]! * grown.size[1]!;
      steps.push(check('an emptied room reports more free space', after > before, `${after.toFixed(2)}m2 empty vs ${before.toFixed(2)}m2 furnished`));
      return steps;
    },
  },
  {
    id: 'input-lifecycle',
    title: 'Obsolete work cannot commit',
    milestone: 'M6',
    gate: 'lifecycle',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const input = new InputCoordinator(editor);
      const floor = floorId(editor);
      input.select('obj_chair_01');
      input.point({ position: [-1.2, 0, 1.2], surfaceId: floor, kind: 'surface' });
      input.openTurn('turn-1');
      input.sealTurn('turn-1');

      // Voice restarts, or the adapter is disposed, while the tool is in flight.
      input.invalidate();
      const late = await input.command({ action: 'move' }, { turnId: 'turn-1', source: 'voice' });
      steps.push(check('work from a previous generation is refused', late.status === 'rejected', describe(late)));
      steps.push(check('nothing was committed', editor.engine.getSnapshot().scene.revision === 0, `revision ${editor.engine.getSnapshot().scene.revision}`));

      // Tracking loss must stop positional commits.
      input.select('obj_chair_01');
      input.point({ position: [-1.0, 0, 1.0], surfaceId: floor, kind: 'surface' });
      editor.engine.setTracking(false);
      const blind = await input.command({ action: 'move' }, { source: 'voice' });
      steps.push(check('a positional edit waits for reliable tracking', blind.status === 'rejected' && blind.refusal === 'tracking_lost', describe(blind)));
      editor.engine.setTracking(true);

      // Dwell selection needs sustained intent, not a passing glance.
      const fresh = new InputCoordinator(editor);
      steps.push(check('a glance does not select', fresh.dwell('obj_bed_01') === false && fresh.getSelection() === null, 'no selection'));
      steps.push(check('a different target resets the dwell', fresh.dwell('obj_table_01') === false, 'reset'));
      return steps;
    },
  },
  // ---------------------------------------------------------------- M7
  {
    id: 'tool-schema',
    title: 'The voice tools ship a schema the model can actually use',
    milestone: 'M7',
    gate: 'voice',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      // `z.toJSONSchema` emits correct 2020-12 tuple syntax and OpenAI's function
      // validator rejects it, so `dimensions` made the whole edit_room schema unusable
      // and the assistant reported that it could not resize anything. Checked on the
      // SHIPPED object, because the bug was in the encoding and not in the logic.
      const rejected: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'prefixItems' || key === '$schema' || key === 'additionalItems')
            rejected.push(`${path}.${key}`);
          if (key === 'items' && value === false) rejected.push(`${path}.items=false`);
          walk(value, `${path}.${key}`);
        }
      };
      for (const tool of [voiceTool, recipeTool]) walk(tool.parameters, tool.name);
      steps.push(check('no keyword the API rejects survives', rejected.length === 0, rejected.join(', ') || 'clean'));

      const properties = (voiceTool.parameters as { properties: Record<string, unknown> }).properties;
      steps.push(check('resize is expressible without a tuple', ['width_m', 'height_m', 'depth_m', 'width_delta_m'].every((k) => k in properties), Object.keys(properties).filter((k) => /_m$/.test(k)).join(', ')));

      // Every phrasing a model might reach for, including one axis at a time.
      const floor = floorId(editor);
      await editor.intent({ action: 'add', family: 'table' }, context(editor, { position: [0, 0, 0], surfaceId: floor, kind: 'surface' }));
      const id = editor.engine.getSnapshot().scene.design.objects[0]?.id;
      const dims = () => editor.engine.getSnapshot().scene.design.objects[0]?.dimensions ?? [];
      const wide = await editor.intent({ action: 'resize', target_id: id, width_m: 1.4 }, context(editor, null));
      steps.push(check('an absolute single axis resizes', wide.status === 'applied' && Math.abs((dims()[0] ?? 0) - 1.4) < 1e-6, `${describe(wide)} -> ${dims().join(' x ')}`));
      steps.push(check('the untouched axes keep their size', Math.abs((dims()[1] ?? 0) - 0.75) < 1e-6, dims().join(' x ')));
      const wider = await editor.intent({ action: 'resize', target_id: id, width_delta_m: 0.2 }, context(editor, null));
      steps.push(check('a relative change resolves from the current size', wider.status === 'applied' && Math.abs((dims()[0] ?? 0) - 1.6) < 1e-6, dims().join(' x ')));
      const silent = await editor.intent({ action: 'resize', target_id: id }, context(editor, null));
      steps.push(check('no size at all asks rather than guesses', silent.status === 'rejected' && /how wide/i.test(silent.message), silent.message));
      return steps;
    },
  },
  {
    id: 'restyle-bedroom',
    title: 'A blue bedroom with three frames on the window wall',
    milestone: 'M7',
    gate: 'recipe',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const result = await editor.restyle(
        {
          label: 'a blue bedroom with three frames',
          items: [
            { family: 'bed', count: 1, color: '#3b6ea5' },
            { family: 'frame', count: 3, color: '#2f2f33', surface_id: 'srf_wall_north' },
          ],
          wall_color: '#5b7fa8',
        },
        context(editor, null),
      );
      steps.push(check('the arrangement commits', result.status === 'applied', describe(result)));

      const scene = editor.engine.getSnapshot().scene;
      const frames = scene.design.objects.filter((o) => o.refined_class === 'frame');
      steps.push(check('three distinct frames exist', frames.length === 3 && new Set(frames.map((f) => f.id)).size === 3, frames.map((f) => f.id).join(', ')));
      steps.push(check('the palette reached the walls', scene.design.surfaces.filter((s) => s.class === 'wall').every((s) => s.material_ref === '#5b7fa8'), 'all walls repainted'));

      // The window spans x -0.7..0.7 on the north wall. A frame overlapping it would
      // have been a `blocks_window` violation, so this is belt and braces on geometry
      // the engine already refused to commit.
      const clear = frames.every((f) => Math.abs(f.pose.position[0] ?? 0) - (f.dimensions[0] ?? 0) / 2 > 0.7);
      steps.push(check('no frame is hung over the window', clear, frames.map((f) => (f.pose.position[0] ?? 0).toFixed(2)).join(', ')));

      const group = Object.values(scene.groups).find((g) => g.family === 'frame');
      steps.push(check('the group records its member order', !!group && group.order.length === 3, group?.order.join(',') ?? 'no group'));
      // Equal spacing IN USABLE WALL SPACE: the window splits the wall, so the members
      // sharing a run sit exactly the recorded pitch apart.
      const sorted = [...frames].sort((a, b) => (a.pose.position[0] ?? 0) - (b.pose.position[0] ?? 0));
      const gaps = sorted.slice(1).map((f, i) => Math.abs((f.pose.position[0] ?? 0) - (sorted[i]?.pose.position[0] ?? 0)));
      const matched = group ? gaps.some((g) => Math.abs(g - group.spacingM) < 1e-3) : false;
      steps.push(check('members in one run are evenly spaced', matched, `gaps ${gaps.map((g) => g.toFixed(2)).join(', ')} vs pitch ${group?.spacingM}`));

      // Distinct AND editable: recolouring one must not touch the other two.
      const one = await editor.intent({ action: 'color', target_id: frames[0]!.id, color: '#ff0000' }, context(editor, null));
      const after = editor.engine.getSnapshot().scene.design.objects.filter((o) => o.refined_class === 'frame');
      steps.push(check('each frame is individually editable', one.status === 'applied' && after.filter((f) => f.material_ref === '#ff0000').length === 1, describe(one)));
      return steps;
    },
  },
  {
    id: 'group-count',
    title: 'Frame count two to three to two keeps member identity',
    milestone: 'M7',
    gate: 'recipe',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const first = await editor.restyle(
        { label: 'two frames', items: [{ family: 'frame', count: 2, surface_id: 'srf_wall_south' }] },
        context(editor, null),
      );
      steps.push(check('two frames are hung', first.status === 'applied', describe(first)));
      const groupId = Object.values(editor.engine.getSnapshot().scene.groups)[0]?.id ?? '';
      const two = [...(editor.engine.getSnapshot().scene.groups[groupId]?.order ?? [])];
      const pitchTwo = editor.engine.getSnapshot().scene.groups[groupId]?.spacingM ?? 0;
      const at = (list: string[], i: number) => list[i] ?? '';

      const grown = await editor.intent({ action: 'group_edit', group_id: groupId, count: 3 }, context(editor, null));
      steps.push(check('the count increases', grown.status === 'applied', describe(grown)));
      const three = [...(editor.engine.getSnapshot().scene.groups[groupId]?.order ?? [])];
      const pitchThree = editor.engine.getSnapshot().scene.groups[groupId]?.spacingM ?? 0;
      steps.push(check('the original members keep their ids', three.length === 3 && at(three, 0) === at(two, 0) && at(three, 1) === at(two, 1), `${two.join(',')} -> ${three.join(',')}`));
      steps.push(check('only the difference was added', new Set(three).size === 3 && !two.includes(at(three, 2)), `added ${at(three, 2)}`));
      steps.push(check('spacing was recomputed', Math.abs(pitchThree - pitchTwo) > 1e-6, `${pitchTwo} -> ${pitchThree}`));

      const shrunk = await editor.intent({ action: 'group_edit', group_id: groupId, count: 2 }, context(editor, null));
      steps.push(check('the count decreases', shrunk.status === 'applied', describe(shrunk)));
      const back = [...(editor.engine.getSnapshot().scene.groups[groupId]?.order ?? [])];
      const live = editor.engine.getSnapshot().scene.design.objects.filter((o) => o.state === 'present').map((o) => o.id);
      steps.push(check('it trims from the end of the established order', back.length === 2 && at(back, 0) === at(two, 0) && at(back, 1) === at(two, 1), back.join(',')));
      steps.push(check('the removed member is gone from the room', !live.includes(at(three, 2)), `${live.length} objects left`));
      return steps;
    },
  },
  {
    id: 'layout-infeasible',
    title: 'A bed and two nightstands that cannot fit',
    milestone: 'M7',
    gate: 'layout',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene;
      const result = await editor.restyle(
        {
          label: 'a big bed and two nightstands',
          items: [
            { family: 'bed', count: 1, dimensions: [2.4, 0.6, 2.5] },
            { family: 'cabinet', count: 2 },
          ],
        },
        context(editor, null),
      );
      steps.push(check('it refuses rather than improvises', result.status === 'rejected', describe(result)));
      steps.push(check('the refusal explains the conflict', /nowhere|overlap|door/i.test(result.message), result.message));
      steps.push(check('alternatives are offered', result.conflicts.length > 0, result.conflicts.join(' | ')));

      const after = editor.engine.getSnapshot().scene;
      steps.push(check('nothing was partially committed', after.design.objects.length === before.design.objects.length && after.revision === before.revision, `${after.design.objects.length} objects at revision ${after.revision}`));
      steps.push(check('nothing was silently shrunk', after.design.objects.every((o, i) => o.dimensions.join() === (before.design.objects[i]?.dimensions ?? []).join()), 'dimensions unchanged'));
      return steps;
    },
  },
  {
    id: 'restyle-preserve',
    title: 'A restyle that preserves a selected object',
    milestone: 'M7',
    gate: 'transaction',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const result = await editor.restyle(
        {
          label: 'restyle but keep the desk',
          items: [{ family: 'cabinet', count: 1 }],
          preserve_ids: ['obj_table_01'],
          hide_ids: ['obj_bed_01'],
        },
        context(editor, null),
      );
      steps.push(check('the restyle commits', result.status === 'applied', describe(result)));

      const scene = editor.engine.getSnapshot().scene;
      const table = scene.design.objects.find((o) => o.id === 'obj_table_01');
      steps.push(check('the preserved object is still visible', table?.state === 'present', table ? 'present' : 'gone'));

      // Still an OBSTACLE, not just still drawn: a probe at its pose must be refused.
      const index = buildIndex(scene, 'probe');
      const probe = {
        id: 'probe',
        class: 'storage' as const,
        dimensions: [0.6, 0.6, 0.6] as Vec3,
        pose: { position: [...table!.pose.position] as Vec3, yaw: 0 },
        pivot: 'base_center' as const,
      };
      const finding = evaluatePlacement(scene, probe as never, { index, skipNotes: true });
      steps.push(check('the preserved object still blocks placement', finding.violations.some((v) => v.with === 'obj_table_01'), finding.violations.map((v) => `${v.type}:${v.with}`).join(', ') || 'no violation'));

      // Visibility intent is NOT physical removal.
      steps.push(check('the hidden object is recorded as intent', scene.removalMaskIds.includes('obj_bed_01'), scene.removalMaskIds.join(',')));
      steps.push(check('hiding it did not delete the physical object', !scene.removedPhysicalIds.includes('obj_bed_01') && scene.measured.objects.some((o) => o.id === 'obj_bed_01'), 'measured observation retained'));
      steps.push(check('the intent names the reconstruction it was made against', scene.removalMaskCalibration?.calibrationId === scene.calibrationId, JSON.stringify(scene.removalMaskCalibration)));
      return steps;
    },
  },
  {
    id: 'restyle-undo',
    title: 'Undo restores objects, surfaces, groups and visibility intent together',
    milestone: 'M7',
    gate: 'transaction',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = JSON.parse(JSON.stringify(editor.engine.getSnapshot().scene)) as EditorState;
      const result = await editor.restyle(
        {
          label: 'restyle everything',
          items: [{ family: 'frame', count: 2, surface_id: 'srf_wall_south' }],
          wall_color: '#223344',
          hide_ids: ['obj_bed_01'],
        },
        context(editor, null),
      );
      steps.push(check('the restyle commits', result.status === 'applied', describe(result)));
      const mid = editor.engine.getSnapshot().scene;
      steps.push(check('it advanced the revision exactly once', mid.revision === before.revision + 1, `${before.revision} -> ${mid.revision}`));

      const undone = await editor.intent({ action: 'undo' }, context(editor, null));
      steps.push(check('undo succeeds', undone.status === 'applied', describe(undone)));
      const after = editor.engine.getSnapshot().scene;
      steps.push(check('objects are restored', after.design.objects.length === before.design.objects.length, `${after.design.objects.length} objects`));
      steps.push(check('surfaces are restored', after.design.surfaces.every((s, i) => s.material_ref === before.design.surfaces[i]?.material_ref), 'colours restored'));
      steps.push(check('groups are restored', Object.keys(after.groups).length === Object.keys(before.groups).length, `${Object.keys(after.groups).length} groups`));
      steps.push(check('visibility intent is restored', after.removalMaskIds.length === before.removalMaskIds.length, `${after.removalMaskIds.length} masked`));
      return steps;
    },
  },
  {
    id: 'structure-resolve',
    title: 'A wall moved into furniture gives a complete alternative or refuses whole',
    milestone: 'M7',
    gate: 'layout',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene;
      const moved = await editor.intent(
        { action: 'structure', target_id: 'srf_wall_east', structure_kind: 'offset_wall', metres: 0.6 },
        context(editor, null),
      );
      const complete = moved.status === 'adjusted' && moved.refusal === 'awaiting_confirmation';
      const refusedWhole = moved.status === 'rejected';
      steps.push(check('it is a complete alternative or a whole refusal', complete || refusedWhole, describe(moved)));
      steps.push(check('nothing committed before the answer', editor.engine.getSnapshot().scene.revision === before.revision, `revision ${editor.engine.getSnapshot().scene.revision}`));
      if (complete) {
        steps.push(check('the alternative says what would move', /move/i.test(moved.report?.adjustment_reason ?? ''), moved.report?.adjustment_reason ?? ''));
        const confirmed = await editor.intent({ action: 'confirm' }, context(editor, null));
        steps.push(check('confirming applies the whole change', confirmed.status === 'applied', describe(confirmed)));
        const after = editor.engine.getSnapshot().scene;
        const index = buildIndex(after, '');
        const valid = after.design.objects
          .filter((o) => o.state === 'present')
          .every((o) => evaluatePlacement(after, o, { index, skipNotes: true }).violations.length === 0);
        steps.push(check('every object is valid afterwards', valid, 'no violations'));
      } else {
        steps.push(check('the refusal names the obstruction', (moved.report?.violations_resolved.length ?? 0) > 0, describe(moved)));
      }
      return steps;
    },
  },
  {
    id: 'three-legged-bed',
    title: 'A three-legged bed is refused with a supported alternative',
    milestone: 'M7',
    gate: 'construction',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const result = await editor.intent(
        { action: 'add', family: 'bed', legs: 3 },
        context(editor, onFloor(editor, [0, 0, 0])),
      );
      steps.push(check('it is refused, not approximated', result.status === 'rejected' && result.refusal === 'construction_invalid', describe(result)));
      steps.push(check('the refusal names the missing template', /three|3-support/i.test(result.message) && /template/i.test(result.message), result.message));
      steps.push(check('a supported alternative is offered', /four-legged|three-legged table/i.test(result.message), result.message));
      steps.push(check('the assumptions travel with it', result.caveats.some((c) => /not verified/i.test(c)), result.caveats.join(' | ')));
      steps.push(check('nothing was added', editor.engine.getSnapshot().scene.design.objects.length === 0, 'room still empty'));

      // The authored three-support template that DOES exist behaves differently: a
      // tripod table is buildable and carries its edge-load finding as a caveat.
      const tripod = await editor.intent(
        { action: 'add', family: 'table', legs: 3 },
        context(editor, onFloor(editor, [0, 0, 0])),
      );
      const assembly = Object.values(editor.engine.getSnapshot().scene.assemblies)[0];
      steps.push(check('the authored tripod table is allowed', tripod.status === 'applied', describe(tripod)));
      steps.push(check('its construction result names the template version', assembly?.constructionResult?.templateVersion === '1.1.0', assembly?.constructionResult?.templateVersion ?? 'none'));
      steps.push(check('its edge-load finding is recorded, not hidden', assembly?.constructionResult?.status === 'needs-adjustment' && assembly.constructionResult.findings.some((f) => f.code === 'unbalanced'), assembly?.constructionResult?.findings.map((f) => f.code).join(',') ?? ''));

      // M7.5.3: a dimension change re-runs the authored checks. A shelf that was fine
      // at 0.8m is not fine at 1.4m, and the verdict has to move with the geometry
      // rather than stay at whatever it was when the object was created.
      const shelf = await editor.intent(
        { action: 'add', family: 'shelf' },
        // The south wall: no opening, so this measures construction and nothing else.
        context(editor, { position: [0, 1.2, 2.0], surfaceId: 'srf_wall_south', kind: 'surface' }),
      );
      const shelfId = editor.engine.getSnapshot().scene.design.objects.find((o) => o.refined_class === 'shelf')?.id;
      const asBuilt = shelfId ? editor.engine.getSnapshot().scene.assemblies[shelfId]?.constructionResult : undefined;
      steps.push(check('a short shelf starts valid', shelf.status === 'applied' && asBuilt?.status === 'valid-within-template', `${describe(shelf)} / ${asBuilt?.status}`));
      const stretched = await editor.intent(
        { action: 'resize', target_id: shelfId, width_delta_m: 0.6 },
        context(editor, null),
      );
      const after = shelfId ? editor.engine.getSnapshot().scene.assemblies[shelfId]?.constructionResult : undefined;
      steps.push(check('the resize is resolved from the current size', stretched.status !== 'rejected' || /size/i.test(stretched.message), describe(stretched)));
      steps.push(check('construction was re-validated against the new size', after?.status === 'needs-adjustment' && after.findings.some((f) => f.code === 'span_exceeded'), `${after?.status}: ${after?.findings.map((f) => f.code).join(',')}`));
      return steps;
    },
  },
  {
    id: 'stale-proposal',
    title: 'A proposal arriving after another commit is rejected',
    milestone: 'M7',
    gate: 'transaction',
    scene: sampleRoom,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const recipe = SceneRecipeSchema.parse({
        label: 'a frame wall',
        items: [{ family: 'frame', count: 2, surfaceId: 'srf_wall_south' }],
      });
      const proposal = planLayout(scene, recipe, { proposalId: 'stale-1', build: buildObject });
      steps.push(check('the plan is complete', proposal.status === 'complete', proposal.explanation));

      // Something else commits in the meantime.
      const other = await editor.intent({ action: 'paint', paint_target: 'surface', surface_id: 'srf_floor', color: '#101010' }, context(editor, null));
      steps.push(check('an unrelated edit commits', other.status === 'applied', describe(other)));

      const applied = editor.engine.applyProposal(proposal, 'stale-op', { build: buildObject });
      steps.push(check('the stale proposal is refused', applied.status === 'rejected' && applied.refusal === 'stale_revision', describe(applied)));
      const after = editor.engine.getSnapshot().scene;
      steps.push(check('the current design is preserved', after.design.objects.length === 0 && after.design.surfaces.find((s) => s.class === 'floor')?.material_ref === '#101010', `${after.design.objects.length} objects`));
      return steps;
    },
  },
  {
    id: 'search-limit',
    title: 'Reaching the evaluation limit is not a proof of impossibility',
    milestone: 'M7',
    gate: 'budget',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const recipe = SceneRecipeSchema.parse({
        label: 'four beds',
        items: [{ family: 'bed', count: 4 }],
      });
      const bounded = planLayout(scene, recipe, { proposalId: 'budget-1', build: buildObject, maxEvaluations: 40 });
      steps.push(check('it stops at the budget', bounded.status === 'search_exhausted' && bounded.exhausted, `${bounded.status} after ${bounded.evaluations}`));
      steps.push(check('it stays inside the budget', bounded.evaluations <= 40, `${bounded.evaluations} evaluations`));
      steps.push(check('it says the limit was the limit', /budget|not a proof/i.test(bounded.explanation), bounded.explanation));
      steps.push(check('it commits nothing', bounded.placements.length === 0, `${bounded.placements.length} placements`));

      // The SAME request with the real budget proves a conflict instead. Two different
      // claims, two different statuses - which is the whole point of the distinction.
      const full = planLayout(scene, recipe, { proposalId: 'budget-2', build: buildObject });
      steps.push(check('with the full budget it proves the conflict', full.status === 'infeasible' && !full.exhausted, `${full.status} after ${full.evaluations}`));
      steps.push(check('the full search stays under the declared cap', full.evaluations <= MAX_EVALUATIONS, `${full.evaluations} of ${MAX_EVALUATIONS}`));

      // The object cap is reported as a bound too, never as geometry.
      const many = planLayout(scene, SceneRecipeSchema.parse({ label: 'too many', items: [{ family: 'frame', count: 12 }, { family: 'cabinet', count: 4 }] }), { proposalId: 'budget-3', build: buildObject });
      steps.push(check('the object cap is a bound, not a conflict', many.status === 'search_exhausted' && /bounded to/.test(many.explanation), many.explanation));
      return steps;
    },
  },
  {
    id: 'plan-deterministic',
    title: 'The same recipe and room plan identically',
    milestone: 'M7',
    gate: 'layout',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const recipe = SceneRecipeSchema.parse({
        label: 'a mixed arrangement',
        items: [
          { family: 'cabinet', count: 2 },
          { family: 'frame', count: 3, surfaceId: 'srf_wall_south' },
        ],
      });
      const runs = [0, 1, 2].map((n) =>
        JSON.stringify(planLayout(scene, recipe, { proposalId: `det-${n}`, build: buildObject }).placements),
      );
      steps.push(check('three plans agree byte for byte', runs.every((r) => r === runs[0]), `${runs[0]!.length} bytes`));

      // Validation output must be stable too, not just geometry.
      const results = [0, 1].map((n) =>
        JSON.stringify(
          planLayout(scene, recipe, { proposalId: `det-v${n}`, build: buildObject }).placements.map((pl) => pl.construction),
        ),
      );
      steps.push(check('construction results agree', results[0] === results[1], 'identical'));
      return steps;
    },
  },
  {
    id: 'reconstruction-never-erases',
    title: 'A reconstruction manifest alone never erases furniture',
    milestone: 'M7',
    gate: 'transaction',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const before = editor.engine.getSnapshot().scene;
      steps.push(check('nothing is masked to begin with', before.removalMaskIds.length === 0, 'empty'));

      // A manifest naming removed objects is exactly what M5 produces. Adopting the
      // calibration it belongs to must not turn that list into an erasure.
      const manifest = {
        calibrationId: 'srv-1',
        calibrationRevision: 0,
        frameId: before.frameId,
        artifacts: [
          { key: 'atlas.png', role: 'atlas' as const, inferred: true },
          { key: 'shell.json', role: 'shell' as const, inferred: false },
        ],
        removedObjectIds: ['obj_bed_01', 'obj_table_01'],
      };
      editor.engine.adoptCalibration(manifest.calibrationId);
      const after = editor.engine.getSnapshot().scene;
      steps.push(check('the manifest erased nothing', after.removalMaskIds.length === 0 && after.removedPhysicalIds.length === 0, `${after.removalMaskIds.length} masked, ${after.removedPhysicalIds.length} removed`));
      steps.push(check('the furniture is all still there', after.design.objects.filter((o) => o.state === 'present').length === before.design.objects.length, `${after.design.objects.length} objects`));

      // Only an explicit intent sets it, and only for a MEASURED id.
      const asked = await editor.restyle(
        { label: 'hide the bed', items: [{ family: 'frame', count: 1, surface_id: 'srf_wall_south' }], hide_ids: ['obj_bed_01', 'not_a_real_object'] },
        context(editor, null),
      );
      const masked = editor.engine.getSnapshot().scene;
      steps.push(check('an explicit request does set it', asked.status === 'applied' && masked.removalMaskIds.includes('obj_bed_01'), describe(asked)));
      steps.push(check('an id that was never measured is not recorded', !masked.removalMaskIds.includes('not_a_real_object'), masked.removalMaskIds.join(',')));
      return steps;
    },
  },
  {
    id: 'legacy-style-expansion',
    title: 'A legacy style plan expands into the same validated transaction',
    milestone: 'M7',
    gate: 'legacy',
    scene: sampleRoomFurnished,
    run: async (editor) => {
      const steps: StepResult[] = [];
      const scene = editor.engine.getSnapshot().scene;
      const expansion = expandLegacyPlan(scene, {
        summary: 'Warmer walls and a dresser by the window.',
        ops: [
          { type: 'CHANGE_COLOR', target_id: 'srf_wall_north', color_hex: '#c8b8a0' },
          { type: 'ADD_OBJECT', target_id: 'obj_new_1', catalog_id: 'cat_dresser_oak', relation: 'against_wall', anchor_id: 'srf_wall_north' },
          { type: 'CHANGE_MATERIAL', target_id: 'obj_table_01', material_ref: 'mat_walnut' },
          { type: 'ADD_OBJECT', target_id: 'obj_new_2', catalog_id: 'cat_chandelier', relation: 'centered_in' },
        ],
      });
      steps.push(check('the supported ops became recipe items', expansion.recipe.items.length === 1 && expansion.recipe.items[0]!.family === 'cabinet', expansion.recipe.items.map((i) => i.family).join(',')));
      steps.push(check('the wall colour became a palette', expansion.recipe.wall_color === '#c8b8a0', expansion.recipe.wall_color ?? 'none'));
      steps.push(check('unsupported families are reported, not approximated', expansion.skipped.some((s) => s.op.catalog_id === 'cat_chandelier' && /no authored template/.test(s.reason)), expansion.skipped.map((s) => s.reason).join(' | ')));
      steps.push(check('a legacy material ref is not read as a structural class', expansion.skipped.some((s) => s.op.type === 'CHANGE_MATERIAL'), 'skipped'));
      steps.push(check('untouched furniture is preserved', expansion.recipe.preserve_ids?.includes('obj_bed_01') === true, expansion.recipe.preserve_ids?.join(',') ?? ''));

      const result = await editor.restyle(expansion.recipe, context(editor, null));
      steps.push(check('it commits through the same transaction', result.status === 'applied', describe(result)));
      const after = editor.engine.getSnapshot().scene;
      steps.push(check('one revision for the whole plan', after.revision === scene.revision + 1, `${scene.revision} -> ${after.revision}`));
      steps.push(check('the wall was repainted and the dresser placed', after.design.surfaces.find((s) => s.id === 'srf_wall_north')?.material_ref === '#c8b8a0' && after.design.objects.some((o) => o.refined_class === 'cabinet'), 'both applied'));
      return steps;
    },
  },
];

/** The UI and the headless runner both filter one list, so a scenario cannot be added to
 * the suite and forgotten by the button that runs it. */
export const scenariosFor = (milestone: Scenario['milestone']) =>
  scenarios.filter((scenario) => scenario.milestone === milestone);

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const editor = createEditor(scenario.scene());
  try {
    const steps = await scenario.run(editor);
    return { id: scenario.id, title: scenario.title, steps, ok: steps.every((s) => s.ok) };
  } catch (error) {
    return {
      id: scenario.id,
      title: scenario.title,
      steps: [check('scenario completed', false, error instanceof Error ? error.message : 'failed')],
      ok: false,
    };
  } finally {
    editor.dispose();
  }
}

/** Two runs of the same scenario must agree byte for byte. */
export async function checkDeterminism(scenario: Scenario, runs = 3): Promise<StepResult> {
  const results: string[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await runScenario(scenario);
    results.push(JSON.stringify(result.steps.map((s) => [s.ok, s.detail])));
  }
  const identical = results.every((r) => r === results[0]);
  return check(
    `${scenario.title} is deterministic over ${runs} runs`,
    identical,
    identical ? 'identical output' : 'output differs between runs',
  );
}
