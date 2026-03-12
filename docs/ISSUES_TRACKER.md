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

### ISS-013 — History double-push on ws.send() error in pipeline
**Status:** FIXED
**Symptom:** Conversation history could accumulate duplicate entries (same user+assistant pair pushed twice), causing LLM to see repeated context and respond oddly on subsequent turns.
**Root cause:** `_runPipeline` pushed to `history` in the try block (after LLM completes). If `this.ws.send(response_end)` then threw (client disconnected mid-stream), the catch block also pushed to history — because `llmCompleted=true` was already set but the catch had no guard against duplicate pushes.
**Fix:** Added `historyPushed` boolean flag. Catch block only pushes `if (fullResponse && !historyPushed)`.

---

### ISS-014 — `ws.send()` throws silently crashing Cartesia audio callback
**Status:** FIXED
**Symptom:** If the client WebSocket closed while audio chunks were still arriving from Cartesia, the `onAudioChunk` callback threw `WebSocket is not open`. This error propagated into Cartesia's `message` event handler, potentially breaking the TTS stream cleanup.
**Root cause:** `onAudioChunk`, `onError`, `response_end` send (in catch), and latency send (after finally) all called `this.ws.send()` without guarding against a closed WebSocket.
**Fix:** Wrapped all non-critical `ws.send()` calls in `try { ... } catch { /* WS closed */ }`.

---

### ISS-015 — Second utterance pipeline hang (under investigation — diagnostics added)
**Status:** OPEN (diagnostic logging added; barge-in partially mitigates UX impact)
**Symptom:** After first response completes, second utterance is recognized by STT but no LLM response appears. User sees no second response.
**Likely root cause:** Second utterance arrives while first pipeline is still waiting on `await Promise.race([tts.waitForComplete(), ttsTimeout])` (up to 4 seconds after `response_end`). The second utterance is queued (`isBusy=true`) and eventually processes — but can appear hung if TTS takes the full 4-second timeout.
**Diagnostic added:** `[Pipeline] processUtterance isBusy=<true|false> id=...` log shows exact state when each utterance arrives.
**Partial mitigation (ISS-016):** Barge-in/interrupt feature allows the user to manually abort the current pipeline via the ✋ Interrupt button, causing the queued utterance to process immediately.

---

### ISS-016 — No way to interrupt AI mid-response (barge-in missing)
**Status:** FIXED
**Symptom:** Once the avatar started speaking there was no way to stop it — the user had to wait for the full response before the mic became active again. This violated the "seamless modality switching" requirement.
**Root cause 1 (server):** No abort mechanism in `_runPipeline`. The LLM stream ran to completion regardless of new input. `pendingUtterance` queue meant a new utterance while busy would sit waiting for the current pipeline (LLM + TTS + 4s wait) to finish.
**Root cause 2 (client):** `micMutedRef` was kept `true` from first token until 1.5s after `response_end`. No user-facing action to override this.
**Fix (server):** Added `AbortController` per pipeline run in `TutorSession._runPipeline`. New `interrupt()` method aborts the controller. `streamLLM` accepts an optional `externalSignal` combined with the existing 12s timeout. `tts.abort()` fires in `finally`. Server handles `{ type: 'interrupt' }` WS message → `session.interrupt()`.
**Fix (client):** `handleBargeIn` callback: clears streaming text, resets avatar state, immediately unmutes the mic, sends `{ type: 'interrupt' }` to server. ✋ Interrupt button appears in the controls bar while avatar is speaking.

---

### ISS-017 — No mic mute toggle during an active session
**Status:** FIXED
**Symptom:** Once "Start Session" was clicked, there was no way to silence the microphone without ending the entire session. User had to end and restart to prevent background noise from triggering the pipeline.
**Root cause:** `micMutedRef` (half-duplex gate) was the only mute mechanism, and it was automated — no user-controlled mute.
**Fix:** Added `isMicMuted` React state + `manualMuteRef` (ref stays in sync for the audio callback closure). Audio sending checks both: `!micMutedRef.current && !manualMuteRef.current`. 🎤/🔇 toggle button in controls bar; turns red when muted. State resets on session end.

---

### ISS-018 — Avatar mouth-open artifact at the start of each response
**Status:** FIXED
**Symptom:** At the start of every response, the avatar's mouth would open and begin animating a fraction of a second before any audio was audible. This was the most visually jarring lip-sync artefact.
**Root cause:** Simli begins rendering avatar animation as soon as the first PCM chunk is received, before the audio playback buffer has enough data to start playing. The animation leads the audio by approximately 1 video frame (~33ms) plus audio buffer fill time (~100-150ms).
**Fix:** `generateSilenceBuffer(200ms)` in `tts.ts` prepends 200ms of zero-filled 16-bit PCM to the first audio chunk of every response. The avatar animates "silence" (mouth closed) for 200ms while the audio buffer fills, then opens its mouth in sync with actual speech.

