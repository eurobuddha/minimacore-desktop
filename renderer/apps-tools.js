/*
 * apps-tools.js: the screens of the tray apps added in Phase 5b (KeyUses, Minima Explorer, Entropy), each as its
 * original in Pandamonium draws it (apks/base integrated/…), expanded to the window. Loaded before app.js: it only declares
 * functions, which use app.js's helpers (el, esc, api, copy, toast, running) when they are called. What a screen SHOWS is worked out in renderer/apps-act.js (no DOM
 * there, so it is tested); what it ASKS is one call to the main process per action. Peer, node and server text
 * reaches the page through esc() or textContent only.
 */
"use strict";

// ---- KeyUses: Pandamonium's KeyUses 0.1.4 (integrated/keyreuses MainActivity), over main/keyuses.js ----------------
// One screen: the badge, the title, Run audit, the privacy line; then the verdict and the table; the explainer.
// Not here: "Include minimaWallet's classic keys" (no minimaWallet on the desktop) and the keys derived from the seed.
let KU_STATE = { busy: false, error: "", result: null };
function keyUsesReset() { KU_STATE = { busy: KU_STATE.busy, error: "", result: null }; }   // leaving the screen drops the result, as the original's onStop
async function keyUsesRun() {
  if (KU_STATE.busy) return;
  KU_STATE = { busy: true, error: "", result: null }; renderKeyUses();
  let r;
  try { r = await api.keyUsesAudit(); } catch (e) { r = { ok: false, error: AppsAct.keyuses.UNAVAILABLE }; }
  KU_STATE = { busy: false, error: r && r.ok ? "" : (r && r.error) || AppsAct.keyuses.UNAVAILABLE, result: r && r.ok ? r : null };
  if (activeView === "keyuses") { renderKeyUses(); const b = el("kuRun"); if (b) b.focus(); } else keyUsesReset();
}
function keyUsesResults(r) {
  const K = AppsAct.keyuses, C = K.COPY, v = K.verdict(r);
  const notice = (text, tone) => `<div class="kx-notice kx-notice--${tone}">${esc(text)}</div>`;
  const block = (b) => b.cmd
    ? `<button class="kx-inset kx-inset--copy" data-copy="${esc(b.cmd)}" title="Click to copy"><span class="kx-label">${esc(b.label)}</span><code class="kx-code">${esc(b.cmd)}</code></button>`
    : `<div class="kx-inset"><div class="kx-label">${esc(b.label)}</div><div class="kx-inset__body">${esc(b.body)}</div></div>`;
  const row = (x, n) => { const c = K.chip(x); return `<div class="kx-row" role="row">
      <div class="kx-cell kx-cell--addr" role="cell"><div class="kx-num kx-tone--${c.tone}">#${n}${x.family === "block" ? " · 128/4" : ""}</div><span class="kx-chip kx-chip--${c.tone}">${esc(c.label)}</span>
        <div class="kx-src">Node</div><button class="kx-addr" data-copy="${esc(x.address)}" title="Click to copy">${esc(x.address)}</button></div>
      <div class="kx-cell" role="cell">${esc(K.num(x.local))}</div><div class="kx-cell" role="cell">${esc(K.num(x.sigs))}</div><div class="kx-cell" role="cell">${esc(K.num(x.coins))}</div></div>`; };
  const head = `<div class="kx-row kx-row--head" role="row"><div class="kx-cell kx-cell--addr" role="columnheader">Address (click to copy)</div><div class="kx-cell" role="columnheader">Local uses</div><div class="kx-cell" role="columnheader">Spend blocks</div><div class="kx-cell" role="columnheader">Spent coins</div></div>`;
  return (r.complete ? "" : notice(C.incomplete, "warn"))
    + `<div class="kx-scope">Checked scope: ${esc(r.classicKeys)} classic · ${esc(r.blockKeys)} block-based keys</div>`
    + (r.mismatch ? notice(C.mismatch, "risk") : "") + (r.exhaustion ? notice(C.exhaustion, "warn") : "")
    + `<div class="kx-verdict kx-verdict--${v.tone}"><h2 class="kx-verdict__t">${esc(v.title)}</h2><p class="kx-verdict__b">${esc(v.body)}</p>${v.blocks.map(block).join("")}</div>`
    + `<div class="kx-card kx-card--table">${K.sections(r).map(s => `<div class="kx-section" role="table" aria-label="${esc(s.title)}"><h3 class="kx-section__t">${esc(s.title)}</h3>${head}${s.rows.map((x, i) => row(x, i + 1)).join("")}</div>`).join("")}
      <div class="kx-cov">${r.tip > 0 ? "Archive coverage to block " + esc(r.tip) + "." : "The archive did not say which block it reaches."} Spend blocks can undercount signatures. Only default addresses are checked; custom scripts and multisig usage are not included. A clear result is not proof that a key is safe.</div></div>`;
}
function renderKeyUses() {
  const C = AppsAct.keyuses.COPY, s = KU_STATE;
  el("keyusesBody").innerHTML = `<div class="kx">
    <div class="kx-badge"><i></i>Key audit</div>
    <h1 class="kx-title">KeyUses</h1>
    <p class="kx-sub">Check the keys this node holds for one-time signature reuse: classic keys and block-based keys, whichever this wallet has.</p>
    ${running ? "" : `<div class="kx-pair"><b>The node is not ready</b><span>Start the node on the Node tab, then run the audit.</span></div>`}
    <div class="kx-card">
      <button class="kx-run" id="kuRun"${s.busy || !running ? " disabled" : ""}>${s.busy ? `<i class="kx-spin" aria-hidden="true"></i>Auditing your keys…` : "Run audit"}</button>
      <p class="kx-privacy">Only public keys and addresses are sent to eurobuddha.com for the audit. This reveals the selected addresses to that server. Seeds stay on this computer.</p>
      ${s.error ? `<div class="kx-error" role="alert">${esc(s.error)}</div>` : ""}
    </div>
    <div id="kuResults" aria-live="polite">${s.result ? keyUsesResults(s.result) : ""}</div>
    <div class="kx-card"><div class="kx-label">Key audit</div><p class="kx-explain">${esc(C.explain)}</p>
      <p class="kx-explain">On this computer the audit covers the keys the node holds. The phone also checks the 64 classic and 32 block-based keys it derives from the seed, and minimaWallet’s keys; that is not done here.</p></div>
    <div class="kx-foot">eurobuddha · Minima Ecosystem · KeyUses</div></div>`;
  el("kuRun").onclick = keyUsesRun;
}

// ---- Minima Explorer: Pandamonium's block explorer (integrated/blockexplorer MainActivity), over main/explorer.js ---
// Home (three tiles, LATEST BLOCKS, Load older), then pushed pages with Back: block, transaction, address. Every read is
// one of the seven the main process builds; blocks are fetched one at a time with the original's pause. Its own dark /
// light palette behind the header's button, as the original (it does not follow the system).
// Different from the phone on purpose: every id and address is shown whole (the phone cuts them to 10…8) and can be copied.
const EX_MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
let EX = null;
function explorerReset() { const gen = EX ? EX.gen + 1 : 1; EX = { gen, tip: "", blocks: [], lowest: 0, loading: false, end: false, status: "", speed: "", db: "", pages: [], blockCache: new Map(), txCache: new Map(), timer: null }; }
explorerReset();
const exKeep = (map, key, value, cap) => { map.delete(key); map.set(key, value); if (map.size > cap) map.delete(map.keys().next().value); };
const exWait = (ms) => new Promise(r => setTimeout(r, ms));
/** One read. → the node's `response` (an object or a list), or null when the node refused, was not there, or had nothing. */
async function exAsk(kind, arg) {
  try { const j = await api.explorer(kind, arg); return j && j.status === true && j.response != null ? j : null; } catch (e) { return null; }
}
function exDateTime(ms) { return ms > 0 ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "Time not given"; }
function exTokenLabel(c) {
  const X = AppsAct.explorer, tid = c && c.tokenid;
  if (X.isMinima(tid)) return "MINIMA";
  return String(tid).toUpperCase() === EX_MXUSD.toUpperCase() ? "MxUSD" : nameWithId(String(tid), X.tokenName(c));
}

