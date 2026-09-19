# M9 — Internal release candidate

Status: planned; integrated release acceptance remains open. Written 2026-09-19.

References: [shared milestone baseline](../implementation-plan-expo.md#remaining-milestone-plans--m6-through-m9), [M6 coordinated inputs](m6-hands-and-voice.md), [M7 creation and restyling](m7-creation-and-restyling.md), [M8 live compositing](m8-live-compositing.md).

## Goal and required end state

Produce a reproducible, internally installable build that completes the intended journey on explicitly supported hardware, with measured performance and operational recovery.

At completion, another person can install the candidate, calibrate an empty or furnished room, redesign it using hands and voice, see live compositing, undo changes, and end the session cleanly. Installation and operation must not depend on undocumented knowledge from the original implementer.

Dependencies: M6, M7, and M8 completion checklists plus the accepted M5 reconstruction baseline. M9 rechecks the integrated candidate without reopening the original milestone scope.

This milestone does not include public launch, App Store submission, accounts, persistent projects, multiroom, non-LiDAR support, or a horizontally scaled backend.

## Starting state and implementation boundaries

The repository has development/preview build configuration, a Fastify backend, a separate reconstruction worker, local gates, and developer diagnostics. Those components need a frozen compatible configuration, an installation path, integrated device evidence, and a runbook before they form an internal release candidate.

Primary integration points are the [build profiles](../../mobile/eas.json), [application configuration](../../mobile/app.config.ts), [server entry point](../../server/src/index.ts), [calibration store](../../server/src/reconstruction/store.ts), and [worker instructions](../../workers/reconstruction/README.md).

Keep the staging service bounded to one Fastify process with the existing ephemeral store. Preserve a previous accepted installable binary for rollback; do not assume an obsolete source directory constitutes a working rollback artifact.

## Ordered implementation plan

### M9.1 — Freeze and identify the candidate

1. Record application commit, native build identifier, dependency lockfile hash, backend/worker versions, selected adapter IDs, voice model configuration, and reconstruction model-weight checksums.
2. Define support only for device/OS combinations that have passed the gates. Require at least one physical LiDAR iPhone; do not advertise every iOS 17+ device as verified.
3. Package an internal distribution build with a separate staging identity and backend configuration.
4. Document reproducible installation and configuration from a clean checkout or the distributed build artifact.
5. Retain the previous accepted installable binary and compatible server/worker configuration. Record their artifact locations and restore procedure.

Deliverable: an identifiable candidate and rollback set, with an explicit support matrix.

### M9.2 — Package a bounded staging deployment

1. Run one Fastify instance using the existing ephemeral calibration store.
2. Run the reconstruction worker as a separate process with matching versions and configuration.
3. Document startup, shutdown, required secrets, health/capability checks, capacity limits, cancellation, expiry, and restart behavior.
4. Serve staging traffic over TLS and keep provider credentials server-side.
5. Verify cleanup on normal session exit, cancellation, expiry, worker failure, and server restart.
6. Identify any external provider's retention limitation explicitly; API deletion must not be described as proof of downstream deletion without evidence.
7. Keep horizontal scaling and a persistent database outside this internal release.

Deliverable: a reproducible staging service with verified failure handling and temporary-data lifecycle.

### M9.3 — Run the integrated acceptance journey

1. Cover an empty room, a furnished room, an incomplete calibration, and constrained placement around an opening.
2. Demonstrate calibration → reconstruction → coordinated editing → grouped restyle → live compositing → undo → session disposal.
3. Repeat the full empty-room and furnished-room journeys three times on every supported device/OS combination.
4. Exercise camera/microphone permission denial, connectivity loss, worker timeout, tracking loss, background/resume, and voice reconnect.
5. Confirm each failure preserves the last committed design and offers an actionable recovery state.
6. Verify developer sample rooms and adapter controls do not appear in the ordinary internal-release product journey.

Deliverable: recordings and diagnostic references for repeatable full-journey acceptance.

### M9.4 — Measure latency, compositing, and resource behavior

1. Run 30 successful simple voice edits: five each of move, rotate, resize, color, remove, and undo.
2. Measure actual speech end using an instrumented local audio reference or synchronized recording. Provider-event arrival is not an acceptable substitute.
3. Record p50/p95 speech-end-to-first-correct-visible-edit latency. Require p95 below 1.2 seconds under the documented network conditions.
4. Report failures and retries separately; do not silently remove them from the evidence. Retain the individual measurements used for the successful-edit percentile.
5. Record settled-commit latency separately from first-visible-edit latency. Report reconstruction duration separately from both.
6. Run a 30-minute mixed-use session including voice, carrying, reconstruction, and three-object erasure.
7. Apply M8's sustained 30 FPS measurement procedure during live compositing. Require no crash, stuck transaction, or growing live-frame/resource count.
8. Create and dispose ten sessions and confirm resource counts return to baseline: camera ownership, microphone tracks, peer connections, timers, native frame leases, textures, jobs, and temporary assets.

Deliverable: reproducible latency, FPS, and resource evidence for this candidate build.

### M9.5 — Complete diagnostics and handoff documentation

1. Export sanitized evidence correlated by session, calibration, revision, turn, operation, job, and adapter identity.
2. Keep credentials, raw camera frames, and raw audio out of default diagnostic exports. Any recordings used for acceptance are deliberate evidence artifacts, not default application logging.
3. Preserve developer overlays in development builds while hiding developer controls from the normal product journey.
4. Correct setup and architecture notes that contradict the actual camera flow, reconstruction integration, or native build location.
5. Provide installation, demonstration, troubleshooting, known-limitations, staging-operation, cleanup, and rollback instructions.
6. Record unresolved issues by user impact. Spatial corruption, wrong-target edits, broken undo, failed foreground preservation, and uncontrolled resource growth block acceptance.
7. Identify the accepted build and its exact device/OS support matrix in the release evidence.

Deliverable: an internal release handoff another engineer or evaluator can follow without additional implementation decisions.

## Public interfaces and compatibility

No new product-facing API is planned for M9. Freeze the interfaces delivered by M6–M8 and verify the candidate's client/server/worker combination.

- Record compatible versions as a release set rather than assuming arbitrary client and worker revisions interoperate.
- Preserve legacy routes that remain supported; verify that staging credentials and configuration do not leak into another build variant.
- Document unsupported combinations and explicit failure states.
- Roll back native regressions with a compatible application binary. Do not assume a JavaScript update can repair native camera or texture behavior.

## Verification and acceptance scenarios

Run the repository's existing TypeScript, milestone gate, and iOS JavaScript bundle checks against the candidate commit, then build and verify the actual native application. Do not substitute a simulator for hardware acceptance.

| Scenario | Required result |
|---|---|
| Fresh internal installation | Another person installs and starts the documented journey |
| Empty-room journey, three runs per supported combination | Calibration, creation, edits, undo, and cleanup succeed |
| Furnished-room journey, three runs per supported combination | Reconstruction, preservation, restyle, erasure, undo, and cleanup succeed |
| Incomplete coverage or constrained doorway placement | Uncertainty and conflicts are explained; invalid geometry does not commit |
| Permission denial | Specific recovery guidance; no stuck session |
| Network loss, voice reconnect, or worker timeout | Committed design remains intact and capabilities recover explicitly |
| Tracking loss and background/resume | No positional commits during unreliable tracking; no stale callbacks |
| Thirty simple voice edits | Measured p95 below 1.2 seconds, with raw timing evidence and reported failures |
| Thirty-minute mixed-use session | Sustained compositing performance and bounded resources |
| Ten session create/dispose cycles | Owned resources and temporary assets return to baseline |
| Server restart and expired session access | Documented invalidation, cleanup, and inaccessible expired artifacts |
| Rollback rehearsal | Previous accepted compatible build/service set is recoverable |

## Completion checklist

### Packaging and implementation

- [ ] Internally installable candidate and full version manifest exist.
- [ ] Separate staging identity/configuration are recorded and reproducible.
- [ ] A bounded Fastify/worker deployment and TLS access are documented.
- [ ] Cleanup, expiry, failure, and restart behavior are implemented and documented.
- [ ] Diagnostic exports are sanitized and correlated.
- [ ] Normal product screens exclude developer controls.
- [ ] Installation, troubleshooting, known limitations, and rollback instructions match the candidate.
- [ ] Previous accepted installable binary and compatible service configuration are retained.

### Verification and end-state evidence

- [ ] M6, M7, and M8 completion checklists are satisfied.
- [ ] Existing local checks and milestone scenarios pass for the candidate commit.
- [ ] Every advertised device/OS combination has physical-device evidence.
- [ ] Empty-room and furnished-room journeys each pass three consecutive runs per combination.
- [ ] Failure and recovery scenarios preserve committed scene state.
- [ ] Simple voice edits meet the measured p95 latency requirement.
- [ ] Live compositing meets the sustained 30 FPS requirement.
- [ ] The 30-minute mixed-use session passes.
- [ ] Ten create/dispose cycles release owned resources and temporary assets.
- [ ] Staging cleanup and expired-session access behavior are verified.
- [ ] Rollback has been rehearsed with the retained artifacts.
- [ ] No blocking spatial, transaction, compositing, or lifecycle defects remain.
- [ ] The evidence record names the accepted build and its exact support matrix.

## Completion evidence record

- Accepted application commit/build and artifact location: **not recorded**.
- Lockfile hash, backend/worker versions, adapter IDs, model configuration/checksums: **not recorded**.
- Supported device/OS matrix: **not recorded**.
- Local commands and scenario results: **not recorded**.
- Full-journey recordings and recovery evidence: **not recorded**.
- Individual latency samples, p50/p95, network conditions, and failures: **not recorded**.
- Sustained FPS, freshness, thermal/memory data, and resource counts: **not recorded**.
- Staging operation, expiry/cleanup, and rollback evidence: **not recorded**.
- Known nonblocking limitations and unsupported combinations: **not recorded**.
- Acceptance date and reviewer: **not recorded**.
