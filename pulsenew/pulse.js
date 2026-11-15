/*
 * Pulse10: an acoustic QR code, built for loudness and range.
 *
 *   loud      the app's sound: 16 tones in 19.5–20.65 kHz (two interleaved sets), inaudible, played at full scale,
 *             with a stronger header, echo-proof tone sets and repeat stacking for range.
 *   high      Pulse3–8's sound: 16 tones in 19.0–20.5 kHz. Near-silent, arm's length. Hidden, still decodable.
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

  // Header: [part length, part index, part count, message id hi, message id lo, piece, total hi, total lo] + Reed-Solomon.
  // Long links are split into parts of at most PART_BYTES; the receiver collects parts across plays.
  // The loud mode gives the header 6 parity bytes instead of 4: at long range the header is the weak spot.
  const HEADER_FIELDS = 8;
  const headerParity = m => m.headerParity || 4, headerBytes = m => HEADER_FIELDS + headerParity(m);
  const PART_BYTES = 32, MAX_PARTS = 255;
  const MAX_PAYLOAD = PART_BYTES * MAX_PARTS;     // ~8 KB: no practical limit for a link
  // 3-bit symbols straddle byte boundaries, so one bad tone can spoil two bytes: give those modes more parity
  const bodyParity = (n, bits = 4) => bits === 4 ? Math.max(6, Math.ceil(n * 0.3)) : Math.max(8, Math.ceil(n * 0.5));

  // C-major pentatonic, C5 upward (Hz)
  const PENTA = [523.25, 587.33, 659.26, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0];

  function profile(name, o) {
    const dataTones = 1 << o.bits;
    const m = Object.assign({ name, dataTones, START: dataTones, END: dataTones + 1, numTones: dataTones + 2 }, o);
    // alt: a second set of data tones, used by every other symbol (see 'loud')
    m.frameFreqs = m.alt ? [...m.freqs, ...m.alt] : m.freqs.slice();
    // vib: START / END wobble ±vib Hz. In a room, a single steady tone can vanish at one spot (its echoes cancel it);
    // a wobbling one can't, because a few Hz away the echoes add up differently. The receiver listens either side too.
    if (m.vib) m.vibIdx = [m.START, m.END].map(t => { const i = m.frameFreqs.length; m.frameFreqs.push(m.freqs[t] - m.vib * 0.8, m.freqs[t] + m.vib * 0.8); return [t, i, i + 1]; });
    m.lag = m.alt ? 2 : 1;   // how far back the last symbol on the same set of tones is
    return m;
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
    loud: profile('loud', {
      label: 'Loud', bits: 4,
      // 19.5–20.65 kHz: inaudible (17–18.5 and 18.5–20 were both audible to the team). 20.65 kHz is the most a
      // 44.1 kHz device can play. Two interleaved sets of 16 tones, 34 Hz apart: even symbols use one set, odd
      // symbols the other. In a hall the last symbol keeps ringing (reverb) for a while; on a different set it
      // can't be mistaken for this one. START / END sit at the two ends.
      freqs: [...Array.from({ length: 16 }, (_, i) => 19550 + i * 2 * 1050 / 31), 19500, 20650],
      alt: Array.from({ length: 16 }, (_, i) => 19550 + (2 * i + 1) * 1050 / 31),
      speeds: { fast: 50, normal: 65, slow: 90 },
      frameMs: 30, hopMs: 5, shape: 'glide', glideMs: 10, preambleMult: 3, leadToneMs: 250, fadeMs: 40, fadeInMs: 220, amp: 1,
      headerParity: 6, vib: 50, vibRate: 20,
    }),
    high: profile('high', {
      label: 'High', bits: 4,
      freqs: Array.from({ length: 18 }, (_, i) => 19000 + i * 1500 / 17),   // 19.0–20.5 kHz, 88 Hz apart
      speeds: { fast: 45, normal: 60, slow: 90 },
      frameMs: 30, hopMs: 5, shape: 'glide', glideMs: 10, preambleMult: 3, leadToneMs: 450, fadeMs: 40, fadeInMs: 400, amp: 0.9,
    }),
  };
  const DEFAULT_MODE = 'loud', DEFAULT_SPEED = 'normal';

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

  // ---------------------------------------------------------------- packing (shorter sound for the same link)
  // Every message starts with one format byte:
  //   0       raw UTF-8 text
  //   1..5    a packed link: 1 = no prefix, 2 = https://, 3 = https://www., 4 = http://, 5 = http://www.
  //           then 6-bit symbols: lowercase letters, digits, URL punctuation and common chunks ('.com', 'durhack'…)
  //   6       a quick code: the next byte is an index into QUICK (links built into every copy of the app)
  const PREFIXES = ['', 'https://', 'https://www.', 'http://', 'http://www.'];
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789./-_?=&%#:~+';   // codes 0..47
  const TOKENS = ['.com', '.co.uk', '.ac.uk', '.org', '.net', '.io', 'www.', 'durhack', 'is.gd/', '.html', '.php',
    'https://', 'youtube', 'watch?v='];                                // codes 48..61
  const UPPER = 62, BYTE = 63;   // 62: next letter is a capital; 63: one raw byte follows (or, at the very end, padding)
  /** Built-in links that play as a tiny quick code. Every copy of the app must have the same list, in the same order; only add to the end. */
  const QUICK = [
    'https://durhack.com',
    'https://durhack.com/',
    'https://mitxela.com/projects/acoustic_qr_code',
  ];
  const quickIndex = text => QUICK.indexOf(text);

  function packLink(text) {
    let pre = 0;
    for (let i = PREFIXES.length - 1; i > 0; i--) if (text.startsWith(PREFIXES[i]) && PREFIXES[i].length > PREFIXES[pre].length) pre = i;
    const s = text.slice(PREFIXES[pre].length), syms = [];
    for (let i = 0; i < s.length;) {
      let tok = -1;
      for (let t = 0; t < TOKENS.length; t++) if (s.startsWith(TOKENS[t], i) && (tok < 0 || TOKENS[t].length > TOKENS[tok].length)) tok = t;
      if (tok >= 0) { syms.push([48 + tok]); i += TOKENS[tok].length; continue; }
      const ch = s[i], lo = ch.toLowerCase(), a = ALPHA.indexOf(lo);
      if (a >= 0 && (ch === lo || (ch >= 'A' && ch <= 'Z'))) { if (ch !== lo) syms.push([UPPER]); syms.push([a]); i++; continue; }
      const cp = s.codePointAt(i), str = String.fromCodePoint(cp);
      for (const b of utf8Encode(str)) syms.push([BYTE, b]);
      i += str.length;
    }
    const bits = [];
    const put = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push((v >> k) & 1); };
    for (const [c, b] of syms) { put(c, 6); if (c === BYTE) put(b, 8); }
    while (bits.length % 8) bits.push(1);   // all-ones padding reads back as an unfinished raw byte, so it's ignored
    const out = [pre + 1];
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    return out;
  }
  function unpackLink(bytes) {
    const bits = [];
    for (let i = 1; i < bytes.length; i++) for (let k = 7; k >= 0; k--) bits.push((bytes[i] >> k) & 1);
    let pos = 0, upper = false;
    const get = n => { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | bits[pos++]; return v; };
    const raw = [];
    let out = PREFIXES[bytes[0] - 1];
    const flush = () => { if (raw.length) { out += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(raw)); raw.length = 0; } };
    while (bits.length - pos >= 6) {
      const c = get(6);
      if (c === BYTE) { if (bits.length - pos < 8) break; raw.push(get(8)); continue; }
      flush();
      if (c === UPPER) { upper = true; continue; }
      const t = c < 48 ? ALPHA[c] : TOKENS[c - 48];
      out += upper ? t.toUpperCase() : t; upper = false;
    }
    flush();
    return out;
  }
  /** Text -> the bytes that get sent: the shortest of quick code, packed link and plain text. */
  function packMessage(text) {
    const q = quickIndex(text);
    if (q >= 0) return [6, q];
    const plain = [0, ...utf8Encode(text)];
    try { const p = packLink(text); if (p.length < plain.length && unpackLink(p) === text) return p; } catch (e) { /* fall back to plain */ }
    return plain;
  }
  function unpackMessage(bytes) {
    if (!bytes.length) throw new Error('empty');
    const f = bytes[0];
    if (f === 0) return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes.slice(1)));
    if (f >= 1 && f <= PREFIXES.length) return unpackLink(bytes);
    if (f === 6 && bytes.length === 2 && QUICK[bytes[1]]) return QUICK[bytes[1]];
    throw new Error('format');
  }

  // ---------------------------------------------------------------- room only
  //  LIVE   [10, t4, link..]   the link plus the second it was played. Receivers refuse it once it's more than
  //                            LIVE_GRACE_S old, so a recording played later (or sent as a voice note) doesn't work.
  const LIVE = 10, LIVE_GRACE_S = 30;
  const EPOCH_2026 = Date.UTC(2026, 0, 1);
  /** Room: link + the time this play starts (ms) -> LIVE bytes. */
  function liveMessage(text, at = Date.now()) {
    const t = Math.max(0, Math.floor((at - EPOCH_2026) / 1000));
    return [LIVE, t >>> 24 & 255, t >> 16 & 255, t >> 8 & 255, t & 255, ...packMessage(text)];
  }
  /** -> {text, ageS}. ageS = how long ago it was played (counted from the start of that play). */
  function readLive(bytes, now = Date.now()) {
    const t = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
    return { text: unpackMessage(bytes.slice(5)), ageS: (now - EPOCH_2026) / 1000 - t };
  }
  const isSpecial = bytes => bytes[0] === LIVE;

  /** Split text into balanced parts; each part becomes one packet. */
  function splitParts(text, payload = null) {
    if (!text && !payload) throw new Error('Nothing to send');
    const bytes = payload || packMessage(text);   // payload: ready-made bytes, e.g. from liveMessage
    if (bytes.length > MAX_PAYLOAD) throw new Error(`Too long (${bytes.length} bytes)`);
    return partLens(bytes.length).map((len, i, lens) => ({ payload: bytes.slice(i * lens[0], i * lens[0] + len), index: i, count: lens.length, id: crc16(bytes), total: bytes.length }));
  }
  /** Bytes in each part for a message of `total` bytes. The receiver works this out from the header too. */
  function partLens(total) {
    const n = Math.ceil(total / PART_BYTES), size = Math.ceil(total / n), lens = [];
    for (let i = 0; i < n; i++) lens.push(Math.min(size, total - i * size));
    return lens;
  }

  function buildPacket(part, m) {
    const bits = m.bits, HP = headerParity(m), HB = headerBytes(m);
    const fields = [part.payload.length, part.index, part.count, part.id >> 8, part.id & 0xff, part.piece || 0, part.total >> 8, part.total & 0xff];
    const crc = crc16([...fields, ...part.payload]);
    const body = part.payload.concat([crc >> 8, crc & 0xff]);
    const header = whiten(rsEncode(fields, HP), 0);
    const bodyW = whiten(rsEncode(body, bodyParity(body.length, bits)), HB);
    return { header, body: bodyW };
  }

  function partSegs(part, m, T) {
    const { header, body } = buildPacket(part, m);
    const segs = [m.START, m.END, m.START, m.END].map(tone => ({ tone, ms: T * (m.preambleMult || 1) }));   // longer preamble rides over room reverb
    if (m.leadToneMs) segs.unshift({ tone: m.START, ms: m.leadToneMs });   // soft lead-in at the start frequency
    let j = 0;
    for (const v of bytesToSymbols(header, m.bits)) segs.push({ tone: v, ms: T, alt: !!m.alt && (j++ & 1) === 1 });
    for (const v of bytesToSymbols(body, m.bits)) segs.push({ tone: v, ms: T, alt: !!m.alt && (j++ & 1) === 1 });
    segs.push({ tone: m.END, ms: 2 * T });
    segs.mode = m.name; segs.T = T; segs.part = part.index; segs.parts = part.count; segs.total = part.total;
    return segs;
  }

  // One play: the parts back to back (a short breath between them for the receiver to re-sync), then the
  // music decides the length: exactly the extract, so looping the play has no gap at all.
  const LEAD_MS = 80, PART_GAP_MS = 120, PLAY_TAIL_MS = 250, PEAK = 0.98;
  /** Part start times and play length (ms). Same maths on both ends: the receiver has mode, speed, total bytes and piece. */
  function layoutFor(mode, T, total, piece) {
    const starts = []; let t = 0;
    for (const len of partLens(total)) { starts.push(t); t += LEAD_MS + packetMs(mode, T, len) + PART_GAP_MS; }
    const dataMs = t - PART_GAP_MS + PLAY_TAIL_MS;
    return { starts, dataMs, ms: pieceMs(piece, dataMs) };
  }
  const playLayout = parts => layoutFor(parts[0].mode, parts[0].T, parts[0].total, parts[0].piece);
  const playMs = parts => playLayout(parts).ms;

  /** Text -> one segment list per part. opts.music: 'auto' (default), a piece number, or 0 for none. */
  function encodeParts(text, opts = {}) {
    const m = MODES[opts.mode] || MODES[DEFAULT_MODE];
    const T = m.speeds[opts.speed] || m.speeds[DEFAULT_SPEED];
    const parts = splitParts(text, opts.payload), dataMs = layoutFor(m.name, T, parts[0].total, 0).dataMs;
    const music = opts.music ?? 'auto', ranked = rankPieces(dataMs);
    // Auto: one of the three pieces that best fit the sound, chosen by the link itself (so different links get
    // different music, and the same link always gets the same piece); "Another piece" (shuffle) steps to the next
    const top = ranked.slice(0, 3), id = music === 'auto' ? top[(crc16(splitParts(text, opts.payload)[0].payload) + (opts.shuffle || 0)) % top.length] : (PIECES[+music] ? +music : 0);
    return parts.map(p => { const segs = partSegs({ ...p, piece: id }, m, T); segs.piece = id; return segs; });
  }
  /** Text -> segments of the first part (whole message when it fits in one part). */
  const encode = (text, opts) => encodeParts(text, opts)[0];

  /** One full play: every part back to back, with one piece of music running through the whole thing. */
  function renderPlay(parts, sampleRate, opts = {}) {
    const { starts, ms } = playLayout(parts), N = Math.round(sampleRate * ms / 1000), out = new Float32Array(N);
    const p = PIECES[parts[0].piece];
    parts.forEach((segs, i) => {
      const o = Math.round(sampleRate * starts[i] / 1000);
      const one = synthesize(segs, sampleRate, { leadMs: LEAD_MS, tailMs: 0, amplitude: p ? 0.75 : 1 });
      for (let j = 0; j < one.length && o + j < N; j++) out[o + j] += one[j];
    });
    if (p && opts.melody !== false) {
      // the last notes ring on into the start of the next play, so wrap their tail around: seamless when looped
      const mel = synthesizeMelody(ms, sampleRate, 0.3, p);
      for (let j = 0; j < mel.length; j++) out[j % N] += mel[j];
    }
    // as loud as the device can play without clipping: a single sine has the lowest peak-to-power ratio
    // there is, so scaling its peak to just under full scale is the most sound a speaker can be given
    let peak = 0; for (let j = 0; j < N; j++) { const a = Math.abs(out[j]); if (a > peak) peak = a; }
    if (peak > 0) { const g = PEAK / peak; for (let j = 0; j < N; j++) out[j] *= g; }
    return out;
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
    const smooth = m.shape === 'glide' && G > 0;
    const fS = s => (s.alt ? m.alt : m.freqs)[s.tone], fE = fS;
    const att = Math.round(sampleRate * 0.012), rel = Math.round(sampleRate * 0.022);
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si], prev = segs[si - 1], next = segs[si + 1];
      const a = Math.round(sampleRate * t0 / 1000), b = Math.round(sampleRate * (t0 + s.ms) / 1000), n = b - a;
      const f0 = fS(s), f1 = fE(s);
      for (let i = 0; i < n; i++) {
        let g = 1;
        if (m.shape === 'note') {
          // gentle "plucked" note: quick attack, slight decay, soft release into the next note
          g = 0.75 + 0.25 * Math.exp(-i / (sampleRate * 0.06));
          if (i < att) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / att);
          if (i > n - rel) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / rel);
        }
        out[lead + a + i] = Math.sin(phase) * g;
        let f = f0 + (f1 - f0) * i / n;
        if (m.vib && s.tone >= m.dataTones) f += m.vib * Math.sin(2 * Math.PI * m.vibRate * (a + i) / sampleRate);
        if (smooth) {
          // raised-cosine frequency glide across each boundary: no abrupt jumps, so no audible clicks
          if (prev && i < G / 2) { const fp = fE(prev); f = fp + (f - fp) * (0.5 - 0.5 * Math.cos(Math.PI * (i + G / 2) / G)); }
          else if (next && n - i < G / 2) { const fn = fS(next); f = f + (fn - f) * (0.5 - 0.5 * Math.cos(Math.PI * (G / 2 - (n - i)) / G)); }
        }
        phase += 2 * Math.PI * f / sampleRate; if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
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

  // ---------------------------------------------------------------- classical music
  // Six public-domain extracts. One extract plays through the whole sound, from the first part to the last,
  // with no gaps, and the sound is cut to exactly the extract's length so the 5 plays join up seamlessly.
  // Notes are [step, midi, hand, length in steps]. 'R' (melody) notes are what the receiver listens for.
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  /** "note:steps" in sixteenths ('r' = rest), e.g. "F#5:2 r:1 Bb4:4". shift transposes in semitones. */
  function line(str, hand, shift = 0, k0 = 0) {
    const notes = []; let k = k0;
    for (const tok of str.trim().split(/\s+/)) {
      if (tok === '|') continue;
      const [n, d] = tok.split(':'), dur = +d;
      if (n !== 'r') {
        const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
        if (!m) throw new Error('bad note ' + tok);
        notes.push([k, 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + shift, hand, dur]);
      }
      k += dur;
    }
    return { notes, steps: k - k0 };
  }
  function piece(name, composer, right, left, o = {}) {
    const r = line(right, 'R', o.shift || 0), l = line(left, 'L', o.shift || 0);
    return { name, composer, steps: r.steps, notes: [...r.notes, ...l.notes.filter(n => n[0] < r.steps)], natural: o.natural, minStep: o.minStep || 90 };
  }
  // Bach's Prelude in C: each bar is one chord, first two notes held low, the other three ripple twice per half bar
  function prelude(chords, shift) {
    const notes = [];
    chords.forEach((c, b) => {
      for (const half of [0, 8]) {
        const k0 = b * 16 + half;
        notes.push([k0, c[0] + shift, 'L', 8], [k0 + 1, c[1] + shift, 'L', 7]);
        [2, 3, 4, 2, 3, 4].forEach((j, i) => notes.push([k0 + 2 + i, c[j] + shift, 'R', 1]));
      }
    });
    return notes;
  }
  const PIECES = [
    null,   // 0 = no music
    piece('Für Elise', 'Beethoven',
      'E5:1 D#5:1 | E5:1 D#5:1 E5:1 B4:1 D5:1 C5:1 | A4:3 C4:1 E4:1 A4:1 | B4:3 E4:1 G#4:1 B4:1 | C5:3 E4:1 E5:1 D#5:1 |' +
      ' E5:1 D#5:1 E5:1 B4:1 D5:1 C5:1 | A4:3 C4:1 E4:1 A4:1 | B4:3 E4:1 C5:1 B4:1 | A4:6',
      'r:2 r:6 A2:1 E3:1 A3:1 r:3 E2:1 E3:1 G#3:1 r:3 A2:1 E3:1 A3:1 r:3 r:6 A2:1 E3:1 A3:1 r:3 E2:1 E3:1 G#3:1 r:3 A2:1 E3:1 A3:1 r:3',
      { natural: 170, minStep: 130 }),   // its low arpeggio notes need room to be heard
    { name: 'Prelude in C', composer: 'Bach', steps: 128, natural: 135, minStep: 110,   // an octave up, music-box style
      notes: prelude([[60, 64, 67, 72, 76], [60, 62, 69, 74, 77], [59, 62, 67, 74, 77], [60, 64, 67, 72, 76],
        [57, 60, 64, 69, 72], [50, 57, 62, 66, 72], [55, 59, 62, 67, 71], [55, 60, 64, 67, 72]], 12) },
    piece('Rondo alla Turca', 'Mozart',
      'B4:1 A4:1 G#4:1 A4:1 | C5:4 D5:1 C5:1 B4:1 C5:1 | E5:4 F5:1 E5:1 D#5:1 E5:1 | B5:1 A5:1 G#5:1 A5:1 B5:1 A5:1 G#5:1 A5:1 | C6:4 A5:2 C6:2 |' +
      ' B5:2 A5:2 G#5:2 A5:2 | E5:2 F5:2 G5:2 G5:2 | A5:2 G5:2 F5:2 E5:2 | D5:8',
      'r:4 A3:8 A3:8 A3:8 A3:4 E3:4 E3:8 C3:8 F3:8 G3:8', { natural: 110 }),
    piece('Eine kleine Nachtmusik', 'Mozart',
      'G5:4 r:2 D5:2 G5:4 r:2 D5:2 | G5:2 D5:2 G5:2 B5:2 D6:8 | C6:4 r:2 A5:2 C6:4 r:2 A5:2 | C6:2 A5:2 F#5:2 A5:2 D5:8',
      'G2:8 G2:8 G2:8 G2:8 D3:8 D3:8 D3:8 D3:8', { natural: 105 }),
    piece('Piano Sonata No. 12, K. 332', 'Mozart',   // first movement, Allegro (3/4), opening theme
      'F5:8 A5:2 C6:2 | F5:8 A5:2 C6:2 | D6:4 C6:2 Bb5:2 A5:2 G5:2 | F5:8 E5:4 | G5:8 Bb5:2 D6:2 | G5:8 Bb5:2 D6:2 | E6:4 D6:2 C6:2 Bb5:2 A5:2 | G5:12',
      'F3:12 F3:12 Bb2:12 C3:12 C3:12 C3:12 C3:12 C3:12', { natural: 100 }),
    piece('Gymnopédie No. 1', 'Satie',
      'r:4 F#5:4 A5:4 | G5:4 F#5:4 C#5:4 | B4:4 C#5:4 D5:4 | A4:12 | F#4:12 |' +
      ' r:4 F#5:4 A5:4 | G5:4 F#5:4 C#5:4 | B4:4 C#5:4 D5:4 | A4:12 | C#5:12 | F#5:12',
      'G2:12 D3:12 G2:12 D3:12 G2:12 D3:12 G2:12 D3:12 G2:12 D3:12 G2:12', { natural: 140 }),
  ];
  const pieceName = id => (PIECES[id] ? PIECES[id].name : null);
  const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);
  // how long each note sounds, in steps (given, or until the same hand's next note)
  function noteLen(p, i) {
    const [k, , hand, d] = p.notes[i];
    if (d) return d;
    let next = p.steps;
    for (const [k2, , h2] of p.notes) if (h2 === hand && k2 > k && k2 < next) next = k2;
    return Math.max(1, next - k);
  }

  /** Length of one packet in ms (what durationMs(encode(...)) returns), computable by the receiver from len + speed. */
  function packetMs(mode, T, len) {
    const m = MODES[mode], body = len + 2 + bodyParity(len + 2, m.bits);   // len = this part's payload bytes
    return (m.leadToneMs || 0) + 4 * T * (m.preambleMult || 1) + T * (symbolsFor(headerBytes(m), m.bits) + symbolsFor(body, m.bits)) + 2 * T;
  }
  /** Shortest a piece can be played without its fast notes blurring together. */
  const pieceMinMs = id => (PIECES[id] ? PIECES[id].steps * PIECES[id].minStep : 0);
  /** How long one play lasts: the data, stretched if needed to the piece's shortest tempo. */
  const pieceMs = (id, dataMs) => Math.max(dataMs, pieceMinMs(id));
  /** How well a piece fits a sound of dataMs: tempo far from natural, or padding the sound out, both cost. */
  function fitCost(id, dataMs) {
    const p = PIECES[id], ms = pieceMs(id, dataMs);
    return Math.abs(Math.log(ms / (p.steps * p.natural))) + 2 * (ms - dataMs) / dataMs;
  }
  /** Pieces ranked by how well they fit a sound of dataMs, best first. */
  function rankPieces(dataMs) {
    return PIECES.map((p, i) => i).filter(i => PIECES[i]).sort((a, b) => fitCost(a, dataMs) - fitCost(b, dataMs));
  }

  /** Piano-like rendering of a piece, stretched to last `ms`. Peak ≈ amp. */
  function synthesizeMelody(ms, sampleRate, amp = 0.3, p = PIECES[1]) {
    const step = ms / p.steps / 1000;
    const out = new Float32Array(Math.round(sampleRate * (ms / 1000 + 4)));
    p.notes.forEach(([k, note, hand], idx) => {
      // long notes are held (pedal), so a slow piece never drops to silence between notes
      const held = noteLen(p, idx) * step, ring = Math.min(4, Math.max(1.4, held + 0.5)), sustain = Math.max(0.55, held * 0.6);
      const f = midiHz(note), t0 = Math.round(k * step * sampleRate), n = Math.round(ring * sampleRate);
      const vel = hand === 'L' ? 0.55 : 1;
      for (let h = 1; h <= 6 && f * h < 8000; h++) {
        const a = vel * Math.pow(h, -1.6), tau = sustain / Math.sqrt(h), w = 2 * Math.PI * f * h / sampleRate;
        for (let i = 0; i < n && t0 + i < out.length; i++) {
          const t = i / sampleRate;
          const env = Math.min(1, t / 0.004) * Math.exp(-t / tau) * (i > n - 2000 ? (n - i) / 2000 : 1);
          out[t0 + i] += a * env * Math.sin(w * i);
        }
      }
    });
    let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= amp / peak;
    return out;
  }

  /**
   * Listen back: were the piece's melody notes from step `from` to `to` really played, in time, starting at
   * startSample and lasting ms for the whole piece? Returns counts so several parts can be added together.
   */
  function checkMelody(store, sampleRate, startSample, ms, p, from = 0, to = Infinity) {
    if (!p) return { matched: 0, total: 0, expected: 0 };
    const step = ms / p.steps / 1000 * sampleRate, onsets = p.notes.map(([k, n]) => [k * step, n]);
    let total = 0, matched = 0, expected = 0;
    const power = (s, N, f) => {
      const c = 2 * Math.cos(2 * Math.PI * f / sampleRate), ring = store.ring, mask = store.RN - 1;
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); const s0 = ring[(s + i) & mask] * w + c * s1 - s2; s2 = s1; s1 = s0; }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    p.notes.forEach(([k, note, hand], i) => {
      if (hand !== 'R' || k < from || k >= to) return;
      expected++;
      // only the first beat-ish of a note: later it has decayed, and the next note may start
      const len = Math.min(noteLen(p, i) * step, 0.2 * sampleRate);
      const s = Math.round(startSample + k * step + 0.02 * sampleRate), N = Math.round(len - 0.03 * sampleRate);
      if (N < 0.05 * sampleRate || s < store.total - store.RN || s + N > store.total) return;
      // notes still ringing (and their overtones) would confuse the comparison, so leave those pitches out
      const ringing = onsets.filter(([o, n]) => o <= k * step && o > k * step - sampleRate && n !== note).map(([, n]) => n);
      const near = f => ringing.some(n => { for (let h = 1; h <= 6; h++) if (Math.abs(midiHz(n) * h / f - 1) < 0.03) return true; return false; });
      const others = [];
      for (let d = -5; d <= 5; d++) if (d && !near(midiHz(note + d))) others.push(power(s, N, midiHz(note + d)));
      if (others.length < 2) return;
      others.sort((a, b) => a - b);
      total++;
      const pw = power(s, N, midiHz(note));
      // and it must start here: clearly louder than just before its onset. A note struck again while still
      // ringing rises less, but it still rises.
      const repeat = p.notes.some(x => x[1] === note && x[0] < k && (k - x[0]) * step < 0.4 * sampleRate);
      const Np = Math.round(0.05 * sampleRate), pre = power(Math.round(startSample + k * step - 0.01 * sampleRate) - Np, Np, midiHz(note)) * N / Np;
      if (pw > 4 * others[others.length >> 1] && pw > (repeat ? 1.1 : 2) * pre) matched++;
    });
    return { matched, total, expected };
  }
  /** Decide from counts (one part's, or several parts' added together). Few notes to go on: ask for more of them. */
  const melodyHeard = ({ matched, total, expected }) => total >= Math.min(8, Math.ceil(expected * 0.6)) && total > 0 && matched > (total < 12 ? 0.74 : 0.6) * total;

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
      this.coeff = Float64Array.from(m.frameFreqs, f => 2 * Math.cos(2 * Math.PI * f / sr));
      this.NT = m.frameFreqs.length;
      this.frames = 0;
      this.FN = 1 << 13;
      this.lvHist = new Float32Array(this.FN * this.NT);
      this.aHist = new Float32Array(this.FN * 2);
      this.nf = new Float32Array(this.NT);
      this.r = new Float32Array(this.NT);
      this.correlators = Object.entries(m.speeds).map(([name, ms]) => {
        const T = sr * ms / 1000;
        const Tp = T * (m.preambleMult || 1);
        return { name, T, Tp, Tf: Tp / this.hop, best: null, hist: new Float32Array(256).fill(-1e9) };
      });
      this.cands = [];
      this.failed = new Map();
      this.waiting = [];   // decoded parts whose music is still finishing
      this.HP = headerParity(m); this.HB = headerBytes(m);
      this.headerSyms = symbolsFor(this.HB, m.bits);
      this.maxBodySyms = symbolsFor(PART_BYTES + 2 + bodyParity(PART_BYTES + 2, m.bits), m.bits);
      this.bad = [];       // copies that didn't decode on their own, kept so later repeats can be stacked onto them
      this.meter = 0;      // live signal strength (dB above the background), for the range test
    }

    process() {
      while (this.frames * this.hop + this.W <= this.store.total) this._frame();
      this._stepCandidates();
      // once a part's music has finished, check it and hand the part on
      while (this.waiting.length && this.waiting[0].end <= this.store.total) this._finishPart(this.waiting.shift());
    }
    _finishPart(w) {
      const melody = checkMelody(this.store, this.sr, w.start, w.ms, PIECES[w.part.piece], w.from, w.to);
      if (this.h.onPart) this.h.onPart({ ...w.part, melody }, this.m.name);
    }

    _sample(i) { return this.store.ring[i & (this.store.RN - 1)]; }

    _goertzel(start, N, win, count, first = 0) {
      const out = new Float64Array(count), ring = this.store.ring, mask = this.store.RN - 1;
      for (let k = 0; k < count; k++) {
        const c = this.coeff[first + k];
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
      const m = this.m, NT = this.NT, f = this.frames++;
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
        else nf += (m.nfRise || 0.002) * (v - nf) * (this.hop / (this.sr * 0.005));   // rise slowly (≈2.5 s)
        this.nf[k] = Math.max(nf, 1e-7);
        const r = this.r[k] = v / Math.max(this.nf[k], floor);
        if (r > bestR) { bestR = r; best = k; }
      }
      const ai = (f & (this.FN - 1)) * 2;
      const lvl = t => (m.vibIdx ? (this.r[m.vibIdx[t][0]] + this.r[m.vibIdx[t][1]] + this.r[m.vibIdx[t][2]]) / 3 : this.r[t ? m.END : m.START]);
      this.aHist[ai] = Math.log(Math.max(1, lvl(0)));
      this.aHist[ai + 1] = Math.log(Math.max(1, lvl(1)));
      // signal strength for the range test: the loudest tone against the typical (median) tone of this band,
      // held at its peak and let fall slowly, so walking around a hall gives a steady reading
      const sorted = Array.from(lv).sort((a, b) => a - b), med = sorted[NT >> 1] || 1e-12;
      const db = 20 * Math.log10(Math.max(1e-12, peak) / Math.max(1e-12, med));
      this.meter = Math.max(db, this.meter - 6 * this.hop / this.sr);   // falls 6 dB per second
      if (this.h.onFrame) this.h.onFrame(this.r, bestR >= 3 ? best : -1, this.meter);
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
      // one candidate per speed: in a reverberant room a preamble can also look like another speed's, so each
      // speed gets its own try and the header's error check decides
      for (const k of this.cands) if (k.speed === c.name && Math.abs(k.b0 - b0) < k.T) { if (score > k.score && k.k < 4) Object.assign(k, this._cand(c, b0, score)); return; }
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
          const odd = !!m.alt && (c.k & 1) === 1, first = odd ? m.numTones : 0;   // which set of tones this symbol uses
          const lv = this._goertzel(s, N, c.win, m.dataTones, first);
          const row = Float64Array.from(lv, v => v * v);
          const hard = argmax(row);
          const prev = c.hard[c.hard.length - 1];
          if (prev !== undefined) { const a = prev + (m.alt && !odd ? m.numTones : 0), b = hard + first; if (a !== b) this._track(c, a, b); }
          c.rows.push(row); c.hard.push(hard);
          c.b += c.T; c.k++;
          if (c.k === this.headerSyms) this._header(c);
          else if (c.total && c.k >= c.total) { if (c.bad) this._stack(c); else this._body(c); }
          else if (c.total && !c.bad) this._progress(c);
        }
        if (c.done) this.cands.splice(this.cands.indexOf(c), 1);
      }
    }

    _track(c, a, b) {
      const NT = this.NT, T = c.T, edge = c.b, lo = edge - T / 3, hi = edge + T / 3;
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

    /** prepared header rows -> header fields, or null if they don't decode and agree with themselves */
    _parseHeader(norm) {
      const bytes = this._bytes(norm, this.HB, 0);
      try {
        const f = rsDecode(bytes.map(x => x.byte), this.HP, []), [len, index, count, , , piece, totHi, totLo] = f;
        const total = (totHi << 8) | totLo, lens = total ? partLens(total) : [];
        // the header must agree with itself: total bytes give the number of parts and this part's length
        if (len < 1 || piece >= PIECES.length || lens.length !== count || index >= count || lens[index] !== len) return null;
        return f;
      } catch (e) { return null; }
    }
    _setHeader(c, f) {
      const [len, index, count, idHi, idLo, piece, totHi, totLo] = f;
      Object.assign(c, { len, index, count, piece, msgBytes: (totHi << 8) | totLo, id: (idHi << 8) | idLo, fields: f, bad: false });
      c.parity = bodyParity(len + 2, this.m.bits);
      c.bodyBytes = len + 2 + c.parity;
      c.total = this.headerSyms + symbolsFor(c.bodyBytes, this.m.bits);
    }
    _header(c) {
      const f = this._parseHeader(prepare(c.rows, this.m.lag));
      if (f) { this._setHeader(c, f); this._progress(c); return; }
      // too faint (or not a packet at all): keep listening as if a full-size part followed, so this copy can be
      // stacked onto the next repeats of the sound
      c.bad = true; c.total = this.headerSyms + this.maxBodySyms;
    }

    _body(c) {
      c.done = true;
      const norm = prepare(c.rows.slice(this.headerSyms), this.m.lag);
      const key = `${c.id}:${c.index}:${c.len}`;
      let payload = this._tryBody(norm, c);
      if (payload === null) {
        // combine with an earlier failed copy of this same part
        const prev = this.failed.get(key);
        if (prev && prev.sum.length === norm.length && this.store.total - prev.at < this.sr * 300) {
          for (let i = 0; i < norm.length; i++) for (let k = 0; k < this.m.dataTones; k++) prev.sum[i][k] += norm[i][k];
          prev.at = this.store.total;
          payload = this._tryBody(prev.sum, c);
        } else {
          this.failed.set(key, { sum: norm, at: this.store.total });
        }
      }
      if (payload !== null) { this.failed.delete(key); this._deliver(c, payload); return; }
      if (!this._stack(c) && this.h.onError) this.h.onError(this.m.name);
    }

    // Repeat stacking. Every play is the same sound, so copies that each failed alone are added together,
    // symbol by symbol, before decoding: 5 faint plays carry ~7 dB more than one. Copies are matched by timing:
    // an earlier copy d samples back, plus whatever arrived 2d, 3d… back (missing plays are skipped). This works
    // even when no header ever decoded on its own, and keeps the parts of a multi-part link apart.
    _stack(c) {
      c.done = true;
      const now = c.b0, T = c.T0;
      this.bad = this.bad.filter(q => now - q.b0 < this.sr * 240);
      const me = { b0: c.b0, rows: c.rows, speed: c.speed }, prevs = this.bad.filter(q => q.speed === c.speed);
      this.bad.push(me);
      const tried = new Set();
      for (let pi = prevs.length - 1; pi >= 0; pi--) {
        const d = now - prevs[pi].b0;
        if (d < 10 * T) continue;
        const group = [me];
        for (let j = 1; j <= 6; j++) {
          const t = now - j * d, q = prevs.find(x => Math.abs(x.b0 - t) < 0.5 * T + 0.002 * j * d);
          if (q) group.push(q);
        }
        const key = group.map(q => Math.round(q.b0)).join();
        if (tried.has(key)) continue;
        tried.add(key);
        if (this._tryGroup(group, c)) { this.bad = this.bad.filter(q => !group.includes(q)); return true; }
      }
      return false;
    }
    _tryGroup(group, c) {
      const hs = this.headerSyms, K = this.m.dataTones;
      const sum = (from, to) => {
        let acc = null;
        for (const q of group) {
          if (q.rows.length < to) continue;
          const n = prepare(q.rows.slice(from, to), this.m.lag);
          if (!acc) acc = n.map(r => r.slice()); else for (let i = 0; i < n.length; i++) for (let k = 0; k < K; k++) acc[i][k] += n[i][k];
        }
        return acc;
      };
      const f = this._parseHeader(sum(0, hs));
      if (!f) return false;
      const t = Object.assign({}, c);
      this._setHeader(t, f);
      const body = sum(hs, t.total);
      if (!body) return false;
      const payload = this._tryBody(body, t);
      if (payload === null) return false;
      this._deliver(t, payload);
      return true;
    }

    _deliver(c, payload) {
      // where the packet (and its music, if the sender played it) started
      const Tms = c.T0 / this.sr * 1000, start = c.b0 - 4 * c.T0 * (this.m.preambleMult || 1) - (this.m.leadToneMs || 0) / 1000 * this.sr;
      // the sender used one of the mode's speeds: snap to it, then rebuild the whole play's layout from the header
      const T = Object.values(this.m.speeds).reduce((a, b) => (Math.abs(b - Tms) < Math.abs(a - Tms) ? b : a));
      const L = layoutFor(this.m.name, T, c.msgBytes, c.piece), p = PIECES[c.piece];
      const playStart = start - (L.starts[c.index] + LEAD_MS) / 1000 * this.sr;
      // this part checks the stretch of music that plays over it (the last part: to the end of the piece)
      const from = p ? Math.ceil(L.starts[c.index] / L.ms * p.steps - 1e-9) : 0;
      const to = p ? (c.index + 1 < c.count ? Math.ceil(L.starts[c.index + 1] / L.ms * p.steps - 1e-9) : p.steps) : 0;
      const w = { start: playStart, ms: L.ms, from, to, end: p ? playStart + ((to / p.steps) * L.ms / 1000 + 0.45) * this.sr : 0,
        part: { payload, index: c.index, count: c.count, id: c.id, piece: c.piece } };
      if (w.end <= this.store.total) this._finishPart(w);
      else { this.waiting.push(w); this.waiting.sort((a, b) => a.end - b.end); }
    }

    _tryBody(norm, c) {
      const bytes = this._bytes(norm, c.bodyBytes, this.HB);
      const word = bytes.map(x => x.byte);
      const order = bytes.map((x, i) => i).sort((i, j) => bytes[i].conf - bytes[j].conf);
      for (const nErase of [0, Math.floor(c.parity / 2), c.parity, Math.floor(c.parity * 0.75)]) {
        const erase = order.slice(0, nErase).filter(i => bytes[i].conf < 4);
        try {
          const msg = rsDecode(word, c.parity, erase);
          const payload = msg.slice(0, c.len), crc = (msg[c.len] << 8) | msg[c.len + 1];
          if (crc16([...c.fields, ...payload]) !== crc) continue;
          return payload;
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
      const L = this.m.lag;
      for (let i = L; i < syms.length; i++) if (syms[i].v === syms[i - L].v) syms[i].conf = Math.min(syms[i].conf, 1.5);
      const bytes = symbolsToBytes(syms, this.m.bits, nBytes);
      const dw = whiten(bytes.map(x => x.byte), whitenOffset);
      bytes.forEach((x, i) => { x.byte = dw[i]; });
      return bytes;
    }

    _progress(c) {
      const best = this.cands.filter(k => k.total && !k.done).sort((a, b) => b.k - a.k)[0];
      if (best === c && this.h.onProgress) this.h.onProgress(c.k, c.total, this.m.name, { index: c.index, count: c.count });
    }
  }

  /**
   * Listens for every mode at once and puts multi-part messages back together. Handlers:
   *   onMessage(text, mode, {melody: {heard, piece}, parts})   a complete message (heard = every part had its music)
   *   onPart({index, count, have}, mode)               a part arrived (have = how many distinct parts so far)
   *   onError(mode), onProgress(done, total, mode, {index, count}), onDetect(mode),
   *   onFrame(mode, levels, toneIdx, meterDb)   levels = each tone's loudness relative to its background; meterDb = signal strength
   */
  class MultiDecoder {
    constructor(sampleRate, handlers = {}, modes = Object.keys(MODES)) {
      this.store = new SampleStore(sampleRate);
      this.h = handlers;
      this.messages = new Map();   // id -> {count, parts[], heard[]}
      this.decoders = modes.filter(n => MODES[n].freqs[MODES[n].freqs.length - 1] < sampleRate * 0.47).map(n => new Decoder(sampleRate, n, this.store, {
        onPart: (p, mode) => this._part(p, mode),
        onError: handlers.onError, onDetect: handlers.onDetect,
        onProgress: handlers.onProgress,
        onFrame: handlers.onFrame ? (lv, t, db) => handlers.onFrame(n, lv, t, db) : null,
      }));
    }
    push(samples) {
      this.store.write(samples);
      for (const d of this.decoders) d.process();
    }
    _part(p, mode) {
      let msg = this.messages.get(p.id);
      if (!msg || msg.count !== p.count) { msg = { count: p.count, parts: new Array(p.count).fill(null), mel: new Array(p.count).fill(null) }; this.messages.set(p.id, msg); }
      msg.parts[p.index] = p.payload;
      // keep the best hearing of each part's stretch of music (a later repeat may have been clearer)
      const prev = msg.mel[p.index], score = m => (m.total ? m.matched / m.total : 0);
      if (!prev || score(p.melody) > score(prev)) msg.mel[p.index] = p.melody;
      const have = msg.parts.filter(Boolean).length;
      if (this.h.onPart) this.h.onPart({ index: p.index, count: p.count, have }, mode);
      if (have < p.count) return;
      const bytes = [].concat(...msg.parts);
      this.messages.delete(p.id);
      if (crc16(bytes) !== p.id) { if (this.h.onError) this.h.onError(mode); return; }
      // room-only (live) messages are handed over as bytes for the app to check
      let text = null;
      if (!isSpecial(bytes)) { try { text = unpackMessage(bytes); } catch (e) { return; } }
      // add every part's counts together and judge the whole piece at once
      const sum = msg.mel.reduce((a, m) => ({ matched: a.matched + m.matched, total: a.total + m.total, expected: a.expected + m.expected }), { matched: 0, total: 0, expected: 0 });
      if (this.h.onMessage) this.h.onMessage(text, mode, { melody: { heard: !!PIECES[p.piece] && melodyHeard(sum), piece: p.piece, name: pieceName(p.piece), score: `${sum.matched}/${sum.total}` }, parts: p.count, special: text === null ? bytes : null });
    }
  }

  function hann(N) {
    const w = new Float64Array(N); let s = 0;
    for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); s += w[i]; }
    w.sum = s; return w;
  }
  function argmax(r) { let a = 0; for (let k = 1; k < r.length; k++) if (r[k] > r[a]) a = k; return a; }

  // Per-tone background normalisation, then learned echo cancelling.
  // lag: how many symbols back the last one on the same tones was (2 when symbols alternate between two sets).
  function prepare(rows, lag = 1) {
    const norm = normalize(rows), n = norm.length, hard = norm.map(argmax), leaks = [];
    for (let i = lag; i < n; i++) if (hard[i] !== hard[i - lag]) leaks.push(norm[i][hard[i - lag]] / Math.max(1e-15, norm[i - lag][hard[i - lag]]));
    leaks.sort((a, b) => a - b);
    const leak = leaks.length ? Math.min(0.5, leaks[Math.floor((leaks.length - 1) * 0.75)] * 1.5) : 0;
    const clean = norm.map((r, i) => {
      const o = r.slice();
      if (i >= lag) { const p = hard[i - lag]; o[p] = Math.max(0, o[p] - leak * norm[i - lag][p]); }
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
    encode, encodeParts, renderPlay, playMs, playLayout, PART_BYTES, synthesize, synthesizeMelody, checkMelody, packetMs, PIECES, pieceName, noteLen, rankPieces, fitCost, pieceMs, layoutFor, partLens, melodyHeard, durationMs, Decoder, MultiDecoder, safeUrl, utf8Encode, crc16, packMessage, unpackMessage, QUICK, LIVE, LIVE_GRACE_S, liveMessage, readLive, isSpecial, headerBytes,
    rs: { encode: rsEncode, decode: rsDecode }, _prep: prepare, _bits: { bytesToSymbols, symbolsToBytes },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Pulse;
  else root.Pulse = Pulse;
})(typeof self !== 'undefined' ? self : this);
