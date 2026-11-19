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
  /** A typed amount as a plain number text. A comma or a second point is never read as anything ("" = no amount):
   *  stripping the comma made "1,5" fifteen (0.18.121; the Exchange ticket's rule is DexCore.entryProblem). */
  const cleanNum = (v) => (/,|\..*\./.test(String(v)) ? "" : String(v).replace(/[^0-9.]/g, ""));
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
    return { crossed: !!both && bb >= ba, spread: !both ? "—" : ba - bb > 0 ? "spread " + fmtPx(ba - bb) + " · " + cut((ba - bb) / bb * 100, 1) + "%" : "⚠ crossed",
      warn: both && bb >= ba ? "Crossed: best bid " + fmtPx(bb) + " is at or above best ask " + fmtPx(ba) + ". You would sell cheaper than you buy." : "",
      bids: bids.length ? bids.length + " lvl · best " + fmtPx(bb) + " · " + abbrev(sum(bids)) + " " + ccy : "none", asks: asks.length ? asks.length + " lvl · best " + fmtPx(ba) + " · " + abbrev(sum(asks)) + " " + ccy : "none" };
  }
  /** YOUR OFFER at a glance (MarketTab.renderMyOffer), from the maker's read model and my own levels in the book. */
  function offerState(mc, book, src) {
    const c = (mc && mc.cfg) || {}, st = (mc && mc.state) || {}, man = (mc && mc.manual) || {}, rows = [];
    for (const [side, name] of [["asks", "ASK"], ["bids", "BID"]]) for (const r of (book && book[side]) || []) if (r.mine) rows.push(name + "  " + fmtPx(r.p) + "   " + abbrev(r.cap));
    const set = c.step > 0 || (man.bids || []).length > 0 || (man.asks || []).length > 0, live = rows.length > 0 && !st.withdrawn;
    return { live, rows: live ? rows : [], text: !mc ? "…" : st.withdrawn ? "Withdrawn: your offer is off the book, or leaving it within about a block." : live ? "Live" + (c.pegEnable ? " · pegged to " + src : "") + " · kept on the book while this app and the node run."
      : set ? "Saved, not on the book. Publish puts it there." : "Off: edit your order, then Publish.", ago: mc && mc.lastPublishMs ? mc.lastPublishMs : 0 };
  }
  /** An OTC deal's state in words (OtcTab.dealStatus). */
  function dealStatus(d) {
    const st = String(d.status || "");
    return st === "PROPOSED" || st === "COUNTERED" ? (d.whoseTurn === "ME" ? "Your move: accept, counter or reject" : "Waiting for the counterparty…")
      : st === "AGREED" ? "Agreed: settling" : st === "EXECUTING" ? "Executing: the swap's two sides are locking" : st === "COMPLETE" ? "Complete" : st === "REJECTED" ? "Rejected" : st === "EXPIRED" ? "Expired" : st.toLowerCase();
  }
  const dealCanAct = (d) => d.whoseTurn === "ME" && (d.status === "PROPOSED" || d.status === "COUNTERED");
  /** Why an OTC offer's terms cannot be sent ("" = they can): both plain positive numbers, the amount within the LP's size. */
  function termsProblem(amount, price, cap) {
    const ok = (t) => /^[0-9]+(\.[0-9]+)?$/.test(String(t).trim()) && Number(t) > 0;
    if (!ok(amount) || !ok(price)) return "Enter an amount and a price. Nothing was sent.";
    return cap != null && Number(amount) > Number(cap) + 1e-9 ? "Above the LP's max size (" + cap + "). Nothing was sent." : "";
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
  const sendReview = (asset, from, to, amt, fee) => { const sym = asset === "eth" ? "ETH" : "USDT"; return { title: "Review: Send " + sym, ok: "Send now", text: "From  " + from + "\n\nSend  " + amt + " " + sym + "\nTo  " + to + "\n\nNetwork fee  ≈ " + fee + " ETH\nThis cannot be undone." }; };
  const KEY_WARN = "This key controls your ETH funds. Anyone who sees it can take them. It is derived from your Minima node seed. Never share it or type it into a website.";

  // The engine reads at most this many coins of a token before it refuses (main/atomix/lib/htlc.js guardedCoins): a maker
  // over it declines every buy until the coins are merged (AtomixConsolidate.warning).
  const COIN_CAP = { minima: 200, mxusdt: 53 };
  const coinWarn = (currency, coins) => (COIN_CAP[currency] && Number(coins) > COIN_CAP[currency] ? coins + " " + ccyName(currency) + " coins: AtomiX buys are being declined. Consolidate." : "");

  /** The halt card's words (DoorsTab.paintRescue), for the desktop: h = axStatus().halt, unsettled = swaps not finished. */
  function haltCard(h, unsettled) {
    const d = [];
    if (h.minimaMismatch) d.push("Minima identity: ORPHANED\n  in use    " + h.orphanedPk + "\n  your node does not own it");
    if (h.ethMismatch) d.push("ETH wallet: STALE\n  in use    " + h.staleEth + "\n  node now  " + h.nodeEth);
    return { title: "⛔  Wallet mismatch: AtomiX is halted",
      why: "Your node's seed no longer matches the keys AtomiX is holding. Trading, publishing and new swaps are stopped. Swaps already in flight keep settling: that part is safe to leave running.",
      details: d.join("\n\n"),
      warn: "⚠  The claim secrets for " + unsettled + " unsettled swap" + (unsettled === 1 ? "" : "s") + " are in this app's AtomiX store"
        + (h.ethMismatch ? ", and the stale ETH key is held only while the app runs: it is made again from the node's seed at every start and is never stored, so only your OLD node seed could rebuild it. Do NOT quit or restart the app before you have exported that key and moved its funds" : "")
        + ". Rescue what you need FIRST. The desktop has no reset for this yet: after the rescue, ask for help before you restore or reset anything.",
      tools: h.ethMismatch ? [["key", "Export the stale ETH key"], ["sweep", "↑  Sweep funds to the node wallet"]] : [] };
  }
  /** Market offline (MakerService.maybeOfflineAlert): the node is not running while a market or OTC offer was being kept on the book. */
  const offline = (nodeRunning, wasLive) => (!nodeRunning && wasLive ? "Market offline: your Minima node isn't running, so your published AtomiX market drops off the book and nobody can trade with you. You were not filled by this, and swaps already locked are refunded at their deadline once the node runs. Start the node: your market is published again by itself." : "");

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
    /** Publish: the saved order as it is (axMakerPublish). */
    async makerPublish(api, ui) {
      const r = await api.axMakerPublish().catch(fail);
      ui.say(r && r.err ? "Your market was NOT published: " + mx(r.err) + ". What was on the book before is unchanged." : "Your market was sent to the book. Nothing is traded yet: it trades when someone takes a level, and this app answers by itself while it runs.", r && r.err ? "error" : "note");
      return r;
    },
    /** Save & publish: Enabled off withdraws (axMakerWithdraw); else axMakerSave(cfg, manual). form = makerForm(…). */
    async makerSave(api, ui, form) {
      if (form.withdraw) { const r = await api.axMakerWithdraw().catch(fail); ui.say(r && r.err ? "Your market was NOT withdrawn: " + mx(r.err) + ". It may still be on the book." : "Market withdrawn: your offer leaves the book within about a block. A take already in flight still settles.", r && r.err ? "error" : "note"); return r; }
      const r = await api.axMakerSave(form.cfg, form.manual).catch(fail);
      ui.say(r && r.err ? "Your order was NOT published: " + mx(r.err) + ". Open the editor to see what was saved before trying again." : "Your order was saved and sent to the book. Nothing is traded yet: it trades when someone takes a level.", r && r.err ? "error" : "note");
      return r;
    },
    async makerWithdraw(api, ui) {
      if (!await ui.confirm("Withdraw your market?", "Your order is tombstoned so peers stop trading against it.", "Withdraw")) return null;
      const r = await api.axMakerWithdraw().catch(fail);
      ui.say(r && r.err ? "Your market was NOT withdrawn: " + mx(r.err) + ". It may still be on the book." : "Market withdrawn: your offer leaves the book within about a block. A take already in flight still settles.", r && r.err ? "error" : "note");
      return r;
    },
    // ---- OTC: the panel's four calls. side is the LP's side: "SELL" = the LP sells (you buy), "BUY" = the LP buys (you sell) ----
    async otcGoLive(api, ui, sell, buy) {
      const r = await api.axOtcGoLive(sell, buy).catch(fail);
      ui.say(r && r.err ? "Your availability was NOT published: " + mx(r.err) : "Your availability was published: other people can now propose deals to you. Nothing is traded until you accept one.", r && r.err ? "error" : "note");
      return r;
    },
    async otcWithdraw(api, ui) {
      const r = await api.axOtcWithdraw().catch(fail);
      ui.say(r && r.err ? "Your availability may still be on the board: " + mx(r.err) : "Availability withdrawn. A deal already agreed still settles.", r && r.err ? "error" : "note");
      return r;
    },
    async otcPropose(api, ui, lp, side, amount, price) {
      side = String(side || "").trim().toUpperCase();
      if (side !== "SELL" && side !== "BUY") { ui.say("Side must be SELL or BUY. Nothing was sent.", "note"); return null; }
      if (!amount || !price) return null;
      const r = await api.axOtcPropose({ cid: lp.cid, mpk: lp.mpk, eth: lp.eth }, side, amount, price).catch(fail);
      ui.say(r && r.err ? "Your offer was NOT sent: " + mx(r.err) : "Offer sent. Nothing is locked: the LP can accept, counter or reject it, and you will see it under My deals.", r && r.err ? "error" : "note");
      return r;
    },
    /** accept / reject: axOtcDeal(ref, action). counter: axOtcDeal(ref, "counter", amount, price). */
    async otcDeal(api, ui, ref, action, amount, price) {
      const r = await (action === "counter" ? api.axOtcDeal(ref, "counter", amount, price) : api.axOtcDeal(ref, action)).catch(fail);
      if (r && r.err) ui.say((action === "accept" ? "The deal was NOT accepted: " : action === "reject" ? "The deal may not be rejected yet: " : "Your counter-offer was NOT sent: ") + mx(r.err), "error");
      else ui.say(action === "accept" ? "Accepted. The deal now settles as an ordinary AtomiX swap: follow it in Activity. If the other side never locks, your lock is refunded by itself at its timelock." : action === "reject" ? "Rejected. Nothing was locked." : "Counter-offer sent. Nothing is locked until one side accepts.", "note");
      return r;
    },
    // ---- the Ethereum wallet: axSendReview (the engine's checks and the fee) → review → axSend ----
    /** { err } to show in the dialog, or { fee }. */
    async sendCheck(api, asset, to, amt) { const r = await api.axSendReview(asset, to, amt).catch(fail); return r && r.err ? { err: mx(r.err) } : r; },
    async sendGo(api, ui, asset, from, to, amt, fee) {
      const rv = sendReview(asset, from, to, amt, fee);
      if (!await ui.confirm(rv.title, rv.text, rv.ok)) return null;
      const r = await api.axSend(asset, to, amt).catch(fail), sym = asset === "eth" ? "ETH" : "USDT";
      if (r && r.err) ui.say("The send of " + amt + " " + sym + " was not confirmed as sent: " + mx(r.err) + ". Look at this address on an Ethereum explorer before sending again: a transaction may have gone out.", "error");
      else ui.say("Sent " + amt + " " + sym + ". It is final once Ethereum confirms it. Transaction " + (r && r.tx), "note");
      return r;
    },
    /** the warning first, then the key (axExportKey) */
    async exportKey(api, ui) { if (!await ui.confirm("Export ETH private key", KEY_WARN, "Reveal key")) return null; return api.axExportKey().catch(() => null); },
    /** every swap, maker and taker, to one file: axExportSwaps → exportCsv(text, "atomix-trades.csv") */
    async exportCsv(api, ui) {
      const rows = await api.axExportSwaps().catch(() => []);
      if (!rows.length) { ui.say("There are no swaps to export. No file was written.", "note"); return null; }
      const path = await api.exportCsv(csv(rows), "atomix-trades.csv").catch(() => null);
      ui.say(path ? "Saved " + rows.length + " swaps." : "Export cancelled. No file was written.", "note");
      return path;
    },
    async refundNow(api, ui, hash) { const r = await api.axRefundNow(hash).catch((e) => ({ msg: "Refund check failed: " + ((e && e.message) || e) })); return mx(r.msg); },
    async inspect(api, hash) { return (await api.axInspect(hash).catch((e) => ["Check failed: " + ((e && e.message) || e)])).map(mx); }
  };

  /** One at a time (0.18.118): while fn runs, a second call does nothing. For the money actions that had no
   *  in-flight state of their own: a double click on Refund now or on a wallet action started it twice. */
  function oneAtATime() { let on = false; return async (fn) => { if (on) return; on = true; try { return await fn(); } finally { on = false; } }; }
  const core = { oneAtATime, MXUSD, ccyName, ccyOf, mx, tok, fmtPx, abbrev, cut, ax6, cleanNum, coinAmount, slipOf, roleLabel, terminal, bestLine, review, takeResult, stages, swapItem, HIDE_ASK, launch, makerLive, RUNGS, clampLevels, ladderPrices, makerForm, ladderSummary, offerState, COIN_CAP, coinWarn, dealStatus, dealCanAct, termsProblem, CSV_COLS, csv, sendReview, KEY_WARN, haltCard, offline };
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
    const off = offline(D.running(), pref("dexicon_ax_market_live") === "1");
    if (off) out.push(`<div class="dx-card ax-alert" role="alert"><b class="ax-t14">Market offline</b><div class="ax-dim">${esc(off.replace(/^Market offline: y/, "Y"))}</div><button class="dx-btn ax-btn--s" data-axstart="1">Start the node</button></div>`);
    else if (!D.running()) out.push(`<div class="dx-state" role="status">The node is stopped, so nothing here can trade and nothing can settle. Start it and AtomiX comes back by itself.</div>`);
    if (halted()) out.push(haltHtml());
    else if (!S.st.ready) out.push(`<div class="dx-card ax-big"><b class="ax-t14">Setting up AtomiX…</b><div class="ax-dim">Preparing your Ethereum wallet and swap keys on this node, then reading the market. The first start takes a minute or two.</div></div>`);
    const l = S.st.ready ? launch(S.st.currency, S.swaps, makerLive(S.mc, S.book), null) : null;
    if (l) out.push(`<div class="ax-launch" role="status">${esc(l.text)}</div>`);
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  function haltHtml() {
    const h = haltCard(S.st.halt, (S.swaps || []).filter((x) => !terminal(x)).length);
    return `<div class="dx-card ax-big ax-halt" role="alert"><b class="ax-halt__t">${esc(h.title)}</b><div class="ax-dim">${esc(h.why)}</div><pre class="ax-halt__d" data-copy="${esc(h.details)}" title="Click to copy the recovery details">${esc(h.details)}</pre><div class="ax-bad">${esc(h.warn)}</div>`
      + h.tools.map((t) => `<button class="dx-btn ax-rescue" data-axw="${t[0]}">${esc(t[1])}</button>`).join("") + `</div>`;
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
    $("axReview").onclick = () => D.money(async () => {
      if (S.busy) return;
      if (halted()) return say("Halted: this node no longer owns the keys AtomiX uses here. Nothing was sent.", "error");
      S.busy = true; paintReview();
      const r = await Act.take(api(), ui, S.sell, amount(), S.slip, ccy());
      S.busy = false;
      if (r && !r.err) { S.typed = null; $("axSend").value = ""; $("axRecv").value = ""; $("axPlan").textContent = ""; }
      load("swap").then(paint, paint);
    });
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

  // ---- Market (MarketTab.java) ----
  const WHY_MARKET = "Here you are the maker: publish a ladder of prices at which you sell and buy the active coin against ERC20 USDT. Takers lock their side first; this app answers automatically while it is running, so keep it open and the node online. Peg the ladder to the live price and it reprices itself; if the price feed fails, it is withdrawn for safety. Withdraw takes your offer off the book in about a block. One market at a time: the ⇄ pill switches it.";
  const src = () => ((S.book ? S.book.pricingParity : S.st.currency === "mxusdt") ? "Parity" : "MEXC");
  const agoMin = (ms) => { const m = Math.floor(Math.max(0, Date.now() - Number(ms)) / 60000); return m < 1 ? "less than a minute ago" : m + " min ago"; };
  function half(row, bid) {
    if (!row) return `<div class="ax-half${bid ? " ax-half--bid" : ""}"><span class="ax-q"><span class="ax-sz">—</span></span></div>`;
    const take = !row.mine && row.cap > 0, q = bid ? `<span class="ax-sz">${abbrev(row.cap)}</span><span class="ax-px">${fmtPx(row.p)}</span>` : `<span class="ax-px">${fmtPx(row.p)}</span><span class="ax-sz">${abbrev(row.cap)}</span>`;
    const tag = row.mine ? `<span class="ax-tag ax-tag--you">you</span>` : `<span class="ax-tag" data-copy="${esc(row.signer)}" title="Maker key. Click to copy">${esc(row.signer)}</span>`;
    return `<div class="ax-half${bid ? " ax-half--bid" : ""}">${take ? `<button class="ax-q" data-axtake="${bid ? "bid" : "ask"}" aria-label="${bid ? "Sell " : "Buy "}${esc(ccy())} at ${fmtPx(row.p)} USDT">${q}</button>` : `<span class="ax-q">${q}</span>`}${tag}</div>`;
  }
  function marketHtml() {
    const c = ccy(), b = S.book, mc = S.mc, o = offerState(mc, b, src()), mid = mc && mc.state && (mc.state.lastMid || mc.state.lastPrice), warn = coinWarn(S.st.currency, S.bals && S.bals.meta && S.bals.meta.coins);
    const out = [banners(), why("market", "YOUR AtomiX MARKET", WHY_MARKET)];
    if (!D.running() || !S.st.ready) return out.join("");
    out.push(`<div class="ax-sub ax-sub--tight">The live USDT ⇄ ${esc(c)} order book. Tap a level to take it on the Swap page, or publish your own offer.</div>`);
    if (mid > 0) out.push(`<div class="ax-mono11">${src()} mid ${fmtPx(mid)}</div>`);
    if (warn) out.push(`<button class="ax-warnpill" data-axgo="assets">${esc(warn)}</button>`);
    out.push(`<div class="dx-card"><div class="dx-label">YOUR OFFER · USDT ⇄ ${esc(c)}</div><div class="ax-offer" data-live="${o.live}">${esc(o.text)}</div>${o.rows.length ? `<pre class="ax-mono11">${esc(o.rows.join("\n"))}\n(USDT per ${esc(c)})</pre>` : ""}${o.ago ? `<div class="ax-line">Last publish ${agoMin(o.ago)}</div>` : ""}</div>`);
    out.push(`<div class="dx-row ax-obh"><b class="ax-t16">Order book  ·  ${b ? b.scanned || 0 : "…"} live</b><button class="dx-pill ax-refresh" data-axrefresh="1">Refresh</button></div>`);
    if (!b || (!b.bids.length && !b.asks.length)) out.push(`<div class="ax-dim">${b ? "No live orders yet. Publish one, or wait for a counterparty." : "Reading the book…"}</div>`);
    else {
      if (b.bestBid && b.bestAsk) out.push(`<div class="ax-spread">spread ${fmtPx(b.bestAsk - b.bestBid)} USDT  ·  USDT per ${esc(c)}, size in ${esc(c)}</div>`);
      out.push(`<div class="ax-legend"><span>SELL ${esc(c)} (bid)</span><span>BUY ${esc(c)} (ask)</span></div>`);
      for (let i = 0, n = Math.min(Math.max(b.bids.length, b.asks.length), 12); i < n; i++) out.push(`<div class="ax-depth${i === 0 ? " ax-depth--best" : ""}">${half(b.bids[i], true)}<span class="ax-div">│</span>${half(b.asks[i], false)}</div>`);
    }
    out.push(`<div class="ax-mbtns"><button class="dx-btn" data-axmk="edit">Edit my order</button><button class="dx-btn ax-go" data-axmk="publish"${S.busy || halted() ? " disabled" : ""}>${S.busy === "publish" ? "Publishing…" : "Publish"}</button><button class="dx-btn" data-axmk="withdraw"${S.busy ? " disabled" : ""}>${S.busy === "withdraw" ? "Withdrawing…" : "Withdraw"}</button></div>`);
    const mh = S.mh || { chart: [], recent: [] }; let ex = 0, op = 0; (mh.recent || []).forEach((t) => { if (t.status === "EXECUTED") ex++; else if (t.status === "OPEN") op++; });
    out.push(`<div class="dx-card ax-chartcard"><div class="dx-label">MARKET HISTORY · PRICE ONLY</div><canvas id="axChart" class="ax-chart"></canvas><div class="ax-line">last ${mh.chart.length ? fmtPx(mh.chart[mh.chart.length - 1].price) : "—"} · ${ex} filled · ${op} open. Every swap this node saw on the book, no back-fill. The list is in Activity › Market history.</div></div>`);
    return out.join("");
  }
  function drawChart(canvas, data) {
    const cv = canvas && canvas.getContext && canvas.getContext("2d"); if (!cv) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = canvas.clientWidth || 640, h = canvas.clientHeight || 180;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); cv.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 56, padR = 8, padT = 8, padB = 16, css = getComputedStyle(canvas), ACC = css.getPropertyValue("--ax-acc").trim() || "#F7931A", DIM = css.getPropertyValue("--dx-dim2").trim() || "#6F7583";
    cv.clearRect(0, 0, w, h); cv.font = '11px "JetBrains Mono", ui-monospace, monospace'; cv.fillStyle = DIM;
    if (!data || data.length < 2) { cv.fillText(!data || !data.length ? "Collecting market data…" : "need 2+ trades to chart", padL, h / 2); return; }
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
    return `<div id="axTop">${banners()}</div><h2 class="ax-h2">Your order · USDT ⇄ ${esc(cc)}</h2>
      <div class="dx-card"><div class="ax-togs">${sw("mkEnabled", !st.withdrawn, "Enabled")}${sw("mkPeg", peg, "Peg → " + src())}<span class="ax-mono11" id="mkOracle">${peg ? "fetching " + src() + " price…" : "peg off"}</span></div>
        <div class="ax-flds">${fld("mid", "mkMid", "")}${fld("step %", "mkStep", c.step != null ? c.step : "1")}${fld("levels", "mkLevels", c.levels != null ? c.levels : "3")}${fld("size", "mkSize", c.size != null ? c.size : c.askSize != null ? c.askSize : "")}${fld("skew %", "mkBias", c.bias != null ? c.bias : "0")}${fld("reprice %", "mkReprice", c.reprice != null ? c.reprice : "1")}</div>
        <div class="ax-line">Pegged: prices follow the ${src()} mid. Size fills every rung; any amount or price can be edited. Only the chosen number of levels is published.</div>
        <div class="ax-legend"><span>BIDS · you buy ${esc(cc)}</span><span>ASKS · you sell ${esc(cc)}</span></div>
        <div class="ax-mhdr"><span>amount · price</span><span>price · amount</span></div>${rows}
        <div class="ax-spread ax-spread--mid" id="mkSpread">—</div>
        ${fld("Min trade · " + esc(cc), "mkMin", c.min != null ? c.min : "")}
        <div class="ax-mono11" id="mkPrev"></div>
        <button class="ax-cta" id="mkSave">Save &amp; publish</button>
        <div class="ax-mbtns"><button class="dx-btn" id="mkWithdraw">Withdraw market</button><button class="dx-btn" id="mkCancel">Close the editor</button></div></div>`;
  }
  function bindEditor() {
    const val = (id) => { const e = $(id); return e ? e.value : ""; }, isOn = (id) => { const e = $(id); return !!e && e.getAttribute("aria-checked") === "true"; };
    const get = (n) => val("mk" + n[0].toUpperCase() + n.slice(1)), on = (n) => isOn(n === "enabled" ? "mkEnabled" : "mkPeg");
    const manual = () => { const f = makerForm(get, () => true); return f.manual; };
    let oracle = 0;
    const summary = () => { const m = ladderSummary(manual(), ccy()); $("mkSpread").textContent = m.spread; $("mkSpread").dataset.bad = m.crossed; $("mkPrev").dataset.bad = m.crossed; $("mkPrev").textContent = m.warn || "BIDS  " + m.bids + "\nASKS  " + m.asks; };
    const showLevels = () => { const L = clampLevels(val("mkLevels")); for (let i = 0; i < RUNGS; i++) $("mkRow" + i).hidden = i >= L; };
    /** prices from mid · step · skew for the visible rungs; hidden rungs are emptied so they are not published; only EMPTY sizes are filled */
    const reprice = (midOver) => {
      const L = clampLevels(val("mkLevels")), size = n0(val("mkSize")), px = ladderPrices(midOver != null ? midOver : val("mkMid"), val("mkStep"), val("mkBias"), L);
      for (let i = 0; i < RUNGS; i++) {
        const bp = $("mkBidP" + i), ap = $("mkAskP" + i), ba = $("mkBidA" + i), aa = $("mkAskA" + i);
        if (i < L) { if (px[i]) { bp.value = px[i].bid; ap.value = px[i].ask; } if (size > 0) { if (!ba.value) ba.value = fmtPx(size); if (!aa.value) aa.value = fmtPx(size); } }
        else bp.value = ap.value = ba.value = aa.value = "";
      }
      showLevels(); summary();
    };
    const seed = () => { const L = clampLevels(val("mkLevels")), size = n0(val("mkSize")); for (let i = 0; i < RUNGS; i++) $("mkBidA" + i).value = $("mkAskA" + i).value = i < L && size > 0 ? fmtPx(size) : ""; summary(); };
    const pegUi = () => { $("mkMid").disabled = on("peg"); };
    const refreshPeg = async () => {
      const pv = await api().axMakerPreview({ pegEnable: true, step: n0(val("mkStep")), askSize: n0(val("mkSize")), bidSize: n0(val("mkSize")), bias: n0(val("mkBias")), levels: n0(val("mkLevels")) || 1, reprice: n0(val("mkReprice")) || 1, min: n0(val("mkMin")) }, {}).catch(() => null);
      if (!pv || !$("mkOracle")) return;
      oracle = pv.mid || 0;
      $("mkOracle").textContent = pv.mid > 0 ? (pv.source || ccy()) + " · mid " + fmtPx(pv.mid) + (pv.fresh ? "" : " (stale)") + (pv.wide ? " · WIDE" : "") : "waiting for " + (pv.source || "market") + " price…";
      if (on("peg")) { $("mkMid").value = pv.mid > 0 ? fmtPx(pv.mid) : ""; if (pv.mid > 0) reprice(pv.mid); }
    };
    const poll = () => { clearInterval(S.pegTimer); refreshPeg(); S.pegTimer = setInterval(() => { if ($("mkOracle") && isOn("mkPeg")) refreshPeg(); else clearInterval(S.pegTimer); }, 2500); };
    for (const id of ["mkEnabled", "mkPeg"]) $(id).onclick = () => { $(id).setAttribute("aria-checked", String(!isOn(id))); if (id === "mkPeg") { pegUi(); if (isOn(id)) poll(); else { clearInterval(S.pegTimer); $("mkOracle").textContent = "peg off"; reprice(); } } };
    const b = body();
    b.oninput = (e) => { const t = e.target; if (!t || t.tagName !== "INPUT") return; if (t.id !== "mkBias") numIn(t);   // the skew may be negative
      if (["mkMid", "mkStep", "mkBias", "mkLevels"].includes(t.id)) reprice(on("peg") && oracle > 0 ? oracle : undefined); else if (t.id === "mkSize") seed(); else summary(); };
    const done = () => { clearInterval(S.pegTimer); S.editing = false; S.busy = false; b.oninput = null; b.innerHTML = ""; render("market", b); };
    $("mkSave").onclick = () => D.money(async () => {
      if (S.busy) return;
      if (halted() && on("enabled")) return say("Halted: this node no longer owns the keys AtomiX uses here. Nothing was published.", "error");
      S.busy = "save"; $("mkSave").disabled = true; $("mkSave").textContent = "Saving…";
      await Act.makerSave(api(), ui, makerForm(get, on)); done();
    });
    $("mkWithdraw").onclick = () => D.money(async () => { if (S.busy) return; S.busy = "withdraw"; const r = await Act.makerWithdraw(api(), ui); S.busy = false; if (r) done(); });
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
      if (S.busy) return;
      S.busy = what; paint();
      if (what === "publish") await Act.makerPublish(api(), ui); else await Act.makerWithdraw(api(), ui);
      S.busy = false; load("market").then(paint, paint);
    });
  }

  // ---- OTC (OtcTab.java) ----
  const WHY_OTC = "Negotiate a custom size and price directly with a liquidity provider (LP), then settle as the same trustless HTLC swap as everything else in ①: each side locks, the secret releases both, and a stalled deal refunds. Go live with your own availability and other people can propose deals to you; this app answers and settles while it is running.";
  function otcHtml() {
    const c = ccy(), o = S.otc, out = [banners(), why("otc", "OTC: A PRIVATE DEAL", WHY_OTC)];
    if (!D.running() || !S.st.ready) return out.join("");
    const my = (o && o.myOffer) || {}, live = !!my.enable, dr = S.otcDraft || (o ? (S.otcDraft = { sell: my.sellSize || "", buy: my.buySize || "" }) : { sell: "", buy: "" }), dis = S.busy || halted() ? " disabled" : "";
    out.push(`<div class="dx-label ax-sec">MY AVAILABILITY</div><div class="dx-card">
      <label class="ax-fld"><b>I SELL up to</b><input class="dx-in ax-in" id="otcSell" inputmode="decimal" autocomplete="off" placeholder="max ${esc(c)} (blank = off)" value="${esc(dr.sell)}"></label>
      <label class="ax-fld"><b>I BUY up to</b><input class="dx-in ax-in" id="otcBuy" inputmode="decimal" autocomplete="off" placeholder="max ${esc(c)} (blank = off)" value="${esc(dr.buy)}"></label>
      <div class="ax-offer" data-live="${live}">${live ? "● Live: LPs can negotiate with you" : "○ Off"}</div>
      <div class="ax-acts"><button class="dx-btn ax-go" data-axotc="live"${dis}>${live ? "Update" : "Go live"}</button>${live ? `<button class="dx-btn" data-axotc="withdraw"${S.busy ? " disabled" : ""}>Withdraw</button>` : ""}</div></div>`);
    out.push(`<div class="dx-label ax-sec">LIQUIDITY PROVIDERS</div>`);
    if (!o) out.push(`<div class="ax-dim">Reading the OTC board…</div>`);
    else if (!o.board.length) out.push(`<div class="ax-dim">No OTC LPs online right now.</div>`);
    else o.board.forEach((lp, i) => {
      const sides = [Number(lp.sell) > 0 ? "sells up to " + lp.sell + " " + c : "", Number(lp.buy) > 0 ? "buys up to " + lp.buy + " " + c : ""].filter(Boolean).join("   ·   ");
      out.push(`<div class="dx-card"><b class="ax-t13">${esc(sides || "no size offered")}</b>${idLine("LP id", lp.cid)}<div class="ax-acts">${Number(lp.sell) > 0 ? `<button class="dx-btn ax-go" data-axlp="${i}" data-side="SELL"${dis}>Buy ${esc(c)}</button>` : ""}${Number(lp.buy) > 0 ? `<button class="dx-btn" data-axlp="${i}" data-side="BUY"${dis}>Sell ${esc(c)}</button>` : ""}</div></div>`);
    });
    out.push(`<div class="dx-label ax-sec">MY DEALS</div>`);
    if (o && !o.deals.length) out.push(`<div class="ax-dim">No OTC deals yet.</div>`);
    for (const d of (o && o.deals) || []) out.push(`<div class="dx-card"><b class="ax-t14">${d.side === "SELL" ? "LP sells " : "LP buys "}${esc(d.amount)} ${esc(c)} @ ${esc(d.price)} USDT</b><div class="ax-dim">${esc(dealStatus(d))}</div>${d.hash ? idLine("swap", d.hash) : ""}`
      + (dealCanAct(d) ? `<div class="ax-acts"><button class="dx-btn ax-go" data-axdeal="accept" data-ref="${esc(d.ref)}"${dis}>Accept</button><button class="dx-btn" data-axdeal="counter" data-ref="${esc(d.ref)}"${dis}>Counter</button><button class="dx-btn" data-axdeal="reject" data-ref="${esc(d.ref)}"${S.busy ? " disabled" : ""}>Reject</button></div>` : "") + `</div>`);
    return out.join("");
  }
  function paintOtc() { const b = body(); b.innerHTML = otcHtml(); b.oninput = (e) => { const t = e.target; if (t && (t.id === "otcSell" || t.id === "otcBuy")) { numIn(t); if (S.otcDraft) S.otcDraft[t.id === "otcSell" ? "sell" : "buy"] = t.value; } }; }
  /** amount and price for a proposal or a counter-offer (OtcTab.terms) */
  const terms = (title, text, okLabel, amount, price, cap) => form(title, `<pre>${esc(text)}</pre><label class="ax-fld"><b>${esc(ccy())} amount${cap != null ? " (at most " + esc(cap) + ")" : ""}</b><input class="dx-in ax-in" name="a" inputmode="decimal" autocomplete="off" value="${esc(amount || "")}"></label><label class="ax-fld"><b>Price (USDT per ${esc(ccy())})</b><input class="dx-in ax-in" name="p" inputmode="decimal" autocomplete="off" value="${esc(price || "")}"></label>`,
    okLabel, (d) => { const a = d.querySelector("[name=a]").value.trim(), p_ = d.querySelector("[name=p]").value.trim(); return termsProblem(a, p_, cap) || { amount: a, price: p_ }; }, (d) => { d.oninput = (e) => { if (e.target.tagName === "INPUT") numIn(e.target); }; });
  async function otcAct(ds) {
    if (S.busy) return;
    if (halted() && !(ds.axotc === "withdraw" || ds.axdeal === "reject")) return say("Halted: this node no longer owns the keys AtomiX uses here. Nothing was sent.", "error");
    const o = S.otc || { board: [], deals: [] }, c = ccy(), run = async (fn) => { S.busy = true; paint(); await fn(); S.busy = false; S.otcDraft = ds.axotc ? null : S.otcDraft; load("otc").then(paint, paint); };
    if (ds.axotc === "live") return run(() => Act.otcGoLive(api(), ui, $("otcSell").value, $("otcBuy").value));
    if (ds.axotc === "withdraw") return run(() => Act.otcWithdraw(api(), ui));
    if (ds.axlp != null) {
      const lp = o.board[Number(ds.axlp)]; if (!lp) return;
      const buy = ds.side === "SELL", t = await terms(buy ? "Buy " + c : "Sell " + c, (buy ? "You buy " + c + " from this LP and pay USDT on Ethereum." : "You sell " + c + " to this LP and receive USDT on Ethereum.") + " This sends an offer only: nothing is locked until the LP accepts and the swap starts.\n\nLP id\n" + lp.cid, "Send offer", "", "", buy ? lp.sell : lp.buy);
      return t ? run(() => Act.otcPropose(api(), ui, lp, ds.side, t.amount, t.price)) : null;
    }
    if (ds.axdeal === "counter") {
      const d = o.deals.find((x) => x.ref === ds.ref); if (!d) return;
      const t = await terms("Counter-offer", "Your counter replaces the terms on the table. Nothing is locked until one side accepts.", "Send counter", d.amount, d.price, null);
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
    const scr = SCREENS[tab]; if (!scr) { host.dataset.tab = tab; host.onclick = null; host.innerHTML = `<div class="dx-state dx-state--note" role="status">This screen of the room is not built in this version yet.</div>`; S.tab = tab; return; }
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
    if (ds.axwhy) { pref("dexicon_fold_" + ds.axwhy, pref("dexicon_fold_" + ds.axwhy) === "1" ? "0" : "1"); return paint(); }
    if (ds.axgo) return D.go(ds.axgo);
    if (ds.axslip) { if (ds.axslip === "custom") return customSlip(); S.slip = Number(ds.axslip); pref("dexicon_ax_slip", ds.axslip); paint(); return preview(); }
    if (ds.axcheck) return checkNow(ds.axcheck);
    if (ds.axmk) return marketAct(ds.axmk);
    if (ds.axotc || ds.axlp != null || ds.axdeal) return D.money(() => otcAct(ds));
    if (ds.axrefresh) { S.book = null; paint(); return load(S.tab).then(paint, paint); }
    if (ds.axtake) { S.sell = ds.axtake === "bid"; S.typed = null; return D.go("swap"); }   // a bid is where you SELL, an ask where you BUY; the amount and the review are on Swap
    if (ds.axhide) return hide(ds.axhide);
    if (ds.axrefund) return one(async () => { S.answers[ds.axrefund] = "Asking for the refund…"; paint(); S.answers[ds.axrefund] = await Act.refundNow(api(), ui, ds.axrefund); return reload(); });
    if (ds.axcsv) return Act.exportCsv(api(), ui);
    if (ds.axstart) return D.start();
    if (ds.axw) return one(() => walletAct(ds.axw));
    if (ds.axswitch) return switchCurrency();   // gated inside: the strip's pill calls it too
    if (ds.axabout) return void D.dialog("About AtomiX", ABOUT, "");
  }
  const reload = () => load(onShared() ? "shared" : S.tab).then(paint, paint);

  // ---- AtomiX's part of the shared screens (dexicon-ui.js places them): Activity, History, Assets, Settings ----
  const ABOUT = "Swap MINIMA or MxUSD ⇄ Ethereum USDT trustlessly across chains: no middleman ever holds your funds. Both sides lock their funds in a time-locked contract; a swap that stalls is refunded by itself at its deadline.\n\nYour keys are derived from this node's seed, so it is the same wallet and identity on any device running AtomiX on this node's seed.\n\nRoom ① has Swap (a quick trade), Market (the order book and your own offer) and OTC (private negotiated deals). Your swaps are in Activity and History, your Ethereum wallet in Assets.\n\nAtomiX trades on the same on-chain books as the AtomiX phone app and MiniDapp.";
  const up = () => D.running() && S.st.ready;
  function part(tab, sub) {
    if (!up()) return tab === "assets" ? `<div class="dx-card"><div class="dx-label">ETHEREUM</div><div class="dx-sub dx-sub--sans">${D.running() ? "AtomiX is still starting: the Ethereum wallet appears when it is ready." : "The node is stopped. The Ethereum wallet appears when it runs."}</div></div>` : "";
    const c = ccy(), swaps = S.swaps || [];
    if (tab === "activity") {
      if (sub === 1) { const rec = (S.mh && S.mh.recent) || []; return rec.length ? `<div class="dx-day">ATOMIX · USDT ⇄ ${esc(c)}</div>` + rec.map((t) => `<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline">${fmtPx(t.price)} USDT</span><span class="dx-chip" data-tone="${t.status === "EXECUTED" ? "ok" : t.status === "REFUNDED" ? "bad" : "live"}">${t.status === "EXECUTED" ? "FILLED" : t.status === "REFUNDED" ? "REFUNDED" : "OPEN"}</span></div><div class="dx-sub">${esc(t.sizeMinima)} ${esc(c)} · block ${esc(t.createdBlock)}</div></div>`).join("") : ""; }
      const list = swaps.filter((x) => !S.hidden.has(x.hash)).sort((a, b) => (terminal(a) - terminal(b)) || (b.created - a.created));
      return list.length ? `<div class="dx-day">ATOMIX SWAPS · USDT ⇄ ${esc(c)}</div>` + list.map((x) => swapCard(x, true)).join("") : "";
    }
    if (tab === "history") { const list = swaps.filter(terminal).sort((a, b) => b.created - a.created); return list.length ? `<div class="dx-day">ATOMIX SWAPS · USDT ⇄ ${esc(c)}</div>` + list.map((x) => swapCard(x, false)).join("") : ""; }
    if (tab === "assets") {
      const w = S.wallet, b = (w && w.bals) || {}, m = b.meta, warn = coinWarn(S.st.currency, m && m.coins), addr = S.st.eth || (w && w.addr) || "";
      const locked = m ? Math.max(0, (Number(m.confirmed) || 0) - (Number(m.sendable) || 0)) : 0;
      return (halted() ? haltHtml() : "") + `<div class="dx-card"><div class="dx-row"><span class="dx-label">ETHEREUM</span><span class="dx-row"><button class="dx-btn dx-btn--side" data-copy="${esc(addr)}">Copy</button><button class="dx-info" data-axw="info" aria-label="About this Ethereum wallet">i</button></span></div>
          <div class="ax-ethbal">USDT ${esc(w ? b.usdt : "…")} · ETH ${esc(w ? b.eth : "…")}</div><div class="dx-addr" data-copy="${esc(addr)}" title="Your Ethereum wallet address. Click to copy">${esc(addr)}</div>
          ${b.ethErr ? `<div class="ax-bad">The Ethereum balance could not be read: ${esc(b.ethErr)}. The amounts above are not known; nothing is lost. Try Refresh.</div>` : ""}
          <div class="ax-wbtns"><button class="dx-btn" data-axw="refresh">↻  Refresh</button><button class="dx-btn" data-axw="fund">⤓  Fund / QR</button><button class="dx-btn" data-axw="send">↑  Send</button><button class="dx-btn ax-key" data-axw="key">Export key</button></div></div>`
        + `<div class="dx-card"><div class="dx-label">ATOMIX · ${esc(c)} AVAILABLE TO SWAP</div><div class="ax-ethbal">${esc(w ? b.minima : "…")} ${esc(c)}</div>`
        + (m ? `<div class="dx-sub">confirmed ${esc(m.confirmed)} · locked ≈ ${cut(locked)} · unconfirmed ${esc(m.unconfirmed)} · ${esc(m.coins)} ${Number(m.coins) === 1 ? "coin" : "coins"}</div>` : "")
        + (warn ? `<div class="ax-bad">${esc(warn)}</div>` : "") + `<div class="ax-wbtns"><button class="dx-btn" data-axw="coins">Show coins</button><button class="dx-btn" data-axw="consolidate">Consolidate ${esc(c)} coins</button></div></div>`;
    }
    if (tab === "settings") {
      const custom = S.slip !== 2 && S.slip !== 4.2, other = S.st.currency === "minima" ? "MxUSD" : "MINIMA";
      return `<div class="dx-card" data-axccy="${esc(S.st.currency || "")}"><div class="dx-row"><span class="dx-h">ATOMIX</span><button class="dx-info" data-axabout="1" aria-label="About AtomiX">i</button></div>
        <div class="dx-sub dx-sub--sans">Room ① trades USDT ⇄ ${esc(c)} now. One market at a time: switching withdraws your offer on this one first; swaps in flight still settle.</div>
        <div class="ax-wbtns"><button class="dx-btn" data-axswitch="1"${S.switching ? " disabled" : ""}>⇄  Switch to ${other}</button></div>
        <div class="ax-slip"><span>Max slippage for a buy</span>${[2, 4.2].map((x) => `<button data-axslip="${x}" aria-pressed="${S.slip === x}">${x}%</button>`).join("")}<button data-axslip="custom" aria-pressed="${custom}">${custom ? S.slip + "%" : "Custom"}</button></div>
        <div class="dx-sub dx-sub--sans">AtomiX engine ready · Ethereum mainnet · block ${esc(S.st.block || "…")}${halted() ? " · HALTED" : ""}</div></div>`;
    }
    return "";
  }
  async function walletAct(what) {
    const w = S.wallet, addr = S.st.eth || (w && w.addr) || "", c = ccy();
    if (what === "refresh") { S.wallet = null; paint(); return reload(); }
    if (what === "info") return void D.dialog("Ethereum wallet", "ERC20 USDT and a little ETH for gas. This wallet is derived from this node's seed: the same address as the AtomiX phone app and MiniDapp on this seed. Its key is made again at every start and is never stored.", "");
    if (what === "fund") {
      let qr = ""; try { if (typeof qrcode !== "undefined") { const q = qrcode(0, "M"); q.addData(addr); q.make(); qr = `<div class="ax-qr">${q.createImgTag(5, 6)}</div>`; } } catch (e) {}
      return void form("Receive / Fund · Ethereum", `<div class="dx-addr" data-copy="${esc(addr)}" title="Click to copy">${esc(addr)}</div>${qr}<div class="dx-sub dx-sub--sans">Same address on all EVM networks: fund it with Ethereum ETH and USDT. A little ETH pays the gas for swaps and sends.</div><button class="dx-btn ax-copy" data-copy="${esc(addr)}">Copy address</button>`, "");
    }
    if (what === "send") return sendDialog("");
    if (what === "sweep") return sendDialog((S.st.halt && S.st.halt.nodeEth) || "");   // the rescue: the recipient is this node's own current Ethereum address
    if (what === "key") {
      const pk = await Act.exportKey(api(), ui); if (pk === null) return;
      if (!pk) return say("The Ethereum wallet is not ready yet. No key was shown.", "note");
      return void form("ETH private key", `<div class="ax-bad">⚠ Keep this secret.</div><div class="dx-addr">${esc(pk)}</div><button class="dx-btn ax-copy" data-copy="${esc(pk)}">Copy key</button>`, "");
    }
    if (what === "coins") {
      const rows = await api().axCoins().catch(() => []);
      return void D.dialog("Your " + c + " coins", rows.length ? rows.map((r) => r.amount + " " + c + "\ncoin " + r.coinid).join("\n\n") : "No sendable coins right now.", "");
    }
    if (what === "consolidate") { const done = await D.consolidateToken(S.st.currency === "minima" ? "0x00" : MXUSD, c); if (done) reload(); }
  }
  /** Send from the Ethereum wallet (WalletActions.send): ETH or USDT, to, amount with Max; the engine checks it and names the fee; then the review. */
  async function sendDialog(prefill) {
    const w = S.wallet, from = S.st.eth || (w && w.addr) || ""; let asset = "eth";
    const got = await form("Send from this wallet", `<div class="dx-seg"><button data-asset="eth" aria-pressed="true">ETH</button><button data-asset="usdt" aria-pressed="false">USDT</button></div>
      <label class="ax-fld"><b>To</b><input class="dx-in ax-in" name="to" placeholder="0x… recipient" autocomplete="off" spellcheck="false" value="${esc(prefill || "")}"></label>
      <label class="ax-fld"><b>Amount</b><span class="ax-maxrow"><input class="dx-in ax-in" name="amt" inputmode="decimal" placeholder="0.00" autocomplete="off"><button class="dx-btn dx-btn--side" data-max="1">Max</button></span></label>
      <div class="dx-sub dx-sub--sans">Sends are irreversible. Double-check the address.</div>`, "Review",
      async (d) => { const to = d.querySelector("[name=to]").value.trim(), amt = d.querySelector("[name=amt]").value.trim(), r = await Act.sendCheck(api(), asset, to, amt); return r.err ? r.err + " Nothing was sent." : { asset, to, amt, fee: r.fee }; },
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
    if (await D.money(async () => { S.switching = true; D.repaintStrip(); await Act.switchCurrency(api(), ui, S.st.currency); S.switching = false; return true; }) !== true) return; S.typed = null; S.book = null; S.mc = null; S.wallet = null; S.bals = null;
    if (onShared()) return reload();
    const b = body(); if (b && SCREENS[S.tab] && b.dataset.tab === S.tab) { b.innerHTML = ""; render(S.tab, b); } else load("").then(D.repaintStrip, D.repaintStrip);
  }

  return Object.assign({ Act, init: (deps) => { D = deps; api().axStatus().then((s) => { if (s) { S.st = s; D.repaintStrip(); } }).catch(() => {}); }, render, onUpdate, reset, tick, click, switchCurrency, part, shared,
    pill: () => ({ text: "⇄  " + (S.switching ? "Switching…" : ccy()), currency: S.st.currency || "", busy: !!S.switching, label: "Trading " + ccy() + ". Activate to switch to " + (S.st.currency === "minima" ? "MxUSD" : "MINIMA") + "." }) }, core);
});
