"""
Numerical self-check: `python3 workers/reconstruction/erase_selftest.py`

Paints a wall whose colour is a known function of position, stands a dark object against
it, and asserts that erasing the object leaves the wall — and leaves the wall it actually
had, not an average of it.

Hermetic. The segmenter and the filler are injected, so the whole contract is checked
without 250MB of weights and the gate runs the same way on any machine. What the real
models change is quality; what is asserted here is the part that must hold whatever they
return, which is the part that can silently be wrong.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from erase import CONTEXT, DILATE, erase, grow, object_mask, region_box, window_fill  # noqa: E402

W, H = 640, 480
# The object, in pixels. Deliberately NOT the same rectangle as the region: the user's
# box is an estimate and the whole point of segmenting is that the two differ.
OBJECT = (250, 180, 390, 400)      # x0, y0, x1, y1
REGION = {"x0": 0.34, "y0": 0.32, "x1": 0.65, "y1": 0.88}
OBJECT_RGB = (18, 20, 26)

PASS, FAIL = "\x1b[32mok\x1b[0m", "\x1b[31mNO\x1b[0m"
results: list[tuple[bool, str, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((ok, label, detail))


def wall(width: int = W, height: int = H) -> np.ndarray:
    """A gradient, so a fill that returns one flat colour is visibly not the wall."""
    xs = np.linspace(60, 200, width, dtype=np.float32)[None, :]
    ys = np.linspace(40, 150, height, dtype=np.float32)[:, None]
    rgb = np.zeros((height, width, 3), dtype=np.float32)
    rgb[..., 0] = xs
    rgb[..., 1] = ys
    rgb[..., 2] = 0.5 * (xs + ys)
    return rgb.astype(np.uint8)


def photograph() -> tuple[np.ndarray, np.ndarray]:
    """The wall, and the wall with the object standing against it."""
    clean = wall()
    shot = clean.copy()
    x0, y0, x1, y1 = OBJECT
    shot[y0:y1, x0:x1] = OBJECT_RGB
    return clean, shot


def encode(rgb: np.ndarray) -> str:
    ok, buffer = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    assert ok
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def decode(image_base64: str) -> np.ndarray:
    buffer = np.frombuffer(base64.b64decode(image_base64), dtype=np.uint8)
    return cv2.cvtColor(cv2.imdecode(buffer, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)


class StubSegmenter:
    """Stands in for SAM: returns the object's true silhouette, whatever the prompt."""

    def __init__(self, silhouette: np.ndarray, calls: list) -> None:
        self.silhouette = silhouette
        self.calls = calls

    def masks(self, image_base64: str, seed: np.ndarray) -> np.ndarray:
        self.calls.append(seed.copy())
        return self.silhouette


def truth_fill(rgb: np.ndarray, mask: np.ndarray, clean: np.ndarray) -> np.ndarray:
    """A perfect filler, so a wrong RESULT is a wrong mask rather than a weak model."""
    return np.where(mask[..., None], clean, rgb)


