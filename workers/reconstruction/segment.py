"""
Stage 1: which pixels are furniture.

Two sources, unioned, because neither is sufficient alone:

- GEOMETRY. A measured object's box is fixed in room space and the camera pose is known, so
  its silhouette is exact, temporally stable and free. This is what keeps the strip of floor
  under a chair from being polluted by the chair.
- SAM. Geometry can only mask what RoomPlan boxed. Clutter it never categorised — a bag, a
  cable, a stack of books — is invisible to the geometric pass and is exactly what the PRD
  asks segmentation to catch.

SAM is optional at runtime. Without weights the geometric masks still produce a correct, if
less complete, result, and the reason is recorded rather than the absence being silent.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from geometry import as_matrix, camera_in_room

# RoomPlan under-estimates soft edges, and an object's contact shadow on the floor is the
# most visible tell once the object is gone. Both constants come from the prior art in
# docs/prd-diminished-reality.md rather than being guessed here.
INFLATE = 0.06
FLOOR_SKIRT = 0.10


@dataclass
class Masks:
    """One boolean mask per keyframe, True where the pixel is foreground."""

    per_frame: list[np.ndarray] = field(default_factory=list)
    geometric_pixels: int = 0
    model_pixels: int = 0
    model: str = "none"
    note: str = ""


def _box_corners(center: np.ndarray, size: np.ndarray, yaw: float) -> np.ndarray:
    """Eight corners of an upright box whose `center` is its BASE centre."""
    hx, hz = size[0] / 2 * (1 + INFLATE) + FLOOR_SKIRT, size[2] / 2 * (1 + INFLATE) + FLOOR_SKIRT
    top = size[1] * (1 + INFLATE)
    local = np.array(
        [
            [sx * hx, y, sz * hz]
            for sx in (-1, 1)
            for sz in (-1, 1)
            for y in (-FLOOR_SKIRT, top)
        ]
    )
    c, s = np.cos(yaw), np.sin(yaw)
    rotate = np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]])
    return (rotate @ local.T).T + center


def geometric_masks(room: dict, keyframes: list[dict], origin: np.ndarray) -> Masks:
    """Project every measured obstacle into every keyframe and fill its convex hull."""
    import cv2

    masks = Masks()
    for frame in keyframes:
        meta = frame["metadata"]
        width, height = int(meta["width"]), int(meta["height"])
        mask = np.zeros((height, width), dtype=np.uint8)
        c2r = camera_in_room(meta["cameraToWorld"], origin)
        intrinsics = as_matrix(meta["intrinsics"], 3)
        for obstacle in room["obstacles"]:
            corners = _box_corners(
                np.array(obstacle["center"], dtype=np.float64),
                np.array(obstacle["size"], dtype=np.float64),
                float(obstacle["yaw"]),
            )
            from geometry import project

            uv, _, valid = project(corners, c2r, intrinsics, width, height)
            # A box straddling the frame edge still occludes what is inside the frame, so
            # clamp rather than dropping it — but require at least one corner genuinely in
            # view, or a box behind the camera would paint the whole image.
            if not valid.any():
                continue
            points = np.clip(uv, [0, 0], [width - 1, height - 1]).astype(np.int32)
            hull = cv2.convexHull(points.reshape(-1, 1, 2))
            cv2.fillConvexPoly(mask, hull, 1)
        masks.per_frame.append(mask.astype(bool))
        masks.geometric_pixels += int(mask.sum())
    return masks


def refine_with_sam(masks: Masks, keyframes: list[dict], weights: str | None) -> Masks:
    """
    Tighten the geometric boxes and catch unboxed clutter.

    Deliberately additive: SAM's output is unioned with geometry rather than replacing it.
    A segmenter that misses the sofa must not be able to un-mask the sofa, which a
    replacement would.
    """
    if not weights:
        masks.note = "no SAM weights; geometric masks only"
        return masks
    try:
        import onnxruntime  # noqa: F401
    except ImportError:  # pragma: no cover - environment dependent
        masks.note = "onnxruntime unavailable; geometric masks only"
        return masks
    from sam import SamSegmenter

    segmenter = SamSegmenter(weights)
    masks.model = segmenter.name
    for index, frame in enumerate(keyframes):
        predicted = segmenter.masks(frame["jpegBase64"], masks.per_frame[index])
        masks.model_pixels += int(predicted.sum())
        masks.per_frame[index] = masks.per_frame[index] | predicted
    return masks


def segment(room: dict, keyframes: list[dict], origin: np.ndarray, weights: str | None) -> Masks:
    """
    An empty room skips this entirely.

    The PRD is explicit that an empty area is placed into directly, "without an unnecessary
    erase pass" — running a segmenter over a room with nothing to remove costs time and can
    only invent foreground.
    """
    # Unconditional on weights, and not an optimisation. SAM here is PROMPTED from the
    # geometric mask's connected components; with no obstacles there is no seed, so it
    # gets zero prompts and can contribute nothing however good it is. Running the encoder
    # anyway would cost a second per keyframe to produce an empty mask.
    #
    # The consequence is worth naming: clutter RoomPlan never boxed, in a room where it
    # boxed NOTHING, is not caught. Catching it needs unprompted "segment everything"
    # mode, which is a different and far more expensive operation than tightening a box.
    if not room["obstacles"]:
        empty = Masks(note="empty room; removal skipped")
        for frame in keyframes:
            meta = frame["metadata"]
            empty.per_frame.append(
                np.zeros((int(meta["height"]), int(meta["width"])), dtype=bool)
            )
        return empty
    return refine_with_sam(geometric_masks(room, keyframes, origin), keyframes, weights)
