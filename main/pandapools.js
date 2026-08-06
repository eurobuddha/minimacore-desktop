/*
 * pandapools.js — PandaPools orchestrator (main process). The AMM logic itself is REUSED VERBATIM from the MDS
 * MiniDapp (main/pandapools/*.js, copied byte-identical from ~/Projects/pandapools-mds for 3-way parity). This
 * module only provides the runtime the reused code expects and the read-model / actions the renderer calls:
 *
 *   • an `MDS` shim: MDS.cmd → the node over RPC (mirrors mail.js's runner), MDS.sql → sql.js, MDS.log → console,
 *     MDS.net.GET → fetch, MDS.init → captured so we drive service.js's inited/NEWBLOCK from our own timer.
 *   • a block-poll loop (like mail.js startLoop): on each new tip run Book.scan (the UI pool list), fire service.js's
 *     background NEWBLOCK (discovery snapshot + feed + keep-fresh + re-announce), resume any pending sign, verify.
 *   • read-model getters (Decimals serialised to strings for IPC) + promise-wrapped action methods over PoolMgr.
 *
 * Fund-moving + parity logic lives ENTIRELY in the reused files (covenant/curve/router/book/poolmgr/store/service).
 */
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const { createContext, ALL_FILES } = require("./pandapools/loader");
const { makeSqlShim } = require("./pandapools/sqlshim");
const { fetchJson } = require("./netfetch");

const SCAN_EVERY_MS = 12000;          // poll cadence; work only runs when the tip block advances
const VERIFY_FAIL_BLOCKS = 12;        // a CREATE whose reserves never land within this is marked failed (parity)

// ---- external market price (MEXC MINIMA/USDT) — the create-flow price anchor (parity with the MDS dapp) ----
// PandaPools only creates MINIMA / USDT pools (the pair with a live market feed), so a pool always opens at the
// true rate. USDT_TOKENID is the on-chain mxUSDT id; ONLY this token is poolable (no mispriceable pools).
const USDT_TOKENID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const MKT_DEPTH = "https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20";
const MKT_BOOK = "https://api.mexc.com/api/v3/ticker/bookTicker?symbol=MINIMAUSDT";
const MKT_MIN_USDT = 25, MKT_FRESH_MS = 5 * 60000, MKT_GAP_MS = 30000;
let mktMid = 0, mktAt = 0, mktLastTry = 0, mktFetching = false;
function isMarketFed(tid) { return !!tid && String(tid).toLowerCase() === USDT_TOKENID.toLowerCase(); }

const emitter = new EventEmitter();
let ctx = null;                        // the vm context holding the reused globals (Book, PoolMgr, Store, Curve, Router, PP)
let sqlShim = null;
let serviceHandler = null;            // service.js's MDS.init callback (we fire inited/NEWBLOCK into it)
let ready = false, initPromise = null;
let scanTimer = null, lastTip = 0, scanning = false, scanStartTs = 0;
let POOLS = [];                        // latest funded pools from Book.scan (Decimal reserves)
let dataDir = null;

// swappable node-command runner (overridable in tests via _setRunner) — mirrors mail.js:42-45.
let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
function _setDataDir(d) { dataDir = d; }
function nodeCmd(cmd) { return runner(cmd); }

function buildMds() {
  return {
    // two-arg then(): a throw inside the success cb must NOT fall through to the error handler (double-invoke →
    // negative `pending` in the counted-completion scans → a wedged scan). One reply = exactly one cb call.
    cmd: function (command, cb) { runner(command).then(function (r) { if (cb) cb(r); }, function () { if (cb) cb({ status: false }); }); },
    sql: sqlShim.sql,
    // history.js pages the node's `history` into the permanent mirror and adapts its page size downward on
    // any page that fails. The 256 KB reply cap that forces the Android app down to max:1 lives in the
    // ANDROID BROADCAST RECEIVER (MinimaReceiver.MAX_MESSAGE_LEN), not in the node — and this transport is
    // the node's own HTTP RPC, which imposes no size limit at all (see main/rpc.js: it simply accumulates the
    // body). So page far harder here; a backfill that takes hours at max:64 finishes in minutes at 512.
    historyPageMax: 512,
    log: function () { /* console.log.apply(console, arguments); */ },
    init: function (cb) { serviceHandler = cb; },                    // capture — we drive the events ourselves
    net: { GET: function (url, cb) { if (cb) cb({ status: false }); } },   // MEXC ticker is optional; stubbed
  };
}

async function init() {
  if (ready) return;
  if (initPromise) return initPromise;
  initPromise = (async function () {
    const dir = dataDir || app.getPath("userData");
    sqlShim = await makeSqlShim(path.join(dir, "pandapools.sqlite"));
    ctx = createContext(buildMds(), ALL_FILES);                     // loads all reused files; service.js registers via MDS.init
    await new Promise(function (r) { ctx.Store.init(function () { r(); }); });
    if (serviceHandler) serviceHandler({ event: "inited" });         // boot service.js (coinnotify cleanup + retrackOwn + first scan)
    ready = true;
  })().catch(function (e) { initPromise = null; throw e; });         // don't cache a rejection → a transient init failure can retry
  return initPromise;
}
function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) { /* best effort */ } }
/** On a wallet seed restore the identity changed. Drop the loaded context + cached pools and wipe the local store,
 *  so the background keep-fresh worker stops churning on the previous seed's (now unspendable) pools and My LP clears.
 *  Recovery recipes are for the previous wallet and are re-importable from a PandaPools backup. Mirrors mail's invalidate. */
