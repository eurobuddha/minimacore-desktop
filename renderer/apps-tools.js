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
