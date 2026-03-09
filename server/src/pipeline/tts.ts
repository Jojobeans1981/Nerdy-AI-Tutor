/**
 * TTS module — Cartesia Sonic streaming WebSocket.
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
  onAudioChunk: (base64Pcm: string) => void;
  onFirstByte: (ms: number) => void;
  onError: (error: string, message: string) => void;
}

// ── CartesiaTTS ───────────────────────────────────────────────────────────────
export class CartesiaTTS {
  private ws: WebSocket | null = null;
  private textBuffer = '';
  private wsOpen = false;
  private streamEnded = false;
  private streamDone = false;
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  readonly done: Promise<void>;

  constructor(private cb: TtsCallbacks) {
    this.done = new Promise<void>(r => { this.doneResolve = r; });
  }

  connect(): void {
    this.connectMs = Date.now();
    this.ws = new WebSocket(WS_URL());

    this.ws.on('open', () => {
      console.log('[TTS] Cartesia WS open');
      this.wsOpen = true;
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
            this.streamDone = true;
            this.doneResolve();
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

  sendToken(token: string): void {
    this.textBuffer += token;
  }

  endStream(): void {
    this.streamEnded = true;
    if (!this.wsOpen) return;
    this._send(this.textBuffer || ' ');
  }

  waitForComplete(): Promise<void> { return this.done; }

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
