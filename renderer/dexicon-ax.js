/*
 * dexicon-ax.js: Dexicon room ① MxUSD. The REAL AtomiX (USDT on Ethereum ⇄ MxUSD on Minima, and the MINIMA / USDT
 * market behind the ⇄ pill), drawn as the Android client draws it (apks/dexicon DoorsTab / MarketTab / OtcTab /
 * AssetsTab / WalletActions) over the engine the desktop already runs: the SAME window.mcd ax* calls with the SAME
 * arguments and the SAME guards, in the same order, as the panel it replaces (renderer/atomix-ui.js, removed in 0.18.141; was kept in
 * the tree until the 3e parity audit). This file changes screens, never behaviour: scripts/dexicon-ax.test.cjs runs
 * both and compares every call.
 *
 * Three parts: text and numbers with no DOM (Core), the money actions over (api, ui) with no DOM (Act), the screens.
 * RULE 2: the dollar token is MxUSD wherever a user reads it; "USDT" names only the Ethereum leg. The engine still
 * keys its book "mxusdt" and labels rows "mxUSDT": internal, and mapped here (ccyName, tok, mx).
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");   // loaded by a test or the main process: the same t(), th(), tr() the window has
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
  /** A typed amount as a plain number text. A comma or a second point is never read as anything ("" = no amount):
   *  stripping the comma made "1,5" fifteen (0.18.121; the Exchange ticket's rule is DexCore.entryProblem). */
  const cleanNum = (v) => (/,|\..*\./.test(String(v)) ? "" : String(v).replace(/[^0-9.]/g, ""));
  /** The coin amount a swap is sized by, from the field that was typed (the panel's two input handlers). */
  const coinAmount = (typedCoin, text, price) => { const c = cleanNum(text); return typedCoin ? c : (price > 0 && Number(c) > 0 ? ax6(Number(c) / price) : ""); };
  /** A custom slippage entry: the percent the panel would keep, or null (0.1 to 50, one decimal). */
  const slipOf = (text) => { const n = parseFloat(text); return isFinite(n) && n >= 0.1 && n <= 50 ? Math.round(n * 10) / 10 : null; };
  const roleLabel = (r) => (r === "RESPONDER" ? "maker" : r === "INITIATOR" ? "taker" : String(r || "").toLowerCase());
  /** Finished: complete, refunded, or in ERROR with its timelock window closed. A swap in ERROR whose window is still
   *  open (inWindow, the engine's rule) may hold a lock that can be refunded: it stays In progress, with Refund now. */
  const terminal = (s) => s.status === "COMPLETE" || s.status === "REFUNDED" || (s.status === "ERROR" && !s.inWindow);

  function bestLine(sell, price, cap, ccy, depth, makers) {
    if (!(price > 0)) return I18N.t("No live makers on the book right now.");
    let s = I18N.t("Best price {price} USDT/{ccy}  ·  up to ~{cap} at best", { price: fmtPx(price), ccy: ccy, cap: abbrev(cap) });
    if (depth != null && depth > cap + 1e-9) s += ", ~" + abbrev(depth) + " across the book";
    if (makers > 0) s += "  ·  " + makers + (" " + I18N.t(makers === 1 ? "maker" : "makers"));
    return s + (sell ? "" : "  ·  ETH gas per part");
  }
  /** The review of a frozen quote (DoorsTab.openReview, the panel's axDoReview): every part with its maker key whole. */
  function review(q, sell) {
    const ccy = ccyName(q.label);
    if (q.single) return { title: I18N.t("Review: Sell {ccy}", { ccy: ccy }), ok: I18N.t("Start swap"),
      text: I18N.t("Sell  {minima} {ccy}\nReceive  ≈ {usdt} USDT\n\nBest price {price} USDT/{ccy2}\nCounterparty\n{maker}\n\nThis locks your {ccy3} on Minima now. If the maker never locks, it is refunded by itself after the timelock. Keep the app and the node running.", { minima: q.single.minima, ccy: ccy, usdt: q.single.usdt, price: fmtPx(q.single.price), ccy2: ccy, maker: q.single.maker, ccy3: ccy }) };
    const p = q.plan, n = p.legs.length, parts = n + (" " + I18N.t(n === 1 ? "part" : "parts"));
    const L = [I18N.t("Avg {avgPrice}  ·  worst {worstPrice} USDT/{ccy}{slippagePct}", { avgPrice: fmtPx(p.avgPrice), worstPrice: fmtPx(p.worstPrice), ccy: ccy, slippagePct: (!sell && p.slippagePct > 0 ? ("  " + I18N.t("·  within {slippagePct}% slippage", { slippagePct: cut(p.slippagePct, 2) })) : "") }), ""];
    p.legs.forEach((l, i) => L.push(I18N.t("Part {i} · {minima} {ccy} @ {price} → {usdt} USDT\n  {maker}", { i: (i + 1), minima: l.minima, ccy: ccy, price: fmtPx(l.price), usdt: l.usdt, maker: l.maker })));
    L.push("", sell ? I18N.t("Total: sell {filledMinima} {ccy} · receive ≈ {totalUsdt} USDT", { filledMinima: cut(p.filledMinima), ccy: ccy, totalUsdt: cut(p.totalUsdt) }) : I18N.t("Total: pay ≈ {totalUsdt} USDT · receive ≈ {filledMinima} {ccy}", { totalUsdt: cut(p.totalUsdt), filledMinima: cut(p.filledMinima), ccy: ccy }));
    if (p.partial) L.push("", I18N.t("Fills {filledMinima} of {target} {ccy}: {slippagePct}", { filledMinima: cut(p.filledMinima), target: cut(p.target), ccy: ccy, slippagePct: (!sell && p.stopReason === "slippage" ? I18N.t("the rest is priced beyond your {slippagePct}% slippage.", { slippagePct: cut(p.slippagePct, 2) }) : I18N.t("the rest isn't available in the book right now.")) }));
    if (!sell) L.push("", I18N.t("Each part is a separate Ethereum transaction: you pay ETH gas {n}{n2}", { n: n, n2: (" " + I18N.t(n === 1 ? "time." : "times.")) }));
    L.push("", I18N.t("{ccy} Parts run one at a time. If one can't start we stop and you keep the rest; unmatched parts refund by themselves after the timelock. Keep the app and the node running.", { ccy: (sell ? I18N.t("This locks your {ccy} on Minima now.", { ccy: ccy }) : I18N.t("This locks your USDT on Ethereum now.")) }));
    return { title: sell ? I18N.t("Sell {filledMinima} {ccy} in {parts}", { filledMinima: cut(p.filledMinima), ccy: ccy, parts: parts }) : I18N.t("Buy ≈ {filledMinima} {ccy} for ≈ {totalUsdt} USDT in {parts}", { filledMinima: cut(p.filledMinima), ccy: ccy, totalUsdt: cut(p.totalUsdt), parts: parts }), text: L.join("\n"), ok: n > 1 ? I18N.t("Start sweep") : I18N.t("Start swap") };
  }
  /** What a finished axSwap call means, in the alert's three parts: what happened, were you filled, what to do. */
  /** A refusal KNOWN to come before any lock or send (main/atomix.js swapExecute, whileHeld, whileHalted; the engine's
   *  startLeg and ready()). Any other failure may have left something on a chain: a Minima `send` can time out at 180 s
   *  and still post, an Ethereum broadcast can fail after it went out. */
  const PRELOCK = /quote has expired|market was just withdrawn|maker vanished from the reviewed book|AtomiX is stopped while the wallet|AtomiX is halted|engine not booted yet|^Not ready$/;
  const prelock = (t) => PRELOCK.test(String(t == null ? "" : t).replace(/^.*?Error: /, "").replace(/^(Sweep stopped at part \d+|part \d+): /, ""));
  const UNSURE = L_("No lock was confirmed. Look at In progress before trying again.");
  function takeResult(r) {
    if (!r) return { kind: "error", text: I18N.t("The swap gave no answer. Look at Activity before trying again: a part may have been locked.") };
    if (r.err) return { kind: "error", text: mx(r.err) + (prelock(r.err) ? (" " + I18N.t("Nothing was locked.")) : " " + UNSURE) };
    const why = (r.stopped ? [r.stopped] : []).concat(r.reasons || []), all = r.ok === r.of && !why.length;
    const gas = why.some((t) => /Approving USDT/.test(t)) ? (" " + I18N.t("An approval of USDT was sent to Ethereum and costs gas.")) : "";
    return { kind: all ? "note" : "error", text: I18N.t("{ok} of {of}{of2} locked.{mx}{unsure}", { ok: r.ok, of: r.of, of2: (" " + I18N.t(r.of === 1 ? "part" : "parts")), mx: (why.length ? " " + why.map(mx).join(". ") + "." : ""), unsure: (r.ok ? (" " + I18N.t("Nothing is swapped yet: each locked part completes when its maker locks the other side, or is refunded by itself at its timelock. Follow it below or in Activity.{unsure}", { unsure: (why.length && !why.every(prelock) ? (" " + I18N.t("For the rest: {unsure}", { unsure: UNSURE })) : "") }))
        : why.length && why.every(prelock) ? (" " + I18N.t("Nothing was locked.")) : gas + " " + UNSURE) }) };
  }

  /** YOUR SWAP (DoorsTab.paintStages). rows: { state: "done"|"active"|"pending"|"warn", text }. */
  function stages(sell, ccy, connected, bals, swaps, now) {
    const gt = (v) => parseFloat(v) > 0, rows = [{ state: connected ? "done" : "warn", text: I18N.t("Node connected") }];
    if (sell) rows.push({ state: gt(bals.minima) ? "done" : "warn", text: I18N.t("{ccy} ready to sell", { ccy: ccy }) });
    else rows.push({ state: gt(bals.usdt) ? "done" : "warn", text: I18N.t("USDT ready to spend") }, { state: gt(bals.eth) ? "done" : "warn", text: I18N.t("ETH for gas") });
    let active = null, done = null, more = 0;
    for (const s of swaps || []) {
      if (!terminal(s)) { more++; if (!active || s.created > active.created) active = s; }
      else if (now - Number(s.updated) <= 30000 && (!done || s.updated > done.updated)) done = s;   // a swap that just finished stays 30 s, so it is seen to land
    }
    const sw = active || done; if (active) more--;
    if (!sw) { rows.push({ state: "pending", text: I18N.t("Enter an amount and tap Review to begin") }); return { rows, which: "", check: "", more: 0 }; }
    const st = tok(sw.selltoken), bt = tok(sw.buytoken), a = sw.status === "LOCKED" || sw.status === "CLAIMING" ? 3 : sw.status === "COMPLETE" ? 5 : 2;
    const leg = (i) => (i < a ? "done" : i === a ? "active" : "pending");
    if (sw.status === "REFUNDED") rows.push({ state: "warn", text: I18N.t("Timed out: {sellamount} {st} refunded", { sellamount: sw.sellamount, st: st }) });
    else if (sw.status === "ERROR") rows.push({ state: "warn", text: sw.inWindow ? I18N.t("Stopped with an error: see it under In progress (in ③ Exchange, History, if you hid it)") : I18N.t("Stopped with an error: see it in Activity for what happened") });
    else rows.push({ state: leg(1), text: I18N.t("Locked your {sellamount} {st}", { sellamount: sw.sellamount, st: st }) }, { state: leg(2), text: I18N.t("Counterparty locks their side") }, { state: leg(3), text: I18N.t("Claim your {buyamount} {bt}", { buyamount: sw.buyamount, bt: bt }) }, { state: leg(4), text: I18N.t("Swap complete") });
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
    if (error && s.inWindow) lines.push(I18N.t("Stopped with an error. If a lock was made it can still be refunded: this stays here, with Refund now, until its deadline has passed."));
    let refund = null;
    if (v) {
      const when = (t) => (v.blocks ? "block " + t : new Date(t * 1000).toLocaleString());
      const left = (t) => { const d = t - v.cur + 1; if (v.blocks) return v.cur ? d + (" " + I18N.t(d === 1 ? "block" : "blocks")) : I18N.t("a few blocks"); return d >= 3600 ? Math.floor(d / 3600) + "h " + Math.ceil((d % 3600) / 60) + "m" : I18N.t("{d} min", { d: Math.ceil(d / 60) }); };
      if (v.steps && v.steps.length) lines.push("✓ " + v.steps.map(mx).join(" · ✓ "));
      if (st === "STARTED" && !v.timedOut && v.cur < v.respondBy) lines.push(I18N.t("Maker must respond by {respondBy}", { respondBy: when(v.respondBy) }));
      if (v.notice) lines.push((v.notice.state === "declined" ? (I18N.t("Maker declined:") + " ") : (I18N.t("Maker is retrying:") + " ")) + mx(v.notice.reason));
      if (v.canRefund && (v.timedOut || v.cur >= v.respondBy) && !v.refundSent) lines.push(I18N.t("Refund opens {blocks}: automatic, app open or not", { blocks: when(v.refundAt + (v.blocks ? 1 : 0)) }));
      if (v.refunded) lines.push("Refunded");
      if (v.canRefund) refund = v.refundOpen ? { label: I18N.t("Refund now"), enabled: true } : { label: I18N.t("Refund now (opens in {refundAt})", { refundAt: left(v.refundAt) }), enabled: false };
    }
    if (answer) lines.push(mx(answer));
    const ids = [["swap", s.hash], ["counterparty", s.counterparty], ["swap id on Ethereum", s.contractId]].filter((x) => x[1]);
    if (v && v.refundSent) ids.push(["refund sent", v.refundSent]);
    return { hash: s.hash, live: running, terminal: terminal(s), maker, created: Number(s.created) || 0,
      title: maker ? I18N.t("AtomiX · your market filled") : s.direction === "ERC20_TO_MINIMA" ? I18N.t("AtomiX entry") : I18N.t("AtomiX exit"),
      amount: s.sellamount + " " + sell + " → " + s.buyamount + " " + buy, sub: roleLabel(s.role) + " · " + outcome,
      chip: running ? "LIVE" : complete ? "DONE" : refunded ? "REFUNDED" : "FAILED", tone: running ? "live" : complete ? "ok" : "bad", lines, refund, ids };
  }
  const HIDE_ASK = (maker) => I18N.t("This only removes the card from Swap and Activity. If any funds were locked on-chain they still refund by themselves at the timelock: hiding doesn't touch them. {maker}", { maker: (maker ? I18N.t("It stays in History with Check now and Unhide; your own lock returns by itself after its timelock.") : I18N.t("It stays in History, with Check now, Refund now and Unhide.")) });
  /** History (0.18.132): every finished swap AND every hidden one, finished or not. A hidden swap that still needs the
   *  app running or the user's attention is always reachable here, with Check now, Refund now and Unhide. */
  const historyList = (swaps, hidden) => (swaps || []).filter((x) => terminal(x) || hidden.has(x.hash)).sort((a, b) => (terminal(a) - terminal(b)) || (b.created - a.created));
  /** not finished: neither complete nor refunded (a swap in ERROR may still hold a lock) */
  const unfinished = (swaps) => (swaps || []).filter((s) => s.status !== "COMPLETE" && s.status !== "REFUNDED");
  const deadline = (s) => (!(Number(s.timelock) > 0) ? "" : s.legIsMinima ? "block " + s.timelock : new Date(Number(s.timelock) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " "));
  /** The nearest deadlines of my own locks among swaps: one per chain (a block cannot be compared with a time). */
  function nearest(swaps) {
    const m = swaps.filter((s) => s.legIsMinima && Number(s.timelock) > 0).sort((a, b) => a.timelock - b.timelock)[0], e = swaps.filter((s) => !s.legIsMinima && Number(s.timelock) > 0).sort((a, b) => a.timelock - b.timelock)[0];
    return [m ? I18N.t("{m} (Minima)", { m: deadline(m) }) : "", e ? I18N.t("{e} (Ethereum)", { e: deadline(e) }) : ""].filter(Boolean).join(" and ");
  }
  /** What a stopped node means for the swaps in the list (0.18.132, M5). swaps null: the list was never read. */
  function stoppedNote(swaps) {
    if (swaps == null) return I18N.t("Your swaps have not been read yet: if one is not finished, start the node now.");
    const u = unfinished(swaps), near = nearest(u); if (!u.length) return I18N.t("None of your swaps is unfinished.");
    return I18N.t("{u} not finished. While the node is off nothing on Minima can be claimed or refunded: a swap waiting for this node's claim LOSES that claim if the node stays off past its deadline. Start the node now.{near}", { u: u.length + (" " + I18N.t(u.length === 1 ? "swap is" : "swaps are")), near: (near ? (" " + I18N.t("Nearest deadline of your own locks: {near}.", { near: near })) : "") });
  }

  /**
   * The launch rule (DoorHost.applyLaunchRule): the room is for MxUSD; it stays in MINIMA mode with a banner while a
   * USDT ⇄ MINIMA swap or deal is in flight or the MINIMA market is live. "idle": MINIMA mode with nothing live. On
   * the phone that case switches back by itself; here the switch posts a signed withdrawal of the market, so the
   * banner offers it and the user confirms it. null: no banner (MxUSD mode, or not known yet).
   */
  function launch(currency, swaps, makerLive, otcLive) {
    if (currency !== "minima" || swaps == null || makerLive == null) return null;
    const swap = (swaps || []).some((s) => !terminal(s)) || !!otcLive, live = !!makerLive;
    // idle says only what was checked: the swaps, my levels on the book, and (when the engine reported it) my OTC availability
    if (!swap && !live) return { idle: true, text: I18N.t("AtomiX is in MINIMA mode: this room quotes USDT ⇄ MINIMA. {otcLive} Use the ⇄ pill to go back to MxUSD.", { otcLive: (otcLive == null ? I18N.t("None of your swaps there is unfinished and your MINIMA market is not on the book; OTC was not checked: look at the OTC tab.")
      : I18N.t("None of your swaps there is unfinished, your MINIMA market is not on the book and your OTC availability is off.")) }) };
    return { idle: false, text: I18N.t("Opened in MINIMA mode: {swap}. Dexicon never switches a live market by itself. Use the ⇄ pill to go back to MxUSD when you are ready.", { swap: (swap && live ? I18N.t("a USDT ⇄ MINIMA swap or OTC deal is in flight and your MINIMA market is live") : swap ? I18N.t("a USDT ⇄ MINIMA swap or OTC deal is in flight") : I18N.t("your MINIMA market is live")) }) };
  }
  /** Is my market on the book, or kept there (the maker read model and my own levels in the book)? null: unknown. */
  function makerLive(mc, book) {
    if (!mc && !book) return null;
    const mine = book ? (book.bids || []).concat(book.asks || []).some((r) => r.mine) : false, st = (mc && mc.state) || {};
    return mine && !st.withdrawn;
  }

  // ---- the maker's order editor (the panel's axWireMakerEditor; AtomiX editOrderDialog) ----
  const RUNGS = 6;
  const n0 = (v) => Number(v) || 0;
  const clampLevels = (v) => Math.max(1, Math.min(RUNGS, Math.floor(n0(v)) || 1));
  /** The prices the editor writes into the visible rungs from mid, step % and skew % (skew is held to ±20 %). */
  function ladderPrices(mid, step, bias, levels) {
    const m = n0(mid), st = n0(step), quoted = m * (1 + Math.max(-20, Math.min(20, n0(bias))) / 100), out = [];
    if (!(m > 0 && st > 0)) return out;
    for (let i = 0; i < clampLevels(levels); i++) out.push({ bid: fmtPx(quoted * (1 - (i + 1) * st / 100)), ask: fmtPx(quoted * (1 + (i + 1) * st / 100)) });
    return out;
  }
  /** A rung's size as the editor writes it from the size field: the number as typed, in plain decimals. Never six
   *  significant figures and never an exponent (0.18.133; the old panel passed the size through the price format: 1234567.89 became "1.23457e+6"). */
  const rungSize = (text) => { const t = String(text == null ? "" : text).trim(); return /^(\d+\.?\d*|\.\d+)$/.test(t) && Number(t) > 0 ? t : ""; };
  /** The OTC LP a button was drawn for (0.18.133, M6): found by its id in the board as it is NOW, and only if it still
   *  offers the sizes that were on the button's card. null: it left, or its terms changed; nothing may be sent. */
  const lpPick = (board, cid, sell, buy) => (board || []).find((x) => String(x.cid) === String(cid) && String(x.sell) === String(sell) && String(x.buy) === String(buy)) || null;
  /** What Save & publish sends, from the editor's fields. get(name) is a field's text, on(name) a switch.
   *  { withdraw: true } when Enabled is off, else { cfg, manual } exactly as the panel built them. */
  function makerForm(get, on) {
    if (!on("enabled")) return { withdraw: true };
    const rows = (side) => { const out = []; for (let i = 0; i < RUNGS; i++) out.push({ p: n0(get(side + "P" + i)), a: n0(get(side + "A" + i)) }); return out.filter((l) => l.p > 0 && l.a > 0); };
    const step = n0(get("step")), size = n0(get("size"));
    return { cfg: { pegEnable: on("peg") && step > 0 && size > 0, step, size, askSize: size, bidSize: size, bias: n0(get("bias")), reprice: n0(get("reprice")) || 1, levels: clampLevels(get("levels")), min: n0(get("min")) },
      manual: { asks: rows("ask"), bids: rows("bid") } };
  }
  /** The editor's summary of what is typed: the spread, or that the ladder is crossed. */
  function ladderSummary(manual, ccy) {
    const { asks, bids } = manual, sum = (a) => a.reduce((t, l) => t + l.a, 0);
    const ba = asks.length ? Math.min(...asks.map((l) => l.p)) : 0, bb = bids.length ? Math.max(...bids.map((l) => l.p)) : 0, both = asks.length && bids.length;
    return { crossed: !!both && bb >= ba, spread: !both ? "—" : ba - bb > 0 ? "spread " + fmtPx(ba - bb) + " · " + cut((ba - bb) / bb * 100, 1) + "%" : I18N.t("⚠ crossed"),
      warn: both && bb >= ba ? I18N.t("Crossed: best bid {bb} is at or above best ask {ba}. You would sell cheaper than you buy.", { bb: fmtPx(bb), ba: fmtPx(ba) }) : "",
      bids: bids.length ? I18N.t("{bids} lvl · best {bb} · {bids2} {ccy}", { bids: bids.length, bb: fmtPx(bb), bids2: abbrev(sum(bids)), ccy: ccy }) : "none", asks: asks.length ? I18N.t("{asks} lvl · best {ba} · {asks2} {ccy}", { asks: asks.length, ba: fmtPx(ba), asks2: abbrev(sum(asks)), ccy: ccy }) : "none" };
  }
  /** The price line above YOUR OFFER, as the phone writes it: "Parity mid 1  (bid 1 / ask 1)  ·  16s ago". Under parity
   *  the bid and the ask ARE the mid; for MEXC the engine keeps only the mid, so no bid or ask is written. */
  function midLine(source, mid, lastOk, now) {
    const age = Number(lastOk) > 0 ? Math.max(0, Math.floor((now - Number(lastOk)) / 1000)) : null;
    return I18N.t("{source} mid {mid}{mid2}{age}", { source: source, mid: fmtPx(mid), mid2: (source === "Parity" ? ("  " + I18N.t("(bid {mid} / ask {mid2})", { mid: fmtPx(mid), mid2: fmtPx(mid) })) : ""), age: (age == null ? "" : ("  " + I18N.t("·  {age} ago", { age: (age < 120 ? age + "s" : I18N.t("{age} min", { age: Math.floor(age / 60) })) }))) });
  }
  /** YOUR OFFER at a glance (MarketTab.renderMyOffer), from the maker's read model and my own levels in the book. */
  function offerState(mc, book, src) {
    const c = (mc && mc.cfg) || {}, st = (mc && mc.state) || {}, man = (mc && mc.manual) || {}, rows = [];
    for (const [side, name] of [["asks", "ASK"], ["bids", "BID"]]) for (const r of (book && book[side]) || []) if (r.mine) rows.push(name + "  " + fmtPx(r.p) + "   " + abbrev(r.cap));
    const set = c.step > 0 || (man.bids || []).length > 0 || (man.asks || []).length > 0, live = rows.length > 0 && !st.withdrawn;
    return { live, rows: live ? rows : [], text: !mc ? "…" : st.withdrawn ? I18N.t("Withdrawn: your offer is off the book, or leaving it within about a block.") : live ? I18N.t("Live{src} · kept on the book while this app and the node run.", { src: (c.pegEnable ? (" " + I18N.t("· pegged to {src}", { src: src })) : "") })
      : set ? I18N.t("Saved, not on the book. Publish puts it there.") : I18N.t("Off — edit your order, then Publish."), ago: mc && mc.lastPublishMs ? mc.lastPublishMs : 0 };
  }
  /** An OTC deal's state in words (OtcTab.dealStatus). */
  function dealStatus(d) {
    const st = String(d.status || "");
    return st === "PROPOSED" || st === "COUNTERED" ? (d.whoseTurn === "ME" ? I18N.t("Your move: accept, counter or reject") : I18N.t("Waiting for the counterparty…"))
      : st === "AGREED" ? I18N.t("Agreed: settling") : st === "EXECUTING" ? I18N.t("Executing: the swap's two sides are locking") : st === "COMPLETE" ? I18N.t("Complete") : st === "REJECTED" ? I18N.t("Rejected") : st === "EXPIRED" ? I18N.t("Expired") : st.toLowerCase();
  }
  const dealCanAct = (d) => d.whoseTurn === "ME" && (d.status === "PROPOSED" || d.status === "COUNTERED");
  /** Why an OTC offer's terms cannot be sent ("" = they can): both plain positive numbers, the amount within the LP's size. */
  function termsProblem(amount, price, cap) {
    const ok = (t) => /^[0-9]+(\.[0-9]+)?$/.test(String(t).trim()) && Number(t) > 0;
    if (!ok(amount) || !ok(price)) return I18N.t("Enter an amount and a price. Nothing was sent.");
    return cap != null && Number(amount) > Number(cap) + 1e-9 ? I18N.t("Above the LP's max size ({cap}). Nothing was sent.", { cap: cap }) : "";
  }

  /**
   * The swap history as CSV (the panel's axExportCsv, character for character): tools/dexHistory reads these column
   * NAMES. Columns may be appended, never renamed or reordered. rows = axExportSwaps().
   */
  const CSV_COLS = ["Date", "Role", "Direction", "Sold Amount", "Sold Token", "Bought Amount", "Bought Token", "Price (USDT/MINIMA)", "Counterparty", "Status", "Contract Id", "Minima Tx", "Eth Tx"];
  function csv(rows) {
    const q = (v) => { let t = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const role = (r) => { const x = roleLabel(r); return x ? x[0].toUpperCase() + x.slice(1) : ""; };
    const dir = (d) => (d === "MINIMA_TO_ERC20" ? "Sell MINIMA" : d === "ERC20_TO_MINIMA" ? "Buy MINIMA" : d || "");
    const iso = (ms) => { const n = Number(ms); return n > 0 && isFinite(n) ? new Date(n).toISOString() : ""; };
    const price = (x) => { const sell = parseFloat(x.sellAmount), buy = parseFloat(x.buyAmount); if (!(sell > 0) || !(buy > 0)) return ""; const p = x.direction === "MINIMA_TO_ERC20" ? buy / sell : x.direction === "ERC20_TO_MINIMA" ? sell / buy : 0; return p > 0 ? String(Number(p.toPrecision(8))) : ""; };
    const lines = rows.map((x) => [iso(x.created), role(x.role), dir(x.direction), x.sellAmount, tokRaw(x.sellToken), x.buyAmount, tokRaw(x.buyToken), price(x), x.counterparty, String(x.status == null ? "" : x.status).toLowerCase(), x.contractId, x.minimaTx, x.ethTx].map(q).join(","));
    return [CSV_COLS.join(",")].concat(lines).join("\r\n");
  }
  /** the panel's axTok, for the file: a token id becomes its name, anything else is written as it is */
  const tokRaw = (t) => { if (typeof t === "string" && t.indexOf("0x") === 0) { const l = t.toLowerCase(); if (l === "0x00") return "MINIMA"; if (l.indexOf("7d39745") >= 0) return "MxUSD"; } return t; };
  /** The review of a wallet send (WalletActions.review): from, amount, to and the fee, every address whole. */
  const sendReview = (asset, from, to, amt, fee) => { const sym = asset === "eth" ? "ETH" : "USDT"; return { title: I18N.t("Review: Send {sym}", { sym: sym }), ok: I18N.t("Send now"), text: I18N.t("From  {from}\n\nSend  {amt} {sym}\nTo  {to}\n\nNetwork fee  ≈ {fee} ETH\nThis cannot be undone.", { from: from, amt: amt, sym: sym, to: to, fee: fee }) }; };

  // The engine reads at most this many coins of a token before it refuses (main/atomix/lib/htlc.js guardedCoins): a maker
  // over it declines every buy until the coins are merged (AtomixConsolidate.warning).
  const COIN_CAP = { minima: 200, mxusdt: 53 };
  const coinWarn = (currency, coins) => (COIN_CAP[currency] && Number(coins) > COIN_CAP[currency] ? I18N.t("{coins} {currency} coins: AtomiX buys are being declined. Consolidate.", { coins: coins, currency: ccyName(currency) }) : "");

  /**
   * The halt card (0.18.132, M4), from the facts. h = axStatus().halt; swaps = axSwaps() rows, or null when not read.
   * Minima key orphaned: no Minima-side step under that key can be signed (a claim of coins locked to it, a refund of
   * coins it locked) until this node owns the key again; the Ethereum side still works. Ethereum wallet stale: the
   * key in use lives in memory only, so the Ethereum side works exactly as long as the app keeps running.
   * tools: [attribute, value, label]; every instruction on the card has one of them, or a button on a swap's card.
   */
  function haltCard(h, swaps) {
    const d = [], both = h.minimaMismatch && h.ethMismatch, u = unfinished(swaps);
    if (h.minimaMismatch) d.push(I18N.t("Minima identity: ORPHANED\n  in use    {orphanedPk}\n  your node does not own it", { orphanedPk: h.orphanedPk }));
    if (h.ethMismatch) d.push(I18N.t("ETH wallet: STALE\n  in use    {staleEth}\n  node now  {nodeEth}", { staleEth: h.staleEth, nodeEth: h.nodeEth }));
    const eth = h.ethMismatch ? "only while this app keeps running (the stale Ethereum key is held in memory; it is made again from the node's seed at every start and is never stored)" : "by itself";
    const stuck = u.map((s) => {
      const coin = tok(tok(s.selltoken) === "USDT" ? s.buytoken : s.selltoken), mine = tok(s.selltoken) !== "USDT", maker = s.role === "RESPONDER", dl = deadline(s);
      const text = !h.minimaMismatch ? I18N.t("Its Ethereum side settles only while this app keeps running.")
        : mine ? I18N.t("Your {sellamount} {coin} lock CANNOT be refunded under the orphaned key. If the other side claims it, the swap completes: your USDT is claimed on Ethereum {eth}.", { sellamount: s.sellamount, coin: coin, eth: eth })
        : maker ? I18N.t("The taker's {buyamount} {coin} CANNOT be claimed by this node. If the taker claims your USDT, that {coin2} is forfeited at the taker's timelock. If the taker does not, your USDT is refunded on Ethereum {eth}.", { buyamount: s.buyamount, coin: coin, coin2: coin, eth: eth })
        : I18N.t("The {buyamount} {coin} locked to you CANNOT be claimed by this node. Your USDT is refunded on Ethereum at its deadline, {eth}.", { buyamount: s.buyamount, coin: coin, eth: eth });
      return { hash: s.hash, text: text + (dl ? (" " + I18N.t("Your lock's deadline: {dl}.", { dl: dl })) : "") };
    });
    const todo = [];
    if (h.ethMismatch) todo.push(I18N.t("Do NOT quit or restart the app."), I18N.t("Export the stale ETH key now (button below) and keep it safe: only your OLD node seed could rebuild it."), I18N.t("When the swaps listed here have finished or refunded, sweep what is left to the node wallet (button below)."));
    if (h.minimaMismatch) todo.push(I18N.t("{u} Ask for help before you restore or reset anything: the desktop has no tool that brings the old key back while keeping this AtomiX store, and restoring a seed sets this store, with its claim secrets, aside.", { u: (u.length ? I18N.t("Follow each swap listed here in Activity (Check now, Refund now).") : I18N.t("Nothing of yours is waiting on the orphaned key.")) }));
    return { title: I18N.t("⛔  Wallet mismatch: AtomiX is halted"),
      which: both ? I18N.t("Both the Minima key and the Ethereum wallet no longer match this node.") : h.minimaMismatch ? I18N.t("The Minima key AtomiX saved is not one this node owns. The Ethereum wallet still matches.") : I18N.t("The Ethereum wallet in use is not the one this node derives. The Minima key still matches."),
      why: I18N.t("Trading, publishing and new swaps are stopped; the engine refuses them."),
      settles: h.minimaMismatch ? I18N.t("Still settles: the Ethereum side of each swap (claiming USDT, refunding USDT you locked), {eth}. Does NOT settle until this node owns the key again: any Minima-side step under the orphaned key.", { eth: eth })
        : I18N.t("Still settles: every Minima-side step, by itself. The Ethereum side of each swap settles {eth}.", { eth: eth }),
      details: d.join("\n\n"),
      count: swaps == null ? I18N.t("Your swaps have not been read yet.") : u.length ? I18N.t("{u} unfinished swap{u2}:", { u: u.length, u2: I18N.s(u.length) }) : I18N.t("No unfinished swap."),
      stuck, todo,
      tools: (h.ethMismatch ? [["axw", "key", I18N.t("Export the stale ETH key")], ["axw", "sweep", I18N.t("↑  Sweep funds to the node wallet")]] : []).concat(u.length ? [["axgo", "activity", I18N.t("Open Activity")]] : []) };
  }
  /** Market offline (MakerService.maybeOfflineAlert): the node is not running while a market or OTC offer was being kept on the book.
   *  The body of the card ("" = no card); its title, "Market offline", is drawn apart, so nothing is cut out of a translated sentence. */
  const offline = (nodeRunning, wasLive, swaps) => (!nodeRunning && wasLive ? I18N.t("Your Minima node isn't running, so your published AtomiX market drops off the book and nobody can trade with you. You were not filled by this. {swaps} Once the node runs, your market is published again by itself.", { swaps: stoppedNote(swaps) }) : "");

  // ======================================================================== Act: the money actions, no DOM
  // ui = { confirm(title, text, okLabel) → Promise<bool>, say(text, kind) }. Every function here makes the SAME
  // window.mcd calls, with the same arguments, behind the same guards, in the same order, as renderer/atomix-ui.js.
  const fail = (e) => ({ err: String((e && e.message) || e) });
  const refused = (e) => /AtomiX is halted|AtomiX is stopped while the wallet/.test(String(e));   // the glue refused before anything was saved or sent
  const RETRY = " While it runs, AtomiX publishes the saved order again by itself: at the next reprice, or within 30 minutes.";
  const Act = {
    /** axQuote (freeze) → review → axSwap(the frozen quote's id). */
    async take(api, ui, sell, amt, slip, ccy) {
      if (!amt) { ui.say(I18N.t("Enter how much {ccy} to {sell}. Nothing was sent.", { ccy: (ccy || "MxUSD"), sell: (sell ? "sell" : "buy") }), "note"); return null; }
      const q = await api.axQuote(sell, amt, slip).catch(fail);
      if (q.err) { ui.say(I18N.t("{err} Nothing was sent.", { err: mx(q.err) }), "note"); return null; }
      const r = review(q, sell);
      if (!await ui.confirm(r.title, r.text, r.ok)) return null;
      const res = await api.axSwap(q.quoteId).catch(fail), t = takeResult(res);
      ui.say(t.text, t.kind);
      return res;
    },
    /** confirm → axSwitchCurrency(the other market's key). `cur` is read ONCE. */
    async switchCurrency(api, ui, cur) {
      const key = cur === "minima" ? "mxusdt" : "minima", to = key === "mxusdt" ? "MxUSD" : "MINIMA";
      if (!await ui.confirm(I18N.t("Switch to {to}?", { to: to }), I18N.t("Your live market on the current book is withdrawn first, then AtomiX moves to the {to} book. Any in-flight swap still settles.", { to: to }), I18N.t("Switch to {to}", { to: to }))) return null;
      const r = await api.axSwitchCurrency(key).catch(fail);
      if (r && r.err) ui.say(I18N.t("The market was not switched: {err}", { err: mx(r.err) }), "error");
      return r;
    },
    /** Publish: the saved order as it is (axMakerPublish). */
    async makerPublish(api, ui) {
      const r = await api.axMakerPublish().catch(fail);
      ui.say(r && r.err ? (refused(r.err) ? I18N.t("Your market was NOT published: {err}", { err: mx(r.err) }) : I18N.t("Your market is NOT on the book yet: {err}. What was on the book before is unchanged.{retry}", { err: mx(r.err), retry: RETRY })) : I18N.t("Your market was sent to the book. Nothing is traded yet: it trades when someone takes a level, and this app answers by itself while it runs."), r && r.err ? "error" : "note");
      return r;
    },
    /** Save & publish: Enabled off withdraws (axMakerWithdraw); else axMakerSave(cfg, manual). form = makerForm(…). */
    async makerSave(api, ui, form) {
      if (form.withdraw) { const r = await api.axMakerWithdraw().catch(fail); ui.say(r && r.err ? I18N.t("Your market was NOT withdrawn: {err}. It may still be on the book.", { err: mx(r.err) }) : I18N.t("Market withdrawn: your offer leaves the book within about a block. A take already in flight still settles."), r && r.err ? "error" : "note"); return r; }
      const r = await api.axMakerSave(form.cfg, form.manual).catch(fail);
      ui.say(r && r.err ? (refused(r.err) ? I18N.t("Your order was NOT saved and NOT published: {err}", { err: mx(r.err) }) : I18N.t("Your order was SAVED but is not on the book yet: {err}.{retry} To stop that, withdraw the market.", { err: mx(r.err), retry: RETRY })) : I18N.t("Your order was saved and sent to the book. Nothing is traded yet: it trades when someone takes a level."), r && r.err ? "error" : "note");
      return r;
    },
    async makerWithdraw(api, ui) {
      if (!await ui.confirm(I18N.t("Withdraw your market?"), I18N.t("Your order is tombstoned so peers stop trading against it."), "Withdraw")) return null;
      const r = await api.axMakerWithdraw().catch(fail);
      ui.say(r && r.err ? I18N.t("Your market was NOT withdrawn: {err}. It may still be on the book.", { err: mx(r.err) }) : I18N.t("Market withdrawn: your offer leaves the book within about a block. A take already in flight still settles."), r && r.err ? "error" : "note");
      return r;
    },
    // ---- OTC: the panel's four calls. side is the LP's side: "SELL" = the LP sells (you buy), "BUY" = the LP buys (you sell) ----
    async otcGoLive(api, ui, sell, buy) {
      const r = await api.axOtcGoLive(sell, buy).catch(fail);
      ui.say(r && r.err ? I18N.t("Your availability was NOT published: {err}", { err: mx(r.err) }) : I18N.t("Your availability was published: other people can now propose deals to you. Nothing is traded until you accept one."), r && r.err ? "error" : "note");
      return r;
    },
    async otcWithdraw(api, ui) {
      const r = await api.axOtcWithdraw().catch(fail);
      ui.say(r && r.err ? I18N.t("Your availability may still be on the board: {err}", { err: mx(r.err) }) : r && r.posted === false ? I18N.t("Your availability is switched off in this app. Nothing was posted to the board, because AtomiX is halted: an entry already on the board ages out by itself, and no proposal is answered meanwhile.") : I18N.t("Availability withdrawn. A deal already agreed still settles."), r && r.err || (r && r.posted === false) ? "error" : "note");
      return r;
    },
    async otcPropose(api, ui, lp, side, amount, price) {
      side = String(side || "").trim().toUpperCase();
      if (side !== "SELL" && side !== "BUY") { ui.say(I18N.t("Side must be SELL or BUY. Nothing was sent."), "note"); return null; }
      if (!amount || !price) return null;
      const r = await api.axOtcPropose({ cid: lp.cid, mpk: lp.mpk, eth: lp.eth }, side, amount, price).catch(fail);
      ui.say(r && r.err ? I18N.t("Your offer was NOT sent: {err}", { err: mx(r.err) }) : I18N.t("Offer sent. Nothing is locked: the LP can accept, counter or reject it, and you will see it under My deals."), r && r.err ? "error" : "note");
      return r;
    },
    /** accept / reject: axOtcDeal(ref, action). counter: axOtcDeal(ref, "counter", amount, price). */
    async otcDeal(api, ui, ref, action, amount, price) {
      const r = await (action === "counter" ? api.axOtcDeal(ref, "counter", amount, price) : api.axOtcDeal(ref, action)).catch(fail);
      if (r && r.err) ui.say((action === "accept" ? (I18N.t("The deal was NOT accepted:") + " ") : action === "reject" ? (I18N.t("The deal may not be rejected yet:") + " ") : (I18N.t("Your counter-offer was NOT sent:") + " ")) + mx(r.err), "error");
      else ui.say(action === "accept" ? I18N.t("Accepted. The deal now settles as an ordinary AtomiX swap: follow it in Activity. If the other side never locks, your lock is refunded by itself at its timelock.") : action === "reject" ? I18N.t("Rejected. Nothing was locked.") : I18N.t("Counter-offer sent. Nothing is locked until one side accepts."), "note");
      return r;
    },
    // ---- the Ethereum wallet: axSendReview (the engine's checks and the fee) → review → axSend ----
    /** { err } to show in the dialog, or { fee }. */
    async sendCheck(api, asset, to, amt) { const r = await api.axSendReview(asset, to, amt).catch(fail); return r && r.err ? { err: mx(r.err) } : r; },
    async sendGo(api, ui, asset, from, to, amt, fee) {
      const rv = sendReview(asset, from, to, amt, fee);
      if (!await ui.confirm(rv.title, rv.text, rv.ok)) return null;
      const r = await api.axSend(asset, to, amt).catch(fail), sym = asset === "eth" ? "ETH" : "USDT";
      if (r && r.err) ui.say(I18N.t("The send of {amt} {sym} was not confirmed as sent: {err}. Look at this address on an Ethereum explorer before sending again: a transaction may have gone out.", { amt: amt, sym: sym, err: mx(r.err) }), "error");
      else ui.say(I18N.t("Sent {amt} {sym}. It is final once Ethereum confirms it. Transaction {tx}", { amt: amt, sym: sym, tx: (r && r.tx) }), "note");
      return r;
    },
    /** every swap, maker and taker, to one file: axExportSwaps → exportCsv(text, "atomix-trades.csv") */
    async exportCsv(api, ui) {
      const rows = await api.axExportSwaps().catch(() => []);
      if (!rows.length) { ui.say(I18N.t("There are no swaps to export. No file was written."), "note"); return null; }
      const path = await api.exportCsv(csv(rows), "atomix-trades.csv").catch(() => null);
      ui.say(path ? I18N.t("Saved {rows} swaps.", { rows: rows.length }) : I18N.t("Export cancelled. No file was written."), "note");
      return path;
    },
    async refundNow(api, ui, hash) { const r = await api.axRefundNow(hash).catch((e) => ({ msg: I18N.t("Refund check failed: {e}", { e: ((e && e.message) || e) }) })); return mx(r.msg); },
    async inspect(api, hash) { return (await api.axInspect(hash).catch((e) => [I18N.t("Check failed: {e}", { e: ((e && e.message) || e) })])).map(mx); }
  };

  /** One at a time (0.18.118): while fn runs, a second call does nothing. For the money actions that had no
   *  in-flight state of their own: a double click on Refund now or on a wallet action started it twice. */
  function oneAtATime() { let on = false; return async (fn) => { if (on) return; on = true; try { return await fn(); } finally { on = false; } }; }
  const core = { oneAtATime, MXUSD, ccyName, ccyOf, mx, tok, fmtPx, abbrev, cut, ax6, cleanNum, coinAmount, slipOf, roleLabel, terminal, bestLine, review, takeResult, prelock, stages, swapItem, HIDE_ASK, launch, makerLive, historyList, unfinished, stoppedNote, RUNGS, clampLevels, ladderPrices, rungSize, lpPick, makerForm, ladderSummary, midLine, offerState, COIN_CAP, coinWarn, dealStatus, dealCanAct, termsProblem, CSV_COLS, csv, sendReview, haltCard, offline };
  if (typeof document === "undefined") return Object.assign({ Act }, core);

  // ======================================================================== the screens
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; };
  let D = null;   // deps from app.js: api, copy, dialog, running(), consolidateToken, exportKey() (ETH Wallet's gated key dialog), go(tab), repaintStrip()
  const S = { st: { ready: false }, book: null, swaps: null, bals: null, mc: null, mh: null, otc: null, sell: false, typed: null, said: null, answers: {}, at: 0, tab: "", busy: false,
    slip: slipOf(pref("dexicon_ax_slip")) || 4.2, hidden: new Set((pref("dexicon_ax_hidden") || "").split(",").filter(Boolean)) };
  const api = () => D.api;
  const ccy = () => ccyOf(S.st), halted = () => !!(S.st && S.st.halt);
  /** is the screen on show one of the shared ones (Activity, Assets, Settings, History), which dexicon-ui.js draws? */
  const onShared = () => { const w = D.where(); return w.shared; };
  const say = (text, kind) => { if (onShared()) return D.say(text, kind || "error"); S.said = text ? { text, kind: kind || "error" } : null; paint(); };
  const ui = { confirm: (title, text, ok) => D.dialog(title, text, ok), say };
  const body = () => $("dxAxBody");
  const visible = (tab) => { const b = body(); return !!b && b.dataset.tab === (tab || S.tab) && $("shell").dataset.mode === "dex" && b.offsetParent !== null; };
  const typing = () => { const a = document.activeElement, b = body(); return !!(a && b && b.contains(a) && a.tagName === "INPUT"); };

  /** A dialog with its own fields. onOk(dialog) returns a string to refuse (shown, the dialog stays) or nothing. */
  function form(title, html, okLabel, onOk, wire) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"); d.className = "dx-dlg ax-dlg"; d.dataset.axccy = S.st.currency || "";
      d.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="ax-bad" role="alert"></div><div class="dx-dlg__b"><button class="dx-btn" data-x="0">${th("Close")}</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
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
    if (!S.st.ready) return;
    if (!D.running()) { const sw = await api().axSwaps().catch(() => null); if (sw) S.swaps = sw; return; }   // the engine's own store: what is unfinished is known with the node off
    const want = { swaps: () => api().axSwaps() };
    if (tab !== "shared") { want.book = () => api().axBook(); want.mc = () => api().axMakerCfg(); }   // a book scan is slow: only where a book is shown
    if (tab === "market" || tab === "shared") want.mh = () => api().axMarketHistory();
    if (tab === "otc") want.otc = () => api().axOtc();
    const keys = Object.keys(want), got = await Promise.allSettled(keys.map((k) => want[k]()));
    keys.forEach((k, i) => { if (got[i].status === "fulfilled") S[k] = got[i].value; });
    const ml = makerLive(S.mc, S.book); if (tab !== "shared" && ml != null) pref("dexicon_ax_market_live", ml || (S.otc && S.otc.myOffer && S.otc.myOffer.enable) ? "1" : "0");
    api().axWallet().then((w) => { if (w) { S.wallet = w; S.bals = w.bals; paint(); } }).catch(() => {});
  }
  function onUpdate() { if (S.upd || !D) return; S.upd = setTimeout(() => { S.upd = null; if (onShared() && D.where().shown) load("shared").then(paint, paint); else if (visible()) load(S.tab).then(paint, paint); else api().axStatus().then((s) => { if (s) { S.st = s; D.repaintStrip(); } }).catch(() => {}); }, 400); }
  function reset() { Object.assign(S, { st: { ready: false }, book: null, swaps: null, bals: null, wallet: null, mc: null, mh: null, otc: null, typed: null, said: null, answers: {}, at: 0 }); const b = body(); if (b) { b.innerHTML = ""; delete b.dataset.tab; } }

  // ---- what stands above every screen of the room ----
  function banners() {
    const out = [];
    const off = offline(D.running(), pref("dexicon_ax_market_live") === "1", S.swaps);
    if (off) out.push(`<div class="dx-card ax-alert" role="alert"><b class="ax-t14">${th("Market offline")}</b><div class="ax-dim">${esc(off)}</div><button class="dx-btn ax-btn--s" data-axstart="1">${th("Start the node")}</button></div>`);
    else if (!D.running()) out.push(`<div class="dx-state" role="status">${tr("The node is stopped, so nothing here can trade and nothing can settle. {swaps}", { swaps: esc(stoppedNote(S.swaps)) })}</div>`);
    if (halted()) out.push(haltHtml());
    else if (!S.st.ready && S.st.error) out.push(`<div class="dx-state dx-state--error" role="alert">${esc(DexCore.storeError("AtomiX", "swap store", S.st.error, AX_AFTER))} <button class="dx-btn ax-btn--s" data-axaside="1"${DexCore.gate.on ? " disabled" : ""}>${th("Set the store aside and start empty")}</button></div>`);
    else if (!S.st.ready) out.push(`<div class="dx-card ax-big"><b class="ax-t14">${th("Setting up AtomiX…")}</b><div class="ax-dim">${th("Preparing your Ethereum wallet and swap keys on this node, then reading the market. The first start takes a minute or two.")}</div></div>`);
    const l = S.st.ready ? launch(S.st.currency, S.swaps, makerLive(S.mc, S.book), S.st.otcOffer == null ? null : !!S.st.otcOffer || !!(S.otc && S.otc.deals && S.otc.deals.length)) : null;
    if (l) out.push(`<div class="ax-launch" role="status">${esc(l.text)}</div>`);
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  const AX_AFTER = L_("A swap that was unfinished is recorded in that file, with what claims or refunds it: keep the file, and this app will not finish that swap from the empty store.");
  /** The store that cannot be opened is moved aside (main: mcd:engineSetAside, refused unless the engine's last start failed). */
  async function setAside() {
    if (!await D.dialog(I18N.t("Set the swap store aside?"), DexCore.SET_ASIDE("AtomiX", AX_AFTER, S.st.store), I18N.t("Set it aside"))) return;
    const r = await api().engineSetAside("atomix").then((kept) => ({ kept }), fail);
    say(r.err ? I18N.t("The swap store was not set aside: {err}. Nothing was changed.", { err: r.err }) : I18N.t("The swap store was set aside{kept}. AtomiX is starting with an empty store.{kept2}", { kept: (r.kept ? (" " + I18N.t("and is kept as {kept}", { kept: r.kept })) : ""), kept2: (r.kept ? " " + DexCore.PUT_BACK(S.st.store, r.kept) : "") }), r.err ? "error" : "note");
  }
  function haltHtml() {
    const h = haltCard(S.st.halt, S.swaps);
    return `<div class="dx-card ax-big ax-halt" role="alert"><b class="ax-halt__t">${esc(h.title)}</b><div class="ax-dim">${esc(h.which)} ${esc(h.why)}</div><pre class="ax-halt__d" data-copy="${esc(h.details)}" title="${th("Click to copy the recovery details")}">${esc(h.details)}</pre>`
      + `<div class="ax-line">${esc(h.settles)}</div><div class="ax-bad">${esc(h.count)}</div>` + h.stuck.map((x) => idLine("swap", x.hash) + `<div class="ax-line">${esc(x.text)}</div>`).join("")
      + h.todo.map((t) => `<div class="ax-bad">${esc(t)}</div>`).join("") + h.tools.map((t) => `<button class="dx-btn ax-rescue" data-${t[0]}="${t[1]}">${esc(t[2])}</button>`).join("") + `</div>`;
  }
  /** An explainer card. Market and OTC open theirs until it is folded, as the phone shows them (the wide captures of 19 Nov); Swap's stays folded until opened. */
  const whyOpen = (key) => { const v = pref("dexicon_fold_" + key); return v === "1" || (v == null && key !== "swap"); };
  const why = (key, title, text) => { const open = whyOpen(key); return `<button class="ax-why${open ? " ax-why--open" : ""}" data-axwhy="${key}" aria-expanded="${open}"><span class="dx-label">${esc(title)} ${open ? "▾" : "▸"}</span>${open ? `<span class="ax-why__t">${esc(text)}</span>` : ""}</button>`; };
  const idLine = (label, value) => `<div class="dx-id" data-copy="${esc(value)}" title="${th("Click to copy")}">${esc(label)} ${esc(value)}</div>`;

  /** A swap's card: the same one on Swap (IN PROGRESS), in Activity and in History. */
  function swapCard(s, hideable, unhide) {
    const it = swapItem(s, S.answers[s.hash]);
    return `<div class="dx-card ax-swap"><div class="dx-row"><b class="ax-t13">${esc(it.title)}</b><span class="dx-row"><span class="dx-chip" data-tone="${it.tone}">${it.chip}</span>${hideable ? `<button class="ax-x" data-axhide="${esc(it.hash)}" aria-label="${th("Hide this swap's card")}">✕</button>` : ""}</span></div>`
      + `<div class="ax-amt">${esc(it.amount)}</div><div class="ax-dim">${esc(D.relTime ? D.relTime(it.created) + " · " : "")}${esc(it.sub)}</div>`
      + it.lines.map((l) => `<div class="ax-line">${esc(l)}</div>`).join("") + it.ids.map((x) => idLine(x[0], x[1])).join("")
      + `<div class="ax-acts"><button class="dx-btn" data-axcheck="${esc(it.hash)}">${th("Check now")}</button>${unhide ? `<button class="dx-btn" data-axunhide="${esc(it.hash)}">${th("Unhide")}</button>` : ""}${it.refund ? `<button class="dx-btn${it.refund.enabled ? " dx-btn--go" : ""}" data-axrefund="${esc(it.hash)}"${it.refund.enabled ? "" : " disabled"}>${esc(it.refund.label)}</button>` : ""}</div></div>`;
  }
  async function checkNow(hash) {
    const lines = await Act.inspect(api(), hash);
    if (await D.dialog(I18N.t("Swap status"), I18N.t("{lines}\n\nSwap {hash}", { lines: lines.join("\n\n"), hash: hash }), I18N.t("Check again"))) checkNow(hash);
  }
  async function hide(hash) {
    const s = (S.swaps || []).find((x) => x.hash === hash); if (!s) return;
    if (!terminal(s) && !await D.dialog(I18N.t("Hide this swap?"), HIDE_ASK(s.role === "RESPONDER"), I18N.t("Hide"))) return;
    S.hidden.add(hash); pref("dexicon_ax_hidden", [...S.hidden].slice(-400).join(",")); paint();
  }

  // ---- Swap (DoorsTab.java) ----
  const WHY_SWAP = L_("Dexicon's exchange (③) trades MINIMA against MxUSD, Minima's own dollar. If your dollars are USDT on Ethereum, buy MxUSD with them here first; sell MxUSD here to turn it back into USDT. Both sides lock their funds in a time-locked contract; if anything stalls, you are refunded automatically. Already hold MxUSD? Go straight to ③. Just swapping? You can stop here. Your Ethereum wallet (the USDT you swap from and to) is in Assets.");
  function swapSkeleton() {
    return `<div id="axTop"></div><div id="axWhy"></div>
      <h2 class="ax-h2" id="axHead"></h2><div class="ax-sub">${th("Enter an amount and see exactly what you'll get at the best price.")}</div>
      <div class="ax-side" role="group" aria-label="${th("Direction")}"><button id="axSellB"></button><button id="axBuyB"></button></div>
      <div class="dx-card ax-big" id="axEmpty" hidden><b class="ax-t14" id="axEmptyT"></b><div class="ax-dim">${th("Check back soon, or open Market to place your own order and wait for a match.")}</div><button class="dx-btn ax-btn--s" data-axgo="market">${th("Open Market")}</button></div>
      <div class="dx-card ax-big" id="axCard" hidden>
        <div class="ax-fl">${th("YOU SEND")}</div>
        <div class="ax-amtrow"><div class="ax-chip" id="axSendChip"></div><input class="ax-bigin" id="axSend" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.00" aria-label="${th("You send")}"></div>
        <div class="ax-flip"><i></i><button id="axFlip" aria-label="${th("Flip: swap the other way")}">⇅</button><i></i></div>
        <div class="ax-fl">${th("YOU RECEIVE (estimate)")}</div>
        <div class="ax-amtrow"><div class="ax-chip" id="axRecvChip"></div><input class="ax-bigin ax-bigin--recv" id="axRecv" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.00" aria-label="${th("You receive, an estimate")}"></div>
        <div class="ax-best" id="axBest"></div>
        <div class="ax-slip" id="axSlip"></div>
        <div class="ax-plan" id="axPlan" role="status"></div>
        <button class="ax-cta" id="axReview">${th("Review swap")}</button>
      </div>
      <div class="ax-stages" id="axStages"></div>
      <div class="dx-label ax-prog" id="axProgL" hidden>${th("IN PROGRESS")}</div><div id="axList"></div>
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
      plan.textContent = !p ? I18N.t("1 part · {price} USDT/{ccy}\nYou receive ≈ {usdt} USDT", { price: fmtPx(pv.single.price), ccy: ccy(), usdt: pv.single.usdt })
        : I18N.t("{legs} · avg {avgPrice} · worst {worstPrice} USDT/{ccy}{ccy2}{slippagePct}", { legs: p.legs.length + (" " + I18N.t(p.legs.length === 1 ? "part" : "parts")), avgPrice: fmtPx(p.avgPrice), worstPrice: fmtPx(p.worstPrice), ccy: ccy(), ccy2: (sell ? ("\n" + I18N.t("You receive ≈ {totalUsdt} USDT", { totalUsdt: cut(p.totalUsdt) })) : ("\n" + I18N.t("You pay ≈ {totalUsdt} USDT for {filledMinima} {ccy}", { totalUsdt: cut(p.totalUsdt), filledMinima: cut(p.filledMinima), ccy: ccy() }))), slippagePct: (p.partial ? ("\n" + I18N.t("PARTIAL: fills {filledMinima} of {target} {ccy}{slippagePct}", { filledMinima: cut(p.filledMinima), target: cut(p.target), ccy: ccy(), slippagePct: (!sell && p.stopReason === "slippage" ? I18N.t(": the rest is priced beyond your {slippagePct}% slippage.", { slippagePct: cut(p.slippagePct, 2) }) : I18N.t(": the rest isn't in the book right now.")) })) : "") });
    }, 250);
  }
  function bindSwap() {
    $("axSellB").onclick = () => setSide(true); $("axBuyB").onclick = () => setSide(false); $("axFlip").onclick = () => setSide(!S.sell);
    for (const [id, name] of [["axSend", "send"], ["axRecv", "recv"]]) $(id).oninput = () => { S.typed = $(id).value ? name : null; S.said = null; mirror(); if (!$(id).value) { $("axPlan").textContent = ""; } preview(); paintReview(); };
    $("axReview").onclick = () => D.money(async () => {
      if (halted()) return say(I18N.t("Halted: this node no longer owns the keys AtomiX uses here. Nothing was sent."), "error");
      const r = await busyWhile(true, () => { paintReview(); return Act.take(api(), ui, S.sell, amount(), S.slip, ccy()); });
      if (r && !r.err) { S.typed = null; $("axSend").value = ""; $("axRecv").value = ""; $("axPlan").textContent = ""; }
      load("swap").then(paint, paint);
    });
  }
  /** The label a button shows while its action runs. Not a gate: every money action is behind D.money (DexCore.money). */
  const busyWhile = async (label, fn) => { S.busy = label; try { return await fn(); } finally { S.busy = false; } };
  const paintReview = () => { const b = $("axReview"); if (b) { b.disabled = S.busy || halted(); b.dataset.dim = amount() ? "0" : "1"; b.textContent = S.busy ? I18N.t("Starting…") : I18N.t("Review swap"); } };
  function paintSwap() {
    const c = ccy(), b = S.book || {}, p = price(), ready = D.running() && S.st.ready, bals = S.bals || { minima: "—", usdt: "—", eth: "—" };
    $("axTop").innerHTML = banners(); $("axWhy").innerHTML = why("swap", I18N.t("WHY THIS STEP"), WHY_SWAP);
    $("axHead").textContent = I18N.t("Swap {c} ⇄ USDT", { c: c });
    $("axSellB").textContent = I18N.t("Sell {c}", { c: c }); $("axBuyB").textContent = I18N.t("Buy {c}", { c: c });
    $("axSellB").setAttribute("aria-pressed", S.sell); $("axBuyB").setAttribute("aria-pressed", !S.sell);
    $("axEmpty").hidden = !(ready && S.book && !(p > 0)); $("axCard").hidden = !(ready && p > 0);
    $("axEmptyT").textContent = I18N.t("No one is quoting a {sell} price right now.", { sell: (S.sell ? "buy" : "sell") });
    const chip = (coin) => `<span class="ax-disc${coin ? "" : " ax-disc--usdt"}">${coin ? "M" : "$"}</span><span><b>${esc(coin ? c : "USDT")}</b><small>${tr("avail {usdt}", { usdt: esc(coin ? bals.minima : bals.usdt) })}</small></span>`;
    $("axSendChip").innerHTML = chip(S.sell); $("axRecvChip").innerHTML = chip(!S.sell);
    if (!typing()) mirror();
    if (!amount()) $("axBest").textContent = bestLine(S.sell, p, S.sell ? b.bidCap : b.askCap, c, null, b.makers);
    const custom = S.slip !== 2 && S.slip !== 4.2;
    $("axSlip").hidden = S.sell;
    $("axSlip").innerHTML = `<span>${th("Max slippage")}</span>${[2, 4.2].map((s) => `<button data-axslip="${s}" aria-pressed="${S.slip === s}">${s}%</button>`).join("")}<button data-axslip="custom" aria-pressed="${custom}">${custom ? S.slip + "%" : th("Custom")}</button>`;
    paintReview();
    const stg = stages(S.sell, c, D.running() && S.st.ready, bals, S.swaps, Date.now());
    $("axStages").innerHTML = `<div class="ax-fl">${th("YOUR SWAP")}</div>` + stg.rows.slice(0, S.sell ? 2 : 3).map(stageRow).join("") + (stg.which ? `<div class="ax-which">${esc(stg.which)}</div>` : "") + stg.rows.slice(S.sell ? 2 : 3).map(stageRow).join("")
      + (stg.check ? `<button class="dx-btn ax-btn--s" data-axcheck="${esc(stg.check)}">${th("Check now")}</button>` : "") + (stg.more > 0 ? `<button class="ax-more" data-axgo="activity">${tr("+ {more} more swap{more2} in flight: see Activity", { more: stg.more, more2: I18N.s(stg.more) })}</button>` : "");
    const live = (S.swaps || []).filter((s) => !terminal(s) && !S.hidden.has(s.hash));
    $("axProgL").hidden = !live.length; $("axList").innerHTML = live.map((s) => swapCard(s, true)).join("");
    $("axFin").textContent = S.swaps && !S.swaps.length ? I18N.t("No AtomiX swaps yet. Buy {c} brings ERC20 USDT in; Sell {c2} takes it back out as USDT.", { c: c, c2: c }) : S.swaps ? I18N.t("Every swap, finished or not, is in Activity ›") : "";
  }
  const stageRow = (r) => `<div class="ax-stage" data-state="${r.state}"><i></i><span>${esc(r.text)}</span></div>`;
  async function customSlip() {
    const v = await D.dialog(I18N.t("Max slippage"), I18N.t("The most above the best price you'll pay per {ccy} when a buy fills across deeper levels (0.1 to 50 %).", { ccy: ccy() }), I18N.t("Set"), { label: I18N.t("Max slippage, percent"), value: String(S.slip) });
    if (v == null) return;
    const n = slipOf(v); if (n == null) return say(I18N.t("Enter a percent between 0.1 and 50. The slippage was not changed."), "note");
    S.slip = n; pref("dexicon_ax_slip", String(n)); paint(); preview();
  }

  // ---- Market (MarketTab.java) ----
  const WHY_MARKET = L_("Here you are the maker: publish a ladder of prices at which you sell and buy the active coin against ERC20 USDT. Takers lock their side first; this app answers automatically while it is running, so keep it open and the node online. Peg the ladder to the live price and it reprices itself; if the price feed fails, it is withdrawn for safety. Withdraw takes your offer off the book in about a block. One market at a time: the ⇄ pill switches it.");
  const src = () => ((S.book ? S.book.pricingParity : S.st.currency === "mxusdt") ? "Parity" : "MEXC");
  const agoMin = (ms) => { const m = Math.floor(Math.max(0, Date.now() - Number(ms)) / 60000); return m < 1 ? I18N.t("less than a minute ago") : I18N.t("{m} min ago", { m: m }); };
  function half(row, bid) {
    if (!row) return `<div class="ax-half${bid ? " ax-half--bid" : ""}"><span class="ax-q"><span class="ax-sz">—</span></span></div>`;
    const take = !row.mine && row.cap > 0, q = bid ? `<span class="ax-sz">${abbrev(row.cap)}</span><span class="ax-px">${fmtPx(row.p)}</span>` : `<span class="ax-px">${fmtPx(row.p)}</span><span class="ax-sz">${abbrev(row.cap)}</span>`;
    const tag = row.mine ? `<span class="ax-tag ax-tag--you">you</span>` : `<span class="ax-tag" data-copy="${esc(row.signer)}" title="${th("Maker key. Click to copy")}">${esc(row.signer)}</span>`;
    return `<div class="ax-half${bid ? " ax-half--bid" : ""}">${take ? `<button class="ax-q" data-axtake="${bid ? "bid" : "ask"}" aria-label="${tr("{bid}{ccy} at {p} USDT", { bid: bid ? (th("Sell") + " ") : (th("Buy") + " "), ccy: esc(ccy()), p: fmtPx(row.p) })}">${q}</button>` : `<span class="ax-q">${q}</span>`}${tag}</div>`;
  }
  function marketHtml() {
    const c = ccy(), b = S.book, mc = S.mc, o = offerState(mc, b, src()), mid = mc && mc.state && (mc.state.lastMid || mc.state.lastPrice), warn = coinWarn(S.st.currency, S.bals && S.bals.meta && S.bals.meta.coins);
    const out = [banners(), why("market", I18N.t("YOUR AtomiX MARKET"), WHY_MARKET)];
    if (!D.running() || !S.st.ready) return out.join("");
    out.push(`<div class="ax-sub ax-sub--tight">${tr("The live USDT ⇄ {c} order book. Tap a level to take it, use the Swap page, or publish your own offer.", { c: esc(c) })}</div>`);
    if (mid > 0) out.push(`<div class="ax-mono11">${esc(midLine(src(), mid, mc.state.lastOk, Date.now()))}</div>`);
    if (warn) out.push(`<button class="ax-warnpill" data-axgo="assets">${esc(warn)}</button>`);
    out.push(`<div class="dx-card"><div class="dx-label">${tr("YOUR OFFER · USDT ⇄ {c}", { c: esc(c) })}</div><div class="ax-offer" data-live="${o.live}">${esc(o.text)}</div>${o.rows.length ? `<pre class="ax-mono11">${esc(o.rows.join("\n"))}\n(USDT per ${esc(c)})</pre>` : ""}${o.ago ? `<div class="ax-line">${tr("Last publish {ago}", { ago: agoMin(o.ago) })}</div>` : ""}</div>`);
    out.push(`<div class="dx-row ax-obh"><b class="ax-t16">${tr("Order book  ·  {scanned} live", { scanned: b ? b.scanned || 0 : "…" })}</b><button class="dx-pill ax-refresh" data-axrefresh="1">${th("Refresh")}</button></div>`);
    if (!b || (!b.bids.length && !b.asks.length)) out.push(`<div class="ax-dim">${b ? th("No live orders yet. Publish one, or wait for a counterparty.") : th("Reading the book…")}</div>`);
    else {
      if (b.bestBid && b.bestAsk) out.push(`<div class="ax-spread">${tr("spread {bestBid} USDT  ·  USDT per {c}, size in {c2}", { bestBid: fmtPx(b.bestAsk - b.bestBid), c: esc(c), c2: esc(c) })}</div>`);
      out.push(`<div class="ax-legend"><span>${tr("SELL {c} (bid)", { c: esc(c) })}</span><span>${tr("BUY {c} (ask)", { c: esc(c) })}</span></div>`);
      for (let i = 0, n = Math.min(Math.max(b.bids.length, b.asks.length), 12); i < n; i++) out.push(`<div class="ax-depth${i === 0 ? " ax-depth--best" : ""}">${half(b.bids[i], true)}<span class="ax-div">│</span>${half(b.asks[i], false)}</div>`);
    }
    out.push(`<div class="ax-mbtns"><button class="dx-btn" data-axmk="edit">${th("Edit my order")}</button><button class="dx-btn ax-go" data-axmk="publish"${S.busy || halted() ? " disabled" : ""}>${S.busy === "publish" ? th("Publishing…") : th("Publish")}</button><button class="dx-btn" data-axmk="withdraw"${S.busy ? " disabled" : ""}>${S.busy === "withdraw" ? th("Withdrawing…") : th("Withdraw")}</button></div>`);
    const mh = S.mh || { chart: [], recent: [] }; let ex = 0, op = 0; (mh.recent || []).forEach((t) => { if (t.status === "EXECUTED") ex++; else if (t.status === "OPEN") op++; });
    out.push(`<div class="dx-card ax-chartcard"><div class="dx-label">${th("MARKET HISTORY · PRICE ONLY")}</div><canvas id="axChart" class="ax-chart"></canvas><div class="ax-line">${tr("last {price} · {ex} filled · {op} open. Every swap this node saw on the book, no back-fill. The list is in Activity › Market history.", { price: mh.chart.length ? fmtPx(mh.chart[mh.chart.length - 1].price) : "—", ex: ex, op: op })}</div></div>`);
    return out.join("");
  }
  function drawChart(canvas, data) {
    const cv = canvas && canvas.getContext && canvas.getContext("2d"); if (!cv) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = canvas.clientWidth || 640, h = canvas.clientHeight || 180;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); cv.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 56, padR = 8, padT = 8, padB = 16, css = getComputedStyle(canvas), ACC = css.getPropertyValue("--ax-acc").trim() || "#F7931A", DIM = css.getPropertyValue("--dx-dim2").trim() || "#6F7583";
    cv.clearRect(0, 0, w, h); cv.font = '11px "JetBrains Mono", ui-monospace, monospace'; cv.fillStyle = DIM;
    if (!data || data.length < 2) { cv.fillText(!data || !data.length ? I18N.t("Collecting market data…") : I18N.t("need 2+ trades to chart"), padL, h / 2); return; }
    let minP = Infinity, maxP = -Infinity, minB = Infinity, maxB = -Infinity;
    data.forEach((t) => { minP = Math.min(minP, t.price); maxP = Math.max(maxP, t.price); minB = Math.min(minB, t.createdBlock); maxB = Math.max(maxB, t.createdBlock); });
    if (maxP <= minP) maxP = minP + Math.max(minP * 0.001, 1e-9); if (maxB <= minB) maxB = minB + 1;
    const px = (bk) => padL + ((bk - minB) / (maxB - minB)) * (w - padL - padR), py = (v) => padT + (1 - (v - minP) / (maxP - minP)) * (h - padT - padB);
    cv.strokeStyle = DIM; cv.lineWidth = 1; cv.beginPath(); cv.moveTo(padL, padT); cv.lineTo(padL, h - padB); cv.lineTo(w - padR, h - padB); cv.stroke();
    cv.fillText(fmtPx(maxP), 2, padT + 9); cv.fillText(fmtPx(minP), 2, h - padB);
    cv.strokeStyle = ACC; cv.lineWidth = 2; cv.beginPath(); data.forEach((t, i) => { const x = px(t.createdBlock), y = py(t.price); if (i === 0) cv.moveTo(x, y); else cv.lineTo(x, y); }); cv.stroke();
    cv.fillStyle = ACC; data.forEach((t) => { cv.beginPath(); cv.arc(px(t.createdBlock), py(t.price), 2.5, 0, Math.PI * 2); cv.fill(); });
  }
  // the editor: Enabled and Peg switches, mid · step · levels · size · skew · reprice, six rungs (bids left, asks right), the minimum
  const sw = (id, on, label) => `<label class="ax-tog"><span>${label}</span><button class="ax-switch" id="${id}" role="switch" aria-checked="${on}"><i></i></button></label>`;
  const fld = (label, id, val) => `<label class="ax-fld"><b>${label}</b><input class="dx-in ax-in" id="${id}" inputmode="decimal" autocomplete="off" value="${esc(val == null ? "" : val)}"></label>`;
  function editorHtml() {
    const mc = S.mc || {}, c = mc.cfg || {}, st = mc.state || {}, man = mc.manual || { bids: [], asks: [] }, cc = ccy();
    const asks = (man.asks || []).slice().sort((x, y) => x.p - y.p), bids = (man.bids || []).slice().sort((x, y) => y.p - x.p), peg = c.step > 0 ? !!c.pegEnable : true;
    const cell = (id, v, ph, cls) => `<input class="ax-rin ${cls}" id="${id}" inputmode="decimal" autocomplete="off" placeholder="${ph}" aria-label="${ph}" value="${esc(v == null ? "" : v)}">`;
    let rows = "";
    for (let i = 0; i < RUNGS; i++) { const bl = bids[i] || {}, al = asks[i] || {}; rows += `<div class="ax-mrow" id="mkRow${i}">${cell("mkBidA" + i, bl.a, "bid size", "")}${cell("mkBidP" + i, bl.p, "bid price", "ax-rin--bid")}<span class="ax-div">│</span>${cell("mkAskP" + i, al.p, "ask price", "ax-rin--ask")}${cell("mkAskA" + i, al.a, "ask size", "")}</div>`; }
    return `<div id="axTop">${banners()}</div><h2 class="ax-h2">${tr("Your order · USDT ⇄ {cc}", { cc: esc(cc) })}</h2>
      <div class="dx-card"><div class="ax-togs">${sw("mkEnabled", !st.withdrawn, "Enabled")}${sw("mkPeg", peg, I18N.t("Peg → {src}", { src: src() }))}<span class="ax-mono11" id="mkOracle">${peg ? tr("fetching {src} price…", { src: src() }) : "peg off"}</span></div>
        <div class="ax-flds">${fld("mid", "mkMid", "")}${fld("step %", "mkStep", c.step != null ? c.step : "1")}${fld("levels", "mkLevels", c.levels != null ? c.levels : "3")}${fld("size", "mkSize", c.size != null ? c.size : c.askSize != null ? c.askSize : "")}${fld("skew %", "mkBias", c.bias != null ? c.bias : "0")}${fld("reprice %", "mkReprice", c.reprice != null ? c.reprice : "1")}</div>
        <div class="ax-line">${tr("Pegged: prices follow the {src} mid. Size fills every rung; any amount or price can be edited. Only the chosen number of levels is published.", { src: src() })}</div>
        <div class="ax-legend"><span>${tr("BIDS · you buy {cc}", { cc: esc(cc) })}</span><span>${tr("ASKS · you sell {cc}", { cc: esc(cc) })}</span></div>
        <div class="ax-mhdr"><span>${th("amount · price")}</span><span>${th("price · amount")}</span></div>${rows}
        <div class="ax-spread ax-spread--mid" id="mkSpread">—</div>
        ${fld(I18N.t("Min trade · {cc}", { cc: esc(cc) }), "mkMin", c.min != null ? c.min : "")}
        <div class="ax-mono11" id="mkPrev"></div>
        <button class="ax-cta" id="mkSave">${th("Save & publish")}</button>
        <div class="ax-mbtns"><button class="dx-btn" id="mkWithdraw">${th("Withdraw market")}</button><button class="dx-btn" id="mkCancel">${th("Close the editor")}</button></div></div>`;
  }
  function bindEditor() {
    const val = (id) => { const e = $(id); return e ? e.value : ""; }, isOn = (id) => { const e = $(id); return !!e && e.getAttribute("aria-checked") === "true"; };
    const get = (n) => val("mk" + n[0].toUpperCase() + n.slice(1)), on = (n) => isOn(n === "enabled" ? "mkEnabled" : "mkPeg");
    const manual = () => { const f = makerForm(get, () => true); return f.manual; };
    let oracle = 0;
    const summary = () => { const m = ladderSummary(manual(), ccy()); $("mkSpread").textContent = m.spread; $("mkSpread").dataset.bad = m.crossed; $("mkPrev").dataset.bad = m.crossed; $("mkPrev").textContent = m.warn || I18N.t("BIDS  {bids}\nASKS  {asks}", { bids: m.bids, asks: m.asks }); };
    const showLevels = () => { const L = clampLevels(val("mkLevels")); for (let i = 0; i < RUNGS; i++) $("mkRow" + i).hidden = i >= L; };
    /** prices from mid · step · skew for the visible rungs; hidden rungs are emptied so they are not published; only EMPTY sizes are filled */
    const reprice = (midOver) => {
      const L = clampLevels(val("mkLevels")), size = n0(val("mkSize")), px = ladderPrices(midOver != null ? midOver : val("mkMid"), val("mkStep"), val("mkBias"), L);
      for (let i = 0; i < RUNGS; i++) {
        const bp = $("mkBidP" + i), ap = $("mkAskP" + i), ba = $("mkBidA" + i), aa = $("mkAskA" + i);
        if (i < L) { if (px[i]) { bp.value = px[i].bid; ap.value = px[i].ask; } if (size > 0) { if (!ba.value) ba.value = rungSize(val("mkSize")); if (!aa.value) aa.value = rungSize(val("mkSize")); } }
        else bp.value = ap.value = ba.value = aa.value = "";
      }
      showLevels(); summary();
    };
    const seed = () => { const L = clampLevels(val("mkLevels")), size = n0(val("mkSize")); for (let i = 0; i < RUNGS; i++) $("mkBidA" + i).value = $("mkAskA" + i).value = i < L && size > 0 ? rungSize(val("mkSize")) : ""; summary(); };
    const pegUi = () => { $("mkMid").disabled = on("peg"); };
    const refreshPeg = async () => {
      const pv = await api().axMakerPreview({ pegEnable: true, step: n0(val("mkStep")), askSize: n0(val("mkSize")), bidSize: n0(val("mkSize")), bias: n0(val("mkBias")), levels: n0(val("mkLevels")) || 1, reprice: n0(val("mkReprice")) || 1, min: n0(val("mkMin")) }, {}).catch(() => null);
      if (!pv || !$("mkOracle")) return;
      oracle = pv.mid || 0;
      $("mkOracle").textContent = pv.mid > 0 ? I18N.t("{ccy} · mid {mid}{fresh}{wide}", { ccy: (pv.source || ccy()), mid: fmtPx(pv.mid), fresh: (pv.fresh ? "" : " (stale)"), wide: (pv.wide ? (" " + I18N.t("· WIDE")) : "") }) : I18N.t("waiting for {source} price…", { source: (pv.source || "market") });
      if (on("peg")) { $("mkMid").value = pv.mid > 0 ? fmtPx(pv.mid) : ""; if (pv.mid > 0) reprice(pv.mid); }
    };
    const poll = () => { clearInterval(S.pegTimer); refreshPeg(); S.pegTimer = setInterval(() => { if ($("mkOracle") && isOn("mkPeg")) refreshPeg(); else clearInterval(S.pegTimer); }, 2500); };
    for (const id of ["mkEnabled", "mkPeg"]) $(id).onclick = () => { $(id).setAttribute("aria-checked", String(!isOn(id))); if (id === "mkPeg") { pegUi(); if (isOn(id)) poll(); else { clearInterval(S.pegTimer); $("mkOracle").textContent = "peg off"; reprice(); } } };
    const b = body();
    b.oninput = (e) => { const t = e.target; if (!t || t.tagName !== "INPUT") return; if (t.id !== "mkBias") numIn(t);   // the skew may be negative
      if (["mkMid", "mkStep", "mkBias", "mkLevels"].includes(t.id)) reprice(on("peg") && oracle > 0 ? oracle : undefined); else if (t.id === "mkSize") seed(); else summary(); };
    const done = () => { clearInterval(S.pegTimer); S.editing = false; b.oninput = null; b.innerHTML = ""; render("market", b); };
    $("mkSave").onclick = () => D.money(async () => {
      if (halted() && on("enabled")) return say(I18N.t("Halted: this node no longer owns the keys AtomiX uses here. Nothing was published."), "error");
      const form = makerForm(get, on);   // read before anything can close the editor
      await busyWhile("save", () => { const b = $("mkSave"); if (b) { b.disabled = true; b.textContent = I18N.t("Saving…"); } return Act.makerSave(api(), ui, form); });
      if (S.editing) done(); else load("market").then(paint, paint);   // Close during the save left the editor already: the save's outcome is said on Market
    });
    $("mkWithdraw").onclick = () => D.money(async () => { const r = await busyWhile("withdraw", () => Act.makerWithdraw(api(), ui)); if (r && S.editing) done(); });
    $("mkCancel").onclick = () => { S.said = null; done(); };
    pegUi(); showLevels(); if (n0(val("mkSize")) > 0) reprice(); summary(); if (on("peg")) poll();
  }
  function paintMarket() {
    const b = body();
    if (S.editing) { if (!$("mkSave")) { b.innerHTML = editorHtml(); bindEditor(); } else $("axTop").innerHTML = banners(); return; }
    b.innerHTML = marketHtml();
    if ($("axChart")) setTimeout(() => { try { drawChart($("axChart"), (S.mh || {}).chart); } catch (e) {} }, 0);
  }
  async function marketAct(what) {
    if (what === "edit") { S.editing = true; S.said = null; return paint(); }
    return D.money(async () => {
      await busyWhile(what, () => { paint(); return what === "publish" ? Act.makerPublish(api(), ui) : Act.makerWithdraw(api(), ui); });
      load("market").then(paint, paint);
    });
  }

  // ---- OTC (OtcTab.java) ----
  const WHY_OTC = L_("Negotiate a custom size and price directly with a liquidity provider (LP), then settle as the same trustless HTLC swap as everything else in ①: each side locks, the secret releases both, and a stalled deal refunds. Go live with your own availability and other people can propose deals to you; this app answers and settles while it is running.");
  function otcHtml() {
    const c = ccy(), o = S.otc, out = [banners(), why("otc", I18N.t("OTC — A PRIVATE DEAL"), WHY_OTC)];
    if (!D.running() || !S.st.ready) return out.join("");
    const my = (o && o.myOffer) || {}, live = !!my.enable, dr = S.otcDraft || (o ? (S.otcDraft = { sell: my.sellSize || "", buy: my.buySize || "" }) : { sell: "", buy: "" }), dis = S.busy || halted() ? " disabled" : "";
    out.push(`<div class="dx-label ax-sec">${th("MY AVAILABILITY")}</div><div class="dx-card">
      <label class="ax-fld"><b>${th("I SELL up to")}</b><input class="dx-in ax-in ax-in--line" id="otcSell" inputmode="decimal" autocomplete="off" placeholder="${tr("max {c} (blank = off)", { c: esc(c) })}" value="${esc(dr.sell)}"></label>
      <label class="ax-fld"><b>${th("I BUY up to")}</b><input class="dx-in ax-in ax-in--line" id="otcBuy" inputmode="decimal" autocomplete="off" placeholder="${tr("max {c} (blank = off)", { c: esc(c) })}" value="${esc(dr.buy)}"></label>
      <div class="ax-offer" data-live="${live}">${live ? th("● Live: LPs can negotiate with you") : th("○ Off")}</div>
      <div class="ax-acts"><button class="dx-btn ax-go" data-axotc="live"${dis}>${live ? th("Update") : th("Go live")}</button><button class="dx-btn" data-axotc="withdraw"${S.busy ? " disabled" : ""}>${th("Withdraw")}</button></div></div>`);   // always there, as in the old panel (0.18.141): an offer this screen thinks is off can still be on the board
    out.push(`<div class="dx-label ax-sec">${th("LIQUIDITY PROVIDERS")}</div>`);
    if (!o) out.push(`<div class="ax-dim">${th("Reading the OTC board…")}</div>`);
    else if (!o.board.length) out.push(`<div class="ax-dim">${th("No OTC LPs online right now.")}</div>`);
    else o.board.forEach((lp) => {
      const sides = [Number(lp.sell) > 0 ? I18N.t("sells up to {n} {c}", { n: lp.sell, c: c }) : "", Number(lp.buy) > 0 ? I18N.t("buys up to {n} {c}", { n: lp.buy, c: c }) : ""].filter(Boolean).join("   ·   ");
      out.push(`<div class="dx-card"><b class="ax-t13">${esc(sides || I18N.t("no size offered"))}</b>${idLine(I18N.t("LP id"), lp.cid)}<div class="ax-acts">${Number(lp.sell) > 0 ? `<button class="dx-btn ax-go" data-axlp="${esc(lp.cid)}" data-sell="${esc(lp.sell)}" data-buy="${esc(lp.buy)}" data-side="SELL"${dis}>${tr("Buy {c}", { c: esc(c) })}</button>` : ""}${Number(lp.buy) > 0 ? `<button class="dx-btn" data-axlp="${esc(lp.cid)}" data-sell="${esc(lp.sell)}" data-buy="${esc(lp.buy)}" data-side="BUY"${dis}>${tr("Sell {c}", { c: esc(c) })}</button>` : ""}</div></div>`);
    });
    out.push(`<div class="dx-label ax-sec">${th("MY DEALS")}</div>`);
    if (o && !o.deals.length) out.push(`<div class="ax-dim">${th("No OTC deals yet.")}</div>`);
    for (const d of (o && o.deals) || []) out.push(`<div class="dx-card"><b class="ax-t14">${tr("{side}{amount} {c} @ {price} USDT", { side: d.side === "SELL" ? (th("LP sells") + " ") : (th("LP buys") + " "), amount: esc(d.amount), c: esc(c), price: esc(d.price) })}</b><div class="ax-dim">${esc(dealStatus(d))}</div>${d.hash ? idLine("swap", d.hash) : ""}`
      + (dealCanAct(d) ? `<div class="ax-acts"><button class="dx-btn ax-go" data-axdeal="accept" data-ref="${esc(d.ref)}"${dis}>${th("Accept")}</button><button class="dx-btn" data-axdeal="counter" data-ref="${esc(d.ref)}"${dis}>${th("Counter")}</button><button class="dx-btn" data-axdeal="reject" data-ref="${esc(d.ref)}"${S.busy ? " disabled" : ""}>${th("Reject")}</button></div>` : "") + `</div>`);
    return out.join("");
  }
  function paintOtc() { const b = body(); b.innerHTML = otcHtml(); b.oninput = (e) => { const t = e.target; if (t && (t.id === "otcSell" || t.id === "otcBuy")) { numIn(t); if (S.otcDraft) S.otcDraft[t.id === "otcSell" ? "sell" : "buy"] = t.value; } }; }
  /** amount and price for a proposal or a counter-offer (OtcTab.terms) */
  const terms = (title, text, okLabel, amount, price, cap) => form(title, `<pre>${esc(text)}</pre><label class="ax-fld"><b>${tr("{ccy} amount{cap}", { ccy: esc(ccy()), cap: cap != null ? (" " + tr("(at most {cap})", { cap: esc(cap) })) : "" })}</b><input class="dx-in ax-in" name="a" inputmode="decimal" autocomplete="off" value="${esc(amount || "")}"></label><label class="ax-fld"><b>${tr("Price (USDT per {ccy})", { ccy: esc(ccy()) })}</b><input class="dx-in ax-in" name="p" inputmode="decimal" autocomplete="off" value="${esc(price || "")}"></label>`,
    okLabel, (d) => { const a = d.querySelector("[name=a]").value.trim(), p_ = d.querySelector("[name=p]").value.trim(); return termsProblem(a, p_, cap) || { amount: a, price: p_ }; }, (d) => { d.oninput = (e) => { if (e.target.tagName === "INPUT") numIn(e.target); }; });
  async function otcAct(ds) {
    if (halted() && !(ds.axotc === "withdraw" || ds.axdeal === "reject")) return say(I18N.t("Halted: this node no longer owns the keys AtomiX uses here. Nothing was sent."), "error");
    const o = S.otc || { board: [], deals: [] }, c = ccy(), run = async (fn) => { await busyWhile(true, () => { paint(); return fn(); }); S.otcDraft = ds.axotc ? null : S.otcDraft; load("otc").then(paint, paint); };
    if (ds.axotc === "live") return run(() => Act.otcGoLive(api(), ui, $("otcSell").value, $("otcBuy").value));
    if (ds.axotc === "withdraw") return run(() => Act.otcWithdraw(api(), ui));
    if (ds.axlp != null) {
      // the row is found by the LP's id in the board as it is now, with the sizes its card showed (the list is replaced
      // by engine updates while the screen is not redrawn under a focused field: an index could name another LP)
      const GONE = I18N.t("That LP's offer changed or left the board while this screen was open. Nothing was sent. The list is redrawn: look again.");
      const lp = lpPick(o.board, ds.axlp, ds.sell, ds.buy); if (!lp) { say(GONE, "error"); return load("otc").then(paint, paint); }
      const buy = ds.side === "SELL", t = await terms(buy ? I18N.t("Buy {c}", { c: c }) : I18N.t("Sell {c}", { c: c }), I18N.t("{c} This sends an offer only: nothing is locked until the LP accepts and the swap starts.\n\nLP id\n{cid}", { c: (buy ? I18N.t("You buy {c} from this LP and pay USDT on Ethereum.", { c: c }) : I18N.t("You sell {c} to this LP and receive USDT on Ethereum.", { c: c })), cid: lp.cid }), I18N.t("Send offer"), "", "", buy ? lp.sell : lp.buy);
      if (!t) return null;
      if (!lpPick((S.otc || {}).board, ds.axlp, ds.sell, ds.buy)) { say(GONE, "error"); return load("otc").then(paint, paint); }   // again: the terms dialog was open meanwhile
      return run(() => Act.otcPropose(api(), ui, lp, ds.side, t.amount, t.price));
    }
    if (ds.axdeal === "counter") {
      const d = o.deals.find((x) => x.ref === ds.ref); if (!d) return;
      const t = await terms("Counter-offer", I18N.t("Your counter replaces the terms on the table. Nothing is locked until one side accepts."), I18N.t("Send counter"), d.amount, d.price, null);
      return t ? run(() => Act.otcDeal(api(), ui, ds.ref, "counter", t.amount, t.price)) : null;
    }
    if (ds.axdeal) return run(() => Act.otcDeal(api(), ui, ds.ref, ds.axdeal));
  }

  // ---- the room ----
  const none = () => "", noop = () => {};
  const SCREENS = { swap: { skeleton: swapSkeleton, bind: bindSwap, paint: paintSwap }, market: { skeleton: none, bind: noop, paint: paintMarket, whole: true },
    otc: { skeleton: none, bind: noop, paint: paintOtc, whole: true } };
  function render(tab, host) {
    if (!D) return;
    const scr = SCREENS[tab]; if (!scr) { host.dataset.tab = tab; host.onclick = null; host.innerHTML = `<div class="dx-state dx-state--note" role="status">${th("This screen of the room is not built in this version yet.")}</div>`; S.tab = tab; return; }
    if (host.dataset.tab !== tab || (!host.firstChild && !scr.whole)) { host.dataset.tab = tab; clearInterval(S.pegTimer); S.editing = false; S.otcDraft = null; host.oninput = null; host.innerHTML = scr.skeleton(); host.onclick = click; S.said = null; scr.bind(); $("main").scrollTop = 0; }
    S.tab = tab; host.dataset.axccy = S.st.currency || "";
    paint(); load(tab).then(paint, paint);
  }
  function paint() {
    if (onShared()) return D.redraw();
    const b = body(), scr = SCREENS[S.tab]; if (!b || !scr || b.dataset.tab !== S.tab || (!b.firstChild && !scr.whole)) return;
    if (scr.whole && typing() && !S.editing) return;   // a screen drawn whole is never redrawn under someone typing
    b.dataset.axccy = S.st.currency || ""; scr.paint();
  }
  /** once a minute while a screen of the room is open (the phone's REFRESH_MS), never under someone typing */
  /** the shared screens ask for AtomiX's part of their data: at once when one opens, then once a minute */
  function shared(force) { if (!D || (!force && Date.now() - S.at < 60000)) return; load("shared").then(D.redraw, D.redraw); }
  function tick() { if (D && !onShared() && SCREENS[S.tab] && visible() && !typing() && !S.busy && Date.now() - S.at > 60000) load(S.tab).then(paint, paint); }
  /** true when the click was one of this file's (dexicon-ui.js asks first, on the shared screens) */
  async function click(e) {
    const b = e.target.closest("button"); if (!b || !Object.keys(b.dataset).some((k) => k.indexOf("ax") === 0)) return false;
    await click0(b.dataset); return true;
  }
  /** every money action of the room passes Dexicon's one gate (DexCore.money, 0.18.122): one at a time across rooms 1, 2 and 3 */
  const one = (fn) => D.money(fn);
  async function click0(ds) {
    if (ds.axwhy) { pref("dexicon_fold_" + ds.axwhy, whyOpen(ds.axwhy) ? "0" : "1"); return paint(); }
    if (ds.axgo) return D.go(ds.axgo);
    if (ds.axaside) return one(setAside);
    if (ds.axslip) { if (ds.axslip === "custom") return customSlip(); S.slip = Number(ds.axslip); pref("dexicon_ax_slip", ds.axslip); paint(); return preview(); }
    if (ds.axcheck) return checkNow(ds.axcheck);
    if (ds.axmk) return marketAct(ds.axmk);
    if (ds.axotc || ds.axlp != null || ds.axdeal) return D.money(() => otcAct(ds));
    if (ds.axrefresh) { S.book = null; paint(); return load(S.tab).then(paint, paint); }
    if (ds.axtake) { S.sell = ds.axtake === "bid"; S.typed = null; return D.go("swap"); }   // a bid is where you SELL, an ask where you BUY; the amount and the review are on Swap
    if (ds.axhide) return hide(ds.axhide);
    if (ds.axunhide) { S.hidden.delete(ds.axunhide); pref("dexicon_ax_hidden", [...S.hidden].join(",")); return paint(); }
    if (ds.axrefund) return one(async () => { S.answers[ds.axrefund] = I18N.t("Asking for the refund…"); paint(); S.answers[ds.axrefund] = await Act.refundNow(api(), ui, ds.axrefund); return reload(); });
    if (ds.axcsv) return Act.exportCsv(api(), ui);
    if (ds.axstart) return D.start();
    if (ds.axw) return one(() => walletAct(ds.axw));
    if (ds.axswitch) return switchCurrency();   // gated inside: the strip's pill calls it too
    if (ds.axabout) return void D.dialog(I18N.t("About AtomiX"), ABOUT, "");
  }
  const reload = () => load(onShared() ? "shared" : S.tab).then(paint, paint);

  // ---- AtomiX's part of the shared screens (dexicon-ui.js places them): Activity, History, Assets, Settings ----
  const ABOUT = L_("Swap MINIMA or MxUSD ⇄ Ethereum USDT trustlessly across chains: no middleman ever holds your funds. Both sides lock their funds in a time-locked contract; a swap that stalls is refunded by itself at its deadline.\n\nYour keys are derived from this node's seed, so it is the same wallet and identity on any device running AtomiX on this node's seed.\n\nRoom ① has Swap (a quick trade), Market (the order book and your own offer) and OTC (private negotiated deals). Your swaps are in Activity and History, your Ethereum wallet in Assets.\n\nAtomiX trades on the same on-chain books as the AtomiX phone app and MiniDapp.");
  const up = () => D.running() && S.st.ready;
  function part(tab, sub) {
    if (!up()) return tab === "assets" ? `<div class="dx-card"><div class="dx-label">${th("ETHEREUM")}</div><div class="dx-sub dx-sub--sans">${D.running() ? th("AtomiX is still starting: the Ethereum wallet appears when it is ready.") : th("The node is stopped. The Ethereum wallet appears when it runs.")}</div></div>` : "";
    const c = ccy(), swaps = S.swaps || [];
    if (tab === "activity") {
      if (sub === 1) { const rec = (S.mh && S.mh.recent) || []; return rec.length ? `<div class="dx-day">${tr("ATOMIX · USDT ⇄ {c}", { c: esc(c) })}</div>` + rec.map((t) => `<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline">${fmtPx(t.price)} USDT</span><span class="dx-chip" data-tone="${t.status === "EXECUTED" ? "ok" : t.status === "REFUNDED" ? "bad" : "live"}">${t.status === "EXECUTED" ? th("FILLED") : t.status === "REFUNDED" ? th("REFUNDED") : th("OPEN")}</span></div><div class="dx-sub">${tr("{sizeMinima} {c} · block {createdBlock}", { sizeMinima: esc(t.sizeMinima), c: esc(c), createdBlock: esc(t.createdBlock) })}</div></div>`).join("") : ""; }
      const list = swaps.filter((x) => !S.hidden.has(x.hash)).sort((a, b) => (terminal(a) - terminal(b)) || (b.created - a.created));
      return list.length ? `<div class="dx-day">${tr("ATOMIX SWAPS · USDT ⇄ {c}", { c: esc(c) })}</div>` + list.map((x) => swapCard(x, true)).join("") : "";
    }
    if (tab === "history") { const list = historyList(swaps, S.hidden); return list.length ? `<div class="dx-day">${tr("ATOMIX SWAPS · USDT ⇄ {c}", { c: esc(c) })}</div>` + list.map((x) => swapCard(x, false, S.hidden.has(x.hash))).join("") : ""; }
    if (tab === "assets") {
      const w = S.wallet, b = (w && w.bals) || {}, m = b.meta, warn = coinWarn(S.st.currency, m && m.coins), addr = S.st.eth || (w && w.addr) || "";
      const locked = m ? Math.max(0, (Number(m.confirmed) || 0) - (Number(m.sendable) || 0)) : 0;
      return (halted() ? haltHtml() : "") + `<div class="dx-card"><div class="dx-row"><span class="dx-label">${th("ETHEREUM")}</span><span class="dx-row"><button class="dx-btn dx-btn--side" data-copy="${esc(addr)}">${th("Copy")}</button><button class="dx-info" data-axw="info" aria-label="${th("About this Ethereum wallet")}">i</button></span></div>
          <div class="ax-ethbal">${tr("USDT {usdt} · ETH {eth}", { usdt: esc(w ? b.usdt : "…"), eth: esc(w ? b.eth : "…") })}</div><div class="dx-addr" data-copy="${esc(addr)}" title="${th("Your Ethereum wallet address. Click to copy")}">${esc(addr)}</div>
          ${b.ethErr ? `<div class="ax-bad">${tr("The Ethereum balance could not be read: {ethErr}. The amounts above are not known; nothing is lost. Try Refresh.", { ethErr: esc(b.ethErr) })}</div>` : ""}
          <div class="ax-wbtns"><button class="dx-btn" data-axw="refresh">${th("↻  Refresh")}</button><button class="dx-btn" data-axw="fund">${th("⤓  Fund / QR")}</button><button class="dx-btn" data-axw="send">${th("↑  Send")}</button><button class="dx-btn ax-key" data-axw="key">${th("Export key")}</button></div></div>`
        + `<div class="dx-card"><div class="dx-label">${tr("ATOMIX · {c} AVAILABLE TO SWAP", { c: esc(c) })}</div><div class="ax-ethbal">${esc(w ? b.minima : "…")} ${esc(c)}</div>`
        + (m ? `<div class="dx-sub">${tr("confirmed {confirmed} · locked ≈ {locked} · unconfirmed {unconfirmed} · {coins} {coins2}", { confirmed: esc(m.confirmed), locked: cut(locked), unconfirmed: esc(m.unconfirmed), coins: esc(m.coins), coins2: I18N.t(Number(m.coins) === 1 ? "coin" : "coins") })}</div>` : "")
        + (warn ? `<div class="ax-bad">${esc(warn)}</div>` : "") + `<div class="ax-wbtns"><button class="dx-btn" data-axw="coins">${th("Show coins")}</button><button class="dx-btn" data-axw="consolidate">${tr("Consolidate {c} coins", { c: esc(c) })}</button></div></div>`;
    }
    if (tab === "settings") {
      const custom = S.slip !== 2 && S.slip !== 4.2, other = S.st.currency === "minima" ? "MxUSD" : "MINIMA";
      return `<div class="dx-card" data-axccy="${esc(S.st.currency || "")}"><div class="dx-row"><span class="dx-h">${th("ATOMIX")}</span><button class="dx-info" data-axabout="1" aria-label="${th("About AtomiX")}">i</button></div>
        <div class="dx-sub dx-sub--sans">${tr("Room ① trades USDT ⇄ {c} now. One market at a time: switching withdraws your offer on this one first; swaps in flight still settle.", { c: esc(c) })}</div>
        <div class="ax-wbtns"><button class="dx-btn" data-axswitch="1"${S.switching ? " disabled" : ""}>${tr("⇄  Switch to {other}", { other: other })}</button></div>
        <div class="ax-slip"><span>${th("Max slippage for a buy")}</span>${[2, 4.2].map((x) => `<button data-axslip="${x}" aria-pressed="${S.slip === x}">${x}%</button>`).join("")}<button data-axslip="custom" aria-pressed="${custom}">${custom ? S.slip + "%" : th("Custom")}</button></div>
        <div class="dx-sub dx-sub--sans">${tr("AtomiX engine ready · Ethereum mainnet · block {block}{halted}", { block: esc(S.st.block || "…"), halted: halted() ? (" " + th("· HALTED")) : "" })}</div></div>`;
    }
    return "";
  }
  async function walletAct(what) {
    const w = S.wallet, addr = S.st.eth || (w && w.addr) || "", c = ccy();
    if (what === "refresh") { S.wallet = null; paint(); return reload(); }
    if (what === "info") return void D.dialog(I18N.t("Ethereum wallet"), I18N.t("ERC20 USDT and a little ETH for gas. This wallet is derived from this node's seed: the same address as the AtomiX phone app and MiniDapp on this seed. Its key is made again at every start and is never stored."), "");
    if (what === "fund") {
      let qr = ""; try { if (typeof qrcode !== "undefined") { const q = qrcode(0, "M"); q.addData(addr); q.make(); qr = `<div class="ax-qr">${q.createImgTag(5, 6)}</div>`; } } catch (e) {}
      return void form(I18N.t("Receive / Fund · Ethereum"), `<div class="dx-addr" data-copy="${esc(addr)}" title="${th("Click to copy")}">${esc(addr)}</div>${qr}<div class="dx-sub dx-sub--sans">${th("Same address on all EVM networks: fund it with Ethereum ETH and USDT. A little ETH pays the gas for swaps and sends.")}</div><button class="dx-btn ax-copy" data-copy="${esc(addr)}">${th("Copy address")}</button>`, "");
    }
    if (what === "send") return sendDialog("");
    if (what === "sweep") return sendDialog((S.st.halt && S.st.halt.nodeEth) || "");   // the rescue: the recipient is this node's own current Ethereum address
    if (what === "key") return void D.exportKey();   // ETH Wallet's own gated flow (0.19.120: the typed phrase checked in the main process, the system's prompt where there is one, the clipboard that clears); the key is never in this room's page
    if (what === "coins") {
      const rows = await api().axCoins().catch(() => []);
      return void D.dialog(I18N.t("Your {c} coins", { c: c }), rows.length ? rows.map((r) => I18N.t("{amount} {c}\ncoin {coinid}", { amount: r.amount, c: c, coinid: r.coinid })).join("\n\n") : I18N.t("No sendable coins right now."), "");
    }
    if (what === "consolidate") { const done = await D.consolidateToken(S.st.currency === "minima" ? "0x00" : MXUSD, c); if (done) reload(); }
  }
  /** Send from the Ethereum wallet (WalletActions.send): ETH or USDT, to, amount with Max; the engine checks it and names the fee; then the review. */
  async function sendDialog(prefill) {
    const w = S.wallet, from = S.st.eth || (w && w.addr) || ""; let asset = "eth";
    const got = await form(I18N.t("Send from this wallet"), `<div class="dx-seg"><button data-asset="eth" aria-pressed="true">ETH</button><button data-asset="usdt" aria-pressed="false">USDT</button></div>
      <label class="ax-fld"><b>${th("To")}</b><input class="dx-in ax-in" name="to" placeholder="${th("0x… recipient")}" autocomplete="off" spellcheck="false" value="${esc(prefill || "")}"></label>
      <label class="ax-fld"><b>${th("Amount")}</b><span class="ax-maxrow"><input class="dx-in ax-in" name="amt" inputmode="decimal" placeholder="0.00" autocomplete="off"><button class="dx-btn dx-btn--side" data-max="1">${th("Max")}</button></span></label>
      <div class="dx-sub dx-sub--sans">${th("Sends are irreversible. Double-check the address.")}</div>`, "Review",
      async (d) => { const to = d.querySelector("[name=to]").value.trim(), amt = d.querySelector("[name=amt]").value.trim(), r = await Act.sendCheck(api(), asset, to, amt); return r.err ? I18N.t("{err} Nothing was sent.", { err: r.err }) : { asset, to, amt, fee: r.fee }; },
      (d) => d.addEventListener("click", async (e) => {
        const a = e.target.closest("[data-asset]"), m = e.target.closest("[data-max]");
        if (a) { asset = a.dataset.asset; d.querySelectorAll("[data-asset]").forEach((x) => x.setAttribute("aria-pressed", String(x === a))); }
        if (m) { const v = await api().axSendMax(asset).catch(() => null); if (v != null) d.querySelector("[name=amt]").value = v; }
      }));
    if (!got) return;
    const r = await Act.sendGo(api(), ui, got.asset, from, got.to, got.amt, got.fee);
    if (r && !r.err && r.tx) D.copy(r.tx);
    if (r) reload();
  }
  /** The ⇄ pill (MainActivity.switchCurrencyDialog): the panel's confirm, then the engine's switch. */
  async function switchCurrency() {
    if (!D || S.switching || !S.st.ready) return;
    if (await D.money(async () => { S.switching = true; D.repaintStrip(); let r = null; try { r = await Act.switchCurrency(api(), ui, S.st.currency); } finally { S.switching = false; } if (r && !r.err) { S.otc = null; S.otcDraft = null; pref("dexicon_ax_market_live", "0"); }   // the switch withdrew the market and disarmed OTC: neither the old board nor "a market was live" carries over
      return true; }) !== true) return; S.typed = null; S.book = null; S.mc = null; S.wallet = null; S.bals = null;
    if (onShared()) return reload();
    const b = body(); if (b && SCREENS[S.tab] && b.dataset.tab === S.tab) { b.innerHTML = ""; render(S.tab, b); } else load("").then(D.repaintStrip, D.repaintStrip);
  }

  return Object.assign({ Act, init: (deps) => { D = deps; api().axStatus().then((s) => { if (s) { S.st = s; D.repaintStrip(); } }).catch(() => {}); }, render, onUpdate, reset, tick, click, switchCurrency, part, shared,
    pill: () => ({ text: "⇄  " + (S.switching ? I18N.t("Switching…") : ccy()), currency: S.st.currency || "", busy: !!S.switching, label: I18N.t("Trading {ccy}. Activate to switch to {currency}.", { ccy: ccy(), currency: (S.st.currency === "minima" ? "MxUSD" : "MINIMA") }) }) }, core);
});
