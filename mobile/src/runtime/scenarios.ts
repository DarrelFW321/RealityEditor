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
  gate: 'placement' | 'overlap' | 'support' | 'undo' | 'stale';
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

export const scenarios: Scenario[] = [
  {
    id: 'placement',
    title: 'Valid placement',
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
];

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
