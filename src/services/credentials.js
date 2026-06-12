import { query } from '../db/pool.js';
import { decrypt } from './crypto.js';
import 'dotenv/config';

// Single source of truth for runtime secrets.
//
// Resolution order, per field:
//   1. value stored (encrypted) in the settings table, else
//   2. the matching .env fallback variable.
//
// Both rmClient.js and extract.js MUST obtain secrets through here so the app
// behaves identically whether secrets were entered in the UI or set in the
// environment. Decrypted values are never logged.

function pick(dbValue, envValue) {
  if (dbValue) {
    try {
      return decrypt(dbValue) || envValue || null;
    } catch (err) {
      console.error('[credentials] failed to decrypt a stored secret:', err.message);
      return envValue || null;
    }
  }
  return envValue || null;
}

// Turn whatever was provided (bare subdomain / hostname / full URL) into a
// clean base URL, with the RENTMANAGER_BASE_URL env as fallback.
function resolveBaseUrl(subdomain, envBase) {
  const s = (subdomain || '').trim();
  if (s) {
    if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
    if (s.includes('.')) return `https://${s.replace(/\/+$/, '')}`;
    return `https://${s}.api.rentmanager.com`;
  }
  return envBase ? envBase.trim().replace(/\/+$/, '') : null;
}

export async function getCredentials() {
  let row = {};
  try {
    const res = await query(
      'SELECT rm_subdomain, rm_username, rm_password, anthropic_api_key FROM settings WHERE id = 1'
    );
    row = res.rows[0] || {};
  } catch (err) {
    // If the DB is unreachable we still allow pure-env operation.
    console.error('[credentials] could not read settings row:', err.message);
  }

  // Resolve the API base URL. The Settings "subdomain" field is tolerant: it
  // accepts a bare subdomain ("bluegm"), a hostname ("bluegm.api.rentmanager.com"),
  // or a full URL ("https://bluegm.api.rentmanager.com"). Falls back to the
  // RENTMANAGER_BASE_URL env var, then a bare RM_SUBDOMAIN.
  const subdomain = row.rm_subdomain || process.env.RM_SUBDOMAIN || null;
  const baseUrl = resolveBaseUrl(subdomain, process.env.RENTMANAGER_BASE_URL);

  return {
    rm: {
      // subdomain is not a secret, stored in plaintext (may be null when a full
      // RENTMANAGER_BASE_URL is used instead).
      subdomain,
      baseUrl,
      locationId: Number(process.env.RENTMANAGER_LOCATION_ID || 1),
      username: pick(row.rm_username, process.env.RENTMANAGER_USERNAME || process.env.RM_USERNAME),
      password: pick(row.rm_password, process.env.RENTMANAGER_PASSWORD || process.env.RM_PASSWORD),
    },
    anthropic: {
      apiKey: pick(row.anthropic_api_key, process.env.ANTHROPIC_API_KEY),
    },
  };
}
