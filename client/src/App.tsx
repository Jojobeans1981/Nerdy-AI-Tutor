import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket, type LatencyReport } from './hooks/useWebSocket';
import { useMicrophone } from './hooks/useMicrophone';
import { LatencyDashboard } from './components/LatencyDashboard';
import { TopicSelector } from './components/TopicSelector';
import { ChatDisplay } from './components/ChatDisplay';
import { AvatarVideo, type AvatarVideoHandle } from './components/AvatarVideo';
import { MicSelector } from './components/MicSelector';
import { VisualAid } from './components/VisualAid';

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
  const avatarRef = useRef<AvatarVideoHandle>(null);
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
  // Manual mute toggle — user-controlled, independent of the half-duplex gate.
  const [isMicMuted, setIsMicMuted] = useState(false);
  const manualMuteRef = useRef(false);
  // FIX 8: WebRTC pre-warm timing and reconnect tracking for LatencyDashboard
  const [webRTCReadyMs, setWebRTCReadyMs] = useState<number | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  // Web Audio API fallback: plays raw PCM when Simli WebRTC isn't connected yet
  const audioCtxRef = useRef<AudioContext | null>(null);
  const simliReadyRef = useRef(false);
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
      isAiRespondingRef.current = false;
      responseEndedRef.current = false;
      streamingTextRef.current = '';
      setStreamingText('');
      setIsProcessing(false);
      setIsAvatarActive(false);
      micMutedRef.current = false;
      console.log('[Mic] Unmuted — WS reconnect reset');
    }
  }, [ws.isConnected, mic.isRecording]);

  // 5s watchdog: force-unmute if mic is stuck muted while AI is not actively responding.
  // Catches all edge cases (WS drops, TTS failures, timer race conditions) with a max
  // "stuck" window of 5s. Condition: muted + AI not streaming tokens = safe to unmute.
  useEffect(() => {
    if (!mic.isRecording) return;
    const watchdog = setInterval(() => {
      if (micMutedRef.current && !isAiRespondingRef.current) {
        console.warn('[Watchdog] Mic stuck muted — AI not responding — force unmuting');
        if (speakingTimeoutRef.current) { clearTimeout(speakingTimeoutRef.current); speakingTimeoutRef.current = null; }
        if (micUnmuteTimerRef.current) { clearTimeout(micUnmuteTimerRef.current); micUnmuteTimerRef.current = null; }
        micMutedRef.current = false;
      }
    }, 5000);
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
          setIsProcessing(false); // first token arrived — clear spinner
          responseEndedRef.current = false; // new response starting
          audioReceivedRef.current = false; // reset audio-received flag for this response
          setAudioMissed(false);
          currentInteractionIdRef.current = msg.interaction_id ?? currentInteractionIdRef.current;
          // Mute mic on first token — TTS echo will start arriving soon
          micMutedRef.current = true;
          if (isFirstToken) {
            // Safety unmute: if response_end is ever lost (e.g. WS drop mid-pipeline),
            // this guarantees the mic unmutes within 8s regardless.
            // The response_end handler's 1.5s timer replaces this in the normal flow.
            if (micUnmuteTimerRef.current) clearTimeout(micUnmuteTimerRef.current);
            micUnmuteTimerRef.current = setTimeout(() => {
              console.warn('[Mic] Safety unmute fired — response_end may have been lost');
              micMutedRef.current = false;
            }, 8000);
            console.log('[Mic] Muted — response started');
          }
          streamingTextRef.current += msg.text;
          setStreamingText(streamingTextRef.current);
          break;
        }

        case 'response_end': {
          isAiRespondingRef.current = false;
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
          // Do NOT flush or clear the rechunk buffer here — Cartesia audio
          // chunks are still in-flight after response_end (LLM finishes before
          // TTS). Flushing here inserts a zero-padded silence frame mid-speech,
          // causing audible choppiness. The speaking timeout handles the flush.
          avatarRef.current?.resetStats();
          // Detect audio failure: check 2.5s after response_end, not immediately.
          // Audio binary frames often arrive AFTER response_end (TTS still streaming),
          // so checking at response_end gives a false positive on every response.
          setTimeout(() => {
            if (!audioReceivedRef.current) {
              console.warn('[Audio] No audio received 2.5s after response_end — possible TTS failure');
              setAudioMissed(true);
            }
          }, 2500);
          // Mark response as ended — trailing audio chunks will now use the 3s timer
          // instead of the 8s watchdog (see ws.onAudio handler).
          responseEndedRef.current = true;
          // Fast-forward any 8s watchdog that was set before response_end arrived.
          // Audio often arrives before response_end (sentence streaming), so the
          // watchdog was set to 8s. Now that we know the response is done, reset
          // it to 3s so the "Speaking" state clears promptly.
          if (speakingTimeoutRef.current) {
            clearTimeout(speakingTimeoutRef.current);
            speakingTimeoutRef.current = setTimeout(() => speakingDoneRef.current?.(), 1500);
          }
          // No-audio case: if TTS fails entirely and no audio arrives, the 8s safety
          // timer set on first token handles unmute. The fast-forward above handles
          // exchanges where audio was already in-flight before response_end arrived.
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
      avatarRef.current?.flushAudio();
      avatarRef.current?.resetForInteraction();
      // Unmute mic — TTS is done (1.5s of silence after last audio chunk)
      if (micUnmuteTimerRef.current) clearTimeout(micUnmuteTimerRef.current);
      micUnmuteTimerRef.current = null;
      micMutedRef.current = false;
      console.log('[Mic] Unmuted — speaking done (TTS finished)');
    };
  });

  // Binary audio path — raw PCM arrives as Uint8Array (no base64, no JSON parse overhead)
  useEffect(() => {
    ws.onAudio((pcm) => {
      setIsAvatarActive(true);
      audioReceivedRef.current = true;
      // Reset the speaking timer on each chunk.
      // Before response_end: 8s watchdog.  After response_end: 1.5s.
      if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
      speakingTimeoutRef.current = setTimeout(
        () => speakingDoneRef.current?.(),
        responseEndedRef.current ? 1500 : 8000,
      );

      if (simliReadyRef.current) {
        // Simli WebRTC connected — route audio through avatar (lip-sync + video)
        avatarRef.current?.sendAudio(pcm);
        // Report render latency on first audio chunk of each interaction
        const audioSentMs = avatarRef.current?.getLastRenderStartMs() ?? 0;
        if (audioSentMs > 0 && currentInteractionIdRef.current) {
          const renderMs = Date.now() - audioSentMs + 33;
          ws.sendJson({ type: 'avatar_rendered', interaction_id: currentInteractionIdRef.current, render_ms: renderMs });
        }
      } else {
        // Simli not ready yet — play raw PCM directly via Web Audio API so voice works
        try {
          if (!audioCtxRef.current) {
            audioCtxRef.current = new AudioContext({ sampleRate: 16000 });
          }
          const ctx = audioCtxRef.current;
          // PCM is 16-bit signed LE — convert to Float32
          const samples = pcm.length / 2;
          const audioBuffer = ctx.createBuffer(1, samples, 16000);
          const channel = audioBuffer.getChannelData(0);
          const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          for (let i = 0; i < samples; i++) {
            channel[i] = view.getInt16(i * 2, true) / 32768;
          }
          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(ctx.destination);
          src.start();
        } catch (e) {
          console.warn('[Audio fallback] playback error:', e);
        }
      }
    });
  }, [ws]);

  const handleStart = useCallback(async () => {
    // Full reset of all pipeline state — covers fresh starts and topic-change-then-restart.
    // Prevents stale refs from a previous session bleeding into the new one.
    isAiRespondingRef.current = false;
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
    // Satisfy browser autoplay policy — must be called from within a user gesture handler.
    // Simli pre-warms before any interaction, so the audio/video elements need an explicit
    // .play() triggered by this click to avoid "NotAllowedError: play() failed" errors.
    avatarRef.current?.unlockAudio();
    setSessionStartTime(Date.now());
    setSessionElapsed(0);
    ws.connect();
    setTimeout(async () => {
      let _warnedDropped = false;
      await mic.startRecording((audioData) => {
        if (micMutedRef.current) {
          if (!_warnedDropped) { console.warn('[Mic] Audio dropped — micMuted=true'); _warnedDropped = true; }
          return;
        }
        _warnedDropped = false;
        if (manualMuteRef.current) return;
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
    isAiRespondingRef.current = false;
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
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          backdropFilter: 'blur(12px)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(135deg, #00d4ff, #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          }}>🎓</div>
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.3px' }}>Nerdy AI Tutor</span>
          {topic && (
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 600,
              background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.25)',
              color: '#00d4ff', padding: '3px 10px', borderRadius: 20,
            }}>{topicLabel}</span>
          )}
          {ws.reconnectAttempts >= 5 && !ws.isConnected && (
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#ef4444' }}>
              Connection lost — please refresh.
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {mic.isRecording && (
              <>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, color: ws.isConnected ? '#22c55e' : ws.isReconnecting ? '#f59e0b' : '#ef4444',
                }}>
                  <span>●</span>
                  {ws.isConnected ? 'Connected' : ws.isReconnecting ? 'Reconnecting' : 'Disconnected'}
                </span>
                <span style={{ color: '#1e293b' }}>·</span>
              </>
            )}
            <span style={{ fontSize: 11, color: '#475569', letterSpacing: '0.5px' }}>by Nerdy / Varsity Tutors</span>
          </span>
        </header>

        {/* Main */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>

          {/* Landing overlay — shown before topic is selected.
              Rendered on top while the session layout (with AvatarVideo) mounts
              in the background so the Simli WebRTC handshake starts immediately. */}
          {!topic && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: 24, textAlign: 'center',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '2.5px',
                textTransform: 'uppercase', color: '#00d4ff', marginBottom: 16, opacity: 0.9,
              }}>Socratic AI · Ask, Don't Tell</div>
              <h1 style={{
                fontSize: 'clamp(28px, 5vw, 48px)', fontWeight: 800,
                letterSpacing: '-1px', lineHeight: 1.15, marginBottom: 16,
                background: 'linear-gradient(135deg, #e2e8f0 30%, #7c3aed)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>
                What would you like<br />to learn today?
              </h1>
              <p style={{ color: '#64748b', fontSize: 15, marginBottom: 52, maxWidth: 460 }}>
                Pick a topic and start talking. Your AI tutor guides you with questions — never just giving you the answer.
              </p>
              <TopicSelector selected={topic} onSelect={(t) => { avatarRef.current?.unlockAudio(); setTopic(t); }} />

              {/* How it works */}
              <div style={{ marginTop: 52, display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
                {[
                  { step: '01', label: 'Speak or type', desc: 'Your voice is transcribed in real time' },
                  { step: '02', label: 'AI thinks', desc: 'Llama 3.1 crafts a Socratic question' },
                  { step: '03', label: 'Avatar responds', desc: 'Cartesia TTS + Simli lip-sync video' },
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

          {/* Session layout — always mounted so AvatarVideo's WebRTC handshake
              begins on page load (not after topic selection). Hidden via display:none
              while on the landing page; the component stays mounted throughout. */}
          <div style={{
            height: '100%',
            display: topic ? 'grid' : 'none',
            gridTemplateColumns: '1fr 296px',
            gap: 10, padding: 10,
          }}>

            {/* Left */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
              <AvatarVideo
                ref={avatarRef}
                isActive={isAvatarActive}
                onWebRTCReady={(ms) => {
                  setWebRTCReadyMs(ms);
                  simliReadyRef.current = true;
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
                  <span>⚠️ No audio received — the tutor's last response may not have played. Check your volume or network.</span>
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
                        background: 'linear-gradient(135deg, #00d4ff, #7c3aed)',
                        color: '#fff', letterSpacing: '0.3px',
                        boxShadow: '0 0 18px rgba(0,212,255,0.3)',
                      }}
                    >
                      Start Session
                    </button>
                  ) : (
                    <button
                      onClick={handleStop}
                      style={{
                        position: 'relative', padding: '9px 26px', borderRadius: 50,
                        border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        background: '#ef4444', color: '#fff',
                        boxShadow: '0 0 18px rgba(239,68,68,0.35)',
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
                          const barColor = i < 4 ? '#22c55e' : i < 6 ? '#eab308' : '#ef4444';
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
                        color: isProcessing ? '#f59e0b' : mic.audioLevel > 0.05 ? '#22c55e' : '#475569',
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
                        background: isMicMuted ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.06)',
                        color: isMicMuted ? '#ef4444' : '#94a3b8',
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
                        background: textInput.trim() ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.05)',
                        color: textInput.trim() ? '#00d4ff' : '#334155',
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
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#475569', marginBottom: 14 }}>Session</div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Topic</div>
                  <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{topicLabel}</div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Status</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: mic.isRecording ? '#22c55e' : '#475569', fontSize: 16, lineHeight: 1 }}>●</span>
                    <span style={{ color: mic.isRecording ? '#22c55e' : '#475569', fontWeight: 600 }}>
                      {mic.isRecording ? (isProcessing ? 'Processing' : isAvatarActive ? 'AI Speaking' : 'Listening') : 'Idle'}
                    </span>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Duration</div>
                  <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 18, fontFamily: 'monospace' }}>
                    {sessionStartTime
                      ? `${String(Math.floor(sessionElapsed / 60)).padStart(2, '0')}:${String(sessionElapsed % 60).padStart(2, '0')}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Exchanges</div>
                  <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 20 }}>
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
