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

// Parse a comma/space/semicolon-separated allow-list of sender addresses into a
// lowercased array. Empty / unset -> [] (meaning "accept any sender").
function parseSenders(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Resolve a tri-state boolean: a real DB boolean wins; else an env string
// ('true'/'1'/'yes' = true), else the provided default.
function resolveBool(dbValue, envValue, dflt) {
  if (typeof dbValue === 'boolean') return dbValue;
  if (envValue != null && envValue !== '') {
    return /^(1|true|yes|on)$/i.test(String(envValue).trim());
  }
  return dflt;
}

export async function getCredentials() {
  let row = {};
  try {
    const res = await query(
      `SELECT rm_subdomain, rm_username, rm_password, anthropic_api_key,
              imap_host, imap_port, imap_user, imap_password, imap_mailbox,
              imap_allowed_senders, email_auto_push
         FROM settings WHERE id = 1`
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
    // Inbox (IMAP) config for automatic email intake. host/user/password are the
    // minimum needed to poll; everything else has a sensible default.
    email: {
      host: row.imap_host || process.env.IMAP_HOST || null,
      port: Number(row.imap_port || process.env.IMAP_PORT || 993),
      user: row.imap_user || process.env.IMAP_USER || null,
      password: pick(row.imap_password, process.env.IMAP_PASSWORD),
      mailbox: row.imap_mailbox || process.env.IMAP_MAILBOX || 'INBOX',
      allowedSenders: parseSenders(row.imap_allowed_senders || process.env.IMAP_ALLOWED_SENDERS),
      autoPush: resolveBool(row.email_auto_push, process.env.EMAIL_AUTO_PUSH, true),
    },
  };
}
