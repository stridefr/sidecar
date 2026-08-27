// Speech-to-text, shared by the pop-up prompt box and the main window's
// reader input.
//
// This uses the Web Speech API — and in Electron, that API's 'network' error
// is not a flaky connection to retry. Chromium's built-in speech recognition
// calls a Google endpoint that requires a private API key baked into official
// Google Chrome; Electron's bundled Chromium doesn't have one, so every
// attempt fails the same way regardless of whether the machine is online.
// It's a permanent limitation of this approach, not an intermittent fault —
// so the button disables itself after the first one rather than inviting
// another try that cannot succeed, and Win+H (Windows' own dictation, which
// doesn't go through this API at all) is named as the real fallback.
(function () {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

  function isSupported() { return !!Ctor; }

  // opts: { button, label, getText, setText, onError, onState }
  function attach(opts) {
    const { button, label, getText, setText, onError, onState } = opts;
    if (!button) return null;

    if (!Ctor) {
      button.disabled = true;
      button.title = 'Dictation is not available in this build — press Win+H instead.';
      return null;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    let listening = false;
    let base = '';

    const paint = () => {
      button.classList.toggle('listening', listening);
      if (label) label.textContent = listening ? 'Listening…' : 'Dictate';
      if (onState) onState(listening);
    };

    rec.onstart = () => { base = getText() || ''; listening = true; paint(); };
    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      setText((base + ' ' + final + interim).trim());
      if (final) base = (base + ' ' + final).trim();
    };
    rec.onerror = (e) => {
      listening = false; paint();
      if (!onError) return;
      if (e.error === 'not-allowed') onError('Microphone access was blocked. Allow it for Sidecar, or press Win+H instead.');
      else if (e.error === 'no-speech') onError('Didn’t catch anything — try again.');
      else onError('Dictation stopped (' + e.error + '). Press Win+H instead.');
    };
    rec.onend = () => { listening = false; paint(); };

    button.addEventListener('click', () => {
      if (listening) { rec.stop(); return; }
      try { rec.start(); }
      catch (err) { if (onError) onError('Could not start dictation. Press Win+H instead.'); }
    });

    return { stop: () => { try { rec.stop(); } catch (e) {} }, isListening: () => listening };
  }

  window.SidecarDictation = { attach, isSupported };
})();
