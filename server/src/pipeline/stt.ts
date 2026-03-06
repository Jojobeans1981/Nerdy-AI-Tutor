/**
 * STT module — Deepgram Nova-2 streaming transcription.
 *
 * Manages the Deepgram WebSocket connection for one session.
 * Measures stt_ms = time from first audio sent → speech_final.
 */
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export interface SttCallbacks {
  /** Fired for every interim (non-final) transcript segment */
  onInterim: (text: string) => void;
  /** Fired once per utterance when speech_final=true. sttMs = first-audio→speech_final. */
  onFinal: (text: string, sttMs: number) => void;
  onError?: (err: unknown) => void;
}

export class DeepgramSTT {
  private live: ReturnType<ReturnType<typeof createClient>['listen']['live']> | null = null;
  /** Timestamp of the first audio chunk sent in the current utterance */
  private audioStartMs = 0;

  constructor(private callbacks: SttCallbacks) {}

  /** Open the Deepgram live connection. Safe to call before audio arrives. */
  connect(): void {
    const client = createClient(process.env.DEEPGRAM_API_KEY!);

    this.live = client.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      endpointing: 200,       // ms of silence → speech_final (tighter = lower latency)
      utterance_end_ms: 1200,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    this.live.on(LiveTranscriptionEvents.Open, () => {
      console.log('[STT] Deepgram connected');
    });

    this.live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const text: string = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text) return;

      const isFinal: boolean = data.is_final ?? false;
      const speechFinal: boolean = data.speech_final ?? false;

      if (isFinal) {
        console.log(`[STT] is_final=true speech_final=${speechFinal} text="${text.slice(0, 60)}"`);
        // Reset timer on each is_final so audioStartMs measures silence since
        // last recognised word, giving us the endpointing delay not utterance length.
        this.audioStartMs = Date.now();
      }

      // Forward every non-empty segment as interim (includes final segments before speech_final)
      if (!speechFinal) {
        this.callbacks.onInterim(text);
        return;
      }

      // speech_final = true → utterance complete.
      // sttMs here = endpointing delay only (time Deepgram waited after last word
      // before firing speech_final). We reset audioStartMs on every is_final so it
      // reflects the gap between last segment and speech_final, not the full utterance.
      const sttMs = this.audioStartMs > 0 ? Date.now() - this.audioStartMs : 0;
      console.log(`[STT] Final  endpointing_ms≈${sttMs}  text="${text.slice(0, 60)}"`);
      this.audioStartMs = 0;
      this.callbacks.onFinal(text, sttMs);
    });

    this.live.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error('[STT] Error:', err);
      this.callbacks.onError?.(err);
    });

    this.live.on(LiveTranscriptionEvents.Close, () => {
      console.log('[STT] Deepgram connection closed');
    });
  }

  /**
   * Forward a raw PCM audio chunk to Deepgram.
   * Records the timestamp of the first chunk for stt_ms calculation.
   */
  sendAudio(data: ArrayBuffer): void {
    if (!this.live || this.live.getReadyState() !== 1) {
      console.warn('[STT] Dropped audio — Deepgram not ready');
      return;
    }
    if (this.audioStartMs === 0) {
      this.audioStartMs = Date.now();
    }
    this.live.send(new Uint8Array(data).buffer as ArrayBuffer);
  }

  close(): void {
    this.live?.requestClose();
    this.live = null;
    this.audioStartMs = 0;
  }
}
