/*
 * main.js — Electron entry: window + tray, IPC wiring, node lifecycle.
 *
 * The renderer is fully sandboxed (contextIsolation on, nodeIntegration off) and reaches the node only via
 * the IPC handlers here, which proxy to the local RPC using the main-held secret. On launch we start the
 * node if setup is done; otherwise the renderer runs the first-run wizard and calls nodeStart when finished.
 */
const testProfile = require("./testprofile");   // FIRST: a TEST copy moves userData and its keychain names before anything reads them
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, nativeTheme, shell, Notification, session, clipboard, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const node = require("./node-manager");
const portmap = require("./portmap");
const rpc = require("./rpc");
const restore = require("./restore");   // backup-file restore rules (key mode first)
const inflight = require("./inflight");   // what a Shutdown or a Quit would interrupt, said once for both
const { pinMinimaSend } = require("./sendpin");
const updater = require("./updater");
const loginitem = require("./loginitem");   // "Open at login" — OS login item (mac/win) or XDG autostart (linux)   // app updates from the minimaCore store feed (the jar itself ships with the app)
const netfetch = require("./netfetch");
const histDb = require("./history-db");
const faucet = require("./faucet");
const mail = require("./mail");
const chat = require("./chat");
const pandapools = require("./pandapools");
const atomix = require("./atomix");
const dexicon = require("./dexicon");
const dexiconRoom = require("./dexicon-room");
dexiconRoom.register(require("electron"));   // dxroom://exchange/: the Dexicon page for its hidden, sandboxed frame
const ethwallet = require("./ethwallet");
const shop = require("./shop");
const casino = require("./casino");
const vestr = require("./vestr");
const webwallet = require("./webwallet");
const parlons = require("./parlons");
const reserve = require("./reserve");   // the shared coin reservation (docs/COIN_RESERVATION.md); main/rpc.js calls its guard

// THE COIN RESERVATION FOLLOWS THE NODE. Registered before every engine's own status listener, so its file is being
// opened before an engine sends its first command (guard waits for the open). Opened per wallet when the node runs,
// swept once a minute against the node's real coins, closed when the node stops (the builds died with it).
reserve.onLog = (line) => node.log("[coins] " + line);
reserve.setHoldSource("dexicon", () => dexicon.coinHolds());   // the coins of live FAST orders and unanswered takes (main/dexicon.js COIN HOLDS)
let reserveSweep = null, reserveSweeping = false;
const reserveRead = (c) => rpc.rpcRead(node.rpcPort(), config.rpcSecret(), c);
node.on("status", (s) => {
  if (s.state === "running" && !reserveSweep) {
    reserve.open(app.getPath("userData"), reserveRead);
    reserveSweep = setInterval(() => {
      if (reserveSweeping || node.state !== "running") return;
      reserveSweeping = true;
      // a file that could not be opened at start (the node did not answer yet, or was locked) is tried again each minute
      (reserve._file() ? Promise.resolve() : reserve.open(app.getPath("userData"), reserveRead)).then(() => reserve.sweep(reserveRead)).catch(() => {}).then(() => { reserveSweeping = false; });
    }, 60000);
    if (reserveSweep.unref) reserveSweep.unref();
  } else if (s.state !== "running" && reserveSweep) { clearInterval(reserveSweep); reserveSweep = null; reserve.close(); }
});

let win = null;
let tray = null;

/**
 * LAST RESORT — an app supervising a node that holds real funds must not die because a socket failed.
 *
 * One did: a connect error on wake reached no listener and Electron's default handler killed the main
 * process, taking AtomiX with it (the 0.16.93 lookup regression, fixed in main/netfetch.js). Registering
 * these listeners also replaces that modal "A JavaScript error occurred in the main process" dialog.
 *
 * This is a NET, not a licence to leave faults unfixed. Everything lands in the Logs view in full, with its
 * stack, prefixed so it is impossible to mistake for node output — node.log() already splits on newlines,
 * caps each line and redacts seed phrases and private keys. Registered before anything else can throw.
 */
function logFatal(kind, err) {
  const detail = (err && err.stack) ? err.stack : String(err && err.message ? err.message : err);
  try { node.log("[app] " + kind + " — " + detail); } catch (e) { /* logging must never throw */ }
  try { console.error("[app] " + kind + ":", err); } catch (e) {}
}
process.on("uncaughtException", (err) => logFatal("UNCAUGHT EXCEPTION", err));
process.on("unhandledRejection", (reason) => logFatal("UNHANDLED REJECTION", reason));

// single instance — a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// Parlons lives in the system browser (0.19.3). The app still says when a message or a call arrives, from the
// node's own log lines (main/parlons-notify.js); a click opens the panel with a fresh one-time link.
require("./parlons-notify").install({ events: node, electron: require("electron"), window: () => win, open: () => parlons.openExternal() });

function createWindow() {
  win = new BrowserWindow({
    // Pandamonium on the unfolded Fold is 932 x 704 dp: the reference the shell is built to. The standard
    // title bar is kept (no hiddenInset): the shell's own toolbar has the tray button where the Mac's
    // traffic lights would sit. The background is Pandamonium's core_bg for the system theme.
    width: 932, height: 732, minWidth: 440, minHeight: 640,
    title: testProfile.on ? "Minima Core — TEST PROFILE" : "Minima Core",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0F1114" : "#F4F5F7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (testProfile.on) {   // a TEST copy says so in the title bar, on every screen and on the Dock icon
    win.on("page-title-updated", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => win.webContents.insertCSS('body::after{content:"TEST PROFILE";position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#B00020;color:#fff;font:700 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.08em;padding:4px 10px;border-radius:0 0 6px 6px;pointer-events:none}').catch(() => {}));
    try { if (app.dock) app.dock.setBadge("TEST"); } catch (e) {}
  }
  // No embedded web view anywhere (0.19.3: Parlons opens in the system browser). Should one ever be attached, refuse it.
  win.webContents.on("will-attach-webview", (ev) => ev.preventDefault());
  // Deny ALL child windows (no camera/etc inheritance). BUT for the ETH Wallet's Etherscan links, open them in the
  // user's real browser via shell.openExternal — allowed ONLY for the exact https://etherscan.io/ prefix so no
  // attacker-influenced or non-https scheme can ever be launched. rel=noreferrer on the anchors covers tabnabbing.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === "string" && url.startsWith("https://etherscan.io/")) { shell.openExternal(url); }
    return { action: "deny" };
  });
  // Defense-in-depth: never let the app frame itself navigate away from the bundled file:// renderer.
  win.webContents.on("will-navigate", (e, url) => { if (!String(url).startsWith("file://")) e.preventDefault(); });
  // On macOS the app/node already stays running after closing its window. Keep the call
  // receiver alive too; explicit Quit still closes it through the existing graceful shutdown.
  // Elsewhere closing the window quits the app: the quit is asked for while the window is still there, so the
  // Quit warning (before-quit) has a window to be answered in, and "Stay open" leaves it as it was.
  win.on("close", e => { if (quitting) return; e.preventDefault(); if (process.platform === "darwin") win.hide(); else app.quit(); });
  win.on("closed", () => { win = null; });
}

