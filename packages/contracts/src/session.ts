import { z } from 'zod';
import { RsgSchema, SceneObjectSchema, type ConstraintReport, type Rsg } from './generated';

// Versioned Expo envelopes. Existing RSG/Op/SCP wire contracts remain unchanged.
// Never redeclare a generated name here: index.ts star-exports both, so a duplicate
// is silently dropped from the barrel. Import the generated type instead.
export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export const PoseV1Schema = z.object({ position: Vec3Schema, yaw: z.number().finite() }).strict();
export type PoseV1 = z.infer<typeof PoseV1Schema>;

/** Compile-time only. The schema is untouched, so codegen is unaffected. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The five object families the procedural builders support. Declared once. */
export const TemplateSchema = z.enum(['table', 'bed', 'frame', 'shelf', 'cabinet']);
export type Template = z.infer<typeof TemplateSchema>;
export const PartSchema = z.object({
  id: z.string(),
  center: Vec3Schema,
  size: Vec3Schema.refine((v) => v.every((n) => n > 0)),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  structural: z.boolean(),
});
export type Part = z.infer<typeof PartSchema>;
/** Local-frame top-face region that may carry load. Null means it supports nothing. */
export const BearingSchema = z.object({
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
  y: z.number().finite(),
});
export type Bearing = z.infer<typeof BearingSchema>;
export const SupportSchema = z.object({
  mode: z.enum(['floor', 'wall', 'object']),
  /** A room surface id, or an OBJECT id when mode is 'object'. */
  surfaceId: z.string(),
  bearing: BearingSchema.nullable(),
  mountHeight: z.number().finite().nullable(),
});
export type Support = z.infer<typeof SupportSchema>;
// ---------------------------------------------------------------- M7 construction
//
// M7.5 requires construction outcomes that affect proposals and narration rather than
// decorative metadata. These types are what a validator returns and what an assembly
// carries so the answer can be re-derived after any dimension, support, orientation or
// material change.

/**
 * Structural material class, kept strictly separate from cosmetic colour.
 *
 * `material_ref` on a SceneObject is a hex colour the renderer paints with. It says
 * nothing about stiffness, so span and thickness limits cannot be read from it. PRD
 * section 4 requires the two to be distinct; this is the structural half.
 */
export const MaterialClassSchema = z.enum([
  'softwood',
  'hardwood',
  'engineered_panel',
  'steel',
  'glass',
  'unknown',
]);
export type MaterialClass = z.infer<typeof MaterialClassSchema>;

/**
 * The four outcomes M7.5 names, and nothing else.
 *
 * `valid-within-template` is deliberately hyphenated with "within-template": passing
 * these checks is a statement about an authored envelope, never a claim of certified
 * strength or verified real load capacity.
 */
export const ConstructionStatusSchema = z.enum([
  'valid-within-template',
  'needs-adjustment',
  'unsupported',
  'unknown',
]);
export type ConstructionStatus = z.infer<typeof ConstructionStatusSchema>;

/** One authored check that did not pass, with the number that justifies it. */
export const ConstructionFindingSchema = z
  .object({
    code: z.enum([
      'dimension_non_positive',
      'disconnected',
      'span_exceeded',
      'thickness_below_minimum',
      'support_contact',
      'unbalanced',
      'no_authored_template',
      'outside_envelope',
    ]),
    detail: z.string().max(200),
    /** The authored limit and the value measured against it. Null when not numeric. */
    limit: z.number().finite().nullable(),
    actual: z.number().finite().nullable(),
  })
  .strict();
export type ConstructionFinding = z.infer<typeof ConstructionFindingSchema>;

export const ConstructionResultSchema = z
  .object({
    status: ConstructionStatusSchema,
    template: TemplateSchema,
    /** Which authored revision of the template justified the result. */
    templateVersion: z.string().max(16),
    materialClass: MaterialClassSchema,
    findings: z.array(ConstructionFindingSchema).max(16),
    /** The declared assumptions the result rests on. Never empty. */
    assumptions: z.array(z.string()).min(1),
  })
  .strict();
