# Expo implementation status

Implementation started 2026-09-18. This is a working migration foundation, not a completed release. No automated testing workstream or test packages were added.

Planning update, 2026-09-19: the project owner confirmed **M5 complete**. The remaining work is specified in the [M6–M9 implementation plans](implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), each with an ordered implementation sequence, acceptance scenarios, and completion checklist. The target is an internal release candidate, with a 30 FPS minimum for live compositing. Earlier evidence sections below describe the state when they were written; this documentation update adds no new verification claims.

## Implemented code

- npm workspace with pinned Expo SDK 57, Vision Camera 5, R3F, WebRTC and compatible React Native dependencies; one root lockfile.
- Shared generated RSG/Op/SCP/ConstraintReport contracts, preserving the server compatibility import. Added frame/shelf classes to the source schema and regenerated Swift and TypeScript.
- Versioned Expo session envelopes, adapter ports, diagnostic events, lifecycle ownership and a development sample room.
- Local transaction engine: selection, move preview, free carrying, live drop validity, validated drop, upright gravity settling, cancellation, stale-operation rejection, duplicate-operation protection and undo.
- Compound box collision queries, room-boundary/opening checks, retained physical-obstacle handling and explicit construction uncertainty.
- Parameterized table, bed, cabinet, shelf and frame assemblies used for both rendering and collisions. Multi-object additions are atomic.
- Expo editor with touch controls, voice tool integration and a development command/diagnostics panel.
- Single-turn RoomPlan/ARKit calibration with pose-derived coverage, targeted extra-view prompts, confidence- and coverage-driven measured/inferred provenance, and retained partial results on failure. Native code exports room surfaces, tracked camera matrices and Apple Vision hand cursor/pinch samples.
- Fastify `/voice/session` compatibility alias, calibration sessions, bounded aligned-frame upload, asynchronous job lifecycle, scoped artifacts, cancellation and expiry. Cloud inference runs through a replaceable external worker adapter, and the mobile client now drives the whole round trip.

## Milestone assessment

| Milestone | State | Remaining work |
|---|---|---|
| M0 Foundation | Implemented; JS checks pass | Demonstrate development binary on hardware |
| M1 Native feasibility | Reworked after the first device run exposed missing behavior; local checks pass | Build this revision and repeat the complete [M1 physical-device gate](m1-native-feasibility.md) |
| M2 Spatial engine | Implemented; gate scenarios pass locally | Relation and occupancy recomputation (M6), `APPLY_STYLE` expansion (M7), device demonstration |
| M3 Carry/release | Implemented; gate scenarios pass locally | Device demonstration |
| M4 Calibration | Implemented; gate scenarios pass locally against replayed captures | Device captures; non-LiDAR capture route; multiroom handling |
| M5 Reconstruction | Complete per project-owner confirmation, 2026-09-19 | Accepted baseline for M6–M9; historical evidence below is retained |
| [M6 Hands/voice](milestones/m6-hands-and-voice.md) | Implemented; 34/34 app gate including 9 M6 scenarios | Device acceptance: audio, fingertip alignment, delayed tools, combined input, background/resume |
| [M7 Creation/restyle](milestones/m7-creation-and-restyling.md) | Procedural additions and basic edits implemented; detailed plan available | Whole-layout search, stable groups, construction validation, and atomic scene/visibility transactions |
| [M8 Compositing](milestones/m8-live-compositing.md) | Not implemented; detailed plan available | Native texture bridge, selective pixel replacement, foreground/depth handling, and sustained 30 FPS |
| [M9 Internal release](milestones/m9-internal-release-candidate.md) | Not ready; detailed plan available | Integrated acceptance, supported-device evidence, staging operation, performance, and rollback |

## M2 spatial engine

Implemented against the milestone's four open items, with **no change to
`contracts/schema/`** — every construct needed already existed, so `codegen.sh`,
`Generated/Contracts.swift` and the checked-in fixtures are untouched and no new native
binary is required.

- `ConstraintReport` is now the engine's result payload. `EditResult` carries it alongside a
  typed `refusal`, `caveats`, and the existing human-readable `conflicts` strings. The
  `adjusted` status, typed violations, soft notes and ranked alternatives are all reachable for
  the first time; those four generated schemas previously had no TypeScript consumer.
- `evaluatePlacement` replaces the flat string list with typed `ViolationResolved` and
  `RemainingNote`. Hard constraints reject; `Clearances` shortfalls only annotate, as
  `Clearances.swift` requires. `validatePlacement` remains as a compatibility shim.
- Real door-swing arcs, ported from `Surface.swingArcPolygon`. Where a scan supplies no swing —
  which is every device-captured door today — the conservative box is kept and the report
  records that the swing is unverified rather than claiming clearance.
- Mounted support now uses the yaw-correct half-depth along the wall normal, checks wall-polygon
  containment and opening overlap, and emits `blocks_window`. Wall normals and floor-polygon
  winding are normalised inside `buildIndex` at read time, so `roomToSession` is unchanged.
- Object-on-object support requires an explicitly named, compatible support plus a declared
  bearing region. Geometry follows Swift; the policy follows the PRD, so a bed is never stacked
  on a desk and settling never promotes an object onto whatever happens to lie beneath it.
- A bounded nudge search produces `adjusted` with a narratable reason, or `rejected` with up to
  three ranked alternatives. An adjustment of 5cm or more is held for confirmation and commits
  under its original operation id, so a retried tool call cannot double-apply.
- Structural edits (`offset_wall`, `ceiling_height`, `resize_opening`) apply to `design` only;
  `measured` is typed `DeepReadonly`, so the compiler rejects any write to observation. A change
  that invalidates furniture is refused whole and the revision does not advance.
- Operation parity: `replace`, `material` and `structure` added, with inverses computed before
  the mutation. `yaw_delta` resolves to an absolute before the inverse is taken, cosmetic colour
  is separated from structural material, and `blocks_window` is emitted.

### Deliberate divergences from the Swift engine

- `MODIFY_WALL` / `MODIFY_FLOOR` carry `params.surface` forward, a field the schema documents as
  inverse-only. No schema change; the op vocabulary stays at twelve.
- Stacking stability additionally requires 60% of the footprint over the bearing. Swift tests the
  centre alone, which passes an object hanging most of the way off.
- `construction: 'unknown'` is a caveat, not a violation. Previously it was set and then treated
  as a hard error, which made the flag unreachable and permanently rejected three-legged beds and
  every oversized recipe.
