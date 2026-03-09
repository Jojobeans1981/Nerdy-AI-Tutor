# AI Service Cost Log — Nerdy AI Tutor

Tracks real pricing for every AI API used in the pipeline. All figures are as of March 2026.
Per-session estimates assume a typical 10-minute tutoring session with ~20 student exchanges.

---

## Services in the Pipeline

### 1. Deepgram — Speech-to-Text
**Model:** Nova-2 (streaming, `en-US`)
**Pricing:** $0.0059 / minute of audio transcribed (Pay-as-you-go)
**Free tier:** $200 credit on sign-up (~33,000 minutes)

| Metric | Value |
|--------|-------|
| Latency (endpointing) | ~200ms after speech ends |
| Cost per 10-min session | $0.059 |
| Cost per 100 sessions | $5.90 |
| Cost per 1,000 sessions | $59.00 |

**Notes:**
- Billed per minute of *audio sent*, not per transcript character
- Keep-alive pings every 8s do not incur charges (they send empty buffers)
- `utterance_end_ms: 1500` fallback adds at most 1.5s extra billed time per stuck utterance

---

### 2. Groq — LLM Inference
**Model:** `llama-3.1-8b-instant`
**Pricing:** $0.05 / 1M input tokens · $0.08 / 1M output tokens (Pay-as-you-go)
**Free tier:** Generous free tier with rate limits (~6,000 tokens/min, ~14,400 requests/day)

| Metric | Value |
|--------|-------|
| First token latency | ~261ms avg |
| Tokens per response | ~80 output (max_tokens=80) |
| Tokens per session (20 exchanges) | ~6,000 input + ~1,600 output |
| Cost per 10-min session | ~$0.0004 (effectively free) |
| Cost per 1,000 sessions | ~$0.43 |

**Notes:**
- System prompt adds ~500 tokens per request (rebuilt fresh each call with concept+grade)
- Conversation history grows by ~2 messages per exchange; truncation not yet implemented
- At 20 exchanges the history is ~3,000 input tokens per call — still well within free limits

---

### 3. Cartesia — Text-to-Speech
**Model:** `sonic-english`
**Pricing:** $15.00 / 1M characters synthesized
**Free tier:** 10,000 characters/month

| Metric | Value |
|--------|-------|
| First audio latency | ~480–600ms after request |
| Avg response length | ~80 characters |
| Characters per session (20 exchanges) | ~1,600 chars |
| Cost per 10-min session | $0.000024 (2.4 thousandths of a cent) |
| Cost per 1,000 sessions | $0.024 |
| Free tier covers | ~6 full sessions/month |

**Notes:**
- Free tier (10k chars) is exhausted quickly in development — upgrade to pay-as-you-go early
- 429 rate limit errors during startup warm cache; fixed by switching to sequential caching
- Voice `58fbaf73-d7de-4e82-a6b3-118180e7057c` (Janet - Sunny Speaker, female) selected
- TTS cache pre-synthesizes 8 common affirmation phrases at startup — no charge beyond initial warm

---

### 4. Simli — Video Avatar (WebRTC)
**Pricing:** Free tier available; paid plans start at ~$29/month
**Transport:** WebRTC (ICE/STUN), audio sent via WebSocket signaling

| Metric | Value |
|--------|-------|
| WebRTC handshake time | 3–5 seconds (cold) |
| Face ID in use | `tmp9i8bbq7c` (public demo face) |
| Audio format sent | PCM 16-bit, 16kHz, mono, 6000-byte frames |
| Cost per session | Free tier |

**Notes:**
- Simli session token expires after `maxSessionLength: 600s` (10 minutes)
- `maxIdleTime: 120s` — avatar disconnects after 2 minutes of silence
- Token is pre-fetched on page load so avatar connects before topic is selected
- After topic switch the old token is cleared and a new prefetch starts immediately

---

## Total Cost Per Session

| Session Length | Total Cost |
|----------------|-----------|
| 5 minutes / 10 exchanges | ~$0.031 |
| 10 minutes / 20 exchanges | ~$0.059 |
| 30 minutes / 60 exchanges | ~$0.178 |

**Dominant cost: Deepgram STT** (~98% of total spend). LLM and TTS are near-zero.

---

## Monthly Budget Estimates (Development)

| Usage | Deepgram | Groq | Cartesia | Total |
|-------|----------|------|----------|-------|
| 50 sessions/mo (light testing) | $2.95 | $0.02 | $0.00* | ~$2.97 |
| 200 sessions/mo (active dev) | $11.80 | $0.09 | $0.00* | ~$11.89 |
| 1,000 sessions/mo (demo/pilot) | $59.00 | $0.43 | $0.024 | ~$59.45 |

*Cartesia free tier covers light usage; upgrade needed at scale.

---

## Cost Optimization Implemented

1. **TTS startup cache** — 8 common affirmation phrases pre-synthesized at server start. Subsequent uses of these openers skip the Cartesia API call entirely.
2. **max_tokens: 80** — LLM capped at 80 output tokens (short Socratic responses). Keeps token cost low and TTS synthesis time short.
3. **Groq free tier** — At current usage levels, Groq cost is negligible; free tier is sufficient for development and small-scale demos.
4. **Audio rechunking** — Sending 6000-byte frames to Simli (not arbitrary sizes) prevents oversend and reduces wasted bandwidth.
