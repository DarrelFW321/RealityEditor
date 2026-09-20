# The minimal interface

The editor has two buttons. Everything else is said out loud.

```
                    ┌──────────────────────────────┐
                    │  I shifted it 40cm left so   │   glass caption, fades after 7s
                    │  your closet door still opens│
                    └──────────────────────────────┘

                         (  🎙  )  ( 📐 )              glass, merged as one material
```

There is always a third, and never a fourth. Which one depends on where you are:

| Room | Third button | What it does |
|---|---|---|
| development room | `viewfinder` | leaves the sample room and starts a real sweep, in one tap |
| your room, live | `cube.transparent` | detaches: the plan and the three-quarter view, away from the room |
| your room, detached | `arkit` | back to the live view |

`viewfinder` is deliberately absent from a real session — it discards the room, and a
button that throws away a scan does not belong next to one that saves it. Both scan
routes go through the same `beginScan`, so the welcome screen and the editor cannot
drift about what starting a scan means.

## The first screen, and the second

```
   ┌──────────────────────────────┐      ┌──────────────────────────────┐
   │        ╱▔▔▔▔▔▔▔▔╲            │      │        ╱▔▔▔▔▔▔▔▔╲            │
   │      ╱  dark cutaway ╲       │      │      ╱  dark cutaway ╲       │
   │     │   ILLUSTRATION  │      │  ->  │     │ YOUR ROOM, TURNING│    │
   │      ╲              ╱        │      │      ╲              ╱        │
   │        ╲▁▁▁▁▁▁▁▁╱            │      │        ╲▁▁▁▁▁▁▁▁╱            │
   ├──────────────────────────────┤      ├──────────────────────────────┤
   │       Reality Editor         │      │  Your room is measured       │
   │  Make room for something new │      │  16.0 m² · 4 walls · 86%     │
   │                              │      │                              │
   │     (   Get started   )      │      │     ( Looks right )          │
   │                              │      │                              │
   └──────────────────────────────┘      └──────────────────────────────┘
```

The welcome screen's column is not bottom-anchored, and its spacer sits BELOW the button
rather than above it. Bringing a sentence and a button together can move either one;
moving the button up is the only version that keeps the words around the middle instead
of dragging them to the bottom with it. The gap between them is fixed at 24pt, so it does
not stretch on a big phone and collapse on a small one the way a proportional one would.

The hero's box is the PICTURE'S OWN SHAPE, not a flexed share of what is left. A flexed
box is almost never the image's aspect, so `contain` fits inside it and leaves a band of
dead space above and below — which is both a smaller room and a wider gap to the sentence
than the layout thinks it is asking for.

Two things that shape needs, both learned the hard way:

- **`maxHeight`.** An aspect-locked box takes its height from the screen's WIDTH and has
  no relationship to how much height is left. `flexShrink` is 0 by default in React
  Native, so on a short screen it keeps its size and pushes the button off the bottom.
  Capped at 44%, the worst case is a letterboxed picture rather than a missing button.
- **`alignSelf: 'stretch'`, not `width: '100%'`.** A percentage width resolves against the
  parent's content box, so the negative margin meant to bleed the picture past the page's
  padding only slid it sideways — it was never actually full width. Stretch resolves
  after margins, which is what makes the bleed real.

The picture bleeds 24pt PAST each screen edge. It can, because the crop leaves 8% of
background margin of its own: over-bleeding spends that margin rather than the room, so
the diorama is 15% larger and there is still 12pt of empty dark beside it. That last bit
is what keeps it from reading as a crop — push the bleed further and the room touches the
edges again, which is exactly how it looked wrong before.

Two spacers rather than one, taking equal shares above the picture and below the button,
which centres the block. The picture ITSELF cannot be centred on the screen — it is more
than half of it, and putting its middle on the screen's middle pushes the button off the
bottom. What can be centred, and what reads as centred, is everything together: on a
393x852 screen the block's middle lands at 49%.

The bleed is NOT symmetric: 60pt on the left against 36pt on the right, which moves the
picture 12pt left of centre. The diorama's bounding box sits within 2px of its frame's
middle, so geometrically it was already centred — but the bookshelf, the monitors and the
car are all on the right while the left wall is dark and empty, and the eye puts the
centre of that right of where a bounding box does. The margins are page colour on page
colour, so a shift has nothing to give it away; the only thing it can cost is the room
running off the side.

Measured — on a 393x852 screen the diorama spans 6pt to 363pt, so it clears the left edge
by 6 and the right by 30; on an SE, 20 and 44; on a Pro Max, 9 and 33. Six points is
close to the limit for this bleed.

Every build launches here. A `__DEV__` shortcut that opened straight into the sample room
was tried and reverted: skipping the landing page in the build you are developing means
never seeing the landing page, which is the screen most in need of being seen.

