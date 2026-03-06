import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DeepgramSTT } from './pipeline/stt.js';
import { TutorSession } from './services/pipeline.js';
import { getReports } from './utils/latency.js';

// Validate required env vars
const required = ['DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/latency', (_req, res) => { res.json(getReports()); });
app.get('/api/health',  (_req, res) => { res.json({ status: 'ok', timestamp: Date.now() }); });

const server = createServer(app);

// WebSocket endpoint for the full STT→LLM→TTS pipeline
const wss = new WebSocketServer({ server, path: '/ws/session' });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const concept = url.searchParams.get('concept') ?? 'fractions';
  console.log(`[WS] Client connected  concept="${concept}"`);

  const session = new TutorSession(ws, concept);
  let interactionCount = 0;

  // ── Deepgram STT — one persistent connection per WebSocket session ──────────
  const stt = new DeepgramSTT({
    onInterim: (text) => {
      ws.send(JSON.stringify({ type: 'transcript', text, is_final: false }));
    },
    onFinal: (text, sttMs) => {
      // Confirm final transcript to client
      ws.send(JSON.stringify({ type: 'transcript', text, is_final: true }));

      interactionCount++;
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

  // ── Receive messages from client ────────────────────────────────────────────
  ws.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'audio_config') {
          console.log('[WS] Audio config:', msg);
          return;
        }
        if (msg.type === 'avatar_rendered') {
          console.log(`[WS] avatar_rendered  id=${msg.interaction_id ?? 'unknown'}`);
          return;
        }
      } catch { /* not JSON */ }
      return;
    }

    // Binary = raw PCM audio — forward to Deepgram.
    // Must use new Uint8Array(data) to get an exact-size copy;
    // data.buffer is the pooled backing ArrayBuffer which is larger than data.
    if (Buffer.isBuffer(data)) {
      stt.sendAudio(new Uint8Array(data).buffer as ArrayBuffer);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    stt.close();
  });
});

const PORT = parseInt(process.env.PORT || '3001');
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket at ws://localhost:${PORT}/ws/session`);
  console.log(`[Server] Latency dashboard at http://localhost:${PORT}/api/latency`);
});
