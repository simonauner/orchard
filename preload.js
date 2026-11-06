const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agents', {
  copy: (data) => ipcRenderer.invoke('clipboard:write', data),
  workspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: () => ipcRenderer.invoke('workspaces:add'),
  settings: () => ipcRenderer.invoke('settings:get'),
  status: () => ipcRenderer.invoke('settings:status'),
  browseClaude: () => ipcRenderer.invoke('settings:browseClaude'),
  setClaudePath: (file) => ipcRenderer.invoke('settings:setClaudePath', file),
  list: () => ipcRenderer.invoke('agent:list'),
  history: (id) => ipcRenderer.invoke('agent:history', id),
  create: (opts) => ipcRenderer.invoke('agent:create', opts),
  remove: (id) => ipcRenderer.invoke('agent:remove', id),
  send: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, id, evt) => cb(id, evt)),
  onInfo: (cb) => ipcRenderer.on('agent:info', (_e, info) => cb(info)),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_e, id, s) => cb(id, s)),
});
