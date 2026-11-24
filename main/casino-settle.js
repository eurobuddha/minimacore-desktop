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
 *  - THE SECRET OF AN OFFER THAT IS STILL OPEN IS NEVER SHOWN. A reveal puts the house secret on chain. Anyone can forge a
 *    phase-1 coin that copies the key and commit of a live offer; revealing for it would let the forger take the real offer with
 *    a pick he knows wins. The covenant lets a phase-0 offer be spent only by its owner's signature or by a real take, so an
 *    offer has been taken (or cancelled) exactly when no unspent phase-0 coin carries its commit. The reveal is therefore made
 *    only when the SAME confirmed coin scan holds no phase-0 coin with that commit and one of this wallet's keys; while one
 *    exists, that phase-0 coin is cancelled first (safe in both readings: it is this wallet's own money or a forger's gift),
 *    and the reveal waits until it is gone. The scan is the confirmed chain, never the mempool: a take that is only in the
 *    mempool can still be replaced by one with another pick. Besides, a taken offer of this app always holds bet x payout
 *    (stake bet x (payout - 1) plus the taker's bet, forced by the covenant): any other amount is a forgery and is not
 *    revealed automatically (it would cost a key use per forged dust coin).
 *  - Outcome and payout are the covenant's own: SHA3(house secret ++ player secret), its first 4 bytes as a number, modulo
 *    the range, equal to the pick; winnings bet x payout, the rest to the house. Exact decimal arithmetic (BigInt), no rounding.
 *  - Every transaction's error path runs txndelete (family rule), and so does its success path. A posted transaction is
 *    written to <userData>/casino-settle.json before the post, so it is not built again each block.
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

// ---- the shapes: the ONLY values that reach a command ----
const HEX64 = /^0x[0-9A-Fa-f]{64}$/;                    // a key, an address or a commit this wallet relies on; a secret; a coin id
const HEXV = /^0x(?:[0-9A-Fa-f]{2}){1,64}$/;            // hex the other side wrote, copied or hashed as it is
const ADDR = /^0x(?:[0-9A-Fa-f]{2}){1,32}$/;            // an address the covenant makes an output pay
const DEC = /^\d{1,30}(?:\.\d{1,44})?$/;                // a plain decimal
const INT = /^[1-9]\d{0,9}$/;                           // a positive whole number (range, payout)
const BLOCKN = /^\d{1,12}$/;
const copyable = (v) => typeof v === "string" && (HEXV.test(v) || DEC.test(v));
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
function posted() {
  const o = store.load(), p = (o && o.posted && typeof o.posted === "object") ? o.posted : {}, out = {};
  for (const [id, r] of Object.entries(p)) if (HEX64.test(id) && r && Number.isSafeInteger(r.block)) out[id] = { action: String(r.action || ""), block: r.block, at: Number(r.at) || 0, txpowid: V.isHexId(r.txpowid) ? r.txpowid : "" };
  return out;
}
function setPosted(coinid, rec) { const p = posted(); if (rec) p[coinid] = rec; else delete p[coinid]; try { store.save({ posted: p }); } catch (e) { log("could not save the posted list: " + (e && e.message)); } }

// ---- reading the node ----
const up = (s) => String(s).toUpperCase();
let known = new Set();   // every key the node has listed this session: one short `keys` answer does not make a coin a stranger's
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
  const p = posted(), gone = Object.keys(p).filter(id => !coins.some(c => c && up(c.coinid) === up(id)));   // spent: settled
  if (gone.length) { for (const id of gone) delete p[id]; try { store.save({ posted: p }); } catch (e) {} }
  return { tip: Number(tipS), keys: known, addrs, coins: coins.filter(c => c && typeof c === "object"), posted: p };
}
/** Is this key the node's, asked for this one key (no list to be short)? An unreadable answer throws: never a guess. */
async function isKey(pk) {
  if (known.has(up(pk))) return true;
  const r = await ask("keys publickey:" + pk, "one key");
  const hit = !!(r && Array.isArray(r.keys) && r.keys.some(row => row && up(row.publickey) === up(pk)));
  if (hit) known.add(up(pk));
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

/**
 * What this wallet may do with ONE coin at the contract. → null (not this wallet's: nothing is done, nothing is listed), or a row
 * { coinid, phase, role, amount, tokenid, token, age, blocksLeft, leftFor, action, auto, note, problem, manualOk, held, plan }.
 * `manual` is the user's own click: it lifts only the two checks that guard against paying for nothing (the pot is bet x payout;
 * the winnings address is this wallet's), never a shape check, the secret or the open-offer rule.
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
  if (!V.isTokenid(tokenid) || !V.isAmount(amount) || !BLOCKN.test(String(coin.created))) return bad("its token, amount or creation block cannot be read");
  Object.assign(row, { amount, tokenid, token: tokenLabel(tokenid), age: ctx.tip - Number(coin.created) });
  if (row.age < 0) return bad("it is newer than the node's tip");
  const phase = phaseOf(st); if (phase === null) return bad("state 6 (the phase) is not 0, 1 or 2");
  row.phase = phase;
  const p = ctx.posted[row.coinid]; if (p && ctx.tip - p.block < REPOST_AFTER) { row.held = true; row.note = "A transaction for this coin was sent at block " + p.block + (p.txpowid ? " (" + p.txpowid + ")" : "") + ". Waiting for the chain."; }
  const base = { coinid: row.coinid, amount, tokenid };

  if (phase === 0) {
    if (!house) return bad("it is an open offer, and state 0 is not a key of this wallet");
    row.action = "cancel"; row.plan = Object.assign({ kind: "cancel", key: k0 }, base);
    if (!row.held) row.note = "Open offer: anyone can take it at any time, in another P2P Chance app. Cancel it to take your stake back.";
    return row;
  }
  const to = st.get(7); if (typeof to !== "string" || !DEC.test(to)) return bad("state 7 (the timeout) is not a plain number");
  const expired = BigInt(row.age) > BigInt(to.split(".")[0]);   // the covenant's @COINAGE GT timeout, at the tip
  const left = expired ? 0 : Number(BigInt(to.split(".")[0]) - BigInt(row.age)) + 1;
  const claim = (key) => { row.action = "claim"; row.auto = true; row.plan = Object.assign({ kind: "claim", key }, base); if (!row.held) row.note = "The other side let the timeout pass: this wallet takes the whole pot."; return row; };

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
    // THE OPEN-OFFER RULE: never while a phase-0 coin of this wallet carries the same commit (the offer could still be taken).
    for (const o of ctx.coins) {
      const os = o !== coin && stateOf(o); if (!os || phaseOf(os) !== 0 || up(os.get(2)) !== up(commit)) continue;
      const ok0 = os.get(0); if (typeof ok0 !== "string" || !HEX64.test(ok0)) continue;
      let mine; try { mine = up(ok0) === up(k0) || await isKey(ok0); } catch (e) { return bad("an open offer with the same commit is on chain (coin " + String(o.coinid) + ") and the node could not say whether its key is this wallet's: the secret is not shown"); }
      if (!mine) continue;   // not this wallet's key: not its offer (an offer of this wallet always carries one of its keys)
      if (!HEX64.test(String(o.coinid)) || !V.isTokenid(o.tokenid) || !V.isAmount(o.tokenid === "0x00" ? o.amount : o.tokenamount)) return bad("an open offer with the same commit is still on chain (coin " + String(o.coinid) + ") and cannot be read: the secret is not shown while it could be taken");
      row.action = "unblock"; row.auto = true;
      row.plan = { kind: "cancel", key: ok0, coinid: o.coinid, amount: o.tokenid === "0x00" ? o.amount : o.tokenamount, tokenid: o.tokenid };
      row.note = "An open offer with the same commit is still on chain (coin " + o.coinid + "). It is cancelled first: the secret is not shown while that offer could still be taken.";
      const op = ctx.posted[o.coinid]; if (op && ctx.tip - op.block < REPOST_AFTER) row.held = true;
      return row;
    }
    row.action = "reveal"; row.auto = true;
    row.plan = Object.assign({ kind: "reveal", key: k0, secret, states: [0, 1, 2, 3, 4, 5].map(n => [n, st.get(n)]).concat([[6, "2"]], [7, 8, 9, 10, 11].map(n => [n, st.get(n)])) }, base);
    if (!row.held) row.note = "Taken: the house secret is revealed so the bet can be settled.";
    return row;
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
    if (r && r.plan) { row.action = "resolve"; row.auto = true; row.plan = r.plan; if (!row.held) row.note = "Won: " + r.plan.outputs[0][1] + " " + row.token + " is paid out to this wallet."; return row; }
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
async function send(plan, ctx) {
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
      const post = c.startsWith("txnpost");
      if (post) setPosted(plan.coinid, { action: plan.kind, block: ctx.tip, at: Date.now(), txpowid: "" });   // before the post: a crash must not build it again
      let r, err; try { r = await run(c); } catch (e) { r = undefined; err = e; }
      if (post) {
        // only the node's own refusal (status false, not pending) or a post that never reached it is a failure; no answer or an
        // unreadable one is "posted, outcome unknown" (as Vestr, 0.18.322), and stays recorded
        if (r && typeof r === "object" && r.status === true) { const tx = r.response && r.response.txpowid; setPosted(plan.coinid, { action: plan.kind, block: ctx.tip, at: Date.now(), txpowid: V.isHexId(tx) ? tx : "" }); return { ok: true, action: plan.kind, coinid: plan.coinid, txpowid: V.isHexId(tx) ? tx : "" }; }
        if ((err && neverSent(err)) || (r && typeof r === "object" && r.status === false && r.pending !== true)) { setPosted(plan.coinid, null); throw new Error("the node refused the transaction" + (r && r.error ? " (" + String(r.error) + ")" : err ? " (" + err.message + ")" : "") + ". Nothing was sent."); }
        return { ok: true, unknown: true, action: plan.kind, coinid: plan.coinid, txpowid: "" };
      }
      if (!r || r.status !== true) throw new Error(c.split(" ")[0] + " failed" + (r && r.error ? " (" + String(r.error) + ")" : err ? " (" + err.message + ")" : "") + ". Nothing was sent.");
    }
  } finally { await run("txndelete id:" + id).catch(() => {}); }   // every path, the family rule
}

// ---- one thing at a time: the block pass and a click never build two transactions of one coin ----
let chain = Promise.resolve();
function locked(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }
const WORDS = { cancel: "Cancelled an open offer", unblock: "Cancelled an open offer", reveal: "Revealed the house secret of a taken offer", resolve: "Collected the winnings of a bet", claim: "Claimed the pot of a bet the other side let time out" };
function said(row, res) { return WORDS[row.action] + (res.unknown ? " (sent; the node did not answer, so it may or may not have gone through)" : "") + ": coin " + res.coinid + (res.txpowid ? ", transaction " + res.txpowid : "") + "."; }

/** This wallet's coins at the contract, for the panel. Never throws: { ok:false, error } when the node cannot be read. */
async function list() {
  try {
    const ctx = await scan(), rows = [];
    for (const c of ctx.coins) { let r; try { r = await judge(c, ctx, false); } catch (e) { continue; } if (r) { delete r.plan; rows.push(r); } }
    return { ok: true, contract: CONTRACT, tip: ctx.tip, rows };
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
    const res = await send(row.plan, ctx); emitter.emit("update");
    return Object.assign(res, { message: said(row, res) });
  });
}
/** Every coin a filter picks, one at a time, each from a fresh read. → { done: [...], failed: [...] } */
async function sweep(pick, manual) {
  const tried = new Set(), done = [], failed = [];
  for (let n = 0; n < 50; n++) {
    const ctx = await scan(); let row = null;
    for (const c of ctx.coins) { let r; try { r = await judge(c, ctx, manual); } catch (e) { continue; } if (r && r.plan && !r.held && !r.problem && !tried.has(r.plan.coinid) && pick(r)) { row = r; break; } }
    if (!row) break;
    tried.add(row.plan.coinid);
    try { const res = await send(row.plan, ctx); done.push(Object.assign(res, { message: said(row, res) })); }
    catch (e) { failed.push({ coinid: row.plan.coinid, action: row.action, error: String((e && e.message) || e) }); }
  }
  if (done.length || failed.length) emitter.emit("update");
  return { done, failed };
}
/** "Cancel all my open offers": an untaken offer is a standing risk now that nothing here watches it. */
function cancelAll() { return locked(() => sweep(r => r.action === "cancel", true)); }
/** The block pass: reveals, payouts and timeout claims (and the cancel that must come before a reveal), nothing else. */
function pass() {
  return locked(async () => {
    const out = await sweep(r => r.auto, false);
    for (const d of out.done) { log(d.message); emitter.emit("notify", d.message); }
    for (const f of out.failed) log("not settled: " + f.action + " of coin " + f.coinid + ": " + f.error);
    return out;
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
function invalidate() { known = new Set(); secretCache.clear(); lastTip = null; }

module.exports = {
  emitter, list, settle, cancelAll, pass, startLoop, stopLoop, invalidate, CONTRACT, SCRIPT, MXUSD_TOKENID, REPOST_AFTER,
  _setRunner: (fn) => { runner0 = fn; }, _setSecrets: (fn) => { readSecret = fn; secretCache.clear(); }, _setStore: (s) => { store = s; }, _judge: judge, _run: run
};
