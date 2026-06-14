import { query } from '../db/pool.js';
import { randomToken } from './password.js';

// Database-backed sessions. A random token lives in an httpOnly cookie; the row
// here maps it to a user with an expiry.

export const SESSION_COOKIE = 'zg_session';
const TTL_DAYS = 30;

export async function createSession(userId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expires]
  );
  return { token, expires };
}

// Resolve a session token to its (active) user, or null. Sweeps the row if
// expired.
export async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.is_active) {
    await destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
}
