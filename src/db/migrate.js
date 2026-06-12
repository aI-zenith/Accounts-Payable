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
