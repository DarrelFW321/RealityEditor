import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Button,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import { AdapterSlot } from '@reality/adapters';
import { bearingFor } from '@reality/spatial-engine';
import type { EditorState, InteractionContext, Vec3 } from '@reality/contracts';
import type { Editor, Intent } from '../runtime/editor';
import type { TrackedFrame } from '../adapters/roomplan';
import { RealtimeVoice, type VoiceActivity } from '../adapters/realtime';
import { evaluateSpatialFrame } from '../adapters/roomplan';
import { SceneView, restingOrbit, ORBIT_LIMITS } from './SceneView';
import { resolveHand } from '../adapters/hand';
import { InputCoordinator } from '../runtime/coordinator';
import { applyToPoint, roomFromWorld } from '../adapters/room-space';
import {
  checkDeterminism,
  runScenario,
  scenariosFor,
  type Scenario,
  type ScenarioResult,
} from '../runtime/scenarios';
import type { ReconstructionPhase } from '../runtime/reconstruction';
import { textureBridgeAvailable } from '../adapters/frame-textures';
import type { FrameDiagnosticMode, FrameDiagnosticSample } from './NativeFrameDiagnostic';
import type { CompositorSample } from './CompositorView';
import { erasureVolumes, retainedVolumes } from '@reality/spatial-engine';
import { PatchStore } from '../runtime/patches';
import { frameCaptureAvailable, nativeFrameCapture } from '../adapters/frame-textures';
import { apiURL } from '../runtime/api-url';
import { BlueprintView } from './BlueprintView';
import { BlueprintEditor } from './BlueprintEditor';
import { blueprintAvailable, exportBlueprint, previewSheet } from '../adapters/blueprint';
import type { PlanSheet } from '@reality/blueprint';
import { GlassCircle, GlassCluster, GlassPanel, GlassPill } from './Glass';