export type ConstructionResult = z.infer<typeof ConstructionResultSchema>;

/** How two parts of an assembly are joined. Used to prove the construction is connected. */
export const ConnectionSchema = z
  .object({ from: z.string(), to: z.string(), kind: z.enum(['bears_on', 'fixed_to', 'spans']) })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;

/** A declared load the template is authored to carry, at a point in local XZ metres. */
export const LoadCaseSchema = z
  .object({
    id: z.string().max(40),
    at: z.tuple([z.number().finite(), z.number().finite()]),
    newtons: z.number().finite().positive(),
    description: z.string().max(120),
  })
  .strict();
export type LoadCase = z.infer<typeof LoadCaseSchema>;

export const AssemblySchema = z.object({
  template: TemplateSchema,
  parts: z.array(PartSchema).min(1),
  supports: z.array(z.tuple([z.number(), z.number()])),
  /** Deprecated mirrors of `support`, retained so existing consumers compile. */
  mounting: z.enum(['floor', 'wall']),
  supportSurface: z.string(),
  support: SupportSchema,
  assumptions: z.array(z.string()),
  construction: z.enum(['plausible', 'unknown', 'invalid']),
  // ---- M7.5. Every one carries a default, so an assembly authored before M7 still
  // parses and simply reports `unknown` construction rather than failing to load.
  /** Which authored revision of the family template produced these parts. */
  templateVersion: z.string().max(16).default('0.0.0'),
  /** Structural class. Independent of `parts[].color`, which is cosmetic. */
  materialClass: MaterialClassSchema.default('unknown'),
  /** Authored joins between parts. Emptiness is why a pre-M7 assembly is `unknown`. */
  connections: z.array(ConnectionSchema).default([]),
  /** Ground-contact polygon in local XZ; balance is judged against this, not the box. */
  supportPolygon: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** The loads the template claims to carry. Never inferred from dimensions. */
  loadCases: z.array(LoadCaseSchema).default([]),
  /** Last validation outcome. Recomputed after dimension, support, orientation or
   * material changes; null means it has not been validated under M7 rules. */
  constructionResult: ConstructionResultSchema.nullable().default(null),
});
export type Assembly = z.infer<typeof AssemblySchema>;
// ---------------------------------------------------------------- M7 groups
//
// A group is what makes "make it three" mean "add one" rather than "generate three new
// frames". It owns the ESTABLISHED MEMBER ORDER, which is the thing a follow-up edit
// needs and the thing a bare list of object ids cannot express.

/** How a group's members relate to the room and to each other. */
export const LayoutRelationSchema = z.enum([
  'against_wall',
  'centred',
  'evenly_spaced',
  'facing_surface',
  'beside_anchor',
]);
export type LayoutRelation = z.infer<typeof LayoutRelationSchema>;

