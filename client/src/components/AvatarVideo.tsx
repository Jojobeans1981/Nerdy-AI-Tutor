import { useRef, useEffect, forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { SimliClient, generateSimliSessionToken, generateIceServers } from 'simli-client';

const SIMLI_API_KEY = import.meta.env.VITE_SIMLI_API_KEY as string;
const SIMLI_FACE_ID = import.meta.env.VITE_SIMLI_FACE_ID as string;

// Pre-fetch session token + ICE servers on module load (before user picks a topic)
// so the avatar connects instantly when the component mounts.
let prefetchedAuth: Promise<{ session_token: string; iceServers: any }> | null = null;

function prefetchSimliAuth() {
  if (prefetchedAuth) return prefetchedAuth;
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) return null;
  prefetchedAuth = Promise.all([
    generateSimliSessionToken({
      config: {
        faceId: SIMLI_FACE_ID,
        handleSilence: true,
        maxSessionLength: 600,
        maxIdleTime: 120,
      },
      apiKey: SIMLI_API_KEY,
    }),
    generateIceServers(SIMLI_API_KEY),
  ]).then(([tokenRes, iceServers]) => ({
    session_token: tokenRes.session_token,
    iceServers,
  }));
  // If prefetch fails, allow retry
  prefetchedAuth.catch(() => { prefetchedAuth = null; });
  return prefetchedAuth;
}

// Start prefetching immediately on module load
prefetchSimliAuth();

export interface AvatarVideoHandle {
  /** Send a base64-encoded PCM 16-bit 16kHz mono audio chunk to Simli */
  sendAudio: (base64Pcm: string) => void;
  /** Timestamp (Date.now()) of when Simli last started rendering video */
  getLastRenderStartMs: () => number;
  /** Measured lip-sync offset samples (audio sent ms vs video frame ms) */
  getLipSyncSamples: () => number[];
  /** Reset render start and lip-sync samples for a new interaction */
  resetForInteraction: () => void;
}

interface Props {
  isActive: boolean;
}

type Status = 'connecting' | 'ready' | 'error';

