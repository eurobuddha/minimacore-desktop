/*
 * atomix.js — the desktop orchestrator for the AtomiX atomic-swap module (DESKTOP-ONLY glue; the engine under
 * main/atomix/ is a BYTE-IDENTICAL copy of ~/Projects/atomix-mds and runs VERBATIM in a vm — see loader.js).
 * Mirrors main/pandapools.js: build the MDS shim, init idempotently, drive the engine with the same three
 * events every peer uses (inited / NEWBLOCK / MDS_TIMER_60SECONDS), expose a JSON-safe read-model + promise-
 * wrapped actions to the renderer over IPC.
 *
 * THE GLUE RULE (the pandapools 752264c lesson, written in blood): every action here mirrors the donor's
 * app.js flow EXACTLY — frozen review data, makerLive re-check at lock time, raw-balance send validation,
 * review-then-broadcast. No desktop-side re-quoting, no improvised guards, no dropped displays.
 */
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");
const { rpcCall } = require("./rpc");
const { createContext } = require("./atomix/loader");
const { makeSqlShim } = require("./pandapools/sqlshim");   // the proven generic H2→SQLite shim (3rd instance)
const netfetch = require("./netfetch");
// electron/config/node-manager are lazy so the headless gate harness can drive this module bare-node
// via _setRunner/_setDataDir (one implementation for tests AND the app — no harness drift).
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();

// Outbound HTTP allowlist for the engine's MDS.net — the ETH JSON-RPC endpoints baked into the engine
// (lib/ethhtlc.js NET.rpcs) + the MEXC feed. Anything else is refused here regardless of what the vm asks for.
const NET_HOSTS = new Set([
  "ethereum-rpc.publicnode.com", "eth.drpc.org", "eth-mainnet.public.blastapi.io", "eth-pokt.nodies.app",
  "eth.api.onfinality.io", "api.zan.top", "eth.rpc.blxrbdn.com", "gateway.tenderly.co", "1rpc.io",
  "api.mexc.com"
]);
function allowedUrl(u) {
  try { return NET_HOSTS.has(new URL(String(u)).hostname); } catch (e) { return false; }
}

let ctx = null;               // the vm context (ctx.AX / ctx.READY / ctx.CTX)
let sqlShim = null;
let serviceHandler = null;    // captured by MDS.init — WE fire the events
let ready = false;            // orchestrator init done (engine boot is async + self-healing inside the vm)
let initPromise = null;
let pollTimer = null, minuteTimer = null, lastTip = null;
let generation = 0;           // bumped on invalidate — a stale in-flight init from an old seed must not resurrect
let dataDir = null;
let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
const LOG_RING = [];          // last engine log lines for the renderer/status
const SCAN_EVERY_MS = 12000;

function dir() { return dataDir || app.getPath("userData"); }
function log(line) {
  line = String(line).replace(/^\[atomix\]\s*/, "");   // the engine's own MDS.log lines carry the prefix already
  const entry = new Date().toISOString().slice(11, 19) + " " + line;
  LOG_RING.push(entry); if (LOG_RING.length > 200) LOG_RING.shift();
  console.log("[atomix]", line);
}

function buildMds() {
  return {
    minidappuid: "",
    cmd(command, cb) {
      // two-arg then (pandapools pattern): a throw inside the success cb must not double-fire the cb.
      // CROSS-REALM: the engine tests `r.response instanceof Array` (orderbook/otc/responder book scans) — a
      // main-realm array is NOT instanceof the VM realm's Array, so every cmd response is marshalled INTO the
      // vm realm (JSON round-trip via the vm's own parser). Without this the book always reads empty. (sql
      // rows are consumed by realm-independent ops — Array.isArray/.map/index — so they need no marshalling.)
      runner(String(command)).then(r => cb(toVm(r)), () => cb(toVm({ status: false })));
    },
    sql(query, cb) {
      sqlShim.sql(query, cb);
      // FUND-SAFETY DURABILITY: the H2 peers persist synchronously; our sqlite image is debounced 400ms. A
      // crash in that window after a SECRET write (the preimage that claims a leg) would degrade an in-flight
      // swap to refund-only — so secret writes flush the image synchronously. Rare row class; cost is trivial.
      if (/INSERT INTO `secrets`/i.test(String(query))) { try { sqlShim.flush(); } catch (e) {} }
    },
    net: {
      GET(url, cb) {
        if (!allowedUrl(url)) return cb({});
        netfetch.fetchJson(String(url)).then(obj => cb(obj == null ? {} : { response: obj }), () => cb({}));
      },
      POST(url, data, cb) {
        if (!allowedUrl(url)) return cb({});
        netfetch.postText(String(url), String(data)).then(text => cb(text == null ? {} : { response: text }), () => cb({}));
      }
    },
    notify(msg) { log("notify: " + msg); emitter.emit("notify", String(msg)); },
    log(msg) { log(String(msg)); emitter.emit("update"); },
    init(cb) { serviceHandler = cb; }
    // .load is attached by loader.createContext (path-jailed file loader for service.js's own manifest)
  };
}