// ---- the chain list ----
function explorerTip(s) {   // from every node status: a block the list has not seen starts one refresh (coalesced, as the phone's 400 ms)
  const b = s && s.health && s.health.block != null ? String(s.health.block) : "";
  if (!running || !b || b === EX.tip) return;
  clearTimeout(EX.timer); EX.timer = setTimeout(explorerRefresh, 400);
}
async function explorerRefresh() {
  if (!running) return;
  const gen = EX.gen, j = await exAsk("tip");
  if (gen !== EX.gen) return;
  const tip = j ? AppsAct.explorer.height({ header: j.response }) : "";
  if (!tip || tip === "0") { if (!EX.blocks.length) { EX.status = "node unreachable"; explorerPaint(); } return; }
  const first = !EX.tip, gap = first ? 0 : Number(tip) - Number(EX.tip);
  EX.tip = tip; explorerChrome();
  if (first || !EX.blocks.length) explorerReload();
  else if (gap > 0) { if (gap <= AppsAct.explorer.MAX_LIVE_GAP) { if (!EX.loading) { EX.loading = true; explorerLoad(Number(tip), gap, true); } } else explorerReload(); }
  exAsk("status").then(r => { const c = r && r.response.chain; const t = c ? AppsAct.explorer.blockTime(c.speed) : ""; if (t && gen === EX.gen) { EX.speed = t; explorerPaint(true); } });
  exAsk("info").then(r => { const d = r && r.response.txpowdb; const n = d ? AppsAct.explorer.groupNum(d.size) : ""; if (n && gen === EX.gen) { EX.db = n + " txns"; explorerPaint(true); } });
}
function explorerReload() { EX.blocks = []; EX.blockCache.clear(); EX.end = false; EX.loading = false; EX.lowest = Number(EX.tip) + 1; explorerOlder(); }
function explorerOlder() {
  if (EX.loading || EX.end || !EX.tip) return;
  EX.loading = true; EX.status = "loading…"; explorerPaint(true);
  explorerLoad(EX.lowest - 1, AppsAct.explorer.PAGE, false);
}
/** The sequential walker (MainActivity.loadChain): down from `height` for `count` blocks, one read at a time. prepend: the few new blocks above the list. */
async function explorerLoad(height, count, prepend) {
  const gen = EX.gen, X = AppsAct.explorer, top = prepend && EX.blocks.length ? Number(X.height(EX.blocks[0])) : 0;
  let at = 0;
  for (; count > 0 && height > 0 && !(prepend && height <= top); count--, height--) {
    let txpow = EX.blockCache.get(height);
    if (!txpow) {
      const j = await exAsk("block", String(height));
      if (gen !== EX.gen) return;
      txpow = j && typeof j.response === "object" && !Array.isArray(j.response) ? j.response : null;
      if (!txpow) { if (!prepend) EX.end = true; break; }   // "TxPoW not found @ height N": below what the node keeps
      exKeep(EX.blockCache, height, txpow, 200);
    }
    if (prepend) EX.blocks.splice(at++, 0, txpow); else { EX.blocks.push(txpow); EX.lowest = height; }
    explorerPaint(true);
    await exWait(X.FETCH_GAP_MS);   // never hammer the node
    if (gen !== EX.gen) return;
  }
  EX.loading = false; EX.status = EX.end ? "end of retained chain" : ""; explorerPaint(true);
}

// ---- search and pages ----
async function explorerSearch() {
  const q = AppsAct.explorer.classify(el("exSearch").value);
  if (!q) return;
  if (q.kind === "bad") return toast("Enter a block number, TxPoW ID or address");
  if (q.kind === "block") return explorerBlockAt(q.arg);
  if (q.kind === "address") return explorerAddress(q.arg);
  explorerFind(q.arg);
}
async function explorerBlockAt(h) {
  const X = AppsAct.explorer; let txpow = EX.blockCache.get(Number(h));
  if (!txpow) {
    toast("Looking up block " + X.groupNum(h) + "…");
    const gen = EX.gen, j = await exAsk("block", h); if (gen !== EX.gen) return;
    txpow = j && typeof j.response === "object" && !Array.isArray(j.response) ? j.response : null;
    if (!txpow) return toast("Block " + h + " not found on this node");
    exKeep(EX.blockCache, Number(h), txpow, 200);
  }
  explorerPush({ type: "block", txpow });
}
/** A 0x string can be a TxPoW id or an address: the id first, then the address (searchTxpowThenAddress). */
async function explorerFind(id) {
  let txpow = EX.txCache.get(id);
  if (!txpow) {
    toast("Searching…");
    const gen = EX.gen, j = await exAsk("txpow", id); if (gen !== EX.gen) return;
    txpow = j && typeof j.response === "object" && !Array.isArray(j.response) ? j.response : null;
    if (!txpow) return explorerAddress(id);
    exKeep(EX.txCache, id, txpow, 100);
  }
  explorerPush({ type: AppsAct.explorer.pageOf(txpow), txpow });
}
async function explorerTxn(id) {
  let txpow = EX.txCache.get(id);
  if (!txpow) {
    toast("Loading transaction…");
    const gen = EX.gen, j = await exAsk("txpow", id); if (gen !== EX.gen) return;
    txpow = j && typeof j.response === "object" && !Array.isArray(j.response) ? j.response : null;
    if (!txpow) return toast(id + " not found on this node", "", id);
    exKeep(EX.txCache, id, txpow, 100);
  }
  explorerPush({ type: "txn", txpow });
}
async function explorerAddress(addr) {
  const gen = EX.gen; let j = null;
  try { j = await api.explorer("address", addr); } catch (e) {}
  if (gen !== EX.gen) return;
  const list = j && j.status === true && Array.isArray(j.response) ? j.response.filter(t => t && typeof t === "object") : [];
  if (!list.length) return toast(addr + " not found on this node", "", addr);
  explorerPush({ type: "address", addr, list, total: Number(j.total) || list.length });
}
function explorerPush(page) {
  EX.pages.push(page); explorerPaint();
  const b = el("explorerBody").querySelector("[data-ex=back]"); if (b) b.focus();
  if (page.type === "txn") {   // confirmations, when the node answers
    const gen = EX.gen, id = String(page.txpow.txpowid || "");
    api.explorer("onchain", id).then(j => AppsAct.explorer.onchain(j), () => null).then(c => { if (gen !== EX.gen) return; page.conf = c || { ok: false, text: "" }; if (EX.pages[EX.pages.length - 1] === page) explorerPaint(true); });
  }
}

