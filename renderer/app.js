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
let waitingForNode = false;
let activeView = "balances";
let refreshTimer = null;
let RESTORE = null;          // {seed, keyuses, host} held in memory for a pending restore — NEVER persisted
let postBootStarted = false; // guard: run the post-boot wallet step (new backup / restore resync) once
const ICON_CACHE = new Map();// tokenid → { icon: dataURI|null, valid: bool|null } — survives the 15s refresh
let HIST_SYNCING = false;    // guard against overlapping history syncs
let histOldestOffset = 0;    // how deep "Load older" has paged
// terminal state
let TERM_OUT = "";
const TERM_HIST = [];
let termIdx = -1;
let TERM_CMDS = null;        // command names for Tab-completion (lazy from `help`)
let SEND_TOKENS = [];        // [{tokenid, name, sendable}] for the Send/Split/Consolidate token dropdowns

function tokenOptions() {
  return SEND_TOKENS.map(t => `<option value="${esc(t.tokenid)}">${esc(t.name)}${t.tokenid !== MINIMA ? " · " + short(t.tokenid, 12) : ""}</option>`).join("");
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
function toast(msg, kind) {
  const t = el("toast"); t.className = "toast" + (kind ? " " + kind : ""); t.textContent = msg; t.style.display = "";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, 3200);
}
function copy(text) { try { navigator.clipboard.writeText(text); toast("Copied ✓", "ok"); } catch (e) {} }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function short(s, n) { s = String(s || ""); return s.length > (n || 18) ? s.slice(0, (n || 18)) + "…" : s; }

// ---- theme -----------------------------------------------------------------
// TERMINAL identity: dark default + light toggle. Legacy stored themes (current/original-*) → dark.
const THEMES = ["dark", "light"];
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
}
function cycleTheme() {
  CFG.theme = (CFG.theme === "light") ? "dark" : "light";
  applyTheme(CFG.theme); api.saveConfig({ theme: CFG.theme });
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  CFG = await api.getConfig();
  applyTheme(CFG.theme || "current");
  el("themeBtn").onclick = cycleTheme;
  el("nodePill").onclick = () => selectTab("node");
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => selectTab(b.dataset.view));
  initTabScroll();
  api.appVersion().then(v => { const e = el("hdrVer"); if (e && v) e.textContent = "v" + v; }).catch(() => {});

  api.onStatus(onStatus);
  api.onLog(appendLog);
  api.onMail(onMailUpdate);
  api.onPandapools(onPandapoolsUpdate);
  api.onAtomix(onAtomixUpdate);
  api.onShop(onShopUpdate);
  api.onCasino(onCasinoUpdate);

  // Run onboarding until BOTH the node wizard and the wallet step are done. A stale pre-0.1.1 config can have
  // setupDone:true but walletDone:false (no walletMode/peersUrl) — that must still show the wizard, not skip it.
  if (!CFG.setupDone || !CFG.walletDone) { showSetup(); return; }
  waitingForNode = true;
  const s = await api.nodeStatus();
  onStatus(s);
  if (s.state === "stopped") api.nodeStart();
}

function onStatus(s) {
  const pill = el("nodePill");
  pill.dataset.state = s.state;
  let label = s.state;
  if (s.state === "running" && s.health) label = "● " + (s.health.connections || 0) + " peers"
    + (s.contribute && s.health.incoming ? " · " + s.health.incoming + " in" : "") + " · #" + (s.health.block || 0);
  else if (s.state === "starting") label = "starting…";
  else if (s.state === "error") label = "error";
  pill.textContent = label;

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
  if (activeView === "node") renderNode(s);
}

// ---- first-run wizard: network + wallet presets + the FULL startup-parameter editor ----
// P is the working copy of every non-managed minima.jar flag; the presets and the advanced editor both write
// into it, and it is saved verbatim as config.params. MINIMA_PARAMS is the shared manifest (params.js).
function showSetup() {
  el("shell").style.filter = "blur(2px)";
  const box = el("setupBody");
  const P = Object.assign({}, MINIMA_PARAMS.defaultParams(), CFG.params || {});
  const def = CFG.dataFolder || "";
  // Reopened from the Node tab to look at / tweak an already-working setup → offer a way out. On first run
  // there is nothing to go back TO (boot() forces this wizard until both are done), so no Cancel there.
  const canCancel = !!(CFG.setupDone && CFG.walletDone);
  const title = document.querySelector("#setup .modal__title");
  if (title) title.textContent = canCancel ? "Node settings" : "Set up your node";

  box.innerHTML = `
    <div class="view__desc">${canCancel
      ? "Change how your node starts. Nothing is applied until you press Apply — Cancel discards everything."
      : "Set up your node. Nothing here leaves this Mac. Every minima.jar startup parameter is editable below."}</div>

    <div class="setup-sec"><div class="setup-sec__h">Network</div>
      <label class="opt" data-net="mainnet"><b>Mainnet</b><span>Join the live Minima network — light client, syncs to the tip in seconds.</span></label>
      <label class="opt" data-net="solo"><b>Solo / test</b><span>A private local chain that auto-mines — safe for trying things out.</span></label>
      <label class="opt" data-net="custom"><b>Custom peer</b><span>Connect to a specific host:port you provide.</span></label>
      <input class="field__input" id="customPeer" placeholder="host:port" style="display:none;margin-top:4px" />
      <div class="view__desc" style="font-size:11px;margin-top:4px">A network is a preset — it fills the parameters below; tweak anything you like.</div>
    </div>

    <div class="setup-sec" id="roleSec"><div class="setup-sec__h">Network role</div>
      <label class="opt" data-role="light"><b>Light wallet — recommended</b><span>Connects out only. Fast start, minimal bandwidth.</span></label>
      <label class="opt" data-role="contribute"><b>Contribute to the network</b><span>Your node also accepts connections and helps other nodes sync. Asks your router to open your Minima port (UPnP) and keeps ~50 days of block history — a one-time extra download. Many home routers refuse or silently ignore the request, so this isn't guaranteed; you can always forward the port yourself.</span></label>
    </div>

    <div class="setup-sec" id="walletSec"><div class="setup-sec__h">Wallet</div>
      <label class="opt sel" data-w="new"><b>New wallet</b><span>Generate a fresh seed on this node. You'll back up the 24 words next.</span></label>
      <label class="opt" data-w="restore"><b>Restore from seed</b><span>Import an existing seed — 24 BIP39 words or your own passphrase — and fast-sync via MegaMMR.</span></label>
      <div id="restoreFields" style="display:none">
        <div class="field" style="margin-top:6px"><div class="field__label">Your seed phrase</div>
          <textarea class="field__input" id="rSeed" rows="3" placeholder="24 BIP39 words, or any passphrase"></textarea>
          <div class="prow__h">Any phrase is accepted (anyphrase). Enter it EXACTLY as it was created — it is case- and spacing-sensitive.</div></div>
        <div class="field"><div class="field__label">Signatures already used (key-uses)</div>
          <input class="field__input" id="rKeyuses" value="0" inputmode="numeric" /></div>
        <div class="view__desc" style="color:var(--amber)">⚠ Key-uses must be at least the number of signatures this seed has ever made, on any node. Too low reuses one-time keys and can lose funds — if unsure, set it higher.</div>
        <div class="field"><div class="field__label">MegaMMR host (ip:port, must run -megammr)</div>
          <input class="field__input" id="rHost" value="${esc(CFG.megammrHost)}" /></div>
      </div>
    </div>

    <div class="setup-sec"><div class="setup-sec__h">Core</div>
      <div class="field"><div class="field__label">Data folder (-data / -basefolder)</div>
        <div class="seg"><input class="field__input" id="dataFolder" placeholder="(default app folder)" value="${esc(def)}" readonly />
        <button class="btn btn--outline btn--sm" id="pickFolder">Choose…</button></div></div>
      <div class="field"><div class="field__label">Minima port (-port)</div>
        <input class="field__input" id="basePort" value="${esc(CFG.basePort)}" inputmode="numeric" /></div>
      <div class="field"><div class="field__label">RPC port (-rpc)</div>
        <input class="field__input" id="rpcPort" value="${esc(CFG.rpcPortManual || "")}" placeholder="(auto: Minima port + 4)" inputmode="numeric" /></div>
    </div>

    <div class="setup-sec"><div class="setup-sec__h">All startup parameters</div>
      <div id="advParams"></div>
      <div class="setup-sec__sub" style="margin-top:10px">Additional raw arguments</div>
      <textarea class="field__input" id="extraArgs" rows="2" placeholder="e.g. -myextra value">${esc(CFG.extraArgs || "")}</textarea>
      <div class="prow__h">Appended verbatim. Quotes are respected.</div>
      <div class="setup-sec__sub" style="margin-top:12px">Managed by the app</div>
      ${MINIMA_PARAMS.MANAGED_INFO.map(m => `<div class="prow prow--managed"><span class="prow__l">-${esc(m.flag)}</span><span class="prow__note">${esc(m.note)}</span></div>`).join("")}
    </div>

    ${canCancel
      ? `<div class="seg" style="margin-top:12px">
           <button class="btn btn--outline btn--full" id="setupCancel">Cancel</button>
           <button class="btn btn--primary btn--full" id="startNode">Apply &amp; restart node</button></div>`
      : `<button class="btn btn--primary btn--full" id="startNode" style="margin-top:12px">Start node</button>`}`;

  // ---- advanced params editor (rebuilt from P so presets show through) ----
  function renderAdvanced() {
    el("advParams").innerHTML = MINIMA_PARAMS.GROUPS.map(g => `
      <div class="adv-group"><div class="adv-group__h">${esc(g.group)}</div>
      ${g.items.map(it => paramControl(it, P[it.flag])).join("")}</div>`).join("");
    el("advParams").querySelectorAll("[data-flag]").forEach(inp => {
      const f = inp.dataset.flag;
      if (inp.type === "checkbox") inp.onchange = () => { P[f] = inp.checked; };
      else inp.onchange = () => { P[f] = inp.value; };
    });
  }
  function paramControl(it, val) {
    const id = "p_" + it.flag;
    if (it.type === "bool") {
      return `<label class="prow"><input type="checkbox" id="${id}" data-flag="${esc(it.flag)}" ${val === true ? "checked" : ""}/>
        <span class="prow__l">${esc(it.label)}</span><span class="prow__h">${esc(it.help)}</span></label>`;
    }
    const isSecret = it.type === "secret";
    const shown = isSecret ? "" : (val === true || val == null ? "" : val);
    const ph = isSecret && val === true ? "•••••••• (stored — leave blank to keep)" : "";
    const type = isSecret ? "password" : (it.type === "int" ? "text" : "text");
    return `<div class="field prow"><label class="prow__l" for="${id}">${esc(it.label)}</label>
      <input class="field__input" id="${id}" type="${type}" data-flag="${esc(it.flag)}" ${isSecret ? 'data-secret="1"' : ''} ${isSecret && val === true ? 'data-set="1"' : ''} value="${esc(shown)}" placeholder="${esc(ph)}" ${it.type === "int" ? 'inputmode="numeric"' : ''}/>
      <div class="prow__h">${esc(it.help)}</div></div>`;
  }

  // ---- network preset fills the network-related params in P ----
  let net = CFG.network || "mainnet", wmode = "new", role = CFG.contribute ? "contribute" : "light";
  const walletSec = el("walletSec");
  const applyNet = (n) => {
    net = n;
    if (n === "solo") {
      Object.assign(P, { solo: true, isclient: false, mobile: false, nosyncibd: false, limitbandwidth: false,
        allowallip: false, p2pnodes: "", connect: "" });
    } else {
      Object.assign(P, { solo: false, test: false, genesis: false, allowallip: true });
      // The network-role preset owns the client/server flags (see params.js) — apply it after the network
      // preset so switching network keeps the chosen role.
      Object.assign(P, role === "contribute" ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
      if (n === "custom") { P.connect = el("customPeer").value.trim(); P.p2pnodes = ""; }
      else { P.p2pnodes = CFG.peersUrl || MINIMA_PARAMS.defaultParams().p2pnodes; P.connect = ""; }
    }
    box.querySelectorAll(".opt[data-net]").forEach(x => x.classList.toggle("sel", x.dataset.net === n));
    el("customPeer").style.display = n === "custom" ? "" : "none";
    walletSec.style.display = n === "solo" ? "none" : "";
    el("roleSec").style.display = n === "solo" ? "none" : "";
    renderAdvanced();
  };
  const applyRole = (r) => {
    role = r;
    box.querySelectorAll(".opt[data-role]").forEach(x => x.classList.toggle("sel", x.dataset.role === r));
    if (net !== "solo") {
      Object.assign(P, r === "contribute" ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
      renderAdvanced();
    }
  };
  const selectW = (w) => {
    wmode = w;
    box.querySelectorAll(".opt[data-w]").forEach(x => x.classList.toggle("sel", x.dataset.w === w));
    el("restoreFields").style.display = w === "restore" ? "" : "none";
  };
  box.querySelectorAll(".opt[data-net]").forEach(o => o.onclick = () => applyNet(o.dataset.net));
  box.querySelectorAll(".opt[data-role]").forEach(o => o.onclick = () => applyRole(o.dataset.role));
  box.querySelectorAll(".opt[data-w]").forEach(o => o.onclick = () => selectW(o.dataset.w));
  if (CFG.customConnect) el("customPeer").value = CFG.customConnect;
  el("customPeer").oninput = () => { if (net === "custom") P.connect = el("customPeer").value.trim(); };
  el("pickFolder").onclick = async () => { const f = await api.pickFolder(); if (f) el("dataFolder").value = f; };
  // Cancel is a pure discard: P is a local working copy and nothing is written outside startNode's handler,
  // so closing the overlay leaves the config and the running node untouched.
  const setupCancel = el("setupCancel");
  if (setupCancel) setupCancel.onclick = () => hideSetup();
  renderAdvanced();
  applyNet(net); applyRole(role); selectW("new");   // seed P from the network + role presets, show in editor

  el("startNode").onclick = async () => {
    const basePort = parseInt(el("basePort").value, 10) || CFG.basePort;
    const rpcPortManual = el("rpcPort").value.trim();
    if (net === "custom" && !el("customPeer").value.trim()) { toast("Enter a host:port for the custom peer."); return; }
    const solo = net === "solo";
    const walletMode = solo ? "new" : wmode;
    let host = CFG.megammrHost;

    // A restore holds the seed + key-uses in memory only — applied by megammrsync after the node is up.
    if (walletMode === "restore") {
      // anyphrase:true → the node hashes the phrase VERBATIM (seed = SHA(raw bytes)), so pass it faithfully:
      // strip only leading/trailing whitespace (the textarea's stray newline), never collapse internal spacing
      // or change case — that would derive a DIFFERENT seed. Any non-empty phrase/length is valid.
      const seed = el("rSeed").value.trim();
      const keyuses = parseInt(el("rKeyuses").value, 10);
      host = el("rHost").value.trim() || CFG.megammrHost;
      if (!seed) { toast("Enter your seed phrase."); return; }
      if (/["\\]/.test(seed)) { toast("This seed contains a \" or \\ the restore can't carry safely. Remove it or restore via the node terminal.", "err"); return; }
      if (/[\n\r\t]/.test(seed)) { toast("Remove the line breaks/tabs — enter your seed as one clean line (they change the derived wallet).", "err"); return; }
      if (!/^[\w.\-]+:\d+$/.test(host)) { toast("MegaMMR host must be ip:port.", "err"); return; }
      if (isNaN(keyuses) || keyuses < 0) { toast("Enter the key-uses count (0 if brand new)."); return; }
      RESTORE = { seed, keyuses, host };
    }

    // collect every advanced control into P (secret: blank + previously-set → keep marker)
    el("advParams").querySelectorAll("[data-flag]").forEach(inp => {
      const f = inp.dataset.flag;
      if (inp.type === "checkbox") { P[f] = inp.checked; return; }
      const v = inp.value.trim();
      if (inp.dataset.secret) P[f] = v ? v : (inp.dataset.set ? true : "");
      else P[f] = v;
    });

    const walletDone = solo ? true : (walletMode === "restore" ? false : !!CFG.walletDone);
    const patch = {
      setupDone: true, network: net, basePort, rpcPortManual, walletMode, walletDone,
      contribute: role === "contribute" && !solo,
      dataFolder: el("dataFolder").value || "",
      customConnect: net === "custom" ? el("customPeer").value.trim() : "",
      megammrHost: host, params: P, extraArgs: el("extraArgs").value.trim()
    };
    CFG = await api.saveConfig(patch);
    waitingForNode = true;
    postBootStarted = false;      // let the post-boot wallet step run for this (re)start
    showStarting();
    if (running) await api.nodeRestart(); else await api.nodeStart();   // reconfigure = restart to apply
  };
  el("setup").style.display = "";
}
function hideSetup() { el("setup").style.display = "none"; el("shell").style.filter = ""; }

// ---- starting / progress overlay -------------------------------------------
function showStarting() {
  const restore = CFG.walletMode === "restore";
  el("setupBody").innerHTML = `
    <div class="setup-progress">
      <div class="spin spin--lg"></div>
      <div class="setup-progress__title" id="startTitle">Starting your node…</div>
      <div class="view__desc" id="startSub">${restore
        ? "Booting a light client on " + esc(CFG.network) + ", then fast-syncing your seed via MegaMMR."
        : "Booting a light client and connecting to the " + esc(CFG.network) + " network."}</div>
      <div class="setup-progress__stat" id="startStat">connecting…</div>
    </div>`;
}
function updateSetupProgress(s) {
  const stat = el("startStat"); if (!stat) return;
  if (s.state === "starting") stat.textContent = "connecting…";
  else if (s.state === "running" && s.health) stat.textContent = "● " + (s.health.connections || 0) + " peers · block #" + (s.health.block || 0);
  else if (s.state === "error") { stat.textContent = "⚠ " + (s.lastError || "node error"); stat.style.color = "var(--red)"; }
}

// ---- post-boot wallet step (runs once the node is running) -----------------
function seedFrom(v) { return v && (v.phrase || v.seedphrase || v.seed || v.mnemonic) || ""; }
function runPostBoot() { if (RESTORE) postBootRestore(); else postBootNewSeed(); }

// NEW wallet: reveal the fresh seed for backup, then done — NO resync (a new node just follows the tip).
function postBootNewSeed() {
  el("setupBody").innerHTML = `
    <div class="view__desc">Your node is live. Back up the seed that controls your funds — it never leaves this Mac and is the only way to recover your wallet.</div>
    <button class="btn btn--outline btn--full" id="revealSeed">Reveal my 24-word seed</button>
    <div class="addrbox" id="seedBox" style="display:none;white-space:normal;line-height:1.6;letter-spacing:.3px"></div>
    <label class="opt" id="seedAck" style="display:none"><input type="checkbox"/> <span style="margin:0;color:var(--text)">I've written down my 24 words and stored them safely.</span></label>
    <button class="btn btn--primary btn--full" id="newGo" style="display:none">Open my wallet</button>`;
  el("revealSeed").onclick = async () => {
    const v = await tryCmd("vault");
    const phrase = seedFrom(v);
    if (!phrase) { toast("Couldn't read the seed yet — give the node a moment.", "err"); return; }
    el("seedBox").style.display = ""; el("seedBox").textContent = phrase;
    el("seedAck").style.display = ""; el("newGo").style.display = "";
  };
  el("newGo").onclick = async () => {
    if (!el("seedAck").querySelector("input").checked) { toast("Tick the box once you've backed up your seed."); return; }
    CFG = await api.saveConfig({ walletDone: true });
    hideSetup(); renderActive(); toast("Wallet ready ✓", "ok");
  };
  el("setup").style.display = "";
}

// RESTORE: node is up — apply the held seed via megammrsync, then done.
async function postBootRestore() {
  const { seed, keyuses, host } = RESTORE;
  el("setupBody").innerHTML = `
    <div class="setup-progress">
      <div class="spin spin--lg"></div>
      <div class="setup-progress__title">Restoring your wallet…</div>
      <div class="view__desc">Fast-syncing your seed via MegaMMR (${esc(host)}). This usually takes seconds.</div>
      <div class="setup-progress__stat" id="rStat">resyncing…</div>
    </div>`;
  el("setup").style.display = "";
  try {
    await cmd(`megammrsync action:resync host:${host} phrase:"${seed}" anyphrase:true keyuses:${keyuses}`);
    RESTORE = null;   // clear the seed from memory
    try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState(); try { await api.axInvalidate(); } catch (e) {} resetAxState(); try { await api.casinoInvalidate(); } catch (e) {} resetCasinoState();   // seed changed → re-derive the mail identity
    CFG = await api.saveConfig({ walletDone: true, megammrHost: host });
    hideSetup(); renderActive(); toast("Wallet restored ✓", "ok");
  } catch (e) {
    const st = el("rStat"); if (st) { st.textContent = "⚠ " + e.message; st.style.color = "var(--red)"; }
    el("setupBody").insertAdjacentHTML("beforeend",
      `<button class="btn btn--primary btn--full" id="rRetry" style="margin-top:10px">Retry</button>`);
    el("rRetry").onclick = () => postBootRestore();
  }
}

// Restore a DIFFERENT seed on an already-running node (from Settings) — same megammrsync, done inline.
function showRestoreOverlay() {
  el("shell").style.filter = "blur(2px)";
  el("setupBody").innerHTML = `
    <div class="view__desc">Restore a different seed on this node — 24 BIP39 words or your own passphrase. The current wallet will be replaced by the restored one.</div>
    <div class="field"><div class="field__label">Your seed phrase</div>
      <textarea class="field__input" id="orSeed" rows="3" placeholder="24 BIP39 words, or any passphrase"></textarea>
      <div class="prow__h">Any phrase is accepted (anyphrase). Enter it EXACTLY as created — case- and spacing-sensitive.</div></div>
    <div class="field"><div class="field__label">Signatures already used (key-uses)</div>
      <input class="field__input" id="orKeyuses" value="0" inputmode="numeric" /></div>
    <div class="view__desc" style="color:var(--amber)">⚠ Key-uses must be at least the number of signatures this seed has ever made, on any node. Too low reuses one-time keys and can lose funds — if unsure, set it higher.</div>
    <div class="field"><div class="field__label">MegaMMR host (ip:port, must run -megammr)</div>
      <input class="field__input" id="orHost" value="${esc(CFG.megammrHost)}" /></div>
    <div class="seg"><button class="btn btn--outline btn--full" id="orCancel">Cancel</button>
      <button class="btn btn--primary btn--full" id="orGo">Restore + sync</button></div>`;
  el("orCancel").onclick = () => { hideSetup(); };
  el("orGo").onclick = async () => {
    const seed = el("orSeed").value.trim();   // anyphrase: pass verbatim (see restore in showSetup)
    const keyuses = parseInt(el("orKeyuses").value, 10);
    const host = el("orHost").value.trim() || CFG.megammrHost;
    if (!seed) { toast("Enter your seed phrase."); return; }
    if (/["\\]/.test(seed)) { toast("This seed contains a \" or \\ the restore can't carry safely. Remove it or restore via the node terminal.", "err"); return; }
    if (/[\n\r\t]/.test(seed)) { toast("Remove the line breaks/tabs — enter your seed as one clean line (they change the derived wallet).", "err"); return; }
    if (!/^[\w.\-]+:\d+$/.test(host)) { toast("MegaMMR host must be ip:port.", "err"); return; }
    if (isNaN(keyuses) || keyuses < 0) { toast("Enter the key-uses count (0 if brand new)."); return; }
    el("orGo").disabled = true; el("orGo").textContent = "Restoring…";
    try {
      await cmd(`megammrsync action:resync host:${host} phrase:"${seed}" anyphrase:true keyuses:${keyuses}`);
      try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState(); try { await api.axInvalidate(); } catch (e) {} resetAxState(); try { await api.casinoInvalidate(); } catch (e) {} resetCasinoState();   // seed changed → re-derive the mail identity
      CFG = await api.saveConfig({ megammrHost: host });
      hideSetup(); renderActive(); toast("Wallet restored ✓", "ok");
    } catch (e) { toast("Restore failed: " + e.message, "err"); el("orGo").disabled = false; el("orGo").textContent = "Restore + sync"; }
  };
  el("setup").style.display = "";
}

// ---- tabs / refresh --------------------------------------------------------
function selectTab(view) {
  activeView = view;
  const active = document.querySelector('.tab[data-view="' + view + '"]');
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("tab--active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("view--active", v.id === "view-" + view));
  positionTabInk();
  // Bring the active tab into view when the row is scrolled (block:nearest so the page never scrolls).
  if (active) { try { active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); } catch (e) { active.scrollIntoView(); } setTimeout(updateTabScroll, 250); }
  renderActive();
}

// ---- narrow-width tab scrolling: fades + arrow chips + wheel, since all 10 tabs can overflow at 440px ----
function updateTabScroll() {
  const tabs = el("tabs"), wrap = el("tabsWrap");
  if (!tabs || !wrap) return;
  const max = tabs.scrollWidth - tabs.clientWidth;
  wrap.classList.toggle("can-l", tabs.scrollLeft > 1);
  wrap.classList.toggle("can-r", tabs.scrollLeft < max - 1);
  el("tabsArrowL").hidden = !wrap.classList.contains("can-l");
  el("tabsArrowR").hidden = !wrap.classList.contains("can-r");
  positionTabInk();
}
// Sliding orange underline that tracks the active tab in the horizontal strip. In the wide
// nav-rail (>=900px) the active marker is a CSS inset-shadow bar instead, so the ink hides.
function positionTabInk() {
  const tabs = el("tabs");
  if (!tabs) return;
  const ink = tabs.querySelector(".tab-ink");
  if (!ink) return;
  const active = tabs.querySelector(".tab--active");
  if (!active || (window.matchMedia && window.matchMedia("(min-width: 900px)").matches)) {
    ink.style.opacity = "0";
    return;
  }
  ink.style.opacity = "1";
  ink.style.width = active.offsetWidth + "px";
  ink.style.transform = "translateX(" + active.offsetLeft + "px)";
}
function initTabScroll() {
  const tabs = el("tabs");
  if (!tabs) return;
  if (!tabs.querySelector(".tab-ink")) {
    const ink = document.createElement("div");
    ink.className = "tab-ink";
    tabs.appendChild(ink);
  }
  const by = () => Math.max(120, Math.round(tabs.clientWidth * 0.7));
  el("tabsArrowL").onclick = () => tabs.scrollBy({ left: -by(), behavior: "smooth" });
  el("tabsArrowR").onclick = () => tabs.scrollBy({ left: by(), behavior: "smooth" });
  // Vertical mouse-wheel → horizontal scroll (trackpads already scroll sideways; this covers a plain wheel).
  tabs.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollLeft += e.deltaY; e.preventDefault();
    }
  }, { passive: false });
  tabs.addEventListener("scroll", updateTabScroll, { passive: true });
  window.addEventListener("resize", updateTabScroll);
  updateTabScroll();
  // Manrope/Geist load async → tab widths change after first paint; reposition the ink once they settle.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionTabInk);
}
function renderActive() {
  if (!running && activeView !== "node") { /* wallet views need the node */ }
  if (activeView === "balances") renderBalances();
  else if (activeView === "receive") renderReceive();
  else if (activeView === "send") renderSend();
  else if (activeView === "mail") renderMail();
  else if (activeView === "pandapools") renderPandapools();
  else if (activeView === "atomix") renderAtomix();
  else if (activeView === "minimall") renderMiniMall();
  else if (activeView === "casino") renderCasino();
  else if (activeView === "history") renderHistory();
  else if (activeView === "terminal") renderTerminal();
  else if (activeView === "logs") renderLogs();
  else if (activeView === "settings") renderSettings();
  else if (activeView === "node") api.nodeStatus().then(renderNode);
}
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => { if (running && (activeView === "balances")) renderBalances(); }, 15000);
}
function stopRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

// ---- Balances --------------------------------------------------------------
async function renderBalances() {
  const host = el("balList");
  if (!running) { host.innerHTML = `<div class="spin">Waiting for the node…</div>`; return; }
  const bal = await tryCmd("balance");
  if (!bal || !bal.length) { host.innerHTML = `<div class="card"><div class="view__desc">No coins yet. Your balance appears here once the node has synced and you hold MINIMA or tokens.</div></div>`; return; }
  BAL_BY_TID = {};
  for (const b of bal) BAL_BY_TID[b.tokenid || MINIMA] = b;
  // Consolidate only merges SPENDABLE coins (a send-to-self of signable coins) — locked/watch-only UTXOs
  // can't be touched. balance.coins counts them all, so gate the nudge on the sendable count instead: one
  // query, grouped by token. (Minima e.g. can show 14 total coins but only 5 spendable.)
  SENDABLE_COUNT = {};
  try {
    const sc = await tryCmd("coins relevant:true sendable:true") || [];
    for (const c of sc) { const t = c.tokenid || MINIMA; SENDABLE_COUNT[t] = (SENDABLE_COUNT[t] || 0) + 1; }
  } catch (e) { /* nudge just won't show if we can't count — safe default */ }
  host.innerHTML = bal.map(balCardHtml).join("");
  host.querySelectorAll(".consolidate-btn").forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();                                 // don't also open the detail modal
    const tid = btn.dataset.tokenid;
    if (!validTok(tid)) return;
    btn.disabled = true; btn.textContent = "Consolidating…";
    try { await cmd(`consolidate tokenid:${tid}`); toast("Consolidation submitted ✓ — coins merge over the next blocks.", "ok"); }
    catch (e2) { toast("Consolidate failed: " + e2.message, "err"); btn.disabled = false; }
  });
  // Whole card opens the rich token-detail modal (the consolidate button stops propagation above).
  host.querySelectorAll(".card[data-tokenid]").forEach(card => card.onclick = () => {
    const b = BAL_BY_TID[card.dataset.tokenid];
    if (b) showTokenDetail(b);
  });
  enhanceTokenIcons(host);
}
let BAL_BY_TID = {};       // tokenid → last balance row, so a card click can open the modal without refetching
let SENDABLE_COUNT = {};   // tokenid → count of SPENDABLE coins (what consolidate can actually merge)

