# Development Log — Nerdy AI Tutor

Chronological record of what was built, major decisions, and rationale.

---

## Project Goal

Build a real-time AI video avatar tutor that teaches using the Socratic method — guiding students to discover answers through questions, never giving direct answers. The system listens via microphone, processes speech, generates a Socratic response, and delivers it through a lip-synced video avatar with sub-second perceived latency.

**Pipeline:** `Mic → Deepgram STT → Groq LLM → Cartesia TTS → Simli WebRTC Avatar`

---

## Commit History

### Commit 1 — `f54e5fc` · Initial commit
**What was built:**
- Full streaming pipeline: Deepgram Nova-2 STT → Groq llama-3.1-8b-instant → Cartesia Sonic TTS → Simli WebRTC avatar
- Express + WebSocket server (`server/src/index.ts`) handling binary PCM audio from client
- `TutorSession` class (`pipeline.ts`) managing conversation history and `isBusy` guard
- `DeepgramSTT` module with live streaming, keep-alive, and auto-reconnect
- `CartesiaTTS` module with fire-and-forget WebSocket connect (concurrent with LLM call)
- `streamLLM` generator function with Socratic system prompt per concept + grade level
- React client with `AudioWorklet` for mic capture (PCM, downsampled to 16kHz off main thread)
- Simli WebRTC avatar component with auth prefetch on module load
- Latency tracking: per-stage timestamps (STT, LLM first token, TTS first byte, pipeline end)
- Three topics: Fractions (6th), Mitosis (8th), Algebra (9th)

**Key architectural decisions:**
- **Concurrent pipeline**: TTS WebSocket connects at the same time as the LLM call starts, not after. Eliminates ~50ms cold-start cost.
- **Single TTS request**: Accumulate all LLM tokens locally, send to Cartesia in one request when LLM finishes. Cartesia's streaming-context `continue` mode was tested but found slower in practice.
- **AudioWorklet**: Runs off main thread — no UI jank during continuous mic capture. Handles native-rate → 16kHz downsampling.
- **`isBusy` guard with pending queue**: Only one pipeline runs at a time. Overlapping utterances are queued (single slot — newest replaces older).
- **Socratic system prompt**: Rebuilt fresh each call with concept + grade. Enforced rules: end every response with a question, never give direct answers, affirm correct answers.

---

### Commit 2 — `a7d1b15` · UI/UX overhaul, debug fixes, animated neural network background
**What changed:**
- Full visual redesign: dark glassmorphism UI with animated neural network background
- Latency dashboard component showing per-stage breakdown
- Topic selector with per-topic accent cards
- MicSelector component for device switching
- VisualAid component (concept diagrams)
- ChatDisplay with streaming token display and interim transcript
- Text input fallback alongside voice input
- Avatar height increased (260px → 420px), `objectFit: contain` to show full face
- TTS cache: pre-synthesize 8 common affirmation phrases at startup (sequential, not concurrent — avoids 429 rate limits)
- STT improvements: `utterance_end_ms: 1500` fallback finalizer with `pendingFinalText` tracking; `reconnecting` guard to prevent duplicate reconnect loops
- Simli auth prefetch triggered on module load (before user selects topic)
- Client-side `pendingAudioRef` queue: audio chunks received before Simli WebRTC is ready are buffered and replayed on connect

---

### Commit 3 — `cc6a237` · Text input, voice UX, STT resilience, avatar prefetch
**What changed:**
- Text input field added alongside voice — sends as `text_input` WS message, bypasses STT
- Pending text queue: text typed before WS connects is sent once connected
- STT resilience: `UtteranceEnd` event as fallback when `speech_final` never fires (background noise preventing endpointing)
- Noise suppression enabled on mic: `noiseSuppression: { ideal: true }`
- Avatar render latency measurement and reporting to server
- Lip-sync measurement: `requestVideoFrameCallback` tracks video frame timing vs audio sent time
- Watchdog timer (8s): if `response_end` never arrives (server hung), client auto-clears "Speaking" state

---

### Commit 4 — `8eaddc1` · Pipeline stability, avatar load, lip sync, and voice improvements
**What changed:**

