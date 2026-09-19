import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KeyframeSchema } from '@reality/contracts';
import { CalibrationStore } from '../reconstruction/store.js';

const Create = z
  .object({ revision: z.number().int().nonnegative(), frameId: z.string().min(1).max(100) })
  .strict();
const Upload = z
  .object({
    metadata: KeyframeSchema,
    jpegBase64: z
      .string()
      .max(5_600_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export async function registerCalibrationRoutes(app: FastifyInstance, store: CalibrationStore) {
  await store.initialize();
  const timer = setInterval(() => {
    void store.expire().catch(() => app.log.error('calibration_cleanup_failed'));
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await store.close();
  });
  app.get('/capabilities', async () => ({
    reconstruction: store.providerId,
    sessionRetentionHours: 24,
  }));
  app.post('/calibrations', async (request, reply) => {
    const data = Create.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: 'invalid_calibration' });
    try {
      return reply.code(201).send(await store.create(data.data.revision, data.data.frameId));
    } catch {
      return reply.code(503).send({ error: 'session_capacity' });
    }
  });
  app.post<{ Params: { id: string } }>(
    '/calibrations/:id/frames',
    { bodyLimit: 6 * 1024 * 1024 },
    async (request, reply) => {
      const session = store.authorize(request.params.id, request.headers.authorization);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const data = Upload.safeParse(request.body);
      if (!data.success) return reply.code(400).send({ error: 'invalid_keyframe' });
      try {
        await store.upload(
          session,
          data.data.metadata,
          Buffer.from(data.data.jpegBase64, 'base64'),
        );
        return reply.code(201).send({ id: data.data.metadata.id });
      } catch {
        return reply.code(409).send({ error: 'capture_rejected' });
      }
    },
  );
  app.post<{ Params: { id: string } }>('/calibrations/:id/reconstruct', async (request, reply) => {
    const session = store.authorize(request.params.id, request.headers.authorization);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const data = Create.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: 'invalid_revision' });
    try {
      return reply.code(202).send(store.begin(session, data.data.revision, data.data.frameId));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'reconstruction_rejected';
      return reply.code(code === 'provider_not_configured' ? 503 : 409).send({ error: code });
    }
  });
  app.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const job = store.job(request.params.id, request.headers.authorization);
    return job ?? reply.code(404).send({ error: 'job_not_found' });
  });
  app.get<{ Params: { id: string; key: string } }>(
    '/calibrations/:id/assets/:key',
    async (request, reply) => {
      const session = store.authorize(request.params.id, request.headers.authorization);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const asset = await store.asset(session, request.params.key);
      if (!asset) return reply.code(404).send({ error: 'asset_not_found' });
      return reply.header('Cache-Control', 'no-store').type(asset.mime).send(asset.bytes);
    },
  );
  app.delete<{ Params: { id: string } }>('/calibrations/:id', async (request, reply) => {
    const session = store.authorize(request.params.id, request.headers.authorization);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    await store.remove(session);
    return reply.code(204).send();
  });
}
