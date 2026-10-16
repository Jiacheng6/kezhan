const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', Object.freeze({
  browser: (visible) => ipcRenderer.invoke('desktop:browser', !!visible),
  hide: () => ipcRenderer.invoke('desktop:hide'),
  exit: () => ipcRenderer.invoke('desktop:exit'),
  closeChoice: (id, choice) => ipcRenderer.invoke('desktop:close-choice', id, choice),
  onCloseRequest: (callback) => {
    let revision = 0;
    const listener = (_, request) => { revision++; callback(request); };
    ipcRenderer.on('desktop:close-request', listener);
    ipcRenderer.invoke('desktop:close-state').then(request => { if (!revision && request) callback(request); }).catch(() => {});
    return () => ipcRenderer.removeListener('desktop:close-request', listener);
  },
  restart: () => ipcRenderer.invoke('desktop:restart'),
  dataFolder: () => ipcRenderer.invoke('desktop:data-folder'),
  info: () => ipcRenderer.invoke('desktop:info'),
  updateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkUpdate: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  updateNotified: () => ipcRenderer.invoke('desktop:update-notified'),
  onUpdate: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('desktop:update-status', listener);
    return () => ipcRenderer.removeListener('desktop:update-status', listener);
  },
  onVisibility: (callback) => {
    let revision = 0;
    const listener = (_, visible) => { revision += 1; callback(visible); };
    ipcRenderer.on('desktop:visibility', listener);
    ipcRenderer.invoke('desktop:visibility').then(visible => { if (!revision) callback(visible); }).catch(() => {});
    return () => ipcRenderer.removeListener('desktop:visibility', listener);
  },
}));
