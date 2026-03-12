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

### Commit 5 — `4848516` · Docs, code cleanup, and stale reference fixes
**What changed:**
- Full doc audit: added `ISSUES_TRACKER.md`, `DEV_LOG.md`, `AI_COST_LOG.md`
- Removed remaining stale ElevenLabs references throughout codebase
- Removed orphaned `prompts.ts`, unused exports
- Minor TypeScript cleanup (`topic ?? ''` in VisualAid)

---

### Commit 6 (current) · Modality switching, latency, UX, and pipeline enhancements

**Barge-in / interrupt (seamless modality switching):**
- Server: `AbortController` per `_runPipeline` run. `TutorSession.interrupt()` aborts the LLM stream mid-generation. `streamLLM` accepts `externalSignal` combined with the 12s timeout. `tts.abort()` in `finally` ensures Cartesia WS always closes.
- Server: `{ type: 'interrupt' }` WS message routes to `session.interrupt()` in `index.ts`.
- Client: `handleBargeIn` callback clears streaming text, resets avatar, unmutes mic, sends interrupt. ✋ Interrupt button appears while avatar is speaking and session is active.

**Mic mute toggle:**
- `isMicMuted` state + `manualMuteRef` (closure-safe ref). Audio sending gated on `!micMutedRef.current && !manualMuteRef.current`. 🎤/🔇 toggle in controls; resets on session end.

**200ms silence buffer (lip-sync artifact fix):**
- `generateSilenceBuffer(200ms)` in `tts.ts` prepends silence to the first chunk of every TTS response. Eliminates avatar mouth-open artifact before audio playback catches up.

**Expanded TTS pre-cache (16 phrases):**
- Added 8 new Socratic opener phrases to `ttsCache.ts` (16 total). Startup log updated to report count.

**Upgraded Socratic system prompt:**
- Replaced rule-based prompt with frustration detection (empathy-first response on "I don't get it" etc.), hint escalation levels (question → hint → partial example), pacing rules, no-repeat-opener rule, and explicit "spoken aloud — no markdown" instruction.

**Session state tracking (hint level + attempt count):**
- `TutorSession` now tracks `hintLevel` (0/1/2), `attemptCountOnCurrentConcept`, `conceptsMastered[]`, `mistakePatterns[]`.
- `attemptCount` increments on each utterance; resets to 0 when LLM response contains affirmation words (regex match). `hintLevel = min(2, attemptCount - 1)`.
- `SessionContext` injected into every `streamLLM` call and appended to the system prompt so LLM adapts scaffolding automatically.

**WebSocket auto-reconnect (5 retries at 1500ms):**
- `useWebSocket` now schedules reconnect on unintentional `onclose`. `intentionalDisconnectRef` distinguishes user disconnects from drops. `isReconnecting` + `reconnectAttempts` exposed from hook.
- Amber "Reconnecting… (N/5)" indicator in header. "Connection lost. Please refresh." after max retries.
- Client-side message history preserved across reconnects; server-side session context resets.

**AvatarVideo pre-warm improvements:**
- Explicit `webRTCReady` boolean state set on Simli `start` event. Logs `[Simli] WebRTC pre-warmed and ready (Xms from mount)`.
- `onWebRTCReady` callback prop reports mount-to-ready timing to `App.tsx`.
- Idle video loop: `<video src="/idle-loop.mp4" autoPlay loop muted>` shown when `!(webRTCReady && isActive)`. Simli video shown only while actively speaking.
- "Connecting..." overlay during pre-warm period is now a subtle bottom badge, not a full-screen block.

**Latency dashboard enhancements:**
- **WebRTC Ready Time** row: ms from mount to Simli connected event.
- **Quality Score (Q: 0–100):** 100 base, −1pt per 100ms over 500ms avg total latency, −5pt per reconnect event. Green ≥80, amber ≥50, red <50.
- Reconnect count shown in interaction footer.

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
  ├── useMicrophone       AudioWorklet off main thread, float32 → int16 PCM, 16kHz
  ├── useWebSocket        Binary (PCM) + JSON routing; auto-reconnect (5 retries)
  ├── AvatarVideo         Simli WebRTC; webRTCReady state; idle-loop.mp4 fallback
  │                       6000-byte PCM rechunker; onWebRTCReady timing callback
  ├── LatencyDashboard    Per-stage latency; WebRTC ready time; quality score 0-100
  └── App                 Session state; half-duplex gate; manual mic mute;
                          handleBargeIn; reconnect indicator

Node.js Server (Express + ws)
  ├── index.ts            WS server; STT wiring; handles interrupt message
  ├── DeepgramSTT         Live stream; keepAlive every 8s; UtteranceEnd fallback
  ├── TutorSession        isBusy guard; single pending queue; AbortController per run
  │                       interrupt(); hintLevel/attemptCount/sessionContext tracking
  ├── _runPipeline        try/finally: concurrent TTS connect + LLM stream
  │                       affirmation detection → hint level reset
  ├── CartesiaTTS         Fire-and-forget WS; 200ms silence buffer on first chunk
  ├── streamLLM           Groq streaming; upgraded Socratic prompt; externalSignal abort
  │                       sessionContext injected (hintLevel, mastered, patterns)
  └── ttsCache.ts         16 phrases pre-synthesized at startup (not yet integrated into pipeline)
```

---

## Latency Profile (Measured)

| Stage | Typical | Budget | Notes |
|-------|---------|--------|-------|
| STT endpointing | 200ms | <300ms | Min reliable; `UtteranceEnd` fallback at 1500ms |
| LLM first token | 261ms avg | <400ms | Groq llama-3.1-8b-instant |
| TTS first byte | 480–600ms | <500ms | Cartesia Sonic; after LLM completes full response |
| 200ms silence buffer | +200ms | n/a | Added intentionally — eliminates mouth-open artifact |
| Total (speech_final → first audio) | ~850ms | <1000ms | From speech_final to first avatar audio |
| Simli render lag | ~33ms | <200ms | One video frame after first PCM chunk |
| WebRTC pre-warm | 3000–5000ms | n/a | Runs on page load, before topic selection |

**Bottleneck:** TTS first byte. LLM must complete in full (~261ms) before Cartesia receives text (~250ms synthesis start) = ~500ms minimum. The additional 200ms silence buffer brings perceived first audio to ~700ms but eliminates the mouth-open artifact.
**Quality score formula:** `100 - floor(max(0, avg_total_ms - 500) / 100) - (reconnect_count × 5)`, clamped 0–100.
