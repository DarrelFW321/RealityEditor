#!/usr/bin/env python3
"""
Regenerates contracts/fixtures/ from a single description of the demo room.

The fixtures are checked in — you normally never run this. It exists because the
numbers in bedroom_4x4.rsg.json have to be mutually consistent (the occupancy RLE
has to match the object footprints, the SCP angular offsets have to match the
camera pose, the free-space summary has to match the grid) and hand-authoring
6400 occupancy cells is how you ship a fixture that quietly disagrees with itself
and burns an afternoon of the solver owner's time.

    python3 tools/make_fixtures.py

Room convention (see contracts/schema/rsg.schema.json):
  right-handed, Y-up, metres; origin at floor-polygon centroid on the floor plane.
  -Z is north. yaw is CCW about +Y measured from -Z. At yaw=0 an object faces north.
"""
import json, math, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(ROOT, "contracts", "fixtures")
R = 4

def rnd(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        return 0.0 + round(v, R)
    if isinstance(v, list):
        return [rnd(x) for x in v]
    if isinstance(v, dict):
        return {k: rnd(x) for k, x in v.items()}
    return v

def write(path, obj):
    full = os.path.join(FIX, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        json.dump(rnd(obj), f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"  wrote {path}")

# ---------------------------------------------------------------- room shape
W, D, CEIL = 4.0, 4.0, 2.5
HX, HZ = W / 2, D / 2
FLOOR_POLY = [[-HX, HZ], [HX, HZ], [HX, -HZ], [-HX, -HZ]]

def signed_area(poly):
    s = 0.0
    for i in range(len(poly)):
        x0, z0 = poly[i]
        x1, z1 = poly[(i + 1) % len(poly)]
        s += z0 * x1 - x0 * z1
    return 0.5 * s

assert signed_area(FLOOR_POLY) > 0, "floor polygon must be CCW about +Y"
AREA = abs(signed_area(FLOOR_POLY))

YAW_N, YAW_W, YAW_S, YAW_E = 0.0, math.pi / 2, math.pi, 3 * math.pi / 2

# dimensions are [width, height, depth] at yaw=0: width along local X, depth along local Z.
OBJECTS = [
    dict(id="obj_bed_01", cls="bed", refined="queen bed",
         pos=[-0.985, 0.0, -0.985], yaw=YAW_E, dims=[1.53, 0.6, 2.03],
         material="mat_linen_oat", asset="cat_bed_queen_01", movable=True, salience=0.9),
    dict(id="obj_table_01", cls="table", refined="writing desk",
         pos=[1.7, 0.0, -1.0], yaw=YAW_W, dims=[1.2, 0.75, 0.6],
         material="mat_oak_light", asset="cat_desk_oak_01", movable=True, salience=0.5),
    dict(id="obj_chair_01", cls="chair", refined="desk chair",
         pos=[0.75, 0.0, -1.0], yaw=YAW_E, dims=[0.5, 0.9, 0.5],
         material="mat_felt_grey", asset="cat_chair_felt_01", movable=True, salience=0.4),
]

def footprint(o):
    """World-space axis-aligned [x0,x1,z0,z1]. Every demo yaw is a multiple of 90deg
    so the footprint stays axis-aligned; a general solver must not assume this."""
    w, _, d = o["dims"]
    q = round(o["yaw"] / (math.pi / 2)) % 4
    ex, ez = (w, d) if q % 2 == 0 else (d, w)
    x, _, z = o["pos"]
    return [x - ex / 2, x + ex / 2, z - ez / 2, z + ez / 2]

def aabb(o):
    x0, x1, z0, z1 = footprint(o)
    return [x0, x1, o["pos"][1], o["pos"][1] + o["dims"][1], z0, z1]

for a in range(len(OBJECTS)):
    fx0, fx1, fz0, fz1 = footprint(OBJECTS[a])
    assert -HX - 1e-9 <= fx0 and fx1 <= HX + 1e-9, f"{OBJECTS[a]['id']} out of bounds in x"
    assert -HZ - 1e-9 <= fz0 and fz1 <= HZ + 1e-9, f"{OBJECTS[a]['id']} out of bounds in z"
    for b in range(a + 1, len(OBJECTS)):
        gx0, gx1, gz0, gz1 = footprint(OBJECTS[b])
        assert not (fx0 < gx1 - 1e-9 and gx0 < fx1 - 1e-9 and fz0 < gz1 - 1e-9 and gz0 < fz1 - 1e-9), \
            f"{OBJECTS[a]['id']} intersects {OBJECTS[b]['id']}"

# ---------------------------------------------------------------- occupancy
RES = 0.05
NX, NZ = int(round(W / RES)), int(round(D / RES))
ORIGIN = [-HX + RES / 2, -HZ + RES / 2]

def occupies(o, cx, cz, margin):
    """Cell-centre test in the object's LOCAL frame, mirroring
    SceneObject.footprintContains in Swift.

    TWO THINGS HERE ARE LOAD-BEARING.

    The rotation is the TRUE one, not the quadrant-snapped footprint above. And
    the yaw used is `round(yaw, R)` -- the value this script actually WRITES to
    the fixture, not the full-precision one it holds in memory. 3*pi/2 rounds to
    4.7124, which is 1.1e-5 radians away and moves a 2m footprint edge by ~1e-5m.
    Rasterising from the unrounded yaw produced a grid that no reader of the
    fixture could reproduce from the fixture's own numbers: a whole row of cells
    along the bed's edge disagreed, and it read as a bug in the Swift applier.

    The strict `<` with an epsilon keeps a cell centre sitting exactly on the
    expanded boundary OUT -- it overlaps the footprint by zero area."""
    w, _, d = o["dims"]
    yaw = round(o["yaw"], R)
    x, _, z = o["pos"]
    dx, dz = cx - round(x, R), cz - round(z, R)
    c, s_ = math.cos(yaw), math.sin(yaw)
    lx = c * dx - s_ * dz
    lz = s_ * dx + c * dz
    eps = 1e-9
    return abs(lx) < w / 2 + margin - eps and abs(lz) < d / 2 + margin - eps

def build_grid():
    g = [0] * (NX * NZ)
    for o in OBJECTS:
        for jz in range(NZ):
            cz = ORIGIN[1] + jz * RES
            for ix in range(NX):
                cx = ORIGIN[0] + ix * RES
                if occupies(o, cx, cz, RES / 2):
                    g[jz * NX + ix] = 1
    return g

def rle(g):
    """Run lengths, row-major (x fastest), ALTERNATING starting with FREE.
    A leading 0 encodes a grid that starts occupied."""
    out, cur, run = [], 0, 0
    for v in g:
        if v == cur:
            run += 1
        else:
            out.append(run); cur = v; run = 1
    out.append(run)
    assert sum(out) == len(g)
    back, val = [], 0
    for r in out:
        back.extend([val] * r); val ^= 1
    assert back == g, "RLE round-trip failed"
    return out

GRID = build_grid()
GRID_RLE = rle(GRID)
print(f"  occupancy {NX}x{NZ}={NX*NZ} cells, {sum(GRID)} occupied, {len(GRID_RLE)} runs")

def largest_open_rect():
    """Maximal axis-aligned free rectangle, via largest-rectangle-in-histogram per row."""
    heights = [0] * NX
    best = (0, None)
    for jz in range(NZ):
        for ix in range(NX):
            heights[ix] = 0 if GRID[jz * NX + ix] else heights[ix] + 1
        stack = []
        for ix in range(NX + 1):
            h = heights[ix] if ix < NX else 0
            start = ix
            while stack and stack[-1][1] >= h:
                s, sh = stack.pop()
                area = sh * (ix - s)
                if area > best[0]:
                    best = (area, (s, ix, jz - sh + 1, jz))
                start = s
            stack.append((start, h))
    _, (x0, x1, z0, z1) = best
    cx = ORIGIN[0] + (x0 + x1 - 1) / 2 * RES
    cz = ORIGIN[1] + (z0 + z1) / 2 * RES
    return dict(center=[cx, cz], size=[(x1 - x0) * RES, (z1 - z0 + 1) * RES], yaw=0.0)

def wall_clearances():
    """Mean free depth measured perpendicularly inward from each wall face, averaged
    over the wall's cells. Mean rather than min: a single touching object would drive
    min to zero and tell the planner nothing useful."""
    def depth_along(cells):
        tot = 0.0
        for run in cells:
            n = 0
            for occupied in run:
                if occupied:
                    break
                n += 1
            tot += n * RES
        return tot / len(cells)
    north = [[GRID[jz * NX + ix] for jz in range(NZ)] for ix in range(NX)]
    south = [[GRID[jz * NX + ix] for jz in reversed(range(NZ))] for ix in range(NX)]
    west = [[GRID[jz * NX + ix] for ix in range(NX)] for jz in range(NZ)]
    east = [[GRID[jz * NX + ix] for ix in reversed(range(NX))] for jz in range(NZ)]
    return [
        dict(surface_id="srf_wall_north", free_depth_m=depth_along(north)),
        dict(surface_id="srf_wall_south", free_depth_m=depth_along(south)),
        dict(surface_id="srf_wall_east", free_depth_m=depth_along(east)),
        dict(surface_id="srf_wall_west", free_depth_m=depth_along(west)),
    ]

FREE_SPACE = dict(largest_open_rect=largest_open_rect(), wall_clearances=wall_clearances())
print(f"  largest open rect {FREE_SPACE['largest_open_rect']}")

# ---------------------------------------------------------------- surfaces
def wall(sid, normal, offset, poly, material):
    return dict(id=sid, **{"class": "wall"}, provenance="real", state="present",
                plane=dict(normal=normal, offset=offset), polygon=poly,
                material_ref=material, parent=None, swing=None)

SURFACES = [
    wall("srf_wall_north", [0, 0, 1], -HZ,
         [[-HX, 0, -HZ], [HX, 0, -HZ], [HX, CEIL, -HZ], [-HX, CEIL, -HZ]], "mat_paint_warm_white"),
    wall("srf_wall_south", [0, 0, -1], -HZ,
         [[HX, 0, HZ], [-HX, 0, HZ], [-HX, CEIL, HZ], [HX, CEIL, HZ]], "mat_paint_warm_white"),
    wall("srf_wall_east", [-1, 0, 0], -HX,
         [[HX, 0, -HZ], [HX, 0, HZ], [HX, CEIL, HZ], [HX, CEIL, -HZ]], "mat_paint_warm_white"),
    wall("srf_wall_west", [1, 0, 0], -HX,
         [[-HX, 0, HZ], [-HX, 0, -HZ], [-HX, CEIL, -HZ], [-HX, CEIL, HZ]], "mat_paint_warm_white"),
    dict(id="srf_floor", **{"class": "floor"}, provenance="real", state="present",
         plane=dict(normal=[0, 1, 0], offset=0.0),
         polygon=[[-HX, 0, HZ], [HX, 0, HZ], [HX, 0, -HZ], [-HX, 0, -HZ]],
         material_ref="mat_oak_floor", parent=None, swing=None),
    dict(id="srf_ceiling", **{"class": "ceiling"}, provenance="real", state="present",
         plane=dict(normal=[0, -1, 0], offset=-CEIL),
         polygon=[[-HX, CEIL, -HZ], [HX, CEIL, -HZ], [HX, CEIL, HZ], [-HX, CEIL, HZ]],
         material_ref="mat_paint_ceiling", parent=None, swing=None),
    dict(id="srf_window_north", **{"class": "window"}, provenance="real", state="present",
         plane=dict(normal=[0, 0, 1], offset=-HZ),
         polygon=[[-0.7, 0.9, -HZ], [0.7, 0.9, -HZ], [0.7, 2.1, -HZ], [-0.7, 2.1, -HZ]],
         material_ref="mat_glass_clear", parent="srf_wall_north", swing=None),
    dict(id="srf_door_east", **{"class": "door"}, provenance="real", state="present",
         plane=dict(normal=[-1, 0, 0], offset=-HX),
         polygon=[[HX, 0, 0.07], [HX, 0, 0.93], [HX, 2.03, 0.93], [HX, 2.03, 0.07]],
         material_ref="mat_paint_door", parent="srf_wall_east",
         swing=dict(hinge="left", direction="inward", arc_radius=0.86)),
]

def mk_object(o):
    return dict(id=o["id"], **{"class": o["cls"]}, refined_class=o["refined"],
                provenance="real", state="present",
                pose=dict(position=o["pos"], yaw=o["yaw"]),
                dimensions=o["dims"], pivot="base_center",
                material_ref=o["material"], asset_ref=o["asset"],
                movable=o["movable"], salience=o["salience"])

# Relations are a CACHE, not an authored fact -- rsg.schema.json says so, and
# RSG.recomputingRelations() rewrites this array after every applied op. So the
# content AND THE ORDER here have to be exactly what that function produces, or
# the first op silently rewrites the fixture and `testUndoIsExact` can never be
# byte-exact again.
#
# Sorted by (subject, predicate, object). `adjacent_to` is symmetric and is
# recorded once, in id order; `in_front_of` is recorded in the direction whose
# anchor faces the subject more squarely, ties broken by id.
#
# SpatialCoreTests.RelationsTests asserts these agree. If you change either
# side, run that test before trusting this list.
RELATIONS = [
    dict(subject="obj_bed_01", predicate="against_wall", object="srf_wall_west", distance=0.0),
    dict(subject="obj_chair_01", predicate="adjacent_to", object="obj_table_01", distance=0.4),
    dict(subject="obj_chair_01", predicate="in_front_of", object="obj_table_01", distance=0.4),
    dict(subject="obj_table_01", predicate="against_wall", object="srf_wall_east", distance=0.0),
]

RSG = dict(
    room_id="01J8X4Q2K7B9N3M5P6R8T0V2W4",
    version=0,
    frame=dict(world_transform=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
               up=[0, 1, 0], units="m"),
    bounds=dict(floor_polygon=FLOOR_POLY, ceiling_height=CEIL, area_m2=AREA),
    surfaces=SURFACES,
    objects=[mk_object(o) for o in OBJECTS],
    relations=RELATIONS,
    occupancy=dict(resolution_m=RES, origin=ORIGIN, size=[NX, NZ], grid_rle=GRID_RLE),
    lighting=dict(preset="measured", intensity=850.0, ambient_cct=4200.0),
)

# ---------------------------------------------------------------- SCP geometry
ROOM = {o["id"]: dict(box=aabb(o), cls=o["refined"], salience=o["salience"]) for o in OBJECTS}
ROOM["srf_window_north"] = dict(box=[-0.7, 0.7, 0.9, 2.1, -HZ - 0.01, -HZ + 0.01],
                                cls="window", salience=0.3)
ROOM["srf_door_east"] = dict(box=[HX - 0.01, HX + 0.01, 0.0, 2.03, 0.07, 0.93],
                             cls="door", salience=0.2)

def centre(b): return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]
def sub(a, b): return [a[i] - b[i] for i in range(3)]
def norm(a): return math.sqrt(sum(c * c for c in a))
def unit(a):
    n = norm(a); return [c / n for c in a]
def dot(a, b): return sum(a[i] * b[i] for i in range(3))
def angle_deg(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b))))))

