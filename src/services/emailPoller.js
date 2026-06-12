// Email intake: poll an IMAP mailbox for new messages, turn each PDF attachment
// into an invoice row, extract it with Claude, and (optionally) auto-push it to
// Rent Manager as a credit card transaction.
//
// This is the "every bill emailed to <address> lands in Rent Manager" path. It
// reuses the exact same extraction (ingest.js) and push (pushInvoice.js) logic
// as the manual upload flow, so an emailed bill behaves identically to a dropped
// PDF — it just arrives on its own.
//
// Reliability notes:
//  - Processed messages are flagged \Seen so they aren't handled twice; a
//    DB-level de-dupe on (email_message_id, original_name) is the backstop if a
//    message is re-polled before it could be flagged.
//  - A module-level `running` guard prevents overlapping polls.
//  - Unconfigured = no-op (the app runs fine without an inbox configured).

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

import { query } from '../db/pool.js';
import { getCredentials } from './credentials.js';
import { extractAndStore } from './ingest.js';
import { pushInvoiceToRentManager } from './pushInvoice.js';

const DEFAULT_INTERVAL_MS = 60 * 1000;

let running = false;
let timer = null;

function isPdf(att) {
  if (!att) return false;
  const type = (att.contentType || '').toLowerCase();
  const name = (att.filename || '').toLowerCase();
  return type === 'application/pdf' || name.endsWith('.pdf');
}

// Process one fetched message: filter by sender, store each PDF attachment as an
// invoice, extract, and auto-push when enabled. Always flags the message \Seen
// at the end (best effort) so it isn't reprocessed.
async function processMessage(client, uid, source, cfg) {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  const subject = parsed.subject || null;
  const messageId = parsed.messageId || `imap-uid-${uid}`;

  const markSeen = () =>
    client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});

  // Optional sender allow-list.
  if (cfg.allowedSenders.length && !cfg.allowedSenders.some((s) => from.includes(s))) {
    console.log(`[email] skipping message from ${from || 'unknown'} (not in allow-list).`);
    return markSeen();
  }

  const pdfs = (parsed.attachments || []).filter(isPdf);
  if (pdfs.length === 0) {
    console.log(`[email] message from ${from || 'unknown'} has no PDF attachment — skipping.`);
    return markSeen();
  }

  for (const att of pdfs) {
    const filename = att.filename || `invoice-${Date.now()}.pdf`;

    // De-dupe: a re-polled message must not create a second row.
    const dup = await query(
      'SELECT 1 FROM invoices WHERE email_message_id = $1 AND original_name = $2 LIMIT 1',
      [messageId, filename]
    );
    if (dup.rowCount) {
      console.log(`[email] already ingested "${filename}" from ${messageId} — skipping.`);
      continue;
    }

    const { rows } = await query(
      `INSERT INTO invoices
         (original_name, status, file_data, mime_type, source, email_from, email_subject, email_message_id)
       VALUES ($1, 'pending', $2, 'application/pdf', 'email', $3, $4, $5)
       RETURNING id`,
      [filename, att.content, from || null, subject, messageId]
    );
    const id = rows[0].id;
    console.log(`[email] ingested "${filename}" from ${from || 'unknown'} as invoice #${id}.`);

    try {
      const inv = await extractAndStore(id, att.content);
      if (cfg.autoPush) {
        const result = await pushInvoiceToRentManager({ id, extracted: inv.extracted });
        console.log(`[email] invoice #${id}: ${result.message}`);
      } else {
        console.log(`[email] invoice #${id} extracted — waiting for manual review.`);
      }
    } catch (err) {
      // extractAndStore already set the row to 'error'; just log and move on.
      console.error(`[email] invoice #${id} extraction failed: ${err.message}`);
    }
  }

  return markSeen();
}

/**
 * Run a single poll cycle. Safe to call repeatedly; no-ops if a poll is already
 * in progress or the inbox isn't configured.
 */
export async function pollInbox() {
  if (running) return;

  const { email } = await getCredentials();
  if (!email.host || !email.user || !email.password) return; // not configured -> no-op

  running = true;
  let client;
  try {
    client = new ImapFlow({
      host: email.host,
      port: email.port,
      secure: email.port === 993,
      auth: { user: email.user, pass: email.password },
      logger: false,
    });
    await client.connect();

    const lock = await client.getMailboxLock(email.mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (uids && uids.length) {
        console.log(`[email] ${uids.length} new message(s) in ${email.mailbox}.`);
        // Snapshot source bytes first, then process — avoids mutating flags while
        // a fetch generator is open on the same connection.
        const fetched = [];
        for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          fetched.push({ uid: msg.uid, source: msg.source });
        }
        for (const m of fetched) {
          await processMessage(client, m.uid, m.source, email).catch((err) =>
            console.error(`[email] message ${m.uid} failed:`, err.message)
          );
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('[email] poll failed:', err.message);
    if (client) {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Start the recurring inbox poller. Called once at server startup; non-fatal if
 * the inbox isn't configured (pollInbox just no-ops until it is).
 */
export function startEmailPoller() {
  if (timer) return; // already started
  const interval = Number(process.env.EMAIL_POLL_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  // Kick one off shortly after boot, then on the interval.
  setTimeout(() => pollInbox().catch((e) => console.error('[email] initial poll error:', e.message)), 5000);
  timer = setInterval(
    () => pollInbox().catch((e) => console.error('[email] poll error:', e.message)),
    interval
  );
  // Don't keep the process alive solely for the timer.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[email] inbox poller started (every ${Math.round(interval / 1000)}s).`);
}

/**
 * Lightweight connection test for the Settings UI: connect, open the mailbox,
 * report how many messages it holds. Throws on any failure.
 */
export async function testInbox() {
  const { email } = await getCredentials();
  if (!email.host || !email.user || !email.password) {
    throw new Error('IMAP host, username and password are all required.');
  }
  const client = new ImapFlow({
    host: email.host,
    port: email.port,
    secure: email.port === 993,
    auth: { user: email.user, pass: email.password },
    logger: false,
  });
  await client.connect();
  try {
    const mb = await client.mailboxOpen(email.mailbox);
    return { mailbox: email.mailbox, total: mb.exists };
  } finally {
    await client.logout().catch(() => {});
  }
}
