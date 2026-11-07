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
  history: (limit) => ipcRenderer.invoke("coat:history", limit),
  restore: (id) => ipcRenderer.invoke("coat:restore", id),
  search: (q, limit) => ipcRenderer.invoke("coat:search", q, limit),
  setWallFromSearch: (result) => ipcRenderer.invoke("coat:wall-from-search", result),
  setPan: (x, y) => ipcRenderer.invoke("coat:pan", x, y),
  onDaemonMsg: (cb) => ipcRenderer.on("coat:msg", (_e, payload) => cb(payload)),
});