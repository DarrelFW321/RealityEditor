import { z } from 'zod';
import {
  ReconstructionManifestSchema,
  type Keyframe,
  type ReconstructionRoom,
} from '@reality/contracts';

export interface ReconstructionInput {
  calibrationId: string;
  calibrationRevision: number;
  frameId: string;
  /** Planes to project onto and volumes to reject, in room space. */
  room: ReconstructionRoom;
  keyframes: { metadata: Keyframe; jpegBase64: string }[];
}
const OutputSchema = z
  .object({
    manifest: ReconstructionManifestSchema,
    assets: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpg|json|glb)$/),
            mime: z.enum(['image/png', 'image/jpeg', 'application/json', 'model/gltf-binary']),
            dataBase64: z
              .string()
              .min(4)
              .max(16_000_000)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type ReconstructionOutput = z.infer<typeof OutputSchema>;
export interface ReconstructionProvider {
  readonly id: string;
  reconstruct(input: ReconstructionInput, signal: AbortSignal): Promise<ReconstructionOutput>;
}

/**
 * Semantic checks on whatever a provider returned. Called by the STORE, not by a provider,
 * because the store is what publishes and every provider is untrusted — including ours.
 *
 * These used to live inside `HttpReconstructionProvider`, which meant swapping the provider
 * silently dropped all of them: the gate caught a fake publishing a manifest for
 * `someone-elses-calibration` with the job reported as completed. A provider is explicitly
 * a replaceable part, so its replacement must not be able to take the safety checks with it.
 */
export function assertConsistent(input: ReconstructionInput, output: ReconstructionOutput) {
  const { manifest } = output;
  if (
    manifest.calibrationId !== input.calibrationId ||
    manifest.calibrationRevision !== input.calibrationRevision ||
    manifest.frameId !== input.frameId
  )
    throw new Error('worker_revision_mismatch');
  if (!['atlas', 'shell'].every((role) => manifest.artifacts.some((a) => a.role === role)))
    throw new Error('worker_incomplete_shell');
  const keys = new Set(output.assets.map((a) => a.key));
  if (keys.size !== output.assets.length || manifest.artifacts.some((a) => !keys.has(a.key)))
    throw new Error('worker_missing_artifact');
}

/** A GPU worker can be replaced without changing the HTTP app or mobile client. */
export class HttpReconstructionProvider implements ReconstructionProvider {
  readonly id = 'http-reconstruction-v1';
  constructor(
    private url: string,
    private token: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    )
      throw new Error('Worker must use HTTPS outside localhost.');
  }
  async reconstruct(input: ReconstructionInput, signal: AbortSignal) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(input),
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`worker_http_${response.status}`);
    // Bound the response even when the worker does not supply Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('worker_empty_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024 * 1024) throw new Error('worker_response_too_large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    // Transport's job: bound the bytes and parse them. The semantic cross-checks are the
    // store's, so they apply to every provider rather than only to this one.
    return OutputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
}