// ---- drawing ----
const exCopy = (key, value) => `<button class="ex-copy" data-copy="${esc(value)}"><span class="ex-copy__k">${esc(key)}   (click to copy)</span><span class="ex-mono">${esc(value)}</span></button>`;
const exKv = (key, value) => `<div class="ex-kv"><span>${esc(key)}</span><b>${esc(value)}</b></div>`;
const exLink = (label, id, act) => `<div class="ex-linkrow">${label ? `<div class="ex-linkrow__l">${esc(label)}</div>` : ""}<button class="ex-link" data-ex="${act}" data-id="${esc(id)}">${esc(id)}  ›</button><button class="ex-cp" data-copy="${esc(id)}" aria-label="Copy ${esc(id)}">Copy</button></div>`;
const exGiven = (v, unit) => (v == null || v === "" ? "Not given" : String(v) + (unit || ""));
function exRaw(page) {
  return `<div class="ex-card"><button class="ex-rawbtn" data-ex="raw" aria-expanded="${page.raw ? "true" : "false"}">{ }  ${page.raw ? "Hide raw JSON  ▴" : "View raw JSON  ▾"}</button>
    ${page.raw ? `<button class="ex-cp ex-cp--raw" data-copy="${esc(JSON.stringify(page.txpow, null, 2))}">Copy JSON</button><pre class="ex-raw" tabindex="0">${esc(JSON.stringify(page.txpow, null, 2))}</pre>` : ""}</div>`;
}
function exWhen(txpow) { const ms = AppsAct.explorer.timeMilli(txpow); return esc(exDateTime(ms)) + (ms > 0 ? "   ·   " + esc(histWhen(ms)) : ""); }
function exBlockPage(page) {
  const X = AppsAct.explorer, t = page.txpow, h = t.header || null, list = t.body && Array.isArray(t.body.txnlist) ? t.body.txnlist.filter(x => typeof x === "string" && x) : [];
  const parent = h && Array.isArray(h.superparents) && h.superparents[0] && typeof h.superparents[0].parent === "string" ? h.superparents[0].parent : "";
  return `<div class="ex-card ex-card--hero"><div class="ex-big">#${esc(X.groupNum(X.height(t)) || "Height not given")}</div><div class="ex-when">${exWhen(t)}</div></div>
    <div class="ex-card">${exCopy("TxPoW ID", String(t.txpowid || ""))}${exKv("Superblock level", exGiven(t.superblock))}${exKv("Size", exGiven(t.size, " bytes"))}${exKv("Burn", X.tidyAmount(t.burn == null ? "0" : t.burn) + " MINIMA")}
      ${h ? (h.blkdiff ? exCopy("Difficulty", String(h.blkdiff)) : exKv("Difficulty", "Not given")) + exKv("Cascade levels", exGiven(h.cascadelevels)) + (parent ? exLink("Parent block", parent, "find") : "") : ""}</div>
    <div class="ex-card"><div class="ex-h">TRANSACTIONS</div>${!list.length && t.istransaction !== true ? `<div class="ex-none">No transactions in this block</div>` : ""}
      ${t.istransaction === true ? exLink("⛏ carried in this TxPoW", String(t.txpowid || ""), "own") : ""}${list.map(id => exLink("", id, "txn")).join("")}</div>${exRaw(page)}`;
}
function exCoins(title, coins, cls, sign) {
  const X = AppsAct.explorer, list = Array.isArray(coins) ? coins.filter(c => c && typeof c === "object") : null;
  return `<div class="ex-card"><div class="ex-h">${title}${list ? "  ·  " + list.length : ""}</div>${!list || !list.length ? `<div class="ex-none">none</div>` : list.map(c => {
    const addr = String(c.miniaddress || c.address || "");
    return `<div class="ex-coin"><div class="ex-amt ${cls}">${sign}${esc(X.coinAmount(c))}  ${esc(exTokenLabel(c))}</div>${addr ? `<button class="ex-coin__a" data-copy="${esc(addr)}">${esc(addr)}   (click to copy)</button>` : `<div class="ex-none">Address not given</div>`}</div>`; }).join("")}</div>`;
}
function exTxnPage(page) {
  const X = AppsAct.explorer, t = page.txpow, txn = t.body && t.body.txn && typeof t.body.txn === "object" ? t.body.txn : null, state = txn && Array.isArray(txn.state) ? txn.state.filter(s => s && typeof s === "object") : [];
  const c = page.conf;
  return `<div class="ex-card ex-card--hero"><div class="ex-big ex-big--txn">Transaction</div><div class="ex-when">${exWhen(t)}</div><div class="ex-conf${c && !c.ok ? " ex-conf--off" : ""}">${esc(c ? c.text : "confirmations: …")}</div></div>
    <div class="ex-card">${exCopy("TxPoW ID", String(t.txpowid || ""))}${exKv("Size", exGiven(t.size, " bytes"))}${exKv("Burn", X.tidyAmount(t.burn == null ? "0" : t.burn) + " MINIMA")}${exKv("Is block", t.isblock === true ? "yes, also a block" : "no")}</div>
    ${txn ? exCoins("INPUTS", txn.inputs, "ex-amt--in", "−") + exCoins("OUTPUTS", txn.outputs, "ex-amt--out", "+") + (state.length ? `<div class="ex-card"><div class="ex-h">STATE VARIABLES</div>${state.map(s => exCopy("Port " + (s.port == null ? "?" : s.port), String(s.data == null ? "" : s.data))).join("")}</div>` : "") : ""}${exRaw(page)}`;
}
function exAddressPage(page) {
  const X = AppsAct.explorer;
  return `<div class="ex-card ex-card--hero"><button class="ex-addr" data-copy="${esc(page.addr)}">${esc(page.addr)}</button>
      <div class="ex-when">TxPoW records on this node: ${esc(page.total)}${page.total > page.list.length ? " (the first " + esc(page.list.length) + " are listed)" : ""} · click the address to copy</div></div>
    <div class="ex-card">${page.list.map((t, i) => { const ms = X.timeMilli(t), blk = t.isblock === true;
      return `<div class="ex-rec" role="button" tabindex="0" data-ex="rec" data-i="${i}"><span class="ex-kind${blk ? " ex-kind--blk" : ""}">${blk ? "BLK" : "TXN"}</span>
        <span class="ex-rec__mid"><span class="ex-mono ex-id" data-copy="${esc(t.txpowid || "")}" title="Click to copy">${esc(t.txpowid || "")}</span><span class="ex-rec__sub">Block ${esc(X.height(t) || "?")}${ms > 0 ? "  ·  " + esc(histWhen(ms)) : ""}</span></span><span class="ex-chev">›</span></div>`; }).join("")}</div>`;
}
function exHome() {
  const X = AppsAct.explorer, tile = (label, value, hero) => `<div class="ex-tile${hero ? " ex-tile--hero" : ""}"><div class="ex-tile__l">${label}</div><div class="ex-tile__v">${esc(value || "Not read yet")}</div></div>`;
  return `<div class="ex-stats">${tile("TIP HEIGHT", X.groupNum(EX.tip), true)}${tile("BLOCK TIME", EX.speed)}${tile("TXPOW DB", EX.db)}</div>
    <div class="ex-sec"><span>LATEST BLOCKS</span><span class="ex-sec__s" role="status">${esc(EX.status)}</span></div>
    <div class="ex-list">${EX.blocks.map((t, i) => { const n = X.txCount(t), ms = X.timeMilli(t);
      return `<div class="ex-block" role="button" tabindex="0" data-ex="block" data-i="${i}"><span class="ex-block__l"><span class="ex-block__n">#${esc(X.groupNum(X.height(t)))}</span>
        <span class="ex-block__s"><span class="ex-id" data-copy="${esc(t.txpowid || "")}" title="Click to copy">${esc(t.txpowid || "")}</span>${ms > 0 ? "  ·  " + esc(histWhen(ms)) : ""}</span></span>
        <span class="ex-pill${n ? " ex-pill--tx" : ""}">${n ? "Transactions: " + n : "EMPTY"}</span><span class="ex-chev">›</span></div>`; }).join("")}
      ${EX.end ? `<div class="ex-more ex-more--end">· end of retained chain ·</div>` : EX.loading ? `<div class="ex-more">loading…</div>` : EX.tip ? `<button class="ex-more ex-more--btn" data-ex="older">Load older blocks  ▾</button>` : ""}</div>`;
}
function explorerChrome() { const c = el("exTip"); if (c) c.textContent = "● " + (AppsAct.explorer.groupNum(EX.tip) || "no block yet"); }
/** Draw the page on top of the stack, or the home list. keep: a repaint for new data; the reader's place and focus are kept. */
function explorerPaint(keep) {
  const host = el("exContent"); if (!host) return;
  const page = EX.pages[EX.pages.length - 1], main = el("main"), y = main ? main.scrollTop : 0;
  const f = keep && document.activeElement && host.contains(document.activeElement) ? document.activeElement : null, fk = f ? [f.dataset.ex || "", f.dataset.i || "", f.dataset.id || ""].join("|") : "";
  host.innerHTML = !page ? exHome()
    : `<div class="ex-back"><button class="ex-back__b" data-ex="back">‹ Back</button><span>${page.type === "block" ? "Block detail" : page.type === "txn" ? "Transaction" : "Address"}</span></div><div class="ex-page">${page.type === "block" ? exBlockPage(page) : page.type === "txn" ? exTxnPage(page) : exAddressPage(page)}</div>`;
  if (main) main.scrollTop = keep ? y : 0;
  if (fk) { const again = [...host.querySelectorAll("[data-ex]")].find(n => [n.dataset.ex || "", n.dataset.i || "", n.dataset.id || ""].join("|") === fk); if (again) again.focus({ preventScroll: true }); }
}
function explorerAct(n) {
  const act = n.dataset.ex, page = EX.pages[EX.pages.length - 1];
  if (act === "back") { EX.pages.pop(); explorerPaint(); }
  else if (act === "older") explorerOlder();
  else if (act === "block") explorerPush({ type: "block", txpow: EX.blocks[+n.dataset.i] });
  else if (act === "rec" && page) { const t = page.list[+n.dataset.i]; explorerPush({ type: AppsAct.explorer.pageOf(t), txpow: t }); }
  else if (act === "find") explorerFind(n.dataset.id);
  else if (act === "txn") explorerTxn(n.dataset.id);
  else if (act === "own" && page) explorerPush({ type: "txn", txpow: page.txpow });
  else if (act === "raw" && page) { page.raw = !page.raw; explorerPaint(true); }
}
function renderExplorer() {
  const host = el("explorerBody");
  if (!el("exContent")) {
    const light = store("explorerTheme") === "light";
    host.innerHTML = `<div class="ex${light ? " ex--light" : ""}" id="exRoot"><div class="ex-head"><div class="ex-title">Minima Explorer</div><div class="ex-tip" id="exTip"></div>
        <button class="ex-theme" id="exTheme" aria-label="${light ? "Dark theme" : "Light theme"}">${light ? "☾" : "☀"}</button></div>
      <form class="ex-search" id="exForm"><input class="ex-in" id="exSearch" placeholder="Block № · TxPoW ID · 0x / Mx address" aria-label="Block number, TxPoW ID or address" autocomplete="off" spellcheck="false"><button class="ex-go" type="submit">Search</button></form>
      <div class="ex-pair" id="exPair" hidden><b>Node unavailable</b><span>The node is not running. Start it on the Node tab, then come back.</span></div>
      <div id="exContent"></div></div>`;
    el("exForm").onsubmit = (e) => { e.preventDefault(); if (running) explorerSearch(); };
    el("exTheme").onclick = () => { const on = !el("exRoot").classList.contains("ex--light"); store("explorerTheme", on ? "light" : "dark"); el("exRoot").classList.toggle("ex--light", on); el("exTheme").textContent = on ? "☾" : "☀"; el("exTheme").setAttribute("aria-label", on ? "Dark theme" : "Light theme"); };
    host.addEventListener("click", (e) => { const n = e.target.closest("[data-ex]"); if (n) explorerAct(n); });
    host.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[role=button][data-ex]")) { e.preventDefault(); explorerAct(e.target); } });
  }
  el("exPair").hidden = running;
  explorerChrome(); explorerPaint(true);
  if (running) explorerRefresh();
}

