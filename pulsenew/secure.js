/*
 * Signed pulses: proves which device sent a pulse. Signing, not secrecy: anyone can still read the link.
 *
 *   SIGNED  [7] [public key: 32] [time: 4] [inner message: n] [signature: 64]
 *
 *   public key  the sender's raw Ed25519 public key
 *   time        big-endian uint32, seconds since 2026-01-01 UTC, set when Play is pressed
 *   inner       exactly what Pulse.packMessage(text) returns (format byte 0-6)
 *   signature   Ed25519 over utf8("pulse-signed-v1") ‖ [7] ‖ public key ‖ time ‖ inner
 *
 * The private key is generated non-extractable and kept in IndexedDB, so not even this app's own code can
 * read its bytes. Receivers show the sender as four fingerprint words taken from SHA-256(public key).
 *
 * Works in the browser (window.PulseSecure) and in Node (module.exports). Everything here is async.
 */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const P = node ? require('./pulse.js') : root.Pulse;
  const WORDS = node ? require('./vendor/bip39-english.js') : root.BIP39_ENGLISH;
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;

  const SIGNED = P.SIGNED, KEY_LEN = 32, SIG_LEN = 64, HEAD_LEN = 1 + KEY_LEN + 4;
  const PREFIX = P.utf8Encode('pulse-signed-v1');
  const MAX_AGE_S = 12 * 3600, MAX_FUTURE_S = 5 * 60;
  const ALG = { name: 'Ed25519' };

  // ---------------------------------------------------------------- key storage (IndexedDB)
  const DB = 'pulse10-secure', STORE = 'keys', ID = 'identity';
  let memory = null;   // the pair in use; also the only copy where IndexedDB is missing (Node, private windows)
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  async function generate() {
    const pair = await subtle.generateKey(ALG, false, ['sign', 'verify']);   // false: the private key can't be exported
    const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw };
  }
  /** -> {privateKey, publicKey, publicRaw}. The same pair every time on this device, made on first use. */
  async function loadOrCreateKeys() {
    if (memory) return memory;
    try {
      const saved = await idb('readonly', s => s.get(ID));
      if (saved && saved.privateKey && saved.publicRaw) return memory = saved;
    } catch (e) { /* no storage: fall through to a pair that lasts until the page closes */ }
    return newKeys();
  }
  /** Replace the stored pair with a fresh one ("New identity"). The old private key is gone for good. */
  async function newKeys() {
    const keys = await generate();
    try { await idb('readwrite', s => s.put(keys, ID)); } catch (e) { /* kept in memory only */ }
    return memory = keys;
  }

  // ---------------------------------------------------------------- fingerprint words
  /** Raw public key -> 'maple-river-otter-lamp': the first 44 bits of its SHA-256 as 4 words of 11 bits. */
  async function fingerprint(publicRaw) {
    const h = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(publicRaw)));
    let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + h[i];   // 48 bits: exact in a double
    v = Math.floor(v / 16);                                      // keep the first 44
    const out = [];
    for (let i = 0; i < 4; i++) { out.unshift(WORDS[v % 2048]); v = Math.floor(v / 2048); }
    return out.join('-');
  }

  // ---------------------------------------------------------------- sign / read
  const signedData = body => new Uint8Array([...PREFIX, ...body]);   // body = [7, key, time, inner]
  /** Link + key pair + the time Play was pressed (ms) -> SIGNED bytes. */
  async function signMessage(text, keys, at = Date.now()) {
    const t = Math.max(0, Math.floor((at - P.EPOCH_2026) / 1000));
    const body = [SIGNED, ...keys.publicRaw, t >>> 24 & 255, t >> 16 & 255, t >> 8 & 255, t & 255, ...P.packMessage(text)];
    const sig = new Uint8Array(await subtle.sign(ALG, keys.privateKey, signedData(body)));
    return [...body, ...sig];
  }
  /**
   * SIGNED bytes -> {ok:true, text, publicRaw, words, ageS}, or {ok:false, reason, ...}.
   * reason: 'malformed' | 'bad-signature' | 'old' | 'future' | 'unsupported'.
   * 'old' and 'future' had a good signature, so they also carry text/publicRaw/words/ageS.
   * 'unsupported' (this browser has no Ed25519) carries the unchecked text and ageS: never trust or auto-open it.
   */
  async function readSigned(bytes, now = Date.now()) {
    bytes = Array.from(bytes);
    if (bytes[0] !== SIGNED || bytes.length < HEAD_LEN + 1 + SIG_LEN) return { ok: false, reason: 'malformed' };
    const body = bytes.slice(0, bytes.length - SIG_LEN), sig = new Uint8Array(bytes.slice(bytes.length - SIG_LEN));
    const publicRaw = new Uint8Array(body.slice(1, 1 + KEY_LEN));
    const t = ((body[33] << 24) | (body[34] << 16) | (body[35] << 8) | body[36]) >>> 0;
    const ageS = (now - P.EPOCH_2026) / 1000 - t;
    let text;
    try { text = P.unpackMessage(body.slice(HEAD_LEN)); } catch (e) { return { ok: false, reason: 'malformed' }; }
    if (!(await supported())) return { ok: false, reason: 'unsupported', text, publicRaw, ageS };
    let good = false;
    try {
      const key = await subtle.importKey('raw', publicRaw, ALG, false, ['verify']);
      good = await subtle.verify(ALG, key, sig, signedData(body));
    } catch (e) { good = false; }   // e.g. 32 bytes that aren't a valid public key
    if (!good) return { ok: false, reason: 'bad-signature' };
    const info = { text, publicRaw, words: await fingerprint(publicRaw), ageS };
    if (ageS > MAX_AGE_S) return { ok: false, reason: 'old', ...info };
    if (ageS < -MAX_FUTURE_S) return { ok: false, reason: 'future', ...info };
    return { ok: true, ...info };
  }

  let can = null;
  /** -> true if this browser can sign and verify Ed25519 (old browsers can't). */
  function supported() {
    if (!can) can = (async () => {
      try {
        const pair = await subtle.generateKey(ALG, false, ['sign', 'verify']), data = new Uint8Array([1, 2, 3]);
        return await subtle.verify(ALG, pair.publicKey, await subtle.sign(ALG, pair.privateKey, data), data);
      } catch (e) { return false; }
    })();
    return can;
  }

  const Secure = { loadOrCreateKeys, newKeys, fingerprint, signMessage, readSigned, supported, MAX_AGE_S, MAX_FUTURE_S, SIGNED };
  if (node) module.exports = Secure;
  else root.PulseSecure = Secure;
})(typeof self !== 'undefined' ? self : this);
