import { query } from '../db/pool.js';

// Lightweight in-app notifications (task assigned / updated).

export async function listForUser(userId, limit = 20) {
  const { rows } = await query(
    'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return rows;
}

export async function unreadCount(userId) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND is_read=false',
    [userId]
  );
  return rows[0]?.n ?? 0;
}

export async function markAllRead(userId) {
  await query('UPDATE notifications SET is_read=true WHERE user_id=$1', [userId]).catch(() => {});
}