// ---- Entropy: Pandamonium's seed dice (integrated/entropy MainActivity, DiceView, LastWordView, DiceRollView) -------
// Two tabs: DICE ROLL (pick a length, throw five dice or tap in real ones, the bits fill, the phrase is shown concealed)
// and LAST WORD (type N-1 words, every valid last word is worked out). The maths is renderer/entropy-core.js.
//
// WHAT IS ON THIS SCREEN IS A WALLET SEED. The phrase itself lives in this page's memory only: it is never stored,
// logged, put on the clipboard (the original has no copy button either) or sent to the main process. The VALUES IT IS
// MADE FROM are another matter in digital mode: each roll's node value (A), device value (B) and their hash pass through
// the main process (main/entropy.js) and the node on 127.0.0.1, and whoever holds every A and B can recompute the phrase.
// The screen says so beside the mode choice and recommends real dice for a wallet that will hold value. The device's
// own random values come from WebCrypto, where the original uses SecureRandom.
// LIFETIME (0.19.133, as the phone's note promises): a phrase is concealed until Reveal, and with it the roll string and
// the audit log. Leaving the screen by any route ERASES the phrase, the rolls, the audit values, their text in the page
// and every typed last-word box: another screen (asked first when a finished phrase is there), the window hidden or
// closed, the node stopping, a wallet restore, Hide or Freeze of Entropy, and five minutes without input (counted down
// on screen through the last minute). While the screen is open the window is asked to be kept out of screen captures.
// Not here: the sounds, and demo mode (the phone's switch that allows screen capture and then refuses to roll).
const EN_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const EN_IDLE_MS = 300000, EN_WARN_MS = 60000;
let EN = null, EN_ASKING = false, EN_TICK = null;
function entropyNew() { return { tab: "dice", words: 12, physical: false, faces: [], audits: [], busy: false, auto: false, done: false, revealed: false, phrase: null, audit: false, run: 0,
  selfErr: "not run", ready: false, nodeOk: false, verified: 0, seen: new Set(), idleAt: Date.now(), lw: { words: 12, hidden: false, candidates: null, prev: [] } }; }
const enEl = (id) => el(id);
const enSay = (id, text, cls) => { const n = enEl(id); if (n) { n.textContent = text; n.className = cls; } };
const enDie = (n, face) => { n.dataset.face = face; n.innerHTML = `<i class="en-die__b">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => `<b${EN_PIPS[face].includes(i) ? ' class="on"' : ""}></b>`).join("")}</i>`; };
const enDice = () => [...document.querySelectorAll("#enDice .en-die")];
/** 32 random bytes of this device as 0x hex (RollEngine.deviceSecretHex): WebCrypto, never Math.random. */
function enDeviceSecret() { const b = new Uint8Array(32); crypto.getRandomValues(b); let s = "0x"; for (const x of b) s += x.toString(16).padStart(2, "0"); return s; }
function enDeviceFace() { const u = new Uint8Array(1); for (;;) { crypto.getRandomValues(u); const f = EntropyCore.faceFromByte(u[0]); if (f) return f; } }
const EN_NODE_BAD = "The node's answer did not match; this roll was not used.";
/**
 * One node value with one device value, believed only when checked (0.19.132): the node's random is 32 bytes of hex and
 * not one it gave before, and the hash is the one the main process worked out itself from (node ++ device), so the node
 * cannot choose it and the face depends on all 32 device bytes. → { a, b, h }; throws EN_NODE_BAD.
 */
