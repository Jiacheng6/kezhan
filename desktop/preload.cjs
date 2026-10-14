const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', Object.freeze({
  browser: (visible) => ipcRenderer.invoke('desktop:browser', !!visible),
  hide: () => ipcRenderer.invoke('desktop:hide'),
  exit: () => ipcRenderer.invoke('desktop:exit'),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  dataFolder: () => ipcRenderer.invoke('desktop:data-folder'),
  info: () => ipcRenderer.invoke('desktop:info'),
}));
