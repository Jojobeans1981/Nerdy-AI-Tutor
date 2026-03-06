import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { TutorSession } from './services/pipeline.js';
import { getReports } from './utils/latency.js';

// Validate env
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

// Latency dashboard endpoint
app.get('/api/latency', (_req, res) => {
  res.json(getReports());
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] Client connected');
  const session = new TutorSession(ws);
  let interactionCount = 0;

  // Open a persistent Deepgram live connection for this session
  const dgLive = deepgram.listen.live({
    model: 'nova-2',
    language: 'en-US',
    smart_format: true,
    interim_results: true,
    endpointing: 300,       // trigger speech_final after 300ms silence
    utterance_end_ms: 1200,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
  });

  let sttStartTime = 0;

  dgLive.on(LiveTranscriptionEvents.Open, () => {
    console.log('[Deepgram] Connection opened');
  });

  dgLive.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    const isFinal = data.is_final;
    // speech_final = true only once per utterance (requires endpointing to be set).
    // is_final = true fires per-segment and can fire many times per utterance.
    const speechFinal = data.speech_final ?? false;

    // Send interim transcripts to client for display
    ws.send(JSON.stringify({
      type: 'transcript',
      text: transcript,
      is_final: speechFinal,
    }));

    // Only trigger the pipeline at true utterance end (speech_final), not per-segment
    if (speechFinal && transcript.trim()) {
      interactionCount++;
      const interactionId = `int_${Date.now()}_${interactionCount}`;
      console.log(`[STT] Final: "${transcript}" (${interactionId})`);

      // Fire the streaming pipeline — don't block the STT connection
      session.processUtterance(transcript, interactionId).catch((err) => {
        console.error('[Pipeline] Error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Pipeline error' }));
      });
    }
  });

  dgLive.on(LiveTranscriptionEvents.Error, (err: any) => {
    console.error('[Deepgram] Error:', err);
  });

  dgLive.on(LiveTranscriptionEvents.Close, () => {
    console.log('[Deepgram] Connection closed');
  });

  // Receive audio data from client and forward to Deepgram
  ws.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'audio_config') {
          console.log('[WS] Audio config received:', msg);
          return;
        }
        if (msg.type === 'avatar_rendered') {
          // Client signals avatar rendered — for latency tracking
          return;
        }
      } catch {
        // Not JSON, treat as binary
      }
    }

    // Forward raw audio bytes to Deepgram
    if (Buffer.isBuffer(data)) {
      if (dgLive.getReadyState() === 1) {
        dgLive.send(new Uint8Array(data).buffer as ArrayBuffer);
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    dgLive.requestClose();
  });
});

const PORT = parseInt(process.env.PORT || '3001');
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket at ws://localhost:${PORT}/ws`);
  console.log(`[Server] Latency dashboard at http://localhost:${PORT}/api/latency`);
});
