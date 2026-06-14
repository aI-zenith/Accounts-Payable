import { Router } from 'express';
import { verifyPassword } from '../services/password.js';
import {
  countUsers,
  createUser,
  getAuthUserByEmail,
  getUserByInvite,
  setPassword,
  touchLogin,
} from '../services/users.js';
import { createSession, destroySession, SESSION_COOKIE } from '../services/sessionStore.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const AUTH_LAYOUT = 'auth-layout';

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

async function startSession(res, userId) {
  const { token } = await createSession(userId);
  res.cookie(SESSION_COOKIE, token, cookieOpts());
}

// Only allow same-origin relative redirects from ?next.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// --- First-run setup: create the first administrator ----------------------
router.get(
  '/setup',
  wrap(async (req, res) => {
    if ((await countUsers()) > 0) return res.redirect('/login');
    res.render('setup', { title: 'Welcome', layout: AUTH_LAYOUT, error: null });
  })
);

router.post(
  '/setup',
  wrap(async (req, res) => {
    if ((await countUsers()) > 0) return res.redirect('/login');
    const { name, email, password, confirm } = req.body;
    const fail = (error) => res.status(400).render('setup', { title: 'Welcome', layout: AUTH_LAYOUT, error });
    if (!email || !password) return fail('Email and password are required.');
    if (String(password).length < 8) return fail('Password must be at least 8 characters.');
    if (password !== confirm) return fail('Passwords do not match.');
    try {
      const user = await createUser({ email, name, roleKey: 'admin', password });
      await startSession(res, user.id);
      res.redirect('/');
    } catch (err) {
      fail(err.message.includes('unique') ? 'That email is already registered.' : err.message);
    }
  })
);

// --- Login ----------------------------------------------------------------
router.get(
  '/login',
  wrap(async (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    if ((await countUsers()) === 0) return res.redirect('/setup');
    res.render('login', {
      title: 'Sign in',
      layout: AUTH_LAYOUT,
      error: null,
      next: req.query.next || '/',
      notice: req.query.notice || null,
    });
  })
);

router.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body;
    const next = safeNext(req.body.next);
    const fail = () =>
      res.status(401).render('login', {
        title: 'Sign in',
        layout: AUTH_LAYOUT,
        error: 'Incorrect email or password.',
        next,
        notice: null,
      });
    const user = await getAuthUserByEmail(email);
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) return fail();
    await startSession(res, user.id);
    await touchLogin(user.id);
    res.redirect(next);
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/login');
  })
);

// --- Accept an invite: set your password ----------------------------------
router.get(
  '/accept-invite/:token',
  wrap(async (req, res) => {
    const user = await getUserByInvite(req.params.token);
    if (!user) {
      return res.status(404).render('error', {
        title: 'Invite not found',
        status: 404,
        message: 'This invite link is invalid or has already been used.',
      });
    }
    res.render('accept-invite', { title: 'Set your password', layout: AUTH_LAYOUT, error: null, user });
  })
);

router.post(
  '/accept-invite/:token',
  wrap(async (req, res) => {
    const user = await getUserByInvite(req.params.token);
    if (!user) {
      return res.status(404).render('error', {
        title: 'Invite not found',
        status: 404,
        message: 'This invite link is invalid or has already been used.',
      });
    }
    const { password, confirm } = req.body;
    const fail = (error) =>
      res.status(400).render('accept-invite', { title: 'Set your password', layout: AUTH_LAYOUT, error, user });
    if (!password || String(password).length < 8) return fail('Password must be at least 8 characters.');
    if (password !== confirm) return fail('Passwords do not match.');
    await setPassword(user.id, password);
    await startSession(res, user.id);
    res.redirect('/');
  })
);

export default router;