- `blocks_walkway` and the `blocks` relation stay unemitted, matching Swift. A walkway needs a
  circulation graph this project does not have, and its honest form is already the soft
  `circulation` note.
- Scenario rooms with a built-in object live in `packages/dev-scenarios` as code rather than as a
  new RSG fixture. An RSG fixture is the measured room; regenerating one risks perturbing
  `bedroom_4x4.rsg.json`, which the Swift tests reference byte-for-byte.

### Known issues logged in M2, fixed in M3

- Backgrounding called `setTracking(false)`, but the resume branch re-enabled only when there was
  no tracked frame, so a real AR session stayed paused until the panel remounted. Resume now reads
  the session's own tracking state.
- `AdapterSlot.dispose` stopped a starting adapter before awaiting its queue, so a fast
  background/foreground/unmount could dispose twice. It now awaits the queue first, leaving
  exactly one owner to clean up.

## Verification performed here

Workspace TypeScript checks, Expo iOS JavaScript export, generated-contract consistency, and the existing Swift SpatialCore build passed. Expo autolinking discovers `SpatialCaptureModule`. The Swift core build also confirms the new frame/shelf enum cases preserve its exhaustive switches. These checks do not compile the native Expo capture module or demonstrate camera/audio/hand behavior.

M1 now includes a DeviceMotion-guided six-view 300° Vision Camera sweep with manual fallback and automatic continuation, an explicit stopped/unmounted handoff before RoomPlan mounts, native acquisition events, an automatically finalizing 270° RoomPlan measurement with an always-available manual finish, and an explicitly tagged inferred-floor fallback when furniture prevents RoomPlan from finalizing a floor. It also includes viewport/orientation metadata, frame freshness/cadence checks, R3F render FPS, fixed world-space alignment markers, tracking-loss gating, confidence-gated and smoothed fingertip tracking, scale-independent pinch hysteresis, and a documented device evidence procedure. See the [M1 feasibility record](m1-native-feasibility.md). These changes require another device run; local checks cannot establish visual alignment or camera ownership on hardware.

This machine now has a full Xcode 27.0 installation (build 27A266a) with CocoaPods 1.16.2, not
only Command Line Tools as earlier revisions of this document stated. `mobile/ios` has since
been regenerated: all 228 Pods `.xcconfig` files resolve against the current repository path,
and `ExpoSensors` is linked. No physical-device build, model call, image upload or cloud
deployment was performed as part of M3. No existing tests were removed or run.

### M2 evidence

Workspace TypeScript, the Expo iOS Hermes export (1881 modules) and `swift build` in
`ios/SpatialCore` all pass. No file under `contracts/schema/`, `contracts/fixtures/`,
`Generated/` or `packages/contracts/src/generated.ts` was modified, so fixture validation and
codegen drift cannot have regressed; `python3 tools/validate_fixtures.py` and
`contracts/codegen.sh --check` could not run on this machine (no `jsonschema` module, and an
npm cache permission fault) and should be run in CI.

The five gate behaviours run from **Modules → Run M2 gate** in the development room, and all
pass: valid placement; a door-swing conflict adjusted with *"the door needs 86cm to swing
open"* and an out-of-room drop rejected with two alternatives; a small item resting on a named
table while a bed is refused with `incompatible_support`; a wall move that traps the desk
refused whole with the revision unchanged, then a valid move and an undo that restores the
design byte-for-byte; and stale, duplicate and immovable refusals. Repeating the overlap
scenario three times produces identical output.

Measured on this machine, not on device: `buildIndex` 0.03 ms, a stop-at-first placement check
0.003 ms, a full check with soft notes 0.02 ms, the door-arc nudge 3 ms, and an exhaustive
30-ring search 7 ms against its 120 ms deadline. The settling loop now issues one `sweepDown`
query per drop instead of a placement evaluation per substep.

## M3 carry and release

The `committed → held → resolving → settling → committed` state machine was already in place
from M2. M3 made it demonstrable, closed the three normative requirements that had no
implementation, and fixed the two lifecycle bugs M2 logged.

- **A gate suite that drives the carry path directly.** The M2 scenarios go through
  `editor.intent`; carrying is only reachable through `engine.begin/preview/release/confirm/
  cancel/setTracking`, so eight new scenarios call those. They run from **Modules → Run M3
  gate** in the development room and headlessly with `npm run gate`.
- **Live drop validity.** `preview()` now publishes `previewValidity` alongside the pose, so a
  held object says why it could not be released where it currently is. It evaluates only
  `bounds`, `intersection` and `doors`: no support is chosen until release, so asking about one
  while held would report every mid-air pose as floating and turn an advisory query into a
  permanent red light. Carrying is never obstructed by the answer, which the `carry-free`
  scenario asserts leg by leg.
- **The carry lifecycle is recorded.** `stage: 'carry'` events cover `held`, `regrabbed`,
  `resolving`, `settling`, `settled`, `committed`, `cancelled`, `support_rejected` and four
  distinct `restored_*` reasons, with `durationMs` on the settle. Before this a whole carry
  emitted two events and neither was a transition, so "distinguish allowed carry-time overlap
  from invalid committed overlap" was not observable. `DiagnosticEvent` gained an optional
  `targetId`; the no-arbitrary-payload rule is unchanged, since an entity id is not free text.
- **General support contacts.** `bearing` was only ever produced by `scene-recipes`, so every
  measured object had none and `resolveSupport` refused all of them: nothing could be placed on
  a scanned table, in any real room. `bearingFor` returns the declared bearing when there is one
  and otherwise derives an inset top face for classes that can bear load, using the identical
  formula `buildObject` uses. A derived bearing adds a caveat naming itself as derived, so it is
  never narrated as measured.
- **Stability.** Floor-edge overhang was already `out_of_bounds` and tip-over off another object
  was already the centre-inside plus 60%-coverage rule; measurement confirmed both. The gap was
  slenderness, so a new `stability` aspect emits a caveat above a 4:1 height-to-base ratio. A
  caveat, not a violation: M2 records that promoting a construction signal to a hard error is
  what made `construction: 'unknown'` unreachable.

### A bug the new gate found

`confirm()` re-derived the support surface from `assemblies[id].support.surfaceId`. A scanned
object has no assembly, so that resolved to `''` and every confirmed adjustment of real furniture
was refused with "that support is no longer there". The M2 overlap scenario cancels its pending
adjustment instead of confirming it, so the path had no coverage. The resolved support is now
carried on `pending` from the release that parked it.

