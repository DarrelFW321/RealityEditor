# M8 native texture feasibility — implementation and device handoff

Status, 2026-09-19: **M8-A development spike implemented; native compilation and device feasibility unverified. M8 is not complete.** Follow the [M8 milestone plan](milestones/m8-live-compositing.md). Its prerequisite gate prohibits proceeding to final erasure passes before texture interoperability is demonstrated on hardware.

## Implemented

- A native acquire/release bridge in [SpatialFrameTextures](../mobile/modules/spatial-capture/ios/SpatialFrameTextures.mm), attached to the existing RoomPlan/ARKit session. It neither starts another camera nor serializes live pixel bytes to JavaScript.
- At most three module-owned native leases, counting uploads and pending GPU cleanup. Invalidation cancels unpublished uploads; delivered mappings remain owned until explicit release, even after the capture view is replaced. Module teardown retires all leases. Background cleanup is deferred until resume so it does not submit prohibited GPU work. Duplicate release is harmless.
- Native upload of supported bi-planar YUV camera data, Float32 scene depth, byte confidence, and byte person segmentation. Missing optional inputs remain absent rather than becoming invented masks. The conservative upload/fence path is a feasibility implementation, not a proven performance optimization.
- Matching capture timestamp, pose, projection, room-anchor transform, display-to-sensor transform, frame ID, generation, sequence, and viewport metadata. Uploads run on the Expo GL queue and restore modified GL upload state.
- A pure TypeScript lease consumer that allows one request in flight, rejects wrong identities/viewports and stale/reordered results, includes native age and conservative bridge transit in its 150 ms freshness bound, and releases late results after disposal.
- Development-only camera, depth, confidence, and foreground views inside the existing R3F canvas. Camera mode renders editable geometry using the same bundle's pose; the other modes show only their diagnostic texture. A missing diagnostic texture is purple, not a fabricated zero-depth or empty-foreground image.
- Eight M8 scenarios in the existing app gate and a development-panel M8 gate button. No separate test framework.

Depth/person semantics are requested only when the diagnostic first acquires a frame after measurement. The existing AR configuration is copied, supported semantics checked, and tracking/anchors retained. Turning diagnostics off stops acquisition; the AR session keeps these semantics until the session ends. Measure that cost during the device spike before deciding production lifecycle policy.

## Expo GL compatibility boundary

The package and pod dependency pin `expo-gl` to **57.0.2**. The bridge uses `EXGLContext.runAsync`, `EXGLContextCreateObject`, `EXGLContextMapObject`, and `EXGLContextDestroyObject` from that installed source. It declares the existing `EXGLObjectManager.getContextWithId:` selector in a local Objective-C category because Expo does not expose it in the public header. This is an explicit dependency on internal Expo behavior. No modification of `node_modules` is required. Revalidate the lookup, GL queue, and object mapping before upgrading Expo GL.

JavaScript uses the same `{ id }` texture wrapper convention as Expo GL's `createCameraTextureAsync`, but does not invoke that function or attach another camera output. R3F's native renderer remains responsible for presenting the same-frame camera/virtual overlay.

The native path currently uploads textures and uses `glFinish` for conservative ownership fencing. This can stall the GPU and may fail the performance gate. Do not describe it as zero-copy or 30 FPS verified. If profiling fails, replace uploads/fences with a validated CoreVideo texture-cache/GPU-sync path without weakening ownership or same-frame guarantees.

## Reproduce local verification

