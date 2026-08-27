// Speech-to-text, shared by the pop-up prompt box and the main window's
// reader input.
//
// This uses the Web Speech API, which is present in Electron's Chromium but
// is not guaranteed to have a working backend — some builds expose the object
// and then fail on start. So this never pretends: if the API is missing or
// errors, the button is disabled or the failure is reported, with Win+H named
// as the fallback that always works on Windows.
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
