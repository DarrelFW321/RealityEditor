import { sampleRoomFurnished } from '@reality/dev-scenarios';
import { TextureFrameStream, type TextureFrame, type TextureFrameSource } from './frame-textures';
import type { Scenario, StepResult } from './scenarios';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const request = { contextId: 1, frameId: 'room-frame', width: 320, height: 640 };
function bundle(sequence = 1): TextureFrame {
  return {
    version: 1, leaseId: `lease-${sequence}`, contextId: 1, frameId: request.frameId,
    generation: 1, sequence, timestamp: 1000 + sequence, nativeAgeMs: 5,
    viewportWidth: 320, viewportHeight: 640,
    cameraToWorld: identity, projection: identity, roomAnchor: identity,
    displayToImage: [1,0,0, 0,1,0, 0,0,1],
    videoRange: false, bt709: true, leasedSlots: 1, dropped: 0,
    textures: { luma: { id: 1, width: 640, height: 480 }, chroma: { id: 2, width: 320, height: 240 } },
  };
}
const check = (label: string, ok: boolean): StepResult => ({ label, ok, detail: ok ? 'passed' : 'failed' });
function harness() {
  let time = 0;
  let next: unknown = bundle();
  const released: string[] = [];
  const source: TextureFrameSource = {
    acquire: async () => next,
    release: async id => { released.push(id); },
  };
  const stream = new TextureFrameStream(source, request, () => time);
  return { stream, released, set: (value: unknown) => { next = value; }, advance: (ms: number) => { time += ms; } };
}

export const compositingScenarios: Scenario[] = [
  {
    id: 'm8-frame-identity', title: 'Native bundles reject mismatched identities and malformed metadata',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness();
      const invalid = [
        { ...bundle(), contextId: 2 }, { ...bundle(), frameId: 'other-frame' },
        { ...bundle(), viewportWidth: 640 }, { ...bundle(), cameraToWorld: [1] },
        { ...bundle(), projection: identity.map(() => NaN) }, { ...bundle(), leasedSlots: 4 },
        { ...bundle(), roomAnchor: identity.map(() => 0) },
        { ...bundle(), displayToImage: Array(9).fill(0) },
        { ...bundle(), cameraToWorld: Array(18).fill(1) },
        { ...bundle(), textures: { luma: bundle().textures.luma, chroma: bundle().textures.luma } },
      ];
      for (const value of invalid) { h.set(value); await h.stream.poll(); }
      const steps = [check('all malformed/mismatched frames rejected and released',
        h.stream.read() === null && h.released.length === invalid.length && h.stream.rejected === invalid.length)];
      h.set(bundle()); await h.stream.poll();
      steps.push(check('camera-only bundle is usable for diagnostics, not evidence of foreground support',
        h.stream.read()?.sequence === 1 && !h.stream.read()?.textures.foreground));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-freshness', title: 'Stale and reordered camera bundles never masquerade as live',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      h.advance(151);
      const steps = [check('old frame clears and releases even without new input',
        h.stream.read() === null && h.released.length === 1)];
      h.set(bundle(2)); await h.stream.poll();
      h.set({ ...bundle(3), timestamp: 1001 }); await h.stream.poll();
      steps.push(check('increasing request sequence cannot hide repeated/older AR pixels', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(4), generation: 0 }); await h.stream.poll();
      steps.push(check('older adapter generation rejected', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(5), nativeAgeMs: 200 }); await h.stream.poll();
      steps.push(check('native capture age participates in freshness', h.stream.read()?.sequence === 2));
      h.set({ ...bundle(1), generation: 2 }); await h.stream.poll();
      steps.push(check('new adapter generation can restart sequence', h.stream.read()?.generation === 2));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-lifecycle', title: 'Texture requests are bounded and late results are disposed',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      let resolve!: (value: unknown) => void;
      let requested = 0;
      const released: string[] = [];
      const stream = new TextureFrameStream({
        acquire: () => { requested++; return new Promise(r => { resolve = r; }); },
        release: async id => { released.push(id); },
      }, request, () => 0);
      const pending = stream.poll(); await stream.poll(); await stream.poll();
      const steps = [check('only one request is in flight', requested === 1 && stream.busy)];
      stream.dispose(); resolve(bundle()); await pending;
      steps.push(check('late completion after context disposal is released, never shown',
        stream.read() === null && released.length === 1));
      await stream.poll();
      steps.push(check('disposed stream cannot silently resume', requested === 1));
      const h = harness();
      for (let i = 1; i <= 10; i++) { h.set(bundle(i)); await h.stream.poll(); }
      h.stream.dispose(); h.stream.dispose();
      steps.push(check('ten replacements/disposal release every lease exactly once',
        h.released.length === 10 && new Set(h.released).size === 10));
      return steps;
    },
  },
  {
    id: 'm8-frame-transit', title: 'Slow upload and transport failure degrade to unavailable',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      let time = 0, fail = false;
      const released: string[] = [];
      const stream = new TextureFrameStream({
        acquire: async () => { if (fail) throw new Error('offline'); time += 200; return bundle(); },
        release: async id => { released.push(id); },
      }, request, () => time);
      await stream.poll();
      const steps = [check('bridge transit is conservatively included in age', stream.read() === null && released.length === 1)];
      fail = true; await stream.poll();
      steps.push(check('transport error is counted without leaking a pending request', stream.errors === 1 && !stream.busy));
      stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-unavailable', title: 'Tracking loss clears a still-fresh displayed frame immediately',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      const steps = [check('fresh frame initially displayed', h.stream.read() !== null)];
      h.set(null); await h.stream.poll();
      steps.push(check('unavailable response clears and releases without waiting 150 ms',
        h.stream.read() === null && h.released.length === 1));
      h.stream.dispose(); return steps;
    },
  },
  {
    id: 'm8-frame-duplicate-lease', title: 'Repeated lease tokens cannot destroy the displayed texture',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness(); await h.stream.poll();
      await h.stream.poll();
      const steps = [check('exact duplicate is rejected without releasing the current lease',
        h.stream.read()?.sequence === 1 && h.released.length === 0)];
      h.set({ ...bundle(2), leaseId: 'lease-1' }); await h.stream.poll();
      steps.push(check('same token with newer metadata is still not a new resource',
        h.stream.read()?.sequence === 1 && h.released.length === 0));
      h.stream.dispose();
      steps.push(check('owner eventually releases token once', h.released.length === 1));
      return steps;
    },
  },
  {
    id: 'm8-frame-release-failure', title: 'Synchronous release failures cannot retain displayed state',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const stream = new TextureFrameStream({
        acquire: async () => bundle(),
        release: () => { throw new Error('native module already destroyed'); },
      }, request, () => 0);
      await stream.poll(); stream.dispose(); stream.dispose();
      return [check('dispose clears state and records one release failure without throwing',
        stream.read() === null && stream.errors === 1)];
    },
  },
  {
    id: 'm8-frame-optional-textures', title: 'Explicitly absent optional texture fields remain supported',
    milestone: 'M8', gate: 'compositor', scene: sampleRoomFurnished,
    async run() {
      const h = harness();
      h.set({ ...bundle(), textures: { ...bundle().textures, depth: undefined, foreground: undefined } });
      await h.stream.poll();
      const steps = [check('camera-only optional fields do not throw during handle validation',
        h.stream.read() !== null && h.stream.errors === 0)];
      h.stream.dispose(); return steps;
    },
  },
];
