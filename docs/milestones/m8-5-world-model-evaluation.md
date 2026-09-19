# M8.5 — World-model research and controlled evaluation

Status: desk research and implementation plan written 2026-09-19. Provider experiments, integration, and device acceptance have **not** been performed. No paid inference, room-image upload, or model deployment was performed for this research.

References: [shared milestone baseline](../implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), [product requirements](../prd-expo-migration.md), [M8 live compositing](m8-live-compositing.md), [M9 internal release](m9-internal-release-candidate.md).

## Goal and required end state

Determine whether a world-model-backed appearance provider improves the empty-room background revealed when furniture is removed, without weakening measured geometry, live compositing, privacy, or operational reliability.

At completion, we have a reproducible comparison against the accepted M5/M8 baseline and an explicit **adopt, defer, or reject** decision. Adoption additionally requires a replaceable, verified appearance adapter and a working baseline fallback. A documented rejection or deferral is a valid milestone outcome; shipping a world model is not required to complete M9.

Sequence: **M8 accepted → optional M8.5 evaluation → M9**. Desk research and synthetic preparation can happen earlier. Final quality and device comparisons require the accepted M8 build. Do not use a world model to bypass an incomplete M8 gate.

### Goal checklist

- [ ] Establish whether generated background completion is materially better than the existing worker.
- [ ] Preserve the measured room, openings, physical obstacles, and editable scene semantics.
- [ ] Demonstrate stable appearance across viewpoints in the actual native Expo editor.
- [ ] Bound cost, latency, temporary-data exposure, and cancellation behavior.
- [ ] Produce a supported adoption decision, including evidence for continuing without a world model.

## Scope and non-goals

The primary experiment is **appearance completion on the existing measured shell**, not replacement of RoomPlan or the spatial engine. Candidate output may fill unobserved wall/floor texels; observed texels remain authoritative. New texture is inferred appearance, never a measured observation.

Keep M7 objects, procedural assemblies, collisions, selection, transactions, and undo unchanged. Generated furniture painted into a texture is not an editable object and is a failure for this empty-room use case. A visually removed physical obstacle remains in the physical-occupancy model.

Out of scope: per-frame cloud generation, generated video as the live camera, whole-world replacement of the editor, training a foundation model, non-LiDAR capture, multiroom, persistent projects, new conversational controllers, a renderer migration, and a separate testing framework. Direct Gaussian-splat rendering is a secondary feasibility question, not a prerequisite for the primary experiment.

## Research findings and shortlist

These are documented capabilities, not results verified in this repository. Availability, prices, terms, and model versions must be rechecked immediately before execution.

| Candidate | Documented capability | Project fit and unresolved question | Priority |
|---|---|---|---|
| World Labs depth-conditioned panorama | Depth panorama plus text produces RGB panorama asynchronously | Can we use its appearance only in missing shell regions, without invented furniture or structural features? | A: first experiment |
| World Labs Marble world generation | Image/multi-image/panorama inputs; persistent world assets and exports | Can the generated representation register to the measured room and yield a better atlas? | B: bounded comparison |
| Tencent HY-World 2.0 | Public generation/reconstruction pipeline producing meshes and 3D Gaussian representations | Potential self-hosted alternative; deployment, licensing, weights, resource needs, and input-prior compatibility still need auditing | Reserve candidate |
| NVIDIA Cosmos / Google Genie | Broader world-simulation and interactive-generation research | Reviewed material does not establish our required measured-room-to-editable-shell interface | Defer |

