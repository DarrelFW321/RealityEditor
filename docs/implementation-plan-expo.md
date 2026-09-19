# Expo migration implementation plan

Status: implementation in progress. See [current code, verification and remaining milestone work](expo-implementation-status.md). The milestones below remain the target scope; scaffolding alone does not close their device or reconstruction gates.

Product and architecture reference: [Expo migration PRD](prd-expo-migration.md). Isolation means independently buildable, replaceable modules so new implementations can be inserted without rewriting the application. No new testing workstream, test frameworks, or CI test suites are in scope. Retain diagnostics throughout implementation. Keep Fastify.

## Remaining milestone plans — M6 through M9

Planning baseline, 2026-09-19: **M5 is complete, as confirmed by the project owner.** The detailed plans below define the remaining implementation and acceptance work. They take precedence over the shorter M6–M9 outlines in this document where the detail differs. Historical evidence records remain historical; this planning update does not claim a new device run or verification result.

| Milestone | Goal | Detailed plan and completion checklist |
|---|---|---|
| M6 — Coordinated inputs | Hands, touch, and voice edit one scene with reliable turn binding and shared transactions | [Hands and voice](milestones/m6-hands-and-voice.md) |
| M7 — Creation and restyling | Generate editable, valid layouts and commit restyles as one undoable transaction | [Creation and restyling](milestones/m7-creation-and-restyling.md) |
| M8 — Live compositing | Erase unwanted furniture pixels while preserving foreground hands and correct depth ordering | [Live compositing](milestones/m8-live-compositing.md) |
| M9 — Internal release candidate | Deliver a reproducible internal build with a verified full journey and operational recovery | [Internal release candidate](milestones/m9-internal-release-candidate.md) |

Implementation order is **M6 → M7 → M8 → M9**. M8's native texture feasibility work can begin during M6; subsequent M8 transaction integration depends on M7. This dependency allows independent work but does not require parallel agents or additional staffing.

### Agreed scope and completion rules

- M9 targets internal distribution, not a public launch or App Store submission.
- Live compositing must sustain at least **30 FPS**. 55–60 FPS is an optimization target, not a release blocker.
- Retain Expo, R3F, the current RoomPlan/ARKit session, Apple Vision hand tracking, direct Realtime WebRTC, Fastify, and the reconstruction worker. Use one conversational model. Keep the legacy style endpoint compatible without adding a second conversational controller to the Expo journey.
- Initial support is single-room editing on verified LiDAR iPhone/device-OS combinations. Non-LiDAR reconstruction, Android calibration, multiroom, accounts, persistent projects, and an offline product mode remain outside these milestones. Filament, Meshy, Backboard adoption, and world-model research are not dependencies.
- The spatial engine remains the only writer of committed design state. Measured observations, inferred appearance, proposed design, and physical occupancy remain distinct.
- Extend the existing development scenarios, gates, and diagnostic tools. Do not add a separate testing framework or testing workstream.
- Treat implementation, local verification, and physical-device verification as separate checklist entries. A local gate cannot establish camera alignment, audio behavior, texture interoperability, or foreground preservation.
- Every completion record names the commit, build, device/OS where applicable, adapter IDs, commands/scenarios, measured results, limitations, and evidence location. Leave unknown evidence explicitly unrecorded; do not infer it from an earlier milestone.

## Delivery approach

Build an iOS-first Expo application alongside the existing Swift application. Move deterministic spatial behavior into a framework-independent TypeScript package, while keeping camera, tracking, rendering, voice transport, and reconstruction behind replaceable adapters. Preserve the existing application and API compatibility until the Expo release passes its device gates.

Deliver small vertical slices using sample room data and development adapters before connecting them to live sensors or providers. These development tools do not add an offline product feature. Do not add furniture registration, project reopening, Filament, or Meshy.

The two highest-risk gates are native camera/pose/render integration and world-consistent empty-room reconstruction. A mock or simulator demonstration cannot close either gate. A third early spike must establish an Expo-compatible settling implementation; R3F is the renderer, not the physics engine.

## Workspace and ownership boundaries

Proposed additions, not directories already implemented:

