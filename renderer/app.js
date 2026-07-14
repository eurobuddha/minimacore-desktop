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
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
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

  api.onStatus(onStatus);
  api.onLog(appendLog);

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
  if (s.state === "running" && s.health) label = "● " + (s.health.connections || 0) + " peers · #" + (s.health.block || 0);
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
    if (CFG.walletDone) { hideSetup(); renderActive(); }
    else if (!postBootStarted) { postBootStarted = true; runPostBoot(); }
  }
  if (activeView === "node") renderNode(s);
}

// ---- first-run wizard: ONE upfront screen — network + new/restore + options ----
function showSetup() {
  el("shell").style.filter = "blur(2px)";
  const box = el("setupBody");
  const def = CFG.dataFolder || "";
  box.innerHTML = `
    <div class="view__desc">Set up your node. Nothing here leaves this Mac.</div>

    <div class="setup-sec"><div class="setup-sec__h">Network</div>
      <label class="opt sel" data-net="mainnet"><b>Mainnet</b><span>Join the live Minima network — syncs to the tip in seconds.</span></label>
      <label class="opt" data-net="solo"><b>Solo / test</b><span>A private local chain that auto-mines — safe for trying things out.</span></label>
      <label class="opt" data-net="custom"><b>Custom peer</b><span>Connect to a specific host:port you provide.</span></label>
      <input class="field__input" id="customPeer" placeholder="host:port" style="display:none;margin-top:4px" />
    </div>

    <div class="setup-sec" id="walletSec"><div class="setup-sec__h">Wallet</div>
      <label class="opt sel" data-w="new"><b>New wallet</b><span>Generate a fresh seed on this node. You'll back up the 24 words next.</span></label>
      <label class="opt" data-w="restore"><b>Restore from seed</b><span>Import an existing 24-word seed and fast-sync via MegaMMR.</span></label>
      <div id="restoreFields" style="display:none">
        <div class="field" style="margin-top:6px"><div class="field__label">Your 24-word seed phrase</div>
          <textarea class="field__input" id="rSeed" rows="3" placeholder="word1 word2 …"></textarea></div>
        <div class="field"><div class="field__label">Signatures already used (key-uses)</div>
          <input class="field__input" id="rKeyuses" value="0" inputmode="numeric" /></div>
        <div class="view__desc" style="color:var(--amber)">⚠ Key-uses must be at least the number of signatures this seed has ever made, on any node. Too low reuses one-time keys and can lose funds — if unsure, set it higher.</div>
        <div class="field"><div class="field__label">MegaMMR host (ip:port, must run -megammr)</div>
          <input class="field__input" id="rHost" value="${esc(CFG.megammrHost)}" /></div>
      </div>
    </div>

    <div class="setup-sec"><div class="setup-sec__h">Options</div>
      <div class="field"><div class="field__label">Data folder</div>
        <div class="seg"><input class="field__input" id="dataFolder" placeholder="(default app folder)" value="${esc(def)}" readonly />
        <button class="btn btn--outline btn--sm" id="pickFolder">Choose…</button></div></div>
      <div class="field"><div class="field__label">Base port (RPC = +4)</div>
        <input class="field__input" id="basePort" value="${esc(CFG.basePort)}" /></div>
      <label class="opt" id="megammr" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" ${CFG.megammr ? "checked" : ""}/> <span style="margin:0;color:var(--text)">Keep full history (megammr) — bigger, slower initial sync</span></label>
    </div>

    <button class="btn btn--primary btn--full" id="startNode" style="margin-top:12px">Start node</button>`;

  let net = CFG.network || "mainnet", wmode = "new";
  const walletSec = el("walletSec");
  const selectNet = (n) => {
    net = n;
    box.querySelectorAll(".opt[data-net]").forEach(x => x.classList.toggle("sel", x.dataset.net === n));
    el("customPeer").style.display = n === "custom" ? "" : "none";
    walletSec.style.display = n === "solo" ? "none" : "";   // solo runs its own local seed
  };
  const selectW = (w) => {
    wmode = w;
    box.querySelectorAll(".opt[data-w]").forEach(x => x.classList.toggle("sel", x.dataset.w === w));
    el("restoreFields").style.display = w === "restore" ? "" : "none";
  };
  box.querySelectorAll(".opt[data-net]").forEach(o => o.onclick = () => selectNet(o.dataset.net));
  box.querySelectorAll(".opt[data-w]").forEach(o => o.onclick = () => selectW(o.dataset.w));
  if (CFG.customConnect) el("customPeer").value = CFG.customConnect;
  selectNet(net); selectW("new");   // apply the initial (current-config) selection + section visibility
  el("pickFolder").onclick = async () => { const f = await api.pickFolder(); if (f) el("dataFolder").value = f; };

  el("startNode").onclick = async () => {
    const basePort = parseInt(el("basePort").value, 10) || CFG.basePort;
    if (net === "custom" && !el("customPeer").value.trim()) { toast("Enter a host:port for the custom peer."); return; }
    const solo = net === "solo";
    const walletMode = solo ? "new" : wmode;
    let host = CFG.megammrHost;

    // A restore holds the seed + key-uses in memory only — applied by megammrsync after the node is up.
    if (walletMode === "restore") {
      const seed = el("rSeed").value.trim().replace(/\s+/g, " ");
      const keyuses = parseInt(el("rKeyuses").value, 10);
      host = el("rHost").value.trim() || CFG.megammrHost;
      if (seed.split(" ").length < 12) { toast("Enter your full 24-word seed phrase."); return; }
      if (isNaN(keyuses) || keyuses < 0) { toast("Enter the key-uses count (0 if brand new)."); return; }
      RESTORE = { seed, keyuses, host };
    }

    // walletDone: solo needs no ceremony; a restore must (re)run the resync; a fresh new wallet needs the seed
    // backup step; an already-onboarded user just changing network keeps their wallet (stays done).
    const walletDone = solo ? true : (walletMode === "restore" ? false : !!CFG.walletDone);
    const patch = {
      setupDone: true, network: net, basePort, walletMode, walletDone,
      dataFolder: el("dataFolder").value || "",
      megammr: el("megammr").querySelector("input").checked,
      customConnect: net === "custom" ? el("customPeer").value.trim() : "",
      megammrHost: host
    };
    CFG = await api.saveConfig(patch);
    waitingForNode = true;
    postBootStarted = false;      // let the post-boot wallet step run for this (re)start
    showStarting();
    // reconfiguring a live node needs a restart to apply new args; first run just starts.
    if (running) await api.nodeRestart(); else await api.nodeStart();
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
    <div class="view__desc">Restore a different 24-word seed on this node. The current wallet will be replaced by the restored one.</div>
    <div class="field"><div class="field__label">Your 24-word seed phrase</div>
      <textarea class="field__input" id="orSeed" rows="3" placeholder="word1 word2 …"></textarea></div>
    <div class="field"><div class="field__label">Signatures already used (key-uses)</div>
      <input class="field__input" id="orKeyuses" value="0" inputmode="numeric" /></div>
    <div class="view__desc" style="color:var(--amber)">⚠ Key-uses must be at least the number of signatures this seed has ever made, on any node. Too low reuses one-time keys and can lose funds — if unsure, set it higher.</div>
    <div class="field"><div class="field__label">MegaMMR host (ip:port, must run -megammr)</div>
      <input class="field__input" id="orHost" value="${esc(CFG.megammrHost)}" /></div>
    <div class="seg"><button class="btn btn--outline btn--full" id="orCancel">Cancel</button>
      <button class="btn btn--primary btn--full" id="orGo">Restore + sync</button></div>`;
  el("orCancel").onclick = () => { hideSetup(); };
  el("orGo").onclick = async () => {
    const seed = el("orSeed").value.trim().replace(/\s+/g, " ");
    const keyuses = parseInt(el("orKeyuses").value, 10);
    const host = el("orHost").value.trim() || CFG.megammrHost;
    if (seed.split(" ").length < 12) { toast("Enter your full seed phrase."); return; }
    if (isNaN(keyuses) || keyuses < 0) { toast("Enter the key-uses count (0 if brand new)."); return; }
    el("orGo").disabled = true; el("orGo").textContent = "Restoring…";
    try {
      await cmd(`megammrsync action:resync host:${host} phrase:"${seed}" anyphrase:true keyuses:${keyuses}`);
      CFG = await api.saveConfig({ megammrHost: host });
      hideSetup(); renderActive(); toast("Wallet restored ✓", "ok");
    } catch (e) { toast("Restore failed: " + e.message, "err"); el("orGo").disabled = false; el("orGo").textContent = "Restore + sync"; }
  };
  el("setup").style.display = "";
}

// ---- tabs / refresh --------------------------------------------------------
function selectTab(view) {
  activeView = view;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("tab--active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("view--active", v.id === "view-" + view));
  renderActive();
}
function renderActive() {
  if (!running && activeView !== "node") { /* wallet views need the node */ }
  if (activeView === "balances") renderBalances();
  else if (activeView === "receive") renderReceive();
  else if (activeView === "send") renderSend();
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
  host.innerHTML = bal.map(b => {
    const t = b.token && typeof b.token === "object" ? (b.token.name && (b.token.name.name || b.token.name) || "") : (b.token || "");
    const name = b.tokenid === MINIMA ? "MINIMA" : (t || short(b.tokenid, 10));
    return `<div class="card">
      <div class="kv"><span class="kv__k">${esc(name)}</span><span class="kv__v">${esc(b.confirmed)}</span></div>
      <div class="kv"><span class="kv__k">sendable</span><span class="kv__v kv__v--green">${esc(b.sendable)}</span></div>
      ${b.unconfirmed && b.unconfirmed !== "0" ? `<div class="kv"><span class="kv__k">pending</span><span class="kv__v kv__v--amber">${esc(b.unconfirmed)}</span></div>` : ""}
    </div>`;
  }).join("");
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
}
function drawQR(text) {
  const host = el("qr"); host.innerHTML = "";
  if (!text || text.indexOf("0x") === 0 && text.length < 5 || typeof qrcode === "undefined") return;
  try { const qr = qrcode(0, "M"); qr.addData(text); qr.make(); host.innerHTML = qr.createImgTag(5, 6); }
  catch (e) { /* address too long for one QR — the copyable text still works */ }
}

// ---- Settings --------------------------------------------------------------
async function renderSettings() {
  const host = el("settingsBody");
  if (!running) { host.innerHTML = `<div class="spin">Waiting for the node…</div>`; return; }
  const [addr, keys] = await Promise.all([tryCmd("getaddress"), tryCmd("keys action:list")]);
  const uses = keysMaxUses(keys);
  host.innerHTML = `
    <div class="card"><div class="card__title">Wallet</div>
      <div class="kv"><span class="kv__k">Address</span><span class="kv__v">${esc(short((addr && (addr.miniaddress || addr.address)) || "—", 22))}</span></div>
      <div class="kv"><span class="kv__k">Signatures used</span><span class="kv__v">${esc(uses)}</span></div>
      <button class="btn btn--outline btn--full" id="setReveal" style="margin-top:8px">Reveal seed phrase</button>
      <div class="addrbox" id="setSeed" style="display:none;white-space:normal;line-height:1.6"></div>
      <button class="btn btn--outline btn--full" id="setRestore">Restore from a different seed…</button>
    </div>
    <div class="card"><div class="card__title">Backup</div>
      <div class="view__desc">Writes an encrypted recovery backup into the node's data folder. Your seed phrase (above) is the ultimate backup.</div>
      <div class="field"><input class="field__input" id="bkPw" type="password" placeholder="backup password" /></div>
      <button class="btn btn--outline btn--full" id="setBackup">Create encrypted backup</button>
    </div>
    <div class="card"><div class="card__title">Diagnostics</div>
      <div class="field"><input class="field__input" id="diagCmd" placeholder="a node command, e.g. status" /></div>
      <button class="btn btn--sm btn--outline" id="diagGo">Run</button>
      <pre class="logbox" id="diagOut"></pre>
    </div>
    <div class="card"><div class="card__title">Appearance</div>
      <button class="btn btn--outline btn--full" id="setTheme">Theme: ${esc(CFG.theme)}</button>
    </div>`;
  el("setReveal").onclick = async () => { const v = await tryCmd("vault"); const p = seedFrom(v); if (!p) { toast("Couldn't read the seed.", "err"); return; } el("setSeed").style.display = ""; el("setSeed").textContent = p; };
  el("setRestore").onclick = () => showRestoreOverlay();
  el("setBackup").onclick = async () => {
    const pw = el("bkPw").value.trim();
    if (!pw) { toast("Enter a backup password."); return; }
    try { await cmd(`backup password:"${pw}"`); toast("Encrypted backup written to the node data folder ✓", "ok"); }
    catch (e) { toast("Backup failed: " + e.message, "err"); }
  };
  el("diagGo").onclick = async () => { const c = el("diagCmd").value.trim(); if (!c) return; try { const r = await api.cmd(c); el("diagOut").textContent = JSON.stringify(r, null, 2); } catch (e) { el("diagOut").textContent = e.message; } };
  el("setTheme").onclick = () => { cycleTheme(); renderSettings(); };
}
function keysMaxUses(keys) {
  try { const arr = Array.isArray(keys) ? keys : (keys && keys.keys) || []; let m = 0; for (const k of arr) m = Math.max(m, parseInt(k.uses, 10) || 0); return m; }
  catch (e) { return "—"; }
}

// ---- Send ------------------------------------------------------------------
async function renderSend() {
  const card = el("sendCard");
  if (!running) { card.innerHTML = `<div class="spin">Waiting for the node…</div>`; return; }
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
    f.innerHTML = `
      <div class="field"><div class="field__label">To address</div><input class="field__input" id="sTo" placeholder="Mx… or 0x…" /></div>
      <div class="field"><div class="field__label">Amount</div><input class="field__input" id="sAmt" placeholder="0.0" /></div>
      <div class="field"><div class="field__label">Token id (blank = MINIMA)</div><input class="field__input" id="sTok" placeholder="0x00" /></div>
      <button class="btn btn--primary btn--full" id="sGo">Send</button>`;
    el("sGo").onclick = async () => {
      const to = el("sTo").value.trim(), amt = el("sAmt").value.trim(), tok = el("sTok").value.trim();
      if (!to || !amt) { toast("Enter an address and amount."); return; }
      el("sGo").disabled = true; el("sGo").textContent = "Sending…";
      try { const r = await cmd(`send address:${to} amount:${amt}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : "")); toast("Sent ✓ " + short((r && r.txpowid) || "", 12), "ok"); el("sTo").value = el("sAmt").value = ""; }
      catch (e) { toast(e.message, "err"); }
      el("sGo").disabled = false; el("sGo").textContent = "Send";
    };
  } else if (mode === "split") {
    f.innerHTML = `
      <div class="view__desc">Split your own coins into equal pieces (useful for parallel sends).</div>
      <div class="field"><div class="field__label">Token id (blank = MINIMA)</div><input class="field__input" id="spTok" placeholder="0x00" /></div>
      <div class="field"><div class="field__label">Amount to split</div><input class="field__input" id="spAmt" placeholder="0.0" /></div>
      <div class="field"><div class="field__label">Into how many coins (2–20)</div><input class="field__input" id="spN" value="10" /></div>
      <button class="btn btn--primary btn--full" id="spGo">Split</button>`;
    el("spGo").onclick = async () => {
      const amt = el("spAmt").value.trim(), n = parseInt(el("spN").value, 10) || 0, tok = el("spTok").value.trim();
      if (!amt || n < 2 || n > 20) { toast("Enter an amount and 2–20 coins."); return; }
      el("spGo").disabled = true;
      try { const a = await cmd("getaddress"); const addr = a.miniaddress || a.address;
        await cmd(`send address:${addr} amount:${amt} split:${n}` + (tok && tok !== MINIMA ? ` tokenid:${tok}` : "")); toast("Split ✓", "ok"); }
      catch (e) { toast(e.message, "err"); }
      el("spGo").disabled = false;
    };
  } else {
    f.innerHTML = `
      <div class="view__desc">Merge many small coins of one token into fewer, larger coins.</div>
      <div class="field"><div class="field__label">Token id (blank = MINIMA)</div><input class="field__input" id="coTok" placeholder="0x00" /></div>
      <button class="btn btn--primary btn--full" id="coGo">Consolidate</button>`;
    el("coGo").onclick = async () => {
      const tok = el("coTok").value.trim() || MINIMA;
      el("coGo").disabled = true;
      try { await cmd(`consolidate tokenid:${tok}`); toast("Consolidated ✓", "ok"); }
      catch (e) { toast(e.message, "err"); }
      el("coGo").disabled = false;
    };
  }
}