Candidate sources: [World Labs depth-to-RGB API](https://docs.worldlabs.ai/api/reference/pano/depth_to_rgb), [World Labs input examples](https://docs.worldlabs.ai/api/world-generation-examples), [HY-World 2.0 official repository](https://github.com/Tencent-Hunyuan/HY-World-2.0), [NVIDIA Cosmos repository](https://github.com/NVIDIA/cosmos), [Google Genie](https://deepmind.google/models/genie/).

### A — Depth-conditioned appearance: recommended first experiment

The documented endpoint is `POST /marble/v1/pano:depth_to_rgb`. It accepts a full 360-degree, 2:1 equirectangular depth panorama, a text prompt, and an optional seed. EXR carries float depth; normalized PNG requires `z_min` and `z_max`. Completion is an asynchronous operation returning a panorama URL. The documentation describes only loose adherence to geometry; its exposed request schema contains neither a reference RGB image nor an edit mask. It therefore does not establish faithful reconstruction of the original room's materials. [API contract](https://docs.worldlabs.ai/api/reference/pano/depth_to_rgb).

Our proposed use is narrower: render depth from our measured shell, generate a candidate panorama, and project candidate color onto existing UVs only where observation coverage is absent. This is an engineering hypothesis, not an advertised exact-room reconstruction capability. Compare against the existing completion worker; abandon this route if it paints structural inventions or cannot match observed material boundaries.

### B — Full-world generation: comparison, not automatic adoption

The API documents multi-image input with azimuth hints; the reviewed examples do not establish ingestion of our full per-frame intrinsics and six-degree-of-freedom camera poses. Use selected aligned captures, but do not assume provider-generated geometry inherits their metric registration. Upload server-side via supported media/base64 inputs, not publicly exposed calibration URLs. [Input examples](https://docs.worldlabs.ai/api/world-generation-examples).

Pin `marble-1.1` for the full-world comparison; reserve `marble-1.0-draft` for inexpensive plumbing checks, not final quality evidence. The models page and generation reference currently disagree about the default model, so never rely on an omitted model field. Record requested and returned identifiers. [Models](https://docs.worldlabs.ai/api/models), [generation API](https://docs.worldlabs.ai/api/reference/worlds/generate).

SPZ outputs include documented scale, ground-offset, and coordinate-convention metadata. Apply the documented conversion exactly once and record the resulting transform. Those fields do not prove alignment to our measured room. Mesh/GLB export is a separate operation; a generated collider must never become authoritative physical geometry. [SPZ rendering conventions](https://docs.worldlabs.ai/api/rendering-spz), [asset export API](https://docs.worldlabs.ai/api/reference/worlds/export).

Spark provides a Three.js Gaussian-splat renderer using WebGL2 and WebAssembly. That is relevant to an optional native feasibility spike, but does not demonstrate compatibility with Expo GL/Hermes. Keep the main path on the current shell/atlas renderer; do not substitute a WebView demonstration for native acceptance. [Spark repository](https://github.com/sparkjsdev/spark).

### Reserve and deferred options

HY-World 2.0 is worth revisiting if the managed candidate fails access, privacy, or quality requirements. Its repository describes generation and multi-view reconstruction components, but a working paper/demo is not our deployment plan. Before selecting it, pin individual component revisions and weights, audit their licenses, and measure GPU memory and end-to-end runtime. Do not infer that every announced successor has deployable code. [Official repository](https://github.com/Tencent-Hunyuan/HY-World-2.0).

Cosmos and Genie address useful but broader world-model problems. Do not add a second experiment track without first verifying a concrete export/API contract that serves this room-anchored appearance task. “World model” alone is not a selection criterion. [Cosmos](https://github.com/NVIDIA/cosmos), [Genie](https://deepmind.google/models/genie/).

## Repository integration constraints

The following are current code observations, not already-implemented world-model support:

| Boundary | Current behavior | Required plan |
|---|---|---|
| [Worker provider](../../server/src/reconstruction/provider.ts) | `ReconstructionProvider.reconstruct(input, signal)` returns validated manifest/assets, including shell and atlas | Add an opt-in worker-side completion implementation; normalize external output before publishing |
| [Session contracts](../../packages/contracts/src/session.ts) | Shell is room-space wall/floor geometry with UVs; artifact roles are mask/atlas/shell | Preserve shell geometry and baseline UV layout; do not forward arbitrary worlds or SPZ as shell artifacts |
| [Calibration store](../../server/src/reconstruction/store.ts) | One immutable reconstruction attempt per calibration; worker deadline is 120 seconds | Use isolated development stores for comparisons; design an explicit optional refinement lifecycle before production adoption |
| [Mobile reconstruction adapter](../../packages/adapters/src/reconstruction.ts) | Overall polling deadline is 180 seconds | A longer provider operation needs a bounded, separate appearance-refinement wait; do not silently lengthen ordinary baseline waits |
| [Existing worker](../../workers/reconstruction/README.md) | Projects observations before completing holes | Retain its observation mask and baseline artifact; replace only the completion stage |
| [M8 compositor](m8-live-compositing.md) | Planned revision-safe world-space appearance adoption | Stage validated candidate textures; keep current baseline active until an atomic, valid appearance swap |

Current provider transport caps response bytes at 64 MiB, each asset at 16,000,000 base64 characters, and asset count at 64. The shell contract limits atlas dimensions to 8192. These are rejection limits, not target sizes. Keep candidate atlas dimensions and UVs equal to baseline; download and process large provider assets inside the worker, never directly in mobile. Do not enlarge limits just to accept an unoptimized world export.

### Proposed data flow

```text
Frozen calibrated input + accepted observation coverage
    ├── Existing worker → baseline shell/atlas → M8 stays usable
    └── Optional backend appearance job
          → provider → registration/reprojection → hole-only atlas
          → validation + provenance → atomic M8 texture adoption

Measured geometry / physical occupancy / M7 transactions: unchanged
```

The new lifecycle is a design requirement, not an existing endpoint. For evaluation, use separate development server/store instances or an isolated diagnostic runner with the same frozen input hash. Do not reset `session.job`, overwrite the baseline artifact, or publish a second attempt as if it were the original job.

If adoption is warranted, add a versioned optional appearance-job contract alongside baseline reconstruction. It must identify the parent calibration/revision/frame, baseline artifact hash, provider/configuration hash, job ID, and appearance generation. Follow existing schema ownership/code-generation conventions. Keep provider operation IDs, credentials, and external download URLs backend-only. The editor accepts an appearance result only when all parent identities still match; result readiness never commits removal, movement, or visibility state.

## Ordered implementation and research plan

### M8.5-A — Freeze the baseline and evaluation protocol

1. Require accepted M8 device evidence before final comparisons. Record commit/build, supported device/OS, baseline worker versions, and existing quality/performance limitations.
2. Prepare four cases: plain empty room; furnished room with removable furniture; patterned floor/wall with a large hidden region; challenging window/reflective or low-texture region.
3. Use synthetic data for plumbing first. For real cases, obtain permission for the specific provider and captures. Collect furnished and physically cleared reference views where feasible, holding capture settings and camera poses as close as possible.
4. Freeze the input keyframe subset, measured shell, opening boundaries, baseline atlas, observation/hole masks, and camera evaluation route. Hash inputs; record actual poses. Withheld/cleared-room reference views are evaluation-only and must not enter provider input.
5. Select three fixed seeds, `0`, `1`, and `2`, before seeing results. Predeclare criteria below; score all attempted runs, including failures. A seed is recorded input, not a promise of bitwise provider reproducibility.

Deliverable: a sanitized case manifest and repeatable baseline recordings. Private media lives in approved temporary evidence storage, not Git.

### M8.5-B — Resolve provider access, data handling, and budget

1. Recheck endpoint availability, exact model IDs, prices, applicable account terms, training settings, output-use rights, and provider retention/deletion behavior.
2. Establish server-side secrets, private world permissions, allowlisted bounded asset downloads, request accounting, and an approved spending ceiling before any paid call.
3. Resolve panorama pricing separately; do not infer depth-to-RGB cost from ordinary text/image panorama pricing.
4. Use synthetic captures until real-room data handling is approved. If provider retention is incompatible with the product requirement, defer that provider or evaluate an approved self-hosted alternative.
5. Record a maximum execution window of five engineering days for the initial experiment after access and baseline readiness. Stop earlier at a hard failure; extending the timebox or provider list requires a separate decision.

Deliverable: a short access/privacy/cost decision with explicit allowed inputs. Lack of acceptable access is a documented deferral, not permission to weaken the data policy.

### M8.5-C — Build the isolated appearance adapter and validate projection

1. Extend the worker's completion boundary behind explicit development configuration; leave the default worker unchanged. Retain observation coverage and the unmodified baseline output.
2. For route A, select a panorama origin inside the measured room and outside physical obstacles. Generate a complete spherical depth image from shell geometry, respecting openings; do not fabricate unknown adjoining rooms to close missing depth.
3. Verify axis orientation, depth convention, units, and PNG/EXR encoding against the provider's [official depth example](https://github.com/worldlabsai/worldlabs-api-examples/tree/main/web-chisel-depth-png). Use a synthetic room with known distances and distinct axis markers before paying for a generation. If open/unknown rays cannot be represented correctly, exclude that route rather than invent a depth encoding.
4. Use a fixed empty-room prompt and permitted material/color descriptors. Reproject the returned panorama from the known origin onto existing shell UVs. Apply candidate pixels only inside zero-observation holes; preserve observed texels exactly. Blend seams only on the inferred side of the boundary. Leave unsupported/disoccluded texels on baseline completion and mark their provenance.
5. For route B, extract a representation suitable for projection. Apply documented coordinate conversion, then estimate one rigid transform to room space from at least six well-spread landmarks across floor and walls. Use separate fitting and held-out landmarks; if correspondence or metric scale cannot be established, fail the route. Do not use nonrigid warps or per-view alignment to conceal drift.
6. Bake route B appearance to the same baseline atlas and apply the same hole-only restriction. No generated vertices, furniture, colliders, or semantic guesses enter the measured scene.
7. Validate response identity, image dimensions, resource bounds, provenance, and unchanged geometry. Reject malformed assets before publication. Keep per-texel observed/inferred coverage alongside surface-level provenance where M8 requires it.

Deliverable: an isolated adapter plus synthetic projection evidence; this does not establish visual quality or native compatibility.

### M8.5-D — Run a bounded provider comparison

1. Run at most two synthetic smoke requests per route. Stop a route immediately if its output cannot be normalized or registered. Do not pay for a larger dataset merely to confirm a contract failure.
2. Choose one finalist based on feasibility and smoke quality; record why the other route was deferred/rejected. Evaluate the finalist on all four frozen cases and three seeds: twelve scored runs, without cherry-picking.
3. Record request/operation identities, input/configuration hashes, model identifiers, seed, timing by stage, output sizes, billed cost, and every failure. Keep secrets and imagery out of normal diagnostics.
4. Poll accepted operations with bounded backoff. Respect provider rate limits and `Retry-After`. Never blindly resubmit an ambiguously accepted paid POST; reconcile its operation or stop for manual review.
5. Propose a ten-minute end-to-end refinement deadline, including generation, transfer, baking, and validation. Keep the baseline editor usable throughout. A late result cannot update a cancelled, expired, or recalibrated session.
6. Abort local work and reject late callbacks on cancellation. Track provider resources for cleanup separately: local abort does not demonstrate remote cancellation. Reconcile outstanding operations even when their results are no longer adoptable.

Deliverable: complete run ledger and comparable normalized artifacts, or a concrete early-stop finding.

### M8.5-E — Compare in the native editor and prove recovery

1. Load baseline and candidate into the same M8 development build, with identical geometry, camera routes, exposure conditions, and erasure intent. Blind the appearance labels for visual scoring.
2. Replay removal, movement, replacement, foreground hand crossing, viewpoint translation, undo, tracking loss, and recalibration. Check both the revealed background and boundaries against retained real objects.
3. Run each variant for ten minutes on the same physical LiDAR iPhone. Use M8's measurement procedure, recording thermal state, native/GPU memory, frame freshness, FPS, and texture counts. Let the device return to comparable thermal conditions between runs.
4. Exercise provider failure, malformed/oversized result, slow result, offline transition, cancellation, app backgrounding, expiry, and result arrival after recalibration. The baseline must remain usable and no stale appearance may publish.
5. Repeat ten refinement create/cancel-or-complete/dispose cycles; verify local resources return to baseline and provider cleanup has an explicit accounted state.

Deliverable: device comparison and recovery evidence. A browser viewer, still image, or attractive generated flythrough cannot satisfy this step.

### M8.5-F — Decide and hand off

1. Apply every hard gate below and record visual-benefit results separately. Do not average a geometry/privacy failure away with a quality score.
2. **Adopt:** all gates pass and benefit threshold is met. Complete the optional refinement lifecycle, retain a baseline-only configuration, document supported cases, and rerun local/native verification on the final integration commit.
3. **Defer:** evidence, access, or timebox is insufficient. Name the missing evidence and specific trigger for revisiting it. Continue M9 with the baseline.
4. **Reject this candidate:** hard failures or insufficient benefit are demonstrated. Record the failure cases and continue M9 with the baseline; this is not a rejection of all future world models.
5. Record the selected release adapter and evidence in M9. Adoption does not waive M9's full-journey, voice-latency, compositing, or resource gates.

Deliverable: a reviewed decision and reproducible configuration for M9.

## Acceptance gates

The numeric targets below are proposed project acceptance thresholds, not provider guarantees. Freeze them before experiments; record any deliberate revision rather than changing them after seeing results.

| Gate | Required evidence / pass rule |
|---|---|
| Geometry and semantics | Measured shell positions, topology, UVs, openings, physical obstacles, and M7 committed state are identical before/after appearance adoption; zero provider-generated geometry commits |
| Observation preservation | Decoded observed atlas texels are identical to baseline; generated texels remain marked inferred |
| Registration, route B | After documented metric conversion and one rigid fit, held-out landmark error is at most 3 cm at the 95th percentile and 5 cm maximum; no additional scale fitting to hide metric errors |
| Projection, route A | Synthetic axis/distance checks pass; rendered texture landmarks remain attached to their shell positions across the recorded route; no projection-induced sliding or opening fill |
| Visual benefit | Three reviewers compare all seeds blindly. A case wins only when at least two reviewers prefer the candidate on at least two of its three seeds. At least three of four cases must win; no critical visual failure in any scored run |
| Critical visual failures | No invented furniture, painted doors/windows, foreground erasure, persistent ghost furniture, or new view-dependent swimming; include failures in the ledger |
| Reference comparison | Where cleared-room reference exists, report masked color error under fixed documented alignment/lighting conditions and boundary artifacts for baseline/candidate; plausible hidden texture without ground truth is not claimed accurate |
| Native performance | At least 30 FPS in every ten-second measurement window over the ten-minute run, with fresh synchronized inputs; candidate peak native/GPU memory no more than 20% above baseline and no growth across disposal cycles |
| Latency and isolation | Refinement completes within ten minutes in every scored successful run; failures/timeouts reported separately. No model call on the live frame, gesture, transaction, or voice critical path |
| Reliability | At least eleven of twelve scored runs yield valid artifacts by the deadline; malformed, stale, or failed results never replace baseline |
| Recovery | Baseline-only operation, cancellation, expiry, late results, background/resume, and ten disposal cycles pass; fallback cannot alter scene/visibility history |
| Data and spend | Account-specific data policy is accepted, secrets remain backend-only, all remote resources are accounted for, and request admission remains within the approved ceiling |

If the finalist has not reached all twelve runs, it cannot be adopted on partial evidence. Document an early reject/defer instead. A valid artifact that has a critical visual failure still fails adoption.

## Budget and operational risks

World Labs lists 1,250 credits per USD: standard `marble-1.1` world generation costs 1,500 credits and multi-image panorama creation adds 100. That is approximately **$1.28 per multi-image world**, or **$15.36 for twelve**. High-quality mesh export adds 3,500 credits, approximately **$2.80 each**. Depth-to-RGB is not separately priced on the reviewed pricing page; confirm its cost before execution. Turning off auto-refill does not prevent overage charges. [API pricing](https://docs.worldlabs.ai/api/pricing).

Proposed initial full-world ceiling: **$25**, including smoke requests and any separately justified exports; not authorization to spend. Depth-route requests require their own confirmed unit ceiling and approved total. Maintain a local admission ledger that reserves the maximum charge for each in-flight request and stops new work when the ceiling could be exceeded. Reconcile actual billing; do not treat failed or locally cancelled requests as automatically free. Record worker/GPU, storage, and transfer costs separately.

Generation is an asynchronous workload; documented world-generation timing is around five minutes, not an SLA. This exceeds current server/mobile baseline deadlines, so use the isolated evaluation path first. High-quality export is unsuitable as an assumed interactive dependency; inspect actual timings before proposing it for refinement. [Rate limits and job timing](https://docs.worldlabs.ai/api/rate-limits), [export specifications](https://docs.worldlabs.ai/marble/export/specs).

The world-delete endpoint describes deletion of a world and associated assets, but this does not establish erasure of every uploaded media asset, standalone panorama, log, or training copy. Do not describe our local expiry as a provider-side retention guarantee. Confirm outstanding-operation and media cleanup mechanisms before uploading private captures. [Delete-world API](https://docs.worldlabs.ai/api/reference/worlds/delete).

The reviewed terms permit content use for model improvement and describe prospective paid-account opt-out; the privacy policy does not establish the project's proposed fixed temporary-data retention window. Record the actual agreement/settings and get the data-handling decision before real-room use. Private world visibility is not equivalent to no training or bounded retention. [Terms](https://www.worldlabs.ai/terms-of-service), [privacy policy](https://www.worldlabs.ai/privacy-policy).

## Completion checklist — what we must have at the end

### Required for any outcome

- [x] Current primary-source research and a bounded candidate shortlist are written down.
- [x] Integration boundaries, evaluation sequence, and proposed adoption gates are documented.
- [ ] Accepted M8 baseline and frozen evaluation case manifest are recorded, or their absence is the explicit reason for deferral.
- [ ] Access, pricing, privacy, and output-use decisions are recorded before applicable experiments.
- [ ] Run ledger includes every attempted request, failure, cost, and evidence location; unrun experiments are explicitly marked unrun.
- [ ] Comparison/recovery evidence exists for work performed; early-stop outcomes name the exact failed or unavailable prerequisite.
- [ ] Decision is explicitly adopt, defer, or reject, with reviewer/date and rationale.
- [ ] Local and remote temporary resources are cleaned up or have documented unresolved retention limitations.
- [ ] M9 selected-provider configuration and the baseline-only path are documented.

### Additionally required for adoption

- [ ] Opt-in appearance provider and revision-safe refinement lifecycle are implemented, not merely prototyped.
- [ ] Shell/atlas normalization preserves geometry, observed texels, and inference provenance.
- [ ] All twelve scored runs and all acceptance gates are evaluated; visual benefit threshold passes.
- [ ] Exact Expo native build passes quality, sustained-FPS, memory, and recovery checks on supported hardware.
- [ ] Existing local checks and relevant milestone scenarios pass on the final integration commit; no new testing framework is introduced.
- [ ] Budget enforcement, backend-only credentials, cleanup, and baseline fallback are verified.
- [ ] Configuration/model identifiers, limitations, operations instructions, and rollback are reproducible.
- [ ] M9 includes the adopted adapter in its full integrated acceptance; M8.5 evidence is not substituted for release acceptance.

## Completion evidence record

- Research date and sources: **2026-09-19; linked above**.
- M8 baseline commit/build/device/OS: **not recorded**.
- Provider/account policy approval and spending ceiling: **not recorded**.
- Frozen cases, hashes, reference capture permissions, and evaluation route: **not recorded**.
- Candidate configuration/model/weight identifiers: **not recorded**.
- Adapter/integration commit and local verification commands: **not recorded**.
- All-run ledger, billed cost, timings, sizes, and failures: **not recorded**.
- Geometry/projection checks and blinded visual scores: **not recorded**.
- Device recordings, FPS/memory/freshness, and recovery results: **not recorded**.
- Cleanup and unresolved provider retention findings: **not recorded**.
- Decision, rationale, reviewer/date, and revisit trigger if deferred: **not recorded**.
- M9 selected adapter and fallback configuration: **not recorded**.
