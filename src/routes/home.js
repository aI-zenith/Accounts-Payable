import { Router } from 'express';
import { query } from '../db/pool.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// A short, work-positive line. One is chosen per day so it feels steady but fresh.
const QUOTES = [
  'Small wins, stacked daily, become big results.',
  'Do today what your future self will thank you for.',
  'Progress beats perfection — keep it moving.',
  'Focus on the next right step, not the whole staircase.',
  'Discipline is choosing what you want most over what you want now.',
  'Great operations are quiet — calm, consistent, on time.',
  'Clear the small things; the big things get easier.',
  'You don’t have to be extreme, just consistent.',
  'Own the morning, and the day follows.',
  'Done is the engine of more.',
  'Tidy ledger, clear mind.',
  'Build the habit; the results take care of themselves.',
];

// --- GET / : the platform home / overview dashboard ------------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const now = new Date();
    const inET = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(now);
    const etHour = Number(inET({ hour: 'numeric', hour12: false }));
    const greeting = etHour < 12 ? 'Good morning' : etHour < 18 ? 'Good afternoon' : 'Good evening';
    const dateLong = inET({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const firstName = (req.user?.name || '').trim().split(/\s+/)[0] || '';

    // Accounts Payable snapshot (best-effort — empty if the DB isn't ready).
    const ap = { total: 0, review: 0, pushed: 0, open: 0 };
    try {
      const { rows } = await query('SELECT status, count(*)::int AS n FROM invoices GROUP BY status');
      for (const r of rows) {
        ap.total += r.n;
        if (r.status === 'needs_review') ap.review += r.n;
        else if (r.status === 'pushed') ap.pushed += r.n;
        else ap.open += r.n;
      }
    } catch {
      /* leave zeros */
    }

    const quote = QUOTES[Math.floor(now.getTime() / 86400000) % QUOTES.length];

    res.render('home', {
      title: 'Dashboard',
      active: 'home',
      greeting,
      firstName,
      dateLong,
      quote,
      ap,
      notice: req.query.notice || null,
    });
  })
);

export default router;
