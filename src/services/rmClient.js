// Rent Manager API client.
//
// AUTH IS WIRED for this account (company code `bluegm`):
//   - Base URL:   https://bluegm.api.rentmanager.com  (RENTMANAGER_BASE_URL)
//   - Auth:       POST /authentication/AuthenticateUser
//                 body { Username, Password, LocationID }
//   - The response is the token as a (JSON-quoted) string.
//   - Every subsequent request carries header  X-RM12API: <token>
//   - On a 401 the client re-authenticates and retries the request once.
//   - Tokens are cached in module scope and proactively refreshed after a TTL.
//
// The WRITE operations (createProject / attachDocument) remain STUBS: their
// exact resource paths/payloads are still pending API discovery. They are
// backed by the working request() helper, so wiring them later is a one-liner.

import { readFile } from 'node:fs/promises';
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

  const res = await fetch(`${base}/authentication/AuthenticateUser`, {
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
        'X-RM12API': token,
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
// WRITE OPERATIONS — STUBS. Wire after confirming the resource paths.
// ---------------------------------------------------------------------------

/**
 * Create the Rent Manager record for a confirmed invoice.
 * STUB: target endpoint/payload pending API discovery. Intended to return the
 * new record id (from the Location header or the response body).
 */
export async function createProject(data) {
  // TODO(discovery): e.g.
  //   const { location, body } = await request('/projects', {
  //     method: 'POST', body: JSON.stringify(mapInvoiceToProject(data)),
  //   });
  //   return idFromLocation(location) ?? body?.ProjectID;
  throw new Error('TODO: wire endpoint after discovery');
}

/**
 * Attach the original invoice PDF to a Rent Manager record.
 * STUB: target endpoint/upload shape pending API discovery.
 */
export async function attachDocument(parentId, filePath) {
  // TODO(discovery): read the file and POST to the confirmed attachment endpoint.
  void readFile; // keep the intended dependency visible
  throw new Error('TODO: wire endpoint after discovery');
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
