// Classical music layer: the link still decodes with the music on top, and the receiver can tell whether the music was there.
const P = require('../pulse.js');
const T = require('./decode.test.js');

function run(name, { melody = true, snrDb = 100, speed = 'normal', sr = 48000, plays = 1, long = false, chars = 0, music = 'auto', fake = 0 }) {
  const text = chars ? 'https://example.org/' + 'x'.repeat(chars - 20) : long ? 'https://example.org/path/' + 'x'.repeat(70) + '?q=ünïcødé' : 'https://durhack.com/';
  const segs = P.encodeParts(text, { mode: 'high', speed, music });
  const piece = segs[0].piece;
  if (fake) for (const s of segs) s.piece = fake;   // header says one piece, a different one is played
  const one = P.renderPlay(segs, sr, { melody });
  if (fake) melody = false;
  let x = T.room(one, sr);
  const pre = new Float32Array(sr), parts = [pre]; for (let p = 0; p < plays; p++) parts.push(x); parts.push(new Float32Array((fake ? 18 : 6) * sr));
  const n = parts.reduce((a, p) => a + p.length, 0), y = new Float32Array(n); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; }
  if (snrDb < 100) {
    const nz = T.babble(n, sr), rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const g = rms(one) / rms(nz) / Math.pow(10, snrDb / 20); for (let i = 0; i < n; i++) y[i] += nz[i] * g;
  }
  const got = [];
  const d = new P.MultiDecoder(sr, { onMessage: (m, md, info) => got.push({ m, heard: info.melody.heard, mm: info.melody.score, s: `${info.parts} part(s)`, name: info.melody.name }) }, ['high']);
  for (let i = 0; i < n; i += 2048) d.push(y.subarray(i, i + 2048));
  const ok = got.length > 0 && got.every(g => g.m === text && g.heard === melody && g.name === P.pieceName(piece));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${got.map(g => `link ok, ${g.name} ${g.heard ? 'heard' : 'not heard'} ${g.mm || ''} (${g.s})`).join('; ') || 'nothing decoded'}`);
  return ok;
}

const cases = [
  ['with music (auto)', {}],
  ['without music', { melody: false }],
  ['fast', { speed: 'fast' }],
  ['slow', { speed: 'slow' }],
  ['44.1 kHz', { sr: 44100 }],
  ['crowd babble 0 dB', { snrDb: 0 }],
  ['without music + crowd babble 0 dB', { melody: false, snrDb: 0 }],
  ['long link (multi-part), auto', { long: true }],
  ['long link (multi-part) without music', { long: true, melody: false }],
  ['auto, 200 chars', { chars: 200 }],
  ['auto, 120 chars + babble 0 dB', { chars: 120, snrDb: 0 }],
  ['auto, 80 chars, 2 plays + babble 0 dB', { chars: 80, snrDb: 0, plays: 2 }],
  ...P.PIECES.map((p, i) => p && [`${p.name}`, { music: i }]).filter(Boolean),
  ...P.PIECES.map((p, i) => p && [`${p.name} + babble 0 dB`, { music: i, snrDb: 0 }]).filter(Boolean),
  ...P.PIECES.map((p, i) => p && [`says ${p.name}, plays another (rejected)`, { music: i, fake: i === 1 ? 3 : 1 }]).filter(Boolean),
];
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
let pass = 0, n = 0; for (const [name, o] of cases) if (!only || only.test(name)) { n++; if (run(name, o)) pass++; }
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