async function enNodeHash() {
  const b = enDeviceSecret(), a = await api.entropy("random"), key = String(a).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key) || EN.seen.has(key)) throw new Error(EN_NODE_BAD);
  EN.seen.add(key);
  const h = await api.entropy("hash", EntropyCore.hashInput(a, b));
  if (!h) throw new Error(EN_NODE_BAD);
  return { a, b, h };
}
/** One die (RollEngine.rollOne): node random and device random, hashed; device only when the node is not there (and labelled so). → { face, audit }; throws on a source that misbehaves: there is no quiet fall back to one source. */
async function enRollOne() {
  const C = EntropyCore;
  if (!EN.nodeOk) { const face = enDeviceFace(); return { face, audit: { src: C.SRC.DEVICE_ONLY, a: "", b: "", n: face - 1, face } }; }
  for (let attempt = 0; attempt <= C.REJECT_LIMIT; attempt++) {
    const { a, b, h } = await enNodeHash(), r = C.faceFromHash(h);
    if (r.error) throw new Error(r.error);
    if (!r.reject) return { face: r.face, audit: { src: C.SRC.NODE_DEVICE, a, b, n: r.n, face: r.face } };
  }
  throw new Error("Entropy source misbehaving (rejection limit)");
}
/** One uniform 32-bit number for the last-word picker (RollEngine.randomN): node + device, or the device alone when the node is known to be away, and which it was. A node that answers wrongly gives { error }: nothing is picked. */
async function enRandomN() {
  const C = EntropyCore;
  if (!EN.nodeOk) { const u = new Uint32Array(1); crypto.getRandomValues(u); return { n: u[0], src: C.SRC.DEVICE_ONLY }; }
  try { const { h } = await enNodeHash(); return { n: parseInt(h.substring(2, 10), 16), src: C.SRC.NODE_DEVICE }; }
  catch (e) { entropyNode(); return { error: "The node's answer did not match; no word was picked. Try again." }; }
}
/** Prove the node before any roll uses it (MainActivity.verifyNode), by the very check every roll passes: "verified" means one full node + device hash was confirmed in the main process. */
async function enVerify() {
  const mine = ++EN.verified, set = (ok, text) => { if (mine !== EN.verified) return; EN.nodeOk = ok; EN.ready = true; if (!EN.selfErr) enSay("enSource", text, "en-source" + (ok ? " en-ok" : " en-amber")); };
  if (!running) return set(false, "node unavailable: device CSPRNG only (single source)");
  setTimeout(() => { if (mine === EN.verified && !EN.ready) set(false, "node unavailable: device CSPRNG only (single source)"); }, 5000);   // never leave rolls gated for ever
  try { await enNodeHash(); set(true, "BIP39 self-test ✓ node SHA3 + device CSPRNG verified"); }
  catch (e) { set(false, (e && e.message === EN_NODE_BAD ? "the node's answers did not match" : "node commands failed") + ": device CSPRNG only (single source)"); }
}
function entropyNode() { if (EN && el("enRoot")) { EN.ready = false; enVerify(); } }   // the node went away or came back: what the rolls use is checked again

// ---- DICE ROLL ----
function enChips() {
  document.querySelectorAll("#enDiceTab [data-len]").forEach(b => b.classList.toggle("en-btn--on", +b.dataset.len === EN.words));
  enEl("enDigital").classList.toggle("en-btn--on", !EN.physical); enEl("enPhysical").classList.toggle("en-btn--on", EN.physical);
  enEl("enThrow").hidden = enEl("enAuto").hidden = EN.physical; enEl("enPad").hidden = !EN.physical;
  enEl("enAuto").textContent = EN.auto ? "Auto-roll: on" : "Auto-roll: off"; enEl("enAuto").classList.toggle("en-btn--gold", EN.auto);
}
function enProgress() {
  const target = EntropyCore.entTarget(EN.words), b = EntropyCore.facesToBits(EN.faces).length;
  enEl("enBar").style.width = Math.min(100, Math.floor(b * 100 / target)) + "%";
  enEl("enProgL").textContent = Math.min(b, target) + " / " + target + " bits, " + EN.faces.length + " rolls";
  enEl("enTicker").textContent = EN.faces.join("");
  enEl("enRestart").hidden = !EN.faces.length || EN.done;
}
/** The phrase length is chosen BEFORE the first roll and not after: a length picked once rolls are seen would let the same rolls be tried at every length. */
function enSetLength(n) {
  if (EN.faces.length > 0) { if (!EN.done && n !== EN.words) enStatus("The phrase length cannot change once a roll is recorded. Start over to choose another length.", true); return false; }
  if (EN.busy || EN.done) return false;
  EN.words = n; enChips(); enProgress(); return true;
}
const enStatus = (text, err) => enSay("enStatus", text, "en-status" + (err ? " en-red" : ""));
function enBlocked() { if (!EN.selfErr) return false; enStatus("Blocked: self-test failed: " + EN.selfErr, true); return true; }
function enStopDice(face) { enDice().forEach((d, i) => { clearInterval(d._flick); d.className = "en-die"; enDie(d, face == null ? (i % 6) + 1 : face); }); }
async function enThrow() {
  if (EN.busy || EN.done || enBlocked()) return;
  if (!EN.ready) return enStatus("Verifying entropy sources, one moment…", true);
  const run = EN.run; EN.busy = true; enStatus("", false);
  enDice().forEach(d => { d.className = "en-die en-die--tumble"; clearInterval(d._flick); d._flick = setInterval(() => enDie(d, (+d.dataset.face % 6) + 1), 140); });
  let got = null, why = "";
  try { got = await Promise.race([Promise.all(Array.from({ length: EntropyCore.DICE }, enRollOne)), new Promise((_, no) => setTimeout(() => no(new Error("late")), 20000))]); } catch (e) { got = null; why = (e && e.message) || ""; }
  if (run !== EN.run) return;                                    // wiped while the node was answering: nothing of this throw is kept
  if (!got) {
    enStopDice(1); EN.busy = false; EN.auto = false; enChips();
    if (why !== EN_NODE_BAD) return enStatus("Entropy source error: nothing recorded. Try again.", true);
    entropyNode();                                               // the node is proved again before another roll may use it; the source line says what it found
    return enStatus(EN_NODE_BAD + " Nothing was recorded.", true);
  }
  await Promise.all(enDice().map((d, i) => new Promise(done => setTimeout(() => {   // each die tumbles on, then settles on its face
    if (run !== EN.run) return done();
    clearInterval(d._flick); d.className = "en-die en-die--roll"; let ticks = 0;
    d._flick = setInterval(() => { if (++ticks > 13) { clearInterval(d._flick); enDie(d, got[i].face); } else enDie(d, (+d.dataset.face % 6) + 1); }, 55);
    setTimeout(() => { clearInterval(d._flick); d.className = "en-die"; enDie(d, got[i].face); done(); }, 900);
  }, 120 * i))));
  if (run !== EN.run) return;
  const target = EntropyCore.entTarget(EN.words);
  EntropyCore.record(EN.faces, EN.audits, got.map(g => g.face), got.map(g => g.audit), target);
  enProgress(); EN.busy = false;
  if (EntropyCore.facesToBits(EN.faces).length >= target) return enFinish();
  if (EN.auto && !EN.done) setTimeout(() => { if (run === EN.run && EN.auto && activeView === "entropy") enThrow(); }, 500);
}
function enTap(face) {
  if (EN.done || EN.busy || !EN.physical || enBlocked()) return;
  EN.faces.push(face); EN.audits.push({ src: EntropyCore.SRC.PHYSICAL, a: "", b: "", n: face - 1, face });
  enDie(enDice()[(EN.faces.length - 1) % EntropyCore.DICE], face);
  enProgress();
  if (EntropyCore.facesToBits(EN.faces).length >= EntropyCore.entTarget(EN.words)) enFinish();
}
async function enFinish() {
  const C = EntropyCore, run = EN.run, all = C.facesToBits(EN.faces), ent = C.rawTruncate(all);
  EN.done = true;
  const phrase = await C.entropyBitsToWords(ent), good = await C.check(phrase);
  if (run !== EN.run) return;
  if (!good) { EN.done = false; return enStatus("INTERNAL MISMATCH: phrase suppressed. Wipe and retry.", true); }   // our own checker must accept our own words, or nothing is shown
  EN.phrase = phrase; EN.revealed = false; enWords();
  enEl("enSummary").textContent = C.summary(EN.faces, EN.audits, all.length, ent.length, phrase.length).join("\n");
  enEl("enRoll").hidden = true; enEl("enDone").hidden = false;
}
/** The phrase, and with it the roll string and the audit log (each of them IS the phrase to whoever reads it): in the page only while revealed. */
function enWords() {
  const p = EN.phrase || [], on = EN.revealed && !!EN.phrase;
  enEl("enWords").innerHTML = p.map((w, i) => `<div class="en-word${i === p.length - 1 ? " en-word--cs" : ""}${on ? "" : " en-word--off"}">${i + 1}. ${on ? esc(w) : "••••••"}</div>`).join("");
  enEl("enReveal").textContent = on ? "🙈 Click to hide" : "👁 Click to reveal";
  enEl("enRolls").textContent = on ? EN.faces.join("") : EN.phrase ? "•••••• (reveal the phrase to see its roll history)" : "";
  if (!on) EN.audit = false;
  const b = enEl("enAuditBtn"); b.disabled = !on; b.textContent = !on ? "Per-roll audit log: reveal the phrase first" : EN.audit ? "Hide per-roll audit log" : "Show per-roll audit log"; b.setAttribute("aria-expanded", EN.audit ? "true" : "false");
  enEl("enAuditWrap").hidden = !EN.audit; enEl("enAudit").textContent = EN.audit ? EntropyCore.auditLog(EN.audits) : "";
}
function enWipe() {
  EN.run++; EN.faces = []; EN.audits = []; EN.phrase = null; EN.seen = new Set(); EN.busy = EN.auto = EN.done = EN.revealed = EN.audit = false;
  enWords(); enEl("enSummary").textContent = "";
  enStatus("", false); enStopDice(); enEl("enDone").hidden = true; enEl("enRoll").hidden = false; enChips(); enProgress();
}

