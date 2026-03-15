/**
 * Streaming pipeline: STT final transcript → LLM token stream → TTS audio chunks
 *
 * TRUE PIPELINE: All three stages run concurrently.
 * - LLM tokens stream directly into CartesiaTTS.sendToken()
 * - TTS audio chunks are forwarded to the client via callback the instant they arrive
 * - No stage waits for the previous to complete
 */
import { LatencyTracker, storeReport, updateAvatarRender } from '../utils/latency.js';
import { streamLLM, extractSessionUpdate, verifyStudentAnswer, type ChatMessage, type SessionContext } from '../pipeline/llm.js';
import { CartesiaTTS } from '../pipeline/tts.js';
import type { WebSocket as ClientWS } from 'ws';

// BUG 1 FIX: track cache hit rate across all sessions
let cacheHits = 0;
let cacheMisses = 0;

export function getCacheHitStats(): { hits: number; misses: number; hitRate: string } {
  const total = cacheHits + cacheMisses;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? `${Math.round((cacheHits / total) * 100)}%` : 'n/a',
  };
}

/** Manages one tutoring session's conversation history and streaming pipeline */
export class TutorSession {
  // No system message in history — llm.ts builds it fresh each call with concept+grade
  private history: ChatMessage[] = [];
  // Guard: only one pipeline runs at a time
  private isBusy = false;
  // Queue the latest utterance received while busy (replaces any prior queued one)
  private pendingUtterance: { transcript: string; interactionId: string; sttMs: number } | null = null;
  // AbortController for the currently running pipeline (barge-in support)
  private currentAbortController: AbortController | null = null;

  // FIX 6: Session-level mastery and hint tracking
  private conceptsMastered: string[] = [];
  private mistakePatterns: string[] = [];
  private hintLevel = 0;
  private attemptCountOnCurrentConcept = 0;
  // BUG 2 FIX: store last exchange for async extraction
  private lastStudentUtterance = '';
  private fullLlmResponseText = '';
  // Latency optimisation: verify starts on is_final (~250ms before speech_final)
  // so by the time _runPipeline runs the promise is already resolved.
  private prefetchedVerify: Promise<'correct' | 'incorrect' | 'unknown'> | null = null;
  private prefetchedTranscript = '';

  /** Optional callback — called at the top of _runPipeline so STT can activate keepAlive */
  public onPipelineStart: (() => void) | null = null;

  constructor(private ws: ClientWS, private concept: string = 'fractions') {}

  /** Called by the WebSocket handler when the client reports avatar render latency */
  reportAvatarRender(interactionId: string, renderMs: number): void {
    updateAvatarRender(interactionId, renderMs);
    console.log(`[Avatar] render_ms=${renderMs}  id=${interactionId}`);
  }

  /**
   * Interrupt the current pipeline (barge-in).
   * Aborts the running LLM/TTS stream; the pending utterance (already queued
   * by processUtterance) will be processed immediately after abort settles.
   */
  interrupt(): void {
    if (this.isBusy && this.currentAbortController) {
      console.log('[Pipeline] Barge-in — aborting current pipeline');
      this.currentAbortController.abort(new Error('barge-in'));
    }
  }

  /**
   * Called by the STT layer on is_final=true (~250ms before speech_final).
   * Starts answer verification immediately so the result is ready when the
   * pipeline begins — eliminating verifyStudentAnswer's ~300ms serial cost.
   */
  prefetchVerify(transcript: string): void {
    if (this.isBusy) return; // don't prefetch if a pipeline is already running
    // Debounce: if is_final fires multiple times with the same text (Deepgram can
    // emit several is_final events before speech_final), skip redundant Groq calls.
    if (this.prefetchedTranscript === transcript && this.prefetchedVerify) return;
    this.prefetchedTranscript = transcript;
    this.prefetchedVerify = verifyStudentAnswer(transcript, this.concept, this.history);
    console.log(`[Verify] Prefetch started for: "${transcript.slice(0, 50)}"`);
  }

