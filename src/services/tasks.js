import { query } from '../db/pool.js';

// Reference values (kept in code; categories live in the DB and are editable).
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const STATUSES = ['open', 'in_progress', 'completed', 'cancelled'];
export const OPEN_STATUSES = ['open', 'in_progress'];
export const LINK_TYPES = ['tenant', 'owner', 'prospect', 'vendor'];
export const SNOOZE_DAYS = 7;

const SORTABLE = {
  due_at: 't.due_at',
  priority: "array_position(ARRAY['urgent','high','normal','low'], t.priority)",
  status: 't.status',
  title: 'lower(t.title)',
  created_at: 't.created_at',
  updated_at: 't.updated_at',
};

export async function listCategories() {
  const { rows } = await query(
    'SELECT * FROM task_categories WHERE is_active ORDER BY sort, lower(name)'
  );
  return rows;
}

export function canSeeAll(viewer) {
  return Boolean(viewer && (viewer.isAdmin || (viewer.permissions || []).includes('tasks_all')));
}

// Build the role-scoping clause: full-access roles see everything; staff see
// tasks they created or are assigned to.
function scopeClause(viewer, params) {
  if (canSeeAll(viewer)) return null;
  params.push(viewer.id);
  const p = `$${params.length}`;
  return `(t.created_by = ${p} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${p}))`;
}

// Attach assignee lists to a set of task rows (one extra query).
async function withAssignees(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const { rows: a } = await query(
    `SELECT ta.task_id, u.id, u.name, u.email
       FROM task_assignees ta JOIN users u ON u.id = ta.user_id
      WHERE ta.task_id = ANY($1) ORDER BY lower(coalesce(u.name, u.email))`,
    [ids]
  );
  const byTask = new Map();
  for (const r of a) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push({ id: r.id, name: r.name || r.email, email: r.email });
  }
  for (const t of rows) t.assignees = byTask.get(t.id) || [];
  return rows;
}

/**
 * List active tasks for a viewer with filters. Snoozed and soft-deleted tasks
 * are always excluded here. `f` accepts: status, priority, category, assignee,
 * dueFrom, dueTo, openOnly, hasTenant, q (search), sort, dir.
 */
export async function listTasks(viewer, f = {}) {
  const where = ['t.deleted_at IS NULL', '(t.snoozed_until IS NULL OR t.snoozed_until <= now())'];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('$$', `$${params.length}`));
  };

  if (f.status && STATUSES.includes(f.status)) add('t.status = $$', f.status);
  if (f.priority && PRIORITIES.includes(f.priority)) add('t.priority = $$', f.priority);
  if (f.category) add('t.category = $$', f.category);
  if (f.openOnly) where.push(`t.status IN ('open','in_progress')`);
  if (f.hasTenant) where.push(`t.link_type = 'tenant' AND t.link_id IS NOT NULL`);
  if (f.dueFrom) add('t.due_at >= $$', f.dueFrom);
  if (f.dueTo) add('t.due_at <= $$', f.dueTo);
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(`(t.title ILIKE ${p} OR t.description ILIKE ${p})`);
  }
  if (f.assignee) {
    params.push(Number(f.assignee));
    where.push(`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${params.length})`);
  }
  const scope = scopeClause(viewer, params);
  if (scope) where.push(scope);

  const sortCol = SORTABLE[f.sort] || 't.due_at';
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await query(
    `SELECT t.* FROM tasks t WHERE ${where.join(' AND ')}
       ORDER BY ${sortCol} ${dir} NULLS LAST, t.created_at DESC`,
    params
  );
  return withAssignees(rows);
}

// Tasks currently snoozed (and visible to the viewer).
export async function listSnoozed(viewer) {
  const where = ['t.deleted_at IS NULL', 't.snoozed_until IS NOT NULL', 't.snoozed_until > now()'];
  const params = [];
  const scope = scopeClause(viewer, params);
  if (scope) where.push(scope);
  const { rows } = await query(
    `SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.snoozed_until ASC`,
    params
  );
  return withAssignees(rows);
}

export async function getTask(id, viewer) {
  const { rows } = await query('SELECT t.* FROM tasks t WHERE t.id = $1 AND t.deleted_at IS NULL', [id]);
  const task = rows[0];
  if (!task) return null;
  await withAssignees([task]);
  if (!canSeeAll(viewer)) {
    const mine = task.created_by === viewer.id || task.assignees.some((a) => a.id === viewer.id);
    if (!mine) return { forbidden: true };
  }
  const [comments, history, attachments, reminders] = await Promise.all([
    query(
      `SELECT c.*, u.name, u.email FROM task_comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.task_id = $1 ORDER BY c.created_at ASC`,
      [id]
    ),
    query(
      `SELECT h.*, u.name, u.email FROM task_history h LEFT JOIN users u ON u.id = h.user_id
         WHERE h.task_id = $1 ORDER BY h.created_at DESC`,
      [id]
    ),
    query('SELECT id, filename, mime_type, created_at FROM task_attachments WHERE task_id = $1 ORDER BY created_at', [id]),
    query('SELECT * FROM reminders WHERE task_id = $1 AND user_id = $2 ORDER BY remind_at', [id, viewer.id]),
  ]);
  task.comments = comments.rows;
  task.history = history.rows;
  task.attachments = attachments.rows;
  task.reminders = reminders.rows;
  return task;
}

