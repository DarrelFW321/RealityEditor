# PRD: Diminished Reality (erasing real objects from the live feed)

Status: proposal. Owner: A (Capture + Renderer). Target: Hack the North 2026.

---

## 1. Problem

When the user says *"remove the chair"* or *"move the chair to the window"*, the
twin folds into the wall or slides to its new spot, and the **real chair is still
sitting in the camera feed**. The illusion that the room changed collapses on the
two op kinds the demo most wants to show.

`SceneRenderer.captureSkin` already names this gap in its doc comment: a skin
"cannot remove the real object, which stays exactly where it was". This document
is the plan for removing it.

The field calls this **diminished reality (DR)**. The two families of technique
are *observation-based* (show pixels you saw from another viewpoint) and
*inpainting-based* (synthesise background from surrounding pixels). Nearly every
working system assumes a **planar background**, and that is the fact this design
leans on: in an RSG, whatever is behind a piece of furniture is a wall plane and
a floor plane whose equations we already have.

## 2. Goals

- G1. After `DELETE_OBJECT` on a `provenance: real` object, the real object is no
  longer visible in the camera view, within the same 450ms window as the
  existing dissolve animation.
- G2. After `MOVE_OBJECT` / `ROTATE_OBJECT` / `RESIZE_OBJECT` / `REPLACE_OBJECT`
  on a real object, its **original physical location** shows floor and wall, and
  the twin appears at the new pose.
- G3. `UNDO` brings the real object back with no residue. No extra state to
  unwind: the erased set is *derived* from graph state every frame.
- G4. Zero added latency on the speech → visible-change path. Every expensive
  step runs before the op arrives or after the change is already on screen.
- G5. Stable under hand-held motion. No flicker, no sliding, no per-frame ML.
- G6. Fits every rule in the README: on-device, no server, no third-party Swift
  packages, no fourth interface, no schema change.

## 3. Non-goals

- Photoreal fill of complex backgrounds (patterned rugs, bookshelves). The demo
  is rehearsed against a plain floor and plain wall.
- Erasing objects RoomPlan did not detect. If it is not in the RSG we cannot
  erase it; "remove that" with no resolved entity is out of scope.
- Per-region occlusion control (see risk R1).
- Generative inpainting on the critical path (learned fill is a stretch goal,
  off-path only, section 9 M4).
- Anything on the simulator. RealityKit post-processing dispatch is device-only.

## 4. Constraints inherited from the repo

- RealityKit `ARView`, iOS 17 deployment target. `ARView.renderCallbacks`
  (iOS 15+) is available; we do **not** move to a custom Metal renderer.
- `sceneReconstruction = .mesh`, `.sceneDepth`, `.smoothedSceneDepth` are
  already requested in the session configuration.
- Scene-mesh occlusion is a global `ARView` option with an existing toggle
  (`SceneRenderer.setOcclusionEnabled`).
- The RSG has `provenance: real | virtual` on objects and a `hidden` lifecycle.
  That is sufficient; nothing is added to any frozen interface.
- Nothing in `SpatialCore` may import ARKit/RealityKit/Metal. All of this lives
  in `ios/RealityEditor/Render/`.

## 5. User-visible behaviour

Voice: "remove the chair."
1. Twin folds into its wall over 0.45s (exists today).
2. In the same 0.45s, the real chair fades out of the camera feed and the floor
   and wall behind it fade in. The two motions read as one.
3. Model narrates from the `ConstraintReport` as today.

Voice: "put the chair by the window."
1. Twin slides to the window (exists today).
2. The real chair's original spot shows floor and wall.
3. The twin at the window is a skinned or glimpsed twin, so it looks like the
   user's chair. The user's chair has, visually, moved.

Voice: "undo."
1. Twin unfolds from the wall / slides back (exists today).
2. Real chair fades back into the feed over 0.25s.

Debug: a toggle on the hand-test screen shows the eraser mask, the atlas
coverage heat-map, and the eraser on/off, next to the existing occlusion toggle.

## 6. Design overview

Three components, all owned by A, all under `ios/RealityEditor/Render/Eraser/`.

```
                 ARFrame (2 Hz keyframes)          RSG diff (per op)
                        │                                │
                        ▼                                ▼
              ┌──────────────────┐            ┌───────────────────┐
              │ BackgroundAtlas  │            │ PhysicalRegistry  │
              │ floor + wall     │            │ scan-time pose of │
              │ textures, built  │            │ every real object │
              │ from unoccluded  │            │ → set of erased   │
              │ camera pixels    │            │   world-space OBBs│
              └────────┬─────────┘            └─────────┬─────────┘
                       │  sample(plane, uv)             │  mask geometry
                       ▼                                ▼
                    ┌──────────────────────────────────────┐
                    │ EraserPass  (ARView postProcess)      │
                    │ per pixel: inside erased OBB and not  │
                    │ inside a drawn twin's OBB → replace   │
                    │ with atlas colour along the pixel ray │
                    └──────────────────────────────────────┘
```

