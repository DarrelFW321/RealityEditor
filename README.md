# Reality Editor

Scan a room with LiDAR. Point your phone at things and talk. The room changes.

The model never generates images. It emits structured operations against a
persistent 3D scene graph, and a constraint solver validates every one against
real measured geometry. That is why it can say *"I shifted it 40cm left so your
closet door still opens"* — it is not describing a picture, it is reporting what
the solver did.

## Run it

Two terminals, both from the repo root. Node 22.13+.

```bash
npm run server     # Fastify on 0.0.0.0:8787
npm run dev        # Metro
```

The app needs a custom dev client — it uses VisionCamera, WebRTC and a local
Swift module, so Expo Go will not work:

```bash
npm run ios --workspace @reality/mobile     # once, needs Xcode
```

Copy `server/.env.example` to `server/.env` and fill in what you need; each
feature reports `not_configured` rather than failing if its key is missing.
Leave `EXPO_PUBLIC_API_URL` **empty** in `mobile/.env` so the phone finds the
server through Metro instead of a pinned IP that goes stale.

Check it is alive with `curl localhost:8787/health`.

## How it fits together

- **The phone owns geometry.** Scene graph, constraint solving, deixis and
  rendering all run on-device. No pose is ever computed off-device.
- **Ops carry intent, never coordinates.** The model emits
  `{target, relation, anchor}` because it cannot see. The solver computes the
  pose against real clearances, door swings and collisions, then reports what it
  did — including when it moved something or refused.
- **The server is never in the op path.** It mints voice tokens, plans themes,
  serves meshes and materials, and runs generation and reconstruction. Each of
  those happens before a turn starts or degrades to something local.

`contracts/schema/*.json` is the single source of truth for RSG (the scene
graph), Op + ConstraintReport, and SCP (what the model knows about where you are
pointing). Run `./contracts/codegen.sh` after editing; never hand-edit generated
types.

## Where furniture comes from

Three sources. The solver cannot tell them apart, because all three reduce to
bounds in metres before it sees them.

| Source | Cost | What it gives you |
|---|---|---|
| **Authored templates** | free, instant | Five families built from boxes, parametric in any dimension, wearing a real PBR material |
| **Catalog** | free at runtime | Pre-built textured meshes for what templates cannot express — sofas, lamps, statues, plants |
| **Text-to-3D** | ~30 credits, ~90s | Anything else. Geometry appears untextured while the material stage runs |

A prompt is matched against the catalog first and only reaches generation when
nothing fits. The matcher will not substitute: ask for six compartments and get
four and it says no, because the audience can count.

Where no asset exists, an authored box stands in — but only where a box is
honest. A sofa becomes a frame in real linen and the substitution is said out
loud. A lamp or a statue, where the silhouette *is* the object, is refused.

## Layout

```
contracts/     JSON Schema — the single source of truth, plus codegen
mobile/        Expo app. Scene graph, solver, renderer, voice loop.
packages/
  spatial-engine/  collisions, clearances, door swings, layout planning
  scene-recipes/   the five authored templates
  object-spec/     prompt -> typed spec, and catalog matching
server/        Fastify. Voice token, style planner, objects, reconstruction.
workers/       Python. Segmentation and inpainting for removal.
catalog/       USDZ + PBR materials + manifest; generated/ holds built meshes
scripts/       catalog build — resumable, and aborts rather than overspending
spikes/        experiments wired into nothing; delete freely
ios/           the original Swift app, superseded by mobile/
```

## Checks

```bash
npm run gate          # everything
npm run gate:app      # editor runtime, replayed tool calls
npm run gate:server   # routes, through Fastify inject()
npm run gate:objects  # prompt analysis, GLB handling, catalog matching
npm run typecheck
```

Most gates replay scripted tool calls, so agent behaviour is reproducible
without a live model.

## More

- [Hackathon plan](docs/hackathon-plan.md) — the original build plan, owner
  split, and the "do not build" list with the one rule we later reversed.
- [Mobile setup](mobile/README.md) · [implementation status](docs/expo-implementation-status.md)
