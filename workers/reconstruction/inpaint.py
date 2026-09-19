"""
Masked hole filling for surface atlases.

The one slot in the pipeline where appearance is invented, done by a model that can SEE
the real wall around the hole. That is the whole reason this sits at the `complete()`
boundary rather than being a world model: a masked edit is conditioned on the actual
observed pixels surrounding the gap, so it continues the user's wall instead of
imagining a plausible one.

Three rules, enforced here rather than trusted:

1. HOLE-ONLY. Whatever comes back, only texels the projector marked unobserved are
   taken from it. Observed texels are copied from the baseline and then CHECKED.
2. TILED, NOT RESIZED. The atlas is cropped to windows the model accepts and pasted
   back at full resolution. Rescaling a 4m wall to 1024px and back would soften every
   real pixel on it to fill a gap in one corner.
3. BOUNDED. A tile cap and a spend ledger, because each call costs money and an atlas
   with scattered holes could otherwise fan out into dozens of requests.

Off unless configured. `complete()` keeps jump-flood as the fallback on every failure
path, so this can only ever improve the result or leave it exactly as it was.
"""

from __future__ import annotations

import base64
import io
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

# The edit endpoint accepts a fixed set of sizes; 1024 square is the one that tiles a
# wall atlas sensibly. Windows are cropped to this, never scaled to it.
TILE = 1024
# Per-atlas and per-request caps. A surface needing more tiles than this is left on the
# deterministic fill rather than being expensive and slow.
MAX_TILES_PER_SURFACE = int(os.environ.get("INPAINT_MAX_TILES_PER_SURFACE", "2"))
MAX_TILES_TOTAL = int(os.environ.get("INPAINT_MAX_TILES", "6"))
# A hole smaller than this is not worth a network round trip; jump-flood is fine.
MIN_HOLE_TEXELS = int(os.environ.get("INPAINT_MIN_HOLE_TEXELS", "2000"))

PROMPT = (
    "Continue the existing wall or floor surface seamlessly across the masked region. "
    "Match the surrounding colour, texture, grain and lighting exactly. "
    "Do not add furniture, objects, shadows, text, patterns or features of any kind."
)


@dataclass
class InpaintReport:
    provider: str = "none"
    model: str = ""
    applied: bool = False
    reason: str = "not requested"
    tiles_requested: int = 0
    tiles_applied: int = 0
    holes: int = 0
    filled: int = 0
    observed_preserved: bool = True
    billed_calls: int = 0
    notes: list[str] = field(default_factory=list)


