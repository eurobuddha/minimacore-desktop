/*
 * futurecash.js — Future Cash Next, the engine (main process). A port of Pandamonium's NATIVE app, not the MiniDapp:
 * apks/base integrated/futurecash-next (standalone futurecash-next 0.1.8, f8d09620156320242f54b8c7d2e212dac0ee8419 per
 * apks/base integrated/sources.lock.json): FutureCashContract, Node, Tx, Wallet, StakeScan, Guardian, Audit,
 * AuditRunner, Cfg, Store. The MiniDapp (mds/futurecash-next 3.2.1) was read only for the protocol.
 *
 * WHAT A STAKE IS. A coin sent to the FutureCash contract with state 0 = "0xFF", 1 = the unlock block, 2 = the payout
 * address (0x hex), 3 = the creation time in ms, 4 = the alternative unlock in blocks of coin age. The contract lets the
 * coin be spent once @BLOCK >= state 1 or @COINAGE >= state 4, and only with the whole amount going to state 2
 * (VERIFYOUT). So a collect needs NO signature and can only ever pay the address fixed when the stake was made.
 *
 * DIFFERENCES FROM THE PHONE, ON PURPOSE:
 *  - NODE ONLY. The phone also audits and rescues minimaWallet's keys (a separate wallet app inside Pandamonium). The
 *    desktop has no minimaWallet: its key set is empty, so the scan is the node's own (StakeScan reads the chain-wide
 *    contract address only for minimaWallet's sake, and never here).
 *  - BOUNDED READS. The phone reads `coins relevant:true` (the whole wallet) and `scripts` on every block. Here the
 *    stake read is `coins relevant:true address:<contract>` for the two contract addresses (the stakes this node
 *    tracks, nothing else), and the script table is read when it is needed (start, a payout not known, a retire, every
 *    SCRIPTS_EVERY blocks), never every block. Each pass posts at most CAP_POSTS collects and CAP_POSTS sweeps and asks
 *    the node about at most CAP_READS single coins; the rest waits for the next block.
 *
 * Every node command goes through o.run (main.js: rpcCall with owner "futurecash", so the signing queue and the coin
 * guard see it). Nothing here touches the network but the key audit (o.get, the one pinned host of main/keyuses.js).
 */
"use strict";
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const keyuses = require("./keyuses");
const { toUnits, fromUnits, pinMinimaSend } = require("./sendpin");

// ---- FutureCashContract.java, verbatim ----
/** The contract. Registered verbatim; its address is the hash of this exact text (scripts/futurecash-test.cjs pins both). */
const SCRIPT = "RETURN (@BLOCK GTE PREVSTATE(1) OR @COINAGE GTE PREVSTATE(4)) AND VERIFYOUT(@INPUT PREVSTATE(2) @AMOUNT @TOKENID FALSE)";
/** Where every FutureCash / Maximize stake sits (core's BondServer and the MiniDapp hard-code it too). */
const KNOWN_ADDRESS = "0xEA8823992AB3CEBBA855D68006F0D05B0C4838FE55885375837D90F98954FA13";
const ST_FUTUREBLOCK = 1, ST_RECIPIENT = 2, ST_COINAGE = 4;
const SECONDS_PER_BLOCK = 50;

// ---- Guardian.java / Audit.java / Cfg.java constants ----
const RETRY_BLOCKS = 8, MAX_ATTEMPTS = 5, VERIFY_GRACE = 3, VERIFY_MAX = 30;
const FRESH_MS = 30 * 60000, MAX_MS = 24 * 3600000, AUDIT_EVERY_MS = 20 * 60000;
const FINGERPRINT_VERSION = "wallet-keys-v1|";
const LOG_MAX_LINES = 80, LOG_MSG_MAX = 300;
const MIN_DEFAULTS_KEEP = 8;
// ---- the desktop's bounds ----
const CAP_POSTS = 8, CAP_READS = 32, SCRIPTS_EVERY = 10, STAKE_ROWS_MAX = 5000;

/** Cfg.java key names (the MiniDapp's keypair keys). */
const K = { ENABLED: "enabled", AUTO_COLLECT_SAFE: "auto_collect_safe", SAFE_ADDRESS: "safe_address", SAFE_MODE: "safe_mode", CLEAN_ADDR: "clean_addr",
  ATRISK_ADDRS: "atrisk_addrs", AUDIT_OK: "audit_ok", AUDIT_AT: "audit_at", AUDIT_USES: "audit_uses", AUDIT_LAST_ERR: "audit_last_err", SAFE_REUSED: "safe_reused",
  NOTIFY: "notify", SCRIPT_ADDRESS: "script_address", LAST_TIP: "last_tip", LAST_ACTION: "last_action", LOG: "fc_log", AUDIT_LOGGED_N: "audit_logged_n", GUARDIAN_ON: "guardian_on" };
/** Store.java status words. */
const S = { DETECTED: "DETECTED", COLLECT_POSTED: "COLLECT_POSTED", COLLECT_POSTED_SAFE: "COLLECT_POSTED_SAFE", COLLECTED: "COLLECTED", COLLECTED_SAFE: "COLLECTED_SAFE",
  SWEEP_QUEUED: "SWEEP_QUEUED", PENDING: "PENDING", SWEEP_POSTED: "SWEEP_POSTED", SWEPT: "SWEPT", TAKEN: "TAKEN" };

// ---- shapes: the one gate between data (the chain, the audit service, the screen) and a command string (Node.java) ----
const HEX = /^0x[0-9a-fA-F]{2,}$/, MX = /^M[xX][0-9A-Za-z]{30,100}$/, HEX64 = /^0x[0-9a-fA-F]{64}$/, AMOUNT = /^[0-9]+(\.[0-9]+)?$/;
const validHexAddr = (s) => typeof s === "string" && HEX.test(s);
const validMx = (s) => typeof s === "string" && MX.test(s);
const validAddr = (s) => validHexAddr(s) || validMx(s);
const lc = (s) => String(s == null ? "" : s).toLowerCase();

/** Wallet.canonAddr: hex and Mx spellings compare equal within their kind. */
function canon(a) {
  const s = String(a == null ? "" : a).trim();
  if (/^0x/i.test(s)) return "h" + s.slice(2).toLowerCase();
  if (/^M[xX]/.test(s)) { const h = mxToHex(s); return h ? "h" + h.slice(2).toLowerCase() : "m" + s; }   // an Mx is its hex, when it decodes (the desktop compares across spellings)
  if (/^[0-9a-fA-F]{8,}$/.test(s)) return "h" + s.toLowerCase();
  return "x" + s.toLowerCase();
}
const sha3 = (b) => crypto.createHash("sha3-256").update(b).digest();
const B32 = "0123456789abcdefghijklmnopqrstuv";
/** An Mx address back to its 0x hex (the inverse of main/keyuses.js addressOf's encoding, with its checksum), or null. */
function mxToHex(mx) {
  if (!validMx(mx)) return null;
  let n = 0n;
  for (const ch of mx.slice(2).toLowerCase().replace(/w/g, "i").replace(/y/g, "l").replace(/z/g, "o")) { const d = B32.indexOf(ch); if (d < 0) return null; n = n * 32n + BigInt(d); }
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const b = Buffer.from(h, "hex");
  if (b.length !== 39 || b[0] !== 1 || ((b[1] << 8) | b[2]) !== 32) return null;
  const addr = b.subarray(3, 35);
  return sha3(addr).subarray(0, 4).equals(b.subarray(35)) ? "0x" + addr.toString("hex").toUpperCase() : null;
}
/** The address of a script (a single-leaf MMR of it), as main/keyuses.js addressOf hashes RETURN SIGNEDBY(..). */
function scriptAddress(script) {
  const s = Buffer.from(String(script), "utf8"), len = Buffer.alloc(4); len.writeUInt32BE(s.length);
  return "0x" + sha3(Buffer.concat([Buffer.from([0, 1, 0]), len, s, Buffer.from([0, 1, 0])])).toString("hex").toUpperCase();
}

/** Node.state: a coin's state variable at a port, or null. */
function state(coin, port) {
  const st = coin && Array.isArray(coin.state) ? coin.state : null;
  if (!st) return null;
  for (const v of st) if (v && String(v.port) === String(port)) return v.data == null ? null : String(v.data);
  return null;
}
/** Node.outAmount: MINIMA in `amount`, a token in `tokenamount`. Missing = "0" (refused later as a zero output). */
const outAmount = (c) => (lc(c && c.tokenid) === "0x00" || !(c && c.tokenid) ? String(c && c.amount != null ? c.amount : "0") : String(c && c.tokenamount != null ? c.tokenamount : "0"));
const num = (s) => { const n = Number(String(s == null ? "" : s).trim()); return /^\d{1,15}$/.test(String(s == null ? "" : s).trim()) ? n : 0; };   // Guardian.parseLong: a plain whole number, else 0
/** Exact decimal sum of amount strings (44 decimals, as the node), written back without trailing zeros. Never rounded. */
const sum = (list) => fromUnits(list.reduce((a, s) => a + (AMOUNT.test(String(s)) ? toUnits(s) : 0n), 0n));
const decEq = (a, b) => AMOUNT.test(String(a)) && AMOUNT.test(String(b)) && toUnits(a) === toUnits(b);