/** Is this balance row a 1-of-1 NFT? (non-Minima, total supply 1, no fractional decimals) */
function isNftBal(b) {
  return b.tokenid && b.tokenid !== MINIMA && String(b.total) === "1"
    && (!b.token || !b.token.decimals || String(b.token.decimals) === "0");
}

// One balance card: token icon (identicon → real icon over) + name + amounts + coin count + consolidate nudge.
function balCardHtml(b) {
  const isNative = b.tokenid === MINIMA || !b.tokenid;
  const name = TOK.tokenName(b.token, b.tokenid);
  const coins = parseInt(b.coins, 10) || 0;
  const cached = ICON_CACHE.get(b.tokenid);
  let iconCell;
  if (isNative) {
    iconCell = `<span class="tok-wrap"><img class="tok-icon tok-icon--native" src="minima-mark.svg" alt=""><span class="tok-badge">✓</span></span>`;
  } else {
    const identicon = TOK.identiconDataUri(b.tokenid);
    const res = TOK.resolveIcon(TOK.pickIconField(b.token));
    const src = (cached && cached.icon) || res.data || identicon;
    const showBadge = cached && cached.valid;
    iconCell = `<span class="tok-wrap" data-tokenid="${esc(b.tokenid)}" data-identicon="${esc(identicon)}"`
      + (res.data ? ` data-icon-data="${esc(res.data)}"` : "")
      + (res.remote ? ` data-icon-remote="${esc(res.remote)}"` : "")
      + (TOK.webvalidateUrl(b.token) ? ` data-webv="1"` : "")
      + `><img class="tok-icon" src="${esc(src)}" alt=""><span class="tok-badge"${showBadge ? "" : " hidden"}>✓</span></span>`;
  }
  // Nudge on SPENDABLE coins only — consolidate can't merge locked ones, so counting them would offer to
  // consolidate coins that can't be touched (e.g. 14 total but 5 spendable → no useful consolidation).
  const spendCoins = SENDABLE_COUNT[b.tokenid || MINIMA] || 0;
  const nudge = spendCoins >= 10
    ? `<button class="btn btn--sm btn--outline consolidate-btn" data-tokenid="${esc(b.tokenid)}" style="margin-top:8px;width:100%">Consolidate ▸ ${spendCoins} spendable coins into fewer</button>`
    : "";
  // Headline = SENDABLE — what the user can actually spend. `confirmed` (total incl. coins locked in
  // scripts/pools) was misleading: it made a $2-spendable wallet read as $600. Locked = confirmed − sendable,
  // shown as a small muted line only when there is a locked portion.
  const sendable = b.sendable || "0", confirmed = b.confirmed || "0";   // balance.java always emits both; guard so a malformed row can't blank the whole list
  const locked = decSub(confirmed, sendable);
  const nft = isNftBal(b);
  const sub = nft ? "Spendable · NFT" : "Spendable";
  const meta = [];
  if (locked !== "0") meta.push(`🔒 ${esc(TOK.tidyAmount(locked))} locked`);
  if (coins) meta.push(`${coins} coin${coins === 1 ? "" : "s"}`);
  return `<div class="card card--token" data-tokenid="${esc(b.tokenid || MINIMA)}">
    <div class="kv"><span class="kv__k">${iconCell}${esc(name)}</span><span class="kv__v">${esc(TOK.tidyAmount(sendable))}</span></div>
    <div class="kv bal-sub"><span class="kv__k">${sub}</span><span class="kv__v">${esc(TOK.ticker(b.token) || "")}</span></div>
    ${meta.length ? `<div class="bal-meta">${meta.join(" · ")}</div>` : ""}
    ${b.unconfirmed && b.unconfirmed !== "0" ? `<div class="kv"><span class="kv__k">pending</span><span class="kv__v kv__v--amber">${esc(TOK.tidyAmount(b.unconfirmed))}</span></div>` : ""}
    ${nudge}
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
    ${coins ? `<div class="view__sub tokd-coins-hdr" id="tokdCoinsHdr">▸ Coins (${coins})</div><div id="tokdCoins" hidden></div>` : ""}
    <div class="seg" style="margin-top:12px">
      <button class="btn btn--outline btn--full" id="tokdReceive">Receive</button>
      <button class="btn btn--primary btn--full" id="tokdSend">Send ${esc(tick || name)}</button>
    </div>
    <button class="btn btn--outline btn--full" id="tokdClose" style="margin-top:8px">Close</button>
  </div></div>`);

  const close = () => { const o = el("tokDetail"); if (o) o.remove(); };
  el("tokdClose").onclick = close;
  el("tokDetail").onclick = (e) => { if (e.target.id === "tokDetail") close(); };
  el("tokdId").onclick = () => copy(tid);
  el("tokdReceive").onclick = () => { close(); selectTab("receive"); };
  el("tokdSend").onclick = () => { close(); SEND_PRESELECT = tid; selectTab("send"); };
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

  // Per-coin list — lazy on first expand (coins has no count-cap; keep the modal light).
  if (coins) {
    let loaded = false;
    el("tokdCoinsHdr").onclick = async () => {
      const box = el("tokdCoins"), hdr = el("tokdCoinsHdr");
      const open = box.hidden;
      box.hidden = !open;
      hdr.textContent = (open ? "▾" : "▸") + ` Coins (${coins})`;
      if (open && !loaded) { loaded = true; await loadCoinList(tid, isNative, box); }
    };
  }
}

const COIN_LIST_CAP = 50;   // most coins shown in the modal; more get a "+N more" footer

async function loadCoinList(tid, isNative, box) {
  if (!validTok(tid)) { box.innerHTML = `<div class="view__desc">Invalid token id.</div>`; return; }   // tid is node-sourced, but never interpolate an unvalidated value into a command
  box.innerHTML = `<div class="spin spin--sm">Loading coins…</div>`;
  try {
    const all = await cmd(`coins relevant:true tokenid:${tid} order:desc`) || [];
    // Which coinids are spendable — the node's own sendable gate (isAddressSimple + RETURN TRUE).
    let sendableIds = new Set();
    try { const s = await cmd(`coins relevant:true sendable:true tokenid:${tid}`) || []; for (const c of s) sendableIds.add(c.coinid); } catch (e) {}
    if (!all.length) { box.innerHTML = `<div class="view__desc">No coins.</div>`; return; }
    const shown = all.slice(0, COIN_LIST_CAP);
    box.innerHTML = shown.map(c => {
      const amt = TOK.tidyAmount(isNative ? (c.amount || "0") : (c.tokenamount || c.amount || "0"));
      const spend = sendableIds.has(c.coinid);
      const cid = String(c.coinid || "");
      const tail = cid.length > 14 ? "…" + cid.slice(-12) : cid;
      const bits = [];
      if (c.created) bits.push("block " + esc(String(c.created)));
      if (c.age != null) bits.push("age " + esc(String(c.age)));
      return `<div class="coin-row" data-cid="${esc(cid)}" title="click to copy coin id">
        <div class="coin-row__top"><span class="coin-amt">${esc(amt)}</span>
          <span class="chip ${spend ? "chip--spend" : "chip--lock"}">${spend ? "spendable" : "🔒 locked"}</span></div>
        <div class="coin-row__sub">${esc(tail)}${bits.length ? " · " + bits.join(" · ") : ""}</div>
      </div>`;
    }).join("") + (all.length > shown.length ? `<div class="view__desc">+ ${all.length - shown.length} more coin${all.length - shown.length === 1 ? "" : "s"} not shown</div>` : "");
    box.querySelectorAll(".coin-row[data-cid]").forEach(r => r.onclick = () => copy(r.dataset.cid));
  } catch (e) {
    box.innerHTML = `<div class="view__desc">Couldn't load coins: ${esc(e.message || String(e))}</div>`;
  }
}

// ---- Receive ---------------------------------------------------------------
async function renderReceive() {
  const addrEl = el("recvAddr");
  if (!running) { addrEl.textContent = "waiting for node…"; return; }
  const r = await tryCmd("getaddress");
  setRecv((r && (r.miniaddress || r.address)) || "unavailable");
  el("newAddrBtn").onclick = async () => { const n = await tryCmd("newaddress"); if (n) { setRecv(n.miniaddress || n.address); toast("New address ✓", "ok"); } };
}
function setRecv(addr) {
  const addrEl = el("recvAddr");
  addrEl.textContent = addr; addrEl.onclick = () => copy(addr);
  drawQR(addr);
  renderRecvLabel(addr);
}
function renderRecvLabel(addr) {
  const btn = el("newAddrBtn");
  let box = el("recvLabelBox");
  if (!box) { box = document.createElement("div"); box.id = "recvLabelBox"; box.style.marginTop = "10px"; btn.parentNode.insertBefore(box, btn); }
  box.innerHTML = `<div class="field__label">Label this address (optional)</div>
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
  try { const qr = qrcode(0, "M"); qr.addData(text); qr.make(); host.innerHTML = qr.createImgTag(5, 6); }
  catch (e) { /* address too long for one QR — the copyable text still works */ }
}

// ---- minimaMail (on-chain encrypted messaging) -----------------------------
let MAIL_ID = null;         // { publicId, name, payaddr }
let MAIL_CONTACTS = [];
let MAIL_VERSION = null;    // app version, for the banner (fetched once)
let mailView = "inbox";     // inbox | thread | new | contacts | identity | archived
let mailPeer = null;        // other party's publicId
const MAIL_EMOJIS = ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","😐","😑","😶","😏","😒","🙄","😬","😌","😔","😪","🤤","😴","😷","🤒","🤕","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","👍","👎","👌","🤝","🙏","👋","💪","👏","🙌","🤙","✌️","🤞","❤️","🧡","💛","💚","💙","💜","🖤","🤍","💯","🔥","✨","⭐","🎉","🎊","🚀","⚡","💰","💸","💎","✅","❌","❓","❗","💬","📩","📤","📥","☕","🍺","🍻","🌍","🎁","👀","😈","🤖","🫶"];

// After a seed restore/resync the main-process mail identity is invalidated (api.mailInvalidate). The renderer must
// drop its cached identity too, or renderMail() (gated on !MAIL_ID) keeps showing the OLD seed's id + pay address —
// a correspondent could then pay an address the restored wallet no longer controls. Call this alongside every
// api.mailInvalidate().
function resetMailState() { MAIL_ID = null; MAIL_CONTACTS = []; mailView = "inbox"; mailPeer = null; }
function resetPpState() { ppView = "swap"; PP_POOLS = []; PP_MINE = []; PP_SWAP_TOKS = []; ppSwapMinToTok = true; }

function mailAvatar(publicId) { return TOK.identiconDataUri(String(publicId || "0x0").slice(0, 18)); }
function mailShort(id) { id = String(id || ""); return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }
function mailName(id) {
  if (MAIL_ID && id === MAIL_ID.publicId) return "You";
  const c = MAIL_CONTACTS.find(x => x.publicId === id);
  return (c && c.username) || mailShort(id);
}
/** A real Minima receiving address (0x + exactly 64 hex, or Mx… base58) — rejects a 130-hex Mail key AND enforces
 *  the Mx charset (a length-only check let "Mx… address:0x<attacker>" through → command-arg injection). Mirrors main. */
function looksLikeMinimaAddress(a) {
  a = String(a || "").trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}
async function refreshMailBadge() {
  try { const th = await api.mailThreads(); const n = th.reduce((s, t) => s + (t.unread || 0), 0);
    const b = el("mailBadge"); if (b) { b.textContent = n > 99 ? "99+" : String(n); b.hidden = n === 0; } } catch (e) {}
}
async function renderMail() {
  const host = el("mailBody");
  if (!running) { host.innerHTML = `<div class="view__title">minimaMail</div><div class="spin">Waiting for the node…</div>`; return; }
  if (!MAIL_ID) {
    host.innerHTML = `<div class="view__title">minimaMail</div><div class="spin">Setting up your encrypted mail identity…</div>`;
    try { MAIL_ID = await api.mailInit(); }
    catch (e) { host.innerHTML = `<div class="view__title">minimaMail</div><div class="card"><div class="view__desc">Couldn't set up mail: ${esc(e.message)}. Make sure the wallet is unlocked, then reopen this tab.</div></div>`; return; }
  }
  MAIL_CONTACTS = await api.mailContacts().catch(() => []);
  renderMailCurrent();
}
function renderMailCurrent() {
  if (mailView === "thread") return renderMailThread();
  if (mailView === "new") return renderMailNew();
  if (mailView === "contacts") return renderMailContacts();
  if (mailView === "identity") return renderMailIdentity();
  if (mailView === "archived") return renderMailArchived();
  return renderMailInbox();
}

