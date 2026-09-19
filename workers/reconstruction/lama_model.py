"""
LaMa inpainting for atlas holes.

The PRD names LaMa as the first implementation baseline and asks for it to be compared
against, not assumed better than, the deterministic fill. So this is one of two
implementations behind `complete()`, selected when `LAMA_WEIGHTS` is set, and the
jump-flood fill stays the fallback and the comparison point.

Runs on the ATLAS, not on camera frames. That is the whole reason the projection stage
exists first: inpainting each frame independently would give a different invention per
viewpoint, which is what the PRD means by flicker and changing geometry.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

# The model's input is fixed at 512x512 (confirmed from its ONNX signature). Tiling keeps
# a 1024x1024 wall atlas from being downsampled to mush before it is filled.
TILE = 512
OVERLAP = 64


class LamaInpainter:
    def __init__(self, weights: str) -> None:
        import onnxruntime

        path = Path(weights)
        if path.is_dir():
            path = path / "lama.onnx"
        options = onnxruntime.SessionOptions()
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = onnxruntime.InferenceSession(
            str(path), options, providers=["CPUExecutionProvider"]
        )
        self.input_names = [i.name for i in self.session.get_inputs()]

    def _fill_tile(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        # Measured against the model, not assumed: input is 0..1, and the OUTPUT COMES
        # BACK IN 0..255 ALREADY. Scaling it by 255 again — the symmetric-looking thing to
        # do, and what the first version did — saturates every filled texel to white.
        image = rgb.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        holes = mask.astype(np.float32)[None, None]
        out = self.session.run(None, {"image": image, "mask": holes})[0]
        return np.clip(out[0].transpose(1, 2, 0), 0, 255).astype(np.uint8)

    def fill(self, rgb: np.ndarray, holes: np.ndarray) -> np.ndarray:
        import cv2

        if not holes.any():
            return rgb
        result = rgb.copy()
        height, width = rgb.shape[:2]
        step = TILE - OVERLAP
        for top in range(0, max(1, height - OVERLAP), step):
            for left in range(0, max(1, width - OVERLAP), step):
                bottom, right = min(top + TILE, height), min(left + TILE, width)
                sub_mask = holes[top:bottom, left:right]
                if not sub_mask.any():
                    continue
                sub = result[top:bottom, left:right]
                # The network wants a fixed square; pad rather than distort, so the fill
                # is not stretched relative to the texture it is continuing.
                padded_rgb = np.zeros((TILE, TILE, 3), dtype=np.uint8)
                padded_mask = np.zeros((TILE, TILE), dtype=np.uint8)
                padded_rgb[: sub.shape[0], : sub.shape[1]] = sub
                padded_mask[: sub_mask.shape[0], : sub_mask.shape[1]] = sub_mask
                filled = self._fill_tile(padded_rgb, padded_mask)[: sub.shape[0], : sub.shape[1]]
                # Only the holes are replaced. Observed texels are measurements and
                # must survive the model untouched.
                keep = sub_mask[..., None]
                result[top:bottom, left:right] = np.where(keep, filled, sub)
        return result
