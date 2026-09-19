import {
  EditorStateSchema,
  EditCommandSchema,
  LayoutProposalSchema,
  type ConstraintReport,
  type EditorState,
  type EditCommand,
  type EditRefusal,
  type EditResult,
  type EngineOp,
  type PoseV1,
  type SceneObject,
  type SettlingAdapter,
  type DiagnosticSink,
  type InteractionContext,
  type Assembly,
  type LayoutProposal,
  type ViolationResolved,
  type Vec3,
} from '@reality/contracts';
import {
  bearingFor,
  bearingIsDerived,
  buildIndex,
  describeViolation,
  evaluatePlacement,
  type ObjectLike,
  type PlacementAspect,
} from './geometry';
import { dominant, emptyReport, narrator, reasonFor, solvePlacement } from './solver';
import type { ObjectBuilder } from './layout';
import { rebuildDerived } from './derived';
import { narratableAdjustmentM } from './clearances';
import { applyStructuralChange } from './structure';

export * from './geometry';
export * from './clearances';
export * from './solver';
export * from './structure';
export * from './coverage';
export * from './derived';
export * from './scp';
export * from './layout';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Re-runs the authored construction checks for an assembly at a given size. */
export type Revalidator = (
  assembly: Assembly,
  dimensions: Vec3,
) => import('@reality/contracts').ConstructionResult;

const HISTORY_LIMIT = 32;
const APPLIED_LIMIT = 256;

export type EngineSnapshot = {
  scene: EditorState;
  previewScene: EditorState | null;
  preview: { targetId: string; pose: PoseV1 } | null;
  phase: 'committed' | 'held' | 'resolving' | 'settling';
  result: EditResult | null;
  /** Set when an adjustment is large enough to need confirming before it commits. */
  pending: { operationId: string; report: ConstraintReport } | null;
  /** What a release from the current held pose would do. Advisory only: carrying is never
   * obstructed by it, and it deliberately ignores support, which is not chosen until
   * release. Null whenever nothing is held. */
  previewValidity: { ok: boolean; reason: string | null } | null;
};

/** Which checks an edit actually needs. A colour change needs none of them. */
const ASPECTS: Record<string, readonly PlacementAspect[]> = {
  color: [],
  material: [],
  remove: [],
  rotate: ['bounds', 'intersection', 'doors', 'support', 'mount', 'construction'],
  // Rotation is the only one of these that cannot change an object's proportions, so it
  // is the only one that skips the stability check. Resize, add and replace can all
  // introduce something taller than its base is wide.
  resize: ['bounds', 'intersection', 'doors', 'support', 'mount', 'construction', 'stability'],
  add: ['bounds', 'intersection', 'doors', 'support', 'mount', 'construction', 'stability'],
  replace: ['bounds', 'intersection', 'doors', 'support', 'mount', 'construction', 'stability'],
};

const WALL_TEMPLATES = new Set(['frame', 'shelf']);

function templateOf(scene: EditorState, object: ObjectLike): string {
  return scene.assemblies[object.id]?.template ?? object.class;
}

/** A lamp may sit on a table. A bed may not. */
function mayRestOnObject(scene: EditorState, object: ObjectLike): boolean {
  if (WALL_TEMPLATES.has(templateOf(scene, object))) return false;
  const w = object.dimensions[0] ?? 0;
  const h = object.dimensions[1] ?? 0;
  const d = object.dimensions[2] ?? 0;
  return w * d <= 0.4 && h <= 0.6;
}

export class SpatialEngine {
  private snapshot: EngineSnapshot;
  private listeners = new Set<() => void>();
  private history: { scene: EditorState; opId: string }[] = [];
  private applied: string[] = [];
  private log: EngineOp[] = [];
  private branchId = 'br_main';
  private undone = 0;
  private sequence = 0;
  private pending: {
    operationId: string;
    candidate: EditorState;
    original: EditorState;
    report: ConstraintReport;
    /** Carried forward from the release that parked this. A scanned object has no
     * assembly, so re-deriving the support from `assemblies` on confirm yielded '' and
     * refused every confirmed adjustment of real furniture with "that support is no
     * longer there". The support was already resolved once; keep the answer. */
    supportSurface: string;
    /**
     * Set when the pending change is NOT a carry — a structural re-solve, which has a
     * complete validated candidate and no object in flight. `confirm` commits it
     * directly, because there is nothing for gravity to settle.
     */
    command?: EditCommand;
  } | null = null;
  private transaction: {
    original: EditorState;
    targetId: string;
    draft: EditorState;
    pendingIds: Set<string>;
    controller: AbortController;
  } | null = null;
  private tracking = true;
  /** Who asked for the edit currently being applied. Set immediately before a command
   * and cleared after, so it cannot leak onto an unrelated later op. */
  private cause: { turnId: string | null; source: 'voice' | 'tap' | 'system' } = {
    turnId: null,
    source: 'system',
  };

  constructor(
    scene: EditorState,
    private settling: SettlingAdapter,
    private diagnostics: DiagnosticSink,
    /**
     * Re-runs authored construction checks after a change that can invalidate them
     * (M7.5.3). Injected rather than imported for the same reason the object builder
     * is: template knowledge lives with the templates, and the engine owns scene state
     * and validation. Absent means the pre-M7 behaviour — the coarse flag only.
     */
    private revalidateConstruction: Revalidator | null = null,
  ) {
    // Derive before first publish. A fixture ships hand-authored relations and a grid
    // that were correct when written and have no guaranteed relationship to the geometry
    // beside them; presenting those as the scene's own derived data would mean the very
    // first commit silently changes fields nothing edited.
    const initial = copy(EditorStateSchema.parse(scene)) as EditorState;
    rebuildDerived(initial);
    this.snapshot = {
      scene: initial,
      phase: 'committed',
      previewScene: null,
      preview: null,
      result: null,
      pending: null,
      previewValidity: null,
    };
  }

  getSnapshot = (): EngineSnapshot => this.snapshot;

  /** Attributes the next commit. The coordinator sets this; nothing else should. */
  attribute(cause: { turnId: string | null; source: 'voice' | 'tap' | 'system' }) {
    this.cause = cause;
  }

  /**
   * Adopts the server's calibration id once a reconstruction session exists.
   *
   * `calibrationId` starts as RoomPlan's own room UUID, minted before any server contact,
   * so it could never match the id the server issues and every staleness check compared
   * two values that were guaranteed to differ. This is deliberately not a commit: it
   * changes no geometry, so it must not advance the revision, enter history, or become
   * undoable.
   */
  adoptCalibration(calibrationId: string) {
    if (!calibrationId || this.snapshot.scene.calibrationId === calibrationId) return;
    this.publish({ scene: { ...this.snapshot.scene, calibrationId } });
  }

  getLog = (): readonly EngineOp[] => this.log;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<EngineSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private remember(operationId: string) {
    this.applied.push(operationId);
    if (this.applied.length > APPLIED_LIMIT) this.applied.shift();
  }

