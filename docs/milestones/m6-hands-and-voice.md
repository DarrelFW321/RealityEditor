# M6 — Coordinated hands, touch, and voice

Status: implemented locally; device acceptance remains open. Written 2026-09-19, implemented 2026-09-19.

References: [shared milestone baseline](../implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), [product requirements](../prd-expo-migration.md), [implementation status](../expo-implementation-status.md).

## Goal and required end state

Make all supported inputs operate one predictable editor. A user can select an object, point somewhere else, and speak; delayed tool calls must still act on the intended object and destination.

At completion, the existing editing actions work through hands/touch and voice, concurrent inputs share one manipulation transaction, and stale or interrupted work cannot change the room unexpectedly. The UI clearly distinguishes the selected object from the destination.

Dependencies: accepted M5 baseline and the existing M2–M4 command, carry, calibration, and tracking interfaces. M7 will build recipe tools on this input coordination. M8's native texture feasibility work may proceed independently.

## Starting state and implementation boundaries

Already present: hand raycasting, pinch/carry/release, attention history, Realtime WebRTC tools, lifecycle adapters, and a local transaction engine.

Remaining gaps:

- Voice handling relies on a mutable current speech turn; response association needs explicit ownership.
- Destination age, selection ambiguity, and confirmation identity need defined behavior.
- Context needs a maintained scene summary, not only selected and destination IDs.
- Commits clear occupancy instead of rebuilding it; spatial relationships also need recomputation.
- Delayed events, concurrent input, and disposal need integrated acceptance evidence.

Primary integration points are the [editor composition](../../mobile/src/runtime/editor.ts), [editor panel](../../mobile/src/components/EditorPanel.tsx), [voice adapter](../../mobile/src/adapters/realtime.ts), [spatial engine](../../packages/spatial-engine/src/index.ts), and [session contracts](../../packages/contracts/src/session.ts).

Do not introduce another conversational model, continuous voice-camera upload, an audio-routing UI, or new reconstruction work in M6.

## Ordered implementation plan

### M6.1 — Extract one input coordinator

1. Move ownership of selection, destination, active manipulation, pending confirmation, and turn binding out of UI component effects into an input coordinator.
2. Route hand, touch, and voice actions through the coordinator. It invokes the engine; it does not write committed scene state itself.
3. Keep selected entity and destination as independent references. Pointing at a destination never changes selection by itself.
4. Show distinct selected-object and destination highlights before resolving ambiguous requests.
5. Add point-and-dwell selection: 500 ms continuously targeting the same entity, resetting on target change or unreliable tracking. Keep tap and pinch selection available.

Deliverable: a framework-independent coordination interface that the panel, hand adapter, and voice adapter consume.

### M6.2 — Establish timestamped interaction history

1. Maintain bounded local context history at 10 Hz on a session monotonic clock, including when a stationary selection has not changed.
2. Record native capture time separately from callback arrival time. Convert clocks explicitly at adapter boundaries.
3. Preserve epoch timestamps where existing wire contracts require them. Do not silently change the meaning of an existing timestamp field.
4. Record voice-boundary arrival time separately from provider timing metadata. Do not describe network arrival as the actual moment the user began or stopped speaking.
5. Latch selection when the speech-start event is handled; seal the destination when the turn ends. Retain the most recent valid destination for at most two seconds.
6. If there is no fresh destination, ask the user to point again. If selection changed around an uncertain speech boundary, ask which object was intended instead of guessing.

Deliverable: timestamped samples whose freshness is based on observation time, and immutable context snapshots for completed turns.

### M6.3 — Correlate turns, responses, and confirmations

1. Give every turn a record containing input-item ID, session/frame identity, revision, adapter generation, latched selection, and sealed destination.
2. Associate response and tool-call IDs with the originating turn explicitly. Never associate a late response with whichever speech turn is currently active.
3. Keep sealed context immutable while network work completes.
4. Reject stale scene revisions with an actionable explanation; do not silently rebase positional commands.
5. Bind confirmation to a specific pending operation ID. A delayed confirmation must not approve a newer pending edit.
6. Cache the original result for a duplicate tool-call ID and return that result without executing the command again.

Deliverable: deterministic turn-to-command resolution under delay, duplication, and event reordering.

### M6.4 — Rebuild derived scene context

1. Rebuild the fixed 5 cm floor occupancy grid after commit, undo, and structural edits. Its run lengths must sum to the grid's cell count, including empty-room states.
2. Derive supported spatial relations from current geometry and explicit support relationships. Remove relations whose entities no longer exist.
3. Keep proposed-design occupancy distinct from retained observed physical obstacles. Visual removal must not make physical space appear clear.
4. Implement the existing supported relation predicates. Leave `blocks` unemitted until a circulation model exists; retain the current clearance notes.
5. Build an SCP containing candidates, recent attention, and free-space information. Keep its serialized size below 2 KB by bounding candidate lists.
6. Update local context at 10 Hz. Send sealed context at voice-turn boundaries and updated context before subsequent tool reasoning; no continuous raw camera stream is added.

Deliverable: geometry-derived occupancy, relations, and compact voice context that agree with the committed revision.

### M6.5 — Complete input parity and shared transactions

1. Add voice selection, cancellation, and confirmation, plus a voice equivalent for every editing action already exposed manually.
2. Resolve named targets against actual scene entities and available descriptions. An invented ID or ambiguous name must not select an arbitrary object.
3. Route voice color, rotation, and resize changes for a held object into that object's active manipulation transaction.
4. Route a voice move of the held object through the existing release and settling path.
5. Refuse edits to another object during a grab until the current manipulation ends. Do not create a competing scene writer.
6. Preserve one undo operation for a completed combined manipulation. Intermediate frames and preview-only voice changes do not become separate commits.