export function EditorPanel({
  editor,
  frame,
  handFrame,
  origin,
  spatialOwner,
  onSaveCapture,
  onScan,
  detached,
  onDetach,
  reconstruction,
  depthInputs,
  onExit,
}: {
  editor: Editor;
  frame?: MutableRefObject<TrackedFrame | null>;
  handFrame?: MutableRefObject<TrackedFrame | null>;
  /** Room-space origin in ARKit world coordinates. */
  origin?: Vec3;
  spatialOwner?: string;
  /** Writes the capture this room came from out as an M4 gate fixture. Absent for the
   * development room, which was never captured. */
  onSaveCapture?: () => string;
  /** Leaves this room and starts a measurement sweep. */
  onScan?: () => void;
  /** True while the room is being edited away from the room. */
  detached?: boolean;
  onDetach?: (next: boolean) => void;
  /** Empty-room reconstruction, which runs behind the editor after a capture. */
  reconstruction?: ReconstructionPhase;
  /** What the native side said about scene depth, or null before it has spoken. */
  depthInputs?: { ok: boolean; reason: string } | null;
  onExit: () => void;
}) {
  const snapshot = useSyncExternalStore(editor.engine.subscribe, editor.engine.getSnapshot);
  const events = useSyncExternalStore(editor.diagnostics.subscribe, editor.diagnostics.getSnapshot);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [destination, setDestination] = useState<InteractionContext['destination']>(null);
  const [message, setMessage] = useState('Starting the microphone\u2026');
  // What the one button is doing, straight from the voice session. There is no separate
  // "is voice on" flag: a second source of truth for the same thing is how a muted
  // microphone ends up drawn as though it were listening.
  const [activity, setActivity] = useState<VoiceActivity>('offline');
  const [muted, setMuted] = useState(false);
  const [json, setJSON] = useState('{"action":"add","family":"table"}'),
    [dev, setDev] = useState(false);
  const [, refreshDiagnostics] = useState(0);
  const [sceneSize, setSceneSize] = useState<{ width: number; height: number } | null>(null);
  // The sheet currently on screen. Non-null IS the modal being open: there is no second
  // flag that could disagree with it about whether there is anything to show.
  const [blueprint, setBlueprint] = useState<PlanSheet | null>(null);
  const [exporting, setExporting] = useState(false);
  const [blueprintNote, setBlueprintNote] = useState('');
  // The shell is a preview of the room without its furniture. Off by default: the
  // measured room is the working surface, and the shell is something you turn on to look
  // at rather than something that silently replaces what you were editing against.
  const [showShell, setShowShell] = useState(false);
  // State, not a ref: this is the line that answers "why are the pixels not
  // changing", so it has to re-render when it changes.
  const [compositorSample, setCompositorSample] = useState<CompositorSample | null>(null);
  /**
   * Inpainted wall patches. One per hidden box, requested when the box is hidden and
   * dropped whenever its geometry changes — see `PatchStore.reconcile`.
   */
  const patchStore = useRef<PatchStore | null>(null);
  const [patches, setPatches] = useState<ReturnType<PatchStore['ready']>>([]);
  const [patchNote, setPatchNote] = useState<string | null>(null);
  /**
   * What live erasure should remove this frame, derived from committed state.
   *
   * Recomputed from the snapshot rather than accumulated, so undo, a cancelled drop and
   * tracking loss all restore the original appearance with no compositor bookkeeping
   * (M8-D.3/D.5). A carry is included transiently while it is held.
   */
  const erasure = useMemo(() => {
    const scene = snapshot.previewScene ?? snapshot.scene;
    const volumes = erasureVolumes(scene, { carriedId: snapshot.preview?.targetId ?? null });
    return volumes.length ? { volumes, retained: retainedVolumes(scene, volumes) } : null;
  }, [snapshot.scene, snapshot.previewScene, snapshot.preview]);

  useEffect(() => {
    if (!frameCaptureAvailable()) {
      // Silent until now, and it is the one cause the user cannot deduce from the
      // screen: an older development binary has no `captureFrame`, so no patch is ever
      // requested and hiding a box commits without covering anything.
      setPatchNote('This app build cannot capture frames, so masked areas cannot be filled in. Rebuild the development client.');
      return;
    }
    const store = new PatchStore(apiURL(), nativeFrameCapture);
    patchStore.current = store;
    const unsubscribe = store.subscribe((_id, state) => {
      setPatches(store.ready());
      if (state.state === 'failed') setPatchNote(state.reason);
      // A ready patch is covering the box either way. Its note says only why the fill
      // is the local one rather than the model's, which is a caveat, not a failure.
      if (state.state === 'ready') setPatchNote(state.note ?? null);
    });
    return () => {
      unsubscribe();
      store.dispose();
      patchStore.current = null;
      setPatches([]);
    };
  }, []);

  /**
   * Requests a patch for every hidden box that does not have a current one.
   *
   * Driven by the committed scene rather than by the hide action, so it also recovers
   * a patch after undo/redo and drops one the moment a box is moved or resized —
   * there is no second place tracking which boxes are hidden.
   */
  useEffect(() => {
    const store = patchStore.current;
    if (!store) return;
    const scene = snapshot.scene;
    // Both deliberate "stop showing this" intents: a box the user drew, and a scanned
    // object they deleted. `moved` and `removed` are excluded because they follow from
    // an edit rather than from an erasure the user asked for, and `carried` changes
    // every frame — each would spend a capture and an inference call on a region
    // nobody asked to have filled.
    const wanted = erasureVolumes(scene).filter(
      (v) => v.reason === 'manual' || v.reason === 'hidden',
    );
    const missing = store.reconcile(wanted, scene.frameId);
    setPatches(store.ready());
    for (const volume of missing) void store.request(volume, scene);
  }, [snapshot.scene]);

  /**
   * Why erasure is or is not happening, in one line.
   *
   * Something is marked for erasure and the screen does not change is the single most
   * confusing state this feature has, and until now it was silent — which is what left
   * the assistant improvising an explanation for it. The commit always succeeds; only
   * the PAINTING can fail, and that distinction belongs on screen.
   *
   * IT LEADS WITH THE PATCHES, because a patch is what actually covers a box. This line
   * used to report only the compositor, so it called the whole feature dead whenever the
   * native texture bridge was absent — while a patch was, or could have been, covering
   * the box perfectly well. The compositor is reported after, as the addition it is.
   */
  const erasureStatus = useMemo(() => {
    const count = erasure?.volumes.length ?? 0;
    if (!count) return null;
    const noun = `${count} region${count === 1 ? '' : 's'}`;
    if (!frame) return `${noun} hidden. Filling them in needs the camera.`;
    if (patches.length) {
      const generated = patches.filter((p) => p.fill === 'inpaint').length;
      const source =
        generated === patches.length
          ? 'a generated background'
          : generated
            ? `${generated} generated, the rest from the surrounding wall`
            : 'the surrounding wall';
      return `Covering ${patches.length} of ${noun} with ${source}.`;
    }
    // Nothing covered yet. Each of the following was true at some point while the
    // pixels did not move, and naming which one is false is the difference between
    // debugging this from a device and guessing at it.
    const s = compositorSample;
    if (!s) return `${noun} hidden. Capturing the wall behind — point the camera at it.`;
    if (!s.frame)
      return `${noun} hidden. The compositor is running but receiving no camera frames (rejected ${s.rejected}, errors ${s.errors}).`;
    if (!s.depth)
      return `${noun} hidden. No scene depth${
        depthInputs && !depthInputs.ok ? ` — ${depthInputs.reason}` : ''
      }, so only a drawn box can be bounded.`;
    const source = s.atlas ? 'the reconstructed background' : 'surrounding wall and floor colour';
    return `Erasing ${s.erased} region(s) from ${source} · frame ${Math.round(s.ageMs)}ms · ${s.planes} shell plane(s)${s.foreground ? '' : ' · no person mask'}${s.errors ? ` · ${s.errors} error(s)` : ''}`;
  }, [erasure, frame, patches, compositorSample, depthInputs]);
  const [frameDiagnostic, setFrameDiagnostic] = useState<FrameDiagnosticMode>('off');
  const nativeFrameSample = useRef<FrameDiagnosticSample | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  /**
   * The one line the interface still says out loud.
   *
   * Everything that used to be eight stacked Texts collapses to a headline and at most
   * one aside, ranked by what a person needs first: what the solver just did, then why
   * it could not, then whatever slow thing is happening behind the room.
   */
  const caption = snapshot.result?.message ?? message;
  const aside =
    snapshot.result?.conflicts[0] ??
    (snapshot.phase === 'held' && snapshot.previewValidity && !snapshot.previewValidity.ok
      ? snapshot.previewValidity.reason
      : null) ??
    patchNote ??
    erasureStatus ??
    // Unmeasured space must not read as measured space. It survived the cull because it
    // is the one caption that is a claim about truth rather than about progress.
    (snapshot.scene.provenance === 'inferred'
      ? 'Some walls were not measured directly. Placements against them are estimates.'
      : null);
  /**
   * Captions fade. A room you are standing in is the thing worth looking at, and a
   * sentence that never leaves is a sentence nobody reads twice.
   */
  const [shown, setShown] = useState(true);
  useEffect(() => {
    setShown(true);
    const timer = setTimeout(() => setShown(false), 7000);
    return () => clearTimeout(timer);
  }, [caption, aside]);
  const [gate, setGate] = useState<ScenarioResult[]>([]);
  const [gateRunning, setGateRunning] = useState<Scenario['milestone'] | null>(null);
  const [gateMilestone, setGateMilestone] = useState<Scenario['milestone'] | null>(null);
  const renderFps = useRef(0);
  const slot = useRef(new AdapterSlot<RealtimeVoice>(editor.diagnostics));
  // One owner for selection, destination and turn binding, shared by hands, touch and
  // voice. The React state below mirrors it for rendering; the coordinator is the source.
  const input = useRef(new InputCoordinator(editor));
  useEffect(() => {
    // 10Hz, unconditionally. Sampling only on change meant a stationary selection had no
    // recent sample for a speech turn to bind against.
    const timer = setInterval(() => {
      input.current.sample();
      /**
       * A pending arrangement is not part of the engine snapshot, so nothing re-renders
       * when one appears. It used to be mirrored by the touch restyle handler alone —
       * which meant a restyle asked for BY VOICE put the transaction into
       * awaiting_confirmation and then showed no way to confirm it. Read from the
       * editor here, where both paths end up.
       */
      setProposal(editor.pendingProposal()?.explanation ?? null);
      // The SCP needs a viewpoint. Taken from the same tracked frame the renderer uses,
      // converted into room space once here rather than in the packet builder.
      const tracked = frame?.current;
      if (tracked) {
        const toRoom = roomFromWorld(tracked.roomAnchor, origin ?? [0, 0, 0]);
        const eye = applyToPoint(toRoom, {
          x: tracked.cameraToWorld[12] ?? 0,
          y: tracked.cameraToWorld[13] ?? 0,
          z: tracked.cameraToWorld[14] ?? 0,
        });
        // Camera forward is -Z of the pose, rotated into room space.
        const f = { x: -(tracked.cameraToWorld[8] ?? 0), y: -(tracked.cameraToWorld[9] ?? 0), z: -(tracked.cameraToWorld[10] ?? 0) };
        const rotated = {
          x: toRoom[0]! * f.x + toRoom[4]! * f.y + toRoom[8]! * f.z,
          y: toRoom[1]! * f.x + toRoom[5]! * f.y + toRoom[9]! * f.z,
          z: toRoom[2]! * f.x + toRoom[6]! * f.y + toRoom[10]! * f.z,
        };
        const hand = tracked.hand;
        input.current.setView({
          position: [eye.x, eye.y, eye.z],
          forward: [rotated.x, rotated.y, rotated.z],
          fovDeg: 68,
          screenPoint: hand?.x !== undefined && hand.y !== undefined ? [hand.x, hand.y] : [0.5, 0.5],
          pointingConfidence: hand?.confidence ?? 1,
          pointingSource: hand?.visible ? 'hand' : 'phone',
        });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [frame, origin]);
  useEffect(
    () =>
      input.current.subscribe(() => {
        setSelected(input.current.getSelection());
        setDestination(input.current.getDestination());
      }),
    [],
  );
  useEffect(() => {
    const coordinator = input.current;
    return () => coordinator.dispose();
  }, []);
  // One clock everywhere: epoch milliseconds. Attention binds against this.
  const context = useRef<InteractionContext>({
    turnId: 'manual',
    clock: 'epoch',
    timestamp: Date.now(),
    revision: snapshot.scene.revision,
    frameId: snapshot.scene.frameId,
    selectedId: selected,
    destination,
    viewer: null,
  });
  const sync = (patch: Partial<InteractionContext> = {}) => {
    context.current = { ...context.current, timestamp: Date.now(), ...patch };
    editor.attention.push(context.current);
    slot.current.active?.setContext(context.current);
    return context.current;
  };
  useEffect(() => {
    if (!dev) return;
    const timer = setInterval(() => refreshDiagnostics((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, [dev]);
  useEffect(() => {
    // frameId was initialised once at mount and never refreshed, so a re-measure
    // without a remount made every attention bind miss with `other_frame` and every
    // intent fail as stale. It is part of scene identity and has to track the scene.
    sync({
      revision: snapshot.scene.revision,
      frameId: snapshot.scene.frameId,
      selectedId: selected,
      destination,
    });
  }, [selected, destination, snapshot.scene.revision, snapshot.scene.frameId]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (s) => {
      if (s !== 'active') {
        setFrameDiagnostic('off');
        editor.engine.setTracking(false);
        void slot.current.dispose();
        setActivity('offline');
      } else {
        // Voice came up on its own when the editor opened; it has to come back the same
        // way. Backgrounding tears the session down, and without this the one button
        // returns dead and the app looks like it stopped listening on purpose.
        if (!slot.current.active) void connect();
        // Resume from what the AR session actually reports, not from the absence of a
        // frame ref. `!frame` is false for every real session, so editing stayed dead
        // after any backgrounding until the panel remounted. With no tracked frame at
        // all (the development room) there is nothing to lose tracking, so resume.
        editor.engine.setTracking(!frame || frame.current?.tracking === 'normal');
      }
    });
    return () => {
      subscription.remove();
      void slot.current.dispose();
    };
  }, [editor, frame]);
  useEffect(() => {
    if (!handFrame) return;
    let raf = 0,
      last = -1,
      pinched = false;
    const tick = () => {
      const hand = handFrame.current;
      if (hand && hand.timestamp !== last) {
        last = hand.timestamp;
        setCursor(
          hand.hand?.x !== undefined && hand.hand.y !== undefined
            ? { x: hand.hand.x, y: hand.hand.y }
            : null,
        );
        const state = editor.engine.getSnapshot();
        const carriedId = state.phase === 'held' ? state.preview?.targetId : undefined;
        const hit = resolveHand(hand, state.scene, origin ?? [0, 0, 0], carriedId),
          down = !!hand.hand?.pinching;
        if (!hit && hand.hand?.x === undefined) setDestination(null);
        // An object hit is a destination only when it can actually carry the load.
        const asDestination =
          hit && (!hit.objectId || canSupport(state.scene, carriedId, hit.objectId))
            ? {
                position: hit.position,
                surfaceId: hit.surfaceId,
                kind: hit.objectId ? ('object' as const) : ('surface' as const),
              }
            : null;
        if (asDestination) input.current.point(asDestination, 'hand');
        if (down && !pinched && hit?.objectId && state.phase !== 'held') {
          input.current.select(hit.objectId, 'hand');
          sync({ selectedId: hit.objectId });
          editor.engine.begin(hit.objectId);
        }
        // Point-and-dwell: holding a target for 500ms selects it without a pinch.
        if (!down && state.phase !== 'held')
          input.current.dwell(hit?.objectId ?? null, hand.tracking === 'normal');
        if (down && state.phase === 'held' && asDestination && state.preview)
          editor.engine.preview({ position: asDestination.position, yaw: state.preview.pose.yaw });
        // Only a held transaction may be released; a settle in flight must not be re-entered.
        if (
          hand.hand?.x !== undefined &&
          !down &&
          pinched &&
          state.phase === 'held' &&
          context.current.destination
        )
          void editor.engine.release(editor.nextId(), context.current.destination.surfaceId);
        if (hand.hand?.x === undefined && pinched) editor.engine.cancel();
        pinched = down;
        // The coordinator owns the destination and times it; re-latching the previous
        // one here every frame kept a stale destination alive forever, which is what the
        // two-second freshness rule exists to prevent.
        sync({ destination: input.current.getDestination() });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [editor, handFrame, origin]);
  /** One runner for both gates. The M2 and M3 suites differ only in which scenarios
   * they select, so duplicating the button would let one drift behind the other. */
  async function runGate(milestone: Scenario['milestone']) {
    setGateRunning(milestone);
    setGateMilestone(milestone);
    try {
      const results: ScenarioResult[] = [];
      for (const scenario of scenariosFor(milestone)) results.push(await runScenario(scenario));
      // Repeating a solver-heavy scenario is the only check that a result was reasoned
      // rather than sampled.
      const repeatable = scenariosFor(milestone).find(
        (s) =>
          s.id ===
          {
            M2: 'overlap',
            M3: 'carry-adjust',
            M4: 'calib-inferred',
            M6: 'input-ordering',
            M7: 'plan-deterministic',
            M8: 'm8-frame-identity',
          }[
            milestone
          ],
      );
      if (repeatable) {
        const repeat = await checkDeterminism(repeatable);
        results.push({ id: 'determinism', title: 'Determinism', steps: [repeat], ok: repeat.ok });
      }
      setGate(results);
    } finally {
      setGateRunning(null);
    }
  }
  async function run(intent: Intent | unknown) {
    try {
      const result = await editor.intent(intent, context.current);
      setMessage([result.message, ...result.conflicts].join(' '));
    } catch {
      setMessage('That edit could not be applied.');
    }
  }
  /**
   * Bring the microphone up.
   *
   * Called once on entry rather than waiting to be asked. The room is edited by talking
   * to it; a voice-first app whose first required act is finding the button that turns
   * voice on has the wrong first act. A failure here is reported and left alone — touch
   * still selects and carries, and retrying on a loop would hammer a server that has
   * already said no.
   */
  const connect = async () => {
    setActivity('connecting');
    try {
      await slot.current.replace(
        () => new RealtimeVoice(apiURL(), editor.diagnostics, input.current, setMessage, setActivity),
      );
      slot.current.active?.setMuted(muted);
    } catch (error) {
      setActivity('offline');
      setMessage(error instanceof Error ? error.message : 'Voice unavailable.');
    }
  };
  /**
   * The one button.
   *
   * Mute is not disconnect: the session, its tools and the conversation so far all
   * survive, and only the audio track is disabled. Pressing it while offline is read as
   * "start" instead, so a connection that failed has a way back without a second control
   * that would exist purely to say the first one is broken.
   */
  function toggleMute() {
    const voice = slot.current.active;
    if (!voice || activity === 'offline') {
      if (activity !== 'connecting') void connect();
      return;
    }
    const next = !muted;
    setMuted(next);
    voice.setMuted(next);
  }
  // Voice comes up with the editor. Deliberately not awaited: the room is usable the
  // moment it is measured, and it must not wait on a network round trip to become so.
  useEffect(() => {
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * What "export a blueprint" and "end the session" do when spoken.
   *
   * The two buttons left and the two spoken forms land in the same place, so neither can
   * drift from the other. Registered against the editor rather than handled inside it
   * because neither one touches the room.
   */
  useEffect(
    () =>
      editor.onAppAction((action) => {
        if (action === 'export_blueprint') openBlueprint();
        else confirmExit();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );
  /**
   * The plan of the room as it is, rebuilt whenever the room changes.
   *
   * Only while the development sheet is open. `buildPlan` is cheap but it is not free,
   * and a page nobody is looking at is a page worth not drawing on every committed edit.
   */
  const devPlan = useMemo(
    () => (dev ? previewSheet(snapshot.scene) : null),
    [dev, snapshot.scene],
  );
  /**
   * A shape dragged on the plan, turned into a request to move the object.
   *
   * Relative, not absolute: the drag knows how far the finger went, and only the scene
   * knows where the object started. `pose.position` names different corners of the box
   * for different pivots, so adding a delta is exact where reading a centroid off the
   * drawing would quietly shift anything pivoted on its back edge.
   *
   * It goes through `point` and `run` — the same destination and the same intent a tap
   * in the 3D view produces — so the solver validates this exactly as it validates
   * everything else, and can adjust it, hold it for a yes, or refuse it.
   */
  async function movePlan(id: string, delta: [number, number]) {
    const scene = editor.engine.getSnapshot().scene;
    const object = scene.design.objects.find((o) => o.id === id);
    const floor = scene.design.surfaces.find((s) => s.class === 'floor' && s.state === 'present');
    if (!object || !floor) {
      setMessage('That shape is not something the plan can move.');
      return;
    }
    point(
      [
        (object.pose.position[0] ?? 0) + delta[0],
        object.pose.position[1] ?? 0,
        (object.pose.position[2] ?? 0) + delta[1],
      ],
      floor.id,
    );
    await run({ action: 'move', target_id: id });
  }
  function openBlueprint() {
    setBlueprintNote('');
    setBlueprint(
      previewSheet(editor.engine.getSnapshot().scene, {
        title:
          editor.engine.getSnapshot().scene.provenance === 'sample'
            ? 'DEVELOPMENT ROOM'
            : 'FLOOR PLAN',
      }),
    );
  }
  function confirmExit() {
    Alert.alert('End session?', 'The room and everything in it will be discarded.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'End session', style: 'destructive', onPress: onExit },
    ]);
  }
  /**
   * Swipe down from the top to leave.
   *
   * On the ROOT, in the CAPTURE phase, rather than on an invisible strip laid over the
   * scene. An overlay would have been simpler and wrong: React Native hit-tests to the
   * topmost view and then negotiates UPWARDS, so a sibling underneath never gets a
   * second chance — the strip would have silently eaten every tap on an object in the
   * top of the view, which is most of the room when you are standing in it. Capturing
   * from the ancestor leaves the scene as the responder for everything else and takes
   * over only once the gesture has proved to be this one.
   *
   * Never while carrying. Dragging an object downhill from the top of the screen is a
   * real thing to be doing, and it must not be read as wanting to throw the room away.
   *
   * Both values are read through refs because the responder is built once: closing over
   * the first render's snapshot would ask whether the object was held a minute ago.
   */
  /**
   * Two fingers move the camera; one finger moves the furniture.
   *
   * The split is what makes both possible at once. A single finger already means select,
   * point and carry, so the view had to claim a gesture that could never be one of those
   * — and it claims it in the CAPTURE phase on the scene's own container, so a one-finger
   * touch is never intercepted on its way to the object underneath.
   *
   * Only where the phone is not already the camera. In the live view ARKit owns the pose
   * and a dragged one would be overwritten sixty times a second while fighting it.
   */
  const orbit = useRef(restingOrbit());
  const orbitable = useRef(false);
  orbitable.current = !frame;
  const grip = useRef({ x: 0, y: 0, spread: 0, live: false });
  const reading = (touches: readonly { pageX: number; pageY: number }[]) => {
    const a = touches[0]!;
    const b = touches[1]!;
    return {
      x: (a.pageX + b.pageX) / 2,
      y: (a.pageY + b.pageY) / 2,
      spread: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
    };
  };
  const clamp = (value: number, low: number, high: number) =>
    value < low ? low : value > high ? high : value;
  const look = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) =>
        orbitable.current && event.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponderCapture: (event) =>
        orbitable.current && event.nativeEvent.touches.length >= 2,
      // Never hand the gesture back mid-orbit: the canvas below would otherwise take it
      // the moment one finger drifts, and the room would jump as a carry began.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        if (event.nativeEvent.touches.length < 2) return;
        grip.current = { ...reading(event.nativeEvent.touches), live: true };
      },
      onPanResponderMove: (event) => {
        const touches = event.nativeEvent.touches;
        // A finger lifted and came back. Re-seat rather than applying the jump between
        // a two-finger centroid and a one-finger one, which is half the screen.
        if (touches.length < 2) {
          grip.current.live = false;
          return;
        }
        const now = reading(touches);
        if (!grip.current.live) {
          grip.current = { ...now, live: true };
          return;
        }
        const seat = orbit.current;
        /**
         * Slower than a mouse, because two fingers have less room than a mouse.
         *
         * A swipe across the screen turns about 130 degrees and tilts through maybe half
         * the usable range. Desktop orbit controls map a screen height to a full circle;
         * at that rate a thumb-and-finger drag spins the room twice and you lose which
         * wall you were looking at.
         */
        seat.azimuth -= (now.x - grip.current.x) * 0.006;
        // Drag down and the room tips towards you, showing more of its top.
        seat.elevation = clamp(
          seat.elevation + (now.y - grip.current.y) * 0.003,
          ORBIT_LIMITS.minElevation,
          ORBIT_LIMITS.maxElevation,
        );
        if (grip.current.spread > 12 && now.spread > 12)
          seat.distance = clamp(
            seat.distance * (grip.current.spread / now.spread),
            ORBIT_LIMITS.minDistance,
            ORBIT_LIMITS.maxDistance,
          );
        grip.current = { ...now, live: true };
      },
      onPanResponderRelease: () => {
        grip.current.live = false;
      },
      onPanResponderTerminate: () => {
        grip.current.live = false;
      },
    }),
  ).current;

  const held = useRef(snapshot.phase);
  held.current = snapshot.phase;
  const exit = useRef(() => {});
  exit.current = confirmExit;
  const dismiss = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: (event, gesture) =>
        // One finger. Two is the camera, and a two-finger drag downwards from the top of
        // the screen is an ordinary way to look at the ceiling, not a request to throw
        // the room away.
        event.nativeEvent.touches.length === 1 &&
        held.current !== 'held' &&
        gesture.y0 < 110 &&
        gesture.dy > 40 &&
        Math.abs(gesture.dy) > Math.abs(gesture.dx) * 2,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > 90) exit.current();
      },
    }),
  ).current;
  function point(position: Vec3, surfaceId: string, kind: 'surface' | 'object' = 'surface') {
    const next = { position, surfaceId, kind };
    // Through the coordinator, which notifies the mirror above. Pointing at a
    // destination never changes the selection.
    input.current.point(next, 'touch');
    sync({ destination: next });
    if (snapshot.phase === 'held' && snapshot.preview)
      editor.engine.preview({ position, yaw: snapshot.preview.pose.yaw });
  }
  function release() {
    if (editor.engine.getSnapshot().phase === 'held' && context.current.destination)
      void editor.engine.release(editor.nextId(), context.current.destination.surfaceId);
  }
  return (
    <View style={styles.root} {...dismiss.panHandlers}>
      <View
        style={styles.scene}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSceneSize({ width, height });
        }}
        {...look.panHandlers}
      >
        <SceneView
          orbit={orbit}
          snapshot={snapshot}
          selectedId={selected}
          onSelect={(id) => input.current.select(id, 'touch')}
          onPoint={point}
          onRelease={release}
          frame={frame}
          origin={origin}
          diagnostics={dev}
          frameDiagnostic={dev ? frameDiagnostic : 'off'}
          onFrameDiagnostic={sample => { nativeFrameSample.current = sample; }}
          shell={reconstruction?.state === 'ready' ? reconstruction.shell : null}
          showShell={showShell}
          atlasUri={reconstruction?.state === 'ready' ? reconstruction.atlasUri : null}
          erasure={erasure}
          patches={patches}
          onCompositor={setCompositorSample}
          onRenderFps={(fps) => {
            renderFps.current = fps;
          }}
        />
      </View>
      {cursor && sceneSize && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: cursor.x * sceneSize.width - 10,
            top: cursor.y * sceneSize.height - 10,
            width: 20,
            height: 20,
            borderRadius: 10,
            borderWidth: 2,
            borderColor: '#8bd0ff',
          }}
        />
      )}
      {/* WHAT IS LEFT OF THE INTERFACE.
          The room is the interface; this is the little that cannot be said out loud.
          `box-none` so every tap that is not on a control still reaches the scene, which
          is how an object gets selected now that selecting one shows no buttons. */}
      <View style={styles.hud} pointerEvents="box-none">
        {shown && caption !== '' && (
          <GlassPanel style={styles.caption}>
            <Text style={styles.captionText}>{caption}</Text>
            {aside !== null && <Text style={styles.captionAside}>{aside}</Text>}
          </GlassPanel>
        )}
        {/* A QUESTION, NOT A CONTROL. The solver holds an adjustment of 5cm or more for
            a yes, and "yes" is a thing you say — but a held operation with no visible
            way to answer it is a dead end whenever voice is muted or never connected.
            It shows only while something is actually waiting. */}
        {(proposal !== null || snapshot.pending !== null) && (
          <GlassPanel style={styles.caption}>
            <Text style={styles.captionText}>
              {proposal ?? snapshot.pending?.report?.adjustment_reason ?? 'Apply that adjustment?'}
            </Text>
            <View style={styles.answers}>
              {/* One handler for both kinds of waiting. The coordinator checks a parked
                  arrangement first and falls through to the engine's held operation, so
                  the button cannot answer the wrong question. Neither branch clears the
                  prompt optimistically: it is read from the editor, and blanking it here
                  would only make it flicker back on the next poll. */}
              <Pressable
                accessibilityRole="button"
                onPress={() => void input.current.confirm().then((r) => setMessage(r.message))}
              >
                <Text style={styles.answer}>Yes</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void run({ action: 'cancel' })}
              >
                <Text style={styles.answerDim}>No</Text>
              </Pressable>
            </View>
          </GlassPanel>
        )}
        <GlassCluster style={styles.cluster} spacing={28}>
          <GlassCircle
            size={78}
            accessibilityLabel={muted ? 'Unmute the microphone' : 'Mute the microphone'}
            tintColor={activity === 'hearing' ? 'rgba(90,190,255,0.28)' : undefined}
            onPress={() => toggleMute()}
            // The diagnostics, the gates and the JSON console still exist; they just no
            // longer occupy the screen of someone using the app.
            onLongPress={__DEV__ ? () => setDev(!dev) : undefined}
          >
            <VoiceIcon activity={activity} />
          </GlassCircle>
          <GlassCircle
            size={62}
            accessibilityLabel="Export a blueprint of this room"
            onPress={openBlueprint}
          >
            <SymbolView name="ruler" size={25} tintColor="#e8f0fb" />
          </GlassCircle>
          {/* TAKE THE MEASURED ROOM SOMEWHERE ELSE.
              A scan is finished standing in the room and thought about on a sofa, where
              the live view shows furniture registered to walls that are not in front of
              you. This swaps the camera for the three-quarter view and the plan — the
              development room, holding your room. Never offered for the sample room,
              which has no camera to leave. */}
          {onDetach && snapshot.scene.provenance !== 'sample' && (
            <GlassCircle
              size={62}
              accessibilityLabel={
                detached ? 'Return to the live view' : 'Edit this room away from the room'
              }
              onPress={() => {
                onDetach(!detached);
                setMessage(
                  detached
                    ? 'Back in the room. Point at things again.'
                    : 'Two fingers to look around, one to move things. Long-press the microphone for the drawing.',
                );
              }}
            >
              <SymbolView
                name={detached ? 'arkit' : 'cube.transparent'}
                size={25}
                tintColor="#e8f0fb"
              />
            </GlassCircle>
          )}
          {/* THE WAY OUT OF THE DEVELOPMENT ROOM, BY TAP.
              Only there. Swiping down returns to the welcome screen, which is a gesture
              you have to know about, and from the sample room the thing you almost
              always want next is to measure a real one — so this does both at once.
              Deliberately absent from a real session: it discards the room, and a
              button that throws away a scan does not belong next to one that saves it. */}
          {onScan && snapshot.scene.provenance === 'sample' && (
            <GlassCircle
              size={62}
              accessibilityLabel="Leave the development room and scan a real one"
              onPress={onScan}
            >
              <SymbolView name="viewfinder" size={25} tintColor="#e8f0fb" />
            </GlassCircle>
          )}
        </GlassCluster>
      </View>
        {__DEV__ && dev && (
          <View style={styles.devSheet}>
            {/* THE PLAN, LIVE. Open the development sheet and the room is also a
                drawing — one that can be touched. */}
            {devPlan && (
              <View style={styles.devPlan}>
                <BlueprintEditor
                  sheet={devPlan}
                  selectedId={selected}
                  onSelect={(id) => input.current.select(id, 'touch')}
                  onMove={(id, delta) => void movePlan(id, delta)}
                />
              </View>
            )}
            <ScrollView contentContainerStyle={styles.dev}>
            {(() => {
              const report = evaluateSpatialFrame(frame?.current ?? null, sceneSize);
              const nativeHand = handFrame?.current?.hand;
              const integrationChecks = [
                {
                  name: 'R3F render cadence',
                  ok: renderFps.current >= 20,
                  detail: `${renderFps.current.toFixed(1)} fps`,
                },
                {
                  name: 'camera continuity',
                  ok: spatialOwner?.includes('retained') ?? false,
                  detail: spatialOwner ?? 'no ownership event',
                },
                {
                  name: 'hand targeting',
                  ok: !!nativeHand?.visible && (nativeHand?.confidence ?? 0) >= 0.35,
                  detail: nativeHand
                    ? `${nativeHand.visible ? 'visible' : 'not visible'}, confidence ${nativeHand.confidence.toFixed(2)}`
                    : 'no Vision sample',
                },
              ];
              const ready = report.ready && integrationChecks.every((check) => check.ok);
              return (
                <>
                  <Text style={[styles.detail, ready ? styles.good : styles.error]}>
                    M1 live gate: {ready ? 'instrumented checks ready' : 'needs attention'}
                  </Text>
                  {[...report.checks, ...integrationChecks].map((check) => (
                    <Text key={check.name} style={styles.detail}>
                      {check.ok ? '✓' : '×'} {check.name}: {check.detail}
                    </Text>
                  ))}
                </>
              );
            })()}
            <Text style={styles.detail}>
              Settling: {editor.moduleIds.settling} · Voice: {slot.current.active?.id ?? 'off'} ·
              Revision {snapshot.scene.revision}
            </Text>
            <Text style={styles.detail}>
              Spatial: {frame?.current?.tracking ?? 'no frame'}
              {frame?.current ? ` (${frame.current.trackingReason})` : ''} · camera{' '}
              {frame?.current ? `${frame.current.fps.toFixed(1)} fps` : 'inactive'} · frame{' '}
              {frame?.current
                ? `${Date.now() - (frame.current.receivedAt ?? Date.now())} ms ago`
                : '—'}
            </Text>
            {frame?.current && (
              <Text style={styles.detail}>
                Mapping {frame.current.worldMapping} · thermal {frame.current.thermalState} · memory
                warnings {frame.current.memoryWarnings}
              </Text>
            )}
            <Text style={styles.detail}>
              Camera ownership: {spatialOwner ?? 'development scene'}
            </Text>
            {frame && (
              <>
                <Text style={styles.detail}>
                  M8 native-frame feasibility only — live erasure unavailable until device acceptance.
                  {!textureBridgeAvailable() ? ' Rebuild the native app to enable the texture bridge.' : ''}
                </Text>
                {(['off', 'camera', 'depth', 'confidence', 'foreground'] as const).map(mode => (
                  <Button key={mode} title={`M8 ${mode}${frameDiagnostic === mode ? ' ✓' : ''}`}
                    disabled={!textureBridgeAvailable() && mode !== 'off'}
                    onPress={() => { setShowShell(false); setFrameDiagnostic(mode); }} />
                ))}
                {nativeFrameSample.current && <Text style={styles.detail}>
                  Native frame age: {Number.isFinite(nativeFrameSample.current.ageMs) ? nativeFrameSample.current.ageMs.toFixed(0) : 'unavailable'} ms · leases {nativeFrameSample.current.leasedSlots}/3 · dropped {nativeFrameSample.current.dropped} · rejected {nativeFrameSample.current.rejected} · errors {nativeFrameSample.current.errors} · depth {nativeFrameSample.current.depth ? 'yes' : 'no'} · foreground {nativeFrameSample.current.foreground ? 'yes' : 'no'}
                </Text>}
              </>
            )}
            <Text style={styles.detail}>
              Viewport:{' '}
              {frame?.current
                ? `${frame.current.viewportWidth}×${frame.current.viewportHeight} ${frame.current.orientation}`
                : 'sample scene'}{' '}
              · hand {handFrame?.current?.hand?.visible ? 'visible' : 'not visible'}
            </Text>
            {handFrame?.current?.hand && (
              <>
                <Text style={styles.detail}>
                  Hand confidence {handFrame.current.hand.confidence.toFixed(2)} · pinch{' '}
                  {handFrame.current.hand.pinching ? 'closed' : 'open'} · Vision{' '}
                  {handFrame.current.hand.processed} processed / {handFrame.current.hand.dropped} dropped
                  {' · '}{handFrame.current.hand.latencyMs.toFixed(0)} ms
                </Text>
                {/* Names the stage that is failing. Without this a dead cursor looks the
                    same whether Vision found nothing, found a hand whose point landed
                    off-screen, or found one below the activation gate. */}
                {(() => {
                  const h = handFrame.current!.hand!;
                  const [reason, bad] = !h.detected
                    ? ['Vision found no hand in this frame', true]
                    : h.inView === false
                      ? [
                          `fingertip mapped OUTSIDE the viewport at ${h.displayX?.toFixed(2)}, ${h.displayY?.toFixed(2)} — orientation or viewport is wrong`,
                          true,
                        ]
                      : !h.visible
                        ? [
                            `seen at confidence ${(h.rawConfidence ?? 0).toFixed(2)}, below the 0.60 needed to activate`,
                            true,
                          ]
                        : ['tracking the fingertip', false];
                  return (
                    <Text style={bad ? styles.error : styles.good}>Hand: {reason}</Text>
                  );
                })()}
                <Text style={styles.detail}>
                  Fingertip raw {handFrame.current.hand.rawX?.toFixed(2) ?? '—'},
                  {handFrame.current.hand.rawY?.toFixed(2) ?? '—'} · display{' '}
                  {handFrame.current.hand.displayX?.toFixed(2) ?? '—'},
                  {handFrame.current.hand.displayY?.toFixed(2) ?? '—'} · smoothed{' '}
                  {handFrame.current.hand.x?.toFixed(2) ?? '—'},
                  {handFrame.current.hand.y?.toFixed(2) ?? '—'}
                </Text>
              </>
            )}
            {/* The gate that silently killed hand targeting once before: resolveHand
                refuses any frame whose coordinate frame is not the scene's. */}
            <Text
              style={[
                styles.detail,
                frame?.current && frame.current.frameId !== snapshot.scene.frameId
                  ? styles.error
                  : styles.good,
              ]}
            >
              Frame identity:{' '}
              {!frame?.current
                ? 'no tracked frame'
                : frame.current.frameId === snapshot.scene.frameId
                  ? 'live frames match the scene'
                  : `MISMATCH — scene ${snapshot.scene.frameId.slice(0, 8)}, live ${frame.current.frameId.slice(0, 8)}; hand targeting is disabled`}
            </Text>
            <Text style={styles.detail}>
              Alignment markers: red is the AR origin; green points are measured floor boundaries.
            </Text>
            <Text style={[styles.detail, gate.length && gate.every((g) => g.ok) ? styles.good : styles.error]}>
              {gateMilestone ?? 'M2/M3'} gate:{' '}
              {gate.length
                ? `${gate.filter((g) => g.ok).length}/${gate.length} scenarios pass`
                : 'not run'}
            </Text>
            {onSaveCapture && (
              <Button
                title="Save capture as fixture"
                onPress={() => setMessage(onSaveCapture())}
              />
            )}
            <View style={styles.row}>
              {(['M2', 'M3', 'M4', 'M6', 'M7', 'M8'] as const).map((milestone) => (
                <Button
                  key={milestone}
                  title={gateRunning === milestone ? 'Running…' : `Run ${milestone} gate`}
                  disabled={gateRunning !== null}
                  onPress={() => void runGate(milestone)}
                />
              ))}
            </View>
            {gate.map((result) => (
              <View key={result.id}>
                <Text style={[styles.detail, result.ok ? styles.good : styles.error]}>
                  {result.ok ? '✓' : '×'} {result.title}
                </Text>
                {result.steps.map((step, i) => (
                  <Text key={`${result.id}-${i}`} style={styles.detail}>
                    {'   '}
                    {step.ok ? '✓' : '×'} {step.label} — {step.detail}
                  </Text>
                ))}
              </View>
            ))}
            <TextInput
              style={styles.input}
              multiline
              value={json}
              onChangeText={setJSON}
              autoCapitalize="none"
            />
            <Button
              title="Apply command"
              onPress={() => {
                try {
                  void run(JSON.parse(json));
                } catch {
                  setMessage('Invalid JSON.');
                }
              }}
            />
            {events.slice(-4).map((e, i) => (
              <Text key={i} style={styles.detail}>
                {e.stage} / {e.code} / r{e.revision ?? '-'}
              </Text>
            ))}
            </ScrollView>
          </View>
        )}
      <Modal
        visible={blueprint !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setBlueprint(null)}
      >
        <View style={styles.sheetRoot}>
          <View style={styles.top}>
            <Text style={styles.title}>Blueprint</Text>
            <Pressable onPress={() => setBlueprint(null)}>
              <Text style={styles.link}>Close</Text>
            </Pressable>
          </View>
          {blueprint && (
            <>
              {/* Fixed to the page's own aspect ratio. A preview that reflows is a
                  preview of a different drawing. */}
              <View style={styles.page}>
                <BlueprintView sheet={blueprint} style={StyleSheet.absoluteFill} />
              </View>
              <Text style={styles.detail}>
                A4 landscape at {blueprint.scaleLabel}. Drawn from the room as it is now,
                including everything added in this session.
              </Text>
              {blueprintNote !== '' && <Text style={styles.detail}>{blueprintNote}</Text>}
              {!blueprintAvailable() ? (
                <Text style={styles.error}>
                  This development build cannot write a PDF. The preview above is the whole
                  drawing; rebuild the app to export it.
                </Text>
              ) : exporting ? (
                <View style={styles.row}>
                  <ActivityIndicator color="#9dccff" />
                  <Text style={styles.detail}>Drawing the page…</Text>
                </View>
              ) : (
                <GlassPill
                  label="Export PDF"
                  onPress={() => {
                    setExporting(true);
                    setBlueprintNote('');
                    // The sheet on screen, not a fresh one: what was previewed is what
                    // gets exported even if a voice command moved something meanwhile.
                    void exportBlueprint(blueprint, {
                      title: snapshot.scene.provenance === 'sample' ? 'DEVELOPMENT ROOM' : 'FLOOR PLAN',
                    })
                      .then((result) =>
                        setBlueprintNote(
                          result.shared ? 'Shared.' : 'Saved to the app\u2019s cache and offered for sharing.',
                        ),
                      )
                      .catch((error: unknown) =>
                        setBlueprintNote(
                          error instanceof Error ? error.message : 'The blueprint could not be exported.',
                        ),
                      )
                      .finally(() => setExporting(false));
                  }}
                />
              )}
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}
/**
 * The microphone, showing what it is doing.
 *
 * Four states a person can act on, and one that is only ever briefly true. `waveform`
 * is a layered symbol, so the variable-colour animation runs through its bars — which is
 * what makes "it can hear me" visible at arm's length rather than a colour change nobody
 * notices. A muted microphone is never animated: it has nothing to show.
 */
function VoiceIcon({ activity }: { activity: VoiceActivity }) {
  if (activity === 'connecting') return <ActivityIndicator color="#e8f0fb" />;
  if (activity === 'muted')
    return <SymbolView name="mic.slash.fill" size={27} tintColor="#ff9d8c" />;
  if (activity === 'offline') return <SymbolView name="mic.fill" size={27} tintColor="#8598ad" />;
  if (activity === 'listening')
    return <SymbolView name="mic.fill" size={27} tintColor="#e8f0fb" />;
  return (
    <SymbolView
      name="waveform"
      size={28}
      tintColor={activity === 'hearing' ? '#6fd0ff' : '#b9d4ec'}
      animationSpec={{
        repeating: true,
        variableAnimationSpec: { iterative: true, dimInactiveLayers: true },
      }}
    />
  );
}

/** A destination on another object is only offered when that object can carry it.
 * Goes through `bearingFor` so a scanned desk is offered on the same terms as one the
 * user added; checking `assemblies` directly excluded every measured object. */
function canSupport(
  scene: EditorState,
  carriedId: string | undefined,
  targetId: string,
): boolean {
  if (!carriedId || carriedId === targetId) return false;
  const target = scene.design.objects.find((o) => o.id === targetId);
  if (!target || !bearingFor(scene, target)) return false;
  const carried = scene.design.objects.find((o) => o.id === carriedId);
  if (!carried) return false;
  const [w, h, d] = carried.dimensions;
  return (w ?? 0) * (d ?? 0) <= 0.4 && (h ?? 0) <= 0.6;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scene: { ...StyleSheet.absoluteFill },
  top: { padding: 20, flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: 'white', fontWeight: '600', fontSize: 22 },
  link: { color: '#9dccff' },
  hud: { marginTop: 'auto', alignItems: 'center', paddingBottom: 34, gap: 14 },
  caption: {
    maxWidth: 340,
    marginHorizontal: 20,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 22,
    overflow: 'hidden',
    gap: 6,
  },
  captionText: { color: '#ffffff', fontSize: 16, lineHeight: 22, textAlign: 'center', fontWeight: '500' },
  captionAside: { color: '#cfe0f1', fontSize: 13, lineHeight: 18, textAlign: 'center' },
  answers: { flexDirection: 'row', justifyContent: 'center', gap: 28, paddingTop: 4 },
  answer: { color: '#9ed6ff', fontSize: 17, fontWeight: '700' },
  answerDim: { color: '#c3d2e2', fontSize: 17, fontWeight: '500' },
  cluster: { alignItems: 'center', gap: 14 },
  devSheet: {
    position: 'absolute',
    top: 60,
    bottom: 130,
    left: 12,
    right: 12,
    backgroundColor: '#0b1422f2',
    borderRadius: 18,
    overflow: 'hidden',
  },
  devPlan: { padding: 10, paddingBottom: 4 },
  text: { color: '#f6fafe', fontSize: 15 },
  detail: { color: '#c6d6e6', fontSize: 13 },
  error: { color: '#ffb7a6', fontSize: 13 },
  good: { color: '#6de0ad' },
  row: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#3b516d', borderRadius: 18, padding: 10 },
  dev: { gap: 8 },
  sheetRoot: { flex: 1, backgroundColor: '#0c1420', padding: 16, gap: 12 },
  page: { aspectRatio: 842 / 595, backgroundColor: '#ffffff', borderRadius: 4, overflow: 'hidden' },
  input: {
    color: 'white',
    borderColor: '#506784',
    borderWidth: 1,
    padding: 8,
    fontFamily: 'Courier',
  },
});