def forward_from(yaw, pitch):
    cp = math.cos(pitch)
    return [-math.sin(yaw) * cp, math.sin(pitch), -math.cos(yaw) * cp]

def ray_aabb(o, d, b):
    t0, t1 = 0.0, float("inf")
    for i, (lo, hi) in enumerate(((b[0], b[1]), (b[2], b[3]), (b[4], b[5]))):
        if abs(d[i]) < 1e-9:
            if o[i] < lo or o[i] > hi:
                return None
            continue
        ta, tb = (lo - o[i]) / d[i], (hi - o[i]) / d[i]
        if ta > tb: ta, tb = tb, ta
        t0, t1 = max(t0, ta), min(t1, tb)
        if t0 > t1:
            return None
    return t0

def first_hit(o, d, table):
    best = (None, None)
    for eid, e in table.items():
        t = ray_aabb(o, d, e["box"])
        if t is not None and (best[1] is None or t < best[1]):
            best = (eid, t)
    return best

def floor_hit(o, d):
    if d[1] >= -1e-9:
        return None
    t = -o[1] / d[1]
    p = [o[i] + d[i] * t for i in range(3)]
    if -HX <= p[0] <= HX and -HZ <= p[2] <= HZ:
        return p, t
    return None

FOV = 68.0

def screen_area_frac(b, cam):
    c = centre(b)
    dist = max(0.3, norm(sub(c, cam)))
    w = max(b[1] - b[0], b[5] - b[4])
    h = b[3] - b[2]
    view_w = 2 * dist * math.tan(math.radians(FOV) / 2)
    return max(0.0, min(1.0, (w * h) / (view_w * view_w * 4 / 3)))

