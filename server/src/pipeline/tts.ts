/**
 * TTS module — Cartesia Sonic streaming WebSocket.
 *
 * connect() is FIRE-AND-FORGET — the WS handshake overlaps the LLM call.
 * All tokens are accumulated locally and sent in ONE request when endStream()
 * fires, so Cartesia gets the full text at once and starts synthesizing immediately.
 * Single-chunk approach avoids multi-done:true sequencing issues with Cartesia's API.
 */
import { WebSocket } from 'ws';

// Prevents avatar mouth-open artifact before audio playback starts
function generateSilenceBuffer(durationMs: number, sampleRate = 16000): Buffer {
  // 16-bit PCM = 2 bytes per sample; fill with zeros = silence
  return Buffer.alloc(Math.floor(durationMs * sampleRate / 1000) * 2);
}

const API_KEY  = () => process.env.CARTESIA_API_KEY!;
const VERSION  = '2024-06-10';
const MODEL    = 'sonic-english';
const WS_URL   = () =>
  `wss://api.cartesia.ai/tts/websocket?api_key=${API_KEY()}&cartesia_version=${VERSION}`;

// ── Voice resolution ──────────────────────────────────────────────────────────
let cachedVoiceId = '';

/**
 * Fetch available Cartesia voices and cache a suitable English male voice.
 * Called once at server startup so every TTS request has it ready.
 */
export async function preloadVoice(): Promise<string> {
  if (process.env.CARTESIA_VOICE_ID) {
    cachedVoiceId = process.env.CARTESIA_VOICE_ID;
    console.log(`[TTS] Cartesia voice (env): ${cachedVoiceId}`);
    return cachedVoiceId;
  }

  const res = await fetch('https://api.cartesia.ai/voices', {
    headers: { 'X-API-Key': API_KEY(), 'Cartesia-Version': VERSION },
  });

  if (!res.ok) throw new Error(`Cartesia voices fetch failed: ${res.status} ${await res.text()}`);

  const voices: any[] = await res.json();

  const pick =
    voices.find(v => v.language === 'en' && v.is_public &&
      (v.description?.toLowerCase().includes('female') || v.name?.toLowerCase().match(/\b(woman|female|girl|janet|sarah|emma|sophia)\b/))) ??
    voices.find(v => v.language === 'en' && v.is_public) ??
    voices[0];

  cachedVoiceId = pick.id;
  console.log(`[TTS] Cartesia voice selected: "${pick.name}" (${pick.id})`);
  return cachedVoiceId;
}

// ── Callbacks ─────────────────────────────────────────────────────────────────
export interface TtsCallbacks {
  /** Raw PCM bytes (16-bit signed, 16kHz, mono) — no base64 encoding */
  onAudioChunk: (pcm: Buffer) => void;
  onFirstByte: (ms: number) => void;
  onError: (error: string, message: string) => void;
}

// ── CartesiaTTS ───────────────────────────────────────────────────────────────
export class CartesiaTTS {
  private ws: WebSocket | null = null;
  private textBuffer = '';
  private wsOpen = false;
  private streamDone = false;
  // Set true once the final (continue=false) chunk has been sent.
  private finalSent = false;
  // Count of chunks sent to Cartesia (for logging only)
  private chunksQueued = 0;
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  readonly done: Promise<void>;
  // Stable context_id shared across all continue=true chunks for this response
  private contextId = '';
  // Chunks queued before the WS opened (drained on 'open')
  private pendingChunks: Array<{ text: string; continueStream: boolean }> = [];
  // Prevent double-close races when abort() is called concurrently
  private isAborting = false;
  // Resolved by waitForComplete() when any completion condition fires
  private completionResolve: (() => void) | null = null;

  constructor(private cb: TtsCallbacks) {
    this.done = new Promise<void>(r => { this.doneResolve = r; });
  }