function fire(event) { if (serviceHandler) { try { serviceHandler({ event }); } catch (e) { log("handler error: " + e.message); } } }

// Marshal a main-realm value INTO the vm realm (so `instanceof Array` etc. use the vm's intrinsics). Lazy —
// ctx exists by the time any cmd response is marshalled. Falls back to identity before the ctx is built.
let vmJsonParse = null;
function toVm(obj) {
  try {
    if (!ctx) return obj;
    if (!vmJsonParse) vmJsonParse = require("vm").runInContext("JSON.parse", ctx);
    return vmJsonParse(JSON.stringify(obj));
  } catch (e) { return obj; }
}

async function init() {
  if (ready) return;
  if (initPromise) return initPromise;
  const gen = generation;     // capture; invalidate() bumps this to disown an in-flight init from the old seed
  initPromise = (async () => {
    const shim = await makeSqlShim(path.join(dir(), "atomix.sqlite"));
    if (gen !== generation) { try { shim.flush(); } catch (e) {} return; }   // invalidated mid-init → drop it
    sqlShim = shim;
    ctx = createContext(buildMds());
    if (gen !== generation) { ctx = null; sqlShim = null; return; }           // invalidated during context build
    ready = true;
    fire("inited");            // service.js tryBoot: trust preflight → vault/seedrandom → engines → poll.
  })().catch(e => { if (gen === generation) { initPromise = null; ready = false; } log("init failed: " + e.message); throw e; });
  return initPromise;
}

function startLoop() {
  if (pollTimer) return;
  const tick = () => init().then(() => {
    runner("block").then(r => {
      const tip = r && r.response && (r.response.block || r.response);
      if (tip && tip !== lastTip) { lastTip = tip; fire("NEWBLOCK"); emitter.emit("update"); }
    }).catch(() => {});
  }).catch(() => {});
  tick();
  pollTimer = setInterval(tick, SCAN_EVERY_MS);
  minuteTimer = setInterval(() => { if (ready) { fire("MDS_TIMER_60SECONDS"); emitter.emit("update"); } }, 60000);
}
function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
}

function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) {} }

/** Wallet/seed restore: the engine identity + swap DB belong to the OLD seed — wipe and re-init (mirrors
 *  pandapools.invalidate / mailInvalidate). */
function invalidate() {
  generation++;              // disown any in-flight init (old seed) BEFORE we tear down
  stopLoop();
  flush();
  try { fs.unlinkSync(path.join(dir(), "atomix.sqlite")); } catch (e) {}
  ctx = null; sqlShim = null; serviceHandler = null; ready = false; initPromise = null; lastTip = null;
  vmJsonParse = null; lastQuotes = {};   // realm-bound helpers + frozen quotes die with the old context
  emitter.emit("update");
  startLoop();
}

/** Engine status for the renderer header: booted?, identity, block, active currency, recent log lines. */
function status() {
  const booted = !!(ctx && ctx.READY);
  return {
    ready: booted,
    eth: booted && ctx.CTX && ctx.CTX.eth ? ctx.CTX.eth.address : null,
    minimaPk: booted && ctx.CTX && ctx.CTX.htlc ? ctx.CTX.htlc.publickey : null,
    currency: ctx && ctx.AX ? ctx.AX.trading.active().key : null,
    block: lastTip,
    log: LOG_RING.slice(-30)
  };
}

// ============================ read-model + actions (S2) ============================
// Every flow below is a 1:1 transcription of the donor's lib/app.js — the engine does the thinking, this
// file only sequences it. Frozen quotes (pandapools quoteAndStash pattern): execute EXACTLY what was reviewed.

