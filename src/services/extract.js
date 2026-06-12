import Anthropic from '@anthropic-ai/sdk';
import { getCredentials } from './credentials.js';

const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = `You are an accounts-payable data extraction engine.
You receive a single vendor invoice as a PDF document and must return ONLY a
single JSON object — no prose, no markdown, no commentary, no code fences.

Use exactly this schema and these keys:
{
  "vendor_name": string|null,
  "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null,
  "due_date": "YYYY-MM-DD"|null,
  "line_items": [
    { "description": string, "qty": number|null, "unit_price": number|null, "amount": number|null }
  ],
  "subtotal": number|null,
  "tax": number|null,
  "total": number|null,
  "property_reference": string|null,
  "currency": string|null
}

Rules:
- Output the JSON object and nothing else.
- Dates MUST be ISO YYYY-MM-DD or null. Do not invent dates.
- Numbers must be plain JSON numbers (no currency symbols, no thousands separators).
- If a value is not present on the invoice, use null (or [] for line_items).
- "property_reference" is any property/unit/job identifier the invoice mentions.`;

// Build an Anthropic client from resolved credentials.
async function getClient() {
  const { anthropic } = await getCredentials();
  if (!anthropic.apiKey) {
    throw new Error(
      'No Anthropic API key available. Set it in Settings or via ANTHROPIC_API_KEY.'
    );
  }
  return new Anthropic({ apiKey: anthropic.apiKey });
}

// Strip ```json ... ``` fences and surrounding whitespace if the model added them.
function stripFences(text) {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  return t;
}

/**
 * Extract structured invoice data from a PDF.
 * @param {Buffer} pdfBuffer the raw PDF bytes
 * @returns {Promise<object>} parsed JSON matching the schema above
 * @throws {Error} on parse failure; the raw model text is attached as err.raw
 */
export async function extractInvoice(pdfBuffer) {
  const client = await getClient();
  const base64 = pdfBuffer.toString('base64');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          {
            type: 'text',
            text: 'Extract this invoice into the required JSON object.',
          },
        ],
      },
    ],
  });

  const rawText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  const cleaned = stripFences(rawText);

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const parseError = new Error(`Could not parse extraction JSON: ${err.message}`);
    parseError.raw = rawText;
    throw parseError;
  }
}
