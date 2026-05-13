'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  exportMarkdown: (url, pat) =>
    ipcRenderer.invoke('export-markdown', { url, pat }),

  onProgress: (callback) =>
    ipcRenderer.on('fetch-progress', (_event, msg) => callback(msg)),

  removeProgressListeners: () =>
    ipcRenderer.removeAllListeners('fetch-progress'),
});