```text
mobile/                         Expo app, UI, composition, development builds
mobile/modules/spatial-capture/  Native adapter if required by the feasibility spike
packages/contracts/             Generated TypeScript contracts and validators
packages/spatial-engine/        Commands, constraints, targeting, transactions, undo
packages/scene-recipes/         Procedural assemblies and authored construction rules
packages/dev-scenarios/         Sample rooms and development-only input adapters
packages/adapters/              Implementations of capture, voice and physics ports
server/                         Existing Fastify app; routes and job orchestration
workers/reconstruction/         Separate segmentation/completion worker
contracts/schema/               Existing source schemas; retain as source of truth
contracts/fixtures/             Existing fixtures, extended with versioned scenarios
ios/                            Existing app and SpatialCore during migration
```

The spatial engine must not import React, native modules, Three.js, provider SDKs, or server code. Render meshes and physics bodies derive from validated scene data. Use metres, explicit coordinate conventions, calibration/frame identifiers, and monotonic timestamps at adapter boundaries. Record transform direction and matrix layout; never infer either from an array shape.

| Boundary | Contract and responsibility | Independent development path |
|---|---|---|
| Capture / spatial provider | Frame metadata, intrinsics, pose, tracking status, measured surfaces, camera ownership lifecycle | Recorded metadata and synthetic room sequence |
| Hand input | Timestamped cursor/gesture samples in a declared image coordinate system | Landmark and gesture replay |
| Command engine | RSG + Op + SCP → preview/result + ConstraintReport; sole owner of commits | Sample room and command panel |
| Settling adapter | Valid candidate + collision/support geometry → bounded settle result or failure | Sample scene with selectable settling implementation |
| Renderer | Draw scene/preview using synchronized projection; never silently mutate domain state | Standalone sample-scene view; tracked view on device |
| Voice session | Turn events, tool requests/results, cancellation and transport lifecycle | Scripted transcript/tool events without microphone or provider |
| Reconstruction client | Revision-tagged job manifests and temporary asset references | Local fake jobs with delay/failure/cancellation controls |

Keep generated contracts out of handwritten edits. Extend `contracts/codegen.sh` to produce the shared package and retain a compatibility export for the existing server. Version new schemas and fixtures together; old Swift fixtures must either remain compatible or have an explicit migration. Do not reinterpret existing fields silently.

## Milestones and exit gates

Each milestone ends in a reviewable change, a runnable demonstration, and an evidence record containing commit, dependency versions, device/build where relevant, active adapter IDs, diagnostics, and remaining limitations. Estimates should follow M1 findings; there is no credible delivery date before the native integration path is established.

| Milestone | Depends on | Deliverable | Required exit evidence |
|---|---|---|---|
| M0 — Foundation and isolation | None | Expo development build scaffold, shared contracts, development adapters, diagnostic envelope, adapter registry | App boots with a sample room; one adapter can be replaced through configuration without changing feature code |
| M1 — Native feasibility | M0 | Vision Camera capture, measured-room provider, synchronized R3F render prototype, hand-frame access and physics spike | Real-device aligned anchor demo; explicit camera handoff; correct fingertip projection; selected settling backend runs on device; pinned compatibility record |
| M2 — Spatial engine and transactions | M0 | TypeScript scene operations, targeting, constraints, inverse operations, scene revision handling | Sample-room demonstration shows valid placement, rejected overlap, explicit support, atomic undo and stale-operation rejection |
| M3 — Carry and release | M1, M2 | Shared gesture/voice manipulation state machine and real settling adapter | Carry through doorway/objects; valid release settles; invalid release restores; one move yields one undo; no unintended stacking |
| M4 — Calibration journey | M1, M2 | Guided sweep, extra-view prompts, shell confidence, physical obstacle layer | Empty and furnished room device captures preserve measured/inferred distinction; tracking loss and incomplete scans recover clearly |
| M5 — Reconstruction service | M0, M4 | Fastify session/job endpoints, worker, selected keyframe upload, masks, background atlas/completion | Furnished room clean-shell preview stays registered across viewpoints; empty room bypasses removal; cancellation, revision checks and cleanup verified |
| M6 — Coordinated hands and voice | M3, M4 | One Realtime session, synchronized SCP, shared commands and tool results | Point/select then point/destination works despite delayed tools; voice and hands edit one transaction; interruptions and duplicate calls are safe |
| M7 — Creation and restyling | M2, M3, M5, M6 | Procedural object families, structured recipes, assembly rules, grouped restyles | Blue bedroom/three frames demo; dimensions/colors/count edits; plausible three-legged bed or explained rejection; no committed overlap |
| M8 — Live compositing | M1, M5, M7 | Clean-shell compositing, depth/hand occlusion, incremental appearance updates | Camera motion and hand crossing do not expose stale furniture masks or erase the hand; uncertain regions remain identified |
| M9 — Integrated release candidate | M3–M8 | Staging build, supported-device matrix, diagnostics runbook, migration/cutover checklist | Full journey demonstrated on supported hardware with recorded performance; no critical unresolved spatial errors; rollback build retained |

