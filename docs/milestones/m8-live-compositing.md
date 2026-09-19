# M8 — Live compositing and foreground preservation

Status: in progress; M8-A texture bridge and **M8-C selective erasure** implemented,
M8-D visibility wiring implemented, and the **local patch fill** makes hiding change
pixels with no server, no reconstruction and no texture bridge. Neither shader has **run
on a device** and milestone acceptance remains open. Updated 2026-09-19. See [implementation evidence and
device handoff](../m8-native-texture-feasibility.md).

**M8-C/D implementation note.** The erasure decision is a pure function in
[`erasure.ts`](../../packages/spatial-engine/src/erasure.ts) — the set is DERIVED from
committed scene state every frame, never accumulated, so undo, a cancelled drop and
tracking loss all restore the original appearance with no compositor history (M8-D.3/D.5).
The shell is reduced to planes plus an exact world-to-atlas map in
[`shell-planes.ts`](../../mobile/src/runtime/shell-planes.ts), verified to round-trip on
every vertex. [`CompositorView.tsx`](../../mobile/src/components/CompositorView.tsx) draws
the camera and, inside the validated region only, samples the shell behind the furniture.
Every uncertain pixel keeps the camera: no depth, low confidence, foreground, a retained
object, or no shell behind the ray all mean "do not erase". Six headless scenarios cover
the decision and the sampling; **the GLSL itself is unverified.**

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

### "I don't have a target ID for the mask box"

Three causes, and one is older than masks.

**`result.selectedId` was dropped on the floor.** `select` and `mask_area` both return a
resolved target and the coordinator ignored it, so placing a box selected nothing and
`hide` had no target. The same omission meant "select the chair" by voice had never
actually selected anything — a latent M6 bug this surfaced.

**Mask boxes were invisible to the model.** They are not scene objects, so they appear
in neither the object list nor the spatial context. The assistant could not name the box
it had just created. They now travel as `mask_areas` beside the other context.

**`hide` demanded an id the user was never asked for.** "Mask that" then "hide it" is the
whole workflow and the second half arrives with no id. The most recent unhidden box is
now the fallback, the placement reply quotes the box id back, and the instructions state
that a missing target id is never the right answer for a mask box.

### The inpainted-patch path

After repeated rounds where the compositor committed state and moved no pixels, the
approach changed: instead of replacing pixels in screen space every frame, ask once
what is behind a masked box and put that answer **on the wall as ordinary geometry**.

```
"hide it"  ->  native captureFrame (PNG + pose + projection)
           ->  project the box into that image  ->  region bounds
           ->  POST /inpaint  ->  Backboard image model  ->  filled frame
           ->  project the box's corners onto the wall behind it
           ->  a quad with projective UVs, drawn by R3F
```

It stays registered because it IS registered — a quad on the wall plane in room space,
the same reason the M5 shell stays put. Crucially it needs **no custom shader, no
native texture bridge and no scene depth**: three things the compositor needed and each
of which silently disabled the whole feature at least once.

**Verified numerically rather than by eye.** A point on the optical axis projects to
exactly (0.5, 0.5); the wall behind the box is identified; the quad lands on that wall
from two different viewpoints; and geometry and texture agree to **0.00e+0** — every
corner samples the photograph exactly where it projects, which is the entire
registration argument. A box out of view is refused before any request, because an
inference call costs about forty seconds.

**Clipped to the photograph.** A box running off the bottom of frame projected a corner
to a negative UV, and a texture sampled outside its bounds clamps — smearing one edge
pixel in a streak across the wall. The quad now shrinks by bisection until every corner
is inside the image: less wall covered with real pixels beats more wall covered with a
stretch.

**Patches are transient display state, not scene data.** The intent — which box is
hidden — is committed and undoable in the engine; the photograph is a cache in front of
it, keyed by the box's pose and the frame identity, and dropped the moment either
changes. A patch registered to a room that has since moved is a rectangle floating in
mid-air, so a stale one is discarded rather than shown.

**Backboard has no mask**, so the returned frame may differ anywhere. That is safe only
because the quad covers the box footprint and nothing else, so pixels outside the
region are never sampled. `/inpaint` says `maskPreserved: false` in its response rather
than leaving that implied.

