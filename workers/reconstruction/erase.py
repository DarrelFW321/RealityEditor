"""
One frame, one box, the object inside it gone.

Distinct from the reconstruction pipeline in every way that matters. That runs over a
whole sweep, builds surface atlases and fills the texels no camera ever saw. This answers
a single question the device asks at the moment the user hides something: *given this
photograph and this box, what does the wall behind look like?*

Two stages, and the first one is the point of this module.

1. WHICH PIXELS. A box is not a silhouette. Filling the box's whole footprint paints over
   wall that never needed painting, and an oversized box paints over a lot of it. SAM is
   prompted with the box — which is exactly the interface it wants, and exactly what
   `segment.py` already does for the atlas — and returns the object's actual outline.
   Without weights the box itself is the mask, which is what this did before and is still
   correct, only blunter.

2. WHAT COLOUR. LaMa, masked, on the real photograph. A masked model is conditioned on
   the observed pixels surrounding the hole, so it continues THIS wall rather than
   imagining a plausible one — the same argument `inpaint.py` makes for sitting at the
   `complete()` boundary.

PRESERVATION IS ENFORCED, NOT REQUESTED. Every pixel outside the mask is copied back from
the original afterwards and the number the model had moved is reported. That is what lets
the caller cover the box's whole footprint with the result: the parts that were never the
object come back byte-identical, so they are still the real wall. The alternative — a
provider that may repaint anywhere, described to in words — is what `/inpaint` had to
work around with geometry.

Everything degrades rather than refusing. No SAM is a blunter mask; no LaMa is a
deterministic fill; neither is an error, because every one of them still removes the
object and the alternative is leaving it on screen.
"""

from __future__ import annotations

import base64
import os

import numpy as np

# How far the mask is grown past what the segmenter returned, as a fraction of the
# region's short side. An outline that is a few pixels too small leaves a rim of the
# original object, which reads as a halo; a few pixels too large takes wall that gets
# filled with more wall. The two failures are not comparable, so this leans large.
# `segment.py` inflates for the same reason and says so.
DILATE = 0.04
# Downward only, for the contact shadow. Once an object is gone its shadow on the floor
# is the most visible tell that something used to be there, and no segmenter includes it
# in the object.
SHADOW = 0.05
# SAM may legitimately extend past a box that under-covers its object, and must not be
# free to grow across the whole room. Bounded to the region grown by this much.
BLEED = 0.25
# Below this the segmenter found nothing usable and the box is the better answer.
MIN_MASK_FRACTION = 0.01
# The learned filler sees a fixed 512 square. How much room around the mask is included
# in that square, as a fraction of the mask's own size — this is the wall the model has
# to continue FROM, and without enough of it the fill is a wash.
CONTEXT = 0.6
LAMA_FRAME = 512


def _decode(image_base64: str) -> np.ndarray | None:
    """
    RGB, whatever the sender encoded. `imdecode` sniffs the container itself.

    Malformed base64 is a caller error, not a crash: it comes back as None and becomes
    the same named refusal as an image OpenCV cannot read, so the worker answers 400
    rather than 500 and the server can say which of the two it was.
    """
    import cv2

    try:
        raw = base64.b64decode(image_base64, validate=False)
    except Exception:
        return None
    if not raw:
        return None
    bgr = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    return None if bgr is None else cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _encode(rgb: np.ndarray) -> str:
    import cv2

    ok, buffer = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        raise RuntimeError("png_encode_failed")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def region_box(region: dict, width: int, height: int) -> tuple[int, int, int, int]:
    """Normalised bounds to pixel bounds, clamped and never empty."""
    x0 = int(round(max(0.0, min(1.0, float(region.get("x0", 0.0)))) * width))
    x1 = int(round(max(0.0, min(1.0, float(region.get("x1", 1.0)))) * width))
    y0 = int(round(max(0.0, min(1.0, float(region.get("y0", 0.0)))) * height))
    y1 = int(round(max(0.0, min(1.0, float(region.get("y1", 1.0)))) * height))
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    return x0, y0, max(x1, x0 + 1), max(y1, y0 + 1)