M1 and M2 can progress independently after M0. Worker orchestration in M5 can start with synthetic captures while M4 develops, but cannot pass its geometry gate until calibrated capture works. Recipe builders in M7 can similarly start against fixtures. Do not treat early scaffold completion as completion of these milestones.

### M0: establish a trustworthy baseline

- Inspect existing Swift implementations and stubs to identify reusable behavior and missing pieces. Preserve existing tests, but do not add a testing workstream to this migration plan.
- Scaffold the Expo app using compatible pinned dependencies from the PRD. Use development builds for native integrations. Keep existing server entry points working.
- Add schemas for revision/provenance, selected object versus destination, grouped operations, support/assembly metadata, and reconstruction manifests incrementally with their consumers.
- Add a development workspace with a sample room, manual command panel and selectable adapters. Each module owns its resources and exposes start, stop and dispose lifecycle methods.
- Establish an event envelope with session/calibration/scene/turn/tool/job correlation. Do not put raw audio, camera images, credentials, or signed upload URLs in diagnostic logs.

### M1: resolve native feasibility before committing to a stack

- Start with Vision Camera for the visual scan and RoomPlan as the LiDAR measured-shell candidate. Demonstrate camera ownership transitions; do not start competing rear-camera sessions.
- Prove that the tracked phase exposes the frame, projection, pose, and timestamps needed for hand targeting and live compositing. If a wrapper cannot expose them, build a local Expo native adapter or revise that wrapper choice.
- Align separate visual and tracked passes through explicit correspondences and reject unmatched frames. Capture intrinsics alone cannot locate an ordinary photograph in the room.
- Demonstrate an R3F object remaining anchored during translation and rotation, including portrait/landscape coordinate handling and foreground/background transitions. Record drift and registration error against visible reference points.
- Evaluate a settling backend on the actual Expo/Hermes build for gravity, compound collision shapes, contact reporting, fixed timestep, bounded iterations, and tunneling prevention. Do not assume a browser/WASM physics example works on native.
- Save the selected versions, native patches, unsupported devices and numerical tolerances in a decision record. A failed spike changes the implementation path; it must not weaken the product rule that settled objects are valid.

### M2–M3: make local manipulation reliable

Implement `committed → held/preview → resolving drop → settling → committed`. Preserve the original committed state until success. Preview transforms do not mutate history. While held, disable gravity and collision response; collision queries may still explain destination validity.

On release, validate support and intersection before simulation. Ask before a lateral alternative; otherwise restore the original pose. A valid floor drop settles under gravity while other objects remain fixed. Wall-mounted objects attach to their validated surface. No throwing and no implicit furniture stacking. Re-grab cancels settling; tracking loss or solver failure rolls back. Apply the same behavior to voice moves.

Use compound geometry to distinguish a chair under a table from a chair penetrating a table leg. Maintain design occupancy separately from real obstacles that a restyle visually removes. Implement atomic rollback for partially prepared multi-object changes and structural edits that invalidate dependent objects.

### M4–M5: capture and reconstruct the same room

Calibration guides a slow sweep, then asks for missing views instead of treating a full spin as sufficient. Preserve floor/wall/opening evidence and uncertainty. Unknown space cannot silently become verified floor space.

Extend Fastify with the PRD's calibration, reconstruction, job-status and deletion routes. Keep inference in a separate worker. Use per-session ownership checks, scoped uploads, job idempotency, bounded retries and revision-tagged results. Deletion revokes access and prevents a late worker from republishing artifacts; a cleanup process handles abandoned jobs and assets.

Implement segmentation → visible-background projection → hole completion → clean-shell asset manifest. Evaluate SAM-family masks and the LaMa baseline independently. Treat generated hidden content as inferred, never measured. Expose each stage’s output in the development workspace so masks and atlas consistency can be inspected from multiple viewpoints and an individual stage can be replaced.

Selected frame uploads remain scoped to session reconstruction. Use synthetic or explicitly permitted captures for development experiments, and confirm provider retention before promising cleanup. The proposed 24-hour maximum expiry must cover storage/job records and document any external retention limitation.

