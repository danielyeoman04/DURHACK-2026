// Link packing: every message must come back exactly as it went in, and links should get shorter.
const P = require('../pulse.js');
const links = ['https://durhack.com', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://is.gd/aB3xYz',
  'https://durhack.com/schedule/2026/workshops?track=composition&room=great-hall', 'http://example.org/ünïcødé?q=Ä B', 'hello world'];
let bad = 0;
for (const t of links) {
  const b = P.packMessage(t), ok = P.unpackMessage(b) === t; if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.length} chars -> ${b.length} bytes  ${t}`);
}
let fuzzBad = 0;
for (let i = 0; i < 20000; i++) {
  let s = ''; const n = 1 + Math.random() * 80 | 0;
  for (let j = 0; j < n; j++) { const r = Math.random(); s += r < 0.7 ? String.fromCharCode(97 + Math.random() * 26 | 0) : r < 0.8 ? String.fromCharCode(65 + Math.random() * 26 | 0) : r < 0.9 ? './-?=&_#%:~+ '[Math.random() * 13 | 0] : String.fromCodePoint(160 + Math.random() * 2000 | 0); }
  if (Math.random() < 0.5) s = 'https://' + s;
  if (P.unpackMessage(P.packMessage(s)) !== s) fuzzBad++;
}
console.log(`${fuzzBad ? 'FAIL' : 'PASS'}  20000 random strings round-trip (${fuzzBad} bad)`);
process.exit(bad || fuzzBad ? 1 : 0);
