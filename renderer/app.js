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
const THEMES = ["current", "original-light", "original-dark"];
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); }
function cycleTheme() {
  const i = THEMES.indexOf(CFG.theme || "current");
  CFG.theme = THEMES[(i + 1) % THEMES.length];
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

  api.onStatus(onStatus);
  api.onLog(appendLog);
  api.onMail(onMailUpdate);
  api.onPandapools(onPandapoolsUpdate);

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
    try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState();   // seed changed → re-derive the mail identity
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
      try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState();   // seed changed → re-derive the mail identity
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
}
function initTabScroll() {
  const tabs = el("tabs");
  if (!tabs) return;
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
}
function renderActive() {
  if (!running && activeView !== "node") { /* wallet views need the node */ }
  if (activeView === "balances") renderBalances();
  else if (activeView === "receive") renderReceive();
  else if (activeView === "send") renderSend();
  else if (activeView === "mail") renderMail();
  else if (activeView === "pandapools") renderPandapools();
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
function ppActsHtml(acts) {
  return acts.length ? acts.map(a => `<div class="row"><div class="row__mid">
      <div class="row__l1">${esc(a.type)} ${a.failed ? "· <span style=\"color:var(--red)\">Failed</span>" : a.confirmed ? "· <span style=\"color:var(--green)\">Confirmed</span>" : "· Confirming…"}</div>
      <div class="row__l2">${esc(short(a.summary, 52))}</div></div><div class="row__r">${esc(relTime(a.ts))}</div></div>`).join("")
    : `<div class="empty">No activity yet.</div>`;
}
function ppFeedHtml(feed) {
  return feed.length ? feed.map(f => `<div class="row"><div class="row__mid">
      <div class="row__l1">${esc(f.kind)} · ${esc(f.tokenLabel)}</div>
      <div class="row__l2">${esc(TOK.tidyAmount(f.minimaAmt))} MINIMA ${f.minimaIn ? "→" : "←"} ${esc(TOK.tidyAmount(f.tokenAmt))}</div></div>
      <div class="row__r">${esc(relTime(f.ts))}</div></div>`).join("")
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
async function renderHistory() {
  ensureHistActions();
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
async function renderHistoryList() {
  const host = el("histList");
  const rows = await api.histGet();
  if (!rows || !rows.length) {
    host.innerHTML = `<div class="empty">No transactions yet.${running ? "" : " Waiting for the node…"}</div>`;
    el("histMore").innerHTML = ""; return;
  }
  let tip = 0; try { const b = await tryCmd("block"); tip = parseInt((b && (b.block != null ? b.block : b)), 10) || 0; } catch (e) {}
  host.innerHTML = rows.map(histRowHtml).join("");
  host.querySelectorAll(".row[data-txid]").forEach(node => node.onclick = () => {
    const row = rows.find(x => x.txpowid === node.dataset.txid); if (row) showHistoryDetail(row, tip);
  });
  el("histMore").innerHTML = running ? `<button class="btn btn--outline btn--full" id="histOlder">Load older</button>` : "";
  if (el("histOlder")) el("histOlder").onclick = () => syncHistory({ older: true });
}
function histRowHtml(r) {
  const glyph = r.direction === "in" ? "↓" : r.direction === "out" ? "↑" : "⟲";
  const cls = r.direction === "in" ? "row__l1--green" : r.direction === "out" ? "row__l1--red" : "";
  let l1;
  if (r.kind === "split" || r.kind === "consolidation")
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
function showHistoryDetail(r, tip) {
  const conf = (tip && r.block) ? (tip - r.block + 1) : "";
  const timeStr = r.time ? new Date(r.time).toLocaleString() : "—";
  const lbl = labelFor(r.counterparty);
  const who = r.counterparty ? (lbl ? `${lbl} (${short(r.counterparty, 16)})` : r.counterparty) : "—";
  const deltas = Object.keys(r.difference || {}).map(t => `${esc(TOK.shortId(t))}: ${esc(TOK.tidyAmount(r.difference[t]))}`).join("<br>") || "—";
  const bd = (list) => (list && list.length ? list.map(c => `• ${esc(TOK.tidyAmount(c.amount))} ${esc(TOK.tokenName(c.token, c.tokenid))} → ${esc(short(c.address, 16))}`).join("<br>") : "—");
  const kind = r.kind !== "normal" ? (r.kind[0].toUpperCase() + r.kind.slice(1)) : (r.direction === "in" ? "Received" : r.direction === "out" ? "Sent" : "Self");
  document.body.insertAdjacentHTML("beforeend", `<div class="overlay" id="histDetail"><div class="modal">
    <div class="modal__title">Transaction</div>
    <div class="kv"><span class="kv__k">Type</span><span class="kv__v">${esc(kind)}</span></div>
    <div class="kv"><span class="kv__k">Amount</span><span class="kv__v">${esc(TOK.tidyAmount(r.amount))} ${esc(r.tokenName)}</span></div>
    <div class="kv"><span class="kv__k">Block</span><span class="kv__v">#${esc(r.block)}${conf !== "" ? " · " + conf + " conf" : ""}</span></div>
    <div class="kv"><span class="kv__k">Time</span><span class="kv__v">${esc(timeStr)}</span></div>
    <div class="kv"><span class="kv__k">Txpow id</span><span class="kv__v" id="histTxid" style="cursor:pointer" title="copy">${esc(short(r.txpowid, 22))}</span></div>
    <div class="kv"><span class="kv__k">${r.direction === "in" ? "From" : "To"}</span><span class="kv__v">${esc(who)}</span></div>
    <div class="view__sub">Per-token effect</div><div class="kv__v" style="text-align:left">${deltas}</div>
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
function coinLite(c) { return { address: c.miniaddress || c.address || "", amount: c.amount || c.tokenamount || "0", tokenid: c.tokenid || MINIMA, token: c.token }; }
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
function normalize(txpow, detail) {
  detail = detail || {};
  const hdr = txpow.header || {}, txn = (txpow.body && txpow.body.txn) || {};
  const inputs = (txn.inputs || []).map(coinLite), outputs = (txn.outputs || []).map(coinLite);
  const diff = detail.difference || {};
  let primTok = MINIMA, primAmt = "0";
  for (const tid of Object.keys(diff)) if (absCmp(diff[tid], primAmt) > 0) { primTok = tid; primAmt = diff[tid]; }
  const signed = String(primAmt), neg = signed.startsWith("-");
  const isZero = /^-?0*\.?0*$/.test(signed);
  let direction = isZero ? "self" : (neg ? "out" : "in");
  const inCount = inputs.length, outCount = outputs.length;
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
  const coinForTok = inputs.concat(outputs).find(c => c.tokenid === primTok);
  const tokenName = TOK.tokenName(coinForTok && coinForTok.token, primTok);
  const counterparty = (direction === "in" ? (inputs[0] && inputs[0].address) : (outputs[0] && outputs[0].address)) || "";
  return { txpowid: txpow.txpowid, block: parseInt(hdr.block, 10) || 0, time: parseInt(hdr.timemilli, 10) || 0,
    istransaction: !!txpow.istransaction, direction, kind, tokenid: primTok, tokenName, amount: String(amount),
    counterparty, inCount, outCount, difference: diff, inputs, outputs };
}
// adaptive pager (256KB cap → halve; skip oversized) + incremental stop at first known txpowid + persist + render
async function syncHistory(opts) {
  opts = opts || {};
  if (HIST_SYNCING) return; HIST_SYNCING = true;
  try {
    const known = new Set((await api.histGet()).map(r => r.txpowid));
    let offset = opts.older ? histOldestOffset : 0, max = 8, skips = 0, pages = 0, hitKnown = false;
    const fresh = [];
    for (;;) {
      let page;
      try {
        const j = await api.cmd(`history relevant:true max:${max} offset:${offset}`);
        page = (!j || j.status !== true || !j.response) ? { over: true } : { txpows: j.response.txpows || [], details: j.response.details || [] };
      } catch (e) { page = { over: true }; }
      if (page.over) { if (max > 1) { max = Math.floor(max / 2); continue; } if (skips < 3) { skips++; offset += 1; max = 8; continue; } break; }
      if (!page.txpows.length) break;
      for (let i = 0; i < page.txpows.length; i++) {
        const row = normalize(page.txpows[i], page.details[i]);
        if (!row.txpowid) continue;
        if (!opts.older && known.has(row.txpowid)) { hitKnown = true; break; }
        fresh.push(row);
      }
      if (hitKnown) break;
      offset += page.txpows.length; max = 8; skips = 0;
      if (opts.older && ++pages >= 4) break;
    }
    if (fresh.length) await api.histAdd(fresh);
    histOldestOffset = opts.older ? offset : Math.max(histOldestOffset, offset);
    await renderHistoryList();
  } finally { HIST_SYNCING = false; }
}
function histType(r) { return r.kind !== "normal" ? r.kind : (r.direction === "in" ? "Received" : r.direction === "out" ? "Sent" : "Self"); }
function histDate(ms) { return ms ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") : ""; }
async function copyHistory() {
  const rows = await api.histGet();
  const lines = rows.map(r => [histDate(r.time), histType(r), TOK.tidyAmount(r.amount), r.tokenName, labelFor(r.counterparty) || r.counterparty, r.txpowid, r.block].join("\t"));
  copy(["date\ttype\tamount\ttoken\tcounterparty\ttxpowid\tblock", ...lines].join("\n"));
}
async function exportHistory() {
  const rows = await api.histGet();
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = rows.map(r => [histDate(r.time), histType(r), TOK.tidyAmount(r.amount), r.tokenName, labelFor(r.counterparty) || r.counterparty, r.txpowid, r.block].map(q).join(","));
  const csv = ["date,type,amount,token,counterparty,txpowid,block", ...lines].join("\r\n");
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
  const [addr, keys] = await Promise.all([tryCmd("getaddress"), tryCmd("keys action:list")]);
  const ku = keysInfo(keys);
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
      if (resetsWallet) { try { await api.mailInvalidate(); } catch (e) {} resetMailState(); try { await api.ppInvalidate(); } catch (e) {} resetPpState(); }   // seed reset → re-derive the mail identity
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
