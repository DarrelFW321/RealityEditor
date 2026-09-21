import type { EditResult, InteractionContext, Scp, Vec3 } from '@reality/contracts';
import { buildScp, type ViewState } from '@reality/spatial-engine';
import type { Editor, Intent } from './editor';

/**
 * One owner for selection, destination, turn binding and command execution, shared by
 * hands, touch and voice.
 *
 * Before this, that state lived in React effects inside `EditorPanel`: the hand loop wrote
 * `selected` and `destination` through `setState`, the voice adapter read a mutable
 * `context` ref, and "which object was the user talking about" was whatever the ref held
 * when a network callback happened to arrive. That is fine until a tool call is delayed,
 * at which point it silently acts on the wrong object.
 *
 * Framework-independent on purpose: no React, so the deterministic scenarios can drive it
 * directly with a scripted transport instead of needing a live model or a rendered tree.
 */

export type InputSource = 'hand' | 'touch' | 'voice' | 'system';
export type Destination = InteractionContext['destination'];

/** Monotonic milliseconds since the coordinator was created.
 *
 * Wall-clock time can jump backwards; a session clock cannot. Epoch stays on the wire
 * where the contracts require it — this never replaces `InteractionContext.timestamp`,
 * it sits beside it. */
const defaultClock = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** Selection latches at speech onset; a destination older than this is not trustworthy
 * as "there", because the user has had time to point somewhere else. */
export const DESTINATION_MAX_AGE_MS = 2_000;
/** Continuous targeting that counts as deliberate selection. */
export const DWELL_MS = 500;


export type TurnRecord = {
  turnId: string;
  /** Latched when the turn opened. Never updated afterwards. */
  selectedId: string | null;
  destination: Destination;
  /** Monotonic time the destination was last observed, for the freshness rule. */
  destinationAt: number | null;
  revision: number;
  frameId: string;
  /** The adapter generation that opened the turn. A later generation's work is not ours. */
  generation: number;
  openedAt: number;
  /** The selection was not stable across the utterance, so "that one" could mean
   * either object. Decided when the turn is sealed. */
  ambiguousAtOpen: boolean;
  sealedAt: number | null;
  /** Responses this turn is responsible for. A response belongs to the turn that asked
   * for it, not to whichever turn happens to be open when it arrives. */
  responseIds: Set<string>;
  /** The pending confirmation this turn created, if any. */
  pendingOperationId: string | null;
  /** The layout proposal this turn left waiting on a yes, if any (M7). A proposal is
   * not an engine operation, so it needs its own binding or a delayed "yes" could
   * apply a restyle the user was never shown. */
  pendingProposalId: string | null;
};

export type Resolution =
  | { ok: true; context: InteractionContext }
  | { ok: false; reason: string; code: 'no_turn' | 'stale_destination' | 'ambiguous' | 'stale_revision' | 'wrong_generation' };

export class InputCoordinator {
  private selectedId: string | null = null;
  private destination: Destination = null;
  private destinationAt: number | null = null;
  private turns = new Map<string, TurnRecord>();
  private responseOwner = new Map<string, string>();
  /** Bumped on dispose and on voice restart, so late work can be identified as obsolete. */
  private generation = 0;
  /** Conversational recency, most recent first. Resolves "it" with no geometry. */
  private salienceStack: string[] = [];
  private lastTapAt: number | null = null;
  private lastFloorHit: { point: Vec3; at: number } | null = null;
  /** Supplied by whatever owns the tracked camera; absent in the development room. */
  private view: ViewState | null = null;
  private dwellTarget: string | null = null;
  private dwellSince = 0;
  /** Selection changes near a speech boundary make "that one" ambiguous. */
  private lastSelectionChangeAt = -Infinity;
  private listeners = new Set<() => void>();
  /** State-changing commands run one at a time; see `command`. */
  private queue: Promise<unknown> = Promise.resolve();
  private results = new Map<string, EditResult>();

  /** The clock is injectable because every freshness rule here is time-dependent, and a
   * scenario that proves "older than two seconds is refused" must be able to say so
   * without sleeping for two seconds or reaching into private state. */
  constructor(
    private editor: Editor,
    private now: () => number = defaultClock,
  ) {}

