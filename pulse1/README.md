# Pulse4

Send a link as sound. Receive it with a microphone. A QR code shows the same link for anyone
without a phone to listen with. Works offline as an installable web app.

## Für Elise mode (new in Pulse4)

Send plays the **first 4 bars of Für Elise** (Beethoven, public domain) out loud on a piano-like sound,
while the link travels on top of it, near-silently, at 19–20.5 kHz. The tempo is stretched so the 4 bars
last exactly as long as one copy of the link (about 5.3 s, a natural Für Elise tempo). Like before,
it plays 5 times.

**Musical password.** When the receiver decodes a link, it knows exactly when the music should have
started. It listens back to check that each right-hand note of Für Elise was really there at the right
moment, comparing each expected note with the semitones around it. With "Only accept links played with
Für Elise" on (the default), a link sent without the tune is ignored. In tests it matched 15–19 of 19 notes
with the tune and 2–4 of 19 without, and the threshold is 60%.

This is a theme feature, not real security: a recording of the whole performance would still work.
Real protection would mean encrypting the link, which is a separate step.

Turn the tune off with "Play Für Elise with it" on Send, and turn the check off on Receive.

## Sound

The app currently shows one mode, **High**:

- 16 tones between **19.0 and 20.5 kHz**, which is near-silent for most people. Some teenagers can still faintly hear it.
- About **5.3 s** per play for `https://durhack.com/` (Fast ~4.1 s, Slow ~7.5 s). It **plays 5 times and then stops**.
  The receiver combines plays, so a missed one isn't lost.
- It starts with a soft 0.45 s fade-in at the start frequency, and tones **glide** into each other instead of
  jumping, which avoids the clicks that make high tones audible.
- There are no volume buttons. It plays at a fixed level, and you use the device's own volume.
- It's short range, roughly arm's length. It needs a device whose audio runs at 44.1 kHz or more, which covers all current phones and laptops.

The engine also contains **Standard** (3–5.6 kHz tones), **Child** (pentatonic melody) and **Whale**
(audible deep gliding song, 294–784 Hz, ~15 s). They're hidden for now. To bring them back, add their names to `VISIBLE` at the top of the Send section in `app.js`.
True infrasound (below 20 Hz) isn't possible: phone and laptop speakers can't produce it, and their mics filter it out.

## Install it like an app

Open it once in Chrome (MacBook, Android, Windows), then click **Install** in the address bar, or use
"Add to Home screen" on a phone. It gets its own window and icon, and it works offline.

## Run it

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. The mic and offline mode need https (or localhost), so host it on
GitHub Pages to use it on phones. Links: `?mode=recv` opens Receive, and `?url=` pre-fills the link.

## Under the hood

Each packet starts with an S-E-S-E preamble, then a header (length + Reed-Solomon), then the body
(link + CRC-16 + Reed-Solomon parity: about 30% for 16-tone modes, 50% for 8-tone modes). The receiver:

- finds the preamble with a matched filter at each speed, so it knows exactly where each symbol starts
- measures each symbol with one long, narrow filter
- judges each tone against its own background noise
- learns and subtracts room echo
- learns how loud each tone arrives and evens out tones the room or speaker swallows
- marks shaky symbols as erasures for Reed-Solomon
- if a play fails, combines it with the next repeat
- tracks clock drift between devices

Offline: a service worker caches the app. Links heard offline are saved on the device and opened
when you're back online.

## Tests

```bash
node test/decode.test.js
node test/melody.test.js
```

14 simulated cases across all modes: room echo, crowd babble, music, a whistle, white noise,
44.1/48 kHz mismatch and clock drift. All pass. Every mode was also decoded end to end in
headless Chromium, with noisy recordings fed in as the microphone.

QR code: `vendor/qrcode.js` (qrcode-generator by Kazuhiko Arase, MIT).