### Which pixels, not just which box

A box is not a silhouette. Filling the box's whole footprint paints over wall that never
needed painting, and a drawn box is an estimate, so it paints over a lot of it. Nothing
in the chain knew the object's shape: `/inpaint` went to Backboard, which **has no mask
parameter at all**, so the region was described to it in words — "the area occupies 31%
to 52% across" — and the result was a rectangle.

Both halves of the answer were already in the repository and unreachable from this path.
`sam.py` had a box-prompt segmenter verified to 3px at 1920x1440, and `lama_model.py` a
masked filler; both are CPU ONNX, both had weights on disk, and both ran only inside the
reconstruction sweep. `erase.py` puts them behind one worker route, `POST /erase`, and
`/inpaint` prefers it over any hosted provider.

**Measured against the box, on a 1280x960 frame with a loose box around the object:**

| | box alone | segmented |
|---|---|---|
| IoU with the true object | 0.643 | **0.796** |
| object covered | 100% | 100% |
| wall needlessly repainted | 82,902px | **38,265px** |

**Preservation stopped being a hope.** The worker copies every pixel outside the mask
back from the original before replying and reports how many the model had moved —
`inpaint.py` rule 1, for the same reason. `maskPreserved` is now `true` by construction
rather than `false` with a note explaining why that was survivable. That is also what
makes the full-footprint quad correct: the parts of the box that were never the object
come back byte-identical, so they are still the real photograph, and no tight alpha mask
on the geometry is needed. A tight mask would have been worse — the patch is registered
to the wall, so a silhouette-shaped hole slides against the object as the camera moves.

**The mask is grown on purpose.** An outline a few pixels small leaves a rim of the
original object, which reads as a halo; a few pixels large takes wall that gets filled
with more wall. The two failures are not comparable, so it leans large — plus a
downward-only extension for the contact shadow, which no segmenter includes in the
object and which is the most visible tell once the object is gone. `segment.py` inflates
for the same reasons.

**Tiling was the whole quality problem.** `LamaInpainter.fill` walks the image in 512
tiles, which is right for an atlas whose holes are small and scattered. Here the hole is
larger than one tile, so each tile was almost entirely hole, the model had no wall to
continue from, and it returned a smooth grey wash matching neither wall nor floor. Not a
weak model — a model shown nothing to work from. `window_fill` runs it once on the mask
plus 60% of margin, squared and scaled to the frame it wants. Scaling is safe here in a
way `inpaint.py` rule 2 is not about: only masked pixels are taken from the result and
those are invented at any resolution, so no observed pixel is ever resampled. **One pass
instead of four, 9.3s to 4.9s, and the wall/floor line continues through the fill
instead of a blob sitting in it.**

Backboard stays behind the worker for deployments without one. Everything degrades
rather than refusing: no SAM is a blunter mask, no LaMa is a deterministic TELEA fill,
neither is an error — each still removes the object, and the alternative is leaving it
on screen.

Verified end to end on the real weights through the real HTTP path, with
`BACKBOARD_API_KEY` deliberately blanked so the worker had to do the work:
`HTTP 200 in 4.0s, provider worker, maskPreserved true,
{"mask":"sam","maskPixels":187779,"regionPixels":232416,"fill":"lama","changedOutsideMask":0}`.

### `Cannot read property 'width' of undefined`

Thrown from `renderer.resetState()` on the first frame the compositor ran on a device,
and it is a one-line incompatibility rather than anything about erasure.

three's `WebGLState.reset()` ends with:

```js
gl.scissor( 0, 0, gl.canvas.width, gl.canvas.height );
gl.viewport( 0, 0, gl.canvas.width, gl.canvas.height );
```

`canvas` is a standard property of a browser `WebGLRenderingContext`. It is not a
property of expo-gl's, which is a plain object of GL entry points — and React Three
Fiber builds its canvas SHIM separately, handing it to the renderer as `domElement`
without ever attaching it to the context. So `gl.canvas` is `undefined`.