  /** Update the active concept and reset conversation history + session tracking */
  setConcept(concept: string): void {
    this.concept = concept;
    this.history = [];
    this.conceptsMastered = [];
    this.mistakePatterns = [];
    this.hintLevel = 0;
    this.attemptCountOnCurrentConcept = 0;
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
    console.log(`[Pipeline] processUtterance  isBusy=${this.isBusy}  id=${interactionId}  text="${transcript.slice(0, 60)}"`);
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
      console.log(`[Pipeline] isBusy released — ready for next utterance`);
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
    console.log(`[Pipeline] _runPipeline START  id=${interactionId}  text="${transcript.slice(0, 60)}"`);
    this.onPipelineStart?.();
    this.currentAbortController = new AbortController();
    const { signal } = this.currentAbortController;

    // 45s safety fuse: if _runPipeline hasn't returned by then, force-reset isBusy
    // so subsequent utterances aren't permanently blocked.
    const safetyFuse = setTimeout(() => {
      if (this.isBusy) {
        console.error(`[Pipeline] SAFETY FUSE: isBusy still true after 45s — force-resetting  id=${interactionId}`);
        this.isBusy = false;
      }
    }, 45000);

    // FIX 6: increment attempt count; compute hint level before calling LLM
    this.attemptCountOnCurrentConcept++;
    this.hintLevel = Math.min(2, this.attemptCountOnCurrentConcept - 1);
    const sessionContext: SessionContext = {
      hintLevel: this.hintLevel,
      conceptsMastered: [...this.conceptsMastered],
      mistakePatterns: [...this.mistakePatterns],
    };
    console.log(`[Session] attempt=${this.attemptCountOnCurrentConcept} hintLevel=${this.hintLevel}`);

    const tracker = new LatencyTracker(interactionId);
    if (sttMs > 0) tracker.setSttMs(sttMs);
    tracker.mark('stt_end');

    // ── Stages 1 + 2 start concurrently ─────────────────────────────────────
    // TTS WebSocket connect() is fire-and-forget — it returns immediately.
    // Tokens are accumulated locally until the WS opens, then sent in one shot.
    // This overlaps the Cartesia handshake with the Groq API call.
    const tts = new CartesiaTTS({
      onAudioChunk: (pcm) => {
        // Send as binary frame: [0x01 type byte][raw PCM] — no base64, no JSON overhead
        const frame = Buffer.allocUnsafe(1 + pcm.length);
        frame[0] = 0x01;
        pcm.copy(frame, 1);
        try { this.ws.send(frame); } catch { /* WS closed */ }
      },
      onFirstByte: () => {
        tracker.mark('tts_first_byte');
      },
      onError: (error, message) => {
        try { this.ws.send(JSON.stringify({ type: 'tts_error', error, message })); } catch { /* WS closed */ }
      },
    });

    tts.connect(); // non-blocking — runs in parallel with verification below

    // Use the prefetched verify promise if it was started on is_final (~250ms ago),
    // otherwise start it now (text_input path, or if prefetch was skipped).
    // In the prefetch case the promise is already resolved — await is instant.
    const verifyPromise = (this.prefetchedVerify && this.prefetchedTranscript === transcript)
      ? this.prefetchedVerify
      : verifyStudentAnswer(transcript, this.concept, this.history);
    this.prefetchedVerify = null;
    this.prefetchedTranscript = '';

    const answerVerdict = await verifyPromise;
    console.log(`[Verify] transcript="${transcript.slice(0, 50)}" verdict=${answerVerdict}`);
    sessionContext.answerVerdict = answerVerdict;

    // ── Stages 2 + 3: Stream LLM → TTS ──────────────────────────────────────
    // Wrapped in try/finally so tts.abort() ALWAYS runs — even if the LLM
    // times out (AbortSignal fires), throws, or the client WS closes mid-stream.
    // Without this, a failed pipeline leaves the Cartesia WS open indefinitely,
    // blocking the next request (free tier rejects concurrent connections).
    let fullResponse = '';
    let llmCompleted = false;
    let historyPushed = false;
    let responseEndSent = false;
    try {
      let isFirstToken = true;

      console.log(`[Pipeline] LLM start  id=${interactionId}`);
      for await (const token of streamLLM(transcript, this.concept, this.history, signal, sessionContext)) {
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

      // TTS cache disabled (was Cartesia-specific) — synthesize via Edge TTS
      tts.endStream();

      // Update conversation history immediately (LLM is done)
      this.history.push({ role: 'user', content: transcript });
      this.history.push({ role: 'assistant', content: fullResponse });
      historyPushed = true;
      console.log(`[Session] History: ${this.history.length} messages  concept="${this.concept}"`);

      // Signal response complete to client as soon as text is done —
      // audio chunks continue streaming in the background via onAudioChunk.
      console.log(`[Pipeline] response_end  length=${fullResponse.length}`);
      this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId }));
      responseEndSent = true;

