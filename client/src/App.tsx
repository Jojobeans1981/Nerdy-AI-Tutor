import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket, type LatencyReport } from './hooks/useWebSocket';
import { useMicrophone } from './hooks/useMicrophone';
import { LatencyDashboard } from './components/LatencyDashboard';
import { TopicSelector } from './components/TopicSelector';
import { ChatDisplay } from './components/ChatDisplay';
import { AvatarVideo, type AvatarVideoHandle } from './components/AvatarVideo';
import { MicSelector } from './components/MicSelector';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

const WS_URL = (concept: string) => `ws://${window.location.hostname}:3001/ws/session?concept=${concept}`;

function App() {
  const [topic, setTopic] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [latencyReports, setLatencyReports] = useState<LatencyReport[]>([]);
  const [isAvatarActive, setIsAvatarActive] = useState(false);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);

  const streamingTextRef = useRef('');
  // True while the AI pipeline is actively streaming tokens.
  // Prevents a spurious speech_final (background noise, echo) from wiping
  // streamingTextRef mid-response and causing the chat bubble to vanish.
  const isAiRespondingRef = useRef(false);
  const avatarRef = useRef<AvatarVideoHandle>(null);

  const ws = useWebSocket(topic ? WS_URL(topic) : WS_URL('fractions'));
  const mic = useMicrophone();

  useEffect(() => {
    ws.onMessage((msg) => {
      switch (msg.type) {
        case 'transcript':
          if (msg.is_final && msg.text?.trim()) {
            setMessages((prev) => [...prev, { role: 'user', text: msg.text }]);
            setInterimTranscript('');
            // Only reset streaming state when the AI is NOT mid-response.
            // If a spurious speech_final fires while tokens are streaming
            // (isBusy blocks a new pipeline but the transcript still reaches
            // the client), clearing here would wipe the response in progress.
            if (!isAiRespondingRef.current) {
              setStreamingText('');
              streamingTextRef.current = '';
            }
          } else if (!msg.is_final) {
            setInterimTranscript(msg.text || '');
          }
          break;

        case 'token':
          isAiRespondingRef.current = true;
          streamingTextRef.current += msg.text;
          setStreamingText(streamingTextRef.current);
          break;

        case 'audio':
          // Push PCM audio directly to Simli via imperative handle — no state update,
          // no re-render, no queue accumulation. This is the low-latency path.
          setIsAvatarActive(true);
          avatarRef.current?.sendAudio(msg.data);
          break;

        case 'response_end': {
          isAiRespondingRef.current = false;
          // Capture NOW — React updater functions run async, so reading the ref
          // inside setMessages would see the already-cleared value ("").
          const finalText = streamingTextRef.current;
          streamingTextRef.current = '';
          setStreamingText('');
          if (finalText.trim()) {
            setMessages((prev) => [...prev, { role: 'assistant', text: finalText }]);
          }
          setTimeout(() => setIsAvatarActive(false), 1000);
          break;
        }

        case 'latency':
          setLatencyReports((prev) => [...prev, msg as unknown as LatencyReport]);
          break;

        case 'tts_error':
          console.error('[ElevenLabs]', msg.error, msg.message);
          alert(`TTS error (${msg.error}): ${msg.message}`);
          break;

        case 'error':
          console.error('[Server]', msg.message);
          break;
      }
    });
  }, [ws]);

  const handleStart = useCallback(async () => {
    ws.connect();
    setTimeout(async () => {
      await mic.startRecording((audioData) => {
        ws.sendAudio(audioData);
      }, micDeviceId);
    }, 500);
  }, [ws, mic, micDeviceId]);

  const handleStop = useCallback(() => {
    mic.stopRecording();
    ws.disconnect();
  }, [mic, ws]);

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
          <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto', letterSpacing: '0.5px' }}>
            by Nerdy / Varsity Tutors
          </span>
        </header>

        {/* Main */}
        {!topic ? (

          /* Landing */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
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
            <TopicSelector selected={topic} onSelect={setTopic} />
          </div>

        ) : (

          /* Session */
          <div style={{
            flex: 1, display: 'grid',
            gridTemplateColumns: '1fr 296px',
            gap: 10, padding: 10, minHeight: 0,
          }}>

            {/* Left */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
              <AvatarVideo ref={avatarRef} isActive={isAvatarActive} />

              <div className="glass" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                <ChatDisplay messages={messages} interimTranscript={interimTranscript} streamingText={streamingText} />
              </div>

              {/* Controls */}
              <div className="glass" style={{ padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
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

                {mic.isRecording && (
                  <span style={{ fontSize: 12, color: '#22c55e', display: 'flex', alignItems: 'center' }}>
                    <span className="rec-dot" />Recording
                  </span>
                )}

                <MicSelector selectedDeviceId={micDeviceId} onSelect={setMicDeviceId} />

                <button
                  onClick={() => { setTopic(null); handleStop(); setMessages([]); setLatencyReports([]); }}
                  style={{
                    marginLeft: 'auto', padding: '6px 14px', borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
                    color: '#64748b', cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Change Topic
                </button>
              </div>
            </div>

            {/* Right */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
              <LatencyDashboard reports={latencyReports} />
              <div className="glass" style={{ padding: 16, fontSize: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#475569', marginBottom: 14 }}>Session</div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Topic</div>
                  <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{topicLabel}</div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 3 }}>Method</div>
                  <div style={{ color: '#94a3b8' }}>Socratic — guides through questions</div>
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
        )}
      </div>
    </div>
  );
}

export default App;
