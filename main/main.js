/*
 * main.js — Electron entry: window + tray, IPC wiring, node lifecycle.
 *
 * The renderer is fully sandboxed (contextIsolation on, nodeIntegration off) and reaches the node only via
 * the IPC handlers here, which proxy to the local RPC using the main-held secret. On launch we start the
 * node if setup is done; otherwise the renderer runs the first-run wizard and calls nodeStart when finished.
 */
const flavor = require("./flavor");   // FIRST: which app this is. A flavour or a TEST profile sets the name, userData and the keychain names before anything reads them
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
const keyuses = require("./keyuses");
const explorer = require("./explorer");
const entropy = require("./entropy");
const secureScreen = require("./securescreen");
const mail = require("./mail");
const chat = require("./chat");
const pandapools = require("./pandapools");
const atomix = require("./atomix");
const dexicon = require("./dexicon");
// A page action of the Exchange with no intent the native chrome recorded is asked about here, in the main process (0.19.231)
dexicon.setConfirm(async (title, detail) => {
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", buttons: [lang.t("Refuse"), lang.t("Allow")], defaultId: 0, cancelId: 0, noLink: true, message: title, detail });
  return r.response === 1;
});
const dexiconRoom = require("./dexicon-room");
dexiconRoom.register(require("electron"));   // dxroom://exchange/: the Dexicon page for its hidden, sandboxed frame
const ethwallet = require("./ethwallet");
const shop = require("./shop");
require("./shop-store").setLog((m) => node.log("[app] " + m));
require("./mail-store").setLog((m) => node.log(m));   // the same for Mail's store (0.19.169)   // a miniMall store that cannot be saved, or a coin that cannot be read, is said in the Logs view
const casino = require("./casino");
const vestr = require("./vestr");
const webwallet = require("./webwallet");
const parlons = require("./parlons");
const lang = require("./lang");         // the app's language here: the window's own helper and catalogs
const reserve = require("./reserve");   // the shared coin reservation (docs/COIN_RESERVATION.md); main/rpc.js calls its guard