def score(ang, area, salience, recency):
    """Mirrors the weighting Deixis/Scorer.swift is specified to implement. If the
    Swift weights change, change them here too and regenerate."""
    return max(0.0, min(1.0, 0.55 * math.exp(-(ang / 12.0) ** 2)
                             + 0.20 * min(area / 0.25, 1.0)
                             + 0.15 * salience
                             + 0.10 * recency))

def search_camera(table, targets):
    """Find a camera pose where the named entities land near the requested angular
    offsets and the crosshair actually hits the first one. Random seed + local refine,
    so the fixture is reproducible."""
    rng = random.Random(20260918)
    primary = list(targets.keys())[0]

    def err_of(cam, yaw, pitch):
        fwd = forward_from(yaw, pitch)
        hid, _ = first_hit(cam, fwd, table)
        if hid != primary:
            return None, None
        e = sum((angle_deg(sub(centre(table[k]["box"]), cam), fwd) - v) ** 2
                for k, v in targets.items())
        return e, fwd

    best, best_err = None, float("inf")
    for _ in range(120000):
        cam = [rng.uniform(-HX + 0.3, HX - 0.3), rng.uniform(1.35, 1.65),
               rng.uniform(-HZ + 0.3, HZ - 0.3)]
        if any(e["box"][0] < cam[0] < e["box"][1] and e["box"][4] < cam[2] < e["box"][5]
               for e in table.values()):
            continue
        yaw, pitch = rng.uniform(0, 2 * math.pi), rng.uniform(-0.5, 0.1)
        e, _ = err_of(cam, yaw, pitch)
        if e is not None and e < best_err:
            best_err, best = e, (cam, yaw, pitch)
    assert best is not None, "no camera pose hit the primary target"

    step = 0.25
    cam, yaw, pitch = best
    for _ in range(6000):
        c2 = [cam[0] + rng.uniform(-step, step), cam[1] + rng.uniform(-step / 4, step / 4),
              cam[2] + rng.uniform(-step, step)]
        if not (-HX + 0.25 < c2[0] < HX - 0.25 and -HZ + 0.25 < c2[2] < HZ - 0.25):
            continue
        if any(e["box"][0] < c2[0] < e["box"][1] and e["box"][4] < c2[2] < e["box"][5]
               for e in table.values()):
            continue
        y2, p2 = yaw + rng.uniform(-step / 4, step / 4), pitch + rng.uniform(-step / 8, step / 8)
        e, _ = err_of(c2, y2, p2)
        if e is not None and e < best_err:
            best_err, cam, yaw, pitch = e, c2, y2, p2
        step *= 0.9995
    return cam, forward_from(yaw, pitch), math.sqrt(best_err / len(targets))