### Deliberate non-goals

- **Angular rigid-body dynamics.** `FloorSettlingAdapter` stays an upright gravity baseline.
  Rapier's JavaScript distribution is WebAssembly with no established React Native/Hermes
  support, and that decision is recorded in the [M1 feasibility record](m1-native-feasibility.md).
  The replacement seam is one interface, `SettlingAdapter`, injected through
  `EditorModules.createSettling`. Tipping is reported as a caveat, never simulated.
- **Derived bearings are inferred, not measured.** A scan gives a bounding box and a category,
  never a load rating. The class list is deliberately short; omitting a surface costs a refusal,
  while a wrong inclusion would invent capacity the scan never observed.
- **Relation and occupancy recomputation** were deferred to M6 and are now implemented;
  see the M6 section below.

### M3 evidence

Measured on this machine, not on device. `npm run gate` reports **15/15**: the five M2
scenarios, the eight M3 scenarios, and two determinism checks.

The eight M3 scenarios and what each proves:

| Scenario | Gate clause |
|---|---|
| Carry through objects and the doorway | carry through doorway/objects |
| A valid release settles under gravity | valid release settles |
| An invalid release restores the original pose | invalid release restores |
| A lateral adjustment is confirmed, not slipped in | ask before a lateral alternative |
| One move yields one undo | one move yields one undo |
| No unintended stacking | no unintended stacking |
| Re-grab cancels settling; tracking loss rolls back | re-grab cancels settling; tracking loss rolls back |
| A voice move uses the same carry path | apply the same behavior to voice moves |

Numbers behind the claims:

- A 0.9 m drop settles in **444 ms** of wall clock and lands at exactly `y=0`, with every other
  object's pose byte-identical before and after.
- `engine.preview()` including the validity query costs **0.012 ms**, about **0.1%** of a 60 Hz
  frame. `buildIndex` is 0.011 ms and the query itself 0.003 ms with a cached index against
  0.008 ms without, so the index is rebuilt per preview rather than cached and invalidated on a
  mid-carry resize.
- Repeating a carry three times produces byte-identical output at both `y=0` and `y=0.9`, so the
  suite exercises the real settling adapter rather than a deterministic stub.
- A carry with a mid-carry colour change and rotation commits **exactly one** operation of type
  `move`, and one undo restores pose, colour and angle together, byte-identical.
- Slenderness: a 0.2 × 2.0 × 0.2 m column is flagged at 10.0:1; a 0.6 m-deep 2 m wardrobe at
  3.3:1 is not.
- A rejected drop leaves the revision unchanged and offers alternatives; the refusal reason is
  on screen, not only in the log.

Not established here: anything requiring hardware. The on-device carry demonstration is step 5
of the [M1 physical-device gate](m1-native-feasibility.md) and still depends on a native
rebuild after the repository move.

## M4 calibration journey

The guided sweep and the physical-obstacle layer already existed. M4 replaced the completion
test, gave calibration the states the PRD names, and made the measured/inferred distinction
real instead of nominal.

- **Coverage decides completion, not turn angle.** `packages/spatial-engine/src/coverage.ts`
  accumulates which 15° sectors the camera actually faced, under normal tracking, from the
  `onFrame` pose stream. A wall counts as measured when at least 75% of the angular span it
  subtends from the floor centroid was observed. The old test was `scanDegrees >= 270 &&
  walls >= 3`, which a phone spun on the spot with the lens covered satisfies.
- **This is TypeScript, and that was the point.** `onFrame` already ships `cameraToWorld` and
  `tracking` at 20Hz in every mode, so the evidence was already crossing the bridge. Forming
  the judgement on the JavaScript side means the whole calibration rule set replays from a
  recorded capture and no native rebuild sits on the path of a change to the rules. **No Swift
  was modified for this milestone.**
- **Extra-view prompts name a direction.** `needs_view` fires only when a boundary is almost
  entirely unseen (under 25% of its span), and the prompt says "Turn toward the west wall",
  reusing the same `compass()` helper that narrates placement alternatives. Degraded tracking
  gets different wording because the fix is different: hold still, rather than turn.
- **Shell confidence is two signals, and coverage outranks RoomPlan.** A `.low` RoomPlan
  confidence demotes a surface to `inferred` on its own. Separately, a wall the camera never
  faced is demoted however confident RoomPlan is — because RoomPlan closes a room and reports
  four confident walls after a 270° turn, inferring the fourth from the three it measured.
  Both `design` and `measured` carry the demotion, and one inferred structural surface makes
  the envelope `provenance: 'inferred'` — an enum member that existed in the contract and had
  never been assigned by anything.
- **Failure keeps what it gathered.** A native `failed` or a conversion throw now lands in a
  `failed` state showing the specific reason with a Retry, instead of silently resetting the
  sweep to zero and returning the user to a blank scan.
- **The physical-obstacle layer was already correct** and now has a scenario proving it: a
  design-erased object stays a collision neighbour in `buildIndex` until it is explicitly
  listed in `removedPhysicalIds`.

### Finishing is labelled, never blocked

A 270° sweep reports `ready` with the walls behind the user marked `inferred`, and
`needs_view` always offers **Use it anyway**. That is deliberate. The PRD asks that "missing
essential geometry cannot silently become a precise measurement" — honesty, not a locked
door — and M2 already recorded what happens when a soft signal is promoted to a hard error.
The editor says so on screen: an inferred shell names which surface classes were not measured
directly.

### Non-LiDAR now refuses at the start

Previously a non-LiDAR device walked the user through a 300° Vision Camera sweep, reached the
measure screen, hit `guard RoomCaptureSession.isSupported`, and offered nothing but Cancel.
The welcome screen now explains up front that calibration needs LiDAR. `ScanCamera.tsx` is
retained and annotated as unmounted; the `visual` and `handoff` phases were removed rather
than left unreachable in the state machine. A real non-LiDAR capture route remains open work.

### Deliberate non-goals

- **Multiroom.** One `room_id`, one floor polygon, one calibration. `RoomBuilder` is
  constructed with empty options and `CapturedStructure` is never referenced. Deferred.
- **Keyframe upload.** Six pose+intrinsics keyframes are captured, counted and dropped. The
  client, Fastify routes, store and worker boundary all exist and nothing calls them; wiring
  that path — and reconciling `calibrationId`, which currently holds a RoomPlan id rather
  than the server's UUID, and `calibrationRevision`, which is always `0` — is M5's work.
