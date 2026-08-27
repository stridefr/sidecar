// Slash-command autocomplete, shared by the pop-up prompt box and the main
// window's inline input — mirrors Claude Code's own "/" menu. Built-ins are
// a static list (they're part of the CLI, not the project); custom commands
// come from the target session's own project .claude/commands and
// .claude/skills over IPC, cached per session since that's a disk scan.
(function () {
  const BUILTIN_COMMANDS = [
    { name: '/model', description: 'Switch or view the active model', argumentHint: '[model]' },
    { name: '/effort', description: 'Set or view reasoning effort', argumentHint: '[level|auto|status]' },
    { name: '/memory', description: 'Open persistent memory files' },
    { name: '/context', description: 'Show context window usage', argumentHint: '[all]' },
    { name: '/compact', description: 'Compact the conversation history', argumentHint: '[instructions]' },
    { name: '/clear', description: 'Start a new session', argumentHint: '[name]' },
    { name: '/resume', description: 'Resume a previous session' },
    { name: '/branch', description: 'Branch the session', argumentHint: '[name]' },
    { name: '/fork', description: 'Fork the session with a new prompt', argumentHint: '[prompt]' },
    { name: '/cd', description: 'Change working directory', argumentHint: '<path>' },
    { name: '/diff', description: 'Show pending changes' },
    { name: '/init', description: 'Generate a CLAUDE.md for this project' },
    { name: '/permissions', description: 'View or edit tool permissions' },
    { name: '/mcp', description: 'Manage MCP servers', argumentHint: '[...]' },
    { name: '/config', description: 'View or set config', argumentHint: '[key=value ...]' },
    { name: '/status', description: 'Show session status' },
    { name: '/usage', description: 'Show usage and cost' },
    { name: '/help', description: 'Show help' },
    { name: '/copy', description: 'Copy a previous response', argumentHint: '[N]' },
    { name: '/export', description: 'Export the conversation', argumentHint: '[filename]' },
    { name: '/btw', description: 'Ask a side question without derailing the task', argumentHint: '[question]' },
    { name: '/color', description: 'Set the terminal accent color', argumentHint: '[color|default]' },
    { name: '/background', description: 'Run a task in the background', argumentHint: '[prompt]' },
    { name: '/exit', description: 'Exit Claude Code' },
    { name: '/batch', description: 'Run a batch of independent tasks' },
    { name: '/code-review', description: 'Review the current branch or a PR' },
    { name: '/security-review', description: 'Run a security-focused review' },
    { name: '/plan', description: 'Draft an implementation plan', argumentHint: '[description]' },
    { name: '/goal', description: 'Set or clear a standing goal', argumentHint: '[condition|clear]' },
    { name: '/tasks', description: 'Show the task list' },
    { name: '/verify', description: 'Verify recent work' },
    { name: '/debug', description: 'Debug an issue' },
    { name: '/doctor', description: 'Diagnose the Claude Code install' },
    { name: '/loop', description: 'Repeat a task on an interval', argumentHint: '[interval]' },
  ];

  const customCache = new Map(); // sessionId -> resolved custom command list

  async function loadCustom(sessionId) {
    if (!sessionId) return [];
    if (customCache.has(sessionId)) return customCache.get(sessionId);
    let list = [];
    try { list = await window.sidecar.getSlashCommands(sessionId); } catch (e) { list = []; }
    customCache.set(sessionId, list);
    return list;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // opts: { textarea, insertBefore, getSessionId, onChange }
  // insertBefore: the sibling element the dropdown is inserted directly
  // above, in normal document flow (so it pushes the host's own resize
  // logic the same way the existing screenshot-strip does, rather than
  // floating over content that may be in a scrolling/clipped container).
  function attach(opts) {
    const { textarea, insertBefore, getSessionId, onChange } = opts;
    let pop = null, items = [], selected = 0;

    function close() {
      if (!pop) return;
      pop.remove();
      pop = null;
      if (onChange) onChange();
    }

    // Only fires for a single in-progress command word starting the field —
    // same trigger shape as Claude Code's own menu. A "/" appearing anywhere
    // else (mid-sentence, a pasted path) is left alone.
    function currentToken() {
      const m = textarea.value.match(/^\/([a-zA-Z0-9_-]*)$/);
      return m ? m[1] : null;
    }

    async function refresh() {
      const token = currentToken();
      if (token === null) { close(); return; }

      const custom = await loadCustom(getSessionId());
      if (currentToken() === null) return; // input moved on while that IPC call was in flight

      const f = token.toLowerCase();
      items = [...custom, ...BUILTIN_COMMANDS].filter((c) => c.name.slice(1).toLowerCase().startsWith(f)).slice(0, 8);
      selected = 0;

      if (!items.length) { close(); return; }
      render();
    }

    function render() {
      if (!pop) {
        pop = document.createElement('div');
        pop.className = 'slashdrop';
        insertBefore.parentElement.insertBefore(pop, insertBefore);
      }
      pop.innerHTML = items.map((c, i) => `
        <div class="slashrow${i === selected ? ' sel' : ''}" data-i="${i}">
          <span class="nm">${escapeHtml(c.name)}</span>
          ${c.argumentHint ? `<span class="hint">${escapeHtml(c.argumentHint)}</span>` : ''}
          <span class="desc">${escapeHtml(c.description || '')}</span>
        </div>`).join('');
      pop.querySelectorAll('.slashrow').forEach((row) => {
        // mousedown, not click: fires before the textarea's blur, so
        // selection lands before the dropdown would otherwise close.
        row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(+row.dataset.i); });
      });
      if (onChange) onChange();
    }

    function pick(i) {
      const c = items[i];
      if (!c) return;
      textarea.value = c.name + ' ';
      close();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    textarea.addEventListener('input', refresh);
    textarea.addEventListener('blur', () => setTimeout(close, 120)); // lets a row's mousedown land first

    // Capture phase, so this claims Enter/Escape/arrows before the host
    // surface's own bubble-phase keydown handler sees them — the menu can
    // then work on both composer.js and renderer.js without either needing
    // to know it exists.
    textarea.addEventListener('keydown', (e) => {
      if (!pop || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); selected = (selected + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); selected = (selected - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(selected); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);

    return { close };
  }

  window.SidecarSlash = { attach };
})();
