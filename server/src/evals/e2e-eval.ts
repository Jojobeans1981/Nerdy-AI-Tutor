/**
 * End-to-End Pipeline Health Eval
 *
 * Connects to the running server via WebSocket and drives test scenarios by
 * sending text_input messages (no real mic needed). Asserts that the pipeline
 * completes within time budgets and returns expected message types.
 *
 * Usage:
 *   npm run eval:e2e                   # manual mode
 *   CI=true npm run eval:e2e           # CI mode — JSON + exit code
 */
import WebSocket from 'ws';
import chalk from 'chalk';

const IS_CI = process.env.CI === 'true';
const WS_BASE = process.env.SERVER_URL?.replace('http', 'ws') || 'ws://localhost:3001';

const E2E_SCENARIOS = [
  {
    id: 'session-start',
    topic: 'fractions',
    description: 'First exchange completes within 8s — receives token + response_end',
    studentText: 'What is a fraction?',
    timeoutMs: 8000,
    assertions: ['llm_response_received', 'response_end_received', 'total_under_8000ms'],
  },
  {
    id: 'frustration-flow',
    topic: 'fractions',
    description: 'Student expresses frustration — pipeline returns a response',
    studentText: "I don't get it at all",
    timeoutMs: 8000,
    assertions: ['llm_response_received', 'response_end_received'],
  },
  {
    id: 'text-input-bypass',
    topic: 'algebra',
    description: 'text_input message bypasses STT and runs pipeline',
    studentText: 'How do I solve for x?',
    timeoutMs: 8000,
    assertions: ['llm_response_received', 'response_end_received'],
  },
];

interface AssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface ScenarioResult {
  id: string;
  passed: boolean;
  durationMs: number;
  assertionResults: AssertionResult[];
}

async function runScenario(scenario: typeof E2E_SCENARIOS[number]): Promise<ScenarioResult> {
  const start = Date.now();
  const assertionResults: AssertionResult[] = [];
  const receivedTypes = new Set<string>();
  let durationMs = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws/session?concept=${scenario.topic}`);

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out after ${scenario.timeoutMs}ms`));
      }, scenario.timeoutMs);

      ws.on('open', () => {
        // Use text_input so we don't need real STT/mic
        ws.send(JSON.stringify({ type: 'text_input', text: scenario.studentText }));
      });

      ws.on('message', (raw) => {
        // Binary frames are audio — just note receipt
        if (raw instanceof Buffer && raw[0] === 0x01) {
          receivedTypes.add('audio');
          return;
        }
        try {
          const msg = JSON.parse(raw.toString());
          receivedTypes.add(msg.type);

          if (msg.type === 'response_end') {
            durationMs = Date.now() - start;
            clearTimeout(timeout);
            ws.close();
          }
        } catch { /* not JSON */ }
      });

      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
  } catch (err: any) {
    assertionResults.push({ name: 'scenario_completed', passed: false, detail: err.message });
    return { id: scenario.id, passed: false, durationMs: Date.now() - start, assertionResults };
  }

  durationMs = durationMs || (Date.now() - start);

  for (const assertion of scenario.assertions) {
    switch (assertion) {
      case 'llm_response_received':
        assertionResults.push({
          name: assertion,
          passed: receivedTypes.has('token') || receivedTypes.has('llm_chunk'),
          detail: `received types: ${[...receivedTypes].join(', ')}`,
        });
        break;
      case 'response_end_received':
        assertionResults.push({
          name: assertion,
          passed: receivedTypes.has('response_end'),
          detail: receivedTypes.has('response_end') ? 'response_end received' : 'response_end never arrived',
        });
        break;
      case 'total_under_8000ms':
        assertionResults.push({
          name: assertion,
          passed: durationMs < 8000,
          detail: `${durationMs}ms`,
        });
        break;
      default:
        assertionResults.push({ name: assertion, passed: true, detail: 'not measured in this scenario' });
    }
  }

  const passed = assertionResults.every((ar) => ar.passed);
  return { id: scenario.id, passed, durationMs, assertionResults };
}

async function runE2EEvals() {
  if (!IS_CI) {
    console.log(chalk.bold('\n🔄 END-TO-END PIPELINE HEALTH EVALS\n'));
  }

  // Verify server is reachable before running scenarios
  try {
    await fetch(WS_BASE.replace('ws://', 'http://') + '/api/health');
  } catch {
    if (!IS_CI) {
      console.error(chalk.red('❌ Server not reachable at ' + WS_BASE));
      console.error(chalk.gray('   Start the server: cd server && npm run dev'));
    } else {
      console.log(JSON.stringify({ eval: 'e2e', allPassed: false, error: 'Server unreachable' }));
    }
    process.exit(1);
  }

  const results: ScenarioResult[] = [];

  for (const scenario of E2E_SCENARIOS) {
    if (!IS_CI) console.log(chalk.cyan(`  Running: ${scenario.id}...`));
    const result = await runScenario(scenario);
    results.push(result);

    if (!IS_CI) {
      console.log(result.passed ? chalk.green(`  ✅ ${scenario.id}`) : chalk.red(`  ❌ ${scenario.id}`));
      console.log(chalk.gray(`     ${scenario.description}`));
      result.assertionResults.forEach((ar) => {
        console.log(ar.passed ? chalk.green(`     ✓ ${ar.name}`) : chalk.red(`     ✗ ${ar.name}: ${ar.detail}`));
      });
      console.log(chalk.gray(`     Duration: ${result.durationMs}ms\n`));
    }
  }

  const allPassed = results.every((r) => r.passed);

  if (IS_CI) {
    console.log(JSON.stringify({ eval: 'e2e', allPassed, results }, null, 2));
    process.exit(allPassed ? 0 : 1);
  } else {
    console.log(allPassed ? chalk.green('✅ All E2E evals passed') : chalk.red('❌ Some E2E evals failed'));
  }

  return { allPassed, results };
}

runE2EEvals().catch(console.error);
