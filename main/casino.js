/*
 * casino.js — SETTLE-ONLY glue for the removed "P2P Chance" (Zero Edge Casino) module.
 *
 * P2P Chance left the app in 0.18.68: there is no tab, no game screen and no way to create or take a bet.
 * What stays is the part that gets money OUT of bets a wallet already has on the chain. main.js starts it at once
 * for an install whose config says casinoEnabled. Every other install gets watch(): read-only looks at the covenant
 * (`coins`, `keys` — no newscript, no engine), which start the same loop only if this wallet has a bet there (the old
 * "Disable" button only hid the tab, so a wallet can have live bets with casinoEnabled false). The loop:
 *   - reveals as the house and resolves as the player (main/casino/service.js, unchanged, on each new block);
 *   - withdraws the wallet's own untaken offers: it writes the engine's durable cancel marker, and service.js's
 *     keepalive then sends that offer's stake back to the wallet instead of renewing it;
 *   - claims a pot the moment its timeout allows (engine claimTimeout — this used to be a My Bets button).
 * It can NEVER start anything: the MDS shim refuses `send` (the only command createBet posts with) and every
 * output to the covenant that is not a reveal (which is what a take and an offer renewal both are). See refused().
 *
 * Fund-critical glue points kept from the full module:
 *  - `checkmode` is synthesised to WRITE (service.js gates auto-processing on it).
 *  - MDS.keypair is backed by the OS keychain (config.getSecret/setSecret). The commit preimages
 *    (casino_secret_for_* / casino_psecret_for_*) and casino_history are NEVER deleted or rewritten here.
 *  - the covenant is registered `trackall:false`; own bets stay relevant via core's state-var matching.
 *  - a failed coin scan or an unreadable key list is never read as "nothing open".
 */
const { EventEmitter } = require("events");
const crypto = require("crypto");
const { rpcCall } = require("./rpc");
const { createContext } = require("./casino/loader");

const emitter = new EventEmitter();

const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
// The covenant script — MUST compile to CONTRACT (identical to native + MDS). Verbatim from the donor service.js.
const CASINO_SCRIPT = 'LET hpk=PREVSTATE(0) LET ha=PREVSTATE(1) LET hc=PREVSTATE(2) LET rng=PREVSTATE(3) LET po=PREVSTATE(4) LET bt=PREVSTATE(5) LET ph=PREVSTATE(6) LET to=PREVSTATE(7) IF ph EQ 0 AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF IF ph EQ 0 THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 1 ASSERT STATE(7) EQ to ASSERT STATE(11) GTE 0 AND STATE(11) LT rng ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+bt @TOKENID TRUE) RETURN TRUE ENDIF LET qk=PREVSTATE(8) LET pk=PREVSTATE(11) IF ph EQ 1 AND SIGNEDBY(hpk) THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 2 ASSERT SAMESTATE(7 11) LET hs=STATE(12) ASSERT SHA3(hs) EQ hc ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) RETURN TRUE ENDIF IF ph EQ 1 AND @COINAGE GT to AND SIGNEDBY(qk) THEN RETURN TRUE ENDIF IF ph EQ 2 AND SIGNEDBY(qk) THEN LET ps=STATE(13) ASSERT SHA3(ps) EQ PREVSTATE(10) LET hs=PREVSTATE(12) LET h=SHA3(CONCAT(hs ps)) LET r=NUMBER(SUBSET(0 4 h))%rng IF r EQ pk THEN LET w=bt*po ASSERT VERIFYOUT(@INPUT PREVSTATE(9) w @TOKENID FALSE) IF @AMOUNT GT w THEN ASSERT VERIFYOUT(@INPUT+1 ha @AMOUNT-w @TOKENID FALSE) ENDIF ELSE ASSERT VERIFYOUT(@INPUT ha @AMOUNT @TOKENID FALSE) ENDIF RETURN TRUE ENDIF IF ph EQ 2 AND @COINAGE GT to AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF RETURN FALSE';

const SCAN_EVERY_MS = 12000;
const IDLE_EVERY_MS = 60 * 60 * 1000;   // nothing open: one read-only look an hour (see startLoop)
const WATCH_RETRY_MS = 60 * 1000;        // watch(): the look failed, or the key list was unreadable — look again soon
const RETRY_BLOCKS = 8;                 // a posted txn mines asynchronously — same cooldown service.js uses

// The one choke point: every command the engine issues passes through the shim. Refuse whatever could put new
// value into the covenant. createBet posts with `send`; takeBet and the offer renewal both write an output to
// the covenant. The only covenant output settling needs is the house reveal (same coin, same amount, phase 1→2).
const TO_COVENANT = ("address:" + CONTRACT).toUpperCase();
// The verb is read the way the node reads it (main/cmdverb.js: any case, quoted, trimmed — 0.19.418; /^send\b/ let `SEND` by),
// in every piece of a chain; a chain itself is refused before this by cmdverb.refuse (the node runs what follows a ";").
const V = require("./cmdverb");
function refused(c) {
  return V.parts(c).some(p => {
    if (V.beginsAs(p, "send")) return true;
    return V.is(p, "txnoutput") && p.toUpperCase().includes(TO_COVENANT) && !/^txnoutput id:svc_reveal_/.test(p);
  });
}

