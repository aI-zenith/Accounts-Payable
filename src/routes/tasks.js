import { Router } from 'express';
import multer from 'multer';
import * as Tasks from '../services/tasks.js';
import { addReminder } from '../services/reminders.js';
import { listUsers } from '../services/users.js';
import { searchRmEntities, searchAllEntities } from '../services/rmClient.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Parse list filters from the query string.
function parseFilters(q) {
  return {
    status: q.status || '',
    priority: q.priority || '',
    category: q.category || '',
    assignee: q.assignee || '',
    dueFrom: q.dueFrom || '',
    dueTo: q.dueTo || '',
    openOnly: q.openOnly === '1' || q.openOnly === 'on',
    hasTenant: q.hasTenant === '1' || q.hasTenant === 'on',
    q: q.q || '',
    sort: q.sort || 'due_at',
    dir: q.dir === 'desc' ? 'desc' : 'asc',
  };
}
function queryString(f) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === true) p.set(k, '1');
    else if (v && v !== false) p.set(k, v);
  }
  return p.toString();
}

// Parse a task create/edit form body into a data object.
function parseBody(b) {
  const toArr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  let recurrence = null;
  if (b.rec_freq) {
    recurrence = {
      freq: b.rec_freq,
      interval: Number(b.rec_interval) || 1,
      endType: ['never', 'on', 'after'].includes(b.rec_end_type) ? b.rec_end_type : 'never',
      endOn: b.rec_end_on || null,
      count: Number(b.rec_count) || null,
    };
  }
  return {
    title: b.title,
    description: b.description || null,
    category: b.category || null,
    priority: b.priority,
    status: b.status,
    color: b.color || null,
    due_at: b.due_at ? b.due_at : null,
    assignees: toArr(b.assignees),
    recurrence,
    link_type: b.link_type || null,
    link_id: b.link_id || null,
    link_name: b.link_name || null,
  };
}

async function formContext() {
  const [users, categories] = await Promise.all([listUsers(), Tasks.listCategories()]);
  return {
    users,
    categories,
    priorities: Tasks.PRIORITIES,
    statuses: Tasks.STATUSES,
    linkTypes: Tasks.LINK_TYPES,
  };
}

// --- GET /tasks : table list ----------------------------------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const filters = parseFilters(req.query);
    const [tasks, ctx, saved] = await Promise.all([
      Tasks.listTasks(req.user, filters),
      formContext(),
      Tasks.listSavedFilters(req.user.id),
    ]);
    res.render('tasks/list', {
      title: 'Tasks',
      active: 'tasks',
      taskActive: 'list',
      tasks,
      filters,
      qs: queryString(filters),
      saved,
      ...ctx,
      notice: req.query.notice || null,
    });
  })
);

// --- GET /tasks/board : kanban --------------------------------------------
router.get(
  '/board',
  wrap(async (req, res) => {
    const filters = parseFilters(req.query);
    const tasks = await Tasks.listTasks(req.user, filters);
    const columns = Tasks.STATUSES.map((s) => ({ key: s, tasks: tasks.filter((t) => t.status === s) }));
    res.render('tasks/board', {
      title: 'Task board',
      active: 'tasks',
      taskActive: 'board',
      columns,
      statuses: Tasks.STATUSES,
      notice: req.query.notice || null,
    });
  })
);

// --- GET /tasks/snoozed ----------------------------------------------------
router.get(
  '/snoozed',
  wrap(async (req, res) => {
    const tasks = await Tasks.listSnoozed(req.user);
    res.render('tasks/snoozed', {
      title: 'Snoozed tasks',
      active: 'tasks',
      taskActive: 'snoozed',
      tasks,
      notice: req.query.notice || null,
    });
  })
);