// THE COIN RESERVATION FOLLOWS THE NODE. Registered before every engine's own status listener, so its file is being
// opened before an engine sends its first command (guard waits for the open). Opened per wallet when the node runs,
// swept once a minute against the node's real coins, closed when the node stops (the builds died with it).
reserve.onLog = (line) => node.log("[coins] " + line);
// The setting (Settings, "Coin guard"): the master switch, and what sends and consolidate do (off / observe / enforce;
// observe by default: logged, never changed). Read at start and passed again with every save of the config.
const reserveMode = (c) => reserve.setMode({ on: c.coinGuard !== false, sends: c.coinGuardSends });
reserveMode(config.load());
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
  // The saved theme (Settings, Appearance) before the window exists, so the first paint is already in it (no flash): the
  // background below and every page's prefers-color-scheme follow nativeTheme.themeSource. 0.19.378
  nativeTheme.themeSource = config.themeSource(config.load().theme);
  win = new BrowserWindow({
    // Pandamonium on the unfolded Fold is 932 x 704 dp: the reference the shell is built to. The standard
    // title bar is kept (no hiddenInset): the shell's own toolbar has the tray button where the Mac's
    // traffic lights would sit. The background is Pandamonium's core_bg for the applied theme (the saved choice, set just above).
    width: 932, height: 732, minWidth: 440, minHeight: 640,
    title: flavor.test ? flavor.windowTitle + " (TEST PROFILE)" : flavor.windowTitle,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0F1114" : "#F4F5F7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureScreen.watch(win);   // capture protection never outlives the page that asked for it
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (flavor.id || flavor.test) win.on("page-title-updated", (e) => e.preventDefault());   // the page's own <title> is the released app's: the window keeps this app's name
  if (flavor.test) {   // a TEST copy says so in the title bar, on every screen and on the Dock icon
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

const { N_ } = lang.I18N, NODE_STATES = [N_("running"), N_("starting"), N_("stopping"), N_("stopped"), N_("error")];   // every catalog must hold them
let refreshTrayMenu = () => {};   // set by setupTray: the menu is rebuilt when the node's state or the language changes
function setupTray() {
  // the official Minima logo mark (bare, transparent) for the menu-bar tray, sized for the menu bar
  const MINIMA_MARK = "data:image/png;base64,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";
  const img = nativeImage.createFromDataURL(MINIMA_MARK).resize({ width: 18, height: 18 });
  try {
    tray = new Tray(img); currentLang();
    const menu = () => Menu.buildFromTemplate([
      { label: flavor.productName + ": " + lang.t(node.state), enabled: false },   // the node's state, said in the app's language (the five words are named below)
      { type: "separator" },
      { label: lang.t("Show"), click: () => { if (win) win.show(); else createWindow(); } },
      { label: lang.t("Restart node"), click: () => { mayStop().then(() => held(() => node.restart())).catch(() => {}); } },   // main's own question when anything is in flight (0.19.268)
      ...(updater.current().available ? [{ type: "separator" }, { label: lang.t("Update to minimaCore {version}…", { version: updater.current().version }), click: () => { if (win) { win.show(); win.webContents.send("mcd:openUpdate"); } } }] : []),
      { type: "separator" },
      { label: lang.t("Quit"), click: () => app.quit() }
    ]);
    tray.setToolTip(flavor.test ? flavor.productName + " (TEST PROFILE)" : flavor.productName);
    tray.setContextMenu(menu());
    refreshTrayMenu = () => { if (tray) tray.setContextMenu(menu()); };
    node.on("status", refreshTrayMenu);
  } catch (e) { /* tray optional */ }
}

// ---- IPC ----
function requireRunning() {
  if (node.state !== "running") throw new Error("node not running");
}

// The commands that show what controls the funds (main/seedgate.js, 0.19.176): `vault` and `seedrandom` run from a window
// only once the phrase typed for that exact command, and the system's prompt where there is one, were checked here.
const seedgate = require("./seedgate"), cmdverb = require("./cmdverb");
// The system's own check of every secret gate (main/syscheck.js, 0.19.188): Touch ID; refused while a Touch ID that worked
// before cannot be asked; a main-process message box naming what is shown where there never was one.
const systemCheck = require("./syscheck").forElectron(require("electron"), () => win);
const secretGate = seedgate.create(systemCheck);
ipcMain.handle("mcd:secretGate", (_e, command, typed) => { requireRunning(); return secretGate.open(command, typed); });
ipcMain.handle("mcd:revealSeed", (_e, typed) => { requireRunning(); return seedgate.revealSeed(typed, systemCheck, (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c)); });
// First run: the seed of the wallet the node has just made is shown once, before the wallet opens. Only in that step: a
// launch that began with the wallet already made never answers it (a window that set walletDone back does not reopen it).
let firstRunOpen = null;
// Once a wallet-replacing megammrsync (phrase: or file:) has been sent in this launch, the first-run seed step is closed for
// good (0.19.201): flipping walletMode from restore back to new would otherwise show the RESTORED wallet's seed, ungated.
// A Resync node that ended well also ends what an unfinished MegaMMR file import owed (main/megammrfile.js resynced: its marker, the held engines).
const runResync = async (c) => { if (restore.replacesWalletFromPhrase(c) || restore.loadsBackupFile(c)) firstRunOpen = false; const r = await node.runResync(c); if (r && r.status === true && restore.isResync(c)) await megafile.resynced(); return r; };
// Decided from facts of THIS launch (0.19.220), not from config the window can write: the node first started on a data
// folder with no node data (node.freshAtFirstStart), no wallet-replacing command has been sent since, and the wallet step
// has not been finished (walletDone set true in this launch only closes it; setting it back opens nothing).
ipcMain.handle("mcd:firstRunSeed", async () => {
  requireRunning();
  if (firstRunOpen === null) firstRunOpen = node.freshAtFirstStart === true;
  if (!firstRunOpen || node.freshAtFirstStart !== true) throw new Error("The seed is shown here only while a new wallet is being made.");
  const v = ((await rpc.rpcCall(node.rpcPort(), config.rpcSecret(), "vault")) || {}).response || {};
  return String(v.phrase || v.seedphrase || v.seed || v.mnemonic || "");
});

// What the Terminal does with a text before it runs it (0.19.237, as released 0.18.194): its secret kind and whether it is a chain
// (the gate's own reading), whether it writes, and how it may be echoed (secret values hidden). Advice: mcd:cmd stays the gate.
ipcMain.handle("mcd:cmdKind", (_e, command) => {
  const c = String(command == null ? "" : command), k = seedgate.classify(c), shown = seedgate.masked(c);
  return { kind: k.kind, chain: k.chain, write: rpc._timeoutFor(c) > 30000, shown, secretValues: shown !== c.replace(/\s+/g, " ").trim() && /•••/.test(shown) };
});
ipcMain.handle("mcd:cmd", async (_e, command) => {
  // every check before a text reaches the node, in one tested function and in one order (main/seedgate.js checkCommand, 0.19.327 port of
  // the released 0.18.201): control characters, read otherwise than it looks, an escaped ";", builder values, the per-piece refusals,
  // keyuses:, keys replaced outside Backup & Recovery, the node running, the secret gate, a backup file, open work, the backup password
  await seedgate.checkCommand(command, { take: secretGate.take, running: requireRunning, walletWork, keyMode: () => config.load().keyMode,
    tip: async () => { const r = await rpc.rpcCall(node.rpcPort(), config.rpcSecret(), "block"); return parseInt(r && r.response && (r.response.block != null ? r.response.block : r.response), 10); } });
  // megammrsync ends by shutting the node down: run it with that expected, then start the node again (guarded).
  if (restore.isResync(command)) { await mayStop(); return seedgate.scrubReply(await held(() => runResync(command)), command); }   // secret parameters never echoed back (0.19.282)   // it ends by stopping the node: main's own question when anything is in flight (0.19.268)
  // quit, an archive / mysql / reset resync or import, megammr import: the node stops at the end (0.19.283): the same guard as every other stop
  const stops = restore.stopsNode(command); if (stops) await mayStop();
  const run = (c) => (stops ? (f) => held(f, true) : (f) => f())(() => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c));   // a stop the node refused ends its hold (0.19.319); no answer does not (0.19.326)
  // Shared-node fund-safety: a MINIMA `send` (wallet Send/Split) must not auto-select anyone-can-spend beacon dust
  // (PandaPools etc.) as its input → KeyRow.getPrivateKey() null. Pin it to a signable coin. Non-send cmds pass through.
  const pinned = await pinMinimaSend(run, command, { minCoinage: 3 });   // it reads the verb as the node does (main/cmdverb.js) and passes anything that is not a MINIMA send unchanged; never a coin too young to spend
  return seedgate.scrubReply(await run(pinned), command);   // the node echoes every parameter in "params": a secret one is hidden (0.19.282)
});

// Clipboard writes go through the main process — main-process clipboard.writeText is synchronous and never subject
// to the renderer navigator.clipboard's focus/permission failures (which silently left stale data on the clipboard
// while the UI still said "Copied"). Coerce nullish to "" so it never writes the string "null"/"undefined".
ipcMain.handle("mcd:clip", (_e, text) => { clipboard.writeText(text == null ? "" : String(text)); return true; });
// A secret on the clipboard (the ETH key): cleared after a minute and when the app quits, unless something else was copied since (main/clipsecret.js).
const clipSecret = require("./clipsecret").create(clipboard);
ipcMain.handle("mcd:clipSecret", (_e, text) => clipSecret.copy(text));

// Startup Params "Copy RPC password": main process to clipboard. The password is never returned to the renderer.
ipcMain.handle("mcd:copyRpcPassword", () => clipSecret.copy(config.rpcSecret()));   // a secret: cleared after a minute and at quit (main/clipsecret.js, 0.19.226)

// Language. The preload asks once, synchronously, so the window's first paint is already in the language; the
// system's language is read here (after "ready": a window exists) and only when nothing was picked.
let langReady = false;
function currentLang() {
  if (!langReady) { let sys = ""; try { sys = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale(); } catch (e) {} lang.init(config.load().language, sys); langReady = true; }
  return lang.current();
}
ipcMain.on("mcd:langGet", (e) => { try { e.returnValue = currentLang(); } catch (err) { e.returnValue = "en"; } });
ipcMain.handle("mcd:langSet", (_e, code) => {
  currentLang();
  if (!lang.set(code)) throw new Error("Unknown language.");
  config.save({ language: code });
  refreshTrayMenu();
  return code;
});

ipcMain.handle("mcd:appVersion", () => app.getVersion());
// Which app this is, for the screens: its name, and whether it updates itself and may open at login (main/flavor.js).
ipcMain.handle("mcd:flavor", () => ({ id: flavor.id, name: flavor.productName, title: flavor.windowTitle, updates: !updater.OFF, loginItem: flavor.loginItem && !flavor.test, basePort: flavor.basePort }));
ipcMain.handle("mcd:getConfig", () => { const c = config.load(); return c; });
ipcMain.handle("mcd:saveConfig", (_e, patch) => saveConfigPatch(patch));
const NODE_START_KEYS = ["params", "extraArgs", "dataFolder", "basePort", "rpcPortManual", "heapMb", "nodeKind", "contribute", "network", "customConnect"];
/** The window's config patch, saved (also by a restart that carries one: mcd:nodeRestart, 0.19.287). */
function saveConfigPatch(patch) {
  if (patch && Object.keys(patch).some(k => NODE_START_KEYS.includes(k))) notBusy();   // how the node starts: never while an import or a resync runs
  if (patch) delete patch.casinoEnabled;   // P2P Chance is removed: nothing may switch its settle-only gate on (or off)
  if (patch) delete patch.frozenApps;      // only mcd:freezeSet writes it: it refuses while money is in flight
  const c = config.save(patch || {});
  if (patch && "theme" in patch) nativeTheme.themeSource = config.themeSource(c.theme);   // the whole app, at once, no restart
  reserveMode(c);
  if (c.walletDone) firstRunOpen = false;   // the wallet step is over for this launch
  if (patch && "openAtLogin" in patch) c.loginItem = loginitem.apply(app, c.openAtLogin);   // transient status for the Settings toast, not persisted
  return c;
}
// Key mode (main/keymode.js). The renderer may ASK for a mode when a wallet is created or restored; config
// records it once and refuses any later change. Block is refused outright on a jar that cannot run it.
ipcMain.handle("mcd:keyMode", () => ({ mode: config.load().keyMode, supported: node.blockKeysSupported() }));
ipcMain.handle("mcd:recordKeyMode", (_e, mode) => {
  if (mode === "block" && !node.blockKeysSupported()) throw new Error("The node in this version of the app cannot run a block key wallet.");
  return config.recordKeyMode(mode === "block" ? "block" : "classic");
});
// What replacing the wallet would strand, asked of the existing read models (main/restore.js activeWorkList).
const walletWork = async (skipDexicon = Date.now() < dexSkipUntil) => restore.activeWorkList({ atomix: await atomix.activeWork().catch(() => null), pools: await pandapools.activeWork().catch(() => null),
  // P2P Chance (0.19.262): whatever the settle loop found, also on an install that only watches (the loop starts by itself
  // when this wallet has bets on the chain). open() is null until a clean scan, so a wallet that never bet is never held up.
  casino: casino.open(), casinoLooping: casino.looping(), casinoWaitedMs: casino.uncheckedMs(), poolsState: pandapools.status(), ownPools: await pandapools.ownPools().catch(() => null),   // 0.18.137: why PandaPools cannot be checked; this wallet's own open pools
  futurecash: await Promise.resolve().then(() => futurecash.activeWork()).catch(() => null),   // its collects and sweeps under way (null: could not be asked, which refuses)
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
  await each("Future Cash Next", () => futurecash.invalidate());   // its store is the old wallet's: moved aside, never deleted
  await each("coin reservations", () => reserve.invalidate());   // every reservation belongs to the old wallet's coins
  node.log("[app] wallet replaced: minimaMail, PandaPools, AtomiX, Dexicon, P2P Chance, Future Cash Next and the coin reservations were reset in the main process" + (failed.length ? "; NOT reset: " + failed.join("; ") : ""));
  if (failed.length) throw new Error(failed.join("; "));
};
// Around a wallet-replacing megammrsync (node-manager runResync, 0.18.116): the three trading engines are stopped
// before the command is sent and stay stopped until it is known which wallet the node holds; they then go on, on
// their own stores (the same wallet) or on new ones (onWalletReplaced above has run in between).
node.onEnginesHold = async () => { await Promise.all([dexicon.hold(), atomix.hold(), pandapools.hold()]); };
// Before the node is told to quit (node-manager stop(), 0.18.117): what the engines have at the node ends first, so a
// posted action is recorded by the engine that posted it. Each wait is bounded (Dexicon: main/dexicon.js STOP DRAINS).
node.onStopping = () => Promise.all([dexicon.stop(), atomix.quiet(10000), pandapools.quiet(10000)]);
// ...and none while a MegaMMR file import has not finished (its marker, main/megammrfile.js): the node's balance is incomplete until Resync node
node.onEnginesRelease = () => { if (freeze.isFrozen("dexicon") || config.load().megammrImport) return; atomix.release(); pandapools.release(); dexicon.release(); if (node.state === "running") dexicon.start(); };   // a frozen Dexicon stays held (main/freeze.js)
// A file the node is told to read (main/importfile.js): only one the user chose in the system's open dialog, kept here, never copied.
const importfile = require("./importfile");
const imports = importfile.create({ platform: process.platform, t: (s) => (currentLang(), lang.t(s)), defaultPath: () => config.load().dataFolder || config.defaultDataFolder(),
  dataDir: () => node.dataDir(), showOpen: (o) => dialog.showOpenDialog(win, o) });
ipcMain.handle("mcd:pickImport", async (_e, kind) => { requireRunning(); return imports.pick(kind === "megammr" ? "megammr" : "backup"); });
// Resync from a MegaMMR FILE (which turns MegaMMR on) and Turn MegaMMR off: main/megammrfile.js. One of these, or a restore, at a time.
const megafile = require("./megammrfile").create({ node, config, status: () => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), "status"),
  call: (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c), imports, mayStop: () => guardStop(), held, runResync,   // inside its own exclusive: the stop guard alone
  // what is open is what restore refuses on (main/restore.js activeWorkList), but this wallet's own standing pools: the import keeps the wallet
  work: async () => (await walletWork()).filter(i => !String(i).endsWith(restore.CONFIRM_HINT)),
  // the other apps' loops start again at the next node status once nothing holds them
  holdEngines: () => { pauseLoops(); return node.onEnginesHold(); }, releaseEngines: () => node.releaseEngines(), fs, totalmem: () => require("os").totalmem(), platform: process.platform,
  log: (l) => node.log(l), sleep: (ms) => new Promise(r => setTimeout(r, ms)), upMs: 10 * 60 * 1000 });
// Restore from a backup FILE (main/restore.js): the backup's key mode must be this install's recorded one.
ipcMain.handle("mcd:restoreBackup", (_e, o) => megafile.exclusive("restore", async () => {
  const r = await restore.restoreBackup(o, { keyMode: config.load().keyMode, supported: node.blockKeysSupported(), picked: (shown) => imports.confirm("backup", shown),
    running: node.state === "running", run: async (c) => { await guardStop(); return held(() => runResync(c)); }, work: walletWork });   // the stop guard right before the node gets it (0.19.294)
  if (r && r.status === true) imports.forget("backup");   // restored: a later restore chooses its file again (a refused one, a wrong password, keeps it for the retry)
  return r;
}));
ipcMain.handle("mcd:importMegammr", (_e, shown) => megafile.importMegammr(shown));
node.on("status", (s) => { if (s && s.state === "running") megafile.verify().catch(() => {}); });   // after an import: its own blocks found on the new chain, at the network's tip (M4)
ipcMain.handle("mcd:megammrOff", () => megafile.megammrOff());
ipcMain.handle("mcd:defaultDataFolder", () => config.defaultDataFolder());
ipcMain.handle("mcd:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

ipcMain.handle("mcd:nodeStatus", () => node.snapshot());
ipcMain.handle("mcd:nodeStart", async () => { notBusy(); await node.start(); return node.snapshot(); });
// Stop whatever node holds our port/data folder (an earlier launch's), then start. Same reclaim as every start.
ipcMain.handle("mcd:nodeReclaim", async (_e, ack) => { await mayStop(ack, "reclaim"); return held(async () => { await node.stop(); await node.start(); return node.snapshot(); }); });
ipcMain.handle("mcd:nodeStop", async (_e, ack) => { await mayStop(ack, "stop"); return held(async () => { await node.stop(); return node.snapshot(); }); });
// What a Shutdown (the node stops) or a Quit (the app goes) would interrupt: each engine's own activeWork(), read here
// and said by main/inflight.js for BOTH, so the two warnings cannot disagree (0.18.142). null = could not be asked.
const inFlightWork = async () => {
  // the reads run side by side, each under its own bound (0.19.321): in sequence under the guard's one 5 s bound, one slow read
  // lost the others' answers and everything read as "could not be checked"; one that does not answer in 4 s is that one alone
  const one = (f) => new Promise(r => { const t = setTimeout(() => r(null), 4000); if (t.unref) t.unref(); const done = (v) => { clearTimeout(t); r(v); }; Promise.resolve().then(f).then(done, () => done(null)); });   // no timer left once it answers (0.19.334)
  const [ax, pools, dex, fc] = await Promise.all([one(() => atomix.activeWork()), one(() => pandapools.activeWork()), one(() => dexicon.activeWork()), one(() => futurecash.activeWork())]);
  return { atomix: ax, pools, dexicon: dex, casino: casino.open(), casinoOn: !!config.load().casinoEnabled || casino.looping(),   // the loop running with no clean scan: not read yet (0.19.269)
    futurecash: fc, shop: shop.sendingCount() };   // shop: miniMall payments at the node (0.19.288)
};
// Every node stop or restart goes through mayStop (main/inflight.js stopGuard, 0.19.268): with work in flight, only after the
// warning the window showed (its one-time ack) or main's own question.
const stopGuard = inflight.stopGuard({ running: () => node.state === "running", gather: inFlightWork, log: (l) => node.log(l), t: () => (currentLang(), lang.t),
  ask: async (w) => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", buttons: [lang.t("Stop the node anyway"), lang.t("Keep it running")], defaultId: 1, cancelId: 1, noLink: true, title: flavor.windowTitle, message: w.title, detail: w.message });
    return r.response === 0;
  } });
async function mayStop(ack, action) { notBusy(); return guardStop(ack, action); }
async function guardStop(ack, action) { if (!await stopGuard.pass(ack, action)) throw new Error("The node keeps running: nothing was stopped."); }
// While a MegaMMR file import, a restore, a MegaMMR switch or a resync runs, nothing else stops, restarts or resets the node, nor
// changes how it starts: Stop, Restart, Start, the node kind, Startup Params, Resync, Rebuild, the Terminal's stopping commands and the
// Web Wallet's MegaMMR switch all come through mayStop (or saveConfigPatch / nodeStart), refused with the plain reason. A restart in the
// middle of an import cuts it after the node reset its chain; a start without -megammr deletes the MegaMMR it is writing.
const nodeBusy = () => megafile.busy() || !!node.resyncing;
// The other apps' background loops (Mail, miniMall, Vestr, Future Cash Next, P2P Chance) during a MegaMMR file import and while it is
// unfinished: the node's chain and balance are being replaced. Stopped when the import holds the engines; their start sites refuse meanwhile
// and start them again at the first node status after (main/freeze.js paused, the Future Cash Next and P2P Chance sites below).
const loopsPaused = () => megafile.busy() || !!config.load().megammrImport;
function pauseLoops() { mail.stopLoop(); shop.stopLoop(); vestr.stopLoop(); futurecash.stop().catch(() => {}); casino.stopLoop(); casinoStarted = false; }
function notBusy() { if (nodeBusy()) throw new Error(require("./megammrfile").BUSY); }
node.on("status", (s) => stopGuard.seen(s && s.state));   // a stop that happened ends the guard's hold (0.19.316)
// What a yes let go, run so that a failure which left the node running ends the hold (0.19.319): a restore refused for a wrong
// password, an import that fails fast or a settings save that throws, retried at once, was refused for up to 30 s.
// answerOnly (0.19.326, the Terminal's stopping commands): only the node's own refusal (status false) ends the hold; no answer does not,
// because the node may be stopping: quit runs Main.shutdown before it replies, and the shutdown can cut the connection first.
async function held(op, answerOnly) {
  const mine = stopGuard.holding();   // the hold this yes opened (0.19.322): ended only by its own failure, never another request's
  try { const r = await op(); if (r && r.status === false && node.state === "running") stopGuard.release(mine); return r; }
  catch (e) { if (!answerOnly && node.state === "running") stopGuard.release(mine); throw e; }
}
// The Apps tab's Freeze (main/freeze.js): what each app's background work is, and the list kept in the config.
const whenRunning = (fn) => () => { if (node.state === "running") return fn(); };   // the start's own promise goes back: main/freeze.js runs one start at a time and remembers a failed one
const freeze = require("./freeze").create({
  load: () => config.load().frozenApps, save: (ids) => { config.save({ frozenApps: ids }); }, log: (l) => node.log(l),
  engines: {
    mail: { start: whenRunning(() => mail.startLoop()), stop: () => mail.stopLoop() },
    minimall: { start: whenRunning(() => shop.startLoop()), stop: () => shop.stopLoop() },   // its start awaits the node (identity, first scan): never two at once, never retried on every status after a failure (main/freeze.js)
    vestr: { start: whenRunning(() => vestr.startLoop()), stop: () => vestr.stopLoop() },
    // Future Cash Next: frozen, it makes no pass and holds no store open; never while a collect or a sweep is under way
    futurecash: { start: whenRunning(() => futurecash.start()), stop: () => futurecash.stop(), blockers: async () => require("./freeze").futurecashBlockers(await Promise.resolve().then(() => futurecash.activeWork()).catch(() => null)) },
    chat: { start: whenRunning(() => chat.startLoop()), stop: () => chat.stopLoop() },
    // The hold a wallet replacement uses; by the time start runs it is no longer in the frozen list. gate: before what is
    // in flight is read, nothing new can start (AtomiX and PandaPools held with their engines up; the Exchange takes no new command).
    dexicon: { gate: async () => { dexicon.gate(); await Promise.all([atomix.hold(), pandapools.hold()]); }, start: () => node.onEnginesRelease(), stop: () => node.onEnginesHold() }
  },
  // A wallet-replacing megammrsync holds the same engines (node-manager runResync): from before its hold until its settle has released them.
  replacing: () => (megafile.busy() ? "import" : !!node.replacingWallet || !!(node.walletCheck && node.walletCheck.held)),   // a MegaMMR file import holds the engines too (said as such)
  paused: () => loopsPaused(),
  dexiconWork: async () => Object.assign(await inFlightWork(), { ownPools: await pandapools.ownPools().catch(() => null), holds: (() => { try { return dexicon.coinHolds(); } catch (e) { return null; } })() })
});
ethwallet.setFrozen(() => freeze.isFrozen("dexicon"));
// A held engine says why in its refusals: frozen by the user, not "the wallet is being replaced".
for (const [eng, name] of [[atomix, "AtomiX"], [pandapools, "PandaPools"], [dexicon, "Dexicon"]]) eng.setHeldReason(() => (freeze.isFrozen("dexicon") ? (name === "Dexicon" ? "Dexicon is frozen" : name + " is stopped because Dexicon is frozen") + ". Unfreeze Dexicon on the Apps tab: it then starts again by itself. Nothing was sent." : ""));
node.on("status", (s) => { freeze.settle(); if (s.state !== "running") freeze.nodeStopped(); });   // a start that failed (a locked node) is tried again with the next node, not on every status
ipcMain.handle("mcd:freezeList", () => freeze.list());
ipcMain.handle("mcd:freezeSet", (_e, id, on) => freeze.set(id, on));
ipcMain.handle("mcd:inFlight", async (_e, how, action) => { const w = inflight.inFlight(await Promise.race([inFlightWork(), new Promise(r => setTimeout(() => r({}), 5000))]), how === "quit" ? "quit" : "shutdown", Date.now(), (currentLang(), lang.t)); return { title: w.title, message: w.message, any: w.any, ack: w.any && how !== "quit" && /^(restart|stop|kind)$/.test(String(action)) ? stopGuard.issue(action) : "" }; });   // ack: for that action's warning only (0.19.268, 0.19.287)
// a patch is saved only once the guard let the restart go (0.19.287): asked first, saved after; a refusal changes nothing
ipcMain.handle("mcd:nodeRestart", async (_e, ack, patch) => { await mayStop(ack, "restart"); return held(async () => { if (patch) saveConfigPatch(patch); await node.restart(); return node.snapshot(); }); });
ipcMain.handle("mcd:nodeLogs", () => node.logs.slice(-800));
// Logs, "Save to file" (the phone's Share): the text the screen shows, redacted again here, to a file the user chooses.
ipcMain.handle("mcd:logsSave", async () => {   // the log files on disk through the scrubber (0.19.221), never text the window sends
  const d = new Date(), two = (n) => String(n).padStart(2, "0");
  const r = await dialog.showSaveDialog(win, { title: lang.t("Save node log"), defaultPath: "minima-node-log-" + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + ".txt", filters: [{ name: "Text", extensions: ["txt"] }] });
  if (r.canceled || !r.filePath) return null;
  const nl = require("./nodelog");
  fs.writeFileSync(r.filePath, nl.forFile(nl.fileText(node.diskLog()), config.rpcSecret()), { encoding: "utf8", mode: 0o600 });
  return r.filePath;
});
ipcMain.handle("mcd:portmapStatus", () => portmap.status());

// Parlons account (Parlons Node kind): status for its screen, "open in the browser" (the one-time link is read and
// handed to the system browser here; the renderer never holds it), and the kind switch (restarts the node).
ipcMain.handle("mcd:parlonsStatus", () => parlons.status());
ipcMain.handle("mcd:parlonsOpenExternal", () => parlons.openExternal());
ipcMain.handle("mcd:setNodeKind", async (_e, kind, ack, patch) => {
  const k = kind === "minima" ? "minima" : "parlons";
  if (k === "parlons") { const why = node.parlonsBlocker(); if (why) throw new Error(why); }
  // A block wallet cannot move to a node jar that does not know block keys: say so before anything is saved.
  if (config.load().keyMode === "block" && !require("./keymode").jarSupportsBlock(path.join(path.dirname(node.jarPath()), k === "parlons" ? "parlons-node.jar" : "minima.jar")))
    throw new Error("This wallet uses block key uses, and that node cannot run it.");
  await mayStop(ack, "kind");
  return held(async () => {
    if (patch) saveConfigPatch(patch);   // Settings' heap size with it, saved only once the guard let the restart go (0.19.294)
    config.save({ nodeKind: k });
    chat.stopLoop();   // restart re-gates chat (both kinds run keets since 0.18.6)
    await node.restart();
    return node.snapshot();
  });
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

// Entropy (main/entropy.js): the node's `random` through rpcCall, or the SHA3-256 of one roll worked out here (never sent to the node); the hex value back. Seed material: never logged.
ipcMain.handle("mcd:entropy", (_e, kind, arg) => { requireRunning(); return entropy.ask(kind, arg, (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c)); });
// While a seed phrase can be on screen (Entropy), the system is asked to keep the window out of screenshots and screen
// sharing (main/securescreen.js). On or off, nothing else: no path, no setting. The answer is what was set and on which
// platform, { on, platform }; a load, a reload or a renderer crash turns it off (secureScreen.watch in createWindow).
ipcMain.handle("mcd:secureScreen", (_e, on) => secureScreen.set(win, on));

// Minima Explorer (main/explorer.js): a kind and one checked value in, one of seven node READS out, through rpcCall.
ipcMain.handle("mcd:explorer", (_e, kind, arg) => { requireRunning(); return explorer.ask(kind, arg, (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c)); });

// The Web Wallet's on-chain check of ONE public key (main/keyuses.js onchainUses): asked only by a click on "Check
// on-chain" or "Confirm" in the Web Wallet's send form, never by itself. The host is the one pinned in keyuses.js,
// the key is checked as 0x + 64 hex before it reaches the query string, no redirect is followed, and the answer is a
// whole number or null (not read), never a default.
ipcMain.handle("mcd:keyAudit", (_e, publicKey) => keyuses.onchainUses(publicKey, (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES })));
// The KeyUses app (main/keyuses.js): the node's keys are read here through rpcCall, the lookups go to the one pinned
// host one at a time with no redirect followed and a reply of at most 512 KB, and the renderer is handed the joined
// result. It names no host and no key itself.
ipcMain.handle("mcd:keyUsesAudit", () => { requireRunning(); return keyuses.audit({ run: (c) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), c), get: (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES }) }); });

