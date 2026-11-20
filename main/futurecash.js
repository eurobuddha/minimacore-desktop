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
const { toUnits, fromUnits } = require("./sendpin");

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
 * create(o): o = { run(cmd) -> the node's reply (rpcCall, owner "futurecash"), dir() -> userData, get(url) -> parsed JSON
 * or null (the audit host), log(line), notify(title, body), now() }.
 */
function create(o) {
  const now = o.now || Date.now, log = (l) => { try { o.log && o.log("[futurecash] " + l); } catch (e) {} };
  let store = null, walletKey = "", opening = null, startedAt = 0, openError = "";
  let scriptsCache = null;      // { block, rows, keys } — the node's script table and keys, read when needed
  const atRisk = new Set();
  let lastTip = 0, auditRunning = false, lastAudit = null, passing = null;

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
      } catch (e) { openError = (e && e.message) || String(e); log("could not start: " + openError); throw e; }
      finally { opening = null; }
    })();
    return opening;
  }
  /** The node stopped (or the app is frozen): a pass under way ends first, then the store is closed. */
  async function stop() {
    if (passing) await passing.catch(() => {});
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

  // ---- the pass ----
  /**
   * One pass on a new block. Read side only in this version: what is staked to this wallet is recorded (detect) for the
   * screens; nothing is posted.
   */
  function pass(t) {
    if (!store || passing) return passing || Promise.resolve(false);
    passing = (async () => {
      try {
        if (!t) t = await tip();
        if (!t) return false;
        lastTip = t; kv().set(K.LAST_TIP, String(t));
        const sets = await scriptTable(false);
        loadAtRisk(sets);
        await detect(sets);
        return true;
      } catch (e) { activity("error", "Guardian pass failed — will retry next block: " + ((e && e.message) || e)); return false; }
      finally { passing = null; }
    })();
    return passing;
  }

  // ---- the read model for the screens ----
  /** Guardian.listStakes: soonest unlock first. */
  async function stakes() {
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
      lastAction: k.get(K.LAST_ACTION, "") || "", contract: k.get(K.SCRIPT_ADDRESS, "") || ""
    };
  }
  function activityLog() { try { const a = JSON.parse(kv().get(K.LOG, "[]")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

  return { start, stop, pass, stakes, status, audit, activity: activityLog, verdict,
    _store: () => store, _scripts: (f) => scriptTable(f), _atRisk: () => atRisk, _tip: tip, get walletKey() { return walletKey; } };
}

module.exports = { create, SCRIPT, KNOWN_ADDRESS, SECONDS_PER_BLOCK, K, S, CAP_POSTS, CAP_READS, SCRIPTS_EVERY, MIN_DEFAULTS_KEEP, FRESH_MS, MAX_MS,
  canon, mxToHex, scriptAddress, state, outAmount, sum, decEq, looksLikeFutureCash, isStake, matured, hasOwnKey, usesFingerprint, validAddr, validHexAddr, validMx };
