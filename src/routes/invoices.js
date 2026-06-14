import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { query } from '../db/pool.js';
import { extractInvoice } from '../services/extract.js';
import {
  findCreditCardByName,
  findVendorByName,
  createVendor,
  findPropertyByName,
  createCreditCardTransaction,
  attachReceipt,
  listExpenseGLAccounts,
} from '../services/rmClient.js';

const router = Router();

// PDFs are stored in Postgres (see migrate.js) so they survive deploys/restarts
// on ephemeral hosting. multer keeps the upload in memory just long enough to
// write the bytes to the database.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are accepted.'));
  },
});

const STATUSES = ['pending', 'extracting', 'extracted', 'confirmed', 'needs_review', 'pushed', 'error'];

// Columns to select for lists/review — deliberately excludes the heavy
// `file_data` bytea so it is only ever loaded when streaming the PDF.
const INVOICE_COLS =
  'id, original_name, stored_path, status, extracted, vendor_name, invoice_number, ' +
  'invoice_date, total, rm_project_id, rm_attachment_id, error_msg, created_at, updated_at';

// Small async wrapper so thrown errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate :id is a positive integer, load the row, attach to req.
const loadInvoice = wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Invalid invoice id.');
    err.status = 400;
    throw err;
  }
  const { rows } = await query(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = $1`, [id]);
  if (!rows[0]) {
    const err = new Error('Invoice not found.');
    err.status = 404;
    throw err;
  }
  req.invoice = rows[0];
  next();
});

// --- background extraction -------------------------------------------------
// Fired without awaiting from the upload handler. Updates status as it goes.
async function processInvoice(id, pdfBuffer) {
  try {
    await query("UPDATE invoices SET status = 'extracting', updated_at = now() WHERE id = $1", [id]);
    const data = await extractInvoice(pdfBuffer);

    await query(
      `UPDATE invoices
         SET status = 'extracted',
             extracted = $2,
             vendor_name = $3,
             invoice_number = $4,
             invoice_date = $5,
             total = $6,
             error_msg = NULL,
             updated_at = now()
       WHERE id = $1`,
      [
        id,
        data,
        data.vendor_name ?? null,
        data.invoice_number ?? null,
        normalizeDate(data.invoice_date),
        normalizeNumber(data.total),
      ]
    );
  } catch (err) {
    const detail = err.raw || err.message || String(err);
    console.error(`[invoices] extraction failed for #${id}:`, err.message);
    await query(
      "UPDATE invoices SET status = 'error', error_msg = $2, updated_at = now() WHERE id = $1",
      [id, detail]
    ).catch((e) => console.error('[invoices] could not record error state:', e.message));
  }
}

function normalizeDate(v) {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function normalizeNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- GET / : dashboard -----------------------------------------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const filter = STATUSES.includes(req.query.status) ? req.query.status : null;
    const sql = filter
      ? `SELECT ${INVOICE_COLS} FROM invoices WHERE status = $1 ORDER BY created_at DESC`
      : `SELECT ${INVOICE_COLS} FROM invoices ORDER BY created_at DESC`;
    const { rows } = await query(sql, filter ? [filter] : []);

    res.render('dashboard', {
      title: 'Invoices',
      active: 'dashboard',
      invoices: rows,
      filter,
      statuses: STATUSES,
      notice: req.query.notice || null,
    });
  })
);

// --- POST /upload ----------------------------------------------------------
// Accepts one OR many PDFs (bulk). Each is stored and extraction kicked off.
router.post(
  '/upload',
  (req, res, next) =>
    upload.array('invoices', 50)(req, res, (err) => {
      if (err) {
        return res.redirect('/?notice=' + encodeURIComponent(err.message));
      }
      next();
    }),
  wrap(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) {
      return res.redirect('/?notice=' + encodeURIComponent('Please choose one or more PDFs to upload.'));
    }
    for (const file of files) {
      const { rows } = await query(
        `INSERT INTO invoices (original_name, status, file_data, mime_type)
         VALUES ($1, 'pending', $2, $3) RETURNING id`,
        [file.originalname, file.buffer, file.mimetype]
      );
      // Kick off extraction without blocking the response.
      processInvoice(rows[0].id, file.buffer);
    }

    const msg =
      files.length === 1
        ? `Uploaded "${files[0].originalname}" — extracting…`
        : `Uploaded ${files.length} receipts — extracting…`;
    res.redirect('/?notice=' + encodeURIComponent(msg));
  })
);