The incoming lockfile disagreed with existing root manifest versions. Mobile also imported Zod without declaring it and resolved Zod 3, breaking its existing `z.toJSONSchema` call. Mobile now explicitly depends on the same Zod 4 range as the contracts; the lockfile is synchronized without changing the declared React/React Native versions. Optional peer conflicts require the install mode below. This does not establish native compatibility of every dependency.

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm run gate:app -- M8
npm run gate
npm run bundle --workspace @reality/mobile
```

Results on 2026-09-19:

| Check | Result |
|---|---|
| Workspace TypeScript checks | Pass |
| M8 app gate | 8/8 scenarios pass after review fixes |
| Full app gate, including existing scenarios/determinism | 33/33 pass after review fixes |
| Existing server gate | 9/9 pass |
| Python worker gate | Blocked: `ModuleNotFoundError: No module named 'cv2'`; worker code unchanged |
| iOS JavaScript export | Pass; 1,764 modules bundled |
| Swift parser / podspec Ruby syntax | Pass; these are not native compilation |
| Lockfile consistency | `npm ci --ignore-scripts --legacy-peer-deps --dry-run` passes |
| Native compile, linking, GL shader execution | Not run: full Xcode is not installed on this host |
| Physical LiDAR iPhone, image quality, sustained FPS, GPU cleanup | Not run |

## Physical-device gate procedure

1. Use a Mac with full Xcode selected, CocoaPods, provisioning, and a supported physical LiDAR iPhone. Rebuild the native app using the existing `npm run ios --workspace @reality/mobile` workflow; an OTA/JavaScript-only update cannot install this bridge.
2. Record commit plus any working-tree patch, lockfile hash, Xcode/iOS/device versions, build ID, and installed Expo GL version. Verify both native source files compile/link; resolve any platform integration errors before collecting visual evidence.
3. Scan and accept a measured room normally. In the editor's development panel, turn off “Show empty room” and select **M8 camera**. An older binary should explain that the bridge requires a rebuild.
4. Confirm camera color, orientation, crop, and aspect ratio in portrait and both landscape orientations. Compare against the original native camera view by selecting **M8 off**. Confirm the room-origin and boundary diagnostic anchors stay registered while walking laterally one metre and rotating.
5. Select **depth**, **confidence**, and **foreground**. Depth maps 0–5 metres to black–white; confidence maps ARKit's 0–2 levels to black–white; foreground shows the segmentation values. Purple means unavailable. Record a hand crossing and retained furniture at different distances. A person mask alone does not prove pixel-accurate hands or selective object erasure.
6. Watch frame age, lease slots (never above three), rejected/dropped counts, renderer FPS, and existing thermal/memory diagnostics. Record source freshness with FPS; a repeatedly presented old image does not pass. Run at least ten minutes with camera motion. Native Instruments/resource evidence is still required; the displayed lease count is a sample, not a GPU leak detector.
7. Repeat ten on/off cycles, orientation changes, tracking loss/recovery, background/resume, editor exit, and recalibration. Backgrounding turns diagnostics off; explicitly select a mode again after resume. Confirm old pixels clear and old lease callbacks cannot publish into the new context/session.
8. Confirm native frame/texture resources return to baseline after disposal. Record upload/fence cost and any memory/thermal growth. Fail the spike for color conversion errors, misregistration, stale pixels, resource leaks, unavailable required foreground inputs, or unacceptable performance.

## Work still required after the native gate passes

- Final selective-erasure and depth-compositing passes; the diagnostic camera overlay is **not** the product compositor.
- Pixel-valid erasure evidence rather than furniture-box-only replacement; foreground protection must be proven visually.
- M7 transaction-owned visibility across move/rotate/resize/replace/remove, preview, rejection, cancellation, and undo.
- Shell clipping at room polygons/openings, revision-safe atlas adoption, and observed/inferred coverage handling.
- Labelled structural design previews, full compositor diagnostic views, and release-quality bounded degradation.
- M8's three-object erasure, one-metre walkthrough, foreground-hand crossing, ten-minute 30 FPS, and lifecycle acceptance evidence.

Do not mark M8 complete or enable live furniture erasure based on the local gate or successful JavaScript export. The next blocking artifact is a compiled device build and recorded M8-A texture feasibility result.

## Follow-up code review fixes — 2026-09-19

- Unavailable native frames now clear the displayed lease immediately instead of retaining stale pixels until timeout.
- Repeated lease tokens are rejected without releasing a texture still owned by the renderer; synchronous release errors cannot leave stale displayed state.
- Singular camera/anchor/display transforms are rejected. Explicitly undefined optional texture fields no longer cause handle validation to throw.
- Texture ownership moved from the active capture view to its Expo module, allowing late releases after view replacement. Native invalidation no longer deletes already-delivered textures while JavaScript might sample them.
- Native cleanup waits for app resume when inactive; module teardown retains the bounded retired pool until cleanup can run. The diagnostic render loop no longer issues GL calls while inactive, and teardown still releases leases when renderer cleanup fails.
- Shader/program/geometry allocation failures have explicit cleanup paths.
- Shell atlas loading now hides obsolete textures, ignores cancelled load errors, and disposes textures separately from shell geometry. Clearing or replacing an atlas cannot intentionally reuse the disposed previous atlas.

The eight headless scenarios cover JavaScript ownership/validation behavior, not native scheduling or React/GL image behavior. The latter fixes remain code-reviewed and await native compilation and the device procedure above.
