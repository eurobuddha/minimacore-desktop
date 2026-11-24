/*
 * casino-settle.js: P2P Chance (Zero Edge Casino) SETTLE-ONLY mode (0.18.330). Written fresh; the removed engine
 * (0.18.318, last in 61df01e56d291dd623da4125b29e48ceecaeb84a) is NOT restored. No betting, no new offers, no takes: it only
 * closes what a wallet of this app still has on chain at the casino covenant, so that removing the casino does not cost it a pot.
 *
 * What it does, and only for coins the NODE says are this wallet's (`keys`, `scripts`; never the coin's own word):
 *   (a) CANCEL   phase 0, state 0 is one of this wallet's keys: the coin back to this wallet's own address   (a button)
 *   (b) REVEAL   phase 1, this wallet is the house and holds the secret of state 2                            (automatic)
 *   (c) RESOLVE  phase 2, this wallet is the player, holds the secret of state 10 and WON                     (automatic)
 *   (d) CLAIM    after the timeout: phase 1 as the player, phase 2 as the house                               (automatic)
 *
 * The rules that make it safe (each one has a test in scripts/casino-settle-test.cjs):
 *  - A coin's state is a stranger's text (anyone can send a coin with any state to the covenant, and a taker writes ports
 *    8-11 freely), and the node runs what follows a ";" as another command. Every value is checked to an exact shape BEFORE it
 *    is used; a command is built from checked values only, is ONE command, passes main/cmdverb.js refuse, and must match one of
 *    the shapes in SHAPES or it is not sent. A coin with any other value is left alone and listed with its whole coin id.
 *  - THE OPEN-OFFER RULE (0.18.337; the rule of 0.18.330 let one forged coin stop a real reveal for ever, and made the block
 *    pass cancel an offer without a click). A reveal puts the house secret on chain, and an offer that is still open with
 *    the same secret could then be taken with a pick that wins. So a reveal WAITS while this wallet has an open offer with the
 *    same commit, but only an offer that could really be taken and that is worth protecting, and only for a bounded time:
 *      what holds a reveal: a phase-0 coin whose states 0-7 are all there and readable (a missing one makes the contract throw
 *        on a take as on any spend: such a coin can never be taken, so it protects nothing), state 0 a key the NODE says is this
 *        wallet's, the same commit, the SAME token as the bet and MINIMA or MxUSD (another token's own script may refuse every
 *        spend), an amount that is exactly the stake its own terms give (bet x (payout - 1), what this app wrote), and at least
 *        this wallet's stake in the bet (a smaller one: not revealing would lose more than that offer holds). Nothing else.
 *      for how long: until the bet is HOLD_AGE blocks old; or, when the offer has the bet's own terms (states 0-5 and 7 equal:
 *        the timeout is then this wallet's own, not a stranger's), until REVEAL_ANYWAY_LEFT blocks are left. Then the bet is
 *        revealed although the offer is still there.
 *      why it is revealed anyway: not revealing loses this wallet's stake in the bet FOR CERTAIN at the timeout. Revealing
 *        exposes the open offer, which is lost only if someone takes it before it is cancelled, and which a hostile taker can
 *        win in any case, secret or no secret (the contract's take does not require states 9 and 10; a take without one can
 *        never be revealed and is claimed at the timeout). The certain loss decides.
 *      the block pass NEVER cancels: an open offer is cancelled by the user's click only. The bet that waits is listed as not
 *        settled automatically, with the offer's coin id and "cancel that offer now".
 *    A bet in which this wallet has no stake (the pot is the bet: payout 1) is never revealed automatically. A taken offer of
 *    this app always holds bet x payout (stake plus the taker's bet, forced by the covenant): any other amount is a forgery and
 *    is not revealed automatically. The scan is the confirmed chain, never the mempool.
 *  - Outcome and payout are the covenant's own: SHA3(house secret ++ player secret), its first 4 bytes as a number, modulo
 *    the range, equal to the pick; winnings bet x payout, the rest to the house. Exact decimal arithmetic (BigInt), no rounding.
 *  - Every transaction's error path runs txndelete (family rule), and so does its success path. A posted transaction is
 *    written to <userData>/casino-settle.json before the post, so it is not built again each block.
 *  - NOTHING IS SIGNED THAT THE CONTRACT WOULD REFUSE (0.18.336). Anyone can write any coin at the contract, with this wallet's
 *    public key in it. The contract reads states 0-7 before anything else (and 8 and 11 for a taken bet), and a missing or
 *    unreadable one makes it throw on every spend; its "AND" evaluates both sides, so state 0 (and state 8 of a taken bet) must
 *    be hex or its signature check throws; a claim signed with a key that is also the other side's takes the other branch and
 *    fails. Each of these is checked before a transaction is built. The node's txnpost answers before mining and does not
 *    judge the contract: a transaction it would refuse is dropped later, silently, and the signature is spent.
 *  - AUTOMATIC SIGNING IS BOUNDED (0.18.336): MINIMA and MxUSD only; at most AUTO_TRIES signatures per coin, ever (kept in
 *    casino-settle.json; after that the coin is listed and only the button sends again); at most AUTO_PER_PASS per block pass
 *    and AUTO_PER_DAY in any 24 hours, of which timeout claims may use CLAIMS_PER_DAY. One scan per pass. Work is ordered, never
 *    taken in scan order (the node lists newest first, so a stranger's new coins would always come first): reveals and payouts
 *    before claims, alternately the nearest deadline and the largest amount; claims by amount.
 *  - A POST IS "SENT", NOT "DONE". The record of a sent transaction goes to "done" only when a scan that lists coins at the
 *    contract no longer lists that coin. An empty answer (a node that is still syncing answers []) or a failed read changes
 *    nothing: no record and no count is dropped.
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { rpcCall, neverSent } = require("./rpc");
const CV = require("./cmdverb");
const V = require("./validate");
const { sha3_256 } = require("./sha3");

const emitter = new EventEmitter();
const SOURCE = "P2P Chance settle";
const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
const MXUSD_TOKENID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";   // the Minima dollar token is MxUSD
// The covenant, verbatim: it must compile to CONTRACT (txnbasics attaches its script proof from the node's script row).
const SCRIPT = 'LET hpk=PREVSTATE(0) LET ha=PREVSTATE(1) LET hc=PREVSTATE(2) LET rng=PREVSTATE(3) LET po=PREVSTATE(4) LET bt=PREVSTATE(5) LET ph=PREVSTATE(6) LET to=PREVSTATE(7) IF ph EQ 0 AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF IF ph EQ 0 THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 1 ASSERT STATE(7) EQ to ASSERT STATE(11) GTE 0 AND STATE(11) LT rng ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+bt @TOKENID TRUE) RETURN TRUE ENDIF LET qk=PREVSTATE(8) LET pk=PREVSTATE(11) IF ph EQ 1 AND SIGNEDBY(hpk) THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 2 ASSERT SAMESTATE(7 11) LET hs=STATE(12) ASSERT SHA3(hs) EQ hc ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) RETURN TRUE ENDIF IF ph EQ 1 AND @COINAGE GT to AND SIGNEDBY(qk) THEN RETURN TRUE ENDIF IF ph EQ 2 AND SIGNEDBY(qk) THEN LET ps=STATE(13) ASSERT SHA3(ps) EQ PREVSTATE(10) LET hs=PREVSTATE(12) LET h=SHA3(CONCAT(hs ps)) LET r=NUMBER(SUBSET(0 4 h))%rng IF r EQ pk THEN LET w=bt*po ASSERT VERIFYOUT(@INPUT PREVSTATE(9) w @TOKENID FALSE) IF @AMOUNT GT w THEN ASSERT VERIFYOUT(@INPUT+1 ha @AMOUNT-w @TOKENID FALSE) ENDIF ELSE ASSERT VERIFYOUT(@INPUT ha @AMOUNT @TOKENID FALSE) ENDIF RETURN TRUE ENDIF IF ph EQ 2 AND @COINAGE GT to AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF RETURN FALSE';
const NEWSCRIPT = 'newscript script:"' + SCRIPT + '" trackall:false';
const SCAN = "coins address:" + CONTRACT + " depth:4096";   // the confirmed chain; depth above every tree length, as the removed engine
const REPOST_AFTER = 10;      // blocks a posted transaction is given before it may be built again
const SCAN_EVERY_MS = 12000;
const AUTO_TRIES = 3;         // automatic signatures for ONE coin, ever: after that only the button
const AUTO_PER_PASS = 4;      // automatic signatures in one block pass
const AUTO_PER_DAY = 24;      // automatic signatures in any 24 hours
const CLAIMS_PER_DAY = 12;    // of those, timeout claims stop here: the rest is kept for reveals and payouts, which have a deadline
const DAY_MS = 86400000;
const MANUAL_SWEEP = 50;      // "Cancel all": offers cancelled by one click
const HOLD_AGE = 1200;            // a bet whose reveal waits for an open offer to be cancelled is revealed anyway at this age
const REVEAL_ANYWAY_LEFT = 300;   // … or, when the offer has the bet's own terms, when this many blocks are left

// ---- the shapes: the ONLY values that reach a command ----
const HEX64 = /^0x[0-9A-Fa-f]{64}$/;                    // a key, an address or a commit this wallet relies on; a secret; a coin id
const HEXV = /^0x(?:[0-9A-Fa-f]{2}){1,64}$/;            // hex the other side wrote, copied or hashed as it is
const ADDR = /^0x(?:[0-9A-Fa-f]{2}){1,32}$/;            // an address the covenant makes an output pay
const DEC = /^\d{1,30}(?:\.\d{1,44})?$/;                // a plain decimal
const INT = /^[1-9]\d{0,9}$/;                           // a positive whole number (range, payout)
const BLOCKN = /^\d{1,12}$/;
const copyable = (v) => typeof v === "string" && (HEXV.test(v) || DEC.test(v));
/** The same value as the contract compares it: hex without regard to case, a number by its value. */
const sameValue = (a, b) => typeof a === "string" && typeof b === "string" && ((HEXV.test(a) && HEXV.test(b) && a.toUpperCase() === b.toUpperCase()) || (DEC.test(a) && DEC.test(b) && decCmp(a, b) === 0));
const TXID = "cs_[a-z]{5,7}_\\d{1,16}_\\d{1,6}";
const HEXS = "0x[0-9A-Fa-f]{64}", DECS = "\\d{1,30}(?:\\.\\d{1,44})?";
const SHAPES = [
  /^block$/, /^keys$/, /^scripts$/, /^getaddress$/,
  new RegExp("^keys publickey:" + HEXS + "$"),
  new RegExp("^scripts address:" + CONTRACT + "$"),
  new RegExp("^txn(?:create|basics|post|delete) id:" + TXID + "$"),
  new RegExp("^txninput id:" + TXID + " coinid:" + HEXS + "$"),
  new RegExp("^txnoutput id:" + TXID + " amount:" + DECS + " address:0x(?:[0-9A-Fa-f]{2}){1,32} tokenid:(?:0x00|" + HEXS + ") storestate:(?:true|false)$"),
  new RegExp("^txnstate id:" + TXID + " port:(?:[0-9]|1[0-3]) value:(?:0x(?:[0-9A-Fa-f]{2}){1,64}|" + DECS + ")$"),
  new RegExp("^txnsign id:" + TXID + " publickey:" + HEXS + "$")
];

