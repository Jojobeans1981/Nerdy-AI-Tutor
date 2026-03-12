import { useRef, useEffect, forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { SimliClient, generateSimliSessionToken } from 'simli-client';

const SIMLI_API_KEY = import.meta.env.VITE_SIMLI_API_KEY as string;
const SIMLI_FACE_ID = import.meta.env.VITE_SIMLI_FACE_ID as string;

// Pre-fetch session token on module load so the avatar connects instantly (LiveKit transport).
let prefetchedAuth: Promise<{ session_token: string }> | null = null;

function prefetchSimliAuth() {
  if (prefetchedAuth) return prefetchedAuth;
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) return null;
  prefetchedAuth = generateSimliSessionToken({
    config: {
      faceId: SIMLI_FACE_ID,
      handleSilence: true,
      maxSessionLength: 600,
      maxIdleTime: 120,
    },
    apiKey: SIMLI_API_KEY,
  }).then((tokenRes) => ({ session_token: tokenRes.session_token }));
  // If prefetch fails, allow retry
  prefetchedAuth.catch(() => { prefetchedAuth = null; });
  return prefetchedAuth;
}

// Start prefetching immediately on module load
prefetchSimliAuth();

export interface AvatarVideoHandle {
  /** Send raw PCM bytes (16-bit signed, 16kHz, mono) to Simli */
  sendAudio: (pcm: Uint8Array) => void;
  /** Flush any remaining bytes in the rechunk buffer (zero-pad to 6000 bytes) */
  flushAudio: () => void;
  /** Timestamp (Date.now()) of when Simli last started rendering video */
  getLastRenderStartMs: () => number;
  /** Measured lip-sync offset samples (audio sent ms vs video frame ms) */
  getLipSyncSamples: () => number[];
  /**
   * Reset timing/lip-sync stats for the next interaction WITHOUT touching the
   * rechunk buffer. Safe to call at response_end while audio is still in-flight.
   */
  resetStats: () => void;
  /**
   * Full reset including the rechunk buffer. Only call after audio has fully
   * drained (e.g. in the speaking timeout after flushAudio).
   */
  resetForInteraction: () => void;
  /**
   * Call after a user gesture to satisfy the browser autoplay policy.
   * Simli connects before any interaction (pre-warm), so the audio element
   * needs an explicit .play() call triggered by the first user click.
   */
  unlockAudio: () => void;
}

interface Props {
  isActive: boolean;
  /** Called once when Simli WebRTC handshake completes; receives ms from mount to ready */
  onWebRTCReady?: (ms: number) => void;
}

type Status = 'connecting' | 'ready' | 'error';
type FailedStep = 'env' | 'auth' | 'webrtc' | null;

function diagnose(raw: string, step: FailedStep): string {
  const s = raw.toLowerCase();
  if (step === 'env') return `Missing environment variable — add it to client/.env and restart the dev server.`;
  if (step === 'auth') {
    if (s.includes('401') || s.includes('403') || s.includes('unauthorized') || s.includes('forbidden'))
      return 'Simli API key rejected (401/403). Verify VITE_SIMLI_API_KEY in client/.env.';
    if (s.includes('404') || s.includes('not found'))
      return 'Face ID not found (404). Verify VITE_SIMLI_FACE_ID in client/.env.';
    if (s.includes('fetch') || s.includes('network') || s.includes('failed to fetch'))
      return 'Could not reach Simli servers — check your internet connection.';
    return 'Session token request failed — check your Simli API key and face ID.';
  }
  if (step === 'webrtc') {
    if (s.includes('too many retry') || s.includes('retry attempts'))
      return 'WebRTC ICE negotiation failed after all retry attempts. This is usually a transient network issue — click Retry.';
    if (s.includes('ice'))
      return 'WebRTC ICE connection failed — STUN/TURN servers could not establish a path.';
    return 'WebRTC startup failed. Click Retry to try again with fresh credentials.';
  }
  return raw;
}

