# Reality Editor — Expo implementation and architecture PRD

Status: proposed, revised after product feedback. Research date: 2026-09-18.

## 1. Product outcome

Open the camera, calibrate the surrounding room, preview it without unwanted furniture, and redesign it using coordinated hands and voice. The app should work with an empty room and a furnished room. People do not create a project, register furniture, or manually assemble a room before using it.

The product is a live, session-based spatial editor. Its central example is: point at a wall and say “make this a blue bedroom with three frames here,” then adjust the result with gestures or speech.

Keep Expo and React Native Vision Camera. Prefer ecosystem components, but explicitly identify places where a native adapter or reconstruction research is still required. A richer rendering ecosystem alone does not resolve hidden geometry.

Removed from initial scope: furniture registration, reopen-project journeys, offline operation, React Native Filament, and Meshy. Diagnostics remain required. Implementation isolation means replaceable modules, stable interfaces and independent development views, not a testing workstream; see the [implementation plan](implementation-plan-expo.md). COLMAP remains an unresolved research option, not an implementation dependency. Existing tests are not deleted.

## 2. Revised journey

### Calibrate the space

1. The camera opens with “Slowly turn around and show the room.” A coverage guide highlights missing directions and surfaces.
2. Ask the user to show the floor and ceiling boundaries. Where furniture blocks an important boundary, request a short sideways movement or another viewpoint: “Step left so I can see beside the sofa.” A spin is an initial coverage gesture, not a guarantee of sufficient reconstruction.
3. Estimate the architectural shell: floor, walls, ceiling, openings, and dimensions. Automatically identify visible foreground objects without an object-registration screen.
4. Build an empty-room preview, retaining observed structural surfaces and completing occluded regions. Mark uncertain geometry in the calibration overlay and ask for another view when it affects placement.
5. Offer “use this space” once the room is usable. Missing appearance detail can improve asynchronously; missing essential geometry cannot silently become a precise measurement.

No fixed scan-duration promise. Completion is based on coverage and tracking quality. Calibration has visible states: observing, needs another view, reconstructing, ready, and failed/retry.

### Edit with hands, voice, or both

Hands and voice operate the same command system. Every exposed manual editing action has a voice equivalent; this does not mean recognizing every arbitrary human motion.

| Action | Hands/touch | Voice | Combined example |
|---|---|---|---|
| Select | Point and dwell, or tap | Name or describe an object | Point: “this one” |
| Move | Pinch/grab and drag | Name a destination or an offset | Select chair, point at floor: “put it here” |
| Resize | Resize handle or pinch gesture | Specify width, height, depth, or relative change | Hold selection: “make it 20 centimetres wider” |
| Rotate | Rotation gesture or handle | Specify an angle or facing direction | “Face this toward that window” |
| Appearance | Material/color control | Specify color/material | Point at wall: “make this blue” |
| Add/count | Add/duplicate control | Specify object type and quantity | Point at wall: “three frames here, evenly spaced” |
| Remove/restore | Selected-object action | Remove, restore, undo | Point: “remove that, keep the lamp” |
| Room structure | Boundary/opening handles | Change virtual dimensions or openings | Point: “make this doorway wider” |

The selected object and the destination are separate references. “Move this there” must not replace the selected object when the user points at the destination. Show target and destination highlights before committing an ambiguous interpretation.

Physical hand tracking uses the rear-camera-visible free hand; touch is an equivalent input and fallback. Two-hand gestures are optional because the user may hold the phone in one hand.

### Restyle in place

1. Determine whether the target area contains objects that the request removes, replaces, or preserves.
2. For furnished areas, mask unwanted objects and produce a clean background before placing replacements. In an empty area, place directly without an unnecessary erase pass.
3. Generate a structured layout and editable objects, then fit them to the available room surfaces and clearance constraints. Validate the complete layout together so newly generated objects cannot overlap each other or be piled up to satisfy an object-count request.
4. Render progressively in the calibrated space. Support follow-ups such as “three frames instead of two,” “narrower bed,” “darker blue,” and “move the wall in by half a metre.”
5. Undo restores the previous layout and its removal masks together. A restyle is a grouped transaction.

Virtual structure edits change the proposed design, not the measured observation. They invalidate affected placements and require re-solving. Structural integrity means physically plausible geometry and construction: objects fit the space, balance on their supports, connect coherently, and have a believable load path. This applies to generated furniture as well as room edits; it is not a request for renovation-safety certification.

