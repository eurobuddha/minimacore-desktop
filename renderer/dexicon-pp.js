/*
 * dexicon-pp.js: Dexicon room ② Pools. The REAL PandaPools (constant-product pools MINIMA ⇄ MxUSD on Minima), drawn as
 * the Android client draws it inside Dexicon (apks/dexicon com.eurobuddha.pandapools SwapView / PoolsView / MyLpView /
 * WalletView / ActivityView) over the engine the desktop already runs: the SAME window.mcd pp* calls with the SAME
 * arguments and the SAME guards, in the same order, as the panel it replaces (renderer/pools.js, which stays in the
 * tree until the 3e parity audit). This file changes screens, never behaviour: scripts/dexicon-pp.test.cjs runs both
 * and compares every call.
 *
 * Three parts, as dexicon-ax.js: text and numbers with no DOM (Core), the money actions over (api, ui) with no DOM
 * (Act), the screens. RULE 2: the dollar token is MxUSD wherever the desktop writes it. The engine names it "USDT"
 * in the records it keeps; "USDT/MINIMA (MEXC)" is the MEXC market's own unit and stays.
 */
(function (root, factory) { const node = typeof module === "object" && module.exports, m = factory(node ? require("./dexicon-core.js") : root.DexCore); if (node) module.exports = m; else root.DexPools = m; })(this, function (C) {
  "use strict";

  // ======================================================================== Core: no DOM
  const MINIMA = "0x00", MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const isMxusd = (tok) => String(tok || "").toLowerCase() === MXUSD.toLowerCase();
  /** A pool token's name. The dollar token is named by its ID, never by what a token calls itself: another token that
   *  calls itself USDT or MxUSD is said to be another token. An unnamed token is its whole id. */
  const tokLabel = (tok, name) => (isMxusd(tok) ? "MxUSD" : !name || name === tok ? String(tok || "token") : /^m?x?usdt?$/i.test(name) ? name + " (another token, not MxUSD)" : String(name));
  /** the engine's own records say USDT for the dollar token */
  const mx = (s) => String(s == null ? "" : s).replace(/\bm?x?USDT\b/gi, "MxUSD");
  /** a decimal string CUT to dp decimals, never rounded (SwapView.trim8 / fmt6: RoundingMode.DOWN); other text as it is */
  const cut = (x, dp) => { const d = C.dec(x); return d ? C.str(C.down(d, dp)) : String(x == null || x === "" ? "0" : x); };
  /** every digit, no trailing zeros (SwapView.trim) */
  const whole = (x) => { const d = C.dec(x); return d ? C.str(d) : String(x == null ? "—" : x); };
  /** the old panel's amount check (pools.js doPpSwap): digits with at most one point, above zero */
  const amountOk = (v) => /^[0-9]*\.?[0-9]+$/.test(String(v)) && parseFloat(v) > 0;
  const plural = (n, one) => n + " " + one + (Number(n) === 1 ? "" : "s");

  /** The pairs there are pools for, deepest first as the scan gives them: [{ tok, name }]. */
  function pairs(pools) { const seen = {}, out = []; for (const p of pools || []) if (p.tok && !seen[p.tok.toLowerCase()]) { seen[p.tok.toLowerCase()] = 1; out.push({ tok: p.tok, name: tokLabel(p.tok, p.tokName) }); } return out; }
  const poolLine = (t, info) => "MINIMA / " + t.name + "   ·   " + plural(info.pools, "pool") + "   ·   depth " + whole(info.depth) + " MINIMA";
  /** sendable, not confirmed: confirmed counts coins locked in pools (the old panel's rule) */
  function sendable(bal, tok) { const r = (bal || []).find((b) => b.tokenid && b.tokenid.toLowerCase() === String(tok).toLowerCase()); return r ? r.sendable || "0" : "0"; }
  const balanceLine = (bal, t) => "Your balance: " + cut(sendable(bal, MINIMA), 6) + " MINIMA  ·  " + cut(sendable(bal, t.tok), 6) + " " + t.name;
  /** The MEXC line (SwapView.renderMarket), for the MxUSD pair only: the market mid, the blended pool price (Σ token /
   *  Σ MINIMA, cut to 6 decimals) and how far apart they are. "" = no line. */
  function marketLine(t, market, pools) {
    if (!isMxusd(t.tok)) return "";
    let m = C.zero, u = C.zero;
    for (const p of pools || []) if (p.tok && p.tok.toLowerCase() === t.tok.toLowerCase()) { m = C.add(m, C.dec(p.reserveM) || C.zero); u = C.add(u, C.dec(p.reserveT) || C.zero); }
    if (m.v === 0n) return "";
    const mid = market && market.fresh && Number(market.mid) > 0 ? C.dec(Number(market.mid).toFixed(12)) : null;
    if (!mid || mid.v === 0n) return "Market price unavailable (MEXC)";
    const spot = C.div(u, m, 12), above = C.cmp(spot, mid) > 0, pct = C.div(C.mul(above ? C.sub(spot, mid) : C.sub(mid, spot), C.dec("100")), mid, 8);
    const word = C.cmp(pct, C.dec("0.1")) < 0 ? "at market" : C.str(C.down(pct, 1)) + "% " + (above ? "above market" : "below market");
    return "Market ≈ " + C.str(C.down(mid, 6)) + " USDT/MINIMA (MEXC)  ·  Pool " + C.str(C.down(spot, 6)) + "  ·  " + word;
  }
  /** The live quote's rows (SwapView.requote), or why there is none. q = ppQuote(). */
  function quoteRows(q, t, dir) {
    if (!q || !q.ok) return { ok: false, out: q && q.notReady ? "0.0" : "—", note: q && q.notReady ? "PandaPools is still starting. One moment." : "This trade is too large for the pools' depth. Try a smaller amount." };
    const rows = [["Rate", "≈ " + cut(q.effPrice, 8) + " " + t.name + " / MINIMA"], ["Price impact", q.priceImpact + " %"]];
    if (Number(q.poolsAvailable) > 1) rows.push(["Routed across", (Number(q.poolsUsed) || 0) + " of " + (Number(q.poolsAvailable) || 0) + " pools" + (q.capped ? " (top " + (Number(q.maxPools) || 6) + ")" : "")]);
    rows.push(["Pool fee (0.50%)", "kept by LPs"], ["You receive", whole(q.totalOut) + " " + (dir ? t.name : "MINIMA")]);
    return { ok: true, out: cut(q.totalOut, 8), rows };
  }
  /** What the Swap click asks to be confirmed (SwapView.confirmAndSwap; the old panel's "Confirm swap"). */
  function swapReview(q, amt, t, dir) {
    const pay = dir ? "MINIMA" : t.name, get = dir ? t.name : "MINIMA";
    return { title: "Confirm swap", ok: "Swap", text: "Pay  " + amt + " " + pay + "\nReceive  " + whole(q.totalOut) + " " + get + "\nRate  ≈ " + cut(q.effPrice, 8) + " " + t.name + " / MINIMA\n\nPrice impact " + q.priceImpact + "%."
      + (Number(q.poolsUsed) > 1 ? "\nRouted across " + q.poolsUsed + " pools in one transaction." : "")
      + "\n\nThis posts a real on-chain transaction for exactly these amounts. There is no slippage setting: if a pool moves before it confirms, the swap is rejected and you keep your funds." };
  }

  // ---- Pools (PoolsView.java) ----
  /** "3 pools · 866751.25 MINIMA aggregate depth": the MINIMA reserves added exactly (VirtualCurve.totalMinima). */
  function poolsSummary(pools) {
    if (!pools || !pools.length) return "no active pools";
    return plural(pools.length, "pool") + " · " + C.str(pools.reduce((t, p) => C.add(t, C.dec(p.reserveM) || C.zero), C.zero)) + " MINIMA aggregate depth";
  }
  /** One pool's card: its rows as [label, value, copy value]. The pool address is whole. */
  function poolCard(p) {
    const name = tokLabel(p.tok, p.tokName), rows = [["reserves", whole(p.reserveM) + " MINIMA  ·  " + whole(p.reserveT) + " " + name], ["spot price", cut(p.spot, 8) + " " + name + " / MINIMA"], ["fees accrued (K/KMIN−1)", cut(p.feeGrowthPct, 8) + " %"]];
    if (!isMxusd(p.tok)) rows.push(["token", String(p.tok), p.tok]);
    rows.push(["pool", p.address + "  (click to copy)", p.address]);
    return { title: "MINIMA / " + name, rows };
  }
  /** One collective card per token (PoolsView.combinedCard), from the engine's own aggregates (ppAggregate). */
  function combinedCard(a) {
    const name = tokLabel(a.tok, a.name);
    return { title: "MINIMA / " + name + "  ·  combined", rows: [["pools combined", String(a.count)], ["total reserves", whole(a.totalMinima) + " MINIMA  ·  " + whole(a.totalToken) + " " + name], ["aggregate spot price", cut(a.price, 8) + " " + name + " / MINIMA"], ["tradeable depth", whole(a.depth) + " MINIMA"]] };
  }

  /** An error as the bridge gives it, without the bridge's own wrapping. */
  const bare = (e) => String((e && e.message) || e || "").replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
  /**
   * A failed action in the alert's three parts: what happened, whether funds moved, what to do. The engine reports
   * fixed sentences; the ones a reader cannot act on are said in plain words, with the node's own answer beside them
   * (node = ppWhy(): the node's last refusal of a pool command, used only when it came after `since`).
   */
  function failText(what, raw, node, since) {
    raw = bare(raw);
    const said = node && node.error && Number(node.at) >= Number(since || 0) ? " The node's last answer while this ran (its \"" + node.verb + "\" command): " + mx(node.error).replace(/[.\s]+$/, "") + "." : "";
    if (/BACKUP_REQUIRED/.test(raw)) return what + " was not done and no funds moved. Before another pool can be created or migrated, the encrypted backup of your pools and this node must be saved and checked. Open My LP, choose Back up / restore pools, save the backup, then try again.";
    if (/could not mint an owner key/i.test(raw)) return what + " was not done and no funds moved: the node did not make the new key that would own the pool." + said + " Check that the node is running and in sync, then try again.";
    if (/Could not identify the input signing key/i.test(raw)) return what + " was not done and nothing was signed: the node could not say which key signs one of the coins it would spend." + said + " Wait until the node has caught up with the chain, then try again.";
    if (/quote expired/i.test(raw)) return what + " was not sent and no funds moved: the quote was too old. Enter the amount again for a fresh one.";
    if (/timed out/i.test(raw)) return "It is not known whether this was sent: no answer came in time." + said + " Look at Activity and at your balance before trying again, and do not repeat it until you have.";
    return what + " did not go through: " + (mx(raw).replace(/[.\s]+$/, "") || "no reason was given") + "." + said + " Look at Activity: if no new line is there, nothing was sent and no funds moved.";
  }

  // ======================================================================== Act: the money actions, no DOM
  // ui = { confirm(title, text, okLabel) → Promise<bool>, say(text, kind) }. Every function here makes the SAME
  // window.mcd calls, with the same arguments, behind the same guards, in the same order, as renderer/pools.js.
  /** why a call failed, with the node's own last answer when it came during the call */
  async function why(api, what, e, since) { const node = await Promise.resolve().then(() => api.ppWhy()).catch(() => null); return failText(what, e, node, since); }
  const Act = {
    /** ppQuote at the click (the exact route that will be posted, frozen) → confirm → ppSwap(that quote's id). */
    async swap(api, ui, t, dir, amt) {
      if (!t) { ui.say("Pick a pool first. Nothing was sent.", "note"); return null; }
      if (!amountOk(amt)) { ui.say("Enter an amount. Nothing was sent.", "note"); return null; }
      const q = await api.ppQuote(t.tok, dir, amt).catch(() => ({ ok: false }));
      if (!q || !q.ok || !q.quoteId) { ui.say(q && q.notReady ? "PandaPools is still starting. Nothing was sent: try again in a moment." : "That trade is too large for these pools. Nothing was sent: try a smaller amount.", "note"); return null; }
      const rv = swapReview(q, amt, t, dir);
      if (!await ui.confirm(rv.title, rv.text, rv.ok)) return null;
      const since = Date.now();
      try {
        const r = await api.ppSwap(q.quoteId);
        ui.say("Swap submitted: you pay " + amt + " " + (dir ? "MINIMA" : t.name) + " and receive " + whole(r && r.totalOut) + " " + (dir ? t.name : "MINIMA") + " when a block confirms it. It is not final yet: follow it in Activity. Transaction " + ((r && r.txpowid) || "not reported"), "note");
        return r || {};
      } catch (e) { ui.say(await why(api, "The swap", e, since), "error"); return { err: bare(e) }; }
    }
  };

  const core = { MINIMA, MXUSD, isMxusd, tokLabel, mx, cut, whole, amountOk, plural, pairs, poolLine, sendable, balanceLine, marketLine, quoteRows, swapReview, poolsSummary, poolCard, combinedCard, bare, failText };
  if (typeof document === "undefined") return Object.assign({ Act }, core);

  // ======================================================================== the screens
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let D = null;   // deps from app.js: api, tryCmd, running(), dialog, money, go(tab), start(), where()
  const S = { tab: "", at: 0, st: null, said: null, pools: null, sel: 0, dir: true, bal: null, info: null, market: null, acts: null, qseq: 0, combined: false, agg: null };
  const api = () => D.api;
  const body = () => $("dxPpBody");
  const visible = (tab) => { const b = body(), w = D.where(); return !!b && w.shown && w.room === "pools" && b.dataset.tab === (tab || S.tab); };
  const typing = () => { const a = document.activeElement, b = body(); return !!(a && b && b.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  const say = (text, kind) => { S.said = text ? { text, kind: kind || "error" } : null; paint(); };
  const ui = { confirm: (title, text, ok) => D.dialog(title, text, ok), say };
  const up = () => D.running() && !!(S.st && S.st.ready);
  const toks = () => pairs(S.pools), pair = () => toks()[S.sel] || toks()[0] || null;

  // ---- reads: each screen asks for what it shows ----
  async function load(tab) {
    S.at = Date.now();
    S.st = await api().ppStatus().catch(() => null);
    if (!up()) return;
    const want = { pools: () => api().ppPools(), acts: () => api().ppActivity() };
    if (tab === "swap") { want.bal = () => D.tryCmd("balance"); want.market = () => api().ppMarket(); }
    if (tab === "pools" && S.combined) want.agg = () => api().ppAggregate();
    const keys = Object.keys(want), got = await Promise.allSettled(keys.map((k) => want[k]()));
    keys.forEach((k, i) => { if (got[i].status === "fulfilled" && got[i].value != null) S[k] = got[i].value; });
    if (tab === "swap" && pair()) S.info = await api().ppPairInfo(pair().tok).catch(() => S.info);
  }
  /** the engine's scans say "update": passive parts only, never under someone typing (the old panel's "frozen tab" rule) */
  function onUpdate() { if (S.upd || !D) return; S.upd = setTimeout(() => { S.upd = null; if (visible()) load(S.tab).then(paint, paint); }, 400); }
  function tick() { if (D && visible() && !typing() && !C.gate.on && Date.now() - S.at > 60000) load(S.tab).then(paint, paint); }
  function reset() { Object.assign(S, { at: 0, st: null, said: null, pools: null, sel: 0, dir: true, bal: null, info: null, market: null, acts: null }); S.qseq++; const b = body(); if (b) { b.innerHTML = ""; delete b.dataset.tab; } }

  /** what stands above every screen of the room: the node, the engine, the last thing said */
  function banners() {
    const out = [];
    if (!D.running()) out.push(`<div class="dx-state" role="status">The node is stopped, so nothing here can trade and your pools are not being kept fresh. Start it and PandaPools comes back by itself. <button class="dx-btn pp-inline" data-ppstart="1">Start the node</button></div>`);
    else if (!S.st) out.push(`<div class="dx-state dx-state--note" role="status">PandaPools could not be read just now. Nothing is lost: this screen tries again by itself.</div>`);
    else if (!S.st.ready) out.push(`<div class="dx-state dx-state--note" role="status">PandaPools is starting: it opens its saved pools and reads the pool registry from the node. Nothing can be sent yet.</div>`);
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  const kv = (k, v, cls) => `<div class="pp-kv"><span>${esc(k)}</span><span class="${cls || ""}">${v}</span></div>`;
  /** A pool operation as one line of the strip under Swap (SwapView.activityRow). */
  const tone = (a) => (a.failed ? "bad" : a.confirmed ? "ok" : "live");
  const recentRow = (a) => `<div class="pp-rrow"><span>${esc(a.type)} · ${esc(mx(a.summary))}</span><b data-tone="${tone(a)}">${esc(a.statusText || "Waiting for node check")}</b></div>`;

  // ---- Swap (SwapView.java) ----
  function swapSkeleton() {
    return `<div id="ppTop"></div>
      <div class="pp-line" id="ppPoolLine">Finding pools…</div><div class="pp-line" id="ppBalLine"></div><div class="pp-line pp-line--gap" id="ppMktLine"></div>
      <label class="pp-pair" id="ppPairRow" hidden><span>POOL</span><select class="dx-in" id="ppPair" aria-label="Pool pair"></select></label>
      <div class="pp-panel"><label class="pp-panel__m"><span class="pp-fl">YOU PAY</span><input class="pp-amt" id="ppAmt" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.0"></label><b class="pp-tok" id="ppFrom">MINIMA</b></div>
      <div class="pp-fliprow"><button class="pp-flip" id="ppFlip" aria-label="Flip: swap the other way">⇅</button></div>
      <div class="pp-panel"><div class="pp-panel__m"><span class="pp-fl">YOU RECEIVE (EST.)</span><div class="pp-amt" id="ppOut" aria-live="polite">0.0</div></div><b class="pp-tok" id="ppTo">MxUSD</b></div>
      <div class="pp-quote" id="ppQuote"></div>
      <button class="pp-cta" id="ppGo" disabled>SWAP</button>
      <div class="pp-recent" id="ppRecent"></div>`;
  }
  const amt = () => ($("ppAmt") ? $("ppAmt").value.trim() : "");
  /** the live quote: last one asked wins (the old panel's ppQuoteSeq); the bump retires any quote still in flight */
  async function requote() {
    const t = pair(), a = amt(), q = $("ppQuote"), out = $("ppOut"); if (!q || !t) return;
    if (!amountOk(a)) { S.qseq++; S.q = null; q.innerHTML = ""; out.textContent = "0.0"; return paintGo(); }
    const seq = ++S.qseq, dir = S.dir, r = await api().ppQuote(t.tok, dir, a).catch(() => ({ ok: false }));
    if (seq !== S.qseq || !$("ppQuote")) return;   // a later keystroke already asked for a fresher quote, or the screen changed
    const rows = quoteRows(r, t, dir); S.q = rows.ok;
    $("ppOut").textContent = rows.out;
    $("ppQuote").innerHTML = rows.ok ? rows.rows.map((x) => kv(x[0], esc(x[1]))).join("") : `<div class="pp-warn">${esc(rows.note)}</div>`;
    paintGo();
  }
  const paintGo = () => { const b = $("ppGo"); if (b) { b.disabled = C.gate.on || !up() || !S.q; b.textContent = S.swapping ? "SWAPPING…" : "SWAP"; } };
  function bindSwap() {
    $("ppAmt").oninput = () => { S.said = null; $("ppTop").innerHTML = banners(); requote(); };
    $("ppFlip").onclick = () => { S.dir = !S.dir; paintSwap(); requote(); };
    $("ppPair").onchange = () => { S.sel = Number($("ppPair").value) || 0; S.info = null; paintSwap(); requote(); load("swap").then(paint, paint); };
    $("ppGo").onclick = () => D.money(async () => {
      const t = pair(), dir = S.dir;   // the pair and the direction being confirmed, read once
      S.swapping = true; paintGo();
      const r = await Act.swap(api(), ui, t, dir, amt()).catch((e) => { say(failText("The swap", e), "error"); return null; });
      S.swapping = false;
      if (r && !r.err && $("ppAmt")) { $("ppAmt").value = ""; S.q = null; S.qseq++; $("ppOut").textContent = "0.0"; $("ppQuote").innerHTML = ""; }
      paintGo(); load("swap").then(paint, paint);
    });
  }
  function paintSwap() {
    const t = pair(), list = toks();
    $("ppTop").innerHTML = banners();
    $("ppPairRow").hidden = list.length < 2;
    if (!typing()) $("ppPair").innerHTML = list.map((x, i) => `<option value="${i}"${i === S.sel ? " selected" : ""}>MINIMA / ${esc(x.name)}</option>`).join("");
    $("ppPoolLine").textContent = !up() ? "" : !S.pools ? "Finding pools…" : !t ? "No live pools yet. Create one in My LP to seed liquidity." : S.info ? poolLine(t, S.info) : "MINIMA / " + t.name;
    $("ppBalLine").textContent = t && S.bal ? balanceLine(S.bal, t) : "";
    $("ppMktLine").textContent = t ? marketLine(t, S.market, S.pools) : "";
    $("ppFrom").textContent = S.dir ? "MINIMA" : t ? t.name : "token"; $("ppTo").textContent = S.dir ? (t ? t.name : "token") : "MINIMA";
    paintGo();
    const recent = (S.acts || []).filter((a) => a.type !== "STATUS").slice(0, 3);
    $("ppRecent").innerHTML = recent.length ? `<div class="dx-label">RECENT ACTIVITY</div>${recent.map(recentRow).join("")}<button class="pp-link" data-ppgo="activity">See all  →  Activity</button>` : "";
  }

  // ---- Pools (PoolsView.java): every pool of the shared registry, one by one or combined per token ----
  const noop = () => {};
  const poolsSkeleton = () => `<div id="ppTop"></div><div class="pp-sumrow"><span class="pp-line" id="ppSum"></span><button class="pp-scan" data-ppscan="1">↻  SCAN</button></div>
      <div class="pp-chips" role="group" aria-label="View"><button data-ppmode="indiv">INDIVIDUAL</button><button data-ppmode="combined">COMBINED</button></div><div id="ppList"></div>`;
  const cardHtml = (c) => `<div class="dx-card pp-card"><b class="pp-ct">${esc(c.title)}</b>${c.rows.map((r) => `<div class="pp-kv pp-kv--mono"${r[2] ? ` data-copy="${esc(r[2])}" title="Click to copy"` : ""}><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("")}</div>`;
  function paintPools() {
    $("ppTop").innerHTML = banners();
    $("ppSum").textContent = !up() ? "" : S.scanning ? "Scanning the pool registry…" : S.pools ? poolsSummary(S.pools) : "Scanning the pool registry…";
    body().querySelectorAll("[data-ppmode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ppmode === "combined") === S.combined)));
    const list = S.combined ? (S.agg || []).map(combinedCard) : (S.pools || []).map(poolCard);
    $("ppList").innerHTML = !up() || !S.pools || (S.combined && !S.agg) ? "" : list.length ? list.map(cardHtml).join("")
      : `<div class="pp-line">${S.combined ? "No funded pools to combine yet." : "No live pools found in the registry yet. Create one in My LP to seed liquidity."}</div>`;
  }
  async function scan() { if (S.scanning || !up()) return; S.scanning = true; paint(); await api().ppScan().catch(() => null); S.scanning = false; load(S.tab).then(paint, paint); }

  // ---- the room ----
  const SCREENS = { swap: { skeleton: swapSkeleton, bind: bindSwap, paint: paintSwap, after: requote }, pools: { skeleton: poolsSkeleton, bind: noop, paint: paintPools } };
  function render(tab, host) {
    if (!D) return;
    const scr = SCREENS[tab];
    if (host.dataset.tab !== tab || !host.firstChild) {
      host.dataset.tab = tab; S.said = null; host.onclick = click; $("main").scrollTop = 0;
      host.innerHTML = scr ? scr.skeleton() : `<div class="dx-state dx-state--note" role="status">This screen of the room is not built in this version yet.</div>`;
      if (scr) scr.bind();
    }
    S.tab = tab; paint();
    load(tab).then(() => { paint(); if (scr && scr.after) scr.after(); }, paint);
  }
  function paint() { const b = body(), scr = SCREENS[S.tab]; if (b && scr && b.dataset.tab === S.tab && b.firstChild) scr.paint(); }
  function click(e) {
    const b = e.target.closest("button"); if (!b) return;
    const ds = b.dataset;
    if (ds.ppgo) return D.go(ds.ppgo);
    if (ds.ppstart) return D.start();
    if (ds.ppmode) { S.combined = ds.ppmode === "combined"; paint(); return load(S.tab).then(paint, paint); }   // the cached pools are drawn at once; a stale answer is simply painted over
    if (ds.ppscan) return scan();
  }

  return Object.assign({ Act, init: (deps) => { D = deps; }, render, onUpdate, reset, tick }, core);
});
