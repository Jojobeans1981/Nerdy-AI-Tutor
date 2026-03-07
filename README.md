# Nerdy AI Tutor

A real-time AI video avatar tutor that uses the Socratic method to teach students through conversation — not lectures. The student speaks, the AI responds with guiding questions through a lip-synced video avatar, achieving sub-500ms end-to-end latency.

## Pipeline

```
Mic (PCM 16kHz) → Deepgram STT → Groq LLM → Cartesia TTS → Simli Avatar
```

All stages stream concurrently. The TTS WebSocket connects in parallel with the LLM call, eliminating cold-start latency.

## Latency Results

| Stage | Measured | Budget |
|-------|----------|--------|
| STT (endpointing) | ~200ms | <300ms |
| LLM first token | ~261ms avg | <400ms |
| TTS first byte | ~580ms | <300ms |
| Total end-to-end | **387ms avg** | <1000ms |

## Prerequisites

- Node.js 18+
- API keys for: Deepgram, Groq, Cartesia, Simli

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Jojobeans1981/Nerdy-AI-Tutor
cd Nerdy-AI-Tutor

# Install server deps
cd server && npm install && cd ..

# Install client deps
cd client && npm install && cd ..
```

### 2. Configure environment

Create `.env` in the project root:

```env
DEEPGRAM_API_KEY=your_deepgram_key
GROQ_API_KEY=your_groq_key
CARTESIA_API_KEY=your_cartesia_key
CARTESIA_VOICE_ID=your_cartesia_voice_id
SIMLI_API_KEY=your_simli_key
SIMLI_FACE_ID=your_simli_face_id
PORT=3001
```

Create `client/.env`:

```env
VITE_SIMLI_API_KEY=your_simli_key
VITE_SIMLI_FACE_ID=your_simli_face_id
```

> Note: Vite strips any env var without the `VITE_` prefix from the browser bundle, so Simli keys must be duplicated with the prefix.

### 3. Start

**Terminal 1 — Server:**
```bash
cd server && npm run dev
```

**Terminal 2 — Client:**
```bash
cd client && npm run dev
```

Open http://localhost:5173

## One-Command Start

**Unix/macOS:**
```bash
bash start.sh
```

**Windows:**
```bat
start.bat
```

Both scripts launch server + client in parallel and print the URLs. Open http://localhost:5173 in your browser.

## Usage

1. Open the app in your browser
2. Select a topic: **Fractions** (6th grade), **Cell Biology — Mitosis** (8th grade), or **Algebra** (9th grade)
3. Click **Start Session** — this connects the WebSocket and starts the mic
4. Speak your question or answer
5. The AI avatar responds with a Socratic guiding question
6. Monitor per-stage latency in the dashboard (top right)

## Architecture

```
client/
  src/
    App.tsx                    Main layout, WebSocket client, session state
    hooks/
      useMicrophone.ts         AudioWorklet mic capture, PCM downsampling to 16kHz
      useWebSocket.ts          WebSocket lifecycle and message routing
    components/
      AvatarVideo.tsx          Simli WebRTC avatar, imperative audio feed, pending queue
      ChatDisplay.tsx          Streaming chat bubbles with live cursor
      TopicSelector.tsx        Topic cards with per-topic accent colors
      LatencyDashboard.tsx     Per-stage latency table with color-coded status
      MicSelector.tsx          Mic device picker

server/
  src/
    index.ts                   Express + WebSocket server, STT wiring
    services/
      pipeline.ts              TutorSession: orchestrates LLM + TTS per utterance
    pipeline/
      llm.ts                   Groq streaming, Socratic system prompt, conversation history
      tts.ts                   CartesiaTTS: fire-and-forget WS, single-request send
      stt.ts                   DeepgramSTT: live connection, endpointing latency measurement
    utils/
      latency.ts               LatencyTracker, in-memory ring buffer of reports
      prompts.ts               Socratic system prompt with grade-level examples
