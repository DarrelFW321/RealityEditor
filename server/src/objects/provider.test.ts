import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshyObjectProvider, meshyPreviewBody, meshyRefineBody } from './provider.js';

const ENDPOINT = 'https://api.meshy.ai/openapi/v2/text-to-3d';
const TASK_URL = `${ENDPOINT}/task-1`;

function meshyStub(options: {
  onSubmit?: (body: Record<string, unknown>) => void;
  glbUrl?: string;
  body?: Buffer;
}): typeof fetch {
  const glbUrl = options.glbUrl ?? 'https://assets.example/model.glb';
  return (async (url: string, init: RequestInit = {}) => {
    if (url === ENDPOINT && init.method === 'POST') {
      options.onSubmit?.(JSON.parse(String(init.body)));
      return Response.json({ result: 'task-1' });
    }
    if (url === TASK_URL) {
      return Response.json({ status: 'SUCCEEDED', progress: 100, consumed_credits: 20, model_urls: { glb: glbUrl } });
    }
    if (url === glbUrl) return new Response(options.body ?? Buffer.from('glb bytes'));
    throw new Error(`Unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}

test('preview submits a meshy-7.1 task with bounded polycount', async () => {
  let submitted: Record<string, unknown> = {};
  const provider = new MeshyObjectProvider('test-key', meshyStub({ onSubmit: (b) => { submitted = b; } }), 0);
  const result = await provider.preview({ prompt: 'a tall oak shelving unit' });

  assert.equal(submitted.mode, 'preview');
  assert.equal(submitted.prompt, 'a tall oak shelving unit');
  assert.equal(submitted.ai_model, 'meshy-7.1');
  assert.equal(submitted.should_remesh, true);
  assert.equal(submitted.topology, 'triangle');
  assert.equal(submitted.target_polycount, 50_000);
  assert.deepEqual(submitted.target_formats, ['glb']);
  assert.equal(result.consumedCredits, 20);
});

test('refine inherits the preview model by omitting ai_model', async () => {
  let submitted: Record<string, unknown> = {};
  const provider = new MeshyObjectProvider('test-key', meshyStub({ onSubmit: (b) => { submitted = b; } }), 0);
  await provider.refine({ previewTaskId: 'preview-9', texturePrompt: 'pale natural oak' });

  assert.equal(submitted.mode, 'refine');
  assert.equal(submitted.preview_task_id, 'preview-9');
  assert.equal(submitted.enable_pbr, true);
  assert.equal(submitted.texture_resolution, '2k');
  // A model mismatch between preview and refine is a documented 400.
  assert.ok(!('ai_model' in submitted), 'refine must not send ai_model');
});

test('neither stage sends deprecated or unwanted fields', () => {
  for (const body of [meshyPreviewBody({ prompt: 'x' }), meshyRefineBody({ previewTaskId: 'y' })]) {
    assert.ok(!('art_style' in body), 'art_style is deprecated');
    assert.ok(!('symmetry_mode' in body), 'symmetry_mode is deprecated');
    assert.ok(!('geometry_resolution' in body), 'we build at standard geometry resolution');
  }
});

test('refine omits texture_prompt when none is given', () => {
  assert.ok(!('texture_prompt' in meshyRefineBody({ previewTaskId: 'y' })));
  assert.equal(meshyRefineBody({ previewTaskId: 'y', texturePrompt: 'oak' }).texture_prompt, 'oak');
});

test('an expired download URL is refreshed rather than abandoned', async () => {
  const fresh = 'https://assets.example/fresh.glb';
  let statusReads = 0;
  let expiredHits = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url === ENDPOINT && init.method === 'POST') return Response.json({ result: 'task-1' });
    if (url === TASK_URL) {
      statusReads += 1;
      const glb = statusReads === 1 ? 'https://assets.example/expired.glb' : fresh;
      return Response.json({ status: 'SUCCEEDED', progress: 100, model_urls: { glb } });
    }
    if (url === 'https://assets.example/expired.glb') {
      expiredHits += 1;
      return new Response('gone', { status: 403 });
    }
    if (url === fresh) return new Response(Buffer.from('fresh bytes'));
    throw new Error(`Unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  const result = await new MeshyObjectProvider('test-key', fetchImpl, 0).preview({ prompt: 'a bench' });
  assert.equal(expiredHits, 1);
  assert.equal(statusReads, 2);
  assert.deepEqual(result.bytes, Buffer.from('fresh bytes'));
});

test('a failed task surfaces the provider error message', async () => {
  const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') return Response.json({ result: 'task-1' });
    return Response.json({ status: 'FAILED', task_error: { message: 'moderation blocked' } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    new MeshyObjectProvider('test-key', fetchImpl, 0).preview({ prompt: 'a bench' }),
    /preview failed: moderation blocked/,
  );
});

test('a missing key fails before any network call', async () => {
  const provider = new MeshyObjectProvider('', (() => { throw new Error('should not fetch'); }) as unknown as typeof fetch);
  await assert.rejects(provider.preview({ prompt: 'a bench' }), /MESHY_API_KEY is not configured/);
});
