/* Pulse10 web app: Send (link -> sound + classical music), Receive (mic -> link) and QR (big, for a projector). */
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
    for (const t of ['send', 'recv', 'qr']) $('tab-' + t).setAttribute('aria-selected', which === t);
    $('send').hidden = which !== 'send';
    $('recv').hidden = which !== 'recv';
    $('qrtab').hidden = which !== 'qr';
    if (which === 'recv') stopPlaying();   // the sound keeps going on the QR tab, so a projector can show both
    if (which !== 'recv') stopListening();
    if (which !== 'qr') unproject();
    store.set('pulse10-tab', which === 'recv' ? 'recv' : 'send');
    if (which === 'send') drawScore(null);
  }
  $('tab-send').onclick = () => show('send');
  $('tab-recv').onclick = () => show('recv');
  $('tab-qr').onclick = () => { show('qr'); project(); };   // the tab click counts as the gesture full screen needs

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
  // Modes shown in the app (the engine also has 'high' (Pulse3–8's 19–20.5 kHz sound), 'standard', 'child' and
  // 'whale'; add them here to bring them back)
  const VISIBLE = ['loud'];
  const PLAYS = 5;
  const HINTS = {
    standard: 'Clear tones. Best in loud rooms.',
    child: 'Plays a short melody.',
    whale: 'A deep, gliding whale song.',
    high: 'The link plays near-silently at 19–20.5 kHz. Keep devices close.',
    loud: 'Silent 19.5–20.65 kHz tones at full volume. Fast is shortest; Normal carries further.',
  };
  const settings = store.get('pulse10-send', { mode: VISIBLE[0], speed: 'fast' });
  if (!VISIBLE.includes(settings.mode)) settings.mode = VISIBLE[0];
  $('modeField').hidden = VISIBLE.length < 2;
  segmented($('mode'), VISIBLE.map(n => [n, P.MODES[n].label]), settings.mode, v => { settings.mode = v; changed(); });
  segmented($('speed'), [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']], settings.speed, v => { settings.speed = v; changed(); });
  function changed() { store.set('pulse10-send', settings); if (source) stopPlaying(); update(); }

  // music: off by default. On, a piece is picked to fit the link ("Another piece" steps through the others).
  // The receiver needs no setting: it takes links with or without music.
  let musicOn = store.get('pulse10-musicOn', false) === true;
  segmented($('music'), [['off', 'No music'], ['on', 'Music']], musicOn ? 'on' : 'off', v => { musicOn = v === 'on'; store.set('pulse10-musicOn', musicOn); if (source) stopPlaying(); update(); });
  const musicOpt = () => (musicOn ? 'auto' : 0);

  // ---------- send ----------
  let source = null, parts = null, segs = null, playStart = 0, playDur = 0, raf = 0;

  // The whole play as two "staves": every part of the hidden 19–20.5 kHz link on top, the music underneath
  function drawScore(progress) {
    const c = $('score'); if (!c.clientWidth) return;
    const { g, w, h } = sizeCanvas(c);
    g.clearRect(0, 0, w, h);
    if (!parts) return;
    const L = P.playLayout(parts), total = L.ms, p = P.PIECES[parts[0].piece], m = P.MODES[parts[0].mode];
    const fg = css('--fg'), muted = css('--muted');
    const split = p ? Math.round(h * 0.42) : h;
    const alpha = t => (progress == null || t / total <= progress ? 1 : 0.25);
    parts.forEach((segs, i) => {
      let t = L.starts[i] + 80;
      for (const s of segs) {
        const x = t / total * w, sw = Math.max(1, s.ms / total * w - 1);
        const y = split - 8 - (s.tone + 0.5) / m.numTones * (split - 16);
        g.fillStyle = s.tone >= m.START ? muted : fg; g.globalAlpha = alpha(t);
        g.fillRect(x, y - 1, sw, 2);
        t += s.ms;
      }
    });
    if (p) {
      g.globalAlpha = 1; g.fillStyle = css('--line'); g.fillRect(0, split + 4, w, 1);
      const step = total / p.steps, ns = p.notes.map(n => n[1]), lo = Math.min(...ns) - 2, hi = Math.max(...ns) + 2;
      p.notes.forEach(([k, note, hand], i) => {
        const len = P.noteLen(p, i) * step;
        const x = k * step / total * w, y = h - 6 - (note - lo) / (hi - lo) * (h - split - 16);
        g.globalAlpha = alpha(k * step) * (hand === 'L' ? 0.45 : 1); g.fillStyle = fg;
        g.fillRect(x, y - 2, Math.max(2, len / total * w - 1), 3);
      });
    }
    g.globalAlpha = 1;
  }

  const fmt = s => s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;

  // ---------- shorter links ----------
  // Links over SHORTEN_AT characters are swapped for an is.gd short link when online (the QR keeps the full link).
  // Every link is also packed tighter by the engine, which needs no internet.
  const SHORTEN_AT = 45;
  const shortCache = new Map();   // long link -> short link, or a pending promise
  let jsonp = 0, shortTimer = 0;
  function shortenOnline(url) {
    return new Promise(resolve => {
      const cb = '__pulseShort' + (++jsonp), sc = document.createElement('script');
      const done = v => { clearTimeout(t); delete window[cb]; sc.remove(); resolve(v); };
      const t = setTimeout(() => done(null), 5000);
      window[cb] = d => done(d && typeof d.shorturl === 'string' && /^https:\/\/is\.gd\/[A-Za-z0-9_]+$/.test(d.shorturl) ? d.shorturl : null);
      sc.onerror = () => done(null);
      sc.src = 'https://is.gd/create.php?format=json&callback=' + cb + '&url=' + encodeURIComponent(url);
      document.head.appendChild(sc);
    });
  }
  const wantsShort = text => $('shorten').checked && text.length > SHORTEN_AT && P.QUICK.indexOf(text) < 0 && !!P.safeUrl(text) && !/^https:\/\/is\.gd\//.test(text);
  function requestShort(text) {
    if (shortCache.has(text) || !navigator.onLine) return shortCache.get(text);
    const p = shortenOnline(text).then(v => {
      if (v) shortCache.set(text, v); else shortCache.delete(text);
      if ($('url').value.trim() === text && !source) update();
      return v;
    });
    shortCache.set(text, p);
    return p;
  }
  // what actually gets played for the link in the box
  function sendText() {
    const text = $('url').value.trim(), v = wantsShort(text) ? shortCache.get(text) : null;
    return typeof v === 'string' ? v : text;
  }
  $('shorten').checked = store.get('pulse10-shorten', true);
  $('shorten').addEventListener('change', () => { store.set('pulse10-shorten', $('shorten').checked); if (source) stopPlaying(); update(); });


  let shuffle = 0;
  const MAX_PLAY_S = 20;     // one play should stay under this; shortening long links keeps it there
  const MAX_TOTAL_S = 180;   // and all 5 plays under 3 minutes (a lecturer shouldn't have to wait)
  $('another').onclick = () => { shuffle++; if (source) stopPlaying(); update(); };

  function update() {
    $('modeHint').textContent = HINTS[settings.mode];
    const typed = $('url').value.trim();
    if (wantsShort(typed) && !shortCache.has(typed) && navigator.onLine) {
      clearTimeout(shortTimer); shortTimer = setTimeout(() => requestShort(typed), 700);
    }
    try {
      const text = sendText();
      parts = P.encodeParts(text, { mode: settings.mode, speed: settings.speed, music: musicOpt(), shuffle });
      segs = parts[0];
      const quick = P.QUICK.indexOf(text) >= 0;
      $('linkHint').textContent = quick ? 'Built-in link: sent as a tiny code.'
        : text !== typed ? `Sent as ${text.replace('https://', '')}`
        : wantsShort(typed) ? (navigator.onLine ? 'Shortening…' : 'Offline: sent in full.') : '';
      const name = P.pieceName(segs.piece), L = P.playLayout(parts), one = L.ms / 1000;
      const pc = P.PIECES[segs.piece], natural = pc ? pc.steps * pc.natural : 0;
      const tempo = !pc ? '' : one * 1000 > natural * 1.15 ? ', played a little slower' : one * 1000 < natural * 0.85 ? ', played a little faster' : '';
      $('musicHint').textContent = !name ? '' : `${name} (${pc.composer})${tempo}.`;
      const over = one > MAX_PLAY_S || one * PLAYS > MAX_TOTAL_S;
      $('sendMeta').textContent = `${fmt(one)} per play, ${PLAYS} plays` + (parts.length > 1 ? ` · ${parts.length} parts` : '') +
        (over ? ` · too long: ${wantsShort(typed) && !navigator.onLine ? 'go online to shorten it' : 'use a shorter link'}` : '');
      $('sendMeta').classList.toggle('err', over);
      $('another').hidden = !musicOn;
      $('play').disabled = false;
      if (!source) $('play').textContent = 'Play';
    } catch (e) {
      segs = null; parts = null; $('musicHint').textContent = ''; $('linkHint').textContent = ''; $('another').hidden = true;
      const empty = !$('url').value.trim();   // nothing typed yet is not an error
      $('sendMeta').textContent = empty ? '' : e.message; $('sendMeta').classList.toggle('err', !empty);
      $('play').disabled = !source;
    }
    drawScore(null);
    drawQr();
  }
  $('url').addEventListener('input', () => { if (source) stopPlaying(); update(); });

  function stopPlaying() {
    if (source) { try { source.stop(); } catch (e) {} source = null; }
    cancelAnimationFrame(raf);
    $('play').textContent = 'Play'; $('play').classList.remove('on'); $('play').disabled = false;
    $('play2').textContent = 'Play sound'; $('qrNow').textContent = '';
    if (parts) segs = parts[0];
    drawScore(null);
  }

  $('play').onclick = togglePlay;
  $('play2').onclick = togglePlay;
  async function togglePlay() {
    if (source) { stopPlaying(); update(); return; }
    const ac = audio();   // inside the tap, so the browser allows sound
    const typed = $('url').value.trim();
    if (wantsShort(typed) && navigator.onLine) {
      const pending = requestShort(typed);
      if (pending && typeof pending.then === 'function') {
        $('play').disabled = true; $('play').textContent = 'Shortening…';
        await pending; $('play').disabled = false; $('play').textContent = 'Play';
      }
    }
    update();
    if (!segs || source) return;
    const m = P.MODES[settings.mode];
    if (m.freqs[m.freqs.length - 1] > ac.sampleRate * 0.47) {
      $('sendMeta').textContent = 'This device can’t play this sound.'; $('sendMeta').classList.add('err'); return;
    }
    startSound([P.renderPlay(parts, ac.sampleRate)], PLAYS);
  }

  // plays: one or more rendered plays (all the same length), played back to back, the whole set `loops` times
  function startSound(plays, loops) {
    const ac = audio(), len = plays[0].length;
    const buf = ac.createBuffer(1, len * plays.length, ac.sampleRate);
    plays.forEach((x, k) => buf.copyToChannel(x, 0, k * len));
    const total = plays.length * loops;
    source = ac.createBufferSource();
    source.buffer = buf; source.loop = loops > 1;
    source.connect(ac.destination);
    source.onended = () => { stopPlaying(); update(); };
    playStart = ac.currentTime + 0.05; playDur = len / ac.sampleRate;
    source.start(playStart);
    source.stop(playStart + playDur * total);
    $('play').classList.add('on'); $('play').disabled = false;
    const { starts } = P.playLayout(parts);
    segs = parts[0];
    const tick = () => {
      if (!source) return;
      const el = Math.max(0, ac.currentTime - playStart), n = Math.min(total, Math.floor(el / playDur) + 1), tms = (el % playDur) * 1000;
      let k = 0; while (k + 1 < parts.length && tms >= starts[k + 1]) k++;
      if (segs !== parts[k]) segs = parts[k];
      $('play').textContent = `Stop · ${n}/${total}` + (parts.length > 1 ? ` · part ${k + 1}/${parts.length}` : '');
      $('play2').textContent = 'Stop sound';
      const name = P.pieceName(segs.piece);
      $('qrNow').textContent = `Playing ${n}/${total}` + (name ? ` · ${name}` : '') + ' · listen or scan';
      drawScore(Math.min(1, tms / (playDur * 1000)));
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

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
    $('qrEmpty').textContent = 'Type a link on Send first.';
    $('qrBig').innerHTML = svg || '';
    $('qrLink').textContent = svg ? text.replace(/^https?:\/\//, '') : '';
    $('stage').hidden = !svg; $('qrEmpty').hidden = !!svg; $('project').disabled = !svg;
  }
  // projector view: the browser's full screen where it exists (laptops, Android), a full-window view otherwise (iPhone)
  function project() {
    if ($('stage').hidden) return;
    $('stage').classList.add('full');
    const el = $('stage'), req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req && !document.fullscreenElement) { try { const r = req.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
  }
  function unproject() {
    $('stage').classList.remove('full');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  $('project').onclick = project;
  $('stage').onclick = () => { if ($('stage').classList.contains('full')) unproject(); };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('stage').classList.remove('full'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') unproject(); });

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
  const history = store.get('pulse10-history', []);
  const pending = store.get('pulse10-pending', []);

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
  function removePending(i) { pending.splice(i, 1); store.set('pulse10-pending', pending); renderPending(); }
  function renderNet() { $('net').hidden = navigator.onLine; renderPending(); }

  function onMessage(text, mode, info) {
    const heard = !!(info && info.melody && info.melody.heard), name = heard ? info.melody.name : '';
    const b = info && info.special;
    if (!b) { accept(text, mode, name); return; }
    if (b[0] === P.LIVE) {   // a room-only link (the engine still understands them): refuse recordings
      let r; try { r = P.readLive(b); } catch (e) { return; }
      if (Math.abs(r.ageS) > P.LIVE_GRACE_S) { setStatus('Heard an old recording of a room-only link. Ignored.', true); setProgress(0); return; }
      accept(r.text, mode, name, 'Room only, heard live');
    }
  }

  // ---------- signal meter (range test) ----------
  // How far the loudest tone stands above the background, in dB. Walk away from a playing phone and watch it.
  // The levels come from the simulated range tests (test/range.test.js), not from real halls.
  const METER = { good: 20, ok: 12 };
  let meterDb = 0;
  function drawMeter() {
    const db = node ? meterDb : 0;
    $('meterBar').style.width = Math.min(100, Math.max(0, db / 40 * 100)).toFixed(0) + '%';
    $('meterText').textContent = !node ? '' : db < 6 ? 'Signal: none' :
      `Signal ${Math.round(db)} dB · ${db >= METER.good ? 'strong' : db >= METER.ok ? 'good' : 'weak'}`;
  }

  function accept(text, mode, name, note = '') {
    $('resMelody').innerHTML = [note, name ? `Played with ${name}` : ''].filter(Boolean).join(' · ');
    const url = P.safeUrl(text), offline = !navigator.onLine;
    setProgress(1);
    $('result').hidden = false;
    $('resUrl').textContent = text;
    $('resOpen').hidden = !url || offline;
    if (url) $('resOpen').href = url;
    setStatus(!url ? 'Received text' : offline ? 'Saved. Opens when you’re back online.' : 'Received');

    if (history[0] && history[0].text === text && Date.now() - history[0].at < 60000) return;   // a repeat of the same sound
    history.unshift({ text, mode, at: Date.now() }); history.length = Math.min(history.length, 20);
    store.set('pulse10-history', history); renderHistory();
    if (navigator.vibrate) navigator.vibrate(60);
    if (!url) return;
    if (offline) {
      if (!pending.some(p => p.url === url)) { pending.push({ text, url, at: Date.now() }); store.set('pulse10-pending', pending); }
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
      const p = pending.shift(); store.set('pulse10-pending', pending);
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
      onFrame: (mode, lv, tone, db) => { if (mode === visMode) { frames.push({ lv: Float32Array.from(lv), tone }); meterDb = db; } },
      onDetect: mode => { if (mode !== visMode) { visMode = mode; initWaterfall(); } },
      onPart: ({ index, count, have }) => {
        if (count > 1 && have < count) { setStatus(`Part ${have}/${count}. Keep listening…`); setProgress(have / count); }
      },
      onProgress: (done, total, mode, info) => {
        if (info && info.count > 1) {
          setStatus(`Part ${info.index + 1}/${info.count} · ${Math.round(done / total * 100)}%`);
          return;
        }
        visMode = mode;
        setStatus(`Receiving · ${Math.round(done / total * 100)}%`);
        setProgress(done / total);
      },
      onMessage,
      onError: () => { setStatus('Missed it. Waiting for the next play…', true); setProgress(0); },
    }, VISIBLE);
    node.onaudioprocess = e => decoder.push(e.inputBuffer.getChannelData(0));
    mic.connect(node);
    const mute = ac.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ac.destination);
    initWaterfall();
    setStatus('Listening…'); setProgress(0);
    $('listen').textContent = 'Stop'; $('listen').classList.add('on');
    const loop = () => { drawWaterfall(); drawMeter(); if (node) requestAnimationFrame(loop); };
    loop();
  }

  function stopListening() {
    if (node) { node.disconnect(); node.onaudioprocess = null; node = null; }
    if (mic) { mic.disconnect(); mic = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    decoder = null; frames = []; meterDb = 0; drawMeter();
    $('listen').textContent = 'Listen'; $('listen').classList.remove('on');
    if ($('status').textContent.startsWith('Listening')) setStatus('Microphone off');
  }
  $('listen').onclick = () => (node ? stopListening() : startListening());

  // ---------- init ----------
  const params = new URLSearchParams(location.search);
  if (params.get('url')) $('url').value = params.get('url');
  if (P.MODES[params.get('sound')]) settings.mode = params.get('sound');
  let tab = params.get('mode') || store.get('pulse10-tab', 'send');
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
