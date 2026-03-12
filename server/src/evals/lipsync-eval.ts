/**
 * Avatar Lip-Sync Accuracy Eval
 *
 * Fetches per-frame drift reports from /api/lipsync-report (populated by
 * AvatarVideo.tsx) and asserts average drift is within the ±80ms budget.
 *
 * Usage:
 *   npm run eval:lipsync               # manual mode
 *   CI=true npm run eval:lipsync       # CI mode — JSON + exit code
 */
import chalk from 'chalk';

const IS_CI = process.env.CI === 'true';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

const DRIFT_BUDGET_MS = 80;     // acceptable average lip-sync drift
const EXCEED_RATE_MAX = 10;     // max % of frames allowed to exceed budget

async function runLipsyncEvals() {
  if (!IS_CI) {
    console.log(chalk.bold('\n🎭 AVATAR LIP-SYNC ACCURACY EVALS\n'));
  }

  let reports: any[];
  try {
    const res = await fetch(`${SERVER_URL}/api/lipsync-report`);
    reports = await res.json() as any[];
  } catch {
    if (!IS_CI) {
      console.error(chalk.red('❌ Could not reach server at ' + SERVER_URL));
      console.error(chalk.gray('   Start the server first: cd server && npm run dev'));
    } else {
      console.log(JSON.stringify({ eval: 'lipsync', allPassed: false, error: 'Server unreachable' }));
    }
    process.exit(1);
  }

  if (!reports || reports.length === 0) {
    if (!IS_CI) {
      console.log(chalk.yellow('⚠️  No lip-sync reports found — run sessions first, then re-eval'));
    } else {
      console.log(JSON.stringify({ eval: 'lipsync', allPassed: true, warning: 'No data', sampleCount: 0 }));
    }
    process.exit(0);
  }

  const driftValues = reports
    .map((r) => r.driftMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);

  const avgDrift = Math.round(driftValues.reduce((s, v) => s + v, 0) / driftValues.length);
  const p50Drift = driftValues[Math.floor(0.5 * driftValues.length)];
  const p95Drift = driftValues[Math.ceil(0.95 * driftValues.length) - 1];
  const maxDrift = driftValues[driftValues.length - 1];
  const exceedCount = driftValues.filter((v) => v > DRIFT_BUDGET_MS).length;
  const exceedRate = Math.round((exceedCount / driftValues.length) * 100);

  const avgPassed = avgDrift <= DRIFT_BUDGET_MS;
  const exceedRatePassed = exceedRate <= EXCEED_RATE_MAX;
  const allPassed = avgPassed && exceedRatePassed;

  const results = { avgDrift, p50Drift, p95Drift, maxDrift, exceedRate, avgPassed, exceedRatePassed, sampleCount: driftValues.length };

  if (!IS_CI) {
    console.log(avgPassed ? chalk.green('✅ Average drift within budget') : chalk.red('❌ Average drift exceeds budget'));
    console.log(chalk.gray(`   avg: ${avgDrift}ms (budget: ${DRIFT_BUDGET_MS}ms) ${avgPassed ? '✓' : '✗'}`));
    console.log(chalk.gray(`   p50: ${p50Drift}ms  p95: ${p95Drift}ms  max: ${maxDrift}ms`));
    console.log(chalk.gray(`   frames exceeding budget: ${exceedRate}% (max allowed: ${EXCEED_RATE_MAX}%) ${exceedRatePassed ? '✓' : '✗'}`));
    console.log(chalk.gray(`   sample count: ${driftValues.length}`));
    console.log(allPassed ? chalk.green('\n✅ Lip-sync evals passed') : chalk.red('\n❌ Lip-sync drift exceeds budget'));
  } else {
    console.log(JSON.stringify({ eval: 'lipsync', allPassed, results }, null, 2));
    process.exit(allPassed ? 0 : 1);
  }

  return { allPassed, results };
}

runLipsyncEvals().catch(console.error);
