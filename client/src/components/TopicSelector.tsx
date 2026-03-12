const TOPICS = [
  {
    id: 'fractions',
    label: 'Fractions',
    grade: '6th Grade',
    emoji: '🔢',
    accent: 'var(--mirra-reflect)',
    glow: 'rgba(62,207,207,0.15)',
    desc: 'What does it mean to divide something equally?',
  },
  {
    id: 'mitosis',
    label: 'Cell Biology',
    subtitle: 'Mitosis',
    grade: '8th Grade',
    emoji: '🧬',
    accent: 'var(--mirra-accent)',
    glow: 'rgba(108,99,255,0.15)',
    desc: 'How does one cell become two — and why does it matter?',
  },
  {
    id: 'algebra',
    label: 'Algebra',
    subtitle: 'Solving for x',
    grade: '9th Grade',
    emoji: '📐',
    accent: 'var(--mirra-accent-soft)',
    glow: 'rgba(139,132,255,0.15)',
    desc: 'What stays balanced when both sides change?',
  },
] as const;

interface Props {
  selected: string | null;
  onSelect: (topic: string) => void;
}

export function TopicSelector({ selected, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
      {TOPICS.map((t) => {
        const isSelected = selected === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className="topic-card"
            style={{
              width: 200,
              padding: '20px 16px',
              borderRadius: 16,
              border: `1px solid ${isSelected ? t.accent : 'rgba(255,255,255,0.08)'}`,
              background: isSelected ? t.glow : 'rgba(255,255,255,0.03)',
              color: 'var(--mirra-text-primary)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.2s',
              boxShadow: isSelected ? `0 0 24px ${t.glow}` : 'none',
              backdropFilter: 'blur(8px)',
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>{t.emoji}</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: isSelected ? t.accent : 'var(--mirra-text-primary)', marginBottom: 2 }}>
              {t.label}
            </div>
            {'subtitle' in t && (
              <div style={{ fontSize: 12, color: 'var(--mirra-text-secondary)', marginBottom: 6 }}>{t.subtitle}</div>
            )}
            <div style={{
              display: 'inline-block', fontSize: 10, fontWeight: 600,
              letterSpacing: '1px', textTransform: 'uppercase',
              color: t.accent, background: `${t.accent}18`,
              padding: '2px 8px', borderRadius: 20, marginBottom: 10,
            }}>{t.grade}</div>
            <div style={{ fontSize: 12, color: 'var(--mirra-text-secondary)', lineHeight: 1.4 }}>{t.desc}</div>
          </button>
        );
      })}
    </div>
  );
}
