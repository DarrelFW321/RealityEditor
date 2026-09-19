"""
M8.5-C synthetic projection evidence. No network, no weights, no money.

Proves the four things that must be true before a paid generation is worth making, on a
room whose distances and axes are known exactly:

1. The equirectangular convention round-trips. A direction turned into a pixel and back
   is the same direction, to floating-point.
2. Depth is metrically correct. A 4x4x2.5m box seen from a known origin has known
   distances along each axis, and the rendered panorama must report them.
3. Openings stay unknown. A ray through the window must NOT come back as wall distance,
   because a depth image that closes the window conditions the provider to paint one.
4. Reprojection lands where it should, and only in holes. Every filled texel receives
   the colour the panorama actually holds for that texel's direction, and every observed
   texel is byte-identical to baseline.

Run: `python3 workers/reconstruction/appearance_selftest.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

import panorama
from appearance import AppearanceReport, refine
from panorama import (
    UNKNOWN_DEPTH,
    decode_depth_png,
    direction_of,
    encode_depth_png,
    pixel_of,
    render_depth,
)
from synthetic_provider import SyntheticProvider, expected_colour

GREEN, RED, DIM, OFF = "\x1b[32m", "\x1b[31m", "\x1b[2m", "\x1b[0m"
results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str) -> None:
    results.append((label, bool(ok), detail))
    print(f"  {GREEN + 'ok' + OFF if ok else RED + 'NO' + OFF} {label} {DIM}- {detail}{OFF}")


# A 4 x 4 room, 2.5m tall, centred on the origin, with a window in the north wall at
# the same place the app's own bedroom fixture puts one.
HALF, CEIL = 2.0, 2.5
ROOM = {
    "origin": [0.0, 0.0, 0.0],
    "surfaces": [
        {
            "id": "srf_floor",
            "class": "floor",
            "polygon": [[-HALF, 0, -HALF], [HALF, 0, -HALF], [HALF, 0, HALF], [-HALF, 0, HALF]],
            "normal": [0, 1, 0],
            "inferred": False,
        },
        {
            "id": "srf_wall_north",
            "class": "wall",
            "polygon": [[-HALF, 0, -HALF], [HALF, 0, -HALF], [HALF, CEIL, -HALF], [-HALF, CEIL, -HALF]],
            "normal": [0, 0, 1],
            "inferred": False,
        },
        {
            "id": "srf_wall_south",
            "class": "wall",
            "polygon": [[HALF, 0, HALF], [-HALF, 0, HALF], [-HALF, CEIL, HALF], [HALF, CEIL, HALF]],
            "normal": [0, 0, -1],
            "inferred": False,
        },
        {
            "id": "srf_wall_east",
            "class": "wall",
            "polygon": [[HALF, 0, -HALF], [HALF, 0, HALF], [HALF, CEIL, HALF], [HALF, CEIL, -HALF]],
            "normal": [-1, 0, 0],
            "inferred": False,
        },
        {
            "id": "srf_wall_west",
            "class": "wall",
            "polygon": [[-HALF, 0, HALF], [-HALF, 0, -HALF], [-HALF, CEIL, -HALF], [-HALF, CEIL, HALF]],
            "normal": [1, 0, 0],
            "inferred": False,
        },
    ],
    "openings": [
        {
            "id": "srf_window_north",
            "class": "window",
            "parent": "srf_wall_north",
            "polygon": [[-0.7, 0.9, -HALF], [0.7, 0.9, -HALF], [0.7, 2.1, -HALF], [-0.7, 2.1, -HALF]],
        }
    ],
    "obstacles": [],
}


class FakeAtlas:
    """The fields `reproject_onto_atlas` reads, without importing the projector."""

    def __init__(self, id: str, corner, u_axis, v_axis, cols: int, rows: int):
        self.id = id
        self.corner = np.asarray(corner, dtype=np.float64)
        self.u_axis = np.asarray(u_axis, dtype=np.float64)
        self.v_axis = np.asarray(v_axis, dtype=np.float64)
        self.cols = cols
        self.rows = rows
        self.rgb = np.zeros((rows, cols, 3), dtype=np.float32)
        self.weight = np.zeros((rows, cols), dtype=np.float32)
        self.inferred = False

    @property
    def holes(self):
        return self.weight <= 0.0


# ---------------------------------------------------------------- M8.5-C.3

# The four ways an equirectangular convention usually differs between two codebases.
# Anything outside this set is a genuine incompatibility rather than a relabelling.
CANDIDATE_CONVENTIONS = {
    "identity": lambda d: d,
    "lon+180": lambda d: np.stack([-d[..., 0], d[..., 1], -d[..., 2]], axis=-1),
    "lon-mirrored": lambda d: np.stack([-d[..., 0], d[..., 1], d[..., 2]], axis=-1),
    "lat-flipped": lambda d: np.stack([d[..., 0], -d[..., 1], d[..., 2]], axis=-1),
}


def verify_against_reference(
    reference: np.ndarray,
    z_min: float,
    z_max: float,
    expectations: list[dict],
    tolerance_m: float = 0.05,
) -> dict:
    """
    M8.5-C.3: does OUR equirectangular convention agree with the provider's?

    `reference` is the provider's own published depth panorama, decoded as 16-bit, with
    the `z_min`/`z_max` that accompanied it. `expectations` are landmarks read off their
    documentation or example scene, each `{"label", "lon_deg", "lat_deg", "metres"}`.

    Samples the reference at the pixel OUR maths says each landmark occupies, under each
    candidate convention, and reports which one fits. Identity winning is the result that
    permits `PROVIDER_CONVENTION_VERIFIED = True`; anything else means our encoder must
    be changed to match theirs before a credit is spent, because a depth panorama sent
    with a mirrored longitude produces a plausible, confidently wrong room.

    Deliberately not automatic. It returns a verdict for a person to record, and nothing
    here flips the flag: an unattended check that enables paid calls is how a convention
    mismatch becomes twelve billed runs of garbage.
    """
    depth = decode_depth_png(reference, z_min, z_max)
    height, width = depth.shape
    report: dict = {"shape": [int(width), int(height)], "two_to_one": width == height * 2, "fits": {}}
    if not expectations:
        report["verdict"] = "no expectations supplied; nothing was checked"
        return report

    for name, transform in CANDIDATE_CONVENTIONS.items():
        errors = []
        for item in expectations:
            lon = np.radians(float(item["lon_deg"]))
            lat = np.radians(float(item["lat_deg"]))
            direction = np.array(
                [np.cos(lat) * np.sin(lon), np.sin(lat), -np.cos(lat) * np.cos(lon)]
            )
            x, y = pixel_of(transform(direction), width, height)
            row = min(max(int(round(float(y))), 0), height - 1)
            got = float(depth[row, int(round(float(x))) % width])
            errors.append(abs(got - float(item["metres"])) if got > 0 else float("inf"))
        report["fits"][name] = {
            "maxErrorM": None if not np.isfinite(max(errors)) else round(max(errors), 4),
            "matched": bool(np.isfinite(max(errors)) and max(errors) <= tolerance_m),
        }

    winners = [name for name, fit in report["fits"].items() if fit["matched"]]
    if winners == ["identity"]:
        report["verdict"] = (
            "MATCH. Our convention agrees with the provider's. Record this run, then set "
            "panorama.PROVIDER_CONVENTION_VERIFIED = True."
        )
    elif winners:
        report["verdict"] = (
            f"MISMATCH. The provider matches {winners} rather than identity. Change "
            "panorama.direction_of/pixel_of to their convention and re-run; do NOT set "
            "PROVIDER_CONVENTION_VERIFIED."
        )
    else:
        report["verdict"] = (
            "NO FIT. None of the usual conventions explains the reference. Re-read the "
            "provider's depth example before spending anything; this route may not be "
            "expressible with our encoding at all (M8.5-C.3 says exclude it if so)."
        )
    return report


# A room that is NOT symmetric about x. The square room above cannot detect a longitude
# mirror at all — swapping east for west swaps two walls that are both 2m away — so
# verifying a convention in it would be vacuous. The east wall moves to x=+3 so the two
# sides are distinguishable, which is a requirement for the landmarks, not a detail.
ASYMMETRIC_ROOM = {
    "origin": [0.0, 0.0, 0.0],
    "surfaces": [
        {
            "id": "srf_floor",
            "class": "floor",
            "polygon": [[-2, 0, -2], [3, 0, -2], [3, 0, 2], [-2, 0, 2]],
            "normal": [0, 1, 0],
            "inferred": False,
        },
        {
            "id": "srf_wall_north",
            "class": "wall",
            "polygon": [[-2, 0, -2], [3, 0, -2], [3, CEIL, -2], [-2, CEIL, -2]],
            "normal": [0, 0, 1],
            "inferred": False,
        },
        {
            "id": "srf_wall_south",
            "class": "wall",
            "polygon": [[3, 0, 2], [-2, 0, 2], [-2, CEIL, 2], [3, CEIL, 2]],
            "normal": [0, 0, -1],
            "inferred": False,
        },
        {
            "id": "srf_wall_east",
            "class": "wall",
            "polygon": [[3, 0, -2], [3, 0, 2], [3, CEIL, 2], [3, CEIL, -2]],
            "normal": [-1, 0, 0],
            "inferred": False,
        },
        {
            "id": "srf_wall_west",
            "class": "wall",
            "polygon": [[-2, 0, 2], [-2, 0, -2], [-2, CEIL, -2], [-2, CEIL, 2]],
            "normal": [1, 0, 0],
            "inferred": False,
        },
    ],
    "openings": [],
    "obstacles": [],
}


def _self_check_verifier() -> tuple[bool, str]:
    """
    The verifier gates spending, so it is itself checked against references we generated
    and therefore know the answer for. Three properties, all of which have to hold:

    1. An honest reference in an asymmetric room yields MATCH on identity alone.
    2. A mirrored reference is NOT called a match.
    3. Landmarks that cannot discriminate (the symmetric room) are refused rather than
       waved through — an ambiguous check that reads as a pass is worse than no check.
    """
    pano = render_depth(ASYMMETRIC_ROOM, np.array([0.0, 1.5, 0.0]), width=512)
    encoded, z_min, z_max = encode_depth_png(pano)
    expectations = [
        {"label": "east wall", "lon_deg": 90.0, "lat_deg": 0.0, "metres": 3.0},
        {"label": "west wall", "lon_deg": -90.0, "lat_deg": 0.0, "metres": 2.0},
        {"label": "floor", "lon_deg": 0.0, "lat_deg": -90.0, "metres": 1.5},
    ]
    honest = verify_against_reference(encoded, z_min, z_max, expectations)
    mirrored = verify_against_reference(encoded[:, ::-1].copy(), z_min, z_max, expectations)

    square = render_depth(ROOM, np.array([0.0, 1.5, 0.0]), width=512)
    square_encoded, s_min, s_max = encode_depth_png(square)
    ambiguous = verify_against_reference(
        square_encoded,
        s_min,
        s_max,
        [
            {"label": "east wall", "lon_deg": 90.0, "lat_deg": 0.0, "metres": 2.0},
            {"label": "west wall", "lon_deg": -90.0, "lat_deg": 0.0, "metres": 2.0},
        ],
    )

    matched = honest["verdict"].startswith("MATCH")
    rejected_mirror = not mirrored["fits"]["identity"]["matched"]
    caught_ambiguity = not ambiguous["verdict"].startswith("MATCH")
    ok = matched and rejected_mirror and caught_ambiguity
    return ok, (
        f"honest={honest['verdict'].split('.')[0]}, "
        f"mirror rejected={rejected_mirror}, "
        f"symmetric landmarks refused={caught_ambiguity}"
    )


def main() -> int:
    print("\nconvention")
    width, height = 256, 128
    ys, xs = np.mgrid[0:height, 0:width]
    forward = direction_of(xs.astype(np.float64), ys.astype(np.float64), width, height)
    back_x, back_y = pixel_of(forward, width, height)
    drift = max(
        float(np.abs(back_x - xs).max()),
        float(np.abs(back_y - ys).max()),
    )
    check("direction and pixel are exact inverses", drift < 1e-9, f"max drift {drift:.2e} px")

    centre = direction_of(np.array(width / 2.0 - 0.5), np.array(height / 2.0 - 0.5), width, height)
    check(
        "longitude zero looks along -Z and +Y is up",
        abs(centre[2] + 1.0) < 1e-9 and abs(centre[1]) < 1e-9,
        f"centre ray {np.round(centre, 6).tolist()}",
    )

    print("\ndepth, against known distances")
    origin = np.array([0.0, 1.5, 0.0])
    pano = render_depth(ROOM, origin, width=512)
    h, w = pano.depth.shape

    def ray_depth(direction) -> float:
        # Longitude WRAPS, latitude CLAMPS. Wrapping y sends straight-down to the top
        # row, which reported the missing ceiling and made the floor look unknown.
        x, y = pixel_of(np.asarray(direction, dtype=np.float64), w, h)
        row = min(max(int(round(float(y))), 0), h - 1)
        return float(pano.depth[row, int(round(float(x))) % w])

    # Straight down is the floor at eye height; the cardinal walls are 2m away.
    cases = [
        ("floor below", [0, -1, 0], 1.5),
        ("east wall", [1, 0, 0], 2.0),
        ("west wall", [-1, 0, 0], 2.0),
        ("south wall", [0, 0, 1], 2.0),
    ]
    for label, direction, expected in cases:
        got = ray_depth(direction)
        check(f"{label} is {expected}m", abs(got - expected) < 0.02, f"{got:.4f}m")

    # A 45-degree ray in the floor plane reaches the corner at 2*sqrt(2).
    diagonal = ray_depth([1, 0, 1])
    check(
        "the diagonal reaches the corner",
        abs(diagonal - 2.0 * np.sqrt(2)) < 0.03,
        f"{diagonal:.4f}m vs {2.0 * np.sqrt(2):.4f}m",
    )

    print("\nopenings stay unknown")
    # Straight at the window centre: 0.9-2.1m high on the north wall, eye at 1.5m, so a
    # horizontal ray along -Z passes through the glass.
    through_window = ray_depth([0, 0, -1])
    check(
        "a ray through the window is unknown, not wall distance",
        through_window == UNKNOWN_DEPTH,
        f"{through_window} (wall would be 2.0)",
    )
    # The same wall below the sill must still be solid, which is what proves the opening
    # is a hole cut in the wall rather than the wall having gone missing. Aimed at
    # (0, 0.5, -2): below the 0.9m sill, and steep enough to reach the wall before the
    # floor. Expected distance is the length of that offset from the eye.
    below = ray_depth([0, -1, -2])
    want_below = float(np.linalg.norm([0.0, 0.5 - 1.5, -2.0]))
    check(
        "the wall below the sill is still solid",
        abs(below - want_below) < 0.05,
        f"{below:.4f}m vs {want_below:.4f}m",
    )

    # Where unknown is allowed to be below the horizon. The window sill sits at 0.9m
    # and the eye at 1.5m, so the lower half of the glass points slightly DOWNWARD: a
    # ray through it leaves the room and hits nothing, which is correctly unknown even
    # though it is below the horizon. Steeply down there is only floor.
    steep = pano.depth[int(h * 0.75) :, :]
    check(
        "steeply downward is all floor",
        bool((steep > 0).all()),
        f"{int((steep <= 0).sum())} unknown texels in the bottom quarter",
    )
    # And the shallow unknown band must sit inside the window's azimuth, not anywhere
    # else — that is what ties it to the opening rather than to a hole in the renderer.
    band = pano.depth[h // 2 + 2 : int(h * 0.75), :] <= 0
    columns = np.where(band.any(axis=0))[0]
    half_angle = float(np.arctan2(0.7, 2.0))
    lo = int((-half_angle + np.pi) / (2 * np.pi) * w) - 3
    hi = int((half_angle + np.pi) / (2 * np.pi) * w) + 3
    check(
        "below-horizon unknown is confined to the window's azimuth",
        columns.size == 0 or (int(columns.min()) >= lo and int(columns.max()) <= hi),
        f"columns {int(columns.min()) if columns.size else '-'}..{int(columns.max()) if columns.size else '-'} within {lo}..{hi}",
    )
    # Above it, the sphere is legitimately unknown: the reconstruction room contract
    # carries walls and floors only, so this synthetic room has no ceiling to hit. That
    # is a recorded limitation of route A conditioning, not a defect here.
    upper_unknown = float((pano.depth[: h // 2 - 2, :] <= 0).mean())
    check(
        "the missing ceiling is the unknown region above the horizon",
        upper_unknown > 0.5,
        f"{upper_unknown * 100:.1f}% of the upper hemisphere; no ceiling in the room payload",
    )

    print("\ndepth encoding round-trip")
    encoded, z_min, z_max = encode_depth_png(pano)
    decoded = decode_depth_png(encoded, z_min, z_max)
    known = pano.known
    error = float(np.abs(decoded[known] - pano.depth[known]).max())
    check("16-bit normalised depth round-trips", error < 1e-3, f"max error {error * 1000:.3f}mm")
    check(
        "unknown survives encoding as zero",
        bool((encoded[~known] == 0).all()) and bool((decoded[~known] == 0).all()),
        f"{int((~known).sum())} unknown texels",
    )

    print("\nreprojection onto shell UVs")
    # The north wall, 4m x 2.5m, at 64 px/m. Left half observed, right half a hole, so
    # the hole-only rule has something to get wrong.
    atlas = FakeAtlas(
        "srf_wall_north",
        corner=[-HALF, 0.0, -HALF],
        u_axis=[2 * HALF, 0.0, 0.0],
        v_axis=[0.0, CEIL, 0.0],
        cols=128,
        rows=80,
    )
    atlas.rgb[:] = 17.0
    atlas.weight[:, : atlas.cols // 2] = 1.0
    baseline = [np.full((atlas.rows, atlas.cols, 3), 17.0, dtype=np.float32)]

    filled, report = refine(ROOM, [atlas], baseline, SyntheticProvider(), width=512)
    rgb = filled[0]
    holes = atlas.holes
    observed = ~holes

    check("the candidate was applied", report.applied, f"{report.reason}")
    check(
        "observed texels are byte-identical to baseline",
        report.observed_preserved and np.array_equal(rgb[observed], baseline[0][observed]),
        f"{int(observed.sum())} observed texels unchanged",
    )
    check(
        "only hole texels changed",
        bool((rgb[observed] == 17.0).all()),
        "no observed texel was repainted",
    )
    check(
        "most of the hole was filled",
        report.coverage > 0.6,
        f"{report.filled}/{report.holes} texels ({report.coverage * 100:.1f}%)",
    )

    # The exact-colour check. Each filled texel must hold the colour the synthetic
    # panorama encodes for that texel's own direction, which is only true if the
    # reprojection put it in the right place.
    points, rays = panorama.texel_directions(atlas, np.array([0.0, 1.5, 0.0]))
    want = expected_colour(rays).astype(np.float32)
    changed = holes & np.any(rgb != baseline[0], axis=-1)
    if changed.any():
        deviation = float(np.abs(rgb[changed] - want[changed]).max())
        check(
            "filled texels hold the colour for their own direction",
            deviation <= 2.0,
            f"max channel error {deviation:.2f}/255 over {int(changed.sum())} texels",
        )
    else:
        check("filled texels hold the colour for their own direction", False, "nothing changed")

    print("\nsafety rails")
    empty = AppearanceReport()
    unchanged, off_report = refine(ROOM, [atlas], baseline, None)
    check(
        "no provider leaves the baseline object untouched",
        unchanged is baseline and not off_report.applied,
        off_report.reason,
    )

    class Liar:
        id = "liar"

        def generate(self, request):
            from appearance import AppearanceCandidate

            h2, w2 = request.depth.depth.shape
            return AppearanceCandidate(
                panorama=np.zeros((h2, w2, 3), dtype=np.uint8), provider="liar", model="l", seed=0
            )

    class WrongShape:
        id = "wrong"

        def generate(self, request):
            from appearance import AppearanceCandidate

            return AppearanceCandidate(
                panorama=np.zeros((10, 10, 3), dtype=np.uint8), provider="wrong", model="w", seed=0
            )

    _, bad = refine(ROOM, [atlas], baseline, WrongShape())
    check("a non 2:1 panorama is rejected", not bad.applied and "2:1" in bad.reason, bad.reason)

    black, dark = refine(ROOM, [atlas], baseline, Liar())
    check(
        "even an all-black candidate cannot touch observed texels",
        np.array_equal(black[0][observed], baseline[0][observed]),
        "observed preserved",
    )

    check(
        "a real provider is refused while the convention is unverified",
        panorama.PROVIDER_CONVENTION_VERIFIED is False,
        "PROVIDER_CONVENTION_VERIFIED is False; worldlabs will refuse to load",
    )
    verifier_ok, verifier_detail = _self_check_verifier()
    check(
        "the convention verifier itself is trustworthy",
        verifier_ok,
        verifier_detail,
    )

    print("\nmasked inpainting")
    import inpaint
    from inpaint import SyntheticInpainter, hole_windows, run as inpaint_run

    wall = FakeAtlas("wall", corner=[-2, 0, -2], u_axis=[4, 0, 0], v_axis=[0, 2.5, 0], cols=1400, rows=900)
    wall.rgb[:] = 90.0
    wall.weight[:] = 1.0
    # One rectangular gap, as a piece of furniture standing against the wall leaves.
    wall.weight[300:700, 400:900] = 0.0
    baseline = [np.full((wall.rows, wall.cols, 3), 90.0, dtype=np.float32)]
    holes = wall.holes

    windows = hole_windows(holes, 2)
    inside = all(0 <= w[0] < w[2] <= wall.rows and 0 <= w[1] < w[3] <= wall.cols for w in windows)
    covers = windows and holes[windows[0][0]:windows[0][2], windows[0][1]:windows[0][3]].any()
    check("hole windows stay inside the atlas", bool(inside and windows), f"{len(windows)} window(s): {windows}")
    check("the first window covers holes", bool(covers), "prioritised by hole coverage")
    check(
        "windows are at most one tile across",
        all(w[2] - w[0] <= inpaint.TILE and w[3] - w[1] <= inpaint.TILE for w in windows),
        f"tile {inpaint.TILE}",
    )
    check("the same mask yields the same windows", hole_windows(holes, 2) == windows, "deterministic")

    filled, report = inpaint_run([wall], baseline, SyntheticInpainter())
    observed = ~holes
    check("the filler was applied", report.applied, report.reason)
    check(
        "observed texels are byte-identical to baseline",
        np.array_equal(filled[0][observed], baseline[0][observed]) and report.observed_preserved,
        f"{int(observed.sum())} observed texels unchanged",
    )
    check("hole texels changed", bool((filled[0][holes] != 90.0).any()), f"{report.filled} filled")
    check(
        "the call count is bounded",
        report.tiles_requested <= inpaint.MAX_TILES_TOTAL,
        f"{report.tiles_requested} of at most {inpaint.MAX_TILES_TOTAL}",
    )

    # A filler that repaints outside its mask must not be able to change the wall.
    class Vandal:
        id = "vandal"
        model = "v"

        def fill(self, rgb, mask):
            return np.zeros_like(np.asarray(rgb, dtype=np.uint8))

    vandalised, bad = inpaint_run([wall], baseline, Vandal())
    check(
        "a filler that edits outside its mask cannot touch observed texels",
        np.array_equal(vandalised[0][observed], baseline[0][observed]),
        "paste is hole-only regardless",
    )
    check("and the attempt is recorded", not bad.observed_preserved, "; ".join(bad.notes) or "unrecorded")

    class Broken:
        id = "broken"
        model = "b"

        def fill(self, rgb, mask):
            raise RuntimeError("upstream exploded")

    survived, crashed = inpaint_run([wall], baseline, Broken())
    check(
        "a failing filler returns the baseline untouched",
        survived is baseline and not crashed.applied,
        crashed.reason,
    )
    check("no filler configured is a no-op", inpaint_run([wall], baseline, None)[0] is baseline, "unchanged")

    tiny = FakeAtlas("tiny", corner=[0, 0, 0], u_axis=[1, 0, 0], v_axis=[0, 1, 0], cols=60, rows=60)
    tiny.weight[:] = 1.0
    tiny.weight[0:5, 0:5] = 0.0
    tinyBase = [np.full((60, 60, 3), 40.0, dtype=np.float32)]
    _, small = inpaint_run([tiny], tinyBase, SyntheticInpainter())
    check(
        "a hole too small to be worth a call is left alone",
        not small.applied and small.tiles_requested == 0,
        small.reason,
    )

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