let runner0 = (cmd) => { const config = require("./config"), node = require("./node-manager"); return rpcCall(node.rpcPort(), config.rpcSecret(), cmd); };
/** ONE command, of a known shape, or nothing is sent. */
function run(cmd) {
  const c = String(cmd);
  const why = CV.refuse(SOURCE, c) || ((c === SCAN || c === NEWSCRIPT || SHAPES.some(re => re.test(c))) ? "" : "This is not a command the P2P Chance settle mode sends. Nothing was sent.");
  if (why) { const e = new Error(why); e.notSent = true; return Promise.reject(e); }
  return runner0(c);
}
function log(line) { console.log("[chance-settle]", String(line)); }

// ---- exact decimals (plain strings in, plain strings out; never a double) ----
function dec(s) { const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s)); return [BigInt(m[1] + (m[2] || "")), (m[2] || "").length]; }
function fmt(n, dp) { const t = n.toString().padStart(dp + 1, "0"), i = t.slice(0, t.length - dp), f = dp ? t.slice(t.length - dp).replace(/0+$/, "") : ""; return f ? i + "." + f : i; }
function aligned(a, b) { const x = dec(a), y = dec(b), dp = Math.max(x[1], y[1]); return [x[0] * 10n ** BigInt(dp - x[1]), y[0] * 10n ** BigInt(dp - y[1]), dp]; }
function decCmp(a, b) { const [x, y] = aligned(a, b); return x < y ? -1 : x > y ? 1 : 0; }
function decSub(a, b) { const [x, y, dp] = aligned(a, b); return fmt(x - y, dp); }
function decMulInt(a, k) { const x = dec(a); return fmt(x[0] * BigInt(k), x[1]); }

