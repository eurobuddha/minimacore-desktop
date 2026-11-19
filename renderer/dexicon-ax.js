/*
 * dexicon-ax.js: Dexicon room ① MxUSD. The REAL AtomiX (USDT on Ethereum ⇄ MxUSD on Minima, and the MINIMA / USDT
 * market behind the ⇄ pill), drawn as the Android client draws it (apks/dexicon DoorsTab / MarketTab / OtcTab /
 * AssetsTab / WalletActions) over the engine the desktop already runs: the SAME window.mcd ax* calls with the SAME
 * arguments and the SAME guards, in the same order, as the panel it replaces (renderer/atomix-ui.js, which stays in
 * the tree until the 3e parity audit). This file changes screens, never behaviour: scripts/dexicon-ax.test.cjs runs
 * both and compares every call.
 *
 * Three parts: text and numbers with no DOM (Core), the money actions over (api, ui) with no DOM (Act), the screens.
 * RULE 2: the dollar token is MxUSD wherever a user reads it; "USDT" names only the Ethereum leg. The engine still
 * keys its book "mxusdt" and labels rows "mxUSDT": internal, and mapped here (ccyName, tok, mx).
 */
(function (root, factory) { const m = factory(); if (typeof module === "object" && module.exports) module.exports = m; else root.DexAx = m; })(this, function () {
  "use strict";

  // ======================================================================== Core: no DOM
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const ccyName = (l) => { l = String(l == null ? "" : l); return /^mxusdt?$/i.test(l) ? "MxUSD" : l.toLowerCase() === "minima" ? "MINIMA" : l; };
  const ccyOf = (st) => (st && st.currency === "minima" ? "MINIMA" : st && st.currency === "mxusdt" ? "MxUSD" : "…");
  /** the engine's own sentences say mxUSDT; the token is MxUSD (DoorHost.mx) */
  const mx = (s) => String(s == null ? "" : s).replace(/mxusdt/gi, "MxUSD");
  const tok = (t) => { if (typeof t === "string" && t.indexOf("0x") === 0) { const l = t.toLowerCase(); if (l === "0x00") return "MINIMA"; if (l.indexOf("7d39745") >= 0) return "MxUSD"; } return ccyName(t); };
  /** a price: 6 significant figures (the panel's fmtPx, AX.fmt.px) */
  const fmtPx = (p) => { p = Number(p); if (!isFinite(p) || p <= 0) return "0"; let s = p.toPrecision(6); if (s.indexOf("e") < 0 && s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; };
  /** a book size, cut: "k" from 1000 (the panel's fmtAbbrev) */
  const abbrev = (v) => { v = Number(v); if (!(v > 0)) return "—"; const trim = (x) => { const f = Math.pow(10, x < 10 ? 2 : 1); return (Math.floor(x * f) / f).toString(); }; return v >= 1000 ? trim(v / 1000) + "k" : trim(v); };
  /** an amount for display, CUT to dp decimals, never rounded up (float noise below 1e-9 aside) */
  const cut = (n, dp) => { n = Number(n); if (!isFinite(n)) return String(n); const s = n.toFixed(9), i = s.indexOf("."); return (s.slice(0, i + 1 + (dp == null ? 6 : dp))).replace(/0+$/, "").replace(/\.$/, "") || "0"; };
  /** the panel's ax6: the live estimate, floored to 6 decimals */
  const ax6 = (x) => (isFinite(x) && x > 0 ? String(Math.floor(x * 1e6) / 1e6) : "");
  const cleanNum = (v) => String(v).replace(/[^0-9.]/g, "");
  /** The coin amount a swap is sized by, from the field that was typed (the panel's two input handlers). */
  const coinAmount = (typedCoin, text, price) => { const c = cleanNum(text); return typedCoin ? c : (price > 0 && Number(c) > 0 ? ax6(Number(c) / price) : ""); };
  /** A custom slippage entry: the percent the panel would keep, or null (0.1 to 50, one decimal). */
  const slipOf = (text) => { const n = parseFloat(text); return isFinite(n) && n >= 0.1 && n <= 50 ? Math.round(n * 10) / 10 : null; };
  const roleLabel = (r) => (r === "RESPONDER" ? "maker" : r === "INITIATOR" ? "taker" : String(r || "").toLowerCase());
  const terminal = (s) => s.status === "COMPLETE" || s.status === "REFUNDED" || s.status === "ERROR";

  function bestLine(sell, price, cap, ccy, depth, makers) {
    if (!(price > 0)) return "No live makers on the book right now.";
    let s = "Best price " + fmtPx(price) + " USDT/" + ccy + "  ·  up to ~" + abbrev(cap) + " at best";
    if (depth != null && depth > cap + 1e-9) s += ", ~" + abbrev(depth) + " across the book";
    if (makers > 0) s += "  ·  " + makers + (makers === 1 ? " maker" : " makers");
    return s + (sell ? "" : "  ·  ETH gas per part");
  }
  /** The review of a frozen quote (DoorsTab.openReview, the panel's axDoReview): every part with its maker key whole. */
  function review(q, sell) {
    const ccy = ccyName(q.label);
    if (q.single) return { title: "Review: Sell " + ccy, ok: "Start swap",
      text: "Sell  " + q.single.minima + " " + ccy + "\nReceive  ≈ " + q.single.usdt + " USDT\n\nBest price " + fmtPx(q.single.price) + " USDT/" + ccy + "\nCounterparty\n" + q.single.maker
        + "\n\nThis locks your " + ccy + " on Minima now. If the maker never locks, it is refunded by itself after the timelock. Keep the app and the node running." };
    const p = q.plan, n = p.legs.length, parts = n + (n === 1 ? " part" : " parts");
    const L = ["Avg " + fmtPx(p.avgPrice) + "  ·  worst " + fmtPx(p.worstPrice) + " USDT/" + ccy + (!sell && p.slippagePct > 0 ? "  ·  within " + cut(p.slippagePct, 2) + "% slippage" : ""), ""];
    p.legs.forEach((l, i) => L.push("Part " + (i + 1) + " · " + l.minima + " " + ccy + " @ " + fmtPx(l.price) + " → " + l.usdt + " USDT\n  " + l.maker));
    L.push("", sell ? "Total: sell " + cut(p.filledMinima) + " " + ccy + " · receive ≈ " + cut(p.totalUsdt) + " USDT" : "Total: pay ≈ " + cut(p.totalUsdt) + " USDT · receive ≈ " + cut(p.filledMinima) + " " + ccy);
    if (p.partial) L.push("", "Fills " + cut(p.filledMinima) + " of " + cut(p.target) + " " + ccy + ": " + (!sell && p.stopReason === "slippage" ? "the rest is priced beyond your " + cut(p.slippagePct, 2) + "% slippage." : "the rest isn't available in the book right now."));
    if (!sell) L.push("", "Each part is a separate Ethereum transaction: you pay ETH gas " + n + (n === 1 ? " time." : " times."));
    L.push("", (sell ? "This locks your " + ccy + " on Minima now." : "This locks your USDT on Ethereum now.") + " Parts run one at a time. If one can't start we stop and you keep the rest; unmatched parts refund by themselves after the timelock. Keep the app and the node running.");
    return { title: sell ? "Sell " + cut(p.filledMinima) + " " + ccy + " in " + parts : "Buy ≈ " + cut(p.filledMinima) + " " + ccy + " for ≈ " + cut(p.totalUsdt) + " USDT in " + parts, text: L.join("\n"), ok: n > 1 ? "Start sweep" : "Start swap" };
  }
  /** What a finished axSwap call means, in the alert's three parts: what happened, were you filled, what to do. */
  function takeResult(r) {
    if (!r) return { kind: "error", text: "The swap gave no answer. Look at Activity before trying again: a part may have been locked." };
    if (r.err) return { kind: "error", text: mx(r.err) + " Nothing was locked." };
    const all = r.ok === r.of && !r.stopped;
    return { kind: all ? "note" : "error", text: r.ok + " of " + r.of + (r.of === 1 ? " part" : " parts") + " locked." + (r.stopped ? " " + mx(r.stopped) + "." : "")
      + (r.ok ? " Nothing is swapped yet: each locked part completes when its maker locks the other side, or is refunded by itself at its timelock. Follow it below or in Activity." : " Nothing was locked and nothing was spent.") };
  }

  /** YOUR SWAP (DoorsTab.paintStages). rows: { state: "done"|"active"|"pending"|"warn", text }. */
  function stages(sell, ccy, connected, bals, swaps, now) {
    const gt = (v) => parseFloat(v) > 0, rows = [{ state: connected ? "done" : "warn", text: "Node connected" }];
    if (sell) rows.push({ state: gt(bals.minima) ? "done" : "warn", text: ccy + " ready to sell" });
    else rows.push({ state: gt(bals.usdt) ? "done" : "warn", text: "USDT ready to spend" }, { state: gt(bals.eth) ? "done" : "warn", text: "ETH for gas" });
    let active = null, done = null, more = 0;
    for (const s of swaps || []) {
      if (!terminal(s)) { more++; if (!active || s.created > active.created) active = s; }
      else if (now - Number(s.updated) <= 30000 && (!done || s.updated > done.updated)) done = s;   // a swap that just finished stays 30 s, so it is seen to land
    }
    const sw = active || done; if (active) more--;
    if (!sw) { rows.push({ state: "pending", text: "Enter an amount and tap Review to begin" }); return { rows, which: "", check: "", more: 0 }; }
    const st = tok(sw.selltoken), bt = tok(sw.buytoken), a = sw.status === "LOCKED" || sw.status === "CLAIMING" ? 3 : sw.status === "COMPLETE" ? 5 : 2;
    const leg = (i) => (i < a ? "done" : i === a ? "active" : "pending");
    if (sw.status === "REFUNDED") rows.push({ state: "warn", text: "Timed out: " + sw.sellamount + " " + st + " refunded" });
    else if (sw.status === "ERROR") rows.push({ state: "warn", text: "Stopped: see the swap below for what happened" });
    else rows.push({ state: leg(1), text: "Locked your " + sw.sellamount + " " + st }, { state: leg(2), text: "Counterparty locks their side" }, { state: leg(3), text: "Claim your " + sw.buyamount + " " + bt }, { state: leg(4), text: "Swap complete" });
    return { rows, which: sw.sellamount + " " + st + "  →  " + sw.buyamount + " " + bt + "   ·   " + roleLabel(sw.role), check: terminal(sw) ? "" : sw.hash, more };
  }

  /** One swap as a ledger card (Ledger.swap + the panel's axSwapRows / axVisHtml): words, never raw states. */
  function swapItem(s, answer) {
    const sell = tok(s.selltoken), buy = tok(s.buytoken), st = s.status, maker = s.role === "RESPONDER", v = s.vis;
    const running = st === "STARTED" || st === "LOCKED" || st === "CLAIMING", complete = st === "COMPLETE", refunded = st === "REFUNDED", error = st === "ERROR";
    const outcome = maker
      ? (complete ? (buy === "USDT" ? "paid · USDT at your Ethereum address" : "paid · in your wallet") : st === "CLAIMING" ? "claiming your payment" : running ? "you locked · waiting for the taker to claim" : refunded ? "the taker never claimed · " + sell + " back" : error ? "failed" : String(st || "").toLowerCase())
      : (st === "STARTED" ? "waiting for the maker" : running ? "claiming" : complete ? (buy === "USDT" ? "at your Ethereum address" : "in your wallet") : refunded ? "maker didn't lock · " + sell + " back" : error ? "failed" : String(st || "").toLowerCase());
    const lines = [];
    if (s.detail) lines.push(mx(s.detail));
    let refund = null;
    if (v) {
      const when = (t) => (v.blocks ? "block " + t : new Date(t * 1000).toLocaleString());
      const left = (t) => { const d = t - v.cur + 1; if (v.blocks) return v.cur ? d + (d === 1 ? " block" : " blocks") : "a few blocks"; return d >= 3600 ? Math.floor(d / 3600) + "h " + Math.ceil((d % 3600) / 60) + "m" : Math.ceil(d / 60) + " min"; };
      if (v.steps && v.steps.length) lines.push("✓ " + v.steps.map(mx).join(" · ✓ "));
      if (st === "STARTED" && !v.timedOut && v.cur < v.respondBy) lines.push("Maker must respond by " + when(v.respondBy));
      if (v.notice) lines.push((v.notice.state === "declined" ? "Maker declined: " : "Maker is retrying: ") + mx(v.notice.reason));
      if (v.canRefund && (v.timedOut || v.cur >= v.respondBy) && !v.refundSent) lines.push("Refund opens " + when(v.refundAt + (v.blocks ? 1 : 0)) + ": automatic, app open or not");
      if (v.refunded) lines.push("Refunded");
      if (v.canRefund) refund = v.refundOpen ? { label: "Refund now", enabled: true } : { label: "Refund now (opens in " + left(v.refundAt) + ")", enabled: false };
    }
    if (answer) lines.push(mx(answer));
    const ids = [["swap", s.hash], ["counterparty", s.counterparty], ["swap id on Ethereum", s.contractId]].filter((x) => x[1]);
    if (v && v.refundSent) ids.push(["refund sent", v.refundSent]);
    return { hash: s.hash, live: running, terminal: terminal(s), maker, created: Number(s.created) || 0,
      title: maker ? "AtomiX · your market filled" : s.direction === "ERC20_TO_MINIMA" ? "AtomiX entry" : "AtomiX exit",
      amount: s.sellamount + " " + sell + " → " + s.buyamount + " " + buy, sub: roleLabel(s.role) + " · " + outcome,
      chip: running ? "LIVE" : complete ? "DONE" : refunded ? "REFUNDED" : "FAILED", tone: running ? "live" : complete ? "ok" : "bad", lines, refund, ids };
  }
  const HIDE_ASK = (maker) => "This only removes the card from Swap and Activity. If any funds were locked on-chain they still refund by themselves at the timelock: hiding doesn't touch them. "
    + (maker ? "It stays in History with Check now; your own lock returns by itself after its timelock." : "It stays in History, with Check now and Refund now.");

  /**
   * The launch rule (DoorHost.applyLaunchRule): the room is for MxUSD; it stays in MINIMA mode with a banner while a
   * USDT ⇄ MINIMA swap or deal is in flight or the MINIMA market is live. "idle": MINIMA mode with nothing live. On
   * the phone that case switches back by itself; here the switch posts a signed withdrawal of the market, so the
   * banner offers it and the user confirms it. null: no banner (MxUSD mode, or not known yet).
   */
  function launch(currency, swaps, makerLive, otcLive) {
    if (currency !== "minima" || swaps == null || makerLive == null) return null;
    const swap = (swaps || []).some((s) => !terminal(s)) || !!otcLive, live = !!makerLive;
    if (!swap && !live) return { idle: true, text: "AtomiX is in MINIMA mode: this room quotes USDT ⇄ MINIMA. Nothing of yours is live there. Use the ⇄ pill to go back to MxUSD." };
    return { idle: false, text: "Opened in MINIMA mode: " + (swap && live ? "a USDT ⇄ MINIMA swap or OTC deal is in flight and your MINIMA market is live" : swap ? "a USDT ⇄ MINIMA swap or OTC deal is in flight" : "your MINIMA market is live")
      + ". Dexicon never switches a live market by itself. Use the ⇄ pill to go back to MxUSD when you are ready." };
  }
  /** Is my market on the book, or kept there (the maker read model and my own levels in the book)? null: unknown. */
  function makerLive(mc, book) {
    if (!mc && !book) return null;
    const mine = book ? (book.bids || []).concat(book.asks || []).some((r) => r.mine) : false, st = (mc && mc.state) || {};
    return mine && !st.withdrawn;
  }

  // ======================================================================== Act: the money actions, no DOM
  // ui = { confirm(title, text, okLabel) → Promise<bool>, say(text, kind) }. Every function here makes the SAME
  // window.mcd calls, with the same arguments, behind the same guards, in the same order, as renderer/atomix-ui.js.
  const fail = (e) => ({ err: String((e && e.message) || e) });
  const Act = {
    /** axQuote (freeze) → review → axSwap(the frozen quote's id). */
    async take(api, ui, sell, amt, slip, ccy) {
      if (!amt) { ui.say("Enter how much " + (ccy || "MxUSD") + " to " + (sell ? "sell" : "buy") + ". Nothing was sent.", "note"); return null; }
      const q = await api.axQuote(sell, amt, slip).catch(fail);
      if (q.err) { ui.say(mx(q.err) + " Nothing was sent.", "note"); return null; }
      const r = review(q, sell);
      if (!await ui.confirm(r.title, r.text, r.ok)) return null;
      const res = await api.axSwap(q.quoteId).catch(fail), t = takeResult(res);
      ui.say(t.text, t.kind);
      return res;
    },
    /** confirm → axSwitchCurrency(the other market's key). `cur` is read ONCE. */
    async switchCurrency(api, ui, cur) {
      const key = cur === "minima" ? "mxusdt" : "minima", to = key === "mxusdt" ? "MxUSD" : "MINIMA";
      if (!await ui.confirm("Switch to " + to + "?", "Your live market on the current book is withdrawn first, then AtomiX moves to the " + to + " book. Any in-flight swap still settles.", "Switch to " + to)) return null;
      const r = await api.axSwitchCurrency(key).catch(fail);
      if (r && r.err) ui.say("The market was not switched: " + mx(r.err), "error");
      return r;
    },
    async refundNow(api, ui, hash) { const r = await api.axRefundNow(hash).catch((e) => ({ msg: "Refund check failed: " + ((e && e.message) || e) })); return mx(r.msg); },
    async inspect(api, hash) { return (await api.axInspect(hash).catch((e) => ["Check failed: " + ((e && e.message) || e)])).map(mx); }
  };

  const core = { MXUSD, ccyName, ccyOf, mx, tok, fmtPx, abbrev, cut, ax6, cleanNum, coinAmount, slipOf, roleLabel, terminal, bestLine, review, takeResult, stages, swapItem, HIDE_ASK, launch, makerLive };
  if (typeof document === "undefined") return Object.assign({ Act }, core);

  // ======================================================================== the screens
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; };
  let D = null;   // deps from app.js: api, copy, dialog, running(), consolidateToken, go(tab), repaintStrip()
  const S = { st: { ready: false }, book: null, swaps: null, bals: null, mc: null, mh: null, otc: null, sell: false, typed: null, said: null, answers: {}, at: 0, tab: "", busy: false,
    slip: slipOf(pref("dexicon_ax_slip")) || 4.2, hidden: new Set((pref("dexicon_ax_hidden") || "").split(",").filter(Boolean)) };
  const api = () => D.api;
  const ccy = () => ccyOf(S.st), halted = () => !!(S.st && S.st.halt);
  const say = (text, kind) => { S.said = text ? { text, kind: kind || "error" } : null; paint(); };
  const ui = { confirm: (title, text, ok) => D.dialog(title, text, ok), say };
  const body = () => $("dxAxBody");
  const visible = (tab) => { const b = body(); return !!b && b.dataset.tab === (tab || S.tab) && $("shell").dataset.mode === "dex" && b.offsetParent !== null; };
  const typing = () => { const a = document.activeElement, b = body(); return !!(a && b && b.contains(a) && a.tagName === "INPUT"); };

  /** A dialog with its own fields. onOk(dialog) returns a string to refuse (shown, the dialog stays) or nothing. */
  function form(title, html, okLabel, onOk, wire) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"); d.className = "dx-dlg ax-dlg"; d.dataset.axccy = S.st.currency || "";
      d.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="ax-bad" role="alert"></div><div class="dx-dlg__b"><button class="dx-btn" data-x="0">Close</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
      const end = (v) => { d.close(); d.remove(); resolve(v); };
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-x]"); if (!b) return;
        if (b.dataset.x === "0") return end(null);
        b.disabled = true; const bad = await onOk(d); b.disabled = false;
        if (typeof bad === "string" && bad) d.querySelector(".ax-bad").textContent = bad; else end(bad === undefined ? true : bad);
      });
      d.addEventListener("cancel", () => { d.remove(); resolve(null); });
      $("shell").appendChild(d); if (wire) wire(d); d.showModal();
    });
  }
  const numIn = (i) => { const c = i.value.replace(",", ".").replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"); if (c !== i.value) i.value = c; return c; };

  // ---- reads: each screen asks for what it shows; the Ethereum balances are slow and arrive by themselves ----
  async function load(tab) {
    S.at = Date.now();
    const fresh = await api().axStatus().catch(() => null); if (fresh) S.st = fresh;
    D.repaintStrip();
    if (!D.running() || !S.st.ready) return;
    const want = { book: () => api().axBook(), swaps: () => api().axSwaps(), mc: () => api().axMakerCfg() };
    const keys = Object.keys(want), got = await Promise.allSettled(keys.map((k) => want[k]()));
    keys.forEach((k, i) => { if (got[i].status === "fulfilled") S[k] = got[i].value; });
    api().axWallet().then((w) => { if (w) { S.wallet = w; S.bals = w.bals; paint(); } }).catch(() => {});
  }
  function onUpdate() { if (S.upd || !D) return; S.upd = setTimeout(() => { S.upd = null; if (visible()) load(S.tab).then(paint, paint); else api().axStatus().then((s) => { if (s) { S.st = s; D.repaintStrip(); } }).catch(() => {}); }, 400); }
  function reset() { Object.assign(S, { st: { ready: false }, book: null, swaps: null, bals: null, wallet: null, mc: null, mh: null, otc: null, typed: null, said: null, answers: {}, at: 0 }); const b = body(); if (b) { b.innerHTML = ""; delete b.dataset.tab; } }

  // ---- what stands above every screen of the room ----
  function banners() {
    const out = [];
    if (!D.running()) out.push(`<div class="dx-state" role="status">The node is stopped, so nothing here can trade and nothing can settle. Start it and AtomiX comes back by itself.</div>`);
    else if (!S.st.ready) out.push(`<div class="dx-card ax-big"><b class="ax-t14">Setting up AtomiX…</b><div class="ax-dim">Preparing your Ethereum wallet and swap keys on this node, then reading the market. The first start takes a minute or two.</div></div>`);
    const l = S.st.ready ? launch(S.st.currency, S.swaps, makerLive(S.mc, S.book), null) : null;
    if (l) out.push(`<div class="ax-launch" role="status">${esc(l.text)}</div>`);
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  const why = (key, title, text) => { const open = pref("dexicon_fold_" + key) === "1"; return `<button class="ax-why${open ? " ax-why--open" : ""}" data-axwhy="${key}" aria-expanded="${open}"><span class="dx-label">${esc(title)} ${open ? "▾" : "▸"}</span>${open ? `<span class="ax-why__t">${esc(text)}</span>` : ""}</button>`; };
  const idLine = (label, value) => `<div class="dx-id" data-copy="${esc(value)}" title="Click to copy">${esc(label)} ${esc(value)}</div>`;

  /** A swap's card: the same one on Swap (IN PROGRESS), in Activity and in History. */
  function swapCard(s, hideable) {
    const it = swapItem(s, S.answers[s.hash]);
    return `<div class="dx-card ax-swap"><div class="dx-row"><b class="ax-t13">${esc(it.title)}</b><span class="dx-row"><span class="dx-chip" data-tone="${it.tone}">${it.chip}</span>${hideable ? `<button class="ax-x" data-axhide="${esc(it.hash)}" aria-label="Hide this swap's card">✕</button>` : ""}</span></div>`
      + `<div class="ax-amt">${esc(it.amount)}</div><div class="ax-dim">${esc(D.relTime ? D.relTime(it.created) + " · " : "")}${esc(it.sub)}</div>`
      + it.lines.map((l) => `<div class="ax-line">${esc(l)}</div>`).join("") + it.ids.map((x) => idLine(x[0], x[1])).join("")
      + `<div class="ax-acts"><button class="dx-btn" data-axcheck="${esc(it.hash)}">Check now</button>${it.refund ? `<button class="dx-btn${it.refund.enabled ? " dx-btn--go" : ""}" data-axrefund="${esc(it.hash)}"${it.refund.enabled ? "" : " disabled"}>${esc(it.refund.label)}</button>` : ""}</div></div>`;
  }
  async function checkNow(hash) {
    const lines = await Act.inspect(api(), hash);
    if (await D.dialog("Swap status", lines.join("\n\n") + "\n\nSwap " + hash, "Check again")) checkNow(hash);
  }
  async function hide(hash) {
    const s = (S.swaps || []).find((x) => x.hash === hash); if (!s) return;
    if (!terminal(s) && !await D.dialog("Hide this swap?", HIDE_ASK(s.role === "RESPONDER"), "Hide")) return;
    S.hidden.add(hash); pref("dexicon_ax_hidden", [...S.hidden].slice(-400).join(",")); paint();
  }

  // ---- Swap (DoorsTab.java) ----
  const WHY_SWAP = "Dexicon's exchange (③) trades MINIMA against MxUSD, Minima's own dollar. If your dollars are USDT on Ethereum, buy MxUSD with them here first; sell MxUSD here to turn it back into USDT. Both sides lock their funds in a time-locked contract; if anything stalls, you are refunded automatically. Already hold MxUSD? Go straight to ③. Just swapping? You can stop here. Your Ethereum wallet (the USDT you swap from and to) is in Assets.";
  function swapSkeleton() {
    return `<div id="axTop"></div><div id="axWhy"></div>
      <h2 class="ax-h2" id="axHead"></h2><div class="ax-sub">Enter an amount and see exactly what you'll get at the best price.</div>
      <div class="ax-side" role="group" aria-label="Direction"><button id="axSellB"></button><button id="axBuyB"></button></div>
      <div class="dx-card ax-big" id="axEmpty" hidden><b class="ax-t14" id="axEmptyT"></b><div class="ax-dim">Check back soon, or open Market to place your own order and wait for a match.</div><button class="dx-btn ax-btn--s" data-axgo="market">Open Market</button></div>
      <div class="dx-card ax-big" id="axCard" hidden>
        <div class="ax-fl">YOU SEND</div>
        <div class="ax-amtrow"><div class="ax-chip" id="axSendChip"></div><input class="ax-bigin" id="axSend" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.00" aria-label="You send"></div>
        <div class="ax-flip"><i></i><button id="axFlip" aria-label="Flip: swap the other way">⇅</button><i></i></div>
        <div class="ax-fl">YOU RECEIVE (estimate)</div>
        <div class="ax-amtrow"><div class="ax-chip" id="axRecvChip"></div><input class="ax-bigin ax-bigin--recv" id="axRecv" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.00" aria-label="You receive, an estimate"></div>
        <div class="ax-best" id="axBest"></div>
        <div class="ax-slip" id="axSlip"></div>
        <div class="ax-plan" id="axPlan" role="status"></div>
        <button class="ax-cta" id="axReview">Review swap</button>
      </div>
      <div class="ax-stages" id="axStages"></div>
      <div class="dx-label ax-prog" id="axProgL" hidden>IN PROGRESS</div><div id="axList"></div>
      <button class="ax-fin" id="axFin" data-axgo="activity"></button>`;
  }
  const price = () => { const b = S.book || {}; return S.sell ? b.bestBid : b.bestAsk; };
  /** the field the user did NOT type follows the best price (the panel's wireAxSwapInputs; DoorsTab.mirror) */
  function mirror() {
    if (S.typed == null) return;
    const from = $(S.typed === "send" ? "axSend" : "axRecv"), other = $(S.typed === "send" ? "axRecv" : "axSend"), p = price(), v = numIn(from);
    const coinTyped = (S.typed === "send") === S.sell;
    if (document.activeElement !== other) other.value = !(p > 0) || !(Number(v) > 0) ? "" : coinTyped ? ax6(Number(v) * p) : ax6(Number(v) / p);
  }
  /** the amount in the coin, as the panel kept it (axAmt) */
  const amount = () => { if (S.typed == null) return ""; const coinTyped = (S.typed === "send") === S.sell; return coinAmount(coinTyped, $(S.typed === "send" ? "axSend" : "axRecv").value, price()); };
  function setSide(sell) { if (S.sell !== sell) { S.sell = sell; S.typed = null; $("axSend").value = ""; $("axRecv").value = ""; $("axPlan").textContent = ""; } S.said = null; paint(); }
  function preview() {
    clearTimeout(S.pv);
    S.pv = setTimeout(async () => {
      const amt = amount(); if (!visible("swap") || !amt) return;
      const sell = S.sell, pv = await api().axSwapPreview(sell, amt, S.slip).catch(() => null);
      if (!pv || !visible("swap") || sell !== S.sell || amt !== amount()) return;
      const plan = $("axPlan"), m = pv.meta || {};
      if (pv.err) { plan.dataset.kind = "bad"; plan.textContent = mx(pv.err); return; }
      $("axBest").textContent = bestLine(sell, m.bestPrice, m.bestCap, ccyName(m.label), m.depth, (S.book || {}).makers);
      const recv = $(S.typed === "send" ? "axRecv" : "axSend");   // refine the field that was not typed with the engine's own numbers
      const val = pv.single ? (S.typed === "send" ? (sell ? pv.single.usdt : pv.single.minima) : (sell ? pv.single.minima : pv.single.usdt)) : (S.typed === "send" ? (sell ? pv.plan.totalUsdt : pv.plan.filledMinima) : (sell ? pv.plan.filledMinima : pv.plan.totalUsdt));
      if (document.activeElement !== recv && val != null) recv.value = String(val);
      const p = pv.plan; plan.dataset.kind = p && p.partial ? "warn" : "";
      plan.textContent = !p ? "1 part · " + fmtPx(pv.single.price) + " USDT/" + ccy() + "\nYou receive ≈ " + pv.single.usdt + " USDT"
        : p.legs.length + (p.legs.length === 1 ? " part" : " parts") + " · avg " + fmtPx(p.avgPrice) + " · worst " + fmtPx(p.worstPrice) + " USDT/" + ccy()
          + (sell ? "\nYou receive ≈ " + cut(p.totalUsdt) + " USDT" : "\nYou pay ≈ " + cut(p.totalUsdt) + " USDT for " + cut(p.filledMinima) + " " + ccy())
          + (p.partial ? "\nPARTIAL: fills " + cut(p.filledMinima) + " of " + cut(p.target) + " " + ccy() + (!sell && p.stopReason === "slippage" ? ": the rest is priced beyond your " + cut(p.slippagePct, 2) + "% slippage." : ": the rest isn't in the book right now.") : "");
    }, 250);
  }
  function bindSwap() {
    $("axSellB").onclick = () => setSide(true); $("axBuyB").onclick = () => setSide(false); $("axFlip").onclick = () => setSide(!S.sell);
    for (const [id, name] of [["axSend", "send"], ["axRecv", "recv"]]) $(id).oninput = () => { S.typed = $(id).value ? name : null; S.said = null; mirror(); if (!$(id).value) { $("axPlan").textContent = ""; } preview(); paintReview(); };
    $("axReview").onclick = async () => {
      if (S.busy) return;
      if (halted()) return say("Halted: this node no longer owns the keys AtomiX uses here. Nothing was sent.", "error");
      S.busy = true; paintReview();
      const r = await Act.take(api(), ui, S.sell, amount(), S.slip, ccy());
      S.busy = false;
      if (r && !r.err) { S.typed = null; $("axSend").value = ""; $("axRecv").value = ""; $("axPlan").textContent = ""; }
      load("swap").then(paint, paint);
    };
  }
  const paintReview = () => { const b = $("axReview"); if (b) { b.disabled = S.busy || halted(); b.dataset.dim = amount() ? "0" : "1"; b.textContent = S.busy ? "Starting…" : "Review swap"; } };
  function paintSwap() {
    const c = ccy(), b = S.book || {}, p = price(), ready = D.running() && S.st.ready, bals = S.bals || { minima: "—", usdt: "—", eth: "—" };
    $("axTop").innerHTML = banners(); $("axWhy").innerHTML = why("swap", "WHY THIS STEP", WHY_SWAP);
    $("axHead").textContent = "Swap " + c + " ⇄ USDT";
    $("axSellB").textContent = "Sell " + c; $("axBuyB").textContent = "Buy " + c;
    $("axSellB").setAttribute("aria-pressed", S.sell); $("axBuyB").setAttribute("aria-pressed", !S.sell);
    $("axEmpty").hidden = !(ready && S.book && !(p > 0)); $("axCard").hidden = !(ready && p > 0);
    $("axEmptyT").textContent = "No one is quoting a " + (S.sell ? "buy" : "sell") + " price right now.";
    const chip = (coin) => `<span class="ax-disc${coin ? "" : " ax-disc--usdt"}">${coin ? "M" : "$"}</span><span><b>${esc(coin ? c : "USDT")}</b><small>avail ${esc(coin ? bals.minima : bals.usdt)}</small></span>`;
    $("axSendChip").innerHTML = chip(S.sell); $("axRecvChip").innerHTML = chip(!S.sell);
    if (!typing()) mirror();
    if (!amount()) $("axBest").textContent = bestLine(S.sell, p, S.sell ? b.bidCap : b.askCap, c, null, b.makers);
    const custom = S.slip !== 2 && S.slip !== 4.2;
    $("axSlip").hidden = S.sell;
    $("axSlip").innerHTML = `<span>Max slippage</span>${[2, 4.2].map((s) => `<button data-axslip="${s}" aria-pressed="${S.slip === s}">${s}%</button>`).join("")}<button data-axslip="custom" aria-pressed="${custom}">${custom ? S.slip + "%" : "Custom"}</button>`;
    paintReview();
    const stg = stages(S.sell, c, D.running() && S.st.ready, bals, S.swaps, Date.now());
    $("axStages").innerHTML = `<div class="ax-fl">YOUR SWAP</div>` + stg.rows.slice(0, S.sell ? 2 : 3).map(stageRow).join("") + (stg.which ? `<div class="ax-which">${esc(stg.which)}</div>` : "") + stg.rows.slice(S.sell ? 2 : 3).map(stageRow).join("")
      + (stg.check ? `<button class="dx-btn ax-btn--s" data-axcheck="${esc(stg.check)}">Check now</button>` : "") + (stg.more > 0 ? `<button class="ax-more" data-axgo="activity">+ ${stg.more} more swap${stg.more === 1 ? "" : "s"} in flight: see Activity</button>` : "");
    const live = (S.swaps || []).filter((s) => !terminal(s) && !S.hidden.has(s.hash));
    $("axProgL").hidden = !live.length; $("axList").innerHTML = live.map((s) => swapCard(s, true)).join("");
    $("axFin").textContent = S.swaps && !S.swaps.length ? "No AtomiX swaps yet. Buy " + c + " brings ERC20 USDT in; Sell " + c + " takes it back out as USDT." : S.swaps ? "Every swap, finished or not, is in Activity ›" : "";
  }
  const stageRow = (r) => `<div class="ax-stage" data-state="${r.state}"><i></i><span>${esc(r.text)}</span></div>`;
  async function customSlip() {
    const v = await D.dialog("Max slippage", "The most above the best price you'll pay per " + ccy() + " when a buy fills across deeper levels (0.1 to 50 %).", "Set", { label: "Max slippage, percent", value: String(S.slip) });
    if (v == null) return;
    const n = slipOf(v); if (n == null) return say("Enter a percent between 0.1 and 50. The slippage was not changed.", "note");
    S.slip = n; pref("dexicon_ax_slip", String(n)); paint(); preview();
  }

  // ---- the room ----
  const SCREENS = { swap: { skeleton: swapSkeleton, bind: bindSwap, paint: paintSwap } };
  function render(tab, host) {
    if (!D) return;
    const scr = SCREENS[tab]; if (!scr) { host.dataset.tab = tab; host.onclick = null; host.innerHTML = `<div class="dx-state dx-state--note" role="status">This screen of the room is not built in this version yet.</div>`; S.tab = tab; return; }
    if (host.dataset.tab !== tab || !host.firstChild) { host.dataset.tab = tab; host.innerHTML = scr.skeleton(); host.onclick = click; S.said = null; scr.bind(); $("main").scrollTop = 0; }
    S.tab = tab; host.dataset.axccy = S.st.currency || "";
    paint(); load(tab).then(paint, paint);
  }
  function paint() { const b = body(), scr = SCREENS[S.tab]; if (!b || !scr || b.dataset.tab !== S.tab || !b.firstChild) return; b.dataset.axccy = S.st.currency || ""; scr.paint(); }
  /** once a minute while a screen of the room is open (the phone's REFRESH_MS), never under someone typing */
  function tick() { if (D && SCREENS[S.tab] && visible() && !typing() && !S.busy && Date.now() - S.at > 60000) load(S.tab).then(paint, paint); }
  async function click(e) {
    const b = e.target.closest("button"); if (!b) return;
    const ds = b.dataset;
    if (ds.axwhy) { pref("dexicon_fold_" + ds.axwhy, pref("dexicon_fold_" + ds.axwhy) === "1" ? "0" : "1"); return paint(); }
    if (ds.axgo) return D.go(ds.axgo);
    if (ds.axslip) { if (ds.axslip === "custom") return customSlip(); S.slip = Number(ds.axslip); pref("dexicon_ax_slip", ds.axslip); paint(); return preview(); }
    if (ds.axcheck) return checkNow(ds.axcheck);
    if (ds.axhide) return hide(ds.axhide);
    if (ds.axrefund) { S.answers[ds.axrefund] = "Asking for the refund…"; paint(); S.answers[ds.axrefund] = await Act.refundNow(api(), ui, ds.axrefund); return load(S.tab).then(paint, paint); }
  }
  /** The ⇄ pill (MainActivity.switchCurrencyDialog): the panel's confirm, then the engine's switch. */
  async function switchCurrency() {
    if (!D || S.switching || !S.st.ready) return;
    S.switching = true; D.repaintStrip();
    await Act.switchCurrency(api(), ui, S.st.currency);
    S.switching = false; S.typed = null; S.book = null; S.mc = null;
    const b = body(); if (b && SCREENS[S.tab] && b.dataset.tab === S.tab) { b.innerHTML = ""; render(S.tab, b); } else load("").then(D.repaintStrip, D.repaintStrip);
  }

  return Object.assign({ Act, init: (deps) => { D = deps; api().axStatus().then((s) => { if (s) { S.st = s; D.repaintStrip(); } }).catch(() => {}); }, render, onUpdate, reset, tick, click, switchCurrency,
    pill: () => ({ text: "⇄  " + (S.switching ? "Switching…" : ccy()), currency: S.st.currency || "", busy: !!S.switching, label: "Trading " + ccy() + ". Activate to switch to " + (S.st.currency === "minima" ? "MxUSD" : "MINIMA") + "." }) }, core);
});
