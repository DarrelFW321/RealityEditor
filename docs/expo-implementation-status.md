# Expo implementation status

Implementation started 2026-09-18. This is a working migration foundation, not a completed release. No automated testing workstream or test packages were added.

## Implemented code

- npm workspace with pinned Expo SDK 57, Vision Camera 5, R3F, WebRTC and compatible React Native dependencies; one root lockfile.
- Shared generated RSG/Op/SCP/ConstraintReport contracts, preserving the server compatibility import. Added frame/shelf classes to the source schema and regenerated Swift and TypeScript.
- Versioned Expo session envelopes, adapter ports, diagnostic events, lifecycle ownership and a development sample room.
- Local transaction engine: selection, move preview, free carrying, live drop validity, validated drop, upright gravity settling, cancellation, stale-operation rejection, duplicate-operation protection and undo.
- Compound box collision queries, room-boundary/opening checks, retained physical-obstacle handling and explicit construction uncertainty.
- Parameterized table, bed, cabinet, shelf and frame assemblies used for both rendering and collisions. Multi-object additions are atomic.
- Expo editor with touch controls, voice tool integration and a development command/diagnostics panel.
- Vision Camera capture screen and explicit handoff to a local RoomPlan/ARKit module. Native code exports room surfaces, tracked camera matrices and Apple Vision hand cursor/pinch samples.
- Fastify `/voice/session` compatibility alias, calibration sessions, bounded aligned-frame upload, asynchronous job lifecycle, scoped artifacts, cancellation and expiry. Cloud inference runs through a replaceable external worker adapter.

## Milestone assessment

| Milestone | State | Remaining work |
|---|---|---|
| M0 Foundation | Implemented; JS checks pass | Demonstrate development binary on hardware |
| M1 Native feasibility | Reworked after the first device run exposed missing behavior; local checks pass | Build this revision and repeat the complete [M1 physical-device gate](m1-native-feasibility.md) |
| M2 Spatial engine | Implemented; gate scenarios pass locally | Relation and occupancy recomputation (M6), `APPLY_STYLE` expansion (M7), device demonstration |
| M3 Carry/release | Implemented; gate scenarios pass locally | Device demonstration |
| M4 Calibration | Native measurement flow written | Coverage/confidence acceptance, inferred-shell guidance, non-LiDAR alternative and multiroom handling |
| M5 Reconstruction | API, client and worker boundary implemented | Vision Camera-to-room registration; deployed segmentation/completion pipeline; projected atlases and verified cleanup across external providers |
| M6 Hands/voice | Integration written | Device audio, fingertip alignment, turn/context timing and concurrent input demonstration |
| M7 Creation/restyle | Procedural additions and basic edits implemented | General room-aware layout search, count-change groups, grouped mask/scene transactions, supported unusual assemblies |
| M8 Compositing | Not implemented | Empty-shell textures, hand-preserving occlusion, temporal consistency |
| M9 Release | Not ready | All dependent device and reconstruction gates |

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
- **Relation and occupancy recomputation** remain deferred to M6, as in M2.

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

This defines a provider integration contract, not an implemented SAM/LaMa pipeline. No worker is selected by default; reconstruction returns `provider_not_configured`. Backboard has not been adopted. A worker must preserve metric registration and identify inferred content; a generated room illustration is insufficient.

The built-in calibration store is a bounded, single-process development service. Sessions are invalidated and their UUID directories cleaned on server restart. Use shared storage and job coordination before deploying multiple backend instances. The API's expiry cannot guarantee an external provider's retention policy.

## Contract source decision

Existing scene wire types remain generated from `contracts/schema/*.json` through `contracts/codegen.sh`. Expo-specific session envelopes are currently authored as Zod schemas in `packages/contracts/src/session.ts`; inferred TypeScript types are derived from those schemas, not maintained separately. This avoids breaking the old Swift wire format while the native integration is under development. Promote them to the cross-language generation path when Swift needs to consume the envelope itself.
