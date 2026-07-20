/*
 * casino.js — the desktop orchestrator for the Zero Edge Casino module (DESKTOP-ONLY glue; the engine under
 * main/casino/ runs VERBATIM in a vm — see loader.js). Mirrors main/atomix.js: build the MDS shim, init
 * idempotently, drive service.js with the block events it expects (inited / NEWBLOCK), expose a JSON-safe
 * read-model + promise-wrapped actions to the renderer over IPC.
 *
 * FUND-CRITICAL glue points (the reasons this file exists rather than calling the node directly):
 *  - `checkmode` is synthesised to WRITE (there is no MDS READ/WRITE minidapp mode over the admin RPC; service.js
 *    gates auto-processing on it).
 *  - the house-create `send` (the only bare MINIMA send in the casino) is routed through sendpin.pinMinimaSend so
 *    the node can't auto-select anyone-can-spend beacon dust on the shared node (KeyRow.getPrivateKey() NPE).
 *  - MDS.keypair is backed by the OS keychain (config.getSecret/setSecret, sync-durable). The commit preimages
 *    (casino_secret_for_* / casino_psecret_for_*) are the crown jewels — a lost preimage strands the pot until the
 *    1500-block timeout — so they are written durably BEFORE the on-chain send. Keys are hashed to a stable account
 *    token so uppercase-hex commits can't collide in the keychain/file-fallback path.
 *  - the covenant is registered with `trackall:true` so `coins address:CONTRACT` surfaces OTHER players' open bets
 *    (discovery + native/MDS interop); the donor's plain newscript is insufficient on a fresh node.
 */
const { EventEmitter } = require("events");
const crypto = require("crypto");
const { rpcCall } = require("./rpc");
const { createContext } = require("./casino/loader");
const { pinMinimaSend } = require("./sendpin");
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();

const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
// The covenant script — MUST compile to CONTRACT (identical to native + MDS). Verbatim from the donor service.js.
const CASINO_SCRIPT = 'LET hpk=PREVSTATE(0) LET ha=PREVSTATE(1) LET hc=PREVSTATE(2) LET rng=PREVSTATE(3) LET po=PREVSTATE(4) LET bt=PREVSTATE(5) LET ph=PREVSTATE(6) LET to=PREVSTATE(7) IF ph EQ 0 AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF IF ph EQ 0 THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 1 ASSERT STATE(7) EQ to ASSERT STATE(11) GTE 0 AND STATE(11) LT rng ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+bt @TOKENID TRUE) RETURN TRUE ENDIF LET qk=PREVSTATE(8) LET pk=PREVSTATE(11) IF ph EQ 1 AND SIGNEDBY(hpk) THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 2 ASSERT SAMESTATE(7 11) LET hs=STATE(12) ASSERT SHA3(hs) EQ hc ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) RETURN TRUE ENDIF IF ph EQ 1 AND @COINAGE GT to AND SIGNEDBY(qk) THEN RETURN TRUE ENDIF IF ph EQ 2 AND SIGNEDBY(qk) THEN LET ps=STATE(13) ASSERT SHA3(ps) EQ PREVSTATE(10) LET hs=PREVSTATE(12) LET h=SHA3(CONCAT(hs ps)) LET r=NUMBER(SUBSET(0 4 h))%rng IF r EQ pk THEN LET w=bt*po ASSERT VERIFYOUT(@INPUT PREVSTATE(9) w @TOKENID FALSE) IF @AMOUNT GT w THEN ASSERT VERIFYOUT(@INPUT+1 ha @AMOUNT-w @TOKENID FALSE) ENDIF ELSE ASSERT VERIFYOUT(@INPUT ha @AMOUNT @TOKENID FALSE) ENDIF RETURN TRUE ENDIF IF ph EQ 2 AND @COINAGE GT to AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF RETURN FALSE';

const SCAN_EVERY_MS = 12000;
const CASINO_SEND = /^send\s/;   // the only bare send in the casino is the house-create MINIMA stake

let ctx = null;
let serviceHandler = null;    // captured by MDS.init (service.js) — WE fire the events
let ready = false;
let initPromise = null;
let pollTimer = null, lastTip = null;
let generation = 0;
const LOG_RING = [];

let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};