function invalidate() {
  try { stopLoop(); } catch (e) {}
  try { if (sqlShim) sqlShim.flush(); } catch (e) {}
  try { fs.unlinkSync(path.join(dataDir || app.getPath("userData"), "pandapools.sqlite")); } catch (e) {}   // fresh store next init
  ctx = null; serviceHandler = null; sqlShim = null; ready = false; initPromise = null;
  POOLS = []; lastTip = 0; scanning = false; scanStartTs = 0; lastQuotes = {};   // stale routes reference the old seed's pools
  emitter.emit("update");
  startLoop();                                                    // re-init under the new seed on the next tick
}

// ---- helpers ----
function currentBlock() {
  return nodeCmd("block").then(function (b) {
    var resp = b && b.response;
    return parseInt(resp && (resp.block != null ? resp.block : resp), 10) || 0;
  }).catch(function () { return 0; });
}
function D(x) { return ctx.PP.dec(x); }
function s(d) { try { return ctx.PP.plain(d); } catch (e) { return "0"; } }
/** Reject a fund action that never settles (a dropped PoolMgr callback / a node command that never returns). */
function withTimeout(p, ms, msg) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(msg)); }, ms); })]); }

/** A Book pool (Decimal reserves) → a JSON-safe object for the renderer. */
function serializePool(p) {
  if (!p) return null;
  var funded = ctx.Curve.funded(p);
  var spot = funded ? ctx.Curve.spotPrice(p) : D(0);               // token per MINIMA
  var kv = funded ? ctx.Curve.k(p) : D(0);
  return {
    address: p.address, mxaddress: p.mxaddress || "", opk: p.opk, oadr: p.oadr, tok: p.tok, kmin: String(p.kmin),
    tokName: p.tokName || ctx.PP.tokenLabel({ tok: p.tok, tokName: p.tokName }), tokDecimals: p.tokDecimals || 8,
    reserveM: s(p.reserveM), reserveT: s(p.reserveT), coinidM: p.coinidM || "", coinidT: p.coinidT || "",
    reserveBlock: p.reserveBlock || 0, spot: s(spot), k: s(kv),
    feeGrowthPct: funded ? s(ctx.Curve.feeGrowth(p).times(100)) : "0",   // fees accrued (K/KMIN − 1), % — the donor's "fees accrued"
  };
}
/** My-LP economics, ported from the donor lpCard: value, pool price, fees earned, price move, IL, age, health. */
function serializeMyPool(p, snap) {
  var value = D(p.reserveM).times(2);                             // both legs ≈ 2× the MINIMA reserve
  var feeBase = (snap && snap.feeBaseK && snap.feeBaseK.gt(0)) ? snap.feeBaseK : D(p.kmin || 0);
  var k = ctx.Curve.k(p);
  var growth = feeBase.gt(0) ? Math.max(0, Number(k.div(feeBase)) - 1) : 0;
  var feeMult = Math.sqrt(1 + growth);
  var feesMinima = Number(value) * (1 - 1 / feeMult);
  var kmin = D(p.kmin || 0);
  var out = {
    address: p.address, tok: p.tok, tokName: p.tokName || ctx.PP.tokenLabel({ tok: p.tok, tokName: p.tokName }),
    tokDecimals: p.tokDecimals || 8, reserveM: s(p.reserveM), reserveT: s(p.reserveT),
    value: s(value), poolPrice: s(ctx.Curve.spotPrice(p)), feesMinima: feesMinima, feesPct: growth * 100,
    kratio: kmin.gt(0) ? Number(k.div(kmin)) : 1,
  };
  if (snap && snap.initPrice && snap.initPrice.gt(0) && ctx.Curve.spotPrice(p).gt(0)) {
    var ratio = Number(ctx.Curve.spotPrice(p)) / Number(snap.initPrice);
    out.priceMove = (ratio - 1) * 100;
    out.il = (2 * Math.sqrt(ratio) / (1 + ratio) - 1) * 100;      // vs holding
    out.ageBlocks = (lastTip && snap.block) ? Math.max(0, lastTip - snap.block) : 0;
  }
  return out;
}

// ---- the block-poll loop (mirrors mail.js startLoop) ----
function startLoop() {
  if (scanTimer) return;
  var tick = function () {
    currentBlock().then(function (tip) {
      if (tip && tip !== lastTip) { lastTip = tip; runCycle(tip); }
    }).catch(function () {});
  };
  init().then(tick).catch(function () {});
  scanTimer = setInterval(function () { init().then(tick).catch(function () {}); }, SCAN_EVERY_MS);
}
function stopLoop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