The central idea: **the mask comes from geometry, not from vision.** A real
object's scan-time box is fixed in world space and the camera pose is known
every frame, so the mask is free, exact, and temporally stable. Vision
segmentation is used at most once, at op time, to tighten the box.

### 6.1 PhysicalRegistry

`SceneRenderer.load(_:)` snapshots every object with `provenance == .real` into
`physical: [String: SceneObject]`. This is the only place the physical pose is
remembered. It is not in the RSG because the RSG stores the *current* pose, and
it must not be: the schema is frozen, and the op log already knows the history.

Every `apply(from:to:)` recomputes the erased set:

```
erased = physical.filter { id, phys in
    guard let now = new.object(id: id) else { return true }        // gone
    return now.lifecycle == .hidden
        || now.pose      != phys.pose
        || now.dimensions != phys.dimensions
        || now.catalogID  != phys.catalogID                         // REPLACE
}
```

Derived, never stored. Undo is therefore correct by construction: when the graph
returns to the scan-time state the set empties and the eraser fades out.

Each erased entry becomes a world-space OBB uniform: centre, half-extents, yaw.
Two dilations are applied before upload: 6% on width/depth/height (RoomPlan
boxes under-estimate chair backs), and an extra 10cm outward on the footprint
extended down to the floor plane (the object's **contact shadow** on the floor
is the most common tell after the object itself is gone).

### 6.2 BackgroundAtlas

One RGBA16F texture per plane, plus a weight channel:
- Floor: covers the floor polygon's bounding rectangle at 256 px/m
  (4m room → 1024²).
- Each wall: wall width × wall height at 256 px/m.

Update runs on a **keyframe**, not every frame: when the camera has moved more
than 10cm or rotated more than 5° since the last keyframe, capped at 2 Hz. The
update is one compute kernel per plane:

```
for each atlas texel:
    P   = world point of texel on the plane
    uv  = project(P, camera intrinsics, camera transform)      // ARKit convention
    if uv outside image                                → skip
    if segment(camera → P) hits any REAL object's OBB  → skip   (object in the way)
    if |sceneDepth(uv) − dist(camera, P)| > 10cm       → skip   (something else in the way)
    if depthConfidence(uv) < medium                    → skip
    w   = cos(grazing angle) · (1 − edge falloff)
    rgb = YCbCr→RGB(capturedImage, uv)
    atlas[texel] = lerp(atlas[texel], rgb, w / (w + weight[texel]))
    weight[texel] += w
```

The real-object test uses the **physical** OBBs, always, so the strip of floor
under a chair is never polluted by the chair even before an op arrives.

Hole filling: texels with `weight == 0` are unavoidable (the floor directly under
the chair has never been seen). A jump-flood nearest-filled-texel pass followed
by a 3-texel blur fills them from their neighbours. This is the whole
"inpainting" step in the MVP: for a plain floor and plain wall it is enough, and
it is deterministic.

Ingestion hook: `ARSessionDelegate.session(_:didUpdate:)`, which already feeds
`HandTracker` and the SCP builder. The atlas reads `frame.capturedImage`,
`frame.sceneDepth`, `frame.camera`; it never blocks the delegate (the encode is
submitted and forgotten on its own command queue).

### 6.3 EraserPass

