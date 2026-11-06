const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agents', {
  create: (task) => ipcRenderer.invoke('agent:create', task),
  remove: (id) => ipcRenderer.invoke('agent:remove', id),
  send: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, id, evt) => cb(id, evt)),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_e, id, s) => cb(id, s)),
});
