import { Router } from 'express';
import {
  listUsers,
  createUser,
  getUserById,
  setPassword,
  setUserRole,
  regenerateInvite,
  deleteUser,
} from '../services/users.js';
import {
  PERMISSIONS,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
} from '../services/roles.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Absolute origin for building shareable invite links.
function origin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// === Members (mounted at /team) ===========================================

// --- GET /team : members + role assignment --------------------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const [users, roles] = await Promise.all([listUsers(), listRoles()]);
    res.render('users', {
      title: 'Team',
      active: 'team',
      teamActive: 'members',
      users,
      roles,
      origin: origin(req),
      notice: req.query.notice || null,
      error: req.query.error || null,
    });
  })
);

router.post(
  '/add',
  wrap(async (req, res) => {
    const { email, name, role_id } = req.body;
    const password = req.body.password && req.body.password.trim() ? req.body.password : null;
    if (!email || !String(email).trim()) {
      return res.redirect('/team?error=' + encodeURIComponent('An email address is required.'));
    }
    if (password && String(password).length < 8) {
      return res.redirect('/team?error=' + encodeURIComponent('Password must be at least 8 characters.'));
    }
    try {
      const user = await createUser({ email, name, roleId: role_id || null, password });
      const msg = password
        ? `Added ${user.email} as ${user.role_name}.`
        : `Invited ${user.email} as ${user.role_name}. Copy the invite link below to share.`;
      res.redirect('/team?notice=' + encodeURIComponent(msg));
    } catch (err) {
      const msg = /unique|duplicate/i.test(err.message) ? 'That email is already on the team.' : err.message;
      res.redirect('/team?error=' + encodeURIComponent(msg));
    }
  })
);

// --- POST /team/:id/role : change a member's role -------------------------
router.post(
  '/:id/role',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const roleId = Number(req.body.role_id);
    if (!Number.isInteger(id) || !Number.isInteger(roleId)) {
      return res.redirect('/team?error=' + encodeURIComponent('Pick a role.'));
    }
    if (req.user && req.user.id === id) {
      return res.redirect('/team?error=' + encodeURIComponent('You cannot change your own role.'));
    }
    const user = await setUserRole(id, roleId);
    res.redirect('/team?notice=' + encodeURIComponent(`${user.email} is now ${user.role_name}.`));
  })
);

router.post(
  '/:id/reinvite',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isInteger(id)) await regenerateInvite(id);
    res.redirect('/team?notice=' + encodeURIComponent('New invite link generated.'));
  })
);

router.post(
  '/:id/set-password',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const password = req.body.password;
    if (!password || String(password).length < 8) {
      return res.redirect('/team?error=' + encodeURIComponent('Password must be at least 8 characters.'));
    }
    if (Number.isInteger(id)) await setPassword(id, password);
    res.redirect('/team?notice=' + encodeURIComponent('Password updated.'));
  })
);

router.post(
  '/:id/delete',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.redirect('/team');
    if (req.user && req.user.id === id) {
      return res.redirect('/team?error=' + encodeURIComponent('You cannot remove your own account.'));
    }
    const target = await getUserById(id);
    if (target) await deleteUser(id);
    res.redirect('/team?notice=' + encodeURIComponent('Team member removed.'));
  })
);

// === Roles (mounted at /team/roles) =======================================

// --- GET /team/roles : roles + permission matrix --------------------------
router.get(
  '/roles',
  wrap(async (req, res) => {
    const roles = await listRoles();
    res.render('roles', {
      title: 'Roles',
      active: 'team',
      teamActive: 'roles',
      roles,
      permissions: PERMISSIONS,
      notice: req.query.notice || null,
      error: req.query.error || null,
    });
  })
);

// --- POST /team/roles : create a role -------------------------------------
router.post(
  '/roles',
  wrap(async (req, res) => {
    try {
      const role = await createRole({ name: req.body.name, permissions: req.body.permissions });
      res.redirect('/team/roles?notice=' + encodeURIComponent(`Role “${role.name}” created.`));
    } catch (err) {
      res.redirect('/team/roles?error=' + encodeURIComponent(err.message));
    }
  })
);

// --- POST /team/roles/:id : update a role's name + permissions ------------
router.post(
  '/roles/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    try {
      const role = await updateRole(id, { name: req.body.name, permissions: req.body.permissions });
      res.redirect('/team/roles?notice=' + encodeURIComponent(`Saved “${role.name}”.`));
    } catch (err) {
      res.redirect('/team/roles?error=' + encodeURIComponent(err.message));
    }
  })
);

// --- POST /team/roles/:id/delete ------------------------------------------
router.post(
  '/roles/:id/delete',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    try {
      if (Number.isInteger(id)) await deleteRole(id);
      res.redirect('/team/roles?notice=' + encodeURIComponent('Role deleted.'));
    } catch (err) {
      res.redirect('/team/roles?error=' + encodeURIComponent(err.message));
    }
  })
);

export default router;