**Critical bug fix — pipeline freeze after errors:**
- `_runPipeline` had no try/catch around the LLM/TTS stream. If the LLM timed out (AbortSignal.timeout(12s)) or threw, `tts.abort()` was never called, leaving the Cartesia WebSocket open indefinitely. The next request failed because Cartesia (free tier) rejects concurrent connections.
- **Fix:** Wrapped LLM/TTS stream in `try/finally` — `tts.abort()` always runs. Error path also sends `response_end` to client so UI never stays frozen.

**Critical bug fix — "stuck on Speaking" for ~8s after response:**
- `response_end` is sent when LLM finishes, but Cartesia audio chunks keep streaming for 1-2s after. Each arriving audio chunk reset the 8s watchdog timer, keeping the avatar on "Speaking" for 8+ seconds.
- **Fix:** `responseEndedRef` flag. When `response_end` arrives, flag is set. Subsequent audio chunks still forward to Simli but do NOT reset the 8s watchdog. Avatar goes to "Listening" 1 second after `response_end`.

**Avatar load time improvement:**
- `AvatarVideo` was only mounted after topic selection, so the 3-5s Simli WebRTC handshake happened after the user clicked a topic.
- **Fix:** Session layout always renders (CSS `display: none` before topic selected). AvatarVideo mounts immediately on page load. WebRTC handshake runs in the background while user reads the landing page. By the time a topic is selected, avatar is often already connected.

**Lip sync improvement — audio rechunking:**
- Cartesia sends PCM in arbitrary chunk sizes. Simli's internal AudioProcessor batches at 3000 samples (6000 bytes). Sending mismatched sizes caused irregular animation bursts.
- **Fix:** Client-side rechunk buffer accumulates bytes and drains in exact 6000-byte frames before `sendAudioData()`.
- `flushAudio()` called at `response_end` to zero-pad and send the final partial frame.
- Kept `sendAudioData` (not `sendAudioDataImmediate`) to preserve Simli's jitter buffer — prevents glitchy audio from network delivery variations.

**Voice change:** Switched from default male voice to Janet - Sunny Speaker (female, warm, guidance-oriented). ID: `58fbaf73-d7de-4e82-a6b3-118180e7057c`.

**Code cleanup (audit-driven):**
- Removed stale `[ElevenLabs]` references in comments and logs (Cartesia replaced ElevenLabs early in development)
- Deleted orphaned `server/src/utils/prompts.ts` (superseded by `buildSystemPrompt()` in `llm.ts`)
- Removed unused `SOCRATIC_TEST_SCENARIOS` export from `llm.ts`
- Removed unused `getCachedOpener()` export from `ttsCache.ts`
- Fixed TypeScript error: `VisualAid topic={topic ?? ''}` (always-mounted session grid exposes `string | null`)

---

## Architecture Summary

```
Browser (React + Vite)
  ├── useMicrophone     AudioWorklet off main thread, float32 → int16 PCM, 16kHz
  ├── useWebSocket      Binary (PCM) + JSON message routing
  ├── AvatarVideo       Simli WebRTC client, 6000-byte audio rechunker
  └── App               Session state, responseEndedRef watchdog logic

Node.js Server (Express + ws)
  ├── index.ts          WS server, STT wiring, utterance numbering
  ├── DeepgramSTT       Live stream, keepAlive every 8s, UtteranceEnd fallback
  ├── TutorSession      isBusy guard, single pending queue slot
  ├── _runPipeline      try/finally: concurrent TTS connect + LLM stream
  ├── CartesiaTTS       Fire-and-forget WS, token accumulation, single send
  └── streamLLM         Groq streaming, Socratic prompt per concept, 12s timeout
```

---

## Latency Profile (Measured)

| Stage | Typical | Notes |
|-------|---------|-------|
| STT endpointing | 200ms | Min reliable setting; `UtteranceEnd` fallback at 1500ms |
| LLM first token | 261ms avg | Groq llama-3.1-8b-instant |
| TTS first byte | 480–600ms | Cartesia Sonic after LLM completes |
| Total (LLM+TTS) | ~850ms | From speech_final to first avatar audio |
| Simli render lag | ~33ms | One video frame after first PCM chunk |

**Bottleneck:** TTS first byte. Cartesia takes ~250ms after receiving text — LLM must finish first (261ms), so minimum pipeline is ~500ms. Would require speculative TTS pre-generation to go lower.
