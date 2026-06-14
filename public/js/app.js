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
      const url = '/settings/test/' + (which === 'claude' ? 'claude' : 'rentmanager');

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
})();
