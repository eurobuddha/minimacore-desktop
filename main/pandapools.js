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
const { app } = require("electron");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const { createContext, ALL_FILES } = require("./pandapools/loader");
const { makeSqlShim } = require("./pandapools/sqlshim");

const SCAN_EVERY_MS = 12000;          // poll cadence; work only runs when the tip block advances
const VERIFY_FAIL_BLOCKS = 12;        // a CREATE whose reserves never land within this is marked failed (parity)

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
  var spot = ctx.Curve.funded(p) ? ctx.Curve.spotPrice(p) : D(0);   // token per MINIMA
  var kv = ctx.Curve.funded(p) ? ctx.Curve.k(p) : D(0);
  return {
    address: p.address, mxaddress: p.mxaddress || "", opk: p.opk, oadr: p.oadr, tok: p.tok, kmin: String(p.kmin),
    tokName: p.tokName || ctx.PP.tokenLabel({ tok: p.tok, tokName: p.tokName }), tokDecimals: p.tokDecimals || 8,
    reserveM: s(p.reserveM), reserveT: s(p.reserveT), coinidM: p.coinidM || "", coinidT: p.coinidT || "",
    reserveBlock: p.reserveBlock || 0, spot: s(spot), k: s(kv),
  };
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
function pools() { return POOLS.map(serializePool).filter(Boolean); }
function myPools() {
  // A pool is "mine" if we hold a recovery recipe for it (created here) — cross-referenced with the live scan.
  return new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      var mine = {}; recipes.forEach(function (r) { if (r.address) mine[r.address.toLowerCase()] = true; });
      resolve(POOLS.filter(function (p) { return p.address && mine[p.address.toLowerCase()]; }).map(serializePool));
    });
  });
}
function activity() { return new Promise(function (resolve) { ctx.Store.actList(120, function (a) { resolve((a || []).map(function (e) { return { type: e.type, summary: e.summary, txpowid: e.txpowid, ts: e.ts, failed: e.failed, failMsg: e.failMsg, confirmed: e.confirmedOnchain, submitBlock: e.submitBlock }; })); }); }); }
function feed() { return new Promise(function (resolve) { ctx.Store.feedList(100, function (f) { resolve((f || []).map(function (e) { return { pool: e.pool, tokenLabel: e.tokenLabel, kind: e.kind, minimaIn: e.minimaIn, minimaAmt: s(e.minimaAmt), tokenAmt: s(e.tokenAmt), price: s(e.price), ts: e.ts }; })); }); }); }

// ---- actions (promise wrappers over PoolMgr's {ok,fail} callbacks) ----
function poolByAddress(addr) { for (var i = 0; i < POOLS.length; i++) if (POOLS[i].address && POOLS[i].address.toLowerCase() === String(addr || "").toLowerCase()) return POOLS[i]; return null; }

function quoteSwap(tok, minimaToToken, amountIn) {
  if (!ready || !ctx) return { ok: false };                        // may be called over IPC before init() completes
  var pair = POOLS.filter(function (p) { return p.tok && p.tok.toLowerCase() === String(tok).toLowerCase(); });
  var route = ctx.Router.route(pair, minimaToToken, amountIn);
  return route;
}

