import type { LatencyReport } from '../hooks/useWebSocket';

interface Props {
  reports: LatencyReport[];
}

function avg(nums: number[]): string {
  const valid = nums.filter((n) => n >= 0);
  if (valid.length === 0) return '--';
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length).toString();
}

function badge(ms: number, limit: number): string {
  if (ms < 0) return 'gray';
  return ms <= limit ? '#22c55e' : '#ef4444';
}

export function LatencyDashboard({ reports }: Props) {
  const last = reports[reports.length - 1];
  const last10 = reports.slice(-10);

  return (
    <div style={{ padding: 16, background: '#1a1a2e', borderRadius: 12, color: '#e0e0e0', fontFamily: 'monospace', fontSize: 13 }}>
      <h3 style={{ margin: '0 0 12px', color: '#00d4ff' }}>Pipeline Latency</h3>
      {!last ? (
        <p style={{ color: '#888' }}>Waiting for first interaction...</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #333' }}>
                <th style={{ textAlign: 'left', padding: 4 }}>Stage</th>
                <th style={{ textAlign: 'right', padding: 4 }}>Last</th>
                <th style={{ textAlign: 'right', padding: 4 }}>Budget</th>
                <th style={{ textAlign: 'right', padding: 4 }}>Avg(10)</th>
              </tr>
            </thead>
            <tbody>
              <Row label="STT" ms={last.stt_ms} limit={300} avg={avg(last10.map((r) => r.stt_ms))} />
              <Row label="LLM 1st tok" ms={last.llm_first_token_ms} limit={400} avg={avg(last10.map((r) => r.llm_first_token_ms))} />
              <Row label="TTS 1st byte" ms={last.tts_first_byte_ms} limit={300} avg={avg(last10.map((r) => r.tts_first_byte_ms))} />
              <Row label="Avatar" ms={last.avatar_render_ms} limit={200} avg={avg(last10.map((r) => r.avatar_render_ms))} />
              <Row label="Total" ms={last.total_ms} limit={1000} avg={avg(last10.map((r) => r.total_ms))} bold />
            </tbody>
          </table>
          <p style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
            Interactions: {reports.length}
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, ms, limit, avg: avgStr, bold }: { label: string; ms: number; limit: number; avg: string; bold?: boolean }) {
  const color = badge(ms, limit);
  const style = bold ? { fontWeight: 'bold' as const } : {};
  return (
    <tr style={{ borderBottom: '1px solid #222', ...style }}>
      <td style={{ padding: 4 }}>{label}</td>
      <td style={{ padding: 4, textAlign: 'right' as const, color }}>{ms >= 0 ? `${ms}ms` : '--'}</td>
      <td style={{ padding: 4, textAlign: 'right' as const, color: '#888' }}>{`<${limit}ms`}</td>
      <td style={{ padding: 4, textAlign: 'right' as const }}>{avgStr}ms</td>
    </tr>
  );
}