// Camera (the QR scanner) and microphone (a Chat voice note, asked for only when the user chooses "Voice note"):
// ONLY the `media` permission, ONLY for this app's own window (its top frame, the bundled file:// page; the CSP
// blocks remote content), and on macOS only after the system's own question for that device. Everything else,
// and every other web contents, is denied.
function ownPage(wc) {
  return !!wc && !!win && !win.isDestroyed() && wc === win.webContents && String((wc.getURL && wc.getURL()) || "").startsWith("file://");
}
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (permission !== "media" || !ownPage(wc) || (details && details.isMainFrame === false)) { cb(false); return; }
    try {
      if (process.platform === "darwin") {
        const { systemPreferences } = require("electron");
        for (const type of (details && details.mediaTypes) || []) {
          if (type === "audio" && !await systemPreferences.askForMediaAccess("microphone")) { cb(false); return; }
          if (type === "video" && !await systemPreferences.askForMediaAccess("camera")) { cb(false); return; }
        }
      }
      cb(ownPage(wc));
    } catch (e) { cb(false); }
  });
  // Mirror the request handler exactly (derive from the webContents, don't trust a null origin).
  ses.setPermissionCheckHandler((wc, permission) => permission === "media" && ownPage(wc));
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
      ...(updater.current().available ? [{ type: "separator" }, { label: "Update to minimaCore " + updater.current().version + "…", click: () => { if (win) { win.show(); win.webContents.send("mcd:openUpdate"); } } }] : []),
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ]);
    tray.setToolTip(testProfile.on ? "minimaCore — TEST PROFILE" : "minimaCore");
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
  // A backup file brings its own keys, in its own key mode: only Backup & Recovery restores one, after the mode check.
  if (restore.loadsBackupFile(command)) throw new Error("Restoring a backup file replaces this wallet's keys. Use Backup & Recovery, Restore from file: it checks the backup's key mode first.");
  // Replacing the wallet from a seed phrase resets every identity made from the old one: refused while work that needs the old keys is open.
  if (restore.replacesWalletFromPhrase(command)) { const open = restore.activeWorkProblem(await walletWork()); if (open) throw new Error(open); }
  const bad = restore.backupCommandProblem(command);
  if (bad) throw new Error(bad);
  // megammrsync ends by shutting the node down: run it with that expected, then start the node again (guarded).
  if (restore.isResync(command)) return node.runResync(command);
  const run = (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c);
  // Shared-node fund-safety: a MINIMA `send` (wallet Send/Split) must not auto-select anyone-can-spend beacon dust
  // (PandaPools etc.) as its input → KeyRow.getPrivateKey() null. Pin it to a signable coin. Non-send cmds pass through.
  const pinned = /^send\s/.test(command) ? await pinMinimaSend(run, command) : command;
  return run(pinned);
});

// Clipboard writes go through the main process — main-process clipboard.writeText is synchronous and never subject
// to the renderer navigator.clipboard's focus/permission failures (which silently left stale data on the clipboard
// while the UI still said "Copied"). Coerce nullish to "" so it never writes the string "null"/"undefined".
ipcMain.handle("mcd:clip", (_e, text) => { clipboard.writeText(text == null ? "" : String(text)); return true; });

// Startup Params "Copy RPC password": main process to clipboard. The password is never returned to the renderer.
ipcMain.handle("mcd:copyRpcPassword", () => { clipboard.writeText(config.rpcSecret()); return true; });

ipcMain.handle("mcd:appVersion", () => app.getVersion());
ipcMain.handle("mcd:getConfig", () => { const c = config.load(); return c; });
ipcMain.handle("mcd:saveConfig", (_e, patch) => {
  if (patch) delete patch.casinoEnabled;   // P2P Chance is removed: nothing may switch its settle-only gate on (or off)
  const c = config.save(patch || {});
  if (patch && "openAtLogin" in patch) c.loginItem = loginitem.apply(app, c.openAtLogin);   // transient status for the Settings toast, not persisted
  return c;
});
// Key mode (main/keymode.js). The renderer may ASK for a mode when a wallet is created or restored; config
// records it once and refuses any later change. Block is refused outright on a jar that cannot run it.
ipcMain.handle("mcd:keyMode", () => ({ mode: config.load().keyMode, supported: node.blockKeysSupported() }));
ipcMain.handle("mcd:recordKeyMode", (_e, mode) => {
  if (mode === "block" && !node.blockKeysSupported()) throw new Error("The node in this version of the app cannot run a block key wallet.");
  return config.recordKeyMode(mode === "block" ? "block" : "classic");
});
// What replacing the wallet would strand, asked of the existing read models (main/restore.js activeWorkList).
const walletWork = async (skipDexicon = Date.now() < dexSkipUntil) => restore.activeWorkList({ atomix: await atomix.activeWork().catch(() => null), pools: await pandapools.activeWork().catch(() => null),
  casino: config.load().casinoEnabled ? casino.open() : null, poolsState: pandapools.status(), ownPools: await pandapools.ownPools().catch(() => null),   // 0.18.137: why PandaPools cannot be checked; this wallet's own open pools
  dexicon: await dexicon.activeWork().catch(() => null), skipDexicon });
