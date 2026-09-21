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
import { isAmbiguous } from '@reality/spatial-engine';
import { agentChoiceTool, recipeTool, voiceTool, VOICE_INSTRUCTIONS } from '../runtime/editor';
import { catalogIds, catalogMenu, onObjectCatalogChange } from '../runtime/object-catalog';
import type { InputCoordinator } from '../runtime/coordinator';

/**
 * What the microphone button is currently showing.
 *
 * `hearing` is the one the user asked for — proof the app can tell they are talking,
 * rather than a button that looks identical whether or not anything is getting through.
 * It comes from the server's own voice-activity detection, which is the same signal that
 * decides a turn has started, so the icon cannot disagree with what the model heard.
 */
export type VoiceActivity = 'offline' | 'connecting' | 'muted' | 'listening' | 'hearing' | 'thinking' | 'replying';

/**
 * The static prompt plus whatever the catalog currently holds.
 *
 * Appended per session rather than baked into VOICE_INSTRUCTIONS: the catalog changes,
 * the prompt does not. An empty catalog sends the prompt alone, so an unreachable
 * server degrades to the procedural families rather than advertising ids that would
 * not resolve.
 */
function listeningStatus(): string {
  const count = catalogIds().length;
  return count
    ? `Listening. ${count} catalog objects.`
    : 'Listening. No catalog reached the app — basic shapes only.';
}

function instructionsWithCatalog(): string {
  const menu = catalogMenu();
  return menu
    ? `${VOICE_INSTRUCTIONS}\n\nPre-built objects available as catalog_id on the add action, to be preferred over family when one of them is what was asked for: ${menu}.`
    : VOICE_INSTRUCTIONS;
}

/**
 * Playback gain for the assistant's voice, on react-native-webrtc's 0-10 scale.
 *
 * 1.0 is the library default and is too quiet to hear across a room over the PlayAndRecord
 * category. Held well below the ceiling: gain applied after the fact clips rather than
 * compresses, and a distorted instruction is worse than a quiet one.
 */
const OUTPUT_GAIN = 4;

