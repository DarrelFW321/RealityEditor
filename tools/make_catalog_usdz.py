#!/usr/bin/env python3
"""
Fills catalog/usdz/ with photoreal furniture, so a twin can be an actual chair
instead of a grey box — and writes the REAL measured dimensions and triangle
counts of what it shipped back into catalog/manifest.json.

    python3 tools/make_catalog_usdz.py            # build everything in MODELS
    python3 tools/make_catalog_usdz.py --only cat_sofa_boucle_02
    python3 tools/make_catalog_usdz.py --render   # also write PNG previews to /tmp

The USDZ files are checked in — you normally never run this. It exists because
the alternative is an undocumented folder of binaries nobody can regenerate,
re-license, or swap out.

WHERE THE MODELS COME FROM. Poly Haven (https://polyhaven.com/models), CC0.
Public domain, no attribution required, commercial use and redistribution fine
— which is the whole reason it is this library and not one of the "free" model
sites whose terms forbid checking a file into a repo. They are scan-based,
photoreal PBR assets: real base colour, roughness, metallic and normal maps,
authored at real-world scale. Poly Haven's API terms ask only that a product
built on the LIVE API says so; this script downloads once and the files are
bundled, but the credit is in catalog/README.md regardless.

Every model was hand-picked against the manifest entry it stands in for (see
MODELS) — matched on what it IS, not on its name: the entry ids are stable API
for the voice tools and fixtures, the model behind one can change.

WHAT THE PIPELINE DOES TO EACH MODEL, and why every step is there:

  1. Downloads the .usdc mesh plus one texture set. Textures are picked per
     map (TEXTURE_CHOICE): 2k JPEG for colour and normal — on a phone screen
     at arm's length 2k is indistinguishable from 4k and a quarter the bytes
     — 1k JPEG for roughness, and 1k PNG for metallic, which is
     near-constant and compresses to nothing. Poly Haven's own USD references
     EXR textures, which RealityKit does not load from a USDZ; the references
     are rewritten to the JPEG/PNG files actually packed.

  2. Strips the MaterialX network. Blender exports two shader graphs per
     material — a UsdPreviewSurface and a MaterialX `standard_surface` — and
     RealityKit only knows the first. Left in, `usdchecker --arkit` fails on
     `ND_normalmap_float` and usdrecord cannot compile the shader; the safe,
     universally supported graph is the one we keep.

  3. Bakes the up axis. Blender writes `upAxis = "Z"`. RealityKit does honour
     that, but usdrecord, Quick Look on other platforms and the next tool
     someone points at these files may not; the stage is rewritten Y-up with
     the rotation applied explicitly, so there is exactly one interpretation.

  4. Turns it to face the renderer's way. SceneRenderer's convention: at yaw 0
     an object faces -Z, its back is +Z. Blender's is front = -Y, which lands
     at +Z after the axis change — backwards. Seating is checked, not
     assumed: tools/usdzinfo.swift loads the packed file with RealityKit and
     reports where the upper-body mass (backrest, headboard) sits; if it is at
     -Z the model is spun 180° and re-packed. Tables and shelves are
     symmetric enough that it does not matter, and FACING can override any of
     it by hand.

  5. Packs with `usdzip --arkitAsset`, which flattens and re-checks the file
     against RealityKit's own requirements, then `usdchecker --arkit`.

  6. Measures the result WITH REALITYKIT (usdzinfo) and writes `dims_m` and
     `poly_count` into the manifest. Those two numbers are load-bearing:
     `server/src/catalog.ts` filters the catalogue by measured free space, and
     `Applier` sizes every ADD_OBJECT from `dims_m`. A manifest that says a sofa
     is 1.8m wide when the file is 2.1m offers it for a gap it will not fit.

SCALE. Poly Haven models are metric and `SceneRenderer.loadCatalogAsset` scales
a catalogue model to the object's dimensions per axis — so with `dims_m` set
from the model itself, an added or swapped-in object renders at exactly its
authored proportions, and only a scanned object that was assigned a catalogue
asset gets stretched to its measured box.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, "catalog")
MANIFEST = os.path.join(CATALOG, "manifest.json")
OUT = os.path.join(CATALOG, "usdz")
CACHE = os.path.join(tempfile.gettempdir(), "polyhaven-cache")

API = "https://api.polyhaven.com"

# manifest entry id -> Poly Haven asset id. Chosen for what the model IS.
MODELS = {
    # seating
    "cat_chair_dining_oak_01":         "painted_wooden_chair_01",
    "cat_chair_dining_leather_01":     "dining_chair_02",
    "cat_chair_office_mesh_01":        "SchoolChair_01",
    "cat_chair_armchair_boucle_01":    "modern_arm_chair_01",
    "cat_chair_armchair_classic_01":   "ArmChair_01",
    "cat_chair_lounge_midcentury_01":  "mid_century_lounge_chair",
    "cat_chair_felt_01":               "GreenChair_01",
    "cat_chair_stool_ash_01":          "bar_chair_round_01",
    "cat_ottoman_leather_01":          "Ottoman_01",
    "cat_sofa_boucle_02":              "sofa_02",
    "cat_sofa_classic_03":             "sofa_03",
    # tables and desks
    "cat_desk_oak_01":                 "wooden_table_02",
    "cat_desk_metal_office_01":        "metal_office_desk",
    "cat_table_side_wood_01":          "small_wooden_table_01",
    "cat_table_round_wood_01":         "round_wooden_table_02",
    "cat_table_console_classic_01":    "ClassicConsole_01",
    "cat_coffee_table_marble_01":      "coffee_table_round_01",
    "cat_coffee_table_modern_01":      "modern_coffee_table_01",
    # storage
    "cat_nightstand_oak_01":           "side_table_01",
    "cat_nightstand_classic_01":       "ClassicNightstand_01",
    "cat_cabinet_modern_01":           "modern_wooden_cabinet",
    "cat_cabinet_drawers_01":          "drawer_cabinet",
    "cat_shelves_steel_01":            "steel_frame_shelves_01",
    "cat_shelves_display_01":          "wooden_display_shelves_01",
    # beds
    "cat_bed_queen_01":                "GothicBed_01",
}

# Manifest classes whose front/back the backrest heuristic can tell apart.
# Anything else keeps Blender's orientation unless FACING says otherwise.
SEATING_CLASSES = {"chair", "sofa", "bed"}

# Hand overrides: manifest id -> "flip" or "keep". Wins over the heuristic.
#
# Checked by eye (usdrecord from both sides — see --render). Not every artist
# models front = -Y, and the heuristic has nothing to go on for a cabinet,
# whose drawers and back panel weigh the same. The sofa is the one seat it got
# wrong: its arms are as tall as its back, so the upper-body mass is centred.
FACING = {
    "cat_cabinet_drawers_01":    "flip",
    "cat_cabinet_modern_01":     "flip",
    "cat_desk_metal_office_01":  "flip",
    "cat_nightstand_classic_01": "flip",
    "cat_sofa_boucle_02":        "flip",
}

# Per map type: (resolution, format). Map type is the suffix of the texture
# stem Poly Haven uses — `foo_diff`, `foo_rough`, `foo_nor_gl`, `foo_metal`.
TEXTURE_CHOICE = {
    "diff":   ("2k", "jpg"),
    # Roughness is noise-like and compresses badly; at 1k it is a third of the
    # bytes of 2k and nobody can tell on a phone. Colour and normals stay 2k.
    "rough":  ("1k", "jpg"),
    "nor_gl": ("2k", "jpg"),
    "nor_dx": ("2k", "jpg"),
    "metal":  ("1k", "png"),
    "ao":     ("1k", "jpg"),
    "arm":    ("1k", "jpg"),
}
NON_TEXTURE_KEYS = {"blend", "gltf", "usd", "fbx"}


# MARK: - Fetching

# The API refuses Python's default User-Agent with a 403. Say who we are.
USER_AGENT = "reality-editor-catalog/1.0 (+https://github.com/Poly-Haven/Public-API)"


def request(url):
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT})


def fetch_json(url):
    with urllib.request.urlopen(request(url), timeout=60) as response:
        return json.load(response)


def fetch_file(url, dest):
    """Downloads to the cache once; copies from there every time after."""
    os.makedirs(CACHE, exist_ok=True)
    cached = os.path.join(CACHE, url.split("/ph-assets/", 1)[-1].replace("/", "__"))
    if not os.path.exists(cached):
        print(f"      GET {url.rsplit('/', 1)[-1]}")
        with urllib.request.urlopen(request(url), timeout=300) as response, \
                open(cached + ".part", "wb") as f:
            shutil.copyfileobj(response, f)
        os.replace(cached + ".part", cached)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(cached, dest)


def texture_urls(files):
    """stem -> resolution -> format -> url, for every texture map of an asset.

    The stem is the file basename minus `_<res>.<ext>`, which is exactly what
    the USD's own `@./textures/<stem>_2k.exr@` references use — so a reference
    can be matched to a download without guessing at Poly Haven's key names,
    which differ between single- and multi-material assets (`Diffuse` versus
    `pillow_diff`).
    """
    available = {}
    for key, by_res in files.items():
        if key in NON_TEXTURE_KEYS:
            continue
        for res, by_ext in by_res.items():
            for ext, info in by_ext.items():
                name = info["url"].rsplit("/", 1)[-1]
                stem = re.sub(r"_%s\.%s$" % (re.escape(res), re.escape(ext)), "", name)
                available.setdefault(stem, {}).setdefault(res, {})[ext] = info["url"]
    return available


# MARK: - USD surgery

def body_brace(text, pos):
    """Index of the `{` opening a prim's body, given `pos` just after its name.

    Skips the optional metadata `( ... )` first — Blender's `customData = {`
    dictionary lives in there, and a naive search for `{` would land inside it
    and match the wrong braces.
    """
    i = pos
    while text[i].isspace():
        i += 1
    if text[i] == "(":
        depth = 0
        while i < len(text):
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
    return text.index("{", i)


def blocks(text, keyword):
    """Spans of every `def <keyword> "name" ... { ... }` prim, by brace matching."""
    found = []
    for match in re.finditer(r'\n([ \t]*)def %s "([^"]+)"' % keyword, text):
        brace = body_brace(text, match.end())
        depth, i = 0, brace
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        found.append((match.group(2), match.start(), i + 1))
    return found


def remove_spans(text, spans):
    """Cuts spans out of text. Spans nested inside another are dropped first —
    removing an inner one shifts the outer one's end and it would then eat
    whatever followed it (the material's closing braces, as it happens)."""
    outermost = [s for s in spans
                 if not any(o != s and o[0] <= s[0] and s[1] <= o[1] for o in spans)]
    for start, end in sorted(set(outermost), reverse=True):
        text = text[:start] + text[end:]
    return text


def strip_materialx(usda):
    """Removes every MaterialX shader and node graph, and the outputs that
    point at them, leaving the UsdPreviewSurface graph RealityKit understands."""
    drop = []
    for _, start, end in blocks(usda, "NodeGraph"):
        drop.append((start, end))
    for _, start, end in blocks(usda, "Shader"):
        body = usda[start:end]
        if re.search(r'info:id = "ND_', body):
            drop.append((start, end))
    usda = remove_spans(usda, drop)
    usda = re.sub(r"\n[ \t]*token outputs:mtlx:[^\n]*", "", usda)
    return usda


def retarget_textures(usda, available):
    """Rewrites every texture reference to the file this script will pack, and
    returns the (relative path, url) pairs to download."""
    wanted = {}

    def choose(match):
        stem, res, ext = match.group(1), match.group(2), match.group(3)
        kind = next((k for k in TEXTURE_CHOICE if stem.endswith("_" + k)), None)
        want_res, want_ext = TEXTURE_CHOICE.get(kind, (res, "jpg"))
        options = available.get(stem)
        if not options:
            sys.exit(f"texture {stem} referenced by the USD but not offered by the API")
        # Fall back gracefully: the wanted resolution, then anything we have.
        by_ext = options.get(want_res) or options[sorted(options, key=lambda r: int(r[:-1]))[0]]
        chosen_ext = want_ext if want_ext in by_ext else ("png" if "png" in by_ext else "jpg")
        chosen_res = next(r for r, e in options.items() if e is by_ext)
        relative = f"textures/{stem}_{chosen_res}.{chosen_ext}"
        wanted[relative] = by_ext[chosen_ext]
        return f"@./{relative}@"

    # Match on the BASENAME. Most exports reference `./textures/<stem>_2k.exr`;
    # a few older ones use a bare `0/<stem>_1k.exr`. Either way the stem is
    # what identifies the map, and every reference is rewritten into textures/.
    usda = re.sub(r"@(?:[^@/]*/)*([^@/]+?)_(\d+k)\.(exr|jpg|png)@", choose, usda)
    return usda, wanted


def declare_no_subdivision(usda):
    """Blender leaves `subdivisionScheme` unset, which USD reads as Catmull-Clark.
    RealityKit does not subdivide, but a renderer that does would quadruple
    the triangle count `poly_count` promises. Say what we mean."""
    out = []
    last = 0
    for _, start, end in blocks(usda, "Mesh"):
        body = usda[start:end]
        if "subdivisionScheme" not in body:
            body = re.sub(r'(\n[ \t]*)def Mesh "[^"]+"(?:\s*\([^)]*\))?\s*\{',
                          lambda m: m.group(0) + m.group(1) + '    uniform token subdivisionScheme = "none"',
                          body, count=1)
        out.append(usda[last:start])
        out.append(body)
        last = end
    out.append(usda[last:])
    return "".join(out)


def bake_orientation(usda, flip):
    """Z-up -> Y-up, plus an optional 180° about Y, applied on the root prim.

    Applied to the DEFAULT PRIM, which must have no transform ops of its own —
    Blender never gives it any, and a model that breaks that assumption fails
    loudly here rather than rendering on its side on stage.
    """
    header = re.search(r"\A#usda 1\.0\s*\((.*?)\n\)", usda, re.S)
    if not header:
        sys.exit("no stage metadata block")
    meta = header.group(1)
    if 'upAxis = "Z"' not in meta:
        sys.exit("expected a Z-up stage from Blender; got:\n" + meta)
    default = re.search(r'defaultPrim = "([^"]+)"', meta).group(1)
    usda = usda.replace('upAxis = "Z"', 'upAxis = "Y"', 1)

    root = next(((s, e) for name, s, e in blocks(usda, "Xform") if name == default), None)
    if not root:
        sys.exit(f"default prim {default} is not an Xform")
    start, end = root
    name_end = re.compile(r'def Xform "[^"]+"').search(usda, start).end()
    brace = body_brace(usda, name_end)
    # The root's own attributes are whatever sits before its first child prim.
    first_child = re.search(r"\n[ \t]*def ", usda[brace:end])
    own = usda[brace: brace + (first_child.start() if first_child else end - brace)]
    if "xformOp" in own:
        sys.exit(f"root prim {default} already has transform ops; not handled")

    # `start` sits on the newline before `def`; the indent is what follows it.
    indent = re.match(r"[ \t]*", usda[start + 1:]).group(0)
    ops = ['"xformOp:rotateX"']
    lines = [f"{indent}    float xformOp:rotateX = -90"]
    if flip:
        ops.insert(0, '"xformOp:rotateY"')
        lines.append(f"{indent}    float xformOp:rotateY = 180")
    # USD applies the LAST op in xformOpOrder to the points first: axis change,
    # then the spin about the (now vertical) Y axis.
    lines.append(f"{indent}    uniform token[] xformOpOrder = [{', '.join(ops)}]")
    return usda[:brace + 1] + "\n" + "\n".join(lines) + usda[brace + 1:]


# MARK: - Tools

def build_usdzinfo():
    """Compiles the RealityKit inspector once. Needs Xcode's swiftc; macOS only."""
    binary = os.path.join(tempfile.gettempdir(), "usdzinfo")
    source = os.path.join(HERE, "usdzinfo.swift")
    if not os.path.exists(binary) or os.path.getmtime(binary) < os.path.getmtime(source):
        print("compiling tools/usdzinfo.swift")
        subprocess.run(["swiftc", "-O", source, "-o", binary], check=True)
    return binary


def inspect(usdzinfo, usdz):
    result = subprocess.run([usdzinfo, usdz], check=True, capture_output=True, text=True)
    return json.loads(result.stdout.strip().splitlines()[-1])


def pack(work, usda_text, usdz):
    """Repaired USDA -> USDC -> checked USDZ, textures alongside."""
    usda = os.path.join(work, "model.usda")
    usdc = os.path.join(work, "model.usdc")
    with open(usda, "w") as f:
        f.write(usda_text)
    subprocess.run(["usdcat", "-o", usdc, usda], check=True)
    if os.path.exists(usdz):
        os.remove(usdz)
    # --arkitAsset: resolves and packs every texture the layer references,
    # flattens, and applies RealityKit's own packaging rules.
    subprocess.run(["usdzip", "--arkitAsset", "model.usdc", usdz],
                   cwd=work, check=True, capture_output=True, text=True)
    check = subprocess.run(["usdchecker", "--arkit", usdz], capture_output=True, text=True)
    # usdchecker prints spurious "already registered" coding errors on this
    # toolchain; the verdict is the last line.
    verdict = (check.stdout.strip().splitlines() or [""])[-1]
    if "Success" not in verdict:
        sys.exit(f"usdchecker rejected {usdz}:\n{check.stdout}\n{check.stderr}")


def render(usdz, png):
    subprocess.run(["usdrecord", "-w", "512", usdz, png], capture_output=True, text=True)


# MARK: - Main

def build(entry, asset, entry_class, usdzinfo, render_dir):
    info = fetch_json(f"{API}/info/{asset}")
    files = fetch_json(f"{API}/files/{asset}")
    usd = files["usd"]
    # The mesh is identical at every texture resolution; take the smallest.
    lowest = sorted(usd, key=lambda r: int(r[:-1]))[0]
    usdc_url = usd[lowest]["usd"]["url"]

    work = tempfile.mkdtemp(prefix=f"ph-{asset}-")
    try:
        source = os.path.join(work, "source.usdc")
        fetch_file(usdc_url, source)
        usda = subprocess.run(["usdcat", source], check=True, capture_output=True,
                              text=True).stdout

        usda = strip_materialx(usda)
        usda, textures = retarget_textures(usda, texture_urls(files))
        for relative, url in textures.items():
            fetch_file(url, os.path.join(work, relative))
        usda = declare_no_subdivision(usda)

        usdz = os.path.join(OUT, entry.removeprefix("cat_") + ".usdz")
        flip = FACING.get(entry) == "flip"
        pack(work, bake_orientation(usda, flip=flip), usdz)
        measured = inspect(usdzinfo, usdz)

        # Backwards seating: the backrest sits at -Z. Spin it and re-pack.
        if (entry not in FACING and entry_class in SEATING_CLASSES
                and measured["back_mass_z"] < -0.01):
            flip = True
            pack(work, bake_orientation(usda, flip=True), usdz)
            measured = inspect(usdzinfo, usdz)

        if render_dir:
            render(usdz, os.path.join(render_dir, os.path.basename(usdz) + ".png"))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    w, h, d = measured["extents"]
    size_mb = os.path.getsize(usdz) / 1e6
    print(f"  {os.path.basename(usdz):36s} <- {asset:28s} "
          f"{w:.2f}x{h:.2f}x{d:.2f}m  {measured['triangles']:6d} tris  "
          f"{measured['materials']} mat  {size_mb:4.1f} MB"
          f"{'  (flipped)' if flip else ''}"
          f"{'  back_z=%+.2f' % measured['back_mass_z']}")

    return {
        "dims_m": {"w": round(w, 2), "h": round(h, 2), "d": round(d, 2)},
        "usdz_file": f"usdz/{os.path.basename(usdz)}",
        "poly_count": measured["triangles"],
        "source": {
            "provider": "Poly Haven",
            "asset": asset,
            "url": f"https://polyhaven.com/a/{asset}",
            "license": "CC0",
            "authors": sorted(info.get("authors", {}).keys()),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="*", help="manifest entry ids to (re)build")
    parser.add_argument("--render", action="store_true",
                        help="also render a PNG preview of each model into /tmp/catalog-renders")
    parser.add_argument("--no-prune", action="store_true",
                        help="keep .usdz files the manifest no longer references")
    args = parser.parse_args()

    if sys.platform != "darwin":
        sys.exit("macOS only: needs RealityKit, swiftc and /usr/bin/usdzip")

    with open(MANIFEST) as f:
        manifest = json.load(f)
    entries = {e["id"]: e for e in manifest["entries"]}

    unmapped = [e for e in entries if e not in MODELS]
    if unmapped:
        print(f"note: no model for {unmapped} — they render procedurally")
    orphaned = [m for m in MODELS if m not in entries]
    if orphaned:
        sys.exit(f"MODELS names entries missing from manifest.json: {orphaned}")

    wanted = args.only or sorted(MODELS)
    usdzinfo = build_usdzinfo()
    os.makedirs(OUT, exist_ok=True)
    render_dir = None
    if args.render:
        render_dir = "/tmp/catalog-renders"
        os.makedirs(render_dir, exist_ok=True)

    for entry in wanted:
        if entry not in MODELS:
            sys.exit(f"{entry} is not in MODELS")
        print(f"{entry}")
        measured = build(entry, MODELS[entry], entries[entry]["class"], usdzinfo, render_dir)
        # Keep the author's ordering of the entry; only the measured facts change.
        entries[entry].update(measured)

    manifest["entries"] = list(entries.values())
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    if not args.no_prune:
        referenced = {os.path.basename(e["usdz_file"]) for e in entries.values() if e.get("usdz_file")}
        for name in sorted(os.listdir(OUT)):
            if name.endswith(".usdz") and name not in referenced:
                os.remove(os.path.join(OUT, name))
                print(f"  pruned {name} (no manifest entry references it)")

    total = sum(os.path.getsize(os.path.join(OUT, n)) for n in os.listdir(OUT)) / 1e6
    print(f"\ncatalog/usdz/: {total:.1f} MB total. Models: Poly Haven, CC0.")
    if render_dir:
        print(f"previews in {render_dir}")


if __name__ == "__main__":
    main()