# ------------------------------------------------------- pointing ray (deixis)
# Mirrors CameraBasis.direction(through:) in Deixis/Pointing.swift. Two
# independent implementations of the same pinhole model is the point: the Swift
# test asserts against these baked numbers, so a sign error in either one shows
# up as a failing test rather than as a crosshair that is subtly off.
#
# ASPECT: every pointing fixture keeps the fingertip on the horizontal centre
# line (y = 0.5). That makes ndc_y zero, which drops the aspect term out of the
# maths entirely — so these fixtures stay valid whatever viewport the app
# actually reports, and a test can check them without hardcoding a phone model.
POINTING_PHONE = dict(screen_point=[0.5, 0.5], confidence=1.0, source="phone")

def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]

def camera_basis(fwd):
    """Right and up axes for a forward direction, world up = +Y."""
    right = unit(cross(fwd, [0.0, 1.0, 0.0]))
    up = unit(cross(right, fwd))
    return right, up

def ray_through(screen_point, cam_fwd, fov_deg, aspect=0.4613):
    """Room-space direction of the ray through a viewport point."""
    right, up = camera_basis(cam_fwd)
    ndc_x = 2 * screen_point[0] - 1
    ndc_y = 1 - 2 * screen_point[1]
    tan_h = math.tan(math.radians(fov_deg) / 2)
    tan_v = tan_h / aspect
    d = [right[i] * (ndc_x * tan_h) + up[i] * (ndc_y * tan_v) + cam_fwd[i]
         for i in range(3)]
    return unit(d)

