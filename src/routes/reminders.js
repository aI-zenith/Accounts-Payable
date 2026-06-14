import { Router } from 'express';
import { listMyReminders, markReminderDone, deleteReminder, markRemindersShown } from '../services/reminders.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- GET /reminders : My Reminders (filter open/done/all) ------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const filter = ['open', 'done', 'all'].includes(req.query.filter) ? req.query.filter : 'open';
    const reminders = await listMyReminders(req.user.id, filter);
    res.render('reminders/my', {
      title: 'My Reminders',
      active: 'tasks',
      taskActive: 'reminders',
      reminders,
      filter,
      notice: req.query.notice || null,
    });
  })
);

router.post(
  '/:id/done',
  wrap(async (req, res) => {
    await markReminderDone(Number(req.params.id), req.user.id);
    res.redirect('/reminders' + (req.body.filter ? `?filter=${req.body.filter}` : ''));
  })
);

router.post(
  '/:id/delete',
  wrap(async (req, res) => {
    await deleteReminder(Number(req.params.id), req.user.id);
    res.redirect('/reminders');
  })
);

// Dismiss the on-screen banner for today (marks the shown reminders).
router.post(
  '/dismiss',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : [];
    await markRemindersShown(ids.map(Number).filter(Boolean));
    res.json({ ok: true });
  })
);

export default router;