def grow(mask: np.ndarray, pixels: int, shadow: int) -> np.ndarray:
    """Dilate in every direction, then downward alone for the contact shadow."""
    import cv2

    out = mask
    if pixels > 0:
        size = pixels * 2 + 1
        out = cv2.dilate(out.astype(np.uint8), np.ones((size, size), np.uint8)).astype(bool)
    if shadow > 0:
        # OpenCV reads `src(y + row - anchor)`, so rows AT AND ABOVE the anchor make a
        # pixel inherit from what is above it — which extends the mask DOWNWARD. Written
        # out because it is exactly the kind of sign that goes in backwards silently;
        # the self-test asserts the shadow lands below the object and not above it.
        kernel = np.zeros((shadow * 2 + 1, 1), np.uint8)
        kernel[: shadow + 1, 0] = 1
        out = cv2.dilate(out.astype(np.uint8), kernel).astype(bool)
    return out


def object_mask(
    image_base64: str,
    rgb: np.ndarray,
    box: tuple[int, int, int, int],
    segmenter=None,
) -> tuple[np.ndarray, str]:
    """
    The pixels to replace, and where the answer came from.

    The box always produces a usable mask, so the segmenter is strictly an improvement on
    it: anything it cannot do confidently leaves the box in place rather than leaving the
    object on screen.
    """
    height, width = rgb.shape[:2]
    x0, y0, x1, y1 = box
    seed = np.zeros((height, width), dtype=bool)
    seed[y0:y1, x0:x1] = True

    source = "box"
    mask = seed
    if segmenter is not None:
        try:
            refined = segmenter.masks(image_base64, seed)
        except Exception:  # pragma: no cover - model/runtime dependent
            refined = None
        if refined is not None and refined.shape == seed.shape:
            # SAM may extend past a box that under-covers its object, which is the point.
            # It may not wander across the room, which is what an unbounded mask from a
            # low-confidence prompt looks like.
            margin_x = int(round((x1 - x0) * BLEED))
            margin_y = int(round((y1 - y0) * BLEED))
            allowed = np.zeros((height, width), dtype=bool)
            allowed[
                max(0, y0 - margin_y) : min(height, y1 + margin_y),
                max(0, x0 - margin_x) : min(width, x1 + margin_x),
            ] = True
            refined = refined & allowed
            if refined.sum() >= MIN_MASK_FRACTION * seed.sum():
                mask, source = refined, "sam"

    short = min(x1 - x0, y1 - y0)
    return grow(mask, int(round(short * DILATE)), int(round(short * SHADOW))), source


def _segmenter():
    weights = os.environ.get("SAM_WEIGHTS")
    if not weights:
        return None
    try:
        from sam import SamSegmenter

        return SamSegmenter(weights)
    except Exception:  # pragma: no cover - model/runtime dependent
        return None