def main() -> int:
    clean, shot = photograph()
    encoded = encode(shot)
    x0, y0, x1, y1 = OBJECT
    silhouette = np.zeros((H, W), dtype=bool)
    silhouette[y0:y1, x0:x1] = True

    # ---------------------------------------------------------------- the region box
    box = region_box(REGION, W, H)
    check("the region maps to pixels", box == (218, 154, 416, 422), str(box))
    check(
        "a reversed region is still a box",
        region_box({"x0": 0.8, "x1": 0.2, "y0": 0.9, "y1": 0.1}, W, H) == (128, 48, 512, 432),
        str(region_box({"x0": 0.8, "x1": 0.2, "y0": 0.9, "y1": 0.1}, W, H)),
    )
    check(
        "an out-of-range region is clamped, not trusted",
        region_box({"x0": -5.0, "x1": 9.0, "y0": -1.0, "y1": 2.0}, W, H) == (0, 0, W, H),
        str(region_box({"x0": -5.0, "x1": 9.0, "y0": -1.0, "y1": 2.0}, W, H)),
    )

    # ---------------------------------------------------------------- which pixels
    # Without a segmenter the box is the mask. Correct, and blunter: it covers wall the
    # object never occluded, which is exactly what asking SAM is meant to stop.
    blunt, source = object_mask(encoded, shot, box, None)
    check("with no segmenter the box is the mask", source == "box", source)
    check("which covers the whole region", blunt[box[1] : box[3], box[0] : box[2]].all(), f"{int(blunt.sum())}px")

    calls: list = []
    tight, source = object_mask(encoded, shot, box, StubSegmenter(silhouette, calls))
    check("a segmenter is prompted with the box", len(calls) == 1 and bool(calls[0][y0 + 5, x0 + 5]), f"{len(calls)} prompt(s)")
    check("the box is what it is prompted with", calls and calls[0].sum() == (box[2] - box[0]) * (box[3] - box[1]), f"{int(calls[0].sum()) if calls else 0}px")
    check("and its outline is used instead", source == "sam", source)
    check("which is tighter than the box", int(tight.sum()) < int(blunt.sum()), f"{int(tight.sum())} < {int(blunt.sum())}")
    check("while still covering every pixel of the object", tight[y0:y1, x0:x1].all(), "covered")

    # The mask is grown on purpose. An outline a few pixels small leaves a rim of the
    # original object, which reads as a halo around the hole.
    short = min(box[2] - box[0], box[3] - box[1])
    margin = int(round(short * DILATE))
    check("it is grown past the outline", margin > 0 and bool(tight[y0, max(0, x0 - margin)]), f"{margin}px")
    check("but not without bound", not tight[y0 - 4 * margin, x0], "bounded above")

    # The contact shadow, and the direction that is easy to write backwards.
    shadowed = grow(silhouette, 0, 10)
    check("the shadow extends below the object", shadowed[y1 + 5, x0 + 10] and not shadowed[y0 - 5, x0 + 10], "downward")

    # A segmenter that wanders must not be allowed to erase the room.
    everything = np.ones((H, W), dtype=bool)
    wandering, source = object_mask(encoded, shot, box, StubSegmenter(everything, []))
    check("a runaway mask is clipped to the region's neighbourhood", not wandering[0, 0] and not wandering[H - 1, W - 1], f"{int(wandering.sum())}px")
    # And one that finds nothing must leave the object covered by the box rather than
    # leaving it on screen.
    empty, source = object_mask(encoded, shot, box, StubSegmenter(np.zeros((H, W), dtype=bool), []))
    check("an empty mask falls back to the box", source == "box" and empty[y0 + 5, x0 + 5], source)

    # ---------------------------------------------------------------- what colour
    result = erase(
        {"imageBase64": encoded, "region": REGION},
        segmenter=StubSegmenter(silhouette, []),
        filler=lambda rgb, mask: truth_fill(rgb, mask, clean),
    )
    out = decode(result["imageBase64"])
    check("the frame comes back the same size", out.shape == shot.shape, str(out.shape))
    check("the mask source is reported", result["stages"]["mask"] == "sam", result["stages"]["mask"])
    check("and so is the fill", result["stages"]["fill"] == "injected", result["stages"]["fill"])

    worst = int(np.abs(out[y0:y1, x0:x1].astype(int) - clean[y0:y1, x0:x1].astype(int)).max())
    check("the object is gone and the real wall is back", worst == 0, f"worst channel error {worst}")
    darkest = out.reshape(-1, 3).sum(axis=1).min()
    check("nothing as dark as the object is left anywhere", darkest > sum(OBJECT_RGB) + 30, f"darkest {darkest} vs object {sum(OBJECT_RGB)}")

    # THE CLAIM THAT MAKES A FULL-FOOTPRINT PATCH SAFE. Everything outside the mask is
    # the original photograph, so the parts of the box that were never the object are
    # still real wall rather than something a model invented.
    mask, _ = object_mask(encoded, shot, box, StubSegmenter(silhouette, []))
    outside = ~mask
    check("every pixel outside the mask is byte-identical", bool((out[outside] == shot[outside]).all()), f"{int(outside.sum())}px preserved")
    check("including wall inside the box the object never covered", bool(mask[box[1] + 2, box[0] + 2]) is False and bool((out[box[1] + 2, box[0] + 2] == shot[box[1] + 2, box[0] + 2]).all()), "real wall kept")

    # A model that paints outside its mask is RECORDED and still cannot change the wall.
    def vandal(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        return np.full_like(rgb, 255)

    guarded = erase(
        {"imageBase64": encoded, "region": REGION},
        segmenter=StubSegmenter(silhouette, []),
        filler=vandal,
    )
    vandalised = decode(guarded["imageBase64"])
    check("a filler that repaints everything is contained", bool((vandalised[outside] == shot[outside]).all()), "wall survived")
    check("and the overreach is counted", guarded["stages"]["changedOutsideMask"] > 0, str(guarded["stages"]["changedOutsideMask"]))

    # ---------------------------------------------------------------- the fill window
    #
    # A learned filler sees a fixed square. Tiling the whole frame hands it tiles that
    # are almost entirely hole — furniture is bigger than one tile — so it has no wall
    # left to continue from and returns a smooth wash matching neither wall nor floor.
    # Measured on the real model before this was a window: mean error in the hole went
    # from a grey blob to a continued wall/floor line, and from four passes to one.
    seen: list[tuple[int, float]] = []

    def watcher(rgb: np.ndarray, holes: np.ndarray) -> np.ndarray:
        seen.append((rgb.shape[0], float(holes.mean())))
        return np.full_like(rgb, (7, 9, 11))

    windowed = window_fill(shot, silhouette, watcher)
    check("the filler is called exactly once", len(seen) == 1, f"{len(seen)} call(s)")
    check("on a square frame", seen and seen[0][0] == 512, f"{seen[0][0] if seen else 0}px")
    # The number that matters: how much of what the model sees is wall it can continue.
    check(
        "with real wall around the hole to continue from",
        seen and seen[0][1] < 0.6,
        f"{seen[0][1] * 100:.0f}% hole, {CONTEXT:.0%} context requested" if seen else "-",
    )
    check("only masked pixels are taken from it", bool((windowed[~silhouette] == shot[~silhouette]).all()), "rest untouched")
    check("and the masked ones are", bool((windowed[silhouette] == (7, 9, 11)).all()), "filled")

    # A mask touching the frame edge must not index outside it.
    edge = np.zeros((H, W), dtype=bool)
    edge[H - 40 :, : 40] = True
    corner = window_fill(shot, edge, watcher)
    check("a mask in the corner stays inside the frame", corner.shape == shot.shape, str(corner.shape))
    check("an empty mask is a no-op", bool((window_fill(shot, np.zeros((H, W), dtype=bool), watcher) == shot).all()), "unchanged")
    # A filler that returns the wrong size must not corrupt the frame.
    check(
        "a filler returning the wrong shape changes nothing",
        bool((window_fill(shot, silhouette, lambda rgb, m: np.zeros((8, 8, 3), np.uint8)) == shot).all()),
        "unchanged",
    )

    # ---------------------------------------------------------------- degrading
    # No weights at all is the gate's own default, and it must still remove the object.
    plain = erase({"imageBase64": encoded, "region": REGION})
    plain_out = decode(plain["imageBase64"])
    check("with no models configured it still runs", plain["stages"]["fill"] == "telea", plain["stages"]["fill"])
    check("and the object is still gone", int(np.abs(plain_out[y0 + 20 : y1 - 20, x0 + 20 : x1 - 20].astype(int) - OBJECT_RGB).sum(axis=-1).min()) > 40, "removed")

    for bad, reason in (({}, "missing_image"), ({"imageBase64": "!!!not base64!!!"}, "undecodable_image")):
        try:
            erase(bad)
            check(f"{reason} is refused", False, "accepted")
        except ValueError as error:
            check(f"{reason} is refused", str(error) == reason, str(error))
        except Exception as error:
            check(f"{reason} is refused", False, f"{type(error).__name__}: {error}")

    for ok, label, detail in results:
        print(f"  {PASS if ok else FAIL} {label}" + (f" \x1b[2m- {detail}\x1b[0m" if detail else ""))
    passed = sum(1 for ok, _, _ in results if ok)
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