export const AvatarVideo = forwardRef<AvatarVideoHandle, Props>(({ isActive, onWebRTCReady }, ref) => {
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
  const pendingAudioRef = useRef<Uint8Array[]>([]);
  // Rechunk buffer: accumulate bytes until we have a full 6000-byte frame
  const audioRechunkBufRef = useRef<Uint8Array>(new Uint8Array(0));
  const SIMLI_CHUNK_BYTES = 6000;
  const [status, setStatus] = useState<Status>('connecting');
  // FIX 1: explicit webRTCReady boolean for pre-warm tracking
  const [webRTCReady, setWebRTCReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failedStep, setFailedStep] = useState<FailedStep>(null);
  const [connectStep, setConnectStep] = useState<string>('Initializing…');
  // FIX 1: track mount time so we can report how long the pre-warm took
  const mountTimeRef = useRef(Date.now());
  // Throttle drift POSTs to once per second
  const lastDriftReportRef = useRef(0);
  // Retry trigger: increment to re-run the Simli init effect with fresh credentials
  const [retryTrigger, setRetryTrigger] = useState(0);
  // Auto-retry counter for mid-session drops (resets on successful 'start')
  const autoRetryCountRef = useRef(0);
  const MAX_AUTO_RETRIES = 3;

  // Stable ref so the useEffect dep array doesn't change when the parent re-renders
  const onWebRTCReadyRef = useRef(onWebRTCReady);
  useEffect(() => { onWebRTCReadyRef.current = onWebRTCReady; }, [onWebRTCReady]);

  const sendPcmToSimli = useCallback((incoming: Uint8Array) => {
    if (!simliRef.current) return;
    try {
      const combined = new Uint8Array(audioRechunkBufRef.current.length + incoming.length);
      combined.set(audioRechunkBufRef.current);
      combined.set(incoming, audioRechunkBufRef.current.length);
      audioRechunkBufRef.current = combined;

      while (audioRechunkBufRef.current.length >= SIMLI_CHUNK_BYTES) {
        const frame = audioRechunkBufRef.current.slice(0, SIMLI_CHUNK_BYTES);
        audioRechunkBufRef.current = audioRechunkBufRef.current.slice(SIMLI_CHUNK_BYTES);
        simliRef.current.sendAudioData(frame);
      }
      // Partial tail bytes stay in the buffer until the next chunk fills them.
      // No zero-padding flush timer — padding introduces audible silence mid-stream.
    } catch (err) {
      console.warn('[Simli] sendAudio error:', err);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    sendAudio: (pcm: Uint8Array) => {
      if (!isReadyRef.current) {
        pendingAudioRef.current.push(pcm.slice());
        return;
      }
      const sentMs = Date.now();
      if (lastRenderStartMsRef.current === 0) {
        lastRenderStartMsRef.current = sentMs;
      }
      audioSentTimesRef.current.push(sentMs);
      if (audioSentTimesRef.current.length > 20) audioSentTimesRef.current.shift();
      sendPcmToSimli(pcm);
    },
    flushAudio: () => {
      if (!simliRef.current || audioRechunkBufRef.current.length === 0) return;
      const padded = new Uint8Array(SIMLI_CHUNK_BYTES);
      padded.set(audioRechunkBufRef.current);
      audioRechunkBufRef.current = new Uint8Array(0);
      simliRef.current.sendAudioData(padded);
    },
    getLastRenderStartMs: () => lastRenderStartMsRef.current,
    getLipSyncSamples: () => lipSyncSamplesRef.current,
    resetStats: () => {
      // Reset timing + lip-sync state only — rechunk buffer intentionally
      // untouched so in-flight audio chunks keep flowing without gaps.
      lastRenderStartMsRef.current = 0;
      audioSentTimesRef.current = [];
      lipSyncSamplesRef.current = [];
    },
    resetForInteraction: () => {
      lastRenderStartMsRef.current = 0;
      audioSentTimesRef.current = [];
      lipSyncSamplesRef.current = [];
      audioRechunkBufRef.current = new Uint8Array(0);
    },
    unlockAudio: () => {
      // Unmute our audio element and play it.
      if (audioRef.current) {
        audioRef.current.muted = false;
        audioRef.current.play().catch(() => {});
      }
      videoRef.current?.play().catch(() => {});
      // LiveKit creates its own hidden <audio> elements for remote tracks — those
      // are NOT our audioRef, so we must play() all audio elements in the document.
      // This unblocks any LiveKit-managed track that failed due to autoplay policy.
      document.querySelectorAll('audio').forEach(el => {
        (el as HTMLAudioElement).play().catch(() => {});
      });
      // Unlock LiveKit's internal AudioContext by resuming a dummy one from this gesture.
      try {
        const ctx = new AudioContext();
        ctx.resume().then(() => ctx.close()).catch(() => {});
      } catch { /* ignore */ }
    },
  }), [sendPcmToSimli]);

  // FIX 1: Initialize Simli WebRTC on component mount (empty dep array via stable sendPcmToSimli)
  useEffect(() => {
    if (!videoRef.current || !audioRef.current) return;

    const videoEl = videoRef.current;
    const audioEl = audioRef.current;
    let client: SimliClient | null = null;
    let cancelled = false;
    let playingListener: (() => void) | null = null;

    mountTimeRef.current = Date.now();

    const init = async () => {
      if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
        const missing = [!SIMLI_API_KEY && 'VITE_SIMLI_API_KEY', !SIMLI_FACE_ID && 'VITE_SIMLI_FACE_ID'].filter(Boolean).join(', ');
        console.error(`[Simli] Missing env vars: ${missing} — avatar will not connect`);
        setFailedStep('env');
        setErrorMsg(`Missing: ${missing}`);
        setStatus('error');
        return;
      }
      try {
        setConnectStep('Getting session token…');
        console.log('[Simli] Fetching session token + ICE servers...');
        const authPromise = prefetchSimliAuth();
        if (!authPromise) throw new Error('Simli API key or face ID missing');
        let session_token: string;
        try {
          // Timeout the auth fetch too — a hanging network call would stall indefinitely
          const authTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Session token request timed out (10s). Check your internet connection.')), 10_000)
          );
          ({ session_token } = await Promise.race([authPromise, authTimeout]));
        } catch (authErr: any) {
          setFailedStep('auth');
          throw authErr;
        }
        console.log('[Simli] Auth OK — session_token length:', session_token?.length ?? 0);
        setConnectStep('Starting WebRTC…');
        prefetchedAuth = null;

        if (cancelled) return;

        // LiveKit transport — no ICE/P2P needed, works through any NAT/firewall
        client = new SimliClient(session_token, videoEl, audioEl, null, undefined, 'livekit');
        simliRef.current = client;

        client.on('start', () => {
          console.log('[Simli] WebRTC connected — waiting for first video frame...');
          console.log('[Simli] Connected — draining', pendingAudioRef.current.length, 'queued chunks');
          isReadyRef.current = true;
          autoRetryCountRef.current = 0; // reset on successful connect
          setStatus('ready');

          // Simli sends green/blank frames for ~500ms after 'start' while the face
          // renderer initialises. Wait for the first non-green frame via a pixel check
          // before revealing the video. Falls back to a 2s timeout if rVFC is absent.
          const revealVideo = () => {
            if (playingListener) {
              videoEl.removeEventListener('playing', playingListener);
              playingListener = null;
            }
            const readyMs = Date.now() - mountTimeRef.current;
            console.log(`[Simli] Face frame ready (${readyMs}ms from mount)`);
            setWebRTCReady(true);
            onWebRTCReadyRef.current?.(readyMs);
          };

          videoEl.play().catch(() => {});

          if (typeof (videoEl as any).requestVideoFrameCallback === 'function') {
            // Sample the center pixel — pure green (0,128+,0) means not ready yet
            const canvas = document.createElement('canvas');
            canvas.width = 4; canvas.height = 4;
            const ctx2d = canvas.getContext('2d')!;
            let revealed = false;
            const checkFrame = () => {
              if (revealed || cancelled) return;
              ctx2d.drawImage(videoEl, 0, 0, 4, 4);
              const [r, g, b] = ctx2d.getImageData(1, 1, 1, 1).data;
              // Green init frame: g is dominant and r+b are very low
              const isGreen = g > 80 && r < 40 && b < 40;
              if (!isGreen) {
                revealed = true;
                revealVideo();
              } else {
                (videoEl as any).requestVideoFrameCallback(checkFrame);
              }
            };
            (videoEl as any).requestVideoFrameCallback(checkFrame);
          } else {
            // Fallback: wait 1.5s for Simli renderer to produce the first face frame
            setTimeout(() => { if (!cancelled) revealVideo(); }, 1500);
          }

          // Drain any audio that arrived during the WebRTC handshake
          const queued = pendingAudioRef.current.splice(0);
          for (const chunk of queued) sendPcmToSimli(chunk);

          // Lip-sync measurement via requestVideoFrameCallback
          if (typeof (videoEl as any).requestVideoFrameCallback === 'function') {
            const measureFrame = (now: number) => {
              if (!isReadyRef.current) return;
              const sentTimes = audioSentTimesRef.current;
              if (sentTimes.length > 0) {
                const wallMs = performance.timeOrigin + now;
                const nearest = sentTimes.reduce((a, b) => Math.abs(b - wallMs) < Math.abs(a - wallMs) ? b : a);
                const offset = wallMs - nearest;
                if (Math.abs(offset) < 500) {
                  const rounded = Math.round(offset);
                  lipSyncSamplesRef.current.push(rounded);
                  if (lipSyncSamplesRef.current.length > 30) lipSyncSamplesRef.current.shift();
                  // Report to server once per second (throttled)
                  const nowMs = Date.now();
                  if (nowMs - lastDriftReportRef.current >= 1000) {
                    lastDriftReportRef.current = nowMs;
                    fetch('/api/lipsync-report', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ driftMs: Math.abs(rounded), timestamp: nowMs }),
                    }).catch(() => {});
                  }
                }
              }
              (videoEl as any).requestVideoFrameCallback(measureFrame);
            };
            (videoEl as any).requestVideoFrameCallback(measureFrame);
          }
        });

        client.on('stop', () => {
          // Don't reset isReadyRef — LiveKit fires 'stop' after each silent period,
          // which would block all subsequent audio. sendPcmToSimli's simliRef null-check
          // handles true disconnects safely.
          console.log('[Simli] stop event (ignored for audio gating)');
        });

        const handleSimliError = (detail: unknown, label: string) => {
          console.error(`[Simli] ${label}:`, detail);
          // Mid-session drop (was connected before) — auto-retry silently
          if (isReadyRef.current && autoRetryCountRef.current < MAX_AUTO_RETRIES) {
            autoRetryCountRef.current++;
            console.warn(`[Simli] Mid-session error — auto-retry ${autoRetryCountRef.current}/${MAX_AUTO_RETRIES}`);
            isReadyRef.current = false;
            setWebRTCReady(false);
            setStatus('connecting');
            setConnectStep(`Reconnecting… (${autoRetryCountRef.current}/${MAX_AUTO_RETRIES})`);
            try { client?.stop(); } catch { /* ignore */ }
            simliRef.current = null;
            prefetchedAuth = null;
            if (!cancelled) setTimeout(() => setRetryTrigger(t => t + 1), 1500);
            return;
          }
          // Initial connect failure or retries exhausted — show error overlay
          setFailedStep('webrtc');
          setErrorMsg(String(detail));
          setStatus('error');
        };

        client.on('error', (detail) => handleSimliError(detail, 'Error'));
        client.on('startup_error', (msg) => handleSimliError(msg, 'Startup error'));

        console.log('[Simli] Starting WebRTC handshake...');
        // With LiveKit transport, client.start() initiates the connection but does NOT
        // resolve when ready — the 'start' event signals readiness, and 'startup_error'
        // or 'error' signals failure. Both are handled above. Just fire-and-forget.
        client.start().catch(() => {}); // errors reported via 'startup_error'/'error' events
      } catch (err) {
        // Always stop the client on error — a timed-out or errored client must be closed
        // before the next connection attempt, otherwise Simli hits the rate limit.
        try { client?.stop(); } catch { /* ignore */ }
        simliRef.current = null;
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Simli] Init failed:', msg);
          setErrorMsg(msg);
          setStatus('error');
          // failedStep already set by the throwing branch (auth/webrtc/env);
          // fall back to 'webrtc' if somehow unset
          setFailedStep((prev) => prev ?? 'webrtc');
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (playingListener) videoEl.removeEventListener('playing', playingListener);
      client?.stop();
      simliRef.current = null;
      isReadyRef.current = false;
      pendingAudioRef.current = [];
    };
  }, [sendPcmToSimli, retryTrigger]); // onWebRTCReady accessed via ref — removing it prevents reconnect loop

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid #222',
        background: '#0a0a1a',
        height: 420,
        flexShrink: 0,
      }}
    >
      {/* Placeholder — shown while Simli is still connecting */}
      {!webRTCReady && status !== 'error' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: 'radial-gradient(ellipse at center, #0d1b2a 0%, #0a0a1a 100%)',
        }}>
          <div style={{
            width: 110, height: 110, borderRadius: '50%',
            background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2236 100%)',
            border: '2px solid rgba(0,212,255,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 52,
          }}>🎓</div>
          <span style={{
            fontSize: 12, color: '#334155', fontFamily: 'monospace', letterSpacing: '0.5px',
          }}>
            {connectStep}
          </span>
        </div>
      )}

      {/* Simli WebRTC video — always visible once connected (Simli handles idle face) */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          // Always rendered so the browser decodes frames and fires 'playing'.
          // The placeholder overlay covers it until webRTCReady is true.
          opacity: webRTCReady ? 1 : 0,
        }}
      />
      {/* muted so Chrome's autoplay policy allows the initial play(); unlockAudio() unmutes after user gesture */}
      <audio ref={audioRef} autoPlay muted style={{ display: 'none' }} />

      {/* FIX 1: Connecting overlay during pre-warm period */}
      {status === 'connecting' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingBottom: 16,
            background: 'transparent',
            gap: 6,
            pointerEvents: 'none',
          }}
        >
          <span style={{
            color: '#475569', fontSize: 11, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.5)', padding: '3px 10px', borderRadius: 20,
          }}>
            Connecting...
          </span>
        </div>
      )}

      {/* Error overlay */}
      {status === 'error' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(10,10,26,0.9)',
            gap: 10,
            padding: '0 20px',
          }}
        >
          <div style={{ fontSize: 32 }}>⚠️</div>
          {/* Step label */}
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '1.5px',
            textTransform: 'uppercase', color: '#ef4444', opacity: 0.7,
          }}>
            {failedStep === 'env' ? 'Configuration error' :
             failedStep === 'auth' ? 'Authentication failed' :
             'WebRTC connection failed'}
          </span>
          {/* Human-readable diagnosis */}
          <span style={{ color: '#e2e8f0', fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
            {diagnose(errorMsg ?? '', failedStep)}
          </span>
          {/* Raw error — collapsed, monospace for copy-paste */}
          {errorMsg && (
            <details style={{ width: '100%' }}>
              <summary style={{ color: '#475569', fontSize: 10, cursor: 'pointer', textAlign: 'center' }}>
                Raw error
              </summary>
              <span style={{
                display: 'block', marginTop: 6, color: '#64748b',
                fontSize: 10, fontFamily: 'monospace', wordBreak: 'break-all',
                textAlign: 'center',
              }}>
                {errorMsg}
              </span>
            </details>
          )}
          {failedStep !== 'env' && (
            <button
              onClick={() => {
                prefetchedAuth = null;
                setStatus('connecting');
                setErrorMsg(null);
                setFailedStep(null);
                setWebRTCReady(false);
                setRetryTrigger((t) => t + 1);
              }}
              style={{
                marginTop: 4, padding: '7px 20px', borderRadius: 8, border: 'none',
                cursor: 'pointer', fontWeight: 600, fontSize: 12,
                background: 'rgba(0,212,255,0.15)', color: '#00d4ff',
              }}
            >
              Retry Connection
            </button>
          )}
        </div>
      )}

      {/* Speaking / Listening indicator */}
      {webRTCReady && (
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
