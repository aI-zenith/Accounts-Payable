import 'dotenv/config';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import homeRoutes from './routes/home.js';
import invoiceRoutes from './routes/invoices.js';
import settingsRoutes from './routes/settings.js';
import reconcileRoutes from './routes/reconcile.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import { parseCookies, attachUser, requireAuth, requirePermission } from './middleware/auth.js';
import { warmToken } from './services/rmClient.js';
import { startEmailPoller } from './services/emailPoller.js';
import { runMigrations } from './db/migrate.js';

// Platform branding (Accounts Payable is the first module of the Zenith Group
// operations platform).
const BRAND = { company: 'Zenith Group', product: 'Operations' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const app = express();

// Behind Render's proxy — trust it so req.protocol is https (for invite links).
app.set('trust proxy', true);

// Views (EJS + layout).
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Body parsing + static assets (static is public — served before the auth gate).
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// Health check for Render (public).
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Cookies + current user on every request.
app.use(parseCookies);
app.use(attachUser);

// Make a few values available to every view.
app.use((req, res, next) => {
  res.locals.active = '';
  res.locals.notice = null;
  res.locals.year = new Date().getFullYear();
  res.locals.brand = BRAND;
  next();
});

// Public auth routes (login / setup / accept-invite / logout).
app.use('/', authRoutes);

// Everything below requires a signed-in user.
app.use(requireAuth);

// Home dashboard — available to every signed-in user.
app.use('/', homeRoutes);

// Module routes, each gated by the matching permission (admins always pass).
app.use(
  ['/invoices', '/upload', '/invoice', '/file', '/push-all', '/reconcile'],
  requirePermission('accounts_payable')
);
app.use('/', invoiceRoutes);
app.use('/', reconcileRoutes);

app.use('/settings', requirePermission('settings'));
app.use('/', settingsRoutes);

app.use('/team', requirePermission('team'), userRoutes);

// 404.
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    status: 404,
    message: 'That page could not be found.',
  });
});

// Centralized async error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).render('error', {
    title: 'Something went wrong',
    status,
    message: err.message || 'An unexpected error occurred.',
  });
});

const PORT = process.env.PORT || 3000;

// Ensure the schema exists before serving. Idempotent (CREATE ... IF NOT EXISTS),
// so this is safe on every boot and removes the need for a separate build step.
// Non-fatal: if the DB is unreachable we still start so /healthz responds and
// the error surfaces in request handlers rather than crash-looping.
try {
  await runMigrations();
} catch (err) {
  console.error('[startup] migration failed, continuing:', err.message);
}

app.listen(PORT, () => {
  console.log(`Zenith Group platform listening on http://localhost:${PORT}`);
  // Pre-authenticate with Rent Manager on startup (non-fatal if unconfigured).
  warmToken();
  // Start polling the configured inbox for emailed bills (no-op until configured).
  startEmailPoller();
});

export default app;