// ---- secrets: the removed app's own keychain entries, read only ----
let readSecret = (name) => { try { return require("./config").getSecret("casino-" + crypto.createHash("sha256").update(String(name)).digest("hex")); } catch (e) { return null; } };
const secretCache = new Map();   // found: kept; not found: asked again after 10 minutes (each keychain read starts a process)
function lookup(name) {
  const hit = secretCache.get(name);
  if (hit && (hit.v || Date.now() - hit.at < 600000)) return hit.v;
  let v = null; try { v = readSecret(name) || null; } catch (e) { v = null; }
  secretCache.set(name, { v, at: Date.now() });
  return v;
}
const sha3hex = (hex) => sha3_256(Buffer.from(hex.slice(2), "hex")).toString("hex").toUpperCase();
/** The secret this computer holds for a commit, proven: 0x + 64 hex whose SHA3 IS the commit. "" = none held, null = held but wrong. */
function secretFor(prefix, commit) {
  const h = commit.slice(2);
  for (const c of new Set([commit, "0x" + h.toUpperCase(), "0x" + h.toLowerCase()])) {
    const s = lookup(prefix + c);
    if (s) return (HEX64.test(s) && sha3hex(s) === h.toUpperCase()) ? s : null;
  }
  return "";
}

// ---- what was posted (so it is not built again each block) ----
let app = null; try { app = require("electron").app; } catch (e) {}
const storeFile = () => path.join(app.getPath("userData"), "casino-settle.json");
let store = {
  load() { try { return JSON.parse(fs.readFileSync(storeFile(), "utf8")); } catch (e) { return {}; } },
  save(o) { const f = storeFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o, null, 2)); fs.renameSync(f + ".tmp", f); }
};
let now = () => Date.now();
const ACTIONS = ["cancel", "reveal", "resolve", "claim"];
/**
 * { posted: { coinid: { action, block, at, txpowid, tries, sent, done } }, sigs: [ms] }. tries = signatures made for the coin
 * (never reset); sent = the last one was posted (false: the node refused the post); done = the block of the scan that no longer
 * listed the coin (0: still there, or not known). sigs = the times of the AUTOMATIC signatures of the last 24 hours.
 * A record of 0.18.330 (no tries, no sent) is one sent transaction.
 */
function loadStore() {
  let o; try { o = store.load(); } catch (e) { o = null; }
  const p = (o && o.posted && typeof o.posted === "object") ? o.posted : {}, out = { posted: {}, sigs: [] };
  for (const [id, r] of Object.entries(p)) {
    if (!HEX64.test(id) || !r || typeof r !== "object" || !Number.isSafeInteger(r.block)) continue;
    out.posted[id] = { action: ACTIONS.includes(r.action) ? r.action : "", block: r.block, at: Number(r.at) || 0, txpowid: V.isHexId(r.txpowid) ? r.txpowid : "",
      tries: Number.isSafeInteger(r.tries) && r.tries >= 0 ? r.tries : 1, sent: r.sent !== false, done: Number.isSafeInteger(r.done) && r.done > 0 ? r.done : 0 };
  }
  const t = now(); if (o && Array.isArray(o.sigs)) out.sigs = o.sigs.filter(x => Number.isFinite(x) && x <= t && t - x < DAY_MS);
  return out;
}
function saveStore(s) {
  // done records are history: the oldest go once there are many (a record is made only by a signature of this wallet)
  const ids = Object.keys(s.posted); if (ids.length > 400) for (const id of ids.filter(i => s.posted[i].done).sort((a, b) => s.posted[a].at - s.posted[b].at).slice(0, ids.length - 400)) delete s.posted[id];
  try { store.save(s); return true; } catch (e) { log("could not save casino-settle.json: " + (e && e.message)); return false; }
}
const sigsToday = () => loadStore().sigs.length;
/** A signature is about to be made for this coin: counted BEFORE it is asked for (a crash must not lose the count). Not saved: not signed. */
function countSignature(coinid, action, tip, auto) {
  const s = loadStore(), r = s.posted[coinid] || { tries: 0 };
  s.posted[coinid] = { action, block: tip, at: now(), txpowid: "", tries: r.tries + 1, sent: false, done: 0 };
  if (auto) s.sigs.push(now());
  if (!saveStore(s)) throw new Error("casino-settle.json could not be written, so the signature could not be counted. Nothing was signed.");
}
/** The node said it did not sign (or the command never reached it): the count is taken back. */
function uncountSignature(coinid, before, auto) {
  const s = loadStore(); if (before) s.posted[coinid] = before; else delete s.posted[coinid];
  if (auto) s.sigs.pop();
  saveStore(s);
}
function setSent(coinid, sent, txpowid) { const s = loadStore(), r = s.posted[coinid]; if (!r) return; r.sent = sent; r.txpowid = txpowid || ""; r.at = now(); saveStore(s); }