The sample room kept one door, because a simulator and a phone without depth otherwise
have no way into the editor at all: a long-press on the wordmark, `__DEV__` only. A door
without being a button, which is the point — the button was removed from this screen
deliberately.

The welcome screen is a picture; everything after it is the real thing. There is no room
yet on the first screen, so nothing true can be drawn there — and a render of a fixture
pretending to be your bedroom is a worse lie than an illustration that is plainly one.
The moment there IS a room, it is drawn by the renderer that will edit it, and that one
turns.

The still does not, and cannot: an image model asked for the same diorama twelve degrees
round returns a DIFFERENT bedroom rather than the same one from a new angle, and no
prompt fixes that because the model has no scene to rotate. Only the measured room, which
has actual geometry, spins.

Generated through the Backboard key and the Gemini image model `POST /inpaint` already
uses; `tools/hero-image.ts` keeps the prompt so it can be made again rather than being an
artefact nobody can reproduce.

`tools/seat-hero.py` does three things to it afterwards, and the generator runs them
itself, so a regenerated hero cannot arrive with any of them. Each exists because the
model got something NEARLY right.

**Size.** It returns whatever it feels like: 1280 one run, 4096 and 3.5MB the next.
Downscaling first is not only about bytes — averaging four pixels into one removes the
render's speckle, and speckle is what makes the two steps below miss.

**Colour.** Its background has to BE the page or the hero is a rectangle of
slightly-wrong dark with a visible edge, and asking for `#0C1420` in the prompt is not
enough: `#0A111B` one run, `#090F1F` the next. Near-background pixels are BLENDED towards
the target rather than shifted by a constant, because the surround is not flat — there is
a vignette, and a constant shift moves a gradient without flattening it. Measured over
110 edge samples: mean 1.3, worst 4, which is JPEG's own wobble rather than a colour
difference.

**Crop.** The model composes small — about two thirds of the frame — so a third of the
picture is background the page can supply for free. Cutting it makes the room half again
as large at the same layout size, and the file gets smaller doing it. The margin left
behind is 12.5%, not the 3.5% first tried: at 3.5% the diorama fills 93% of its frame, and
a full-bleed hero then runs the room into both screen edges and reads as a crop rather
than as a picture of something.

The untouched artifact is kept in the temp directory rather than deleted, because
otherwise the only way to try a different crop is another generation, and another
generation returns a different room.

## The room is the artwork

```
   ┌──────────────────────────────┐      ┌──────────────────────────────┐
   │        ╱▔▔▔▔▔▔▔▔╲            │      │        ╱▔▔▔▔▔▔▔▔╲            │
   │      ╱  isometric  ╲         │      │      ╱  isometric  ╲         │
   │     │   cutaway     │        │  ->  │     │   cutaway     │        │
   │      ╲  SAMPLE     ╱         │      │      ╲  YOUR ROOM  ╱         │
   │        ╲▁▁▁▁▁▁▁▁╱            │      │        ╲▁▁▁▁▁▁▁▁╱            │
   │         ( Sample room )      │      │      ( 16.0 m² · 4 walls )   │
   ├──────────────────────────────┤      ├──────────────────────────────┤
   │  REALITY EDITOR              │      │  Your room is measured       │
   │  Make room for               │      │  Stay here, or take it with  │
   │  something new.              │      │  you and work on the plan.   │
   │                              │      │                              │
   │        ( Get started )       │      │  ( Edit in the room )        │
   │                              │      │  ( Development room )        │
   └──────────────────────────────┘      └──────────────────────────────┘
        welcome                               after the sweep
```

`RoomPortrait` draws the measured room with the same R3F renderer and the same scene
graph the editor edits. Dark, because it is looked at inside a dark app, over a dark page,
next to a dark hero — a cream doll's house in the middle of that reads as a different
application. No ground ring: it was a flourish, and it was the one thing on the screen
that meant nothing.

Near walls are dropped rather than modelled away, every frame, from the wall's own
inward normal. Which walls are near depends on where the camera is and the room turns
slowly, so baking it in would be wrong within two seconds. The normal is flipped towards
the floor centroid before it is used: the schema says wall normals point into the room
and the fixture obliges, but `buildIndex` normalises wall winding at read time precisely
because a real capture does not always — and a cutaway that trusted the stored direction
would remove the two walls you are looking THROUGH and leave you staring at the back of
the near ones. Checked at every quarter turn: two adjacent walls kept, always the far
pair.

The lens is long and far away. A wide one at this angle bows the floor slab outwards and
the room stops reading as a model of a room and starts reading as a fisheye of one.

## After the sweep

```
Get started  ->  sweep  ->  editing, listening  ->  blueprint
```

