/**
 * Run all eval suites and print a summary report.
 *
 * Usage:
 *   npm run eval:all                   # manual mode
 *   CI=true npm run eval:all           # CI mode — JSON + exit code
 */
import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_CI = process.env.CI === 'true';
const serverRoot = resolve(__dirname, '../../..');

const EVALS = [
  { name: 'Unit Tests (no API)', cmd: 'npx vitest run' },
  { name: 'LLM Socratic Quality', cmd: 'tsx src/evals/llm-eval.ts' },
  { name: 'Latency Benchmarks', cmd: 'tsx src/evals/latency-eval.ts' },
  { name: 'Lip-Sync Accuracy', cmd: 'tsx src/evals/lipsync-eval.ts' },
  { name: 'E2E Pipeline Health', cmd: 'tsx src/evals/e2e-eval.ts' },
];

interface EvalResult {
  name: string;
  passed: boolean;
  output: string;
}

async function runAll() {
  if (!IS_CI) {
    console.log(chalk.bold.white('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.white('║   NERDY AI TUTOR — FULL EVAL SUITE   ║'));
    console.log(chalk.bold.white('╚══════════════════════════════════════╝\n'));
  }

  const results: EvalResult[] = [];

  for (const eval_ of EVALS) {
    if (!IS_CI) process.stdout.write(`  Running ${eval_.name}... `);
    try {
      const output = execSync(eval_.cmd, {
        cwd: serverRoot,
        env: { ...process.env, CI: 'true' },
        timeout: 90_000,
        stdio: 'pipe',
      }).toString();
      results.push({ name: eval_.name, passed: true, output });
      if (!IS_CI) console.log(chalk.green('✅'));
    } catch (err: any) {
      const output: string = err.stdout?.toString() || err.stderr?.toString() || err.message;
      results.push({ name: eval_.name, passed: false, output });
      if (!IS_CI) {
        console.log(chalk.red('❌'));
        // Show the failing output indented
        output.split('\n').slice(0, 10).forEach((line: string) => {
          console.log(chalk.gray('    ' + line));
        });
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;

  if (IS_CI) {
    console.log(
      JSON.stringify(
        {
          allPassed,
          passed,
          total,
          results: results.map((r) => ({ name: r.name, passed: r.passed })),
        },
        null,
        2,
      ),
    );
    process.exit(allPassed ? 0 : 1);
  } else {
    console.log(chalk.bold(`\n📊 Results: ${passed}/${total} eval suites passed`));
    console.log(allPassed ? chalk.bold.green('\n🎉 All evals passed!') : chalk.bold.red('\n🚨 Some evals failed — check output above'));
  }
}

runAll().catch(console.error);