def build_scp(table, cam, fwd, t_ms, salience_stack, last_tap, demonstrative,
              free_space, floor_pt=None, floor_age=None, n_cands=5,
              pointing=None):
    # The DEIXIS ray, which is the camera forward only when the source is the
    # phone. Every angular offset below is measured against this, not `fwd` --
    # `fwd` still describes where the camera looks and still drives the
    # crosshair_ray hit.
    pointing = dict(POINTING_PHONE) if pointing is None else dict(pointing)
    ray = ray_through(pointing["screen_point"], fwd, FOV)

    hid, ht = first_hit(cam, ray, table)
    if hid is None:
        fh = floor_hit(cam, ray)
        hit_type, hit_point, hit_dist = ("floor", fh[0], fh[1]) if fh else ("none", None, None)
    else:
        hit_type = "object" if hid.startswith("obj_") else "surface"
        hit_point = [cam[i] + ray[i] * ht for i in range(3)]
        hit_dist = ht

    vis = []
    for eid, e in table.items():
        c = centre(e["box"])
        ang = angle_deg(sub(c, cam), ray)
        if ang > FOV:
            continue
        h, _ = first_hit(cam, unit(sub(c, cam)), table)
        vis.append(dict(id=eid, **{"class": e["cls"]}, angular_offset_deg=ang,
                        distance_m=norm(sub(c, cam)),
                        screen_area_frac=screen_area_frac(e["box"], cam),
                        salience=e["salience"],
                        occluded=(h is not None and h != eid)))
    vis.sort(key=lambda v: (v["angular_offset_deg"], v["id"]))
    vis = vis[:12]

    cands = []
    for v in vis[:n_cands]:
        rec = (1.0 - salience_stack.index(v["id"]) / len(salience_stack)
               if v["id"] in salience_stack else 0.0)
        cands.append(dict(entity_id=v["id"], demonstrative=demonstrative,
                          score=score(v["angular_offset_deg"], v["screen_area_frac"],
                                      table[v["id"]]["salience"], rec)))
    cands.sort(key=lambda c: -c["score"])

    if floor_pt is None:
        fh = floor_hit(cam, ray)
        floor_pt, floor_age = (fh[0], 0) if fh else (None, 0)
    return dict(t=t_ms,
                camera=dict(position=cam, forward=fwd, fov_deg=FOV),
                crosshair_ray=dict(hit_entity=hid, hit_point=hit_point,
                                   hit_distance_m=hit_dist, hit_type=hit_type),
                pointing_ray=pointing,
                last_floor_hit=dict(point=floor_pt, age_ms=floor_age),
                last_tap=dict(entity=last_tap[0], age_ms=last_tap[1]),
                visible_entities=vis, salience_stack=salience_stack,
                ranked_candidates=cands, free_space_summary=free_space)

