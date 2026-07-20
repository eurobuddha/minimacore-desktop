/*
 * vestr.js — desktop orchestrator for the Vestr token-vesting module. A native reproduction (no vm) of the MDS
 * Vestr 1.8.1 dapp + the native Android app, over the local node's RPC. Vestr locks a token amount to a beneficiary
 * over a start→end block window, released LINEARLY and collectable no more often than a grace cadence; the
 * beneficiary collects the vested-so-far amount. No cancel (covenant has no owner-refund path). Stateless — no
 * off-chain secrets, no DB. All manual (no auto-collect).
 *
 * FUND-CRITICAL, copied VERBATIM from the 1.8.1 donor (consensus-load-bearing — do not "tidy"):
 *  - CLEAN_SCRIPT (the covenant) → deploys to 0x3C43…C8BE (the shared network: web MDS ↔ native Android ↔ desktop).
 *  - CHECK_MATHS → run on the NODE (runscript) to get the exact SIGDIG(2) collectable/change; the client never
 *    computes the posted amount (BigDecimal rounding would differ from SIGDIG(2) and fail the covenant).
 *  - the collect txn ORDER: payout output @INPUT (no state) then change @INPUT+1 (keep state), state ports carried.
 * Token-grain: a TOKEN coin's spendable amount is `tokenamount` (MINIMA 0x00 uses `amount`).
 */
const { EventEmitter } = require("events");
const crypto = require("crypto");
const { rpcCall } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();

// The covenant. VERBATIM from vestr 1.8.1 `vestingContract.cleanScript`. Registered via newscript → adopt the
// returned address; it must equal CONTRACT (verified live: this exact string deploys there, 20 live vests).
const CLEAN_SCRIPT = 'LET unlockaddress=PREVSTATE(0) LET totallockedamount=PREVSTATE(1) LET startblock=PREVSTATE(2) LET finalblock=PREVSTATE(3) LET minblockwait=PREVSTATE(4) ASSERT SAMESTATE(0 8) ASSERT PREVSTATE(199) EQ STATE(199) IF @BLOCK GTE finalblock THEN IF VERIFYOUT(@INPUT unlockaddress @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF ENDIF IF @BLOCK LT startblock THEN RETURN FALSE ENDIF IF @COINAGE LT minblockwait THEN RETURN FALSE ENDIF LET totalduration=finalblock-startblock IF totalduration LTE 0 THEN LET blockamount=@AMOUNT ELSE LET blockamount=SIGDIG(2(totallockedamount/totalduration)) ENDIF LET owedamounttime=@BLOCK-startblock LET owedamountminima=owedamounttime*blockamount LET alreadycollected=totallockedamount-@AMOUNT LET cancollect=SIGDIG(2(owedamountminima-alreadycollected)) IF cancollect LTE 0 THEN RETURN FALSE ENDIF IF cancollect GT @AMOUNT THEN LET cancollect=@AMOUNT ENDIF LET payout=GETOUTAMT(@INPUT) IF GETOUTADDR(@INPUT) NEQ unlockaddress THEN RETURN FALSE ENDIF IF GETOUTTOK(@INPUT) NEQ @TOKENID THEN RETURN FALSE ENDIF IF payout GT cancollect THEN RETURN FALSE ENDIF IF GETOUTKEEPSTATE(@INPUT) NEQ FALSE THEN RETURN FALSE ENDIF LET change=@AMOUNT-payout IF change LTE 0 THEN RETURN TRUE ENDIF RETURN VERIFYOUT(@INPUT+1 @ADDRESS change @TOKENID TRUE)';
// Off-chain mirror run via `runscript` to preview the exact collectable/change (VERBATIM 1.8.1 `checkMaths`,
// whitespace-collapsed — KISS is whitespace-insensitive and this is not address-sensitive).
const CHECK_MATHS = 'LET totallockedamount=PREVSTATE(1) LET startblock=PREVSTATE(2) LET finalblock=PREVSTATE(3) LET minblockwait=PREVSTATE(4) LET mustwaitblocks="0" LET mustwait= (@BLOCK - @COINAGE) GT "0" AND minblockwait GT (@BLOCK - @COINAGE) LET contractexpired = @BLOCK GTE finalblock IF mustwait EQ TRUE THEN LET mustwaitblocks=minblockwait - (@BLOCK - @COINAGE) ENDIF LET coinsage=@COINAGE LET cliffed=@BLOCK LT startblock LET totalduration=finalblock-startblock IF totalduration LTE 0 THEN LET blockamount=@AMOUNT ELSE LET blockamount=SIGDIG(2 (totallockedamount/totalduration)) ENDIF LET owedamounttime=@BLOCK-startblock LET owedamountminima=owedamounttime*blockamount LET alreadycollected=totallockedamount-@AMOUNT LET cancollect=SIGDIG(2 (owedamountminima - alreadycollected)) IF cancollect GT @AMOUNT THEN LET cancollect=@AMOUNT ENDIF LET change=@AMOUNT-cancollect LET totalsum = change + cancollect LET totalinput = @AMOUNT IF contractexpired EQ TRUE THEN LET mustwait=FALSE ENDIF IF contractexpired EQ TRUE THEN LET cancollect=@AMOUNT ENDIF';

