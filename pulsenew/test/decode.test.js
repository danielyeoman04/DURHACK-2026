// Offline loopback tests: synthesize -> simulated room -> decode.
// Usage: node test/decode.test.js   (add --v1 style comparisons by editing CASES)
const P = require('../pulse.js');

let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function resample(x, ratio) {
  const n = Math.floor(x.length * ratio), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / ratio, j = Math.floor(t), f = t - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; }
  return y;
}
const rms = x => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

// --- noise generators (all return Float32Array of length n at sample rate sr) ---
function white(n) { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = gauss(); return y; }
function pink(n) { // Voss-ish 1/f
  const y = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) { const w = gauss(); b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w; y[i] = b0 + b1 + b2 + 0.02 * w; }
  return y;
}
// crowd babble: many talkers, each a voiced harmonic source with syllable-rate on/off and a formant-ish tilt
function babble(n, sr, talkers = 8) {
  const y = new Float32Array(n);
  for (let t = 0; t < talkers; t++) {
    let f0 = 90 + rnd() * 160, ph = 0, env = 0, target = 0, next = 0;
    const hiss = pink(n);
    for (let i = 0; i < n; i++) {
      if (i >= next) { target = rnd() < 0.65 ? 1 : 0; next = i + sr * (0.08 + rnd() * 0.25); f0 *= 0.9 + rnd() * 0.2; f0 = Math.min(280, Math.max(85, f0)); }
      env += (target - env) * 0.002;
      ph += 2 * Math.PI * f0 / sr;
      let v = 0;
      for (let h = 1; h * f0 < 7000; h += 1) v += Math.sin(h * ph) / h;   // -6 dB/oct harmonic tilt
      y[i] += env * (v * 0.5 + hiss[i] * (rnd() < 0.15 ? 2 : 0.3));       // voiced + fricative bursts
    }
  }
  return y;
}
// music: chords of harmonic notes changing every ~400 ms, plus a hi-hat
function music(n, sr) {
  const y = new Float32Array(n); let notes = [], next = 0; const ph = [0, 0, 0, 0];
  const hat = white(n);
  for (let i = 0; i < n; i++) {
    if (i >= next) { const root = 110 * Math.pow(2, Math.floor(rnd() * 24) / 12); notes = [1, 1.26, 1.5, 2].map(r => root * r); next = i + sr * 0.4; }
    let v = 0;
    notes.forEach((f, k) => { ph[k] += 2 * Math.PI * f / sr; for (let h = 1; h < 12; h++) v += Math.sin(h * ph[k]) / (h * h * 0.5 + 1); });
    const beat = (i % Math.round(sr * 0.25)) / sr; v += hat[i] * Math.exp(-beat * 60) * 3;
    y[i] = v;
  }
  return y;
}
// a single loud whistle/feedback squeal sitting right on a data tone
function whistle(n, sr, f) { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = Math.sin(2 * Math.PI * f * i / sr) * (1 + 0.3 * Math.sin(i / sr * 3)); return y; }

function room(x, sr, echoes = [[0.011, 0.5], [0.023, 0.35], [0.041, 0.25], [0.067, 0.15]]) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { let v = x[i]; for (const [d, g] of echoes) { const j = i - Math.round(d * sr); if (j >= 0) v += x[j] * g; } y[i] = v; }
  return y;
}

/** snrDb: signal RMS vs noise RMS over the whole recording (broadband, like a real room) */
function trial(text, mode, speed, { snrDb = 100, noise = 'babble', sr = 48000, txSr = 48000, drift = 1, plays = 2, echo = true, chunk = 2048 }) {
  const pkts = P.encodeParts(text, { mode, speed });
  let one = P.renderPlay(pkts, txSr);
  one = Float32Array.from({ length: one.length + Math.round(txSr * 0.6) }, (_, i) => one[i] || 0);
  one = resample(one, sr / txSr * drift);
  if (echo) one = room(one, sr);
  const lead = new Float32Array(Math.round(sr * 1.5));
  const parts = [lead]; for (let p = 0; p < plays; p++) parts.push(one);
  const n = parts.reduce((a, p) => a + p.length, 0), x = new Float32Array(n); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  const sig = rms(one);
  if (snrDb < 100) {
    const nz = noise === 'white' ? white(n) : noise === 'music' ? music(n, sr) : noise === 'whistle' ? whistle(n, sr, P.MODES[mode || 'standard'].freqs[5]) : noise === 'mix' ? addAll(babble(n, sr), music(n, sr)) : babble(n, sr);
    const g = sig / rms(nz) / Math.pow(10, snrDb / 20);
    for (let i = 0; i < n; i++) x[i] += nz[i] * g;
  }
  const got = [], modes = [];
  const d = new P.MultiDecoder(sr, { onMessage: (m, md) => { got.push(m); modes.push(md); } });
  for (let i = 0; i < n; i += chunk) d.push(x.subarray(i, i + chunk));
  return { ok: got.length > 0 && got.every(m => m === text) && modes.every(md => md === (mode || 'standard')), count: got.length, secs: P.playMs(pkts) / 1000 };
}
function addAll(a, b) { const ra = rms(a), rb = rms(b); for (let i = 0; i < a.length; i++) a[i] = a[i] / ra + b[i] / rb; return a; }

module.exports = { trial, babble, music, room };

if (require.main === module) {
  const url = 'https://durhack.com/';
  const long = 'https://example.org/some/really/long/path?with=query&and=more&utf8=héllo-✓';
  const cases = [
    ['loud: clean', url, 'loud', 'normal', {}],
    ['loud: fast', url, 'loud', 'fast', {}],
    ['loud: slow, long + UTF-8', long, 'loud', 'slow', {}],
    ['loud: 300-char link (10 parts)', 'https://example.org/' + 'a1b2c3d4e5'.repeat(28), 'loud', 'normal', {}],
    ['loud: 300-char link, babble -10 dB', 'https://example.org/' + 'a1b2c3d4e5'.repeat(28), 'loud', 'normal', { snrDb: -10, noise: 'mix' }],
    ['loud: 44.1k phone -> 48k laptop', url, 'loud', 'normal', { txSr: 44100 }],
    ['loud: 48k -> 44.1k + 0.1% drift', url, 'loud', 'fast', { sr: 44100, drift: 1.001 }],
    ['loud: white noise -10 dB', url, 'loud', 'fast', { snrDb: -10, noise: 'white' }],
    ['loud: babble + music -10 dB', url, 'loud', 'fast', { snrDb: -10, noise: 'mix' }],
    ['loud: whistle on a tone', url, 'loud', 'fast', { snrDb: 0, noise: 'whistle' }],
    ['high (Pulse8 sound): clean', url, 'high', 'normal', {}],
    ['high: babble + music -10 dB', url, 'high', 'normal', { snrDb: -10, noise: 'mix' }],
    ['whale: clean', url, 'whale', 'normal', {}],
    ['standard: babble + music -10 dB', url, 'standard', 'normal', { snrDb: -10, noise: 'mix' }],
    ['child: clean', url, 'child', 'normal', {}],
  ];
  let pass = 0;
  for (const [name, text, mode, speed, opt] of cases) {
    const r = trial(text, mode, speed, opt); if (r.ok) pass++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} decoded ${r.count}/${opt.plays || 2} plays  (${r.secs.toFixed(1)} s per play)`);
  }
  console.log(`\n${pass}/${cases.length} passed`);
  console.log('safeUrl', P.safeUrl('durhack.com'), P.safeUrl('javascript:alert(1)'));
  process.exit(pass === cases.length ? 0 : 1);
}