- **Door swing.** Every device-captured door still has `swing: null`, so the conservative box
  from M2 applies. The frozen RSG schema carries provenance per surface, not per attribute, so
  an inferred hinge on a measured door cannot be expressed; inventing one would be worse.
- **No schema change.** `rsg.schema.json` is a frozen interface with
  `additionalProperties: false`, and `Surface.provenance` already means exactly what coverage
  needed to say.

### Two bugs the first M4 device run found

Both were invisible locally because the development fixture is a 4x4m room built centred on
the origin, and because the sweep integrator has no headless harness.

- **Every added object was refused as "Outside the calibrated room".** `roomToSession`
  applied only the floor's Y offset, leaving X and Z in ARKit world space, so a scanned room
  sat wherever the AR session had started rather than at its own centroid. `rsg.schema.json`
  is explicit that "origin sits at the centroid of the floor polygon", and `add` with no
  pointed destination defaults to `[0,0,0]` — which on a real scan is outside the floor
  polygon. The conversion now recentres the room and records the displacement in
  `frame.world_transform`, which is what that field is for. `CameraPose` and the hand ray
  subtract the full origin vector rather than height alone; `floorOffset: number` became
  `origin: Vec3` along that path. `offset-origin.capture.json` and the `calib-origin`
  scenario pin it: a room 7.3m off-origin recentres to +/-2m and accepts an add.

- **A 270 degree turn read about 210.** `updateScanProgress` rejected any sample whose yaw
  delta exceeded 0.35 rad while still advancing `scanYaw`, so the rotation in that sample was
  lost permanently. 0.35 rad is 20 degrees per sample; the frame pump is throttled to 20Hz
  but runs slower under RoomPlan's load, making that an ordinary brisk turn rather than the
  tracking glitch the guard was written for. It now rejects on implied *rate* (above ~690
  deg/s) instead. The paired `abs(delta) > 0.001` floor was also removed: it discarded every
  sample below 0.057 degrees, which at 20Hz is 1.1 deg/s, so the slow steady sweep the app
  asks for accumulated nothing. Tremor is unbiased and cancels in the directed sum, and the
  direction latch already requires ~7 degrees of evidence.

  **This one is native and needs a rebuild to take effect.** It also has no headless gate:
  the integrator reads `ARFrame` poses, and a TypeScript re-implementation would prove only
  that the copy agrees with itself. Device gate step 2a covers it.

### A third bug, introduced by M4's own phase rework

**Hand manipulation stopped working entirely.** The new `needs_view` and `failed` states kept
the native view's `mode` prop at `scan`, but both are reached *after* RoomPlan has finished and
emitted its room. `setMode` only guards against `next == mode`, so `scan` arriving while the
native side sat in `edit` passed straight through and started a fresh `RoomCaptureSession` —
which mints a new `frameId`. The scene had been built with the old one, and `resolveHand`
refuses any frame whose id does not match the scene, so the cursor drew but targeted nothing:
`begin` never fired, and no object could be picked up. Reaching only ~210° made `needs_view`
the likely landing state, which is why this showed up together with the sweep bug.

Only `observing` may request `scan` now. `needs_view` also gained a **Keep scanning** button,
which makes the extra-view prompt actionable rather than decorative — the retained ARSession
means the coverage already gathered stays valid across a re-run.

Diagnostics were added to the Modules overlay so neither failure is silent again: a
frame-identity line that turns red on a scene/live mismatch and states that hand targeting
is disabled, and a hand line that names the failing stage.

That second one exists because `acceptHand` made three different failures look identical
from JavaScript. `x`/`y` are published only once the hand is active, and the raw fingertip
was itself gated on the point already being in view, so "Vision found no hand", "found one
whose point mapped outside the viewport" and "found one below the 0.60 activation gate" all
arrived as `visible: false, confidence: 0`. Native now reports `detected`, `inView`,
`rawConfidence` and both the raw and display points before any gate, and the overlay turns
that into one sentence naming which stage failed.

**`rawImagePoint` was checked and is correct.** It is the exact inverse of the EXIF rotation
for all four orientations, verified by round-tripping the forward rotation through it. That
inversion is deliberate and necessary: Vision returns points in the EXIF-oriented upright
image, while `ARFrame.displayTransform` expects normalized coordinates in the captured
buffer's native space. Undoing the rotation is what gets the fingertip into the space the
transform consumes.

### Drift: the room is now anchored

Reported from device as drift and inconsistent placement. The cause was structural: **there
was no `ARAnchor` anywhere in the project.** Room geometry was frozen against the ARKit world
origin as it stood the instant the scan finished, and the camera was mapped by subtracting a
fixed vector every frame. ARKit keeps refining that estimate — relocalisation and loop closure
move the world frame — and nothing told the room, so placed objects slid off the real surfaces
they were placed on.

ARKit revises anchor transforms when it improves its understanding of a space. The room origin
now carries an `ARAnchor`, and every frame reports that anchor's *current* transform rather
than the one it was created with. `roomFromWorld` prefers it and falls back to the scan-time
origin for the development room, for the frames before the anchor exists, and for a malformed
anchor.

Two details worth keeping:

- **A full matrix, not a translation.** A relocalisation can rotate the anchor as well as move
  it. Subtracting a vector would silently drop the rotation, and the hand ray would keep
  pointing the old way.
- **No renderer dependency.** An anchor transform is rigid, so the inverse is a transposed
  rotation with a re-derived translation. That is cheaper than a general 4x4 invert and keeps
  the module loadable by the headless gate.

Measured in `calib-anchor`: a world revision of 12cm and 3 degrees puts a placed point
**48.6cm** out of position with the static origin, and **0.000mm** out when following the
anchor. The scenario also pins the fallbacks, because a wrong fallback would break the
development room rather than the device.

This is the third change to the coordinate pipeline in this milestone and the only one that
cannot be checked without hardware — the arithmetic is gated, but whether ARKit actually
revises the anchor usefully in a real room is a device question. M1 gate step 3 (drift over a
60-second loop) is the acceptance test.

### M4 evidence

Measured on this machine, not on device. `npm run gate` reports **24/24**: five M2
scenarios, eight M3, eight M4, and three determinism checks.

The eight M4 scenarios replay recorded captures through `roomToSession`, so the calibration
judgement is verifiable with no hardware:

