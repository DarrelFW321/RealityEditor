"""
segmentation -> visible-background projection -> hole completion -> clean-shell manifest.

Every stage writes its own artifact when `dump` is set, because the plan requires masks,
projected backgrounds and completed surfaces to be inspectable separately: a bad result has
to be traceable to the stage that caused it, not just observed at the end.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from appearance import enabled as appearance_enabled, provider_from_env, refine
from complete import complete
from project import coverage, project_surfaces
from segment import segment
from shell import encode_json, encode_png, pack, shell_document


@dataclass
class Result:
    manifest: dict
    assets: list[dict]
    stages: dict


def reconstruct(request: dict, dump: Path | None = None) -> Result:
    room = request["room"]
    keyframes = request["keyframes"]
    origin = np.array(room["origin"], dtype=np.float64)
    sam_weights = os.environ.get("SAM_WEIGHTS") or None
    lama_weights = os.environ.get("LAMA_WEIGHTS") or None

    masks = segment(room, keyframes, origin, sam_weights)
    atlases = project_surfaces(room, keyframes, masks.per_frame, origin)
    filled, method, inpainting = complete(atlases, lama_weights)

    # M8.5: an OPTIONAL fourth stage. Off unless APPEARANCE_PROVIDER names one, and it
    # can only repaint texels `complete` already marked as never observed. The baseline
    # result above stays the fallback and is returned unchanged on any failure, so this
    # cannot make the worker worse than it is without it.
    appearance = None
    if appearance_enabled():
        provider = provider_from_env()
        filled, appearance = refine(room, atlases, filled, provider, seed=int(os.environ.get("APPEARANCE_SEED", "0")))
        if appearance.applied:
            method = f"{method}+{appearance.provider}"

    image, placed = pack(atlases, filled)
    document = shell_document(atlases, placed, (image.shape[1], image.shape[0]), method)

    assets = [
        {
            "key": "atlas.png",
            "mime": "image/png",
            "dataBase64": base64.b64encode(encode_png(image)).decode("ascii"),
        },
        {
            "key": "shell.json",
            "mime": "application/json",
            "dataBase64": base64.b64encode(encode_json(document)).decode("ascii"),
        },
    ]
    artifacts = [
        {"key": "atlas.png", "role": "atlas", "inferred": True},
        # The shell's GEOMETRY is measured — it is the calibrated room. Only its appearance
        # is invented, and each surface carries its own flag inside the document.
        {"key": "shell.json", "role": "shell", "inferred": any(s["inferred"] for s in document["surfaces"])},
    ]

    if dump:
        _dump(dump, masks, atlases, filled, image, document)

    return Result(
        manifest={
            "calibrationId": request["calibrationId"],
            "calibrationRevision": request["calibrationRevision"],
            "frameId": request["frameId"],
            "artifacts": artifacts,
            # What the DESIGN may now treat as removable. Physical presence is the
            # client's separate obstacle layer and is unaffected by anything here.
            "removedObjectIds": [o["id"] for o in room["obstacles"]],
        },
        assets=assets,
        stages={
            "masks": masks.model,
            "maskNote": masks.note,
            "geometricPixels": masks.geometric_pixels,
            "modelPixels": masks.model_pixels,
            "completion": method,
            "coverage": coverage(atlases),
            # Present only when the masked filler ran, so its absence is unambiguous.
            **(
                {
                    "inpainting": {
                        "provider": inpainting.provider,
                        "model": inpainting.model,
                        "applied": inpainting.applied,
                        "reason": inpainting.reason,
                        "holes": inpainting.holes,
                        "filled": inpainting.filled,
                        "tilesRequested": inpainting.tiles_requested,
                        "tilesApplied": inpainting.tiles_applied,
                        "observedPreserved": inpainting.observed_preserved,
                        "billedCalls": inpainting.billed_calls,
                        "notes": inpainting.notes,
                    }
                }
                if inpainting is not None
                else {}
            ),
            # Present only when the optional stage ran, so its absence is unambiguous
            # rather than a row of zeroes that could mean "off" or "filled nothing".
            **(
                {
                    "appearance": {
                        "provider": appearance.provider,
                        "model": appearance.model,
                        "seed": appearance.seed,
                        "applied": appearance.applied,
                        "reason": appearance.reason,
                        "holes": appearance.holes,
                        "filled": appearance.filled,
                        "leftOnBaseline": appearance.left_on_baseline,
                        "coverage": appearance.coverage,
                        "observedPreserved": appearance.observed_preserved,
                        "perSurface": appearance.per_surface,
                        "billedCredits": appearance.billed_credits,
                    }
                }
                if appearance is not None
                else {}
            ),
        },
    )


def _dump(root: Path, masks, atlases, filled, image, document) -> None:
    import cv2

    root.mkdir(parents=True, exist_ok=True)
    for index, mask in enumerate(masks.per_frame):
        cv2.imwrite(str(root / f"mask-{index}.png"), mask.astype(np.uint8) * 255)
    for atlas, rgb in zip(atlases, filled):
        name = atlas.id.replace("/", "_")
        # Observed only, holes black: shows what the cameras actually saw.
        observed = np.clip(atlas.rgb, 0, 255).astype(np.uint8) * (atlas.weight > 0)[..., None]
        cv2.imwrite(str(root / f"projected-{name}.png"), cv2.cvtColor(observed, cv2.COLOR_RGB2BGR))
        cv2.imwrite(str(root / f"holes-{name}.png"), atlas.holes.astype(np.uint8) * 255)
        cv2.imwrite(str(root / f"completed-{name}.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(root / "atlas.png"), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    (root / "shell.json").write_bytes(encode_json(document))