let ctx = null;
let serviceHandler = null;    // captured by MDS.init (service.js) — WE fire the events
let ready = false;
let initPromise = null;
let timer = null, active = false, watching = false, loop = 0, lastTip = null;
let outstanding = null;         // null = not known yet; else { offers, bets } for THIS wallet
const acted = new Map();        // coinid → tip when we last posted for it
let generation = 0;
const LOG_RING = [];

let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd, { owner: "casino" });   // owner: main/reserve.js
};

function log(line) {
  const entry = new Date().toISOString().slice(11, 19) + " " + String(line);
  LOG_RING.push(entry); if (LOG_RING.length > 200) LOG_RING.shift();
  console.log("[chance]", String(line));
  try { emitter.emit("log", entry); } catch (e) { /* emitter always defined by call time */ }
}

// ---- keychain-backed keypair (commit preimages + identity cache + history) ----
function kpAccount(key) { return "casino-" + crypto.createHash("sha256").update(String(key)).digest("hex"); }
function kpGet(key) { try { return require("./config").getSecret(kpAccount(key)); } catch (e) { return null; } }
function kpSet(key, value) { try { return require("./config").setSecret(String(value), kpAccount(key)) === true; } catch (e) { return false; } }
function kpDelete(key) { try { require("./config").deleteSecret(kpAccount(key)); } catch (e) {} }

// ---- cross-realm marshalling (parity with atomix; casino uses Array.isArray so it's belt-and-braces) ----
let vmJsonParse = null;
function toVm(obj) {
  try {
    if (!ctx) return obj;
    if (!vmJsonParse) vmJsonParse = require("vm").runInContext("JSON.parse", ctx);
    return vmJsonParse(JSON.stringify(obj));
  } catch (e) { return obj; }
}

function buildMds() {
  return {
    minidappuid: "",
    cmd(command, cb) {
      // the donor calls cmd WITHOUT a callback in places (newscript, txndelete) — valid in the browser shim, so no-op.
      const done = typeof cb === "function" ? cb : () => {};
      let c = String(command);
      { const why = V.refuse("P2P Chance", c); if (why) { done(toVm({ status: false, error: why })); return; } }   // one command (0.19.418)
      if (/^checkmode\b/.test(c)) { done(toVm({ status: true, response: { mode: "WRITE" } })); return; }  // admin RPC is always WRITE
      // Normalise every donor newscript to trackall:false: the row is needed for txnbasics ScriptProofs
      // (track-flag-blind), but trackall:true adopts every stranger's bet into the balance forever — and a
      // stale donor copy re-registering trackall:true would silently re-promote the row (newscript REPLACES).
      if (/^newscript\b/.test(c)) {
        c = c.replace(/\btrackall:true\b/, "trackall:false");
        if (!/\btrackall:/.test(c)) c += " trackall:false";
      }
      if (refused(c)) { log("refused (settle only): " + c.split(" ").slice(0, 2).join(" ")); done(toVm({ status: false, error: "P2P Chance has been removed" })); return; }
      runner(c).then(r => done(toVm(r)), () => done(toVm({ status: false })));
    },
    keypair: {
      get(key, cb) { const v = kpGet(key); cb(v == null ? { status: false, value: null } : { status: true, value: v }); },
      set(key, value, cb) { const ok = kpSet(key, value); if (cb) cb({ status: ok }); }   // report REAL durability (fund-safety: preimage writes gate the send)
    },
    notify(msg) { log("notify: " + msg); },   // claims are posted automatically now; there is no My Bets to send anyone to
    notifycancel() {},
    log(msg) { log(String(msg)); emitter.emit("update"); },
    init(cb) { serviceHandler = cb; }
    // .load is attached by loader.createContext
  };
}

function fire(event) { if (serviceHandler) { try { serviceHandler({ event }); } catch (e) { log("handler error: " + e.message); } } }

