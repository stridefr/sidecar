// Ellipsis at rest; loops continuously once hovered or marked active. Ported
// from the mockup — same mechanism, wrapped so it can be re-run safely every
// time the rail or reader re-renders with new content.
(function () {
  var SPEED = 38; // px per second — same rate for every title

  function groupsOf(root) {
    var out = [], seen = new Set();
    root.querySelectorAll('.srow .body, .palrow .body').forEach(function (g) {
      out.push(g);
      g.querySelectorAll('.marq').forEach(function (m) { seen.add(m); });
    });
    root.querySelectorAll('.marq').forEach(function (m) { if (!seen.has(m)) out.push(m); });
    return out;
  }
  function linesOf(g) {
    return g.classList.contains('marq') ? [g] : Array.prototype.slice.call(g.querySelectorAll('.marq'));
  }

  function wrap(el) {
    if (el.querySelector(':scope > .marq-track')) return;
    var track = document.createElement('span');
    track.className = 'marq-track';
    var first = document.createElement('span');
    first.className = 'marq-i';
    while (el.firstChild) first.appendChild(el.firstChild);
    var dup = first.cloneNode(true);
    dup.classList.add('dup');
    dup.setAttribute('aria-hidden', 'true');
    track.appendChild(first); track.appendChild(dup);
    el.appendChild(track);
  }

  function widthOf(el) {
    var track = el.querySelector(':scope > .marq-track');
    if (!track) return 0;
    var first = track.firstElementChild;
    var pt = track.style.cssText, pf = first.style.cssText;
    track.style.cssText = 'display:inline-flex;width:max-content';
    first.style.cssText = 'max-width:none;overflow:visible;text-overflow:clip';
    var w = first.scrollWidth;
    track.style.cssText = pt; first.style.cssText = pf;
    return w;
  }

  function clear(el) {
    el.classList.remove('is-over', 'go');
    el.style.removeProperty('--gap');
    el.style.removeProperty('--shift');
    el.style.removeProperty('--dur');
  }

  function measureGroup(g) {
    var lines = linesOf(g), widths = [], maxW = 0, over = false;
    lines.forEach(function (el) {
      el.classList.remove('go');
      var w = widthOf(el);
      widths.push(w);
      if (w > maxW) maxW = w;
      if (w - el.clientWidth > 2) over = true;
    });
    if (!over) { lines.forEach(clear); return; }

    var box = lines[0].clientWidth || 200;
    var base = Math.max(20, Math.min(32, Math.round(box * 0.13)));
    var span = maxW + base;

    lines.forEach(function (el, i) {
      el.classList.add('is-over');
      el.style.setProperty('--gap', (span - widths[i]) + 'px');
      el.style.setProperty('--shift', (-span) + 'px');
      el.style.setProperty('--dur', (span / SPEED).toFixed(2) + 's');
    });
  }

  function armed(el) {
    var row = el.closest('.srow, .palrow, .ctarget, .txhead, .mini');
    if (!row) return false;
    if (row.matches(':hover')) return true;
    return row.classList.contains('reading') || row.classList.contains('sending') || row.classList.contains('sel');
  }

  var bound = false;
  function bindGlobalHoverOnce() {
    if (bound) return;
    bound = true;
    var tick = function () {
      document.querySelectorAll('.marq.is-over').forEach(function (el) {
        el.classList.toggle('go', armed(el));
      });
    };
    document.addEventListener('mouseover', tick);
    document.addEventListener('mouseout', tick);
  }

  function refresh(root) {
    root = root || document;
    var all = Array.prototype.slice.call(root.querySelectorAll('.marq'));
    all.forEach(wrap);
    groupsOf(root).forEach(measureGroup);
    bindGlobalHoverOnce();
  }

  window.SidecarMarquee = { refresh: refresh };
})();
