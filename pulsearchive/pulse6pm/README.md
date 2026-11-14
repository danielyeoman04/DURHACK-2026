# Pulse: a QR code you can hear

One web page with two modes:

- **Send** types in a URL and plays it as a burst of tones (about 9 s for a typical link at Normal speed).
- **Receive** listens through the microphone, decodes the tones, and offers to open the website.

No build step, no dependencies. `index.html`, `app.js` and `pulse.js` are the app. `sw.js`, `manifest.webmanifest` and the icons make it work offline.

## Run it

```bash
cd pulse
python3 -m http.server 8000      # or: npx serve
```

Open http://localhost:8000 on your laptop. Browsers only allow the microphone on **https** or
**localhost**, so to try it on a phone host it somewhere with https:

- **GitHub Pages**: push the folder to a repo, then Settings → Pages → deploy from `main`.
- **Netlify Drop**: drag the folder onto https://app.netlify.com/drop.
- **Tunnel from your laptop**: `npx localtunnel --port 8000` or `ngrok http 8000`.

Handy links: `?mode=recv` opens straight into Receive, `?url=https://...` pre-fills Send.

## Offline mode

Pulse is an installable web app (PWA). Open it once while online, and it caches itself on the
device. After that, both Send and Receive work with no internet. Use "Add to Home Screen" on a phone
or the install icon in Chrome's address bar to get an app icon.

- **Receiving while offline:** the link is saved on the device instead of opening, and an "Offline"
  badge shows. Saved links stay even if the app is closed.
- **Back online:** if the app is open, it takes you straight to the saved link (when auto-open is on).
  If it was closed, the next launch opens on Receive with a "ready to open" list.
- Offline caching needs https (or localhost), same as the mic.

## How it works (protocol v2, noise-hardened)

Inspired by [mitxela's acoustic QR code](https://mitxela.com/projects/acoustic_qr_code), which draws
a real QR code into a spectrogram. That approach is visual but fragile: speed differences and noise
break the image. Pulse keeps the idea of a URL as sound but uses a scheme built to survive a loud room.

```
[S][E][S][E]   preamble, one symbol each   finds the packet and its exact timing
header         length + 4 Reed-Solomon     10 tones
body           URL + CRC-16 + RS parity    2 tones per byte (~30% parity)
[E E]          end
```

- **18 tones, 3000 to 5550 Hz** in 150 Hz steps: 16 data tones (one per 4-bit nibble) plus START and END.
  This sits above most of the energy of voices and music.
- **Speeds:** Fast 70 ms, **Normal 120 ms (default)**, Slow 200 ms per tone. The receiver detects
  all three automatically.
- **Preamble matched filter.** The receiver looks for the S-E-S-E pattern at each speed, which tells it
  exactly where every symbol starts. It then measures each symbol over most of its length with one long,
  narrow filter. That lets in far less noise than the 20 ms snapshots v1 used.
- **Per-tone background normalisation.** Each tone is judged against its own background level, so a
  hum, a whistle or a loud band of music can't win.
- **Echo cancelling.** The receiver learns how much of each tone leaks into the next symbol through room
  reverb and subtracts it.
- **Reed-Solomon with erasures.** Bytes are whitened and protected with ~30% parity. Uncertain symbols
  are flagged as erasures, which roughly doubles how many errors get repaired. A CRC-16 makes sure the
  result is right.
- **Repeat combining.** If a play still fails, its measurements are kept and added to the next repeat.
- **Clock tracking**, so mismatched sample rates and clock drift between phones don't matter.
- **Mic processing off.** `echoCancellation`, `noiseSuppression` and `autoGainControl` are disabled,
  because voice-call filters treat tones as noise.
- **Safety:** only `http(s)` links can open. `javascript:` and other schemes are refused.
- **Auto-open** is on by default and opens the site in the same tab, like a camera QR scanner does.
  Pop-ups opened without a tap get blocked on phones.

## Tests

```bash
node test/decode.test.js
```

This runs packets through a simulated room: reverb, crowd babble (8 talkers), music, a loud whistle
sitting on a data tone, white noise, 44.1k↔48k sample rates and clock drift. All 13 cases pass.

Noise sweep (one play, Normal speed, signal-to-noise ratio of the whole recording):

| Noise | v1 works down to | v2 works down to |
|---|---|---|
| Crowd babble | -5 dB | -15 dB (lowest tested) |
| Music | 0 dB | -15 dB (lowest tested) |
| Babble + music | 0 dB | -20 dB (lowest tested) |

These are simulations. Real speakers, mics and rooms will be worse, so test in the actual venue.

The app was also tested end to end in headless Chromium, with a WAV of the signal buried under
babble + music at -5 dB fed in as the microphone. It decoded the URL.

## Stretch goals (not built yet)

1. **Encrypted / one-time sound.** Encrypt the payload (AES-GCM via WebCrypto) with a key the
   receiver has, and add a timestamp or nonce so a recording can't be replayed. A server issues
   one-time tokens and the decoded token unlocks a private page.
2. **Melody mode.** Map the data tones to a musical scale (e.g. pentatonic notes) so the sound is a
   tune. Whitening already keeps repeated notes rare, which helps here.
3. **Near-ultrasonic band** (17 to 19 kHz) for "silent" transfer. Many laptop mics handle it,
   but some phones filter it out.
