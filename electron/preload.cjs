// Exposes a small, fixed API to the editor page. The page cannot reach Node or the file system directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaudeRemote', {
  list: () => ipcRenderer.invoke('remote:list'),
  add: (input) => ipcRenderer.invoke('remote:add', input),
  remove: (id) => ipcRenderer.invoke('remote:remove', id),
  analyze: (id) => ipcRenderer.invoke('remote:analyze', id),
});

contextBridge.exposeInMainWorld('zaudeProject', {
  pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
  scan: (folder) => ipcRenderer.invoke('project:scan', folder),
  load: (folder) => ipcRenderer.invoke('project:load', folder),
  save: (folder, data) => ipcRenderer.invoke('project:save', folder, data),
  waveform: (filePath) => ipcRenderer.invoke('project:waveform', filePath),
  saveZd: (input) => ipcRenderer.invoke('project:saveZd', input),
  openZd: (filePath) => ipcRenderer.invoke('project:openZd', filePath),
});

contextBridge.exposeInMainWorld('zaudeRender', {
  start: (input) => ipcRenderer.invoke('render:start', input),
  onProgress: (callback) => {
    const listener = (_event, p) => callback(p);
    ipcRenderer.on('render:progress', listener);
    return () => ipcRenderer.removeListener('render:progress', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeUpdate', {
  status: () => ipcRenderer.invoke('update:status'),
  check: () => ipcRenderer.invoke('update:check'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeAI', {
  getSettings: () => ipcRenderer.invoke('ai:settings:get'),
  setSettings: (input) => ipcRenderer.invoke('ai:settings:set', input),
  startTextToVideo: (input) => ipcRenderer.invoke('ai:textToVideo:start', input),
  cancelTextToVideo: (id) => ipcRenderer.invoke('ai:textToVideo:cancel', id),
  reveal: (filePath) => ipcRenderer.invoke('ai:reveal', filePath),
  mediaUrl: (filePath) => ipcRenderer.invoke('ai:mediaUrl', filePath),
  onJob: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:job', listener);
    return () => ipcRenderer.removeListener('ai:job', listener);
  },
});