// Future Cash Next (main/futurecash.js): the native app's engine, here. Every node command through rpcCall as owner
// "futurecash" (the signing queue and the coin guard see it); the key audit through the KeyUses host. It runs while the
// node runs: its store is this wallet's own file, and one pass is made on each new block.
const futurecash = require("./futurecash").create({ run: (c, opts) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), rpc.oneCommand(c), Object.assign({}, opts, { owner: "futurecash" })),   // opts kept (review L4): the send pin's coin read is { unfiltered: true }, so it sees the coins others hold and keeps off their addresses   // ONE command each (0.19.194): it sends no chain
  dir: () => app.getPath("userData"),   // was swallowed by the comment above from 0.19.194 to 0.19.371: the store had no folder and Future Cash Next never started
  get: (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES }), log: (l) => node.log(l), granted: (wk) => config.fcGranted(wk), dropGrant: (wk) => config.setFcGrant(wk, null), keyMode: () => config.load().keyMode, reserve,
  notify: (title, body) => { try { const n = new Notification({ title: String(title), body: String(body), silent: false }); n.on("click", () => { if (win) { win.show(); win.focus(); } }); n.show(); } catch (e) { /* best-effort */ } } });
reserve.setHoldSource("futurecash", () => futurecash.coinHolds());   // what it is about to sweep: no other part of the app may spend it first
const fcPush = () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:futurecash"); };
let fcBlock = 0;
// A failed start is tried again with growing pauses for as long as the node runs (review M3), and said once when
// background signing was allowed: the guardian is then not watching although the user asked it to.
const fcStarter = require("./futurecash").createStarter({ start: () => futurecash.start(), frozen: () => freeze.isFrozen("futurecash"),
  granted: () => { const g = config.load().fcGrant; return !!(g && typeof g === "object" && Object.keys(g).length); },
  notify: () => { try { const n = new Notification({ title: "Future Cash Next", body: lang.t("Future Cash Next could not start, so its guardian is not watching your stakes. It is tried again by itself."), silent: false }); n.on("click", () => { if (win) { win.show(); win.focus(); } }); n.show(); } catch (e) {} } });