function AX() { if (!ctx || !ctx.READY) throw new Error("AtomiX engine not booted yet"); return ctx.AX; }
function vmCtx() { return ctx.CTX; }
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms))]);
}
function p(fn) { return new Promise((res, rej) => { try { fn((err, val) => err ? rej(err instanceof Error ? err : new Error(String(err))) : res(val)); } catch (e) { rej(e); } }); }
function jclone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ---- balances (donor refreshBalances/refreshEthBalances: display + RAW — raw gates every fund check) ----
async function balances() {
  const A = AX();
  const out = { minima: "0", meta: null, eth: "0", ethWei: "0", usdt: "0", usdtRaw: "0" };
  const bal = await runner("balance tokenid:" + A.trading.active().tokenId).catch(() => null);
  const r0 = bal && bal.response && bal.response[0];
  // node returns response:[] for a token the wallet holds none of → a zeroed breakdown (consistent UI card).
  out.minima = r0 ? String(r0.sendable) : "0";
  out.meta = r0
    ? { confirmed: r0.confirmed, unconfirmed: r0.unconfirmed, sendable: r0.sendable, coins: r0.coins, at: Date.now() }
    : { confirmed: "0", unconfirmed: "0", sendable: "0", coins: 0, at: Date.now() };
  const ops = A.ethops.make(ctx.RPC, vmCtx().eth.privKey, vmCtx().eth.address);
  await p(cb => ctx.RPC.getBalance(vmCtx().eth.address, cb)).then(wei => { out.ethWei = wei.toString(); out.eth = A.dec.formatUnits(wei, 18); }).catch(() => {});
  await p(cb => ops.balanceOf(A.ethops.NET.usdt, cb)).then(raw => { out.usdtRaw = raw.toString(); out.usdt = A.dec.formatUnits(raw, 6); }).catch(() => {});
  return out;
}

// ---- book + quote (donor onReview: single within the best level, else best-price-first sweep) ----
let lastQuotes = {}, quoteSeq = 0;
function myId() { const A = AX(); return A.boot.activeIdentity(vmCtx()).publicId(); }
async function bookScan() { const A = AX(); return p(cb => A.book.scan((e, book) => cb(e, book))); }

async function book() {
  const A = AX();
  const b = await withTimeout(bookScan(), 30000, "book scan");
  const q = A.book.bestMakers(b, myId());
  // `scanned` = orders the engine READ+VERIFIED on-chain (Ed25519 + parse); `makers` = EXTERNAL makers after
  // excluding our own identity's orders (0 is correct on a node whose own maker published the whole book).
  const mine = A.boot.activeIdentity(vmCtx()).publicId();
  const external = Object.keys(b).filter(pk => !A.book.isMine(b[pk], mine)).length;
  return jclone({
    scanned: Object.keys(b).length, makers: external,
    bestBid: q.bestBid, bestAsk: q.bestAsk, bidCap: q.bidCap, askCap: q.askCap,
    bids: A.book.aggSide(b, true, myId()).slice(0, 12).map(r => ({ signer: r.maker.signerPk, p: r.level.p, cap: A.book.levelCap(r.maker, r.level, true) })),
    asks: A.book.aggSide(b, false, myId()).slice(0, 12).map(r => ({ signer: r.maker.signerPk, p: r.level.p, cap: A.book.levelCap(r.maker, r.level, false) })),
    currency: A.trading.active().key, label: A.trading.active().coinLabel
  });
}

