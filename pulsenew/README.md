# Pulse (pulsenew)

An acoustic QR code: one device plays a link as sound and every device nearby with a microphone receives it.
The sound sits at 19.5–20.65 kHz, which most adults can't hear. A QR tab shows the same link on a projector
for anyone without a working mic. It works offline as an installable web app.

Live: <https://xericunitedeagleexperimental.netlify.app/> · The code calls this version **Pulse10**. Older
versions are in `../pulse1` and `../pulsearchive`.

## Using it

| Tab | What it does |
|---|---|
| **Send** | Paste a link and press **Play**. The sound loops until you press it again. The chart shows the tones of every part on top and, with music on, the notes of the piece underneath. |
| **Receive** | Tap the logo to start listening. A heard link is shown with an **Open** button. Tick "Open links automatically" to open links in a new tab instead. It is off by default, so a prank link can't open by itself. A signal meter shows the strength in dB (weak / good / strong). Heard links go into **Recent**. Links heard while offline are saved and open when you're back online. |
| **QR** | Opens full screen for a projector. The sound keeps playing, so a room can scan or listen. |
| **Secure** | **Sign my pulses** proves a pulse came from your device, and shows your four fingerprint words. Receivers can lock to one sender. See [Signed pulses](#signed-pulses). |

Send settings (saved per device):

- **Music**: off by default. When it's on, a classical extract plays over the data (see [Music](#music)). **Another piece** switches to a different one.
- **Slower pulse**: uses the `slow` speed instead of `fast`. After 3 fast plays the app suggests switching.
- **Limit pulse to 3 repeats**: stops after 3 plays instead of looping.
- **Shorten long links**: links over 45 characters are swapped for an `is.gd` short link when you're online. The QR code still shows the full link.

The receiver has no settings. It decodes every speed, with or without music.

URL parameters: `?url=<link>` fills the Send box, `?mode=recv` opens Receive, and `?sound=<mode>` picks an engine mode (see [Hidden extras](#hidden-extras)).

## How it works

```
SEND
text ─► packMessage ─► splitParts ─► buildPacket (per part) ─► partSegs ─► renderPlay ─► AudioBufferSource (loop)
        format byte +   ≤32-byte      header + body,            symbols →    all parts +
        packed link     parts         Reed-Solomon, CRC,        tones        music, peak
                                      whitening                              at 98%

RECEIVE
mic ─► SampleStore ─► Decoder (one per mode) ───────────────────────────────► MultiDecoder ─► app.onMessage
       30 s ring       Goertzel per 30 ms frame → preamble matched filter →    collects parts
       buffer          symbol slicing + clock tracking → echo cancel /         by message id,
                       equalise → RS decode with erasures → CRC → combine /    checks CRC,
                       stack repeats                                           unpacks the text
```

All the signal code is in `pulse.js` and runs in both the browser (`window.Pulse`) and Node (`require`).
`app.js` contains only the UI.

### 1. Message bytes (`packMessage`)

Every message begins with a **format byte**:

| Format byte | Contents | Example |
|---|---|---|
| `0` | Raw UTF-8 text | `hello world`: 11 chars, 12 bytes |
| `1`–`5` | A packed link. The byte gives the prefix (`1` none, `2` `https://`, `3` `https://www.`, `4` `http://`, `5` `http://www.`). After it come 6-bit codes: `a–z 0–9 ./-_?=&%#:~+`, common chunks (`.com`, `.co.uk`, `durhack`, `youtube`, `watch?v=`…), `62` = next letter is a capital, `63` = one raw byte follows | YouTube link: 43 chars, 16 bytes |
| `6` | A quick code: the next byte indexes `QUICK`, the list of links built into the app | `https://durhack.com/`: 2 bytes |
| `7` | **Signed**: public key, time, a normal message (`0`–`6`), then a signature. See [Signed pulses](#signed-pulses) | `https://durhack.com/`: 103 bytes |
| `8` | Reserved for a later key-announcement message (signed plays would then carry a 4-byte key id). Not built | |
| `10` | **Live** ("room only"): a 4-byte timestamp (seconds since 2026-01-01 UTC), then a normal message. The receiver rejects it if it is more than 30 s old, so a recording played back later doesn't work. The engine and receiver support it, but the UI has no way to send one | |

Format bytes `9` and `11`–`255` are unused. `packMessage` uses whichever of quick code, packed link or
plain text is shortest, and keeps a packed link only if it unpacks back to exactly the same text.

`QUICK` must be the same in every copy of the app, in the same order. Only ever add to the end of it.

The receiver passes plain messages to the app as text. A message whose format byte `isSpecial()` recognises
(Signed and Live) is passed as raw bytes in `info.special`, and `onMessage` in `app.js` decides what to do with it.

### 2. Parts and packets (`splitParts`, `buildPacket`)

A message can be up to 8,160 bytes. It is split into evenly sized parts of at most 32 bytes. Each part becomes one packet:

```
[lead tone] [S E S E preamble] [header: 8 fields + 6 RS parity] [body: payload + CRC-16 + ≈30% RS parity] [E E]
```

- **Header fields**: part length, part index, part count, message id (2 bytes, CRC-16 of the *whole* message), piece of music, total message length (2 bytes). The receiver checks that these agree with each other, which rejects most false headers.
- **Body**: the part's payload and a CRC-16 over header fields + payload, Reed-Solomon encoded over GF(256). Parity is `max(6, 30%)` bytes for 4-bit modes.
- **Whitening**: header and body are XORed with a fixed pseudo-random sequence so long runs of the same tone don't occur. **It is not encryption**: the sequence is fixed and public.

### 3. Tones (`MODES.loud`)

The app uses only the `loud` mode:

- 4 bits per symbol, so 16 data tones. There are **two interleaved sets** of 16 tones, about 34 Hz apart. Even symbols use one set and odd symbols the other, so the reverb of one symbol can't be mistaken for the next.
- START (19.5 kHz) and END (20.65 kHz) mark the ends of the band. They **wobble ±50 Hz** so room echoes can't cancel them at one spot. 20.65 kHz is the highest a 44.1 kHz device can play, and the app refuses to play on a device whose sample rate is too low.
- Neighbouring tones glide into each other (raised-cosine) so there are no clicks. The whole play is scaled so its peak is at 98% of full scale.
- Symbol lengths: `fast` 50 ms, `normal` 65 ms, `slow` 90 ms. The app offers fast and slow. Normal is still decoded.

One **play** is every part back to back, with a 120 ms gap between parts. The app loops the play. Without music:

| Link | Bytes | Parts | Fast | Slow |
|---|---|---|---|---|
| `https://durhack.com/` (quick code) | 2 | 1 | 3.7 s | 6.2 s |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | 16 | 1 | 5.1 s | 8.7 s |
| 300-character link | 218 | 7 | 48.7 s | 85.0 s |

The app warns when one play is longer than 20 s (40 s for a signed play).

### 4. Receiving (`Decoder`, `MultiDecoder`)

The microphone is opened with echo cancellation, noise suppression and auto gain **off**, because voice
filters remove the tones. Samples go into a shared 30 s ring buffer. One `Decoder` per visible mode reads from it:

1. **Frames**: every 5 ms, Goertzel filters measure each tone over a 30 ms window. Each tone is compared against its own slowly tracked background level. These frames feed the signal meter and a preamble detector.
2. **Preamble matched filter**: one per speed. It looks for the S-E-S-E pattern and finds the exact symbol grid, to a fraction of a frame. Each speed gets its own candidate, and the header check decides which is real.
3. **Symbols**: each symbol is measured with a long Goertzel over its middle section, on the tone set that symbol uses. A **clock tracker** nudges the timing at each tone change, which handles 44.1 ↔ 48 kHz devices and drift.
4. **`prepare`**: removes each tone's background level, subtracts a learned fraction of the previous same-set symbol (echo), and equalises tones that the room or speaker makes quieter.
5. **Reed-Solomon with erasures**: first tried with no erasures, then with the least confident bytes marked as erasures. The CRC confirms the result.
6. **Repeats**: if a part fails, it is added symbol by symbol to an earlier failed copy of the same part. If even the header failed, `_stack` matches copies by timing (same interval between plays) and adds up to 7 of them **before** decoding, so faint plays that never decoded alone can decode together.
7. **`MultiDecoder`** collects parts by message id across plays, checks the CRC of the whole message, and unpacks it.

In the app, the same link heard again within 5 minutes refreshes its Recent entry but doesn't open again.

### Music

Music is off by default. When it's on, one of six public-domain extracts (Für Elise, Bach's Prelude in C,
Rondo alla Turca, Eine kleine Nachtmusik, Mozart K. 332, Gymnopédie No. 1) plays through the whole sound.
Its tempo is fitted to the data, so the loop joins up with no gap. The piece is one of the three that fit
the sound best, chosen by a hash of the link. For short links those are Eine kleine Nachtmusik, Rondo alla
Turca and Für Elise. If the piece needs more time than the data, the play is stretched. A quick-code link
with music lasts 5.8 s instead of 3.7 s.

The piece number is in the header. The receiver checks that the melody notes were actually played, in time
(`checkMelody`), and reports "Played with …". The music is decoration and a provenance check only. The link
decodes without it.

## Signed pulses

Anyone in a lecture hall can play a pulse, so a receiver can't tell the lecturer's link from a prank. With
**Sign my pulses** on (Secure tab, off by default), every pulse proves which device sent it. This is
**signing, not secrecy**: anyone nearby can still read the link. It works fully offline.

```
[7] [public key: 32] [time: 4] [inner message: n] [signature: 64]
```

- **public key**: the sender's raw Ed25519 public key. It is in every play, so a new listener needs only one play.
- **time**: big-endian uint32, seconds since 2026-01-01 UTC, set when Play is pressed (the same for every loop).
- **inner message**: exactly what `packMessage` returns (format byte `0`–`6`).
- **signature**: Ed25519 over `utf8("pulse-signed-v1") ‖ [7] ‖ public key ‖ time ‖ inner message`.

The key pair is made by WebCrypto the first time the Secure tab is opened and kept in IndexedDB. The private
key is non-extractable: it never leaves the device, and not even the app's own code can read its bytes.
**New identity** replaces the pair.

**Fingerprint words.** A receiver shows the sender as four words, for example `maple-river-otter-lamp`. They
are the first 44 bits of `SHA-256(public key)`, as four 11-bit indexes into the BIP-39 English word list
(`vendor/bip39-english.js`). The lecturer puts their words on a slide, and the QR tab shows them under the QR
code while signing is on. 44 bits is enough against someone messing about in a lecture, but **not against a
determined attacker**: with a GPU farm, someone could search for a key with the same four words.

**Lock.** A receiver that hears a signed link can **Lock to this sender**. The lock is that sender's public key
(not the words), kept in `localStorage`. While locked, unsigned links and links signed by anyone else are not
shown and not added to Recent. **Unlock** is in the result box and in the Secure tab.

| Heard | Receiver shows |
|---|---|
| Good signature, not locked | The link, "Signed by *words*", and **Lock to this sender** |
| Good signature, locked to that key | The link, "Signed by *words* ✓" |
| Locked, and the link is unsigned or from another key | Nothing. Status: "Ignored a link not from *words*" |
| Bad signature | Nothing. Status: "Rejected a link with a bad signature" |
| More than 12 hours old, or more than 5 minutes in the future | Nothing. Rejected as a replay or a wrong clock |
| The browser has no Ed25519 | The link, marked "Signature not checked". It never opens automatically |

A signed message is 101 bytes longer, so a play is about 21 s longer. Fast speed, no music:

| Link | Unsigned | Signed |
|---|---|---|
| `https://durhack.com/` (quick code) | 3.7 s, 1 part | 25.0 s, 4 parts |
| YouTube link | 5.1 s, 1 part | 26.7 s, 4 parts |

Limits: signing can't separate two senders playing at the same time (it only checks packets that already
decoded), and a recording of a signed pulse can be replayed for 12 hours. A replay can only repeat a link the
sender really sent.

## Range: simulated, not measured

`node test/range.test.js` models a lecture hall: the direct sound falls 6 dB per doubling of distance,
diffuse reverb equals the direct sound at 4 m, and background hiss is 25 dB below a phone at 1 m. A distance
counts as reached when the link decodes at least once in 5 plays:

| Hall | Pulse8 sound | Pulse10 fast | Pulse10 normal |
|---|---|---|---|
| Reverb 0.6 s (typical at these frequencies, because air and people absorb high frequencies) | 4 m | **40 m** (every distance tried) | **40 m** |
| Reverb 1.2 s (worst case) | 4 m | 4 m | 4 m |

In a hall, reverb sets the limit, not loudness. Real numbers vary by phone and room. To measure, open **Receive**,
play from another phone, and walk away watching the meter (strong ≥ 20 dB, good ≥ 12 dB). Playing through the
hall's own speakers (3.5 mm or Bluetooth from the laptop) is the surest way to cover a whole hall.

Tried and dropped: LoRa-style chirps. In these simulations they helped against noise but did worse in reverb than plain tones.

## Code map

| File | What's in it |
|---|---|
| `pulse.js` | The engine. Modes, CRC, whitening, Reed-Solomon, link packing, Live messages, packet building, synthesis, music, `Decoder`, `MultiDecoder`, `safeUrl`. |
| `secure.js` | Signed pulses: key storage (IndexedDB), fingerprint words, `signMessage`, `readSigned`. Browser (`window.PulseSecure`) and Node. |
| `app.js` | UI: tabs, the Secure tab and sender lock, Send settings, `is.gd` shortening (JSONP), play loop and score chart, QR / full screen, mic and receive flow, history, offline queue. |
| `index.html` | Markup and all the CSS. Light and dark themes come from `prefers-color-scheme`. |
| `sw.js` | Service worker. It caches the app on install, serves it cache-first, and refreshes in the background. |
| `vendor/qrcode.js` | qrcode-generator by Kazuhiko Arase (MIT). |
| `vendor/bip39-english.js` | The BIP-39 English word list (MIT), for fingerprint words. |
| `test/` | Node tests. Each one synthesises a play, runs it through a simulated room, and decodes it. |

## Hidden extras

- **Other engine modes**: `high` (Pulse3–8's 19–20.5 kHz sound), `standard` (3–5.6 kHz, most robust in noise), `child` (a pentatonic melody) and `whale` (low glides). Add a mode's name to `VISIBLE` in `app.js` to show it in the UI. The receiver listens only for `VISIBLE` modes.
- **`normal` speed**: the receiver decodes it, but the UI doesn't offer it.
- **Live messages** (format byte `10`): see the format table above.

## Run, test, deploy

```bash
python3 -m http.server 8000      # the mic and offline mode need https or localhost
node test/decode.test.js         # 15 loopback cases: reverb, babble, music, whistle, white noise, 44.1/48 kHz, drift (~9 min)
node test/melody.test.js         # 30 cases: the melody check accepts the right piece and rejects others
node test/pack.test.js           # link packing round-trips, plus 20,000 random strings
node test/secure.test.js         # signed pulses: round-trip, tampering, wrong key, age limits, words, room loopback (~1 min)
node test/range.test.js          # the simulated hall above (a few minutes)
```

Netlify serves this folder as a static site, with no build step. **When you change any cached file, bump `CACHE`
in `sw.js`** (currently `pulse10-v5`). Otherwise installed copies keep serving the old version until the
service worker updates.
