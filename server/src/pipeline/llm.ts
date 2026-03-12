/**
 * LLM module — Groq streaming with Socratic constraint enforcement.
 *
 * Accepts: transcript, concept, conversationHistory, optional session context
 * Returns: async generator that yields tokens as they arrive
 */
import Groq from 'groq-sdk';

// ── Concept → grade mapping ───────────────────────────────────────────────────
const CONCEPT_META: Record<string, { grade: string; display: string }> = {
  fractions: { grade: '6th', display: 'Fractions' },
  mitosis:   { grade: '8th', display: 'Cell Biology — Mitosis' },
  algebra:   { grade: '9th', display: 'Algebra — Solving for x' },
};

// ── FIX 6: Session context injected per call ──────────────────────────────────
export interface SessionContext {
  hintLevel: number;          // 0 = question only, 1 = add hint, 2 = partial example
  conceptsMastered: string[]; // e.g. ["what a fraction is"]
  mistakePatterns: string[];  // e.g. ["confuses numerator and denominator"]
  answerVerdict?: 'correct' | 'incorrect' | 'unknown'; // pre-verified by verifyStudentAnswer()
}

function buildSystemPrompt(concept: string, ctx?: SessionContext): string {
  const meta = CONCEPT_META[concept.toLowerCase()] ?? { grade: '7th', display: concept };

  const lines = [
    `You are a Socratic tutor teaching ${meta.display} to a ${meta.grade} grader. Spoken responses only — no markdown.`,
    '',
    'RULES (all mandatory):',
    '- Max 2 sentences. Always end with exactly one question ending in "?".',
    '- Never give the answer. Guide discovery.',
    '- Frustrated ("I don\'t get it", "I give up", etc.): empathize first, then give analogy, then easier question.',
    `- Hint level ${ctx?.hintLevel ?? 0}: ${(ctx?.hintLevel ?? 0) === 0 ? 'guiding question only' : (ctx?.hintLevel ?? 0) === 1 ? 'add a specific hint' : 'give partial worked example, ask student to complete'}.`,
  ];

  // Inject pre-verified verdict so the main LLM never has to judge correctness itself
  if (ctx?.answerVerdict === 'correct') {
    lines.push('- VERIFIED: The student\'s answer is mathematically CORRECT. Affirm in 1 sentence, then advance with a new question.');
  } else if (ctx?.answerVerdict === 'incorrect') {
    lines.push('- VERIFIED: The student\'s answer is mathematically INCORRECT. Say "Interesting — let\'s look at why..." then guide with a hint.');
  } else {
    lines.push('- Correct: affirm in 1 sentence, then advance. When in doubt, assume the student is correct.');
    lines.push('- Wrong: ONLY say "Interesting — let\'s look at why..." if you are CERTAIN the answer is wrong.');
  }

  if (ctx) {
    if (ctx.conceptsMastered.length > 0) lines.push(`- Already mastered: ${ctx.conceptsMastered.join(', ')}`);
    if (ctx.mistakePatterns.length > 0) lines.push(`- Known mistakes: ${ctx.mistakePatterns.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Fast pre-verification step: determines if the student's answer is mathematically
 * correct BEFORE the main streaming call. Runs in parallel with TTS connect so
 * added latency is near zero. Returns 'unknown' if the input isn't an answer attempt.
 */
export async function verifyStudentAnswer(
  transcript: string,
  concept: string,
  conversationHistory: ChatMessage[],
): Promise<'correct' | 'incorrect' | 'unknown'> {
  const lastQuestion = conversationHistory.length > 0
    ? conversationHistory[conversationHistory.length - 1].content
    : '';

  const prompt = `You are a math verifier. Answer with exactly one word.

Topic: ${concept}
${lastQuestion ? `Question asked: "${lastQuestion}"` : ''}
Student answered: "${transcript}"

Is the student's answer mathematically correct? Reply with exactly one word: correct, incorrect, or unknown (if the input is not an answer attempt, is conversational, or you cannot determine correctness).`;

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('verify timeout')), 2000));
    const completion = await Promise.race([
      getGroq().chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5,
        temperature: 0,
      }),
      timeout,
    ]);
    const reply = (completion.choices[0].message.content ?? '').toLowerCase().trim();
    if (reply.startsWith('incorrect')) return 'incorrect';
    if (reply.startsWith('correct')) return 'correct';
    return 'unknown';
  } catch {
    return 'unknown'; // non-fatal — main LLM proceeds without verdict
  }
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