node.on("status", (s) => {
  if (s.state !== "running" || loopsPaused()) { fcBlock = 0; fcStarter.reset(); futurecash.stop().catch(() => {}); return; }   // not during a MegaMMR file import, nor while it is unfinished
  const b = s.health && s.health.block;
  fcStarter.tick().then(() => { if (b && b !== fcBlock && !freeze.isFrozen("futurecash")) { fcBlock = b; return futurecash.pass(b).then(fcPush); } }).catch(() => {});   // frozen (Apps tab): no store opened, no pass
});
// The screens' calls, by name: nothing else reaches the engine.
const FC_OPS = { status: () => futurecash.status(), stakes: () => futurecash.stakes(), audit: (force) => futurecash.audit(force === true), activity: () => futurecash.activity(),
  lock: (amount, blocks, recipient) => futurecash.lock(amount, blocks, recipient), collect: (coinid) => futurecash.collectNow(coinid), collectAll: () => futurecash.collectAll(),
  safeSameNode: () => futurecash.setSafeSameNode(), safeExternal: (addr) => futurecash.setSafeExternal(addr), stopRescue: () => futurecash.stopRescue(),
  autoCollect: (on) => futurecash.setFlag("auto_collect_safe", on === true), minAuto: (v) => futurecash.setMinAuto(v),
  handedOut: (addr) => require("./futurecash").handedOut(addr, [{ app: "minimaMail", address: (() => { try { return mail.myReceivingAddress(); } catch (e) { return ""; } })() },
    { app: "miniMall", address: (() => { try { return require("./shop-store").getMeta("vendorAddress") || ""; } catch (e) { return ""; } })() },
    { app: "AtomiX", address: (() => { try { const pk = atomix.status().minimaPk; const a = pk && keyuses.addressOf(pk); return a ? a.hex : ""; } catch (e) { return ""; } })() }]),   // read only: what each has handed out as its own address
  signCap: (v) => futurecash.setSignCap(v), notify: (on) => futurecash.setFlag("notify", on === true),   // swallowed by the comment above from 0.19.212 to 0.19.371 ("Unknown Future Cash action.")
  harden: () => futurecash.harden(), retire: (addr) => futurecash.retire(addr), sweep: (addr) => futurecash.sweepAddress(addr), recover: () => futurecash.recoverRetired(),
  resetHistory: () => futurecash.resetHistory(), guardian: (on) => fcGuardian(on === true), revoke: () => fcRevoke() };
