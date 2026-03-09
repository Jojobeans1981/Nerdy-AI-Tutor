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

    // ── Stages 2 + 3: Stream LLM → TTS ──────────────────────────────────────
    // Wrapped in try/finally so tts.abort() ALWAYS runs — even if the LLM
    // times out (AbortSignal fires), throws, or the client WS closes mid-stream.
    // Without this, a failed pipeline leaves the Cartesia WS open indefinitely,
    // blocking the next request (free tier rejects concurrent connections).
    let fullResponse = '';
    let llmCompleted = false;
    try {
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

        // ── Stage 3: Pipe token into TTS — fires onAudioChunk concurrently ──
        tts.sendToken(token);
      }

      llmCompleted = true;

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

      // Wait up to 4s for TTS to complete, then abort to avoid dangling WS connections.
      // Cartesia's free tier rejects a new connection if a prior WS is still open.
      const ttsTimeout = new Promise<void>(r => setTimeout(r, 4000));
      await Promise.race([tts.waitForComplete(), ttsTimeout]);
    } catch (err) {
      console.error('[Pipeline] LLM/TTS stream error:', err);
      // Notify the client so the UI doesn't stay frozen waiting for response_end
      this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId, error: true }));
      // Save partial response to history so conversation context isn't lost
      if (fullResponse) {
        this.history.push({ role: 'user', content: transcript });
        this.history.push({ role: 'assistant', content: llmCompleted ? fullResponse : fullResponse + '…' });
      }
    } finally {
      // Always close the Cartesia WS — prevents a stale open connection
      // from blocking the next request, regardless of how the pipeline ended.
      tts.abort();
    }

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
