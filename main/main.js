/*
 * main.js — Electron entry: window + tray, IPC wiring, node lifecycle.
 *
 * The renderer is fully sandboxed (contextIsolation on, nodeIntegration off) and reaches the node only via
 * the IPC handlers here, which proxy to the local RPC using the main-held secret. On launch we start the
 * node if setup is done; otherwise the renderer runs the first-run wizard and calls nodeStart when finished.
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification, session } = require("electron");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const node = require("./node-manager");
const portmap = require("./portmap");
const rpc = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const updater = require("./updater");
const netfetch = require("./netfetch");
const histDb = require("./history-db");
const faucet = require("./faucet");
const mail = require("./mail");
const pandapools = require("./pandapools");
const atomix = require("./atomix");
const shop = require("./shop");
const casino = require("./casino");

let win = null;
let tray = null;

// single instance — a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 540, height: 840, minWidth: 440, minHeight: 640,
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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));   // no child windows inherit camera/etc
  win.on("closed", () => { win = null; });
}

// Camera permission for the QR scanner: allow ONLY the `media` permission and ONLY for our own bundled
// file:// renderer (there is no other origin — the CSP blocks remote content). Everything else is denied.
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    const url = (wc && wc.getURL && wc.getURL()) || "";
    cb(permission === "media" && url.startsWith("file://"));
  });
  // Mirror the request handler exactly (derive from the webContents, don't trust a null origin).
  ses.setPermissionCheckHandler((wc, permission) => {
    const url = (wc && wc.getURL && wc.getURL()) || "";
    return permission === "media" && url.startsWith("file://");
  });
}

function pushStatus() { if (win && !win.isDestroyed()) win.webContents.send("mcd:status", node.snapshot()); }

function setupTray() {
  // the official Minima logo mark (bare, transparent) for the menu-bar tray, sized for the menu bar
  const MINIMA_MARK = "data:image/png;base64,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";
  const img = nativeImage.createFromDataURL(MINIMA_MARK).resize({ width: 18, height: 18 });
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
  const run = (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c);
  // Shared-node fund-safety: a MINIMA `send` (wallet Send/Split) must not auto-select anyone-can-spend beacon dust
  // (PandaPools etc.) as its input → KeyRow.getPrivateKey() null. Pin it to a signable coin. Non-send cmds pass through.
  const pinned = /^send\s/.test(command) ? await pinMinimaSend(run, command) : command;
  return run(pinned);
});

ipcMain.handle("mcd:appVersion", () => app.getVersion());
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
ipcMain.handle("mcd:nodeLogs", () => node.logs.slice(-800));
ipcMain.handle("mcd:portmapStatus", () => portmap.status());

ipcMain.handle("mcd:checkJarUpdate", () => updater.checkForUpdate());
ipcMain.handle("mcd:applyJarUpdate", async (_e, rel) => { const r = await updater.applyUpdate(rel); await node.restart(); return r; });

// token icons + history store + CSV export (no requireRunning — these render off the local store / cache)
ipcMain.handle("mcd:tokenIcon", (_e, url) => netfetch.tokenIcon(url));
ipcMain.handle("mcd:faucet", (_e, address) => faucet.requestFaucet(address));

// KeyUses reuse audit — the ONLY user-initiated external call. Host is HARD-PINNED to eurobuddha.com (no
// user-controlled host → no SSRF surface); pubkeys/addrs are hex-validated before they reach the query string.
// netfetch.fetchJson is capped + never throws, so an unreachable service just returns null (graceful degrade).
const KEYUSES_BASE = "https://eurobuddha.com";
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;         // 32-byte WOTS public key
const HEX_ADDR = /^0x[0-9a-fA-F]{2,80}$/;      // Minima address — 0x + hex, generously bounded (hex-only, no metachars)
ipcMain.handle("mcd:keyAudit", (_e, pubkeys) => {
  const list = (Array.isArray(pubkeys) ? pubkeys : []).map(String).filter(k => HEX_KEY.test(k));
  if (!list.length) return null;
  return netfetch.fetchJson(KEYUSES_BASE + "/keyaudit?keys=" + encodeURIComponent(list.join(",")));
});
ipcMain.handle("mcd:keyReuse", (_e, addrs) => {
  const list = (Array.isArray(addrs) ? addrs : []).map(String).filter(a => HEX_ADDR.test(a));
  if (!list.length) return null;
  return netfetch.fetchJson(KEYUSES_BASE + "/reuse?addrs=" + encodeURIComponent(list.join(",")));
});

// minimaMail (on-chain encrypted messaging; crypto/keys live here, never in the renderer)
ipcMain.handle("mcd:mailInit", async () => { await mail.init(); return mail.myIdentity(); });
ipcMain.handle("mcd:mailIdentity", () => mail.myIdentity());
ipcMain.handle("mcd:mailSetName", (_e, n) => { mail.setName(n); return mail.myIdentity(); });
ipcMain.handle("mcd:mailShare", () => mail.shareString());
ipcMain.handle("mcd:mailThreads", () => mail.threads());
ipcMain.handle("mcd:mailThread", (_e, h) => mail.thread(h));
ipcMain.handle("mcd:mailThreadWith", (_e, peer) => mail.threadWith(peer));
ipcMain.handle("mcd:mailSend", (_e, to, base) => mail.sendMessage(to, base || {}));
ipcMain.handle("mcd:mailPay", (_e, to, payaddr, amount, tokenid, tokenname, memo) => mail.pay(to, payaddr, amount, tokenid, tokenname, memo));
ipcMain.handle("mcd:mailRequestPayaddr", (_e, peer) => mail.requestPayaddr(peer));
ipcMain.handle("mcd:mailResolvePayaddr", (_e, peer) => mail.resolvePayaddr(peer));
ipcMain.handle("mcd:mailReceivingAddr", () => mail.myReceivingAddress());
ipcMain.handle("mcd:mailContacts", () => mail.contacts());
ipcMain.handle("mcd:mailAddContact", (_e, share, name) => mail.addContact(share, name));
ipcMain.handle("mcd:mailRenameContact", (_e, peer, name) => mail.renameContact(peer, name));
ipcMain.handle("mcd:mailRemoveContact", (_e, peer) => mail.removeContact(peer));
ipcMain.handle("mcd:mailDeleteThread", (_e, hashref) => mail.deleteThread(hashref));
ipcMain.handle("mcd:mailArchivedThreads", () => mail.archivedThreads());
ipcMain.handle("mcd:mailSetArchived", (_e, hashref, on) => mail.setArchived(hashref, on));
ipcMain.handle("mcd:mailScan", () => mail.scan());
ipcMain.handle("mcd:mailInvalidate", () => { mail.invalidateIdentity(); return true; });

// ---- miniMall (shop) ----
ipcMain.handle("mcd:shopInit", async () => { await shop.init(); return shop.myIdentity(); });
ipcMain.handle("mcd:shopVendorCard", async () => { await shop.init(); return shop.vendorCard(); });
ipcMain.handle("mcd:shopMyShops", () => shop.myShops());
ipcMain.handle("mcd:shopSave", (_e, cfg) => shop.saveShop(cfg));
ipcMain.handle("mcd:shopDelete", (_e, shopId) => shop.deleteShop(shopId));
ipcMain.handle("mcd:shopOrders", () => shop.ordersList());
ipcMain.handle("mcd:shopOrder", (_e, ref) => shop.orderDetail(ref));
ipcMain.handle("mcd:shopNewCount", () => shop.newOrderCount());
ipcMain.handle("mcd:shopPlaceOrder", (_e, shopCfg, items, total, shipping, delivery, note) => shop.placeOrder(shopCfg, items, total, shipping, delivery, note));
ipcMain.handle("mcd:shopRetryPay", (_e, ref) => shop.retryPayment(ref));
ipcMain.handle("mcd:shopAdvance", (_e, ref, status) => shop.advanceStatus(ref, status));
ipcMain.handle("mcd:shopReply", (_e, ref, text) => shop.reply(ref, text));
ipcMain.handle("mcd:shopScan", () => shop.scanOnce());
ipcMain.handle("mcd:shopInvalidate", () => { shop.invalidateIdentity(); return true; });
// backup: keys stay in main; the renderer only supplies the passphrase and triggers the file dialog.
ipcMain.handle("mcd:mailExportBackup", async (_e, passphrase) => {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const enc = await mail.exportBackup(passphrase);   // throws before any dialog if the identity isn't ready
  const r = await dialog.showSaveDialog(win, { defaultPath: "minimamail-backup.json", filters: [{ name: "minimaMail backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, enc, "utf8");
  return { canceled: false, path: r.filePath };
});
ipcMain.handle("mcd:mailImportBackup", async (_e, passphrase) => {
  if (typeof passphrase !== "string" || passphrase.length < 1) throw new Error("Enter the backup passphrase.");
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "minimaMail backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const json = fs.readFileSync(r.filePaths[0], "utf8");
  const id = await mail.importBackup(passphrase, json);   // throws on wrong passphrase / bad file
  return { canceled: false, identity: id };
});

// forward mail updates to the window; start the scan loop once the node is running
mail.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:mail"); });
// OS notification on a fresh incoming message when the window isn't focused (mirrors the native "New mail")
mail.emitter.on("incoming", (info) => {
  try {
    if (!info || (win && !win.isDestroyed() && win.isFocused())) return;
    const who = info.name || "New mail";
    const body = info.count > 1 ? info.count + " new messages" : (info.preview || "New message");
    const n = new Notification({ title: info.count > 1 ? "minimaMail" : who, body, silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (e) { /* notifications are best-effort */ }
});
// miniMall: order feed → renderer; OS notification on a new incoming order (vendor) when unfocused
shop.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:shop"); });
shop.emitter.on("incoming", (info) => {
  try {
    if (!info || (win && !win.isDestroyed() && win.isFocused())) return;
    if (info.paid) return;   // payment-matched events don't pop a toast; only new orders do
    const n = new Notification({ title: "miniMall — new order", body: (info.shopName ? info.shopName + " · " : "") + (info.amount ? info.amount + " " + (info.currency || "") : "New order"), silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (e) {}
});
let mailStarted = false;
node.on("status", (s) => { if (s.state === "running" && !mailStarted) { mailStarted = true; mail.startLoop(); shop.startLoop().catch(() => {}); } });

// PandaPools (AMM) — read model + actions; the AMM logic is the reused MDS core (main/pandapools/*).
ipcMain.handle("mcd:ppPools", () => pandapools.pools());
ipcMain.handle("mcd:ppMyPools", () => pandapools.myPools());
ipcMain.handle("mcd:ppActivity", () => pandapools.activity());
ipcMain.handle("mcd:ppFeed", () => pandapools.feed());
ipcMain.handle("mcd:ppScan", () => pandapools.scanNow());
ipcMain.handle("mcd:ppQuote", (_e, tok, minimaToToken, amount) => pandapools.quoteSwap(tok, minimaToToken, amount));
ipcMain.handle("mcd:ppPairInfo", (_e, tok) => pandapools.pairInfo(tok));
ipcMain.handle("mcd:ppSwap", (_e, quoteId) => pandapools.swap(quoteId));
ipcMain.handle("mcd:ppCreate", (_e, tok, dec, x0, y0) => pandapools.createPool(tok, dec, x0, y0));
ipcMain.handle("mcd:ppCreatePreview", (_e, dec, x0, y0) => pandapools.createPreview(dec, x0, y0));
ipcMain.handle("mcd:ppMarket", () => pandapools.market());
ipcMain.handle("mcd:ppCreateAnchor", () => pandapools.createAnchor());
ipcMain.handle("mcd:ppMarketToken", () => pandapools.marketToken());
ipcMain.handle("mcd:ppDeposit", (_e, addr, addM, addT) => pandapools.deposit(addr, addM, addT));
ipcMain.handle("mcd:ppClose", (_e, addr) => pandapools.close(addr));
ipcMain.handle("mcd:ppMigrate", (_e, addr, x0, y0) => pandapools.migrate(addr, x0, y0));
ipcMain.handle("mcd:ppCollect", () => pandapools.collectToWallet());
ipcMain.handle("mcd:ppInvalidate", () => { pandapools.invalidate(); return true; });
ipcMain.handle("mcd:ppBackup", () => pandapools.backup());
ipcMain.handle("mcd:ppRestore", (_e, json) => pandapools.restore(json));
ipcMain.handle("mcd:ppSaveBackup", async (_e, json) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: "pandapools-backup.json", filters: [{ name: "PandaPools backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, String(json || ""), "utf8");
  return { canceled: false, path: r.filePath };
});
ipcMain.handle("mcd:ppLoadBackup", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "PandaPools backup", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  try { if (fs.statSync(r.filePaths[0]).size > 8 * 1024 * 1024) throw new Error("That file is too large to be a PandaPools backup."); } catch (e) { return { canceled: false, error: e.message }; }
  return { canceled: false, json: fs.readFileSync(r.filePaths[0], "utf8") };
});
pandapools.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:pandapools"); });
let ppStarted = false;
node.on("status", (s) => { if (s.state === "running" && !ppStarted) { ppStarted = true; pandapools.startLoop(); } });

// AtomiX (atomic swaps) — the reused MDS engine (main/atomix/*) in a vm; read model + actions.
ipcMain.handle("mcd:axStatus", () => atomix.status());
ipcMain.handle("mcd:axBook", () => atomix.book());
ipcMain.handle("mcd:axQuote", (_e, sell, amount, slip) => atomix.quote(sell, amount, slip));
ipcMain.handle("mcd:axSwapPreview", (_e, sell, amount, slip) => atomix.swapPreview(sell, amount, slip));
ipcMain.handle("mcd:axSwap", (_e, quoteId) => atomix.swapExecute(quoteId));
ipcMain.handle("mcd:axSwaps", () => atomix.swaps());
ipcMain.handle("mcd:axInspect", (_e, hash) => atomix.inspect(hash));
ipcMain.handle("mcd:axMarketHistory", () => atomix.marketHistory());
ipcMain.handle("mcd:axWallet", () => atomix.wallet());
ipcMain.handle("mcd:axExportKey", () => atomix.exportKey());
ipcMain.handle("mcd:axCoins", () => atomix.coins());
ipcMain.handle("mcd:axSendMax", (_e, asset) => atomix.sendMax(asset));
ipcMain.handle("mcd:axSendReview", (_e, asset, to, amt) => atomix.sendReview(asset, to, amt));
ipcMain.handle("mcd:axSend", (_e, asset, to, amt) => atomix.sendExecute(asset, to, amt));
ipcMain.handle("mcd:axMakerCfg", () => atomix.makerCfg());
ipcMain.handle("mcd:axMakerPreview", (_e, cfg, manual) => atomix.makerPreview(cfg, manual));
ipcMain.handle("mcd:axMakerSave", (_e, cfg, manual) => atomix.makerSave(cfg, manual));
ipcMain.handle("mcd:axMakerPublish", () => atomix.makerPublish());
ipcMain.handle("mcd:axMakerWithdraw", () => atomix.makerWithdraw());
ipcMain.handle("mcd:axSwitchCurrency", (_e, key) => atomix.switchCurrency(key));
ipcMain.handle("mcd:axOtc", () => atomix.otc());
ipcMain.handle("mcd:axOtcGoLive", (_e, sell, buy) => atomix.otcGoLive(sell, buy));
ipcMain.handle("mcd:axOtcWithdraw", () => atomix.otcWithdraw());
ipcMain.handle("mcd:axOtcPropose", (_e, lp, side, amount, price) => atomix.otcPropose(lp, side, amount, price));
ipcMain.handle("mcd:axOtcDeal", (_e, ref, action, amount, price) => atomix.otcDealAction(ref, action, amount, price));
ipcMain.handle("mcd:axInvalidate", () => { atomix.invalidate(); return true; });
atomix.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:atomix"); });
atomix.emitter.on("notify", (msg) => {   // settlement/OTC milestones — OS notification when the app isn't focused
  try {
    if (win && !win.isDestroyed() && win.isFocused()) return;
    const n = new Notification({ title: "AtomiX", body: String(msg), silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (e) { /* best-effort */ }
});
let axStarted = false;
node.on("status", (s) => { if (s.state === "running" && !axStarted) { axStarted = true; atomix.startLoop(); } });

// Casino (Zero Edge Casino — on-chain commit-reveal)
ipcMain.handle("mcd:casinoStatus", () => casino.status());
ipcMain.handle("mcd:casinoOpenBets", () => casino.openBets());
ipcMain.handle("mcd:casinoMyBets", () => casino.myBets());
ipcMain.handle("mcd:casinoHistory", () => casino.history());
ipcMain.handle("mcd:casinoBalance", () => casino.balance());
ipcMain.handle("mcd:casinoCreate", (_e, preset, bet) => casino.create(preset, bet));
ipcMain.handle("mcd:casinoTake", (_e, coinid, pick) => casino.take(coinid, pick));
ipcMain.handle("mcd:casinoCancel", (_e, coinid) => casino.cancel(coinid));
ipcMain.handle("mcd:casinoResolve", (_e, coinid) => casino.resolve(coinid));
ipcMain.handle("mcd:casinoReveal", (_e, coinid) => casino.reveal(coinid));
ipcMain.handle("mcd:casinoClaimTimeout", (_e, coinid) => casino.claimTimeout(coinid));
ipcMain.handle("mcd:casinoNewCount", () => casino.newCount());
ipcMain.handle("mcd:casinoSeen", () => casino.markSeen());
ipcMain.handle("mcd:casinoInvalidate", () => { casino.invalidate(); return true; });
casino.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:casino"); });
casino.emitter.on("notify", (msg) => {   // reveal/resolve milestones — OS notification when the app isn't focused
  try {
    if (win && !win.isDestroyed() && win.isFocused()) return;
    const n = new Notification({ title: "Casino", body: String(msg), silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (e) { /* best-effort */ }
});
let casinoStarted = false;
node.on("status", (s) => { if (s.state === "running" && !casinoStarted) { casinoStarted = true; casino.startLoop(); } });

ipcMain.handle("mcd:histGet", (_e, limit) => histDb.all(limit));
ipcMain.handle("mcd:histAdd", (_e, rows) => histDb.merge(Array.isArray(rows) ? rows : []));
ipcMain.handle("mcd:histClear", async () => { await histDb.clear(); return true; });
ipcMain.handle("mcd:histQuery", (_e, filters) => histDb.query(filters || {}));
ipcMain.handle("mcd:histTokens", () => histDb.tokens());
ipcMain.handle("mcd:histStats", () => histDb.stats());
ipcMain.handle("mcd:exportCsv", async (_e, text, name) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: name || "minima-history.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(text == null ? "" : text), "utf8");
  return r.filePath;
});

// miniMall: export a .shop bundle (save dialog) / import one (open dialog → parsed JSON)
ipcMain.handle("mcd:shopExport", async (_e, json, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: (name || "shop") + ".shop", filters: [{ name: "miniMall shop", extensions: ["shop"] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(json == null ? "" : json), "utf8");
  return r.filePath;
});
ipcMain.handle("mcd:shopImport", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "miniMall shop", extensions: ["shop", "json"] }] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")); } catch (e) { throw new Error("Not a valid .shop file."); }
});

// forward node events to the window + tray
node.on("status", pushStatus);
node.on("log", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:log", node.logs.slice(-1)[0]); });

app.whenReady().then(() => {
  setupPermissions();
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
  try { pandapools.flush(); } catch (err) {}   // flush the debounced PandaPools store BEFORE any early-return path
  try { atomix.flush(); } catch (err) {}       // flush the debounced AtomiX swap DB (secrets are already sync-flushed)
  try { casino.flush(); } catch (err) {}       // casino keychain writes are sync; no-op, kept for symmetry
  try { histDb.flush(); } catch (err) {}       // flush the debounced history DB too
  if (quitting) return;
  // Always go through node.stop(), even with no node process: it also releases the router port mapping,
  // which can outlive the node (e.g. the node died on its own). Both halves are bounded, so quit stays fast.
  e.preventDefault(); quitting = true;
  try { await node.stop(); } catch (err) {}
  app.quit();
});