export class RealtimeVoice implements VoiceAdapter {
  private unsubscribeCatalog: (() => void) | null = null;
  /** The assistant's audio track, held only so its gain can be set. */
  private remoteAudio: MediaStreamTrack | null = null;
  readonly id = 'openai-realtime-webrtc';
  readonly capabilities = ['audio', 'edit-tools'];
  private muted = false;
  private activity: VoiceActivity = 'offline';
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private controller: AbortController | null = null;
  /** The turn currently producing audio. Used ONLY to open and seal turns; never to
   * decide which turn a network event belongs to. */
  private speechTurn: string | null = null;
  /** The turn whose `response.create` we most recently sent, so `response.created` can
   * be attributed to the turn that ASKED for the response rather than to whichever turn
   * happens to be speaking when the acknowledgement arrives. */
  private awaitingResponseFor: string | null = null;
  constructor(
    private apiURL: string,
    private diagnostics: DiagnosticSink,
    private input: InputCoordinator,
    private status: (message: string) => void,
    /** Drives the microphone icon. Optional so nothing existing has to supply it. */
    private onActivity: (activity: VoiceActivity) => void = () => {},
  ) {}
  private setActivity(next: VoiceActivity) {
    // A muted microphone outranks everything the connection has to say: the icon must
    // never animate as though it were hearing someone while the track is disabled.
    const resolved = this.muted && next !== 'offline' && next !== 'connecting' ? 'muted' : next;
    if (resolved === this.activity) return;
    this.activity = resolved;
    this.onActivity(resolved);
  }
  /**
   * Stop sending audio, without tearing the session down.
   *
   * Disabling the track rather than stopping it keeps the peer connection, the tools and
   * the conversation alive — WebRTC goes on sending silence, so the server's voice
   * detection simply never fires and no turn opens. Stopping the track instead would
   * free the hardware and require a full renegotiation to come back, which is a
   * reconnect, not a mute.
   */
  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.setActivity(muted ? 'muted' : 'listening');
  }
  isMuted() {
    return this.muted;
  }
  /** Retained for the `VoiceAdapter` port. The coordinator owns interaction state now,
   * so there is nothing to copy in: this used to be a per-frame deep clone whose only
   * readers were the two turn-boundary handlers. */
  setContext(_context: InteractionContext) {}
  /** Non-standard by necessity; never allowed to take the session down with it. */
  private applyOutputGain() {
    const track = this.remoteAudio as (MediaStreamTrack & { _setVolume?: (v: number) => void }) | null;
    if (typeof track?._setVolume !== 'function') return;
    try {
      track._setVolume(OUTPUT_GAIN);
    } catch {
      // Audible at the default gain is still audible.
    }
  }

  private send(event: unknown) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event));
  }
  async start() {
    if (this.peer) throw new Error('Voice already active');
    const controller = new AbortController();
    this.controller = controller;
    this.setActivity('connecting');
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.apiURL}/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) {
        // Every non-ok status used to collapse into "configure the backend API key",
        // so a key that was REJECTED and a key that was MISSING read identically —
        // and someone who had already pasted a key was told to paste a key. The
        // server names its refusals; carry the name through to the sentence.
        const reason = await response
          .json()
          .then((body) => (body as { error?: string }).error)
          .catch(() => undefined);
        this.diagnostics.emit({
          timestamp: Date.now(),
          stage: 'voice',
          code: reason ?? `session_http_${response.status}`,
          adapterId: this.id,
        });
        throw new Error(sessionFailure(reason, response.status));
      }
      const session = (await response.json()) as { client_secret?: string };
      if (!session.client_secret) throw new Error('Invalid voice credential');
      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (error) {
        // Distinguished because the remedies differ: a denied microphone needs Settings,
        // a busy one needs the other app closed. Both used to surface as the generic
        // "voice unavailable", which tells the user nothing they can act on.
        const denied = /permission|denied|notallowed/i.test(
          error instanceof Error ? `${error.name} ${error.message}` : String(error),
        );
        this.diagnostics.emit({
          timestamp: Date.now(),
          stage: 'voice',
          code: denied ? 'microphone_denied' : 'microphone_unavailable',
          adapterId: this.id,
        });
        throw new Error(
          denied
            ? 'Microphone access is off. Enable it in Settings; the editor still works by hand.'
            : 'The microphone is unavailable. Close other apps using it and try again.',
        );
      }
      if (controller.signal.aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      // Mute can be pressed while the session is still negotiating; the track it needs
      // to disable did not exist then, so the decision is reapplied now.
      if (this.muted) stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      const peer = new RTCPeerConnection();
      this.peer = peer;

      /**
       * The reply is audible.
       *
       * WebRTC plays the remote track by itself on iOS, so nothing here was ever wrong —
       * but nothing held a reference to it either, which meant its gain could not be
       * touched. The session runs under the PlayAndRecord category the microphone
       * requires, and that category favours the receiver over the loudspeaker, so the
       * reply arrives far quieter than media playback would.
       *
       * `_setVolume` is react-native-webrtc's own extension (gain 0-10, default 1) and is
       * the only lever the library exposes for this; it deliberately accepts remote
       * tracks. Guarded because a non-standard API is exactly the kind that disappears in
       * a version bump, and a quiet assistant is a far better failure than a silent one.
       */
      peer.ontrack = (event: unknown) => {
        const track = (event as { track?: MediaStreamTrack }).track;
        if (!track || track.kind !== 'audio') return;
        this.remoteAudio = track;
        this.applyOutputGain();
      };

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onopen = () => {
        this.send({
          type: 'session.update',
          session: {
            type: 'realtime',
            // Two tools: one simple edit, one whole arrangement. M7.6 keeps them
            // separate so a "move that left" never has to carry a creation schema.
            tools: [voiceTool, recipeTool, agentChoiceTool],
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
            instructions: instructionsWithCatalog(),
          },
        });
        // Re-sent when the catalog arrives. It is fetched asynchronously at startup, so
        // it can land after this channel opens; a menu fixed at open left the model
        // unable to name a lamp or a television, which have no `family` to fall back on.
        this.unsubscribeCatalog?.();
        this.unsubscribeCatalog = onObjectCatalogChange(() => {
          this.send({
            type: 'session.update',
            session: { type: 'realtime', instructions: instructionsWithCatalog() },
          });
          this.status(listeningStatus());
        });
        // SAID OUT LOUD, because an empty catalog is otherwise invisible until the
        // model is asked for something only the catalog has. A lamp and a television
        // are not `family` values, so with no menu they cannot be expressed at all and
        // the model falls back to asking which family to use — a question the user has
        // no way to answer. Showing the count turns that into a one-glance diagnosis.
        this.status(listeningStatus());
        this.setActivity('listening');
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
        const state = peer.connectionState;
        if (state === 'failed' || state === 'disconnected') {
          // A named state, and an explicit statement that the room is unaffected: the
          // committed scene stays usable when voice is not.
          this.diagnostics.emit({
            timestamp: Date.now(),
            stage: 'voice',
            code: state === 'failed' ? 'connection_failed' : 'disconnected',
            adapterId: this.id,
          });
          this.status(
            state === 'failed'
              ? 'Voice could not connect. Your room is unchanged; hands and touch still work.'
              : 'Voice disconnected. Tap to reconnect; your room is unchanged.',
          );
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
    if (event.type === 'input_audio_buffer.speech_started') {
      // Selection latches here. The coordinator records it; nothing later can change
      // what this turn was about.
      const turnId = String(event.item_id);
      this.speechTurn = turnId;
      const record = this.input.openTurn(turnId);
      this.setActivity('hearing');
      this.diagnostics.emit({
        timestamp: Date.now(),
        stage: 'voice',
        code: 'turn_opened',
        adapterId: this.id,
        generation: record.generation,
        targetId: record.selectedId ?? undefined,
      });
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && this.speechTurn) {
      // The destination is sealed here: it may move while the user is still speaking,
      // but not after they stop.
      this.input.sealTurn(this.speechTurn);
      this.setActivity('thinking');
    }
    if (event.type === 'input_audio_buffer.committed') {
      const turnId = this.speechTurn;
      if (turnId) this.input.sealTurn(turnId);
      const resolved = turnId ? this.input.resolve(turnId, false) : null;
      const context = resolved?.ok ? resolved.context : null;
      // Remember which turn this response answers BEFORE asking for it.
      this.awaitingResponseFor = turnId;
      // Sealed context plus the SCP. The packet is what lets the model resolve "that
      // one" and "over there" without doing geometry, and the client has already decided
      // the ranking — when the top two candidates are within 0.1 the model must ask.
      const scp = this.input.scp();
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                interaction_context: context,
                spatial_context: scp,
                ambiguous: scp ? isAmbiguous(scp) : false,
                // Mask boxes are not scene objects and appear in neither list above.
                // Without this the model cannot name the box it just placed.
                mask_areas: this.input.masks(),
              }),
            },
          ],
        },
      });
      this.send({ type: 'response.create' });
    }
    if (event.type === 'response.created' && this.awaitingResponseFor) {
      // NOT `this.speechTurn`. Speak, pause, speak again, and a slow acknowledgement for
      // the first utterance would previously be recorded against the second turn — and
      // then act on the second turn's selection.
      this.input.attachResponse(this.awaitingResponseFor, String(event.response.id));
    }
    if (
      event.type === 'response.function_call_arguments.done' &&
      (event.name === 'edit_room' ||
        event.name === 'restyle_room' ||
        event.name === 'agent_choice')
    ) {
      const record = this.input.turnForResponse(String(event.response_id));
      const id = String(event.call_id);
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.arguments);
      } catch {
        // Malformed arguments used to throw out of here into a generic "command failed".
        this.status('I did not understand that edit. Please say it again.');
        return;
      }
      // The coordinator serialises execution and caches by call id, so a duplicate
      // delivery returns the original result without running anything.
      const result =
        event.name === 'agent_choice'
          ? await this.input.design(
              parsed,
              { turnId: record?.turnId, callId: id, source: 'voice' },
              (stage) =>
                this.status(stage === 'planning' ? 'Furnishing the room…' : 'Design placed.'),
            )
          : event.name === 'restyle_room'
          ? await this.input.restyle(
              parsed,
              { turnId: record?.turnId, callId: id, source: 'voice' },
              // Planning progress is reported SEPARATELY from the simple-edit latency
              // indicator (M7.6.5): a layout search takes long enough that reusing the
              // per-edit spinner would read as one slow edit rather than as thinking.
              (stage) =>
                this.status(
                  stage === 'planning' ? 'Planning the layout…' : 'Layout planned.',
                ),
            )
          : (parsed as { action?: string }).action === 'confirm'
            ? await this.input.confirm(record?.turnId)
            : await this.input.command(parsed, {
                turnId: record?.turnId,
                callId: id,
                source: 'voice',
              });
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
    }
    // Audio coming back is the only reliable sign the model has started answering;
    // `response.created` only means it accepted the request.
    if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta')
      this.setActivity('replying');
    if (event.type === 'response.done') this.setActivity('listening');
    if (event.type === 'error') {
      this.status('Voice service reported an error. Reconnect if it persists.');
      this.setActivity('listening');
    }
  }
  async stop() {
    this.controller?.abort();
    this.controller = null;
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = null;
    this.remoteAudio = null;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream?.release();
    this.stream = null;
    this.speechTurn = null;
    this.awaitingResponseFor = null;
    this.setActivity('offline');
    // Every turn opened by this connection is now obsolete. A tool call still in flight
    // cannot commit against the next connection's state.
    this.input.invalidate();
  }
  async dispose() {
    await this.stop();
  }
}

/**
 * One sentence per remedy. A missing key is an edit to `server/.env`, a rejected key
 * is a different key, a rate limit is a wait, and an unreachable upstream is the
 * server's network rather than the phone's — four actions that were previously all
 * described as "configure the backend API key".
 */
function sessionFailure(reason: string | undefined, status: number) {
  switch (reason) {
    case 'not_configured':
      return 'Voice is not configured. Set OPENAI_API_KEY in server/.env and restart the server.';
    case 'key_rejected':
      return 'The server\'s voice API key was rejected. Check OPENAI_API_KEY in server/.env.';
    case 'rate_limited':
      return 'The voice service is rate limited. Wait a moment and start voice again.';
    case 'upstream_unreachable':
      return 'The server could not reach the voice service. Check the server\'s connection.';
    default:
      return `Voice session failed (${reason ?? `HTTP ${status}`}). Hands and touch still work.`;
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