/**
 * THE ONE NATIVE GRANT. Starting the guardian lets this app sign with nobody at the screen. The first time, for this
 * wallet, the user is asked HERE, in a native dialog the window cannot answer for, what exactly will be signed; the answer
 * is kept in the main config (config.setFcGrant, which no renderer patch can write). Without it nothing is signed in the
 * background. Revoke (the Guardian tab) takes it back and stops the guardian.
 */
async function fcGuardian(on) {
  if (!on) return futurecash.setGuardian(false);
  if (!futurecash.rescueReady()) return futurecash.setGuardian(true);   // says what is missing (a destination)
  const wk = futurecash.walletKey;
  if (!config.fcGranted(wk)) {
    const st = await futurecash.status(), safe = (st && st.safe) || "";
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", noLink: true, defaultId: 1, cancelId: 1,
      buttons: [lang.t("Allow background signing"), lang.t("Cancel")], title: "Future Cash Next",
      message: lang.t("Let Future Cash Next sign by itself?"),
      detail: lang.t("While the guardian runs, Future Cash Next signs and posts two kinds of transaction with nobody at the screen:\n\n• Collect a matured stake to its own payout address. That is an address of this wallet, and the contract allows no other.\n• Move a coin from an address of this wallet whose one-time key was used more than once, or that was retired, to your safe destination:\n{safe}\n\nBefore anything is signed, the app checks the node's own copy of the transaction against these two shapes, and refuses and logs anything else. Nothing else is signed by itself.\n\nYou can take this back at any time on the Guardian tab (Background signing). The guardian then stops.", { safe }) });
    if (r.response !== 0) return { ok: false, declined: true };
    // the destination is read again AFTER the answer: the grant is for the address the question showed, never another
    const after = await futurecash.status();
    if (!safe || !after || after.safe !== safe || futurecash.walletKey !== wk) return { ok: false, error: "The rescue destination changed while you were asked. Nothing was allowed." };
    config.setFcGrant(wk, Date.now(), safe);
    node.log("[futurecash] the user allowed background signing for the wallet whose first key is " + wk);
  }
  return futurecash.setGuardian(true);
}
async function fcRevoke() {
  const wk = futurecash.walletKey || null;   // the store never opened: every grant is taken back (review L1)
  config.setFcGrant(wk, null);
  node.log("[futurecash] the user took back background signing " + (wk ? "for the wallet whose first key is " + wk : "for every wallet (Future Cash Next had not started)"));
  const r = await futurecash.setGuardian(false).catch(() => null);
  return r && r.ok ? r : { ok: true };
}
ipcMain.handle("mcd:fc", (_e, op, ...args) => { if (typeof op !== "string" || !Object.hasOwn(FC_OPS, op)) throw new Error("Unknown Future Cash action."); requireRunning(); return FC_OPS[op](...args); });

