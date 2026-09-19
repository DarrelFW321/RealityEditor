import { useEffect, useRef, useState } from 'react';
import { AppState, Button, Linking, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
/**
 * DEVICEMOTION IS IMPORTED NARROWLY, AND GUARDED. Two separate reasons.
 *
 * 1. `import { DeviceMotion } from 'expo-sensors'` pulls the package barrel,
 *    whose first line is `import * as Pedometer from './Pedometer'`. That
 *    requires the `ExponentPedometer` native module at module scope, so a
 *    sensor this screen never uses could crash the app on launch:
 *
 *        Cannot find native module 'ExponentPedometer'
 *
 *    The barrel eagerly loads eight sensors; this screen needs one.
 *
 * 2. Even the narrow path needs `ExponentDeviceMotion` to be linked, which it
 *    is not until pods are reinstalled after adding expo-sensors. An absent
 *    native module must degrade to manual capture, not a white screen —
 *    `startSweep` already has that fallback and could never reach it, because
 *    the throw happened at import time, before any guard could run.
 *
 * `require` rather than `import` deliberately: the throw has to be catchable,
 * and a static import is hoisted above any try block.
 */
type DeviceMotionSensor = typeof import('expo-sensors/build/DeviceMotion').default;
type MotionSubscription = ReturnType<DeviceMotionSensor['addListener']>;

const DeviceMotion: DeviceMotionSensor | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-sensors/build/DeviceMotion').default as DeviceMotionSensor;
  } catch {
    return null;
  }
})();
import { File } from 'expo-file-system';

export type VisualReference = {
  path: string;
  capturedAt: number;
  view: string;
};

const referenceCount = 6;
const sweepDegrees = 300;
const degreesPerReference = sweepDegrees / (referenceCount - 1);

