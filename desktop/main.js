/*
 * Pulse desktop shell. Loads the pulse1 web app in a window, keeps it listening when the
 * window is closed (tray icon), saves every link it hears to a file, and opens links in the
 * default browser only when the user asks.
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, session, nativeImage,
        systemPreferences, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

// Test hooks: a separate data folder, a WAV file played as the microphone, start with no window shown.
if (process.env.PULSE_USER_DATA) app.setPath('userData', process.env.PULSE_USER_DATA);
if (process.env.PULSE_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.PULSE_FAKE_MIC);
}
const START_HIDDEN = !!process.env.PULSE_START_HIDDEN;

// lets the page start the microphone at launch, without waiting for a click
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// packaged: pulse1 is copied next to main.js. From source: it is the sibling folder.
const WEB_DIR = [path.join(__dirname, 'pulse1'), path.join(__dirname, '..', 'pulse1')]
  .find(d => fs.existsSync(path.join(d, 'index.html')));
const MAX_LINKS = 500;

let win = null, tray = null, quitting = false, listening = false, blocker = null, toldAboutTray = false;
let links = [];                       // [{ url, at }] newest first
const liveNotifications = new Set();  // keep references so click handlers survive garbage collection

// ---------- saved links (a JSON file, so they survive restarts and need no internet) ----------
const storeFile = () => path.join(app.getPath('userData'), 'links.json');

function safeUrl(text) {
  try {
    const u = new URL(String(text));
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch (e) { return null; }
}
function loadLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    links = (Array.isArray(data) ? data : [])
      .map(l => ({ url: safeUrl(l && l.url), at: Number(l && l.at) || 0 }))
      .filter(l => l.url);
  } catch (e) { links = []; }
}
function saveLinks() {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    const tmp = storeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(links, null, 2));
    fs.renameSync(tmp, storeFile());
  } catch (e) { console.error('Pulse: could not save links:', e.message); }
}
function linksChanged() {
  saveLinks();
  if (win && !win.isDestroyed()) win.webContents.send('links:changed', links);
  updateTray();
}
function addLink(text) {
  const url = safeUrl(text);
  if (!url) return;
  links = [{ url, at: Date.now() }, ...links.filter(l => l.url !== url)].slice(0, MAX_LINKS);
  linksChanged();
  notify('Pulse heard a link', `${shortUrl(url)}\nClick to open it in your browser.`, () => openLink(url));
}
function removeLink(url) {
  links = links.filter(l => l.url !== url);
  linksChanged();
}
function openLink(text) {
  const url = safeUrl(text);
  if (url) shell.openExternal(url);
}
function shortUrl(url) {
  const u = new URL(url);
  const s = u.host + (u.pathname === '/' ? '' : u.pathname);
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(WEB_DIR, 'icon-192.png') });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('click', () => { done(); if (onClick) onClick(); });
  n.on('close', done);
  n.show();
}

// ---------- window ----------
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 620, height: 860, minWidth: 380, minHeight: 500,
    show: false,
    backgroundColor: '#0b0d12',
    icon: path.join(WEB_DIR, 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,    // keep decoding at full speed while the window is hidden
    },
  });
  win.loadFile(path.join(WEB_DIR, 'index.html'));
  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });

  // the window only ever shows the Pulse page. Every link goes to the default browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openLink(url); });

  // closing the window hides it and Pulse keeps listening. Quit is in the tray menu.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray) {
      toldAboutTray = true;
      notify('Pulse is still running',
        listening ? 'It keeps listening in the background. Use the tray icon to open or quit it.'
                  : 'Use the tray icon to open or quit it.',
        showWindow);
    }
  });
}

// ---------- tray ----------
let iconOn = null, iconOff = null;
function makeTrayIcons() {
  const size = process.platform === 'darwin' ? 18 : 32;
  iconOn = nativeImage.createFromPath(path.join(WEB_DIR, 'icon-192.png')).resize({ width: size, height: size });
  // paused icon: the same picture, faded
  const s = iconOn.getSize(), bmp = Buffer.from(iconOn.toBitmap());
  for (let i = 0; i < bmp.length; i++) bmp[i] = bmp[i] * 0.4;
  iconOff = nativeImage.createFromBitmap(bmp, { width: s.width, height: s.height });
}
function updateTray() {
  if (!tray) return;
  tray.setImage(listening ? iconOn : iconOff);
  tray.setToolTip(listening ? 'Pulse: listening' : 'Pulse: paused');
  const recent = links.slice(0, 5).map(l => ({ label: shortUrl(l.url), click: () => openLink(l.url) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Pulse', click: showWindow },
    { label: listening ? 'Pause listening' : 'Resume listening',
      click: () => { if (win) win.webContents.send('listening:toggle'); } },
    { type: 'separator' },
    { label: 'Recent links', submenu: recent.length ? recent : [{ label: 'None yet', enabled: false }] },
    { type: 'separator' },
    { label: 'Quit Pulse', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- start ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', showWindow);            // macOS dock icon
  app.on('window-all-closed', () => {});     // stay alive in the tray

  ipcMain.handle('links:list', () => links);
  ipcMain.handle('links:add', (_e, url) => addLink(url));
  ipcMain.handle('links:remove', (_e, url) => removeLink(url));
  ipcMain.handle('links:open', (_e, url) => openLink(url));
  ipcMain.on('listening:state', (_e, on) => {
    listening = !!on;
    // stop the OS from suspending the app while it is listening
    if (listening && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!listening && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    updateTray();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.durhack.pulse');   // Windows needs this for notifications
    loadLinks();

    // the page is our own local file, and the microphone is the only permission it gets
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    if (process.platform === 'darwin') {
      try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) {}
    }

    createWindow();
    makeTrayIcons();
    tray = new Tray(iconOff);
    tray.on('click', showWindow);
    updateTray();
  });
}