async function quote(sell, amountStr, slipPct) {
  const A = AX(), SP = A.swapplan;
  const bals = await balances();
  const b = await withTimeout(bookScan(), 30000, "book scan");
  const q = A.book.bestMakers(b, myId());
  const want = Number(amountStr);
  const ccy = A.trading.active().coinLabel;
  if (!(want > 0)) return { err: "Enter a valid " + ccy + " amount." };
  const bestMaker = sell ? q.bidMaker : q.askMaker, bestPrice = sell ? q.bestBid : q.bestAsk, bestCap = sell ? q.bidCap : q.askCap;
  if (!bestMaker || bestPrice <= 0) return { err: "No quote available right now." };
  let model;
  if (sell) {
    if (want > Number(bals.minima) + 1e-9) return { err: "You only have " + bals.minima + " " + ccy + " to sell." };
    if (want <= bestCap + 1e-9) {
      const minima = SP.legMinima(want), usdt = SP.computeUsdt(minima, bestPrice);
      if (!minima || !usdt) return { err: "Enter a valid amount" };
      model = { mode: "single", sell: true, minima, usdt, price: bestPrice, maker: bestMaker.signerPk };
    } else {
      const plan = SP.buildSweepPlan(b, true, amountStr, 0, myId());
      if (!plan.legs.length) return { err: plan.stopReason === "below-min" ? "That's below the makers' minimum trade size." : "No liquidity available to fill that right now." };
      model = { mode: "sweep", sell: true, plan };
    }
  } else {
    const slip = (Number(slipPct) || 0) / 100;
    const plan = SP.buildSweepPlan(b, false, amountStr, slip, myId());
    if (!plan.legs.length) return { err: plan.stopReason === "below-min" ? "That's below the makers' minimum trade size." : "No liquidity available to fill that right now." };
    if (plan.totalUsdt > Number(bals.usdt) + 1e-9) return { err: "Need ≈ " + plan.totalUsdt.toFixed(6) + " USDT for that — you have " + bals.usdt + "." };
    model = { mode: "sweep", sell: false, plan };
  }
  // FREEZE the quote (752264c rule): execution replays exactly this, against a fresh makerLive check.
  const qid = "q" + (++quoteSeq);
  lastQuotes[qid] = { model, book: b, at: Date.now() };
  const keys = Object.keys(lastQuotes); if (keys.length > 30) delete lastQuotes[keys[0]];
  const out = jclone({ quoteId: qid, mode: model.mode, sell, single: model.mode === "single"
    ? { minima: model.minima, usdt: model.usdt, price: model.price, maker: model.maker }
    : null,
    plan: model.plan ? { legs: model.plan.legs.map(l => ({ maker: l.maker.signerPk, price: l.price, minima: l.minima, usdt: l.usdt })),
      filledMinima: model.plan.filledMinima, totalUsdt: model.plan.totalUsdt, avgPrice: model.plan.avgPrice,
      worstPrice: model.plan.worstPrice, target: model.plan.target, partial: model.plan.partial,
      stopReason: model.plan.stopReason, slippagePct: model.plan.slippagePct } : null,
    label: ccy });
  return out;
}

function legHooks(A, signerPk, sellMinima, freshBook) {
  return {
    makerLive: () => A.book.makerLive(freshBook[signerPk], sellMinima),
    me: A.boot.activeIdentity(vmCtx()),
    myPublicId: myId(),
    onWithdrawn: () => {}, onNote: (tag) => log("swap note: " + tag)
  };
}
function makerObj(book, signerPk) { return book[signerPk] || null; }
function pollConfirm(A, hash, sellLeg) {
  // donor pollConfirm: gate the NEXT unpinned-coin leg on THIS one confirming (5s × 24)
  return new Promise(resolve => {
    let tries = 0;
    (function loop() {
      p(cb => { A.engine.confirmMyLock(hash, sellLeg, found => cb(null, found)); }).then(found => {
        if (found) return resolve(true);
        if (++tries > 24) return resolve(false);
        setTimeout(loop, 5000);
      }).catch(() => resolve(false));
    })();
  });
}