### M6–M8: integrate intent, generation and appearance

Keep one configured conversational model and direct Realtime WebRTC as the baseline. Issue ephemeral credentials through Fastify. Do not introduce an audio routing button. Backboard remains an optional adapter experiment after the baseline works; Jev is not a SAM replacement and no secondary conversational controller is needed.

Bind selected-object identity and pointing destination to the relevant speech turn, using a timestamped history and scene revision. Late tool calls must resolve against that context or request clarification. Duplicate tool deliveries cannot repeat edits. A voice edit during a grab joins the active transaction. Report actual ConstraintReports to the model rather than narrating success before commit.

Build frame, shelf, cabinet, table, bed and architectural templates as editable assemblies. Validate dimensions, connectivity, supports, declared load assumptions and authored span/joint rules. A cosmetic blue material does not imply a structural material change. Use bundled GLB variants where appropriate; do not execute model-generated code.

Restyle is one transaction spanning removal masks, generated objects and layout. Validate the entire proposed arrangement before commit. A failed furniture replacement restores both old design and visibility. Structural changes operate on design overrides, preserving measured observations and revalidating affected placements.

For live compositing, project the same world-space background rather than inpainting each camera frame independently. Preserve foreground hands and retained objects with depth/mask ordering. Record temporal artifacts, disocclusion errors, tracking failures and GPU/memory cost separately from model-generation time.

## Isolation for building and replacing components

### Stable interfaces, replaceable implementations

Feature code depends on domain interfaces, not concrete SDKs. Define the interfaces alongside the shared contracts; implementations live in adapters. Assemble the selected implementations in one application composition root and one server composition root. The spatial engine remains the sole writer of committed scene state.

```text
Hands / voice / touch → shared commands → spatial engine → scene state → renderer
Capture adapter → measured observations → calibration → reconstruction stages
                                            ↓                   ↓
                                      physical obstacles   inferred shell
```

SDK-specific objects, exceptions, buffers and response formats stay inside their adapters. Translate outputs into versioned domain contracts before publishing them. Each adapter declares its capabilities and returns explicit unavailable, unsupported or failed states. A new provider must not silently claim capabilities it lacks.

| Replaceable part | Stable input/output | What stays unchanged when replaced |
|---|---|---|
| Room measurement | Observations with poses, units, confidence and frame identity | Calibration UI and room-state consumers |
| Hand tracking | Timestamped cursor/gesture samples | Selection, commands and voice context binding |
| Segmentation | Aligned keyframes → instance masks and scores | Background projection and completion |
| Background completion | Atlas, hole mask and provenance → completed atlas | Segmentation and editable object generation |
| Settling backend | Candidate pose, collision shapes and support rules → settled pose or failure | Carry interaction, validation, transaction history |
| Voice transport/provider | Turn events, spatial context, tool requests/results | Editing tools and local spatial validation |
| Object builder | Validated recipe → assembly, render asset and collision/support data | Layout solver and edit UI |
| Rendering implementation | Scene snapshot, preview and tracked projection | Scene ownership, operations and undo |

Keep Vision Camera as the required scanning implementation and R3F as the selected renderer. These boundaries isolate their integration details; they are not a proposal to replace those choices now. Likewise, Fastify continues to host the backend, with provider SDKs and GPU workers behind server-side interfaces.

### Development workspace

Create a development-only screen that can open a sample room and enable a focused module view: capture/alignment, hand targeting, manipulation/settling, reconstruction stages, voice commands, or scene recipes. Each view uses the same production module interface. It can provide saved intermediate inputs so work on completion does not require recapturing a room, and work on the renderer does not require a live voice connection.

Select implementations through a typed development configuration, for example `segmentation: current | candidate` or `settling: current | candidate`. Keep the normal implementation as the default. Include module ID, version and configuration in diagnostics so a failure can be traced to the active implementation. Development selectors and sample-data controls do not appear in the product journey.

Use a separate development app identity and backend environment for experiments. Give each reconstruction attempt its own job ID and asset namespace. Candidate output stays separate until explicitly adopted; it must not overwrite the current room or the baseline implementation's artifacts. Upload authorization remains limited to the approved session reconstruction; selecting another adapter does not expand it.

### Failure containment and resource ownership

