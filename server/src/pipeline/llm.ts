/**
 * LLM module — Groq streaming with Socratic constraint enforcement.
 *
 * Accepts: transcript, concept, conversationHistory
 * Returns: async generator that yields tokens as they arrive
 * Logs: llm_first_token_ms, Socratic violations
 */
import Groq from 'groq-sdk';

// ── Concept → grade mapping ───────────────────────────────────────────────────
const CONCEPT_META: Record<string, { grade: string; display: string }> = {
  fractions: { grade: '6th', display: 'Fractions' },
  mitosis:   { grade: '8th', display: 'Cell Biology — Mitosis' },
  algebra:   { grade: '9th', display: 'Algebra — Solving for x' },
};

function buildSystemPrompt(concept: string): string {
  const meta = CONCEPT_META[concept.toLowerCase()] ?? { grade: '7th', display: concept };
  return [
    `You are a patient, encouraging tutor teaching ${meta.display} to a ${meta.grade} grade student.`,
    '',
    'RULES YOU MUST FOLLOW:',
    '1. NEVER give direct answers. Always respond with a guiding question.',
    '2. Every response MUST end with a question mark.',
    '3. If the student is wrong, ask a question that helps them find the error.',
    '4. If the student is right, ask them to explain WHY.',
    '5. Keep responses under 2 sentences + 1 question.',
    '6. Use simple, age-appropriate language.',
    '',
    'VIOLATION OF THESE RULES IS NOT PERMITTED UNDER ANY CIRCUMSTANCES.',
  ].join('\n');
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── Groq singleton ────────────────────────────────────────────────────────────
let groqClient: Groq | null = null;
function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

// ── Socratic test scenarios (logged at startup for verification) ──────────────
export const SOCRATIC_TEST_SCENARIOS = [
  { label: 'Direct question',  input: 'What is mitosis?' },
  { label: 'Random answer',    input: 'The answer is 42.' },
  { label: 'Wrong answer',     input: '1/2 + 1/3 = 2/5' },
] as const;

/**
 * Stream LLM tokens for a student utterance.
 *
 * @param transcript        The student's speech (current turn)
 * @param concept           Topic key: 'fractions' | 'mitosis' | 'algebra'
 * @param conversationHistory  Prior user+assistant turns (no system message)
 * @yields  Each token string as it arrives from Groq
 */
export async function* streamLLM(
  transcript: string,
  concept: string,
  conversationHistory: ChatMessage[],
): AsyncGenerator<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemPrompt(concept) },
    ...conversationHistory,
    { role: 'user', content: transcript },
  ];

  const t0 = Date.now();
  let firstTokenMs = -1;
  let fullResponse = '';

  const stream = await getGroq().chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages,
    stream: true,
    max_tokens: 80,                   // Socratic responses are 1-2 sentences; less = faster
    temperature: 0.7,
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (!token) continue;

    if (firstTokenMs === -1) {
      firstTokenMs = Date.now() - t0;
      console.log(`[LLM] First token: ${firstTokenMs}ms  concept=${concept}`);
    }

    fullResponse += token;
    yield token;
  }

  // ── Socratic constraint validation ────────────────────────────────────────
  const trimmed = fullResponse.trim();
  if (!trimmed.endsWith('?')) {
    console.warn(
      `[LLM] ⚠ SOCRATIC VIOLATION — response does not end with '?'\n` +
      `  concept="${concept}"  transcript="${transcript.slice(0, 60)}"\n` +
      `  tail: "...${trimmed.slice(-80)}"`,
    );
  } else {
    console.log(
      `[LLM] ✓ Socratic OK  concept=${concept}  ` +
      `first_token=${firstTokenMs}ms  chars=${trimmed.length}`,
    );
  }
}
