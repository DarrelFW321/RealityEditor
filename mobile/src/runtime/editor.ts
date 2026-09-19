import { Diagnostics, FloorSettlingAdapter } from '@reality/adapters';
import { AttentionHistory, SpatialEngine, wallFacingYaw } from '@reality/spatial-engine';
import { buildObject } from '@reality/scene-recipes';
import {
  RecipeSchema,
  type EditorState,
  type InteractionContext,
  type Vec3,
  type EditResult,
  type EditCommand,
  type SettlingAdapter,
} from '@reality/contracts';
import { z } from 'zod';

export const IntentSchema = z
  .object({
    action: z.enum([
      'move',
      'rotate',
      'resize',
      'color',
      'material',
      'remove',
      'undo',
      'add',
      'confirm',
      'structure',
    ]),
    target_id: z.string().optional(),
    color: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .optional(),
    material_ref: z.string().optional(),
    yaw_degrees: z.number().finite().optional(),
    yaw_delta_degrees: z.number().finite().optional(),
    dimensions: z
      .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
      .optional(),
    family: z.enum(['bed', 'table', 'frame', 'shelf', 'cabinet']).optional(),
    count: z.number().int().min(1).max(12).optional(),
    legs: z.union([z.literal(3), z.literal(4)]).optional(),
    structure_kind: z.enum(['offset_wall', 'ceiling_height', 'resize_opening']).optional(),
    metres: z.number().finite().optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
  })
  .strict();
export type Intent = z.infer<typeof IntentSchema>;

export const voiceTool = {
  type: 'function',
  name: 'edit_room',
  description:
    'Edit using the bound selection and pointed destination. No invented coordinates. Ask for missing targets/destinations. Report the returned result, including any adjustment. When the result asks for confirmation, call again with action "confirm" only after the user agrees.',
  parameters: z.toJSONSchema(IntentSchema),
};

export interface EditorModules {
  createSettling: () => SettlingAdapter;
  buildObject: typeof buildObject;
}
export const defaultEditorModules: EditorModules = {
  createSettling: () => new FloorSettlingAdapter(),
  buildObject,
};