```

## Key Technical Decisions

### Why Cartesia over ElevenLabs?
ElevenLabs has a ~400ms synthesis floor before first audio. Cartesia Sonic delivers first audio in ~100ms after receiving text. At our response lengths (~80 chars), Cartesia's total synthesis time is also lower.

### Why single TTS request instead of streaming input?
Cartesia's `continue: true` streaming context mode buffers text server-side and delays synthesis until `continue: false` arrives — effectively the same as sending everything at once but with extra round-trips. Sending one complete request when the LLM finishes is faster in practice.

### Why fire-and-forget TTS connect?
The Cartesia WebSocket handshake takes ~50ms. By calling `tts.connect()` at pipeline start (concurrent with the Groq API call), the connection is ready before the LLM finishes, eliminating cold-start cost.

### Why release `isBusy` at LLM completion not audio completion?
`response_end` fires when text is complete (LLM done), not when audio finishes playing. The perceived response latency is text-complete → speech-starts, which is ~580ms. Waiting for audio completion would add ~2-3s before the student can speak again.

### Why Deepgram over Whisper?
Whisper (API) has 1-2s latency per utterance. Deepgram Nova-2 with streaming delivers speech_final in ~200ms after the student stops speaking (endpointing: 200ms setting), making it the lowest-latency production STT option.

### Why Groq with llama-3.1-8b-instant?
Groq's hardware delivers ~250ms first-token latency on llama-3.1-8b-instant, which is the fastest available option for production streaming inference. Larger models (GPT-4o, Claude) would add 200-400ms with no meaningful quality gain for short Socratic responses.

### Why AudioWorklet for mic capture?
AudioWorklet runs off the main thread, preventing UI jank from interfering with audio capture. It also handles PCM downsampling to 16kHz (Deepgram requirement) without blocking React renders.

## Latency Benchmarking

The server exposes a latency API at `http://localhost:3001/api/latency` returning per-stage measurements for all recent interactions:

```json
[
  {
    "interaction_id": "int_1234567890_1",
    "stt_ms": 203,
    "llm_first_token_ms": 287,
    "tts_first_byte_ms": 541,
    "avatar_render_ms": 45,
    "total_ms": 412,
    "timestamp": 1234567890000
  }
]
```

Run the benchmark script to collect and analyze results:

```bash
node server/scripts/benchmark.js
```

## Concepts Taught

| Topic | Grade | Approach |
|-------|-------|----------|
| Fractions | 6th | Pizza/pie analogies, denominator discovery |
| Cell Biology — Mitosis | 8th | Cell division, phase sequence guided by questions |
| Algebra — Solving for x | 9th | Equation balancing, substitution verification |

## Limitations

- **Lip-sync latency**: Simli's WebRTC handshake takes 3-5 seconds on first connection. Audio queues during this window; the first response may have slight sync offset until the WebRTC connection stabilizes.
- **TTS first byte at ~580ms**: Above the <300ms target. This is bounded by LLM time (~261ms) + Cartesia synthesis start (~280ms). Further reduction would require speculative pre-generation or a faster LLM.
- **STT endpointing at 200ms**: Deepgram waits 200ms of silence before firing `speech_final`. This is the minimum reliable setting; lower values cause false finals on natural speech pauses.
- **Single-session concurrency**: The `isBusy` guard prevents overlapping pipeline runs per session but does not limit concurrent sessions server-wide.
- **No persistent history**: Conversation history resets on WebSocket reconnect. No database-backed session persistence.
- **Topics limited to 3**: Fractions, Mitosis, Algebra. Adding new topics requires prompt engineering and testing.
- **English only**: Deepgram is configured for `en-US`. Cartesia voice is English-only.

## API Keys Required

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| [Deepgram](https://deepgram.com) | Speech-to-text | $200 credit |
| [Groq](https://groq.com) | LLM inference | Free tier available |
| [Cartesia](https://cartesia.ai) | Text-to-speech | Free tier available |
| [Simli](https://simli.com) | Video avatar | Free tier available |
