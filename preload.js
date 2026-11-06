const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agents', {
  create: () => ipcRenderer.invoke('agent:create'),
  send: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, id, evt) => cb(id, evt)),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_e, id, s) => cb(id, s)),
});
