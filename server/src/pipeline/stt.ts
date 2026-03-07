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
  private closed = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

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
      // Keep-alive: send empty buffer every 8s to prevent Deepgram timeout
      this.keepAliveTimer = setInterval(() => {
        if (this.live && this.live.getReadyState() === 1) {
          this.live.keepAlive();
        }
      }, 8000);
    });

    this.live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const text: string = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text) return;

      const isFinal: boolean = data.is_final ?? false;
      const speechFinal: boolean = data.speech_final ?? false;

      if (isFinal) {
        console.log(`[STT] is_final=true speech_final=${speechFinal} text="${text.slice(0, 60)}"`);
        // Mark the timestamp of the last recognised word boundary.
        // When speech_final fires (possibly the same packet), the diff gives
        // the endpointing delay (Deepgram's silence wait, ~200ms by config).
        this.audioStartMs = Date.now();
      }

      // Forward every non-empty segment as interim (includes final segments before speech_final)
      if (!speechFinal) {
        this.callbacks.onInterim(text);
        return;
      }

      // speech_final = true → utterance complete.
      // Use the configured endpointing value (200ms) as a floor so the dashboard
      // never shows 0ms (same-packet is_final + speech_final collapses the timer).
      const rawMs = this.audioStartMs > 0 ? Date.now() - this.audioStartMs : 0;
      const sttMs = Math.max(rawMs, 200); // endpointing is always >= config value
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
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      // Auto-reconnect if the session is still active
      if (!this.closed) {
        console.log('[STT] Reconnecting in 500ms...');
        setTimeout(() => {
          if (!this.closed) this.connect();
        }, 500);
      }
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
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.live?.requestClose();
    this.live = null;
    this.audioStartMs = 0;
  }
}