// ---- small reusable dialogs (action sheet / prompt / confirm) --------------
function showActionSheet(title, items) {
  const rows = items.map((it, i) => `<button class="btn ${it.danger ? "btn--danger" : "btn--outline"} btn--full" data-i="${i}" style="margin-top:6px">${esc(it.label)}</button>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="sheetOv"><div class="modal">
    <div class="modal__title">${esc(title)}</div>${rows}
    <button class="btn btn--outline btn--full" id="sheetCancel" style="margin-top:12px">Cancel</button></div></div>`);
  const ov = el("sheetOv"); const close = () => { if (ov) ov.remove(); };
  ov.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => { close(); const it = items[parseInt(b.dataset.i, 10)]; if (it && it.onclick) it.onclick(); });
  el("sheetCancel").onclick = close;
  ov.onclick = (e) => { if (e.target.id === "sheetOv") close(); };
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
      <div class="modal__title">${esc(title)}</div><div class="view__desc" style="white-space:pre-wrap">${esc(message || "")}</div>
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
// Live scan-loop updates arrive as a stream of `mail:update` pushes. NEVER rebuild the active sub-view from one:
// that would wipe the compose input / add-contact form the user is typing into and steal focus every ~10s (the
// "frozen tab" bug). Coalesce bursts, always refresh the badge, and only patch PASSIVE lists in place — the inbox
// list and an open thread's bubbles. The New / Contacts / Identity forms are left completely untouched.
let mailUpdateTimer = null;
function onMailUpdate() {
  if (mailUpdateTimer) return;
  mailUpdateTimer = setTimeout(() => { mailUpdateTimer = null; applyMailUpdate(); }, 350);
}
function applyMailUpdate() {
  refreshMailBadge();
  if (activeView !== "mail" || !MAIL_ID) return;
  if (mailView === "inbox") refreshMailInboxList().catch(() => {});
  else if (mailView === "thread") refreshMailConv().catch(() => {});
  // new | contacts | identity: form left intact — never re-render out from under the user.
}
async function refreshMailInboxList() {
  if (!el("mailList")) return;                        // not on the inbox layout → nothing to patch
  const th = await api.mailThreads().catch(() => []);
  const list = el("mailList"); if (!list) return;     // re-fetch after the await — the view may have changed under us
  const sy = list.scrollTop;                          // preserve scroll — a live update shouldn't yank the reader to the top
  list.innerHTML = th.length ? th.map(mailThreadRowHtml).join("")
    : `<div class="empty">No messages yet. Tap <b>New</b> to start a conversation — share your Identity so others can message you.</div>`;
  wireThreadRows(list, false);
  list.scrollTop = sy;
}
async function refreshMailConv() {
  if (!el("mailConv") || !mailPeer) return;                      // not on a thread → nothing to patch
  const msgs = await api.mailThreadWith(mailPeer).catch(() => null);
  const conv = el("mailConv");                                   // re-fetch after the await
  if (!msgs || !conv) return;
  const atBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 60;
  const sy = conv.scrollTop;                                     // preserve scroll unless the reader is already at the end
  conv.innerHTML = renderConvHtml(msgs);
  conv.scrollTop = atBottom ? conv.scrollHeight : sy;
}
function mailHeader(title, backTo, opts) {
  opts = opts || {};
  const inbox = backTo == null;
  const right = inbox
    ? `<button class="btn btn--sm btn--outline" id="mailNew">New</button>
       <button class="btn btn--sm btn--outline" id="mailContactsBtn">Contacts</button>
       <button class="btn btn--sm btn--outline" id="mailIdBtn">Identity</button>
       <button class="btn btn--sm btn--outline" id="mailMenuBtn" title="More">⋮</button>`
    : (opts.menuId ? `<button class="btn btn--sm btn--outline" id="${opts.menuId}" title="Options">⋮</button>` : "");
  return `<div class="mail-top">
    ${!inbox ? `<button class="btn btn--sm btn--outline" id="mailBack">‹ Back</button>` : ""}
    <div class="mail-top__title">${esc(title)}</div><div class="hdr__spacer"></div>
    ${right}</div>`;
}
function wireMailHeader(backTo) {
  if (el("mailBack")) el("mailBack").onclick = () => { mailView = backTo; renderMailCurrent(); };
  if (el("mailNew")) el("mailNew").onclick = () => { mailView = "new"; mailPeer = null; renderMailCurrent(); };
  if (el("mailContactsBtn")) el("mailContactsBtn").onclick = () => { mailView = "contacts"; renderMailCurrent(); };
  if (el("mailIdBtn")) el("mailIdBtn").onclick = () => { mailView = "identity"; renderMailCurrent(); };
  if (el("mailMenuBtn")) el("mailMenuBtn").onclick = () => showActionSheet("minimaMail", [
    { label: "🗄 Archived chats", onclick: () => { mailView = "archived"; renderMailCurrent(); } },
    { label: "ℹ️ How minimaMail works", onclick: showMailHelp },
  ]);
}
function showMailHelp() {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="mhOv"><div class="modal">
    <div class="modal__title">About minimaMail</div>
    <div class="view__desc" style="white-space:pre-wrap">End-to-end encrypted messages that live on the Minima chain — no server, no Maxima.

• Your identity is derived from your node's seed, so it's the same on every device that restores the same seed.
• Each message is a tiny 0.000000001 Minima coin carrying a sealed, signed blob only the recipient can open.
• You can send funds right inside a chat, and back up your identity + history with a passphrase.

It does NOT interoperate with the web ChainMail / Maxima MiniDapp — it's its own on-chain network.</div>
    <button class="btn btn--outline btn--full" id="mhClose" style="margin-top:12px">Close</button></div></div>`);
  const ov = el("mhOv"); const close = () => { if (ov) ov.remove(); };
  el("mhClose").onclick = close; ov.onclick = (e) => { if (e.target.id === "mhOv") close(); };
}
async function renderMailInbox() {
  const host = el("mailBody");
  const th = await api.mailThreads().catch(() => []);
  if (MAIL_VERSION == null) MAIL_VERSION = await api.appVersion().catch(() => "");
  host.innerHTML = `<div class="view__title">minimaMail${MAIL_VERSION ? ` <span class="mail-ver">v${esc(MAIL_VERSION)}</span>` : ""}</div>${mailHeader("Inbox", null)}
    <div id="mailList">${th.length ? th.map(mailThreadRowHtml).join("") : `<div class="empty">No messages yet. Tap <b>New</b> to start a conversation — share your Identity so others can message you.</div>`}</div>`;
  wireMailHeader(null);
  wireThreadRows(host, false);
  refreshMailBadge();
}
function mailThreadRowHtml(t) {
  const m = t.last || {};
  const peer = t.other || (m.incoming ? m.frompublickey : m.topublickey);
  const preview = (m.incoming ? "" : "You: ") + (m.type === "image" ? "📷 Image" : m.type === "payment" ? ("💰 " + TOK.tidyAmount(m.amount || "") + " " + (m.tokenname || "Minima")) : (m.message || ""));
  return `<div class="row mail-thread" data-peer="${esc(peer)}" data-hashref="${esc(t.hashref || "")}" style="cursor:pointer" title="Right-click for options">
    <img class="mail-av" src="${esc(mailAvatar(peer))}" alt="">
    <div class="row__mid"><div class="row__l1">${esc(mailName(peer))}${t.unread ? ` <span class="mail-dot"></span>` : ""}</div>
      <div class="row__l2">${esc(short(preview, 48))}</div></div>
    <div class="row__r">${esc(relTime(m.date))}</div></div>`;
}
// Shared row wiring: left-click opens the thread, right-click opens the archive/rename/delete menu.
function wireThreadRows(root, archived) {
  root.querySelectorAll(".mail-thread[data-peer]").forEach(node => {
    node.onclick = () => { mailPeer = node.dataset.peer; mailView = "thread"; renderMailCurrent(); };
    node.oncontextmenu = (e) => { e.preventDefault(); threadRowMenu(node.dataset.peer, node.dataset.hashref, archived); };
  });
}
function threadRowMenu(peer, hashref, archived) {
  showActionSheet(mailName(peer), [
    { label: "💬 Open", onclick: () => { mailPeer = peer; mailView = "thread"; renderMailCurrent(); } },
    { label: "✎ Rename chat", onclick: () => renameChat(peer) },
    archived ? { label: "📥 Unarchive", onclick: () => doArchive(hashref, false) }
             : { label: "🗄 Archive", onclick: () => doArchive(hashref, true) },
    { label: "🗑 Delete conversation", danger: true, onclick: () => confirmDeleteThread(peer, hashref) },
  ]);
}
async function renameChat(peer) {
  const init = (MAIL_CONTACTS.find(c => c.publicId === peer) || {}).username || "";
  const name = await showPrompt("Rename chat", init, "Display name");
  if (name == null) return;
  try { await api.mailRenameContact(peer, name.trim()); MAIL_CONTACTS = await api.mailContacts(); renderMailCurrent(); toast("Renamed ✓", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function doArchive(hashref, on) {
  if (!hashref) { toast("Nothing to archive yet."); return; }
  try { await api.mailSetArchived(hashref, on); if (mailView === "thread") mailView = "inbox"; renderMailCurrent(); toast(on ? "Archived" : "Unarchived", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function confirmDeleteThread(peer, hashref) {
  if (!hashref) { toast("Nothing to delete yet."); return; }
  const ok = await showConfirm("Delete conversation?", "This removes all messages with " + mailName(peer) + " from this device. Funds already sent are not affected.", "Delete", true);
  if (!ok) return;
  try { await api.mailDeleteThread(hashref); if (mailView === "thread" || mailView === "archived") mailView = "inbox"; renderMailCurrent(); toast("Deleted", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function renderMailThread() {
  const host = el("mailBody");
  const msgs = await api.mailThreadWith(mailPeer).catch(() => []);
  const hashref = msgs.length ? msgs[0].hashref : "";
  host.innerHTML = `${mailHeader(mailName(mailPeer), "inbox", { menuId: "mailThreadMenu" })}
    <div class="mail-conv" id="mailConv">${renderConvHtml(msgs)}</div>
    <div class="mail-compose">
      <button class="btn btn--sm btn--outline" id="mailPlus" title="Attach / send funds">＋</button>
      <button class="btn btn--sm btn--outline" id="mailEmoji" title="Emoji">😊</button>
      <input class="field__input" id="mailText" placeholder="Message…" autocomplete="off" />
      <button class="btn btn--primary btn--sm" id="mailSendBtn">Send</button>
    </div>
    <input type="file" id="mailFile" accept="image/*" hidden />`;
  wireMailHeader("inbox");
  if (el("mailThreadMenu")) el("mailThreadMenu").onclick = () => threadMenu(mailPeer, hashref);
  const conv = el("mailConv"); conv.scrollTop = conv.scrollHeight;
  const sendText = async () => {
    const t = el("mailText").value.trim(); if (!t) return;
    el("mailText").value = ""; el("mailSendBtn").disabled = true;
    try { await api.mailSend(mailPeer, { type: "text", message: t }); await renderMailThread(); }
    catch (e) { toast("Send failed: " + e.message, "err"); el("mailSendBtn").disabled = false; }
  };
  el("mailSendBtn").onclick = sendText;
  el("mailText").onkeydown = (e) => { if (e.key === "Enter") sendText(); };
  el("mailEmoji").onclick = () => showEmojiPicker(el("mailText"));
  el("mailPlus").onclick = () => showActionSheet("Send", [
    { label: "📷 Photo", onclick: () => el("mailFile").click() },
    { label: "💰 Send funds", onclick: () => showSendFunds(mailPeer) },
  ]);
  el("mailFile").onchange = () => sendMailImage(el("mailFile").files[0]);
  el("mailText").focus();
}
function threadMenu(peer, hashref) {
  const isContact = MAIL_CONTACTS.some(c => c.publicId === peer);
  const items = [{ label: "✎ Rename chat", onclick: () => renameChat(peer) }];
  if (!isContact) items.push({ label: "➕ Add to contacts", onclick: () => addPeerContact(peer) });
  items.push({ label: "🗄 Archive", onclick: () => doArchive(hashref, true) });
  items.push({ label: "🗑 Delete conversation", danger: true, onclick: () => confirmDeleteThread(peer, hashref) });
  showActionSheet(mailName(peer), items);
}
async function addPeerContact(peer) {
  const name = await showPrompt("Add to contacts", (MAIL_CONTACTS.find(c => c.publicId === peer) || {}).username || "", "Name (optional)");
  if (name == null) return;
  try { await api.mailAddContact(peer, name.trim()); MAIL_CONTACTS = await api.mailContacts(); renderMailCurrent(); toast("Added ✓", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
// Conversation body with day chips (Today / Yesterday / date) and same-sender grouping within 5 minutes.
function renderConvHtml(msgs) {
  if (!msgs.length) return `<div class="empty">No messages yet — say hi.</div>`;
  let html = "", lastDay = "", lastSender = null, lastTime = 0;
  for (const m of msgs) {
    const day = mailDayLabel(m.date);
    if (day !== lastDay) { html += `<div class="mail-daychip">${esc(day)}</div>`; lastDay = day; lastSender = null; }
    const sender = m.incoming ? "in" : "out";
    const grouped = sender === lastSender && ((m.date || 0) - lastTime) < 5 * 60 * 1000;
    html += mailBubbleHtml(m, grouped);
    lastSender = sender; lastTime = m.date || 0;
  }
  return html;
}
function mailDayLabel(ts) {
  const d = new Date(ts || Date.now()), now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function mailBubbleHtml(m, grouped) {
  const mine = !m.incoming;
  let inner;
  if (m.type === "image" && m.image) inner = `<img class="mail-img" src="data:image/jpeg;base64,${esc(m.image)}" alt="">`;
  else if (m.type === "payment") inner = `<div class="mail-pay">💰 ${esc(TOK.tidyAmount(m.amount || ""))} ${esc(m.tokenname || "Minima")}${m.message ? "<br>" + esc(m.message) : ""}</div>`;
  else inner = esc(m.message || "");
  const status = mine ? `<span class="mail-status">${m.status === "confirmed" ? "✓✓" : "✓"}</span>` : "";
  const meta = grouped ? "" : `<div class="mail-bubble__meta">${esc(relTime(m.date))} ${status}</div>`;
  return `<div class="mail-bubble ${mine ? "mail-bubble--me" : ""}${grouped ? " mail-bubble--grouped" : ""}"><div class="mail-bubble__body">${inner}</div>${meta}</div>`;
}
async function renderMailNew() {
  const host = el("mailBody");
  const opts = MAIL_CONTACTS.map(c => `<option value="${esc(c.publicId)}">${esc(c.username || mailShort(c.publicId))}</option>`).join("");
  host.innerHTML = `${mailHeader("New message", "inbox")}
    <div class="card">
      ${MAIL_CONTACTS.length ? `<div class="field"><div class="field__label">To a contact</div><select class="field__input" id="mailToSel"><option value="">— choose —</option>${opts}</select></div>` : ""}
      <div class="field"><div class="field__label">…or paste a mail id (0x… , optionally id|Mx…payaddr)</div>
        <textarea class="field__input" id="mailToId" rows="2" placeholder="0x… 128 hex"></textarea></div>
      <div class="field"><div class="field__label">Message</div><input class="field__input" id="mailNewText" placeholder="Say hi…" /></div>
      <button class="btn btn--primary btn--full" id="mailNewSend">Send</button>
    </div>`;
  wireMailHeader("inbox");
  if (el("mailToSel")) el("mailToSel").onchange = () => { if (el("mailToSel").value) el("mailToId").value = el("mailToSel").value; };
  el("mailNewSend").onclick = async () => {
    let to = el("mailToId").value.trim().split("|")[0].trim();
    const text = el("mailNewText").value.trim();
    if (!/^0x[0-9a-fA-F]{128}$/.test(to)) { toast("Enter a valid mail id (0x + 128 hex).", "err"); return; }
    if (!text) { toast("Enter a message."); return; }
    el("mailNewSend").disabled = true;
    try {
      // if they pasted an id|payaddr share, register it as a contact so the payaddr is stored
      if (el("mailToId").value.includes("|")) { try { await api.mailAddContact(el("mailToId").value.trim(), ""); MAIL_CONTACTS = await api.mailContacts(); } catch (e) {} }
      await api.mailSend(to, { type: "text", message: text });
      mailPeer = to; mailView = "thread"; renderMailCurrent();
    } catch (e) { toast("Send failed: " + e.message, "err"); el("mailNewSend").disabled = false; }
  };
}
async function renderMailContacts() {
  const host = el("mailBody");
  MAIL_CONTACTS = await api.mailContacts().catch(() => []);
  host.innerHTML = `${mailHeader("Contacts", "inbox")}
    <div class="card"><div class="card__title">Add a contact</div>
      <div class="field"><div class="field__label">Name (optional)</div><input class="field__input" id="ctName" placeholder="Alice" /></div>
      <div class="field"><div class="field__label">Mail id (0x… , or id|Mx…payaddr)</div><textarea class="field__input" id="ctId" rows="2" placeholder="0x… 128 hex"></textarea></div>
      <div class="seg"><button class="btn btn--outline btn--full" id="ctScan">Scan QR</button><button class="btn btn--primary btn--full" id="ctAdd">Add contact</button></div></div>
    <div id="ctList">${MAIL_CONTACTS.length ? MAIL_CONTACTS.map(c => `<div class="row mail-contact" data-peer="${esc(c.publicId)}" style="cursor:pointer" title="Right-click to rename / delete">
      <img class="mail-av" src="${esc(mailAvatar(c.publicId))}" alt="">
      <div class="row__mid"><div class="row__l1">${esc(c.username || mailShort(c.publicId))}</div><div class="row__l2">${esc(mailShort(c.publicId))}</div></div>
      <button class="btn btn--sm btn--outline ct-menu" data-peer="${esc(c.publicId)}" title="Options">⋮</button></div>`).join("") : `<div class="empty">No contacts yet.</div>`}</div>`;
  wireMailHeader("inbox");
  el("ctAdd").onclick = async () => {
    const share = el("ctId").value.trim(), name = el("ctName").value.trim();
    try { await api.mailAddContact(share, name); MAIL_CONTACTS = await api.mailContacts(); renderMailContacts(); toast("Contact added ✓", "ok"); }
    catch (e) { toast(e.message, "err"); }
  };
  el("ctScan").onclick = async () => { const v = await scanQR("Scan a Mail-key QR"); if (v && el("ctId")) el("ctId").value = v; };
  host.querySelectorAll("#ctList .row[data-peer]").forEach(n => {
    n.onclick = (e) => { if (e.target.classList.contains("ct-menu")) return; mailPeer = n.dataset.peer; mailView = "thread"; renderMailCurrent(); };
    n.oncontextmenu = (e) => { e.preventDefault(); contactMenu(n.dataset.peer); };
  });
  host.querySelectorAll(".ct-menu").forEach(b => b.onclick = (e) => { e.stopPropagation(); contactMenu(b.dataset.peer); });
}
function contactMenu(peer) {
  showActionSheet(mailName(peer), [
    { label: "💬 Open chat", onclick: () => { mailPeer = peer; mailView = "thread"; renderMailCurrent(); } },
    { label: "✎ Rename", onclick: () => renameChat(peer) },
    { label: "🗑 Delete contact", danger: true, onclick: () => confirmDeleteContact(peer) },
  ]);
}
async function confirmDeleteContact(peer) {
  const ok = await showConfirm("Delete contact?", "Remove " + mailName(peer) + " from your contacts. Your conversation history stays.", "Delete", true);
  if (!ok) return;
  try { await api.mailRemoveContact(peer); MAIL_CONTACTS = await api.mailContacts(); renderMailCurrent(); toast("Deleted", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function renderMailArchived() {
  const host = el("mailBody");
  const th = await api.mailArchivedThreads().catch(() => []);
  host.innerHTML = `${mailHeader("Archived", "inbox")}
    <div id="mailArchList">${th.length ? th.map(mailThreadRowHtml).join("") : `<div class="empty">No archived chats. Right-click a chat to archive it.</div>`}</div>`;
  wireMailHeader("inbox");
  wireThreadRows(el("mailArchList"), true);
}
async function renderMailIdentity() {
  const host = el("mailBody");
  const share = await api.mailShare().catch(() => MAIL_ID.publicId);
  host.innerHTML = `${mailHeader("Your identity", "inbox")}
    <div class="card" style="text-align:center">
      <img class="mail-av mail-av--lg" src="${esc(mailAvatar(MAIL_ID.publicId))}" alt="">
      <div class="field" style="margin-top:10px"><div class="field__label">Display name</div>
        <div class="seg"><input class="field__input" id="idName" value="${esc(MAIL_ID.name || "")}" placeholder="Your name" /><button class="btn btn--outline btn--sm" id="idNameSave">Save</button></div></div>
      <div class="field__label" style="margin-top:8px">Your mail id — share it so others can message you</div>
      <div class="addrbox addrbox__addr" id="idShare" title="Click to copy">${esc(share)}</div>
      <div class="qrbox" id="idQr"></div>
      <div class="view__desc">Others add this id as a contact to send you encrypted mail. Your pay address is included so they can also send you Minima.</div>
      <div class="field__label" style="margin-top:10px">Your Minima receiving address</div>
      <div class="addrbox addrbox__addr" id="idPay" title="Click to copy">${esc(MAIL_ID.payaddr || "(getting your address…)")}</div>
      <div class="field__label" style="margin-top:12px">Backup</div>
      <div class="seg"><button class="btn btn--outline btn--full" id="idBackup">Back up</button><button class="btn btn--outline btn--full" id="idRestore">Restore</button></div>
      <div class="view__desc">A passphrase-encrypted file with your identity, contacts and messages. Restores on any device — even the Minima Mail phone app.</div>
    </div>`;
  wireMailHeader("inbox");
  el("idShare").onclick = () => copy(share);
  el("idPay").onclick = () => { if (MAIL_ID.payaddr) { copy(MAIL_ID.payaddr); toast("Copied.", "ok"); } };
  el("idNameSave").onclick = async () => { MAIL_ID = await api.mailSetName(el("idName").value.trim()); toast("Name saved ✓", "ok"); };
  el("idBackup").onclick = doMailBackup;
  el("idRestore").onclick = doMailRestore;
  try { if (typeof qrcode !== "undefined") { const qr = qrcode(0, "M"); qr.addData(share); qr.make(); el("idQr").innerHTML = qr.createImgTag(4, 8); } } catch (e) {}
}
async function doMailBackup() {
  const pass = await showPrompt("Back up identity", "", "Passphrase (min 8 chars)",
    { password: true, ok: "Back up", message: "Your backup contains your private key, so it's encrypted with this passphrase — you'll need it to restore." });
  if (pass == null) return;
  if (pass.length < 8) { toast("Use a passphrase of at least 8 characters.", "err"); return; }
  if (/[^\x20-\x7E]/.test(pass)) { toast("Use an ASCII passphrase so it restores on every device.", "err"); return; }
  try { const r = await api.mailExportBackup(pass); if (r && r.canceled) return; toast("Backed up ✓", "ok"); }
  catch (e) { toast("Backup failed: " + e.message, "err"); }
}
async function doMailRestore() {
  const pass = await showPrompt("Restore identity", "", "Backup passphrase",
    { password: true, ok: "Choose file & restore", message: "Enter the passphrase, then choose your encrypted backup file." });
  if (pass == null) return;
  if (/[^\x20-\x7E]/.test(pass)) { toast("Use an ASCII passphrase.", "err"); return; }
  try {
    const r = await api.mailImportBackup(pass);
    if (r && r.canceled) return;
    if (r && r.identity) MAIL_ID = r.identity;
    MAIL_CONTACTS = await api.mailContacts().catch(() => []);
    mailView = "inbox"; renderMailCurrent();
    toast("Restored ✓", "ok");
  } catch (e) { toast("Restore failed — wrong passphrase or bad file.", "err"); }
}
function showEmojiPicker(input) {
  const html = `<div class="overlay" id="emojiOv"><div class="modal" style="max-width:320px">
    <div class="modal__title">Emoji</div><div class="emoji-grid">${MAIL_EMOJIS.map(e => `<button class="emoji-btn">${e}</button>`).join("")}</div>
    <button class="btn btn--outline btn--full" id="emojiClose">Close</button></div></div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const close = () => { const o = el("emojiOv"); if (o) o.remove(); };
  el("emojiOv").querySelectorAll(".emoji-btn").forEach(b => b.onclick = () => { input.value += b.textContent; close(); input.focus(); });
  el("emojiClose").onclick = close;
  el("emojiOv").onclick = (e) => { if (e.target.id === "emojiOv") close(); };
}
async function sendMailImage(file) {
  if (!file) return;
  toast("Compressing image…");
  try {
    const b64 = await compressImage(file);
    await api.mailSend(mailPeer, { type: "image", message: "", image: b64 });
    renderMailThread();
  } catch (e) { toast("Image failed: " + (e.message || e), "err"); }
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const draw = (dim, q) => { let w = img.width, h = img.height; const s = Math.min(1, dim / Math.max(w, h)); w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s)); const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h); return c.toDataURL("image/jpeg", q); };
      let dim = 400, q = 0.7, data = draw(dim, q);
      while (data.length > 11000 && (q > 0.25 || dim > 160)) { if (q > 0.3) q -= 0.12; else { dim -= 60; q = 0.6; } data = draw(dim, q); }
      if (data.length > 11500) return reject(new Error("image too large to fit one on-chain message"));
      resolve(data.split(",")[1]);
    };
    img.onerror = () => reject(new Error("couldn't read image"));
    const r = new FileReader(); r.onload = () => (img.src = r.result); r.onerror = () => reject(new Error("couldn't read file")); r.readAsDataURL(file);
  });
}
async function showSendFunds(peer) {
  const bal = await tryCmd("balance") || [];
  const toks = bal
    .filter(b => { try { return parseFloat(b.confirmed) > 0; } catch (e) { return false; } })
    .map(b => ({ tokenid: b.tokenid || MINIMA, name: TOK.tokenName(b.token, b.tokenid), bal: b.confirmed }));
  if (!toks.length) { toast("No funds available to send.", "err"); return; }
  const opts = toks.map((t, i) => `<option value="${i}">${esc(t.name)} — balance ${esc(t.bal)}</option>`).join("");
  let known = await api.mailResolvePayaddr(peer).catch(() => "");
  if (!known) api.mailRequestPayaddr(peer).catch(() => {});   // fire the handshake — address may live-fill below
  const myAddr = await api.mailReceivingAddr().catch(() => "");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="sfOv"><div class="modal">
    <div class="modal__title">Send funds to ${esc(mailName(peer))}</div>
    <div class="field"><div class="field__label">Token</div><select class="field__input" id="sfTok">${opts}</select></div>
    <div class="field"><div class="field__label">Amount</div><input class="field__input" id="sfAmt" placeholder="0.0" autocomplete="off" /></div>
    <div class="field"><div class="field__label">Their Minima receiving address</div>
      <div class="seg"><input class="field__input" id="sfAddr" placeholder="0x… / Mx…" value="${esc(known || "")}" autocomplete="off" />
        <button class="btn btn--outline btn--sm" id="sfScan">Scan</button></div>
      <div class="view__desc" id="sfHint" style="margin-top:4px">${known ? "Auto-filled from their messages." : "Requesting their address… or scan their QR / paste it."}</div></div>
    <div class="field"><div class="field__label">Note (optional)</div><input class="field__input" id="sfMemo" placeholder="What's it for?" autocomplete="off" /></div>
    <div class="view__desc">You'll receive at: ${myAddr ? esc(short(myAddr, 22)) : "(getting your address…)"}</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="sfCancel">Cancel</button><button class="btn btn--primary btn--full" id="sfReview">Review</button></div>
  </div></div>`);
  const ov = el("sfOv");
  let off = null;
  const close = () => { if (off) { off(); off = null; } if (ov) ov.remove(); };
  // Live-fill the recipient address the moment a payaddr-reply arrives (scan emits an update on a learned address).
  off = api.onMail(async () => {
    const f = el("sfAddr"); if (!f || f.value.trim()) return;
    const a = await api.mailResolvePayaddr(peer).catch(() => "");
    if (a && el("sfAddr") && !el("sfAddr").value.trim()) { el("sfAddr").value = a; const h = el("sfHint"); if (h) h.textContent = "Auto-filled from their reply."; }
  });
  el("sfCancel").onclick = close;
  ov.onclick = (e) => { if (e.target.id === "sfOv") close(); };
  el("sfScan").onclick = async () => {
    const v = await scanQR("Scan their receiving-address QR");
    if (v == null) return;
    const a = v.indexOf("|") >= 0 ? v.split("|")[1] : v;   // a mailkey|Mxaddr share, or a bare address
    if (a && el("sfAddr")) { el("sfAddr").value = a.trim(); const h = el("sfHint"); if (h) h.textContent = "From their QR."; }
  };
  el("sfReview").onclick = async () => {
    const t = toks[parseInt(el("sfTok").value, 10)] || toks[0];
    const amt = el("sfAmt").value.trim(), address = el("sfAddr").value.trim(), memo = el("sfMemo").value;
    if (!/^[0-9]*\.?[0-9]+$/.test(amt) || parseFloat(amt) <= 0) { toast("Enter a valid amount.", "err"); return; }
    try { if (parseFloat(amt) > parseFloat(t.bal)) { toast("Insufficient balance.", "err"); return; } } catch (e) {}
    if (!looksLikeMinimaAddress(address)) {
      if (!known) api.mailRequestPayaddr(peer).catch(() => {});
      toast("Enter " + mailName(peer) + "'s Minima receiving address (0x… or Mx…).", "err"); return;
    }
    const ok = await showConfirm("Send " + amt + " " + t.name + "?",
      "To " + mailName(peer) + "\n" + address + "\n\nThis sends real funds and cannot be undone.", "Send");
    if (!ok) return;
    close();
    const prog = showProgress("Sending " + amt + " " + t.name, "Posting to the chain — this can take a few seconds…");
    try {
      const r = await api.mailPay(peer, address, amt, t.tokenid, t.name, memo);
      prog.close();
      renderMailThread();
      showPayResult(true, "Sent " + amt + " " + t.name + " to " + mailName(peer) + ".", (r && r.txpowid) || "");
    } catch (e) {
      prog.close();
      // An ambiguous send (timeout/reset) may actually have posted — never present it as a clean failure that
      // invites a re-pay. mail.pay() words the message so we can detect it and show an "unknown status" dialog.
      const amb = /may have been submitted/i.test(e.message || "");
      showPayResult(false, amb ? e.message : ("Payment failed: " + e.message), "", amb);
    }
  };
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

// ---- PandaPools (AMM) — Swap / Pools / My LP / Activity. ----
let ppView = "swap";            // swap | pools | mylp | activity
let PP_POOLS = [];
let PP_MINE = [];               // my owned pools (for the LP-management sheets)
let PP_SWAP_TOKS = [];          // [{tok,name}] pairs available to trade
let ppSwapMinToTok = true;      // true = pay MINIMA get token; false = pay token get MINIMA

function ppHeader(active) {
  const tab = (id, label) => `<button class="btn btn--sm ${active === id ? "btn--primary" : "btn--outline"}" data-ppview="${id}">${label}</button>`;
  return `<div class="view__title">PandaPools</div>
    <div class="seg" style="margin-bottom:12px">${tab("swap", "Swap")}${tab("pools", "Pools")}${tab("mylp", "My LP")}${tab("activity", "Activity")}</div>`;
}
function wirePpHeader() {
  document.querySelectorAll("#ppBody [data-ppview]").forEach(b => b.onclick = () => { ppView = b.dataset.ppview; renderPandapools(); });
}
async function renderPandapools() {
  const host = el("ppBody");
  if (!running) { host.innerHTML = `<div class="view__title">PandaPools</div><div class="spin">Waiting for the node…</div>`; return; }
  if (ppView === "pools") return renderPpPools();
  if (ppView === "mylp") return renderPpMyLP();
  if (ppView === "activity") return renderPpActivity();
  return renderPpSwap();
}
function ppPairRows(pools) {
  // group discovered pools by token (each group = one MINIMA/token pair)
  const groups = {};
  pools.forEach(p => { (groups[p.tok] = groups[p.tok] || []).push(p); });
  const keys = Object.keys(groups);
  if (!keys.length) return `<div class="empty">No pools discovered yet. They appear as the node scans the shared registry — give it a moment after the node reaches the tip.</div>`;
  return keys.map(tok => {
    const g = groups[tok];
    const name = esc(g[0].tokName || TOK.shortId(tok));
    const rows = g.map(p => `<div class="row" style="cursor:pointer" data-pool="${esc(p.address)}" title="Right-click to copy the pool address">
        <div class="row__mid"><div class="row__l1">${esc(TOK.tidyAmount(p.reserveM))} MINIMA · ${esc(TOK.tidyAmount(p.reserveT))} ${name}</div>
          <div class="row__l2">price ${esc(TOK.tidyAmount(p.spot))} ${name}/MINIMA · fees ${esc(TOK.tidyAmount(p.feeGrowthPct))}% · ${esc(short(p.address, 18))}</div></div>
        <div class="row__r">›</div></div>`).join("");
    return `<div class="card"><div class="card__title">MINIMA / ${name} <span class="mail-ver">${g.length} pool${g.length > 1 ? "s" : ""}</span></div>${rows}</div>`;
  }).join("");
}
let PP_BAL_MIN = "0", PP_BAL_TOK = "0";
let PP_USDT_ID = null;          // cached market-fed token id (mxUSDT) for the swap-page MEXC line
async function renderPpSwap() {
  const host = el("ppBody");
  const pools = await api.ppPools().catch(() => []);
  PP_POOLS = pools;
  const seen = {}; PP_SWAP_TOKS = [];
  pools.forEach(p => { if (p.tok && !seen[p.tok]) { seen[p.tok] = true; PP_SWAP_TOKS.push({ tok: p.tok, name: p.tokName || TOK.shortId(p.tok) }); } });
  if (!PP_SWAP_TOKS.length) {
    host.innerHTML = `${ppHeader("swap")}<div class="empty">No live pools yet — create one in the My LP tab to seed liquidity.</div>`;
    wirePpHeader(); return;
  }
  const opts = PP_SWAP_TOKS.map((t, i) => `<option value="${i}">MINIMA / ${esc(t.name)}</option>`).join("");
  host.innerHTML = `${ppHeader("swap")}
    <div class="card">
      <div class="field"><div class="field__label">Pool</div><select class="field__input" id="ppSwapTok">${opts}</select></div>
      <div class="view__desc" id="ppPoolLine">—</div>
      <div class="view__desc" id="ppSwapMarket" style="display:none;color:var(--dim)"></div>
      <div class="kv"><span>You hold</span><span id="ppHoldings">—</span></div>
      <div class="seg"><button class="btn btn--full" id="ppDirBuy">Buy with MINIMA</button><button class="btn btn--full" id="ppDirSell">Sell for MINIMA</button></div>
      <div class="field"><div class="field__label" id="ppSwapInLbl">You pay (MINIMA)</div><input class="field__input" id="ppSwapAmt" placeholder="0.0" autocomplete="off" /><div class="view__desc" id="ppFromBal" style="margin-top:4px"></div></div>
      <div id="ppQuote"></div>
      <button class="btn btn--primary btn--full" id="ppSwapGo">Review swap</button>
    </div>`;
  wirePpHeader();
  ppSwapMinToTok = true;
  await refreshPpSwapMeta();
  applyPpDir();
  el("ppDirBuy").onclick = () => { ppSwapMinToTok = true; applyPpDir(); };
  el("ppDirSell").onclick = () => { ppSwapMinToTok = false; applyPpDir(); };
  el("ppSwapTok").onchange = () => { refreshPpSwapMeta().then(applyPpDir); };
  el("ppSwapAmt").oninput = () => ppUpdateQuote();
  el("ppSwapGo").onclick = () => doPpSwap();
}
// Pool line (count + aggregate depth) + your holdings for both legs — the liquidity/price context the donor shows.
async function refreshPpSwapMeta() {
  const sel = el("ppSwapTok"); if (!sel) return;
  const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) return;
  const info = await api.ppPairInfo(t.tok).catch(() => ({ pools: 0, depth: "0" }));
  if (el("ppPoolLine")) el("ppPoolLine").textContent = "MINIMA / " + t.name + " · " + info.pools + (Number(info.pools) === 1 ? " pool" : " pools") + " · depth " + TOK.tidyAmount(info.depth) + " MINIMA";
  const bal = await tryCmd("balance") || [];
  // SENDABLE, not confirmed — confirmed counts coins locked in pools/scripts, so it overstated what you can
  // actually trade (same bug fixed in the wallet). The CREATE flow already uses sendable.
  const bm = bal.find(b => b.tokenid === MINIMA); PP_BAL_MIN = bm ? (bm.sendable || "0") : "0";
  const bt = bal.find(b => b.tokenid && b.tokenid.toLowerCase() === t.tok.toLowerCase()); PP_BAL_TOK = bt ? (bt.sendable || "0") : "0";
  if (el("ppHoldings")) el("ppHoldings").textContent = TOK.tidyAmount(PP_BAL_MIN) + " MINIMA · " + TOK.tidyAmount(PP_BAL_TOK) + " " + t.name;
  if (el("ppFromBal")) { const payTok = ppSwapMinToTok ? "MINIMA" : t.name; el("ppFromBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_MIN : PP_BAL_TOK) + " " + payTok; }
  ppRenderSwapMarket(t);   // MEXC market-comparison line (USDT pairs only) — passive, safe on a block tick
}
// The donor's renderSwapMarket: for a MINIMA/USDT pool, show the live MEXC mid + how the blended pool spot compares.
async function ppRenderSwapMarket(t) {
  const host = el("ppSwapMarket"); if (!host || !t) return;
  if (PP_USDT_ID === null) { try { const mt = await api.ppMarketToken(); PP_USDT_ID = ((mt && mt.usdt) || "").toLowerCase(); } catch (e) { PP_USDT_ID = ""; } }
  const isUsdt = PP_USDT_ID && t.tok && t.tok.toLowerCase() === PP_USDT_ID;
  if (!isUsdt) { host.style.display = "none"; host.textContent = ""; return; }
  host.style.display = "";
  let m = null; try { m = await api.ppMarket(); } catch (e) {}
  if (!el("ppSwapMarket")) return;                                  // view changed during the await
  if (!m || !m.fresh || !m.mid) { host.textContent = "Market price unavailable (MEXC)"; return; }
  let line = "Market ≈ " + TOK.tidyAmount(m.mid) + " USDT/MINIMA (MEXC)";
  let sm = 0, st = 0;
  (PP_POOLS || []).forEach(p => { if (p.tok && p.tok.toLowerCase() === t.tok.toLowerCase()) { sm += parseFloat(p.reserveM) || 0; st += parseFloat(p.reserveT) || 0; } });
  const mid = parseFloat(m.mid);
  if (sm > 0 && mid > 0) {
    const spot = st / sm, pct = (spot - mid) / mid * 100;
    const word = Math.abs(pct) < 0.1 ? "at market" : (Math.abs(pct).toFixed(1) + "% " + (pct > 0 ? "above market" : "below market"));
    line += "  ·  Pool " + spot.toFixed(6) + "  ·  " + word;
  }
  host.textContent = line;
}
function applyPpDir() {
  if (!el("ppDirBuy")) return;
  el("ppDirBuy").className = "btn btn--full " + (ppSwapMinToTok ? "btn--primary" : "btn--outline");
  el("ppDirSell").className = "btn btn--full " + (ppSwapMinToTok ? "btn--outline" : "btn--primary");
  const t = PP_SWAP_TOKS[(el("ppSwapTok") && el("ppSwapTok").value | 0) || 0];
  const payTok = ppSwapMinToTok ? "MINIMA" : (t ? t.name : "token");
  if (el("ppSwapInLbl")) el("ppSwapInLbl").textContent = "You pay (" + payTok + ")";
  if (el("ppFromBal")) el("ppFromBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_MIN : PP_BAL_TOK) + " " + payTok;
  ppUpdateQuote();
}
function ppKv(k, vHtml, green) { return `<div class="kv"><span>${esc(k)}</span><span${green ? ' style="color:var(--green)"' : ""}>${vHtml}</span></div>`; }
let ppQuoteSeq = 0;
async function ppUpdateQuote() {
  const disp = el("ppQuote"); if (!disp) return;
  const sel = el("ppSwapTok"), amtEl = el("ppSwapAmt"); if (!sel || !amtEl) return;
  const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) return;
  const amt = amtEl.value.trim();
  if (!/^[0-9]*\.?[0-9]+$/.test(amt) || parseFloat(amt) <= 0) { disp.innerHTML = `<div class="view__desc">Enter an amount for a live quote.</div>`; return; }
  const seq = ++ppQuoteSeq;                                       // last-write-wins: a newer quote supersedes this one
  const q = await api.ppQuote(t.tok, ppSwapMinToTok, amt).catch(() => ({ ok: false }));
  if (seq !== ppQuoteSeq) return;                                 // a later keystroke already fired a fresher quote
  const d = el("ppQuote"); if (!d) return;                        // view may have changed during the await
  if (!q || !q.ok) { d.innerHTML = `<div class="view__desc">${q && q.notReady ? "Starting up — one moment…" : "This trade is too large for the pools' depth — try a smaller amount."}</div>`; return; }
  const recvTok = ppSwapMinToTok ? esc(t.name) : "MINIMA";
  let html = "";
  html += ppKv("Rate", "≈ " + esc(TOK.tidyAmount(q.effPrice)) + " " + esc(t.name) + " / MINIMA");
  html += ppKv("Price impact", esc(q.priceImpact) + " %");
  if (Number(q.poolsAvailable) > 1) html += ppKv("Routed across", (Number(q.poolsUsed) || 0) + " of " + (Number(q.poolsAvailable) || 0) + " pools" + (q.capped ? " (top " + (Number(q.maxPools) || 6) + ")" : ""));
  html += ppKv("Pool fee (0.50%)", "kept by LPs");
  html += ppKv("You receive", "≈ " + esc(TOK.tidyAmount(q.totalOut)) + " " + recvTok, true);
  d.innerHTML = html;
}
let ppSwapBusy = false;
async function doPpSwap() {
  if (ppSwapBusy) return;                                         // block a double-submit during the pre-confirm quote await
  const sel = el("ppSwapTok"); if (!sel) return;
  const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) { toast("Pick a pool first.", "err"); return; }
  const amt = (el("ppSwapAmt") && el("ppSwapAmt").value || "").trim();
  if (!/^[0-9]*\.?[0-9]+$/.test(amt) || parseFloat(amt) <= 0) { toast("Enter an amount.", "err"); return; }
  ppSwapBusy = true;
  try {
    // A FRESH quote at confirm time = the exact route we'll post (frozen-quote, like the donor's confirmSwap→doSwap).
    const q = await api.ppQuote(t.tok, ppSwapMinToTok, amt).catch(() => ({ ok: false }));
    if (!q || !q.ok || !q.quoteId) { toast(q && q.notReady ? "Starting up — try again in a moment." : "That trade is too large for these pools.", "err"); return; }
    const payLbl = ppSwapMinToTok ? "MINIMA" : t.name, getLbl = ppSwapMinToTok ? t.name : "MINIMA";
    const routed = Number(q.poolsUsed) > 1 ? "\nRouted across " + q.poolsUsed + " pools in one transaction." : "";
    const okc = await showConfirm("Confirm swap",
      "Pay  " + amt + " " + payLbl + "\nReceive  ≈ " + TOK.tidyAmount(q.totalOut) + " " + getLbl +
      "\nRate  ≈ " + TOK.tidyAmount(q.effPrice) + " " + t.name + " / MINIMA\n\nPrice impact " + q.priceImpact + "%." + routed +
      "\n\nThis posts a real on-chain transaction — if a pool moves before it confirms, the swap is rejected and you keep your funds.", "Swap");
    if (!okc) return;
    const prog = showProgress("Swapping " + amt + " " + payLbl, "Posting to the chain — this can take a few seconds…");
    try {
      const r = await api.ppSwap(q.quoteId);                       // posts the EXACT confirmed route (frozen)
      prog.close();
      toast("Swapped ✓ — received " + TOK.tidyAmount(r.totalOut) + " " + getLbl, "ok");
      if (el("ppSwapAmt")) el("ppSwapAmt").value = "";
      ppUpdateQuote(); refreshPpSwapMeta();
    } catch (e) { prog.close(); toast("Swap failed: " + e.message, "err"); }
  } finally { ppSwapBusy = false; }
}

// HTML builders (reused by the initial render AND the live-update patch) + wiring helpers.
function ppNum(n) { n = Number(n); if (!isFinite(n)) return "0"; return (n.toFixed(4).replace(/\.?0+$/, "")) || "0"; }   // display-only float format
function ppMineHtml(mine) {
  if (!mine.length) return `<div class="empty">You don't own any pools yet. Create one with the button above.</div>`;
  return mine.map(p => {
    const nm = esc(p.tokName || TOK.shortId(p.tok));
    let rows = `<div class="kv"><span>Your liquidity</span><span>${esc(TOK.tidyAmount(p.reserveM))} MINIMA + ${esc(TOK.tidyAmount(p.reserveT))} ${nm}</span></div>`
      + `<div class="kv"><span>Value now</span><span>≈ ${esc(TOK.tidyAmount(p.value))} MINIMA</span></div>`
      + `<div class="kv"><span>Pool price</span><span>${esc(TOK.tidyAmount(p.poolPrice))} ${nm} / MINIMA</span></div>`
      + `<div class="kv"><span>Fees earned</span><span style="color:var(--green)">≈ ${esc(ppNum(p.feesMinima))} MINIMA (+${esc(ppNum(p.feesPct))}%)</span></div>`;
    if (p.priceMove != null) {
      rows += `<div class="kv"><span>Price since open</span><span>${p.priceMove >= 0 ? "+" : ""}${esc(ppNum(p.priceMove))}%</span></div>`
        + `<div class="kv"><span>Impermanent loss</span><span${p.il < -0.01 ? ' style="color:var(--red)"' : ""}>${esc(ppNum(p.il))}% vs holding</span></div>`;
      if (p.ageBlocks > 0) rows += `<div class="kv"><span>Age</span><span>${Number(p.ageBlocks) || 0} blocks (~${esc(ppNum(p.ageBlocks * 50 / 3600))} h)</span></div>`;
    }
    return `<div class="card"><div class="card__title">MINIMA / ${nm}</div>${rows}
      <div class="kv"><span>Address</span><span class="addrbox__addr" style="cursor:pointer" data-copy="${esc(p.address)}">${esc(short(p.address, 22))}</span></div>
      <div class="seg" style="margin-top:8px"><button class="btn btn--sm btn--outline" data-ppadd="${esc(p.address)}">Add</button><button class="btn btn--sm btn--outline" data-ppmig="${esc(p.address)}">Migrate</button><button class="btn btn--sm btn--danger" data-ppwd="${esc(p.address)}">Withdraw</button></div></div>`;
  }).join("");
}
function wirePpMineActions(root) {
  root.querySelectorAll("[data-ppadd]").forEach(b => b.onclick = () => showPpDeposit(b.dataset.ppadd));
  root.querySelectorAll("[data-ppmig]").forEach(b => b.onclick = () => showPpMigrate(b.dataset.ppmig));
  root.querySelectorAll("[data-ppwd]").forEach(b => b.onclick = () => confirmPpWithdraw(b.dataset.ppwd));
}
// Normalize a SWAP summary to the consistent "Bought/Sold N MINIMA for M <token>" framing. New swaps are already
// recorded this way; older rows were stored from the token's side ("Bought <token> for <minima>") — reframe those.
function ppSwapSummary(a) {
  const s = a.summary || "";
  if (a.type !== "SWAP" || /MINIMA/.test(s)) return s;          // non-swap, or already new-format
  let m = /^Bought (\S+) for (\S+)$/.exec(s);                   // old: bought <token> for <minima> ⇒ sold MINIMA
  if (m) return "Sold " + m[2] + " MINIMA for " + m[1];
  m = /^Sold (\S+) for (\S+)$/.exec(s);                         // old: sold <minima> for <token> ⇒ bought MINIMA
  if (m) return "Bought " + m[1] + " MINIMA for " + m[2];
  return s;
}
function ppActsHtml(acts) {
  return acts.length ? acts.map(a => `<div class="row"><div class="row__mid">
      <div class="row__l1">${esc(a.type)} ${a.failed ? "· <span style=\"color:var(--red)\">Failed</span>" : a.confirmed ? "· <span style=\"color:var(--green)\">Confirmed</span>" : "· Confirming…"}</div>
      <div class="row__l2">${esc(short(ppSwapSummary(a), 58))}</div></div><div class="row__r">${esc(relTime(a.ts))}</div></div>`).join("")
    : `<div class="empty">No activity yet.</div>`;
}
function ppFeedHtml(feed) {
  // Always framed from MINIMA's side: MINIMA into the pool = someone SOLD MINIMA; MINIMA out = someone BOUGHT it.
  return feed.length ? feed.map(f => {
    const verb = f.minimaIn ? "Sold" : "Bought";
    const cls = f.minimaIn ? "row__l1--red" : "row__l1--green";
    return `<div class="row"><div class="row__mid">
      <div class="row__l1 ${cls}">${verb} ${esc(TOK.tidyAmount(f.minimaAmt))} MINIMA</div>
      <div class="row__l2">for ${esc(TOK.tidyAmount(f.tokenAmt))} ${esc(f.tokenLabel)}</div></div>
      <div class="row__r">${esc(relTime(f.ts))}</div></div>`;
  }).join("")
    : `<div class="empty">No swaps seen yet.</div>`;
}
function wirePpPoolRows(root) {
  root.querySelectorAll(".row[data-pool]").forEach(n => n.oncontextmenu = (e) => { e.preventDefault(); copy(n.dataset.pool); toast("Pool address copied", "ok"); });
}
function wirePpCopy(root) { root.querySelectorAll("[data-copy]").forEach(n => n.onclick = () => { copy(n.dataset.copy); toast("Copied", "ok"); }); }

