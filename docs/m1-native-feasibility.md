# M1 native feasibility record

Status: implementation revised after an unsuccessful first device run; repeat device evidence is pending. Updated 2026-09-19.

M1 answers whether the selected native pieces can share one real iPhone journey. Passing TypeScript or producing a JavaScript bundle does not answer that question. The app now contains a development overlay that measures the relevant interfaces and shows fixed world-space markers.

## Selected implementation

| Concern | M1 implementation | Replacement boundary |
|---|---|---|
| Visual reference capture | React Native Vision Camera 5.2.3 plus Expo DeviceMotion-guided 300° sweep | Capture screen; files remain unregistered and local |
| Measured shell | RoomPlan using a local Expo native module; floor falls back to a wall-base hull tagged `inferred` when furniture hides it | `SpatialCapture` native view and room envelope |
| Tracked editing camera | The same ARSession continues after RoomPlan stops | Native tracked-frame envelope |
| Hand cursor | Apple Vision index-tip and pinch samples from the same ARFrame | Timestamped normalized hand sample |
| Editable rendering | R3F native/Expo GL with a transparent surface above ARSCNView | Scene snapshot and tracked projection |
| Drop feasibility | `FloorSettlingAdapter`, a fixed-step upright floor-drop baseline | `SettlingAdapter` |

The settling choice is deliberately narrow. Rapier’s official JavaScript distribution is WebAssembly and its official material does not establish React Native/Hermes support. `@react-three/rapier` is designed around that WASM build. It remains a candidate only after it runs in this exact development build; M1 does not silently select it from a web demo. The current adapter satisfies free carrying, downward sweep checks, cancellation and floor contact, but does not claim angular rigid-body dynamics.

## Camera ownership sequence

1. Vision Camera owns the rear camera during visual reference selection.
2. The scan screen requests Vision Camera to stop, waits for its acknowledgement when available, unmounts the camera view, and holds a handoff interval before RoomPlan can mount.
3. RoomPlan creates and owns one ARSession for measurement.
4. Finishing measurement calls `stop(pauseARSession: false)` and retains that ARSession for tracked editing.
5. Backgrounding immediately disables spatial commits in JavaScript; ARKit must return to normal tracking before editing resumes. Ending the session stops capture, pauses AR, clears delegates and releases resources.

The M1 overlay reports the current owner. It is a defect if Vision Camera and RoomPlan report ownership at the same time, the preview freezes during handoff, or returning from the background commits a spatial edit before tracking returns to normal.

## Coordinate contract

- Native matrices are emitted column-major, matching `simd_float4x4` and Three.js `Matrix4.fromArray`.
- Every frame includes a coordinate-frame ID, AR timestamp, monotonic sequence, tracking state/reason, projection, camera-to-world matrix, viewport size and interface orientation.
- RoomPlan surfaces and objects start in the retained ARSession coordinate frame. The editor subtracts the measured floor offset from room geometry and camera Y exactly once.
- Apple Vision landmarks are detected in an upright EXIF orientation, converted back to captured-image normalized coordinates, then mapped by `ARFrame.displayTransform` into the exact native viewport, including orientation and aspect-fill cropping.
- The R3F GL surface requests an alpha channel so the native tracked camera remains visible below it.
- Hand samples and camera matrices come from the same retained ARFrame. The editor rejects frame-ID mismatches and spatial commits while tracking is limited or lost.

## Device gate

Use an iOS 17+ LiDAR iPhone and a development build. Open **Modules** in the editor to see the M1 gate.

1. Start calibration, stand near the room center. Calibration is now **one turn**: RoomPlan requests the rear camera directly and there is no separate Vision Camera sweep or handoff interval to observe. On a device without LiDAR the welcome screen must refuse before any turn begins, rather than starting a sweep that cannot finish. Confirm the screen reports RoomPlan acquired the rear camera, with no persistent blank preview and no simultaneous owner.
2. Complete the guided RoomPlan 270° turn for metric dimensions. It should finalize automatically once the turn and at least three observed walls are complete; **Finish now** remains available because RoomPlan may defer floor classification. If no floor is finalized, conversion derives a floor boundary from measured wall bases and records its provenance as `inferred`. The gate must show normal tracking, finite 4×4 matrices, matching viewport, a fresh frame and at least 12 native samples per second.
2a. **Sweep accuracy.** Turn a measured 270 degrees, briskly in places and slowly in others, and confirm the reported angle tracks reality to within a few degrees. Reading materially low means the rate-based rejection in `updateScanProgress` has regressed; that code is native, so confirm the build actually contains it.
2b. **M4 coverage.** The panel must report observed percentage rising as you turn, not just degrees. Deliberately leave one wall unobserved: the room must still be accepted, that wall must arrive as `provenance: 'inferred'`, and the editor must say the shell is partly inferred. Then face a wall you skipped and confirm the prompt named that direction before you turned. Press **Save capture as fixture** and copy both written files into `contracts/fixtures/rooms/captures/` so the M4 gate replays this room permanently.
3. Walk and rotate the phone. The red origin marker and green measured floor corners must remain fixed to the same real locations. Record visible drift over a 60-second loop and after one background/foreground cycle. The room origin now carries an `ARAnchor` and every frame follows that anchor's current transform, so this step is the acceptance test for that fix: drift that survives it means the anchor is not being revised usefully, not that the correction is missing.
4. Rotate through every supported interface orientation. Cursor position and world markers must remain aligned; viewport diagnostics must update.
5. Open **Modules**, show one hand, and move the index tip across all four quadrants. The blue cursor must follow the visible fingertip and the overlay must show confidence and processed/dropped samples. Pinch on a virtual object, carry it through another object, and release it on clear floor. Carrying may overlap; release must settle or restore.
6. Cover the camera or move rapidly until tracking is limited. The app must preserve the committed scene, cancel an active manipulation and refuse a spatial commit until normal tracking resumes.
7. Keep the session open for ten minutes while moving and manipulating objects. Record native sample FPS, R3F render FPS, thermal state, frame freshness and any camera interruption or memory warning.

Record device model, iOS version, build commit, dependency lockfile hash, room dimensions, start/end screenshots of the overlay and observed drift. M1 passes only when the anchored-render, hand-targeting, handoff and settling demonstrations work in one build. A simulator cannot close this gate.

## Evidence available in this workspace

- Workspace TypeScript passes.
- Expo produces the iOS JavaScript/Hermes export.
- Expo prebuild produces the native iOS project with iOS 17 deployment, camera/microphone usage descriptions and Hermes.
- Expo autolinking resolves Vision Camera, Nitro modules, WebRTC and `SpatialCapture`.
- The native Swift file passes Swift parser validation.
- Existing Swift SpatialCore builds with the generated contract changes.

The machine does not have a full Xcode/iPhoneOS SDK or CocoaPods, so it cannot compile the generated iOS app. TypeScript, the Expo/Hermes export, Expo native-module resolution, Swift parsing, and diff validation pass after the device-driven rework. A new physical-device run is still required; visual alignment and real camera ownership cannot be established by these local checks.