// minimaMail (on-chain encrypted messaging; crypto/keys live here, never in the renderer)
ipcMain.handle("mcd:mailInit", async () => { await mail.init(); return mail.myIdentity(); });
ipcMain.handle("mcd:mailSetName", (_e, n) => { mail.setName(n); return mail.myIdentity(); });
ipcMain.handle("mcd:mailAddressWords", () => require("./mailaddress").words);
ipcMain.handle("mcd:mailResolveAddress", (_e, value) => mail.resolveRecipient(value));
ipcMain.handle("mcd:mailResolveDetail", (_e, value) => mail.resolveDetail(value));          // 0.19.9: the key AND how it is known
ipcMain.handle("mcd:mailConfirmRecipient", (_e, key) => mail.confirmRecipient(key));
ipcMain.handle("mcd:mailPublishNotice", () => mail.publishNoticeDue());
ipcMain.handle("mcd:mailPublishAnswer", (_e, publish) => mail.answerPublishNotice(publish === true));
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
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], title: lang.t("File (up to 100 MB)") });
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
  const r = await dialog.showOpenDialog(win, { title: lang.t("Send a photo"),
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
ipcMain.handle("mcd:shopScanState", () => shop.scanState());   // what the order scan could not read (0.19.249)
ipcMain.handle("mcd:shopScanDismiss", () => shop.dismissUnread());   // the vendor hides "no deeper history" (0.19.331)
ipcMain.handle("mcd:shopNotSent", (_e, ref) => shop.paymentNotSent(ref));   // the buyer checked their History: the uncertain payment was not sent (0.19.241)
ipcMain.handle("mcd:shopAdvance", (_e, ref, status) => shop.advanceStatus(ref, status));
ipcMain.handle("mcd:shopVendorCheck", (_e, ref) => shop.vendorCheck(ref));   // the vendor checked an unmatched order by hand (0.19.166)
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
  const r = await dialog.showSaveDialog(win, { defaultPath: "keets-chat-backup-" + stamp + ".kbak", filters: [{ name: lang.t("Chat backup"), extensions: ["kbak"] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, file);
  return { canceled: false, path: r.filePath, contacts: all.contacts.length, messages: all.messages.length };
});
ipcMain.handle("mcd:chatOpenBackup", async (_e, pass) => {
  if (typeof pass !== "string" || !pass) throw new Error("Enter the backup's password.");
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: lang.t("Chat backup"), extensions: ["kbak"] }, { name: lang.t("All files"), extensions: ["*"] }] });
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
  const b = pendingChatBackup;
  if (!b) throw new Error("Open the backup again.");
  await mayStop();   // main's own question when anything is in flight (0.19.268); the backup stays open after a no
  pendingChatBackup = null;
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
  const r = await dialog.showSaveDialog(win, { defaultPath: "minimamail-backup.json", filters: [{ name: lang.t("minimaMail backup"), extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, enc, "utf8");
  return { canceled: false, path: r.filePath };
});
ipcMain.handle("mcd:mailImportBackup", async (_e, passphrase) => {
  if (typeof passphrase !== "string" || passphrase.length < 1) throw new Error("Enter the backup passphrase.");
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: lang.t("minimaMail backup"), extensions: ["json"] }] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const json = fs.readFileSync(r.filePaths[0], "utf8");
  const id = await mail.importBackup(passphrase, json);   // throws on wrong passphrase / bad file
  return { canceled: false, identity: id };
});

