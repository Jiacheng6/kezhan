const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', Object.freeze({
  browser: (visible) => ipcRenderer.invoke('desktop:browser', !!visible),
  hide: () => ipcRenderer.invoke('desktop:hide'),
  exit: () => ipcRenderer.invoke('desktop:exit'),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  dataFolder: () => ipcRenderer.invoke('desktop:data-folder'),
  info: () => ipcRenderer.invoke('desktop:info'),
  updateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkUpdate: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  onUpdate: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('desktop:update-status', listener);
    return () => ipcRenderer.removeListener('desktop:update-status', listener);
  },
}));
