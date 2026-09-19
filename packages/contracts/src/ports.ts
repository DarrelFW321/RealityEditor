import type { EditorState, InteractionContext, PoseV1, ReconstructionJob, Vec3 } from './session';

export interface Adapter {
  readonly id: string;
  readonly capabilities: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export type DiagnosticEvent = {
  timestamp: number;
  stage: string;
  code: string;
  sessionId?: string;
  revision?: number;
  adapterId?: string;
  generation?: number;
  // Deliberately no arbitrary payload: no transcripts, credentials or camera data.
  durationMs?: number;
};
export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}
export interface SettlingAdapter extends Adapter {
  settle(
    input: { scene: EditorState; targetId: string; pose: PoseV1; supportSurface: string },
    signal: AbortSignal,
    onFrame: (pose: PoseV1) => void,
  ): Promise<PoseV1>;
}
export interface VoiceAdapter extends Adapter {
  setContext(context: InteractionContext): void;
}
export interface ReconstructionAdapter extends Adapter {
  reconstruct(
    calibrationId: string,
    revision: number,
    frameId: string,
    signal: AbortSignal,
  ): Promise<ReconstructionJob>;
}
export interface SpatialSample {
  timestamp: number;
  frameId: string;
  tracking: 'normal' | 'limited' | 'lost';
  cameraToWorld: number[];
  projection: number[];
  handCursor?: { imagePoint: [number, number]; confidence: number };
}
export interface SpatialAdapter extends Adapter {
  subscribe(listener: (sample: SpatialSample) => void): () => void;
}
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}
