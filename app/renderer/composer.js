window.__sidecarErrors = [];
window.addEventListener('error', (e) => window.__sidecarErrors.push(e.message + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => window.__sidecarErrors.push('unhandled promise: ' + (e.reason && e.reason.stack || e.reason)));

(function () {
  const $ = (sel) => document.querySelector(sel);
  const HUE_VAR = (h) => `var(--hue-${h || 'violet'})`;

  const state = {
    targetId: null,
    targetTitle: '',
    targetHue: 'violet',
    targetStatus: null,
    images: [],       // dataURLs
    sessions: [],      // flat list for the swap dropdown
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setError(msg) {
    const el = $('#c-err');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = ''; el.textContent = msg;
  }

  function setTarget(id, title, hue, status, sharesWindowWith) {
    state.targetId = id; state.targetTitle = title || ''; state.targetHue = hue || 'violet'; state.targetStatus = status;
    const nameEl = $('#c-name');
    nameEl.style.setProperty('--hue', HUE_VAR(hue));
    $('#c-name-text').textContent = id ? title : 'No open session';

    const warn = $('#c-sharewarn');
    if (id && sharesWindowWith > 0) {
      warn.style.display = '';
      warn.textContent = `⚠ ${sharesWindowWith} other session${sharesWindowWith === 1 ? '' : 's'} share this window — make sure "${title}" is the active tab in Antigravity first.`;
    } else {
      warn.style.display = 'none';
    }

    const subEl = $('#c-sub');
    subEl.innerHTML = ''; // drop any previous marquee wrap before re-wrapping fresh text
    subEl.textContent = id && status === 'running' ? '· running — this will queue' : '';
    window.SidecarMarquee.refresh(document.querySelector('.ctarget'));

    localStorage.setItem('sidecar:lastTarget', id || '');
    $('#c-send').disabled = !id;
    resize();
  }

  async function loadSessions() {
    const data = await window.sidecar.listSessions();
    const flat = [...data.pinned, ...data.windows.flatMap((w) => w.sessions)]
      .filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
    state.sessions = flat;
    return flat;
  }

  function pickDefaultTarget(flat) {
    const last = localStorage.getItem('sidecar:lastTarget');
    if (last && flat.find((s) => s.id === last)) return flat.find((s) => s.id === last);
    return flat.find((s) => s.status === 'ask') || flat.find((s) => s.status === 'wait') || flat[0] || null;
  }

  async function initTargetIfNeeded() {
    if (state.targetId) return; // already set (e.g. via composer:setTarget)
    const flat = await loadSessions();
    const def = pickDefaultTarget(flat);
    if (def) setTarget(def.id, def.title, def.hue, def.status, def.sharesWindowWith);
    else setTarget(null, '', 'violet', null);
  }

  // ── target swap dropdown ─────────────────────────────────────────────
  function renderDropdown(filter) {
    const f = (filter || '').toLowerCase();
    const rows = state.sessions.filter((s) => !f || s.title.toLowerCase().includes(f));
    $('#c-drop-list').innerHTML = rows.map(renderDropRow).join('')
      || `<div class="drow" style="color:var(--faint)">No open sessions match</div>`;
    document.querySelectorAll('.drow[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const s = state.sessions.find((x) => x.id === row.dataset.id);
        if (s) setTarget(s.id, s.title, s.hue, s.status, s.sharesWindowWith);
        closeDropdown();
      });
    });
  }
  async function openDropdown() {
    await loadSessions();
    renderDropdown('');
    $('#c-drop').classList.add('show');
    $('#c-search').value = '';
    $('#c-search').focus();
    resize();
  }
  function closeDropdown() { $('#c-drop').classList.remove('show'); resize(); }
  function toggleDropdown() { $('#c-drop').classList.contains('show') ? closeDropdown() : openDropdown(); }
  $('#c-swap').addEventListener('click', toggleDropdown);
  $('#c-search').addEventListener('input', (e) => renderDropdown(e.target.value));

  // ── images: paste + drop ─────────────────────────────────────────────
  function addImage(dataUrl) {
    state.images.push(dataUrl);
    renderShots();
  }
  function renderShots() {
    $('#shots').innerHTML = state.images.map((src, i) => `
      <div class="shot"><img src="${src}"><span class="x" data-i="${i}">×</span></div>`).join('');
    document.querySelectorAll('.shot .x').forEach((btn) => {
      btn.addEventListener('click', () => { state.images.splice(+btn.dataset.i, 1); renderShots(); resize(); });
    });
    resize();
  }
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? e.clipboardData.items : [];
    let handledImage = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        handledImage = true;
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => addImage(reader.result);
        reader.readAsDataURL(file);
      }
    }
    if (handledImage) e.preventDefault(); // let plain text paste through to the textarea untouched
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer.files || []) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => addImage(reader.result);
      reader.readAsDataURL(file);
    }
  });

  // ── dictation (shared with the main window) ──────────────────────────
  window.SidecarDictation.attach({
    button: $('#c-mic'),
    label: $('#c-mic-label'),
    getText: () => $('#ta').value,
    setText: (v) => { $('#ta').value = v; autoResizeTextarea(); },
    onError: setError,
  });

  function renderDropRow(s) {
    return `
      <div class="drow" data-id="${escapeHtml(s.id)}">
        <span class="hue-dot" style="background:${HUE_VAR(s.hue)}"></span>
        <span class="nm">${escapeHtml(s.title)}</span>
        <span class="kbd">${escapeHtml(s.status)}</span>
      </div>`;
  }
  // ── textarea autosize + window resize ────────────────────────────────
  function autoResizeTextarea() {
    const ta = $('#ta');
    ta.style.height = 'auto';
    ta.style.height = Math.min(260, ta.scrollHeight) + 'px';
    resize();
  }
  $('#ta').addEventListener('input', autoResizeTextarea);
  // Measure after layout settles, then ask the main process to tween the window
  // to that height. Coalesced so a burst of changes produces one animation
  // rather than several fighting each other.
  let resizeQueued = false;
  function resize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resizeQueued = false;
        const h = document.querySelector('.composer').scrollHeight;
        window.sidecar.resizeComposer(h);
      });
    });
  }

  // ── send ──────────────────────────────────────────────────────────────
  async function doSend(submit) {
    if (!state.targetId) { setError('No open session to send to.'); return; }
    const text = $('#ta').value.trim();
    if (!text && !state.images.length) return;
    setError(null);
    $('#c-send').disabled = true;
    let r;
    try {
      // Explicit primitives only — see the note in renderer.js.
      r = await window.sidecar.send({
        sessionId: String(state.targetId || ''),
        text: String(text || ''),
        images: state.images.filter((x) => typeof x === 'string').map(String),
        submit: !!submit,
      });
    } catch (err) {
      console.error('[sidecar] send failed:', err);
      const raw = (err && err.message) || '';
      r = { ok: false, error: /conversion failure|could not be cloned|processing argument/i.test(raw)
        ? 'Something in that message could not be sent. Try again — if it keeps happening, remove any attached screenshot first.'
        : (raw || 'The send failed unexpectedly.') };
    } finally {
      $('#c-send').disabled = false;   // never leave the button stuck
    }
    if (!r || !r.ok) {
      setError((r && r.error) === 'needs-setup'
        ? 'Sidecar needs one shortcut added to Antigravity first — open Sidecar → Settings → Sending.'
        : ((r && r.error) || 'Could not send.'));
      return;
    }
    $('#ta').value = '';
    state.images = [];
    renderShots();
    autoResizeTextarea();
    window.sidecar.hideComposer();
  }
  $('#c-send').addEventListener('click', () => doSend(true));
  $('#ta').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(true); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); doSend(false); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#c-drop').classList.contains('show')) closeDropdown();
      else window.sidecar.hideComposer();
    }
    if (e.key.toLowerCase() === 's' && e.altKey) { e.preventDefault(); toggleDropdown(); }
  });

  // ── wiring from main process ─────────────────────────────────────────
  window.sidecar.onComposerSetTarget((payload) => {
    setTarget(payload.id, payload.title, payload.hue, null, payload.sharesWindowWith);
  });
  window.sidecar.onComposerReset(async () => {
    setError(null);
    await initTargetIfNeeded();
    $('#ta').focus();
    resize();
  });

  $('#c-close').addEventListener('click', () => window.sidecar.hideComposer());

  function applySettings(s) {
    document.documentElement.style.setProperty('--tint', String(s.composerTint));
    window.SidecarMotion.apply(s.animations);
  }
  window.sidecar.onSettingsChanged(applySettings);
  window.sidecar.getSettings().then(applySettings);

  initTargetIfNeeded().then(() => { $('#ta').focus(); resize(); });
})();