export const AvatarVideo = forwardRef<AvatarVideoHandle, Props>(({ isActive }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliRef = useRef<SimliClient | null>(null);
  const isReadyRef = useRef(false);
  const lastRenderStartMsRef = useRef(0);
  /** Timestamps of audio chunks sent to Simli (for lip-sync measurement) */
  const audioSentTimesRef = useRef<number[]>([]);
  /** Measured offsets: video_frame_time - audio_sent_time in ms */
  const lipSyncSamplesRef = useRef<number[]>([]);
  // Buffer audio chunks that arrive before Simli's WebRTC is established.
  // Without this queue every chunk sent during the 3-5s handshake is silently
  // dropped, leaving the first response completely silent.
  const pendingAudioRef = useRef<string[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Stable decode-and-send helper (simliRef is a ref so no dep needed)
  const sendPcmToSimli = useCallback((base64Pcm: string) => {
    if (!simliRef.current) return;
    try {
      const binary = atob(base64Pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      simliRef.current.sendAudioData(bytes);
    } catch (err) {
      console.warn('[Simli] sendAudio error:', err);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    sendAudio: (base64Pcm: string) => {
      if (!isReadyRef.current) {
        pendingAudioRef.current.push(base64Pcm);
        return;
      }
      const sentMs = Date.now();
      // Record first audio sent time for render latency measurement
      if (lastRenderStartMsRef.current === 0) {
        lastRenderStartMsRef.current = sentMs;
      }
      // Track audio chunk send time for lip-sync measurement (keep last 20)
      audioSentTimesRef.current.push(sentMs);
      if (audioSentTimesRef.current.length > 20) audioSentTimesRef.current.shift();
      sendPcmToSimli(base64Pcm);
    },
    getLastRenderStartMs: () => lastRenderStartMsRef.current,
    getLipSyncSamples: () => lipSyncSamplesRef.current,
    resetForInteraction: () => {
      lastRenderStartMsRef.current = 0;
      audioSentTimesRef.current = [];
      lipSyncSamplesRef.current = [];
    },
  }), [sendPcmToSimli]);

  useEffect(() => {
    if (!videoRef.current || !audioRef.current) return;

    const videoEl = videoRef.current;
    const audioEl = audioRef.current;
    let client: SimliClient | null = null;
    let cancelled = false;

    const init = async () => {
      if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
        const missing = [!SIMLI_API_KEY && 'VITE_SIMLI_API_KEY', !SIMLI_FACE_ID && 'VITE_SIMLI_FACE_ID'].filter(Boolean).join(', ');
        console.error(`[Simli] Missing env vars: ${missing} — avatar will not connect`);
        setErrorMsg(`Missing env vars: ${missing}`);
        setStatus('error');
        return;
      }
      try {
        // Use prefetched auth (already started on page load) or fetch now
        const authPromise = prefetchSimliAuth();
        if (!authPromise) throw new Error('Simli API key or face ID missing');
        const { session_token, iceServers } = await authPromise;
        // Clear so next mount gets a fresh token
        prefetchedAuth = null;

        if (cancelled) return;

        client = new SimliClient(session_token, videoEl, audioEl, iceServers);
        simliRef.current = client;

        client.on('start', () => {
          console.log('[Simli] Connected — draining', pendingAudioRef.current.length, 'queued chunks');
          isReadyRef.current = true;
          setStatus('ready');
          // Pre-fetch next token so topic changes are instant
          prefetchSimliAuth();

          // Drain any audio that arrived during the WebRTC handshake
          const queued = pendingAudioRef.current.splice(0);
          for (const chunk of queued) sendPcmToSimli(chunk);

          // Measure lip-sync: compare when audio was sent vs when a video frame arrives.
          // requestVideoFrameCallback fires when the browser renders each video frame.
          // We compare the frame's presentationTime to the nearest audio sent time to
          // estimate audio-video sync offset.
          if (typeof (videoEl as any).requestVideoFrameCallback === 'function') {
            const measureFrame = (now: number) => {
              if (!isReadyRef.current) return;
              const sentTimes = audioSentTimesRef.current;
              if (sentTimes.length > 0) {
                // Find the audio chunk closest in time to this frame
                const frameMs = now; // DOMHighResTimeStamp from rAF epoch
                const wallMs = performance.timeOrigin + frameMs;
                const nearest = sentTimes.reduce((a, b) => Math.abs(b - wallMs) < Math.abs(a - wallMs) ? b : a);
                const offset = wallMs - nearest;
                if (Math.abs(offset) < 500) { // ignore outliers > 500ms
                  lipSyncSamplesRef.current.push(Math.round(offset));
                  if (lipSyncSamplesRef.current.length > 30) lipSyncSamplesRef.current.shift();
                }
              }
              (videoEl as any).requestVideoFrameCallback(measureFrame);
            };
            (videoEl as any).requestVideoFrameCallback(measureFrame);
          }
        });

        client.on('stop', () => {
          isReadyRef.current = false;
        });

        client.on('error', (detail) => {
          console.error('[Simli] Error:', detail);
          setErrorMsg(String(detail));
          setStatus('error');
        });

        client.on('startup_error', (msg) => {
          console.error('[Simli] Startup error:', msg);
          setErrorMsg(String(msg));
          setStatus('error');
        });

        await client.start();
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Simli] Init failed:', msg);
          setErrorMsg(msg);
          setStatus('error');
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      client?.stop();
      simliRef.current = null;
      isReadyRef.current = false;
      pendingAudioRef.current = [];
    };
  }, [sendPcmToSimli]);

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid #222',
        background: '#0a0a1a',
        height: 260,
        flexShrink: 0,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      <audio ref={audioRef} autoPlay style={{ display: 'none' }} />

      {status !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0a0a1a',
            gap: 12,
          }}
        >
          {status === 'connecting' ? (
            <>
              <div style={{ fontSize: 40 }}>🎓</div>
              <span style={{ color: '#888', fontSize: 13, fontFamily: 'monospace' }}>
                Connecting to avatar...
              </span>
            </>
          ) : (
            <>
              <div style={{ fontSize: 40 }}>⚠️</div>
              <span style={{ color: '#ef4444', fontSize: 13, fontFamily: 'monospace' }}>
                Avatar connection failed
              </span>
              {errorMsg && (
                <span style={{ color: '#ef4444', fontSize: 11, maxWidth: 320, textAlign: 'center', padding: '0 16px' }}>
                  {errorMsg}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {status === 'ready' && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 10,
            fontSize: 10,
            color: isActive ? '#00d4ff' : '#555',
            fontFamily: 'monospace',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span style={{ color: isActive ? '#22c55e' : '#555' }}>●</span>
          {isActive ? 'Speaking' : 'Listening'}
        </div>
      )}
    </div>
  );
});