function log(line) {
  const entry = new Date().toISOString().slice(11, 19) + " " + String(line);
  LOG_RING.push(entry); if (LOG_RING.length > 200) LOG_RING.shift();
  console.log("[casino]", String(line));
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
      if (/^checkmode\b/.test(c)) { done(toVm({ status: true, response: { mode: "WRITE" } })); return; }  // admin RPC is always WRITE
      // The donor's service.js re-registers the covenant with a PLAIN newscript (no trackall). Force trackall:true
      // onto every newscript so it can never clobber the tracking that surfaces OTHER players' open bets (discovery).
      if (/^newscript\b/.test(c) && !/\btrackall:/.test(c)) c += " trackall:true";
      if (CASINO_SEND.test(c)) { pinMinimaSend(runner, c).then(p => runner(p)).then(r => done(toVm(r)), () => done(toVm({ status: false }))); return; }
      runner(c).then(r => done(toVm(r)), () => done(toVm({ status: false })));
    },
    keypair: {
      get(key, cb) { const v = kpGet(key); cb(v == null ? { status: false, value: null } : { status: true, value: v }); },
      set(key, value, cb) { const ok = kpSet(key, value); if (cb) cb({ status: ok }); }   // report REAL durability (fund-safety: preimage writes gate the send)
    },
    notify(msg) { log("notify: " + msg); emitter.emit("notify", String(msg)); },
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
    // Register the covenant WITH trackall:true (discovery + interop). Assert it resolves to the shared address.
    try {
      const reg = await runner('newscript script:"' + CASINO_SCRIPT + '" trackall:true');
      const addr = reg && reg.response && (reg.response.address || reg.response.miniaddress);
      if (addr && String(addr).toUpperCase() !== CONTRACT.toUpperCase()) log("WARNING: casino script address mismatch: " + addr);
      else log("casino script registered (trackall) → " + CONTRACT);
    } catch (e) { log("newscript failed: " + (e && e.message)); }
    ready = true;
    fire("inited");   // service.js: checkmode → newscript → keys; then auto-processes on each NEWBLOCK we fire
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
}
function stopLoop() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function flush() { /* keychain writes are synchronous; nothing to debounce */ }

/** Wallet/seed restore: the cached casino identity belongs to the OLD seed — drop it and re-init so getaddress
 *  re-derives under the new seed. Old bet secrets are left (harmless; those coins no longer exist for us). */
function invalidate() {
  generation++;
  stopLoop();
  kpDelete("casino_pubkey"); kpDelete("casino_hexaddr"); kpDelete("casino_miniaddr");
  ctx = null; serviceHandler = null; ready = false; initPromise = null; lastTip = null; vmJsonParse = null;
  emitter.emit("update");
  startLoop();
}

function status() {
  const s = (ctx && ctx.CASINO) ? ctx.CASINO.status() : null;
  return { ready: !!(s && s.ready), address: (s && s.address) || null, pubkey: (s && s.pubkey) || null,
    keys: (s && s.keys) || 0, block: lastTip, contract: CONTRACT, log: LOG_RING.slice(-20) };
}

// ---- read-model + actions ----
function C() { if (!ctx || !ctx.CASINO) throw new Error("Casino engine not ready yet"); return ctx.CASINO; }
function pcb(fn) { return new Promise((res, rej) => { try { fn((err, val) => err ? rej(err instanceof Error ? err : new Error(String(err))) : res(val)); } catch (e) { rej(e); } }); }
function jclone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

async function openBets() { return jclone(await pcb(cb => C().openBets(cb))); }
async function myBets() { return jclone(await pcb(cb => C().myBets(cb))); }
async function history() { return jclone(await pcb(cb => C().history(cb))); }
async function balance() { return await pcb(cb => C().balance(cb)); }
async function create(preset, bet) { const r = await pcb(cb => C().createBet(preset, bet, cb)); emitter.emit("update"); return jclone(r); }
async function take(coinid, pick) { const r = await pcb(cb => C().takeBet(coinid, pick, cb)); emitter.emit("update"); return jclone(r); }
async function cancel(coinid) { const r = await pcb(cb => C().cancelBet(coinid, cb)); emitter.emit("update"); return jclone(r); }
async function resolve(coinid) { const r = await pcb(cb => C().manualResolve(coinid, cb)); emitter.emit("update"); return jclone(r); }
async function reveal(coinid) { const r = await pcb(cb => C().manualReveal(coinid, cb)); emitter.emit("update"); return jclone(r); }
async function claimTimeout(coinid) { const r = await pcb(cb => C().claimTimeout(coinid, cb)); emitter.emit("update"); return jclone(r); }

// ---- unseen-result badge (history entries newer than the last time the user opened the tab) ----
async function newCount() {
  try {
    const hist = await pcb(cb => C().history(cb));
    const seen = Number(kpGet("casino_seen_ts") || 0);
    return (hist || []).filter(h => (Number(h.time) || 0) > seen).length;
  } catch (e) { return 0; }
}
async function markSeen() {
  try {
    const hist = await pcb(cb => C().history(cb)).catch(() => []);
    let max = 0; (hist || []).forEach(h => { if ((Number(h.time) || 0) > max) max = Number(h.time); });
    kpSet("casino_seen_ts", String(max || Date.now()));
  } catch (e) {}
  return true;
}

module.exports = {
  emitter, init, startLoop, stopLoop, flush, invalidate, status,
  openBets, myBets, history, balance,
  create, take, cancel, resolve, reveal, claimTimeout, newCount, markSeen,
  _setRunner: (fn) => { runner = fn; }, _ctx: () => ctx, _fire: fire, CONTRACT, CASINO_SCRIPT
};