print("searching for pointing_at_bed camera pose...")
cam, fwd, rms = search_camera(ROOM, {"obj_bed_01": 4.0, "srf_window_north": 22.0,
                                     "obj_table_01": 38.0})
print(f"  rms angular error {rms:.2f} deg")
SCP_BED = build_scp(ROOM, cam, fwd, 1758153600000.0,
                    ["obj_bed_01", "srf_window_north"], (None, 0), "that", FREE_SPACE)
for v in SCP_BED["visible_entities"]:
    print(f"    {v['id']:<20} {v['angular_offset_deg']:6.2f} deg  {v['distance_m']:.2f} m")

# ------------------------------------------------- ambiguous two chairs
# Standalone packet. Its entity ids are deliberately NOT from bedroom_4x4: it
# exercises Deixis/Scorer.swift's tie path, which needs no RSG at all.
# The two chairs are near-symmetric but not identical — a perfect tie is an input
# the real world never produces and would let a broken scorer pass.
TWO = {
    "obj_chair_left":  dict(box=[-0.70, -0.18, 0.0, 0.92, -0.74, -0.22], cls="chair", salience=0.45),
    "obj_chair_right": dict(box=[0.22, 0.72, 0.0, 0.88, -0.70, -0.24], cls="chair", salience=0.40),
    "obj_table_02":    dict(box=[-0.55, 0.55, 0.0, 0.74, -1.60, -1.00], cls="dining table", salience=0.5),
}
TWO_CAM = [0.02, 1.48, 1.55]
TWO_FWD = unit([-0.01, -0.30, -1.0])
AMB = build_scp(TWO, TWO_CAM, TWO_FWD, 1758153742000.0, ["obj_table_02"], (None, 0),
                "that", FREE_SPACE, n_cands=3)
AMB["ranked_candidates"] = [c for c in AMB["ranked_candidates"] if c["entity_id"].endswith(("left", "right"))]
gap = abs(AMB["ranked_candidates"][0]["score"] - AMB["ranked_candidates"][1]["score"])
print(f"ambiguous_two_chairs: top-2 score gap {gap:.4f} (needs 0 < gap < 0.1)")
assert 0.0 < gap < 0.1, "fixture must be ambiguous but not a degenerate tie"

# ------------------------------------------- the same two chairs, but POINTED AT
# The hand-tracking fixture, and the tightest test in the set: identical room,
# identical camera pose, identical everything -- the ONLY difference from
# ambiguous_two_chairs is that the pointing ray comes from a fingertip left of
# centre instead of the screen centre.
#
# That one change has to turn a packet the scorer must call ambiguous into one
# where the left chair wins outright. If it does not, the pointing ray is not
# actually reaching the deixis score and hand tracking is decorative.
#
# y = 0.5 keeps the fingertip on the horizontal centre line so the aspect ratio
# drops out of the maths -- see the note by ray_through.
HAND = dict(screen_point=[0.33, 0.5], confidence=0.91, source="hand")
POINTED = build_scp(TWO, TWO_CAM, TWO_FWD, 1758153744000.0, ["obj_table_02"], (None, 0),
                    "that", FREE_SPACE, n_cands=3, pointing=HAND)
