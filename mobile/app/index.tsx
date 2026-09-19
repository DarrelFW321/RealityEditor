import { useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import { sampleRoom } from '@reality/dev-scenarios';
import { EditorPanel } from '../src/components/EditorPanel';
import { createEditor, type Editor } from '../src/runtime/editor';
import {
  SpatialView,
  spatialSupported,
  roomToSession,
  parseKeyframe,
  type TrackedFrame,
} from '../src/adapters/roomplan';
import type { Keyframe } from '@reality/contracts';
import { CoverageTracker, type CoverageMask } from '@reality/spatial-engine';
import { ReconstructionRun, type ReconstructionPhase } from '../src/runtime/reconstruction';
import type { Vec3 } from '@reality/contracts';

const roomSweepDegrees = 270;

export default function Home() {
  // THE STATES THE PRD NAMES, NOT THE ONES THE CAMERA HAPPENS TO HAVE.
  //
  // "Calibration has visible states: observing, needs another view, reconstructing, ready,
  // and failed/retry." `needs_view` and `failed` are the two that were missing: coverage had
  // no way to ask for anything, and every failure silently reset the sweep to zero.
  const [phase, setPhase] = useState<
    | 'welcome'
    | 'observing'
    | 'needs_view'
    | 'reconstructing'
    | 'failed'
    | 'edit'
  >('welcome'),
    [editor, setEditor] = useState<Editor | null>(null);
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
  // The raw capture, kept so a development build can write it out as a gate fixture.
  const lastCapture = useRef<{ roomJSON: string; mask: CoverageMask } | null>(null);
  // Which capture this is within the app session, so `calibrationRevision` is a real value
  // rather than a hardcoded 0 that no staleness check could ever act on.
  const captureCount = useRef(0);
  const reconstruction = useRef<ReconstructionRun | null>(null);
  const [recon, setRecon] = useState<ReconstructionPhase>({ state: 'idle' });
  // Registered references from the measurement sweep: pose + intrinsics from the same
  // ARFrame, so these are real keyframes rather than unregistered photographs.
  const keyframes = useRef<{ metadata: Keyframe; jpegBase64: string }[]>([]);
  const [keyframeCount, setKeyframeCount] = useState(0);
  const clearCaptures = () => {
    keyframes.current = [];
    setKeyframeCount(0);
  };
  useEffect(() => () => clearCaptures(), []);
  const handFrame = useRef<TrackedFrame | null>(null);
  const frame = useRef<TrackedFrame | null>(null),
    // Room-space origin in ARKit world coordinates. Subtracted from the camera and from
    // hand rays so both agree with the recentred room.
    origin = useRef<Vec3>([0, 0, 0]);
  // Drives the native prop; a ref alone would not re-render the view to deliver it.
  const [anchored, setAnchored] = useState(false);
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
    setPhase('edit');

    // RECONSTRUCTION RUNS BEHIND THE EDITOR, NOT IN FRONT OF IT.
    //
    // The measured room is already usable, so uploading and reconstructing must never
    // block entering edit or fail it. The six keyframes were previously counted on screen
    // and then dropped; this is the first thing that consumes them.
    void (async () => {
      const run = new ReconstructionRun(
        process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787',
      );
      reconstruction.current = run;
      run.subscribe(setRecon);
      await run.run(
        keyframes.current,
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
    setObservedFraction(0);
    setFailure('');
    setAnchored(false);
    setPhase('welcome');
  };
  return (
    <SafeAreaView style={styles.root}>
      {(phase === 'observing' || phase === 'needs_view' ||
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
            mode={phase === 'observing' ? 'scan' : 'edit'}
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
              setKeyframeCount(keyframes.current.length);
            }}
            onStatus={(e) => {
              setMessage(e.nativeEvent.message);
              if (e.nativeEvent.code === 'camera_owner') setSpatialOwner(e.nativeEvent.message);
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
              if (received.hand) handFrame.current = received;
              if (!frame.current || received.timestamp >= frame.current.timestamp)
                frame.current = received;
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
                pendingRoom.current = converted;
                setObservedFraction(converted.coverage?.observedFraction ?? 0);
                // A boundary nobody looked at is worth asking about before committing to a
                // room built partly out of guesses. The user can still decline.
                if (converted.coverage?.status === 'needs_view') {
                  setMessage(converted.coverage.prompt ?? 'Show one more room boundary.');
                  setPhase('needs_view');
                  return;
                }
                useRoom(converted);
              } catch (error) {
                setFailure(error instanceof Error ? error.message : 'Unable to use this room.');
                setPhase('failed');
              }
            }}
          />
        )}
      {(phase === 'observing' ||
        phase === 'needs_view' ||
        phase === 'reconstructing' ||
        phase === 'failed') && (
        <View style={styles.panel}>
          <Text style={styles.title}>
            {phase === 'needs_view'
              ? 'One more view'
              : phase === 'failed'
                ? 'Measurement stopped'
                : 'Turn once for dimensions'}
          </Text>
          <Text style={phase === 'failed' ? styles.warn : styles.text}>
            {phase === 'failed' ? failure : message}
          </Text>
          <Text style={styles.owner}>Camera: {spatialOwner}</Text>
          <Text style={styles.owner}>{keyframeCount} registered references</Text>
          <Text style={styles.text}>
            Room sweep: {Math.round(Math.min(roomDegrees, roomSweepDegrees))}° / {roomSweepDegrees}°
          </Text>
          <Text style={styles.text}>
            Observed: {Math.round(observedFraction * 100)}% of the room · {roomCoverage.walls}{' '}
            walls · {roomCoverage.floors} floor · {roomCoverage.openings} openings
          </Text>
          {phase === 'needs_view' && pendingRoom.current && (
            <>
              {/* Makes the prompt actionable instead of decorative. The ARSession is
                  retained across a re-run, so world directions - and the coverage already
                  gathered - stay valid; only RoomPlan's own capture restarts. */}
              <Button
                title="Keep scanning"
                onPress={() => {
                  pendingRoom.current = null;
                  setPhase('observing');
                  setMessage('Turn toward the boundary that is still missing.');
                }}
              />
              {/* Never a locked door: missing geometry becomes an inferred label. */}
              <Button
                title="Use it anyway"
                onPress={() => pendingRoom.current && useRoom(pendingRoom.current)}
              />
            </>
          )}
          {phase === 'failed' ? (
            <Button
              title="Try again"
              onPress={() => {
                setFailure('');
                setMessage('Turn steadily through 270°. Keep the phone upright.');
                setPhase('observing');
              }}
            />
          ) : (
            <Button
              title={phase === 'reconstructing' ? 'Building room…' : 'Finish now'}
              disabled={phase === 'reconstructing'}
              onPress={() => setPhase('reconstructing')}
            />
          )}
          {__DEV__ && lastCapture.current && (
            <Button title="Save capture as fixture" onPress={() => setMessage(saveCapture())} />
          )}
          <Button title="Cancel" onPress={end} />
        </View>
      )}
      {phase === 'edit' && editor && (
        <EditorPanel
          editor={editor}
          frame={editor.engine.getSnapshot().scene.provenance === 'sample' ? undefined : frame}
          handFrame={handFrame}
          origin={origin.current}
          spatialOwner={spatialOwner}
          onSaveCapture={lastCapture.current ? saveCapture : undefined}
          reconstruction={recon}
          onExit={end}
        />
      )}
      {phase === 'welcome' && (
        <View style={styles.welcome}>
          <Text style={styles.eyebrow}>REALITY EDITOR</Text>
          <Text style={styles.hero}>{'Make room for\nsomething new.'}</Text>
          <Text style={styles.text}>
            Calibrate your space, then shape it with your hands and voice.
          </Text>
          {/* SAY NO HERE, NOT THREE SCREENS LATER.
              Without RoomPlan there is no route to geometry at all: the Vision Camera
              sweep produces unregistered photographs, and the measure screen used to
              strand the user with nothing but Cancel after a full 300° turn. Refusing at
              the start costs them one tap instead of a minute. */}
          {spatialSupported() ? (
            <Button
              title="Calibrate my space"
              onPress={() => {
                setRoomCoverage({ walls: 0, floors: 0, openings: 0 });
                setRoomDegrees(0);
                coverage.current.reset();
                setObservedFraction(0);
                setFailure('');
                keyframes.current = [];
                setKeyframeCount(0);
                // ONE TURN. The separate 300° Vision Camera pass produced references
                // nothing consumed — read once for a count, then deleted — while
                // RoomPlan's own sweep already emits registered keyframes as it goes.
                setSpatialOwner('RoomPlan is requesting the rear camera.');
                setPhase('observing');
                setMessage('Turn steadily through 270°. Keep the phone upright.');
              }}
            />
          ) : (
            <Text style={styles.warn}>
              This iPhone cannot measure a room. Calibration needs LiDAR and the native
              development build; without depth there is no way to turn what the camera sees
              into metric geometry, and a room guessed from photographs is not a measurement.
            </Text>
          )}
          {__DEV__ && (
            <Button
              title="Open development room"
              onPress={() => {
                setEditor(createEditor(sampleRoom()));
                setPhase('edit');
              }}
            />
          )}
        </View>
      )}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c1420' },
  warn: { color: '#ffad99', fontSize: 15, lineHeight: 22 },
  welcome: { flex: 1, justifyContent: 'center', padding: 28, gap: 24 },
  eyebrow: { color: '#8abcee', letterSpacing: 3, fontSize: 12 },
  hero: { color: '#fafafa', fontSize: 40, fontWeight: '600', lineHeight: 46 },
  title: { color: 'white', fontSize: 24 },
  text: { color: '#bac8d8', fontSize: 17, lineHeight: 25 },
  owner: { color: '#8bd0ff', fontSize: 13 },
  panel: { marginTop: 'auto', backgroundColor: '#111b2bea', padding: 24, gap: 16 },
});