// ---- reading the node ----
const up = (s) => String(s).toUpperCase();
let known = new Set();   // every key the node has listed this session: one short `keys` answer does not make a coin a stranger's
let strangers = new Set();   // keys the node said, asked one by one, are NOT this wallet's
async function ask(cmd, what) {
  let r; try { r = await run(cmd); } catch (e) { throw new Error("The node did not answer (" + what + "): " + ((e && e.message) || e) + ". Nothing was done."); }
  if (!r || r.status !== true) throw new Error("The node could not be read (" + what + "). Nothing was done.");
  return r.response;
}
/** One read of everything a decision needs. Any part that cannot be read: an error, and nothing is done. */
async function scan() {
  const b = await ask("block", "block"), tipS = String(b && b.block);
  if (!BLOCKN.test(tipS)) throw new Error("The node's block height could not be read. Nothing was done.");
  const k = await ask("keys", "keys"), list = (k && Array.isArray(k.keys)) ? k.keys : Array.isArray(k) ? k : null;
  if (!list) throw new Error("The node's keys could not be read. Nothing was done.");
  for (const row of list) { const pk = row && typeof row === "object" ? row.publickey : row; if (typeof pk === "string" && HEX64.test(pk)) known.add(up(pk)); }
  if (!known.size) throw new Error("The node listed no keys. Nothing was done.");
  const s = await ask("scripts", "scripts"); if (!Array.isArray(s)) throw new Error("The node's addresses could not be read. Nothing was done.");
  const addrs = new Set(); for (const row of s) if (row && row.simple === true && typeof row.address === "string" && HEX64.test(row.address)) addrs.add(up(row.address));
  const coins = await ask(SCAN, "the coins at the P2P Chance contract"); if (!Array.isArray(coins)) throw new Error("The coins at the P2P Chance contract could not be read. Nothing was done.");
  // SENT → DONE only on evidence: a scan that lists coins at the contract and not this one. An empty answer is what a node that
  // is still syncing gives: it changes nothing. A coin that is listed again (a re-organised chain) is not done any more.
  const S0 = loadStore(), tip = Number(tipS), seen = new Set(coins.map(c => up(c && c.coinid))), spent = []; let changed = false;
  for (const [id, r] of Object.entries(S0.posted)) {
    const here = seen.has(up(id));
    if (here && r.done) { r.done = 0; changed = true; }
    else if (!here && !r.done && r.sent && coins.length) { r.done = tip; changed = true; spent.push([id, r]); }
  }
  if (changed) saveStore(S0);
  for (const [id, r] of spent) { const m = "Coin " + id + " is now spent (seen at block " + tip + "), after this app sent " + (WORDS[r.action] || "a transaction") + " for it at block " + r.block + "."; log(m); emitter.emit("notify", m); }
  return { tip, keys: known, addrs, coins: coins.filter(c => c && typeof c === "object"), posted: S0.posted };
}
/** Is this key the node's, asked for this one key (no list to be short)? An unreadable answer throws: never a guess. */
async function isKey(pk) {
  if (known.has(up(pk))) return true;
  if (strangers.has(up(pk))) return false;   // asked for by itself once already: a stranger's coins must not cost a question each, each pass
  const r = await ask("keys publickey:" + pk, "one key");
  const hit = !!(r && Array.isArray(r.keys) && r.keys.some(row => row && up(row.publickey) === up(pk)));
  if (hit) known.add(up(pk)); else if (r && Array.isArray(r.keys) && strangers.size < 5000) strangers.add(up(pk));
  return hit;
}

// ---- reading a coin ----
/** port → data, or null when the state is not a list of single ports with text values. */
function stateOf(coin) {
  if (!Array.isArray(coin.state)) return null;
  const m = new Map();
  for (const s of coin.state) {
    const p = s && typeof s === "object" ? String(s.port) : "";
    if (!/^\d{1,3}$/.test(p) || typeof s.data !== "string" || m.has(p)) return null;
    m.set(p, s.data);
  }
  return { get: (port) => m.get(String(port)) };
}
/** 0, 1 or 2 as the covenant compares it (a number equal to it), else null. */
function phaseOf(st) { const v = st && st.get(6); if (typeof v !== "string" || !DEC.test(v)) return null; for (const p of [0, 1, 2]) if (decCmp(v, String(p)) === 0) return p; return null; }
const tokenLabel = (t) => t === "0x00" ? "MINIMA" : up(t) === up(MXUSD_TOKENID) ? "MxUSD" : t;

/** A sent transaction is given REPOST_AFTER blocks before another is built for its coin. A refused post (sent false) holds nothing. */
const holds = (p, tip) => !!(p && p.sent && !p.done && tip - p.block < REPOST_AFTER);
/**
 * What this wallet may do with ONE coin at the contract. → null (not this wallet's: nothing is done, nothing is listed), or a row
 * { coinid, phase, role, amount, tokenid, token, age, blocksLeft, leftFor, action, auto, note, problem, manualOk, held, plan }.
 * `manual` is the user's own click: it lifts only the checks that guard against paying for nothing (the pot is bet x payout; this
 * wallet has a stake; the winnings address is this wallet's; the token; the count of signatures), never a shape check, the secret
 * or the open-offer rule.
 */
