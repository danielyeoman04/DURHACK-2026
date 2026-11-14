// Für Elise layer: the link still decodes with the music on top, and the receiver can tell whether the music was there.
const P = require('../pulse.js');
const T = require('./decode.test.js');

function run(name, { melody = true, snrDb = 100, speed = 'normal', sr = 48000, plays = 1 }) {
  const text = 'https://durhack.com/';
  const segs = P.encode(text, { mode: 'high', speed });
  const lead = 80;
  const data = P.synthesize(segs, sr, { leadMs: lead, tailMs: 350 });
  const mel = P.synthesizeMelody(P.durationMs(segs), sr, 0.3);
  const one = new Float32Array(Math.max(data.length, mel.length + Math.round(sr * lead / 1000)));
  one.set(data);
  if (melody) for (let i = 0; i < mel.length; i++) one[i + Math.round(sr * lead / 1000)] += mel[i];
  let x = T.room(one, sr);
  const pre = new Float32Array(sr), parts = [pre]; for (let p = 0; p < plays; p++) parts.push(x);
  const n = parts.reduce((a, p) => a + p.length, 0), y = new Float32Array(n); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; }
  if (snrDb < 100) {
    const nz = T.babble(n, sr), rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const g = rms(data) / rms(nz) / Math.pow(10, snrDb / 20); for (let i = 0; i < n; i++) y[i] += nz[i] * g;
  }
  const got = [];
  const d = new P.MultiDecoder(sr, { onMessage: (m, md, info) => got.push({ m, heard: info.melody.heard, s: `${info.melody.matched}/${info.melody.total}` }) }, ['high']);
  for (let i = 0; i < n; i += 2048) d.push(y.subarray(i, i + 2048));
  const ok = got.length > 0 && got.every(g => g.m === text && g.heard === melody);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} ${got.map(g => `link ok, Für Elise ${g.heard ? 'heard' : 'not heard'} (${g.s})`).join('; ') || 'nothing decoded'}`);
  return ok;
}

const cases = [
  ['with Für Elise', {}],
  ['without Für Elise', { melody: false }],
  ['with Für Elise, fast', { speed: 'fast' }],
  ['with Für Elise, slow', { speed: 'slow' }],
  ['with Für Elise, 44.1 kHz', { sr: 44100 }],
  ['with Für Elise + crowd babble 0 dB', { snrDb: 0 }],
  ['without Für Elise + crowd babble 0 dB', { melody: false, snrDb: 0 }],
];
let pass = 0; for (const [n, o] of cases) if (run(n, o)) pass++;
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
