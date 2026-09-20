import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectStore } from './store.js';
import { FakeObjectProvider, fakeTexturedGlb } from './fake.js';
import { validateGlb } from './glb.js';

async function withStore(
  run: (store: ObjectStore, root: string) => Promise<void>,
  options: { provider?: FakeObjectProvider | null; catalogDir?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'objects-'));
  const store = new ObjectStore(
    root,
    options.provider === undefined ? new FakeObjectProvider() : options.provider,
    options.catalogDir ?? null,
  );
  await store.initialize();
  try {
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The store queues generation, so a job is only finished once the queue drains. */
async function settle(store: ObjectStore, id: string) {
  for (let i = 0; i < 200; i += 1) {
    const job = store.getJob(id);
    if (job && (job.status === 'complete' || job.status === 'failed')) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('job did not settle');
}

test('a generated job produces an untextured preview then a textured asset', async () => {
  await withStore(async (store) => {
    const job = await settle(store, store.create({ prompt: 'a large blue shelving unit' }).id);
    assert.equal(job.status, 'complete');
    assert.equal(job.source, 'generated');
    assert.equal(job.credits, 30);

    assert.ok(job.previewAsset, 'preview asset lands first');
    assert.equal(job.previewAsset.textured, false);
    assert.ok(job.asset);
    assert.equal(job.asset.textured, true);
    assert.notEqual(job.previewAsset.sha256, job.asset.sha256);
  });
});

test('a colour in the prompt puts a tint segment on the textured URL only', async () => {
  await withStore(async (store) => {
    const blue = await settle(store, store.create({ prompt: 'a large blue shelving unit' }).id);
    assert.match(blue.asset!.url, /^\/objects\/assets\/[a-f0-9]{64}\/2867b2\.glb$/);
    // The preview has a flat material already, so tinting it would double-apply.
    assert.match(blue.previewAsset!.url, /^\/objects\/assets\/[a-f0-9]{64}\.glb$/);

    const plain = await settle(store, store.create({ prompt: 'a shelving unit' }).id);
    assert.match(plain.asset!.url, /^\/objects\/assets\/[a-f0-9]{64}\.glb$/);
  });
});

test('readAsset tints on demand and caches the result', async () => {
  await withStore(async (store) => {
    const job = await settle(store, store.create({ prompt: 'a large blue shelving unit' }).id);
    const sha = job.asset!.sha256;
    const plain = await store.readAsset(sha);
    const tinted = await store.readAsset(sha, '2867b2');
    assert.notDeepEqual(plain, tinted);
    assert.deepEqual(await store.readAsset(sha, '2867b2'), tinted, 'second read hits the cache');
    assert.doesNotThrow(() => validateGlb(tinted));
  });
});

test('a provider failure marks the job failed with the provider message', async () => {
  await withStore(async (store) => {
    const job = await settle(store, store.create({ prompt: 'a bench' }).id);
    assert.equal(job.status, 'failed');
    assert.match(job.message, /fake failure/);
  }, { provider: new FakeObjectProvider('fail-refine') });
});

test('with no provider a job fails instead of hanging', async () => {
  await withStore(async (store) => {
    const job = store.create({ prompt: 'a bench' });
    assert.equal(job.status, 'failed');
    assert.match(job.message, /not configured/);
  }, { provider: null });
});

test('a catalog hit completes synchronously and never reaches the provider', async () => {
  const catalogDir = await mkdtemp(join(tmpdir(), 'catalog-'));
  await mkdir(join(catalogDir, 'assets'), { recursive: true });
  const glb = fakeTexturedGlb();
  const sha = validateGlb(glb).sha256;
  await writeFile(join(catalogDir, 'assets', `${sha}.glb`), glb);
  await writeFile(join(catalogDir, 'manifest.json'), JSON.stringify({
    entries: [{
      id: 'tall-shelving-unit', status: 'complete', category: 'shelving_unit', size: 'large',
      materialFamily: 'wood', baseFinish: 'pale oak', tintable: true,
      keywords: ['freestanding'], structure: { compartmentCount: 4 },
      sha256: sha, file: `assets/${sha}.glb`, triangles: 300, textures: 3,
    }],
  }));

  try {
    await withStore(async (store) => {
      assert.equal(store.catalogInfo.entries, 1);
      const job = store.create({ prompt: 'a large blue freestanding shelving unit with four empty compartments' });
      // No awaiting the queue: a catalog hit resolves before create() returns. The
      // provider is rigged to fail, so reaching it at all would show up here.
      assert.equal(job.status, 'complete');
      assert.equal(job.source, 'catalog');
      assert.equal(job.catalog?.id, 'tall-shelving-unit');
      assert.ok(job.catalog?.disclosures.includes('pre-made catalog object'));
      assert.match(job.asset!.url, /\/2867b2\.glb$/, 'blue is applied as a tint');
      // Served straight out of the catalog directory, not the job root.
      assert.doesNotThrow(() => validateGlb(Buffer.from(glb)));
      assert.equal(store.fileFor(sha), join(catalogDir, 'assets', `${sha}.glb`));
    }, { provider: new FakeObjectProvider('fail-preview'), catalogDir });
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test('a malformed manifest is reported, not thrown', async () => {
  const catalogDir = await mkdtemp(join(tmpdir(), 'catalog-bad-'));
  await writeFile(join(catalogDir, 'manifest.json'), '{ not json');
  try {
    await withStore(async (store) => {
      assert.equal(store.catalogInfo.entries, 0);
      assert.match(store.catalogInfo.error ?? '', /not valid JSON/);
    }, { catalogDir });
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});
