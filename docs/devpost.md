# Devpost submission draft

## Inspiration

We were tired of designing a physical space on a flat screen. Every tool for
changing a room is 2D: a floor plan in a browser, a render, a photo with
furniture pasted in. You decide by dragging rectangles, then walk into the room
and find out you were wrong.

The room is right there. It has clearances and a door that has to open. We wanted
to stop representing it and start working inside it: point at the corner you
mean, say what you want, and see it happen at full size while you stand in it.
That means an agent, not menus, and it means the model cannot draw the result,
because a generated picture is a flat screen again.

## What it does

Dex is an agent that edits a physical room through your phone.

- Scan once. LiDAR gives it measured walls, floor, openings and furniture, and
  anything the camera never faced is marked inferred.
- Point and talk. It calls tools rather than producing text, and it emits a
  target, a relation and an anchor instead of coordinates. The solver computes
  the pose against real clearances, door swings and collisions.
- It reports what the solver did, including when it shifted something 40cm to
  keep a door usable, or refused and offered alternatives.
- "Mask that" boxes an object the scan never recognised. "Hide it" segments it,
  fills the region and projects the result onto the wall, so the real furniture
  stops appearing in the camera view.
- Describe furniture that does not exist and it is generated as a textured 3D
  object, measured, and shown at the size it would really be.
- Export the room as edited to a scaled PDF floor plan.

## How we built it

- Expo and React Native with React Three Fiber, a native Swift module, a Fastify
  server and a Python worker.
- The agent runs on the OpenAI Realtime API over WebRTC, opened by the phone. The
  server only mints a short lived token. Live entity ids are injected into the
  tool schema as enums, so it cannot act on an object that does not exist.
- The environment is a TypeScript spatial engine with no ARKit imports, so it
  runs headless: collisions, clearances, door swings, a 5cm lattice search that
  adjusts or refuses, transactions and undo.
- Generation is a pipeline. A prompt becomes a typed spec with category, size,
  dimensions and material, is matched against a catalog first, and only reaches
  Meshy text to 3D when nothing fits. Returned GLBs are validated and measured
  before anything loads them.
- Removal runs in Python: geometric masks unioned with Segment Anything, and
  LaMa or a deterministic fill.
- 235 automated checks across six gates, most of them replaying scripted tool
  calls so agent behaviour is reproducible without a live model.

## Challenges we ran into

- Slow responses landed on the wrong object, because they were bound to whichever
  turn was speaking rather than the turn that asked.
- Our own tool description listed mask as a synonym for delete, so asking to mask
  something ran an erase.
- Text to 3D returns a furnished scene. It fills shelves with books, and the model
  has no negative prompt, so exclusions had to go in the positive prompt.
- Colour is a multiply, so it can only darken. The prompt asks for a pale neutral
  bake, otherwise a blue tint goes muddy.
- The room had no ARAnchor and drifted. A 12cm and 3 degree world revision put a
  placed point 48.6cm out; following the anchor brought it to 0.000mm.
- Every component passed its gate while the chain was dead, because a worker URL
  was unset and every job was refused.

## Accomplishments

- The agent cannot hallucinate a target. Ids come from the scene, and an
  unresolved reference becomes a question rather than an action.
- Generated furniture is treated like measured furniture. Bounds come off the
  mesh in metres, so the same solver and clearances apply with nothing special
  cased.
- Guesses are visible. The spec records which dimensions were defaulted and what
  it could not resolve.
- Removal works with no server and no reconstruction, filling from surrounding
  camera pixels when nothing better exists.
- Registration is measured, not judged by eye. The reconstruction places a known
  marker within 0.3cm of ground truth.

## What we learned

- Give the model intent and keep the geometry. Most failure modes then become
  solver outcomes you can report.
- A generative model is a source of assets, not decisions. What comes back is
  bytes to validate and measure first.
- Bind work to the turn that asked for it. Almost every agent bug was an ordering
  problem, not a reasoning problem.
- Degrade instead of refusing. Without a model the mask is blunter or the fill is
  deterministic, and the object still goes away.

## What's next for Dex

- Put generation in the agent's hands. It is a separate screen today, so the next
  step is a tool that generates an object and hands it to the solver.
- Grow the catalog from what people generate, so a common request stops costing a
  provider call.
- Finish device acceptance for live compositing at 30 FPS with hand and foreground
  preservation.
- Memory across sessions, phones without LiDAR, and more than one room.

## Built with

Expo, React Native, TypeScript, Swift, Objective-C++, Python, ARKit, RoomPlan,
Apple Vision, React Three Fiber, three.js, expo-gl, OpenGL ES, WebRTC, OpenAI
Realtime API, Anthropic Claude, Meshy, Segment Anything, LaMa, ONNX Runtime,
OpenCV, NumPy, Fastify, Node.js, JSON Schema
