/*
 * pandapools.js — PandaPools orchestrator (main process). The AMM logic itself is REUSED VERBATIM from the MDS
 * MiniDapp (main/pandapools/*.js, copied byte-identical from ../../mds/pandapools-mds for 3-way parity, and
 * digest-pinned by scripts/pandapools-parity.manifest.json). This module only provides the runtime the reused
 * code expects and the read-model / actions the renderer calls:
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
let contextEpoch=0, quarantineRequired=false;

// swappable node-command runner (overridable in tests via _setRunner) — mirrors mail.js:42-45.
let runner = (cmd, opts) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd, Object.assign({ owner: "pandapools" }, opts));   // opts.signal: see poolAbort; owner: main/reserve.js
// One per contextEpoch (0.18.107): invalidate() aborts it, so a signing command of the old engine still queued in
// main/noderun.js is never sent. The queue reads only `.aborted`, so this is that one field and not an AbortController
// (this file is also run inside a bare vm context by its tests, where that global does not exist).
let poolAbort = { aborted: false };
// HOLD (0.18.116): a command that may replace the wallet is about to run in the node (node-manager runResync). The
// engine and its store are kept, but nothing new is done: no scan timer, no init, so no action from a screen (each
// starts with init()), and no SIGNING command reaches the node. release() lifts it.
let held = false, heldLoop = false, busy = 0;
const HELD = "PandaPools is stopped while the wallet is being replaced. It starts again by itself.";
function _setRunner(fn) { runner = fn; }
function _setDataDir(d) { dataDir = d; }
function nodeCmd(cmd) { return runner(cmd); }

// The engine reports a failed action in fixed sentences ("could not mint an owner key…", "Could not identify the input
// signing key."), without what the node answered. The node's own last refusal is kept here, by command NAME only (never
// its arguments), so a screen can show the real reason beside the engine's sentence (lastNodeFailure, mcd:ppWhy).
// Read-only bookkeeping: nothing the engine receives or sends is changed.
let lastFail = null;
function noteFail(command, r) {
  if (!r || r.status !== false) return;
  const error = String(r.error || r.message || "").slice(0, 400);
  if (error) lastFail = { verb: String(command).trim().split(/\s+/)[0].slice(0, 40), error: error, at: Date.now() };
}
function lastNodeFailure() { return lastFail; }
/** For the screens: has the engine started (its saved pools open, the registry scan running)? Read only.
 *  error (0.18.137): why the last start failed, in the engine's or the store's own words ("" = it did not fail, or it
 *  has started since); waitedMs: how long it has been trying. A damaged pandapools.sqlite fails its integrity check on
 *  EVERY start, so without these the room said "starting" for ever and the restore gate never opened. */
let initError = "", firstTry = 0;
function status() { const up = !!(ready && ctx); return { ready: up, block: lastTip || 0, pools: POOLS.length, error: up ? "" : initError, waitedMs: up || !firstTry ? 0 : Date.now() - firstTry,
  store: storeFile() }; }   // store: the whole path, for the set-aside dialog ("quit, then rename it back")
function storeFile() { return path.join(dataDir || app.getPath("userData"), "pandapools.sqlite"); }
/** A store that cannot be opened is MOVED ASIDE under a dated name (main/restore.js moveAside), never deleted, so the
 *  engine can start on an empty one; the pools are then restored from the user's backup file. Only when the last start
 *  failed: a store that opens is never moved. Returns the kept path. The caller starts the engine (startLoop). */
function setAsideStore() {
  if (ready || !initError) throw new Error("PandaPools' store is open, so nothing was moved.");
  if (held) throw new Error(HELD);
  // 0.19.101: an init may be in flight on this very file (the scan loop tries again): it is disowned first (its epoch
  // check then ends it), so it cannot finish beside the init that starts on the empty store.
  contextEpoch++;
  if (ctx && ctx.ActivityChain) { try { ctx.ActivityChain.stop(); } catch (e) {} }
  ctx = null; sqlShim = null; serviceHandler = null;
  const kept = require("./restore").moveAside(storeFile());
  initError = ""; initPromise = null; firstTry = 0; emitter.emit("update");
  return kept;
}

function buildMds() {
  const epoch=contextEpoch, storage=sqlShim, signal=poolAbort;
  return {
    poolDesktop: true, // MiniHub WRITE/block-mode requirement is enforced in the MDS runtime.
    // two-arg then(): a throw inside the success cb must NOT fall through to the error handler (double-invoke →
    // negative `pending` in the counted-completion scans → a wedged scan). One reply = exactly one cb call.
    cmd: function (command, cb) { if(epoch!==contextEpoch){if(cb)cb({status:false});return;}
      if(held&&require("./noderun").SIGNING.test(String(command))){if(cb)cb({status:false,error:HELD});return;}
      busy++;   // hold() waits for what is at the node
      runner(command,{signal:signal}).then(function (r) { busy--; noteFail(command, r); if (cb) cb(epoch===contextEpoch?r:{status:false}); }, function (e) { busy--; noteFail(command, { status: false, error: (e && e.message) || String(e) }); if (cb) cb({ status: false }); }); },
    sql: function(q,cb){if(epoch!==contextEpoch){if(cb)cb({status:false});return;}storage.sql(q,cb);},
    persistRecovery: function(cb) { cb(epoch===contextEpoch&&storage.flushChecked()); },
    archiveGET: function(url,cb) { fetchJson(url).then(cb,function(){cb(null);}); },
    // history.js pages the node's `history` into the permanent mirror and adapts its page size downward on
    // any page that fails. The 256 KB reply cap that forces the Android app down to max:1 lives in the
    // ANDROID BROADCAST RECEIVER (MinimaReceiver.MAX_MESSAGE_LEN), not in the node — and this transport is
    // the node's own HTTP RPC, which imposes no size limit at all (see main/rpc.js: it simply accumulates the
    // body). So page far harder here; a backfill that takes hours at max:64 finishes in minutes at 512.
    historyPageMax: 512,
    notify: (msg) => { try { const { Notification } = require("electron"); if (Notification && Notification.isSupported()) new Notification({ title: "PandaPools", body: String(msg || "") }).show(); } catch (e) { /* headless/test context — the engine falls back to MDS.log */ } },
    log: function () { /* console.log.apply(console, arguments); */ },
    init: function (cb) { serviceHandler = cb; },                    // capture — we drive the events ourselves
    net: { GET: function (url, cb) { if (cb) cb({ status: false }); } },   // MEXC ticker is optional; stubbed
  };
}

