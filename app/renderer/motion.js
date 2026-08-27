// Decides whether animations run, and is the only thing that should.
//
// Chromium reports `prefers-reduced-motion: reduce` whenever Windows'
// "Animation effects" switch is off. That switch gets turned off for two very
// different reasons — motion sensitivity, and wanting a snappier machine — so
// treating it as an absolute veto (the CSS media query used to) left anyone in
// the second group with a dead, static app and no way to opt back in.
//
// So: 'auto' follows the system, and is the default, which keeps first-run
// behaviour respectful. 'on' and 'off' are explicit user overrides that win.
(function () {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let mode = 'auto';

  function resolve(m) {
    if (m === 'on') return true;
    if (m === 'off') return false;
    return !mq.matches;
  }

  function paint() {
    const on = resolve(mode);
    document.body.classList.toggle('no-anim', !on);
    // Main process needs this too, for the composer's window-height tween —
    // it has no way to read a CSS media query on its own.
    if (window.sidecar && window.sidecar.reportReducedMotion) {
      window.sidecar.reportReducedMotion(mq.matches);
    }
    return on;
  }

  function apply(m) {
    mode = m || 'auto';
    return paint();
  }

  // If the system preference flips while we're open, 'auto' should follow it.
  const onChange = () => { if (mode === 'auto') paint(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);

  window.SidecarMotion = { apply, resolve, systemPrefersReduced: () => mq.matches };
})();
