# Pulse desktop app (Windows and Mac)

The same Pulse app as `../pulse1`, wrapped in Electron so it can run in the background.

- **Listens in the background.** It starts listening when it opens. Closing the window hides it and
  it keeps listening. The tray icon (menu bar on a Mac) has Show, Pause/Resume listening, the five
  most recent links, and Quit.
- **Saves every link it hears**, online or offline, to a file on the computer. The list is still
  there after a restart.
- **Never opens a link by itself.** You get a notification when a link arrives. Click the
  notification, the link in the Saved links list, or the tray menu to open it in your default browser.

The desktop app is only a wrapper. It loads the hosted web app (address in `desktop/config.json`; see below) and does not use the files in `../pulse1`.
All Pulse behaviour lives in pulse1. The desktop adds: background listening, saving links, notifications,
the tray, and offline use (the web app's own service worker caches it after the first online launch;
if it has never loaded, `offline.html` offers a retry). `preload.js` watches the page's elements
(`#listen`, `#resUrl`, `#auto`) so pulse1 needs no desktop code. It also turns off "Open links automatically".

**Changing the address (no rebuild):** create or edit `%APPDATA%\Pulse\config.json` (Mac: `~/Library/Application Support/Pulse/config.json`)
containing `{ "url": "https://your-host/" }` and restart Pulse. That file wins over the `desktop/config.json` baked into the installer,
and the `PULSE_URL` environment variable wins over both. Offline use is per address: a new address needs one online launch.

For development, run pulse1 locally and point the app at it: `PULSE_URL=http://localhost:8000 npm start`.

## Run from source

```bash
cd desktop
npm install
npm start
```

If `npm start` fails from a VS Code terminal with `Cannot read properties of undefined`, the
terminal has `ELECTRON_RUN_AS_NODE` set. Clear it (`unset ELECTRON_RUN_AS_NODE` in bash,
`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell) or use a normal terminal.

## Build the installers

Each one has to be built on its own operating system. Output goes to `desktop/out/`.

| Run on | Command | You get |
|---|---|---|
| Windows | `npm run dist:win` | `Pulse-Setup-1.0.1.exe` (installer) and `Pulse-Portable-1.0.1.exe` (no install) |
| Mac | `npm run dist:mac` | `Pulse-1.0.1.dmg` |

The apps are not code-signed, so the first launch shows a warning:

- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
- **Mac:** right-click the app → **Open** → **Open**. If macOS says the app is damaged, run
  `xattr -cr /Applications/Pulse.app` once. Allow the microphone when asked.

The Mac build has not been run yet. The Windows build has been built and tested.

## Where the links are stored

`links.json` in the app's data folder:

- Windows: `%APPDATA%\Pulse\links.json`
- Mac: `~/Library/Application Support/Pulse/links.json`

## Files

- `main.js`: window, tray, notifications, link file, microphone permission, background-throttling switches.
- `preload.js`: watches the hosted page, plus the Saved links panel.
- `offline.html`: shown when the app can't load. `assets/`: icons.

## Testing without a real microphone

`main.js` reads environment variables, used for automated checks:

- `PULSE_FAKE_MIC`: path to a WAV file that is played as the microphone.
- `PULSE_USER_DATA`: a different data folder, so tests don't touch your real links.
- `PULSE_START_HIDDEN`: start with the window hidden.
- `PULSE_URL`: load a different copy of the web app.
