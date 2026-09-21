> Expo migration: see [mobile setup](mobile/README.md), [implementation status](docs/expo-implementation-status.md), and [plan](docs/implementation-plan-expo.md). Install from this directory with `npm ci`; the workspace root lockfile now owns server and mobile dependencies. The original Swift app remains available below.

# Dex

Scan a room with LiDAR. Point your phone at things and talk. The room changes.

The AI never generates images. It emits structured operations against a
persistent 3D scene graph, and a constraint solver validates every one against
real measured geometry. That is why it can say *"I shifted it 40cm left so your
closet door still opens"* — it is not describing a picture, it is reporting what
the solver did.

**Hack the North 2026, Sept 18–20. 36 hours, 4 people, one 3-minute live demo.**

---

## The number everything serves

> **End of user speech → visible change, under 1.2 seconds.**

Every architectural decision in this repo exists to protect that budget. When a
choice is unclear, the tiebreaker is whichever option spends fewer milliseconds
between someone stopping talking and the furniture moving.

Three consequences worth internalising before you write anything:

- **The phone is authoritative for geometry.** Scene graph, constraint solving,
  deixis resolution, and rendering all run on-device. Geometry never
  round-trips to a server. Not once.
- **The server is authoritative for nothing on the critical path.** It has two
  endpoints: mint a voice token, expand a style theme. That is the whole backend.
- **Ops carry intent, never coordinates.** The model emits
  `{target, relation, anchor}` because it cannot see. The client's solver
  computes the pose.

---

## The three frozen interfaces

These are the contract between four people working in parallel. They are defined
in `contracts/schema/` and both the Swift and TypeScript types are generated from
them.

| Interface | File | What it is |
|---|---|---|
| **RSG** | `rsg.schema.json` | Room Scene Graph. Right-handed, Y-up, metres. Origin at the floor-polygon centroid. |
| **Op** + **ConstraintReport** | `op.schema.json`, `constraint_report.schema.json` | One validated mutation, and the solver's narratable answer. |
| **SCP** | `scp.schema.json` | Spatial Context Packet. 10Hz, under 2KB. What the model knows about where you are pointing. |

> ### No fourth interface after hour 2.
>
> If you need to pass something new between two systems, put it in one of these
> three or pass it inside one of them. A fourth interface added at hour 20 has to
> be threaded through four people's half-finished code, and it will be threaded
> wrong in at least one of them. `ws_frames.schema.json` is a transport envelope,
> not a fourth interface — it just carries the three.
>
> Changing a **field** inside a frozen interface is fine and expected. Edit the
> schema, run `./contracts/codegen.sh`, commit both generated files. What is
> frozen is the *set of interfaces*, not their contents.

---

## Setup

```bash
git clone <this repo> && cd reality-editor
./tools/install-hooks.sh          # once per clone
```

### Everyone, first

```bash
cd ios/SpatialCore && swift build && swift test
```

`swift test` **fails**. That is correct — the solver, applier, and scorer are
unimplemented and throw. Two tests pass (fixture loading and the hallucination
guard). Nothing errors, nothing crashes, and every signature is right, so you can
start filling in bodies immediately.

### Owner A — Capture + Renderer

```bash
cd ios && xcodegen generate && open RealityEditor.xcodeproj
```

Yours: `ios/RealityEditor/Capture/`, `ios/RealityEditor/Render/`.

- `RSGBuilder.swift` has the full contract you must satisfy written into its doc
  comment. Read it before writing a line — the wall-normal orientation note in
  particular, because a flipped normal places furniture outside the house and
  looks like a solver bug.
- You do not need a phone to start. `RSGBuilder.loadFixtureRoom()` returns the
  checked-in bedroom, and it is bundled into the app.
- Twin Mode (measured boxes, no assets) is the default and the fallback. Get that
  working before you load a single USDZ.

### Owner B — Scene graph, ops, solver, deixis

```bash
cd ios/SpatialCore && swift test   # your to-do list, in red
```

Yours: everything in `ios/SpatialCore/Sources/SpatialCore/`. **Never import
ARKit, RealityKit, RoomPlan, or UIKit here** — the package must build and test on
a laptop with no device, or you become blocked on owner A.

Suggested order: `OccupancyGrid` → `Applier.apply` + `inverse` (turns four tests
green) → `ConstraintSolver.solve` → `Scorer.rank`.

`Solver/Clearances.swift` is already a real constants table, not a stub. Use it.

### Owner C — Voice loop

```bash
cd server && cp .env.example .env   # add OPENAI_API_KEY
npm install && npm run dev
```