// --- GET /file/:id : stream the PDF inline ---------------------------------
router.get(
  '/file/:id',
  loadInvoice,
  wrap(async (req, res) => {
    const setHeaders = () => {
      res.setHeader('Content-Type', req.invoice.mime_type || 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(req.invoice.original_name)}"`
      );
    };

    // Primary path: the PDF bytes live in the database.
    const { rows } = await query(
      'SELECT file_data, mime_type FROM invoices WHERE id = $1',
      [req.invoice.id]
    );
    const fileData = rows[0]?.file_data;
    if (fileData) {
      res.setHeader('Content-Type', rows[0].mime_type || 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(req.invoice.original_name)}"`
      );
      return res.end(fileData);
    }

    // Fallback: a legacy record whose bytes were only ever on disk.
    if (req.invoice.stored_path) {
      const filePath = path.resolve(req.invoice.stored_path);
      if (fs.existsSync(filePath)) {
        setHeaders();
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    const err = new Error('This invoice was uploaded before files were stored in the database, so its PDF is no longer available. Please re-upload it.');
    err.status = 404;
    throw err;
  })
);

// --- GET /invoice/:id : review --------------------------------------------
router.get(
  '/invoice/:id',
  loadInvoice,
  wrap(async (req, res) => {
    const d = req.invoice.extracted || {};

    // Expense accounts for the type-to-search picker (best-effort).
    let glAccounts = [];
    try {
      glAccounts = (await listExpenseGLAccounts()).map((a) => ({
        id: String(a.GLAccountID),
        name: a.Name,
        ref: a.Reference,
      }));
    } catch {
      glAccounts = [];
    }
    const glMap = {};
    for (const a of glAccounts) glMap[a.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] = a.id;

    // Default selection: the AI suggestion, else the configured default.
    let defaultGlId = d.expense_account_id || '';
    let defaultGlName = d.expense_account_name || d.expense_account || '';
    if (!defaultGlId) {
      const { rows } = await query(
        'SELECT default_gl_account_id, default_gl_account_name FROM settings WHERE id = 1'
      );
      if (rows[0]) {
        defaultGlId = rows[0].default_gl_account_id || '';
        defaultGlName = defaultGlName || rows[0].default_gl_account_name || '';
      }
    }

    res.render('review', {
      title: `Review · ${req.invoice.original_name}`,
      active: 'dashboard',
      invoice: req.invoice,
      data: d,
      glAccounts,
      glMap,
      defaultGlId,
      defaultGlName,
      notice: req.query.notice || null,
    });
  })
);

// --- POST /invoice/:id/confirm --------------------------------------------
router.post(
  '/invoice/:id/confirm',
  loadInvoice,
  wrap(async (req, res) => {
    const b = req.body;

    // Reassemble line items from parallel arrays.
    const toArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const desc = toArr(b.li_description);
    const qty = toArr(b.li_qty);
    const unit = toArr(b.li_unit_price);
    const amount = toArr(b.li_amount);
    const lineItems = desc
      .map((d, i) => ({
        description: d || '',
        qty: normalizeNumber(qty[i]),
        unit_price: normalizeNumber(unit[i]),
        amount: normalizeNumber(amount[i]),
      }))
      .filter((li) => li.description || li.amount != null);

    const extracted = {
      ...(req.invoice.extracted || {}),
      vendor_name: b.vendor_name || null,
      invoice_number: b.invoice_number || null,
      invoice_date: normalizeDate(b.invoice_date),
      due_date: normalizeDate(b.due_date),
      subtotal: normalizeNumber(b.subtotal),
      tax: normalizeNumber(b.tax),
      total: normalizeNumber(b.total),
      property_reference: b.property_reference || null,
      credit_card: b.credit_card || null,
      card_last4: b.card_last4 ? String(b.card_last4).replace(/\D/g, '').slice(-4) : null,
      expense_account: b.expense_account || null,
      expense_account_id: b.expense_account_id || null,
      expense_account_name: b.expense_account || null,
      currency: b.currency || null,
      line_items: lineItems,
    };

    await query(
      `UPDATE invoices
         SET extracted = $2,
             vendor_name = $3,
             invoice_number = $4,
             invoice_date = $5,
             total = $6,
             status = 'confirmed',
             updated_at = now()
       WHERE id = $1`,
      [
        req.invoice.id,
        extracted,
        extracted.vendor_name,
        extracted.invoice_number,
        extracted.invoice_date,
        extracted.total,
      ]
    );

    res.redirect(
      `/invoice/${req.invoice.id}?notice=` + encodeURIComponent('Changes saved.')
    );
  })
);

