/**
 * TTS module — Cartesia Sonic streaming WebSocket.
 *
 * Replaces ElevenLabs. Cartesia delivers first audio in ~50-100ms after
 * receiving text vs ElevenLabs' ~400ms floor, enabling sub-700ms pipelines.
 *
 * connect() is FIRE-AND-FORGET — the WS handshake overlaps the LLM call.
 * All tokens are accumulated locally and sent in one request when endStream()
 * fires, so Cartesia gets the full text at once and starts synthesizing immediately.
 */
import { WebSocket } from 'ws';

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

  // Prefer a public English voice with male characteristics
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
  /** Fires immediately for every raw PCM audio chunk as it arrives */
  onAudioChunk: (base64Pcm: string) => void;
  /** ms from connect() call to first audio chunk */
  onFirstByte: (ms: number) => void;
  /** API-level error from Cartesia */
  onError: (error: string, message: string) => void;
}

// ── CartesiaTTS ───────────────────────────────────────────────────────────────
export class CartesiaTTS {
  private ws: WebSocket | null = null;
  /** All tokens accumulated until endStream() fires the single request */
  private textBuffer = '';
  private wsOpen = false;
  private streamEnded = false;
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  readonly done: Promise<void>;

  constructor(private cb: TtsCallbacks) {
    this.done = new Promise<void>(r => { this.doneResolve = r; });
  }

  /**
   * Initiate the Cartesia WebSocket — returns immediately (fire-and-forget).
   * The WS handshake (~50ms) overlaps with the LLM call so it's ready when
   * endStream() fires.
   */
  connect(): void {
    this.connectMs = Date.now();
    this.ws = new WebSocket(WS_URL());

    this.ws.on('open', () => {
      console.log('[TTS] Cartesia WS open');
      this.wsOpen = true;

      // If endStream() was already called before WS opened, send immediately
      if (this.streamEnded) {
        this._send(this.textBuffer || ' ');
      }
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._onAudio((data as Buffer).toString('base64'));
      } else {
        try {
          const msg = JSON.parse((data as Buffer).toString());
          if (msg.data) this._onAudio(msg.data);
          if (msg.done === true) {
            console.log('[TTS] Cartesia stream done');
            this.doneResolve();
          }
          if (msg.error) {
            console.error('[TTS] Cartesia error:', msg.error);
            this.cb.onError('cartesia', String(msg.error));
            this.doneResolve();
          }
        } catch { /* non-JSON frame */ }
      }
    });

    this.ws.on('close', () => this.doneResolve());
    this.ws.on('error', err => {
      console.error('[TTS] WS error:', err.message);
      this.doneResolve();
    });
  }

  /** Accumulate LLM tokens locally — sent all at once when endStream() fires. */
  sendToken(token: string): void {
    this.textBuffer += token;
  }

  /**
   * Send the full accumulated text to Cartesia in one request.
   * Cartesia starts synthesizing immediately and streams audio back.
   */
  endStream(): void {
    this.streamEnded = true;
    if (!this.wsOpen) return; // open handler will send
    this._send(this.textBuffer || ' ');
  }

  /** Resolves when Cartesia signals done or closes the connection. */
  waitForComplete(): Promise<void> { return this.done; }

  /** Immediately close the WS and resolve the done promise. */
  abort(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.doneResolve();
  }

  private _onAudio(base64: string): void {
    if (this.isFirstAudio) {
      this.isFirstAudio = false;
      const ms = Date.now() - this.connectMs;
      console.log(`[TTS] First audio: ${ms}ms after connect()`);
      this.cb.onFirstByte(ms);
    }
    this.cb.onAudioChunk(base64);
  }

  private _send(transcript: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      model_id:      MODEL,
      transcript,
      voice:         { mode: 'id', id: cachedVoiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      context_id:    `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }));
  }
}
