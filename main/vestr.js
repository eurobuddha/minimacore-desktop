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
const { rpcCall, oneCommand } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const V = require("./validate");
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

let runner0 = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
// every command this module sends is ONE command (main/rpc.js oneCommand, 0.18.177): a contract coin's state is the chain's,
// anyone can make one that names this wallet, and a ";" in it started a second command through runscript / txnstate
const runner = (cmd) => { try { return runner0(oneCommand(cmd)); } catch (e) { return Promise.reject(e); } };
function log(line) { const e = new Date().toISOString().slice(11, 19) + " " + String(line); LOG_RING.push(e); if (LOG_RING.length > 200) LOG_RING.shift(); console.log("[vestr]", String(line)); }

// ---- helpers ----
function stateVar(coin, port) { for (const s of (coin.state || [])) { if (s.port === port || s.port == port) return s.data; } return ""; }
function coinAmount(coin) { return String(coin.tokenid === "0x00" ? coin.amount : coin.tokenamount); }   // token-grain gotcha
// A contract coin's state is anyone's (any wallet can make a coin at the shared covenant naming this one), so nothing of it is
// used, shown as a figure or put into a command until it has the shape the covenant reads (0.18.209): the beneficiary is a
// whole 0x address, the amounts and blocks plain numbers, and every port a bare value (no space or quote to start a
// second parameter in txnstate). A coin that does not is left out and logged.
const NUM = /^-?\d{1,30}(\.\d{1,44})?$/;
function stateProblem(coin) {
  if (!/^0x[0-9A-Fa-f]{64}$/.test(stateVar(coin, 0))) return "the beneficiary is not a whole 0x address";
  if (!V.isAmount(String(stateVar(coin, 1)))) return "the locked amount is not a plain number above zero";
  for (const p of [2, 3, 4]) if (!NUM.test(String(stateVar(coin, p)))) return "state " + p + " is not a plain number";
  for (const p of [5, 6, 7, 8]) { const v = String(stateVar(coin, p)); if (v !== "" && !(V.isBareValue(v) && v.length <= 64)) return "state " + p + " is not a bare value"; }
  if (!V.isHexId(String(stateVar(coin, 199)))) return "the vest id is not hex";
  if (!V.isHexId(String(coin.coinid || "")) || !V.isTokenid(coin.tokenid) || !NUM.test(coinAmount(coin)) || !/^\d{1,20}$/.test(String(coin.created))) return "the coin itself is not readable";
  return "";
}
/** a - b on plain decimal strings, exactly (0.18.209: the collected figure was a double); "" when either cannot be read. */
function decSub(a, b) {
  const P = (x) => { const m = /^(\d+)(?:\.(\d+))?$/.exec(String(x)); return m ? [BigInt(m[1] + (m[2] || "")), (m[2] || "").length] : null; };
  const x = P(a), y = P(b); if (!x || !y) return "";
  const dp = Math.max(x[1], y[1]); let d = x[0] * 10n ** BigInt(dp - x[1]) - y[0] * 10n ** BigInt(dp - y[1]); if (d < 0n) d = 0n;
  const t = d.toString().padStart(dp + 1, "0"), i = t.slice(0, t.length - dp), f = dp ? t.slice(t.length - dp).replace(/0+$/, "") : "";
  return f ? i + "." + f : i;
}
/**
 * Blocks still to wait before the covenant's grace line lets a collect through (0.18.291; the age at the tip since 0.18.292,
 * as the phone's Contract.inGrace). The covenant refuses while `@COINAGE LT minblockwait`, skipped from the final block on (its
 * first branch pays the whole coin). The age is taken at the TIP: txncheck runs the script with @BLOCK = the tip, and so does the
 * node's own relay check of a txpow it just mined (Main MAIN_TXPOWMINED posts it through NIOMessage like any peer's; a
 * non-monotonic txn whose scripts fail at the tip is kept but never forwarded, and nothing re-broadcasts the mempool), so a collect
 * only the next block would accept never leaves this node. Only the block builder checks against tip + 1. CHECK_MATHS's own
 * mustwait is FALSE at age 0 (`(@BLOCK - @COINAGE) GT "0"`), so it decides nothing here; the list's Collect button reads this figure.
 */
