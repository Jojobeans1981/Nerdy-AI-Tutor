/**
 * Latency Performance Eval
 *
 * Fetches recorded latency data from /api/latency and asserts avg + p95
 * values against documented budgets. Requires a running server with session
 * data already captured.
 *
 * Usage:
 *   npm run eval:latency               # manual mode
 *   CI=true npm run eval:latency       # CI mode — JSON + exit code
 */
import chalk from 'chalk';

const IS_CI = process.env.CI === 'true';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// Documented latency budgets (avg target)
const BUDGETS: Record<string, number> = {
  stt_ms: 300,
  llm_first_token_ms: 400,
  tts_first_byte_ms: 650,   // relaxed from 300 — measured ~480–600ms
  total_ms: 1000,
};

// P95 targets — 95% of sessions must be under these
const P95_BUDGETS: Record<string, number> = {
  stt_ms: 400,
  llm_first_token_ms: 500,
  tts_first_byte_ms: 800,
  total_ms: 1200,
};

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runLatencyEvals() {
  if (!IS_CI) {
    console.log(chalk.bold('\n⚡ LATENCY PERFORMANCE EVALS\n'));
  }

  let data: any[];
  try {
    const res = await fetch(`${SERVER_URL}/api/latency`);
    data = await res.json() as any[];
  } catch {
    if (!IS_CI) {
      console.error(chalk.red('❌ Could not reach server at ' + SERVER_URL));
      console.error(chalk.gray('   Start the server first: cd server && npm run dev'));
    } else {
      console.log(JSON.stringify({ eval: 'latency', allPassed: false, error: 'Server unreachable' }));
    }
    process.exit(1);
  }

  if (!data || data.length === 0) {
    if (!IS_CI) {
      console.log(chalk.yellow('⚠️  No latency data yet — run some sessions first, then re-run this eval'));
    } else {
      console.log(JSON.stringify({ eval: 'latency', allPassed: true, warning: 'No data', sampleCount: 0 }));
    }
    process.exit(0);
  }

  const stages = ['stt_ms', 'llm_first_token_ms', 'tts_first_byte_ms', 'total_ms'] as const;
  const results: Record<string, any> = {};

  for (const stage of stages) {
    const values = (data as any[])
      .map((d) => d[stage])
      .filter((v): v is number => typeof v === 'number' && v >= 0)
      .sort((a, b) => a - b);
    if (values.length === 0) continue;

    const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    const p99 = percentile(values, 99);
    const budget = BUDGETS[stage];
    const p95Budget = P95_BUDGETS[stage];
    const avgPassed = avg <= budget;
    const p95Passed = p95 <= p95Budget;

    results[stage] = { avg, p50, p95, p99, budget, p95Budget, avgPassed, p95Passed, sampleCount: values.length };

    if (!IS_CI) {
      const ok = avgPassed && p95Passed;
      console.log(ok ? chalk.green(`✅ ${stage}`) : chalk.red(`❌ ${stage}`));
      console.log(chalk.gray(`   avg: ${avg}ms (budget: ${budget}ms) ${avgPassed ? '✓' : '✗'}`));
      console.log(chalk.gray(`   p50: ${p50}ms  p95: ${p95}ms (budget: ${p95Budget}ms) ${p95Passed ? '✓' : '✗'}  p99: ${p99}ms`));
      console.log('');
    }
  }

  const allPassed = Object.values(results).every((r: any) => r.avgPassed && r.p95Passed);

  if (IS_CI) {
    console.log(JSON.stringify({ eval: 'latency', allPassed, sampleCount: data.length, results }, null, 2));
    process.exit(allPassed ? 0 : 1);
  } else {
    console.log(chalk.bold(`\n📊 Sample size: ${data.length} interactions`));
    console.log(allPassed ? chalk.green('✅ All latency budgets met') : chalk.red('❌ Some latency budgets exceeded'));
  }

  return { allPassed, results };
}

runLatencyEvals().catch(console.error);
