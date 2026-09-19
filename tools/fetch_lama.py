#!/usr/bin/env python3
"""
Fetches and compiles LaMa (image inpainting) for the diminished-reality eraser.

    python3 tools/fetch_lama.py

NOT checked in, unlike catalog/usdz's models — this one is 187MB, and every
clone, `git status`, and CI checkout paying that cost for a stretch feature
that already has a working fallback (`DiffusionInpainter`) is the wrong trade.
Run this once; `ios/RealityEditor/Models/LaMa.mlmodelc/` is gitignored and the
eraser runs the geometric fill instead when it is not there — see
`LaMaPhotoInpainter.loadIfNeeded` and EraseCapture's doc comment on why the
fill is swappable at all.

WHERE IT COMES FROM. mlboydaisuke/LaMa-CoreML on Hugging Face, Apache-2.0 — a
`coremltools` conversion of advimman/lama (Suvorov et al., WACV 2022) for
on-device inference. Confirmed the model's actual contract before writing any
Swift against it (`ios/tools` has no way to introspect a `.mlmodel` at build
time, so this is the only chance): two 800x800 image inputs, "image" (RGB) and
"mask" (grayscale, 255 = fill this), one 800x800 RGB "output". `computeUnits`
is fixed to `.all` in `LaMaPhotoInpainter` because the HF card is explicit that
a different compute unit can silently change the numerics or crash the GPU —
that is the setting the conversion was verified against, not a suggestion.

WHY COMPILED HERE, NOT ON DEVICE. Two options ship a Core ML model in an app:
add the `.mlpackage` to the Xcode target and let Xcode's build-time Core ML
tool compile it, or compile it to `.mlmodelc` yourself and ship that as a
resource. The PROJECT TAKES THE SECOND PATH DELIBERATELY, for the same reason
`catalog/usdz` is a plain resource folder rather than a build-phase asset
catalog: `project.yml`'s source globs need no per-file registration, adding a
model needs no project.yml edit, and `MLModel(contentsOf:)` loads a compiled
`.mlmodelc` directly with no Xcode-generated Swift class to keep in sync. It
also means first launch never pays Core ML's own JIT compile — this script
already has.

    python3 tools/fetch_lama.py
    python3 tools/fetch_lama.py --check     # verify a previously fetched model still loads

This is macOS-only: it shells out to `xcrun coremlcompiler`, which does not
exist on Linux CI. That is fine — the eraser's fallback path has no such
requirement, and this script is a developer tool, not a build step.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS = os.path.join(ROOT, "models")
DEST = os.path.join(MODELS, "LaMa.mlmodelc")

REPO = "mlboydaisuke/LaMa-CoreML"
BASE = f"https://huggingface.co/{REPO}/resolve/main/LaMa.mlpackage"
# The three files that make up the package. `Manifest.json` is the mlpackage's
# own index; the other two are its one Core ML program and its weights.
FILES = {
    "Manifest.json": "Manifest.json",
    "Data/com.apple.CoreML/model.mlmodel": "Data/com.apple.CoreML/model.mlmodel",
    "Data/com.apple.CoreML/weights/weight.bin": "Data/com.apple.CoreML/weights/weight.bin",
}


def download(url, local, attempts=5):
    """Retries on 429/5xx with backoff. HF's anonymous rate limit is real and
    transient — a 187MB weight file is exactly the request that trips it, and
    failing the whole fetch on the first hiccup would make this script less
    reliable than just re-running it by hand."""
    request = urllib.request.Request(url, headers={
        # An anonymous default urllib UA is itself a reason HF throttles
        # harder; identifying the client is not just politeness here.
        "User-Agent": "reality-editor/fetch_lama.py (+https://github.com)"})
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request) as response, open(local, "wb") as f:
                shutil.copyfileobj(response, f)
            return
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503) or attempt == attempts:
                raise
            wait = 2 ** attempt
            print(f"  {error.code} from Hugging Face, retrying in {wait}s "
                  f"({attempt}/{attempts})")
            time.sleep(wait)


def fetch(work):
    package = os.path.join(work, "LaMa.mlpackage")
    for remote, relative in FILES.items():
        local = os.path.join(package, relative)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        url = f"{BASE}/{remote}"
        print(f"downloading {url}")
        download(url, local)
    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(package) for f in fs)
    print(f"fetched {size / 1e6:.0f} MB")
    return package


def compile_package(package, work):
    out = os.path.join(work, "compiled")
    subprocess.run(["xcrun", "coremlcompiler", "compile", package, out], check=True)
    compiled = os.path.join(out, "LaMa.mlmodelc")
    if not os.path.isdir(compiled):
        sys.exit(f"coremlcompiler did not produce {compiled}")
    return compiled


def check():
    """Confirms a previously fetched model still loads, without re-downloading."""
    if not os.path.isdir(DEST):
        sys.exit(f"{DEST} does not exist — run tools/fetch_lama.py first")
    # A real load, not just a directory check: the same call
    # `LaMaPhotoInpainter.loadIfNeeded` makes, so a corrupt or half-copied
    # model is caught here rather than at the first "remove the chair".
    swift = f'''
    import CoreML
    let config = MLModelConfiguration(); config.computeUnits = .all
    let model = try MLModel(contentsOf: URL(fileURLWithPath: "{DEST}"), configuration: config)
    print("inputs:", model.modelDescription.inputDescriptionsByName.keys.sorted())
    print("outputs:", model.modelDescription.outputDescriptionsByName.keys.sorted())
    '''
    result = subprocess.run(["swift", "-"], input=swift, text=True,
                            capture_output=True)
    print(result.stdout, end="")
    if result.returncode != 0:
        sys.exit(f"model failed to load:\n{result.stderr}")
    print("LaMa.mlmodelc loads correctly")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="verify the fetched model, then exit")
    args = parser.parse_args()

    if sys.platform != "darwin":
        sys.exit("macOS only: this needs xcrun coremlcompiler")

    if args.check:
        check()
        return

    work = tempfile.mkdtemp(prefix="lama-fetch-")
    try:
        package = fetch(work)
        compiled = compile_package(package, work)
        os.makedirs(MODELS, exist_ok=True)
        if os.path.exists(DEST):
            shutil.rmtree(DEST)
        shutil.move(compiled, DEST)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\nwrote {DEST}")
    check()


if __name__ == "__main__":
    main()