  connect(): void {
    console.log('[TTS] connect() called');
    this.connectMs = Date.now();
    this.contextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.ws = new WebSocket(WS_URL());

    this.ws.on('open', () => {
      console.log('[TTS] Cartesia WS open');
      this.wsOpen = true;
      // Drain any chunks that arrived before the WS opened
      for (const chunk of this.pendingChunks) {
        this._send(chunk.text, chunk.continueStream);
      }
      this.pendingChunks = [];
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._onAudio(data as Buffer);
      } else {
        try {
          const msg = JSON.parse((data as Buffer).toString());
          console.log('[TTS] Cartesia message received:', JSON.stringify(msg).slice(0, 200));
          if (msg.data) this._onAudio(Buffer.from(msg.data, 'base64'));
          if (msg.type === 'done' && msg.done === true) {
            console.log('[TTS] waitForComplete resolved via done message');
            this.streamDone = true;
            this.doneResolve();
            this.completionResolve?.();
            this.completionResolve = null;
          }
          if (msg.error) {
            console.error('[TTS] Cartesia error:', JSON.stringify(msg.error));
            this.cb.onError('cartesia', String(msg.error?.message ?? msg.error));
            this.doneResolve();
          }
        } catch { /* non-JSON frame */ }
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || '';
      if (!this.streamDone) {
        console.error(`[TTS] Cartesia WS closed unexpectedly  code=${code}  reason="${reasonStr}"`);
      } else {
        console.log(`[TTS] Cartesia WS closed normally  code=${code}`);
      }
      this.doneResolve();
    });
    this.ws.on('error', err => {
      console.error('[TTS] WS error:', err.message);
      this.doneResolve();
    });
  }

  /**
   * Accumulate LLM tokens and flush complete sentences immediately.
   *
   * Sentences ending in "." or "!" are sent to Cartesia with continue=true as
   * soon as they arrive, so Cartesia starts synthesizing sentence 1 while the
   * LLM is still generating sentence 2. This cuts first-audio latency by ~300-500ms.
   *
   * "?" is intentionally excluded — Cartesia requires a final chunk with
   * continue=false to complete the context. Every Socratic response ends with
   * "?", so leaving it in the buffer ensures endStream() sends it correctly.
   * Flushing "?" with continue=true would leave no text for the final chunk,
   * causing Cartesia to never send done:true and hanging the pipeline.
   */
  sendToken(token: string): void {
    this.textBuffer += token;
    const buf = this.textBuffer;
    // Flush on sentence-ending "." or "!" once we have at least 5 chars of content
    if (buf.length >= 5 && /[.!][ \t]*$/.test(buf)) {
      const text = buf.trimEnd();
      this.textBuffer = '';
      console.log(`[TTS] Sentence flush (${text.length} chars): "${text.slice(0, 60)}"`);
      this._flushChunk(text, true); // continue=true: Cartesia maintains voice context
    }
  }

  /**
   * Signal end of LLM stream. Sends any remaining buffered text as the final chunk.
   *
   * If all sentences were already flushed by sendToken() (buffer is empty), we must
   * NOT send a bogus space chunk — Cartesia may not send done:true for it, leaving
   * chunksCompleted < chunksQueued and blocking waitForComplete() for the full 8s
   * timeout (which holds isBusy=true and makes it look like the mic isn't working).
   * Instead, just mark finalSent=true and resolve if all chunks are already acked.
   */
  endStream(): void {
    const text = this.textBuffer.trimEnd();
    this.textBuffer = '';
    if (text.length > 0) {
      console.log(`[TTS] endStream — final chunk (${text.length} chars): "${text.slice(0, 60)}"`);
      this._flushChunk(text, false); // continue=false: finalises the Cartesia context
    } else {
      // All text was already flushed via sentence streaming — no more text to send.
      // The done message from Cartesia will resolve waitForComplete().
      this.finalSent = true;
      console.log(`[TTS] endStream — buffer empty, all sentences pre-flushed (queued=${this.chunksQueued})`);
    }
  }

  waitForComplete(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this.ws?.off('close', onClose);
        clearTimeout(ceiling);
        resolve();
      };

      // Condition 1: Cartesia sends done message (primary path)
      this.completionResolve = done;
      // If done already fired before waitForComplete was called, resolve immediately
      if (this.streamDone) { done(); return; }

