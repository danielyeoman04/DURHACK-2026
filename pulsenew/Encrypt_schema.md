# Encrypt schema: signed pulses (handoff)

Plan for the "encrypt" feature in pulsenew. Read this, then `pulsenew/README.md`, which explains how the engine
works (message format bytes, parts, packets, receiver). This doc assumes you know that README.

## Goal, in one paragraph

A lecturer's pulse should be **provably theirs**. Anyone in the room can hear every pulse and can see the
projector, so a shared room code doesn't work: anyone who sees the code can send with it. Instead the
sender's device holds a **private key that never leaves it** and signs each pulse. The pulse carries the
**public key** and the signature. Receivers check the signature and show the sender as four
**fingerprint words** (e.g. `maple-river-otter-lamp`). The lecturer shows the same words on the projector,
and a receiver can **lock** to that sender, after which links from anyone else are ignored. All of this works
fully offline, because WebCrypto is built into browsers and Electron.

The threat this targets is someone messing about in a lecture hall, not a nation-state. Don't add more than
this plan asks for.

## Decisions already made (don't reopen them)

| Decision | Choice | Why |
|---|---|---|
| What "encrypt" means | **Signing, not secrecy.** Links stay readable by anyone. | Everyone in the room is meant to get the link. The problem is fake links, not eavesdropping. |
| Shared room code / PIN | **No** | Anyone who can see the code can forge links with it. |
| Online PIN registry | **No** | Breaks offline (the desktop app must work fully offline), and it would still need signatures to prove anything. |
| RSA ("prime numbers") | **No** | A 256-byte signature makes a play about 61 s long. |
| Algorithm | **Ed25519** via `crypto.subtle` | 32-byte public key, 64-byte signature. Supported in current Chrome, Firefox and Safari, in Electron 45 (the desktop app's version, Chromium 142) and in Node 26 (verified). |
| Key in every play | **Yes**, not a separate key-announcement message | Each play stands alone, a new listener needs only one play, and repeat stacking works as it does now. |
| Auto-open | Already **off by default** (commit `710151a`) | |
| Neural-network decoder, TESLA, encryption for secrecy | **Out of scope** | |
| Two senders at once (listen before playing, taking turns) | **Out of scope: a separate build after this one** | Signing only checks packets that already decoded. It can't separate two plays that overlap in time. Overlap handling changes the sender's play loop, not the crypto. Signed plays are about 5× longer, so they collide more often, which makes this the natural next build. |

## Where to build

**On the branch `feature/signed-pulses`, never on `main`.** pulsenew on `main` is live on Netlify
(<https://xericunitedeagleexperimental.netlify.app/>) and must not break.

- The branch already exists, is pushed to `origin`, and is checked out in the repo's main working copy. Work there. Check with `git branch --show-current` before your first commit. Don't create a worktree: if you ever do, never commit it into the repo. Commit `9822b4a` had to undo exactly that, because it broke Netlify's checkout. `.claude/worktrees/` is git-ignored.
- Commit and push to `feature/signed-pulses` as you go.
- Work only inside `pulsenew/` on that branch. Don't touch `pulse1/` (the stable build) or `desktop/` (the team ports desktop to pulsenew later).
- Test on `localhost`. The mic, WebCrypto and the service worker all need https or localhost. Ports 8000 and 8001 are already used by old builds on the dev machine, so use something like 8010: `python -m http.server 8010 --bind 127.0.0.1`. To test on a phone you need https. If Netlify branch deploys are enabled, the branch gets its own preview URL. Ask the user. Never push to `main` to test.
- Merge to `main` only when the [done checklist](#done-when) passes **and the user says so**.

## Byte formats

Two format bytes, from the unused range (`7`–`9` and `11`–`255` are free; see the README table):

### `7`: signed message

```
[7] [public key: 32] [time: 4] [inner message: n] [signature: 64]
```

- **public key**: the sender's raw Ed25519 public key (`exportKey('raw')`).
- **time**: big-endian uint32, seconds since 2026-01-01 UTC. Reuse `EPOCH_2026` from the Live format in `pulse.js`. It is set once when Play is pressed, not per loop.
- **inner message**: exactly what `packMessage(text)` returns today (format byte `0`–`6`), so all link packing still applies.
- **signature**: Ed25519 over `utf8("pulse-signed-v1") ‖ [7] ‖ public key ‖ time ‖ inner message`. The fixed prefix stops a signature from being reused in another context.

Total = 101 + n bytes. Measured with the fast speed and no music:

| Link | Unsigned | Signed |
|---|---|---|
| `https://durhack.com/` (quick code, n = 2) | 3.7 s, 1 part | 25.0 s, 4 parts |
| YouTube link (n = 16) | 5.1 s, 1 part | 26.7 s, 4 parts |

The app currently warns when a play is longer than 20 s (`MAX_PLAY_S` in `app.js`). For signed plays, raise
the limit to about 40 s, or show "Signed pulses take longer" instead of the warning.

### `8`: reserved

Keep it free for an optional later optimisation: a separate key announcement, where signed plays carry only a 4-byte key id (measured 20.3 s + a 10.1 s announcement). Don't build it now.

## Fingerprint words

- Words = the first 44 bits of `SHA-256(public key)`, split into 4 × 11 bits, used as indexes into the **BIP-39 English word list** (2048 words). Join them with `-`.
- Bundle the list as a file in `pulsenew/vendor/` so it works offline (BIP-39 is MIT-licensed; keep the licence note), and add it to `FILES` in `sw.js`.
- 44 bits is enough against a prankster, but not against a determined attacker with a GPU farm. Say so in the README.

## Code layout

Keep `pulse.js` changes small. Put the crypto in a new file.

### New `pulsenew/secure.js` (browser `window.PulseSecure` + Node `module.exports`, same pattern as `pulse.js`)

```js
loadOrCreateKeys()            // -> {privateKey (non-extractable), publicKey, publicRaw: Uint8Array(32)}; stored in IndexedDB
newKeys()                     // replace the stored pair ("New identity" button)
fingerprint(publicRaw)        // -> Promise<'maple-river-otter-lamp'>
signMessage(text, keys, at)   // -> Promise<number[]> format-7 bytes (inner = Pulse.packMessage(text))
readSigned(bytes, now)        // -> Promise<{ok, text, publicRaw, words, ageS} | {ok:false, reason}>
supported()                   // -> Promise<boolean>; false if Ed25519 is missing (old browsers)
```

- **Storing the key:** `CryptoKey` objects can be put directly into IndexedDB (structured clone). Generate the pair with `extractable: false` for the private key, so not even the app's own JS can read the private key's bytes. That is the "hidden even from the user" property the user asked for. `localStorage` can't hold a `CryptoKey`.
- All of it is async. The send path in `app.js` is currently synchronous (`update()` → `P.encodeParts`), so build the signed bytes before calling `encodeParts(null, {payload: bytes, …})`. The `payload` option already exists, and the Live format uses it.

### Changes to `pulse.js`

- `isSpecial(bytes)`: also true for `bytes[0] === 7`, so `MultiDecoder` passes signed messages to the app as raw bytes in `info.special`. That route already exists for Live.
- Export a `SIGNED = 7` constant next to `LIVE`.
- Nothing else. The packet layer, decoder and stacking don't change.

### Changes to `app.js` / `index.html`

**New tab.** Label it "Secure" by default, because it signs rather than encrypts. Ask the user if they want "Encrypt".

Sender part:
- A "Sign my pulses" switch, off by default.
- Your fingerprint words, large, with a hint telling the lecturer to put them on the slides.
- A "New identity" button (with a confirm), which replaces the key pair.
- When the switch is on, Send plays signed bytes, and the **QR tab shows the words under the QR code** so the projector shows them too.
- If `supported()` is false, disable the switch and show "This browser can't sign."

Receiver part (in `onMessage`, next to the Live branch):

| Case | Show |
|---|---|
| Valid signature, not locked | The link, plus "Signed by **maple-river-otter-lamp**" and a **Lock to this sender** button |
| Valid signature, locked, same key | The link, plus "Signed by maple-river-otter-lamp ✓" |
| Locked, and the link is unsigned or from another key | Don't show it as the result or add it to Recent. Status line: "Ignored a link not from maple-river-otter-lamp" |
| Bad signature (tampered) | Reject. Status: "Rejected a link with a bad signature" |
| `ageS` > 12 h, or more than 5 min in the future | Reject as a replay or clock problem, with a clear status |
| Browser can't verify | Show the link marked "Signature not checked" and never auto-open it |

- The lock is stored as the public key (base64) in `localStorage` (`pulse10-lock`), with an **Unlock** button in the Secure tab and in the result box.
- Recent entries for signed links show the words.

### Service worker

Add `secure.js` and the word list to `FILES` in `sw.js`, and bump `CACHE` (currently `pulse10-v4`).

## Tests

Add `pulsenew/test/secure.test.js` (Node 26 has `crypto.subtle` with Ed25519):

1. Sign → read round-trip for the `pack.test.js` links: `ok`, the same text, the same words.
2. Flip any one byte (key, time, inner message, signature) → `ok:false`.
3. A signature from key A with key B's public key spliced in → `ok:false`.
4. Age > 12 h and > 5 min in the future → rejected.
5. The same public key always gives the same words, and the words come from the list.
6. **Loopback:** render a signed message with `encodeParts(null, {payload})` + `renderPlay`, run it through the room model in `test/decode.test.js` (export or reuse `trial`, adding a `payload` option), decode with `MultiDecoder`, then `readSigned` the `special` bytes → `ok`. Do one clean case and one with babble + music at −10 dB.

Existing tests must still pass: `node test/pack.test.js`, `node test/melody.test.js`, and `node test/decode.test.js`. The decode test takes about 9 minutes, so run it in the background or hand it to the `pulse-tester` subagent (`.claude/agents/pulse-tester.md`).

## Done when

- [ ] All tests above pass, including the existing ones.
- [ ] Tested on localhost: two browser windows or devices, one signing and one receiving. Lock, ignore an unsigned link while locked, unlock.
- [ ] Unsigned sending and receiving work exactly as before when the switch is off. The live site's behaviour can't change for people who don't use the Secure tab.
- [ ] Works with the network off (DevTools → offline), after one load.
- [ ] `pulsenew/README.md` has a "Signed pulses" section: formats `7`/`8` in the format table, fingerprint words, the lock, the 44-bit caveat, and the play lengths.
- [ ] The user has tested it and agreed to merge to `main`.

## Time box

The hackathon deadline is 12:00 on 2026-11-15, and the team also needs time for a presentation and repo
polish. If the signing isn't solid about **3 hours before the deadline**, stop. Leave the branch unmerged
and present signing as future work. A half-working feature on the live site is worse than none.

## Later (not now)

- Port to `desktop/`. It currently bundles `pulse1`, and the team will move it to pulsenew. Electron 45 already supports Ed25519. Check that `crypto.subtle` is available on `file://` pages there.
- Format `8` key announcements, to make plays shorter.