| Scenario | Gate clause |
|---|---|
| An empty-room capture converts as measured | empty-room capture |
| Scanned furniture stays a physical obstacle | physical obstacle layer |
| The unobserved wall is inferred, not measured | measured/inferred distinction |
| RoomPlan low confidence becomes inferred | shell confidence |
| An incomplete sweep asks for the missing view | extra-view prompts, tracking loss |
| A failed capture explains itself | incomplete scans recover clearly |
| A room away from the ARKit origin is usable | regression from the first device run |
| The room follows ARKit corrections instead of drifting | drift reported from device |

Behaviour behind the claims, from the replayed 4×4 m capture:

- A **180°** sweep reports `needs_view` and names the west wall. A **270°** sweep reports
  `ready` with two walls `inferred` and the envelope `inferred`. A **360°** sweep reports
  `ready` with nothing inferred and the envelope `observed`.
- The same capture converted **without** a coverage mask labels all four walls `real`, which
  is what the code did before this milestone.
- A full 360° turn recorded entirely under `limited` tracking is **not** accepted, and the
  prompt says tracking rather than aim was the problem.
- A two-wall capture is refused with "Show more room boundaries before editing.", and a good
  capture converts normally afterwards.
- The missing-floor capture derives a 16.0 m² floor from the wall bases and tags it `inferred`.

**The fixtures under `contracts/fixtures/rooms/captures/` are synthetic.** They exercise every
branch of the conversion but they are not evidence that a real scan behaves this way, and the
gate line says "device captures". A development build now has a **Save capture as fixture**
button that writes the raw `roomJSON` and its coverage mask; those files drop into the fixture
directory unchanged and the scenarios do not need to change to consume them.

## M5 reconstruction service — Stage A

The API was complete and well defended before this milestone, and **nothing had ever called
it**. Six pose+intrinsics keyframes were captured, counted on screen and garbage-collected;
the client existed with zero instantiations; no method could fetch an artifact. Stage A makes
the round trip real without touching a pixel, which is where three of the four gate clauses
live.

- **The keyframes are uploaded.** `mobile/src/runtime/reconstruction.ts` owns the server
  session and token, uploads the six views, starts the job and follows it to a terminal
  state. It runs *behind* the editor: the measured room is already usable, so reconstruction
  can never block entering edit or fail it.
- **Identity is reconciled.** `calibrationId` held RoomPlan's own room UUID, minted before
  any server contact, so it could never equal the `randomUUID()` the server issues and
  `stale_calibration` could never fire. The scene now adopts the server's id through
  `SpatialEngine.adoptCalibration`, which deliberately does not commit — it changes no
  geometry, so it must not advance the revision or enter undo history. `calibrationRevision`
  became a real per-capture counter instead of a hardcoded `0` compared against itself.
- **The client can fetch artifacts.** `GET /calibrations/:id/assets/:key` had existed since
  the API was written with no client method able to reach it. Added, returning bytes rather
  than a URL because the route needs the bearer token, which never leaves the client object.
- **Polling is bounded.** `poll` was a single request with no loop; `awaitJob` wraps it with
  capped backoff and a deadline, so a job that never settles surfaces as a failure instead of
  a spinner that runs until the session expires.
- **Failures are named.** Every request now carries the server's own reason —
  `duplicate_frame`, `capture_limit`, `stale_calibration`, `provider_not_configured` — and
  the editor shows reconstruction progress, completion or failure. A missing worker reads as
  a configuration state, not a fault.

### A real hole the gate found

**The manifest cross-checks lived inside `HttpReconstructionProvider`, not at the store
boundary.** A provider is explicitly a replaceable part, so swapping it silently dropped
every one of them: the first gate run had a fake publishing a manifest for
`someone-elses-calibration` with the job reported `completed`. `assertConsistent` moved to
`provider.ts` as a free function and the **store** now applies it to whatever any provider
returns, before a single byte is written. The HTTP provider keeps only transport concerns —
bounding the response and parsing it.

### Other defects fixed

- **`void this.run(s, job)` could kill the process.** Its `finally` awaits an `rm`, and an
  unhandled rejection from a floating promise terminates Node. Now caught and reported.
- **Nothing ever called `app.close()`.** Fastify installs no signal handlers — that is
  `fastify-cli`, which this project does not use — so the `onClose` hook that releases
  sessions was unreachable and every Ctrl-C, container stop or deploy left uploaded camera
  frames on disk until the next boot happened to wipe them. `SIGINT`/`SIGTERM` handlers added.
- **Worker error detail was destroyed.** Eight distinct provider failures collapsed into
  `reconstruction_failed` and were never logged anywhere, making a worker integration fault
  undebuggable from the server side. The client still sees the coarse status; the operator
  now sees which one it was. Upload refusals are likewise named rather than collapsed into
  one opaque `capture_rejected`.
- **A timed-out job reported two different stages** depending on which path timed it out.
- **`store.asset` threw out of an un-try/catch'd handler** into a 500 when the map and the
  disk disagreed; a missing artifact is a 404.
- **`server/src/routes/assets.ts` was deleted.** 150 lines serving the legacy Swift app's
  catalogue over HTTP: never imported, so the routes did not exist at runtime, one of its
  three roots is not on disk, and `tools/voice-doctor.sh` reported its absence as a permanent
  false failure. That check now reports whether a reconstruction worker is configured, which
  is the thing that actually matters.

### M5 evidence

`npm run gate` now runs two suites: the app gate (24/24, unchanged) and a new server gate
(9/9). The server gate drives every route through Fastify's `inject()` — no socket, no port
to collide, nothing to clean up, but real routing, parsing, validation and serialisation.

It lives in the server workspace on purpose: `mobile/src/runtime/scenarios.ts` is imported by
`EditorPanel` and therefore bundled into the app, so importing Fastify from there would drag
the whole server into the Metro bundle.

| Scenario | Gate clause |
|---|---|
| A calibration completes end to end | round trip, artifacts marked inferred |
| An empty room bypasses removal | empty room bypasses removal |
| Stale and mismatched revisions are refused | revision checks |
| A worker answering for another calibration is rejected | revision checks, late publish |
| Deleting mid-job cancels it and revokes access | cancellation |
| Cleanup covers deletion, expiry and shutdown | cleanup verified |
| Retries do not duplicate work | job idempotency |
| One session cannot read another | per-session ownership |
| Without a worker the API says so plainly | provider_not_configured is a state, not a fault |

Separately verified over a **real socket**, client against server: six keyframes uploaded,
the server UUID adopted into the scene, the job completed with both artifacts marked
inferred, the atlas fetched as valid PNG bytes through the previously unreachable route, and
the session gone after dispose.

