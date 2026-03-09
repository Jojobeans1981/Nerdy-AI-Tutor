# Issues Tracker — Nerdy AI Tutor

Log of bugs found, root causes, and fixes applied. Status: OPEN / FIXED / KNOWN LIMITATION.

---

## Fixed Issues

### ISS-001 — Simli `INVALID_API_KEY` on avatar connect
**Status:** FIXED
**Symptom:** Avatar showed "Avatar connection failed" with `{"detail":"INVALID_API_KEY"}` immediately on connect.
**Root cause:** `client/.env` had the Cartesia API key set as `VITE_SIMLI_API_KEY` instead of the actual Simli key. The face ID was also incorrect.
**Fix:** Corrected `client/.env` with proper `VITE_SIMLI_API_KEY=odgaldbjp84y1zyuzy66q` and `VITE_SIMLI_FACE_ID=tmp9i8bbq7c`.

---

### ISS-002 — TTS cache 429 / 500 errors at startup
**Status:** FIXED
**Symptom:** Server logs showed `[TTS Cache] Failed to cache "..." 429` for most or all phrases during warm-up. Zero phrases cached.
**Root cause 1 (429):** `warmTtsCache()` used `Promise.allSettled()` — all 8 phrases requested concurrently, hitting Cartesia rate limits.
**Root cause 2 (500):** `CARTESIA_VOICE_ID` in root `.env` had a trailing `_voice_id` suffix making it invalid.
**Fix:** Switched from concurrent `Promise.allSettled` to sequential `for...of` loop with `await`. Corrected voice ID.

---

### ISS-003 — Deepgram connection closing after first question
**Status:** FIXED
**Symptom:** `[STT] Deepgram connection closed (code=...)` after the first response, then no transcripts received.
**Root cause:** No `reconnecting` guard — the `Close` event handler triggered multiple simultaneous reconnect `setTimeout` calls, causing a reconnect storm.
**Fix:** Added `reconnecting` flag (set `true` before `setTimeout`, cleared on `connect()`). Added close code logging for diagnostics. Also null-out `this.live` immediately in Close handler to prevent stale reference.

---

### ISS-004 — STT "stuck listening" — utterance never finalized
**Status:** FIXED
**Symptom:** The mic stayed in listening state indefinitely. Deepgram received audio but `speech_final` never fired (background noise, AC hum keeping VAD active).
**Root cause:** `endpointing: 200ms` requires a clean silence window. Continuous ambient noise prevents this from ever triggering.
**Fix 1:** Enabled `noiseSuppression: { ideal: true }` on mic constraints — browser filters noise before sending to Deepgram.
**Fix 2:** Added `UtteranceEnd` event handler as fallback: fires 1500ms after the last recognized word, even without silence. Uses `pendingFinalText` to track the last `is_final` transcript for use in the fallback.

---

### ISS-005 — Cartesia WS closing unexpectedly after first response
**Status:** FIXED
**Symptom:** `[TTS] Cartesia WS closed unexpectedly code=1006` on the second request. Second response had no audio.
**Root cause:** The `tts.waitForComplete().catch(() => {})` fire-and-forget after the first pipeline left the Cartesia WebSocket open indefinitely. Cartesia's free tier rejects new connections if a prior WS is still open. The second request got an ECONNREFUSED equivalent at the WS level.
**Fix:** Replaced fire-and-forget with `await Promise.race([tts.waitForComplete(), ttsTimeout])` followed by `tts.abort()` in all cases. The 4s timeout ensures cleanup even if `done` never arrives.

---

### ISS-006 — Pipeline stuck on "Speaking" — LLM timeout not cleaned up
**Status:** FIXED
**Symptom:** After ~12 seconds of no response, the pipeline appeared to reset (watchdog fired) but subsequent requests also failed silently — no audio, no response.
**Root cause:** `AbortSignal.timeout(12000)` caused `streamLLM` to throw `AbortError`. The error propagated through `_runPipeline` (no local try/catch). `processUtterance`'s `finally` block reset `isBusy = false`, but `tts.abort()` was never reached (it was at the bottom of `_runPipeline` after the await). The Cartesia WS stayed open, blocking the next request.
**Fix:** Wrapped the entire LLM+TTS streaming block in `try/catch/finally`. `finally` always calls `tts.abort()`. `catch` sends `response_end` to client (so UI unfreezes) and saves any partial response to conversation history.

---

### ISS-007 — Avatar shows "Speaking" for ~8 seconds after response ends
**Status:** FIXED
**Symptom:** After the tutor finished speaking, the avatar stayed on "Speaking" indicator for 8+ seconds before switching to "Listening". Users waited for this before speaking again.
**Root cause:** `response_end` is sent when the LLM finishes, but Cartesia audio chunks continue streaming for 1-2 seconds afterward (already in-flight). Each arriving audio chunk called `setIsAvatarActive(true)` and reset the 8-second watchdog timer. The 1-second shutdown scheduled by `response_end` was immediately overridden.
**Fix:** Added `responseEndedRef` boolean flag. Set to `true` on `response_end`, reset to `false` on first `token` of next response. Audio chunks check this flag before resetting the watchdog — they still forward audio to Simli but don't extend the Speaking state.