// The wallet under the app was replaced (node-manager runResync: megammrsync with phrase: or file:). Called by the
// MAIN process while the node is stopped and before it is started again, so it does not depend on the window being
// open, and no engine ticks on the new wallet with the old wallet's records. Every identity-bound store is set aside
// (never deleted), each on its own: one that fails does not stop the others, and all failures are reported together.
// The renderer's own reset chain (app.js walletReplaced) now only clears what is on screen.
node.onWalletReplaced = async () => {
  const failed = [];
  const each = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name + ": " + ((e && e.message) || e)); } };
  await each("minimaMail", () => mail.invalidateIdentity());
  await each("PandaPools", () => pandapools.invalidate());
  await each("AtomiX", () => atomix.invalidate());
  await each("Dexicon", () => dexicon.invalidate({ hold: true }));   // it starts with the node, on the new wallet
  await each("P2P Chance", () => casino.invalidate());
  await each("coin reservations", () => reserve.invalidate());   // every reservation belongs to the old wallet's coins
  node.log("[app] wallet replaced: minimaMail, PandaPools, AtomiX, Dexicon and P2P Chance were reset in the main process" + (failed.length ? "; NOT reset: " + failed.join("; ") : ""));
  if (failed.length) throw new Error(failed.join("; "));
};
// Around a wallet-replacing megammrsync (node-manager runResync, 0.18.116): the three trading engines are stopped
// before the command is sent and stay stopped until it is known which wallet the node holds; they then go on, on
// their own stores (the same wallet) or on new ones (onWalletReplaced above has run in between).
node.onEnginesHold = async () => { await Promise.all([dexicon.hold(), atomix.hold(), pandapools.hold()]); };
// Before the node is told to quit (node-manager stop(), 0.18.117): what the engines have at the node ends first, so a
// posted action is recorded by the engine that posted it. Each wait is bounded (Dexicon: main/dexicon.js STOP DRAINS).
node.onStopping = () => Promise.all([dexicon.stop(), atomix.quiet(10000), pandapools.quiet(10000)]);
node.onEnginesRelease = () => { atomix.release(); pandapools.release(); dexicon.release(); if (node.state === "running") dexicon.start(); };
// Restore from a backup FILE (main/restore.js): the backup's key mode must be this install's recorded one.
ipcMain.handle("mcd:restoreBackup", (_e, o) => restore.restoreBackup(o, { keyMode: config.load().keyMode, supported: node.blockKeysSupported(),
  running: node.state === "running", run: (c) => node.runResync(c), work: walletWork }));