async function renderPpPools() {
  const host = el("ppBody");
  PP_POOLS = await api.ppPools().catch(() => []);
  const depth = PP_POOLS.reduce((sum, p) => sum + (parseFloat(p.reserveM) || 0), 0);
  const summary = PP_POOLS.length ? `${PP_POOLS.length} pool${PP_POOLS.length === 1 ? "" : "s"} · ~${ppNum(depth)} MINIMA aggregate depth` : "";
  host.innerHTML = `${ppHeader("pools")}
    <div class="view__desc">Live constant-product pools on the shared mainnet registry — the same pools the phone app and the MDS MiniDapp trade.${summary ? " " + esc(summary) + "." : ""}</div>
    <div id="ppList">${ppPairRows(PP_POOLS)}</div>`;
  wirePpHeader(); wirePpPoolRows(el("ppList"));
}
async function renderPpMyLP() {
  const host = el("ppBody");
  PP_MINE = await api.ppMyPools().catch(() => []);
  host.innerHTML = `${ppHeader("mylp")}
    <div class="view__desc">Pools you created on this device. Keep-fresh maintains their reserves automatically — <b>leave this app running</b> so your pools stay live for everyone.</div>
    <div class="seg"><button class="btn btn--primary btn--full" id="ppCreateBtn">＋ Create a pool</button><button class="btn btn--outline btn--full" id="ppCollectBtn">Collect to wallet</button></div>
    <div id="ppMine" style="margin-top:12px">${ppMineHtml(PP_MINE)}</div>
    <div class="card" style="margin-top:12px"><div class="card__title">Recovery</div>
      <div class="view__desc">Back up your pools (covenant params + a snapshot of the reserve coins — no seed) so you can re-track and withdraw them on any node. Cross-compatible with the phone app and the MDS MiniDapp.</div>
      <div class="seg"><button class="btn btn--outline btn--full" id="ppBackupBtn">Back up</button><button class="btn btn--outline btn--full" id="ppRestoreBtn">Restore</button><button class="btn btn--outline btn--full" id="ppGuideBtn">How it works</button></div></div>`;
  wirePpHeader(); wirePpCopy(el("ppMine")); wirePpMineActions(el("ppMine"));
  el("ppCreateBtn").onclick = showPpCreate;
  el("ppCollectBtn").onclick = doPpCollect;
  el("ppBackupBtn").onclick = showPpBackup;
  el("ppRestoreBtn").onclick = showPpRestore;
  el("ppGuideBtn").onclick = showPpGuide;
}
let ppBackupBusy = false;
async function showPpBackup() {
  if (ppBackupBusy) return;                                        // async fetch → guard against a double-click stacking modals
  ppBackupBusy = true;
  const prog = showProgress("Preparing backup…", "Snapshotting your pools' current reserve coins…");
  let r; try { r = await api.ppBackup(); } catch (e) { prog.close(); ppBackupBusy = false; toast("Backup failed: " + e.message, "err"); return; }
  prog.close();
  ppBackupBusy = false;
  if (r && r.empty) { toast("No pools to back up yet — create one first.", "err"); return; }
  const json = (r && r.json) || "";
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ppbOv"><div class="modal">
    <div class="modal__title">Your pool backup</div>
    <div class="view__desc">Save this somewhere safe. To restore later, paste it into Restore on any device. Public data only — no seed.</div>
    <textarea class="field__input" id="ppbTa" readonly style="min-height:150px;font-family:monospace;font-size:11px">${esc(json)}</textarea>
    <div class="seg" style="margin-top:10px"><button class="btn btn--outline btn--full" id="ppbCopy">Copy</button><button class="btn btn--primary btn--full" id="ppbSave">Save file</button></div>
    <button class="btn btn--outline btn--full" id="ppbClose" style="margin-top:8px">Done</button></div></div>`);
  const ov = el("ppbOv"); const close = () => { if (ov) ov.remove(); };
  el("ppbClose").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppbOv") close(); };
  el("ppbCopy").onclick = () => { copy(json); toast("Copied ✓", "ok"); };
  el("ppbSave").onclick = async () => { try { const s = await api.ppSaveBackup(json); if (s && !s.canceled) toast("Saved ✓", "ok"); } catch (e) { toast("Save failed: " + e.message, "err"); } };
}
async function showPpRestore() {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="pprOv"><div class="modal">
    <div class="modal__title">Restore pools</div>
    <div class="view__desc">Paste a PandaPools backup (or load a file). This re-tracks your pools on THIS node and re-imports the reserve coins so you can withdraw again — even on a brand-new node. Only restore backups you trust.</div>
    <textarea class="field__input" id="pprTa" placeholder="…paste backup JSON here" style="min-height:130px;font-family:monospace;font-size:11px"></textarea>
    <div class="view__desc" id="pprStatus" style="margin-top:6px"></div>
    <div class="seg" style="margin-top:8px"><button class="btn btn--outline btn--full" id="pprFile">Load file</button><button class="btn btn--primary btn--full" id="pprGo">Restore</button></div>
    <button class="btn btn--outline btn--full" id="pprCancel" style="margin-top:8px">Cancel</button></div></div>`);
  const ov = el("pprOv"); const close = () => { if (ov) ov.remove(); };
  el("pprCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "pprOv") close(); };
  el("pprFile").onclick = async () => { try { const f = await api.ppLoadBackup(); if (f && f.error) { toast(f.error, "err"); return; } if (f && !f.canceled && el("pprTa")) el("pprTa").value = f.json || ""; } catch (e) {} };
  let busy = false;
  el("pprGo").onclick = async () => {
    if (busy) return;
    const json = (el("pprTa") && el("pprTa").value || "").trim();
    if (!json) { toast("Paste a backup, or load a file.", "err"); return; }
    busy = true;
    if (el("pprStatus")) el("pprStatus").textContent = "Restoring…";
    try {
      const r = await api.ppRestore(json);
      if (el("pprStatus")) el("pprStatus").textContent = "Re-tracked " + r.restored + " of " + r.total + " pool" + (r.total === 1 ? "" : "s") + (r.regen ? " (regenerated " + r.regen + " owner key" + (r.regen === 1 ? "" : "s") + ")" : "") + " — rescanning…";
      toast("Restored ✓", "ok");
      setTimeout(() => { close(); renderPandapools(); }, 1600);
    } catch (e) { if (el("pprStatus")) el("pprStatus").textContent = e.message; toast("Restore failed: " + e.message, "err"); }
    finally { busy = false; }
  };
}
function showPpGuide() {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ppgOv"><div class="modal">
    <div class="modal__title">How pool recovery works</div>
    <div class="view__desc" style="white-space:pre-wrap">Your pools are recoverable at several levels:

• RECIPE — this app keeps a recipe (covenant + params) for every pool you own, so it can always re-derive and re-track them.
• RE-TRACK — on launch it re-registers any owned covenant a resynced/wiped node lost, so discovery finds them again.
• BACKUP — “Back up” exports those recipes plus a fresh snapshot of each reserve coin (public data only, no seed). “Restore” re-tracks + re-imports them on ANY node — even a brand-new one — and regenerates your owner keys so the pools are withdrawable.
• KEEP-FRESH — while this app is open, it recreates your pools' reserves before they age out, so every light node keeps seeing and trading them.
• GOSSIP — it re-posts faded discovery beacons for pools it knows, so they stay findable even while their creator is offline.

Last resort: your seed + a MegaMMR resync restores the coins; the recipe re-tracks the pools.</div>
    <button class="btn btn--outline btn--full" id="ppgClose" style="margin-top:10px">Close</button></div></div>`);
  const ov = el("ppgOv"); const close = () => { if (ov) ov.remove(); };
  el("ppgClose").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppgOv") close(); };
}
let ppCollectBusy = false;
async function doPpCollect() {
  if (ppCollectBusy) return;                                     // block a double-click (two concurrent sweeps + stacked overlays)
  ppCollectBusy = true;
  const okc = await showConfirm("Collect to wallet?", "Move any withdrawn/migrated reserves from your pool owner addresses into your default wallet.", "Collect");
  if (!okc) { ppCollectBusy = false; return; }
  const prog = showProgress("Collecting…", "Moving any withdrawn reserves from your owner addresses into your default wallet…");
  try {
    const r = await api.ppCollect();
    prog.close();
    toast(r && r.coins ? "Collected " + r.coins + " coin(s) to your wallet ✓" : "Nothing to collect right now.", "ok");
    renderPandapools();
  } catch (e) { prog.close(); toast("Collect failed: " + e.message, "err"); }
  finally { ppCollectBusy = false; }
}
// ---- LP management sheets (create / add / migrate / withdraw) ----
// Token-leg decimals, defensively parsed + clamped (a wrong value → token-grain rejection at createPool).
function ppSafeDec(token) { const d = parseInt(token && token.decimals, 10); return Number.isFinite(d) && d >= 0 && d <= 18 ? d : 8; }
// Create is USDT-only + price-anchored, mirroring the MDS dapp (0.6.6): a pool always opens at the true
// MINIMA/USDT rate (MEXC market → live-pool spot). Free-ratio manual create is the tier-3 fallback for the
// very first pool only. openCreate → dispatchCreate → createFormPriced (enter USDT) | createFormManual.
async function showPpCreate() {
  const bal = await tryCmd("balance") || [];
  let usdtId = "";
  try { const mt = await api.ppMarketToken(); usdtId = (mt && mt.usdt) || ""; } catch (e) {}
  const isFed = (tid) => !!tid && !!usdtId && tid.toLowerCase() === usdtId.toLowerCase();
  let minimaAvail = 0;
  const toks = [];
  bal.forEach(b => {
    const tid = b.tokenid || "";
    if (tid === MINIMA || tid === "0x00") { minimaAvail = parseFloat(b.sendable) || 0; return; }   // MINIMA is the other leg
    const sendable = parseFloat(b.sendable) || 0;
    if (!tid || sendable <= 0 || !isFed(tid)) return;   // ONLY market-fed pairs (mxUSDT) — no mispriceable pools
    toks.push({ tokenid: tid, name: TOK.tokenName(b.token, tid), dec: ppSafeDec(b.token), avail: sendable });
  });
  if (!toks.length) {
    await showConfirm("Get mxUSDT first",
      "PandaPools creates MINIMA / USDT pools — the pair with a live market price, so a pool always opens at the true rate. Your wallet holds no mxUSDT; receive some first, then create a pool.", "OK");
    return;
  }
  if (toks.length === 1) { ppDispatchCreate(toks[0], minimaAvail); return; }
  const opts = toks.map((t, i) => `<option value="${i}">${esc(t.name)} — ${esc(String(t.avail))} avail</option>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ppcPickOv"><div class="modal">
    <div class="modal__title">Pool MINIMA with…</div>
    <div class="field"><select class="field__input" id="ppcPick">${opts}</select></div>
    <div class="seg" style="margin-top:6px"><button class="btn btn--outline btn--full" id="ppcPickCancel">Cancel</button><button class="btn btn--primary btn--full" id="ppcPickGo">Next</button></div></div></div>`);
  const ov = el("ppcPickOv"); const close = () => { if (ov) ov.remove(); };
  el("ppcPickCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcPickOv") close(); };
  el("ppcPickGo").onclick = () => { const t = toks[el("ppcPick").value | 0]; close(); if (t) ppDispatchCreate(t, minimaAvail); };
}

async function ppDispatchCreate(t, minimaAvail) {
  let a = null;
  try { a = await api.ppCreateAnchor(); } catch (e) {}
  if (a && a.price) ppCreateFormPriced(t, minimaAvail, a.price, a.source || "market");
  else ppCreateFormManual(t);   // tier-3: no MEXC AND no live pool — user sets the first price
}

// Tier 1/2 ANCHORED priced form: enter USDT only; MINIMA is DERIVED from the anchor (no free ratio).
function ppCreateFormPriced(t, minimaAvail, initPrice, initSource) {
  let price = initPrice, source = initSource;
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ppcOv"><div class="modal">
    <div class="modal__title">Create MINIMA / ${esc(t.name)} pool</div>
    <div class="field"><div class="field__label">${esc(t.name)} to provide</div><input class="field__input" id="ppcU" placeholder="e.g. 1.90" autocomplete="off" /></div>
    <div class="view__desc" id="ppcInfo" style="white-space:pre-wrap"></div>
    <div class="seg" style="margin-top:6px"><button class="btn btn--outline btn--full" id="ppcCancel">Cancel</button><button class="btn btn--outline btn--full" id="ppcRefresh">↻ Price</button><button class="btn btn--primary btn--full" id="ppcGo">Create</button></div></div></div>`);
  const ov = el("ppcOv"); const close = () => { if (ov) ov.remove(); };
  el("ppcCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcOv") close(); };
  const info = () => el("ppcInfo");
  const derive = (u, p) => Math.ceil((u / p) * 1e6) / 1e6;   // MINIMA = USDT ÷ price, rounded UP to the 6dp grain
  const numOk = (v) => /^[0-9]*\.?[0-9]+$/.test(v) && parseFloat(v) > 0;   // strict — reject "1.5abc" before it reaches createPool
  function update() {
    if (!info()) return;
    const p = parseFloat(price);
    if (!(p > 0)) { info().textContent = "Fetching MINIMA/USDT market price…"; return; }
    let cap = minimaAvail * p; if (t.avail < cap) cap = t.avail;
    let str = "Price: " + TOK.tidyAmount(price) + " USDT/MINIMA (" + source + ")\n";
    str += "You have: " + TOK.tidyAmount(String(minimaAvail)) + " MINIMA · " + TOK.tidyAmount(String(t.avail)) + " " + t.name + "\n";
    const uRaw = (el("ppcU") && el("ppcU").value || "").trim();
    if (!numOk(uRaw)) { str += "Enter the " + t.name + " amount to provide (max ≈ " + TOK.tidyAmount(String(cap)) + ")."; }
    else {
      const u = parseFloat(uRaw);
      const minima = derive(u, p);
      str += "MINIMA required:  " + TOK.tidyAmount(String(minima)) + "\nTotal pool value:  ≈ US$ " + TOK.tidyAmount(String(u * 2));
      if (minima > minimaAvail) str += "\n⚠ Not enough MINIMA — reduce " + t.name + " to ≤ " + TOK.tidyAmount(String(cap)) + ".";
      if (u > t.avail) str += "\n⚠ You only have " + TOK.tidyAmount(String(t.avail)) + " " + t.name + ".";
    }
    info().textContent = str;
  }
  el("ppcU").oninput = update;
  el("ppcRefresh").onclick = async () => {
    if (info()) info().textContent = "Refreshing price…";
    try { const m = await api.ppMarket(); if (m && m.mid) { price = m.mid; source = "MEXC market"; } } catch (e) {}
    update();
  };
  let busy = false;
  el("ppcGo").onclick = async () => {
    if (busy) return;
    const p = parseFloat(price);
    if (!(p > 0)) { if (info()) info().textContent = "No price yet — tap ↻ Price and retry."; return; }
    const uStr = (el("ppcU").value || "").trim();
    if (!numOk(uStr)) { if (info()) info().textContent = "Enter the " + t.name + " amount (a positive number)."; return; }
    const u = parseFloat(uStr);
    const minima = derive(u, p);
    if (minima > minimaAvail || u > t.avail) { if (info()) info().textContent = "Not enough balance for that amount."; return; }
    busy = true;
    const okc = await showConfirm("Create this pool?",
      "MINIMA / " + t.name + " pool\n\n" + TOK.tidyAmount(String(minima)) + " MINIMA  +  " + uStr + " " + t.name + "\nOpens at " + TOK.tidyAmount(price) + " USDT/MINIMA  (matches " + source + " ✓)\n\nThe 0.5% swap fee goes to liquidity providers.", "Create");
    if (!okc) { busy = false; return; }
    close();
    const prog = showProgress("Creating pool…", "Posting to the chain — this can take a few seconds…");
    try { await api.ppCreate(t.tokenid, t.dec, String(minima), uStr); prog.close(); toast("Pool created ✓", "ok"); renderPandapools(); }
    catch (e) { prog.close(); toast("Create failed: " + e.message, "err"); }
    finally { busy = false; }
  };
  update();
}

// Tier 3 BOOTSTRAP: reached ONLY when no MEXC price AND no live MINIMA/USDT pool (the first pool). Creator sets
// the opening price; gated behind an explicit acknowledgement + the confirm step.
function ppCreateFormManual(t) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="ppcOv"><div class="modal">
    <div class="modal__title">Create MINIMA / ${esc(t.name)} pool</div>
    <div class="view__desc" style="color:var(--red)">No market price is available (MEXC is unreachable and there are no live MINIMA / ${esc(t.name)} pools to match). You are setting the OPENING PRICE yourself — set it to the true market rate, or arbitrageurs will correct it at your expense.</div>
    <div class="field"><div class="field__label">MINIMA to deposit</div><input class="field__input" id="ppcX" placeholder="e.g. 100" autocomplete="off" /></div>
    <div class="field"><div class="field__label">${esc(t.name)} to deposit</div><input class="field__input" id="ppcY" placeholder="e.g. 0.56" autocomplete="off" /></div>
    <div class="view__desc" id="ppcPreview" style="white-space:pre-wrap">Enter both amounts to see the opening price.</div>
    <label style="display:block;margin:6px 0;font-size:12px"><input type="checkbox" id="ppcAck" style="margin-right:6px" />I understand I'm setting the opening price with no market to check it against.</label>
    <div class="seg" style="margin-top:6px"><button class="btn btn--outline btn--full" id="ppcCancel">Cancel</button><button class="btn btn--primary btn--full" id="ppcGo">Create</button></div></div></div>`);
  const ov = el("ppcOv"); const close = () => { if (ov) ov.remove(); };
  el("ppcCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcOv") close(); };
  const numOk = (v) => /^[0-9]*\.?[0-9]+$/.test(v) && parseFloat(v) > 0;
  const updatePreview = async () => {
    const x = (el("ppcX") && el("ppcX").value || "").trim(), y = (el("ppcY") && el("ppcY").value || "").trim();
    if (!numOk(x) || !numOk(y)) { if (el("ppcPreview")) el("ppcPreview").textContent = "Enter both amounts to see the opening price."; return; }
    const pv = await api.ppCreatePreview(t.dec, x, y).catch(() => ({ ok: false }));
    if (el("ppcPreview")) el("ppcPreview").textContent = pv && pv.ok
      ? "Opening price:  " + TOK.tidyAmount(pv.price) + " " + t.name + " / MINIMA\nProduct floor (KMIN):  " + pv.kmin
      : ((pv && pv.msg) || "Enter both amounts.");
  };
  el("ppcX").oninput = updatePreview; el("ppcY").oninput = updatePreview;
  let busy = false;
  el("ppcGo").onclick = async () => {
    if (busy) return;
    const x0 = el("ppcX").value.trim(), y0 = el("ppcY").value.trim();
    if (!numOk(x0) || !numOk(y0)) { toast("Enter both reserves (positive).", "err"); return; }
    if (!el("ppcAck").checked) { toast("Tick the box to confirm you're setting the opening price.", "err"); return; }
    busy = true;
    const pv = await api.ppCreatePreview(t.dec, x0, y0).catch(() => ({ ok: false }));
    const priceLine = pv && pv.ok ? "⚠ No market price available — YOU are setting the opening price at " + TOK.tidyAmount(pv.price) + " " + t.name + " / MINIMA.\n" : "";
    const okc = await showConfirm("Create MINIMA / " + t.name + " pool?",
      x0 + " MINIMA  +  " + y0 + " " + t.name + "\n" + priceLine + "\nThe 0.5% swap fee goes to liquidity providers. On-chain; withdrawable later as the owner.", "Create");
    if (!okc) { busy = false; return; }
    close();
    const prog = showProgress("Creating pool…", "Posting to the chain — this can take a few seconds…");
    try { await api.ppCreate(t.tokenid, t.dec, x0, y0); prog.close(); toast("Pool created ✓", "ok"); renderPandapools(); }
    catch (e) { prog.close(); toast("Create failed: " + e.message, "err"); }
    finally { busy = false; }
  };
  updatePreview();
}
function ppTwoAmountSheet(title, desc, lblA, lblB, okLabel, onGo) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="pp2Ov"><div class="modal">
    <div class="modal__title">${esc(title)}</div><div class="view__desc">${esc(desc)}</div>
    <div class="field"><div class="field__label">${esc(lblA)}</div><input class="field__input" id="pp2A" placeholder="0.0" autocomplete="off" /></div>
    <div class="field"><div class="field__label">${esc(lblB)}</div><input class="field__input" id="pp2B" placeholder="0.0" autocomplete="off" /></div>
    <div class="seg" style="margin-top:10px"><button class="btn btn--outline btn--full" id="pp2Cancel">Cancel</button><button class="btn btn--primary btn--full" id="pp2Go">${esc(okLabel)}</button></div></div></div>`);
  const ov = el("pp2Ov"); const close = () => { if (ov) ov.remove(); };
  el("pp2Cancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "pp2Ov") close(); };
  let busy = false;
  el("pp2Go").onclick = async () => { if (busy) return; busy = true; try { await onGo(el("pp2A").value.trim(), el("pp2B").value.trim(), close); } finally { busy = false; } };
}
async function showPpDeposit(addr) {
  const p = PP_MINE.find(x => x.address === addr); if (!p) { toast("Pool not found.", "err"); return; }
  ppTwoAmountSheet("Add liquidity", "Grow MINIMA / " + (p.tokName || "token") + " in place (capped at 2× the floor — beyond that, use Migrate).",
    "Add MINIMA", "Add " + (p.tokName || "token"), "Add", async (a, b, close) => {
      const numOk = (v) => v === "" || /^[0-9]*\.?[0-9]+$/.test(v);
      if (!numOk(a) || !numOk(b) || ((parseFloat(a) || 0) <= 0 && (parseFloat(b) || 0) <= 0)) { toast("Enter an amount to add.", "err"); return; }
      const okc = await showConfirm("Add liquidity?", "Add " + (a || "0") + " MINIMA and " + (b || "0") + " " + (p.tokName || "token") + " to the pool. On-chain and irreversible.", "Add");
      if (!okc) return;
      close();
      const prog = showProgress("Adding liquidity…", "Posting to the chain…");
      try { await api.ppDeposit(addr, a || "0", b || "0"); prog.close(); toast("Liquidity added ✓", "ok"); renderPandapools(); }
      catch (e) { prog.close(); toast("Add failed: " + e.message, "err"); }
    });
}
async function showPpMigrate(addr) {
  const p = PP_MINE.find(x => x.address === addr); if (!p) { toast("Pool not found.", "err"); return; }
  ppTwoAmountSheet("Migrate pool", "Reset the pool to new reserves at a fresh address (resets the KMIN floor). The old reserves go to your owner address — use “Collect to wallet” to move them into your default wallet.",
    "New MINIMA reserve", "New " + (p.tokName || "token") + " reserve", "Migrate", async (a, b, close) => {
      if (!/^[0-9]*\.?[0-9]+$/.test(a) || parseFloat(a) <= 0 || !/^[0-9]*\.?[0-9]+$/.test(b) || parseFloat(b) <= 0) { toast("Enter both new reserves.", "err"); return; }
      const okc = await showConfirm("Migrate this pool?", "Old reserves go to your owner address (collect them with “Collect to wallet”); a new pool opens with " + a + " MINIMA / " + b + " " + (p.tokName || "token") + ".", "Migrate");
      if (!okc) return;
      close();
      const prog = showProgress("Migrating…", "Posting to the chain…");
      try { await api.ppMigrate(addr, a, b); prog.close(); toast("Migrated ✓", "ok"); renderPandapools(); }
      catch (e) { prog.close(); toast("Migrate failed: " + e.message, "err"); }
    });
}
let ppWithdrawBusy = false;
async function confirmPpWithdraw(addr) {
  if (ppWithdrawBusy) return;
  ppWithdrawBusy = true;
  try {
    const p = PP_MINE.find(x => x.address === addr);
    const ok = await showConfirm("Withdraw this pool?",
      "Sweep the reserves" + (p ? " (" + TOK.tidyAmount(p.reserveM) + " MINIMA · " + TOK.tidyAmount(p.reserveT) + " " + (p.tokName || "") + ")" : "") + " to your owner address (spendable on this node). The pool closes. Then use “Collect to wallet” to move them into your default wallet — do that before restoring your seed on another node.", "Withdraw", true);
    if (!ok) return;
    const prog = showProgress("Withdrawing…", "Posting to the chain…");
    try { await api.ppClose(addr); prog.close(); toast("Withdrawn ✓ — at your owner address; use “Collect to wallet” to move it to your wallet", "ok"); renderPandapools(); }
    catch (e) { prog.close(); toast("Withdraw failed: " + e.message, "err"); }
  } finally { ppWithdrawBusy = false; }
}
async function renderPpActivity() {
  const host = el("ppBody");
  const [acts, feed] = await Promise.all([api.ppActivity().catch(() => []), api.ppFeed().catch(() => [])]);
  host.innerHTML = `${ppHeader("activity")}
    <div class="card" id="ppActs"><div class="card__title">Your activity</div>${ppActsHtml(acts)}</div>
    <div class="card" id="ppFeed"><div class="card__title">Market feed <span class="mail-ver">all pools</span></div>${ppFeedHtml(feed)}</div>`;
  wirePpHeader();
}
// Live scan updates: patch ONLY the passive list container of the active sub-view IN PLACE (preserve scroll); never
// rebuild the header or any form (the "frozen tab" rule — matters once swap/create inputs land in later steps).
let ppUpdateTimer = null;
function onPandapoolsUpdate() {
  if (ppUpdateTimer) return;
  ppUpdateTimer = setTimeout(() => { ppUpdateTimer = null; refreshPpActive().catch(() => {}); }, 400);
}
async function refreshPpActive() {
  const body = el("ppBody");
  if (!body || activeView !== "pandapools") return;
  const sy = body.scrollTop;
  if (ppView === "swap") {
    ppUpdateQuote(); refreshPpSwapMeta();   // refresh quote + pool line + balances (passive regions only; never the input/form)
    return;
  }
  if (ppView === "pools") {
    if (!el("ppList")) return;
    PP_POOLS = await api.ppPools().catch(() => []);
    const c = el("ppList"); if (c) { c.innerHTML = ppPairRows(PP_POOLS); wirePpPoolRows(c); }
  } else if (ppView === "mylp") {
    if (!el("ppMine")) return;
    PP_MINE = await api.ppMyPools().catch(() => []);
    const c = el("ppMine"); if (c) { c.innerHTML = ppMineHtml(PP_MINE); wirePpCopy(c); wirePpMineActions(c); }
  } else if (ppView === "activity") {
    if (!el("ppActs")) return;
    const [acts, feed] = await Promise.all([api.ppActivity().catch(() => []), api.ppFeed().catch(() => [])]);
    if (el("ppActs")) el("ppActs").innerHTML = `<div class="card__title">Your activity</div>${ppActsHtml(acts)}`;
    if (el("ppFeed")) el("ppFeed").innerHTML = `<div class="card__title">Market feed <span class="mail-ver">all pools</span></div>${ppFeedHtml(feed)}`;
  }
  if (el("ppBody")) el("ppBody").scrollTop = sy;
}

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
const HIST_NORM_VER = 3;   // bump when normalize()'s classification changes → re-normalizes already-stored rows once
async function loadOwnAddresses() {
  try {
    const j = await api.cmd("scripts");
    let arr = j && j.response;
    arr = Array.isArray(arr) ? arr : (arr && arr.scripts) || [];
    const set = new Set();
    for (const s of arr) {
      if (!s || s.simple !== true) continue;   // own signable address; covenants (anyone-can-spend) are simple:false
      if (s.miniaddress) set.add(String(s.miniaddress));
      if (s.address) set.add(String(s.address).toLowerCase());
    }
    if (set.size) HIST_OWN = set;
  } catch (e) { /* leave HIST_OWN null → normalize falls back to the node's own difference */ }
  return HIST_OWN;
}

