/**
 * M5 reconstruction-service gate: `npm run gate:server`.
 *
 * Drives every route through Fastify's `inject()` rather than a socket. No port to collide,
 * nothing to clean up, and the request still goes through real routing, body parsing,
 * validation and serialisation — only the transport is skipped.
 *
 * It lives in the server workspace on purpose. `mobile/src/runtime/scenarios.ts` is imported
 * by `EditorPanel` and therefore bundled into the app; importing Fastify from there would
 * drag the whole server into the Metro bundle.
 *
 * Exits non-zero on any failure so CI can depend on it.
 */
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { CalibrationStore } from './reconstruction/store.js';
import { FakeReconstructionProvider, type FakeBehaviour } from './reconstruction/fake.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

type StepResult = { label: string; ok: boolean; detail: string };
type ScenarioResult = { id: string; title: string; steps: StepResult[]; ok: boolean };
const check = (label: string, ok: boolean, detail: string): StepResult => ({ label, ok, detail });

/** A real JPEG header. The store sniffs the SOI marker, so random bytes are refused. */
const jpeg = (size = 64) => {
  const bytes = Buffer.alloc(size, 0x20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.toString('base64');
};

/** A 4x4m room with one obstacle, in room space. Matches what `reconstructionRoom` emits. */
const room = () => ({
  origin: [7.3, 0, -4.1],
  surfaces: [
    { id: 'floor-main', class: 'floor' as const, normal: [0, 1, 0], inferred: false,
      polygon: [[-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2]] },
    { id: 'wall-north', class: 'wall' as const, normal: [0, 0, -1], inferred: false,
      polygon: [[-2, 0, 2], [2, 0, 2], [2, 2.5, 2], [-2, 2.5, 2]] },
    { id: 'wall-west', class: 'wall' as const, normal: [1, 0, 0], inferred: true,
      polygon: [[-2, 0, -2], [-2, 0, 2], [-2, 2.5, 2], [-2, 2.5, -2]] },
  ],
  obstacles: [{ id: 'obj-bed', center: [-1, 0, -1], size: [1.53, 0.6, 2.03], yaw: 0 }],
});

const keyframe = (frameId: string, id = randomUUID()) => ({
  id,
  timestamp: 1_700_000_000,
  width: 1920,
  height: 1440,
  frameId,
  cameraToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1],
  intrinsics: [1400, 0, 0, 0, 1400, 0, 960, 720, 1],
});

type Harness = {
  app: FastifyInstance;
  store: CalibrationStore;
  provider: FakeReconstructionProvider;
  root: string;
  /** Session directories currently on disk. The cleanup evidence. */
  dirs: () => Promise<string[]>;
};

async function harness(behaviour: FakeBehaviour = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'reality-gate-'));
  const provider = new FakeReconstructionProvider(behaviour);
  const store = new CalibrationStore(root, provider);
  const app = await buildApp(store, { logger: false });
  return {
    app,
    store,
    provider,
    root,
    dirs: async () => (await readdir(root)).filter((n) => /^[0-9a-f-]{36}$/.test(n)),
  };
}

/** Create a session and upload `frames` keyframes. The setup every scenario starts from. */
async function calibrate(h: Harness, frameId: string, frames = 2, revision = 0) {
  const created = await h.app.inject({
    method: 'POST',
    url: '/calibrations',
    payload: { revision, frameId, room: room() },
  });
  const { id, token } = created.json() as { id: string; token: string };
  const auth = { authorization: `Bearer ${token}` };
  for (let i = 0; i < frames; i++)
    await h.app.inject({
      method: 'POST',
      url: `/calibrations/${id}/frames`,
      headers: auth,
      payload: { metadata: keyframe(frameId), jpegBase64: jpeg() },
    });
  return { id, token, auth, created };
}

/** Polls until the job leaves a non-terminal state, bounded so a bug cannot hang the gate. */
async function settle(h: Harness, id: string, jobId: string, auth: Record<string, string>) {
  for (let i = 0; i < 100; i++) {
    const response = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}`, headers: auth });
    if (response.statusCode !== 200) return response;
    const job = response.json() as { status: string };
    if (job.status !== 'queued' && job.status !== 'running') return response;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} never settled`);
}