ipcMain.handle("mcd:defaultDataFolder", () => config.defaultDataFolder());
ipcMain.handle("mcd:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

ipcMain.handle("mcd:nodeStatus", () => node.snapshot());
ipcMain.handle("mcd:nodeStart", async () => { await node.start(); return node.snapshot(); });
// Stop whatever node holds our port/data folder (an earlier launch's), then start. Same reclaim as every start.
ipcMain.handle("mcd:nodeReclaim", async () => { await node.stop(); await node.start(); return node.snapshot(); });
ipcMain.handle("mcd:nodeStop", async () => { await node.stop(); return node.snapshot(); });
// What a Shutdown (the node stops) or a Quit (the app goes) would interrupt: each engine's own activeWork(), read here
// and said by main/inflight.js for BOTH, so the two warnings cannot disagree (0.18.142). null = could not be asked.
const inFlightWork = async () => ({ atomix: await atomix.activeWork().catch(() => null), pools: await pandapools.activeWork().catch(() => null),
  dexicon: await dexicon.activeWork().catch(() => null), casino: config.load().casinoEnabled ? casino.open() : null, casinoOn: !!config.load().casinoEnabled });
ipcMain.handle("mcd:inFlight", async (_e, how) => { const w = inflight.inFlight(await Promise.race([inFlightWork(), new Promise(r => setTimeout(() => r({}), 5000))]), how === "quit" ? "quit" : "shutdown", Date.now()); return { title: w.title, message: w.message, any: w.any }; });
ipcMain.handle("mcd:nodeRestart", async () => { await node.restart(); return node.snapshot(); });
ipcMain.handle("mcd:nodeLogs", () => node.logs.slice(-800));
ipcMain.handle("mcd:portmapStatus", () => portmap.status());

// Parlons account (Parlons Node kind): status for its screen, "open in the browser" (the one-time link is read and
// handed to the system browser here; the renderer never holds it), and the kind switch (restarts the node).
ipcMain.handle("mcd:parlonsStatus", () => parlons.status());
ipcMain.handle("mcd:parlonsOpenExternal", () => parlons.openExternal());
ipcMain.handle("mcd:setNodeKind", async (_e, kind) => {
  const k = kind === "minima" ? "minima" : "parlons";
  if (k === "parlons") { const why = node.parlonsBlocker(); if (why) throw new Error(why); }
  // A block wallet cannot move to a node jar that does not know block keys: say so before anything is saved.
  if (config.load().keyMode === "block" && !require("./keymode").jarSupportsBlock(path.join(path.dirname(node.jarPath()), k === "parlons" ? "parlons-node.jar" : "minima.jar")))
    throw new Error("This wallet uses block key uses, and that node cannot run it.");
  config.save({ nodeKind: k });
  chat.stopLoop();   // restart re-gates chat (both kinds run keets since 0.18.6)
  await node.restart();
  return node.snapshot();
});

// JAR UPDATER DISABLED. The node jar is shipped with the app and is the only jar we run.
// It pointed at a GitHub releases feed defaulting to eurobuddha/minima-core — a private repo with
// no releases — so it could never find anything; and were that repo opened up, desktop users would
// silently be moved onto fork builds. The handlers stay registered so any caller gets a clear
// answer instead of an "no handler registered" throw.
// App updates: the one-app store feed (main/updater.js). The node jar ships with the app and is never updated alone.
ipcMain.handle("mcd:updateStatus", () => updater.current());
ipcMain.handle("mcd:updateCheck", async () => { await updater.check(); return updater.current(); });
ipcMain.handle("mcd:updateDownload", async () => { const p = await updater.download(); return { path: p, status: updater.current() }; });
ipcMain.handle("mcd:checkJarUpdate", () => ({ available: false, reason: "Node updates ship with the app." }));
ipcMain.handle("mcd:applyJarUpdate", async () => { throw new Error("The in-app node updater is disabled."); });

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
ipcMain.handle("mcd:mailSetName", (_e, n) => { mail.setName(n); return mail.myIdentity(); });
ipcMain.handle("mcd:mailAddressWords", () => require("./mailaddress").words);
ipcMain.handle("mcd:mailResolveAddress", (_e, value) => mail.resolveRecipient(value));
ipcMain.handle("mcd:mailCheckOwnBeacon", () => mail.checkOwnBeacon());
ipcMain.handle("mcd:mailPublishAddress", (_e, key, enabled) => mail.setPublication(key, enabled === true));
ipcMain.handle("mcd:mailSetTheme", (_e, theme) => mail.setTheme(theme));
ipcMain.handle("mcd:mailPayOptions", () => mail.payOptions());
ipcMain.handle("mcd:mailShare", () => mail.shareString());
ipcMain.handle("mcd:mailThreads", () => mail.threads());
ipcMain.handle("mcd:mailReadMessage", (_e, hash, id) => mail.readMessage(hash, id));
ipcMain.handle("mcd:mailThread", (_e, h) => mail.thread(h));
ipcMain.handle("mcd:mailThreadWith", (_e, peer, subject) => mail.threadWith(peer, subject));
ipcMain.handle("mcd:mailSend", (_e, to, base) => mail.sendMessage(to, base || {}));
ipcMain.handle("mcd:mailRetry", (_e, hashref, randomid) => mail.retrySend(hashref, randomid));
ipcMain.handle("mcd:mailOutbox", () => mail.outbox());
ipcMain.handle("mcd:mailSent", () => mail.sent());
ipcMain.handle("mcd:mailStatus", () => mail.status());
ipcMain.handle("mcd:mailBackfill", () => mail.startBackfill());

// KeetChat — pubkey-addressed E2E messages over the keets transport (main/chat.js owns
// the sidecar inbox; renderer reads/writes through these only). Both node kinds.
ipcMain.handle("mcd:chatInit", async () => { await chat.init(); return chat.myIdentity(); });
ipcMain.handle("mcd:chatIdentity", () => chat.myIdentity());
ipcMain.handle("mcd:chatSetName", (_e, n) => { chat.setName(n); return chat.myIdentity(); });
ipcMain.handle("mcd:chatThreads", () => chat.threads());
ipcMain.handle("mcd:chatThread", (_e, pk) => chat.thread(pk));
ipcMain.handle("mcd:chatSend", (_e, to, text) => chat.send(to, text));
ipcMain.handle("mcd:chatAddContact", (_e, pk, name) => chat.addContact(pk, name));
ipcMain.handle("mcd:chatRenameContact", (_e, pk, name) => chat.renameContact(pk, name));
ipcMain.handle("mcd:chatRemoveContact", (_e, pk) => chat.removeContact(pk));
ipcMain.handle("mcd:chatStatus", () => chat.status());
ipcMain.handle("mcd:chatMedia", (_e, ref) => chat.fetchMedia(ref));
ipcMain.handle("mcd:chatSendPayment", (_e, to, amount, token) => chat.sendPayment(to, amount, token));
ipcMain.handle("mcd:chatRequestPayAddr", (_e, to) => chat.requestPayAddr(to));
ipcMain.handle("mcd:chatPayAddr", (_e, to) => chat.payAddrOf(to));
ipcMain.handle("mcd:chatContacts", () => chat.contacts());
ipcMain.handle("mcd:chatClearThread", (_e, pk) => chat.clearThread(pk));
ipcMain.handle("mcd:chatDeleteMessage", (_e, id) => chat.deleteMessage(id));
ipcMain.handle("mcd:chatSendVoice", (_e, to, bytes, mime, secs, wave) => chat.sendVoice(to, bytes, mime, secs, wave));
// Files (0.19.2). The renderer never names a path: sending goes through an open dialog, saving through a save dialog
// whose default name is the peer's file name made safe. A saved file is never opened by the app.
ipcMain.handle("mcd:chatFileSend", async (_e, to) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], title: "File (up to 100 MB)" });
  if (r.canceled || !r.filePaths.length) return null;
  return chat.fileSend(to, r.filePaths[0]);
});
ipcMain.handle("mcd:chatFileOffer", (_e, peer, ref) => chat.fileOffer(peer, ref));
ipcMain.handle("mcd:chatFileRun", (_e, peer, ref, id) => chat.fileRun(peer, ref, id));
ipcMain.handle("mcd:chatFilePause", (_e, id) => chat.filePause(id));
ipcMain.handle("mcd:chatFileStatus", (_e, id) => chat.fileStatus(id));
ipcMain.handle("mcd:chatFileTransfers", (_e, peer) => chat.fileTransfers(peer));
ipcMain.handle("mcd:chatFileRemove", (_e, id) => chat.fileRemove(id));
ipcMain.handle("mcd:chatFileKeep", (_e, id, on) => chat.fileKeep(id, on));
ipcMain.handle("mcd:chatFileShareAgain", (_e, id) => chat.fileShareAgain(id));
ipcMain.handle("mcd:chatFileSave", async (_e, id) => {
  const st = chat.fileStatus(id);
  if (!st || !st.canSave) throw new Error("The file is not verified yet.");
  const r = await dialog.showSaveDialog(win, { defaultPath: require("./chatfiles").safeName(st.name) });
  if (r.canceled || !r.filePath) return { canceled: true };
  await chat.fileSave(id, r.filePath);
  return { canceled: false, path: r.filePath };
});
ipcMain.handle("mcd:chatSendImage", async (_e, to) => {
  const r = await dialog.showOpenDialog(win, { title: "Send a photo",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }], properties: ["openFile"] });
  if (r.canceled || !r.filePaths.length) return null;
  return chat.sendImageFile(to, r.filePaths[0]);
});
ipcMain.handle("mcd:mailPay", (_e, to, payaddr, amount, tokenid, tokenname, memo, subject) => mail.pay(to, payaddr, amount, tokenid, tokenname, memo, subject));
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
// Chat backup (.kbak) — the same file the bears write (apks/base ChatBackup.java): keets keypair +
// every chat contact and message. The keypair never reaches the renderer; addresses travel IN FULL.
const chatbackup = require("./chatbackup");
const chatStore = require("./chat-store");
let pendingChatBackup = null;
const keetsKeypairFile = () => path.join(node.dataDir(), "keets", "keypair");
ipcMain.handle("mcd:chatExportBackup", async (_e, pass) => {
  if (typeof pass !== "string" || pass.length < 8) throw new Error("Use a password of at least 8 characters.");
  let keypair = null;
  try { keypair = fs.readFileSync(keetsKeypairFile()); } catch (e) { /* keets never ran: chats only */ }
  try { await chat.init(); } catch (e) { /* node down: the manifest's address stays blank */ }
  const all = chatStore.all(), payaddr = {};
  for (const [k, v] of Object.entries(all.meta)) if (k.startsWith("payaddr:")) payaddr[k.slice(8)] = v;
  const file = chatbackup.exportBackup(pass, { keypair, keetsPubkey: chat.myIdentity().pubkey, chatName: all.meta.myname || "",
    contacts: all.contacts, messages: all.messages, payaddr });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const r = await dialog.showSaveDialog(win, { defaultPath: "keets-chat-backup-" + stamp + ".kbak", filters: [{ name: "Chat backup", extensions: ["kbak"] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, file);
  return { canceled: false, path: r.filePath, contacts: all.contacts.length, messages: all.messages.length };
});
ipcMain.handle("mcd:chatOpenBackup", async (_e, pass) => {
  if (typeof pass !== "string" || !pass) throw new Error("Enter the backup's password.");
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Chat backup", extensions: ["kbak"] }, { name: "All files", extensions: ["*"] }] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  if (fs.statSync(r.filePaths[0]).size > chatbackup.MAX_FILE) throw new Error("That file is too large to be a chat backup.");
  let opened;
  try { opened = chatbackup.openBackup(pass, fs.readFileSync(r.filePaths[0])); }
  catch (e) { throw new Error(e.message === "BAD_PASSWORD" ? "Wrong password, or this is not a chat backup." : e.message); }
  pendingChatBackup = opened;
  try { await chat.init(); } catch (e) { /* node down */ }
  return { canceled: false, keetsPubkey: opened.manifest.keetsPubkey || "", maxAddress: opened.manifest.maxAddress || "",
    current: chat.myIdentity().pubkey, contacts: opened.contacts.length, messages: opened.messages.length, hasMax: opened.hasMax };
});
ipcMain.handle("mcd:chatApplyBackup", async () => {
  const b = pendingChatBackup; pendingChatBackup = null;
  if (!b) throw new Error("Open the backup again.");
  // The sidecar reads its keypair only at spawn: stop the node, write, start.
  chat.stopLoop();
  await node.stop();
  if (b.keypair) {
    fs.mkdirSync(path.dirname(keetsKeypairFile()), { recursive: true });
    const tmp = keetsKeypairFile() + ".restore";
    fs.writeFileSync(tmp, b.keypair, { mode: 0o600 });
    fs.renameSync(tmp, keetsKeypairFile());
  }
  const payaddr = {};
  for (const c of b.contacts) if (c.payaddr) payaddr[c.pubkey] = c.payaddr;
  chatStore.mergeBackup(b.contacts, b.messages, payaddr, b.manifest.chatName || "");
  chat.forgetIdentity();
  await node.start();   // status "running" restarts the chat loop
  return true;
});

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
// A payment message is its sender's claim (0.19.7). The screens ask here whether this node has found it; what is not
// found is looked for again on each new block, within main/payverify.js's limits. Reads only, never the signing queue.
const payverify = require("./payverify").create({ run: (c) => rpc.rpcRead(node.rpcPort(), config.rpcSecret(), c),
  onChange: () => { mail.emitter.emit("update"); chat.emitter.emit("update"); } });
ipcMain.handle("mcd:payCheck", (_e, txid, tokenid, amount) => node.state === "running" ? payverify.ask({ txid, tokenid, amount }) : "unverified");
let payBlock = 0;
node.on("status", (s) => {
  if (s.state !== "running") { if (s.state === "starting") { payverify.reset(); payBlock = 0; } return; }
  const b = s.health && s.health.block;
  if (b && b !== payBlock) { payBlock = b; payverify.onBlock().catch(() => {}); }
});
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
// KeetChat: updates -> renderer; OS notification on fresh incoming when unfocused
chat.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:chat"); });
chat.emitter.on("incoming", (info) => {
  try {
    if (!info || (win && !win.isDestroyed() && win.isFocused())) return;
    const title = info.count > 1 ? "KeetChat" : (info.name || "KeetChat");
    const body = info.count > 1 ? info.count + " new messages" : (info.preview || "New message");
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send("mcd:chat-focus"); } });
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
node.on("status", (s) => { if (s.state === "running") chat.startLoop(); });

// PandaPools (AMM) — read model + actions; the AMM logic is the reused MDS core (main/pandapools/*).
ipcMain.handle("mcd:ppPools", () => pandapools.pools());
ipcMain.handle("mcd:ppMyPools", () => pandapools.myPools());
ipcMain.handle("mcd:ppActivity", () => pandapools.activity());
ipcMain.handle("mcd:ppStatement", () => pandapools.statement());
ipcMain.handle("mcd:ppConsolidationCheck", () => pandapools.consolidationCheck());
// What the engines hold of the wallet's coins (main/reserve.js), for the Wallet's figures and the coins dialog: every
// held coin with what holds it (ids whole), and per token what the wallet itself can and cannot send. Read only.
ipcMain.handle("mcd:reserved", async () => {
  if (node.state !== "running") return { coins: [], funds: [] };
  return { coins: reserve.list().filter(r => r.owner !== "wallet"), funds: await reserve.funds("wallet", reserveRead) };
});
ipcMain.handle("mcd:ppFeed", () => pandapools.feed());
ipcMain.handle("mcd:ppScan", () => pandapools.scanNow());
ipcMain.handle("mcd:ppQuote", (_e, tok, minimaToToken, amount) => pandapools.quoteSwap(tok, minimaToToken, amount));
ipcMain.handle("mcd:ppPairInfo", (_e, tok) => pandapools.pairInfo(tok));
ipcMain.handle("mcd:ppAggregate", () => pandapools.aggregateInfo());
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
ipcMain.handle("mcd:ppInvalidate", async () => { await pandapools.invalidate(); return true; });
ipcMain.handle("mcd:ppBackup", () => pandapools.backup());
ipcMain.handle("mcd:ppRestore", (_e, json) => pandapools.restore(json));
ipcMain.handle("mcd:ppRecoverSaved", (_e, addr) => pandapools.recoverSaved(addr));
ipcMain.handle("mcd:ppRetirePool", (_e, addr, retired) => pandapools.retirePool(addr, retired));
ipcMain.handle("mcd:ppListRetired", () => pandapools.listRetired());
ipcMain.handle("mcd:ppPendingCollect", () => pandapools.pendingCollect());
ipcMain.handle("mcd:ppArchiveSettings", (_e, url) => pandapools.archiveSettings(url));
ipcMain.handle("mcd:ppConfirmSigning", (_e, opk, attested) => pandapools.confirmSigning(opk, attested));
ipcMain.handle("mcd:ppCompleteBackupRequired",()=>pandapools.completeBackupRequired());
ipcMain.handle("mcd:ppStatus", () => pandapools.status());
ipcMain.handle("mcd:ppWhy", () => pandapools.lastNodeFailure());   // the node's last refusal of a pool command: { verb, error, at } or null
ipcMain.handle("mcd:ppSaveBackup", async (_e, password) => {
  return pandapools.completeBackup(password,async bytes=>{
    const r=await dialog.showSaveDialog(win,{defaultPath:'pandapools-full-'+Date.now()+'.ppbackup',filters:[{name:'Encrypted pool + node backup',extensions:['ppbackup']}]});
    if(r.canceled||!r.filePath)return {canceled:true};
    await fs.promises.writeFile(r.filePath,bytes,{mode:0o600});
    const B=require('./pandapools/combined-backup'),st=await fs.promises.stat(r.filePath);
    if(st.size!==bytes.length||await B.sha(await fs.promises.readFile(r.filePath))!==await B.sha(bytes))throw Error('BACKUP_NOT_VERIFIED: saved bytes differ. Choose another location.');
    return {canceled:false,path:r.filePath};
  });
});
ipcMain.handle("mcd:ppLoadBackup", async (_e, password, extractNode) => {
  const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'PandaPools backup',extensions:['ppbackup','json']}]});
  if(r.canceled||!r.filePaths.length)return {canceled:true};
  const B=require('./pandapools/combined-backup'),file=r.filePaths[0],st=await fs.promises.stat(file);
  if(st.size>B.MAX_FILE)throw Error('BACKUP_TOO_LARGE');
  const bytes=await fs.promises.readFile(file);
  if(bytes.subarray(0,4).toString('ascii')!=='MVLT'){
    if(bytes.length>4*1024*1024||extractNode)throw Error('This is a legacy pool-only file; no node backup is included.');
    return {canceled:false,json:bytes.toString('utf8')};
  }
  const opened=await B.open(password,bytes);await pandapools.validateCompleteRecipes(opened.poolJson);
  if(extractNode){
    const chosen=await dialog.showSaveDialog(win,{defaultPath:'pandapools-node-recovery-'+Date.now()+'.bak',filters:[{name:'Native node backup',extensions:['bak']}]});
    if(chosen.canceled||!chosen.filePath){opened.node.fill(0);return {canceled:true};}
    try{
      await fs.promises.writeFile(chosen.filePath,opened.node,{mode:0o600});
      if((await fs.promises.stat(chosen.filePath)).size!==opened.node.length||await B.sha(await fs.promises.readFile(chosen.filePath))!==opened.manifest.nodeSha256)throw Error('NODE_EXPORT_NOT_VERIFIED');
      // Shown deliberately for the user's native restore flow, never logged or persisted as plaintext.
      return {canceled:false,nodePassword:opened.manifest.nodePassword,path:chosen.filePath};
    }finally{opened.node.fill(0);}
  }
  opened.node.fill(0);return {canceled:false,json:opened.poolJson,combined:true};
});
pandapools.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:pandapools"); });
let ppStarted = false;
let ppNodeWasDown = false;   // in-app node restart → re-fire the PandaPools service boot (hygiene sweep re-run)
node.on("status", (s) => {
  if (s.state === "running" && !ppStarted) { ppStarted = true; pandapools.startLoop(); return; }
  if (s.state !== "running" && ppStarted) { ppNodeWasDown = true; return; }
  if (s.state === "running" && ppStarted && ppNodeWasDown) { ppNodeWasDown = false; pandapools.onNodeRestarted(); }
});