async function init() {
  if (held) throw new Error(HELD);
  if (ready) return;
  if (initPromise) return initPromise;
  const epoch=contextEpoch;
  if (!firstTry) firstTry = Date.now();
  initPromise = (async function () {
    const storage = await makeSqlShim(storeFile());
    if(epoch!==contextEpoch)throw new Error("Wallet identity changed during pool initialization.");
    sqlShim=storage;
    ctx = createContext(buildMds(), ALL_FILES);                     // loads all reused files; service.js registers via MDS.init
    await new Promise(function (r) { ctx.Store.init(function () { r(); }); });
    await new Promise(function (resolve, reject) { ctx.ActivityChain.init(function (ok) { if (ok) resolve(); else reject(new Error("Pool transaction storage unavailable")); }); });
    if(epoch!==contextEpoch)throw new Error("Wallet identity changed during pool initialization.");
    if(quarantineRequired){
      const held=storage.sql("UPDATE pp_ownpools SET signing_unverified=1");
      if(!held.status||!storage.flushChecked())throw new Error("Could not preserve pool signing holds. Pool engine remains stopped.");
      quarantineRequired=false;
    }
    ctx.ActivityChain.onChange(function () { emitter.emit("update"); });
    if (serviceHandler) serviceHandler({ event: "inited" });         // boot service.js (coinnotify cleanup + retrackOwn + first scan)
    ready = true; initError = "";
  })().catch(function (e) { if(epoch===contextEpoch){initError=String((e&&e.message)||e||"it did not start");initPromise=null;ready=false;if(ctx&&ctx.ActivityChain)ctx.ActivityChain.stop();ctx=null;serviceHandler=null;} throw e; });         // don't cache a rejection → a transient init failure can retry
  return initPromise;
}
function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) { /* best effort */ } }
/** The node restarted IN-APP (tray "Restart node" / settings / megammr): its in-memory relevance cache was
 *  just rebuilt, so any tracking demotes that were pending a restart are now effective — and unlike MDS,
 *  the desktop service context survives, so `inited` would never re-fire on its own. Re-fire it (idempotent:
 *  coinnotify cleanup, ensureTables, retrackOwn, cleanForeign, scan) so the hygiene sweep re-runs without
 *  waiting for the next full app launch. */
function onNodeRestarted() {
  if (ready && serviceHandler) serviceHandler({ event: "inited" });
}
/** Wallet identity changes invalidate live work, never the saved recipes or usage floors. */
/** The shared coin reservation (main/reserve.js) drops this engine's unfinished builds. Never throws: a stop must stop. */
function releaseBuilds() { try { require("./reserve").releaseOwner("pandapools"); } catch (e) {} }
async function invalidate() {
  quarantineRequired=true;stopLoop();contextEpoch++;poolAbort.aborted=true;poolAbort={aborted:false};
  releaseBuilds();
  const old=ctx,storage=sqlShim;
  if(old&&old.ActivityChain)old.ActivityChain.stop();
  ready=false;ctx=null;serviceHandler=null;initPromise=null;
  POOLS=[];lastTip=0;scanning=false;scanStartTs=0;lastQuotes={};lastFail=null;
  if(storage){
    const r=storage.sql("UPDATE pp_ownpools SET signing_unverified=1");
    if(!r.status||!storage.flushChecked())throw new Error("Could not preserve pool signing holds. Pool engine stopped; resolve storage before restarting.");
    quarantineRequired=false;
  }
  // a store that could not be opened belongs to the old wallet too: kept under its dated name, and the engine starts empty (0.18.137)
  if(!storage&&initError){ try{ const kept=require("./restore").moveAside(storeFile()); if(kept){initError="";firstTry=0;} }catch(e){} }
  sqlShim=null;emitter.emit("update");
  if(held){heldLoop=true;return;}   // started by release()
  await init();startLoop();
}
/** HOLD (above). Resolves once nothing of the engine's is at the node any more (three quiet looks), or after maxMs. */
async function hold(maxMs) {
  if (!held) { held = true; heldLoop = !!scanTimer; stopLoop(); }
  await quiet(maxMs || 15000);
  releaseBuilds();   // the engine is stopped: its unfinished builds died with it (posted coins stay held)
}
/** Resolves once nothing of the engine's is at the node (three quiet looks), or after maxMs; then the store is written.
 *  Also awaited before the node is told to quit (main.js onStopping). */
