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
 *  - the covenant is registered with `trackall:false` (2.8.9 line): `coins address:CONTRACT` is a chain-tree walk
 *    and surfaces other players' open bets WITHOUT tracking; trackall:true only polluted every player's balance
 *    with the whole network's pots. Own bets stay relevant via core's state-var matching (ports 0/1/8/9).
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
      if (/^checkmode\b/.test(c)) { done(toVm({ status: true, response: { mode: "WRITE" } })); return; }  // admin RPC is always WRITE
      // Normalise every donor newscript to trackall:false: the row is needed for txnbasics ScriptProofs
      // (track-flag-blind), but trackall:true adopts every stranger's bet into the balance forever — and a
      // stale donor copy re-registering trackall:true would silently re-promote the row (newscript REPLACES).
      if (/^newscript\b/.test(c)) {
        c = c.replace(/\btrackall:true\b/, "trackall:false");
        if (!/\btrackall:/.test(c)) c += " trackall:false";
      }
      if (CASINO_SEND.test(c)) {
        const insuf = "Not enough spendable MINIMA for this stake — you can only stake coins your own wallet holds (check the sendable balance in the header).";
        pinMinimaSend(runner, c).then(p => runner(p)).then(
          r => { if (r && r.status === false && !r.error) r.error = insuf; done(toVm(r)); },
          () => done(toVm({ status: false, error: insuf }))
        );
        return;
      }
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
  ctx = null; serviceHandler = null; ready = false; initPromise = null; lastTip = null; vmJsonParse = null; myKeysCache = null;
  emitter.emit("update");
  startLoop();
}

function status() {
  const s = (ctx && ctx.CASINO) ? ctx.CASINO.status() : null;
  return { ready: !!(s && s.ready), address: (s && s.address) || null, pubkey: (s && s.pubkey) || null,
    keys: (s && s.keys) || 0, block: lastTip, contract: CONTRACT, log: LOG_RING.slice(-20) };
}

// ---- read-model + actions ----
function C() { if (!ctx || !ctx.CASINO) throw new Error("P2PChance engine not ready yet"); return ctx.CASINO; }
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

// ---- raw reads for the renderer's per-block state machine (rich activity feed) + maker result detection ----
const cnorm = (v) => String(v || "").toUpperCase().replace(/^0X/, "");
const cstate = (arr, p) => { const s = (arr || []).find(v => String(v.port) === String(p)); return s ? s.data : ""; };
const cmnum = (v) => parseFloat(parseFloat(v).toFixed(8));
function cgame(range) { range = parseInt(range); return range === 2 ? "Coin Flip" : range === 6 ? "Dice" : range === 36 ? "Roulette" : "Custom (" + range + ")"; }
function cpick(range, pick) { range = parseInt(range); const p = parseInt(pick); if (isNaN(p)) return "—"; return range === 2 ? (p === 0 ? "Heads" : "Tails") : String(p + 1); }

// Wallet keys are cached and NEVER degraded to empty on a transient `keys` RPC miss — a poisoned empty set would
// mislabel our OWN bets as not-ours and silently drop them from the result pipeline (a real silent-failure cause).
let myKeysCache = null;
async function loadMyKeys() {
  try {
    const k = await runner("keys");
    const list = (k && k.response && (k.response.keys || k.response)) || [];
    const set = new Set();
    (Array.isArray(list) ? list : []).forEach(x => { const pk = cnorm((x && x.publickey) || x); if (pk) set.add(pk); });
    if (set.size) myKeysCache = set;   // replace only on a good fetch
  } catch (e) { /* keep the last-good cache */ }
  return myKeysCache || new Set();
}
// rawBets: ALL coins at the covenant (incl. other players'), WITH state, annotated amHouse/amPlayer.
async function rawBets() {
  const r = await runner("coins address:" + CONTRACT + " depth:4096");   // cap above every tree length (stock cascade 2048)
  const coins = (r && r.response) || [];
  const mine = await loadMyKeys();
  return coins.map(c => ({ coinid: c.coinid, address: c.address, miniaddress: c.miniaddress, amount: c.amount, age: c.age, created: c.created, state: c.state || [], amHouse: mine.has(cnorm(cstate(c.state, 0))), amPlayer: mine.has(cnorm(cstate(c.state, 8))) }));
}
async function walletCoins() { const r = await runner("coins relevant:true tokenid:0x00"); return (r && r.response) || []; }