async function judge(coin, ctx, manual) {
  const st = stateOf(coin); if (!st) return null;
  const k0 = st.get(0), k8 = st.get(8);
  const house = typeof k0 === "string" && HEX64.test(k0) && ctx.keys.has(up(k0));
  const player = typeof k8 === "string" && HEX64.test(k8) && ctx.keys.has(up(k8));
  if (!house && !player) return null;
  const row = { coinid: String(coin.coinid), phase: null, role: house && player ? "House and player" : house ? "House" : "Player", amount: "", tokenid: "", token: "", age: null,
    blocksLeft: null, leftFor: "", action: null, auto: false, note: "", problem: "", manualOk: false, held: false, plan: null };
  const bad = (why, manualOk) => { row.problem = why; row.manualOk = !!manualOk; row.action = null; row.plan = null; return row; };
  if (!HEX64.test(row.coinid)) return bad("its coin id is not 0x and 64 hex digits");
  const tokenid = coin.tokenid, amount = tokenid === "0x00" ? coin.amount : coin.tokenamount;   // a token coin's value is its tokenamount
  // the amount as the node's own text: a JSON number has been through a double, and is not the amount on chain
  if (!V.isTokenid(tokenid) || typeof amount !== "string" || !V.isAmount(amount) || !BLOCKN.test(String(coin.created))) return bad("its token, amount or creation block cannot be read");
  Object.assign(row, { amount, tokenid, token: tokenLabel(tokenid), age: ctx.tip - Number(coin.created) });
  if (row.age < 0) return bad("it is newer than the node's tip");
  const phase = phaseOf(st); if (phase === null) return bad("state 6 (the phase) is not 0, 1 or 2");
  row.phase = phase;
  const p = ctx.posted[row.coinid]; if (holds(p, ctx.tip)) { row.held = true; row.note = "A transaction for this coin was sent at block " + p.block + (p.txpowid ? " (id before mining " + p.txpowid + ")" : "") + ". It is not confirmed: waiting for the chain."; }
  row.tries = p ? p.tries : 0;
  const base = { coinid: row.coinid, amount, tokenid };
  // What the contract reads before it looks at who signed: a missing or unreadable state there and it throws on EVERY spend.
  const unread = (ports) => { const n = ports.find(x => !copyable(st.get(x))); return n === undefined ? "" : "state " + n + " is missing or is not 0x hex or a plain number: the contract cannot read it and refuses every spend of this coin, so nothing is signed for it"; };
  const notHex = (n) => "state " + n + " is not 0x hex: the contract's signature check throws on it and refuses every spend of this coin, so nothing is signed for it";
  // The automatic pass only (never the user's own click): MINIMA and MxUSD, and a coin it has not already signed for AUTO_TRIES times.
  const autoOnly = () => {
    if (manual || !row.plan || !row.auto) return row;
    if (!(tokenid === "0x00" || up(tokenid) === up(MXUSD_TOKENID))) return bad("its token is not MINIMA or MxUSD: nothing is signed for it automatically", true);
    if (p && p.tries >= AUTO_TRIES) return bad("this app signed " + p.tries + " transactions for it (the last at block " + p.block + ") and it is still at the contract: it is not signed for automatically any more", true);
    return row;
  };

  if (phase === 0) {
    if (!house) return bad("it is an open offer, and state 0 is not a key of this wallet");
    { const why = unread([0, 1, 2, 3, 4, 5, 6, 7]); if (why) return bad(why); }
    row.action = "cancel"; row.plan = Object.assign({ kind: "cancel", key: k0 }, base);
    if (!row.held) row.note = "Open offer: anyone can take it at any time, in another P2P Chance app. Cancel it to take your stake back.";
    return row;
  }
  const to = st.get(7); if (typeof to !== "string" || !DEC.test(to)) return bad("state 7 (the timeout) is not a plain number");
  const expired = BigInt(row.age) > BigInt(to.split(".")[0]);   // the covenant's @COINAGE GT timeout, at the tip
  const left = expired ? 0 : Number(BigInt(to.split(".")[0]) - BigInt(row.age)) + 1;
  { const why = unread([0, 1, 2, 3, 4, 5, 6, 7, 8, 11]); if (why) return bad(why); }
  for (const n of [0, 8]) if (!HEXV.test(st.get(n))) return bad(notHex(n));
  const claim = (key) => {
    if (up(k0) === up(k8)) return bad("states 0 and 8 hold the same key: the contract takes its signature as the other side's move, which fails, so the timeout claim cannot be made");
    row.action = "claim"; row.auto = true; row.plan = Object.assign({ kind: "claim", key }, base); if (!row.held) row.note = "The other side let the timeout pass: this wallet can take the whole pot.";
    return autoOnly();
  };

  if (phase === 1) {
    row.blocksLeft = left;
    if (player && expired) return claim(k8);
    if (!house) { row.leftFor = "until this wallet can claim the pot"; if (!row.held) row.note = "Waiting for the house to reveal."; return row; }
    row.leftFor = "before the player can take the whole pot";
    const commit = st.get(2); if (typeof commit !== "string" || !HEX64.test(commit)) return bad("state 2 (the house commit) is not 0x and 64 hex digits");
    for (const port of [1, 3, 4, 5, 7, 8, 9, 10, 11]) if (!copyable(st.get(port))) return bad("state " + port + " is not 0x hex or a plain number, so it cannot be copied into the reveal");
    const secret = secretFor("casino_secret_for_", commit);
    if (secret === "") return bad("the secret of this offer is not on this computer, so it cannot be revealed here");
    if (secret === null) return bad("the secret saved for this offer does not match its commit");
    // a taken offer of this app holds exactly bet x payout: anything else is a forgery (a dust coin must not cost a key use, or cancel an offer)
    const whole = INT.test(st.get(3)) && INT.test(st.get(4)) && V.isAmount(st.get(5)) && decCmp(amount, decMulInt(st.get(5), st.get(4))) === 0;
    if (!whole && !manual) return bad("the pot is not bet x payout, which a taken offer of this app always is: it is not revealed automatically", true);
    // THE OPEN-OFFER RULE (the header says why): an open offer of this wallet with the same commit, one that could really be taken
    // and holds at least this wallet's stake in the bet, makes the reveal WAIT, for a bounded time. The pass never cancels it.
    const bet = st.get(5), stake = whole && decCmp(amount, bet) > 0 ? decSub(amount, bet) : "0";
    let open = null;
    for (const o of ctx.coins) {
      if (o === coin) continue;
      const os = stateOf(o); if (!os || phaseOf(os) !== 0 || !sameValue(os.get(2), commit)) continue;
      if ([0, 1, 2, 3, 4, 5, 6, 7].some(n => !copyable(os.get(n))) || !HEX64.test(os.get(0)) || !HEX64.test(String(o.coinid))) continue;   // the contract would throw on a take: not an offer
      if (o.tokenid !== tokenid || !(tokenid === "0x00" || up(tokenid) === up(MXUSD_TOKENID))) continue;
      const oa = tokenid === "0x00" ? o.amount : o.tokenamount;
      if (typeof oa !== "string" || !V.isAmount(oa) || !INT.test(os.get(3)) || !INT.test(os.get(4)) || !V.isAmount(os.get(5)) || decCmp(oa, decMulInt(os.get(5), BigInt(os.get(4)) - 1n)) !== 0) continue;   // not a stake this app wrote
      if (decCmp(oa, stake) < 0) continue;   // it holds less than this wallet's stake in the bet: the bet comes first
      let mine; try { mine = await isKey(os.get(0)); } catch (e) { return bad("an open offer with the same secret is at the contract (coin " + o.coinid + ") and the node could not say whether its key is this wallet's: the secret is not shown"); }
      if (!mine) continue;   // not this wallet's key: not its offer
      const twin = [0, 1, 2, 3, 4, 5, 7].every(n => sameValue(os.get(n), st.get(n)));
      if (!open || (twin && !open.twin)) open = { coinid: o.coinid, amount: oa, twin };
    }
    if (open) {
      const anyway = whole && stake !== "0" && (row.age >= HOLD_AGE || (open.twin && left <= REVEAL_ANYWAY_LEFT));
      if (!anyway) return bad("an open offer of this wallet with the same secret is still at the contract (coin " + open.coinid + ", " + open.amount + " " + row.token + "). Revealing this bet shows that offer's secret to whoever takes it, so this bet waits. Cancel that offer now"
        + (whole && stake !== "0" ? ". This bet is revealed anyway when it is " + HOLD_AGE + " blocks old (it is " + row.age + ")" + (open.twin ? " or " + REVEAL_ANYWAY_LEFT + " blocks are left (" + left + " are)" : "") + ", because not revealing loses its pot for certain" : ". This bet is not revealed while that offer is there"));
      row.warn = "An open offer of this wallet with the same secret was not cancelled (coin " + open.coinid + "). This bet is revealed anyway: not revealing loses its pot for certain. Revealing shows that offer's secret: cancel that offer now.";
    }
    if (stake === "0" && !manual) return bad("this wallet has no stake in it (the pot is the player's own bet): it is not revealed automatically", true);
    row.action = "reveal"; row.auto = true;
    row.plan = Object.assign({ kind: "reveal", key: k0, secret, states: [0, 1, 2, 3, 4, 5].map(n => [n, st.get(n)]).concat([[6, "2"]], [7, 8, 9, 10, 11].map(n => [n, st.get(n)])) }, base);
    if (!row.held) row.note = row.warn || "Taken: the house secret is to be revealed so the bet can be settled.";
    return autoOnly();
  }

  // phase 2
  if (player) {
    row.blocksLeft = left; row.leftFor = "before the house can take the whole pot";
    const r = (() => {
      const commit = st.get(10); if (typeof commit !== "string" || !HEX64.test(commit)) return "state 10 (the player commit) is not 0x and 64 hex digits";
      const hs = st.get(12), rng = st.get(3), po = st.get(4), bt = st.get(5), pick = st.get(11);
      if (typeof hs !== "string" || !HEXV.test(hs)) return "state 12 (the house secret) is not 0x hex";
      if (!INT.test(rng) || !INT.test(po) || !V.isAmount(bt) || typeof pick !== "string" || !DEC.test(pick)) return "the range, payout, bet or pick is not a plain number";
      const ps = secretFor("casino_psecret_for_", commit);
      if (ps === "") return "the secret of this bet is not on this computer, so it cannot be settled here";
      if (ps === null) return "the secret saved for this bet does not match its commit";
      // the covenant: h = SHA3(CONCAT(hs ps)); r = NUMBER(SUBSET(0 4 h)) % rng; r EQ pick
      const result = sha3_256(Buffer.from(hs.slice(2) + ps.slice(2), "hex")).readUInt32BE(0) % Number(rng);
      if (decCmp(pick, String(result)) !== 0) return { lost: true };
      const w = decMulInt(bt, po), a9 = st.get(9), ha = st.get(1), more = decCmp(amount, w);   // w = bt*po
      if (more < 0) return "the pot (" + amount + ") is smaller than the winnings (" + w + "), so the covenant cannot pay it";
      if (typeof a9 !== "string" || !ADDR.test(a9)) return "state 9 (the player address) is not an address";
      if (more > 0 && (typeof ha !== "string" || !ADDR.test(ha))) return "state 1 (the house address) is not an address";
      if (!(HEX64.test(a9) && ctx.addrs.has(up(a9))) && !manual) return { why: "the winnings would go to " + a9 + ", which the node does not list as an address of this wallet: it is not settled automatically", manualOk: true };
      return { plan: Object.assign({ kind: "resolve", key: k8, secret: ps, outputs: [[a9, w]].concat(more > 0 ? [[ha, decSub(amount, w)]] : []) }, base) };
    })();
    if (r && r.plan) { row.action = "resolve"; row.auto = true; row.plan = r.plan; if (!row.held) row.note = "Won: " + r.plan.outputs[0][1] + " " + row.token + " is to be paid out to this wallet."; return autoOnly(); }
    if (house && expired) return claim(k0);
    if (r && r.lost) { row.note = "Lost: the pot goes to the house. Nothing to collect."; row.blocksLeft = null; row.leftFor = ""; return row; }
    return typeof r === "string" ? bad(r) : bad(r.why, r.manualOk);
  }
  if (expired) return claim(k0);
  row.blocksLeft = left; row.leftFor = "until this wallet can claim the pot"; if (!row.held) row.note = "Revealed: waiting for the player to settle.";
  return row;
}

