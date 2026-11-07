// preload.js — secure contextBridge between the coat GUI renderer and main.
// Only whitelisted daemon actions are exposed; the renderer never touches Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coat", {
  status: () => ipcRenderer.invoke("coat:status"),
  rotate: () => ipcRenderer.invoke("coat:rotate"),
  save: () => ipcRenderer.invoke("coat:save"),
  setInterval: (hours) => ipcRenderer.invoke("coat:interval", hours),
  tags: () => ipcRenderer.invoke("coat:tags"),
  setTags: (tags) => ipcRenderer.invoke("coat:tags:set", tags),
  openArchive: () => ipcRenderer.invoke("coat:open"),
  onDaemonMsg: (cb) => ipcRenderer.on("coat:msg", (_e, payload) => cb(payload)),
});