// AtomiX (atomic swaps) — the reused MDS engine (main/atomix/*) in a vm; read model + actions.
ipcMain.handle("mcd:axStatus", () => atomix.status());
ipcMain.handle("mcd:axBook", () => atomix.book());
ipcMain.handle("mcd:axQuote", (_e, sell, amount, slip) => atomix.quote(sell, amount, slip));
ipcMain.handle("mcd:axSwapPreview", (_e, sell, amount, slip) => atomix.swapPreview(sell, amount, slip));
ipcMain.handle("mcd:axSwap", (_e, quoteId) => atomix.swapExecute(quoteId));
ipcMain.handle("mcd:axSwaps", () => atomix.swaps());
ipcMain.handle("mcd:axRefundNow", (_e, hash) => atomix.refundNow(hash));
ipcMain.handle("mcd:axExportSwaps", () => atomix.exportSwaps());
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

// Dexicon (room 3, Exchange) — the Dexicon MiniDapp's engine (main/dexicon/*) in a vm; read model + the command
// bridge the Dexicon screens use (main/dexicon.js command(): an allow-list of node verbs, the engine's own SQL, and
// packets to the service). It runs only while the node is "running" (so: after the wallet exists and the key-mode
// gate has passed) and stops with it.
ipcMain.handle("mcd:dxStatus", () => dexicon.status());
ipcMain.handle("mcd:dxBook", () => dexicon.book());
ipcMain.handle("mcd:dxMine", () => dexicon.mine());
// { op: "identity" }: the page asks for its trading identity. Derived here, put straight into the page's sandboxed
// frame (main/dexicon-room.js deliverIdentity), and NOT returned: the answer says only whether it was delivered.
ipcMain.handle("mcd:dxCommand", async (e, a) => {
  if (a && a.op === "identity") { let seed; try { dexicon.checkEpoch(a); seed = await dexicon.identitySeed(); } catch (err) { return { status: false, error: (err && err.message) || "the trading identity could not be read" }; } return dexiconRoom.deliverIdentity(e.sender, seed); }
  return dexicon.command(a);
});
// A wallet replacement blocked ONLY because Dexicon cannot be checked (it never became ready, or its store is
// damaged): the screen has shown restore.DEX_SKIP_WARNING and the user chose to go on. Checked again here; then the
// Dexicon check is left out for two minutes. Everything else that blocks a replacement still does.
let dexSkipUntil = 0;
ipcMain.handle("mcd:dxSkipWarning", async () => restore.skipWarning(await walletWork(false)));   // 0.18.137: what stands in the way NOW, word for word (Dexicon alone: its own text)
ipcMain.handle("mcd:dxSkipCheck", async () => {
  const list = await walletWork(false);
  if (!restore.onlyDexiconUnchecked(list)) throw new Error(list.length ? restore.activeWorkProblem(list) : "Dexicon can be checked now. Try the restore again.");
  dexSkipUntil = Date.now() + 120000;
  node.log("[app] the user chose to replace the wallet after this warning: " + list.join(" | "));
  return true;
});
// A store that cannot be opened (0.18.137): the room shows the error, and the user may have the file moved aside
// under a dated name (never deleted) so the engine starts on an empty one. Only for an engine whose last start failed.
ipcMain.handle("mcd:engineSetAside", (_e, which) => {
  const eng = which === "atomix" ? atomix : which === "pandapools" ? pandapools : null;
  if (!eng) throw new Error("No such engine.");
  const kept = eng.setAsideStore();
  node.log("[app] the " + which + " store could not be opened and was set aside by the user: " + (kept || "(there was no file)"));
  if (node.state === "running") eng.startLoop();
  return kept;
});
// No mcd:dxInvalidate: a window cannot move the store aside, and a wallet replacement does not wait for a window
// to say so (walletReplaced, below).
dexicon.emitter.on("comms", (message) => { if (win && !win.isDestroyed()) win.webContents.send("mcd:dexicon", message); });   // service → screens
dexicon.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:dexicon", null); });           // a new block, or a wallet reset
node.on("status", (s) => { if (s.state === "running") dexicon.start(); else dexicon.stop(); });