---

### ISS-008 — Avatar load time 3-5 seconds after topic selection
**Status:** FIXED (mitigated)
**Symptom:** After clicking a topic, user waited 3-5 seconds on "Connecting to avatar..." before the session could begin.
**Root cause:** `AvatarVideo` was conditionally rendered only when `topic` was set. Simli's auth was prefetched on page load, but the WebRTC handshake (3-5s) started only after topic selection.
**Fix:** Session layout (including `AvatarVideo`) is always mounted, using CSS `display: none` while no topic is selected. The Simli WebRTC handshake now runs in the background during the landing page view. By the time the user selects a topic, the avatar is often already connected or nearly done.
**Remaining:** If user selects a topic within ~2s of page load, some wait is still visible.

---

### ISS-009 — Lip sync quality poor / avatar mouth movement irregular
**Status:** FIXED
**Symptom:** Avatar mouth movements were visibly out of sync with audio, often animating in bursts.
**Root cause 1:** `sendAudioData` vs `sendAudioDataImmediate` — using the wrong variant. Initially switched to `sendAudioDataImmediate` which bypasses Simli's jitter buffer, causing audio gaps when network delivery was uneven.
**Root cause 2:** Cartesia sends PCM in arbitrary chunk sizes. Simli's internal AudioProcessor batches at 3000 Int16 samples (6000 bytes). Sending chunks of non-matching sizes caused the animation to trigger on irregular boundaries.
**Fix:** Added client-side rechunk buffer accumulating bytes into exact 6000-byte frames. Reverted to `sendAudioData` (not Immediate) to preserve Simli's jitter buffer for smooth playback. `flushAudio()` called at `response_end` to zero-pad and send the final partial frame so the last syllables animate correctly.

---

### ISS-010 — `INVALID_FACE_ID` — Simli face removed from public library
**Status:** FIXED
**Symptom:** `{"detail":"INVALID_FACE_ID"}` on avatar connect.
**Root cause:** The original face ID `dd10cb5a-d31d-4f12-b69f-6db3383c006e` was removed from Simli's public face library.
**Fix:** Queried Cartesia API (confirmed working), then found a valid public Simli face via direct API test. Updated to `tmp9i8bbq7c`.

---

### ISS-011 — Stale ElevenLabs references throughout codebase
**Status:** FIXED
**Symptom:** Code comments and log tags referenced "ElevenLabs" despite the project using Cartesia.
**Root cause:** ElevenLabs was the original TTS provider during early development. When migrated to Cartesia, comments were not fully updated.
**Locations fixed:**
- `pipeline.ts` comment: "buffered inside ElevenLabsTTS" → "accumulated locally"
- `App.tsx` console.error: `[ElevenLabs]` → `[Cartesia]`
**Also removed:**
- Orphaned `server/src/utils/prompts.ts` (static system prompt file superseded by dynamic `buildSystemPrompt()` in `llm.ts`)
- Unused `SOCRATIC_TEST_SCENARIOS` export in `llm.ts`
- Unused `getCachedOpener()` export in `ttsCache.ts`

---

## Open Issues

### ISS-012 — Simli free tier credits exhausted
**Status:** OPEN
**Symptom:** `{"detail":"Free credits ran out, upgrade plan on https://app.simli.com"}` on avatar connect.
**Root cause:** Simli free tier has a limited monthly credit allocation that was consumed during development/testing.
**Action required:** Upgrade Simli plan at https://app.simli.com or investigate self-hosted alternatives.

---

## Known Limitations (Not Bugs)

### LIM-001 — TTS first byte at ~500ms (above <300ms target)
The TTS first byte is bounded by: LLM must complete (~261ms avg) + Cartesia synthesis start (~250ms). Minimum achievable is ~500ms without speculative pre-generation. Cartesia has no "early send" mode that reliably helps within our response length.

### LIM-002 — STT endpointing at minimum 200ms
Deepgram `endpointing: 200ms` is the lowest reliable setting. Values below 200ms cause false finals on natural speech pauses (mid-sentence breaths). `UtteranceEnd` at 1500ms provides fallback but adds latency in stuck cases.

### LIM-003 — Conversation history not persisted
History resets on WebSocket disconnect (topic change, page refresh). No database. Each new session starts fresh.

### LIM-004 — Single-session concurrency
One pipeline runs at a time per session (`isBusy` guard). A second utterance received while busy is queued (newest replaces any prior queued utterance). No per-server concurrency limit across multiple users.

### LIM-005 — Topics limited to 3
Adding new topics requires: updating `CONCEPT_META` in `llm.ts`, adding to `TopicSelector`, and adding a `VisualAid` diagram. The system prompt is generic enough to handle any topic, but `buildSystemPrompt` only knows three grade/display mappings.

### LIM-006 — Simli WebRTC requires active browser tab
WebRTC streams pause/degrade if the browser tab is backgrounded. Not an issue for normal tutoring use but matters for testing.