`arView.renderCallbacks.postProcess` is set once in `SceneRenderer.attach(to:)`.
When nothing is erased it blits `sourceColorTexture` → `targetColorTexture`
(Apple's documented no-op path) and costs one copy.

When the erased set is non-empty, one compute kernel over the target:

```
for each pixel:
    ray = camera ray from inverse(context.projection) and camera transform
    tObj = nearest hit of ray against erased OBBs                 → none: pass through
    if ray hits a DRAWN TWIN's OBB before tObj                   → pass through
    tBg  = nearest positive hit against floor plane and wall planes
    P    = ray · tBg ;  (plane, uv) = atlas lookup for P
    bg   = atlas[plane][uv] · luminanceGain
    a    = feather(distance to OBB silhouette, 8px) · eraseAlpha[obj]
    out  = mix(src, bg, a)
```

Three details that make it hold together:

- **Virtual content wins.** Any pixel covered by a currently-drawn twin (the
  moved chair at its new pose, a new sofa placed where the old one was) is
  excluded by testing the ray against the drawn twins' OBBs. This is pure
  geometry from the RSG, so it does not depend on what RealityKit writes into
  `sourceDepthTexture` (see spike S1).
- **Luminance gain.** Once per keyframe, the mean luminance of a 12px ring just
  outside the mask in the source frame is compared to the atlas sample along
  the same rays; the ratio is applied to the fill. This is the cheap version of
  the illumination adaptation Siltanen's pipeline is built around, and it is
  what stops the patch reading as a lighter or darker rectangle.
- **`eraseAlpha` is animated**, 0 → 1 over 0.45s on erase (matching
  `dissolveDuration`) and 1 → 0 over 0.25s on undo. It is the same per-object
  value the dissolve uses for the twin, so the two animations are in step.

### 6.4 Interplay with the scene-mesh occlusion option

ARKit's mesh of the real chair does not know the chair has been "removed", so
with `.occlusion` on it will hide any twin placed inside the erased volume. RealityKit
offers no per-region control. Decision for the hackathon: **when the erased set
becomes non-empty, the renderer turns occlusion off; when it empties, it turns
it back on.** The user-facing cost is that twins can draw over real furniture
elsewhere in the room while something is erased. That is acceptable for a
3-minute demo and it is reversible with the existing toggle. Revisit only if a
rehearsed turn looks wrong because of it.

## 7. Integration points

| Where | Change |
|---|---|
| `SceneRenderer.attach(to:)` | Install `EraserPass`, pass `arView`. |
| `SceneRenderer.load(_:)` | Populate `PhysicalRegistry`. Allocate atlas textures from floor polygon and wall surfaces. |
| `SceneRenderer.apply(from:to:)` | Recompute erased set; push OBB uniforms; start alpha animations; toggle occlusion per 6.4. |
| `SceneRenderer.dissolve` / `emerge` | No change; the eraser reads the same duration constants. |
| `HandTestView.Coordinator.session(_:didUpdate:)` | Call `atlas.ingest(frame)` (throttled inside). |
| `HandTestView` debug row | Buttons: Eraser on/off, Show mask, Show atlas coverage. |
| `SessionRecorder` | Log `{t, "erase", ids, atlasCoverage}` on every erased-set change so a bad-looking turn is diffable. |
| `project.yml` | None. `.metal` files under `RealityEditor/` are picked up by the folder glob. |

No change to any schema, to `SpatialCore`, to `TurnController`, to the server,
or to the tool schema. The model does not know the eraser exists; it narrates
the `ConstraintReport` exactly as before.

## 8. Performance budget

- Speech → visible change: **+0ms.** The eraser starts on the frame the op is
  applied; atlas work happened earlier.
- Post-process kernel: ray/OBB for ≤ 8 erased boxes + ≤ 16 drawn twins, then
  ray/plane for ≤ 6 planes, per pixel at view resolution. Estimate < 0.5ms on
  A17. Target: **≥ 55 fps** with three objects erased on iPhone 15 Pro.
- Atlas update: ≤ 5 kernels (floor + 4 walls) over ≤ 1024² texels at 2 Hz.
  Estimate ~1ms per keyframe, on its own queue.
- Memory: floor 1024² RGBA16F + weight ≈ 10MB; walls ≈ 6MB each. Under 40MB.
- Vision: not on any per-frame path. Optional once per op (M3 tightening).

## 9. Milestones

Slotted into the README's schedule. The rule from the README applies: this is a
**hour 20–26 feature for Owner A, after Twin Mode renders a scanned room.** Hard
decision at hour 26: ship what is stable, or fall back (section 10).

**M0. Pipeline spike (2h).** `EraserPass` installed; blit passthrough; a debug
tint over the projected OBB of one real object. Proves: the callback runs on
device, coordinate mapping from `context.projection` matches `arView.project`,
frame rate unchanged.
Exit: tinted box sits on the real chair through 10s of hand-held motion.

**M1. Plane fill from one frame (3h).** Erased pixels replaced by ray/plane fill
sampled from an atlas built from the **current frame only** (single keyframe,
no accumulation). Feathering and luminance gain in.
Exit: "remove the chair" against a plain wall reads as removed when the phone is
roughly where it was at op time. Parallax breaks are expected.

**M2. Accumulated atlas (4h).** Keyframe ingestion with OBB and depth rejection,
weighted blending, jump-flood hole fill. Coverage heat-map in debug view.
Exit: after a 20s walk of the room, floor coverage ≥ 90%; the erased spot stays
put while walking a 1m arc.

**M3. Op integration and polish (3h).** Derived erased set, alpha animation in
step with dissolve/emerge, undo, occlusion toggle per 6.4, recorder logging,
optional one-shot Vision tightening of the OBB at op time using the existing
`GlimpseCapture.foregroundMask`.
Exit: the six demo turns run three times in a row with erase on.

**M4. Stretch, only if M3 is done before hour 28.** Learned hole fill: run a LaMa
Core ML model once, off-thread, on the keyframe at op time; bake its output into
the atlas texels that had `weight == 0`; the M2 fill shows meanwhile and is
swapped when the model returns. Never per frame. Cost to weigh: ~190MB in the
bundle, ~600MB peak RAM, cold start. Default answer is no.

## 10. Fallbacks

**F1. Impostor card (half a day, geometry only, no Metal).** On erase, spawn an
opaque unlit quad just in front of the real object's near face, textured once
from the atlas using the current camera projection. Closer to the camera than
the chair, so it hides the chair regardless of the scene mesh. Correct head-on,
breaks with parallax, exactly like `captureSkin`. Take this if M0 fails on
device.

**F2. Rendered twin mode.** Swap `arView.environment.background` away from the
camera and draw the floor and walls as panels textured from the atlas. There is
no real chair in a rendered room, so erase is trivial. This is what IKEA Kreativ
does for LiDAR full-room scans ("the room starts completely empty"). Loses the
live-camera magic; keeps every op working. Take this if the venue lighting makes
F1 and M2 look bad in rehearsal.

**F3. Script around it.** Removal and movement of *real* objects are the only ops
that need DR. Add, swap, retexture, wall changes, and any op on a virtual object
do not. If nothing above is stable at hour 30, the demo script has zero
real-object removes and one real-object move where the twin's new position
covers the old one from the demo camera angle.

## 11. Risks

- **R1. Scene-mesh occlusion hides twins placed in the erased volume.**
  Mitigation: section 6.4. Residual: twins over-draw real furniture while
  something is erased.
- **R2. Illumination seam.** The fill is lit as the floor around it, but the
  chair's soft shadow and any colour bleed are gone. Mitigations: footprint
  dilation, feathering, luminance gain. Residual: visible at close range on the
  projector; rehearse the camera distance.
- **R3. Unobserved texels.** The floor directly under the chair is never seen.
  Mitigation: hole fill from neighbours; plain floor in the demo room. Stretch:
  M4.
- **R4. Coordinate-space bugs.** Three spaces (captured image, viewport,
  atlas) and two orientations. Mitigation: M0 exit criterion is precisely this;
  reuse `AspectFill.imagePoint` and the `displayTransform` inverse that
  `GlimpseCapture` already uses; debug mask overlay from hour one.
- **R5. `sourceDepthTexture` semantics.** Unknown whether it contains scene-mesh
  depth when occlusion is on. Mitigation: design does not depend on it (6.3
  uses RSG geometry for twin exclusion). Spike S1 characterises it anyway.
- **R6. Device-only.** The compute dispatch does not run in the simulator.
  Mitigation: `EraserPass` is a no-op blit when `MTLDevice` lacks non-uniform
  threadgroups or when there is no scan; fixture mode keeps working.
- **R7. Schedule.** This is a real feature at hour 20. Mitigation: hard cut at
  hour 26 to F1, F2, or F3; nothing else in the app depends on it.

## 12. Spikes to run before M1

- **S1.** Dump `sourceDepthTexture` with occlusion on and off, with a twin in
  frame. Record what the camera-only pixels read (far plane? zero?) and whether
  mesh depth appears.
- **S2.** Confirm `context.projection` equals the projection `arView.project`
  uses, including the aspect-fill crop, by drawing a box outline through both
  paths and overlaying.
- **S3.** Measure `dispatchThreads` cost at view resolution on the demo phone
  with 8 OBBs and 6 planes. Confirm the 55 fps floor.

## 13. Acceptance criteria

- "Remove the chair" on a real chair: not visible within 450ms; no flicker over
  10s of hand-held motion including a 1m lateral walk; seam not noticeable at
  the rehearsed camera distance on the venue projector.
- "Move the chair to the window": original location shows floor and wall; twin
  at the target is skinned or glimpsed.
- "Undo" after either: real chair visible again, no residue, within 250ms.
- Three real objects erased simultaneously: ≥ 55 fps on iPhone 15 Pro.
- A virtual sofa added into the erased volume draws over the fill, not under it.
- Atlas floor coverage ≥ 90% after a 20s scan walk of the 4×4 demo room.
- Fixture room, no LiDAR device, simulator: no crash, eraser silently disabled.
- Every erased-set change appears in the session `.jsonl`.

## 14. Open questions

- Should op-time Vision tightening (M3) *replace* the OBB or *union* with it?
  Proposal: union, dilated; a mask that is too small leaves chair edges, a mask
  that is too big erases a little extra wall, and the second failure is
  invisible.
- Walls with doors and windows: the atlas simply records them, which is correct.
  Do we want to reject texels inside RoomPlan door/window openings so a chair
  in front of a window fills with window rather than smeared frame? Defer.
- Mirror and glass: the atlas will bake reflections at the keyframe angle. Out
  of scope; avoid in the demo room.

## 15. Sources

Apple
- [ARView.RenderCallbacks](https://developer.apple.com/documentation/realitykit/arview/rendercallbacks-swift.struct) and [ARView.PostProcessContext](https://developer.apple.com/documentation/realitykit/arview/postprocesscontext)
- [PostProcessEffectContext](https://developer.apple.com/documentation/RealityKit/PostProcessEffectContext) (blit no-op pattern; Metal compute, MPS, Core Image all valid)
- [Displaying an AR Experience with Metal](https://developer.apple.com/documentation/arkit/displaying-an-ar-experience-with-metal) (YCbCr → RGB, `CVMetalTextureCache`)
- [Visualizing and interacting with a reconstructed scene](https://developer.apple.com/documentation/arkit/visualizing-and-interacting-with-a-reconstructed-scene)
- [WWDC26: What's new in image understanding](https://developer.apple.com/videos/play/wwdc2026/237/) (tap-to-segment; iOS 26 only)
- [WWDC26: Camera and Photo Technologies lab](https://developer.apple.com/videos/play/wwdc2026/8018/) (Photos Clean Up has no public API)

Tutorials and code
- [Custom Post-Processing in RealityKit](https://rozengain.medium.com/quick-realitykit-tutorial-custom-post-processing-b5275d9271b)
- [RealityKit post-process full code (Stack Overflow)](https://stackoverflow.com/questions/79802422/realitykit-how-to-support-post-process-with-custom-camera)
- [Texture ARMeshGeometry from ARKit camera frame (Stack Overflow)](https://stackoverflow.com/questions/63733708/texture-armeshgeometry-from-arkit-camera-frame)

Papers
- Mori, Ikeda, Saito. [A survey of diminished reality](https://link.springer.com/article/10.1186/s41074-017-0028-1). IPSJ TCVA 2017.
- Siltanen. [Diminished reality for augmented reality interior design](https://doi.org/10.1007/s00371-015-1174-z). The Visual Computer 2017.
- Herling, Broll. [PixMix: A real-time approach to high-quality Diminished Reality](https://doi.org/10.1109/ismar.2012.6402551). ISMAR 2012. [TVCG 2014 extension](https://doi.org/10.1109/tvcg.2014.2298016).
- Mori et al. [InpaintFusion: Incremental RGB-D Inpainting for 3D Scenes](https://doi.org/10.1109/tvcg.2020.3003768). TVCG 2020.
- [Online Adaptive Integration of Observation and Inpainting for DR](https://doi.org/10.1109/ismar-adjunct57072.2022.00069). ISMAR-Adjunct 2022. (The "inpaint now, observe later" pattern behind M4.)
- Gsaxner et al. [DeepDR](https://immersive-technology-lab.github.io/projects/deepdr/). 3DV 2024.
- [Clean-Splat](https://doi.org/10.20944/preprints202512.2740.v1). Preprint 2025.
- [An AI-based system offering automatic DR-enhanced AR for indoor scenes](https://www.iti.gr/iti/wp-content/uploads/2024/10/an-ai-based-system-offering-automatic-dr-enhanced-ar-for-indoor-scenes.pdf) (layout-aware floor/wall inpainting).
- Wong et al. [Exploiting ARKit Depth Maps for Mixed Reality Home Design](https://ismar2020.ismar.net/demonstrations/index.html). ISMAR 2020 demo (Geomagical / IKEA).
- Suvorov et al. [LaMa](https://arxiv.org/abs/2109.07161). WACV 2022. Core ML: [LaMa-CoreML](https://huggingface.co/mlboydaisuke/LaMa-CoreML), [CoreMLaMa](https://github.com/mallman/CoreMLaMa).

Product
- IKEA Kreativ: [how it works](https://www.ikea.com/fi/en/customer-service/knowledge/articles/ff043ec6-3527-4de3-96e2-9368671ec281.html), [erasing furniture](https://www.ikea.com/us/en/customer-service/knowledge/articles/6226432c-c257-4d49-bf04-cede16cae5c5.html).