function runCycle(tip) {
  if (scanning && (Date.now() - scanStartTs) < 120000) return;   // one cycle at a time, with a 2-min stuck-guard
  scanning = true; scanStartTs = Date.now();
  // 1) UI discovery — Book.scan gives the funded pool list the renderer trades on.
  try { ctx.Book.scan(function (pools) {
    POOLS = pools || [];
    scanning = false;                 // reset BEFORE emitting, so a throwing update-listener can't leave it wedged
    emitter.emit("update");
    // 2) background engine — service.js does its own discovery snapshot + feed + keep-fresh + re-announce.
    try { if (serviceHandler) serviceHandler({ event: "NEWBLOCK" }); } catch (e) {}
    // 3) resume any pending signature (harmless on a full-RPC node), then verify pending CREATEs.
    try { ctx.PoolMgr.onNewBlock(); } catch (e) {}
    verifyPendingActivity(tip);
  }); } catch (e) { scanning = false; }   // a synchronous throw must not wedge the cycle (the 2-min guard also recovers)
}

/** Mark a CREATE activity 'confirmed' once its covenant reserves land, or 'failed' after VERIFY_FAIL_BLOCKS. */
function verifyPendingActivity(tip) {
  if (!ctx) return;                                              // an invalidate() may have nulled ctx while this cycle was in flight
  ctx.Store.actList(120, function (acts) {
    acts.forEach(function (a) {
      if (a.type !== "CREATE" || !a.refaddr || !a.txpowid || a.confirmedOnchain || a.failed) return;
      nodeCmd("coins address:" + a.refaddr).then(function (j) {
        var cs = (j && j.status && Array.isArray(j.response)) ? j.response : [];
        var funded = cs.some(function (c) { return c && c.spent !== true; });
        if (funded) { ctx.Store.actSetStatus(a.txpowid, "confirmed", ""); emitter.emit("update"); }
        else if (a.submitBlock > 0 && tip - a.submitBlock >= VERIFY_FAIL_BLOCKS) { ctx.Store.actSetStatus(a.txpowid, "failed", "the pool's reserves never landed on-chain"); emitter.emit("update"); }
      }).catch(function () {});
    });
  });
}

// ---- read model (JSON-safe) ----
function pools() { if (!ctx) return []; return POOLS.map(serializePool).filter(Boolean); }
function myPools() {
  // A pool is "mine" if we hold a recovery recipe for it (created here) — cross-referenced with the live scan.
  if (!ctx) return Promise.resolve([]);
  return new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      var mine = {}; recipes.forEach(function (r) { if (r.address) mine[r.address.toLowerCase()] = true; });
      var owned = POOLS.filter(function (p) { return p.address && mine[p.address.toLowerCase()]; });
      if (!owned.length) { resolve([]); return; }
      var pending = owned.length, out = [];
      owned.forEach(function (p) {                                 // fetch each pool's LP baseline (feeBaseK/initPrice/block) for the economics
        ctx.Store.lpGet(p.address, function (snap) { out.push(serializeMyPool(p, snap)); if (--pending === 0) resolve(out); });
      });
    });
  });
}
// `confirmed` must use the shared Store.confirmed() (block-count fallback for swaps), NOT the raw
// confirmedOnchain flag — the on-chain verifier only ever confirms CREATE rows (they have a covenant address
// to check), so reading the flag alone left SWAP/DEPOSIT/etc. stuck on "Confirming…" forever. lastTip is the
// live chain tip (updated every block by the scan cycle).
function activity() { if (!ctx) return Promise.resolve([]); return new Promise(function (resolve) { ctx.Store.actList(120, function (a) { resolve((a || []).map(function (e) { return { type: e.type, summary: e.summary, txpowid: e.txpowid, ts: e.ts, failed: e.failed, failMsg: e.failMsg, confirmed: ctx.Store.confirmed(e, lastTip), submitBlock: e.submitBlock }; })); }); }); }
function feed() { if (!ctx) return Promise.resolve([]); return new Promise(function (resolve) { ctx.Store.feedList(100, function (f) { resolve((f || []).map(function (e) { return { pool: e.pool, tokenLabel: e.tokenLabel, kind: e.kind, minimaIn: e.minimaIn, minimaAmt: s(e.minimaAmt), tokenAmt: s(e.tokenAmt), price: s(e.price), ts: e.ts }; })); }); }); }

/**
 * The per-pool statement CSV: what you put in, your own trades, what is in the pool now, and the profit.
 *
 * Built from the permanent pp_history mirror (history.js keeps it topped up) plus the live reserves from the
 * current scan, so the file and the Pools tab cannot disagree. Syncs first, because a statement built on a
 * half-filled history would be quietly incomplete — the worst way for an accounting file to be wrong.
 */
function statement() {
  if (!ctx) return Promise.resolve({ csv: "", rows: 0, backfilled: false });
  return new Promise(function (resolve) {
    ctx.History.sync(function () {
      // Same ownership test as the My LP tab: a pool is ours if we hold a recovery recipe for it, and the
      // reserves come from the live scan — so the statement and the pool card read the same numbers.
      ctx.Store.ownAll(function (recipes) {
        var owned = {}; (recipes || []).forEach(function (r) { if (r.address) owned[r.address.toLowerCase()] = true; });
        ctx.Store.knownAddrsGet(function (known) {
          ctx.Store.histAll(function (rows) {
            ctx.Store.kvGet("hist_backfilled", function (done) {
              var mine = POOLS.filter(function (p) { return p.address && owned[p.address.toLowerCase()]; })
                .map(function (p) {
                  return { address: p.address, label: ctx.PP.tokenLabel(p), reserveM: s(p.reserveM), reserveT: s(p.reserveT) };
                });
              var csv = ctx.Statement.build(rows, mine, known,
                { at: Date.now(), version: app.getVersion(), backfilled: done === "true" });
              resolve({ csv: csv, rows: rows.length, pools: mine.length, backfilled: done === "true" });
            });
          });
        });
      });
    });
  });
}

