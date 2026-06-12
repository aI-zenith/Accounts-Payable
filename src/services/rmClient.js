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
// property. Vendors are auto-created when missing. The property is derived from
// the CREDIT CARD (findPropertyForCreditCard) and then verified against the
// invoice's job/property reference (jobMatchesPropertyOrUnit — it must name the
// property or one of its units); an unmatched property/job is flagged for review.

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
    const err = new Error(`Rent Manager request failed: HTTP ${res.status} ${String(text).slice(0, 200)}`);
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

async function listAll(path) {
  const { body } = await request(path);
  return Array.isArray(body) ? body : body ? [body] : [];
}

export async function findCreditCardByName(name) {
  const cards = await listAll('/CreditCards?pageSize=500');
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

// Fetch a single property by id (null on any miss).
export async function getPropertyById(id) {
  if (id == null) return null;
  try {
    const { body } = await request(`/Properties/${id}`);
    return body && (body.PropertyID || body.ID || body.Name) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the property a credit card belongs to — the PRIMARY way a bill is
 * assigned to a property. RM links a card to a property in one of a few shapes
 * depending on account config, so we try them in order, then fall back to
 * matching the card's name against a property name.
 */
export async function findPropertyForCreditCard(card) {
  if (!card) return null;

  // 1) A PropertyID directly on the card record.
  const directId = card.PropertyID ?? card.PropertyId ?? null;
  if (directId != null) {
    const p = await getPropertyById(directId);
    if (p) return p;
  }

  // 2) An already-embedded Property object.
  if (card.Property && (card.Property.PropertyID || card.Property.Name)) {
    return card.Property;
  }

  // 3) Re-fetch the card asking RM to embed its Property / expose its PropertyID.
  const cid = card.CreditCardID ?? card.ID;
  if (cid != null) {
    try {
      const { body } = await request(`/CreditCards/${cid}?embeds=Property`);
      if (body && body.Property && (body.Property.PropertyID || body.Property.Name)) {
        return body.Property;
      }
      const pid = body?.PropertyID ?? body?.PropertyId ?? null;
      if (pid != null) {
        const p = await getPropertyById(pid);
        if (p) return p;
      }
    } catch {
      /* fall through to name match */
    }
  }

  // 4) Fallback: the card is named after its property (e.g. "Wood Ave").
  return findPropertyByName(card.Name);
}

// List a property's units, trying a server-side filter first, then an embed.
async function listUnitsForProperty(propertyId) {
  if (propertyId == null) return [];
  try {
    const units = await listAll(`/Units?filter=PropertyID,eq,${propertyId}&pageSize=1000`);
    if (units.length) return units;
  } catch {
    /* try embed instead */
  }
  try {
    const { body } = await request(`/Properties/${propertyId}?embeds=Units`);
    return Array.isArray(body?.Units) ? body.Units : [];
  } catch {
    return [];
  }
}

/**
 * SECONDARY verification: the invoice's job/property reference must name the
 * card's property (by Name/ShortName) OR one of that property's units. Returns
 * true only when it matches — an empty/unknown job ref does NOT auto-pass.
 */
export async function jobMatchesPropertyOrUnit(property, jobRef) {
  if (!property || !jobRef) return false;
  const n = norm(jobRef);
  if (!n) return false;

  // a) Matches the property itself.
  for (const cand of [property.Name, property.ShortName]) {
    const c = norm(cand);
    if (c && (c === n || c.includes(n) || n.includes(c))) return true;
  }

  // b) Matches one of the property's units.
  const pid = property.PropertyID ?? property.ID;
  const units = await listUnitsForProperty(pid);
  const unit = bestMatch(jobRef, units, [
    (u) => u.Name,
    (u) => u.UnitNumber,
    (u) => u.ShortName,
  ]);
  return Boolean(unit);
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
  return (
    (body && (body.CreditCardTransactionID || body.TransactionID || body.ID)) ||
    idFromLocation(location)
  );
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