// ---- LAST WORD ----
const lwBoxes = () => [...document.querySelectorAll("#lwBoxes input:not([disabled])")];
const lwStatus = (text, err) => enSay("lwStatus", text, "en-status " + (err ? "en-red" : "en-ok"));
function lwBuild() {
  const L = EN.lw; L.candidates = null; L.prev = [];
  enEl("lwResults").hidden = true; enEl("lwCands").innerHTML = ""; lwStatus("", false); enEl("lwSugg").innerHTML = "";
  enEl("lwBoxes").innerHTML = Array.from({ length: L.words }, (_, i) => { const cs = i === L.words - 1;
    return `<input class="en-box${cs ? " en-box--cs" : ""}" ${cs ? 'id="lwLast" disabled placeholder="?"' : `data-i="${i}" placeholder="${i + 1}…"`} aria-label="${cs ? "The last word, calculated" : "Word " + (i + 1)}" type="${L.hidden ? "password" : "text"}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`; }).join("");
  document.querySelectorAll("#lwTab [data-lwlen]").forEach(b => b.classList.toggle("en-btn--on", +b.dataset.lwlen === L.words));
  lwCalcState();
}
function lwStyle(box) { const v = box.value; box.classList.toggle("en-box--ok", !!v && EntropyCore.wordIndex(v) >= 0); box.classList.toggle("en-box--bad", !!v && EntropyCore.wordIndex(v) < 0 && !EntropyCore.suggestions(v).length); }
function lwTyped() { const out = []; for (const b of lwBoxes()) { if (EntropyCore.wordIndex(b.value) < 0) return null; out.push(b.value); } return out; }
function lwCalcState() { enEl("lwCalc").disabled = !lwTyped(); }
function lwInvalidate() { const L = EN.lw; if (L.candidates) { L.candidates = null; enEl("lwResults").hidden = true; enEl("lwCands").innerHTML = ""; } enEl("lwLast").value = ""; }
function lwSuggest(box) { enEl("lwSugg").innerHTML = EntropyCore.suggestions(box.value).slice(0, 8).map(w => `<button class="en-btn en-btn--sugg" data-sugg="${esc(w)}" data-i="${box.dataset.i}">${esc(w)}</button>`).join(""); }
function lwCommit(box, w) {
  const boxes = lwBoxes(), idx = boxes.indexOf(box);
  box.value = w; EN.lw.prev[idx] = w.length; lwStyle(box); lwInvalidate(); lwCalcState();
  for (let j = 0; j < boxes.length; j++) { const k = boxes[(idx + 1 + j) % boxes.length]; if (EntropyCore.wordIndex(k.value) < 0) { k.focus(); lwSuggest(k); return; } }
  enEl("lwSugg").innerHTML = ""; enEl("lwCalc").focus();
}
function lwEdit(box) {
  const idx = lwBoxes().indexOf(box), v = box.value.toLowerCase().replace(/[^a-z]/g, "");
  if (v !== box.value) box.value = v;
  lwInvalidate();
  const grew = v.length > (EN.lw.prev[idx] || 0); EN.lw.prev[idx] = v.length;
  const m = EntropyCore.suggestions(v);
  // list words are unique after four letters: commit as soon as what is typed can be only one word, but only while TYPING (never while deleting)
  if (grew && m.length === 1 && v) return lwCommit(box, m[0]);
  lwStyle(box); lwSuggest(box); lwCalcState();
}
async function lwCalc() {
  if (EN.selfErr) return lwStatus("Blocked: startup self-test failed: " + EN.selfErr, true);
  const words = lwTyped(); if (!words) return;
  const res = await EntropyCore.lastWordCandidates(words);
  if (res.error) return lwStatus(res.error, true);
  for (const c of res.candidates) if (!(await EntropyCore.check(words.concat(c)))) return lwStatus("INTERNAL MISMATCH: results suppressed (candidate failed validation).", true);
  if ((lwTyped() || []).join(" ") !== words.join(" ")) return;   // edited while it was worked out
  EN.lw.candidates = res.candidates;
  lwStatus(res.candidates.length + " valid last words (" + res.free + " free bits + " + res.cs + "-bit checksum), all checksum-validated", false);
  enEl("lwCands").innerHTML = res.candidates.map(w => `<button class="en-cand" data-cand="${esc(w)}">${esc(w)}</button>`).join("");
  enEl("lwResults").hidden = false; lwHidden(EN.lw.hidden);
}
function lwPick(w, how) { enEl("lwLast").value = w; lwStatus("Phrase complete: word " + EN.lw.words + " = \"" + w + "\" (" + how + "). Valid BIP39 ✓", false); }
function lwHidden(on) {
  EN.lw.hidden = on; enEl("lwHide").textContent = on ? "👁 Show" : "🙈 Hide";
  document.querySelectorAll("#lwBoxes input").forEach(b => { b.type = on ? "password" : "text"; });
  for (const id of ["lwSugg", "lwCands", "lwStatus"]) enEl(id).style.visibility = on ? "hidden" : "";
}