const CONTRACT = "0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE";
const SECONDS_PER_BLOCK = 50;
// grace cadence (hours) — 1.8.1 gracePeriods + native's None; blocks = hours*3600/50.
const GRACE = { None: 0, Daily: 24, Weekly: 168, Monthly: 720, Every_3_Months: 2190, Every_6_Months: 4320, Yearly: 8640 };
const SCAN_EVERY_MS = 12000;

let scriptAddress = null;       // adopted from newscript at init (== CONTRACT)
let ready = false, initPromise = null;
let pollTimer = null, lastTip = null;
const LOG_RING = [];

let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
function log(line) { const e = new Date().toISOString().slice(11, 19) + " " + String(line); LOG_RING.push(e); if (LOG_RING.length > 200) LOG_RING.shift(); console.log("[vestr]", String(line)); }

// ---- helpers ----
function stateVar(coin, port) { for (const s of (coin.state || [])) { if (s.port === port || s.port == port) return s.data; } return ""; }
function coinAmount(coin) { return String(coin.tokenid === "0x00" ? coin.amount : coin.tokenamount); }   // token-grain gotcha
async function tip() { const r = await runner("block").catch(() => null); return r && r.response && (parseInt(r.response.block) || 0) || 0; }
async function runScriptVars(script, prevstate, globals) {
  const cmd = 'runscript script:"' + script + '" prevstate:' + JSON.stringify(prevstate) + " globals:" + JSON.stringify(globals);
  const r = await runner(cmd).catch(() => null);
  return (r && r.response && (r.response.variables || r.response.variable)) || {};
}

async function init() {
  if (ready) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const reg = await runner('newscript script:"' + CLEAN_SCRIPT + '" trackall:false');
    const addr = reg && reg.response && (reg.response.address || reg.response.miniaddress);
    scriptAddress = addr || CONTRACT;
    if (String(scriptAddress).toUpperCase() !== CONTRACT.toUpperCase()) log("WARNING: vestr script address mismatch: " + scriptAddress);
    else log("vestr covenant registered → " + CONTRACT);
    ready = true;
  })().catch(e => { initPromise = null; ready = false; log("init failed: " + (e && e.message)); throw e; });
  return initPromise;
}

