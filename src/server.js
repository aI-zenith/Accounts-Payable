import 'dotenv/config';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import invoiceRoutes from './routes/invoices.js';
import settingsRoutes from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const app = express();

// Views (EJS + layout).
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Body parsing + static assets.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// Make a few values available to every view.
app.use((req, res, next) => {
  res.locals.active = '';
  res.locals.notice = null;
  res.locals.year = new Date().getFullYear();
  next();
});

// Health check for Render.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Routes.
app.use('/', invoiceRoutes);
app.use('/', settingsRoutes);

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
app.listen(PORT, () => {
  console.log(`Invoice Bridge listening on http://localhost:${PORT}`);
});

export default app;
