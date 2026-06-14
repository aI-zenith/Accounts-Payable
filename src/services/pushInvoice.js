// Push a confirmed/extracted invoice to Rent Manager as a Credit Card
// Transaction, then attach the receipt PDF. Shared by the manual "Push" button,
// the "Push all" action, and the email auto-push path so every entry point
// resolves records, allocates, and attaches identically.
//
// Property assignment (per requirement): the property is identified PRIMARILY by
// the credit card used (each RM card belongs to a property). The invoice's
// job/property reference is then a SECOND-STEP verification — it must match that
// property or one of its units. A card with no linked property falls back to a
// name match on the job reference. Anything unmatched is flagged needs_review
// rather than guessed.

import { query } from '../db/pool.js';
import {
  findCreditCardByName,
  findVendorByName,
  createVendor,
  findPropertyByName,
  findPropertyForCreditCard,
  jobMatchesPropertyOrUnit,
  createCreditCardTransaction,
  attachReceipt,
} from './rmClient.js';

function normalizeDate(v) {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function normalizeNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map the extracted invoice + resolved RM records into the POST body.
// Per the CreditCardTransactionModel schema:
//   - vendor -> AccountID + AccountType:"Vendor"
//   - Amount is READ ONLY (sum of the details), so it goes on the detail line
//   - CreditCardTransactionDetails is REQUIRED on create — it carries the
//     property/expense allocation (the grey row in the RM form).
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

// Attach the stored receipt PDF to a transaction. Returns a short status note.
async function doAttach(inv, txnId) {
  if (txnId == null) return ' (could not read the transaction id, so the receipt was not attached)';
  try {
    const { rows: fr } = await query('SELECT file_data FROM invoices WHERE id = $1', [inv.id]);
    const fileData = fr[0] && fr[0].file_data;
    if (!fileData) return '';
    const attId = await attachReceipt(txnId, fileData, inv.original_name);
    await query('UPDATE invoices SET rm_attachment_id = $2 WHERE id = $1', [
      inv.id,
      attId != null ? String(attId) : null,
    ]);
    return ' Receipt attached.';
  } catch (err) {
    // Non-fatal: the transaction already exists and the PDF stays stored in this
    // app. Log details; show a short note.
    console.error(`[push] receipt attach failed for #${inv.id}:`, err.message);
    return ` (receipt attach failed: ${err.message.slice(0, 160)})`;
  }
}

/**
 * Core push logic. Resolves records, creates the transaction, attaches the
 * receipt, and owns the row's terminal status transition. Never throws for a
 * business reason — unmatched records / RM errors become a needs_review result
 * so callers (button, push-all, email auto-push) can run unattended.
 *
 * @param {object} inv  the invoice row (needs id, extracted, original_name,
 *                      rm_project_id, rm_attachment_id)
 * @returns {Promise<{ ok:boolean, status:string, message:string }>}
 */
export async function pushInvoice(inv) {
  const d = inv.extracted || {};

  // Idempotency: if a transaction already exists for this invoice, never create
  // a duplicate — just (re)attach the receipt if it isn't attached yet.
  if (inv.rm_project_id) {
    if (inv.rm_attachment_id) {
      return { ok: true, status: 'pushed', message: `Already pushed (transaction ${inv.rm_project_id}, receipt attached).` };
    }
    const note = await doAttach(inv, Number(inv.rm_project_id));
    return { ok: true, status: 'pushed', message: `Already pushed (transaction ${inv.rm_project_id}).${note}` };
  }

  const setStatus = (status, msg) =>
    query('UPDATE invoices SET status = $2, error_msg = $3, updated_at = now() WHERE id = $1', [
      inv.id,
      status,
      status === 'pushed' ? null : msg,
    ]);

  try {
    // 1) Credit card — required (and the key to the property in step 3).
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

    // 3) Property — PRIMARY: the credit card's linked property; SECONDARY: the
    //    invoice's job/property reference must verify against it (the property
    //    itself or one of its units). A card with no linked property falls back
    //    to a name match on the job reference.
    let property = await findPropertyForCreditCard(card);
    if (property) {
      const jobRef = d.property_reference || '';
      if (!(await jobMatchesPropertyOrUnit(property, jobRef))) {
        const msg = `Needs review: job "${jobRef}" does not match card property "${property.Name}" or any of its units.`;
        await setStatus('needs_review', msg);
        return { ok: false, status: 'needs_review', message: msg };
      }
    } else {
      property = d.property_reference ? await findPropertyByName(d.property_reference) : null;
    }
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
    const txnId = await createCreditCardTransaction(
      buildCreditCardTransaction({ card, vendor, property, glAccountId, d })
    );
    await query(
      "UPDATE invoices SET status = 'pushed', rm_project_id = $2, error_msg = NULL, updated_at = now() WHERE id = $1",
      [inv.id, txnId != null ? String(txnId) : null]
    );

    // 6) Attach the receipt PDF — non-fatal: never undo a created transaction.
    const attachNote = await doAttach(inv, txnId);
    return { ok: true, status: 'pushed', message: `Credit card transaction ${txnId ?? 'created'}.${attachNote}` };
  } catch (err) {
    console.error(`[push] push failed for #${inv.id}:`, err.message);
    const msg = `Push failed: ${err.message}`;
    await setStatus('needs_review', msg);
    return { ok: false, status: 'needs_review', message: msg };
  }
}
