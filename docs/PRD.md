# Product Requirements Document — Nerdy AI Tutor

**Version:** 1.0
**Date:** 2026-03-10
**Status:** Active

---

## 1. Overview

Nerdy AI Tutor is a real-time, voice-first AI tutoring application that teaches middle and high school students using the Socratic method. A student speaks to an animated avatar; the avatar listens, understands, and responds with a guiding question — never the answer — keeping the student doing the thinking. The full speech-in → speech-out loop targets **under 1 second of total latency**.

---

## 2. Problem Statement

One-on-one tutoring is the most effective learning modality but is inaccessible to most students due to cost and availability. Existing AI tutoring tools are text-first, static, and passive — they give answers rather than guide discovery. Students lose engagement when feedback is delayed, impersonal, or text-only.

**Nerdy AI Tutor solves three things:**
1. Makes Socratic tutoring available to any student with a browser and a mic
2. Responds fast enough to feel conversational (< 1 second end-to-end)
3. Presents a real talking face to maintain student engagement

---

## 3. Target Users

| User | Description |
|------|-------------|
| **Primary** | Middle and high school students (grades 6–9) learning math or science |
| **Secondary** | Teachers and parents who want to observe session quality and latency metrics |
| **Tertiary** | Developers evaluating the real-time AI pipeline architecture |

---

## 4. Goals & Success Metrics

### Product Goals
| Goal | Metric | Target |
|------|--------|--------|
| Conversational speed | End-to-end latency (STT → first audio) | < 1,000 ms |
| STT responsiveness | Silence detection (endpointing) | ≤ 300 ms |
| LLM speed | Time to first token | ≤ 400 ms |
| TTS speed | Time to first audio byte | ≤ 300 ms |
| Avatar readiness | Simli WebRTC handshake | ≤ 3,000 ms (pre-warmed on load) |
| Reliability | Sessions without audio failure per 10 interactions | ≥ 9/10 |
| Pedagogy compliance | Responses ending with "?" | ≥ 95% |

### Non-Goals (v1)
- Multi-student or classroom mode
- Teacher-facing dashboards or student accounts
- Content beyond the 3 hardcoded topics
- Mobile-native app (browser only)
- Production deployment / auth layer

---

## 5. Features

### 5.1 Core Features

#### Voice Conversation
- **Microphone capture:** AudioWorklet-based PCM capture at 16 kHz mono, off the main thread
- **Speech-to-text:** Deepgram Nova-2 streaming; provides interim transcripts and final speech_final events
- **Silence detection:** 300 ms endpointing; 1,500 ms UtteranceEnd fallback
- **Noise filter:** Drops speech_final if confidence < 0.65 or fewer than 2 words
- **Text input fallback:** Type a response when voice is unavailable
- **Microphone selector:** Switch between system input devices

#### AI Tutor (LLM)
- **Model:** Groq-hosted `llama-3.1-8b-instant` (fastest available, ~250 ms first token)
- **Pedagogy:** Socratic — never gives the answer; always ends with a question
- **Response constraints:** Maximum 2 sentences, 60 tokens; spoken aloud (no markdown)
- **Session state tracking:**
  - `hintLevel` (0 = question only, 1 = hint, 2 = partial example) escalates per failed attempt
  - `conceptsMastered[]` — tracks confirmed understanding
  - `mistakePatterns[]` — tracks recurring errors
- **Async extraction:** After each response, a second LLM call analyzes the exchange and updates session state non-blocking
- **Frustration detection:** If student says "I don't get it" / "I give up" etc., tutor empathizes first before re-teaching
- **Conversation history:** Full user + assistant turn history passed on each call (no context window loss)
- **Barge-in / interrupt:** Student can speak while AI is talking; pipeline aborts and restarts

