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

const WS_URL = `ws://${window.location.hostname}:3001/ws`;

function App() {
  const [topic, setTopic] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [latencyReports, setLatencyReports] = useState<LatencyReport[]>([]);
  const [isAvatarActive, setIsAvatarActive] = useState(false);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);

  const streamingTextRef = useRef('');
  // Imperative ref to AvatarVideo — lets us push audio chunks without React re-renders
  const avatarRef = useRef<AvatarVideoHandle>(null);

  const ws = useWebSocket(WS_URL);
  const mic = useMicrophone();

  useEffect(() => {
    ws.onMessage((msg) => {
      switch (msg.type) {
        case 'transcript':
          if (msg.is_final && msg.text?.trim()) {
            setMessages((prev) => [...prev, { role: 'user', text: msg.text }]);
            setInterimTranscript('');
            setStreamingText('');
            streamingTextRef.current = '';
          } else if (!msg.is_final) {
            setInterimTranscript(msg.text || '');
          }
          break;

        case 'token':
          streamingTextRef.current += msg.text;
          setStreamingText(streamingTextRef.current);
          break;

        case 'audio':
          // Push PCM audio directly to Simli via imperative handle — no state update,
          // no re-render, no queue accumulation. This is the low-latency path.
          setIsAvatarActive(true);
          avatarRef.current?.sendAudio(msg.data);
          break;

        case 'response_end':
          if (streamingTextRef.current.trim()) {
            setMessages((prev) => [...prev, { role: 'assistant', text: streamingTextRef.current }]);
          }
          setStreamingText('');
          streamingTextRef.current = '';
          setTimeout(() => setIsAvatarActive(false), 1000);
          break;

        case 'latency':
          setLatencyReports((prev) => [...prev, msg as unknown as LatencyReport]);
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

  return (
    <div style={{ minHeight: '100vh', background: '#0f0f23', color: '#e0e0e0', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: '16px 24px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 24 }}>🎓</span>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>AI Tutor</h1>
        <span style={{ fontSize: 12, color: '#888', marginLeft: 'auto' }}>by Nerdy / Varsity Tutors</span>
      </header>

      {!topic ? (
        <div style={{ maxWidth: 700, margin: '80px auto', textAlign: 'center', padding: 24 }}>
          <h2 style={{ marginBottom: 8 }}>What would you like to learn today?</h2>
          <p style={{ color: '#888', marginBottom: 32 }}>Pick a topic and start talking. Your AI tutor will guide you using the Socratic method.</p>
          <TopicSelector selected={topic} onSelect={setTopic} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, padding: 16, height: 'calc(100vh - 65px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* AvatarVideo holds the Simli WebRTC session for the lifetime of this view */}
            <AvatarVideo ref={avatarRef} isActive={isAvatarActive} />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0a0a1a', borderRadius: 12, border: '1px solid #222', overflow: 'hidden' }}>
              <ChatDisplay messages={messages} interimTranscript={interimTranscript} streamingText={streamingText} />
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {!mic.isRecording ? (
                <button
                  onClick={handleStart}
                  style={{ padding: '12px 32px', borderRadius: 10, border: 'none', background: '#00d4ff', color: '#000', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}
                >
                  Start Tutoring Session
                </button>
              ) : (
                <button
                  onClick={handleStop}
                  style={{ padding: '12px 32px', borderRadius: 10, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}
                >
                  End Session
                </button>
              )}
              <MicSelector selectedDeviceId={micDeviceId} onSelect={setMicDeviceId} />
              <span style={{ fontSize: 12, color: mic.isRecording ? '#22c55e' : '#888' }}>
                {mic.isRecording ? '● Recording' : 'Microphone off'}
              </span>
              <button
                onClick={() => { setTopic(null); handleStop(); setMessages([]); setLatencyReports([]); }}
                style={{ marginLeft: 'auto', padding: '8px 16px', borderRadius: 8, border: '1px solid #333', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 12 }}
              >
                Change Topic
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <LatencyDashboard reports={latencyReports} />
            <div style={{ padding: 16, background: '#1a1a2e', borderRadius: 12, fontSize: 12, color: '#888' }}>
              <h4 style={{ margin: '0 0 8px', color: '#e0e0e0' }}>Current Topic</h4>
              <p style={{ margin: 0 }}>{topic === 'fractions' ? 'Fractions (6th Grade)' : topic === 'mitosis' ? 'Cell Biology — Mitosis (8th Grade)' : 'Algebra — Solving for x (9th Grade)'}</p>
              <h4 style={{ margin: '16px 0 8px', color: '#e0e0e0' }}>Method</h4>
              <p style={{ margin: 0 }}>Socratic — the tutor guides through questions, never gives direct answers.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
