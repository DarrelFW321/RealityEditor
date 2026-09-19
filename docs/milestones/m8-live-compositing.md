# M8 — Live compositing and foreground preservation

Status: in progress; M8-A native texture feasibility spike and diagnostic views implemented, native build/device gate unverified. Final compositing and milestone acceptance remain open. Updated 2026-09-19. See [implementation evidence and device handoff](../m8-native-texture-feasibility.md).

References: [shared milestone baseline](../implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), [product requirements](../prd-expo-migration.md), [M7 scene transactions](m7-creation-and-restyling.md).

## Goal and required end state

Replace unwanted furniture pixels with the reconstructed background while keeping the live camera, retained objects, hands, and new virtual content correctly ordered.

At completion, removing or moving a real object changes its original appearance in the live view, remains stable during camera movement, and reverses correctly with undo. The composite sustains at least **30 FPS** during the acceptance session; 55–60 FPS is an optimization target.

Dependencies: accepted M5 shell/atlas artifacts and calibration identity, M6 input/lifecycle coordination, and M7 transactional visibility intent. The native texture feasibility step can start during M6; final compositing integration depends on M7.

A reconstructed shell preview does not satisfy M8. If texture interoperability or foreground preservation fails its gate, M8 remains incomplete rather than being redefined as a shell-only feature.

After acceptance, [optional milestone M8.5](m8-5-world-model-evaluation.md) evaluates world-model appearance completion against this baseline. It cannot replace an M8 gate. The implementation steps below use letters to distinguish them from that separate milestone.

## Starting state and implementation boundaries

M5 supplies a registered textured shell. The current renderer displays it as 3D content but does not selectively replace camera pixels. M8-A now adds an opt-in, bounded native color/depth/foreground texture bridge and same-frame development views. These are not yet compiled or validated on a physical device and do not implement selective erasure.

Primary integration points are the [native capture module](../../mobile/modules/spatial-capture/ios/SpatialCaptureModule.swift), [capture adapter](../../mobile/src/adapters/roomplan.tsx), [scene renderer](../../mobile/src/components/SceneView.tsx), [shell renderer](../../mobile/src/components/ShellView.tsx), and [session contracts](../../packages/contracts/src/session.ts).

Retain R3F for editable rendering and the existing ARSession for capture. Keep live pixel data native; do not send per-frame base64 images through JavaScript or add per-frame cloud inpainting. The worker remains responsible for world-space background appearance, not real-time camera composition.

## Ordered implementation plan

### M8-A — Pass the native texture feasibility gate

1. Add an Expo GL integration to the native capture adapter for camera color, depth/confidence, and foreground textures in the R3F GL context.
2. Keep native buffers behind process-local handles. Expose frame sequence, capture time, projection, display transform, room anchor, coordinate-frame identity, and adapter generation alongside the handles.
3. Use three bounded frame slots with explicit acquire/release ownership. Drop obsolete frames rather than creating an unbounded queue.
4. Render camera pixels and virtual content from the same acquired frame bundle. Do not combine an independently advancing camera background with an unrelated rendered pose.
5. Demonstrate orientation handling, texture lifetime, context disposal, and background/resume on the exact pinned native build.
6. Record the Expo GL integration method and any native dependency patch. A patch must be reproducible from a clean checkout; do not rely on an edited dependency installation.

Deliverable: a physical-device demonstration of the same-frame camera/virtual overlay with bounded resources and no competing camera session.

Implementation evidence for this path: Expo exposes native GL object creation/mapping, and ARKit exposes scene-depth data when supported frame semantics are enabled. These capabilities support the proposed bridge but do not establish compatibility with this pinned application build. The physical-device spike must establish that compatibility.