// ETH Wallet — a standalone full-parity ERC20 wallet on the SAME seed-derived address, reusing the AtomiX engine.
ipcMain.handle("mcd:ewStatus", () => ethwallet.status());
ipcMain.handle("mcd:ewBalances", () => ethwallet.balances());
ipcMain.handle("mcd:ewTokens", () => ethwallet.tokens());
ipcMain.handle("mcd:ewAddToken", (_e, addr) => ethwallet.addToken(addr));
ipcMain.handle("mcd:ewRemoveToken", (_e, addr) => ethwallet.removeToken(addr));
ipcMain.handle("mcd:ewSendMax", (_e, asset) => ethwallet.sendMax(asset));
ipcMain.handle("mcd:ewSendReview", (_e, asset, to, amt) => ethwallet.sendReview(asset, to, amt));
ipcMain.handle("mcd:ewSend", (_e, asset, to, amt, tier) => ethwallet.sendExecute(asset, to, amt, tier));
ipcMain.handle("mcd:ewExportKey", () => ethwallet.exportKey());
ipcMain.handle("mcd:ewSetRpc", (_e, url) => ethwallet.setRpc(url));
ethwallet.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:ethwallet"); });

// P2P Chance was removed in 0.18.68. What is left only SETTLES bets a wallet already has on the chain (reveal,
// resolve, withdraw its own open offers, claim timeouts — main/casino.js). It runs at once for an install whose
// config says casinoEnabled (nothing in the app can turn that on any more). Every other install only LOOKS, read-only,
// for this wallet's own bets on the covenant — the old "Disable" button only hid the tab, so such a wallet can still
// have an open offer or a taken bet — and the loop starts only if one is found. No bets: no casino writes at all.
ipcMain.handle("mcd:casinoOpen", () => casino.open());
ipcMain.handle("mcd:casinoInvalidate", () => { casino.invalidate(); return true; });
casino.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:casino"); });
let casinoStarted = false;
function startCasinoIfEnabled() {
  if (casinoStarted) return;
  if (node.state !== "running") return;
  casinoStarted = true;
  if (require("./config").load().casinoEnabled) casino.startLoop(); else casino.watch();
}
node.on("status", (s) => { if (s.state === "running") startCasinoIfEnabled(); });

