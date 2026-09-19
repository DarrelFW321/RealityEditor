"""
Equirectangular panorama geometry for the M8.5 appearance experiment.

Two directions, both pure and both testable without a provider:

- DEPTH OUT. Render a 2:1 equirectangular depth image of the measured shell from a
  chosen origin inside the room. This is the conditioning input route A sends.
- COLOUR IN. Reproject a returned equirectangular RGB panorama back onto the existing
  atlas UVs, so candidate appearance lands on the shell we already measured rather than
  on geometry a provider invented.

Nothing here talks to a network, costs money, or needs weights. That is deliberate: the
milestone requires the projection to be verified on a synthetic room with known
distances before a single paid generation, and code that cannot run offline cannot be
verified that way.

COORDINATE AND ENCODING CONVENTION
----------------------------------
Room space is the engine's: +X right, +Y up, +Z toward the south wall, metres.

For a W x H image with H = W / 2, pixel centres map to angles as

    lon = (x + 0.5) / W * 2*pi - pi        # -pi .. +pi, increasing to the right
    lat = pi/2 - (y + 0.5) / H * pi        # +pi/2 at the top row, -pi/2 at the bottom

and a direction is

    d = (cos(lat) * sin(lon),  sin(lat),  -cos(lat) * cos(lon))

so lon = 0 looks along -Z, lon = +pi/2 looks along +X, and +Y is up. `direction_of` and
`pixel_of` are exact inverses of each other at pixel centres, which `appearance_selftest`
asserts — a convention that does not round-trip is a silent half-pixel drift in every
texel the experiment later scores.

THIS IS OUR CONVENTION, NOT A VERIFIED PROVIDER MATCH. M8.5-C.3 requires checking axis
order, depth units and PNG/EXR encoding against the provider's own depth example before
any paid call. `PROVIDER_CONVENTION_VERIFIED` stays False until someone does that.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Flipped only by a human who has run the provider's published depth example through
# `verify_against_reference` and recorded the result. Route A must not be billed while
# this is False.
PROVIDER_CONVENTION_VERIFIED = False

# Rays that leave through an opening, or miss the shell entirely, carry this depth.
UNKNOWN_DEPTH = 0.0
# Nothing closer than this is a real surface hit; it is the origin's own epsilon.
MIN_DEPTH_M = 1e-4


def direction_of(x: np.ndarray, y: np.ndarray, width: int, height: int) -> np.ndarray:
    """Pixel centres to unit directions. Vectorised; `x`/`y` broadcast together."""
    lon = (x + 0.5) / width * 2.0 * np.pi - np.pi
    lat = np.pi / 2.0 - (y + 0.5) / height * np.pi
    cos_lat = np.cos(lat)
    return np.stack([cos_lat * np.sin(lon), np.sin(lat), -cos_lat * np.cos(lon)], axis=-1)


def pixel_of(direction: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Unit directions to fractional pixel coordinates. Exact inverse of `direction_of`."""
    d = np.asarray(direction, dtype=np.float64)
    norm = np.linalg.norm(d, axis=-1, keepdims=True)
    d = d / np.maximum(norm, 1e-12)
    lon = np.arctan2(d[..., 0], -d[..., 2])
    lat = np.arcsin(np.clip(d[..., 1], -1.0, 1.0))
    x = (lon + np.pi) / (2.0 * np.pi) * width - 0.5
    y = (np.pi / 2.0 - lat) / np.pi * height - 0.5
    return x, y


# ---------------------------------------------------------------- shell geometry


@dataclass(frozen=True)
class Facet:
    """One planar shell surface, with the openings cut into it."""

    id: str
    cls: str
    polygon: np.ndarray            # (n, 3) room space
    normal: np.ndarray             # (3,) unit
    offset: float                  # plane constant: dot(normal, p) == offset
    openings: tuple[np.ndarray, ...]  # polygons, coplanar, depth is UNKNOWN through these


def _plane_of(polygon: np.ndarray, hint: np.ndarray) -> tuple[np.ndarray, float]:
    """Newell's method, oriented to agree with the surface's declared normal."""
    normal = np.zeros(3)
    count = len(polygon)
    for i in range(count):
        a = polygon[i]
        b = polygon[(i + 1) % count]
        normal += np.cross(a, b)
    length = np.linalg.norm(normal)
    if length < 1e-12:
        normal = np.asarray(hint, dtype=np.float64)
        length = max(np.linalg.norm(normal), 1e-12)
    normal = normal / length
    if float(np.dot(normal, hint)) < 0:
        normal = -normal
    return normal, float(np.dot(normal, polygon[0]))