// forward mail updates to the window; start the scan loop once the node is running
mail.emitter.on("update", () => { if (win && !win.isDestroyed()) win.webContents.send("mcd:mail"); });
// A payment message is its sender's claim (0.19.7). The screens ask here whether this node has found it; what is not
// found is looked for again on each new block, within main/payverify.js's limits. Reads only, never the signing queue.
// a txid belongs to the first message that claimed it, kept across restarts (0.19.238): payclaims.json in the data folder
const payClaims = (() => {
  const file = () => path.join(app.getPath("userData"), "payclaims.json"); let m = null;
  const load = () => { if (m) return m; m = Object.create(null); try { const j = JSON.parse(fs.readFileSync(file(), "utf8")); if (j && typeof j === "object") Object.assign(m, j); } catch (e) {} return m; };
  return { get: (k) => (Object.hasOwn(load(), k) ? m[k] : undefined), set: (k, v) => { load()[k] = v; const keys = Object.keys(m); if (keys.length > 20000) delete m[keys[0]]; try { const t = file() + ".tmp"; fs.writeFileSync(t, JSON.stringify(m)); fs.renameSync(t, file()); } catch (e) {} } };
})();
const payverify = require("./payverify").create({ run: (c) => rpc.rpcRead(node.rpcPort(), config.rpcSecret(), c), claims: payClaims,
  onChange: () => { mail.emitter.emit("update"); chat.emitter.emit("update"); } });
