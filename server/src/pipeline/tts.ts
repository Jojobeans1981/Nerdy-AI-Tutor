/**
 * TTS module — ElevenLabs streaming WebSocket.
 *
 * connect() is FIRE-AND-FORGET — it initiates the WebSocket but returns
 * immediately so the LLM can start in parallel. Tokens sent before the
 * WebSocket opens are buffered and flushed once the connection is ready.
 *
 * This saves the full WS handshake time (~100ms) from the critical path.
 */
import { WebSocket } from 'ws';

const VOICE_ID  = () => process.env.ELEVENLABS_VOICE_ID!;
const ELEVEN_KEY = () => process.env.ELEVENLABS_API_KEY!;

// eleven_flash_v2_5 = ElevenLabs' ultra-low-latency model (~2× faster than turbo)
const ELEVEN_WS_URL = () =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID()}/stream-input` +
  `?model_id=eleven_flash_v2_5&output_format=pcm_16000&optimize_streaming_latency=4`;

export interface TtsCallbacks {
  /** Fires immediately for every base64 PCM chunk — concurrent with LLM loop */
  onAudioChunk: (base64Pcm: string) => void;
  /** ms from connect() call to first audio chunk */
  onFirstByte: (ms: number) => void;
  /** ElevenLabs API error (e.g. payment_required) */
  onError: (error: string, message: string) => void;
}

export class ElevenLabsTTS {
  private ws: WebSocket | null = null;
  /** Buffer for tokens that arrive before the WebSocket is open */
  private preOpenBuffer = '';
  /** Buffer for boundary-based flushing once connected */
  private tokenBuffer = '';
  private wsOpen = false;
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  private readonly done: Promise<void>;

  constructor(private callbacks: TtsCallbacks) {
    this.done = new Promise<void>((resolve) => { this.doneResolve = resolve; });
  }

  /**
   * Initiate the ElevenLabs WebSocket connection — returns immediately.
   * The pipeline can start the LLM right after calling this without waiting.
   */
  connect(): void {
    this.connectMs = Date.now();
    this.ws = new WebSocket(ELEVEN_WS_URL(), {
      headers: { 'xi-api-key': ELEVEN_KEY() },
    });

    this.ws.on('open', () => {
      console.log('[TTS] ElevenLabs WS open');
      // Required init message must arrive before any text
      this.ws!.send(JSON.stringify({
        text: ' ',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.0,
          use_speaker_boost: true,
        },
        generation_config: {
          // 30 chars → first audio faster; larger chunks for better prosody on later chunks
          chunk_length_schedule: [30, 60, 100, 140],
        },
      }));

      this.wsOpen = true;

      // Drain any tokens that arrived while the WS was still connecting
      if (this.preOpenBuffer) {
        this.tokenBuffer = this.preOpenBuffer;
        this.preOpenBuffer = '';
        this._flush();
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (!msg.audio) {
          console.log('[TTS] Message:', JSON.stringify(msg).slice(0, 200));
          if (msg.error || msg.message) {
            this.callbacks.onError(msg.error ?? 'unknown', msg.message ?? '');
          }
          if (msg.isFinal === true) this.doneResolve();
        }

        if (msg.audio) {
          if (this.isFirstAudio) {
            this.isFirstAudio = false;
            const ms = Date.now() - this.connectMs;
            console.log(`[TTS] First audio: ${ms}ms after connect()`);
            this.callbacks.onFirstByte(ms);
          }
          this.callbacks.onAudioChunk(msg.audio);
        }
      } catch { /* non-JSON */ }
    });

    this.ws.on('close', () => this.doneResolve());
    this.ws.on('error', (err) => {
      console.error('[TTS] WebSocket error:', err.message);
      this.doneResolve();
    });
  }

  /**
   * Feed one LLM token. If the WebSocket isn't open yet, the token is
   * buffered and will be flushed the moment the connection opens.
   */
  sendToken(token: string): void {
    if (!this.wsOpen) {
      this.preOpenBuffer += token;
      return;
    }

    this.tokenBuffer += token;
    const atBoundary = /[.!?,;:]/.test(token);
    const bufferFull = this.tokenBuffer.length >= 80;

    if ((atBoundary || bufferFull) && this.tokenBuffer.trim()) {
      this._flush();
    }
  }

  /** Flush remaining text and send the end-of-stream marker. */
  endStream(): void {
    if (!this.wsOpen) {
      // WS never opened — nothing to flush
      this.doneResolve();
      return;
    }
    if (this.tokenBuffer.trim()) this._flush();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: '' }));
    }
  }

  /** Resolves when ElevenLabs signals isFinal or closes the connection. */
  waitForComplete(): Promise<void> {
    return this.done;
  }

  private _flush(): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.tokenBuffer.trim()) {
      this.ws.send(JSON.stringify({ text: this.tokenBuffer }));
    }
    this.tokenBuffer = '';
  }
}