/** Keep the permanent history mirror current. Fire-and-forget; safe to call every block. */
function syncHistory() {
  if (!ctx || ctx.History.isRunning()) return Promise.resolve(0);
  return new Promise(function (resolve) { ctx.History.sync(function (added) { resolve(added); }); });
}

// ---- actions (promise wrappers over PoolMgr's {ok,fail} callbacks) ----
function poolByAddress(addr) { for (var i = 0; i < POOLS.length; i++) if (POOLS[i].address && POOLS[i].address.toLowerCase() === String(addr || "").toLowerCase()) return POOLS[i]; return null; }

var lastQuotes = {}, quoteCounter = 0;   // quoteId → {route, minimaToToken} — the EXACT confirmed route (frozen-quote, like the donor)
function pairPoolsFor(tok) { return POOLS.filter(function (p) { return p.tok && p.tok.toLowerCase() === String(tok).toLowerCase(); }); }
/** Price impact %, exactly the donor's impact(r): |effPrice − spotBefore| / spotBefore × 100. */
function priceImpactOf(route) {
  var sb = route.spotBefore;
  if (!sb || sb.isZero()) return "0.00";
  return route.effPrice.minus(sb).abs().div(sb).times(100).toDP(2, ctx.PP.D.ROUND_HALF_UP).toString();
}
/** Pair summary for the swap page's pool line (shown before an amount is entered): pool count + aggregate MINIMA depth. */
function pairInfo(tok) {
  if (!ctx) return { pools: 0, depth: "0" };
  var pair = pairPoolsFor(tok);
  return { pools: pair.length, depth: s(ctx.Router.aggregateDepth(pair)) };
}
/** Per-token aggregates for the Pools tab "Combined" (collective-pool) view — reuses the engine's own Curve/Router
 *  aggregation (Decimal-exact, the SAME numbers the swap router uses), so the combined card is a pure display, no
 *  new pool math. Groups by token (Router.byToken, funded only, deepest pair first). Returns
 *  [{tok, name, count, totalMinima, totalToken, price, depth}]. */
function aggregateInfo() {
  if (!ctx) return [];
  return ctx.Router.byToken(POOLS).map(function (g) {
    var totM = ctx.Curve.totalMinima(g);
    var price = ctx.Curve.aggregatePrice(g);            // reserve-weighted token per MINIMA
    return {
      tok: g[0].tok,
      name: ctx.PP.tokenLabel({ tok: g[0].tok, tokName: g[0].tokName }),
      count: g.length,
      totalMinima: s(totM),
      totalToken: s(totM.times(price)),                 // summed token side, derived from the two aggregates
      price: s(price),
      depth: s(ctx.Router.aggregateDepth(g))            // routable MINIMA depth (deepest MAX_POOLS)
    };
  });
}
/** Quote a swap AND STASH the exact route under a quoteId — the renderer confirms this quote, then swap(quoteId)
 *  posts THAT route verbatim (frozen-quote; no re-quote, no slippage floor — matches native/MDS confirmSwap→doSwap). */
function quoteAndStash(tok, minimaToToken, amountIn) {
  if (!ready || !ctx) return { ok: false, notReady: !ready };
  var pl = pairPoolsFor(tok);
  var route = ctx.Router.route(pl, minimaToToken, amountIn);
  if (!route.ok) return { ok: false };
  var qid = ++quoteCounter;
  var tokenLabel = ctx.PP.tokenLabel({ tok: tok, tokName: pl[0] && pl[0].tokName }) || "token";
  lastQuotes[qid] = { route: route, minimaToToken: minimaToToken, tokenLabel: tokenLabel };
  var ids = Object.keys(lastQuotes);
  if (ids.length > 40) ids.sort(function (a, b) { return a - b; }).slice(0, ids.length - 30).forEach(function (k) { delete lastQuotes[k]; });  // keep the recent ~30
  return { ok: true, totalIn: s(route.totalIn), totalOut: s(route.totalOut), effPrice: s(route.effPrice),
    priceImpact: priceImpactOf(route), poolsUsed: route.poolsUsed, poolsAvailable: route.poolsAvailable,
    capped: !!route.capped, maxPools: ctx.Router.MAX_POOLS, quoteId: qid };
}