// ---- the screen ----
function entropyTab(tab) {
  EN.tab = tab;
  if (EN.done && EN.revealed) { EN.revealed = false; enWords(); }   // secret hygiene on a tab switch: whatever was on show is concealed again
  if (!EN.lw.hidden && lwBoxes().some(b => b.value)) lwHidden(true);
  for (const t of ["dice", "lw"]) { const on = t === tab; enEl(t === "dice" ? "enDiceTab" : "lwTab").hidden = !on; const b = enEl("enTab-" + t); b.classList.toggle("en-tab--on", on); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; }
}
/** Is there anything on the screen that is, or leads to, a seed phrase? */
function enHolds() { return !!(EN && (EN.phrase || EN.faces.length || lwBoxes().some(b => b.value))); }
/**
 * ERASE: the phrase, the rolls, the audit values, everything the page drew of them (the words, #enRolls, #enAudit,
 * #enSummary, #enTicker) and every typed last-word box. The screen's whole content is taken out of the page and the
 * state replaced; a throw or a calculation still waiting for an answer finds another run number and records nothing.
 */
function entropyErase() {
  if (!EN) return;
  const run = EN.run + 1, verified = EN.verified;
  clearInterval(EN_TICK); EN_TICK = null; enDice().forEach(d => clearInterval(d._flick));
  EN.faces.length = 0; EN.audits.length = 0; EN.phrase = null; EN.lw.candidates = null; EN.seen.clear();
  const body = el("entropyBody"); if (body) body.innerHTML = "";
  EN = entropyNew(); EN.run = run; EN.verified = verified;
}
/** Erased without being asked (the window hidden, the node stopped, a wallet restore, five idle minutes): a screen still open is drawn again, empty, and says why. */
function entropyErased(why) {
  if (!EN) return;
  const had = enHolds(), open = !!el("enRoot");
  entropyErase();
  if (open && activeView === "entropy") { renderEntropy(); if (had) enStatus("Everything on this screen was erased: " + why, true); }
}
/**
 * selectTab asks this before another screen is shown. → true: go on (everything is erased and the window may be
 * captured again). → false: a finished phrase is on the screen, so the user is asked, once; go() runs if they agree.
 */