async function init() {
  if (ready) return;
  if (initPromise) return initPromise;
  const gen = generation;
  initPromise = (async () => {
    ctx = createContext(buildMds());
    if (gen !== generation) { ctx = null; return; }
    // Register the covenant trackall:false — the ROW enables ScriptProofs (interop); tracking is not needed
    // for discovery (`coins address:` is relevance-free) and only polluted the balance. Assert the address.
    try {
      const reg = await runner('newscript script:"' + CASINO_SCRIPT + '" trackall:false');
      const addr = reg && reg.response && (reg.response.address || reg.response.miniaddress);
      if (addr && String(addr).toUpperCase() !== CONTRACT.toUpperCase()) log("WARNING: chance script address mismatch: " + addr);
      else log("chance script registered (trackall:false) → " + CONTRACT);
    } catch (e) { log("newscript failed: " + (e && e.message)); }
    ready = true;
    fire("inited");   // service.js: checkmode → newscript → keys; then auto-processes on each NEWBLOCK we fire
  })().catch(e => { if (gen === generation) { initPromise = null; ready = false; } log("init failed: " + e.message); throw e; });
  return initPromise;
}

// One settle pass per new block. Throws on a failed scan so the caller leaves `outstanding` as it was.
async function settle(tip) {
  await pcb(cb => C().ensureReady(() => cb(null)));   // identity cached → service.js can pay a withdrawn offer to the wallet
  // service.js pays a withdrawn offer to the keychain copy of the wallet address; the engine caches it only once
  // per run, so a keychain write that failed then would block every withdrawal. Write it when it is missing.
  const me = C().status().address; if (me && !kpGet("casino_hexaddr")) kpSet("casino_hexaddr", me);
  const coins = await rawBets();
  const keys = myKeysCache;
  if (!keys) return;                                  // ownership unprovable → conclude nothing
  const mine = coins.filter(c => c.amHouse || c.amPlayer);
  const offers = mine.filter(c => c.amHouse && String(cstate(c.state, 6)) === "0");
  outstanding = { offers: offers.length, bets: mine.length - offers.length };
  for (const id of [...acted.keys()]) if (!mine.some(c => c.coinid === id)) acted.delete(id);
  const due = (c) => { const at = acted.get(c.coinid); if (at != null && tip - at < RETRY_BLOCKS) return false; acted.set(c.coinid, tip); return true; };
  const O = ctx.CasinoOffers, T = ctx.CasinoTimeouts;
  for (const c of offers) {
    try {
      if (O.valid(c)) {   // service.js posts the withdrawal (two a block) once the marker is durable
        if (kpGet(O.cancelKey(c)) !== "1") await pcb(cb => O.requestCancel(ctx.MDS, c, cb));
      } else if (due(c)) {   // an offer the keepalive will not touch: the engine's own cancel
        await pcb(cb => C().cancelBet(c.coinid, cb)); log("open offer withdrawn " + c.coinid);
      }
    } catch (e) { log("offer withdrawal " + c.coinid + ": " + (e && e.message)); }
  }
  for (const c of mine) {
    if (!T.canClaim(c, pk => keys.has(cnorm(pk))) || !due(c)) continue;
    try { await pcb(cb => C().claimTimeout(c.coinid, cb)); log("timeout claim posted " + c.coinid); }
    catch (e) { log("timeout claim " + c.coinid + ": " + (e && e.message)); }
  }
  if (mine.length) fire("NEWBLOCK");   // service.js: reveal, resolve, withdraw the marked offers
}

// Runs every 12 s while this wallet has something on the covenant. With nothing open it drops to one read-only
// look an hour instead of stopping: a node that is still syncing can show an empty covenant, and a house that
// stopped looking for good would lose a taken bet to the 1500-block timeout (about 21 hours).
function startLoop() {
  if (active) return;
  active = true; loopSince = Date.now();
  const id = ++loop;
  const tick = async () => {
    try {
      await init();
      const r = await runner("block");
      const tip = Number(r && r.response && (r.response.block || r.response));
      if (tip && tip !== lastTip) { await settle(tip); lastTip = tip; emitter.emit("update"); }
    } catch (e) { log("settle: " + (e && e.message)); }
    if (active && id === loop) timer = setTimeout(tick, outstanding && !(outstanding.offers + outstanding.bets) ? IDLE_EVERY_MS : SCAN_EVERY_MS);
  };
  tick();
}
function stopLoop() { active = false; watching = false; loop++; clearTimeout(timer); timer = null; }

// For an install that is NOT casinoEnabled: does this wallet have a bet on the covenant anyway? Read-only (`coins
// address:` and `keys`): no newscript, no engine, nothing written. An own bet starts the settle loop. A failed look
// or an unreadable key list proves nothing, so it is repeated in a minute; a clean "none" is repeated once an hour,
// because a node that is still syncing can show an empty covenant. A wallet with no bets never gets past this.
function watch(retryMs = WATCH_RETRY_MS, idleMs = IDLE_EVERY_MS) {
  if (active || watching) return;
  watching = true;
  const id = ++loop;
  const look = async () => {
    let next = retryMs;
    try {
      const coins = await rawBets();
      if (!watching || id !== loop) return;
      if (myKeysCache) {
        if (coins.some(c => c.amHouse || c.amPlayer)) { watching = false; log("this wallet has P2P Chance bets on the chain: settling them"); startLoop(); return; }
        next = idleMs;
      }
    } catch (e) { /* not known yet */ }
    if (watching && id === loop) timer = setTimeout(look, next);
  };
  look();
}
function flush() { /* keychain writes are synchronous; nothing to debounce */ }

