# Pulse10

Send a link as sound. Receive it with a microphone. A QR tab shows the same link for a projector.
Works offline as an installable web app.

Pulse10 is Pulse6's simple layout with one job: **louder and further**. No colour lock, no Private mode, no range picker.

## What changed for range

| | Pulse8 | Pulse10 |
|---|---|---|
| Band | 19–20.5 kHz | **19.5–20.65 kHz**: inaudible (17–18.5 and 18.5–20 were audible to the team). 20.65 kHz is the most a 44.1 kHz device can play |
| Level | 90% | **Full scale** (peak at 98%, no clipping) |
| Play | 4.3 s | **3.7 s** (Fast, the default) · 4.6 s Normal · 6.2 s Slow |
| 5 plays | 22 s | **18 s** |
| Header | 4 parity bytes | 6, because at long range the header is the weak spot |
| Echo | learned and subtracted | also **two alternating tone sets**, so a symbol's echo can't be mistaken for the next symbol |
| Start tones | steady | **wobble ±50 Hz**, so room echoes can't cancel them at one spot |
| Repeats | combined after the header decoded | **stacked blind**: 5 faint plays are added up by timing, even when no header decoded alone |
| Receive | | **Signal meter** (dB, weak / good / strong) for walking a hall |

Music is off by default (No music / Music switch). With it on, the piece is picked from the three that best fit the
sound, by the link itself, so different links get different pieces (Eine kleine Nachtmusik, Rondo alla Turca and Für
Elise for short links); **Another piece** steps on. The receiver has no settings and takes either.

## Range: simulated, not measured

`node test/range.test.js` models a lecture hall: direct sound falling 6 dB per doubling of distance, diffuse reverb
equal to the direct sound at 4 m, and background hiss 25 dB below a phone at 1 m. Pulse8's sound and Pulse10's
sit in the same band now, so the difference is all in the receiver and the louder, shorter signal. Decoded at least once in 5 plays:

| Hall | Pulse8 sound | Pulse10 Fast | Pulse10 Normal |
|---|---|---|---|
| Reverb 0.6 s (typical this high: air and people soak up highs) | 4 m | **40 m** (every distance tried) | **40 m** |
| Reverb 1.2 s (worst case) | 4 m | 4 m | 4 m |

So the limit in a hall is reverb, not loudness. Real numbers will differ per phone and room: open **Receive**,
play from the other phone, and walk away watching the signal meter. Strong = 20 dB and up, good = 12 dB.
Through a lecture hall's own speakers (3.5 mm or Bluetooth from the laptop) the direct sound is far louder,
which is the surest way to cover a whole hall.

Tried and dropped: LoRa-style chirps. They helped against noise but did worse in reverb than plain tones in these simulations.

## The rest, unchanged from Pulse6/8

- **Shorter links**: packed 6-bit symbols (offline); links over 45 characters swapped for an `is.gd` short link when online (the QR keeps the full link); quick codes for links in `QUICK` in `pulse.js`.
- **Any length**: split into 32-byte parts, collected across plays.
- **Music**: six public-domain extracts, one running through the whole sound; the receiver checks the melody and says which piece it heard.
- **QR tab**: full screen on open, sound keeps playing.
- **Offline**: service worker, saved links open when back online.

Hidden in the engine: `high` (Pulse3–8's 19–20.5 kHz sound; the receiver still decodes it), `standard`, `child`, `whale`. Add names to `VISIBLE` in `app.js` to show them.

## Run and test

```bash
python3 -m http.server 8000      # mic and offline need https or localhost
node test/decode.test.js         # 15 cases: reverb, babble, music, whistle, white noise, 44.1/48 kHz, drift. All pass.
node test/melody.test.js         # 30/30
node test/pack.test.js
node test/range.test.js          # the simulated hall above (a few minutes)
```

QR code: `vendor/qrcode.js` (qrcode-generator by Kazuhiko Arase, MIT).
