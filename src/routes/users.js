import { Router } from 'express';
import {
  listUsers,
  createUser,
  getUserById,
  setPassword,
  regenerateInvite,
  deleteUser,
} from '../services/users.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Absolute origin for building shareable invite links.
function origin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Mounted at /team. --- GET /team : list users + invite links -------------
router.get(
  '/',
  wrap(async (req, res) => {
    const users = await listUsers();
    res.render('users', {
      title: 'Team',
      active: 'team',
      users,
      origin: origin(req),
      notice: req.query.notice || null,
      error: req.query.error || null,
    });
  })
);

// --- POST /team/add -------------------------------------------------------
router.post(
  '/add',
  wrap(async (req, res) => {
    const { email, name, role } = req.body;
    const password = req.body.password && req.body.password.trim() ? req.body.password : null;
    if (!email || !String(email).trim()) {
      return res.redirect('/team?error=' + encodeURIComponent('An email address is required.'));
    }
    if (password && String(password).length < 8) {
      return res.redirect('/team?error=' + encodeURIComponent('Password must be at least 8 characters.'));
    }
    try {
      const user = await createUser({ email, name, role, password });
      const msg = password
        ? `Added ${user.email} with a password.`
        : `Invited ${user.email}. Copy the invite link below to share.`;
      res.redirect('/team?notice=' + encodeURIComponent(msg));
    } catch (err) {
      const msg = /unique|duplicate/i.test(err.message) ? 'That email is already on the team.' : err.message;
      res.redirect('/team?error=' + encodeURIComponent(msg));
    }
  })
);

// --- POST /team/:id/reinvite : fresh invite link --------------------------
router.post(
  '/:id/reinvite',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isInteger(id)) await regenerateInvite(id);
    res.redirect('/team?notice=' + encodeURIComponent('New invite link generated.'));
  })
);

// --- POST /team/:id/set-password ------------------------------------------
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

// --- POST /team/:id/delete ------------------------------------------------
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

export default router;
