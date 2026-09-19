# Fixtures

Sample data the whole team codes against. Regenerate with
`python3 tools/make_fixtures.py`; validate with `python3 tools/validate_fixtures.py`.

These are not toys. They are what lets four people work in parallel from hour 0:
the solver owner tunes clearances with no phone, the voice owner tunes prompts on
a train, the renderer owner has a room to draw before RoomPlan works, and the
airplane-mode fallback is nearly free.

## `rooms/bedroom_4x4.rsg.json`

A 4×4m bedroom, 2.5m ceiling, every field populated.

```
              NORTH  (-Z)
      ┌────────[ window ]────────┐
      │                          │
      │  ┌────┐                  │
      │  │    │          ┌────┐  │
 WEST │  │bed │   ·chair·│desk│  │ EAST
 (-X) │  │    │          └────┘  │ (+X)
      │  └────┘                  │
      │                         ╭┤
      │                         ││ door
      └─────────────────────────┴┘
              SOUTH  (+Z)
```

- Origin at the floor-polygon centroid, on the floor. Corners at (±2, ±2).
- **Window** on the north wall: 1.4 × 1.2m, sill at 0.9m, centred.
- **Door** on the east wall: 0.86 × 2.03m, **left hinge, opens inward**, 0.86m
  swing arc. This is the constraint that produces the demo's best line.
- **Bed** (queen, 1.53 × 2.03m) against the west wall, headboard west.
- **Desk** (1.2 × 0.6m) against the east wall.
- **Chair** 0.4m in front of the desk.
- **Occupancy**: 80 × 80 cells at 5cm, 1680 occupied, 85 RLE runs.

Nothing starts under the window — that is the first demo turn.

## `scp/pointing_at_bed.json`

Crosshair on the bed. Measured angular offsets, not invented ones:

| Entity | Offset | Distance |
|---|---|---|
| `obj_bed_01` | 3.99° | 2.91 m |
| `srf_window_north` | 21.98° | 4.03 m |
| `obj_chair_01` | 28.45° | 3.66 m |
| `obj_table_01` | 37.97° | 4.35 m |
| `srf_door_east` | 59.95° | 3.80 m |

The camera pose was solved for, not guessed — every number is consistent with
the room geometry and with the scoring weights in `Deixis/Scorer.swift`.

## `scp/ambiguous_two_chairs.json`

Two chairs whose top-two scores differ by **0.0334** — inside the 0.1 ambiguity
threshold, so the scorer must route to the ask-don't-guess path.

**Its entity ids are deliberately not from `bedroom_4x4`.** `Scorer.rank` takes
only an SCP, never an RSG, so this fixture is self-contained on purpose — it
tests the tie path with no room loaded at all.

Near-symmetric but not identical. A perfect 0.0 tie is an input the real world
never produces, and it would let a scorer that returns a constant pass the test.

## `sessions/demo_script.jsonl`

The six demo turns, 46 frames, one `WSFrame` per line.

| # | Utterance | What it demonstrates |
|---|---|---|
| 1 | "move the bed under the window" | intent → solver adjusts → model narrates the adjustment |
| 2 | "turn it to face the door" | anaphora off the salience stack, no geometry |
| 3 | "delete that chair" | deixis off the crosshair |
| 4 | "put a rug over there" | `last_floor_hit` at 620ms — the pointing gesture is the sweep |
| 5 | "actually undo that" | exact undo by replaying a stored inverse |
| 6 | "make it scandinavian" | one utterance → a 5-op batch sharing a `style_batch_id` |

Turn 4 is the one worth reading. `last_floor_hit.age_ms` is 620, not 0: by the
time the user finished saying "over there", the phone had already swept off the
spot. That is why the SCP samples at 10Hz instead of once per turn.

Audio payloads are recorded with `pcm_b64` empty. 24kHz PCM16 is ~48KB/s and it
makes the log undiffable, which is the only thing the log is for.
