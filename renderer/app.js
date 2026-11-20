/*
 * app.js — the renderer. Talks to the node ONLY through window.mcd (the preload bridge → main-process RPC
 * proxy). Boot: read config → first-run node wizard, or start the node and show the wallet. The wallet drives
 * the LOCAL node's own wallet (getaddress / balance / send / consolidate), so it is self-custodial by nature.
 */
"use strict";
const api = window.mcd;   // window.mcd is exposed by preload; alias to avoid re-declaring the global
const el = (id) => document.getElementById(id);
const MINIMA = "0x00";

let CFG = null;
let running = false;
let nodeState = "";          // the node's last reported state, for the "stopped" wording
let waitingForNode = false;
let activeView = "balances";
let refreshTimer = null;
let KEYMODE = { mode: "", supported: false };   // the wallet's key mode ("classic" | "block" | "" before a wallet) and whether this node can run block keys
let FR_CLASSIC = false;      // first run, block-capable node only: the Classic mode switch (off = block key uses)
let RESTORE = null;          // {seed, keyuses, host} held in memory for a pending restore — NEVER persisted
let postBootStarted = false; // guard: run the post-boot wallet step (new backup / restore resync) once
const ICON_CACHE = new Map();// tokenid → { icon: dataURI|null, valid: bool|null } — survives the 15s refresh
let HIST_SYNCING = false;    // guard against overlapping history syncs
let histOldestOffset = 0;    // how deep "Load older" has paged
// terminal state
const TERM_HIST = [];
let termIdx = -1;
let SUG_ITEMS = [];          // current autocomplete suggestions (from TermComplete.suggest)
let SUG_SEL = 0;             // highlighted suggestion index
const SUG_MAX = 40;          // dropdown row cap
let SEND_TOKENS = [];        // [{tokenid, name, sendable}] for the Send token dropdown

function tokenOptions() {
  return SEND_TOKENS.map(t => `<option value="${esc(t.tokenid)}">${esc(t.name)}${t.tokenid !== MINIMA ? " · " + t.tokenid : ""}</option>`).join("");
}

function labelFor(addr) { return (CFG && CFG.labels && CFG.labels[addr]) || ""; }

// Input validation — these values are interpolated into node command strings, so a stray space would let a
// pasted "address" inject extra params (address:/burn:/multi:) into a fund-moving `send`. Reject anything that
// isn't a clean address / amount / tokenid before building any command.
function validAddr(a) { return /^(0x|Mx)[0-9A-Za-z]+$/.test(a); }
function validAmt(a) { return /^[0-9]*\.?[0-9]+$/.test(a) && parseFloat(a) > 0; }
function validTok(t) { return t === "" || t === MINIMA || /^0x[0-9A-Fa-f]+$/.test(t); }

// ---- node command (throws on transport error OR status:false) --------------
async function cmd(command) {
  const j = await api.cmd(command);
  if (!j || j.status !== true) throw new Error((j && j.error) || "command failed: " + command);
  return j.response;
}
async function tryCmd(command) { try { return await cmd(command); } catch (e) { return null; } }

// ---- ui helpers ------------------------------------------------------------
let toastTimer = null;
/**
 * toast(msg, kind, copyText)
 *
 * `copyText` is the RULE-1 escape hatch. An identifier exists to be pasted into an explorer or a support
 * ticket, and a toast is the worst place to lose one: it shows briefly, then it is gone with no second
 * surface holding the value. Txid toasts used to print the first 12 characters and nothing anywhere kept the rest.
 * When copyText is given the toast becomes clickable and puts the COMPLETE string on the clipboard, and it
 * stays up longer so there is time to click it.
 */
function toast(msg, kind, copyText) {
  const t = el("toast");
  t.className = "toast" + (kind ? " " + kind : "") + (copyText ? " toast--copy" : "");
  t.textContent = msg + (copyText ? "  ⧉" : "");
  t.style.display = "";
  t.onclick = copyText ? (() => copy(copyText)) : null;
  t.title = copyText ? "Click to copy the full id" : "";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; t.onclick = null; }, copyText ? 8000 : 3200);
}
// Copy through the MAIN process (api.clip → clipboard.writeText) — reliable regardless of window focus. The old
// navigator.clipboard.writeText rejected silently when unfocused, so the toast lied and the clipboard kept stale
// data. Await the real result and only report success when the write actually happened; fall back to the web API.
async function copy(text) {
  const s = String(text == null ? "" : text);
  let ok = false;
  try { ok = !!(await api.clip(s)); } catch (e) { ok = false; }
  if (!ok) { try { await navigator.clipboard.writeText(s); ok = true; } catch (e) { ok = false; } }
  toast(ok ? "Copied ✓" : "Copy failed — select the text and press ⌘C", ok ? "ok" : "err");
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/**
 * idHtml(value, shown) — an identifier shown and COPYABLE IN FULL (RULE 1).
 *
 * An address, coin id or txid exists to be pasted somewhere. Rendering `0xb126…b652` with no way back to the
 * whole string destroys the only thing it was for. Where the layout genuinely cannot carry 64 characters,
 * this keeps the full value exactly one click away — data-copy holds it complete, the delegated handler in
 * boot() copies it, and the tooltip shows it. `shown` defaults to the whole value (it was 8…6 until 0.18.38).
 */
function idHtml(value, shown) {
  const v = String(value == null ? "" : value);
  if (!v) return "";
  const disp = shown || v;   // RULE 1: the whole value by default; .idcopy wraps it
  return `<span class="idcopy" data-copy="${esc(v)}" title="${esc(v)}\n(click to copy)">${esc(disp)}</span>`;
}

// ---- theme -----------------------------------------------------------------
// The theme follows the system, as Pandamonium does: there is no toggle. style.css switches its tokens on
// prefers-color-scheme; data-theme is kept in step for the panels that key their own palettes on it
// (mail.css, chat.css). The old saved "theme" config value is no longer read.
const SYSTEM_LIGHT = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  document.documentElement.setAttribute("data-theme", SYSTEM_LIGHT.matches ? "light" : "dark");
}
SYSTEM_LIGHT.addEventListener("change", applyTheme);

// ---- boot ------------------------------------------------------------------
async function boot() {
  CFG = await api.getConfig();
  try { KEYMODE = (await api.keyMode()) || KEYMODE; } catch (e) {}
  applyTheme();
  initShell();
  // RULE 1, app-wide: anything rendered with a shortened identifier carries the COMPLETE value in
  // data-copy, and one click puts that complete value on the clipboard. Delegated from the document so it
  // works for every view without each render path having to remember to wire it. It REPLACES the old
  // per-view wirePpCopy (PandaPools only); running both made every PandaPools id copy twice.
  // CAPTURE phase, and it stops the event dead. A copy span can sit INSIDE a clickable row — the AtomiX depth
  // book nests one in `.ax-half[data-take]`, whose handler jumps to the Swap tab and picks a side — so
  // "copy this maker's key" was also starting a trade setup. Capture is what makes stopping it work at all:
  // on the bubble phase this listener runs LAST (document is outermost), long after the row's own handler.
  // Copy is a terminal action, so no ancestor wants the click as well.
  document.addEventListener("click", (e) => {
    const n = e.target && e.target.closest && e.target.closest("[data-copy]");
    if (n && n.dataset.copy) { e.preventDefault(); e.stopPropagation(); copy(n.dataset.copy); }
  }, true);
  api.appVersion().then(v => { APP_VERSION = v || ""; }).catch(() => {});
  // App updates: the store feed is checked in the main process; the menu gains an "Update" item when a newer build exists.
  const refreshUpdatePill = async () => {
    try { const u = await api.updateStatus(); const b = el("hdrUpdate"); if (!b) return; b.hidden = !u.available; if (u.available) b.textContent = "Update to " + u.version; el("moreBtn").classList.toggle("bar__more--update", !!u.available); } catch (e) {}
  };
  el("hdrUpdate").addEventListener("click", () => openSettingsAt("updCard"));
  if (api.onOpenUpdate) api.onOpenUpdate(() => el("hdrUpdate").click());
  refreshUpdatePill(); setTimeout(refreshUpdatePill, 15_000); setInterval(refreshUpdatePill, 60_000);   // the first feed check runs ~8 s after launch

  api.onStatus(onStatus);
  api.onLog(appendLog);
  api.onMail(onMailUpdate);
  api.onChat(onChatUpdate);
  api.onChatFocus(() => { selectTab("chat"); ChatPanel.focusLatest(); });
  api.onPandapools(onPandapoolsUpdate);
  api.onAtomix(onAtomixUpdate);
  api.onEthWallet(onEthWalletUpdate);
  api.onShop(onShopUpdate);
  api.onCasino(chanceLeftCard);            // P2P Chance is removed; this only refreshes its "still open" Settings card
  api.onVestr(onVestrUpdate);
  api.onWebWallet(onWebWalletUpdate);

  // KeetChat rides the keets transport, which both node kinds run (0.18.17+).
  const chtab = el("chatTab"); if (chtab) chtab.hidden = false;

  // Run onboarding until BOTH the node wizard and the wallet step are done. A stale pre-0.1.1 config can have
  // setupDone:true but walletDone:false (no walletMode/peersUrl) — that must still show the wizard, not skip it.
  if (!CFG.setupDone || !CFG.walletDone) { showSetup(); return; }
  waitingForNode = true;
  const s = await api.nodeStatus();
  onStatus(s);
  if (s.state === "stopped") api.nodeStart();
}

// The tray's bottom line, as the phone's drawer: the mode this wallet really runs in.
function paintKeyMode(mode) {
  if (mode) KEYMODE.mode = mode;
  el("trayMode").textContent = KEYMODE.mode === "block" ? "Block key uses · low-RAM node" : "Classic mode";
}
// The running node was found in the other key mode and stopped (main/node-manager.js verifyKeyMode): the message
// stays over the whole window, with nothing to dismiss it. Quitting the app is the way on.
function showKeyModeBlock(msg) {
  if (el("keyModeBlock")) return;
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="keyModeBlock" data-modal><div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="kmbTitle">
    <div class="modal__title" id="kmbTitle">Node stopped: wrong key mode</div><div class="view__desc" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(msg)}</div></div></div>`);
  el("shell").inert = true;
}
function onStatus(s) {
  if (s.keyModeAlert) showKeyModeBlock(s.keyModeAlert);
  paintKeyMode(s.keyMode);
  paintFooter(s);
  nodeState = s.state;
  DexUI.node(s);
  // A node the user shut down: say so on every screen, with the way back. (At launch the node is "stopped" for a moment too.)
  el("stopBar").hidden = !(s.state === "stopped" && !s.resyncing && !waitingForNode && CFG.setupDone && CFG.walletDone);

  // live progress on the starting/onboarding overlay (before the wallet is ready)
  if (el("setup").style.display !== "none" && !CFG.walletDone) updateSetupProgress(s);

  const wasRunning = running;
  running = s.state === "running";
  if (running && (waitingForNode || !wasRunning)) {
    waitingForNode = false;
    startRefresh();
    refreshMailBadge();
    if (CFG.walletDone) { hideSetup(); renderActive(); }
    else if (!postBootStarted) { postBootStarted = true; runPostBoot(); }
  }
  // The node went away: the Wallet and Faucet must not keep showing what it last said.
  if (wasRunning && !running) { resetWalletFigures(); keyUsesReset(); if (activeView === "balances" || activeView === "faucet" || activeView === "keyuses") renderActive(); }
  if (activeView === "node") renderNode(s);
  // The Parlons tab follows the account, not the chain: re-render on a readiness/error change only.
  if (s.parlons) {
    const sig = (s.parlons.ready ? "1" : "0") + "|" + (s.parlons.error || "") + "|" + s.state;
    if (sig !== parlonsLastSig) { parlonsLastSig = sig; renderParlons(); }
  }
  wwLastStatus = s;
  wwLiveRender();   // flip the megammr gate live after enable+restart — but NEVER rebuild the form on a routine block tick
}

// ---- first run: the phone's launcher (New Wallet / Restore Wallet / Startup Params) ------------------------
// The layer covers the window until a wallet exists. Underneath it is the old wizard's logic, in its order:
// save the config, start the node, and once it runs either show the node's new seed (and have it typed back)
// or apply the held seed with megammrsync. A seed is held in memory only (RESTORE, or a local in the seed
// screens) and is never saved, logged or sent anywhere but to this computer's own node.
function frScreen(title, back, bodyClass) {
  el("setup").style.display = ""; el("shell").inert = true;
  el("setupBar").hidden = !title; el("setupTitle").textContent = title || "";
  el("setupBack").hidden = !back; el("setupBack").onclick = back || null;
  const body = el("setupBody"); body.className = "fr-body " + (bodyClass || "pscreen"); body.scrollTop = 0;
  return body;
}
function showSetup() {
  frScreen("", null, "fr-launch").innerHTML = `
    <div class="fr-hero">${CORE_MARK.replace("tray__ic", "fr-logo")}
      <div class="fr-name">MINIMA CORE</div>
      <p class="fr-intro">Your own node, on your computer.\nChoose how to begin.</p></div>
    <div class="fr-btns">
      <button class="btn btn--primary ps-btn ps-btn--main" id="frNew">New Wallet</button>
      <button class="btn btn--outline ps-btn ps-btn--main" id="frRestore">Restore Wallet</button>
      <button class="btn btn--outline ps-btn ps-btn--main" id="frParams">Startup Params</button>
    </div>`;
  el("frNew").onclick = () => frStart(null);
  el("frRestore").onclick = () => frRestore();
  el("frParams").onclick = () => renderParams(frScreen("Startup Params", showSetup), true, showSetup);
}
function hideSetup() { el("setup").style.display = "none"; el("setupBody").innerHTML = ""; el("shell").inert = false; }

// Restore Wallet: the phone's "Restore & resync" screen, with one box per word.
function frRestore() {
  if (CFG.network === "solo") { toast("A solo network has no MegaMMR node to restore from. Change the network in Startup Params first.", "err"); return; }
  const body = frScreen("Restore Wallet", showSetup);
  body.innerHTML = `
    <h2 class="ps-h">Restore &amp; resync</h2>
    <p class="ps-intro">Enter your seed phrase, key uses and the address of a Minima MegaMMR node.\n\nEnter key uses above the number of signatures this seed has ever made, on any node. Too low reuses one-time keys and can lose funds: if unsure, set it higher.</p>
    <div class="eyebrow ps-label">Seed phrase</div><div id="frWords"></div>
    ${modeQuestionHtml()}
    <div class="eyebrow ps-label">Key uses</div><input class="field__input ps-field" id="frUses" inputmode="numeric" autocomplete="off" placeholder="0 only if this seed has never signed" />
    <div class="eyebrow ps-label">MegaMMR node</div><input class="field__input ps-field" id="frHost" autocomplete="off" spellcheck="false" value="${esc(CFG.megammrHost)}" />
    <button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="frGo">Proceed</button>`;
  const words = WordEntry.create(el("frWords"), { anyPhrase: true, clearClipboard: () => api.clip("") });
  wireModeQuestion(body);
  el("frGo").onclick = async () => {
    const km = restoreMode(body); if (km.error) { toast(km.error, "err"); return; }
    const seed = await resolveSeed(words); if (!seed) return;
    const keyuses = el("frUses").value.trim(), host = el("frHost").value.trim() || CFG.megammrHost;
    const built = resyncCommand({ host, phrase: seed, anyphrase: true, keyuses, needPhrase: true });
    if (built.error) { toast(built.error, "err"); return; }
    words.clear();
    frStart({ seed, keyuses, host, mode: km.mode });
  };
}
// "Which mode were these words used in?" Shown only when this node can run block keys; otherwise every wallet is classic.
function modeQuestionHtml() {
  if (!KEYMODE.supported) return "";
  return `<div class="eyebrow ps-label">Which kind of wallet were these words used in?</div>
    <div class="modeq" role="radiogroup" aria-label="Which kind of wallet were these words used in?">
      <button type="button" class="opt" role="radio" aria-checked="false" data-mode="block"><b>Block key uses</b><span>A wallet made in Pandamonium on a phone, or made new in this app.</span></button>
      <button type="button" class="opt" role="radio" aria-checked="false" data-mode="classic"><b>Classic</b><span>A wallet made in an older Minima Core, in MinimaClassic, or with Classic mode switched on.</span></button>
    </div>
    <p class="ps-note">The same 24 words give different addresses in each mode. Choose with care: the choice is recorded for this install and cannot be changed afterwards. If you choose the wrong one, the wallet opens with no funds in it. Nothing is lost, but the other mode then needs a fresh install of the app, where you choose again.</p>`;
}
// Restore from a backup FILE: the file brings its wallet's keys as they are, so its mode must be this install's.
// Always asked, also on a node that runs classic keys only: a block backup restored there is the forbidden mix.
// The file cannot answer for itself (everything in it is encrypted under the backup password).
function backupModeQuestionHtml() {
  const q = "Was this backup made by a wallet using block key uses, such as Pandamonium on a phone with default settings, or classic keys?";
  return `<div class="eyebrow ps-label">${q}</div>
    <div class="modeq" role="radiogroup" aria-label="${q}">
      <button type="button" class="opt" role="radio" aria-checked="false" data-mode="block"><b>Block key uses</b><span>Pandamonium on a phone with default settings, or a wallet made new in an app that uses block key uses.</span></button>
      <button type="button" class="opt" role="radio" aria-checked="false" data-mode="classic"><b>Classic keys</b><span>An older Minima Core, MinimaClassic, or a wallet made with Classic mode switched on.</span></button>
    </div>`;
}
function wireModeQuestion(host) {
  host.querySelectorAll(".modeq .opt").forEach(o => o.onclick = () => host.querySelectorAll(".modeq .opt").forEach(x => { const on = x === o; x.classList.toggle("sel", on); x.setAttribute("aria-checked", on ? "true" : "false"); }));
}
// The mode a restore runs in, or { error }. A node without block keys: classic, no question. An install whose
// mode is already recorded can only restore words of that mode: the mode is never switched.
function restoreMode(host) {
  if (!KEYMODE.supported) return { mode: "classic" };
  const picked = host.querySelector('.modeq .opt[aria-checked="true"]');
  if (!picked) return { error: "Choose which kind of wallet these words were used in." };
  const mode = picked.dataset.mode;
  if (KEYMODE.mode && KEYMODE.mode !== mode) return { error: "This install holds a " + KEYMODE.mode + " key wallet, and that cannot be changed. Words used in a " + mode + " key wallet would open an empty wallet here. Restore them on a fresh install." };
  return { mode };
}
/**
 * What the boxes hold, as the node must be given it (the phone's SeedEntry.resolve). Boxes: Minima's own form
 * (capitals, single spaces: what a node generated). A free-form phrase: exactly as typed. A free-form phrase
 * made only of list words: ASK. Every result is sent with anyphrase:true, so the node hashes exactly this
 * string. Returns "" (after saying why) when there is nothing usable yet.
 */
async function resolveSeed(words) {
  const typed = words.phrase();
  if (typed == null) { toast(words.problem(), "err"); return ""; }
  if (!words.isAnyPhrase()) return WordEntry.minimaForm(typed);
  if (!WordEntry.allListWords(typed)) return typed.trim();
  const pick = await new Promise(res => showActionSheet("These are list words", [
    { label: "Minima's form", onclick: () => res("minima") }, { label: "Exactly as typed", onclick: () => res("typed") }],
    "A wallet made by Minima uses its own form of the words (capitals, single spaces). Older apps could make a wallet from the words exactly as they were typed. Choose \"Exactly as typed\" only for such a wallet: otherwise you open a different, empty wallet.", () => res("")));
  return pick === "minima" ? WordEntry.minimaForm(typed) : pick === "typed" ? typed.trim() : "";
}
// New Wallet or a restore: save the config, then start the node. restore = { seed, keyuses, host } or null.
async function frStart(restore) {
  const solo = CFG.network === "solo";
  // The key mode is recorded ONCE, here, before the node first starts for this wallet. A recorded mode is kept;
  // otherwise a restore uses the mode its words were used in, and a new wallet is block unless the node cannot
  // run block keys or Classic mode was switched on. A refusal (the mode is already the other one) stops here.
  const want = KEYMODE.mode || (restore ? restore.mode : (KEYMODE.supported && !FR_CLASSIC ? "block" : "classic"));
  try { KEYMODE.mode = await api.recordKeyMode(want); } catch (e) { toast(ipcError(e), "err"); return; }
  RESTORE = restore;   // memory only: applied by megammrsync after the node is up, then cleared
  const mode = restore ? "restore" : "new", megammrHost = restore ? restore.host : CFG.megammrHost;
  const patch = { setupDone: true, walletMode: mode, walletDone: solo, megammrHost };
  try { CFG = await api.saveConfig(patch); } catch (e) { RESTORE = null; toast(ipcError(e), "err"); return; }
  waitingForNode = true;
  postBootStarted = false;      // let the post-boot wallet step run for this start
  showStarting();
  if (running) await api.nodeRestart(); else await api.nodeStart();
}

// ---- Startup Params (the phone's ParamsActivity, over the reconfigure logic the old wizard had) ------------
// P is the working copy of every non-managed minima.jar flag; the switches, the network preset and the full
// editor all write into it, and it is saved verbatim as config.params. MINIMA_PARAMS is the shared manifest
// (params.js). Nothing here touches the wallet: no seed, no walletDone, no walletMode.
// The network preset and the Server switch fill the flags they own (was applyNet / applyRole in the wizard).
function applyNetPreset(P, net, server, customPeer, peersUrl) {
  if (net === "solo") {
    Object.assign(P, { solo: true, isclient: false, mobile: false, nosyncibd: false, limitbandwidth: false,
      allowallip: false, p2pnodes: "", connect: "" });
    return P;
  }
  Object.assign(P, { solo: false, test: false, genesis: false, allowallip: true });
  // The Server switch owns the client/server flags (see params.js): applied after the network preset.
  Object.assign(P, server ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
  if (net === "custom") { P.connect = customPeer; P.p2pnodes = ""; }
  else { P.p2pnodes = peersUrl || MINIMA_PARAMS.defaultParams().p2pnodes; P.connect = ""; }
  return P;
}
// What Save writes, or why it cannot. f = { net, server, basePort, rpcPort, dataFolder, customPeer, extraArgs, P }.
function paramsPatch(f, cfg) {
  if (f.net === "custom" && !f.customPeer) return { error: "Enter a host:port for the custom peer." };
  const keyArg = MINIMA_PARAMS.keyModeArg(f.extraArgs);
  if (keyArg) return { error: keyArg + " cannot be set here. The wallet's key mode sets it." };
  const ownedArg = MINIMA_PARAMS.reservedArg(f.extraArgs);
  if (ownedArg) return { error: ownedArg + " cannot be set here. The app sets it itself." };
  return { patch: {
    network: f.net, basePort: parseInt(f.basePort, 10) || cfg.basePort, rpcPortManual: f.rpcPort,
    contribute: !!f.server && f.net !== "solo", dataFolder: f.dataFolder || "",
    customConnect: f.net === "custom" ? f.customPeer : "", params: f.P, extraArgs: f.extraArgs
  } };
}
function psSwitch(id, title, on, body) {
  return `<div class="ps-sw"><span class="ps-sw__t" id="${id}L">${esc(title)}</span><button class="switch switch--m2" role="switch" id="${id}" aria-checked="${on ? "true" : "false"}" aria-labelledby="${id}L"></button></div>
    <p class="ps-note">${esc(body)}</p>`;
}
// host: the Startup Params screen, or the first-run layer (firstRun: no wallet yet, so Save only, as the phone).
function renderParams(host, firstRun, done) {
  host = host || el("paramsBody");
  const $ = (id) => host.querySelector("#" + id);
  const isOn = (id) => $(id).getAttribute("aria-checked") === "true";
  const P = Object.assign({}, MINIMA_PARAMS.defaultParams(), CFG.params || {});
  let net = CFG.network || "mainnet";
  const rpcPort = parseInt(CFG.rpcPortManual, 10) || (CFG.basePort + 4);
  const plain = CFG.nodeKind === "minima";
  host.innerHTML = `
    <h2 class="ps-h">Startup parameters</h2>
    <p class="ps-intro">Configure how the node starts. Changes take effect when the node restarts.</p>
    ${firstRun && KEYMODE.supported && !KEYMODE.mode ? psSwitch("pClassic", "Classic mode", FR_CLASSIC, "On: the wallet is made with classic keys. Off (default): block key uses on a low-RAM node (-blockaskeyuses -lowram); classic mode uses more RAM.\n\nThis is chosen once, before the wallet exists, and cannot be changed afterwards. The same seed produces different addresses in each mode: to restore a wallet, choose the mode it was made in.") : ""}
    ${psSwitch("pServer", "Server mode (-server)", !!CFG.contribute, "Accept incoming connections instead of client-only. Needs a reachable port (router forward / hotspot).")}
    ${psSwitch("pMega", "MegaMMR (-megammr)", P.megammr === true, "Keep the full Mega MMR so this node can serve seed resyncs. Uses significantly more RAM and storage.")}
    <div class="ps-sw"><span class="ps-sw__t">RPC (-rpcenable)</span><span class="ps-sw__on">Always on</span></div>
    <p class="ps-note">${plain
      ? `HTTP RPC interface on port ${esc(rpcPort)}. This app talks to its node through it, so it cannot be switched off. Anything that can reach the port can command this node, so it is never started without Basic auth: user minima, password below.`
      : `RPC interface on port ${esc(rpcPort)}, on this computer only. This app talks to its node through it, so it cannot be switched off. The Parlons Node takes no RPC password.`}</p>
    ${plain ? `<button class="btn btn--outline ps-btn ps-btn--copy" id="pRpcCopy">Copy RPC password</button>` : ""}
    ${psSwitch("pKeets", "Keets transport (-keets)", P.keets === true, "On: KeetChat and the peer-to-peer keets transport, as before. Off: no Hyperswarm sidecar and no DHT - the node runs on the classic Minima transport only and uses less RAM. Your chats and keets identity stay on this computer and return when you switch it back on. Applies after a restart.")}
    <div class="eyebrow ps-label">Extra arguments (advanced)</div>
    <textarea class="field__input ps-field" id="extraArgs" rows="2" spellcheck="false" placeholder="-p2pnodes host:port -txpowdbstore 3 …">${esc(CFG.extraArgs || "")}</textarea>
    <p class="ps-note ps-note--gap">Space-separated flags passed to the node at boot, after the parameters below. Quotes are respected. -blockaskeyuses and -lowram are not allowed here: the wallet's key mode sets them.</p>
    <details class="ps-adv"><summary>All parameters</summary>
      <div class="setup-sec"><div class="setup-sec__h">Network</div>
        <label class="opt" data-net="mainnet"><b>Mainnet</b><span>Join the live Minima network.</span></label>
        <label class="opt" data-net="solo"><b>Solo / test</b><span>A private local chain that mines its own blocks. Safe for trying things out.</span></label>
        <label class="opt" data-net="custom"><b>Custom peer</b><span>Connect to a specific host:port you provide.</span></label>
        <input class="field__input" id="customPeer" placeholder="host:port" style="display:none;margin-top:4px" value="${esc(CFG.customConnect || "")}" />
        <div class="ps-note">A network is a preset: it fills the parameters below, and you can still change any of them.</div>
      </div>
      <div class="setup-sec"><div class="setup-sec__h">Core</div>
        <div class="field"><div class="field__label">Data folder (-data / -basefolder)</div>
          <div class="seg"><input class="field__input" id="dataFolder" placeholder="(default app folder)" value="${esc(CFG.dataFolder || "")}" readonly />
          <button class="btn btn--outline btn--sm" id="pickFolder">Choose…</button></div></div>
        <div class="field"><div class="field__label">Minima port (-port)</div>
          <input class="field__input" id="basePort" value="${esc(CFG.basePort)}" inputmode="numeric" /></div>
        <div class="field"><div class="field__label">RPC port (-rpc)</div>
          <input class="field__input" id="rpcPort" value="${esc(CFG.rpcPortManual || "")}" placeholder="(auto: Minima port + 4)" inputmode="numeric" /></div>
      </div>
      <div class="setup-sec"><div class="setup-sec__h">Every startup parameter</div>
        <div id="advParams"></div>
        <div class="setup-sec__sub" style="margin-top:12px">Managed by the app</div>
        ${MINIMA_PARAMS.MANAGED_INFO.map(m => `<div class="prow prow--managed"><span class="prow__l">-${esc(m.flag)}</span><span class="prow__note">${esc(m.note)}</span></div>`).join("")}
      </div>
    </details>
    <button class="btn btn--outline ps-btn ps-btn--save" id="pSave">Save</button>
    ${firstRun ? "" : `<button class="btn btn--primary ps-btn ps-btn--main" id="pSaveRestart">Save &amp; Restart Node</button>`}`;

  // ---- the full editor (rebuilt from P so the switches and presets show through) ----
  function paramControl(it, val) {
    const id = "p_" + it.flag;
    if (it.type === "bool") {
      return `<label class="prow"><input type="checkbox" id="${id}" data-flag="${esc(it.flag)}" ${val === true ? "checked" : ""}/>
        <span class="prow__l">${esc(it.label)}</span><span class="prow__h">${esc(it.help)}</span></label>`;
    }
    const isSecret = it.type === "secret";
    const shown = isSecret ? "" : (val === true || val == null ? "" : val);
    const ph = isSecret && val === true ? "•••••••• (stored — leave blank to keep)" : "";
    return `<div class="field prow"><label class="prow__l" for="${id}">${esc(it.label)}</label>
      <input class="field__input" id="${id}" type="${isSecret ? "password" : "text"}" data-flag="${esc(it.flag)}" ${isSecret ? 'data-secret="1"' : ''} ${isSecret && val === true ? 'data-set="1"' : ''} value="${esc(shown)}" placeholder="${esc(ph)}" ${it.type === "int" ? 'inputmode="numeric"' : ''}/>
      <div class="prow__h">${esc(it.help)}</div></div>`;
  }
  function renderAdvanced() {
    $("advParams").innerHTML = MINIMA_PARAMS.GROUPS.map(g => `
      <div class="adv-group"><div class="adv-group__h">${esc(g.group)}</div>
      ${g.items.map(it => paramControl(it, P[it.flag])).join("")}</div>`).join("");
    $("advParams").querySelectorAll("[data-flag]").forEach(inp => {
      const f = inp.dataset.flag;
      if (inp.type === "checkbox") inp.onchange = () => { P[f] = inp.checked; paintSwitches(); };
      else inp.onchange = () => { P[f] = inp.value; };
    });
  }
  const paintSwitches = () => { $("pMega").setAttribute("aria-checked", P.megammr === true ? "true" : "false"); $("pKeets").setAttribute("aria-checked", P.keets === true ? "true" : "false"); };
  const applyNet = (n) => {
    net = n;
    applyNetPreset(P, net, isOn("pServer"), $("customPeer").value.trim(), CFG.peersUrl);
    host.querySelectorAll(".opt[data-net]").forEach(x => x.classList.toggle("sel", x.dataset.net === n));
    $("customPeer").style.display = n === "custom" ? "" : "none";
    $("pServer").disabled = n === "solo";
    renderAdvanced();
  };
  host.querySelectorAll(".switch--m2").forEach(sw => sw.onclick = () => {
    sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
    if (sw.id === "pMega") P.megammr = isOn("pMega");
    else if (sw.id === "pKeets") P.keets = isOn("pKeets");
    else if (sw.id === "pClassic") FR_CLASSIC = isOn("pClassic");   // kept for this first run only; recorded when the wallet is made
    else if (sw.id === "pServer" && net !== "solo") Object.assign(P, isOn("pServer") ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
    renderAdvanced();
  });
  host.querySelectorAll(".opt[data-net]").forEach(o => o.onclick = () => applyNet(o.dataset.net));
  $("customPeer").oninput = () => { if (net === "custom") P.connect = $("customPeer").value.trim(); };
  $("pickFolder").onclick = async () => { const f = await api.pickFolder(); if (f) $("dataFolder").value = f; };
  if ($("pRpcCopy")) $("pRpcCopy").onclick = async () => {   // the password goes from the main process to the clipboard; it never reaches this page
    let ok = false; try { ok = !!(await api.copyRpcPassword()); } catch (e) {}
    toast(ok ? "RPC password copied" : "Could not copy the RPC password", ok ? "ok" : "err");
  };
  // Draw the editor from what is saved. The preset is applied only when the user picks a network or flips a
  // switch, so opening this screen and pressing Save changes nothing.
  host.querySelectorAll(".opt[data-net]").forEach(x => x.classList.toggle("sel", x.dataset.net === net));
  $("customPeer").style.display = net === "custom" ? "" : "none";
  $("pServer").disabled = net === "solo";
  renderAdvanced();

  const collect = () => {
    // every control of the full editor into P (a secret left blank that was already stored keeps its marker)
    $("advParams").querySelectorAll("[data-flag]").forEach(inp => {
      const f = inp.dataset.flag;
      if (inp.type === "checkbox") { P[f] = inp.checked; return; }
      const v = inp.value.trim();
      if (inp.dataset.secret) P[f] = v ? v : (inp.dataset.set ? true : "");
      else P[f] = v;
    });
    const r = paramsPatch({ net, server: isOn("pServer"), basePort: $("basePort").value, rpcPort: $("rpcPort").value.trim(),
      dataFolder: $("dataFolder").value, customPeer: $("customPeer").value.trim(), extraArgs: $("extraArgs").value.trim(), P }, CFG);
    if (r.error) { toast(r.error, "err"); return null; }
    return r.patch;
  };
  const leave = () => (done ? done() : selectTab(lastTabView));
  $("pSave").onclick = async () => {
    const patch = collect(); if (!patch) return;
    try { CFG = await api.saveConfig(patch); } catch (e) { toast(ipcError(e), "err"); return; }
    toast("Saved - applies when the node restarts", "ok"); leave();
  };
  if ($("pSaveRestart")) $("pSaveRestart").onclick = async () => {
    const patch = collect(); if (!patch) return;
    if (!await showConfirm("Restart node?", "The node will shut down cleanly and start again with the new parameters. This takes a minute.", "Restart")) return;
    try { CFG = await api.saveConfig(patch); } catch (e) { toast(ipcError(e), "err"); return; }
    toast("Restarting the node…"); leave();
    waitingForNode = true;
    if (running) await api.nodeRestart(); else await api.nodeStart();   // reconfigure = restart to apply
  };
}
// Electron wraps a main-process refusal as "Error invoking remote method 'x': Error: the message".
function ipcError(e) { return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }

// ---- Backup & Recovery (the phone's BackupActivity hub, over the backup, resync, restore and vault commands
// the Settings cards ran). One view; BK_PAGE says which of the phone's screens it shows ("" = the hub).
let BK_PAGE = "";
const BK_TITLE = { "": "Backup & Recovery", create: "Create backup", restore: "Restore from file", resync: "Resync node", keys: "Private keys" };
function bkOpen(page) { BK_PAGE = page; el("barPage").textContent = BK_TITLE[page]; el("main").scrollTop = 0; renderBackup(); }
/**
 * megammrsync, built in ONE place for every screen that runs it (chain resync, rebuild from a phrase, the
 * first-run restore). A backup FILE is restored by the main process, after its key-mode check (main/restore.js). Returns { error } or { cmd, resetsWallet }. The node's command
 * parser has no escape character, so refusing a value is the only defence: every check the Settings cards
 * and the setup dialog made is here, in their order.
 */
function resyncCommand(o) {
  const host = String(o.host || "").trim();
  const phrase = String(o.phrase || "").trim();   // a free-form phrase is hashed as typed: trim the ends only, never the inside
  const keyuses = String(o.keyuses == null ? "" : o.keyuses).trim();
  if (o.needPhrase && !phrase) return { error: "Enter your seed phrase." };
  if (/["\\]/.test(phrase)) return { error: "This seed contains a \" or \\ the restore can't carry safely. Remove it or restore via the node terminal." };
  if (phrase.includes(";")) return { error: "This seed contains a semicolon (;), which the node reads as the end of the command. Remove it or restore via the node's own command line." };
  if (/[\n\r\t]/.test(phrase)) return { error: "Remove the line breaks and tabs: enter your seed as one clean line (they change the derived wallet)." };
  if (!/^[\w.\-]+:\d+$/.test(host)) return { error: "MegaMMR host must be host:port." };
  if (phrase && !/^\d+$/.test(keyuses)) return { error: "Enter the key uses for this seed (0 if brand new). Too low reuses one-time keys and can lose funds." };
  if (keyuses && !/^\d+$/.test(keyuses)) return { error: "Key uses must be a whole number." };
  let cmd = `megammrsync action:resync host:${host}`;
  if (phrase) cmd += ` phrase:"${phrase}"` + (o.anyphrase ? " anyphrase:true" : "");
  if (keyuses) cmd += ` keyuses:${keyuses}`;
  return { cmd, resetsWallet: !!phrase };
}
// A wallet replacement that is refused ONLY because Dexicon cannot be checked (it never finished starting, or its
// store is damaged) must not be blocked for ever: the main process says so in the refusal, the user is told what
// going on means, and the main process checks again before it leaves the Dexicon check out (mcd:dxSkipCheck).
// Resolves true when the caller may try once more.
async function offerWithoutDexicon(e) {
  // 0.18.137: also AtomiX or PandaPools that cannot be checked, and the warning about this wallet's own open pools
  const why = ipcError(e), unchecked = /you can go on without this check\./.test(why), pools = /You can go on after confirming this\./.test(why);
  if (!unchecked && !pools) return false;
  let warning; try { warning = await api.dxSkipWarning(); } catch (err) { return false; }
  const dexOnly = unchecked && !pools && !/(AtomiX|PandaPools) (could not open|has not finished starting after)/.test(why);
  if (!await showConfirm(dexOnly ? "Go on without checking Dexicon?" : pools && !unchecked ? "Replace the wallet these pools belong to?" : "Replace the wallet without these checks?", warning, dexOnly ? "Go on without the check" : pools && !unchecked ? "I have its 24 words: go on" : "Go on without the check", true)) return false;
  try { await api.dxSkipCheck(); return true; } catch (err) { toast(ipcError(err), "err"); return false; }
}
// The wallet under the app changed (a restored seed or backup): every identity derived from the old seed is
// dropped and nothing the old wallet said stays on screen.
// The stores themselves were already set aside by the MAIN process, while the node was stopped (main.js
// node.onWalletReplaced, 0.18.106): that must not depend on this window being open. Here only the screen is cleared.
async function walletReplaced() {
  resetMailState(); resetPpState(); resetAxState();
  resetWalletFigures(); api.nodeStatus().then(paintFooter);
}
// A backup password as the node can carry it (the phone's rule): letters and numbers only. A quote used to
// close password:"…" early, so the node encrypted under a DIFFERENT password than the one typed.
function backupPasswordProblem(pw, again) {
  if (!pw) return "Enter a backup password.";
  if (!/^[A-Za-z0-9]+$/.test(pw)) return "Letters and numbers only";
  if (pw !== again) return "The two passwords do not match";
  return "";
}
function renderBackup() {
  const host = el("backupBody"), $ = (id) => host.querySelector("#" + id);
  el("barPage").textContent = BK_TITLE[BK_PAGE];
  const head = (h, intro) => `<h2 class="ps-h">${esc(h)}</h2><p class="ps-intro">${esc(intro)}</p>`;
  const field = (id, label, attrs) => `<div class="eyebrow ps-label">${esc(label)}</div><input class="field__input ps-field" id="${id}" autocomplete="off" spellcheck="false" ${attrs || ""}/>`;
  const stopped = `<div class="ps-tile ps-tile--strong" role="status">The node is not running. Start the node before backing up or restoring.</div>`;
  if (BK_PAGE && !running) { host.innerHTML = head(BK_TITLE[BK_PAGE], "") + stopped; return; }

  if (BK_PAGE === "") {
    const rows = [["create", "Create backup", "Write an encrypted .bak of this node into its data folder."],
      ["restore", "Restore from file", "Put a backup back on this node, then catch up to the chain tip from a MegaMMR node."],
      ["chat", "Chat backup", "Save or restore your keets chat address, contacts and messages."],
      ["mail", "Mail backup", "Save or restore your MinimaMail identity, contacts and messages."],
      ["resync", "Resync node", "Rebuild this node's chain from a MegaMMR node. Your wallet and seed phrase are not touched."],
      ["keys", "Private keys", "Seed phrase, or rebuild this wallet from a phrase."]];
    host.innerHTML = head("Backup & Recovery", "Save a copy of this node, put it back, or rebuild it from another node.") + (running ? "" : stopped) +
      `<div class="bk-rows">` + rows.map(r => `<button class="bk-row" data-bk="${r[0]}"${running ? "" : " disabled"}><span class="bk-row__t">${esc(r[1])}</span><span class="bk-row__s">${esc(r[2])}</span></button>`).join("") + `</div>`;
    host.querySelectorAll(".bk-row").forEach(b => b.onclick = () => {
      const k = b.dataset.bk;
      if (k === "chat") showActionSheet("Chat backup", [{ label: "Back up chats", onclick: () => ChatPanel.backup() }, { label: "Restore chats", onclick: () => ChatPanel.restore() }]);
      else if (k === "mail") showActionSheet("Mail backup", [{ label: "Back up identity", onclick: () => MailPanel.backup() }, { label: "Restore from a backup", onclick: () => MailPanel.restore() }]);
      else bkOpen(k);
    });
    return;
  }

  if (BK_PAGE === "create") {
    host.innerHTML = head("Create backup", "Writes one encrypted .bak file holding this node's wallet, chain and archive. The node keeps running.") +
      field("bkPw", "Password", 'type="password" placeholder="letters and numbers only"') +
      field("bkPw2", "Confirm password", 'type="password" placeholder="type it again"') +
      `<div class="ps-tile">This password is the only thing protecting your private keys inside the file. There is no way to recover the backup without it, and no way to reset it later.</div>
      <button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="bkGo">Create backup</button>
      <div class="bk-status" id="bkStatus" role="status"></div><div id="bkOut"></div>`;
    $("bkGo").onclick = async () => {
      const pw = $("bkPw").value, st = $("bkStatus");
      const why = backupPasswordProblem(pw, $("bkPw2").value);
      if (why) { toast(why, "err"); return; }
      $("bkGo").disabled = true; $("bkGo").textContent = "Creating…";
      st.textContent = "Writing the backup. The node is locked while it copies, so this can take a while.";
      try {
        const r = await cmd(`backup password:"${pw}"`);
        const b = (r && r.backup) || r || {}, file = b.file || "";
        $("bkPw").value = ""; $("bkPw2").value = "";
        st.textContent = file ? "Backup created. Saved in the node folder as" : "Backup created in the node's data folder.";
        $("bkOut").innerHTML = file ? `<div class="bk-mono" id="bkPath">${esc(file)}</div><button class="btn btn--outline ps-btn" data-copy="${esc(file)}">Copy full path</button>` : "";
      } catch (e) { st.textContent = "Backup failed. " + e.message; }
      $("bkGo").disabled = false; $("bkGo").textContent = "Create backup";
    };
    return;
  }

  // The three screens that run megammrsync share its confirm step, its run and what follows a replaced wallet.
  const run = async (btnId, label, built, title, warning, okLabel) => {
    if (built.error) { toast(built.error, "err"); return; }
    if (!await showConfirm(title, warning, okLabel, built.resetsWallet)) return;
    const btn = $(btnId), st = $("bkStatus"); btn.disabled = true; btn.textContent = label + "…"; st.textContent = "";
    try {
      const attempt = async () => { if (built.exec) { const j = await built.exec(); if (!j || j.status !== true) throw new Error((j && j.error) || "the node refused the restore"); } else await cmd(built.cmd); };
      try { await attempt(); } catch (e) { if (!await offerWithoutDexicon(e)) throw e; await attempt(); }
      CFG = await api.saveConfig({ megammrHost: built.host });
      if (built.resetsWallet) await walletReplaced();
      // The node shut itself down at the end and the main process started it again, through every start check.
      const after = await api.nodeStatus();
      if (after.state === "error") { st.textContent = label + " finished, but the node was not started again. " + (after.lastError || ""); btn.disabled = false; btn.textContent = btn.dataset.label; return; }
      toast(label + " complete ✓ The node is restarting.", "ok"); bkOpen("");
    } catch (e) { st.textContent = label + " not completed. " + ipcError(e); btn.disabled = false; btn.textContent = btn.dataset.label; }
  };
  const hostField = field("bkHost", "MegaMMR node", `value="${esc(CFG.megammrHost)}"`);
  const built = (o) => Object.assign(resyncCommand(o), { host: String(o.host || "").trim() });

  if (BK_PAGE === "resync") {
    host.innerHTML = head("Resync node", "Choose a Minima MegaMMR node to resync from. Use the format host:port.") + hostField +
      `<button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="bkGo" data-label="Resync">Resync</button><div class="bk-status" id="bkStatus" role="status"></div>`;
    $("bkGo").onclick = () => { const h = $("bkHost").value.trim(); run("bkGo", "Resync", built({ host: h }), "Resync this node?",
      "Minima will rebuild its chain data from " + h + ".\n\n• Your wallet and seed phrase are not touched.\n• Any transaction still waiting to be mined is dropped.\n\nThis can take a while on a slow connection.", "Resync"); };
    return;
  }

  if (BK_PAGE === "restore") {
    host.innerHTML = head("Restore from file", "Replaces this node's wallet and chain with the contents of a backup, then catches up to the chain tip from a MegaMMR node.") +
      field("bkFile", "Backup file", 'placeholder="a .bak file in the node folder, or its full path"') +
      field("bkFilePw", "Backup password", 'type="password" placeholder="the password used when it was made"') + backupModeQuestionHtml() + hostField +
      `<button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="bkGo" data-label="Restore this node">Restore this node</button><div class="bk-status" id="bkStatus" role="status"></div>`;
    wireModeQuestion(host);
    $("bkGo").onclick = async () => { const f = $("bkFile").value.trim(), picked = host.querySelector('.modeq .opt[aria-checked="true"]');
      const o = { host: $("bkHost").value.trim(), file: f, password: $("bkFilePw").value, mode: picked ? picked.dataset.mode : "" };
      // The main process checks the backup's key mode and builds the command; a refusal comes before the question below.
      try { $("bkStatus").textContent = ""; await api.restoreBackup(Object.assign({ check: true }, o)); } catch (e) { if (!await offerWithoutDexicon(e)) { $("bkStatus").textContent = ipcError(e); return; } }
      run("bkGo", "Restore", { host: o.host, resetsWallet: true, exec: () => api.restoreBackup(o) }, "Replace this node?",
      "Minima will replace its wallet and chain with " + f + ".\n\n• The keys and coins this node holds now are GONE unless they are also in that backup.\n• Any transaction still waiting to be mined is dropped.", "Restore"); };
    return;
  }

  // Private keys: the seed phrase, and the rebuild of this wallet from a phrase.
  host.innerHTML = head("Private keys", "Anyone who reads these words owns your funds. Write them down somewhere only you can reach: never in a photo, a note app or a message.") +
    `<div class="eyebrow ps-label">Seed</div>
    <div class="seedcard" id="bkSeed" hidden></div>
    <button class="btn btn--outline ps-btn" id="bkShow">Show seed phrase</button>
    <div class="eyebrow ps-label bk-gap">Rebuild wallet from seed phrase</div>
    <p class="ps-note ps-note--body">Replace this node's wallet with the one for a seed phrase, then resync from a MegaMMR node. Destructive.</p>
    <div class="eyebrow ps-label">Seed phrase</div><div id="bkWords"></div>` + modeQuestionHtml() +
    field("bkUses", "Key uses", 'inputmode="numeric" placeholder="higher than any previous rebuild of this seed"') + hostField +
    `<button class="btn btn--danger ps-btn ps-btn--main ps-btn--go" id="bkGo" data-label="Rebuild">Rebuild</button><div class="bk-status" id="bkStatus" role="status"></div>`;
  $("bkShow").onclick = async () => {
    const box = $("bkSeed");
    if (!box.hidden) { box.hidden = true; box.textContent = ""; $("bkShow").textContent = "Show seed phrase"; return; }
    const p = seedFrom(await tryCmd("vault"));
    if (!p) { toast("The node did not return a seed phrase.", "err"); return; }
    box.textContent = p; box.hidden = false; $("bkShow").textContent = "Hide seed phrase";
  };
  const words = WordEntry.create($("bkWords"), { anyPhrase: true, clearClipboard: () => api.clip("") });
  wireModeQuestion(host);
  $("bkGo").onclick = async () => { const km = restoreMode(host); if (km.error) { toast(km.error, "err"); return; }
    const seed = await resolveSeed(words); if (!seed) return;
    run("bkGo", "Rebuild", built({ host: $("bkHost").value, phrase: seed, anyphrase: true, keyuses: $("bkUses").value, needPhrase: true }), "Rebuild this wallet?",
    "Minima will replace this node's wallet with the one for that seed phrase and resync from a MegaMMR node.\n\n• The keys and coins this node holds now are GONE unless they belong to that phrase.\n• Key uses must be HIGHER than any previous rebuild. Minima signatures are stateful, and reusing a key index is how a wallet loses funds.", "Rebuild"); };
}

// ---- starting / progress screen ---------------------------------------------
function showStarting() {
  const restore = CFG.walletMode === "restore";
  frScreen("", null).innerHTML = `
    <div class="setup-progress">
      <div class="spin spin--lg"></div>
      <div class="setup-progress__title" id="startTitle">Starting your node…</div>
      <div class="view__desc" id="startSub">${restore
        ? "Starting the node on " + esc(CFG.network) + ", then restoring your seed from the MegaMMR node."
        : "Starting the node and connecting to the " + esc(CFG.network) + " network."}</div>
      <div class="setup-progress__stat" id="startStat">connecting…</div>
    </div>`;
}
function updateSetupProgress(s) {
  const stat = el("startStat"); if (!stat) return;
  if (s.state === "starting") stat.textContent = "connecting…";
  else if (s.state === "running" && s.health) stat.textContent = "● " + (s.health.connections || 0) + " peers · block #" + (s.health.block || 0);
  else if (s.state === "error") {
    stat.textContent = "⚠ " + (s.lastError || "node error"); stat.style.color = "var(--red)";
    if (!el("startBack")) {   // a way out, to change a port or a parameter and try again
      stat.insertAdjacentHTML("afterend", `<button class="btn btn--outline ps-btn" id="startBack">Back</button>`);
      el("startBack").onclick = () => { RESTORE = null; showSetup(); };
    }
  }
}

// ---- post-boot wallet step (runs once the node is running) -----------------
function seedFrom(v) { return v && (v.phrase || v.seedphrase || v.seed || v.mnemonic) || ""; }
function runPostBoot() { if (RESTORE) postBootRestore(); else postBootNewSeed(); }

// NEW wallet: the node made the seed. Show it (the phone's "Your recovery seed"), then have it typed back
// before the wallet opens. No resync: a new node just follows the tip.
async function postBootNewSeed() {
  const body = frScreen("New Wallet", null);
  body.innerHTML = `
    <h2 class="ps-h">Your recovery seed</h2>
    <p class="ps-intro">Write these words down and keep them safe. Anyone with this seed controls your funds, and it cannot be recovered if lost.</p>
    <div class="seedcard fr-seed" id="frSeed">Reading from the node…</div>
    <button class="btn btn--primary ps-btn ps-btn--main fr-proceed" id="frSaved" disabled>I've saved it. Proceed</button>`;
  let phrase = "";
  for (let i = 0; i < 20 && !phrase && el("frSeed"); i++) {   // the vault answers a moment after the node does
    phrase = String(seedFrom(await tryCmd("vault")) || "").trim();
    if (!phrase) await new Promise(r => setTimeout(r, 1500));
  }
  if (!el("frSeed")) return;
  if (!phrase) {
    el("frSeed").textContent = "The node did not return a seed phrase.";
    el("frSaved").disabled = false; el("frSaved").textContent = "Try again"; el("frSaved").onclick = postBootNewSeed;
    return;
  }
  el("frSeed").textContent = phrase;
  el("frSaved").disabled = false;
  el("frSaved").onclick = () => confirmNewSeed(phrase);
}
// The phone's confirm-entry screen: the words are typed back, one box per word, and must be this wallet's.
function confirmNewSeed(phrase) {
  const body = frScreen("New Wallet", postBootNewSeed);
  body.innerHTML = `
    <h2 class="ps-h">Confirm your seed</h2>
    <p class="ps-intro">Type in your seed phrase to confirm you have saved it.</p>
    <div class="eyebrow ps-label">Seed phrase</div><div id="frWords"></div>
    <button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="frGo">Proceed</button>`;
  const words = WordEntry.create(el("frWords"), { clearClipboard: () => api.clip("") });
  el("frGo").onclick = async () => {
    const typed = words.phrase();
    if (typed == null) { toast(words.problem(), "err"); return; }
    const miss = seedMismatch(phrase, typed);
    if (miss) { toast(miss, "err"); return; }
    CFG = await api.saveConfig({ walletDone: true });
    hideSetup(); renderActive(); toast("Wallet ready ✓", "ok");
  };
}
// "" when the typed words are the wallet's seed, else which word to check. Case and spacing are not the point here.
function seedMismatch(phrase, typed) {
  const want = WordEntry.splitPasted(phrase), got = WordEntry.splitPasted(typed);
  for (let i = 0; i < Math.max(want.length, got.length); i++) if (want[i] !== got[i]) return "Word " + (i + 1) + " is not the word of this wallet. Check what you wrote down.";
  return "";
}

// RESTORE: the node is up. Apply the held seed with megammrsync, then done.
async function postBootRestore() {
  const { seed, keyuses, host } = RESTORE;
  frScreen("", null).innerHTML = `
    <div class="setup-progress">
      <div class="spin spin--lg"></div>
      <div class="setup-progress__title">Restoring your wallet…</div>
      <div class="view__desc">Restoring your seed from the MegaMMR node (${esc(host)}).</div>
      <div class="setup-progress__stat" id="rStat">resyncing…</div>
    </div>`;
  try {
    const built = resyncCommand({ host, phrase: seed, anyphrase: true, keyuses, needPhrase: true });
    if (built.error) throw new Error(built.error);
    try { await cmd(built.cmd); } catch (e) { if (!await offerWithoutDexicon(e)) throw e; await cmd(built.cmd); }
    RESTORE = null;   // clear the seed from memory
    await walletReplaced();   // seed changed: every identity derived from the old one is dropped
    CFG = await api.saveConfig({ walletDone: true, megammrHost: host });
    const after = await api.nodeStatus();   // the node shut itself down at the end; the main process started it again
    hideSetup(); renderActive();
    if (after.state === "error") toast("Wallet restored, but the node was not started again. " + (after.lastError || ""), "err");
    else toast("Wallet restored ✓ The node is restarting.", "ok");
  } catch (e) {
    const st = el("rStat"); if (st) { st.textContent = "⚠ " + ipcError(e); st.style.color = "var(--red)"; }
    el("setupBody").insertAdjacentHTML("beforeend",
      `<button class="btn btn--primary ps-btn" id="rRetry">Retry</button><button class="btn btn--outline ps-btn" id="rBack">Back</button>`);
    el("rRetry").onclick = () => postBootRestore();
    el("rBack").onclick = () => { RESTORE = null; showSetup(); };
  }
}

// ---- the shell: Pandamonium's toolbar, six tabs, app tray, overflow menu and footer ----------------------
// selectTab(view) is still the one way to show a screen. Where the screen sits decides what the shell wears:
//   a TAB screen      toolbar (tray button, titles, menu) + tab strip + footer
//   a SUB screen      a back arrow and the screen's title, as the phone's own Receive / Send / Logs / Terminal
//   a tray APP        the dark host bar "Minima Core / Pandamonium" with the tray button; no tabs, no footer
const TAB_OF = { balances: "wallet", atomix: "dexicon", pandapools: "dexicon", dexicon: "dexicon", history: "history", apps: "apps", chat: "chat", node: "node" };
const SUB_TITLE = { receive: "Receive", send: "Send", logs: "Logs", terminal: "Terminal", settings: "Settings", params: "Startup Params", backup: "Backup & Recovery" };
// The tray, in Pandamonium's default order (PandamoniumDestinations). Apps the desktop does not have yet
// (Future Cash Next, Minima Explorer, Entropy) get a row when their phase builds them: no dead rows.
const TRAY_APPS = [
  { id: "core", name: "Minima Core" },
  { id: "mail", name: "MinimaMail", icon: "icons/mail.png", badge: "mailBadge" },
  { id: "ethwallet", name: "ETH Wallet", icon: "icons/ethwallet.png" },
  { id: "vestr", name: "Minima Vestr", icon: "icons/vestr.png" },
  { id: "keyuses", name: "KeyUses", icon: "icons/keyuses.svg" },
  { id: "faucet", name: "Minima Faucet", icon: "icons/faucet.svg" },
  { id: "minimall", name: "miniMall", icon: "icons/minimall.png", badge: "shopBadge" },
  { id: "webwallet", name: "Web Wallet", icon: "minima-mark.svg" },
  { id: "parlons", name: "Parlons", icon: "icons/parlons.png" }
];
const CORE_MARK = '<svg class="tray__ic" viewBox="0 0 105 100" aria-hidden="true"><path d="M84.16,26.77L79.52,48.44L73.58,22.29L52.79,13.38L47.17,39.59L42.21,8.86L21.42,0L0,100H22.71L29.27,69.27L34.23,100H56.98L62.56,73.8L68.5,100H91.21L105,35.63L84.16,26.77Z"/></svg>';
const NARROW = window.matchMedia("(max-width: 719px)");   // below this the tray overlays, as on the phone
let lastTabView = "balances";   // where Back returns to, and where "Minima Core" in the tray lands
let dexView = "atomix";         // the Dexicon room last shown: "atomix" (①), "pandapools" (②) or "dexicon" (③ Exchange)
let lastShellView = "balances"; // where Dexicon's ✕ returns to: the last screen that wore the shell's tabs
let APP_VERSION = "";
function store(key, value) {    // shell preferences only (tray open, order, hidden); never anything that matters
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) {}
  return null;
}
// The saved tray order: Minima Core is pinned first, then the saved ids that still exist (each once). An app the
// saved order has never seen (a new app in this version) takes its default place: straight after the app that
// comes before it in the default order, wherever the user has put that one. (PandamoniumOrder.decode appends new
// apps at the end; here a new row must not land under Parlons for everyone who ever moved a row.)
function trayOrder(saved, ids) {
  const order = [ids[0]];
  for (const id of String(saved || "").split(",")) if (ids.indexOf(id) > 0 && !order.includes(id)) order.push(id);
  ids.forEach((id, i) => { if (!order.includes(id)) order.splice(order.indexOf(ids[i - 1]) + 1, 0, id); });
  return order;
}
function viewOfTab(tab) { return tab === "wallet" ? "balances" : tab === "dexicon" ? dexView : tab; }
// Dexicon is full screen: its own header, room pills and bottom bar; none of the shell's bars (mode "dex").
function shellMode(view) { const tab = TAB_OF[view] || ""; return { tab, mode: tab === "dexicon" ? "dex" : tab ? "tabs" : SUB_TITLE[view] ? "sub" : "app" }; }

function selectTab(view) {
  // Auto-lock the Web Wallet when navigating away — never leave the seed in renderer memory on another tab.
  if (activeView === "webwallet" && view !== "webwallet" && typeof wwLock === "function") wwLock();
  if (activeView === "backup" && view !== "backup") el("backupBody").innerHTML = "";   // a shown seed phrase or a typed password never outlives the screen
  if (activeView === "keyuses" && view !== "keyuses") keyUsesReset();                 // an audit's result is not kept after the screen is left (as the phone's)
  activeView = view;
  const { tab, mode } = shellMode(view);
  if (tab) { lastTabView = view; if (tab === "dexicon") dexView = view; else lastShellView = view; }
  el("shell").dataset.mode = mode;
  el("shell").dataset.tab = tab;
  el("barPage").textContent = SUB_TITLE[view] || "";
  document.querySelectorAll(".tab").forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("tab--active", on); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
  });
  DexUI.paint(view);
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("view--active", v.id === "view-" + view));
  paintTraySelection();
  closeMenu();
  renderActive();
}

function initShell() {
  // tabs: click, and the arrow keys move along the strip (one tab stop, as a tablist should be)
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach(b => b.onclick = () => selectTab(viewOfTab(b.dataset.tab)));
  el("tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const shown = tabs.filter(b => !b.hidden), i = shown.indexOf(document.activeElement);
    if (i < 0) return;
    const next = shown[(i + (e.key === "ArrowRight" ? 1 : shown.length - 1)) % shown.length];
    e.preventDefault(); next.focus(); next.click();
  });
  DexUI.init({ go: selectTab, leave: () => selectTab(lastShellView), start: () => { toast("Starting the node…"); api.nodeStart(); } });
  el("backBtn").onclick = () => (activeView === "backup" && BK_PAGE ? bkOpen("") : selectTab(lastTabView));   // a Backup & Recovery screen goes back to its hub
  el("walSend").onclick = () => selectTab("send");
  el("walReceive").onclick = () => selectTab("receive");
  el("walHead").onclick = toggleWalBreakdown;
  el("stopStart").onclick = () => { toast("Starting the node…"); api.nodeStart(); };

  // tray
  const list = el("trayList");
  list.innerHTML = TRAY_APPS.map(a => `<button class="tray__row" data-app="${a.id}">${a.icon ? `<img class="tray__ic" src="${a.icon}" alt="">` : CORE_MARK}<span class="tray__name">${esc(a.name)}</span>${a.badge ? `<span class="tab-badge" id="${a.badge}" hidden></span>` : ""}</button>`).join("");
  list.querySelectorAll(".tray__row").forEach(r => r.onclick = () => {
    selectTab(r.dataset.app === "core" ? lastTabView : r.dataset.app);
    // The Parlons row opens Parlons: in the browser, when the account is up (its screen here says so, and what is wrong when it is not).
    if (r.dataset.app === "parlons") api.parlonsStatus().then(st => { if (st && st.kind === "parlons" && st.ready && !st.error) openParlons(); }).catch(() => {});
    if (NARROW.matches) setTray(false);
  });
  initTrayOrder(list);
  applyHiddenApps();
  api.freezeList().then(l => { FROZEN = l || []; applyHiddenApps(); if (activeView === "apps") renderApps(); }).catch(() => {});
  el("trayBtn").onclick = () => setTray(el("tray").hidden);
  el("trayScrim").onclick = () => setTray(false);
  setTray(!NARROW.matches && store("shellTray") === "1", true);
  NARROW.addEventListener("change", () => setTray(!NARROW.matches && !el("tray").hidden, true));   // also drops `inert` when the window widens

  // overflow menu
  el("moreBtn").onclick = () => (el("moreMenu").hidden ? openMenu() : closeMenu());
  el("moreMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    closeMenu(); menuAction(b.dataset.act);
  });
  el("moreMenu").addEventListener("keydown", (e) => {
    const items = [...el("moreMenu").querySelectorAll(".menu__item:not([hidden])")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === "Tab") closeMenu();
  });
  document.addEventListener("mousedown", (e) => { if (!el("moreMenu").hidden && !e.target.closest("#moreMenu, #moreBtn")) closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el("moreMenu").hidden) { closeMenu(); el("moreBtn").focus(); }
    else if (NARROW.matches && !el("tray").hidden) { setTray(false); el("trayBtn").focus(); }
  });
  selectTabQuiet();
}
// First paint of the shell state without rendering a view (boot() renders once the node is up).
function selectTabQuiet() { el("shell").dataset.tab = "wallet"; paintTraySelection(); }

// Tray rows can be dragged into a new order, or moved with Alt+Up / Alt+Down; Up / Down walk the rows.
// Minima Core stays first. The rows are MOVED, never rebuilt, so the unread counts on them survive.
function initTrayOrder(list) {
  const row = (id) => list.querySelector(`.tray__row[data-app="${id}"]`);
  for (const id of trayOrder(store("shellOrder"), TRAY_APPS.map(a => a.id))) list.appendChild(row(id));
  const save = () => store("shellOrder", [...list.children].map(r => r.dataset.app).filter(id => id !== "core").join(","));
  let dragged = null;
  list.querySelectorAll(".tray__row").forEach(r => {
    if (r.dataset.app === "core") return;
    r.draggable = true;
    r.title = "Drag to reorder, or Alt+Up / Alt+Down";
    r.addEventListener("dragstart", (e) => { dragged = r; r.classList.add("tray__row--drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.dataset.app); });
    r.addEventListener("dragend", () => { r.classList.remove("tray__row--drag"); dragged = null; save(); });
    r.addEventListener("dragover", (e) => {
      if (!dragged || dragged === r) return;
      e.preventDefault();
      const box = r.getBoundingClientRect();
      list.insertBefore(dragged, e.clientY < box.top + box.height / 2 ? r : r.nextSibling);
    });
  });
  list.addEventListener("dragover", (e) => { if (dragged) e.preventDefault(); });   // a drop anywhere on the list lands where the row already is
  list.addEventListener("keydown", (e) => {
    const r = e.target.closest(".tray__row"); if (!r || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const rows = [...list.children].filter(x => !x.hidden), i = rows.indexOf(r), up = e.key === "ArrowUp";
    const to = rows[i + (up ? -1 : 1)];
    if (!e.altKey) { if (to) to.focus(); return; }
    if (r.dataset.app === "core" || !to || to.dataset.app === "core") return;
    list.insertBefore(r, up ? to : to.nextSibling); r.focus(); save();
  });
}
function setTray(open, quiet) {
  el("tray").hidden = !open;
  el("trayScrim").hidden = !open;                      // CSS shows the scrim only when the tray overlays
  el("stage").inert = open && NARROW.matches;          // an overlaying tray is modal: Tab stays inside it (Escape or the scrim closes it)
  el("shell").classList.toggle("shell--tray", open);
  el("trayBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (!NARROW.matches && !quiet) store("shellTray", open ? "1" : "0");   // remembered for the push-aside tray
  paintTrayDot();
}
function paintTraySelection() {
  const sel = el("shell").dataset.mode === "app" ? activeView : "core";
  document.querySelectorAll(".tray__row").forEach(r => {
    const on = r.dataset.app === sel;
    r.classList.toggle("tray__row--sel", on);
    if (on) r.setAttribute("aria-current", "page"); else r.removeAttribute("aria-current");
  });
}
// Mail and miniMall count their unread on their tray rows. With the tray closed those rows are out of
// sight, so the tray button carries a dot while either count is showing. A HIDDEN app's row is never in
// sight, so its count lights the dot whether the tray is open or not, and shows on its Apps tab row.
function trayDotOn(rows, trayOpen) { return rows.some(r => r.count && (r.hidden || !trayOpen)); }
function paintTrayDot() {
  const rows = TRAY_APPS.filter(a => a.badge && el(a.badge)).map(a => ({ count: !el(a.badge).hidden, hidden: el(a.badge).closest(".tray__row").hidden }));
  el("trayDot").hidden = !trayDotOn(rows, !el("tray").hidden);
  paintAppsCounts();
}
function paintAppsCounts() {
  document.querySelectorAll("#appsList [data-count]").forEach(c => { const b = el(c.dataset.count); c.hidden = !b || b.hidden; c.textContent = b ? b.textContent : ""; });
}
// A stopped node or a restored seed: nothing the old wallet said may stay on screen (the Wallet total, the
// Faucet's address, the footer's key uses, the Node dashboard). Each is read again when it is next shown.
const NO_FIGURE = "–";
function resetWalletFigures() {
  el("walTotal").textContent = NO_FIGURE; WAL_MINIMA = null; paintWalBreakdown();
  el("faucetBody").innerHTML = "";
  FOOT_KEYS = null; FOOT_KEYS_AT = 0; NODE_DASH = {}; NODE_DASH_AT = 0; BAL_BY_TID = {}; RECV_ADDR = null; WAL_DRAG = null;
}
function waitHtml() { return nodeState === "stopped" ? `<div class="empty">The node is stopped.</div>` : `<div class="spin">Waiting for the node…</div>`; }
function openMenu() { el("moreMenu").hidden = false; el("moreBtn").setAttribute("aria-expanded", "true"); const f = el("moreMenu").querySelector(".menu__item:not([hidden])"); if (f) f.focus(); }
function closeMenu() { el("moreMenu").hidden = true; el("moreBtn").setAttribute("aria-expanded", "false"); }
function openSettingsAt(cardId) {
  selectTab("settings");
  setTimeout(() => { const c = el(cardId); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); }, 200);
}
async function menuAction(act) {
  if (act === "logs" || act === "terminal" || act === "settings") selectTab(act);
  else if (act === "backup") { BK_PAGE = ""; selectTab("backup"); }
  else if (act === "params") selectTab("params");
  else if (act === "shutdown") {
    // What is in flight, from the engines' own records, said by the main process (main/inflight.js): the same
    // source and the same words as the Quit warning. A read that fails is said, not shown as idle.
    const w = await Promise.race([api.inFlight("shutdown").catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))])
      || { title: "Shut down the node?", message: "Could not be checked: whether a swap, a pool operation or an Exchange trade is in flight. Look at the Dexicon tab before you shut down.\n\nThe node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until you start it again." };
    if (!await showConfirm(w.title, w.message, "Shut down", true)) return;
    toast("Shutting down the node…");
    try { await api.nodeStop(); } catch (e) { toast(e.message || String(e), "err"); }
  }
}

// Footer, as the phone's: a dot and the key line on the left, "block @ time" on the right. This node uses
// classic keys, so the left reads "Key uses: N" (the phone's own text when block-as-key-uses is off).
let FOOT_KEYS = null, FOOT_KEYS_AT = 0;
// The node reports the tip's time as Java's Date.toString(), "Thu Jul 16 14:54:04 BST 2026". new Date() only
// knows GMT and the US zone names, so BST, CET, JST and the rest came back invalid and the time went blank.
// The wall clock and the date are taken from the text itself; "NO BLOCKS YET" and anything else carry no clock.
function clock(t) { const m = /\b\d\d:\d\d:\d\d\b/.exec(String(t || "")); return m ? m[0] : ""; }
function blockTime(t) {
  t = String(t || "").trim();
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d\d:\d\d:\d\d) (\S+) (\d{4})$/.exec(t);
  if (m) return m[1] + " " + Number(m[2]) + ", " + m[5] + ", " + m[3] + " " + m[4];
  return /^no blocks/i.test(t) ? "No blocks yet" : clock(t) ? t : "";
}
function paintFooter(s) {
  const h = s.health || {}, up = s.state === "running";
  el("footDot").dataset.state = s.state || "";
  const keyLabel = KEYMODE.mode === "block" ? "Last key block: " : "Key uses: ";   // the phone's two wordings
  el("footL").textContent = up ? (FOOT_KEYS == null ? "Awaiting blocks…" : keyLabel + FOOT_KEYS)
    : s.state === "error" ? "Node error" : s.resyncing ? "Restarting after resync…" : s.state === "stopped" ? "Node stopped" : "Awaiting blocks…";
  const at = clock(h.time);
  el("footR").textContent = up && h.block ? h.block + (at ? " @ " + at : "") : "";
  if (up && Date.now() - FOOT_KEYS_AT > 60000) {       // one read-only `keys` a minute at most
    FOOT_KEYS_AT = Date.now();
    tryCmd("keys").then(k => { const n = maxKeyUses(k); if (n != null) { FOOT_KEYS = n; if (running) el("footL").textContent = keyLabel + n; } });
  }
}
// `keys` reports the most-used key as response.maxuses (what the phone shows); older jars only list the keys.
function maxKeyUses(k) {
  if (!k) return null;
  if (k.maxuses != null && !Array.isArray(k)) return k.maxuses;
  const arr = Array.isArray(k) ? k : k.keys;
  return Array.isArray(arr) && arr.length ? keysInfo(k).used : null;
}
// ===================== Web Wallet (local, MegaMMR-gated) =====================
// The screens of the official Minima Web Wallet 2.5.2 (mds/webWallet: its login card, the Balance / Send / Receive tabs, the
// token search and detail, the logout dialog; its colours and Manrope), over main/webwallet.js and the LOCAL -megammr node.
// The seed is passed to main only for loopback signing (keys genkey → sendfrom on 127.0.0.1) and is never persisted: held
// here in memory while logged in, cleared on Logout. Every desktop safeguard stays: the "never type your seed into a
// website" banner, the MegaMMR gate, the one-time key-uses acknowledgement with its on-chain check, the two-click confirm,
// the UNKNOWN-status lock. NOT reproduced, on purpose: "Remember me" (the original stores the seed in plain text),
// "Generate secret key", and a per-send key-uses figure the user may lower (main keeps a durable counter that only grows).
let wwLastStatus = null, wwSeed = null, wwAddr = null, wwBal = [], wwKu = null, wwArmed = false, wwKuSuggest = 0, wwMode = null;
// The wallets (by address) whose last send's status is UNKNOWN. NOT cleared by Logout or by leaving the screen (0.19.123:
// logging out and in again offered Send at once, with the possible first payment unchecked): only "I've checked" clears one.
// In memory, as everything on this screen: a restart of the app starts clean.
const WW_UNKNOWN = new Set();
function wwUnknown(address, set) {
  const k = String(address || "").toLowerCase(); if (!k) return false;
  if (set === true) WW_UNKNOWN.add(k); else if (set === false) WW_UNKNOWN.delete(k);
  return WW_UNKNOWN.has(k);
}
let wwTab = "balance", wwSearch = "", wwForm = { to: "", amt: "", tok: "0x00" };

// The 4 render "modes". A LIVE update (block tick / status push) must ONLY re-render when the mode CHANGES —
// re-rendering the same mode rebuilds the panel and WIPES whatever the user is typing (the seed field, the send
// form). User-initiated calls (tab select, login, refresh, logout, send) call renderWebWallet() directly instead.
function currentWwMode() { if (!running) return "waiting"; if (!wwMegammrOn()) return "gate"; if (!wwSeed || !wwAddr) return "unlock"; return "wallet"; }
function wwLiveRender() { if (activeView === "webwallet" && currentWwMode() !== wwMode) renderWebWallet(); }
function onWebWalletUpdate() { wwLiveRender(); }
function wwLock() { wwSeed = null; wwAddr = null; wwBal = []; wwKu = null; wwArmed = false; wwKuSuggest = 0; wwTab = "balance"; wwSearch = ""; wwForm = { to: "", amt: "", tok: "0x00" }; }
function wwMegammrOn() { return !!(wwLastStatus && wwLastStatus.health && wwLastStatus.health.megammr); }
// A token is named from its id where the id is known; an unnamed token (main hands back the start of its id) shows its whole id.
function wwName(b) { const k = PayLabel.token(b.tokenid); return k.known ? (k.name === "MINIMA" ? "Minima" : k.name) : nameWithId(b.tokenid, b.name); }
/** A token NOT known by its id (0.19.124): its own name, with what cannot be seen taken out (control, format and zero-width
 *  characters), AND its whole token id beside it, so that a name made to read as another token's is told apart by the id.
 *  A name that reads as Minima or MxUSD, or is only the start of the id, is not shown: the id alone is. */
function nameWithId(tid, name) {
  const n = String(name == null ? "" : name).replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "").replace(/\s+/g, " ").trim();
  return n && !String(tid).startsWith(n) && !/^(minima|mxusdt?)$/i.test(n) ? n + " (token " + tid + ")" : String(tid);
}
const WW_SAFE = `<div class="ww-safe"><b>Runs entirely on this computer.</b> Your secret key is sent only to your own local node (127.0.0.1) to derive keys and sign. It never leaves this machine and is never saved.
  <br><b>Never type your secret key into a website Web Wallet.</b> A hosted site can steal it (that has drained wallets).</div>`;
const wwCard = (inner) => `<div class="ww"><div class="ww-card">${inner}</div></div>`;

async function renderWebWallet() {
  const body = el("webwalletBody");
  wwMode = currentWwMode();   // record what we're about to render, so wwLiveRender only re-renders on a real change
  if (!running) { body.innerHTML = wwCard(`<h1 class="ww-h1">Minima Web Wallet</h1><p class="ww-p">Waiting for the node…</p>`); return; }
  if (!wwMegammrOn()) return renderWwGate(body);
  if (!wwSeed || !wwAddr) return renderWwUnlock(body);
  return renderWwWallet(body);
}

function renderWwGate(body) {
  body.innerHTML = wwCard(`<h1 class="ww-h1">Minima Web Wallet is unavailable!</h1><p class="ww-p">A -megammr node is required to use this Wallet.</p><hr class="ww-hr">
    <p class="ww-p">The Web Wallet reaches a wallet from its secret key alone, so this node must keep the full MegaMMR to serve the coins and proofs of that wallet's address. Enabling MegaMMR restarts the node and grows its data over time. It is a one-time change.</p>
    <button class="ww-btn" id="wwEnableBtn">Enable MegaMMR &amp; restart node</button>`);
  el("wwEnableBtn").addEventListener("click", async () => {
    const b = el("wwEnableBtn"); b.disabled = true; b.textContent = "Restarting node…";
    try { await api.wwEnableMegammr(); toast("MegaMMR enabled. The node is restarting", "ok"); }
    catch (e) { toast("Could not enable MegaMMR", "err"); b.disabled = false; b.textContent = "Enable MegaMMR & restart node"; }
  });
}

function renderWwUnlock(body) {
  body.innerHTML = wwCard(`<h1 class="ww-h1">Minima Web Wallet</h1><p class="ww-p">Login with your secret key.</p><hr class="ww-hr">${WW_SAFE}
    <div class="ww-field"><input class="ww-in" id="wwSeedIn" type="password" placeholder="Enter a secret key" aria-label="Secret key" autocomplete="off" spellcheck="false" />
      <button class="ww-eye" id="wwEye" aria-label="Show the secret key" aria-pressed="false">Show</button></div>
    <p class="ww-fine">24 words or your own phrase: any phrase is accepted. Enter it EXACTLY as created: capitals, spaces and hyphens (-) all count. <b>Do not share this key with anyone!</b></p>
    <button class="ww-btn" id="wwUnlockBtn">Login</button>`);
  el("wwEye").onclick = () => { const i = el("wwSeedIn"), on = i.type === "password"; i.type = on ? "text" : "password"; el("wwEye").textContent = on ? "Hide" : "Show"; el("wwEye").setAttribute("aria-pressed", on); };
  const go = async () => {
    // Pass the phrase VERBATIM (only trim leading/trailing whitespace) — the node hashes it faithfully, so
    // lowercasing/collapsing would derive a DIFFERENT wallet. Mirror the restore flow's guard.
    const seed = String(el("wwSeedIn").value || "").trim();
    if (!seed) { toast("Enter your secret key.", "err"); return; }
    if (/["\\\n\r\t]/.test(seed)) { toast("The key has a \", \\ or line break the command can't carry. Enter it as one clean line.", "err"); return; }
    const b = el("wwUnlockBtn"); b.disabled = true; b.textContent = "Logging in…";
    try {
      wwAddr = await api.wwDerive(seed);
      wwSeed = seed;
      wwKu = await api.wwKeyuses(wwAddr.address).catch(() => ({ keyuses: 0, ack: false }));
      // M2: auto-check on-chain key-uses so the confirm field never defaults to a bare 0 for a seed that has
      // already spent elsewhere (under-counting reuses a WOTS leaf = fund loss). Best-effort; floored below.
      wwKuSuggest = 0;
      if (!wwAddr.isNodeSeed) { try { const ka = await api.keyAudit([wwAddr.publickey]); const k = ka && ka.keys && ka.keys[0]; if (k) wwKuSuggest = Math.max(Number(k.spend_blocks) || 0, Number(k.spent_coins) || 0); } catch (e) {} }
      wwBal = await api.wwRead(wwAddr.address, wwAddr.isNodeSeed).catch(() => []);
      el("wwSeedIn").value = "";
      renderWebWallet();
    } catch (e) {
      toast((e && e.message) || "Could not log in", "err");
      b.disabled = false; b.textContent = "Login";
    }
  };
  el("wwUnlockBtn").addEventListener("click", go);
  el("wwSeedIn").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

// Match the original webWallet EXACTLY: display `confirmed`, and append "/<unconfirmed>" only when there is a
// pending amount. It never shows `sendable` — a foreign megammr seed reports sendable:0 (the node holds none of its
// keys) even though the coins are real and spendable via sendfrom, so showing sendable made a 655k wallet read "0".
function wwAmount(b) { return esc(b.confirmed) + (b.unconfirmed && String(b.unconfirmed) !== "0" ? `<small>/${esc(b.unconfirmed)}</small>` : ""); }
function wwTokens(q) { q = String(q || "").trim().toLowerCase(); return wwBal.filter(b => !q || wwName(b).toLowerCase().includes(q) || String(b.tokenid).toLowerCase().includes(q)); }
function wwPaintTokens() {
  const list = wwTokens(wwSearch), host = el("wwTokList"); if (!host) return;
  host.innerHTML = list.map(b => `<button class="ww-tok" data-tok="${esc(b.tokenid)}"><span class="ww-tok__ic" aria-hidden="true">${esc(wwName(b).slice(0, 1).toUpperCase())}</span>
      <span class="ww-tok__main"><b>${esc(wwName(b))}</b><span>${wwAmount(b)}</span></span></button>`).join("") || `<p class="ww-p ww-center">${wwBal.length ? "No results found" : "No balance yet for this wallet."}</p>`;
  host.querySelectorAll("[data-tok]").forEach(r => { r.onclick = () => wwTokenDetail(wwBal.find(b => b.tokenid === r.dataset.tok)); });
}
function wwTokenDetail(b) {
  if (!b) return;
  const row = (k, v) => `<div class="ww-drow"><span>${k}</span><b>${v}</b></div>`;
  const d = openDlg("wwTokDlg", wwName(b), `<div class="ww-detail">${b.tokenid === "0x00" ? `<p class="ww-p">Minima's Official Token</p>` : ""}<div class="ww-dbox"><div class="ww-dbox__t">Details</div>
    ${row("Balance", wwAmount(b))}${row("Token ID", `<span class="ww-id">${esc(b.tokenid)}</span>`)}${b.decimals != null ? row("Decimals", esc(String(b.decimals))) : ""}</div></div>`,
    `<button class="dlg__btn" id="wwTokCopy">Copy token ID</button>`);
  if (d) el("wwTokCopy").onclick = () => copy(b.tokenid);
}

function renderWwWallet(body) {
  const a = wwAddr, ku = wwKu || { keyuses: 0, ack: false };
  const recv = a.miniaddress || a.address;
  const tab = (id, label) => `<button class="ww-tab${wwTab === id ? " ww-tab--on" : ""}" role="tab" aria-selected="${wwTab === id}" data-wwtab="${id}">${label}</button>`;
  let page = "";
  if (wwTab === "balance") {
    page = `<h6 class="ww-h6">Tokens</h6><div class="ww-searchrow"><input class="ww-search" id="wwSearch" type="search" placeholder="Search tokens" aria-label="Search tokens" value="${esc(wwSearch)}" autocomplete="off" />
      <button class="ww-round" id="wwRefresh" aria-label="Refresh" title="Refresh">↻</button></div><div class="ww-toks" id="wwTokList"></div>`;
  } else if (wwTab === "receive") {
    let qr = "";
    try { if (typeof qrcode !== "undefined") { const q = qrcode(0, "M"); q.addData(recv); q.make(); qr = `<div class="ww-qr">${q.createImgTag(4, 0)}</div>`; } } catch (e) {}
    page = `${qr}<div class="ww-addr" id="wwAddrBox">${esc(recv)}</div><button class="ww-btn" id="wwCopyAddr">Copy</button>`;
  } else {
    const kuDefault = Math.max(Number(ku.keyuses) || 0, Number(wwKuSuggest) || 0);
    const kuPanel = a.isNodeSeed
      ? `<p class="ww-fine">This is <b>your node's own wallet</b>: the balance is the whole wallet's, across every address. Sends go through the node, which chooses the coins and manages its signing keys itself.</p>`
      : (ku.ack
      ? `<label class="ww-label">Secret key uses</label><div class="ww-kuline"><span>The next send signs at use <b>${esc(String(ku.keyuses))}</b>. The app counts every send and never counts down.</span><button class="ww-link" id="wwKuEdit">Raise it</button></div>`
      : `<div class="ww-safe ww-safe--warn"><b>Confirm the secret key uses before sending.</b> How many payments has this key ALREADY made anywhere (0 for a brand-new key)? A figure that is too high is safe; <b>a figure that is too low can reuse a signing key and lose your funds</b>.${wwKuSuggest > 0 ? ` <b>The chain shows at least ${esc(String(wwKuSuggest))}.</b>` : ""}
           <label class="ww-label" for="wwKuIn">Secret key uses</label><input class="ww-in" id="wwKuIn" type="number" min="0" step="1" placeholder="Amount of times" value="${esc(String(kuDefault))}" />
           <div class="ww-two"><button class="ww-btn ww-btn--dark" id="wwKuCheck">Check on-chain</button><button class="ww-btn" id="wwKuConfirm">Confirm</button></div></div>`);
    const unknown = wwUnknown(a.address), ambig = unknown ? `<div class="ww-safe ww-safe--warn"><b>⚠ The last send's status is UNKNOWN.</b> The node did not confirm it, and the payment may have gone through. Check <b>History</b> and your balance before sending again, or you could pay twice.
        <button class="ww-btn ww-btn--dark" id="wwAmbigClear">I've checked: let me send again</button></div>` : "";
    const off = ((a.isNodeSeed || ku.ack) && !unknown) ? "" : "disabled";
    const toks = wwBal.length ? wwBal : [{ tokenid: "0x00", name: "MINIMA" }];
    page = `<label class="ww-label" for="wwTok">Token</label><select class="ww-in" id="wwTok" ${off}>${toks.map(b => `<option value="${esc(b.tokenid)}"${b.tokenid === wwForm.tok ? " selected" : ""}>${esc(wwName(b))}${b.confirmed != null ? "  (" + esc(b.confirmed) + ")" : ""}</option>`).join("")}</select>
      <label class="ww-label" for="wwAmt">Amount</label><input class="ww-in" id="wwAmt" placeholder="Enter amount" value="${esc(wwForm.amt)}" inputmode="decimal" autocomplete="off" ${off} />
      <label class="ww-label" for="wwTo">Recipient address</label><input class="ww-in" id="wwTo" placeholder="Enter recipient address (Mx or 0x)" value="${esc(wwForm.to)}" autocomplete="off" spellcheck="false" ${off} />
      ${kuPanel}${ambig}<button class="ww-btn" id="wwSendBtn" ${off}>Send</button>`;
  }
  body.innerHTML = wwCard(`<div class="ww-top"><h1 class="ww-h1">Minima Web Wallet</h1><button class="ww-link" id="wwLockBtn">Logout</button></div>
    <div class="ww-tabs" role="tablist">${tab("balance", "Balance")}${tab("send", "Send")}${tab("receive", "Receive")}</div>${page}`);

  body.querySelectorAll("[data-wwtab]").forEach(b => { b.onclick = () => { wwTab = b.dataset.wwtab; wwArmed = false; renderWebWallet(); }; });
  el("wwLockBtn").addEventListener("click", wwLogout);
  const refresh = async () => { wwBal = await api.wwRead(a.address, a.isNodeSeed).catch(() => wwBal); renderWebWallet(); };
  if (wwTab === "balance") {
    wwPaintTokens();
    el("wwSearch").oninput = () => { wwSearch = el("wwSearch").value; wwPaintTokens(); };
    el("wwRefresh").addEventListener("click", refresh);
    return;
  }
  if (wwTab === "receive") { el("wwAddrBox").onclick = el("wwCopyAddr").onclick = () => copy(recv); return; }
  for (const [id, k] of [["wwTo", "to"], ["wwAmt", "amt"], ["wwTok", "tok"]]) el(id).oninput = el(id).onchange = () => { wwForm[k] = el(id).value; };
  const ambigBtn = el("wwAmbigClear"); if (ambigBtn) ambigBtn.addEventListener("click", () => { wwUnknown(wwAddr && wwAddr.address, false); renderWebWallet(); });
  if (a.isNodeSeed) {
    el("wwSendBtn").addEventListener("click", () => wwDoSend());   // node wallet: no key-uses gate, node manages keys
  } else if (!ku.ack) {
    el("wwKuConfirm").addEventListener("click", async () => {
      const n = Math.max(0, Math.floor(Number(el("wwKuIn").value) || 0));
      try { wwKu = await api.wwAckKeyuses(a.address, n); renderWebWallet(); toast("Secret key uses confirmed", "ok"); }
      catch (e) { toast("Could not save the secret key uses", "err"); }
    });
    el("wwKuCheck").addEventListener("click", async () => {
      const btn = el("wwKuCheck"); btn.disabled = true; btn.textContent = "Checking…";
      try {
        const r = await api.keyAudit([a.publickey]);
        const k = r && r.keys && r.keys[0];
        const onchain = k ? Math.max(Number(k.spend_blocks) || 0, Number(k.spent_coins) || 0) : 0;
        const cur = Number(el("wwKuIn").value) || 0;
        el("wwKuIn").value = String(Math.max(cur, onchain));
        toast("On-chain uses: " + onchain + " (set as minimum)", "ok");
      } catch (e) { toast("On-chain check unavailable", "err"); }
      btn.disabled = false; btn.textContent = "Check on-chain";
    });
  } else {
    const ed = el("wwKuEdit"); if (ed) ed.addEventListener("click", () => { wwKu.ack = false; renderWebWallet(); });
    el("wwSendBtn").addEventListener("click", () => wwDoSend());
  }
}
// The original's logout dialog, without showing the secret key back (it is not put on screen again once typed).
async function wwLogout() {
  const ku = wwKu || { keyuses: 0 }, node = wwAddr && wwAddr.isNodeSeed;
  const ok = await showConfirm("Log out of this session", "If you haven't stored your secret key then this is your last chance! It is not kept by this app: after Logout it is gone from memory.\n\n"
    + (node ? "" : "Secret key uses: " + ku.keyuses + "\nWe recommend taking a note of your secret key uses. This should be increased each time you send a transaction."), "Logout", false);
  if (!ok) return;
  wwLock(); renderWebWallet(); toast("Logged out", "ok");
}

async function wwDoSend() {
  const btn = el("wwSendBtn"), f = { seed: wwSeed, to: el("wwTo").value, amount: el("wwAmt").value, tokenid: el("wwTok").value };
  const bad = AppsAct.ww.problem(f); if (bad) { toast(bad, "err"); return; }
  if (wwUnknown(wwAddr && wwAddr.address)) { toast("The last send's status is UNKNOWN. Check History and your balance, then choose \"I've checked\".", "err"); return; }
  if (!wwArmed) {   // two-click confirm — sends are irreversible
    wwArmed = true; btn.textContent = "Click again to confirm: this cannot be undone";
    setTimeout(() => { if (wwArmed) { wwArmed = false; if (btn.isConnected) btn.textContent = "Send"; } }, 4000);
    return;
  }
  wwArmed = false; btn.disabled = true; btn.textContent = "Sending...";
  const from = wwAddr.address;   // the wallet this send leaves: the screen may be logged out before the answer is here
  const r = await AppsAct.ww.send(api, f);
  if (r && r.ok) {
    toast("Your transaction has been successfully sent!" + (r.txnid ? " " + r.txnid : ""), "ok", r.txnid || null);
    wwForm.to = ""; wwForm.amt = "";
    wwKu = await api.wwKeyuses(wwAddr.address).catch(() => wwKu);
    wwBal = await api.wwRead(wwAddr.address, wwAddr.isNodeSeed).catch(() => wwBal);
    renderWebWallet();
  } else if (r && r.ambiguous) {
    // M1: don't offer a one-click retry — surface the unknown state, refresh balances, and gate re-send behind
    // an explicit "I've checked" acknowledgement (renderWwWallet shows the banner while this wallet is in WW_UNKNOWN).
    wwUnknown(from, true);
    toast(r.message || "Send status unknown: check before trying again", "err");
    if (wwAddr) wwBal = await api.wwRead(wwAddr.address, wwAddr.isNodeSeed).catch(() => wwBal);
    renderWebWallet();
  } else {
    toast((r && (r.message || r.err)) || "Send failed", "err");
    btn.disabled = false; btn.textContent = "Send";
  }
}

function renderActive() {
  if (FROZEN.length && thawOnOpen()) return;   // a frozen app that is opened is unfrozen first, then drawn
  if (!running && activeView !== "node") { /* wallet views need the node */ }
  if (activeView === "balances") renderBalances();
  else if (activeView === "receive") renderReceive();
  else if (activeView === "send") renderSend();
  else if (activeView === "webwallet") renderWebWallet();
  else if (activeView === "mail") renderMail();
  else if (activeView === "chat") renderChat();
  else if (activeView === "pandapools" || activeView === "atomix" || activeView === "dexicon") DexUI.render();   // Dexicon rooms ①, ② and ③
  else if (activeView === "ethwallet") renderEthWallet();
  else if (activeView === "minimall") renderMiniMall();
  else if (activeView === "vestr") renderVestr();
  else if (activeView === "parlons") renderParlons();
  else if (activeView === "history") renderHistory();
  else if (activeView === "terminal") renderTerminal();
  else if (activeView === "logs") renderLogs();
  else if (activeView === "settings") renderSettings();
  else if (activeView === "params") renderParams();
  else if (activeView === "backup") renderBackup();
  else if (activeView === "apps") renderApps();
  else if (activeView === "faucet") renderFaucet();
  else if (activeView === "keyuses") renderKeyUses();
  else if (activeView === "node") api.nodeStatus().then(renderNode);
}
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => { if (running && (activeView === "balances")) renderBalances(); }, 15000);
}
function stopRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

// ---- Wallet tab (Pandamonium's BalanceView / BalanceAdapter) ---------------
async function renderBalances() {
  const host = el("balList");
  if (!running) { WAL_DRAG = null; el("walTotal").textContent = NO_FIGURE; WAL_MINIMA = null; paintWalBreakdown(); host.innerHTML = waitHtml(); return; }
  walDragCheck();
  if (WAL_DRAG) return;                                  // a row is being dragged: the 15 s rebuild waits for the drop
  let bal = await tryCmd("balance");
  walDragCheck();
  if (WAL_DRAG) return;                                  // a drag that began while the node was answering: its row must not be rebuilt under it
  // a failed read is not an empty wallet: no old total above it, and no zero row
  if (!bal) { el("walTotal").textContent = NO_FIGURE; WAL_MINIMA = null; paintWalBreakdown(); host.innerHTML = `<div class="empty">The balance could not be read. It is read again every 15 seconds.</div>`; return; }
  await loadHeld();                                      // what the engines hold: left out of every "sendable" below
  BAL_AT = Date.now();                                   // drives the breakdown's "updated ..."
  // The phone always shows a Minima row, at 0 for a wallet that holds nothing yet.
  if (!bal.length) bal = [{ token: "Minima", tokenid: MINIMA, confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0" }];
  BAL_BY_TID = {};
  for (const b of bal) BAL_BY_TID[b.tokenid || MINIMA] = b;
  // "Total balance" is the MINIMA headline, the same sendable figure its row shows.
  WAL_MINIMA = BAL_BY_TID[MINIMA] || { confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0" };
  el("walTotal").textContent = summaryAmount(freeOf(WAL_MINIMA));
  paintWalBreakdown();
  // The list is rebuilt every 15 s. Keyboard focus stays where it was: the same token's row.
  const was = host.contains(document.activeElement) ? document.activeElement.closest(".balrow") : null;
  const wasTid = was && was.dataset.tokenid;
  const order = tokenOrder(store("walletOrder"), bal.map(b => b.tokenid || MINIMA));
  host.innerHTML = order.map(t => balCardHtml(BAL_BY_TID[t])).join("");
  if (was) { const row = [...host.querySelectorAll(".balrow")].find(r => r.dataset.tokenid === wasTid); if (row) row.focus(); }
  initTokenOrder(host);
  host.querySelectorAll(".balrow").forEach(row => {
    row.onclick = () => { const b = BAL_BY_TID[row.dataset.tokenid]; if (b) showCoins(b); };
    row.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); row.click(); } };
  });
  enhanceTokenIcons(host);
}
// HELD FUNDS (0.18.146, docs/COIN_RESERVATION.md): what AtomiX, PandaPools and Dexicon hold of this wallet's coins. The
// node's `sendable` counts them (they are plain coins), but the wallet cannot send them: the figures below leave them
// out and say what holds them. coins: coin id (lower case) -> what holds it; funds: token id (lower case) ->
// { held, free, why }. A read that fails keeps the last answer: nothing new is claimed.
let HELD = { coins: {}, funds: {} };
async function loadHeld() {
  try {
    const r = await api.reserved(), coins = {}, funds = {};
    for (const c of (r && r.coins) || []) coins[String(c.coinid).toLowerCase()] = String(c.why || "another part of the app");
    for (const f of (r && r.funds) || []) funds[String(f.tokenid).toLowerCase()] = f;
    HELD = { coins, funds };
  } catch (e) {}
}
const heldOf = (tid) => HELD.funds[String(tid || MINIMA).toLowerCase()] || null;
/** What the wallet itself can send of this balance row: the node's sendable less what is held (never below 0). */
const freeOf = (b) => { const h = heldOf(b.tokenid || MINIMA); return h ? decSub(b.sendable || "0", h.held) : (b.sendable || "0"); };
const heldLine = (tid) => { const h = heldOf(tid); return h ? "held " + TOK.tidyAmount(h.held) + " for " + h.why : ""; };
let BAL_BY_TID = {};       // tokenid → last balance row, so a row click can open its dialog without refetching
let BAL_AT = 0;            // when the last `balance` reply landed: the breakdown's "updated ..."
let WAL_MINIMA = null;     // the MINIMA balance row behind "Total balance" (null: not read)
let WAL_DRAG = null;       // the token row being dragged
// A drag whose row is no longer on the page has ended, whether or not its dragend came: without this a lost
// dragend would leave WAL_DRAG set and every later refresh would return early, freezing the Wallet on old figures.
function walDragCheck() { if (WAL_DRAG && !WAL_DRAG.isConnected) WAL_DRAG = null; }

// The saved token order, as the phone's TokenOrder.decode: Minima is pinned first, then the saved ids that
// are still held (each once), then anything new at the end, so a token just received never goes missing.
function tokenOrder(saved, present) {
  const order = present.includes(MINIMA) ? [MINIMA] : [];
  for (const t of String(saved || "").split(",")) if (present.includes(t) && !order.includes(t)) order.push(t);
  for (const t of present) if (!order.includes(t)) order.push(t);
  return order;
}
// Token rows drag into a new order, or move with Alt+Up / Alt+Down; Up / Down walk the rows. Minima stays first.
// A token that is no longer held drops out of the saved order when the order is next saved, as on the phone.
function initTokenOrder(host) {
  const rows = () => [...host.querySelectorAll(".balrow")];
  const save = () => store("walletOrder", rows().map(r => r.dataset.tokenid).filter(t => t !== MINIMA).join(","));
  rows().forEach(r => {
    if (r.dataset.tokenid === MINIMA) return;
    r.draggable = true;
    r.title = "Drag to reorder, or Alt+Up / Alt+Down";
    r.addEventListener("dragstart", (e) => { WAL_DRAG = r; r.classList.add("balrow--drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.dataset.tokenid); });
    r.addEventListener("dragend", () => { r.classList.remove("balrow--drag"); WAL_DRAG = null; save(); });
    r.addEventListener("dragover", (e) => {
      if (!WAL_DRAG || WAL_DRAG === r) return;
      e.preventDefault();
      const box = r.getBoundingClientRect();
      host.insertBefore(WAL_DRAG, e.clientY < box.top + box.height / 2 ? r : r.nextSibling);
    });
  });
  host.ondragover = (e) => { if (WAL_DRAG) e.preventDefault(); };   // a drop anywhere on the list lands where the row already is
  host.onkeydown = (e) => {
    const r = e.target.closest(".balrow"); if (!r || e.target !== r || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const all = rows(), up = e.key === "ArrowUp", to = all[all.indexOf(r) + (up ? -1 : 1)];
    if (!e.altKey) { if (to) to.focus(); return; }
    if (r.dataset.tokenid === MINIMA || !to || to.dataset.tokenid === MINIMA) return;
    host.insertBefore(r, up ? to : to.nextSibling); r.focus(); save();
  };
}

/** Display only: at most six decimals, cut off and never rounded up (the phone's Format.summaryAmount).
 *  The exact figure is in the token's coins dialog. A real balance is never shown as zero. */
function summaryAmount(s) {
  s = String(s == null ? "" : s).trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m) return s || "0";
  const int = (m[2] || "0").replace(/^0+(?=\d)/, ""), frac = m[3] || "";
  if (/^0*$/.test(int + frac)) return "0";
  const cut = frac.slice(0, 6).replace(/0+$/, "");
  if (int === "0" && !cut) return m[1] ? ">-0.000001" : "<0.000001";
  return m[1] + int + (cut ? "." + cut : "");
}
/** "now", "31 minutes ago", "1 hour ago", "3 days ago": how the phone says how long ago. */
function since(ms) {
  const d = Math.max(0, Date.now() - ms), n = (v, unit) => v + " " + unit + (v === 1 ? "" : "s") + " ago";
  if (d < 60000) return "now";
  if (d < 3600000) return n(Math.floor(d / 60000), "minute");
  if (d < 86400000) return n(Math.floor(d / 3600000), "hour");
  return n(Math.floor(d / 86400000), "day");
}
function coinCount(n) { n = parseInt(n, 10) || 0; return n + (n === 1 ? " coin" : " coins"); }

/** What makes up the header number, behind the expand arrow (collapsed by default, as the phone). */
function paintWalBreakdown() {
  const b = WAL_MINIMA, box = el("walBreakdown");
  box.textContent = !b ? "Node not connected"
    : `confirmed ${summaryAmount(b.confirmed || "0")}  ·  locked ≈ ${summaryAmount(decSub(b.confirmed || "0", b.sendable || "0"))}`
      + (heldLine(MINIMA) ? "  ·  " + heldLine(MINIMA) : "")
      + `  ·  unconfirmed ${summaryAmount(b.unconfirmed || "0")}  ·  ${coinCount(b.coins)}  ·  updated ${since(BAL_AT)}  ·  click a token for coins`;
}
function toggleWalBreakdown() {
  const box = el("walBreakdown"), show = box.hidden;
  paintWalBreakdown();
  box.hidden = !show;
  el("walHead").setAttribute("aria-expanded", show ? "true" : "false");
  el("walHead").setAttribute("aria-label", show ? "Hide balance details" : "Show balance details");
}

/** Is this balance row a 1-of-1 NFT? (non-Minima, total supply 1, no fractional decimals) */
function isNftBal(b) {
  return b.tokenid && b.tokenid !== MINIMA && String(b.total) === "1"
    && (!b.token || !b.token.decimals || String(b.token.decimals) === "0");
}

// One token row, as the phone's view_balance_row: icon tile with the validated badge, name, amount, and one
// faint line with whatever the amount leaves out ("4 coins", "locked 20 · 20 coins"). Nothing else.
function balCardHtml(b) {
  const tid = b.tokenid || MINIMA, isNative = tid === MINIMA;
  const cached = ICON_CACHE.get(tid);
  let iconCell;
  if (isNative) {
    iconCell = `<span class="tok-wrap"><img class="tok-icon tok-icon--native" src="icons/minima.svg" alt=""><span class="tok-badge">✓</span></span>`;
  } else {
    const identicon = TOK.identiconDataUri(tid);
    const res = TOK.resolveIcon(TOK.pickIconField(b.token));
    const src = (cached && cached.icon) || res.data || identicon;
    const showBadge = cached && cached.valid;
    iconCell = `<span class="tok-wrap" data-tokenid="${esc(tid)}" data-identicon="${esc(identicon)}"`
      + (res.data ? ` data-icon-data="${esc(res.data)}"` : "")
      + (res.remote ? ` data-icon-remote="${esc(res.remote)}"` : "")
      + (TOK.webvalidateUrl(b.token) ? ` data-webv="1"` : "")
      + `><img class="tok-icon" src="${esc(src)}" alt=""><span class="tok-badge"${showBadge ? "" : " hidden"}>✓</span></span>`;
  }
  // The amount is SENDABLE: what can be spent. `confirmed` also counts coins locked in scripts and pools.
  const sendable = b.sendable || "0", confirmed = b.confirmed || "0";   // balance.java always emits both; guard so a malformed row can't blank the whole list
  const positive = (v) => /[1-9]/.test(String(v || "")) && !String(v).startsWith("-");
  const locked = decSub(confirmed, sendable), parts = [], free = freeOf(b);   // free: less what the engines hold
  if (positive(locked)) parts.push("locked " + summaryAmount(locked));
  if (heldLine(tid)) parts.push(heldLine(tid));
  if (positive(b.unconfirmed)) parts.push("unconfirmed " + summaryAmount(b.unconfirmed));
  if (parseInt(b.coins, 10) > 0) parts.push(coinCount(b.coins));
  return `<div class="balrow" data-tokenid="${esc(tid)}" tabindex="0" role="button">
    ${iconCell}
    <div class="balrow__main">
    <div class="balrow__top"><span class="balrow__name">${esc(TOK.tokenName(b.token, tid))}</span><span class="balrow__amt">${esc(summaryAmount(free))}</span></div>
    ${parts.length ? `<div class="bal-breakdown">${esc(parts.join("  ·  "))}</div>` : ""}
    </div>
  </div>`;
}

// After paint: swap in real icons (inline data → now; http/ipfs → SSRF-guarded main fetch) + validation badge
// (node `tokenvalidate`). Per-tokenid cache means the 15s refresh does zero network work for seen tokens.
async function enhanceTokenIcons(root) {
  const pending = [];
  for (const w of root.querySelectorAll(".tok-wrap[data-tokenid]")) {
    const cached = ICON_CACHE.get(w.dataset.tokenid);
    if (cached) applyIcon(w, cached); else pending.push(w);
  }
  let i = 0;   // small concurrency cap: each uncached token may trigger a server-side tokenvalidate GET
  const worker = async () => {
    while (i < pending.length) {
      const w = pending[i++], tid = w.dataset.tokenid;
      if (ICON_CACHE.has(tid)) { applyIcon(w, ICON_CACHE.get(tid)); continue; }
      const entry = { icon: null, valid: null };
      if (w.dataset.iconData) entry.icon = w.dataset.iconData;
      else if (w.dataset.iconRemote) { try { entry.icon = await api.tokenIcon(w.dataset.iconRemote); } catch (e) {} }
      if (w.dataset.webv && validTok(tid)) { try { const r = await cmd(`tokenvalidate tokenid:${tid}`); entry.valid = !!(r && r.web && r.web.valid); } catch (e) { entry.valid = false; } }
      ICON_CACHE.set(tid, entry);
      applyIcon(w, entry);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
function applyIcon(w, e) {
  if (e.icon) { const img = w.querySelector("img"); if (img) { img.onerror = () => { img.onerror = null; img.src = w.dataset.identicon; }; img.src = e.icon; } }
  if (e.valid) { const badge = w.querySelector(".tok-badge"); if (badge) badge.hidden = false; }
}

// ---- Token detail modal (rich, mirrors the official/utxoWallet token view) --
/** Consolidate one token's coins: say what will happen, check the pool owner keys, then run the node's own command.
 *  The confirmation and the owner-key check are PandaPools' (WalletTools.showConsolidate, checkConsolidation). */
async function consolidateToken(tid, name) {
  if (!validTok(tid)) { toast("Token id must be a 0x… hex value.", "err"); return false; }
  const cmdText = "consolidate tokenid:" + tid;
  if (!await showConfirm("Consolidate " + name + "?",
        "Combine your " + name + " wallet coins into fewer, larger ones?\n\nMinimaCore selects the coins itself with its standard consolidation command. Only spendable coins are merged. No burn fee.\n\n" + cmdText,
        "Consolidate", false)) return false;
  const why = await api.ppConsolidationCheck();
  if (why) { await showConfirm("Not consolidated", why, "OK", false); return false; }
  await cmd(cmdText);
  toast("Consolidation submitted ✓ Coins merge over the next blocks.", "ok");
  return true;
}
let SEND_PRESELECT = null;   // tokenid to preselect in the Send tab (set by the modal's Send action)

/** Group the integer part of a decimal string with thousands separators (display only). */
function groupThousands(s) {
  s = String(s == null ? "" : s);
  const [int, frac] = s.split(".");
  const g = (int || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? g + "." + frac : g;
}
/** Hostname for a link label; returns "" if it doesn't parse as http(s). */
function hostOf(url) {
  try { const u = new URL(String(url)); return (u.protocol === "http:" || u.protocol === "https:") ? u.host : ""; }
  catch (e) { return ""; }
}
/** Only render an http(s) link; anything else is shown as inert text (no javascript:/data: hrefs). */
function safeLinkRow(label, url) {
  const host = hostOf(url);
  if (!host) return url ? `<div class="kv"><span class="kv__k">${esc(label)}</span><span class="kv__v tokd-wrap">${esc(url)}</span></div>` : "";
  return `<div class="kv"><span class="kv__k">${esc(label)}</span><a class="kv__v tokd-link" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(host)} ↗</a></div>`;
}

async function showTokenDetail(b) {
  const tid = b.tokenid || MINIMA;
  const isNative = tid === MINIMA;
  const name = TOK.tokenName(b.token, tid);
  const nft = isNftBal(b);
  const sendable = b.sendable || "0";
  const locked = decSub(b.confirmed || "0", sendable);
  const tick = isNative ? "MINIMA" : (TOK.ticker(b.token) || "");
  const desc = isNative ? "The native coin of the Minima blockchain." : TOK.metaField(b.token, "description");
  const owner = isNative ? "" : TOK.metaField(b.token, "owner");
  const website = isNative ? "" : TOK.metaField(b.token, "external_url");
  const webv = TOK.webvalidateUrl(b.token);
  const supply = isNative ? "1,000,000,000" : groupThousands(b.total);
  const coins = parseInt(b.coins, 10) || 0;

  // Large icon reuses the exact resolve/cache/validate path as the balance list.
  const cached = ICON_CACHE.get(tid);
  let heroIcon;
  if (isNative) {
    heroIcon = `<span class="tok-wrap tok-wrap--lg"><img class="tok-icon tok-icon--lg tok-icon--native" src="minima-mark.svg" alt=""><span class="tok-badge">✓</span></span>`;
  } else {
    const identicon = TOK.identiconDataUri(tid);
    const res = TOK.resolveIcon(TOK.pickIconField(b.token));
    const src = (cached && cached.icon) || res.data || identicon;
    const showBadge = cached && cached.valid;
    heroIcon = `<span class="tok-wrap tok-wrap--lg" data-tokenid="${esc(tid)}" data-identicon="${esc(identicon)}"`
      + (res.data ? ` data-icon-data="${esc(res.data)}"` : "")
      + (res.remote ? ` data-icon-remote="${esc(res.remote)}"` : "")
      + (webv ? ` data-webv="1"` : "")
      + `><img class="tok-icon tok-icon--lg" src="${esc(src)}" alt=""><span class="tok-badge"${showBadge ? "" : " hidden"}>✓</span></span>`;
  }

  // extraMetadata: every custom key on the token (or its nested name-object) that isn't one of the known
  // fields — mirrors the official wallet, so arbitrary token attributes are still surfaced.
  const KNOWN = new Set(["name", "url", "icon", "description", "owner", "external_url", "webvalidate", "ticker", "decimals"]);
  const tokObj = (b.token && typeof b.token === "object") ? (b.token.name && typeof b.token.name === "object" ? b.token.name : b.token) : null;
  let extraRows = "";
  if (tokObj) for (const [k, v] of Object.entries(tokObj)) {
    if (KNOWN.has(k) || v == null || typeof v === "object") continue;
    extraRows += `<div class="kv"><span class="kv__k">${esc(k)}</span><span class="kv__v tokd-wrap">${esc(String(v))}</span></div>`;
  }

  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="tokDetail"><div class="modal modal--token">
    <div class="tokd-hero">
      ${heroIcon}
      <div class="tokd-name">${esc(name)}${nft ? " · NFT" : (isNative ? "" : " · token")}</div>
      ${desc ? `<div class="tokd-desc">${esc(desc)}</div>` : ""}
    </div>
    <div class="kv"><span class="kv__k">Spendable</span><span class="kv__v kv__v--green">${esc(TOK.tidyAmount(freeOf(b)))}${tick ? " " + esc(tick) : ""}</span></div>
    ${heldOf(tid) ? `<div class="kv"><span class="kv__k">Held</span><span class="kv__v">${esc(TOK.tidyAmount(heldOf(tid).held))} for ${esc(heldOf(tid).why)}</span></div>` : ""}
    ${locked !== "0" ? `<div class="kv"><span class="kv__k">🔒 Locked</span><span class="kv__v">${esc(TOK.tidyAmount(locked))}</span></div>` : ""}
    ${b.unconfirmed && b.unconfirmed !== "0" ? `<div class="kv"><span class="kv__k">Pending</span><span class="kv__v kv__v--amber">${esc(TOK.tidyAmount(b.unconfirmed))}</span></div>` : ""}
    <div class="kv"><span class="kv__k">Coins</span><span class="kv__v">${coins}</span></div>
    <div class="kv"><span class="kv__k">Supply</span><span class="kv__v">${esc(supply)}</span></div>
    <div class="kv" id="tokdDec" hidden><span class="kv__k">Decimals</span><span class="kv__v"></span></div>
    ${owner ? `<div class="kv"><span class="kv__k">Owner</span><span class="kv__v tokd-wrap">${esc(owner)}</span></div>` : ""}
    <div class="view__sub">Token ID</div>
    <div class="kv__v tokd-id" id="tokdId" title="click to copy">${esc(tid)}</div>
    ${safeLinkRow("Website", website)}
    ${safeLinkRow("Validation", webv)}
    ${extraRows}
    <div class="seg" style="margin-top:12px">
      <button class="btn btn--outline btn--full" id="tokdReceive">Receive</button>
      <button class="btn btn--primary btn--full" id="tokdSend">Send ${esc(tick || name)}</button>
    </div>
    <button class="btn btn--outline btn--full" id="tokdClose" style="margin-top:8px">Close</button>
  </div></div>`);

  const close = () => { const o = el("tokDetail"); if (o) o.remove(); };
  const leave = () => { close(); const c = el("coinsDlg"); if (c) c.remove(); };   // opened from the coins dialog: going to Send or Receive closes both
  el("tokdClose").onclick = close;
  el("tokDetail").onclick = (e) => { if (e.target.id === "tokDetail") close(); };
  el("tokdId").onclick = () => copy(tid);
  el("tokdReceive").onclick = () => { leave(); selectTab("receive"); };
  el("tokdSend").onclick = () => { leave(); SEND_PRESELECT = tid; selectTab("send"); };
  enhanceTokenIcons(el("tokDetail"));   // swap in the real icon + validated badge (reused path)

  // Decimals (tokens only) — best-effort background enrich, never blocks the modal.
  if (!isNative && validTok(tid)) {
    cmd(`balance tokendetails:true tokenid:${tid}`).then(r => {
      const row = Array.isArray(r) ? r[0] : r;
      const dec = row && row.details && row.details.decimals;
      const box = el("tokdDec");
      if (box && dec != null && dec !== "") { box.querySelector(".kv__v").textContent = String(dec); box.hidden = false; }
    }).catch(() => {});
  }
}

/** The shared PandaPools discovery beacon address ("PANDAPOOLS" in hex). Dust coins here are registry
 *  beacons, not spendable liquidity — worth naming so they don't read as unexplained locked funds. */
const PANDA_SENTINEL = "0x50414E4441504F4F4C53";

// ---- dialogs in the phone's shape: a title, a body, and text buttons along the bottom ----
// Escape and a click outside close the top one; focus goes back to whatever opened it. One of each at a time:
// asked for again while it is open, it returns null and nothing is added. Tab stays inside (modalTab).
function openDlg(id, title, bodyHtml, buttonsHtml) {
  if (document.querySelectorAll("#" + id).length) return null;
  const opener = document.activeElement;
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay overlay--dlg" id="${id}" data-modal><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="${id}Title" tabindex="-1">
    <h2 class="dlg__title" id="${id}Title">${esc(title)}</h2>
    <div class="dlg__body">${bodyHtml}</div>
    <div class="dlg__btns">${buttonsHtml}<span class="dlg__gap"></span><button class="dlg__btn" data-close>Close</button></div></div></div>`);
  const root = el(id);
  const close = () => { if (!root.isConnected) return; root.remove(); if (opener && opener.isConnected) opener.focus(); };
  root.onclick = (e) => { if (e.target === root || e.target.closest("[data-close]")) close(); };
  root.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  root.querySelector(".dlg").focus();
  return { root, close };
}
// Tab and Shift+Tab stay inside the dialog on top, when that dialog is one marked data-modal (the coins dialog,
// a coin's detail, Split, and every confirm). Without this, focus stayed on the button underneath and Enter
// opened a second copy over the first.
function modalTab(e) {
  if (e.key !== "Tab") return;
  const open = document.querySelectorAll("body > .overlay"), top = open[open.length - 1];
  if (!top || !top.hasAttribute("data-modal")) return;
  const stops = [...top.querySelectorAll("button, input, select, textarea, [tabindex]")].filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
  const at = stops.indexOf(document.activeElement);
  if (!stops.length) { e.preventDefault(); return; }
  if (e.shiftKey ? at <= 0 : at < 0 || at === stops.length - 1) { e.preventDefault(); stops[e.shiftKey ? stops.length - 1 : 0].focus(); }
}
document.addEventListener("keydown", modalTab, true);

/**
 * Every coin behind a token balance (the phone's CoinsDialog). ALL relevant coins are listed, the ones locked
 * in a contract included, because seeing what makes confirmed larger than sendable is the point. No coin id
 * is shortened. A coin opens its full detail. Split and Consolidate, the desktop's own, are two buttons here.
 */
async function showCoins(b) {
  const tid = b.tokenid || MINIMA, isNative = tid === MINIMA, name = TOK.tokenName(b.token, tid);
  const sendable = b.sendable || "0", confirmed = b.confirmed || "0", locked = decSub(confirmed, sendable);
  await loadHeld();
  const head = `sendable ${TOK.tidyAmount(freeOf(b))}` + (heldLine(tid) ? `  ·  ${heldLine(tid)}` : "") + (locked !== "0" ? `  ·  locked ${TOK.tidyAmount(locked)}` : "") + `  ·  confirmed ${TOK.tidyAmount(confirmed)}`;
  const canSplit = !isNftBal(b) && Number(sendable) > 0;
  const d = openDlg("coinsDlg", name + " coins",
    `<div class="coins-head">${esc(head)}</div>
     <div class="coins-status" id="coinsStatus">Reading coins…</div>
     <div class="coins-list" id="coinsList" hidden></div>
     <div class="coins-foot" id="coinsFoot" hidden></div>
     <div class="coins-tools" id="coinsTools"${canSplit ? "" : " hidden"}>
       <button class="btn btn--outline" id="coinsSplit"${canSplit ? "" : " hidden"} title="Split some of this into several equal coins, so you can make several sends without waiting for change">Split</button>
       <button class="btn btn--outline" id="coinsConsolidate" hidden>Consolidate</button>
     </div>`,
    `<button class="dlg__btn" id="coinsCopyTid">Copy token ID</button>${isNative ? "" : `<button class="dlg__btn" id="coinsTokInfo">Token details</button>`}`);
  if (!d) return;                                                    // this dialog is already open
  el("coinsCopyTid").onclick = () => copy(tid);                      // the whole token id; the dialog stays open
  if (el("coinsTokInfo")) el("coinsTokInfo").onclick = () => showTokenDetail(b);
  el("coinsSplit").onclick = () => splitDialog(tid, name);
  el("coinsConsolidate").onclick = async () => {
    const btn = el("coinsConsolidate"); btn.disabled = true;
    try { await consolidateToken(tid, name); }
    catch (e) { toast(e.message, "err"); }
    btn.disabled = false;
  };
  const status = (text, kind) => { const s = el("coinsStatus"); if (!s) return; s.textContent = text; s.className = "coins-status" + (kind ? " coins-status--" + kind : ""); s.hidden = false; };
  if (!validTok(tid)) { status("Invalid token ID. Refresh the balance before sending.", "bad"); return; }   // tid is node-sourced, but never interpolate an unvalidated value into a command
  if (!running) { status("Node not started. No coin data yet.", "warn"); return; }
  // Two reads: every relevant coin, then the sendable ones. The node's coin JSON carries no "sendable" flag,
  // so the LOCKED chips come from the difference. If the second read fails nothing is claimed either way:
  // no chips, no "sendable" in a coin's detail, and the footer says the check could not be made.
  // The balance is read before and after, for the footer: confirmed plus unconfirmed is what these coins add up to.
  const balTotal = async () => { try { const row = (await cmd("balance")).find(x => (x.tokenid || MINIMA) === tid); return row ? decAdd(row.confirmed || "0", row.unconfirmed || "0") : "0"; } catch (e) { return null; } };
  let all, sendableIds = null;
  const before = await balTotal();
  try { all = await cmd(`coins relevant:true tokenid:${tid} simplestate:false`) || []; }
  catch (e) { if (d.root.isConnected) status("Coins query failed: " + (e.message || String(e)), "bad"); return; }   // a failed read is not an empty wallet
  try { sendableIds = new Set((await cmd(`coins relevant:true sendable:true tokenid:${tid} simplestate:false`) || []).map(c => c.coinid)); } catch (e) {}
  const after = await balTotal();
  // Pool covenant addresses this install knows about, so a reserve coin can be named as such.
  const poolAddrs = new Set();
  try {
    for (const p of (await api.ppPools()) || []) {
      if (p.address) poolAddrs.add(String(p.address).toLowerCase());
      if (p.mxaddress) poolAddrs.add(String(p.mxaddress).toLowerCase());
    }
  } catch (e) { /* Pools engine not up: coins still list, without the pool tag */ }
  if (!d.root.isConnected) return;                                   // closed while the node was answering
  if (!all.length) { status("No coins for this token."); return; }
  const amountOf = (c) => String(isNative ? (c.amount || "0") : (c.tokenamount || c.amount || "0"));
  const isSendable = (c) => (sendableIds ? sendableIds.has(c.coinid) : null);   // null: not known, and never shown as "sendable"
  const heldWhy = (c) => HELD.coins[String(c.coinid || "").toLowerCase()] || "";
  const tagOf = (c) => {
    const ad = String(c.address || "").toLowerCase(), mx = String(c.miniaddress || "").toLowerCase();
    if ((ad && poolAddrs.has(ad)) || (mx && poolAddrs.has(mx))) return `<span class="coin-chip">POOL</span>`;
    if (ad === PANDA_SENTINEL.toLowerCase()) return `<span class="coin-chip">BEACON</span>`;
    const why = heldWhy(c);   // held by AtomiX, PandaPools or Dexicon: said in plain words on the row, not only in a tooltip
    if (why) return `<span class="coin-chip coin-chip--locked">HELD</span><span class="coin-held">${esc(why)}</span>`;
    return "";
  };
  const list = el("coinsList");
  list.innerHTML = all.map((c, i) => `<div class="coin-row" data-i="${i}" tabindex="0" role="button">
      <div class="coin-row__top"><span class="coin-amt">${esc(TOK.tidyAmount(amountOf(c)))}</span>${isSendable(c) === false ? `<span class="coin-chip coin-chip--locked">LOCKED</span>` : ""}${tagOf(c)}</div>
      <div class="coin-row__cid">${esc(String(c.coinid || ""))}</div>
    </div>`).join("");
  list.querySelectorAll(".coin-row").forEach(r => {
    r.onclick = () => { const c = all[parseInt(r.dataset.i, 10)]; showCoinDetail(c, isSendable(c), heldWhy(c)); };
    r.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.click(); } };
  });
  el("coinsStatus").hidden = true; list.hidden = false;
  let sum = "0"; for (const c of all) { try { sum = decAdd(sum, amountOf(c)); } catch (e) {} }
  const foot = el("coinsFoot"), said = coinsFootText(all.length, sendableIds ? all.filter(c => !sendableIds.has(c.coinid)).length : null, sum, before, after);
  foot.textContent = said.text;
  foot.classList.toggle("coins-foot--warn", said.warn);
  foot.hidden = false;
  // Consolidate merges SPENDABLE coins only, so it is offered when there are at least two of them.
  if (sendableIds && all.filter(c => sendableIds.has(c.coinid)).length >= 2) { el("coinsConsolidate").hidden = false; el("coinsTools").hidden = false; }
}

// The coins dialog's footer. The coins listed are every relevant coin, the ones under three confirmations
// included, so their sum is compared with confirmed plus unconfirmed from a `balance` read now, not with the
// confirmed figure the Wallet tab had when the dialog opened (that showed a false warning after every receive
// and Split). The warning needs two balance reads, one each side of the coins read, that agree with each other:
// a failed read, or a block landing in between, shows no warning.
function coinsFootText(count, locked, sum, before, after) {
  const warn = before != null && after != null && absCmp(before, after) === 0 && absCmp(sum, after) !== 0;
  return { warn, text: coinCount(count) + "  ·  " + (locked == null ? "locked coins could not be checked" : "Locked: " + locked) + "  ·  sum " + TOK.tidyAmount(sum)
    + (warn ? `\n⚠ These coins add up to ${TOK.tidyAmount(sum)}. The balance, confirmed and unconfirmed, is ${TOK.tidyAmount(after)}.` : "") };
}

/** Everything the node knows about one coin (the phone's CoinDetailDialog). No value is shortened and each
 *  has its own Copy: an id that comes out of here must go back into `coins coinid:` byte for byte.
 *  sendable is true, false, or null when the sendable read failed: then nothing is claimed either way. */
function showCoinDetail(c, sendable, held) {
  const state = (c.state == null || (Array.isArray(c.state) ? !c.state.length : (typeof c.state === "object" ? !Object.keys(c.state).length : c.state === "")))
    ? "(none)" : (typeof c.state === "string" ? c.state : JSON.stringify(c.state, null, 2));
  const rows = [["Coin ID", c.coinid], ["Amount", c.amount], ["Token amount", c.tokenamount], ["Token ID", c.tokenid], ["Address", c.address],
    ["Mini address", c.miniaddress], ["Sendable", sendable == null ? null : held ? "not by the wallet while it is held" : sendable ? "yes" : "no, locked in a contract"], ["Held for", held || null], ["Created", c.created], ["Age", c.age],
    ["MMR entry", c.mmrentry], ["Spent", c.spent], ["Store state", c.storestate], ["State", state]]
    .filter(([, v]) => v != null && String(v) !== "" && String(v) !== "null").map(([k, v]) => [k, String(v)]);
  const raw = JSON.stringify(c, null, 2);
  const d = openDlg("coinDlg", sendable == null ? "Coin" : held ? "Coin, held" : sendable ? "Coin, sendable" : "Coin, locked",
    (sendable == null ? `<div class="coins-status coins-status--warn">Whether this coin is sendable could not be checked.</div>` : "") + rows.map(([k, v], i) => `<div class="cd-row"><div class="eyebrow">${esc(k)}</div>
        <div class="cd-row__line"><div class="cd-row__v">${esc(v)}</div><button class="dlg__btn dlg__btn--sm" data-i="${i}" aria-label="Copy ${esc(k)}">COPY</button></div></div>`).join("")
      + `<div class="eyebrow cd-raw-h">Raw JSON</div><pre class="cd-raw">${esc(raw)}</pre>`,
    `<button class="dlg__btn" id="coinCopyJson">Copy JSON</button>`);
  if (!d) return;                                                    // a coin's detail is already open
  d.root.querySelectorAll(".cd-row [data-i]").forEach(b => b.onclick = () => copy(rows[parseInt(b.dataset.i, 10)][1]));
  el("coinCopyJson").onclick = () => copy(raw);
}

/** Split one token's own coins into equal pieces. The form and its checks are the Send screen's old Split
 *  form (0.18.65), moved here; the token is the one whose coins dialog opened it. */
function splitDialog(tok, name) {
  if (document.querySelectorAll("#splitOv").length) return;          // one Split dialog at a time
  const opener = document.activeElement;
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="splitOv" data-modal><div class="modal" role="dialog" aria-modal="true" aria-labelledby="spTitle">
    <div class="modal__title" id="spTitle">Split ${esc(name)}</div>
    <div class="view__desc">Split your own coins into equal pieces (useful for parallel sends).</div>
    <div class="field"><div class="field__label">Amount to split</div><input class="field__input" id="spAmt" placeholder="0.0" /></div>
    <div class="field"><div class="field__label">Into how many coins (2 to 20)</div><input class="field__input" id="spN" value="10" /></div>
    <div class="seg"><button class="btn btn--outline btn--full" id="spCancel">Cancel</button><button class="btn btn--primary btn--full" id="spGo">Split</button></div></div></div>`);
  const ov = el("splitOv"), go = el("spGo"), cancel = el("spCancel");
  let busy = false;                                                  // a split is with the node: no close and no second submit until it answers
  const close = () => { if (busy) return; ov.remove(); if (opener && opener.isConnected) opener.focus(); };
  cancel.onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  el("spAmt").focus();                                               // focus leaves the Split button underneath; Tab stays in here (modalTab)
  go.onclick = async () => {
    if (busy) return;
    const amt = el("spAmt").value.trim(), n = parseInt(el("spN").value, 10) || 0;
    if (!validAmt(amt)) { toast("Enter a positive amount (digits only).", "err"); return; }
    if (n < 2 || n > 20) { toast("Split into 2 to 20 coins."); return; }
    if (!validTok(tok)) { toast("Token id must be a 0x… hex value.", "err"); return; }
    busy = true; go.disabled = cancel.disabled = true;
    let sent = false;
    try { const a = await cmd("getaddress"); const addr = a.miniaddress || a.address;
      await cmd(`send address:${addr} amount:${amt} split:${n}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : "")); toast("Split ✓", "ok"); sent = true; }
    catch (e) { toast(e.message, "err"); }
    busy = false; go.disabled = cancel.disabled = false;             // the buttons held above, not looked up again: after a split the dialog is gone
    if (sent) close();
  };
}

// ---- Receive (Pandamonium's ReceiveView) -----------------------------------
// "Get Address" asks the node for one of the wallet's existing default addresses (`getaddress`), as the phone
// does. It used to run `newaddress`, which made the node create and store a new key on every press.
let RECV_ADDR = null;        // the address on show; kept while the app runs, as the phone keeps it between visits
async function renderReceive() {
  el("recvCopy").onclick = () => { if (RECV_ADDR) copy(RECV_ADDR); };
  el("recvGet").onclick = getRecvAddress;
  if (!running) {
    RECV_ADDR = null; drawQR(""); el("recvLabelBox").innerHTML = "";
    el("recvAddr").textContent = nodeState === "stopped" ? "The node is stopped." : "Waiting for the node…";
    return;
  }
  if (RECV_ADDR) setRecv(RECV_ADDR); else await getRecvAddress();
}
async function getRecvAddress() {
  const btn = el("recvGet"); btn.disabled = true;
  const r = await tryCmd("getaddress");
  btn.disabled = false;
  const addr = r && (r.miniaddress || r.address);
  if (addr) setRecv(addr);
  else if (RECV_ADDR) toast("The node did not give an address. The one shown is still yours.", "err");
  else el("recvAddr").textContent = "The address could not be read. Press Get Address to try again.";
}
function setRecv(addr) {
  RECV_ADDR = addr;
  el("recvAddr").textContent = addr;
  drawQR(addr);
  renderRecvLabel(addr);
}
// The desktop's own addition, under the phone's layout: a name for this address, shown in History and its exports.
function renderRecvLabel(addr) {
  el("recvLabelBox").innerHTML = `<label class="field__label" for="recvLabelIn">Label this address (optional)</label>
    <div class="seg"><input class="field__input" id="recvLabelIn" placeholder="e.g. Savings" value="${esc(labelFor(addr))}" />
      <button class="btn btn--outline btn--sm" id="recvLabelSave">Save</button></div>`;
  el("recvLabelSave").onclick = async () => {
    const name = el("recvLabelIn").value.trim();
    const labels = Object.assign({}, CFG.labels);
    if (name) labels[addr] = name; else delete labels[addr];
    CFG = await api.saveConfig({ labels });
    toast(name ? "Label saved ✓" : "Label removed", "ok");
  };
}
function drawQR(text) {
  const host = el("qr"); host.innerHTML = "";
  if (!text || text.indexOf("0x") === 0 && text.length < 5 || typeof qrcode === "undefined") return;
  try { const qr = qrcode(0, "M"); qr.addData(text); qr.make(); host.innerHTML = qr.createImgTag(6, 24); host.querySelector("img").alt = "Receive QR code"; }
  catch (e) { /* address too long for one QR — the copyable text still works */ }
}

// ---- shared dialogs + progress/result modals (every panel uses these, not just Mail) ---------------------
// ---- small reusable dialogs (action sheet / prompt / confirm) --------------
function showActionSheet(title, items, message, onCancel) {
  const rows = items.map((it, i) => `<button class="btn ${it.danger ? "btn--danger" : "btn--outline"} btn--full" data-i="${i}" style="margin-top:6px">${esc(it.label)}</button>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="sheetOv"><div class="modal">
    <div class="modal__title">${esc(title)}</div>${message ? `<div class="view__desc">${esc(message)}</div>` : ""}${rows}
    <button class="btn btn--outline btn--full" id="sheetCancel" style="margin-top:12px">Cancel</button></div></div>`);
  const ov = el("sheetOv"); const close = () => { if (ov) ov.remove(); };
  const cancel = () => { close(); if (onCancel) onCancel(); };
  ov.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => { close(); const it = items[parseInt(b.dataset.i, 10)]; if (it && it.onclick) it.onclick(); });
  el("sheetCancel").onclick = cancel;
  ov.onclick = (e) => { if (e.target.id === "sheetOv") cancel(); };
}
function showPrompt(title, initial, placeholder, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="promptOv"><div class="modal">
      <div class="modal__title">${esc(title)}</div>
      ${opts.message ? `<div class="view__desc">${esc(opts.message)}</div>` : ""}
      <input class="field__input" id="promptInput" type="${opts.password ? "password" : "text"}" value="${esc(initial || "")}" placeholder="${esc(placeholder || "")}" autocomplete="off" />
      <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="promptCancel">Cancel</button><button class="btn btn--primary btn--full" id="promptOk">${esc(opts.ok || "OK")}</button></div></div></div>`);
    const ov = el("promptOv"); const done = (v) => { if (ov) ov.remove(); resolve(v); };
    const inp = el("promptInput"); inp.focus(); if (!opts.password) inp.select();
    inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value); if (e.key === "Escape") done(null); };
    el("promptOk").onclick = () => done(inp.value);
    el("promptCancel").onclick = () => done(null);
    ov.onclick = (e) => { if (e.target.id === "promptOv") done(null); };
  });
}
// One question on screen at a time: a second one waits until the first is answered (two at once shared their
// button ids, so the first one's buttons answered the second). Focus goes to Cancel, Escape is Cancel, Tab stays
// inside (modalTab), and focus goes back to what asked.
let CONFIRM_QUEUE = Promise.resolve();
function showConfirm(title, message, okLabel, danger) {
  const ask = () => new Promise((resolve) => {
    const opener = document.activeElement;
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="confirmOv" data-modal><div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle">
      <div class="modal__title" id="cfTitle">${esc(title)}</div><div class="view__desc" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(message || "")}</div>
      <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="cfCancel">Cancel</button>
        <button class="btn ${danger ? "btn--danger" : "btn--primary"} btn--full" id="cfOk">${esc(okLabel || "OK")}</button></div></div></div>`);
    const ov = el("confirmOv"); const done = (v) => { ov.remove(); if (opener && opener.isConnected) opener.focus(); resolve(v); };
    el("cfOk").onclick = () => done(true); el("cfCancel").onclick = () => done(false);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
    ov.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
    el("cfCancel").focus();
  });
  const answer = CONFIRM_QUEUE.then(ask);
  CONFIRM_QUEUE = answer.then(() => {}, () => {});
  return answer;
}

// ---- QR scanner (webcam via BarcodeDetector, or a QR image / paste) ---------
// BarcodeDetector is built into Chromium (no external lib → CSP-safe). Resolves to the decoded string, or null.
function scanQR(purpose) {
  return new Promise((resolve) => {
    const hasBD = typeof window.BarcodeDetector !== "undefined";
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="scanOv"><div class="modal" style="max-width:360px">
      <div class="modal__title">${esc(purpose || "Scan QR")}</div>
      <div id="scanArea" style="text-align:center">
        ${hasBD ? `<video id="scanVideo" autoplay playsinline muted style="width:100%;max-height:280px;border-radius:8px;background:#000"></video>`
                : `<div class="view__desc">This build can't open the webcam. Choose a QR image, or paste one with ⌘V.</div>`}
      </div>
      <div class="view__desc" id="scanHint" style="margin-top:6px">${hasBD ? "Point the QR at your webcam — or use an image." : ""}</div>
      <input type="file" id="scanFile" accept="image/*" hidden />
      <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="scanImg">Use an image</button><button class="btn btn--outline btn--full" id="scanCancel">Cancel</button></div>
      <div class="view__desc" style="margin-top:6px;font-size:11px">Tip: you can paste a QR image with ⌘V.</div>
    </div></div>`);
    const ov = el("scanOv");
    let stream = null, raf = null, detector = null, done = false;
    const finish = (val) => {
      if (done) return; done = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      document.removeEventListener("paste", onPaste);
      if (ov) ov.remove();
      resolve(val || null);
    };
    const detectFrom = async (src) => {
      try { if (!detector) detector = new window.BarcodeDetector({ formats: ["qr_code"] }); const c = await detector.detect(src); if (c && c.length) return c[0].rawValue; } catch (e) {}
      return null;
    };
    const decodeImageFile = async (file) => {
      if (!hasBD) { toast("QR image decoding isn't available in this build.", "err"); return null; }
      try { const bmp = await createImageBitmap(file); return await detectFrom(bmp); } catch (e) { return null; }
    };
    async function onPaste(e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) if (it.type && it.type.indexOf("image") === 0) {
        const f = it.getAsFile(); if (f) { const v = await decodeImageFile(f); if (v) finish(v); else toast("No QR found in that image.", "err"); }
      }
    }
    document.addEventListener("paste", onPaste);
    el("scanCancel").onclick = () => finish(null);
    ov.onclick = (e) => { if (e.target.id === "scanOv") finish(null); };
    el("scanImg").onclick = () => el("scanFile").click();
    el("scanFile").onchange = async () => { const f = el("scanFile").files[0]; if (!f) return; const v = await decodeImageFile(f); if (v) finish(v); else toast("No QR found in that image.", "err"); };
    if (hasBD) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(s => {
        stream = s; const v = el("scanVideo"); if (!v) { s.getTracks().forEach(t => t.stop()); return; }
        v.srcObject = s;
        const tick = async () => { if (done) return; const val = await detectFrom(v); if (val) return finish(val); if (!done) raf = requestAnimationFrame(tick); };
        v.onloadedmetadata = () => { raf = requestAnimationFrame(tick); };
      }).catch(err => { const h = el("scanHint"); if (h) h.textContent = "Camera unavailable (" + ((err && err.name) || "denied") + "). Use an image, or paste one."; });
    }
  });
}
function showProgress(title, message) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="progOv"><div class="modal">
    <div class="modal__title">${esc(title)}</div><div class="spin">${esc(message || "")}</div></div></div>`);
  return { close: () => { const o = el("progOv"); if (o) o.remove(); } };
}
function showPayResult(ok, message, txid, ambiguous) {
  const title = ambiguous ? "⚠ Payment status unknown" : (ok ? "✓ Payment sent" : "Payment failed");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="prOv"><div class="modal">
    <div class="modal__title">${title}</div>
    <div class="view__desc" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(message)}${ok && txid ? "\n\nTx: " + idHtml(txid) : ""}</div>
    ${ok && txid ? `<button class="btn btn--outline btn--full" id="prCopy" style="margin-top:8px">Copy tx id</button>` : ""}
    <button class="btn btn--primary btn--full" id="prOk" style="margin-top:8px">OK</button></div></div>`);
  const ov = el("prOv"); const close = () => { if (ov) ov.remove(); };
  el("prOk").onclick = close; ov.onclick = (e) => { if (e.target.id === "prOv") close(); };
  if (el("prCopy")) el("prCopy").onclick = () => { copy(txid); toast("Copied.", "ok"); };
}

// ---- minimaMail — the panel lives in renderer/mail.js (APK parity, its own palette) -----------------------
// The old panel was ~590 lines here, shared app.css classes with miniMall,
// and could not carry the APK's paper palette without leaking it into every other tab. app.js keeps only the
// wiring: shared dialogs and helpers go in through MailPanel.init, so neither file reaches into the other.
MailPanel.init({
  api, esc, el, toast, copy, relTime,
  showPrompt, showConfirm, showActionSheet, scanQR,
  TOK
});
function renderMail() {
  if (!running) { el("mailBody").innerHTML = `<div class="empty">Start your node to use Mail.</div>`; return; }
  MailPanel.render();
}
function resetMailState() { MailPanel.reset(); }
function onMailUpdate() { MailPanel.onUpdate(); refreshMailBadge(); }
async function refreshMailBadge() {
  const n = await MailPanel.badge();
  const b = el("mailBadge"); if (!b) return;
  b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
  paintTrayDot();
}
// ---- KeetChat — the panel lives in renderer/chat.js (keets transport; main/chat.js owns the inbox) --------
ChatPanel.init({ api, esc, el, toast, copy, showPrompt, showConfirm });
function renderChat() {
  if (!running) { el("chatBody").innerHTML = `<div class="empty">Start your node to use Chat.</div>`; return; }
  ChatPanel.render();
}
function onChatUpdate() { ChatPanel.onUpdate(); refreshChatBadge(); }
async function refreshChatBadge() {
  const n = await ChatPanel.badge();
  const b = el("chatBadge"); if (!b) return;
  b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
}
ChatPanel.badgeChanged = refreshChatBadge;
// ---- PandaPools: room ② of Dexicon (renderer/dexicon-pp.js) over the window.mcd pp* calls. The panel it replaced
// (renderer/pools.js) was removed in 0.18.141 after the parity audit (docs/DEXICON_PARITY_AUDIT.md).
function onPandapoolsUpdate() { DexPools.onUpdate(); }
function resetPpState() { DexPools.reset(); }

// ---- History ---------------------------------------------------------------
// History filter/paging state. The list renders from the local DB via api.histQuery (paged); the filter bar is
// built ONCE per tab-enter (never on a list re-render) so a background sync can't steal focus mid-search.
let HIST_FILTER = { search: "", token: "", direction: "" };
let HIST_DISPLAY = 300;
const HIST_STEP = 300;
let HIST_ROWS = [];
let histSearchTimer = null;
function histFilterActive() { return !!(HIST_FILTER.search || HIST_FILTER.token || HIST_FILTER.direction); }
function histQueryArgs() { return { search: HIST_FILTER.search, token: HIST_FILTER.token, direction: HIST_FILTER.direction }; }

// The node's OWN signature addresses (simple RETURN SIGNEDBY(mykey) scripts). Coins at any OTHER address — e.g. an
// anyone-can-spend PandaPools covenant this node imported for pool discovery — are foreign, and must NOT count toward
// the wallet's net effect. A plain node never imports those covenants, so its `history` difference already reflects
// only own coins; this set lets us reproduce that view even though our node tracks the covenants. Mx + 0x forms.
let HIST_OWN = null;
let HIST_CONTRACT = null;   // script addresses the node knows that are NOT simple wallet addresses (covenants, contracts)
const HIST_NORM_VER = 3;   // bump when normalize()'s classification changes → re-normalizes already-stored rows once
async function loadOwnAddresses() {
  try {
    const j = await api.cmd("scripts");
    let arr = j && j.response;
    arr = Array.isArray(arr) ? arr : (arr && arr.scripts) || [];
    const set = new Set(), contracts = new Set();
    for (const s of arr) {
      if (!s) continue;
      const into = s.simple === true ? set : contracts;   // own signable address; covenants (anyone-can-spend) are simple:false
      if (s.miniaddress) into.add(String(s.miniaddress));
      if (s.address) into.add(String(s.address).toLowerCase());
    }
    if (set.size) { HIST_OWN = set; HIST_CONTRACT = contracts; }   // an empty reply never replaces a good set
  } catch (e) { /* leave HIST_OWN null → normalize falls back to the node's own difference */ }
  return HIST_OWN;
}
// An address as the phone's History labels it: YOURS (a simple wallet address), CONTRACT (a script the node
// knows that is not one), EXTERNAL (neither). "" while the wallet's addresses are not known: never a wrong label.
function histOwnership(addr) {
  if (!HIST_OWN || !HIST_OWN.size || !addr) return "";
  const has = (set) => set.has(String(addr)) || set.has(String(addr).toLowerCase());
  return has(HIST_OWN) ? "YOURS" : (HIST_CONTRACT && has(HIST_CONTRACT)) ? "CONTRACT" : "EXTERNAL";
}
// Does this transaction touch one of the wallet's own addresses at all? One that does not is contract or
// external activity the node adopted; "Hide foreign contract activity" leaves those rows out.
function histInvolvesWallet(r) {
  return histOwnership(r.counterparty) === "YOURS" || (r.inputs || []).some(ownAddr) || (r.outputs || []).some(ownAddr);
}

let HIST_TIP = 0;            // the chain tip, for "synced to block"
let HIST_LAST_SYNC = 0;      // when the last sync that reached the node finished
let HIST_LAST_OK = true;     // false: the last sync could not read the node
let HIST_WIRED = false;
async function renderHistory() {
  initHistory();
  await ensureHistFilter();
  if (running) {
    if (!HIST_OWN || !HIST_OWN.size) await loadOwnAddresses();
    const rebuilt = await maybeRebuildHistory();   // one-time re-fetch to backfill real token amounts (tokenamount)
    if (!rebuilt) await renormalizeStored();        // otherwise reclassify stored rows in place
  }
  await renderHistoryList();
  if (running) histSync({ older: false });
}
// The header is the phone's: title, Sync, the options menu, the status line and the search field. Wired once,
// so a background sync re-rendering the list cannot take the focus out of the search field.
function initHistory() {
  if (HIST_WIRED) return; HIST_WIRED = true;
  el("histSync").onclick = () => { if (running) histSync({ older: false }); else toast("The node is not running.", "err"); };
  el("histSearch").oninput = (e) => { HIST_FILTER.search = e.target.value.trim(); HIST_DISPLAY = HIST_STEP; clearTimeout(histSearchTimer); histSearchTimer = setTimeout(renderHistoryList, 200); };
  const menu = el("histMenu"), btn = el("histMenuBtn");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => { paintHistMenu(); menu.hidden = false; btn.setAttribute("aria-expanded", "true"); menu.querySelector(".menu__item").focus(); };
  btn.onclick = () => (menu.hidden ? open() : close());
  menu.onclick = (e) => { const b = e.target.closest("[data-hact]"); if (!b) return; close(); histMenuAction(b.dataset.hact); };
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll(".menu__item")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); }
    else if (e.key === "Tab") close();
  };
  document.addEventListener("mousedown", (e) => { if (!menu.hidden && !e.target.closest("#histMenu, #histMenuBtn")) close(); });
}
function histHideForeign() { return store("histHideForeign") === "1"; }
function paintHistMenu() {
  el("histMenu").querySelector('[data-hact="foreign"]').setAttribute("aria-checked", histHideForeign() ? "true" : "false");
  el("histMenu").querySelector('[data-hact="filter"]').setAttribute("aria-checked", el("histFilter").hidden ? "false" : "true");
}
function histMenuAction(act) {
  if (act === "json") exportHistoryJson();
  else if (act === "csv") exportHistory();
  else if (act === "import") importHistory();
  else if (act === "foreign") { store("histHideForeign", histHideForeign() ? "0" : "1"); renderHistoryList(); }
  else if (act === "filter") { el("histFilter").hidden = !el("histFilter").hidden; }
  else if (act === "copy") copyHistory();
}
// Sync now, with the phone's signs of it: the button shows "⟳ …" and the status line "Syncing…".
async function histSync(opts) {
  el("histSync").textContent = "⟳ …"; el("histStatus").textContent = "Syncing…";
  let r = null;
  try { r = await syncHistory(opts); } catch (e) { r = { reachable: false }; }
  if (!r.busy) { HIST_LAST_OK = !!r.reachable; if (r.reachable) HIST_LAST_SYNC = Date.now(); }
  el("histSync").textContent = "⟳ Sync";
  paintHistStatus();
}
async function paintHistStatus() {
  const box = el("histStatus"); if (!box || HIST_SYNCING) return;
  let total = 0; try { total = ((await api.histStats()) || {}).count || 0; } catch (e) {}
  if (!total && running && !HIST_LAST_OK) { box.textContent = "Couldn't read history. The node may be busy. Press Sync to retry."; return; }
  box.textContent = total + (total === 1 ? " transaction" : " transactions")
    + (HIST_TIP > 0 ? " · synced to block " + HIST_TIP : "")
    + (HIST_LAST_SYNC ? " · " + since(HIST_LAST_SYNC) : "")
    + (running ? "" : " · " + (nodeState === "stopped" ? "the node is stopped" : "waiting for the node"));
}
// The desktop's own token and direction filter. The phone has no place for it, so it sits behind the
// options menu ("Filter by direction and token") and shows itself whenever a filter is set.
async function ensureHistFilter() {
  const host = el("histFilter"); if (!host) return;
  const toks = await api.histTokens().catch(() => []);
  const tokOpts = [`<option value="">All tokens</option>`].concat(
    (toks || []).map(t => `<option value="${esc(t.tokenid)}"${t.tokenid === HIST_FILTER.token ? " selected" : ""}>${esc(t.name || TOK.shortId(t.tokenid))}</option>`)
  ).join("");
  const dirs = [["", "All"], ["in", "In"], ["out", "Out"], ["self", "Self"], ["split", "Split"], ["consolidation", "Consol."]];
  host.innerHTML = `
    <select id="histToken" class="field__input hist-tokensel" aria-label="Token">${tokOpts}</select>
    <div class="hist-dirs" id="histDir">${dirs.map(([v, l]) => `<button class="btn btn--sm ${HIST_FILTER.direction === v ? "chip--active" : ""}" data-dir="${v}">${l}</button>`).join("")}</div>`;
  if (HIST_FILTER.token || HIST_FILTER.direction) host.hidden = false;
  el("histToken").onchange = (e) => { HIST_FILTER.token = e.target.value; HIST_DISPLAY = HIST_STEP; renderHistoryList(); };
  el("histDir").querySelectorAll("[data-dir]").forEach(b => b.onclick = () => {
    HIST_FILTER.direction = b.dataset.dir; HIST_DISPLAY = HIST_STEP;
    el("histDir").querySelectorAll("[data-dir]").forEach(x => x.classList.toggle("chip--active", x.dataset.dir === HIST_FILTER.direction));
    renderHistoryList();
  });
}
async function renderHistoryList() {
  const host = el("histList");
  const stored = (await api.histQuery(Object.assign(histQueryArgs(), { limit: HIST_DISPLAY, offset: 0 }))) || [];
  // "Hide foreign contract activity" does nothing until the wallet's own addresses are known: never an empty list for lack of data.
  HIST_ROWS = (histHideForeign() && HIST_OWN && HIST_OWN.size) ? stored.filter(histInvolvesWallet) : stored;
  try { const b = await tryCmd("block"); HIST_TIP = parseInt((b && (b.block != null ? b.block : b)), 10) || HIST_TIP; } catch (e) {}
  paintHistStatus();
  host.innerHTML = HIST_ROWS.length ? HIST_ROWS.map(histRowHtml).join("")
    : (histFilterActive() || stored.length ? `<div class="hist-empty">No matching transactions.</div>` : "");   // nothing stored yet: the status line says "0 transactions", as the phone
  host.querySelectorAll(".hrow").forEach(node => {
    node.onclick = () => { const row = HIST_ROWS.find(x => x.txpowid === node.dataset.txid); if (row) showHistoryDetail(row); };
    node.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); node.click(); } };
  });
  // Pager: more matching rows in the DB → "Show more"; else, unfiltered + running → fetch older from the node.
  if (stored.length >= HIST_DISPLAY) {
    el("histMore").innerHTML = `<button class="btn btn--outline btn--full" id="histMoreBtn">Show more</button>`;
    el("histMoreBtn").onclick = () => { HIST_DISPLAY += HIST_STEP; renderHistoryList(); };
  } else if (running && !histFilterActive() && stored.length) {
    el("histMore").innerHTML = `<button class="btn btn--outline btn--full" id="histOlder">Fetch older from node</button>`;
    el("histOlder").onclick = () => histSync({ older: true });
  } else {
    el("histMore").innerHTML = "";
  }
}
// One row, as the phone's: the arrow, the signed amount and token in the direction's colour, then the other
// party, whose address it is, and when. The address is shown whole (the phone shortens it). The right-hand
// word is "Unverified", as the phone: a row is a wallet change, not proof it settled. The detail asks the chain.
function histRowHtml(r) {
  const glyph = r.direction === "in" ? "↓" : r.direction === "out" ? "↑" : "⟲";
  const cls = r.direction === "in" ? "hrow--in" : r.direction === "out" ? "hrow--out" : "hrow--self";
  let l1;
  if (r.kind === "buy" || r.kind === "sell") {
    const c = tradeCounter(r);
    l1 = (r.kind === "buy" ? "Bought " : "Sold ") + TOK.tidyAmount(r.amount) + " MINIMA" + (c ? " for " + TOK.tidyAmount(c.amt) + " " + c.name : "");
  } else if (r.kind === "split" || r.kind === "consolidation")
    l1 = (r.kind === "split" ? "Split · " + r.outCount : "Consolidation · " + r.inCount) + " coins";
  else {
    const sign = r.direction === "in" ? "+" : r.direction === "out" ? "−" : "";
    l1 = sign + TOK.tidyAmount(r.amount) + "  " + r.tokenName;
  }
  const who = labelFor(r.counterparty) || r.counterparty, tag = histOwnership(r.counterparty);
  const l2 = [who, tag, histWhen(r.time)].filter(Boolean).join("  ·  ");
  return `<div class="hrow ${cls}" data-txid="${esc(r.txpowid)}" tabindex="0" role="button">
    <div class="hrow__g">${glyph}</div>
    <div class="hrow__mid"><div class="hrow__l1">${esc(l1)}</div><div class="hrow__l2">${esc(l2)}</div></div>
    <div class="hrow__r">Unverified</div></div>`;
}
/** "31 minutes ago" inside a week, then the date (the phone's relative()). */
function histWhen(ms) {
  if (!ms || ms <= 0) return "";
  return Date.now() - ms < 7 * 86400000 ? since(ms) : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
/**
 * What the node says about a transaction being on the chain (the phone's HistoryChainStatus.describe, from the
 * reply to `txpow onchain:<id>`). A block height in a TxPoW header and a change in the wallet are not evidence
 * of settlement, so anything short of a consistent found / block / tip / confirmations reply reads "Unverified".
 */
function chainStatus(j) {
  try {
    if (!j || j.status !== true || j.pending === true) return "Unverified";
    const r = j.response;
    if (!r || typeof r !== "object") return "Unverified";
    if (r.found === false) return "Not found on this node, unverified";
    if (r.found !== true) return "Unverified";
    if (typeof r.blockid !== "string" || !/^0x[0-9a-f]{64}$/i.test(r.blockid) || /^0x0+$/i.test(r.blockid)) return "Unverified";
    const whole = (k) => { if (typeof r[k] !== "string" || !/^[0-9]{1,30}$/.test(r[k])) throw new Error(k); return BigInt(r[k]); };
    const block = whole("block"), tip = whole("tip"), depth = whole("confirmations");
    if (block <= 0n || tip - block !== depth) return "Unverified";
    return (depth >= 3n ? "Confirmed" : "In block") + " #" + block + " · " + depth + " confirmations";
  } catch (e) { return "Unverified"; }
}
// The counter (token) leg of a buy/sell row, read from the persisted difference map → {amt, name}.
function tradeCounter(r) {
  const d = r.difference || {};
  const tid = Object.keys(d).find(t => t !== MINIMA && !/^-?0*\.?0*$/.test(String(d[t])));
  if (!tid) return null;
  const coin = (r.inputs || []).concat(r.outputs || []).find(c => c.tokenid === tid);
  return { amt: String(d[tid]).replace(/^-/, ""), name: TOK.tokenName(coin && coin.token, tid) };
}
function showHistoryDetail(r) {
  const timeStr = r.time ? new Date(r.time).toLocaleString() : "unknown";
  const lbl = labelFor(r.counterparty);
  const who = r.counterparty ? (lbl ? `${lbl} (${r.counterparty})` : r.counterparty) : "unknown";
  const deltas = Object.keys(r.difference || {}).map(t => `${esc(TOK.shortId(t))}: ${esc(TOK.tidyAmount(r.difference[t]))}`).join("<br>") || "none";
  // Each coin: amount + token → address, with the coinid and any state variables when present.
  const bd = (list) => (list && list.length ? list.map(c => {
    let line = `• ${esc(TOK.tidyAmount(c.amount))} ${esc(TOK.tokenName(c.token, c.tokenid))} → ${idHtml(c.address)}`;
    if (c.coinid) line += ` <span class="hist-dim">${idHtml(c.coinid)}</span>`;
    if (c.state && c.state.length) line += c.state.map(s => `<br>&nbsp;&nbsp;<span class="hist-dim">[${esc(String(s.port))}] ${esc(String(s.data))}</span>`).join("");
    return line;
  }).join("<br>") : "none");
  const isTrade = r.kind === "buy" || r.kind === "sell";
  const tc = isTrade ? tradeCounter(r) : null;
  const kind = isTrade ? (r.kind === "buy" ? "Bought MINIMA" : "Sold MINIMA")
    : (r.kind !== "normal" ? (r.kind[0].toUpperCase() + r.kind.slice(1)) : (r.direction === "in" ? "Received" : r.direction === "out" ? "Sent" : "Self"));
  const amtStr = (isTrade && tc) ? `${esc(TOK.tidyAmount(r.amount))} MINIMA for ${esc(TOK.tidyAmount(tc.amt))} ${esc(tc.name)}` : `${esc(TOK.tidyAmount(r.amount))} ${esc(r.tokenName)}`;
  const burnStr = (r.burn != null && r.burn !== "" && !/^0*\.?0*$/.test(String(r.burn))) ? esc(TOK.tidyAmount(r.burn)) + " MINIMA" : "0";
  const feeRow = r.burn != null ? `<div class="kv"><span class="kv__k">Fee (burn)</span><span class="kv__v">${burnStr}</span></div>` : "";
  const sizeRow = r.size ? `<div class="kv"><span class="kv__k">Size</span><span class="kv__v">${esc(r.size)} bytes</span></div>` : "";
  const txState = (r.state && r.state.length) ? `<div class="view__sub">Transaction state</div><div class="kv__v" style="text-align:left">${r.state.map(s => `[${esc(String(s.port))}] ${esc(String(s.data))}`).join("<br>")}</div>` : "";
  // Optional block-explorer link — off unless the user sets CFG.explorerBase; the local DB is the source of truth.
  const explorer = (CFG && CFG.explorerBase && r.txpowid) ? safeLinkRow("Explorer", String(CFG.explorerBase) + encodeURIComponent(r.txpowid)) : "";
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="histDetail"><div class="modal">
    <div class="modal__title">Transaction</div>
    <div class="kv"><span class="kv__k">Type</span><span class="kv__v">${esc(kind)}</span></div>
    <div class="kv"><span class="kv__k">Amount</span><span class="kv__v">${amtStr}</span></div>
    ${feeRow}
    <div class="kv"><span class="kv__k">Created at height (not confirmation)</span><span class="kv__v">${esc(r.block)}</span></div>
    <div class="kv"><span class="kv__k">On chain</span><span class="kv__v" id="histChain">Checking chain inclusion…</span></div>
    <div class="kv"><span class="kv__k">Time</span><span class="kv__v">${esc(timeStr)}</span></div>
    ${sizeRow}
    <div class="kv"><span class="kv__k">Txpow id</span><span class="kv__v" id="histTxid" style="cursor:pointer" title="copy">${esc(r.txpowid)}</span></div>
    <div class="kv"><span class="kv__k">${r.direction === "in" ? "From" : "To"}</span><span class="kv__v">${esc(who)}</span></div>
    ${explorer}
    <div class="view__sub">Per-token effect</div><div class="kv__v" style="text-align:left">${deltas}</div>
    ${txState}
    <div class="view__sub">Inputs (${r.inCount})</div><div class="kv__v" style="text-align:left">${bd(r.inputs)}</div>
    <div class="view__sub">Outputs (${r.outCount})</div><div class="kv__v" style="text-align:left">${bd(r.outputs)}</div>
    <button class="btn btn--outline btn--full" id="histClose">Close</button></div></div>`);
  el("histTxid").onclick = () => copy(r.txpowid);
  // Ask the node whether this transaction is in a block on the chain it follows. Read-only; the id is checked before it goes into the command.
  const chain = el("histChain"), said = (t) => { if (chain.isConnected) chain.textContent = t; };
  if (!/^0x[0-9a-f]{64}$/i.test(String(r.txpowid || "")) || !running) said("Unverified");
  else api.cmd("txpow onchain:" + r.txpowid).then(j => said(chainStatus(j)), () => said("Unverified, node check unavailable"));
  const close = () => { const o = el("histDetail"); if (o) o.remove(); };
  el("histClose").onclick = close;
  el("histDetail").onclick = (e) => { if (e.target.id === "histDetail") close(); };
}
function relTime(ms) {
  if (!ms) return "";
  const d = Date.now() - ms, m = Math.floor(d / 60000), h = Math.floor(d / 3600000), days = Math.floor(d / 86400000);
  if (d < 60000) return "just now";
  if (m < 60) return m + "m ago";
  if (h < 24) return h + "h ago";
  if (days < 30) return days + "d ago";
  return new Date(ms).toLocaleDateString();
}

// coin/txpow → normalized row (ported from the native history apps' difference→direction + split/consol rules)
// Store the coin's REAL display amount. For a token coin the on-chain `amount` is a raw sub-grain value (e.g. a pool
// coin's MxUSD shows as 2.8e-37); the node's decoded real value is `tokenamount`. MINIMA (0x00) has no tokenamount —
// its `amount` is already real. Getting this right is what lets a pool swap's MxUSD leg be recovered (it settles into
// the wallet as a dust-encoded token coin whose tokenamount is the true amount). Mirrors the balances read at :753.
function coinLite(c) {
  const tid = c.tokenid || MINIMA;
  const amount = tid === MINIMA ? (c.amount || "0") : (c.tokenamount != null ? c.tokenamount : (c.amount || "0"));
  return { address: c.miniaddress || c.address || "", amount: String(amount), tokenid: tid, token: c.token, coinid: c.coinid || "", state: c.state || [] };
}
function absCmp(a, b) {   // compare |decimal string a| vs |b| without float rounding
  a = String(a).replace(/^-/, ""); b = String(b).replace(/^-/, "");
  const as = a.split("."), bs = b.split(".");
  const an = (as[0] || "0").replace(/^0+/, "") || "0", bn = (bs[0] || "0").replace(/^0+/, "") || "0";
  if (an.length !== bn.length) return an.length - bn.length;
  if (an !== bn) return an < bn ? -1 : 1;
  const af = (as[1] || "").replace(/0+$/, ""), bf = (bs[1] || "").replace(/0+$/, "");
  const L = Math.max(af.length, bf.length), ap = af.padEnd(L, "0"), bp = bf.padEnd(L, "0");
  return ap === bp ? 0 : (ap < bp ? -1 : 1);
}
function decAdd(a, b) {   // non-negative decimal string addition (BigInt-scaled)
  a = String(a); b = String(b);
  const as = a.split("."), bs = b.split(".");
  const af = as[1] || "", bf = bs[1] || "", scale = Math.max(af.length, bf.length);
  const ax = BigInt((as[0] || "0") + af.padEnd(scale, "0"));
  const bx = BigInt((bs[0] || "0") + bf.padEnd(scale, "0"));
  let s = (ax + bx).toString();
  if (scale === 0) return s;
  s = s.padStart(scale + 1, "0");
  return s.slice(0, -scale) + "." + s.slice(-scale);
}
function decSub(a, b) {   // non-negative decimal string subtraction a-b, clamped at 0 (BigInt-scaled)
  a = String(a); b = String(b);
  const as = a.split("."), bs = b.split(".");
  const af = as[1] || "", bf = bs[1] || "", scale = Math.max(af.length, bf.length);
  const ax = BigInt((as[0] || "0") + af.padEnd(scale, "0"));
  const bx = BigInt((bs[0] || "0") + bf.padEnd(scale, "0"));
  const d = ax - bx;
  if (d <= 0n) return "0";                        // never show a negative "locked"
  let s = d.toString();
  if (scale === 0) return s;
  s = s.padStart(scale + 1, "0");
  return (s.slice(0, -scale) + "." + s.slice(-scale)).replace(/\.?0+$/, "");   // trim trailing zeros
}
// Is this coin at one of the node's OWN signature addresses? (false when HIST_OWN is unknown → caller falls back.)
function ownAddr(c) {
  const a = c && (c.address || c.miniaddress);
  if (!HIST_OWN || !HIST_OWN.size || !a) return false;
  return HIST_OWN.has(String(a)) || HIST_OWN.has(String(a).toLowerCase());
}
// Signed per-token net = Σ(outputs) − Σ(inputs) over the given coins, at arbitrary precision (BigInt-scaled per
// token, so 44-dp token dust never rounds). Returns { tokenid: signedDecimalString } with zero-nets dropped to "0".
function signedNet(inputs, outputs) {
  const scale = {}, acc = {};
  const scan = (list) => { for (const c of list) { const t = c.tokenid || MINIMA, f = (String(c.amount || "0").split(".")[1] || "").length; if (f > (scale[t] || 0)) scale[t] = f; } };
  scan(inputs); scan(outputs);
  const add = (list, sign) => { for (const c of list) { const t = c.tokenid || MINIMA, sc = scale[t] || 0, p = String(c.amount || "0").split("."); acc[t] = (acc[t] || 0n) + BigInt(sign) * BigInt((p[0].replace(/^-/, "") || "0") + (p[1] || "").padEnd(sc, "0")); } };
  add(inputs, -1); add(outputs, 1);
  const out = {};
  for (const t of Object.keys(acc)) {
    let v = acc[t]; const sc = scale[t] || 0, neg = v < 0n; if (neg) v = -v;
    let s = v.toString();
    if (sc > 0) { s = s.padStart(sc + 1, "0"); s = (s.slice(0, -sc) + "." + s.slice(-sc)).replace(/0+$/, "").replace(/\.$/, ""); }
    s = s || "0";   // strip FRACTIONAL trailing zeros only — never touch an integer's trailing zeros ("60" must stay "60")
    out[t] = (neg && s !== "0" ? "-" : "") + s;
  }
  return out;
}
// A token's on-chain grain (decimal places), read from its coin metadata. MINIMA → -1 (never quantize; it legitimately
// moves in tiny amounts). Unknown token → 18 (a safe ceiling that keeps any real amount but zeros covenant dust).
function tokDec(tid, inputs, outputs) {
  if (tid === MINIMA) return -1;
  const c = inputs.concat(outputs).find(x => x.tokenid === tid && x.token && x.token.decimals != null);
  const d = c ? parseInt(c.token.decimals, 10) : NaN;
  return Number.isFinite(d) ? d : 18;
}
// Floor |amount| to `dec` decimals (keep sign). On-chain token amounts are always multiples of the grain, so this is
// lossless for real balances — but a PandaPools covenant encodes reserves in a SUB-grain token fraction (e.g. 2.8e-37
// USDT), which this correctly collapses to "0" so it is never mistaken for a swap's counter leg.
function quantTok(amountStr, dec) {
  if (dec < 0) return String(amountStr);
  const neg = String(amountStr).startsWith("-");
  const parts = String(amountStr).replace(/^-/, "").split(".");
  const ip = (parts[0] || "0").replace(/^0+(?=\d)/, ""), fp = (parts[1] || "").slice(0, dec);
  let s = ip + (fp ? "." + fp : "");
  if (fp) s = s.replace(/0+$/, "").replace(/\.$/, "");   // fractional trailing zeros only — keep an integer's ("100")
  s = s || "0";
  return (neg && s !== "0" ? "-" : "") + s;
}
// Classify a transaction from its coins + the node's own `difference`. Shared by fresh normalize() and the one-time
// re-normalize of stored rows. When a foreign (covenant) coin is present, `nodeDiff` counts it and a pool swap nets
// to ~0 → it would show as split/self; we instead take the wallet's TRUE net over OWN coins (what a plain node
// reports) so swaps read as Bought/Sold MINIMA. With no own-address info, or no covenant coin, we use `nodeDiff`.
function classify(inputs, outputs, nodeDiff) {
  nodeDiff = nodeDiff || {};
  const inCount = inputs.length, outCount = outputs.length;
  const hasForeign = inputs.some(c => !ownAddr(c)) || outputs.some(c => !ownAddr(c));
  const ownIn = inputs.filter(ownAddr), ownOut = outputs.filter(ownAddr);
  let diff = (HIST_OWN && HIST_OWN.size && hasForeign && (ownIn.length || ownOut.length))
    ? signedNet(ownIn, ownOut) : nodeDiff;
  // Quantize each token leg to its grain so covenant reserve-dust drops out (a pool deposit/withdraw is then a plain
  // MINIMA Sent/Received, not a spurious "Sold N MINIMA for 0.0000…"). No-op for already-grain node differences.
  if (HIST_OWN && HIST_OWN.size) {
    const cleaned = {};
    for (const t of Object.keys(diff)) cleaned[t] = quantTok(diff[t], tokDec(t, inputs, outputs));
    diff = cleaned;
  }
  let primTok = MINIMA, primAmt = "0";
  for (const tid of Object.keys(diff)) if (absCmp(diff[tid], primAmt) > 0) { primTok = tid; primAmt = diff[tid]; }
  const signed = String(primAmt), neg = signed.startsWith("-");
  const isZero = /^-?0*\.?0*$/.test(signed);
  let direction = isZero ? "self" : (neg ? "out" : "in");
  let kind = "normal";
  if (direction === "self") {
    if (outCount > inCount && outCount > 1) kind = "split";
    else if (inCount > outCount && inCount > 1) kind = "consolidation";
  }
  let amount = signed.replace(/^-/, "");
  if (kind === "split" || kind === "consolidation") {
    const totals = {};
    for (const o of outputs) totals[o.tokenid] = decAdd(totals[o.tokenid] || "0", o.amount || "0");
    let domTok = MINIMA, domAmt = "0";
    for (const tid of Object.keys(totals)) if (absCmp(totals[tid], domAmt) > 0) { domTok = tid; domAmt = totals[tid]; }
    primTok = domTok; amount = domAmt;
  }
  // Trade (pool swap / OTC): the net effect is MINIMA moving one way and exactly one token the other way. Reframe
  // it as BUYING or SELLING MINIMA against the token leg — the counter (token) leg is read back from `difference`
  // at render time.
  const nzToks = Object.keys(diff).filter(t => !/^-?0*\.?0*$/.test(String(diff[t])));
  if (nzToks.length === 2 && nzToks.indexOf(MINIMA) >= 0) {
    const other = nzToks.find(t => t !== MINIMA);
    const minNeg = String(diff[MINIMA]).startsWith("-");
    if (minNeg !== String(diff[other]).startsWith("-")) {
      kind = minNeg ? "sell" : "buy";                 // gave MINIMA = sold; received MINIMA = bought
      direction = minNeg ? "out" : "in";
      primTok = MINIMA; amount = String(diff[MINIMA]).replace(/^-/, "");
    }
  }
  const coinForTok = inputs.concat(outputs).find(c => c.tokenid === primTok);
  const tokenName = TOK.tokenName(coinForTok && coinForTok.token, primTok);
  const counterparty = (direction === "in" ? (inputs[0] && inputs[0].address) : (outputs[0] && outputs[0].address)) || "";
  return { direction, kind, tokenid: primTok, tokenName, amount: String(amount), difference: diff, counterparty, inCount, outCount };
}
function normalize(txpow, detail) {
  detail = detail || {};
  const hdr = txpow.header || {}, txn = (txpow.body && txpow.body.txn) || {};
  const inputs = (txn.inputs || []).map(coinLite), outputs = (txn.outputs || []).map(coinLite);
  const c = classify(inputs, outputs, detail.difference || {});
  return { txpowid: txpow.txpowid, block: parseInt(hdr.block, 10) || 0, time: parseInt(hdr.timemilli, 10) || 0,
    istransaction: !!txpow.istransaction, isblock: !!txpow.isblock, size: parseInt(txpow.size, 10) || 0,
    burn: String(txpow.burn != null ? txpow.burn : "0"),
    direction: c.direction, kind: c.kind, tokenid: c.tokenid, tokenName: c.tokenName, amount: c.amount,
    counterparty: c.counterparty, inCount: c.inCount, outCount: c.outCount,
    difference: c.difference, inputs, outputs, state: txn.state || [] };
}
// One-time re-classification of already-stored rows after a normalize() logic change (gated by HIST_NORM_VER). Only
// runs once own-address info is available; recomputes from each row's stored coins and upserts the ones that change.
async function renormalizeStored() {
  if (!HIST_OWN || !HIST_OWN.size) return;                              // no own-address info → leave stored rows as-is
  if (localStorage.getItem("histNormVer") === String(HIST_NORM_VER)) return;
  try {
    const rows = await api.histGet();                                    // every stored row (coins included)
    const out = [];
    for (const r of rows) {
      const inputs = r.inputs || [], outputs = r.outputs || [];
      if (!inputs.length && !outputs.length) continue;                   // nothing to reclassify from
      const c = classify(inputs, outputs, r.difference || {});
      if (c.kind === r.kind && c.direction === r.direction && c.amount === String(r.amount)) continue;
      out.push(Object.assign({}, r, { direction: c.direction, kind: c.kind, tokenid: c.tokenid,
        tokenName: c.tokenName, amount: c.amount, difference: c.difference, counterparty: c.counterparty }));
    }
    for (let i = 0; i < out.length; i += 500) await api.histAdd(out.slice(i, i + 500));
    localStorage.setItem("histNormVer", String(HIST_NORM_VER));
  } catch (e) { /* transient; retried next session (version marker only set on success) */ }
}
// Pager: fetch history in pages and persist into the local DB. Over HTTP RPC there is NO 256KB response cap
// (that is an Android-Binder limit — we are a jar over loopback HTTP), so we page at the node's own default of
// 100. The halve-on-"over" below is only a safety fallback if a single page errors; incremental sync stops at
// the first already-stored txpowid, and a "Load older" pull runs to an empty page or a generous row budget.
const HIST_PAGE = 100;          // node default (was 8 — a native-Binder holdover)
const HIST_OLDER_BUDGET = 2000; // rows fetched per "Load older" click
// Returns { fetched, reachable }. `reachable` = the node served at least one page (so a caller like the one-time
// rebuild can tell "node down, retry later" apart from "nothing new"). opts.rebuild re-fetches from offset 0 and
// UPSERTS every row (no stop-at-known) so a coinLite/normalize change re-writes the whole stored history.
async function syncHistory(opts) {
  opts = opts || {};
  if (HIST_SYNCING) return { fetched: 0, reachable: false, completed: false, busy: true }; HIST_SYNCING = true;
  let reachable = false, fetched = 0, completed = false;   // completed = the loop reached a clean end (empty page / all-known), not a node error
  try {
    if (!HIST_OWN || !HIST_OWN.size) await loadOwnAddresses();   // classify new rows over own coins (native's view)
    const upsertAll = !!(opts.older || opts.rebuild);            // don't stop at the first already-stored txpowid
    // A row that came from an import file does not count as known: the walk goes on past it, so the node's own
    // row for that transaction is written over it (and the walk then stops at the first row the node gave before).
    const known = upsertAll ? null : new Set((await api.histGet()).filter(r => !r.imported).map(r => r.txpowid));
    let offset = opts.older ? histOldestOffset : 0, max = HIST_PAGE, skips = 0, hitKnown = false;
    let batch = [];
    const flushBatch = async () => { if (batch.length) { await api.histAdd(batch); batch = []; } };
    for (;;) {
      let page;
      try {
        const j = await api.cmd(`history relevant:true max:${max} offset:${offset}`);
        if (j && j.status === true && j.response) { reachable = true; page = { txpows: j.response.txpows || [], details: j.response.details || [] }; }
        else page = { over: true };
      } catch (e) { page = { over: true }; }
      if (page.over) { if (max > 1) { max = Math.floor(max / 2); continue; } if (skips < 3) { skips++; offset += 1; max = HIST_PAGE; continue; } break; }
      if (!page.txpows.length) { completed = true; break; }   // natural end of history
      for (let i = 0; i < page.txpows.length; i++) {
        const row = normalize(page.txpows[i], page.details[i]);
        if (!row.txpowid) continue;
        if (!upsertAll && known.has(row.txpowid)) { hitKnown = true; break; }
        batch.push(row); fetched++;
      }
      if (hitKnown) { completed = true; break; }
      offset += page.txpows.length; max = HIST_PAGE; skips = 0;
      if (batch.length >= 500) await flushBatch();          // bound memory/IPC on a deep first sync
      if (opts.older && fetched >= HIST_OLDER_BUDGET) break;
    }
    await flushBatch();
    // rebuild reaches the end, so it advances the "oldest" watermark too (Math.max branch) — no redundant re-scan later.
    histOldestOffset = opts.older ? offset : Math.max(histOldestOffset, offset);
    await renderHistoryList();
  } finally { HIST_SYNCING = false; }
  return { fetched, reachable, completed };
}
// One-time re-fetch of the whole stored history after a capture/normalize change that needs FRESH node data (the
// stored coins can't be re-decoded in place — e.g. capturing `tokenamount`, dropped by older coinLite). Gated by
// HIST_REBUILD_VER; the marker is set ONLY once the rebuild reached the natural END of history (reachable AND
// completed) — a node-down or mid-stream-truncated launch leaves the marker unset and retries next session, so no
// older rows are left permanently stale with the pre-tokenamount amounts.
const HIST_REBUILD_VER = 1;
async function maybeRebuildHistory() {
  if (localStorage.getItem("histRebuildVer") === String(HIST_REBUILD_VER)) return false;
  const r = await syncHistory({ rebuild: true });
  if (r && r.reachable && r.completed) { localStorage.setItem("histRebuildVer", String(HIST_REBUILD_VER)); return true; }
  return r && r.reachable;   // reached the node (rows updated) but not the end → don't mark done; still skip renormalize this render
}
function histType(r) { return r.kind !== "normal" ? r.kind : (r.direction === "in" ? "Received" : r.direction === "out" ? "Sent" : "Self"); }
function histDate(ms) { return ms ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") : ""; }
// Copy/CSV export the CURRENTLY FILTERED set (not just what's on screen), with the richer columns.
const HIST_COLS = ["date", "type", "direction", "amount", "token", "counter_amount", "counter_token", "fee", "counterparty", "txpowid", "block", "inputs", "outputs", "deltas"];
function histCells(r) {
  const deltas = Object.keys(r.difference || {}).map(t => `${TOK.shortId(t)}:${TOK.tidyAmount(r.difference[t])}`).join(" ");
  const tc = (r.kind === "buy" || r.kind === "sell") ? tradeCounter(r) : null;   // the MxUSD (token) leg of a swap
  return [histDate(r.time), histType(r), r.direction || "", TOK.tidyAmount(r.amount), r.tokenName,
    tc ? TOK.tidyAmount(tc.amt) : "", tc ? tc.name : "",
    (r.burn != null ? TOK.tidyAmount(r.burn) : ""), labelFor(r.counterparty) || r.counterparty || "", r.txpowid, r.block,
    r.inCount != null ? r.inCount : "", r.outCount != null ? r.outCount : "", deltas];
}
async function histExportRows() {
  return (await api.histQuery(Object.assign(histQueryArgs(), { limit: 1000000, offset: 0 }))) || [];
}
async function copyHistory() {
  const rows = await histExportRows();
  const lines = rows.map(r => histCells(r).join("\t"));
  copy([HIST_COLS.join("\t"), ...lines].join("\n"));
  toast(`Copied ${rows.length} rows ✓`, "ok");
}
// The whole local history as one JSON file to keep (the phone's "Export as JSON (backup)"): the same envelope,
// with the desktop's richer rows inside. Every stored row, whatever the screen is filtered to.
async function exportHistoryJson() {
  const rows = (await api.histGet()) || [];
  const text = JSON.stringify({ app: "minima-history", version: 1, source: "minimacore-desktop", exported_at: Date.now(), count: rows.length, tx: rows });
  const p = await api.exportCsv(text, "minima-history.json");
  toast(p ? `Exported ${rows.length} transaction${rows.length === 1 ? "" : "s"} ✓` : "Export cancelled", p ? "ok" : "");
}
// One record of an export file → a row for the local store, or null if it is not one. Reads the desktop's
// own rows and the phone's (HistoryEntry.toJson: received / sent / self, timemilli, inputs and deltas as JSON
// text, coins with `addr` and `name`). Every field, down to each coin's token and state, is rebuilt from a
// checked number, amount, id or address; nothing from the file is passed through. A field that is present and
// wrong drops the whole row (the import counts it). Ids are upper-case hex after 0x, as the node writes them.
function histImportRow(o) {
  if (!o || typeof o !== "object" || typeof o.txpowid !== "string" || !/^0x[0-9A-Fa-f]{64}$/.test(o.txpowid)) return null;
  const bad = new Error("row");
  const hex = (v) => "0x" + v.slice(2).toUpperCase();
  const parsed = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { throw bad; } } return v; };
  const list = (v) => { v = parsed(v); if (v == null) return []; if (!Array.isArray(v) || v.length > 2048) throw bad; return v; };
  const whole = (v) => { if (v == null || v === "") return 0; if ((typeof v !== "number" && typeof v !== "string") || !/^[0-9]{1,15}$/.test(String(v))) throw bad; return Number(v); };
  const amt = (v) => { if (v == null || v === "") return "0"; if ((typeof v !== "number" && typeof v !== "string") || !/^-?[0-9]{1,64}(\.[0-9]{1,64})?$/.test(String(v))) throw bad; return String(v); };
  const addr = (v) => { if (v == null || v === "") return ""; if (typeof v !== "string" || v.length > 200 || !/^(0x|Mx)[0-9A-Za-z]+$/.test(v)) throw bad; return v; };
  const tok = (v) => { if (v == null || v === "" || v === MINIMA) return MINIMA; if (typeof v !== "string" || !/^0x[0-9A-Fa-f]{1,128}$/.test(v)) throw bad; return hex(v); };
  const id = (v) => { if (v == null || v === "") return ""; if (typeof v !== "string" || !/^0x[0-9A-Fa-f]{1,128}$/.test(v)) throw bad; return hex(v); };
  const text = (v) => (typeof v === "string" && v && v.length <= 256 ? v : "");
  const state = (v) => list(v).map(s => { if (!s || typeof s !== "object" || (typeof s.data !== "string" && typeof s.data !== "number") || String(s.data).length > 65536) throw bad;
    return { port: whole(s.port), type: whole(s.type), data: String(s.data) }; });
  const coin = (c) => {
    if (!c || typeof c !== "object") throw bad;
    const t = c.token && typeof c.token === "object" ? c.token : {};
    const name = text(t.name && typeof t.name === "object" ? t.name.name : t.name) || text(c.name), token = {};
    if (name) token.name = name;
    if (t.decimals != null && whole(t.decimals) <= 64) token.decimals = whole(t.decimals);
    return { address: addr(c.address != null ? c.address : c.addr), amount: amt(c.amount), tokenid: tok(c.tokenid),
      token: name || token.decimals != null ? token : undefined, coinid: id(c.coinid), state: state(c.state) };
  };
  try {
    const inputs = list(o.inputs).map(coin), outputs = list(o.outputs).map(coin), tokenid = tok(o.tokenid), difference = {};
    const d = parsed(o.difference != null ? o.difference : o.deltas);
    if (d != null) { if (typeof d !== "object" || Array.isArray(d)) throw bad; for (const k of Object.keys(d)) difference[tok(k)] = amt(d[k]); }
    const direction = o.direction == null ? "self" : ({ received: "in", sent: "out", in: "in", out: "out", self: "self" })[o.direction];
    const kind = o.kind == null ? "normal" : ["normal", "split", "consolidation", "buy", "sell"].find(k => k === o.kind);
    if (!direction || !kind) throw bad;
    return { txpowid: hex(o.txpowid), block: whole(o.block), time: whole(o.time != null ? o.time : o.timemilli),
      istransaction: o.istransaction !== false, isblock: o.isblock === true, size: whole(o.size), burn: amt(o.burn),
      direction, kind, tokenid, tokenName: text(o.tokenName) || TOK.tokenName(null, tokenid),
      amount: amt(o.amount).replace(/^-/, ""), counterparty: addr(o.counterparty),
      inCount: inputs.length || whole(o.inCount), outCount: outputs.length || whole(o.outCount),
      difference, inputs, outputs, state: state(o.state) };
  } catch (e) { if (e === bad) return null; throw e; }
}
// What an import would do, worked out before anything is written: the rows the store does not have, how many
// it already has, how many records were not valid, and a refusal when the new rows would not fit. The store
// trims its lowest blocks past the cap, and it is the only record of transactions the node has pruned, so a
// file is never allowed to push it there.
function histImportPlan(records, known, cap) {
  const fresh = [], seen = new Set(); let same = 0, invalid = 0;
  for (const o of records) {
    const row = histImportRow(o);
    if (!row) invalid++;
    else if (known.has(row.txpowid) || seen.has(row.txpowid)) same++;
    else { seen.add(row.txpowid); fresh.push(row); }
  }
  const refuse = cap > 0 && known.size + fresh.length > cap
    ? `Nothing was imported. The file would add ${fresh.length} transactions to the ${known.size} already stored, and the store holds ${cap} at most.` : "";
  return { fresh, same, invalid, refuse };
}
// "Import history (restore / merge)": rows the store does not have are added, in one write; a row it already
// has is left exactly as it is (matched on the txpow id), so importing the same file twice, or one from another
// device, is safe. An added row is marked imported: when the node later reports that transaction, a sync
// replaces it with the node's own row.
async function importHistory() {
  let text;
  try { text = await api.importJson(); } catch (e) { toast("Import failed: " + (e.message || e), "err"); return; }
  if (text == null) return;                                          // cancelled
  try {
    const arr = JSON.parse(text).tx;
    if (!Array.isArray(arr)) throw new Error("this is not a history export");
    const known = new Set(((await api.histGet()) || []).map(r => r.txpowid));
    const plan = histImportPlan(arr, known, ((await api.histStats()) || {}).cap);
    if (plan.refuse) { toast(plan.refuse, "err"); return; }
    const res = plan.fresh.length ? await api.histImport(plan.fresh) : { added: 0 };
    if (res.refused) { toast(`Nothing was imported. The file would add ${res.fresh} transactions to the ${res.existing} already stored, and the store holds ${res.cap} at most.`, "err"); return; }
    toast(`Added ${res.added} of ${arr.length}. Already stored: ${plan.same + (plan.fresh.length - res.added)}.` + (plan.invalid ? ` Not valid, left out: ${plan.invalid}.` : ""), "ok");
    await ensureHistFilter(); await renderHistoryList();
  } catch (e) { toast("Import failed: " + (e.message || e), "err"); }
}
async function exportHistory() {
  const rows = await histExportRows();
  // Quote for CSV; neutralize spreadsheet formula-injection (a token name like "=HYPERLINK(...)" is attacker-set) by
  // prefixing a single quote when a cell leads with a formula trigger — Excel/Sheets evaluate those even when quoted.
  const q = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const lines = rows.map(r => histCells(r).map(q).join(","));
  const csv = [HIST_COLS.join(","), ...lines].join("\r\n");
  const p = await api.exportCsv(csv, "minima-history.csv");
  toast(p ? "Saved CSV ✓" : "Export cancelled", p ? "ok" : "");
}

// ---- Terminal (full node console — runs commands immediately, no guard) ----
// Autocomplete: TermComplete (termcomplete.js, ported from apks/terminalide) suggests
// commands → params → param values as you type; Tab accepts, arrows navigate, Esc closes.
function termSugUpdate() {
  const inp = el("termIn"); if (!inp) return;
  const res = TermComplete.suggest(inp.value, inp.selectionStart);
  SUG_ITEMS = res.items.slice(0, SUG_MAX); SUG_SEL = 0;
  const hint = el("termHint");
  if (res.paramHint) { hint.textContent = res.paramHint; hint.style.display = ""; }
  else hint.style.display = "none";
  termSugRender();
}
function termSugRender() {
  const box = el("termSug");
  if (!SUG_ITEMS.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.innerHTML = SUG_ITEMS.map((it, i) =>
    `<div class="termsug__row${i === SUG_SEL ? " termsug__row--sel" : ""}" data-i="${i}">` +
    `<span class="termsug__l">${esc(it.label)}</span>` +
    (it.required ? `<span class="termsug__req">required</span>` : "") +
    (it.desc ? `<span class="termsug__d">${esc(it.desc)}</span>` : "") + `</div>`).join("");
  box.style.display = "";
  // mousedown (not click): fires before the input's blur, and preventDefault keeps focus in the input
  for (const row of box.children) row.onmousedown = (e) => { e.preventDefault(); termSugAccept(SUG_ITEMS[+row.dataset.i]); };
  const sel = box.children[SUG_SEL]; if (sel) sel.scrollIntoView({ block: "nearest" });
}
function termSugClose() {
  SUG_ITEMS = []; SUG_SEL = 0;
  const box = el("termSug"), hint = el("termHint");
  if (box) { box.style.display = "none"; box.innerHTML = ""; }
  if (hint) hint.style.display = "none";
}
function termSugAccept(item) {
  const inp = el("termIn"), cur = inp.value, caret = inp.selectionStart;
  inp.value = TermComplete.apply(cur, caret, item);   // re-derived at accept time, splices the token only
  const c = TermComplete.applyCaret(cur, caret, item);
  inp.setSelectionRange(c, c);
  termSugUpdate();                                    // Tab flows onward: command → params → values
}
// ---- Terminal: Pandamonium's TerminalView (banner, output, the command field and Run), the desktop's completion kept ----
// Output is built from text nodes only (a reply can carry any text a peer put on the chain); JSON is coloured as
// mds/terminalIDE colours it (keys, strings, numbers, true / false, null; `false` and failure words in red).
const TERM_MAX = 20000;   // characters kept, as the phone's boundedAppend: older output is dropped from the head
const TERM_BANNER = ["**********************************************", "*  __  __  ____  _  _  ____  __  __    __    *", "* (  \\/  )(_  _)( \\( )(_  _)(  \\/  )  /__\\   *",
  "*  )    (  _)(_  )  (  _)(_  )    (  /(__)\\  *", "* (_/\\/\\_)(____)(_)\\_)(____)(_/\\/\\_)(__)(__) *", "*                                            *", "**********************************************"];
let TERM_ITEMS = [];      // [{ kind: "cmd" | "json" | "err" | "note", text }]
/** The coloured pieces of a pretty-printed JSON text: [[class | "", text], …]. Pure (scripts/apps-screens.test.cjs). */
function termJsonParts(text) {
  const out = [], re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(["", text.slice(at, m.index)]);
    if (m[1] && m[2]) { out.push(["j-key", m[1]]); out.push(["", m[2]]); }
    else if (m[1]) out.push([/error|invalid|fail/i.test(m[1]) ? "j-err" : "j-str", m[1]]);
    else if (m[3]) out.push([m[3] === "false" ? "j-err" : "j-bool", m[3]]);
    else out.push([m[0] === "null" ? "j-null" : "j-num", m[0]]);
    at = re.lastIndex;
  }
  if (at < text.length) out.push(["", text.slice(at)]);
  return out;
}
function termNode(it) {
  const line = document.createElement("div"); line.className = "term-line term-line--" + it.kind;
  if (it.kind !== "json") { line.textContent = it.text; return line; }
  for (const [cls, t] of termJsonParts(it.text)) { if (!cls) { line.appendChild(document.createTextNode(t)); continue; } const sp = document.createElement("span"); sp.className = cls; sp.textContent = t; line.appendChild(sp); }
  return line;
}
/** What "Copy output" copies: a reply too long for the screen is copied WHOLE (`full`), not as the tail that is shown. */
function termText() { return TERM_ITEMS.map(it => (it.kind === "cmd" ? "> " : "") + (it.full || it.text)).join("\n"); }
function appendTerm(text, kind) {
  let it = { kind: kind || "json", text: String(text) };
  // one oversized reply: the screen shows its tail and says so; the whole reply is kept for Copy output while it is on screen
  if (it.text.length > TERM_MAX) it = { kind: it.kind === "json" ? "note" : it.kind, full: it.text, text: "[This output is cut: the last " + TERM_MAX + " of its " + it.text.length + " characters are shown. Copy output copies all of it.]\n" + it.text.slice(-TERM_MAX) };
  TERM_ITEMS.push(it);
  let size = TERM_ITEMS.reduce((n, x) => n + x.text.length + 1, 0), dropped = 0;
  while (size > TERM_MAX && TERM_ITEMS.length > 1) { size -= TERM_ITEMS.shift().text.length + 1; dropped++; }
  const out = el("termOut"); if (!out) return;
  for (; dropped > 0 && out.firstChild; dropped--) out.removeChild(out.firstChild);
  out.appendChild(termNode(it));
  el("termScroll").scrollTop = el("termScroll").scrollHeight;
}
// A typed `send` is the user's own command. One thing can be added to it on the way, and the Terminal says so: a MINIMA send
// with no fromaddress: may be given one (main.js, the pin that keeps the node off coins it cannot sign). The coin guard itself
// passes a wallet command through unchanged unless it is switched to Enforce (Settings, Coin guard).
// The same rule as the main process (main/sendpin.js pinSend): MINIMA is no tokenid at all or exactly tokenid:0x00, and a chain (;) is never pinned.
function termSendNote(c) { const t = /\btokenid:(0x[0-9A-Fa-f]+)/i.exec(c); return /^send\s/i.test(c) && !c.includes(";") && !/\bfromaddress:/i.test(c) && (!t || t[1].toLowerCase() === "0x00") ? "note: a MINIMA send with no fromaddress: may be given one of this wallet's own addresses, so that the node does not choose a coin it cannot sign. The reply's params show what was sent. Type fromaddress: yourself to choose." : ""; }
async function termRun() {
  const inp = el("termIn"), c = inp.value.trim(); if (!c) return;   // an empty Run does nothing
  inp.value = ""; termSugClose();
  TERM_HIST.push(c); termIdx = TERM_HIST.length;
  appendTerm(c, "cmd");
  const note = termSendNote(c); if (note) appendTerm(note, "note");
  try { const r = await api.cmd(c); appendTerm(JSON.stringify(r, null, 2), "json"); }
  catch (err) { appendTerm("error: " + ipcError(err), "err"); }
  inp.focus();
}
function renderTerminal() {
  const out = el("termOut"), inp = el("termIn");
  api.nodeStatus().then(s => { el("termBanner").textContent = TERM_BANNER.join("\n") + "\nWelcome to Minima Core " + ((s && s.health && s.health.version) || "") + "\nYou can run commands in this Terminal.."; }).catch(() => {});
  if (!el("termBanner").textContent) el("termBanner").textContent = TERM_BANNER.join("\n");
  out.textContent = ""; TERM_ITEMS.forEach(it => out.appendChild(termNode(it)));
  el("termScroll").scrollTop = el("termScroll").scrollHeight;
  el("termClear").onclick = () => { TERM_ITEMS = []; out.textContent = ""; inp.focus(); };
  el("termCopy").onclick = () => copy(termText());
  el("termRun").onclick = termRun;
  inp.onkeydown = async (e) => {
    if (e.key === "Enter") {                          // Enter ALWAYS submits, dropdown open or not
      termRun();
    } else if (e.key === "Escape") {                  // the escape hatch to reach ↑ history while suggestions are up
      if (SUG_ITEMS.length) { e.preventDefault(); termSugClose(); }
    } else if (e.key === "Tab") {
      if (SUG_ITEMS.length) { e.preventDefault(); termSugAccept(SUG_ITEMS[Math.min(SUG_SEL, SUG_ITEMS.length - 1)]); }   // with nothing to complete, Tab moves on to Run
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      if (SUG_ITEMS.length) {                         // dropdown open → move highlight (wraps)
        SUG_SEL = (SUG_SEL + d + SUG_ITEMS.length) % SUG_ITEMS.length; termSugRender();
      } else if (TERM_HIST.length) {                  // else history, as before
        termIdx = Math.max(0, Math.min(TERM_HIST.length, termIdx + d));
        inp.value = TERM_HIST[termIdx] || "";
        inp.setSelectionRange(inp.value.length, inp.value.length);
        termSugUpdate();
      }
    }
  };
  inp.oninput = termSugUpdate;                        // typing / paste / cut
  inp.onblur = termSugClose;                          // focus loss (incl. tab switch, click-outside) closes
  // Caret moves (←/→/Home/End/mouse click) retrigger suggestions, like terminalide's
  // setOnCaretMoved. Property assignment = one listener no matter how often we re-render.
  document.onselectionchange = () => { if (document.activeElement === el("termIn")) termSugUpdate(); };
  inp.focus();
  termSugUpdate();
}

// ---- Settings --------------------------------------------------------------
// ---- Apps tab: the phone's "Internal" list, one row per app, each with a Hide and a Freeze switch ----
// Hide takes an app out of the tray until it is switched back; the app itself keeps running. Freeze (0.19.117, main/freeze.js)
// stops the app's background work and puts its tray row away; its data is kept, and unfreezing resumes it. The main process
// decides whether an app may be frozen and says why not (Dexicon: never while money is in flight). Minima Core is neither.
// Dexicon and Chat are tabs: they have no drawer row to hide, and opening the tab unfreezes them, as on the phone.
const APPS_TABS = [{ id: "dexicon", name: "Dexicon", tab: true, icon: "minima-tile.svg" }, { id: "chat", name: "Chat", tab: true, icon: "minima-tile.svg" }];
const NO_FREEZE = { core: "Cannot be frozen: Minima Core is the node and the wallet.", parlons: "Cannot be frozen: Parlons is part of the node itself." };
let FROZEN = [];   // ids, as the main process holds them (config frozenApps)
function hiddenApps() { return String(store("shellHidden") || "").split(",").filter(id => id && id !== "core" && TRAY_APPS.some(a => a.id === id)); }
function applyHiddenApps() {
  const hidden = hiddenApps();
  document.querySelectorAll(".tray__row").forEach(r => { r.hidden = hidden.includes(r.dataset.app) || FROZEN.includes(r.dataset.app); });
  paintTrayDot();
}
/** The line under an app's name (IntegratedAppsAdapter): where it is, and " · Deep frozen" when it is. */
function appsState(a, hidden, frozen) { return (a.id === "core" ? "Always on" : a.tab ? "A tab" : hidden ? "Hidden from drawer" : "In app drawer") + (frozen ? " · Deep frozen" : ""); }
let THAW_FAILED = "";   // the app whose unfreeze-on-open failed: it is drawn frozen, with the reason said, and not asked again until the switch is used
async function setFrozen(id, on) {
  THAW_FAILED = "";
  try { FROZEN = await api.freezeSet(id, on); }
  catch (e) { openDlg("freezeNo", on ? "Not frozen" : "Still frozen", `<div class="apps-why">${esc(ipcError(e))}</div>`, ""); FROZEN = await api.freezeList().catch(() => FROZEN); }   // the list is read again: the screen shows what the main process holds
  applyHiddenApps();
}
// Opening a frozen app wakes it for good (PandamoniumHooks: "opening a frozen app unfreezes it").
function thawOnOpen() {
  const id = activeView === "chat" ? "chat" : TAB_OF[activeView] === "dexicon" ? "dexicon" : activeView;
  if (!FROZEN.includes(id) || THAW_FAILED === id) return false;
  const name = (TRAY_APPS.concat(APPS_TABS).find(a => a.id === id) || { name: id }).name;
  api.freezeSet(id, false).then(l => { FROZEN = l; applyHiddenApps(); toast(name + " was frozen. It is running again."); renderActive(); })
    .catch(async (e) => {   // never a blank screen: the reason is said, and the app is drawn as it is (still frozen)
      THAW_FAILED = id; FROZEN = await api.freezeList().catch(() => FROZEN); applyHiddenApps();
      openDlg("freezeNo", "Still frozen", `<div class="apps-why">${esc(name + " could not be unfrozen: " + ipcError(e) + "\n\nTry the Freeze switch on the Apps tab.")}</div>`, "");
      renderActive();
    });
  return true;
}
function renderApps() {
  const hidden = hiddenApps();
  el("appsList").innerHTML = TRAY_APPS.concat(APPS_TABS).map(a => {
    const core = a.id === "core", off = hidden.includes(a.id), ice = FROZEN.includes(a.id), noIce = NO_FREEZE[a.id];
    return `<div class="apps-row">
    ${a.icon ? `<img class="apps-row__ic" src="${a.icon}" alt="">` : CORE_MARK.replace("tray__ic", "apps-row__ic")}
    <div class="apps-row__main"><div class="apps-row__name">${esc(a.name)}${a.badge ? `<span class="tab-badge" data-count="${a.badge}" hidden></span>` : ""}</div><div class="apps-row__state">${appsState(a, off, ice)}</div>${noIce ? `<div class="apps-row__state" id="appsWhy-${a.id}">${esc(noIce)}</div>` : ""}</div>
    <div class="apps-row__sw"><label class="apps-row__hide"><span>Hide</span><button class="switch" role="switch" aria-checked="${off}" aria-label="Hide ${esc(a.name)}" data-hide="${a.id}"${core || a.tab ? " disabled" : ""}></button></label>
      <label class="apps-row__hide"><span>Freeze</span><button class="switch" role="switch" aria-checked="${ice}" aria-label="Freeze ${esc(a.name)}" data-freeze="${a.id}"${noIce ? ` disabled aria-describedby="appsWhy-${a.id}"` : ""}></button></label></div>
  </div>`; }).join("");
  paintAppsCounts();
  el("appsList").querySelectorAll(".switch[data-hide]:not([disabled])").forEach(sw => sw.onclick = () => {
    const id = sw.dataset.hide, now = hiddenApps();
    store("shellHidden", (now.includes(id) ? now.filter(x => x !== id) : now.concat(id)).join(","));
    applyHiddenApps(); renderApps();
    const again = el("appsList").querySelector(`.switch[data-hide="${id}"]`); if (again) again.focus();
  });
  el("appsList").querySelectorAll(".switch[data-freeze]:not([disabled])").forEach(sw => sw.onclick = async () => {
    const id = sw.dataset.freeze; sw.disabled = true;
    await setFrozen(id, !FROZEN.includes(id));
    if (activeView === "apps") { renderApps(); const again = el("appsList").querySelector(`.switch[data-freeze="${id}"]`); if (again && !document.querySelector(".overlay--dlg")) again.focus(); }
  });
}
// ---- Minima Faucet: the one screen of Pandamonium's Faucet (apks/base integrated/faucet, pm_faucet_activity_main.xml) ----
// The request itself is main/faucet.js (one GET to the pinned host, nothing else); this is its screen.
async function renderFaucet() {
  const host = el("faucetBody");
  if (el("faucetGo")) { el("faucetBanner").hidden = running; return; }   // already drawn: keep what the user typed and the last answer
  host.innerHTML = `<div class="fc"><div class="fc-brand">MINIMA FAUCET</div>
    <div class="fc-banner" id="faucetBanner"${running ? " hidden" : ""}><b>The node is not ready</b><span>Start the node on the Node tab, then come back.</span></div>
    <h1 class="fc-h1">Get Free Minima</h1><div class="fc-sub">Receive 0.0001 Minima to try out the blockchain.</div>
    <label class="fc-label" for="faucetAddr">Minima Address</label>
    <textarea class="fc-in" id="faucetAddr" rows="2" placeholder="Paste or fetch an address…" autocomplete="off" spellcheck="false"></textarea>
    <button class="fc-btn fc-btn--line" id="faucetMine">Get My Address</button>
    <button class="fc-btn" id="faucetGo">Request Minima</button>
    <div class="fc-status" id="faucetStatus" role="status" hidden></div>
    <div class="fc-help">The faucet sends a tiny amount of Minima to your node so you can try creating custom tokens and testing transactions.</div>
    <div class="fc-foot">eurobuddha · Minima Ecosystem</div></div>`;
  const say = (text, ok) => { const st = el("faucetStatus"); st.hidden = false; st.textContent = text; st.className = "fc-status " + (ok ? "fc-status--ok" : "fc-status--err"); };
  el("faucetMine").onclick = async () => {
    const b = el("faucetMine"); b.disabled = true; b.textContent = "Fetching…";
    const a = running ? await tryCmd("getaddress") : null, addr = a && (a.miniaddress || a.address);
    if (addr) el("faucetAddr").value = addr; else say(a ? "Could not read address from response." : "The node did not respond. Check its status on the Node tab.", false);
    b.disabled = false; b.textContent = "Get My Address";
  };
  el("faucetGo").onclick = async () => {
    const addr = el("faucetAddr").value.trim();
    if (!addr) { say("Please enter a Minima address.", false); return; }
    if (!validAddr(addr)) { say("That is not a Minima address (Mx… or 0x…).", false); return; }
    const btn = el("faucetGo"); btn.disabled = true; btn.textContent = "Requesting…";
    try { const r = await api.faucet(addr); say("Faucet: " + (r && r.message ? r.message : "Unexpected response from faucet."), !!(r && r.status)); }
    catch (e) { say("Failed to reach the faucet. Try again later.", false); }
    btn.disabled = false; btn.textContent = "Request Minima";
  };
}
// Settings: what is the desktop's own and has no screen on the phone (open at login, updates, which node, the
// key-use audit, address labels, the history store). Laid out with the shell's own pieces: the phone's
// eyebrow-and-card of the Node tab. Node commands are typed in the Terminal; there is no second command box here.
async function renderSettings() {
  const host = el("settingsBody");
  const keys = running ? await tryCmd("keys action:list") : null;
  const ku = keysInfo(keys);
  const pct = ku.cap ? Math.min(100, Math.round(ku.used / ku.cap * 100)) : 0;
  const warn = pct >= 80;
  const labels = CFG.labels || {}, labelKeys = Object.keys(labels);
  const kind = CFG.nodeKind === "minima" ? "minima" : "parlons";
  const sec = (title, body, id) => `<div class="eyebrow home-eyebrow">${title}</div><div class="card home-card set-card"${id ? ` id="${id}"` : ""}>${body}</div>`;
  // Which app this is (main/flavor.js): a copy that does not update itself has no feed to check and no Download button.
  const fl = (await api.flavor().catch(() => null)) || { updates: true, loginItem: true, name: "Minima Core" };
  host.innerHTML =
    sec("This computer", `<div class="ps-sw set-sw"><span class="ps-sw__t" id="setAutostartL">Open at login</span><button class="switch switch--m2" role="switch" id="setAutostart" aria-checked="${CFG.openAtLogin ? "true" : "false"}" aria-labelledby="setAutostartL"></button></div>
      <p class="ps-note">Start Minima Core, and so your node, when you log in to this computer. It opens to the tray on Mac. Uses the login items on Mac and Windows and the autostart folder on Linux.</p>`) +
    sec("Updates", !fl.updates ? `<p class="set-text">${esc(fl.name)} does not update itself: it reads no update feed and downloads nothing. A newer build is installed by hand.</p>` : `<p class="set-text">Minima Core checks its own store feed for a newer build. Downloads are verified against the feed's sha256 and opened for you to install; nothing installs by itself.</p>
      <p class="set-text" id="updBody">Checking…</p>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="updCheck">Check now</button><button class="btn btn--primary" id="updGet" hidden>Download</button></div>
      <div class="status" id="updStatus"></div>`, "updCard") +
    sec("Node", `<p class="set-text">${kind === "parlons"
        ? "This is the <b>Parlons Node</b>: a full Minima node plus your Parlons account (chat, calls, payments) under this node's seed, and a Maxima relay when you contribute. Parlons, in the app tray, is your account."
        : "This is the <b>plain Minima node</b>. The Parlons Node is the same node plus your Parlons account under this seed: same chain, same wallet, same data folder."}</p>
      <label class="set-radio"><input type="radio" name="setKind" value="parlons" ${kind === "parlons" ? "checked" : ""}><span>Parlons Node: the node and your Parlons account (recommended)</span></label>
      <label class="set-radio"><input type="radio" name="setKind" value="minima" ${kind === "minima" ? "checked" : ""}><span>Plain Minima node: no Parlons account</span></label>
      <div class="eyebrow ps-label">Parlons Node memory (MB; 0 = automatic: 3072 with MegaMMR, else 1536)</div><input class="field__input ps-field" id="setHeap" inputmode="numeric" value="${esc(CFG.heapMb || 0)}" />
      <div class="home-actions set-actions"><button class="btn btn--outline" id="setKindApply">Apply and restart the node</button></div>
      <div class="status" id="setKindStatus"></div>`) +
    (running ? sec("Signing keys", `<p class="set-text">Each key can sign a limited number of times; reusing an exhausted one-time key can lose funds. The node rotates keys automatically. This shows your headroom.</p>
      <div class="health"><div class="health__row"><span>Most-used key</span><span>${esc(ku.used)} / ${esc(ku.cap)} sigs${ku.count ? " · " + ku.count + " keys" : ""}</span></div>
        <div class="health__track"><div class="health__fill${warn ? " health__fill--warn" : ""}" style="width:${pct}%"></div></div></div>
      ${warn ? `<div class="status status--warn">⚠ A signing key is ${pct}% used. Generate fresh keys or restore with the correct key uses before it exhausts.</div>` : ""}`) +
    sec("Address key uses", `<p class="set-text">KeyUses, in the app tray, lists every key of this node with its address and checks each against the chain for one-time signature reuse. It runs only when you press Run audit there.</p>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="kuOpen">Open KeyUses</button></div>`)
      : sec("Signing keys", `<p class="set-text">${nodeState === "stopped" ? "The node is stopped." : "Waiting for the node…"}</p>`)) +
    sec("Address labels", labelKeys.length ? labelKeys.map(a => `<div class="set-label"><div class="set-label__t"><b>${esc(labels[a])}</b><span>${esc(a)}</span></div><button class="btn btn--sm btn--outline lbl-del" data-addr="${esc(a)}">Delete</button></div>`).join("")
      : `<p class="set-text">No labels yet. Name an address on the Receive screen.</p>`) +
    sec("History", `<p class="set-text">Your transaction history is stored on this computer (the node prunes old data). Clear it if you switch wallets.</p>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="setClearHist">Clear local history</button></div>`) +
    sec("Coin guard", `<div class="ps-sw set-sw"><span class="ps-sw__t" id="setGuardL">Keep the trading engines off each other's coins</span><button class="switch switch--m2" role="switch" id="setGuard" aria-checked="${CFG.coinGuard !== false ? "true" : "false"}" aria-labelledby="setGuardL"></button></div>
      <p class="ps-note">AtomiX, PandaPools, Dexicon and the wallet spend from one wallet. With this on, a coin one of them has put into a transaction, or that backs a live Dexicon order, is refused to the others before anything is signed. Off: nothing is checked and every command passes untouched.</p>
      <div class="eyebrow ps-label">Sends and Consolidate</div>
      <select class="field__input ps-field" id="setGuardSends" aria-label="Sends and Consolidate">
        <option value="off"${CFG.coinGuardSends === "off" ? " selected" : ""}>Off: not looked at</option>
        <option value="observe"${CFG.coinGuardSends !== "off" && CFG.coinGuardSends !== "enforce" ? " selected" : ""}>Observe: sent unchanged; the Logs say what would have been pinned or refused</option>
        <option value="enforce"${CFG.coinGuardSends === "enforce" ? " selected" : ""}>Enforce: kept off held coins, or refused with the reason</option>
      </select>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="setGuardRelease">Release all holds</button></div>
      <div class="status" id="setGuardStatus"></div>`) +
    `<div id="chanceLeft"></div>`;
  const drawUpdate = (u) => {
    const b = el("updBody"), g = el("updGet"); if (!b) return;
    if (u.error && !u.available) b.textContent = "Could not read the feed (" + u.error + "). Running v" + u.running + ".";
    else if (u.available) b.innerHTML = "<b>Minima Core " + esc(u.version) + "</b> is available (you run v" + esc(u.running) + ")" + (u.date ? " · " + esc(u.date) : "") + (u.notes ? "<br>" + esc(u.notes) : "") + (u.downloaded ? "<br>Downloaded to " + esc(u.downloaded) : "");
    else b.textContent = "You run the newest build, v" + u.running + (u.checkedAt ? " (checked " + new Date(u.checkedAt).toLocaleTimeString() + ")" : "") + ".";
    g.hidden = !u.available;
  };
  if (fl.updates) api.updateStatus().then(drawUpdate).catch(() => {});
  if (el("updCheck")) el("updCheck").onclick = async () => { el("updStatus").textContent = "Checking…"; try { const u = await api.updateCheck(); drawUpdate(u); el("updStatus").textContent = ""; } catch (e) { el("updStatus").textContent = e.message || String(e); } };
  if (el("updGet")) el("updGet").onclick = async () => {
    el("updGet").disabled = true; el("updStatus").textContent = "Downloading — the file is verified against the feed before it is saved…";
    try { const r = await api.updateDownload(); el("updStatus").textContent = "Saved and verified: " + r.path + " — install it over this app, then relaunch."; drawUpdate(r.status); }
    catch (e) { el("updStatus").textContent = e.message || String(e); }
    el("updGet").disabled = false;
  };
  el("setKindApply").onclick = async () => {
    const want = (host.querySelector('input[name="setKind"]:checked') || {}).value === "minima" ? "minima" : "parlons";
    const heapMb = Math.max(0, parseInt(el("setHeap").value, 10) || 0);
    const stat = el("setKindStatus");
    el("setKindApply").disabled = true; stat.textContent = "Restarting the node…";
    try {
      CFG = await api.saveConfig({ heapMb });
      await api.setNodeKind(want);
      CFG = await api.getConfig();
      stat.textContent = want === "parlons" ? "Parlons Node starting. Open Parlons from the app tray." : "Plain Minima node starting.";
      toast("Node restarting…", "ok");
    } catch (e) { stat.textContent = e.message || String(e); toast(e.message || String(e), "err"); }
    el("setKindApply").disabled = false;
  };
  host.querySelectorAll(".lbl-del").forEach(btn => btn.onclick = async () => {
    const nl = Object.assign({}, CFG.labels); delete nl[btn.dataset.addr];
    CFG = await api.saveConfig({ labels: nl }); toast("Label removed", "ok"); renderSettings();
  });
  el("setClearHist").onclick = async () => { await api.histClear(); toast("Local history cleared ✓", "ok"); };
  el("setGuard").onclick = async () => { CFG = await api.saveConfig({ coinGuard: CFG.coinGuard === false }); toast(CFG.coinGuard !== false ? "Coin guard on" : "Coin guard off: nothing is checked", CFG.coinGuard !== false ? "ok" : "warn"); renderSettings(); };
  el("setGuardSends").onchange = async () => { CFG = await api.saveConfig({ coinGuardSends: el("setGuardSends").value }); toast("Sends and Consolidate: " + CFG.coinGuardSends, "ok"); };
  el("setGuardRelease").onclick = async () => {
    if (!await showConfirm("Release all holds?", "Every coin the app is holding for a swap, a pool transaction or an order is released at once. The record of them is kept beside the new one under a dated name; nothing is deleted.\n\nThis cannot spend a coin twice: the node itself refuses a second spend. A transaction still being built may then fail and can be tried again. The coins of an order that is still live are held again within a minute; cancel the order to free them.", "Release all", true)) return;
    try { const r = await api.reserveReleaseAll(); el("setGuardStatus").textContent = r.released + (r.released === 1 ? " hold" : " holds") + " released."; toast("Holds released", "ok"); }
    catch (e) { el("setGuardStatus").textContent = e.message || String(e); }
  };
  el("setAutostart").onclick = async () => {
    const on = !CFG.openAtLogin;
    CFG = await api.saveConfig({ openAtLogin: on });
    const li = CFG.loginItem || {};
    if (li.ok === false) toast((on ? "Saved, but not registered: " : "Saved, but could not unregister: ") + (li.note || "unknown error"), "warn");
    else toast(on ? "Minima Core will open when you log in ✓" : "Minima Core will no longer open at login", "ok");
    renderSettings();
  };
  chanceLeftCard();
  if (el("kuOpen")) el("kuOpen").onclick = () => selectTab("keyuses");
}
function keysInfo(keys) {
  try {
    const arr = Array.isArray(keys) ? keys : (keys && keys.keys) || [];
    let used = 0, cap = 0;
    for (const k of arr) { used = Math.max(used, parseInt(k.uses, 10) || 0); cap = Math.max(cap, parseInt(k.maxuses, 10) || 0); }
    return { used, cap: cap || 262144, count: arr.length };
  } catch (e) { return { used: 0, cap: 262144, count: 0 }; }
}
// ---- Send ------------------------------------------------------------------
async function renderSend() {
  const card = el("sendCard");
  if (!running) { card.innerHTML = waitHtml(); return; }
  // token dropdown source — the wallet's held coins/tokens (MINIMA first). No raw token-id typing.
  const bal = await tryCmd("balance") || [];
  await loadHeld();   // sendable here is what the WALLET can send: less what AtomiX, PandaPools and Dexicon hold
  SEND_TOKENS = bal.map(b => ({ tokenid: b.tokenid || MINIMA, name: TOK.tokenName(b.token, b.tokenid), sendable: freeOf(b), held: heldLine(b.tokenid || MINIMA),
    ticker: (b.tokenid || MINIMA) === MINIMA ? "MINIMA" : (TOK.ticker(b.token) || "") }));
  if (!SEND_TOKENS.some(t => t.tokenid === MINIMA)) SEND_TOKENS.unshift({ tokenid: MINIMA, name: "Minima", sendable: "0", ticker: "MINIMA" });
  SEND_TOKENS.sort((a, b) => (a.tokenid === MINIMA ? -1 : b.tokenid === MINIMA ? 1 : 0));
  card.innerHTML = `<div id="sendForm"></div>`;
  sendForm();
}
// The phone's Send screen (view_wallet_send): Token, sendable, Amount with Max, To address, Send Funds. The
// phone's Scan button is left out. The checks and the command below are the desktop's own, unchanged since 0.18.78.
function sendForm() {
  const f = el("sendForm");
  {
    // Preselect the token if we arrived from a token page's "Send" action.
    const preselect = SEND_PRESELECT; SEND_PRESELECT = null;
    f.innerHTML = `
      <label class="eyebrow" for="sTok">Token</label>
      <select class="send-tok" id="sTok">${tokenOptions()}</select>
      <div class="send-avail" id="sAvail"></div>
      <label class="eyebrow" for="sAmt">Amount</label>
      <div class="send-line"><input class="send-in" id="sAmt" placeholder="0.0" inputmode="decimal" autocomplete="off" /><button class="btn btn--outline" id="sMax" type="button">Max</button></div>
      <label class="eyebrow" for="sTo">To address</label>
      <div class="send-line"><textarea class="send-in" id="sTo" rows="1" placeholder="Mx… or 0x…" autocomplete="off" spellcheck="false"></textarea></div>
      <button class="btn btn--primary send-go" id="sGo">Send Funds</button>`;
    // The address wraps so a pasted one can be read end to end before sending; Enter does not add a line.
    const grow = () => { const t = el("sTo"); t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };
    el("sTo").oninput = grow;
    el("sTo").onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
    if (preselect) el("sTok").value = preselect;
    const tokOf = (tid) => SEND_TOKENS.find(x => x.tokenid === tid) || {};
    const sendableOf = (tid) => tokOf(tid).sendable || "0";
    const refreshAvail = () => {
      const t = tokOf(el("sTok").value);
      el("sAvail").textContent = "sendable " + TOK.tidyAmount(t.sendable || "0") + (t.held ? "  ·  " + t.held : "");
    };
    el("sTok").onchange = refreshAvail;
    el("sMax").onclick = () => { el("sAmt").value = TOK.tidyAmount(sendableOf(el("sTok").value)); };
    refreshAvail();
    el("sGo").onclick = async () => {
      const to = el("sTo").value.trim(), amt = el("sAmt").value.trim(), tok = el("sTok").value;
      if (!validAddr(to)) { toast("That doesn't look like a valid Mx… / 0x… address.", "err"); return; }
      if (!validAmt(amt)) { toast("Enter a positive amount (digits only).", "err"); return; }
      if (!validTok(tok)) { toast("Token id must be a 0x… hex value.", "err"); return; }
      const avail = sendableOf(tok);
      if (absCmp(amt, avail) > 0) { toast("Amount exceeds your spendable balance (" + TOK.tidyAmount(avail) + "). " + (tokOf(tok).held ? "Not sendable now: " + tokOf(tok).held + ". Nothing was sent." : "The rest is locked in scripts/pools."), "err"); return; }
      el("sGo").disabled = true; el("sGo").textContent = "Sending…";
      try {
        const chk = await tryCmd(`checkaddress address:${to}`);   // reject a malformed/unparseable recipient
        if (!chk) { toast("Couldn't validate the address (node busy?). Not sending.", "err"); el("sGo").disabled = false; el("sGo").textContent = "Send Funds"; return; }
        // Review before it leaves. Every OTHER send in this app confirms first — minimaMail pay, ETH send,
        // AtomiX swap, the PandaPools actions, Vestr — and this is the one people use most. The recipient is
        // shown IN FULL so a mistyped or clipboard-swapped address has somewhere to be caught.
        const tname = tokOf(tok).name || (tok === MINIMA ? "MINIMA" : tok);
        if (!await showConfirm(`Send ${amt} ${tname}?`,
              `To\n${to}\n\nAmount\n${amt} ${tname}\n\nCheck the address above. This sends real funds and cannot be undone.`,
              "Send now", false)) {
          el("sGo").disabled = false; el("sGo").textContent = "Send Funds"; return;
        }
        const r = await cmd(`send address:${to} amount:${amt}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : ""));
        toast("Sent ✓ " + ((r && r.txpowid) || ""), "ok", (r && r.txpowid) || null); el("sTo").value = el("sAmt").value = ""; refreshAvail();
      } catch (e) { toast(e.message, "err"); }
      el("sGo").disabled = false; el("sGo").textContent = "Send Funds";
    };
  }
}

// ---- Node (status / config / update / logs) --------------------------------

/**
 * The "Network help" line for a contributing node.
 *
 * Only ONE thing proves inbound works: a real incoming peer. A router accepting the port mapping proves
 * nothing — verified on a Plusnet Hub Two, which stores the mapping with Enabled=1 and still leaves the
 * port shut. So the mapped copy says "asked your router", never "the port is open".
 *
 * We need no reachability service of our own: the Minima network IS the dial-back. A peer that learns our
 * address queues the connect-back immediately (P2PPeersChecker posts PEERS_CHECKPEERS as a Message, not a
 * timer), so a working setup shows incoming peers within seconds-to-minutes. That makes silence meaningful:
 * we hint at HINT_MS, and state it firmly once the jar's own hourly check has flipped isAcceptingInLinks off.
 */
const CONTRIB_HINT_MS = 15 * 60_000;

/** RFC1918 + CGNAT + link-local + loopback — i.e. not an address the outside world can reach. */
function isPrivateAddr(a) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
    .test(String(a || ""));
}

function contribHelp(s, h, pm) {
  const port = CFG.basePort;
  if ((h.incoming || 0) > 0)
    return { color: "var(--green)", text: "● Reachable — " + h.incoming + " incoming peer" + (h.incoming === 1 ? "" : "s") };
  if (pm.state === "double_nat")
    return { color: "var(--amber)", text: "Your router is behind another one (carrier-grade NAT), so other nodes can't dial in. You still help by relaying blocks and transactions." };
  if (pm.state === "mapped") {
    const up = s.uptimeMs || 0;
    if (h.acceptingInLinks === false && up > 70 * 60_000)
      return { color: "var(--amber)", text: "Your router accepted the request but nothing is getting through — some routers report success without actually opening the port. You'll need to forward it yourself. You're still helping by relaying meanwhile.", howto: true };
    if (up > CONTRIB_HINT_MS)
      return { color: "var(--amber)", text: "No incoming peers yet. Other nodes normally dial back within minutes, so your router may have accepted the request without really opening the port — if this sticks, forward it yourself.", howto: true };
    return { color: "", text: "Asked your router to open port " + port + " — not confirmed yet. Waiting for the first incoming peer." };
  }
  if (pm.state === "searching") return { color: "", text: "Asking your router to open port " + port + "…" };
  if (pm.state === "no_gateway")
    return { color: "var(--amber)", text: "Your router didn't answer — automatic port opening (UPnP/NAT-PMP) is off or blocked. You can forward the port yourself, or keep helping as an outbound node.", howto: true };
  if (pm.state === "mapping_refused")
    return { color: "var(--amber)", text: "Your router refused to open port " + port + " — UPnP may be disabled, or that port is already forwarded to another device.", howto: true };
  if (pm.state === "error") return { color: "var(--amber)", text: "Port mapping error — retrying automatically." };
  return { color: "", text: "starting…" };
}

/**
 * The manual port-forward instructions. Automatic opening fails on a lot of home routers — silently, in
 * the Hub-2 case — so "forward it yourself" has to be a real answer, not a brush-off. Everything here is
 * discovered from the machine and the router (portmap.discoverHostInfo), so the user gets their own
 * numbers to copy rather than a generic doc telling them to go find them.
 */
function forwardHowTo(pm) {
  const port = CFG.basePort;
  const lan = pm.lanIp || "this Mac's IP address";
  const router = pm.routerName ? esc(pm.routerName) : "your router";
  const admin = pm.gatewayIp ? `<a href="http://${esc(pm.gatewayIp)}" target="_blank">http://${esc(pm.gatewayIp)}</a>` : "your router's admin page";
  return `<div class="howto">
    <div class="howto__h">How to open port ${esc(port)} yourself</div>
    <div class="howto__b">In ${router}'s settings (${admin}), find <b>Port forwarding</b> and add:</div>
    <div class="kv"><span class="kv__k">Protocol</span><span class="kv__v">TCP</span></div>
    <div class="kv"><span class="kv__k">External port</span><span class="kv__v">${esc(port)}</span></div>
    <div class="kv"><span class="kv__k">Internal port</span><span class="kv__v">${esc(port)}</span></div>
    <div class="kv"><span class="kv__k">Send to</span><span class="kv__v">${esc(lan)} (this Mac)</span></div>
    <div class="howto__b">Also reserve <b>${esc(lan)}</b> for this Mac in your router's DHCP settings — otherwise the
      address can change and the forward will quietly stop working.${pm.routerName ? ` Searching for “${router} port forwarding” will show the exact screens.` : ""}</div>
  </div>`;
}

// The phone's dashboard reads (HomeView.readDashboard): `keys` for the most-used key, `peers` for one peer
// picked at random, `network` for the live connection and incoming counts. Read-only, at most every 30 s
// while the Node tab is showing; the values are kept so a status push does not blank them.
let NODE_DASH = {}, NODE_DASH_AT = 0;
async function refreshNodeDash() {
  if (Date.now() - NODE_DASH_AT < 30000) return;
  NODE_DASH_AT = Date.now();
  const [keys, peers, net] = await Promise.all([tryCmd("keys"), tryCmd("peers"), tryCmd("network")]);
  const d = {};
  const ku = maxKeyUses(keys); if (ku != null) d.keyuses = ku;
  if (peers) { const list = String(peers.peerslist || "").split(",").filter(Boolean); d.peer = list.length ? list[Math.floor(Math.random() * list.length)] : "No peers"; }
  if (net) {
    const det = net.details || {}, self = String((det.p2p && det.p2p.address) || "").split(":")[0];
    if (det.connected != null) d.connected = det.connected;
    // incoming peers, minus a hairpinned dial back to this node's own address (same rule as the phone and main/node-manager.js)
    if (Array.isArray(net.connections)) d.incoming = net.connections.filter(c => c && c.incoming === true && String(c.host || "") !== self).length;
  }
  NODE_DASH = Object.assign({}, NODE_DASH, d);
  if (activeView === "node" && running) api.nodeStatus().then(renderNode);
}
function renderNode(s) {
  s = s || { state: "?", health: null };
  const c = el("nodeCard");
  const h = s.health || {};
  const pm = s.portmap || {};
  const contributing = !!s.contribute;
  const help = contributing ? contribHelp(s, h, pm) : null;
  // The jar seeds its advertised address from a LAN guess and only learns the real one from the peer
  // req_ip/res_ip exchange, so for the first minutes p2pAddress is a private IP — never label that "public".
  const p2pIp = String(h.p2pAddress || "").split(":")[0];
  const showAddr = !!p2pIp && !isPrivateAddr(p2pIp);
  const addrOk = showAddr && !!pm.externalIp && p2pIp === pm.externalIp;
  // Laid out as the phone's Node tab (view_home.xml): NODE, then IDENTITY. The desktop's own controls follow.
  const up = s.state === "running";
  const status = up ? "Online" : s.state === "starting" ? "Waiting for node" : s.state === "error" ? "Error" : s.state === "stopped" ? "Stopped" : s.state === "stopping" ? "Stopping" : String(s.state);
  const when = blockTime(h.time);
  const D = up ? NODE_DASH : {};
  const row = (k, v, extra) => `<div class="home-row"${extra || ""}><span class="home-row__k">${k}</span><span class="home-row__v">${v}</span></div>`;
  c.innerHTML = `
    <div class="eyebrow home-eyebrow">Node</div>
    <div class="card home-card">
      <div class="home-row" data-state="${esc(s.state)}"><i class="home-dot"></i><span class="home-row__k">Status</span><span class="home-row__v home-status">${esc(status)}</span></div>
      ${row("Block", esc(up ? (h.block ?? "") : ""))}
      ${row("Block time", esc(up ? when : ""))}
      ${row("Connections", esc(up ? (D.connected ?? h.connections ?? "") : ""))}
      ${row("Incoming", esc(D.incoming ?? ""))}
      ${row("Random peer", esc(D.peer ?? ""))}
    </div>
    <div class="eyebrow home-eyebrow">Identity</div>
    <div class="card home-card">
      <div class="home-cap">Key uses</div>
      <div class="home-num">${esc(D.keyuses ?? (up ? "Connecting…" : ""))}</div>
      ${row("Minima", esc(h.version || ""))}
      ${row("App version", esc(APP_VERSION))}
    </div>
    <div class="eyebrow home-eyebrow">This computer</div>
    <div class="card home-card">
    ${row("Role", contributing ? "Contributing (server)" : "Light wallet")}
    ${help ? `<div class="home-row"><span class="home-row__k">Network help</span><span class="home-row__v"${help.color ? ` style="color:${help.color}"` : ""}>${esc(help.text)}</span></div>` : ""}
    ${help && help.howto ? forwardHowTo(pm) : ""}
    ${contributing && showAddr ? row("Public address", esc(h.p2pAddress) + (addrOk ? " ✓" : "")) : ""}
    ${row("Network", esc(CFG.network))}
    ${row("RPC port", esc(s.rpcPort || CFG.basePort + 4))}
    ${s.lastError ? `<div class="home-row"><span class="home-row__k">Error</span><span class="home-row__v" style="color:var(--red)">${esc(s.lastError)}</span></div>` : ""}
    ${s.portOwner ? row("Port " + esc(s.portOwner.port || CFG.basePort) + " held by", "pid " + esc(s.portOwner.pid) + " · " + esc(s.portOwner.command)) : ""}
    <div class="home-actions">
      <button class="btn btn--outline" id="nRestart">${s.state === "stopped" ? "Start node" : "Restart node"}</button>
      ${s.state === "error" ? `<button class="btn btn--outline" id="nReclaim">Start again</button>` : ""}
      ${CFG.network !== "solo" ? `<button class="btn btn--outline" id="nContrib">${contributing ? "Stop contributing to the network" : "Contribute to the network"}</button>` : ""}
      <button class="btn btn--outline" id="nReconfig">Reconfigure node</button>
    </div>
    </div>`;
  if (up) refreshNodeDash();
  const nContrib = el("nContrib");
  if (nContrib) nContrib.onclick = async () => {
    const turnOn = !contributing;
    const msg = turnOn
      ? "Contribute to the network?\n\nYour node will accept incoming connections and help other nodes sync. This asks your router to open TCP " + CFG.basePort + " (UPnP), keeps ~50 days of block history (a one-time extra download), and restarts the node now.\n\nNot all routers allow this. If yours doesn't, you'll still help by relaying."
      : "Stop contributing?\n\nYour node goes back to a light wallet (outbound connections only), the router port is closed, and the node restarts now.";
    if (!await showConfirm(turnOn ? "Contribute to the network?" : "Stop contributing?",
        msg.slice(msg.indexOf("\n\n") + 2), turnOn ? "Contribute" : "Stop", !turnOn)) return;
    const params = Object.assign({}, CFG.params, turnOn ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
    CFG = await api.saveConfig({ contribute: turnOn, params });
    toast(turnOn ? "Contributing. Restarting node…" : "Back to light wallet. Restarting node…");
    api.nodeRestart();
  };
  el("nReconfig").onclick = () => selectTab("params");
  el("nRestart").onclick = () => { toast("Restarting node…"); api.nodeRestart(); };
  const nReclaim = el("nReclaim");
  if (nReclaim) nReclaim.onclick = async () => { nReclaim.disabled = true; nReclaim.textContent = "Starting…"; try { await api.nodeReclaim(); toast("Node restarting…", "ok"); } catch (e) { toast(e.message || String(e), "err"); } };
  // The in-app jar updater is disabled — the node jar ships with the app. See main/updater.js.
  paintLogs();   // refresh the Node-tab log pane now that this view is active
}

let logLines = [];
const LOG_MAX = 2000;       // lines kept for the Node tab's box and the Logs screen (the main process holds 800 and the whole log on disk)
const LOGS_CHARS = 30000;   // the Logs screen shows at most this much text, as the phone's LogsView
const LOGS_CHIPS = [["scripts", "Scripts"], ["mining", "Mining"], ["blocks", "Blocks"], ["networking", "Networking"], ["ibd", "Initial block download (IBD)"], ["maxima", "Maxima"]];
let logsPaused = false, logsFilter = "", logsSeeded = false, logsOn = {};
async function initLogs() { logLines = await api.nodeLogs(); paintLogs(); }
/** The text of the Logs screen: the lines that match the filter (any case), joined, and of that the last 30,000 characters. */
function logsRender(lines, filter) { const f = String(filter || "").toLowerCase(); return (f ? lines.filter(l => String(l).toLowerCase().includes(f)) : lines).join("\n").slice(-LOGS_CHARS); }
/** One more line on the text already shown (LogsView: over the limit, the last 30,000 characters and the line; else the line appended). */
function logsAppend(text, line) { return text.length > LOGS_CHARS ? text.slice(-LOGS_CHARS) + "\n" + line : (text ? text + "\n" : "") + line; }
function appendLog(line) {
  if (!line) return; logLines.push(line); if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  const nodeBox = el("logbox"); if (nodeBox && viewActive("node")) { nodeBox.textContent = logLines.join("\n"); nodeBox.scrollTop = nodeBox.scrollHeight; }
  const box = el("logsBox");
  if (!box || !viewActive("logs") || logsPaused) return;   // paused: live lines are not drawn; Resume draws the whole buffer again
  if (logsFilter && !String(line).toLowerCase().includes(logsFilter.toLowerCase())) return;
  box.textContent = logsAppend(box.textContent, line);     // textContent only: a log line can carry a peer's text
  el("logsScroll").scrollTop = el("logsScroll").scrollHeight;
}
function viewActive(v) { const s = document.getElementById("view-" + v); return !!(s && s.classList.contains("view--active")); }
function paintLogs() {
  const nodeBox = el("logbox"); if (nodeBox && viewActive("node")) { nodeBox.textContent = logLines.join("\n"); nodeBox.scrollTop = nodeBox.scrollHeight; }
  const box = el("logsBox");
  if (box && viewActive("logs")) { box.textContent = logsRender(logLines, logsFilter); el("logsScroll").scrollTop = el("logsScroll").scrollHeight; }
}
/** The node's answer to `logs` says what it logs now: the chips follow it, never the click. */
function logsSync(r) {
  const resp = r && r.status !== false && r.response && typeof r.response === "object" ? r.response : null; if (!resp) return false;
  for (const [k] of LOGS_CHIPS) if (k in resp) logsOn[k] = resp[k] === true || resp[k] === "true";
  return true;
}
function paintLogChips() {
  el("logsChips").innerHTML = LOGS_CHIPS.map(([k, label]) => `<button class="logs-chip${logsOn[k] ? " logs-chip--on" : ""}" role="switch" aria-checked="${!!logsOn[k]}" data-logchip="${k}"${running ? "" : " disabled"}>${label}</button>`).join("");
  el("logsChips").querySelectorAll("[data-logchip]").forEach(c => { c.onclick = async () => {
    const k = c.dataset.logchip; c.disabled = true;
    const r = await tryCmd("logs " + k + ":" + (logsOn[k] ? "false" : "true"));
    if (!logsSync({ response: r })) toast("The node did not answer.", "warn");
    paintLogChips(); const again = el("logsChips").querySelector(`[data-logchip="${k}"]`); if (again) again.focus();
  }; });
}
// ---- Logs (overflow menu): Pandamonium's LogsView over the node's output ----
async function renderLogs() {
  logLines = await api.nodeLogs();
  paintLogs();
  el("logsPause").textContent = logsPaused ? "Resume" : "Pause";
  el("logsPause").onclick = () => { logsPaused = !logsPaused; el("logsPause").textContent = logsPaused ? "Resume" : "Pause"; if (!logsPaused) paintLogs(); };
  el("logsClear").onclick = () => { logLines = []; paintLogs(); };
  el("logsFilter").value = logsFilter;
  el("logsFilter").oninput = () => { logsFilter = el("logsFilter").value; paintLogs(); };
  el("logsSave").onclick = async () => {
    const text = el("logsBox").textContent; if (!text.trim()) return;   // as the phone's Share: nothing to share, nothing happens
    try { const p = await api.logsSave(text); if (p) toast("Saved to " + p, "ok"); } catch (e) { toast("Could not save: " + ipcError(e), "warn"); }
  };
  paintLogChips();
  if (running && !logsSeeded) { logsSeeded = logsSync({ response: await tryCmd("logs") }); paintLogChips(); }   // what the node logs now
}

boot();
initLogs();

// ---- AtomiX: room ① of Dexicon (renderer/dexicon-ax.js) over the window.mcd ax* calls. The panel it replaced
// (renderer/atomix-ui.js) was removed in 0.18.141 after the parity audit (docs/DEXICON_PARITY_AUDIT.md).
DexPools.init({ api, copy, tryCmd, TOK, redraw: DexUI.redraw, consolidateToken, showCoins, PoolCalc, running: () => running, dialog: DexUI.dialog, money: DexUI.money, go: DexUI.pickTab, where: DexUI.where, start: () => { toast("Starting the node…"); api.nodeStart(); } });
DexAx.init({ api, copy, relTime, exportKey: ewExportKey, consolidateToken, money: DexUI.money, running: () => running, dialog: DexUI.dialog, repaintStrip: DexUI.paintStrip, go: DexUI.pickTab, say: DexUI.say, redraw: DexUI.redraw, where: DexUI.where, start: () => { toast("Starting the node…"); api.nodeStart(); } });
function onAtomixUpdate() { DexAx.onUpdate(); }
function resetAxState() { DexAx.reset(); }

// ---- dialogs of the integrated apps (ETH Wallet, Vestr, miniMall): Material 3 dark, as their Android originals ----
// o = { title, body (html), cls, sticky (no Escape / outside click), buttons: [{ label, v, neutral, on(root, close) }] }.
// A button with `on` closes the dialog itself (close(value)); any other closes it with its `v`. → { root, done, close }.
let ADLG_N = 0;
function appDlg(o) {
  const opener = document.activeElement, id = "adlg" + (++ADLG_N), buttons = o.buttons || [{ label: "Close", v: null }];
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay overlay--adlg" id="${id}" data-modal><div class="adlg ${o.cls || ""}" role="dialog" aria-modal="true" aria-labelledby="${id}T" tabindex="-1">
    <h2 class="adlg__title" id="${id}T">${esc(o.title)}</h2><div class="adlg__body">${o.body || ""}</div>
    <div class="adlg__btns">${buttons.map((b, i) => `<button class="adlg__btn${b.neutral ? " adlg__btn--neutral" : ""}" data-v="${i}">${esc(b.label)}</button>`).join("")}</div></div></div>`);
  const root = el(id); let res; const done = new Promise(r => { res = r; });
  const close = (v) => { if (!root.isConnected) return; root.remove(); if (opener && opener.isConnected) opener.focus(); res(v === undefined ? null : v); };
  root.onclick = (e) => {
    if (e.target === root) { if (!o.sticky) close(null); return; }
    const b = e.target.closest(".adlg__btn"); if (!b) return;
    const def = buttons[+b.dataset.v];
    if (def.on) def.on(root, close); else close(def.v === undefined ? def.label : def.v);
  };
  root.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); if (!o.sticky) close(null); } };
  (root.querySelector(".adlg__body input, .adlg__body textarea") || root.querySelector(".adlg")).focus();
  return { root, done, close };
}
/** A dialog that is a list to pick from (Android's setItems). → the picked index, or null. */
function appPick(title, items) {
  const d = appDlg({ title, cls: "adlg--list", body: items.map((t, i) => `<button class="adlg__item" data-i="${i}">${esc(t)}</button>`).join(""), buttons: [{ label: "Cancel", v: null }] });
  d.root.querySelectorAll(".adlg__item").forEach(b => { b.onclick = (e) => { e.stopPropagation(); d.close(+b.dataset.i); }; });
  return d.done;
}
/** Enter and Space press a card that is drawn as a button. */
function cardKeys(host) { host.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[role=button]")) { e.preventDefault(); e.target.click(); } }; }

// ============================ ETH Wallet ============================
// The screens of the Android ETH Wallet as Pandamonium shows it (apks/base integrated/ethwallet, MainActivity.render and its
// dialogs; Design.java), over main/ethwallet.js: the SAME seed-derived address Dexicon ① MxUSD (AtomiX) swaps with. Every
// call that spends or shows the key is in renderer/apps-act.js (AppsAct.eth), pinned by scripts/apps-money.test.cjs.
// Not here, on purpose: "Import key". On the phone it gives ETH Wallet a key of its own; here there is one engine and
// one key, and replacing it would orphan swaps in flight.
let ewStatusCache = { ready: false };
let ewUpdateTimer = null, ewAt = 0;
const EW_ETHERSCAN = "https://etherscan.io/";
const EW_DISC = { USDT: "#26A17B", USDC: "#2775CA", DAI: "#F5AC37" };
function resetEwState() { ewStatusCache = { ready: false }; ewAt = 0; }

/** At most six decimals, cut and never rounded, trailing zeros dropped (the phone's balance format). */
function ewCut(s) { s = String(s == null ? "" : s); const i = s.indexOf("."); return TOK.tidyAmount(i < 0 ? s : s.slice(0, i + 7)) || "0"; }
function ewEthIcon() { return `<span class="ew-ic ew-ic--eth" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M16 3 8.5 16 16 20.4 23.5 16z" fill="#343434"/><path d="M16 3v17.4L23.5 16z" fill="#8C8C8C"/><path d="M8.5 17.6 16 29l7.5-11.4L16 22z" fill="#3C3C3B"/><path d="M16 22v7l7.5-11.4z" fill="#8C8C8C"/></svg></span>`; }
// The phone loads each token's logo from a CDN and shows this disc until it arrives; the desktop makes no such request.
function ewTokIcon(sym) { return sym === "WETH" ? ewEthIcon() : `<span class="ew-ic" aria-hidden="true" style="background:${Object.hasOwn(EW_DISC, sym) ? EW_DISC[sym] : "#1F1F2B"}">${esc(String(sym || "?").slice(0, 2))}</span>`; }
function ewOpen(url) { if (url.startsWith(EW_ETHERSCAN)) window.open(url, "_blank", "noreferrer"); }   // the main process opens nothing but etherscan.io
/** An address in full, monospace, its first 8 and last 6 characters in the accent (the phone's confirm blocks). */
function ewBlock(a) { a = String(a || ""); return a.length < 16 ? `<div class="ew-block">${esc(a)}</div>` : `<div class="ew-block"><b>${esc(a.slice(0, 8))}</b>${esc(a.slice(8, -6))}<b>${esc(a.slice(-6))}</b></div>`; }

async function renderEthWallet() {
  const host = el("ewBody"); if (!host) return;
  const st = await api.ewStatus().catch(() => ({ ready: false }));
  ewStatusCache = st;
  const head = (upd) => `<div class="ew-hd"><h1 class="ew-title">ETH Wallet</h1><span class="ew-pill ew-pill--net">Mainnet · real funds</span></div>
    <div class="ew-sub">v${esc(APP_VERSION)}  ·  node-derived${upd ? "  ·  updated " + esc(since(ewAt)) : ""}</div>`;
  if (!st.ready) {
    host.innerHTML = `<div class="ew">${running ? "" : `<button class="ew-banner" id="ewRetry">The node is not running. Start it on the Node tab, then come back: this wallet sets itself up.</button>`}
      ${head(false)}<div class="ew-line">${st.frozen ? "Dexicon is frozen. Unfreeze it on the Apps tab to use this wallet." : "Setting up wallet…"}</div>
      ${running && !st.frozen ? `<div class="ew-note">The key is derived from this node (the same one Dexicon ① MxUSD swaps with). The node must be running and unlocked.</div>
      <div class="ew-acts"><button class="ew-pill ew-act" id="ewRetry">↻  Refresh</button></div>` : ""}</div>`;
    if (el("ewRetry")) el("ewRetry").onclick = () => { toast("Retrying…"); renderEthWallet(); };
    return;
  }
  const read = await api.ewBalances().catch(() => null);
  if (read) ewAt = Date.now();
  // no answer from the Ethereum RPC: the screen is still drawn, with "Not read yet" where a balance would be (the phone draws a dash there)
  const b = read || { address: st.address || "", eth: null, tokens: (await api.ewTokens().catch(() => [])).map(t => Object.assign({ balance: null }, t)) };
  const val = (v, sym) => (v == null ? "Not read yet" : ewCut(v) + " " + sym);
  const asset = (key, icon, title, value, menu) => `<div class="ew-card ew-asset" role="button" tabindex="0" data-ewasset="${esc(key)}">${icon}
      <div class="ew-asset__main"><div class="ew-asset__t">${esc(title)}</div><div class="ew-asset__v">${esc(value)}</div></div>
      ${menu ? `<button class="ew-more" data-ewmenu="${esc(key)}" aria-label="Options for ${esc(menu)}" title="Token options">⋮</button>` : ""}</div>`;
  host.innerHTML = `<div class="ew">${head(!!ewAt)}
    ${st.halt ? `<div class="ew-warn">⚠ Dexicon ① MxUSD is halted: this node's keys are not the ones it saved. Read its notice before sending anything from here.</div>` : ""}
    <div class="ew-card ew-addr" role="button" tabindex="0" id="ewAddrCard"><div class="ew-asset__t">Your address  ·  click to receive</div><div class="ew-addr__v">${esc(b.address)}</div></div>
    ${asset("eth", ewEthIcon(), "Ethereum", val(b.eth, "ETH"))}
    ${read ? "" : `<div class="ew-warn">⚠ RPC: the Ethereum endpoints did not answer. Refresh, or set another one in Settings.</div>`}
    ${b.tokens.map(t => asset(t.address, ewTokIcon(t.symbol), t.address, val(t.balance, t.symbol), t.symbol)).join("")}
    <div class="ew-acts"><button class="ew-pill ew-act" id="ewSend">↑  Send</button><button class="ew-pill ew-act" id="ewReceive">↓  Receive</button><button class="ew-pill ew-act" id="ewRefresh">↻  Refresh</button></div>
    <div class="ew-acts ew-acts--2"><button class="ew-pill ew-act" id="ewAddTok">+  Add token</button><button class="ew-pill ew-act" id="ewScanSite">↗  Etherscan</button><button class="ew-pill ew-act" id="ewSettings">⚙  Settings</button></div></div>`;
  cardKeys(host);
  const send = (key) => { if (!read) { toast("The balances have not been read yet. Refresh first.", "warn"); return; } ewSendDialog(b, key); };
  el("ewAddrCard").onclick = () => ewReceive(b.address);
  el("ewSend").onclick = () => send("eth");
  el("ewReceive").onclick = () => ewReceive(b.address);
  el("ewRefresh").onclick = () => { toast("Refreshing…"); renderEthWallet(); };
  el("ewAddTok").onclick = () => ewAddTokenDialog();
  el("ewScanSite").onclick = () => ewOpen(EW_ETHERSCAN + "address/" + b.address);
  el("ewSettings").onclick = () => ewSettingsDialog(b);
  host.querySelectorAll("[data-ewasset]").forEach(c => {
    c.onclick = (e) => { if (e.target.closest("[data-ewmenu]")) return; send(c.dataset.ewasset); };
    if (c.dataset.ewasset !== "eth") c.oncontextmenu = (e) => { e.preventDefault(); ewTokenMenu(b, c.dataset.ewasset); };   // the phone's long press
  });
  host.querySelectorAll("[data-ewmenu]").forEach(m => { m.onclick = (e) => { e.stopPropagation(); ewTokenMenu(b, m.dataset.ewmenu); }; });
}

function ewReceive(addr) {
  let qr = "";
  if (typeof qrcode !== "undefined") { const q = qrcode(0, "M"); q.addData(addr); q.make(); qr = `<div class="ew-qr">${q.createImgTag(5, 0)}</div>`; }
  appDlg({ title: "Receive", body: `${qr}<div class="ew-mono ew-sel">${esc(addr)}</div><div class="ew-fine">Same address on all EVM networks. Send only Ethereum-mainnet assets here.</div>`,
    buttons: [{ label: "Close", v: null }, { label: "Copy", on: () => { api.clip(addr); toast("Address copied", "ok"); } }] });
}

function ewSendDialog(b, startAsset) {
  const assets = [{ key: "eth", sym: "ETH", label: "ETH · Ethereum", bal: b.eth }].concat(b.tokens.map(t => ({ key: t.address, sym: t.symbol, label: t.symbol + " · " + t.address, bal: t.balance })));
  let cur = assets.find(a => a.key === startAsset) || assets[0], busy = false;
  const d = appDlg({ title: "Send", body: `<button class="ew-tokline" id="ewTokLine"></button>
      <input class="adlg__in ew-mono" id="ewTo" placeholder="Recipient 0x…" aria-label="Recipient address" autocomplete="off" spellcheck="false" />
      <div><button class="ew-pill" id="ewScan">⌗  Scan QR</button></div>
      <input class="adlg__in" id="ewAmt" placeholder="Amount" aria-label="Amount" inputmode="decimal" autocomplete="off" />
      <div><button class="ew-pill ew-pill--dim" id="ewMax">MAX</button></div>`,
    buttons: [{ label: "Cancel", v: null }, { label: "Review", on: async (_root, close) => {
      if (busy) return; busy = true;
      toast("Estimating fee…");
      const r = await AppsAct.eth.review(api, b.address, cur.key, el("ewTo").value, el("ewAmt").value);
      busy = false;
      if (r.err) { toast(r.err, "warn"); return; }
      close(); ewConfirmSend(b, cur, r);
    } }] });
  const paint = () => { el("ewTokLine").textContent = "Token: " + cur.label + "  (click to change · balance " + ewCut(cur.bal) + ")"; };
  paint();
  el("ewTokLine").onclick = async () => { const i = await appPick("Send which token", assets.map(a => a.label)); if (i != null) { cur = assets[i]; if (d.root.isConnected) paint(); } };
  el("ewScan").onclick = async () => { const got = await scanQR("Scan recipient address"); const m = /0x[0-9a-fA-F]{40}/.exec(String(got || "")); if (m && d.root.isConnected) el("ewTo").value = m[0]; };
  el("ewMax").onclick = async () => { if (cur.key === "eth") toast("Reserving gas…"); const m = await AppsAct.eth.max(api, cur.key); if (m != null && d.root.isConnected) el("ewAmt").value = m; };
}

/** What a send from this address means for a swap in flight: said on the review, in red, when there is one or when it cannot be known. */
function ewSwapWarning(sw) {
  if (!sw || !sw.known) return "⚠ Could not check whether a Dexicon ① MxUSD swap is in flight. Swaps sign with this same address and need its ETH for gas: look at Dexicon, Activity before sending.";
  const k = sw.swaps.length; if (!k) return "";
  return "⚠ " + (k === 1 ? "1 swap of Dexicon ① MxUSD is" : k + " swaps of Dexicon ① MxUSD are") + " in flight. " + (k === 1 ? "It signs" : "They sign")
    + " with this same address and " + (k === 1 ? "needs" : "need") + " ETH here for gas to claim or refund. Sending ETH out now can leave a swap unable to finish before its time limit. Wait until Dexicon, Activity shows "
    + (k === 1 ? "it" : "them") + " finished, or leave enough ETH for gas.";
}
// Confirm: the three fee tiers of the original (Medium first), the fee of each read by the main process.
async function ewConfirmSend(b, cur, r) {
  let tier = "med", sending = false;
  const swap = ewSwapWarning(await api.ewSwaps().catch(() => null));
  const label = { low: "Low", med: "Medium", high: "High" };
  const d = appDlg({ title: "Confirm send", body: `<div class="ew-kv">Your address:</div>${ewBlock(b.address)}
      <div class="ew-kv">Send:  ${esc(r.amt)} ${esc(cur.sym)}</div>
      ${cur.key === "eth" ? "" : `<div class="ew-kv">${esc(cur.sym)} contract:</div>${ewBlock(cur.key)}`}
      <div class="ew-asset__t ew-gap">To</div>${ewBlock(r.to)}
      <div class="ew-asset__t ew-gap">Network fee</div>
      <div class="ew-tiers">${["low", "med", "high"].map(t => `<button class="ew-pill ew-tier" data-ewtier="${t}">${label[t]}</button>`).join("")}</div>
      <div class="ew-fee" id="ewFee"></div>
      ${r.capped ? `<div class="ew-warn">⚠ Unusually high network fee. Your RPC endpoint may be faulty or hostile: check it in Settings before sending.</div>` : ""}
      <div class="ew-warn" id="ewFeeShare" hidden></div>
      ${swap ? `<div class="ew-warn" id="ewSwapWarn">${esc(swap)}</div>` : ""}`,
    buttons: [{ label: "Cancel", v: null }, { label: "Send", on: async (_root, close) => {
      if (sending) return; sending = true;
      toast("Broadcasting…");
      const s = await AppsAct.eth.send(api, cur.key, r.to, r.amt, tier);
      close();
      // uncertain = the broadcast may or may not have gone out: never said as sent, never as a clean failure
      if (s && s.uncertain) appDlg({ title: "Not confirmed", body: `<p>${esc(s.err)}</p><p>Do not send it again until its outcome is checked.</p>`, buttons: [{ label: "Close", v: null }, { label: "View address on Etherscan", on: () => ewOpen(EW_ETHERSCAN + "address/" + b.address) }] });
      else if (!s || s.err) toast("Send failed: " + ((s && s.err) || "no answer"), "warn");
      else {
        store("ewLastTx", s.tx);
        appDlg({ title: "Sent", body: `<p>Broadcast.</p><div class="ew-mono ew-sel">${esc(s.tx)}</div>`, buttons: [{ label: "Close", v: null }, { label: "View on Etherscan", on: () => ewOpen(EW_ETHERSCAN + "tx/" + s.tx) }] });
      }
      if (activeView === "ethwallet") renderEthWallet();
    } }] });
  const paint = () => {
    const f = r.fees && r.fees[tier];
    el("ewFee").textContent = f ? "~" + TOK.tidyAmount(f.fee) + " ETH  ·  " + TOK.tidyAmount(f.gwei) + " gwei" : "";
    d.root.querySelectorAll("[data-ewtier]").forEach(x => { const on = x.dataset.ewtier === tier; x.classList.toggle("ew-tier--on", on); x.setAttribute("aria-pressed", on); });
    const share = cur.key === "eth" && f && Number(r.amt) > 0 ? Math.floor(Number(f.fee) / Number(r.amt) * 100) : 0, box = el("ewFeeShare");
    box.hidden = !(share > 25); box.textContent = "⚠ The fee is about " + share + "% of the amount you're sending.";
  };
  d.root.querySelectorAll("[data-ewtier]").forEach(x => { x.onclick = () => { tier = x.dataset.ewtier; paint(); }; });
  paint();
}

async function ewAddTokenDialog() {
  const d = appDlg({ title: "Add token", body: `<p>Paste an ERC20 contract address. Symbol + decimals are read from the chain.</p>
      <input class="adlg__in ew-mono" id="ewTokIn" placeholder="0x… contract" aria-label="Token contract address" autocomplete="off" spellcheck="false" />`,
    buttons: [{ label: "Cancel", v: null }, { label: "Add", on: async (_root, close) => {
      const addr = el("ewTokIn").value; if (!String(addr).trim()) { toast("Bad contract address", "warn"); return; }
      close(); toast("Reading token…");
      const r = await AppsAct.eth.addToken(api, addr);
      toast(r && r.err ? r.err : "Added " + (r && r.token ? r.token.symbol : "token"), r && r.err ? "warn" : "ok");
      if (r && !r.err && activeView === "ethwallet") renderEthWallet();
    } }] });
  return d.done;
}

async function ewTokenMenu(b, addr) {
  const t = b.tokens.find(x => x.address === addr) || { symbol: "Token", address: addr };
  const i = await appPick(t.symbol + " · " + addr, ["Send " + t.symbol, "View on Etherscan", "Copy contract address", "Remove from list"]);
  if (i === 0) ewSendDialog(b, addr);
  else if (i === 1) ewOpen(EW_ETHERSCAN + "token/" + addr + "?a=" + b.address);
  else if (i === 2) copy(addr);
  else if (i === 3) { await AppsAct.eth.removeToken(api, addr); if (activeView === "ethwallet") renderEthWallet(); }
}

async function ewSettingsDialog(b) {
  const i = await appPick("Settings", ["Export private key", "RPC endpoint", "Add token", "View address on Etherscan", "View last transaction", "Switch wallet source"]);
  if (i === 0) ewExportKey();
  else if (i === 1) ewRpcDialog();
  else if (i === 2) ewAddTokenDialog();
  else if (i === 3) { if (b.address) ewOpen(EW_ETHERSCAN + "address/" + b.address); else toast("No address yet", "warn"); }
  else if (i === 4) { const tx = store("ewLastTx"); if (/^0x[0-9a-fA-F]{64}$/.test(tx || "")) ewOpen(EW_ETHERSCAN + "tx/" + tx); else toast("No transaction sent from this device yet"); }
  else if (i === 5) appDlg({ title: "Switch wallet source", body: `<p>On the desktop this wallet always uses the embedded wallet: the key this node derives, which is also the key Dexicon ① MxUSD swaps sign with.</p>
      <p>Importing another key is not offered here. One Ethereum key serves this wallet and the swaps, and replacing it while a swap is in flight would leave that swap unable to claim or refund. (Nothing here moves funds.)</p>` });
}

// Export: the phone asks "I understand", then the device's own lock screen ("Confirm it's you"), then shows the key. Here: the
// typed phrase, then the system's prompt where Electron offers one (Touch ID on a Mac that has it), both checked in the main process.
function ewExportKey() {
  let busy = false;
  appDlg({ title: "Export private key", body: `<p>Anyone who sees this key can take these funds, permanently and irreversibly. Only continue if you are alone and know exactly why you need it.</p>
      <p>It is also the key Dexicon ① MxUSD swaps sign with.</p>
      <label class="adlg__lbl" for="ewExpIn">Type ${esc(AppsAct.eth.EXPORT_PHRASE)} to confirm it's you</label>
      <input class="adlg__in" id="ewExpIn" autocomplete="off" spellcheck="false" />`,
    buttons: [{ label: "Cancel", v: null }, { label: "I understand, show it", on: async (_root, close) => {
      if (busy) return; busy = true;
      const r = await AppsAct.eth.exportKey(api, el("ewExpIn").value);
      busy = false;
      if (r.err) { toast(/cancel/i.test(r.err) ? "Cancelled" : r.err, "warn"); return; }
      close();
      ewRevealKey(r.key, r.system); r.key = null;
    } }] });
}
/** The key on the screen: for a minute at most, and only while the window is in front. Closing takes it out of the page
 *  and out of this function. Copy goes through the main process, which clears the clipboard again (main/clipsecret.js). */
function ewRevealKey(key, system) {
  let k = String(key || ""); key = null;
  const d = appDlg({ title: "Private key", body: `<div class="ew-warn">Anyone with this key controls these funds. Never share it.</div>
      ${system ? "" : `<div class="ew-warn">No system check took place: this computer offered no Touch ID prompt, so the typed phrase was the only check.</div>`}
      <div class="ew-mono ew-sel" id="ewKeyText"></div><div class="ew-fine">This closes by itself after 60 seconds, and when you leave this window.</div>`,
    buttons: [{ label: "Close", v: null }, { label: "Copy", on: () => { if (!k) return; api.clipSecret(k); toast("Key copied. The clipboard is cleared in 60 seconds and when the app quits", "ok"); } }] });
  d.root.querySelector("#ewKeyText").textContent = k;   // as text, in this one node, which close() removes
  const end = () => d.close(null), hidden = () => { if (document.hidden) end(); };
  const timer = setTimeout(end, 60000);
  window.addEventListener("blur", end); document.addEventListener("visibilitychange", hidden);
  d.done.then(() => { k = ""; clearTimeout(timer); window.removeEventListener("blur", end); document.removeEventListener("visibilitychange", hidden); });
  return d;
}

async function ewRpcDialog() {
  const st = await api.ewStatus().catch(() => ({}));
  const say = (r, ok) => { if (r && r.err) { toast(r.err, "warn"); return false; } toast(ok, "ok"); return true; };
  appDlg({ title: "RPC endpoint", body: `<input class="adlg__in ew-mono" id="ewRpcIn" placeholder="https://…" aria-label="RPC endpoint" value="${esc((st && st.rpc) || "")}" autocomplete="off" spellcheck="false" />
      <div class="ew-fine">Falls back to public keyless nodes automatically if this one fails. Only public https hosts are accepted. Dexicon ① MxUSD settles its swaps through the same endpoint.</div>`,
    buttons: [{ label: "Default", neutral: true, on: async (_root, close) => { if (say(await AppsAct.eth.setRpc(api, ""), "Using the default public RPCs")) close(); } },
      { label: "Cancel", v: null },
      { label: "Save", on: async (_root, close) => { if (say(await AppsAct.eth.setRpc(api, el("ewRpcIn").value), "RPC saved")) close(); } }] });
}

// live push: refresh the passive dashboard only, and never while a dialog is open (the frozen-form rule)
function onEthWalletUpdate() {
  if (ewUpdateTimer) return;
  ewUpdateTimer = setTimeout(() => {
    ewUpdateTimer = null;
    if (activeView !== "ethwallet" || !el("ewBody")) return;
    // Don't rebuild while a dialog is open. NB offsetParent is ALWAYS null for position:fixed (.overlay), so test
    // computed display instead — and skip the always-present hidden #setup overlay (display:none → excluded).
    if ([...document.querySelectorAll(".overlay")].some(o => getComputedStyle(o).display !== "none")) return;
    renderEthWallet().catch(() => {});
  }, 400);
}

// ============================ miniMall ============================
// Three Android apps in one tray app, as Pandamonium's MallActivity presents them: a launcher with three cards, each opening
// its app's own screens (apks/merchshop "miniMall", apks/merchstudio "miniMall Studio", apks/merchinbox "miniMall Inbox";
// each Design.java: #0A0A0F / #15151F / #1F1F2B, accent #F7931A), over main/shop.js. What orders, pays, marks and saves is
// in renderer/apps-act.js (AppsAct.shop), pinned against the screens this replaced by scripts/apps-money.test.cjs.
// The dollar token is MxUSD on every label; the value on the wire and in a .shop file stays "USDT".
// Owed (main/shop.js cannot do them): Studio's NFTs tab and StateNFT collections, the Inbox's NFT delivery and its CSV
// export, enquiries from a storefront, and keeping the buyer's list of added shops across restarts.
let shopView = "home";          // home | shop | studio | inbox
let shopNav = {};               // the open screen inside a section: { screen, ref, pi }
let shopIdentity = null;        // { publicId, vendorAddress }
let shopLoaded = null;          // the .shop open in the storefront
let shopAdded = [];             // shops added in miniMall this session
let shopCart = {};              // productId → qty
let shopShipId = null;
let shopFilter = "ALL";         // the Inbox's status chip
let shopDraft = null;           // Studio: the shop being built
let shopUpdateTimer = null;
const SHOP = AppsAct.shop;
const SHOP_PILL = { DELIVERED: "#2ECC71", SHIPPED: "#2ECC71", PAID: "#F7931A", CONFIRMED: "#F7931A", UNDERPAID: "#E74C3C", WRONG_TOKEN: "#E74C3C" };
const SHOP_APPS = [["shop", "miniMall", "Browse your shops, place orders and track deliveries."], ["studio", "miniMall Studio", "Build a storefront for your products."], ["inbox", "miniMall Inbox", "Manage customer orders, payments and deliveries."]];

async function onShopUpdate() {
  if (shopUpdateTimer) clearTimeout(shopUpdateTimer);
  shopUpdateTimer = setTimeout(async () => {
    refreshShopBadge();
    if (activeView !== "minimall") return;
    if (el("shopBody") && el("shopBody").querySelector("input:focus, textarea:focus")) return;   // never stomp a form
    if ([...document.querySelectorAll(".overlay")].some(o => getComputedStyle(o).display !== "none")) return;
    if ((shopView === "inbox" || shopView === "shop") && (shopNav.screen === "orders" || shopNav.screen === "order" || (shopView === "inbox" && !shopNav.screen))) renderMiniMall();
  }, 350);
}
async function refreshShopBadge() {
  try { const n = await api.shopNewCount(); const b = el("shopBadge"); if (!b) return; if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true; paintTrayDot(); } catch (e) {}
}
function shopGo(view, nav) { shopView = view; shopNav = nav || {}; renderMiniMall(); }
function shopPill(status) { const s = status === "INQUIRY" ? "ENQUIRY" : String(status || ""); return `<span class="mm-pill" style="background:${Object.hasOwn(SHOP_PILL, status) ? SHOP_PILL[status] : "#9A9AA8"}">${esc(s)}</span>`; }
function shopAgo(ms) { const d = Date.now() - (Number(ms) || 0); return d < 60000 ? "just now" : d < 3600000 ? Math.floor(d / 60000) + "m ago" : d < 86400000 ? Math.floor(d / 3600000) + "h ago" : Math.floor(d / 86400000) + "d ago"; }
/** A screen of one of the three apps: its bar (back, title, icons on the right), then the page. */
function shopFrame(title, back, icons, body, foot) {
  el("shopBody").innerHTML = `<div class="mm"><div class="mm-bar">${back ? `<button class="mm-bar__b" id="mmBack" aria-label="Back">‹</button>` : ""}<span class="mm-bar__t">${esc(title)}</span>
      ${(icons || []).map(([id, glyph, label]) => `<button class="mm-bar__b" id="${id}" aria-label="${esc(label)}" title="${esc(label)}">${glyph}</button>`).join("")}</div>
    <div class="mm-page" id="shopSub">${body}</div>${foot || ""}</div>`;
  if (back) el("mmBack").onclick = back;
  cardKeys(el("shopBody"));
}
const shopSay = (e) => toast((e && e.message) || String(e || "failed"), "warn");

async function renderMiniMall() {
  const host = el("shopBody"); if (!host) return;
  if (!shopIdentity && running) { try { shopIdentity = await api.shopInit(); } catch (e) {} }
  if (shopView === "shop") return renderShopApp();
  if (shopView === "studio") return renderShopStudio();
  if (shopView === "inbox") return renderShopInbox();
  // Pandamonium's launcher page (MallActivity): its own colours, not the three apps'
  host.innerHTML = `<div class="mall"><h1 class="mall__t">miniMall</h1><div class="mall__d">Shop, create storefronts and manage orders.</div>
    ${SHOP_APPS.map(([id, name, d]) => `<div class="mall__card" role="button" tabindex="0" data-mall="${id}"><img class="mall__ic" src="icons/minimall.png" alt="" />
      <div class="mall__main"><div class="mall__n">${name}${id === "inbox" ? `<span class="tab-badge" id="mallNew" hidden></span>` : ""}</div><div class="mall__s">${d}</div></div><span class="mall__go" aria-hidden="true">›</span></div>`).join("")}</div>`;
  cardKeys(host);
  host.querySelectorAll("[data-mall]").forEach(c => { c.onclick = () => { if (!running) { toast("Start the node first", "warn"); return; } shopGo(c.dataset.mall); }; });
  api.shopNewCount().then(n => { const b = el("mallNew"); if (b && n > 0) { b.textContent = n; b.hidden = false; } }).catch(() => {});
}

// ---------------- miniMall Inbox (merchinbox): the orders customers placed with my shops ----------------
async function renderShopInbox() {
  if (shopNav.screen === "order") return renderShopSellOrder(shopNav.ref);
  const all = (await api.shopOrders().catch(() => [])).filter(o => o.role === "sell"), mine = await api.shopMyShops().catch(() => []);
  const list = all.filter(o => shopFilter === "ALL" || o.status === shopFilter);
  shopFrame(mine.length === 1 ? mine[0].shopName : "Orders", () => shopGo("home"), [["mmCard", "≡", "Vendor Card"]],
    `<div class="mm-ver">miniMall Inbox</div>
     <div class="mm-status ${shopIdentity ? "mm-status--ok" : ""}">${shopIdentity ? "✓ Ready to receive orders  ·  shop key " + idHtml(shopIdentity.publicId) : "Connecting to your node…"}</div>
     <div class="mm-chips">${["ALL", "PENDING", "PAID", "CONFIRMED", "SHIPPED", "DELIVERED"].map(s => `<button class="mm-pill mm-chip${shopFilter === s ? " mm-chip--on" : ""}" data-chip="${s}" aria-pressed="${shopFilter === s}">${s}</button>`).join("")}</div>
     ${list.map(o => `<div class="mm-row" role="button" tabindex="0" data-oref="${esc(o.ref)}"><div class="mm-row__top"><span class="mm-row__t">${o.unread ? "●  " : ""}${esc(o.ref)}</span>${shopPill(o.status)}</div>
        <div class="mm-row__s">${esc(o.shopName || "")}   ·   ${esc(o.amount)} ${esc(SHOP.cur(o.currency))}   ·   ${shopAgo(o.date)}</div></div>`).join("")}`);
  el("mmCard").onclick = shopVendorCard;
  el("shopSub").querySelectorAll("[data-chip]").forEach(c => { c.onclick = () => { shopFilter = c.dataset.chip; renderShopInbox(); }; });
  el("shopSub").querySelectorAll("[data-oref]").forEach(r => { r.onclick = () => shopGo("inbox", { screen: "order", ref: r.dataset.oref }); });
}
async function shopVendorCard() {
  const card = await api.shopVendorCard().catch(() => "");
  if (!card) { toast("Connect to your node first.", "warn"); return; }
  let qr = ""; if (typeof qrcode !== "undefined") { try { const q = qrcode(0, "L"); q.addData(card); q.make(); qr = `<div class="ew-qr">${q.createImgTag(3, 0)}</div>`; } catch (e) {} }
  appDlg({ title: "Vendor Card", body: `<p>This is your public shop key + receiving address. It is safe to share: a shop you build in miniMall Studio carries it, so that orders reach you.</p>${qr}<div class="ew-mono ew-sel">${esc(card)}</div>`,
    buttons: [{ label: "Close", v: null }, { label: "Copy", on: () => { api.clip(card); toast("Copied", "ok"); } }] });
}
function shopThread(chat, them) { return (chat || []).map(m => `<div class="mm-msg${m.incoming ? "" : " mm-msg--me"}">${m.incoming ? them : "You"}: ${esc(m.message)}</div>`).join(""); }
function shopItems(o) { return (o.items || []).map(i => `<div>• ${esc(i.product)}${i.size ? " (" + esc(i.size) + ")" : ""}  x${esc(String(i.quantity))}  = ${esc(i.lineTotal || "")}</div>`).join("") || "<div>(no items listed)</div>"; }
const shopKv = (k, v, copyable) => `<div class="mm-kv"><span>${k}</span>${copyable ? `<button class="mm-kv__v mm-kv__v--copy" data-copy="${esc(v)}">${esc(v)}</button>` : `<span class="mm-kv__v">${esc(v)}</span>`}</div>`;
async function renderShopSellOrder(ref) {
  const d = await api.shopOrder(ref).catch(() => null);
  if (!d || !d.order || d.order.role !== "sell") { shopFrame("Orders", () => shopGo("inbox"), [], `<div class="mm-empty">Order not found.</div>`); return; }
  const o = d.order, cur = SHOP.cur(o.currency), enquiry = o.status === "INQUIRY", next = SHOP.nextStatus(o);
  shopFrame((o.items && o.items[0] && o.items[0].product) || o.ref, () => shopGo("inbox"), [],
    `<div class="mm-line">${shopPill(o.status)}<span class="${o.paid ? "mm-in" : "mm-dim"}">${o.paid ? "  paid " + esc(o.paidAmount || o.amount) + " " + esc(cur) : "  awaiting payment"}</span></div>
     <div class="mm-sec">Items</div><div class="mm-card">${shopItems(o)}</div>
     ${shopKv("Total", o.amount + " " + cur)}${shopKv("Reference", o.ref, true)}${shopKv("Shop", o.shopName || "")}
     <div class="mm-sec">Delivery</div>${shopKv("Method", o.shipping || "Not given")}${o.delivery ? shopKv("Address", o.delivery, true) : ""}
     ${o.note ? `<div class="mm-sec">Buyer note</div><div class="mm-card">${esc(o.note)}</div>` : ""}
     ${shopKv("Buyer key", o.counterparty || "", true)}
     ${enquiry ? "" : `<div class="mm-sec">Update status</div><div class="mm-grid">${["PAID", "CONFIRMED", "SHIPPED", "DELIVERED"].map(s => `<button class="mm-btn${o.status === s ? " mm-btn--on" : ""}" data-advance="${s}"${s === next ? "" : " disabled"}>${s}</button>`).join("")}</div>
       <div class="mm-hint">${!o.paid ? "Awaiting payment first. PAID is set by the payment itself, when it arrives." : next ? "Next: " + next + "." : "This order is delivered."}</div>`}
     <div class="mm-sec">${enquiry ? "Conversation" : "Message the buyer"}</div><div class="mm-thread">${shopThread(d.chat, "Buyer")}</div>
     <div class="mm-send"><input class="mm-in-f" id="shopMsg" placeholder="Reply…" aria-label="Reply" autocomplete="off" /><button class="mm-btn" id="shopSend">Send</button></div>`);
  shopWireOrder(ref, () => renderShopSellOrder(ref));
}
function shopWireOrder(ref, again) {
  el("shopSub").querySelectorAll("[data-copy]").forEach(b => { b.onclick = () => copy(b.dataset.copy); });
  el("shopSub").querySelectorAll("[data-advance]").forEach(b => { b.onclick = async () => { b.disabled = true; const r = await SHOP.advance(api, ref, b.dataset.advance); if (r.err) shopSay(r.err); else toast("Marked " + b.dataset.advance, "ok"); again(); }; });
  const send = async () => { const r = await SHOP.reply(api, ref, el("shopMsg").value); if (r && r.err) { toast("Reply failed: " + r.err, "warn"); return; } if (r) again(); };
  el("shopSend").onclick = send; el("shopMsg").onkeydown = (e) => { if (e.key === "Enter") send(); };
  if (el("shopRetry")) el("shopRetry").onclick = async () => { el("shopRetry").disabled = true; const r = await SHOP.retryPay(api, ref); if (r.err) toast("Payment failed: " + r.err, "warn"); else toast("Payment sent.", "ok"); again(); };
}

// ---------------- miniMall (merchshop): shops, a storefront, the cart, checkout, my orders ----------------
async function renderShopApp() {
  const n = shopNav.screen;
  if (n === "orders") return renderShopMyOrders();
  if (n === "order") return renderShopBuyOrder(shopNav.ref);
  if (n === "checkout" && shopLoaded) return renderShopCheckout();
  if (n === "store" && shopLoaded) return renderShopStore();
  const mine = await api.shopMyShops().catch(() => []), row = (s, how, i) => `<div class="mm-row" role="button" tabindex="0" data-${how}="${i}"><div class="mm-row__t mm-row__t--big">${esc(s.shopName)}</div><div class="mm-row__s">${(s.products || []).length} products  ·  ${esc(SHOP.cur(s.currency))}</div></div>`;
  shopFrame("miniMall", () => shopGo("home"), [["mmOrders", "🧾", "My orders"]],
    `<div class="mm-ver">miniMall Shop</div>
     ${shopAdded.map((s, i) => row(s, "added", i)).join("")}
     ${shopAdded.length ? "" : `<div class="mm-empty">No shops yet.\n\nClick “Add a shop” below and pick a .shop file a vendor shared with you.</div>`}
     ${mine.length ? `<div class="mm-sec">Your own shops (as a buyer sees them)</div>${mine.map((s, i) => row(s, "mine", i)).join("")}` : ""}`,
    `<div class="mm-foot"><button class="mm-btn mm-btn--on mm-btn--cta" id="shopAdd">＋  Add a shop</button></div>`);
  el("mmOrders").onclick = () => shopGo("shop", { screen: "orders" });
  const open = (s) => { const why = SHOP.problem(s); if (why) { toast(why, "warn"); return; } shopLoaded = s; shopCart = {}; shopShipId = null; shopGo("shop", { screen: "store" }); };   // a shop whose token does not match its currency is never opened
  el("shopAdd").onclick = async () => {
    try { const cfg = await api.shopImport(); if (!cfg) return;
      const why = SHOP.problem(cfg); if (why) { toast(why, "warn"); return; }
      shopAdded = shopAdded.filter(s => s.shopId !== cfg.shopId).concat(cfg); toast("Added " + cfg.shopName, "ok"); open(cfg);
    } catch (e) { toast("Couldn't read that file.", "warn"); }
  };
  el("shopSub").querySelectorAll("[data-added]").forEach(c => { c.onclick = () => open(shopAdded[+c.dataset.added]); });
  el("shopSub").querySelectorAll("[data-mine]").forEach(c => { c.onclick = () => open(mine[+c.dataset.mine]); });
}
function renderShopStore() {
  const s = shopLoaded, cur = SHOP.cur(s.currency), count = Object.values(shopCart).reduce((a, b) => a + b, 0);
  shopFrame(s.shopName, () => shopGo("shop"), [],
    `<div class="mm-dim mm-pays">Pays in ${esc(cur)}</div>
     ${(s.products || []).map(p => { const q = shopCart[p.id] || 0, cap = Number(p.maxUnits) || 99; return `<div class="mm-prod">
        ${SHOP.image(p.image) ? `<img class="mm-prod__im" src="${esc(SHOP.image(p.image))}" alt="" data-zoom="${esc(p.id)}" />` : `<div class="mm-prod__im"></div>`}
        <div class="mm-prod__main"><div class="mm-prod__n">${esc(p.name)}</div><div class="mm-prod__d">${esc(p.description || "")}</div><div class="mm-prod__p">${esc(p.price)} ${esc(cur)}</div></div>
        <div class="mm-step"><button class="mm-step__b" data-dec="${esc(p.id)}" aria-label="One fewer ${esc(p.name)}"${q <= 0 ? " disabled" : ""}>–</button><span class="mm-step__q">${q}</span><button class="mm-step__b" data-inc="${esc(p.id)}" aria-label="One more ${esc(p.name)}"${q >= cap ? " disabled" : ""}>+</button></div></div>`; }).join("")}`,
    `<div class="mm-foot mm-foot--cart"><span>${count ? count + " items  ·  " + esc(SHOP.cartTotal(s, shopCart, null)) + " " + esc(cur) : "Cart empty"}</span><button class="mm-btn mm-btn--on" id="shopCheckout">Checkout</button></div>`);
  const cap = (id) => { const p = (s.products || []).find(x => x.id === id); return p ? (Number(p.maxUnits) || 99) : 99; };
  el("shopSub").querySelectorAll("[data-inc]").forEach(b => { b.onclick = () => { const id = b.dataset.inc; shopCart[id] = Math.min(cap(id), (shopCart[id] || 0) + 1); renderShopStore(); }; });
  el("shopSub").querySelectorAll("[data-dec]").forEach(b => { b.onclick = () => { const id = b.dataset.dec; shopCart[id] = Math.max(0, (shopCart[id] || 0) - 1); if (!shopCart[id]) delete shopCart[id]; renderShopStore(); }; });
  el("shopSub").querySelectorAll("[data-zoom]").forEach(im => { im.onclick = () => { const p = s.products.find(x => x.id === im.dataset.zoom); appDlg({ title: p.name, body: `<img class="mm-zoom" src="${esc(SHOP.image(p.image))}" alt="" /><p>${esc(p.description || "")}</p>` }); }; });
  el("shopCheckout").onclick = () => { if (!count) { toast("Add an item first (use + above).", "warn"); return; } shopGo("shop", { screen: "checkout" }); };
}
function renderShopCheckout() {
  const s = shopLoaded, cur = SHOP.cur(s.currency), ship = SHOP.shipOf(s, shopShipId), items = SHOP.orderItems(s, shopCart);
  const sums = SHOP.totals(s, shopCart, shopShipId), total = sums.total || "0.000000";
  shopFrame("Checkout", () => shopGo("shop", { screen: "store" }), [],
    `<div class="mm-card">${items.map(i => `<div class="mm-kv"><span class="mm-kv__v">${esc(i.product)} × ${i.quantity}</span><span>${esc(i.lineTotal)}</span></div>`).join("")}</div>
     ${(s.shipping || []).length ? `<div class="mm-sec">Delivery method</div><div class="mm-opts">${s.shipping.map(sh => `<button class="mm-btn${ship && ship.id === sh.id ? " mm-btn--on" : ""}" data-ship="${esc(sh.id)}" aria-pressed="${!!(ship && ship.id === sh.id)}">${esc(sh.label)}${Number(sh.fee) > 0 ? "  +" + esc(String(sh.fee)) : "  · free"}</button>`).join("")}</div>` : ""}
     <div class="mm-sec">Delivery address / email</div><textarea class="mm-in-f" id="shopDelivery" rows="2" placeholder="Where should this go? (or email for digital)" aria-label="Delivery address or email"></textarea>
     <div class="mm-sec">Message to seller (optional)</div><input class="mm-in-f" id="shopNote" placeholder="Anything the vendor should know" aria-label="Message to seller" autocomplete="off" />
     <div class="mm-totals">${shopKv("Items", sums.itemsTotal || "0.000000")}${shopKv("Shipping", sums.fee || "0.000000")}${shopKv("Total", total + " " + cur)}</div>
     <div class="mm-hint">Your address and message are encrypted: only the vendor can read them.</div>`,
    `<div class="mm-foot"><button class="mm-btn mm-btn--on mm-btn--cta" id="shopPay">Pay ${esc(total)} ${esc(cur)}</button></div>`);
  const keep = () => ({ d: el("shopDelivery").value, n: el("shopNote").value });
  el("shopSub").querySelectorAll("[data-ship]").forEach(b => { b.onclick = () => { const k = keep(); shopShipId = b.dataset.ship; renderShopCheckout(); el("shopDelivery").value = k.d; el("shopNote").value = k.n; }; });
  el("shopPay").onclick = async () => {
    const btn = el("shopPay"); if (btn.disabled) return; btn.disabled = true;
    const r = await SHOP.place(api, { confirm: (title, text) => appDlg({ title, body: `<p class="mm-payq">${esc(text)}</p>`, buttons: [{ label: "Back", v: false }, { label: "Pay", v: true }] }).done, busy: () => toast("Sending your order and payment…") },
      s, shopCart, shopShipId, el("shopDelivery").value, el("shopNote").value);
    if (r.cancelled) { btn.disabled = false; return; }
    if (r.err) { toast(r.refused ? r.err : "Order failed: " + r.err, "warn"); btn.disabled = false; return; }
    if (r.payError) toast("Order sent, but payment failed. Open the order to retry. (" + r.payError + ")", "warn"); else toast("Order placed!", "ok");
    shopCart = {}; shopGo("shop", { screen: "order", ref: r.ref });
  };
}
async function renderShopMyOrders() {
  const list = (await api.shopOrders().catch(() => [])).filter(o => o.role === "buy");
  shopFrame("My orders", () => shopGo("shop"), [],
    list.map(o => `<div class="mm-row" role="button" tabindex="0" data-oref="${esc(o.ref)}"><div class="mm-row__top"><span class="mm-row__t">${esc(o.shopName || o.ref)}</span>${shopPill(o.status)}</div>
      <div class="mm-row__s">${esc(o.amount)} ${esc(SHOP.cur(o.currency))}  ·  ${shopAgo(o.date)}${o.ambiguous ? "  ·  payment not confirmed" : o.unpaid && !o.paid ? "  ·  not paid" : ""}</div></div>`).join("") || `<div class="mm-empty">No orders yet.</div>`);
  el("shopSub").querySelectorAll("[data-oref]").forEach(r => { r.onclick = () => shopGo("shop", { screen: "order", ref: r.dataset.oref }); });
}
async function renderShopBuyOrder(ref) {
  const d = await api.shopOrder(ref).catch(() => null);
  if (!d || !d.order || d.order.role !== "buy") { shopFrame("My orders", () => shopGo("shop", { screen: "orders" }), [], `<div class="mm-empty">Order not found.</div>`); return; }
  const o = d.order, cur = SHOP.cur(o.currency);
  shopFrame(o.shopName || o.ref, () => shopGo("shop", { screen: "orders" }), [],
    `<div class="mm-line">${shopPill(o.status)}</div>
     <div class="mm-sec">Order</div><div class="mm-card">${shopItems(o)}</div>
     ${shopKv("Total", o.amount + " " + cur)}${shopKv("Reference", o.ref, true)}${shopKv("Delivery", o.shipping || "Not given")}${o.delivery ? shopKv("To", o.delivery) : ""}
     ${d.ambiguous ? `<div class="mm-warn">⚠ The payment timed out: it may already have gone through. Check your Wallet and History before sending again, so that you do not pay twice.</div>` : ""}
     ${d.unpaid && !d.ambiguous && !o.paid ? `<button class="mm-btn mm-btn--on mm-btn--cta" id="shopRetry">Retry payment</button>` : ""}
     <div class="mm-sec">Messages with the vendor</div><div class="mm-thread">${shopThread(d.chat, "Vendor") || `<div class="mm-dim">No messages yet. Say hello below.</div>`}</div>`,
    `<div class="mm-foot mm-send"><input class="mm-in-f" id="shopMsg" placeholder="Message the vendor…" aria-label="Message the vendor" autocomplete="off" /><button class="mm-btn" id="shopSend">Send</button></div>`);
  shopWireOrder(ref, () => renderShopBuyOrder(ref));
}

// ---------------- miniMall Studio (merchstudio): products, then "Your shop", then the .shop file ----------------
// The desktop keeps several shops (the phone's Studio builds one): the first screen lists them. No NFTs tab: owed, see the top.
async function renderShopStudio() {
  const d = shopDraft, n = shopNav.screen;
  if (d && n === "product" && d.products[shopNav.pi]) return renderShopProduct(d, shopNav.pi);
  if (d && n === "details") return renderShopDetails(d);
  if (d) return renderShopProducts(d);
  const mine = await api.shopMyShops().catch(() => []);
  shopFrame("miniMall Studio", () => shopGo("home"), [],
    `<div class="mm-status ${shopIdentity ? "mm-status--ok" : "mm-status--acc"}">${shopIdentity ? "✓ Shop key ready (from this node's seed)" : "Connecting to your node…"}</div>
     ${mine.map(s => `<div class="mm-row"><div class="mm-row__top"><span class="mm-row__t mm-row__t--big">${esc(s.shopName)}</span>
        <span class="mm-opts"><button class="mm-btn" data-editshop="${esc(s.shopId)}">Edit</button><button class="mm-btn" data-exportshop="${esc(s.shopId)}">Export .shop</button></span></div>
        <div class="mm-row__s">${(s.products || []).length} products  ·  ${esc(SHOP.cur(s.currency))}</div></div>`).join("")
       || `<div class="mm-empty">Regular goods: you write the name and price, attach a photo, and ship them yourself.\n\nClick ＋ to build your first shop.</div>`}`,
    `<div class="mm-foot"><button class="mm-btn mm-btn--on mm-btn--cta" id="shopNew">＋  New shop</button></div>`);
  el("shopNew").onclick = () => { shopDraft = { shopName: "", currency: "Minima", vendorPublicId: shopIdentity ? shopIdentity.publicId : "", vendorAddress: shopIdentity ? shopIdentity.vendorAddress : "", shipping: SHOP.standardShipping(), products: [] }; shopGo("studio"); };
  el("shopSub").querySelectorAll("[data-editshop]").forEach(b => { b.onclick = async () => { const m = await api.shopMyShops(); shopDraft = JSON.parse(JSON.stringify(m.find(s => s.shopId === b.dataset.editshop))); shopDraft.shipping = SHOP.normalizeShipping(shopDraft.shipping); shopGo("studio"); }; });
  el("shopSub").querySelectorAll("[data-exportshop]").forEach(b => { b.onclick = async () => { const m = await api.shopMyShops(); const s = m.find(x => x.shopId === b.dataset.exportshop); const p = await api.shopExport(JSON.stringify(s, null, 2), s.shopId); if (p) toast("Exported to " + p, "ok"); }; });
}
function renderShopProducts(d) {
  const cur = SHOP.cur(d.currency), listed = d.products.filter(p => p.name && Number(p.price) > 0).length;
  shopFrame(d.shopId ? d.shopName || "Your shop" : "miniMall Studio", () => { shopDraft = null; shopGo("studio"); }, [],
    `<div class="mm-seg"><span class="mm-btn mm-btn--on">Products · ${d.products.length}</span></div>
     ${d.products.map((p, i) => `<div class="mm-prod" role="button" tabindex="0" data-prod="${i}">${SHOP.image(p.image) ? `<img class="mm-prod__im mm-prod__im--s" src="${esc(SHOP.image(p.image))}" alt="" />` : `<div class="mm-prod__im mm-prod__im--s"></div>`}
        <div class="mm-prod__main"><div class="mm-prod__n">${esc(p.name || "Unnamed product")}</div><div class="mm-prod__d${Number(p.price) > 0 ? "" : " mm-red"}">${Number(p.price) > 0 ? esc(String(p.price)) + " " + esc(cur) + " · ×" + esc(String(p.maxUnits || 10)) : "no price"}</div></div></div>`).join("")
       || `<div class="mm-empty">Regular goods: you write the name and price, attach a photo, and ship them yourself.\n\nClick ＋ to add your first product.</div>`}
     <button class="mm-btn mm-btn--cta mm-gap" id="sdAddProd">＋  Add product</button>`,
    `<div class="mm-foot"><button class="mm-btn mm-btn--cta${listed ? " mm-btn--on" : ""}" id="sdNext">${listed ? "Continue · " + listed + " in shop  →" : "Add a product to continue"}</button></div>`);
  el("sdAddProd").onclick = () => { if (d.products.length >= 40) { toast("A shop holds at most 40 listings.", "warn"); return; } d.products.push({ id: "p" + Date.now().toString(36), name: "", description: "", mode: "units", price: "", maxUnits: "10", image: "" }); shopGo("studio", { screen: "product", pi: d.products.length - 1 }); };
  el("shopSub").querySelectorAll("[data-prod]").forEach(c => { c.onclick = () => shopGo("studio", { screen: "product", pi: +c.dataset.prod }); });
  el("sdNext").onclick = () => { if (listed) shopGo("studio", { screen: "details" }); };
}
function renderShopProduct(d, i) {
  const p = d.products[i];
  shopFrame("Your product", () => { read(); shopGo("studio"); }, [],
    `<div class="mm-photo" id="sdPhoto" role="button" tabindex="0">${SHOP.image(p.image) ? `<img src="${esc(SHOP.image(p.image))}" alt="" />` : ""}<span>${SHOP.image(p.image) ? "Click to change the photo" : "Click to add a photo"}</span></div>
     <div class="mm-sec">Name</div><input class="mm-in-f" id="sdPName" placeholder="Product name" value="${esc(p.name || "")}" autocomplete="off" />
     <div class="mm-sec">About</div><input class="mm-in-f" id="sdPDesc" placeholder="Description (optional)" value="${esc(p.description || "")}" autocomplete="off" />
     <div class="mm-sec">Price (${esc(SHOP.cur(d.currency))})</div><input class="mm-in-f" id="sdPPrice" inputmode="decimal" placeholder="0" value="${esc(p.price || "")}" autocomplete="off" />
     <div class="mm-sec">Stock (max per order)</div><input class="mm-in-f" id="sdPMax" inputmode="numeric" placeholder="10" value="${esc(p.maxUnits || "")}" autocomplete="off" />
     <button class="mm-btn mm-btn--on mm-btn--cta mm-gap" id="sdPDone">Done</button><button class="mm-btn mm-btn--cta mm-red" id="sdPDel">Remove product</button>`);
  function read() { if (!el("sdPName")) return; p.name = el("sdPName").value; p.description = el("sdPDesc").value; p.price = el("sdPPrice").value; p.maxUnits = el("sdPMax").value; }
  const photo = el("sdPhoto"), take = async (f) => { if (!f) return; read(); p.image = await shopResizeImage(f); renderShopProduct(d, i); };
  photo.onclick = () => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.onchange = () => take(inp.files[0]); inp.click(); };
  photo.ondragover = (e) => { e.preventDefault(); }; photo.ondrop = (e) => { e.preventDefault(); take(e.dataTransfer.files[0]); };
  el("sdPDone").onclick = () => { read(); shopGo("studio"); };
  el("sdPDel").onclick = () => { d.products.splice(i, 1); shopGo("studio"); };
}
function renderShopDetails(d) {
  shopFrame("Your shop", () => { read(); shopGo("studio"); }, [],
    `<div class="mm-sec">Shop name</div><input class="mm-in-f" id="sdName" value="${esc(d.shopName)}" placeholder="e.g. Zebra Gallery" autocomplete="off" />
     <div class="mm-sec">Pays in</div><div class="mm-seg"><button class="mm-btn${d.currency === "Minima" ? " mm-btn--on" : ""}" data-cur="Minima" aria-pressed="${d.currency === "Minima"}">Minima</button><button class="mm-btn${d.currency !== "Minima" ? " mm-btn--on" : ""}" data-cur="USDT" aria-pressed="${d.currency !== "Minima"}">MxUSD</button></div>
     <div class="mm-sec">Shipping (label + fee)</div>${d.shipping.map((sh, i) => `<div class="mm-kv"><span class="mm-kv__v">${esc(sh.label)}</span>${sh.id === "digital" ? `<span>free</span>` : `<input class="mm-in-f mm-in-f--fee" data-si="${i}" inputmode="decimal" placeholder="0" aria-label="${esc(sh.label)} fee" value="${esc(sh.fee || "")}" autocomplete="off" />`}</div>`).join("")}
     <div class="mm-sec">Vendor card (from this node: how orders reach you)</div><div class="mm-card ew-mono">${esc(d.vendorPublicId || "")}|${esc(d.vendorAddress || "")}</div>
     <div class="mm-hint">${d.products.filter(p => p.name && Number(p.price) > 0).length} products  ·  pays in ${esc(SHOP.cur(d.currency))}</div>`,
    `<div class="mm-foot"><button class="mm-btn mm-btn--on mm-btn--cta" id="sdSave">${d.shopId ? "Save" : "Save & export .shop"}</button></div>`);
  function read() { if (!el("sdName")) return; d.shopName = el("sdName").value.trim(); el("shopSub").querySelectorAll("[data-si]").forEach(inp => { if (d.shipping[+inp.dataset.si]) d.shipping[+inp.dataset.si].fee = inp.value; }); }
  el("shopSub").querySelectorAll("[data-cur]").forEach(b => { b.onclick = () => { read(); d.currency = b.dataset.cur; renderShopDetails(d); }; });
  el("sdSave").onclick = async () => {
    read();
    const r = await SHOP.save(api, d);
    if (r.err) { shopSay(r.err); return; }
    shopDraft = null; toast("Shop saved", "ok"); if (r.exported) toast("Exported to " + r.exported, "ok");
    shopGo("studio");
  };
}
function shopResizeImage(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => { const img = new Image(); img.onload = () => {
      let w = img.width, h = img.height; const scale = Math.min(1, 1024 / Math.max(w, h)); w = Math.round(w * scale); h = Math.round(h * scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = 0.85, out = cv.toDataURL("image/jpeg", q);
      while (out.length > 150000 && q > 0.3) { q -= 0.1; out = cv.toDataURL("image/jpeg", q); }
      resolve(out);
    }; img.onerror = () => resolve(""); img.src = fr.result; };
    fr.onerror = () => resolve(""); fr.readAsDataURL(file);
  });
}

// ---- P2P Chance was removed in 0.18.68 -----------------------------------------------------------------
// One Settings card, shown only while this wallet still has something open on the chain. The app withdraws
// open offers and settles bets by itself (main/casino.js), so the card has nothing to press.
async function chanceLeftCard() {
  const host = el("chanceLeft"); if (!host) return;
  let o = null; try { o = await api.casinoOpen(); } catch (e) {}
  const n = (k, one, many) => k + " " + (k === 1 ? one : many);
  const parts = []; if (o && o.offers) parts.push(n(o.offers, "open offer", "open offers")); if (o && o.bets) parts.push(n(o.bets, "bet in play", "bets in play"));
  host.innerHTML = !parts.length ? "" : `<div class="card"><div class="card__title">P2P Chance has been removed</div>
      <div class="view__desc">P2P Chance is no longer part of this app, and no new games can be started. You still have <b>${esc(parts.join(" and "))}</b>. There is nothing you need to do: open offers are withdrawn and their stake returned to your wallet, and bets in play are settled automatically. Keep the app open with your node running until this card disappears.</div></div>`;
}

// ============================ Minima Vestr ============================
// The screens of the Android Vestr as Pandamonium shows it (apks/base integrated/vestr: MainActivity, CreatorView, ContractUi,
// CreateContractActivity, CalculatorActivity, ContractDetailActivity; VestrDesign: orange on near black), over main/vestr.js.
// The covenant, the collect transaction and every command are the main process's and were not touched; the two calls that
// move funds are in renderer/apps-act.js (AppsAct.vestr), pinned by scripts/apps-money.test.cjs.
// The shared covenant: 0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE.
// The native app has no nicknames and no search (those are the blue MiniDapp's); neither is here.
let vestrTab = "creator";        // creator | collector | about
let vestrSub = null;             // null | "create" | "calc" | { coinid } (a contract's detail)
let vestrUpdateTimer = null;
let vestrTokMap = null;          // tokenid → name
let vestrBusy = false;           // a create or a collect is with the node
const VESTR_GRACE = [["None", 0], ["Daily", 24], ["Weekly", 168], ["Monthly", 720], ["Every 3 Months", 2190], ["Every 6 Months", 4320], ["Yearly", 8640]];
const VESTR_TABS = [["creator", "✎", "Creator"], ["collector", "❖", "Collector"], ["about", "ⓘ", "About"]];

function vAmt(v) { return TOK.tidyAmount(String(v == null ? "0" : v)) || "0"; }   // the node's own figure: never rounded
// A token is named from its id where the id is known (Minima, the one MxUSD); another token's own name is shown WITH its whole
// id (nameWithId), and when it takes one of those two names the id alone is shown.
function vTok(tid) {
  const k = PayLabel.token(tid); if (k.known) return k.name === "MINIMA" ? "Minima" : k.name;
  return nameWithId(tid, vestrTokMap && vestrTokMap[tid]);   // a name not known by id is shown with the whole id (the create review too)
}
function vRel(ms) {
  if (!(ms > 0)) return "";
  const d = ms - Date.now(), a = Math.abs(d), u = a >= 86400000 ? Math.floor(a / 86400000) + " day(s)" : a >= 3600000 ? Math.floor(a / 3600000) + " hour(s)" : Math.floor(a / 60000) + " min(s)";
  return d > 0 ? "in " + u : u + " ago";
}
function vStatus(text, ok) { const s = el("vsStatus"); if (!s) return; s.textContent = text; s.hidden = !text; s.className = "vs-status " + (ok ? "vs-status--ok" : "vs-status--err"); }
function vestrGo(tab, sub) { vestrTab = tab || vestrTab; vestrSub = sub || null; renderVestr(); }

function onVestrUpdate() {
  if (vestrUpdateTimer) clearTimeout(vestrUpdateTimer);
  vestrUpdateTimer = setTimeout(() => {
    if (activeView !== "vestr" || vestrBusy) return;
    if (vestrSub === "create" || vestrSub === "calc") return;   // never redraw a form under the user
    if (el("vestrBody") && el("vestrBody").querySelector("input:focus")) return;
    renderVestr();
  }, 350);
}

async function renderVestr() {
  const host = el("vestrBody"); if (!host) return;
  if (!vestrTokMap && running) { try { const t = await api.vestrTokens(); vestrTokMap = {}; (t || []).forEach(x => { vestrTokMap[x.tokenid] = x.name; }); } catch (e) {} }
  const st = await api.vestrStatus().catch(() => ({}));
  const keep = el("vdBurn") ? el("vdBurn").value : null;   // the fee typed on a contract's screen outlives a redraw on a new block
  const title = vestrSub === "create" ? "Create a contract" : vestrSub === "calc" ? "Calculate a contract" : vestrSub ? "Contract" : "";
  host.innerHTML = `<div class="vs">${vestrSub
      ? `<div class="vs-head vs-head--sub"><button class="vs-back" id="vsBack" aria-label="Back">‹</button><span class="vs-head__sub">${title}</span></div>`
      : `<div class="vs-head"><span class="vs-head__t">vestr</span><span class="vs-head__b">${st && st.block ? "#" + esc(String(st.block)) : ""}</span></div>`}
    <div class="vs-page" id="vestrSub"></div>
    ${vestrSub ? "" : `<div class="vs-nav" role="tablist">${VESTR_TABS.map(([id, g, l]) => `<button class="vs-tab${vestrTab === id ? " vs-tab--on" : ""}" role="tab" aria-selected="${vestrTab === id}" data-vtab="${id}"><span class="vs-tab__g" aria-hidden="true">${g}</span><span class="vs-tab__l">${l}</span></button>`).join("")}</div>`}</div>`;
  host.querySelectorAll("[data-vtab]").forEach(b => { b.onclick = () => vestrGo(b.dataset.vtab); });
  if (el("vsBack")) el("vsBack").onclick = () => vestrGo();
  const page = el("vestrSub");
  if (!running) { page.innerHTML = `<div class="vs-banner"><div class="vs-banner__t">vestr is not enabled yet</div><div class="vs-banner__d">The node is not running. Start it on the Node tab, then come back.</div></div>`; return; }
  if (vestrSub === "create") return renderVestrCreate(page);
  if (vestrSub === "calc") return renderVestrCalc(page);
  if (vestrSub) return renderVestrDetail(page, vestrSub.coinid, keep);
  if (vestrTab === "about") return renderVestrAbout(page);
  return renderVestrList(page);
}

// One contract, as ContractUi.card. The contract id is shown whole (the phone's Pandamonium copy cuts it; the standalone app does not).
function vestrCard(v) {
  const tok = vTok(v.tokenid), when = (ms, a, b) => { const r = vRel(ms); return r ? (r.startsWith("in ") ? a + " " + r : b + " " + r) : ""; };
  return `<div class="vs-card" role="button" tabindex="0" data-vcoin="${esc(v.coinid)}">
    <div class="vs-card__hd"><span class="vs-card__ic" aria-hidden="true">${esc(tok.slice(0, 1).toUpperCase())}</span>
      <div class="vs-card__tt"><div class="vs-card__id">Contract ${esc(v.uid)}</div><div class="vs-card__amt">${esc(vAmt(v.amount))} ${esc(tok)}</div></div></div>
    <div class="vs-card__bd"><div class="vs-card__l"><div>Total vested: ${esc(vAmt(v.total))}</div><div>Collected: ${esc(decSub(String(v.total), String(v.amount)))}</div></div>
      <div class="vs-card__r"><div>Collection: ${esc(v.graceLabel)}</div><div>${esc(when(v.startMs, "starts", "started"))}</div><div>${esc(when(v.endMs, "ends", "ended"))}</div></div></div></div>`;
}
async function renderVestrList(page) {
  let vs = null; try { vs = await api.vestrList(); } catch (e) {}
  if (el("vestrSub") !== page) return;
  const cards = !vs ? `<div class="vs-empty">The contracts could not be read from the node. This screen tries again on the next block.</div>`
    : vs.length ? vs.map(vestrCard).join("") : `<div class="vs-empty">${vestrTab === "creator" ? "You have no vesting contracts yet." : "Nothing to collect yet."}</div>`;
  page.innerHTML = vestrTab === "creator"
    ? `<button class="vs-cta" id="vsCreate">＋  Create a contract</button><button class="vs-cta vs-cta--2" id="vsCalc">≈  Calculate a contract</button><h2 class="vs-h">My contracts</h2>${cards}`
    : `<h1 class="vs-h1">Collect</h1><div class="vs-blurb">Open a contract to withdraw the tokens that have vested.</div>${cards}`;
  cardKeys(page);
  if (el("vsCreate")) { el("vsCreate").onclick = () => vestrGo(null, "create"); el("vsCalc").onclick = () => vestrGo(null, "calc"); }
  page.querySelectorAll("[data-vcoin]").forEach(c => { c.onclick = () => vestrGo(null, { coinid: c.dataset.vcoin }); });
}
function renderVestrAbout(page) {
  page.innerHTML = `<h1 class="vs-about__t">vestr</h1>
    <div class="vs-about__d">Lock tokens in a vesting contract that releases gradually over time. Create a contract, track it, and withdraw what has vested.</div>
    <button class="vs-cta" id="vsAbCreate">Create a contract</button><button class="vs-cta vs-cta--dark" id="vsAbCollect">Collect from a contract</button>
    <div class="vs-about__f">Contracts are an on-chain Minima smart contract, fully interoperable with the vestr MiniDapp.</div>`;
  el("vsAbCreate").onclick = () => vestrGo("creator"); el("vsAbCollect").onclick = () => vestrGo("collector");
}

// ---- a contract's detail (ContractDetailActivity): the node works out what can be collected; one button, no confirm, as the original ----
async function renderVestrDetail(page, coinid, keepFee) {
  let vs = null; try { vs = await api.vestrList(); } catch (e) {}
  if (el("vestrSub") !== page) return;
  const v = (vs || []).find(x => x.coinid === coinid);
  if (!v) { page.innerHTML = `<div class="vs-empty">${vs ? "This contract is no longer in the list. If you have just collected its last tokens, it is finished." : "The contract could not be read from the node."}</div>`; return; }
  const tok = vTok(v.tokenid), can = !!v.canCollectNow;
  const row = (k, val) => `<div class="vs-row"><span>${k}</span><b>${esc(val)}</b></div>`;
  const copyRow = (k, val) => `<button class="vs-copy" data-copy="${esc(val)}"><span>${k}</span><code>${esc(val)}</code></button>`;
  page.innerHTML = `<div class="vs-hero${can ? " vs-hero--on" : ""}"><div class="vs-hero__l">Available to collect</div><div class="vs-hero__v">${esc(vAmt(v.cancollect))} ${esc(tok)}</div></div>
    ${row("Collected", decSub(String(v.total), String(v.amount)))}${row("Total vested", vAmt(v.total))}${row("Remaining in contract", vAmt(v.amount))}${row("Collect every", v.graceLabel)}
    ${row("Grace remaining", v.mustwait && Number(v.mustwaitblocks) > 0 ? vAmt(v.mustwaitblocks) + " blocks" : "ready")}${row("Starts", vRel(v.startMs))}${row("Ends", vRel(v.endMs))}
    ${row("Start block", String(v.startBlock))}${row("End block", String(v.endBlock))}
    ${copyRow("Token id", v.tokenid)}${copyRow("Coin id", v.coinid)}${copyRow("Withdrawal address", v.beneficiary)}${copyRow("Contract id", v.uid)}
    <label class="vs-label" for="vdBurn">Network fee (burn, optional)</label><input class="vs-in" id="vdBurn" inputmode="decimal" placeholder="0" autocomplete="off" />
    <button class="vs-cta vs-cta--form" id="vdCollect"${can ? "" : " disabled"}>${can ? "Collect " + esc(vAmt(v.cancollect)) + " " + esc(tok) : "Nothing to collect yet"}</button>
    <div class="vs-status" id="vsStatus" hidden></div>`;
  if (keepFee) el("vdBurn").value = keepFee;
  page.querySelectorAll("[data-copy]").forEach(b => { b.onclick = () => copy(b.dataset.copy); });
  el("vdCollect").onclick = async () => {
    if (vestrBusy) return; vestrBusy = true;
    const btn = el("vdCollect"); btn.disabled = true; vStatus("Collecting…", true);
    const r = await AppsAct.vestr.collect(api, coinid, el("vdBurn").value);
    vestrBusy = false;
    if (!el("vsStatus")) return;
    if (r.err) { vStatus("Failed: " + r.err, false); btn.disabled = false; return; }
    vStatus("✓ Collected. The tokens will arrive shortly.", true);
    setTimeout(() => { if (vestrSub && vestrSub.coinid === coinid) vestrGo("collector"); }, 1400);
  };
}

// ---- Create a contract (CreateContractActivity) ----
function vestrForm(extra) {
  return `<label class="vs-label" for="vcAmt">Token amount</label><input class="vs-in" id="vcAmt" inputmode="decimal" placeholder="0.0" autocomplete="off" />
    <label class="vs-label" for="vcStart">Contract start</label><input class="vs-in" id="vcStart" type="datetime-local" aria-label="Select start date & time" />
    <label class="vs-label" for="vcEnd">Contract end</label><input class="vs-in" id="vcEnd" type="datetime-local" aria-label="Select end date & time" />
    <label class="vs-label" for="vcGrace">${extra ? "Grace period (time between collections)" : "Grace period"}</label>
    <select class="vs-in" id="vcGrace">${VESTR_GRACE.map(([l, h]) => `<option value="${h}"${l === "Daily" ? " selected" : ""}>${l}</option>`).join("")}</select>`;
}
const vestrWhen = (id) => { const v = el(id).value; return v ? new Date(v).getTime() : NaN; };
async function renderVestrCreate(page) {
  let toks = []; try { toks = await api.vestrTokens(); } catch (e) {}
  let mine = ""; try { mine = await api.vestrMyAddress(); } catch (e) {}
  if (el("vestrSub") !== page) return;
  page.innerHTML = `<label class="vs-label" for="vcTok">Token</label>
    <select class="vs-in" id="vcTok">${(toks || []).map(t => `<option value="${esc(t.tokenid)}">${esc(vTok(t.tokenid))}  (${esc(vAmt(t.sendable))})</option>`).join("") || '<option value="0x00">Minima</option>'}</select>
    <label class="vs-label" for="vcAddr">Withdrawal address</label><input class="vs-in vs-in--mono" id="vcAddr" placeholder="Mx… or 0x…" value="${esc(mine)}" autocomplete="off" spellcheck="false" />
    ${vestrForm(true)}
    <label class="vs-label" for="vcBurn">Burn (optional, MINIMA)</label><input class="vs-in" id="vcBurn" inputmode="decimal" placeholder="0" autocomplete="off" />
    <label class="vs-label" for="vcPw">Vault password (only if your node is locked)</label><input class="vs-in" id="vcPw" type="password" placeholder="Vault password" autocomplete="off" />
    <button class="vs-cta vs-cta--form" id="vcCreate">Review &amp; create</button><div class="vs-status" id="vsStatus" hidden></div>`;
  el("vcCreate").onclick = async () => {
    if (vestrBusy) return;
    const f = { tokenid: el("vcTok").value, amount: el("vcAmt").value, beneficiary: el("vcAddr").value, startMs: vestrWhen("vcStart"), endMs: vestrWhen("vcEnd"), graceHours: el("vcGrace").value, burn: el("vcBurn").value, password: el("vcPw").value };
    const bad = AppsAct.vestr.createProblem(f, Date.now()); if (bad) { vStatus(bad, false); return; }
    vestrBusy = true; el("vcCreate").disabled = true; vStatus("Creating contract…", true);
    // The review the button's name promises (the phone sends at once). The address is whole, on its own line: there is no cancel in this covenant.
    const r = await AppsAct.vestr.create(api, { confirm: showConfirm }, f, vTok(f.tokenid), (VESTR_GRACE.find(g => g[1] === Number(f.graceHours)) || [""])[0]);
    vestrBusy = false;
    if (!el("vcCreate")) return;
    if (r.cancelled) { el("vcCreate").disabled = false; vStatus("", true); return; }
    if (r.err) { el("vcCreate").disabled = false; vStatus(r.err, false); return; }
    vStatus("✓ Contract created. It will appear in your contracts shortly.", true);
    setTimeout(() => { if (vestrSub === "create") vestrGo("creator"); }, 1400);
  };
}

// ---- Calculate a contract (CalculatorActivity): one figure, nothing sent ----
function renderVestrCalc(page) {
  page.innerHTML = `${vestrForm(false)}<button class="vs-cta vs-cta--form" id="vkGo">Calculate</button><div class="vs-status" id="vsStatus" hidden></div>`;
  el("vkGo").onclick = async () => {
    const amt = el("vcAmt").value.trim(), s = vestrWhen("vcStart"), e = vestrWhen("vcEnd"), hours = Number(el("vcGrace").value) || 0;
    if (!/^\d+(\.\d+)?$/.test(amt) || !(Number(amt) > 0)) return vStatus("Enter a valid amount.", false);
    if (!isFinite(s) || !isFinite(e)) return vStatus("Pick start and end dates.", false);
    if (!(e > s)) return vStatus("End must be after the start.", false);
    const r = await api.vestrCalculate(amt, s, e, hours).catch(() => null);
    if (!r) return vStatus("The figure could not be worked out.", false);
    // an estimate, cut and never rounded up, never more than the whole amount (the phone's paymentPerGrace)
    const cut = (x, dp) => { const m = Math.pow(10, dp); return String(Math.min(Number(amt), Math.floor(x * m) / m)); };
    vStatus(hours > 0 ? "Released per period (" + (VESTR_GRACE.find(g => g[1] === hours) || [""])[0] + "): " + cut(r.perPeriod, 2) : "Released per block: " + cut(r.perBlock, 8), true);
  };
}


// ---- Parlons: the account this node hosts (Parlons Node kind) ------------------------------------------
// The account serves its own web panel on loopback. Since 0.19.3 the app does not embed it: the Parlons row opens it in
// the system browser with the node's one-time link, and this screen says where it is and what state the account is in.
let parlonsLastSig = "";       // readiness/error signature that last drove a re-render
let parlonsRenderSeq = 0;
/** Open the panel in the system browser with a fresh one-time link (only ever the node's loopback panel; main/parlons.js). */
async function openParlons() {
  const ok = await api.parlonsOpenExternal().catch(() => false);
  if (!ok) toast("The account has no sign-in link yet. Try again in a moment.", "err");
  return ok;
}
async function renderParlons() {
  const seq = ++parlonsRenderSeq;
  const strip = el("parlonsStrip"), body = el("parlonsBody");
  function retry(message) {
    strip.innerHTML = `<div class="parlons-strip"><span>${esc(message)}</span><button class="btn btn--sm btn--outline" id="parlonsReload">Reload</button></div>`;
    body.innerHTML = `<div class="spin" role="status">${esc(message)}</div>`;
    el("parlonsReload").onclick = () => renderParlons();
  }
  const st = await api.parlonsStatus().catch(() => null);
  if (seq !== parlonsRenderSeq) return;
  if (!st) { retry("Could not check the account. Reload to try again."); return; }
  if (st.kind !== "parlons") {
    strip.innerHTML = "";
    body.innerHTML = `<div class="card"><div class="card__title">Parlons</div>
      <div class="view__desc">Your node can host your Parlons account: private chat, calls and payments under this node's own seed, with your phones and computers paired to it. This install still runs the plain Minima node.</div>
      ${st.blocker ? `<div class="status status--warn">${esc(st.blocker)}</div>` : `<button class="btn btn--primary btn--full" id="parlonsSwitch">Switch to the Parlons Node (restarts the node; wallet and data stay)</button>`}
      </div>`;
    const b = el("parlonsSwitch");
    if (b) b.onclick = async () => {
      if (!await showConfirm("Switch this node to the Parlons Node?",
          "Same chain, same wallet, same data folder — plus your Parlons account. The node restarts now.", "Switch")) return;
      b.disabled = true; b.textContent = "Switching…";
      try { await api.setNodeKind("parlons"); CFG = await api.getConfig(); toast("Parlons Node starting…", "ok"); renderParlons(); }
      catch (e) { toast(e.message || String(e), "err"); b.disabled = false; b.textContent = "Switch to the Parlons Node"; }
    };
    return;
  }
  if (!st.ready || st.error) {
    strip.innerHTML = `<div class="parlons-strip"><span>${st.error ? "Account error" : "Starting the account…"}${st.version ? " · Parlons Node " + esc(st.version) : ""}</span>
        <button class="btn btn--sm btn--outline" id="parlonsReload">Reload</button></div>${st.error ? `<div class="status status--warn">${esc(st.error)}</div>` : ""}`;
    el("parlonsReload").onclick = () => renderParlons();
    body.innerHTML = `<div class="spin">${st.error ? "The account did not start. See Logs in the menu." : "Waiting for the account to attach to the network…"}</div>`;
    return;
  }
  // Parlons is its own app and opens in your browser (owner decision, 19 Nov 2026): nothing of it is embedded here.
  strip.innerHTML = "";
  body.innerHTML = `<div class="card"><div class="card__title">Parlons</div>
    <div class="view__desc">Parlons opens in your browser, signed in to the account on this node. Each time, the app asks the node for a new one-time link, and only for this computer.</div>
    <button class="btn btn--primary btn--full" id="parlonsOpen">Open Parlons in the browser</button>
    ${st.address ? `<div class="view__desc" style="margin-top:14px">Your Parlons address</div><div class="addrbox__addr" id="parlonsAddr" title="Copy" style="cursor:copy;overflow-wrap:anywhere">${esc(st.address)}</div>` : ""}
    <div class="view__desc" style="margin-top:14px">While the node runs, this app tells you when a Parlons message arrives. It tells you of an incoming call only while Parlons is open in a browser tab or a paired phone is in reach: with neither, the node declines the call at once and tells nothing. Calls are answered in the Parlons tab.</div>
    ${st.version ? `<div class="view__desc" style="margin-top:8px">Parlons Node ${esc(st.version)}</div>` : ""}</div>`;
  el("parlonsOpen").onclick = openParlons;
  const addr = el("parlonsAddr"); if (addr) addr.onclick = () => { copy(st.address); toast("Copied.", "ok"); };
}