/** Surface-level appearance, applied as one part of a restyle transaction. */
export const PaletteSchema = z
  .object({
    walls: z.string().regex(/^#[\da-f]{6}$/i).nullable().default(null),
    floor: z.string().regex(/^#[\da-f]{6}$/i).nullable().default(null),
    objects: z.string().regex(/^#[\da-f]{6}$/i).nullable().default(null),
  })
  .strict();
export type Palette = z.infer<typeof PaletteSchema>;

export const GroupSchema = z
  .object({
    id: z.string().min(1).max(80),
    /** What the user asked for, kept so narration can quote the request back. */
    label: z.string().max(80),
    family: TemplateSchema,
    /**
     * Established member order. A count increase APPENDS and a decrease TRIMS FROM THE
     * END, which is what lets surviving members keep their ids across an edit. Never
     * re-sorted: re-sorting would silently reassign identity.
     */
    order: z.array(z.string()).min(1).max(12),
    /** The wall or floor the group sits on. */
    surfaceId: z.string(),
    relation: LayoutRelationSchema,
    dimensions: Vec3Schema,
    color: z.string().regex(/^#[\da-f]{6}$/i),
    materialClass: MaterialClassSchema,
    /** Centre-to-centre spacing along the surface, recomputed on every count change. */
    spacingM: z.number().finite().nonnegative(),
  })
  .strict();
export type Group = z.infer<typeof GroupSchema>;

export const EditorStateSchema = z.object({
  /**
   * 2 since M7, which added `groups`. Both are accepted on read so a state in flight
   * across the change still parses; producers emit 2. Nothing persists an EditorState,
   * so there is no stored-fixture migration to write.
   */
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  sessionId: z.string(),
  calibrationId: z.string(),
  frameId: z.string(),
  revision: z.number().int().nonnegative(),
  calibrationRevision: z.number().int().nonnegative(),
  provenance: z.enum(['sample', 'observed', 'inferred']),
  measured: RsgSchema,
  design: RsgSchema,
  assemblies: z.record(z.string(), AssemblySchema),
  // Erasing a real object does not erase its physical occupancy.
  removedPhysicalIds: z.array(z.string()),
  /**
   * Visibility INTENT: measured objects the user asked to stop seeing, which M8 will
   * consume. Deliberately separate from `removedPhysicalIds` — an object can be erased
   * from view while still being a physical obstacle, and receiving a reconstruction
   * manifest alone must never add anything here (M7.3.6).
   */
  removalMaskIds: z.array(z.string()),
  /**
   * Which reconstruction the visibility intent above was expressed against.
   *
   * Intent is stored by measured object identity AND this reference (M7.3.6). Identity
   * alone is not enough: a recalibration renumbers nothing but re-observes everything,
   * so intent recorded against an older calibration should be re-examined rather than
   * silently applied to a room the user has since re-scanned.
   */
  removalMaskCalibration: z
    .object({
      calibrationId: z.string(),
      calibrationRevision: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  /**
   * Hand-placed erasure boxes.
   *
   * Everything else erased is tied to something the scan recognised, which means
   * anything RoomPlan did not box cannot be removed at all. A mask volume is just a
   * region the user drew: no detection, no segmentation model, no object.
   *
   * Deliberately NOT a SceneObject. It has no assembly, takes part in no collision
   * check and blocks no placement — it only says "do not show me what is in here".
   * Living in committed state is what makes it undoable with everything else.
   */
  maskVolumes: z
    .array(
      z
        .object({
          id: z.string().min(1).max(80),
          label: z.string().max(80).default('masked area'),
          center: Vec3Schema,
          size: Vec3Schema.refine((v) => v.every((n) => n >= 0.05 && n <= 8)),
          yaw: z.number().finite().default(0),
          /**
           * False means MARKED: the box is drawn as an outline and the camera is
           * untouched. True means HIDDEN: its pixels are replaced.
           *
           * Two steps on purpose. Placing a box and sizing it is a thing the user does
           * while looking at what is inside it, and erasing on placement would remove
           * the very thing they are aiming at.
           */
          hidden: z.boolean().default(false),
        })
        .strict(),
    )
    .max(16)
    .default([]),
  /** M7 groups, keyed by group id. Defaulted so a pre-M7 state still parses. */
  groups: z.record(z.string(), GroupSchema).default({}),
});
/** `measured` is observation. Structural edits apply to `design`; tsc enforces it here. */
export type EditorState = Omit<z.infer<typeof EditorStateSchema>, 'measured'> & {
  measured: DeepReadonly<Rsg>;
};
export const ContextSchema = z.object({
  turnId: z.string(),
  /** Unix epoch milliseconds. Convert uptime and performance clocks at the boundary. */
  clock: z.literal('epoch'),
  timestamp: z.number().finite(),
  revision: z.number().int(),
  frameId: z.string(),
  selectedId: z.string().nullable(),
  destination: z
    .object({
      position: Vec3Schema,
      surfaceId: z.string(),
      /** 'object' means surfaceId names a supporting object, not a room surface. */
      kind: z.enum(['surface', 'object']).default('surface'),
    })
    .nullable(),
  /**
   * Where the user is and what they are looking at, room space.
   *
   * Needed for the one operation that must work when NOTHING has been identified:
   * drawing an erasure box around something the scan never recognised. Every other
   * action resolves against a surface or an object, and refusing for lack of one is
   * correct; refusing to put a box in front of someone who is looking straight at the
   * thing they want gone is not. Optional, so nothing else has to supply it.
   */
  viewer: z
    .object({ position: Vec3Schema, forward: Vec3Schema })
    .nullable()
    .default(null),
});
export type InteractionContext = z.infer<typeof ContextSchema>;
export const RecipeSchema = z
  .object({
    family: z.enum(['table', 'bed', 'frame', 'shelf', 'cabinet']),
    count: z.number().int().min(1).max(12),
    dimensions: Vec3Schema.refine((v) => v.every((n) => n >= 0.04 && n <= 6)),
    color: z.string().regex(/^#[\da-f]{6}$/i),
    legs: z.union([z.literal(3), z.literal(4)]).default(4),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;
export const EditCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('move'),
      targetId: z.string(),
      position: Vec3Schema,
      supportSurface: z.string(),
    })
    .strict(),
  z.object({ type: z.literal('rotate'), targetId: z.string(), yaw: z.number().finite() }).strict(),
  z
    .object({
      type: z.literal('resize'),
      targetId: z.string(),
      dimensions: Vec3Schema.refine((v) => v.every((n) => n > 0 && n <= 6)),
    })
    .strict(),
  z
    .object({
      type: z.literal('color'),
      targetId: z.string(),
      color: z.string().regex(/^#[\da-f]{6}$/i),
    })
    .strict(),
  z.object({ type: z.literal('remove'), targetId: z.string() }).strict(),
  z
    .object({ type: z.literal('add'), object: SceneObjectSchema, assembly: AssemblySchema })
    .strict(),
  // Cosmetic colour and structural material are separate edits; PRD section 4.
  z.object({ type: z.literal('material'), targetId: z.string(), materialRef: z.string() }).strict(),
  z
    .object({
      type: z.literal('replace'),
      targetId: z.string(),
      object: SceneObjectSchema,
      assembly: AssemblySchema,
      keepPose: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('structure'),
      targetId: z.string(),
      change: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('offset_wall'), metres: z.number().finite() }).strict(),
        z
          .object({ kind: z.literal('ceiling_height'), metres: z.number().finite().positive() })
          .strict(),
        z
          .object({
            kind: z.literal('resize_opening'),
            width: z.number().finite().positive(),
            height: z.number().finite().positive(),
          })
          .strict(),
      ]),
    })
    .strict(),
  // A SURFACE repaint. `color` edits an object; a wall is not an object, and routing
  // wall colour through `color` would have meant looking the id up in two collections
  // and guessing which one the caller meant.
  z
    .object({
      type: z.literal('paint'),
      targetId: z.string(),
      color: z.string().regex(/^#[\da-f]{6}$/i),
    })
    .strict(),
  /**
   * One whole restyle, for the op log only.
   *
   * It carries no geometry: the draft was already built, validated and published by
   * `applyProposal`, and this records WHAT happened so the log can show one entry for
   * a restyle instead of thirty. Its inverse is null because undo restores the whole
   * pre-transaction snapshot, which is what makes the undo atomic.
   */
  z
    .object({
      type: z.literal('restyle'),
      proposalId: z.string(),
      label: z.string().max(80),
      affectedIds: z.array(z.string()).max(128),
    })
    .strict(),
  /** Place or resize a hand-drawn erasure box. Same id twice replaces it. */
  z
    .object({
      type: z.literal('mask'),
      id: z.string().min(1).max(80),
      label: z.string().max(80).default('masked area'),
      center: Vec3Schema,
      size: Vec3Schema.refine((v) => v.every((n) => n >= 0.05 && n <= 8)),
      yaw: z.number().finite().default(0),
      hidden: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('unmask'), targetId: z.string() }).strict(),
  z.object({ type: z.literal('undo') }).strict(),
]);
export type EditCommand = z.infer<typeof EditCommandSchema>;

export type EditRefusal =
  | 'stale_revision'
  | 'duplicate_operation'
  | 'no_transaction'
  | 'tracking_lost'
  | 'unknown_target'
  | 'invalid_parameters'
  | 'immovable'
  | 'incompatible_support'
  | 'construction_invalid'
  | 'unsupported_structure'
  | 'history_evicted'
  | 'awaiting_confirmation';

export type EditResult = {
  status: 'applied' | 'adjusted' | 'rejected' | 'preview';
  message: string;
  /** Produced for every mutation attempt. Null only for preview and envelope refusals. */
  report: ConstraintReport | null;
  refusal: EditRefusal | null;
  /** Non-metric statements RemainingNote cannot express, e.g. unverified load capacity. */
  caveats: string[];
  /** Human-readable, derived from `report`. EditorPanel renders these as Text children. */
  conflicts: string[];
  revision: number;
};

export type EngineOp = {
  opId: string;
  seq: number;
  branchId: string;
  command: EditCommand;
  /** Computed before the mutation, against the pre-apply scene. Always absolute. */
  inverse: EditCommand | null;
  causedBy: { turnId: string | null; transcript: string; source: 'voice' | 'tap' | 'system' };
  report: ConstraintReport | null;
  clientTs: number;
  appliedTs: number | null;
};
export const KeyframeSchema = z
  .object({
    id: z.string().uuid(),
    timestamp: z.number().finite(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameId: z.string(),
    cameraToWorld: z.array(z.number().finite()).length(16),
    intrinsics: z.array(z.number().finite()).length(9),
  })
  .strict();
export type Keyframe = z.infer<typeof KeyframeSchema>;
/**
 * The room a reconstruction is of.
 *
 * The worker cannot project without it. Keyframes carry pose and intrinsics but say
 * nothing about where the walls are, which volumes to mask, or — critically — which frame
 * the poses are in: `cameraToWorld` is raw ARKit world space while the scene is recentred
 * on its floor centroid, so `origin` is what reconciles the two.
 *
 * Geometry is sent in ROOM space; only `origin` refers to the world frame. Sending the
 * room rather than letting the worker infer one keeps the phone authoritative for geometry,
 * which is the rule the whole architecture rests on.
 */
export const ReconstructionRoomSchema = z
  .object({
    /** Room origin in ARKit world coordinates. Subtract to bring a pose into room space. */
    origin: Vec3Schema,
    /** Planes to project onto, room space, counter-clockwise about the normal. */
    surfaces: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            class: z.enum(['wall', 'floor']),
            polygon: z.array(Vec3Schema).min(3).max(64),
            normal: Vec3Schema,
            /** Already inferred by calibration. Its texels can never be observed. */
            inferred: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    /**
     * Openings in those surfaces, room space, coplanar with their host wall.
     *
     * Added for M8.5 route A, which renders a depth panorama from the shell and must not
     * fabricate an adjoining room behind a window. A ray through an opening is UNKNOWN
     * depth, and that can only be represented if the worker knows the opening is there —
     * without this it would close the hole with wall distance and invent geometry.
     *
     * Optional with a default, so a payload written before M8.5 still validates and the
     * baseline pipeline is unaffected by its absence.
     */
    openings: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            class: z.enum(['window', 'door', 'opening']),
            /** The wall this opening is cut into. */
            parent: z.string().min(1).max(100),
            polygon: z.array(Vec3Schema).min(3).max(64),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    /**
     * Measured furniture to reject from the background, as upright boxes in room space.
     * `center` is the base centre, matching the engine's `base_center` pivot.
     */
    obstacles: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            center: Vec3Schema,
            size: Vec3Schema,
            yaw: z.number().finite(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type ReconstructionRoom = z.infer<typeof ReconstructionRoomSchema>;

/**
 * The clean shell, as the worker emits it.
 *
 * A SELF-CONTAINED mesh: positions, UVs and per-surface provenance. Deliberately not an
 * extension of the RSG `Surface` type — that schema is frozen with
 * `additionalProperties: false` and has nowhere to hang a UV — so the shell travels beside
 * the scene rather than inside it.
 *
 * Room space throughout, matching `EditorState.design`, so the renderer needs to know
 * nothing about the ARKit world frame the keyframes were captured in.
 */
export const ShellSchema = z
  .object({
    space: z.literal('room'),
    atlas: z
      .object({
        key: z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpg)$/),
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
      })
      .strict(),
    /** Which completion implementation ran. Recorded so a result is never ambiguous. */
    completion: z.string().max(32),
    surfaces: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            class: z.enum(['wall', 'floor']),
            positions: z.array(Vec3Schema).min(3).max(64),
            uvs: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(3).max(64),
            indices: z.array(z.number().int().nonnegative()).min(3).max(192),
            /** How much of this surface a camera actually saw, 0..1. */
            observedFraction: z.number().min(0).max(1),
            /** True when the appearance is mostly invented rather than observed. */
            inferred: z.boolean(),
          })
          // One UV per position, or the renderer would read past the end of the array.
          .refine((s) => s.positions.length === s.uvs.length, {
            message: 'positions and uvs must correspond',
          }),
      )
      .max(64),
  })
  .strict();
export type Shell = z.infer<typeof ShellSchema>;

export const ReconstructionManifestSchema = z
  .object({
    calibrationId: z.string(),
    calibrationRevision: z.number().int().nonnegative(),
    frameId: z.string(),
    // Object storage references are relative keys, never provider-owned arbitrary URLs.
    artifacts: z.array(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_./-]+$/),
        role: z.enum(['mask', 'atlas', 'shell']),
        inferred: z.boolean(),
      }),
    ),
    removedObjectIds: z.array(z.string()),
  })
  .strict();