async function logHistory(taskId, userId, action, detail) {
  await query('INSERT INTO task_history (task_id, user_id, action, detail) VALUES ($1,$2,$3,$4)', [
    taskId,
    userId,
    action,
    detail || null,
  ]).catch(() => {});
}

async function notify(userIds, taskId, type, message) {
  const ids = [...new Set(userIds)].filter(Boolean);
  for (const uid of ids) {
    await query('INSERT INTO notifications (user_id, task_id, type, message) VALUES ($1,$2,$3,$4)', [
      uid,
      taskId,
      type,
      message,
    ]).catch(() => {});
  }
}

async function setAssignees(taskId, userIds) {
  await query('DELETE FROM task_assignees WHERE task_id = $1', [taskId]);
  for (const uid of [...new Set((userIds || []).map(Number).filter(Boolean))]) {
    await query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [taskId, uid]);
  }
}

export async function createTask(data, actor) {
  const { rows } = await query(
    `INSERT INTO tasks (title, description, category, priority, status, color, due_at, recurrence,
                        link_type, link_id, link_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      String(data.title || '').trim() || 'Untitled task',
      data.description || null,
      data.category || null,
      PRIORITIES.includes(data.priority) ? data.priority : 'normal',
      STATUSES.includes(data.status) ? data.status : 'open',
      data.color || null,
      data.due_at || null,
      data.recurrence ? JSON.stringify(data.recurrence) : null,
      data.link_type || null,
      data.link_id || null,
      data.link_name || null,
      actor.id,
    ]
  );
  const id = rows[0].id;
  await setAssignees(id, data.assignees);
  await logHistory(id, actor.id, 'created', `Created “${data.title}”`);
  await notify(
    (data.assignees || []).map(Number).filter((u) => u !== actor.id),
    id,
    'assigned',
    `You were assigned: ${data.title}`
  );
  return id;
}

export async function updateTask(id, data, actor) {
  const before = (await query('SELECT * FROM tasks t WHERE id = $1', [id])).rows[0];
  if (!before) return;
  await query(
    `UPDATE tasks SET title=$2, description=$3, category=$4, priority=$5, status=$6, color=$7,
            due_at=$8, recurrence=$9, link_type=$10, link_id=$11, link_name=$12, updated_at=now()
       WHERE id=$1`,
    [
      id,
      String(data.title || before.title).trim(),
      data.description ?? before.description,
      data.category ?? before.category,
      PRIORITIES.includes(data.priority) ? data.priority : before.priority,
      STATUSES.includes(data.status) ? data.status : before.status,
      data.color ?? before.color,
      data.due_at ?? before.due_at,
      data.recurrence ? JSON.stringify(data.recurrence) : before.recurrence,
      data.link_type ?? before.link_type,
      data.link_id ?? before.link_id,
      data.link_name ?? before.link_name,
    ]
  );
  if (data.assignees !== undefined) await setAssignees(id, data.assignees);

  // Compact change log.
  const changes = [];
  for (const k of ['title', 'priority', 'status', 'category']) {
    if (data[k] !== undefined && String(data[k]) !== String(before[k] ?? '')) {
      changes.push(`${k}: ${before[k] ?? '—'} → ${data[k]}`);
    }
  }
  await logHistory(id, actor.id, 'updated', changes.join('; ') || 'Edited details');
  await notify(
    (data.assignees || []).map(Number).filter((u) => u !== actor.id),
    id,
    'updated',
    `Task updated: ${data.title || before.title}`
  );
}

// Compute the next due date for a recurring task.
function nextDue(dueAt, rec) {
  if (!dueAt || !rec) return null;
  const d = new Date(dueAt);
  const n = Math.max(1, Number(rec.interval) || 1);
  if (rec.freq === 'daily') d.setDate(d.getDate() + n);
  else if (rec.freq === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (rec.freq === 'monthly') d.setMonth(d.getMonth() + n);
  else if (rec.freq === 'yearly') d.setFullYear(d.getFullYear() + n);
  else return null;
  if (rec.endType === 'on' && rec.endOn && d > new Date(rec.endOn)) return null;
  return d;
}

export async function setStatus(id, status, actor) {
  if (!STATUSES.includes(status)) return;
  const before = (await query('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
  if (!before) return;
  await query('UPDATE tasks SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
  await logHistory(id, actor.id, 'status', `${before.status} → ${status}`);

  // Spawn the next occurrence when a recurring task is completed.
  if (status === 'completed' && before.recurrence && before.due_at) {
    let rec = before.recurrence;
    if (typeof rec === 'string') {
      try {
        rec = JSON.parse(rec);
      } catch {
        rec = null;
      }
    }
    let remaining = rec && rec.endType === 'after' ? Number(rec.count) || 0 : null;
    if (remaining !== null && remaining <= 1) rec = null; // last occurrence
    const due = nextDue(before.due_at, rec);
    if (due) {
      if (remaining !== null) rec = { ...rec, count: remaining - 1 };
      const { rows } = await query(
        `INSERT INTO tasks (title, description, category, priority, status, color, due_at, recurrence,
                            link_type, link_id, link_name, created_by)
         VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          before.title,
          before.description,
          before.category,
          before.priority,
          before.color,
          due,
          JSON.stringify(rec),
          before.link_type,
          before.link_id,
          before.link_name,
          actor.id,
        ]
      );
      const newId = rows[0].id;
      const a = (await query('SELECT user_id FROM task_assignees WHERE task_id=$1', [id])).rows.map((r) => r.user_id);
      await setAssignees(newId, a);
      await logHistory(newId, actor.id, 'created', 'Recurring follow-up created');
    }
  }
}