async function quiet(maxMs) {
  const end = Date.now() + (maxMs || 10000);
  for (let n = 0; n < 3 && Date.now() < end;) { await new Promise(function (r) { setTimeout(r, 100); }); n = busy ? 0 : n + 1; }
  flush();
}
function release() { if (!held) return; held = false; if (heldLoop) startLoop(); }

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
function withTimeout(p, ms, msg) { var t; return Promise.race([p, new Promise(function (_, rej) { t = setTimeout(function () { rej(new Error(msg)); }, ms); })]).finally(function () { clearTimeout(t); }); }
/**
 * For the calls that are not fund actions but still wait on ONE engine callback (statement, check reserves, put away,
 * confirm signing): before 0.18.138 a callback the engine dropped left the screen's promise open for ever, and with it
 * Dexicon's one money gate, in all three rooms, until the app was restarted. Now the wait ends with what is true: no
 * answer came, so it is not known whether it was done.
 */
var NO_ANSWER = "PandaPools gave no answer in time, so it is not known whether this was done. Check Activity before trying again.";
var READ_WAIT_MS = { statement: 300000, recover: 180000, retire: 30000, confirm: 60000 };
function _setWaits(w) { Object.assign(READ_WAIT_MS, w); }

// ------------------------------------------------------------------ glue-level fund-action queue
//
// Since 0.16.83 the reused engine serialises every build→sign→post chain (poolmgr.js submitSign +
// the pp_signlock row shared with service.js). That fixes concurrent signing, but it moves the WAIT
// somewhere the caller's withTimeout cannot see: an action can now sit QUEUED INSIDE the engine past
// its own timeout, at which point the UI has already said "timed out — retry" while the queued chain
// is still alive and will happily post. A retry then double-posts against the same coins and both
// attempts sign, burning owner-key leaves — the exact hazard the pre-spend deadline was added for, with
// a new cause. Restore's auto-withdraw makes it near-certain, because it enqueues one close per pool.
//
// So the glue keeps its own serial queue in front of the engine and stamps a deadline BEFORE enqueueing:
// a slot that comes up after its caller gave up is dropped without ever calling into the engine, so
// nothing signs. The engine's gate still matters — it is what serialises us against service.js's
// background keep-fresh/re-announce, which does not come through here at all.
var ACTION_QUEUE = [], ACTION_RUNNING = false;
var ACTION_EXEC_MS = 200000;        // execution budget once a slot is entered (the pre-0.16.83 timeout)
var ACTION_QUEUE_WAIT_MS = 600000;  // how long a slot may wait for its turn before it is abandoned
var ACTION_TOTAL_MS = ACTION_EXEC_MS + ACTION_QUEUE_WAIT_MS;

function pumpActionQueue() {
  if (ACTION_RUNNING) return;
  var job = ACTION_QUEUE.shift();
  if (!job) return;
  ACTION_RUNNING = true;
  var release = function () { ACTION_RUNNING = false; setTimeout(pumpActionQueue, 0); };
  // Dropped rather than run: the caller has already been told this timed out, so a spend here would be
  // the late double-post. Nothing has been sent — the engine was never entered.
  if (job.abandoned()) { job.reject(new Error(job.label + " timed out while queued — nothing was posted. Retry.")); release(); return; }
  var settled = false;
  var once = function (fn) { return function (v) { if (settled) return; settled = true; release(); fn(v); }; };
  try { job.run(once(job.resolve), once(job.reject)); }
  catch (e) { once(job.reject)(e instanceof Error ? e : new Error(String(e))); }
}

/**
 * Run one fund action through the glue's serial queue. `run(resolve, reject)` is called only when the slot is
 * entered and only if the caller is still waiting; it gets `ACTION_EXEC_MS` to settle.
 */
function queuedAction(label, run) {
  var enqueuedAt = Date.now(), gaveUp = false;
  var p = new Promise(function (resolve, reject) {
    ACTION_QUEUE.push({
      label: label, run: run, resolve: resolve, reject: reject,
      abandoned: function () { return gaveUp || (Date.now() - enqueuedAt) > ACTION_QUEUE_WAIT_MS; },
    });
    setTimeout(pumpActionQueue, 0);
  });
  return withTimeout(p, ACTION_TOTAL_MS, label + " timed out — check Activity and your balance before retrying.")
    .catch(function (e) { gaveUp = true; throw e; });
}

/** Deadline for the pre-spend guards, stamped when a slot is ENTERED (never at enqueue time). */
function execDeadline() { return Date.now() + ACTION_EXEC_MS - 10000; }

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
  if (held) { heldLoop = true; return; }   // started by release()
  if (scanTimer) return;
  var tick = function () {
    currentBlock().then(function (tip) {
      if (ctx) ctx.ActivityChain.verify();
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
    var addresses = []; POOLS.forEach(function (p) { if (p.address) addresses.push(p.address); if (p.mxaddress) addresses.push(p.mxaddress); });
    ctx.Store.knownAddrsAdd(addresses);
    scanning = false;                 // reset BEFORE emitting, so a throwing update-listener can't leave it wedged
    emitter.emit("update");
    try { autoUpkeep(tip); } catch (e) {}   // 0.18.57: own pools recover + block-mode keys confirm by themselves
    // 2) background engine — service.js does its own discovery snapshot + feed + keep-fresh + re-announce.
    try { if (serviceHandler) serviceHandler({ event: "NEWBLOCK" }); } catch (e) {}
    // 3) resume any pending signature (harmless on a full-RPC node), then verify pending CREATEs.
    try { ctx.PoolMgr.onNewBlock(); } catch (e) {}
    syncHistory(); ctx.ActivityChain.verify(); ctx.ActivityChain.syncPublic(false);
  }); } catch (e) { scanning = false; }   // a synchronous throw must not wedge the cycle (the 2-min guard also recovers)
}

