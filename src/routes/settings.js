import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { encrypt, decrypt, mask } from '../services/crypto.js';
import { getCredentials } from '../services/credentials.js';
import { authenticate, _resetTokenCache } from '../services/rmClient.js';

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Read the settings row and produce safe, masked display values.
async function loadSettingsView() {
  const { rows } = await query(
    'SELECT rm_subdomain, rm_username, rm_password, anthropic_api_key FROM settings WHERE id = 1'
  );
  const row = rows[0] || {};

  const safeDecrypt = (v) => {
    if (!v) return null;
    try {
      return decrypt(v);
    } catch {
      return null;
    }
  };

  const rmUser = safeDecrypt(row.rm_username);
  const rmPass = safeDecrypt(row.rm_password);
  const claudeKey = safeDecrypt(row.anthropic_api_key);

  return {
    rm_subdomain: row.rm_subdomain || '',
    // Masked display only — full secrets are never sent to the browser.
    rm_username_masked: rmUser ? mask(rmUser) : '',
    rm_password_masked: rmPass ? mask(rmPass) : '',
    anthropic_masked: claudeKey ? mask(claudeKey, { prefix: 'sk-ant-' }) : '',
    has_rm_username: Boolean(rmUser),
    has_rm_password: Boolean(rmPass),
    has_anthropic: Boolean(claudeKey),
  };
}

// --- GET /settings ---------------------------------------------------------
router.get(
  '/settings',
  wrap(async (req, res) => {
    const settings = await loadSettingsView();
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      settings,
      notice: req.query.notice || null,
    });
  })
);

// --- POST /settings --------------------------------------------------------
// Blank secret field = keep existing. Only overwrite when a new value is typed.
router.post(
  '/settings',
  wrap(async (req, res) => {
    const b = req.body;
    const sets = ['updated_at = now()'];
    const vals = [];
    let i = 1;

    const addPlain = (col, val) => {
      sets.push(`${col} = $${i++}`);
      vals.push(val || null);
    };
    const addSecret = (col, val) => {
      if (val && val.trim()) {
        sets.push(`${col} = $${i++}`);
        vals.push(encrypt(val.trim()));
      }
    };

    addPlain('rm_subdomain', b.rm_subdomain && b.rm_subdomain.trim());
    addSecret('rm_username', b.rm_username);
    addSecret('rm_password', b.rm_password);
    addSecret('anthropic_api_key', b.anthropic_api_key);

    await query(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`, vals);

    // A subdomain/credential change invalidates any cached RM token.
    _resetTokenCache();

    res.redirect('/settings?notice=' + encodeURIComponent('Settings saved.'));
  })
);

// --- POST /settings/test/rentmanager --------------------------------------
router.post(
  '/settings/test/rentmanager',
  wrap(async (req, res) => {
    try {
      const { rm } = await getCredentials();
      if (!rm.baseUrl || !rm.username || !rm.password) {
        return res.json({
          ok: false,
          message: 'A subdomain (or RENTMANAGER_BASE_URL), username and password are all required.',
        });
      }
      _resetTokenCache();
      await authenticate();
      res.json({ ok: true, message: 'Authenticated successfully.' });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  })
);

// --- POST /settings/test/claude -------------------------------------------
router.post(
  '/settings/test/claude',
  wrap(async (req, res) => {
    try {
      const { anthropic } = await getCredentials();
      if (!anthropic.apiKey) {
        return res.json({ ok: false, message: 'No Anthropic API key configured.' });
      }
      const client = new Anthropic({ apiKey: anthropic.apiKey });
      // Cheap 1-token ping.
      await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      res.json({ ok: true, message: 'Claude API key is valid.' });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  })
);

export default router;
