// Push a confirmed/extracted invoice to Rent Manager as a Credit Card
// Transaction. Shared by the manual "Push to Rent Manager" button and the email
// auto-push path so both resolve records the same way and flag the same review
// cases. The function owns the invoice row's terminal status transition:
//   success      -> 'pushed'   (+ rm_project_id = the new transaction id)
//   any mismatch -> 'needs_review' (+ error_msg = why)
//
// It NEVER throws for a business reason (unmatched card/vendor/property or an RM
// error) — those become a 'needs_review' result so callers can run unattended.

import { query } from '../db/pool.js';
import {
  findCreditCardByName,
  findVendorByName,
  createVendor,
  findPropertyForCreditCard,
  jobMatchesPropertyOrUnit,
  createCreditCardTransaction,
  attachInvoiceFile,
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
    // TODO(property): attach `property` (PropertyID ${property?.PropertyID}) via the
    // confirmed child allocation structure once discovery returns it.
  };
}

/**
 * Resolve records and create the Rent Manager credit card transaction.
 * @param {{ id:number, extracted:object }} inv  the invoice row (needs id + extracted)
 * @returns {Promise<{ ok:boolean, status:'pushed'|'needs_review', txnId?:any, message:string }>}
 */
export async function pushInvoiceToRentManager(inv) {
  const d = inv.extracted || {};

  // Record a manual-review state and return it (no silent failures).
  const flag = async (msg) => {
    await query(
      "UPDATE invoices SET status = 'needs_review', error_msg = $2, updated_at = now() WHERE id = $1",
      [inv.id, msg]
    ).catch((e) => console.error('[push] could not record review state:', e.message));
    return { ok: false, status: 'needs_review', message: msg };
  };

  try {
    // 1) Credit card — required; a missing/unmatched card is a hard stop. The
    //    card is also how we identify the property (step 3), so it must resolve.
    if (!d.credit_card) return flag('Needs review: no credit card found on the invoice.');
    const card = await findCreditCardByName(d.credit_card);
    if (!card) return flag(`Credit card not found: ${d.credit_card}`);

    // 2) Vendor — match by merchant name, create if it doesn't exist.
    let vendor = d.vendor_name ? await findVendorByName(d.vendor_name) : null;
    if (!vendor && d.vendor_name) {
      vendor = await createVendor(d.vendor_name);
    }
    if (!vendor) return flag('Needs review: no vendor/merchant on the invoice.');

    // 3) Property — PRIMARY: derive it from the credit card used. SECONDARY: the
    //    invoice's job/property reference must verify against that property
    //    (matching the property itself or one of its units). A failed/absent
    //    verification is flagged for manual review rather than guessed.
    const property = await findPropertyForCreditCard(card);
    if (!property) {
      return flag(`Needs review: credit card "${card.Name}" is not linked to a property in Rent Manager.`);
    }
    const jobRef = d.property_reference || '';
    if (!jobRef) {
      return flag(
        `Needs review: no job/property reference on the invoice to verify against card property "${property.Name}".`
      );
    }
    if (!(await jobMatchesPropertyOrUnit(property, jobRef))) {
      return flag(
        `Needs review: job "${jobRef}" does not match card property "${property.Name}" or any of its units.`
      );
    }

    // 4) Create the transaction.
    const payload = buildCreditCardTransaction({ card, vendor, property, d });
    const txnId = await createCreditCardTransaction(payload);

    // 5) Attach the original PDF to the created record. This is best-effort and
    //    deliberately NON-FATAL: the transaction already exists, so a failed
    //    attach must never flip the row to a state that would re-push (and thus
    //    double-charge). We record the attachment id on success and surface a
    //    note on failure so it can be retried by hand.
    let attachmentNote = '';
    try {
      const { rows } = await query(
        'SELECT file_data, original_name FROM invoices WHERE id = $1',
        [inv.id]
      );
      const file = rows[0];
      if (file?.file_data && txnId != null) {
        const attachmentId = await attachInvoiceFile(txnId, {
          filename: file.original_name || `invoice-${inv.id}.pdf`,
          content: file.file_data,
          description: d.invoice_number ? `Invoice ${d.invoice_number}` : 'Receipt',
        });
        await query('UPDATE invoices SET rm_attachment_id = $2 WHERE id = $1', [
          inv.id,
          attachmentId != null ? String(attachmentId) : null,
        ]);
      } else if (txnId == null) {
        attachmentNote = ' (no transaction id returned, so the PDF was not attached)';
      }
    } catch (err) {
      console.error(`[push] attach failed for #${inv.id} (txn ${txnId}):`, err.message);
      attachmentNote = ` (transaction created, but attaching the PDF failed: ${err.message})`;
    }

    await query(
      "UPDATE invoices SET status = 'pushed', rm_project_id = $2, updated_at = now() WHERE id = $1",
      [inv.id, txnId != null ? String(txnId) : null]
    );
    return {
      ok: true,
      status: 'pushed',
      txnId,
      message: `Pushed to Rent Manager — credit card transaction ${txnId ?? 'created'}.${attachmentNote}`,
    };
  } catch (err) {
    console.error(`[push] failed for #${inv.id}:`, err.message);
    return flag(`Push failed: ${err.message}`);
  }
}
