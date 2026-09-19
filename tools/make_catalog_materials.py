#!/usr/bin/env python3
"""
Fills catalog/materials/ with PBR texture sets for the manifest's furniture
materials, so Twin Mode's procedural furniture is drawn in real oak and real
wool rather than a flat tint.

    python3 tools/make_catalog_materials.py

The textures are checked in — you normally never run this. Same reasoning as
make_catalog_usdz.py: a folder of binaries nobody can regenerate is a liability.

WHY THIS EXISTS. A catalogue model covers the furniture somebody modelled.
Twin Mode — `SceneRenderer.procedural` — covers everything else: the scanned
desk nobody has a USDZ for, the rug, the object whose asset failed to load. It
builds them from boxes at measured size, and a box with a flat colour on it
reads as a render swatch however good the lighting. The same box wearing a wood
grain with a normal map and a real roughness map reads as furniture. This is
the cheapest realism there is: three 1k JPEGs per material.

WHERE THEY COME FROM. Poly Haven (https://polyhaven.com/textures), CC0 — same
library, same licence, same reasons as the models. One texture per manifest
material id; the renderer finds them by convention at
`materials/<material_id>/{diff,nor_gl,rough}.jpg`, so adding a material is a
manifest row, a line in TEXTURES below, and a run of this script.

1k, JPEG. Twin Mode furniture is a stand-in, and 1k across a 0.5m tile is
already finer than the phone can show at arm's length; the whole set is under
3 MB and adds nothing measurable to launch.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_catalog_usdz import API, fetch_file, fetch_json  # noqa: E402

ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, "catalog")
MANIFEST = os.path.join(CATALOG, "manifest.json")
OUT = os.path.join(CATALOG, "materials")

# manifest material id -> Poly Haven texture id. Chosen to match the swatch
# colour each id already promises (`base_color_hex`), so a style plan that
# picked "mat_walnut_dark" for its darkness still gets something dark.
TEXTURES = {
    "mat_oak_light":    "oak_veneer_01",
    "mat_walnut_dark":  "fine_grained_wood",
    "mat_ash_pale":     "plywood",
    "mat_felt_grey":    "poly_wool_herringbone",
    "mat_boucle_cream": "curly_teddy_natural",
    "mat_linen_oat":    "terlenka",
}

# Poly Haven map key -> file the renderer looks for.
MAPS = {"Diffuse": "diff.jpg", "nor_gl": "nor_gl.jpg", "Rough": "rough.jpg"}
RESOLUTION = "1k"


def main():
    with open(MANIFEST) as f:
        manifest = json.load(f)
    materials = {m["id"]: m for m in manifest["materials"]}
    missing = [m for m in TEXTURES if m not in materials]
    if missing:
        sys.exit(f"TEXTURES names material ids missing from manifest.json: {missing}")

    for material_id, asset in sorted(TEXTURES.items()):
        info = fetch_json(f"{API}/info/{asset}")
        files = fetch_json(f"{API}/files/{asset}")
        folder = os.path.join(OUT, material_id)
        for key, name in MAPS.items():
            url = files[key][RESOLUTION]["jpg"]["url"]
            fetch_file(url, os.path.join(folder, name))
        size = sum(os.path.getsize(os.path.join(folder, n)) for n in MAPS.values()) / 1e6
        print(f"  {material_id:18s} <- {asset:24s} {size:.1f} MB")

        materials[material_id]["source"] = {
            "provider": "Poly Haven",
            "asset": asset,
            "url": f"https://polyhaven.com/a/{asset}",
            "license": "CC0",
            "authors": sorted(info.get("authors", {}).keys()),
        }

    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"\nwrote {len(TEXTURES)} texture sets to catalog/materials/ (Poly Haven, CC0)")


if __name__ == "__main__":
    main()