// Vestr (token vesting)
ipcMain.handle("mcd:vestrStatus", () => vestr.status());
ipcMain.handle("mcd:vestrList", () => vestr.list());
ipcMain.handle("mcd:vestrTokens", () => vestr.tokens());
ipcMain.handle("mcd:vestrMyAddress", () => vestr.myAddress());
ipcMain.handle("mcd:vestrCreate", (_e, opts) => vestr.create(opts));
ipcMain.handle("mcd:vestrCollect", (_e, coinid, burn) => vestr.collect(coinid, burn));
ipcMain.handle("mcd:vestrCalculate", (_e, amount, startMs, endMs, graceHours) => vestr.calculate(amount, startMs, endMs, graceHours));
vestr.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:vestr"); });
let vestrStarted = false;
node.on("status", (s) => { if (s.state === "running" && !vestrStarted) { vestrStarted = true; vestr.startLoop(); } });

// Web Wallet (local, megammr-gated). All node I/O + fund logic lives in webwallet.js; the seed reaches only
// the local node over loopback. `wwEnableMegammr` sets the -megammr param and restarts (the tab's warning CTA).
ipcMain.handle("mcd:wwMegammr", () => webwallet.isMegammr());
ipcMain.handle("mcd:wwDerive", (_e, seed) => webwallet.derive(seed));
ipcMain.handle("mcd:wwRead", (_e, address, nodeSeed) => webwallet.read(address, nodeSeed));
ipcMain.handle("mcd:wwKeyuses", (_e, address) => webwallet.keyusesInfo(address));
ipcMain.handle("mcd:wwAckKeyuses", (_e, address, count) => webwallet.ackKeyuses(address, count));
ipcMain.handle("mcd:wwSend", (_e, opts) => webwallet.send(opts));
ipcMain.handle("mcd:wwEnableMegammr", async () => {
  const c = config.load();
  config.save({ params: Object.assign({}, c.params, { megammr: true }) });
  await node.restart();
  return node.snapshot();
});
webwallet.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:webwallet"); });