async function renderHistory() {
  ensureHistActions();
  await ensureHistFilter();
  if (running) {
    if (!HIST_OWN || !HIST_OWN.size) await loadOwnAddresses();
    const rebuilt = await maybeRebuildHistory();   // one-time re-fetch to backfill real token amounts (tokenamount)
    if (!rebuilt) await renormalizeStored();        // otherwise reclassify stored rows in place
  }
  await renderHistoryList();
  if (running) syncHistory({ older: false });
}
function ensureHistActions() {
  el("histActions").innerHTML =
    `<button class="btn btn--sm btn--outline" id="histRefresh">Refresh</button>
     <button class="btn btn--sm btn--outline" id="histCopy">Copy</button>
     <button class="btn btn--sm btn--outline" id="histCsv">Export CSV</button>`;
  el("histRefresh").onclick = () => { if (running) syncHistory({ older: false }); };
  el("histCopy").onclick = () => copyHistory();
  el("histCsv").onclick = () => exportHistory();
}
async function ensureHistFilter() {
  const host = el("histFilter"); if (!host) return;
  const toks = await api.histTokens().catch(() => []);
  const tokOpts = [`<option value="">All tokens</option>`].concat(
    (toks || []).map(t => `<option value="${esc(t.tokenid)}"${t.tokenid === HIST_FILTER.token ? " selected" : ""}>${esc(t.name || TOK.shortId(t.tokenid))}</option>`)
  ).join("");
  const dirs = [["", "All"], ["in", "In"], ["out", "Out"], ["self", "Self"], ["split", "Split"], ["consolidation", "Consol."]];
  host.innerHTML = `
    <div class="hist-filter">
      <input id="histSearch" class="field__input hist-search" placeholder="Search address, token or txid…" value="${esc(HIST_FILTER.search)}" autocomplete="off" spellcheck="false" />
      <select id="histToken" class="field__input hist-tokensel">${tokOpts}</select>
    </div>
    <div class="seg hist-dirs" id="histDir">${dirs.map(([v, l]) => `<button class="btn btn--sm ${HIST_FILTER.direction === v ? "chip--active" : ""}" data-dir="${v}">${l}</button>`).join("")}</div>`;
  el("histSearch").oninput = (e) => { HIST_FILTER.search = e.target.value.trim(); HIST_DISPLAY = HIST_STEP; clearTimeout(histSearchTimer); histSearchTimer = setTimeout(renderHistoryList, 200); };
  el("histToken").onchange = (e) => { HIST_FILTER.token = e.target.value; HIST_DISPLAY = HIST_STEP; renderHistoryList(); };
  el("histDir").querySelectorAll("[data-dir]").forEach(b => b.onclick = () => {
    HIST_FILTER.direction = b.dataset.dir; HIST_DISPLAY = HIST_STEP;
    el("histDir").querySelectorAll("[data-dir]").forEach(x => x.classList.toggle("chip--active", x.dataset.dir === HIST_FILTER.direction));
    renderHistoryList();
  });
}
async function renderHistoryList() {
  const host = el("histList");
  const rows = await api.histQuery(Object.assign(histQueryArgs(), { limit: HIST_DISPLAY, offset: 0 }));
  HIST_ROWS = rows || [];
  if (!HIST_ROWS.length) {
    host.innerHTML = `<div class="empty">${histFilterActive() ? "No matching transactions." : (running ? "No transactions yet." : "Waiting for the node…")}</div>`;
    el("histMore").innerHTML = ""; return;
  }
  let tip = 0; try { const b = await tryCmd("block"); tip = parseInt((b && (b.block != null ? b.block : b)), 10) || 0; } catch (e) {}
  host.innerHTML = HIST_ROWS.map(histRowHtml).join("");
  host.querySelectorAll(".row[data-txid]").forEach(node => node.onclick = () => {
    const row = HIST_ROWS.find(x => x.txpowid === node.dataset.txid); if (row) showHistoryDetail(row, tip);
  });
  // Pager: more matching rows in the DB → "Show more"; else, unfiltered + running → fetch older from the node.
  if (HIST_ROWS.length >= HIST_DISPLAY) {
    el("histMore").innerHTML = `<button class="btn btn--outline btn--full" id="histMoreBtn">Show more</button>`;
    el("histMoreBtn").onclick = () => { HIST_DISPLAY += HIST_STEP; renderHistoryList(); };
  } else if (running && !histFilterActive()) {
    el("histMore").innerHTML = `<button class="btn btn--outline btn--full" id="histOlder">Fetch older from node</button>`;
    el("histOlder").onclick = () => syncHistory({ older: true });
  } else {
    el("histMore").innerHTML = "";
  }
}
function histRowHtml(r) {
  const glyph = r.direction === "in" ? "↓" : r.direction === "out" ? "↑" : "⟲";
  const cls = r.direction === "in" ? "row__l1--green" : r.direction === "out" ? "row__l1--red" : "";
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
  const who = labelFor(r.counterparty) || short(r.counterparty, 20);
  return `<div class="row" data-txid="${esc(r.txpowid)}" style="cursor:pointer">
    <div class="row__glyph ${cls}">${glyph}</div>
    <div class="row__mid"><div class="row__l1 ${cls}">${esc(l1)}</div><div class="row__l2">${esc(who)} · ${esc(relTime(r.time))}</div></div>
    <div class="row__r">#${esc(r.block)}</div></div>`;
}
// The counter (token) leg of a buy/sell row, read from the persisted difference map → {amt, name}.
function tradeCounter(r) {
  const d = r.difference || {};
  const tid = Object.keys(d).find(t => t !== MINIMA && !/^-?0*\.?0*$/.test(String(d[t])));
  if (!tid) return null;
  const coin = (r.inputs || []).concat(r.outputs || []).find(c => c.tokenid === tid);
  return { amt: String(d[tid]).replace(/^-/, ""), name: TOK.tokenName(coin && coin.token, tid) };
}
function showHistoryDetail(r, tip) {
  const conf = (tip && r.block) ? (tip - r.block + 1) : "";
  const timeStr = r.time ? new Date(r.time).toLocaleString() : "—";
  const lbl = labelFor(r.counterparty);
  const who = r.counterparty ? (lbl ? `${lbl} (${short(r.counterparty, 16)})` : r.counterparty) : "—";
  const deltas = Object.keys(r.difference || {}).map(t => `${esc(TOK.shortId(t))}: ${esc(TOK.tidyAmount(r.difference[t]))}`).join("<br>") || "—";
  // Each coin: amount + token → address, with the coinid and any state variables when present.
  const bd = (list) => (list && list.length ? list.map(c => {
    let line = `• ${esc(TOK.tidyAmount(c.amount))} ${esc(TOK.tokenName(c.token, c.tokenid))} → ${esc(short(c.address, 16))}`;
    if (c.coinid) line += ` <span class="hist-dim">${esc(short(c.coinid, 12))}</span>`;
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
    <div class="kv"><span class="kv__k">Block</span><span class="kv__v">#${esc(r.block)}${conf !== "" ? " · " + conf + " conf" : ""}</span></div>
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
// coin's mxUSDT shows as 2.8e-37); the node's decoded real value is `tokenamount`. MINIMA (0x00) has no tokenamount —
// its `amount` is already real. Getting this right is what lets a pool swap's mxUSDT leg be recovered (it settles into
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
  if (HIST_SYNCING) return { fetched: 0, reachable: false, completed: false }; HIST_SYNCING = true;
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
  const tc = (r.kind === "buy" || r.kind === "sell") ? tradeCounter(r) : null;   // the mxUSDT (token) leg of a swap
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
const FALLBACK_CMDS = ["balance", "coins", "send", "consolidate", "tokens", "tokencreate", "status", "block", "history",
  "getaddress", "newaddress", "keys", "vault", "backup", "tokenvalidate", "checkaddress", "scripts", "help", "txncreate",
  "txninput", "txnoutput", "txnsign", "txnpost", "txndelete", "megammrsync", "peers", "network", "quit", "coinexport",
  "coinimport", "cointrack", "newscript", "sendpoll", "runscript", "hash", "random", "convert", "maths", "mmrcreate"];
function parseHelpNames(h) {
  const out = new Set();
  const arr = Array.isArray(h) ? h : (h && (h.commands || h.response)) || [];
  if (Array.isArray(arr)) for (const c of arr) { if (typeof c === "string") out.add(c.split(/\s/)[0]); else if (c && c.command) out.add(String(c.command).split(/\s/)[0]); }
  else if (typeof h === "string") { (h.match(/\b[a-z][a-z0-9]{2,}\b/g) || []).forEach(w => out.add(w)); }
  return out.size ? [...out].sort() : FALLBACK_CMDS.slice();
}
function appendTerm(s) {
  TERM_OUT += (TERM_OUT ? "\n" : "") + s;
  if (TERM_OUT.length > 20000) TERM_OUT = TERM_OUT.slice(TERM_OUT.length - 20000);
  const out = el("termOut"); if (out) { out.textContent = TERM_OUT; out.scrollTop = out.scrollHeight; }
}
async function renderTerminal() {
  const out = el("termOut"), inp = el("termIn");
  out.textContent = TERM_OUT; out.scrollTop = out.scrollHeight;
  if (!TERM_CMDS && running) { const h = await tryCmd("help"); TERM_CMDS = parseHelpNames(h); }
  el("termClear").onclick = () => { TERM_OUT = ""; out.textContent = ""; };
  el("termCopy").onclick = () => copy(TERM_OUT);
  inp.onkeydown = async (e) => {
    if (e.key === "Enter") {
      const c = inp.value.trim(); if (!c) return;
      inp.value = ""; TERM_HIST.push(c); termIdx = TERM_HIST.length;
      appendTerm("> " + c);
      try { const r = await api.cmd(c); appendTerm(JSON.stringify(r, null, 2)); }
      catch (err) { appendTerm("error: " + (err && err.message || err)); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); if (!TERM_HIST.length) return;
      termIdx = Math.max(0, termIdx - 1); inp.value = TERM_HIST[termIdx] || "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault(); if (!TERM_HIST.length) return;
      termIdx = Math.min(TERM_HIST.length, termIdx + 1); inp.value = TERM_HIST[termIdx] || "";
    } else if (e.key === "Tab") {
      e.preventDefault();
      const parts = inp.value.split(" "), frag = parts[0];
      if (!frag || !TERM_CMDS) return;
      const matches = TERM_CMDS.filter(c => c.startsWith(frag));
      if (matches.length) { const i = matches.indexOf(frag); parts[0] = matches[(i + 1) % matches.length]; inp.value = parts.join(" "); }
    }
  };
  inp.focus();
}

// ---- Settings --------------------------------------------------------------
async function renderSettings() {
  const host = el("settingsBody");
  if (!running) { host.innerHTML = `<div class="spin">Waiting for the node…</div>`; return; }
  const [addr, keys, scripts] = await Promise.all([tryCmd("getaddress"), tryCmd("keys action:list"), tryCmd("scripts")]);
  const ku = keysInfo(keys);
  const kuRows = keyUsesRows(keys, scripts);
  const pct = ku.cap ? Math.min(100, Math.round(ku.used / ku.cap * 100)) : 0;
  const warn = pct >= 80;
  const labels = CFG.labels || {}, labelKeys = Object.keys(labels);
  const fullAddr = (addr && (addr.miniaddress || addr.address)) || "—";
  host.innerHTML = `
    <div class="card"><div class="card__title">Wallet</div>
      <div class="field__label">Your address</div>
      <div class="addrbox addrbox__addr" id="setAddr" title="Click to copy" style="margin-top:0">${esc(fullAddr)}</div>
      <button class="btn btn--outline btn--full" id="setReveal" style="margin-top:8px">Reveal seed phrase</button>
      <div class="addrbox" id="setSeed" style="display:none;white-space:normal;line-height:1.6"></div>
      <button class="btn btn--outline btn--full" id="setRestore">Restore from a different seed…</button>
    </div>
    <div class="card"><div class="card__title">Faucet — get free Minima</div>
      <div class="view__desc">Request a tiny amount of Minima to your address — enough to get started and send minimaMail.</div>
      <div class="field"><div class="field__label">Your address</div>
        <div class="seg"><input class="field__input" id="faucetAddr" placeholder="Mx… or 0x…" value="${esc(fullAddr === "—" ? "" : fullAddr)}" />
          <button class="btn btn--outline btn--sm" id="faucetMine">My address</button></div></div>
      <button class="btn btn--outline btn--full" id="faucetGo">Request Minima</button>
      <div class="status" id="faucetStatus"></div>
    </div>
    <div class="card"><div class="card__title">Resync chain</div>
      <div class="view__desc">Re-fetch the chain and your coins from a MegaMMR host (seconds). Use if the node is stuck or behind — with just a host, your seed, keys and key-uses are left untouched.</div>
      <div class="field"><div class="field__label">MegaMMR host (ip:port)</div><input class="field__input" id="setResyncHost" value="${esc(CFG.megammrHost)}" /></div>
      <label class="prow" style="margin-top:4px"><input type="checkbox" id="setResyncAdv"><span class="prow__l">Advanced parameters (full megammrsync)</span></label>
      <div id="setResyncAdvBox" style="display:none">
        <div class="view__desc" style="color:var(--amber)">⚠ Providing a seed phrase performs a FULL WALLET RESET to that seed (regenerates keys, sets key-uses) — not a plain resync. Leave the phrase blank for the safe chain-only resync.</div>
        <div class="field"><div class="field__label">Seed phrase (optional — resets the wallet)</div><textarea class="field__input" id="setResyncPhrase" rows="2" placeholder="blank = plain resync"></textarea></div>
        <label class="prow"><input type="checkbox" id="setResyncAnyphrase"><span class="prow__l">anyphrase (seed is any text, not BIP39 words)</span></label>
        <div class="field"><div class="field__label">Key-uses (signatures this seed has ever made; required with a seed)</div><input class="field__input" id="setResyncKeyuses" placeholder="0 if brand new" inputmode="numeric" /></div>
        <div class="field"><div class="field__label">Keys to generate (default 64)</div><input class="field__input" id="setResyncKeys" placeholder="64" inputmode="numeric" /></div>
        <div class="field"><div class="field__label">Restore from backup file (optional)</div><input class="field__input" id="setResyncFile" placeholder="path to a .bak file" /></div>
        <div class="field"><div class="field__label">Backup password (optional)</div><input class="field__input" id="setResyncPassword" type="password" /></div>
      </div>
      <button class="btn btn--outline btn--full" id="setResync">Resync now</button>
    </div>
    <div class="card"><div class="card__title">Signing keys (WOTS safety)</div>
      <div class="view__desc">Each key can sign a limited number of times; reusing an exhausted one-time key can lose funds. The node rotates keys automatically — this shows your headroom.</div>
      <div class="health"><div class="health__row"><span>Most-used key</span><span>${esc(ku.used)} / ${esc(ku.cap)} sigs${ku.count ? " · " + ku.count + " keys" : ""}</span></div>
        <div class="health__track"><div class="health__fill${warn ? " health__fill--warn" : ""}" style="width:${pct}%"></div></div></div>
      ${warn ? `<div class="status status--warn">⚠ A signing key is ${pct}% used — generate fresh keys or restore with the correct key-uses before it exhausts.</div>` : ""}
    </div>
    <div class="card"><div class="card__title">Address key-uses</div>
      <div class="view__desc">Every signing key can sign up to 262,144 times before it exhausts, and a one-time key that signs the same leaf twice is unsafe. This lists each key's address and how many signatures it has used. "Deep reuse audit" cross-checks the chain via your KeyUses service — the node's own counter can under-report.</div>
      <div id="kuList" class="ku-list">${kuRows.length ? kuRows.map(kuRowHtml).join("") : `<div class="view__desc">No keys reported.</div>`}</div>
      <button class="btn btn--outline btn--full" id="kuAudit" style="margin-top:10px">Deep reuse audit</button>
      <div class="status" id="kuAuditStatus"></div>
      <div class="view__desc" style="font-size:11px;margin-top:2px">The deep audit sends your public keys to your KeyUses service (eurobuddha.com) to check the chain for real reuse — automatically when you open this panel, and when you tap the button. Nothing else leaves your node.</div>
    </div>
    <div class="card"><div class="card__title">Backup</div>
      <div class="view__desc">Writes an encrypted recovery backup into the node's data folder. Your seed phrase (above) is the ultimate backup.</div>
      <div class="field"><input class="field__input" id="bkPw" type="password" placeholder="backup password" /></div>
      <button class="btn btn--outline btn--full" id="setBackup">Create encrypted backup</button>
    </div>
    <div class="card"><div class="card__title">Address labels</div>
      ${labelKeys.length ? labelKeys.map(a => `<div class="kv"><span class="kv__k" style="word-break:break-all">${esc(labels[a])} <span style="color:var(--dim2);font-size:11px">${esc(short(a, 24))}</span></span><button class="btn btn--sm btn--outline lbl-del" data-addr="${esc(a)}">Delete</button></div>`).join("") : `<div class="view__desc">No labels yet. Name an address in the Receive tab.</div>`}
    </div>
    <div class="card"><div class="card__title">History</div>
      <div class="view__desc">Your transaction history is stored locally (the node prunes old data). Clear it if you switch wallets.</div>
      <button class="btn btn--outline btn--full" id="setClearHist">Clear local history</button>
    </div>
    <div class="card"><div class="card__title">Diagnostics</div>
      <div class="field"><input class="field__input" id="diagCmd" placeholder="a node command, e.g. status" /></div>
      <button class="btn btn--sm btn--outline" id="diagGo">Run</button>
      <pre class="logbox" id="diagOut"></pre>
    </div>
    <div class="card"><div class="card__title">Appearance</div>
      <button class="btn btn--outline btn--full" id="setTheme">Theme: ${esc(CFG.theme)}</button>
    </div>`;
  el("setAddr").onclick = () => copy(fullAddr);
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
  el("setReveal").onclick = async () => { const v = await tryCmd("vault"); const p = seedFrom(v); if (!p) { toast("Couldn't read the seed.", "err"); return; } el("setSeed").style.display = ""; el("setSeed").textContent = p; };
  el("setRestore").onclick = () => showRestoreOverlay();
  el("setResyncAdv").onclick = () => { el("setResyncAdvBox").style.display = el("setResyncAdv").checked ? "" : "none"; };
  el("setResync").onclick = async () => {
    const rhost = el("setResyncHost").value.trim();
    if (!/^[\w.\-]+:\d+$/.test(rhost)) { toast("Host must be ip:port.", "err"); return; }
    let cmdStr = `megammrsync action:resync host:${rhost}`, resetsWallet = false;
    if (el("setResyncAdv").checked) {
      const phrase = el("setResyncPhrase").value.trim(), keyuses = el("setResyncKeyuses").value.trim();
      const keys = el("setResyncKeys").value.trim(), file = el("setResyncFile").value.trim(), password = el("setResyncPassword").value;
      if (phrase) {
        if (/["\\\n\r\t]/.test(phrase)) { toast("Seed phrase has a \", \\ or line break the command can't carry.", "err"); return; }
        if (!/^\d+$/.test(keyuses)) { toast("Enter key-uses when providing a seed (0 if brand new) — reusing WOTS keys can lose funds.", "err"); return; }
        cmdStr += ` phrase:"${phrase}"` + (el("setResyncAnyphrase").checked ? " anyphrase:true" : "");
        resetsWallet = true;
      }
      if (keyuses) { if (!/^\d+$/.test(keyuses)) { toast("Key-uses must be a whole number.", "err"); return; } cmdStr += ` keyuses:${keyuses}`; }
      if (keys) { if (!/^\d+$/.test(keys)) { toast("Keys must be a whole number.", "err"); return; } cmdStr += ` keys:${keys}`; }
      if (file) { if (/[\s"\\]/.test(file)) { toast("File path can't contain spaces or quotes.", "err"); return; } cmdStr += ` file:${file}`; }
      if (password) { if (/[\s"\\]/.test(password)) { toast("Password can't contain spaces or quotes.", "err"); return; } cmdStr += ` password:${password}`; }
    }
    const warn = resetsWallet
      ? "⚠ This RESETS your wallet to the entered seed (regenerates keys, sets key-uses). Continue?"
      : "Re-fetches the chain and your coins. Your seed, keys and key-uses are NOT changed. Continue?";
    if (!confirm("Resync from " + rhost + "?\n\n" + warn)) return;
    const btn = el("setResync"); btn.disabled = true; btn.textContent = "Resyncing…";
    try { await cmd(cmdStr); CFG = await api.saveConfig({ megammrHost: rhost });
      if (resetsWallet) { try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState(); try { await api.axInvalidate(); } catch (e) {} resetAxState(); try { await api.casinoInvalidate(); } catch (e) {} resetCasinoState(); }   // seed reset → re-derive the mail identity
      toast("Resync complete ✓", "ok"); renderBalances(); }
    catch (e) { toast("Resync failed: " + e.message, "err"); }
    btn.disabled = false; btn.textContent = "Resync now";
  };
  el("setBackup").onclick = async () => {
    const pw = el("bkPw").value.trim();
    if (!pw) { toast("Enter a backup password."); return; }
    try { await cmd(`backup password:"${pw}"`); toast("Encrypted backup written to the node data folder ✓", "ok"); }
    catch (e) { toast("Backup failed: " + e.message, "err"); }
  };
  host.querySelectorAll(".lbl-del").forEach(btn => btn.onclick = async () => {
    const nl = Object.assign({}, CFG.labels); delete nl[btn.dataset.addr];
    CFG = await api.saveConfig({ labels: nl }); toast("Label removed", "ok"); renderSettings();
  });
  el("setClearHist").onclick = async () => { await api.histClear(); toast("Local history cleared ✓", "ok"); };
  el("diagGo").onclick = async () => { const c = el("diagCmd").value.trim(); if (!c) return; try { const r = await api.cmd(c); el("diagOut").textContent = JSON.stringify(r, null, 2); } catch (e) { el("diagOut").textContent = e.message; } };
  el("setTheme").onclick = () => { cycleTheme(); renderSettings(); };
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
    status.textContent = "⚠ Reuse audit unavailable (KeyUses service unreachable) — showing local key-use counts only. Try again later.";
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
  if (!running) { card.innerHTML = `<div class="spin">Waiting for the node…</div>`; return; }
  // token dropdown source — the wallet's held coins/tokens (MINIMA first). No raw token-id typing.
  const bal = await tryCmd("balance") || [];
  SEND_TOKENS = bal.map(b => ({ tokenid: b.tokenid || MINIMA, name: TOK.tokenName(b.token, b.tokenid), sendable: b.sendable || "0",
    ticker: (b.tokenid || MINIMA) === MINIMA ? "MINIMA" : (TOK.ticker(b.token) || "") }));
  if (!SEND_TOKENS.some(t => t.tokenid === MINIMA)) SEND_TOKENS.unshift({ tokenid: MINIMA, name: "Minima", sendable: "0", ticker: "MINIMA" });
  SEND_TOKENS.sort((a, b) => (a.tokenid === MINIMA ? -1 : b.tokenid === MINIMA ? 1 : 0));
  card.innerHTML = `
    <div class="seg" id="sendModes">
      <button class="btn btn--sm btn--primary" data-mode="send">Send</button>
      <button class="btn btn--sm btn--outline" data-mode="split">Split</button>
      <button class="btn btn--sm btn--outline" data-mode="consolidate">Consolidate</button>
    </div>
    <div id="sendForm"></div>`;
  const modes = card.querySelectorAll("#sendModes .btn");
  let mode = "send";
  const paint = () => {
    modes.forEach(b => b.className = "btn btn--sm " + (b.dataset.mode === mode ? "btn--primary" : "btn--outline"));
    sendForm(mode);
  };
  modes.forEach(b => b.onclick = () => { mode = b.dataset.mode; paint(); });
  paint();
}
function sendForm(mode) {
  const f = el("sendForm");
  if (mode === "send") {
    // Preselect the token if we arrived from a token-detail modal's "Send" action.
    const preselect = SEND_PRESELECT; SEND_PRESELECT = null;
    f.innerHTML = `
      <div class="field"><div class="field__label">To address</div><input class="field__input" id="sTo" placeholder="Mx… or 0x…" /></div>
      <div class="field"><div class="field__label">Amount</div>
        <div class="seg"><input class="field__input" id="sAmt" placeholder="0.0" /><button class="btn btn--outline btn--sm" id="sMax" type="button">Max</button></div>
        <div class="field__hint" id="sAvail"></div></div>
      <div class="field"><div class="field__label">Token</div><select class="field__input" id="sTok">${tokenOptions()}</select></div>
      <button class="btn btn--primary btn--full" id="sGo">Send</button>`;
    if (preselect) el("sTok").value = preselect;
    const tokOf = (tid) => SEND_TOKENS.find(x => x.tokenid === tid) || {};
    const sendableOf = (tid) => tokOf(tid).sendable || "0";
    const refreshAvail = () => {
      const t = tokOf(el("sTok").value);
      el("sAvail").textContent = "Available: " + TOK.tidyAmount(t.sendable || "0") + (t.ticker ? " " + t.ticker : "");
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
        if (!chk) { toast("Couldn't validate the address (node busy?) — not sending.", "err"); el("sGo").disabled = false; el("sGo").textContent = "Send"; return; }
        const r = await cmd(`send address:${to} amount:${amt}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : ""));
        toast("Sent ✓ " + short((r && r.txpowid) || "", 12), "ok"); el("sTo").value = el("sAmt").value = ""; refreshAvail();
      } catch (e) { toast(e.message, "err"); }
      el("sGo").disabled = false; el("sGo").textContent = "Send";
    };
  } else if (mode === "split") {
    f.innerHTML = `
      <div class="view__desc">Split your own coins into equal pieces (useful for parallel sends).</div>
      <div class="field"><div class="field__label">Token</div><select class="field__input" id="spTok">${tokenOptions()}</select></div>
      <div class="field"><div class="field__label">Amount to split</div><input class="field__input" id="spAmt" placeholder="0.0" /></div>
      <div class="field"><div class="field__label">Into how many coins (2–20)</div><input class="field__input" id="spN" value="10" /></div>
      <button class="btn btn--primary btn--full" id="spGo">Split</button>`;
    el("spGo").onclick = async () => {
      const amt = el("spAmt").value.trim(), n = parseInt(el("spN").value, 10) || 0, tok = el("spTok").value;
      if (!validAmt(amt)) { toast("Enter a positive amount (digits only).", "err"); return; }
      if (n < 2 || n > 20) { toast("Split into 2–20 coins."); return; }
      if (!validTok(tok)) { toast("Token id must be a 0x… hex value.", "err"); return; }
      el("spGo").disabled = true;
      try { const a = await cmd("getaddress"); const addr = a.miniaddress || a.address;
        await cmd(`send address:${addr} amount:${amt} split:${n}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : "")); toast("Split ✓", "ok"); }
      catch (e) { toast(e.message, "err"); }
      el("spGo").disabled = false;
    };
  } else {
    f.innerHTML = `
      <div class="view__desc">Merge many small coins of one token into fewer, larger coins.</div>
      <div class="field"><div class="field__label">Token</div><select class="field__input" id="coTok">${tokenOptions()}</select></div>
      <button class="btn btn--primary btn--full" id="coGo">Consolidate</button>`;
    el("coGo").onclick = async () => {
      const tok = el("coTok").value || MINIMA;
      if (!validTok(tok)) { toast("Token id must be a 0x… hex value.", "err"); return; }
      el("coGo").disabled = true;
      try { await cmd(`consolidate tokenid:${tok}`); toast("Consolidated ✓", "ok"); }
      catch (e) { toast(e.message, "err"); }
      el("coGo").disabled = false;
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
  c.innerHTML = `
    <div class="kv"><span class="kv__k">State</span><span class="kv__v">${esc(s.state)}</span></div>
    <div class="kv"><span class="kv__k">Version</span><span class="kv__v">${esc(h.version || "—")}</span></div>
    <div class="kv"><span class="kv__k">Block</span><span class="kv__v">${esc(h.block ?? "—")}</span></div>
    <div class="kv"><span class="kv__k">Peers</span><span class="kv__v">${esc(h.connections ?? "—")}</span></div>
    <div class="kv"><span class="kv__k">Role</span><span class="kv__v">${contributing ? "Contributing (server)" : "Light wallet"}</span></div>
    ${help ? `<div class="kv"><span class="kv__k">Network help</span><span class="kv__v"${help.color ? ` style="color:${help.color}"` : ""}>${esc(help.text)}</span></div>` : ""}
    ${help && help.howto ? forwardHowTo(pm) : ""}
    ${contributing && showAddr ? `<div class="kv"><span class="kv__k">Public address</span><span class="kv__v">${esc(h.p2pAddress)}${addrOk ? " ✓" : ""}</span></div>` : ""}
    <div class="kv"><span class="kv__k">Network</span><span class="kv__v">${esc(CFG.network)}</span></div>
    <div class="kv"><span class="kv__k">RPC port</span><span class="kv__v">${esc(s.rpcPort || CFG.basePort + 4)}</span></div>
    ${s.lastError ? `<div class="kv"><span class="kv__k">Error</span><span class="kv__v kv__v--red">${esc(s.lastError)}</span></div>` : ""}
    <div class="seg" style="margin-top:10px">
      <button class="btn btn--sm btn--outline" id="nRestart">Restart node</button>
      <button class="btn btn--sm btn--outline" id="nUpdate">Check for update</button>
    </div>
    ${CFG.network !== "solo" ? `<button class="btn btn--outline btn--full" id="nContrib" style="margin-top:8px">Contribute to the network: ${contributing ? "On — turn off" : "Off — turn on"}</button>` : ""}
    <button class="btn btn--outline btn--full" id="nReconfig" style="margin-top:8px">Reconfigure node (network · new/restore · startup params)…</button>`;
  const nContrib = el("nContrib");
  if (nContrib) nContrib.onclick = async () => {
    const turnOn = !contributing;
    const msg = turnOn
      ? "Contribute to the network?\n\nYour node will accept incoming connections and help other nodes sync. This asks your router to open TCP " + CFG.basePort + " (UPnP), keeps ~50 days of block history (a one-time extra download), and restarts the node now.\n\nNot all routers allow this — if yours doesn't, you'll still help by relaying."
      : "Stop contributing?\n\nYour node goes back to a light wallet (outbound connections only), the router port is closed, and the node restarts now.";
    if (!confirm(msg)) return;
    const params = Object.assign({}, CFG.params, turnOn ? MINIMA_PARAMS.ROLE_CONTRIBUTE : MINIMA_PARAMS.ROLE_LIGHT);
    CFG = await api.saveConfig({ contribute: turnOn, params });
    toast(turnOn ? "Contributing — restarting node…" : "Back to light wallet — restarting node…");
    api.nodeRestart();
  };
  el("nReconfig").onclick = () => showSetup();
  el("nRestart").onclick = () => { toast("Restarting node…"); api.nodeRestart(); };
  el("nUpdate").onclick = async () => {
    toast("Checking for a node update…");
    const u = await api.checkJarUpdate();
    if (!u || !u.available) { toast((u && u.reason) || "You're on the latest node."); return; }
    if (!confirm("Update the node to " + u.version + "?\n\n" + (u.sha256 ? "The download is sha256-verified. " : "") + "The node will download, install, and restart.")) return;
    toast("Downloading + installing " + u.version + "…");
    try { await api.applyJarUpdate(u); toast("Node updated to " + u.version + " ✓ — restarting", "ok"); }
    catch (e) { toast("Update failed: " + e.message, "err"); }
  };
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

// ============================ AtomiX (atomic swaps) ============================
// The reused MDS engine runs in the main process (main/atomix/*); this renderer is a faithful transcription
// of the donor lib/ui.js flows into the desktop TERMINAL design system. Live updates patch PASSIVE regions
// only — never rebuild a form the user is typing into (the Mail frozen-tab rule).
let axView = "swap";                    // swap | market | activity | otc | wallet
let axSell = true;                      // swap direction
let axSlip = 4.2;                       // buy-sweep max slippage %
let axStatusCache = { ready: false };
let axLastBook = null;
let axMakerCfgCache = null;             // last maker read-model {cfg,manual,state,lastPublishMs} — for editor re-render on toggle
let axPegMode = null;                   // maker editor peg/manual toggle (null = defer to saved cfg.pegEnable)
let axEditing = false;                  // Market tab: editing your own order? (donor S.editing) — false shows Edit/Publish buttons
let axEnaMode = null;                   // maker editor "Enabled" switch (null = defer to saved state.withdrawn)
let axOracleMid = 0;                    // last live oracle mid (peg) — drives the ladder generator while pegged
let axPegPollTimer = null;              // interval polling the oracle price while the peg switch is on
let axUpdateTimer = null;

function resetAxState() { axView = "swap"; axSell = true; axSlip = 4.2; axStatusCache = { ready: false }; axLastBook = null; axAmt = ""; axBalsCache = null; axQuoteMeta = null; axEditing = false; axPegMode = null; axEnaMode = null; axStopPegPoll(); }
function resetCasinoState() { casinoView = "play"; casinoPick = {}; casinoStatusCache = null; }

function axHeader(active) {
  const st = axStatusCache;
  const ccy = st.currency === "minima" ? "MINIMA" : (st.currency === "mxusdt" ? "mxUSDT" : "…");
  const dot = st.ready ? '<span style="color:var(--green)">●</span> ' : '<span style="color:var(--amber)">●</span> ';
  const tabs = [["swap", "Swap"], ["market", "Market"], ["activity", "Activity"], ["otc", "OTC"], ["wallet", "Wallet"]]
    .map(([v, l]) => `<button class="btn btn--sm ${active === v ? "btn--primary" : "btn--outline"}" data-axview="${v}">${l}</button>`).join("");
  return `<div class="view__title">AtomiX <span class="mail-ver">${dot}${st.ready ? "live" : "starting…"} · ${esc(ccy)}</span>
      <button class="btn btn--sm btn--outline" id="axCcy" style="float:right">Switch to ${st.currency === "minima" ? "mxUSDT" : "MINIMA"}</button>
      <button class="btn btn--sm btn--outline" id="axHelp" style="float:right;margin-right:6px">?</button></div>
    <div class="seg" style="flex-wrap:wrap">${tabs}</div>`;
}
function wireAxHeader() {
  document.querySelectorAll("#axBody [data-axview]").forEach(b => b.onclick = () => { axView = b.dataset.axview; renderAtomix(); });
  const c = el("axCcy"); if (c) c.onclick = axSwitchCurrency;
  const h = el("axHelp"); if (h) h.onclick = axWelcome;
}

async function renderAtomix() {
  const host = el("axBody");
  if (!host) return;
  if (!running) { host.innerHTML = `<div class="empty">Start your node to use AtomiX.</div>`; return; }
  axStatusCache = await api.axStatus().catch(() => ({ ready: false }));
  // currency accent: mxUSDT = Tether green, MINIMA = orange (donor trading.js) — scoped to #view-atomix.
  const vroot = el("view-atomix"); if (vroot) vroot.setAttribute("data-axccy", axStatusCache.currency === "minima" ? "minima" : "mxusdt");
  if (!axStatusCache.ready) {
    host.innerHTML = `${axHeader(axView)}<div class="empty">AtomiX is starting on your node — deriving your swap identity and registering the covenant. This clears on its own in a few seconds.</div>`;
    wireAxHeader(); return;
  }
  if (axView === "swap") return renderAxSwap();
  if (axView === "market") return renderAxMarket();
  if (axView === "activity") return renderAxActivity();
  if (axView === "otc") return renderAxOtc();
  if (axView === "wallet") return renderAxWallet();
}

// ---- Swap ----
// donor swapplan (6dp grain) reproduced client-side for the LIVE typing estimate (labelled an estimate; the
// engine's exact BigDecimal math is used on Review/execute). computeUsdt=floor6(ccy×price); computeMinima=floor6(usdt÷price).
function ax6(x) { return isFinite(x) && x > 0 ? String(Math.floor(x * 1e6) / 1e6) : ""; }
function axCleanNum(v) { return String(v).replace(/[^0-9.]/g, ""); }
let axAmt = "";              // canonical ccy (mxUSDT/MINIMA) amount — bidirectional card keeps this
let axPreviewTimer = null, axQuoteMeta = null;
let axBalsCache = null;      // last wallet balances — instant paint; ETH reads are slow so we refresh async

async function renderAxSwap() {
  const host = el("axBody");
  const [b, swaps] = await Promise.all([api.axBook().catch(() => null), api.axSwaps().catch(() => [])]);
  axLastBook = b;
  const ccy = (b && b.label) || "mxUSDT";
  const bals = axBalsCache || { minima: "0", usdt: "0", eth: "0" };
  // refresh balances in the background (slow ETH reads) → patch the chips + stages without a full re-render
  api.axWallet().then(w => {
    if (!w || activeView !== "atomix" || axView !== "swap") return;
    axBalsCache = w.bals;
    const chips = el("axBody").querySelectorAll(".ax-chip .ax-avail");
    // send chip is index 0, receive chip index 1; send=ccy in SELL, USDT in BUY
    if (chips[0]) chips[0].textContent = "avail " + (axSell ? w.bals.minima : w.bals.usdt);
    if (chips[1]) chips[1].textContent = "avail " + (axSell ? w.bals.usdt : w.bals.minima);
    const st = el("axBody").querySelector(".ax-stages"); if (st) st.innerHTML = axStagesRows(swaps, w.bals, ccy);
  }).catch(() => {});
  const q = b || {};
  const have = axSell ? (q.bestBid > 0) : (q.bestAsk > 0);
  const price = axSell ? q.bestBid : q.bestAsk;
  const cap = axSell ? q.bidCap : q.askCap;
  axQuoteMeta = { price, cap, ccy };

  const noQuote = !have ? `<div class="card">
      <div style="font-weight:600">No one is quoting a ${axSell ? "buy" : "sell"} price right now.</div>
      <div class="empty" style="margin-top:6px">Check back soon, or open Market to place your own order and wait for a match.</div>
      <button class="btn btn--outline btn--sm" id="axOpenMarket" style="margin-top:8px">Open Market</button>
    </div>` : "";

  // market-context line — the swap page's at-a-glance book summary (maker count + best bid/ask + spread)
  const mktctx = b ? `<div class="ax-mktctx"><b>${b.scanned || 0}</b> maker${(b.scanned || 0) === 1 ? "" : "s"} on the book`
    + (b.bestBid ? ` · bid <b>${fmtPx(b.bestBid)}</b>` : "")
    + (b.bestAsk ? ` · ask <b>${fmtPx(b.bestAsk)}</b>` : "")
    + (b.bestBid && b.bestAsk ? ` · spread ${fmtPx(b.bestAsk - b.bestBid)}` : "") + `</div>` : "";

  const sendCcy = axSell;   // SELL → you send ccy; BUY → you send USDT
  const usdtEst = have ? ax6(Number(axAmt) * price) : "";
  const dual = have ? `<div class="card">
      <div class="field__label">YOU SEND</div>
      <div class="ax-amtrow">${axChip(sendCcy, ccy, bals)}<input class="ax-amt mono" id="ax${sendCcy ? "InCcy" : "InUsdt"}" inputmode="decimal" placeholder="0.00" value="${esc(sendCcy ? axAmt : usdtEst)}" autocomplete="off" /></div>
      <div class="ax-flip"><button class="btn btn--sm btn--outline" id="axFlip" title="Flip direction">⇅</button></div>
      <div class="field__label">YOU RECEIVE (estimate)</div>
      <div class="ax-amtrow">${axChip(!sendCcy, ccy, bals)}<input class="ax-amt mono" id="ax${sendCcy ? "InUsdt" : "InCcy"}" inputmode="decimal" placeholder="0.00" value="${esc(sendCcy ? usdtEst : axAmt)}" autocomplete="off" /></div>
      ${axSell ? "" : axSlipRow()}
      <div class="view__desc" id="axBestLine">${axBestLine(price, cap, ccy)}</div>
      <button class="btn btn--primary btn--full" id="axReview">Review swap</button>
      <div id="axStatusLine"></div>
    </div>` : "";

  host.innerHTML = `${axHeader("swap")}
    <div class="view__title" style="border:0;padding-bottom:2px">Swap ${esc(ccy)} ⇄ USDT</div>
    <div class="view__desc" style="margin-top:0">Enter an amount — see exactly what you'll get at the best price.</div>
    <div class="seg"><button class="btn btn--full ${axSell ? "btn--primary" : "btn--outline"}" id="axDirSell">Sell ${esc(ccy)}</button><button class="btn btn--full ${axSell ? "btn--outline" : "btn--primary"}" id="axDirBuy">Buy ${esc(ccy)}</button></div>
    ${mktctx}
    ${noQuote}${dual}
    ${axStages(swaps, bals, ccy)}`;
  wireAxHeader();
  el("axDirSell").onclick = () => { axSell = true; renderAxSwap(); };
  el("axDirBuy").onclick = () => { axSell = false; renderAxSwap(); };
  const om = el("axOpenMarket"); if (om) om.onclick = () => { axView = "market"; renderAtomix(); };
  const fl = el("axFlip"); if (fl) fl.onclick = () => { axSell = !axSell; renderAxSwap(); };
  wireAxSlipRow();
  const rv = el("axReview"); if (rv) rv.onclick = axDoReview;
  wireAxSwapInputs(price, ccy);
}

/** Coin chip with the live available balance (donor coinChip): disc badge + label + "avail X". */
function axChip(isCcy, ccy, bals) {
  const avail = isCcy ? bals.minima : bals.usdt;
  return `<div class="ax-chip"><span class="ax-disc${isCcy ? "" : " usdt"}">${isCcy ? "M" : "$"}</span><span class="ax-tick">${esc(isCcy ? ccy : "USDT")}</span><span class="ax-avail">avail ${esc(avail)}</span></div>`;
}
/** Bidirectional wiring: typing one field updates the OTHER (never the focused one) + refreshes the best-price
 *  line via a debounced exact engine preview. No re-render → the edited field keeps focus (donor rule). */
function wireAxSwapInputs(price, ccy) {
  const ccyIn = el("axInCcy"), usdtIn = el("axInUsdt");
  if (!ccyIn || !usdtIn) return;
  // strict numeric-only: keep at most one dot; sanitize the FIELD (not just axAmt) so text can't be entered.
  const sanitize = (inp) => { const c = axCleanNum(inp.value); if (c !== inp.value) { const at = inp.selectionStart; inp.value = c; try { inp.setSelectionRange(at - 1 < 0 ? 0 : at, at - 1 < 0 ? 0 : at); } catch (e) {} } return c; };
  ccyIn.addEventListener("input", () => {
    axAmt = sanitize(ccyIn);
    if (document.activeElement !== usdtIn) usdtIn.value = price > 0 && Number(axAmt) > 0 ? ax6(Number(axAmt) * price) : "";
    axSchedulePreview();
  });
  usdtIn.addEventListener("input", () => {
    const u = sanitize(usdtIn);
    axAmt = price > 0 && Number(u) > 0 ? ax6(Number(u) / price) : "";
    if (document.activeElement !== ccyIn) ccyIn.value = axAmt;
    axSchedulePreview();
  });
}
/** Debounced exact preview: refines the receive estimate + best-price line with the engine's real numbers
 *  (sweep avg differs from the single best price once the amount exceeds the best level's cap). */
function axSchedulePreview() {
  if (axPreviewTimer) clearTimeout(axPreviewTimer);
  axPreviewTimer = setTimeout(async () => {
    if (activeView !== "atomix" || axView !== "swap" || !axAmt) return;
    const pv = await api.axSwapPreview(axSell, axAmt, axSlip).catch(() => null);
    if (!pv || activeView !== "atomix" || axView !== "swap") return;
    const bl = el("axBestLine");
    if (pv.err) { if (bl) bl.textContent = pv.err; return; }
    const m = pv.meta || {};
    if (bl) bl.textContent = axBestLine(m.bestPrice, m.bestCap, m.label, m.depth);
    // refine the RECEIVE field with exact engine math (not the local float), but never the focused input
    const recv = axSell ? el("axInUsdt") : el("axInCcy");
    if (recv && document.activeElement !== recv) {
      const val = pv.single ? (axSell ? pv.single.usdt : pv.single.minima) : (axSell ? String(pv.plan.totalUsdt) : String(pv.plan.filledMinima));
      if (val != null) recv.value = val;
    }
  }, 250);
}
function axBestLine(price, cap, ccy, depth) {
  if (!(price > 0)) return "No live makers on the book right now.";
  let s = `Best price ${fmtPx(price)} USDT/${ccy}  ·  up to ~${fmtAbbrev(cap)} at best`;
  if (depth != null && depth > cap + 1e-9) s += `, ~${fmtAbbrev(depth)} across the book`;
  if (!axSell) s += "  ·  ETH gas per part";
  return s;
}
function axSlipRow() {
  return `<div class="kv"><span>Max slippage</span><span>${[2, 4.2].map(s => `<button class="btn btn--sm ${axSlip === s ? "btn--primary" : "btn--outline"}" data-axslip="${s}">${s}%</button>`).join("")}<button class="btn btn--sm ${axSlip !== 2 && axSlip !== 4.2 ? "btn--primary" : "btn--outline"}" id="axSlipCustom">${axSlip !== 2 && axSlip !== 4.2 ? axSlip + "%" : "Custom"}</button></span></div>`;
}
function wireAxSlipRow() {
  document.querySelectorAll("#axBody [data-axslip]").forEach(x => x.onclick = () => { axSlip = Number(x.dataset.axslip); renderAxSwap(); });
  const sc = el("axSlipCustom"); if (sc) sc.onclick = async () => {
    const v = await showPrompt("Custom max slippage", "", "e.g. 1.5", { message: "Percent (0.1 – 50). A BUY sweep will not take levels priced beyond this above the best ask." });
    const n = parseFloat(v); if (isFinite(n) && n >= 0.1 && n <= 50) { axSlip = Math.round(n * 10) / 10; renderAxSwap(); } else if (v != null) toast("Enter a percent between 0.1 and 50", "warn");
  };
}
// Price display — donor AX.fmt.px parity: 6 significant figures, trailing zeros stripped. (The old 2dp-above-1
// rounding collapsed a near-1.0 mxUSDT book to "1" on every row — the ladder looked empty/degenerate.)
function fmtPx(p) { p = Number(p); if (!isFinite(p) || p <= 0) return "0"; let s = p.toPrecision(6); if (s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; }

/** The "YOUR SWAP" stages tracker (donor stages()): node/balance readiness + the in-flight swap's 4 legs. */
function axStages(swaps, bals, ccy) {
  return `<div class="field__label" style="margin-top:16px">YOUR SWAP</div><div class="ax-stages">${axStagesRows(swaps, bals, ccy)}</div>`;
}
function axStagesRows(swaps, bals, ccy) {
  const gt = v => parseFloat(v) > 0;
  const rows = [];
  rows.push(axStageRow(axStatusCache.ready ? "done" : "warn", "Node ready"));
  if (axSell) rows.push(axStageRow(gt(bals.minima) ? "done" : "pending", ccy + " ready to sell"));
  else { rows.push(axStageRow(gt(bals.usdt) ? "done" : "pending", "USDT ready to spend")); rows.push(axStageRow(gt(bals.eth) ? "done" : "pending", "ETH for gas")); }
  const sw = (swaps || []).find(s => s.status !== "COMPLETE" && s.status !== "REFUNDED" && s.status !== "ERROR");
  if (sw) {
    rows.push(`<div class="ax-swapline mono">${esc(sw.sellamount)} ${esc(axTok(sw.selltoken))} → ${esc(sw.buyamount)} ${esc(axTok(sw.buytoken))} · ${esc(String(sw.role).toLowerCase())}</div>`);
    rows.push(axStageRow(axLegDone(sw, 1), "Locked your " + esc(sw.sellamount) + " " + esc(axTok(sw.selltoken))));
    rows.push(axStageRow(axLegDone(sw, 2), "Counterparty locks their side"));
    rows.push(axStageRow(axLegDone(sw, 3), "Claim your " + esc(sw.buyamount) + " " + esc(axTok(sw.buytoken))));
    rows.push(axStageRow(axLegDone(sw, 4), "Swap complete"));
  } else rows.push(axStageRow("pending", "Enter an amount and tap Review to begin"));
  return rows.join("");
}
function axStageRow(state, text) { return `<div class="ax-stage ${state}"><span class="sdot"></span><span>${text}</span></div>`; }
function axLegDone(sw, n) {
  const s = sw.status;
  if (s === "COMPLETE") return "done";
  if (s === "REFUNDED") return n === 1 ? "warn" : "pending";
  if (n === 1) return "done";
  if (n === 2) return (s === "LOCKED" || s === "CLAIMING") ? "active" : "pending";
  if (n === 3) return s === "CLAIMING" ? "active" : "pending";
  return "pending";
}

async function axDoReview() {
  if (!axAmt) { toast("Enter how much " + (axQuoteMeta ? axQuoteMeta.ccy : "mxUSDT") + " to " + (axSell ? "sell" : "buy"), "warn"); return; }
  const q = await api.axQuote(axSell, axAmt, axSlip).catch(e => ({ err: String(e.message || e) }));
  if (q.err) { toast(q.err, "warn"); return; }
  const ccy = q.label, sh = s => { const n = Number(s); return isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : s; };
  let title, msg;
  if (q.single) {
    title = "Review — Sell " + ccy;
    msg = `Sell  ${q.single.minima} ${ccy}\nReceive  ≈ ${q.single.usdt} USDT\n\nBest price ${fmtPx(q.single.price)} USDT/${ccy}\nCounterparty  ${axShort(q.single.maker)}\nThis locks your ${ccy} on-chain.`;
  } else {
    const p = q.plan, n = p.legs.length;
    const head = `Avg ${fmtPx(p.avgPrice)}  ·  worst ${fmtPx(p.worstPrice)} USDT/${ccy}${!axSell && p.slippagePct > 0 ? "  ·  within " + sh(p.slippagePct) + "% slippage" : ""}`;
    const parts = p.legs.map((l, i) => `Part ${i + 1} · ${l.minima} ${ccy} @ ${fmtPx(l.price)} → ${l.usdt} USDT · ${axShort(l.maker)}`).join("\n");
    const total = axSell ? `Total: sell ${sh(p.filledMinima)} ${ccy} · receive ≈ ${sh(p.totalUsdt)} USDT` : `Total: pay ≈ ${sh(p.totalUsdt)} USDT · receive ≈ ${sh(p.filledMinima)} ${ccy}`;
    const partial = p.partial ? `\n\nFills ${fmtAbbrev(p.filledMinima)} of ${fmtAbbrev(p.target)} ${ccy} — ${(!axSell && p.stopReason === "slippage") ? "the rest is priced beyond your " + sh(p.slippagePct) + "% slippage." : "the rest isn't available in the book right now."}` : "";
    const gas = !axSell ? `\n\nEach part is a separate Ethereum transaction — you pay ETH gas ${n} ${n === 1 ? "time." : "times."}` : "";
    title = axSell ? `Sell ${fmtAbbrev(p.filledMinima)} ${ccy} in ${n} ${n === 1 ? "part" : "parts"}` : `Buy ≈ ${fmtAbbrev(p.filledMinima)} ${ccy} for ≈ ${sh(p.totalUsdt)} USDT in ${n} ${n === 1 ? "part" : "parts"}`;
    msg = `${head}\n\n${parts}\n\n${total}${partial}${gas}`;
  }
  const go = await showConfirm(title, msg, q.plan && q.plan.legs.length > 1 ? "Start sweep" : "Start swap");
  if (!go) return;
  const rv = el("axReview"); if (rv) rv.disabled = true;
  const r = await api.axSwap(q.quoteId).catch(e => ({ err: String(e.message || e) }));
  if (r && r.err) { toast(r.err, "warn"); }
  else if (r) { toast(`✓ ${r.ok}/${r.of} leg${r.of === 1 ? "" : "s"} locked — watching for the counterparty.${r.stopped ? " " + r.stopped : ""}`, "ok"); axAmt = ""; }
  if (activeView === "atomix" && axView === "swap") renderAxSwap();
}
function axShort(pk) { pk = String(pk || ""); return pk.length < 14 ? pk : pk.slice(0, 8) + "…" + pk.slice(-6); }

// ---- Market (donor marketTab: order book · your market editor/actions · market history) ----
async function renderAxMarket() {
  const host = el("axBody");
  axStopPegPoll();
  const [b, mh, mc] = await Promise.all([api.axBook().catch(() => null), api.axMarketHistory().catch(() => ({ chart: [], recent: [] })), api.axMakerCfg().catch(() => null)]);
  axLastBook = b; axMakerCfgCache = mc;
  const ccy = b ? b.label : "mxUSDT";
  const count = b ? (b.scanned || 0) : 0;
  const others = b && b.makers > 0 && b.makers !== count ? ` · ${b.makers} other` : "";
  // "your market" — status line (LIVE / offline) + either the [Edit my order][Publish] actions or the editor.
  const yourMkt = axEditing
    ? axMakerEditor(mc, ccy, b)
    : `${axYourMarketStatus(mc, b)}<div class="ax-mkr-actions"><button class="btn btn--outline btn--full" id="axEdit">Edit my order</button><button class="btn btn--primary btn--full" id="axPublish">Publish</button></div>`;
  host.innerHTML = `${axHeader("market")}
    <div class="card"><div class="card__title">Order book · ${count} live${others}</div>
      <div class="view__desc">The live order book. Tap a price to trade, or publish your own offer.</div>
      <div class="ax-ladder">${axLadder(b, ccy)}</div>
      <button class="btn btn--outline btn--sm" id="axBookRefresh" style="margin-top:8px">Refresh</button>
    </div>
    <div class="card"><div class="card__title">Your market · ${esc(ccy)} ⇄ USDT</div><div id="axMktHost">${yourMkt}</div></div>
    ${axEditing ? "" : `<div class="card"><div class="card__title">Market history <span class="mail-ver">price only</span></div>
      <canvas id="axChart" width="640" height="160" style="width:100%;height:160px"></canvas>
      <div class="view__desc">${axHistLine(mh)}</div>${axHistRows(mh)}
    </div>`}`;
  wireAxHeader();
  el("axBookRefresh").onclick = renderAxMarket;
  // tap-to-trade: clicking a takeable level prefills the swap on the correct side (bid → you sell, ask → you buy)
  host.querySelectorAll(".ax-depth .ax-half[data-take]").forEach(h => h.onclick = () => { axSell = h.getAttribute("data-take") === "bid"; axView = "swap"; renderAtomix(); });
  if (axEditing) {
    axWireMakerEditor(ccy);
  } else {
    el("axEdit").onclick = () => { axEditing = true; axPegMode = null; renderAxMarket(); };
    el("axPublish").onclick = async () => { const btn = el("axPublish"); btn.disabled = true; btn.textContent = "Publishing…"; const r = await api.axMakerPublish().catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "✓ Market published", r && r.err ? "warn" : "ok"); renderAxMarket(); };
    setTimeout(() => { try { axDrawChart(el("axChart"), mh.chart); } catch (e) {} }, 0);
  }
}
/** "Your market" status: LIVE (own levels on the book, peg mid, last publish) or offline — so you can SEE your market. */
function axYourMarketStatus(mc, b) {
  const st = (mc && mc.state) || {};
  let mine = 0, mineRows = "";
  if (b) {
    (b.bids || []).forEach(r => { if (r.mine) { mine++; mineRows += `<div class="ax-mymkt-row"><span class="bidpx">BID ${fmtPx(r.p)}</span><span class="ax-sz">${fmtAbbrev(r.cap)}</span></div>`; } });
    (b.asks || []).forEach(r => { if (r.mine) { mine++; mineRows += `<div class="ax-mymkt-row"><span class="askpx">ASK ${fmtPx(r.p)}</span><span class="ax-sz">${fmtAbbrev(r.cap)}</span></div>`; } });
  }
  const live = mine > 0 && !st.withdrawn;
  const mid = st.lastMid || st.lastPrice;
  const txt = live
    ? `LIVE · ${mine} level${mine === 1 ? "" : "s"} on the book` + (mid ? ` · mid ${fmtPx(mid)}` : "") + (mc && mc.lastPublishMs ? ` · published ${axAgo(mc.lastPublishMs)}` : "")
    : (st.withdrawn ? "Offline · market withdrawn" : "Offline · you have no live order");
  return `<div class="ax-mkr-status ${live ? "live" : "off"}"><span class="dot"></span>${esc(txt)}</div>`
    + (live ? `<div class="ax-mymkt">${mineRows}</div>` : "");
}
/** The live depth ladder (donor marketTab): spread line + legend + up to 12 paired bid│ask rows. */
function axLadder(b, ccy) {
  if (!b || (!b.bids.length && !b.asks.length)) return `<div class="empty">No live orders yet. Publish one below, or wait for a counterparty.</div>`;
  let out = "";
  if (b.bestBid && b.bestAsk) out += `<div class="ax-spread">spread ${fmtPx(b.bestAsk - b.bestBid)} USDT · USDT per ${esc(ccy)}, size in ${esc(ccy)}</div>`;
  out += `<div class="ax-legend"><span class="sell">SELL ${esc(ccy)} (bid)</span><span class="buy">BUY ${esc(ccy)} (ask)</span></div>`;
  const n = Math.min(Math.max(b.bids.length, b.asks.length), 12);
  for (let i = 0; i < n; i++) out += axDepthRow(b.bids[i], b.asks[i], i === 0);
  return out;
}
function axDepthRow(bid, ask, best) {
  return `<div class="ax-depth${best ? " best" : ""}">${axDepthHalf(bid, true)}<span class="divider">│</span>${axDepthHalf(ask, false)}</div>`;
}
function axDepthHalf(row, isBid) {
  if (!row) return `<div class="ax-half${isBid ? " bid" : ""}"><span class="ax-sz">—</span></div>`;
  const take = !row.mine && row.cap > 0;
  const tag = row.mine ? `<span class="ax-tag you">you</span>` : `<span class="ax-tag">${esc(axShort(row.signer))}</span>`;
  return `<div class="ax-half${isBid ? " bid" : ""}${take ? " takeable" : ""}"${take ? ` data-take="${isBid ? "bid" : "ask"}"` : ""}>`
    + `<span class="top"><span class="ax-px ${isBid ? "bidpx" : "askpx"}">${fmtPx(row.p)}</span><span class="ax-sz">${fmtAbbrev(row.cap)}</span></span>${tag}</div>`;
}
// Size display — donor AX.fmt.abbrev parity: "—" for ≤0; floor to 2dp (<10) or 1dp (≥10); "k" ≥ 1000.
function fmtAbbrev(v) { v = Number(v); if (!(v > 0)) return "—"; const trim = x => { const dp = x < 10 ? 2 : 1, f = Math.pow(10, dp); return (Math.floor(x * f) / f).toString(); }; return v >= 1000 ? trim(v / 1000) + "k" : trim(v); }
function axHistLine(mh) {
  const last = mh.chart.length ? fmtPx(mh.chart[mh.chart.length - 1].price) : "—";
  let ex = 0, op = 0; (mh.recent || []).forEach(t => { if (t.status === "EXECUTED") ex++; else if (t.status === "OPEN") op++; });
  return `last ${last} · ${ex} filled · ${op} open`;
}
function axHistRows(mh) {
  if (!(mh.recent || []).length) return `<div class="empty">No trades observed yet — AtomiX records swaps network-wide as they happen (no backfill).</div>`;
  return mh.recent.map(t => {
    const cls = t.status === "EXECUTED" ? "var(--green)" : t.status === "REFUNDED" ? "var(--red)" : "var(--dim)";
    const lbl = t.status === "EXECUTED" ? "filled" : t.status === "REFUNDED" ? "cancelled" : "open";
    return `<div class="row" style="justify-content:space-between"><span class="mono">${fmtPx(t.price)}</span><span class="mono" style="color:var(--dim)">${fmtAbbrev(Number(t.sizeMinima))} M</span><span class="mail-ver" style="color:${cls}">${lbl}</span></div>`;
  }).join("");
}
function axDrawChart(canvas, data) {
  const cv = canvas && canvas.getContext && canvas.getContext("2d"); if (!cv) return;
  const w = canvas.width, h = canvas.height, padL = 46, padR = 8, padT = 8, padB = 16;
  const css = getComputedStyle(document.documentElement);
  const ACC = (css.getPropertyValue("--accent") || "#FF7358").trim(), DIM = (css.getPropertyValue("--dim") || "#888").trim();
  cv.clearRect(0, 0, w, h); cv.font = "11px monospace"; cv.fillStyle = DIM;
  if (!data || data.length < 2) { cv.fillText(!data || !data.length ? "Collecting market data…" : "need 2+ trades to chart", padL, h / 2); return; }
  let minP = Infinity, maxP = -Infinity, minB = Infinity, maxB = -Infinity;
  data.forEach(t => { minP = Math.min(minP, t.price); maxP = Math.max(maxP, t.price); minB = Math.min(minB, t.createdBlock); maxB = Math.max(maxB, t.createdBlock); });
  if (maxP <= minP) maxP = minP + Math.max(minP * 0.001, 1e-9); if (maxB <= minB) maxB = minB + 1;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const px = bk => padL + ((bk - minB) / (maxB - minB)) * plotW, py = v => padT + (1 - (v - minP) / (maxP - minP)) * plotH;
  cv.strokeStyle = DIM; cv.lineWidth = 1; cv.beginPath(); cv.moveTo(padL, padT); cv.lineTo(padL, h - padB); cv.lineTo(w - padR, h - padB); cv.stroke();
  cv.fillText(String(fmtPx(maxP)), 2, padT + 9); cv.fillText(String(fmtPx(minP)), 2, h - padB);
  cv.strokeStyle = ACC; cv.lineWidth = 2; cv.beginPath();
  data.forEach((t, i) => { const x = px(t.createdBlock), y = py(t.price); if (i === 0) cv.moveTo(x, y); else cv.lineTo(x, y); }); cv.stroke();
  cv.fillStyle = ACC; data.forEach(t => { cv.beginPath(); cv.arc(px(t.createdBlock), py(t.price), 2.5, 0, Math.PI * 2); cv.fill(); });
}
/** "12s ago" / "4m ago" / "2h ago" from an epoch-ms timestamp. */
function axAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago";
}
// donor editRow/editInput/toggle → label-left / input-right rows, an On/Off pill, exact donor labels.
function axEditRow(label, right) { return `<div class="ax-editrow"><span class="ax-editlabel">${label}</span>${right}</div>`; }
function axEditInput(id, val) { return `<input class="ax-editinput mono" id="${id}" inputmode="decimal" placeholder="0" value="${esc(val)}" autocomplete="off" />`; }
function axSwitch(id, on) { return `<button class="ax-switch${on ? " on" : ""}" id="${id}" role="switch" aria-checked="${on}"><span class="knob"></span></button>`; }
function axGenField(id, val, ph) { return `<input class="ax-genfield mono" id="${id}" inputmode="decimal" placeholder="${esc(ph || "")}" value="${esc(val == null ? "" : val)}" autocomplete="off" />`; }
// Generator field with a PERSISTENT "Name · unit" caption (label-left, reuses the .ax-editrow pattern) so the field
// is identifiable even with a value typed — placeholders alone vanish on input. Same id → wiring is unchanged.
function axGenRow(label, id, val) { return `<div class="ax-editrow"><span class="ax-editlabel">${label}</span>${axGenField(id, val, "0")}</div>`; }
/** One editable ladder level: tag (A1/B1…) + price + size. cls = "ask" | "bid". */
function axLevelRow(tag, idP, idA, pv, av, cls) {
  return `<div class="ax-lvl ${cls}"><span class="ax-lvl-tag">${tag}</span>`
    + `<input class="ax-lvl-p mono" id="${idP}" inputmode="decimal" placeholder="price" value="${esc(pv == null ? "" : pv)}" autocomplete="off" />`
    + `<input class="ax-lvl-a mono" id="${idA}" inputmode="decimal" placeholder="size" value="${esc(av == null ? "" : av)}" autocomplete="off" /></div>`;
}
/** Inline cockpit field: a small label + narrow input on one line (dense). */
function axFld(label, id, val) { return `<span class="ax-fld"><b>${label}</b>${axGenField(id, val, "")}</span>`; }
/** One editable ladder row, MIRRORING the read-only book (axDepthRow): bid half (amount OUTER / price INNER, via
 *  CSS row-reverse) │ ask half (price INNER / amount OUTER). Same rung IDs (axBidP/A, axAskP/A) → wiring unchanged. */
function axMakerRow(i, best, bp, ba, ap, aa) {
  const inp = (cls, id, v, ph) => `<input class="${cls} mono" id="${id}" inputmode="decimal" placeholder="${ph}" value="${esc(v == null ? "" : v)}" autocomplete="off" />`;
  return `<div class="ax-mrow${best ? " best" : ""}" id="axRow${i}">`
    + `<div class="ax-mhalf bid"><div class="top">${inp("ax-px bidpx", "axBidP" + i, bp, "price")}${inp("ax-sz", "axBidA" + i, ba, "size")}</div></div>`
    + `<span class="divider">│</span>`
    + `<div class="ax-mhalf ask"><div class="top">${inp("ax-px askpx", "axAskP" + i, ap, "price")}${inp("ax-sz", "axAskA" + i, aa, "size")}</div></div></div>`;
}
function axStartPegPoll(fn) { axStopPegPoll(); fn(); axPegPollTimer = setInterval(() => { if (activeView === "atomix" && axView === "market" && axEditing) fn(); else axStopPegPoll(); }, 2500); }
function axStopPegPoll() { if (axPegPollTimer) { clearInterval(axPegPollTimer); axPegPollTimer = null; } }
/** The maker editor — MIRRORS the read-only order book: a compact CONTROL COCKPIT (Enabled + Peg toggles, live
 *  oracle, and one row of fields mid·step·levels·size·skew·reprice) over a single ladder where BIDS are on the LEFT
 *  and ASKS on the RIGHT, prices meeting in the middle at the spread, amounts on the outer edges, best row on top.
 *  Auto (peg) mode by default; `size` seeds every rung and each amount stays editable; only `levels` rungs show. */
function axMakerEditor(mc, ccy, b) {
  const c = (mc && mc.cfg) || {}, st = (mc && mc.state) || {}, man = (mc && mc.manual) || { bids: [], asks: [] };
  const parity = b ? !!b.pricingParity : (axStatusCache.currency === "mxusdt");
  const src = parity ? "Parity" : "MEXC";
  const enabled = axEnaMode != null ? axEnaMode : !st.withdrawn;
  const peg = axPegMode != null ? axPegMode : (c.step > 0 ? !!c.pegEnable : true);   // default AUTO for a fresh market
  const asks = (man.asks || []).slice().sort((x, y) => x.p - y.p);   // ascending → index 0 = best (lowest) ask
  const bids = (man.bids || []).slice().sort((x, y) => y.p - x.p);   // descending → index 0 = best (highest) bid
  let rows = "";
  for (let i = 0; i < 6; i++) { const bl = bids[i] || {}, al = asks[i] || {}; rows += axMakerRow(i, i === 0, bl.p, bl.a, al.p, al.a); }
  const oracle = peg ? "fetching " + src + " price…" : (src === "Parity" ? "Parity · mid 1.0" : "peg off");
  const sz = c.size != null ? c.size : (c.askSize != null ? c.askSize : "");
  return `<div class="ax-cockpit-top">`
      + `<span class="ax-tog"><span class="ax-tog-l">Enabled</span>${axSwitch("axEnabled", enabled)}</span>`
      + `<span class="ax-tog"><span class="ax-tog-l">Peg → ${src}</span>${axSwitch("axPegToggle", peg)}</span>`
      + `<span class="ax-oracle mono" id="axOracle">${oracle}</span></div>`
    + `<div class="ax-cockpit">`
      + axFld("mid", "axMid", "")
      + axFld("step %", "axStep", c.step != null ? c.step : "1")
      + axFld("levels", "axLevels", c.levels != null ? c.levels : "3")
      + axFld("size", "axSize", sz)
      + axFld("skew %", "axBias", c.bias != null ? c.bias : "0")
      + axFld("reprice %", "axReprice", c.reprice != null ? c.reprice : "1")
      + `</div>`
    + `<div class="ax-mkr-hint">Auto mode: prices track the ${src} mid · <b>size</b> seeds every rung — edit any amount or price · only your chosen levels show</div>`
    + `<div class="ax-legend"><span class="sell">BIDS · you buy ${esc(ccy)}</span><span class="buy">ASKS · you sell ${esc(ccy)}</span></div>`
    + `<div class="ax-mcolhdr"><span>amount&nbsp;·&nbsp;price</span><span>price&nbsp;·&nbsp;amount</span></div>`
    + `<div id="axLadder">${rows}</div>`
    + `<div class="ax-spread-mid mono" id="axSpread">—</div>`
    + `<div class="ax-mkr-foot">`
      + axEditRow("Min trade · " + esc(ccy), axEditInput("axMin", c.min != null ? c.min : ""))
      + `<div class="ax-prev" id="axMkrPreview"><div class="empty">—</div></div></div>`
    + `<button class="btn btn--primary btn--full" id="axSave" style="margin-top:12px">Save &amp; publish</button>`
    + `<div class="ax-mkr-actions" style="margin-top:8px"><button class="btn btn--outline btn--full" id="axWithdraw">Withdraw market</button><button class="btn btn--outline btn--full" id="axCancel">Cancel</button></div>`;
}
function axWireMakerEditor(ccy) {
  const num = id => { const e = el(id); return e ? (Number(e.value) || 0) : 0; };
  const pegOn = () => { const e = el("axPegToggle"); return !!(e && e.classList.contains("on")); };
  const enaOn = () => { const e = el("axEnabled"); return !!(e && e.classList.contains("on")); };
  const getRows = pfx => { const out = []; for (let i = 0; i < 6; i++) out.push({ p: num(pfx + "P" + i), a: num(pfx + "A" + i) }); return out; };
  const collect = () => ({ asks: getRows("axAsk").filter(l => l.p > 0 && l.a > 0), bids: getRows("axBid").filter(l => l.p > 0 && l.a > 0) });
  let filling = false;
  // live preview summary from the rows (native updateLadderPreview): level counts, best prices, side totals, crossed
  const updPreview = () => {
    const host = el("axMkrPreview"); if (!host) return;
    const { asks, bids } = collect();
    // centered spread readout between the twin ladders
    const sp = el("axSpread");
    if (sp) {
      if (asks.length && bids.length) {
        const ba = Math.min(...asks.map(l => l.p)), bb = Math.max(...bids.map(l => l.p)), d = ba - bb;
        sp.textContent = d > 0 ? `spread ${fmtPx(d)} · ${(d / bb * 100).toFixed(1)}%` : "⚠ crossed";
        sp.classList.toggle("crossed", d <= 0);
      } else { sp.textContent = "—"; sp.classList.remove("crossed"); }
    }
    if (asks.length && bids.length) {
      const bestAsk = Math.min(...asks.map(l => l.p)), bestBid = Math.max(...bids.map(l => l.p));
      if (bestBid >= bestAsk) { host.innerHTML = `<div class="ax-prev-cross">⚠ Crossed — best bid ${fmtPx(bestBid)} ≥ best ask ${fmtPx(bestAsk)}: you'd sell cheaper than you buy</div>`; return; }
    }
    const sum = arr => arr.reduce((s, l) => s + l.a, 0);
    const bidS = bids.length ? `${bids.length} lvl · best ${fmtPx(Math.max(...bids.map(l => l.p)))} · ${fmtAbbrev(sum(bids))} ${esc(ccy)}` : "none";
    const askS = asks.length ? `${asks.length} lvl · best ${fmtPx(Math.min(...asks.map(l => l.p)))} · ${fmtAbbrev(sum(asks))} ${esc(ccy)}` : "none";
    host.innerHTML = `<div class="ax-prev-sum mono"><div><span class="bidpx">BIDS</span>&nbsp; ${bidS}</div><div><span class="askpx">ASKS</span>&nbsp; ${askS}</div></div>`;
  };
  const clampLevels = () => Math.max(1, Math.min(6, Math.floor(num("axLevels")) || 1));
  const showLevels = () => { const L = clampLevels(); for (let i = 0; i < 6; i++) { const r = el("axRow" + i); if (r) r.style.display = i < L ? "" : "none"; } };
  // PRICES from mid·step·skew for the visible rungs (prices are auto); blank hidden rungs so they aren't published;
  // seed only EMPTY sizes so a hand-edited amount survives a re-price. Called on mid/step/skew/levels + the peg tick.
  const reprice = midOverride => {
    const m = midOverride != null ? midOverride : num("axMid"), step = num("axStep"), size = num("axSize"), L = clampLevels();
    const quoted = m * (1 + Math.max(-20, Math.min(20, num("axBias"))) / 100);
    filling = true;
    try {
      for (let i = 0; i < 6; i++) {
        const on = i < L, bp = el("axBidP" + i), ap = el("axAskP" + i), ba = el("axBidA" + i), aa = el("axAskA" + i);
        if (on) {
          if (m > 0 && step > 0) { if (bp) bp.value = fmtPx(quoted * (1 - (i + 1) * step / 100)); if (ap) ap.value = fmtPx(quoted * (1 + (i + 1) * step / 100)); }
          if (size > 0) { if (ba && !ba.value) ba.value = fmtPx(size); if (aa && !aa.value) aa.value = fmtPx(size); }
        } else { if (bp) bp.value = ""; if (ap) ap.value = ""; if (ba) ba.value = ""; if (aa) aa.value = ""; }
      }
    } finally { filling = false; }
    showLevels(); updPreview();
  };
  // SIZE seeds every visible rung's amount — the ONE control that overwrites hand-edited amounts (the master size).
  const seedSizes = () => {
    const size = num("axSize"), L = clampLevels();
    filling = true;
    try { for (let i = 0; i < 6; i++) { const on = i < L, ba = el("axBidA" + i), aa = el("axAskA" + i); if (ba) ba.value = on && size > 0 ? fmtPx(size) : ""; if (aa) aa.value = on && size > 0 ? fmtPx(size) : ""; } }
    finally { filling = false; }
    updPreview();
  };
  // pegged: pull the live oracle mid from the engine, set the oracle line + mid field, regenerate the rows
  const refreshPeg = async () => {
    const pv = await api.axMakerPreview({ pegEnable: true, step: num("axStep"), askSize: num("axSize"), bidSize: num("axSize"), bias: num("axBias"), levels: num("axLevels") || 1, reprice: num("axReprice") || 1, min: num("axMin") }, {}).catch(() => null);
    if (!pv) return;
    axOracleMid = pv.mid || 0;
    const ol = el("axOracle"); if (ol) ol.textContent = pv.mid > 0 ? (esc(pv.source || ccy) + " · mid " + fmtPx(pv.mid) + (pv.fresh ? "" : " (stale)") + (pv.wide ? " · WIDE" : "")) : ("waiting for " + esc(pv.source || "market") + " price…");
    const midE = el("axMid"); if (midE && pegOn()) midE.value = pv.mid > 0 ? fmtPx(pv.mid) : "";
    if (pv.mid > 0 && pegOn()) reprice(pv.mid);
  };
  const pegModeUi = () => { const on = pegOn(), midE = el("axMid"); if (midE) { midE.disabled = on; midE.style.opacity = on ? "0.5" : "1"; } };

  const swEna = el("axEnabled"); if (swEna) swEna.onclick = () => { swEna.classList.toggle("on"); const on = swEna.classList.contains("on"); swEna.setAttribute("aria-checked", on); axEnaMode = on; };
  const swPeg = el("axPegToggle"); if (swPeg) swPeg.onclick = () => {
    swPeg.classList.toggle("on"); const on = swPeg.classList.contains("on"); swPeg.setAttribute("aria-checked", on); axPegMode = on; pegModeUi();
    if (on) axStartPegPoll(refreshPeg); else { axStopPegPoll(); const ol = el("axOracle"); if (ol) ol.textContent = "peg off"; reprice(); }
  };
  // price controls (mid/step/skew/levels) re-price the rungs (sizes preserved); `size` re-seeds every amount.
  ["axMid", "axStep", "axBias", "axLevels"].forEach(id => { const e = el(id); if (e) e.addEventListener("input", () => { if (filling) return; reprice(pegOn() && axOracleMid > 0 ? axOracleMid : undefined); }); });
  const szE = el("axSize"); if (szE) szE.addEventListener("input", () => { if (filling) return; seedSizes(); });
  for (let i = 0; i < 6; i++) ["axAskP", "axAskA", "axBidP", "axBidA"].forEach(pfx => { const e = el(pfx + i); if (e) e.addEventListener("input", () => { if (!filling) updPreview(); }); });
  const minE = el("axMin"); if (minE) minE.addEventListener("input", updPreview);

  const finish = () => { axEditing = false; axPegMode = null; axEnaMode = null; axStopPegPoll(); renderAxMarket(); };
  el("axSave").onclick = async () => {
    const btn = el("axSave"); btn.disabled = true; btn.textContent = "Saving…";
    if (!enaOn()) {   // Enabled OFF → withdraw (tombstone), like the native disable
      const r = await api.axMakerWithdraw().catch(e => ({ err: String(e.message || e) }));
      toast(r && r.err ? r.err : "Market withdrawn", r && r.err ? "warn" : "ok"); finish(); return;
    }
    const step = num("axStep"), size = num("axSize");
    const cfg = { pegEnable: pegOn() && step > 0 && size > 0, step, size, askSize: size, bidSize: size, bias: num("axBias"), reprice: num("axReprice") || 1, levels: clampLevels(), min: num("axMin") };
    const r = await api.axMakerSave(cfg, collect()).catch(e => ({ err: String(e.message || e) }));
    toast(r && r.err ? r.err : "✓ Market saved + published", r && r.err ? "warn" : "ok"); finish();
  };
  el("axWithdraw").onclick = async () => { if (!await showConfirm("Withdraw your market?", "Your order is tombstoned so peers stop trading against it.", "Withdraw", true)) return; const r = await api.axMakerWithdraw().catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "Market withdrawn", r && r.err ? "warn" : "ok"); finish(); };
  el("axCancel").onclick = finish;

  pegModeUi(); showLevels();
  if (num("axSize") > 0) reprice();   // on open: seed prices (if mid set) + fill empty amounts for the visible rungs
  updPreview();
  if (pegOn()) axStartPegPoll(refreshPeg);
}

// ---- Activity ----
async function renderAxActivity() {
  const host = el("axBody");
  const swaps = await api.axSwaps().catch(() => []);
  host.innerHTML = `${axHeader("activity")}<div class="card"><div class="card__title">Your swaps</div>${swaps.length ? "" : '<div class="empty">No swaps yet — your completed and refunded swaps appear here.</div>'}<div id="axSwapList">${axSwapRows(swaps)}</div></div>`;
  wireAxHeader();
  wireAxSwapRows();
}
function axSwapRows(swaps) {
  return swaps.map(s => `<div class="row" style="justify-content:space-between;cursor:pointer" data-axhash="${esc(s.hash)}">
    <span class="mono" style="font-size:13px">${esc(s.sellamount)} ${esc(axTok(s.selltoken))} → ${esc(s.buyamount)} ${esc(axTok(s.buytoken))}</span>
    <span class="mail-ver">${esc(String(s.status).toLowerCase())}</span></div>`).join("");
}
function axTok(t) { if (typeof t === "string" && t.indexOf("0x") === 0) { const l = String(t).toLowerCase(); if (l === "0x00") return "MINIMA"; if (l.indexOf("7d39745") >= 0) return "mxUSDT"; } return t; }
function wireAxSwapRows() {
  document.querySelectorAll("#axBody [data-axhash]").forEach(r => r.onclick = async () => {
    toast("Checking…");
    const lines = await api.axInspect(r.dataset.axhash).catch(e => ["Check failed: " + (e.message || e)]);
    showAxReport(r.dataset.axhash, lines);
  });
}
function showAxReport(hash, lines) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="axRepOv"><div class="modal">
    <div class="modal__title">Swap status</div><div class="view__desc" style="white-space:pre-wrap">${esc(lines.join("\n"))}</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="axRepClose">Close</button><button class="btn btn--primary btn--full" id="axRepAgain">Check again</button></div></div></div>`);
  const ov = el("axRepOv"); const close = () => ov && ov.remove();
  el("axRepClose").onclick = close;
  el("axRepAgain").onclick = async () => { close(); const l = await api.axInspect(hash).catch(e => ["Check failed"]); showAxReport(hash, l); };
  ov.onclick = e => { if (e.target.id === "axRepOv") close(); };
}

// ---- OTC ----
async function renderAxOtc() {
  const host = el("axBody");
  const o = await api.axOtc().catch(() => ({ board: [], deals: [], myOffer: {} }));
  const ccy = axStatusCache.currency === "minima" ? "MINIMA" : "mxUSDT";
  host.innerHTML = `${axHeader("otc")}
    <div class="card"><div class="card__title">Your availability (${esc(ccy)})</div>
      <div class="row"><div class="field" style="flex:1"><div class="field__label">Max to SELL</div><input class="field__input" id="axOtcSell" value="${o.myOffer && o.myOffer.sellSize || ""}" /></div>
        <div class="field" style="flex:1"><div class="field__label">Max to BUY</div><input class="field__input" id="axOtcBuy" value="${o.myOffer && o.myOffer.buySize || ""}" /></div></div>
      <div class="seg"><button class="btn btn--primary btn--full" id="axOtcLive">Go live</button><button class="btn btn--outline btn--full" id="axOtcWithdraw">Withdraw</button></div></div>
    <div class="card"><div class="card__title">LP board</div>${o.board.length ? o.board.map((lp, i) => `<div class="row" style="justify-content:space-between"><span class="mono" style="font-size:12px">${esc(TOK.shortId(lp.cid))}</span><span>sell ${esc(lp.sell)} · buy ${esc(lp.buy)}</span><button class="btn btn--sm btn--outline" data-axlp="${i}">Propose</button></div>`).join("") : '<div class="empty">No LPs live right now.</div>'}</div>
    <div class="card"><div class="card__title">Your deals</div>${o.deals.length ? o.deals.map(d => axDealRow(d)).join("") : '<div class="empty">No active deals.</div>'}</div>`;
  wireAxHeader();
  el("axOtcLive").onclick = async () => { const r = await api.axOtcGoLive(el("axOtcSell").value, el("axOtcBuy").value).catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "✓ Availability published", r && r.err ? "warn" : "ok"); };
  el("axOtcWithdraw").onclick = async () => { await api.axOtcWithdraw().catch(() => {}); toast("Availability withdrawn"); };
  document.querySelectorAll("#axBody [data-axlp]").forEach(btn => btn.onclick = () => axOtcPropose(o.board[Number(btn.dataset.axlp)]));
  document.querySelectorAll("#axBody [data-axaccept]").forEach(btn => btn.onclick = async () => { await api.axOtcDeal(btn.dataset.axaccept, "accept").catch(e => toast(e.message || e, "warn")); renderAxOtc(); });
  document.querySelectorAll("#axBody [data-axreject]").forEach(btn => btn.onclick = async () => { await api.axOtcDeal(btn.dataset.axreject, "reject").catch(() => {}); renderAxOtc(); });
}
function axDealRow(d) {
  const canAct = d.whoseTurn === "ME" && (d.status === "PROPOSED" || d.status === "COUNTERED");
  return `<div class="row" style="justify-content:space-between"><span class="mono" style="font-size:12px">${esc(d.side)} ${esc(d.amount)} @ ${esc(d.price)}</span><span class="mail-ver">${esc(String(d.status).toLowerCase())}</span>${canAct ? `<span><button class="btn btn--sm btn--primary" data-axaccept="${esc(d.ref)}">Accept</button> <button class="btn btn--sm btn--danger" data-axreject="${esc(d.ref)}">Reject</button></span>` : ""}</div>`;
}
async function axOtcPropose(lp) {
  if (!lp) return;
  const sideRaw = await showPrompt("Deal side", "SELL", "SELL or BUY", { message: "SELL = you buy their " + (axStatusCache.currency === "minima" ? "MINIMA" : "mxUSDT") + "; BUY = you sell yours." });
  if (!sideRaw) return;
  const side = String(sideRaw).trim().toUpperCase();
  if (side !== "SELL" && side !== "BUY") { toast("Side must be SELL or BUY", "warn"); return; }
  const amount = await showPrompt("Amount", "", "0.0"); if (!amount) return;
  const price = await showPrompt("Price (USDT each)", "", "1.0"); if (!price) return;
  const r = await api.axOtcPropose({ cid: lp.cid, mpk: lp.mpk, eth: lp.eth }, side, amount, price).catch(e => ({ err: String(e.message || e) }));
  toast(r && r.err ? r.err : "✓ Proposed — waiting on the LP", r && r.err ? "warn" : "ok"); renderAxOtc();
}

// ---- Wallet (ETH) ----
async function renderAxWallet() {
  const host = el("axBody");
  const w = await api.axWallet().catch(() => null);
  if (!w) { host.innerHTML = `${axHeader("wallet")}<div class="empty">Wallet not ready.</div>`; wireAxHeader(); return; }
  const b = w.bals, m = b.meta;
  const locked = m ? Math.max(0, (Number(m.confirmed) || 0) - (Number(m.sendable) || 0)) : 0;
  host.innerHTML = `${axHeader("wallet")}
    <div class="card" id="axMinCard" style="cursor:pointer"><div class="card__title">${esc(w.label)} · available to swap</div>
      <div class="mono" style="font-size:22px;color:var(--accent)">${esc(b.minima)} ${esc(w.label)}</div>
      <div class="view__desc">${m ? `confirmed ${m.confirmed} · locked ≈ ${Math.round(locked * 1e6) / 1e6} · unconfirmed ${m.unconfirmed} · ${m.coins} coins · tap for coins` : ""}</div></div>
    <div class="card" id="axEthCard" style="cursor:pointer"><div class="card__title">Ethereum</div>
      <div class="mono" style="font-size:22px">${esc(b.eth)} ETH</div><div class="view__desc mono">${esc(w.shortAddr)}</div></div>
    <div class="card"><div class="card__title">USDT · Ethereum</div><div class="mono" style="font-size:22px">${esc(b.usdt)} USDT</div></div>
    <div class="seg" style="flex-wrap:wrap"><button class="btn btn--outline btn--sm" id="axRefreshBal">Refresh</button><button class="btn btn--outline btn--sm" id="axFund">Fund / QR</button><button class="btn btn--outline btn--sm" id="axSend">Send</button><button class="btn btn--outline btn--sm" id="axExport">Export key</button></div>`;
  wireAxHeader();
  el("axMinCard").onclick = axCoinDump;
  el("axEthCard").onclick = () => axReceive(w.addr);
  el("axRefreshBal").onclick = renderAxWallet;
  el("axFund").onclick = () => axReceive(w.addr);
  el("axSend").onclick = () => axSendDialog(w);
  el("axExport").onclick = axExportKey;
}
function axReceive(addr) {
  let qrHtml = "";
  if (typeof qrcode !== "undefined") { const qr = qrcode(0, "M"); qr.addData(addr); qr.make(); qrHtml = `<div style="background:#fff;padding:8px;border-radius:8px;width:fit-content;margin:10px auto">${qr.createImgTag(5, 6)}</div>`; }
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="axRxOv"><div class="modal">
    <div class="modal__title">Receive / Fund · Ethereum</div>
    <div class="mono" style="user-select:all;word-break:break-all;text-align:center;font-size:13px">${esc(addr)}</div>${qrHtml}
    <div class="view__desc">Same address on all EVM networks — fund it with Ethereum ETH and tokens.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="axRxClose">Close</button><button class="btn btn--primary btn--full" id="axRxCopy">Copy address</button></div></div></div>`);
  const ov = el("axRxOv"); const close = () => ov && ov.remove();
  el("axRxClose").onclick = close; el("axRxCopy").onclick = () => { copy(addr); };
  ov.onclick = e => { if (e.target.id === "axRxOv") close(); };
}
async function axExportKey() {
  if (!await showConfirm("Export ETH private key", "This key controls your ETH funds. Anyone who sees it can take them. It is derived from your Minima node seed. Never share it or type it into a website.", "Reveal key", true)) return;
  const pk = await api.axExportKey().catch(() => null);
  if (!pk) { toast("Wallet not ready", "warn"); return; }
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="axPkOv"><div class="modal">
    <div class="modal__title">ETH private key</div><div class="view__desc" style="color:var(--red)">⚠ Keep this secret.</div>
    <div class="mono" style="user-select:all;word-break:break-all;font-size:12px">${esc(pk)}</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="axPkClose">Close</button><button class="btn btn--primary btn--full" id="axPkCopy">Copy key</button></div></div></div>`);
  const ov = el("axPkOv"); const close = () => ov && ov.remove();
  el("axPkClose").onclick = close; el("axPkCopy").onclick = () => copy(pk);
  ov.onclick = e => { if (e.target.id === "axPkOv") close(); };
}
async function axCoinDump() {
  const rows = await api.axCoins().catch(() => []);
  const body = rows.length ? rows.map(c => `<div class="row mono" style="font-size:12px"><span>${esc(c.amount)}</span><span style="color:var(--dim)">${esc(TOK.shortId(c.coinid))}</span></div>`).join("") : '<div class="empty">No sendable coins right now.</div>';
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="axCoinOv"><div class="modal"><div class="modal__title">Your coins</div>${body}<div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="axCoinClose">Close</button></div></div></div>`);
  const ov = el("axCoinOv"); el("axCoinClose").onclick = () => ov.remove(); ov.onclick = e => { if (e.target.id === "axCoinOv") ov.remove(); };
}
async function axSendDialog(w) {
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="axSendOv"><div class="modal">
    <div class="modal__title">Send from this wallet</div>
    <div class="seg"><button class="btn btn--primary btn--full" id="axSendEth" data-asset="eth">ETH</button><button class="btn btn--outline btn--full" id="axSendUsdt" data-asset="usdt">USDT</button></div>
    <div class="field"><div class="field__label">To</div><input class="field__input mono" id="axSendTo" placeholder="0x… recipient" autocomplete="off" /></div>
    <div class="field"><div class="field__label">Amount <button class="btn btn--sm btn--outline" id="axSendMax" style="float:right">Max</button></div><input class="field__input mono" id="axSendAmt" placeholder="0.00" autocomplete="off" /></div>
    <div class="view__desc">Sends are irreversible. Double-check the address.</div>
    <div class="seg" style="margin-top:12px"><button class="btn btn--outline btn--full" id="axSendCancel">Cancel</button><button class="btn btn--primary btn--full" id="axSendReview">Review</button></div></div></div>`);
  const ov = el("axSendOv"); let asset = "eth"; const close = () => ov && ov.remove();
  const setAsset = a => { asset = a; el("axSendEth").className = "btn btn--full " + (a === "eth" ? "btn--primary" : "btn--outline"); el("axSendUsdt").className = "btn btn--full " + (a === "usdt" ? "btn--primary" : "btn--outline"); };
  el("axSendEth").onclick = () => setAsset("eth"); el("axSendUsdt").onclick = () => setAsset("usdt");
  el("axSendMax").onclick = async () => { const m = await api.axSendMax(asset).catch(() => null); if (m != null) el("axSendAmt").value = m; };
  el("axSendCancel").onclick = close;
  ov.onclick = e => { if (e.target.id === "axSendOv") close(); };
  el("axSendReview").onclick = async () => {
    const to = el("axSendTo").value.trim(), amt = el("axSendAmt").value.trim();
    const r = await api.axSendReview(asset, to, amt).catch(e => ({ err: String(e.message || e) }));
    if (r.err) { toast(r.err, "warn"); return; }
    close();
    if (!await showConfirm("Review — Send " + (asset === "eth" ? "ETH" : "USDT"), `Send  ${amt} ${asset === "eth" ? "ETH" : "USDT"}\nTo  ${to}\n\nNetwork fee ≈ ${r.fee} ETH\nThis cannot be undone.`, "Send now", true)) return;
    const s = await api.axSend(asset, to, amt).catch(e => ({ err: String(e.message || e) }));
    toast(s && s.err ? s.err : "✓ Sent — tx " + TOK.shortId(s.tx), s && s.err ? "warn" : "ok");
    if (activeView === "atomix" && axView === "wallet") renderAxWallet();
  };
}

async function axSwitchCurrency() {
  const to = axStatusCache.currency === "minima" ? "mxUSDT" : "MINIMA";
  if (!await showConfirm("Switch to " + to + "?", "Your live market on the current book is withdrawn first, then AtomiX moves to the " + to + " book. Any in-flight swap still settles.", "Switch")) return;
  const r = await api.axSwitchCurrency(axStatusCache.currency === "minima" ? "mxusdt" : "minima").catch(e => ({ err: String(e.message || e) }));
  if (r && r.err) toast(r.err, "warn");
  renderAtomix();
}
function axWelcome() {
  showConfirm("Welcome to AtomiX", "Swap MINIMA or mxUSDT ⇄ Ethereum USDT trustlessly across chains — no middleman ever holds your funds.\n\nYour keys are derived from this node's seed, so it's the same wallet and identity on any device running AtomiX.\n\nTabs: Swap (quick trade) · Market (full order book + your maker order) · Activity (your swaps) · OTC (private negotiated deals) · Wallet (your ETH).\n\nInteroperates on the SAME on-chain books as the AtomiX phone app and MiniDapp.", "Get started");
}

// live push: patch passive regions only; never rebuild a form the user is typing into
function onAtomixUpdate() {
  if (axUpdateTimer) return;
  axUpdateTimer = setTimeout(() => { axUpdateTimer = null; refreshAxActive().catch(() => {}); }, 400);
}
async function refreshAxActive() {
  if (activeView !== "atomix" || !el("axBody")) return;
  // NEVER rebuild a view while the user is typing in one of its inputs (the Mail frozen-tab rule). The Market
  // maker editor + OTC availability + Swap amount all hold live inputs.
  const focusInBody = document.activeElement && el("axBody").contains(document.activeElement) && document.activeElement.tagName === "INPUT";
  if (axView === "activity") return renderAxActivity();
  if (axView === "market") { if (!focusInBody) return renderAxMarket(); return; }   // skip while configuring the market
  if (axView === "swap") {
    // if the user isn't typing an amount, a full re-render refreshes the book/best-price/stages; otherwise
    // only refresh the stages tracker in place (never touch the amount inputs).
    if (!focusInBody) return renderAxSwap();
    const swaps = await api.axSwaps().catch(() => []); const w = await api.axWallet().catch(() => null);
    const bals = (w && w.bals) || { minima: "0", usdt: "0", eth: "0" };
    const stagesEl = el("axBody").querySelector(".ax-stages");
    if (stagesEl) stagesEl.innerHTML = axStagesRows(swaps, bals, axQuoteMeta ? axQuoteMeta.ccy : "mxUSDT");
  }
  // OTC/Wallet: leave the form alone; the user re-enters or taps Refresh (an OS notification flags OTC activity).
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
  try { const n = await api.shopNewCount(); const b = el("shopBadge"); if (!b) return; if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true; } catch (e) {}
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
  const id = shopIdentity ? axShort(shopIdentity.publicId) : "…";
  if (!orders.length) { host.innerHTML = `<div class="card"><div class="empty">No orders yet. Orders to your shops (Selling) and orders you place (Buying) both land here.<br>Your shop id: <span class="mono">${id}</span></div></div>`; return; }
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
      <div class="field"><div class="field__label">Currency</div><div class="seg"><button class="btn btn--sm ${d.currency === "Minima" ? "btn--primary" : "btn--outline"}" data-cur="Minima">MINIMA</button><button class="btn btn--sm ${d.currency !== "Minima" ? "btn--primary" : "btn--outline"}" data-cur="USDT">mxUSDT</button></div></div>
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

// ============================ Casino (Zero Edge Casino — on-chain commit-reveal) ============================
// Fleshed out in S2 (PLAY/MY BETS) + S3 (HOUSE) + S4 (animations/SFX). S0: shell + badge + update plumbing.
let casinoView = "play";        // play | house | mybets | history
let casinoUpdateTimer = null;
let casinoPick = {};            // coinid → chosen outcome index (PLAY)
let casinoStatusCache = null;   // last casinoStatus()

const CASINO_PRESETS = {
  flip: { name: "Coin Flip", icon: "✦", range: 2, payout: 2, labels: ["Heads", "Tails"] },
  dice: { name: "Dice", icon: "⚀", range: 6, payout: 6, labels: ["1", "2", "3", "4", "5", "6"] },
  roulette: { name: "Roulette", icon: "◉", range: 36, payout: 36, labels: null }
};
let casinoHousePreset = "flip";
let casinoBusy = {};            // coinid/action → true while a txn is in flight (disable buttons)
const casinoFlashed = {};      // coinid → true once its win/lose flash has shown (session)

function casinoGame(range) { return range == 2 ? CASINO_PRESETS.flip : range == 6 ? CASINO_PRESETS.dice : range == 36 ? CASINO_PRESETS.roulette : { name: "Custom (" + range + ")", icon: "✳", range: range, payout: range }; }
function casinoPickLabel(range, pick) { return range == 2 ? (parseInt(pick) === 0 ? "Heads" : "Tails") : "" + (parseInt(pick) + 1); }
function casinoFmt(v) { const n = parseFloat(v); return (isNaN(n) ? 0 : n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }

// --- pure Web-Audio SFX (CSP-safe: no files, no network) ---
const casinoSfx = (() => {
  let ac = null;
  function ctx() { try { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); return ac; } catch (e) { return null; } }
  function tone(freq, dur, type, vol, when) { const a = ctx(); if (!a) return; const t = a.currentTime + (when || 0); const o = a.createOscillator(), g = a.createGain(); o.type = type || "sine"; o.frequency.value = freq; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol || 0.14, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur); }
  const on = () => { try { return localStorage.getItem("casino_mute") !== "1"; } catch (e) { return true; } };
  return {
    chip() { if (!on()) return; tone(180, 0.06, "square", 0.08); tone(240, 0.05, "square", 0.06, 0.045); },
    deal() { if (!on()) return; tone(330, 0.06, "triangle", 0.09); },
    spin() { if (!on()) return; tone(440, 0.05, "sawtooth", 0.05); tone(520, 0.05, "sawtooth", 0.05, 0.1); },
    win() { if (!on()) return; [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, "sine", 0.13, i * 0.09)); },
    lose() { if (!on()) return; tone(210, 0.35, "sawtooth", 0.1); tone(150, 0.45, "sawtooth", 0.09, 0.08); },
    chime() { if (!on()) return; tone(880, 0.12, "sine", 0.1); tone(1174, 0.14, "sine", 0.09, 0.08); }
  };
})();

function onCasinoUpdate() {
  if (casinoUpdateTimer) clearTimeout(casinoUpdateTimer);
  casinoUpdateTimer = setTimeout(async () => {
    refreshCasinoBadge();
    await casinoWatchResults();
    if (activeView !== "casino") return;
    if (el("casinoBody") && el("casinoBody").querySelector("input:focus")) return;   // never stomp a form
    renderCasino();
  }, 350);
}
async function refreshCasinoBadge() {
  try { const n = await api.casinoNewCount(); const b = el("casinoBadge"); if (!b) return; if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true; } catch (e) {}
}
// A background reveal/resolve (service.js) records to casino_history — surface the newest fresh win/lose as a flash.
async function casinoWatchResults() {
  let hist = []; try { hist = await api.casinoHistory(); } catch (e) { return; }
  const now = Date.now();
  const fresh = (hist || []).filter(h => h && h.coinid && !casinoFlashed[h.coinid] && (now - (Number(h.time) || 0)) < 180000);
  if (!fresh.length) { (hist || []).forEach(h => { if (h && h.coinid) casinoFlashed[h.coinid] = true; }); return; }
  (hist || []).forEach(h => { if (h && h.coinid) casinoFlashed[h.coinid] = true; });   // mark all seen so only the newest flashes
  const h = fresh[0];   // history is newest-first
  casinoFlash(!!h.won, h.game, h.profit, h.pickLabel, h.resultLabel, h.range);
}

async function renderCasino() {
  const host = el("casinoBody"); if (!host) return;
  let st = null, bal = "0";
  try { st = await api.casinoStatus(); } catch (e) {}
  try { bal = await api.casinoBalance(); } catch (e) {}
  casinoStatusCache = st;
  api.casinoSeen().catch(() => {}); refreshCasinoBadge();   // viewing the tab clears the unseen-result badge
  const ready = st && st.ready;
  const sub = (v, label) => `<button class="btn btn--sm ${casinoView === v ? "btn--primary" : "btn--outline"}" data-cv="${v}">${label}</button>`;
  host.innerHTML =
    `<div class="view__title" style="display:flex;align-items:center;gap:10px">Casino
       <span style="font:600 11px/1 var(--mono);color:var(--dim);letter-spacing:0">ZERO EDGE · 0% HOUSE</span>
       <span style="flex:1"></span>
       <button class="btn btn--sm btn--outline" id="casinoMute" title="Sound">${(() => { try { return localStorage.getItem("casino_mute") === "1" ? "🔇" : "🔊"; } catch (e) { return "🔊"; } })()}</button>
     </div>
     <div class="casino-hdr">
       <div><span class="casino-hdr__k">Balance</span><span class="casino-hdr__v">${casinoFmt(bal)} <small>MINIMA</small></span></div>
       <div><span class="casino-hdr__k">Block</span><span class="casino-hdr__v">${st && st.block ? "#" + st.block : "—"}</span></div>
       <div><span class="casino-hdr__k">Engine</span><span class="casino-hdr__v" style="color:${ready ? "var(--green)" : "var(--amber)"}">${ready ? "ready" : "starting…"}</span></div>
     </div>
     <div class="seg" style="margin:10px 0 12px">${sub("play", "Play")}${sub("house", "Be the House")}${sub("mybets", "My Bets")}${sub("history", "History")}</div>
     <div id="casinoSub"></div>`;
  host.querySelectorAll("[data-cv]").forEach(b => b.addEventListener("click", () => { casinoView = b.dataset.cv; renderCasino(); }));
  const mute = el("casinoMute");
  if (mute) mute.addEventListener("click", () => { try { const m = localStorage.getItem("casino_mute") === "1"; localStorage.setItem("casino_mute", m ? "0" : "1"); } catch (e) {} renderCasino(); });
  renderCasinoSub();
}

function renderCasinoSub() {
  if (casinoView === "play") return renderCasinoPlay();
  if (casinoView === "house") return renderCasinoHouse();
  if (casinoView === "mybets") return renderCasinoMyBets();
  if (casinoView === "history") return renderCasinoHistory();
}

// ---------------- PLAY: take other players' open bets ----------------
async function renderCasinoPlay() {
  const host = el("casinoSub"); if (!host) return;
  let bets = []; try { bets = await api.casinoOpenBets(); } catch (e) {}
  if (el("casinoSub") !== host) return;   // view changed while awaiting
  if (!bets.length) { host.innerHTML = `<div class="card"><div class="view__desc" style="margin:0">No open bets right now. Switch to <b>Be the House</b> to offer one, or check back — bets from the native app & MiniDapp appear here too.</div></div>`; return; }
  host.innerHTML = bets.map(b => {
    const g = casinoGame(b.range), odds = (b.payout - 1);
    const win = casinoFmt(parseFloat(b.bet) * b.payout);
    const pick = casinoPick[b.coinid];
    const picker = casinoPicker(b.range, b.coinid, pick);
    const canTake = pick !== undefined && pick !== null && pick !== "";
    return `<div class="card casino-bet">
      <div class="casino-bet__top"><span class="casino-ico">${g.icon}</span>
        <span class="casino-bet__name">${esc(g.name)}</span>
        <span class="casino-bet__odds">${odds}:1</span></div>
      <div class="casino-bet__row"><span>Bet</span><b>${casinoFmt(b.bet)} MINIMA</b></div>
      <div class="casino-bet__row"><span>You win</span><b style="color:var(--green)">${win} MINIMA</b></div>
      <div class="casino-pickwrap">${picker}</div>
      <button class="btn btn--primary btn--full casino-take" data-coin="${b.coinid}" ${canTake && !casinoBusy[b.coinid] ? "" : "disabled"}>${casinoBusy[b.coinid] ? "Taking…" : (canTake ? "TAKE BET — pick " + esc(casinoPickLabel(b.range, pick)) : "Choose your pick")}</button>
    </div>`;
  }).join("");
  // pick controls
  host.querySelectorAll("[data-pick]").forEach(elm => elm.addEventListener("click", () => { casinoPick[elm.dataset.coin] = parseInt(elm.dataset.pick); renderCasinoPlay(); }));
  host.querySelectorAll("input[data-picknum]").forEach(inp => inp.addEventListener("input", () => { const v = parseInt(inp.value); casinoPick[inp.dataset.picknum] = (v >= 1 && v <= 36) ? v - 1 : ""; const btn = host.querySelector(`.casino-take[data-coin="${inp.dataset.picknum}"]`); if (btn) { const ok = casinoPick[inp.dataset.picknum] !== "" && casinoPick[inp.dataset.picknum] != null; btn.disabled = !ok; btn.textContent = ok ? "TAKE BET — pick " + (casinoPick[inp.dataset.picknum] + 1) : "Choose your pick"; } }));
  host.querySelectorAll(".casino-take").forEach(btn => btn.addEventListener("click", () => casinoDoTake(btn.dataset.coin)));
}

function casinoPicker(range, coinid, pick) {
  if (range == 2) return ["Heads", "Tails"].map((l, i) => `<button class="btn btn--sm ${pick === i ? "btn--primary" : "btn--outline"}" data-pick="${i}" data-coin="${coinid}">${l}</button>`).join("");
  if (range == 6) return [0, 1, 2, 3, 4, 5].map(i => `<button class="btn btn--sm ${pick === i ? "btn--primary" : "btn--outline"}" data-pick="${i}" data-coin="${coinid}" style="min-width:38px">${i + 1}</button>`).join("");
  return `<input class="field__input" type="number" min="1" max="36" placeholder="Pick a number 1–36" data-picknum="${coinid}" value="${pick != null && pick !== "" ? pick + 1 : ""}" style="max-width:220px">`;
}

async function casinoDoTake(coinid) {
  if (casinoBusy[coinid]) return;
  const pick = casinoPick[coinid];
  if (pick === undefined || pick === null || pick === "") { toast("Choose your pick first", "warn"); return; }
  casinoBusy[coinid] = true; renderCasinoPlay(); casinoSfx.deal();
  try {
    const r = await api.casinoTake(coinid, pick);
    delete casinoBusy[coinid]; delete casinoPick[coinid];
    toast((r && r.game ? r.game : "Bet") + " taken — picked " + (r && r.pickLabel ? r.pickLabel : "") + " ✓", "ok");
    casinoView = "mybets"; renderCasino();
  } catch (e) {
    delete casinoBusy[coinid];
    toast("Take failed: " + (e && e.message ? e.message : e), "err");
    renderCasinoPlay();
  }
}

// ---------------- HOUSE: create a bet + manage your open offers ----------------
async function renderCasinoHouse() {
  const host = el("casinoSub"); if (!host) return;
  const p = CASINO_PRESETS[casinoHousePreset];
  const betInput = el("casinoBetAmt");
  const curBet = betInput ? betInput.value : "";
  let mine = []; try { mine = await api.casinoMyBets(); } catch (e) {}
  const open = (mine || []).filter(b => b.phase === 0 && b.amHouse);
  const card = (id, g) => `<button class="btn btn--sm ${casinoHousePreset === id ? "btn--primary" : "btn--outline"}" data-preset="${id}" style="flex-direction:column;gap:2px;padding:10px 6px"><span style="font-size:18px">${g.icon}</span><span>${g.name}</span><span style="font:600 10px/1 var(--mono);opacity:.7">${g.payout - 1}:1</span></button>`;
  host.innerHTML =
    `<div class="card">
      <div class="casino-presets">${card("flip", CASINO_PRESETS.flip)}${card("dice", CASINO_PRESETS.dice)}${card("roulette", CASINO_PRESETS.roulette)}</div>
      <label class="casino-lbl">Player's bet (MINIMA)</label>
      <input class="field__input" id="casinoBetAmt" type="number" min="0" step="0.01" placeholder="e.g. 10" value="${esc(curBet)}">
      <div id="casinoHouseSummary" class="casino-summary"></div>
      <button class="btn btn--primary btn--full" id="casinoCreateBtn" ${casinoBusy.create ? "disabled" : ""}>${casinoBusy.create ? "Creating…" : "CREATE BET"}</button>
      <div class="casino-note">You stake the amount you could lose; the player adds their bet and picks an outcome. When they take it, your node auto-reveals — zero house edge, the whole pot is paid out.</div>
    </div>
    ${open.length ? `<div class="casino-subttl">Your open offers</div>` + open.map(b => `<div class="card casino-bet"><div class="casino-bet__top"><span class="casino-ico">${casinoGame(b.range).icon}</span><span class="casino-bet__name">${esc(casinoGame(b.range).name)}</span><span class="casino-bet__odds">${b.payout - 1}:1</span></div><div class="casino-bet__row"><span>Locked</span><b>${casinoFmt(b.amount)} MINIMA</b></div><div class="casino-bet__row"><span>Status</span><b style="color:var(--amber)">Waiting for a taker</b></div><button class="btn btn--sm btn--outline casino-cancel" data-coin="${b.coinid}" ${casinoBusy[b.coinid] ? "disabled" : ""}>${casinoBusy[b.coinid] ? "Cancelling…" : "Cancel & reclaim"}</button></div>`).join("") : ""}`;
  host.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { casinoHousePreset = b.dataset.preset; renderCasinoHouse(); }));
  const amt = el("casinoBetAmt");
  if (amt) amt.addEventListener("input", casinoUpdateHouseSummary);
  casinoUpdateHouseSummary();
  const cb = el("casinoCreateBtn");
  if (cb) cb.addEventListener("click", casinoDoCreate);
  host.querySelectorAll(".casino-cancel").forEach(btn => btn.addEventListener("click", () => casinoDoCancel(btn.dataset.coin)));
}

function casinoUpdateHouseSummary() {
  const box = el("casinoHouseSummary"); if (!box) return;
  const p = CASINO_PRESETS[casinoHousePreset];
  const bet = parseFloat((el("casinoBetAmt") || {}).value) || 0;
  let stake = parseFloat((bet * (p.payout - 1)).toFixed(8)); if (stake <= 0) stake = bet;
  box.innerHTML = `<div class="casino-summary__row"><span>You lock</span><b>${casinoFmt(stake)} MINIMA</b></div>
    <div class="casino-summary__row"><span>If the player wins</span><b style="color:var(--red)">−${casinoFmt(stake)}</b></div>
    <div class="casino-summary__row"><span>If the player loses</span><b style="color:var(--green)">+${casinoFmt(bet)}</b></div>
    <div class="casino-summary__row"><span>Odds</span><b>${p.payout - 1}:1 (fair)</b></div>`;
  const cb = el("casinoCreateBtn"); if (cb && !casinoBusy.create) cb.textContent = stake > 0 ? "CREATE BET — LOCK " + casinoFmt(stake) : "CREATE BET";
}

async function casinoDoCreate() {
  if (casinoBusy.create) return;
  const bet = parseFloat((el("casinoBetAmt") || {}).value);
  if (!bet || bet <= 0 || isNaN(bet)) { toast("Enter a valid bet amount", "warn"); return; }
  casinoBusy.create = true; renderCasinoHouse(); casinoSfx.chip();
  try {
    const r = await api.casinoCreate(casinoHousePreset, String(bet));
    delete casinoBusy.create;
    toast((r && r.game ? r.game : "Bet") + " created — " + casinoFmt(r && r.stake) + " MINIMA locked ✓", "ok");
    casinoView = "mybets"; renderCasino();
  } catch (e) {
    delete casinoBusy.create;
    toast("Create failed: " + (e && e.message ? e.message : e), "err");
    renderCasinoHouse();
  }
}

async function casinoDoCancel(coinid) {
  if (casinoBusy[coinid]) return;
  casinoBusy[coinid] = true; renderCasinoHouse();
  try { const r = await api.casinoCancel(coinid); delete casinoBusy[coinid]; toast("Cancelled — " + casinoFmt(r && r.amount) + " MINIMA returned ✓", "ok"); renderCasino(); }
  catch (e) { delete casinoBusy[coinid]; toast("Cancel failed: " + (e && e.message ? e.message : e), "err"); renderCasinoHouse(); }
}

// ---------------- MY BETS: active bets in flight ----------------
async function renderCasinoMyBets() {
  const host = el("casinoSub"); if (!host) return;
  let bets = []; try { bets = await api.casinoMyBets(); } catch (e) {}
  if (el("casinoSub") !== host) return;
  const active = (bets || []).filter(b => b.phase !== 0 || b.amHouse);   // include my open offers too
  if (!active.length) { host.innerHTML = `<div class="card"><div class="view__desc" style="margin:0">No bets in flight. Take one in <b>Play</b> or offer one in <b>Be the House</b>.</div></div>`; return; }
  host.innerHTML = active.map(b => {
    const g = casinoGame(b.range);
    let statusTxt = "", statusCol = "var(--amber)", extra = "";
    const canTimeout = b.expired;
    if (b.phase === 0) { statusTxt = "Open — waiting for a taker"; extra = `<button class="btn btn--sm btn--outline casino-cancel" data-coin="${b.coinid}">Cancel & reclaim</button>`; }
    else if (b.phase === 1 && b.amHouse) { statusTxt = "Taken — auto-revealing…"; extra = b.age > 10 ? `<button class="btn btn--sm btn--outline casino-reveal" data-coin="${b.coinid}">Force reveal</button>` : ""; }
    else if (b.phase === 1) { statusTxt = "Waiting for house to reveal…"; }
    else if (b.phase === 2 && b.amPlayer) { statusTxt = "Revealing — auto-resolving…"; statusCol = "var(--green)"; extra = b.age > 10 ? `<button class="btn btn--sm btn--outline casino-resolve" data-coin="${b.coinid}">Force resolve</button>` : ""; }
    else if (b.phase === 2) { statusTxt = "Waiting for player to resolve…"; }
    if (canTimeout) extra = `<button class="btn btn--sm btn--outline casino-timeout" data-coin="${b.coinid}" style="color:var(--red);border-color:var(--red)">Claim timeout</button>`;
    const pickTxt = (b.pick !== "" && b.pick != null && b.amPlayer) ? " · picked " + casinoPickLabel(b.range, b.pick) : "";
    return `<div class="card casino-bet">
      <div class="casino-bet__top"><span class="casino-ico">${g.icon}</span><span class="casino-bet__name">${esc(g.name)}</span>
        <span class="casino-bet__role">${esc(b.role)}${pickTxt}</span></div>
      <div class="casino-bet__row"><span>Pot</span><b>${casinoFmt(b.amount)} MINIMA</b></div>
      <div class="casino-bet__row"><span>Status</span><b style="color:${statusCol}">${statusTxt}</b></div>
      ${b.timeout ? `<div class="casino-bet__row"><span>Age</span><b>${b.age}/${b.timeout} blocks</b></div>` : ""}
      ${casinoBusy[b.coinid] ? `<div class="casino-note">Working…</div>` : extra}
    </div>`;
  }).join("");
  host.querySelectorAll(".casino-cancel").forEach(btn => btn.addEventListener("click", () => casinoDoCancel(btn.dataset.coin)));
  host.querySelectorAll(".casino-reveal").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "reveal")));
  host.querySelectorAll(".casino-resolve").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "resolve")));
  host.querySelectorAll(".casino-timeout").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "timeout")));
}

async function casinoDoFallback(coinid, kind) {
  if (casinoBusy[coinid]) return;
  casinoBusy[coinid] = true; renderCasinoMyBets();
  const fn = kind === "reveal" ? api.casinoReveal : kind === "resolve" ? api.casinoResolve : api.casinoClaimTimeout;
  try {
    const r = await fn(coinid);
    delete casinoBusy[coinid];
    if (kind === "resolve" && r) { casinoFlashed[coinid] = true; casinoFlash(r.isHouse ? !r.playerWins : r.playerWins, casinoGame(r.range).name, null, casinoPickLabel(r.range, r.pick), casinoPickLabel(r.range, r.result), r.range); }
    else toast(kind === "timeout" ? "Timeout claimed — " + casinoFmt(r && r.amount) + " MINIMA returned ✓" : "Done ✓", "ok");
    renderCasino();
  } catch (e) { delete casinoBusy[coinid]; toast("Failed: " + (e && e.message ? e.message : e), "err"); renderCasinoMyBets(); }
}

// ---------------- HISTORY ----------------
async function renderCasinoHistory() {
  const host = el("casinoSub"); if (!host) return;
  let hist = []; try { hist = await api.casinoHistory(); } catch (e) {}
  if (el("casinoSub") !== host) return;
  if (!hist.length) { host.innerHTML = `<div class="card"><div class="view__desc" style="margin:0">No completed bets yet.</div></div>`; return; }
  host.innerHTML = `<div class="card" style="padding:0;overflow:hidden">` + hist.map(rb => {
    const won = !!rb.won, col = won ? "var(--green)" : "var(--red)", sign = won ? "+" : "−";
    const pk = (rb.pickLabel && rb.pickLabel !== "—") ? `<div class="casino-hist__sub">Picked ${esc(rb.pickLabel)} → Result ${esc(rb.resultLabel)}</div>` : "";
    return `<div class="casino-hist"><span class="casino-ico" style="font-size:17px">${casinoGame(rb.range).icon}</span>
      <div style="flex:1"><div class="casino-hist__ttl">${esc(rb.game)} <span style="color:var(--dim);font-weight:400">as ${esc(rb.role)}</span></div>${pk}</div>
      <div style="font:800 14px/1 var(--mono);color:${col}">${sign}${casinoFmt(rb.profit)}</div></div>`;
  }).join("") + `</div>`;
}

// ---------------- win/lose flash (full-screen, body-appended; TERMINAL palette) ----------------
function casinoFlash(won, game, amount, pickLabel, resultLabel, range) {
  won ? casinoSfx.win() : casinoSfx.lose();
  const g = casinoGame(range || 2);
  const ov = document.createElement("div");
  ov.className = "casino-flash-ov";
  const detail = (pickLabel && resultLabel && pickLabel !== "—") ? `<div class="casino-flash__detail">Result <b>${esc(resultLabel)}</b> · you picked <b>${esc(pickLabel)}</b></div>` : "";
  const amt = (amount != null && amount !== "") ? `<div class="casino-flash__amt" style="color:${won ? "var(--green)" : "var(--red)"}">${won ? "+" : "−"}${casinoFmt(amount)} MINIMA</div>` : "";
  ov.innerHTML = `<div class="casino-flash ${won ? "is-win" : "is-lose"}">
      <div class="casino-flash__spin casino-spin-${g.range}"><span>${g.icon}</span></div>
      <div class="casino-flash__ttl" style="color:${won ? "var(--green)" : "var(--red)"}">${won ? "YOU WIN" : "YOU LOSE"}</div>
      ${detail}${amt}
      <div class="casino-flash__game">${esc(g.name)}</div>
      <button class="btn btn--primary casino-flash__go">CONTINUE</button>
    </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); };
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  ov.querySelector(".casino-flash__go").addEventListener("click", close);
  const onKey = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  if (activeView === "casino") setTimeout(() => { if (document.body.contains(ov)) renderCasino(); }, 400);
}
