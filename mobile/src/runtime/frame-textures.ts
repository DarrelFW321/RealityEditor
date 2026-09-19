import { z } from 'zod';

// Finite but singular transforms also break inverse projection/room registration.
function invertible(values: number[]) {
  const n = Math.sqrt(values.length);
  const rows = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => values[c * n + r]!));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(rows[r]![c]!) > Math.abs(rows[pivot]![c]!)) pivot = r;
    if (Math.abs(rows[pivot]![c]!) < 1e-10) return false;
    [rows[c], rows[pivot]] = [rows[pivot]!, rows[c]!];
    for (let r = c + 1; r < n; r++) {
      const factor = rows[r]![c]! / rows[c]![c]!;
      for (let k = c; k < n; k++) rows[r]![k] = rows[r]![k]! - factor * rows[c]![k]!;
    }
  }
  return true;
}
const matrix = (length: number) => z.array(z.number().finite()).length(length)
  .refine(values => values.length === length && invertible(values));
const texture = z.object({
  id: z.number().int().positive(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
/** Process-local metadata, deliberately NOT a session/export/persistence schema. */
export const TextureFrameSchema = z.object({
  version: z.literal(1),
  leaseId: z.string().min(1),
  contextId: z.number().int().positive(),
  frameId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  timestamp: z.number().finite().nonnegative(),
  nativeAgeMs: z.number().finite().nonnegative(),
  viewportWidth: z.number().positive().finite(),
  viewportHeight: z.number().positive().finite(),
  cameraToWorld: matrix(16), projection: matrix(16), roomAnchor: matrix(16),
  displayToImage: matrix(9),
  videoRange: z.boolean(), bt709: z.boolean(),
  leasedSlots: z.number().int().min(1).max(3),
  dropped: z.number().int().nonnegative(),
  textures: z.object({
    luma: texture, chroma: texture, depth: texture.optional(),
    confidence: texture.optional(), foreground: texture.optional(),
  }),
});
export type TextureFrame = z.infer<typeof TextureFrameSchema>;
export type FrameRequest = { contextId: number; frameId: string; width: number; height: number };
export interface TextureFrameSource {
  acquire(request: FrameRequest): Promise<unknown>;
  release(leaseId: string): Promise<void>;
}
export const MAX_FRAME_AGE_MS = 150;

/** One request in flight, one displayed lease. Late responses are always released.
 * Clock is monotonic JS time; native age is measured against ARKit uptime natively.
 * Request elapsed time is conservatively included (never mix epoch and uptime). */
export class TextureFrameStream {
  private generation = 0;
  private pending = false;
  private stopped = false;
  private current: { frame: TextureFrame; received: number; transit: number } | null = null;
  private last: { generation: number; sequence: number; timestamp: number } | null = null;
  rejected = 0;
  errors = 0;
  constructor(
    private source: TextureFrameSource,
    readonly request: FrameRequest,
    private now: () => number = () => performance.now(),
  ) {}
  get busy() { return this.pending; }
  get ageMs() {
    return this.current
      ? this.current.frame.nativeAgeMs + this.current.transit + this.now() - this.current.received
      : Infinity;
  }
  read(): TextureFrame | null {
    if (this.ageMs > MAX_FRAME_AGE_MS) this.clear();
    return this.current?.frame ?? null;
  }
  private release(frame: { leaseId: string }) {
    try { void this.source.release(frame.leaseId).catch(() => { this.errors++; }); }
    catch { this.errors++; }
  }
  private clear() {
    const old = this.current;
    this.current = null;
    if (old) this.release(old.frame);
  }
  async poll() {
    if (this.stopped || this.pending) return;
    this.pending = true;
    const epoch = this.generation, started = this.now();
    try {
      const raw = await this.source.acquire(this.request);
      // Null is an unavailable/tracking-lost native frame, not permission to reuse
      // yesterday's pixels until their age limit. Clear immediately.
      if (raw == null) { this.clear(); return; }
      const parsed = TextureFrameSchema.safeParse(raw);
      const frame = parsed.success ? parsed.data : null;
      const incomingLease = typeof raw === 'object' && raw && 'leaseId' in raw && typeof raw.leaseId === 'string'
        ? raw.leaseId : null;
      const ownsIncomingLease = incomingLease !== null && incomingLease === this.current?.frame.leaseId;
      const transit = Math.max(0, this.now() - started);
      const ids = frame ? Object.values(frame.textures).filter(t => t !== undefined).map(t => t.id) : [];
      const valid = frame && !ownsIncomingLease && !this.stopped && epoch === this.generation &&
        frame.contextId === this.request.contextId && frame.frameId === this.request.frameId &&
        frame.viewportWidth === this.request.width && frame.viewportHeight === this.request.height &&
        frame.nativeAgeMs + transit <= MAX_FRAME_AGE_MS && new Set(ids).size === ids.length &&
        (!this.last || (frame.generation >= this.last.generation &&
          (frame.generation > this.last.generation ||
            (frame.sequence > this.last.sequence && frame.timestamp > this.last.timestamp))));
      if (!valid || !frame) {
        this.rejected++;
        // A repeated token aliases our displayed resource. Releasing it here would
        // leave current pointing at a deleted native texture.
        if (incomingLease && !ownsIncomingLease) this.release({ leaseId: incomingLease });
        return;
      }
      this.clear();
      this.last = frame;
      this.current = { frame, received: this.now(), transit };
    } catch { this.errors++; this.read(); }
    finally { this.pending = false; }
  }
  dispose() {
    this.stopped = true;
    this.generation++;
    this.clear();
  }
}
