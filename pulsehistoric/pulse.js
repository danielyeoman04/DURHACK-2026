/*
 * Pulse: an acoustic QR code.  Protocol v2 (noise-hardened).
 *
 *   [S][E][S][E]  preamble, one symbol each      -> finds the packet and its exact timing
 *   header        len + 4 Reed-Solomon bytes      -> 10 tones
 *   body          payload + CRC-16 + RS parity    -> 2 tones per byte
 *   [E E]         end flourish
 *
 * Tones: 16 data tones (one per 4-bit nibble) + START + END, 3000–5550 Hz in 150 Hz steps.
 * That band sits above most of the energy of voices and music in a busy room.
 *
 * Why it survives noise:
 *  - The preamble is found with a matched filter (S/E/S/E pattern) at each known speed, so the
 *    receiver knows exactly where every symbol starts. Each symbol is then measured over most of
 *    its length with one long, narrow filter, instead of a 20 ms snapshot. Longer listening
 *    means a narrower filter, so less noise gets in.
 *  - Every tone is compared with its own background level, so a hum, a whistle or a loud
 *    frequency band can't dominate.
 *  - Bytes are whitened and protected with Reed-Solomon (~30% parity). Uncertain symbols are
 *    flagged as erasures, which roughly doubles how many errors can be repaired.
 *  - If a packet still fails, its soft measurements are kept and added to the next repeat, so
 *    two noisy plays can decode where one cannot.
 *  - The symbol clock is tracked during the packet, so device clock drift doesn't matter.
 *
 * Works in the browser (window.Pulse) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- constants
  const DATA_TONES = 16;
  const START = 16, END = 17, NUM_TONES = 18;
  const BASE_FREQ = 3000, SPACING = 150;
  const HEADER_PARITY = 4, HEADER_BYTES = 1 + HEADER_PARITY;
  const MAX_PAYLOAD = 180;

  const SPEEDS = {
    fast:   { symbolMs: 70,  label: 'Fast' },
    normal: { symbolMs: 120, label: 'Normal' },
    slow:   { symbolMs: 200, label: 'Slow (noisy rooms)' },
  };
  const DEFAULT_SPEED = 'normal';

  const toneFreq = i => BASE_FREQ + i * SPACING;
  const bodyParity = n => Math.max(6, Math.ceil(n * 0.3));

  // ---------------------------------------------------------------- CRC + whitening
  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }
  // XOR with a fixed pseudo-random sequence so long runs of one tone (e.g. "wwwww", zeros) don't happen
  function whiten(bytes, offset = 0) {
    let x = 0x5a;
    for (let i = 0; i < offset; i++) x = (x * 109 + 89) & 0xff;
    return bytes.map(b => { const o = b ^ x; x = (x * 109 + 89) & 0xff; return o; });
  }

  // ---------------------------------------------------------------- Reed-Solomon GF(256)
  const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
           for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; })();
  const gmul = (a, b) => (a && b) ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
  const gdiv = (a, b) => { if (!b) throw new Error('div0'); return a ? GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255] : 0; };
  const gpow = (x, p) => GF_EXP[(((GF_LOG[x] * p) % 255) + 255) % 255];
  const ginv = x => GF_EXP[255 - GF_LOG[x]];
  const pscale = (p, x) => p.map(c => gmul(c, x));
  function padd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function pmul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gmul(p[i], q[j]);
    return r;
  }
  function peval(p, x) { let y = p[0]; for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i]; return y; }
  function pdiv(dividend, divisor) {
    const out = dividend.slice();
    for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
      const c = out[i];
      if (c) for (let j = 1; j < divisor.length; j++) if (divisor[j]) out[i + j] ^= gmul(divisor[j], c);
    }
    const sep = out.length - (divisor.length - 1);
    return [out.slice(0, sep), out.slice(sep)];
  }
  function rsGen(nsym) { let g = [1]; for (let i = 0; i < nsym; i++) g = pmul(g, [1, gpow(2, i)]); return g; }
  function rsEncode(msg, nsym) {
    const gen = rsGen(nsym), out = msg.concat(new Array(nsym).fill(0));
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c) for (let j = 1; j < gen.length; j++) out[i + j] ^= gmul(gen[j], c);
    }
    return msg.concat(out.slice(msg.length));
  }
  function rsSyndromes(msg, nsym) { const s = [0]; for (let i = 0; i < nsym; i++) s.push(peval(msg, gpow(2, i))); return s; }
  function rsErrataLocator(pos) { let l = [1]; for (const i of pos) l = pmul(l, padd([1], [gpow(2, i), 0])); return l; }
  function rsErrorEvaluator(synd, loc, nsym) { return pdiv(pmul(synd, loc), [1].concat(new Array(nsym + 1).fill(0)))[1]; }
  function rsCorrectErrata(msg, synd, errPos) {
    const coefPos = errPos.map(p => msg.length - 1 - p);
    const loc = rsErrataLocator(coefPos);
    const ev = rsErrorEvaluator(synd.slice().reverse(), loc, loc.length - 1).reverse();
    const X = coefPos.map(p => gpow(2, -(255 - p)));
    const E = new Array(msg.length).fill(0);
    X.forEach((Xi, i) => {
      const XiInv = ginv(Xi);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = gmul(prime, 1 ^ gmul(XiInv, X[j]));
      if (!prime) throw new Error('rs: magnitude');
      const y = gmul(Xi, peval(ev.slice().reverse(), XiInv));
      E[errPos[i]] = gdiv(y, prime);
    });
    return padd(msg, E);
  }
  function rsErrorLocator(synd, nsym, eraseCount) {
    let loc = [1], old = [1];
    const shift = synd.length > nsym ? synd.length - nsym : 0;
    for (let i = 0; i < nsym - eraseCount; i++) {
      const K = i + shift;
      let delta = synd[K];
      for (let j = 1; j < loc.length; j++) delta ^= gmul(loc[loc.length - 1 - j], synd[K - j]);
      old = old.concat([0]);
      if (delta) {
        if (old.length > loc.length) { const nl = pscale(old, delta); old = pscale(loc, ginv(delta)); loc = nl; }
        loc = padd(loc, pscale(old, delta));
      }
    }
    while (loc.length && loc[0] === 0) loc.shift();
    if ((loc.length - 1) * 2 + eraseCount > nsym) throw new Error('rs: too many errors');
    return loc;
  }
  function rsFindErrors(loc, n) {
    const pos = [];
    for (let i = 0; i < n; i++) if (peval(loc, gpow(2, i)) === 0) pos.push(n - 1 - i);
    if (pos.length !== loc.length - 1) throw new Error('rs: locator');
    return pos;
  }
  function rsForney(synd, pos, n) {
    const f = synd.slice(1);
    for (const p of pos) {
      const x = gpow(2, n - 1 - p);
      for (let j = 0; j < f.length - 1; j++) f[j] = gmul(f[j], x) ^ f[j + 1];
    }
    return f;
  }
  /** Returns corrected message bytes (without parity) or throws. erase = positions known to be bad. */
  function rsDecode(word, nsym, erase = []) {
    let msg = word.slice();
    if (erase.length > nsym) throw new Error('rs: too many erasures');
    for (const p of erase) msg[p] = 0;
    let synd = rsSyndromes(msg, nsym);
    if (Math.max(...synd) === 0) return msg.slice(0, msg.length - nsym);
    const fsynd = rsForney(synd, erase, msg.length);
    const loc = rsErrorLocator(fsynd, nsym, erase.length);
    const errPos = rsFindErrors(loc.slice().reverse(), msg.length);
    msg = rsCorrectErrata(msg, synd, erase.concat(errPos));
    synd = rsSyndromes(msg, nsym);
    if (Math.max(...synd) !== 0) throw new Error('rs: uncorrectable');
    return msg.slice(0, msg.length - nsym);
  }

  // ---------------------------------------------------------------- sender
  const utf8Encode = t => new TextEncoder().encode(t);

  function buildStream(text) {
    const payload = Array.from(utf8Encode(text));
    if (!payload.length) throw new Error('Nothing to send');
    if (payload.length > MAX_PAYLOAD) throw new Error(`Too long: ${payload.length} bytes (max ${MAX_PAYLOAD})`);
    const crc = crc16([payload.length, ...payload]);
    const body = payload.concat([crc >> 8, crc & 0xff]);
    const stream = rsEncode([payload.length], HEADER_PARITY).concat(rsEncode(body, bodyParity(body.length)));
    return whiten(stream);
  }

  /** Text -> list of {tone, ms} segments. */
  function encode(text, speed = DEFAULT_SPEED) {
    const T = (SPEEDS[speed] || SPEEDS[DEFAULT_SPEED]).symbolMs;
    const segs = [START, END, START, END].map(tone => ({ tone, ms: T }));
    for (const b of buildStream(text)) segs.push({ tone: b >> 4, ms: T }, { tone: b & 15, ms: T });
    segs.push({ tone: END, ms: 2 * T });
    return segs;
  }

  /** Segments -> Float32Array, phase-continuous with soft edges (no clicks). */
  function synthesize(segs, sampleRate, opts = {}) {
    const amp = opts.amplitude ?? 0.6;
    const lead = Math.round(sampleRate * (opts.leadMs ?? 80) / 1000);
    const tail = Math.round(sampleRate * (opts.tailMs ?? 80) / 1000);
    // place symbol edges on exact (fractional) times so long packets don't accumulate rounding drift
    let totalMs = 0; for (const s of segs) totalMs += s.ms;
    const body = Math.round(sampleRate * totalMs / 1000);
    const out = new Float32Array(lead + body + tail);
    const fade = Math.round(sampleRate * 0.008);
    let phase = 0, t0 = 0;
    for (const s of segs) {
      const a = Math.round(sampleRate * t0 / 1000), b = Math.round(sampleRate * (t0 + s.ms) / 1000);
      const dp = 2 * Math.PI * toneFreq(s.tone) / sampleRate;
      for (let i = a; i < b; i++) { out[lead + i] = Math.sin(phase); phase += dp; if (phase > 2 * Math.PI) phase -= 2 * Math.PI; }
      t0 += s.ms;
    }
    for (let i = 0; i < body; i++) {
      let g = amp;
      if (i < fade) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
      else if (i > body - fade) g *= 0.5 - 0.5 * Math.cos(Math.PI * (body - i) / fade);
      out[lead + i] *= g;
    }
    return out;
  }

  const durationMs = segs => segs.reduce((a, s) => a + s.ms, 0);

  // ---------------------------------------------------------------- receiver
  /**
   * Streaming decoder. Feed raw mono samples with push(). Handlers:
   *   onMessage(text), onError(reason), onProgress(done, total|null), onFrame(levels, toneIdx)
   * levels are each tone's loudness relative to its own background (1 = background).
   */
  class Decoder {
    constructor(sampleRate, handlers = {}) {
      const sr = this.sr = sampleRate;
      this.h = handlers;
      this.W = Math.round(sr * 0.02);              // 20 ms frames for detection / clock tracking
      this.hop = Math.round(sr * 0.005);           // every 5 ms
      this.win = hann(this.W);
      this.coeff = Float64Array.from({ length: NUM_TONES }, (_, k) => 2 * Math.cos(2 * Math.PI * toneFreq(k) / sr));
      // raw sample history (for long per-symbol filters) and per-frame history
      this.RN = 1 << Math.ceil(Math.log2(sr * 40));
      this.ring = new Float32Array(this.RN);
      this.total = 0;                               // samples received
      this.frames = 0;                              // frames analysed
      this.FN = 1 << 13;
      this.lvHist = new Float32Array(this.FN * NUM_TONES);
      this.aHist = new Float32Array(this.FN * 2);   // log-contrast of START / END tones
      this.nf = new Float32Array(NUM_TONES);        // per-tone background level
      this.r = new Float32Array(NUM_TONES);
      this.detectRatio = handlers.detectRatio ?? 3;
      // one matched filter per speed
      this.correlators = Object.entries(SPEEDS).map(([name, s]) => {
        const T = sr * s.symbolMs / 1000;
        return { name, T, Tf: T / this.hop, best: null, hist: new Float32Array(256).fill(-1e9) };
      });
      this.cands = [];
      this.failed = new Map();                      // len -> {sum, count, at} soft data from failed attempts
      this.lastSuccessAt = -1e12;
    }

    push(samples) {
      for (let i = 0; i < samples.length; i++) this.ring[(this.total + i) & (this.RN - 1)] = samples[i];
      this.total += samples.length;
      while ((this.frames * this.hop) + this.W <= this.total) this._frame();
      this._stepCandidates();
    }

    _sample(i) { return this.ring[i & (this.RN - 1)]; }

    // ---- per-frame analysis: levels, background tracking, preamble detection
    _frame() {
      const f = this.frames++, start = f * this.hop, N = this.W, lv = this._goertzel(start, N, this.win, NUM_TONES);
      const base = (f & (this.FN - 1)) * NUM_TONES;
      let best = -1, bestR = 0;
      for (let k = 0; k < NUM_TONES; k++) {
        const v = lv[k];
        this.lvHist[base + k] = v;
        let nf = this.nf[k];
        if (nf === 0) nf = v || 1e-9;
        else if (v < nf) nf += 0.1 * (v - nf);       // drop quickly to the true background
        else nf += 0.002 * (v - nf);                 // rise slowly (≈2.5 s), so tones don't count as background
        this.nf[k] = Math.max(nf, 1e-7);
        const r = this.r[k] = v / this.nf[k];
        if (r > bestR) { bestR = r; best = k; }
      }
      const tone = bestR >= this.detectRatio ? best : -1;
      const ai = (f & (this.FN - 1)) * 2;
      this.aHist[ai] = Math.log(Math.max(1, this.r[START]));
      this.aHist[ai + 1] = Math.log(Math.max(1, this.r[END]));
      if (this.h.onFrame) this.h.onFrame(this.r, tone);
      for (const c of this.correlators) this._correlate(c, f);
    }

    _goertzel(start, N, win, count) {
      const out = new Float64Array(count);
      for (let k = 0; k < count; k++) {
        const c = this.coeff[k];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
          const s0 = this._sample(start + i) * (win ? win[i] : 1) + c * s1 - s2;
          s2 = s1; s1 = s0;
        }
        out[k] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) * (2 / (win ? win.sum : N));
      }
      return out;
    }

    // matched filter for the S E S E preamble at one speed
    _correlate(c, f) {
      const n = Math.round(4 * c.Tf), f0 = f - n + 1;
      if (f0 < 0) return;
      let sum = 0, minB = Infinity;
      for (let j = 0; j < 4; j++) {
        const a = f0 + Math.round(j * c.Tf), b = f0 + Math.round((j + 1) * c.Tf);
        let s = 0;
        for (let g = a; g < b; g++) {
          const i = (g & (this.FN - 1)) * 2, d = this.aHist[i] - this.aHist[i + 1];
          s += (j % 2 === 0) ? d : -d;
        }
        s /= (b - a); sum += s; if (s < minB) minB = s;
      }
      const C = sum / 4;
      c.hist[f0 & 255] = C;
      const ok = C >= 0.55 && minB >= 0.2;
      if (ok && (!c.best || C > c.best.C)) c.best = { f0, C };
      if (c.best && f0 - c.best.f0 > c.Tf / 2) {
        const b = c.best; c.best = null;
        const ym = c.hist[(b.f0 - 1) & 255], y0 = b.C, yp = c.hist[(b.f0 + 1) & 255];
        const den = ym - 2 * y0 + yp;
        const delta = (den < 0 && ym > -1e8 && yp > -1e8) ? Math.max(-0.5, Math.min(0.5, 0.5 * (ym - yp) / den)) : 0;
        const p = (b.f0 + delta) * this.hop + this.W / 2 - this.hop / 2;   // preamble start, in samples
        this._newCandidate(c, p + 4 * c.T, b.C);
      }
    }

    _newCandidate(c, b0, score) {
      for (const k of this.cands) if (Math.abs(k.b0 - b0) < k.T) { if (score > k.score && k.k < 4) { Object.assign(k, this._cand(c, b0, score)); } return; }
      this.cands.push(this._cand(c, b0, score));
    }
    _cand(c, b0, score) { return { speed: c.name, T: c.T, T0: c.T, b0, b: b0, k: 0, score, rows: [], hard: [], total: null, len: null }; }

    // ---- symbol-synchronous decoding
    _stepCandidates() {
      const lastCenter = (this.frames - 1) * this.hop + this.W / 2;
      for (const c of this.cands.slice()) {
        while (!c.done) {
          const T = c.T;
          if (c.b + T > this.total || c.b + T / 3 > lastCenter) break;
          if (c.b < this.total - this.RN + this.sr) { c.done = true; break; }
          // measure each data tone over the middle of the symbol (skipping the start, where echoes of the previous tone linger)
          const s = Math.round(c.b + 0.25 * T), N = Math.round(0.67 * T);
          if (!c.win || c.win.length !== N) c.win = hann(N);
          const lv = this._goertzel(s, N, c.win, DATA_TONES);
          const row = Float64Array.from(lv, v => v * v);
          let hard = 0; for (let k = 1; k < DATA_TONES; k++) if (row[k] > row[hard]) hard = k;
          // clock tracking: nudge the symbol grid toward where the tone actually changed
          const prev = c.hard[c.hard.length - 1];
          if (prev !== undefined && prev !== hard) this._track(c, prev, hard);
          c.rows.push(row); c.hard.push(hard);
          c.b += c.T; c.k++;
          if (c.k === 2 * HEADER_BYTES) this._header(c);
          else if (c.total && c.k >= c.total) this._body(c);
          else if (c.total) this._progress(c);
        }
        if (c.done) this.cands.splice(this.cands.indexOf(c), 1);
      }
    }

    _track(c, a, b) {
      const T = c.T, edge = c.b, lo = edge - T / 3, hi = edge + T / 3;
      let bestX = null, prevS = null, prevX = null;
      const fLo = Math.max(0, Math.ceil((lo - this.W / 2) / this.hop)), fHi = Math.min(this.frames - 1, Math.floor((hi - this.W / 2) / this.hop));
      if (this.frames - fLo > this.FN) return;
      for (let f = fLo; f <= fHi; f++) {
        const i = (f & (this.FN - 1)) * NUM_TONES, s = this.lvHist[i + b] - this.lvHist[i + a], x = f * this.hop + this.W / 2;
        if (prevS !== null && prevS < 0 && s >= 0) {
          const cross = prevX + (x - prevX) * (-prevS) / (s - prevS);
          if (bestX === null || Math.abs(cross - edge) < Math.abs(bestX - edge)) bestX = cross;
        }
        prevS = s; prevX = x;
      }
      if (bestX === null) return;
      const e = Math.max(-T / 5, Math.min(T / 5, bestX - edge));
      c.b += 0.4 * e;
      c.T = Math.max(c.T0 * 0.97, Math.min(c.T0 * 1.03, c.T + 0.02 * e));
    }

    _header(c) {
      const bytes = this._bytes(c.rows, 0);
      try {
        const len = rsDecode(bytes.map(x => x.byte), HEADER_PARITY, [])[0];
        if (len < 1 || len > MAX_PAYLOAD) throw new Error('len');
        c.len = len;
        c.parity = bodyParity(len + 2);
        c.total = 2 * (HEADER_BYTES + len + 2 + c.parity);
        this._progress(c);
      } catch (e) {
        c.done = true;                               // not a real packet (or hopelessly corrupt)
      }
    }

    _body(c) {
      c.done = true;
      const rows = c.rows.slice(2 * HEADER_BYTES);
      let text = this._tryBody(rows, c.len, c.parity);
      if (text === null) {
        // combine with an earlier failed copy of the same packet and try again
        const prev = this.failed.get(c.len);
        const norm = prepare(rows);
        if (prev && prev.sum.length === norm.length && this.total - prev.at < this.sr * 90) {
          for (let i = 0; i < norm.length; i++) for (let k = 0; k < DATA_TONES; k++) prev.sum[i][k] += norm[i][k];
          prev.count++; prev.at = this.total;
          text = this._tryBody(prev.sum, c.len, c.parity, true);
        } else {
          this.failed.set(c.len, { sum: norm, count: 1, at: this.total });
        }
      }
      if (text === null) { if (this.h.onError) this.h.onError('Too noisy, waiting for the next repeat'); return; }
      this.failed.delete(c.len);
      if (this.h.onMessage) this.h.onMessage(text);
    }

    _tryBody(rows, len, parity, preNormalized) {
      const bytes = this._bytes(rows, HEADER_BYTES, preNormalized);
      const word = bytes.map(x => x.byte);
      const order = bytes.map((x, i) => i).sort((i, j) => bytes[i].conf - bytes[j].conf);
      const attempts = [0, Math.floor(parity / 2), parity, Math.floor(parity * 0.75)];
      for (const nErase of attempts) {
        const erase = order.slice(0, nErase).filter(i => bytes[i].conf < 4);
        try {
          const msg = rsDecode(word, parity, erase);
          const payload = msg.slice(0, len), crc = (msg[len] << 8) | msg[len + 1];
          if (crc16([len, ...payload]) !== crc) continue;
          return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payload));
        } catch (e) { /* try the next erasure set */ }
      }
      return null;
    }

    // rows (power per data tone per symbol) -> whitened-removed bytes with a confidence value
    _bytes(rows, byteOffset, preNormalized) {
      const norm = preNormalized ? rows : prepare(rows);
      const out = [];
      const nib = norm.map(r => {
        let a = 0;
        for (let k = 1; k < DATA_TONES; k++) if (r[k] > r[a]) a = k;
        let b = a === 0 ? 1 : 0;
        for (let k = 0; k < DATA_TONES; k++) if (k !== a && r[k] > r[b]) b = k;
        return { v: a, conf: r[a] / Math.max(1e-12, r[b]) };
      });
      // the same tone twice in a row is often really the echo of the previous symbol drowning out
      // a tone that the room happens to swallow; flag it as uncertain so Reed-Solomon can treat it as an erasure
      for (let i = 1; i < nib.length; i++) if (nib[i].v === nib[i - 1].v) nib[i].conf = Math.min(nib[i].conf, 1.5);
      const raw = [];
      for (let i = 0; i + 1 < nib.length; i += 2) raw.push({ byte: (nib[i].v << 4) | nib[i + 1].v, conf: Math.min(nib[i].conf, nib[i + 1].conf) });
      const dw = whiten(raw.map(x => x.byte), byteOffset);
      raw.forEach((x, i) => { x.byte = dw[i]; out.push(x); });
      return out;
    }

    _progress(c) {
      // report only the most advanced packet that has a valid header
      const best = this.cands.filter(k => k.total && !k.done).sort((a, b) => b.k - a.k)[0];
      if (best === c && this.h.onProgress) this.h.onProgress(c.k, c.total);
    }
  }

  function hann(N) {
    const w = new Float64Array(N); let s = 0;
    for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); s += w[i]; }
    w.sum = s; return w;
  }

  // Echo cancellation + background normalisation of a packet's per-symbol tone powers.
  function prepare(rows) {
    const norm = normalize(rows), n = norm.length, hard = norm.map(argmax), leaks = [];
    // learn how much of the previous symbol's tone leaks into the next slot (room echo/reverb)
    for (let i = 1; i < n; i++) if (hard[i] !== hard[i - 1]) leaks.push(norm[i][hard[i - 1]] / Math.max(1e-15, norm[i - 1][hard[i - 1]]));
    leaks.sort((a, b) => a - b);
    const leak = leaks.length ? Math.min(0.5, leaks[Math.floor((leaks.length - 1) * 0.75)] * 1.5) : 0;
    return norm.map((r, i) => {
      const o = r.slice();
      if (i > 0) { const p = hard[i - 1]; o[p] = Math.max(0, o[p] - leak * norm[i - 1][p]); }
      return o;
    });
  }
  function argmax(r) { let a = 0; for (let k = 1; k < r.length; k++) if (r[k] > r[a]) a = k; return a; }

  // Divide each tone's power by its own background level across the packet (lower quartile),
  // so a tone that is constantly loud because of room noise doesn't win every symbol.
  function normalize(rows) {
    const n = rows.length, bg = new Float64Array(DATA_TONES);
    for (let k = 0; k < DATA_TONES; k++) {
      const col = rows.map(r => r[k]).sort((a, b) => a - b);
      bg[k] = col[Math.floor((n - 1) * 0.25)];
    }
    const typical = Array.from(bg).sort((a, b) => a - b)[DATA_TONES >> 1] + 1e-15;
    return rows.map(r => Array.from(r, (v, k) => v / (bg[k] + typical)));
  }

  /** Only let real web links through: never javascript:, data:, etc. */
  function safeUrl(text) {
    let s = text.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null; }
    catch (e) { return null; }
  }

  const Pulse = {
    DATA_TONES, START, END, NUM_TONES, BASE_FREQ, SPACING, SPEEDS, DEFAULT_SPEED, MAX_PAYLOAD,
    toneFreq, crc16, encode, synthesize, durationMs, Decoder, safeUrl, utf8Encode,
    rs: { encode: rsEncode, decode: rsDecode },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Pulse;
  else root.Pulse = Pulse;
})(typeof self !== 'undefined' ? self : this);
