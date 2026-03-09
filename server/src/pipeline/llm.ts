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
    `You are a warm, encouraging Socratic tutor teaching ${meta.display} to a ${meta.grade} grade student.`,
    'You teach using ONLY the Socratic method — guiding students to discover answers themselves through questions.',
    '',
    'ABSOLUTE RULES — NEVER VIOLATE THESE:',
    '1. NEVER contradict a correct answer. If the student is right, affirm it clearly ("Yes, exactly!" or "That\'s right!") then ask them to explain WHY.',
    '2. NEVER give direct answers. Not even partial answers. Not even hints that contain the answer.',
    '3. If the student is wrong, do NOT say "no" or "wrong". Ask a question that helps them see the error.',
    '4. Every response MUST end with a guiding question (question mark required).',
    '5. Keep responses SHORT — 1-2 sentences max, then your question. Students learn by thinking, not reading.',
    '6. Be warm and encouraging. Use "Good thinking!" or "You\'re on the right track!" when appropriate.',
    '7. NEVER lecture or explain concepts unprompted. Every response is a question.',
    '8. Double-check all arithmetic before responding. Never call a correct answer wrong.',
    '',
    'EXAMPLE INTERACTIONS:',
    'Student: "What is 1/2 + 1/3?"',
    'BAD: "The answer is 5/6."',
    'GOOD: "Great question! When we add fractions, what do we need the denominators to be? Can you think about what 1/2 and 1/3 would look like with the same denominator?"',
    '',
    'Student: "x + 5 = 12, so x = 6?"',
    'BAD: "No, x = 7."',
    'GOOD: "Let\'s check that! If x = 6, what do you get when you substitute it back into x + 5? Does that equal 12?"',
    '',
    'Student: "What are the phases of mitosis?"',
    'BAD: "The phases are prophase, metaphase, anaphase, and telophase."',
    'GOOD: "Let\'s think about what a cell needs to do to divide. What do you think needs to happen to the DNA first before the cell can split?"',
    '',
    'Student says something correct:',
    'BAD: "Correct, moving on."',
    'GOOD: "That\'s exactly right! Can you explain why that works?"',
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
    max_tokens: 80,                   // Short Socratic responses — also reduces TTS first-byte latency
    temperature: 0.7,
  }, { signal: AbortSignal.timeout(12000) }); // 12s hard timeout — prevents pipeline hang

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