// ---- read model (JSON-safe) ----
function pools() { if (!ctx) return []; return POOLS.map(serializePool).filter(Boolean); }
function myPools() {
  if(!ctx)return Promise.resolve([]);const active=ctx;
  return new Promise((resolve,reject)=>active.Store.ownAll((recipes,ok)=>{
    if(ok===false){reject(new Error("Saved pool recipes could not be read."));return;}
    // Retired recipes (a pool closed or migrated away) are HIDDEN, never deleted — they stay in ownAll
    // for backups and key classification, and are un-retired if a scan finds the pool live again.
    Promise.all(recipes.filter(r=>!r.retired).map(r=>{
      const p=POOLS.find(p=>p.address&&p.address.toLowerCase()===r.address.toLowerCase()&&active.ReserveRecovery.complete(p));
      // A pool we can see live on chain is not closed, whatever a past close assumed. Without this the
      // Desktop had the HIDE half of retire and no un-hide: one click on a pool that merely looked
      // unresolved (mid-resync, archive down) removed it from the UI with no way back.
      if(p&&r.retired)active.Store.setRetired(r.address,0,()=>{});
      const state={address:r.address,tok:r.tok,opk:r.opk,signingStateUnverified:r.signingStateUnverified||active.Store.confirmationFailed(r.opk),unresolved:!p};
      if(!p)return state;
      return new Promise(done=>active.Store.lpGet(p.address,snap=>done(Object.assign(serializeMyPool(p,snap),state))));
    })).then(resolve,reject);
  }));
}
/**
 * A token's label in a record, by its ID and never by its name (0.18.135): the one dollar token is "MxUSD"; every other
 * token is its own name (control and zero-width characters removed) marked as not MxUSD, with its WHOLE id. A token can
 * be named anything, "MxUSD" included, so a name alone must never be what a record or a screen calls the dollar token.
 */
function labelById(tok, name) {
  if (isMarketFed(tok)) return "MxUSD";
  var n = String(name == null ? "" : name).replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (n && n.toLowerCase() !== String(tok || "").toLowerCase() ? n : "unnamed token") + " (not MxUSD, token " + tok + ")";
}
function activityLabels() { var labels = {}; labels[USDT_TOKENID.toLowerCase()] = "MxUSD"; POOLS.forEach(function (p) { if (p.tok) labels[p.tok.toLowerCase()] = labelById(p.tok, p.tokName); }); return labels; }
/** A swap recorded before 0.18.135 ends in the token's NAME as the engine read it ("… for 10 USDT"). Where the node's own
 *  history of that transaction names exactly one token, the record is labelled by that token's id; otherwise it is left
 *  exactly as recorded (never guessed, never reworded). */
function relabelSwap(model, row) {
  var m = /^((?:Sold|Bought) \S+ MINIMA for \S+) (.+)$/.exec((model && model.summary) || ""), h = row && row.history;
  if (!m || model.type !== "SWAP" || !h || /\(not MxUSD, token 0x[0-9A-Fa-f]+\)$/.test(m[2])) return model;
  var ids = []; try { ids = Object.keys(JSON.parse(h.deltas || "{}")).filter(function (t) { return t !== "0x00"; }); } catch (e) {}
  if (ids.length === 1) model.summary = m[1] + " " + labelById(ids[0], m[2]);
  return model;
}
function activity() {
  if (!ctx) return Promise.resolve([]);
  const active = ctx;
  return new Promise(function (resolve) { active.ActivityChain.snapshot(function (snap) {
    var labels = activityLabels(), rows = snap.rows.map(function (r) { return relabelSwap(active.ActivityChain.rowModel(r, labels), r); });
    var error = [snap.error, active.History.error()].filter(Boolean).join(" · ");
    if (error) rows.unshift({ type: "STATUS", summary: error });
    resolve(rows);
  }); });
}
/**
 * For the Shutdown warning and the restore gate (the Dexicon host's activeWork, for pools): the activity rows while
 * the engine runs; [] when this data folder never had a pool store, so nothing can be waiting; null when there is a
 * store but the engine has not started, so whether a pool transaction is waiting COULD NOT BE CHECKED. activity()
 * itself answers [] in that case, which read as "nothing in flight".
 */
function activeWork() {
  if (ctx) return activity();
  let has = true; try { has = fs.existsSync(storeFile()); } catch (e) {}
  return Promise.resolve(has ? null : []);
}
/**
 * For the restore gate (0.18.137): THIS wallet's own pools that are not put away, each with its whole address and its
 * reserves as the scan has them. Replacing the wallet with ANOTHER one leaves their reserves where only the old
 * wallet's owner keys can withdraw them. [] = none, or no pool store; null = they could not be read.
 */
