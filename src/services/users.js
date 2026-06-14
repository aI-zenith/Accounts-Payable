import { query } from '../db/pool.js';
import { hashPassword, randomToken } from './password.js';

// User store for the platform. Pending (invited) users have an invite_token and
// no password until they accept; an admin can also create a user with a password
// directly (active immediately).

const COLS =
  'id, email, name, role, invite_token, invite_created_at, is_active, last_login_at, ' +
  '(password_hash IS NOT NULL) AS has_password, created_at, updated_at';

export async function countUsers() {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  return rows[0]?.n ?? 0;
}

export async function listUsers() {
  const { rows } = await query(`SELECT ${COLS} FROM users ORDER BY created_at ASC`);
  return rows;
}

export async function getUserById(id) {
  const { rows } = await query(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Includes password_hash — for authentication only.
export async function getAuthUserByEmail(email) {
  const { rows } = await query(
    'SELECT id, email, name, role, password_hash, is_active FROM users WHERE lower(email) = lower($1)',
    [String(email || '').trim()]
  );
  return rows[0] || null;
}

export async function getUserByInvite(token) {
  if (!token) return null;
  const { rows } = await query(`SELECT ${COLS} FROM users WHERE invite_token = $1`, [token]);
  return rows[0] || null;
}

/**
 * Create a user. With a password -> active immediately. Without -> a pending
 * invite (invite_token set) the admin can share as a link.
 */
export async function createUser({ email, name, role = 'member', password = null }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) throw new Error('Email is required.');
  const safeRole = role === 'admin' ? 'admin' : 'member';
  const passwordHash = password ? hashPassword(password) : null;
  const inviteToken = password ? null : randomToken();

  const { rows } = await query(
    `INSERT INTO users (email, name, role, password_hash, invite_token, invite_created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [cleanEmail, name || null, safeRole, passwordHash, inviteToken, inviteToken ? new Date() : null]
  );
  return getUserById(rows[0].id);
}

// Set/replace a password and clear any pending invite (used by accept-invite and
// admin password resets).
export async function setPassword(userId, password) {
  const hash = hashPassword(password);
  await query(
    `UPDATE users SET password_hash = $2, invite_token = NULL, invite_created_at = NULL,
            is_active = true, updated_at = now() WHERE id = $1`,
    [userId, hash]
  );
  return getUserById(userId);
}

// Generate a fresh invite link (re-invite / password reset by link).
export async function regenerateInvite(userId) {
  const token = randomToken();
  await query(
    'UPDATE users SET invite_token = $2, invite_created_at = now(), updated_at = now() WHERE id = $1',
    [userId, token]
  );
  return token;
}

export async function deleteUser(userId) {
  await query('DELETE FROM users WHERE id = $1', [userId]);
}

export async function touchLogin(userId) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]).catch(() => {});
}