// ---- building and posting ONE transaction ----
let seq = 0;
async function ensureScript() {
  const have = await run("scripts address:" + CONTRACT).catch(() => null);
  if (have && have.status === true && have.response && up(have.response.address) === up(CONTRACT)) return;
  const reg = await run(NEWSCRIPT).catch(() => null);
  if (!(reg && reg.status === true && reg.response && up(reg.response.address) === up(CONTRACT))) throw new Error("The P2P Chance contract could not be registered on the node, so nothing was built. Nothing was sent.");
}
/** One of this wallet's own addresses, said by the node twice: getaddress, and a simple row of `scripts`. */
async function ownAddress(ctx) {
  const a = await ask("getaddress", "getaddress"), addr = a && a.address;
  if (typeof addr !== "string" || !HEX64.test(addr) || !ctx.addrs.has(up(addr))) throw new Error("The node gave no address it lists as this wallet's own. Nothing was sent.");
  return addr;
}
async function send(plan, ctx, auto) {
  await ensureScript();
  const id = "cs_" + plan.kind + "_" + Date.now() + "_" + (++seq);
  const body = [];
  if (plan.kind === "cancel" || plan.kind === "claim") body.push("txnoutput id:" + id + " amount:" + plan.amount + " address:" + (await ownAddress(ctx)) + " tokenid:" + plan.tokenid + " storestate:false");
  if (plan.kind === "reveal") {
    body.push("txnoutput id:" + id + " amount:" + plan.amount + " address:" + CONTRACT + " tokenid:" + plan.tokenid + " storestate:true");
    for (const [port, value] of plan.states) body.push("txnstate id:" + id + " port:" + port + " value:" + value);
    body.push("txnstate id:" + id + " port:12 value:" + plan.secret);
  }
  if (plan.kind === "resolve") {
    for (const [address, amount] of plan.outputs) body.push("txnoutput id:" + id + " amount:" + amount + " address:" + address + " tokenid:" + plan.tokenid + " storestate:false");
    body.push("txnstate id:" + id + " port:13 value:" + plan.secret);
  }
  const cmds = ["txncreate id:" + id, "txninput id:" + id + " coinid:" + plan.coinid].concat(body, ["txnsign id:" + id + " publickey:" + plan.key, "txnbasics id:" + id, "txnpost id:" + id]);
  try {
    for (const c of cmds) {
      const post = c.startsWith("txnpost"), sign = c.startsWith("txnsign"), before = sign ? loadStore().posted[plan.coinid] : null;
      if (sign) countSignature(plan.coinid, plan.kind, ctx.tip, auto);   // every signature is counted, before it is asked for
      if (post) setSent(plan.coinid, true, "");                           // before the post: a crash must not build it again
      let r, err; try { r = await run(c); } catch (e) { r = undefined; err = e; }
      const refused = (err && neverSent(err)) || (r && typeof r === "object" && r.status === false && r.pending !== true);
      if (sign && refused) uncountSignature(plan.coinid, before, auto);   // the node's own "no": no signature was made
      if (post) {
        // only the node's own refusal (status false, not pending) or a post that never reached it is a failure; no answer or an
        // unreadable one is "sent, outcome unknown" (as Vestr, 0.18.322), and stays recorded. A refused post is not "sent": the
        // coin is not held, but its signature stays counted.
        if (r && typeof r === "object" && r.status === true) { const tx = r.response && r.response.txpowid, txpowid = V.isHexId(tx) ? tx : ""; setSent(plan.coinid, true, txpowid); return { ok: true, action: plan.kind, coinid: plan.coinid, txpowid }; }
        if (refused) { setSent(plan.coinid, false, ""); throw new Error("the node refused the transaction" + (r && r.error ? " (" + String(r.error) + ")" : err ? " (" + err.message + ")" : "") + ". Nothing was sent."); }
        return { ok: true, unknown: true, action: plan.kind, coinid: plan.coinid, txpowid: "" };
      }
      if (!r || r.status !== true) throw new Error(c.split(" ")[0] + " failed" + (r && r.error ? " (" + String(r.error) + ")" : err ? " (" + err.message + ")" : "") + ". Nothing was sent.");
    }
  } finally { await run("txndelete id:" + id).catch(() => {}); }   // every path, the family rule
}