// Post the EXACT confirmed route (frozen-quote). If the pool moved since the quote, the covenant/txncheck rejects it
// (fail-closed) and the user keeps their funds — the donor's "no slippage surprise" guarantee. No re-quote, no floor.
async function swap(quoteId) {
  await init();
  var q = lastQuotes[quoteId];
  if (!q || !q.route || !q.route.ok) throw new Error("This quote expired — re-enter the amount to get a fresh quote.");
  var route = q.route, minimaToToken = q.minimaToToken;
  return withTimeout(new Promise(function (resolve, reject) {
    ctx.PoolMgr.swap(route, minimaToToken, {
      ok: function (txpowid) {
        // Always frame from MINIMA's side: paying MINIMA to get the token = SOLD MINIMA; paying the token to get
        // MINIMA = BOUGHT MINIMA. (minimaToToken → totalIn is the MINIMA leg; else totalOut is the MINIMA leg.)
        var minimaAmt = minimaToToken ? route.totalIn : route.totalOut;
        var tokenAmt = minimaToToken ? route.totalOut : route.totalIn;
        ctx.Store.actRecord("SWAP", (minimaToToken ? "Sold " : "Bought ") + s(minimaAmt) + " MINIMA for " + s(tokenAmt) + " " + (q.tokenLabel || "token"), txpowid, lastTip, "");
        delete lastQuotes[quoteId];
        emitter.emit("update"); resolve({ txpowid: txpowid, totalIn: s(route.totalIn), totalOut: s(route.totalOut) });
      },
      fail: function (msg) { reject(new Error(msg)); },
    });
  }), 200000, "The swap timed out — check Activity and your balance before retrying.");
}

// ---- MEXC market price (create-flow anchor) — mirrors the MDS dapp refreshMarket / resolveAnchor ----
function marketFresh() { return mktMid > 0 && (Date.now() - mktAt) <= MKT_FRESH_MS; }
function effLevel(side) {            // price where cumulative price*qty first reaches MKT_MIN_USDT (dust-proof)
  if (!Array.isArray(side)) return 0;
  var cum = 0;
  for (var i = 0; i < side.length; i++) {
    var px = parseFloat(side[i][0]), qty = parseFloat(side[i][1]);
    if (!(px > 0) || !(qty > 0)) return 0;
    cum += px * qty;
    if (cum >= MKT_MIN_USDT) return px;
  }
  return 0;
}
function acceptMid(b, a) {
  if (!(b > 0) || !(a > 0) || b > a) return;
  if ((a - b) / a >= 0.2) return;    // book too thin/wide to quote
  var m = (a + b) / 2;
  if (m > 0 && isFinite(m)) { mktMid = m; mktAt = Date.now(); }
}
/** Best-effort MEXC refresh (rate-limited to MKT_GAP_MS). Depth book first (dust-proof mid), then bookTicker. */
async function refreshMarket() {
  var now = Date.now();
  if (mktFetching || now - mktLastTry < MKT_GAP_MS) return;   // rate-limited → keep the cached mid
  mktFetching = true; mktLastTry = now;
  try {
    var j = await fetchJson(MKT_DEPTH);
    if (j && (j.bids || j.asks)) { acceptMid(effLevel(j.bids), effLevel(j.asks)); return; }
    var k = await fetchJson(MKT_BOOK);
    if (k) acceptMid(parseFloat(k.bidPrice), parseFloat(k.askPrice));
  } catch (e) { /* market data is optional — the create flow falls back to live-pool spot, then manual */ }
  finally { mktFetching = false; }
}
function fmtMid() { return String(parseFloat(mktMid.toPrecision(12))); }   // trim float-division noise; keep real precision
/** Read-only market snapshot for the swap-page market line + the create ↻ Price button. Refreshes if stale.
 *  Pure MEXC — does NOT require the node/ctx, so it works before/independent of init(). */
async function market() {
  if (!marketFresh()) await refreshMarket();
  return { mid: marketFresh() ? fmtMid() : null, fresh: marketFresh(), at: mktAt };
}
/** Opening-price anchor for create, best-first: (1) fresh MEXC mid; (2) aggregate spot of live USDT pools; else null.
 *  MEXC (tier 1) needs no node; only the tier-2 live-pool fallback needs ctx/POOLS. */
async function createAnchor() {
  if (!marketFresh()) await refreshMarket();
  if (marketFresh() && mktMid > 0) return { price: fmtMid(), source: "MEXC market" };
  try { await init(); } catch (e) { return { price: null, source: "" }; }
  var live = POOLS.filter(function (p) { return p && isMarketFed(p.tok); });
  var agg = ctx && ctx.Curve.aggregatePrice(live);
  if (agg && agg.gt(0)) return { price: s(agg), source: "live pools" };
  return { price: null, source: "" };
}
/** The single market-fed token id (mxUSDT) — the renderer gates create to this, mirroring the dapp. */
function marketToken() { return { usdt: USDT_TOKENID }; }

/** Opening-price + KMIN preview for the manual-bootstrap create form (tier-3) — pure, no spend. */
function createPreview(tokDecimals, x0, y0) {
  if (!ctx) return { ok: false, msg: "Starting up…" };
  try {
    var x = D(x0), y = D(y0);
    if (x.lte(0) || y.lte(0)) return { ok: false, msg: "Enter both amounts." };
    if (!ctx.Covenant.sizeOk(x, y)) return { ok: false, msg: "Amounts too large (x × y must be < 2^64)." };
    var yc = y.toDP(parseInt(tokDecimals, 10) || 8, ctx.PP.D.ROUND_DOWN);
    if (yc.lte(0)) return { ok: false, msg: "Token amount is below the token's smallest unit." };
    return { ok: true, price: s(yc.div(x)), kmin: ctx.Covenant.kmin(x, yc) };   // token per MINIMA + the product floor
  } catch (e) { return { ok: false, msg: e.message }; }
}