Nothing in between. The sweep ends, the room appears and voice is already up — the
microphone starts itself with the editor, so there is nothing to read and nothing to
dismiss before talking to the room.

A shaping step lived here briefly: a shell-only view for pushing walls around before any
furniture existed to be in the way of them. It gave `offset_wall`, `ceiling_height` and
`resize_opening` their first controls, and it was removed a turn later because a screen
between finishing a scan and using the room is a screen in the way. All three edits are
still reachable the way they always were — "move that wall in ten centimetres" — so what
went is the detour, not the capability.

`mobile/src/components/ShapeRoom.tsx` and `RoomPortrait.tsx` are unreferenced as a
result. They are kept rather than deleted because the decision reversed inside one turn,
not because anything calls them.

## Where the development room is

After the sweep, before anything else — the screen above on the right. The scan used to land straight in the live view, which assumed the only reason to measure
a room is to stand in it. It is not: half the time the room has just been measured in
order to be thought about somewhere else. Both pills reach the same editor holding the
same room and differ only in whether the camera is the backdrop, so the choice is free —
and the `cube.transparent` button switches between them afterwards either way.

`needs_view` still intercepts genuinely poor coverage first, and its "use it anyway" now
arrives at this junction rather than skipping past it.

The welcome screen's `__DEV__` shortcut is relabelled **Empty sample room**, because that
is what it is: a 4x4 fixture. "Development room" now names the place a MEASURED room goes.

## Taking the room with you

A scan is finished standing in the room and thought about somewhere else. Point the phone
at a different room and the live view shows your furniture registered to walls that are
not in front of you, so detaching swaps the camera for the drawing and the three-quarter
view — the development room, holding your room.

It is a VIEW, not a different scene. The room keeps its geometry, its edits and its
`observed` provenance. Relabelling a measured room as a sample to reuse that code path
would be a lie about where the geometry came from, and the blueprint prints that
provenance on the page.

### Looking around

| Fingers | What it means |
|---|---|
| one | select, point, carry — unchanged |
| two, dragged | orbit: across turns, down tips towards you |
| two, pinched | closer and further |

The split is what makes both possible at once. A single finger already means three things,
so the view had to claim a gesture that could never be one of them — and it claims it in
the CAPTURE phase on the scene's own container, so a one-finger touch is never intercepted
on its way to the object underneath. The exit swipe was narrowed to single-touch at the
same time: a two-finger drag downwards from the top of the screen is an ordinary way to
look at the ceiling, not a request to throw the room away.

The camera's seat is spherical — bearing, elevation, distance — because it is dragged.
Storing a position instead would mean recovering those two angles from it every frame.
It is read through a ref and applied in `useFrame` rather than held in state: the gesture
is a stream of touch events, and routing sixty of those a second through React would
re-render the whole editor to move a camera. The defaults reproduce the old fixed
`[4, 5, 6]` exactly, so a room nobody drags looks precisely as it always did.

Only where the phone is not already the camera. In the live view ARKit owns the pose, and
a dragged one would be overwritten sixty times a second while fighting it.

Tuned slower than desktop orbit controls, which map a screen height to a full circle: at
that rate a thumb-and-finger drag spins the room twice and you lose which wall you were
looking at. A swipe across turns about 130 degrees; the full usable tilt takes about 450px
and stops short of both the floor and straight overhead, the second being degenerate as
well as useless.

Three things that are not obvious:

- **The camera keeps running, behind an opaque backdrop.** Unmounting `SpatialView` is
  the obvious way to detach and it mints a new `frameId` on the way back —
  `SpatialCaptureView` generates one per instance. The scene was built with the old one,
  so every intent would then fail `context.frameId !== state.frameId` as stale and the
  hand cursor would refuse every frame. Covering it costs some battery and keeps the
  ARSession, the room anchor and that id alive.
- **Tracking stops gating edits.** While detached the phone may be in another building.
  Tracking still reports honestly, but it is no longer a statement about whether an edit
  can be trusted — nothing is being aligned to the camera — so it must not refuse one.
- **The camera needs putting back on its tripod.** `CameraPose` does not merely move the
  R3F camera, it overwrites the PROJECTION with ARKit's, straight from the frame. Stop
  feeding it and both are left wherever the phone last was, which drops you at head
  height inside a wall looking through a lens belonging to a device you are no longer
  holding. `DeskCamera` mounts whenever there is no frame and rebuilds both.

## What went, and where it went