It is thrown inside the render loop, so nothing catches it and it takes the frame;
the failure reads as the app being broken rather than as the line that caused it. Every
path here that resets GL state was therefore dead on device the moment it first ran —
the compositor, and both native frame diagnostics. It had never been seen because the
compositor only mounts when something is being erased, and until the mount condition
was fixed nothing ever was.

`ensureContextCanvas` attaches a shim that reports the DRAWING BUFFER through getters
rather than copying its size once, since a stored size is wrong after the first
rotation and this sets a scissor rectangle. It never replaces an existing `canvas`, so
web is untouched, and a context that refuses the property returns false instead of
throwing — losing the reset is survivable, losing the frame to an exception is not.

### Hiding committed and the pixels stayed put

Three separate reasons, and the first one alone was enough to make the whole feature
look dead on the exact case it was built for.

**A drawn box could not erase anything the scan had recognised.** `retainedVolumes`
protects every measured object that is not itself being erased — right, because erasing
one object must not take the sofa beside it. But a hand-drawn box has no measured
identity, so a box drawn around a scanned bed left the bed *retained*, and both
`shouldErase` and the shader returned false for every pixel of it. Mask a furnace
RoomPlan missed and it worked; mask a bed RoomPlan found and nothing happened at all.
Protection now yields to a box the user drew AT that object — tested both ways, because
a box around a whole bed contains the bed's centre while a small box on one end of a
sofa does not, but its own centre is inside the sofa. A box that merely passes near
something fails both tests and protection stands.

**Nothing was drawn until an image model answered.** A patch was published only on a
successful `/inpaint`, so every pixel of this feature was downstream of a remote call
that takes about a minute and can be unconfigured, rate limited or unreachable — and on
any of those the patch was dropped entirely, which puts the furniture back. The
photograph is now published as the patch texture **immediately**, before the request
goes out, and the region is reconstructed in the fragment shader from the wall around
it. The inpaint then replaces it in place, and any failure *degrades to* the local fill
with a note rather than withdrawing it.

**The fill itself.** Four samples taken just outside the quad's four edges, weighted by
inverse distance to each. The boundary colour is reproduced exactly at the boundary, so
the patch meets the surrounding wall with no seam, and it blends smoothly across the
interior — on a plain wall, or a wall meeting a floor, indistinguishable from the
surface continuing behind the object.

"Just outside the edge" is computed in the quad's own frame, never in image space. The
quad is a rectangle on the wall but its image is a general quadrilateral, so stepping
left in image space can walk back across the object instead of off it. `quadHomography`
maps the quad's unit square onto the photograph (Heckbert), so `s = -margin` is
genuinely beyond the left edge from any viewing angle. The margin is in **quad widths**,
not pixels: the same 20px reaches past a distant chair and lands in the middle of a near
one. A quad with no area is rejected on its Jacobian rather than on finiteness — four
coincident corners solve cleanly to a map that sends the square to one point, and the
"fill" would then be the object's own colour.

`fillAt` is that arithmetic in TypeScript, so the scenarios assert on the calculation
the shader performs rather than on a second copy of it — the same reason `shouldErase`
lives in the engine. Against a synthetic photograph of a dark object on a plain wall the
fill returns wall to 2.2e-16 over an 11x11 grid, and the homography maps the unit square
onto the quad to 0.00e+0.

**Patches were requested for drawn boxes only.** `hide` on scanned furniture — the
`delete` verb — produced no patch at all and waited on a reconstruction that mostly did
not exist. Both deliberate intents now request one. `moved`, `removed` and `carried`
still do not: those follow from an edit rather than from an erasure anyone asked for,
and `carried` changes every frame.

**And the status line diagnosed the wrong thing.** It reported only the compositor, so
it called the feature dead whenever the native texture bridge was absent — while a patch
could be covering the box perfectly well. It now leads with how many regions are covered
and what they are filled from. A build with no `captureFrame` says so outright, which
was the one cause nothing on screen could reveal.

### The compositor never mounted

"Hide it" committed and the screen did not change, because `SceneView`'s mount condition
still read:

```
!!frame && frameDiagnostic === 'off' && !!shell && !!erasure && volumes.length > 0
```

`shell` is non-null only once a reconstruction has completed. The atlas requirement had
been removed from that line and the **shell** requirement left in, two lines above a
comment saying erasure must not wait on a worker. So the component never rendered, the
shader never ran, and every fix to the fill was to code nothing was executing.

