import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { parseStatement } from '../services/statement.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DAY = 24 * 60 * 60 * 1000;

// Match a statement charge to an existing invoice: amount within a cent, date
// within ±5 days, and last-4 consistent when both sides have it.
function matchCharge(charge, invoices) {
  const amt = Number(charge.amount);
  const cDate = charge.charge_date ? new Date(charge.charge_date).getTime() : null;
  let best = null;
  for (const inv of invoices) {
    if (inv._used) continue;
    if (inv.total == null || Math.abs(Number(inv.total) - amt) > 0.01) continue;
    if (cDate != null && inv.invoice_date) {
      const days = Math.abs(cDate - new Date(inv.invoice_date).getTime()) / DAY;
      if (days > 5) continue;
    }
    const invLast4 = inv.extracted && inv.extracted.card_last4 ? String(inv.extracted.card_last4).slice(-4) : null;
    if (charge.last4 && invLast4 && charge.last4 !== invLast4) continue;
    best = inv;
    break;
  }
  return best;
}

// --- GET /reconcile : dashboard -------------------------------------------
router.get(
  '/reconcile',
  wrap(async (req, res) => {
    const { rows: statements } = await query('SELECT * FROM statements ORDER BY created_at DESC');
    const current = statements[0] || null;

    let charges = [];
    let summary = { total: 0, matched: 0, missing: 0 };
    if (current) {
      const r = await query(
        'SELECT * FROM statement_charges WHERE statement_id = $1 ORDER BY charge_date DESC NULLS LAST, id',
        [current.id]
      );
      charges = r.rows;
      summary.total = charges.length;
      summary.matched = charges.filter((c) => c.status === 'matched').length;
      summary.missing = summary.total - summary.matched;
    }

    res.render('reconcile', {
      title: 'Reconcile',
      active: 'reconcile',
      statements,
      current,
      charges,
      summary,
      notice: req.query.notice || null,
    });
  })
);

// --- POST /reconcile/upload -----------------------------------------------
router.post(
  '/reconcile/upload',
  (req, res, next) =>
    upload.single('statement')(req, res, (err) => {
      if (err) return res.redirect('/reconcile?notice=' + encodeURIComponent(err.message));
      next();
    }),
  wrap(async (req, res) => {
    if (!req.file) {
      return res.redirect('/reconcile?notice=' + encodeURIComponent('Please choose a statement file (CSV or PDF).'));
    }

    let parsed;
    try {
      parsed = await parseStatement(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (err) {
      return res.redirect('/reconcile?notice=' + encodeURIComponent(`Could not parse statement: ${err.message}`));
    }
    if (!parsed.charges.length) {
      return res.redirect('/reconcile?notice=' + encodeURIComponent('No charges were found in that file.'));
    }

    // Load candidate invoices once for matching.
    const { rows: invoices } = await query(
      "SELECT id, total, invoice_date, extracted FROM invoices WHERE status IN ('extracted','confirmed','needs_review','pushed')"
    );

    const { rows: stRows } = await query(
      'INSERT INTO statements (original_name, source_type, charge_count) VALUES ($1, $2, $3) RETURNING id',
      [req.file.originalname, parsed.sourceType, parsed.charges.length]
    );
    const statementId = stRows[0].id;

    let matched = 0;
    for (const c of parsed.charges) {
      const hit = matchCharge({ ...c, charge_date: c.date }, invoices);
      if (hit) hit._used = true;
      if (hit) matched += 1;
      await query(
        `INSERT INTO statement_charges (statement_id, charge_date, amount, description, last4, matched_invoice_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [statementId, c.date, c.amount, c.description, c.last4, hit ? hit.id : null, hit ? 'matched' : 'missing']
      );
    }

    const msg = `Loaded ${parsed.charges.length} charges — ${matched} matched, ${parsed.charges.length - matched} missing a receipt.`;
    res.redirect('/reconcile?notice=' + encodeURIComponent(msg));
  })
);

// --- GET /reconcile/:id/delete --------------------------------------------
router.get(
  '/reconcile/:id/delete',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isInteger(id)) await query('DELETE FROM statements WHERE id = $1', [id]);
    res.redirect('/reconcile?notice=' + encodeURIComponent('Statement removed.'));
  })
);

export default router;
