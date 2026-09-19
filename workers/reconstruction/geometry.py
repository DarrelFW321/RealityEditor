"""
Projection maths for the reconstruction worker.

Pure numpy, no models, no I/O — so it can be checked numerically without weights, a GPU or
a server. Everything downstream is only as correct as this file, and a sign error here
produces an atlas that looks plausible and is registered to the wrong place.

CONVENTIONS, stated because getting one wrong is silent:

- Matrices arrive COLUMN-MAJOR, flattened, matching `simd_float4x4` memory order and
  `Matrix4.fromArray`. `as_matrix` transposes them into numpy's row-major convention.
- ARKit camera space is +X right, +Y up, -Z forward. A point in front of the camera has
  NEGATIVE z.
- Image space is pixels of the captured frame, origin top-left, +v DOWN.
- Room space is the scene's frame: the floor centroid is the origin and +Y is up. Keyframe
  poses are in ARKit world space, so `origin` is subtracted to bring them into room space.
"""

from __future__ import annotations

import numpy as np

EPS = 1e-9


def as_matrix(flat: list[float], n: int = 4) -> np.ndarray:
    """Column-major flat array -> row-major (n, n)."""
    return np.array(flat, dtype=np.float64).reshape(n, n).T


def camera_in_room(camera_to_world: list[float], origin: np.ndarray) -> np.ndarray:
    """Camera-to-room 4x4. The pose arrives in world space; the room is recentred."""
    m = as_matrix(camera_to_world)
    m[:3, 3] -= origin
    return m


