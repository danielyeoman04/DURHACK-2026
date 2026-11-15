// Simulated range test: how far away can each mode still be decoded in a reverberant lecture hall?
// Usage: node test/range.test.js [--quick]
//
// THIS IS A SIMULATION, NOT A MEASUREMENT. The model:
//  - the direct sound falls 6 dB per doubling of distance (1/d), from 1 m;
//  - the hall adds diffuse reverb (decaying noise, RT60 0.6 s: a hall's reverb is shorter at 17 kHz than for speech,
//    because air and the audience soak up high frequencies; 1.2 s is also run as a worst case) whose level doesn't change with distance, set so that
//    direct and reverb are equally loud at 4 m (the "critical distance" of a medium lecture hall);
//  - a fixed background hiss (white noise) at the microphone, set so a 17 kHz tone at 1 m is 25 dB above it in
//    the receiver's band (a phone at full volume, quiet-ish hall);
//  - phone speakers are weaker at 19–20.5 kHz than at 18.5–20 kHz. We assume 6 dB weaker (it was 12 dB vs 17–18.5) (speaker + microphone
//    roll-off together). This number varies a lot between phones; it is the main assumption behind "Near" vs "Room".
//  - 5 plays, as the app sends; a mode "reaches" a distance when the link decodes at least once within them.
const P = require('../pulse.js');

let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Real FFT-free overlap-add convolution with a simple radix-2 complex FFT
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function convolve(x, h) {
  const L = 1 << 16, M = h.length, B = L - M + 1, y = new Float32Array(x.length);
  const hr = new Float64Array(L), hi = new Float64Array(L); hr.set(h); fft(hr, hi, false);
  for (let o = 0; o < x.length; o += B) {
    const re = new Float64Array(L), im = new Float64Array(L);
    for (let i = 0; i < B && o + i < x.length; i++) re[i] = x[o + i];
    fft(re, im, false);
    for (let i = 0; i < L; i++) { const r = re[i] * hr[i] - im[i] * hi[i]; im[i] = re[i] * hi[i] + im[i] * hr[i]; re[i] = r; }
    fft(re, im, true);
    for (let i = 0; i < L && o + i < y.length; i++) y[o + i] += re[i];
  }
  return y;
}
// Diffuse hall reverb: exponentially decaying noise (the standard model of late reverberation), starting 8 ms
// after the direct sound and building up over 25 ms. Its level is set by the caller.
function hallIR(sr, rt60) {
  const n = Math.round(sr * Math.min(1.5, rt60 * 1.1)), h = new Float64Array(n), r = mkRnd(99);
  for (let i = 0; i < n; i++) {
    const t = i / sr; if (t < 0.008) continue;
    h[i] = r() * Math.exp(-6.9 * t / rt60) * Math.min(1, (t - 0.008) / 0.025);
  }
  return h;
}
function mkRnd(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; const u = s / 0x7fffffff; s = (s * 1103515245 + 12345) & 0x7fffffff; return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 0x7fffffff); }; }
const irCache = new Map();
function reverb(x, sr, rt60) {
  const key = sr + ':' + rt60;
  if (!irCache.has(key)) irCache.set(key, hallIR(sr, rt60));
  return convolve(x, irCache.get(key));
}
const rms = x => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };

const SR = 48000, RT60 = +(process.env.RT60 || 0.6), CRIT = 4, SNR1M_DB = 25, NEAR_LOSS_DB = 0, PLAYS = 5;

function trial(text, mode, dist, speed = 'normal', rt60 = RT60) {
  const parts = P.encodeParts(text, { mode, speed, music: 0 });   // music off, as the app defaults to
  const one = P.renderPlay(parts, SR);
  const lead = Math.round(SR * 1.0), n = lead + one.length * PLAYS + SR;
  const dry = new Float32Array(n);
  for (let p = 0; p < PLAYS; p++) dry.set(one, lead + p * one.length);
  const bandGain = mode === 'high' ? Math.pow(10, -NEAR_LOSS_DB / 20) : 1;
  const ref = rms(one);                                   // a full-volume play, at 1 m
  const r = reverb(dry, SR, rt60), rg = (bandGain * ref / CRIT) / rms(r.subarray(lead, lead + one.length));   // reverb = direct at CRIT metres
  // band noise: white noise whose power in a ~1.5 kHz band is SNR1M_DB below the 1 m signal
  const noiseRms = ref / Math.pow(10, SNR1M_DB / 20) * Math.sqrt((SR / 2) / 1500);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = dry[i] * bandGain / dist + r[i] * rg + gauss() * noiseRms;
  const got = [];
  const d = new P.MultiDecoder(SR, { onMessage: m => got.push(m) }, ['loud', 'high']);
  for (let i = 0; i < n; i += 4096) d.push(x.subarray(i, i + 4096));
  return { ok: got.length > 0 && got.every(m => m === text), count: got.length, secs: P.playMs(parts) / 1000 };
}

if (require.main === module) {
  const quick = process.argv.includes('--quick');
  const text = 'https://durhack.com/';
  const dists = quick ? [2, 4, 8, 16, 24] : [2, 3, 4, 6, 8, 11, 16, 22, 30, 40];
  const rows = [['Pulse8 sound (19–20.5 kHz)', 'high', 'normal'], ['Pulse10, Fast', 'loud', 'fast'], ['Pulse10, Normal', 'loud', 'normal']];
  for (const rt of [RT60, 1.2]) {
    console.log(`\nHall: RT60 ${rt} s, critical distance ${CRIT} m, 1 m band SNR ${SNR1M_DB} dB, ${PLAYS} plays`);
    for (const [label, mode, speed] of rows) {
      let reach = 0, firstFail = 0; const cells = [];
      for (const dist of dists) {
        seed = 11 + dist * 7;
        const r = trial(text, mode, dist, speed, rt);
        cells.push(`${dist}m:${r.ok ? r.count : '-'}`);
        if (r.ok && !firstFail) reach = dist; else if (!r.ok && !firstFail) firstFail = dist;
      }
      const secs = P.playMs(P.encodeParts(text, { mode, speed, music: 0 })) / 1000;
      console.log(`${label.padEnd(27)} ${secs.toFixed(1)} s/play  reaches ${String(reach).padStart(2)} m   [${cells.join(' ')}]`);
    }
  }
}
module.exports = { trial, reverb };