function graceWait(coin, tp) {
  const created = Number(coin.created), minwait = Number(stateVar(coin, 4)), final = Number(stateVar(coin, 3));
  if (![created, minwait, final, tp].every(Number.isFinite)) return Infinity;
  return tp >= final ? 0 : Math.max(0, minwait - (tp - created));
}
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
  const wait = tp ? graceWait(coin, tp) : 0, mustwait = wait > 0;   // the figure collect() refuses by (0.18.291), not CHECK_MATHS's mustwait
  const collected = decSub(total, amount);
  const pct = num(total) > 0 ? Math.max(0, Math.min(100, Math.round((num(total) - num(amount)) / num(total) * 100 + (num(cancollect) / num(total)) * 100))) : 0;
  return {
    coinid: coin.coinid, tokenid: coin.tokenid, uid: stateVar(coin, 199),
    beneficiary: stateVar(coin, 0), total, amount, collected,
    startBlock, endBlock, graceHours: /^\d{1,6}$/.test(String(stateVar(coin, 7))) ? Number(stateVar(coin, 7)) : 0, graceLabel: graceLabel(stateVar(coin, 7)),
    startMs: parseInt(stateVar(coin, 6)) || 0, endMs: parseInt(stateVar(coin, 8)) || 0, createdMs: parseInt(stateVar(coin, 5)) || 0,
    cancollect, change: String(v.change != null ? v.change : "0"), mustwaitblocks: String(mustwait ? wait : 0),
    cliffed, expired, mustwait, canCollectNow: !!tp && !cliffed && !mustwait && V.isAmount(cancollect),
    pctVested: expired ? 100 : pct
  };
}
async function list() {
  await init();
  const tp = await tip();
  // checkmempool:true (0.18.291): a coin a collect is spending (being mined here, or in the mempool) is not listed
  const r = await runner("coins address:" + scriptAddress + " relevant:true checkmempool:true").catch(() => null);
  const coins = (r && Array.isArray(r.response)) ? r.response : [];
  const out = [];
  for (const c of coins) {
    if (!stateVar(c, 199)) continue;
    const bad = stateProblem(c); if (bad) { log("left out a contract coin " + String(c.coinid) + ": " + bad); continue; }
    try { out.push(await contractFromCoin(c, tp)); } catch (e) {}
  }
  return out.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
}

// ---- balances / tokens for the Create picker ----
async function tokens() {
  await init();
  const r = await runner("balance").catch(() => null);
  const rows = (r && Array.isArray(r.response)) ? r.response : [];
  return rows.map(b => ({ tokenid: b.tokenid, name: b.tokenid === "0x00" ? "MINIMA" : ((b.token && (b.token.name || b.token)) || String(b.tokenid)), sendable: String(b.sendable) }));
}
async function myAddress() { const r = await runner("getaddress").catch(() => null); return r && r.response && (r.response.miniaddress || r.response.address) || ""; }

