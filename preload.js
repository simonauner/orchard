const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agents', {
  workspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: () => ipcRenderer.invoke('workspaces:add'),
  create: (opts) => ipcRenderer.invoke('agent:create', opts),
  remove: (id) => ipcRenderer.invoke('agent:remove', id),
  send: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, id, evt) => cb(id, evt)),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_e, id, s) => cb(id, s)),
});
