import dotenv from 'dotenv';
import { resolve, dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DeepgramSTT } from './pipeline/stt.js';
import { TutorSession, getCacheHitStats } from './services/pipeline.js';
import { getReports } from './utils/latency.js';
import { preloadVoice } from './pipeline/tts.js';
import { getCacheStats } from './utils/ttsCache.js';

// Validate required env vars
const required = ['DEEPGRAM_API_KEY', 'GROQ_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Per-frame lip-sync drift reports from AvatarVideo (kept in-memory, last 100)
const lipsyncReports: { driftMs: number; sessionId?: string; timestamp: number }[] = [];

app.get('/api/latency',     (_req, res) => { res.json(getReports()); });
app.get('/api/health',     (_req, res) => { res.json({ status: 'ok', timestamp: Date.now() }); });
app.get('/api/cache',      (_req, res) => { res.json(getCacheStats()); });
app.get('/api/cache-stats', (_req, res) => { res.json(getCacheHitStats()); });

app.post('/api/lipsync-report', (req, res) => {
  const { driftMs, sessionId, timestamp } = req.body;
  if (typeof driftMs === 'number') {
    lipsyncReports.push({ driftMs, sessionId, timestamp: timestamp ?? Date.now() });
    if (lipsyncReports.length > 100) lipsyncReports.shift();
  }
  res.json({ ok: true });
});

app.get('/api/lipsync-report', (_req, res) => { res.json(lipsyncReports); });

// Serve built React client in production (Render deployment)
const clientDist = join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
  console.log('[Server] Serving static client from', clientDist);
}

const server = createServer(app);

// WebSocket endpoint for the full STT→LLM→TTS pipeline
const wss = new WebSocketServer({ server, path: '/ws/session' });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const concept = url.searchParams.get('concept') ?? 'fractions';
  console.log(`[WS] Client connected  concept="${concept}"`);

  const session = new TutorSession(ws, concept);
  let interactionCount = 0;
  let audioFlowing = false;

  // ── Deepgram STT — one persistent connection per WebSocket session ──────────
  // stt is created below; wire pipeline→STT keepAlive after both exist
  const stt = new DeepgramSTT({
    onInterim: (text) => {
      ws.send(JSON.stringify({ type: 'transcript', text, is_final: false }));
    },
    onIsFinal: (text) => {
      // Start answer verification early — runs during the 250ms endpointing silence
      // window so the result is ready before _runPipeline needs it.
      session.prefetchVerify(text);
    },
    onFinal: (text, sttMs) => {
      // Confirm final transcript to client
      ws.send(JSON.stringify({ type: 'transcript', text, is_final: true }));

      interactionCount++;
      audioFlowing = false; // reset so we can detect when audio resumes after this pipeline
      const interactionId = `int_${Date.now()}_${interactionCount}`;
      console.log(`[STT] Utterance #${interactionCount}: "${text}"  stt_ms=${sttMs}`);

      // Fire pipeline — non-blocking, passes true sttMs for latency tracking
      session.processUtterance(text, interactionId, sttMs).catch((err) => {
        console.error('[Pipeline] Error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Pipeline error' }));
      });
    },
    onError: (err) => {
      console.error('[STT] Deepgram error:', err);
    },
  });

  stt.connect();

  // Wire pipeline → STT keepAlive: when pipeline starts, activate keepAlive immediately
  session.onPipelineStart = () => stt.onPipelineStart();

  // ── Receive messages from client ────────────────────────────────────────────
  ws.on('message', (data: Buffer | string) => {
    try {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'audio_config') {
            console.log('[WS] Audio config:', msg);
            return;
          }
          if (msg.type === 'text_input') {
            const text = (typeof msg.text === 'string' ? msg.text : '').trim();
            if (!text) return;
            interactionCount++;
            const interactionId = `int_${Date.now()}_${interactionCount}`;
            // Confirm as final transcript so client shows the message
            ws.send(JSON.stringify({ type: 'transcript', text, is_final: true }));
            console.log(`[Text] Input #${interactionCount}: "${text}"`);
            session.processUtterance(text, interactionId, 0).catch((err) => {
              console.error('[Pipeline] Error:', err);
              ws.send(JSON.stringify({ type: 'error', message: 'Pipeline error' }));
            });
            return;
          }
          if (msg.type === 'interrupt') {
            session.interrupt();
            return;
          }
          if (msg.type === 'avatar_rendered') {
            const renderMs = typeof msg.render_ms === 'number' ? msg.render_ms : -1;
            console.log(`[WS] avatar_rendered  id=${msg.interaction_id ?? 'unknown'}  render_ms=${renderMs}`);
            session.reportAvatarRender(msg.interaction_id, renderMs);
            return;
          }
          if (msg.type === 'lip_sync_report') {
            console.log(
              `[LipSync] id=${msg.interaction_id}  avg=${msg.avg_offset_ms}ms  max=${msg.max_offset_ms}ms  ` +
              `within_45ms=${Math.round((msg.within_45ms ?? 0) * 100)}%  within_80ms=${Math.round((msg.within_80ms ?? 0) * 100)}%  ` +
              `samples=${msg.sample_count}`,
            );
            return;
          }
        } catch { /* not JSON */ }
        return;
      }

      // Binary = raw PCM audio — forward to Deepgram.
      // Must use new Uint8Array(data) to get an exact-size copy;
      // data.buffer is the pooled backing ArrayBuffer which is larger than data.
      if (Buffer.isBuffer(data)) {
        // Log first audio chunk after each silence gap to confirm audio path is live
        if (!audioFlowing) {
          audioFlowing = true;
          console.log(`[WS] Audio flowing again (${data.length} bytes)`);
        }
        stt.sendAudio(new Uint8Array(data).buffer as ArrayBuffer);
      }
    } catch (err) {
      console.error('[WS Server] Unhandled error in message handler:', err);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[WS Server] Client disconnected — code: ${code}  reason: "${reason.toString()}"`);
    stt.close();
  });

  ws.on('error', (err: Error) => {
    console.error('[WS Server] WebSocket error:', err);
  });
});

const PORT = parseInt(process.env.PORT || '3001');

// Preload TTS voice (Edge TTS — no API key needed), then start server
preloadVoice().then(async () => {
  // TTS cache disabled — was Cartesia-specific, Edge TTS doesn't need it
  server.listen(PORT, () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket at ws://localhost:${PORT}/ws/session`);
    console.log(`[Server] Latency dashboard at http://localhost:${PORT}/api/latency`);
    console.log(`[Server] Cache stats at http://localhost:${PORT}/api/cache`);
  });
}).catch((err) => {
  console.error('[Server] Failed to initialize TTS:', err.message);
  process.exit(1);
});