POINTED["ranked_candidates"] = [c for c in POINTED["ranked_candidates"]
                                if c["entity_id"].endswith(("left", "right"))]
p_gap = abs(POINTED["ranked_candidates"][0]["score"] - POINTED["ranked_candidates"][1]["score"])
print(f"pointing_at_left_chair: winner {POINTED['ranked_candidates'][0]['entity_id']}, "
      f"top-2 gap {p_gap:.4f} (needs > 0.1)")
assert POINTED["ranked_candidates"][0]["entity_id"] == "obj_chair_left", \
    "the fingertip points left; the left chair must win"
assert p_gap > 0.1, "pointing must RESOLVE the ambiguity, not merely lean"
assert POINTED["crosshair_ray"]["hit_entity"] == "obj_chair_left", \
    "the pointing ray, not the camera forward, drives the hit"

write("rooms/bedroom_4x4.rsg.json", RSG)
write("scp/pointing_at_bed.json", SCP_BED)
write("scp/ambiguous_two_chairs.json", AMB)
write("scp/pointing_at_left_chair.json", POINTED)

# ---------------------------------------------------------------- session log
def ulid(n):
    """Deterministic stand-in for a real ULID. Crockford base32, 26 chars."""
    alpha = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    rng = random.Random(1000 + n)
    return "01J8X4Q2K7" + "".join(rng.choice(alpha) for _ in range(16))

def op(n, seq, typ, targets, params, inverse, utt, transcript, rep, t):
    return dict(op_id=ulid(n), seq=seq, branch_id="br_main", type=typ,
                target_ids=targets, params=params, inverse=inverse,
                caused_by=dict(utterance_id=utt, transcript=transcript, source="voice"),
                constraint_report=rep, client_ts=t, applied_ts=t + 180.0)

def rep(status, applied, requested, reason, dist, resolved=(), notes=(), alts=()):
    return dict(status=status, applied_pose=applied, requested_pose=requested,
                adjustment_reason=reason, adjustment_distance_m=dist,
                violations_resolved=list(resolved), remaining_notes=list(notes),
                alternatives=list(alts))

T0 = 1758153600000.0
frames = []

def frame(dir_, typ, t, **payload):
    f = dict(dir=dir_, type=typ, t=t); f.update(payload); frames.append(f)

def turn(t, hint, ops, speech, scp):
    frame("client_to_server", "context", t - 900, context=scp)
    frame("client_to_server", "audio", t - 850,
          audio=dict(pcm_b64="", sample_rate=24000, channels=1))
    frame("client_to_server", "context", t - 400, context=scp)
    frame("server_to_client", "hint", t + 310, hint=hint)
    frame("server_to_client", "ops", t + 620, ops=ops)
    for o in ops:
        frame("client_to_server", "applied", t + 790, applied=o)
    frame("server_to_client", "speech", t + 840,
          speech=dict(text=speech, audio_b64=None, final=True))

bed_from = dict(position=OBJECTS[0]["pos"], yaw=OBJECTS[0]["yaw"])
bed_under_window = dict(position=[0.0, 0.0, -0.985], yaw=YAW_S)

# 1 — the headline move: intent in, solver adjusts, model narrates the adjustment.
turn(T0, dict(kind="highlight", entity_ids=["obj_bed_01", "srf_window_north"], text="the bed"),
     [op(1, 1, "MOVE_OBJECT", ["obj_bed_01"],
         dict(relation="under", anchor_id="srf_window_north"),
         dict(type="MOVE_OBJECT", target_ids=["obj_bed_01"],
              params=dict(relation="absolute", position=bed_from["position"], yaw=bed_from["yaw"])),
         "utt_01", "move the bed under the window",
         rep("adjusted", bed_under_window, dict(position=[0.28, 0.0, -0.985], yaw=YAW_S),
             "the window is off-centre and the bed looked lopsided under it", 0.28,
             resolved=[dict(type="blocks_walkway", **{"with": "srf_door_east"}, overlap_m=0.12)],
             notes=[dict(type="clearance", side="left", value_m=0.68, recommended_m=0.76)]),
         T0)],
     "Done — it's centred under the window. I nudged it 28 centimetres right so the "
     "walkway to the door stays clear.", SCP_BED)

