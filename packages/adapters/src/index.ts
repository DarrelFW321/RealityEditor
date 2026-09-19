import type {
  Adapter,
  DiagnosticEvent,
  DiagnosticSink,
  SettlingAdapter,
  PoseV1,
  Vec3,
} from '@reality/contracts';
import { buildIndex, sweepDown, wallFacingYaw } from '@reality/spatial-engine';
export * from './reconstruction';

export class Diagnostics implements DiagnosticSink {
  private events: DiagnosticEvent[] = [];
  private listeners = new Set<() => void>();
  emit(event: DiagnosticEvent) {
    this.events = [...this.events.slice(-199), event];
    this.listeners.forEach((l) => l());
  }
  getSnapshot = () => this.events;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** Serial lifecycle transitions prevent overlapping native camera/audio owners. */
export class AdapterSlot<T extends Adapter> {
  private current: T | null = null;
  private starting: T | null = null;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private requestVersion = 0;
  constructor(private diagnostics: DiagnosticSink) {}
  get active() {
    return this.current;
  }
  get epoch() {
    return this.generation;
  }
  replace(factory: () => T): Promise<void> {
    const requested = ++this.requestVersion;
    const transition = this.queue.then(async () => {
      if (requested !== this.requestVersion) return;
      const previous = this.current;
      this.current = null;
      this.generation++;
      if (previous) {
        try {
          await previous.stop();
        } finally {
          await previous.dispose();
        }
      }
      const next = factory();
      const epoch = this.generation;
      this.starting = next;
      try {
        await next.start();
        if (epoch !== this.generation || requested !== this.requestVersion) {
          await next.dispose();
          return;
        }
        this.current = next;
        this.diagnostics.emit({
          timestamp: Date.now(),
          stage: 'adapter',
          code: 'started',
          adapterId: next.id,
          generation: this.generation,
        });
      } catch (error) {
        await next.dispose();
        this.diagnostics.emit({
          timestamp: Date.now(),
          stage: 'adapter',
          code: 'start_failed',
          adapterId: next.id,
          generation: this.generation,
        });
        throw error;
      } finally {
        if (this.starting === next) this.starting = null;
      }
    });
    this.queue = transition.catch(() => {});
    return transition;
  }
  async dispose() {
    this.requestVersion++;
    this.generation++;
    await this.starting?.stop();
    await this.queue;
    const previous = this.current;
    this.current = null;
    if (previous) {
      try {
        await previous.stop();
      } finally {
        await previous.dispose();
      }
    }
  }
}

/** Upright drop baseline; replaceable by a full rigid-body adapter.
 * Other bodies stay static. No angular dynamics and no load-strength claims.
 */
export class FloorSettlingAdapter implements SettlingAdapter {
  readonly id = 'floor-gravity-v1';
  readonly capabilities = ['upright-floor-drop', 'wall-attachment', 'object-support'];
  async start() {}
  async stop() {}
  async dispose() {}
  async settle(
    input: Parameters<SettlingAdapter['settle']>[0],
    signal: AbortSignal,
    onFrame: (pose: PoseV1) => void,
  ): Promise<PoseV1> {
    const scene = input.scene;
    const object = scene.design.objects.find((o) => o.id === input.targetId);
    if (!object) throw new Error('Unknown settling target');
    const support = scene.assemblies[object.id]?.support;
    const index = buildIndex(scene, object.id);

    if (support?.mode === 'wall') {
      const wall = index.walls.find((w) => w.id === support.surfaceId);
      if (!wall) throw new Error('Missing mounting wall');
      // Project onto the measured plane rather than trusting the requested depth.
      const p = input.pose.position;
      const distance = wall.normal[0] * p[0] + wall.normal[1] * p[1] + wall.normal[2] * p[2];
      const depth = (object.dimensions[2] ?? 0) / 2;
      const shift = wall.offset + depth - distance;
      return {
        position: [p[0] + wall.normal[0] * shift, p[1], p[2] + wall.normal[2] * shift] as Vec3,
        yaw: wallFacingYaw(wall.normal),
      };
    }

    // The declared support decides where the drop ends. Never whatever lies beneath.
    let floor = 0;
    if (support?.mode === 'object') {
      const supporter = index.neighbours.find((n) => n.id === support.surfaceId);
      if (!supporter?.bearing) throw new Error('Support cannot carry this object');
      floor = supporter.bearing.y;
    }
    if (input.pose.position[1] < floor - 0.001) throw new Error('Below its support');

    // One sweep query for the whole drop; the per-substep loop was the cost.
    const blocked = sweepDown(
      scene,
      { ...object, pose: { position: input.pose.position, yaw: input.pose.yaw } },
      input.pose.position[1],
      floor,
      index,
      support?.mode === 'object' ? support.surfaceId : undefined,
    );
    if (blocked) throw new Error(`Drop path obstructed by ${blocked.blockedBy}`);

    let y = input.pose.position[1];
    let v = 0;
    for (let step = 0; step < 300; step++) {
      if (signal.aborted) throw new Error('Cancelled');
      v += 9.81 / 60;
      y = Math.max(floor, y - v / 60);
      const pose: PoseV1 = {
        position: [input.pose.position[0], y, input.pose.position[2]],
        yaw: input.pose.yaw,
      };
      onFrame(pose);
      if (y === floor) return pose;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('Cancelled'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 1000 / 60);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Settling timed out');
  }
}