/**
 * Stream LLM tokens for a student utterance.
 *
 * @param transcript        The student's speech (current turn)
 * @param concept           Topic key: 'fractions' | 'mitosis' | 'algebra'
 * @param conversationHistory  Prior user+assistant turns (no system message)
 * @param externalSignal    Optional AbortSignal for barge-in interruption
 * @param sessionContext    Optional session state for hint escalation (FIX 6)
 * @yields  Each token string as it arrives from Groq
 */
export async function* streamLLM(
  transcript: string,
  concept: string,
  conversationHistory: ChatMessage[],
  externalSignal?: AbortSignal,
  sessionContext?: SessionContext,
): AsyncGenerator<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemPrompt(concept, sessionContext) },
    ...conversationHistory,
    { role: 'user', content: transcript },
  ];

  const t0 = Date.now();
  let firstTokenMs = -1;
  let fullResponse = '';

  // Combine 12s hard timeout with optional external abort (barge-in)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('LLM timeout')), 8000);
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
  }

  const stream = await getGroq().chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages,
    stream: true,
    max_tokens: 60,
    temperature: 0.7,
  }, { signal: controller.signal });

  try {
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
  } finally {
    clearTimeout(timeoutId);
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
      `first_token=${firstTokenMs}ms  chars=${trimmed.length}  hintLevel=${sessionContext?.hintLevel ?? 0}`,
    );
  }
}

/**
 * After each completed student→tutor exchange, call the LLM a second time
 * with a structured extraction prompt to update session state.
 *
 * Fire-and-forget — does NOT block the audio pipeline. Returns updated session
 * metadata. On JSON parse failure, returns the current state unchanged.
 */
export async function extractSessionUpdate(
  studentUtterance: string,
  tutorResponse: string,
  topic: string,
  currentState: {
    conceptsMastered: string[];
    mistakePatterns: string[];
    attemptCountOnCurrentConcept: number;
  },
): Promise<{
  conceptsMastered: string[];
  mistakePatterns: string[];
  wasCorrect: boolean;
  newConcept: string | null;
  newMistake: string | null;
}> {
  const prompt = `You are analyzing a tutoring exchange. Respond ONLY with valid JSON — no explanation, no markdown, no preamble.

Topic: ${topic}
Student said: "${studentUtterance}"
Tutor responded: "${tutorResponse}"

Current mastered concepts: ${JSON.stringify(currentState.conceptsMastered)}
Current mistake patterns: ${JSON.stringify(currentState.mistakePatterns)}

Respond with this exact JSON shape:
{
  "wasCorrect": true,
  "newConcept": "short description or null",
  "newMistake": "short description or null",
  "conceptsMastered": ["full updated array"],
  "mistakePatterns": ["full updated array"]
}

Rules:
- "wasCorrect" true only if student demonstrated clear understanding
- "newConcept" / "newMistake" must be 5 words or less, or null
- Never add a concept if student was wrong; never add a mistake if student was correct
- Keep each array to max 5 items, drop oldest if over limit`;

  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0,
    });

    const raw = completion.choices[0].message.content || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Session Extraction] Failed to parse LLM JSON:', err);
    return {
      wasCorrect: false,
      newConcept: null,
      newMistake: null,
      conceptsMastered: currentState.conceptsMastered,
      mistakePatterns: currentState.mistakePatterns,
    };
  }
}
