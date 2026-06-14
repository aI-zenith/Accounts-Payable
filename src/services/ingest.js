// Shared invoice ingestion: run Claude extraction for an existing invoice row
// and persist the structured result. Used by BOTH the manual upload route and
// the email poller so the two paths behave identically.

import { query } from '../db/pool.js';
import { extractInvoice } from './extract.js';

function normalizeDate(v) {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function normalizeNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a stored invoice's PDF and write the result back to its row.
 * Moves status pending/`extracting` -> `extracted`, or `error` on failure.
 * On failure the row's error is recorded *before* the error is re-thrown, so
 * callers can simply log-and-continue (background upload) or skip the push
 * (email auto-push) without losing the reason.
 *
 * @param {number} id  invoices.id
 * @param {Buffer} pdfBuffer  the raw PDF bytes
 * @returns {Promise<{ id:number, extracted:object }>}
 */
export async function extractAndStore(id, pdfBuffer) {
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
    return { id, extracted: data };
  } catch (err) {
    const detail = err.raw || err.message || String(err);
    await query(
      "UPDATE invoices SET status = 'error', error_msg = $2, updated_at = now() WHERE id = $1",
      [id, detail]
    ).catch((e) => console.error('[ingest] could not record error state:', e.message));
    throw err;
  }
}