def project(
    points_room: np.ndarray,
    camera_to_room: np.ndarray,
    intrinsics: np.ndarray,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Room-space points -> pixel coordinates in one keyframe.

    Returns (uv, depth, valid): uv is (N, 2) float pixels, depth is (N,) metres along the
    view axis, valid is (N,) bool for points in front of the camera and inside the frame.
    """
    room_to_camera = np.linalg.inv(camera_to_room)
    homogeneous = np.concatenate(
        [points_room, np.ones((len(points_room), 1))], axis=1
    )
    camera = (room_to_camera @ homogeneous.T).T[:, :3]

    # -Z is forward, so anything with z >= 0 is behind the lens.
    depth = -camera[:, 2]
    in_front = depth > EPS
    safe = np.where(in_front, depth, 1.0)

    fx, fy = intrinsics[0, 0], intrinsics[1, 1]
    cx, cy = intrinsics[0, 2], intrinsics[1, 2]
    u = fx * (camera[:, 0] / safe) + cx
    # Camera +Y is up and image +v is down, so y is negated. Dropping this puts every
    # projection on the wrong side of the horizon, which still looks like a picture.
    v = fy * (-camera[:, 1] / safe) + cy

    uv = np.stack([u, v], axis=1)
    valid = in_front & (u >= 0) & (u < width) & (v >= 0) & (v < height)
    return uv, depth, valid


def surface_basis(polygon: np.ndarray, normal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, tuple[float, float]]:
    """
    A 2D frame for one planar surface.

    Returns (corner, u_axis, v_axis, (width_m, height_m)). Texel (i, j) of this surface is
    at `corner + u*i_metres + v*j_metres`, so the atlas is metric by construction rather
    than by a scale factor applied later.
    """
    normal = normal / max(np.linalg.norm(normal), EPS)
    up = np.array([0.0, 1.0, 0.0])
    if abs(float(normal @ up)) > 0.9:
        # A floor or ceiling: lay the texture out in the horizontal plane.
        u_axis, v_axis = np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])
    else:
        # A wall: u runs along it horizontally, v is world up. Keeping v vertical means a
        # wall texture is never rotated relative to the room.
        u_axis = np.cross(up, normal)
        u_axis = u_axis / max(np.linalg.norm(u_axis), EPS)
        v_axis = up
    local = np.stack(
        [polygon @ u_axis, polygon @ v_axis], axis=1
    )
    lo = local.min(axis=0)
    hi = local.max(axis=0)
    # The polygon's own plane offset, so the corner sits exactly on the surface.
    plane_point = polygon[0]
    corner = (
        plane_point
        + u_axis * (lo[0] - float(plane_point @ u_axis))
        + v_axis * (lo[1] - float(plane_point @ v_axis))
    )
    return corner, u_axis, v_axis, (float(hi[0] - lo[0]), float(hi[1] - lo[1]))


def texel_points(
    corner: np.ndarray, u_axis: np.ndarray, v_axis: np.ndarray, cols: int, rows: int, metres_per_texel: float
) -> np.ndarray:
    """Room-space centre of every texel, row-major, shape (rows * cols, 3)."""
    i = (np.arange(cols) + 0.5) * metres_per_texel
    j = (np.arange(rows) + 0.5) * metres_per_texel
    grid_i, grid_j = np.meshgrid(i, j)
    return (
        corner
        + grid_i.reshape(-1, 1) * u_axis
        + grid_j.reshape(-1, 1) * v_axis
    )


def obb_blocks(
    eye: np.ndarray, points: np.ndarray, center: np.ndarray, size: np.ndarray, yaw: float,
    inflate: float, floor_skirt: float,
) -> np.ndarray:
    """
    Does the segment from `eye` to each point pass through this furniture volume?

    This is the geometric half of segmentation: a measured object's box is fixed in room
    space and the camera pose is known, so the occlusion test is exact and temporally
    stable, with no model involved. `inflate` and `floor_skirt` widen the box because
    RoomPlan under-estimates soft edges and because an object's contact shadow on the floor
    is the most visible tell once the object itself is gone.

    `center` is the BASE centre, matching the engine's `base_center` pivot.
    """
    half = size / 2.0
    half_inflated = half * (1.0 + inflate)
    # Grow downward to the floor rather than symmetrically: the skirt is about the shadow
    # the object casts where it meets the ground.
    lo_local = np.array([-half_inflated[0] - floor_skirt, -floor_skirt, -half_inflated[2] - floor_skirt])
    hi_local = np.array([half_inflated[0] + floor_skirt, size[1] * (1.0 + inflate), half_inflated[2] + floor_skirt])

    c, s = np.cos(-yaw), np.sin(-yaw)
    rotate = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])

    local_eye = rotate @ (eye - center)
    local_points = (rotate @ (points - center).T).T
    direction = local_points - local_eye

    # Slab test along the segment, clipped to t in [0, 1] so only the part between the eye
    # and the surface counts. A box behind the surface does not occlude it.
    t_near = np.zeros(len(points))
    t_far = np.ones(len(points))
    for axis in range(3):
        d = direction[:, axis]
        o = local_eye[axis]
        parallel = np.abs(d) < EPS
        with np.errstate(divide="ignore", invalid="ignore"):
            t1 = np.where(parallel, -np.inf, (lo_local[axis] - o) / d)
            t2 = np.where(parallel, np.inf, (hi_local[axis] - o) / d)
        lo_t = np.minimum(t1, t2)
        hi_t = np.maximum(t1, t2)
        outside = parallel & ((o < lo_local[axis]) | (o > hi_local[axis]))
        t_near = np.maximum(t_near, np.where(outside, np.inf, lo_t))
        t_far = np.minimum(t_far, np.where(outside, -np.inf, hi_t))
    return t_near <= t_far


def grazing_weight(points: np.ndarray, eye: np.ndarray, normal: np.ndarray) -> np.ndarray:
    """
    How much to trust a sample: head-on is worth more than edge-on.

    A texel seen at a grazing angle covers many pixels of blurred, foreshortened image, so
    weighting by the cosine keeps a square-on view from being washed out by a glancing one.
    """
    to_eye = eye - points
    lengths = np.linalg.norm(to_eye, axis=1)
    lengths = np.where(lengths < EPS, 1.0, lengths)
    cosine = (to_eye / lengths[:, None]) @ (normal / max(np.linalg.norm(normal), EPS))
    return np.clip(cosine, 0.0, 1.0)
