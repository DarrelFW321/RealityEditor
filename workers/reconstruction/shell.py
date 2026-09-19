"""
Stage 4: pack the surface atlases into one image and describe how to draw it.

`shell.json` is a SELF-CONTAINED mesh: positions, UVs and a per-surface inferred flag. It
deliberately does not extend the RSG `Surface` type — that schema is frozen with
`additionalProperties: false` and has nowhere to hang a UV — so the shell travels beside
the scene rather than inside it.

Room space throughout, matching `EditorState.design`, so the client can draw it without
knowing anything about the world frame the keyframes were captured in.
"""

from __future__ import annotations

import json

import numpy as np

from project import SurfaceAtlas

# One row of surfaces per shelf. Simple, and with six surfaces there is nothing to gain
# from a better packer.
MAX_ATLAS_EDGE = 4096


def pack(atlases: list[SurfaceAtlas], filled: list[np.ndarray]) -> tuple[np.ndarray, list[dict]]:
    """Shelf-packs every surface into one RGB image and returns its UV rectangles."""
    scale = 1.0
    total_width = max((a.cols for a in atlases), default=1)
    # Shrink uniformly if a single surface is wider than the atlas can be.
    if total_width > MAX_ATLAS_EDGE:
        scale = MAX_ATLAS_EDGE / total_width

    placed: list[dict] = []
    x = y = shelf_height = 0
    width = height = 0
    boxes = []
    for atlas in atlases:
        cols = max(1, int(atlas.cols * scale))
        rows = max(1, int(atlas.rows * scale))
        if x + cols > MAX_ATLAS_EDGE and x > 0:
            x, y = 0, y + shelf_height
            shelf_height = 0
        boxes.append((x, y, cols, rows))
        x += cols
        shelf_height = max(shelf_height, rows)
        width = max(width, x)
        height = max(height, y + rows)

    image = np.zeros((max(1, height), max(1, width), 3), dtype=np.uint8)
    import cv2

    for atlas, rgb, (bx, by, cols, rows) in zip(atlases, filled, boxes):
        resized = cv2.resize(rgb, (cols, rows), interpolation=cv2.INTER_AREA) if (
            cols != atlas.cols or rows != atlas.rows
        ) else rgb
        image[by : by + rows, bx : bx + cols] = resized
        observed = float((atlas.weight > 0).sum()) / float(max(1, atlas.weight.size))
        placed.append(
            {
                "id": atlas.id,
                "class": atlas.cls,
                "rect": [bx, by, cols, rows],
                "observedFraction": round(observed, 4),
                # Inferred when calibration already said so, or when most of the surface
                # is invented rather than observed. Half is the line: below it the texture
                # is mostly a guess and must not be presented as a photograph of the room.
                "inferred": bool(atlas.inferred or observed < 0.5),
            }
        )
    return image, placed


def shell_document(
    atlases: list[SurfaceAtlas], placed: list[dict], atlas_size: tuple[int, int], method: str
) -> dict:
    """The mesh, with UVs into the packed atlas. Two triangles per planar surface."""
    width, height = atlas_size
    surfaces = []
    for atlas, entry in zip(atlases, placed):
        bx, by, cols, rows = entry["rect"]
        # Corners in room space, in the surface's own basis order, so UVs and positions
        # correspond without the client needing the basis.
        w_m = atlas.cols / 256.0
        h_m = atlas.rows / 256.0
        corners = [
            atlas.corner,
            atlas.corner + atlas.u_axis * w_m,
            atlas.corner + atlas.u_axis * w_m + atlas.v_axis * h_m,
            atlas.corner + atlas.v_axis * h_m,
        ]
        # v is flipped because image rows run downward while the surface basis runs up.
        uvs = [
            [bx / width, (by + rows) / height],
            [(bx + cols) / width, (by + rows) / height],
            [(bx + cols) / width, by / height],
            [bx / width, by / height],
        ]
        surfaces.append(
            {
                "id": entry["id"],
                "class": entry["class"],
                "positions": [[round(float(c), 5) for c in corner] for corner in corners],
                "uvs": [[round(u, 6), round(v, 6)] for u, v in uvs],
                "indices": [0, 1, 2, 0, 2, 3],
                "observedFraction": entry["observedFraction"],
                "inferred": entry["inferred"],
            }
        )
    return {
        "space": "room",
        "atlas": {"key": "atlas.png", "width": width, "height": height},
        "completion": method,
        "surfaces": surfaces,
    }


def encode_png(image: np.ndarray) -> bytes:
    import cv2

    ok, buffer = cv2.imencode(".png", cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    if not ok:
        raise ValueError("png_encode_failed")
    return buffer.tobytes()


def encode_json(document: dict) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode("utf-8")
