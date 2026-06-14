import Anthropic from '@anthropic-ai/sdk';
import { getCredentials } from './credentials.js';

// Parse a credit card / bank statement into a normalized list of charges:
//   [{ date: 'YYYY-MM-DD'|null, amount: number, description: string, last4: string|null }]
//
// Supports CSV (and CSV exported from Excel) and PDF (via Claude). For native
// .xlsx, export to CSV first — or ask and native xlsx can be added.

const MODEL = 'claude-opus-4-8';

// --- CSV -------------------------------------------------------------------
// Minimal RFC-4180-ish CSV parser (handles quotes, embedded commas/newlines).
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

function toNumber(v) {
  if (v == null) return null;
  // Strip currency symbols, thousands separators, handle parentheses as negative.
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[()]/g, '').replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function toISODate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function last4Of(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})\D*$/);
  return m ? m[1] : null;
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  // Detect a header row by looking for known column names.
  const header = rows[0].map((h) => String(h).toLowerCase().trim());
  const findCol = (...names) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  const dateCol = findCol('date', 'posted', 'transaction date');
  const amountCol = findCol('amount', 'debit', 'charge', 'total');
  const descCol = findCol('description', 'name', 'merchant', 'payee', 'memo', 'details');
  const cardCol = findCol('card', 'account', 'last 4', 'last4');

  const hasHeader = dateCol !== -1 || amountCol !== -1 || descCol !== -1;
  const body = hasHeader ? rows.slice(1) : rows;

  // Fall back to positional columns when no header was detected.
  const di = dateCol !== -1 ? dateCol : 0;
  const ai = amountCol !== -1 ? amountCol : 1;
  const ci = descCol !== -1 ? descCol : 2;

  const charges = [];
  for (const r of body) {
    const amount = toNumber(r[ai]);
    if (amount == null) continue;
    charges.push({
      date: toISODate(r[di]),
      amount: Math.abs(amount),
      description: String(r[ci] ?? '').trim(),
      last4: cardCol !== -1 ? last4Of(r[cardCol]) : null,
    });
  }
  return charges;
}

// --- PDF (via Claude) ------------------------------------------------------
async function parsePdf(buffer) {
  const { anthropic } = await getCredentials();
  if (!anthropic.apiKey) throw new Error('No Anthropic API key available for statement parsing.');
  const client = new Anthropic({ apiKey: anthropic.apiKey });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system:
      'You extract charge line items from a credit card or bank statement PDF. ' +
      'Return ONLY a JSON array, no prose, no code fences. Each element: ' +
      '{ "date": "YYYY-MM-DD"|null, "amount": number, "description": string, "last4": string|null }. ' +
      'Include only charges/debits (money spent), not payments/credits. Amounts are positive numbers.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
          { type: 'text', text: 'Extract every charge as the required JSON array.' },
        ],
      },
    ],
  });

  let text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('Statement extraction did not return a JSON array.');
  return data.map((c) => ({
    date: toISODate(c.date),
    amount: Math.abs(toNumber(c.amount) ?? 0),
    description: String(c.description ?? '').trim(),
    last4: c.last4 ? last4Of(c.last4) : null,
  }));
}

/**
 * Parse a statement file into normalized charges.
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimetype
 */
export async function parseStatement(buffer, filename, mimetype) {
  const name = (filename || '').toLowerCase();
  const isPdf = mimetype === 'application/pdf' || name.endsWith('.pdf');
  const isCsv = mimetype === 'text/csv' || name.endsWith('.csv') || name.endsWith('.txt');

  if (isPdf) return { sourceType: 'pdf', charges: await parsePdf(buffer) };
  if (isCsv) return { sourceType: 'csv', charges: parseCsv(buffer.toString('utf8')) };

  // Unknown type — try CSV as a last resort.
  return { sourceType: 'csv?', charges: parseCsv(buffer.toString('utf8')) };
}
