// The only bridge between the UI page and the app: send a request, receive the tabs. Pages in
// tabs get no preload, so they cannot reach it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("browser", {
  send: (request) => ipcRenderer.send("browser", request),
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
  onFocusAddress: (listener) => ipcRenderer.on("focusAddress", () => listener()),
});
