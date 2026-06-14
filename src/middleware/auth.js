import { SESSION_COOKIE, getSessionUser } from '../services/sessionStore.js';
import { countUsers } from '../services/users.js';

// Minimal cookie parser (avoids a dependency). Populates req.cookies.
export function parseCookies(req, res, next) {
  const header = req.headers.cookie;
  const jar = {};
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) jar[k] = decodeURIComponent(v);
    }
  }
  req.cookies = jar;
  next();
}

// Resolve the session cookie to a user and expose it to handlers + views.
// Non-blocking: unauthenticated requests simply have no user.
export async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    req.user = token ? await getSessionUser(token) : null;
  } catch (err) {
    console.error('[auth] attachUser failed:', err.message);
    req.user = null;
  }
  res.locals.currentUser = req.user;
  next();
}

// Gate everything that isn't a public auth/asset route. Sends unauthenticated
// users to the first-run setup (if there are no users yet) or to login.
export function requireAuth(req, res, next) {
  if (req.user) return next();
  Promise.resolve(countUsers())
    .then((n) => {
      if (n === 0) return res.redirect('/setup');
      const next = encodeURIComponent(req.originalUrl || '/');
      return res.redirect(`/login?next=${next}`);
    })
    .catch(() => res.redirect('/login'));
}

export function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', {
    title: 'Not allowed',
    status: 403,
    message: 'You need an administrator account to manage the team.',
  });
}
