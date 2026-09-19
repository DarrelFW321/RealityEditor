# Expo application

Run installation from the `reality-editor` workspace root:

```sh
npm ci
npm run server
```

In another terminal, copy `mobile/.env.example` to `mobile/.env`, set the backend's LAN address for a physical phone, and run:

```sh
npm run ios --workspace @reality/mobile
```

This requires full Xcode, signing, a development build and a supported LiDAR iPhone for room measurement. Expo Go cannot load Vision Camera, WebRTC, or the local spatial module. `npm run dev` starts Metro for an already-installed development build. No provider key belongs in mobile environment variables.

The welcome screen exposes **Open development room** only in development. It uses sample geometry to build the editor without camera or cloud services. Tap a surface to set a destination; tap an object to select it; use Carry and point/drag across the floor, then Release. While an object is held the panel says whether a release there would be accepted and the object glows amber where it would not; carrying is never blocked by that answer. The Modules panel accepts structured editing commands, shows recent diagnostic events, and runs the **M2** and **M3** milestone gates. Both suites also run without a device: `npm run gate` from the repository root, optionally with `M2` or `M3` to select one. Voice uses the same commands through `/voice/session` when the backend has `OPENAI_API_KEY`.

The live journey uses Vision Camera for selected visual references, releases its camera, then starts native RoomPlan measurement. The native AR session continues into editing and supplies projection, pose, tracking and hand cursor samples. Captured references remain local and are deleted when the session ends. **Their registration into the measured frame is not implemented, so they are not uploaded or falsely labeled as tracked keyframes.**

Current rendering is measured-room editing, not live furniture erasure. The settling implementation is an upright gravity/floor baseline with compound collision checks, not a general rigid-body solver: instability is reported as a caveat, never simulated. An object resting on scanned furniture uses a bearing region derived from the measured bounding box, which is inferred geometry and not a load rating. Review [implementation status](../docs/expo-implementation-status.md) before considering a milestone complete.

## Replace an implementation

- Contracts and capabilities: `packages/contracts/src/ports.ts`.
- Pure scene ownership: `packages/spatial-engine`.
- Procedural assemblies: `packages/scene-recipes`.
- Lifecycle and gravity baseline: `packages/adapters`.
- Application composition: `src/runtime/editor.ts`.
- Native integrations: `src/adapters` and `modules/spatial-capture`.
- UI consumers: `src/components`.

Pass candidate factories to `createEditor(scene, modules)`; `defaultEditorModules` supplies the current settling adapter and object builder. For example:

```ts
const editor = createEditor(scene, {
  ...defaultEditorModules,
  createSettling: () => new CandidateSettlingAdapter(),
});
```

The rest of the editor continues to consume the same contracts. Voice implementations are installed through `AdapterSlot` in the editor panel. Add an adapter implementing the relevant port and select it at session creation. `AdapterSlot` serializes stop/dispose/start and assigns a generation. Do not replace a tracking provider while keeping anchors from its previous coordinate frame. Native package changes require a new binary.

The native background currently uses an empty ARSCNView solely to present the tracked camera. All editable meshes are rendered by R3F. Device work must establish projection alignment, timing, lifecycle behavior and frame-buffer performance before this is considered a completed native milestone.

For M1, open **Modules** after measurement. The overlay reports camera ownership, native frame cadence/freshness, tracking reason, viewport/orientation, R3F render FPS and hand visibility. Red/green world markers expose projection or coordinate-frame drift. Follow the [M1 device gate](../docs/m1-native-feasibility.md) and attach its evidence before marking native feasibility complete.
