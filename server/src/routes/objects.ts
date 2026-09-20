import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { interpretPrompt } from '@reality/object-spec';
import { ObjectStore } from '../objects/store.js';

const Prompt = z.object({ prompt: z.string().min(3).max(1000) }).strict();

const SHA256 = /^[a-f0-9]{64}$/;
const TINT_FILE = /^([0-9a-f]{6})\.glb$/;
const SHA_FILE = /^([a-f0-9]{64})\.glb$/;

/** Content-addressed, so the bytes behind a URL never change. */
const IMMUTABLE = 'public, max-age=3600';

async function sendGlb(reply: FastifyReply, read: () => Promise<Buffer>) {
  try {
    const bytes = await read();
    return reply.code(200).header('cache-control', IMMUTABLE).type('model/gltf-binary').send(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return reply.code(404).send({ error: 'asset_not_found' });
    }
    // A tint against an untextured asset is a bad request, not a server fault.
    return reply.code(409).send({ error: 'asset_not_tintable', message: (error as Error).message });
  }
}

export async function registerObjectRoutes(app: FastifyInstance, store: ObjectStore) {
  await store.initialize();

  app.post('/objects', async (request, reply) => {
    const data = Prompt.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: 'invalid_prompt' });
    const job = store.create(data.data);
    // 503 only when nothing could serve it: no catalog hit and no provider.
    if (job.status === 'failed' && !store.providerId) {
      return reply.code(503).send({ error: 'not_configured', message: job.message });
    }
    return reply.code(202).send({ job });
  });

  app.get<{ Params: { id: string } }>('/objects/jobs/:id', async (request, reply) => {
    const job = store.getJob(request.params.id);
    return job ? reply.send({ job }) : reply.code(404).send({ error: 'job_not_found' });
  });

  app.get('/objects/catalog', async () => ({
    entries: store.catalogEntries.map(({ file, ...entry }) => entry),
  }));

  /** Parse without generating, so the app can preview a spec for free. */
  app.post('/objects/interpret', async (request, reply) => {
    const data = Prompt.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: 'invalid_prompt' });
    return reply.send({ spec: interpretPrompt(data.data) });
  });

  app.get<{ Params: { file: string } }>('/objects/assets/:file', async (request, reply) => {
    const sha256 = SHA_FILE.exec(request.params.file)?.[1];
    if (!sha256) return reply.code(404).send({ error: 'asset_not_found' });
    return sendGlb(reply, () => store.readAsset(sha256));
  });

  // Tint is a path segment rather than a query string because expo-asset derives
  // its cache filename from the extension, and a query breaks that.
  app.get<{ Params: { sha256: string; file: string } }>('/objects/assets/:sha256/:file', async (request, reply) => {
    const tint = TINT_FILE.exec(request.params.file)?.[1];
    if (!SHA256.test(request.params.sha256) || !tint) return reply.code(404).send({ error: 'asset_not_found' });
    return sendGlb(reply, () => store.readAsset(request.params.sha256, tint));
  });
}