def _basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Any orthonormal pair spanning the plane. Only used for inside/outside tests."""
    seed = np.array([0.0, 1.0, 0.0]) if abs(normal[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(seed, normal)
    u = u / max(np.linalg.norm(u), 1e-12)
    return u, np.cross(normal, u)


def _inside(point: np.ndarray, polygon: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Even-odd test in the plane's own 2D basis. `point` is (..., 3)."""
    px = point @ u
    py = point @ v
    qx = polygon @ u
    qy = polygon @ v
    inside = np.zeros(px.shape, dtype=bool)
    count = len(polygon)
    for i in range(count):
        j = (i + count - 1) % count
        straddles = (qy[i] > py) != (qy[j] > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            crossing = (qx[j] - qx[i]) * (py - qy[i]) / (qy[j] - qy[i] + 1e-30) + qx[i]
        inside ^= straddles & (px < crossing)
    return inside


def facets_of(room: dict) -> list[Facet]:
    """Shell surfaces with their openings attached, in a fixed id order."""
    by_parent: dict[str, list[np.ndarray]] = {}
    for opening in room.get("openings", []) or []:
        by_parent.setdefault(opening["parent"], []).append(
            np.asarray(opening["polygon"], dtype=np.float64)
        )
    out: list[Facet] = []
    for surface in sorted(room["surfaces"], key=lambda s: s["id"]):
        polygon = np.asarray(surface["polygon"], dtype=np.float64)
        if len(polygon) < 3:
            continue
        normal, offset = _plane_of(polygon, np.asarray(surface["normal"], dtype=np.float64))
        out.append(
            Facet(
                id=surface["id"],
                cls=surface["class"],
                polygon=polygon,
                normal=normal,
                offset=offset,
                openings=tuple(by_parent.get(surface["id"], ())),
            )
        )
    return out


@dataclass
class DepthPanorama:
    origin: np.ndarray
    depth: np.ndarray          # (H, W) float32 metres; UNKNOWN_DEPTH where nothing is known
    surface: np.ndarray        # (H, W) int32 index into `facets`, -1 where unknown
    facets: list[Facet]

    @property
    def known(self) -> np.ndarray:
        return self.depth > MIN_DEPTH_M

    @property
    def z_range(self) -> tuple[float, float]:
        """Min/max over KNOWN texels only, which is what a normalised encoding needs."""
        known = self.known
        if not known.any():
            return 0.0, 1.0
        return float(self.depth[known].min()), float(self.depth[known].max())


def render_depth(room: dict, origin: np.ndarray, width: int = 1024) -> DepthPanorama:
    """
    Ray-casts the measured shell into an equirectangular depth image.

    A ray that hits a wall inside one of its openings is UNKNOWN, not the wall distance
    and not a guess at the room beyond. That is the whole reason openings travel in the
    room payload: the alternative is quietly claiming a window is a solid surface 3m
    away, which would condition the provider to paint a wall over it.
    """
    height = width // 2
    facets = facets_of(room)
    ys, xs = np.mgrid[0:height, 0:width]
    directions = direction_of(xs.astype(np.float64), ys.astype(np.float64), width, height)

    best = np.full((height, width), np.inf)
    hit = np.full((height, width), -1, dtype=np.int32)
    blocked = np.zeros((height, width), dtype=bool)

    for index, facet in enumerate(facets):
        denominator = directions @ facet.normal
        # Rays parallel to the plane never hit it; the epsilon also drops grazing rays
        # whose intersection is numerically meaningless.
        usable = np.abs(denominator) > 1e-9
        t = np.full((height, width), np.inf)
        np.divide(
            facet.offset - float(np.dot(facet.normal, origin)),
            denominator,
            out=t,
            where=usable,
        )
        forward = usable & (t > MIN_DEPTH_M) & np.isfinite(t)
        if not forward.any():
            continue
        points = origin + directions * t[..., None]
        u, v = _basis(facet.normal)
        within = np.zeros_like(forward)
        within[forward] = _inside(points[forward], facet.polygon, u, v)
        if not within.any():
            continue

        # An opening is a hole in this facet, so the ray passes THROUGH rather than
        # stopping. Recorded separately: it must beat a farther surface behind it, or a
        # window would report the distance to whatever the ray hits next.
        through = np.zeros_like(within)
        for opening in facet.openings:
            if len(opening) < 3:
                continue
            candidate = np.zeros_like(within)
            candidate[within] = _inside(points[within], opening, u, v)
            through |= candidate
        solid = within & ~through

        nearer_solid = solid & (t < best)
        best = np.where(nearer_solid, t, best)
        hit = np.where(nearer_solid, index, hit)
        # Anything the opening lets through is unknown from here outward.
        blocked |= through & (t <= best)

    depth = np.where(np.isfinite(best), best, UNKNOWN_DEPTH).astype(np.float32)
    surface = np.where(np.isfinite(best), hit, -1).astype(np.int32)
    unknown = blocked & ~np.isfinite(best)
    # A ray through an opening that then hits nothing is unknown; one that hits a farther
    # wall would have set `best` already and is a legitimate sight line past a doorway.
    depth[unknown] = UNKNOWN_DEPTH
    surface[unknown] = -1
    return DepthPanorama(origin=np.asarray(origin, dtype=np.float64), depth=depth, surface=surface, facets=facets)


def encode_depth_png(pano: DepthPanorama) -> tuple[np.ndarray, float, float]:
    """
    16-bit normalised depth plus the `z_min`/`z_max` the provider contract requires.

    0 is reserved for unknown, so the usable range starts at 1. Round-tripping through
    `decode_depth_png` is asserted in the self-test, because a normalisation that cannot
    be inverted is a silent metric error in every conditioned generation.
    """
    z_min, z_max = pano.z_range
    span = max(z_max - z_min, 1e-6)
    normalised = (pano.depth - z_min) / span
    encoded = np.zeros(pano.depth.shape, dtype=np.uint16)
    known = pano.known
    encoded[known] = 1 + np.clip(normalised[known] * 65534.0, 0, 65534).astype(np.uint16)
    return encoded, z_min, z_max


def decode_depth_png(encoded: np.ndarray, z_min: float, z_max: float) -> np.ndarray:
    span = max(z_max - z_min, 1e-6)
    depth = np.zeros(encoded.shape, dtype=np.float32)
    known = encoded > 0
    depth[known] = z_min + (encoded[known].astype(np.float32) - 1.0) / 65534.0 * span
    return depth


# ---------------------------------------------------------------- colour back in


def sample_equirect(panorama: np.ndarray, directions: np.ndarray) -> np.ndarray:
    """Bilinear sample of an equirectangular RGB image, wrapping in longitude."""
    height, width = panorama.shape[:2]
    x, y = pixel_of(directions, width, height)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    # Longitude wraps; latitude clamps, because there is no pixel above the pole.
    xi0 = np.mod(x0, width)
    xi1 = np.mod(x0 + 1, width)
    yi0 = np.clip(y0, 0, height - 1)
    yi1 = np.clip(y0 + 1, 0, height - 1)
    top = panorama[yi0, xi0] * (1 - fx) + panorama[yi0, xi1] * fx
    bottom = panorama[yi1, xi0] * (1 - fx) + panorama[yi1, xi1] * fx
    return top * (1 - fy) + bottom * fy


def texel_directions(atlas, origin: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    World position and viewing direction for every texel of one atlas.

    The atlas is planar and its parameterisation is already fixed by `project_surfaces`,
    so the same corner/u/v that placed observed colour places candidate colour. Reusing
    it is what keeps the candidate on the measured shell instead of on a second, subtly
    different surface.
    """
    rows, cols = atlas.rows, atlas.cols
    us = (np.arange(cols, dtype=np.float64) + 0.5) / cols
    vs = (np.arange(rows, dtype=np.float64) + 0.5) / rows
    grid_v, grid_u = np.meshgrid(vs, us, indexing="ij")
    extent_u = np.asarray(atlas.u_axis, dtype=np.float64)
    extent_v = np.asarray(atlas.v_axis, dtype=np.float64)
    points = (
        np.asarray(atlas.corner, dtype=np.float64)
        + grid_u[..., None] * extent_u
        + grid_v[..., None] * extent_v
    )
    return points, points - np.asarray(origin, dtype=np.float64)


def reproject_onto_atlas(
    atlas,
    panorama: np.ndarray,
    origin: np.ndarray,
    pano_depth: DepthPanorama | None = None,
    tolerance_m: float = 0.15,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Samples candidate colour for every texel of one atlas.

    Returns `(rgb, usable)`. `usable` is False where the panorama cannot speak for that
    texel — behind an opening, or occluded by nearer geometry so the panorama pixel shows
    something else entirely. Those texels stay on baseline completion rather than taking
    a colour that belongs to a different surface, which is the difference between filling
    a hole and smearing the room across it.
    """
    points, rays = texel_directions(atlas, origin)
    distance = np.linalg.norm(rays, axis=-1)
    rgb = sample_equirect(panorama.astype(np.float32), rays)
    usable = distance > MIN_DEPTH_M

    if pano_depth is not None:
        height, width = pano_depth.depth.shape
        x, y = pixel_of(rays, width, height)
        xi = np.mod(np.rint(x).astype(np.int64), width)
        yi = np.clip(np.rint(y).astype(np.int64), 0, height - 1)
        expected = pano_depth.depth[yi, xi]
        # Unknown in the conditioning depth means unknown in the result. A texel whose
        # ray the panorama says is closer than the texel is occluded from this origin.
        usable &= expected > MIN_DEPTH_M
        usable &= distance <= expected + tolerance_m

    return np.clip(rgb, 0, 255).astype(np.float32), usable
