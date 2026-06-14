import { query } from '../db/pool.js';

// Personal reminders attached to a task. Only the owner sees them.

export async function addReminder(userId, taskId, data) {
  await query(
    `INSERT INTO reminders (user_id, task_id, title, note, remind_at, via_email, via_daily_email, via_screen, recurrence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      userId,
      taskId,
      String(data.title || '').trim() || 'Reminder',
      data.note || null,
      data.remind_at,
      Boolean(data.via_email),
      Boolean(data.via_daily_email),
      Boolean(data.via_screen),
      data.recurrence === 'daily' ? 'daily' : null,
    ]
  );
}

// filter: 'open' | 'done' | 'all'
export async function listMyReminders(userId, filter = 'open') {
  const where = ['r.user_id = $1'];
  if (filter === 'open') where.push("r.status = 'open'");
  else if (filter === 'done') where.push("r.status = 'done'");
  const { rows } = await query(
    `SELECT r.*, t.title AS task_title, (r.status='open' AND r.remind_at < now()) AS overdue
       FROM reminders r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.status ASC, r.remind_at ASC`,
    [userId]
  );
  return rows;
}

export async function markReminderDone(id, userId) {
  await query("UPDATE reminders SET status='done' WHERE id=$1 AND user_id=$2", [id, userId]);
}

export async function deleteReminder(id, userId) {
  await query('DELETE FROM reminders WHERE id=$1 AND user_id=$2', [id, userId]);
}

// Reminders to surface on-screen for this user today (once per day).
export async function dueScreenReminders(userId) {
  const { rows } = await query(
    `SELECT r.id, r.title, r.note, r.remind_at, r.recurrence, t.title AS task_title, r.task_id
       FROM reminders r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.user_id = $1 AND r.status = 'open' AND r.via_screen = true
        AND r.remind_at <= now()
        AND (r.last_shown_on IS NULL OR r.last_shown_on < current_date)
      ORDER BY r.remind_at ASC`,
    [userId]
  );
  return rows;
}

export async function markRemindersShown(ids) {
  if (!ids || !ids.length) return;
  await query('UPDATE reminders SET last_shown_on = current_date WHERE id = ANY($1)', [ids]).catch(() => {});
}

// Reminders that need an email now (one-time or daily follow-up).
export async function dueEmailReminders() {
  const { rows } = await query(
    `SELECT r.*, u.email AS user_email, u.name AS user_name, t.title AS task_title
       FROM reminders r JOIN users u ON u.id = r.user_id
       LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.status = 'open' AND r.remind_at <= now()
        AND (
          (r.via_email = true AND r.last_emailed_at IS NULL)
          OR ((r.via_daily_email = true OR r.recurrence = 'daily')
               AND (r.last_emailed_at IS NULL OR r.last_emailed_at::date < current_date))
        )
      ORDER BY r.remind_at ASC`
  );
  return rows;
}

export async function markReminderEmailed(id) {
  await query('UPDATE reminders SET last_emailed_at = now() WHERE id=$1', [id]).catch(() => {});
}