async function createPool(tokenid, tokDecimals, x0, y0) {
  await init();
  return withTimeout(new Promise(function (resolve, reject) {
    ctx.PoolMgr.createPool(tokenid, tokDecimals, x0, y0, {
      created: function (p, txpowid) {
        ctx.Store.ownRecord(p);                                         // recovery recipe (Layer 1)
        ctx.Store.lpRecord(p.address, p.reserveM, p.reserveT, lastTip); // LP fee/IL baseline
        ctx.Store.actRecord("CREATE", "Created a pool with " + s(p.reserveM) + " MINIMA", txpowid, lastTip, p.address);
        emitter.emit("update"); resolve({ txpowid: txpowid, address: p.address });
      },
      fail: function (msg) { reject(new Error(msg)); },
    });
  }), 200000, "Creating the pool timed out — check Activity and your balance before retrying.");
}

function actionOnPool(addr, fn, label, summary) {
  return init().then(function () {
    var p = poolByAddress(addr);
    if (!p) return Promise.reject(new Error("Pool not found in the current scan — try again in a moment."));
    return withTimeout(new Promise(function (resolve, reject) { fn(p, { ok: function (txpowid) { ctx.Store.actRecord(label, summary || (label + " on a pool"), txpowid, lastTip, ""); emitter.emit("update"); resolve({ txpowid: txpowid }); }, fail: function (m) { reject(new Error(m)); } }); }),
      200000, label + " timed out — check Activity and your balance before retrying.");
  });
}
function deposit(addr, addM, addT) { return actionOnPool(addr, function (p, d) { ctx.PoolMgr.deposit(p, addM, addT, d); }, "ADD", "Added liquidity"); }

/** Self-heal the owner key before an owner-signed spend (WITHDRAW / MIGRATE): $OPK is a newaddress key
 *  (index ≥ 64) the node re-derives lazily; a restore regenerates it ASYNCHRONOUSLY, so a spend attempted too
 *  soon fails with "Public Key not found". Re-issue newaddress until it reappears (a no-op if already held; can
 *  only succeed under the pool's creating seed). The hunt is BUDGETED (see poolmgr.js): a key another seed
 *  minted comes back as unreachable instead of burning 256 fresh wallet keys per attempt — cb(foreign) says so. */
const FOREIGN_KEY_MSG = "This pool's owner key belongs to a different seed — this node cannot sign for it. "
  + "Manage this pool on the device/seed that created it.";
function ensureOwnerKey(opk, cb) {
  if (!opk || !ctx || !ctx.PoolMgr || !ctx.PoolMgr.ensureOwnerKeys) return cb(false);
  try {
    ctx.PoolMgr.ensureOwnerKeys([opk], function (regen, unreachable) {
      cb(!!(unreachable && unreachable.indexOf(String(opk).toLowerCase()) !== -1));
    });
  } catch (e) { cb(false); }
}
/** The hunt gate is serial, so an unrelated caller's multi-minute hunt can delay ours past the caller's
 *  withTimeout. Once the UI has said "timed out — retry", a late spend MUST NOT fire — the retry would
 *  double-post against the same coins (both posts sign, burning owner-key leaves; one fails on-chain).
 *  Deadlines sit just under each caller's withTimeout so the guard always fires first. */
var HUNT_SPEND_GUARD_MS = 190000;   // vs the 200s close/migrate withTimeout
function closePool(addr) {
  return actionOnPool(addr, function (p, d) {
    var deadline = Date.now() + HUNT_SPEND_GUARD_MS;
    ensureOwnerKey(p.opk, function (foreign) {
      if (foreign) { d.fail(FOREIGN_KEY_MSG); return; }
      if (Date.now() > deadline) { d.fail("timed out before the owner key was ready — retry"); return; }
      ctx.PoolMgr.close(p, d);
    });
  }, "WITHDRAW", "Withdrew a pool's reserves");
}
async function migrate(addr, newX, newY) {
  await init();
  var p = poolByAddress(addr); if (!p) throw new Error("Pool not found.");
  return withTimeout(new Promise(function (resolve, reject) {
    var deadline = Date.now() + HUNT_SPEND_GUARD_MS;
    ensureOwnerKey(p.opk, function (foreign) {
      if (foreign) { reject(new Error(FOREIGN_KEY_MSG)); return; }
      if (Date.now() > deadline) { reject(new Error("timed out before the owner key was ready — retry")); return; }
      ctx.PoolMgr.migrate(p, newX, newY, { created: function (np, txpowid) { ctx.Store.ownRecord(np); ctx.Store.actRecord("MIGRATE", "Migrated a pool", txpowid, lastTip, np.address); emitter.emit("update"); resolve({ txpowid: txpowid, address: np.address }); }, fail: function (m) { reject(new Error(m)); } });
    });
  }),
    200000, "Migrate timed out — check Activity and your balance before retrying.");
}

/** Forward funds sitting at MY pools' owner addresses ($OADR) onward to the default-64 wallet — so withdrawn
 *  reserves aren't stranded at a newaddress a seed-only restore won't reproduce. Reuses PoolMgr.sweepOwnerFunds. */
