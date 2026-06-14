import { query } from '../db/pool.js';
import { hashPassword, randomToken } from './password.js';

// User store for the platform. Pending (invited) users have an invite_token and
// no password until they accept; an admin can also create a user with a password
// directly (active immediately).

// Display columns, joined to the user's role for name/key/admin flag.
const SELECT =
  `SELECT u.id, u.email, u.name, u.role_id, u.invite_token, u.invite_created_at,
          u.is_active, u.last_login_at, (u.password_hash IS NOT NULL) AS has_password,
          u.created_at, u.updated_at,
          r.name AS role_name, r.key AS role_key, r.is_admin AS role_is_admin
     FROM users u LEFT JOIN roles r ON r.id = u.role_id`;

export async function countUsers() {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  return rows[0]?.n ?? 0;
}

export async function listUsers() {
  const { rows } = await query(`${SELECT} ORDER BY u.created_at ASC`);
  return rows;
}

export async function getUserById(id) {
  const { rows } = await query(`${SELECT} WHERE u.id = $1`, [id]);
  return rows[0] || null;
}

// Includes password_hash — for authentication only.
export async function getAuthUserByEmail(email) {
  const { rows } = await query(
    'SELECT id, email, name, password_hash, is_active FROM users WHERE lower(email) = lower($1)',
    [String(email || '').trim()]
  );
  return rows[0] || null;
}

export async function getUserByInvite(token) {
  if (!token) return null;
  const { rows } = await query(`${SELECT} WHERE u.invite_token = $1`, [token]);
  return rows[0] || null;
}

// Resolve a role by id, then key, else fall back to the Employee role.
async function resolveRole(roleId, roleKey) {
  if (roleId) {
    const { rows } = await query('SELECT * FROM roles WHERE id = $1', [Number(roleId)]);
    if (rows[0]) return rows[0];
  }
  if (roleKey) {
    const { rows } = await query('SELECT * FROM roles WHERE key = $1', [roleKey]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query("SELECT * FROM roles WHERE key = 'employee'");
  return rows[0] || null;
}

/**
 * Create a user. With a password -> active immediately. Without -> a pending
 * invite (invite_token set) the admin can share as a link.
 */
export async function createUser({ email, name, roleId = null, roleKey = null, password = null }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) throw new Error('Email is required.');
  const role = await resolveRole(roleId, roleKey);
  const passwordHash = password ? hashPassword(password) : null;
  const inviteToken = password ? null : randomToken();

  const { rows } = await query(
    `INSERT INTO users (email, name, role, role_id, password_hash, invite_token, invite_created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      cleanEmail,
      name || null,
      role?.key || 'employee',
      role?.id || null,
      passwordHash,
      inviteToken,
      inviteToken ? new Date() : null,
    ]
  );
  return getUserById(rows[0].id);
}

// Change a user's role.
export async function setUserRole(userId, roleId) {
  const role = await resolveRole(roleId, null);
  if (!role) throw new Error('Role not found.');
  await query('UPDATE users SET role = $2, role_id = $3, updated_at = now() WHERE id = $1', [
    userId,
    role.key,
    role.id,
  ]);
  return getUserById(userId);
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