function ownPools() {
  if (!ctx) { let has = true; try { has = fs.existsSync(storeFile()); } catch (e) {} return Promise.resolve(has ? null : []); }
  return myPools().then(function (list) { return list.map(function (p) { return { address: p.address, token: labelById(p.tok, p.tokName), reserveM: p.unresolved ? null : p.reserveM, reserveT: p.unresolved ? null : p.reserveT }; }); }, function () { return null; });
}
function feed() {
  if (!ctx) return Promise.resolve([]);
  const active = ctx;
  return new Promise(function (resolve) { active.ActivityChain.snapshot(function (snap) {
    var labels = activityLabels();
    var rows = snap.events.map(function (e) { return { pool: e.pool, kind: e.kind, minimaIn: e.minimaIn, minimaAmt: e.minimaAmt, tokenAmt: e.tokenAmt, tokenLabel: labels[String(e.tokenid).toLowerCase()] || labelById(e.tokenid, ""), txpowid: e.txpowid, ts: e.ts, statusText: e.transaction.statusText, confirmed: e.transaction.confirmed, verifiedAt: e.transaction.verifiedAt }; });
    active.Store.feedList(-1, function (observations) {
      // an observation kept only the token's NAME: labelled by id through its pool when that pool is in the scan, else said to be a name only
      observations.forEach(function (e) { var p = poolByAddress(e.pool); rows.push({ pool: e.pool, kind: e.kind, minimaAmt: s(e.minimaAmt), tokenAmt: s(e.tokenAmt), tokenLabel: p ? labelById(p.tok, p.tokName) : String(e.tokenLabel || "token") + " (a name only: the token was not identified)", ts: e.ts, observed: true }); });
      resolve(rows);
    });
  }); });
}

/**
 * The per-pool statement CSV: what you put in, your own trades, what is in the pool now, and the profit.
 *
 * Built from the permanent pp_history mirror (history.js keeps it topped up) plus the live reserves from the
 * current scan, so the file and the Pools tab cannot disagree. Syncs first, because a statement built on a
 * half-filled history would be quietly incomplete — the worst way for an accounting file to be wrong.
 */
function statement() {
  if (!ctx) return Promise.resolve({ csv: "", rows: 0, backfilled: false });
  return withTimeout(new Promise(function (resolve) {
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
  }), READ_WAIT_MS.statement, "PandaPools gave no answer in time, so the statement was not built and no file was written. Try again in a moment.");
}

/** Keep the permanent history mirror current. Fire-and-forget; safe to call every block. */
function syncHistory() {
  if (!ctx || ctx.History.isRunning()) return Promise.resolve(0);
  return new Promise(function (resolve) { ctx.History.sync(function (added) { if (ctx) ctx.ActivityChain.verify(); emitter.emit("update"); resolve(added); }); });
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
  var tokenLabel = labelById(tok, pl[0] && pl[0].tokName);   // what the swap's record will call the token: by its id
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
  if (marketFresh() && mktMid > 0) return { price: fmtMid(), source: "MEXC market", at: mktAt };   // at: when MEXC was read (0.18.138: the review says how old the price is)
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
    return queuedAction(label, function (resolve, reject) {
      fn(p, {
        ok: function (txpowid) { ctx.Store.actRecord(label, (typeof summary === "function" ? summary() : summary) || (label + " on a pool"), txpowid, lastTip, ""); emitter.emit("update"); resolve({ txpowid: txpowid }); },
        fail: function (m) { reject(new Error(m)); },
      });
    });
  });
}
/**
 * Add liquidity. The engine takes the MINIMA amount and works the token side out itself from the reserves it reads when
 * it posts (poolmgr.js deposit: addM × reserveT ÷ reserveM, cut to the token's decimals); addT is not used by it, and it
 * answers with the transaction id only. So what it TOOK is worked out here, by its own rule, with its own Decimal, from
 * the same pool object it has just refreshed (0.18.136): the record and the screen's result say that, not what was typed.
 */
function depositUsed(p, addM) {
  try { var m = D(addM), t = m.times(D(p.reserveT)).div(D(p.reserveM)).toDP(p.tokDecimals, ctx.PP.D.ROUND_DOWN); return { minima: s(m), token: s(t), label: labelById(p.tok, p.tokName) }; }
  catch (e) { return null; }
}
function deposit(addr, addM, addT) {
  var used = null;
  return actionOnPool(addr, function (p, d) { ctx.PoolMgr.deposit(p, addM, addT, { ok: function (txpowid) { used = depositUsed(p, addM); d.ok(txpowid); }, fail: d.fail }); }, "ADD",
    function () { return used ? "Added " + used.minima + " MINIMA and " + used.token + " " + used.label + " to a pool" : "Added liquidity"; })
    .then(function (r) { return used ? Object.assign(r, { minima: used.minima, token: used.token }) : r; });
}

/** READ-ONLY owner-key and signing-state pre-flight before an owner-signed spend (WITHDRAW / MIGRATE).
 *  Delegates to PoolMgr.ensureOwnerKeys, which since MDS 0.6.2x is ReserveRecovery.ensureKeys: it reads the
 *  node's key list and the saved recipes and NEVER creates or advances a key. Recreating an old Winternitz key
 *  at use zero can disclose its signing material, and a recipe plus an elapsed-block estimate cannot establish
 *  the highest previously used leaf — so a key this wallet does not hold comes back as unreachable and the spend
 *  is refused. `cb(foreign)` is true for every blocked case: key absent, node unreadable, key exhausted, recipe
 *  signing-quarantined, or the node's counter below the recipe's recorded floor. */
