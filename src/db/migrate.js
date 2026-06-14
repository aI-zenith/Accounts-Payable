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

  // --- Platform: users + sessions -----------------------------------------
  // The app is the Zenith Group operations platform; Accounts Payable is the
  // first module. Users sign in; admins can invite teammates (an invite link is
  // shown per pending user) or create them with a password directly.
  `CREATE TABLE IF NOT EXISTS users (
     id                serial PRIMARY KEY,
     email             text UNIQUE NOT NULL,
     name              text,
     role              text NOT NULL DEFAULT 'member',
     password_hash     text,
     invite_token      text UNIQUE,
     invite_created_at timestamptz,
     is_active         boolean NOT NULL DEFAULT true,
     last_login_at     timestamptz,
     created_at        timestamptz DEFAULT now(),
     updated_at        timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email))`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token      text PRIMARY KEY,
     user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz DEFAULT now(),
     expires_at timestamptz NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,

  // --- Roles & permissions -------------------------------------------------
  // A role defines what a user can see/access (permissions = nav areas). The
  // Admin role always has everything (is_admin). Manager/Employee are seeded as
  // editable starting points; admins can edit them or create more.
  `CREATE TABLE IF NOT EXISTS roles (
     id          serial PRIMARY KEY,
     key         text UNIQUE NOT NULL,
     name        text NOT NULL,
     permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
     is_admin    boolean NOT NULL DEFAULT false,
     is_system   boolean NOT NULL DEFAULT false,
     created_at  timestamptz DEFAULT now(),
     updated_at  timestamptz DEFAULT now()
   )`,
  `INSERT INTO roles (key, name, permissions, is_admin, is_system)
     VALUES ('admin', 'Admin', '[]'::jsonb, true, true)
     ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO roles (key, name, permissions, is_admin, is_system)
     VALUES ('manager', 'Manager',
       '["accounts_payable","properties","residents","leasing","maintenance","reports"]'::jsonb,
       false, true)
     ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO roles (key, name, permissions, is_admin, is_system)
     VALUES ('employee', 'Employee', '["accounts_payable"]'::jsonb, false, true)
     ON CONFLICT (key) DO NOTHING`,

  // Link users to a role; backfill from the legacy text role.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id int REFERENCES roles(id)`,
  `UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'admin')
     WHERE role_id IS NULL AND role = 'admin'`,
  `UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'employee')
     WHERE role_id IS NULL`,

  // Grant the Tasks module to the seeded roles by default (idempotent).
  // Manager sees all tasks (tasks_all); Employee/Staff sees only their own.
  `UPDATE roles SET permissions = permissions || '["tasks","tasks_all"]'::jsonb
     WHERE key = 'manager' AND NOT (permissions ? 'tasks')`,
  `UPDATE roles SET permissions = permissions || '["tasks"]'::jsonb
     WHERE key = 'employee' AND NOT (permissions ? 'tasks')`,

  // --- Tasks module --------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS task_categories (
     id serial PRIMARY KEY,
     name text UNIQUE NOT NULL,
     color text,
     sort int DEFAULT 0,
     is_active boolean DEFAULT true,
     created_at timestamptz DEFAULT now()
   )`,
  `INSERT INTO task_categories (name, sort) VALUES
     ('Lease Management',1),('Move-In / Move-Out',2),('Lease Renewal',3),
     ('Tenant Communication',4),('Rent Collection',5),('Delinquency Follow-Up',6),
     ('Owner Relations',7),('Vendor Coordination',8),('Property Inspection',9),
     ('Compliance / Legal',10),('Administrative',11),('Marketing / Vacancy',12),
     ('HOA / Association',13),('Other',99)
   ON CONFLICT (name) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id            serial PRIMARY KEY,
     title         text NOT NULL,
     description   text,
     category      text,
     priority      text NOT NULL DEFAULT 'normal',
     status        text NOT NULL DEFAULT 'open',
     color         text,
     due_at        timestamptz,
     recurrence    jsonb,
     link_type     text,
     link_id       text,
     link_name     text,
     snoozed_until timestamptz,
     deleted_at    timestamptz,
     created_by    int REFERENCES users(id),
     created_at    timestamptz DEFAULT now(),
     updated_at    timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status)`,
  `CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (due_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_snoozed_idx ON tasks (snoozed_until)`,

  `CREATE TABLE IF NOT EXISTS task_assignees (
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS task_comments (
     id serial PRIMARY KEY,
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     user_id int,
     body text NOT NULL,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS task_history (
     id serial PRIMARY KEY,
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     user_id int,
     action text NOT NULL,
     detail text,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS task_attachments (
     id serial PRIMARY KEY,
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     filename text NOT NULL,
     mime_type text,
     file_data bytea,
     uploaded_by int,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id serial PRIMARY KEY,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     title text,
     note text,
     remind_at timestamptz NOT NULL,
     via_email boolean DEFAULT false,
     via_daily_email boolean DEFAULT false,
     via_screen boolean DEFAULT false,
     recurrence text,
     status text NOT NULL DEFAULT 'open',
     last_emailed_at timestamptz,
     last_shown_on date,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS task_saved_filters (
     id serial PRIMARY KEY,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     name text NOT NULL,
     query jsonb NOT NULL,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS notifications (
     id serial PRIMARY KEY,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     task_id int,
     type text,
     message text,
     is_read boolean NOT NULL DEFAULT false,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, is_read)`,

  // --- Tasks redesign: richer model (subtasks, CC/watchers, tags, cost) ----
  // New status/priority vocabulary from the redesign (Open/In Progress/Blocked/
  // In Review/Done; Urgent/High/Medium/Low). Migrate legacy values.
  `UPDATE tasks SET status = 'done' WHERE status IN ('completed','cancelled')`,
  `UPDATE tasks SET priority = 'medium' WHERE priority = 'normal'`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_cost_cents int`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb`,

  `CREATE TABLE IF NOT EXISTS task_subtasks (
     id serial PRIMARY KEY,
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     label text NOT NULL,
     done boolean NOT NULL DEFAULT false,
     sort int DEFAULT 0,
     created_at timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS task_subtasks_task_idx ON task_subtasks (task_id)`,
  `CREATE TABLE IF NOT EXISTS task_cc (
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS task_watchers (
     task_id int REFERENCES tasks(id) ON DELETE CASCADE,
     user_id int REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, user_id)
   )`,

  `ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS mentions jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file'`,
  `ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS duration_sec int`,
  `ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS comment_id int`,

  // Categories from the redesign (added alongside any existing ones).
  `INSERT INTO task_categories (name, sort) VALUES
     ('Lease Renewal',1),('Maintenance',2),('Turnover / Make-ready',3),('Leasing',4),
     ('Collections',5),('Inspection',6),('Compliance',7),('Accounts Payable',8),
     ('Resident Request',9)
   ON CONFLICT (name) DO NOTHING`,
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
