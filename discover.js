#!/usr/bin/env node
'use strict';

/*
 * discover.js — one-off Rent Manager WAPI12 endpoint explorer.
 *
 * Authenticates against /Authentication/AuthorizeUser, then GETs a set of
 * endpoints using the X-RM12Api-ApiToken header and prints, for each one:
 *   - the JSON "shape" (array vs object, length, top-level keys)
 *   - the first record (pretty-printed)
 * 404s (and other per-endpoint failures) are caught so the run continues.
 *
 * Response headers for one call are dumped so you can inspect the
 * rate-limit headers (X-RateLimit-*, Retry-After, etc.).
 *
 * Config is read from a .env file (see .env.example):
 *   RM_SUBDOMAIN=mycompany      # the "MYCOMPANY" in MYCOMPANY.api.rentmanager.com
 *   RM_USERNAME=...
 *   RM_PASSWORD=...
 *
 * Usage: node discover.js
 */

const fs = require('fs');
const path = require('path');

// --- tiny .env parser (no dependencies) -----------------------------------
function loadEnv(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// --- helpers ----------------------------------------------------------------
function shapeOf(data) {
  if (Array.isArray(data)) {
    const first = data[0];
    return {
      type: 'array',
      length: data.length,
      firstRecordKeys:
        first && typeof first === 'object' ? Object.keys(first) : null,
    };
  }
  if (data && typeof data === 'object') {
    return { type: 'object', keys: Object.keys(data) };
  }
  return { type: typeof data, value: data };
}

function firstRecord(data) {
  if (Array.isArray(data)) return data.length ? data[0] : '(empty array)';
  return data;
}

function truncate(str, max = 4000) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`;
}

// --- main -------------------------------------------------------------------
async function main() {
  const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

  const subdomain = env.RM_SUBDOMAIN;
  const username = env.RM_USERNAME;
  const password = env.RM_PASSWORD;

  const missing = [];
  if (!subdomain) missing.push('RM_SUBDOMAIN');
  if (!username) missing.push('RM_USERNAME');
  if (!password) missing.push('RM_PASSWORD');
  if (missing.length) {
    console.error(
      `Missing required config: ${missing.join(', ')}.\n` +
        `Create a .env file (see .env.example).`
    );
    process.exit(1);
  }

  const base = `https://${subdomain}.api.rentmanager.com`;

  // 1) Authenticate ----------------------------------------------------------
  console.log(`Authenticating to ${base}/Authentication/AuthorizeUser ...`);
  const authRes = await fetch(`${base}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: username, Password: password }),
  });

  const authBody = await authRes.text();
  if (!authRes.ok) {
    console.error(`Auth failed: HTTP ${authRes.status} ${authRes.statusText}`);
    console.error(authBody);
    process.exit(1);
  }

  // AuthorizeUser returns the token as a raw string, which JSON-encodes as a
  // quoted string (e.g. "abc123..."). Parse if it looks like JSON, else use raw.
  let token = authBody.trim();
  try {
    const parsed = JSON.parse(authBody);
    if (typeof parsed === 'string') token = parsed;
    else if (parsed && typeof parsed === 'object') {
      token = parsed.Token || parsed.token || parsed.ApiToken || token;
    }
  } catch (_) {
    // not JSON — strip surrounding quotes if present
    token = token.replace(/^"|"$/g, '');
  }

  if (!token) {
    console.error('Could not extract a token from the auth response:');
    console.error(authBody);
    process.exit(1);
  }
  console.log(`Got token (${token.length} chars): ${token.slice(0, 8)}...\n`);

  // 2) Endpoints to probe ----------------------------------------------------
  // Explicit list plus name-match candidates (Bill/Estimate/Attachment/Document).
  const endpoints = [
    '/Projects',
    '/ServiceManagerProjects',
    '/ServiceManagerIssues',
    '/Vendors',
    '/GLAccounts',
    '/Properties',
    // "Bill"
    '/Bills',
    '/VendorBills',
    // "Estimate"
    '/Estimates',
    '/ServiceManagerEstimates',
    // "Attachment"
    '/Attachments',
    // "Document"
    '/Documents',
  ];

  const headers = {
    'X-RM12Api-ApiToken': token,
    Accept: 'application/json',
  };

  let headersDumped = false;

  for (const ep of endpoints) {
    const url = `${base}${ep}`;
    console.log('\n' + '='.repeat(70));
    console.log(`GET ${ep}`);
    console.log('='.repeat(70));
    try {
      const res = await fetch(url, { headers });

      // 3) Dump full response headers for the very first call so the
      //    rate-limit headers are visible.
      if (!headersDumped) {
        console.log('--- Response headers (full dump for this call) ---');
        for (const [k, v] of res.headers.entries()) {
          console.log(`  ${k}: ${v}`);
        }
        console.log('--------------------------------------------------');
        headersDumped = true;
      }

      console.log(`Status: ${res.status} ${res.statusText}`);

      if (res.status === 404) {
        console.log('-> 404 Not Found, skipping.');
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        console.log(`-> Non-OK response, body:`);
        console.log(truncate(text, 1000));
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        console.log('-> Response was not JSON. Raw body:');
        console.log(truncate(text, 1000));
        continue;
      }

      console.log('Shape:', JSON.stringify(shapeOf(data)));
      console.log('First record:');
      console.log(truncate(JSON.stringify(firstRecord(data), null, 2)));
    } catch (err) {
      console.log(`-> Request error for ${ep}: ${err.message} (continuing)`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
