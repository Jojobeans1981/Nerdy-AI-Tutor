/** Per-interaction latency tracker for every pipeline stage */
export interface LatencyReport {
  interaction_id: string;
  stt_ms: number;
  llm_first_token_ms: number;
  tts_first_byte_ms: number;
  avatar_render_ms: number;
  total_ms: number;
  timestamp: number;
}

export class LatencyTracker {
  private start = 0;
  private marks: Record<string, number> = {};
  private sttMsOverride: number | null = null;
  public interaction_id: string;

  constructor(interaction_id: string) {
    this.interaction_id = interaction_id;
    this.start = performance.now();
  }

  mark(stage: string): void {
    this.marks[stage] = performance.now();
  }

  /** Inject the true STT duration measured by the STT module (first audio → speech_final) */
  setSttMs(ms: number): void {
    this.sttMsOverride = ms;
  }

  report(): LatencyReport {
    const now = performance.now();
    return {
      interaction_id: this.interaction_id,
      stt_ms: this.sttMsOverride ?? this.delta('stt_end'),
      llm_first_token_ms: this.delta('llm_first_token'),
      tts_first_byte_ms: this.delta('tts_first_byte'),
      avatar_render_ms: this.delta('avatar_render'),
      total_ms: Math.round(now - this.start),
      timestamp: Date.now(),
    };
  }

  private delta(key: string): number {
    const val = this.marks[key];
    return val ? Math.round(val - this.start) : -1;
  }
}

// In-memory ring buffer of recent reports for dashboard
const MAX_REPORTS = 200;
const reports: LatencyReport[] = [];

export function storeReport(r: LatencyReport): void {
  reports.push(r);
  if (reports.length > MAX_REPORTS) reports.shift();
}

export function getReports(): LatencyReport[] {
  return reports;
}

/** Update avatar_render_ms on an already-stored report when the client sends it back */
export function updateAvatarRender(interaction_id: string, render_ms: number): void {
  const r = reports.find(x => x.interaction_id === interaction_id);
  if (r && render_ms > 0) r.avatar_render_ms = render_ms;
}
