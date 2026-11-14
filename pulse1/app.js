/* Pulse4 web app: Send (link -> sound + QR) and Receive (mic -> link). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.Pulse;
  let ctx = null;

  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------- tabs ----------
  function show(which) {
    $('tab-send').setAttribute('aria-selected', which === 'send');
    $('tab-recv').setAttribute('aria-selected', which === 'recv');
    $('send').hidden = which !== 'send';
    $('recv').hidden = which !== 'recv';
    if (which !== 'send') stopPlaying();
    if (which !== 'recv') stopListening();
    store.set('pulse4-tab', which);
    if (which === 'send') drawScore(null);
  }
  $('tab-send').onclick = () => show('send');
  $('tab-recv').onclick = () => show('recv');

  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = parseInt(c.dataset.h, 10);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px';
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  // ---------- segmented controls ----------
  function segmented(el, options, value, onChange) {
    el.replaceChildren(...options.map(([v, label]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.v = v;
      b.setAttribute('aria-pressed', v === value);
      b.onclick = () => { for (const x of el.children) x.setAttribute('aria-pressed', x === b); onChange(v); };
      return b;
    }));
  }
  // Modes shown in the app (the engine also has 'standard', 'child' and 'whale'; add them here to bring them back)
  const VISIBLE = ['high'];
  const PLAYS = 5;
  const HINTS = {
    standard: 'Clear tones. Best in loud rooms.',
    child: 'Plays a short melody.',
    whale: 'A deep, gliding whale song.',
    high: 'The link plays near-silently at 19–20.5 kHz. Keep devices close.',
  };
  const settings = store.get('pulse4-send', { mode: VISIBLE[0], speed: 'normal' });
  if (!VISIBLE.includes(settings.mode)) settings.mode = VISIBLE[0];
  $('modeField').hidden = VISIBLE.length < 2;
  segmented($('mode'), VISIBLE.map(n => [n, P.MODES[n].label]), settings.mode, v => { settings.mode = v; changed(); });
  segmented($('speed'), [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']], settings.speed, v => { settings.speed = v; changed(); });
  function changed() { store.set('pulse4-send', settings); if (source) stopPlaying(); update(); }

  // ---------- send ----------
  let source = null, segs = null, playStart = 0, playDur = 0, raf = 0;

  // Two "staves": the hidden 19–20.5 kHz link on top, Für Elise underneath
  function drawScore(progress) {
    const c = $('score'); if (!c.clientWidth) return;
    const { g, w, h } = sizeCanvas(c);
    g.clearRect(0, 0, w, h);
    if (!segs) return;
    const m = P.MODES[segs.mode], total = P.durationMs(segs), fg = css('--fg'), muted = css('--muted');
    const split = $('melody').checked ? Math.round(h * 0.42) : h;
    const alpha = t => (progress == null || t / total <= progress ? 1 : 0.25);
    let t = 0;
    for (const s of segs) {
      const x = t / total * w, sw = Math.max(1, s.ms / total * w - 1);
      const y = split - 8 - (s.tone + 0.5) / m.numTones * (split - 16);
      g.fillStyle = s.tone >= m.START ? muted : fg; g.globalAlpha = alpha(t);
      g.fillRect(x, y - 1, sw, 2);
      t += s.ms;
    }
    if (split < h) {
      g.globalAlpha = 1; g.fillStyle = css('--line'); g.fillRect(0, split + 4, w, 1);
      const step = total / P.FUR_ELISE.steps, lo = 38, hi = 78;
      for (const [k, note, hand] of P.FUR_ELISE.notes) {
        const len = (k === 25 ? 2 : (P.FUR_ELISE.notes.find(n => n[0] > k && n[2] === hand) || [P.FUR_ELISE.steps])[0] - k) * step;
        const x = k * step / total * w, y = h - 6 - (note - lo) / (hi - lo) * (h - split - 16);
        g.globalAlpha = alpha(k * step) * (hand === 'L' ? 0.45 : 1); g.fillStyle = fg;
        g.fillRect(x, y - 2, Math.max(3, len / total * w - 2), 4);
      }
    }
    g.globalAlpha = 1;
  }

  function update() {
    $('modeHint').textContent = HINTS[settings.mode];
    try {
      segs = P.encode($('url').value.trim(), { mode: settings.mode, speed: settings.speed });
      $('sendMeta').textContent = `${(P.durationMs(segs) / 1000).toFixed(1)} s × ${PLAYS}`;
      $('sendMeta').classList.remove('err');
      $('play').disabled = false;
    } catch (e) {
      segs = null;
      $('sendMeta').textContent = e.message; $('sendMeta').classList.add('err');
      $('play').disabled = !source;
    }
    drawScore(null);
    drawQr();
  }
  $('url').addEventListener('input', () => { if (source) stopPlaying(); update(); });
  $('melody').addEventListener('change', () => { if (source) stopPlaying(); store.set('pulse4-melody', $('melody').checked); drawScore(null); });
  $('needMelody').addEventListener('change', () => store.set('pulse4-needMelody', $('needMelody').checked));
  $('melody').checked = store.get('pulse4-melody', true);
  $('needMelody').checked = store.get('pulse4-needMelody', true);

  function stopPlaying() {
    if (source) { try { source.stop(); } catch (e) {} source = null; }
    cancelAnimationFrame(raf);
    $('play').textContent = 'Play'; $('play').classList.remove('on');
    drawScore(null);
  }

  $('play').onclick = () => {
    if (source) { stopPlaying(); return; }
    update();
    if (!segs) return;
    const ac = audio();
    const m = P.MODES[settings.mode];
    if (m.freqs[m.freqs.length - 1] > ac.sampleRate * 0.47) {
      $('sendMeta').textContent = 'This device can’t play this sound.'; $('sendMeta').classList.add('err'); return;
    }
    // one buffer: the message PLAYS times with short gaps, then it stops by itself. Fixed level; use the device volume.
    const one = P.synthesize(segs, ac.sampleRate, { tailMs: 350, amplitude: $('melody').checked ? 0.75 : 1 });
    if ($('melody').checked) {
      // Für Elise, timed so the 4 bars last exactly as long as the hidden link
      const mel = P.synthesizeMelody(P.durationMs(segs), ac.sampleRate, 0.3), off = Math.round(ac.sampleRate * 0.08);
      for (let i = 0; i < mel.length && off + i < one.length; i++) one[off + i] += mel[i];
    }
    const buf = ac.createBuffer(1, one.length * PLAYS, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let k = 0; k < PLAYS; k++) data.set(one, k * one.length);
    source = ac.createBufferSource();
    source.buffer = buf;
    source.connect(ac.destination);
    source.onended = () => stopPlaying();
    source.start();
    playStart = ac.currentTime; playDur = one.length / ac.sampleRate;
    $('play').classList.add('on');
    const lead = 0.08, body = P.durationMs(segs) / 1000;
    const tick = () => {
      const el = ac.currentTime - playStart, n = Math.min(PLAYS, Math.floor(el / playDur) + 1), t = el % playDur - lead;
      $('play').textContent = `Stop · ${n}/${PLAYS}`;
      drawScore(Math.min(1, Math.max(0, t / body)));
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  // ---------- QR code (bundled library, works offline) ----------
  function qrSvg(text) {
    if (!window.qrcode) return null;
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const q = qrcode(0, 'M'); q.addData(text); q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    } catch (e) { return null; }
  }
  function drawQr() {
    const text = $('url').value.trim();
    const svg = text ? qrSvg(P.safeUrl(text) || text) : null;
    $('qr').hidden = !svg;
    $('qrBtn').innerHTML = svg || '';
    $('qrFull').firstElementChild.innerHTML = svg || '';
  }
  $('qrBtn').onclick = () => { $('qrFull').hidden = false; };
  $('qrFull').onclick = () => { $('qrFull').hidden = true; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('qrFull').hidden = true; });

  // ---------- receive ----------
  let stream = null, node = null, mic = null, decoder = null, wctx = null, frames = [], visMode = VISIBLE[0];

  function setStatus(text, err) { $('status').textContent = text; $('status').className = 'status' + (err ? ' err' : ''); }
  function setProgress(f) { $('prog').style.width = (f * 100).toFixed(1) + '%'; }

  function initWaterfall() {
    const c = $('spec'); const { g, w, h } = sizeCanvas(c);
    g.fillStyle = css('--soft'); g.fillRect(0, 0, w, h);
    wctx = { g, w, h };
  }

  function drawWaterfall() {
    if (!wctx || !frames.length) return;
    const { g, w, h } = wctx, colW = 2, dpr = window.devicePixelRatio || 1;
    const list = frames.slice(-Math.ceil(w / colW)); frames = [];
    const shift = Math.min(w, list.length * colW);
    g.drawImage(g.canvas, shift * dpr, 0, (w - shift) * dpr, h * dpr, 0, 0, w - shift, h);
    const m = P.MODES[visMode], rowH = h / m.numTones, bg = css('--soft'), fg = css('--fg'), muted = css('--muted');
    list.forEach((f, i) => {
      const x = w - shift + i * colW;
      g.globalAlpha = 1; g.fillStyle = bg; g.fillRect(x, 0, colW, h);
      for (let k = 0; k < m.numTones; k++) {
        const y = h - (k + 1) * rowH;
        if (k === f.tone) { g.globalAlpha = 1; g.fillStyle = k >= m.START ? muted : fg; }
        else { g.globalAlpha = Math.min(1, Math.log(Math.max(1, f.lv[k])) / Math.log(40)) * 0.35; g.fillStyle = fg; }
        g.fillRect(x, y + 0.5, colW, rowH - 1);
      }
    });
    g.globalAlpha = 1;
  }

  // saved links (heard while offline) and recent history, kept on the device
  const history = store.get('pulse4-history', []);
  const pending = store.get('pulse4-pending', []);

  function linkEl(text, url) {
    if (!url) { const sp = document.createElement('span'); sp.textContent = text; return sp; }
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = text; return a;
  }
  function renderHistory() {
    $('recent').hidden = history.length === 0;
    $('history').replaceChildren(...history.map(h => { const li = document.createElement('li'); li.appendChild(linkEl(h.text, P.safeUrl(h.text))); return li; }));
  }
  function renderPending() {
    const online = navigator.onLine;
    $('pending').hidden = pending.length === 0;
    $('pendingTitle').textContent = online ? 'Saved while offline' : 'Saved. Opens when you’re back online';
    $('pendingList').replaceChildren(...pending.map((p, i) => {
      const li = document.createElement('li');
      li.appendChild(linkEl(p.text, p.url));
      const go = document.createElement('button'); go.textContent = 'Open'; go.disabled = !online;
      go.onclick = () => { removePending(i); location.href = p.url; };
      const x = document.createElement('button'); x.textContent = 'Remove'; x.className = 'quiet';
      x.onclick = () => removePending(i);
      li.append(go, x);
      return li;
    }));
  }
  function removePending(i) { pending.splice(i, 1); store.set('pulse4-pending', pending); renderPending(); }
  function renderNet() { $('net').hidden = navigator.onLine; renderPending(); }

  function onMessage(text, mode, info) {
    const heard = !!(info && info.melody && info.melody.heard);
    if ($('needMelody').checked && !heard) {
      setStatus('Heard a link, but not Für Elise, so it was ignored.', true); setProgress(0);
      return;
    }
    $('resMelody').textContent = heard ? 'Played with Für Elise' : '';
    const url = P.safeUrl(text), offline = !navigator.onLine;
    setProgress(1);
    $('result').hidden = false;
    $('resUrl').textContent = text;
    $('resOpen').hidden = !url || offline;
    if (url) $('resOpen').href = url;
    setStatus(!url ? 'Received text' : offline ? 'Saved. Opens when you’re back online.' : 'Received');

    if (history[0] && history[0].text === text && Date.now() - history[0].at < 60000) return;   // a repeat of the same sound
    history.unshift({ text, mode, at: Date.now() }); history.length = Math.min(history.length, 20);
    store.set('pulse4-history', history); renderHistory();
    if (navigator.vibrate) navigator.vibrate(60);
    if (!url) return;
    if (offline) {
      if (!pending.some(p => p.url === url)) { pending.push({ text, url, at: Date.now() }); store.set('pulse4-pending', pending); }
      renderPending();
    } else if ($('auto').checked) {
      setStatus('Opening…');
      setTimeout(() => { stopListening(); location.href = url; }, 700);   // same tab, like a QR scanner
    }
  }

  window.addEventListener('offline', renderNet);
  window.addEventListener('online', () => {
    renderNet();
    if (pending.length && $('auto').checked) {
      const p = pending.shift(); store.set('pulse4-pending', pending);
      setStatus('Back online. Opening saved link…');
      setTimeout(() => { stopListening(); location.href = p.url; }, 700);
    }
  });

  async function startListening() {
    const ac = audio();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },   // voice filters would remove the tones
      });
    } catch (e) {
      setStatus(location.protocol === 'https:' || location.hostname === 'localhost' ? 'Microphone blocked' : 'Microphone needs https', true);
      return;
    }
    mic = ac.createMediaStreamSource(stream);
    node = ac.createScriptProcessor(4096, 1, 1);
    decoder = new P.MultiDecoder(ac.sampleRate, {
      onFrame: (mode, lv, tone) => { if (mode === visMode) frames.push({ lv: Float32Array.from(lv), tone }); },
      onDetect: mode => { if (mode !== visMode) { visMode = mode; initWaterfall(); } },
      onProgress: (done, total, mode) => {
        visMode = mode;
        setStatus(`Receiving · ${P.MODES[mode].label} · ${Math.round(done / total * 100)}%`);
        setProgress(done / total);
      },
      onMessage,
      onError: () => { setStatus('Missed it. Waiting for the next repeat…', true); setProgress(0); },
    }, VISIBLE);
    node.onaudioprocess = e => decoder.push(e.inputBuffer.getChannelData(0));
    mic.connect(node);
    const mute = ac.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ac.destination);
    initWaterfall();
    setStatus('Listening…'); setProgress(0);
    $('listen').textContent = 'Stop'; $('listen').classList.add('on');
    const loop = () => { drawWaterfall(); if (node) requestAnimationFrame(loop); };
    loop();
  }

  function stopListening() {
    if (node) { node.disconnect(); node.onaudioprocess = null; node = null; }
    if (mic) { mic.disconnect(); mic = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    decoder = null; frames = [];
    $('listen').textContent = 'Listen'; $('listen').classList.remove('on');
    if ($('status').textContent.startsWith('Listening')) setStatus('Microphone off');
  }
  $('listen').onclick = () => (node ? stopListening() : startListening());

  // ---------- init ----------
  const params = new URLSearchParams(location.search);
  if (params.get('url')) $('url').value = params.get('url');
  if (P.MODES[params.get('sound')]) settings.mode = params.get('sound');
  let tab = params.get('mode') || store.get('pulse4-tab', 'send');
  if (pending.length && navigator.onLine) tab = 'recv';
  show(tab === 'recv' ? 'recv' : 'send');
  for (const b of $('mode').children) b.setAttribute('aria-pressed', b.dataset.v === settings.mode);
  update();
  renderHistory(); renderNet();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('resize', () => { drawScore(null); if (wctx) initWaterfall(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { drawScore(null); if (wctx) initWaterfall(); });
})();
