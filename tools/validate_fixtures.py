#!/usr/bin/env python3
"""
Validates every file in contracts/fixtures/ against contracts/schema/.

    python3 tools/validate_fixtures.py

A fixture that has drifted from its schema is worse than no fixture: it is a
green test that proves nothing. Run this in CI and after any schema edit.
Exits non-zero on the first failure of each file, printing the JSON path.
"""
import json, os, sys
from jsonschema import Draft7Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT7

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA_DIR = os.path.join(ROOT, "contracts", "schema")
FIX_DIR = os.path.join(ROOT, "contracts", "fixtures")

def load(p):
    with open(p) as f:
        return json.load(f)

SCHEMAS = {n: load(os.path.join(SCHEMA_DIR, n))
           for n in sorted(os.listdir(SCHEMA_DIR)) if n.endswith(".json")}
# Cross-file $refs ("op.schema.json", "rsg.schema.json#/definitions/SceneObject")
# resolve against each schema's relative $id, so every schema is registered under
# both its bare filename and its declared $id.
REGISTRY = Registry().with_resources(
    [(uri, Resource.from_contents(s, default_specification=DRAFT7))
     for n, s in SCHEMAS.items() for uri in {n, s.get("$id", n)}]
)

def validator_for(name):
    return Draft7Validator(SCHEMAS[name], registry=REGISTRY)

# fixture path (relative to contracts/fixtures) -> schema file; ".jsonl" validates line by line
CASES = [
    ("rooms/bedroom_4x4.rsg.json", "rsg.schema.json"),
    ("scp/pointing_at_bed.json", "scp.schema.json"),
    ("scp/ambiguous_two_chairs.json", "scp.schema.json"),
    ("scp/pointing_at_left_chair.json", "scp.schema.json"),
    ("sessions/demo_script.jsonl", "ws_frames.schema.json"),
]

def report(label, validator, doc):
    errs = sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    if not errs:
        return 0
    for e in errs[:5]:
        path = "/".join(str(p) for p in e.absolute_path) or "<root>"
        print(f"  FAIL {label} at {path}: {e.message}", file=sys.stderr)
    if len(errs) > 5:
        print(f"  ... and {len(errs) - 5} more", file=sys.stderr)
    return 1

def main():
    # Every schema must itself be a legal draft-07 schema.
    bad = 0
    for name, schema in SCHEMAS.items():
        try:
            Draft7Validator.check_schema(schema)
            print(f"  schema ok   {name}")
        except Exception as exc:
            print(f"  SCHEMA INVALID {name}: {exc}", file=sys.stderr)
            bad = 1
    if bad:
        return bad

    # Every op embedded anywhere in the session log must also satisfy op.schema.json.
    op_v = validator_for("op.schema.json")

    for rel, schema_name in CASES:
        path = os.path.join(FIX_DIR, rel)
        if not os.path.exists(path):
            print(f"  MISSING {rel}", file=sys.stderr)
            bad = 1
            continue
        v = validator_for(schema_name)
        if rel.endswith(".jsonl"):
            n_frames = n_ops = 0
            with open(path) as f:
                for i, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    doc = json.loads(line)
                    n_frames += 1
                    bad |= report(f"{rel}:{i}", v, doc)
                    for o in (doc.get("ops") or []):
                        n_ops += 1
                        bad |= report(f"{rel}:{i} ops[]", op_v, o)
                    if doc.get("applied"):
                        n_ops += 1
                        bad |= report(f"{rel}:{i} applied", op_v, doc["applied"])
            print(f"  fixture ok  {rel}  ({n_frames} frames, {n_ops} embedded ops)")
        else:
            bad |= report(rel, v, load(path))
            if not bad:
                print(f"  fixture ok  {rel}")
    return bad

if __name__ == "__main__":
    code = main()
    print("validate_fixtures: " + ("FAILED" if code else "all green"))
    sys.exit(code)