// 0.18.139: this said "Open Pool recovery and confirm…", and no such menu entry exists: the button is on the pool's own card.
const UNAVAILABLE_KEY_MSG = "Owner signing is paused or its current key state could not be verified. In My LP, on this pool's card, press Confirm wallet signing state, with the latest complete wallet backup restored on this node.";
function ensureOwnerKey(opk, cb) {
  if (!opk || !ctx || !ctx.PoolMgr || !ctx.PoolMgr.ensureOwnerKeys) return cb(false);
  try {
    ctx.PoolMgr.ensureOwnerKeys([opk], function (regen, unreachable) {
      cb(!!(unreachable && unreachable.indexOf(String(opk).toLowerCase()) !== -1));
    });
  } catch (e) { cb(false); }
}
/** The owner-key pre-flight is itself serialised, so an unrelated caller's read can delay ours. Once the UI has
 *  said "timed out — retry", a late spend MUST NOT fire — the retry would double-post against the same coins and
 *  both posts would sign, burning owner-key leaves. The deadline is stamped when the queue slot is ENTERED
 *  (execDeadline), so it measures execution only; waiting for the slot is handled by queuedAction, which drops an
 *  abandoned slot before the engine is ever called. */
function closePool(addr) {
  return actionOnPool(addr, function (p, d) {
    var deadline = execDeadline();
    ensureOwnerKey(p.opk, function (foreign) {
      if (foreign) { d.fail(UNAVAILABLE_KEY_MSG); return; }
      if (Date.now() > deadline) { d.fail("timed out before the owner key was ready — nothing was posted. Retry."); return; }
      ctx.PoolMgr.close(p, {
        ok: function (txpowid) {
          ctx.Store.setRetired(p.address, 1, function () {});
          // Queue the payout address BEFORE any forward, so a crash between the close and the forward still
          // leaves the job recorded. The service pass finishes it and keeps going until the address is empty.
          ctx.Store.collectAdd(p.oadr, function () { ctx.PoolMgr.collectSweep(function () { emitter.emit("update"); }); });
          d.ok(txpowid);
        },
        fail: function (m) { d.fail(m); } });
    });
  }, "WITHDRAW", "Withdrew a pool's reserves");
}
async function migrate(addr, newX, newY) {
  await init();
  var p = poolByAddress(addr); if (!p) throw new Error("Pool not found.");
  return queuedAction("Migrate", function (resolve, reject) {
    var deadline = execDeadline();
    ensureOwnerKey(p.opk, function (foreign) {
      if (foreign) { reject(new Error(UNAVAILABLE_KEY_MSG)); return; }
      if (Date.now() > deadline) { reject(new Error("timed out before the owner key was ready — nothing was posted. Retry.")); return; }
      ctx.PoolMgr.migrate(p, newX, newY, { created: function (np, txpowid) { ctx.Store.ownRecord(np); ctx.Store.setRetired(p.address, 1, function () {}); ctx.Store.actRecord("MIGRATE", "Migrated a pool", txpowid, lastTip, np.address); emitter.emit("update"); resolve({ txpowid: txpowid, address: np.address }); }, fail: function (m) { reject(new Error(m)); } });
    });
  });
}

/** Forward funds sitting at MY pools' owner addresses ($OADR) onward to the default-64 wallet — so withdrawn
 *  reserves aren't stranded at a newaddress a seed-only restore won't reproduce. Reuses PoolMgr.sweepOwnerFunds. */
/** Every payout address still holding withdrawn funds, with its status. Drives the MY LP card. */
async function pendingCollect() {
  await init(); const active = ctx;
  return new Promise(resolve => active.Store.collectAll(resolve));
}

async function collectToWallet() {
  await init();
  return withTimeout(new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      var oadrs = (recipes || []).map(function (r) { return r.oadr; }).filter(Boolean);
      if (!oadrs.length) { resolve({ addresses: 0, coins: 0 }); return; }
      var opks = (recipes || []).map(function (r) { return r.opk; }).filter(Boolean);
      // regenerate every owner key first ($OADR returns SIGNEDBY($OPK)) — self-heal the post-restore race.
      // A foreign-seed key doesn't abort the sweep (the other pools' funds still move) — it's reported.
      var deadline = Date.now() + 230000;   // just under this promise's 240s withTimeout (cf. execDeadline)
      ctx.PoolMgr.ensureOwnerKeys(opks, function (regen, unreachable) {
        if (Date.now() > deadline) { resolve({ addresses: 0, coins: 0, foreign: unreachable ? unreachable.length : 0 }); return; }
        // Enqueue FIRST, then sweep. A fire-and-forget sweep cannot finish a job whose coins are not
        // spendable yet — that is exactly how 2934.95626348 MxUSD was left behind on 2026-09-14. Queued
        // addresses are then finished by the background service pass, which outlives this call.
        var left = oadrs.length;
        oadrs.forEach(function (a) {
          ctx.Store.collectAdd(a, function () {
            if (--left > 0) return;
            ctx.PoolMgr.collectSweep(function (t) {
              if (t.cleared) ctx.Store.actRecord("COLLECT", "Moved withdrawn funds from " + t.cleared + " payout address(es) to your wallet", "", lastTip, "");
              emitter.emit("update");
              resolve({ addresses: t.cleared, coins: t.cleared, cleared: t.cleared, pending: t.pending,
                        stranded: t.stranded, foreign: unreachable ? unreachable.length : 0 });
            });
          });
        });
      });
    });
  }), 240000, "Collecting timed out — check your balance; you can retry from My LP.");
}