async function collectToWallet() {
  await init();
  return withTimeout(new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      var oadrs = (recipes || []).map(function (r) { return r.oadr; }).filter(Boolean);
      if (!oadrs.length) { resolve({ addresses: 0, coins: 0 }); return; }
      var opks = (recipes || []).map(function (r) { return r.opk; }).filter(Boolean);
      // regenerate every owner key first ($OADR returns SIGNEDBY($OPK)) — self-heal the post-restore race.
      // A foreign-seed key doesn't abort the sweep (the other pools' funds still move) — it's reported.
      var deadline = Date.now() + 230000;   // just under this promise's 240s withTimeout (see HUNT_SPEND_GUARD_MS)
      ctx.PoolMgr.ensureOwnerKeys(opks, function (regen, unreachable) {
        if (Date.now() > deadline) { resolve({ addresses: 0, coins: 0, foreign: unreachable ? unreachable.length : 0 }); return; }
        ctx.PoolMgr.sweepOwnerFunds(oadrs, { swept: function (addresses, coins) {
          if (coins) { ctx.Store.actRecord("COLLECT", "Collected " + coins + " coin(s) to your wallet", "", lastTip, ""); emitter.emit("update"); }
          resolve({ addresses: addresses, coins: coins, foreign: unreachable ? unreachable.length : 0 });
        } });
      });
    });
  }), 240000, "Collecting timed out — check your balance; you can retry from My LP.");
}

async function scanNow() { await init(); return new Promise(function (r) { ctx.Book.scan(function (ps) { POOLS = ps || []; emitter.emit("update"); r(pools()); }); }); }

// ---- Recovery (Layer 3): backup + restore. Byte-compatible with native/MDS ({pandapools_backup:1, pools:[…]}),
//      public data only (recipe params + a fresh coinexport of each reserve coin) — no seed, cannot move funds.
async function backup() {
  await init();
  await scanNow();                                                 // freshen POOLS so we can coinexport the current reserve coins
  return withTimeout(new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      recipes = recipes || [];
      if (!recipes.length) { resolve({ empty: true, json: "" }); return; }
      var funded = {};
      POOLS.forEach(function (p) { if (p && p.address && ctx.Curve.funded(p)) funded[p.address.toLowerCase()] = p; });
      var pools = [], pending = recipes.length;
      function fin() { if (--pending === 0) resolve({ json: JSON.stringify({ pandapools_backup: 3, pools: pools }, null, 2) }); }
      recipes.forEach(function (r) {
        var e = { addr: r.address || "", mx: r.mxaddress || "", opk: r.opk || "", oadr: r.oadr || "",
          tok: r.tok || "", dec: (r.tokDecimals == null ? 8 : r.tokDecimals), kmin: r.kmin || "0", script: r.script || "" };
        pools.push(e);
        var f = funded[(r.address || "").toLowerCase()];
        function afterCoins() {
          if (f && f.coinidM && f.coinidT) {
            nodeCmd("coinexport coinid:" + f.coinidM).then(function (jm) {
              var rm = jm && jm.response; if (rm && rm.data) e.cm = rm.data;
              nodeCmd("coinexport coinid:" + f.coinidT).then(function (jt) { var rt = jt && jt.response; if (rt && rt.data) e.ct = rt.data; fin(); }).catch(fin);
            }).catch(fin);
          } else fin();
        }
        // Stamp the owner key's ACTUAL one-time-signature count and the height it was read at. Without it a
        // later restore resumes the regenerated key at leaf 0 and re-signs leaves already spent on-chain.
        if (e.opk && ctx.PoolMgr.readKeyUses) {
          try {
            ctx.PoolMgr.readKeyUses(e.opk, function (uses, kidx) {
              if (uses !== null && uses !== undefined) { e.opkuses = uses; if (lastTip > 0) e.atblock = lastTip; }
              // v3: the key's derivation index — a restore's hunt becomes exact, and a backup restored
              // onto the WRONG seed is proven foreign with zero minted keys. Backfill it locally too: a
              // pre-v3 pool only reveals its index while the node still HOLDS the key — i.e. right now.
              if (kidx >= 0) { e.kidx = kidx; if (ctx.PoolMgr.rememberKidx) ctx.PoolMgr.rememberKidx(e.opk, kidx); }
              afterCoins();
            });
          } catch (err) { afterCoins(); }
        } else afterCoins();
      });
    });
  }), 120000, "Backup timed out — try again.");
}
async function restore(json) {
  await init();
  var root; try { root = JSON.parse(json); } catch (e) { throw new Error("That doesn't look like a PandaPools backup (invalid JSON)."); }
  var pools = root && root.pools;
  if (!root || !root.pandapools_backup || !Array.isArray(pools) || !pools.length) throw new Error("No PandaPools pools found in that backup.");
  return withTimeout(new Promise(function (resolve) {
    // v3 backups carry each owner key's derivation index — remember them BEFORE the hunt so it can run
    // exact (and prove a wrong-seed restore with zero minted keys).
    if (ctx.PoolMgr.rememberKidx) pools.forEach(function (e) { if (e && e.opk && e.kidx >= 0) ctx.PoolMgr.rememberKidx(e.opk, e.kidx); });
    var total = pools.length, fin = 0, ok = 0;
    pools.forEach(function (e) {
      restoreOne(e, function (good) {
        if (good) ok++;
        if (++fin === total) {
          // Regenerate any missing $OPK owner keys — a seed-only restore only brings back the 64 defaults, so a
          // newaddress owner key must be re-issued in order for restored pools to be closeable/collectable.
          var opks = pools.map(function (x) { return x && x.opk; }).filter(Boolean);
          ctx.PoolMgr.ensureOwnerKeys(opks, function (regen, unreachable) {
            var foreignSet = {};
            (unreachable || []).forEach(function (o) { foreignSet[o] = true; });
            // A regenerated key comes back at uses = 0. Wind it forward to where it actually left off
            // BEFORE anything can sign with it — that ordering is the whole fix.
            advanceRestoredKeys(pools, 0, foreignSet, function (warn) {
              emitter.emit("update"); scanNow().catch(function () {});
              resolve({ restored: ok, total: total, regen: regen, foreign: unreachable ? unreachable.length : 0, warn: warn || null });
            });
          });
        }
      });
    });
  }), 240000, "Restore timed out — check My LP; some pools may have been re-tracked.");
}
/** Owner actions other than keep-fresh that could also have signed since the backup. Erring high costs a
 *  leaf out of 262,144; falling short leaks the key. */