The condition is now `shouldComposite()` in the spatial engine — exported, with six
assertions including one that a reconstruction is not required. It was an inline boolean
nobody could test, which is precisely how it kept a stale clause.

**And a hazard that fix introduced.** The compositor owns the whole draw while mounted,
and previously only mounted when a shell existed — which was almost never. Now it mounts
whenever something is hidden, so on a device whose native texture bridge is not
delivering it would have ended each frame with nothing drawn and replaced a working
editor with an empty one. It now requires `textureBridgeAvailable()`, still renders the
scene on a starved frame rather than blanking, and after a second of starvation reports
`onUnavailable` so the caller reverts to the ordinary camera path for the session.

### Mask, then hide: two steps, and no reconstruction required

A box that erased on placement removed the very thing the user was aiming at while they
sized it. So a mask volume now has two states: **marked** draws an outline and leaves
the camera alone; **hidden** replaces the pixels. `hide` on a box is what crosses that
line, and resizing a hidden box keeps it hidden so the fill does not flicker back.

**The fill no longer waits on a reconstruction.** The compositor prefers the shell when
one exists — it carries real texture rather than an average colour — but when there is
none, or no shell surface lies along the ray, it fills from the camera pixels
immediately surrounding the region: eight rays marched outward, first non-erased sample
on each, inverse-distance weighted. A live jump-flood. The wall and floor around the box
are real photographed pixels, so it picks up their actual colour and shading.

Bounded by construction — eight rays, eight hops — so the cost is fixed per erased pixel
and zero everywhere else. Every ray still landing inside the region (a box filling the
screen) returns nothing and keeps the camera, rather than inventing a colour.

That changed `erasureAvailability` too. A missing, loading or stale-calibration shell now
**degrades** instead of refusing; only tracking loss, a missing or stale frame, and
absent scene depth still make erasure impossible, because depth is what bounds the
region and has no substitute. Requiring a reconstruction had made erasure unavailable in
every session where nobody had run one, which was most of them.

### "Mask" and "delete" are two different words

They were being treated as synonyms, and the fault was in my own schema text: the
`hide` description listed "delete", "erase", **"mask"** and "get rid of" together, so
asking to *mask* something produced an object erase — which needs a reconstruction to
show anything — rather than the box the user meant.

The vocabulary is now split, and asserted so it cannot drift back:

| Word | Action | What it does |
|---|---|---|
| **mask** | `mask_area` | Places a visible box. Works whether or not anything is identified, and even when a real object is there. Resize and move it afterwards. |
| **unmask** | `unmask_area` | Removes a box. |
| **delete** | `hide` | Real scanned furniture: pixels replaced with the wall behind, object stays physically present. |
| **delete** | `remove` | A virtual object, or recording that a real one has actually been carried out. |

Both the action description and the session instructions now state that these are not
synonyms, and that masking with nothing identified is expected rather than an error.
Six scenario checks read the SHIPPED schema and prompt — including one asserting the
`hide` description no longer claims the word "mask" — because this was a wording bug and
only wording assertions catch a wording bug.

### Erasing what the scan never recognised

Everything erasable was tied to something RoomPlan detected, so anything it missed — a
furnace, a radiator, a pile of boxes — could not be removed at all. The assistant said
so honestly and there was nothing it could do about it.

The answer was not a segmentation model. The compositor already erases whatever falls
inside an oriented box; it only needed boxes that are not derived from a detected
object. `EditorState.maskVolumes` holds hand-placed ones: point at the thing, get a box,
everything inside it stops being shown.

Deliberately **not** a `SceneObject`. It has no assembly, joins no collision check and
blocks no placement — the scenario asserts furniture can still be placed inside one. It
says only "do not show me what is in here". Living in committed state is what makes it
undo with everything else, and re-issuing the same id replaces the box rather than
adding a second, so resizing is one undo step instead of two.

`center` is the BASE centre, matching every other volume in the engine, so pointing at
the floor gives a box standing on it rather than one half-buried. Reachable by voice
(`mask_area` / `unmask_area`) and by touch, and drawn as an outline so the user can see
what they have selected before deleting it.