      // Condition 2: WebSocket closes before done arrives
      const onClose = () => {
        console.log('[TTS] WS closed — resolving waitForComplete via close fallback');
        done();
      };
      this.ws?.once('close', onClose);

      // Condition 3: Absolute 8 second ceiling — nothing should ever take longer
      const ceiling = setTimeout(() => {
        console.warn('[TTS] waitForComplete ceiling hit (8s) — forcing resolve');
        done();
      }, 8000);
    });
  }

  /**
   * Close the Cartesia WS and return a Promise that resolves when the socket
   * is fully closed (or immediately if already closed).
   *
   * Awaiting this in the pipeline's finally block ensures the next pipeline's
   * tts.connect() only fires after Cartesia registers the old connection as
   * closed — the free tier rejects concurrent WebSocket connections.
   *
   * Uses wsClosed flag (set in the 'close' handler) to avoid the race where
   * Cartesia closes from their side right after done:true before abort() is
   * called — in that case the event already fired and we resolve immediately
   * instead of waiting the full 1s timeout.
   */
  abort(): Promise<void> {
    console.log(`[TTS] abort() called — ws readyState: ${this.ws?.readyState ?? 'null'}  isAborting: ${this.isAborting}`);
    this.doneResolve(); // unblock any waiters

    // Already aborting — prevent double-close races
    if (this.isAborting) { console.log('[TTS] abort() — already aborting, returning'); return Promise.resolve(); }
    if (!this.ws) { console.log('[TTS] abort() — no ws, returning'); return Promise.resolve(); }

    this.isAborting = true;
    const ws = this.ws;
    this.ws = null;

    // Remove data listeners immediately to prevent processing stale frames
    ws.removeAllListeners('message');
    ws.removeAllListeners('open');

    const readyState = ws.readyState;

    // CLOSED — already done
    if (readyState === WebSocket.CLOSED) {
      this.isAborting = false;
      return Promise.resolve();
    }

    // CLOSING — wait up to 800ms for the close event, then resolve regardless
    if (readyState === WebSocket.CLOSING) {
      return new Promise<void>(resolve => {
        const timeout = setTimeout(() => { this.isAborting = false; resolve(); }, 800);
        const done = () => { clearTimeout(timeout); this.isAborting = false; resolve(); };
        ws.once('close', done);
        ws.once('error', done);
      });
    }

    // OPEN or CONNECTING — initiate close, wait up to 2s
    return new Promise<void>(resolve => {
      const timeout = setTimeout(() => { this.isAborting = false; resolve(); }, 2000);
      const done = () => { clearTimeout(timeout); this.isAborting = false; resolve(); };
      ws.once('close', done);
      ws.once('error', done);
      try {
        ws.close();
      } catch {
        // close() can throw if the socket is in a bad state
        clearTimeout(timeout);
        this.isAborting = false;
        resolve();
      }
    });
  }

  private _flushChunk(text: string, continueStream: boolean): void {
    if (!continueStream) this.finalSent = true;
    this.chunksQueued++;
    console.log(`[TTS] Expecting ${this.chunksQueued} total segments (continue=${continueStream})`);
    if (!this.wsOpen) {
      this.pendingChunks.push({ text, continueStream });
      return;
    }
    this._send(text, continueStream);
  }

  private _onAudio(pcm: Buffer): void {
    if (this.isFirstAudio) {
      this.isFirstAudio = false;
      const ms = Date.now() - this.connectMs;
      console.log(`[TTS] First audio: ${ms}ms after connect()`);
      this.cb.onFirstByte(ms);
      // Brief 40ms silence offset so Simli's video generation catches up before first word
      console.log('[TTS] Prepending 40ms silence buffer');
      const silence = generateSilenceBuffer(40);
      this.cb.onAudioChunk(Buffer.concat([silence, pcm]));
      return;
    }
    this.cb.onAudioChunk(pcm);
  }

  private _send(transcript: string, continueStream: boolean): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = {
      model_id:      MODEL,
      transcript,
      voice:         { mode: 'id', id: cachedVoiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      context_id:    this.contextId,
    };
    if (continueStream) payload.continue = true;
    this.ws.send(JSON.stringify(payload));
  }
}
