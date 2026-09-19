import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import {
  AppState,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AdapterSlot } from '@reality/adapters';
import { bearingFor } from '@reality/spatial-engine';
import type { EditorState, InteractionContext, Vec3 } from '@reality/contracts';
import type { Editor, Intent } from '../runtime/editor';
import type { TrackedFrame } from '../adapters/roomplan';
import { RealtimeVoice } from '../adapters/realtime';
import { evaluateSpatialFrame } from '../adapters/roomplan';
import { SceneView } from './SceneView';
import { resolveHand } from '../adapters/hand';
import {
  checkDeterminism,
  runScenario,
  scenariosFor,
  type Scenario,
  type ScenarioResult,
} from '../runtime/scenarios';
import type { ReconstructionPhase } from '../runtime/reconstruction';

export function EditorPanel({
  editor,
  frame,
  handFrame,
  origin,
  spatialOwner,
  onSaveCapture,
  reconstruction,
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
  /** Empty-room reconstruction, which runs behind the editor after a capture. */
  reconstruction?: ReconstructionPhase;
  onExit: () => void;
}) {
  const snapshot = useSyncExternalStore(editor.engine.subscribe, editor.engine.getSnapshot);
  const events = useSyncExternalStore(editor.diagnostics.subscribe, editor.diagnostics.getSnapshot);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [destination, setDestination] = useState<InteractionContext['destination']>(null);
  const [message, setMessage] = useState('Select an object or point at a surface to add one.'),
    [voice, setVoice] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [json, setJSON] = useState('{"action":"add","family":"table"}'),
    [dev, setDev] = useState(false);
  const [, refreshDiagnostics] = useState(0);
  const [sceneSize, setSceneSize] = useState<{ width: number; height: number } | null>(null);
  // The shell is a preview of the room without its furniture. Off by default: the
  // measured room is the working surface, and the shell is something you turn on to look
  // at rather than something that silently replaces what you were editing against.
  const [showShell, setShowShell] = useState(false);
  const [gate, setGate] = useState<ScenarioResult[]>([]);
  const [gateRunning, setGateRunning] = useState<Scenario['milestone'] | null>(null);
  const [gateMilestone, setGateMilestone] = useState<Scenario['milestone'] | null>(null);
  const renderFps = useRef(0);
  const slot = useRef(new AdapterSlot<RealtimeVoice>(editor.diagnostics));
  // One clock everywhere: epoch milliseconds. Attention binds against this.
  const context = useRef<InteractionContext>({
    turnId: 'manual',
    clock: 'epoch',
    timestamp: Date.now(),
    revision: snapshot.scene.revision,
    frameId: snapshot.scene.frameId,
    selectedId: selected,
    destination,
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
    sync({ revision: snapshot.scene.revision, selectedId: selected, destination });
  }, [selected, destination, snapshot.scene.revision]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (s) => {
      if (s !== 'active') {
        editor.engine.setTracking(false);
        void slot.current.dispose();
        setVoice(false);
      } else {
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
        if (asDestination) setDestination(asDestination);
        if (down && !pinched && hit?.objectId && state.phase !== 'held') {
          setSelected(hit.objectId);
          sync({ selectedId: hit.objectId });
          editor.engine.begin(hit.objectId);
        }
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
        sync({ destination: asDestination ?? context.current.destination });
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
        (s) => s.id === { M2: 'overlap', M3: 'carry-adjust', M4: 'calib-inferred' }[milestone],
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
  async function toggleVoice() {
    if (connecting) return;
    if (voice) {
      await slot.current.dispose();
      setVoice(false);
      return;
    }
    setConnecting(true);
    try {
      await slot.current.replace(() => {
        const adapter = new RealtimeVoice(
          process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787',
          editor.diagnostics,
          editor.intent,
          setMessage,
          editor.attention,
        );
        adapter.setContext(context.current);
        return adapter;
      });
      setVoice(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Voice unavailable.');
    } finally {
      setConnecting(false);
    }
  }
  function point(position: Vec3, surfaceId: string, kind: 'surface' | 'object' = 'surface') {
    const next = { position, surfaceId, kind };
    setDestination(next);
    sync({ destination: next });
    if (snapshot.phase === 'held' && snapshot.preview)
      editor.engine.preview({ position, yaw: snapshot.preview.pose.yaw });
  }
  function release() {
    if (editor.engine.getSnapshot().phase === 'held' && context.current.destination)
      void editor.engine.release(editor.nextId(), context.current.destination.surfaceId);
  }
  const object = snapshot.scene.design.objects.find((o) => o.id === selected);
  return (
    <View style={styles.root}>
      <View
        style={styles.scene}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSceneSize({ width, height });
        }}
      >
        <SceneView
          snapshot={snapshot}
          selectedId={selected}
          onSelect={setSelected}
          onPoint={point}
          onRelease={release}
          frame={frame}
          origin={origin}
          diagnostics={dev}
          shell={showShell && reconstruction?.state === 'ready' ? reconstruction.shell : null}
          atlasUri={reconstruction?.state === 'ready' ? reconstruction.atlasUri : null}
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
      <View style={styles.top}>
        <Text style={styles.title}>
          {snapshot.scene.provenance === 'sample' ? 'Development room' : 'Your space'}
        </Text>
        <Pressable onPress={onExit}>
          <Text style={styles.link}>End session</Text>
        </Pressable>
      </View>
      <View style={styles.panel}>
        <Text style={styles.text}>{snapshot.result?.message ?? message}</Text>
        <Text style={styles.detail}>{message}</Text>
        {/* Drop validity while held. The PRD requires this to be visible during the
            carry and equally requires it not to block one, so it is only ever text. */}
        {snapshot.phase === 'held' && snapshot.previewValidity && (
          <Text style={snapshot.previewValidity.ok ? styles.good : styles.error}>
            {snapshot.previewValidity.ok
              ? 'Clear to release here.'
              : snapshot.previewValidity.reason}
          </Text>
        )}
        {snapshot.result?.conflicts.map((error, i) => (
          <Text key={`conflict-${i}`} style={styles.error}>
            {error}
          </Text>
        ))}
        {snapshot.result?.report?.remaining_notes.map((note, i) => (
          <Text key={`note-${i}`} style={styles.detail}>
            {note.type} on the {note.side}: {Math.round(note.value_m * 100)}cm, {Math.round(note.recommended_m * 100)}cm recommended
          </Text>
        ))}
        {snapshot.result?.caveats.map((caveat, i) => (
          <Text key={`caveat-${i}`} style={styles.detail}>
            {caveat}
          </Text>
        ))}
        {snapshot.pending && (
          <View style={styles.row}>
            <Button
              title="Move it there"
              onPress={() => void editor.engine.confirm(snapshot.pending!.operationId)}
            />
            <Button title="Leave it" onPress={() => editor.engine.cancel()} />
          </View>
        )}
        {!snapshot.pending &&
          snapshot.result?.report?.alternatives.map((alternative, i) => (
            <Text key={`alt-${i}`} style={styles.detail}>
              Could go {alternative.summary}
            </Text>
          ))}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {(['bed', 'table', 'frame', 'shelf', 'cabinet'] as const).map((family) => (
            <Pressable
              key={family}
              style={styles.chip}
              onPress={() => void run({ action: 'add', family })}
            >
              <Text style={styles.text}>+ {family}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {object && (
          <>
            <Text style={styles.detail}>
              Selected: {object.refined_class ?? object.class} ·{' '}
              {object.dimensions.map((n) => n.toFixed(2)).join(' × ')} m
            </Text>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button
                title={snapshot.phase === 'held' ? 'Release' : 'Carry'}
                onPress={() =>
                  snapshot.phase === 'held' ? release() : editor.engine.begin(object.id)
                }
              />
              <Button title="Cancel" onPress={() => editor.engine.cancel()} />
              <Button
                title="Rotate 15°"
                onPress={() =>
                  void run({
                    action: 'rotate',
                    yaw_degrees: (object.pose.yaw * 180) / Math.PI + 15,
                  })
                }
              />
              <Button
                title="Wider"
                onPress={() =>
                  void run({
                    action: 'resize',
                    dimensions: [
                      object.dimensions[0]! * 1.1,
                      object.dimensions[1]!,
                      object.dimensions[2]!,
                    ],
                  })
                }
              />
              <Button
                title="Blue"
                onPress={() => void run({ action: 'color', color: '#397fc7' })}
              />
              <Button title="Remove" onPress={() => void run({ action: 'remove' })} />
            </ScrollView>
          </>
        )}
        <View style={styles.row}>
          <Button title="Undo" onPress={() => void run({ action: 'undo' })} />
          <Button
            title={connecting ? 'Connecting…' : voice ? 'Stop voice' : 'Start voice'}
            disabled={connecting}
            onPress={() => void toggleVoice()}
          />
          {__DEV__ && <Button title="Modules" onPress={() => setDev(!dev)} />}
        </View>
        {/* Unknown space must not read as verified space. A shell with inferred structure
            says so here rather than letting the room imply it was all measured. */}
        {snapshot.scene.provenance === 'inferred' && (
          <Text style={styles.detail}>
            Partly inferred:{' '}
            {snapshot.scene.design.surfaces
              .filter((s) => s.provenance === 'inferred' && s.state === 'present')
              .map((s) => s.class)
              .join(', ')}{' '}
            were not measured directly. Placements against them are estimates.
          </Text>
        )}
        {/* Reconstruction is asynchronous and optional — the measured room works without
            it — but it must never fail silently. */}
        {reconstruction && reconstruction.state !== 'idle' && (
          <Text
            style={
              reconstruction.state === 'failed'
                ? styles.error
                : reconstruction.state === 'ready'
                  ? styles.good
                  : styles.detail
            }
          >
            {reconstruction.state === 'uploading'
              ? `Sending ${reconstruction.done}/${reconstruction.total} views for the empty-room preview…`
              : reconstruction.state === 'reconstructing'
                ? `Building the empty-room preview — ${reconstruction.stage}…`
                : reconstruction.state === 'ready'
                  ? `Empty-room preview ready — ${reconstruction.shell.surfaces.length} surfaces, filled by ${reconstruction.shell.completion}.`
                  : reconstruction.state === 'unavailable'
                    ? reconstruction.reason
                    : `Empty-room preview failed: ${reconstruction.reason}. The measured room is unaffected.`}
          </Text>
        )}
        {reconstruction?.state === 'ready' && (
          <View style={styles.row}>
            <Button
              title={showShell ? 'Hide empty room' : 'Show empty room'}
              onPress={() => setShowShell(!showShell)}
            />
            {showShell && (
              <Text style={styles.detail}>
                {reconstruction.shell.surfaces.filter((s) => s.inferred).length} of{' '}
                {reconstruction.shell.surfaces.length} surfaces are mostly inferred and are
                dimmed. Real furniture is still in the camera; only the shell is clean.
              </Text>
            )}
          </View>
        )}
        {snapshot.scene.removedPhysicalIds.length > 0 && (
          <Text style={styles.detail}>
            Design preview: {snapshot.scene.removedPhysicalIds.length} physical objects require
            moving or removal. Camera pixels are not erased.
          </Text>
        )}
        {__DEV__ && dev && (
          <View style={styles.dev}>
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
              {(['M2', 'M3', 'M4'] as const).map((milestone) => (
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
          </View>
        )}
      </View>
    </View>
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
  panel: { marginTop: 'auto', padding: 16, gap: 8, backgroundColor: '#0f1b2bea' },
  text: { color: '#f3f5f8', fontSize: 15 },
  detail: { color: '#9dadbf', fontSize: 12 },
  error: { color: '#ffad99', fontSize: 12 },
  good: { color: '#6de0ad' },
  row: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#3b516d', borderRadius: 18, padding: 10 },
  dev: { gap: 8 },
  input: {
    color: 'white',
    borderColor: '#506784',
    borderWidth: 1,
    padding: 8,
    fontFamily: 'Courier',
  },
});