const USES_SLACK = 50;

/** Wind each restored owner key forward to the count it had reached. Sequential on purpose — each pass
 *  burns real signatures, and firing them concurrently is the pattern that caused reuse in the first
 *  place. Best-effort per pool, but every failure is REPORTED, never swallowed. Keys the hunt proved to be
 *  another seed's ({@code foreignSet}) are skipped — there is nothing to advance on this node and never
 *  will be; their count already reaches the UI as r.foreign. */
function advanceRestoredKeys(pools, i, foreignSet, done) {
  if (i >= pools.length) { done(null); return; }
  const e = pools[i];
  if (!e || !e.opk || !ctx.PoolMgr.advanceKeyUses) { advanceRestoredKeys(pools, i + 1, foreignSet, done); return; }
  const label = (e.addr || "pool").slice(0, 10) + "…";
  if (foreignSet && foreignSet[String(e.opk).toLowerCase()]) {
    // Skip SILENTLY: the foreign count already reaches the UI as r.foreign, and hijacking the single
    // warn slot here would mask a later pool's security-critical "could not restore the owner key's
    // usage" warning (the warn chain is first-set-wins).
    advanceRestoredKeys(pools, i + 1, foreignSet, done);
    return;
  }
  if (e.opkuses === undefined) {
    // A pre-v2 backup carries no count. Say so rather than quietly resuming at leaf 0.
    advanceRestoredKeys(pools, i + 1, foreignSet, function () {
      done(label + ": this backup predates key-use tracking, so the owner key's signature count is unknown. "
         + "Re-back-up now and avoid reusing this pool.");
    });
    return;
  }
  const target = ctx.PoolMgr.restoreTarget(e.opkuses, e.atblock || 0, lastTip, USES_SLACK);
  ctx.PoolMgr.advanceKeyUses(e.opk, target, null, function (okAdv, finalUses, err) {
    if (okAdv) { advanceRestoredKeys(pools, i + 1, foreignSet, done); return; }
    advanceRestoredKeys(pools, i + 1, foreignSet, function () {
      done(label + ": could not restore the owner key's usage (" + err + "). Do not use this pool until that "
         + "succeeds — signing now could expose the key.");
    });
  });
}

function restoreOne(e, cbRaw) {
  var done = false; function cb(v) { if (done) return; done = true; cbRaw(v); }   // fire once, whatever the .then/.catch does
  if (!e || !e.addr) { cb(false); return; }
  ctx.Store.ownRecord({ address: e.addr, mxaddress: e.mx || "", opk: e.opk || "", oadr: e.oadr || "",
    tok: e.tok || "", tokDecimals: (e.dec == null ? 8 : e.dec), kmin: e.kmin || "0", covenantScript: e.script || "" });
  ctx.Store.knownAddrsAdd([e.addr, e.mx]);
  var script = (e.script && e.script.length) ? e.script : (e.opk && e.oadr && e.tok && e.kmin ? ctx.Covenant.script(e.opk, e.oadr, e.tok, e.kmin) : "");
  if (!script) { cb(true); return; }                              // recipe persisted; no script to re-track
  nodeCmd("newscript trackall:true script:" + ctx.Covenant.scriptArg(script)).then(function () {
    importCoin(e.cm, function () { importCoin(e.ct, function () { cb(true); }); });
  }).catch(function () { cb(true); });
}
function importCoin(data, next) {
  var d = String(data || "");
  if (!d || /\s/.test(d)) { next(); return; }                    // coinexport blobs are a single space-free token; reject anything else (a hostile backup can't smuggle extra command params)
  nodeCmd("coinimport track:true data:" + d).then(function () { next(); }, function () { next(); });
}

module.exports = {
  emitter, init, startLoop, stopLoop, scanNow, flush, invalidate,
  pools, myPools, activity, feed, statement, syncHistory, quoteSwap: quoteAndStash, pairInfo, aggregateInfo, createPreview,
  market, createAnchor, marketToken,
  swap, createPool, deposit, close: closePool, migrate, collectToWallet, backup, restore,
  _setRunner, _setDataDir,
};
