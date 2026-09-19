# M7 — Structured creation and atomic restyling

Status: planned; implementation and acceptance remain open. Written 2026-09-19.

References: [shared milestone baseline](../implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), [product requirements](../prd-expo-migration.md), [M6 coordinated inputs](m6-hands-and-voice.md).

## Goal and required end state

Turn requests such as “make this a blue bedroom with three frames here” into a coherent, editable arrangement that fits the room.

At completion, generated objects have stable identities, follow-up count and dimension changes work, and a restyle—including removal visibility—is one validated, undoable transaction. No committed layout may intersect objects or invent an unintended support relationship to satisfy a request.

Dependencies: the existing spatial engine and settling behavior, accepted M5 reconstruction assets, and M6 input coordination. Recipe and layout work can use development rooms before the complete voice journey is connected. M8 consumes the visibility intent defined here; M7 does not claim live pixel erasure.

## Starting state and implementation boundaries

Five procedural families already exist: bed, table, cabinet, shelf, and frame. Basic multi-object additions are atomic, but placement is a simple row around the destination. Stable groups, whole-layout search, surface styling, and grouped visibility changes remain incomplete.

Primary integration points are the [recipe builders](../../packages/scene-recipes/src/index.ts), [spatial engine](../../packages/spatial-engine/src/index.ts), [editor intent mapping](../../mobile/src/runtime/editor.ts), and [session contracts](../../packages/contracts/src/session.ts).

Retain these five initial object families. Do not add a model marketplace, runtime code generation, a second conversational model, or an external asset-generation dependency. A supported approximation must be labelled and explicitly requested.

## Ordered implementation plan

### M7.1 — Define scene recipes and stable groups

1. Define validated recipes containing object families, quantities, dimensions, cosmetic appearance, structural template, target surfaces, layout relations, and objects to preserve or replace.
2. Assign stable group IDs and member IDs. Store membership and established member order in scene transaction state.
3. A count increase reuses existing members and adds only the difference. A decrease removes from the end of established group order.
4. Recompute spacing when group count or dimensions change, while retaining reusable member identities.
5. Clarify unsupported object families. Never present a generic primitive as an exact reconstruction.
6. Treat model output as data validated by the recipe schema; never execute generated JavaScript or JSX.

Deliverable: a recipe and group representation supporting subsequent edits to the same objects.

### M7.2 — Implement deterministic whole-layout planning

1. Search floor placements on the existing 5 cm grid and supported orientations. Use measured/proposed room surfaces to establish candidate regions.
2. Place large, constrained objects first; break ties by stable entity ID.
3. Place wall-mounted groups in usable wall intervals, excluding openings. For evenly spaced groups, solve spacing within those intervals rather than generating overlapping copies.
4. Check candidates against retained furniture, all proposed additions, room bounds, support requirements, openings, door behavior, and existing clearance guidance.
5. Preserve the engine's distinction between hard placement violations and advisory clearances. Do not invent a circulation graph.
6. Run bounded, cooperative search so gestures and rendering remain responsive. Initial limits: 12 generated objects and 20,000 candidate evaluations per proposal.
7. Distinguish exhausting the search budget from proving a specific geometric conflict. Return complete valid proposals or explained alternatives; never silently shrink objects, reduce counts, or stack furniture.

Deliverable: a local layout proposal with computed poses and an actual constraint report.

### M7.3 — Add atomic scene and visibility transactions

1. Prepare additions, removals, appearance, group metadata, structural design overrides, and removal-visibility changes in an isolated draft.
2. Validate the complete resulting arrangement before publishing committed state.
3. Commit once, advance revision once, and create one undo entry for the whole restyle.
4. Cancellation, invalid placement, stale revision, or missing reconstruction required by that proposal leaves the original transaction state intact.
5. Preserve measured observations and physical obstacles. A replacement can require physical removal even when it is a valid proposed design.
6. Store visibility intent by measured object identity and reconstruction reference. Receiving a reconstruction manifest alone must never erase furniture.
7. Make the same transaction API available to touch and voice.

Deliverable: restyle commit/rollback/undo covering both design and intended visibility.

### M7.4 — Implement appearance and follow-up edits

1. Support object, group, wall, floor, and room-palette targets for appearance changes.
2. Resolve relative dimensions locally from current object parameters, including “20 centimetres wider.”
3. Add count changes, equal spacing, and facing a named surface.
4. Re-solve dependent placements after structural design edits. If furniture cannot remain valid, return a complete proposal for confirmation or reject the change whole.
5. Require confirmation when a proposal changes the user's requested dimensions, count, or destination.
6. Keep inferred appearance identifiable and measured room geometry immutable.

Deliverable: follow-up commands edit the existing design instead of replacing it with unrelated generated content.

### M7.5 — Make construction validation explicit