async function swapExecute(quoteId) {
  const A = AX();
  const stash = lastQuotes[quoteId];
  if (!stash || Date.now() - stash.at > 120000) { if (stash) delete lastQuotes[quoteId]; throw new Error("That quote has expired — review the swap again."); }
  delete lastQuotes[quoteId];                       // single-use (consumed even on failure, donor pattern)
  const fresh = await withTimeout(bookScan(), 30000, "book scan");   // makerLive re-checks against CURRENT book
  const m = stash.model;
  // NO timeout on a leg lock (donor has none): withTimeout only REJECTS — the engine's startLeg keeps going and
  // can still lock the coin / broadcast, so a "timed out" retry would DOUBLE-lock. Let the leg run to its real
  // callback; the engine's own record-before-broadcast + F1 make a slow leg safe.
  const startLeg = (signerPk, sellMinima, minima, usdt) => {
    const maker = makerObj(stash.book, signerPk);   // the FROZEN maker record (mpk/eth/cid from review time)
    if (!maker) return Promise.reject(new Error("maker vanished from the reviewed book"));
    return p(cb => A.engine.startLeg(maker, "USDT", sellMinima, minima, usdt, legHooks(A, signerPk, sellMinima, fresh), cb));
  };
  if (m.mode === "single") {
    const hash = await startLeg(m.maker, true, m.minima, m.usdt);
    emitter.emit("update");
    return { ok: 1, of: 1, hashes: [hash] };
  }
  const legs = m.plan.legs;
  const hashes = [];
  if (m.sell) {
    // donor startSweepSell: SEQUENTIAL, each next leg gated on the previous confirming (unpinned-coin race). A
    // failed leg does NOT discard progress — report how many locked (donor "Sweep stopped at part N").
    for (let i = 0; i < legs.length; i++) {
      let hash;
      try { hash = await startLeg(legs[i].maker.signerPk, true, legs[i].minima, legs[i].usdt); }
      catch (e) { emitter.emit("update"); return { ok: hashes.length, of: legs.length, hashes, stopped: "Sweep stopped at part " + (i + 1) + ": " + (e.message || e) }; }
      hashes.push(hash);
      if (i < legs.length - 1) {
        const confirmed = await pollConfirm(A, hash, true);
        if (!confirmed) { emitter.emit("update"); return { ok: hashes.length, of: legs.length, hashes, stopped: "part " + (i + 1) + " is still confirming — remaining parts not sent. Try again shortly." }; }
      }
    }
  } else {
    // donor startSweepBuy: buy legs fire back-to-back (nonce-serialized by ethtx)
    const results = await Promise.allSettled(legs.map(l => startLeg(l.maker.signerPk, false, l.minima, l.usdt)));
    for (const r of results) if (r.status === "fulfilled") hashes.push(r.value);
    emitter.emit("update");
    return { ok: hashes.length, of: legs.length, hashes };
  }
  emitter.emit("update");
  return { ok: hashes.length, of: legs.length, hashes };
}

// ---- swaps / inspect (donor refreshSwaps + onSwapDetail) ----
async function swaps() {
  const A = AX();
  const all = await p(cb => A.swapdb.allSwaps(cb));
  return jclone(all.map(s => ({ hash: s.hash, role: s.role, direction: s.direction, selltoken: s.sellToken,
    sellamount: s.sellAmount, buytoken: s.buyToken, buyamount: s.buyAmount, status: s.status, updated: s.updated })));
}
async function inspect(hash) {
  const A = AX(), DB = A.swapdb, H = A.htlc, EO = A.ethops;
  const s = await p(cb => DB.getSwap(hash, cb));
  if (!s) return ["No record of this swap."];
  const block = await p(cb => H.currentBlock(cb)).catch(() => -1);
  const coins = await p(cb => H.scanByHash(hash, 2, 256, cb)).catch(() => []);
  let myMin = null, cpMin = null;
  const myPk = vmCtx().htlc.publickey;
  for (const c of coins || []) {
    if (!c || H.normKey(H.stateAt(c, 5) || "") !== H.normKey(hash)) continue;
    if (H.normKey(H.stateAt(c, 0) || "") === H.normKey(myPk)) myMin = c;
    if (H.normKey(H.stateAt(c, 4) || "") === H.normKey(myPk)) cpMin = c;
  }
  const secret = await p(cb => DB.getSecret(hash, cb)).catch(() => null);
  const events = await p(cb => DB.getEvents(hash, cb)).catch(() => []);
  const ops = A.ethops.make(ctx.RPC, vmCtx().eth.privKey, vmCtx().eth.address);
  const facts = { swap: s, block, secretKnown: !!secret, myMin, cpMin, gc: null, gcAmountHuman: "", myEthStillLocked: null, events: events || [] };
  if (s.direction === "MINIMA_TO_ERC20") {
    const gc = await p(cb => ops.getContract(EO.contractId(hash), cb)).catch(() => null);
    if (gc) { facts.gc = gc; facts.gcAmountHuman = A.dec.formatUnits(gc.amount, String(gc.tokenContract).toLowerCase() === EO.NET.usdt.toLowerCase() ? EO.NET.usdtDecimals : 18); }
  } else {
    facts.myEthStillLocked = await p(cb => ops.canCollect(s.contractId, cb)).catch(() => false);
  }
  return jclone(A.inspect.buildReport(facts));
}