// ---- create / lock (VERBATIM 1.8.1 send with the 10-port state map) ----
async function blockHeightForDate(whenMs, tp) { return tp + Math.round((Number(whenMs) - Date.now()) / 1000 / SECONDS_PER_BLOCK); }
async function create(opts) {
  await init();
  const { tokenid, amount, beneficiary, startMs, endMs, graceHours, burn, password } = opts || {};
  // Everything below is interpolated into a space-tokenised, LAST-WINS command, so a value carrying a space
  // and another `key:` rewrites the command around it — `tokenid` of "0x00 address:0xATTACKER" would append a
  // second address that wins over CONTRACT. main/webwallet.js states the rule ("NEVER interpolate unvalidated
  // free-text"); this module was the one that opted out of it.
  if (!V.isAmount(String(amount))) throw new Error("Enter a valid amount to lock");
  if (!beneficiary) throw new Error("Enter a beneficiary address");
  if (!V.isMinimaAddress(String(beneficiary))) throw new Error("Invalid beneficiary address");   // before it goes into checkaddress (0.18.209)
  // the release cadence is a plain count of hours (0.18.209: "1e3", "-24" and "2.5" were taken by Number())
  const gh = graceHours == null || graceHours === "" ? 0 : (V.isCount(graceHours) && Number(graceHours) <= 100000 ? Number(graceHours) : NaN);
  if (!Number.isSafeInteger(gh)) throw new Error("The release cadence must be a whole number of hours. Nothing was sent.");
  if (!V.isTokenid(tokenid)) throw new Error("Invalid token id");
  if (burn != null && burn !== "" && !V.isAmount(String(burn))) throw new Error("Invalid burn amount");
  if (password != null && password !== "" && String(password).includes(";")) throw new Error("The wallet password can't contain ; (the node would read what follows as a second command). Nothing was sent.");   // 0.18.188
  if (password != null && password !== "" && !V.isQuotableText(String(password))) throw new Error("The wallet password can't contain quotes, backslashes or line breaks");
  if (!(Number(endMs) > Number(startMs))) throw new Error("End must be after start");
  const chk = await runner("checkaddress address:" + String(beneficiary).trim()).catch(() => null);
  const addr0x = chk && chk.status === true && chk.response && chk.response["0x"];
  if (!addr0x || !/^0x[0-9A-Fa-f]{64}$/.test(addr0x)) throw new Error("Invalid beneficiary address");
  const tp = await tip();
  const startBlock = await blockHeightForDate(startMs, tp), endBlock = await blockHeightForDate(endMs, tp);
  const minblockwait = Math.floor(gh * 3600 / SECONDS_PER_BLOCK);
  const uid = "0x" + crypto.randomBytes(32).toString("hex").toUpperCase();
  const now = Date.now();
  const state = '{"0":"' + addr0x + '","1":"' + amount + '","2":"' + startBlock + '","3":"' + endBlock + '","4":"' + minblockwait + '","5":"' + now + '","6":"' + Number(startMs) + '","7":"' + gh + '","8":"' + Number(endMs) + '","199":"' + uid + '"}';
  let cmd = "send debug:false " + (password ? 'password:"' + password + '" ' : "") + "amount:" + amount + " address:" + CONTRACT + " tokenid:" + tokenid + " state:" + state;
  if (burn && Number(burn) > 0) cmd += " burn:" + burn;
  if (tokenid === "0x00") cmd = await pinMinimaSend(runner, cmd);   // MINIMA lock: dodge shared-node beacon-dust NPE
  let res; try { res = await runner(cmd); } catch (e) { res = undefined; }
  // no answer is not "failed" (0.18.209): the lock may have gone, and trying again would lock the amount a second time
  if (!res || typeof res !== "object") throw new Error("The lock may have been sent (the node did not answer). Check your vests and History before you try again, so you do not lock twice.");
  if (res.status === true || res.pending === true) { emitter.emit("update"); return { ok: true, uid }; }
  throw new Error((res.error || "the node refused the lock") + ". Nothing was sent.");
}