function startLoop() {
  if (pollTimer) return;
  const t = () => init().then(() => runner("block").then(r => {
    const b = r && r.response && r.response.block;
    if (b && b !== lastTip) { lastTip = b; emitter.emit("update"); }
  }).catch(() => {})).catch(() => {});
  t(); pollTimer = setInterval(t, SCAN_EVERY_MS);
}
function stopLoop() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---- read model: list vests ----
function graceLabel(hours) { const k = Object.keys(GRACE).find(k => GRACE[k] === Number(hours)); return k ? k.replace(/_/g, " ") : (hours > 0 ? hours + "h" : "Continuous"); }
async function contractFromCoin(coin, tp) {
  const total = stateVar(coin, 1), startBlock = parseInt(stateVar(coin, 2)) || 0, endBlock = parseInt(stateVar(coin, 3)) || 0;
  const amount = coinAmount(coin);
  const v = await runScriptVars(CHECK_MATHS,
    { 1: stateVar(coin, 1), 2: stateVar(coin, 2), 3: stateVar(coin, 3), 4: stateVar(coin, 4), 5: stateVar(coin, 5) },
    { "@AMOUNT": amount, "@BLOCK": tp, "@COINAGE": coin.created });
  const num = x => Number(x) || 0;
  const cancollect = String(v.cancollect != null ? v.cancollect : "0");
  const expired = String(v.contractexpired) === "TRUE" || tp >= endBlock;
  const cliffed = String(v.cliffed) === "TRUE" || tp < startBlock;
  const mustwait = String(v.mustwait) === "TRUE";
  const collected = String(Math.max(0, num(total) - num(amount)));
  const pct = num(total) > 0 ? Math.max(0, Math.min(100, Math.round((num(total) - num(amount)) / num(total) * 100 + (num(cancollect) / num(total)) * 100))) : 0;
  return {
    coinid: coin.coinid, tokenid: coin.tokenid, uid: stateVar(coin, 199),
    beneficiary: stateVar(coin, 0), total, amount, collected,
    startBlock, endBlock, graceHours: parseInt(stateVar(coin, 7)) || 0, graceLabel: graceLabel(stateVar(coin, 7)),
    startMs: parseInt(stateVar(coin, 6)) || 0, endMs: parseInt(stateVar(coin, 8)) || 0, createdMs: parseInt(stateVar(coin, 5)) || 0,
    cancollect, change: String(v.change != null ? v.change : "0"), mustwaitblocks: String(v.mustwaitblocks || "0"),
    cliffed, expired, mustwait, canCollectNow: !cliffed && !mustwait && num(cancollect) > 0,
    pctVested: expired ? 100 : pct
  };
}
async function list() {
  await init();
  const tp = await tip();
  const r = await runner("coins address:" + scriptAddress + " relevant:true").catch(() => null);
  const coins = (r && Array.isArray(r.response)) ? r.response : [];
  const out = [];
  for (const c of coins) { if (!stateVar(c, 199)) continue; try { out.push(await contractFromCoin(c, tp)); } catch (e) {} }
  return out.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
}

// ---- balances / tokens for the Create picker ----
async function tokens() {
  await init();
  const r = await runner("balance").catch(() => null);
  const rows = (r && Array.isArray(r.response)) ? r.response : [];
  return rows.map(b => ({ tokenid: b.tokenid, name: b.tokenid === "0x00" ? "MINIMA" : ((b.token && (b.token.name || b.token)) || String(b.tokenid).slice(0, 10)), sendable: String(b.sendable) }));
}
async function myAddress() { const r = await runner("getaddress").catch(() => null); return r && r.response && (r.response.miniaddress || r.response.address) || ""; }

// ---- create / lock (VERBATIM 1.8.1 send with the 10-port state map) ----
async function blockHeightForDate(whenMs, tp) { return tp + Math.round((Number(whenMs) - Date.now()) / 1000 / SECONDS_PER_BLOCK); }
async function create(opts) {
  await init();
  const { tokenid, amount, beneficiary, startMs, endMs, graceHours, burn, password } = opts || {};
  if (!(Number(amount) > 0)) throw new Error("Enter a valid amount to lock");
  if (!beneficiary) throw new Error("Enter a beneficiary address");
  if (!(Number(endMs) > Number(startMs))) throw new Error("End must be after start");
  const chk = await runner("checkaddress address:" + beneficiary).catch(() => null);
  const addr0x = chk && chk.response && chk.response["0x"];
  if (!addr0x) throw new Error("Invalid beneficiary address");
  const tp = await tip();
  const startBlock = await blockHeightForDate(startMs, tp), endBlock = await blockHeightForDate(endMs, tp);
  const minblockwait = Math.floor((Number(graceHours) || 0) * 3600 / SECONDS_PER_BLOCK);
  const uid = "0x" + crypto.randomBytes(32).toString("hex").toUpperCase();
  const now = Date.now();
  const state = '{"0":"' + addr0x + '","1":"' + amount + '","2":"' + startBlock + '","3":"' + endBlock + '","4":"' + minblockwait + '","5":"' + now + '","6":"' + Number(startMs) + '","7":"' + (Number(graceHours) || 0) + '","8":"' + Number(endMs) + '","199":"' + uid + '"}';
  let cmd = "send debug:false " + (password ? "password:" + password + " " : "") + "amount:" + amount + " address:" + CONTRACT + " tokenid:" + tokenid + " state:" + state;
  if (burn && Number(burn) > 0) cmd += " burn:" + burn;
  if (tokenid === "0x00") cmd = await pinMinimaSend(runner, cmd);   // MINIMA lock: dodge shared-node beacon-dust NPE
  const res = await runner(cmd);
  if (res && (res.status || res.pending)) { emitter.emit("update"); return { ok: true, uid }; }
  throw new Error((res && res.error) || "Lock failed");
}

