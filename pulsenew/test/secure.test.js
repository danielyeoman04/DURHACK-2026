// Signed pulses: a signed link must read back with its sender's words, and any tampering must be refused.
const P = require('../pulse.js');
const S = require('../secure.js');
const WORDS = require('../vendor/bip39-english.js');
const { trial } = require('./decode.test.js');
const links = ['https://durhack.com', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://is.gd/aB3xYz',
  'https://durhack.com/schedule/2026/workshops?track=composition&room=great-hall', 'http://example.org/ünïcødé?q=Ä B', 'hello world'];

let pass = 0, total = 0;
function check(ok, name, detail = '') {
  total++; if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}
const flip = (bytes, i, bit = 0) => { const b = bytes.slice(); b[i] ^= 1 << bit; return b; };
// the same sum done a second way: SHA-256, first 44 bits, four 11-bit indexes, most significant first
function expectedWords(publicRaw) {
  const v = BigInt('0x' + require('crypto').createHash('sha256').update(Buffer.from(publicRaw)).digest('hex')) >> 212n;
  return [33n, 22n, 11n, 0n].map(s => WORDS[Number((v >> s) & 2047n)]).join('-');
}

(async () => {
  check(await S.supported(), 'this Node can sign and verify Ed25519');
  const A = await S.newKeys(), B = await S.newKeys();
  const wordsA = await S.fingerprint(A.publicRaw), wordsB = await S.fingerprint(B.publicRaw);

  // 1. round trip
  for (const t of links) {
    const b = await S.signMessage(t, A), inner = P.packMessage(t).length, r = await S.readSigned(b);
    const ok = r.ok && r.text === t && r.words === wordsA && b.length === 101 + inner && b[0] === 7;
    check(ok, `round trip: ${t.length} chars -> ${b.length} bytes  ${t}`, ok ? '' : JSON.stringify({ ...r, publicRaw: undefined, len: b.length, want: 101 + inner }));
  }

  // 2. one flipped bit anywhere
  const T = Date.UTC(2026, 5, 1, 12, 0, 0), text = 'https://durhack.com/';
  const good = await S.signMessage(text, A, T), n = good.length;
  check((await S.readSigned(good, T)).ok, `untouched message reads (${n} bytes)`);
  for (const [region, i] of [['key', 10], ['time', 35], ['inner message', 37 + ((n - 101) >> 1)], ['signature', n - 30]]) {
    const r = await S.readSigned(flip(good, i, 3), T);
    check(r.ok === false, `flipped bit in the ${region} (byte ${i})`, `-> ${r.ok ? 'ACCEPTED' : r.reason}`);
  }
  const reasons = {}, accepted = [];
  for (let i = 0; i < n; i++) {
    const r = await S.readSigned(flip(good, i, i % 8), T);
    if (r.ok !== false) accepted.push(i); else reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  check(!accepted.length, `flipped bit in each of the ${n} bytes in turn`, accepted.length ? `ACCEPTED at bytes ${accepted.join(',')}` : JSON.stringify(reasons));

  // 3. someone else's public key on A's signature
  const spliced = good.slice(); for (let i = 0; i < 32; i++) spliced[1 + i] = B.publicRaw[i];
  const sp = await S.readSigned(spliced, T);
  check(sp.ok === false && sp.reason === 'bad-signature', `key B spliced onto key A's signature`, `-> ${sp.ok ? 'ACCEPTED' : sp.reason}`);

  // 4. age
  const MIN = 60e3, H = 3600e3;
  for (const [name, now, want] of [
    ['12 h + 60 s old', T + 12 * H + MIN, 'old'], ['11 h 59 min old', T + 12 * H - MIN, true],
    ['5 min + 60 s in the future', T - 5 * MIN - MIN, 'future'], ['4 min in the future', T - 4 * MIN, true]]) {
    const r = await S.readSigned(good, now), ok = want === true ? r.ok === true && r.text === text : r.ok === false && r.reason === want;
    check(ok, `age: ${name}`, `-> ${r.ok ? 'ok' : r.reason} (ageS ${r.ageS})`);
  }

  // 5. fingerprint words
  const viaRead = (await S.readSigned(good, T)).words, again = await S.fingerprint(A.publicRaw);
  check(wordsA === again && wordsA === viaRead, 'same key, same words every time', wordsA);
  const ws = wordsA.split('-');
  check(ws.length === 4 && ws.every(w => WORDS.includes(w)) && WORDS.length === 2048, 'four words from the 2048-word BIP-39 list');
  check(wordsA !== wordsB, 'two keys, different words', `${wordsA} / ${wordsB}`);
  const fixed = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
  check(wordsA === expectedWords(A.publicRaw) && wordsB === expectedWords(B.publicRaw) && await S.fingerprint(fixed) === expectedWords(fixed),
    'words match SHA-256 worked out separately', `${await S.fingerprint(fixed)} = ${expectedWords(fixed)}`);

  // 6. cut short
  for (const [name, b] of [['first 50 bytes only', good.slice(0, 50)], ['empty', []], ['last byte missing', good.slice(0, -1)]]) {
    const r = await S.readSigned(b, T);
    check(r.ok === false, `cut short: ${name}`, `-> ${r.ok ? 'ACCEPTED' : r.reason}`);
  }

  // 7. through the simulated room (slow: a signed play is long)
  const live = await S.signMessage(text, A), words = wordsA;
  for (const [name, opt] of [['clean', {}], ['babble + music -10 dB', { snrDb: -10, noise: 'mix' }]]) {
    const t0 = Date.now(), r = trial(null, 'loud', 'fast', { payload: live, music: 0, ...opt });
    const read = r.ok ? await S.readSigned(r.specials[0]) : null, ok = !!read && read.ok && read.text === text && read.words === words;
    check(ok, `loopback, ${name}`, `decoded ${r.count}/2 plays  (${r.secs.toFixed(1)} s per play, took ${((Date.now() - t0) / 1000).toFixed(0)} s)${read && !read.ok ? '  -> ' + read.reason : ''}`);
  }

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
