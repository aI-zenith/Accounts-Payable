import { pool } from './pool.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS invoices (
     id               serial PRIMARY KEY,
     original_name    text NOT NULL,
     stored_path      text NOT NULL,
     status           text NOT NULL DEFAULT 'pending',
     extracted        jsonb,
     vendor_name      text,
     invoice_number   text,
     invoice_date     date,
     total            numeric(12,2),
     rm_project_id    text,
     rm_attachment_id text,
     error_msg        text,
     created_at       timestamptz DEFAULT now(),
     updated_at       timestamptz DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status)`,

  `CREATE TABLE IF NOT EXISTS settings (
     id                int PRIMARY KEY DEFAULT 1,
     rm_subdomain      text,
     rm_username       text,
     rm_password       text,
     anthropic_api_key text,
     updated_at        timestamptz DEFAULT now(),
     CONSTRAINT settings_singleton CHECK (id = 1)
   )`,

  // Ensure the singleton row exists so settings reads/upserts are simple.
  `INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

  // Store the original PDF bytes in the database so files survive deploys /
  // restarts on ephemeral hosting (no persistent disk required).
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS file_data bytea`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mime_type text`,
  // stored_path is now optional (legacy/disk fallback only).
  `ALTER TABLE invoices ALTER COLUMN stored_path DROP NOT NULL`,

  // Email intake: where the invoice came from ('upload' | 'email') plus the
  // originating message metadata. email_message_id is used to de-duplicate so a
  // re-polled message never creates a second row.
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source text DEFAULT 'upload'`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_from text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_subject text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_message_id text`,
  `CREATE INDEX IF NOT EXISTS invoices_email_msg_idx ON invoices (email_message_id)`,

  // Inbox (IMAP) settings for automatic email intake. The password is stored
  // encrypted (same scheme as the RM/Claude secrets); everything else is plain.
  // email_auto_push: when true, an emailed bill is pushed to Rent Manager
  // automatically once card/vendor/property all match (else it waits for review).
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_host text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_port int`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_user text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_password text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_mailbox text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS imap_allowed_senders text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS email_auto_push boolean DEFAULT true`,

  // Default expense (GL) account for the credit card transaction allocation.
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_gl_account_id text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_gl_account_name text`,
  // Seed "Maintenance Material" (GLAccountID 345) as the default if unset.
  // Only fills a blank value, so a user's later choice is never overwritten.
  `UPDATE settings SET default_gl_account_id = '345', default_gl_account_name = 'Maintenance Material'
     WHERE id = 1 AND (default_gl_account_id IS NULL OR default_gl_account_id = '')`,

  // Map a credit card's last-4 digits to a Rent Manager credit card id, so the
  // push posts to the right card (e.g. 6760 -> "Chase ...7202").
  `CREATE TABLE IF NOT EXISTS card_mappings (
     id           serial PRIMARY KEY,
     last4        text NOT NULL UNIQUE,
     rm_card_id   text NOT NULL,
     rm_card_name text,
     created_at   timestamptz DEFAULT now()
   )`,

  // Statement reconciliation: uploaded statements and their parsed charges.
  `CREATE TABLE IF NOT EXISTS statements (
     id            serial PRIMARY KEY,
     original_name text NOT NULL,
     source_type   text,
     charge_count  int DEFAULT 0,
     created_at    timestamptz DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS statement_charges (
     id                serial PRIMARY KEY,
     statement_id      int REFERENCES statements(id) ON DELETE CASCADE,
     charge_date       date,
     amount            numeric(12,2),
     description       text,
     last4             text,
     matched_invoice_id int,
     status            text NOT NULL DEFAULT 'missing',
     created_at        timestamptz DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS statement_charges_statement_idx ON statement_charges (statement_id)`,
];

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('[migrate] schema is up to date.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// When run directly (`npm run migrate`), execute and exit. When imported (e.g.
// by the server at startup), only the exported function runs — no side effects.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