## 3. RoomPlan, reconstruction, and world models

### What RoomPlan contributes

Apple RoomPlan supplies parametric surfaces and furniture bounds, including transforms, dimensions, identifiers, and confidence. Its guidance addresses scan motion, lighting, and distance. Apple's documentation describes challenging conditions such as mirrors, glass, dark surfaces, and obscured windows. It is designed to recognize furniture in rooms; the presence of furniture is not itself an unsupported scenario. [Apple RoomPlan walkthrough](https://developer.apple.com/videos/play/wwdc2022/10127/)

`expo-roomplan` exposes that capability to React Native and can return exported JSON and USDZ locations. It does not add a different reconstruction algorithm or solve occlusion independently. Verify the chosen release's native compatibility and access to the data needed below. [Expo RoomPlan repository](https://github.com/fordat/expo-roomplan)

Recommendation: retain RoomPlan as the preferred measured-shell candidate on LiDAR iPhones, not as the renderer, texture-reconstruction system, or source of guaranteed hidden-wall geometry. Where the scan misses a wall behind a wardrobe, use additional observations first, then a labeled geometric hypothesis. No sensor or world model can prove the appearance of a never-observed surface from this capture alone.

Removing furniture nodes from RoomPlan output creates an empty geometric shell. It does not remove those objects from camera pixels. This distinction is central to the architecture.

### Proposed empty-room pipeline

`capture → align observations → estimate shell → segment foreground → collect visible background → complete holes → render clean shell → place editable content`

- Maintain three separate representations: observed geometry, inferred shell/background, and proposed design.
- Associate keyframes, masks, camera intrinsics, poses, and depth when available. Every association carries timestamps and coordinate-frame identity. Do not invent poses for ordinary Vision Camera photos.
- Use segmentation to find removable furniture, including objects outside RoomPlan's recognized categories. Preserve doors, windows, built-in fixtures, and user-selected items; allow correction of a bad mask.
- Project visible background into shared wall/floor texture atlases. Reject foreground pixels and depth-inconsistent observations.
- Complete unobserved geometry using constrained surface hypotheses; complete appearance using texture continuation or inpainting. Record which parts were inferred.
- Use one consistent world-space representation across viewpoints. Independent inpainting of each camera frame would introduce flicker and changing geometry.
- Validate a generated update against the current calibration revision. A late job must not overwrite a newer room or undo.

For an empty room, skip furniture removal while retaining coverage checks. For a furnished room, keep the measured physical obstacles separately even when they are visually erased, so the UI does not describe the real floor as unobstructed.

### Research options for your decision