Deliverable: identical command semantics across input sources, including concurrent hand and voice use.

### M6.6 — Harden interruption and lifecycle behavior

1. Serialize state-changing tool execution.
2. Reject unfinished commands from cancelled responses or disposed adapter generations.
3. Preserve already committed edits when the user interrupts speech; undo remains explicit.
4. Cancel positional previews and prevent positional commits during tracking loss.
5. Release subscriptions, microphone tracks, peer connections, timers, and pending callbacks on disposal.
6. Surface permission denial, connection failure, backgrounding, and reconnect as specific states. The committed scene remains usable when voice is unavailable.

Deliverable: interruption and reconnect behavior that cannot publish obsolete work.

## Public interfaces and compatibility

- Add an input-coordination interface between UI/input adapters and the engine.
- Extend session-level interaction records with source/arrival timing, destination age, turn/response/tool correlation, generation, and pending-operation identity.
- Extend typed diagnostics with correlation IDs and timing fields, without arbitrary transcript/media payloads.
- Keep native and provider-specific event shapes inside their adapters.
- Keep generated scene wire contracts generated. Reuse the existing RSG occupancy/relation and SCP fields; do not hand-edit generated bindings.
- Preserve existing wire timestamp semantics, adding explicit internal monotonic timing rather than reinterpreting epoch fields.

## Verification and acceptance scenarios

Extend the existing scenario runner and development Modules view with M6 cases. Exercise transport behavior through a scripted adapter using the same coordinator; do not depend on a live model for deterministic event-order scenarios.

| Scenario | Required result |
|---|---|
| Select chair A, point at floor, speak, then point at chair B while the tool is delayed | Only A moves, using the sealed floor destination |
| Destination older than two seconds | Clarification; no positional commit |
| Selection changes around an uncertain speech boundary | Clarification identifies the ambiguity; no guessed edit |
| Two responses arrive out of order | Each uses its own originating turn or is rejected as stale |
| A delayed confirmation follows a newer pending operation | It cannot confirm the newer operation |
| Carry an object, recolor by voice, release, undo | One undo restores original pose and appearance |
| Deliver one tool call twice | One commit; the original result is returned again |
| Cancel speech or dispose the adapter while a tool is pending | Obsolete work cannot commit |
| Move, resize, remove, and undo | Occupancy and relations match each committed state |
| Deny microphone permission or disconnect voice | Specific status; the editor remains usable |
| Lose tracking or background during a grab | Preview rolls back; positional edits wait for reliable tracking |

Run workspace TypeScript checks, existing milestone gates, and the iOS JavaScript bundle check after implementation. Hardware acceptance must cover audio, fingertip alignment, delayed tools, combined inputs, and background/resume in the same native build.

Record speech-boundary, command, first-visible-edit, and settled-commit timing separately. M9 applies the end-to-end release latency gate.

## Completion checklist

### Implementation

- [x] Selection and destination are independent and visibly identifiable.
- [x] Hands/touch and voice consume the same input coordinator.
- [x] Turn snapshots are immutable and response association is explicit.
- [x] Stale, ambiguous, duplicate, and cancelled commands behave deterministically.
- [x] Confirmation identifies the intended pending operation.
- [x] Every existing manual editing action has a voice equivalent.
- [x] Combined input produces one undoable manipulation transaction.
- [x] Occupancy, relations, and SCP reflect committed geometry. The packet is built from
      the committed grid, bounded to the schema's caps, and sent with the sealed context
      at each turn boundary.
- [x] Permission, tracking, interruption, and reconnect states are implemented and named
      separately, each saying the room is unaffected.

### Verification and end-state evidence

- [x] Existing checks and the M6 development scenarios pass — app gate 33/33 (8 new M6
      scenarios), server gate 9/9, worker self-test, workspace typecheck, iOS JS bundle.
- [ ] Physical-device pointing, audio, and concurrent-input demonstrations pass.
- [x] Late callbacks cannot commit after cancellation or disposal (`input-lifecycle`).
- [x] Turn/generation/target diagnostics emitted; no transcript or media is recorded.
- [x] Limitations recorded below.

## Completion evidence record

- Implementation commit: **pending commit** at time of writing; see the M6 section of
  [implementation status](../expo-implementation-status.md).
- Local commands and scenario results: `npm run typecheck` clean; `npm run gate` →
  **33/33** app, **9/9** server, worker self-test PASS; `npx expo export --platform ios
  --no-bytecode` succeeds.
- Device model, OS, native build, and lockfile hash: **not recorded** — no device run.
- Active adapter IDs and voice configuration: `openai-realtime-webrtc`; unchanged
  `server_vad` with `create_response: false`, `interrupt_response: true`.
- Device demonstration and sanitized diagnostics location: **not recorded**.
- Measured timings, failures, and limitations: no live-model timings taken. SCP measures
  **1170-1382 bytes** against the 2KB budget on the sample room. Limitations: hardware
  acceptance for audio, fingertip alignment, delayed tools, combined input and
  background/resume is outstanding; occlusion in `visible_entities` is inferred from the
  crosshair ray rather than a depth buffer; `blocks` stays unemitted pending a
  circulation model.
- Acceptance date and reviewer: **not recorded**.
