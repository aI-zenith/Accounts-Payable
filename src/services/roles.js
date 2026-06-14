import { query } from '../db/pool.js';

// Permissions = what a role can see/access. The home Dashboard is available to
// every signed-in user and is intentionally not listed here. Add a key when a
// module ships and it becomes gateable.
export const PERMISSIONS = [
  { key: 'accounts_payable', label: 'Accounts Payable' },
  { key: 'properties', label: 'Properties' },
  { key: 'residents', label: 'Residents' },
  { key: 'leasing', label: 'Leasing' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'reports', label: 'Reports' },
  { key: 'team', label: 'Team & roles' },
  { key: 'settings', label: 'Settings' },
];
const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
function cleanPerms(list) {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  return [...new Set(arr.filter((k) => PERM_KEYS.has(k)))];
}

export async function listRoles() {
  const { rows } = await query(
    `SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r
      ORDER BY r.is_admin DESC, r.is_system DESC, lower(r.name) ASC`
  );
  return rows;
}

export async function getRole(id) {
  const { rows } = await query('SELECT * FROM roles WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getRoleByKey(key) {
  const { rows } = await query('SELECT * FROM roles WHERE key = $1', [key]);
  return rows[0] || null;
}

export async function createRole({ name, permissions }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Role name is required.');
  let key = slugify(clean) || 'role';
  if (await getRoleByKey(key)) key = `${key}-${Date.now().toString(36).slice(-4)}`;
  const { rows } = await query(
    `INSERT INTO roles (key, name, permissions, is_admin, is_system)
     VALUES ($1, $2, $3::jsonb, false, false) RETURNING *`,
    [key, clean, JSON.stringify(cleanPerms(permissions))]
  );
  return rows[0];
}

export async function updateRole(id, { name, permissions }) {
  const role = await getRole(id);
  if (!role) throw new Error('Role not found.');
  if (role.is_admin) throw new Error('The Admin role always has every permission.');
  const newName = name && String(name).trim() ? String(name).trim() : role.name;
  await query('UPDATE roles SET name = $2, permissions = $3::jsonb, updated_at = now() WHERE id = $1', [
    id,
    newName,
    JSON.stringify(cleanPerms(permissions)),
  ]);
  return getRole(id);
}

export async function deleteRole(id) {
  const role = await getRole(id);
  if (!role) return;
  if (role.is_system) throw new Error('Built-in roles cannot be deleted.');
  const { rows } = await query('SELECT count(*)::int AS n FROM users WHERE role_id = $1', [id]);
  if (rows[0].n > 0) throw new Error('Reassign members off this role before deleting it.');
  await query('DELETE FROM roles WHERE id = $1', [id]);
}