      // BUG 2 FIX: fire session state extraction after audio is queued — non-blocking
      this.lastStudentUtterance = transcript;
      this.fullLlmResponseText = fullResponse;
      setImmediate(async () => {
        try {
          const update = await extractSessionUpdate(
            this.lastStudentUtterance,
            this.fullLlmResponseText,
            this.concept,
            {
              conceptsMastered: this.conceptsMastered,
              mistakePatterns: this.mistakePatterns,
              attemptCountOnCurrentConcept: this.attemptCountOnCurrentConcept,
            },
          );
          this.conceptsMastered = update.conceptsMastered;
          this.mistakePatterns = update.mistakePatterns;
          if (update.wasCorrect) {
            this.attemptCountOnCurrentConcept = 0;
            this.hintLevel = 0;
          } else {
            this.attemptCountOnCurrentConcept += 1;
            this.hintLevel = Math.min(2, this.attemptCountOnCurrentConcept);
          }
          console.log('[Session State] Updated:', {
            conceptsMastered: this.conceptsMastered,
            mistakePatterns: this.mistakePatterns,
            hintLevel: this.hintLevel,
          });
        } catch (err) {
          console.error('[Session State] Extraction error (non-fatal):', err);
        }
      });

      // Wait for TTS to finish BEFORE releasing isBusy — prevents concurrent
      // Cartesia WS connections (free tier rejects them).
      // waitForComplete() has its own 8s ceiling + WS close fallback, so no extra race needed.
      console.log(`[Pipeline] Waiting for TTS completion...  id=${interactionId}`);
      await tts.waitForComplete().catch(() => {});
      console.log(`[Pipeline] TTS done — closing WS  id=${interactionId}`);
      await tts.abort().catch(() => {});
      console.log(`[Pipeline] TTS done or timed out — entering finally  id=${interactionId}`);
    } catch (err) {
      console.error('[Pipeline] LLM/TTS stream error:', err);
      // Notify the client so the UI doesn't stay frozen waiting for response_end
      try { this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId, error: true })); responseEndSent = true; } catch { /* WS closed */ }
      // Save partial response to history so conversation context isn't lost
      if (fullResponse && !historyPushed) {
        this.history.push({ role: 'user', content: transcript });
        this.history.push({ role: 'assistant', content: llmCompleted ? fullResponse : fullResponse + '…' });
      }
      // Synchronous TTS abort — must complete before isBusy releases
      await tts.abort().catch(() => {});
    } finally {
      console.log(`[Pipeline] FINALLY block entered  id=${interactionId}  responseEndSent=${responseEndSent}`);
      // Guarantee response_end reaches the client even if both try and catch failed to send it
      if (!responseEndSent) {
        console.warn(`[Pipeline] response_end not sent — sending from finally block  id=${interactionId}`);
        try { this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId, error: true })); } catch { /* WS closed */ }
      }
      this.currentAbortController = null;
      clearTimeout(safetyFuse);
      console.log(`[Pipeline] FINALLY block complete  id=${interactionId}`);
    }

    tracker.mark('pipeline_end');
    const report = tracker.report();
    storeReport(report);
    try { this.ws.send(JSON.stringify({ type: 'latency', ...report })); } catch { /* WS closed */ }

    console.log(
      `[Latency] ${interactionId}: ` +
      `STT=${report.stt_ms}ms LLM=${report.llm_first_token_ms}ms ` +
      `TTS=${report.tts_first_byte_ms}ms Total=${report.total_ms}ms`,
    );
  }
}
