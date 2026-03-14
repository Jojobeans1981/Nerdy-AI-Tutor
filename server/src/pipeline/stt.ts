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
  /**
   * Fired when is_final=true but speech_final=false — i.e., Deepgram has committed
   * the word boundary but the silence endpointing window hasn't elapsed yet.
   * Fires ~250ms before onFinal, giving the pipeline a head start on any pre-work.
   */
  onIsFinal?: (text: string) => void;
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
  /** Audio chunks buffered during reconnect — flushed once new connection opens */
  private audioQueue: ArrayBuffer[] = [];
  private reconnectBufferLogSent = false;
  /** Periodic keepAlive sender — active only when no audio is flowing */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Fires 1.5s after the last audio chunk to detect audio-stopped and start keepAlive */
  private audioInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last is_final transcript that hasn't yet had speech_final — used by UtteranceEnd fallback */
  private pendingFinalText = '';
  /** Timestamp of the last transcript event — used by silent disconnect watchdog */
  private lastTranscriptAt = Date.now();
  /** Timestamp of the last audio chunk forwarded to Deepgram — used by watchdog */
  private lastAudioReceivedAt = Date.now();
  /** True once at least one audio chunk has been forwarded to Deepgram */
  private isReceivingAudio = false;
  /** Watchdog interval for detecting silent Deepgram disconnects */
  private silentWatchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private callbacks: SttCallbacks) {}

  /** Open the Deepgram live connection. Safe to call before audio arrives. */
  connect(): void {
    this.reconnecting = false;
    this.lastTranscriptAt = Date.now();
    this.isReceivingAudio = false;
    this.startWatchdog();
    const client = createClient(process.env.DEEPGRAM_API_KEY!);

    this.live = client.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      endpointing: 250,       // ms of silence → speech_final (reduced from 300ms; confidence filter catches false triggers)
      utterance_end_ms: 1000, // fallback finalizer if speech_final never fires (reduced from 1500)
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    this.live.on(LiveTranscriptionEvents.Open, () => {
      console.log('[STT] Deepgram connected');
      // Flush any audio buffered during reconnect
      if (this.audioQueue.length > 0) {
        console.log(`[STT] Flushing ${this.audioQueue.length} buffered audio chunks`);
        for (const chunk of this.audioQueue) {
          this.live!.send(new Uint8Array(chunk).buffer as ArrayBuffer);
        }
        this.audioQueue = [];
      }
      this.reconnecting = false;
      this.reconnectBufferLogSent = false;
      // Start keepAlive as a safety net — will be stopped once audio starts flowing
      this.startKeepAlive();
    });

    this.live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      this.lastTranscriptAt = Date.now();
      const alt = data.channel?.alternatives?.[0];
      const text: string = alt?.transcript ?? '';
      if (!text) return;

      // Noise filter: skip low-confidence or single-word transcripts on speech_final
      // to avoid triggering the pipeline on ambient noise in loud environments.
      const confidence: number = alt?.confidence ?? 1;
      const wordCount: number = text.trim().split(/\s+/).length;

      const isFinal: boolean = data.is_final ?? false;
      const speechFinal: boolean = data.speech_final ?? false;

      // Only drop very low-confidence results (likely background noise/breathing).
      // wordCount filter removed — single-word answers like "six", "yes", "x" are valid.
      if (speechFinal && confidence < 0.55) {
        console.log(`[STT] Noise filter dropped: confidence=${confidence.toFixed(2)} words=${wordCount} text="${text}"`);
        this.pendingFinalText = '';
        this.audioStartMs = 0;
        return;
      }

      if (isFinal) {
        console.log(`[STT] is_final=true speech_final=${speechFinal} text="${text.slice(0, 60)}"`);
        // Track the latest confirmed word boundary for UtteranceEnd fallback
        this.pendingFinalText = text;
        this.audioStartMs = Date.now();
      }

      // Forward every non-empty segment as interim (includes final segments before speech_final)
      if (!speechFinal) {
        this.callbacks.onInterim(text);
        // When is_final=true but speech_final hasn't fired yet, the text is committed —
        // notify the pipeline so it can pre-start any work (e.g. answer verification)
        // during the remaining ~250ms endpointing silence window.
        if (isFinal) {
          this.callbacks.onIsFinal?.(text);
        }
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
      this.lastTranscriptAt = Date.now();
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
      this.stopKeepAlive();
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
    this.onAudioChunkReceived();

    // During reconnect, buffer audio instead of dropping it
    if (this.reconnecting) {
      if (this.audioQueue.length < 50) {
        this.audioQueue.push(data);
      } else {
        this.audioQueue.shift();
        this.audioQueue.push(data);
      }
      if (!this.reconnectBufferLogSent) {
        console.log(`[STT] Buffering audio during reconnect`);
        this.reconnectBufferLogSent = true;
      }
      return;
    }

    if (!this.live || this.live.getReadyState() !== 1) {
      console.warn('[STT] Dropped audio — Deepgram not ready');
      return;
    }
    if (this.audioStartMs === 0) {
      this.audioStartMs = Date.now();
    }
    this.live.send(new Uint8Array(data).buffer as ArrayBuffer);
  }

  /** Send keepAlive every 3s to prevent Deepgram from expiring the session during silence */
  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.live && this.live.getReadyState() === 1) {
        try {
          this.live.keepAlive();
          console.log('[STT] KeepAlive sent');
        } catch (err) {
          console.warn('[STT] KeepAlive failed:', err);
        }
      }
    }, 3000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /** Called by the pipeline when a response starts — mic will be muted, so activate keepAlive immediately */
  public onPipelineStart(): void {
    console.log('[STT] Pipeline starting — activating keepalive');
    this.isReceivingAudio = false;
    this.startKeepAlive();
  }

  /** Called on every incoming PCM chunk — manages audio-active state and keepAlive toggling */
  private onAudioChunkReceived(): void {
    this.isReceivingAudio = true;
    this.lastAudioReceivedAt = Date.now();
    this.stopKeepAlive();

    if (this.audioInactivityTimer) clearTimeout(this.audioInactivityTimer);
    this.audioInactivityTimer = setTimeout(() => {
      this.isReceivingAudio = false;
      this.startKeepAlive();
      console.log('[STT] Audio inactivity — keepalive started');
    }, 1500);
  }

  /**
   * Watchdog: if audio chunks are actively arriving but Deepgram hasn't produced
   * a transcript in 8s, it may have silently disconnected. Force a reconnect.
   *
   * Key: only fires when audio is flowing RIGHT NOW (last chunk < 2s ago),
   * not during muted periods when the mic is off and silence is expected.
   */
  private startWatchdog(): void {
    if (this.silentWatchdog) clearInterval(this.silentWatchdog);
    this.silentWatchdog = setInterval(() => {
      const silenceSinceTranscript = Date.now() - this.lastTranscriptAt;
      const audioStillFlowing = (Date.now() - this.lastAudioReceivedAt) < 2000;

      if (audioStillFlowing && silenceSinceTranscript > 8000) {
        console.warn(`[STT] Genuine disconnect detected — audio flowing but no transcript for ${Math.round(silenceSinceTranscript / 1000)}s. Reconnecting...`);
        this.reconnect();
      }
    }, 5000);
  }

  /** Tear down the current Deepgram connection and re-establish with identical config */
  private reconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    // Preserve state across reconnect
    this.isReceivingAudio = false;
    this.lastTranscriptAt = Date.now();
    // Close the old connection
    this.stopKeepAlive();
    try { this.live?.requestClose(); } catch { /* ignore */ }
    this.live = null;
    this.audioStartMs = 0;
    this.pendingFinalText = '';
    // Reconnect after a short delay
    setTimeout(() => {
      if (!this.closed) {
        console.log('[STT] Reconnecting after silent disconnect...');
        this.connect();
      }
    }, 500);
  }

  close(): void {
    this.closed = true;
    this.stopKeepAlive();
    if (this.audioInactivityTimer) { clearTimeout(this.audioInactivityTimer); this.audioInactivityTimer = null; }
    if (this.silentWatchdog) clearInterval(this.silentWatchdog);
    this.silentWatchdog = null;
    this.live?.requestClose();
    this.live = null;
    this.audioStartMs = 0;
  }
}
