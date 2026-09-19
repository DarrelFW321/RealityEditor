"""
A provider that costs nothing and knows the right answer.

The milestone requires the projection to be proven on "a synthetic room with known
distances and distinct axis markers before paying for a generation". That is only
possible with a stand-in that produces a panorama whose content is a known function of
direction — then a texel that lands in the wrong place is visible as the wrong colour
rather than as a plausible wall.

Two modes:

- `axis` (default) paints each direction with a colour derived from that direction, so
  reprojection error shows up as a hue discontinuity at a surface boundary and the
  self-test can assert an exact expected colour per texel.
- `flat` paints one colour, which is what an "is anything applied at all" plumbing check
  wants without any pattern to distract from it.

This is not a quality baseline and must never be scored as one. It exists so that the
geometry is already right by the time a real generation is paid for.
"""

from __future__ import annotations

import os

import numpy as np

from appearance import AppearanceCandidate, AppearanceRequest
from panorama import direction_of


class SyntheticProvider:
    id = "synthetic-appearance-v1"

    def __init__(self, mode: str | None = None) -> None:
        self.mode = (mode or os.environ.get("APPEARANCE_SYNTHETIC_MODE", "axis")).strip().lower()

    def generate(self, request: AppearanceRequest) -> AppearanceCandidate | None:
        height, width = request.depth.depth.shape
        if self.mode == "flat":
            image = np.zeros((height, width, 3), dtype=np.uint8)
            image[:] = (40, 90, 160)
        else:
            image = axis_panorama(width, height)
        return AppearanceCandidate(
            panorama=image,
            provider=self.id,
            model=f"synthetic/{self.mode}",
            seed=request.seed,
            operation_id=None,
            billed_credits=0,
        )


def axis_panorama(width: int, height: int) -> np.ndarray:
    """
    Direction encoded as colour: R from +X, G from +Y, B from -Z, each mapped 0..255.

    Invertible, so `expected_colour` below gives the exact value any texel must receive.
    That turns "does the reprojection land in the right place" into an equality check
    rather than a judgement about whether an image looks about right.
    """
    ys, xs = np.mgrid[0:height, 0:width]
    directions = direction_of(xs.astype(np.float64), ys.astype(np.float64), width, height)
    return _encode(directions)


def expected_colour(direction: np.ndarray) -> np.ndarray:
    """What `axis_panorama` holds for a given direction. Same mapping, no sampling."""
    d = np.asarray(direction, dtype=np.float64)
    norm = np.linalg.norm(d, axis=-1, keepdims=True)
    return _encode(d / np.maximum(norm, 1e-12))


def _encode(unit: np.ndarray) -> np.ndarray:
    return np.clip(
        np.stack(
            [
                (unit[..., 0] * 0.5 + 0.5) * 255.0,
                (unit[..., 1] * 0.5 + 0.5) * 255.0,
                (-unit[..., 2] * 0.5 + 0.5) * 255.0,
            ],
            axis=-1,
        ),
        0,
        255,
    ).astype(np.uint8)