- [Expo native GL interface](https://raw.githubusercontent.com/expo/expo/main/packages/expo-gl/common/EXGLNativeApi.h)
- [Expo iOS GL context](https://raw.githubusercontent.com/expo/expo/main/packages/expo-gl/ios/EXGLContext.h)
- [Apple ARFrame scene depth](https://developer.apple.com/documentation/arkit/arframe/scenedepth)

Do not proceed to final compositing passes until this gate passes. A failure requires a revised native integration design; it does not authorize changing the selected renderer or weakening the product goal silently.

### M8-B — Enable depth and foreground inputs

1. After measurement, check supported AR frame semantics before enabling scene depth and person segmentation for editing.
2. Preserve world tracking and anchors when configuring the editing phase. Do not reset the coordinate frame without recalibration.
3. Use scene depth to protect foreground geometry and person segmentation as additional foreground evidence.
4. Keep hand landmarks as targeting input; landmarks are not a pixel-accurate hand mask.
5. Pair foreground/depth data with the acquired frame bundle and retain confidence/freshness information.
6. If reliable foreground preservation cannot be demonstrated on a device, leave live erasure unavailable and fail that device's M8 acceptance gate.

Deliverable: usable synchronized foreground/depth inputs with explicit unsupported and unavailable states.

### M8-C — Implement the compositing passes

1. Draw the synchronized camera image as the base layer.
2. Render the reconstructed shell into color/depth targets.
3. Generate erasure masks from immutable measured object positions and the current transaction's visibility intent.
4. Restrict erasure using current depth, retained-object protection, and foreground masks. A coarse furniture box alone is not proof that every enclosed pixel belongs to that furniture.
5. Replace camera pixels only inside the validated erasure region, sampling the registered shell.
6. Draw proposed objects with depth ordering against retained real geometry.
7. Ignore the old furniture depth only where erasure is valid, so erased furniture does not hide its virtual replacement.
8. Preserve foreground hands in front of reconstructed backgrounds and virtual objects when depth indicates they are closer.
9. Clip shell geometry to room polygons and openings; do not fill windows or doorways with wall texture.

Deliverable: selective camera-pixel replacement and correct retained/erased/virtual depth behavior.

### M8-D — Connect visibility to scene transactions

1. Support erasing the original measured appearance after a real object is moved, rotated, resized, replaced, or removed.
2. Keep preview visibility transient and owned by the manipulation transaction.
3. Failed drops, tracking-loss cancellation, and explicit cancellation restore original visibility.
4. Successful release adopts the committed visibility state from the engine.
5. Undo restores scene and erasure intent together; the compositor must not maintain independent undo history.
6. Keep the existing “Show empty room” comparison distinct from selective live erasure.

Deliverable: renderer behavior consistent with M7 commit, rollback, and undo semantics.

### M8-E — Handle appearance updates and structural design previews

1. Reproject one world-space atlas across viewpoints. Do not independently inpaint every camera frame.
2. Stage new textures and adopt them only after calibration, frame, and generation checks.
3. Ensure late appearance results cannot restore cancelled erasure or overwrite a newer transaction's visibility intent.
4. Preserve observed/inferred appearance provenance. Add a coverage mask when per-region rendering requires more detail than per-surface provenance.
5. Structural edits that disagree with the physical room enter a labelled design-preview mode rather than pretending the camera depicts the proposed structure.
6. When required appearance textures are unavailable, retain the usable measured editor and identify live erasure as unavailable.

Deliverable: incremental appearance updates that preserve geometry, revision ownership, and clear view semantics.

### M8-F — Add diagnostics and bounded degradation

1. Expose developer views for original camera, erasure mask, protected foreground, depth, reconstructed shell, and final composite.
2. Record frame age, queue depth, dropped bundles, render time, GPU-resource counts, memory warnings, and thermal state.
3. Disable live erasure when frame bundles are mismatched or stale. Never leave a detached screen-space patch visible.
4. Release frame leases and textures on backgrounding, recalibration, context loss, and session disposal.
5. Measure both the final rendering rate and input/frame freshness. Reusing an old image must not conceal a stalled camera behind a high render FPS.

Deliverable: a diagnosable compositor whose resources remain bounded during sustained use.

## Public interfaces and compatibility

- Add a native-frame texture adapter with explicit acquisition, release, generation, and disposal behavior.
- Add a compositor interface consuming scene snapshots, preview visibility, reconstructed assets, and synchronized frame bundles.
- Texture handles are process-local. Never serialize them into scene state, diagnostics exports, or server requests.
- Add versioned per-object visibility references and reconstruction coverage metadata where needed.
- Continue accepting M5 shell artifacts for the existing shell-preview path. New compositor requirements must not make old fixtures unreadable without an explicit adapter.
- Keep all renderer writes limited to GPU resources and transient display state. The spatial engine owns committed visibility intent.

## Verification and acceptance scenarios

Use the existing scenario runner for identity, revision, visibility, and lifecycle logic. Native texture interoperability and image quality require a physical device and recorded visual evidence.

| Scenario | Required result |
|---|---|
| Remove a real chair | Original chair pixels are replaced with the registered background |
| Move a real chair, then undo | Original location is erased after move; undo restores original visibility |
| Walk a one-metre lateral arc | Replacement background remains registered rather than sliding in screen space |
| Cross a hand over erased furniture and virtual content | Foreground hand remains visible with correct depth ordering |
| Virtual object behind retained furniture | Retained real furniture occludes it correctly |
| Virtual object inside an erased furniture region | Erased furniture depth does not incorrectly hide the replacement |
| Three real objects erased together | Correct independent visibility and sustained performance |
| Cancel a grab or reject a drop | Original appearance returns with the original committed scene |
| Late reconstruction result after undo | Appearance may refresh only for current valid references; visibility stays undone |
| Tracking loss, backgrounding, or GL context recreation | No stale patches, mismatched frames, or leaked frame leases |
| Edit room structure beyond physical boundaries | Explicit design-preview view, not misleading live alignment |

### Performance and visual acceptance procedure

1. Record device/OS, native build, room, lighting, erased objects, render resolution, and active adapters.
2. Warm up the session, then run ten minutes with three-object erasure, camera motion, hand crossings, and ordinary edits.
3. Every post-warmup ten-second measurement window must average at least 30 rendered FPS. Record intentional OS interruptions separately rather than dropping inconvenient samples without explanation.
4. Record source-frame freshness and dropped-frame data alongside FPS to establish that the image remains live.
5. Review the recorded one-metre walkthrough and hand crossings: no persistent furniture residue, detached masks, or erased foreground hand may remain during normal tracking.
6. Confirm live-frame and GPU-resource counts stay bounded and return to their baseline after session disposal.

Run workspace TypeScript checks, existing gates, new compositor state scenarios, and the iOS JavaScript bundle check. Build and run the changed native module; JavaScript export alone does not validate this milestone.

## Completion checklist

### Implementation

- [ ] Native texture bridge exists with bounded acquire/release ownership.
- [ ] Camera pixels, projection, depth, and foreground data form a coherent frame bundle.
- [ ] Real furniture is selectively erased in the live view.
- [ ] Hands and retained objects remain correctly visible.
- [ ] New objects obey real/virtual depth ordering.
- [ ] Shell surfaces respect room polygons and openings.
- [ ] Preview, commit, cancellation, rejected drop, and undo control visibility together.
- [ ] Late appearance updates cannot overwrite current transaction intent.
- [ ] Structural edits enter labelled design-preview mode when necessary.
- [ ] Diagnostics and resource cleanup cover the native and rendering paths.

### Verification and end-state evidence

- [ ] Native texture feasibility passes on the exact pinned physical-device build.
- [ ] Existing checks and compositor state scenarios pass.
- [ ] Walking and hand-crossing recordings pass visual review.
- [ ] Three-object erasure sustains the 30 FPS minimum for ten minutes.
- [ ] Source-frame freshness confirms the displayed camera remains live.
- [ ] Tracking loss and context recreation leave no stale patches.
- [ ] Frame/texture resources remain bounded and return to baseline after disposal.
- [ ] Evidence below identifies the supported device, build, measurements, and limitations.

## Completion evidence record

- Implementation commit and native bridge/patch details: **working-tree implementation; Expo GL 57.0.2 internal context lookup, no node_modules patch; see [handoff](../m8-native-texture-feasibility.md)**.
- Local commands and scenario results: **TypeScript, eight M8 scenarios, app/server gates, iOS JS export, Swift parse, and podspec syntax pass. Worker gate blocked by missing Python OpenCV. Native compilation remains unrun. See [handoff](../m8-native-texture-feasibility.md)**.
- Device model, OS, native build, lockfile hash, and render resolution: **not recorded**.
- Active capture, reconstruction, and compositor adapter IDs: **not recorded**.
- Walkthrough, mask/depth views, and hand-crossing recordings: **not recorded**.
- Ten-minute FPS windows, frame freshness, memory/thermal data, and resource counts: **not recorded**.
- Remaining visual limitations and unsupported capabilities: **not recorded**.
- Acceptance date and reviewer: **not recorded**.