  private wasApplied(operationId: string) {
    return this.applied.includes(operationId);
  }

  private result(
    status: EditResult['status'],
    message: string,
    extra: {
      report?: ConstraintReport | null;
      refusal?: EditRefusal | null;
      caveats?: string[];
      conflicts?: string[];
    } = {},
  ): EditResult {
    const report = extra.report ?? null;
    // Named, not raw ids: EditorPanel renders these straight onto the screen, and the
    // arrow is required because `.map` would otherwise pass the array index as `name`.
    const named = narrator(this.snapshot.scene).name;
    const conflicts =
      extra.conflicts ??
      (report ? report.violations_resolved.map((v) => describeViolation(v, named)) : []);
    const result: EditResult = {
      status,
      message,
      report,
      refusal: extra.refusal ?? null,
      caveats: extra.caveats ?? [],
      conflicts,
      revision: this.snapshot.scene.revision,
    };
    this.diagnostics.emit({
      timestamp: Date.now(),
      stage: 'engine',
      code: extra.refusal ?? status,
      sessionId: this.snapshot.scene.sessionId,
      revision: result.revision,
    });
    this.publish({ result });
    return result;
  }

  /** The carry lifecycle, recorded. The PRD requires held/drop/settling transitions,
   * rejected support surfaces, settling duration and the reason a pose was restored to
   * be observable; before this a whole carry emitted two events and neither was a
   * transition. Distinguishing allowed carry-time overlap from an invalid committed
   * overlap is why `carry/held` is logged separately from `engine/rejected`. */
  /** Re-runs construction for one object in a draft, in place. No-op without a
   * revalidator, which keeps the pre-M7 behaviour byte-identical. */
  private refreshConstruction(scene: EditorState, objectId: string) {
    if (!this.revalidateConstruction) return;
    const assembly = scene.assemblies[objectId];
    const object = scene.design.objects.find((o) => o.id === objectId);
    if (!assembly || !object) return;
    const verdict = this.revalidateConstruction(assembly, object.dimensions as Vec3);
    assembly.constructionResult = verdict;
    if (verdict.status === 'unsupported') assembly.construction = 'invalid';
    else if (verdict.status !== 'valid-within-template') assembly.construction = 'unknown';
    else assembly.construction = 'plausible';
  }

  private trace(code: string, extra: { targetId?: string; durationMs?: number } = {}) {
    this.diagnostics.emit({
      timestamp: Date.now(),
      stage: 'carry',
      code,
      sessionId: this.snapshot.scene.sessionId,
      revision: this.snapshot.scene.revision,
      ...extra,
    });
  }

  private commit(scene: EditorState, original: EditorState, operation: EngineOp) {
    scene.revision = this.snapshot.scene.revision + 1;
    scene.design.version = scene.revision;
    // DERIVED DATA IS REBUILT HERE, NOT BLANKED.
    //
    // This used to clear the grid to `size: [0, 0]` with the comment "never hand a
    // consumer a stale grid". Correct instinct, wrong half: no consumer ever received a
    // stale grid because no consumer ever received a grid. Relations were worse — carried
    // through from the fixture untouched, so they went stale the moment anything moved.
    //
    // Both are pure functions of the committed geometry, so both are recomputed from it
    // on every commit, including undo, which routes through here too.
    rebuildDerived(scene);
    // Editing after an undo forks rather than truncating, matching OpLog.
    if (this.undone > 0) {
      this.branchId = `br_${this.branchId}_${this.sequence}`;
      this.undone = 0;
    }
    this.history.push({ scene: copy(original), opId: operation.opId });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.remember(operation.opId);
    this.log.push({
      ...operation,
      seq: this.sequence++,
      branchId: this.branchId,
      appliedTs: Date.now(),
    });
    if (this.log.length > HISTORY_LIMIT * 2) this.log.shift();
    this.pending = null;
    this.publish({
      scene: copy(scene),
      phase: 'committed',
      preview: null,
      previewScene: null,
      pending: null,
      previewValidity: null,
    });
  }

  private makeOp(command: EditCommand, opId: string, inverse: EditCommand | null): EngineOp {
    return {
      opId,
      seq: -1,
      branchId: this.branchId,
      command,
      inverse,
      // Which utterance caused this edit. Hardcoded to `system` with a null turn until
      // now, so the op log could not distinguish a voice edit from a tap and M6's
      // correlation requirement had nowhere to land. Never a transcript: the contract
      // has the field and the diagnostics rule forbids recording raw speech.
      causedBy: { turnId: this.cause.turnId, transcript: '', source: this.cause.source },
      report: null,
      clientTs: Date.now(),
      appliedTs: null,
    };
  }

