import { Diagnostics, FloorSettlingAdapter } from '@reality/adapters';
import {
  AttentionHistory,
  DEFAULT_COLOR,
  DEFAULT_DIMENSIONS,
  SpatialEngine,
  isWallFamily,
  planLayoutCooperative,
  wallFacingYaw,
} from '@reality/spatial-engine';
import { buildObject, revalidate } from '@reality/scene-recipes';
import {
  RecipeSchema,
  SceneRecipeSchema,
  type EditorState,
  type InteractionContext,
  type LayoutProposal,
  type SceneRecipe,
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
      // Voice parity: every action reachable by hand or touch must be reachable by
      // speech, or "do it by voice" silently means "do most of it by voice".
      'select',
      'cancel',
      // M7 follow-ups. These edit an EXISTING group or surface rather than generating
      // new content, which is what stops "make it three" becoming three new frames.
      'group_edit',
      'paint',
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
    // ---- M7 follow-up edits
    /** Which group to edit. Omitted means the group containing the selection. */
    group_id: z.string().optional(),
    /**
     * Relative size, resolved LOCALLY against the object's current dimensions.
     * "20 centimetres wider" is `width_delta_m: 0.2`; the model never computes the
     * resulting size, because it does not know the current one to the centimetre.
     */
    width_delta_m: z.number().finite().optional(),
    height_delta_m: z.number().finite().optional(),
    depth_delta_m: z.number().finite().optional(),
    /**
     * Absolute size, one axis at a time. Preferred over `dimensions`: a bare 3-tuple
     * makes the model guess that index 0 is width and index 1 is height, and OpenAI's
     * function-schema validator rejects the tuple encoding outright (see `toolSchema`).
     * Any axis left out keeps its current value, so "make it 1.2 wide" is one field.
     */
    width_m: z.number().finite().positive().optional(),
    height_m: z.number().finite().positive().optional(),
    depth_m: z.number().finite().positive().optional(),
    /** For `paint`: 'object' | 'group' | 'surface' | 'room'. Defaults to 'object'. */
    paint_target: z.enum(['object', 'group', 'surface', 'room']).optional(),
    /** The wall or floor to repaint, or the surface a group should face. */
    surface_id: z.string().optional(),
    /** Room palette. Only read when `paint_target` is 'room'. */
    wall_color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
    floor_color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
    facing_surface_id: z.string().optional(),
  })
  .strict();
export type Intent = z.infer<typeof IntentSchema>;

/**
 * The structured recipe the conversational model may request (M7.6).
 *
 * Deliberately a SECOND tool rather than more fields on `edit_room`: a recipe is a
 * different kind of request — a whole arrangement rather than one change — and merging
 * them would make every simple edit carry a creation schema it never uses.
 *
 * It contains no coordinates and cannot contain any. The planner computes poses; the
 * model's entire spatial vocabulary here is a family, a count and a named surface.
 */