Yours: `ios/RealityEditor/Voice/`.

`RealtimeSession.swift` and `ToolSchema.swift` are **implemented** — the hello
world works end to end. Your job is the turn logic on top: wiring tool calls into
`Applier.apply`, pushing SCPs at 10Hz, and feeding `ConstraintReport` back as the
tool result so the model can narrate accurately.

The transport is behind `RealtimeTransport`. Swapping WebSocket for WebRTC later
means one new conformance and one changed line.

### Owner D — Backend, assets, UI shell, recorder

```bash
cd server && npm run dev
```

Yours: `server/`, `catalog/`, `ios/RealityEditor/UI/`,
`ios/RealityEditor/Recording/`, `spectator/`.

`SessionRecorder.swift` is implemented. Keep it that way and keep it running —
see the hour-by-hour note below for why it is an hour-1 task.

---

## Hour by hour

| Hour | What must exist |
|---|---|
| 0–2 | Schemas frozen. Codegen green. Everyone building against fixtures. |
| **2** | **Interfaces freeze.** No fourth interface after this point. |
| 1–4 | **Session recorder running.** Not hour 20. See below. |
| 2–8 | A: RoomPlan → RSG. B: occupancy + applier. C: tool calls → ops. D: server live. |
| 8–14 | A: Twin Mode renders a scanned room. B: solver returns real reports. C: full turn loop closed. D: catalogue bundled. |
| 14–20 | First end-to-end turn on device. Measure the 1.2s. Whatever is slowest, fix that and nothing else. |
| 20–26 | The six demo turns, each working three times in a row. Style planner. |
| **23** | Spectator view — **only if the core already works.** Otherwise cut it. |
| 26–30 | Rehearse on the actual venue wifi. Airplane-mode fallback verified. |
| 30–34 | Bug fixing. No new features. None. |
| 34–36 | Rehearse. Sleep if you can. |

### Build the session recorder in hour 1

It looks like instrumentation you can defer. It is not. It buys three things you
need before you have working hardware:

1. **Prompt tuning with no phone.** Replay a recorded session against a changed
   system prompt and see whether the tool calls change.
2. **The airplane-mode fallback, nearly free.** A recorded session is already a
   scripted demo. If the venue wifi dies at minute 2 of 3, play back
   `demo_script.jsonl` and the room still moves.
3. **Something diffable when a turn fails once in ten runs.** That is the failure
   that will actually happen on stage, and without a log you are debugging it by
   asking someone to say the sentence again.

---

## Codegen

`contracts/schema/*.json` is the single source of truth. Both language bindings
are generated:

```
contracts/schema/*.json
    ├─> ios/SpatialCore/Sources/SpatialCore/Generated/Contracts.swift
    └─> server/src/contracts.ts
```

```bash
./contracts/codegen.sh          # regenerate
./contracts/codegen.sh --check  # fail if stale (what the pre-commit hook runs)
```

**Never hand-edit anything in `Generated/` or `server/src/contracts.ts`.** Edit
the schema and regenerate. Hand-maintained types diverge by hour 15, and the bug
reads as a solver fault: the field is simply absent on one side, arrives as nil,
and the furniture lands at the origin.

Two naming notes so nobody files a bug about them:

- The generated Swift type is `Rsg`; `SceneGraph/RSG.swift` aliases it to `RSG`.
- `Op.targetIDS` — quicktype's acronym handling. It is not a typo.

---

## Do not build

Every one of these is a real temptation. Every one is wrong for this repo.

- **A database.** Persistence is P1 and invisible on stage. The op log is a local
  `.jsonl`.
- **A catalogue service.** Static manifest, assets bundled in the app. A network
  fetch when the sofa appears is a 400ms hitch and a live failure mode.
- **A WebSocket op channel to your own server.** Ops arrive on the model
  connection. The server is not in the op path.
- **Auth, accounts, onboarding.** Anonymous device identity. No login.
- **Third-party Swift packages.** Zero. An SPM resolution failure at hour 20 is
  unrecoverable.
- **A fourth interface.** See above.

---

## Layout

```
contracts/          JSON Schema — the single source of truth
  schema/           the five contracts
  fixtures/         sample rooms, SCPs, and a recorded session
  codegen.sh        schema -> Swift + TypeScript
ios/
  SpatialCore/      Swift package. Pure geometry. NO ARKit/RealityKit, ever.
  RealityEditor/    the app target
server/             Fastify. Two routes. Not in the op path.
catalog/            bundled USDZ + materials + manifest
spectator/          Three.js mirror — scaffold only, hour 23
tools/              fixture generation, validation, git hooks
```
