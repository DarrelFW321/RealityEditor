import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * POST /inpaint — remove what is inside the box from one captured frame.
 *
 * The device sends a photograph and the box's bounds; this returns the same frame with
 * the object inside them gone. Two implementations, and the difference between them is
 * whether anything in the chain knows the object's SHAPE.
 *
 * THE LOCAL WORKER, preferred. `POST /erase` segments the object inside the box and
 * fills only those pixels, restoring everything outside from the original before it
 * replies. So `maskPreserved` is true by construction, the frame never leaves the
 * machine, it costs nothing, and it answers in seconds.
 *
 * BACKBOARD, fallback. It HAS NO MASK PARAMETER — their documentation is explicit that
 * "a base image is not a mask or a guarantee of pixel-preserving edits" — so the box is
 * described to it in words and the returned frame may differ anywhere. That is safe only
 * because of what the caller does with it: the patch covers the box's footprint and
 * nothing else, so pixels outside the region are never sampled. Preservation there is a
 * property of the geometry, not a promise from the provider; do not reuse that response
 * as a whole-frame replacement.
 *
 * ONE FRAME, ON DEMAND. Not per-frame compositing: M8 forbids that outright, and it
 * would flicker anyway because every frame would invent something slightly different.
 * The caller projects this result back onto room geometry, so a single inpaint stays
 * registered while the camera moves.
 */

