/*
 * preload.js — the ONLY bridge between the sandboxed renderer and the main process.
 *
 * Exposes a minimal, explicit API on window.mcd. The renderer can run node commands (routed through the
 * main-process RPC proxy — it never learns the RPC password or the port), read/save config, drive the node
 * lifecycle, and subscribe to status/log pushes. contextIsolation is on; no Node globals leak.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mcd", {
  // node command over RPC → { status, response } (same shape the Android NodeApi consumes)
  cmd: (command) => ipcRenderer.invoke("mcd:cmd", command),

  // config
  getConfig: () => ipcRenderer.invoke("mcd:getConfig"),
  saveConfig: (patch) => ipcRenderer.invoke("mcd:saveConfig", patch),
  defaultDataFolder: () => ipcRenderer.invoke("mcd:defaultDataFolder"),
  pickFolder: () => ipcRenderer.invoke("mcd:pickFolder"),

  // node lifecycle
  nodeStatus: () => ipcRenderer.invoke("mcd:nodeStatus"),
  nodeStart: () => ipcRenderer.invoke("mcd:nodeStart"),
  nodeStop: () => ipcRenderer.invoke("mcd:nodeStop"),
  nodeRestart: () => ipcRenderer.invoke("mcd:nodeRestart"),
  nodeLogs: () => ipcRenderer.invoke("mcd:nodeLogs"),

  // jar updater
  checkJarUpdate: () => ipcRenderer.invoke("mcd:checkJarUpdate"),
  applyJarUpdate: (rel) => ipcRenderer.invoke("mcd:applyJarUpdate", rel),

  // pushes
  onStatus: (fn) => { const h = (_e, s) => fn(s); ipcRenderer.on("mcd:status", h); return () => ipcRenderer.removeListener("mcd:status", h); },
  onLog: (fn) => { const h = (_e, l) => fn(l); ipcRenderer.on("mcd:log", h); return () => ipcRenderer.removeListener("mcd:log", h); }
});
