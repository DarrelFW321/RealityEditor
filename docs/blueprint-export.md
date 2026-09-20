# Blueprint export

Export the room — as edited, not as scanned — to a PDF floor plan.

The ruler button beside the microphone opens a preview of the page, or say "export a
blueprint". `Export PDF` inks it and hands the file to the iOS share sheet, which
previews, prints, mails or saves it to Files.

## What was researched first

**RoomPlan cannot do this.** Its only export is
[`CapturedRoom.export(to:exportOptions:)`](https://developer.apple.com/documentation/roomplan/capturedroom/export(to:exportoptions:)),
which writes USD, USDA or USDZ — 3D, parametric or mesh. There is no 2D plan and no PDF.
Apple's own answer to the question ([forums/thread/713409](https://developer.apple.com/forums/thread/713409))
is that you draw it yourself from `surface.transform`, `surface.dimensions` and
`category`; the reference implementation everyone cites,
[denniswave/RoomPlan-2D](https://github.com/denniswave/RoomPlan-2D), renders it in
SpriteKit.

**No React Native package helps either.** The floor-plan libraries that exist
(`react-planner`, `@asunited/floor-planner`, `react-floorplanner`) are React DOM
components for *drawing* plans with a mouse, not for rendering one from measured
geometry. [`fordat/expo-roomplan`](https://github.com/fordat/expo-roomplan) wraps the
scan, which `mobile/modules/spatial-capture` already does, and does less: no frame
stream, no hand cursor, no keyframes.

**And RoomPlan could not draw the right room anyway.** `CapturedRoom` only ever holds
what was *measured*. The point of this feature is exporting a room after you have put
things in it, and those things exist only in `EditorState.design`.

So the geometry comes from the RSG, and the only real decision left was what puts ink on
the page. That is `UIGraphicsPDFRenderer` — Apple's PDF renderer, Core Graphics
underneath — called from the Swift module the app already owns. No new pods.

## Shape

```
packages/blueprint/src/sheet.ts   page geometry: primitives, layers, scale ladder
packages/blueprint/src/index.ts   buildPlan(EditorState) -> PlanSheet
packages/blueprint/selftest.ts    the gate

mobile/modules/spatial-capture/ios/BlueprintPDF.swift   PlanSheet -> Core Graphics -> PDF
mobile/src/adapters/blueprint.ts                        native call + share sheet
mobile/src/components/BlueprintView.tsx                 PlanSheet -> react-native-svg
```

`buildPlan` decides every coordinate; the Swift renderer and the SVG preview are
transcriptions of that decision into their own primitives. There are no arcs in a
`PlanSheet` — a door swing is a flattened polyline — because an arc means two angle
conventions (SVG sweeps, `CGContext.addArc`) that disagree about which way positive is,
and a door that opens through the wall on one of the two renderers is worse than 32
straight segments nobody can see.

Sheet space is points, origin top-left, +y down. That is SVG's convention and it is the
one `UIGraphicsPDFRenderer` hands to its drawing block, so nothing is flipped anywhere.

Geometry is reused, never re-derived: object footprints come from `footprint()` and door
swings from `swingArcPolygon()` in `@reality/spatial-engine`, so the drawing and the
solver cannot disagree about where anything is.

## Editing through the plan

Long-press the microphone in a development build and the sheet opens with the plan of the
room as it is now, live, redrawn on every committed edit. Tap a shape to select it; drag
it to move the object.

It does not edit the drawing. A drag asks the SOLVER to move the object and the plan
redraws from whatever the scene became — so a move can be adjusted, held for a yes, or
refused, exactly as one asked for by voice can. A plan you could edit directly would be a
second source of truth for where the furniture is.

Which is why the drag is RELATIVE. The gesture knows how far the finger travelled; only
the scene knows where the object started, and `pose.position` names different corners of
the box for different pivots — reading a centroid off the drawing would quietly shift
anything pivoted on its back edge.

Three things make the page readable backwards, and all three are gated:

- every object shape carries the `id` the scene graph knows it by, so a hit test resolves
  to an entity rather than to a guess;
- `sheet.projection` is the affine the page was actually drawn with, published rather than
  reconstructed, and checked corner-for-corner against `footprint()`;
- `fitPage`/`viewToSheet` undo SVG's `xMidYMid meet` letterboxing. A handler that forgets
  the bars is off by half of one everywhere, in the same direction every time, which reads
  as the app being confidently wrong rather than imprecise.

The plan is a top-down view, which is the view in which "is there room for this" is
obvious and the camera view is not — you cannot see the near wall and the far wall at once
through a phone.

## What the drawing will not claim

- Scale comes from a ladder of real drawing ratios, or the sheet says `NOT TO SCALE`.
  A plan that says 1:50 and is not 1:50 is a lie a ruler can catch.
- Walls the scan inferred are overdrawn dashed and counted in the notes.
- A door whose swing RoomPlan did not report — which is every device-captured door — is
  drawn as a plain opening, and the notes say why there is no arc.
- Scanned furniture is dashed, furniture added in the editor is solid blue, and the title
  block counts each.
- Every sheet carries `scan-derived and are not a survey`.

## Verifying it

```
npm run gate:blueprint     # 36 checks, no device
npm run gate               # runs it alongside everything else
```

The page itself is inked by Core Graphics on a phone, which no check here can reach —
so everything that decides where a line goes lives in `buildPlan`, which is pure and runs
under node. The gate asserts the drawn footprint is edge-for-edge the one the engine
computes, that labels run along an object's long axis rather than across it, that a door
leaf is drawn open, that nothing lands off the page, that the same room draws the same
sheet twice, and — for the touchable plan — that a finger in a letterboxed view lands back
on the shape it was over.

On device: scan a room, say what you want in it, tap the ruler, `Export PDF`.

## Note for the next build

`react-native-svg` is new, so the preview needs a fresh development client:

```
npx expo prebuild --clean && npm run ios --workspace @reality/mobile
```

The PDF itself needs the same rebuild to pick up `BlueprintPDF.swift`. An older binary
still runs: `blueprintAvailable()` checks for the function rather than the module, and the
preview says the build cannot write a PDF instead of failing at the share sheet.
