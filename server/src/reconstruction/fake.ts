import type {
  ReconstructionInput,
  ReconstructionOutput,
  ReconstructionProvider,
} from './provider.js';

/**
 * The reconstruction client's development double.
 *
 * Not a shortcut around the real worker — the implementation plan names it as a required
 * part: "Local fake jobs with delay/failure/cancellation controls". Every job-lifecycle
 * behaviour the milestone has to prove (revision checks, cancellation mid-flight, cleanup,
 * idempotency) is a property of the store and the API, not of segmentation quality, and
 * making those depend on model weights would mean they could only ever be checked by hand.
 *
 * It answers with the same shape the real worker must, and is validated by exactly the same
 * `OutputSchema` in `provider.ts`, so a response this produces and a response a Python
 * worker produces are indistinguishable to everything downstream.
 */
export type FakeBehaviour = {
  /** Milliseconds before answering. Lets a test cancel or time out mid-job. */
  delayMs?: number;
  /** Reject with this message instead of answering. */
  failWith?: string;
  /** Answer for a different calibration, to exercise `worker_revision_mismatch`. */
  wrongRevision?: boolean;
  /** Omit the shell artifact, to exercise `worker_incomplete_shell`. */
  omitShell?: boolean;
  /** Reference an artifact in the manifest that no asset supplies. */
  omitAsset?: boolean;
};

/** A 1x1 opaque PNG. Small, valid, and enough to prove bytes survive the round trip. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class FakeReconstructionProvider implements ReconstructionProvider {
  readonly id = 'fake-reconstruction-v1';
  /** Set per call by a scenario. */
  behaviour: FakeBehaviour = {};
  /** Inputs received, so a scenario can assert what the server actually forwarded. */
  readonly calls: ReconstructionInput[] = [];

  constructor(behaviour: FakeBehaviour = {}) {
    this.behaviour = behaviour;
  }

  async reconstruct(input: ReconstructionInput, signal: AbortSignal): Promise<ReconstructionOutput> {
    this.calls.push(input);
    const { delayMs, failWith, wrongRevision, omitShell, omitAsset } = this.behaviour;

    if (delayMs)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        // Honour cancellation the way a real fetch does, or a scenario could never prove
        // that DELETE mid-job actually stops the work.
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    if (failWith) throw new Error(failWith);

    // An empty room needs no removal, so no mask is produced. The atlas and shell are
    // mandatory either way — `provider.ts` rejects a manifest missing either.
    const removedObjectIds = input.keyframes.length ? [] : [];
    const artifacts = [
      { key: 'atlas.png', role: 'atlas' as const, inferred: true },
      ...(omitShell ? [] : [{ key: 'shell.json', role: 'shell' as const, inferred: true }]),
      ...(omitAsset ? [{ key: 'missing.png', role: 'mask' as const, inferred: true }] : []),
    ];
    return {
      manifest: {
        calibrationId: wrongRevision ? 'someone-elses-calibration' : input.calibrationId,
        calibrationRevision: input.calibrationRevision,
        frameId: input.frameId,
        artifacts,
        removedObjectIds,
      },
      assets: [
        { key: 'atlas.png', mime: 'image/png' as const, dataBase64: PNG_1X1 },
        ...(omitShell
          ? []
          : [
              {
                key: 'shell.json',
                mime: 'application/json' as const,
                dataBase64: Buffer.from(
                  JSON.stringify({ surfaces: [], origin: [0, 0, 0] }),
                ).toString('base64'),
              },
            ]),
      ],
    };
  }
}
