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
  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {messages.map((msg, i) => (
        <div
          key={i}
          style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            background: msg.role === 'user' ? '#16213e' : '#1a1a2e',
            border: `1px solid ${msg.role === 'user' ? '#00d4ff33' : '#33333380'}`,
            padding: '10px 14px',
            borderRadius: 12,
            maxWidth: '80%',
            color: '#e0e0e0',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {msg.text}
        </div>
      ))}
      {streamingText && (
        <div
          style={{
            alignSelf: 'flex-start',
            background: '#1a1a2e',
            border: '1px solid #33333380',
            padding: '10px 14px',
            borderRadius: 12,
            maxWidth: '80%',
            color: '#e0e0e0',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {streamingText}
          <span style={{ opacity: 0.5, animation: 'blink 1s infinite' }}>|</span>
        </div>
      )}
      {interimTranscript && (
        <div
          style={{
            alignSelf: 'flex-end',
            padding: '8px 12px',
            color: '#888',
            fontSize: 13,
            fontStyle: 'italic',
          }}
        >
          {interimTranscript}...
        </div>
      )}
    </div>
  );
}
