"""
Stage 2: accumulate the visible background into per-surface atlases.

This is the step that makes the result world-consistent. The PRD is explicit that
independent per-frame inpainting "would introduce flicker and changing geometry" — one
shared world-space texture, sampled by every viewpoint, is what prevents that, and it is
also what M8 will composite from later.

Resolution is 256 px/m, from the prior art: a 4m wall is 1024px, which is enough to read as
a surface and small enough that six of them fit in one atlas.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from geometry import as_matrix, camera_in_room, grazing_weight, project, surface_basis, texel_points

PIXELS_PER_METRE = 256
#

@dataclass
class SurfaceAtlas:
    id: str
    cls: str
    corner: np.ndarray
    u_axis: np.ndarray
    v_axis: np.ndarray
    cols: int
    rows: int
    rgb: np.ndarray       # (rows, cols, 3) float32, weighted mean colour
    weight: np.ndarray    # (rows, cols) float32, 0 means never observed
    inferred: bool        # the surface itself was inferred by calibration

    @property
    def holes(self) -> np.ndarray:
        return self.weight <= 0.0


def _decode(jpeg_base64: str) -> np.ndarray:
    import base64

    import cv2

    buffer = np.frombuffer(base64.b64decode(jpeg_base64), dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("undecodable_keyframe")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def project_surfaces(
    room: dict,
    keyframes: list[dict],
    masks: list[np.ndarray],
    origin: np.ndarray,
    pixels_per_metre: int = PIXELS_PER_METRE,
) -> list[SurfaceAtlas]:
    metres_per_texel = 1.0 / pixels_per_metre
    images = [_decode(frame["jpegBase64"]) for frame in keyframes]
    atlases: list[SurfaceAtlas] = []

    for surface in room["surfaces"]:
        polygon = np.array(surface["polygon"], dtype=np.float64)
        normal = np.array(surface["normal"], dtype=np.float64)
        corner, u_axis, v_axis, (width_m, height_m) = surface_basis(polygon, normal)
        cols = max(1, int(round(width_m * pixels_per_metre)))
        rows = max(1, int(round(height_m * pixels_per_metre)))
        points = texel_points(corner, u_axis, v_axis, cols, rows, metres_per_texel)

        accumulated = np.zeros((rows * cols, 3), dtype=np.float64)
        total_weight = np.zeros(rows * cols, dtype=np.float64)

        for image, frame, mask in zip(images, keyframes, masks):
            meta = frame["metadata"]
            height, width = image.shape[:2]
            c2r = camera_in_room(meta["cameraToWorld"], origin)
            intrinsics = as_matrix(meta["intrinsics"], 3)
            uv, _, valid = project(points, c2r, intrinsics, width, height)
            if not valid.any():
                continue

            eye = c2r[:3, 3]
            weight = grazing_weight(points, eye, normal)
            # Below this the sample is nearly edge-on: a handful of blurred pixels
            # stretched across metres of surface, which drags the mean without adding
            # information.
            valid &= weight > 0.15

            # Foreground rejection. The mask is the union of measured geometry and the
            # segmenter, so a texel behind furniture is simply never sampled here — it
            # becomes a hole for the completion stage rather than a smear of sofa.
            pixel = np.zeros(len(points), dtype=np.int64)
            columns = np.clip(uv[:, 0].astype(np.int64), 0, width - 1)
            lines = np.clip(uv[:, 1].astype(np.int64), 0, height - 1)
            pixel = lines * width + columns
            occluded = mask.reshape(-1)[pixel]
            valid &= ~occluded

            if not valid.any():
                continue
            sampled = image.reshape(-1, 3)[pixel[valid]].astype(np.float64)
            w = weight[valid][:, None]
            accumulated[valid] += sampled * w
            total_weight[valid] += weight[valid]

        safe = np.where(total_weight > 0, total_weight, 1.0)[:, None]
        rgb = (accumulated / safe).reshape(rows, cols, 3).astype(np.float32)
        atlases.append(
            SurfaceAtlas(
                id=surface["id"],
                cls=surface["class"],
                corner=corner,
                u_axis=u_axis,
                v_axis=v_axis,
                cols=cols,
                rows=rows,
                rgb=rgb,
                weight=total_weight.reshape(rows, cols).astype(np.float32),
                # A surface calibration already called inferred can never be observed,
                # whatever the projection finds.
                inferred=bool(surface.get("inferred", False)),
            )
        )
    return atlases


def coverage(atlases: list[SurfaceAtlas]) -> dict[str, float]:
    """Observed fraction per surface. The honest measure of how much is real."""
    return {
        atlas.id: float((atlas.weight > 0).sum()) / float(max(1, atlas.weight.size))
        for atlas in atlases
    }
