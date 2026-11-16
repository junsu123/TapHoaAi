// Only the app's own pages (waiting screen, settings) get this small bridge; the game page from
// the server does not need anything from the app.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("chibiDesktop", {
    getConfig: () => ipcRenderer.invoke("config:get"),
    saveConfig: (cfg) => ipcRenderer.invoke("config:save", cfg),
    chooseDir: () => ipcRenderer.invoke("config:chooseDir"),
    state: () => ipcRenderer.invoke("app:state"),
  });
}