export function ScanCamera({
  onContinue,
  onStatus,
}: {
  onContinue: (references: VisualReference[]) => void;
  onStatus?: (message: string) => void;
}) {
  const device = useCameraDevice('back'),
    permission = useCameraPermission(),
    output = usePhotoOutput({
      containerFormat: 'jpeg',
      quality: 0.9,
      qualityPrioritization: 'balanced',
    });
  const [active, setActive] = useState(true),
    [foreground, setForeground] = useState(AppState.currentState === 'active'),
    [ready, setReady] = useState(false),
    [capturing, setCapturing] = useState(false),
    [releaseRequested, setReleaseRequested] = useState(false),
    [references, setReferences] = useState<VisualReference[]>([]),
    [sweep, setSweep] = useState<'idle' | 'starting' | 'turning' | 'complete' | 'manual'>(
      'idle',
    ),
    [turnDegrees, setTurnDegrees] = useState(0),
    [message, setMessage] = useState('Stand near the center and hold the phone upright.');

  const referencesRef = useRef<VisualReference[]>([]),
    readyRef = useRef(false),
    busyRef = useRef(false),
    mounted = useRef(true),
    delivered = useRef(false),
    releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    motionSubscription = useRef<MotionSubscription | null>(null),
    accumulatedDegrees = useRef(0),
    turnDirection = useRef(0),
    lastMotionTime = useRef<number | null>(null),
    nextReference = useRef(0),
    captureRef = useRef<(label: string) => Promise<boolean>>(async () => false);

  useEffect(() => {
    referencesRef.current = references;
  }, [references]);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    void output
      .prepareSettings([
        {
          flashMode: 'off',
          enableDistortionCorrection: true,
          enableCameraCalibrationDataDelivery: output.supportsCameraCalibrationDataDelivery,
        },
      ])
      .catch(() => undefined);
    return () => {
      subscription.remove();
      motionSubscription.current?.remove();
      motionSubscription.current = null;
      mounted.current = false;
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
      if (!delivered.current) deleteReferences(referencesRef.current);
    };
  }, [output]);

  function deleteReferences(items: VisualReference[]) {
    items.forEach((reference) => {
      try {
        new File(reference.path).delete();
      } catch {}
    });
  }

  async function captureReference(label: string) {
    if (busyRef.current || !readyRef.current || releaseRequested) return false;
    busyRef.current = true;
    setCapturing(true);
    try {
      const photo = await output.capturePhotoToFile(
        {
          flashMode: 'off',
          enableDistortionCorrection: true,
          enableCameraCalibrationDataDelivery: output.supportsCameraCalibrationDataDelivery,
        },
        {},
      );
      const next: VisualReference = {
        path: `file://${photo.filePath}`,
        capturedAt: Date.now(),
        view: label,
      };
      if (!mounted.current) {
        new File(next.path).delete();
        return false;
      }
      const updated = [...referencesRef.current, next].slice(0, referenceCount);
      referencesRef.current = updated;
      setReferences(updated);
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error ? `Could not capture: ${error.message}` : 'Could not capture this view.',
      );
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setCapturing(false);
    }
  }
  captureRef.current = captureReference;

  function resetSweep() {
    motionSubscription.current?.remove();
    motionSubscription.current = null;
    deleteReferences(referencesRef.current);
    referencesRef.current = [];
    setReferences([]);
    accumulatedDegrees.current = 0;
    turnDirection.current = 0;
    lastMotionTime.current = null;
    nextReference.current = 0;
    setTurnDegrees(0);
    setSweep('idle');
    setMessage('Stand near the center and hold the phone upright.');
  }

  async function startSweep() {
    if (!ready || sweep === 'starting') return;
    setSweep('starting');
    setMessage('Starting motion tracking…');
    try {
      // A null module means expo-sensors is not linked into this build. It is
      // the same outcome for the user as hardware without a gyroscope, so it
      // takes the same branch rather than a separate error path.
      const available = DeviceMotion !== null && (await DeviceMotion.isAvailableAsync());
      const motionPermission = DeviceMotion === null
        ? { granted: false }
        : await DeviceMotion.requestPermissionsAsync();
      if (!available || !motionPermission.granted) {
        setSweep('manual');
        setMessage('Motion tracking is unavailable. Turn about 60° between each manual capture.');
        return;
      }

      const first = await captureReference('0°');
      if (!first) {
        setSweep('idle');
        return;
      }
      nextReference.current = 1;
      // `available` above is only true when the module is non-null; this
      // restates it for the compiler rather than asserting with `!`.
      if (!DeviceMotion) return;
      DeviceMotion.setUpdateInterval(50);
      setSweep('turning');
      setMessage('Turn steadily in one direction. Keep the phone upright.');
      motionSubscription.current = DeviceMotion.addListener((sample) => {
        const now = sample.rotationRate?.timestamp ?? Date.now();
        const prior = lastMotionTime.current;
        lastMotionTime.current = now;
        if (prior === null || !sample.rotationRate) return;
        // Expo's iOS bridge emits CoreMotion rotationRate.y as beta. With the
        // phone upright in portrait, that is the vertical axis of the sweep.
        const rate = sample.rotationRate.beta;
        if (!Number.isFinite(rate) || Math.abs(rate) < 1.5) return;
        if (turnDirection.current === 0) turnDirection.current = Math.sign(rate);
        const rawDelta =
          (rate * Math.min(Math.max(now - prior, 0), 0.25)) / turnDirection.current;
        accumulatedDegrees.current = Math.min(
          sweepDegrees,
          Math.max(0, accumulatedDegrees.current + rawDelta),
        );
        const progress = accumulatedDegrees.current;
        setTurnDegrees(progress);

        const threshold = nextReference.current * degreesPerReference;
        if (
          nextReference.current < referenceCount &&
          progress >= threshold &&
          !busyRef.current
        ) {
          const index = nextReference.current;
          nextReference.current += 1;
          void captureRef.current(`${Math.round(index * degreesPerReference)}°`).then((captured) => {
            if (!captured) {
              nextReference.current = Math.max(1, nextReference.current - 1);
            } else if (index === referenceCount - 1) {
              motionSubscription.current?.remove();
              motionSubscription.current = null;
              setTurnDegrees(sweepDegrees);
              setSweep('complete');
              setMessage('Visual coverage complete. Switching to room measurement…');
            }
          });
        }
        if (progress >= sweepDegrees && referencesRef.current.length >= referenceCount) {
          motionSubscription.current?.remove();
          motionSubscription.current = null;
          setTurnDegrees(sweepDegrees);
          setSweep('complete');
          setMessage('Visual coverage complete. Switching to room measurement…');
        }
      });
    } catch (error) {
      setSweep('manual');
      setMessage(
        error instanceof Error
          ? `Motion tracking failed: ${error.message}. Capture the views manually.`
          : 'Motion tracking failed. Capture the views manually.',
      );
    }
  }

  async function captureManual() {
    const index = referencesRef.current.length;
    if (index >= referenceCount) return;
    const captured = await captureReference(`${Math.round(index * degreesPerReference)}° manual`);
    if (!captured) return;
    const count = referencesRef.current.length;
    setTurnDegrees((Math.max(0, count - 1) / (referenceCount - 1)) * sweepDegrees);
    setMessage(
      count >= referenceCount
        ? 'Manual coverage complete. Switching to room measurement…'
        : `Turn about 60° in the same direction, then capture view ${count + 1}.`,
    );
    if (count >= referenceCount) {
      setTurnDegrees(sweepDegrees);
      setSweep('complete');
    }
  }

  function switchToManual() {
    motionSubscription.current?.remove();
    motionSubscription.current = null;
    const count = referencesRef.current.length;
    if (count >= referenceCount) {
      setSweep('complete');
      setTurnDegrees(sweepDegrees);
      setMessage('Coverage complete. Switching to room measurement…');
      return;
    }
    setSweep('manual');
    setTurnDegrees((Math.max(0, count - 1) / (referenceCount - 1)) * sweepDegrees);
    setMessage(
      `Turn about 60° in the same direction, then capture view ${count + 1}.`,
    );
  }

  const deliver = (confirmed: boolean) => {
    if (delivered.current) return;
    delivered.current = true;
    motionSubscription.current?.remove();
    motionSubscription.current = null;
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    onStatus?.(
      confirmed
        ? 'Vision Camera stopped. Releasing the camera before RoomPlan starts.'
        : 'Vision Camera stop acknowledgement timed out; its view was removed before RoomPlan starts.',
    );
    onContinue([...referencesRef.current]);
  };

  function requestHandoff() {
    if (!readyRef.current || referencesRef.current.length < referenceCount || releaseRequested)
      return;
    motionSubscription.current?.remove();
    motionSubscription.current = null;
    setReleaseRequested(true);
    setMessage('Stopping Vision Camera…');
    onStatus?.('Vision Camera stop requested.');
    setActive(false);
    releaseTimer.current = setTimeout(() => deliver(false), 2000);
  }

  useEffect(() => {
    if (sweep !== 'complete' || releaseRequested) return;
    const timer = setTimeout(requestHandoff, 250);
    return () => clearTimeout(timer);
  }, [ready, releaseRequested, sweep]);

  if (!permission.hasPermission)
    return (
      <View style={styles.panel}>
        <Text style={styles.text}>Allow camera access to calibrate your space.</Text>
        <Button
          title={permission.canRequestPermission ? 'Allow camera' : 'Open Settings'}
          onPress={() => {
            void (permission.canRequestPermission
              ? permission.requestPermission()
              : Linking.openSettings());
          }}
        />
      </View>
    );
  if (!device)
    return <Text style={styles.text}>A rear camera is required. Use a physical device.</Text>;

  const progress = Math.min(100, (turnDegrees / sweepDegrees) * 100);
  return (
    <View style={styles.root}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        outputs={[output]}
        isActive={active && foreground}
        enableDistortionCorrection
        enableLowLightBoost={device.supportsLowLightBoost}
        onStarted={() => {
          setReady(true);
          onStatus?.('Vision Camera acquired the rear camera.');
        }}
        onStopped={() => {
          setReady(false);
          if (releaseRequested) deliver(true);
        }}
        onInterruptionStarted={(reason) => {
          setReady(false);
          setMessage(`Camera interrupted (${reason}). Hold position while it recovers.`);
        }}
        onInterruptionEnded={() => setMessage('Resume turning in the same direction.')}
        onError={(error) => {
          setReady(false);
          setMessage(`Camera unavailable: ${error.message}`);
        }}
      />
      <View pointerEvents="none" style={styles.guide} />
      <View style={styles.panel}>
        <Text style={styles.title}>Turn once around</Text>
        <Text style={styles.text}>{message}</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
        <Text style={styles.progressText}>
          {Math.round(turnDegrees)}° / {sweepDegrees}° · {references.length}/{referenceCount} views
          {capturing ? ' · capturing…' : ''}
        </Text>
        {sweep === 'idle' && (
          <Button title="Start quick calibration" disabled={!ready} onPress={() => void startSweep()} />
        )}
        {sweep === 'starting' && <Button title="Starting…" disabled />}
        {sweep === 'turning' && (
          <Button title="Capture manually instead" disabled={capturing} onPress={switchToManual} />
        )}
        {sweep === 'manual' && (
          <Button
            title={capturing ? 'Capturing…' : `Capture view ${references.length + 1}`}
            disabled={!ready || capturing || references.length >= referenceCount}
            onPress={() => void captureManual()}
          />
        )}
        {(sweep === 'turning' || sweep === 'complete' || sweep === 'manual') && (
          <Button
            title="Restart calibration"
            disabled={capturing || releaseRequested}
            onPress={resetSweep}
          />
        )}
        <Button
          title={releaseRequested ? 'Releasing camera…' : 'Continue to room measurement'}
          disabled={!ready || capturing || releaseRequested || sweep !== 'complete'}
          onPress={requestHandoff}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  guide: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '19%',
    bottom: '34%',
    borderWidth: 1,
    borderColor: '#c9e7ff99',
    borderRadius: 18,
  },
  panel: { marginTop: 'auto', padding: 24, gap: 12, backgroundColor: '#111b2bf2' },
  text: { color: '#dde4ee', fontSize: 15, lineHeight: 21 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: '#34465c', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#59c8ff' },
  progressText: { color: '#8bd0ff', fontSize: 13 },
  title: { color: 'white', fontSize: 25, fontWeight: '600' },
});