// ---- one thing at a time: the block pass and a click never build two transactions of one coin ----
let chain = Promise.resolve();
function locked(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }
// What is said at post time is "sent": the node answers a post before mining and does not judge the contract. "Spent" is said by scan().
const WORDS = { cancel: "the cancel of an open offer", reveal: "the reveal of the house secret of a taken offer", resolve: "the payout of a bet this wallet won", claim: "the claim of the pot of a bet the other side let time out" };
function said(res) {
  return "Sent " + WORDS[res.action] + (res.unknown ? "; the node did not answer, so it may or may not have gone through" : "; not confirmed yet (the node takes a transaction before it is mined)")
    + ": coin " + res.coinid + (res.txpowid ? ", id before mining " + res.txpowid : "") + ".";
}
const idCmp = (a, b) => a.coinid < b.coinid ? -1 : a.coinid > b.coinid ? 1 : 0;
const bigFirst = (a, b) => decCmp(b.amount, a.amount) || idCmp(a, b);
/**
 * The order of automatic work. Never the scan's (newest first: a stranger's new coins would always be first). Reveals and payouts
 * (they have a deadline and need this wallet's secret) before timeout claims; among them alternately the nearest deadline and
 * the largest amount, so neither many small coins with short timeouts nor one large coin can keep the other waiting; claims
 * by amount.
 */