def window_fill(rgb: np.ndarray, mask: np.ndarray, fill) -> np.ndarray:
    """
    Runs a fixed-size filler on ONE window around the mask, instead of tiling the frame.

    `LamaInpainter.fill` walks the whole image in 512 tiles, which is right for an atlas
    whose holes are small and scattered — every tile still holds plenty of observed
    texture. It is wrong here. A piece of furniture is larger than one tile, so each tile
    is almost entirely hole, the model has no surrounding wall to continue, and what
    comes back is a smooth grey wash that matches neither the wall nor the floor. That is
    not a weak model; it is a model shown nothing to work from.

    So the window is the mask plus `CONTEXT` of margin, squared and scaled to the frame
    the model wants. SCALING IS SAFE HERE in a way `inpaint.py` rule 2 is not about:
    only masked pixels are ever taken from the result, and those are invented at any
    resolution. No observed pixel is resampled — the caller pastes them back untouched.
    """
    import cv2

    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return rgb
    height, width = mask.shape
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    # Square, so a fixed-size model is not handed a room stretched along one axis.
    span = max(y1 - y0, x1 - x0)
    side = min(span + 2 * int(round(span * CONTEXT)), height, width)
    top = max(0, min(height - side, (y0 + y1) // 2 - side // 2))
    left = max(0, min(width - side, (x0 + x1) // 2 - side // 2))

    crop = rgb[top : top + side, left : left + side]
    holes = mask[top : top + side, left : left + side]
    if not holes.any():
        return rgb
    frame = (LAMA_FRAME, LAMA_FRAME)
    small = cv2.resize(crop, frame, interpolation=cv2.INTER_AREA if side > LAMA_FRAME else cv2.INTER_LINEAR)
    small_holes = cv2.resize(holes.astype(np.uint8), frame, interpolation=cv2.INTER_NEAREST).astype(bool)
    if not small_holes.any():
        return rgb
    filled = fill(small, small_holes)
    if filled is None or filled.shape[:2] != frame:
        return rgb
    restored = cv2.resize(filled, (side, side), interpolation=cv2.INTER_LINEAR)
    out = rgb.copy()
    patch = out[top : top + side, left : left + side]
    out[top : top + side, left : left + side] = np.where(holes[..., None], restored, patch)
    return out


def _filler():
    """`fill(rgb, mask) -> rgb`, learned when weights allow and deterministic otherwise."""
    weights = os.environ.get("LAMA_WEIGHTS")
    if weights:
        try:
            from lama_model import LamaInpainter

            model = LamaInpainter(weights)
            # A 512 window is exactly one of `fill`'s own tiles, so this is a single
            # model pass rather than a walk across the frame.
            return lambda rgb, mask: window_fill(rgb, mask, model.fill), "lama"
        except Exception:  # pragma: no cover - model/runtime dependent
            pass

    def telea(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        import cv2

        # The same deterministic fill `complete()` keeps as its baseline: nearest
        # observed pixel, marched inward. On a plain wall it is genuinely enough.
        return cv2.inpaint(rgb, mask.astype(np.uint8), inpaintRadius=8, flags=cv2.INPAINT_TELEA)

    return telea, "telea"


def erase(request: dict, segmenter=None, filler=None) -> dict:
    """
    `{imageBase64, region}` in, `{imageBase64, stages}` out.

    `segmenter` and `filler` are injected by the self-test so the contract can be checked
    without 250MB of weights, and resolved from the environment otherwise.
    """
    image_base64 = request.get("imageBase64")
    if not isinstance(image_base64, str) or not image_base64:
        raise ValueError("missing_image")
    region = request.get("region") or {}
    if not isinstance(region, dict):
        raise ValueError("invalid_region")

    rgb = _decode(image_base64)
    if rgb is None:
        raise ValueError("undecodable_image")
    height, width = rgb.shape[:2]
    box = region_box(region, width, height)

    mask, mask_source = object_mask(
        image_base64, rgb, box, _segmenter() if segmenter is None else segmenter
    )
    if filler is None:
        filler, fill_source = _filler()
    else:
        fill_source = getattr(filler, "name", "injected")

    filled = filler(rgb, mask)
    if filled is None or filled.shape != rgb.shape:
        # A filler that returns nothing usable leaves the photograph untouched. The
        # caller's local fill is already covering the box, so this is a missed
        # improvement rather than a hole in the user's room.
        return {
            "imageBase64": image_base64,
            "stages": {
                "mask": mask_source,
                "maskPixels": int(mask.sum()),
                "regionPixels": int((box[2] - box[0]) * (box[3] - box[1])),
                "fill": "none",
                "changedOutsideMask": 0,
                "preserved": True,
            },
        }

    # HOLE-ONLY, CHECKED RATHER THAN TRUSTED. `inpaint.py` rule 1, for the same reason: a
    # model that paints outside its mask is recorded and still cannot change the wall.
    outside = ~mask
    changed = int(np.any(filled[outside] != rgb[outside], axis=-1).sum()) if outside.any() else 0
    result = np.where(mask[..., None], filled, rgb).astype(np.uint8)

    return {
        "imageBase64": _encode(result),
        "stages": {
            "mask": mask_source,
            "maskPixels": int(mask.sum()),
            "regionPixels": int((box[2] - box[0]) * (box[3] - box[1])),
            "fill": fill_source,
            "changedOutsideMask": changed,
            "preserved": True,
        },
    }
