# Spike: untextured geometry + our own materials

Can we generate **geometry only** and dress it with the PBR sets in `catalog/materials/`,
instead of paying Meshy to bake a texture we can never change?

Nothing here is wired into the app. Delete the folder and the product is unaffected.

## Why it would be worth it

A refined Meshy GLB carries its texture inside its own UVs. That one fact causes every
catalog limitation we have:

| | today (baked) | if this works |
|---|---|---|
| resize | uniform scale only; a non-proportional resize moves the collision box and not the mesh | any axis, like procedural |
| recolour | multiply a tint over the bake; four objects opt out because tinting only darkens | swap the material |
| restyle | a theme cannot change a baked oak sofa into linen | swap the material |
| cost | preview + refine | preview only |

It would also make one material system instead of two. Procedural boxes already wear
`mat_oak_light`; catalog meshes wear whatever Meshy painted.

## The crux, and why it is tested first

Tiled materials need somewhere to tile. `should_texture: false` returns geometry with no
reason to carry a UV layout, and even when UVs exist they are an atlas for one baked
image — islands with inconsistent texel density, which a repeating wood grain reveals as
seams and wrong-scale patches.

The standard answer is **triplanar projection**: sample the material three times in
object space and blend by the surface normal. No UVs at all. It is cheap and it is what
terrain and rock shaders have used for years. Whether it looks right on a statue, a sofa
and a lamp is a judgement call, and that is what the bench is for.

**If triplanar does not convince, this idea stops here** and no credits are spent.

## Stage 0 — free, offline, run it now

```bash
node spikes/untextured-materials/strip.mjs        # or --drop-uvs for the honest case
python3 -m http.server 8080                       # from the repo root
open http://localhost:8080/spikes/untextured-materials/bench.html
```

`strip.mjs` rebuilds six catalog GLBs as Meshy returns them untextured — images,
textures and samplers deleted, one neutral material left. Geometry is copied through
byte for byte, so these are the real shapes. `--drop-uvs` also removes `TEXCOORD_0`,
which is the state a `should_texture: false` task most likely arrives in.

The six are chosen to be awkward: a statue (organic), an armchair and a sofa
(upholstered), a floor lamp (spindly), a cabinet (boxy), a plant (thin leaves). A
material that only convinces on the cabinet has proved nothing.

Each row renders the same mesh three ways:

1. **untextured** — what Meshy gives you
2. **the mesh's own UVs** — meaningless once UVs are dropped, kept as the control
3. **triplanar** — the candidate

Switch material and tiling density live. Normal mapping is deliberately off in column 3:
triplanar normals need per-axis tangent blending, and a wrong one would flatter the
result.

### What to look for

- Does oak read as oak on the statue, or as a photograph wrapped round a rock?
- Do the sofa cushions look upholstered, or does the weave float over the form?
- Does the grain scale look right against the object's real size?
- Is there visible stretching where a surface faces diagonally?

## Stage 1 — shape fidelity, only if Stage 0 convinces

Meshy text-to-3D is already good, and **its preview stage is already untextured** — so
the materials idea can ship without any image model at all. Adding an image front-end is
a separate question about shape control, worth its own comparison:

- `POST /openapi/v2/text-to-3d`, `mode: preview` — what we use today
- `POST /openapi/v1/image-to-3d`, `should_texture: false` — image in, geometry out

Available keys: fal, Stability, Meshy. fal is the one to try for the image, on speed.

Judge one prompt three ways — text-to-3D preview, fal image → image-to-3D, Stability
image → image-to-3D — on silhouette accuracy, part separation and triangle budget. Not
on texture: there is none.

**Cost:** Meshy bills 30 credits per task in the examples, with texturing accounting for
10 of it. Budget ~20 per untextured task, so ~60 credits for one three-way comparison.
Confirm before running.

## Stage 2 — only if both hold

Wire `should_texture: false` into `MeshyObjectProvider`, give catalog entries a
`material_ref` instead of a baked finish, and apply the material at render time the way
`SceneView` already does for procedural parts. At that point `tintable` disappears,
resize works on every axis, and the planner can place a real mesh and restyle it.

## Status

- [x] Stage 0 built — **not yet judged, needs eyes on the bench**
- [ ] Stage 1 — needs a spend decision
- [ ] Stage 2 — needs Stage 0 and Stage 1
