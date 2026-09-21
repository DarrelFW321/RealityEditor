import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassPanel, GlassPill } from '../src/components/Glass';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import { sampleRoom } from '@reality/dev-scenarios';
import { EditorPanel } from '../src/components/EditorPanel';
import { createEditor, type Editor } from '../src/runtime/editor';
import { loadObjectCatalog } from '../src/adapters/object-catalog';
import {
  SpatialView,
  spatialSupported,
  roomToSession,
  parseKeyframe,
  type TrackedFrame,
} from '../src/adapters/roomplan';
import type { Keyframe } from '@reality/contracts';
import { CoverageTracker, reconstructionRoom, type CoverageMask } from '@reality/spatial-engine';
import { ReconstructionRun, type ReconstructionPhase } from '../src/runtime/reconstruction';
import type { Vec3 } from '@reality/contracts';
import { apiURL } from '../src/runtime/api-url';

const roomSweepDegrees = 270;

export default function Home() {
  // THE STATES THE PRD NAMES, NOT THE ONES THE CAMERA HAPPENS TO HAVE.
  //
  // "Calibration has visible states: observing, needs another view, reconstructing, ready,
  // and failed/retry." `needs_view` and `failed` are the two that were missing: coverage had
  // no way to ask for anything, and every failure silently reset the sweep to zero.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [phase, setPhase] = useState<
    | 'welcome'
    | 'observing'
    | 'needs_view'
    /** Room built, not yet committed to an editor. The only point a second pass is safe. */
    | 'scanned'
    | 'reconstructing'
    | 'failed'
    | 'edit'
  >('welcome');
  const [message, setMessage] = useState(
    'Turn slowly, then show the room’s floor edges and obscured corners.',
  );
  const [spatialOwner, setSpatialOwner] = useState('Vision Camera not started.');
  const [roomCoverage, setRoomCoverage] = useState({ walls: 0, floors: 0, openings: 0 });
  const [roomDegrees, setRoomDegrees] = useState(0);
  // What the camera actually looked at, accumulated from the tracked-frame stream. This is
  // what decides whether a sweep is finished, rather than how far the user turned.
  const coverage = useRef(new CoverageTracker());
  const [observedFraction, setObservedFraction] = useState(0);
  const [failure, setFailure] = useState('');
  // True only while the sweep is running, so editing poses never pollute scan coverage.
  const scanning = useRef(false);
  // The converted room waiting on the user's answer to a "needs another view" prompt.
  const pendingRoom = useRef<ReturnType<typeof roomToSession> | null>(null);
  /**
   * True when the next sweep EXTENDS the room rather than replacing it.
   *
   * RoomPlan reaches about five metres, so one standing position cannot measure a large
   * room however patiently it is swept. A second pass from somewhere else is merged with
   * the first by `StructureBuilder` on the native side — valid only because both passes
   * share one ARSession and therefore one world origin.
   */
  /**
   * The last anchor transform ARKit actually reported.
   *
   * `roomAnchor` is only in a frame's payload when ARKit has the anchor registered in
   * THAT frame — it is absent for the frames right after the anchor is added, and during
   * relocalisation. `roomFromWorld` falls back to the static origin when it is missing,
   * and that origin is a snapshot from conversion time: correct once, wrong the moment
   * ARKit revises its map. So a missing anchor did not degrade gracefully, it SNAPPED the
   * whole room between two different poses from one frame to the next, which is what
   * placed objects refusing to stay put actually looks like.
   *
   * Holding the last known transform is strictly better than reverting to a stale one.
   */
  const lastAnchor = useRef<number[] | undefined>(undefined);
  const addingPass = useRef(false);
  const [passes, setPasses] = useState(0);
  // The raw capture, kept so a development build can write it out as a gate fixture.
  const lastCapture = useRef<{ roomJSON: string; mask: CoverageMask } | null>(null);
  // Which capture this is within the app session, so `calibrationRevision` is a real value
  // rather than a hardcoded 0 that no staleness check could ever act on.
  const captureCount = useRef(0);
  const reconstruction = useRef<ReconstructionRun | null>(null);
  const [recon, setRecon] = useState<ReconstructionPhase>({ state: 'idle' });
  const [depthInputs, setDepthInputs] = useState<{ ok: boolean; reason: string } | null>(null);
  // Registered references from the measurement sweep: pose + intrinsics from the same
  // ARFrame, so these are real keyframes rather than unregistered photographs.
  const keyframes = useRef<{ metadata: Keyframe; jpegBase64: string }[]>([]);
  const clearCaptures = () => {
    keyframes.current = [];
  };
  useEffect(() => () => clearCaptures(), []);
  // Primed once so the add path can look a catalog id up synchronously. An
  // unreachable server leaves it empty and adds fall back to the families.
  useEffect(() => { void loadObjectCatalog(); }, []);
  const handFrame = useRef<TrackedFrame | null>(null);
  const frame = useRef<TrackedFrame | null>(null),
    // Room-space origin in ARKit world coordinates. Subtracted from the camera and from
    // hand rays so both agree with the recentred room.
    origin = useRef<Vec3>([0, 0, 0]);
  // Drives the native prop; a ref alone would not re-render the view to deliver it.
  const [anchored, setAnchored] = useState(false);
  /**
   * Editing the measured room away from the measured room.
   *
   * A scan is finished in the room and then thought about somewhere else — on a sofa, on
   * a train — and the live view is useless there: point the phone at a different room and
   * the furniture is registered to walls that are not in front of you. Detaching swaps
   * the camera for the plan and the three-quarter view, which is what the development
   * room has always been.
   *
   * It is a VIEW, not a different scene. The room keeps its geometry, its edits and its
   * `observed` provenance: relabelling a measured room as a sample to reuse that code
   * path would be a lie about where the geometry came from, and the drawing prints that
   * provenance on the page.
   */
  const [detached, setDetached] = useState(false);
  // Read from the frame callback, which is not re-created per render.
  const detachedRef = useRef(false);
  detachedRef.current = detached;
  useEffect(() => () => editor?.dispose(), [editor]);
  /**
   * ONE DEVICE SESSION BUYS PERMANENT COVERAGE.
   *
   * `roomJSON` is exactly what the M4 gate replays, so writing it out turns a real scan
   * into a checked-in fixture: copy both files off the device into
   * contracts/fixtures/rooms/captures/ and the scenarios consume them unchanged. The
   * coverage mask goes alongside because the capture alone cannot say what was observed.
   */
  const saveCapture = (): string => {
    const capture = lastCapture.current;
    if (!capture) return 'No capture to save yet.';
    try {
      const file = new File(Paths.document, `capture-${Date.now()}.capture.json`);
      file.create({ overwrite: true });
      file.write(capture.roomJSON);
      const sidecar = new File(Paths.document, `${file.name}.mask.json`);
      sidecar.create({ overwrite: true });
      sidecar.write(JSON.stringify(capture.mask));
      return `Saved ${file.name} and its coverage mask.`;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not save the capture.';
    }
  };

  /** Commit a converted capture and enter editing. One place, so the "use it anyway" path
   * and the clean path cannot drift apart. */
  const useRoom = (converted: ReturnType<typeof roomToSession>) => {
    scanning.current = false;
    origin.current = converted.origin;
    setAnchored(true);
    pendingRoom.current = null;
    const created = createEditor(converted.scene);
    setEditor(created);
    setDetached(false);
    // Straight in. Voice comes up on its own with the editor, so the sweep ends and the
    // room is already listening — nothing to read and nothing to dismiss in between.
    setPhase('edit');

    // RECONSTRUCTION RUNS BEHIND THE EDITOR, NOT IN FRONT OF IT.
    //
    // The measured room is already usable, so uploading and reconstructing must never
    // block entering edit or fail it. The six keyframes were previously counted on screen
    // and then dropped; this is the first thing that consumes them.
    void (async () => {
      const run = new ReconstructionRun(
        apiURL(),
      );
      reconstruction.current = run;
      run.subscribe(setRecon);
      await run.run(
        keyframes.current,
        reconstructionRoom(converted.scene, converted.origin),
        converted.scene.calibrationRevision,
        converted.scene.frameId,
        // The scene adopts the server's id; the token stays inside the run.
        (id) => created.engine.adoptCalibration(id),
      );
    })();
  };
  useEffect(() => {
    // Only while RoomPlan is actually measuring. Poses gathered after the room is built
    // would claim coverage that no geometry came from.
    scanning.current = phase === 'observing';
  }, [phase]);
  const end = () => {
    // Asks the server to delete the uploaded frames now rather than waiting out the 24h
    // expiry. Fire-and-forget: the expiry is the guarantee, this is the courtesy.
    void reconstruction.current?.dispose();
    reconstruction.current = null;
    setRecon({ state: 'idle' });
    clearCaptures();
    editor?.dispose();
    setEditor(null);
    frame.current = null;
    handFrame.current = null;
    setRoomCoverage({ walls: 0, floors: 0, openings: 0 });
    setRoomDegrees(0);
    coverage.current.reset();
    // A new room means a new anchor. Carrying the old one would align the new room to
    // the previous room's origin.
    lastAnchor.current = undefined;
    // A new room is not another view of the old one.
    addingPass.current = false;
    setPasses(0);
    setObservedFraction(0);
    setFailure('');
    setAnchored(false);
    setDetached(false);
    setPhase('welcome');
  };
  /**
   * Start a measurement sweep, from wherever you are.
   *
   * `end` first, unconditionally: leaving the development room means disposing an editor
   * and an AR anchor that belong to a scene which is about to be replaced. Reaching this
   * from the welcome screen simply ends nothing.
   */
  const beginScan = () => {
    end();
    setSpatialOwner('RoomPlan is requesting the rear camera.');
    setPhase('observing');
    setMessage('Turn steadily through 270\u00b0. Keep the phone upright.');
  };
  return (
    <SafeAreaView style={styles.root}>
      {(phase === 'observing' || phase === 'needs_view' ||
        phase === 'scanned' ||
        phase === 'reconstructing' ||
        phase === 'failed' ||
        (phase === 'edit' && editor?.engine.getSnapshot().scene.provenance !== 'sample')) &&
        SpatialView && (
          <SpatialView
            style={StyleSheet.absoluteFill}
            // ONLY `observing` MAY PUT THE NATIVE VIEW IN SCAN MODE.
            //
            // `needs_view` and `failed` are both reached AFTER RoomPlan has finished and
            // emitted its room, when the native side is already in edit/failed. Sending
            // `scan` there passes the `next != mode` guard and starts a fresh
            // RoomCaptureSession, which mints a new `frameId`. The scene was built with the
            // old one, and `resolveHand` refuses any frame whose id does not match the
            // scene, so the hand cursor silently stopped targeting anything at all.
            mode={phase === 'observing' ? (addingPass.current ? 'rescan' : 'scan') : 'edit'}
            // Set once the room exists. Native anchors the origin and reports the anchor's
            // current transform every frame, so the room follows ARKit's corrections
            // instead of staying pinned to a world estimate that keeps changing.
            roomOrigin={anchored ? origin.current : null}
            onKeyframe={(e) => {
              // Dropped rather than thrown: one bad frame costs one reference,
              // not the sweep. `parseKeyframe` splits metadata from the JPEG
              // because KeyframeSchema is strict.
              const keyframe = parseKeyframe(e.nativeEvent);
              if (!keyframe) return;
              keyframes.current = [...keyframes.current, keyframe];
            }}
            onStatus={(e) => {
              setMessage(e.nativeEvent.message);
              if (e.nativeEvent.code === 'camera_owner') setSpatialOwner(e.nativeEvent.message);
              // Depth and person segmentation are enabled lazily by the native side and
              // can simply be unsupported. That verdict was emitted and read by nobody,
              // so a device that cannot provide depth looked identical to one where the
              // compositor was merely broken. Held rather than shown once, because it
              // stays true for the session.
              if (e.nativeEvent.code === 'compositing_unavailable')
                setDepthInputs({ ok: false, reason: e.nativeEvent.message });
              if (e.nativeEvent.code === 'compositing_inputs') setDepthInputs({ ok: true, reason: '' });
              if (e.nativeEvent.code === 'observing') {
                setRoomCoverage({
                  walls: e.nativeEvent.wallCount ?? 0,
                  floors: e.nativeEvent.floorCount ?? 0,
                  openings: e.nativeEvent.openingCount ?? 0,
                });
              }
              if (e.nativeEvent.code === 'scan_progress') {
                // READ THE VALUES OUT BEFORE THE UPDATER RUNS.
                //
                // A `set*(prev => …)` updater is invoked lazily, during the next
                // render — not when this handler returns. React Native reuses
                // synthetic events and nulls `nativeEvent` once the handler is
                // done, so closing over `e` here threw
                // "Cannot read property 'wallCount' of null" from inside
                // `basicStateReducer`, with a stack that points at render rather
                // than at this line.
                //
                // The `observing` branch above is safe only because it computes a
                // plain object immediately instead of deferring.
                const { scanDegrees, wallCount, floorCount } = e.nativeEvent;
                setRoomDegrees(scanDegrees ?? 0);
                setRoomCoverage((current) => ({
                  walls: wallCount ?? current.walls,
                  floors: floorCount ?? current.floors,
                  openings: current.openings,
                }));
              }
              if (e.nativeEvent.code === 'scan_complete') setPhase('reconstructing');
              if (e.nativeEvent.code === 'failed') {
                // Keep what was gathered. Bouncing straight back to the sweep discarded
                // every observation and gave the user no idea what had gone wrong.
                setFailure(e.nativeEvent.message);
                setPhase('failed');
              }
            }}
            onFrame={(e) => {
              const received = { ...e.nativeEvent, receivedAt: Date.now() };
              // Sticky: carry the last real anchor onto frames that arrive without one,
              // rather than letting them fall back to the stale static origin.
              if (received.roomAnchor?.length === 16) lastAnchor.current = received.roomAnchor;
              else if (lastAnchor.current) received.roomAnchor = lastAnchor.current;
              if (received.hand) handFrame.current = received;
              if (!frame.current || received.timestamp >= frame.current.timestamp)
                frame.current = received;
              // While detached the phone may be in another building entirely. Tracking
              // still reports honestly, but it is no longer a statement about whether
              // this edit can be trusted — nothing is being aligned to the camera — so
              // it must not refuse one.
              if (!detachedRef.current)
                editor?.engine.setTracking(received.tracking === 'normal');
              // The pose stream IS the coverage evidence. Recording it here means the
              // completeness rules live in testable TypeScript and need no native change.
              if (scanning.current) coverage.current.observe(received);
            }}
            onRoom={(e) => {
              try {
                const mask = coverage.current.snapshot();
                const converted = roomToSession(
                  e.nativeEvent.roomJSON,
                  e.nativeEvent.frameId,
                  mask,
                  captureCount.current++,
                );
                lastCapture.current = { roomJSON: e.nativeEvent.roomJSON, mask };
                setPasses(e.nativeEvent.passes ?? 1);
                pendingRoom.current = converted;
                setObservedFraction(converted.coverage?.observedFraction ?? 0);
                // A boundary nobody looked at is worth asking about before committing to a
                // room built partly out of guesses. The user can still decline.
                if (converted.coverage?.status === 'needs_view') {
                  setMessage(converted.coverage.prompt ?? 'Show one more room boundary.');
                  setPhase('needs_view');
                  return;
                }
                // STOP HERE RATHER THAN ENTERING THE EDITOR.
                //
                // A second RoomPlan pass is only safe before the room is committed: the
                // origin is the floor-polygon centroid, so extending the floor MOVES it,
                // and anything already placed would shift with it. Going straight in left
                // no moment at which another pass could be offered, which is why a room
                // could only ever be swept once.
                setMessage(
                  converted.coverage?.status === 'ready'
                    ? 'Room measured. Add another area if part of it was out of range.'
                    : 'Room measured.',
                );
                setPhase('scanned');
              } catch (error) {
                setFailure(error instanceof Error ? error.message : 'Unable to use this room.');
                setPhase('failed');
              }
            }}
          />
        )}
      {(phase === 'observing' ||
        phase === 'needs_view' ||
        phase === 'scanned' ||
        phase === 'reconstructing' ||
        phase === 'failed') && (
        <View style={styles.hud} pointerEvents="box-none">
          {/* One glass card. The camera ownership line and the reference count were
              diagnostics reading as instructions; they moved to the editor's
              development sheet, where the people who need them already look. */}
          <GlassPanel style={styles.card}>
            <Text style={styles.title}>
              {phase === 'scanned'
                ? 'Room measured'
                : phase === 'needs_view'
                ? 'One more view'
                : phase === 'failed'
                  ? 'Measurement stopped'
                  : 'Turn once for dimensions'}
            </Text>
            <Text style={phase === 'failed' ? styles.warn : styles.text}>
              {phase === 'failed' ? failure : message}
            </Text>
            {phase !== 'failed' && (
              <>
                {/* A bar, not two percentages. It is the same two numbers the sweep
                    always reported; it is just readable while turning. */}
                <View style={styles.track}>
                  <View
                    style={[
                      styles.fill,
                      { width: `${Math.round(Math.min(roomDegrees / roomSweepDegrees, 1) * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.owner}>
                  {Math.round(observedFraction * 100)}% observed · {roomCoverage.walls} walls ·{' '}
                  {roomCoverage.openings} openings
                </Text>
              </>
            )}
          </GlassPanel>
          <View style={styles.actions}>
            {phase === 'needs_view' && pendingRoom.current && (
              <>
                {/* Makes the prompt actionable instead of decorative. The ARSession is
                    retained across a re-run, so world directions - and the coverage already
                    gathered - stay valid; only RoomPlan's own capture restarts. */}
                <GlassPill
                  label="Keep scanning"
                  onPress={() => {
                    pendingRoom.current = null;
                    // EXTEND, do not restart. Walking to the missing boundary and sweeping
                    // again is the only way to measure what was out of RoomPlan's range
                    // from the first position, and the passes merge into one room.
                    addingPass.current = true;
                    setPhase('observing');
                    setMessage('Walk toward the boundary that is still missing, then sweep again.');
                  }}
                />
                {/* Never a locked door: missing geometry becomes an inferred label. */}
                <GlassPill
                  label="Use it anyway"
                  tone="quiet"
                  onPress={() => pendingRoom.current && useRoom(pendingRoom.current)}
                />
              </>
            )}
            {/* Coverage says every boundary was FACED; it cannot say they were close
                enough to measure well. A room bigger than RoomPlan's reach needs a second
                position, so the offer stands even when the sweep is judged complete. */}
            {(phase === 'scanned' || phase === 'needs_view') && (
              <GlassPill
                label={passes > 1 ? `Scan another area (${passes} merged)` : 'Scan another area'}
                tone="quiet"
                onPress={() => {
                  // Keep the built room as the pending one: if the next pass fails, the
                  // user still has something to accept rather than nothing.
                  addingPass.current = true;
                  setPhase('observing');
                  setMessage('Walk to the part that was out of range, then sweep again.');
                }}
              />
            )}
            {phase === 'scanned' && (
              <GlassPill
                label="Use this room"
                onPress={() => pendingRoom.current && useRoom(pendingRoom.current)}
              />
            )}
            {phase === 'failed' ? (
              <GlassPill
                label="Try again"
                onPress={() => {
                  setFailure('');
                  setMessage('Turn steadily through 270°. Keep the phone upright.');
                  setPhase('observing');
                }}
              />
            ) : (
              phase !== 'needs_view' &&
              phase !== 'scanned' && (
                <GlassPill
                  label={phase === 'reconstructing' ? 'Building room…' : 'Finish now'}
                  disabled={phase === 'reconstructing'}
                  onPress={() => setPhase('reconstructing')}
                />
              )
            )}
            {__DEV__ && lastCapture.current && (
              <GlassPill label="Save fixture" tone="quiet" onPress={() => setMessage(saveCapture())} />
            )}
            <GlassPill label="Cancel" tone="quiet" onPress={end} />
          </View>
        </View>
      )}
      {/* WHY THE CAMERA IS STILL RUNNING BEHIND THIS.
          Unmounting `SpatialView` would be the obvious way to detach, and it mints a new
          `frameId` on the way back — `SpatialCaptureView` generates one per instance.
          The scene was built with the old one, so every intent would then fail the
          `context.frameId !== state.frameId` check as stale and the hand cursor would
          refuse every frame. Covering it costs some battery and keeps the ARSession, the
          room anchor and that id alive, so returning to the live view is instant and
          correct rather than fast and broken. */}
      {phase === 'edit' && detached && <View style={styles.backdrop} />}
      {phase === 'edit' && editor && (
        <EditorPanel
          editor={editor}
          frame={
            detached || editor.engine.getSnapshot().scene.provenance === 'sample'
              ? undefined
              : frame
          }
          handFrame={handFrame}
          origin={origin.current}
          spatialOwner={spatialOwner}
          onSaveCapture={lastCapture.current ? saveCapture : undefined}
          onScan={beginScan}
          detached={detached}
          onDetach={(next) => {
            setDetached(next);
            // Coming back, the next tracked frame restores the real answer within a
            // frame or two; going away, nothing else would ever clear a `false` left
            // behind by the walk out of the room.
            if (next) editor.engine.setTracking(true);
          }}
          reconstruction={recon}
          depthInputs={depthInputs}
          onExit={end}
        />
      )}
      {phase === 'welcome' && (
        <View style={styles.welcome}>
          {/* A PICTURE HERE, A RENDER AFTER THE SCAN.
              There is no room yet on this screen, so nothing true can be drawn — and a
              render of a fixture pretending to be your bedroom is a worse lie than an
              illustration that is plainly one. It was generated with the same Gemini
              image model `POST /inpaint` uses; `npx tsx tools/hero-image.ts` makes
              another. Its background is the page's own #0c1420, so it has no edge and
              needs no frame around it.

              It does not turn. An image model asked for the same diorama twelve degrees
              round returns a DIFFERENT room rather than the same one from a new angle,
              so there is no sequence to animate — only the measured room, which has
              actual geometry, turns. */}
          {/* Above the picture, so the whole column sits lower on the screen. */}
          <View style={styles.topSpacer} />
          <Image
            source={require('../assets/hero-room.jpg')}
            style={styles.hero}
            resizeMode="contain"
            accessibilityLabel="A dark cutaway view of a garage"
          />
          <View style={styles.pitch}>
            {/* THE ONLY WAY IN WITHOUT A LIDAR SWEEP, AND IT IS HIDDEN ON PURPOSE.
                The button that used to offer the sample room was removed from this
                screen deliberately; a simulator and a phone without depth still need a
                door, and a long-press is a door without being a button. `__DEV__` only,
                so it does not exist in a release build. */}
            <Pressable
              onLongPress={
                __DEV__
                  ? () => {
                      setEditor(createEditor(sampleRoom()));
                      setPhase('edit');
                    }
                  : undefined
              }
              delayLongPress={600}
            >
              <Text style={styles.wordmark}>Dex</Text>
            </Pressable>
            <Text style={styles.text}>Make room for something new.</Text>
          </View>

          {/* SAY NO HERE, NOT THREE SCREENS LATER.
              Without RoomPlan there is no route to geometry at all: the Vision Camera
              sweep produces unregistered photographs, and the measure screen used to
              strand the user with nothing but Cancel after a full 300° turn. Refusing at
              the start costs them one tap instead of a minute. */}
          {spatialSupported() ? (
            // ONE TURN. The separate 300° Vision Camera pass produced references
            // nothing consumed — read once for a count, then deleted — while
            // RoomPlan's own sweep already emits registered keyframes as it goes.
            <GlassPill label="Get started" size="large" onPress={beginScan} />
          ) : (
            <Text style={styles.warn}>
              This iPhone cannot measure a room. Calibration needs LiDAR and the native
              development build; without depth there is no way to turn what the camera sees
              into metric geometry, and a room guessed from photographs is not a measurement.
            </Text>
          )}
          {/* BELOW the buttons, not above them.
              Bringing the sentence and the button together can move either one, and
              moving the button up is the only version that keeps both of the things
              asked for: the words stay around the middle of the screen, and what you
              press sits just under them instead of at the far end of it. */}
          <View style={styles.spacer} />
        </View>
      )}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c1420' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#0c1420' },
  warn: { color: '#ffb7a6', fontSize: 15, lineHeight: 22 },
  welcome: {
    flex: 1,
    alignItems: 'center',
    padding: 24,
    paddingTop: 14,
    paddingBottom: 34,
    gap: 14,
  },
  /**
   * The room, as large as the screen will give it.
   *
   * Full bleed past the page's own padding, and the box is the PICTURE'S OWN SHAPE
   * rather than a flexed share of what is left. A flexed box is almost never the image's
   * aspect, so `contain` fits inside it and leaves a band of dead space above and below
   * — which is both a smaller room and a wider gap to the sentence under it than the
   * layout thinks it is asking for. Given the exact ratio there is no slack at all.
   *
   * `contain` stays, because a ratio measured from one crop should not be able to clip
   * the next one if a regenerated hero comes back a different shape.
   */
  /**
   * The room, as large as the screen will give it — and never larger.
   *
   * Full bleed past the page's own padding, and the box is the PICTURE'S OWN SHAPE
   * rather than a flexed share of what is left. A flexed box is almost never the image's
   * aspect, so `contain` fits inside it and leaves a band of dead space above and below,
   * which is both a smaller room and a wider gap to the sentence under it.
   *
   * `maxHeight` is the guard that shape needs. An aspect-locked box has a height derived
   * from the screen's WIDTH and no relationship to how much height is left; `flexShrink`
   * is 0 by default in React Native, so on a short screen it simply keeps its size and
   * pushes the button off the bottom. Capped, the worst case is a letterboxed picture
   * rather than a missing button.
   */
  hero: {
    // `alignSelf: stretch`, NOT `width: '100%'`. A percentage width resolves against the
    // parent's content box, so a negative margin only slides it sideways and the picture
    // never actually reaches the screen edges. Stretch resolves after the margins, which
    // is what makes the bleed real.
    alignSelf: 'stretch',
    aspectRatio: 1338 / 1169,
    maxHeight: '52%',
    /**
     * Past the screen, and further on the left than on the right.
     *
     * The bleed itself is what makes the picture 15% larger than a contained one: the
     * image carries 8% of background margin of its own, so running off the edges spends
     * that margin rather than the room.
     *
     * The two are not equal because the picture is not visually centred even though it
     * is geometrically centred — the diorama's bounding box sits within 2px of the
     * frame's middle, but the bookshelf, the monitors and the car are all on the right
     * while the left wall is dark and empty, so the eye puts its centre right of where
     * the measurement does. The difference between these two numbers is twice the shift:
     * 60 and 36 moves it 12pt left.
     *
     * That is close to the limit. The diorama clears the left edge by 6pt at this
     * setting, and the margins themselves are invisible — page colour on page colour —
     * so the only thing a bigger shift costs is the room running off the side.
     */
    marginLeft: -60,
    marginRight: -36,
  },
  /**
   * Equal shares above the picture and below the button, so the block is centred.
   *
   * The picture ITSELF cannot be centred on the screen — it is more than half of it, and
   * putting its middle on the screen's middle pushes the button off the bottom. What can
   * be centred, and what reads as centred, is everything together.
   */
  topSpacer: { flex: 1 },
  /**
   * The air under the button rather than over it.
   *
   * Everything above is a fixed height, so the two spacers simply share whatever a given
   * phone has left, half each. Measured: on a 393x852 screen the block's middle lands at
   * 49% and the button sits 24pt under the sentence, against 104pt before. That gap is
   * fixed, so it does not stretch on a big phone and collapse on a small one the way a
   * proportional one would.
   */
  spacer: { flex: 1 },
  pitch: { gap: 6, alignItems: 'center', paddingTop: 4, paddingBottom: 10 },
  wordmark: { color: '#f8fbff', fontSize: 38, fontWeight: '600', letterSpacing: -0.8 },
  title: { color: 'white', fontSize: 21, fontWeight: '600' },
  text: { color: '#c3d2e2', fontSize: 16, lineHeight: 23, textAlign: 'center' },
  owner: { color: '#a9dcff', fontSize: 13 },
  hud: { marginTop: 'auto', padding: 20, paddingBottom: 34, gap: 14, alignItems: 'center' },
  card: {
    alignSelf: 'stretch',
    padding: 20,
    borderRadius: 26,
    overflow: 'hidden',
    gap: 10,
  },
  track: { height: 3, borderRadius: 2, backgroundColor: '#ffffff26', overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2, backgroundColor: '#7fc6ff' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
});
