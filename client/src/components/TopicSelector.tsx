const TOPICS = [
  { id: 'fractions', label: 'Fractions', grade: '6th Grade', emoji: '🔢' },
  { id: 'mitosis', label: 'Cell Biology — Mitosis', grade: '8th Grade', emoji: '🧬' },
  { id: 'algebra', label: 'Algebra — Solving for x', grade: '9th Grade', emoji: '📐' },
] as const;

interface Props {
  selected: string | null;
  onSelect: (topic: string) => void;
}

export function TopicSelector({ selected, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {TOPICS.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={{
            padding: '12px 20px',
            borderRadius: 10,
            border: selected === t.id ? '2px solid #00d4ff' : '2px solid #333',
            background: selected === t.id ? '#16213e' : '#0f0f23',
            color: '#e0e0e0',
            cursor: 'pointer',
            fontSize: 14,
            transition: 'all 0.2s',
          }}
        >
          <span style={{ fontSize: 20 }}>{t.emoji}</span>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{t.label}</div>
          <div style={{ fontSize: 11, color: '#888' }}>{t.grade}</div>
        </button>
      ))}
    </div>
  );
}