class HoleFiller(Protocol):
    """Fills the masked region of one RGB tile. Returns None to fall back."""

    id: str
    model: str

    def fill(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray | None: ...


# ---------------------------------------------------------------- tiling


def hole_windows(holes: np.ndarray, limit: int) -> list[tuple[int, int, int, int]]:
    """
    Windows covering the holes, as `(y0, x0, y1, x1)` at most TILE on a side.

    Driven by the hole bounding box and clamped inside the atlas, so a window always
    carries real surrounding pixels for the model to match against. Deterministic:
    the same mask yields the same windows, which is what lets two runs be compared.
    """
    rows, cols = holes.shape
    ys, xs = np.nonzero(holes)
    if ys.size == 0:
        return []
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1

    def spans(lo: int, hi: int, extent: int) -> list[tuple[int, int]]:
        out: list[tuple[int, int]] = []
        start = lo
        while start < hi:
            # Centre the window on the remaining run, then clamp so it stays inside.
            begin = max(0, min(start - (TILE - min(TILE, hi - start)) // 2, extent - TILE))
            begin = max(0, begin)
            end = min(extent, begin + TILE)
            out.append((begin, end))
            start = end
            if len(out) > limit:
                break
        return out

    windows: list[tuple[int, int, int, int]] = []
    for ry0, ry1 in spans(y0, y1, rows):
        for rx0, rx1 in spans(x0, x1, cols):
            if holes[ry0:ry1, rx0:rx1].any():
                windows.append((ry0, rx0, ry1, rx1))
    # Biggest hole coverage first, so a tile budget spends itself where it matters.
    windows.sort(key=lambda w: (-int(holes[w[0] : w[2], w[1] : w[3]].sum()), w[0], w[1]))
    return windows[:limit]


def apply_fill(
    baseline: np.ndarray,
    candidate: np.ndarray,
    holes: np.ndarray,
    window: tuple[int, int, int, int],
) -> tuple[np.ndarray, int]:
    """
    Pastes a candidate tile back, hole texels only. Returns `(result, filled)`.

    `baseline` is never mutated. The window's observed texels are not copied from the
    candidate at all, so a model that repainted them cannot affect the output — the
    separate equality check in `run` is there to notice that it tried.
    """
    y0, x0, y1, x1 = window
    result = baseline.copy()
    region = holes[y0:y1, x0:x1]
    if not region.any():
        return result, 0
    patch = result[y0:y1, x0:x1]
    patch[region] = candidate[: y1 - y0, : x1 - x0][region]
    result[y0:y1, x0:x1] = patch
    return result, int(region.sum())


def run(
    atlases: list,
    baseline: list[np.ndarray],
    filler: HoleFiller | None,
) -> tuple[list[np.ndarray], InpaintReport]:
    """Fills what it can, leaves the rest on the deterministic baseline."""
    report = InpaintReport()
    report.holes = int(sum(int(a.holes.sum()) for a in atlases))
    if filler is None:
        report.reason = "no filler configured"
        return baseline, report
    if report.holes == 0:
        report.reason = "nothing to fill; every texel was observed"
        return baseline, report

    report.provider = filler.id
    report.model = filler.model
    out: list[np.ndarray] = []
    budget = MAX_TILES_TOTAL
    preserved = True

    for atlas, base in zip(atlases, baseline):
        holes = atlas.holes
        current = base
        if not holes.any() or int(holes.sum()) < MIN_HOLE_TEXELS or budget <= 0:
            if holes.any() and int(holes.sum()) < MIN_HOLE_TEXELS:
                report.notes.append(f"{atlas.id}: hole too small to be worth a call")
            out.append(current)
            continue
        for window in hole_windows(holes, min(MAX_TILES_PER_SURFACE, budget)):
            y0, x0, y1, x1 = window
            tile = np.ascontiguousarray(current[y0:y1, x0:x1])
            mask = np.ascontiguousarray(holes[y0:y1, x0:x1])
            report.tiles_requested += 1
            budget -= 1
            try:
                candidate = filler.fill(tile, mask)
            except Exception as error:  # pragma: no cover - network dependent
                report.notes.append(f"{atlas.id}: {type(error).__name__}")
                candidate = None
            if candidate is None or candidate.shape[:2] != tile.shape[:2]:
                if candidate is not None:
                    report.notes.append(f"{atlas.id}: wrong tile size {candidate.shape}")
                continue
            observed = ~mask
            if observed.any() and not np.array_equal(
                np.clip(candidate, 0, 255).astype(np.uint8)[observed],
                np.clip(tile, 0, 255).astype(np.uint8)[observed],
            ):
                # Not fatal: the paste is hole-only regardless. Recorded because a model
                # that edits outside its mask is a model whose fill is drifting too.
                preserved = False
                report.notes.append(f"{atlas.id}: candidate altered observed texels")
            current, filled = apply_fill(current, candidate, holes, window)
            report.filled += filled
            report.tiles_applied += 1
        out.append(current)

    report.observed_preserved = preserved
    report.billed_calls = report.tiles_requested
    report.applied = report.tiles_applied > 0
    report.reason = (
        "filled hole texels only" if report.applied else "no tile could be filled"
    )
    if not report.applied:
        return baseline, report
    return out, report


# ---------------------------------------------------------------- providers


class SyntheticInpainter:
    """
    Fills the mask with a colour taken from the observed pixels around it.

    Costs nothing and has a knowable answer, which is what makes the tiling, the
    hole-only paste and the preservation check testable offline. Not a quality baseline:
    it is a flat mean, and jump-flood already beats it.
    """

    id = "synthetic-inpainter"
    model = "mean-of-observed"

    def fill(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
        observed = ~mask
        if not observed.any():
            return None
        out = np.array(rgb, dtype=np.uint8, copy=True)
        out[mask] = np.clip(rgb[observed].mean(axis=0), 0, 255).astype(np.uint8)
        return out


class OpenAIInpainter:
    """
    `POST /v1/images/edits`. The masked region is regenerated; the rest is preserved.

    Chosen over a world model for one reason: it is conditioned on the surrounding real
    pixels of THIS wall. A generative world model has never seen the wall and can only
    produce a plausible one.
    """

    id = "openai-image-edit"

    def __init__(self) -> None:
        self.key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not self.key or self.key.endswith("..."):
            raise RuntimeError("OPENAI_API_KEY is not set (or is still the placeholder)")
        self.model = os.environ.get("INPAINT_MODEL", "").strip()
        if not self.model:
            raise RuntimeError(
                "INPAINT_MODEL must be set explicitly (e.g. gpt-image-2.5-flare). "
                "Image model ids move, and an omitted one is an unrecorded experiment."
            )
        ceiling = os.environ.get("INPAINT_MAX_CALLS", "").strip()
        if not ceiling.isdigit() or int(ceiling) <= 0:
            raise RuntimeError(
                "INPAINT_MAX_CALLS must be set to a positive number of requests. "
                "There is no default: a spending bound is a decision, not a fallback."
            )
        self.remaining = int(ceiling)

    def fill(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
        import cv2

        if self.remaining <= 0:
            return None
        ok_image, image_png = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if not ok_image:
            return None
        # The documented mask: WHITE is regenerated, black is kept, and it must carry an
        # alpha channel. Encoded explicitly rather than by convention, because inverting
        # this silently repaints the wall and keeps the hole.
        rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
        rgba[..., :3] = np.where(mask[..., None], 255, 0)
        rgba[..., 3] = 255
        ok_mask, mask_png = cv2.imencode(".png", rgba)
        if not ok_mask:
            return None

        self.remaining -= 1
        body, content_type = _multipart(
            {"model": self.model, "prompt": PROMPT, "n": "1", "size": "auto"},
            {
                "image": ("atlas.png", image_png.tobytes(), "image/png"),
                "mask": ("mask.png", mask_png.tobytes(), "image/png"),
            },
        )
        request = urllib.request.Request(
            "https://api.openai.com/v1/images/edits", data=body, method="POST"
        )
        request.add_header("Authorization", f"Bearer {self.key}")
        request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError:
            return None
        entry = (payload.get("data") or [{}])[0]
        encoded = entry.get("b64_json")
        if not encoded:
            return None
        decoded = cv2.imdecode(
            np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR
        )
        if decoded is None:
            return None
        returned = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
        if returned.shape[:2] != rgb.shape[:2]:
            # Resizing back would blur the real pixels this tile exists to match.
            return None
        return returned


def _multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]):
    """Minimal multipart/form-data. No dependency for one endpoint's body format."""
    boundary = "----realityeditor" + base64.urlsafe_b64encode(os.urandom(12)).decode()
    buffer = io.BytesIO()
    for name, value in fields.items():
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        buffer.write(f"{value}\r\n".encode())
    for name, (filename, data, mime) in files.items():
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        buffer.write(f"Content-Type: {mime}\r\n\r\n".encode())
        buffer.write(data)
        buffer.write(b"\r\n")
    buffer.write(f"--{boundary}--\r\n".encode())
    return buffer.getvalue(), f"multipart/form-data; boundary={boundary}"


def filler_from_env() -> HoleFiller | None:
    """Opt-in. Absent or `none` leaves the pipeline exactly as it was."""
    name = os.environ.get("INPAINT_PROVIDER", "").strip().lower()
    if name in ("", "none", "off"):
        return None
    if name == "synthetic":
        return SyntheticInpainter()
    if name == "openai":
        return OpenAIInpainter()
    raise RuntimeError(f"unknown INPAINT_PROVIDER {name!r}")
