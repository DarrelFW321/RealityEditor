"""
SAM-family segmentation, ONNX, CPU-capable.

Its job here is narrow and worth stating: geometry already masks everything RoomPlan boxed,
exactly and for free. SAM exists to catch what geometry cannot — clutter that was never
categorised — and to tighten a box that under-covers a soft edge. Its output is UNIONED
with the geometric mask in `segment.py`, never substituted for it, so a segmenter having a
bad day can add false positives but can never un-mask the sofa.

Weights are not checked in. `SAM_WEIGHTS` points at a directory holding `encoder.onnx` and
`decoder.onnx`; `fetch_models.py` explains where they come from. Without them the pipeline
runs on geometric masks and records that it did.
"""

from __future__ import annotations

import base64
from pathlib import Path

import numpy as np

# VERIFIED AGAINST THE ACTUAL MODEL, not assumed from the published SAM contract.
#
# The first implementation here normalised to NCHW and letterboxed to 1024x1024, because
# that is what stock SAM ONNX exports want. This encoder does not: it takes HWC float at
# whatever resolution it is given and does its own preprocessing. Feeding it the textbook
# tensor produced masks offset by a factor of 960/1024 — plausible-looking and wrong.
#
# The convention that measured correctly, to 3px at 1920x1440:
#   - encode the image resized so its LONG side is 1024, as HWC float32 RGB
#   - prompt with box corners in THAT scaled frame, labels 2 and 3
#   - pass orig_im_size = [1024, 1024]; the decoder returns a 1024x1024 mask in which the
#     object sits at its scaled-frame coordinates
#   - crop to the scaled image's own height and width, then resize to the true resolution
MODEL_FRAME = 1024
# The decoder's own confidence that the region is a coherent object.
SCORE_FLOOR = 0.80
# Each prompt is an encoder-free decoder pass, but they are not free. A frame with more
# than this many separate masked regions is noise, not furniture.
MAX_PROMPTS = 16
# Specks in the projected hull are not objects.
MIN_COMPONENT_PIXELS = 500


class SamSegmenter:
    def __init__(self, weights: str) -> None:
        import onnxruntime

        root = Path(weights)
        self.name = root.name or "sam"
        options = onnxruntime.SessionOptions()
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.encoder = onnxruntime.InferenceSession(
            str(root / "encoder.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.decoder = onnxruntime.InferenceSession(
            str(root / "decoder.onnx"), options, providers=["CPUExecutionProvider"]
        )

    def masks(self, jpeg_base64: str, seed: np.ndarray) -> np.ndarray:
        """
        Returns a boolean mask the size of the source image.

        `seed` is the geometric mask. Its connected components become box prompts, which
        turns SAM from "segment everything" into "tighten what we already believe is
        furniture", and bounds the decoder passes to the number of objects in view.
        """
        import cv2

        buffer = np.frombuffer(base64.b64decode(jpeg_base64), dtype=np.uint8)
        bgr = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if bgr is None:
            return np.zeros_like(seed, dtype=bool)
        image = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        height, width = image.shape[:2]

        scale = MODEL_FRAME / max(height, width)
        small = cv2.resize(
            image, (int(round(width * scale)), int(round(height * scale))), interpolation=cv2.INTER_AREA
        )
        rows, cols = small.shape[:2]
        embedding = self.encoder.run(None, {"input_image": small.astype(np.float32)})[0]

        count, _, stats, _ = cv2.connectedComponentsWithStats(seed.astype(np.uint8), connectivity=8)
        out = np.zeros((rows, cols), dtype=bool)
        prompts = 0
        for index in range(1, count):
            if prompts >= MAX_PROMPTS:
                break
            x, y, w, h, area = stats[index]
            if area < MIN_COMPONENT_PIXELS:
                continue
            prompts += 1
            box = np.array(
                [[[x * scale, y * scale], [(x + w) * scale, (y + h) * scale]]], dtype=np.float32
            )
            result = self.decoder.run(
                None,
                {
                    "image_embeddings": embedding,
                    "point_coords": box,
                    # 2 and 3 are SAM's box-corner labels, as distinct from 1/0 for a
                    # positive/negative click.
                    "point_labels": np.array([[2.0, 3.0]], dtype=np.float32),
                    "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
                    "has_mask_input": np.zeros(1, dtype=np.float32),
                    "orig_im_size": np.array([MODEL_FRAME, MODEL_FRAME], dtype=np.float32),
                },
            )
            masks, scores = result[0], result[1]
            if float(scores.reshape(-1)[0]) < SCORE_FLOOR:
                continue
            full = masks.reshape(-1, masks.shape[-2], masks.shape[-1])[0]
            out |= full[:rows, :cols] > 0

        if not out.any():
            return np.zeros((height, width), dtype=bool)
        return cv2.resize(
            out.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST
        ).astype(bool)
