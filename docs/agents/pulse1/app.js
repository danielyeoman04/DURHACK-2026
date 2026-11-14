/* Pulse web app: Send (play URL as sound) and Receive (decode from mic). */
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

  // ---------- tabs ----------
  function show(which) {
    $('tab-send').classList.toggle('on', which === 'send');
    $('tab-recv').classList.toggle('on', which === 'recv');
    $('send').hidden = which !== 'send';
    $('recv').hidden = which !== 'recv';
    if (which !== 'send') stopPlaying();
    if (which !== 'recv') stopListening();
    try { localStorage.setItem('pulse-tab', which); } catch (e) {}
  }
  $('tab-send').onclick = () => show('send');
  $('tab-recv').onclick = () => show('recv');

  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = parseInt(c.dataset.h, 10);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  // ---------- send ----------
  for (const [k, v] of Object.entries(P.SPEEDS)) {
    const o = document.createElement('option'); o.value = k; o.textContent = v.label;
    if (k === P.DEFAULT_SPEED) o.selected = true;
    $('speed').appendChild(o);
  }

  let source = null, segs = null, playStart = 0, playDur = 0, raf = 0;

  function currentSegs() {
    const text = $('url').value.trim();
    return P.encode(text, $('speed').value);
  }

  function drawScore(progress) {
    const c = $('score'); const { g, w, h } = sizeCanvas(c);
    g.clearRect(0, 0, w, h);
    if (!segs) return;
    const total = P.durationMs(segs);
    let t = 0;
    for (const s of segs) {
      const x = t / total * w, sw = Math.max(1, s.ms / total * w);
      const y = h - 8 - (s.tone + 1) / (P.NUM_TONES + 1) * (h - 16);
      g.fillStyle = s.tone >= P.START ? '#a78bfa' : '#5eead4';
      g.fillRect(x, y - 2, sw, 4);
      t += s.ms;
    }
    if (progress != null) {
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, 0, progress * w, h);
      g.fillStyle = '#fff'; g.fillRect(progress * w, 0, 1.5, h);
    }
  }

  function updateSendMeta() {
    try {
      segs = currentSegs();
      const bytes = P.utf8Encode($('url').value.trim()).length;
      $('sendMeta').textContent = `${bytes} bytes · ${(P.durationMs(segs) / 1000).toFixed(1)} s per play · ${segs.length - 2} tones`;
      $('sendMeta').classList.remove('err');
      $('play').disabled = false;
    } catch (e) {
      segs = null;
      $('sendMeta').textContent = e.message; $('sendMeta').classList.add('err');
      $('play').disabled = !source;
    }
    drawScore(null);
  }
  $('url').addEventListener('input', updateSendMeta);
  $('speed').addEventListener('change', updateSendMeta);

  function stopPlaying() {
    if (source) { try { source.stop(); } catch (e) {} source = null; }
    cancelAnimationFrame(raf);
    $('play').textContent = 'Play sound'; $('play').classList.remove('stop');
    drawScore(null);
  }

  $('play').onclick = () => {
    if (source) { stopPlaying(); return; }
    updateSendMeta();
    if (!segs) return;
    const ac = audio();
    const loop = $('loop').checked;
    const samples = P.synthesize(segs, ac.sampleRate, { amplitude: parseFloat($('vol').value), tailMs: loop ? 600 : 80 });
    const buf = ac.createBuffer(1, samples.length, ac.sampleRate);
    buf.copyToChannel(samples, 0);
    source = ac.createBufferSource();
    source.buffer = buf; source.loop = loop;
    source.connect(ac.destination);
    source.onended = () => { if (!loop) stopPlaying(); };
    source.start();
    playStart = ac.currentTime; playDur = buf.duration;
    $('play').textContent = 'Stop'; $('play').classList.add('stop');
    const lead = 0.08, body = P.durationMs(segs) / 1000;
    const tick = () => {
      const t = (ac.currentTime - playStart) % playDur - lead;
      drawScore(Math.min(1, Math.max(0, t / body)));
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  // ---------- receive ----------
  let stream = null, node = null, mic = null, decoder = null, waterfall = null, wctx = null;

  function setStatus(text, cls) { $('status').textContent = text; $('status').className = 'status' + (cls ? ' ' + cls : ''); }
  function setProgress(f) { $('prog').style.width = (f * 100).toFixed(1) + '%'; }

  function initWaterfall() {
    const c = $('spec'); const { g, w, h } = sizeCanvas(c);
    g.fillStyle = '#0b0d12'; g.fillRect(0, 0, w, h);
    wctx = { g, w, h };
  }

  // queue frames from the audio callback, draw them on animation frames
  let frames = [];
  function drawWaterfall() {
    if (!wctx) return;
    const { g, w, h } = wctx;
    const n = frames.length; if (!n) return;
    const colW = 2;
    const shift = Math.min(w, n * colW);
    const dpr = window.devicePixelRatio || 1;
    g.drawImage(g.canvas, shift * dpr, 0, (w - shift) * dpr, h * dpr, 0, 0, w - shift, h);
    const rowH = h / P.NUM_TONES;
    frames.slice(-Math.ceil(w / colW)).forEach((f, i) => {
      const x = w - shift + i * colW;
      g.fillStyle = '#0b0d12'; g.fillRect(x, 0, colW, h);
      for (let k = 0; k < P.NUM_TONES; k++) {
        const v = Math.min(1, Math.log(Math.max(1, f.lv[k])) / Math.log(40)) * 0.8;
        const y = h - (k + 1) * rowH;
        if (k === f.tone) g.fillStyle = k >= P.START ? '#a78bfa' : '#5eead4';
        else g.fillStyle = `rgba(139,147,167,${(v * 0.8).toFixed(3)})`;
        g.fillRect(x, y + 0.5, colW, rowH - 1);
      }
    });
    frames = [];
  }

  // ---------- saved links + history (kept on the device, so they survive going offline or closing the app) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const history = store.get('pulse-history');
  let pending = store.get('pulse-pending');          // links heard while offline, waiting to be opened

  function linkEl(text, url) {
    if (!url) { const sp = document.createElement('span'); sp.textContent = text; return sp; }
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = text; return a;
  }
  function renderHistory() {
    $('history').replaceChildren(...history.map(h => { const li = document.createElement('li'); li.appendChild(linkEl(h.text, P.safeUrl(h.text))); return li; }));
  }
  function renderPending() {
    const online = navigator.onLine;
    $('pending').hidden = pending.length === 0;
    $('pendingTitle').textContent = online
      ? `You're back online. ${pending.length === 1 ? '1 saved link is' : pending.length + ' saved links are'} ready to open`
      : `Saved while offline (${pending.length}). They'll open when you're back online`;
    $('pendingList').replaceChildren(...pending.map((p, i) => {
      const li = document.createElement('li');
      li.appendChild(linkEl(p.text, p.url));
      const go = document.createElement('button'); go.textContent = 'Open'; go.disabled = !online;
      go.onclick = () => { removePending(i); location.href = p.url; };
      const x = document.createElement('button'); x.textContent = 'Remove'; x.className = 'ghost';
      x.onclick = () => removePending(i);
      li.append(go, x);
      return li;
    }));
  }
  function removePending(i) { pending.splice(i, 1); store.set('pulse-pending', pending); renderPending(); }

  function renderNet() {
    $('net').textContent = navigator.onLine ? '' : 'Offline';
    $('net').hidden = navigator.onLine;
    renderPending();
  }

  function onMessage(text) {
    const url = P.safeUrl(text);
    const offline = !navigator.onLine;
    setProgress(1);
    $('result').hidden = false;
    $('resUrl').textContent = text;
    $('resOpen').hidden = !url || offline;
    if (url) $('resOpen').href = url;
    if (!url) setStatus('Received text (not a web link)', '');
    else if (offline) setStatus("You're offline, so the link is saved. It'll open when you're back online.", '');
    else setStatus('Received a website', '');

    if (history[0] && history[0].text === text && Date.now() - history[0].at < 60000) return;   // same repeat again
    history.unshift({ text, at: Date.now() }); history.length = Math.min(history.length, 20);
    store.set('pulse-history', history); renderHistory();
    if (navigator.vibrate) navigator.vibrate(80);
    if (!url) return;
    if (offline) {
      if (!pending.some(p => p.url === url)) { pending.push({ text, url, at: Date.now() }); store.set('pulse-pending', pending); }
      renderPending();
    } else if ($('auto').checked) {
      // open in this tab, like a QR scanner does. Pop-ups opened without a tap get blocked, especially on phones
      setStatus('Opening website…', '');
      setTimeout(() => { stopListening(); location.href = url; }, 900);
    }
  }

  window.addEventListener('offline', renderNet);
  window.addEventListener('online', () => {
    renderNet();
    // back online: take the user to the oldest saved link (the others stay listed)
    if (pending.length && $('auto').checked) {
      const p = pending.shift(); store.set('pulse-pending', pending);
      setStatus('Back online. Opening your saved link…', '');
      setTimeout(() => { stopListening(); location.href = p.url; }, 900);
    }
  });

  async function startListening() {
    const ac = audio();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // the browser's voice processing would treat our tones as noise and filter them out
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'Microphone permission was denied' : 'Microphone needs https:// (or localhost)', 'err');
      return;
    }
    mic = ac.createMediaStreamSource(stream);
    // ScriptProcessor gives us raw samples on the main thread; simple and works everywhere
    node = ac.createScriptProcessor(2048, 1, 1);
    decoder = new P.Decoder(ac.sampleRate, {
      onFrame: (lv, tone) => frames.push({ lv: Float32Array.from(lv), tone }),
      onProgress: (done, total) => {
        setStatus(total ? `Receiving… ${Math.round(done / total * 100)}%` : 'Receiving…', '');
        setProgress(total ? done / total : 0.02);
      },
      onMessage,
      onError: () => { setStatus('Too noisy that time. Keeping what I heard and combining it with the next repeat…', 'err'); setProgress(0); },
    });
    node.onaudioprocess = e => decoder.push(e.inputBuffer.getChannelData(0));
    mic.connect(node);
    // ScriptProcessor only runs when connected to the output; route through a muted gain
    const mute = ac.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ac.destination);
    initWaterfall();
    setStatus('Listening…', ''); setProgress(0);
    $('listen').textContent = 'Stop listening'; $('listen').classList.add('stop');
    const loop = () => { drawWaterfall(); if (node) requestAnimationFrame(loop); };
    loop();
  }

  function stopListening() {
    if (node) { node.disconnect(); node.onaudioprocess = null; node = null; }
    if (mic) { mic.disconnect(); mic = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    decoder = null; frames = [];
    $('listen').textContent = 'Start listening'; $('listen').classList.remove('stop');
    if (!$('status').classList.contains('err')) setStatus('Microphone off', '');
  }

  $('listen').onclick = () => (node ? stopListening() : startListening());

  // ---------- init ----------
  const params = new URLSearchParams(location.search);
  if (params.get('url')) $('url').value = params.get('url');
  let tab = params.get('mode');
  if (!tab) { try { tab = localStorage.getItem('pulse-tab'); } catch (e) {} }
  show(tab === 'recv' ? 'recv' : 'send');
  updateSendMeta();
  renderHistory(); renderNet();
  // saved links from an earlier offline session: if we're online now, send the user to Receive to see them
  if (pending.length && navigator.onLine) show('recv');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('resize', () => { drawScore(null); if (wctx) initWaterfall(); });
})();
