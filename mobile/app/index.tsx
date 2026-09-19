import { useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import { sampleRoom } from '@reality/dev-scenarios';
import { ScanCamera, type VisualReference } from '../src/components/ScanCamera';
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

const roomSweepDegrees = 270;

export default function Home() {
  const [phase, setPhase] = useState<
    'welcome' | 'visual' | 'handoff' | 'measure' | 'processing' | 'edit'
  >(
      'welcome',
    ),
    [editor, setEditor] = useState<Editor | null>(null);
  const [message, setMessage] = useState(
    'Turn slowly, then show the room’s floor edges and obscured corners.',
  );
  const [spatialOwner, setSpatialOwner] = useState('Vision Camera not started.');
  const [roomCoverage, setRoomCoverage] = useState({ walls: 0, floors: 0, openings: 0 });
  const [roomDegrees, setRoomDegrees] = useState(0);
  // Registered references from the measurement sweep (LiDAR path). Unlike
  // `captures` below these carry pose + intrinsics, so they are real keyframes
  // rather than unregistered photographs.
  const keyframes = useRef<{ metadata: Keyframe; jpegBase64: string }[]>([]);
  const [keyframeCount, setKeyframeCount] = useState(0);
  // Vision Camera references. Only reachable on the non-LiDAR fallback path.
  const captures = useRef<VisualReference[]>([]);
  const clearCaptures = () => {
    captures.current.forEach(({ path }) => {
      try {
        new File(path).delete();
      } catch {}
    });
    captures.current = [];
    keyframes.current = [];
    setKeyframeCount(0);
  };
  useEffect(() => () => clearCaptures(), []);
  useEffect(() => {
    if (phase !== 'handoff') return;
    const timer = setTimeout(() => {
      setPhase('measure');
      setMessage('Turn steadily. Step sideways only if furniture hides a room boundary.');
    }, 350);
    return () => clearTimeout(timer);
  }, [phase]);
  const handFrame = useRef<TrackedFrame | null>(null);
  const frame = useRef<TrackedFrame | null>(null),
    offset = useRef(0);
  useEffect(() => () => editor?.dispose(), [editor]);
  const end = () => {
    clearCaptures();
    editor?.dispose();
    setEditor(null);
    frame.current = null;
    handFrame.current = null;
    setRoomCoverage({ walls: 0, floors: 0, openings: 0 });
    setRoomDegrees(0);
    setPhase('welcome');
  };
  return (
    <SafeAreaView style={styles.root}>
      {phase === 'visual' && (
        <ScanCamera
          onStatus={setSpatialOwner}
          onContinue={(references) => {
            captures.current = references;
            setPhase('handoff');
            setMessage('Vision Camera is unmounted. Waiting for its capture session to release.');
          }}
        />
      )}
      {phase === 'handoff' && (
        <View style={styles.welcome}>
          <Text style={styles.title}>Switching cameras</Text>
          <Text style={styles.text}>{message}</Text>
        </View>
      )}
      {(phase === 'measure' ||
        phase === 'processing' ||
        (phase === 'edit' && editor?.engine.getSnapshot().scene.provenance !== 'sample')) &&
        SpatialView && (
          <SpatialView
            style={StyleSheet.absoluteFill}
            mode={phase === 'measure' ? 'scan' : 'edit'}
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
              if (e.nativeEvent.code === 'scan_complete') setPhase('processing');
              if (e.nativeEvent.code === 'failed') setPhase('measure');
            }}
            onFrame={(e) => {
              const received = { ...e.nativeEvent, receivedAt: Date.now() };
              if (received.hand) handFrame.current = received;
              if (!frame.current || received.timestamp >= frame.current.timestamp)
                frame.current = received;
              editor?.engine.setTracking(received.tracking === 'normal');
            }}
            onRoom={(e) => {
              try {
                const converted = roomToSession(e.nativeEvent.roomJSON, e.nativeEvent.frameId);
                offset.current = converted.floorOffset;
                setEditor(createEditor(converted.scene));
                setPhase('edit');
              } catch (error) {
                setMessage(error instanceof Error ? error.message : 'Unable to use this room.');
                setRoomCoverage({ walls: 0, floors: 0, openings: 0 });
                setRoomDegrees(0);
                setPhase('measure');
              }
            }}
          />
        )}
      {(phase === 'measure' || phase === 'processing') && (
        <View style={styles.panel}>
          <Text style={styles.title}>Turn once for dimensions</Text>
          <Text style={styles.text}>{message}</Text>
          <Text style={styles.owner}>Camera: {spatialOwner}</Text>
          <Text style={styles.owner}>
            {keyframeCount > 0
              ? `${keyframeCount} registered references`
              : `${captures.current.length} unregistered references`}
          </Text>
          <Text style={styles.text}>
            Room sweep: {Math.round(Math.min(roomDegrees, roomSweepDegrees))}° / {roomSweepDegrees}°
          </Text>
          <Text style={styles.text}>
            Coverage: {roomCoverage.walls} walls · {roomCoverage.floors} floor ·{' '}
            {roomCoverage.openings} openings
          </Text>
          {!spatialSupported() ? (
            <Text style={styles.text}>
              Room measurement requires the native development build on a supported LiDAR iPhone.
            </Text>
          ) : (
            <Button
              title={phase === 'processing' ? 'Building room…' : 'Finish now'}
              disabled={phase === 'processing'}
              onPress={() => setPhase('processing')}
            />
          )}
          <Button title="Cancel" onPress={end} />
        </View>
      )}
      {phase === 'edit' && editor && (
        <EditorPanel
          editor={editor}
          frame={editor.engine.getSnapshot().scene.provenance === 'sample' ? undefined : frame}
          handFrame={handFrame}
          floorOffset={offset.current}
          spatialOwner={spatialOwner}
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
          <Button
            title="Calibrate my space"
            onPress={() => {
              setRoomCoverage({ walls: 0, floors: 0, openings: 0 });
              setRoomDegrees(0);
              keyframes.current = [];
              setKeyframeCount(0);
              // ONE TURN ON LIDAR DEVICES.
              //
              // The `visual` phase turned the user through a separate 300° with
              // Vision Camera, and the references it produced were never
              // consumed — read once for a count, then deleted. RoomPlan's own
              // sweep already ends at 270° and now emits registered keyframes
              // as it goes, so that first turn bought nothing.
              //
              // Without RoomPlan there is no ARSession to capture from, so the
              // Vision Camera pass stays as the only reference path there.
              if (spatialSupported()) {
                setSpatialOwner('RoomPlan is requesting the rear camera.');
                setPhase('measure');
                setMessage('Turn steadily through 270°. Keep the phone upright.');
              } else {
                setSpatialOwner('Vision Camera owns the rear camera.');
                setPhase('visual');
              }
            }}
          />
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
  welcome: { flex: 1, justifyContent: 'center', padding: 28, gap: 24 },
  eyebrow: { color: '#8abcee', letterSpacing: 3, fontSize: 12 },
  hero: { color: '#fafafa', fontSize: 40, fontWeight: '600', lineHeight: 46 },
  title: { color: 'white', fontSize: 24 },
  text: { color: '#bac8d8', fontSize: 17, lineHeight: 25 },
  owner: { color: '#8bd0ff', fontSize: 13 },
  panel: { marginTop: 'auto', backgroundColor: '#111b2bea', padding: 24, gap: 16 },
});
