# Decision Log

> A running record of choices that affect how the project is built.
> **Newest entries go at the top.** Never rewrite history: if a decision changes,
> add a new entry and mark the old one `Superseded by D-00X`.
>
> **For agents:** read this before proposing architecture, libraries or scope changes.
> Don't re-litigate an `Accepted` decision unless asked. Append an entry when the
> team settles something non-trivial (stack, data model, API shape, scope cut).

## Index
| ID | Title | Status | Date |
|----|-------|--------|------|
| D-002 | Desktop app is a thin wrapper around the hosted web app | Accepted | 2026-11-15 |
| D-001 | Desktop app: Electron wrapper around pulse1, built locally | Accepted | 2026-11-14 |

---

## Entry template
Copy this block to the top of the log, below this line, for each new decision.

```
### D-00X: <short title>
- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Superseded by D-00Y
- **Decided by:** <names>
- **Context:** What forced a choice? What constraints applied?
- **Decision:** What we're doing, in one or two sentences.
- **Alternatives considered:** Option A (why not), Option B (why not)
- **Consequences:** What this makes easier or harder; follow-up work.
```

---

### D-002: Desktop app is a thin wrapper around the hosted web app
- **Date:** 2026-11-15
- **Status:** Accepted (changes the "loads `pulse1/index.html` / `if (D)` branches" part of D-001)
- **Decided by:** Daniel
- **Context:** pulse1 changes constantly; the desktop hooks inside `pulse1/app.js` were lost in a repo reorganisation and the desktop app silently stopped saving links.
- **Decision:** `desktop/` loads the hosted app by URL and adds only background running, saved links, notifications and offline fallback. It reads the page's DOM from `preload.js`; pulse1 contains no desktop code.
- **Alternatives considered:** hooks inside pulse1 (breaks whenever pulse1 changes); bundling a copy of pulse1 (goes stale).
- **Consequences:** the hosted URL must be live; first launch needs internet (afterwards the service worker caches it). If pulse1 renames `#listen`, `#resUrl` or `#auto`, saving stops until `desktop/preload.js` is updated.

### D-001: Desktop app: Electron wrapper around pulse1, built locally
- **Date:** 2026-11-14
- **Status:** Accepted
- **Decided by:** Daniel
- **Context:** We want Pulse to listen in the background on Windows and Mac and keep the links it hears. A browser tab can't do that. The deadline is noon on 2026-11-15.
- **Decision:** `desktop/` is an Electron app that loads `pulse1/index.html` unchanged. It lives in the tray, saves every received link to a JSON file, shows a notification, and opens a link in the default browser only when the user clicks. No launch-at-login. Installers are built locally on each OS with electron-builder and are unsigned.
- **Alternatives considered:** Tauri (smaller installer, but needs Rust and the Mac webview's microphone support is less reliable); auto-opening links on receive (disruptive in a lecture); building with GitHub Actions (we have an issue with Actions).
- **Consequences:** `pulse1/app.js` has desktop-only branches behind `window.pulseDesktop`. The web version is unchanged. The Mac `.dmg` must be built on a Mac. Users see an unsigned-app warning on first launch. Installers are about 110 MB.