| Component | Proposed role | Evidence and remaining limit | Recommendation |
|---|---|---|---|
| RoomPlan through `expo-roomplan` | Measured room-shell seed | Parametric structure and object bounds; hidden regions remain uncertain | Preferred LiDAR measurement candidate |
| SAM 3 / SAM 3.1 | Promptable furniture masks and temporal tracking | Official implementation supports text/visual prompts and image/video segmentation; it does not fill backgrounds | GPU worker candidate; not a phone-per-frame dependency. [Source](https://github.com/facebookresearch/sam3) |
| LaMa | Baseline masked-image filling for projected background textures | A concrete inpainting implementation, already related to this repo's work; older baseline, not a claim of current best quality | First implementation baseline; compare visually before choosing a heavier model. [Source](https://github.com/advimman/lama) |
| World Labs Marble World API | Generate a coherent spatial appearance hypothesis from capture references | Official API supports asynchronous world generation from text and visual inputs; reviewed material does not guarantee metric reconstruction or removal of all furniture from the exact input room | Optional world-model experiment; never authoritative for measured bounds. [API announcement](https://www.worldlabs.ai/blog/announcing-the-world-api) |
| COLMAP | Potential multi-view reconstruction alternative | Capture/processing/deployment pipeline unresolved | Keep in research backlog; do not block the first prototype |

A generated whole-room world is not automatically a collection of independently editable furniture objects. Keep the empty shell and newly placed objects separate even if a world model improves background appearance. Gaussian-splat browser examples also do not establish Expo-native renderer compatibility. [World Labs official examples](https://github.com/worldlabsai/worldlabs-api-examples)

Cloud processing of selected camera frames is approved for this session's reconstruction. Upload selected calibration keyframes and the metadata needed to align them, rather than continuously uploading the raw camera stream. Use temporary session storage and visible reconstruction progress. On reconstruction failure, preserve the last usable preview and offer retry; do not silently replace the requested result with an offline-mode promise. Use of a particular external world-model provider remains a product choice.

## 4. Rendering and new-object generation

React Three Fiber is the recommended editable-scene renderer. It is a React renderer for Three.js, not a model-generation service. Use `@react-three/fiber/native`, `three`, and `expo-gl` for the native scene. Native feature and asset-loader compatibility must be demonstrated rather than inferred from web examples. [React Three Fiber](https://r3f.docs.pmnd.rs/), [Expo GL](https://docs.expo.dev/versions/latest/sdk/gl-view/)

### Concrete creation pipeline

`voice/gesture intent → scene recipe → parameterized model builders or bundled assets → layout solver → R3F scene → subsequent edits`

The scene recipe contains object families, quantities, dimensions, materials, target surfaces, and layout relations. Model output is validated data, not executable JavaScript or JSX.

Initial model builders: frame, shelf, cabinet, table, bed, and primitive architectural elements. Build these from controlled geometry with editable dimensions and materials. Use bundled GLB models for detailed variants; a procedural version remains available when no suitable asset exists. An unsupported object gets a clearly labeled approximation or a clarification, not a claimed exact reconstruction. There is no user-facing furniture registration.

### Non-overlapping placement and intentional support

Placement validity is a hard requirement for every committed scene, whether produced by generation, voice, hand manipulation, resizing, replacement, or structural edits.

- Committed objects cannot penetrate other objects, floors, walls, or ceilings. Temporary overlap while carrying is allowed under the interaction below. Ordinary contact with an assigned support surface is allowed within a small numerical tolerance; visual overlap from the camera's perspective is not itself a 3D collision.
- Floor-standing furniture defaults to floor support. The solver must not lift a bed onto a desk or stack chairs simply because the requested floor area is occupied.
- Placement on another object requires an explicit, compatible support relationship. A lamp on a tabletop or books on a shelf can be valid; arbitrary furniture piles are not. Validate contact region, available area, support stability, and the construction rules of both objects. Unknown support capacity must not be reported as verified.
- Wall-mounted items need a valid mounting surface and must avoid openings and each other. Placement must preserve configured door swings, access paths, and functional clearances.
- Collision geometry follows the object's shape: use compound bounds or simplified convex parts for legs, frames, and open spaces. Start with broad bounding-volume checks, then refine potential conflicts. A chair fitting beneath a table must not be rejected solely because their enclosing boxes overlap. If only coarse geometry is available, report uncertainty rather than claim exact fit.
- Restyling validates new objects against each other, retained objects, and the proposed room structure as one transaction. If the arrangement cannot fit, propose fewer or smaller items or a different layout. Never silently stack, shrink, or intersect objects to satisfy the prompt.
- During a drag or resize, show the proposed drop validity without blocking manipulation and retain the last valid committed state. On release, resolve the candidate and settle it before committing. For voice edits, use the same release behavior without silently changing the intended support surface or destination region.
- Keep two collision layers: the proposed design and observed physical obstacles. Replacing a visually erased sofa with a bed may be a valid redesign, but the sofa still occupies that location physically. Mark that replacement as requiring physical removal; retained real objects remain placement obstacles. Hidden pixels never imply physically empty space.

Example: “put a bed and two nightstands here” must produce three distinct footprints with usable spacing. If they do not fit, explain the shortfall and propose an adjustment. “Put this lamp on that nightstand” explicitly selects a support relationship and must keep the lamp above the top surface, rather than embedded in its mesh.

### Free carrying, physics on release

Confirmed interaction: objects may pass through other objects and architectural boundaries while held or being repositioned by voice. Physical plausibility is enforced at the destination, not along the carrying route. This supersedes the earlier conversational suggestion of collision-constrained carrying and doorway motion planning.

Use the state sequence `committed → held/preview → resolving drop → settling → committed`. Cancel or unsuccessful resolution returns to the pre-move committed state.

- While held, the object follows the hand or voice-directed transform without gravity, collision response, or pushing other objects. Keep its dimensions unchanged unless resizing is requested. Collision queries may show drop validity, but must not obstruct movement.
- Releasing a gesture or completing a voice move requests a drop. Validate the destination against the intended support and room constraints. If the candidate intersects another object, propose a nearby valid pose; do not start gravity simulation with deeply overlapping bodies or use physical impulses to force them apart. Require confirmation of a lateral adjustment; otherwise restore the original pose and explain the conflict.
- For a valid nonintersecting drop, apply gravity and collision handling during settling. Prevent tunneling through surfaces during this stage. Other scene objects remain fixed initially, so dropping one object does not scatter the room. No throwing or momentum transfer from hand motion in the initial interaction.
- Settling must end on an allowed support. Floor-standing furniture still cannot land on another furniture item merely because it lies beneath the drop. Reject or propose another drop when that support would be inappropriate. Wall-mounted items attach to their validated mounting surface instead of falling under gravity.
- Commit only after stable contact and placement/construction validation succeed. If settling fails, remains unstable, loses reliable geometry, or is interrupted by tracking loss, restore the pre-move state. Re-grabbing cancels the settle attempt and resumes the same manipulation transaction.
- One completed move produces one undoable operation from the original pose to the settled pose. Intermediate animation frames do not become edits. Structural/construction rules still apply after resizing or changing orientation.

Example: carry a rigid table through a doorway even if it would not physically fit through that opening, then release it in the other room. It settles on valid floor space without intersecting other furniture. This is a design relocation, not a claim that the real table could be transported through the doorway. The destination room needs known or explicitly confirmed geometry, but a collision-free connecting route is not required.

Implementation boundary: the placement validator and the settling simulation are separate parts of the local spatial engine. R3F displays their state; it is not itself a physics solver. Selection of an Expo-compatible settling implementation remains an implementation research item, with diagnostics for drop resolution, contacts, instability, and restoration.

### Physically plausible object construction

Add a construction validator alongside the room-placement solver. The scene recipe must describe an assembly, not just a decorative mesh: parts, dimensions, structural material class, joints, support/contact regions, and template-specific permissible ranges. Keep a cosmetic material such as blue paint separate from a structural material such as wood or steel.

- Check spatial fit, unwanted intersections, positive dimensions, connected parts, and contact with the intended support surface.
- For freestanding designs, check the projected combined center of mass against the support polygon with a margin under the template's declared load cases. Use assumed masses only when the template declares them; unknown loads produce an unknown result. This is a balance check, not proof of strength.
- Use authored construction rules for frame spans, member thicknesses, joint locations, bracing, and attachment requirements. Do not let the voice model invent material strengths or load ratings.
- Recompute these checks after a change to width, height, depth, supports, or structural material. A color-only edit does not change construction.
- Distinguish valid-within-template, needs-adjustment, unsupported, and unknown results. Do not present a construction as physically plausible merely because it rendered successfully.

For “make a three-legged bed,” select a dedicated three-support bed assembly rather than delete a leg from a four-leg mesh. The builder must account for support placement, foot/contact area, frame bracing, and asymmetric loading near the mattress edges. If a permitted arrangement cannot satisfy the declared construction rules, propose wider supports, a different support layout, or another design. Show an unvalidated concept only when explicitly labeled as such. Detailed strength analysis is outside this prototype; the initial physical-plausibility claim is limited to declared template rules.

For “make a blue bedroom with three frames instead of two”:

1. Identify the room and pointed wall from the current interaction context.
2. Interpret blue as the room palette unless the user targets one object.
3. Change the frame group's desired count to exactly three, retaining stable identities for reusable instances.
4. Build the additional frame from its parameterized template and recompute equal spacing within the usable wall region, excluding openings.
5. Fit the bed and other requested furniture to the shell and clearance rules. If three frames cannot fit at their current size, propose a smaller size or another wall.
6. Commit one scene transaction. Follow-up color, count, and dimension changes update those same objects.

Rendering targets:

- **First usable milestone:** a reconstructed empty room aligned to the live tracked camera, containing independently editable generated objects.
- **Target live composite:** retain unaffected real pixels, replace unwanted furniture pixels with the reconstructed shell, and draw new objects with consistent depth ordering. Preserve the user's foreground hand so erasure does not hide the interaction.
- Changing the actual room boundary in a design can require rendering the proposed room rather than overlaying it on an incompatible camera image. Label the view as a design preview.

The first milestone is not equivalent to completing live diminished reality. Report that distinction in progress and diagnostics.

### Camera ownership and the integration gap

Vision Camera remains the visual scanning/capture package. RoomPlan/AR tracking needs a separate session owner unless an explicit native shared-session integration is implemented. R3F does not supply camera tracking, raw AR frames, or calibrated depth.

The first prototype must settle this concrete boundary:

- Vision Camera captures visual observations during calibration.
- A tracked spatial provider supplies geometry, camera transforms, projection matrices, and AR-frame access during world-aligned editing.
- If observations come from separate capture passes, register them explicitly using visual correspondences and shell constraints. Unregistered photos remain reference images and must not be projected into atlases.
- Hand detection during tracked editing consumes that same tracked camera feed. Do not open a second rear-camera session for it.

ViroReact remains a possible tracking/rendering alternative, not the default second renderer. Its raw-frame access has an open feature request; built-in object detection alone does not establish arbitrary hand-inference support. A small Expo native adapter may be required for synchronized frame/pose/depth delivery and texture interop. This is an explicit implementation risk, not a verified npm-only integration. [Viro frame-access issue](https://github.com/ReactVision/viro/issues/471)

If the shared-frame integration cannot support the required interaction, pause that architecture choice rather than quietly shipping independent unsynchronized camera feeds. The R3F editor and procedural models can progress against recorded calibration data meanwhile.

## 5. Hands and voice share one spatial context

Use MediaPipe Hand Landmarker as the hand-tracking candidate. Its image landmarks and hand-relative world landmarks do not by themselves establish a room-space pointing ray. React Native wrappers exist, but compatibility with Vision Camera 5 and the selected tracked provider is unverified. [Google hand landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker), [React Native wrapper](https://cdiddy77.github.io/react-native-mediapipe/docs/api_pages/hand-landmark-detection/)

Begin with the repo's existing interaction meaning: the fingertip is a visible movable cursor. Unproject its image position through the synchronized camera projection and intersect the resulting ray with room/object geometry. This is not an anatomical finger-axis estimate. Show the cursor and selected target so users understand what pointing means.

Input processing:

1. Timestamp camera pose, hand landmarks, gesture state, and speech events on a common monotonic timeline.
2. Maintain a short history of pointing samples, selected entity, destination hit, confidence, and scene revision.
3. Latch the selected object at grab/selection time. Bind destination pointing to the relevant speech turn rather than whichever frame exists when a network tool call eventually arrives.
4. Provide the voice model with entity candidates and a spatial target handle. The approved reconstruction upload does not automatically authorize continuous camera streaming into the voice session; annotated voice-image input remains a separate optional feature.
5. Reject stale context or clarify close candidates. During tracking loss, keep the last committed scene and stop positional commits until targeting is reliable.
6. Gestures provide continuous local previews. A voice update to the same object updates the active manipulation transaction; it does not start a competing writer. Gesture release or voice completion starts drop resolution and settling; commit only the valid settled result, and let cancel/undo revert the grouped result.

Pointing at an unobserved region does not create a valid floor/wall hit. Ask for a better view or use an explicitly indicated inferred surface.

## 6. One voice model and a flexible backend

Use one configured OpenAI Realtime model over WebRTC. Retain `gpt-realtime-2.1` as the previously researched baseline; no model selector or audio-route UI. The same conversational model issues direct edit tools and structured scene-recipe tools. Dedicated segmentation/inpainting models, if adopted, are vision processing components rather than additional conversational agents.

The model receives scene context and returns intent. The on-device engine computes and validates actual placement, then returns the result for speech. Realtime supports image input and function calling, but raw image understanding is not a substitute for synchronized pointing context. [Official OpenAI documentation](https://developers.openai.com/api/docs/guides/realtime-conversations)

Retain the existing Fastify/TypeScript backend and Zod validation. Extend it with the session, reconstruction-job, provider-integration, and cleanup endpoints below. Keep heavy GPU jobs in separate workers and return job IDs; do not run GPU inference in the HTTP request loop. Workers may use Python where model libraries require it, without replacing Fastify or introducing FastAPI as an application requirement.

Proposed endpoints:

- `POST /voice/session`: issue a short-lived Realtime credential; provider keys stay server-side.
- `POST /calibrations`: create an ephemeral capture session and return scoped upload instructions for selected reconstruction keyframes.
- `POST /calibrations/{id}/reconstruct`: start segmentation, shell completion, and appearance processing.
- `GET /jobs/{id}`: report queued/running/completed/failed state and result manifests, with scene revision identifiers.
- `DELETE /calibrations/{id}`: dispose of temporary capture data and cancel outstanding work where possible.

Voice audio stays on the direct WebRTC path. Keep normal interruption handling, teardown, and OS audio interruptions internally, without adding routing controls to the product UI.

The app has session memory and temporary assets, not a reopen-project feature. A disconnected session shows that live services are unavailable; no offline-mode workstream. Local undo history is session behavior, not a promise of persistent projects. Proposed server upload expiry: 24 hours maximum and earlier deletion when the session ends; confirm provider retention separately before enabling an external world-model service.

## 7. RSG, Op, SCP, and ConstraintReport in plain language

These are small data contracts that let the camera, renderer, hands, voice model, and spatial engine agree. They are not four AI models or four servers.

| Contract | Meaning and purpose | Example |
|---|---|---|
| **RSG — Room Scene Graph** | The app's structured description of the room and objects: identities, dimensions, poses, surfaces, materials, and relationships. It is the state the renderer draws and the solver reasons about. | Wall A is 3.8 m wide; frame group B contains three frames anchored to A. |
| **Op — Operation** | One requested/committed edit, with an identity and enough information to undo it. Both hands and voice create operations. | Change frame group B from two frames to three. |
| **SCP — Spatial Context Packet** | A compact, timestamped explanation of the user's current spatial attention: selected object, pointing candidates, destination, room revision, and relevant free space. | The user selected the chair and is pointing at a floor patch beside the window. |
| **ConstraintReport** | What the placement and construction validators accepted, changed, or rejected and why. The assistant narrates this actual result. | Moved the chair 15 cm to clear the door; or rejected a bed support layout because an edge-loading case falls outside its support region. |

Example: point at a chair, then point near the window and say “put that here.” SCP binds the chair and destination to that turn. The model requests an Op. The engine checks it against the RSG, commits a valid change, and emits a ConstraintReport. The renderer updates and the assistant describes what actually happened.

Keep those existing names internally, but use “room state,” “edit,” “interaction context,” and “placement result” in product discussions. Extend the schemas rather than introducing a competing untyped scene representation.

Required additions include calibration revision, coordinate-frame identity, observed versus inferred provenance, removal-mask references, selected target versus destination, grouped edits, procedural-object parameters, assembly/support metadata, collision proxies, physical-obstacle versus design occupancy, construction-rule results, and timestamped interaction references. Constraint reports identify conflicting entities, unsupported stacking, clearance violations, uncertainty, and proposed alternatives. Store the measured shell separately from editable design overrides. Construction results identify the template and assumptions used; a constraint report must not claim engineering verification beyond those checks.

## 8. Proposed package and service choices

| Area | Choice | Status |
|---|---|---|
| App | Expo SDK 57 baseline, Router, TypeScript, development builds | Retained; pin compatible versions during implementation |
| Visual capture | Vision Camera 5 and required Nitro dependencies | Required |
| Frame processing | Vision Camera worklets/resizer; a MediaPipe-compatible integration | Compatibility work required |
| Room measurement | `expo-roomplan` plus a spatial-provider boundary | Recommended LiDAR candidate; further frame/pose export work may be necessary |
| Editable rendering | `@react-three/fiber/native`, `three`, `expo-gl` | Recommended; AR texture/projection integration remains explicit |
| UI state/interaction | Zustand, Reanimated, Gesture Handler | Retained |
| Voice | `react-native-webrtc`, one Realtime model | Retained |
| Backend | Existing Fastify/TypeScript, Zod, and separate GPU workers where needed | Retained and extended |
| Masking/completion | SAM 3 family + LaMa baseline | Cloud processing approved for session reconstruction; selected models still require implementation profiling |
| World-model research | World Labs Marble API | Optional candidate, not measured truth |
| Diagnostics | Sentry plus structured session events and developer overlays | Required |

No React Native Filament, Meshy, or persistent project database. Replaceable adapters, development module views and failure boundaries are defined in the [implementation plan](implementation-plan-expo.md). No new testing workstream is planned.

## 9. Implementation sequence and diagnostics

### Delivery sequence

1. **Capture and alignment feasibility:** establish one camera owner per phase, frame/pose alignment, hand-frame access, and an R3F scene that follows the tracked camera. Record exact dependency versions and gaps.
2. **Calibration journey:** coverage guidance, room-shell estimation, furnished/empty classification, uncertain-region prompts, and automatic foreground discovery.
3. **Empty-room preview:** world-space masks, observed-background accumulation, provisional completion, and a stable reconstructed shell. Keep original observations for comparison.
4. **Unified editing:** timestamped hand/voice context, shared commands, gesture previews, local constraints, and grouped undo.
5. **Scene creation:** procedural object families, catalog variants, structured recipes, room-aware placement, count changes, construction plausibility checks, and structural design edits.
6. **Live compositing:** replacement of unwanted real pixels, foreground-hand preservation, occlusion handling, temporal consistency, and incremental appearance refinement.

The [implementation plan](implementation-plan-expo.md) expands this sequence into dependency-ordered milestones, working demonstrations, and independently buildable modules with replaceable adapters. Diagnostics remain required throughout. No claim of compatibility, reconstruction accuracy, or real-time performance is made before the corresponding device work.

### Diagnostics required from the first prototype

- Correlate calibration ID, scene revision, frame timestamp, voice turn, model call, operation, and GPU job.
- Overlay tracking quality, coverage, inferred surfaces, object masks, fingertip cursor, selected object, destination ray, and depth mismatch.
- Record camera ownership transitions, frame drops, inference duration, reconstruction stages, memory pressure, render FPS, and speech-to-visible-change latency.
- Log each tool request, validation result, operation result, and rejection reason without recording raw media or credentials by default.
- Record construction-template identity, assumptions, support regions, failed load cases, and automatic design adjustments; overlay support polygons and centers of mass in the developer view.
- Overlay collision volumes, conflicting object pairs, support surfaces, physical obstacles, and clearance regions; log why a proposed placement was rejected or adjusted.
- Record held/drop/settling state transitions, contact events, rejected support surfaces, settling duration, and reasons for restoring the original pose. Distinguish allowed carry-time overlap from invalid committed overlap.
- Surface failed capture, lost tracking, poor coverage, reconstruction timeout, unsupported recipe, and stale job results as specific recoverable states.
- Provide a developer switch between original camera, measured shell, completed empty shell, and final design to locate the failing stage.
- Measure initial generation separately from interactive edits. Retain the existing sub-1.2-second interactive-edit target as a target, not a promise for reconstruction or new asset creation.

### Confirmed choices and remaining research

1. Confirmed: selected camera frames may be uploaded for this session's empty-room reconstruction.
2. Confirmed: generated objects must be physically plausible in both placement and construction, including unusual designs such as a three-legged bed. No committed intersections or accidental stacking; intentional supported placement is validated explicitly. Carrying may pass through objects and doorways; release triggers destination validation and physics-based settling for both hands and voice.
3. Remaining research: determine whether RoomPlan's measured shell plus completion is sufficient, or whether to invest in a non-Apple reconstruction pipeline. A world-model option remains available for review without claiming measurement equivalence.

Implementation has started; see the [implementation status](expo-implementation-status.md) for completed code and remaining device/reconstruction work. No uploads or model calls were made during this implementation.

## 10. Backboard.io assessment

Status: candidate integration, not an adopted replacement. Reviewed public documentation on 2026-09-18; no authenticated model-catalog query, inference call, or latency measurement was performed.

### Jev is a decision model, not a segmentation model

Backboard documents TypeSafe Jev under System One models. It returns named choices, rubric scores, and proposition probabilities. Its documented configuration uses `llm_provider: "typesafe"`, `model_name: "jev-latest"`, `stream: false`, and `system_one.questions` through `POST /threads/messages`. Results are under `system_one.answers`. This is a hosted call rather than a SAM-style GPU deployment. [Jev documentation](https://docs.backboard.io/concepts/system-one)

Possible application use: classify a transcript/context summary as move, resize, restyle, or clarify. This is optional; the existing voice model already interprets requests. Do not add another blocking call to every hand or speech event without demonstrated benefit. Jev does not replace segmentation masks, measured geometry, collision detection, or construction validation. Its probability output must not authorize a placement that fails the local solver.

### Where Backboard fits

| Project requirement | Documented capability | Assessment |
|---|---|---|
| Interpret commands and produce scene recipes | Model routing, tool calling, and model capability filters | Good candidate for a server-side AI adapter; validate outputs against our schemas |
| Classify ambiguous edit requests | Jev typed decisions | Optional helper operating on supplied context, not an authoritative spatial resolver |
| Empty-room appearance concepts | Image-to-image generation | Candidate for visual previews; no guarantee of room geometry preservation |
| Furniture masks / SAM replacement | No equivalent mask-producing endpoint verified in the reviewed documentation | Retain a separate segmentation provider until Backboard supplies a concrete supported model and output contract |
| Exact masked filling | Stateless image API has no dedicated mask/inpainting file input | Not a drop-in replacement for our mask-guided completion stage |
| Live voice and custom tools | Native realtime audio over WebSocket | Credible alternative transport; needs mobile PCM capture/playback integration and latency instrumentation |
| Collision-free, plausible layouts | No deterministic spatial solver established | Remains our local engine's responsibility |
| Long-term assistant memory | Available, but outside the session-based product requirements | Leave disabled |

Model discovery: query `GET /models` for the required capabilities and confirm a specific model/provider combination. A vision-input or image-output flag does not establish segmentation support. Exact account availability remains unverified. [Model catalog](https://docs.backboard.io/concepts/models)

The image API accepts a base image and references through `operation: "generate_image"`; references are not mask layers. Inspect returned `generated_media` rather than extracting links from prose. Recommendation: consider it for appearance ideas, not as the sole source of the measured empty-room shell. [Image API](https://docs.backboard.io/sdk/stateless-images)

### Voice integration option

Backboard's documented native realtime endpoint is `wss://app.backboard.io/api/threads/realtime`. It offers single-use connection tickets issued by a trusted backend. This is a WebSocket integration, not a drop-in replacement for the proposed WebRTC client. [Realtime reference](https://docs.backboard.io/api-reference/threads/realtime)

The client supplies PCM capture, resampling, playback buffering, and interruption handling. Use the negotiated audio format. This introduces integration work that the current WebRTC approach handles differently; no measured latency comparison is available. [Audio guide](https://docs.backboard.io/concepts/native-realtime-audio)

For a Backboard voice prototype, preserve our `VoiceSession` interface and implement a separate transport adapter. Send SCP-derived context through supported session/provider events. Execute only client-owned tool calls, return local ConstraintReports, and cancel pending work when instructed. Realtime uses socket tool outputs, not the REST text-run tool-output protocol. Keep one configured conversational model. Verify that the intended model exists in the realtime catalog rather than assuming a chat-model listing implies realtime support. [Realtime reference](https://docs.backboard.io/api-reference/threads/realtime)

For ordinary text tools, Backboard returns calls for application execution and subsequent result submission. Early tool events are previews; commit scene edits only after a confirmed call, with idempotency and scene-revision checks. [Tool calls](https://docs.backboard.io/sdk/tool-calls)

### Proposed adoption path

1. Keep provider keys in our backend and add a `BackboardAIProvider` boundary. Backboard is an external AI service; our backend still owns session authorization, reconstruction jobs, temporary storage, and cleanup.
2. First evaluate it for noninteractive scene planning or appearance generation. Use an explicitly selected model; our backend passes structured recipes to the same local validator and renderer.
3. Keep hosted SAM segmentation and a mask-aware completion provider independent. Do not replace them with Jev based on model-category similarity.
4. If consolidating voice is valuable, implement the separate ticket-based WebSocket adapter and compare instrumented speech-to-edit latency, interruption behavior, and hand-context freshness. Do not run two concurrent conversational controllers.
5. Leave Jev out of the default path unless classification improves a specific workflow. Record request/model identifiers, resolved model version, latency, usage, and parsing failures in diagnostics.

One possible arrangement is:

`Expo → application backend → Backboard for selected AI tasks`

`Expo calibration → application backend → segmentation/completion providers`

`hands + voice commands → local spatial/construction validators → R3F`

This is a recommendation for incremental adoption, not approval to switch the selected voice architecture or send media to an additional provider.

### Session retention and feasibility limits

Disable cross-session memory. Backboard's “stateless” generation still stores messages/media metadata and files; it does not mean zero retention. Threads do not expire automatically. Track created identifiers, arrange deletion, and confirm media and downstream-provider retention separately before making our proposed expiry promise. [Stateless behavior](https://docs.backboard.io/sdk/stateless-calls), [Thread lifecycle](https://docs.backboard.io/concepts/threads)

Before selecting Backboard for segmentation, obtain a concrete model identifier and an example response containing per-instance masks, dimensions/coordinate conventions, and scores; for video, also verify stable tracking identifiers. The public material reviewed did not establish these capabilities. A vendor demonstration of “recognizing furniture” is insufficient evidence for reusable masks or metric 3D reconstruction.
