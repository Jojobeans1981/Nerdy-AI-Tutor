# Nerdy AI Tutor — Demo Walkthrough

---

## What it is (one sentence)

A real-time AI video avatar that teaches students using the Socratic method — asking guiding questions instead of giving answers.

---

## The Pipeline (say this out loud)

```
Student speaks → Deepgram (STT) → Groq LLM → Cartesia (TTS) → Simli Avatar
```

- **Deepgram Nova-2** — transcribes speech in real time (~300ms)
- **Groq / llama-3.1-8b-instant** — generates a Socratic response (~400ms to first token)
- **Cartesia Sonic** — converts text to natural speech (~200ms to first byte)
- **Simli WebRTC** — renders a lip-synced video avatar face

**Total latency target: < 2 seconds from speech to avatar speaking**

---

## Demo Flow

### 1. Open the app
- Avatar face is already loaded (WebRTC pre-warms on page load, not on topic select)
- No waiting — by the time you pick a topic the avatar is ready

### 2. Pick a topic
- **Fractions** (6th grade)
- **Cell Biology — Mitosis** (8th grade)
- **Algebra — Solving for x** (9th grade)

### 3. Click "Start Session"
- Microphone opens, AI is listening

### 4. Speak a student answer
- See interim transcript appear as you talk
- "Processing…" spinner while AI thinks
- Avatar speaks the Socratic response with lip sync

### 5. Show multi-exchange conversation
- Demonstrate 3–4 back-and-forth exchanges
- Point out: AI always ends with a question, never just gives the answer
- Show chat history building up on the left

### 6. Optional features to show
- **Interrupt button** — appears while avatar is speaking, lets student cut in
- **Text input** — type an answer instead of speaking
- **Latency dashboard** (right panel) — live breakdown of each pipeline stage
- **Mute toggle** — student can mute mic

### 7. Switch topics
- Hit "Change Topic" → pick a different subject → full state reset, fresh session

---

## Key Technical Decisions (talk points)

**Why Socratic?**
The LLM system prompt hard-enforces: max 2 sentences, must end with a question, never give the answer directly. Validated on every response.

**Why this stack?**
- Groq: fastest LLM inference available (~400ms), not OpenAI latency
- Cartesia: streaming TTS with sub-200ms first byte
- Simli: only WebRTC avatar SDK that takes raw PCM + runs at 25fps
- Deepgram: Nova-2 has the best accuracy/latency tradeoff for live speech

**Half-duplex mic gate**
Mic is auto-muted while the avatar speaks to prevent TTS echo from being transcribed as student input. Unmutes automatically 1.5s after the last audio chunk.

**Session memory**
After each exchange, a second async LLM call (fire-and-forget) extracts what the student got right/wrong and adjusts hint level for the next question.

**WebRTC pre-warm**
Avatar WebRTC handshake starts on page load — not after topic selection — saving 4–5s on the first response.

---

## Latency Dashboard (right panel)

| Metric | What it measures |
|---|---|
| STT | Speech-to-text: mic open → final transcript |
| LLM | First token from Groq |
| TTS | First audio byte from Cartesia |
| Avatar | Time to first video frame with lip sync |
| Total | End-to-end: speech → avatar speaking |
| Quality | Score 0–100 based on latency + reconnects |

---

## If something goes wrong

| Problem | Fix |
|---|---|
| AI stops responding after N exchanges | Click **Interrupt**, then speak again |
| Mic seems stuck | End Session → Start Session (full reset) |
| Avatar shows "Connecting…" | Wait 5s, it auto-retries; or hit Retry Connection |
| No audio from avatar | Check laptop volume; "No audio" warning banner will appear |
| Text input not working | Click Start Session first — WS must be connected |

---

## What's next (if asked)

- Student progress persistence across sessions
- More topics / curriculum alignment
- Teacher dashboard showing session transcripts and mastery scores
- Mobile / tablet support
- Deployment (currently local dev)