The fake provider is not a shortcut — the implementation plan names it as required
(`implementation-plan-expo.md:44`: *"Local fake jobs with delay/failure/cancellation
controls"*). Every behaviour above is a property of the store and the API rather than of
segmentation quality, and making them depend on model weights would mean they could only
ever be checked by hand.

**Stage A produces no pixels.** The atlas in these runs is a 1×1 PNG from the fake. The
"clean-shell preview stays registered across viewpoints" clause needs Stage B's worker and
Stage C's renderer, and is still open.

## M5 Stage B — the reconstruction worker

`workers/reconstruction/`, the path the plan already named. Python, because the model
libraries are and the PRD explicitly permits it for workers; it does not replace Fastify and
introduces no FastAPI — transport is one POST handler on the standard library, because a
single-route service does not need a framework.

### The contract had to grow, once

`ReconstructionInput` carried only keyframes. The worker cannot project without the room:
the planes to project onto, the volumes to reject, and — critically — `origin`, because
keyframe poses are in raw ARKit world space while the scene is recentred on its floor
centroid. `ReconstructionRoomSchema` now travels with the session it calibrates.
`reconstructionRoom()` derives it from the scene in one place so the mapping is testable
without a server. Obstacles come from `measured`, not `design`: a sofa already deleted from
the design is still in the photographs, so its pixels must still be rejected.

### The stages

- **Segment.** Two sources, unioned. Geometry projects each measured box into each keyframe
  — exact, temporally stable, free — dilated 6% with a 10cm contact-shadow skirt, both
  constants taken from the prior art rather than guessed. SAM catches clutter RoomPlan never
  categorised, which geometry cannot see. Unioned rather than substituted, so a segmenter
  having a bad day can add false positives but cannot un-mask the sofa.
- **Project.** One atlas per surface at 256 px/m, metric by construction. Per texel: project
  into every keyframe, reject anything the mask covers, weight by the cosine of the grazing
  angle, accumulate. Texels no camera ever saw carry zero weight and become holes. This is
  the step that makes the result world-consistent — the PRD notes that inpainting each frame
  independently "would introduce flicker and changing geometry".
- **Complete.** LaMa when weights are present, a deterministic nearest-texel fill otherwise.
  The fallback is not a stopgap; it is the baseline the PRD asks LaMa to be compared against.
- **Emit.** `shell.json` is a self-contained mesh with its own UVs, deliberately not an
  extension of RSG `Surface` — that schema is frozen with `additionalProperties: false` and
  has nowhere to hang a UV. Room space throughout, so the client needs no world-frame
  knowledge. Every surface carries `observedFraction` and its own `inferred` flag.

Each stage dumps its own artifact under `--dump`, which the plan requires so a bad result is
traceable to the stage that caused it: per-keyframe masks, and per surface the observed-only
projection, the hole mask, and the completed texture.

### Stage B evidence

`npm run gate` now runs three suites: app 24/24, server 9/9, and the worker self-test.

The self-test is synthetic on purpose. It renders a room whose walls carry a checkerboard
and a marker at a known position, photographs it from six poses with real perspective, runs
the actual pipeline over those photographs, and maps the marker back through the shell
document's own positions and UVs — the exact interpolation a renderer performs.

**Registration error: 0.3 cm.** Found `[0.998, 1.252, 2.0]` against ground truth
`[1.0, 1.25, 2.0]`. A real capture would only prove the pipeline runs; a scene with known
ground truth is the only thing that proves it runs *correctly*, and an error of tens of
centimetres looks perfectly convincing in a photograph.

Also measured: 57% floor and 91% wall coverage with furniture present, rising to 90% floor
once the furniture is gone; the masked object named in `removedObjectIds`; and an empty room
skipping the erase pass entirely, as the PRD requires.

Verified over the **full chain** — mobile client → Fastify → real Python worker — in 1.8s,
returning a valid 1.4MB PNG atlas and a shell document with correct UVs, fetched back
through the artifact route.

### Two bugs the self-test caught

Both were in the harness rather than the pipeline, which is the point of having ground truth:

- The renderer built its camera from room-space eyes and then subtracted the origin again,
  putting the camera metres outside the room. Every keyframe was pure black. The pipeline
  reported it honestly — geometry seen, coverage accumulated, colour zero — rather than
  producing something plausible.
- The first registration check assumed the wall's u axis ran along +X and reported a 2m
  error. It runs toward −X. Testing against an assumed convention only proves the test
  agrees with itself, so the check now goes through the shell contract the client will use.

### Models: verified, and three assumptions were wrong

Weights are now fetched and both models run. The ONNX signatures did not match what the
published SAM and LaMa contracts implied, and every mismatch produced plausible-looking
output rather than an error:

- **The SAM encoder takes HWC float at native resolution**, not a normalised NCHW 1024²
  letterbox. Feeding it the textbook tensor produced masks offset by a factor of 960/1024.
- **`orig_im_size` must be `[1024, 1024]`, not the image size.** Passing the true size put
  every mask 6% off. Measured against a synthetic target: 1px error at 960×720, 3px at
  1920×1440, 99.2% coverage of the object.
- **LaMa returns 0–255 already.** Scaling the output by 255 — the symmetric-looking thing
  to do after dividing the input — saturates every filled texel to white. Verified by
  inpainting a striped test tile: hole mean 103.7 against a ground truth of 102.3, stddev
  29.9 against 29.4, so it genuinely reconstructs the pattern rather than smearing.

All three were found by measuring against known ground truth, which is the only reason
they were found at all.

Both paths are reported per request. On the self-test room: geometric masks alone give
1,219,971 masked pixels in 1.2s; with SAM the model contributes a further 984,095 and
completion switches to LaMa, at 25s. The deterministic fill remains the comparison
baseline the PRD asks for rather than a stopgap.

**Still not evaluated:** the PRD requires SAM-family masks and LaMa to be compared
independently before one is selected. Both now run; neither has been judged against the
other on real captures.

## M5 Stage C — the registered preview

`ShellView` draws the reconstructed shell as 3D content in the room, which is M5's half of
the split. It is **not** compositing: the real furniture is still in the camera behind it.
The PRD is explicit that "the first milestone is not equivalent to completing live
diminished reality", and replacing camera pixels is M8.

- **Strictly additive.** It renders only when a shell exists; `SceneView`'s own floor and
  wall meshes are untouched, so with no shell the scene behaves exactly as before. Off by
  default behind a **Show empty room** toggle, because the measured room is the working
  surface and the shell is something to look at, not something that silently replaces what
  you were editing against.
- **`ShellSchema` parses what arrives.** The worker is a replaceable part, and this is the
  only thing between a malformed mesh and the renderer.
- **The texture path already existed and had never been used.** R3F's native entry ships a
  `TextureLoader` that resolves through `expo-asset` and uploads via EXGL, with both Pods
  linked since the project started. The atlas is written to a cache file and loaded from
  its URI — no new dependency, and no multi-megabyte data URL.
- **Unlit material.** The atlas already contains the room's own photographed lighting;
  lighting it again would double every shadow that was captured.
- **An inferred surface is dimmed**, not drawn as though it were photographed. Unknown
  space must not read as verified space, in appearance as much as in geometry.

### Stage C evidence

A real `shell.json`, emitted by the worker from its self-test room, is checked in as a
fixture and gated by `calib-shell` — so the client's parsing and UV handling are verified
without the worker running, and a change to either side that breaks the other is caught.

It asserts the worker's own output validates; that it is in room space; one UV per vertex;
UVs inside the atlas; indices in range; that the floor is the measured 4.00m × 4.00m and
the wall reaches the measured 2.50m ceiling; that each surface reports how much was
observed; and that a well-observed surface is never labelled inferred.

App gate is now 25/25, server 9/9, worker self-test passing, and the Hermes bundle still
evaluates with `ShellView` and the texture loader in it.

**Not verified:** nothing has drawn a shell on a device. The geometry, the UVs and the
contract are gated; that the texture actually uploads through EXGL on hardware is not, and
that is the one thing this stage cannot prove off-device.

## M6 coordinated hands, touch, and voice

### One coordinator, not three sources of truth

Selection, destination, turn binding and command execution lived in React effects: the hand
loop wrote state through `setState`, the voice adapter read a mutable ref, and "which object
was the user talking about" was whatever that ref held when a network callback happened to
arrive. Fine until a tool call is delayed, at which point it silently acts on the wrong
object.

`mobile/src/runtime/coordinator.ts` owns all of it and is framework-independent, so the
scenarios drive it with a scripted transport rather than a live model — which is what the
milestone plan asks for, because event ordering is the thing under test and no provider
makes that reproducible.

### The correlation bug this milestone exists to fix

`response.created` bound the response to `this.speechTurn` — whichever turn was *currently
speaking*. Speak, pause, speak again, and a slow first response was recorded against the
second turn, then acted on the second turn's selection. Responses now attach to the turn
that **asked** for them, recorded before the request goes out.

Alongside it: confirmations bind to a specific pending operation id, so a delayed "yes"
cannot approve an edit the user has not seen; commands are serialised, because the engine is
the only writer of committed state and is not reentrant; and a generation counter makes work
from a previous voice connection identifiable as obsolete.

### Ambiguity, defined twice before it was right

The first rule fired whenever the selection had changed recently — which is the *normal*
flow, point at a thing then talk about it — so it refused every command. The second fired
whenever the live selection differed at resolve time, which is exactly the case latching
exists to handle. The rule that survives is narrower: the selection did not hold **across**
the utterance. Both wrong versions were caught by the gate.

### Derived scene data

`commit` blanked occupancy with the comment *"never hand a consumer a stale grid"*. Right
instinct, wrong half — no consumer ever received a grid at all, and relations were carried
from the fixture untouched, going stale the moment anything moved. Both are now rebuilt from
committed geometry on every commit and undo: an 80x80 grid at the schema's fixed 5cm with run
lengths summing exactly to the cell count, and relations derived from geometry and declared
support. `blocks` stays unemitted, as M2 decided for `blocks_walkway`: it needs a circulation
graph this project does not have.

The engine now derives at construction too, so a fixture's hand-authored relations are not
silently replaced by the first commit. That let `canon()` stop excluding occupancy, making
the undo comparison strictly stronger.

### The spatial context packet

Built from the committed grid rather than recomputed: the schema rejects sending the grid
itself at 10Hz, but a largest-open-rectangle scan over it is affordable. Candidates are
ranked here — angular offset dominant, then distance, apparent size and intrinsic salience —
because the schema is explicit that the client scores and the model only confirms. When the
top two are within 0.1 the client has already concluded it is a tie and says so.

**It agrees with the checked-in fixture.** The largest open rectangle computes as 4x2.2m at
(0, 0.9), matching `contracts/fixtures/scp/pointing_at_bed.json`, which was generated
independently by `tools/make_fixtures.py` in Python. Measured size is 1170-1382 bytes against
the 2KB budget.

### Four further bugs found by the exploration

- `frameId` was initialised once at mount and never refreshed, so a re-measure without a
  remount made every attention bind miss with `other_frame` and every intent fail as stale.
- The destination re-latched itself every frame and never expired, which is precisely what
  the two-second freshness rule exists to prevent.
- The duplicate-call cache evicted at 100 entries and then re-executed; the engine caught the
  double-commit but the original result was lost.
- Every op recorded `source: 'system'` with a null turn, so the log could not distinguish a
  voice edit from a tap. Ops are now attributed to their turn and source — never a
  transcript, which the diagnostics rule forbids.

### M6 evidence

App gate **34/34**, including nine M6 scenarios covering the plan's acceptance table: delayed
tool binding, stale and absent destinations, mid-utterance selection change, out-of-order
responses, duplicate delivery, delayed confirmation against a newer pending edit, voice
parity and shared carry transactions, derived occupancy and relations, the SCP, and
obsolete-work rejection. Server gate 9/9, worker self-test passing, workspace typecheck
clean, iOS JS bundle builds.

**Not verified:** nothing has run on a device. Audio, fingertip alignment, delayed tools
against a live model, concurrent input and background/resume are all outstanding, and the
milestone's own checklist records them as such. Occlusion in `visible_entities` is inferred
from the crosshair ray rather than a depth buffer.

## M7 structured creation and atomic restyling

"Make this a blue bedroom with three frames here" now produces a coherent, editable
arrangement that fits the room. The conversational model contributes a **recipe** —
families, counts and named surfaces — and never a coordinate; the device plans the poses,
validates the whole result and commits it once.

### The planner boundary

`restyle_room` is a second tool alongside `edit_room`, so a "move that left" never has to
carry a creation schema. What it accepts is a `SceneRecipe`: validated data, never
executed. Poses come from `planLayout`, which is deterministic by construction — fixed
candidate order, the same 5cm lattice the nudge search uses, identifiers derived from the
scene rather than a clock, and no random source anywhere. Three runs of the same recipe
against the same room produce byte-identical placements and byte-identical construction
results, and the gate checks both.

### Two claims that must not be confused

A bounded search that runs out of budget has not proved anything. `search_exhausted` and
`infeasible` are separate statuses with separate narration for that reason: the same
four-bed request returns `search_exhausted` at a 40-evaluation budget ("a limit I hit, not
a proof that they do not fit") and `infeasible` at the full 20 000, having actually
established the conflict in 13 011 evaluations and 44ms. The 12-object cap reports as a
bound too, never as geometry.

### Evenly spaced, around a window

The acceptance case is three frames on a wall that has a window in it, and "evenly spaced
in usable wall space" turns out to need a definition. The opening cuts the wall into two
1.2m runs; an odd-numbered group cannot be both evenly spaced across the whole wall and
clear of the glass. The planner tries the runs unrolled into a single measure first, which
gives perfect equal spacing and is rejected here because the middle frame would straddle
the cut, then allocates by largest remainder across runs and spaces evenly within each.
The answer is 2 + 1 at a 0.70m pitch, and no frame over the window.

### Three legs

A three-legged bed is not a bed with a leg deleted. `ENVELOPES` declares which support
counts each family has authored geometry **and** edge-load checks for; `table` gained a
genuine three-support template at version 1.1.0, `bed` did not. So a tripod table builds
and carries its edge-load finding as a caveat, while a three-legged bed is refused with
the reason and a supported alternative. Span limits carry a per-family bracing factor,
because a bare 0.9m panel limit is right for a shelf and wrong for a bed frame with rails
— the factor states the claim about bracing instead of burying it in the material number.

### One transaction

`applyProposal` prepares everything in an isolated draft — withdrawals, placements,
palette, group membership, visibility intent — validates the complete arrangement, and
publishes one commit. One revision, one op-log entry, one undo that restores objects,
surfaces, groups and visibility intent together, because the history entry is a snapshot
of the whole state.

Only violations the transaction **creates** can refuse it. A scan can hand over a room
whose measured furniture already overlaps slightly, and refusing a restyle for a condition
it did not cause would make the feature unusable in exactly the rooms it is for; those are
reported as caveats instead.

### Visibility intent is not removal

`hideMeasuredIds` drops an object from the **design** so it stops being drawn, and records
it in `removalMaskIds` with the calibration it was expressed against. It never touches
`removedPhysicalIds`. The measured observation stays, so the object stays in the index and
the planner still routes around it — not seeing something is not the same as it being
gone. A reconstruction manifest naming removed objects erases nothing on its own, and the
gate proves it.

### Bugs the gate found

- **Re-planning a group collided with itself.** Growing two frames to three left the
  original two in the draft at their old poses, so each reused member overlapped its own
  previous position and the whole group silently relocated to another wall. Members of a
  group being re-planned are now withdrawn from the draft first.
- **Two spacing metrics.** One strategy reported the cell width and the other the
  centre-to-centre distance, so a group's recorded pitch did not match the gap between
  its own members.
- **"Try 1 instead of 1."** The count alternative was offered even for a single object.
- **The revalidator invented legs.** Deriving a nominal 3-or-4 reported every shelf and
  frame as an unauthored four-support variant; the support count is read off the assembly,
  which is the only reliable source.
- **A destination deviation with no request behind it.** The wall-group planner compared
  against the first wall in id order even when the recipe had named no wall at all.

### M7 evidence

App gate **47/47**, including thirteen M7 scenarios covering the plan's acceptance table:
the blue-bedroom recipe, count 2→3→2 with retained identity, an impossible layout with no
partial commit, preservation of a selected object as a visible obstacle, atomic undo of a
furnished-room restyle, a wall moved into furniture, the three-legged bed, a stale
proposal, the search limit, planning determinism, reconstruction-never-erases, and the
legacy style expansion. Server gate 9/9, worker self-test passing, workspace typecheck
clean, iOS JS bundle builds (4.5MB).

**Not verified:** nothing has run on a device. The complete voice-driven bedroom,
count-change and undo journey is outstanding. Known limits: a group hangs on one wall, so
the planner refuses rather than distributing a group across several; floor groups are
placed member-by-member by candidate search rather than solved for even spacing, so
`evenly_spaced` is exact only for wall groups; the construction envelopes and bracing
factors are authored estimates and every result says so.

## Worker integration

Set `RECONSTRUCTION_WORKER_URL` and `RECONSTRUCTION_WORKER_TOKEN` on Fastify only. The worker receives a POST with calibration ID/revision/frame ID and aligned keyframes containing camera metadata and JPEG data. It returns:

```json
{
  "manifest": {
    "calibrationId": "same-as-request",
    "calibrationRevision": 0,
    "frameId": "same-as-request",
    "artifacts": [
      { "key": "shell.json", "role": "shell", "inferred": true },
      { "key": "atlas.png", "role": "atlas", "inferred": true }
    ],
    "removedObjectIds": []
  },
  "assets": [
    { "key": "shell.json", "mime": "application/json", "dataBase64": "..." },
    { "key": "atlas.png", "mime": "image/png", "dataBase64": "..." }
  ]
}
```

This defines a provider integration contract, not an implemented SAM/LaMa pipeline — that is Stage B. No worker is selected by default; reconstruction returns `provider_not_configured`, which the client presents as a configuration state rather than a failure. `FakeReconstructionProvider` implements the same interface for the gate. Note the manifest cross-checks are applied by the **store**, not by a provider, so they hold for every implementation. Backboard has not been adopted. A worker must preserve metric registration and identify inferred content; a generated room illustration is insufficient.

The built-in calibration store is a bounded, single-process development service. Sessions are invalidated and their UUID directories cleaned on server restart. Use shared storage and job coordination before deploying multiple backend instances. The API's expiry cannot guarantee an external provider's retention policy.

## Contract source decision

Existing scene wire types remain generated from `contracts/schema/*.json` through `contracts/codegen.sh`. Expo-specific session envelopes are currently authored as Zod schemas in `packages/contracts/src/session.ts`; inferred TypeScript types are derived from those schemas, not maintained separately. This avoids breaking the old Swift wire format while the native integration is under development. Promote them to the cross-language generation path when Swift needs to consume the envelope itself.