function entropyLeaving(go) {
  if (EN && EN.phrase) {
    if (!EN_ASKING) { EN_ASKING = true; showConfirm("Leave Entropy?", "Leaving erases this phrase. Have you written it down?", "Erase and leave", true).then(ok => { EN_ASKING = false; if (ok) { entropyErase(); go(); } }); }
    return false;
  }
  entropyErase();
  try { api.secureScreen(false); } catch (e) {}
  return true;
}
/** Once a second while the screen is open: five minutes without a click or a key erases what it holds, counted down through the last minute. */
function enIdleTick(now) {
  if (!EN || !el("enRoot")) return;
  const n = el("enIdle"), left = EN.idleAt + EN_IDLE_MS - now;
  if (!enHolds() || EN.busy || EN.auto) { EN.idleAt = now; if (n) n.hidden = true; return; }   // nothing to erase, or dice in the air
  if (left <= 0) return entropyErased("5 minutes passed without input.");
  if (n) { n.hidden = left > EN_WARN_MS; n.textContent = "No input for a while. Everything on this screen is erased in " + Math.ceil(left / 1000) + " s. Click or press a key to keep it."; }
}
// The window hidden or closed (on macOS closing hides it), or the page going away: erased at once, nobody is asked.
document.addEventListener("visibilitychange", () => { if (document.hidden) entropyErased("the window was hidden."); });
window.addEventListener("pagehide", () => entropyErase());
function renderEntropy() {
  try { api.secureScreen(true).then(ok => { const n = el("enCapture"); if (n) n.hidden = ok !== false; }, () => {}); } catch (e) {}
  if (el("enRoot")) { enVerify(); return; }
  const was = EN; EN = entropyNew();
  if (was) { EN.run = was.run; EN.verified = was.verified; }   // the counters go on: an answer still on its way to an erased screen never matches the new one
  let initErr = null; try { EntropyCore.init(WordEntry.WORDS); } catch (e) { initErr = "init failed: " + ((e && e.message) || e); EntropyCore.init(new Array(2048).fill("")); }   // a broken list blocks everything below, with the reason on screen
  const C = EntropyCore, lens = (attr) => C.LENGTHS.map(n => `<button class="en-btn" ${attr}="${n}">${n}</button>`).join("");
  el("entropyBody").innerHTML = `<div class="en" id="enRoot"><div class="en-head"><div class="en-title">ENTROPY</div><div class="en-sub">PROVABLY FAIR BIP39 SEED DICE</div><div class="en-banner" id="enBanner" hidden></div>
      <div class="en-banner" id="enCapture" hidden>This system cannot keep the window out of screenshots and screen sharing. Make sure nothing is recording the screen.</div></div>
    <div class="en-tabs" role="tablist"><button class="en-tab en-tab--on" id="enTab-dice" role="tab" aria-selected="true" aria-controls="enDiceTab">🎲 DICE ROLL</button><button class="en-tab" id="enTab-lw" role="tab" aria-selected="false" aria-controls="lwTab" tabindex="-1">✓ LAST WORD</button></div>
    <div class="en-page" id="enDiceTab" role="tabpanel">
      <div class="en-card"><div class="en-label">PHRASE LENGTH</div><div class="en-row">${lens("data-len")}</div>
        <div class="en-label en-gap">DICE MODE</div><div class="en-row"><button class="en-btn" id="enDigital">Digital (node + device)</button><button class="en-btn" id="enPhysical">Physical dice</button></div>
        <div class="en-hint" id="enModeNote">Digital: each roll's two random values and their hash pass through this app's main process and the node on 127.0.0.1. Whoever could read them there could rebuild the phrase. For a wallet that will hold real value, use Physical dice: real dice never leave this screen.</div>
        <div class="en-source" id="enSource" role="status">checking entropy sources…</div>
        <div class="en-warn">⚠ SECURITY: you are generating a real wallet seed. Go offline, make sure nobody can see the screen, and write the words on paper only. Nothing is stored. Leaving this screen, hiding or closing the window, stopping the node, 5 minutes without input, or Wipe &amp; start over erases the phrase for ever.</div>
        <div class="en-banner" id="enIdle" role="status" hidden></div></div>
      <div class="en-card" id="enRoll"><div class="en-label">COLLECT ENTROPY</div><div class="en-track"><div class="en-bar" id="enBar"></div></div><div class="en-mono en-dim" id="enProgL"></div>
        <div class="en-dice" id="enDice" aria-hidden="true">${"<div class=\"en-die\"></div>".repeat(C.DICE)}</div>
        <button class="en-btn en-btn--gold en-btn--full" id="enThrow">Throw 5 dice</button><button class="en-btn en-btn--full" id="enAuto">Auto-roll: off</button>
        <div id="enPad" hidden><div class="en-warn">⚠ Use a REAL, fair die and enter every roll exactly as it lands. Typing numbers "randomly" from your head produces a weak, guessable seed.</div>
          <div class="en-pad">${[1, 2, 3, 4, 5, 6].map(f => `<button class="en-btn en-btn--text" data-face="${f}" aria-label="A real die landed on ${f}">${"⚀⚁⚂⚃⚄⚅"[f - 1]} ${f}</button>`).join("")}</div><button class="en-btn en-btn--full" id="enUndo">↺ Undo last</button></div>
        <button class="en-btn en-btn--full" id="enRestart" hidden>↺ Start over (erases these rolls)</button>
        <div class="en-ticker" id="enTicker" aria-label="The rolls so far"></div><div class="en-status" id="enStatus" role="status"></div></div>
      <div class="en-card" id="enDone" hidden><div class="en-label">YOUR SEED PHRASE</div><div class="en-words" id="enWords"></div><button class="en-btn en-btn--full" id="enReveal">👁 Click to reveal</button>
        <div class="en-mono en-dim en-summary" id="enSummary"></div>
        <div class="en-label en-gap">VERIFY FAIRNESS</div><div class="en-hint">Maths is bit-identical to iancoleman/bip39 v0.4.3 (locked by fixed vectors produced from the genuine code; see the Entropy repo tests). Roll history below: paste into bip39-standalone.html (Raw entropy mode) to reproduce the phrase.</div>
        <div class="en-ticker en-sel" id="enRolls"></div><button class="en-btn en-btn--full" id="enAuditBtn" aria-expanded="false">Show per-roll audit log</button>
        <div id="enAuditWrap" hidden><div class="en-gold en-small">⚠ This log reveals every roll's secrets (A + B): anyone who sees it can recompute the entire seed phrase. Treat it exactly like the seed words.</div>
          <div class="en-hint en-small">Each digital face = SHA3(node_secret ++ device_secret) → first 4 bytes mod 6 (values ≥ 4294967292 rerolled: zero modulo bias). Verify any roll in the Terminal: runscript script:"LET h=SHA3(CONCAT(&lt;A&gt; &lt;B&gt;)) LET n=NUMBER(SUBSET(0 4 h)) LET r=n%6 RETURN TRUE"</div>
          <pre class="en-audit en-sel" id="enAudit" tabindex="0"></pre></div>
        <button class="en-btn en-btn--pink en-btn--full" id="enWipe">Wipe &amp; start over</button></div></div>
    <div class="en-page" id="lwTab" role="tabpanel" hidden>
      <div class="en-card"><div class="en-label">LAST-WORD (CHECKSUM) CALCULATOR</div><div class="en-row"><button class="en-btn" id="lwHide">🙈 Hide</button><button class="en-btn" id="lwClear">↺ Clear all</button></div>
        <div class="en-row en-gap">${lens("data-lwlen")}</div>
        <div class="en-hint">Every BIP39 word is unique after 4 letters, so boxes auto-complete as soon as the word is unambiguous. The final word packs entropy bits plus the SHA-256 checksum, so it is calculated, never typed.</div>
        <div class="en-boxes" id="lwBoxes"></div><div class="en-sugg" id="lwSugg"></div>
        <button class="en-btn en-btn--gold en-btn--full" id="lwCalc" disabled>Calculate valid last words</button><div class="en-status" id="lwStatus" role="status"></div></div>
      <div class="en-card" id="lwResults" hidden><div class="en-label">VALID LAST WORDS</div><div class="en-hint en-small">click a word to use it as your final word, or:</div>
        <button class="en-btn en-btn--cyan en-btn--full" id="lwRandom">🎲 Pick one at random (node + device entropy)</button><div class="en-cands" id="lwCands"></div></div></div></div>`;
  enStopDice(); enChips(); enProgress(); lwBuild();
  const root = el("enRoot");
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.len) enSetLength(+b.dataset.len);
    else if (b.id === "enRestart") enWipe();   // also with dice in the air: that throw finds another run number and records nothing
    else if (b.id === "enDigital" || b.id === "enPhysical") { if (!EN.busy) { EN.physical = b.id === "enPhysical"; enChips(); } }
    else if (b.id === "enThrow") enThrow();
    else if (b.id === "enAuto") { EN.auto = !EN.auto; enChips(); if (EN.auto && !EN.busy && !EN.done) enThrow(); }
    else if (b.dataset.face) enTap(+b.dataset.face);
    else if (b.id === "enUndo") { if (!EN.done && EN.faces.length) { EN.faces.pop(); EN.audits.pop(); enProgress(); } }
    else if (b.id === "enReveal") { EN.revealed = !EN.revealed; enWords(); }
    else if (b.id === "enAuditBtn") { EN.audit = !EN.audit; enWords(); }
    else if (b.id === "enWipe") enWipe();
    else if (b.id === "enTab-dice" || b.id === "enTab-lw") entropyTab(b.id === "enTab-lw" ? "lw" : "dice");
    else if (b.dataset.lwlen) { EN.lw.words = +b.dataset.lwlen; lwBuild(); lwHidden(EN.lw.hidden); }
    else if (b.id === "lwHide") lwHidden(!EN.lw.hidden);
    else if (b.id === "lwClear") { lwHidden(false); lwBuild(); }
    else if (b.id === "lwCalc") lwCalc();
    else if (b.dataset.sugg) { const box = lwBoxes()[+b.dataset.i]; if (box) lwCommit(box, b.dataset.sugg); }
    else if (b.dataset.cand) lwPick(b.dataset.cand, "chosen manually");
    else if (b.id === "lwRandom") { const c = EN.lw.candidates; if (c && c.length) { const r = await enRandomN(); if (r.error) lwStatus(r.error, true); else if (EN.lw.candidates === c) lwPick(c[r.n % c.length], r.src === EntropyCore.SRC.NODE_DEVICE ? "picked by SHA3(node ++ device) entropy" : "picked by device entropy"); } }   // the count is a power of two, so the remainder is exactly uniform
  });
  for (const type of ["pointerdown", "keydown", "input"]) root.addEventListener(type, () => { EN.idleAt = Date.now(); const n = el("enIdle"); if (n) n.hidden = true; }, true);
  clearInterval(EN_TICK); EN_TICK = setInterval(() => enIdleTick(Date.now()), 1000);
  root.addEventListener("input", (e) => { if (e.target.matches("#lwBoxes input")) lwEdit(e.target); });
  root.addEventListener("focusin", (e) => { if (e.target.matches("#lwBoxes input")) lwSuggest(e.target); });
  root.querySelector(".en-tabs").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const to = EN.tab === "dice" ? "lw" : "dice"; entropyTab(to); enEl("enTab-" + to).focus(); } });
  // the fixed vectors first: nothing is generated until the maths has proved itself in this very window
  (initErr ? Promise.resolve(initErr) : C.selfTest()).then(err => { EN.selfErr = err;
    if (err) { const n = enEl("enBanner"); n.hidden = false; n.textContent = "SELF-TEST FAILED, generation blocked: " + err; enSay("enSource", "self-test FAILED: blocked", "en-source en-amber"); }
    else { enSay("enSource", "BIP39 self-test ✓ node: connecting…", "en-source en-ok"); enVerify(); } });
}
