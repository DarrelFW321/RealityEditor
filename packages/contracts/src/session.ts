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
});
export type Assembly = z.infer<typeof AssemblySchema>;
export const EditorStateSchema = z.object({
  schemaVersion: z.literal(1),
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
  removalMaskIds: z.array(z.string()),
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