/** Guardian.looksLikeFutureCash: a payout in port 2 and a plain block number in port 1. */
function looksLikeFutureCash(coin) {
  const payout = state(coin, ST_RECIPIENT), s1 = state(coin, ST_FUTUREBLOCK);
  return !!payout && s1 != null && /^[0-9]+$/.test(s1);
}
/** StakeScan.isStake: unspent, at one of the contract addresses, a 0x coin id, the shape, a well-formed payout. */
function isStake(coin, contracts) {
  if (!coin || coin.spent === true) return false;
  return contracts.some(a => lc(a) === lc(coin.address)) && HEX64.test(String(coin.coinid || "")) && looksLikeFutureCash(coin) && validAddr(state(coin, ST_RECIPIENT));
}
/** Guardian.matured: exactly the on-chain unlock. */
function matured(coin, tip) {
  const s1 = num(state(coin, ST_FUTUREBLOCK)), s4 = num(state(coin, ST_COINAGE)), created = num(coin && coin.created);
  if (s1 > 0 && tip >= s1) return true;
  return s4 > 0 && created > 0 && (tip - created) >= s4;
}
/** Wallet.hasOwnKey: a default row, or a real public key (every custom script row carries the STRING "0x00"). */
const hasOwnKey = (row) => !!row && (row.default === true || (!!row.publickey && row.publickey !== "0x00"));
const ok = (r) => !!r && r.status === true && r.pending !== true;
const rowsOf = (r) => (r && Array.isArray(r.response) ? r.response : r && r.response && typeof r.response === "object" ? [r.response] : []);

/** Audit.usesFingerprint: a canonical publickey:uses string for the node's whole key set. */
function usesFingerprint(keys) {
  const parts = [];
  for (const k of Array.isArray(keys) ? keys : []) if (k && k.publickey) parts.push(String(k.publickey).toUpperCase() + ":" + k.uses + ":" + k.size + ":" + k.depth + ":" + k.maxuses);
  return FINGERPRINT_VERSION + parts.sort().join("|");
}

/**
 * THE SIGN GATE. Before a transaction of this app is signed (txnsign) or posted (txnpost), what the NODE holds under
 * its id (`txnlist id:`) is checked against what was meant (p), never against what the engine believes it built:
 *   - exactly one input and one output, and no transaction state;
 *   - the input is the planned coin; one token in and out; the output's amount equals the input's and the plan's,
 *     exactly (nothing burnt, nothing kept back: a whole-coin spend, as the native's every transaction is);
 *   - collect: the input sits at a FutureCash contract address; the output pays the stake's own payout, which is an
 *     address of this wallet (and the input's state 2, where the node shows it);
 *   - sweep: the input sits on the address it was planned from, which is an address of this wallet that is at risk or
 *     retired; the output pays the configured safe destination.
 * Anything else is refused with the reason; the caller logs the whole transaction and deletes it.
 * p = { kind, coinid, tokenid, amount, to, contracts, own(addr), from, mayMove(addr), safe }.
 */
function gateCheck(txn, p) {
  const no = (why) => ({ ok: false, why });
  const ins = txn && txn.inputs, outs = txn && txn.outputs;
  if (!Array.isArray(ins) || !Array.isArray(outs)) return no("the node did not show the transaction's inputs and outputs");
  if (ins.length !== 1 || outs.length !== 1) return no(ins.length + " inputs and " + outs.length + " outputs, where one of each was built");
  if (Array.isArray(txn.state) && txn.state.length) return no("the transaction carries state");
  const i = ins[0] || {}, out = outs[0] || {};
  if (!HEX64.test(String(i.coinid || "")) || lc(i.coinid) !== lc(p.coinid)) return no("its input is coin " + i.coinid + ", not " + p.coinid);
  const tok = lc(i.tokenid);
  if (!/^0x[0-9a-f]{2,64}$/.test(tok) || lc(out.tokenid) !== tok || tok !== lc(p.tokenid)) return no("the token is not the same in the input (" + i.tokenid + "), the output (" + out.tokenid + ") and the plan (" + p.tokenid + ")");
  const amtIn = outAmount(i), amtOut = outAmount(out);
  if (!AMOUNT.test(amtIn) || toUnits(amtIn) <= 0n) return no("the input's amount is not stated");
  if (!decEq(amtIn, amtOut) || !decEq(amtIn, p.amount)) return no(amtIn + " goes in, " + amtOut + " comes out, " + p.amount + " was planned");
  if (out.storestate === true) return no("the output keeps state");
  if (p.kind === "collect") {
    if (!(p.contracts || []).some(a => lc(a) === lc(i.address))) return no("its input is not at the FutureCash contract (" + i.address + ")");
    if (canon(out.address) !== canon(p.to)) return no("its output pays " + out.address + ", not the stake's payout " + p.to);
    const s2 = state(i, ST_RECIPIENT);
    if (s2 != null && canon(s2) !== canon(p.to)) return no("the stake's own payout is " + s2 + ", not " + p.to);
    if (!p.own || !p.own(p.to)) return no("the payout " + p.to + " is not an address of this wallet");
    return { ok: true };
  }
  if (p.kind === "sweep") {
    if (canon(i.address) !== canon(p.from)) return no("its input is on " + i.address + ", not " + p.from);
    if (!p.own || !p.own(p.from) || !p.mayMove || !p.mayMove(p.from)) return no("the coin is on " + p.from + ", which is not an at-risk or retired address of this wallet");
    if (!p.safe || canon(p.to) !== canon(p.safe) || canon(out.address) !== canon(p.safe)) return no("its output pays " + out.address + ", not the safe destination " + p.safe);
    return { ok: true };
  }
  return no("an unknown kind of transaction");
}

/**
 * create(o): o = { run(cmd) -> the node's reply (rpcCall, owner "futurecash"), dir() -> userData, get(url) -> parsed JSON
 * or null (the audit host), log(line), notify(title, body), now() }.
 */
