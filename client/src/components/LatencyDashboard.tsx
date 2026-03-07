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
    <div className="glass" style={{ padding: 16, color: '#e2e8f0', fontSize: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#475569', marginBottom: 14 }}>
        Pipeline Latency
      </div>
      {!last ? (
        <div style={{ color: '#334155', fontSize: 12 }}>Waiting for first interaction…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row label="STT endpoint" ms={last.stt_ms} limit={300} avg={avg(last10.map((r) => r.stt_ms))} tooltip="Deepgram endpointing delay — silence after last word → speech_final. ~200ms by config." />
            <Row label="LLM 1st tok" ms={last.llm_first_token_ms} limit={400} avg={avg(last10.map((r) => r.llm_first_token_ms))} />
            <Row label="TTS 1st byte" ms={last.tts_first_byte_ms} limit={300} avg={avg(last10.map((r) => r.tts_first_byte_ms))} />
            <Row label="Avatar" ms={last.avatar_render_ms} limit={200} avg={avg(last10.map((r) => r.avatar_render_ms))} />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '2px 0' }} />
            <Row label="Total" ms={last.total_ms} limit={1000} avg={avg(last10.map((r) => r.total_ms))} bold />
          </div>
          <div style={{ marginTop: 10, fontSize: 10, color: '#334155' }}>
            {reports.length} interaction{reports.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, ms, limit, avg: avgStr, bold, tooltip }: { label: string; ms: number; limit: number; avg: string; bold?: boolean; tooltip?: string }) {
  const color = badge(ms, limit);
  return (
    <div title={tooltip} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'monospace', fontWeight: bold ? 700 : 400, cursor: tooltip ? 'help' : undefined }}>
      <span style={{ flex: 1, color: '#64748b', fontSize: 11 }}>{label}</span>
      <span style={{ minWidth: 52, textAlign: 'right', color: ms >= 0 ? color : '#334155', fontSize: 12 }}>
        {ms >= 0 ? `${ms}ms` : '--'}
      </span>
      <span style={{ minWidth: 42, textAlign: 'right', color: '#334155', fontSize: 10 }}>{`<${limit}`}</span>
      <span style={{ minWidth: 42, textAlign: 'right', color: '#475569', fontSize: 10 }}>{avgStr}avg</span>
    </div>
  );
}