// ---- 0.18.57/0.18.58: the daily pool upkeep is automatic (parity with APK 0.2.95 / MDS 0.6.43) ----
// A saved pool whose reserves this node cannot see recovers itself — once per session per pool, one per cycle,
// silently: re-track the covenant, verify and import both reserve coins (local node, then the archive); the
// service's keep-fresh then recreates them young. Only a pool whose owner key this node holds (readKeyUses
// answers null for a foreign key). A restored block-mode owner key (128^4 tree) is confirmed from the chain
// tip (ReserveRecovery.counterSafe); a legacy key keeps the renderer's attestation button.
const AUTO_RECOVERED = {}, AUTO_CONFIRMED = {};
function autoUpkeep(tip) {
  if (!ctx || !tip) return; const active = ctx;
  active.Store.ownAll(function (recipes, ok) {
    if (ok === false || !recipes || active !== ctx) return;
    let recovering = recoveryBusy;
    recipes.forEach(function (r) {
      if (r.retired || !r.address || !r.opk) return;
      const a = r.address.toLowerCase(), k = r.opk.toLowerCase();
      const live = POOLS.find(function (p) { return p.address && p.address.toLowerCase() === a && active.ReserveRecovery.complete(p); });
      if (!live && !recovering && !AUTO_RECOVERED[a]) {
        AUTO_RECOVERED[a] = true; recovering = true;
        active.PoolMgr.readKeyUses(r.opk, function (uses) {
          if (uses === null) return;                                   // not this node's key: a foreign recipe keeps its card
          if (recoveryBusy) { delete AUTO_RECOVERED[a]; return; }      // a restore is running (the key read is async): retry next cycle
          recoverSaved(r.address).catch(function () { delete AUTO_RECOVERED[a]; });   // e.g. storage unavailable: retry next cycle
        });
      }
      if ((r.signingStateUnverified || active.Store.confirmationFailed(r.opk)) && !AUTO_CONFIRMED[k]) {
        AUTO_CONFIRMED[k] = true;
        active.ReserveRecovery.confirmKey(r.opk, function (confirmed) { if (confirmed) emitter.emit("update"); }, tip, true);
      }
    });
  });
}

async function scanNow() { await init(); return new Promise(function (r) { ctx.Book.scan(function (ps) { POOLS = ps || []; emitter.emit("update"); r(pools()); }); }); }

// ---- Recovery (Layer 3): backup + restore. Byte-compatible with native/MDS ({pandapools_backup:1, pools:[…]}),
//      public data only (recipe params + a fresh coinexport of each reserve coin) — no seed, cannot move funds.
async function backup() {
  await init(); const active=ctx;
  return new Promise(resolve => active.ReserveRecovery.backup(lastTip,resolve));
}
let recoveryBusy=false;
async function restore(json) {
  await init();
  if(typeof json!=="string"||json.length>8*1024*1024)throw new Error("Invalid or oversized pool backup.");
  if(recoveryBusy)throw new Error("Pool recovery is already running.");
  recoveryBusy=true;const active=ctx;
  try {
    return await withTimeout(new Promise(resolve => active.ReserveRecovery.configuredArchive(archive => {
      active.ReserveRecovery.restore(json,archive,null,r => {emitter.emit("update");if(active===ctx)scanNow().catch(()=>{});resolve(r);});
    })), READ_WAIT_MS.recover, "PandaPools gave no answer in time, so it is not known which reserves were found. Nothing was signed. Check My LP before trying again.");
  } finally {recoveryBusy=false;}
}
async function retirePool(address, retired) {
  await init(); const active=ctx;
  return withTimeout(new Promise(resolve=>active.Store.setRetired(address, retired ? 1 : 0, ()=>{emitter.emit("update");resolve(true);})), READ_WAIT_MS.retire, NO_ANSWER);
}

async function listRetired() {
  await init(); const active=ctx;
  return new Promise((resolve,reject)=>active.Store.ownAll((recipes,ok)=>ok===false
    ? reject(new Error("Saved pool recipes could not be read."))
    : resolve(recipes.filter(r=>r.retired).map(r=>({address:r.address,opk:r.opk})))));
}

async function recoverSaved(address) {
  await init();const active=ctx;
  const recipes=await new Promise((resolve,reject)=>active.Store.ownAll((ps,ok)=>ok===false?reject(new Error("Pool storage unavailable.")):resolve(ps)));
  const p=recipes.find(r=>r.address.toLowerCase()===String(address).toLowerCase());
  if(!p)throw new Error("Saved pool recipe not found.");
  return restore(JSON.stringify({pandapools_backup:3,pools:[active.ReserveRecovery.entry(p)]}));
}
async function archiveSettings(url) {
  await init();const active=ctx;
  if(url===undefined)return new Promise(resolve=>active.Store.kvGet("recovery_archive",value=>resolve(value)));
  if(typeof url!=="string")throw new Error("Invalid archive endpoint.");
  return new Promise(resolve=>active.ReserveRecovery.saveArchive(url,resolve));
}
async function confirmSigning(opk,attested) {
  await init();if(attested!==true||typeof opk!=="string"||!/^0x[0-9a-fA-F]{64}$/.test(opk))return false;
  const active=ctx;return withTimeout(new Promise(resolve=>active.ReserveRecovery.confirmKey(opk,ok=>{emitter.emit("update");resolve(ok);},lastTip)), READ_WAIT_MS.confirm, NO_ANSWER);   // block-mode: the tip counts too
}

