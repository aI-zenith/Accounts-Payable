import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { encrypt, decrypt, mask } from '../services/crypto.js';
import { getCredentials } from '../services/credentials.js';
import { authenticate, _resetTokenCache, request } from '../services/rmClient.js';
import { testInbox } from '../services/emailPoller.js';

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Read the settings row and produce safe, masked display values.
async function loadSettingsView() {
  const { rows } = await query(
    `SELECT rm_subdomain, rm_username, rm_password, anthropic_api_key,
            imap_host, imap_port, imap_user, imap_password, imap_mailbox,
            imap_allowed_senders, email_auto_push
       FROM settings WHERE id = 1`
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
  const imapPass = safeDecrypt(row.imap_password);

  return {
    rm_subdomain: row.rm_subdomain || '',
    // Masked display only — full secrets are never sent to the browser.
    rm_username_masked: rmUser ? mask(rmUser) : '',
    rm_password_masked: rmPass ? mask(rmPass) : '',
    anthropic_masked: claudeKey ? mask(claudeKey, { prefix: 'sk-ant-' }) : '',
    has_rm_username: Boolean(rmUser),
    has_rm_password: Boolean(rmPass),
    has_anthropic: Boolean(claudeKey),
    // Email inbox (IMAP). Host/port/user/mailbox/senders are plain; password masked.
    imap_host: row.imap_host || '',
    imap_port: row.imap_port || 993,
    imap_user: row.imap_user || '',
    imap_mailbox: row.imap_mailbox || 'INBOX',
    imap_allowed_senders: row.imap_allowed_senders || '',
    imap_password_masked: imapPass ? mask(imapPass) : '',
    has_imap_password: Boolean(imapPass),
    // Default ON when never set (matches the credentials resolver default).
    email_auto_push: row.email_auto_push !== false,
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

    // Email inbox (IMAP).
    const port = Number.parseInt(b.imap_port, 10);
    addPlain('imap_host', b.imap_host && b.imap_host.trim());
    addPlain('imap_port', Number.isInteger(port) && port > 0 ? port : null);
    addPlain('imap_user', b.imap_user && b.imap_user.trim());
    addPlain('imap_mailbox', (b.imap_mailbox && b.imap_mailbox.trim()) || 'INBOX');
    addPlain('imap_allowed_senders', b.imap_allowed_senders && b.imap_allowed_senders.trim());
    addSecret('imap_password', b.imap_password);
    // Checkbox: present in the body only when checked.
    sets.push(`email_auto_push = $${i++}`);
    vals.push(b.email_auto_push === 'on' || b.email_auto_push === 'true');

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

// --- POST /settings/test/email --------------------------------------------
router.post(
  '/settings/test/email',
  wrap(async (req, res) => {
    try {
      const { email } = await getCredentials();
      if (!email.host || !email.user || !email.password) {
        return res.json({
          ok: false,
          message: 'IMAP host, username and password are all required.',
        });
      }
      const info = await testInbox();
      res.json({
        ok: true,
        message: `Connected — ${info.total} message(s) in ${info.mailbox}.`,
      });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  })
);

// --- GET /settings/rm-discovery -------------------------------------------
// TEMPORARY diagnostic: authenticates and reads a few read-only endpoints so we
// can see the exact fields needed to build an Accounts Payable bill + attach the
// PDF. Returns JSON (shape + first record per endpoint). Remove once the push is
// wired. Runs from Render, which can reach the RM API.
router.get(
  '/settings/rm-discovery',
  wrap(async (req, res) => {
    const get = async (ep) => {
      try {
        const { body } = await request(ep);
        return body;
      } catch (err) {
        return { error: err.message, status: err.status ?? null };
      }
    };
    const schemaOf = (body) => {
      const arr = Array.isArray(body) ? body : body ? [body] : [];
      const first = arr[0] ?? null;
      return {
        count: Array.isArray(body) ? body.length : undefined,
        keys: first && typeof first === 'object' ? Object.keys(first) : null,
        firstRecord: first,
        error: body && body.error ? body : undefined,
      };
    };

    // Probe a custom set of endpoints via ?eps=ep1||ep2 (||-separated, since
    // endpoints contain commas in embeds). Defaults to hunting for the credit
    // card transaction's child property/GL allocation structure.
    const defaults = [
      '/CreditCardTransactions/1?embeds=Charges',
      '/CreditCardTransactions/1?embeds=GLAllocations',
      '/CreditCardTransactions/1?embeds=Allocations',
      '/CreditCardTransactions/1?embeds=GLTransactions',
      '/CreditCardTransactions/1?embeds=Account',
      '/CreditCardTransactions/1?embeds=Properties',
    ];
    const eps = req.query.eps ? String(req.query.eps).split('||') : defaults;

    const result = {};
    for (const ep of eps) {
      result[ep] = schemaOf(await get(ep));
    }
    res.json(result);
  })
);

export default router;
