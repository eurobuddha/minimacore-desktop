/*
 * dexicon-core.js: the Dexicon screens' logic with no DOM in it, so scripts/dexicon-ui.test.cjs can run it in node.
 * In the page it is window.DexCore (renderer/dexicon-ui.js draws with it).
 *
 * The reference is the Android client (apks/dexicon MainActivity.java): three rooms, a bottom tab bar per room,
 * each room remembering its last tab, Dexicon's own light / dark theme (Design.java ONYX / DAYLIGHT).
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");   // loaded by a test or the main process: the same t(), th(), tr() the window has
(function (root, factory) { const m = factory(); if (typeof module === "object" && module.exports) module.exports = m; else root.DexCore = m; })(this, function () {
  "use strict";

  // Room 1 is AtomiX on the desktop's own engine (renderer/dexicon-ax.js). Room 2 is PandaPools on the desktop's own
  // engine (renderer/dexicon-pp.js), with PandaPools' five tabs (pandapools MainActivity: Swap, Pools, My LP, Wallet, Activity).
  const ROOMS = [
    { id: "mxusd", n: "①", label: "MxUSD", view: "atomix", tabs: ["swap", "market", "otc", "activity", "assets", "settings"] },
    { id: "pools", n: "②", label: N_("Pools"), view: "pandapools", tabs: ["swap", "pools", "mylp", "wallet", "activity"] },
    { id: "exchange", n: "③", label: N_("Exchange"), view: "dexicon", tabs: ["trade", "orders", "history", "activity", "assets", "settings"] }
  ];
  /** Activity, Assets and Settings are ONE screen each, shown in rooms 1 and 3 (ActivityTab, AssetsTab, RelaysTab).
   *  Room 2's Activity is PandaPools' own screen, not this one. */
  const SHARED = ["activity", "assets", "settings"];
  const TAB_LABEL = { swap: N_("Swap"), pools: N_("Pools"), mylp: N_("My LP"), wallet: N_("Wallet"), market: N_("Market"), otc: "OTC", trade: N_("Trade"), orders: N_("Orders"), history: N_("History"), activity: N_("Activity"), assets: N_("Assets"), settings: N_("Settings") };   // translated where drawn (dexicon-ui.js)
  const roomOfView = (view) => ROOMS.findIndex(r => r.view === view);

  /** The saved choices: the last tab of each room and the theme. The room itself is not saved: Dexicon opens on ①. */
  /** was: what the removed AtomiX panel had saved as its own theme ("daylight" / "onyx"); it counts until Dexicon's own choice is saved. */
  function load(raw, was) {
    let o = {}; try { o = JSON.parse(raw || "{}") || {}; } catch (e) { o = {}; }
    const mem = { room: 0, tabs: {}, theme: (o.theme || (was === "daylight" ? "DAYLIGHT" : "")) === "DAYLIGHT" ? "DAYLIGHT" : "ONYX" };
    for (const r of ROOMS) mem.tabs[r.id] = r.tabs.includes(o.tabs && o.tabs[r.id]) ? o.tabs[r.id] : (r.tabs[0] || "");
    mem.tabs.mxusd = "swap";   // every start opens room 1 on Swap (DoorHost.applyLaunchRule); the tab is remembered while the app runs
    return mem;
  }
  const save = (mem) => JSON.stringify({ tabs: mem.tabs, theme: mem.theme });
  function pickRoom(mem, i) { if (ROOMS[i]) mem.room = i; return mem; }
  /** A tab of the CURRENT room; a tab the room does not have changes nothing. */
  function pickTab(mem, tab) { const r = ROOMS[mem.room]; if (r.tabs.includes(tab)) mem.tabs[r.id] = tab; return mem; }
  const tabOf = (mem) => mem.tabs[ROOMS[mem.room].id];
  const toggleTheme = (mem) => { mem.theme = mem.theme === "ONYX" ? "DAYLIGHT" : "ONYX"; return mem; };

  /** One money action at a time in ALL of Dexicon, rooms 1, 2 and 3 (0.18.118 for room 3; every room since 0.18.122):
   *  while one is being reviewed, signed or sent, a second click, a held Enter or a button of another room does
   *  nothing. redraw (optional) is called when the gate closes and when it opens again. */
  const gate = { on: false };
  /**
   * An engine that cannot start because its store file could not be opened (0.18.137; status().error). Before this the
   * room said "starting" for ever. In plain words: what happened, what it means, what to do. after = what follows a set-aside.
   */
  const storeError = (name, what, error, after) => I18N.t("{name} cannot start: its {what} could not be opened ({v}). Nothing on the chain is changed by this, but nothing can be read or sent here until it starts. What to do: quit the app and open it again. If this message is still here after that, the file is damaged: set it aside (it is kept under a dated name, never deleted) and {name2} starts with an empty store. {after}", { name: name, what: what, v: String(error).replace(/[.\s]+$/, ""), name2: name, after: after });
  /** How to undo a set-aside, with the whole path: before the move (file = the store) and after it (kept = where it went). */
  const PUT_BACK = (file, kept) => I18N.t("To put it back: quit the app, then rename {file} back to {file2} (move the new, empty file out of the way first).", { file: (kept || (file ? I18N.t("{file}-legacy-keys-(the date)", { file: file }) : "the dated file")), file2: (file || "its old name") });
  const SET_ASIDE = (name, after, file) => I18N.t("The store file of {name}{file} could not be opened. It will be moved aside under a dated name in the same folder. Nothing is deleted.\n\n{name2} then starts with an empty store. {after}\n\n{file2}\n\nDo this only if the message stayed after the app was restarted.", { name: name, file: (file ? " (" + file + ")" : ""), name2: name, after: after, file2: PUT_BACK(file) });
  async function money(fn, redraw) {
    if (gate.on) return undefined;
    gate.on = true; if (redraw) redraw();
    try { return await fn(); } finally { gate.on = false; if (redraw) redraw(); }
  }

  /** The status strip (MainActivity pairPill): the node, then the engine. tone: "ok" | "dim". */
  function strip(nodeState, st, pageFailed) {
    if (nodeState !== "running") return { text: nodeState === "stopped" ? I18N.t("NODE STOPPED") : I18N.t("NODE STARTING…"), tone: "dim" };
    if (st && st.problem) return { text: I18N.t("DEXICON IS NOT RUNNING"), tone: "dim" };
    if (pageFailed) return { text: I18N.t("PAIRED · trading page did not load"), tone: "dim" };
    if (!st || !st.started || !st.ready) return { text: I18N.t("PAIRED · starting Dexicon"), tone: "dim" };
    if (!st.restingReady) return { text: I18N.t("PAIRED · reading the chain"), tone: "ok" };
    return { text: I18N.t("PAIRED"), tone: "ok" };
  }

  // ---- exact decimals: strings in, BigInt inside, never a float; shortening is always a cut, never a rounding ----
  const NUM = /^[0-9]{1,40}(\.[0-9]{1,40})?$/;
  const p10 = (n) => 10n ** BigInt(n);
  /** A plain non-negative decimal string, or null. */
  function dec(x) {
    const t = String(x == null ? "" : x).trim();
    if (!NUM.test(t)) return null;
    const [w, f = ""] = t.split(".");
    return { v: BigInt(w + f), s: f.length };
  }
  const zero = { v: 0n, s: 0 };
  const lift = (a, s) => a.v * p10(s - a.s);
  const add = (a, b) => { const s = Math.max(a.s, b.s); return { v: lift(a, s) + lift(b, s), s }; };
  /** a - b, never below zero */
  const sub = (a, b) => { const s = Math.max(a.s, b.s), v = lift(a, s) - lift(b, s); return { v: v < 0n ? 0n : v, s }; };
  const cmp = (a, b) => { const s = Math.max(a.s, b.s), x = lift(a, s), y = lift(b, s); return x < y ? -1 : x > y ? 1 : 0; };
  const mul = (a, b) => ({ v: a.v * b.v, s: a.s + b.s });
  const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
  /** cut to dp decimals (toward zero) */
  const down = (a, dp) => (a.s <= dp ? a : { v: a.v / p10(a.s - dp), s: dp });
  /** up to dp decimals: only for "you pay at most", where showing less than the truth would be the lie */
  const up = (a, dp) => { if (a.s <= dp) return a; const q = p10(a.s - dp); return { v: a.v / q + (a.v % q ? 1n : 0n), s: dp }; };
  /** a / b cut to dp decimals; null when b is zero */
  const div = (a, b, dp) => (b.v === 0n ? null : { v: (a.v * p10(dp + b.s)) / (b.v * p10(a.s)), s: dp });
  /** every digit it has, no trailing zeros */
  function str(a) {
    let t = a.v.toString().padStart(a.s + 1, "0");
    if (a.s) t = (t.slice(0, -a.s) + "." + t.slice(-a.s)).replace(/0+$/, "").replace(/\.$/, "");
    return t;
  }
  const fmt = (a) => (a ? str(a) : "0");
  /** a balance: cut to 6 decimals (Util.fmtBal) */
  const fmtBal = (a) => (a ? str(down(a, 6)) : "0");
  /** a price: every digit it has, padded to 6 decimals for alignment, never shortened (Util.fmtPrice) */
  function fmtPrice(a) { if (!a) return "…"; const t = str(a), f = (t.split(".")[1] || "").length; return f >= 6 ? t : (f ? t : t + ".") + "0".repeat(6 - f); }
  /** exactly dp decimals, cut (Util.fmtDown) */
  function fmtDown(a, dp) { const x = a || zero, v = x.s > dp ? x.v / p10(x.s - dp) : x.v * p10(dp - x.s), t = v.toString().padStart(dp + 1, "0"); return dp ? t.slice(0, -dp) + "." + t.slice(-dp) : t; }

  const MIN_REM = dec("1");   // main/dexicon/lib/fill.js MIN_REM: a partial take leaves at least 1 MINIMA on the maker's order
  /** How much of an order of `amount` a take of `want` really takes (lib/fill.js floorTake): all of it, or so that
   *  at least 1 MINIMA stays; zero when neither is possible. */
  function floorTake(amount, want) {
    if (cmp(want, amount) >= 0) return amount;
    if (cmp(sub(amount, want), MIN_REM) >= 0) return want;
    return cmp(amount, MIN_REM) > 0 ? sub(amount, MIN_REM) : zero;
  }

  // ---- the order book (TradeView.renderLadder): FAST, BOOK and POOL at each price ----
  const GROUPS = [null, "0.0001", "0.001", "0.01"], GROUP_LABELS = ["EXACT", "0.0001", "0.001", "0.01"], MAX_ROWS = 10;
  /** the level a price belongs to: asks up to the tick, bids down (a grouping of the view, the row still shows the exact best price) */
  function levelKey(price, tick, sell) {
    if (!tick) return price;
    const t = dec(tick), q = div(price, t, 0), back = mul(q, t);
    return sell && cmp(back, price) < 0 ? add(back, t) : back;
  }
  /** fast: the FAST orders to show and count (default book.fast); a later change can pass a filtered list. */
  function ladder(book, groupIdx, fast) {
    const tick = GROUPS[groupIdx] || null, sides = { sell: new Map(), buy: new Map() }, count = { fast: 0, book: 0, pools: ((book && book.pools) || []).length };
    const at = (side, price) => {
      const k = levelKey(price, tick, side === "sell"), id = str(k), m = sides[side];
      if (!m.has(id)) m.set(id, { price: k, exact: price, fast: zero, book: zero, pool: zero, mine: false, others: zero });
      const lv = m.get(id);
      if (side === "sell" ? cmp(price, lv.exact) < 0 : cmp(price, lv.exact) > 0) lv.exact = price;
      return lv;
    };
    for (const kind of ["fast", "book"]) for (const o of (kind === "fast" && fast ? fast : (book && book[kind])) || []) {
      const price = dec(o.price), amt = dec(o.minima); if (!price || !amt || amt.v === 0n) continue;
      const lv = at(o.side === "sell" ? "sell" : "buy", price);
      lv[kind] = add(lv[kind], amt); count[kind]++;
      if (o.ours) lv.mine = true; else lv.others = add(lv.others, amt);
    }
    for (const [list, side] of [[(book && book.poolAsks) || [], "sell"], [(book && book.poolBids) || [], "buy"]]) for (const r of list) {
      const price = dec(r.price), amt = dec(r.minima); if (!price || !amt || amt.v === 0n) continue;
      const lv = at(side, price); lv.pool = add(lv.pool, amt); lv.others = add(lv.others, amt);
    }
    const sorted = (m, asc) => [...m.values()].map(l => Object.assign(l, { total: add(add(l.fast, l.book), l.pool) })).sort((a, b) => (asc ? cmp(a.price, b.price) : cmp(b.price, a.price)));
    const asks = sorted(sides.sell, true), bids = sorted(sides.buy, false);
    const bestAsk = asks.length ? asks[0].exact : null, bestBid = bids.length ? bids[0].exact : null;
    const mid = bestAsk && bestBid ? div(add(bestAsk, bestBid), dec("2"), 8) : bestBid || bestAsk;
    return { asks, bids, count, bestAsk, bestBid, mid, spread: bestAsk && bestBid ? sub(bestAsk, bestBid) : null };
  }
  /** A ladder row's Total (MxUSD at that level): cut to 4 decimals, never rounded up (it was: 0.18.121). */
  const levelTotal = (lv) => down(mul(lv.price, lv.total), 4);
  /** Why a typed number is not taken ("" = it is fine so far). A comma is never read as anything: "1,234.5" used to
   *  become 1.2345 (the comma turned into a point, the second point dropped). */
  function entryProblem(text) {
    const t = String(text == null ? "" : text);
    if (t.includes(",")) return I18N.t("Type the number without a comma: digits and one decimal point, for example 1234.5. Nothing was changed.");
    if ((t.match(/\./g) || []).length > 1) return I18N.t("A number has one decimal point, for example 1234.5. Nothing was changed.");
    return "";
  }
  /** What the hidden page and the service last said, in their own words, for a screen to show: the take's progress,
   *  the service's stage, then the page's notice when it is an error, a result or a wait (never its idle chatter). */
  function pageSays(page, svc) {
    const lines = ((page && page.log) || []).slice(), n = page && page.notice, k = (page && page.kind) || "";
    if (svc && svc.stage) lines.push(String(svc.stage));
    if (n && /error|posted|pending/.test(k) && lines[lines.length - 1] !== n) lines.push(String(n));
    return { lines, error: /error/.test(k) && feedbackKind(n) === "error" };
  }
  /** The rows to draw on one side: at most ten from the best price, each with its depth so far. */
  function rows(levels) {
    const top = levels.slice(0, MAX_ROWS); let run = zero;
    const all = top.reduce((t, l) => add(t, l.total), zero);
    return top.map(l => { run = add(run, l.total); const f = div(run, all, 4); return { lv: l, cum: run, frac: f ? Number(str(f)) : 0 }; });
  }
  /** The amount column (TradeView.amountText): FAST and POOL always tagged, BOOK only beside another source; FAST and
   *  BOOK exact (they can be taken in full), POOL cut to two decimals (sampled depth). One line per source. */
  function amountText(fast, bookAmt, pool) {
    const parts = [], hasPool = pool && pool.v > 0n;
    if (fast && fast.v > 0n) parts.push("FAST " + str(fast));
    if (bookAmt && bookAmt.v > 0n) parts.push((parts.length || hasPool ? "BOOK " : "") + str(bookAmt));
    if (hasPool) parts.push(I18N.t("POOL {pool}", { pool: fmtDown(pool, 2) }));
    return parts.length ? parts : [fmtDown(zero, 2)];
  }

  // ---- funds (Funds.java) ----
  /** sendable balances, what the user's live FAST orders already promise, and what is still settling */
  function funds(minimaSendable, mxusdSendable, orders, fills) {
    let mo = zero, uo = zero, ms = zero, us = zero;
    for (const o of orders || []) {
      if (o.status !== "live") continue;
      const rem = dec(o.remaining), price = dec(o.price); if (!rem || !price) continue;
      if (o.side === "sell") mo = add(mo, rem); else uo = add(uo, up(mul(rem, price), 8));
    }
    for (const f of fills || []) {
      if (f.status !== "settling") continue;
      const m = dec(f.filled) || zero, u = dec(f.role === "maker" ? f.received : f.got) || zero;
      if (f.side === "buy") ms = add(ms, m); else us = add(us, u);
    }
    const ma = dec(minimaSendable), ua = dec(mxusdSendable);
    return { known: !!(ma && ua), minima: ma || zero, mxusd: ua || zero, minimaOrders: mo, mxusdOrders: uo, minimaSettling: ms, mxusdSettling: us };
  }
  /** free to commit to a NEW order on the paying side */
  const freeFor = (f, buy) => (buy ? sub(f.mxusd, f.mxusdOrders) : sub(f.minima, f.minimaOrders));

  // ---- what one click would do (TradeView.paintCta / updateTotal, ui/app.js crossing) ----
  /** The FAST orders of OTHER makers that a limit at `price` crosses, best price first, and whether the only orders
   *  there are the user's own. book = the read model (dxBook). */
  function crossing(book, buy, price) {
    const hits = [], mine = [];
    for (const o of (book && book.fast) || []) {
      const op = dec(o.price), amt = dec(o.minima); if (!op || !amt || amt.v === 0n) continue;
      if (buy ? o.side !== "sell" || cmp(op, price) > 0 : o.side !== "buy" || cmp(op, price) < 0) continue;
      (o.ours ? mine : hits).push({ price: op, amount: amt });
    }
    hits.sort((a, b) => (buy ? cmp(a.price, b.price) : cmp(b.price, a.price)));
    return { hits, ownOnly: !hits.length && mine.length > 0, offered: hits.reduce((t, h) => add(t, h.amount), zero) };
  }
  /** Is there on-chain liquidity (a BOOK order of someone else, or pool depth) at or inside `price`? */
  function chainCrosses(book, buy, price) {
    const inside = (p) => { const d = dec(p); return d && (buy ? cmp(d, price) <= 0 : cmp(d, price) >= 0); };
    return ((book && book.book) || []).some(o => !o.ours && (o.side === "sell") === buy && inside(o.price)) || ((book && (buy ? book.poolAsks : book.poolBids)) || []).some(r => inside(r.price));
  }
  /** The plan the Trade screen shows before the click. All strings are for display; the engine plans again itself. */
  function plan(book, buy, priceText, amountText_, f) {
    const price = dec(priceText), amount = dec(amountText_);
    if (!price || !amount || price.v === 0n || amount.v === 0n) return { ok: false, why: "" };
    if (price.s > 8 || amount.s > 8) return { ok: false, why: I18N.t("At most 8 decimals.") };
    const x = crossing(book, buy, price), chain = chainCrosses(book, buy, price);
    let left = amount, take = zero, cost = zero, pay = zero, get = zero, n = 0, worst = null;
    for (const h of x.hits) {
      if (left.v === 0n) break;
      const t = floorTake(h.amount, min(left, h.amount)); if (t.v === 0n) continue;
      take = add(take, t); cost = add(cost, mul(t, h.price)); left = sub(left, t); n++; worst = h.price;
      // each take is its own transaction, rounded by the engine on its own (lib/fill.js plan: the taker pays MxUSD
      // rounded UP, receives MxUSD rounded DOWN, 8 decimals). The sum of the round-ups can exceed the round-up of the sum.
      pay = add(pay, up(mul(t, h.price), 8)); get = add(get, down(mul(t, h.price), 8));
    }
    // fast: what the page does at the click (ui/app.js place): ANY crossing FAST order means a sweep, never a resting
    // order. A sweep that can take nothing (the minimum remainder) trades nothing: `stuck`.
    const fast = x.hits.length > 0, stuck = fast && take.v === 0n;
    const need = stuck ? zero : fast ? (buy ? pay : take) : (buy ? up(mul(amount, price), 8) : amount);
    const free = f && f.known ? freeFor(f, buy) : null, short = free ? sub(need, free) : zero;
    return { ok: true, buy, price, amount, fast, stuck, takes: n, take, worst, cost, pay, get, rest: fast ? sub(amount, take) : amount, avg: fast && !stuck ? div(cost, take, 8) : null,
      chain, ownOnly: x.ownOnly && !chain, need, free, short, offered: x.offered };
  }
  /** Why nothing can be sent to the on-chain book now ("" = it can): the resting engine is not ready (0.19.373). The
   *  engine's own reason when a start ended in an error (status().restingWhy, main/dexicon/service.desktop.js), else it
   *  is still starting. BOOK / POOL and SWEEP are off while this is not "", and no review is shown. */
  function chainWhy(st) {
    if (st && st.restingReady) return "";
    const why = String((st && st.restingWhy) || "").trim().replace(/[.\s]+$/, "");
    return why ? I18N.t("The on-chain order book could not start: {reason}. It is tried again every minute. FAST orders are not affected.", { reason: why })
      : I18N.t("The on-chain order book is still starting. Nothing can be sent to it yet.");
  }
  /** The limit an on-chain action is sent with (0.19.374). On-chain prices sit on a 6-decimal grid (resting orders are
   *  placed at 6 decimals, pool depth is sampled on 0.00001 ticks) while a FAST price may have 8, and the page takes at
   *  most 6 (renderer/dexicon/mds.js). A SELL is sent at the typed limit cut UP to 6 decimals, a BUY cut DOWN: every
   *  6-decimal level at or better than the typed limit is still at or better than the sent one, and no level worse than
   *  the typed limit becomes acceptable (scripts/dexicon-ui.test.cjs proves it over a grid). The amount is not touched.
   *  null: not a price, or a BUY below the smallest on-chain price. */
  function chainLimit(buy, priceText) {
    const p = dec(priceText); if (!p || p.v === 0n) return null;
    const c = buy ? down(p, 6) : up(p, 6);
    return c.v === 0n ? null : c;
  }
  // ---- SWEEP: FAST and on-chain together (the phone's, apks/base integrated/dexicon MainActivity.java split /
  // sweepAvg / decideBoth, owner 7 Nov), in exact decimals ----
  /** How one click splits `amount` between on-chain BOOK / POOL and FAST, all inside the limit (MainActivity.split):
   *  on-chain takes every MINIMA it holds at or better than the best FAST price (restingCheap) plus whatever the
   *  crossing FAST orders cannot cover; FAST takes the middle, up to what it offers. The two parts never add up to more
   *  than `amount`, and on-chain never more than it holds at the limit (restingAtLimit). */
  function sweepSplit(amount, restingCheap, fastOffered, restingAtLimit) {
    const cheap = min(amount, restingCheap);
    const fastQ = min(fastOffered, sub(amount, cheap));
    const over = sub(sub(amount, cheap), fastQ);
    return { chainQ: min(add(cheap, over), restingAtLimit), fastQ };
  }
  /** MxUSD per MINIMA over both parts (MainActivity.sweepAvg), CUT to 8 decimals (the phone rounds half up; this app
   *  never rounds an amount or a price it shows). null when there is nothing to average. */
  function sweepAvg(chainMinima, chainMxusd, fastTake, fastCost) {
    const q = add(chainMinima, fastTake);
    return q.v === 0n ? null : div(add(chainMxusd, fastCost), q, 8);
  }
  const routeName = (q) => { const o = dec(q && q.orderMinima) || zero, p = dec(q && q.poolMinima) || zero; return o.v > 0n && p.v > 0n ? "BOOK+POOL" : p.v > 0n ? "POOL" : "BOOK"; };
  /**
   * MainActivity.decideBoth: is there a SWEEP for this ticket, and how is it split? null = no sweep (both parts must be
   * more than zero). book.fast is the list of FAST orders the sweep may take: the caller passes it, so a later change
   * can leave out orders this node cannot take. quote(limit, amount) resolves the PAGE's own on-chain plan
   * (renderer/dexicon/mds.js ACTS.quote, PandaComposite.plan) as { totalMinima, totalUsdt, orderMinima, poolMinima }.
   * The on-chain limits are on the 6-decimal grid (chainLimit): the same on-chain levels as the typed ones.
   */
  async function decideBoth(book, buy, priceText, amountText, quote) {
    const price = dec(priceText), amount = dec(amountText);
    if (!price || !amount || price.v === 0n || amount.v === 0n || price.s > 8 || amount.s > 8) return null;
    const x = crossing(book, buy, price); if (!x.hits.length || x.offered.v === 0n) return null;
    const lim = chainLimit(buy, priceText), cheapLim = chainLimit(buy, str(x.hits[0].price)); if (!lim || !cheapLim) return null;
    const total = (q) => (q && dec(q.totalMinima)) || zero;
    const cheap = await quote(str(cheapLim), str(amount)), atLimit = await quote(str(lim), str(amount));
    const q = sweepSplit(amount, total(cheap), x.offered, total(atLimit));
    if (q.chainQ.v === 0n || q.fastQ.v === 0n) return null;
    const chain = await quote(str(lim), str(q.chainQ));
    if (total(chain).v === 0n) return null;
    const fast = plan(book, buy, priceText, str(q.fastQ), null);   // the FAST part as the page takes it (best first, minimum remainder)
    const chainQ = total(chain), chainUsd = dec(chain.totalUsdt) || zero;
    return { limit: lim, chainQ, chainUsd, route: routeName(chain), fastQ: q.fastQ, fastTake: fast.take, fastCost: fast.cost, avg: sweepAvg(chainQ, chainUsd, fast.take, fast.cost) };
  }
  /** What a reviewed plan tells the page at the click (renderer/dexicon/mds.js ACTS.place): the page signs only when
   *  its own book still says the same. */
  const expectOf = (pl) => (pl.fast ? { expect: "take", take: str(pl.take), worst: str(pl.worst || zero) } : { expect: "rest" });
  /** The book the Trade ticket plans on: the page's own FAST orders (Page.state.fast: what the click will act on)
   *  with this node's own orders from the read model (for "only your own orders"); the read model alone until the
   *  page has spoken. */
  const tradeBook = (book, pageFast) => (Array.isArray(pageFast) ? Object.assign({}, book || {}, { fast: pageFast.concat(((book && book.fast) || []).filter(o => o.ours)) }) : book);
  /** The amount a % button fills (TradeView.applyPercent): of the exact MINIMA on offer at that price when FAST orders
   *  cross, capped by the user's free funds; else of the free funds. Cut to 8 decimals. null: no price or no funds read. */
  function percent(book, buy, priceText, pct, f) {
    const price = dec(priceText); if (!price || price.v === 0n || !f || !f.known) return null;
    const free = freeFor(f, buy), cap = buy ? div(free, price, 8) : down(free, 8), offer = crossing(book, buy, price).offered;
    const of = (a) => down(div(mul(a, dec(String(pct))), dec("100"), 8), 8);
    return offer.v > 0n ? min(of(offer), cap) : of(cap);
  }

  /** The inline review: exactly what the click signs. One click is the phone's rule for FAST; nothing is hidden. */
  function review(pl, relays) {
    if (!pl.ok) return [];
    const side = pl.buy ? "BUY" : "SELL", L = [];
    if (pl.stuck) {
      L.push(I18N.t("FAST orders cross this price, but none can be taken in this amount: a partial take must leave at least 1 MINIMA on the maker's order. Nothing would be traded and no order would be placed. Change the amount."));
    } else if (pl.fast) {
      L.push(I18N.t("One click signs and sends: {side} {take} MINIMA from {takes} FAST {buy}{takes2}, best price first, {buy2}{price} MxUSD per MINIMA.", { side: side, take: fmt(pl.take), takes: pl.takes, buy: (pl.buy ? "ask" : "bid"), takes2: I18N.s(pl.takes), buy2: (pl.buy ? "never above " : "never below "), price: fmtPrice(pl.price) }));
      L.push(pl.buy ? I18N.t("You pay at most {pay} MxUSD and receive {take} MINIMA (average {avg}).", { pay: fmt(pl.pay), take: fmt(pl.take), avg: fmtPrice(pl.avg) })
                    : I18N.t("You pay {take} MINIMA and receive at least {get} MxUSD (average {avg}).", { take: fmt(pl.take), get: fmt(pl.get), avg: fmtPrice(pl.avg) }));
      L.push(I18N.t("Your node signs one transaction per order taken; each maker's node co-signs and posts it. A partial take leaves at least 1 MINIMA on the maker's order or takes it whole."));
      if (pl.rest.v > 0n) L.push(I18N.t("The other {rest} MINIMA is not traded and no order is placed for it.", { rest: fmt(pl.rest) }));
    } else {
      if (pl.ownOnly) L.push(I18N.t("Only your own orders are at this price. Nothing would trade."));
      L.push(I18N.t("One click signs and publishes a FAST order: {side} {amount} MINIMA at {price} MxUSD per MINIMA ({price2} MxUSD in all) on {relays} relay{relays2}.", { side: side, amount: fmt(pl.amount), price: fmtPrice(pl.price), price2: (pl.buy ? "up to " + fmt(up(mul(pl.amount, pl.price), 8)) : I18N.t("at least {price}", { price: fmt(down(mul(pl.amount, pl.price), 8)) })), relays: relays, relays2: I18N.s(relays) }));
      L.push(I18N.t("Nothing is traded now and no coin is locked: the coins stay in your wallet and your node co-signs each fill while it is running. You can change or cancel the order at any time."));
    }
    if (pl.chain) L.push(I18N.t("On-chain orders or pools also reach this price. The second button shows that trade for review before anything is signed."));
    return L;
  }
  /** A refusal or an error, from the engine, the page or the bridge: its own words, with the plain prefix a reader
   *  needs. Nothing is added about what happened to funds unless the text itself says it. */
  // ---- the hidden page frame (renderer/dexicon/mds.js): the taker's engine ----
  // It builds, signs and sends FAST takes, hears their answers and voids the ones never answered. So it must exist
  // whenever the engine is ready, WHICHEVER tab is on screen (0.18.109: it used to be made on the first Dexicon visit,
  // so a take left unanswered by the last session waited for that visit), and it must belong to the engine that is
  // running now (st.epoch: a node restart or a replaced wallet makes a new engine).
  const PAGE_LOAD_MS = 20000;
  const PAGE_FAILED = L_("The trading part of Dexicon did not load, so a trade cannot be sent from here right now. The app is trying again. If this message stays, restart the app.");
  /** What to do with the frame now. have = { epoch, madeAt, heard } of the one that exists, or null.
   *  "make" | "remake" (another engine) | "retry" (it never spoke) | "drop" | "keep" | "none". */
  function pageStep(nodeState, st, have, now) {
    const want = nodeState === "running" && (st ? !!st.ready : !!have);   // a status read that failed tears nothing down (a take may be in flight)
    if (!want) return have ? "drop" : "none";
    if (!have) return "make";
    if (st && st.epoch !== have.epoch) return "remake";
    if (!have.heard && now - have.madeAt > PAGE_LOAD_MS) return "retry";
    return "keep";
  }

  /** The engine's own sentence for "nothing but your own orders at this price" (dexicon/lib/ownskip.js ONLY_OWN) is
   *  ordinary plan feedback, not a failure: "note", everything else that reaches say() unlabelled is an "error". */
  const feedbackKind = (text) => (/^Only your own orders are at this price/.test(String(text == null ? "" : text).trim()) ? "note" : "error");
  /** The one outside price's name, from the engine's own field (status().price.source: "MEXC" | "MEXC via CoinGecko"). */
  const priceName = (source) => I18N.t("MEXC price{source}", { source: (/^MEXC via CoinGecko$/.test(String(source || "")) ? (" " + I18N.t("via CoinGecko")) : "") });
  function refusal(text) {
    const t = String(text == null ? "" : text).replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
    return t || I18N.t("It did not go through, and no reason was given. Look at Activity before trying again.");
  }

  // ---- fills (Orders › My fills, History, the CSV) ----
  /** The exact MxUSD leg of a fill: the maker's record knows received / paid, the taker's gave / got (TradeExport.row). */
  function fillUsd(f) {
    const buy = f.side === "buy", maker = f.role === "maker";
    const u = dec(maker ? (buy ? f.paid : f.received) : (buy ? f.gave : f.got));
    return u && u.v > 0n ? u : mul(dec(f.filled) || zero, dec(f.price) || zero);
  }
  /** A fill's state in plain words. "settling" is posted and waiting for a block: it is not done. */
  function fillState(f) {
    return f.status === "done" ? { chip: I18N.N_("DONE"), tone: "ok", text: I18N.t("in block {block}", { block: (f.block || "?") }) }
      : f.status === "lost" ? { chip: I18N.N_("LOST"), tone: "bad", text: f.reason ? I18N.t("never posted ({reason}): the coins were not spent", { reason: f.reason }) : I18N.t("not in a block after 2 hours: the coins were not spent") }
      // 0.18.117: the node stopped before it answered txnpost (main/dexicon/service.desktop.js POST UNANSWERED)
      : f.status === "unknown" ? { chip: I18N.N_("UNKNOWN"), tone: "live", text: I18N.t("the node stopped before it answered: not known yet whether this trade was posted. Your order was reduced as if it was; the chain decides") }
      : { chip: I18N.N_("WAITING"), tone: "live", text: I18N.t("co-signed and posted, waiting for a block: not final yet") };
  }
  /** Net of SETTLED fills only: signed MINIMA and MxUSD, and the counts (HistoryTab.render). */
  function netSettled(fills) {
    let mp = zero, mn = zero, up_ = zero, un = zero, done = 0;
    for (const f of fills || []) {
      if (f.status !== "done") continue;
      done++;
      const m = dec(f.filled) || zero, u = fillUsd(f);
      if (f.side === "buy") { mp = add(mp, m); un = add(un, u); } else { mn = add(mn, m); up_ = add(up_, u); }
    }
    const signed = (pos, neg) => { const c = cmp(pos, neg); return c === 0 ? { sign: 0, text: "0" } : c > 0 ? { sign: 1, text: "+" + str(sub(pos, neg)) } : { sign: -1, text: "−" + str(sub(neg, pos)) }; };
    return { minima: signed(mp, mn), mxusd: signed(up_, un), done, count: (fills || []).length };
  }
  const CSV_HEADER = "timestamp_utc,block,side,role,minima_delta,mxusd_delta,minima_amount,price,mxusd_notional,order_id,txpowid,proceeds_coinids,counterparty,status";
  /** The Android export, column for column (TradeExport.java): other tools read these names. Cells that a spreadsheet
   *  would run as a formula are quoted with a leading apostrophe. */
  function csv(fills) {
    const cell = (v) => { let t = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(t) && !/^-?[0-9.]+$/.test(t)) t = "'" + t; return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const rows = (fills || []).map(f => {
      const buy = f.side === "buy", m = dec(f.filled) || zero, u = fillUsd(f), price = dec(f.price);
      return [new Date((Number(f.ts) || 0) * 1000).toISOString().replace(/\.\d+Z$/, "Z"), f.block || "", buy ? "BUY" : "SELL", f.role === "maker" ? "MAKER" : "TAKER",
        (buy ? "" : "-") + str(m), (buy ? "-" : "") + str(u), str(m), price ? str(price) : "", str(u), f.orderId || "", f.txpowid || "", (f.coins || []).join(" "), f.maker || f.taker || f.counterparty || "", f.status || ""].map(cell).join(",");
    });
    return [CSV_HEADER].concat(rows).join("\n") + "\n";
  }
  /** Why a relay address cannot be used on the desktop ("" = it can). The host reaches relays over https only, and
   *  never an address of this machine or the local network (main/netfetch.js). */
  function relayProblem(url) {
    let u; try { u = new URL(String(url)); } catch (e) { return I18N.t("Enter a relay address like https://relay.example/dex-relay."); }
    if (u.protocol !== "https:") return I18N.t("On the desktop a relay must be an https address. Nothing was added.");
    if (u.username || u.password || u.search || u.hash) return I18N.t("A relay address has no user name, query or fragment. Nothing was added.");
    if (/^(localhost|127\.|10\.|192\.168\.|\[?::1\]?$)/i.test(u.hostname)) return I18N.t("A relay on this machine or the local network cannot be used from the desktop. Nothing was added.");
    return "";
  }
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  /** "TODAY · 19 NOV" / "18 NOV" (local time), for the day headers of History and Activity */
  function dayLabel(ms, nowMs) { const d = new Date(ms), n = new Date(nowMs), t = d.getDate() + " " + MONTHS[d.getMonth()]; return (d.toDateString() === n.toDateString() ? (I18N.t("TODAY ·") + " ") : "") + t + (d.getFullYear() === n.getFullYear() ? "" : " " + d.getFullYear()); }
  /** How long ago, in whole units cut down (Util.ago) */
  function ago(ms) { const s = Math.floor(Math.max(0, ms) / 1000); if (s < 60) return I18N.t("{s}s ago", { s: s }); const m = Math.floor(s / 60); const rel = (v, unit) => new Intl.RelativeTimeFormat(I18N.tag(), { numeric: "always" }).format(-v, unit);   // "1 minute ago", "3 hours ago", worded in the language on show
    if (m < 60) return rel(m, "minute"); const h = Math.floor(m / 60); if (h < 24) return rel(h, "hour"); return rel(Math.floor(h / 24), "day"); }
  // words chosen by a count in rooms ① and ② (I18N.t(n === 1 ? "part" : "parts")): named here so every catalog must hold them
  const COUNT_WORDS = [N_("are"), N_("block"), N_("blocks"), N_("coin"), N_("coins"), N_("is"), N_("its"), N_("maker"), N_("makers"), N_("need"), N_("needs"), N_("part"), N_("parts"), N_("swap is"), N_("swaps are"), N_("their"), N_("time."), N_("times."),
    N_("it"), N_("them"), N_("key"), N_("keys"), N_("pool"), N_("saved pool"), N_("visible pool"), N_("owner key"), N_("transaction")];

  // ---- what the screens may ask for: the page's thirteen actions (quote: read only, 0.19.375) (renderer/dexicon/mds.js ACTS) and four bridge ops ----
  const ACTS = ["place", "cancelFast", "editFast", "cancelChain", "editChain", "addRelay", "removeRelay", "discover", "refresh", "makerOpen", "makerStop", "makerReview", "quote"];
  const OPS = ["cmd", "sql", "comms", "net", "identity"];
  /** A request from the page's frame, or null when it is not one the shell forwards. */
  function bridgeCall(m) {
    if (!m || m.dxRoom !== 1 || typeof m.id !== "number") return null;
    // 0.19.229: the hidden page never writes the clipboard (it could put an address of its choosing there); identifiers are
    // copied from the app's own screens. Its copy is answered with a refusal, so its promise ends and nothing waits.
    if (m.name === "clip") return { kind: "noclip" };
    if (m.name !== "room.dex" || !m.args || !OPS.includes(m.args.op)) return null;
    const a = m.args, s = (v) => (typeof v === "string" ? v : "");
    if (a.op === "identity") return { kind: "dx", args: { op: "identity" } };   // answered inside the page's frame by the main process, never here
    return { kind: "dx", args: a.op === "cmd" ? { op: "cmd", command: s(a.command) } : a.op === "sql" ? { op: "sql", query: s(a.query) } : a.op === "comms" ? { op: "comms", message: s(a.message) }
      : { op: "net", method: a.method === "POST" ? "POST" : "GET", url: s(a.url), body: a.body == null ? null : s(a.body) } };
  }
  /** A drive message for the page, or an Error for an action that is not on the list. */
  function driveCall(id, act, args) { if (!ACTS.includes(act)) throw new Error("not an action of the Exchange screens: " + act); return { dxRoom: 1, drive: { id, act, args: args || {} } }; }

  return { dec, zero, add, sub, cmp, mul, min, down, up, div, str, fmt, fmtBal, fmtPrice, fmtDown, MIN_REM, floorTake, GROUPS, GROUP_LABELS, ladder, rows, amountText,
    funds, freeFor, crossing, chainCrosses, chainWhy, chainLimit, sweepSplit, sweepAvg, decideBoth, plan, percent, review, expectOf, tradeBook, levelTotal, entryProblem, pageSays, refusal, feedbackKind, priceName, pageStep, PAGE_LOAD_MS, PAGE_FAILED, fillUsd, fillState, netSettled, CSV_HEADER, csv, dayLabel, ago, relayProblem, ACTS, OPS, bridgeCall, driveCall,
    ROOMS, SHARED, TAB_LABEL, gate, storeError, SET_ASIDE, PUT_BACK, money, roomOfView, load, save, pickRoom, pickTab, tabOf, toggleTheme, strip };
});
