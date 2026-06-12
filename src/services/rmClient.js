// Rent Manager WAPI12 client.
//
// !!! ENDPOINTS UNCONFIRMED — PENDING API DISCOVERY !!!
// Authentication is implemented and exercised by the Settings "Test connection"
// flow. The write operations (createProject / attachDocument) are deliberately
// left as STUBS: the exact resource paths and payload shapes must be confirmed
// by running API discovery against the live account before they are wired.
//
// See discover.js at the repo root for the discovery script.

import { readFile } from 'node:fs/promises';
import { getCredentials } from './credentials.js';

// Module-scoped token cache. getToken() re-auths on demand (and request()
// re-auths once on a 401).
let cachedToken = null;
let cachedSubdomain = null;

function baseUrlFor(subdomain) {
  if (!subdomain) {
    throw new Error('Rent Manager subdomain is not configured.');
  }
  return `https://${subdomain}.api.rentmanager.com`;
}

/**
 * Authenticate against /Authentication/AuthorizeUser.
 * The token is returned as a raw, JSON-quoted string (e.g. "abc123") — parse it.
 * @returns {Promise<string>} the API token
 */
export async function authenticate() {
  const { rm } = await getCredentials();
  if (!rm.username || !rm.password) {
    throw new Error('Rent Manager username/password are not configured.');
  }
  const base = baseUrlFor(rm.subdomain);

  const res = await fetch(`${base}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: rm.username, Password: rm.password }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Rent Manager auth failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  // Body is the token as a JSON-quoted string. Parse defensively.
  let token;
  try {
    const parsed = JSON.parse(text);
    token = typeof parsed === 'string' ? parsed : parsed?.Token || parsed?.token;
  } catch {
    token = text.trim().replace(/^"|"$/g, '');
  }
  if (!token) {
    throw new Error('Rent Manager auth succeeded but no token was returned.');
  }

  cachedToken = token;
  cachedSubdomain = rm.subdomain;
  return token;
}

/**
 * Return a valid token, authenticating if none is cached or the subdomain changed.
 */
export async function getToken() {
  const { rm } = await getCredentials();
  if (cachedToken && cachedSubdomain === rm.subdomain) {
    return cachedToken;
  }
  return authenticate();
}

/**
 * Low-level request helper.
 * - injects X-RM12Api-ApiToken
 * - retries ONCE on 401 by re-authenticating
 * - returns BOTH the parsed body and the response headers (callers need the
 *   Location header to read the id of a newly-created record).
 * - surfaces rate-limit headers in logs.
 *
 * @returns {Promise<{ status:number, body:any, headers:Headers, location:string|null }>}
 */
export async function request(path, opts = {}) {
  const { rm } = await getCredentials();
  const base = baseUrlFor(rm.subdomain);
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const doFetch = async (token) =>
    fetch(url, {
      ...opts,
      headers: {
        Accept: 'application/json',
        'X-RM12Api-ApiToken': token,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });

  let token = await getToken();
  let res = await doFetch(token);

  // Re-auth once on 401.
  if (res.status === 401) {
    token = await authenticate();
    res = await doFetch(token);
  }

  // Log rate-limit headers (names per WAPI12 conventions; harmless if absent).
  const limit = res.headers.get('X-RateLimit');
  const remaining = res.headers.get('X-RateRemaining');
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

  return {
    status: res.status,
    body,
    headers: res.headers,
    location: res.headers.get('Location'),
  };
}

// ---------------------------------------------------------------------------
// WRITE OPERATIONS — STUBS. Wire after API discovery.
// ---------------------------------------------------------------------------

/**
 * Create the Rent Manager record for a confirmed invoice.
 * STUB: the target endpoint/payload is unconfirmed pending API discovery.
 * Intended to return the new record id (read from the Location header).
 */
export async function createProject(data) {
  // TODO(discovery): replace with the confirmed endpoint, e.g.
  //   const { location, body } = await request('/Projects', {
  //     method: 'POST',
  //     body: JSON.stringify(mapInvoiceToProject(data)),
  //   });
  //   return idFromLocation(location) ?? body?.ProjectID;
  throw new Error('TODO: wire endpoint after discovery');
}

/**
 * Attach the original invoice PDF to a Rent Manager record.
 * STUB: the target endpoint/upload shape is unconfirmed pending API discovery.
 */
export async function attachDocument(parentId, filePath) {
  // TODO(discovery): replace with the confirmed attachment endpoint. The file
  // is read here so the eventual wiring only needs the request shape:
  //   const bytes = await readFile(filePath);
  void readFile; // referenced to keep the intended dependency visible
  throw new Error('TODO: wire endpoint after discovery');
}

// Test-only helper used by the Settings connection test.
export async function testAuthentication() {
  const token = await authenticate();
  return Boolean(token);
}

// Allow tests/teardown to clear the cached token.
export function _resetTokenCache() {
  cachedToken = null;
  cachedSubdomain = null;
}
