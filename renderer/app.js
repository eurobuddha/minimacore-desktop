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
let TERM_OUT = "";
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
 * surface holding the value. Txid toasts used to print `short(txid, 12)` and nothing anywhere kept the rest.
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
function short(s) { return String(s || ""); }   // RULE 1: every caller passes an identifier (tx/coin id, address, key, state) - shown WHOLE
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
  api.onParlonsIncoming(() => selectTab("parlons"));
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
function onStatus(s) {
  paintKeyMode(s.keyMode);
  paintFooter(s);
  nodeState = s.state;
  // A node the user shut down: say so on every screen, with the way back. (At launch the node is "stopped" for a moment too.)
  el("stopBar").hidden = !(s.state === "stopped" && !waitingForNode && CFG.setupDone && CFG.walletDone);
  if (s.health && s.health.block) {                                      // both APK-parity headers carry the tip
    PoolsPanel.setBlock(s.health.block);
    AtomixPanel.setBlock(s.health.block);
  }

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
  if (wasRunning && !running) { resetWalletFigures(); if (activeView === "balances" || activeView === "faucet") renderActive(); }
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
    <p class="ps-note">The same 24 words give different addresses in each mode. If you choose the wrong one, the wallet opens with no funds in it. Nothing is lost: restore again and choose the other.</p>`;
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
 * megammrsync, built in ONE place for every screen that runs it (chain resync, restore from a file, rebuild
 * from a phrase, the first-run restore). Returns { error } or { cmd, resetsWallet }. The node's command
 * parser has no escape character, so refusing a value is the only defence: every check the Settings cards
 * and the setup dialog made is here, in their order.
 */
function resyncCommand(o) {
  const host = String(o.host || "").trim();
  const phrase = String(o.phrase || "").trim();   // a free-form phrase is hashed as typed: trim the ends only, never the inside
  const keyuses = String(o.keyuses == null ? "" : o.keyuses).trim(), file = String(o.file || "").trim(), password = String(o.password || "");
  if (o.needPhrase && !phrase) return { error: "Enter your seed phrase." };
  if (/["\\]/.test(phrase)) return { error: "This seed contains a \" or \\ the restore can't carry safely. Remove it or restore via the node terminal." };
  if (/[\n\r\t]/.test(phrase)) return { error: "Remove the line breaks and tabs: enter your seed as one clean line (they change the derived wallet)." };
  if (!/^[\w.\-]+:\d+$/.test(host)) return { error: "MegaMMR host must be host:port." };
  if (phrase && !/^\d+$/.test(keyuses)) return { error: "Enter the key uses for this seed (0 if brand new). Too low reuses one-time keys and can lose funds." };
  if (keyuses && !/^\d+$/.test(keyuses)) return { error: "Key uses must be a whole number." };
  if (o.needFile && !file) return { error: "Enter the backup file's name or path." };
  if (/[\s"\\]/.test(file)) return { error: "File path can't contain spaces or quotes." };
  if (/[\s"\\]/.test(password)) return { error: "Password can't contain spaces or quotes." };
  let cmd = `megammrsync action:resync host:${host}`;
  if (phrase) cmd += ` phrase:"${phrase}"` + (o.anyphrase ? " anyphrase:true" : "");
  if (keyuses) cmd += ` keyuses:${keyuses}`;
  if (file) cmd += ` file:${file}`;
  if (password) cmd += ` password:${password}`;
  return { cmd, resetsWallet: !!(phrase || file) };
}
// The wallet under the app changed (a restored seed or backup): every identity derived from the old seed is
// dropped and nothing the old wallet said stays on screen.
async function walletReplaced() {
  try { await api.mailInvalidate(); } catch (e) {} resetMailState();
  try { await api.ppInvalidate(); } catch (e) {} resetPpState();
  try { await api.axInvalidate(); } catch (e) {} resetAxState();
  try { await api.casinoInvalidate(); } catch (e) {}
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
      await cmd(built.cmd);
      CFG = await api.saveConfig({ megammrHost: built.host });
      if (built.resetsWallet) await walletReplaced();
      toast(label + " complete ✓", "ok"); bkOpen("");
    } catch (e) { st.textContent = label + " not completed. " + e.message; btn.disabled = false; btn.textContent = btn.dataset.label; }
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
      field("bkFilePw", "Backup password", 'type="password" placeholder="the password used when it was made"') + hostField +
      `<button class="btn btn--primary ps-btn ps-btn--main ps-btn--go" id="bkGo" data-label="Restore this node">Restore this node</button><div class="bk-status" id="bkStatus" role="status"></div>`;
    $("bkGo").onclick = () => { const f = $("bkFile").value.trim(); run("bkGo", "Restore", built({ host: $("bkHost").value, file: f, password: $("bkFilePw").value, needFile: true }), "Replace this node?",
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
    await cmd(built.cmd);
    RESTORE = null;   // clear the seed from memory
    await walletReplaced();   // seed changed: every identity derived from the old one is dropped
    CFG = await api.saveConfig({ walletDone: true, megammrHost: host });
    hideSetup(); renderActive(); toast("Wallet restored ✓", "ok");
  } catch (e) {
    const st = el("rStat"); if (st) { st.textContent = "⚠ " + e.message; st.style.color = "var(--red)"; }
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
const TAB_OF = { balances: "wallet", atomix: "dexicon", pandapools: "dexicon", history: "history", apps: "apps", chat: "chat", node: "node" };
const SUB_TITLE = { receive: "Receive", send: "Send", logs: "Logs", terminal: "Terminal", settings: "Settings", params: "Startup Params", backup: "Backup & Recovery" };
// The tray, in Pandamonium's default order (PandamoniumDestinations). Apps the desktop does not have yet
// (Future Cash Next, Minima Explorer, Entropy, KeyUses) get a row when their phase builds them: no dead rows.
const TRAY_APPS = [
  { id: "core", name: "Minima Core" },
  { id: "mail", name: "MinimaMail", icon: "icons/mail.png", badge: "mailBadge" },
  { id: "ethwallet", name: "ETH Wallet", icon: "icons/ethwallet.png" },
  { id: "vestr", name: "Minima Vestr", icon: "icons/vestr.png" },
  { id: "faucet", name: "Minima Faucet", icon: "icons/faucet.svg" },
  { id: "minimall", name: "miniMall", icon: "icons/minimall.png", badge: "shopBadge" },
  { id: "webwallet", name: "Web Wallet", icon: "minima-mark.svg" },
  { id: "parlons", name: "Parlons", icon: "icons/parlons.png" }
];
const CORE_MARK = '<svg class="tray__ic" viewBox="0 0 105 100" aria-hidden="true"><path d="M84.16,26.77L79.52,48.44L73.58,22.29L52.79,13.38L47.17,39.59L42.21,8.86L21.42,0L0,100H22.71L29.27,69.27L34.23,100H56.98L62.56,73.8L68.5,100H91.21L105,35.63L84.16,26.77Z"/></svg>';
const NARROW = window.matchMedia("(max-width: 719px)");   // below this the tray overlays, as on the phone
let lastTabView = "balances";   // where Back returns to, and where "Minima Core" in the tray lands
let dexView = "atomix";         // which of the two panels the Dexicon tab last showed
let APP_VERSION = "";
function store(key, value) {    // shell preferences only (tray open, order, hidden); never anything that matters
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) {}
  return null;
}
// The saved tray order, as PandamoniumOrder.decode: Minima Core is pinned first, then the saved ids that
// still exist (each once), then any app the saved order has never seen, in the default order.
function trayOrder(saved, ids) {
  const order = [ids[0]];
  for (const id of String(saved || "").split(",")) if (ids.indexOf(id) > 0 && !order.includes(id)) order.push(id);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}
function viewOfTab(tab) { return tab === "wallet" ? "balances" : tab === "dexicon" ? dexView : tab; }
function shellMode(view) { const tab = TAB_OF[view] || ""; return { tab, mode: tab ? "tabs" : SUB_TITLE[view] ? "sub" : "app" }; }

function selectTab(view) {
  // Auto-lock the Web Wallet when navigating away — never leave the seed in renderer memory on another tab.
  if (activeView === "webwallet" && view !== "webwallet" && typeof wwLock === "function") wwLock();
  if (activeView === "backup" && view !== "backup") el("backupBody").innerHTML = "";   // a shown seed phrase or a typed password never outlives the screen
  activeView = view;
  const { tab, mode } = shellMode(view);
  if (tab) { lastTabView = view; if (tab === "dexicon") dexView = view; }
  el("shell").dataset.mode = mode;
  el("shell").dataset.tab = tab;
  el("barPage").textContent = SUB_TITLE[view] || "";
  document.querySelectorAll(".tab").forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("tab--active", on); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".dexswitch__b").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === view ? "true" : "false"));
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
  document.querySelectorAll(".dexswitch__b").forEach(b => b.onclick = () => selectTab(b.dataset.view));
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
    if (NARROW.matches) setTray(false);
  });
  initTrayOrder(list);
  applyHiddenApps();
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
  FOOT_KEYS = null; FOOT_KEYS_AT = 0; NODE_DASH = {}; NODE_DASH_AT = 0; BAL_BY_TID = {}; RECV_ADDR = null;
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
    // Ask the AtomiX and PandaPools glue what is in flight first (their own saved records; no node command).
    const read = (p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => setTimeout(() => r(null), 5000))]);
    const [swaps, maker, pool] = await Promise.all([read(api.axSwaps()), read(api.axMakerCfg()), read(api.ppActivity())]);
    const w = shutdownWarning(swaps, maker, pool, Date.now());
    if (!await showConfirm(w.title, w.message, "Shut down", true)) return;
    toast("Shutting down the node…");
    try { await api.nodeStop(); } catch (e) { toast(e.message || String(e), "err"); }
  }
}
// What a Shutdown would interrupt, in plain words. swaps = api.axSwaps(), maker = api.axMakerCfg(), pool =
// api.ppActivity(); null means that read failed, and the dialog says so instead of looking idle.
const SWAP_DONE = ["COMPLETE", "REFUNDED", "ERROR"];   // the engine's own "nothing left to claim or refund" (trading.js isTerminalSwap)
function shutdownWarning(swaps, maker, pool, nowMs) {
  const busy = [], unread = [];
  if (!Array.isArray(swaps)) unread.push("AtomiX swaps");
  else {
    const n = swaps.filter(s => s && !SWAP_DONE.includes(s.status)).length;
    if (n) busy.push((n === 1 ? "1 AtomiX swap is" : n + " AtomiX swaps are") + " in progress. A swap in progress cannot settle while the node is stopped and can time out. Start the node again before its time limit.");
  }
  if (!maker || typeof maker !== "object") unread.push("your AtomiX market");
  else if ((maker.cfg || {}).pegEnable || (maker.cfg || {}).manualEnable) {
    if (!(maker.state || {}).withdrawn) busy.push("Your AtomiX market is switched on. Its orders stay on the book, but a swap someone starts against them is not answered while the node is stopped.");
  }
  if (!Array.isArray(pool)) unread.push("pool operations");
  else {
    // ponytail: "recent and not confirmed" stands for pending; an old transaction this node never found stays unconfirmed for good
    const n = pool.filter(r => r && r.type !== "STATUS" && !r.failed && !r.confirmed && nowMs - Number(r.ts || 0) < 3600000).length;
    if (n) busy.push((n === 1 ? "1 pool transaction" : n + " pool transactions") + " sent in the last hour " + (n === 1 ? "is" : "are") + " not confirmed yet. The app cannot check or finish " + (n === 1 ? "it" : "them") + " while the node is stopped.");
  }
  if (unread.length) busy.push("Could not be checked: " + unread.join(", ") + ". Look at the Dexicon tab before you shut down.");
  const base = "The node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until you start it again.";
  return { title: busy.length > (unread.length ? 1 : 0) ? "Shut down with trades in flight?" : "Shut down the node?", message: busy.concat(base).join("\n\n") };
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
    : s.state === "error" ? "Node error" : s.state === "stopped" ? "Node stopped" : "Awaiting blocks…";
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
// Access a wallet straight from a seed phrase, backed by the LOCAL -megammr node. The seed is passed to main
// only for loopback signing (keys genkey → sendfrom on 127.0.0.1) and is never persisted. Held here in memory
// while unlocked; cleared on Lock. See main/webwallet.js for the fund-critical send + keyuses handling.
let wwLastStatus = null, wwSeed = null, wwAddr = null, wwBal = [], wwKu = null, wwArmed = false, wwKuSuggest = 0, wwAmbiguous = false, wwMode = null;

// The 4 render "modes". A LIVE update (block tick / status push) must ONLY re-render when the mode CHANGES —
// re-rendering the same mode rebuilds the panel and WIPES whatever the user is typing (the seed textarea, the send
// form). User-initiated calls (tab select, unlock, refresh, lock, send) call renderWebWallet() directly instead.
function currentWwMode() { if (!running) return "waiting"; if (!wwMegammrOn()) return "gate"; if (!wwSeed || !wwAddr) return "unlock"; return "wallet"; }
function wwLiveRender() { if (activeView === "webwallet" && currentWwMode() !== wwMode) renderWebWallet(); }
function onWebWalletUpdate() { wwLiveRender(); }
function wwLock() { wwSeed = null; wwAddr = null; wwBal = []; wwKu = null; wwArmed = false; wwKuSuggest = 0; wwAmbiguous = false; }
function wwMegammrOn() { return !!(wwLastStatus && wwLastStatus.health && wwLastStatus.health.megammr); }

async function renderWebWallet() {
  const body = el("webwalletBody");
  wwMode = currentWwMode();   // record what we're about to render, so wwLiveRender only re-renders on a real change
  if (!running) { body.innerHTML = `<div class="view__title">Web Wallet</div><div class="card"><div class="view__desc">Waiting for the node…</div></div>`; return; }
  if (!wwMegammrOn()) return renderWwGate(body);
  if (!wwSeed || !wwAddr) return renderWwUnlock(body);
  return renderWwWallet(body);
}

function renderWwGate(body) {
  body.innerHTML = `
    <div class="view__title">Web Wallet</div>
    <div class="card">
      <div class="view__desc"><b>A MegaMMR node is required.</b> The Web Wallet accesses a wallet from its seed
        phrase, so the node must keep the full MegaMMR to serve coin data + proofs for your wallet's addresses.</div>
      <div class="view__desc" style="opacity:.8">Enabling MegaMMR restarts the node and grows the node data over
        time. This is a one-time change.</div>
      <button class="btn btn--outline btn--full" id="wwEnableBtn">Enable MegaMMR &amp; restart node</button>
    </div>`;
  el("wwEnableBtn").addEventListener("click", async () => {
    const b = el("wwEnableBtn"); b.disabled = true; b.textContent = "Restarting node…";
    try { await api.wwEnableMegammr(); toast("MegaMMR enabled — node restarting", "ok"); }
    catch (e) { toast("Could not enable MegaMMR", "err"); b.disabled = false; b.textContent = "Enable MegaMMR & restart node"; }
  });
}

function renderWwUnlock(body) {
  body.innerHTML = `
    <div class="view__title">Web Wallet</div>
    <div class="card" style="border-color:var(--accent)">
      <div class="view__desc"><b>Runs entirely on this computer.</b> Your seed is sent only to your own local node
        (127.0.0.1) to derive keys and sign — it never leaves this machine and is never saved.
        <br><b>Never type your seed into a website Web Wallet</b> — a hosted site can steal it (that has drained wallets).</div>
    </div>
    <div class="card">
      <div class="field"><div class="field__label">Seed phrase</div>
        <textarea class="field__input" id="wwSeedIn" rows="3" placeholder="24 words, or your own passphrase" autocomplete="off" spellcheck="false"></textarea>
        <div class="prow__h">Any phrase is accepted (anyphrase). Enter it EXACTLY as created — it is case- and spacing-sensitive.</div></div>
      <button class="btn btn--outline btn--full" id="wwUnlockBtn">Unlock wallet</button>
    </div>`;
  el("wwUnlockBtn").addEventListener("click", async () => {
    // Pass the phrase VERBATIM (only trim leading/trailing whitespace) — the node hashes it faithfully, so
    // lowercasing/collapsing would derive a DIFFERENT wallet. Mirror the restore flow's guard (app.js:2784).
    const seed = String(el("wwSeedIn").value || "").trim();
    if (!seed) { toast("Enter your seed phrase.", "err"); return; }
    if (/["\\\n\r\t]/.test(seed)) { toast("Seed has a \", \\ or line break the command can't carry — enter it as one clean line.", "err"); return; }
    const b = el("wwUnlockBtn"); b.disabled = true; b.textContent = "Deriving…";
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
      toast((e && e.message) || "Could not unlock", "err");
      b.disabled = false; b.textContent = "Unlock wallet";
    }
  });
}

function renderWwWallet(body) {
  const a = wwAddr, ku = wwKu || { keyuses: 0, ack: false };
  const recv = a.miniaddress || a.address;
  let qrHtml = "";
  try { if (typeof qrcode !== "undefined") { const qr = qrcode(0, "M"); qr.addData(recv); qr.make(); qrHtml = `<div style="background:#fff;padding:8px;border-radius:8px;width:fit-content;margin:6px auto">${qr.createImgTag(4, 6)}</div>`; } } catch (e) {}

  // Match the original webWallet EXACTLY: display `confirmed`, and append "/<unconfirmed>" only when there is a
  // pending amount. It never shows `sendable` — a foreign megammr seed reports sendable:0 (the node holds none of its
  // keys) even though the coins are real and spendable via sendfrom, so showing sendable made a 655k wallet read "0".
  const balRows = (wwBal.length ? wwBal : []).map(b =>
    `<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin:6px 0">
       <span>${esc(b.name)}</span>
       <span style="font-family:var(--mono,monospace)">${esc(b.confirmed)}${
         (b.unconfirmed && String(b.unconfirmed) !== "0") ? `<small style="opacity:.6"> / ${esc(b.unconfirmed)}</small>` : ""}</span>
     </div>`).join("") || `<div class="view__desc">No balance yet for this wallet.</div>`;

  const tokOpts = (wwBal.length ? wwBal : [{ tokenid: "0x00", name: "MINIMA" }])
    .map(b => `<option value="${esc(b.tokenid)}">${esc(b.name)}</option>`).join("");

  const kuDefault = Math.max(Number(ku.keyuses) || 0, Number(wwKuSuggest) || 0);
  const kuPanel = a.isNodeSeed
    ? `<div class="view__desc">This is <b>your node's own wallet</b> — showing your full balance across every address. Sends go through the node, which selects coins and manages your signing keys automatically.</div>`
    : (ku.ack
    ? `<div class="view__desc">Key-uses confirmed: next signing index <b>${esc(String(ku.keyuses))}</b>. <a href="#" id="wwKuEdit">change</a></div>`
    : `<div class="card" style="border-color:var(--accent)">
         <div class="view__desc"><b>Confirm key-uses before sending.</b> How many payments has this wallet ALREADY made
           anywhere (0 for a brand-new seed)? Over-estimating is safe; <b>under-estimating can reuse a signing key and
           lose your funds</b>.${wwKuSuggest > 0 ? ` <b>On-chain check suggests at least ${esc(String(wwKuSuggest))}.</b>` : ""}</div>
         <div class="field"><div class="field__label">Payments already made by this seed</div>
           <input class="field__input" id="wwKuIn" type="number" min="0" step="1" value="${esc(String(kuDefault))}" /></div>
         <div style="display:flex;gap:8px">
           <button class="btn btn--outline" id="wwKuCheck">Check on-chain</button>
           <button class="btn btn--outline" id="wwKuConfirm">Confirm</button>
         </div>
       </div>`);

  const ambigBanner = wwAmbiguous
    ? `<div class="card" style="border-color:var(--accent)">
         <div class="view__desc"><b>⚠ Last send status is UNKNOWN.</b> The node didn't confirm — the payment may have
           gone through. Check <b>History</b> / your balance before sending again, or you could pay twice.</div>
         <button class="btn btn--outline" id="wwAmbigClear">I've checked — re-enable Send</button>
       </div>`
    : "";
  const sendDisabled = ((a.isNodeSeed || ku.ack) && !wwAmbiguous) ? "" : "disabled";
  body.innerHTML = `
    <div class="view__title" style="display:flex;justify-content:space-between;align-items:center">
      <span>Web Wallet</span>
      <span><button class="btn btn--ghost" id="wwRefresh">Refresh</button> <button class="btn btn--ghost" id="wwLockBtn">Lock</button></span>
    </div>
    <div class="card">
      <div class="view__desc">Receive address</div>
      ${qrHtml}
      <div class="addrbox" id="wwAddrBox" title="Click to copy">${esc(recv)}</div>
    </div>
    <div class="view__desc" style="margin:10px 2px 4px">Balances</div>
    ${balRows}
    <div class="view__desc" style="margin:12px 2px 4px">Send</div>
    ${kuPanel}
    ${ambigBanner}
    <div class="card">
      <div class="field"><div class="field__label">To (address)</div>
        <input class="field__input" id="wwTo" placeholder="Mx… or 0x…" autocomplete="off" spellcheck="false" ${sendDisabled}></div>
      <div class="field"><div class="field__label">Token</div>
        <select class="field__input" id="wwTok" ${sendDisabled}>${tokOpts}</select></div>
      <div class="field"><div class="field__label">Amount</div>
        <input class="field__input" id="wwAmt" placeholder="0.0" autocomplete="off" ${sendDisabled}></div>
      <button class="btn btn--outline btn--full" id="wwSendBtn" ${sendDisabled}>Send</button>
    </div>`;

  el("wwAddrBox").addEventListener("click", () => copy(recv));
  el("wwRefresh").addEventListener("click", async () => { wwBal = await api.wwRead(a.address, a.isNodeSeed).catch(() => wwBal); renderWebWallet(); });
  el("wwLockBtn").addEventListener("click", () => { wwLock(); renderWebWallet(); toast("Wallet locked", "ok"); });
  const ambigBtn = el("wwAmbigClear"); if (ambigBtn) ambigBtn.addEventListener("click", () => { wwAmbiguous = false; renderWebWallet(); });

  if (a.isNodeSeed) {
    el("wwSendBtn").addEventListener("click", () => wwDoSend());   // node wallet: no key-uses gate, node manages keys
  } else if (!ku.ack) {
    el("wwKuConfirm").addEventListener("click", async () => {
      const n = Math.max(0, Math.floor(Number(el("wwKuIn").value) || 0));
      try { wwKu = await api.wwAckKeyuses(a.address, n); renderWebWallet(); toast("Key-uses confirmed ✓", "ok"); }
      catch (e) { toast("Could not save key-uses", "err"); }
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
    const ed = el("wwKuEdit"); if (ed) ed.addEventListener("click", (ev) => { ev.preventDefault(); wwKu.ack = false; renderWebWallet(); });
    el("wwSendBtn").addEventListener("click", () => wwDoSend());
  }
}

async function wwDoSend() {
  const to = String(el("wwTo").value || "").trim();
  const amount = String(el("wwAmt").value || "").trim();
  const tokenid = el("wwTok").value;
  if (!to) { toast("Enter a recipient address", "err"); return; }
  if (!(Number(amount) > 0)) { toast("Enter a valid amount", "err"); return; }
  const btn = el("wwSendBtn");
  if (!wwArmed) {   // two-tap confirm — sends are irreversible
    wwArmed = true; btn.textContent = "Tap again to confirm — irreversible";
    setTimeout(() => { if (wwArmed) { wwArmed = false; btn.textContent = "Send"; } }, 4000);
    return;
  }
  wwArmed = false; btn.disabled = true; btn.textContent = "Sending…";
  let r;
  try { r = await api.wwSend({ seed: wwSeed, to, amount, tokenid }); }
  catch (e) { toast((e && e.message) || "Send failed", "err"); btn.disabled = false; btn.textContent = "Send"; return; }

  if (r && r.ok) {
    toast("Sent ✓" + (r.txnid ? " " + short(r.txnid, 12) : ""), "ok", r.txnid || null);
    el("wwTo").value = ""; el("wwAmt").value = "";
    wwKu = await api.wwKeyuses(wwAddr.address).catch(() => wwKu);
    wwBal = await api.wwRead(wwAddr.address, wwAddr.isNodeSeed).catch(() => wwBal);
    renderWebWallet();
  } else if (r && r.ambiguous) {
    // M1: don't offer a one-tap retry — surface the unknown state, refresh balances, and gate re-send behind
    // an explicit "I've checked" acknowledgement (renderWwWallet shows the banner while wwAmbiguous).
    wwAmbiguous = true;
    toast(r.message || "Send status unknown — verify before retrying", "err");
    wwBal = await api.wwRead(wwAddr.address, wwAddr.isNodeSeed).catch(() => wwBal);
    renderWebWallet();
  } else {
    toast((r && r.message) || "Send failed", "err");
    btn.disabled = false; btn.textContent = "Send";
  }
}

function renderActive() {
  if (!running && activeView !== "node") { /* wallet views need the node */ }
  if (activeView === "balances") renderBalances();
  else if (activeView === "receive") renderReceive();
  else if (activeView === "send") renderSend();
  else if (activeView === "webwallet") renderWebWallet();
  else if (activeView === "mail") renderMail();
  else if (activeView === "chat") renderChat();
  else if (activeView === "pandapools") renderPandapools();
  else if (activeView === "atomix") renderAtomix();
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
  if (WAL_DRAG) return;                                  // a row is being dragged: the 15 s rebuild waits for the drop
  if (!running) { el("walTotal").textContent = NO_FIGURE; WAL_MINIMA = null; paintWalBreakdown(); host.innerHTML = waitHtml(); return; }
  let bal = await tryCmd("balance");
  // a failed read is not an empty wallet: no old total above it, and no zero row
  if (!bal) { el("walTotal").textContent = NO_FIGURE; WAL_MINIMA = null; paintWalBreakdown(); host.innerHTML = `<div class="empty">The balance could not be read. It is read again every 15 seconds.</div>`; return; }
  BAL_AT = Date.now();                                   // drives the breakdown's "updated ..."
  // The phone always shows a Minima row, at 0 for a wallet that holds nothing yet.
  if (!bal.length) bal = [{ token: "Minima", tokenid: MINIMA, confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0" }];
  BAL_BY_TID = {};
  for (const b of bal) BAL_BY_TID[b.tokenid || MINIMA] = b;
  // "Total balance" is the MINIMA headline, the same sendable figure its row shows.
  WAL_MINIMA = BAL_BY_TID[MINIMA] || { confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0" };
  el("walTotal").textContent = summaryAmount(WAL_MINIMA.sendable || "0");
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
let BAL_BY_TID = {};       // tokenid → last balance row, so a row click can open its dialog without refetching
let BAL_AT = 0;            // when the last `balance` reply landed: the breakdown's "updated ..."
let WAL_MINIMA = null;     // the MINIMA balance row behind "Total balance" (null: not read)
let WAL_DRAG = null;       // the token row being dragged

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
  const locked = decSub(confirmed, sendable), parts = [];
  if (positive(locked)) parts.push("locked " + summaryAmount(locked));
  if (positive(b.unconfirmed)) parts.push("unconfirmed " + summaryAmount(b.unconfirmed));
  if (parseInt(b.coins, 10) > 0) parts.push(coinCount(b.coins));
  return `<div class="balrow" data-tokenid="${esc(tid)}" tabindex="0" role="button">
    ${iconCell}
    <div class="balrow__main">
    <div class="balrow__top"><span class="balrow__name">${esc(TOK.tokenName(b.token, tid))}</span><span class="balrow__amt">${esc(summaryAmount(sendable))}</span></div>
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
  toast("Consolidation submitted ✓ — coins merge over the next blocks.", "ok");
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
    <div class="kv"><span class="kv__k">Spendable</span><span class="kv__v kv__v--green">${esc(TOK.tidyAmount(sendable))}${tick ? " " + esc(tick) : ""}</span></div>
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
// Escape and a click outside close the top one; focus goes back to whatever opened it.
function openDlg(id, title, bodyHtml, buttonsHtml) {
  const opener = document.activeElement;
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay overlay--dlg" id="${id}"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="${id}Title" tabindex="-1">
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

/**
 * Every coin behind a token balance (the phone's CoinsDialog). ALL relevant coins are listed, the ones locked
 * in a contract included, because seeing what makes confirmed larger than sendable is the point. No coin id
 * is shortened. A coin opens its full detail. Split and Consolidate, the desktop's own, are two buttons here.
 */
async function showCoins(b) {
  const tid = b.tokenid || MINIMA, isNative = tid === MINIMA, name = TOK.tokenName(b.token, tid);
  const sendable = b.sendable || "0", confirmed = b.confirmed || "0", locked = decSub(confirmed, sendable);
  const head = `sendable ${TOK.tidyAmount(sendable)}` + (locked !== "0" ? `  ·  locked ${TOK.tidyAmount(locked)}` : "") + `  ·  confirmed ${TOK.tidyAmount(confirmed)}`;
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
  // so the LOCKED chips come from the difference. If the second read fails there are no chips, not no list.
  let all, sendableIds = null;
  try { all = await cmd(`coins relevant:true tokenid:${tid} simplestate:false`) || []; }
  catch (e) { if (d.root.isConnected) status("Coins query failed: " + (e.message || String(e)), "bad"); return; }   // a failed read is not an empty wallet
  try { sendableIds = new Set((await cmd(`coins relevant:true sendable:true tokenid:${tid} simplestate:false`) || []).map(c => c.coinid)); } catch (e) {}
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
  const isSendable = (c) => !sendableIds || sendableIds.has(c.coinid);   // unknown counts as sendable: no chip
  const tagOf = (c) => {
    const ad = String(c.address || "").toLowerCase(), mx = String(c.miniaddress || "").toLowerCase();
    if ((ad && poolAddrs.has(ad)) || (mx && poolAddrs.has(mx))) return `<span class="coin-chip">POOL</span>`;
    if (ad === PANDA_SENTINEL.toLowerCase()) return `<span class="coin-chip">BEACON</span>`;
    return "";
  };
  const list = el("coinsList");
  list.innerHTML = all.map((c, i) => `<div class="coin-row" data-i="${i}" tabindex="0" role="button">
      <div class="coin-row__top"><span class="coin-amt">${esc(TOK.tidyAmount(amountOf(c)))}</span>${isSendable(c) ? "" : `<span class="coin-chip coin-chip--locked">LOCKED</span>`}${tagOf(c)}</div>
      <div class="coin-row__cid">${esc(String(c.coinid || ""))}</div>
    </div>`).join("");
  list.querySelectorAll(".coin-row").forEach(r => {
    r.onclick = () => { const c = all[parseInt(r.dataset.i, 10)]; showCoinDetail(c, isSendable(c)); };
    r.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.click(); } };
  });
  el("coinsStatus").hidden = true; list.hidden = false;
  // The footer cross-checks the coins against the balance the Wallet tab is showing.
  let sum = "0"; for (const c of all) { try { sum = decAdd(sum, amountOf(c)); } catch (e) {} }
  const lockedCount = all.filter(c => !isSendable(c)).length, foot = el("coinsFoot");
  const differs = absCmp(sum, confirmed) !== 0;
  foot.textContent = coinCount(all.length) + (sendableIds ? `  ·  Locked: ${lockedCount}` : "") + `  ·  sum ${TOK.tidyAmount(sum)}`
    + (differs ? `\n⚠ sum ≠ confirmed (${TOK.tidyAmount(confirmed)})` : "");
  foot.classList.toggle("coins-foot--warn", differs);
  foot.hidden = false;
  // Consolidate merges SPENDABLE coins only, so it is offered when there are at least two of them.
  if (sendableIds && all.filter(c => sendableIds.has(c.coinid)).length >= 2) { el("coinsConsolidate").hidden = false; el("coinsTools").hidden = false; }
}

/** Everything the node knows about one coin (the phone's CoinDetailDialog). No value is shortened and each
 *  has its own Copy: an id that comes out of here must go back into `coins coinid:` byte for byte. */
function showCoinDetail(c, sendable) {
  const state = (c.state == null || (Array.isArray(c.state) ? !c.state.length : (typeof c.state === "object" ? !Object.keys(c.state).length : c.state === "")))
    ? "(none)" : (typeof c.state === "string" ? c.state : JSON.stringify(c.state, null, 2));
  const rows = [["Coin ID", c.coinid], ["Amount", c.amount], ["Token amount", c.tokenamount], ["Token ID", c.tokenid], ["Address", c.address],
    ["Mini address", c.miniaddress], ["Sendable", sendable ? "yes" : "no, locked in a contract"], ["Created", c.created], ["Age", c.age],
    ["MMR entry", c.mmrentry], ["Spent", c.spent], ["Store state", c.storestate], ["State", state]]
    .filter(([, v]) => v != null && String(v) !== "" && String(v) !== "null").map(([k, v]) => [k, String(v)]);
  const raw = JSON.stringify(c, null, 2);
  const d = openDlg("coinDlg", sendable ? "Coin, sendable" : "Coin, locked",
    rows.map(([k, v], i) => `<div class="cd-row"><div class="eyebrow">${esc(k)}</div>
        <div class="cd-row__line"><div class="cd-row__v">${esc(v)}</div><button class="dlg__btn dlg__btn--sm" data-i="${i}" aria-label="Copy ${esc(k)}">COPY</button></div></div>`).join("")
      + `<div class="eyebrow cd-raw-h">Raw JSON</div><pre class="cd-raw">${esc(raw)}</pre>`,
    `<button class="dlg__btn" id="coinCopyJson">Copy JSON</button>`);
  d.root.querySelectorAll(".cd-row [data-i]").forEach(b => b.onclick = () => copy(rows[parseInt(b.dataset.i, 10)][1]));
  el("coinCopyJson").onclick = () => copy(raw);
}

/** Split one token's own coins into equal pieces. The form and its checks are the Send screen's old Split
 *  form (0.18.65), moved here; the token is the one whose coins dialog opened it. */
function splitDialog(tok, name) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="splitOv"><div class="modal">
    <div class="modal__title">Split ${esc(name)}</div>
    <div class="view__desc">Split your own coins into equal pieces (useful for parallel sends).</div>
    <div class="field"><div class="field__label">Amount to split</div><input class="field__input" id="spAmt" placeholder="0.0" /></div>
    <div class="field"><div class="field__label">Into how many coins (2–20)</div><input class="field__input" id="spN" value="10" /></div>
    <div class="seg"><button class="btn btn--outline btn--full" id="spCancel">Cancel</button><button class="btn btn--primary btn--full" id="spGo">Split</button></div></div></div>`);
  const close = () => { const o = el("splitOv"); if (o) o.remove(); };
  el("spCancel").onclick = close;
  el("splitOv").onclick = (e) => { if (e.target.id === "splitOv") close(); };
  el("spGo").onclick = async () => {
    const amt = el("spAmt").value.trim(), n = parseInt(el("spN").value, 10) || 0;
    if (!validAmt(amt)) { toast("Enter a positive amount (digits only).", "err"); return; }
    if (n < 2 || n > 20) { toast("Split into 2–20 coins."); return; }
    if (!validTok(tok)) { toast("Token id must be a 0x… hex value.", "err"); return; }
    el("spGo").disabled = true;
    try { const a = await cmd("getaddress"); const addr = a.miniaddress || a.address;
      await cmd(`send address:${addr} amount:${amt} split:${n}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : "")); toast("Split ✓", "ok"); close(); }
    catch (e) { toast(e.message, "err"); }
    el("spGo").disabled = false;
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
function showConfirm(title, message, okLabel, danger) {
  return new Promise((resolve) => {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="confirmOv"><div class="modal">
      <div class="modal__title">${esc(title)}</div><div class="view__desc" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(message || "")}</div>
      <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="cfCancel">Cancel</button>
        <button class="btn ${danger ? "btn--danger" : "btn--primary"} btn--full" id="cfOk">${esc(okLabel || "OK")}</button></div></div></div>`);
    const ov = el("confirmOv"); const done = (v) => { if (ov) ov.remove(); resolve(v); };
    el("cfOk").onclick = () => done(true); el("cfCancel").onclick = () => done(false);
    ov.onclick = (e) => { if (e.target.id === "confirmOv") done(false); };
  });
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
    <div class="view__desc" style="white-space:pre-wrap">${esc(message)}${ok && txid ? "\n\nTx: " + esc(short(txid, 20)) : ""}</div>
    ${ok && txid ? `<button class="btn btn--outline btn--full" id="prCopy" style="margin-top:8px">Copy tx id</button>` : ""}
    <button class="btn btn--primary btn--full" id="prOk" style="margin-top:8px">OK</button></div></div>`);
  const ov = el("prOv"); const close = () => { if (ov) ov.remove(); };
  el("prOk").onclick = close; ov.onclick = (e) => { if (e.target.id === "prOv") close(); };
  if (el("prCopy")) el("prCopy").onclick = () => { copy(txid); toast("Copied.", "ok"); };
}

// ---- minimaMail — the panel lives in renderer/mail.js (APK parity, its own palette) -----------------------
// The old panel was ~590 lines here, shared app.css classes with miniMall (#view-minimall owns .mail-thread),
// and could not carry the APK's paper palette without leaking it into every other tab. app.js keeps only the
// wiring: shared dialogs and helpers go in through MailPanel.init, so neither file reaches into the other.
MailPanel.init({
  api, esc, el, toast, copy, short, relTime,
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
// ---- PandaPools — the panel lives in renderer/pools.js (APK parity, its own palette) ----------------------
// The old panel was ~740 lines here in the desktop's generic TERMINAL styling. app.js keeps only the wiring;
// every engine call, validation, confirm dialog and busy guard moved across verbatim.
PoolsPanel.init({
  api, esc, el, toast, copy, short, TOK,
  showConfirm, showProgress, tryCmd, PoolCalc, MINIMA,
  running: () => running,
  activeView: () => activeView
});
api.appVersion().then(v => PoolsPanel.setVersion(v)).catch(() => {});
function renderPandapools() { PoolsPanel.render(); }
function onPandapoolsUpdate() { PoolsPanel.onUpdate(); }
// Was called on every seed change / wallet reset but never defined — the ReferenceError killed the rest of
// that line, so the AtomiX and Casino resets beside it never ran either.
function resetPpState() { PoolsPanel.reset(); }

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
  const who = labelFor(r.counterparty) || short(r.counterparty, 20), tag = histOwnership(r.counterparty);
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
  const timeStr = r.time ? new Date(r.time).toLocaleString() : "—";
  const lbl = labelFor(r.counterparty);
  const who = r.counterparty ? (lbl ? `${lbl} (${short(r.counterparty, 16)})` : r.counterparty) : "—";
  const deltas = Object.keys(r.difference || {}).map(t => `${esc(TOK.shortId(t))}: ${esc(TOK.tidyAmount(r.difference[t]))}`).join("<br>") || "—";
  // Each coin: amount + token → address, with the coinid and any state variables when present.
  const bd = (list) => (list && list.length ? list.map(c => {
    let line = `• ${esc(TOK.tidyAmount(c.amount))} ${esc(TOK.tokenName(c.token, c.tokenid))} → ${idHtml(c.address, short(c.address, 16))}`;
    if (c.coinid) line += ` <span class="hist-dim">${idHtml(c.coinid, short(c.coinid, 12))}</span>`;
    if (c.state && c.state.length) line += c.state.map(s => `<br>&nbsp;&nbsp;<span class="hist-dim">[${esc(String(s.port))}] ${esc(short(String(s.data), 40))}</span>`).join("");
    return line;
  }).join("<br>") : "—");
  const isTrade = r.kind === "buy" || r.kind === "sell";
  const tc = isTrade ? tradeCounter(r) : null;
  const kind = isTrade ? (r.kind === "buy" ? "Bought MINIMA" : "Sold MINIMA")
    : (r.kind !== "normal" ? (r.kind[0].toUpperCase() + r.kind.slice(1)) : (r.direction === "in" ? "Received" : r.direction === "out" ? "Sent" : "Self"));
  const amtStr = (isTrade && tc) ? `${esc(TOK.tidyAmount(r.amount))} MINIMA for ${esc(TOK.tidyAmount(tc.amt))} ${esc(tc.name)}` : `${esc(TOK.tidyAmount(r.amount))} ${esc(r.tokenName)}`;
  const burnStr = (r.burn != null && r.burn !== "" && !/^0*\.?0*$/.test(String(r.burn))) ? esc(TOK.tidyAmount(r.burn)) + " MINIMA" : "0";
  const feeRow = r.burn != null ? `<div class="kv"><span class="kv__k">Fee (burn)</span><span class="kv__v">${burnStr}</span></div>` : "";
  const sizeRow = r.size ? `<div class="kv"><span class="kv__k">Size</span><span class="kv__v">${esc(r.size)} bytes</span></div>` : "";
  const txState = (r.state && r.state.length) ? `<div class="view__sub">Transaction state</div><div class="kv__v" style="text-align:left">${r.state.map(s => `[${esc(String(s.port))}] ${esc(short(String(s.data), 60))}`).join("<br>")}</div>` : "";
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
    <div class="kv"><span class="kv__k">Txpow id</span><span class="kv__v" id="histTxid" style="cursor:pointer" title="copy">${esc(short(r.txpowid, 22))}</span></div>
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
    const known = upsertAll ? null : new Set((await api.histGet()).map(r => r.txpowid));
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
// own rows and the phone's (HistoryEntry.toJson: received / sent, timemilli, inputs and deltas as JSON text,
// coins with `addr`). Every field is rebuilt by name and type; nothing from the file is passed through as is.
function histImportRow(o) {
  if (!o || typeof o !== "object" || typeof o.txpowid !== "string" || !/^0x[0-9A-Fa-f]{1,128}$/.test(o.txpowid)) return null;
  const parsed = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return null; } } return v; };
  const list = (v) => { v = parsed(v); return Array.isArray(v) ? v : []; };
  const map = (v) => { v = parsed(v); const out = {}; if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) out[String(k)] = String(v[k]); return out; };
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  const coin = (c) => ({ address: String((c && (c.address || c.addr)) || ""), amount: String((c && c.amount) || "0"), tokenid: String((c && c.tokenid) || MINIMA),
    token: c && c.token && typeof c.token === "object" ? c.token : undefined, coinid: String((c && c.coinid) || ""), state: Array.isArray(c && c.state) ? c.state : [] });
  const inputs = list(o.inputs).map(coin), outputs = list(o.outputs).map(coin);
  const tokenid = typeof o.tokenid === "string" && validTok(o.tokenid) && o.tokenid ? o.tokenid : MINIMA;
  return { txpowid: o.txpowid, block: num(o.block), time: num(o.time != null ? o.time : o.timemilli),
    istransaction: o.istransaction !== false, isblock: o.isblock === true, size: num(o.size), burn: String(o.burn != null ? o.burn : "0"),
    direction: ({ received: "in", sent: "out", in: "in", out: "out" })[o.direction] || "self",
    kind: ["split", "consolidation", "buy", "sell"].includes(o.kind) ? o.kind : "normal",
    tokenid, tokenName: typeof o.tokenName === "string" && o.tokenName ? o.tokenName : TOK.tokenName(null, tokenid),
    amount: String(o.amount != null ? o.amount : "0").replace(/^-/, ""), counterparty: String(o.counterparty || ""),
    inCount: inputs.length || num(o.inCount), outCount: outputs.length || num(o.outCount),
    difference: map(o.difference != null ? o.difference : o.deltas), inputs, outputs, state: list(o.state) };
}
// "Import history (restore / merge)": rows the store does not have are added; a row it already has is left
// exactly as it is (matched on the txpow id), so importing the same file twice, or one from another device, is safe.
async function importHistory() {
  let text;
  try { text = await api.importJson(); } catch (e) { toast("Import failed: " + (e.message || e), "err"); return; }
  if (text == null) return;                                          // cancelled
  try {
    const arr = JSON.parse(text).tx;
    if (!Array.isArray(arr)) throw new Error("this is not a history export");
    const known = new Set(((await api.histGet()) || []).map(r => r.txpowid)), fresh = [];
    let total = 0;
    for (const o of arr) { const row = histImportRow(o); if (!row) continue; total++; if (!known.has(row.txpowid)) { known.add(row.txpowid); fresh.push(row); } }
    for (let i = 0; i < fresh.length; i += 500) await api.histAdd(fresh.slice(i, i + 500));
    toast(`Imported: ${total} · New: ${fresh.length}`, "ok");
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
function appendTerm(s) {
  TERM_OUT += (TERM_OUT ? "\n" : "") + s;
  if (TERM_OUT.length > 20000) TERM_OUT = TERM_OUT.slice(TERM_OUT.length - 20000);
  const out = el("termOut"); if (out) { out.textContent = TERM_OUT; out.scrollTop = out.scrollHeight; }
}
function renderTerminal() {
  const out = el("termOut"), inp = el("termIn");
  out.textContent = TERM_OUT; out.scrollTop = out.scrollHeight;
  el("termClear").onclick = () => { TERM_OUT = ""; out.textContent = ""; };
  el("termCopy").onclick = () => copy(TERM_OUT);
  inp.onkeydown = async (e) => {
    if (e.key === "Enter") {                          // Enter ALWAYS submits, dropdown open or not
      const c = inp.value.trim(); if (!c) return;
      inp.value = ""; termSugClose();
      TERM_HIST.push(c); termIdx = TERM_HIST.length;
      appendTerm("> " + c);
      try { const r = await api.cmd(c); appendTerm(JSON.stringify(r, null, 2)); }
      catch (err) { appendTerm("error: " + (err && err.message || err)); }
    } else if (e.key === "Escape") {                  // the escape hatch to reach ↑ history while suggestions are up
      if (SUG_ITEMS.length) { e.preventDefault(); termSugClose(); }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (SUG_ITEMS.length) termSugAccept(SUG_ITEMS[Math.min(SUG_SEL, SUG_ITEMS.length - 1)]);
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
// ---- Apps tab: the phone's "Internal" list, one row per tray app, each with a Hide switch ----
// Hide takes an app out of the tray until it is switched back; the app itself keeps running (the phone's
// second switch, Freeze, comes with the engines in a later phase). Minima Core cannot be hidden.
function hiddenApps() { return String(store("shellHidden") || "").split(",").filter(id => id && id !== "core" && TRAY_APPS.some(a => a.id === id)); }
function applyHiddenApps() {
  const hidden = hiddenApps();
  document.querySelectorAll(".tray__row").forEach(r => { r.hidden = hidden.includes(r.dataset.app); });
  paintTrayDot();
}
function renderApps() {
  const hidden = hiddenApps();
  el("appsList").innerHTML = TRAY_APPS.map(a => {
    const core = a.id === "core", off = hidden.includes(a.id);
    return `<div class="apps-row">
    ${a.icon ? `<img class="apps-row__ic" src="${a.icon}" alt="">` : CORE_MARK.replace("tray__ic", "apps-row__ic")}
    <div class="apps-row__main"><div class="apps-row__name">${esc(a.name)}${a.badge ? `<span class="tab-badge" data-count="${a.badge}" hidden></span>` : ""}</div><div class="apps-row__state">${core ? "Always on" : off ? "Hidden from drawer" : "In app drawer"}</div></div>
    <label class="apps-row__hide"><span>Hide</span><button class="switch" role="switch" aria-checked="${off}" aria-label="Hide ${esc(a.name)}" data-hide="${a.id}"${core ? " disabled" : ""}></button></label>
  </div>`; }).join("");
  paintAppsCounts();
  el("appsList").querySelectorAll(".switch:not([disabled])").forEach(sw => sw.onclick = () => {
    const id = sw.dataset.hide, now = hiddenApps();
    store("shellHidden", (now.includes(id) ? now.filter(x => x !== id) : now.concat(id)).join(","));
    applyHiddenApps(); renderApps();
    const again = el("appsList").querySelector(`.switch[data-hide="${id}"]`); if (again) again.focus();
  });
}
// ---- Minima Faucet (a tray app; the card used to sit in Settings) ----
async function renderFaucet() {
  const host = el("faucetBody");
  if (!running) { host.innerHTML = waitHtml(); return; }
  if (el("faucetGo")) return;                           // already drawn: keep what the user typed and the last answer
  const addr = await tryCmd("getaddress");
  const fullAddr = (addr && (addr.miniaddress || addr.address)) || "";
  host.innerHTML = `
    <div class="card"><div class="card__title">Minima Faucet</div>
      <div class="view__desc">Request a tiny amount of Minima to your address. It is enough to get started and to send MinimaMail.</div>
      <div class="field"><div class="field__label">Your address</div>
        <div class="seg"><input class="field__input" id="faucetAddr" placeholder="Mx… or 0x…" value="${esc(fullAddr)}" />
          <button class="btn btn--outline btn--sm" id="faucetMine">My address</button></div></div>
      <button class="btn btn--primary btn--full" id="faucetGo">Request Minima</button>
      <div class="status" id="faucetStatus"></div>
    </div>`;
  el("faucetMine").onclick = async () => { const a = await tryCmd("getaddress"); if (a) el("faucetAddr").value = a.miniaddress || a.address || ""; };
  el("faucetGo").onclick = async () => {
    const addr = el("faucetAddr").value.trim();
    if (!validAddr(addr)) { toast("Enter a valid Mx… / 0x… address.", "err"); return; }
    const btn = el("faucetGo"), st = el("faucetStatus");
    btn.disabled = true; btn.textContent = "Requesting…"; st.textContent = "Contacting the faucet…"; st.className = "status status--dim";
    try { const r = await api.faucet(addr); st.textContent = r.message; st.className = "status " + (r.status ? "status--ok" : "status--err"); toast(r.message, r.status ? "ok" : "err"); }
    catch (e) { st.textContent = "Faucet error."; st.className = "status status--err"; }
    btn.disabled = false; btn.textContent = "Request Minima";
  };
}
// Settings: what is the desktop's own and has no screen on the phone (open at login, updates, which node, the
// key-use audit, address labels, the history store). Laid out with the shell's own pieces: the phone's
// eyebrow-and-card of the Node tab. Node commands are typed in the Terminal; there is no second command box here.
async function renderSettings() {
  const host = el("settingsBody");
  const [keys, scripts] = running ? await Promise.all([tryCmd("keys action:list"), tryCmd("scripts")]) : [null, null];
  const ku = keysInfo(keys);
  const kuRows = keyUsesRows(keys, scripts);
  const pct = ku.cap ? Math.min(100, Math.round(ku.used / ku.cap * 100)) : 0;
  const warn = pct >= 80;
  const labels = CFG.labels || {}, labelKeys = Object.keys(labels);
  const kind = CFG.nodeKind === "minima" ? "minima" : "parlons";
  const sec = (title, body, id) => `<div class="eyebrow home-eyebrow">${title}</div><div class="card home-card set-card"${id ? ` id="${id}"` : ""}>${body}</div>`;
  host.innerHTML =
    sec("This computer", `<div class="ps-sw set-sw"><span class="ps-sw__t" id="setAutostartL">Open at login</span><button class="switch switch--m2" role="switch" id="setAutostart" aria-checked="${CFG.openAtLogin ? "true" : "false"}" aria-labelledby="setAutostartL"></button></div>
      <p class="ps-note">Start Minima Core, and so your node, when you log in to this computer. It opens to the tray on Mac. Uses the login items on Mac and Windows and the autostart folder on Linux.</p>`) +
    sec("Updates", `<p class="set-text">Minima Core checks its own store feed for a newer build. Downloads are verified against the feed's sha256 and opened for you to install; nothing installs by itself.</p>
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
    sec("Address key uses", `<p class="set-text">This lists each key's address and how many signatures it has used; a one-time key that signs the same leaf twice is unsafe. "Deep reuse audit" cross-checks the chain through your KeyUses service, because the node's own counter can under-report.</p>
      <div id="kuList" class="ku-list">${kuRows.length ? kuRows.map(kuRowHtml).join("") : `<p class="set-text">No keys reported.</p>`}</div>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="kuAudit">Deep reuse audit</button></div>
      <div class="status" id="kuAuditStatus"></div>
      <p class="ps-note">The deep audit sends your public keys to your KeyUses service (eurobuddha.com) to check the chain for real reuse: when you open this screen, and when you press the button. Nothing else leaves your node.</p>`)
      : sec("Signing keys", `<p class="set-text">${nodeState === "stopped" ? "The node is stopped." : "Waiting for the node…"}</p>`)) +
    sec("Address labels", labelKeys.length ? labelKeys.map(a => `<div class="set-label"><div class="set-label__t"><b>${esc(labels[a])}</b><span>${esc(a)}</span></div><button class="btn btn--sm btn--outline lbl-del" data-addr="${esc(a)}">Delete</button></div>`).join("")
      : `<p class="set-text">No labels yet. Name an address on the Receive screen.</p>`) +
    sec("History", `<p class="set-text">Your transaction history is stored on this computer (the node prunes old data). Clear it if you switch wallets.</p>
      <div class="home-actions set-actions"><button class="btn btn--outline" id="setClearHist">Clear local history</button></div>`) +
    `<div id="chanceLeft"></div>`;
  const drawUpdate = (u) => {
    const b = el("updBody"), g = el("updGet"); if (!b) return;
    if (u.error && !u.available) b.textContent = "Could not read the feed (" + u.error + "). Running v" + u.running + ".";
    else if (u.available) b.innerHTML = "<b>Minima Core " + esc(u.version) + "</b> is available (you run v" + esc(u.running) + ")" + (u.date ? " · " + esc(u.date) : "") + (u.notes ? "<br>" + esc(u.notes) : "") + (u.downloaded ? "<br>Downloaded to " + esc(u.downloaded) : "");
    else b.textContent = "You run the newest build, v" + u.running + (u.checkedAt ? " (checked " + new Date(u.checkedAt).toLocaleTimeString() + ")" : "") + ".";
    g.hidden = !u.available;
  };
  api.updateStatus().then(drawUpdate).catch(() => {});
  el("updCheck").onclick = async () => { el("updStatus").textContent = "Checking…"; try { const u = await api.updateCheck(); drawUpdate(u); el("updStatus").textContent = ""; } catch (e) { el("updStatus").textContent = e.message || String(e); } };
  el("updGet").onclick = async () => {
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
  el("setAutostart").onclick = async () => {
    const on = !CFG.openAtLogin;
    CFG = await api.saveConfig({ openAtLogin: on });
    const li = CFG.loginItem || {};
    if (li.ok === false) toast((on ? "Saved, but not registered: " : "Saved, but could not unregister: ") + (li.note || "unknown error"), "warn");
    else toast(on ? "Minima Core will open when you log in ✓" : "Minima Core will no longer open at login", "ok");
    renderSettings();
  };
  chanceLeftCard();
  // key-uses panel: copy an address on click, run the deep audit on demand, and auto-run it once on open (rate-limited).
  if (el("kuList")) el("kuList").onclick = (e) => { const row = e.target.closest(".ku-row"); if (row && e.target.classList.contains("ku-addr") && row.dataset.addr) copy(row.dataset.addr); };
  if (el("kuAudit")) el("kuAudit").onclick = () => runKeyAudit(true);
  runKeyAudit(false);
}
function keysInfo(keys) {
  try {
    const arr = Array.isArray(keys) ? keys : (keys && keys.keys) || [];
    let used = 0, cap = 0;
    for (const k of arr) { used = Math.max(used, parseInt(k.uses, 10) || 0); cap = Math.max(cap, parseInt(k.maxuses, 10) || 0); }
    return { used, cap: cap || 262144, count: arr.length };
  } catch (e) { return { used: 0, cap: 262144, count: 0 }; }
}
// keys action:list has no address, so join each key to its default single-sig address via `scripts`
// (the `simple && default` row whose script is `RETURN SIGNEDBY(<pk>)`). Keyed on uppercased public key.
function keyAddrMap(scripts) {
  const arr = Array.isArray(scripts) ? scripts : (scripts && scripts.scripts) || [];
  const m = {};
  for (const s of arr) { if (s && s.publickey && s.simple && s.default) { const pk = String(s.publickey).toUpperCase(); if (!m[pk]) m[pk] = { address: s.address, miniaddress: s.miniaddress }; } }
  for (const s of arr) { if (s && s.publickey) { const pk = String(s.publickey).toUpperCase(); if (!m[pk]) m[pk] = { address: s.address, miniaddress: s.miniaddress }; } } // fallback: any script row
  return m;
}
function keyUsesRows(keys, scripts) {
  const arr = Array.isArray(keys) ? keys : (keys && keys.keys) || [];
  const map = keyAddrMap(scripts);
  return arr.map((k, i) => {
    const a = map[String(k.publickey || "").toUpperCase()] || {};
    return { i, publickey: k.publickey || "", address: a.address || "", miniaddress: a.miniaddress || "",
      uses: parseInt(k.uses, 10) || 0, cap: parseInt(k.maxuses, 10) || 262144 };
  }).sort((x, y) => y.uses - x.uses);   // most-used (riskiest) first
}
function kuRowHtml(r) {
  const pct = r.cap ? Math.min(100, Math.round(r.uses / r.cap * 100)) : 0;
  const near = pct >= 95 ? " ku-uses--red" : pct >= 80 ? " ku-uses--warn" : "";
  const who = r.miniaddress || r.address || ("key #" + (r.i + 1));   // full address; CSS ellipsizes only if too narrow
  return `<div class="row ku-row" data-pk="${esc(r.publickey)}" data-uses="${esc(r.uses)}" data-addr="${esc(r.miniaddress || r.address || "")}">
    <div class="row__mid"><div class="row__l1 ku-addr" title="Click to copy">${esc(who)}</div><div class="row__l2"><span class="ku-verdict"></span></div></div>
    <div class="row__r"><span class="ku-uses${near}">${esc(r.uses)}</span><span class="ku-cap"> / ${esc(r.cap)}</span></div></div>`;
}
// Deep reuse audit: send the node's public keys to the KeyUses service, join spend_blocks + reuse DB, classify
// each key (risk = reused OR on-chain sigs > local uses — the node counter can under-report). Patches rows in
// place (never rebuilds the panel). Graceful: an unreachable service leaves the local counts and says so.
let KU_AUDIT_AT = 0, KU_AUDITING = false;
const KU_AUDIT_GAP = 60000;
async function runKeyAudit(force) {
  const status = el("kuAuditStatus"); if (!status || KU_AUDITING) return;   // one audit at a time (button can't stack fetches)
  if (!force && KU_AUDIT_AT && (Date.now() - KU_AUDIT_AT) < KU_AUDIT_GAP) return;
  // Source public keys + local use-counts from the already-rendered rows (no redundant, race-prone re-fetch).
  const rows = Array.from(document.querySelectorAll("#kuList .ku-row"));
  const pubs = rows.map(r => r.dataset.pk).filter(Boolean);
  if (!pubs.length) return;
  KU_AUDIT_AT = Date.now(); KU_AUDITING = true;
  const btn = el("kuAudit"); if (btn) btn.disabled = true;
  const usesByPk = {}; rows.forEach(r => { if (r.dataset.pk) usesByPk[String(r.dataset.pk).toUpperCase()] = parseInt(r.dataset.uses, 10) || 0; });
  status.className = "status status--dim"; status.textContent = "Auditing your keys against the chain…";
  try {
  const audit = await api.keyAudit(pubs).catch(() => null);
  if (!audit || !audit.keys) {
    KU_AUDIT_AT = 0;   // transient failure → let the next panel-open retry instead of blocking for the whole window
    status.className = "status status--warn";
    status.textContent = "⚠ Reuse audit unavailable (KeyUses service unreachable). Showing local key-use counts only. Try again later.";
    return;
  }
  const byPk = {}; audit.keys.forEach(u => { if (u && u.publickey) byPk[String(u.publickey).toUpperCase()] = u; });
  const addrs = audit.keys.map(u => u && u.address).filter(Boolean);
  const reuse = await api.keyReuse(addrs).catch(() => null);
  const full = !!(reuse && reuse.results);
  const reuseByAddr = {}; if (full) reuse.results.forEach(r => { if (r && r.address) reuseByAddr[String(r.address).toUpperCase()] = r; });
  let anyRisk = false, maxReuse = 0, recommended = 0;
  document.querySelectorAll("#kuList .ku-row").forEach(node => {
    const pk = String(node.dataset.pk || "").toUpperCase();
    const u = byPk[pk] || {};
    const local = usesByPk[pk] || 0;
    const sigs = Number(u.spend_blocks || 0);
    const rinfo = u.address ? reuseByAddr[String(u.address).toUpperCase()] : null;
    const reused = !!(rinfo && rinfo.reused);
    const reuseCount = rinfo ? (Number(rinfo.reuse_count) || 0) : 0;
    const countRisk = sigs > local;
    if (reused || countRisk) anyRisk = true;
    if (reuseCount > maxReuse) maxReuse = reuseCount;
    recommended = Math.max(recommended, Math.max(sigs, local));
    const v = node.querySelector(".ku-verdict"); if (!v) return;
    if (reused) { v.className = "ku-verdict ku-v--" + (reuseCount > 3 ? "risk" : "warn"); v.textContent = "RE-USED ×" + reuseCount; }
    else if (countRisk) { v.className = "ku-verdict ku-v--risk"; v.textContent = "AT RISK · chain " + sigs + " > node " + local; }
    else { v.className = "ku-verdict ku-v--ok"; v.textContent = "OK · " + sigs + " on-chain"; }
  });
  const reco = recommended + 256;
  const cls = anyRisk ? (maxReuse > 3 ? "status--err" : "status--warn") : "status--ok";
  status.className = "status " + cls;
  status.textContent = (anyRisk
      ? (maxReuse > 3 ? "⚠ Key reuse detected — move funds off the flagged addresses to fresh ones. " : "⚠ Some keys are at risk (chain shows more signatures than the node counter). ")
      : "✓ No reuse detected. ")
    + (full ? "" : "(reuse DB partial — treat as unverified.) ")
    + "Recommended key-uses for your next resync: " + reco + ".";
  } finally { KU_AUDITING = false; const b = el("kuAudit"); if (b) b.disabled = false; }
}

// ---- Send ------------------------------------------------------------------
async function renderSend() {
  const card = el("sendCard");
  if (!running) { card.innerHTML = waitHtml(); return; }
  // token dropdown source — the wallet's held coins/tokens (MINIMA first). No raw token-id typing.
  const bal = await tryCmd("balance") || [];
  SEND_TOKENS = bal.map(b => ({ tokenid: b.tokenid || MINIMA, name: TOK.tokenName(b.token, b.tokenid), sendable: b.sendable || "0",
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
      el("sAvail").textContent = "sendable " + TOK.tidyAmount(t.sendable || "0");
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
      if (absCmp(amt, avail) > 0) { toast("Amount exceeds your spendable balance (" + TOK.tidyAmount(avail) + "). The rest is locked in scripts/pools.", "err"); return; }
      el("sGo").disabled = true; el("sGo").textContent = "Sending…";
      try {
        const chk = await tryCmd(`checkaddress address:${to}`);   // reject a malformed/unparseable recipient
        if (!chk) { toast("Couldn't validate the address (node busy?) — not sending.", "err"); el("sGo").disabled = false; el("sGo").textContent = "Send Funds"; return; }
        // Review before it leaves. Every OTHER send in this app confirms first — minimaMail pay, ETH send,
        // AtomiX swap, the PandaPools actions, Vestr — and this is the one people use most. The recipient is
        // shown IN FULL so a mistyped or clipboard-swapped address has somewhere to be caught.
        const tname = tokOf(tok).name || (tok === MINIMA ? "MINIMA" : tok);
        if (!await showConfirm(`Send ${amt} ${tname}?`,
              `To\n${to}\n\nAmount\n${amt} ${tname}\n\nCheck the address above — this sends real funds and cannot be undone.`,
              "Send now", false)) {
          el("sGo").disabled = false; el("sGo").textContent = "Send Funds"; return;
        }
        const r = await cmd(`send address:${to} amount:${amt}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : ""));
        toast("Sent ✓ " + short((r && r.txpowid) || "", 12), "ok", (r && r.txpowid) || null); el("sTo").value = el("sAmt").value = ""; refreshAvail();
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
    ${s.portOwner ? row("Port held by", "pid " + esc(s.portOwner.pid) + " · " + esc(s.portOwner.command)) : ""}
    <div class="home-actions">
      <button class="btn btn--outline" id="nRestart">${s.state === "stopped" ? "Start node" : "Restart node"}</button>
      ${s.state === "error" ? `<button class="btn btn--outline" id="nReclaim">Stop any node on port ${esc(CFG.basePort)} and start</button>` : ""}
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
  if (nReclaim) nReclaim.onclick = async () => { nReclaim.disabled = true; nReclaim.textContent = "Stopping…"; try { await api.nodeReclaim(); toast("Node restarting…", "ok"); } catch (e) { toast(e.message || String(e), "err"); } };
  // The in-app jar updater is disabled — the node jar ships with the app. See main/updater.js.
  paintLogs();   // refresh the Node-tab log pane now that this view is active
}

let logLines = [];
const LOG_MAX = 2000;
async function initLogs() { logLines = await api.nodeLogs(); paintLogs(); }
function appendLog(line) { if (!line) return; logLines.push(line); if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX); paintLogs(); }
function viewActive(v) { const s = document.getElementById("view-" + v); return !!(s && s.classList.contains("view--active")); }
function paintLogs() {
  const text = logLines.join("\n");
  const nodeBox = el("logbox"); if (nodeBox && viewActive("node")) { nodeBox.textContent = text; nodeBox.scrollTop = nodeBox.scrollHeight; }
  const logsBox = el("logsBox");
  if (logsBox && viewActive("logs")) { logsBox.textContent = text; const follow = el("logsFollow"); if (!follow || follow.checked) logsBox.scrollTop = logsBox.scrollHeight; }
}
// ---- Logs tab (full live node output) ----
async function renderLogs() {
  logLines = await api.nodeLogs();
  paintLogs();
  const box = el("logsBox"); if (box) box.scrollTop = box.scrollHeight;
  el("logsCopy").onclick = () => copy(logLines.join("\n"));
  el("logsClear").onclick = () => { logLines = []; paintLogs(); };
}

boot();
initLogs();

// ---- AtomiX — the panel lives in renderer/atomix-ui.js (APK parity, its own Onyx/Daylight palette) ----------
// app.js keeps only the wiring. Every engine call, the frozen-quote path, the maker save/withdraw, the OTC deal
// actions, the ETH send review → confirm → send and every guard moved across verbatim.
AtomixPanel.init({
  api, esc, el, toast, copy, TOK,
  showConfirm, showPrompt, relTime, idHtml,
  running: () => running,
  activeView: () => activeView
});
api.appVersion().then(v => AtomixPanel.setVersion(v)).catch(() => {});
function renderAtomix() { AtomixPanel.render(); }
function onAtomixUpdate() { AtomixPanel.onUpdate(); }
function resetAxState() { AtomixPanel.reset(); }

// ============================ ETH Wallet (standalone tab) ============================
// A full ERC20 wallet on the SAME seed-derived ethbridge address AtomiX uses (main/ethwallet.js → main/atomix.js
// glue → byte-identical AtomiX ETH engine). Reads: ETH + arbitrary tokens. Sends: ETH + any ERC20, Low/Med/High
// fee tiers. Etherscan links open externally (the safeLinkRow <a target=_blank> pattern the app already uses).
let ewStatusCache = { ready: false };
let ewUpdateTimer = null;
const EW_ETHERSCAN = "https://etherscan.io/";
function resetEwState() { ewStatusCache = { ready: false }; }

function ewEthIcon() { return `<span class="ew-ic ew-ic--eth">Ξ</span>`; }
function ewTokIcon(addr) { return `<img class="ew-ic" src="${TOK.identiconDataUri(addr)}" alt="" />`; }

async function renderEthWallet() {
  const host = el("ewBody"); if (!host) return;
  const st = await api.ewStatus().catch(() => ({ ready: false }));
  ewStatusCache = st;
  const title = `<div class="view__title" style="border:0;padding-bottom:2px">ETH Wallet <span class="ew-net">Mainnet · real funds</span></div>
    <div class="view__desc" style="margin-top:0">A full Ethereum wallet derived from this node's seed — the same address AtomiX and minimaSwap use. Send ETH and any ERC20 token; fees, tokens and RPC are yours to control.</div>`;
  if (!st.ready) {
    host.innerHTML = `${title}<div class="card"><div class="card__title">Setting up your wallet…</div>
      <div class="view__desc">${running ? "Your key is being derived from the node. This needs the node running with write access — if your vault is locked, unlock it first. Your wallet appears here automatically." : "Start your node to unlock your ETH wallet."}</div>
      <button class="btn btn--outline btn--sm" id="ewRetry" style="margin-top:10px">Refresh</button></div>`;
    el("ewRetry").onclick = renderEthWallet;
    return;
  }
  const b = await api.ewBalances().catch(() => null);
  if (!b) {
    host.innerHTML = `${title}<div class="card"><div class="card__title">Couldn't read balances</div>
      <div class="view__desc">The Ethereum RPC didn't respond just now — it auto-falls-back across public nodes. Try again in a moment.</div>
      <button class="btn btn--outline btn--sm" id="ewRetry" style="margin-top:10px">Refresh</button></div>`;
    el("ewRetry").onclick = renderEthWallet;
    return;
  }
  const tokenCards = b.tokens.map(t => `<div class="card ew-asset" data-ewtok="${esc(t.address)}">
      ${ewTokIcon(t.address)}
      <div class="ew-asset__main"><div class="card__title">${esc(t.symbol)}</div><div class="ew-val mono">${esc(TOK.tidyAmount(t.balance))} ${esc(t.symbol)}</div></div>
      <button class="btn btn--sm btn--outline ew-menu" data-ewmenu="${esc(t.address)}" title="Token options">⋯</button>
    </div>`).join("");
  host.innerHTML = `${title}
    <div class="card ew-addr" id="ewAddrCard"><div class="card__title">Your address · tap to receive</div><div class="mono ew-addr__v">${esc(b.address)}</div></div>
    <div class="card ew-asset" id="ewEthCard">${ewEthIcon()}<div class="ew-asset__main"><div class="card__title">Ethereum</div><div class="ew-val mono" style="color:var(--accent)">${esc(TOK.tidyAmount(b.eth))} ETH</div></div></div>
    ${tokenCards}
    <div class="seg ew-actions" style="flex-wrap:wrap;margin-top:12px">
      <button class="btn btn--primary btn--sm" id="ewSend">Send</button>
      <button class="btn btn--outline btn--sm" id="ewReceive">Receive</button>
      <button class="btn btn--outline btn--sm" id="ewRefresh">Refresh</button>
      <button class="btn btn--outline btn--sm" id="ewAddTok">+ Add token</button>
      <a class="btn btn--outline btn--sm" href="${EW_ETHERSCAN}address/${esc(b.address)}" target="_blank" rel="noreferrer">Etherscan ↗</a>
      <button class="btn btn--outline btn--sm" id="ewSettings">Settings</button>
    </div>`;
  el("ewAddrCard").onclick = () => ewReceive(b.address);
  el("ewEthCard").onclick = () => ewSendDialog(b, "eth");
  el("ewSend").onclick = () => ewSendDialog(b, "eth");
  el("ewReceive").onclick = () => ewReceive(b.address);
  el("ewRefresh").onclick = () => { toast("Refreshing…"); renderEthWallet(); };
  el("ewAddTok").onclick = () => ewAddTokenDialog();
  el("ewSettings").onclick = () => ewSettingsDialog(b);
  host.querySelectorAll("[data-ewtok]").forEach(c => c.onclick = e => { if (e.target.closest("[data-ewmenu]")) return; ewSendDialog(b, c.dataset.ewtok); });
  host.querySelectorAll("[data-ewmenu]").forEach(btn => btn.onclick = e => { e.stopPropagation(); ewTokenMenu(b, btn.dataset.ewmenu); });
}

function ewReceive(addr) {
  let qrHtml = "";
  if (typeof qrcode !== "undefined") { const qr = qrcode(0, "M"); qr.addData(addr); qr.make(); qrHtml = `<div style="background:#fff;padding:8px;border-radius:8px;width:fit-content;margin:10px auto">${qr.createImgTag(5, 6)}</div>`; }
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewRxOv"><div class="modal">
    <div class="modal__title">Receive · Ethereum</div>
    <div class="mono" style="user-select:all;word-break:break-all;text-align:center;font-size:13px">${esc(addr)}</div>${qrHtml}
    <div class="view__desc">Same address on all EVM networks — fund it with Ethereum ETH and tokens.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="ewRxClose">Close</button><button class="btn btn--primary btn--full" id="ewRxCopy">Copy address</button></div></div></div>`);
  const ov = el("ewRxOv"); const close = () => ov && ov.remove();
  el("ewRxClose").onclick = close; el("ewRxCopy").onclick = () => copy(addr);
  ov.onclick = e => { if (e.target.id === "ewRxOv") close(); };
}

function ewSendDialog(b, startAsset) {
  const assets = [{ key: "eth", sym: "ETH" }].concat(b.tokens.map(t => ({ key: t.address, sym: t.symbol })));
  let asset = assets.some(a => a.key === startAsset) ? startAsset : "eth";
  const symOf = k => (assets.find(a => a.key === k) || { sym: "?" }).sym;
  const chips = assets.map(a => `<button class="btn btn--sm ew-tokpick" data-ewasset="${esc(a.key)}">${esc(a.sym)}</button>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewSendOv"><div class="modal">
    <div class="modal__title">Send</div>
    <div class="seg ew-tokrow" style="flex-wrap:wrap;gap:6px">${chips}</div>
    <div class="field"><div class="field__label">To</div><input class="field__input mono" id="ewTo" placeholder="0x… recipient" autocomplete="off" spellcheck="false" /></div>
    <div class="field"><div class="field__label">Amount <button class="btn btn--sm btn--outline" id="ewMax" style="float:right">Max</button></div><input class="field__input mono" id="ewAmt" placeholder="0.00" autocomplete="off" /></div>
    <div class="view__desc">Sends are irreversible. Double-check the address.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="ewSendCancel">Cancel</button><button class="btn btn--primary btn--full" id="ewSendReview">Review</button></div></div></div>`);
  const ov = el("ewSendOv"); const close = () => ov && ov.remove();
  const paint = () => ov.querySelectorAll("[data-ewasset]").forEach(x => x.className = "btn btn--sm ew-tokpick " + (x.dataset.ewasset === asset ? "btn--primary" : "btn--outline"));
  ov.querySelectorAll("[data-ewasset]").forEach(x => x.onclick = () => { asset = x.dataset.ewasset; paint(); });
  paint();
  el("ewMax").onclick = async () => { const m = await api.ewSendMax(asset).catch(() => null); if (m != null) el("ewAmt").value = m; };
  el("ewSendCancel").onclick = close;
  ov.onclick = e => { if (e.target.id === "ewSendOv") close(); };
  el("ewSendReview").onclick = async () => {
    const to = el("ewTo").value.trim(), amt = el("ewAmt").value.trim();
    const r = await api.ewSendReview(asset, to, amt).catch(e => ({ err: String(e.message || e) }));
    if (r.err) { toast(r.err, "warn"); return; }
    close();
    ewConfirmSend(asset, symOf(asset), to, amt, r.fees, r.capped);
  };
}

// Confirm with the native Low/Med/High fee tiers (default Medium); live fee + gwei per tier.
function ewConfirmSend(asset, sym, to, amt, fees, capped) {
  let tier = "med";
  const cappedWarn = capped ? `<div class="view__desc" style="color:var(--red);margin-top:6px">⚠ Network gas looks abnormally high — your RPC endpoint may be faulty or hostile. Consider changing it in Settings before sending.</div>` : "";
  const label = t => (t === "low" ? "Low" : t === "high" ? "High" : "Medium");
  const tierBtns = ["low", "med", "high"].map(t => `<button class="btn btn--sm ew-tier" data-ewtier="${t}">${label(t)}</button>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewCfOv"><div class="modal">
    <div class="modal__title">Confirm send</div>
    <div class="kv"><span class="kv__k">Send</span><span class="kv__v mono">${esc(amt)} ${esc(sym)}</span></div>
    <div class="field__label" style="margin-top:8px">To — check every character</div>
    <div class="mono" style="word-break:break-all;font-size:12.5px;background:var(--surface2);border-radius:6px;padding:8px 10px">${esc(to)}</div>
    <div class="field__label" style="margin-top:10px">Network fee</div>
    <div class="seg ew-tierrow" style="gap:6px">${tierBtns}</div>
    <div class="mono ew-feeline" id="ewFee"></div>${cappedWarn}
    <div class="view__desc" style="color:var(--amber);margin-top:8px">This cannot be undone.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="ewCfCancel">Cancel</button><button class="btn btn--primary btn--full" id="ewCfSend">Send now</button></div></div></div>`);
  const ov = el("ewCfOv"); const close = () => ov && ov.remove();
  const feeEl = el("ewFee");
  const paintFee = () => {
    const f = fees && fees[tier];
    feeEl.textContent = f ? `≈ ${TOK.tidyAmount(f.fee)} ETH  ·  ${TOK.tidyAmount(f.gwei)} gwei` : "";
    ov.querySelectorAll("[data-ewtier]").forEach(x => x.className = "btn btn--sm ew-tier " + (x.dataset.ewtier === tier ? "btn--primary" : "btn--outline"));
  };
  ov.querySelectorAll("[data-ewtier]").forEach(x => x.onclick = () => { tier = x.dataset.ewtier; paintFee(); });
  paintFee();
  el("ewCfCancel").onclick = close;
  ov.onclick = e => { if (e.target.id === "ewCfOv") close(); };
  el("ewCfSend").onclick = async () => {
    const btn = el("ewCfSend"); btn.disabled = true; btn.textContent = "Sending…";
    const s = await api.ewSend(asset, to, amt, tier).catch(e => ({ err: String(e.message || e) }));
    close();
    // uncertain = a network glitch mid-broadcast; warn (don't imply success OR clean failure), the user checks Etherscan
    if (s && s.uncertain) toast(s.err, "warn");
    else if (s && s.err) toast(s.err, "warn");
    else toast("✓ Broadcast — tx " + TOK.shortId(s.tx), "ok", (s && s.tx) || null);
    if (activeView === "ethwallet") renderEthWallet();
  };
}

async function ewAddTokenDialog() {
  const addr = await showPrompt("Add token", "", "0x… ERC20 contract address");
  if (!addr) return;
  toast("Reading token…");
  const r = await api.ewAddToken(String(addr).trim()).catch(e => ({ err: String(e.message || e) }));
  toast(r && r.err ? r.err : "✓ Added " + (r.token ? r.token.symbol : "token"), r && r.err ? "warn" : "ok");
  if (r && !r.err && activeView === "ethwallet") renderEthWallet();
}

function ewTokenMenu(b, addr) {
  const t = b.tokens.find(x => x.address === addr) || { symbol: "Token", address: addr };
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewMenuOv"><div class="modal">
    <div class="modal__title">${esc(t.symbol)}</div>
    <div class="seg" style="flex-direction:column;gap:8px">
      <button class="btn btn--outline btn--full" id="ewMenuSend">Send ${esc(t.symbol)}</button>
      <a class="btn btn--outline btn--full" href="${EW_ETHERSCAN}token/${esc(addr)}?a=${esc(b.address)}" target="_blank" rel="noreferrer">View on Etherscan ↗</a>
      <button class="btn btn--outline btn--full" id="ewMenuCopy">Copy contract address</button>
      <button class="btn btn--outline btn--full" id="ewMenuRemove" style="color:var(--red)">Remove from list</button>
    </div>
    <div class="seg" style="margin-top:10px"><button class="btn btn--outline btn--full" id="ewMenuClose">Close</button></div></div></div>`);
  const ov = el("ewMenuOv"); const close = () => ov && ov.remove();
  el("ewMenuClose").onclick = close; ov.onclick = e => { if (e.target.id === "ewMenuOv") close(); };
  el("ewMenuSend").onclick = () => { close(); ewSendDialog(b, addr); };
  el("ewMenuCopy").onclick = () => copy(addr);
  el("ewMenuRemove").onclick = async () => { close(); await api.ewRemoveToken(addr).catch(() => {}); if (activeView === "ethwallet") renderEthWallet(); };
}

function ewSettingsDialog(b) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewSetOv"><div class="modal">
    <div class="modal__title">ETH Wallet settings</div>
    <div class="seg" style="flex-direction:column;gap:8px">
      <button class="btn btn--outline btn--full" id="ewSetKey">Export private key</button>
      <button class="btn btn--outline btn--full" id="ewSetRpc">RPC endpoint</button>
      <button class="btn btn--outline btn--full" id="ewSetTok">Add token</button>
      <a class="btn btn--outline btn--full" href="${EW_ETHERSCAN}address/${esc(b.address)}" target="_blank" rel="noreferrer">View address on Etherscan ↗</a>
    </div>
    <div class="view__desc" style="margin-top:10px">Your key is derived from this node's seed — the same address AtomiX and minimaSwap use. There is nothing to back up separately; restore your Minima seed and this wallet returns.</div>
    <div class="seg" style="margin-top:8px"><button class="btn btn--outline btn--full" id="ewSetClose">Close</button></div></div></div>`);
  const ov = el("ewSetOv"); const close = () => ov && ov.remove();
  el("ewSetClose").onclick = close; ov.onclick = e => { if (e.target.id === "ewSetOv") close(); };
  el("ewSetKey").onclick = () => { close(); ewExportKey(); };
  el("ewSetRpc").onclick = () => { close(); ewRpcDialog(); };
  el("ewSetTok").onclick = () => { close(); ewAddTokenDialog(); };
}

async function ewExportKey() {
  if (!await showConfirm("Export ETH private key", "This key controls your ETH funds. Anyone who sees it can take them. It is derived from your Minima node seed. Never share it or type it into a website.", "Reveal key", true)) return;
  const pk = await api.ewExportKey().catch(() => null);
  if (!pk) { toast("Wallet not ready", "warn"); return; }
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewPkOv"><div class="modal">
    <div class="modal__title">ETH private key</div><div class="view__desc" style="color:var(--red)">⚠ Keep this secret.</div>
    <div class="mono" style="user-select:all;word-break:break-all;font-size:12px">${esc(pk)}</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="ewPkClose">Close</button><button class="btn btn--primary btn--full" id="ewPkCopy">Copy key</button></div></div></div>`);
  const ov = el("ewPkOv"); const close = () => ov && ov.remove();
  el("ewPkClose").onclick = close; el("ewPkCopy").onclick = () => copy(pk);
  ov.onclick = e => { if (e.target.id === "ewPkOv") close(); };
}

async function ewRpcDialog() {
  const st = await api.ewStatus().catch(() => ({}));
  const cur = st && st.rpc ? st.rpc : "";
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ewRpcOv"><div class="modal">
    <div class="modal__title">RPC endpoint</div>
    <div class="field"><div class="field__label">Custom HTTPS RPC (blank = built-in public nodes)</div><input class="field__input mono" id="ewRpcIn" placeholder="https://…" value="${esc(cur)}" autocomplete="off" spellcheck="false" /></div>
    <div class="view__desc">Falls back to public keyless nodes automatically. Only public https hosts are allowed — local/private addresses are blocked for safety. This endpoint is used for all Ethereum activity on this node, including AtomiX swap settlement.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="ewRpcDefault">Use default</button><button class="btn btn--primary btn--full" id="ewRpcSave">Save</button></div>
    <div class="seg" style="margin-top:8px"><button class="btn btn--outline btn--full" id="ewRpcCancel">Cancel</button></div></div></div>`);
  const ov = el("ewRpcOv"); const close = () => ov && ov.remove();
  el("ewRpcCancel").onclick = close; ov.onclick = e => { if (e.target.id === "ewRpcOv") close(); };
  el("ewRpcDefault").onclick = async () => { const r = await api.ewSetRpc("").catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "✓ Using default public RPCs", r && r.err ? "warn" : "ok"); close(); };
  el("ewRpcSave").onclick = async () => { const u = el("ewRpcIn").value.trim(); const r = await api.ewSetRpc(u).catch(e => ({ err: String(e.message || e) })); if (r && r.err) { toast(r.err, "warn"); return; } toast("✓ RPC saved", "ok"); close(); };
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

// ============================ miniMall (shop · studio · orders) ============================
let shopView = "orders";        // orders | shop | studio
let shopIdentity = null;        // { publicId, vendorAddress }
let shopLoaded = null;          // the .shop config open in the Shop viewer
let shopCart = {};              // productId → qty
let shopOrderRef = null;        // open order detail
let shopDraft = null;           // Studio: the shop config being authored
let shopUpdateTimer = null;

async function onShopUpdate() {
  if (shopUpdateTimer) clearTimeout(shopUpdateTimer);
  shopUpdateTimer = setTimeout(async () => {
    refreshShopBadge();
    if (activeView !== "minimall") return;
    if (el("shopBody") && el("shopBody").querySelector("input:focus, textarea:focus")) return;   // never stomp a form
    if (shopView === "orders") renderShopSub();
  }, 350);
}
async function refreshShopBadge() {
  try { const n = await api.shopNewCount(); const b = el("shopBadge"); if (!b) return; if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true; paintTrayDot(); } catch (e) {}
}

async function renderMiniMall() {
  const host = el("shopBody"); if (!host) return;
  if (!shopIdentity) { try { shopIdentity = await api.shopInit(); } catch (e) {} }
  const tab = (v, label) => `<button class="btn btn--sm ${shopView === v ? "btn--primary" : "btn--outline"}" data-shopview="${v}">${label}</button>`;
  host.innerHTML = `<div class="view__title" style="border:0;padding-bottom:2px">miniMall</div>
    <div class="view__desc" style="margin-top:0">Your on-chain shops — author, sell, and receive orders. Interoperates with the miniMall apps on the same network.</div>
    <div class="seg" style="margin-bottom:10px">${tab("orders", "Orders")}${tab("shop", "Shop")}${tab("studio", "Studio")}</div>
    <div id="shopSub"></div>`;
  document.querySelectorAll("#shopBody [data-shopview]").forEach(b => b.onclick = () => { shopView = b.dataset.shopview; shopOrderRef = null; renderMiniMall(); });
  renderShopSub();
}
function renderShopSub() {
  if (shopView === "orders") renderShopOrders();
  else if (shopView === "shop") renderShopBrowse();
  else renderShopStudio();
}
function shopStatusPill(status, unpaid) {
  const cls = ({ DELIVERED: "ok", SHIPPED: "ok", PAID: "acc", CONFIRMED: "acc", UNDERPAID: "warn", WRONG_TOKEN: "warn" })[status] || "";
  const label = unpaid && status === "PENDING" ? "unpaid" : String(status || "").toLowerCase();
  return `<span class="shop-pill ${cls}">${esc(label)}</span>`;
}

// ---- Orders (miniMail): Selling (incoming to my shops) + Buying (my placed orders) ----
async function renderShopOrders() {
  const host = el("shopSub"); if (!host) return;
  if (shopOrderRef) return renderShopOrderDetail(shopOrderRef);
  const orders = await api.shopOrders().catch(() => []);
  const id = shopIdentity ? idHtml(shopIdentity.publicId) : "…";   // RULE 1: the whole id, one click to copy (axShort left with the AtomiX panel)
  if (!orders.length) { host.innerHTML = `<div class="card"><div class="empty">No orders yet. Orders to your shops (Selling) and orders you place (Buying) both land here.<br>Your shop id: ${id}</div></div>`; return; }
  const row = o => `<div class="card shop-order" data-oref="${esc(o.ref)}"><div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><span class="mono">${esc(o.ref)}</span>${o.unread ? ' <span class="shop-dot"></span>' : ""}<div class="view__desc" style="margin:2px 0 0">${esc(o.shopName || "")}</div></div>
      <div style="text-align:right"><div class="mono">${esc(o.amount)} ${esc(o.currency)}</div>${shopStatusPill(o.status, o.unpaid)}</div></div></div>`;
  const sec = (title, list) => list.length ? `<div class="ax-seclabel">${title}</div>` + list.map(row).join("") : "";
  host.innerHTML = sec("SELLING · orders to your shops", orders.filter(o => o.role === "sell")) + sec("BUYING · orders you placed", orders.filter(o => o.role === "buy"));
  host.querySelectorAll("[data-oref]").forEach(r => r.onclick = () => { shopOrderRef = r.dataset.oref; renderShopOrders(); });
}
async function renderShopOrderDetail(ref) {
  const host = el("shopSub"); if (!host) return;
  const d = await api.shopOrder(ref).catch(() => null);
  if (!d || !d.order) { shopOrderRef = null; return renderShopOrders(); }
  const o = d.order, isSell = o.role === "sell";
  const items = (o.items || []).map(i => `<div class="row" style="justify-content:space-between"><span>${esc(i.product)}${i.size ? " · " + esc(i.size) : ""} × ${esc(String(i.quantity))}</span><span class="mono">${esc(i.lineTotal || "")}</span></div>`).join("");
  const chat = (d.chat || []).map(m => `<div class="mail-bubble ${m.incoming ? "" : "mail-bubble--me"}"><div class="mail-bubble__body">${esc(m.message)}</div></div>`).join("");
  host.innerHTML = `<button class="btn btn--sm btn--outline" id="shopBack">← Orders</button>
    <div class="card" style="margin-top:8px"><div class="card__title">${esc(o.ref)} · ${isSell ? "incoming order" : "your order"}</div>
      ${shopStatusPill(o.status, d.unpaid)}
      <div class="view__desc" style="margin-top:6px">${esc(o.shopName || "")}</div>${items}
      <div class="row" style="justify-content:space-between;margin-top:6px;font-weight:700"><span>Total</span><span class="mono">${esc(o.amount)} ${esc(o.currency)}</span></div>
      ${o.shipping ? `<div class="view__desc">Shipping: ${esc(o.shipping)}</div>` : ""}
      ${isSell && o.delivery ? `<div class="view__desc">Deliver to: ${esc(o.delivery)}</div>` : ""}
      ${isSell ? `<div class="view__desc">${o.paid ? "Paid ✓ " + esc(o.paidAmount || "") : "Awaiting payment"}</div>` : ""}
      ${(!isSell && d.ambiguous) ? `<div class="shop-warn" style="margin-top:8px">⚠ The payment timed out — it may already have gone through. Check your Balance/History before sending again, to avoid paying twice.</div>` : ""}
      ${(!isSell && d.unpaid && !d.ambiguous && !o.paid) ? `<button class="btn btn--primary btn--full" id="shopRetry" style="margin-top:8px">Retry payment</button>` : ""}
      ${isSell ? shopAdvanceRow(o) : ""}
    </div>
    <div class="card"><div class="card__title">Messages</div><div class="mail-thread" style="max-height:200px;overflow:auto">${chat || '<div class="empty">No messages yet.</div>'}</div>
      <div class="row" style="margin-top:8px;gap:6px"><input class="field__input" id="shopMsg" placeholder="Message the ${isSell ? "buyer" : "vendor"}…" style="flex:1" autocomplete="off"/><button class="btn btn--outline btn--sm" id="shopSend">Send</button></div>
    </div>`;
  el("shopBack").onclick = () => { shopOrderRef = null; renderShopOrders(); };
  if (el("shopRetry")) el("shopRetry").onclick = async () => { el("shopRetry").disabled = true; try { await api.shopRetryPay(ref); toast("Payment sent ✓", "ok"); } catch (e) { toast(e.message || "failed", "warn"); } renderShopOrderDetail(ref); };
  el("shopSend").onclick = async () => { const t = el("shopMsg").value.trim(); if (!t) return; try { await api.shopReply(ref, t); } catch (e) { toast(e.message || "failed", "warn"); } renderShopOrderDetail(ref); };
  document.querySelectorAll("[data-advance]").forEach(b => b.onclick = async () => { b.disabled = true; try { await api.shopAdvance(ref, b.dataset.advance); toast("Status updated ✓", "ok"); } catch (e) { toast(e.message || "failed", "warn"); } renderShopOrderDetail(ref); });
}
function shopAdvanceRow(o) {
  if (o.status === "INQUIRY") return "";
  if (!o.paid) return `<div class="view__desc" style="margin-top:8px">Awaiting payment before you can confirm.</div>`;
  const flow = ["CONFIRMED", "SHIPPED", "DELIVERED"], rank = { PAID: -1, CONFIRMED: 0, SHIPPED: 1, DELIVERED: 2 };
  const cur = rank[o.status] != null ? rank[o.status] : -1, next = flow[cur + 1];
  if (!next) return `<div class="view__desc" style="margin-top:8px">Order delivered ✓</div>`;
  return `<button class="btn btn--primary btn--full" data-advance="${next}" style="margin-top:8px">Mark ${next.toLowerCase()}</button>`;
}

// ---- Shop viewer: load a .shop → storefront → cart → checkout → order + payment ----
async function renderShopBrowse() {
  const host = el("shopSub"); if (!host) return;
  if (!shopLoaded) {
    const mine = await api.shopMyShops().catch(() => []);
    host.innerHTML = `<div class="card"><div class="card__title">Open a shop</div>
      <div class="view__desc">Load a <span class="mono">.shop</span> a vendor shared with you, or preview one of yours.</div>
      <button class="btn btn--primary btn--full" id="shopOpenFile" style="margin-top:8px">Open a .shop file…</button></div>
      ${mine.length ? `<div class="ax-seclabel">MY SHOPS</div>` + mine.map(s => `<div class="card shop-order" data-openmine="${esc(s.shopId)}"><div class="row" style="justify-content:space-between"><span>${esc(s.shopName)}</span><span class="view__desc">${(s.products || []).length} item(s) · ${esc(s.currency)}</span></div></div>`).join("") : ""}`;
    el("shopOpenFile").onclick = async () => { try { const cfg = await api.shopImport(); if (cfg) { shopLoaded = cfg; shopCart = {}; renderShopBrowse(); } } catch (e) { toast(e.message || "not a valid .shop", "warn"); } };
    host.querySelectorAll("[data-openmine]").forEach(c => c.onclick = async () => { const mine2 = await api.shopMyShops(); shopLoaded = mine2.find(s => s.shopId === c.dataset.openmine); shopCart = {}; renderShopBrowse(); });
    return;
  }
  const s = shopLoaded;
  const cartCount = Object.values(shopCart).reduce((a, b) => a + b, 0);
  const grid = (s.products || []).map(p => {
    const qty = shopCart[p.id] || 0, cap = Number(p.maxUnits) || 99;
    return `<div class="card shop-prod">
      <div class="shop-prod-imgwrap" data-open="${esc(p.id)}" title="View details">${p.image ? `<img class="shop-prod-img" src="${esc(p.image)}" alt=""/>` : `<div class="shop-prod-img shop-prod-noimg">🛍</div>`}<span class="shop-zoom">⤢</span></div>
      <div class="shop-prod-name" data-open="${esc(p.id)}">${esc(p.name)}</div>
      <div class="view__desc shop-prod-desc">${esc(p.description || "")}</div>
      <div class="shop-prod-price mono">${esc(p.price)} ${esc(s.currency)}</div>
      ${shopStepper(p.id, qty, cap)}
    </div>`;
  }).join("");
  host.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center"><div><div class="card__title" style="margin:0">${esc(s.shopName)}</div><div class="view__desc">pays in ${esc(s.currency)}</div></div><button class="btn btn--sm btn--outline" id="shopClose">Close</button></div>
    <div class="shop-grid">${grid}</div>
    ${cartCount ? `<div class="shop-cartbar"><span>${cartCount} item(s) · <span class="mono">${shopCartTotal().toFixed(6)} ${esc(s.currency)}</span></span><button class="btn btn--primary btn--sm" id="shopCheckout">Checkout</button></div>` : ""}`;
  el("shopClose").onclick = () => { shopLoaded = null; shopCart = {}; renderShopBrowse(); };
  host.querySelectorAll("[data-open]").forEach(e => e.onclick = () => shopProductModal(e.dataset.open));
  host.querySelectorAll("[data-inc]").forEach(b => b.onclick = () => { const id = b.dataset.inc, cap = shopCapOf(id); shopCart[id] = Math.min(cap, (shopCart[id] || 0) + 1); renderShopBrowse(); });
  host.querySelectorAll("[data-dec]").forEach(b => b.onclick = () => { const id = b.dataset.dec; shopCart[id] = Math.max(0, (shopCart[id] || 0) - 1); if (!shopCart[id]) delete shopCart[id]; renderShopBrowse(); });
  if (el("shopCheckout")) el("shopCheckout").onclick = shopOpenCheckout;
}
function shopStepper(id, qty, cap) {
  return `<div class="shop-stepper"><button class="shop-step" data-dec="${esc(id)}" ${qty <= 0 ? "disabled" : ""}>−</button><span class="shop-qty mono">${qty}</span><button class="shop-step" data-inc="${esc(id)}" ${qty >= cap ? "disabled" : ""}>+</button></div>`;
}
function shopCapOf(id) { const p = (shopLoaded && shopLoaded.products || []).find(x => x.id === id); return p ? (Number(p.maxUnits) || 99) : 99; }
// Rich product detail modal — big image, full description, qty + add-to-cart.
function shopProductModal(id) {
  const s = shopLoaded; const p = (s && s.products || []).find(x => x.id === id); if (!p) return;
  const qty = shopCart[id] || 0, cap = Number(p.maxUnits) || 99;
  let ov = document.getElementById("shopModalOv");
  if (!ov) { ov = document.createElement("div"); ov.id = "shopModalOv"; ov.className = "shop-modal-ov"; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="shop-modal">
    <button class="shop-modal-x" id="shopModalX" aria-label="Close">✕</button>
    ${p.image ? `<img class="shop-modal-img" src="${esc(p.image)}" alt=""/>` : `<div class="shop-modal-img shop-prod-noimg" style="height:200px;font-size:56px">🛍</div>`}
    <div class="shop-modal-body">
      <div class="shop-modal-name">${esc(p.name)}</div>
      <div class="shop-modal-price mono">${esc(p.price)} ${esc(s.currency)}</div>
      <div class="shop-modal-desc">${esc(p.description || "No description.")}</div>
      <div class="view__desc">Up to ${cap} per order · from ${esc(s.shopName)}</div>
      <div class="shop-modal-buy">${shopStepper(id, qty, cap)}<button class="btn btn--primary" id="mAdd">${qty > 0 ? "In cart ✓" : "Add to cart"}</button></div>
    </div></div>`;
  const close = () => { const o = document.getElementById("shopModalOv"); if (o) o.remove(); document.removeEventListener("keydown", onKey); renderShopBrowse(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  el("shopModalX").onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector("[data-inc]").onclick = () => { shopCart[id] = Math.min(cap, (shopCart[id] || 0) + 1); shopProductModal(id); };
  ov.querySelector("[data-dec]").onclick = () => { shopCart[id] = Math.max(0, (shopCart[id] || 0) - 1); if (!shopCart[id]) delete shopCart[id]; shopProductModal(id); };
  el("mAdd").onclick = () => { if (!shopCart[id]) shopCart[id] = 1; shopProductModal(id); };
}
function shopCartTotal() {
  const s = shopLoaded; if (!s) return 0; let t = 0;
  for (const p of (s.products || [])) { const q = shopCart[p.id] || 0; if (q) t += q * Number(p.price); }
  const ship = shopSelectedShipping(); if (ship) t += Number(ship.fee) || 0;
  return t;
}
let shopShipId = null;
function shopSelectedShipping() { const s = shopLoaded; if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(x => x.id === shopShipId) || s.shipping[0]; }
async function shopOpenCheckout() {
  const s = shopLoaded;
  const shipOpts = (s.shipping || []).map(sh => `<option value="${esc(sh.id)}">${esc(sh.label)}${Number(sh.fee) > 0 ? " (+" + esc(String(sh.fee)) + " " + esc(s.currency) + ")" : " (free)"}</option>`).join("");
  const host = el("shopSub");
  host.innerHTML = `<button class="btn btn--sm btn--outline" id="shopBackStore">← Store</button>
    <div class="card" style="margin-top:8px"><div class="card__title">Checkout · ${esc(s.shopName)}</div>
      ${(s.products || []).filter(p => shopCart[p.id]).map(p => `<div class="row" style="justify-content:space-between"><span>${esc(p.name)} × ${shopCart[p.id]}</span><span class="mono">${(shopCart[p.id] * Number(p.price)).toFixed(6)}</span></div>`).join("")}
      ${shipOpts ? `<div class="field" style="margin-top:8px"><div class="field__label">Shipping</div><select class="field__input" id="shopShip">${shipOpts}</select></div>` : ""}
      <div class="field"><div class="field__label">Delivery (address / email — encrypted, only the vendor sees it)</div><textarea class="field__input" id="shopDelivery" rows="2" placeholder="Where should this go?"></textarea></div>
      <div class="field"><div class="field__label">Note (optional)</div><input class="field__input" id="shopNote" placeholder="Anything for the vendor?" autocomplete="off"/></div>
      <div class="row" style="justify-content:space-between;margin-top:8px;font-weight:700"><span>Total</span><span class="mono" id="shopCkTotal">${shopCartTotal().toFixed(6)} ${esc(s.currency)}</span></div>
      <button class="btn btn--primary btn--full" id="shopPay" style="margin-top:10px">Pay & place order</button>
      <div class="view__desc" style="margin-top:6px">Sends an encrypted order to the vendor + the ${esc(s.currency)} payment in one go.</div>
    </div>`;
  el("shopBackStore").onclick = () => renderShopBrowse();
  if (el("shopShip")) el("shopShip").onchange = () => { shopShipId = el("shopShip").value; el("shopCkTotal").textContent = shopCartTotal().toFixed(6) + " " + s.currency; };
  el("shopPay").onclick = shopDoPay;
}
async function shopDoPay() {
  const s = shopLoaded; const btn = el("shopPay"); btn.disabled = true; btn.textContent = "Placing order…";
  const items = (s.products || []).filter(p => shopCart[p.id]).map(p => ({ product: p.name, quantity: shopCart[p.id], unitPrice: String(p.price), lineTotal: (shopCart[p.id] * Number(p.price)).toFixed(6) }));
  if (!items.length) { toast("Cart is empty", "warn"); btn.disabled = false; btn.textContent = "Pay & place order"; return; }
  const ship = shopSelectedShipping(), total = shopCartTotal().toFixed(6);
  const delivery = (el("shopDelivery") && el("shopDelivery").value.trim()) || "", note = (el("shopNote") && el("shopNote").value.trim()) || "";
  try {
    const r = await api.shopPlaceOrder(s, items, total, ship ? ship.label : "", delivery, note);
    if (r.payError) toast("Order sent, but payment failed: " + r.payError + " — retry from Orders.", "warn");
    else toast("Order placed ✓ " + r.ref, "ok");
    shopCart = {}; shopLoaded = null; shopView = "orders"; shopOrderRef = null; renderMiniMall();
  } catch (e) { toast(e.message || "order failed", "warn"); btn.disabled = false; btn.textContent = "Pay & place order"; }
}

// ---- Studio: author a .shop (auto vendor card from the node identity) ----
function shopSlug(s) { return String(s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop"; }
// Standard shipping: Digital (always free), Domestic + International (fees configurable).
function shopStandardShipping() { return [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0" }, { id: "international", label: "International", fee: "0" }]; }
function shopNormalizeShipping(list) { const by = {}; (list || []).forEach(s => { if (s && s.id) by[s.id] = s; }); return shopStandardShipping().map(std => ({ id: std.id, label: std.label, fee: std.id === "digital" ? "0" : String((by[std.id] && by[std.id].fee) || "0") })); }
async function renderShopStudio() {
  const host = el("shopSub"); if (!host) return;
  if (!shopDraft) {
    const mine = await api.shopMyShops().catch(() => []);
    host.innerHTML = `<button class="btn btn--primary btn--full" id="shopNew">+ New shop</button>
      ${mine.length ? `<div class="ax-seclabel">MY SHOPS</div>` + mine.map(s => `<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><div><b>${esc(s.shopName)}</b><div class="view__desc">${(s.products || []).length} item(s) · ${esc(s.currency)}</div></div><div class="seg"><button class="btn btn--sm btn--outline" data-editshop="${esc(s.shopId)}">Edit</button><button class="btn btn--sm btn--outline" data-exportshop="${esc(s.shopId)}">Export</button></div></div></div>`).join("") : `<div class="card"><div class="empty">No shops yet. Create one — customers load the exported <span class="mono">.shop</span> file to buy.</div></div>`}`;
    el("shopNew").onclick = () => { shopDraft = { shopName: "", currency: "Minima", vendorPublicId: shopIdentity ? shopIdentity.publicId : "", vendorAddress: shopIdentity ? shopIdentity.vendorAddress : "", shipping: shopStandardShipping(), products: [] }; renderShopStudio(); };
    host.querySelectorAll("[data-editshop]").forEach(b => b.onclick = async () => { const m = await api.shopMyShops(); shopDraft = JSON.parse(JSON.stringify(m.find(s => s.shopId === b.dataset.editshop))); shopDraft.shipping = shopNormalizeShipping(shopDraft.shipping); renderShopStudio(); });
    host.querySelectorAll("[data-exportshop]").forEach(b => b.onclick = async () => { const m = await api.shopMyShops(); const s = m.find(x => x.shopId === b.dataset.exportshop); const p = await api.shopExport(JSON.stringify(s, null, 2), s.shopId); if (p) toast("Exported → " + p, "ok"); });
    return;
  }
  const d = shopDraft;
  const prods = d.products.map((p, i) => `<div class="card shop-prod-edit">
      <div class="row" style="justify-content:space-between"><b>Item ${i + 1}</b><button class="btn btn--sm btn--outline" data-delprod="${i}">Remove</button></div>
      <div class="shop-imgdrop" data-imgi="${i}">${p.image ? `<img class="shop-prod-img" src="${esc(p.image)}"/>` : "drop / click to add a photo"}</div>
      <input class="field__input" data-pf="name" data-pi="${i}" placeholder="Name" value="${esc(p.name || "")}" autocomplete="off"/>
      <input class="field__input" data-pf="description" data-pi="${i}" placeholder="Description" value="${esc(p.description || "")}" autocomplete="off"/>
      <div class="row" style="gap:6px"><input class="field__input" data-pf="price" data-pi="${i}" inputmode="decimal" placeholder="Price" value="${esc(p.price || "")}" style="flex:1" autocomplete="off"/><input class="field__input" data-pf="maxUnits" data-pi="${i}" inputmode="numeric" placeholder="Max qty" value="${esc(p.maxUnits || "")}" style="flex:1" autocomplete="off"/></div>
    </div>`).join("");
  const ship = d.shipping.map((sh, i) => sh.id === "digital"
    ? `<div class="row" style="justify-content:space-between;margin-top:4px"><span>Digital</span><span class="view__desc">Free</span></div>`
    : `<div class="row" style="align-items:center;justify-content:space-between;margin-top:4px"><span>${esc(sh.label)}</span><input class="field__input" data-sf="fee" data-si="${i}" inputmode="decimal" placeholder="Fee (${esc(d.currency)})" value="${esc(sh.fee || "")}" style="flex:0 0 130px;text-align:right" autocomplete="off"/></div>`).join("");
  host.innerHTML = `<button class="btn btn--sm btn--outline" id="shopStudioBack">← My shops</button>
    <div class="card" style="margin-top:8px"><div class="card__title">${d.shopId ? "Edit shop" : "New shop"}</div>
      <div class="field"><div class="field__label">Shop name</div><input class="field__input" id="sdName" value="${esc(d.shopName)}" placeholder="My Shop" autocomplete="off"/></div>
      <div class="field"><div class="field__label">Currency</div><div class="seg"><button class="btn btn--sm ${d.currency === "Minima" ? "btn--primary" : "btn--outline"}" data-cur="Minima">MINIMA</button><button class="btn btn--sm ${d.currency !== "Minima" ? "btn--primary" : "btn--outline"}" data-cur="USDT">MxUSD</button></div></div>
      <div class="view__desc">Vendor card (auto-derived from your node — this is how buyers' orders reach you):</div>
      <div class="mono shop-card">${esc((d.vendorPublicId || "").slice(0, 18))}… | ${esc(d.vendorAddress || "")}</div>
    </div>
    <div class="card"><div class="card__title">Shipping</div><div class="view__desc">Digital delivery is free. Set your Domestic &amp; International fees.</div>${ship}</div>
    <div class="card"><div class="card__title">Products (max 40)</div>${prods || '<div class="empty">Add your first product.</div>'}<button class="btn btn--outline btn--full" id="sdAddProd" style="margin-top:8px">+ Add product</button></div>
    <button class="btn btn--primary btn--full" id="sdSave">Save${d.shopId ? "" : " & export .shop"}</button>`;
  const readForm = () => {
    d.shopName = el("sdName").value.trim();
    host.querySelectorAll("[data-pf]").forEach(inp => { const i = +inp.dataset.pi; d.products[i][inp.dataset.pf] = inp.value; });
    host.querySelectorAll("[data-sf]").forEach(inp => { const i = +inp.dataset.si; if (d.shipping[i]) d.shipping[i].fee = inp.value; });
  };
  el("shopStudioBack").onclick = () => { readForm(); shopDraft = null; renderShopStudio(); };
  host.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { readForm(); d.currency = b.dataset.cur; renderShopStudio(); });
  el("sdAddProd").onclick = () => { readForm(); if (d.products.length >= 40) return toast("Max 40 products", "warn"); d.products.push({ id: "p" + Date.now().toString(36), name: "", description: "", mode: "units", price: "", maxUnits: "10", image: "" }); renderShopStudio(); };
  host.querySelectorAll("[data-delprod]").forEach(b => b.onclick = () => { readForm(); d.products.splice(+b.dataset.delprod, 1); renderShopStudio(); });
  host.querySelectorAll(".shop-imgdrop").forEach(dz => {
    const i = +dz.dataset.imgi;
    const pick = () => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.onchange = async () => { if (inp.files[0]) { readForm(); d.products[i].image = await shopResizeImage(inp.files[0]); renderShopStudio(); } }; inp.click(); };
    dz.onclick = pick;
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = async e => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) { readForm(); d.products[i].image = await shopResizeImage(f); renderShopStudio(); } };
  });
  el("sdSave").onclick = async () => {
    readForm();
    if (!d.shopName) return toast("Give the shop a name", "warn");
    if (!d.products.length) return toast("Add at least one product", "warn");
    const cfg = { shopName: d.shopName, shopId: d.shopId || shopSlug(d.shopName), vendorPublicId: d.vendorPublicId, vendorAddress: d.vendorAddress,
      currency: d.currency, tokenid: d.currency === "Minima" ? "0x00" : "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90",
      shipping: shopNormalizeShipping(d.shipping),
      products: d.products.filter(p => p.name && Number(p.price) > 0).map(p => ({ id: p.id, name: p.name, description: p.description || "", mode: "units", price: String(p.price), maxUnits: String(Number(p.maxUnits) || 10), image: p.image || "" })) };
    await api.shopSave(cfg);
    const wasNew = !d.shopId;
    shopDraft = null;
    toast("Shop saved ✓", "ok");
    if (wasNew) { const p = await api.shopExport(JSON.stringify(cfg, null, 2), cfg.shopId); if (p) toast("Exported → " + p, "ok"); }
    renderShopStudio();
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

// ============================ Vestr (token vesting — shared covenant 0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE) ============================
// Reproduces the MDS 1.8.1 / native Vestr: lock a token amount to a beneficiary, released linearly start→end,
// collectable per grace cadence. Node computes the exact collectable (main/vestr.js runscript). Merged layout.
let vestrView = "list";          // list | create | calc
let vestrUpdateTimer = null;
let vestrTokMap = null;          // tokenid → name
let vestrBusy = {};
const VESTR_GRACE = [["None (continuous)", 0], ["Daily", 24], ["Weekly", 168], ["Monthly", 720], ["Every 3 Months", 2190], ["Every 6 Months", 4320], ["Yearly", 8640]];

function vFmt(v) { const n = Number(v); return isNaN(n) ? "0" : n.toLocaleString(undefined, { maximumFractionDigits: 8 }); }
function vTok(tid) { if (tid === "0x00") return "MINIMA"; return (vestrTokMap && vestrTokMap[tid]) || String(tid); }   // RULE 1: an unnamed token shows its whole id

function onVestrUpdate() {
  if (vestrUpdateTimer) clearTimeout(vestrUpdateTimer);
  vestrUpdateTimer = setTimeout(() => {
    if (activeView !== "vestr") return;
    if (el("vestrBody") && el("vestrBody").querySelector("input:focus, select:focus")) return;   // never stomp a form
    if (vestrView === "list") renderVestrSub();
  }, 350);
}

async function renderVestr() {
  const host = el("vestrBody"); if (!host) return;
  if (!vestrTokMap) { try { const t = await api.vestrTokens(); vestrTokMap = {}; (t || []).forEach(x => vestrTokMap[x.tokenid] = x.name); } catch (e) {} }
  const tab = (v, label) => `<button class="btn btn--sm ${vestrView === v ? "btn--primary" : "btn--outline"}" data-vv="${v}">${label}</button>`;
  host.innerHTML = `<div class="view__title" style="display:flex;align-items:center;gap:10px">Vestr <span style="font:600 11px/1 var(--mono);color:var(--dim)">TOKEN VESTING · shared covenant</span></div>`
    + `<div class="seg" style="margin:8px 0 12px">${tab("list", "My Contracts")}${tab("create", "Create")}${tab("calc", "Calculate")}</div>`
    + `<div id="vestrSub"></div>`;
  host.querySelectorAll("[data-vv]").forEach(b => b.addEventListener("click", () => { vestrView = b.dataset.vv; renderVestr(); }));
  renderVestrSub();
}
function renderVestrSub() {
  if (vestrView === "list") return renderVestrList();
  if (vestrView === "create") return renderVestrCreate();
  if (vestrView === "calc") return renderVestrCalc();
}

// ---- My Contracts ----
async function renderVestrList() {
  const host = el("vestrSub"); if (!host) return;
  let vs = []; try { vs = await api.vestrList(); } catch (e) {}
  if (el("vestrSub") !== host) return;
  if (!vs.length) { host.innerHTML = `<div class="card"><div class="view__desc" style="margin:0">You have no vesting contracts yet. <b>Create</b> one, or ask someone to vest to your address — contracts from the native app & web dapp appear here too.</div></div>`; return; }
  host.innerHTML = vs.map(v => {
    const badge = v.expired ? `<span class="v-badge done">fully vested</span>` : v.cliffed ? `<span class="v-badge cliff">not started</span>` : `<span class="v-badge">${v.pctVested}% vested</span>`;
    const availCol = v.canCollectNow ? "var(--green)" : "var(--dim)";
    let action;
    if (v.canCollectNow) action = `<div class="v-collect"><div class="v-fee"><span class="v-flabel">Fee (burn)</span><input class="field__input" id="vburn_${v.coinid}" value="0"></div><button class="btn btn--primary v-cbtn" data-coin="${v.coinid}" ${vestrBusy[v.coinid] ? "disabled" : ""}>${vestrBusy[v.coinid] ? "Collecting…" : "Collect " + vFmt(v.cancollect) + " " + vTok(v.tokenid)}</button></div>`;
    else if (v.cliffed) action = `<div class="v-note">Vesting hasn't started — nothing collectable until block ${v.startBlock.toLocaleString()}.</div>`;
    else if (v.mustwait) action = `<div class="v-note">Grace period — collect again in ~${Number(v.mustwaitblocks).toLocaleString()} blocks.</div>`;
    else action = `<div class="v-note">Nothing available to collect right now.</div>`;
    return `<div class="card v-card">
      <div class="v-top"><span class="v-amt">${vFmt(v.amount)} <small>${esc(vTok(v.tokenid))}</small> <span style="color:var(--dim);font-weight:400">locked</span></span>${badge}</div>
      <div class="v-to mono">→ ${idHtml(v.beneficiary)}</div>
      <div class="v-bar"><i style="width:${v.pctVested}%;${v.expired ? "background:var(--green)" : ""}"></i></div>
      <div class="v-sub mono"><span>start · block ${v.startBlock.toLocaleString()}</span><span>end · block ${v.endBlock.toLocaleString()}</span></div>
      <div class="v-avail"><span class="k">Available to collect now</span><span class="val" style="color:${availCol}">${vFmt(v.cancollect)}</span></div>
      <div class="v-stats">
        <div><span>Collected</span><b>${vFmt(v.collected)}</b></div><div><span>Total locked</span><b>${vFmt(v.total)}</b></div>
        <div><span>Remaining</span><b>${vFmt(v.amount)}</b></div><div><span>Collect every</span><b>${esc(v.graceLabel)}</b></div>
      </div>
      ${action}
    </div>`;
  }).join("");
  host.querySelectorAll(".v-cbtn").forEach(btn => btn.addEventListener("click", () => {
    const coin = btn.dataset.coin, fee = (el("vburn_" + coin) || {}).value || "0";
    vestrDoCollect(coin, fee);
  }));
}
async function vestrDoCollect(coinid, burn) {
  if (vestrBusy[coinid]) return;
  vestrBusy[coinid] = true; renderVestrList();
  try { const r = await api.vestrCollect(coinid, burn); delete vestrBusy[coinid]; toast("Collected " + vFmt(r && r.collected) + " " + vTok(r && r.tokenid) + " ✓", "ok"); renderVestrList(); }
  catch (e) { delete vestrBusy[coinid]; toast("Collect failed: " + (e && e.message ? e.message : e), "err"); renderVestrList(); }
}

// ---- Create ----
async function renderVestrCreate() {
  const host = el("vestrSub"); if (!host) return;
  let toks = []; try { toks = await api.vestrTokens(); } catch (e) {}
  let myAddr = ""; try { myAddr = await api.vestrMyAddress(); } catch (e) {}
  if (el("vestrSub") !== host) return;
  const now = new Date(), toLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const startDef = toLocal(now), endDef = toLocal(new Date(now.getTime() + 90 * 24 * 3600 * 1000));
  host.innerHTML = `<div class="card">
    <label class="v-flabel">Token</label>
    <select class="field__input" id="vcTok">${toks.map(t => `<option value="${t.tokenid}">${esc(t.name)} — ${vFmt(t.sendable)} available</option>`).join("") || '<option value="0x00">MINIMA</option>'}</select>
    <label class="v-flabel">Amount to lock</label>
    <input class="field__input" id="vcAmt" inputmode="decimal" placeholder="e.g. 1000">
    <label class="v-flabel">Beneficiary (withdrawal) address</label>
    <div class="v-row"><input class="field__input" id="vcAddr" placeholder="0x… / Mx…" style="flex:1"><button class="btn btn--outline" id="vcMine" style="flex:0 0 auto">My address</button></div>
    <div class="v-row">
      <div style="flex:1"><label class="v-flabel">Start</label><input class="field__input" id="vcStart" type="datetime-local" value="${startDef}"></div>
      <div style="flex:1"><label class="v-flabel">End</label><input class="field__input" id="vcEnd" type="datetime-local" value="${endDef}"></div>
    </div>
    <label class="v-flabel">Release cadence (grace)</label>
    <select class="field__input" id="vcGrace">${VESTR_GRACE.map(([l, h], i) => `<option value="${h}" ${l === "Weekly" ? "selected" : ""}>${l}</option>`).join("")}</select>
    <div class="v-row">
      <div style="flex:1"><label class="v-flabel">Network fee (burn) · optional</label><input class="field__input" id="vcBurn" value="0"></div>
      <div style="flex:1"><label class="v-flabel">Vault password · optional</label><input class="field__input" id="vcPw" type="password" placeholder="if node locked"></div>
    </div>
    <button class="btn btn--primary btn--full" id="vcCreate">Review &amp; create</button>
    <div class="v-note" style="margin-top:9px">Funds lock into the shared vesting covenant and release linearly from Start to End; the beneficiary collects the vested-so-far amount, no more often than the grace cadence. <b>There is no cancel</b> — locked funds only ever flow to the beneficiary (which can be your own address).</div>
  </div>`;
  el("vcMine").addEventListener("click", () => { el("vcAddr").value = myAddr; });
  el("vcCreate").addEventListener("click", vestrDoCreate);
}
async function vestrDoCreate() {
  const btn = el("vcCreate"); if (!btn || btn.disabled) return;
  const opts = {
    tokenid: el("vcTok").value, amount: (el("vcAmt").value || "").trim(), beneficiary: (el("vcAddr").value || "").trim(),
    startMs: new Date(el("vcStart").value).getTime(), endMs: new Date(el("vcEnd").value).getTime(),
    graceHours: Number(el("vcGrace").value) || 0, burn: (el("vcBurn").value || "0").trim(), password: (el("vcPw").value || "")
  };
  if (!(Number(opts.amount) > 0)) { toast("Enter a valid amount", "warn"); return; }
  if (!opts.beneficiary) { toast("Enter a beneficiary address", "warn"); return; }
  // The beneficiary is shown IN FULL, on its own line. This dialog is the last thing between the user and a
  // contract with no cancel path, so it is the one place a truncated address is least excusable: 8 visible
  // characters plus 4 is exactly what an address-substitution swap is designed to survive.
  const ok = await showConfirm("Create vesting contract?",
    `Lock ${vFmt(opts.amount)} ${vTok(opts.tokenid)}\n\nBeneficiary\n${opts.beneficiary}\n\n` +
    `Released ${VESTR_GRACE.find(g => g[1] === opts.graceHours)?.[0] || ""} from start to end.\n` +
    `Check the address above character by character — this cannot be cancelled.`, "Lock funds", false);
  if (!ok) return;
  btn.disabled = true; btn.textContent = "Locking…";
  try { const r = await api.vestrCreate(opts); toast("Vesting contract created ✓", "ok"); vestrView = "list"; renderVestr(); }
  catch (e) { btn.disabled = false; btn.textContent = "Review & create"; toast("Create failed: " + (e && e.message ? e.message : e), "err"); }
}

// ---- Calculate (offline preview) ----
async function renderVestrCalc() {
  const host = el("vestrSub"); if (!host) return;
  host.innerHTML = `<div class="card">
    <div class="v-note" style="margin-top:0">Preview a schedule without locking anything.</div>
    <div class="v-row" style="margin-top:10px">
      <div style="flex:1"><label class="v-flabel">Amount</label><input class="field__input" id="vkAmt" value="1000"></div>
      <div style="flex:1"><label class="v-flabel">Grace</label><select class="field__input" id="vkGrace">${VESTR_GRACE.map(([l, h]) => `<option value="${h}" ${l === "Weekly" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>
    <div class="v-row">
      <div style="flex:1"><label class="v-flabel">Start</label><input class="field__input" id="vkStart" type="date"></div>
      <div style="flex:1"><label class="v-flabel">End</label><input class="field__input" id="vkEnd" type="date"></div>
    </div>
    <div id="vkOut"></div>
  </div>`;
  const rerun = async () => {
    const s = el("vkStart").value ? new Date(el("vkStart").value).getTime() : Date.now();
    const e = el("vkEnd").value ? new Date(el("vkEnd").value).getTime() : Date.now() + 90 * 24 * 3600 * 1000;
    const r = await api.vestrCalculate(el("vkAmt").value || "0", s, e, Number(el("vkGrace").value) || 0).catch(() => null);
    const out = el("vkOut"); if (!out || !r) return;
    const label = VESTR_GRACE.find(g => g[1] === (Number(el("vkGrace").value) || 0))?.[0] || "period";
    out.innerHTML = `<div class="v-avail" style="border-top:0;margin-top:14px"><span class="k">Released per ${esc(label.toLowerCase())}</span><span class="val" style="color:var(--accent)">≈ ${vFmt(r.perPeriod.toFixed(6))}</span></div>
      <div class="v-stats"><div><span>Duration</span><b>${r.durBlocks.toLocaleString()} blocks · ~${r.weeks.toFixed(1)} wks</b></div><div><span>Per-block</span><b>${vFmt(r.perBlock.toFixed(8))}</b></div></div>`;
  };
  ["vkAmt", "vkGrace", "vkStart", "vkEnd"].forEach(id => el(id).addEventListener("input", rerun));
  rerun();
}


// ---- Parlons: the account this node hosts (Parlons Node kind) ------------------------------------------
// The account serves its own web panel on loopback; the tab embeds it in ONE hardened <webview> and shows a
// native strip above it (address, pairing, open-in-browser). The panel signs in with a one-time link the
// account keeps beside its data; a fresh link is fetched whenever the account (re)starts.
let parlonsLoadedFor = "";     // exact node start we last loaded the panel for
let parlonsLastSig = "";       // readiness/error signature that last drove a re-render
let parlonsStatusCache = null;
let parlonsRenderSeq = 0, parlonsRetry = null;
async function renderParlons(attempt = 0) {
  const seq = ++parlonsRenderSeq; clearTimeout(parlonsRetry);
  const strip = el("parlonsStrip"), body = el("parlonsBody");
  function retry(message) {
    parlonsLoadedFor = "";
    strip.innerHTML = `<div class="parlons-strip"><span>${esc(message)}</span><button class="btn btn--sm btn--outline" id="parlonsReload">Reload</button></div>`;
    body.innerHTML = `<div class="spin" role="status">${esc(message)}</div>`;
    el("parlonsReload").onclick = () => renderParlons();
  }
  const st = await api.parlonsStatus().catch(() => null);
  if (seq !== parlonsRenderSeq) return;
  parlonsStatusCache = st;
  if (!st) { retry("Could not check the account. Reload to try again."); return; }
  if (st.kind !== "parlons") {
    parlonsLoadedFor = "";
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
  // The panel IS the Parlons app: no native chrome above it. The strip only speaks when the account
  // is not up (starting / error).
  if (st.ready && !st.error) strip.innerHTML = "";
  else {
    strip.innerHTML = `<div class="parlons-strip"><span>${st.error ? "Account error" : "Starting the account…"}${st.version ? " · Parlons Node " + esc(st.version) : ""}</span>
        <button class="btn btn--sm btn--outline" id="parlonsReload">Reload</button></div>${st.error ? `<div class="status status--warn">${esc(st.error)}</div>` : ""}`;
    el("parlonsReload").onclick = () => { parlonsLoadedFor = ""; renderParlons(); };
  }
  if (!st.ready || st.error) {
    parlonsLoadedFor = "";
    body.innerHTML = `<div class="spin">${st.error ? "The account did not start — see the Logs tab." : "Waiting for the account to attach to the network…"}</div>`;
    return;
  }
  const ns = await api.nodeStatus().catch(() => null);
  if (seq !== parlonsRenderSeq) return;
  if (!ns || !ns.startedTs) { retry("Could not identify the running node. Reload to try again."); return; }
  const key = String(st.panelPort) + ":" + ns.startedTs;   // minimaDesk's exact one-key-per-start model
  if (body.querySelector("webview") && parlonsLoadedFor === key) return;   // already showing this start's session
  const url = await api.parlonsPanelUrl().catch(() => "");
  if (seq !== parlonsRenderSeq) return;
  if (!url) {
    retry(attempt >= 20 ? "Could not get a sign-in link. Reload to try again." : "Getting a sign-in link from the account…");
    if (attempt < 20) parlonsRetry = setTimeout(() => { if (seq === parlonsRenderSeq) renderParlons(attempt + 1); }, 1500);
    return;
  }
  parlonsLoadedFor = key;
  body.innerHTML = "";
  const wv = document.createElement("webview");
  wv.setAttribute("partition", "persist:parlons");
  wv.setAttribute("allowpopups", "false");
  wv.setAttribute("src", url);
  body.appendChild(wv);
}
