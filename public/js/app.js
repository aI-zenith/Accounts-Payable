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
  document.querySelectorAll('select[data-autosubmit]').forEach((sel) => {
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
  const board = document.querySelector('.board');
  if (board) {
    let dragged = null;
    board.querySelectorAll('.card-task').forEach((card) => {
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
        const status = list.closest('.board__col').dataset.status;
        const id = dragged.dataset.taskId;
        list.appendChild(dragged);
        fetch('/tasks/' + id + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: 'status=' + encodeURIComponent(status),
        }).catch(() => {});
        board.querySelectorAll('.board__col').forEach((c) => {
          const el = c.querySelector('.board__count');
          if (el) el.textContent = c.querySelectorAll('.card-task').length;
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
    const doSearch = () => {
      const type = linkType.value;
      const q = linkSearch.value.trim();
      if (!type || q.length < 2) {
        linkResults.hidden = true;
        return;
      }
      fetch('/tasks/link-search?type=' + encodeURIComponent(type) + '&q=' + encodeURIComponent(q))
        .then((r) => r.json())
        .then((d) => {
          const items = d.results || [];
          linkResults.innerHTML = items.length
            ? items
                .map(
                  (x) =>
                    '<button type="button" data-id="' +
                    x.id +
                    '" data-name="' +
                    String(x.name).replace(/"/g, '&quot;') +
                    '">' +
                    String(x.name).replace(/</g, '&lt;') +
                    '</button>'
                )
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
    linkResults.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      if (linkName) linkName.value = b.getAttribute('data-name');
      if (linkId) linkId.value = b.getAttribute('data-id');
      linkResults.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#linkResults') && e.target !== linkSearch) linkResults.hidden = true;
    });
  }
})();
