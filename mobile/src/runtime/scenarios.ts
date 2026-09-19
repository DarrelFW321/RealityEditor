import {
  capture,
  exampleShell,
  sampleRoomFurnished,
  sampleRoomWithBuiltIn,
  sweepFrames,
} from '@reality/dev-scenarios';
import { buildIndex, CoverageTracker, evaluateCoverage } from '@reality/spatial-engine';
import { ShellSchema } from '@reality/contracts';
import { roomToSession } from '../adapters/room-conversion';
import { applyToPoint, roomFromWorld } from '../adapters/room-space';
import type { EditorState, EditResult, InteractionContext, Vec3 } from '@reality/contracts';
import { createEditor, type Editor } from './editor';
import { compositingScenarios } from './compositing-scenarios';

export type StepResult = { label: string; ok: boolean; detail: string };
export type ScenarioResult = { id: string; title: string; steps: StepResult[]; ok: boolean };

export type Scenario = {
  id: string;
  title: string;
  /** Which milestone gate this scenario is evidence for. The two suites share every
   * helper below but prove different things, and M3 drives the carry state machine
   * directly rather than going through `editor.intent`. */
  milestone: 'M2' | 'M3' | 'M4' | 'M8';
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
    | 'compositor';
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

/** Both excluded caches are derived: `version` counts edits, as Swift's canonicalData
 * does, and `occupancy` is blanked on commit because nothing recomputes it yet. */
const canon = (scene: EditorState) =>
  JSON.stringify(canonical(scene.design, new Set(['version', 'occupancy'])));


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
];

scenarios.push(...compositingScenarios);

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