/** Wallet/seed restore: the cached casino identity belongs to the OLD seed — drop it and re-init so getaddress
 *  re-derives under the new seed. Bet secrets and history are left exactly as they are. The loop restarts only
 *  if it was running, the read-only watch only if it was watching: nothing else is started here. This is the one
 *  place the key cache is dropped (the keys belong to the old wallet). */
function invalidate() {
  const was = active, wasWatching = watching;
  generation++;
  stopLoop();
  kpDelete("casino_pubkey"); kpDelete("casino_hexaddr"); kpDelete("casino_miniaddr");
  ctx = null; serviceHandler = null; ready = false; initPromise = null; lastTip = null; vmJsonParse = null; myKeysCache = null;
  outstanding = null; acted.clear();
  emitter.emit("update");
  if (was) startLoop(); else if (wasWatching) watch();
}

function status() {
  const s = (ctx && ctx.CASINO) ? ctx.CASINO.status() : null;
  return { ready: !!(s && s.ready), address: (s && s.address) || null, pubkey: (s && s.pubkey) || null,
    keys: (s && s.keys) || 0, block: lastTip, contract: CONTRACT, log: LOG_RING.slice(-20) };
}
/** What the Settings card shows: null until a clean scan, then how many offers / bets this wallet still has open. */
function open() { return outstanding && { offers: outstanding.offers, bets: outstanding.bets }; }
/** Is the settle loop running (0.19.269)? It runs only for a wallet with bets on the chain: while it runs and open() is
 *  null (no clean scan yet, or its scans fail), whether a bet is open could not be checked. */
function looping() { return active; }
/** How long the running loop has gone without a clean scan (0.19.285), in ms; 0 once it has one or when it does not run. */
let loopSince = 0;
function uncheckedMs() { return active && !outstanding && loopSince ? Date.now() - loopSince : 0; }

function C() { if (!ctx || !ctx.CASINO) throw new Error("P2PChance engine not ready yet"); return ctx.CASINO; }
function pcb(fn) { return new Promise((res, rej) => { try { fn((err, val) => err ? rej(err instanceof Error ? err : new Error(String(err))) : res(val)); } catch (e) { rej(e); } }); }

// ---- the covenant scan ----
const cnorm = (v) => String(v || "").toUpperCase().replace(/^0X/, "");
const cstate = (arr, p) => { const s = (arr || []).find(v => String(v.port) === String(p)); return s ? s.data : ""; };

// Wallet keys are cached and NEVER degraded on a transient `keys` RPC miss — a poisoned empty set would
// mislabel our OWN bets as not-ours and silently drop them from the result pipeline (a real silent-failure cause).
// A SHORT reply does the same damage (16 Nov: a healthy node answered `keys` with part of its list), so each good
// read is ADDED to the cache and the cache never shrinks. Only invalidate() (wallet reset) drops it.
let myKeysCache = null;
async function loadMyKeys() {
  try {
    const k = await runner("keys");
    const list = (k && k.response && (Array.isArray(k.response.keys) ? k.response.keys : k.response)) || [];
    const set = new Set();
    (Array.isArray(list) ? list : []).forEach(x => { const pk = cnorm((x && x.publickey) || x); if (pk) set.add(pk); });
    if (set.size) myKeysCache = new Set([...(myKeysCache || []), ...set]);   // union: never replace, never shrink
  } catch (e) { /* keep the last-good cache */ }
  return myKeysCache || new Set();
}
// rawBets: ALL coins at the covenant (incl. other players'), WITH state, annotated amHouse/amPlayer.
async function rawBets() {
  const r = await runner("coins address:" + CONTRACT + " depth:4096");   // cap above every tree length (stock cascade 2048)
  if (!r || !r.status || !Array.isArray(r.response)) throw new Error("Casino coin scan unavailable");
  const coins = r.response;
  const mine = await loadMyKeys();
  return coins.map(c => ({ coinid: c.coinid, address: c.address, miniaddress: c.miniaddress, amount: c.amount, tokenid: c.tokenid || "0x00", tokenamount: c.tokenamount, age: c.age, created: c.created, state: c.state || [], amHouse: mine.has(cnorm(cstate(c.state, 0))), amPlayer: mine.has(cnorm(cstate(c.state, 8))) }));
}

module.exports = {
  emitter, init, startLoop, watch, stopLoop, flush, invalidate, status, open, looping, uncheckedMs, rawBets, refused,
  _setRunner: (fn) => { runner = fn; }, _ctx: () => ctx, _fire: fire, CONTRACT, CASINO_SCRIPT
};