// ---- Node (status / config / update / logs) --------------------------------
function renderNode(s) {
  s = s || { state: "?", health: null };
  const c = el("nodeCard");
  const h = s.health || {};
  c.innerHTML = `
    <div class="kv"><span class="kv__k">State</span><span class="kv__v">${esc(s.state)}</span></div>
    <div class="kv"><span class="kv__k">Version</span><span class="kv__v">${esc(h.version || "—")}</span></div>
    <div class="kv"><span class="kv__k">Block</span><span class="kv__v">${esc(h.block ?? "—")}</span></div>
    <div class="kv"><span class="kv__k">Peers</span><span class="kv__v">${esc(h.connections ?? "—")}</span></div>
    <div class="kv"><span class="kv__k">Network</span><span class="kv__v">${esc(CFG.network)}</span></div>
    <div class="kv"><span class="kv__k">RPC port</span><span class="kv__v">${esc(s.rpcPort || CFG.basePort + 4)}</span></div>
    ${s.lastError ? `<div class="kv"><span class="kv__k">Error</span><span class="kv__v kv__v--red">${esc(s.lastError)}</span></div>` : ""}
    <div class="seg" style="margin-top:10px">
      <button class="btn btn--sm btn--outline" id="nRestart">Restart node</button>
      <button class="btn btn--sm btn--outline" id="nUpdate">Check for update</button>
    </div>
    <button class="btn btn--outline btn--full" id="nReconfig" style="margin-top:8px">Reconfigure node (network · new/restore · startup params)…</button>`;
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
}

let logLines = [];
async function initLogs() { logLines = await api.nodeLogs(); paintLogs(); }
function appendLog(line) { if (!line) return; logLines.push(line); if (logLines.length > 300) logLines.shift(); paintLogs(); }
function paintLogs() { const b = el("logbox"); if (b) { b.textContent = logLines.join("\n"); b.scrollTop = b.scrollHeight; } }

boot();
initLogs();
