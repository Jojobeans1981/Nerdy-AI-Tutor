import { useEffect, useRef } from 'react';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

interface Props {
  messages: Message[];
  interimTranscript: string;
  streamingText: string;
}

export function ChatDisplay({ messages, interimTranscript, streamingText }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const isEmpty = messages.length === 0 && !streamingText && !interimTranscript;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {isEmpty && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: '#334155', textAlign: 'center', gap: 8,
        }}>
          <div style={{ fontSize: 32, opacity: 0.4 }}>💬</div>
          <div style={{ fontSize: 13 }}>Conversation will appear here</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Press Start Session and begin speaking</div>
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className="msg-enter" style={{
          display: 'flex',
          flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
          alignItems: 'flex-end', gap: 8,
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
            background: msg.role === 'user'
              ? 'rgba(0,212,255,0.2)'
              : 'linear-gradient(135deg, #7c3aed, #ec4899)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
          }}>
            {msg.role === 'user' ? '🎤' : '🤖'}
          </div>
          <div style={{
            maxWidth: '78%', padding: '10px 14px',
            borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: msg.role === 'user' ? 'rgba(0,212,255,0.08)' : 'rgba(124,58,237,0.1)',
            border: msg.role === 'user' ? '1px solid rgba(0,212,255,0.18)' : '1px solid rgba(124,58,237,0.22)',
            color: '#e2e8f0', fontSize: 14, lineHeight: 1.55,
          }}>
            {msg.text}
          </div>
        </div>
      ))}

      {streamingText && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
            background: 'linear-gradient(135deg, #7c3aed, #ec4899)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
          }}>🤖</div>
          <div style={{
            maxWidth: '78%', padding: '10px 14px',
            borderRadius: '16px 16px 16px 4px',
            background: 'rgba(124,58,237,0.1)',
            border: '1px solid rgba(124,58,237,0.22)',
            color: '#e2e8f0', fontSize: 14, lineHeight: 1.55,
          }}>
            {streamingText}
            <span style={{ animation: 'blink 1s step-end infinite', opacity: 0.6, marginLeft: 1 }}>▌</span>
          </div>
        </div>
      )}

      {interimTranscript && (
        <div style={{ display: 'flex', flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 8 }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(0,212,255,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
          }}>🎤</div>
          <div style={{
            maxWidth: '78%', padding: '8px 14px',
            borderRadius: '16px 16px 4px 16px',
            border: '1px dashed rgba(0,212,255,0.18)',
            color: '#64748b', fontSize: 13, fontStyle: 'italic',
          }}>
            {interimTranscript}…
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