#### Text-to-Speech
- **Provider:** Cartesia Sonic WebSocket API (raw PCM, 16-bit, 16 kHz, mono)
- **Sentence streaming:** Sentences ending in `.` or `!` are flushed to Cartesia immediately with `continue=true` while the LLM generates the remainder — cuts first-audio latency by ~300–400 ms
- **Voice selection:** Auto-fetches Cartesia voice list; picks English male; falls back to first public voice
- **Cache:** 8 common affirmation phrases pre-synthesized at startup; cache hits skip Cartesia entirely
- **Concurrency guard:** `await tts.abort()` waits for full TCP close before next connection; `wsClosed` flag prevents 1 s stall

#### Animated Avatar
- **Provider:** Simli WebRTC (`simli-client` 3.0.1)
- **Pre-warming:** Auth token prefetched on page load (avoids 3–5 s handshake on first response)
- **Audio rechunking:** PCM accumulated into exact 6,000-byte Simli frames before delivery
- **Fallback playback:** Web Audio API plays audio if WebRTC is not yet ready
- **Auto-reconnect:** Up to 3 silent retries mid-session with "Reconnecting…" overlay before showing error
- **Lip-sync measurement:** `requestVideoFrameCallback` tracks video frame time vs audio sent time; samples stored for diagnostics

### 5.2 UI / UX

#### Layout
- Two-column dark glassmorphism design
- Left column: avatar video, streaming chat, mic controls, text input
- Right column: latency dashboard, concept visual aid, session stats

#### Status Indicators
| State | Display |
|-------|---------|
| Idle | "Speak now" |
| Listening (voice detected) | "Listening..." (audio level meter) |
| STT finalizing (is_final received, waiting for LLM) | "Processing…" (amber) |
| AI speaking | "Speaking" with pulse animation |
| Reconnecting | "Reconnecting… (N/3)" overlay on avatar |
| Audio failure | Warning banner above controls |

#### Chat Display
- Streaming LLM text with blinking cursor
- Dashed-border interim STT transcript
- Finalized message bubbles (user / assistant)
- Auto-scroll to latest

#### Topics
| Topic | Grade | Accent Color |
|-------|-------|-------------|
| Fractions | 6th | Cyan |
| Cell Biology — Mitosis | 8th | Purple |
| Algebra — Solving for x | 9th | Orange |

#### Visual Aids
- Topic-specific SVG diagrams rendered when a topic is active

### 5.3 Diagnostics & Monitoring

#### Latency Dashboard (live)
| Stage | Target |
|-------|--------|
| STT endpoint | ≤ 300 ms |
| LLM first token | ≤ 400 ms |
| TTS first byte | ≤ 300 ms |
| Avatar render | ≤ 200 ms |
| **Total** | **≤ 1,000 ms** |

- Color-coded: green ≤ target, red > target
- Quality score 0–100 (avg latency of last 10 + reconnect penalty)
- In-memory ring buffer: last 200 interactions

#### Server API Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /api/latency` | Last 200 latency reports |
| `GET /api/health` | Server status |
| `GET /api/cache-stats` | TTS cache hit/miss rate |
| `POST /api/lipsync-report` | Receive lip-sync drift from client |
| `GET /api/lipsync-report` | Historical lip-sync data |

---

## 6. Architecture

### 6.1 Pipeline Overview

```
Microphone
    │ PCM (16kHz mono)
    ▼
DeepgramSTT ──── interim transcripts ──► UI (italic dashed text)
    │ speech_final
    ▼
TutorSession.processUtterance()
    │
    ├──► CartesiaTTS.connect()          [fire-and-forget, WS handshake starts]
    │
    ▼
streamLLM() ──── tokens ──► UI (streaming text)
    │                  │
    │                  └──► CartesiaTTS.sendToken()
    │                            │ sentence boundary flush (continue=true)
    │                            ▼
    │                       Cartesia Sonic WS
    │                            │ PCM chunks
    │                            ▼
    │                  [0x01][raw PCM] ──► client WS
    │                                          │
    │                                          ▼
    │                                   AvatarVideo.sendAudio()
    │                                          │ 6000-byte rechunk
    │                                          ▼
    │                                   Simli WebRTC
    │                                          │
    │                                          ▼
    │                                   Video + Audio output
    │
    └──► extractSessionUpdate() [async, non-blocking]
              ▼
         hintLevel / mastery / mistakes updated
```

