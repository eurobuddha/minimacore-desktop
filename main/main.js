/*
 * main.js — Electron entry: window + tray, IPC wiring, node lifecycle.
 *
 * The renderer is fully sandboxed (contextIsolation on, nodeIntegration off) and reaches the node only via
 * the IPC handlers here, which proxy to the local RPC using the main-held secret. On launch we start the
 * node if setup is done; otherwise the renderer runs the first-run wizard and calls nodeStart when finished.
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const config = require("./config");
const node = require("./node-manager");
const rpc = require("./rpc");
const updater = require("./updater");

let win = null;
let tray = null;

// single instance — a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 780, minWidth: 380, minHeight: 620,
    title: "minimaCore",
    backgroundColor: "#0A0A0F",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("closed", () => { win = null; });
}

function pushStatus() { if (win && !win.isDestroyed()) win.webContents.send("mcd:status", node.snapshot()); }

function setupTray() {
  // a tiny orange dot as a placeholder tray icon (replaced with a real asset in Phase 6)
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR42mNgGAWjYBSMgv///" +
    "/8z/GdgYPjPwMDwn4GBgYGRAV3wPwMDAwMTAwMDAxMDAwMTAwMDAxMDAwMAxYgG1w2m9kQAAAAASUVORK5CYII=");
  try {
    tray = new Tray(img);
    const menu = () => Menu.buildFromTemplate([
      { label: "minimaCore — " + node.state, enabled: false },
      { type: "separator" },
      { label: "Show", click: () => { if (win) win.show(); else createWindow(); } },
      { label: "Restart node", click: () => node.restart() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ]);
    tray.setToolTip("minimaCore");
    tray.setContextMenu(menu());
    node.on("status", () => tray && tray.setContextMenu(menu()));
  } catch (e) { /* tray optional */ }
}

// ---- IPC ----
function requireRunning() {
  if (node.state !== "running") throw new Error("node not running");
}

ipcMain.handle("mcd:cmd", async (_e, command) => {
  if (typeof command !== "string" || !command.trim()) throw new Error("empty command");
  requireRunning();
  return rpc.rpcCall(node.rpcPort(), config.rpcSecret(), command);
});

ipcMain.handle("mcd:getConfig", () => { const c = config.load(); return c; });
ipcMain.handle("mcd:saveConfig", (_e, patch) => config.save(patch || {}));
ipcMain.handle("mcd:defaultDataFolder", () => config.defaultDataFolder());
ipcMain.handle("mcd:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

ipcMain.handle("mcd:nodeStatus", () => node.snapshot());
ipcMain.handle("mcd:nodeStart", () => { node.start(); return node.snapshot(); });
ipcMain.handle("mcd:nodeStop", async () => { await node.stop(); return node.snapshot(); });
ipcMain.handle("mcd:nodeRestart", async () => { await node.restart(); return node.snapshot(); });
ipcMain.handle("mcd:nodeLogs", () => node.logs.slice(-300));

ipcMain.handle("mcd:checkJarUpdate", () => updater.checkForUpdate());
ipcMain.handle("mcd:applyJarUpdate", async (_e, rel) => { const r = await updater.applyUpdate(rel); await node.restart(); return r; });

// forward node events to the window + tray
node.on("status", pushStatus);
node.on("log", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:log", node.logs.slice(-1)[0]); });

app.whenReady().then(() => {
  createWindow();
  setupTray();
  // Only auto-boot for a FULLY onboarded user. If either the node wizard or the wallet step is unfinished
  // (incl. a stale pre-0.1.1 config with setupDone but no wallet step), the renderer runs onboarding and
  // calls nodeStart when the user finishes — otherwise the node would silently start before any choice.
  const c = config.load();
  if (c.setupDone && c.walletDone) node.start();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { /* keep running in tray on mac; quit elsewhere */ if (process.platform !== "darwin") app.quit(); });

let quitting = false;
app.on("before-quit", async (e) => {
  if (quitting || !node.proc) return;
  e.preventDefault(); quitting = true;
  try { await node.stop(); } catch (err) {}
  app.quit();
});
