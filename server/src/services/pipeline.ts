/**
 * Streaming pipeline: STT final transcript → LLM token stream → TTS audio chunks
 *
 * TRUE PIPELINE: All three stages run concurrently.
 * - LLM tokens stream directly into CartesiaTTS.sendToken()
 * - TTS audio chunks are forwarded to the client via callback the instant they arrive
 * - No stage waits for the previous to complete
 */
import { LatencyTracker, storeReport, updateAvatarRender } from '../utils/latency.js';
import { streamLLM, type ChatMessage } from '../pipeline/llm.js';
import { CartesiaTTS } from '../pipeline/tts.js';
import type { WebSocket as ClientWS } from 'ws';

/** Manages one tutoring session's conversation history and streaming pipeline */
export class TutorSession {
  // No system message in history — llm.ts builds it fresh each call with concept+grade
  private history: ChatMessage[] = [];
  // Guard: only one pipeline runs at a time
  private isBusy = false;
  // Queue the latest utterance received while busy (replaces any prior queued one)
  private pendingUtterance: { transcript: string; interactionId: string; sttMs: number } | null = null;

  constructor(private ws: ClientWS, private concept: string = 'fractions') {}

  /** Called by the WebSocket handler when the client reports avatar render latency */
  reportAvatarRender(interactionId: string, renderMs: number): void {
    updateAvatarRender(interactionId, renderMs);
    console.log(`[Avatar] render_ms=${renderMs}  id=${interactionId}`);
  }

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
      // Queue the utterance so it runs after the current pipeline finishes
      console.log(`[Pipeline] Busy — queuing: "${transcript.slice(0, 60)}"`);
      this.pendingUtterance = { transcript, interactionId, sttMs };
      return;
    }
    this.isBusy = true;
    try {
      await this._runPipeline(transcript, interactionId, sttMs);
    } finally {
      this.isBusy = false;
      // Process queued utterance if any
      if (this.pendingUtterance) {
        const pending = this.pendingUtterance;
        this.pendingUtterance = null;
        this.processUtterance(pending.transcript, pending.interactionId, pending.sttMs).catch((err) => {
          console.error('[Pipeline] Queued utterance error:', err);
        });
      }
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
    const tts = new CartesiaTTS({
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

    // Send full text to Cartesia — it streams audio back as it synthesizes
    tts.endStream();

    // Update conversation history immediately (LLM is done)
    this.history.push({ role: 'user', content: transcript });
    this.history.push({ role: 'assistant', content: fullResponse });
    console.log(`[Session] History: ${this.history.length} messages  concept="${this.concept}"`);

    // Signal response complete to client as soon as text is done —
    // audio chunks continue streaming in the background via onAudioChunk.
    console.log(`[Pipeline] response_end  length=${fullResponse.length}`);
    this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId }));

    // Wait up to 2s for TTS first byte, then send the latency report
    // so tts_first_byte_ms is captured accurately.
    const ttsTimeout = new Promise<void>(r => setTimeout(r, 2000));
    await Promise.race([tts.waitForComplete(), ttsTimeout]);

    tracker.mark('pipeline_end');
    const report = tracker.report();
    storeReport(report);
    this.ws.send(JSON.stringify({ type: 'latency', ...report }));

    console.log(
      `[Latency] ${interactionId}: ` +
      `STT=${report.stt_ms}ms LLM=${report.llm_first_token_ms}ms ` +
      `TTS=${report.tts_first_byte_ms}ms Total=${report.total_ms}ms`,
    );

    // Let remaining audio finish in background
    tts.waitForComplete().catch(() => {});
  }
}
