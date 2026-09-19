# Spectator

A Three.js mirror of the room, in a browser. **Owner: D. Built hour 23, not before.**

## What it is

A laptop on the projector showing the same scene graph the phone is editing. The
audience watches the room change on a big screen while the presenter holds the
phone. It makes a handheld AR demo legible to a room of a hundred people, which
is the only reason it exists.

## Why it is scaffolded now and built at hour 23

It is the highest-value thing you can add **once the core works**, and the most
expensive distraction before that. It touches nothing on the critical path: it
reads the same `RSG` and `Op` contracts everything else does, so it cannot be
blocked by anything except those contracts existing — which they already do.

If hour 23 arrives and the phone is still not moving furniture, do not build
this. Cut it.

## How it gets its data

**Read-only, and not on the critical path.** Two options, in order of preference:

1. **Replay a `.jsonl` session log.** Zero new infrastructure. The session
   recorder already writes `contracts/fixtures/sessions/*.jsonl`; AirDrop one off
   the phone and scrub through it. This also works with no network at all, which
   on conference wifi is worth more than live.
2. **Live mirror over LAN.** The phone POSTs each applied op to a dev-only
   endpoint the spectator polls. Do **not** add a WebSocket op channel to the
   session server for this — the server is deliberately not in the op path, and a
   spectator view is not a good enough reason to put it there.

## Contracts

Import the generated TypeScript types. Do not hand-write them.

```ts
import { RsgSchema, OpSchema, type Rsg, type Op } from "../server/src/contracts.js";
```

Coordinate system is right-handed Y-up metres, same as the phone. Three.js is
also right-handed Y-up, so there is no conversion — verify that before writing
one anyway.

## Setup, when the time comes

    npm create vite@latest . -- --template vanilla-ts
    npm install three

Draw it in Twin Mode: measured boxes, one material per class, one accent colour
for whatever the last op touched. It should look like a diagram, not a render —
a half-finished photoreal room reads as broken, and a clean diagram reads as
deliberate.