// Full backups are captured and encrypted in main; renderer never receives node bytes or its inner password.
let completeBackupBusy=false;
async function completeBackup(password,save){
  await init();
  if(completeBackupBusy)throw Error('BACKUP_BUSY: another backup is running.');
  completeBackupBusy=true;const active=ctx,epoch=contextEpoch;
  const Bundle=require('./pandapools/combined-backup'),Full=require('./pandapools/full-backup');
  const base=node.dataDir();
  try{
    const captured=await Full.capture({
      cmd:async command=>{if(active!==ctx||epoch!==contextEpoch)throw Error('WALLET_CHANGED');const r=await nodeCmd(command);if(active!==ctx||epoch!==contextEpoch)throw Error('WALLET_CHANGED');return r;},
      backup:async()=>{const r=await backup();if(!r.json)throw Error(r.error||'No saved pools.');return r.json;},
      makeNode:async(name,inner)=>{const r=await nodeCmd('backup file:'+name+' password:'+inner+' confirm:'+inner);if(!r||r.status!==true||r.pending)throw Error('NODE_BACKUP_FAILED: check node storage and permissions.');},
      readNode:async name=>{const file=path.join(base,name),st=await fs.promises.lstat(file);if(!st.isFile()||st.size<32||st.size>Bundle.MAX_NODE)throw Error('NODE_BACKUP_SIZE');return fs.promises.readFile(file);},
      deleteNode:name=>fs.promises.unlink(path.join(base,name))
    },password);
    if(active!==ctx||epoch!==contextEpoch)throw Error('WALLET_CHANGED');
    const result=await save(captured.encrypted);
    if(!result||result.canceled)return {canceled:true};
    if(active!==ctx||epoch!==contextEpoch)throw Error('WALLET_CHANGED');
    const ok=await new Promise(resolve=>active.Store.recordCombinedBackup(captured.json,resolve));
    if(!ok)throw Error('BACKUP_NOT_VERIFIED: pool list changed or verification could not be recorded. Save another backup.');
    emitter.emit('update');return result;
  }finally{completeBackupBusy=false;password=null;}
}
async function validateCompleteRecipes(json){
  await init();const parsed=JSON.parse(json);
  if(!parsed||!Array.isArray(parsed.pools)||!parsed.pools.length||parsed.pools.some(p=>!ctx.ReserveRecovery.validRecipe(p)))throw Error('BACKUP_POOL_RECIPES_INVALID');
  return true;
}
async function completeBackupRequired(){await init();return new Promise(resolve=>ctx.Store.combinedBackupReady(ok=>resolve(!ok)));}

/**
 * Before the WALLET consolidates. Core's `consolidate` chooses its own input coins, so it can pick a coin that belongs
 * to a pool owner key; if that key cannot safely sign (its one-time-signature counter is unknown, regressed or spent)
 * signing with it could expose the key. PandaPools on Android refuses the consolidation in that case
 * (OwnerKeyRecovery.checkConsolidation); this is the same rule on the same engine's own classification.
 * Resolves null when it is safe, otherwise the reason in the engine's own words. Fails closed.
 */
async function consolidationCheck() {
  const STOP = "Nothing consolidated: ";
  try { await withTimeout(init(), 15000, "PandaPools is still starting"); }
  catch (e) { return STOP + "could not check your pool owner keys (" + ((e && e.message) || e) + "). Try again in a moment."; }
  if (!ctx) return STOP + "could not check your pool owner keys. Try again in a moment.";
  return withTimeout(new Promise(function (resolve) {
    ctx.Store.ownAll(function (recipes) {
      var keys = (recipes || []).map(function (p) { return p && p.opk; }).filter(Boolean);
      if (!keys.length) { resolve(null); return; }                      // no pools of ours: nothing to protect
      ctx.ReserveRecovery.classifyKeys(keys, function (blocked) {
        // the engine's sentence says "confirm it in Pool recovery"; the button is on the pool's card in My LP (the same words as renderer/dexicon-pp.js whereConfirm)
        resolve(blocked && blocked.length ? STOP + "your wallet holds a pool owner key that cannot sign.\n\n" + String(blocked[0].message).replace(/confirm it (again )?in Pool recovery/g, "confirm it $1with Confirm wallet signing state on the pool's card in My LP") : null);
      });
    });
  }), 15000, "the key check timed out").catch(function (e) { return STOP + "could not verify your wallet keys (" + ((e && e.message) || e) + ")."; });
}

module.exports = {
  consolidationCheck,
  completeBackup, completeBackupRequired, validateCompleteRecipes,
  emitter, init, startLoop, stopLoop, scanNow, flush, invalidate, hold, release, quiet,
  pools, myPools, activity, feed, statement, syncHistory, quoteSwap: quoteAndStash, pairInfo, aggregateInfo, createPreview,
  market, createAnchor, marketToken,
  swap, createPool, deposit, close: closePool, migrate, collectToWallet, pendingCollect, backup, restore, recoverSaved, retirePool, listRetired, archiveSettings, confirmSigning,
  onNodeRestarted, lastNodeFailure, status, activeWork, ownPools, setAsideStore,
  _setRunner, _setDataDir, _labelById: labelById, _relabelSwap: relabelSwap, _depositUsed: depositUsed, _setWaits, NO_ANSWER,
};
