"""
M8.5-C: the isolated appearance adapter.

One replaceable boundary between "the baseline worker completed the holes" and "a world
model proposed appearance for them". Opt-in, off by default, and incapable of changing
anything the baseline already decided.

Three rules the milestone states and this file enforces mechanically rather than by
convention, because every one of them is a way the experiment could quietly cheat:

1. HOLE-ONLY. Candidate colour is applied where `weight <= 0` and nowhere else.
   Observed texels are copied through untouched and then CHECKED to be identical, so a
   provider cannot repaint the room and score well on a comparison against itself.
2. NO GEOMETRY. The adapter receives atlases and returns pixels. It cannot add a vertex,
   a collider, an object or an opening, because it is never given anywhere to put one.
3. PROVENANCE SURVIVES. Every texel it fills is recorded inferred, and which provider
   filled it is recorded beside the result. Generated appearance that cannot be told
   apart from measurement is the failure mode this whole milestone exists to avoid.

A provider that fails, times out, returns the wrong size, or cannot register is not an
error here — it is a texel left on baseline completion. The baseline must stay usable
throughout, so this layer degrades rather than raises.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

import panorama
from panorama import DepthPanorama, render_depth, reproject_onto_atlas


@dataclass
class AppearanceRequest:
    """Everything a provider may see. Deliberately no keyframes and no room payload."""

    depth: DepthPanorama
    prompt: str
    seed: int


@dataclass
class AppearanceCandidate:
    """An equirectangular RGB panorama from the same origin as the depth it answers."""

    panorama: np.ndarray          # (H, W, 3) uint8/float
    provider: str
    model: str
    seed: int
    operation_id: str | None = None
    billed_credits: int = 0


class AppearanceProvider(Protocol):
    """The whole external surface. Synchronous by design: the caller owns the deadline."""

    id: str

    def generate(self, request: AppearanceRequest) -> AppearanceCandidate | None: ...


@dataclass
class AppearanceReport:
    """What happened, in enough detail to put a row in the run ledger."""

    provider: str = "none"
    model: str = ""
    seed: int = 0
    applied: bool = False
    reason: str = "not requested"
    # Per-surface texel accounting. The comparison is meaningless without it.
    holes: int = 0
    filled: int = 0
    left_on_baseline: int = 0
    observed_preserved: bool = True
    operation_id: str | None = None
    billed_credits: int = 0
    per_surface: list[dict] = field(default_factory=list)

    @property
    def coverage(self) -> float:
        return round(self.filled / self.holes, 4) if self.holes else 0.0


# A prompt that describes an EMPTY room and nothing else. Any noun that could be
# furniture is an invitation to paint furniture, which is a critical visual failure.
DEFAULT_PROMPT = (
    "An empty room interior with bare walls and bare floor. "
    "No furniture, no objects, no people, no text, no signage. "
    "Uniform even lighting, plain matte surfaces."
)


def _origin_for(room: dict, obstacle_clearance: float = 0.35) -> np.ndarray | None:
    """
    A panorama origin inside the room and outside every physical obstacle.

    Standing eye height above the floor centroid is right almost always; when furniture
    occupies the centroid the candidate positions are tried on the same 5cm-style lattice
    the rest of the system uses, in a fixed order, so the chosen origin is reproducible.
    Returns None when the room has no clear standing point, which fails the route rather
    than generating a panorama from inside a wardrobe.
    """
    floors = [s for s in room["surfaces"] if s["class"] == "floor"]
    if not floors:
        return None
    polygon = np.asarray(floors[0]["polygon"], dtype=np.float64)
    centroid = polygon.mean(axis=0)
    floor_y = float(polygon[:, 1].mean())
    boxes = [
        (
            np.asarray(o["center"], dtype=np.float64),
            np.asarray(o["size"], dtype=np.float64),
            float(o["yaw"]),
        )
        for o in room.get("obstacles", [])
    ]

    def clear(x: float, z: float) -> bool:
        for centre, size, yaw in boxes:
            dx, dz = x - centre[0], z - centre[2]
            cos_y, sin_y = np.cos(-yaw), np.sin(-yaw)
            local_x = dx * cos_y - dz * sin_y
            local_z = dx * sin_y + dz * cos_y
            if (
                abs(local_x) < size[0] / 2 + obstacle_clearance
                and abs(local_z) < size[2] / 2 + obstacle_clearance
            ):
                return False
        return True

    lo = polygon.min(axis=0)
    hi = polygon.max(axis=0)
    candidates = [(float(centroid[0]), float(centroid[2]))]
    for radius in np.arange(0.25, 2.0, 0.25):
        for angle in np.arange(0.0, 2.0 * np.pi, np.pi / 4):
            candidates.append(
                (float(centroid[0] + radius * np.cos(angle)), float(centroid[2] + radius * np.sin(angle)))
            )
    for x, z in candidates:
        if not (lo[0] + 0.2 <= x <= hi[0] - 0.2 and lo[2] + 0.2 <= z <= hi[2] - 0.2):
            continue
        if clear(x, z):
            return np.array([x, floor_y + 1.5, z], dtype=np.float64)
    return None


def enabled() -> bool:
    """Opt-in, and never on by accident. The default worker path is untouched."""
    return os.environ.get("APPEARANCE_PROVIDER", "").strip() not in ("", "none", "off")


def refine(
    room: dict,
    atlases: list,
    baseline: list[np.ndarray],
    provider: AppearanceProvider | None,
    *,
    seed: int = 0,
    prompt: str = DEFAULT_PROMPT,
    width: int = 1024,
) -> tuple[list[np.ndarray], AppearanceReport]:
    """
    Returns `(rgb per surface, report)`.

    On any failure the baseline list is returned UNCHANGED — the same objects, not
    copies — so a caller can assert identity and know nothing was touched.
    """
    report = AppearanceReport()
    report.holes = int(sum(int(atlas.holes.sum()) for atlas in atlases))
    if provider is None:
        report.reason = "no provider configured"
        return baseline, report
    if report.holes == 0:
        report.reason = "nothing to fill; every texel was observed"
        return baseline, report

    origin = _origin_for(room)
    if origin is None:
        report.reason = "no clear panorama origin inside the room"
        return baseline, report

    depth = render_depth(room, origin, width=width)
    if not depth.known.any():
        report.reason = "the shell produced no known depth from that origin"
        return baseline, report

    candidate = provider.generate(AppearanceRequest(depth=depth, prompt=prompt, seed=seed))
    if candidate is None:
        report.reason = "provider returned nothing"
        return baseline, report

    image = np.asarray(candidate.panorama)
    if image.ndim != 3 or image.shape[2] != 3 or image.shape[0] * 2 != image.shape[1]:
        report.reason = f"panorama is not 2:1 RGB ({image.shape})"
        return baseline, report

    report.provider = candidate.provider
    report.model = candidate.model
    report.seed = candidate.seed
    report.operation_id = candidate.operation_id
    report.billed_credits = candidate.billed_credits

    out: list[np.ndarray] = []
    filled_total = 0
    skipped_total = 0
    preserved = True
    for atlas, base in zip(atlases, baseline):
        holes = atlas.holes
        result = base.copy()
        if not holes.any():
            out.append(result)
            report.per_surface.append({"id": atlas.id, "holes": 0, "filled": 0, "left": 0})
            continue
        rgb, usable = reproject_onto_atlas(atlas, image, origin, pano_depth=depth)
        apply = holes & usable
        result[apply] = rgb[apply]
        # The check, not the intention: compare what came out against what went in
        # everywhere a camera actually saw. This is the gate the milestone words as
        # "decoded observed atlas texels are identical to baseline".
        observed = ~holes
        if observed.any() and not np.array_equal(result[observed], base[observed]):
            preserved = False
        filled = int(apply.sum())
        left = int((holes & ~usable).sum())
        filled_total += filled
        skipped_total += left
        report.per_surface.append(
            {"id": atlas.id, "holes": int(holes.sum()), "filled": filled, "left": left}
        )
        out.append(result)

    report.filled = filled_total
    report.left_on_baseline = skipped_total
    report.observed_preserved = preserved
    if not preserved:
        # Refusing to publish is the only safe response: a provider that can alter an
        # observed texel can make itself look better than the measurement it replaced.
        report.applied = False
        report.reason = "candidate altered observed texels; discarded"
        return baseline, report
    if filled_total == 0:
        report.reason = "no hole texel could be sampled from that panorama"
        return baseline, report

    report.applied = True
    report.reason = "applied to hole texels only"
    return out, report


def provider_from_env() -> AppearanceProvider | None:
    """
    Resolves the configured provider, or None.

    `synthetic` needs no network, no key and no money, and is what the projection
    evidence runs against. A real provider additionally refuses to load while the
    equirectangular convention is unverified against the provider's own example — that
    check is cheap and a mis-specified panorama costs real credits to discover.
    """
    name = os.environ.get("APPEARANCE_PROVIDER", "").strip().lower()
    if name in ("", "none", "off"):
        return None
    if name == "synthetic":
        from synthetic_provider import SyntheticProvider

        return SyntheticProvider()
    if name == "worldlabs":
        if not panorama.PROVIDER_CONVENTION_VERIFIED:
            raise RuntimeError(
                "worldlabs is configured but panorama.PROVIDER_CONVENTION_VERIFIED is False. "
                "Run the provider's published depth example through "
                "appearance_selftest.verify_against_reference and record the result first "
                "(M8.5-C.3); billing a generation against an unverified convention wastes it."
            )
        from worldlabs import WorldLabsProvider

        return WorldLabsProvider()
    raise RuntimeError(f"unknown APPEARANCE_PROVIDER {name!r}")
