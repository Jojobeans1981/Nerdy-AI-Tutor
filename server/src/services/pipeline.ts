/**
 * Streaming pipeline: Deepgram STT → Groq LLM → ElevenLabs TTS → Simli Avatar
 *
 * TRUE PIPELINE: All stages run concurrently. Groq tokens stream directly into
 * the ElevenLabs WebSocket. ElevenLabs audio chunks are forwarded to the client
 * the instant they arrive — no stage waits for the previous to complete.
 */
import Groq from 'groq-sdk';
import { WebSocket } from 'ws';
import { LatencyTracker, storeReport } from '../utils/latency.js';
import { SYSTEM_PROMPT } from '../utils/prompts.js';
import type { WebSocket as ClientWS } from 'ws';

let groq: Groq;
function getGroq() {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}

const VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID!;
const ELEVEN_KEY = () => process.env.ELEVENLABS_API_KEY!;

// ElevenLabs WebSocket streaming input endpoint
// output_format=pcm_16000 → 16-bit signed PCM @ 16 kHz — exactly what Simli expects
const ELEVEN_WS_URL = () =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID()}/stream-input` +
  `?model_id=eleven_turbo_v2_5&output_format=pcm_16000&optimize_streaming_latency=4`;

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Manages one tutoring session's conversation history and streaming pipeline */
export class TutorSession {
  private history: ConversationMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  // Guard: only one pipeline runs at a time. Without this, a second speech_final
  // (echo, background noise, or rapid speech) spawns a second pipeline that
  // overwrites streamingTextRef on the client, making the first response vanish.
  private isBusy = false;

  constructor(private ws: ClientWS) {}

  /** Run the full streaming pipeline for a student utterance */
  async processUtterance(transcript: string, interactionId: string): Promise<void> {
    if (this.isBusy) {
      console.log(`[Pipeline] Busy — ignoring utterance: "${transcript.slice(0, 60)}"`);
      return;
    }
    this.isBusy = true;
    try {
      await this._runPipeline(transcript, interactionId);
    } finally {
      this.isBusy = false;
    }
  }

  private async _runPipeline(transcript: string, interactionId: string): Promise<void> {
    const tracker = new LatencyTracker(interactionId);
    tracker.mark('stt_end');

    this.history.push({ role: 'user', content: transcript });

    // ── Stage 1: Open ElevenLabs WebSocket BEFORE starting LLM ─────────────
    // This eliminates the cold-start penalty from TTS. As soon as the first
    // LLM token arrives, it can be sent directly into the open TTS stream.
    const elevenWs = new WebSocket(ELEVEN_WS_URL(), {
      headers: { 'xi-api-key': ELEVEN_KEY() },
    });

    let isFirstAudio = true;
    let ttsResolveFn: () => void;
    const ttsComplete = new Promise<void>((resolve) => { ttsResolveFn = resolve; });

    elevenWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.audio) {
          if (isFirstAudio) {
            tracker.mark('tts_first_byte');
            isFirstAudio = false;
          }
          // Forward PCM audio chunk immediately to client for Simli rendering
          this.ws.send(JSON.stringify({
            type: 'audio',
            data: msg.audio, // already base64-encoded PCM by ElevenLabs
            interaction_id: interactionId,
          }));
        }

        if (msg.isFinal === true) {
          ttsResolveFn();
        }
      } catch {
        // Non-JSON frame — ignore
      }
    });

    elevenWs.on('close', () => ttsResolveFn());
    elevenWs.on('error', (err) => {
      console.error('[ElevenLabs] WebSocket error:', err.message);
      ttsResolveFn();
    });

    // Wait for ElevenLabs to be ready, then initialize the stream
    await new Promise<void>((resolve, reject) => {
      elevenWs.on('open', resolve);
      elevenWs.on('error', reject);
    });

    elevenWs.send(JSON.stringify({
      text: ' ', // required initialization message
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true,
      },
      generation_config: {
        // Start generating audio after first 80 chars for low latency.
        // Subsequent chunks use 120+ chars for better prosody.
        chunk_length_schedule: [80, 120, 160, 200],
      },
    }));

    // ── Stage 2: Stream LLM tokens from Groq ────────────────────────────────
    // Model: llama-3.1-8b-instant — optimized for < 400ms TTFT on Groq
    // max_tokens: 150 — keeps responses short (Socratic method: 1-2 sentences + question)
    const llmStream = await getGroq().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: this.history,
      stream: true,
      max_tokens: 150,
      temperature: 0.7,
    });

    let fullResponse = '';
    let tokenBuffer = '';
    let isFirstToken = true;

    for await (const chunk of llmStream) {
      const token = chunk.choices[0]?.delta?.content;
      if (!token) continue;

      if (isFirstToken) {
        tracker.mark('llm_first_token');
        isFirstToken = false;
      }

      fullResponse += token;
      tokenBuffer += token;

      // Broadcast token to client for real-time text display
      this.ws.send(JSON.stringify({ type: 'token', text: token, interaction_id: interactionId }));

      // ── Stage 3: Pipe tokens into ElevenLabs WebSocket ───────────────────
      // Flush at natural language boundaries or when buffer is large enough.
      // Sending too-small chunks degrades TTS quality; too-large adds latency.
      const atBoundary = /[.!?,;:]/.test(token);
      const bufferFull = tokenBuffer.length >= 80;

      if ((atBoundary || bufferFull) && tokenBuffer.trim()) {
        if (elevenWs.readyState === WebSocket.OPEN) {
          elevenWs.send(JSON.stringify({ text: tokenBuffer }));
        }
        tokenBuffer = '';
      }
    }

    // Flush any remaining buffered text
    if (tokenBuffer.trim() && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(JSON.stringify({ text: tokenBuffer }));
    }

    // Signal end of text to ElevenLabs (empty string closes the TTS stream)
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(JSON.stringify({ text: '' }));
    }

    // Wait for ElevenLabs to finish sending all audio chunks
    await ttsComplete;

    // Record assistant turn in conversation history
    this.history.push({ role: 'assistant', content: fullResponse });

    // Signal to client that the response is complete
    this.ws.send(JSON.stringify({ type: 'response_end', interaction_id: interactionId }));

    // Finalize latency report
    tracker.mark('pipeline_end');
    const report = tracker.report();
    storeReport(report);
    this.ws.send(JSON.stringify({ type: 'latency', ...report }));

    console.log(
      `[Latency] ${interactionId}: STT=${report.stt_ms}ms ` +
      `LLM=${report.llm_first_token_ms}ms TTS=${report.tts_first_byte_ms}ms ` +
      `Total=${report.total_ms}ms`
    );
  }
}
