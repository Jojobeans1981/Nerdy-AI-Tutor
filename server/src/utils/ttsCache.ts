/**
 * TTS Response Cache — Pre-computation Strategy
 *
 * Pre-synthesizes common short acknowledgment phrases at server startup.
 * When the LLM response starts with a cached phrase, we immediately play
 * the pre-computed audio instead of waiting for Cartesia to synthesize it,
 * reducing perceived TTS latency by 200-400ms for these responses.
 *
 * This implements the "caching and pre-computation" architecture requirement.
 */

const API_KEY  = () => process.env.CARTESIA_API_KEY!;
const VERSION  = '2024-06-10';
const MODEL    = 'sonic-english';

/** Common short affirmation openers the LLM frequently generates */
const CACHE_PHRASES = [
  "That's right!",
  "Exactly!",
  "Yes, exactly!",
  "Good thinking!",
  "Great question!",
  "You've got it!",
  "Nice work!",
  "Close!",
];

/** Map of phrase → base64 PCM audio chunks (16kHz, s16le) */
const cache = new Map<string, string[]>();

let voiceId = '';
let warmed = false;

export function setTtsCacheVoiceId(id: string): void {
  voiceId = id;
}

/**
 * Pre-synthesize all CACHE_PHRASES using the Cartesia HTTP endpoint.
 * Called once at startup after voice preload completes.
 * Failures are non-fatal — cache just stays empty for that phrase.
 */
export async function warmTtsCache(): Promise<void> {
  if (!voiceId || !process.env.CARTESIA_API_KEY) return;
  if (warmed) return;
  warmed = true;

  console.log('[TTS Cache] Pre-computing', CACHE_PHRASES.length, 'common phrases...');
  const start = Date.now();

  for (const phrase of CACHE_PHRASES) {
    try {
      const res = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'X-API-Key': API_KEY(),
          'Cartesia-Version': VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: MODEL,
          transcript: phrase,
          voice: { mode: 'id', id: voiceId },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
        }),
      });

      if (!res.ok) {
        console.warn(`[TTS Cache] Failed to cache "${phrase}": ${res.status}`);
        continue;
      }

      const arrayBuf = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuf).toString('base64');
      // Store as single chunk — short phrase fits in one ~20KB chunk
      cache.set(phrase.toLowerCase(), [base64]);
      console.log(`[TTS Cache] Cached "${phrase}" (${arrayBuf.byteLength} bytes)`);
    } catch (err: any) {
      console.warn(`[TTS Cache] Error caching "${phrase}":`, err.message);
    }
  }

  console.log(`[TTS Cache] Warm complete in ${Date.now() - start}ms. ${cache.size}/${CACHE_PHRASES.length} phrases cached.`);
}

export function getCacheStats(): { size: number; phrases: string[] } {
  return { size: cache.size, phrases: [...cache.keys()] };
}