// Build a short memo from the line items (or invoice number).
function memoFrom(d) {
  const items = Array.isArray(d.line_items) ? d.line_items : [];
  const desc = items.map((li) => li.description).filter(Boolean).slice(0, 5).join('; ');
  if (desc) return desc.slice(0, 250);
  return d.invoice_number ? `Invoice ${d.invoice_number}` : '';
}

// Map the extracted invoice + resolved RM records into the POST body.
// Per the CreditCardTransactionModel schema:
//   - vendor -> AccountID + AccountType:"Vendor"
//   - Amount is READ ONLY (sum of the details), so it goes on the detail line
//   - CreditCardTransactionDetails is REQUIRED on create — it carries the
//     property/expense allocation (the grey row in the RM form).
// Expense account (GLAccountID) is intentionally omitted for now per request
// ("just the total"); add it later when a mapping is configured.
function buildCreditCardTransaction({ card, vendor, property, glAccountId, d }) {
  const amount = normalizeNumber(d.total) ?? 0;
  const detail = {
    PropertyID: property.PropertyID ?? property.ID,
    GLAccountID: glAccountId,
    Amount: amount,
  };
  return {
    CreditCardID: card.CreditCardID ?? card.ID,
    AccountID: vendor.VendorID ?? vendor.ID,
    AccountType: 'Vendor',
    TransactionDate: normalizeDate(d.invoice_date) || new Date().toISOString().slice(0, 10),
    Reference: d.invoice_number || '',
    CreditCardTransactionDetails: [detail],
  };
}

// Resolve the RM credit card: prefer the configured last-4 mapping, then fall
// back to a fuzzy match on the card nickname. Returns { CreditCardID } or null.
async function resolveCard(d) {
  const last4 = d.card_last4 ? String(d.card_last4).replace(/\D/g, '').slice(-4) : null;
  if (last4) {
    const { rows } = await query('SELECT rm_card_id FROM card_mappings WHERE last4 = $1', [last4]);
    if (rows[0]) return { CreditCardID: rows[0].rm_card_id };
  }
  if (d.credit_card) {
    return findCreditCardByName(d.credit_card);
  }
  return null;
}