ipcMain.handle("mcd:payCheck", (_e, txid, tokenid, amount, msgid) => node.state === "running" ? payverify.ask({ txid, tokenid, amount, msgid }) : "unverified");
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
    const who = info.name || lang.t("New mail");
    const body = info.count > 1 ? lang.t("{n} new messages", { n: info.count }) : (info.preview || lang.t("New message"));
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
    const body = info.count > 1 ? lang.t("{n} new messages", { n: info.count }) : (info.preview || lang.t("New message"));
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
    const n = new Notification({ title: lang.t("miniMall: new order"), body: (info.shopName ? info.shopName + " · " : "") + (info.amount ? info.amount + " " + (info.currency || "") : lang.t("New order")), silent: false });
    n.on("click", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (e) {}
});
let mailStarted = false;
// Asked at every "running" (each start is a no-op while its loop runs): an app unfrozen with the node stopped starts with the node.
node.on("status", (s) => { if (s.state === "running") { mailStarted = true; freeze.start("mail"); freeze.start("minimall"); } });   // not when frozen (Apps tab)
node.on("status", (s) => { if (s.state === "running") freeze.start("chat"); });

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
  const m = reserve.mode();
  if (!m.on) return { coins: [], funds: [], mode: m };
  // The Wallet lowers its sendable figures (and Send refuses above them) only while sends are ENFORCED; observed, the
  // node's own figures stand and the held coins are only marked.
  return { coins: reserve.list().filter(r => r.owner !== "wallet"), funds: m.sends === "enforce" ? await reserve.funds("wallet", reserveRead) : [], mode: m };
});
// Settings, "Release all holds": every reservation is dropped and the file moved aside under a dated name (never
// deleted), then a new one is opened. Safe: the node's own mempool check still refuses a double spend. A hold whose
// order is still live is listed again by its engine within a minute.
ipcMain.handle("mcd:reserveReleaseAll", async () => {
  const n = reserve.list().length, kept = reserve.invalidate();
  node.log("[coins] the user released all " + n + " hold" + (n === 1 ? "" : "s") + (kept ? "; the file is kept as " + kept : ""));
  if (node.state === "running") await reserve.open(app.getPath("userData"), reserveRead).catch(() => {});
  return { released: n, kept };
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
ipcMain.handle("mcd:axOtcDeal", (_e, ref, action, amount, price, side) => atomix.otcDealAction(ref, action, amount, price, side));
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
  node.log("[app] the user chose to go on without these checks after this warning: " + list.join(" | "));
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
dexicon.emitter.on("nodelog", (line) => node.log("[dexicon] " + line));   // 0.19.373: why the on-chain engine did not start
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
// The key leaves the main process only after the typed phrase and, on a Mac with Touch ID, the system's own prompt (0.19.108).
ipcMain.handle("mcd:ewExportKey", (_e, typed) => ethwallet.exportKeyGated(typed, systemCheck));
ipcMain.handle("mcd:ewSwaps", () => ethwallet.swapsInFlight());
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
  if (casinoStarted || loopsPaused()) return;
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
node.on("status", (s) => { if (s.state === "running") { vestrStarted = true; freeze.start("vestr"); } });

// Web Wallet (local, megammr-gated). All node I/O + fund logic lives in webwallet.js; the seed reaches only
// the local node over loopback. Its gate points to Resync from a MegaMMR file (0.19.395): a MegaMMR switched on without a file is empty.
ipcMain.handle("mcd:wwMegammr", () => webwallet.isMegammr());
ipcMain.handle("mcd:wwDerive", (_e, seed) => webwallet.derive(seed));
ipcMain.handle("mcd:wwRead", (_e, address, nodeSeed) => webwallet.read(address, nodeSeed));
ipcMain.handle("mcd:wwKeyuses", (_e, address) => webwallet.keyusesInfo(address));
ipcMain.handle("mcd:wwAckKeyuses", (_e, address, count) => webwallet.ackKeyuses(address, count));
// a damaged key-use entry is confirmed again only at or above the chain's figure, read here with the same pinned fetch (0.19.255)
webwallet.setKeyMode(() => config.load().keyMode);   // off on a block key wallet (0.19.333)
webwallet.setOnchain((pk) => keyuses.onchainUses(pk, (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES })));
ipcMain.handle("mcd:wwSend", (_e, opts) => webwallet.send(opts));
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
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: lang.t("History export"), extensions: ["json"] }, { name: lang.t("All files"), extensions: ["*"] }] });
  if (r.canceled || !r.filePaths.length) return null;
  if (fs.statSync(r.filePaths[0]).size > 64 * 1024 * 1024) throw new Error("That file is larger than 64 MB.");
  return fs.readFileSync(r.filePaths[0], "utf8");
});

// miniMall: export a .shop bundle (save dialog) / import one (open dialog → parsed JSON)
ipcMain.handle("mcd:shopExport", async (_e, json, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: (name || "shop") + ".shop", filters: [{ name: lang.t("miniMall shop"), extensions: ["shop"] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(json == null ? "" : json), "utf8");
  return r.filePath;
});
ipcMain.handle("mcd:shopImport", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: lang.t("miniMall shop"), extensions: ["shop", "json"] }] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  let cfg; try { cfg = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")); } catch (e) { throw new Error("Not a valid .shop file."); }
  return shop.checkImported(cfg);   // the vendor's file: currency and token must agree, prices plain, pictures inline or none
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
  freeze.applyAtStartup();   // a frozen Dexicon's engines are held before the node is up; the other frozen apps are simply never started
  if (c.megammrImport) { node.log("[app] a MegaMMR file import did not finish (" + String(c.megammrImport.stage) + ", " + String(c.megammrImport.at) + "): the trading engines stay stopped until Resync node has run"); node.onEnginesHold().catch(() => {}); }   // main/megammrfile.js
  if (c.setupDone && c.walletDone) node.start();
  if (c.openAtLogin) loginitem.apply(app, true);   // re-register every boot: survives a moved AppImage or a reinstall
  updater.start();   // does nothing for a flavour that does not update itself, and for a TEST copy (main/updater.js OFF)
  if (flavor.id) { try { app.setAboutPanelOptions({ applicationName: flavor.productName, applicationVersion: app.getVersion() }); } catch (e) {} }   // About says which app this is
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (win) { win.show(); win.focus(); } });
});

// The node must never outlive the app: a normal quit goes through before-quit → node.stop() (graceful);
// these two are the last resort for every other way out (uncaught exception, will-quit after a failed
// stop). A SIGKILL of the app itself is what reclaimStaleNode() on the next start is for.
app.on("will-quit", () => { try { clipSecret.clearNow(); } catch (e) {} try { node.killNow(); } catch (e) {} });   // a key still on the clipboard does not outlive the app
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
let quitting = false, quitAsking = false;
const IMPORT_QUIT_WARNING = N_("Quitting now leaves the chain half-replaced. Your funds are safe, but the balance will be incomplete until Resync node (Backup & Recovery) has run.");
const systemQuit = inflight.recently();   // true for about a minute after the system asked: a cancelled shutdown does not silence the question for the session
app.whenReady().then(() => { try { powerMonitor.on("shutdown", () => { systemQuit.mark(); }); } catch (e) { /* Windows: session-end below */ } });
app.on("browser-window-created", (_e, w) => { w.on("session-end", () => { systemQuit.mark(); }); w.on("query-session-end", () => { systemQuit.mark(); }); });
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
    // A MegaMMR file import cut by the quit leaves the chain half-replaced (main/megammrfile.js): asked first, "Stay open" the default.
    // A quit the system asked for is not held behind it (the import's marker then says what is owed at the next launch).
    if (megafile.busyWhat() === "import" && !systemQuit.on()) {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); }
      const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", buttons: [lang.t("Quit anyway"), lang.t("Stay open")], defaultId: 1, cancelId: 1, noLink: true, title: flavor.windowTitle,
        message: lang.t("A MegaMMR import is running"), detail: lang.t(IMPORT_QUIT_WARNING) }).catch(() => ({ response: 1 }));
      if (r.response !== 0 && !systemQuit.on()) { quitAsking = false; return; }
    }
    const go = await inflight.decideQuit({ os: systemQuit.on(), stopped: node.state === "stopped", gather: inFlightWork, log: (l) => node.log(l), t: (currentLang(), lang.t),   // the question in the app's language; the log line stays English
      ask: async (w) => {
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: "warning", buttons: [lang.t("Quit anyway"), lang.t("Stay open")], defaultId: 1, cancelId: 1, noLink: true, title: flavor.windowTitle, message: w.title, detail: w.message });
        return r.response === 0 || systemQuit.on();   // the system asked while the question was open: it is not held
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
