import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { extractInvoice } from '../services/extract.js';
import { createProject, attachDocument } from '../services/rmClient.js';

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are accepted.'));
  },
});

const STATUSES = ['pending', 'extracting', 'extracted', 'confirmed', 'pushed', 'error'];

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
  const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
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
async function processInvoice(id, filePath) {
  try {
    await query("UPDATE invoices SET status = 'extracting', updated_at = now() WHERE id = $1", [id]);
    const data = await extractInvoice(filePath);

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
      ? 'SELECT * FROM invoices WHERE status = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM invoices ORDER BY created_at DESC';
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
      `INSERT INTO invoices (original_name, stored_path, status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [req.file.originalname, req.file.path]
    );
    const id = rows[0].id;

    // Kick off extraction without blocking the response.
    processInvoice(id, req.file.path);

    res.redirect('/?notice=' + encodeURIComponent(`Uploaded "${req.file.originalname}" — extracting…`));
  })
);

// --- GET /file/:id : stream the PDF inline ---------------------------------
router.get(
  '/file/:id',
  loadInvoice,
  wrap(async (req, res) => {
    const filePath = path.resolve(req.invoice.stored_path);
    if (!fs.existsSync(filePath)) {
      const err = new Error('Stored PDF is missing on disk.');
      err.status = 404;
      throw err;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(req.invoice.original_name)}"`
    );
    fs.createReadStream(filePath).pipe(res);
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

// --- POST /invoice/:id/push -----------------------------------------------
router.post(
  '/invoice/:id/push',
  loadInvoice,
  wrap(async (req, res) => {
    const inv = req.invoice;
    try {
      const projectId = await createProject(inv.extracted || {});
      const attachmentId = await attachDocument(projectId, inv.stored_path);
      await query(
        `UPDATE invoices
           SET status = 'pushed', rm_project_id = $2, rm_attachment_id = $3, updated_at = now()
         WHERE id = $1`,
        [inv.id, String(projectId), String(attachmentId)]
      );
      return res.redirect(
        `/invoice/${inv.id}?notice=` + encodeURIComponent('Pushed to Rent Manager.')
      );
    } catch (err) {
      // The stubs throw a TODO error until the endpoints are wired. Surface a
      // friendly message and keep the invoice in its confirmed state.
      console.warn(`[invoices] push not wired for #${inv.id}: ${err.message}`);
      return res.redirect(
        `/invoice/${inv.id}?notice=` +
          encodeURIComponent(
            'Push to Rent Manager is not wired up yet (pending API discovery). The invoice is saved as confirmed.'
          )
      );
    }
  })
);

// --- GET /invoice/:id/delete ----------------------------------------------
router.get(
  '/invoice/:id/delete',
  loadInvoice,
  wrap(async (req, res) => {
    const filePath = path.resolve(req.invoice.stored_path);
    fs.rm(filePath, { force: true }, () => {});
    await query('DELETE FROM invoices WHERE id = $1', [req.invoice.id]);
    res.redirect('/?notice=' + encodeURIComponent('Invoice deleted.'));
  })
);

export default router;