---

### ISS-019 — WebSocket session lost on connection drop — no recovery
**Status:** FIXED
**Symptom:** Any network hiccup (brief WiFi dropout, laptop sleep, server restart) caused a permanent disconnect. The session UI showed no indication and the user had to manually refresh.
**Root cause:** `useWebSocket` hook only called `connect()` on explicit user action. No reconnect logic existed.
**Fix:** On unintentional `ws.onclose`, `scheduleReconnect()` waits 1500ms then calls `connect()` again, up to 5 attempts. `intentionalDisconnectRef` distinguishes user-initiated disconnect from drops. `isReconnecting` state drives an amber "Reconnecting… (N/5)" indicator in the header. After 5 failures a permanent "Connection lost. Please refresh." error is shown. Client-side `messages` state is preserved across reconnects; server-side history resets (new `TutorSession` on reconnect — see LIM-003).

---

### ISS-020 — `webRTCReady` state not tracked; no idle fallback video
**Status:** FIXED
**Symptom:** During the 3-5s Simli pre-warm period the avatar panel was either blank (black) or showed a frozen frame. No visual feedback that the connection was progressing.
**Root cause:** `AvatarVideo` had a `status` string but no explicit `webRTCReady` boolean. The Simli `<video>` element showed nothing useful before the WebRTC stream started.
**Fix 1:** Added explicit `webRTCReady` state (set `true` on Simli `start` event). "Connecting..." overlay now appears as a subtle badge at the bottom of the avatar panel rather than a full-screen block.
**Fix 2:** Added `<video src="/idle-loop.mp4" autoPlay loop muted>` shown whenever `!(webRTCReady && isActive)`. Simli video is shown only while actively speaking. The idle video asset (`/idle-loop.mp4`) must be placed in `client/public/`.
**Fix 3:** `onWebRTCReady` callback prop reports mount-to-ready time in ms to `App.tsx` for display in the latency dashboard.

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
**Partial mitigation:** 200ms silence buffer (ISS-018) eliminated the mouth-open artifact so the perceived lip-sync is correct even if the first-byte latency remains high.

### LIM-002 — STT endpointing at minimum 200ms
Deepgram `endpointing: 200ms` is the lowest reliable setting. Values below 200ms cause false finals on natural speech pauses (mid-sentence breaths). `UtteranceEnd` at 1500ms provides fallback but adds latency in stuck cases.

### LIM-003 — Server-side conversation history not persisted across disconnects
Client-side `messages` state is now preserved across WebSocket auto-reconnects (ISS-019). However, the server-side `TutorSession` (including `history`, `conceptsMastered`, `hintLevel`) resets on reconnect because a new session object is created per WebSocket connection. No database. The student will see their previous chat but the LLM loses its conversational context.

### LIM-004 — Single-session concurrency
One pipeline runs at a time per session (`isBusy` guard). A second utterance received while busy is queued (single slot — newest replaces older). The ✋ Interrupt button (ISS-016) gives the user manual control to abort the current pipeline and unblock the queue immediately.

### LIM-005 — Topics limited to 3
Adding new topics requires: updating `CONCEPT_META` in `llm.ts`, adding to `TopicSelector`, and adding a `VisualAid` diagram. The system prompt is generic enough to handle any topic, but `buildSystemPrompt` only knows three grade/display mappings.

### LIM-006 — Simli WebRTC requires active browser tab
WebRTC streams pause/degrade if the browser tab is backgrounded. Not an issue for normal tutoring use but matters for testing.

### LIM-007 — Idle video asset (`/idle-loop.mp4`) not yet created
The `AvatarVideo` component references `/idle-loop.mp4` in `client/public/`. Until this file exists, the avatar panel will show a blank/broken video element when not speaking. A looping neutral face or animated placeholder should be placed at `client/public/idle-loop.mp4`.

### LIM-008 — TTS cache is pre-computed but never served to the client
`ttsCache.ts` pre-synthesizes 16 common phrases at startup (ISS-004 expansion) but there is no code path that checks the cache before routing a response through `CartesiaTTS`. The cache exists in memory but the lookup function (`getCacheStats`) only reports stats — it does not return audio. A future integration would: detect when a response begins with a cached phrase, immediately stream the cached PCM to the client, then continue with Cartesia for the remainder.

### LIM-009 — `conceptsMastered` and `mistakePatterns` are never populated
`TutorSession` now tracks `hintLevel` and `attemptCountOnCurrentConcept` correctly. However `conceptsMastered` and `mistakePatterns` arrays remain empty for all sessions — they are injected into the LLM prompt as context but there is no code that writes to them. Populating these would require either a secondary LLM extraction call per turn, or explicit LLM-returned structured data (not currently implemented).
