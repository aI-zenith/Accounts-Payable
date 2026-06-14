import Anthropic from '@anthropic-ai/sdk';
import { getCredentials } from './credentials.js';

// AI "Polish" rewrite for task descriptions and comments. Runs server-side so
// the API key never reaches the browser. Returns the original text unchanged if
// no key is configured or the call fails.

const INSTR = {
  improve: 'Rewrite this to be clearer and more professional',
  grammar: 'Fix only spelling and grammar, keep the wording and meaning',
  shorten: 'Make this concise, one or two sentences',
  formal: 'Rewrite this in a polished, professional tone',
  friendly: 'Rewrite this in a warm, friendly but professional tone',
};

export async function polish(text, mode, context = 'task description') {
  const base = String(text || '').trim();
  if (!base) return base;
  const instruction = INSTR[mode] || INSTR.improve;
  try {
    const { anthropic } = await getCredentials();
    if (!anthropic.apiKey) return base;
    // Bound the call: never let a slow/blocked network hang the request. The
    // SDK default timeout is 10 minutes, which would leave the UI spinner stuck.
    const client = new Anthropic({ apiKey: anthropic.apiKey, timeout: 15000, maxRetries: 1 });
    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `${instruction} for an internal property-management ${context}.\nReturn ONLY the rewritten text, no preamble or quotes:\n\n${base}`,
        },
      ],
    });
    const out = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return out || base;
  } catch (err) {
    console.error('[ai] polish failed:', err.message);
    return base;
  }
}