// --- GET /tasks/export.csv -------------------------------------------------
router.get(
  '/export.csv',
  wrap(async (req, res) => {
    const tasks = await Tasks.listTasks(req.user, parseFilters(req.query));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['ID', 'Title', 'Category', 'Priority', 'Status', 'Due', 'Assignees', 'Linked', 'Created'];
    const lines = [head.join(',')];
    for (const t of tasks) {
      lines.push(
        [
          t.id,
          esc(t.title),
          esc(t.category),
          t.priority,
          t.status,
          t.due_at ? new Date(t.due_at).toISOString() : '',
          esc(t.assignees.map((a) => a.name).join('; ')),
          esc(t.link_name ? `${t.link_type}: ${t.link_name}` : ''),
          t.created_at ? new Date(t.created_at).toISOString() : '',
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="tasks.csv"');
    res.send(lines.join('\n'));
  })
);

// --- GET /tasks/link-search : RM entity search (JSON) ----------------------
router.get(
  '/link-search',
  wrap(async (req, res) => {
    try {
      const type = req.query.type;
      const q = req.query.q || '';
      // A specific type narrows the search; otherwise search every type at once.
      const results = Tasks.LINK_TYPES.includes(type)
        ? (await searchRmEntities(type, q)).map((r) => ({ ...r, type }))
        : await searchAllEntities(q);
      res.json({ ok: true, results });
    } catch (err) {
      res.json({ ok: false, error: err.message, results: [] });
    }
  })
);

// --- GET /tasks/new : create form -----------------------------------------
router.get(
  '/new',
  wrap(async (req, res) => {
    res.render('tasks/form', {
      title: 'New task',
      active: 'tasks',
      taskActive: 'list',
      task: { priority: 'normal', status: 'open', assignees: [] },
      isNew: true,
      ...(await formContext()),
    });
  })
);

// --- POST /tasks : create --------------------------------------------------
router.post(
  '/',
  wrap(async (req, res) => {
    const id = await Tasks.createTask(parseBody(req.body), req.user);
    res.redirect(`/tasks/${id}?notice=` + encodeURIComponent('Task created.'));
  })
);

// --- POST /tasks/bulk ------------------------------------------------------
router.post(
  '/bulk',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : [];
    const n = await Tasks.bulkUpdate(
      ids,
      { status: req.body.status, priority: req.body.priority, assignee: req.body.assignee },
      req.user
    );
    res.redirect('/tasks?notice=' + encodeURIComponent(`Updated ${n} task(s).`));
  })
);

// --- saved filters ---------------------------------------------------------
router.post(
  '/filters',
  wrap(async (req, res) => {
    await Tasks.saveFilter(req.user.id, req.body.name, parseFilters(req.body));
    res.redirect('/tasks?' + queryString(parseFilters(req.body)) + '&notice=' + encodeURIComponent('Filter saved.'));
  })
);
router.post(
  '/filters/:id/delete',
  wrap(async (req, res) => {
    await Tasks.deleteSavedFilter(req.user.id, Number(req.params.id));
    res.redirect('/tasks');
  })
);

// --- GET /tasks/:id : detail ----------------------------------------------
router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const task = await Tasks.getTask(id, req.user);
    if (!task) {
      const e = new Error('Task not found.');
      e.status = 404;
      throw e;
    }
    if (task.forbidden) {
      const e = new Error('You can only see tasks assigned to you.');
      e.status = 403;
      throw e;
    }
    res.render('tasks/detail', {
      title: task.title,
      active: 'tasks',
      taskActive: 'list',
      task,
      ...(await formContext()),
      notice: req.query.notice || null,
    });
  })
);

// --- GET /tasks/:id/edit ---------------------------------------------------
router.get(
  '/:id/edit',
  wrap(async (req, res) => {
    const task = await Tasks.getTask(Number(req.params.id), req.user);
    if (!task || task.forbidden) {
      const e = new Error('Task not found.');
      e.status = 404;
      throw e;
    }
    res.render('tasks/form', {
      title: `Edit · ${task.title}`,
      active: 'tasks',
      taskActive: 'list',
      task,
      isNew: false,
      ...(await formContext()),
    });
  })
);

// --- POST /tasks/:id : update ----------------------------------------------
router.post(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await Tasks.updateTask(id, parseBody(req.body), req.user);
    res.redirect(`/tasks/${id}?notice=` + encodeURIComponent('Saved.'));
  })
);

// --- task actions ----------------------------------------------------------
router.post(
  '/:id/status',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await Tasks.setStatus(id, req.body.status, req.user);
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok: true });
    res.redirect(req.body.back || `/tasks/${id}`);
  })
);
router.post(
  '/:id/snooze',
  wrap(async (req, res) => {
    await Tasks.snoozeTask(Number(req.params.id), req.user);
    res.redirect((req.body.back || '/tasks') + '?notice=' + encodeURIComponent('Snoozed for 7 days.'));
  })
);
router.post(
  '/:id/wake',
  wrap(async (req, res) => {
    await Tasks.wakeTask(Number(req.params.id), req.user);
    res.redirect((req.body.back || '/tasks/snoozed') + '?notice=' + encodeURIComponent('Task is back in the list.'));
  })
);
router.post(
  '/:id/delete',
  wrap(async (req, res) => {
    await Tasks.softDelete(Number(req.params.id), req.user);
    res.redirect('/tasks?notice=' + encodeURIComponent('Task deleted.'));
  })
);
router.post(
  '/:id/comment',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await Tasks.addComment(id, req.user, req.body.body);
    res.redirect(`/tasks/${id}#activity`);
  })
);
router.post(
  '/:id/attach',
  upload.single('file'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (req.file) await Tasks.addAttachment(id, req.file, req.user);
    res.redirect(`/tasks/${id}`);
  })
);
router.get(
  '/:id/attachment/:attId',
  wrap(async (req, res) => {
    const att = await Tasks.getAttachment(Number(req.params.attId));
    if (!att || att.task_id !== Number(req.params.id)) {
      const e = new Error('Attachment not found.');
      e.status = 404;
      throw e;
    }
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
    res.end(att.file_data);
  })
);
router.post(
  '/:id/reminder',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;
    await addReminder(req.user.id, id, {
      title: b.title,
      note: b.note,
      remind_at: b.remind_at,
      via_email: b.via_email === 'on',
      via_daily_email: b.via_daily_email === 'on',
      via_screen: b.via_screen === 'on',
      recurrence: b.recurrence,
    });
    res.redirect(`/tasks/${id}?notice=` + encodeURIComponent('Reminder set.'));
  })
);

export default router;
