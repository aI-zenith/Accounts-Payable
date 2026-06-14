// Rent Manager API client.
//
// AUTH IS WIRED for this account (company code `bluegm`):
//   - Base URL:   https://bluegm.api.rentmanager.com  (RENTMANAGER_BASE_URL)
//   - Auth:       POST /Authentication/AuthorizeUser
//                 body { Username, Password, LocationID }
//   - The response is the token as a (JSON-quoted) string.
//   - Every subsequent request carries header  X-RM12Api-ApiToken: <token>
//   - On a 401 the client re-authenticates and retries the request once.
//   - Tokens are cached in module scope and proactively refreshed after a TTL.
//
// WRITE: pushes an invoice to Rent Manager as a Credit Card Transaction
// (POST /CreditCardTransactions) after resolving the credit card, vendor, and
// property by name. Vendors are auto-created when missing; an unmatched
// property/job is flagged for manual review by the route.

import { getCredentials } from './credentials.js';

// Proactively re-auth tokens older than this (ms). 401-retry covers the rest.
const TOKEN_TTL_MS = 55 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;
let cachedBaseUrl = null;

function trimSlash(url) {
  return url ? url.replace(/\/+$/, '') : url;
}

/**
 * Authenticate against /authentication/AuthenticateUser.
 * The token is returned as a JSON-quoted string (e.g. "abc123") — parse it.
 * @returns {Promise<string>} the API token
 */