function ordered(rows) {
  const first = rows.filter(r => r.action !== "claim"), claims = rows.filter(r => r.action === "claim").sort(bigFirst);
  const soon = first.slice().sort((a, b) => (a.blocksLeft - b.blocksLeft) || bigFirst(a, b)), big = first.slice().sort((a, b) => bigFirst(a, b)), out = [], seen = new Set();
  for (let i = 0; i < first.length; i++) for (const r of [soon[i], big[i]]) if (!seen.has(r)) { seen.add(r); out.push(r); }
  return out.concat(claims);
}

/** This wallet's coins at the contract, for the panel. Never throws: { ok:false, error } when the node cannot be read. */
async function list() {
  try {
    const ctx = await scan(), rows = [];
    for (const c of ctx.coins) { let r; try { r = await judge(c, ctx, false); } catch (e) { continue; } if (r) { delete r.plan; rows.push(r); } }
    const used = sigsToday();
    return { ok: true, contract: CONTRACT, tip: ctx.tip, rows, auto: { perCoin: AUTO_TRIES, perPass: AUTO_PER_PASS, perDay: AUTO_PER_DAY, usedToday: used, reached: used >= AUTO_PER_DAY } };
  } catch (e) { return { ok: false, contract: CONTRACT, error: String((e && e.message) || e), rows: [] }; }
}
/** The user's click on one coin: the coin is read again, judged again, and what the covenant gives this wallet is done. */
function settle(coinid) {
  return locked(async () => {
    if (typeof coinid !== "string" || !HEX64.test(coinid)) throw new Error("That is not a coin id. Nothing was sent.");
    const ctx = await scan(), coin = ctx.coins.find(c => up(c.coinid) === up(coinid));
    if (!coin) throw new Error("That coin is no longer at the contract (already settled?). Nothing was sent.");
    const row = await judge(coin, ctx, true);
    if (!row) throw new Error("The node does not list a key of that coin as this wallet's. Nothing was sent.");
    if (row.problem) throw new Error("This coin cannot be settled here: " + row.problem + ". Nothing was sent.");
    if (row.held) throw new Error(row.note + " Nothing more was sent.");
    if (!row.plan) throw new Error((row.note || "There is nothing to do for this coin yet.") + " Nothing was sent.");
    const res = await send(row.plan, ctx, false); emitter.emit("update");
    return Object.assign(res, { message: said(res) });
  });
}
/** ONE scan, every coin judged once, and the rows that have something to send (not held, no problem). */
async function work(pick, manual) {
  const ctx = await scan(), rows = [];
  for (const c of ctx.coins) { let r; try { r = await judge(c, ctx, manual); } catch (e) { continue; } if (r && r.plan && !r.held && !r.problem && pick(r)) rows.push(r); }
  return { ctx, rows };
}
/** "Cancel all my open offers": the user's click. The largest first, at most MANUAL_SWEEP in one click. */
function cancelAll() {
  return locked(async () => {
    const { ctx, rows } = await work(r => r.action === "cancel", true), done = [], failed = [];
    for (const row of rows.sort(bigFirst).slice(0, MANUAL_SWEEP)) {
      try { const res = await send(row.plan, ctx, false); done.push(Object.assign(res, { message: said(res) })); }
      catch (e) { failed.push({ coinid: row.plan.coinid, action: row.action, error: String((e && e.message) || e) }); }
    }
    if (done.length || failed.length) emitter.emit("update");
    return { done, failed };
  });
}
/** The block pass: reveals, payouts and timeout claims, nothing else; bounded. It never cancels an offer. */
function pass() {
  return locked(async () => {
    const { ctx, rows } = await work(r => r.auto, false), done = [], failed = [], start = sigsToday();
    for (const row of ordered(rows)) {
      const used = sigsToday();
      if (used - start >= AUTO_PER_PASS || done.length + failed.length >= 2 * AUTO_PER_PASS) break;   // signatures, and tries that failed before one
      if (used >= AUTO_PER_DAY) { log("the automatic limit is reached: " + used + " signatures in the last 24 hours (limit " + AUTO_PER_DAY + "). Nothing more is signed automatically until that falls."); break; }
      if (row.action === "claim" && used >= CLAIMS_PER_DAY) continue;
      try { const res = await send(row.plan, ctx, true), m = said(res); done.push(Object.assign(res, { message: m })); log(m); emitter.emit("notify", m); }
      catch (e) { failed.push({ coinid: row.plan.coinid, action: row.action, error: String((e && e.message) || e) }); log("not sent: " + row.action + " of coin " + row.plan.coinid + ": " + ((e && e.message) || e)); }
    }
    if (done.length || failed.length) emitter.emit("update");
    return { done, failed };
  });
}

let pollTimer = null, lastTip = null;
function startLoop() {
  if (pollTimer) return;
  const t = () => run("block").then(r => {   // a node that is stopped or not answering: silently, the next tick asks again
    const b = r && r.response && r.response.block;
    if (b && b !== lastTip) { lastTip = b; return pass().then(() => emitter.emit("update"), e => log("pass skipped: " + ((e && e.message) || e))); }
  }, () => {});
  t(); pollTimer = setInterval(t, SCAN_EVERY_MS);
}
function stopLoop() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
/** A seed restore or wallet change: the keys seen so far belong to the old wallet. */
function invalidate() { known = new Set(); strangers = new Set(); secretCache.clear(); lastTip = null; }

module.exports = {
  emitter, list, settle, cancelAll, pass, startLoop, stopLoop, invalidate, CONTRACT, SCRIPT, MXUSD_TOKENID, REPOST_AFTER, AUTO_TRIES, AUTO_PER_PASS, AUTO_PER_DAY, CLAIMS_PER_DAY, HOLD_AGE, REVEAL_ANYWAY_LEFT,
  _setClock: (fn) => { now = fn; }, _setRunner: (fn) => { runner0 = fn; }, _setSecrets: (fn) => { readSecret = fn; secretCache.clear(); }, _setStore: (s) => { store = s; }, _judge: judge, _run: run
};