**It must not refuse for want of a target.** The user reaches for this feature precisely
BECAUSE nothing was identified, so "point at something first" refuses in exactly the
situation it exists to serve. Placement falls back through three sources: the box being
adjusted stays put, a pointed destination wins next, and failing both the box lands on
the floor 1.5m in front of the viewer. That last one needed the viewer pose, so
`InteractionContext` gained an optional `viewer` — the only operation in the system that
must work with nothing selected and nothing pointed at.

**Adjustable without numbers or re-pointing.** A selected box takes `resize` (absolute
per axis or relative deltas, so "make it wider" is one field), `move` to a pointed spot,
`rotate`, and `remove`. Those route ahead of the hallucination guard, which only knows
about `design.objects` and would otherwise refuse every edit to a box the user drew.
Re-issuing the same id replaces rather than appends, so an adjustment is one undo step.

### Two things that made erasure look broken

**Nothing was masked because there is no shell.** `GET /capabilities` returns
`{"reconstruction": null}` — `RECONSTRUCTION_WORKER_URL` is unset, so the store refuses
every reconstruct with `provider_not_configured` and no atlas is ever produced. The
compositor samples the shell, so with no shell it correctly does nothing. The commit
still happens; only the painting is missing. That state is now stated on screen instead
of being silent, because "marked for erasure and the screen did not change" is the most
confusing state this feature has and was exactly what left the assistant improvising.

**Measured furniture was being painted over.** Every object RoomPlan detects entered
`design.objects` and was drawn as an opaque box — so a scanned furnace acquired a grey
rectangle sitting exactly on top of the real one. In AR that reads as the app having
masked it. A real object is now drawn only while carried or selected, and faintly; it
stays pickable, because an invisible mesh still receives pointer events, and it remains
an obstacle in the index regardless of how it is rendered. With no camera the
development room draws everything as before.

Segmentation was not the missing piece. RoomPlan had already detected the furnace —
that is where its box came from — and the worker already unions SAM masks into the atlas
projection for clutter RoomPlan misses. On-device segmentation would add erasure targets
the scan never boxed; it would not put a single pixel on screen while the shell is absent.

### Why the assistant could not erase anything

Asked to erase real pixels, the model reported that it lacked a **"project ID"** — a
concept that exists nowhere in this system. Nothing in its tool vocabulary matched
"delete these pixels", so rather than saying it could not act it invented a prerequisite
and blamed that.

Three changes, all in the prompt surface rather than the engine:

- The `action` enum now carries a description naming which verb does what. `hide` is
  explicitly the ERASE/DELETE/MASK action for real furniture, and is distinguished from
  `remove`, which is for virtual objects or for recording that something has physically
  left the room.
- The session instructions state that there are no projects, accounts, sessions or setup
  steps, and that the only honest reasons for inaction are an unknown target or a tool
  refusal.
- `hide` no longer reports a bare success. It says the pixels are replaced once the
  reconstruction is ready and that the real object is still physically present — so a
  commit that is not yet visible on screen explains itself instead of being explained
  away by whoever is narrating.

`VOICE_INSTRUCTIONS` lives in `runtime/editor.ts`, not the voice adapter: the adapter
imports `react-native-webrtc` and the headless gate cannot load it. Four scenarios assert
on the shipped schema and prompt text.

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
- Device model, OS, native build, lockfile hash, and render resolution: **implementer-reported
  working on a physical device, 2026-09-19; hardware, build and render resolution not
  recorded.** This is weaker than the acceptance procedure below asks for — that procedure
  wants ten-minute FPS windows, frame-freshness samples and recorded walkthroughs, none of
  which exist. Treated as sufficient to unblock M8.5's synthetic preparation only, not as a
  substitute for the M8 acceptance gate.
- Active capture, reconstruction, and compositor adapter IDs: **not recorded**.
- Walkthrough, mask/depth views, and hand-crossing recordings: **not recorded**.
- Ten-minute FPS windows, frame freshness, memory/thermal data, and resource counts: **not recorded**.
- Remaining visual limitations and unsupported capabilities: **not recorded**.
- Acceptance date and reviewer: **not recorded**.
