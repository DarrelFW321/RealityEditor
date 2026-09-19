# Catalog

Bundled 3D assets and materials. **Owner: D.**

## Assets ship inside the app bundle

Not fetched from a server. Ever.

A network fetch at the moment the sectional appears is a 400ms hitch in the one
second that has to feel instant, and on conference wifi it is a live failure mode
in front of judges. Everything in `usdz/` and `materials/` is compiled into the
`.app`. The size cost is real and it is the right trade.

## Budget

Hold these. They are not arbitrary — they are what keeps the app under a
reasonable install size and RealityKit under a stable frame rate on a phone that
is already running ARKit, a scene graph, and a live audio stream.

| Thing | Budget |
|---|---|
| USDZ models | ~25 total |
| Triangles per model | ≤ 15,000 |
| PBR materials | ~15 total |
| Texture resolution | 2048² maximum |
| Total bundled assets | keep under ~150 MB |

`poly_count` in `manifest.json` is the real triangle count of the asset, not an
estimate. The renderer uses it to decide what to draw at distance; a wrong number
there is a frame-rate bug that looks like a solver bug.

## manifest.json

The single index of what exists. Two arrays:

- **`materials`** — `id`, `style_tags[]`, `base_color_hex`. Referenced by
  `material_ref` on every surface and object in the RSG.
- **`entries`** — `id`, `class`, `style_tags[]`, `dims_m {w,h,d}`, `usdz_file`,
  `poly_count`, `variants[]`. Referenced by `asset_ref` on an object and by
  `catalog_id` in `ADD_OBJECT` / `REPLACE_OBJECT` op params.

`class` uses the RoomPlan category vocabulary so a catalog entry can stand in for
a scanned object of the same class. Where nothing fits (a rug), pick the nearest
category and let `style_tags` carry the meaning — do not invent a new class, it
will fail RSG validation.

`dims_m` is load-bearing and must match the actual asset. The server filters the
catalogue by measured free space before the style planner ever sees it
(`server/src/catalog.ts`), so a model whose declared dimensions are wrong will be
offered for a room it does not fit in.

## Adding an asset

1. Drop the `.usdz` in `usdz/`, under 15k tris.
2. Add an entry to `manifest.json` with its **real** dimensions and poly count.
3. Add it to the Xcode target's Resources so it lands in the bundle.

There is no build step and no asset pipeline. On this clock, there should not be.
