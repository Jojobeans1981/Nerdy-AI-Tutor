/**
 * Streaming pipeline: STT final transcript → LLM token stream → TTS audio chunks
 *
 * TRUE PIPELINE: All three stages run concurrently.
 * - LLM tokens stream directly into ElevenLabsTTS.sendToken()
 * - TTS audio chunks are forwarded to the client via callback the instant they arrive
 * - No stage waits for the previous to complete
 */
import { LatencyTracker, storeReport } from '../utils/latency.js';
import { streamLLM, type ChatMessage } from '../pipeline/llm.js';
import { ElevenLabsTTS } from '../pipeline/tts.js';
import type { WebSocket as ClientWS } from 'ws';

/** Manages one tutoring session's conversation history and streaming pipeline */
export class TutorSession {
  // No system message in history — llm.ts builds it fresh each call with concept+grade
  private history: ChatMessage[] = [];
  // Guard: only one pipeline runs at a time
  private isBusy = false;

  constructor(private ws: ClientWS, private concept: string = 'fractions') {}

  /** Update the active concept and reset conversation history */
  setConcept(concept: string): void {
    this.concept = concept;
    this.history = [];
    console.log(`[Session] Concept set to "${concept}"`);
  }

  /**
   * Run the full streaming pipeline for a student utterance.
   * @param sttMs  True STT duration from DeepgramSTT (first audio → speech_final)
   */
  async processUtterance(
    transcript: string,
    interactionId: string,
    sttMs = 0,
  ): Promise<void> {
    if (this.isBusy) {
      console.log(`[Pipeline] Busy — ignoring: "${transcript.slice(0, 60)}"`);
      return;
    }
    this.isBusy = true;
    try {
      await this._runPipeline(transcript, interactionId, sttMs);
    } finally {
      this.isBusy = false;
    }
  }

  private async _runPipeline(
    transcript: string,
    interactionId: string,
    sttMs: number,
  ): Promise<void> {
    const tracker = new LatencyTracker(interactionId);
    if (sttMs > 0) tracker.setSttMs(sttMs);
    tracker.mark('stt_end');

    // ── Stages 1 + 2 start concurrently ─────────────────────────────────────
    // TTS WebSocket connect() is fire-and-forget — it returns immediately.
    // Tokens sent before the WS opens are buffered inside ElevenLabsTTS.
    // This overlaps the ~100ms ElevenLabs handshake with the Groq API call.
    const tts = new ElevenLabsTTS({
      onAudioChunk: (base64Pcm) => {
        this.ws.send(JSON.stringify({
          type: 'audio',
          data: base64Pcm,
          interaction_id: interactionId,
        }));
      },
      onFirstByte: () => {
        tracker.mark('tts_first_byte');
      },
      onError: (error, message) => {
        this.ws.send(JSON.stringify({ type: 'tts_error', error, message }));
      },
    });

    tts.connect(); // non-blocking — LLM starts immediately below

    // ── Stage 2: Stream LLM tokens ────────────────────────────────────────────
    let fullResponse = '';
    let isFirstToken = true;

    for await (const token of streamLLM(transcript, this.concept, this.history)) {
      if (isFirstToken) {
        tracker.mark('llm_first_token');
        isFirstToken = false;
        console.log(`[LLM] First token  id=${interactionId}`);
      }

      fullResponse += token;

      // Broadcast token to client for real-time text display
      this.ws.send(JSON.stringify({
        type: 'token',
        text: token,
        interaction_id: interactionId,
      }));

      // ── Stage 3: Pipe token into TTS — fires onAudioChunk concurrently ────
      tts.sendToken(token);
    }

    // Signal end of text stream → ElevenLabs will flush and close
    tts.endStream();

    // Wait for all audio chunks to be delivered
    console.log('[TTS] Waiting for complete...');
    await tts.waitForComplete();
    console.log('[TTS] Complete');

    // Update conversation history
    this.history.push({ role: 'user', content: transcript });
    this.history.push({ role: 'assistant', content: fullResponse });
    console.log(`[Session] History: ${this.history.length} messages  concept="${this.concept}"`);

    // Signal response complete to client
    console.log(`[Pipeline] response_end  length=${fullResponse.length}`);
    this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId }));

    // Finalize latency report
    tracker.mark('pipeline_end');
    const report = tracker.report();
    storeReport(report);
    this.ws.send(JSON.stringify({ type: 'latency', ...report }));

    console.log(
      `[Latency] ${interactionId}: ` +
      `STT=${report.stt_ms}ms LLM=${report.llm_first_token_ms}ms ` +
      `TTS=${report.tts_first_byte_ms}ms Total=${report.total_ms}ms`,
    );
  }
}
