# tools

Scripts. None of them run on the critical path; all of them are things you would
otherwise do by hand and get subtly wrong.

| Script | What it does | When you run it |
|---|---|---|
| `make_fixtures.py` | Regenerates `contracts/fixtures/` from one description of the demo room. | After changing the demo room's layout. Rarely. |
| `validate_fixtures.py` | Validates every fixture against `contracts/schema/`. | After any schema edit, and in CI. |
| `install-hooks.sh` | Installs the pre-commit hook that keeps generated types in sync. | Once, per clone. |

## make_fixtures.py

The fixtures are checked in — you do not normally run this.

It exists because the numbers in `bedroom_4x4.rsg.json` have to agree with each
other. The occupancy RLE has to match the object footprints; the SCP's angular
offsets have to match the camera pose; the free-space summary has to be derivable
from the grid. Hand-authoring 6400 occupancy cells is how you ship a fixture that
quietly disagrees with itself and costs the solver owner an afternoon chasing a
bug that is in the test data.

It asserts its own output: the floor polygon must wind counter-clockwise, no two
objects may overlap, the RLE must round-trip, and the ambiguous-chairs fixture
must actually be ambiguous (top-two score gap strictly between 0 and 0.1 — a
perfect tie is an input the real world never produces and would let a broken
scorer pass).

    python3 tools/make_fixtures.py

The deixis scoring weights are duplicated here and in
`Deixis/Scorer.swift`. If you change one, change the other and regenerate, or the
fixtures start lying about what the scorer should produce.

## validate_fixtures.py

Requires `jsonschema`:

    pip3 install jsonschema

Checks that each of the five schemas is itself valid draft-07, then validates
every fixture against the right one — including each of the 20 ops embedded in
the session log, which is where a contract drift shows up first.

    python3 tools/validate_fixtures.py
