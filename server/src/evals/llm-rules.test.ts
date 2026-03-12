/**
 * Unit tests for Socratic scoring rules.
 * Pure logic — no API keys, no network. Safe for CI.
 */
import { describe, it, expect } from 'vitest';

// ── Rule implementations (mirrors llm-eval.ts) ────────────────────────────────

function endsWithQuestion(text: string): boolean {
  return text.trim().endsWith('?');
}

function maxTwoSentences(text: string): boolean {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length <= 3;
}

function noMarkdown(text: string): boolean {
  return !/(\*\*|__|#{1,6}|\- |\d+\. |```)/g.test(text);
}

function noWrongOrIncorrect(text: string): boolean {
  return !/\b(wrong|incorrect|no that's not right)\b/gi.test(text);
}

function empathyOnFrustration(response: string, studentInput: string): boolean {
  const frustrated = ["i don't get it", "i give up", 'this is hard', "i'm confused"].some((t) =>
    studentInput.toLowerCase().includes(t),
  );
  if (!frustrated) return true;
  return ['tricky', 'not alone', "let's back up", "that's okay", 'makes sense that'].some((w) =>
    response.toLowerCase().includes(w),
  );
}

function noDirectAnswer(text: string, answerKeywords: string[]): boolean {
  const lower = text.toLowerCase();
  return !answerKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Socratic Rule: endsWithQuestion', () => {
  it('passes when response ends with ?', () => {
    expect(endsWithQuestion('What do you think?')).toBe(true);
  });
  it('fails when response ends with period', () => {
    expect(endsWithQuestion('That is correct.')).toBe(false);
  });
  it('fails when response ends with exclamation', () => {
    expect(endsWithQuestion('Great job!')).toBe(false);
  });
  it('trims trailing whitespace before checking', () => {
    expect(endsWithQuestion('What do you think?  ')).toBe(true);
  });
});

describe('Socratic Rule: maxTwoSentences', () => {
  it('passes with one sentence', () => {
    expect(maxTwoSentences('What do you think?')).toBe(true);
  });
  it('passes with two sentences', () => {
    expect(maxTwoSentences('Interesting. What do you think?')).toBe(true);
  });
  it('passes with three sentences (allowed flexibility)', () => {
    expect(maxTwoSentences('That makes sense. Let me ask you something. What happens next?')).toBe(true);
  });
  it('fails with four sentences', () => {
    expect(maxTwoSentences('One. Two. Three. Four?')).toBe(false);
  });
});

describe('Socratic Rule: noMarkdown', () => {
  it('passes for plain text', () => {
    expect(noMarkdown('What do you think?')).toBe(true);
  });
  it('fails for bold text', () => {
    expect(noMarkdown('This is **important**. What do you think?')).toBe(false);
  });
  it('fails for bullet points', () => {
    expect(noMarkdown('- First point\n- Second point')).toBe(false);
  });
  it('fails for headings', () => {
    expect(noMarkdown('## Step 1\nWhat do you think?')).toBe(false);
  });
  it('fails for numbered lists', () => {
    expect(noMarkdown('1. First\n2. Second')).toBe(false);
  });
});

describe('Socratic Rule: noWrongOrIncorrect', () => {
  it('passes for redirect language', () => {
    expect(noWrongOrIncorrect("Interesting — let's look at that differently. What if we tried?")).toBe(true);
  });
  it('fails for "wrong"', () => {
    expect(noWrongOrIncorrect("That's wrong. Try again.")).toBe(false);
  });
  it('fails for "incorrect"', () => {
    expect(noWrongOrIncorrect('That is incorrect.')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(noWrongOrIncorrect('WRONG answer.')).toBe(false);
  });
});

describe('Socratic Rule: empathyOnFrustration', () => {
  it('passes when student is not frustrated', () => {
    expect(empathyOnFrustration('What happens next?', 'Maybe it divides?')).toBe(true);
  });
  it('passes when frustrated and empathy present', () => {
    expect(empathyOnFrustration("That's a tricky part — you're not alone.", "I don't get it")).toBe(true);
  });
  it('passes with "let\'s back up" empathy phrase', () => {
    expect(empathyOnFrustration("Let's back up for a second. What do you know?", 'I give up')).toBe(true);
  });
  it('fails when frustrated but no empathy', () => {
    expect(empathyOnFrustration('What do you think the answer is?', 'I give up')).toBe(false);
  });
  it('fails when frustrated and response jumps straight to teaching', () => {
    expect(empathyOnFrustration('Think about dividing a pizza into equal slices. How many slices?', "I don't get it")).toBe(false);
  });
});

describe('Socratic Rule: noDirectAnswer', () => {
  it('passes when no keywords present', () => {
    expect(noDirectAnswer('What do you think the top number represents?', ['numerator', 'denominator'])).toBe(true);
  });
  it('fails when answer keyword is leaked', () => {
    expect(noDirectAnswer('The numerator is the top number.', ['numerator', 'denominator'])).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(noDirectAnswer('The NUMERATOR is the top number.', ['numerator'])).toBe(false);
  });
  it('passes with empty keyword list', () => {
    expect(noDirectAnswer('What do you think?', [])).toBe(true);
  });
});