# 2 — anaphora: "it" resolves off the salience stack, no geometry needed.
turn(T0 + 9000, dict(kind="highlight", entity_ids=["obj_bed_01"], text="rotating"),
     [op(2, 2, "ROTATE_OBJECT", ["obj_bed_01"], dict(face_anchor_id="srf_door_east"),
         dict(type="ROTATE_OBJECT", target_ids=["obj_bed_01"], params=dict(yaw=YAW_S)),
         "utt_02", "turn it to face the door",
         rep("applied", dict(position=bed_under_window["position"], yaw=YAW_E),
             dict(position=bed_under_window["position"], yaw=YAW_E), None, 0.0), T0 + 9000)],
     "Turned.", SCP_BED)

# 3 — deixis: the crosshair is on the chair.
turn(T0 + 17000, dict(kind="highlight", entity_ids=["obj_chair_01"], text="the desk chair"),
     [op(3, 3, "DELETE_OBJECT", ["obj_chair_01"], {},
         dict(type="ADD_OBJECT", target_ids=["obj_chair_01"],
              params=dict(object=mk_object(OBJECTS[2]), relation="absolute")),
         "utt_03", "delete that chair", rep("applied", None, None, None, 0.0), T0 + 17000)],
     "Gone.", SCP_BED)

# 4 — "over there": resolves against last_floor_hit, not the current frame. The phone
#     has already swept 620ms past the spot by the time speech ends. This is the whole
#     reason the SCP samples at 10Hz instead of once per turn.
SCP_THERE = json.loads(json.dumps(SCP_BED))
SCP_THERE["t"] = T0 + 26000
SCP_THERE["last_floor_hit"] = dict(point=[0.85, 0.0, 0.15], age_ms=620)
SCP_THERE["salience_stack"] = ["obj_chair_01", "obj_bed_01", "srf_window_north"]
turn(T0 + 26000, dict(kind="thinking", entity_ids=None, text="finding a rug"),
     [op(4, 4, "ADD_OBJECT", ["obj_rug_01"],
         dict(catalog_id="cat_rug_wool_01", relation="absolute", position=[0.85, 0.0, 0.15]),
         dict(type="DELETE_OBJECT", target_ids=["obj_rug_01"], params={}),
         "utt_04", "put a rug over there",
         rep("applied", dict(position=[0.85, 0.0, 0.15], yaw=0.0),
             dict(position=[0.85, 0.0, 0.15], yaw=0.0), None, 0.0), T0 + 26000)],
     "There's your rug.", SCP_THERE)

# 5 — exact undo: replay of the stored inverse, never a recomputation.
turn(T0 + 34000, dict(kind="thinking", entity_ids=None, text="undoing"),
     [op(5, 5, "UNDO", ["obj_rug_01"], dict(undo_op_id=ulid(4)), None,
         "utt_05", "actually undo that", rep("applied", None, None, None, 0.0), T0 + 34000)],
     "Undone.", SCP_THERE)

# 6 — style: one utterance expands to a batch on the server, off the critical path.
style_ops = []
for i, (tgt, mat) in enumerate([("srf_wall_north", "mat_paint_chalk"),
                                ("srf_wall_south", "mat_paint_chalk"),
                                ("srf_wall_east", "mat_paint_chalk"),
                                ("srf_wall_west", "mat_paint_chalk"),
                                ("srf_floor", "mat_ash_pale")]):
    old = next(s["material_ref"] for s in SURFACES if s["id"] == tgt)
    style_ops.append(op(10 + i, 6 + i, "CHANGE_MATERIAL", [tgt],
                        dict(material_ref=mat, style_batch_id="sty_scandi_01"),
                        dict(type="CHANGE_MATERIAL", target_ids=[tgt],
                             params=dict(material_ref=old, style_batch_id="sty_scandi_01")),
                        "utt_06", "make it scandinavian",
                        rep("applied", None, None, None, 0.0), T0 + 42000))
turn(T0 + 42000, dict(kind="thinking", entity_ids=None, text="planning a theme"), style_ops,
     "Pale ash floor, chalk walls, and I swapped the linen for undyed cotton.", SCP_THERE)

path = os.path.join(FIX, "sessions", "demo_script.jsonl")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    for fr in frames:
        f.write(json.dumps(rnd(fr), sort_keys=True) + "\n")
print(f"  wrote sessions/demo_script.jsonl ({len(frames)} frames, 6 turns)")