const Request = z
  .object({
    /** The captured frame, PNG, base64 without a data: prefix. */
    imageBase64: z
      .string()
      .min(64)
      .max(12_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    /**
     * Same dimensions, white where the region is. UNUSED BY BACKBOARD, which has no
     * mask input — kept optional so a masked provider can be swapped in without the
     * device changing what it sends, and so the omission is visible rather than
     * implied. `region` is what actually reaches the model today.
     */
    maskBase64: z
      .string()
      .min(64)
      .max(12_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    /** Optional extra guidance. The default already forbids inventing objects. */
    hint: z.string().max(200).optional(),
    /** The masked region as normalised bounds, so it can be described in words. */
    region: z
      .object({
        x0: z.number().min(0).max(1),
        y0: z.number().min(0).max(1),
        x1: z.number().min(0).max(1),
        y1: z.number().min(0).max(1),
      })
      .optional(),
  })
  .strict();

const PROMPT =
  'Continue the existing wall, floor and ceiling surfaces seamlessly across the removed ' +
  'region. Match the surrounding colour, texture, grain, shadow and lighting exactly. ' +
  'Do not add furniture, objects, people, text, patterns or features of any kind. ' +
  'The result must look like an empty part of the same room.';

/**
 * The local worker: segment the object inside the box, fill only those pixels.
 *
 * Preferred over any hosted provider for one structural reason — it is handed a MASK.
 * `POST /erase` runs SAM against the box to get the object's outline and a masked
 * inpainter over that outline, then copies every pixel outside it back from the
 * original. Preservation is therefore a property of the code rather than a request, and
 * the caller can cover the box's whole footprint knowing the parts that were never the
 * object are still the real photograph.
 *
 * It also costs nothing and never sends a frame of the user's room anywhere.
 */
async function eraseLocally(
  app: FastifyInstance,
  body: { imageBase64: string; region?: unknown },
  timeoutMs: number,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { workerURL, workerToken } = config.inpaint;
  const url = new URL(workerURL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return { status: 503, payload: { error: 'not_configured' } };
  const response = await fetch(new URL('/erase', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) {
    app.log.error({ status: response.status }, 'erase worker rejected');
    return {
      status: 502,
      payload: { error: response.status === 401 ? 'key_rejected' : 'upstream_error' },
    };
  }
  const result = (await response.json()) as { imageBase64?: string; stages?: unknown };
  if (!result.imageBase64) return { status: 502, payload: { error: 'no_image_returned' } };
  return {
    status: 200,
    payload: {
      imageBase64: result.imageBase64,
      provider: 'worker',
      stages: result.stages ?? null,
      // Stated, and true here rather than merely hoped: the worker restores every pixel
      // outside the mask from the original before replying.
      maskPreserved: true,
    },
  };
}

export async function registerInpaintRoute(app: FastifyInstance) {
  app.post('/inpaint', { bodyLimit: 26 * 1024 * 1024 }, async (request, reply) => {
    const { key, baseURL, imageProvider, model, timeoutMs, workerURL } = config.inpaint;
    const parsed = Request.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_inpaint_request' });
    // The worker first, whenever there is one. Backboard is the fallback, not the plan.
    if (workerURL) {
      try {
        const { status, payload } = await eraseLocally(
          app,
          { imageBase64: parsed.data.imageBase64, region: parsed.data.region },
          timeoutMs,
        );
        if (status === 200 || !key) return reply.code(status).send(payload);
        // A configured Backboard is worth trying when the worker is down, rather than
        // failing while a working provider sits unused.
        app.log.warn({ status }, 'erase worker unavailable, falling back');
      } catch (err) {
        app.log.error({ err }, 'erase worker unreachable');
        if (!key) return reply.code(502).send({ error: 'upstream_unreachable' });
      }
    }
    if (!key)
      return reply.code(503).send({
        error: 'not_configured',
        message: 'BACKBOARD_API_KEY is not set in server/.env.',
      });
    if (!imageProvider || !model)
      return reply.code(503).send({
        error: 'not_configured',
        message:
          'INPAINT_IMAGE_PROVIDER and INPAINT_MODEL must both be set. Backboard requires ' +
          'both when image generation is enabled and neither has a usable default.',
      });

    const { imageBase64, hint, region } = parsed.data;

    const call = async (path: string, init: RequestInit) => {
      const response = await fetch(`${baseURL}${path}`, {
        ...init,
        headers: {
          // X-API-Key, not Bearer. Backboard documents its own header and an
          // Authorization header is simply ignored, which reads as a 401 nobody can
          // explain.
          'X-API-Key': key,
          ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { raw: text.slice(0, 500) };
      }
      return { status: response.status, body };
    };

    // Where the hole is, in words. The only way to say "this part" to an endpoint
    // that has no mask input.
    const where = region
      ? `The area to remove occupies roughly ${Math.round(region.x0 * 100)}% to ` +
        `${Math.round(region.x1 * 100)}% across and ${Math.round(region.y0 * 100)}% to ` +
        `${Math.round(region.y1 * 100)}% down the image.`
      : '';
    const prompt = [PROMPT, where, hint ?? ''].filter(Boolean).join(' ');

    try {
      // ONE multipart call. A thread and assistant are created automatically when no
      // thread_id is given, and the image attaches directly — there is no separate
      // upload step, which an earlier draft of this invented.
      const form = new FormData();
      form.append('content', prompt);
      form.append('image_generation', 'auto');
      form.append('image_model_provider', imageProvider);
      form.append('image_model_name', model);
      form.append(
        'files',
        new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/png' }),
        'frame.png',
      );
      const generated = await call('/threads/messages', { method: 'POST', body: form });
      if (generated.status >= 400) {
        request.log.error({ status: generated.status }, 'backboard generation rejected');
        return reply
          .code(502)
          .send({ error: upstreamError(generated.status), status: generated.status });
      }

      // The artifact comes back as a URL, not base64, so it is fetched and bounded
      // here. The device never sees a provider URL.
      const url = findImageUrl(generated.body);
      if (!url) {
        request.log.error({ keys: Object.keys(generated.body) }, 'no image in reply');
        return reply.code(502).send({ error: 'no_image_returned' });
      }
      if (!url.toLowerCase().startsWith('https://'))
        return reply.code(502).send({ error: 'unsafe_asset_url' });
      const asset = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!asset.ok) return reply.code(502).send({ error: 'asset_unreachable' });
      const bytes = Buffer.from(await asset.arrayBuffer());
      if (bytes.byteLength > 24 * 1024 * 1024)
        return reply.code(502).send({ error: 'asset_too_large' });

      return reply.send({
        imageBase64: bytes.toString('base64'),
        model,
        provider: 'backboard',
        // Stated in the response, because the caller MUST clip to the region rather
        // than trusting that anything outside it survived.
        maskPreserved: false,
      });
    } catch (err) {
      request.log.error({ err }, 'inpaint failed');
      return reply.code(502).send({ error: 'upstream_unreachable' });
    }
  });
}

/**
 * The generated artifact's URL, wherever the reply happens to carry it.
 *
 * Searched rather than read from a fixed path: the documented shape is
 * `generated_media[].url`, but this is a conversation endpoint whose reply nests
 * differently depending on how the tool ran, and a missing image should be a clear
 * failure rather than an undefined property access.
 */
function findImageUrl(body: unknown, depth = 0): string | null {
  if (depth > 6 || body === null || typeof body !== 'object') return null;
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value === 'string' && /^https:\/\/\S+\.(png|jpe?g|webp)(\?|$)/i.test(value))
      return value;
    const nested = findImageUrl(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Named the way the realtime route names its failures, so the device can act. */
function upstreamError(status: number): string {
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}