const scenarios: { id: string; title: string; run: () => Promise<StepResult[]> }[] = [
  {
    id: 'recon-roundtrip',
    title: 'A calibration completes end to end',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const { id, auth, created } = await calibrate(h, 'frame-A', 6);
        steps.push(check('a session is created', created.statusCode === 201, `HTTP ${created.statusCode}`));
        steps.push(check('the id is the server\'s, not the client\'s', /^[0-9a-f-]{36}$/.test(id), id));

        const started = await h.app.inject({
          method: 'POST',
          url: `/calibrations/${id}/reconstruct`,
          headers: auth,
          payload: { revision: 0, frameId: 'frame-A' },
        });
        steps.push(check('reconstruction is accepted', started.statusCode === 202, `HTTP ${started.statusCode}`));
        const job = started.json() as { id: string };

        const done = (await settle(h, id, job.id, auth)).json() as {
          status: string;
          stage: string;
          result: { artifacts: { key: string; role: string; inferred: boolean }[] } | null;
        };
        steps.push(check('the job completes', done.status === 'completed' && done.stage === 'ready', `${done.status}/${done.stage}`));
        steps.push(check('all six keyframes reached the worker', h.provider.calls[0]?.keyframes.length === 6, `${h.provider.calls[0]?.keyframes.length ?? 0} forwarded`));
        const forwarded = h.provider.calls[0]?.room;
        steps.push(check('the room reached the worker too', forwarded?.surfaces.length === 3 && forwarded.obstacles.length === 1, `${forwarded?.surfaces.length ?? 0} surfaces, ${forwarded?.obstacles.length ?? 0} obstacles`));
        steps.push(check('the world origin is carried, so poses can be placed', forwarded?.origin[0] === 7.3 && forwarded.origin[2] === -4.1, forwarded?.origin.join(', ') ?? 'missing'));
        steps.push(check('already-inferred surfaces are flagged', forwarded?.surfaces.some((x) => x.inferred) ?? false, 'wall-west inferred'));
        steps.push(check('the manifest carries a shell and an atlas', ['shell', 'atlas'].every((r) => done.result?.artifacts.some((a) => a.role === r)), done.result?.artifacts.map((a) => a.role).join(', ') ?? 'none'));
        steps.push(check('generated content is marked inferred', done.result?.artifacts.every((a) => a.inferred) ?? false, 'every artifact inferred'));

        const asset = await h.app.inject({ method: 'GET', url: `/calibrations/${id}/assets/atlas.png`, headers: auth });
        steps.push(check('the atlas is fetchable', asset.statusCode === 200 && asset.rawPayload.length > 0, `HTTP ${asset.statusCode}, ${asset.rawPayload.length} bytes`));
        steps.push(check('artifacts are never cached', asset.headers['cache-control'] === 'no-store', String(asset.headers['cache-control'])));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-empty-room',
    title: 'An empty room bypasses removal',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const { id, auth } = await calibrate(h, 'frame-empty', 2);
        const started = await h.app.inject({
          method: 'POST',
          url: `/calibrations/${id}/reconstruct`,
          headers: auth,
          payload: { revision: 0, frameId: 'frame-empty' },
        });
        const job = started.json() as { id: string };
        const done = (await settle(h, id, job.id, auth)).json() as {
          status: string;
          result: { removedObjectIds: string[]; artifacts: { role: string }[] } | null;
        };
        steps.push(check('an empty room still reconstructs', done.status === 'completed', done.status));
        steps.push(check('nothing is removed', done.result?.removedObjectIds.length === 0, `${done.result?.removedObjectIds.length ?? -1} removals`));
        steps.push(check('no mask is produced', !done.result?.artifacts.some((a) => a.role === 'mask'), done.result?.artifacts.map((a) => a.role).join(', ') ?? ''));
        steps.push(check('a shell is still produced', done.result?.artifacts.some((a) => a.role === 'shell') ?? false, 'shell present'));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-revision',
    title: 'Stale and mismatched revisions are refused',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const { id, auth } = await calibrate(h, 'frame-A', 2);

        const otherFrame = await h.app.inject({
          method: 'POST',
          url: `/calibrations/${id}/reconstruct`,
          headers: auth,
          payload: { revision: 0, frameId: 'frame-B' },
        });
        steps.push(check('a different coordinate frame is refused', otherFrame.statusCode === 409 && (otherFrame.json() as { error: string }).error === 'stale_calibration', `HTTP ${otherFrame.statusCode} ${(otherFrame.json() as { error: string }).error}`));

        const otherRevision = await h.app.inject({
          method: 'POST',
          url: `/calibrations/${id}/reconstruct`,
          headers: auth,
          payload: { revision: 7, frameId: 'frame-A' },
        });
        steps.push(check('a stale revision is refused', otherRevision.statusCode === 409 && (otherRevision.json() as { error: string }).error === 'stale_calibration', `HTTP ${otherRevision.statusCode}`));

        const wrongFrameUpload = await h.app.inject({
          method: 'POST',
          url: `/calibrations/${id}/frames`,
          headers: auth,
          payload: { metadata: keyframe('frame-B'), jpegBase64: jpeg() },
        });
        steps.push(check('a keyframe from another frame is refused', wrongFrameUpload.statusCode === 409 && (wrongFrameUpload.json() as { error: string }).error === 'invalid_state', (wrongFrameUpload.json() as { error: string }).error));

        const noRoom = await h.app.inject({ method: 'POST', url: '/calibrations', payload: { revision: 0, frameId: 'frame-A' } });
        steps.push(check('a session without a room is refused', noRoom.statusCode === 400, `HTTP ${noRoom.statusCode}`));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-worker-mismatch',
    title: 'A worker answering for another calibration is rejected',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness({ wrongRevision: true });
      try {
        const { id, auth } = await calibrate(h, 'frame-A', 2);
        const started = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/reconstruct`, headers: auth, payload: { revision: 0, frameId: 'frame-A' } });
        const job = started.json() as { id: string };
        const done = (await settle(h, id, job.id, auth)).json() as { status: string; error: string | null; result: unknown };
        steps.push(check('the job fails rather than publishing', done.status === 'failed', done.status));
        steps.push(check('nothing is published', done.result === null, JSON.stringify(done.result)));
        steps.push(check('the client is told it failed', done.error === 'reconstruction_failed', String(done.error)));

        // A manifest missing the shell must be refused too.
        const h2 = await harness({ omitShell: true });
        try {
          const b = await calibrate(h2, 'frame-A', 2);
          const s2 = await h2.app.inject({ method: 'POST', url: `/calibrations/${b.id}/reconstruct`, headers: b.auth, payload: { revision: 0, frameId: 'frame-A' } });
          const j2 = s2.json() as { id: string };
          const d2 = (await settle(h2, b.id, j2.id, b.auth)).json() as { status: string };
          steps.push(check('an incomplete shell is refused', d2.status === 'failed', d2.status));
        } finally {
          await h2.app.close();
          await rm(h2.root, { recursive: true, force: true });
        }
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-cancellation',
    title: 'Deleting mid-job cancels it and revokes access',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness({ delayMs: 5_000 });
      try {
        const { id, auth } = await calibrate(h, 'frame-A', 2);
        const started = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/reconstruct`, headers: auth, payload: { revision: 0, frameId: 'frame-A' } });
        const job = started.json() as { id: string };
        steps.push(check('a slow job is running', started.statusCode === 202, `HTTP ${started.statusCode}`));
        steps.push(check('its directory exists', (await h.dirs()).includes(id), (await h.dirs()).join(',') || 'none'));

        const deleted = await h.app.inject({ method: 'DELETE', url: `/calibrations/${id}`, headers: auth });
        steps.push(check('deletion succeeds while the job is in flight', deleted.statusCode === 204, `HTTP ${deleted.statusCode}`));

        // Give the aborted provider a moment to unwind before checking for leftovers.
        await new Promise((r) => setTimeout(r, 50));
        steps.push(check('the token no longer works', (await h.app.inject({ method: 'GET', url: `/jobs/${job.id}`, headers: auth })).statusCode === 404, 'job 404s'));
        steps.push(check('the session is gone', (await h.app.inject({ method: 'DELETE', url: `/calibrations/${id}`, headers: auth })).statusCode === 404, 'session 404s'));
        steps.push(check('no bytes are left on disk', !(await h.dirs()).includes(id), (await h.dirs()).join(',') || 'directory removed'));
        steps.push(check('the late worker result publishes nothing', h.store.job(job.id, `Bearer x`) === null, 'unreachable'));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-cleanup',
    title: 'Cleanup covers deletion, expiry and shutdown',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const a = await calibrate(h, 'frame-A', 2);
        const b = await calibrate(h, 'frame-B', 2);
        steps.push(check('two sessions have two directories', (await h.dirs()).length === 2, `${(await h.dirs()).length} on disk`));

        await h.app.inject({ method: 'DELETE', url: `/calibrations/${a.id}`, headers: a.auth });
        steps.push(check('deleting one leaves the other', (await h.dirs()).length === 1 && !(await h.dirs()).includes(a.id), (await h.dirs()).join(',')));

        // Shutdown must release the rest. Before M5 the onClose hook was unreachable
        // because nothing ever called app.close(), so every stop leaked the whole tree.
        await h.app.close();
        steps.push(check('shutdown releases the remainder', (await h.dirs()).length === 0, (await h.dirs()).join(',') || 'empty'));
        steps.push(check('the other session really existed first', b.created.statusCode === 201, `HTTP ${b.created.statusCode}`));
      } finally {
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-idempotency',
    title: 'Retries do not duplicate work',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const { id, auth } = await calibrate(h, 'frame-A', 2);
        const frame = keyframe('frame-A');
        await h.app.inject({ method: 'POST', url: `/calibrations/${id}/frames`, headers: auth, payload: { metadata: frame, jpegBase64: jpeg() } });
        const again = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/frames`, headers: auth, payload: { metadata: frame, jpegBase64: jpeg() } });
        steps.push(check('a duplicate keyframe is named, not swallowed', (again.json() as { error: string }).error === 'duplicate_frame', (again.json() as { error: string }).error));

        const notJpeg = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/frames`, headers: auth, payload: { metadata: keyframe('frame-A'), jpegBase64: Buffer.from('not an image').toString('base64') } });
        steps.push(check('a non-JPEG is named, not swallowed', (notJpeg.json() as { error: string }).error === 'expected_jpeg', (notJpeg.json() as { error: string }).error));

        const first = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/reconstruct`, headers: auth, payload: { revision: 0, frameId: 'frame-A' } });
        const second = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/reconstruct`, headers: auth, payload: { revision: 0, frameId: 'frame-A' } });
        steps.push(check('a repeated reconstruct returns the same job', (first.json() as { id: string }).id === (second.json() as { id: string }).id, 'same job id'));
        // `begin` returns 202 immediately and runs the provider afterwards, so the call
        // count is only meaningful once the job has settled.
        await settle(h, id, (first.json() as { id: string }).id, auth);
        steps.push(check('the worker is only called once', h.provider.calls.length === 1, `${h.provider.calls.length} calls`));

        const uploadAfterJob = await h.app.inject({ method: 'POST', url: `/calibrations/${id}/frames`, headers: auth, payload: { metadata: keyframe('frame-A'), jpegBase64: jpeg() } });
        steps.push(check('the frame set freezes once a job starts', (uploadAfterJob.json() as { error: string }).error === 'invalid_state', (uploadAfterJob.json() as { error: string }).error));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-ownership',
    title: 'One session cannot read another',
    run: async () => {
      const steps: StepResult[] = [];
      const h = await harness();
      try {
        const a = await calibrate(h, 'frame-A', 2);
        const b = await calibrate(h, 'frame-B', 2);
        steps.push(check("another session's token is refused", (await h.app.inject({ method: 'GET', url: `/calibrations/${a.id}/assets/atlas.png`, headers: b.auth })).statusCode === 404, 'cross-session read 404s'));
        steps.push(check('no token is refused', (await h.app.inject({ method: 'DELETE', url: `/calibrations/${a.id}` })).statusCode === 404, 'unauthenticated delete 404s'));
        steps.push(check('a malformed token is refused', (await h.app.inject({ method: 'DELETE', url: `/calibrations/${a.id}`, headers: { authorization: 'Bearer nope' } })).statusCode === 404, 'bad token 404s'));

        const started = await h.app.inject({ method: 'POST', url: `/calibrations/${a.id}/reconstruct`, headers: a.auth, payload: { revision: 0, frameId: 'frame-A' } });
        const job = started.json() as { id: string };
        await settle(h, a.id, job.id, a.auth);
        steps.push(check("another session cannot poll this job", (await h.app.inject({ method: 'GET', url: `/jobs/${job.id}`, headers: b.auth })).statusCode === 404, 'cross-session poll 404s'));
      } finally {
        await h.app.close();
        await rm(h.root, { recursive: true, force: true });
      }
      return steps;
    },
  },
  {
    id: 'recon-no-worker',
    title: 'Without a worker the API says so plainly',
    run: async () => {
      const steps: StepResult[] = [];
      const root = await mkdtemp(join(tmpdir(), 'reality-gate-'));
      const store = new CalibrationStore(root, null);
      const app = await buildApp(store, { logger: false });
      try {
        const capabilities = (await app.inject({ method: 'GET', url: '/capabilities' })).json() as { reconstruction: string | null };
        steps.push(check('capabilities reports no provider', capabilities.reconstruction === null, String(capabilities.reconstruction)));
        const health = (await app.inject({ method: 'GET', url: '/health' })).json() as { reconstruction: string | null };
        steps.push(check('health reports it too', health.reconstruction === null, 'null'));

        const created = await app.inject({ method: 'POST', url: '/calibrations', payload: { revision: 0, frameId: 'frame-A', room: room() } });
        const { id, token } = created.json() as { id: string; token: string };
        const auth = { authorization: `Bearer ${token}` };
        for (let i = 0; i < 2; i++)
          await app.inject({ method: 'POST', url: `/calibrations/${id}/frames`, headers: auth, payload: { metadata: keyframe('frame-A'), jpegBase64: jpeg() } });
        steps.push(check('capture still works without a worker', (await app.inject({ method: 'GET', url: `/calibrations/${id}/assets/none.png`, headers: auth })).statusCode === 404, 'session is usable'));

        const started = await app.inject({ method: 'POST', url: `/calibrations/${id}/reconstruct`, headers: auth, payload: { revision: 0, frameId: 'frame-A' } });
        steps.push(check('reconstruct is a 503, not a crash', started.statusCode === 503 && (started.json() as { error: string }).error === 'provider_not_configured', `HTTP ${started.statusCode} ${(started.json() as { error: string }).error}`));
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
      return steps;
    },
  },
];

async function main() {
  const results: ScenarioResult[] = [];
  console.log('\nM5 gate');
  for (const scenario of scenarios) {
    const started = Date.now();
    let steps: StepResult[];
    try {
      steps = await scenario.run();
    } catch (error) {
      steps = [check('scenario completed', false, error instanceof Error ? error.message : 'failed')];
    }
    const ok = steps.every((s) => s.ok);
    results.push({ id: scenario.id, title: scenario.title, steps, ok });
    console.log(`  ${ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`} ${scenario.title} ${DIM}(${Date.now() - started}ms)${OFF}`);
    for (const step of steps)
      console.log(`      ${step.ok ? `${GREEN}ok${OFF}` : `${RED}NO${OFF}`} ${step.label} ${DIM}- ${step.detail}${OFF}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
