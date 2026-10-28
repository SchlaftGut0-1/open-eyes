const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("browser", {
  send: (request) => ipcRenderer.send("browser", request),
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
  onFocusAddress: (listener) => ipcRenderer.on("focusAddress", (_event, text) => listener(text)),
});
