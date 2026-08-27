window.__sidecarErrors = [];
window.addEventListener('error', (e) => window.__sidecarErrors.push(e.message + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => window.__sidecarErrors.push('unhandled promise: ' + (e.reason && e.reason.stack || e.reason)));

(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const state = {
    sessions: null,       // last result from listSessions()
    readingId: null,
    sendTargetId: null,
    lastGoodReadingId: null,
    diffTargetId: null,
  };

  const ICON = {
    eye: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h10M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pin: '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1.5 14.5 6.5l-1.6 1.6-1-.4-2.6 2.6.5 2.2L8.4 14 6 11.6 2.6 15 1 13.4 4.4 10 2 7.6l1.5-1.4 2.2.5 2.6-2.6-.4-1z"/></svg>',
  };
  const HUE_VAR = (h) => `var(--hue-${h || 'violet'})`;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Claude's replies are markdown, and rendering them as flat text meant bold,
  // code spans and lists all showed up as literal asterisks and backticks.
  // Everything is HTML-escaped first, then a small subset is re-introduced —
  // no raw HTML from the transcript ever reaches the DOM.
  // [text](url) was never handled at all — it rendered as literal brackets and
  // a raw URL. Links open in the system browser, never inside the app: this
  // pane shows other people's model output, and letting it navigate in-place
  // would let a transcript silently redirect the whole window.
  function mdInline(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) =>
        `<a href="#" class="md-link" data-href="${url}">${text}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, pre, url) =>
        `${pre}<a href="#" class="md-link" data-href="${url}">${url}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>');
  }

  function renderMarkdown(raw) {
    const parts = escapeHtml(raw).split('```');
    let out = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {                       // inside a fenced block
        out += `<pre class="md-pre">${part.replace(/^[A-Za-z0-9_+-]*\n/, '')}</pre>`;
        return;
      }
      out += part.split('\n').map((line) => {
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) return `<div class="md-h">${mdInline(h[2])}</div>`;
        const li = line.match(/^\s*[-*+]\s+(.*)$/);
        if (li) return `<div class="md-li"><span class="md-b">•</span><span>${mdInline(li[1])}</span></div>`;
        const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (ol) return `<div class="md-li"><span class="md-b">${ol[1]}.</span><span>${mdInline(ol[2])}</span></div>`;
        return `<div class="md-p">${mdInline(line) || '&nbsp;'}</div>`;
      }).join('');
    });
    return out;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
    return String(n);
  }
  function fmtUSD(n) { return '$' + n.toFixed(2); }

  function pillFor(session) {
    if (session.status === 'thinking') return `<span class="pill run think">Thinking</span>`;
    if (session.status === 'running') return `<span class="pill run">Running</span>`;
    if (session.status === 'ask') return `<span class="pill wait ask">Answer</span>`;
    if (session.status === 'wait') return `<span class="pill wait">You</span>`;
    return `<span class="pill idle">Idle</span>`;
  }

  // ── rail ──────────────────────────────────────────────────────────────
  // The rail used to rebuild its DOM on every poll, which replayed the row
  // entrance animation and made the whole list visibly flicker every few
  // seconds. Now it only touches the DOM when something actually changed,
  // and only genuinely-new rows animate in.
  let lastRailSig = null;
  let prevRowIds = new Set();

  function rowSig(s) {
    return [s.id, s.status, s.unread, s.pinned, s.title, s.lastPrompt,
      s.hue, s.ask ? s.ask.question : '', ago(s.mtimeMs)].join('');
  }
  function railSignature(data) {
    return JSON.stringify({
      pinned: data.pinned.map(rowSig),
      windows: data.windows.map((w) => [w.pid, w.port, w.workspacePath, w.sessions.map(rowSig)]),
      reading: state.readingId,
      sending: state.sendTargetId,
    });
  }

  function renderRail() {
    const list = $('#rlist');
    const data = state.sessions;
    if (!data) return;

    const sig = railSignature(data);
    if (sig === lastRailSig) return;   // nothing visible changed — leave the DOM alone
    lastRailSig = sig;

    if (!data.windows.length && !data.pinned.length) {
      list.innerHTML = `<div class="empty-rail">No Claude Code sessions found in an open Antigravity window.<br><br>Sidecar only shows sessions that belong to a workspace Antigravity currently has open.</div>`;
      $('#livedot').classList.add('off');
      $('#need-count').style.display = 'none';
      return;
    }
    $('#livedot').classList.remove('off');

    const needCount = [...data.pinned, ...data.windows.flatMap((w) => w.sessions)]
      .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i)
      .filter((s) => s.status === 'wait' || s.status === 'ask').length;   // 'thinking' is busy, not waiting
    $('#need-count').style.display = needCount ? '' : 'none';
    $('#need-count').textContent = `${needCount} need${needCount === 1 ? 's' : ''} you`;

    let html = '';
    if (data.pinned.length) html += renderGroup({ nm: 'Pinned', icon: ICON.pin, sessions: data.pinned, pinned: true });
    for (const w of data.windows) {
      const nm = w.workspacePath ? w.workspacePath.split(/[\\/]/).pop() : 'Unknown';
      html += renderGroup({ nm, pt: ':' + w.port, sessions: w.sessions, projectKey: w.projectKey });
    }
    list.innerHTML = html;

    // Animate only rows that weren't here a moment ago, so an unrelated change
    // elsewhere in the list doesn't make every row flash.
    const nowIds = new Set();
    $$('.srow', list).forEach((row) => {
      nowIds.add(row.dataset.id);
      if (!prevRowIds.has(row.dataset.id)) row.classList.add('is-new');
    });
    prevRowIds = nowIds;

    $$('.wlabel .nm', list).forEach((nmEl) => {
      const key = nmEl.dataset.projectKey;
      if (!key) return; // "Pinned" is a mixed group, not one project — no single hue to set
      nmEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openHuePicker(e.clientX, e.clientY, key, nmEl.style.getPropertyValue('--hue'));
      });
    });

    $$('.srow', list).forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.iconbtn')) return;
        openTranscript(id);
      });
      const pinBtn = $('.pinbtn', row);
      if (pinBtn) pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const nowPinned = !pinBtn.classList.contains('is-pinned');
        await window.sidecar.setPinned(id, nowPinned);
        lastRailSig = null;   // pinned state changed — force the rail to redraw
        refresh();
      });
      const aimBtn = $('.aimbtn', row);
      if (aimBtn) aimBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setSendTarget(id);
      });
    });

    window.SidecarMarquee.refresh(list);
  }

  function renderGroup({ nm, pt, sessions, pinned, projectKey }) {
    const hue = sessions[0] ? HUE_VAR(sessions[0].hue) : HUE_VAR();
    const label = pinned
      ? `<span class="pinicon">${ICON.pin}</span><span class="nm" style="color:var(--dim)">Pinned</span>`
      : `<span class="swatch" style="--hue:${hue}"></span><span class="nm" data-project-key="${escapeHtml(projectKey)}" title="Right-click to change colour" style="--hue:${hue}">${escapeHtml(nm)}</span><span class="pt">${pt || ''}</span>`;
    return `
      <div class="wgroup ${pinned ? 'pinned' : ''}">
        <div class="wlabel">${label}</div>
        ${sessions.map(rowHtml).join('')}
      </div>`;
  }

  const HUES = ['violet', 'cyan', 'magenta', 'amber2', 'teal', 'rose'];
  function openHuePicker(x, y, projectKey, current) {
    closeHuePicker();
    const el = document.createElement('div');
    el.className = 'huepicker';
    el.style.left = Math.min(x, window.innerWidth - 190) + 'px';
    el.style.top = Math.min(y, window.innerHeight - 44) + 'px';
    el.innerHTML = HUES.map((h) => `<span class="sw ${current && current.includes(h) ? 'on' : ''}" data-h="${h}" style="background:${HUE_VAR(h)}"></span>`).join('');
    el.querySelectorAll('.sw').forEach((sw) => {
      sw.addEventListener('click', async () => {
        await window.sidecar.setHue(projectKey, sw.dataset.h);
        closeHuePicker();
        refresh();
      });
    });
    document.body.appendChild(el);
    setTimeout(() => document.addEventListener('click', closeHuePicker, { once: true }), 0);
  }
  function closeHuePicker() { $$('.huepicker').forEach((el) => el.remove()); }

  function rowHtml(s) {
    const isReading = s.id === state.readingId;
    const isSending = s.id === state.sendTargetId;
    const cls = ['srow'];
    if (isReading) cls.push('reading');
    if (isSending) cls.push('sending');
    if (s.status === 'idle') cls.push('muted');
    const hue = HUE_VAR(s.hue);

    let mark = '';
    if (isReading) mark = `<span class="eye">${ICON.eye}</span>`;
    else if (isSending) mark = `<span class="snd">${ICON.arrow}</span>`;

    return `
      <div class="${cls.join(' ')}" data-id="${escapeHtml(s.id)}" style="--hue:${hue}">
        <span class="marks">${mark}</span>
        <span class="body">
          <span class="ttl">${s.unread ? '<span class="unread"></span>' : ''}<span class="marq" style="flex:1">${escapeHtml(s.title)}</span></span>
          <span class="last marq">${escapeHtml(s.ask ? s.ask.question : (s.lastPrompt || (s.windowLive ? ago(s.mtimeMs) + ' ago' : 'window closed')))}</span>
        </span>
        <span class="rt">
          ${pillFor(s)}
          <span style="display:flex;gap:4px">
            <button class="iconbtn aimbtn ${isSending ? 'is-aimed' : ''}" title="${isSending ? 'Already the send target' : 'Send prompts to this session'}">${ICON.arrow}</button>
            <button class="iconbtn pinbtn ${s.pinned ? 'is-pinned' : ''}" title="${s.pinned ? 'Unpin this session' : 'Pin to the top'}">${ICON.pin}</button>
          </span>
        </span>
      </div>`;
  }

  function setSendTarget(id) {
    state.sendTargetId = id;
    lastRailSig = null;   // the aim marker moved — force a redraw
    renderRail();
    updateFooter();
  }

  // ── reader ────────────────────────────────────────────────────────────
  function findSession(id) {
    if (!state.sessions) return null;
    return [...state.sessions.pinned, ...state.sessions.windows.flatMap((w) => w.sessions)].find((s) => s.id === id) || null;
  }

  const lastSig = {}; // sessionId -> signature of what's currently rendered, so the poll can skip a no-op rebuild
  const depthFor = {};  // sessionId -> how many pages of history have been pulled in

  async function openTranscript(id) {
    if (state.readingId !== id) depthFor[id] = 1;   // fresh view starts at one page
    state.readingId = id;
    state.lastGoodReadingId = id;
    state.sendTargetId = id;   // click = read it AND talk to it; the ➤ button re-aims elsewhere
    renderRail();
    updateFooter();
    await renderTranscript(id, { forceScroll: true });
    window.sidecar.markRead(id).then(refresh);
  }

  // Called both on click (forceScroll) and by the poll (forceScroll:false) —
  // the poll skips the DOM rebuild entirely when nothing actually changed,
  // so a session that isn't moving doesn't reset your scroll position or
  // restart marquees every few seconds.
  async function renderTranscript(id, { forceScroll } = {}) {
    const t = await window.sidecar.getTranscript(id, depthFor[id] || 1);
    if (state.readingId !== id) return; // user switched away while this was loading

    const sig = JSON.stringify([t.turns, t.status, t.ask]);
    if (!forceScroll && lastSig[id] === sig) return; // no change since last render
    lastSig[id] = sig;

    const body = $('#tx-body');
    const prevScrollTop = body.scrollTop;
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;

    const s = findSession(id);
    $('#tx-head').style.display = '';
    const titleEl = $('#tx-title');
    titleEl.innerHTML = ''; // drop any previous marquee wrap before re-wrapping fresh text
    titleEl.textContent = t.title;
    const pathEl = $('#tx-path');
    pathEl.style.setProperty('--hue', HUE_VAR(s ? s.hue : 'violet'));
    pathEl.querySelector('span:last-child').textContent = t.cwd ? t.cwd.split(/[\\/]/).pop() : '';
    $('#tx-openbtn').onclick = () => window.sidecar.focusSession(id);
    $('#tx-diffbtn').onclick = () => openDiffPanel(id);

    const items = t.turns.slice();
    const showLoadMore = !!t.hasMore;
    if (t.status === 'ask' && t.ask) items.push({ kind: 'ask', ask: t.ask });
    if (t.status === 'running') items.push({ kind: 'working' });
    if (t.status === 'thinking') items.push({ kind: 'thinkingNow' });

    const moreBtn = showLoadMore
      ? `<button class="loadmore" id="tx-loadmore">Load earlier messages</button>` : '';
    body.innerHTML = moreBtn + (items.length
      ? groupTurns(items).map(blockHtml).join('')
      : `<div class="empty-tx">No messages yet in this session.</div>`);
    if (t.status === 'ask' && t.ask) wireAsk(id, t.ask);

    const lm = $('#tx-loadmore');
    if (lm) lm.addEventListener('click', async () => {
      lm.textContent = 'Loading…';
      lm.disabled = true;
      depthFor[id] = (depthFor[id] || 1) + 1;
      lastSig[id] = null;
      // Keep the reading position steady: note how far the content extends
      // below the viewport, then restore that distance after the older turns
      // are prepended, so the page doesn't jump.
      const fromBottom = body.scrollHeight - body.scrollTop;
      await renderTranscript(id, { forceScroll: false });
      body.scrollTop = body.scrollHeight - fromBottom;
    });
    // Rebuilding innerHTML always snaps scrollTop back to 0 — restore exactly
    // where you were unless you were already at the bottom (then follow new
    // content), or this is a fresh open (then jump to the bottom on purpose).
    if (forceScroll || wasAtBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = prevScrollTop;

    window.SidecarMarquee.refresh($('#tx-head'));
    window.SidecarMarquee.refresh(body);
  }

  // Consecutive Claude output (thinking, tool calls, replies) collapses into a
  // single speaker block, so the badge appears once per turn rather than once
  // per line — otherwise a long tool run is a wall of repeated "CLAUDE" chips.
  function groupTurns(items) {
    const blocks = [];
    for (const it of items) {
      const who = it.kind === 'user' ? 'you' : 'claude';
      const last = blocks[blocks.length - 1];
      if (last && last.who === who && who === 'claude') last.items.push(it);
      else blocks.push({ who, items: [it] });
    }
    return blocks;
  }

  function blockHtml(b) {
    const cls = b.who === 'you' ? 'turn you' : 'turn';
    const label = b.who === 'you' ? 'You' : 'Claude';
    return `<div class="${cls}"><span class="who">${label}</span><div class="stack">${b.items.map(itemHtml).join('')}</div></div>`;
  }

  function itemHtml(t) {
    if (t.kind === 'thinking') return `<span class="fold">▸ Thought</span>`;
    if (t.kind === 'tool') return `<div class="tool">${escapeHtml(t.name)}${t.detail ? ' <b>' + escapeHtml(t.detail) + '</b>' : ''}</div>`;
    if (t.kind === 'user') return `<div class="bubble">${renderMarkdown(t.text)}${t.hasImage ? '<span class="clip">📎 image</span>' : ''}</div>`;
    if (t.kind === 'ask') return askHtml(t.ask);
    if (t.kind === 'working') return `<span class="working"><span class="s"></span> still running…</span>`;
    if (t.kind === 'thinkingNow') return `<span class="working thinking-now"><span class="dots"><i></i><i></i><i></i></span> thinking…</span>`;
    return `<div class="md">${renderMarkdown(t.text)}</div>`;
  }

  function askHtml(ask) {
    const opts = (ask.options.length ? ask.options : [{ label: 'Yes', description: '' }, { label: 'No', description: '' }])
      .map((o, i) => `
        <button class="opt" data-i="${i}" data-label="${escapeHtml(o.label)}">
          <span class="n">${i + 1}</span>
          <span><span class="ol">${escapeHtml(o.label)}</span>${o.description ? `<span class="od">${escapeHtml(o.description)}</span>` : ''}</span>
        </button>`).join('');
    return `
      <div class="ask">
        <div class="ask-head"><span class="lbl">Waiting on you</span><span class="q">${escapeHtml(ask.question)}</span></div>
        <div class="opts">${opts}</div>
        <div class="ask-foot"><span class="hint">Click an option, or reply normally below</span></div>
      </div>`;
  }

  function wireAsk(id, ask) {
    $$('.opt', $('#tx-body')).forEach((btn) => {
      btn.addEventListener('click', async () => {
        $$('.opt', $('#tx-body')).forEach((b) => b.classList.remove('sel'));
        btn.classList.add('sel');
        btn.disabled = true;
        const r = await window.sidecar.answerQuestion({ sessionId: id, answerText: btn.dataset.label });
        if (!r.ok) alert('Could not send the answer: ' + r.error);
        setTimeout(refresh, 400);
      });
    });
  }

  function updateFooter() {
    const foot = $('#tx-foot');
    const input = $('#tx-input');
    if (!state.sendTargetId) { foot.style.display = 'none'; return; }
    const s = findSession(state.sendTargetId);
    foot.style.display = '';
    input.placeholder = `Message ${s ? s.title : '…'}${s && s.status === 'running' ? ' — will queue' : ''}`;

    // Sidecar can bring the right window forward but not pick which session
    // tab is active inside it — if this window has other sessions, warn
    // before a send can land in the wrong one.
    const shareBox = $('#tx-sharewarn');
    if (s && s.sharesWindowWith > 0) {
      shareBox.style.display = '';
      shareBox.textContent = `⚠ This window has ${s.sharesWindowWith} other session${s.sharesWindowWith === 1 ? '' : 's'} open too — make sure “${s.title}” is the active tab in Antigravity before sending.`;
    } else {
      shareBox.style.display = 'none';
    }

    $('#tx-popout').onclick = () => {
      window.sidecar.openComposerFor({ id: state.sendTargetId, title: s ? s.title : '', hue: s ? s.hue : 'violet', sharesWindowWith: s ? s.sharesWindowWith : 0 });
    };
  }

  // Screenshots can be pasted or dropped straight onto the reader, not just
  // into the pop-up prompt box.
  let inlineImages = [];
  function renderInlineShots() {
    const box = $('#tx-shots');
    box.style.display = inlineImages.length ? '' : 'none';
    box.innerHTML = inlineImages.map((src, i) => `
      <div class="shot"><img src="${src}"><span class="x" data-i="${i}">×</span></div>`).join('');
    $$('#tx-shots .x').forEach((btn) => {
      btn.addEventListener('click', () => { inlineImages.splice(+btn.dataset.i, 1); renderInlineShots(); });
    });
  }
  function attachImageFiles(files) {
    let added = false;
    for (const file of files || []) {
      if (!file || !file.type || !file.type.startsWith('image/')) continue;
      added = true;
      const reader = new FileReader();
      reader.onload = () => { inlineImages.push(reader.result); renderInlineShots(); };
      reader.readAsDataURL(file);
    }
    return added;
  }
  document.addEventListener('paste', (e) => {
    if ($('#setup-overlay').classList.contains('show')) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) if (it.kind === 'file' && it.type.startsWith('image/')) files.push(it.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    if (!state.sendTargetId) {
      showSendError('Pick a session on the left first, then paste.');
      return;
    }
    attachImageFiles(files);
    $('#tx-input').focus();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    attachImageFiles(e.dataTransfer.files);
  });

  // Electron's own IPC errors ("conversion failure from", "could not be
  // cloned") describe an internal serialisation step and mean nothing to
  // someone trying to send a message. Translate them.
  function friendlySendError(err) {
    const raw = (err && err.message) || '';
    if (/conversion failure|could not be cloned|processing argument/i.test(raw)) {
      return 'Something in that message could not be sent. Try again — if it keeps happening, remove any attached screenshot first.';
    }
    return raw || 'The send failed unexpectedly.';
  }

  function showSendError(msg, withSetup) {
    const el = $('#tx-err');
    el.style.display = '';
    if (withSetup) {
      el.innerHTML = `${escapeHtml(msg)} <button class="btn ghost" id="tx-setup" style="padding:3px 9px;font-size:11px;margin-left:6px">Set it up</button>`;
      $('#tx-setup').addEventListener('click', openSetupOverlay);
    } else {
      el.textContent = msg;
    }
  }

  async function sendInline() {
    const input = $('#tx-input');
    const text = input.value.trim();
    if ((!text && !inlineImages.length) || !state.sendTargetId) return;
    $('#tx-err').style.display = 'none';

    // Clear immediately so the box is empty the instant you press Enter, the
    // way a chat box should behave. If the send fails the text is put back,
    // so nothing typed is ever lost.
    const sentImages = inlineImages;
    input.value = '';
    autoGrowTxInput();
    inlineImages = [];
    renderInlineShots();
    input.disabled = true;

    let r;
    try {
      // Built as explicit primitives. contextBridge clones arguments as they
      // cross out of the page, so anything non-plain fails *there* — before
      // preload can sanitise it — with an opaque "conversion failure" error.
      r = await window.sidecar.send({
        sessionId: String(state.sendTargetId || ''),
        text: String(text || ''),
        images: sentImages.filter((x) => typeof x === 'string').map(String),
        submit: true,
      });
    } catch (err) {
      console.error('[sidecar] send failed:', err);
      r = { ok: false, error: friendlySendError(err) };
    } finally {
      // Always re-enable. This used to sit after the await, so any thrown
      // error left the box permanently disabled and un-editable.
      input.disabled = false;
    }

    if (!r || !r.ok) {
      input.value = text;            // put the message back, nothing is lost
      autoGrowTxInput();
      inlineImages = sentImages;
      renderInlineShots();
      if (r && r.error === 'needs-setup') {
        showSendError('Sidecar needs one shortcut added to Antigravity before it can type into a session.', true);
      } else {
        showSendError((r && r.error) || 'Could not send.');
      }
      input.focus();
      return;
    }
    input.focus();
    setTimeout(refresh, 500);
  }
  // Grows with content instead of scrolling sideways as a single line.
  function autoGrowTxInput() {
    const el = $('#tx-input');
    el.style.height = 'auto';
    el.style.height = Math.min(140, el.scrollHeight) + 'px';
  }
  $('#tx-input').addEventListener('input', autoGrowTxInput);

  $('#tx-sendbtn').addEventListener('click', sendInline);
  $('#tx-input').addEventListener('keydown', (e) => {
    // Shift+Enter (or Ctrl+Enter) inserts a real newline; plain Enter sends —
    // same convention as the pop-up prompt box.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); sendInline(); }
  });

  // ── edits / diff review ───────────────────────────────────────────────
  let diffEdits = [], diffIdx = 0;

  async function openDiffPanel(id) {
    diffEdits = await window.sidecar.getEdits(id);
    diffIdx = 0;
    $('#diff-count').textContent = diffEdits.length
      ? `${diffEdits.length} recent edit${diffEdits.length === 1 ? '' : 's'}`
      : '';
    renderDiffTabs();
    renderDiffView();
    await renderDiffActions(id);
    $('#diff-overlay').classList.add('show');
  }

  function renderDiffTabs() {
    $('#diff-tabs').innerHTML = diffEdits.map((e, i) => `
      <button class="ftab ${i === diffIdx ? 'on' : ''}" data-i="${i}">
        <span class="nm">${escapeHtml(e.name)}</span>
        <span class="st"><span class="p">+${e.added}</span>${e.removed ? `<span class="m">−${e.removed}</span>` : ''}</span>
      </button>`).join('');
    $$('#diff-tabs .ftab').forEach((tab) => {
      tab.addEventListener('click', () => { diffIdx = +tab.dataset.i; renderDiffTabs(); renderDiffView(); });
    });
  }

  function renderDiffView() {
    const view = $('#diff-view');
    const e = diffEdits[diffIdx];
    if (!e) {
      view.innerHTML = `<div class="diff-empty">No file edits recorded in this session yet.<br>
        Accept and Reject below still act on whatever diff Antigravity currently has open.</div>`;
      return;
    }
    const sign = { add: '+', del: '−', ctx: ' ', gap: '' };
    view.innerHTML = `
      <div class="diff">
        <div class="diff-head">
          <span class="fn">${escapeHtml(e.file)}</span>
          <span class="st"><span class="p">+${e.added}</span>${e.removed ? `<span class="m">−${e.removed}</span>` : ''}</span>
        </div>
        <div class="dlines">${e.rows.map((r) => `
          <div class="dl ${r.t}"><span class="sg">${sign[r.t] || ''}</span><span class="tx2">${escapeHtml(r.s)}</span></div>`).join('')}
        </div>
      </div>`;
  }

  async function renderDiffActions(id) {
    const st = await window.sidecar.keybindingsStatus();
    const actions = $('#diff-actions');
    if (!st.installed) {
      actions.innerHTML = `
        <p>The edits above are what Claude changed in this session, read from its transcript.
        To <em>accept or reject</em> a diff, Sidecar has to drive Antigravity — and the Claude Code
        extension ships no shortcut for either command. It can add two to Antigravity's own
        <code>keybindings.json</code> (backed up first).</p>
        <div class="row">
          <button class="btn" id="diff-install">Add shortcuts</button>
          <button class="btn ghost" id="diff-open">Open in Antigravity</button>
        </div>`;
      $('#diff-install').onclick = async () => {
        const r = await window.sidecar.installKeybindings();
        if (r.ok) renderDiffActions(id); else alert(r.error || 'Could not install the shortcuts.');
      };
    } else {
      actions.innerHTML = `
        <p>Accept and Reject act on the diff <em>Antigravity currently has open</em>, not on the
        specific edit shown above — Sidecar can read the transcript, but the extension exposes no
        way to see which diff is pending.</p>
        <div class="row">
          <button class="btn accept" id="diff-accept">Accept</button>
          <button class="btn danger" id="diff-reject">Reject</button>
          <button class="btn ghost" id="diff-open">Open in Antigravity</button>
        </div>`;
      $('#diff-accept').onclick = async () => { const r = await window.sidecar.acceptDiff(id); $('#diff-overlay').classList.remove('show'); if (!r.ok) alert(r.error); };
      $('#diff-reject').onclick = async () => { const r = await window.sidecar.rejectDiff(id); $('#diff-overlay').classList.remove('show'); if (!r.ok) alert(r.error); };
    }
    const open = $('#diff-open');
    if (open) open.onclick = () => window.sidecar.focusSession(id);
  }
  $('#diff-close').addEventListener('click', () => $('#diff-overlay').classList.remove('show'));

  // ── usage overlay ────────────────────────────────────────────────────
  // Compact plan lines in the rail foot. Session and Weekly are both always
  // shown — the 5-hour session window is the one that actually stops you
  // working, so it stays visible even while it reads 0%.
  const MINI_LIMITS = ['session', 'weekly_all'];
  const MINI_NAMES = { session: 'Session (5h)', weekly_all: 'Weekly (7d)' };

  async function loadPlanMini() {
    const plan = await window.sidecar.getPlan();
    const el = $('#planmini');
    if (!plan.available || !plan.limits.length) { el.style.display = 'none'; return; }

    const rows = MINI_LIMITS
      .map((k) => plan.limits.find((l) => l.key === k))
      .filter(Boolean)
      .map((l) => {
        const pct = Math.max(0, Math.min(100, l.percent));
        const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
        return `
          <div class="mini-plan">
            <span class="nm">${escapeHtml(MINI_NAMES[l.key] || l.label)}</span>
            <span class="rs">${escapeHtml(untilText(l.resetsAt))}</span>
            <span class="pct">${pct}%</span>
            <div class="plan-bar"><i class="${cls}" style="width:${pct}%"></i></div>
          </div>`;
      }).join('');

    if (!rows) { el.style.display = 'none'; return; }

    // These percentages come from a cache Claude Code refreshes only when it
    // next contacts the API — nothing on disk is fresher, and Sidecar
    // deliberately makes no API calls of its own. So they are labelled with
    // their age and dimmed once stale, and a *measured* 5-hour figure is shown
    // underneath: that one is counted from the transcripts and is always live.
    const ageMs = plan.fetchedAtMs ? Date.now() - plan.fetchedAtMs : null;
    const stale = ageMs !== null && ageMs > 20 * 60 * 1000;
    const ageLabel = ageMs === null ? '' : untilAgo(plan.fetchedAtMs);

    let measured = '';
    try {
      const u5 = await window.sidecar.getUsage(5);
      measured = `
        <div class="mini-measured">
          <span class="nm">Last 5h measured</span>
          <span class="v">${fmtTokens(u5.totalTokens)} &middot; ${fmtUSD(u5.totals.costUSD)}</span>
        </div>`;
    } catch (e) { /* usage scan failed — the plan rows still stand on their own */ }

    el.style.display = '';
    el.innerHTML = rows + `
      <div class="mini-age${stale ? ' stale' : ''}" title="Claude Code refreshes these only when it next contacts the API. Sidecar makes no API calls, so it cannot refresh them itself.">
        ${stale ? '&#9888; plan % is ' + escapeHtml(ageLabel) + ' old' : 'plan % ' + escapeHtml(ageLabel)}
      </div>` + measured;
  }

  async function loadMeter() {
    loadPlanMini();
    const u = await window.sidecar.getUsage(24);
    const tot = u.totalTokens || 1;
    $('#m-tokens').textContent = fmtTokens(u.totalTokens);
    $('#m-cost').textContent = fmtUSD(u.totals.costUSD);
    $('#b-out').style.width = (u.totals.output / tot * 100) + '%';
    $('#b-cw').style.width = (u.totals.cacheWrite / tot * 100) + '%';
    $('#b-cr').style.width = (u.totals.cacheRead / tot * 100) + '%';
    $('#b-in').style.width = (u.totals.input / tot * 100) + '%';
    $('#rfoot-tiny').innerHTML = `${state.sessions ? state.sessions.windows.length : 0} window(s) · ${state.sessions ? [...state.sessions.pinned, ...state.sessions.windows.flatMap(w=>w.sessions)].filter((s,i,a)=>a.findIndex(x=>x.id===s.id)===i).length : 0} sessions<br>${state.sessions ? state.sessions.hiddenCount : 0} more on disk — hidden`;
    return u;
  }

  async function openUsageOverlay() {
    renderPlan(await window.sidecar.getPlan());
    const u = await loadMeter();
    const tot = u.totalTokens || 1;
    $('#u-tokens').textContent = fmtTokens(u.totalTokens);
    $('#u-cost').textContent = fmtUSD(u.totals.costUSD);
    $('#u-touched').textContent = u.sessionsTouched;
    $('#u-where-total').textContent = u.totalTokens.toLocaleString() + ' tokens';
    $('#u-b-out').style.width = (u.totals.output / tot * 100) + '%';
    $('#u-b-cw').style.width = (u.totals.cacheWrite / tot * 100) + '%';
    $('#u-b-cr').style.width = (u.totals.cacheRead / tot * 100) + '%';
    $('#u-b-in').style.width = (u.totals.input / tot * 100) + '%';
    $('#u-k-out').textContent = fmtTokens(u.totals.output);
    $('#u-k-cw').textContent = fmtTokens(u.totals.cacheWrite);
    $('#u-k-cr').textContent = fmtTokens(u.totals.cacheRead);
    $('#u-k-in').textContent = fmtTokens(u.totals.input);
    $('#u-list').innerHTML = u.perSession.map((s) => `
      <div class="u-row" style="--hue:${HUE_VAR(s.hue)}">
        <span class="sw"></span><span class="nm">${escapeHtml(s.title)}</span>
        <span class="tk">${fmtTokens(s.tokens)}</span><span class="cs">${fmtUSD(s.costUSD)}</span>
      </div>`).join('') || `<div class="u-row"><span></span><span class="nm">Nothing in the last 24 hours</span><span></span><span></span></div>`;
    $('#usage-overlay').classList.add('show');
  }
  $('#meterrow').addEventListener('click', openUsageOverlay);
  $('#planmini').addEventListener('click', openUsageOverlay);
  $('#btn-usage').addEventListener('click', openUsageOverlay);
  $('#usage-close').addEventListener('click', () => $('#usage-overlay').classList.remove('show'));

  // ── plan usage (real figures, read from ~/.claude.json) ──────────────
  function untilText(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return 'resets soon';
    const h = Math.round(ms / 3600000);
    if (h < 1) return `resets in ${Math.max(1, Math.round(ms / 60000))}m`;
    if (h < 48) return `resets in ${h}h`;
    return `resets in ${Math.round(h / 24)}d`;
  }

  function renderPlan(plan) {
    const box = $('#plan-box');
    if (!plan || !plan.available) {
      box.className = 'plan-unavail';
      box.textContent = (plan && plan.reason) || 'Plan usage unavailable.';
      return;
    }
    box.className = 'plan';
    const rows = plan.limits.map((l) => {
      const pct = Math.max(0, Math.min(100, l.percent));
      const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
      const name = l.scope ? `${l.label} · ${l.scope}` : l.label;
      return `
        <div class="plan-row">
          <div class="plan-top"><span>${escapeHtml(name)}</span>
            <span class="rs">${escapeHtml(untilText(l.resetsAt))}</span>
            <span class="pct">${pct}%</span></div>
          <div class="plan-bar"><i class="${cls}" style="width:${pct}%"></i></div>
        </div>`;
    }).join('');
    const age = plan.fetchedAtMs ? untilAgo(plan.fetchedAtMs) : null;
    box.innerHTML = rows + `
      <div class="plan-meta">
        ${plan.tier ? `<span class="tier">${escapeHtml(plan.tier)}</span>` : ''}
        <span>${age ? `figures from ${age}` : ''}</span>
      </div>`;
  }

  function untilAgo(ms) {
    const d = Date.now() - ms;
    const m = Math.round(d / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  // ── settings ─────────────────────────────────────────────────────────
  let settings = null;

  function applySettings(s) {
    settings = s;
    document.documentElement.style.setProperty('--tint', String(s.tint));
    window.SidecarMotion.apply(s.animations);
  }

  function setToggle(el, on) { el.classList.toggle('on', !!on); }

  async function openSetupOverlay() {
    settings = await window.sidecar.getSettings();
    applySettings(settings);

    $('#s-tint').value = Math.round(settings.tint * 100);
    $('#s-tint-v').textContent = Math.round(settings.tint * 100) + '%';
    $('#s-ctint').value = Math.round(settings.composerTint * 100);
    $('#s-ctint-v').textContent = Math.round(settings.composerTint * 100) + '%';
    $$('#s-anim button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.animations));
    $('#s-anim-note').textContent = window.SidecarMotion.systemPrefersReduced()
      ? 'Windows currently has animation effects switched off, so Automatic means no animations here.'
      : 'Windows currently has animation effects on.';
    $$('#s-material button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.material));
    $$('#s-winmode button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.windowMode));
    await renderSurfaceNote();
    setToggle($('#s-autohide'), settings.composerAutoHide);
    setToggle($('#s-returnfocus'), settings.returnFocusAfterSend);
    $('#s-hk-composer').textContent = prettyAccel(settings.hotkeyComposer);
    $('#s-hk-main').textContent = prettyAccel(settings.hotkeyMain);

    const hk = await window.sidecar.hotkeyStatus();
    const dead = [];
    if (!hk.composer) dead.push('the prompt box');
    if (!hk.main) dead.push('show/hide');
    $('#s-hk-composer').classList.toggle('bad', !hk.composer);
    $('#s-hk-main').classList.toggle('bad', !hk.main);
    $('#s-hk-note').innerHTML = dead.length
      ? `Windows refused the shortcut for ${dead.join(' and ')} — another app already owns it. Pick a different combination.`
      : `Click a shortcut, then press the keys you want. <code>Esc</code> cancels.`;

    await renderDiffSetup();
    refreshVersionRow();
    $('#setup-overlay').classList.add('show');
  }

  async function renderDiffSetup() {
    const st = await window.sidecar.keybindingsStatus();
    $('#setup-body').innerHTML = st.installed
      ? `<p><strong>Ready.</strong> Sending prompts, answering questions, and Accept/Reject all work.</p>
         <p>Sidecar added three shortcuts to Antigravity's own keyboard shortcuts:
         <code>Ctrl+Alt+Shift+0</code> focuses Claude's input box, <code>Ctrl+Alt+Shift+Y</code> accepts a diff,
         <code>Ctrl+Alt+Shift+N</code> rejects one.</p>`
      : `<p>Sidecar types into Antigravity the way you would — it brings the window forward and
         pastes. But focusing <em>Claude's input box specifically</em> needs a shortcut, and the
         extension's built-in one only fires when an editor already has focus, which is never true
         when the keystroke arrives from another app.</p>
         <p>So three shortcuts get added to Antigravity's own <code>keybindings.json</code>
         (focus input, accept diff, reject diff). Your existing file is backed up first.</p>
         <div class="row"><button class="btn" id="setup-install">Add shortcuts</button></div>`;
    const b = $('#setup-install');
    if (b) b.addEventListener('click', async () => {
      const r = await window.sidecar.installKeybindings();
      if (r.ok) renderDiffSetup(); else alert(r.error);
    });
  }

  async function saveSetting(partial) {
    const r = await window.sidecar.setSettings(partial);
    applySettings(r.settings);
    return r;
  }

  $('#s-tint').addEventListener('input', (e) => {
    const v = +e.target.value / 100;
    $('#s-tint-v').textContent = e.target.value + '%';
    document.documentElement.style.setProperty('--tint', String(v)); // live preview
  });
  $('#s-tint').addEventListener('change', (e) => saveSetting({ tint: +e.target.value / 100 }));
  $('#s-ctint').addEventListener('input', (e) => { $('#s-ctint-v').textContent = e.target.value + '%'; });
  $('#s-ctint').addEventListener('change', (e) => saveSetting({ composerTint: +e.target.value / 100 }));
  // Explains, in order of what actually matters: a pending restart, then
  // Windows silently overriding Glass mode, then the plain description.
  async function renderSurfaceNote() {
    const info = await window.sidecar.surfaceInfo();
    const note = $('#s-surface-note');
    const mode = settings.windowMode;
    $('#s-material-row').style.display = mode === 'glass' ? '' : 'none';

    if (info.activeMode && info.activeMode !== mode) {
      note.innerHTML = `Switching surface needs a restart. `
        + `<button class="btn ghost" id="s-relaunch" style="padding:4px 10px;font-size:11.5px">Restart Sidecar</button>`;
      $('#s-relaunch').addEventListener('click', () => window.sidecar.relaunch());
      return;
    }
    if (mode === 'glass' && info.windowsTransparencyEffects === false) {
      note.innerHTML = `Windows has <em>Transparency effects</em> switched off, so Glass is being drawn solid — `
        + `that's Windows overriding it, not Sidecar. Switch it on in Settings → Personalization → Colors, or use <em>Clear</em>.`;
      return;
    }
    note.textContent = mode === 'clear'
      ? 'The transparency slider above is real per-pixel alpha in this mode, so Windows settings cannot override it.'
      : 'Windows is compositing the blur behind this window.';
  }

  $$('#s-winmode button').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await saveSetting({ windowMode: b.dataset.v });
      $$('#s-winmode button').forEach((x) => x.classList.toggle('on', x.dataset.v === r.settings.windowMode));
      await renderSurfaceNote();
    });
  });

  $$('#s-material button').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await saveSetting({ material: b.dataset.v });
      $$('#s-material button').forEach((x) => x.classList.toggle('on', x.dataset.v === r.settings.material));
    });
  });
  $$('#s-anim button').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await saveSetting({ animations: b.dataset.v });
      $$('#s-anim button').forEach((x) => x.classList.toggle('on', x.dataset.v === r.settings.animations));
    });
  });
  $('#s-returnfocus').addEventListener('click', async () => {
    const r = await saveSetting({ returnFocusAfterSend: !settings.returnFocusAfterSend });
    setToggle($('#s-returnfocus'), r.settings.returnFocusAfterSend);
  });
  $('#s-autohide').addEventListener('click', async () => {
    const r = await saveSetting({ composerAutoHide: !settings.composerAutoHide });
    setToggle($('#s-autohide'), r.settings.composerAutoHide);
  });

  // Click a shortcut button, press a combination, and it re-binds live.
  function prettyAccel(a) {
    return String(a || '')
      .replace(/CommandOrControl|Control/g, 'Ctrl')
      .split('+').join(' + ');
  }
  function recordHotkey(btn, key) {
    let active = false;
    const onKey = async (e) => {
      if (!active) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { stop(); return; }
      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const k = e.key;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return; // wait for a real key
      if (!mods.length) return;                                    // needs at least one modifier
      const name = k === ' ' ? 'Space' : (k.length === 1 ? k.toUpperCase() : k);
      const accel = [...mods, name].join('+');
      stop();
      const r = await saveSetting({ [key]: accel });
      btn.textContent = prettyAccel(accel);
      const ok = !r.hotkeys || (key === 'hotkeyComposer' ? r.hotkeys.composer : r.hotkeys.main);
      btn.classList.toggle('bad', !ok);
      $('#s-hk-note').innerHTML = ok
        ? `Saved. <code>Esc</code> cancels while recording.`
        : `Windows refused that combination — another app already owns it. Try another.`;
    };
    function stop() {
      active = false;
      btn.classList.remove('recording');
      btn.textContent = prettyAccel(settings[key]);
      window.removeEventListener('keydown', onKey, true);
    }
    btn.addEventListener('click', () => {
      if (active) { stop(); return; }
      active = true;
      btn.classList.add('recording');
      btn.textContent = 'Press keys…';
      window.addEventListener('keydown', onKey, true);
    });
  }
  recordHotkey($('#s-hk-composer'), 'hotkeyComposer');
  recordHotkey($('#s-hk-main'), 'hotkeyMain');

  $('#btn-setup').addEventListener('click', openSetupOverlay);
  $('#setup-close').addEventListener('click', () => $('#setup-overlay').classList.remove('show'));

  // ── dictation in the reader's send bar ───────────────────────────────
  window.SidecarDictation.attach({
    button: $('#tx-mic'),
    getText: () => $('#tx-input').value,
    setText: (v) => { $('#tx-input').value = v; },
    onError: (msg) => showSendError(msg),
  });

  // ── updates ──────────────────────────────────────────────────────────
  let updateDismissed = false;

  function renderUpdate(st) {
    const bar = $('#updatebar');
    const text = $('#ub-text');
    const actions = $('#ub-actions');
    const barWrap = $('#ub-bar');

    const show = (html, acts, { error, progress } = {}) => {
      bar.hidden = false;
      bar.classList.toggle('is-error', !!error);
      text.innerHTML = html;
      actions.innerHTML = acts || '';
      barWrap.hidden = progress === undefined;
      if (progress !== undefined) $('#ub-fill').style.width = progress + '%';
    };

    if (!st || updateDismissed) { if (!st) bar.hidden = true; return; }

    switch (st.status) {
      case 'available':
        show(`Sidecar <b>${escapeHtml(st.version || '')}</b> is available.`,
          `<button class="btn" id="ub-get">Download</button>`);
        $('#ub-get').addEventListener('click', () => window.sidecar.updateDownload());
        break;
      case 'downloading':
        show(`Downloading <b>${escapeHtml(st.version || '')}</b>…`, '', { progress: st.percent || 0 });
        break;
      case 'ready':
        show(`Sidecar <b>${escapeHtml(st.version || '')}</b> is ready to install.`,
          `<button class="btn" id="ub-install">Restart &amp; update</button>`);
        $('#ub-install').addEventListener('click', () => window.sidecar.updateInstall());
        break;
      case 'error':
        show(`Update failed: ${escapeHtml(st.error || '')}`,
          `<button class="btn ghost" id="ub-retry">Try again</button>`, { error: true });
        $('#ub-retry').addEventListener('click', () => window.sidecar.updateCheck());
        break;
      default:
        bar.hidden = true;   // idle / checking / current / dev — nothing worth interrupting for
    }
  }

  $('#ub-dismiss').addEventListener('click', () => {
    updateDismissed = true;
    $('#updatebar').hidden = true;
  });
  window.sidecar.onUpdateChanged((st) => { updateDismissed = false; renderUpdate(st); });
  window.sidecar.updateState().then(renderUpdate);

  async function refreshVersionRow() {
    const [v, st] = await Promise.all([window.sidecar.appVersion(), window.sidecar.updateState()]);
    $('#s-version').textContent = v || '—';
    const note = $('#s-update-note');
    if (st.status === 'dev') {
      note.textContent = 'Running from source — there is no installer to replace, so updates are disabled. Packaged builds check GitHub and ask before downloading.';
    } else if (st.status === 'available') {
      note.textContent = `Version ${st.version} is available.`;
    } else if (st.status === 'ready') {
      note.textContent = `Version ${st.version} is downloaded and will install on restart.`;
    } else if (st.status === 'error') {
      note.textContent = `Last check failed: ${st.error}`;
    } else {
      note.textContent = 'Sidecar checks GitHub for new versions and asks before downloading anything.';
    }
  }
  $('#s-checkupdate').addEventListener('click', async () => {
    const b = $('#s-checkupdate');
    b.disabled = true; b.textContent = 'Checking…';
    await window.sidecar.updateCheck();
    b.disabled = false; b.textContent = 'Check now';
    refreshVersionRow();
  });

  // ── window chrome ────────────────────────────────────────────────────
  $('#btn-min').addEventListener('click', () => window.sidecar.minimizeMain());
  $('#btn-hide').addEventListener('click', () => window.sidecar.hideMain());
  $('#btn-newprompt').addEventListener('click', () => window.sidecar.openComposer());

  // ── refresh loop ─────────────────────────────────────────────────────
  async function refresh() {
    state.sessions = await window.sidecar.listSessions();
    renderRail();
    updateFooter();
    loadMeter();
    if (state.readingId && findSession(state.readingId) === null && !state.sessions.pinned.find(s=>s.id===state.readingId)) {
      // the session we were reading is no longer shown (window closed & unpinned)
    }
  }

  // Tell the main process when the first real layout is on screen, so the
  // window is revealed already-settled instead of appearing and reflowing.
  (async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (window.sidecar.signalReady) window.sidecar.signalReady();
  })();

  // Delegated once, since the transcript body is rebuilt wholesale on every
  // update — a listener attached to individual links would be gone the next
  // time renderTranscript() runs.
  $('#tx-body').addEventListener('click', (e) => {
    const a = e.target.closest('.md-link');
    if (!a) return;
    e.preventDefault();
    window.sidecar.openExternal(a.dataset.href);
  });

  window.sidecar.onSessionsChanged(refresh);
  window.sidecar.onSettingsChanged(applySettings);
  window.sidecar.getSettings().then(applySettings);
  refresh();
  setInterval(refresh, 6000);
  setInterval(() => { if (state.readingId) renderTranscript(state.readingId, { forceScroll: false }); }, 3000);
})();
