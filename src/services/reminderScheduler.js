import { dueEmailReminders, markReminderEmailed } from './reminders.js';
import { mailerConfigured, sendMail } from './mailer.js';

// Periodically deliver due reminder emails (one-time + daily follow-ups). The
// on-screen and "daily until done" behaviors are driven by the reminder rows;
// this only handles email delivery and is a no-op without SMTP configured.

let timer = null;
let running = false;

async function tick() {
  if (running || !mailerConfigured()) return;
  running = true;
  try {
    const due = await dueEmailReminders();
    for (const r of due) {
      if (!r.user_email) continue;
      const subject = `Reminder: ${r.title}${r.task_title ? ` — ${r.task_title}` : ''}`;
      const body =
        `${r.title}\n\n` +
        (r.note ? `${r.note}\n\n` : '') +
        (r.task_title ? `Task: ${r.task_title}\n` : '') +
        `Due: ${new Date(r.remind_at).toLocaleString()}\n`;
      try {
        await sendMail({ to: r.user_email, subject, text: body });
        await markReminderEmailed(r.id);
      } catch (err) {
        console.error('[reminders] email failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[reminders] scheduler error:', err.message);
  } finally {
    running = false;
  }
}

export function startReminderScheduler() {
  if (timer) return;
  const interval = Number(process.env.REMINDER_INTERVAL_MS || 60000);
  timer = setInterval(() => tick().catch(() => {}), interval);
  if (typeof timer.unref === 'function') timer.unref();
  if (mailerConfigured()) console.log('[reminders] email scheduler started.');
}
