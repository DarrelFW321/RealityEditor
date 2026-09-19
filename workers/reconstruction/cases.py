"""
M8.5-A: the frozen evaluation case manifest.

An experiment that compares a candidate against a baseline is only meaningful if both
saw the same input. This freezes that input and hashes it, so a later run can prove it
scored the same thing rather than a room that drifted between attempts.

What gets hashed is the INPUT ONLY — room geometry, openings, the keyframe subset, the
panorama origin, the seeds, and the prompt. Not the baseline output, which is what the
candidate is being compared against and must be free to change when the baseline worker
is improved. A changed baseline invalidates scores; a changed input invalidates the
comparison itself, and the two failures deserve different alarms.

Deliberately emits no imagery and no camera frames. The manifest is safe to commit; the
media it refers to is not, and lives in approved temporary evidence storage.

Run: `python3 workers/reconstruction/cases.py [--out path]`
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "contracts" / "fixtures" / "rooms" / "captures"

# Predeclared before any result is seen, which is the point of writing them down here
# rather than choosing them at scoring time (M8.5-A.5).
SEEDS = (0, 1, 2)

PROMPT = (
    "An empty room interior with bare walls and bare floor. "
    "No furniture, no objects, no people, no text, no signage. "
    "Uniform even lighting, plain matte surfaces."
)


@dataclass
class Case:
    """One frozen evaluation case."""

    id: str
    purpose: str
    fixture: str
    # True once this case is backed by a real device capture. Every case ships synthetic
    # first, and scoring a synthetic case as visual evidence is explicitly not allowed.
    real_capture: bool = False
    notes: str = ""
    missing: list[str] = field(default_factory=list)


CASES: list[Case] = [
    Case(
        id="plain-empty",
        purpose="Plain empty room. Establishes the floor of the comparison: with almost "
        "no holes there is almost nothing for a candidate to add, and a candidate that "
        "still changes the image here is changing something it should not.",
        fixture="empty-room.capture.json",
        notes="Baseline completion has little to do; expect near-zero hole coverage.",
    ),
    Case(
        id="furnished-removable",
        purpose="Furnished room with removable furniture. The primary use case: the "
        "holes are exactly the wall and floor the furniture was standing in front of.",
        fixture="furnished-room.capture.json",
    ),
    Case(
        id="large-hidden-region",
        purpose="Patterned surface with a large hidden region. Tests whether a candidate "
        "continues a pattern or invents a different one; jump-flood cannot continue a "
        "pattern at all, so this is where a world model should win if it ever does.",
        fixture="furnished-room.capture.json",
        notes="Uses the furnished fixture until a patterned real capture exists.",
        missing=["a real capture with a patterned wall or floor"],
    ),
    Case(
        id="window-low-texture",
        purpose="Window, reflective or low-texture region. The failure case: an opening "
        "must not be filled with wall, and a blank wall must not gain invented detail.",
        fixture="low-confidence-wall.capture.json",
        missing=["a real capture with a window in the low-confidence wall"],
    ),
]


def _canonical(value: object) -> bytes:
    """Stable bytes for hashing: sorted keys, no incidental whitespace."""
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()[:16]


def freeze(case: Case) -> dict:
    """
    The recorded identity of one case.

    Hashes the room geometry and the openings separately from the whole fixture: a
    change to either one changes what a depth panorama looks like, and separating them
    says which moved when a hash stops matching.
    """
    path = FIXTURES / case.fixture
    if not path.exists():
        return {
            "id": case.id,
            "purpose": case.purpose,
            "status": "unavailable",
            "reason": f"fixture {case.fixture} is not in the repository",
            "missing": case.missing,
        }
    fixture = json.loads(path.read_text())
    surfaces = sorted(fixture.get("surfaces", []), key=lambda s: str(s.get("id")))
    objects = sorted(fixture.get("objects", []), key=lambda o: str(o.get("id")))
    openings = [s for s in surfaces if s.get("class") in ("window", "door", "opening")]

    return {
        "id": case.id,
        "purpose": case.purpose,
        "fixture": case.fixture,
        "status": "frozen",
        # Synthetic until a real capture replaces it. Recorded per case so a reader can
        # never mistake synthetic plumbing evidence for visual quality evidence.
        "capture": "real" if case.real_capture else "synthetic",
        "hashes": {
            "fixture": _digest(fixture),
            "surfaces": _digest(surfaces),
            "openings": _digest(openings),
            "objects": _digest(objects),
        },
        "counts": {
            "surfaces": len(surfaces),
            "openings": len(openings),
            "removableObjects": len(objects),
        },
        "seeds": list(SEEDS),
        "promptHash": _digest(PROMPT),
        "missing": case.missing,
        "notes": case.notes,
    }


def manifest() -> dict:
    frozen = [freeze(case) for case in CASES]
    ready = [c for c in frozen if c["status"] == "frozen"]
    return {
        "milestone": "M8.5-A",
        "generator": "workers/reconstruction/cases.py",
        "seeds": list(SEEDS),
        "prompt": PROMPT,
        "cases": frozen,
        # The hash a later run compares against. Covers every case identity at once, so
        # one number answers "did we score the same inputs".
        "manifestHash": _digest([c.get("hashes") for c in frozen]),
        "readiness": {
            "frozen": len(ready),
            "total": len(frozen),
            "realCaptures": sum(1 for c in ready if c.get("capture") == "real"),
            # Stated plainly, because the acceptance gate needs four scored cases and
            # synthetic ones cannot satisfy the visual-benefit gate.
            "blocking": sorted({m for c in frozen for m in c.get("missing", [])}),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze the M8.5 evaluation cases")
    parser.add_argument("--out", type=Path, help="write the manifest here as JSON")
    args = parser.parse_args()

    document = manifest()
    text = json.dumps(document, indent=2, sort_keys=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n")
        print(f"wrote {args.out}")
    else:
        print(text)

    readiness = document["readiness"]
    print(
        f"\n{readiness['frozen']}/{readiness['total']} cases frozen, "
        f"{readiness['realCaptures']} from real captures, manifest {document['manifestHash']}",
        file=sys.stderr,
    )
    for item in readiness["blocking"]:
        print(f"  still needed: {item}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