1. Extend authored assemblies with template version, structural material class, connection rules, bearing regions, support polygon, and declared load assumptions.
2. Validate positive dimensions, connected construction, authored span/thickness limits, support contact, and balance under declared load cases.
3. Separate cosmetic color from structural material. Revalidate construction after dimension, support, orientation, or structural-material changes.
4. Return `valid-within-template`, `needs-adjustment`, `unsupported`, or `unknown`, with the template and assumptions that justify the result.
5. A three-legged bed needs an authored three-support template with edge-load checks. If unavailable or invalid, explain why and offer a supported alternative rather than deleting a leg from the ordinary bed mesh.
6. Unknown construction can appear only as an explicitly requested, visibly labelled concept. Passing these checks is not a claim of certified strength or verified real load capacity.

Deliverable: construction outcomes that affect proposals and narration, not merely decorative assembly metadata.

### M7.6 — Integrate one creation/restyle voice tool

1. Extend the existing voice session with a structured recipe tool and follow-up group-edit commands.
2. The conversational model requests a recipe; the local planner computes poses and validates the whole result.
3. Narrate the actual proposal, refusal, adjustment, or committed transaction.
4. Keep legacy style endpoints compatible without routing Expo restyles through a second conversational model. Legacy style intents, where consumed, must expand into the same validated transaction path.
5. Show planning progress separately from the simple-edit latency indicator.

Deliverable: the bedroom/three-frames conversation using the same input coordinator and engine as manual editing.

## Public interfaces and compatibility

- Add validated scene-recipe, group, construction-result, layout-proposal, and scene-transaction types to session contracts.
- Include proposal identity, base revision, affected entities, alternatives, confirmation requirements, and validation results in the planner boundary.
- Include group membership and visibility intent in undoable state; do not keep a second renderer-owned history.
- Reference measured objects and reconstruction assets for erasure intent. Keep physical occupancy separate from this intent.
- Version changed session envelopes and adapt existing development fixtures with explicit defaults.
- Change generated wire schemas only when a real cross-language consumer needs the new fields; generated files remain generated.

## Verification and acceptance scenarios

Extend the existing development scenarios and Modules view with M7 cases. Use deterministic recipes to verify geometry and transactions without depending on model wording.

| Scenario | Required result |
|---|---|
| Blue bedroom with three frames on a wall containing a window | Correct palette, three distinct editable frames, equal spacing in usable wall space |
| Frame count changes from two to three to two | Reusable members retain IDs; spacing is recalculated |
| Bed plus two nightstands cannot fit | Explained alternatives; no partial commit or hidden shrinking |
| Restyle furnished area while preserving a selected object | Retained object remains visible and a placement obstacle |
| Undo a furnished-room restyle | Objects, surfaces, groups, and visibility intent restore together |
| Enlarge an object or move a wall into furniture | Valid complete alternative or whole-change refusal |
| Request a three-legged bed | Authored validated construction or explained refusal and supported alternative |
| A proposal arrives after another commit | Stale proposal rejected; current design preserved |
| Search reaches its evaluation limit | Bounded completion with a search-limit explanation, not a claim of proven impossibility |
| Repeat the same recipe and room inputs | Deterministic layout and validation output |

Run workspace TypeScript checks, existing gates, new M7 scenarios, and the iOS JavaScript bundle check. Demonstrate the complete voice-driven bedroom, count-change, and undo journey on a physical device after the deterministic checks pass.

## Completion checklist

### Implementation

- [ ] Structured recipes generate editable objects and stable groups.
- [ ] Whole-layout planning checks new objects against each other and retained geometry.
- [ ] Planning is bounded and does not block ongoing input or rendering.
- [ ] Count, dimensions, spacing, facing, color, and surface appearance support follow-up edits.
- [ ] No silent shrinking, count reduction, or unintended stacking occurs.
- [ ] Restyles commit and undo atomically, including visibility intent.
- [ ] Measured observations and physical obstacles remain intact.
- [ ] Construction results identify authored templates and assumptions.
- [ ] Unknown concepts are explicit and labelled.
- [ ] Creation and restyle tools use the existing conversational session and coordinator.

### Verification and end-state evidence

- [ ] Existing checks and M7 development scenarios pass.
- [ ] Impossible-layout, stale-proposal, and search-limit scenarios preserve committed state.
- [ ] Stable identity and atomic undo scenarios pass.
- [ ] The three-legged-bed scenario gives a validated result or explained refusal.
- [ ] The complete bedroom/three-frames journey works on a physical device.
- [ ] Evidence below records the build, recipes, results, and limitations.

## Completion evidence record

- Implementation commit: **not recorded**.
- Local commands and scenario results: **not recorded**.
- Recipe/template versions and sample proposal outputs: **not recorded**.
- Device model, OS, native build, and lockfile hash: **not recorded**.
- Device demonstration and sanitized diagnostics location: **not recorded**.
- Planning durations, construction limitations, and known failures: **not recorded**.
- Acceptance date and reviewer: **not recorded**.
