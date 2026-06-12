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
router.post(
  '/upload',
  (req, res, next) =>
    upload.single('invoice')(req, res, (err) => {
      if (err) {
        return res.redirect('/?notice=' + encodeURIComponent(err.message));
      }
      next();
    }),
  wrap(async (req, res) => {
    if (!req.file) {
      return res.redirect('/?notice=' + encodeURIComponent('Please choose a PDF to upload.'));
    }
    const { rows } = await query(
      `INSERT INTO invoices (original_name, status, file_data, mime_type)
       VALUES ($1, 'pending', $2, $3) RETURNING id`,
      [req.file.originalname, req.file.buffer, req.file.mimetype]
    );
    const id = rows[0].id;

    // Kick off extraction without blocking the response.
    processInvoice(id, req.file.buffer);

    res.redirect('/?notice=' + encodeURIComponent(`Uploaded "${req.file.originalname}" — extracting…`));
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
    res.render('review', {
      title: `Review · ${req.invoice.original_name}`,
      active: 'dashboard',
      invoice: req.invoice,
      data: req.invoice.extracted || {},
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
// Field names are CONFIRMED from the live CreditCardTransactions schema:
//   vendor -> AccountID + AccountType:"Vendor"; date -> TransactionDate;
//   memo -> Comment. The property/GL allocation is a child structure (not on the
//   header) and is added once its shape is confirmed via discovery.
function buildCreditCardTransaction({ card, vendor, property, d }) {
  return {
    CreditCardID: card.CreditCardID ?? card.ID,
    AccountID: vendor.VendorID ?? vendor.ID,
    AccountType: 'Vendor',
    TransactionDate: normalizeDate(d.invoice_date) || new Date().toISOString().slice(0, 10),
    Reference: d.invoice_number || '',
    Comment: memoFrom(d),
    Amount: normalizeNumber(d.total) ?? 0,
    // "Charge" is the transaction direction; RM records TransactionType "CreditCard".
    Type: 'Charge',
    // TODO(property): attach `property` (PropertyID ${'${property?.PropertyID}'}) via the
    // confirmed child allocation structure once discovery returns it.
  };
}

// --- POST /invoice/:id/push -----------------------------------------------
// Pushes the invoice to Rent Manager as a Credit Card Transaction.
router.post(
  '/invoice/:id/push',
  loadInvoice,
  wrap(async (req, res) => {
    const inv = req.invoice;
    const d = inv.extracted || {};

    // Flag for manual review (no silent failures): keep the row, record why.
    const flag = async (msg) => {
      await query(
        "UPDATE invoices SET status = 'needs_review', error_msg = $2, updated_at = now() WHERE id = $1",
        [inv.id, msg]
      );
      return res.redirect(`/invoice/${inv.id}?notice=` + encodeURIComponent(msg));
    };

    try {
      // 1) Credit card — required; a missing/unmatched card is a hard stop.
      if (!d.credit_card) return flag('Needs review: no credit card found on the invoice.');
      const card = await findCreditCardByName(d.credit_card);
      if (!card) return flag(`Credit card not found: ${d.credit_card}`);

      // 2) Vendor — match by merchant name, create if it doesn't exist.
      let vendor = d.vendor_name ? await findVendorByName(d.vendor_name) : null;
      if (!vendor && d.vendor_name) {
        vendor = await createVendor(d.vendor_name);
      }
      if (!vendor) return flag('Needs review: no vendor/merchant on the invoice.');

      // 3) Property/job — flag for manual review if unmatched.
      const property = d.property_reference ? await findPropertyByName(d.property_reference) : null;
      if (!property) {
        return flag(`Needs review: property/job not matched ("${d.property_reference || ''}").`);
      }

      // 4) Create the transaction.
      const payload = buildCreditCardTransaction({ card, vendor, property, d });
      const txnId = await createCreditCardTransaction(payload);

      await query(
        "UPDATE invoices SET status = 'pushed', rm_project_id = $2, updated_at = now() WHERE id = $1",
        [inv.id, txnId != null ? String(txnId) : null]
      );
      return res.redirect(
        `/invoice/${inv.id}?notice=` +
          encodeURIComponent(`Pushed to Rent Manager — credit card transaction ${txnId ?? 'created'}.`)
      );
    } catch (err) {
      console.error(`[invoices] push failed for #${inv.id}:`, err.message);
      return flag(`Push failed: ${err.message}`);
    }
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