export type ReconstructionManifest = z.infer<typeof ReconstructionManifestSchema>;
export const JobSchema = z.object({
  id: z.string(),
  calibrationId: z.string(),
  revision: z.number().int(),
  frameId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  stage: z.string(),
  error: z.string().nullable(),
  result: ReconstructionManifestSchema.nullable(),
});
export type ReconstructionJob = z.infer<typeof JobSchema>;

// ---------------------------------------------------------------- M7 recipes
//
// The planner boundary. A conversational model produces a SceneRecipe and nothing
// else: it is DATA validated by this schema, never executed, and it carries no poses.
// Positions are computed locally by `planLayout`, which is what keeps "never guess
// coordinates" true for whole-room creation as well as for single edits.

export const RecipeItemSchema = z
  .object({
    family: TemplateSchema,
    count: z.number().int().min(1).max(12),
    /** Omitted means "use the family default", resolved locally, not by the model. */
    dimensions: Vec3Schema.refine((v) => v.every((n) => n >= 0.04 && n <= 6)).nullable().default(null),
    color: z.string().regex(/^#[\da-f]{6}$/i).nullable().default(null),
    legs: z.union([z.literal(3), z.literal(4)]).default(4),
    materialClass: MaterialClassSchema.default('engineered_panel'),
    relation: LayoutRelationSchema.default('against_wall'),
    /**
     * Which surface to use. Null means the planner chooses: a wall-mounted family gets
     * the pointed wall or the largest usable one, a floor family gets the floor.
     */
    surfaceId: z.string().nullable().default(null),
    /** Set when a follow-up edit re-plans an existing group instead of creating one. */
    groupId: z.string().nullable().default(null),
  })
  .strict();
export type RecipeItem = z.infer<typeof RecipeItemSchema>;

export const SceneRecipeSchema = z
  .object({
    recipeVersion: z.literal(1).default(1),
    /** The request in the user's terms, quoted back during narration. */
    label: z.string().min(1).max(80),
    /** May be EMPTY. Hiding, replacing or repainting are whole restyles that create
     * nothing, and requiring an item made "hide the bed" impossible to express. */
    items: z.array(RecipeItemSchema).max(6).default([]),
    palette: PaletteSchema.nullable().default(null),
    /** Objects that must survive the restyle and keep obstructing it. */
    preserveIds: z.array(z.string()).max(64).default([]),
    /** Design objects to withdraw as part of this transaction. */
    replaceIds: z.array(z.string()).max(64).default([]),
    /**
     * Measured objects the user wants to stop seeing. Visibility intent only: the
     * physical obstacle stays, so the planner still routes around it.
     */
    hideMeasuredIds: z.array(z.string()).max(64).default([]),
  })
  .strict();
export type SceneRecipe = z.infer<typeof SceneRecipeSchema>;

// ---------------------------------------------------------------- M7 proposals

/** One planned object, fully posed. The planner's output unit. */
export const ProposalPlacementSchema = z
  .object({
    id: z.string(),
    groupId: z.string(),
    /** Index into the group's established order. */
    memberIndex: z.number().int().nonnegative(),
    /** True when this id already exists and is being re-posed rather than created. */
    reused: z.boolean(),
    family: TemplateSchema,
    dimensions: Vec3Schema,
    color: z.string().regex(/^#[\da-f]{6}$/i),
    legs: z.union([z.literal(3), z.literal(4)]),
    materialClass: MaterialClassSchema,
    position: Vec3Schema,
    yaw: z.number().finite(),
    supportSurface: z.string(),
    mode: z.enum(['floor', 'wall']),
    construction: ConstructionResultSchema,
  })
  .strict();
export type ProposalPlacement = z.infer<typeof ProposalPlacementSchema>;

/**
 * Something the proposal had to change about what was asked.
 *
 * Its existence is the confirmation trigger (M7.4.5). Silent shrinking, silent count
 * reduction and silent relocation are exactly what this type makes impossible to do
 * quietly: a planner that changes any of the three must say so here or not change it.
 */
export const DeviationSchema = z
  .object({
    kind: z.enum(['count', 'dimensions', 'destination', 'spacing']),
    requested: z.string().max(120),
    applied: z.string().max(120),
  })
  .strict();
export type Deviation = z.infer<typeof DeviationSchema>;

export const LayoutProposalSchema = z
  .object({
    proposalId: z.string(),
    /**
     * The revision this was planned against. A proposal arriving after another commit
     * is refused rather than applied to a room it never saw (M7.3.4).
     */
    baseRevision: z.number().int().nonnegative(),
    recipe: SceneRecipeSchema,
    /**
     * `complete` — every requested object is placed and validated.
     * `infeasible` — a specific geometric conflict was PROVED.
     * `search_exhausted` — the budget ran out. NOT a proof of impossibility, and
     *   narrated differently for exactly that reason (M7.2.7).
     */
    status: z.enum(['complete', 'infeasible', 'search_exhausted']),
    placements: z.array(ProposalPlacementSchema).max(12),
    groups: z.array(GroupSchema).max(6),
    /** Design object ids withdrawn by this transaction. */
    removals: z.array(z.string()).max(64),
    /** Measured ids whose visibility intent this transaction sets. */
    hideMeasuredIds: z.array(z.string()).max(64),
    palette: PaletteSchema.nullable(),
    /** Everything this transaction touches: placements, removals, repainted surfaces. */
    affectedIds: z.array(z.string()).max(128),
    deviations: z.array(DeviationSchema).max(8),
    requiresConfirmation: z.boolean(),
    /** Offered only when the proposal is not complete. Never a partial commit. */
    alternatives: z.array(z.object({ summary: z.string().max(160) }).strict()).max(4),
    /** One sentence, already in the user's terms. */
    explanation: z.string().max(400),
    /** Budget accounting, so a search-limit result can prove it was a search limit. */
    evaluations: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  })
  .strict();
export type LayoutProposal = z.infer<typeof LayoutProposalSchema>;

/**
 * What the engine actually commits: one draft, validated whole, published once.
 *
 * Separate from `LayoutProposal` because a proposal is a PLAN that may be shown,
 * confirmed or discarded, while a transaction is the act of applying one. Keeping them
 * distinct is what makes "cancellation leaves the original state intact" checkable.
 */
export const SceneTransactionSchema = z
  .object({
    transactionId: z.string(),
    proposalId: z.string(),
    baseRevision: z.number().int().nonnegative(),
    source: z.enum(['voice', 'tap', 'system']),
    /** Set by the caller once the user has agreed to the listed deviations. */
    confirmed: z.boolean().default(false),
  })
  .strict();
export type SceneTransaction = z.infer<typeof SceneTransactionSchema>;