// ---- market history / wallet / coins ----
async function marketHistory() {
  const A = AX();
  const chart = await p(cb => A.swapdb.executedTrades(200, cb)).catch(() => []);
  const recent = await p(cb => A.swapdb.recentTrades(50, cb)).catch(() => []);
  return jclone({ chart, recent });
}
async function wallet() {
  const A = AX();
  const b = await balances();
  return jclone({ addr: vmCtx().eth.address, shortAddr: A.wallet.shortAddr(vmCtx().eth.address), bals: b,
    currency: A.trading.active().key, label: A.trading.active().coinLabel });
}
function exportKey() { AX(); return vmCtx().eth.privKey; }   // renderer shows the 2-step native warning flow
async function coins() {
  const A = AX();
  const r = await runner("coins relevant:true sendable:true tokenid:" + A.trading.active().tokenId + " coinage:1").catch(() => null);
  const rows = (r && Array.isArray(r.response)) ? r.response.map(c => ({ amount: A.htlc.coinAmount(c), coinid: c.coinid || "" })) : [];
  rows.sort((a, b2) => Number(b2.amount) - Number(a.amount));
  return jclone(rows.slice(0, 50));
}

// ---- wallet send (donor onSendMax/onSendReview/doSend — raw balances, gas reserve, review-then-broadcast) ----
async function sendMax(asset) {
  const A = AX();
  const b = await balances();
  if (asset === "usdt") return A.dec.formatUnits(BigInt(b.usdtRaw), 6);
  const gp = await p(cb => ctx.RPC.gasPrice(cb));
  return A.dec.formatUnits(A.wallet.maxEthSendWei(BigInt(b.ethWei), gp), 18);
}
async function sendReview(asset, to, amt) {
  const A = AX();
  const b = await balances();
  const gp = await p(cb => ctx.RPC.gasPrice(cb)).catch(() => null);
  if (gp == null) return { err: "Could not read gas price — try again" };
  const chk = A.wallet.checkSend(asset, to, amt, BigInt(b.ethWei), BigInt(b.usdtRaw), gp);
  if (!chk.ok) return { err: chk.err };
  const gasLimit = asset === "eth" ? A.wallet.GAS_ETH : A.wallet.GAS_ERC20;
  return { fee: A.dec.formatUnits(A.wallet.gasReserveWei(gp, gasLimit), 18) };
}
async function sendExecute(asset, to, amt) {
  const A = AX();
  const send = asset === "eth" ? A.wallet.sendEth : A.wallet.sendUsdt;
  // NO timeout: a rejected-but-still-broadcasting send would prompt a retry → a SECOND transfer (fresh nonce via
  // F1 → both land). Let it run to the real broadcast callback (the engine's per-address nonce serializer bounds it).
  const tx = await p(cb => send(ctx.RPC, vmCtx().eth.privKey, vmCtx().eth.address, to, amt, cb));
  emitter.emit("update");
  return { tx };
}

// ---- maker (donor onSaveOrder/onPublish/onWithdraw; the vm service keep-alives whatever is saved) ----
async function makerAvail() { const b = await balances(); return { minima: Number(b.minima) || 0, usdt: Number(b.usdt) || 0 }; }
async function makerCfg() {
  const A = AX();
  await p(cb => A.maker.loadConfig(() => cb(null)));
  return jclone(A.maker._state());
}
async function makerSave(cfg, manual) {
  const A = AX();
  await p(cb => A.maker.saveConfig(jvm(cfg), jvm(manual), () => cb(null)));
  await p(cb => A.maker.refreshPeg(() => cb(null)));
  const avail = await makerAvail();
  await withTimeout(p(cb => A.maker.publish(jvm(avail), e => cb(e))), 60000, "publish");
  emitter.emit("update");
  return { ok: true };
}
async function makerPublish() {
  const A = AX();
  await p(cb => A.maker.refreshPeg(() => cb(null)));
  const avail = await makerAvail();
  await withTimeout(p(cb => A.maker.publish(jvm(avail), e => cb(e))), 60000, "publish");
  emitter.emit("update");
  return { ok: true };
}
async function makerWithdraw() {
  const A = AX();
  const avail = await makerAvail();
  await withTimeout(p(cb => A.maker.tombstone(jvm(avail), e => cb(e))), 60000, "withdraw");
  emitter.emit("update");
  return { ok: true };
}
// cross-realm safety: hand the vm engine COPIES built in its own realm (so it never sees a foreign object).
function jvm(obj) { return toVm(obj); }

