# Expo implementation status

Implementation started 2026-09-18. This is a working migration foundation, not a completed release. No automated testing workstream or test packages were added.

## Implemented code

- npm workspace with pinned Expo SDK 57, Vision Camera 5, R3F, WebRTC and compatible React Native dependencies; one root lockfile.
- Shared generated RSG/Op/SCP/ConstraintReport contracts, preserving the server compatibility import. Added frame/shelf classes to the source schema and regenerated Swift and TypeScript.
- Versioned Expo session envelopes, adapter ports, diagnostic events, lifecycle ownership and a development sample room.
- Local transaction engine: selection, move preview, free carrying, validated drop, upright gravity settling, cancellation, stale-operation rejection, duplicate-operation protection and undo.
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
| M3 Carry/release | Upright baseline implemented | Full stability/angular dynamics, device behavior, general support contacts |
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

### Known issues logged, not fixed here

- Backgrounding calls `setTracking(false)`, but the resume branch re-enables only when there is no
  tracked frame, so a real AR session stays paused until the panel remounts.
- `AdapterSlot.dispose` stops a starting adapter before awaiting its queue, so a fast
  background/foreground/unmount can dispose twice.

## Verification performed here

Workspace TypeScript checks, Expo iOS JavaScript export, generated-contract consistency, and the existing Swift SpatialCore build passed. Expo autolinking discovers `SpatialCaptureModule`. The Swift core build also confirms the new frame/shelf enum cases preserve its exhaustive switches. These checks do not compile the native Expo capture module or demonstrate camera/audio/hand behavior.

M1 now includes a DeviceMotion-guided six-view 300° Vision Camera sweep with manual fallback and automatic continuation, an explicit stopped/unmounted handoff before RoomPlan mounts, native acquisition events, an automatically finalizing 270° RoomPlan measurement with an always-available manual finish, and an explicitly tagged inferred-floor fallback when furniture prevents RoomPlan from finalizing a floor. It also includes viewport/orientation metadata, frame freshness/cadence checks, R3F render FPS, fixed world-space alignment markers, tracking-loss gating, confidence-gated and smoothed fingertip tracking, scale-independent pinch hysteresis, and a documented device evidence procedure. See the [M1 feasibility record](m1-native-feasibility.md). These changes require another device run; local checks cannot establish visual alignment or camera ownership on hardware.

This machine has only Xcode Command Line Tools, not a full Xcode installation. No physical-device build, model call, image upload or cloud deployment was performed. No existing tests were removed or run.

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