// stakeable: the biggest bet the wallet can ACTUALLY place right now = the largest SINGLE signable (own-key)
// address's SENDABLE MINIMA total. The node's raw balance/`sendable` inflates this with in-play covenant coins
// (they sit at the shared casino address, NOT wallet-spendable) and pending coins, so a stake shown as affordable
// could be rejected for insufficient funds. A stake at or under this ceiling can always be funded (pinMinimaSend
// pins that same address, combining its coins). checkaddress → {simple:true} is the reliable own-key test.
async function stakeable() {
  let coins; try { const r = await runner("coins relevant:true sendable:true tokenid:0x00"); coins = (r && r.response) || []; } catch (e) { return "0"; }
  const byAddr = {};
  for (const c of coins) {
    const addr = String(c.address || ""); const amt = Number(c.amount) || 0;
    if (addr.length < 42 || amt <= 0) continue;
    byAddr[addr] = (byAddr[addr] || 0) + amt;
  }
  let best = 0;
  for (const addr of Object.keys(byAddr)) {
    try { const chk = await runner("checkaddress address:" + addr); if (chk && chk.response && chk.response.simple) best = Math.max(best, byAddr[addr]); } catch (e) {}
  }
  return String(best);
}

// resolveOutcome: MECHANISM B — read the taker's RESOLVE transaction, which is self-contained: it carries
// player_secret in txn.state[13] AND the spent bet coin with FULL state (incl. house_secret[12]). So EITHER side
// computes the EXACT result the instant the taker resolves. Matched by the house commit (state[2], survives all
// phases). Writes the shared casino_history keychain so History/badge update, and emits notify/update.
async function resolveOutcome(commit, role) {
  const want = cnorm(commit);
  let r; try { r = await runner("txpow address:" + CONTRACT); } catch (e) { return { found: false }; }
  const list = (r && r.response) || [];
  for (const tp of list) {
    const txn = (tp && tp.body && tp.body.txn) || (tp && tp.txn) || null; if (!txn) continue;
    const ps = cstate(txn.state, 13); if (!ps) continue;                        // only resolve txns carry state[13]
    const inp = (txn.inputs || [])[0]; if (!inp) continue;
    if (cnorm(inp.address) !== cnorm(CONTRACT)) continue;
    if (cnorm(cstate(inp.state, 2)) !== want) continue;                         // our bet, by commit
    const hs = cstate(inp.state, 12);
    const range = parseInt(cstate(inp.state, 3)) || 2, payout = parseInt(cstate(inp.state, 4)) || range;
    const bet = cstate(inp.state, 5) || "0", pick = parseInt(cstate(inp.state, 11));
    const amount = parseFloat(inp.amount) || 0, playerAddr = cstate(inp.state, 9);
    let exactResult = null, hashPlayerWins;
    try {                                                                        // mirror service.js:211-214
      const hres = await runner("hash data:" + String(hs) + String(ps).substring(2));   // hs keeps 0x, ps drops its 0x
      const hash = (hres && hres.response && hres.response.hash) || "";
      exactResult = parseInt(hash.substring(2, 10), 16) % range;
      hashPlayerWins = (exactResult === pick);
    } catch (e) {}
    const winnings = cmnum(parseFloat(bet) * payout);
    const paidPlayer = (txn.outputs || []).some(o => cnorm(o.address) === cnorm(playerAddr) && Math.abs(parseFloat(o.amount) - winnings) < 0.001);
    let playerWins = (hashPlayerWins === undefined) ? paidPlayer : hashPlayerWins;
    if (hashPlayerWins !== undefined && hashPlayerWins !== paidPlayer) playerWins = paidPlayer;   // outputs = consensus truth
    const won = role === "House" ? !playerWins : playerWins;
    const profit = role === "House" ? (won ? parseFloat(bet) : cmnum(parseFloat(bet) * (payout - 1))) : (won ? cmnum(winnings - parseFloat(bet)) : parseFloat(bet));
    const coinid = inp.coinid, pickLabel = cpick(range, pick), rLabel = exactResult != null ? cpick(range, exactResult) : "—";
    try {
      const rawh = kpGet("casino_history"); let hist = []; try { if (rawh) hist = JSON.parse(rawh); } catch (e) {}
      if (!hist.some(h => h.coinid === coinid)) {
        hist.unshift({ coinid, role, game: cgame(range), range, pickLabel, resultLabel: rLabel, profit, won, bet, amount, txid: coinid, time: Date.now() });
        if (hist.length > 50) hist.pop(); kpSet("casino_history", JSON.stringify(hist));
      }
    } catch (e) {}
    emitter.emit("notify", (won ? "You WON +" : "You lost −") + profit + " Minima — " + cgame(range));
    emitter.emit("update");
    return { found: true, coinid, won, playerWins, result: exactResult, resultLabel: rLabel, pick, pickLabel, range, payout, bet, amount };
  }
  return { found: false };
}

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
  openBets, myBets, history, balance, rawBets, walletCoins, stakeable, resolveOutcome,
  create, take, cancel, resolve, reveal, claimTimeout, newCount, markSeen,
  _setRunner: (fn) => { runner = fn; }, _ctx: () => ctx, _fire: fire, CONTRACT, CASINO_SCRIPT
};
