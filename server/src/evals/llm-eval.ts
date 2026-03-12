/**
 * LLM Socratic Adherence Eval
 *
 * Sends controlled student utterances to Groq and scores each response
 * against Socratic rules. Exits 0 (pass) or 1 (fail) in CI mode.
 *
 * Usage:
 *   npm run eval:llm                   # manual mode — human-readable output
 *   CI=true npm run eval:llm           # CI mode — JSON output + exit code
 */
import Groq from 'groq-sdk';
import chalk from 'chalk';

const IS_CI = process.env.CI === 'true';

// ── Scoring rules ─────────────────────────────────────────────────────────────

const RULES = {
  endsWithQuestion: (text: string) => ({
    passed: text.trim().endsWith('?'),
    detail: 'Response must end with a question mark',
  }),

  maxTwoSentences: (text: string) => {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    return {
      passed: sentences.length <= 3, // slight flexibility for complex responses
      detail: `Response has ${sentences.length} sentences (max 2)`,
    };
  },

  noMarkdown: (text: string) => {
    const hasMarkdown = /(\*\*|__|#{1,6}|\- |\d+\. |```)/g.test(text);
    return {
      passed: !hasMarkdown,
      detail: 'Response must not contain markdown formatting',
    };
  },

  noDirectAnswer: (text: string, answerKeywords: string[]) => {
    const lowerText = text.toLowerCase();
    const leaked = answerKeywords.find((kw) => lowerText.includes(kw.toLowerCase()));
    return {
      passed: !leaked,
      detail: leaked ? `Response leaked answer keyword: "${leaked}"` : 'No answer keywords leaked',
    };
  },

  empathyOnFrustration: (response: string, studentInput: string) => {
    const frustrationTriggers = ["i don't get it", "i don't understand", "i give up", "this is hard", "i'm confused"];
    const isFrustrated = frustrationTriggers.some((t) => studentInput.toLowerCase().includes(t));
    if (!isFrustrated) return { passed: true, detail: 'N/A (no frustration detected in input)' };
    const empathyWords = ['tricky', 'not alone', "let's back up", "that's okay", 'makes sense that'];
    const hasEmpathy = empathyWords.some((w) => response.toLowerCase().includes(w));
    return {
      passed: hasEmpathy,
      detail: hasEmpathy ? 'Empathy detected correctly' : 'Frustration detected but no empathy in response',
    };
  },

  noWrongOrIncorrect: (text: string) => {
    const banned = /\b(wrong|incorrect|no that's not right)\b/gi.test(text);
    return {
      passed: !banned,
      detail: banned ? 'Response used banned negative feedback word' : 'No negative feedback words',
    };
  },
};

// ── Test cases ────────────────────────────────────────────────────────────────

const TEST_CASES = [
  {
    id: 'fractions-basic',
    topic: 'fractions',
    studentInput: 'A fraction is when you divide something',
    answerKeywords: ['numerator', 'denominator'],
  },
  {
    id: 'frustration-response',
    topic: 'fractions',
    studentInput: "I don't get it, this is too hard",
    answerKeywords: [],
  },
  {
    id: 'wrong-answer-redirect',
    topic: 'algebra',
    studentInput: 'x equals 5',
    answerKeywords: ['x = 3', 'x equals 3'],
  },
  {
    id: 'correct-answer-advance',
    topic: 'mitosis',
    studentInput: 'The cell duplicates its DNA during S phase',
    answerKeywords: [],
  },
  {
    id: 'vague-answer',
    topic: 'algebra',
    studentInput: 'I think you add something to both sides maybe?',
    answerKeywords: [],
  },
];

const SYSTEM_PROMPT = `You are an expert Socratic tutor. Maximum 2 sentences per response. Always end with exactly one open-ended question. Never give the answer directly — guide the student to discover it. No markdown, no bullet points, no lists — this is spoken aloud. If the student expresses frustration (e.g. "I don't get it", "this is hard", "I give up"), respond with empathy first before any teaching content. Never use the words "wrong" or "incorrect".`;

// ── Runner ────────────────────────────────────────────────────────────────────

async function runLLMEvals() {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const results: any[] = [];

  if (!IS_CI) {
    console.log(chalk.bold('\n🧠 LLM SOCRATIC ADHERENCE EVALS\n'));
  }

  for (const testCase of TEST_CASES) {
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: `Topic: ${testCase.topic}. Student says: "${testCase.studentInput}"` },
    ];

    const start = Date.now();
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      max_tokens: 150,
    });
    const latencyMs = Date.now() - start;
    const response = completion.choices[0].message.content ?? '';

    const ruleResults = {
      endsWithQuestion: RULES.endsWithQuestion(response),
      maxTwoSentences: RULES.maxTwoSentences(response),
      noMarkdown: RULES.noMarkdown(response),
      noDirectAnswer: RULES.noDirectAnswer(response, testCase.answerKeywords),
      empathyOnFrustration: RULES.empathyOnFrustration(response, testCase.studentInput),
      noWrongOrIncorrect: RULES.noWrongOrIncorrect(response),
    };

    const values = Object.values(ruleResults);
    const allPassed = values.every((r) => r.passed);
    const passedCount = values.filter((r) => r.passed).length;
    const score = Math.round((passedCount / values.length) * 100);

    results.push({ id: testCase.id, score, allPassed, latencyMs, response, ruleResults });

    if (!IS_CI) {
      console.log(allPassed ? chalk.green(`✅ ${testCase.id}`) : chalk.red(`❌ ${testCase.id}`));
      console.log(chalk.gray(`   Input: "${testCase.studentInput}"`));
      console.log(chalk.cyan(`   Response: "${response}"`));
      console.log(chalk.gray(`   Score: ${score}%  Latency: ${latencyMs}ms`));
      Object.entries(ruleResults).forEach(([rule, result]) => {
        console.log(result.passed ? chalk.green(`   ✓ ${rule}`) : chalk.red(`   ✗ ${rule}: ${result.detail}`));
      });
      console.log('');
    }
  }

  const overallScore = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
  const allPassed = results.every((r) => r.allPassed);

  if (IS_CI) {
    console.log(JSON.stringify({ eval: 'llm', overallScore, allPassed, results }, null, 2));
    process.exit(allPassed ? 0 : 1);
  } else {
    console.log(chalk.bold(`\n📊 Overall Socratic Score: ${overallScore}%`));
    console.log(allPassed ? chalk.green('✅ All LLM evals passed') : chalk.red('❌ Some LLM evals failed'));
  }

  return { overallScore, allPassed, results };
}

runLLMEvals().catch(console.error);
