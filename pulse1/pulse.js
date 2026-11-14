/*
 * Pulse4: an acoustic QR code with several sound modes.
 *
 *   standard  16 tones, 3.0–5.6 kHz, 4 bits per tone. Most robust in noisy rooms.
 *   child     a melody: 8 notes of a C-major pentatonic scale (C5–E6), 3 bits per note,
 *             soft attack/release so it sounds like a tune rather than beeps.
 *   whale     deep gliding "whale song": 8 notes of D-minor pentatonic, 294–784 Hz, 3 bits per note.
 *   high      near-inaudible: 16 tones in 19.0–20.5 kHz, 4 bits per tone, smooth glides between tones. Short range.
 *
 * Every mode uses the same packet:
 *   [S][E][S][E] preamble -> header (length + 4 Reed-Solomon bytes) -> body (URL + CRC-16 + ~30% RS parity) -> [E E]
 * The receiver runs one decoder per mode on the same microphone stream, so the mode is detected automatically.
 *
 * Receiver techniques (per mode): preamble matched filter at each speed (finds the exact symbol grid),
 * long per-symbol Goertzel filters, per-tone background normalisation, learned echo cancelling,
 * Reed-Solomon with erasures, repeat combining, and clock tracking.
 *
 * Works in the browser (window.Pulse) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const HEADER_PARITY = 4, HEADER_BYTES = 1 + HEADER_PARITY;
  const MAX_PAYLOAD = 180;
  // 3-bit symbols straddle byte boundaries, so one bad tone can spoil two bytes: give those modes more parity
  const bodyParity = (n, bits = 4) => bits === 4 ? Math.max(6, Math.ceil(n * 0.3)) : Math.max(8, Math.ceil(n * 0.5));

  // C-major pentatonic, C5 upward (Hz)
  const PENTA = [523.25, 587.33, 659.26, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0];

  function profile(name, o) {
    const dataTones = 1 << o.bits;
    return Object.assign({ name, dataTones, START: dataTones, END: dataTones + 1, numTones: dataTones + 2 }, o);
  }

  const MODES = {
    standard: profile('standard', {
      label: 'Standard', bits: 4,
      freqs: Array.from({ length: 18 }, (_, i) => 3000 + i * 150),
      speeds: { fast: 70, normal: 120, slow: 200 },
      frameMs: 20, hopMs: 5, shape: 'fsk', fadeMs: 8, amp: 0.6,
    }),
    child: profile('child', {
      label: 'Child', bits: 3,
      freqs: PENTA,                                  // 8 data notes C5..E6, then G6 (start) and A6 (end)
      speeds: { fast: 110, normal: 150, slow: 220 },
      frameMs: 50, hopMs: 10, shape: 'note', fadeMs: 10, amp: 0.55,
    }),
    whale: profile('whale', {
      label: 'Whale', bits: 3,
      freqs: [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99, 880.0, 1046.5],   // D-minor pentatonic, low register
      speeds: { fast: 110, normal: 140, slow: 200 },
      frameMs: 70, hopMs: 10, shape: 'glide', glideFrac: 0.4, slotStart: 0.22, slotLen: 0.56,
      leadToneMs: 300, fadeMs: 60, fadeInMs: 250, amp: 0.7,
    }),
    high: profile('high', {
      label: 'High', bits: 4,
      freqs: Array.from({ length: 18 }, (_, i) => 19000 + i * 1500 / 17),   // 19.0–20.5 kHz, 88 Hz apart
      speeds: { fast: 45, normal: 60, slow: 90 },
      frameMs: 30, hopMs: 5, shape: 'glide', glideMs: 10, preambleMult: 3, leadToneMs: 450, fadeMs: 40, fadeInMs: 400, amp: 0.9,
    }),
  };
  const DEFAULT_MODE = 'high', DEFAULT_SPEED = 'normal';

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


  // ---------------------------------------------------------------- bit packing
  function bytesToSymbols(bytes, bits) {
    const out = []; let acc = 0, n = 0;
    for (const b of bytes) {
      acc = (acc << 8) | b; n += 8;
      while (n >= bits) { n -= bits; out.push((acc >> n) & ((1 << bits) - 1)); }
      acc &= (1 << n) - 1;
    }
    if (n > 0) out.push((acc << (bits - n)) & ((1 << bits) - 1));
    return out;
  }
  const symbolsFor = (nBytes, bits) => Math.ceil(nBytes * 8 / bits);
  /** symbols [{v, conf}] -> bytes [{byte, conf}] (conf = weakest symbol touching the byte) */
  function symbolsToBytes(syms, bits, nBytes) {
    const out = [];
    for (let i = 0; i < nBytes; i++) {
      let byte = 0, conf = Infinity;
      for (let b = 0; b < 8; b++) {
        const bit = i * 8 + b, s = syms[Math.floor(bit / bits)], shift = bits - 1 - (bit % bits);
        byte = (byte << 1) | ((s.v >> shift) & 1);
        conf = Math.min(conf, s.conf);
      }
      out.push({ byte, conf });
    }
    return out;
  }

  // ---------------------------------------------------------------- sender
  const utf8Encode = t => new TextEncoder().encode(t);

  function buildPacket(text, bits) {
    const payload = Array.from(utf8Encode(text));
    if (!payload.length) throw new Error('Nothing to send');
    if (payload.length > MAX_PAYLOAD) throw new Error(`Too long (${payload.length} bytes, max ${MAX_PAYLOAD})`);
    const crc = crc16([payload.length, ...payload]);
    const body = payload.concat([crc >> 8, crc & 0xff]);
    const header = whiten(rsEncode([payload.length], HEADER_PARITY), 0);
    const bodyW = whiten(rsEncode(body, bodyParity(body.length, bits)), HEADER_BYTES);
    return { header, body: bodyW };
  }

  /** Text -> list of {tone, ms} segments for a mode/speed. */
  function encode(text, opts = {}) {
    const m = MODES[opts.mode] || MODES[DEFAULT_MODE];
    const T = m.speeds[opts.speed] || m.speeds[DEFAULT_SPEED];
    const { header, body } = buildPacket(text, m.bits);
    const segs = [m.START, m.END, m.START, m.END].map(tone => ({ tone, ms: T * (m.preambleMult || 1) }));   // longer preamble rides over room reverb
    if (m.leadToneMs) segs.unshift({ tone: m.START, ms: m.leadToneMs });   // soft lead-in at the start frequency
    for (const v of bytesToSymbols(header, m.bits)) segs.push({ tone: v, ms: T });
    for (const v of bytesToSymbols(body, m.bits)) segs.push({ tone: v, ms: T });
    segs.push({ tone: m.END, ms: 2 * T });
    segs.mode = m.name; segs.T = T;
    return segs;
  }

  /** Segments -> Float32Array. 'fsk' is phase-continuous; 'note' gives each symbol a soft attack and release. */
  function synthesize(segs, sampleRate, opts = {}) {
    const m = MODES[segs.mode] || MODES[DEFAULT_MODE];
    const amp = (opts.amplitude ?? 1) * m.amp;
    const lead = Math.round(sampleRate * (opts.leadMs ?? 80) / 1000);
    const tail = Math.round(sampleRate * (opts.tailMs ?? 80) / 1000);
    const total = segs.reduce((a, s) => a + s.ms, 0);
    const body = Math.round(sampleRate * total / 1000);
    const out = new Float32Array(lead + body + tail);
    let phase = 0, t0 = 0;
    const G = m.glideFrac ? sampleRate * (segs.T || 100) / 1000 * m.glideFrac : sampleRate * (m.glideMs || 0) / 1000;
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      const a = Math.round(sampleRate * t0 / 1000), b = Math.round(sampleRate * (t0 + s.ms) / 1000), n = b - a;
      const dp = 2 * Math.PI * m.freqs[s.tone] / sampleRate;
      const fPrev = si > 0 ? m.freqs[segs[si - 1].tone] : 0, fNext = si < segs.length - 1 ? m.freqs[segs[si + 1].tone] : 0, f = m.freqs[s.tone];
      const att = Math.round(sampleRate * 0.012), rel = Math.round(sampleRate * 0.022);
      for (let i = 0; i < n; i++) {
        let g = 1;
        if (m.shape === 'note') {
          // gentle "plucked" note: quick attack, slight decay, soft release into the next note
          g = 0.75 + 0.25 * Math.exp(-i / (sampleRate * 0.06));
          if (i < att) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / att);
          if (i > n - rel) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / rel);
        }
        out[lead + a + i] = Math.sin(phase) * g;
        let step = dp;
        if (m.shape === 'glide' && G > 0) {
          // raised-cosine frequency glide across each boundary: no abrupt jumps, so no audible clicks
          if (si > 0 && i < G / 2) step = 2 * Math.PI * (fPrev + (f - fPrev) * (0.5 - 0.5 * Math.cos(Math.PI * (i + G / 2) / G))) / sampleRate;
          else if (fNext && n - i < G / 2) step = 2 * Math.PI * (f + (fNext - f) * (0.5 - 0.5 * Math.cos(Math.PI * (G / 2 - (n - i)) / G))) / sampleRate;
        }
        phase += step; if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
      t0 += s.ms;
    }
    const fade = Math.round(sampleRate * m.fadeMs / 1000), fadeIn = Math.round(sampleRate * (m.fadeInMs || m.fadeMs) / 1000);
    for (let i = 0; i < body; i++) {
      let g = amp;
      if (i < fadeIn) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / fadeIn);
      else if (i > body - fade) g *= 0.5 - 0.5 * Math.cos(Math.PI * (body - i) / fade);
      out[lead + i] *= g;
    }
    return out;
  }

  const durationMs = segs => segs.reduce((a, s) => a + s.ms, 0);

  // ---------------------------------------------------------------- Für Elise cover melody
  // Beethoven, Für Elise (public domain): pickup + first 4 bars, in sixteenth-note steps.
  // [step, midi note, hand]. 'R' notes are what the receiver listens for to check the tune was played.
  const FUR_ELISE = {
    steps: 26,
    notes: [
      [0, 76, 'R'], [1, 75, 'R'],
      [2, 76, 'R'], [3, 75, 'R'], [4, 76, 'R'], [5, 71, 'R'], [6, 74, 'R'], [7, 72, 'R'],
      [8, 69, 'R', 3], [8, 45, 'L'], [9, 52, 'L'], [10, 57, 'L'], [11, 60, 'R'], [12, 64, 'R'], [13, 69, 'R'],
      [14, 71, 'R', 3], [14, 40, 'L'], [15, 52, 'L'], [16, 56, 'L'], [17, 64, 'R'], [18, 68, 'R'], [19, 71, 'R'],
      [20, 72, 'R', 3], [20, 45, 'L'], [21, 52, 'L'], [22, 57, 'L'], [23, 64, 'R'], [24, 76, 'R'], [25, 75, 'R', 2],
    ],
  };
  const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);

  /** Length of one packet in ms (what durationMs(encode(...)) returns), computable by the receiver from len + speed. */
  function packetMs(mode, T, len) {
    const m = MODES[mode], body = len + 2 + bodyParity(len + 2, m.bits);
    return (m.leadToneMs || 0) + 4 * T * (m.preambleMult || 1) + T * (symbolsFor(HEADER_BYTES, m.bits) + symbolsFor(body, m.bits)) + 2 * T;
  }
  /** Sixteenth-note length so the 4 bars last exactly as long as the packet. */
  const stepMs = packetMs_ => packetMs_ / FUR_ELISE.steps;

  /** Piano-like rendering of the melody, `ms` long (stretches the tempo to fit). Peak ≈ amp. */
  function synthesizeMelody(ms, sampleRate, amp = 0.3) {
    const step = stepMs(ms) / 1000, ring = 1.4;
    const out = new Float32Array(Math.round(sampleRate * (ms / 1000 + ring)));
    for (const [k, note, hand] of FUR_ELISE.notes) {
      const f = midiHz(note), t0 = Math.round(k * step * sampleRate), n = Math.round(ring * sampleRate);
      const vel = hand === 'L' ? 0.55 : 1;
      for (let h = 1; h <= 6 && f * h < 8000; h++) {
        const a = vel * Math.pow(h, -1.6), tau = 0.55 / Math.sqrt(h), w = 2 * Math.PI * f * h / sampleRate;
        for (let i = 0; i < n; i++) {
          const t = i / sampleRate;
          const env = Math.min(1, t / 0.004) * Math.exp(-t / tau) * (i > n - 2000 ? (n - i) / 2000 : 1);
          out[t0 + i] += a * env * Math.sin(w * i);
        }
      }
    }
    let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= amp / peak;
    return out;
  }

  /** Listen back over a decoded packet: was Für Elise playing in time with it? */
  function checkMelody(store, sampleRate, startSample, ms) {
    const step = stepMs(ms) / 1000 * sampleRate, onsets = FUR_ELISE.notes.map(([k, n]) => [k * step, n]);
    let total = 0, matched = 0;
    const power = (s, N, f) => {
      const c = 2 * Math.cos(2 * Math.PI * f / sampleRate), ring = store.ring, mask = store.RN - 1;
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); const s0 = ring[(s + i) & mask] * w + c * s1 - s2; s2 = s1; s1 = s0; }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    for (const [k, note, hand] of FUR_ELISE.notes) {
      if (hand !== 'R') continue;
      const t = startSample + k * step, s = Math.round(t + 0.02 * sampleRate), N = Math.round(Math.min(step, 0.18 * sampleRate) - 0.03 * sampleRate);
      if (N < 0.05 * sampleRate || s < store.total - store.RN || s + N > store.total) continue;
      // notes still ringing (and their overtones) would confuse the comparison, so leave those pitches out
      const ringing = onsets.filter(([o]) => o <= k * step && o > k * step - sampleRate).map(([, n]) => n);
      const near = f => ringing.some(n => { for (let h = 1; h <= 6; h++) if (Math.abs(midiHz(n) * h / f - 1) < 0.03) return true; return false; });
      const others = [];
      for (let d = -5; d <= 5; d++) if (d && !near(midiHz(note + d))) others.push(power(s, N, midiHz(note + d)));
      if (others.length < 2) continue;
      others.sort((a, b) => a - b);
      total++;
      if (power(s, N, midiHz(note)) > 4 * others[others.length >> 1]) matched++;
    }
    return { matched, total, heard: total >= 8 && matched >= 0.6 * total };
  }

  // ---------------------------------------------------------------- receiver
  /** Shared microphone sample history for all decoders. */
  class SampleStore {
    constructor(sampleRate, seconds = 30) {
      this.RN = 1 << Math.ceil(Math.log2(sampleRate * seconds));
      this.ring = new Float32Array(this.RN);
      this.total = 0;
    }
    write(samples) {
      const m = this.RN - 1;
      for (let i = 0; i < samples.length; i++) this.ring[(this.total + i) & m] = samples[i];
      this.total += samples.length;
    }
  }

  /** Decoder for one mode. Usually used through MultiDecoder. */
  class Decoder {
    constructor(sampleRate, mode, store, handlers = {}) {
      const sr = this.sr = sampleRate, m = this.m = MODES[mode];
      this.store = store; this.h = handlers;
      this.W = Math.round(sr * m.frameMs / 1000);
      this.hop = Math.round(sr * m.hopMs / 1000);
      this.win = hann(this.W);
      this.coeff = Float64Array.from(m.freqs, f => 2 * Math.cos(2 * Math.PI * f / sr));
      this.frames = 0;
      this.FN = 1 << 13;
      this.lvHist = new Float32Array(this.FN * m.numTones);
      this.aHist = new Float32Array(this.FN * 2);
      this.nf = new Float32Array(m.numTones);
      this.r = new Float32Array(m.numTones);
      this.correlators = Object.entries(m.speeds).map(([name, ms]) => {
        const T = sr * ms / 1000;
        const Tp = T * (m.preambleMult || 1);
        return { name, T, Tp, Tf: Tp / this.hop, best: null, hist: new Float32Array(256).fill(-1e9) };
      });
      this.cands = [];
      this.failed = new Map();
      this.headerSyms = symbolsFor(HEADER_BYTES, m.bits);
    }

    process() {
      while (this.frames * this.hop + this.W <= this.store.total) this._frame();
      this._stepCandidates();
    }

    _sample(i) { return this.store.ring[i & (this.store.RN - 1)]; }

    _goertzel(start, N, win, count) {
      const out = new Float64Array(count), ring = this.store.ring, mask = this.store.RN - 1;
      for (let k = 0; k < count; k++) {
        const c = this.coeff[k];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
          const s0 = ring[(start + i) & mask] * win[i] + c * s1 - s2;
          s2 = s1; s1 = s0;
        }
        out[k] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) * (2 / win.sum);
      }
      return out;
    }

    _frame() {
      const m = this.m, NT = m.numTones, f = this.frames++;
      const lv = this._goertzel(f * this.hop, this.W, this.win, NT);
      const base = (f & (this.FN - 1)) * NT;
      let best = -1, bestR = 0, peak = 0;
      for (let k = 0; k < NT; k++) if (lv[k] > peak) peak = lv[k];
      const floor = peak * 0.01;                     // window leakage: anything 40 dB below the loudest tone is not a tone
      for (let k = 0; k < NT; k++) {
        const v = lv[k];
        this.lvHist[base + k] = v;
        let nf = this.nf[k];
        if (nf === 0) nf = v || 1e-9;
        else if (v < nf) nf += 0.1 * (v - nf);       // drop quickly to the true background
        else nf += 0.002 * (v - nf) * (this.hop / (this.sr * 0.005));   // rise slowly (≈2.5 s)
        this.nf[k] = Math.max(nf, 1e-7);
        const r = this.r[k] = v / Math.max(this.nf[k], floor);
        if (r > bestR) { bestR = r; best = k; }
      }
      const ai = (f & (this.FN - 1)) * 2;
      this.aHist[ai] = Math.log(Math.max(1, this.r[m.START]));
      this.aHist[ai + 1] = Math.log(Math.max(1, this.r[m.END]));
      if (this.h.onFrame) this.h.onFrame(this.r, bestR >= 3 ? best : -1);
      for (const c of this.correlators) this._correlate(c, f);
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
      if (C >= 0.55 && minB >= 0.08 && (!c.best || C > c.best.C)) c.best = { f0, C };
      if (c.best && f0 - c.best.f0 > c.Tf / 2) {
        const b = c.best; c.best = null;
        const ym = c.hist[(b.f0 - 1) & 255], y0 = b.C, yp = c.hist[(b.f0 + 1) & 255];
        const den = ym - 2 * y0 + yp;
        const delta = (den < 0 && ym > -1e8 && yp > -1e8) ? Math.max(-0.5, Math.min(0.5, 0.5 * (ym - yp) / den)) : 0;
        const p = (b.f0 + delta) * this.hop + this.W / 2 - this.hop / 2;
        this._newCandidate(c, p + 4 * c.Tp, b.C);
      }
    }

    _newCandidate(c, b0, score) {
      for (const k of this.cands) if (Math.abs(k.b0 - b0) < k.T) { if (score > k.score && k.k < 4) Object.assign(k, this._cand(c, b0, score)); return; }
      this.cands.push(this._cand(c, b0, score));
      if (this.h.onDetect) this.h.onDetect(this.m.name);
    }
    _cand(c, b0, score) { return { speed: c.name, T: c.T, T0: c.T, b0, b: b0, k: 0, score, rows: [], hard: [], total: null, len: null }; }

    _stepCandidates() {
      const m = this.m, total = this.store.total, lastCenter = (this.frames - 1) * this.hop + this.W / 2;
      for (const c of this.cands.slice()) {
        while (!c.done) {
          const T = c.T;
          if (c.b + T > total || c.b + T / 3 > lastCenter) break;
          if (c.b < total - this.store.RN + this.sr) { c.done = true; break; }
          const s = Math.round(c.b + (m.slotStart ?? 0.25) * T), N = Math.round((m.slotLen ?? 0.67) * T);
          if (!c.win || c.win.length !== N) c.win = hann(N);
          const lv = this._goertzel(s, N, c.win, m.dataTones);
          const row = Float64Array.from(lv, v => v * v);
          const hard = argmax(row);
          const prev = c.hard[c.hard.length - 1];
          if (prev !== undefined && prev !== hard) this._track(c, prev, hard);
          c.rows.push(row); c.hard.push(hard);
          c.b += c.T; c.k++;
          if (c.k === this.headerSyms) this._header(c);
          else if (c.total && c.k >= c.total) this._body(c);
          else if (c.total) this._progress(c);
        }
        if (c.done) this.cands.splice(this.cands.indexOf(c), 1);
      }
    }

    _track(c, a, b) {
      const NT = this.m.numTones, T = c.T, edge = c.b, lo = edge - T / 3, hi = edge + T / 3;
      let bestX = null, prevS = null, prevX = null;
      const fLo = Math.max(0, Math.ceil((lo - this.W / 2) / this.hop)), fHi = Math.min(this.frames - 1, Math.floor((hi - this.W / 2) / this.hop));
      if (this.frames - fLo > this.FN) return;
      for (let f = fLo; f <= fHi; f++) {
        const i = (f & (this.FN - 1)) * NT, s = this.lvHist[i + b] - this.lvHist[i + a], x = f * this.hop + this.W / 2;
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
      const bytes = this._bytes(prepare(c.rows), HEADER_BYTES, 0);
      try {
        const len = rsDecode(bytes.map(x => x.byte), HEADER_PARITY, [])[0];
        if (len < 1 || len > MAX_PAYLOAD) throw new Error('len');
        c.len = len;
        c.parity = bodyParity(len + 2, this.m.bits);
        c.bodyBytes = len + 2 + c.parity;
        c.total = this.headerSyms + symbolsFor(c.bodyBytes, this.m.bits);
        this._progress(c);
      } catch (e) { c.done = true; }
    }

    _body(c) {
      c.done = true;
      const norm = prepare(c.rows.slice(this.headerSyms));
      let text = this._tryBody(norm, c);
      if (text === null) {
        const prev = this.failed.get(c.len);
        if (prev && prev.sum.length === norm.length && this.store.total - prev.at < this.sr * 90) {
          for (let i = 0; i < norm.length; i++) for (let k = 0; k < this.m.dataTones; k++) prev.sum[i][k] += norm[i][k];
          prev.at = this.store.total;
          text = this._tryBody(prev.sum, c);
        } else {
          this.failed.set(c.len, { sum: norm, at: this.store.total });
        }
      }
      if (text === null) { if (this.h.onError) this.h.onError(this.m.name); return; }
      this.failed.delete(c.len);
      // where the packet (and Für Elise, if the sender played it) started
      const Tms = c.T0 / this.sr * 1000, start = c.b0 - 4 * c.T0 * (this.m.preambleMult || 1) - (this.m.leadToneMs || 0) / 1000 * this.sr;
      const melody = checkMelody(this.store, this.sr, start, packetMs(this.m.name, Tms, c.len));
      if (this.h.onMessage) this.h.onMessage(text, this.m.name, { melody });
    }

    _tryBody(norm, c) {
      const bytes = this._bytes(norm, c.bodyBytes, HEADER_BYTES);
      const word = bytes.map(x => x.byte);
      const order = bytes.map((x, i) => i).sort((i, j) => bytes[i].conf - bytes[j].conf);
      for (const nErase of [0, Math.floor(c.parity / 2), c.parity, Math.floor(c.parity * 0.75)]) {
        const erase = order.slice(0, nErase).filter(i => bytes[i].conf < 4);
        try {
          const msg = rsDecode(word, c.parity, erase);
          const payload = msg.slice(0, c.len), crc = (msg[c.len] << 8) | msg[c.len + 1];
          if (crc16([c.len, ...payload]) !== crc) continue;
          return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payload));
        } catch (e) { /* next erasure set */ }
      }
      return null;
    }

    // prepared rows -> de-whitened bytes with confidence
    _bytes(norm, nBytes, whitenOffset) {
      const syms = norm.map(r => {
        const a = argmax(r);
        let b = a === 0 ? 1 : 0;
        for (let k = 0; k < r.length; k++) if (k !== a && r[k] > r[b]) b = k;
        return { v: a, conf: r[a] / Math.max(1e-12, r[b]) };
      });
      // a symbol much weaker than the packet's typical symbol was probably sent on a tone that is jammed
      // (a whistle) or swallowed by the room; treat it as unreliable
      const peaks = norm.map(r => Math.max(...r)), med = peaks.slice().sort((a, b) => a - b)[peaks.length >> 1];
      syms.forEach((s, i) => { if (peaks[i] < 0.2 * med) s.conf = Math.min(s.conf, 1.2); });
      // the same tone twice in a row is often an echo of the previous symbol hiding a tone the room swallows
      for (let i = 1; i < syms.length; i++) if (syms[i].v === syms[i - 1].v) syms[i].conf = Math.min(syms[i].conf, 1.5);
      const bytes = symbolsToBytes(syms, this.m.bits, nBytes);
      const dw = whiten(bytes.map(x => x.byte), whitenOffset);
      bytes.forEach((x, i) => { x.byte = dw[i]; });
      return bytes;
    }

    _progress(c) {
      const best = this.cands.filter(k => k.total && !k.done).sort((a, b) => b.k - a.k)[0];
      if (best === c && this.h.onProgress) this.h.onProgress(c.k, c.total, this.m.name);
    }
  }

  /**
   * Listens for every mode at once. Handlers:
   *   onMessage(text, mode), onError(mode), onProgress(done, total, mode), onDetect(mode),
   *   onFrame(mode, levels, toneIdx)   levels = each tone's loudness relative to its background
   */
  class MultiDecoder {
    constructor(sampleRate, handlers = {}, modes = Object.keys(MODES)) {
      this.store = new SampleStore(sampleRate);
      // ultrasonic tones need a sample rate comfortably above 40 kHz
      this.decoders = modes.filter(n => MODES[n].freqs[MODES[n].freqs.length - 1] < sampleRate * 0.47).map(n => new Decoder(sampleRate, n, this.store, {
        onMessage: handlers.onMessage, onError: handlers.onError, onProgress: handlers.onProgress, onDetect: handlers.onDetect,
        onFrame: handlers.onFrame ? (lv, t) => handlers.onFrame(n, lv, t) : null,
      }));
    }
    push(samples) {
      this.store.write(samples);
      for (const d of this.decoders) d.process();
    }
  }

  function hann(N) {
    const w = new Float64Array(N); let s = 0;
    for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); s += w[i]; }
    w.sum = s; return w;
  }
  function argmax(r) { let a = 0; for (let k = 1; k < r.length; k++) if (r[k] > r[a]) a = k; return a; }

  // Per-tone background normalisation, then learned echo cancelling.
  function prepare(rows) {
    const norm = normalize(rows), n = norm.length, hard = norm.map(argmax), leaks = [];
    for (let i = 1; i < n; i++) if (hard[i] !== hard[i - 1]) leaks.push(norm[i][hard[i - 1]] / Math.max(1e-15, norm[i - 1][hard[i - 1]]));
    leaks.sort((a, b) => a - b);
    const leak = leaks.length ? Math.min(0.5, leaks[Math.floor((leaks.length - 1) * 0.75)] * 1.5) : 0;
    const clean = norm.map((r, i) => {
      const o = r.slice();
      if (i > 0) { const p = hard[i - 1]; o[p] = Math.max(0, o[p] - leak * norm[i - 1][p]); }
      return o;
    });
    // channel equalisation: rooms and speakers make some tones much quieter than others. Learn each tone's
    // typical level from symbols where it clearly won, and judge every tone relative to its own level.
    const K = clean[0].length, wins = Array.from({ length: K }, () => []);
    for (const r of clean) {
      const a = argmax(r); let b = 0;
      for (let k = 0; k < K; k++) if (k !== a && r[k] > b) b = r[k];
      if (r[a] > 3 * b) wins[a].push(r[a]);
    }
    const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const known = wins.filter(w => w.length >= 2).map(med);
    if (known.length < K / 2) return clean;
    const typical = med(known);
    const gain = wins.map(w => Math.min(1, Math.max(0.05, (w.length >= 2 ? med(w) : typical) / typical)));
    return clean.map(r => r.map((v, k) => v / gain[k]));
  }
  function normalize(rows) {
    const n = rows.length, K = rows[0].length, bg = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const col = rows.map(r => r[k]).sort((a, b) => a - b);
      bg[k] = col[Math.floor((n - 1) * 0.25)];
    }
    // regulariser: never trust a background more than ~25 dB below the typical symbol (avoids blowing up near-silent tones)
    const peaks = rows.map(r => Math.max(...r)).sort((a, b) => a - b);
    const typical = Math.max(Array.from(bg).sort((a, b) => a - b)[K >> 1], peaks[n >> 1] * 3e-3) + 1e-15;
    return rows.map(r => Array.from(r, (v, k) => v / (bg[k] + typical)));
  }

  /** Only real web links: never javascript:, data:, etc. */
  function safeUrl(text) {
    let s = text.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null; }
    catch (e) { return null; }
  }

  const Pulse = {
    MODES, DEFAULT_MODE, DEFAULT_SPEED, MAX_PAYLOAD,
    encode, synthesize, synthesizeMelody, checkMelody, packetMs, FUR_ELISE, durationMs, Decoder, MultiDecoder, safeUrl, utf8Encode, crc16,
    rs: { encode: rsEncode, decode: rsDecode }, _prep: prepare, _bits: { bytesToSymbols, symbolsToBytes },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Pulse;
  else root.Pulse = Pulse;
})(typeof self !== 'undefined' ? self : this);