  // ------------------------------------------------------------------ observation

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.listeners.forEach((l) => l());
  }

  getSelection = () => this.selectedId;
  getDestination = () => this.destination;
  getGeneration = () => this.generation;

  /** Selection and destination are independent. Pointing somewhere never reselects. */
  select(id: string | null, source: InputSource = 'system') {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.lastSelectionChangeAt = this.now();
    if (id) {
      // Most recent first, deduplicated, bounded. This is what "move it back" reads.
      this.salienceStack = [id, ...this.salienceStack.filter((x) => x !== id)].slice(0, 6);
      if (source === 'touch') this.lastTapAt = this.now();
    }
    this.publish();
  }

  /** The tracked camera, for the SCP. Without it there is no view to describe. */
  setView(view: ViewState | null) {
    this.view = view;
  }

  point(destination: Destination, _source: InputSource = 'system') {
    this.destination = destination;
    this.destinationAt = destination ? this.now() : null;
    // "Over there" resolves against the last floor point, not the current frame: by the
    // time speech ends the phone has usually moved off the spot.
    if (destination && destination.kind === 'surface')
      this.lastFloorHit = { point: destination.position, at: this.now() };
    this.publish();
  }

  /**
   * The Spatial Context Packet for the current moment.
   *
   * Null without a tracked camera — the development room has no view, and inventing one
   * would hand the model a confident description of a viewpoint that does not exist.
   */
  scp(): Scp | null {
    if (!this.view) return null;
    const at = this.now();
    return buildScp(
      this.editor.engine.getSnapshot().scene,
      this.view,
      {
        salienceStack: this.salienceStack,
        lastTap: { entity: this.lastTapAt === null ? null : this.selectedId, ageMs: this.lastTapAt === null ? 0 : at - this.lastTapAt },
        lastFloorHit: this.lastFloorHit
          ? { point: this.lastFloorHit.point, ageMs: at - this.lastFloorHit.at }
          : { point: null, ageMs: 0 },
      },
    );
  }

  /**
   * Point-and-dwell selection: holding a target for 500ms selects it.
   *
   * Call every frame with what is currently under the pointer. Resets on a target change
   * or on unreliable tracking, so a cursor sweeping across objects never selects one it
   * merely passed over.
   */
  dwell(targetId: string | null, reliable = true) {
    if (!reliable || !targetId) {
      this.dwellTarget = null;
      return false;
    }
    const at = this.now();
    if (this.dwellTarget !== targetId) {
      this.dwellTarget = targetId;
      this.dwellSince = at;
      return false;
    }
    if (at - this.dwellSince < DWELL_MS || this.selectedId === targetId) return false;
    this.select(targetId, 'hand');
    return true;
  }

  /** The live context, for the 10Hz history and for UI. */
  snapshot(turnId = 'live'): InteractionContext {
    const scene = this.editor.engine.getSnapshot().scene;
    return {
      turnId,
      clock: 'epoch',
      timestamp: Date.now(),
      revision: scene.revision,
      frameId: scene.frameId,
      selectedId: this.selectedId,
      destination: this.destination,
      // Carried so a mask box can be placed with nothing selected and nothing pointed
      // at. Null in the development room, where there is no tracked camera.
      viewer: this.view
        ? { position: [...this.view.position], forward: [...this.view.forward] }
        : null,
    };
  }

  /**
   * The mask boxes, for the model to refer to by id.
   *
   * They are not scene objects, so they appear in neither the object list nor the
   * spatial context — which left the assistant unable to name the box it had just
   * placed, and reporting that it had no target id for it.
   */
  masks() {
    return this.editor.engine.getSnapshot().scene.maskVolumes.map((v) => ({
      id: v.id,
      hidden: v.hidden,
      size_m: v.size.map((n) => Number(n.toFixed(2))),
    }));
  }

  /** Pushes a sample into attention history. Called on a timer, not only on change, so a
   * stationary selection still has a sample to bind against. */
  sample() {
    this.editor.attention.push(this.snapshot());
  }

  // ------------------------------------------------------------------ turns

  /** Opens a turn and LATCHES the selection at that instant. */
  openTurn(turnId: string): TurnRecord {
    const record: TurnRecord = {
      turnId,
      selectedId: this.selectedId,
      destination: this.destination,
      destinationAt: this.destinationAt,
      revision: this.editor.engine.getSnapshot().scene.revision,
      frameId: this.editor.engine.getSnapshot().scene.frameId,
      generation: this.generation,
      openedAt: this.now(),
      ambiguousAtOpen: false,
      sealedAt: null,
      responseIds: new Set(),
      pendingOperationId: null,
      pendingProposalId: null,
    };
    this.turns.set(turnId, record);
    // Bounded, and oldest-first so a long session cannot grow without limit.
    if (this.turns.size > 32) this.turns.delete(this.turns.keys().next().value!);
    return record;
  }

  /** Seals the destination at turn end. After this the record is immutable. */
  sealTurn(turnId: string) {
    const record = this.turns.get(turnId);
    if (!record || record.sealedAt !== null) return;
    record.destination = this.destination;
    record.destinationAt = this.destinationAt;
    // AMBIGUOUS MEANS THE SELECTION MOVED WHILE THEY WERE TALKING.
    //
    // Not "the selection changed recently" — pointing at a thing and then talking about
    // it is the normal flow, and treating that as ambiguous refuses every ordinary
    // command. The genuine ambiguity is a selection that did not hold across the
    // utterance: "move that one" then has two candidate referents and guessing between
    // them is exactly what this milestone forbids.
    record.ambiguousAtOpen = record.selectedId !== null && this.selectedId !== record.selectedId;
    record.sealedAt = this.now();
  }

  /**
   * Binds a response to the turn that ASKED for it.
   *
   * The previous implementation mapped `response.created` to whichever speech turn was
   * current when the event arrived. Speak, pause, speak again, and a slow first response
   * would be recorded against the second turn — then act on the second turn's selection.
   * The caller passes the turn it requested the response for; nothing here reads "current".
   */
  attachResponse(turnId: string, responseId: string) {
    const record = this.turns.get(turnId);
    if (!record) return;
    record.responseIds.add(responseId);
    this.responseOwner.set(responseId, turnId);
    if (this.responseOwner.size > 64)
      this.responseOwner.delete(this.responseOwner.keys().next().value!);
  }

  turnForResponse(responseId: string): TurnRecord | null {
    const turnId = this.responseOwner.get(responseId);
    return turnId ? (this.turns.get(turnId) ?? null) : null;
  }

  /**
   * The context a command from this turn must act on, or why it cannot.
   *
   * Every refusal is actionable: the PRD requires a clarification rather than a guess, and
   * silently rebasing a positional command onto the current selection is exactly the
   * failure this whole milestone exists to prevent.
   */
  resolve(turnId: string, needsDestination: boolean): Resolution {
    const record = this.turns.get(turnId);
    if (!record) return { ok: false, code: 'no_turn', reason: 'I lost track of that request. Please say it again.' };
    if (record.generation !== this.generation)
      return { ok: false, code: 'wrong_generation', reason: 'Voice restarted while that was in flight. Please repeat it.' };

    const scene = this.editor.engine.getSnapshot().scene;
    if (scene.frameId !== record.frameId)
      return { ok: false, code: 'stale_revision', reason: 'The room was re-measured. Please repeat that.' };

    // AMBIGUITY IS DECIDED WHEN THE TURN OPENS, NOT WHEN IT RESOLVES.
    //
    // The question is whether the user changed their mind *as they started speaking* —
    // then "that one" could mean either object and asking is the only honest answer. A
    // selection change AFTER the turn was sealed is not ambiguous at all; it is exactly
    // the case latching exists to handle, and treating it as ambiguous refused every
    // delayed tool call that this milestone is meant to make work.
    if (record.ambiguousAtOpen)
      return {
        ok: false,
        code: 'ambiguous',
        reason: 'The selection changed as you spoke. Which object did you mean?',
      };

    if (needsDestination) {
      if (!record.destination || record.destinationAt === null)
        return { ok: false, code: 'stale_destination', reason: 'Point at where you want it, then say that again.' };
      const age = (record.sealedAt ?? this.now()) - record.destinationAt;
      if (age > DESTINATION_MAX_AGE_MS)
        return {
          ok: false,
          code: 'stale_destination',
          reason: 'That was a while ago. Point again and repeat it.',
        };
    }

    return {
      ok: true,
      context: {
        turnId: record.turnId,
        clock: 'epoch',
        timestamp: Date.now(),
        revision: record.revision,
        frameId: record.frameId,
        selectedId: record.selectedId,
        destination: record.destination,
        // Same viewer pose the live snapshot carries, so a turn-bound command can
        // place a mask box with nothing identified.
        viewer: this.view
          ? { position: [...this.view.position], forward: [...this.view.forward] }
          : null,
      },
    };
  }

  // ------------------------------------------------------------------ commands

  /**
   * Executes one command, serialized against every other.
   *
   * Two tool calls arriving together used to run concurrently against the same engine.
   * The engine is the only writer of committed state and it is not reentrant: interleaved
   * transactions could each read the pre-edit revision and each believe they were current.
   *
   * `callId` makes it idempotent. A duplicate delivery returns the ORIGINAL result without
   * executing anything, which is what the provider retry semantics require.
   */
  async command(
    intent: Intent | unknown,
    options: { turnId?: string; callId?: string; source?: InputSource } = {},
  ): Promise<EditResult> {
    const { turnId, callId } = options;
    if (callId && this.results.has(callId)) return this.results.get(callId)!;
    const generation = this.generation;

    const run = this.queue.then(async (): Promise<EditResult> => {
      if (generation !== this.generation) return this.refuse('That request is no longer current.');
      const needsDestination =
        typeof intent === 'object' &&
        intent !== null &&
        (intent as Intent).action === 'move' &&
        !(intent as Intent).target_id === false;

      let context: InteractionContext;
      if (turnId) {
        const resolved = this.resolve(turnId, (intent as Intent)?.action === 'move');
        if (!resolved.ok) return this.refuse(resolved.reason);
        context = resolved.context;
      } else {
        context = this.snapshot();
      }
      void needsDestination;
      // Attribute the commit before it happens, so the op log records which utterance
      // or which tap caused it rather than claiming every edit came from the system.
      this.editor.engine.attribute({
        turnId: turnId ?? null,
        source: options.source === 'voice' ? 'voice' : options.source === 'system' ? 'system' : 'tap',
      });
      const result = await this.editor.intent(intent, context);
      this.editor.engine.attribute({ turnId: null, source: 'system' });
      // An action that resolved a target ADOPTS it as the selection. `select` and
      // `mask_area` both return one and this was dropping it, so "select the chair"
      // selected nothing and a freshly placed mask box could not be referred to as
      // "it" on the next turn.
      const resolved = (result as { selectedId?: string }).selectedId;
      if (typeof resolved === 'string' && resolved) this.select(resolved, options.source ?? 'system');
      // A confirmation belongs to the operation that asked for it, so remember which one
      // this turn is waiting on.
      if (turnId && result.refusal === 'awaiting_confirmation') {
        const record = this.turns.get(turnId);
        const pending = this.editor.engine.getSnapshot().pending;
        if (record && pending) record.pendingOperationId = pending.operationId;
        const proposal = this.editor.pendingProposal();
        if (record && proposal) record.pendingProposalId = proposal.proposalId;
      }
      return result;
    });

    this.queue = run.catch(() => undefined);
    const result = await run;
    if (callId) {
      this.results.set(callId, result);
      if (this.results.size > 64) this.results.delete(this.results.keys().next().value!);
    }
    return result;
  }

  /**
   * A whole-arrangement request, serialized against every other writer (M7.6).
   *
   * Shares `command`'s queue and idempotency cache rather than having its own: a
   * restyle and a simple edit are both writes to the one engine, and two queues would
   * be two writers with no ordering between them.
   */
  /**
   * A hard-coded design, run on the same queue as everything else.
   *
   * Delegates to `restyle`'s machinery by construction: same queue, same idempotency
   * cache, same turn resolution. A design is many writes to the one engine, so it must
   * not be a second writer racing the first.
   */
  async design(
    choice: unknown,
    options: { turnId?: string; callId?: string; source?: InputSource } = {},
    onStage?: (stage: string) => void,
  ): Promise<EditResult> {
    return this.runPlanned((recipeInput, context, stage) =>
      this.editor.agentChoice(recipeInput, context, undefined, stage), choice, options, onStage);
  }

  async restyle(
    recipe: unknown,
    options: { turnId?: string; callId?: string; source?: InputSource } = {},
    onStage?: (stage: string) => void,
  ): Promise<EditResult> {
    return this.runPlanned((recipeInput, context, stage) =>
      this.editor.restyle(recipeInput, context, undefined, stage), recipe, options, onStage);
  }

  private async runPlanned(
    execute: (
      input: unknown,
      context: InteractionContext,
      onStage?: (stage: string) => void,
    ) => Promise<EditResult>,
    recipe: unknown,
    options: { turnId?: string; callId?: string; source?: InputSource } = {},
    onStage?: (stage: string) => void,
  ): Promise<EditResult> {
    const { turnId, callId } = options;
    if (callId && this.results.has(callId)) return this.results.get(callId)!;
    const generation = this.generation;

    const run = this.queue.then(async (): Promise<EditResult> => {
      if (generation !== this.generation) return this.refuse('That request is no longer current.');
      let context: InteractionContext;
      if (turnId) {
        const resolved = this.resolve(turnId, false);
        if (!resolved.ok) return this.refuse(resolved.reason);
        context = resolved.context;
      } else {
        context = this.snapshot();
      }
      this.editor.engine.attribute({
        turnId: turnId ?? null,
        source: options.source === 'voice' ? 'voice' : options.source === 'system' ? 'system' : 'tap',
      });
      const result = await execute(recipe, context, onStage);
      this.editor.engine.attribute({ turnId: null, source: 'system' });
      if (turnId && result.refusal === 'awaiting_confirmation') {
        const record = this.turns.get(turnId);
        const proposal = this.editor.pendingProposal();
        if (record && proposal) record.pendingProposalId = proposal.proposalId;
      }
      return result;
    });

    this.queue = run.catch(() => undefined);
    const result = await run;
    if (callId) {
      this.results.set(callId, result);
      if (this.results.size > 64) this.results.delete(this.results.keys().next().value!);
    }
    return result;
  }

  /**
   * Confirms the operation THIS TURN created, never whatever is pending now.
   *
   * A delayed "yes" must not approve an edit the user has not seen. The engine already
   * keys confirmation by operation id; this is what supplies the right one.
   */
  async confirm(turnId?: string): Promise<EditResult> {
    // A parked layout proposal is checked first and bound the same way. It is not an
    // engine operation, so `engine.pending` says nothing about it, and falling through
    // would answer "there is nothing waiting to confirm" to a user looking at a
    // proposal the assistant just described.
    const proposal = this.editor.pendingProposal();
    if (proposal) {
      if (turnId) {
        const record = this.turns.get(turnId);
        if (!record?.pendingProposalId)
          return this.refuse('I am not sure what you are confirming. Please repeat it.');
        if (record.pendingProposalId !== proposal.proposalId)
          return this.refuse('That confirmation was for an earlier arrangement. Please repeat it.');
      }
      return this.editor.intent({ action: 'confirm' }, this.snapshot());
    }
    const pending = this.editor.engine.getSnapshot().pending;
    if (!pending) return this.refuse('There is nothing waiting to confirm.');
    if (turnId) {
      const record = this.turns.get(turnId);
      if (!record?.pendingOperationId)
        return this.refuse('I am not sure what you are confirming. Please repeat the edit.');
      if (record.pendingOperationId !== pending.operationId)
        return this.refuse('That confirmation was for an earlier edit. Please repeat it.');
    }
    return this.editor.engine.confirm(pending.operationId);
  }

  private refuse(message: string): EditResult {
    return {
      status: 'rejected',
      message,
      report: null,
      refusal: 'stale_revision',
      caveats: [],
      conflicts: [],
      revision: this.editor.engine.getSnapshot().scene.revision,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Invalidates every in-flight turn. Late work from before this point cannot commit. */
  invalidate() {
    this.generation += 1;
    this.turns.clear();
    this.responseOwner.clear();
  }

  dispose() {
    this.invalidate();
    this.results.clear();
    this.listeners.clear();
    this.selectedId = null;
    this.destination = null;
  }
}
