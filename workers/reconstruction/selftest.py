"""
Numerical self-check: `python3 workers/reconstruction/selftest.py`

Renders a synthetic room whose walls carry a known pattern, photographs it from six poses,
runs the real pipeline over those photographs, and asserts the atlas came back registered —
that a marker painted at a known place in the room lands at the corresponding texel.

Synthetic on purpose. A real capture proves the pipeline runs; only a scene whose ground
truth is known can prove it runs CORRECTLY, and a registration error of tens of
centimetres looks perfectly convincing in a photograph.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geometry import as_matrix, camera_in_room, project  # noqa: E402
from pipeline import reconstruct  # noqa: E402

W, H = 960, 720
FX = FY = 700.0
ORIGIN = np.array([7.3, 0.0, -4.1])
HALF = 2.0
CEIL = 2.5
MARKER = np.array([1.0, 1.25, HALF])       # on the north wall, right of centre
MARKER_RGB = (255, 32, 32)


def intrinsics() -> list[float]:
    return [FX, 0, 0, 0, FY, 0, W / 2, H / 2, 1]      # column-major


def look_at(eye: np.ndarray, target: np.ndarray) -> list[float]:
    forward = target - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, up, -forward, eye
    return m.T.flatten().tolist()


def surfaces() -> list[dict]:
    return [
        {"id": "floor", "class": "floor", "normal": [0, 1, 0], "inferred": False,
         "polygon": [[-HALF, 0, -HALF], [HALF, 0, -HALF], [HALF, 0, HALF], [-HALF, 0, HALF]]},
        {"id": "north", "class": "wall", "normal": [0, 0, -1], "inferred": False,
         "polygon": [[-HALF, 0, HALF], [HALF, 0, HALF], [HALF, CEIL, HALF], [-HALF, CEIL, HALF]]},
    ]


def render(eye: np.ndarray, target: np.ndarray, obstacle: dict | None) -> str:
    """Photograph the synthetic room: checkerboard walls, a red marker, an optional box."""
    image = np.zeros((H, W, 3), dtype=np.uint8)
    # Same world-space pose the keyframe metadata carries, converted the same way the
    # pipeline converts it. Building this from room-space eyes and then subtracting the
    # origin again put the camera metres outside the room and rendered pure black.
    c2r = camera_in_room(look_at(eye + ORIGIN, target + ORIGIN), ORIGIN)
    K = as_matrix(intrinsics(), 3)

    # Ray-cast every pixel against the floor and north wall. Slow, exact, and it means the
    # pipeline is fed real perspective rather than a warp of a flat image.
    ys, xs = np.mgrid[0:H, 0:W]
    ndc = np.stack([(xs - W / 2) / FX, -(ys - H / 2) / FY, -np.ones_like(xs, dtype=float)], axis=-1)
    dirs = (c2r[:3, :3] @ ndc.reshape(-1, 3).T).T
    dirs /= np.linalg.norm(dirs, axis=1)[:, None]
    eye_room = c2r[:3, 3]

    best = np.full(len(dirs), np.inf)
    colour = np.zeros((len(dirs), 3), dtype=np.uint8)
    for plane_point, plane_normal, axes, tint in (
        (np.array([0.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), (0, 2), (90, 140, 90)),
        (np.array([0.0, 0.0, HALF]), np.array([0.0, 0.0, -1.0]), (0, 1), (150, 150, 200)),
    ):
        denom = dirs @ plane_normal
        with np.errstate(divide="ignore", invalid="ignore"):
            t = ((plane_point - eye_room) @ plane_normal) / denom
        hit = (t > 0.05) & np.isfinite(t)
        points = eye_room + dirs * t[:, None]
        a, b = points[:, axes[0]], points[:, axes[1]]
        inside = (np.abs(a) <= HALF) & (b >= (0 if axes[1] == 1 else -HALF)) & (b <= (CEIL if axes[1] == 1 else HALF))
        hit &= inside & (t < best)
        # A 25cm checkerboard gives the projection something unambiguous to get wrong.
        check = ((np.floor(a * 4) + np.floor(b * 4)) % 2).astype(bool)
        base = np.where(check[:, None], np.array(tint), np.array(tint) // 2).astype(np.uint8)
        colour[hit] = base[hit]
        best[hit] = t[hit]

    # The marker: a 10cm patch on the north wall at a known room position.
    to_marker = MARKER - eye_room
    distance = np.linalg.norm(to_marker)
    uv, _, valid = project(MARKER[None, :], c2r, K, W, H)
    image = colour.reshape(H, W, 3).copy()
    if valid[0]:
        radius = max(2, int(0.05 * FY / distance))
        cv2.circle(image, (int(uv[0][0]), int(uv[0][1])), radius, MARKER_RGB, -1)

    if obstacle is not None:
        centre = np.array(obstacle["center"], dtype=float)
        size = np.array(obstacle["size"], dtype=float)
        corners = np.array([[sx * size[0] / 2, y, sz * size[2] / 2]
                            for sx in (-1, 1) for sz in (-1, 1) for y in (0, size[1])]) + centre
        cuv, _, cvalid = project(corners, c2r, K, W, H)
        if cvalid.any():
            hull = cv2.convexHull(np.clip(cuv, [0, 0], [W - 1, H - 1]).astype(np.int32).reshape(-1, 1, 2))
            cv2.fillConvexPoly(image, hull, (20, 20, 20))

    ok, buffer = cv2.imencode(".jpg", cv2.cvtColor(image, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def build_request(obstacle: dict | None) -> dict:
    eyes = [
        (np.array([0.0, 1.5, -1.2]), np.array([0.0, 1.2, HALF])),
        (np.array([-1.2, 1.5, -0.8]), np.array([0.5, 1.0, HALF])),
        (np.array([1.2, 1.5, -0.8]), np.array([-0.5, 1.0, HALF])),
        (np.array([0.0, 1.5, 0.5]), np.array([0.0, 0.0, 0.0])),
        (np.array([-1.0, 1.5, 0.5]), np.array([-0.5, 0.0, -0.5])),
        (np.array([1.0, 1.5, 0.5]), np.array([0.5, 0.0, -0.5])),
    ]
    return {
        "calibrationId": "selftest",
        "calibrationRevision": 0,
        "frameId": "frame-selftest",
        "room": {
            "origin": ORIGIN.tolist(),
            "surfaces": surfaces(),
            "obstacles": [obstacle] if obstacle else [],
        },
        "keyframes": [
            {
                "metadata": {
                    "id": f"00000000-0000-4000-8000-{index:012d}",
                    "timestamp": float(index),
                    "width": W, "height": H,
                    "frameId": "frame-selftest",
                    "cameraToWorld": look_at(eye + ORIGIN, target + ORIGIN),
                    "intrinsics": intrinsics(),
                },
                "jpegBase64": render(eye, target, obstacle),
            }
            for index, (eye, target) in enumerate(eyes)
        ],
    }


def main() -> int:
    failures = 0

    def check(label: str, ok: bool, detail: str) -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"  {'ok' if ok else 'NO'} {label} - {detail}")

    print("\nfurnished room")
    obstacle = {"id": "obj-bed", "center": [-0.9, 0.0, 0.6], "size": [1.4, 0.6, 2.0], "yaw": 0.0}
    dump = Path(__file__).resolve().parent / ".selftest-out"
    result = reconstruct(build_request(obstacle), dump)
    stages = result.stages
    check("the pipeline produced both artifacts",
          {a["key"] for a in result.assets} == {"atlas.png", "shell.json"},
          ", ".join(sorted(a["key"] for a in result.assets)))
    check("furniture was masked", stages["geometricPixels"] > 0, f"{stages['geometricPixels']} px")
    check("the floor was substantially observed", stages["coverage"]["floor"] > 0.3,
          f"{stages['coverage']['floor']:.0%} of the floor")
    check("the wall was substantially observed", stages["coverage"]["north"] > 0.3,
          f"{stages['coverage']['north']:.0%} of the wall")
    check("the removed object is named", result.manifest["removedObjectIds"] == ["obj-bed"],
          str(result.manifest["removedObjectIds"]))

    document = json.loads(base64.b64decode(
        next(a["dataBase64"] for a in result.assets if a["key"] == "shell.json")))
    atlas = cv2.cvtColor(cv2.imdecode(np.frombuffer(base64.b64decode(
        next(a["dataBase64"] for a in result.assets if a["key"] == "atlas.png")), np.uint8),
        cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)

    # THE REGISTRATION TEST.
    #
    # Maps the found texel back to room space using ONLY the shell document's own
    # positions and UVs — exactly the interpolation a renderer performs. Testing against
    # an assumed axis convention instead would only prove the test agrees with itself; a
    # first attempt did that and reported a 2m error that was entirely the test's, because
    # this wall's u axis runs toward -X.
    north = next(s for s in document["surfaces"] if s["id"] == "north")
    quad_uv = np.array(north["uvs"], dtype=float)
    quad_xyz = np.array(north["positions"], dtype=float)
    x0, x1 = int(quad_uv[:, 0].min() * atlas.shape[1]), int(quad_uv[:, 0].max() * atlas.shape[1])
    y0, y1 = int(quad_uv[:, 1].min() * atlas.shape[0]), int(quad_uv[:, 1].max() * atlas.shape[0])
    patch = atlas[y0:y1, x0:x1].astype(np.int32)
    redness = patch[:, :, 0] - (patch[:, :, 1] + patch[:, :, 2]) // 2
    ry, rx = np.unravel_index(int(np.argmax(redness)), redness.shape)

    found_uv = np.array([(x0 + rx + 0.5) / atlas.shape[1], (y0 + ry + 0.5) / atlas.shape[0]])
    # Corner 0 is the surface origin, 1 is +u, 3 is +v, matching shell_document.
    s_axis = (found_uv[0] - quad_uv[0][0]) / (quad_uv[1][0] - quad_uv[0][0])
    t_axis = (found_uv[1] - quad_uv[0][1]) / (quad_uv[3][1] - quad_uv[0][1])
    found = quad_xyz[0] + s_axis * (quad_xyz[1] - quad_xyz[0]) + t_axis * (quad_xyz[3] - quad_xyz[0])
    error = float(np.linalg.norm(found - MARKER))
    check("the marker is registered to its real position", error < 0.08,
          f"{error * 100:.1f}cm from ground truth, found {found.round(3)} want {MARKER}")
    check("the atlas is not blank", int(atlas.std()) > 5, f"stddev {atlas.std():.1f}")
    check("stage outputs were written for inspection",
          (dump / "atlas.png").exists() and any(dump.glob("mask-*.png")),
          f"{len(list(dump.glob('*.png')))} images in {dump.name}/")

    print("\nempty room")
    empty = reconstruct(build_request(None))
    check("an empty room reconstructs", len(empty.assets) == 2, f"{len(empty.assets)} assets")
    check("nothing is removed", empty.manifest["removedObjectIds"] == [], "no removals")
    check("no erase pass ran", empty.stages["maskNote"].startswith("empty room"),
          empty.stages["maskNote"])
    check("coverage improves without furniture in the way",
          empty.stages["coverage"]["floor"] >= stages["coverage"]["floor"],
          f"{empty.stages['coverage']['floor']:.0%} vs {stages['coverage']['floor']:.0%}")

    print(f"\n{'PASS' if failures == 0 else f'{failures} FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