// ---- collect / claim (VERBATIM 1.8.1 order — amount from the NODE via runscript) ----
async function collect(coinid, burn) {
  await init();
  const cr = await runner("coins coinid:" + coinid).catch(() => null);
  const coin = cr && Array.isArray(cr.response) && cr.response[0];
  if (!coin) throw new Error("Contract coin not found (already collected?)");
  const tp = await tip();
  const v = await runScriptVars(CHECK_MATHS,
    { 1: stateVar(coin, 1), 2: stateVar(coin, 2), 3: stateVar(coin, 3), 4: stateVar(coin, 4), 5: stateVar(coin, 5) },
    { "@AMOUNT": coinAmount(coin), "@BLOCK": tp, "@COINAGE": coin.created });
  const cancollect = String(v.cancollect != null ? v.cancollect : "0");
  const change = String(v.change != null ? v.change : "0");
  if (!(Number(cancollect) > 0)) throw new Error("Nothing available to collect yet");
  const withdrawalAddress = stateVar(coin, 0), tokenid = coin.tokenid;
  const id = "vc" + Math.floor(Math.random() * 1e9);
  const cmds = [];
  cmds.push("txncreate id:" + id);
  cmds.push("txninput id:" + id + " coinid:" + coinid + " scriptmmr:true");
  cmds.push("txnoutput id:" + id + " address:" + withdrawalAddress + " amount:" + cancollect + " tokenid:" + tokenid + " storestate:false");
  if (Number(change) > 0) cmds.push("txnoutput id:" + id + " address:" + CONTRACT + " amount:" + change + " tokenid:" + tokenid + " storestate:true");
  for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 199]) cmds.push("txnstate id:" + id + " port:" + p + " value:" + stateVar(coin, p));
  cmds.push("txnpost id:" + id + (burn && Number(burn) > 0 ? " burn:" + burn : ""));
  try {
    for (const c of cmds) { const r = await runner(c); if (r && r.status === false && !r.pending) { await runner("txndelete id:" + id).catch(() => {}); throw new Error("collect step failed: " + (r.error || c.split(" ")[0])); } }
    emitter.emit("update");
    return { ok: true, collected: cancollect, tokenid };
  } finally { await runner("txndelete id:" + id).catch(() => {}); }
}

// ---- calculate (offline preview — display only, NOT fund-critical) ----
function calculate(amount, startMs, endMs, graceHours) {
  const a = Number(amount) || 0, durSec = (Number(endMs) - Number(startMs)) / 1000;
  const durBlocks = Math.max(0, Math.round(durSec / SECONDS_PER_BLOCK));
  const perBlock = durBlocks > 0 ? a / durBlocks : 0;
  const gh = Number(graceHours) || 0, perPeriodBlocks = gh > 0 ? Math.floor(gh * 3600 / SECONDS_PER_BLOCK) : 1;
  const perPeriod = perBlock * perPeriodBlocks;
  return { durBlocks, perBlock, perPeriod, perPeriodBlocks, graceLabel: graceLabel(graceHours), weeks: durBlocks / (7 * 24 * 3600 / SECONDS_PER_BLOCK) };
}

function status() { return { ready, address: scriptAddress, contract: CONTRACT, block: lastTip, grace: GRACE, log: LOG_RING.slice(-20) }; }

module.exports = {
  emitter, init, startLoop, stopLoop, status,
  list, tokens, myAddress, create, collect, calculate,
  _setRunner: (fn) => { runner = fn; }, CONTRACT, CLEAN_SCRIPT
};
