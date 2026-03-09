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
  private reconnecting = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Last is_final transcript that hasn't yet had speech_final — used by UtteranceEnd fallback */
  private pendingFinalText = '';

  constructor(private callbacks: SttCallbacks) {}

  /** Open the Deepgram live connection. Safe to call before audio arrives. */
  connect(): void {
    this.reconnecting = false;
    const client = createClient(process.env.DEEPGRAM_API_KEY!);

    this.live = client.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      endpointing: 200,       // ms of silence → speech_final (tighter = lower latency)
      utterance_end_ms: 1500, // fallback finalizer if speech_final never fires
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
        // Track the latest confirmed word boundary for UtteranceEnd fallback
        this.pendingFinalText = text;
        this.audioStartMs = Date.now();
      }

      // Forward every non-empty segment as interim (includes final segments before speech_final)
      if (!speechFinal) {
        this.callbacks.onInterim(text);
        return;
      }

      // speech_final = true → utterance complete.
      this.pendingFinalText = '';
      const rawMs = this.audioStartMs > 0 ? Date.now() - this.audioStartMs : 0;
      const sttMs = Math.max(rawMs, 200);
      console.log(`[STT] Final  endpointing_ms≈${sttMs}  text="${text.slice(0, 60)}"`);
      this.audioStartMs = 0;
      this.callbacks.onFinal(text, sttMs);
    });

    // UtteranceEnd fires 1500ms after the last word if speech_final never arrived.
    // This handles the "stuck listening" case where background noise prevents endpointing.
    this.live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (!this.pendingFinalText) return;
      const text = this.pendingFinalText;
      this.pendingFinalText = '';
      const sttMs = this.audioStartMs > 0 ? Math.max(Date.now() - this.audioStartMs, 200) : 200;
      console.log(`[STT] UtteranceEnd fallback  sttMs≈${sttMs}  text="${text.slice(0, 60)}"`);
      this.audioStartMs = 0;
      this.callbacks.onFinal(text, sttMs);
    });

    this.live.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error('[STT] Error:', err);
      this.callbacks.onError?.(err);
    });

    this.live.on(LiveTranscriptionEvents.Close, (event: any) => {
      const code = event?.code ?? event;
      console.log(`[STT] Deepgram connection closed (code=${code})`);
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.live = null;
      // Auto-reconnect if the session is still active and not already reconnecting
      if (!this.closed && !this.reconnecting) {
        this.reconnecting = true;
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
