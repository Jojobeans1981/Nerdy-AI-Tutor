/**
 * VisualAid — concept-specific diagrams to support Socratic tutoring.
 * Each topic gets a relevant illustration the student can reference.
 */

interface Props {
  topic: string;
}

export function VisualAid({ topic }: Props) {
  return (
    <div className="glass" style={{ padding: 16, fontSize: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#475569', marginBottom: 12 }}>
        Visual Reference
      </div>
      {topic === 'fractions' && <FractionsAid />}
      {topic === 'mitosis' && <MitosisAid />}
      {topic === 'algebra' && <AlgebraAid />}
    </div>
  );
}

function FractionsAid() {
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 10 }}>Parts of a Fraction</div>
      <svg viewBox="0 0 200 110" width="100%" style={{ display: 'block' }}>
        {/* Fraction bar */}
        <text x="90" y="38" textAnchor="middle" fill="#e2e8f0" fontSize="26" fontWeight="700">3</text>
        <line x1="60" y1="48" x2="120" y2="48" stroke="#00d4ff" strokeWidth="2.5" />
        <text x="90" y="78" textAnchor="middle" fill="#e2e8f0" fontSize="26" fontWeight="700">4</text>
        {/* Labels */}
        <text x="130" y="38" fill="#94a3b8" fontSize="9">← numerator</text>
        <text x="130" y="52" fill="#00d4ff" fontSize="9">← fraction bar</text>
        <text x="130" y="78" fill="#94a3b8" fontSize="9">← denominator</text>
      </svg>
      {/* Pizza diagram */}
      <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 10, marginBottom: 8 }}>
        3 out of 4 equal parts = ¾
      </div>
      <svg viewBox="0 0 160 80" width="100%" style={{ display: 'block' }}>
        {/* 4-slice pizza */}
        {[0, 1, 2, 3].map((i) => {
          const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
          const nextAngle = ((i + 1) / 4) * Math.PI * 2 - Math.PI / 2;
          const cx = 50, cy = 40, r = 34;
          const x1 = cx + r * Math.cos(angle);
          const y1 = cy + r * Math.sin(angle);
          const x2 = cx + r * Math.cos(nextAngle);
          const y2 = cy + r * Math.sin(nextAngle);
          const filled = i < 3;
          return (
            <path
              key={i}
              d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`}
              fill={filled ? 'rgba(0,212,255,0.25)' : 'rgba(255,255,255,0.04)'}
              stroke="rgba(0,212,255,0.5)"
              strokeWidth="1.5"
            />
          );
        })}
        {/* Legend */}
        <rect x="95" y="20" width="12" height="12" fill="rgba(0,212,255,0.25)" stroke="rgba(0,212,255,0.5)" strokeWidth="1" />
        <text x="112" y="30" fill="#94a3b8" fontSize="9">shaded = 3</text>
        <rect x="95" y="38" width="12" height="12" fill="rgba(255,255,255,0.04)" stroke="rgba(0,212,255,0.5)" strokeWidth="1" />
        <text x="112" y="48" fill="#94a3b8" fontSize="9">empty = 1</text>
        <text x="95" y="66" fill="#e2e8f0" fontSize="11" fontWeight="700">3/4 shaded</text>
      </svg>
    </div>
  );
}

function MitosisAid() {
  const phases = ['Prophase', 'Metaphase', 'Anaphase', 'Telophase'];
  const colors = ['#7c3aed', '#00d4ff', '#22c55e', '#f59e0b'];
  const diagrams = [
    // Prophase: chromosomes condensing in nucleus
    (
      <svg key="p" viewBox="0 0 44 44" width="44" height="44">
        <circle cx="22" cy="22" r="18" fill="none" stroke="#475569" strokeWidth="1.5" />
        {[[-4,-6],[4,-6],[-4,0],[4,0],[-4,6],[4,6]].map(([x,y],i) => (
          <line key={i} x1={22+x!-3} y1={22+y!} x2={22+x!+3} y2={22+y!} stroke="#7c3aed" strokeWidth="3" strokeLinecap="round" />
        ))}
      </svg>
    ),
    // Metaphase: chromosomes lined up at center
    (
      <svg key="m" viewBox="0 0 44 44" width="44" height="44">
        <circle cx="22" cy="22" r="18" fill="none" stroke="#475569" strokeWidth="1.5" />
        <line x1="22" y1="8" x2="22" y2="36" stroke="#475569" strokeWidth="1" strokeDasharray="2,2" />
        {[-9,-3,3,9].map((y,i) => (
          <line key={i} x1="19" y1={22+y} x2="25" y2={22+y} stroke="#00d4ff" strokeWidth="3" strokeLinecap="round" />
        ))}
      </svg>
    ),
    // Anaphase: chromosomes pulling apart
    (
      <svg key="a" viewBox="0 0 44 44" width="44" height="44">
        <circle cx="22" cy="22" r="18" fill="none" stroke="#475569" strokeWidth="1.5" />
        {[-9,-3].map((y,i) => (
          <line key={i} x1="19" y1={22+y-4} x2="25" y2={22+y-4} stroke="#22c55e" strokeWidth="3" strokeLinecap="round" />
        ))}
        {[3,9].map((y,i) => (
          <line key={i} x1="19" y1={22+y+4} x2="25" y2={22+y+4} stroke="#22c55e" strokeWidth="3" strokeLinecap="round" />
        ))}
      </svg>
    ),
    // Telophase: two nuclei forming
    (
      <svg key="t" viewBox="0 0 44 44" width="44" height="44">
        <circle cx="22" cy="22" r="18" fill="none" stroke="#475569" strokeWidth="1.5" />
        <ellipse cx="22" cy="14" rx="10" ry="7" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
        <ellipse cx="22" cy="30" rx="10" ry="7" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
        {[-2,2].map((x,i) => (
          <line key={i} x1={22+x} y1="10" x2={22+x} y2="12" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" />
        ))}
        {[-2,2].map((x,i) => (
          <line key={i} x1={22+x} y1="26" x2={22+x} y2="28" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" />
        ))}
      </svg>
    ),
  ];

  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 10 }}>Stages of Mitosis</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {phases.map((phase, i) => (
          <div key={phase} style={{ textAlign: 'center', background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 4px', border: `1px solid ${colors[i]}33` }}>
            {diagrams[i]}
            <div style={{ fontSize: 10, color: colors[i], fontWeight: 600, marginTop: 4 }}>{phase}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {['Interphase → DNA replication', 'PMAT: Pro → Meta → Ana → Telo'].map((note) => (
          <div key={note} style={{ fontSize: 10, color: '#475569' }}>• {note}</div>
        ))}
      </div>
    </div>
  );
}

function AlgebraAid() {
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 10 }}>Solving for x — Balance Method</div>
      <svg viewBox="0 0 200 130" width="100%" style={{ display: 'block' }}>
        {/* Balance beam */}
        <line x1="20" y1="90" x2="180" y2="90" stroke="#475569" strokeWidth="2" />
        <line x1="100" y1="90" x2="100" y2="110" stroke="#475569" strokeWidth="3" />
        <polygon points="85,110 115,110 100,125" fill="#334155" />

        {/* Left pan */}
        <line x1="40" y1="90" x2="40" y2="65" stroke="#475569" strokeWidth="1.5" />
        <rect x="20" y="55" width="40" height="12" rx="3" fill="rgba(0,212,255,0.15)" stroke="rgba(0,212,255,0.4)" strokeWidth="1" />
        <text x="40" y="65" textAnchor="middle" fill="#00d4ff" fontSize="11" fontWeight="700">x + 5</text>

        {/* Right pan */}
        <line x1="160" y1="90" x2="160" y2="65" stroke="#475569" strokeWidth="1.5" />
        <rect x="140" y="55" width="40" height="12" rx="3" fill="rgba(124,58,237,0.15)" stroke="rgba(124,58,237,0.4)" strokeWidth="1" />
        <text x="160" y="65" textAnchor="middle" fill="#7c3aed" fontSize="11" fontWeight="700">12</text>

        {/* Arrow + step */}
        <text x="100" y="28" textAnchor="middle" fill="#94a3b8" fontSize="9">subtract 5 from both sides</text>
        <path d="M 70 34 Q 100 44 130 34" fill="none" stroke="#475569" strokeWidth="1" markerEnd="url(#arrow)" />

        {/* Result */}
        <text x="40" y="46" textAnchor="middle" fill="#00d4ff" fontSize="10">x</text>
        <text x="100" y="46" textAnchor="middle" fill="#94a3b8" fontSize="10">=</text>
        <text x="160" y="46" textAnchor="middle" fill="#7c3aed" fontSize="10">7</text>
      </svg>

      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { step: 'x + 5 = 12', note: 'Original equation' },
          { step: 'x + 5 − 5 = 12 − 5', note: '−5 from both sides' },
          { step: 'x = 7', note: 'Solution' },
        ].map(({ step, note }) => (
          <div key={step} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <code style={{ fontSize: 11, color: '#e2e8f0', fontFamily: 'monospace' }}>{step}</code>
            <span style={{ fontSize: 10, color: '#475569' }}>{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
