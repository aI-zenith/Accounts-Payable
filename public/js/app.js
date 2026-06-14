// Invoice Bridge — small, dependency-free client interactions.
(function () {
  'use strict';

  // ---- upload: drag-drop + browse + chosen-file display ----
  const zone = document.getElementById('dropzone');
  if (zone) {
    const input = document.getElementById('fileInput');
    const browse = document.getElementById('browseBtn');
    const chosen = document.getElementById('chosenFile');
    const actions = document.getElementById('dropzoneActions');

    const showChosen = (files) => {
      if (!files || !files.length) return;
      chosen.textContent =
        files.length === 1 ? files[0].name : `${files.length} files selected`;
      chosen.hidden = false;
      actions.hidden = false;
    };

    if (browse) browse.addEventListener('click', () => input.click());
    if (input)
      input.addEventListener('change', () => showChosen(input.files));

    ['dragenter', 'dragover'].forEach((evt) =>
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.add('is-drag');
      })
    );
    ['dragleave', 'drop'].forEach((evt) =>
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        if (evt === 'dragleave' && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('is-drag');
      })
    );
    zone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length && input) {
        input.files = files;
        showChosen(files);
      }
    });
  }

  // ---- review: add / remove line items ----
  const addRow = document.getElementById('addRow');
  const tpl = document.getElementById('liTemplate');
  const lineItems = document.getElementById('lineItems');
  if (addRow && tpl && lineItems) {
    const tbody = lineItems.querySelector('tbody');
    addRow.addEventListener('click', () => {
      tbody.appendChild(tpl.content.cloneNode(true));
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-row]');
    if (!btn) return;
    const rows = btn.closest('tbody').querySelectorAll('.li-row');
    if (rows.length > 1) btn.closest('.li-row').remove();
    else {
      // keep one row but clear it
      btn.closest('.li-row').querySelectorAll('input').forEach((i) => (i.value = ''));
    }
  });

  // ---- review: expense-account type-to-search -> resolve to GL account id ----
  const eaInput = document.getElementById('expenseAccountInput');
  const eaId = document.getElementById('expenseAccountId');
  const glMapEl = document.getElementById('glMapData');
  if (eaInput && eaId && glMapEl) {
    let map = {};
    try { map = JSON.parse(glMapEl.textContent || '{}'); } catch (e) { map = {}; }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const sync = () => {
      const id = map[norm(eaInput.value)];
      // Keep the prior id if the current text isn't an exact account name yet.
      if (id) eaId.value = id;
      else if (!eaInput.value) eaId.value = '';
    };
    eaInput.addEventListener('input', sync);
    eaInput.addEventListener('change', sync);
  }

  // ---- review: auto-refresh while extracting ----
  const poller = document.querySelector('[data-poll]');
  if (poller && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setTimeout(() => window.location.reload(), 4000);
  } else if (poller) {
    setTimeout(() => window.location.reload(), 8000);
  }

  // ---- settings: capture chosen card name into hidden field ----
  const rmCardSelect = document.getElementById('rmCardSelect');
  const rmCardName = document.getElementById('rmCardName');
  if (rmCardSelect && rmCardName) {
    const sync = () => {
      const opt = rmCardSelect.options[rmCardSelect.selectedIndex];
      rmCardName.value = opt ? opt.getAttribute('data-name') || '' : '';
    };
    rmCardSelect.addEventListener('change', sync);
    sync();
  }

  // ---- settings: capture chosen GL account name into hidden field ----
  const glSelect = document.getElementById('glSelect');
  const glName = document.getElementById('glName');
  if (glSelect && glName) {
    const syncGl = () => {
      const opt = glSelect.options[glSelect.selectedIndex];
      glName.value = opt ? opt.getAttribute('data-name') || '' : '';
    };
    glSelect.addEventListener('change', syncGl);
    syncGl();
  }

  // ---- settings: connection tests ----
  document.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const which = btn.getAttribute('data-test');
      const card = btn.closest('[data-integration]');
      const dot = card.querySelector('[data-dot]');
      const status = card.querySelector('[data-status]');
      // data-test is the endpoint name: 'rentmanager' | 'claude' | 'email'.
      const url = '/settings/test/' + which;

      dot.className = 'dot is-testing';
      status.hidden = true;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Testing…';

      try {
        const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
        const data = await res.json();
        dot.className = 'dot ' + (data.ok ? 'is-ok' : 'is-fail');
        status.className = 'card__status ' + (data.ok ? 'is-ok' : 'is-fail');
        status.textContent = data.message;
        status.hidden = false;
      } catch (err) {
        dot.className = 'dot is-fail';
        status.className = 'card__status is-fail';
        status.textContent = 'Test request failed: ' + err.message;
        status.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  // ---- auto-submit selects (e.g. inline role change) ----
  document.querySelectorAll('[data-autosubmit]').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (sel.form) sel.form.submit();
    });
  });

  // ---- copy invite link to clipboard ----
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-btn]');
    if (!btn) return;
    const bar = btn.closest('.invitebar') || btn.parentElement;
    const input = bar && bar.querySelector('[data-copy]');
    if (!input) return;
    const flash = () => {
      const t = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = t), 1400);
    };
    input.focus();
    input.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(flash).catch(() => {
        document.execCommand('copy');
        flash();
      });
    } else {
      document.execCommand('copy');
      flash();
    }
  });

  // ---- home: live clock (Eastern) ----
  const clock = document.getElementById('clock');
  if (clock) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
    const tick = () => {
      clock.textContent = fmt.format(new Date());
    };
    tick();
    setInterval(tick, 20000);
  }

  // ---- home: Bridgeport, CT weather (Open-Meteo, no key) ----
  const wx = document.querySelector('[data-weather]');
  if (wx) {
    const wxInfo = (code, isDay) => {
      const m = {
        0: ['Clear', isDay ? '☀️' : '🌙'],
        1: ['Mainly clear', isDay ? '🌤️' : '🌙'],
        2: ['Partly cloudy', '⛅'],
        3: ['Overcast', '☁️'],
        45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
        51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
        61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
        66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
        71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
        80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
        85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
        95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'],
      };
      return m[code] || ['—', '🌡️'];
    };
    const lat = wx.getAttribute('data-lat');
    const lon = wx.getAttribute('data-lon');
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
      '&temperature_unit=fahrenheit&timezone=America/New_York';
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        const c = d.current || {};
        const [label, icon] = wxInfo(c.weather_code, c.is_day);
        wx.innerHTML =
          `<div class="weather__icon">${icon}</div>` +
          `<div class="weather__temp">${Math.round(c.temperature_2m)}°</div>` +
          `<div class="weather__label">${label} · feels ${Math.round(c.apparent_temperature)}°</div>` +
          `<div class="weather__loc">Bridgeport, CT</div>`;
      })
      .catch(() => {
        wx.innerHTML =
          '<div class="weather__loc">Bridgeport, CT</div>' +
          '<div class="weather__loading">Weather unavailable</div>';
      });
  }

  // ---- mobile sidebar toggle ----
  const navToggle = document.getElementById('navToggle');
  if (navToggle) {
    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      document.body.classList.toggle('nav-open');
    });
    document.addEventListener('click', (e) => {
      if (
        document.body.classList.contains('nav-open') &&
        !e.target.closest('.sidebar') &&
        !e.target.closest('#navToggle')
      ) {
        document.body.classList.remove('nav-open');
      }
    });
  }

  // ---- reminder banner: dismiss ----
  const remClose = document.getElementById('remBannerClose');
  if (remClose) {
    remClose.addEventListener('click', () => {
      const b = document.getElementById('remBanner');
      if (b) b.remove();
    });
  }

  // ---- tasks: bulk select ----
  const bulkForm = document.getElementById('bulkForm');
  if (bulkForm) {
    const checkAll = document.getElementById('checkAll');
    const bar = document.getElementById('bulkbar');
    const count = document.getElementById('bulkCount');
    const rows = () => Array.from(bulkForm.querySelectorAll('.rowchk'));
    const refresh = () => {
      const sel = rows().filter((r) => r.checked).length;
      if (count) count.textContent = sel;
      if (bar) bar.hidden = sel === 0;
    };
    if (checkAll)
      checkAll.addEventListener('change', () => {
        rows().forEach((r) => (r.checked = checkAll.checked));
        refresh();
      });
    bulkForm.addEventListener('change', (e) => {
      if (e.target.classList.contains('rowchk')) refresh();
    });
  }

  // ---- tasks: column visibility ----
  document.querySelectorAll('input[data-col]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const col = cb.getAttribute('data-col');
      document.querySelectorAll('[data-col="' + col + '"]').forEach((cell) => {
        if (cell.tagName === 'INPUT') return;
        cell.style.display = cb.checked ? '' : 'none';
      });
    });
  });

  // ---- tasks: kanban drag ----
  const board = document.querySelector('.tkb');
  if (board) {
    let dragged = null;
    board.querySelectorAll('.tkb-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        dragged = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.dataset.taskId);
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        dragged = null;
        board.querySelectorAll('.drop-hover').forEach((d) => d.classList.remove('drop-hover'));
      });
    });
    board.querySelectorAll('[data-droplist]').forEach((list) => {
      list.addEventListener('dragover', (e) => {
        e.preventDefault();
        list.classList.add('drop-hover');
      });
      list.addEventListener('dragleave', () => list.classList.remove('drop-hover'));
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        list.classList.remove('drop-hover');
        if (!dragged) return;
        const status = list.closest('.tkb-col').dataset.status;
        const id = dragged.dataset.taskId;
        const newCard = list.querySelector('.tkb-newcard');
        if (newCard) list.insertBefore(dragged, newCard);
        else list.appendChild(dragged);
        fetch('/tasks/' + id + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: 'status=' + encodeURIComponent(status),
        }).catch(() => {});
        board.querySelectorAll('.tkb-col').forEach((c) => {
          const el = c.querySelector('.tkb-count');
          if (el) el.textContent = c.querySelectorAll('.tkb-card').length;
        });
      });
    });
  }

  // ---- tasks: link a Rent Manager record ----
  const linkType = document.getElementById('linkType');
  const linkSearch = document.getElementById('linkSearch');
  const linkResults = document.getElementById('linkResults');
  if (linkType && linkSearch && linkResults) {
    const linkName = document.getElementById('linkName');
    const linkId = document.getElementById('linkId');
    let timer;
    const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
    const doSearch = () => {
      const q = linkSearch.value.trim();
      if (q.length < 2) {
        linkResults.hidden = true;
        return;
      }
      // Search regardless of the Type dropdown: a chosen type narrows it,
      // otherwise we search every record type at once.
      const type = linkType.value;
      const url = '/tasks/link-search?q=' + encodeURIComponent(q) + (type ? '&type=' + encodeURIComponent(type) : '');
      fetch(url)
        .then((r) => r.json())
        .then((d) => {
          const items = d.results || [];
          const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');
          const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          linkResults.innerHTML = items.length
            ? items
                .map((x) => {
                  const meta = [cap(x.type), x.email, x.phone, x.unit && 'Unit ' + x.unit, x.property && 'Property ' + x.property]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    '<button type="button" data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.name) + '" data-type="' + escAttr(x.type || '') + '">' +
                    escHtml(x.name) +
                    (meta ? '<span class="linkmeta">' + escHtml(meta) + '</span>' : '') +
                    '</button>'
                  );
                })
                .join('')
            : '<button type="button" disabled>No matches</button>';
          linkResults.hidden = false;
        })
        .catch(() => (linkResults.hidden = true));
    };
    linkSearch.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(doSearch, 300);
    });
    // Changing the type narrows an existing search.
    linkType.addEventListener('change', doSearch);
    linkResults.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      const t = b.getAttribute('data-type');
      if (t) linkType.value = t; // set the Type from the chosen record
      if (linkName) linkName.value = b.getAttribute('data-name');
      if (linkId) linkId.value = b.getAttribute('data-id');
      linkResults.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#linkResults') && e.target !== linkSearch) linkResults.hidden = true;
    });
  }

  // ====== Tasks redesign (content-area) ======
  const AVC = ['#2b5fd9', '#7a4dd1', '#0f9d8f', '#c2611f', '#c0398a', '#3a7a3a', '#b5791a', '#d6453d'];
  const avColor = (n) => { let h = 0; for (const ch of String(n || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVC[h % AVC.length]; };
  const initials = (n) => { const p = String(n || '?').trim().split(/\s+/); return ((p[0][0] || '?') + (p[1] ? p[1][0] : '')).toUpperCase(); };
  const escTxt = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

  // ---- AI Polish (form description + comment composer) ----
  const initPolish = (root) => {
    root.querySelectorAll('[data-polish]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      const scope = btn.closest('.tkfield') || btn.closest('.tkcc__box');
      if (!scope) return;
      const menu = (btn.parentElement && btn.parentElement.querySelector('[data-polish-menu]')) || scope.querySelector('[data-polish-menu]');
      const ta = scope.querySelector('textarea');
      const busy = scope.querySelector('[data-busy]');
      const ctx = btn.getAttribute('data-ctx') || 'task description';
      let running = false;
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu) menu.hidden = !menu.hidden; });
      if (menu)
        menu.querySelectorAll('[data-mode]').forEach((opt) => {
          opt.addEventListener('click', () => {
            menu.hidden = true;
            if (running || !ta || !ta.value.trim()) return;
            running = true;
            if (busy) busy.hidden = false;
            // Always release the spinner, even if the network hangs.
            const ctrl = new AbortController();
            const killer = setTimeout(() => ctrl.abort(), 20000);
            fetch('/tasks/ai/polish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: ta.value, mode: opt.getAttribute('data-mode'), context: ctx }),
              signal: ctrl.signal,
            })
              .then((r) => r.json())
              .then((d) => { if (d && d.text) ta.value = d.text; })
              .catch(() => {})
              .finally(() => { clearTimeout(killer); running = false; if (busy) busy.hidden = true; });
          });
        });
    });
  };
  initPolish(document);
  document.addEventListener('click', () => document.querySelectorAll('[data-polish-menu]').forEach((m) => (m.hidden = true)));

  // ---- Comment composer: attach / voice / screen / mention / paste ----
  const initComposer = (root) => root.querySelectorAll('[data-composer]').forEach((form) => {
    if (form.dataset.bound) return;
    form.dataset.bound = '1';
    const fileInput = form.querySelector('[data-file]');
    const kindInput = form.querySelector('[data-kind]');
    const durInput = form.querySelector('[data-duration]');
    const mediaList = form.querySelector('[data-media-list]');
    const recBar = form.querySelector('[data-rec]');
    const recLabel = form.querySelector('[data-rec-label]');
    const recTime = form.querySelector('[data-rec-time]');
    const ta = form.querySelector('[data-text]');
    let mr = null, chunks = [], startT = 0, timer = null, stream = null;

    const renderMedia = (name, kind) => {
      mediaList.innerHTML =
        '<span class="tkmedia">' + (kind === 'voice' ? '🎙️' : kind === 'screen' ? '🖥️' : '📄') + ' ' + escTxt(name) +
        ' <span class="x" data-clear style="cursor:pointer;color:#9aa0ab">×</span></span>';
    };
    const setFile = (file, kind, dur) => { const dt = new DataTransfer(); dt.items.add(file); fileInput.files = dt.files; kindInput.value = kind; if (durInput) durInput.value = dur || ''; renderMedia(file.name, kind); };
    mediaList.addEventListener('click', (e) => { if (e.target.closest('[data-clear]')) { fileInput.value = ''; kindInput.value = 'file'; mediaList.innerHTML = ''; } });

    const attachBtn = form.querySelector('[data-attach]');
    if (attachBtn) attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) { kindInput.value = 'file'; renderMedia(fileInput.files[0].name, 'file'); } });

    let recType = null;
    // Stop every track and clear the timer — the single source of truth for
    // tearing a recording down so nothing is ever left "recording".
    const teardown = () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} stream = null; }
      if (recBar) recBar.hidden = true;
      recType = null;
    };
    const startRec = async (type) => {
      if (recType) { stopRec(); return; } // clicking again stops the current recording
      if (!navigator.mediaDevices || !window.MediaRecorder) { alert('Recording is not supported in this browser.'); return; }
      try {
        stream = type === 'voice'
          ? await navigator.mediaDevices.getUserMedia({ audio: true })
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        chunks = [];
        recType = type;
        const mime = type === 'voice' ? 'audio/webm' : 'video/webm';
        mr = new MediaRecorder(stream, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunks, { type: (mr && mr.mimeType) || mime });
          const dur = Math.max(1, Math.round((Date.now() - startT) / 1000));
          const fname = (type === 'voice' ? 'voice-note' : 'screen-recording') + '-' + Date.now() + '.webm';
          if (blob.size) setFile(new File([blob], fname, { type: blob.type }), type, dur);
          teardown();
        };
        // If the user stops screen-sharing from the browser chrome, end cleanly.
        stream.getTracks().forEach((t) => { t.onended = () => stopRec(); });
        mr.start();
        startT = Date.now();
        recBar.hidden = false;
        if (recLabel) recLabel.textContent = type === 'voice' ? 'Recording voice note' : 'Recording screen';
        const tick = () => { const s = Math.round((Date.now() - startT) / 1000); if (recTime) recTime.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); if (s >= 600) stopRec(); };
        tick();
        timer = setInterval(tick, 500);
      } catch (err) {
        teardown();
        if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') alert('Could not start recording: ' + err.message);
      }
    };
    const stopRec = () => { if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch (e) { teardown(); } } else { teardown(); } };
    const cancelRec = () => { if (mr) mr.onstop = null; if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch (e) {} } chunks = []; mediaList.innerHTML = ''; if (fileInput) { fileInput.value = ''; } if (kindInput) kindInput.value = 'file'; teardown(); };
    const vb = form.querySelector('[data-voice]'); if (vb) vb.addEventListener('click', () => startRec('voice'));
    const sb = form.querySelector('[data-screen]'); if (sb) sb.addEventListener('click', () => startRec('screen'));
    const stb = form.querySelector('[data-rec-stop]'); if (stb) stb.addEventListener('click', stopRec);
    const cb = form.querySelector('[data-rec-cancel]'); if (cb) cb.addEventListener('click', cancelRec);
    const mb = form.querySelector('[data-mention]'); if (mb && ta) mb.addEventListener('click', () => { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@'; ta.focus(); });
    if (ta) ta.addEventListener('paste', (e) => { const f = e.clipboardData && e.clipboardData.files[0]; if (f) setFile(f, 'file'); });
  });
  initComposer(document);

  // ---- Fast in-place tab switching inside the detail panel ----
  // Swap just the detail pane instead of reloading the whole app shell, so
  // moving between Overview / Checklist / Comments / Files / Activity is instant.
  const bindAutosubmit = (root) => root.querySelectorAll('[data-autosubmit]').forEach((s) => {
    if (s.dataset.bound) return;
    s.dataset.bound = '1';
    s.addEventListener('change', () => { if (s.form) s.form.submit(); });
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.tkd-tab');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    const pane = a.closest('[data-detail-pane]');
    if (!pane) return;
    e.preventDefault();
    pane.classList.add('is-loading');
    fetch(a.href, { headers: { 'X-Requested-With': 'fetch' } })
      .then((r) => r.text())
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const fresh = doc.querySelector('[data-detail-pane]');
        if (!fresh) { window.location.href = a.href; return; }
        pane.innerHTML = fresh.innerHTML;
        initPolish(pane); initComposer(pane); bindAutosubmit(pane);
        history.replaceState(null, '', a.href);
      })
      .catch(() => { window.location.href = a.href; })
      .finally(() => pane.classList.remove('is-loading'));
  });

  // ---- People multi-select (assignees / CC) ----
  document.querySelectorAll('[data-multi]').forEach((box) => {
    const name = box.getAttribute('data-multi');
    const wrap = box.parentElement;
    const pop = wrap.querySelector('[data-people]');
    const addBtn = box.querySelector('[data-add]');
    const selected = () => Array.from(box.querySelectorAll('input[type=hidden]')).map((i) => i.value);
    const addChip = (p) => {
      if (box.querySelector('.tk-chip[data-id="' + p.id + '"]')) return;
      const span = document.createElement('span');
      span.className = 'tk-chip';
      span.setAttribute('data-id', p.id);
      span.innerHTML =
        '<span class="av" style="width:21px;height:21px;background:' + avColor(p.name) + ';font-size:9px">' + initials(p.name) + '</span>' +
        escTxt(p.name) + '<span class="x" data-remove>×</span><input type="hidden" name="' + name + '" value="' + p.id + '">';
      box.insertBefore(span, addBtn);
    };
    const renderPop = () => {
      fetch('/tasks/people')
        .then((r) => r.json())
        .then((d) => {
          const sel = selected();
          pop.innerHTML = (d.results || [])
            .map((p) =>
              '<div class="tk-prow" data-id="' + p.id + '" data-name="' + escAttr(p.name) + '">' +
              '<span class="av" style="width:28px;height:28px;background:' + avColor(p.name) + ';font-size:10px">' + initials(p.name) + '</span>' +
              '<div style="flex:1"><div style="font-size:12.5px;font-weight:600">' + escTxt(p.name) + '</div><div style="font-size:11px;color:#9aa0ab">' + escTxt(p.role || '') + '</div></div>' +
              '<span style="color:#2b5fd9;font-weight:700">' + (sel.includes(String(p.id)) ? '✓' : '') + '</span></div>'
            )
            .join('');
          pop.hidden = false;
        });
    };
    box.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) { rm.closest('.tk-chip').remove(); return; }
      renderPop();
    });
    pop.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const ex = box.querySelector('.tk-chip[data-id="' + id + '"]');
      if (ex) ex.remove();
      else addChip({ id, name: row.getAttribute('data-name') });
      renderPop();
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) pop.hidden = true; });
  });

  // ---- Color swatches ----
  document.querySelectorAll('[data-swatches]').forEach((sw) => {
    const input = sw.parentElement.querySelector('[data-color-input]');
    sw.addEventListener('click', (e) => {
      const s = e.target.closest('[data-color]');
      if (!s) return;
      sw.querySelectorAll('.tk-swatch').forEach((x) => x.classList.remove('on'));
      s.classList.add('on');
      if (input) input.value = s.getAttribute('data-color');
    });
  });

  // ---- Recurring toggle ----
  document.querySelectorAll('[data-recur-toggle]').forEach((tg) => {
    const card = tg.closest('.tk-recur');
    const onInput = card.querySelector('[data-recur-on]');
    const fields = card.querySelector('[data-recur-fields]');
    tg.addEventListener('click', () => {
      const on = !tg.classList.contains('on');
      tg.classList.toggle('on', on);
      if (onInput) onInput.value = on ? '1' : '';
      if (fields) fields.style.opacity = on ? '1' : '.45';
    });
  });
})();