### 6.2 Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Frontend | React 19 + TypeScript + Vite | Fast dev, strong typing |
| Backend | Node.js + Express + `ws` | Low-overhead WebSocket server |
| STT | Deepgram Nova-2 | Fastest accuracy/latency ratio |
| LLM | Groq `llama-3.1-8b-instant` | ~250 ms first token (GPU inference) |
| TTS | Cartesia Sonic | Low-latency PCM streaming, voice continuity via context_id |
| Avatar | Simli WebRTC | Photorealistic lip-sync, browser-native delivery |
| Audio capture | Web Audio API AudioWorklet | Off-thread PCM, prevents UI jank |

### 6.3 WebSocket Protocol

**Server → Client (JSON frames):**
| `type` | Payload | Meaning |
|--------|---------|---------|
| `transcript` | `{text, is_final, speech_final}` | STT update |
| `token` | `{text, interaction_id}` | LLM token (streaming) |
| `response_end` | `{interaction_id, error?}` | LLM stream complete |
| `latency` | `{stt_ms, llm_first_token_ms, tts_first_byte_ms, total_ms, ...}` | Per-interaction report |
| `tts_error` | `{error, message}` | Cartesia error |

**Server → Client (binary frames):**
- `[0x01][raw PCM bytes]` — audio chunk (16-bit signed, 16 kHz, mono)

**Client → Server (JSON frames):**
| `type` | Payload | Meaning |
|--------|---------|---------|
| `text_input` | `{text}` | Manual text submission |
| `interrupt` | — | Barge-in: abort current pipeline |
| `avatar_rendered` | `{interaction_id, render_ms}` | Simli video render latency |
| `lip_sync_report` | `{samples[]}` | Lip-sync offset measurements |

**Client → Server (binary frames):**
- Raw PCM audio (16-bit signed, 16 kHz, mono) — forwarded directly to Deepgram

---

## 7. Non-Functional Requirements

| Requirement | Specification |
|-------------|--------------|
| Latency | < 1,000 ms end-to-end (speech → first audio) |
| Concurrency | Single session per server instance (no shared state between sessions) |
| Reliability | Auto-reconnect for STT (500 ms delay) and Simli (up to 3 retries) |
| Security | API keys in `.env` only; never sent to client |
| Browser support | Chrome / Edge (AudioWorklet + WebRTC required) |
| Network | Works on localhost; no CDN or auth layer required for dev |

---

## 8. External Dependencies & API Keys

| Service | Env Var | Free Tier Limits |
|---------|---------|-----------------|
| Deepgram | `DEEPGRAM_API_KEY` | $200 credit on signup |
| Groq | `GROQ_API_KEY` | Free tier, rate limited |
| Cartesia | `CARTESIA_API_KEY` | Free tier: 1 concurrent WebSocket |
| Simli | `VITE_SIMLI_API_KEY` | Free tier available |

**Important:** Cartesia free tier allows only **1 concurrent WebSocket connection**. The pipeline enforces this with `await tts.abort()` before opening the next session.

---

## 9. Known Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| Cartesia free tier: 1 concurrent WS | Must fully close WS before next request | `await tts.abort()` + `wsClosed` guard |
| Simli lip-sync latency | ~150–300 ms video lag behind audio | 80 ms prepended silence buffer |
| STT endpointing at 300 ms | May cut off slow speakers | UtteranceEnd fallback at 1,500 ms |
| Single session per server instance | Cannot handle multiple simultaneous students | Acceptable for prototype |
| No persistent storage | Session data lost on page refresh | Intentional for v1 |

---

## 10. Out of Scope (Future Work)

- User accounts and session history persistence
- More topics / dynamic topic creation
- Teacher dashboard with student progress tracking
- Mobile browser support (Safari AudioWorklet limitations)
- Multi-tenant server deployment
- Adaptive difficulty beyond the 3-level hint system
- Multilingual support
- Accessibility features (screen reader, captions)