export function createEditor(scene: EditorState, modules: EditorModules = defaultEditorModules) {
  const diagnostics = new Diagnostics();
  const attention = new AttentionHistory();
  const settling = modules.createSettling();
  const ready = settling.start();
  // All candidate adapters finish initialization before a drop reaches them.
  const engine = new SpatialEngine(
    scene,
    {
      id: settling.id,
      capabilities: settling.capabilities,
      start: () => ready,
      stop: () => settling.stop(),
      dispose: () => settling.dispose(),
      settle: async (...args) => {
        await ready;
        if (args[1].aborted) throw new Error('Cancelled');
        return settling.settle(...args);
      },
    },
    diagnostics,
  );
  void ready.catch(() => {
    engine.setTracking(false);
    diagnostics.emit({
      timestamp: Date.now(),
      stage: 'settling',
      code: 'initialization_failed',
      adapterId: settling.id,
    });
  });

  let sequence = 0;
  const nextId = () => `${scene.sessionId}-${++sequence}`;

  async function intent(
    input: unknown,
    context: InteractionContext,
    id = nextId(),
  ): Promise<EditResult> {
    const state = engine.getSnapshot().scene;
    const rejected = (message: string, refusal: EditResult['refusal'] = null): EditResult => ({
      status: 'rejected',
      message,
      report: null,
      refusal,
      caveats: [],
      conflicts: [],
      revision: engine.getSnapshot().scene.revision,
    });
    const parsed = IntentSchema.safeParse(input);
    if (!parsed.success) return rejected('I did not understand that edit.', 'invalid_parameters');
    const command = parsed.data;
    if (context.frameId !== state.frameId || context.revision !== state.revision)
      return rejected('The room changed since that instruction. Please repeat it.', 'stale_revision');

    if (command.action === 'confirm') return engine.confirm(engine.getSnapshot().pending?.operationId ?? id);
    if (command.action === 'undo') return engine.execute({ type: 'undo' }, id, context.revision);

    if (command.action === 'structure') {
      const targetId = command.target_id ?? context.destination?.surfaceId;
      if (!targetId) return rejected('Point at the wall or opening to change.');
      const kind = command.structure_kind ?? 'offset_wall';
      if (kind === 'resize_opening') {
        if (!command.width || !command.height)
          return rejected('Tell me the new width and height.');
        return engine.execute(
          {
            type: 'structure',
            targetId,
            change: { kind: 'resize_opening', width: command.width, height: command.height },
          },
          id,
          context.revision,
        );
      }
      if (command.metres === undefined) return rejected('Tell me how far to move it.');
      return engine.execute(
        { type: 'structure', targetId, change: { kind, metres: command.metres } },
        id,
        context.revision,
      );
    }

    if (command.action === 'add') {
      if (!command.family) return rejected('Which kind of object should I add?');
      const dimensions: Vec3 =
        command.dimensions ??
        (command.family === 'bed'
          ? [1.5, 0.6, 2]
          : command.family === 'frame'
            ? [0.5, 0.6, 0.05]
            : command.family === 'shelf'
              ? [0.8, 0.06, 0.3]
              : command.family === 'cabinet'
                ? [0.8, 0.8, 0.5]
                : [1, 0.75, 0.65]);
      const recipe = RecipeSchema.parse({
        family: command.family,
        count: command.count ?? 1,
        dimensions,
        color: command.color ?? '#548ec8',
        legs: command.legs ?? 4,
      });
      const floor = state.design.surfaces.find((s) => s.class === 'floor' && s.state === 'present');
      const mounted = recipe.family === 'frame' || recipe.family === 'shelf';
      const wall = state.design.surfaces.find(
        (s) => s.id === context.destination?.surfaceId && s.class === 'wall' && s.state === 'present',
      );
      if (!floor || (mounted && !wall)) return rejected('Point at the mounting wall first.');
      const additions: Extract<EditCommand, { type: 'add' }>[] = [];
      const origin = context.destination?.position ?? [0, 0, 0];
      for (let i = 0; i < recipe.count; i++) {
        const gap = 0.12;
        const offset = (i - (recipe.count - 1) / 2) * (dimensions[0] + gap);
        let position: Vec3 = [origin[0] + offset, 0, origin[2]];
        let yaw = 0;
        if (wall) {
          const n = wall.plane.normal as Vec3;
          yaw = wallFacingYaw(n);
          const distance =
            n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2] - wall.plane.offset;
          position = [
            origin[0] + n[0] * (dimensions[2] / 2 - distance) + Math.cos(yaw) * offset,
            Math.max(0.2, origin[1] - dimensions[1] / 2),
            origin[2] + n[2] * (dimensions[2] / 2 - distance) - Math.sin(yaw) * offset,
          ];
        }
        const built = modules.buildObject(recipe, `${id}-${i}`, position, wall?.id ?? floor.id);
        built.object.pose.yaw = yaw;
        additions.push({ type: 'add', ...built });
      }
      return engine.batch(additions, id, context.revision);
    }

    const targetId = command.target_id ?? context.selectedId;
    if (!targetId) return rejected('Select an object first.');
    // The hallucination guard: an invented id is refused here, not deep in a batch.
    if (!state.design.objects.some((o) => o.id === targetId && o.state === 'present'))
      return rejected('I cannot find that object in the room.', 'unknown_target');

    if (command.action === 'move') {
      if (!context.destination) return rejected('Point at the destination first.');
      return engine.execute(
        {
          type: 'move',
          targetId,
          position: context.destination.position,
          supportSurface: context.destination.surfaceId,
        },
        id,
        context.revision,
      );
    }
    if (command.action === 'rotate') {
      const current = state.design.objects.find((o) => o.id === targetId)!.pose.yaw;
      // Resolve a relative turn to an absolute one before the inverse is computed.
      const yaw =
        command.yaw_degrees !== undefined
          ? (command.yaw_degrees * Math.PI) / 180
          : command.yaw_delta_degrees !== undefined
            ? current + (command.yaw_delta_degrees * Math.PI) / 180
            : null;
      if (yaw === null) return rejected('Tell me the angle to turn it to.');
      return engine.execute({ type: 'rotate', targetId, yaw }, id, context.revision);
    }
    if (command.action === 'resize' && command.dimensions)
      return engine.execute(
        { type: 'resize', targetId, dimensions: command.dimensions },
        id,
        context.revision,
      );
    if (command.action === 'color' && command.color)
      return engine.execute({ type: 'color', targetId, color: command.color }, id, context.revision);
    if (command.action === 'material' && command.material_ref)
      return engine.execute(
        { type: 'material', targetId, materialRef: command.material_ref },
        id,
        context.revision,
      );
    if (command.action === 'remove')
      return engine.execute({ type: 'remove', targetId }, id, context.revision);
    return rejected('Tell me the value to use.');
  }

  return {
    engine,
    diagnostics,
    attention,
    intent,
    nextId,
    moduleIds: { settling: settling.id },
    dispose: () => {
      engine.dispose();
      attention.clear();
      void settling
        .stop()
        .finally(() => settling.dispose())
        .catch(() => {
          diagnostics.emit({
            timestamp: Date.now(),
            stage: 'settling',
            code: 'cleanup_failed',
            adapterId: settling.id,
          });
        });
    },
  };
}
export type Editor = ReturnType<typeof createEditor>;