// ---- currency switch (donor switchCurrency: tombstone under the OLD identity, then flip the kv — the vm
// service's reloadShared detects it next poll and reconfigures every engine itself) ----
async function switchCurrency(key) {
  const A = AX();
  if (key !== "minima" && key !== "mxusdt") throw new Error("bad currency");
  if (A.trading.active().key === key) return { ok: true };
  const avail = await makerAvail();
  await withTimeout(p(cb => A.maker.onCurrencySwitch(jvm(avail), () => cb(null))), 60000, "switch");
  await p(cb => A.mds.kvSet("trading_currency", key, () => cb(null)));
  fire("MDS_TIMER_60SECONDS");   // nudge reloadShared now instead of waiting for the next block
  emitter.emit("update");
  return { ok: true };
}

// ---- OTC (donor refreshOtc + onOtc*) ----
async function otc() {
  const A = AX();
  const board = await p(cb => A.otc.scanBoard(cb)).catch(() => []);
  await p(cb => A.otc.scanChat(() => cb(null))).catch(() => {});
  const deals = await p(cb => A.otc.allDeals(cb)).catch(() => []);
  return jclone({
    board: (board || []).map(o => ({ cid: o.commsPublicId, mpk: o.minimaPublicKey, eth: o.ethAddress, sell: o.sellSize, buy: o.buySize, ts: o.ts })),
    // drop deals with a malformed side (defense-in-depth vs a hostile peer's PROPOSE — the renderer also esc()s):
    deals: (deals || []).filter(d => d.status !== "EXPIRED" && d.status !== "REJECTED" && d.status !== "COMPLETE" && (d.side === "SELL" || d.side === "BUY")),
    myOffer: A.otc.myOffer()
  });
}
async function otcGoLive(sellSize, buySize) {
  const A = AX();
  A.otc.setMyOffer(true, Number(sellSize) || 0, Number(buySize) || 0);
  await p(cb => A.otc.publishOffer(e => cb(e)));
  emitter.emit("update"); return { ok: true };
}
async function otcWithdraw() {
  const A = AX();
  A.otc.setMyOffer(false, 0, 0);
  await p(cb => A.otc.publishOffer(e => cb(e)));
  emitter.emit("update"); return { ok: true };
}
async function otcPropose(lp, side, amount, price) {
  const A = AX();
  side = String(side || "").trim().toUpperCase();
  if (side !== "SELL" && side !== "BUY") throw new Error("Deal side must be SELL or BUY.");   // never lock the wrong asset
  const lpVm = jvm({ commsPublicId: lp.cid, minimaPublicKey: lp.mpk, ethAddress: lp.eth });
  await p(cb => A.otc.propose(lpVm, side, String(amount), String(price), e => cb(e)));
  emitter.emit("update"); return { ok: true };
}
async function otcDealAction(ref, action, amount, price) {
  const A = AX();
  const d = await p(cb => A.otc.getDeal(ref, cb));
  if (!d) throw new Error("deal not found");
  if (action === "accept") await p(cb => A.otc.accept(d, e => cb(e)));
  else if (action === "reject") await p(cb => A.otc.reject(d, e => cb(e)));
  else if (action === "counter") await p(cb => A.otc.counter(d, String(amount), String(price), e => cb(e)));
  else throw new Error("bad action");
  emitter.emit("update"); return { ok: true };
}

module.exports = {
  emitter, init, startLoop, stopLoop, flush, invalidate, status,
  book, quote, swapExecute, swaps, inspect, marketHistory, wallet, exportKey, coins,
  sendMax, sendReview, sendExecute,
  makerCfg, makerSave, makerPublish, makerWithdraw, switchCurrency,
  otc, otcGoLive, otcWithdraw, otcPropose, otcDealAction,
  _setRunner: (fn) => { runner = fn; }, _setDataDir: (d) => { dataDir = d; },
  _ctx: () => ctx, _fire: fire
};