export const RecipeIntentSchema = z
  .object({
    label: z.string().min(1).max(80),
    items: z
      .array(
        z
          .object({
            family: z.enum(['bed', 'table', 'frame', 'shelf', 'cabinet']),
            count: z.number().int().min(1).max(12),
            dimensions: z
              .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
              .optional(),
            color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
            legs: z.union([z.literal(3), z.literal(4)]).optional(),
            /** A wall or floor id from the supplied context. Never invented. */
            surface_id: z.string().optional(),
            /** Set to re-plan an existing group instead of creating a new one. */
            group_id: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    wall_color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
    floor_color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
    object_color: z.string().regex(/^#[\da-f]{6}$/i).optional(),
    /** Objects that must survive and keep obstructing the new layout. */
    preserve_ids: z.array(z.string()).max(64).optional(),
    /** Design objects this restyle withdraws. */
    replace_ids: z.array(z.string()).max(64).optional(),
    /** Measured objects to stop showing. Visibility intent only; they stay obstacles. */
    hide_ids: z.array(z.string()).max(64).optional(),
  })
  .strict();
export type RecipeIntent = z.infer<typeof RecipeIntentSchema>;

export const voiceTool = {
  type: 'function',
  name: 'edit_room',
  description:
    'Edit using the bound selection and pointed destination. To resize, use width_m/height_m/depth_m for an absolute size or width_delta_m/height_delta_m/depth_delta_m for a change like "20cm wider"; axes you omit keep their current value, and you never need to know the current size. No invented coordinates. Ask for missing targets/destinations. Report the returned result, including any adjustment. When the result asks for confirmation, call again with action "confirm" only after the user agrees. For follow-ups to something you already created, use action "group_edit" with the group id from context so the same objects are edited rather than new ones generated.',
  parameters: toolSchema(IntentSchema),
};

/** M7.6: whole arrangements. The planner computes every pose; this carries none. */
export const recipeTool = {
  type: 'function',
  name: 'restyle_room',
  description:
    'Create or restyle a whole arrangement from a description, e.g. "a blue bedroom with three frames on that wall". Supply only families, counts and named surfaces from the context — never coordinates. The device plans the layout, checks it against the real room and reports back. If the result asks for confirmation, repeat the call is wrong: call edit_room with action "confirm" once the user agrees.',
  parameters: toolSchema(RecipeIntentSchema),
};

/**
 * Resolves "20 centimetres wider" against the size an object actually has.
 *
 * Deliberately local (M7.4.2). The model is told never to invent numbers, and it cannot
 * compute an absolute size without knowing the current one to the centimetre — which it
 * does not, and should not need to. Returns undefined when no delta was given, so the
 * caller can tell "no size change" from "change it by zero".
 */
export function relativeDimensions(
  current: Vec3,
  request: {
    dimensions?: readonly number[];
    width_m?: number;
    height_m?: number;
    depth_m?: number;
    width_delta_m?: number;
    height_delta_m?: number;
    depth_delta_m?: number;
  },
): Vec3 | undefined {
  // A complete tuple wins when a programmatic caller supplies one; the model is not
  // asked for it. Then per-axis absolutes, then per-axis deltas. Mixing is allowed and
  // well defined: an axis with neither keeps the size it has.
  if (request.dimensions?.length === 3)
    return [request.dimensions[0]!, request.dimensions[1]!, request.dimensions[2]!];
  const absolute = [request.width_m, request.height_m, request.depth_m];
  const deltas = [request.width_delta_m, request.height_delta_m, request.depth_delta_m];
  if (absolute.every((v) => v === undefined) && deltas.every((v) => v === undefined))
    return undefined;
  return [0, 1, 2].map((i) =>
    Number(((absolute[i] ?? current[i]! + (deltas[i] ?? 0))).toFixed(4)),
  ) as Vec3;
}

/**
 * The JSON Schema a tool is actually shipped with.
 *
 * `z.toJSONSchema` emits correct JSON Schema 2020-12, and OpenAI's function-calling
 * validator does not accept all of it. A tuple becomes `prefixItems` + `items: false`,
 * which is rejected — so `dimensions` made the whole `edit_room` schema unusable and
 * the model reported that it could not resize anything while move and colour worked.
 * A stray top-level `$schema` is dropped for the same reason: unknown keys are a risk
 * for no benefit, since nothing downstream reads it.
 *
 * Applied to every tool rather than patched at the one call site, so a tuple added
 * later cannot quietly reintroduce this.
 */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$schema') continue;
      out[key] = clean(value);
    }
    if (Array.isArray(out.prefixItems)) {
      // A homogeneous array with the same bounds. `minItems`/`maxItems` already carry
      // the arity, so nothing about the contract is lost.
      out.items = (out.prefixItems as unknown[])[0] ?? { type: 'number' };
      delete out.prefixItems;
    }
    if (out.items === false) delete out.items;
    return out;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

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
    // M7.5.3: the authored checks re-run on every change that can invalidate them.
    // The support count is read off the assembly, so a resize is judged against the
    // geometry that exists rather than the request that made it.
    (assembly, dimensions) => revalidate(assembly, dimensions),
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

  /**
   * The one proposal waiting on a yes.
   *
   * Held here rather than in the engine because a proposal is not yet a transaction:
   * nothing is drafted, nothing is reserved, and the engine's own `pending` means "a
   * validated candidate is one confirm away from committing". Superseded rather than
   * queued — a second request replaces the first, so there is never a stack of layouts
   * a stray "yes" could apply the wrong one of.
   */
  let pendingProposal: { proposal: LayoutProposal; operationId: string } | null = null;

  /** Turns a validated recipe into a committed transaction, or explains why not. */
  async function propose(
    recipe: SceneRecipe,
    context: InteractionContext,
    id: string,
    onStage?: (stage: string) => void,
  ): Promise<EditResult> {
    const state = engine.getSnapshot().scene;
    const proposal = await planLayoutCooperative(
      state,
      recipe,
      {
        proposalId: id,
        build: modules.buildObject,
        destination: context.destination
          ? { position: context.destination.position, surfaceId: context.destination.surfaceId }
          : null,
      },
      onStage,
    );
    if (proposal.status !== 'complete') {
      pendingProposal = null;
      return {
        status: 'rejected',
        message: proposal.explanation,
        report: null,
        // A budget limit is not a geometric proof, and the two must not read alike.
        refusal: proposal.status === 'search_exhausted' ? 'invalid_parameters' : 'unsupported_structure',
        caveats: proposal.exhausted
          ? ['The search was bounded; this is not a proof that it cannot be done.']
          : [],
        conflicts: proposal.alternatives.map((a) => `Try ${a.summary}.`),
        revision: state.revision,
      };
    }
    const outcome = engine.applyProposal(proposal, id, { build: modules.buildObject });
    // Park it only when the engine asked for agreement, so a later "yes" applies THIS
    // arrangement rather than re-planning against a room that may have moved on.
    pendingProposal =
      outcome.refusal === 'awaiting_confirmation' ? { proposal, operationId: id } : null;
    return outcome;
  }

  /** Re-plans one existing group, keeping member identity. The shape every follow-up
   * edit routes through, so count, size, colour and spacing all commit the same way. */
  async function replanGroup(
    groupId: string,
    changes: { count?: number; dimensions?: Vec3; color?: string; facingSurfaceId?: string },
    context: InteractionContext,
    id: string,
  ): Promise<EditResult> {
    const state = engine.getSnapshot().scene;
    const group = state.groups[groupId];
    if (!group)
      return {
        status: 'rejected',
        message: 'I do not have a group by that name.',
        report: null,
        refusal: 'unknown_target',
        caveats: [],
        conflicts: [],
        revision: state.revision,
      };
    const recipe = SceneRecipeSchema.parse({
      label: group.label,
      items: [
        {
          family: group.family,
          count: changes.count ?? group.order.length,
          dimensions: changes.dimensions ?? group.dimensions,
          color: changes.color ?? group.color,
          materialClass: group.materialClass,
          relation: changes.facingSurfaceId ? 'facing_surface' : group.relation,
          surfaceId: changes.facingSurfaceId ?? group.surfaceId,
          groupId,
        },
      ],
      // Everything not in this group stays exactly as it is, including as an obstacle.
      preserveIds: state.design.objects
        .filter((o) => !group.order.includes(o.id) && o.state === 'present')
        .map((o) => o.id),
    });
    return propose(recipe, context, id);
  }

  /** The group a given object belongs to, so "make it three" works from a selection. */
  const groupOf = (state: EditorState, objectId: string) =>
    Object.values(state.groups).find((g) => g.order.includes(objectId)) ?? null;

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

    if (command.action === 'cancel') {
      engine.cancel();
      return {
        status: 'applied',
        message: 'Cancelled.',
        report: null,
        refusal: null,
        caveats: [],
        conflicts: [],
        revision: engine.getSnapshot().scene.revision,
      };
    }
    if (command.action === 'select') {
      // Resolved against real entities, by id or by the words a person would use. An
      // invented id must refuse rather than land on an arbitrary object.
      const wanted = (command.target_id ?? '').toLowerCase().trim();
      if (!wanted) return rejected('Which object do you mean?');
      const present = state.design.objects.filter((o) => o.state === 'present');
      const matches = present.filter(
        (o) =>
          o.id.toLowerCase() === wanted ||
          (o.refined_class ?? '').toLowerCase() === wanted ||
          o.class.toLowerCase() === wanted ||
          (o.refined_class ?? '').toLowerCase().includes(wanted),
      );
      if (!matches.length) return rejected('I cannot find that in the room.', 'unknown_target');
      if (matches.length > 1)
        return rejected(
          `There is more than one ${wanted}. Point at the one you mean.`,
          'invalid_parameters',
        );
      return {
        status: 'applied',
        message: `Selected the ${matches[0]!.refined_class ?? matches[0]!.class}.`,
        report: null,
        refusal: null,
        caveats: [],
        conflicts: [],
        revision: state.revision,
        selectedId: matches[0]!.id,
      } as EditResult & { selectedId: string };
    }
    if (command.action === 'confirm') {
      // A parked restyle outranks a carry adjustment: the restyle is what the user was
      // last asked about, and applying the older pending instead would silently commit
      // something else entirely.
      const parked = pendingProposal;
      if (parked) {
        pendingProposal = null;
        return engine.applyProposal(parked.proposal, `${parked.operationId}-confirmed`, {
          build: modules.buildObject,
          confirmed: true,
        });
      }
      return engine.confirm(engine.getSnapshot().pending?.operationId ?? id);
    }

    if (command.action === 'paint') {
      const target = command.paint_target ?? 'object';
      if (target === 'room') {
        // A palette is several edits that must land together, so it is one batch and
        // therefore one undo — not a wall, then a floor, then whatever went wrong.
        const commands: Extract<EditCommand, { type: 'paint' | 'color' }>[] = [];
        for (const surface of state.design.surfaces) {
          if (surface.state !== 'present') continue;
          if (command.wall_color && surface.class === 'wall')
            commands.push({ type: 'paint', targetId: surface.id, color: command.wall_color });
          if (command.floor_color && surface.class === 'floor')
            commands.push({ type: 'paint', targetId: surface.id, color: command.floor_color });
        }
        if (command.color)
          for (const object of state.design.objects)
            if (object.state === 'present' && object.provenance === 'virtual')
              commands.push({ type: 'color', targetId: object.id, color: command.color });
        if (!commands.length) return rejected('Tell me which colours to use.');
        return engine.batch(commands, id, context.revision);
      }
      if (target === 'surface') {
        const surfaceId = command.surface_id ?? context.destination?.surfaceId;
        if (!surfaceId) return rejected('Point at the wall or floor to paint.');
        if (!command.color) return rejected('Tell me the colour.');
        return engine.execute({ type: 'paint', targetId: surfaceId, color: command.color }, id, context.revision);
      }
      if (target === 'group') {
        const group =
          state.groups[command.group_id ?? ''] ??
          groupOf(state, command.target_id ?? context.selectedId ?? '');
        if (!group) return rejected('I do not know which group you mean.', 'unknown_target');
        if (!command.color) return rejected('Tell me the colour.');
        // Colour changes no geometry, so this is a batch rather than a re-plan: the
        // members keep their poses, and re-solving them could only move them for nothing.
        return engine.batch(
          group.order
            .filter((memberId) => state.design.objects.some((o) => o.id === memberId && o.state === 'present'))
            .map((memberId) => ({ type: 'color' as const, targetId: memberId, color: command.color! })),
          id,
          context.revision,
        );
      }
      const objectId = command.target_id ?? context.selectedId;
      if (!objectId) return rejected('Select an object first.');
      if (!command.color) return rejected('Tell me the colour.');
      return engine.execute({ type: 'color', targetId: objectId, color: command.color }, id, context.revision);
    }

    if (command.action === 'group_edit') {
      const group =
        state.groups[command.group_id ?? ''] ??
        groupOf(state, command.target_id ?? context.selectedId ?? '');
      if (!group)
        return rejected('I do not know which group you mean. Point at one of them.', 'unknown_target');
      const dimensions = relativeDimensions(group.dimensions as Vec3, command);
      return replanGroup(
        group.id,
        {
          count: command.count,
          dimensions,
          color: command.color,
          facingSurfaceId: command.facing_surface_id,
        },
        context,
        id,
      );
    }
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
        color: command.color ?? DEFAULT_COLOR,
        legs: command.legs ?? 4,
      });
      // An unauthored variant is refused HERE, with the authored reason and the
      // supported alternative. Letting it reach the engine produced the correct refusal
      // with none of the explanation, which is the difference between "no" and "no,
      // because there is no three-support bed template — a four-legged one works".
      const probe = modules.buildObject(recipe, `${id}-probe`, [0, 0, 0], '');
      const verdict = probe.assembly.constructionResult;
      if (probe.assembly.construction === 'invalid')
        return {
          status: 'rejected',
          message: verdict?.findings[0]?.detail ?? 'That construction cannot be built.',
          report: null,
          refusal: 'construction_invalid',
          caveats: verdict?.assumptions ?? [],
          conflicts: [],
          revision: state.revision,
        };
      // More than one object is a LAYOUT, not a row. The planner checks them against
      // each other, the room and the existing furniture; the old fixed-pitch loop
      // checked nothing and happily stacked two cabinets in the same place.
      if (recipe.count > 1) {
        const plan = SceneRecipeSchema.parse({
          label: `${recipe.count} ${recipe.family}s`,
          items: [
            {
              family: recipe.family,
              count: recipe.count,
              dimensions,
              color: recipe.color,
              legs: recipe.legs,
              relation: isWallFamily(recipe.family) ? 'evenly_spaced' : 'against_wall',
              surfaceId: context.destination?.surfaceId ?? null,
            },
          ],
          preserveIds: state.design.objects.filter((o) => o.state === 'present').map((o) => o.id),
        });
        return propose(plan, context, id);
      }
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
    if (command.action === 'resize') {
      const current = state.design.objects.find((o) => o.id === targetId)!.dimensions as Vec3;
      // One resolver for every way a size can arrive: a full tuple from code, a single
      // axis from speech, or a delta. All of it against the real current size, which is
      // the only place that number exists.
      const dimensions = relativeDimensions(current, command);
      if (!dimensions)
        return rejected('Tell me the new size — how wide, how tall, or how much to change it by.');
      if (dimensions.some((v: number) => v <= 0))
        return rejected('That would leave it with no size at all.', 'invalid_parameters');
      // A member of a group re-plans the group, so spacing keeps up with the new width
      // instead of leaving three frames overlapping at the old pitch.
      const group = groupOf(state, targetId);
      if (group) return replanGroup(group.id, { dimensions }, context, id);
      return engine.execute({ type: 'resize', targetId, dimensions }, id, context.revision);
    }
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

  /**
   * M7.6 entry point for the `restyle_room` tool.
   *
   * Maps the model's snake_case vocabulary onto the internal recipe and hands it to the
   * same planner and the same transaction that touch uses — there is one creation path,
   * not a voice one and a manual one (M7.3.7).
   */
  async function restyle(
    input: unknown,
    context: InteractionContext,
    id = nextId(),
    onStage?: (stage: string) => void,
  ): Promise<EditResult> {
    const state = engine.getSnapshot().scene;
    const reject = (message: string, refusal: EditResult['refusal'] = null): EditResult => ({
      status: 'rejected',
      message,
      report: null,
      refusal,
      caveats: [],
      conflicts: [],
      revision: state.revision,
    });
    const parsed = RecipeIntentSchema.safeParse(input);
    if (!parsed.success) return reject('I did not understand that arrangement.', 'invalid_parameters');
    if (context.frameId !== state.frameId || context.revision !== state.revision)
      return reject('The room changed since that instruction. Please repeat it.', 'stale_revision');
    const wanted = parsed.data;
    // Every id the model supplied is checked against the real scene before planning.
    // A hallucinated surface would otherwise become "the planner chose for you", which
    // is exactly the silent relocation the milestone forbids.
    const surfaces = new Set(state.design.surfaces.filter((s) => s.state === 'present').map((s) => s.id));
    for (const item of wanted.items)
      if (item.surface_id && !surfaces.has(item.surface_id))
        return reject('I cannot find that surface in the room.', 'unknown_target');

    const recipe = SceneRecipeSchema.parse({
      label: wanted.label,
      items: wanted.items.map((item) => ({
        family: item.family,
        count: item.count,
        dimensions: item.dimensions ?? null,
        color: item.color ?? null,
        legs: item.legs ?? 4,
        relation: isWallFamily(item.family) ? 'evenly_spaced' : 'against_wall',
        surfaceId: item.surface_id ?? null,
        groupId: item.group_id ?? null,
      })),
      palette:
        wanted.wall_color || wanted.floor_color || wanted.object_color
          ? {
              walls: wanted.wall_color ?? null,
              floor: wanted.floor_color ?? null,
              objects: wanted.object_color ?? null,
            }
          : null,
      preserveIds: wanted.preserve_ids ?? [],
      replaceIds: wanted.replace_ids ?? [],
      // Visibility intent is only ever about something that was MEASURED. An id that is
      // not in the scan is dropped rather than recorded as an erasure of nothing.
      hideMeasuredIds: (wanted.hide_ids ?? []).filter((hidden) =>
        state.measured.objects.some((o) => o.id === hidden),
      ),
    });
    return propose(recipe, context, id, onStage);
  }

  return {
    engine,
    diagnostics,
    attention,
    intent,
    restyle,
    /** What is waiting on a yes, for the panel to show. Null when nothing is. */
    pendingProposal: () => pendingProposal?.proposal ?? null,
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