- Every asynchronous result carries session ID, scene/calibration revision and adapter-generation ID. Ignore results from a disposed adapter, old calibration or cancelled operation.
- Use one active camera owner and one active voice controller. Stop and dispose the old implementation before starting a replacement; never compare camera implementations by opening competing camera sessions.
- Give each adapter explicit ownership of its subscriptions, native buffers, audio tracks, timers and cancellation handles. Release those resources on shutdown and report cleanup failures.
- Keep the last valid committed scene when voice, reconstruction or settling fails. Report the affected capability; do not corrupt unrelated state. Tracking failure pauses spatial commits because reliable placement depends on it.
- Bound provider retries and job duration. A segmentation failure belongs to its job and does not crash the Fastify request process. GPU work runs in a separate worker process, allowing worker restart or replacement independently of the API.
- Native adapters share the app process, so an interface cannot contain every native crash. Diagnostics and a compatible previous app build remain necessary. Do not describe module boundaries as process-level crash isolation.

### How to insert a replacement

1. Implement the existing interface in a new adapter directory; keep the current adapter intact.
2. Declare capabilities and translate provider output into the shared contracts. If the interface must change, version it and provide a compatibility path rather than modifying every consumer at once.
3. Register the candidate in the composition root and enable it only in the development configuration.
4. Open the relevant module view with a sample room or permitted saved stage input. Inspect output and diagnostics, then demonstrate it in the integrated journey.
5. Adopt it by changing the selected adapter. Retain the previous selection for rollback until the replacement is established.

Switch session-bound modules at a clean session boundary. Cancel jobs and dispose resources before switching; do not hot-swap a physics engine mid-settle or a tracking provider while retaining incompatible anchors. A changed coordinate frame requires recalibration. Native dependency changes require a new development binary; compatible server-side provider changes can deploy independently.

Examples: insert a different mask provider without changing atlas completion; try another completion model using the same masks; replace the settling solver while preserving free carrying and undo; try a Backboard voice adapter without rewriting editing commands. Backboard must satisfy each specific output contract—it cannot replace segmentation merely because it accepts images.

### Build isolation per milestone

Each milestone owns a bounded module or vertical slice and exposes a small integration surface. Land interface changes first, build the implementation behind that interface, then wire it into the application. Keep unrelated dependency upgrades out of the same change. Maintain a runnable baseline while a candidate is incomplete.

M0 provides the registry, development workspace and lifecycle conventions. M1 isolates native integrations. M2–M3 isolate commands and settling. M4–M5 isolate calibration and each reconstruction stage. M6 isolates conversational transport. M7 isolates builders and layout recipes. M8 consumes the established scene and camera contracts for compositing. M9 assembles the selected implementations and records known limitations.

No new automated test suites, testing packages or testing CI workflows are planned. Existing repository tests remain untouched. Milestones use working demonstrations and diagnostics to show implementation progress.

## Diagnostics and cutover

At M1, record alignment drift, frame/pose skew, frame rate, memory, settling duration and placement tolerances on the development device. At M5, expose masks, projected backgrounds and completed surfaces separately so a bad result can be traced to the responsible stage. Keep these measurements and overlays available when inserting a replacement.

Retain the PRD's sub-1.2-second interactive-edit target, measuring from completed utterance to first correct visible edit for simple commands. Report final settled-commit latency separately. Record p50/p95 over a fixed scenario run, along with conditions and failures. Reconstruction and new asset creation have separate progress and completion measures. Include a sustained device session to expose camera buffer leaks, thermal slowdown and memory growth; a short demo is insufficient.

Each diagnostic failure should identify the responsible stage: capture/alignment, targeting, command parsing, constraint validation, settling, reconstruction, or compositing. Keep the original/measured/empty/design overlays and include a sanitized replay reference where possible.

M9 is complete only when the documented core journey works on supported hardware, the selected modules integrate correctly, and blocking limitations are resolved. Optional world-model and Backboard research does not block the baseline release. If furnished-room reconstruction or camera integration fails its gate, keep the migration incomplete and revise that subsystem; do not silently substitute a static concept image for the live editor.

Cut over in stages: internal fixture build → device development build → integrated staging build → release candidate. Keep the existing iOS app build and backward-compatible server routes available until the Expo candidate is accepted. Use a separate staging backend during development. Rollback means restoring the previous app build and compatible server deployment; native camera/module regressions require a compatible binary, not an assumption that a JavaScript update can fix them.

This document is a plan only. Module implementation, dependency installation, device demonstrations and cloud experiments remain future milestone work.
