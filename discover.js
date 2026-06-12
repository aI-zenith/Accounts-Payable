#!/usr/bin/env node

/*
 * discover.js — one-off Rent Manager API explorer for wiring the AP-bill push.
 *
 * Authenticates (POST /Authentication/AuthorizeUser with {Username, Password,
 * LocationID}), then for each endpoint prints the JSON shape + first record so
 * we can see the exact fields needed to create an Accounts Payable bill and
 * attach the original PDF. Also dumps the response headers for one call so the
 * rate-limit headers are visible. 404s are caught so the run continues.
 *
 * Config comes from a .env file (or the environment):
 *   RENTMANAGER_BASE_URL=https://bluegm.api.rentmanager.com
 *   RENTMANAGER_USERNAME=...
 *   RENTMANAGER_PASSWORD=...
 *   RENTMANAGER_LOCATION_ID=1
 *
 * Usage: node discover.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  if (data && typeof data === 'object') return { type: 'object', keys: Object.keys(data) };
  return { type: typeof data, value: data };
}

function firstRecord(data) {
  if (Array.isArray(data)) return data.length ? data[0] : '(empty array)';
  return data;
}

function truncate(str, max = 4000) {
  return str.length <= max ? str : str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`;
}

async function main() {
  const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

  const base = (env.RENTMANAGER_BASE_URL || env.RM_BASE_URL || '').replace(/\/+$/, '');
  const username = env.RENTMANAGER_USERNAME || env.RM_USERNAME;
  const password = env.RENTMANAGER_PASSWORD || env.RM_PASSWORD;
  const locationId = Number(env.RENTMANAGER_LOCATION_ID || 1);

  const missing = [];
  if (!base) missing.push('RENTMANAGER_BASE_URL');
  if (!username) missing.push('RENTMANAGER_USERNAME');
  if (!password) missing.push('RENTMANAGER_PASSWORD');
  if (missing.length) {
    console.error(`Missing required config: ${missing.join(', ')}. Create a .env file.`);
    process.exit(1);
  }

  // 1) Authenticate ----------------------------------------------------------
  console.log(`Authenticating to ${base}/Authentication/AuthorizeUser ...`);
  const authRes = await fetch(`${base}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: username, Password: password, LocationID: locationId }),
  });
  const authBody = await authRes.text();
  if (!authRes.ok) {
    console.error(`Auth failed: HTTP ${authRes.status} ${authRes.statusText}`);
    console.error(authBody);
    process.exit(1);
  }
  let token = authBody.trim();
  try {
    const parsed = JSON.parse(authBody);
    if (typeof parsed === 'string') token = parsed;
    else if (parsed && typeof parsed === 'object') token = parsed.Token || parsed.token || token;
  } catch (_) {
    token = token.replace(/^"|"$/g, '');
  }
  console.log(`Got token (${token.length} chars): ${token.slice(0, 8)}...\n`);

  // 2) Endpoints relevant to creating an AP bill + attaching the PDF ---------
  const endpoints = [
    '/Bills?pageSize=2&embeds=GLAccount,Property,Vendor',
    '/Vendors?pageSize=2',
    '/GLAccounts?pageSize=5',
    '/Properties?pageSize=2',
    '/Accounts?pageSize=2',
    '/Attachments?pageSize=2',
    '/Documents?pageSize=2',
    // candidates for where attachments hang off a bill
    '/Bills?pageSize=1&embeds=Attachments',
  ];

  const headers = { 'X-RM12Api-ApiToken': token, Accept: 'application/json' };
  let headersDumped = false;

  for (const ep of endpoints) {
    console.log('\n' + '='.repeat(70));
    console.log(`GET ${ep}`);
    console.log('='.repeat(70));
    try {
      const res = await fetch(`${base}${ep}`, { headers });
      if (!headersDumped) {
        console.log('--- Response headers (full dump for this call) ---');
        for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`);
        console.log('--------------------------------------------------');
        headersDumped = true;
      }
      console.log(`Status: ${res.status} ${res.statusText}`);
      if (res.status === 404) { console.log('-> 404 Not Found, skipping.'); continue; }
      const text = await res.text();
      if (!res.ok) { console.log('-> Non-OK body:'); console.log(truncate(text, 1000)); continue; }
      let data;
      try { data = JSON.parse(text); } catch (_) { console.log('-> Not JSON:'); console.log(truncate(text, 1000)); continue; }
      console.log('Shape:', JSON.stringify(shapeOf(data)));
      console.log('First record:');
      console.log(truncate(JSON.stringify(firstRecord(data), null, 2)));
    } catch (err) {
      console.log(`-> Request error for ${ep}: ${err.message} (continuing)`);
    }
  }
  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
