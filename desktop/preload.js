// Bridge between the Pulse web page and the desktop shell. The page checks for window.pulseDesktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulseDesktop', {
  listLinks: () => ipcRenderer.invoke('links:list'),
  addLink: url => ipcRenderer.invoke('links:add', url),
  removeLink: url => ipcRenderer.invoke('links:remove', url),
  openLink: url => ipcRenderer.invoke('links:open', url),
  onLinksChanged: cb => ipcRenderer.on('links:changed', (_e, links) => cb(links)),
  setListening: on => ipcRenderer.send('listening:state', !!on),
  onToggleListening: cb => ipcRenderer.on('listening:toggle', () => cb()),
});