ipcMain.handle("mcd:histGet", (_e, limit) => histDb.all(limit));
ipcMain.handle("mcd:histAdd", (_e, rows) => histDb.merge(Array.isArray(rows) ? rows : []));
ipcMain.handle("mcd:histImport", (_e, rows) => histDb.importRows(rows));   // a file's rows: adds only, refuses past the cap, never trims
ipcMain.handle("mcd:histClear", async () => { await histDb.clear(); return true; });
ipcMain.handle("mcd:histQuery", (_e, filters) => histDb.query(filters || {}));
ipcMain.handle("mcd:histTokens", () => histDb.tokens());
ipcMain.handle("mcd:histStats", () => histDb.stats());
ipcMain.handle("mcd:exportCsv", async (_e, text, name) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: name || "minima-history.csv",
    filters: /\.json$/i.test(String(name || "")) ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "CSV", extensions: ["csv"] }]   // the History JSON backup saves through here too
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(text == null ? "" : text), "utf8");
  return r.filePath;
});

// History "Import history (restore / merge)": the user picks a JSON export; its TEXT goes back to the renderer,
// which checks every record before anything is stored. Nothing is read without the dialog. 64 MB at most.
ipcMain.handle("mcd:importJson", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "History export", extensions: ["json"] }, { name: "All files", extensions: ["*"] }] });
  if (r.canceled || !r.filePaths.length) return null;
  if (fs.statSync(r.filePaths[0]).size > 64 * 1024 * 1024) throw new Error("That file is larger than 64 MB.");
  return fs.readFileSync(r.filePaths[0], "utf8");
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
  if (c.keyMode) config.recordKeyMode(c.keyMode);   // writes down the mode of an install from before the mode existed (classic), for good
  if (c.setupDone && c.walletDone) node.start();
  if (c.openAtLogin) loginitem.apply(app, true);   // re-register every boot: survives a moved AppImage or a reinstall
  if (!testProfile.on) updater.start();   // a TEST copy never reads the update feed or offers an installer
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (win) { win.show(); win.focus(); } });
});

// The node must never outlive the app: a normal quit goes through before-quit → node.stop() (graceful);
// these two are the last resort for every other way out (uncaught exception, will-quit after a failed
// stop). A SIGKILL of the app itself is what reclaimStaleNode() on the next start is for.
app.on("will-quit", () => { try { node.killNow(); } catch (e) {} });
process.on("exit", () => { try { node.killNow(); } catch (e) {} });

app.on("window-all-closed", () => { /* keep running in tray on mac; quit elsewhere */ if (process.platform !== "darwin") app.quit(); });

// QUIT (0.18.142). Three ways in: the user (Quit in the tray or the menu, Cmd-Q, closing the window off the Mac), the
// system (logout, restart, power off), and the app itself after it has stopped the node (the second pass, below).
//  - A user's quit with work in flight, or with an engine that could not be asked, is ASKED first, in the same words
//    as the Shutdown warning (main/inflight.js). "Stay open" leaves everything as it was.
//  - A quit the system asked for is never held behind a question nobody may be there to answer. It goes on, and what
//    was in flight is written to the log. (This app has no updater that quits it: an update is downloaded and shown
//    in the Downloads folder, and the user installs it.)
//  - Either way the node is then stopped through node.stop(): every engine first finishes what it has at the node,
//    each within its own bound and 30 s in all (0.18.117), so a transaction posted in the last second is recorded.
let quitting = false, quitAsking = false, systemQuit = false;
app.whenReady().then(() => { try { powerMonitor.on("shutdown", () => { systemQuit = true; }); } catch (e) { /* Windows: session-end below */ } });
app.on("browser-window-created", (_e, w) => { w.on("session-end", () => { systemQuit = true; }); w.on("query-session-end", () => { systemQuit = true; }); });
app.on("before-quit", (e) => {
  try { pandapools.flush(); } catch (err) {}   // flush the debounced PandaPools store BEFORE any early-return path
  try { atomix.flush(); } catch (err) {}       // flush the debounced AtomiX swap DB (secrets are already sync-flushed)
  try { dexicon.flush(); } catch (err) {}      // and the Dexicon store (orders, takes and fills are already sync-flushed)
  try { casino.flush(); } catch (err) {}       // casino keychain writes are sync; no-op, kept for symmetry
  try { histDb.flush(); } catch (err) {}       // flush the debounced history DB too
  if (quitting) return;
  e.preventDefault();
  if (quitAsking) { if (win && !win.isDestroyed()) { win.show(); win.focus(); } return; }   // a second Quit while the question is open: show it
  quitAsking = true;
  (async () => {
    const go = await inflight.decideQuit({ os: systemQuit, stopped: node.state === "stopped", gather: inFlightWork, log: (l) => node.log(l),
      ask: async (w) => {
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", buttons: ["Quit anyway", "Stay open"], defaultId: 1, cancelId: 1, noLink: true, title: "Minima Core", message: w.title, detail: w.message });
        return r.response === 0 || systemQuit;   // the system asked while the question was open: it is not held
      } }).catch(() => true);
    quitAsking = false;
    if (!go) return;
    // Always go through node.stop(), even with no node process: it also releases the router port mapping,
    // which can outlive the node (e.g. the node died on its own). Both halves are bounded, so quit stays fast.
    quitting = true;
    try { await node.stop(); } catch (err) {}
    app.quit();
  })();
});