// ---- collect / claim (VERBATIM 1.8.1 order — amount from the NODE via runscript) ----
async function collect(coinid, burn) {
  await init();
  if (!V.isHexId(coinid)) throw new Error("Invalid coin id");
  if (burn != null && burn !== "" && !V.isAmount(String(burn))) throw new Error("Invalid burn amount");
  // checkmempool:true (0.18.291): a coin a collect already spends is not listed, so a second collect before the first is mined is not built.
  // The phone's rule (0.18.296, base-vestr-2.2.76 Contract.alreadySpending): only a clean, successful, empty answer refuses, and not before
  // the tip is known (a node without one lists nothing). A failed or malformed answer does not block: the coin is read without the flag, and
  // txninput and txncheck judge the collect. 0.18.291's list of coins collected in this session is gone: it refused a valid collect for the
  // rest of the session exactly when the collect had NOT gone through (an unanswered post: the coin still listed, not in the mempool).
  const cr = await runner("coins coinid:" + coinid + " checkmempool:true").catch(() => null);
  const clean = !!(cr && cr.status === true && Array.isArray(cr.response));
  let coin = clean && cr.response[0];
  if (clean && !coin) {
    if (!(await tip())) throw new Error("The node's block height could not be read, so nothing was built. Nothing was sent.");
    throw new Error("A collect of this coin is already waiting for the chain, or the coin is already spent. Nothing was sent.");
  }
  if (!coin) { const pr = await runner("coins coinid:" + coinid).catch(() => null); coin = pr && pr.status === true && Array.isArray(pr.response) && pr.response[0]; }
  if (!coin) throw new Error("Contract coin not found (already collected?)");
  // the order of refusals (0.18.291): the coin's shape, the tip, nothing available, then the grace wait
  const bad = stateProblem(coin); if (bad) throw new Error("This contract coin cannot be collected: " + bad + ".");
  const tp = await tip();
  if (!tp) throw new Error("The node's block height could not be read, so nothing was built. Nothing was sent.");
  const v = await runScriptVars(CHECK_MATHS,
    { 1: stateVar(coin, 1), 2: stateVar(coin, 2), 3: stateVar(coin, 3), 4: stateVar(coin, 4), 5: stateVar(coin, 5) },
    { "@AMOUNT": coinAmount(coin), "@BLOCK": tp, "@COINAGE": coin.created });
  // 0.18.288: CHECK_MATHS works out its `change` BEFORE an expired contract's cancollect is raised to @AMOUNT, so at and just
  // after the final block it said "collect 100, change 1" for a 100 coin: outputs above the input, a transaction txnpost takes
  // and the chain drops while the app said collected. The payout is the node's cancollect; the change is the coin less the
  // payout, exactly, as the covenant computes it (none once the whole coin is paid out). Within the grace wait the covenant
  // refuses (@COINAGE LT minblockwait), so nothing is built (graceWait: the age at the tip, as txncheck and the node's relay check count it).
  const amount = coinAmount(coin), cancollect = String(v.cancollect != null ? v.cancollect : "0");
  if (!V.isAmount(cancollect)) throw new Error("Nothing available to collect yet");   // the node's figure, a plain number above 0
  if (graceWait(coin, tp) > 0) throw new Error("The grace period of this contract is still running, so nothing can be collected yet. Nothing was sent.");
  if (decSub(cancollect, amount) !== "0") throw new Error("The node's figure to collect is more than this contract coin holds. Nothing was sent.");
  const change = decSub(amount, cancollect);   // payout + change = the coin, exactly
  const withdrawalAddress = stateVar(coin, 0), tokenid = coin.tokenid;
  const id = "vc" + Math.floor(Math.random() * 1e9);
  const cmds = [];
  cmds.push("txncreate id:" + id);
  cmds.push("txninput id:" + id + " coinid:" + coinid + " scriptmmr:true");
  cmds.push("txnoutput id:" + id + " address:" + withdrawalAddress + " amount:" + cancollect + " tokenid:" + tokenid + " storestate:false");
  if (change !== "0") cmds.push("txnoutput id:" + id + " address:" + CONTRACT + " amount:" + change + " tokenid:" + tokenid + " storestate:true");
  for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 199]) cmds.push("txnstate id:" + id + " port:" + p + " value:" + stateVar(coin, p));
  cmds.push("txncheck id:" + id);   // the node judges the built transaction before anything is posted (0.18.291)
  cmds.push("txnpost id:" + id + (burn && Number(burn) > 0 ? " burn:" + burn : ""));
  // txncheck's response.validtransaction = checkTxPoWBasic (inputs, amounts add up) AND the MMR proofs AND every script, run with @BLOCK =
  // the tip (TxPoWChecker.checkTxPoWScripts(tip.getMMR(), txpow, tip.getTxPoW())): posted only when it is the boolean true (0.18.292, as
  // the phone's Contract.txnCheckValid); the grace wait above is counted at the tip too, so the two agree.
  const judged = (r) => !!(r.response && r.response.validtransaction === true);
  try {
    // every step must say status true (0.18.209: an empty or unreadable reply counted as success); the post is the one
    // step that cannot be called failed when there is no answer, because the transaction may have gone
    for (const c of cmds) {
      const post = c.startsWith("txnpost");
      let r; try { r = await runner(c); } catch (e) { r = undefined; }
      if (post && (!r || typeof r !== "object")) { throw new Error("The collect may have been posted (the node did not answer). Check your History and wait for the list to refresh before you collect again."); }
      // status true only (0.18.291): a pending reply (waiting for someone's approval) is not a collect
      if (!r || r.status !== true) throw new Error("collect step failed: " + ((r && r.error) || c.split(" ")[0]) + ". Nothing was collected.");
      if (c.startsWith("txncheck") && !judged(r)) throw new Error("The node checked this collect and judged it invalid, so it was not sent. Nothing was collected.");
    }
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
  _setRunner: (fn) => { runner0 = fn; }, CONTRACT, CLEAN_SCRIPT
};
