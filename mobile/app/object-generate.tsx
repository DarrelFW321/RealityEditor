import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Button, ScrollView, Text, TextInput, View } from 'react-native';
import { Canvas } from '@react-three/fiber/native';
import { router } from 'expo-router';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  assetURL,
  awaitJob,
  startGeneration,
  type GeneratedAsset,
  type ObjectJob,
} from '../src/rendering/objects/generate-client';
import { disposeGltf, loadGlbFromUrl, measureBounds, type MeasuredBounds } from '../src/rendering/objects/load-glb';
import { apiURL, apiURLSource } from '../src/runtime/api-url';

const DEFAULT_PROMPT = 'A large blue freestanding shelving unit with four empty compartments';

function ObjectStage({ gltf, bounds }: { gltf: GLTF; bounds: MeasuredBounds }) {
  // Frame by the object's real size rather than a fixed camera: a lamp and a sofa
  // differ by an order of magnitude and one camera cannot suit both.
  const { width, height, depth } = bounds.dimensionsM;
  const reach = Math.max(width, height, depth) * 2.2;
  return (
    <Canvas
      camera={{ fov: 45, near: 0.01, far: 100, position: [reach, reach * 0.8, reach] }}
      gl={{ alpha: false, antialias: true }}
      // Pixel ratio 1 on purpose: a retina buffer triples the fragment cost for a
      // preview, and textured GLBs are already the memory risk on this device.
      onCreated={({ camera, gl }) => {
        gl.setPixelRatio(1);
        gl.setClearColor('#101a27', 1);
        camera.lookAt(0, bounds.dimensionsM.height / 2, 0);
      }}
      style={{ flex: 1 }}
    >
      <ambientLight intensity={1.6} />
      <directionalLight position={[3, 6, 4]} intensity={2.2} />
      <group position={bounds.offset}>
        <primitive object={gltf.scene} />
      </group>
    </Canvas>
  );
}

export default function ObjectGenerate() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [job, setJob] = useState<ObjectJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [bounds, setBounds] = useState<MeasuredBounds | null>(null);
  const [stage, setStage] = useState('');
  const owned = useRef<GLTF | null>(null);

  const show = useCallback(async (asset: GeneratedAsset, label: string) => {
    const loaded = await loadGlbFromUrl(assetURL(asset));
    const measured = measureBounds(loaded.scene);
    if (owned.current) disposeGltf(owned.current);
    owned.current = loaded;
    setGltf(loaded);
    setBounds(measured);
    setStage(label);
  }, []);

  useEffect(() => () => {
    if (owned.current) disposeGltf(owned.current);
    owned.current = null;
  }, []);

  const generate = useCallback(async () => {
    setBusy(true);
    setError('');
    setStage('');
    try {
      const started = await startGeneration(prompt);
      setJob(started);
      const finished = await awaitJob(started.id, {
        onUpdate: setJob,
        // Untextured geometry lands well before the texture does.
        onPreview: (asset) => void show(asset, 'preview (untextured)').catch(() => {}),
      });
      setJob(finished);
      if (finished.asset) await show(finished.asset, finished.source === 'catalog' ? 'catalog' : 'generated');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [prompt, show]);

  if (!__DEV__) return <Text style={{ padding: 40, color: '#fff' }}>Development-only screen.</Text>;

  const disclosures = job?.catalog?.disclosures ?? job?.spec?.disclosedDefaults ?? [];

  return (
    <View style={{ flex: 1, paddingTop: 60, paddingHorizontal: 14, backgroundColor: '#0c1420' }}>
      <Text style={{ color: '#8fa3bf', fontSize: 12 }}>
        objects · {apiURL()} ({apiURLSource()})
      </Text>

      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        editable={!busy}
        style={{ color: '#fff', backgroundColor: '#16202e', borderRadius: 8, padding: 10, marginTop: 8, minHeight: 64 }}
      />

      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', marginTop: 6 }}>
        <Button title={busy ? 'Generating…' : 'Generate'} onPress={generate} disabled={busy} />
        <Button title="Back" onPress={() => router.back()} />
        {busy ? <ActivityIndicator color="#8fa3bf" /> : null}
      </View>

      {job ? (
        <Text style={{ color: '#8fa3bf', fontSize: 12, marginTop: 6 }}>
          {job.source === 'catalog' ? 'Catalog match' : 'Generated live'} · {job.status} · {job.progress}% · {job.message}
          {job.timings ? ` · ${(job.timings.totalMs / 1000).toFixed(1)}s` : ''}
        </Text>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={{ color: '#ff8f8f', marginTop: 6 }}>
          {error}
        </Text>
      ) : null}

      <View style={{ flex: 1, marginTop: 10, borderRadius: 10, overflow: 'hidden', backgroundColor: '#101a27' }}>
        {gltf && bounds ? (
          <ObjectStage gltf={gltf} bounds={bounds} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#4f6076' }}>Nothing loaded yet</Text>
          </View>
        )}
      </View>

      {bounds ? (
        <ScrollView style={{ maxHeight: 108, marginTop: 8 }}>
          <Text selectable style={{ color: '#8fa3bf', fontSize: 11 }}>
            {stage} · {bounds.dimensionsM.width.toFixed(2)} × {bounds.dimensionsM.height.toFixed(2)} ×{' '}
            {bounds.dimensionsM.depth.toFixed(2)} m · {bounds.triangles.toLocaleString()} tris ·{' '}
            {bounds.materials} materials · {bounds.textures} textures
            {disclosures.length ? `\n${disclosures.map((d) => `• ${d}`).join('\n')}` : ''}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