export async function authenticate() {
  const { rm } = await getCredentials();
  if (!rm.baseUrl) throw new Error('Rent Manager base URL is not configured.');
  if (!rm.username || !rm.password) {
    throw new Error('Rent Manager username/password are not configured.');
  }
  const base = trimSlash(rm.baseUrl);

  const res = await fetch(`${base}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Username: rm.username,
      Password: rm.password,
      LocationID: rm.locationId ?? 1,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // Never include the password; the body here is the API's own message.
    throw new Error(`Rent Manager auth failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  let token;
  try {
    const parsed = JSON.parse(text);
    token = typeof parsed === 'string' ? parsed : parsed?.Token || parsed?.token;
  } catch {
    token = text.trim().replace(/^"|"$/g, '');
  }
  if (!token) throw new Error('Rent Manager auth succeeded but no token was returned.');

  cachedToken = token;
  cachedAt = Date.now();
  cachedBaseUrl = base;
  return token;
}

/**
 * Return a valid token, (re-)authenticating if none is cached, the cached
 * token has aged past the TTL, or the configured base URL changed.
 */
export async function getToken() {
  const { rm } = await getCredentials();
  const base = trimSlash(rm.baseUrl);
  const fresh = cachedToken && cachedBaseUrl === base && Date.now() - cachedAt < TOKEN_TTL_MS;
  return fresh ? cachedToken : authenticate();
}

/**
 * Best-effort token warm-up, called once at server startup. Non-fatal: if the
 * credentials aren't configured yet, we just log and carry on.
 */
export async function warmToken() {
  try {
    await authenticate();
    console.log('[rmClient] authenticated with Rent Manager on startup.');
  } catch (err) {
    console.warn('[rmClient] startup auth skipped:', err.message);
  }
}

/**
 * Low-level request helper.
 * - resolves the full URL against the configured base
 * - injects the X-RM12API token header
 * - retries ONCE on 401 by re-authenticating
 * - returns BOTH the parsed body and the response headers (write ops need the
 *   Location header to read a newly-created record id)
 * - surfaces rate-limit headers in logs
 *
 * @param {string} path e.g. '/tenants', '/properties', or an absolute URL
 * @returns {Promise<{ status:number, body:any, headers:Headers, location:string|null }>}
 */
export async function request(path, opts = {}) {
  const { rm } = await getCredentials();
  const base = trimSlash(rm.baseUrl);
  if (!base && !path.startsWith('http')) {
    throw new Error('Rent Manager base URL is not configured.');
  }
  const url = path.startsWith('http')
    ? path
    : `${base}/${String(path).replace(/^\/+/, '')}`;

  const doFetch = (token) =>
    fetch(url, {
      ...opts,
      headers: {
        Accept: 'application/json',
        // Canonical WAPI12 token header. (The account rejects 'X-RM12API' with
        // "Missing ApiToken"; this is the name the API actually expects.)
        'X-RM12Api-ApiToken': token,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });

  let token = await getToken();
  let res = await doFetch(token);

  // Token expired/invalid -> re-auth once and retry.
  if (res.status === 401) {
    token = await authenticate();
    res = await doFetch(token);
  }

  const limit = res.headers.get('X-RateLimit') || res.headers.get('X-RateLimit-Limit');
  const remaining = res.headers.get('X-RateRemaining') || res.headers.get('X-RateLimit-Remaining');
  if (limit || remaining) {
    console.log(`[rmClient] rate limit: ${remaining ?? '?'} / ${limit ?? '?'} remaining`);
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const err = new Error(`Rent Manager request failed: HTTP ${res.status} ${String(text).slice(0, 500)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return { status: res.status, body, headers: res.headers, location: res.headers.get('Location') };
}

// ---------------------------------------------------------------------------
// LOOKUPS + CREDIT CARD TRANSACTION CREATION
// ---------------------------------------------------------------------------

// Normalize a name for fuzzy matching: lowercase, collapse non-alphanumerics.
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pick the best match for `needle` among `items`, reading candidate names via
// `nameFns`. Prefers an exact normalized match, then a substring match either
// direction (e.g. "the home depot" ~ "home depot", "dolphin" ~ "Dolphin Gardens").
function bestMatch(needle, items, nameFns) {
  const n = norm(needle);
  if (!n || !Array.isArray(items)) return null;
  let partial = null;
  for (const it of items) {
    for (const fn of nameFns) {
      const cand = norm(fn(it));
      if (!cand) continue;
      if (cand === n) return it;
      if (!partial && (cand.includes(n) || n.includes(cand))) partial = it;
    }
  }
  return partial;
}

function idFromLocation(loc) {
  if (!loc) return null;
  const m = String(loc).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

// Robustly pull a record id out of a WAPI create response, which may be a bare
// number, an object, or an array of one object, with varying id field names.
function extractId(body, location, fields) {
  if (typeof body === 'number') return body;
  const obj = Array.isArray(body) ? body[0] : body;
  if (obj && typeof obj === 'object') {
    for (const f of fields) {
      if (obj[f] != null) return obj[f];
    }
  }
  return idFromLocation(location);
}

async function listAll(path) {
  const { body } = await request(path);
  return Array.isArray(body) ? body : body ? [body] : [];
}

export async function listCreditCards() {
  return listAll('/CreditCards?pageSize=500');
}

// Expense GL accounts, excluding parent (header) accounts you can't post to.
export async function listExpenseGLAccounts() {
  const all = await listAll('/GLAccounts?filters=GLAccountType,eq,Expense&pageSize=500');
  return all.filter((a) => !a.IsParent);
}

export async function findCreditCardByName(name) {
  const cards = await listCreditCards();
  return bestMatch(name, cards, [(c) => c.Name]);
}

export async function findVendorByName(name) {
  const vendors = await listAll('/Vendors?pageSize=1000');
  return bestMatch(name, vendors, [(v) => v.Name, (v) => v.Payee]);
}

export async function findPropertyByName(name) {
  const props = await listAll('/Properties?pageSize=1000');
  return bestMatch(name, props, [(p) => p.Name, (p) => p.ShortName]);
}

// Create a vendor when the invoice's merchant isn't found, then return it.
export async function createVendor(name) {
  const { body, location } = await request('/Vendors', {
    method: 'POST',
    body: JSON.stringify({ Name: name, IsActive: true }),
  });
  const id = (body && (body.VendorID || body.ID)) || idFromLocation(location);
  return { VendorID: id, Name: name };
}

/**
 * POST a credit card transaction. `payload` keys must match the WAPI schema
 * (see buildCreditCardTransaction in the invoices route). Returns the new id.
 */
export async function createCreditCardTransaction(payload) {
  const { body, location } = await request('/CreditCardTransactions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return extractId(body, location, ['CreditCardTransactionID', 'TransactionID', 'ID']);
}

/**
 * Attach a receipt file to a credit card transaction (FileAttachmentModel).
 * Called as a separate, non-fatal step so a failure never undoes the
 * already-created transaction. Returns the new attachment/file id.
 */
export async function attachReceipt(transactionId, fileBuffer, filename) {
  const base64 = Buffer.isBuffer(fileBuffer) ? fileBuffer.toString('base64') : String(fileBuffer);
  const name = filename || 'receipt.pdf';
  const ext = (name.includes('.') ? name.split('.').pop() : 'pdf').toLowerCase();

  // A FileAttachment is a generic record linked back to its parent via
  // EntityType + EntityKeyID, carrying the file in the required File (FileModel).
  const payload = {
    EntityType: 'CreditCardTransaction',
    EntityKeyID: Number(transactionId),
    Description: name,
    File: {
      Name: name,
      Extension: ext,
      Data: base64,
    },
  };
  const { body, location } = await request('/FileAttachments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return extractId(body, location, ['FileAttachmentID', 'FileID', 'ID']);
}

// Test-only helper used by the Settings connection test.
export async function testAuthentication() {
  const token = await authenticate();
  return Boolean(token);
}

// Allow tests/teardown/settings-change to clear the cached token.
export function _resetTokenCache() {
  cachedToken = null;
  cachedAt = 0;
  cachedBaseUrl = null;
}
