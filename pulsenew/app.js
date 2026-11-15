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
    for (const t of ['send', 'recv', 'qr', 'secure']) $('tab-' + t).setAttribute('aria-selected', which === t);
    $('send').hidden = which !== 'send';
    $('recv').hidden = which !== 'recv';
    $('qrtab').hidden = which !== 'qr';
    $('secure').hidden = which !== 'secure';
    if (which === 'secure') ensureKeys();
    if (which === 'recv') stopPlaying();   // the sound keeps going on the QR tab, so a projector can show both
    if (which !== 'recv') stopListening();
    if (which !== 'qr') unproject();
    store.set('pulse10-tab', which === 'recv' ? 'recv' : 'send');
    if (which === 'send') drawScore(null);
  }
  $('tab-send').onclick = () => show('send');
  $('tab-recv').onclick = () => show('recv');
  $('tab-secure').onclick = () => show('secure');
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
  const NUDGE_AFTER = 3;   // full pulses sent at the fast speed before suggesting the slow one
  const HINTS = {
    standard: 'Clear tones. Best in loud rooms.',
    child: 'Plays a short melody.',
    whale: 'A deep, gliding whale song.',
    high: 'The link plays near-silently at 19–20.5 kHz. Keep devices close.',
    loud: 'Silent 19.5–20.65 kHz tones at full volume.',
  };
  // two speeds in the app: fast (default) and slow (the engine's 'normal' is still decoded, just not offered)
  const settings = store.get('pulse10-send', { mode: VISIBLE[0], speed: 'fast' });
  if (!VISIBLE.includes(settings.mode)) settings.mode = VISIBLE[0];
  if (settings.speed !== 'slow') settings.speed = 'fast';
  $('modeField').hidden = VISIBLE.length < 2;
  segmented($('mode'), VISIBLE.map(n => [n, P.MODES[n].label]), settings.mode, v => { settings.mode = v; changed(); });
  $('slow').checked = settings.speed === 'slow';
  $('slow').addEventListener('change', () => { settings.speed = $('slow').checked ? 'slow' : 'fast'; changed(); });
  // Pulse 3 times: stop by itself after 3 pulses (a class) instead of looping until stopped
  const THREE = 3;
  $('three').checked = settings.three === true;
  $('three').addEventListener('change', () => { settings.three = $('three').checked; changed(); });
  // a change while pulsing restarts the pulse with the new setting (the click is the gesture sound needs)
  function changed() {
    store.set('pulse10-send', settings); hideNudge();
    if (source) { stopPlaying(); togglePlay(); } else update();
  }

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
  const MAX_PLAY_S = 20;     // one pulse should stay under this; shortening long links keeps it there
  const MAX_SIGNED_S = 40;   // a signed pulse carries 101 more bytes (about 21 s at the fast speed)
  $('another').onclick = () => { shuffle++; if (source) stopPlaying(); update(); };

  const encodeOpts = () => ({ mode: settings.mode, speed: settings.speed, music: musicOpt(), shuffle });

  function update() {
    $('modeHint').textContent = HINTS[settings.mode];
    const typed = $('url').value.trim();
    if (wantsShort(typed) && !shortCache.has(typed) && navigator.onLine) {
      clearTimeout(shortTimer); shortTimer = setTimeout(() => requestShort(typed), 700);
    }
    try {
      const text = sendText();
      parts = P.encodeParts(text, encodeOpts());   // also throws for an empty or oversized link
      // signed: the real bytes are made when Play is pressed (signing is async). This stand-in has the same
      // length and the same first part, so the time, the chart and the piece of music come out the same.
      const signed = signing();
      if (signed) parts = P.encodeParts(null, { ...encodeOpts(), payload: [P.SIGNED, ...keys.publicRaw, 0, 0, 0, 0, ...P.packMessage(text), ...new Array(64).fill(0)] });
      segs = parts[0];
      const quick = P.QUICK.indexOf(text) >= 0;
      $('linkHint').textContent = quick ? 'Built-in link: sent as a tiny code.'
        : text !== typed ? `Sent as ${text.replace('https://', '')}`
        : wantsShort(typed) ? (navigator.onLine ? 'Shortening…' : 'Offline: sent in full.') : '';
      const name = P.pieceName(segs.piece), L = P.playLayout(parts), one = L.ms / 1000;
      const pc = P.PIECES[segs.piece], natural = pc ? pc.steps * pc.natural : 0;
      const tempo = !pc ? '' : one * 1000 > natural * 1.15 ? ', played a little slower' : one * 1000 < natural * 0.85 ? ', played a little faster' : '';
      $('musicHint').textContent = !name ? '' : `${name} (${pc.composer})${tempo}.`;
      const over = one > (signed ? MAX_SIGNED_S : MAX_PLAY_S);
      $('sendMeta').textContent = `${fmt(one)} per pulse` + (parts.length > 1 ? ` · ${parts.length} parts` : '') +
        (signed ? ' · signed (signed pulses take longer)' : '') +
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
    $('play').textContent = 'Play'; $('play').classList.remove('on', 'wave'); $('play').disabled = false;
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
    if (signOn) await ensureKeys();   // never play unsigned just because the key was still loading
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
    if (signing()) {   // sign now: the time in the message is the moment Play was pressed, the same for every loop
      let bytes;
      try { bytes = await S.signMessage(sendText(), keys, Date.now()); }
      catch (e) { $('sendMeta').textContent = 'Couldn’t sign this pulse.'; $('sendMeta').classList.add('err'); return; }
      if (source) return;
      parts = P.encodeParts(null, { ...encodeOpts(), payload: bytes }); segs = parts[0];
    }
    startSound(P.renderPlay(parts, ac.sampleRate));
  }

  // "Pulsing. Click to stop." with each character in its own span, so the CSS wave can run along it
  function waveLabel(el, text) {
    el.replaceChildren(...[...text].map((ch, i) => { const s = document.createElement('span'); s.textContent = ch; s.style.setProperty('--i', i); return s; }));
    el.classList.add('wave');
  }

  // one rendered pulse, looped until stopped
  function startSound(play) {
    const ac = audio(), len = play.length;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    buf.copyToChannel(play, 0, 0);
    const me = source = ac.createBufferSource();
    source.buffer = buf; source.loop = true;
    source.connect(ac.destination);
    source.onended = () => {
      if (source !== me) return;   // a stopped old pulse must not stop a new one
      stopPlaying(); update();
      if (settings.three && settings.speed === 'fast' && !nudged) showNudge();   // 3 pulses done: suggest slow if they missed it
    };
    playStart = ac.currentTime + 0.05; playDur = len / ac.sampleRate;
    source.start(playStart);
    if (settings.three) source.stop(playStart + playDur * THREE);
    $('play').classList.add('on'); $('play').disabled = false;
    waveLabel($('play'), 'Pulsing. Click to stop.');
    $('play2').textContent = 'Stop sound';
    const { starts } = P.playLayout(parts);
    segs = parts[0];
    const tick = () => {
      if (source !== me) return;
      const el = Math.max(0, ac.currentTime - playStart), n = Math.floor(el / playDur) + 1, tms = (el % playDur) * 1000;
      let k = 0; while (k + 1 < parts.length && tms >= starts[k + 1]) k++;
      if (segs !== parts[k]) segs = parts[k];
      const name = P.pieceName(segs.piece);
      $('qrNow').textContent = `Pulse ${n}` + (name ? ` · ${name}` : '') + ' · listen or scan';
      if (!settings.three && n > NUDGE_AFTER && settings.speed === 'fast' && !nudged) showNudge();
      drawScore(Math.min(1, tms / (playDur * 1000)));
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // after NUDGE_AFTER full fast pulses, suggest the slow one (once per page, and never while already slow)
  let nudged = false;
  function showNudge() { nudged = true; $('nudge').hidden = false; }
  function hideNudge() { $('nudge').hidden = true; }
  $('nudgeClose').onclick = hideNudge;
  $('nudgeSlow').onclick = () => { $('slow').checked = true; $('slow').dispatchEvent(new Event('change')); };

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
    $('qrWords').textContent = svg && signing() ? `Signed by ${myWords}` : '';
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
    const c = $('spec'); if (!c) return;   // the waterfall canvas is optional (the Receive tab shows the logo instead)
    const { g, w, h } = sizeCanvas(c);
    g.fillStyle = css('--soft'); g.fillRect(0, 0, w, h);
    wctx = { g, w, h };
  }

  function drawWaterfall() {
    if (!wctx) { frames = []; return; }
    if (!frames.length) return;
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
    $('history').replaceChildren(...history.map((h, i) => {
      const li = document.createElement('li'), link = linkEl(h.text, P.safeUrl(h.text));
      if (h.words) {   // a signed link: show who signed it
        const box = document.createElement('div'), by = document.createElement('span');
        by.className = 'by'; by.textContent = `Signed by ${h.words}`; box.append(link, by); li.appendChild(box);
      } else li.appendChild(link);
      const bin = document.createElement('button'); bin.type = 'button'; bin.className = 'bin';
      bin.title = 'Delete'; bin.setAttribute('aria-label', 'Delete ' + h.text);
      bin.innerHTML = BIN_SVG;
      bin.onclick = () => { history.splice(i, 1); store.set('pulse10-history', history); renderHistory(); };
      li.appendChild(bin);
      return li;
    }));
  }
  const BIN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
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
    if (b && b[0] === P.SIGNED) { onSigned(b, mode, name); return; }
    if (lock) { ignored(); return; }   // locked to one sender: unsigned links are not shown
    if (!b) { accept(text, mode, name); return; }
    if (b[0] === P.LIVE) {   // a room-only link (the engine still understands them): refuse recordings
      let r; try { r = P.readLive(b); } catch (e) { return; }
      if (Math.abs(r.ageS) > P.LIVE_GRACE_S) { setStatus('Heard an old recording of a room-only link. Ignored.', true); setProgress(0); return; }
      accept(r.text, mode, name, 'Room only, heard live');
    }
  }

  // ---------- secure: signed pulses (secure.js) ----------
  // Sender: "Sign my pulses" adds this device's public key and a signature to every pulse. Receiver: a signed
  // link shows the sender's fingerprint words, and "Lock" then hides every link that isn't from that sender.
  const S = window.PulseSecure;
  let signOn = store.get('pulse10-sign', false) === true, keys = null, myWords = '', keysReady = null, canSign = null;
  let lock = store.get('pulse10-lock', null), lockWords = '', lastSig = null;   // lock: the sender's public key, base64
  if (typeof lock !== 'string') lock = null;
  const b64 = raw => btoa(String.fromCharCode(...raw));
  const signing = () => signOn && !!keys;

  // the key pair is only made (or loaded) once someone opens the Secure tab or has signing on
  function ensureKeys() {
    if (!keysReady) keysReady = (async () => {
      try {
        if (!S || !(await S.supported())) throw new Error('unsupported');
        keys = await S.loadOrCreateKeys(); myWords = await S.fingerprint(keys.publicRaw); canSign = true;
      } catch (e) { keys = null; myWords = ''; canSign = false; }
      renderSecure(); if (!source) update();
    })();
    return keysReady;
  }
  function renderSecure() {
    $('signOn').checked = signing(); $('signOn').disabled = !keys;
    $('signHint').textContent = canSign === false ? 'This browser can’t sign.' : canSign === null ? '' :
      signOn ? 'On. Every pulse you send is signed, which makes it about 20 s longer.' : 'Off. Pulses are sent unsigned.';
    $('signHint').classList.toggle('err', canSign === false);
    $('identity').hidden = canSign === false;
    $('myWords').textContent = myWords || '…';
  }
  $('signOn').addEventListener('change', () => {
    signOn = $('signOn').checked; store.set('pulse10-sign', signOn); renderSecure();
    if (source) stopPlaying(); update();
  });
  $('newId').onclick = async () => {
    if (!keys || !confirm('Make a new identity? Your fingerprint words will change, and anyone locked to you will stop seeing your links.')) return;
    try { const k = await S.newKeys(), w = await S.fingerprint(k.publicRaw); keys = k; myWords = w; } catch (e) { return; }
    if (source) stopPlaying();
    renderSecure(); update();
  };

  const who = () => lockWords || 'the locked sender';
  function ignored() { setStatus(`Ignored a link not from ${who()}`, true); setProgress(0); }
  function renderLock() {
    $('lockState').textContent = lock ? `Locked to ${who()}. Links from anyone else are ignored.`
      : 'Not locked. To lock, receive a signed link and choose “Lock to this sender”.';
    $('unlock').hidden = !lock;
    $('recvLock').hidden = !lock; $('recvLock').textContent = lock ? `Locked: only links signed by ${who()} are shown.` : '';
    const s = lastSig, mine = !!s && lock === s.key;
    $('resSign').hidden = !s;
    if (s) { const b = document.createElement('b'); b.textContent = s.words; $('resSign').replaceChildren('Signed by ', b, mine ? ' ✓' : ''); }
    $('resLock').hidden = !s || !!lock; $('resUnlock').hidden = !mine;
  }
  function setLock(key, words) {
    lock = key; lockWords = words || '';
    if (lock) store.set('pulse10-lock', lock); else { try { localStorage.removeItem('pulse10-lock'); } catch (e) {} }
    renderLock();
  }
  $('resLock').onclick = () => { if (lastSig) setLock(lastSig.key, lastSig.words); };
  $('resUnlock').onclick = $('unlock').onclick = () => setLock(null);
  if (lock && S) S.fingerprint(Uint8Array.from(atob(lock), c => c.charCodeAt(0))).then(w => { lockWords = w; renderLock(); }).catch(() => {});

  async function onSigned(b, mode, name) {
    let r;
    try { r = await S.readSigned(b); } catch (e) { r = { ok: false, reason: 'malformed' }; }
    if (r.ok) {
      const key = b64(r.publicRaw);
      if (lock && lock !== key) { ignored(); return; }
      accept(r.text, mode, name, '', { key, words: r.words }); return;
    }
    if (r.reason === 'unsupported') {   // this browser has no Ed25519: show it, marked, and never open it automatically
      if (lock) { ignored(); return; }
      accept(r.text, mode, name, 'Signature not checked', { unchecked: true }); return;
    }
    setProgress(0);
    setStatus(r.reason === 'old' ? 'Rejected a signed link more than 12 hours old (a replay, or a wrong clock)'
      : r.reason === 'future' ? 'Rejected a signed link dated in the future (check this device’s clock)'
      : 'Rejected a link with a bad signature', true);
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

  // the same link heard again within this long (since it was last heard) counts as a repeat and isn't opened again
  const REPEAT_MS = 5 * 60 * 1000;

  // sig: {key, words} for a link with a checked signature, {unchecked: true} for one this browser couldn't check
  function accept(text, mode, name, note = '', sig = null) {
    $('resMelody').textContent = [note, name ? `Played with ${name}` : ''].filter(Boolean).join(' · ');
    const unchecked = !!(sig && sig.unchecked), words = sig && sig.key ? sig.words : '';
    lastSig = words ? sig : null; renderLock();
    const url = P.safeUrl(text), offline = !navigator.onLine;
    setProgress(1);
    $('result').hidden = false;
    $('resUrl').textContent = text;
    $('resOpen').hidden = !url || offline;
    if (url) $('resOpen').href = url;
    setStatus(!url ? 'Received text' : offline ? 'Saved. Opens when you’re back online.' : 'Received');

    // a repeat of the same pulse (the sender loops until stopped): refresh it, don't open it again
    if (history[0] && history[0].text === text && (history[0].words || '') === words && Date.now() - history[0].at < REPEAT_MS) { history[0].at = Date.now(); store.set('pulse10-history', history); return; }
    history.unshift(words ? { text, mode, at: Date.now(), words } : { text, mode, at: Date.now() }); history.length = Math.min(history.length, 20);
    store.set('pulse10-history', history); renderHistory();
    if (navigator.vibrate) navigator.vibrate(60);
    if (!url) return;
    if (offline) {
      if (!pending.some(p => p.url === url)) { pending.push(unchecked ? { text, url, at: Date.now(), noAuto: true } : { text, url, at: Date.now() }); store.set('pulse10-pending', pending); }
      renderPending();
    } else if ($('auto').checked && !unchecked) {
      openInNewTab(url);
    }
  }

  // Opens in a new tab and keeps listening in this one. Browsers block tabs opened without a tap unless the
  // site is allowed pop-ups, so a blocked open falls back to the Open link.
  function openInNewTab(url) {
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch (e) {} setStatus(node ? 'Opened in a new tab. Still listening…' : 'Opened in a new tab.'); }
    else setStatus('Your browser blocked the new tab. Tap Open, or allow pop-ups for this site.', true);
  }

  // auto-open is off by default, so a prank link only shows up and never opens by itself
  $('auto').checked = store.get('pulse10-auto', false) === true;
  $('auto').addEventListener('change', () => store.set('pulse10-auto', $('auto').checked));

  window.addEventListener('offline', renderNet);
  window.addEventListener('online', () => {
    renderNet();
    const i = pending.findIndex(p => !p.noAuto);   // a link whose signature couldn't be checked never opens by itself
    if (i >= 0 && $('auto').checked) {
      const [p] = pending.splice(i, 1); store.set('pulse10-pending', pending); renderPending();
      openInNewTab(p.url);
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
    listenUi(true);
    const loop = () => { drawWaterfall(); drawMeter(); if (node) requestAnimationFrame(loop); };
    loop();
  }

  function stopListening() {
    if (node) { node.disconnect(); node.onaudioprocess = null; node = null; }
    if (mic) { mic.disconnect(); mic = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    decoder = null; frames = []; meterDb = 0; drawMeter();
    listenUi(false);
    if ($('status').textContent.startsWith('Listening')) setStatus('Microphone off');
  }
  // the logo button: beats with a "Pulsing" wave while listening, "Click to pulse" otherwise
  function listenUi(on) {
    $('listen').classList.toggle('on', on); $('listen').setAttribute('aria-pressed', on);
    if (on) waveLabel($('listenLabel'), 'Pulsing');
    else { $('listenLabel').textContent = 'Click to pulse'; $('listenLabel').classList.remove('wave'); }
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
  renderHistory(); renderNet(); renderSecure(); renderLock();
  if (signOn) ensureKeys();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('resize', () => { drawScore(null); if (wctx) initWaterfall(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { drawScore(null); if (wctx) initWaterfall(); });
})();
