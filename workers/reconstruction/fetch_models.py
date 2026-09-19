#!/usr/bin/env python3
"""
Fetches the segmentation and inpainting weights.

    python3 workers/reconstruction/fetch_models.py --all
    python3 workers/reconstruction/fetch_models.py --check

NOT checked in, for the same reason `tools/fetch_lama.py` gives for the Core ML model: a
few hundred megabytes that every clone, `git status` and CI checkout would pay for, when
the pipeline has a working fallback for both stages. `models/` is gitignored.

WITHOUT THESE THE WORKER STILL RUNS. Segmentation falls back to masks projected from the
measured furniture boxes, which are exact for everything RoomPlan categorised; completion
falls back to a deterministic nearest-texel fill. Both paths record which ran, so a result
is never ambiguous about how it was made.

WHERE THEY COME FROM. Neither URL is pinned by this script on purpose — the PRD requires
SAM-family masks and the LaMa baseline to be evaluated independently before one is
selected, so this prints what to fetch and where it must land rather than silently
choosing. Set the paths and the worker picks them up:

    export SAM_WEIGHTS=$PWD/models/sam       # encoder.onnx + decoder.onnx
    export LAMA_WEIGHTS=$PWD/models/lama     # lama.onnx
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "models"

SOURCES = {
    "sam": {
        "dir": MODELS / "sam",
        "files": {
            # MobileSAM: the SAM-family variant that is tractable on CPU. SAM 3 is the
            # PRD's eventual target and is a GPU-worker decision, not a laptop one.
            # Acly/MobileSAM ships the encoder and decoder as a matched pair, which the
            # split-repo alternatives do not.
            "encoder.onnx": "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx",
            # The single-mask decoder: this pipeline prompts with one box per object and
            # wants one answer, not three ranked hypotheses to choose between.
            "decoder.onnx": "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx",
        },
        "env": "SAM_WEIGHTS",
    },
    "lama": {
        "dir": MODELS / "lama",
        "files": {
            "lama.onnx": "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
        },
        "env": "LAMA_WEIGHTS",
    },
}


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  {dest.name} <- {url}")
    temporary = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as out:
        downloaded = 0
        while chunk := response.read(1 << 20):
            out.write(chunk)
            downloaded += len(chunk)
            print(f"\r    {downloaded / 1e6:.0f} MB", end="", flush=True)
    print()
    temporary.replace(dest)


def check() -> int:
    missing = 0
    for name, spec in SOURCES.items():
        for filename in spec["files"]:
            path = spec["dir"] / filename
            state = f"{path.stat().st_size / 1e6:.0f} MB" if path.exists() else "MISSING"
            if not path.exists():
                missing += 1
            print(f"  {name}/{filename}: {state}")
        print(f"    {spec['env']}={os.environ.get(spec['env']) or 'unset'}")
    print(
        "\nThe worker runs without these: geometric masks and a deterministic fill."
        if missing
        else "\nAll weights present."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="fetch every model")
    parser.add_argument("--only", choices=sorted(SOURCES), help="fetch one model")
    parser.add_argument("--check", action="store_true", help="report what is present")
    args = parser.parse_args()
    if args.check or not (args.all or args.only):
        return check()
    for name in [args.only] if args.only else sorted(SOURCES):
        spec = SOURCES[name]
        print(f"{name} -> {spec['dir']}")
        for filename, url in spec["files"].items():
            destination = spec["dir"] / filename
            if destination.exists():
                print(f"  {filename} already present")
                continue
            try:
                fetch(url, destination)
            except Exception as error:
                print(f"  FAILED: {error}", file=sys.stderr)
                print(
                    f"  Fetch it manually into {destination}. The worker falls back "
                    f"until then.",
                    file=sys.stderr,
                )
        print(f"  export {spec['env']}={spec['dir']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
