/**
 * TTS module — Microsoft Edge TTS (free, no API key required).
 *
 * Replaces Cartesia Sonic. Uses msedge-tts to synthesize MP3, then decodes
 * to 16-bit 16kHz mono PCM via ffmpeg-static so the existing client binary
 * protocol works unchanged.
 *
 * connect() is a no-op (no persistent WS needed).
 * Tokens accumulate via sendToken(); endStream() triggers synthesis.
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

// Prevents avatar mouth-open artifact before audio playback starts
function generateSilenceBuffer(durationMs: number, sampleRate = 16000): Buffer {
  return Buffer.alloc(Math.floor(durationMs * sampleRate / 1000) * 2);
}

// Voice name — Microsoft neural voice
const VOICE = 'en-US-JennyNeural'; // Female, natural sounding

// ── Voice resolution ──────────────────────────────────────────────────────────
/**
 * No-op for Edge TTS — voice is specified by name, not fetched from API.
 * Returns empty string (no voice ID concept in Edge TTS).
 */
export async function preloadVoice(): Promise<string> {
  console.log(`[TTS] Edge TTS voice: ${VOICE} (no API key required)`);
  return '';
}

// ── Callbacks ─────────────────────────────────────────────────────────────────
export interface TtsCallbacks {
  /** Raw PCM bytes (16-bit signed, 16kHz, mono) */
  onAudioChunk: (pcm: Buffer) => void;
  onFirstByte: (ms: number) => void;
  onError: (error: string, message: string) => void;
}

// ── EdgeTTS (drop-in replacement for CartesiaTTS) ─────────────────────────────
export class CartesiaTTS {
  private textBuffer = '';
  private connectMs = 0;
  private isFirstAudio = true;
  private doneResolve!: () => void;
  readonly done: Promise<void>;
  private streamDone = false;
  private completionResolve: (() => void) | null = null;
  private ffmpegProc: ChildProcess | null = null;
  private aborted = false;

  constructor(private cb: TtsCallbacks) {
    this.done = new Promise<void>(r => { this.doneResolve = r; });
  }

  /** No-op — Edge TTS doesn't need a persistent connection */
  connect(): void {
    console.log('[TTS] connect() called (Edge TTS — no WS needed)');
    this.connectMs = Date.now();
  }

  /** Accumulate LLM tokens */
  sendToken(token: string): void {
    this.textBuffer += token;
  }

  /**
   * Signal end of LLM stream. Synthesizes all accumulated text via Edge TTS,
   * decodes MP3 → PCM via ffmpeg, and streams PCM chunks to the callback.
   */
  endStream(): void {
    const text = this.textBuffer.trimEnd();
    this.textBuffer = '';
    if (text.length === 0) {
      console.log('[TTS] endStream — no text to synthesize');
      this.streamDone = true;
      this.doneResolve();
      this.completionResolve?.();
      return;
    }
    console.log(`[TTS] endStream — synthesizing (${text.length} chars): "${text.slice(0, 80)}"`);
    this._synthesize(text).catch(err => {
      console.error('[TTS] Synthesis error:', err);
      this.cb.onError('edge-tts', err.message || String(err));
      this.streamDone = true;
      this.doneResolve();
      this.completionResolve?.();
    });
  }

  waitForComplete(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(ceiling);
        resolve();
      };

      this.completionResolve = done;
      if (this.streamDone) { done(); return; }

      // 15s ceiling
      const ceiling = setTimeout(() => {
        console.warn('[TTS] waitForComplete ceiling hit (15s) — forcing resolve');
        done();
      }, 15000);
    });
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.streamDone = true;
    this.doneResolve();
    this.completionResolve?.();
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch { /* ignore */ }
      this.ffmpegProc = null;
    }
    return Promise.resolve();
  }

  private async _synthesize(text: string): Promise<void> {
    if (this.aborted) return;

    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const { audioStream } = tts.toStream(text);

    // Pipe MP3 through ffmpeg to get 16kHz 16-bit mono PCM
    const proc = spawn(ffmpegPath!, [
      '-i', 'pipe:0',          // read MP3 from stdin
      '-f', 's16le',           // output raw PCM
      '-ar', '16000',          // 16kHz sample rate
      '-ac', '1',              // mono
      '-acodec', 'pcm_s16le',  // 16-bit signed little-endian
      'pipe:1',                // write to stdout
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpegProc = proc;

    // Pipe Edge TTS MP3 stream → ffmpeg stdin
    audioStream.pipe(proc.stdin!);

    // Read PCM from ffmpeg stdout
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (this.aborted) return;
      if (this.isFirstAudio) {
        this.isFirstAudio = false;
        const ms = Date.now() - this.connectMs;
        console.log(`[TTS] First audio: ${ms}ms after connect()`);
        this.cb.onFirstByte(ms);
        const silence = generateSilenceBuffer(40);
        this.cb.onAudioChunk(Buffer.concat([silence, chunk]));
        return;
      }
      this.cb.onAudioChunk(chunk);
    });

    proc.stderr!.on('data', (data: Buffer) => {
      // ffmpeg outputs progress/info to stderr — only log errors
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('[TTS] ffmpeg error:', msg.slice(0, 200));
      }
    });

    return new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        this.ffmpegProc = null;
        if (code !== 0 && !this.aborted) {
          console.warn(`[TTS] ffmpeg exited with code ${code}`);
        }
        console.log('[TTS] Synthesis complete');
        this.streamDone = true;
        this.doneResolve();
        this.completionResolve?.();
        resolve();
      });

      proc.on('error', (err) => {
        console.error('[TTS] ffmpeg process error:', err.message);
        this.cb.onError('ffmpeg', err.message);
        this.streamDone = true;
        this.doneResolve();
        this.completionResolve?.();
        resolve();
      });
    });
  }
}
