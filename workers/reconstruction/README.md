# Reconstruction worker

Turns registered keyframes plus a measured room into a clean empty-room shell:

```
segmentation → visible-background projection → hole completion → clean-shell manifest
```

Python because the model libraries are, which the PRD explicitly permits for workers. It
does **not** replace Fastify and introduces no FastAPI: transport is one POST handler on
the standard library, because a single-route service does not need a framework.

## Run it

```bash
pip install -r workers/reconstruction/requirements.txt
python3 -m workers.reconstruction                       # serves on 127.0.0.1:8788
python3 workers/reconstruction/selftest.py              # numerical check, no weights needed
```

Point the server at it:

```bash
# server/.env
RECONSTRUCTION_WORKER_URL=http://127.0.0.1:8788
RECONSTRUCTION_WORKER_TOKEN=any-shared-secret
```

Inspect what each stage produced — the plan requires masks, projected backgrounds and
completed surfaces to be separable so a bad result is traceable to the stage that caused it:

```bash
python3 -m workers.reconstruction --dump out/          # every request writes its stages
python3 -m workers.reconstruction --once req.json --dump out/
```

`out/` gets `mask-N.png` per keyframe, and per surface `projected-*.png` (observed only,
holes black), `holes-*.png` and `completed-*.png`, plus the packed `atlas.png` and
`shell.json`.

## Models

```bash
python3 workers/reconstruction/fetch_models.py --check
python3 workers/reconstruction/fetch_models.py --all
export SAM_WEIGHTS=$PWD/models/sam LAMA_WEIGHTS=$PWD/models/lama
```

Signatures were verified against the actual models, not taken from the published
contracts — the encoder wants HWC at native resolution, `orig_im_size` must be
`[1024, 1024]`, and LaMa returns 0–255 already. Each wrong assumption produced
plausible-looking output rather than an error; see `sam.py` and `lama_model.py`.

**Both stages run without weights**, and say which path they took:

| Stage | With weights | Without |
|---|---|---|
| Segmentation | SAM, unioned with the geometric masks | geometric masks only |
| Completion | LaMa | deterministic nearest-texel fill |

Geometry does most of the segmentation work regardless: a measured object's box is fixed in
room space and the camera pose is known, so its silhouette is exact and temporally stable.
SAM is there for clutter RoomPlan never categorised, which geometry cannot see. Its output
is **unioned**, never substituted — a segmenter having a bad day can add false positives
but cannot un-mask the sofa.

## What it will not do

- **Invent geometry.** The room arrives measured. Only appearance is generated, and every
  surface carries `observedFraction` and an `inferred` flag saying how much of it is real.
- **Erase camera pixels.** That is M8. This produces the world-space shell M8 composites
  from; the split exists because per-frame inpainting flickers and this does not.
- **Trust itself.** Fastify re-validates the response and the store applies the semantic
  cross-checks, so a manifest for the wrong calibration or one missing its shell is refused
  before anything is written.

## Conventions

Matrices arrive column-major. ARKit camera space is +X right, +Y up, **−Z forward**, so a
visible point has negative z. Image space is pixels, origin top-left, **+v down**. Geometry
is in room space — floor centroid at the origin — while keyframe poses are in ARKit world
space, which is what `room.origin` reconciles. `geometry.py` states all of this again at
the top, because a sign error here produces an atlas that looks entirely plausible and is
registered to the wrong place.