export async function snoozeTask(id, actor) {
  await query(`UPDATE tasks SET snoozed_until = now() + interval '${SNOOZE_DAYS} days', updated_at=now() WHERE id=$1`, [id]);
  await logHistory(id, actor.id, 'snoozed', `Snoozed ${SNOOZE_DAYS} days`);
}

export async function wakeTask(id, actor) {
  await query('UPDATE tasks SET snoozed_until = NULL, updated_at=now() WHERE id=$1', [id]);
  await logHistory(id, actor.id, 'woke', 'Woke from snooze');
}

export async function softDelete(id, actor) {
  await query('UPDATE tasks SET deleted_at = now() WHERE id=$1', [id]);
  await logHistory(id, actor.id, 'deleted', 'Moved to trash');
}

export async function addComment(id, actor, body) {
  const text = String(body || '').trim();
  if (!text) return;
  await query('INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)', [id, actor.id, text]);
  await logHistory(id, actor.id, 'comment', text.slice(0, 80));
}

export async function addAttachment(id, file, actor) {
  await query(
    'INSERT INTO task_attachments (task_id, filename, mime_type, file_data, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
    [id, file.originalname, file.mimetype, file.buffer, actor.id]
  );
  await logHistory(id, actor.id, 'attachment', file.originalname);
}

export async function getAttachment(attId) {
  const { rows } = await query('SELECT * FROM task_attachments WHERE id = $1', [attId]);
  return rows[0] || null;
}

// Bulk status / priority / assignee changes.
export async function bulkUpdate(ids, changes, actor) {
  const taskIds = (ids || []).map(Number).filter(Boolean);
  for (const id of taskIds) {
    if (changes.status && STATUSES.includes(changes.status)) await setStatus(id, changes.status, actor);
    if (changes.priority && PRIORITIES.includes(changes.priority)) {
      await query('UPDATE tasks SET priority=$2, updated_at=now() WHERE id=$1', [id, changes.priority]);
      await logHistory(id, actor.id, 'priority', `→ ${changes.priority}`);
    }
    if (changes.assignee) {
      await setAssignees(id, [changes.assignee]);
      await logHistory(id, actor.id, 'assignees', 'Reassigned (bulk)');
      await notify([Number(changes.assignee)], id, 'assigned', 'You were assigned a task');
    }
  }
  return taskIds.length;
}

// --- dashboard helpers -----------------------------------------------------
export async function statusCounts(viewer) {
  const tasks = await listTasks(viewer, {});
  const c = { open: 0, in_progress: 0, completed: 0, cancelled: 0, overdue: 0, total: tasks.length };
  const now = Date.now();
  for (const t of tasks) {
    c[t.status] = (c[t.status] || 0) + 1;
    if (t.due_at && new Date(t.due_at).getTime() < now && OPEN_STATUSES.includes(t.status)) c.overdue += 1;
  }
  return c;
}

export async function myTasks(viewer) {
  const all = await listTasks(viewer, { openOnly: true, sort: 'due_at' });
  return all.filter((t) => t.assignees.some((a) => a.id === viewer.id));
}

export async function dueWithin(viewer, days = 7) {
  const all = await listTasks(viewer, { openOnly: true, sort: 'due_at' });
  const until = Date.now() + days * 86400000;
  return all.filter((t) => t.due_at && new Date(t.due_at).getTime() <= until);
}

// Saved filters (per user).
export async function listSavedFilters(userId) {
  const { rows } = await query('SELECT * FROM task_saved_filters WHERE user_id=$1 ORDER BY name', [userId]);
  return rows;
}
export async function saveFilter(userId, name, queryObj) {
  await query('INSERT INTO task_saved_filters (user_id, name, query) VALUES ($1,$2,$3::jsonb)', [
    userId,
    String(name || 'Filter').trim(),
    JSON.stringify(queryObj || {}),
  ]);
}
export async function deleteSavedFilter(userId, id) {
  await query('DELETE FROM task_saved_filters WHERE id=$1 AND user_id=$2', [id, userId]);
}
