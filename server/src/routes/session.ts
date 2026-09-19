import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, missingKeyResponse } from '../config.js';

/**
 * POST /session — mints an ephemeral client secret for the realtime voice model.
 *
 * This is the entire reason the server exists on the critical path, and it is off
 * it again one round-trip later. The API key stays here; the phone gets a
 * short-lived token and opens its own socket straight to the model. No audio, no
 * geometry, and no ops pass through this process.
 *
 * VERIFIED AGAINST THE CURRENT (GA) DOCS, September 2026:
 *   endpoint  POST https://api.openai.com/v1/realtime/client_secrets
 *             (the preview path POST /v1/realtime/sessions is deprecated — any
 *             tutorial older than a few months points at it)
 *   request   { expires_after: { anchor: "created_at", seconds }, session: {...} }
 *   response  { value: "ek_...", expires_at: <unix seconds>, session: {...} }
 *   ttl       seconds is 10..7200, default 600. SHORT BY DESIGN: mint at session
 *             start, not app launch, and re-mint on every reconnect.
 *   transport the phone then opens
 *             wss://api.openai.com/v1/realtime?model=<model>
 *             with header `Authorization: Bearer <value>`.
 */

const RequestSchema = z.object({
  /**
   * Live RSG entity ids. Injected into the tool schema's target_id/anchor_id
   * enums at session-create time — the hallucination guard. Empty before a scan
   * has completed, which is fine: the model simply has nothing it can name yet.
   */
  entity_ids: z.array(z.string()).max(200).default([]),
  /** Human-readable labels, parallel to entity_ids, used only in the prompt. */
  entity_labels: z.array(z.string()).max(200).default([]),
  room_id: z.string().optional(),
});

const ClientSecretResponseSchema = z.object({
  value: z.string(),
  expires_at: z.number(),
  session: z.object({ id: z.string().optional() }).passthrough().optional(),
});

function instructions(labels: string[]): string {
  const inventory = labels.length ? labels.join(', ') : '(nothing scanned yet)';
  return [
    'You are the voice of a spatial room editor. The user is holding a phone and',
    'pointing it at real furniture in a real, measured room.',
    '',
    'YOU CANNOT SEE. You never emit coordinates, distances, or sizes of your own.',
    "You emit intent — a target, a relation, and an anchor — and the device's",
    'constraint solver computes the actual pose against measured geometry.',
    '',
    'Every tool result hands you back a constraint report. Narrate what ACTUALLY',
    "happened, including adjustments: 'I shifted it 40cm left so your closet door",
    "still opens' is the point of this product. Do not claim a placement you were",
    'not told was applied.',
    '',
    'The device also sends you a ranked candidate list for every demonstrative.',
    'Trust it. When the top two are within 0.1 of each other, ASK which one —',
    'naming a distinguishing feature, not an id. Guessing wrong costs two turns.',
    '',
    'Be brief. One short sentence per action. This is a live demo, not a tutorial.',
    '',
    `Things currently in the room: ${inventory}.`,
  ].join('\n');
}

export async function registerSessionRoute(app: FastifyInstance) {
  for (const path of ['/session', '/voice/session'])
    app.post(path, async (request, reply) => {
      if (!config.openaiApiKey) {
        return reply.code(503).send(missingKeyResponse('OPENAI_API_KEY'));
      }

      const parsed = RequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request', detail: parsed.error.format() });
      }
      const { entity_ids, entity_labels } = parsed.data;

      // Tool definitions live in the iOS target (Voice/ToolSchema.swift) because the
      // entity-id enums have to be injected from the LIVE graph, and only the phone
      // holds that. The session is created with instructions and audio config here;
      // the client sends `session.update` with the tools once it is connected.
      const body = {
        expires_after: { anchor: 'created_at', seconds: config.realtime.ttlSeconds },
        session: {
          type: 'realtime',
          model: config.realtime.model,
          instructions: instructions(entity_labels),
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                // Short on purpose. This silence window is a straight subtraction
                // from the end-of-speech-to-visible-change budget.
                silence_duration_ms: 200,
                create_response: true,
              },
            },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'alloy' },
          },
        },
      };

      let upstream: Response;
      try {
        upstream = await fetch(config.realtime.clientSecretsURL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        request.log.error({ err }, 'realtime client_secrets request failed');
        return reply.code(502).send({ error: 'upstream_unreachable' });
      }

      const text = await upstream.text();
      if (!upstream.ok) {
        request.log.error({ status: upstream.status }, 'client_secrets rejected');
        // A rejected key and an overloaded service are different problems with
        // different remedies, and both used to arrive at the phone as the single
        // word `upstream_error` — which the client then rendered as "configure the
        // backend API key" regardless. Name them so the device can say which it is.
        const error =
          upstream.status === 401 || upstream.status === 403
            ? 'key_rejected'
            : upstream.status === 429
              ? 'rate_limited'
              : 'upstream_error';
        return reply.code(502).send({ error, status: upstream.status });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return reply.code(502).send({ error: 'upstream_invalid_json' });
      }
      const json = ClientSecretResponseSchema.safeParse(payload);
      if (!json.success) {
        return reply
          .code(502)
          .send({ error: 'upstream_shape_changed', detail: json.error.format() });
      }

      // Only the ephemeral token crosses this line. The API key does not.
      return reply.send({
        client_secret: json.data.value,
        expires_at: json.data.expires_at,
        model: config.realtime.model,
        ws_url: `${config.realtime.wsURL}?model=${encodeURIComponent(config.realtime.model)}`,
        entity_ids,
      });
    });
}