// Core push logic, reused by the single-invoice and push-all routes.
// Returns { ok:boolean, status:string, message:string }.
async function pushInvoice(inv) {
  const d = inv.extracted || {};
  const setStatus = (status, msg) =>
    query('UPDATE invoices SET status = $2, error_msg = $3, updated_at = now() WHERE id = $1', [
      inv.id,
      status,
      status === 'pushed' ? null : msg,
    ]);

  try {
    // 1) Credit card — required.
    const card = await resolveCard(d);
    if (!card) {
      const which = d.card_last4 || d.credit_card || '(none)';
      const msg = `Credit card not found: ${which}`;
      await setStatus('needs_review', msg);
      return { ok: false, status: 'needs_review', message: msg };
    }

    // 2) Vendor — match by merchant name, create if missing.
    let vendor = d.vendor_name ? await findVendorByName(d.vendor_name) : null;
    if (!vendor && d.vendor_name) vendor = await createVendor(d.vendor_name);
    if (!vendor) {
      const msg = 'Needs review: no vendor/merchant on the receipt.';
      await setStatus('needs_review', msg);
      return { ok: false, status: 'needs_review', message: msg };
    }

    // 3) Property/job — flag for manual review if unmatched.
    const property = d.property_reference ? await findPropertyByName(d.property_reference) : null;
    if (!property) {
      const msg = `Needs review: property/job not matched ("${d.property_reference || ''}").`;
      await setStatus('needs_review', msg);
      return { ok: false, status: 'needs_review', message: msg };
    }

    // 4) Expense (GL) account — required by RM. Prefer the per-receipt choice,
    //    then the configured default.
    let glAccountId = d.expense_account_id || null;
    if (!glAccountId) {
      const { rows: sRows } = await query('SELECT default_gl_account_id FROM settings WHERE id = 1');
      glAccountId = sRows[0] && sRows[0].default_gl_account_id;
    }
    if (!glAccountId) {
      const msg = 'Needs review: choose a default expense account in Settings (Rent Manager requires a GL account).';
      await setStatus('needs_review', msg);
      return { ok: false, status: 'needs_review', message: msg };
    }

    // 5) Create the transaction.
    const txnId = await createCreditCardTransaction(buildCreditCardTransaction({ card, vendor, property, glAccountId, d }));
    await query(
      "UPDATE invoices SET status = 'pushed', rm_project_id = $2, error_msg = NULL, updated_at = now() WHERE id = $1",
      [inv.id, txnId != null ? String(txnId) : null]
    );

    // 6) Attach the receipt PDF — non-fatal: never undo a created transaction.
    let attachNote = '';
    try {
      const { rows: fr } = await query('SELECT file_data FROM invoices WHERE id = $1', [inv.id]);
      const fileData = fr[0] && fr[0].file_data;
      if (fileData && txnId != null) {
        const attId = await attachReceipt(txnId, fileData, inv.original_name);
        await query('UPDATE invoices SET rm_attachment_id = $2 WHERE id = $1', [
          inv.id,
          attId != null ? String(attId) : null,
        ]);
      }
    } catch (err) {
      console.error(`[invoices] attach failed for #${inv.id}:`, err.message);
      attachNote = ` (receipt attach failed: ${err.message.slice(0, 140)})`;
    }

    return { ok: true, status: 'pushed', message: `Credit card transaction ${txnId ?? 'created'}.${attachNote}` };
  } catch (err) {
    console.error(`[invoices] push failed for #${inv.id}:`, err.message);
    const msg = `Push failed: ${err.message}`;
    await setStatus('needs_review', msg);
    return { ok: false, status: 'needs_review', message: msg };
  }
}

// --- POST /invoice/:id/push -----------------------------------------------
router.post(
  '/invoice/:id/push',
  loadInvoice,
  wrap(async (req, res) => {
    const result = await pushInvoice(req.invoice);
    const prefix = result.ok ? 'Pushed to Rent Manager — ' : '';
    return res.redirect(`/invoice/${req.invoice.id}?notice=` + encodeURIComponent(prefix + result.message));
  })
);

// --- POST /push-all : push every invoice that is ready ---------------------
router.post(
  '/push-all',
  wrap(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM invoices WHERE status IN ('extracted', 'confirmed', 'needs_review') ORDER BY created_at ASC"
    );
    let pushed = 0;
    let flagged = 0;
    for (const inv of rows) {
      const r = await pushInvoice(inv);
      if (r.ok) pushed += 1;
      else flagged += 1;
    }
    const msg = `Push all: ${pushed} pushed, ${flagged} need review${rows.length === 0 ? ' (nothing ready)' : ''}.`;
    return res.redirect('/?notice=' + encodeURIComponent(msg));
  })
);

// --- GET /invoice/:id/delete ----------------------------------------------
router.get(
  '/invoice/:id/delete',
  loadInvoice,
  wrap(async (req, res) => {
    // Best-effort cleanup of any legacy on-disk file; the row (incl. bytes) is
    // the source of truth.
    if (req.invoice.stored_path) {
      fs.rm(path.resolve(req.invoice.stored_path), { force: true }, () => {});
    }
    await query('DELETE FROM invoices WHERE id = $1', [req.invoice.id]);
    res.redirect('/?notice=' + encodeURIComponent('Invoice deleted.'));
  })
);

export default router;
