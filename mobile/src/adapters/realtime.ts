import {
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
  type MediaStream,
} from 'react-native-webrtc';
import type RTCDataChannel from 'react-native-webrtc/lib/typescript/RTCDataChannel';
import type {
  InteractionContext,
  VoiceAdapter,
  DiagnosticSink,
  EditResult,
} from '@reality/contracts';
import type { AttentionHistory } from '@reality/spatial-engine';
import { voiceTool } from '../runtime/editor';

export class RealtimeVoice implements VoiceAdapter {
  readonly id = 'openai-realtime-webrtc';
  readonly capabilities = ['audio', 'edit-tools'];
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private controller: AbortController | null = null;
  private context: InteractionContext | null = null;
  /** Response id to the speech turn it answers. Attention owns the context itself. */
  private turns = new Map<string, string>();
  private speechTurn: string | null = null;
  private calls = new Map<string, Promise<EditResult>>();
  constructor(
    private apiURL: string,
    private diagnostics: DiagnosticSink,
    private apply: (input: unknown, context: InteractionContext, id: string) => Promise<EditResult>,
    private status: (message: string) => void,
    private attention: AttentionHistory,
  ) {}
  setContext(context: InteractionContext) {
    this.context = JSON.parse(JSON.stringify(context));
  }
  private send(event: unknown) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event));
  }
  async start() {
    if (this.peer) throw new Error('Voice already active');
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.apiURL}/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error('Voice session unavailable. Configure the backend API key.');
      const session = (await response.json()) as { client_secret?: string };
      if (!session.client_secret) throw new Error('Invalid voice credential');
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      if (controller.signal.aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onopen = () => {
        this.send({
          type: 'session.update',
          session: {
            type: 'realtime',
            tools: [voiceTool],
            tool_choice: 'auto',
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  create_response: false,
                  interrupt_response: true,
                },
              },
            },
            instructions:
              'You control a spatial editor. Use edit_room for all changes. Use supplied interaction_context, never guess coordinates or targets. Ask if context is missing. Report the tool result faithfully. Unknown structural support means it is not verified.',
          },
        });
        this.status('Voice connected. Point, then speak.');
      };
      channel.onmessage = (event: { data: unknown }) => {
        try {
          void this.handle(JSON.parse(String(event.data))).catch(() =>
            this.status('Voice command failed. Please repeat it.'),
          );
        } catch {
          this.status('Invalid voice event.');
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          this.status('Voice disconnected. Reconnect to continue.');
          void this.stop();
        }
      };
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      const answer = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.client_secret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
        signal: controller.signal,
      });
      if (!answer.ok) throw new Error('Voice negotiation failed');
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: await answer.text() }),
      );
      this.diagnostics.emit({
        timestamp: Date.now(),
        stage: 'voice',
        code: 'connected',
        adapterId: this.id,
      });
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  private async handle(event: Record<string, any>) {
    if (event.type === 'input_audio_buffer.speech_started' && this.context) {
      const turnId = String(event.item_id);
      const bound = this.attention.bind(
        turnId,
        Date.now(),
        this.context.revision,
        this.context.frameId,
      );
      this.speechTurn = 'context' in bound ? turnId : null;
      if ('miss' in bound)
        this.diagnostics.emit({
          timestamp: Date.now(),
          stage: 'attention',
          code: bound.miss,
          adapterId: this.id,
        });
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && this.speechTurn && this.context)
      // Selection latches at speech onset; the destination may move during speech.
      this.attention.refreshDestination(this.speechTurn, this.context.destination);
    if (event.type === 'input_audio_buffer.committed') {
      const context = this.speechTurn ? this.attention.get(this.speechTurn) : null;
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: JSON.stringify({ interaction_context: context }) },
          ],
        },
      });
      this.send({ type: 'response.create' });
    }
    if (event.type === 'response.created' && this.speechTurn) {
      this.turns.set(event.response.id, this.speechTurn);
      if (this.turns.size > 32) this.turns.delete(this.turns.keys().next().value!);
    }
    if (event.type === 'response.function_call_arguments.done' && event.name === 'edit_room') {
      const turnId = this.turns.get(event.response_id);
      const context = turnId ? this.attention.get(turnId) : null;
      const id = String(event.call_id);
      if (!this.calls.has(id))
        this.calls.set(
          id,
          context
            ? this.apply(JSON.parse(event.arguments), context, id)
            : Promise.resolve<EditResult>({
                status: 'rejected',
                message: 'Point at what you mean and say that again.',
                report: null,
                refusal: 'no_transaction',
                caveats: [],
                conflicts: [],
                revision: -1,
              }),
        );
      const result = await this.calls.get(id)!;
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: id,
          output: JSON.stringify(narrate(result)),
        },
      });
      this.send({ type: 'response.create' });
      this.status(result.message);
      if (this.calls.size > 100) this.calls.delete(this.calls.keys().next().value!);
    }
    if (event.type === 'error')
      this.status('Voice service reported an error. Reconnect if it persists.');
  }
  async stop() {
    this.controller?.abort();
    this.controller = null;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream?.release();
    this.stream = null;
    this.turns.clear();
    this.calls.clear();
    this.speechTurn = null;
  }
  async dispose() {
    await this.stop();
    this.context = null;
  }
}

/** The model narrates prose, so it gets prose. Never the raw result structure. */
function narrate(result: EditResult) {
  const report = result.report;
  return {
    status: result.status,
    message: result.message,
    adjustment: report?.adjustment_reason ?? null,
    moved_cm: Math.round((report?.adjustment_distance_m ?? 0) * 100),
    needs_confirmation: result.refusal === 'awaiting_confirmation',
    problems: result.conflicts,
    notes: (report?.remaining_notes ?? []).map(
      (note) => `${note.type} on the ${note.side}: ${Math.round(note.value_m * 100)}cm`,
    ),
    alternatives: (report?.alternatives ?? []).map((a) => a.summary),
    caveats: result.caveats,
  };
}