function create(o) {
  const now = o.now || Date.now, log = (l) => { try { o.log && o.log("[futurecash] " + l); } catch (e) {} };
  let store = null, walletKey = "", opening = null, startedAt = 0, openError = "";
  let scriptsCache = null;      // { block, rows, keys } — the node's script table and keys, read when needed
  const atRisk = new Set();
  let lastTip = 0, auditRunning = false, lastAudit = null, passing = null, lockSaid = false, offSaid = false, vaultWasLocked = false;

  const call = async (c) => { try { return await o.run(c); } catch (e) { return null; } };
  const kv = () => { if (!store) throw new Error("Future Cash Next has not started yet."); return store.kv; };

  /** Cfg.log: newest first, capped; ids come first in a message (the cap clips the tail). */
  function activity(level, message) {
    let msg = String(message == null ? "" : message); if (msg.length > LOG_MSG_MAX) msg = msg.slice(0, LOG_MSG_MAX);
    log(level + ": " + msg);
    if (!store) return;
    let arr = []; try { arr = JSON.parse(store.kv.get(K.LOG, "[]")); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
    store.kv.set(K.LOG, JSON.stringify([{ ts: now(), level, msg }].concat(arr).slice(0, LOG_MAX_LINES)));
  }

  // ---- which wallet, which store ----
  /** The wallet's first public key (modifier 0x00), as main/reserve.js names its file. Throws when the node does not show it. */
  async function firstKey() {
    const pick = (r) => { const l = r && r.status === true && r.response && Array.isArray(r.response.keys) ? r.response.keys : []; const k = l.find(x => x && lc(x.modifier) === "0x00"); return k && HEX64.test(String(k.publickey)) ? lc(k.publickey) : ""; };
    let pk = pick(await call("keys modifier:0x00"));
    if (!pk) pk = pick(await call("keys"));
    if (!pk) throw new Error("the node did not show the wallet's first key yet");
    return pk;
  }
  const storeDir = () => path.join(o.dir(), "futurecash");
  const storeName = (pk) => "futurecash-pk-0x" + crypto.createHash("sha256").update("futurecash|first-key|" + pk).digest("hex") + ".sqlite";
  /** Open this wallet's store (the node is running). Safe to call again; a damaged file is never opened and is said. */
  function start() {
    if (store) return Promise.resolve();
    if (opening) return opening;
    opening = (async () => {
      try {
        const pk = await firstKey();
        store = await require("./futurecash-store").open(path.join(storeDir(), storeName(pk)), { now });
        walletKey = pk; startedAt = now(); openError = ""; scriptsCache = null;
        log("store open for the wallet whose first key is " + pk);
        try { await registerContract(); } catch (e) { log("the contract could not be registered yet: " + ((e && e.message) || e)); }   // asked again on the next lock
      } catch (e) { openError = (e && e.message) || String(e); log("could not start: " + openError); throw e; }
      finally { opening = null; }
    })();
    return opening;
  }
  /** The node stopped (or the app is frozen): a pass under way ends first, then the store is closed. */
  async function stop() {
    if (passing) await passing.catch(() => {});
    await turn;   // an action the screens asked for ends first too
    const s = store; store = null; scriptsCache = null; atRisk.clear(); lastTip = 0; if (s) s.close();
  }

  // ---- the node's script table, bounded (see the header) ----
  /** Wallet.addressSets, from one `scripts` and one `keys action:list` read: what this node can sign for and what it tracks. */
  async function scriptTable(force) {
    if (!force && scriptsCache && lastTip && lastTip - scriptsCache.block < SCRIPTS_EVERY) return scriptsCache;
    const r = await call("scripts");
    if (!r || r.status !== true || r.pending === true || !Array.isArray(r.response)) throw new Error("Could not read wallet addresses. Refresh and retry.");
    const kr = await call("keys action:list"), keys = kr && kr.status === true && kr.response && Array.isArray(kr.response.keys) ? kr.response.keys : null;
    if (!keys) throw new Error("Could not read wallet addresses. Refresh and retry.");
    const ours = new Set(keys.map(k => lc(k && k.publickey)));
    const own = new Set(), tracked = new Set(), retired = [], byCanon = new Map();
    for (const s of r.response) {
      if (!s) continue;
      const addr = String(s.address || ""), mx = String(s.miniaddress || "");
      if (addr) { tracked.add(canon(addr)); byCanon.set(canon(addr), s); }
      if (mx) tracked.add(canon(mx));
      if (hasOwnKey(s)) { if (addr) own.add(canon(addr)); if (mx) own.add(canon(mx)); }
      // Wallet.retiredAddresses: not default, key nulled, script exactly RETURN SIGNEDBY(0x<one of OUR keys>)
      const m = /^RETURN\s+SIGNEDBY\((0x[0-9a-fA-F]+)\)$/i.exec(String(s.script || "").replace(/\s+/g, " ").trim());
      if (addr && s.default !== true && s.publickey === "0x00" && m && ours.has(lc(m[1]))) { retired.push(addr); own.add(canon(addr)); if (mx) own.add(canon(mx)); }
    }
    scriptsCache = { block: lastTip, rows: r.response, keys, own, tracked, retired, byCanon };
    return scriptsCache;
  }
  const owns = (sets, a) => !!a && sets.own.has(canon(a));

  /** Guardian.reloadAtRisk: the audited addresses plus this node's own retired ones. */
  function loadAtRisk(sets) {
    atRisk.clear();
    let flagged = []; try { flagged = JSON.parse(kv().get(K.ATRISK_ADDRS, "[]")); } catch (e) { flagged = []; }
    for (const a of Array.isArray(flagged) ? flagged : []) if (validAddr(a)) atRisk.add(canon(a));
    for (const a of sets ? sets.retired : []) atRisk.add(canon(a));
  }

  /** The contract addresses scanned: the known one, and this node's registered one when it differs. */
  function contracts() {
    const local = store && store.kv.get(K.SCRIPT_ADDRESS, null);
    return local && HEX64.test(local) && lc(local) !== lc(KNOWN_ADDRESS) ? [KNOWN_ADDRESS, local] : [KNOWN_ADDRESS];
  }

  /**
   * StakeScan.read, bounded: the stakes this node tracks at each contract address (`coins relevant:true address:`),
   * paying out to an address of this wallet. Throws (the screen says it) when a read is not complete.
   */
  async function scan(sets) {
    const list = contracts(), found = new Map();
    for (const a of list) {
      const r = await call("coins relevant:true address:" + a);
      if (!r || r.status !== true || r.pending === true || !Array.isArray(r.response)) throw new Error("Could not read the complete stake list. Refresh and retry.");
      if (r.response.length > STAKE_ROWS_MAX) throw new Error("Could not read the complete stake list. Refresh and retry.");
      for (const c of r.response) {
        if (!c || typeof c !== "object") throw new Error("Could not read the complete stake list. Refresh and retry.");
        if (isStake(c, list) && owns(sets, state(c, ST_RECIPIENT))) found.set(lc(c.coinid), c);
      }
    }
    return [...found.values()];
  }

  async function tip() {
    const r = await call("block");
    const b = r && r.status === true && r.response ? num(r.response.block) : 0;
    if (b) lastTip = b;
    return b;
  }

  // ---- the audit (AuditRunner, Audit) ----
  /** Audit.usable: may the guardian act on the stored verdict? Re-confirmed against the node's key counters past FRESH_MS. */
  async function verdict() {
    const k = kv(), aok = k.is(K.AUDIT_OK, false), at = k.getLong(K.AUDIT_AT), age = now() - at;
    if (!aok || at === 0) return { ok: false, at, mode: at ? "PARTIAL" : "NONE" };
    if (at < 0 || age < 0) return { ok: false, at, mode: "STALE" };
    const fp = k.get(K.AUDIT_USES, "");
    if (!fp || !fp.startsWith(FINGERPRINT_VERSION)) return { ok: false, at, mode: "STALE" };
    if (age < FRESH_MS) return { ok: true, at, mode: "FRESH" };
    if (age >= MAX_MS) return { ok: false, at, mode: "STALE" };
    const r = await call("keys action:list"), keys = ok(r) && r.response && Array.isArray(r.response.keys) ? r.response.keys : null;
    if (!keys) return { ok: false, at, mode: "STALE" };
    return usesFingerprint(keys) === fp ? { ok: true, at, mode: "RECONFIRMED" } : { ok: false, at, mode: "STALE" };
  }
  /** Audit.setSafeReused. */
  function setSafeReused(addr, count) {
    const prev = kv().get(K.SAFE_REUSED, "") || "", next = addr ? JSON.stringify({ addr, count }) : "";
    if (next === prev) return;
    kv().set(K.SAFE_REUSED, next);
    if (!next) activity("info", "Safe destination re-checked and clean");
    else activity("error", "Your SAFE destination is a REUSED address (signed " + count + "x) — rescuing there would move your money onto another exposed key. Set a fresh safe address. | address:" + addr);
  }
  function safeReused() { try { const o2 = JSON.parse(kv().get(K.SAFE_REUSED, "") || "null"); return o2 && o2.addr ? { addr: String(o2.addr), count: Number(o2.count) || 0 } : null; } catch (e) { return null; } }
  function safeIsReused(safe) { const b = safeReused(); return !!(b && safe && canon(b.addr) === canon(safe)); }
  function cleanAddr() { try { const c = JSON.parse(kv().get(K.CLEAN_ADDR, "") || "null"); return c && validMx(c.mx) && validHexAddr(c.hex) ? { mx: c.mx, hex: c.hex } : null; } catch (e) { return null; } }
  /** AuditRunner.destinations: where rescued money goes, the safe and the minted clean address. */
  function destinations() {
    const out = [], safe = kv().get(K.SAFE_ADDRESS, ""), clean = cleanAddr();
    if (safe) out.push(safe);
    if (clean && clean.mx !== safe) out.push(clean.hex);
    return out;
  }
  /** Audit.store: at-risk set, fingerprint, destination verdict, audit_ok, audit_at — in that order. */
  function storeAudit(list, keys, complete, badAddr, badCount) {
    const k = kv();
    let arr = list.filter(validAddr);
    if (!complete) {
      let prev; try { prev = JSON.parse(k.get(K.ATRISK_ADDRS, "[]")); } catch (e) { k.setBool(K.AUDIT_OK, false); return; }
      for (const a of Array.isArray(prev) ? prev : []) if (validAddr(a) && !arr.includes(a)) arr.push(a);
    }
    k.set(K.ATRISK_ADDRS, JSON.stringify(arr));
    k.set(K.AUDIT_USES, usesFingerprint(keys));
    if (complete || badAddr) setSafeReused(badAddr, badCount);
    k.setBool(K.AUDIT_OK, complete);
    k.set(K.AUDIT_AT, String(now()));
    if (String(arr.length) !== k.get(K.AUDIT_LOGGED_N, "-1")) { k.set(K.AUDIT_LOGGED_N, String(arr.length)); activity("info", "Audit: " + arr.length + " at-risk address(es)"); }
  }
  /** AuditRunner.run, over main/keyuses.js (the same reads, host and parsing the KeyUses app uses). */
  async function audit(force) {
    if (!store) throw new Error("Future Cash Next has not started yet.");
    const at = kv().getLong(K.AUDIT_AT), age = now() - at;
    if (!force && at > 0 && age >= 0 && age < AUDIT_EVERY_MS && kv().get(K.AUDIT_USES, "").startsWith(FINGERPRINT_VERSION)) return { ok: true, skipped: true };
    if (auditRunning) return { ok: false, running: true };
    auditRunning = true;
    try {
      if (!keyuses.selfTest()) { const m = "Address verification failed. This build cannot run a reliable audit."; kv().set(K.AUDIT_LAST_ERR, m); return { ok: false, error: m }; }
      let keys;
      try { keys = keyuses.select(await o.run("keys action:list")); }
      catch (e) { const m = "Couldn't read keys from the embedded node. Check Minima Core’s status."; kv().set(K.AUDIT_LAST_ERR, m); return { ok: false, error: m }; }
      const dests = destinations().map(d => (validMx(d) ? mxToHex(d) : d)).filter(validHexAddr);
      let found;
      try { found = await keyuses.lookup(keys, o.get, dests); }
      catch (e) { const m = "Couldn't reach the audit service (Could not reach the audit service. Check your connection and try again.)."; kv().set(K.AUDIT_LAST_ERR, m); return { ok: false, error: m }; }
      const result = keyuses.join(keys, found.usage, found.reuse);
      const list = [];
      for (const r of result.rows) if (r.risk || r.reused) list.push(r.hex, r.address);
      let badAddr = "", badCount = 0, complete = result.complete;
      for (const d of destinations()) {
        const hex = validMx(d) ? mxToHex(d) : d, ru = found.reuse.find(x => lc(x.address) === lc(hex));
        if (!ru) complete = false;
        else if (ru.reused && !badAddr) { badAddr = d; badCount = ru.reuseCount; }
      }
      // the keys read again: a key that signed during the request makes the verdict incomplete (AuditRunner's wallet check)
      let again = null; try { again = keyuses.select(await o.run("keys action:list")); } catch (e) {}
      if (!again || JSON.stringify(again) !== JSON.stringify(keys)) complete = false;
      storeAudit(list, keys, complete, badAddr, badCount);
      kv().set(K.AUDIT_LAST_ERR, "");
      lastAudit = Object.assign({ tip: found.tip }, result, { complete });
      return { ok: true };
    } finally { auditRunning = false; }
  }

  // ---- the contract (Wallet.registerContract) ----
  const cleanScript = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
  async function scriptRow(addr) {
    if (!validAddr(addr)) return null;   // the command-injection choke point (Node.validAddr)
    const r = await call("scripts address:" + addr), row = rowsOf(r)[0];
    return row && row.script ? row : null;
  }
  function cacheContract(addr) {
    if (!HEX64.test(String(addr || ""))) return null;
    const prev = kv().get(K.SCRIPT_ADDRESS, null);
    kv().set(K.SCRIPT_ADDRESS, addr);
    if (addr !== prev) activity("info", "FutureCash contract address | address:" + addr);
    return addr;
  }
  async function registerNow() {
    const r = await call("newscript trackall:false clean:true script:\"" + SCRIPT + "\"");
    return cacheContract(ok(r) && r.response ? r.response.address : "");
  }
  /**
   * The contract must be in THIS node's script table (asked of the node at every start, never taken from the cache
   * alone), tracked with trackall:false (a stake is then kept only because its payout is ours). newscript is not an
   * idempotent no-op (core removes, then adds), so it is sent only when the row is really missing or wrongly scoped.
   */
  async function registerContract() {
    const cached = kv().get(K.SCRIPT_ADDRESS, null);
    if (cached) {
      const row = await scriptRow(cached);
      if (row && row.track === true) { activity("warn", "Repairing contract registration — this node was tracking every FutureCash/Maximize stake on the chain, not just yours"); return registerNow(); }
      if (row) return cached;
      return registerNow();
    }
    const r = await call("scripts");
    for (const row of ok(r) && Array.isArray(r.response) ? r.response : []) {
      if (row && cleanScript(row.script) === cleanScript(SCRIPT)) return row.track === true ? registerNow() : cacheContract(row.address);
    }
    return registerNow();
  }
  async function contractAddress() { return kv().get(K.SCRIPT_ADDRESS, null) || registerContract(); }

  // ---- the rescue destination and the payout address (Wallet.cleanAddress) ----
  /** Wallet.vaultLocked: a reply that does not say "unlocked" is locked. */
  async function vaultLocked() {
    const r = await call("status"), resp = r && r.response;
    return !ok(r) || !resp || typeof resp.locked !== "boolean" || resp.locked;
  }
  /** One fresh clean address on THIS node (a `newaddress`), minted once and kept as one blob {mx, hex}. */
  async function cleanAddress() {
    const have = cleanAddr();
    if (have) return { ok: true, value: have.mx, hex: have.hex };
    if (await vaultLocked()) return { ok: false, error: "Your node's keys are locked, so it can't make a new address. Unlock your node (Vault), then try again." };
    const r = await call("newaddress");
    if (r && r.pending === true) return { ok: false, error: "The embedded node did not authorize the request. Check its status before retrying." };
    const resp = (r && r.response) || {}, mx = String(resp.miniaddress || ""), hex = String(resp.address || "");
    if (!validMx(mx) || !validHexAddr(hex) || mxToHex(mx) !== "0x" + hex.slice(2).toUpperCase()) return { ok: false, error: r && r.error ? "Couldn't make a fresh address on this node. (" + r.error + ")" : "Couldn't make a fresh address on this node." };
    kv().set(K.CLEAN_ADDR, JSON.stringify({ mx, hex }));
    scriptsCache = null;   // a new row in the script table
    activity("info", "Clean same-node destination set | address:" + mx);
    return { ok: true, value: mx, hex };
  }

  // ---- lock (Guardian.createFutureCash, with the screen's recipient rules) ----
  /**
   * Lock `amount` MINIMA until tip + blocks, payable only to the recipient (blank = a fresh clean address of this node,
   * never a reused default). The amount is shape-checked and sent as typed (never through a number). → { ok, matBlock,
   * payout, command } or { ok: false, error }.
   */
  function lock(amount, blocks, recipient) { return exclusive(() => lockNow(amount, blocks, recipient)); }
  async function lockNow(amount, blocks, recipient) {
    if (!store) return { ok: false, error: "Future Cash Next has not started yet." };
    const amt = String(amount == null ? "" : amount).trim(), rcp = String(recipient == null ? "" : recipient).trim();
    if (!AMOUNT.test(amt) || toUnits(amt) <= 0n) return { ok: false, error: "Enter a positive amount." };
    const n = Number(blocks);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 100000000) return { ok: false, error: "Pick a maturity time in the future." };
    let payout;
    if (!rcp) { const c = await cleanAddress(); if (!c.ok) return c; payout = c.hex; }
    else if (HEX64.test(rcp)) payout = rcp;
    else if (validMx(rcp)) payout = mxToHex(rcp);
    if (!payout || !HEX64.test(payout)) return { ok: false, error: "Couldn't resolve that recipient address." };
    const contract = await contractAddress();
    if (!contract) return { ok: false, error: "Could not register the FutureCash contract." };
    const t = await tip();
    if (!t) return { ok: false, error: "Could not read the chain tip." };
    const mat = t + n;
    const st = "{\"0\":\"0xFF\",\"1\":\"" + mat + "\",\"2\":\"" + payout + "\",\"3\":\"" + now() + "\",\"4\":\"" + n + "\"}";
    const cmd = await pinMinimaSend(o.run, "send amount:" + amt + " address:" + contract + " state:" + st, { minCoinage: 3, owner: "futurecash" });
    const r = await call(cmd);
    if (r && r.pending === true) return { ok: false, error: "The embedded node did not authorize the request. Check its status before locking again." };
    if (!ok(r)) return { ok: false, error: (r && r.error) || "no reply from Minima Core" };
    activity("info", "Locked " + amt + " · matures block " + mat + " | to:" + payout);
    return { ok: true, matBlock: mat, payout, amount: amt };
  }

  // ---- one thing at a time: a pass and every action the screens ask for share this turn ----
  let turn = Promise.resolve();
  function exclusive(fn) { const p = turn.then(fn, fn); turn = p.then(() => {}, () => {}); return p; }

  // ---- transactions (Tx.java) ----
  let seq = 0;
  const stage = (c) => String(c).split(" ")[0];
  /** Node.coinState: "gone" (rolled back by a reorg) kept apart from "spent". */
  async function coinState(id) {
    const r = await call("coins coinid:" + id);
    if (!ok(r) || !Array.isArray(r.response)) return "UNKNOWN";
    if (!r.response.length) return "GONE";
    return r.response[0] && r.response[0].spent === true ? "SPENT" : "UNSPENT";
  }
  /**
   * Tx.run: the steps in order, each checked before the next; the sign gate asked before the step that signs and the
   * step that posts; txndelete on EVERY path. A reply with no boolean status is an unknown outcome, never a success.
   * txnpost's status:true is the post, not the confirmation (mining is asynchronous): the coin's state decides later.
   */
  async function runTx(kind, steps, plan) {
    const id = "FC" + kind + now() + "_" + (++seq % 1000000);
    try {
      for (const step of steps) {
        const c = step.split("%ID%").join(id), verb = stage(c);
        if (plan && (verb === "txnsign" || verb === "txnpost")) {
          const t = await call("txnlist id:" + id), txn = ok(t) && t.response && t.response.transaction;
          const v = txn ? gateCheck(txn, plan) : { ok: false, why: "the node could not show the transaction" };
          if (!v.ok) {
            activity("error", "Refused by the sign gate before " + verb + ": " + v.why + " | coin:" + plan.coinid);
            log("SIGN GATE REFUSED " + verb + " of " + id + ": " + v.why + "; plan " + JSON.stringify(Object.assign({}, plan, { own: undefined, mayMove: undefined })) + "; the node's transaction " + JSON.stringify(txn || t));
            return { ok: false, error: "Refused before signing: " + v.why + ". Nothing was " + (verb === "txnsign" ? "signed" : "posted") + ".", refused: true };
          }
        }
        const r = await call(c);
        if (r == null) return { ok: false, error: "Minima Core didn't respond (at " + verb + ")" };
        if (typeof r.status !== "boolean") return { ok: false, error: "Couldn't read Minima Core's reply to " + verb + " — it may have succeeded. Check the Activity log before retrying." };
        if (r.pending === true) return { ok: false, error: "The embedded node did not authorize the request. Check its status before retrying.", notPaired: true };
        if (r.status !== true) return { ok: false, error: (r.error ? String(r.error) : "failed") + " (at " + verb + ")" };
      }
      return { ok: true };
    } finally { await call("txndelete id:" + id); }
  }
  /** Tx.checkParts: nothing malformed reaches a command (a coin at the shared contract carries anyone's state). */
  function parts(coinid, address, amount, tokenid) {
    if (!HEX64.test(String(coinid))) return "Refusing to spend a malformed coin id.";
    if (!validAddr(address)) return "This payment's destination looks malformed — refusing.";
    if (!/^0x[0-9a-fA-F]{2,64}$/.test(String(tokenid))) return "This payment's token id looks malformed — refusing.";
    if (!AMOUNT.test(String(amount))) return "This payment's amount looks malformed — refusing.";
    if (toUnits(amount) === 0n) return "Refusing to post a zero-amount output — the coin's amount didn't parse.";
    return "";
  }
  /** Tx.collect: no signature (the contract pins the payout); create, input, output, basics, post. */
  async function collectTx(coinid, payout, amount, tokenid, sets) {
    const bad = parts(coinid, payout, amount, tokenid);
    if (bad) return { ok: false, error: bad };
    return runTx("COL", ["txncreate id:%ID%", "txninput id:%ID% coinid:" + coinid, "txnoutput id:%ID% address:" + payout + " amount:" + amount + " tokenid:" + tokenid + " storestate:false",
      "txnbasics id:%ID%", "txnpost id:%ID%"], { kind: "collect", coinid, tokenid, amount, to: payout, contracts: contracts(), own: (a) => owns(sets, a) });
  }

  // ---- collect by hand (Guardian.collectNow) ----
  /** One matured stake, now. Refused for an at-risk payout (the rescue owns those) and without a usable audit. */
  function collectNow(coinid) { return exclusive(() => collectOne(coinid)); }
  async function collectOne(coinid) {
    const err = (e) => ({ ok: false, error: e });
    if (!store) return Object.assign(err("Future Cash Next has not started yet."), { stop: true });
    if (!HEX64.test(String(coinid))) return err("Not a valid coin id.");
    const t = await tip(), r = await call("coins coinid:" + coinid);
    if (!ok(r) || !Array.isArray(r.response)) return err("Could not read the complete stake list. Refresh and retry.");
    const coin = r.response.find(c => c && lc(c.coinid) === lc(coinid) && c.spent !== true);
    if (!coin) return err("Stake not found — it may already be collected.");
    if (!isStake(coin, contracts())) return err("Not a FutureCash stake.");
    if (!matured(coin, t)) return err("Not matured yet — unlocks at block " + state(coin, ST_FUTUREBLOCK) + " (now " + t + ").");
    const payout = state(coin, ST_RECIPIENT), sets = await scriptTable(false);
    if (!owns(sets, payout)) return err("That stake doesn't pay out to this node — it isn't yours to collect.");
    loadAtRisk(sets);
    if (atRisk.has(canon(payout))) return err("This stake pays out to an at-risk address — the Guardian rescues it with collect + sweep instead. Set up rescue on the Guardian tab.");
    if (!(await verdict()).ok) return Object.assign(err("Run a key audit first, then collect."), { stop: true });
    const amount = outAmount(coin), tokenid = String(coin.tokenid || "0x00"), id = String(coin.coinid);
    // recorded as posted BEFORE the post (an atomic claim): a pass running next sees it, and Quit, Freeze and a wallet
    // replacement know a collect is out until the chain says how it ended
    if (!store.collectExists(id)) store.insertCollect(id, payout, tokenid, amount, num(state(coin, ST_FUTUREBLOCK)), false);
    if (!store.claimForPost(id, S.COLLECT_POSTED_SAFE, t)) return err("This stake is already being collected.");
    const res = await collectTx(id, payout, amount, tokenid, sets);
    if (!res.ok) { store.setCollectStatus(id, S.DETECTED); return Object.assign(err(res.error), { stop: !!res.notPaired }); }
    activity("info", "Manual collect posted: " + amount + " | stake:" + id + " | to:" + payout);
    return { ok: true, amount };
  }
  /** Collect all now: every ready stake on a clean payout; a refusal that would stop every other one stops the loop. */
  function collectAll() {
    return exclusive(async () => {
      let done = 0, last = null;
      const list = (await stakesRead()).stakes;
      for (const st of list) {
        if (!st.ready || st.atRisk) continue;
        const r = await collectOne(st.coinid);
        if (r.ok) done++;
        else { last = r.error; if (r.stop) break; }   // a blocking condition fails every remaining stake the same way
      }
      return { ok: done > 0, done, error: done ? null : (last || "Nothing to collect.") };
    });
  }

  // ---- reconcile (Guardian.collectMatured's first half, reconcileCollects) ----
  /** A DETECTED stake gone from the scan: spent means collected (by this app or anyone: the contract paid its payout). */
  async function settleDetected(seen, budget) {
    for (const row of store.collects(S.DETECTED)) {
      if (seen.has(lc(row.coinid))) continue;
      if (budget.reads-- <= 0) return;
      const st = await coinState(row.coinid);
      // the native sets COLLECTED here whatever the payout, so a clean stake collected by hand was then swept too; on the
      // desktop a clean payout ends as COLLECTED_SAFE: only an at-risk payout is ever queued for a sweep
      if (st === "SPENT") store.setCollectStatus(row.coinid, row.atRisk ? S.COLLECTED : S.COLLECTED_SAFE);
    }
  }
  async function reconcileCollects(t, budget) {
    for (const row of store.collects(S.COLLECT_POSTED, S.COLLECT_POSTED_SAFE)) {
      if (budget.reads-- <= 0) return;
      const safe = row.status === S.COLLECT_POSTED_SAFE && !row.atRisk, st = await coinState(row.coinid);
      if (st === "SPENT") {
        store.setCollectStatus(row.coinid, safe ? S.COLLECTED_SAFE : S.COLLECTED);
        if (safe) notify("Future Cash", "Collected " + row.amount + " safely");
        activity("info", "Collected " + row.amount + (safe ? " [safe]" : " [rescue → sweeping next]") + " | stake:" + row.coinid + " | on:" + row.payout);
        continue;
      }
      if (t - row.collectBlock >= RETRY_BLOCKS) {
        store.setCollectStatus(row.coinid, S.DETECTED);
        if (row.attempts === MAX_ATTEMPTS) { notify("Future Cash", "A collection keeps failing — check this node"); activity("error", "Collect still failing after " + row.attempts + " tries | stake:" + row.coinid + " | to:" + row.payout); }
        else activity("warn", "Collect retry scheduled | stake:" + row.coinid + " | to:" + row.payout);
      }
    }
  }
  function notify(title, body) { try { if (store && store.kv.is(K.NOTIFY, true) && o.notify) o.notify(title, body); } catch (e) {} }

  // ---- detection (Guardian.detect) ----
  async function detect(sets) {
    const seen = new Map();
    for (const c of await scan(sets)) {
      const id = String(c.coinid), payout = state(c, ST_RECIPIENT), mature = num(state(c, ST_FUTUREBLOCK)), risk = atRisk.has(canon(payout));
      seen.set(lc(id), c);
      if (store.collectExists(id)) { store.refreshCollect(id, mature, risk); store.reArmAfterReorg(id); }
      else { const amt = outAmount(c); store.insertCollect(id, payout, String(c.tokenid || "0x00"), amt, mature, risk); activity("info", "Detected FutureCash (" + amt + ")" + (risk ? " [AT RISK]" : "") + " | stake:" + id + " | to:" + payout); }
    }
    return seen;
  }

  // ---- the rescue destination (Wallet.setSafeSameNode / setSafeExternal / safeUsable / sweepDestination) ----
  const sameNode = () => kv().get(K.SAFE_MODE, "external") === "samenode";
  /** Cfg.rescueReady: a destination and rescue on (the precondition for running the guardian at all). */
  const rescueReady = () => !!store && validMx(kv().get(K.SAFE_ADDRESS, null)) && kv().is(K.ENABLED, false);
  function safeUsable(safe, sets) {
    if (!validMx(safe)) return false;
    return sameNode() ? !atRisk.has(canon(safe)) : !sets.tracked.has(canon(safe));
  }
  /** AuditRunner.checkOne: >0 reused, 0 clean, -1 unknown (the audit host could not say; accepted, re-checked by every audit). */
  async function reuseOf(addr) {
    const hex = validMx(addr) ? mxToHex(addr) : addr;
    if (!HEX64.test(String(hex))) return -1;
    let j = null; try { j = await o.get(keyuses.BASE + "/reuse?addrs=" + encodeURIComponent(hex)); } catch (e) {}
    const row = j && j.status === true ? keyuses.parseReuse(j.results).find(x => lc(x.address) === lc(hex)) : null;
    return row ? (row.reused ? Math.max(1, row.reuseCount) : 0) : -1;
  }
  function setSafeSameNode() {
    return exclusive(async () => {
      if (!store) return { ok: false, error: "Future Cash Next has not started yet." };
      const r = await cleanAddress();
      if (!r.ok) return r;
      kv().set(K.SAFE_MODE, "samenode"); kv().set(K.SAFE_ADDRESS, r.value); kv().setBool(K.ENABLED, true);
      activity("info", "Safe destination = a fresh same-node address | address:" + r.value);
      activity("info", "At-risk rescue ENABLED");
      return { ok: true, value: r.value };
    });
  }
  function setSafeExternal(addr) {
    return exclusive(async () => {
      if (!store) return { ok: false, error: "Future Cash Next has not started yet." };
      const a = String(addr == null ? "" : addr).trim();
      if (!validMx(a) || !mxToHex(a)) return { ok: false, error: "Not a valid Mx address (must start with Mx)." };
      const count = await reuseOf(a);
      if (count > 0) return { ok: false, error: "That address has already signed " + count + " time(s) — its key is reused. Sweeping your rescued money there would move it onto another exposed key. Use a fresh address from a clean wallet." };
      const local = "That address belongs to THIS node. Use an EXTERNAL wallet (a different node/seed) with fresh keys.";
      const sets = await scriptTable(true);
      if (sets.tracked.has(canon(a)) || hasOwnKey(await scriptRow(a))) return { ok: false, error: local };
      kv().set(K.SAFE_MODE, "external"); kv().set(K.SAFE_ADDRESS, a);
      setSafeReused("", 0);   // a flag of the previous destination described that one, not this
      kv().setBool(K.ENABLED, true);
      activity("info", (count === 0 ? "Safe address set (external), verified clean" : "Safe address set (external) — reuse check UNVERIFIED, will re-check") + " | address:" + a);
      activity("info", "At-risk rescue ENABLED");
      return { ok: true, value: a, verified: count === 0 };
    });
  }
  function stopRescue() { return exclusive(async () => { kv().setBool(K.ENABLED, false); activity("info", "At-risk rescue DISABLED"); return { ok: true }; }); }
  function setFlag(key, on) { return exclusive(async () => { kv().setBool(key, !!on); return { ok: true }; }); }
  /** The guardian on or off. On needs a destination and the grant (o.granted: the one native question, asked by main.js). */
  function setGuardian(on) {
    return exclusive(async () => {
      if (!store) return { ok: false, error: "Future Cash Next has not started yet." };
      if (!on) { kv().setBool(K.GUARDIAN_ON, false); activity("info", "Guardian stopped"); return { ok: true }; }
      if (!rescueReady()) return { ok: false, needsRescue: true, error: "Pick where rescued funds should go — the guardian needs a destination." };
      if (!granted()) return { ok: false, needsGrant: true, error: "Background signing is not allowed on this computer." };
      kv().setBool(K.GUARDIAN_ON, true); activity("info", "Guardian started");
      return { ok: true };
    });
  }
  const granted = () => { try { return !!(o.granted && walletKey && o.granted(walletKey)); } catch (e) { return false; } };
  /** Is the guardian allowed to act now: switched on, a destination, the grant, and not paused (Freeze). */
  const running = () => !!store && kv().is(K.GUARDIAN_ON, false) && rescueReady() && granted();
  /** Wallet.sweepDestination: the configured EXTERNAL safe while rescue is on, else a fresh clean address of this node. */
  async function sweepDestination() {
    const safe = kv().get(K.SAFE_ADDRESS, "");
    if (kv().is(K.ENABLED, false) && !sameNode() && validMx(safe)) return { ok: true, value: safe };
    return cleanAddress();
  }

  // ---- sweeping (Tx.sweep, Wallet.signKeyFor / sweepAddressToClean) ----
  /** The key an address signs with, from its SIGNEDBY script ("auto" only while the row still has its real key). */
  async function signKeyFor(addr) {
    const row = await scriptRow(addr);
    if (!row) return null;
    const m = /SIGNEDBY\((0x[0-9a-fA-F]+)\)/i.exec(String(row.script || ""));
    if (m) return m[1];
    return row.publickey && row.publickey !== "0x00" ? "auto" : null;
  }
  /** Tx.sweep: one coin, whole, to the destination; signed with the address's real key; checked before the signature and the post. */
  async function sweepTx(coinid, from, dest, amount, tokenid, signKey, sets) {
    const bad = parts(coinid, dest, amount, tokenid);
    if (bad) return { ok: false, error: bad };
    if (signKey !== "auto" && !validHexAddr(signKey)) return { ok: false, error: "Refusing to sign with a malformed public key." };
    // the only places a sweep may pay: the configured safe destination, or this node's own minted clean address
    const c0 = cleanAddr(), allowed = [kv().get(K.SAFE_ADDRESS, ""), c0 && c0.mx, c0 && c0.hex].filter(Boolean).map(canon);
    if (!allowed.includes(canon(dest))) { activity("error", "Refused by the sign gate: " + dest + " is not the rescue destination | coin:" + coinid); return { ok: false, refused: true, error: "Refused before signing: " + dest + " is not the rescue destination. Nothing was signed." }; }
    return runTx("SWP", ["txncreate id:%ID%", "txninput id:%ID% coinid:" + coinid, "txnoutput id:%ID% address:" + dest + " amount:" + amount + " tokenid:" + tokenid + " storestate:false",
      "txnsign id:%ID% publickey:" + signKey, "txnbasics id:%ID%", "txnpost id:%ID%"],
      { kind: "sweep", coinid, tokenid, amount, from, to: dest, safe: dest, own: (a) => owns(sets, a), mayMove: (a) => atRisk.has(canon(a)) });
  }
  /** Coins on an address (Wallet.coinsAt), unspent. */
  async function coinsAt(addr) {
    if (!validAddr(addr)) return [];
    const r = await call("coins address:" + addr);
    return ok(r) && Array.isArray(r.response) ? r.response.filter(c => c && c.spent !== true && HEX64.test(String(c.coinid || ""))) : [];
  }

  // ---- the guardian's work (Guardian.collectMatured, detectCollectedForSweep, detectStrandedForSweep, sweepPending, reconcileSweeps) ----
  async function collectMatured(t, seen, autoSafe, rescueOn, auditOk, canSweep, sets, budget) {
    for (const row of store.collects(S.DETECTED)) {
      if (!owns(sets, row.payout)) { store.deleteCollect(row.coinid); continue; }   // ownership checked again here, never only at detect
      const coin = seen.get(lc(row.coinid));
      if (!coin || !matured(coin, t)) continue;
      const bareSafe = !row.atRisk && auditOk && autoSafe, toSweep = row.atRisk && rescueOn && canSweep;
      if (!bareSafe && !toSweep) continue;   // can't act safely yet: left in the contract, where it is not at risk
      if (budget.posts-- <= 0) return;
      if (!store.claimForPost(row.coinid, bareSafe ? S.COLLECT_POSTED_SAFE : S.COLLECT_POSTED, t)) continue;
      const res = await collectTx(row.coinid, row.payout, row.amount, row.tokenid, sets);
      if (res.ok) {
        notify("Future Cash", "Collecting matured " + row.amount + (bareSafe ? "" : " — will sweep to safe"));
        activity("info", "Collecting " + row.amount + (bareSafe ? " [safe]" : " [rescue]") + " | stake:" + row.coinid + " | to:" + row.payout);
      } else activity("error", "Collect post failed | stake:" + row.coinid + " | to:" + row.payout + " — " + res.error);
      if (res.refused) store.setCollectStatus(row.coinid, S.DETECTED);
    }
  }
  async function detectCollectedForSweep(budget) {
    const claimed = new Set(store.sweepIds().map(lc));
    for (const row of store.collects(S.COLLECTED)) {
      if (budget.reads-- <= 0) return;
      const r = await call("coins address:" + row.payout + " checkmempool:true");
      const found = (ok(r) && Array.isArray(r.response) ? r.response : []).find(c => c && c.spent !== true && HEX64.test(String(c.coinid || "")) && !claimed.has(lc(c.coinid))
        && lc(c.tokenid) === lc(row.tokenid) && decEq(outAmount(c), row.amount) && !(num(c.created) > 0 && num(c.created) < row.collectBlock));
      if (!found) continue;
      claimed.add(lc(found.coinid));
      store.insertSweep(String(found.coinid), String(found.address || row.payout), String(found.tokenid || "0x00"), outAmount(found));
      store.setCollectStatus(row.coinid, S.SWEEP_QUEUED);
      activity("info", "Queued " + outAmount(found) + " for sweep to safe | coin:" + found.coinid + " | on:" + (found.address || ""));
    }
  }
  async function detectStrandedForSweep(sets, budget) {
    const claimed = new Set(store.sweepIds().map(lc));
    for (const addr of sets.retired) {
      if (budget.reads-- <= 0) return;
      for (const c of await coinsAt(addr)) {
        if (claimed.has(lc(c.coinid))) continue;
        claimed.add(lc(c.coinid));
        store.insertSweep(String(c.coinid), addr, String(c.tokenid || "0x00"), outAmount(c));
        activity("info", "Stranded " + outAmount(c) + " | coin:" + c.coinid + " | on retired:" + addr + " — queued to sweep to safe");
      }
    }
  }
  async function sweepPending(t, safe, sets, budget) {
    for (const row of store.sweeps(S.PENDING)) {
      const key = await signKeyFor(row.address);
      if (!owns(sets, row.address) || !key) { activity("error", "Can't sweep — no signing key for this address on this node | coin:" + row.coinid + " | on:" + row.address); continue; }
      if (budget.posts-- <= 0) return;
      if (!store.claimSweepForPost(row.coinid, t)) continue;
      const res = await sweepTx(row.coinid, row.address, safe, row.amount, row.tokenid, key, sets);
      if (res.ok) activity("info", "Sweeping " + row.amount + " | coin:" + row.coinid + " | from:" + row.address + " | to:" + safe);
      else { activity("error", "Sweep post failed | coin:" + row.coinid + " | from:" + row.address + " — " + res.error); if (res.refused) store.setSweepStatus(row.coinid, S.PENDING, null); }
      syncHolds();
    }
  }
  /** Did our swept output arrive? {reliable, coinid}. Only a same-node safe can be looked at (an external one is never tracked). */
  async function arrived(safe, row) {
    const used = new Set(store.sweepNotes().map(lc)), c0 = cleanAddr(), lookup = sameNode() && c0 ? c0.hex : safe;
    const r = await call("coins address:" + lookup + " tokenid:" + row.tokenid);
    if (!ok(r) || !Array.isArray(r.response)) return { reliable: false, coinid: null };
    const hit = r.response.find(c => c && HEX64.test(String(c.coinid || "")) && !used.has(lc(c.coinid)) && !(c.spent === true && !sameNode()) && lc(c.tokenid) === lc(row.tokenid)
      && decEq(outAmount(c), row.amount) && !(num(c.created) > 0 && num(c.created) < row.sweepBlock));
    return { reliable: true, coinid: hit ? String(hit.coinid) : null };
  }
  function markSwept(row, out, safe, t) {
    store.setSweepStatus(row.coinid, S.SWEPT, out);
    kv().set(K.LAST_ACTION, "Secured " + row.amount + " to safe @block " + t);
    notify("Future Cash", "Secured " + row.amount + " to your safe address");
    activity("info", "Secured " + row.amount + " | coin:" + row.coinid + " | to:" + safe);
  }
  async function reconcileSweeps(t, safe, budget) {
    const canVerify = validMx(safe) && sameNode();
    for (const row of store.sweeps(S.SWEEP_POSTED)) {
      if (budget.reads-- <= 0) return;
      const st = await coinState(row.coinid);
      if (st === "GONE") {   // the collect that made this coin was rolled back: nothing swept, nothing stolen
        store.deleteSweep(row.coinid);
        activity("warn", "Sweep abandoned — the collected coin was rolled back by a chain reorg; the stake will be collected again | coin:" + row.coinid + " | on:" + row.address);
        continue;
      }
      if (st === "SPENT") {
        if (!canVerify) { markSwept(row, null, safe, t); continue; }
        const a = await arrived(safe, row);
        if (a.coinid) { markSwept(row, a.coinid, safe, t); continue; }
        if (a.reliable && t - row.sweepBlock >= VERIFY_GRACE) {
          store.setSweepStatus(row.coinid, S.TAKEN, null);
          notify("Future Cash ⚠️", "A collected stake (" + row.amount + ") was spent but did NOT reach your safe address. Your old key may be compromised — check now.");
          activity("error", "⚠️ ALERT: a collected stake was spent but NOT seen at your safe — check for key-reuse loss | coin:" + row.coinid + " | from:" + row.address);
          continue;
        }
        if (!a.reliable && t - row.sweepBlock >= VERIFY_MAX) {
          store.setSweepStatus(row.coinid, S.SWEPT, "unverified");
          notify("Future Cash", "A stake was spent but the node couldn't confirm it reached your safe address — please verify it arrived.");
          activity("warn", "Sweep spent but UNVERIFIED — please check it arrived | coin:" + row.coinid + " | from:" + row.address);
        }
        continue;
      }
      if (t - row.sweepBlock >= RETRY_BLOCKS) {
        store.setSweepStatus(row.coinid, S.PENDING, null);
        if (row.attempts === MAX_ATTEMPTS) { notify("Future Cash", "A sweep keeps failing — funds still on an exposed address. Is your vault unlocked?"); activity("error", "Sweep still failing after " + row.attempts + " tries | coin:" + row.coinid + " | from:" + row.address); }
        else activity("warn", "Sweep retry scheduled | coin:" + row.coinid + " | from:" + row.address);
      }
    }
  }

  // ---- Harden and Recover, by hand (Wallet.reusedDefaults, retireAddress, sweepAddressToClean, recoverRetiredCoins) ----
  /** This node's own reused addresses (the audit's at-risk list), each with whether it is still a default and its coins. */
  function harden() {
    return exclusive(async () => {
      if (!store) return { list: [], stuck: [] };
      const sets = await scriptTable(true); loadAtRisk(sets);
      let flagged = []; try { flagged = JSON.parse(kv().get(K.ATRISK_ADDRS, "[]")); } catch (e) {}
      const list = [], seenHex = new Set();
      for (const a of Array.isArray(flagged) ? flagged : []) {
        if (!validAddr(a)) continue;
        const row = await scriptRow(a);
        if (!row || !row.address || seenHex.has(lc(row.address))) continue;
        seenHex.add(lc(row.address));
        if (!(row.publickey && row.publickey !== "0x00") && !/SIGNEDBY\(/i.test(String(row.script || ""))) continue;   // only OUR addresses
        const coins = await coinsAt(row.address);
        list.push({ hex: String(row.address), mx: String(row.miniaddress || ""), isDefault: row.default === true, coins: coins.length,
          balance: sum(coins.filter(c => lc(c.tokenid) === "0x00").map(c => c.amount)) });
      }
      const stuck = [];
      for (const a of sets.retired) { const n = (await coinsAt(a)).length; if (n) stuck.push({ address: a, coins: n }); }
      return { list, stuck, retired: store.retired() };
    });
  }
  /** Wallet.addressHasStakes: a refusal gate, so it over-detects on purpose (the chain-wide contract read is a click, never a block). */
  async function addressHasStakes(addr) {
    const row = await scriptRow(addr), targets = new Set([canon(addr), canon(row ? row.address : addr)]);
    const scanFor = (r) => (r && Array.isArray(r.response) ? r.response : []).some(c => c && c.spent !== true && looksLikeFutureCash(c) && targets.has(canon(state(c, ST_RECIPIENT))));
    for (const c of contracts()) {
      const mine = await call("coins relevant:true address:" + c), all = await call("coins address:" + c);
      if (!ok(mine) || !ok(all)) return true;   // not known: refused as if a stake paid there
      if (scanFor(mine) || scanFor(all)) return true;
    }
    return false;
  }
  /**
   * Retire ONE reused default address: never while a stake pays to it, while it holds coins, while it would leave fewer
   * than MIN_DEFAULTS_KEEP defaults; and (the desktop's own rule) only while the guardian runs with a destination and the
   * grant, so that anything paid to it later is swept off at once. Recorded in fc_retired.
   */
  function retire(addr) {
    return exclusive(async () => {
      const err = (e) => ({ ok: false, error: e });
      if (!store) return err("Future Cash Next has not started yet.");
      if (!validAddr(addr)) return err("Invalid address.");
      if (!running()) return err("Start the guardian first: a retired address can still be paid, and only the running guardian moves what arrives there to your safe address.");
      if (await addressHasStakes(addr)) return err("Stakes still pay out to this address — they'd land here when they mature and get stuck on the nulled key. Leave it live; the guardian keeps sweeping.");
      const row = await scriptRow(addr);
      if (!row) return err("Address not found on this node.");
      if (row.default !== true) return err("Not an active default change address (already retired, or not one of yours).");
      const script = String(row.script || "");
      if (!/^RETURN SIGNEDBY\(0x[0-9a-fA-F]{64}\)$/i.test(script.replace(/\s+/g, " ").trim()) || script.includes('"')) return err("Unexpected script for a default address — not retiring.");
      let flagged = []; try { flagged = JSON.parse(kv().get(K.ATRISK_ADDRS, "[]")); } catch (e) {}
      if (!(Array.isArray(flagged) ? flagged : []).some(a => canon(a) === canon(row.address))) return err("Only an address the key audit found at risk is retired here.");
      const hex = String(row.address), r = await call("coins address:" + hex);
      if (!ok(r) || !Array.isArray(r.response)) return err("Couldn't check this address's coins right now — try again in a moment.");
      const unspent = r.response.filter(c => c && c.spent !== true).length;
      if (unspent > 0) return err("This address still holds " + unspent + " coin(s). Sweep them to safety first (they're on an exposed key), then retire it.");
      const sets = await scriptTable(true), defaults = sets.rows.filter(x => x && x.default === true).length;
      if (defaults <= MIN_DEFAULTS_KEEP) return err("Keep at least " + MIN_DEFAULTS_KEEP + " change addresses. Restart your node to generate fresh clean ones, then retire more.");
      const n = await call("newscript trackall:true script:\"" + script + "\"");
      scriptsCache = null;
      if (n && n.pending === true) return err("The embedded node did not authorize the request. Check its status before retrying.");
      if (!ok(n)) return err((n && n.error) || "command failed");
      const v = await scriptRow(hex);
      if (v && v.default === true) return err("Retire didn't take effect — the address is still a default.");
      store.addRetired(hex, String(row.miniaddress || ""), script, lastTip);
      activity("info", "Retired a reused default address — off the change rotation, kept watch-only | address:" + hex);
      return { ok: true, value: hex };
    });
  }
  /** Every coin off one of this wallet's at-risk or retired addresses, to the rescue destination, one signature per coin. */
  async function sweepAddressNow(addr) {
    const rep = { ok: false, swept: 0, failed: 0, dest: null, error: null };
    if (!validAddr(addr)) { rep.error = "Invalid address."; return rep; }
    const row = await scriptRow(addr);
    if (!row) { rep.error = "Address not found on this node."; return rep; }
    if (!(row.publickey && row.publickey !== "0x00") && !/SIGNEDBY\(/i.test(String(row.script || ""))) { rep.error = "That isn't one of your signable addresses."; return rep; }
    const from = String(row.address), key = await signKeyFor(from);
    if (!key) { rep.error = "This node has no signing key for that address — it can't be swept from here."; return rep; }
    const sets = await scriptTable(true); loadAtRisk(sets);
    if (!atRisk.has(canon(from))) { rep.error = "Only an address the key audit found at risk, or a retired one, is swept here."; return rep; }
    const dest = await sweepDestination();
    if (!dest.ok) { rep.error = dest.error; return rep; }
    const c0 = cleanAddr();
    if (canon(dest.value) === canon(from) || (c0 && canon(c0.hex) === canon(from))) { rep.error = "Destination equals the source address."; return rep; }
    rep.dest = dest.value;
    for (const c of await coinsAt(from)) {
      const id = String(c.coinid), amount = outAmount(c), tok = String(c.tokenid || "0x00");
      store.insertSweep(id, from, tok, amount);
      if (!store.claimSweepForPost(id, lastTip)) continue;   // the guardian has it
      syncHolds();
      const r = await sweepTx(id, from, dest.value, amount, tok, key, sets);
      if (r.ok) { rep.swept++; activity("info", "Swept " + amount + " | coin:" + id + " | from:" + from + " | to safe:" + dest.value); }
      else {
        store.deleteSweep(id); syncHolds();
        if (r.notPaired) { rep.error = r.error; return rep; }
        rep.failed++; rep.error = r.error; activity("warn", "Couldn't sweep | coin:" + id + " | on:" + from + " — " + r.error);
      }
    }
    rep.ok = rep.swept > 0 || (!rep.failed && !rep.error);
    activity("info", "Swept " + rep.swept + " coin(s) off a reused address" + (rep.failed ? " (" + rep.failed + " failed)" : "") + " | from:" + from + " | to:" + rep.dest);
    return rep;
  }
  const sweepAddress = (addr) => exclusive(() => sweepAddressNow(addr));
  function recoverRetired() {
    return exclusive(async () => {
      const total = { ok: false, swept: 0, failed: 0, dest: null, error: null };
      const sets = await scriptTable(true);
      for (const a of sets.retired) {
        if (!(await coinsAt(a)).length) continue;
        const r = await sweepAddressNow(a);
        total.swept += r.swept; total.failed += r.failed; total.dest = r.dest || total.dest;
        if (r.error && !r.swept) total.error = r.error;
      }
      total.ok = total.swept > 0 || !total.error;
      return total;
    });
  }
  /** Store.resetHistory and the log: completed records only; in-flight work and the destination stay. */
  function resetHistory() { return exclusive(async () => { store.resetHistory(); kv().set(K.LOG, "[]"); return { ok: true }; }); }
  function syncHolds() {}

  // ---- the pass ----
  /**
   * One pass on a new block: what is staked to this wallet is recorded (detect), and what was posted is followed to its
   * end (reconcile). It COLLECTS and SWEEPS only while the guardian runs: switched on, a destination, and the grant
   * (running()); otherwise it reads. Each transaction it posts passes the sign gate.
   */
  function pass(t) {
    if (!store || passing) return passing || Promise.resolve(false);
    passing = exclusive(async () => {
      try {
        if (!store) return false;
        if (!t) t = await tip();
        if (!t) return false;
        lastTip = t; kv().set(K.LAST_TIP, String(t));
        const sets = await scriptTable(false), budget = { reads: CAP_READS, posts: CAP_POSTS };
        loadAtRisk(sets);
        const seen = await detect(sets);
        const go = running(), rescueOn = kv().is(K.ENABLED, false), safe = kv().get(K.SAFE_ADDRESS, null);
        // rescue needs a usable destination AND an unlocked vault, both known BEFORE an at-risk stake is collected
        let canSweep = false, vault = false;
        if (go && rescueOn && safe && safeUsable(safe, sets)) {
          vault = await vaultLocked();
          if (vault) { if (!lockSaid) { lockSaid = true; activity("warn", "Vault locked — rescue paused until you unlock it"); } }
          else { lockSaid = false; canSweep = true; }
        }
        vaultWasLocked = vault;
        const badSafe = safeIsReused(safe);
        if (go && !(canSweep && !badSafe) && !vault) {
          if (!offSaid) {
            offSaid = true;
            const why = badSafe ? "your safe destination is flagged as a REUSED address" : !safe ? "no safe destination is set" : "your safe destination is no longer usable";
            activity("error", "Rescue is OFF — " + why + ". At-risk stakes will be left locked in the contract (safe, but not collected) until you fix it.");
            notify("Future Cash: rescue is off", "The guardian can't move an at-risk stake to safety — " + why + ".");
          }
        } else offSaid = false;
        if (go) await collectMatured(t, seen, kv().is(K.AUTO_COLLECT_SAFE, false), rescueOn, (await verdict()).ok, canSweep && !badSafe, sets, budget);
        await settleDetected(seen, budget);
        await reconcileCollects(t, budget);
        if (go) await detectCollectedForSweep(budget);
        if (go && canSweep) { await detectStrandedForSweep(sets, budget); await sweepPending(t, safe, sets, budget); }
        await reconcileSweeps(t, safe, budget);
        syncHolds();
        return true;
      } catch (e) { activity("error", "Guardian pass failed — will retry next block: " + ((e && e.message) || e)); return false; }
    }).finally(() => { passing = null; });
    return passing;
  }

  // ---- the read model for the screens ----
  /** Guardian.listStakes: soonest unlock first. */
  function stakes() { return exclusive(stakesRead); }
  async function stakesRead() {
    if (!store) throw new Error("Future Cash Next has not started yet.");
    const t = await tip(), sets = await scriptTable(false);
    loadAtRisk(sets);
    const out = [];
    for (const c of await scan(sets)) {
      const payout = state(c, ST_RECIPIENT);
      out.push({ coinid: String(c.coinid), payout, amount: outAmount(c), tokenid: String(c.tokenid || "0x00"), matureBlock: num(state(c, ST_FUTUREBLOCK)),
        ready: matured(c, t), atRisk: atRisk.has(canon(payout)), node: owns(sets, payout) });
    }
    out.sort((a, b) => a.matureBlock - b.matureBlock);
    return { tip: t, stakes: out };
  }
  /** Guardian.status plus the settings the screens draw (Cfg), from the store only, and the verdict (may read keys). */
  async function status() {
    if (!store) return { started: false, error: openError || "", tip: lastTip };
    const k = store.kv, t = lastTip;
    const ready = (risk) => { const l = store.ready(t, risk); return { n: l.length, total: sum(l) }; };
    const pend = store.pendingRisk(t);
    let flagged = []; try { flagged = JSON.parse(k.get(K.ATRISK_ADDRS, "[]")); } catch (e) {}
    return {
      started: true, tip: t, walletKey,
      watching: store.count("collect", S.DETECTED), collecting: store.count("collect", S.COLLECT_POSTED) + store.count("collect", S.COLLECT_POSTED_SAFE),
      collectedSafe: store.count("collect", S.COLLECTED_SAFE), collected: store.count("collect", S.COLLECTED) + store.count("collect", S.SWEEP_QUEUED),
      sweeping: store.count("sweep", S.PENDING) + store.count("sweep", S.SWEEP_POSTED), swept: store.count("sweep", S.SWEPT), taken: store.count("sweep", S.TAKEN),
      readySafe: ready(false), readyRisk: ready(true),
      pendRisk: { n: pend.length, total: sum(pend.map(p => p.amount)), soonest: pend.length ? Math.min(...pend.map(p => p.mature)) : 0 },
      atRiskKnown: atRisk.size, atRiskList: Array.isArray(flagged) ? flagged.filter(validAddr) : [],
      guardianOn: k.is(K.GUARDIAN_ON, false), rescueOn: k.is(K.ENABLED, false), autoCollect: k.is(K.AUTO_COLLECT_SAFE, false), notify: k.is(K.NOTIFY, true),
      safe: k.get(K.SAFE_ADDRESS, ""), sameNode: k.get(K.SAFE_MODE, "external") === "samenode", safeReused: safeReused(),
      audit: { at: k.getLong(K.AUDIT_AT), ok: k.is(K.AUDIT_OK, false), error: k.get(K.AUDIT_LAST_ERR, "") || "", running: auditRunning, verdict: await verdict().catch(() => null), last: lastAudit },
      lastAction: k.get(K.LAST_ACTION, "") || "", contract: k.get(K.SCRIPT_ADDRESS, "") || "", granted: granted(), running: running(), vaultLocked: vaultWasLocked
    };
  }
  function activityLog() { try { const a = JSON.parse(kv().get(K.LOG, "[]")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

  return { start, stop, pass, stakes, status, audit, activity: activityLog, verdict, lock, registerContract, cleanAddress, collectNow, collectAll, setSafeSameNode, setSafeExternal, stopRescue, setGuardian, setFlag, harden, retire, sweepAddress, recoverRetired, resetHistory,
    rescueReady: () => { try { return rescueReady(); } catch (e) { return false; } },
    _store: () => store, _scripts: (f) => scriptTable(f), _atRisk: () => atRisk, _tip: tip, get walletKey() { return walletKey; } };
}

module.exports = { create, SCRIPT, KNOWN_ADDRESS, SECONDS_PER_BLOCK, K, S, CAP_POSTS, CAP_READS, SCRIPTS_EVERY, MIN_DEFAULTS_KEEP, FRESH_MS, MAX_MS,
  gateCheck, canon, mxToHex, scriptAddress, state, outAmount, sum, decEq, looksLikeFutureCash, isStake, matured, hasOwnKey, usesFingerprint, validAddr, validHexAddr, validMx };