| Was | Now |
|---|---|
| `+ bed  + table  + frame  + shelf  + cabinet` | "put a table over there" |
| `◻ mask area`, `✕ unmask` | "mask that", "hide it" |
| `✦ blue bedroom` | "make it a blue bedroom with three frames" |
| Carry · Cancel · Rotate 15° · Wider · Blue · Remove | "pick it up", "turn it", "wider", "get rid of it" |
| `Undo` | "undo" |
| `Start voice` | starts by itself; the button now mutes |
| `End session`, top right | swipe down from the top, or "end the session" |
| `Modules` and the diagnostics sheet | long-press the microphone, `__DEV__` only — which also opens the live, touchable floor plan |
| Eight stacked status lines | one caption, ranked, that fades |

Two new spoken actions carry the buttons that remain: `export_blueprint` and
`end_session` in `IntentSchema`. They are app actions, not scene edits — no transaction,
no revision, no inverse — so `createEditor` only forwards them to whoever registered
`onAppAction`, and the op log never learns about them. Putting them through the engine
would have created undo entries that undo nothing.

## Liquid Glass

`expo-glass-effect` is `UIGlassEffect`, which is iOS 26. This app's deployment target is
17.0, and on an older phone the module renders a plain `View` — transparent, over a live
camera feed, which is worse than ugly: it is invisible. So `src/components/Glass.tsx`
carries its own translucent fallback and only hands the drawing to the system when
`isLiquidGlassAvailable()` says the system can do it. `GlassCircle` sets `isInteractive`,
which is what makes glass flex under a finger; without it the material is just a blurry
disc.

Both pods were already in the build — `expo-glass-effect` and `expo-symbols` arrive
through `expo-router` and were already autolinked — so nothing new had to be compiled
for them.

## The microphone

It starts on its own with the editor, and comes back on its own after backgrounding.
Mute disables the audio track rather than stopping it: the session, its tools and the
conversation so far all survive, WebRTC keeps sending silence so server-side voice
detection never fires, and unmuting is instant instead of a renegotiation.

The icon shows what it is doing, from the session's own events:

| State | Icon |
|---|---|
| connecting | spinner |
| muted | `mic.slash.fill`, warm red |
| listening | `mic.fill` |
| **hearing you** | `waveform`, animating, blue — and the glass itself takes a blue tint |
| thinking / replying | `waveform`, animating, dimmer |

`hearing` comes from `input_audio_buffer.speech_started`, the same signal that opens a
turn — so the icon cannot claim to have heard something the model did not.

## One thing the strip-down nearly broke

`proposal` — the "apply this arrangement?" prompt — was only ever set by the touch
restyle handler behind the `✦ blue bedroom` chip. Delete the chip and a restyle asked for
**by voice** would park the transaction in `awaiting_confirmation` with nothing on screen
able to confirm it. It is now polled from `editor.pendingProposal()` on the existing 10Hz
tick, which is where both paths end up.

Cancelling had the mirror-image bug and always did: `cancel` only ever reached the engine,
so declining a restyle left the proposal parked and a later "yes" — about something else
entirely — applied it. The panel merely stopped drawing it, which is what hid it.
`cancel` now clears the parked proposal.

## Nothing painted on the glass

`isInteractive` is the whole of it: `UIGlassEffect` flexes, brightens and catches its own
specular highlight under a finger. A hand-drawn version — an edge line and a diagonal
streak in plain Views — was built and removed, because two translucent rectangles
imitating a highlight, on top of a material already producing one, read as a sticker on a
window. The only thing set on top of the system material is `GLASS_TINT`, and that is for
legibility rather than looks: glass adapts to its BACKDROP, not to the text on it, so a
caption over a sunlit wall would otherwise be light on light.

The one call to action on a screen is `size="large"`: full width, 19pt type, and enough
padding to be hit without aiming. `wide` is for a secondary directly under one — the same
width so the two read as one column, but slimmer and quieter, because a second button of
equal weight means neither is the answer. Everything else stays `normal`.

## Contrast

Light text on glass is only as readable as whatever the camera is pointed at, and
`UIGlassEffect` adapts towards the BACKDROP rather than towards the text on top — so a
caption over a sunlit wall ends up light-on-light. Every glass surface therefore carries
`GLASS_TINT`, a dark tint that costs none of the material's depth and guarantees a floor
under the type. Secondary text moved from mid-grey to a pale blue-white and up a point;
mid-grey on glass is the hardest thing to read on a screen held at arm's length in a room
you are also looking at.

The blueprint went the other way, because its paper is white: the ink is darker than a
drawing sheet would normally want, and the smallest type came up about a point. That page
is read at A4 in a PDF *and* at a fifth of that inside the development sheet, where the
classic light architectural greys stop being restrained and start being invisible.
Contrast is chosen for the small case; the large one can afford it.

## Getting out

A pan responder on a 96pt strip at the top of the screen. It declines the touch on start
and only claims it once the finger has travelled 14pt downward, so a tap on an object near
the top of the view falls straight through to the scene rather than being eaten by an
invisible dismiss target. Past 60pt it asks before discarding the room.
