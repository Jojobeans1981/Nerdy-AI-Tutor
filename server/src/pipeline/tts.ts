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
      (v.description?.toLowerCase().includes('male') || v.name?.toLowerCase().match(/\b(man|male|guy|liam|james|josh|adam)\b/))) ??
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
  // Count chunks queued vs done:true received.
  // doneResolve() only fires when finalSent AND all sent chunks are acknowledged —
  // Cartesia sends done:true after EACH segment (including continue=true ones), so
  // we must wait for ALL segments to complete, not just the first done:true.
  private chunksQueued = 0;
  private chunksCompleted = 0;
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  readonly done: Promise<void>;
  // Stable context_id shared across all continue=true chunks for this response
  private contextId = '';
  // Chunks queued before the WS opened (drained on 'open')
  private pendingChunks: Array<{ text: string; continueStream: boolean }> = [];
  // True once the 'close' event has fired — abort() returns immediately if set.
  // Prevents a 1s timeout stall when Cartesia closes the WS right after done:true
  // (before abort() is called, the event would already have fired).
  private wsClosed = false;

  constructor(private cb: TtsCallbacks) {
    this.done = new Promise<void>(r => { this.doneResolve = r; });
  }

  connect(): void {
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
          if (msg.data) this._onAudio(Buffer.from(msg.data, 'base64'));
          if (msg.done === true) {
            this.chunksCompleted++;
            const allDone = this.finalSent && this.chunksCompleted >= this.chunksQueued;
            console.log(`[TTS] Cartesia segment done (${this.chunksCompleted}/${this.chunksQueued} finalSent=${this.finalSent})`);
            if (allDone) {
              this.streamDone = true;
              this.doneResolve();
            }
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
      this.wsClosed = true;
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
   * Sentences ending in "." or "!" are sent to Cartesia with continue=true as soon
   * as they arrive, so Cartesia starts synthesizing sentence 1 while the LLM is
   * still generating sentence 2. This cuts first-audio latency by ~300-500ms.
   *
   * "?" is intentionally excluded — every response ends with one, so we leave the
   * final sentence in the buffer for endStream() to send with continue=false.
   * This avoids sending a useless empty/space chunk as the last request.
   */
  sendToken(token: string): void {
    this.textBuffer += token;
    const buf = this.textBuffer;
    // Flush on sentence-ending "." or "!" once we have at least 10 chars of content
    if (buf.length >= 10 && /[.!][ \t]*$/.test(buf)) {
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
      // Mark finalSent so the message handler knows we're done, then resolve if
      // all sent chunks have already received their done:true acknowledgment.
      this.finalSent = true;
      console.log(`[TTS] endStream — buffer empty, all sentences pre-flushed (${this.chunksCompleted}/${this.chunksQueued} acked)`);
      if (this.chunksCompleted >= this.chunksQueued) {
        this.streamDone = true;
        this.doneResolve();
      }
      // If chunksCompleted < chunksQueued, the message handler will call
      // doneResolve() when the last done:true arrives.
    }
  }

  waitForComplete(): Promise<void> { return this.done; }

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
    this.doneResolve(); // unblock any waiters
    if (!this.ws) return Promise.resolve();
    const ws = this.ws;
    this.ws = null;
    // Already closed (Cartesia closed their side right after done:true)
    if (this.wsClosed) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1000); // safety fallback
      const done = () => { clearTimeout(timeout); resolve(); };
      ws.once('close', done);
      ws.once('error', done); // handle close-time errors without crashing Node
      ws.removeAllListeners('message');
      ws.removeAllListeners('open');
      ws.close();
    });
  }

  private _flushChunk(text: string, continueStream: boolean): void {
    if (!continueStream) this.finalSent = true;
    this.chunksQueued++;
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
      // Brief silence offset so Simli's video generation catches up before first word
      console.log('[TTS] Prepending silence buffer');
      const silence = generateSilenceBuffer(80);
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
