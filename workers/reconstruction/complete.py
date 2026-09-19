"""
Stage 3: fill the texels no camera ever saw.

Two implementations behind one call, which is what the plan means by a replaceable stage:

- JUMP FLOOD. Nearest observed texel, then a short blur. Deterministic, instant, no
  weights. For a plain wall or carpet it is genuinely enough, and it is the baseline the
  PRD asks LaMa to be compared against rather than assumed better than.
- LAMA. The learned fill the PRD names as the first implementation baseline.

Whichever runs, the filled region is recorded as inferred. This is the one place in the
system that invents appearance, so it is the one place that most needs to say so.
"""

from __future__ import annotations

import numpy as np

from project import SurfaceAtlas


def jump_flood(atlas: SurfaceAtlas) -> np.ndarray:
    """Nearest-observed-texel fill. `cv2.inpaint` with TELEA is the same idea, tuned."""
    import cv2

    holes = atlas.holes
    if not holes.any():
        return np.clip(atlas.rgb, 0, 255).astype(np.uint8)
    if holes.all():
        # Nothing was ever observed on this surface. A mid grey is honest; anything else
        # would be inventing a colour and calling it a room.
        return np.full((atlas.rows, atlas.cols, 3), 128, dtype=np.uint8)
    filled = cv2.inpaint(
        np.clip(atlas.rgb, 0, 255).astype(np.uint8),
        holes.astype(np.uint8),
        inpaintRadius=8,
        flags=cv2.INPAINT_TELEA,
    )
    return filled


def lama(atlas: SurfaceAtlas, weights: str) -> np.ndarray | None:
    """Learned fill. Returns None when the model cannot run, so the caller falls back."""
    try:
        from lama_model import LamaInpainter
    except ImportError:
        return None
    try:
        return LamaInpainter(weights).fill(
            np.clip(atlas.rgb, 0, 255).astype(np.uint8), atlas.holes
        )
    except Exception:  # pragma: no cover - model/runtime dependent
        return None


def complete(atlases: list[SurfaceAtlas], weights: str | None) -> tuple[list[np.ndarray], str]:
    """Returns (filled RGB per surface, which implementation ran)."""
    method = "jump-flood"
    filled: list[np.ndarray] = []
    for atlas in atlases:
        result = lama(atlas, weights) if weights else None
        if result is not None:
            method = "lama"
        filled.append(result if result is not None else jump_flood(atlas))
    return filled, method
