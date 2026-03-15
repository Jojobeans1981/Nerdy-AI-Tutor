import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket, type LatencyReport } from './hooks/useWebSocket';
import { useMicrophone } from './hooks/useMicrophone';
import { LatencyDashboard } from './components/LatencyDashboard';
import { TopicSelector } from './components/TopicSelector';
import { ChatDisplay } from './components/ChatDisplay';
import { ClientAvatar, type ClientAvatarHandle } from './components/ClientAvatar';
import { MicSelector } from './components/MicSelector';
import { VisualAid } from './components/VisualAid';
import { MirraLogo } from './components/MirraLogo';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

const WS_URL = (concept: string) => {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const proto = isLocal ? 'ws' : 'wss';
  const host = isLocal ? `${window.location.hostname}:3001` : window.location.host;
  return `${proto}://${host}/ws/session?concept=${concept}`;
};

function App() {
  const [topic, setTopic] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [latencyReports, setLatencyReports] = useState<LatencyReport[]>([]);
  const [isAvatarActive, setIsAvatarActive] = useState(false);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  // True while STT has fired but no AI tokens have arrived yet
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [sessionElapsed, setSessionElapsed] = useState(0);

  const streamingTextRef = useRef('');
  // True while the AI pipeline is actively streaming tokens.
  // Prevents a spurious speech_final (background noise, echo) from wiping
  // streamingTextRef mid-response and causing the chat bubble to vanish.
  const isAiRespondingRef = useRef(false);
  // Timestamp when isAiRespondingRef was last set true — used by watchdog to detect hung pipelines
  const aiRespondingStartRef = useRef(0);
  const avatarRef = useRef<ClientAvatarHandle>(null);
  const speakingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref to the speaking-done callback so both onAudio and response_end
  // can schedule it without duplicating code. Set once after component mounts.
  const speakingDoneRef = useRef<(() => void) | null>(null);
  // Set true when response_end arrives so trailing audio chunks (still in-flight
  // from the Cartesia stream) don't reset the 8s watchdog and extend "Speaking".
  const responseEndedRef = useRef(false);
  // Track the current interaction ID (set on first token) for avatar render reporting
  const currentInteractionIdRef = useRef('');
  // Half-duplex gate: true while AI is responding + brief settle window after.
  // Prevents TTS echo (speaker → mic) from reaching Deepgram and corrupting its
  // VAD state, which causes speech_final to never fire on the next utterance.
  const micMutedRef = useRef(false);
  const micUnmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hard-deadline unmute timer (set on response_end) — stored in a ref so it
  // can be cancelled when a new response starts, preventing stale timers from
  // unmuting the mic mid-response.
  const hardUnmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Manual mute toggle — user-controlled, independent of the half-duplex gate.
  const [isMicMuted, setIsMicMuted] = useState(false);
  const manualMuteRef = useRef(false);
  // FIX 8: WebRTC pre-warm timing and reconnect tracking for LatencyDashboard
  const [webRTCReadyMs, setWebRTCReadyMs] = useState<number | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  // Client avatar is always ready — no WebRTC warmup needed
  const avatarReadyRef = useRef(false);
  // True once any audio frame arrives for the current response
  const audioReceivedRef = useRef(false);
  // Non-null when the last response had no audio (shows warning banner)
  const [audioMissed, setAudioMissed] = useState(false);

  // Keep ref in sync so audio callback (closure) always sees latest value
  useEffect(() => { manualMuteRef.current = isMicMuted; }, [isMicMuted]);

  const ws = useWebSocket(topic ? WS_URL(topic) : WS_URL('fractions'));
  const mic = useMicrophone();

  // FIX 8: accumulate total reconnects across the session lifetime
  const prevReconnectAttemptsRef = useRef(0);
  useEffect(() => {
    if (ws.reconnectAttempts > prevReconnectAttemptsRef.current) {
      setReconnectCount(c => c + (ws.reconnectAttempts - prevReconnectAttemptsRef.current));
    }
    prevReconnectAttemptsRef.current = ws.reconnectAttempts;
  }, [ws.reconnectAttempts]);

  // On WS reconnect during an active session: reset all mic-gate and pipeline state.
  // Root cause: if the WS drops mid-response (server restart, network blip), micMutedRef
  // can be true with no timers running to unmute it. The new server session knows nothing
  // about the old response, so no response_end or audio ever arrives — mic stays muted forever.
  const prevIsConnectedRef = useRef(false);
  useEffect(() => {
    const reconnected = ws.isConnected && !prevIsConnectedRef.current;
    prevIsConnectedRef.current = ws.isConnected;
    if (reconnected && mic.isRecording) {
      console.warn('[Mic] WS reconnected mid-session — resetting pipeline state');
      if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
      if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
      if (hardUnmuteTimerRef.current) { clearTimeout(hardUnmuteTimerRef.current); hardUnmuteTimerRef.current = null; }
      isAiRespondingRef.current = false; aiRespondingStartRef.current = 0;
      responseEndedRef.current = false;
      streamingTextRef.current = '';
      setStreamingText('');
      setIsProcessing(false);
      setIsAvatarActive(false);
      micMutedRef.current = false;
      console.log('[Mic] Unmuted — WS reconnect reset');
    }
  }, [ws.isConnected, mic.isRecording]);

  // 3s watchdog: force-unmute if mic is stuck muted while no audio is actually playing.
  // Evaluates actual Web Audio playback state (not timer state) to catch all edge cases.
  useEffect(() => {
    if (!mic.isRecording) return;
    const watchdog = setInterval(() => {
      // Periodic state dump (even when mic is open) to help diagnose stuck states
      const remainingNow = avatarRef.current?.getRemainingPlayMs() ?? 0;
      console.log(
        `[Watchdog] micMuted=${micMutedRef.current} aiResponding=${isAiRespondingRef.current} ` +
        `responseEnded=${responseEndedRef.current} remainingMs=${remainingNow} ` +
        `avatarActive=${isAvatarActive} speakingTimeout=${!!speakingTimeoutRef.current}`
      );
      if (!micMutedRef.current) return; // mic is already open — nothing to do

      const hungPipeline = isAiRespondingRef.current &&
        aiRespondingStartRef.current > 0 &&
        Date.now() - aiRespondingStartRef.current > 15000;

      // Check actual audio playback state — not timer refs
      const remainingMs = avatarRef.current?.getRemainingPlayMs() ?? 0;
      const audioStillPlaying = remainingMs >= 150;

      if (!audioStillPlaying && (!isAiRespondingRef.current || hungPipeline)) {
        console.warn(`[Watchdog] Mic stuck muted — ${hungPipeline ? 'pipeline hung >15s' : 'AI not responding'}, remainingMs=${remainingMs} — force unmuting`);
        if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
        if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
        isAiRespondingRef.current = false; aiRespondingStartRef.current = 0;
        setIsProcessing(false);
        setIsAvatarActive(false);
        micMutedRef.current = false;
      }
    }, 3000);
    return () => clearInterval(watchdog);
  }, [mic.isRecording]);

  // Session duration timer — ticks every second while recording
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => {
      setSessionElapsed(Math.floor((Date.now() - sessionStartTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  useEffect(() => {
    ws.onMessage((msg) => {
      switch (msg.type) {
        case 'transcript':
          if (msg.is_final && msg.text?.trim()) {
            // Avoid duplicating messages already added locally (e.g. text input)
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'user' && last.text === msg.text) return prev;
              return [...prev, { role: 'user', text: msg.text }];
            });
            setInterimTranscript('');
            // Only reset streaming state when the AI is NOT mid-response.
            // If a spurious speech_final fires while tokens are streaming
            // (isBusy blocks a new pipeline but the transcript still reaches
            // the client), clearing here would wipe the response in progress.
            if (!isAiRespondingRef.current) {
              setStreamingText('');
              streamingTextRef.current = '';
              // Show "Processing…" until the first AI token arrives
              setIsProcessing(true);
            }
          } else if (!msg.is_final) {
            setInterimTranscript(msg.text || '');
          }
          break;

        case 'token': {
          const isFirstToken = !isAiRespondingRef.current;
          isAiRespondingRef.current = true;
          if (aiRespondingStartRef.current === 0) aiRespondingStartRef.current = Date.now();
          setIsProcessing(false); // first token arrived — clear spinner
          responseEndedRef.current = false; // new response starting
          audioReceivedRef.current = false; // reset audio-received flag for this response
          setAudioMissed(false);
          currentInteractionIdRef.current = msg.interaction_id ?? currentInteractionIdRef.current;
          if (isFirstToken) {
            // Cancel ALL stale unmute timers from the previous response before muting.
            // Without this, a pending unmute timer fires mid-response, briefly opens
            // the mic, TTS echo corrupts Deepgram's VAD, and subsequent utterances fail.
            const hadStaleTimer = !!micUnmuteTimerRef.current || !!hardUnmuteTimerRef.current || !!speakingTimeoutRef.current;
            if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
            if (hardUnmuteTimerRef.current) { clearTimeout(hardUnmuteTimerRef.current); hardUnmuteTimerRef.current = null; }
            if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
            console.log(`[MicGate] Muting for new response. Stale timers cancelled: ${hadStaleTimer}`);
            // Safety unmute: if response_end is ever lost (e.g. WS drop mid-pipeline),
            // this guarantees the mic unmutes within 8s regardless.
            micUnmuteTimerRef.current = setTimeout(() => {
              console.warn('[Mic] Safety unmute fired — response_end may have been lost');
              micMutedRef.current = false;
            }, 8000);
          }
          // Mute mic — TTS echo will start arriving soon
          micMutedRef.current = true;
          streamingTextRef.current += msg.text;
          setStreamingText(streamingTextRef.current);
          break;
        }

        case 'response_end': {
          isAiRespondingRef.current = false; aiRespondingStartRef.current = 0;
          setIsProcessing(false); // clear in case LLM errored before sending any token
          // Capture NOW — React updater functions run async, so reading the ref
          // inside setMessages would see the already-cleared value ("").
          const finalText = streamingTextRef.current;
          streamingTextRef.current = '';
          setStreamingText('');
          if (finalText.trim()) {
            setMessages((prev) => [...prev, { role: 'assistant', text: finalText }]);
          }
          // Report lip-sync samples collected during this response
          const samples = avatarRef.current?.getLipSyncSamples() ?? [];
          if (samples.length > 0 && msg.interaction_id) {
            const avgOffset = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
            const maxOffset = Math.max(...samples.map(Math.abs));
            ws.sendJson({
              type: 'lip_sync_report',
              interaction_id: msg.interaction_id,
              avg_offset_ms: avgOffset,
              max_offset_ms: maxOffset,
              sample_count: samples.length,
              within_45ms: samples.filter(s => Math.abs(s) <= 45).length / samples.length,
              within_80ms: samples.filter(s => Math.abs(s) <= 80).length / samples.length,
            });
            console.log(`[LipSync] avg=${avgOffset}ms max=${maxOffset}ms samples=${samples.length}`);
          }
          // Reset timing + lip-sync stats for the next interaction.
          // Do NOT call resetPlaybackClock() here — TTS audio chunks are still
          // arriving after response_end (LLM finishes before TTS). Resetting the
          // playback clock mid-stream causes new chunks to overlap already-queued
          // ones, cutting audio short. resetPlaybackClock() is called in speakingDone
          // after all audio has actually finished playing.
          avatarRef.current?.resetStats();
          // Detect audio failure: check 4s after response_end, not immediately.
          // Audio binary frames often arrive AFTER response_end (TTS still streaming),
          // so checking at response_end gives a false positive on every response.
          setTimeout(() => {
            if (!audioReceivedRef.current) {
              console.warn('[Audio] No audio received 4s after response_end — possible TTS failure');
              setAudioMissed(true);
            }
          }, 4000);
          // Mark response as ended — trailing audio chunks will now use the 3s timer
          // instead of the 8s watchdog (see ws.onAudio handler).
          responseEndedRef.current = true;

          // If NO audio was received at all (TTS failure), unmute immediately —
          // don't wait 2.5s for hard unmute or forever for speakingDone.
          if (!audioReceivedRef.current) {
            console.warn('[Mic] No audio received — unmuting immediately at response_end');
            micMutedRef.current = false;
            setIsProcessing(false);
            setIsAvatarActive(false);
            break;
          }

          // Fast-forward any 8s watchdog that was set before response_end arrived.
          // Audio often arrives before response_end (sentence streaming), so the
          // watchdog was set to 8s. Now that we know the response is done, reset
          // it to 800ms so the "Speaking" state clears promptly.
          if (speakingTimeoutRef.current) {
            clearTimeout(speakingTimeoutRef.current);
            speakingTimeoutRef.current = setTimeout(() => speakingDoneRef.current?.(), 800);
          }
          // AUDIO-AWARE hard deadline: guarantee mic reopens after response_end,
          // but NEVER while audio is still playing — opening the mic during TTS
          // playback sends echo to Deepgram, corrupting its VAD and breaking
          // subsequent utterances. Checks every 500ms after the initial 2.5s.
          if (hardUnmuteTimerRef.current) clearTimeout(hardUnmuteTimerRef.current);
          const hardUnmuteCheck = () => {
            if (!micMutedRef.current) { hardUnmuteTimerRef.current = null; return; }
            const remaining = avatarRef.current?.getRemainingPlayMs() ?? 0;
            if (remaining > 200) {
              // Audio still playing — check again after it finishes + margin
              console.log(`[Mic] Hard unmute deferred — ${remaining}ms audio remaining`);
              hardUnmuteTimerRef.current = setTimeout(hardUnmuteCheck, Math.min(remaining + 200, 1000));
              return;
            }
            hardUnmuteTimerRef.current = null;
            console.warn('[Mic] HARD UNMUTE — audio finished, mic still muted');
            micMutedRef.current = false;
            if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
            if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
            setIsAvatarActive(false);
          };
          hardUnmuteTimerRef.current = setTimeout(hardUnmuteCheck, 2500);
          break;
        }

        case 'latency':
          setLatencyReports((prev) => [...prev, msg as unknown as LatencyReport]);
          break;

        case 'tts_error':
          console.error('[Cartesia]', msg.error, msg.message);
          alert(`TTS error (${msg.error}): ${msg.message}`);
          break;

        case 'error':
          console.error('[Server]', msg.message);
          break;
      }
    });
  }, [ws]);

  // Stable speaking-done callback — called 1.5s after the last TTS audio chunk.
  // This is the PRIMARY mic unmute path. Unmuting here (not at response_end) ensures
  // TTS audio has truly finished playing before the mic opens, preventing echo transcription.
  useEffect(() => {
    speakingDoneRef.current = () => {
      // Null out the speaking timeout ref so response_end's fast-forward block
      // doesn't fire speakingDone prematurely on the NEXT exchange.
      speakingTimeoutRef.current = null;
      setIsAvatarActive(false);
      // Reset playback clock now that all audio has finished playing.
      // This syncs nextPlayTime back to currentTime, preventing accumulated
      // drift from inflating future getRemainingPlayMs() values.
      avatarRef.current?.resetPlaybackClock();
      avatarRef.current?.resetStats();
      // Dynamic mic unmute: wait for scheduled Web Audio playback to finish.
      // Web Audio API schedules chunks ahead via nextPlayTime — audio may still be
      // playing 1-2s after the last chunk arrives. Opening the mic too early causes
      // Deepgram to transcribe the AI's own speech as user input, breaking the session.
      const remainingMs = avatarRef.current?.getRemainingPlayMs() ?? 0;
      const unmuteDelay = Math.max(100, remainingMs + 200); // 200ms safety margin
      console.log(`[Mic] Scheduling unmute in ${unmuteDelay}ms (${remainingMs}ms audio remaining)`);
      if (micUnmuteTimerRef.current) clearTimeout(micUnmuteTimerRef.current);
      micUnmuteTimerRef.current = setTimeout(() => {
        micUnmuteTimerRef.current = null;
        micMutedRef.current = false;
        console.log('[Mic] Unmuted — speaking done');
      }, unmuteDelay);
    };
  });

  // Binary audio path — raw PCM arrives as Uint8Array (no base64, no JSON parse overhead)
  useEffect(() => {
    ws.onAudio((pcm) => {
      setIsAvatarActive(true);
      audioReceivedRef.current = true;
      // Reset the speaking timer on each chunk.
      // Before response_end: 8s watchdog.  After response_end: 800ms.
      if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
      speakingTimeoutRef.current = setTimeout(
        () => speakingDoneRef.current?.(),
        responseEndedRef.current ? 800 : 8000,
      );

      // Client avatar handles audio playback + lip sync directly — no WebRTC routing needed
      avatarRef.current?.sendAudio(pcm);
      // Report render latency on first audio chunk of each interaction
      const audioSentMs = avatarRef.current?.getLastRenderStartMs() ?? 0;
      if (audioSentMs > 0 && currentInteractionIdRef.current) {
        const renderMs = Date.now() - audioSentMs + 1; // client-side render is sub-ms
        ws.sendJson({ type: 'avatar_rendered', interaction_id: currentInteractionIdRef.current, render_ms: renderMs });
      }
    });
  }, [ws]);

  const handleStart = useCallback(async () => {
    // Full reset of all pipeline state — covers fresh starts and topic-change-then-restart.
    // Prevents stale refs from a previous session bleeding into the new one.
    isAiRespondingRef.current = false; aiRespondingStartRef.current = 0;
    responseEndedRef.current = false;
    audioReceivedRef.current = false;
    streamingTextRef.current = '';
    setStreamingText('');
    setIsProcessing(false);
    setIsAvatarActive(false);
    setAudioMissed(false);
    if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
    micMutedRef.current = false;
    if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
    if (hardUnmuteTimerRef.current) { clearTimeout(hardUnmuteTimerRef.current); hardUnmuteTimerRef.current = null; }
    // Satisfy browser autoplay policy — must be called from within a user gesture handler.
    // Simli pre-warms before any interaction, so the audio/video elements need an explicit
    // .play() triggered by this click to avoid "NotAllowedError: play() failed" errors.
    avatarRef.current?.unlockAudio();
    setSessionStartTime(Date.now());
    setSessionElapsed(0);
    ws.connect();
    setTimeout(async () => {
      let _lastGateLog = 0;
      await mic.startRecording((audioData) => {
        if (micMutedRef.current || manualMuteRef.current) {
          const now = Date.now();
          if (now - _lastGateLog > 2000) {
            _lastGateLog = now;
            console.log('[MIC GATE] BLOCKED — micMuted:', micMutedRef.current, 'manualMute:', manualMuteRef.current);
          }
          return;
        }
        ws.sendAudio(audioData);
      }, micDeviceId);
    }, 500);
  }, [ws, mic, micDeviceId]);

  const handleStop = useCallback(() => {
    mic.stopRecording();
    ws.disconnect();
    setSessionStartTime(null);
  }, [mic, ws]);

  const handleBargeIn = useCallback(() => {
    // Immediately stop the AI response on client
    isAiRespondingRef.current = false; aiRespondingStartRef.current = 0;
    setIsProcessing(false);
    responseEndedRef.current = true;
    streamingTextRef.current = '';
    setStreamingText('');
    if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
    speakingTimeoutRef.current = null; // prevent stale-ref fast-forward on next exchange
    setIsAvatarActive(false);
    avatarRef.current?.resetForInteraction();
    // Unmute mic immediately so user can speak right away
    if (micUnmuteTimerRef.current) clearTimeout(micUnmuteTimerRef.current);
    micUnmuteTimerRef.current = null;
    if (hardUnmuteTimerRef.current) clearTimeout(hardUnmuteTimerRef.current);
    hardUnmuteTimerRef.current = null;
    micMutedRef.current = false;
    // Tell server to abort the current pipeline
    ws.sendJson({ type: 'interrupt' });
  }, [ws]);

  // Queue for messages typed before WS is ready
  const pendingTextRef = useRef<string | null>(null);

  // When WS connects, flush any pending text message
  useEffect(() => {
    if (ws.isConnected && pendingTextRef.current) {
      const sent = ws.sendJsonReliable({ type: 'text_input', text: pendingTextRef.current });
      if (sent) pendingTextRef.current = null;
    }
  }, [ws.isConnected, ws]);

  const handleSendText = useCallback(() => {
    const text = textInput.trim();
    if (!text) return;
    // Show user message immediately in the chat
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setTextInput('');
    // Use sendJsonReliable — checks actual WS readyState, not stale React state.
    // If the socket isn't open (dropped between renders), queue and reconnect.
    const sent = ws.sendJsonReliable({ type: 'text_input', text });
    if (!sent) {
      console.warn('[Text] WS not ready — queuing and connecting');
      pendingTextRef.current = text;
      ws.connect();
    }
  }, [textInput, ws]);

  const topicLabel =
    topic === 'fractions' ? 'Fractions · 6th Grade' :
    topic === 'mitosis'   ? 'Cell Biology · 8th Grade' :
    topic === 'algebra'   ? 'Algebra · 9th Grade' : '';

  return (
    <div style={{ height: '100vh', overflow: 'hidden', position: 'relative' }}>
      {/* Mesh background */}
      <div className="bg-animated" />

      <div style={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <header style={{
          padding: '12px 24px', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid var(--mirra-border)',
          backdropFilter: 'blur(12px)',
        }}>
          <MirraLogo size="md" />
          <span style={{ color: 'var(--mirra-border)', fontSize: 16, fontWeight: 300, marginLeft: 2 }}>|</span>
          <span style={{ fontSize: 11, color: 'var(--mirra-text-secondary)', letterSpacing: '0.02em' }}>Ask better. Think deeper.</span>
          {topic && (
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 600,
              background: 'rgba(62,207,207,0.1)', border: '1px solid rgba(62,207,207,0.25)',
              color: 'var(--mirra-reflect)', padding: '3px 10px', borderRadius: 20,
            }}>{topicLabel}</span>
          )}
          {ws.reconnectAttempts >= 5 && !ws.isConnected && (
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: 'var(--mirra-error)' }}>
              Connection lost — please refresh.
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {mic.isRecording && (
              <>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, color: ws.isConnected ? 'var(--mirra-correct)' : ws.isReconnecting ? 'var(--mirra-caution)' : 'var(--mirra-error)',
                }}>
                  <span>●</span>
                  {ws.isConnected ? 'Connected' : ws.isReconnecting ? 'Reconnecting' : 'Disconnected'}
                </span>
                <span style={{ color: '#1e293b' }}>·</span>
              </>
            )}
            <span style={{ fontSize: 11, color: 'var(--mirra-text-secondary)', letterSpacing: '0.5px' }}>by Mirra</span>
          </span>
        </header>

        {/* Main */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>

          {/* Landing overlay — shown before topic is selected. */}
          {!topic && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: 24, textAlign: 'center',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '2.5px',
                textTransform: 'uppercase', color: 'var(--mirra-reflect)', marginBottom: 16, opacity: 0.9,
              }}>MIRRA · ASK BETTER. THINK DEEPER.</div>
              <h1 style={{
                fontSize: 'clamp(28px, 5vw, 48px)', fontWeight: 800,
                letterSpacing: '-1px', lineHeight: 1.15, marginBottom: 16,
                background: 'linear-gradient(135deg, var(--mirra-text-primary) 30%, var(--mirra-accent))',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>
                What would you like<br />to discover today?
              </h1>
              <p style={{ color: 'var(--mirra-text-secondary)', fontSize: 15, marginBottom: 52, maxWidth: 460 }}>
                Speak your question. Mirra reflects it back — guiding you to the answer through the right questions, never around them.
              </p>
              <TopicSelector selected={topic} onSelect={(t) => { avatarRef.current?.unlockAudio(); setTopic(t); }} />

              {/* How it works */}
              <div style={{ marginTop: 52, display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
                {[
                  { step: '01', label: 'Speak or type', desc: 'Your voice is transcribed in real time' },
                  { step: '02', label: 'Mirra thinks', desc: 'Llama 3.1 crafts a Socratic question' },
                  { step: '03', label: 'Mirra responds', desc: 'Cartesia TTS + Simli lip-sync video' },
                ].map(({ step, label, desc }) => (
                  <div key={step} style={{ textAlign: 'center', width: 160 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, letterSpacing: '2px',
                      color: '#334155', marginBottom: 6,
                    }}>{step}</div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.5 }}>{desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Session layout — always mounted. ClientAvatar is instant (no WebRTC warmup). */}
          <div style={{
            height: '100%',
            display: topic ? 'grid' : 'none',
            gridTemplateColumns: '1fr 296px',
            gap: 10, padding: 10,
          }}>

            {/* Left */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
              <ClientAvatar
                ref={avatarRef}
                isActive={isAvatarActive}
                onReady={(ms) => {
                  setWebRTCReadyMs(ms);
                  avatarReadyRef.current = true;
                }}
              />

              <div className="glass" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                <ChatDisplay messages={messages} interimTranscript={interimTranscript} streamingText={streamingText} />
              </div>

              {/* Audio failure warning */}
              {audioMissed && (
                <div style={{
                  padding: '8px 14px', borderRadius: 8, flexShrink: 0,
                  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                  color: '#fca5a5', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span>⚠️ No audio received — Mirra's last response may not have played. Check your volume or network.</span>
                  <button
                    onClick={() => setAudioMissed(false)}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
                  >×</button>
                </div>
              )}

              {/* Controls */}
              <div className="glass" style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
                {/* Session buttons + voice indicator */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {!mic.isRecording ? (
                    <button
                      onClick={handleStart}
                      style={{
                        position: 'relative', padding: '9px 26px', borderRadius: 50,
                        border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        background: 'linear-gradient(135deg, var(--mirra-reflect), var(--mirra-accent))',
                        color: '#fff', letterSpacing: '0.3px',
                        boxShadow: '0 0 18px rgba(62,207,207,0.3)',
                      }}
                    >
                      Start Thinking
                    </button>
                  ) : (
                    <button
                      onClick={handleStop}
                      style={{
                        position: 'relative', padding: '9px 26px', borderRadius: 50,
                        border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        background: 'var(--mirra-error)', color: '#fff',
                        boxShadow: '0 0 18px rgba(248,113,113,0.35)',
                      }}
                    >
                      <span className="pulse-ring" />
                      End Session
                    </button>
                  )}

                  {/* Audio level visualizer */}
                  {mic.isRecording && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 20 }}>
                        {Array.from({ length: 7 }).map((_, i) => {
                          const threshold = (i + 1) / 7;
                          const active = mic.audioLevel >= threshold;
                          const barColor = i < 4 ? 'var(--mirra-correct)' : i < 6 ? 'var(--mirra-caution)' : 'var(--mirra-error)';
                          return (
                            <div
                              key={i}
                              style={{
                                width: 3, borderRadius: 1.5,
                                height: 6 + i * 2,
                                background: active ? barColor : 'rgba(255,255,255,0.08)',
                                transition: 'background 0.08s',
                              }}
                            />
                          );
                        })}
                      </div>
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: isProcessing ? 'var(--mirra-caution)' : mic.audioLevel > 0.05 ? 'var(--mirra-correct)' : 'var(--mirra-text-secondary)',
                        transition: 'color 0.2s',
                      }}>
                        {isProcessing ? 'Processing…' : mic.audioLevel > 0.05 ? 'Listening...' : 'Speak now'}
                      </span>
                    </div>
                  )}

                  {/* Mic mute toggle */}
                  {mic.isRecording && (
                    <button
                      onClick={() => setIsMicMuted(m => !m)}
                      title={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
                      style={{
                        padding: '6px 12px', borderRadius: 8, border: 'none',
                        cursor: 'pointer', fontWeight: 600, fontSize: 12,
                        background: isMicMuted ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.06)',
                        color: isMicMuted ? 'var(--mirra-error)' : '#94a3b8',
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}
                    >
                      {isMicMuted ? '🔇' : '🎤'}
                      {isMicMuted ? 'Muted' : 'Mic'}
                    </button>
                  )}

                  {/* Barge-in button — only shown while AI is actively speaking */}
                  {isAvatarActive && mic.isRecording && (
                    <button
                      onClick={handleBargeIn}
                      title="Interrupt the AI and start speaking"
                      style={{
                        padding: '6px 14px', borderRadius: 8, border: 'none',
                        cursor: 'pointer', fontWeight: 700, fontSize: 12,
                        background: 'rgba(251,191,36,0.15)',
                        color: '#fbbf24',
                        display: 'flex', alignItems: 'center', gap: 5,
                        boxShadow: '0 0 10px rgba(251,191,36,0.2)',
                      }}
                    >
                      ✋ Interrupt
                    </button>
                  )}

                  <MicSelector selectedDeviceId={micDeviceId} onSelect={setMicDeviceId} />

                  <button
                    onClick={() => { setTopic(null); handleStop(); setMessages([]); setLatencyReports([]); setIsMicMuted(false); }}
                    style={{
                      marginLeft: 'auto', padding: '6px 14px', borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
                      color: '#64748b', cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    Change Topic
                  </button>
                </div>

                {/* Text input — always visible when a topic is selected */}
                {topic && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
                      placeholder="Or type your answer here…"
                      style={{
                        flex: 1, padding: '8px 14px', borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.1)',
                        background: 'rgba(255,255,255,0.05)',
                        color: '#e2e8f0', fontSize: 13, outline: 'none',
                      }}
                    />
                    <button
                      onClick={handleSendText}
                      disabled={!textInput.trim()}
                      style={{
                        padding: '8px 18px', borderRadius: 8, border: 'none',
                        cursor: textInput.trim() ? 'pointer' : 'default',
                        background: textInput.trim() ? 'rgba(62,207,207,0.2)' : 'rgba(255,255,255,0.05)',
                        color: textInput.trim() ? 'var(--mirra-reflect)' : '#334155',
                        fontWeight: 600, fontSize: 13,
                      }}
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
              <LatencyDashboard
                reports={latencyReports}
                webRTCReadyMs={webRTCReadyMs}
                reconnectCount={reconnectCount}
              />
              <VisualAid topic={topic ?? ''} />
              <div className="glass" style={{ padding: 16, fontSize: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--mirra-text-secondary)', marginBottom: 14 }}>Session</div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: 'var(--mirra-text-secondary)', fontSize: 11, marginBottom: 3 }}>Topic</div>
                  <div style={{ color: 'var(--mirra-text-primary)', fontWeight: 600 }}>{topicLabel}</div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: 'var(--mirra-text-secondary)', fontSize: 11, marginBottom: 3 }}>Status</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: mic.isRecording ? 'var(--mirra-correct)' : 'var(--mirra-text-secondary)', fontSize: 16, lineHeight: 1 }}>●</span>
                    <span style={{ color: mic.isRecording ? 'var(--mirra-correct)' : 'var(--mirra-text-secondary)', fontWeight: 600 }}>
                      {mic.isRecording ? (isProcessing ? 'Processing' : isAvatarActive ? 'AI Speaking' : 'Listening') : 'Idle'}
                    </span>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: 'var(--mirra-text-secondary)', fontSize: 11, marginBottom: 3 }}>Duration</div>
                  <div style={{ color: 'var(--mirra-text-primary)', fontWeight: 700, fontSize: 18, fontFamily: 'monospace' }}>
                    {sessionStartTime
                      ? `${String(Math.floor(sessionElapsed / 60)).padStart(2, '0')}:${String(sessionElapsed % 60).padStart(2, '0')}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--mirra-text-secondary)', fontSize: 11, marginBottom: 3 }}>Exchanges</div>
                  <div style={{ color: 'var(--mirra-text-primary)', fontWeight: 700, fontSize: 20 }}>
                    {messages.filter(m => m.role === 'user').length}
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