async function swap(tok, minimaToToken, amountIn, minQuote) {
  await init();
  var route = quoteSwap(tok, minimaToToken, amountIn);
  if (!route.ok) throw new Error("No route — the trade is too small for the available pools.");
  // Slippage floor: the confirmed quote was `minQuote`; if reserves moved between confirm and execute so the fresh
  // route yields materially less (>3%), abort rather than fill worse than the user agreed to. (The tx itself is
  // always covenant-valid — it spends the exact scanned coins — so staleness normally fails closed; this guards the
  // narrow window where POOLS refreshed to a worse price between the confirm and the post.)
  if (minQuote) { var floor = D(minQuote).times("0.97"); if (D(route.totalOut).lt(floor)) throw new Error("The price moved beyond your quote — nothing was swapped. Re-check the quote and try again."); }
  return withTimeout(new Promise(function (resolve, reject) {
    ctx.PoolMgr.swap(route, minimaToToken, {
      ok: function (txpowid) {
        ctx.Store.actRecord("SWAP", (minimaToToken ? "Bought " : "Sold ") + s(route.totalOut) + " for " + s(route.totalIn), txpowid, lastTip, "");
        emitter.emit("update"); resolve({ txpowid: txpowid, totalIn: s(route.totalIn), totalOut: s(route.totalOut) });
      },
      fail: function (msg) { reject(new Error(msg)); },
    });
  }), 200000, "The swap timed out — check Activity and your balance before retrying.");
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
function closePool(addr) { return actionOnPool(addr, function (p, d) { ctx.PoolMgr.close(p, d); }, "WITHDRAW", "Withdrew a pool's reserves"); }
async function migrate(addr, newX, newY) {
  await init();
  var p = poolByAddress(addr); if (!p) throw new Error("Pool not found.");
  return withTimeout(new Promise(function (resolve, reject) { ctx.PoolMgr.migrate(p, newX, newY, { created: function (np, txpowid) { ctx.Store.ownRecord(np); ctx.Store.actRecord("MIGRATE", "Migrated a pool", txpowid, lastTip, np.address); emitter.emit("update"); resolve({ txpowid: txpowid, address: np.address }); }, fail: function (m) { reject(new Error(m)); } }); }),
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
      ctx.PoolMgr.sweepOwnerFunds(oadrs, { swept: function (addresses, coins) {
        if (coins) { ctx.Store.actRecord("COLLECT", "Collected " + coins + " coin(s) to your wallet", "", lastTip, ""); emitter.emit("update"); }
        resolve({ addresses: addresses, coins: coins });
      } });
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
      function fin() { if (--pending === 0) resolve({ json: JSON.stringify({ pandapools_backup: 1, pools: pools }, null, 2) }); }
      recipes.forEach(function (r) {
        var e = { addr: r.address || "", mx: r.mxaddress || "", opk: r.opk || "", oadr: r.oadr || "",
          tok: r.tok || "", dec: (r.tokDecimals == null ? 8 : r.tokDecimals), kmin: r.kmin || "0", script: r.script || "" };
        pools.push(e);
        var f = funded[(r.address || "").toLowerCase()];
        if (f && f.coinidM && f.coinidT) {
          nodeCmd("coinexport coinid:" + f.coinidM).then(function (jm) {
            var rm = jm && jm.response; if (rm && rm.data) e.cm = rm.data;
            nodeCmd("coinexport coinid:" + f.coinidT).then(function (jt) { var rt = jt && jt.response; if (rt && rt.data) e.ct = rt.data; fin(); }).catch(fin);
          }).catch(fin);
        } else fin();
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
    var total = pools.length, fin = 0, ok = 0;
    pools.forEach(function (e) {
      restoreOne(e, function (good) {
        if (good) ok++;
        if (++fin === total) {
          // Regenerate any missing $OPK owner keys — a seed-only restore only brings back the 64 defaults, so a
          // newaddress owner key must be re-issued in order for restored pools to be closeable/collectable.
          var opks = pools.map(function (x) { return x && x.opk; }).filter(Boolean);
          ctx.PoolMgr.ensureOwnerKeys(opks, function (regen) { emitter.emit("update"); scanNow().catch(function () {}); resolve({ restored: ok, total: total, regen: regen }); });
        }
      });
    });
  }), 240000, "Restore timed out — check My LP; some pools may have been re-tracked.");
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
function importCoin(data, next) { if (!data) { next(); return; } nodeCmd("coinimport track:true data:" + data).then(function () { next(); }).catch(function () { next(); }); }

module.exports = {
  emitter, init, startLoop, stopLoop, scanNow, flush,
  pools, myPools, activity, feed, quoteSwap: function (tok, m, a) { var r = quoteSwap(tok, m, a); return r.ok ? { ok: true, totalIn: s(r.totalIn), totalOut: s(r.totalOut), effPrice: s(r.effPrice), poolsUsed: r.poolsUsed, poolsAvailable: r.poolsAvailable } : { ok: false, notReady: !ready }; },
  swap, createPool, deposit, close: closePool, migrate, collectToWallet, backup, restore,
  _setRunner, _setDataDir,
};
