const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "pigDesktop",
  Object.freeze({
    chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
    info: () => ipcRenderer.invoke("desktop:info"),
  }),
);
