'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  exportProject: (url, pat, format) =>
    ipcRenderer.invoke('export', { url, pat, format }),

  onProgress: (callback) =>
    ipcRenderer.on('fetch-progress', (_event, msg) => callback(msg)),

  removeProgressListeners: () =>
    ipcRenderer.removeAllListeners('fetch-progress'),
});