  /** Computed against the pre-apply scene, always absolute. Legacy Applier contract. */
  private inverseOf(scene: EditorState, command: EditCommand): EditCommand | null {
    const find = (id: string) => scene.design.objects.find((o) => o.id === id);
    switch (command.type) {
      case 'move': {
        const object = find(command.targetId);
        if (!object) return null;
        return {
          type: 'move',
          targetId: command.targetId,
          position: [...object.pose.position] as Vec3,
          supportSurface: scene.assemblies[command.targetId]?.support?.surfaceId ?? '',
        };
      }
      case 'rotate': {
        const object = find(command.targetId);
        return object ? { type: 'rotate', targetId: command.targetId, yaw: object.pose.yaw } : null;
      }
      case 'resize': {
        const object = find(command.targetId);
        return object
          ? {
              type: 'resize',
              targetId: command.targetId,
              dimensions: [...object.dimensions] as Vec3,
            }
          : null;
      }
      case 'color': {
        const object = find(command.targetId);
        return object
          ? { type: 'color', targetId: command.targetId, color: normaliseColor(object.material_ref) }
          : null;
      }
      case 'material': {
        const object = find(command.targetId);
        return object
          ? { type: 'material', targetId: command.targetId, materialRef: object.material_ref }
          : null;
      }
      case 'remove': {
        const object = find(command.targetId);
        const assembly = scene.assemblies[command.targetId];
        return object && assembly
          ? { type: 'add', object: copy(object), assembly: copy(assembly) }
          : null;
      }
      case 'add':
        return { type: 'remove', targetId: command.object.id };
      case 'replace': {
        const object = find(command.targetId);
        const assembly = scene.assemblies[command.targetId];
        return object && assembly
          ? {
              type: 'replace',
              targetId: command.targetId,
              object: copy(object),
              assembly: copy(assembly),
              keepPose: true,
            }
          : null;
      }
      case 'paint': {
        const surface = scene.design.surfaces.find((s) => s.id === command.targetId);
        return surface
          ? { type: 'paint', targetId: command.targetId, color: normaliseColor(surface.material_ref) }
          : null;
      }
      case 'structure':
        if (command.change.kind === 'offset_wall')
          return {
            type: 'structure',
            targetId: command.targetId,
            change: { kind: 'offset_wall', metres: -command.change.metres },
          };
        if (command.change.kind === 'ceiling_height')
          return {
            type: 'structure',
            targetId: command.targetId,
            change: { kind: 'ceiling_height', metres: scene.design.bounds.ceiling_height },
          };
        return null;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------- carrying

  begin(targetId: string): EditResult {
    const object = this.snapshot.scene.design.objects.find(
      (o) => o.id === targetId && o.state === 'present',
    );
    if (!object)
      return this.result('rejected', 'I cannot find that object in the room.', {
        refusal: 'unknown_target',
      });
    if (!object.movable)
      return this.result(
        'rejected',
        `The ${object.refined_class ?? object.class} is built in and cannot move.`,
        { refusal: 'immovable' },
      );
    if (!this.tracking)
      return this.result('rejected', 'Reliable tracking is required.', {
        refusal: 'tracking_lost',
      });
    if (this.transaction?.targetId === targetId) {
      // Re-grabbing cancels an in-flight settle rather than racing it.
      if (this.snapshot.phase === 'resolving' || this.snapshot.phase === 'settling') {
        this.transaction.controller.abort();
        this.transaction.controller = new AbortController();
      }
      this.publish({
        phase: 'held',
        previewValidity: this.snapshot.preview
          ? this.validityAt(this.transaction, this.snapshot.preview.pose)
          : null,
      });
      this.trace('regrabbed', { targetId });
      return this.result('preview', 'Carrying resumed.');
    }
    this.cancel();
    this.transaction = {
      original: copy(this.snapshot.scene),
      targetId,
      draft: copy(this.snapshot.scene),
      pendingIds: new Set(),
      controller: new AbortController(),
    };
    this.publish({
      phase: 'held',
      previewScene: this.transaction.draft,
      preview: { targetId, pose: copy(object.pose) as PoseV1 },
      previewValidity: this.validityAt(this.transaction, object.pose as PoseV1),
    });
    this.trace('held', { targetId });
    return this.result('preview', 'Carrying freely. Release to place.');
  }

  preview(pose: PoseV1) {
    if (
      !this.transaction ||
      this.snapshot.phase !== 'held' ||
      ![...pose.position, pose.yaw].every(Number.isFinite)
    )
      return;
    this.publish({
      preview: { targetId: this.transaction.targetId, pose: copy(pose) },
      previewValidity: this.validityAt(this.transaction, pose),
    });
  }

  /** Answers "would a release here be accepted?" without affecting the carry at all.
   * The PRD requires drop validity to be shown while held and equally requires it never
   * to obstruct movement, so this only ever writes to the snapshot.
   *
   * `support` and `mount` are deliberately excluded: no support is chosen until release,
   * so asking about one here would report every mid-air pose as floating and turn an
   * advisory query into a permanent red light. `allowAboveSupport` exists for exactly
   * this reason. Measured at 0.008 ms against a 16.7 ms frame, so the index is rebuilt
   * each time rather than cached and invalidated on mid-carry resize. */
  private validityAt(
    tx: NonNullable<SpatialEngine['transaction']>,
    pose: PoseV1,
  ): { ok: boolean; reason: string | null } {
    const object = tx.draft.design.objects.find((o) => o.id === tx.targetId);
    if (!object) return { ok: false, reason: 'That object is no longer in the room.' };
    const finding = evaluatePlacement(
      tx.draft,
      { ...object, pose: { position: pose.position, yaw: pose.yaw } } as ObjectLike,
      {
        aspects: ['bounds', 'intersection', 'doors'],
        stopAtFirst: true,
        skipNotes: true,
        allowAboveSupport: true,
      },
    );
    const worst = dominant(finding.violations);
    if (!worst) return { ok: true, reason: null };
    // Present tense and named: this is what a drop would hit right now, shown live.
    return { ok: false, reason: describeViolation(worst, narrator(tx.draft).name) };
  }

  cancel() {
    if (this.transaction) this.trace('cancelled', { targetId: this.transaction.targetId });
    this.transaction?.controller.abort();
    this.transaction = null;
    this.pending = null;
    this.publish({
      phase: 'committed',
      preview: null,
      previewScene: null,
      pending: null,
      previewValidity: null,
    });
  }

  setTracking(reliable: boolean) {
    if (this.tracking === reliable) return;
    this.tracking = reliable;
    if (!reliable) {
      // Recorded before cancel() so the log says why the pose was restored, not just that
      // it was. Tracking loss and a user cancel are the same rollback but not the same event.
      if (this.transaction) this.trace('restored_tracking_lost', { targetId: this.transaction.targetId });
      this.cancel();
      this.result('rejected', 'Tracking lost. Last committed scene preserved.', {
        refusal: 'tracking_lost',
      });
    }
  }

  /** Resolves a named support into a mode, or refuses an incompatible pairing. */
  private resolveSupport(
    scene: EditorState,
    object: ObjectLike,
    supportId: string,
  ): { mode: 'floor' | 'wall' | 'object'; surfaceId: string } | { refusal: EditRefusal; message: string } {
    const surface = scene.design.surfaces.find((s) => s.id === supportId && s.state === 'present');
    const wantsWall = WALL_TEMPLATES.has(templateOf(scene, object));
    if (surface) {
      if (surface.class === 'wall')
        return wantsWall
          ? { mode: 'wall', surfaceId: supportId }
          : { refusal: 'incompatible_support', message: 'That object does not mount to a wall.' };
      if (surface.class === 'floor')
        return wantsWall
          ? { refusal: 'incompatible_support', message: 'That object mounts to a wall.' }
          : { mode: 'floor', surfaceId: supportId };
      return { refusal: 'incompatible_support', message: 'Choose a wall or the floor.' };
    }
    const supporter = scene.design.objects.find(
      (o) => o.id === supportId && o.state === 'present',
    );
    if (!supporter) return { refusal: 'unknown_target', message: 'That support is not in the room.' };
    // A scanned object has no assembly, so its bearing is derived from the measured box.
    // Without this a real desk can never hold anything, which made object support
    // unreachable for every piece of furniture an actual RoomPlan scan produces.
    if (!bearingFor(scene, supporter as ObjectLike))
      return {
        refusal: 'incompatible_support',
        message: `The ${supporter.refined_class ?? supporter.class} has no surface that can hold something.`,
      };
    if (!mayRestOnObject(scene, object))
      return {
        refusal: 'incompatible_support',
        message: 'That is too large to rest on another object. It belongs on the floor.',
      };
    return { mode: 'object', surfaceId: supportId };
  }

  async release(operationId: string, supportSurface: string): Promise<EditResult> {
    const tx = this.transaction;
    const preview = this.snapshot.preview;
    if (!tx || !preview || this.snapshot.phase !== 'held')
      return this.result('rejected', 'No active carry.', { refusal: 'no_transaction' });
    if (this.wasApplied(operationId)) {
      this.cancel();
      return this.result('rejected', 'That edit was already applied.', {
        refusal: 'duplicate_operation',
      });
    }

    const candidate = copy(tx.draft) as EditorState;
    const object = candidate.design.objects.find((o) => o.id === tx.targetId);
    if (!object) {
      this.cancel();
      return this.result('rejected', 'That object is no longer in the room.', {
        refusal: 'unknown_target',
      });
    }
    object.pose = copy(preview.pose);

    const support = this.resolveSupport(candidate, object, supportSurface);
    if ('refusal' in support) {
      this.trace('support_rejected', { targetId: supportSurface });
      this.cancel();
      return this.result('rejected', support.message, { refusal: support.refusal });
    }
    const assembly = candidate.assemblies[object.id];
    if (assembly) {
      assembly.support = { ...assembly.support, mode: support.mode, surfaceId: support.surfaceId };
      assembly.mounting = support.mode === 'wall' ? 'wall' : 'floor';
      assembly.supportSurface = support.surfaceId;
      // The support just changed, and support contact is one of the authored checks.
      this.refreshConstruction(candidate, object.id);
      if (assembly.construction === 'invalid') {
        this.cancel();
        return this.result('rejected', 'That construction cannot be built.', {
          refusal: 'construction_invalid',
        });
      }
    }

    this.trace('resolving', { targetId: object.id });
    this.publish({ phase: 'resolving', previewValidity: null });
    const report = solvePlacement(
      candidate,
      object.id,
      object.pose as PoseV1,
      buildIndex(candidate, object.id),
      {
        supportId: support.mode === 'object' ? support.surfaceId : undefined,
        // Gravity closes the gap to the support; the settled pose is checked strictly.
        allowAboveSupport: true,
      },
    );
    if (report.status === 'rejected') {
      this.trace('restored_unsolvable', { targetId: object.id });
      this.cancel();
      return this.result('rejected', 'Drop rejected; original placement restored.', { report });
    }
    const resolved = report.applied_pose!;
    object.pose = { position: [...resolved.position] as Vec3, yaw: resolved.yaw };

    // A lateral adjustment the user can see must be confirmed, not slipped in.
    if (report.status === 'adjusted' && report.adjustment_distance_m >= narratableAdjustmentM) {
      this.pending = {
        operationId,
        candidate,
        original: tx.original,
        report,
        supportSurface: support.surfaceId,
      };
      this.publish({
        phase: 'resolving',
        pending: { operationId, report },
        preview: { targetId: object.id, pose: object.pose as PoseV1 },
      });
      return this.result('adjusted', `I can move it, but ${report.adjustment_reason}.`, {
        report,
        refusal: 'awaiting_confirmation',
      });
    }

    return this.finish(operationId, candidate, tx, report, support.surfaceId);
  }

  /** Commits a pending adjustment under its original id, so retries stay idempotent. */
  async confirm(operationId: string): Promise<EditResult> {
    const pending = this.pending;
    const tx = this.transaction;
    if (!pending || pending.operationId !== operationId)
      return this.result('rejected', 'There is nothing waiting to confirm.', {
        refusal: 'no_transaction',
      });
    // A pending with a `command` and no carry is a whole-scene candidate that was already
    // validated in full. Routing it through `finish` would ask the settling adapter to
    // drop an object that was never picked up.
    if (pending.command && !tx) {
      const operation = this.makeOp(
        pending.command,
        operationId,
        this.inverseOf(pending.original, pending.command),
      );
      this.commit(pending.candidate, pending.original, { ...operation, report: pending.report });
      return this.result('applied', 'Room updated; the furniture moved to keep it valid.', {
        report: pending.report,
      });
    }
    if (!tx)
      return this.result('rejected', 'There is nothing waiting to confirm.', {
        refusal: 'no_transaction',
      });
    return this.finish(operationId, pending.candidate, tx, pending.report, pending.supportSurface);
  }

  private async finish(
    operationId: string,
    candidate: EditorState,
    tx: NonNullable<SpatialEngine['transaction']>,
    report: ConstraintReport,
    supportSurface: string,
  ): Promise<EditResult> {
    const object = candidate.design.objects.find((o) => o.id === tx.targetId)!;
    this.trace('settling', { targetId: object.id });
    this.publish({ phase: 'settling', pending: null });
    const controller = tx.controller;
    const cancelled = () => controller.signal.aborted || this.transaction !== tx;
    const startedAt = Date.now();
    try {
      const settled = await this.settling.settle(
        { scene: candidate, targetId: object.id, pose: object.pose as PoseV1, supportSurface },
        controller.signal,
        (p) => {
          if (!cancelled()) this.publish({ preview: { targetId: object.id, pose: p } });
        },
      );
      if (cancelled()) {
        this.trace('restored_cancelled', {
          targetId: object.id,
          durationMs: Date.now() - startedAt,
        });
        return this.result('rejected', 'That move was cancelled.', { refusal: 'no_transaction' });
      }
      this.trace('settled', { targetId: object.id, durationMs: Date.now() - startedAt });
      object.pose = settled;

      // The support could have moved or gone during the settle window.
      const stillThere =
        candidate.design.surfaces.some((s) => s.id === supportSurface && s.state === 'present') ||
        candidate.design.objects.some((o) => o.id === supportSurface && o.state === 'present');
      if (!stillThere) {
        this.trace('restored_support_gone', { targetId: supportSurface });
        this.cancel();
        return this.result('rejected', 'That support is no longer there.', {
          refusal: 'incompatible_support',
        });
      }

      const onObject = candidate.assemblies[object.id]?.support.mode === 'object';
      const finding = evaluatePlacement(candidate, object, {
        supportId: onObject ? supportSurface : undefined,
      });
      // A derived bearing is geometry read off a scan, not a load rating. Say so rather
      // than let a successful placement imply the real shelf was measured to hold this.
      const supporter = candidate.design.objects.find((o) => o.id === supportSurface);
      if (onObject && supporter && bearingIsDerived(candidate, supporter as ObjectLike))
        finding.caveats.push(
          `The top of the ${supporter.refined_class ?? supporter.class} was derived from its scanned outline; its real load capacity is not verified.`,
        );
      if (finding.violations.length) {
        this.trace('restored_invalid_settle', { targetId: object.id });
        this.cancel();
        return this.result('rejected', 'Settling did not produce a valid placement.', {
          report: { ...report, status: 'rejected', violations_resolved: finding.violations },
          caveats: finding.caveats,
        });
      }
      if (candidate.measured.objects.some((o) => o.id === object.id))
        candidate.removedPhysicalIds = [...new Set([...candidate.removedPhysicalIds, object.id])];

      tx.pendingIds.forEach((id) => this.remember(id));
      const command: EditCommand = {
        type: 'move',
        targetId: object.id,
        position: [...object.pose.position] as Vec3,
        supportSurface,
      };
      const operation = this.makeOp(command, operationId, this.inverseOf(tx.original, command));
      this.transaction = null;
      this.commit(candidate, tx.original, { ...operation, report });
      this.trace('committed', { targetId: object.id, durationMs: Date.now() - startedAt });
      return this.result(
        report.status === 'adjusted' ? 'adjusted' : 'applied',
        report.status === 'adjusted'
          ? `Placed it, but ${report.adjustment_reason}.`
          : 'Placed on the selected support.',
        { report: { ...report, remaining_notes: finding.notes }, caveats: finding.caveats },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (cancelled()) {
        this.trace('restored_cancelled', { targetId: object.id, durationMs });
        return this.result('rejected', 'That move was cancelled.', { refusal: 'no_transaction' });
      }
      this.trace('restored_settle_failed', { targetId: object.id, durationMs });
      this.cancel();
      return this.result('rejected', 'Settling failed; original placement restored.', {
        conflicts: [error instanceof Error ? error.message : 'Unknown settling failure'],
      });
    }
  }

  // -------------------------------------------------------------- commands

  async execute(input: EditCommand, operationId: string, revision: number): Promise<EditResult> {
    const parsed = EditCommandSchema.safeParse(input);
    if (!parsed.success)
      return this.result('rejected', 'That edit is missing something.', {
        refusal: 'invalid_parameters',
      });
    const command = parsed.data;
    if (this.wasApplied(operationId))
      return this.result('rejected', 'That edit was already applied.', {
        refusal: 'duplicate_operation',
      });
    if (revision !== this.snapshot.scene.revision)
      return this.result('rejected', 'The room changed. Please repeat the edit.', {
        refusal: 'stale_revision',
      });
    if (!this.tracking)
      return this.result('rejected', 'Reliable tracking is required.', {
        refusal: 'tracking_lost',
      });

    if (command.type === 'undo') return this.undo(operationId);
    // A restyle is a whole transaction with its own entry point. It carries no geometry,
    // so executing it here would commit an op log entry for a draft nobody built.
    if (command.type === 'restyle')
      return this.result('rejected', 'Apply a restyle through its proposal.', {
        refusal: 'invalid_parameters',
      });

    // An edit during a carry joins that transaction; it never starts a competing writer.
    if (this.transaction) {
      const tx = this.transaction;
      if (this.snapshot.phase !== 'held')
        return this.result('rejected', 'Finish or cancel the active move first.', {
          refusal: 'no_transaction',
        });
      if (command.type === 'add' || command.type === 'structure')
        return this.result('rejected', 'Finish or cancel the active move first.', {
          refusal: 'no_transaction',
        });
      if (command.targetId !== tx.targetId)
        return this.result('rejected', 'Finish or cancel the active move first.', {
          refusal: 'no_transaction',
        });
      if (command.type === 'move') {
        this.preview({ position: command.position, yaw: this.snapshot.preview!.pose.yaw });
        return this.release(operationId, command.supportSurface);
      }
      return this.previewEdit(command, operationId, tx);
    }

    if (command.type === 'move') {
      const begin = this.begin(command.targetId);
      if (begin.status === 'rejected') return begin;
      this.preview({ position: command.position, yaw: this.snapshot.preview!.pose.yaw });
      return this.release(operationId, command.supportSurface);
    }
    if (command.type === 'structure') return this.structure(command, operationId);
    return this.batch([command], operationId, revision);
  }

  private undo(operationId: string): EditResult {
    this.cancel();
    const previous = this.history.pop();
    if (!previous)
      return this.result('rejected', 'There is nothing left to undo.', {
        refusal: 'history_evicted',
      });
    const restored = copy(previous.scene) as EditorState;
    const operation = this.makeOp({ type: 'undo' }, operationId, null);
    this.undone += 1;
    this.commit(restored, this.snapshot.scene, operation);
    return this.result('applied', 'Undone.');
  }

  private previewEdit(
    command: Exclude<EditCommand, { type: 'move' | 'undo' | 'add' | 'structure' }>,
    operationId: string,
    tx: NonNullable<SpatialEngine['transaction']>,
  ): EditResult {
    if (tx.pendingIds.has(operationId))
      return this.result('rejected', 'That edit was already previewed.', {
        refusal: 'duplicate_operation',
      });
    const draft = copy(tx.draft) as EditorState;
    const object = draft.design.objects.find((o) => o.id === tx.targetId)!;
    const caveats: string[] = [];
    if (command.type === 'color') applyColor(draft, object, command.color);
    else if (command.type === 'material') object.material_ref = command.materialRef;
    else if (command.type === 'rotate')
      this.preview({ ...this.snapshot.preview!.pose, yaw: command.yaw });
    else if (command.type === 'resize') {
      const outcome = applyResize(draft, object, command.dimensions, this.revalidateConstruction);
      if ('refusal' in outcome)
        return this.result('rejected', outcome.message, { refusal: outcome.refusal });
      caveats.push(...outcome.caveats);
    } else if (command.type === 'remove' || command.type === 'replace')
      return this.result('rejected', 'Finish or cancel the active move first.', {
        refusal: 'no_transaction',
      });
    tx.draft = draft;
    tx.pendingIds.add(operationId);
    this.publish({
      previewScene: draft,
      previewValidity: this.snapshot.preview
        ? this.validityAt(tx, this.snapshot.preview.pose)
        : null,
    });
    return this.result('preview', 'Updated the carried object. Release to commit.', { caveats });
  }

  private structure(
    command: Extract<EditCommand, { type: 'structure' }>,
    operationId: string,
  ): EditResult {
    const original = this.snapshot.scene;
    const outcome = applyStructuralChange(copy(original) as EditorState, command);
    if (!outcome.ok)
      return this.result('rejected', outcome.message, { refusal: outcome.refusal });
    const candidate = outcome.scene;
    const index = buildIndex(candidate, '');
    const blocked: string[] = [];
    const violations = [];
    // Revalidate in id order so two runs report the same blocking object first.
    for (const id of [...outcome.touched].sort()) {
      const object = candidate.design.objects.find((o) => o.id === id);
      if (!object || object.state !== 'present') continue;
      const finding = evaluatePlacement(candidate, object, { index, skipNotes: true });
      if (finding.violations.length) {
        blocked.push(id);
        violations.push(...finding.violations);
      }
    }
    if (blocked.length) {
      // M7.4.4: try to re-solve the furniture the change displaced before refusing it.
      // A complete alternative that moves three things 20cm is a far better answer than
      // "no", and the rule is that it is offered for CONFIRMATION rather than applied —
      // the user asked to move a wall, not to have their bed relocated behind their back.
      const resolvedPoses: { id: string; pose: PoseV1; distance: number }[] = [];
      let allResolved = true;
      for (const id of [...blocked].sort()) {
        const object = candidate.design.objects.find((o) => o.id === id)!;
        const support = candidate.assemblies[id]?.support;
        const attempt = solvePlacement(
          candidate,
          id,
          { position: [...object.pose.position] as Vec3, yaw: object.pose.yaw },
          buildIndex(candidate, id),
          { supportId: support?.mode === 'object' ? support.surfaceId : undefined },
        );
        if (attempt.status === 'rejected' || !attempt.applied_pose) {
          allResolved = false;
          break;
        }
        const pose: PoseV1 = {
          position: [...attempt.applied_pose.position] as Vec3,
          yaw: attempt.applied_pose.yaw,
        };
        object.pose = { position: [...pose.position], yaw: pose.yaw };
        resolvedPoses.push({ id, pose, distance: attempt.adjustment_distance_m });
      }
      if (!allResolved) {
        const report: ConstraintReport = {
          ...emptyReport('rejected'),
          adjustment_reason: `it would leave ${blocked.length} item${blocked.length > 1 ? 's' : ''} with nowhere to go`,
          violations_resolved: violations,
        };
        return this.result('rejected', 'That room change would invalidate existing furniture.', {
          report,
        });
      }
      const furthest = resolvedPoses.reduce((a, b) => (b.distance > a.distance ? b : a));
      const named = narrator(candidate).name;
      const report: ConstraintReport = {
        ...emptyReport('adjusted'),
        adjustment_distance_m: furthest.distance,
        adjustment_reason: `${resolvedPoses.length} item${resolvedPoses.length > 1 ? 's' : ''} would have to move, the ${named(furthest.id)} by ${Math.round(furthest.distance * 100)}cm`,
        violations_resolved: violations,
      };
      this.pending = {
        operationId,
        candidate,
        original,
        report,
        supportSurface: '',
        command,
      };
      this.publish({ pending: { operationId, report } });
      return this.result(
        'adjusted',
        `I can do that, but ${report.adjustment_reason}.`,
        { report, refusal: 'awaiting_confirmation' },
      );
    }
    const operation = this.makeOp(command, operationId, this.inverseOf(original, command));
    this.commit(candidate, original, operation);
    return this.result('applied', 'Room updated.');
  }

  batch(
    commands: Exclude<EditCommand, { type: 'move' | 'undo' | 'structure' | 'restyle' }>[],
    operationId: string,
    revision: number,
  ): EditResult {
    if (this.transaction)
      return this.result('rejected', 'Finish or cancel the active move first.', {
        refusal: 'no_transaction',
      });
    if (!this.tracking)
      return this.result('rejected', 'Reliable tracking is required.', {
        refusal: 'tracking_lost',
      });
    if (revision !== this.snapshot.scene.revision)
      return this.result('rejected', 'The room changed. Please repeat the edit.', {
        refusal: 'stale_revision',
      });
    if (this.wasApplied(operationId))
      return this.result('rejected', 'That edit was already applied.', {
        refusal: 'duplicate_operation',
      });

    const original = this.snapshot.scene;
    const candidate = copy(original) as EditorState;
    const changed = new Map<string, readonly PlacementAspect[]>();
    const caveats: string[] = [];

    for (const command of commands) {
      if (!EditCommandSchema.safeParse(command).success)
        return this.result('rejected', 'That edit is missing something.', {
          refusal: 'invalid_parameters',
        });
      if (command.type === 'add') {
        if (candidate.design.objects.some((o) => o.id === command.object.id))
          return this.result('rejected', 'That object is already in the room.', {
            refusal: 'invalid_parameters',
          });
        if (command.assembly.construction === 'invalid')
          return this.result('rejected', 'That construction cannot be built.', {
            refusal: 'construction_invalid',
          });
        candidate.design.objects.push(copy(command.object));
        candidate.assemblies[command.object.id] = copy(command.assembly);
        changed.set(command.object.id, ASPECTS.add!);
        continue;
      }
      if (command.type === 'paint') {
        // A surface, not an object. Repainting is cosmetic and changes no geometry, so
        // it needs no placement aspects — but it does mark the surface as designed,
        // because a measured wall's observed appearance is no longer what is shown.
        const surface = candidate.design.surfaces.find(
          (s) => s.id === command.targetId && s.state === 'present',
        );
        if (!surface)
          return this.result('rejected', 'That surface is not in the room.', {
            refusal: 'unknown_target',
          });
        surface.material_ref = command.color;
        surface.provenance = 'virtual';
        continue;
      }
      const object = candidate.design.objects.find(
        (o) => o.id === command.targetId && o.state === 'present',
      );
      if (!object)
        return this.result('rejected', 'That object is no longer in the room.', {
          refusal: 'unknown_target',
        });

      if (command.type === 'remove') {
        object.state = 'hidden';
        if (candidate.measured.objects.some((o) => o.id === object.id))
          candidate.removedPhysicalIds = [...new Set([...candidate.removedPhysicalIds, object.id])];
        continue;
      }
      if (command.type === 'color') {
        applyColor(candidate, object, command.color);
        changed.set(object.id, ASPECTS.color!);
        continue;
      }
      if (command.type === 'material') {
        object.material_ref = command.materialRef;
        changed.set(object.id, ASPECTS.material!);
        continue;
      }
      if (command.type === 'rotate') {
        object.pose.yaw = command.yaw;
        this.refreshConstruction(candidate, object.id);
        changed.set(object.id, ASPECTS.rotate!);
        continue;
      }
      if (command.type === 'replace') {
        if (command.assembly.construction === 'invalid')
          return this.result('rejected', 'That construction cannot be built.', {
            refusal: 'construction_invalid',
          });
        const pose = command.keepPose ? copy(object.pose) : copy(command.object.pose);
        const next = { ...copy(command.object), id: object.id, pose };
        candidate.design.objects = candidate.design.objects.map((o) =>
          o.id === object.id ? next : o,
        );
        candidate.assemblies[object.id] = copy(command.assembly);
        changed.set(object.id, ASPECTS.replace!);
        continue;
      }
      const outcome = applyResize(candidate, object, command.dimensions, this.revalidateConstruction);
      if ('refusal' in outcome)
        return this.result('rejected', outcome.message, { refusal: outcome.refusal });
      caveats.push(...outcome.caveats);
      changed.set(object.id, ASPECTS.resize!);
    }

    const index = buildIndex(candidate, '');
    const notes = [];
    for (const [id, aspects] of [...changed.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!aspects.length) continue;
      const object = candidate.design.objects.find((o) => o.id === id);
      if (!object || object.state !== 'present') continue;
      const support = candidate.assemblies[id]?.support;
      const finding = evaluatePlacement(candidate, object, {
        index,
        aspects,
        supportId: support?.mode === 'object' ? support.surfaceId : undefined,
      });
      caveats.push(...finding.caveats);
      notes.push(...finding.notes);
      if (finding.violations.length) {
        const report: ConstraintReport = {
          ...emptyReport('rejected'),
          requested_pose: { position: [...object.pose.position], yaw: object.pose.yaw },
          violations_resolved: finding.violations,
        };
        return this.result('rejected', 'That edit cannot be committed.', {
          report,
          caveats: [...new Set(caveats)],
        });
      }
    }

    const first = commands[0]!;
    const operation = this.makeOp(first, operationId, this.inverseOf(original, first));
    const report: ConstraintReport = { ...emptyReport('applied'), remaining_notes: notes };
    this.commit(candidate, original, { ...operation, report });
    return this.result('applied', 'Scene updated.', {
      report,
      caveats: [...new Set(caveats)],
    });
  }

  // ------------------------------------------------- M7.3 restyle transactions

  /**
   * Applies a whole layout proposal as ONE transaction.
   *
   * Everything is prepared in an isolated draft, the COMPLETE resulting arrangement is
   * validated, and only then is a single commit published: one revision, one op log
   * entry, one undo. Any refusal on the way out returns before `commit`, so the original
   * state is untouched by construction rather than by a rollback that has to be right.
   *
   * The builder is passed in rather than held, exactly as the planner takes it: the
   * engine owns scene state and validation, and knows nothing about how a bed is made.
   */
  applyProposal(
    proposal: LayoutProposal,
    operationId: string,
    options: { build: ObjectBuilder; confirmed?: boolean },
  ): EditResult {
    const parsed = LayoutProposalSchema.safeParse(proposal);
    if (!parsed.success)
      return this.result('rejected', 'That proposal is not well formed.', {
        refusal: 'invalid_parameters',
      });
    const plan = parsed.data;

    if (this.transaction)
      return this.result('rejected', 'Finish or cancel the active move first.', {
        refusal: 'no_transaction',
      });
    if (!this.tracking)
      return this.result('rejected', 'Reliable tracking is required.', {
        refusal: 'tracking_lost',
      });
    if (this.wasApplied(operationId))
      return this.result('rejected', 'That restyle was already applied.', {
        refusal: 'duplicate_operation',
      });
    // A proposal planned against an older room describes furniture that has since moved.
    // Refusing preserves the current design; re-planning is the caller's job.
    if (plan.baseRevision !== this.snapshot.scene.revision)
      return this.result('rejected', 'The room changed while I was planning. Ask again.', {
        refusal: 'stale_revision',
      });
    if (plan.status !== 'complete')
      return this.result('rejected', plan.explanation, {
        refusal: plan.status === 'search_exhausted' ? 'invalid_parameters' : 'unsupported_structure',
        conflicts: plan.alternatives.map((a) => `Try ${a.summary}.`),
      });
    // A plan that changed what was asked must be agreed to first. `deviations` is the
    // only way the planner can alter a count, a size or a destination, so gating on it
    // is what makes silent substitution impossible rather than merely discouraged.
    if (plan.requiresConfirmation && !options.confirmed)
      return this.result(
        'adjusted',
        `${plan.explanation} Say yes to apply it.`,
        {
          refusal: 'awaiting_confirmation',
          conflicts: plan.deviations.map((d) => `${d.kind}: asked ${d.requested}, planned ${d.applied}`),
        },
      );

    const original = this.snapshot.scene;
    const candidate = copy(original) as EditorState;
    const caveats: string[] = [];
    const named = narrator(original).name;

    // 1. Withdrawals. A measured object leaving the design is a claim about the REAL
    //    room, so it is recorded as a physical removal and said out loud; a virtual one
    //    simply stops existing.
    for (const id of plan.removals) {
      const object = candidate.design.objects.find((o) => o.id === id);
      if (!object) continue;
      if (candidate.measured.objects.some((m) => m.id === id)) {
        object.state = 'hidden';
        candidate.removedPhysicalIds = [...new Set([...candidate.removedPhysicalIds, id])];
        caveats.push(`The real ${named(id)} has to be moved out for this design to fit.`);
      } else {
        candidate.design.objects = candidate.design.objects.filter((o) => o.id !== id);
        delete candidate.assemblies[id];
      }
    }

    // 2. Visibility intent, by MEASURED identity only. Dropping the object from the
    //    design stops it being drawn while the measured observation keeps it in the
    //    index — so a hidden bed is still something the planner has to route around.
    //    Nothing here touches `removedPhysicalIds`: not seeing it is not it being gone.
    for (const id of plan.hideMeasuredIds) {
      if (!candidate.measured.objects.some((m) => m.id === id)) continue;
      candidate.design.objects = candidate.design.objects.filter((o) => o.id !== id);
      candidate.removalMaskIds = [...new Set([...candidate.removalMaskIds, id])];
    }
    if (candidate.removalMaskIds.length)
      candidate.removalMaskCalibration = {
        calibrationId: candidate.calibrationId,
        calibrationRevision: candidate.calibrationRevision,
      };

    // 3. Placements. A reused member keeps its id and is re-posed in place, which is
    //    what makes a count change an edit of the same objects rather than a rebuild.
    for (const placement of plan.placements) {
      const built = options.build(
        {
          family: placement.family,
          count: 1,
          dimensions: placement.dimensions,
          color: placement.color,
          legs: placement.legs,
        },
        placement.id,
        placement.position,
        placement.supportSurface,
        placement.materialClass,
      );
      if (built.assembly.construction === 'invalid')
        return this.result(
          'rejected',
          built.assembly.constructionResult?.findings[0]?.detail ??
            'That construction cannot be built.',
          { refusal: 'construction_invalid' },
        );
      const object = {
        ...copy(built.object),
        pose: { position: [...placement.position] as Vec3, yaw: placement.yaw },
      };
      const at = candidate.design.objects.findIndex((o) => o.id === placement.id);
      if (at >= 0) candidate.design.objects[at] = object;
      else candidate.design.objects.push(object);
      candidate.assemblies[placement.id] = copy(built.assembly);
      if (built.assembly.constructionResult?.status !== 'valid-within-template')
        caveats.push(
          `${placement.family}: ${built.assembly.constructionResult?.findings[0]?.detail ?? 'construction not verified'}`,
        );
    }

    // 4. Palette. Surfaces are repainted wholesale; objects only where they are ours to
    //    repaint — a measured object's colour is an observation, and a preserved one was
    //    explicitly asked to stay as it is.
    const palette = plan.palette;
    if (palette) {
      for (const surface of candidate.design.surfaces) {
        const colour =
          surface.class === 'wall' ? palette.walls : surface.class === 'floor' ? palette.floor : null;
        if (!colour) continue;
        surface.material_ref = colour;
        surface.provenance = 'virtual';
      }
      if (palette.objects) {
        const preserved = new Set(plan.recipe.preserveIds);
        for (const object of candidate.design.objects)
          if (object.provenance === 'virtual' && !preserved.has(object.id))
            applyColor(candidate, object, palette.objects);
      }
    }

    // 5. Group membership, and a sweep for groups nothing is left of.
    for (const group of plan.groups) candidate.groups[group.id] = copy(group);
    for (const [id, group] of Object.entries(candidate.groups))
      if (
        !group.order.some((member) =>
          candidate.design.objects.some((o) => o.id === member && o.state === 'present'),
        )
      )
        delete candidate.groups[id];

    // 6. Validate the COMPLETE arrangement, not just what moved.
    //
    //    Only violations this transaction CREATED can refuse it. A scan can hand us a
    //    room whose measured furniture already overlaps slightly, and refusing a restyle
    //    because of a condition it did not cause would make the feature unusable in
    //    exactly the rooms it is for. Pre-existing problems are reported instead.
    const before = violationSignatures(original);
    const after = violationSignatures(candidate);
    const introduced = [...after.entries()].filter(([key]) => !before.has(key));
    if (introduced.length) {
      const worst = introduced
        .map(([, violation]) => violation)
        .sort((a, b) => b.overlap_m - a.overlap_m)[0]!;
      const report: ConstraintReport = {
        ...emptyReport('rejected'),
        adjustment_reason: reasonFor(worst, named, narrator(candidate).arcRadius),
        violations_resolved: introduced.map(([, violation]) => violation),
      };
      return this.result('rejected', 'That arrangement does not work; nothing was changed.', {
        report,
        caveats: [...new Set(caveats)],
      });
    }
    const carried = [...before.keys()].filter((key) => after.has(key)).length;
    if (carried)
      caveats.push(`${carried} pre-existing placement problem(s) in this room were left as they are.`);

    // 7. One commit. One revision. One undo entry covering objects, surfaces, groups
    //    and visibility intent together, because `commit` snapshots the whole state.
    const command: EditCommand = {
      type: 'restyle',
      proposalId: plan.proposalId,
      label: plan.recipe.label.slice(0, 80),
      affectedIds: plan.affectedIds.slice(0, 128),
    };
    const operation = this.makeOp(command, operationId, null);
    const report: ConstraintReport = { ...emptyReport('applied') };
    this.commit(candidate, original, { ...operation, report });
    return this.result('applied', plan.explanation, {
      report,
      caveats: [...new Set(caveats)],
    });
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
  }
}

/**
 * Every violation in a scene, keyed so two scenes can be compared.
 *
 * The key deliberately includes the subject, the type and the other party but NOT the
 * depth: an overlap that merely got worse is still the same pre-existing overlap, and
 * treating a millimetre of drift as a new problem would make the diff useless.
 */
function violationSignatures(scene: EditorState): Map<string, ViolationResolved> {
  const index = buildIndex(scene, '');
  const out = new Map<string, ViolationResolved>();
  for (const object of [...scene.design.objects].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (object.state !== 'present') continue;
    const support = scene.assemblies[object.id]?.support;
    const finding = evaluatePlacement(scene, object, {
      index,
      skipNotes: true,
      supportId: support?.mode === 'object' ? support.surfaceId : undefined,
    });
    for (const violation of finding.violations)
      out.set(`${object.id}|${violation.type}|${violation.with}`, violation);
  }
  return out;
}

function normaliseColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value : '#999999';
}

function applyColor(scene: EditorState, object: SceneObject, color: string) {
  object.material_ref = color;
  scene.assemblies[object.id]?.parts.forEach((part) => {
    part.color = color;
  });
}

function applyResize(
  scene: EditorState,
  object: SceneObject,
  dimensions: Vec3,
  revalidate: Revalidator | null = null,
): { caveats: string[] } | { refusal: EditRefusal; message: string } {
  const assembly = scene.assemblies[object.id];
  if (!assembly)
    return { refusal: 'invalid_parameters', message: 'That object has no editable template.' };
  const ratios = dimensions.map((v, i) => v / (object.dimensions[i] ?? 1));
  assembly.parts.forEach((part) => {
    part.center = part.center.map((v, i) => v * ratios[i]!) as Vec3;
    part.size = part.size.map((v, i) => v * ratios[i]!) as Vec3;
  });
  assembly.supports = assembly.supports.map(([x, z]) => [x * ratios[0]!, z * ratios[2]!]);
  if (assembly.support.bearing)
    assembly.support.bearing = {
      polygon: assembly.support.bearing.polygon.map(([x, z]) => [x * ratios[0]!, z * ratios[2]!]),
      y: assembly.support.bearing.y * ratios[1]!,
    };
  object.dimensions = dimensions;
  const caveats: string[] = [];
  // Outside the template's envelope is unknown, not invalid. It commits with a caveat.
  if (ratios.some((r) => r > 1.25 || r < 0.75)) {
    assembly.construction = 'unknown';
    caveats.push('Resized beyond this template’s verified envelope; construction is not verified.');
  }
  // The authored checks are re-run against the NEW dimensions, so a resize that puts a
  // shelf past its span or a load outside its support polygon says which, rather than
  // leaving a stale verdict from the size the object used to be.
  if (revalidate) {
    const verdict = revalidate(assembly, dimensions);
    assembly.constructionResult = verdict;
    if (verdict.status === 'unsupported') assembly.construction = 'invalid';
    else if (verdict.status !== 'valid-within-template') assembly.construction = 'unknown';
    for (const finding of verdict.findings) caveats.push(finding.detail);
  }
  return { caveats };
}

/** Latches selection independently from a destination and retains speech context. */
export class AttentionHistory {
  private samples: InteractionContext[] = [];
  private turns = new Map<string, InteractionContext>();
  private hits = 0;
  private misses = 0;

  push(sample: InteractionContext) {
    this.samples.push(copy(sample));
    this.samples = this.samples.slice(-120);
  }

  latest(): InteractionContext | null {
    return this.samples.length ? copy(this.samples[this.samples.length - 1]!) : null;
  }

  stats() {
    return { hits: this.hits, misses: this.misses, samples: this.samples.length };
  }

  /** Epoch milliseconds. A mismatched clock base is the classic 100% miss. */
  bind(
    turnId: string,
    timestamp: number,
    revision: number,
    frameId: string,
  ): { context: InteractionContext } | { miss: 'no_sample' | 'stale_revision' | 'other_frame' } {
    const recent = [...this.samples]
      .reverse()
      .filter((s) => s.timestamp <= timestamp && timestamp - s.timestamp < 1500);
    if (!recent.length) {
      this.misses += 1;
      return { miss: 'no_sample' };
    }
    const sample = recent.find((s) => s.revision === revision && s.frameId === frameId);
    if (!sample) {
      this.misses += 1;
      return { miss: recent.some((s) => s.frameId === frameId) ? 'stale_revision' : 'other_frame' };
    }
    this.hits += 1;
    const bound = { ...copy(sample), turnId };
    this.turns.set(turnId, bound);
    if (this.turns.size > 32) this.turns.delete(this.turns.keys().next().value!);
    return { context: bound };
  }

  /** Selection latches at speech onset; the destination may still move during speech. */
  refreshDestination(turnId: string, destination: InteractionContext['destination']) {
    const existing = this.turns.get(turnId);
    if (existing) this.turns.set(turnId, { ...existing, destination: copy(destination) });
  }

  get(turnId: string) {
    return this.turns.get(turnId) ?? null;
  }

  clear() {
    this.samples = [];
    this.turns.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
