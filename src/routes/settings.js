import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { encrypt, decrypt, mask } from '../services/crypto.js';
import { getCredentials } from '../services/credentials.js';
import {
  authenticate,
  _resetTokenCache,
  request,
  listCreditCards,
  listExpenseGLAccounts,
} from '../services/rmClient.js';
import { testInbox } from '../services/emailPoller.js';

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Read the settings row and produce safe, masked display values.
async function loadSettingsView() {
  const { rows } = await query(
    `SELECT rm_subdomain, rm_username, rm_password, anthropic_api_key,
            default_gl_account_id, default_gl_account_name,
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
    default_gl_account_id: row.default_gl_account_id || '',
    default_gl_account_name: row.default_gl_account_name || '',
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

    // Saved last-4 -> RM card mappings.
    const { rows: cardMappings } = await query(
      'SELECT id, last4, rm_card_id, rm_card_name FROM card_mappings ORDER BY last4'
    );

    // Live lists from RM for the pickers (best-effort).
    let rmCards = [];
    let rmCardsError = null;
    try {
      const cards = await listCreditCards();
      rmCards = cards.map((c) => ({ id: String(c.CreditCardID ?? c.ID), name: c.Name }));
    } catch (err) {
      rmCardsError = err.message;
    }

    let glAccounts = [];
    try {
      const accts = await listExpenseGLAccounts();
      glAccounts = accts.map((a) => ({ id: String(a.GLAccountID), name: a.Name, ref: a.Reference }));
    } catch {
      glAccounts = [];
    }

    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      settings,
      cardMappings,
      rmCards,
      rmCardsError,
      glAccounts,
      notice: req.query.notice || null,
    });
  })
);

// --- Credit card mappings (last-4 -> RM card) ------------------------------
router.post(
  '/settings/card-mappings',
  wrap(async (req, res) => {
    const last4 = String(req.body.last4 || '').replace(/\D/g, '').slice(-4);
    const rmCardId = String(req.body.rm_card_id || '').trim();
    const rmCardName = String(req.body.rm_card_name || '').trim() || null;
    if (last4.length !== 4 || !rmCardId) {
      return res.redirect('/settings?notice=' + encodeURIComponent('Enter the last 4 digits and pick a card.'));
    }
    await query(
      `INSERT INTO card_mappings (last4, rm_card_id, rm_card_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (last4) DO UPDATE SET rm_card_id = EXCLUDED.rm_card_id, rm_card_name = EXCLUDED.rm_card_name`,
      [last4, rmCardId, rmCardName]
    );
    res.redirect('/settings?notice=' + encodeURIComponent(`Mapped •••• ${last4} → ${rmCardName || rmCardId}.`));
  })
);

router.post(
  '/settings/card-mappings/:id/delete',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isInteger(id)) await query('DELETE FROM card_mappings WHERE id = $1', [id]);
    res.redirect('/settings?notice=' + encodeURIComponent('Mapping removed.'));
  })
);

// --- Default expense (GL) account -----------------------------------------
router.post(
  '/settings/default-gl',
  wrap(async (req, res) => {
    const id = String(req.body.default_gl_account_id || '').trim();
    const name = String(req.body.default_gl_account_name || '').trim() || null;
    if (!id) return res.redirect('/settings?notice=' + encodeURIComponent('Choose an expense account.'));
    await query(
      'UPDATE settings SET default_gl_account_id = $1, default_gl_account_name = $2, updated_at = now() WHERE id = 1',
      [id, name]
    );
    res.redirect('/settings?notice=' + encodeURIComponent(`Default expense account set to ${name || id}.`));
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

// --- GET /settings/attach-probe -------------------------------------------
// TEMPORARY diagnostic to nail down the exact credit-card-transaction
// attachment payload. Two parts:
//   1) Read-only: scan existing CCTs for one that already HAS an attachment and
//      return its exact field shape (the authoritative model to mirror).
//   2) Optional write: with ?txn=<id>, POST a real receipt several ways and
//      report which variant RM accepts. The first variant that returns ok is the
//      answer. Remove this route once the attach is wired.
router.get(
  '/settings/attach-probe',
  wrap(async (req, res) => {
    const out = {};

    // 0) Read RM's own Help doc for THIS subresource via the authenticated
    //    client (it 403s unauthenticated). The ASP.NET Web API Help page server-
    //    renders the request model + a JSON sample; strip tags so the field
    //    names + sample are readable.
    const stripTags = (html) =>
      String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    for (const helpUrl of [
      '/Help/Subresource/CreditCardTransactions/Attachments',
      '/Help/ResourceModel?modelName=FileAttachment',
      '/Help/ResourceModel?modelName=File',
    ]) {
      try {
        const r = await request(helpUrl);
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        out[`help:${helpUrl}`] = { status: r.status, text: stripTags(text).slice(0, 8000) };
      } catch (err) {
        out[`help:${helpUrl}`] = { error: err.message, status: err.status ?? null };
      }
    }

    // 1) Hunt for an existing attachment to copy its structure exactly.
    try {
      const samples = [];
      let scanned = 0;
      for (let page = 1; page <= 6 && samples.length < 3; page++) {
        const { body } = await request(
          `/CreditCardTransactions?embeds=Attachments&pageSize=200&pageNumber=${page}`
        );
        const list = Array.isArray(body) ? body : body ? [body] : [];
        scanned += list.length;
        for (const t of list) {
          if (Array.isArray(t.Attachments) && t.Attachments.length && samples.length < 3) {
            samples.push({
              CreditCardTransactionID: t.ID,
              attachmentKeys: Object.keys(t.Attachments[0] || {}),
              attachment: t.Attachments[0],
            });
          }
        }
        if (list.length < 200) break; // last page
      }
      out.existingAttachmentSamples = { scanned, found: samples.length, samples };
    } catch (err) {
      out.existingAttachmentSamples = { error: err.message };
    }

    // 2) Optional: try POSTing to ?txn with several body variants.
    const txn = req.query.txn ? Number(req.query.txn) : null;
    if (txn) {
      // Prefer the real stored receipt for this transaction; else a tiny stub.
      let bytes;
      let fname = 'probe.pdf';
      try {
        const { rows } = await query(
          'SELECT file_data, original_name FROM invoices WHERE rm_project_id = $1 LIMIT 1',
          [String(txn)]
        );
        if (rows[0]?.file_data) {
          bytes = rows[0].file_data;
          fname = rows[0].original_name || fname;
        }
      } catch {
        /* fall through to stub */
      }
      if (!bytes) bytes = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
      const content = Buffer.isBuffer(bytes) ? bytes.toString('base64') : String(bytes);
      const file = { Name: fname, Extension: 'pdf', Content: content };
      const url = `/CreditCardTransactions/${txn}/Attachments`;

      // A MySqlException (DB-level) most often means a required FK is missing —
      // RM files hang off a FileType. Pull the account's FileTypes so we can send
      // a valid one and surface the list either way.
      const normList = (b) => (Array.isArray(b) ? b : b ? [b] : []);
      let fileTypes = [];
      for (const ep of ['/FileTypes?pageSize=200', '/FileType?pageSize=200', '/DocumentTypes?pageSize=200']) {
        try {
          const { body } = await request(ep);
          const list = normList(body);
          if (list.length) {
            fileTypes = list.map((f) => ({ id: f.FileTypeID ?? f.ID ?? f.DocumentTypeID, name: f.Name, ep }));
            break;
          }
        } catch {
          /* try next alias */
        }
      }
      out.fileTypes = fileTypes.slice(0, 25);
      const ftId = fileTypes[0]?.id ?? null;

      const variants = [
        { label: 'array, File, no FileType', body: [{ Description: fname, File: file }] },
        ...(ftId != null
          ? [
              {
                label: `array, File.FileTypeID=${ftId}`,
                body: [{ Description: fname, File: { ...file, FileTypeID: ftId } }],
              },
              {
                label: `array, FileTypeID=${ftId} on attachment`,
                body: [{ Description: fname, FileTypeID: ftId, File: file }],
              },
              {
                label: `array, File.FileType={ID}`,
                body: [{ Description: fname, File: { ...file, FileType: { FileTypeID: ftId } } }],
              },
            ]
          : []),
        { label: 'array, File w/ IsActive+FileName', body: [{ Description: fname, IsActive: true, File: { Name: fname, Extension: 'pdf', Content: content, IsActive: true } }] },
      ];

      out.postAttempts = [];
      for (const v of variants) {
        try {
          const r = await request(url, { method: 'POST', body: JSON.stringify(v.body) });
          out.postAttempts.push({ variant: v.label, ok: true, status: r.status, body: r.body });
        } catch (err) {
          out.postAttempts.push({
            variant: v.label,
            ok: false,
            status: err.status ?? null,
            error: String(err.message).slice(0, 400),
          });
        }
      }
    }

    res.json(out);
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
      // Hunt for the property/GL allocation child structure.
      '/CreditCardTransactions/1?embeds=Expenses',
      '/CreditCardTransactions/1?embeds=GLAccountAllocations',
      '/CreditCardTransactions/1?embeds=Distributions',
      '/CreditCardTransactions/1?embeds=CreditCardTransactionGLAllocations',
      '/CreditCardTransactions/1?embeds=Details',
      '/CreditCardTransactions/1?embeds=Lines',
      // Hunt for the attachment endpoint/structure + the exact EntityType the
      // account uses for a credit card transaction's file attachments.
      '/CreditCardTransactions/1?embeds=FileAttachments',
      '/CreditCardTransactions/1?embeds=Attachments',
      '/CreditCardTransactions/1?embeds=Files',
      '/FileAttachments?pageSize=5',
      '/Attachments?pageSize=1',
      '/Files?pageSize=1',
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
