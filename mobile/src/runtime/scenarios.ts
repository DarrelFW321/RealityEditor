import {
  sampleRoomFurnished,
  sampleRoomWithBuiltIn,
} from '@reality/dev-scenarios';
import type { EditorState, EditResult, InteractionContext, Vec3 } from '@reality/contracts';
import { createEditor, type Editor } from './editor';

export type StepResult = { label: string; ok: boolean; detail: string };
export type ScenarioResult = { id: string; title: string; steps: StepResult[]; ok: boolean };

export type Scenario = {
  id: string;
  title: string;
  /** Which milestone gate this scenario is evidence for. The two suites share every
   * helper below but prove different things, and M3 drives the carry state machine
   * directly rather than going through `editor.intent`. */
  milestone: 'M2' | 'M3';
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
    | 'voice';
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
