/**
 * reserve.js — the ONE coin reservation every signer of this app shares (docs/COIN_RESERVATION.md).
 *
 * AtomiX, PandaPools, the Dexicon engine and the wallet's own commands spend from one wallet. The signing queue
 * (main/noderun.js) keeps their signatures apart in time; this keeps their COINS apart. main/rpc.js calls guard() for
 * every node command, inside the signing queue, with the caller's name (opts.owner; none = "wallet").
 *
 *   txns   coin id -> a coin named for a transaction: building (txninput), posting (txnpost sent, no answer yet), posted
 *   holds  coin id -> standing collateral (a live Dexicon FAST order's coins, its takes awaiting an answer)
 *
 * A coin another owner holds is refused at `txninput` before the node sees it, with the node's own failure shape
 * ({status:false, error}), so the builder's normal path deletes its transaction. ONLY A PLAIN WALLET COIN IS EVER
 * REFUSED: a contract coin (an HTLC lock, a pool reserve, a bet) is asked of the node first and always let through, so
 * a claim or a refund can never be starved (SETTLEMENT WINS, the doc).
 *
 * RELEASE: txndelete of an unposted transaction; a refused txninput; a txnpost the node rejects (status:false, not
 * pending); the coin spent (sweep); a posted transaction known dead (sweep: DEAD_BLOCKS and DEAD_MS after the post the
 * coin is still unspent and nothing in the mempool spends it); a build abandoned for BUILD_MS; the owner's engine
 * stopped (its builds only); the wallet replaced (everything, the file moved aside). txnpost answering ok is
 * asynchronous mining, NOT confirmation: a posted coin stays reserved until one of these.
 *
 * No network and no child process here: every node read goes through the function the caller passes.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUILD_MS = 15 * 60 * 1000;   // a `building` coin with no post and no delete for this long is an abandoned build
const DEAD_MS = 10 * 60 * 1000;    // known dead: this long AND this many blocks after the post, unspent, out of the mempool
const DEAD_BLOCKS = 12;
const SWEEP_READS = 25;            // coins asked of the node per sweep, round robin: a fragmented wallet is never listed
const SETTLES = new Set(["atomix", "casino"]);   // owners whose transactions settle against a deadline
const TXN_WHY = { atomix: "an AtomiX swap", pandapools: "a PandaPools transaction", dexicon: "a Dexicon trade", casino: "a P2P Chance transaction", wallet: "a transaction of the wallet" };
const HOLD_WHY = { dexicon: "Dexicon" };
const WATCH = /(?:^|;)\s*(?:txncreate|txninput|txnpost|txndelete|send|consolidate|coins)\b/i;
const MXUSD = "0x7d39745fbd29049be29850b55a18bf550e4d442f930f86266e34193d89042a90";
const tokenName = (t) => (lc(t) === "0x00" ? "MINIMA" : lc(t) === MXUSD ? "MxUSD" : "of token " + t);
/** An engine's own choice of inputs: its wallet coins of one token. Not a look at one coin or one address. */
const CHOICE_READ = (c) => /^\s*coins\b/i.test(c) && /\brelevant:true\b/i.test(c) && /\btokenid:/i.test(c) && !/\b(?:coinid|address):/i.test(c);

const lc = (s) => String(s == null ? "" : s).toLowerCase();
const verbOf = (c) => lc((/^\s*(\w+)/.exec(c) || [])[1]);
const param = (c, k) => { const m = new RegExp("(?:^|\\s)" + k + ":(\\S+)", "i").exec(c); return m ? m[1] : ""; };
const isCoin = (s) => /^0x[0-9a-f]{2,64}$/.test(s);
const refusal = (verb, why) => ({ command: verb, status: false, pending: false, error: why, reserved: true });
const rows = (r) => (r && r.status === true && Array.isArray(r.response) ? r.response : null);   // null: the node did not say

function createRegistry(o = {}) {
  const now = o.now || Date.now;
  const txns = new Map(), holds = new Map();
  const txOf = new Map();       // txn id -> { owner, posted, coins:Set }
  const sources = new Map();    // owner -> () => [{ coinid, why }]: where that owner's holds are read from
  const gone = new Map();       // coin ids the node no longer shows (a source that still lists one does not bring it back)
  let file = null, lastFile = null, opening = null, cursor = 0;
  const api = { onLog: o.log || null };
  const log = (line) => { try { if (api.onLog) api.onLog(String(line)); } catch (e) {} };

  // ---- the store ----
  function save() {
    if (!file) return;
    const tmp = file + ".tmp", body = JSON.stringify({ v: 1, txns: [...txns.values()], holds: [...holds.values()] });
    const fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  /** Written before the reserving command is forwarded. A disk that refuses is said once, and never stops a command. */
  let saveFailed = "";
  function persist() { try { save(); saveFailed = ""; } catch (e) { if (saveFailed !== e.message) { saveFailed = e.message; log("reservations could not be written (" + e.message + "): they are kept in memory only"); } } }
  function load() {
    let d = null;
    try { if (fs.existsSync(file)) d = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { const kept = require("./restore").moveAside(file); log("the reservation file could not be read (" + e.message + "): it is kept as " + kept + ", and an empty one is started"); }
    for (const r of (d && Array.isArray(d.txns) ? d.txns : [])) {
      if (!r || !isCoin(lc(r.coinid)) || !r.owner || !r.txn || txns.has(lc(r.coinid))) continue;
      txns.set(lc(r.coinid), r); tx(r.txn, r.owner, r.state !== "building").coins.add(lc(r.coinid));
    }
    for (const h of (d && Array.isArray(d.holds) ? d.holds : [])) if (h && isCoin(lc(h.coinid)) && h.owner && !holds.has(lc(h.coinid))) holds.set(lc(h.coinid), h);
  }
  function clear() { txns.clear(); holds.clear(); txOf.clear(); gone.clear(); cursor = 0; }
  /**
   * Open this wallet's file (the node is running). read(cmd) -> the node's reply. The wallet id is one-way: the
   * SHA-256 of a seed the node derives for this purpose alone. If it cannot be read (a locked node) the registry works
   * in memory and says so; it is asked again at the next open.
   */
  function open(dir, read) {
    if (opening) return opening;
    opening = (async () => {
      try {
        const r = await read("seedrandom modifier:coin-reservation-v1");
        const seed = r && r.status === true && r.pending !== true && r.response ? String(r.response.seedrandom || "") : "";
        if (!/^0x[0-9A-Fa-f]{64}$/.test(seed)) throw new Error((r && (r.error || r.message)) || "the node gave no derived seed (is it locked?)");
        fs.mkdirSync(dir, { recursive: true });
        file = lastFile = path.join(dir, "coin-reservations-0x" + crypto.createHash("sha256").update("coin-reservation|" + lc(seed)).digest("hex") + ".json");
        load();
        // nothing survives a restart as `building` for long: what was being built then is aged out by sweep (BUILD_MS from its own time)
        const n = txns.size + holds.size; if (n) log(n + " coin reservation" + (n === 1 ? "" : "s") + " read back from " + file);
      } catch (e) { file = null; log("this wallet's reservation file could not be opened (" + ((e && e.message) || e) + "): reservations are kept in memory only until the next start"); }
      finally { opening = null; }
    })();
    return opening;
  }
  /** The node stopped: every build died with it (released, written), the rest stays on disk, memory is emptied. */
  function close() {
    for (const [k, r] of txns) if (r.state === "building") txns.delete(k);
    persist(); file = null; clear();
  }
  /** The wallet was replaced or reset: everything released, the file moved aside under a dated name (never deleted). */
  function invalidate() {
    clear();
    const f = file || lastFile; file = lastFile = null;
    const kept = f ? require("./restore").moveAside(f) : "";
    if (kept) log("the old wallet's coin reservations are kept as " + kept);
    return kept;
  }

  // ---- records ----
  function tx(id, owner, posted) { let t = txOf.get(id); if (!t) { t = { owner, posted: !!posted, coins: new Set() }; txOf.set(id, t); } return t; }
  function unlink(k) { const r = txns.get(k); if (!r) return; txns.delete(k); const t = txOf.get(r.txn); if (t) { t.coins.delete(k); if (!t.coins.size && t.posted) txOf.delete(r.txn); } }
  function describe(r) { return r.why || (r.txn ? TXN_WHY[r.owner] : HOLD_WHY[r.owner]) || "another part of the app"; }
  /** The record that keeps `coin` from `owner`, or null. A transaction's claim is said before a hold. */
  function foreign(owner, coin) {
    const k = lc(coin), t = txns.get(k), h = holds.get(k);
    return (t && t.owner !== owner && t) || (h && h.owner !== owner && h) || null;
  }
  const others = (owner) => { for (const r of txns.values()) if (r.owner !== owner) return true; for (const h of holds.values()) if (h.owner !== owner) return true; return false; };

  /** Is this one of the wallet's own plain coins (at a simple address of mine)? Throws when the node does not say. */
  async function isPlain(coin, read) {
    const r = rows(await read("coins coinid:" + coin + " sendable:true"));
    if (!r) throw new Error("the node did not say");
    return r.some(x => lc(x.coinid) === lc(coin));
  }
  /** "" = this owner may put the coin into transaction `id`; otherwise why not, in plain words. */
  async function blocked(owner, id, coin, read) {
    if (!foreign(owner, coin)) return "";
    // ONLY A PLAIN WALLET COIN IS EVER REFUSED (header). When the node cannot say, a settling owner is let through.
    let plain; try { plain = await isPlain(coin, read); } catch (e) { plain = !SETTLES.has(owner); }
    if (!plain) return "";
    const by = foreign(owner, coin);   // looked at again: the read took time
    if (!by) return "";
    if (by === holds.get(coin) && SETTLES.has(owner)) {
      // SETTLEMENT WINS: a settlement transaction (it already carries a contract coin) takes a coin that is only collateral
      const t = txOf.get(id);
      for (const k of (t && t.owner === owner ? [...t.coins] : [])) {
        let contract = false; try { contract = !(await isPlain(k, read)); } catch (e) {}
        if (contract) { if (holds.delete(coin)) { persist(); log("settlement first: coin " + by.coinid + " was held for " + describe(by) + " and goes into " + (TXN_WHY[owner] || owner) + " " + id); } return ""; }
      }
    }
    return "Coin " + by.coinid + " is held for " + describe(by) + ". Nothing was signed.";
  }

  async function input(owner, c, send) {
    const id = param(c, "id"), given = param(c, "coinid"), coin = lc(given);
    if (!id || !isCoin(coin)) return send(c);
    // Free coin: nothing is awaited between the look and the record, so two callers in one tick cannot both pass.
    if (foreign(owner, coin)) {
      const why = await blocked(owner, id, coin, send);
      if (why) { log("refused: `txninput` of " + owner + " (transaction " + id + "): " + why); return refusal("txninput", why); }
    }
    const had = txns.get(coin), t = tx(id, owner);
    const mine = !had || had.owner === owner;   // a contract coin another owner named first keeps its first record
    if (mine) { if (had) unlink(coin); txns.set(coin, { coinid: given, owner, txn: id, state: "building", at: now() }); t.coins.add(coin); persist(); }
    const back = () => { const r = txns.get(coin); if (mine && r && r.txn === id && r.state === "building") { unlink(coin); persist(); } };
    let r; try { r = await send(c); } catch (e) { back(); throw e; }
    if (!r || r.status !== true) back();
    return r;
  }
  async function post(owner, c, send) {
    const id = param(c, "id"), t = txOf.get(id);
    if (!t || !t.coins.size) return send(c);
    const at = now();
    t.posted = true;
    for (const k of t.coins) { const r = txns.get(k); if (r) { r.state = "posting"; r.postedAt = at; } }
    persist();   // a crash from here on finds them posted: only the chain can say otherwise
    let r; try { r = await send(c); } catch (e) { throw e; }   // no answer: it may have been posted, so the coins stay
    if (r && r.status === false && r.pending !== true) {   // a definite rejection: nothing was broadcast
      t.posted = false;
      for (const k of [...t.coins]) unlink(k);
      txOf.delete(id); persist();
    } else {
      for (const k of t.coins) { const x = txns.get(k); if (x) x.state = "posted"; }
      persist();
    }
    return r;
  }
  async function del(c, send) {
    const id = param(c, "id");
    try { return await send(c); }
    finally {
      const t = txOf.get(id);
      if (t && !t.posted) { for (const k of [...t.coins]) unlink(k); txOf.delete(id); persist(); }
      else if (t && !t.coins.size) txOf.delete(id);
    }
  }
  /** "an AtomiX swap and a live Dexicon order": what holds these records, each said once. */
  function whys(recs) { const said = [...new Set(recs.map(describe))]; return said.length > 1 ? said.slice(0, -1).join(", ") + " and " + said[said.length - 1] : said[0] || "another part of the app"; }
  /**
   * `send`. Nothing held by anyone else: forwarded exactly as before. Otherwise it is kept to an address none of whose
   * coins is held (main/sendpin.js; `fromaddress:` is the only coin choice `send` has), or refused before signing.
   */
  async function sendCmd(owner, c, send) {
    if (!others(owner)) return send(c);
    const held = (id) => foreign(owner, id);
    const no = (why) => { log("refused: `send` of " + owner + ": " + why); return refusal("send", why); };
    const from = param(c, "fromaddress");
    if (from) {   // the caller pinned it: the node may take any coin at that address
      const tok = param(c, "tokenid") || "0x00";
      let at = null; try { at = rows(await send("coins relevant:true tokenid:" + tok + " address:" + from)); } catch (e) {}
      const by = (at || []).map(x => held(x.coinid)).filter(Boolean);
      if (by.length) return no("Not sent: the address this send takes its coins from holds coin " + by[0].coinid + ", held for " + whys(by) + ". Nothing was signed.");
      return send(c);
    }
    const { pinSend, fromUnits, toUnits } = require("./sendpin");
    const p = await pinSend(send, c, { held, tokens: true });
    if (!p.blocked) return send(c);   // no coin of this token is held: exactly as it came
    if (p.pinned) return send(p.command);
    const name = tokenName(p.token);
    return no("Not enough free funds: " + fromUnits(p.heldUnits) + " " + name + " is held for " + whys(p.held)
      + " (a send takes its coins from one address, so coins at an address with a held coin count as held). Free: " + fromUnits(p.freeUnits) + " " + name
      + (p.freeUnits >= toUnits(p.need) ? ", and no single address holds the " + p.need + " this send needs" : "") + ". Nothing was signed.");
  }
  /** `consolidate`: core picks its own coins (the largest, by address) and cannot leave one out. Refused while another owner holds a coin of that token. */
  function consolidateCmd(owner, c, send) {
    if (/\bdryrun:true\b/i.test(c)) return send(c);
    const tok = lc(param(c, "tokenid")), by = [];
    for (const r of [...txns.values(), ...holds.values()]) if (r.owner !== owner && (r.tokenid == null || lc(r.tokenid) === tok)) by.push(r);
    if (!by.length) return send(c);
    const why = "Nothing consolidated: " + by.length + " coin" + (by.length === 1 ? " is" : "s are") + " held for " + whys(by) + ", and consolidating chooses its own coins and could take " + (by.length === 1 ? "it" : "one of them") + ". Try again when " + (by.length === 1 ? "it is" : "they are") + " free. Nothing was signed.";
    log("refused: `consolidate` of " + owner + ": " + why);
    return Promise.resolve(refusal("consolidate", why));
  }
  /** An engine's read of its own wallet coins: what another owner holds is left out, so it chooses among coins it can use. */
  async function coinsRead(owner, c, send, opts) {
    const r = await send(c);
    if (owner === "wallet" || (opts && opts.unfiltered) || !CHOICE_READ(c) || !rows(r) || !others(owner)) return r;
    const free = r.response.filter(x => !foreign(owner, x && x.coinid));
    return free.length === r.response.length ? r : Object.assign({}, r, { response: free });
  }
  function one(owner, c, send, opts) {
    const v = verbOf(c);
    if (v === "coins") return coinsRead(owner, c, send, opts);
    if (v === "send") return sendCmd(owner, c, send);
    if (v === "consolidate") return consolidateCmd(owner, c, send);
    if (v === "txninput") return input(owner, c, send);
    if (v === "txnpost") return post(owner, c, send);
    if (v === "txndelete") return del(c, send);
    if (v === "txncreate") { const id = param(c, "id"); if (id && !txOf.has(id)) tx(id, owner); }
    return send(c);
  }
  /**
   * Every node command of the app. owner: who asks ("" = the wallet). send(cmd) forwards to the node and resolves
   * with its reply. Resolves with the node's reply, or with a refusal in the node's own failure shape.
   */
  async function guard(owner, command, send, opts) {
    const c = String(command);
    if (!WATCH.test(c)) return send(c);   // nearly everything: one test, nothing else
    if (opening) await opening;
    owner = owner || "wallet";
    if (c.indexOf(";") < 0) return one(owner, c.trim(), send, opts);
    // a `;` chain (the terminal): refused whole when one of its inputs is held; then recorded part by part from its reply
    const ps = c.split(";").map(s => s.trim()).filter(Boolean);
    for (const p of ps) if (verbOf(p) === "txninput" && isCoin(lc(param(p, "coinid")))) {
      const why = await blocked(owner, param(p, "id"), lc(param(p, "coinid")), send);
      if (why) { log("refused: a chained command of " + owner + ": " + why); return refusal("txninput", why); }
    }
    if (ps.some(p => /^(?:send|consolidate)$/.test(verbOf(p))) && others(owner)) {
      const why = "Not sent: coins are held for " + whys([...txns.values(), ...holds.values()].filter(r => r.owner !== owner)) + ", and a send or a consolidation inside a chain of commands cannot be kept away from them. Run it as one command. Nothing was signed.";
      log("refused: a chained command of " + owner + ": " + why); return refusal(verbOf(ps.find(p => /^(?:send|consolidate)$/.test(verbOf(p)))), why);
    }
    const reply = await send(c), each = Array.isArray(reply) ? reply : [];
    ps.forEach((p, i) => { const r = each[i]; if (r && /^txn/.test(verbOf(p))) one(owner, p, async () => r).catch(() => {}); });   // the same bookkeeping, fed the node's own answers
    return reply;
  }

  // ---- holds ----
  /** Replace `owner`'s holds with this list ([{ coinid, why }]). */
  function setHolds(owner, list) {
    const want = new Map();
    for (const h of (list || [])) { const k = lc(h && h.coinid); if (isCoin(k) && !gone.has(k) && !want.has(k)) want.set(k, h); }
    let changed = false;
    for (const [k, h] of holds) if (h.owner === owner && !want.has(k)) { holds.delete(k); changed = true; }
    for (const [k, h] of want) {
      const had = holds.get(k);
      if (had && had.owner !== owner) continue;   // first come: two owners never hold one coin
      if (!had) { holds.set(k, { coinid: String(h.coinid), owner, why: String(h.why || ""), at: now() }); changed = true; }
      else if (had.why !== String(h.why || "")) { had.why = String(h.why || ""); changed = true; }
    }
    if (changed) persist();
    return changed;
  }
  function setHoldSource(owner, fn) { if (fn) sources.set(owner, fn); else sources.delete(owner); }
  /** That owner's engine stopped: its builds died with it. Its posted coins and its holds stay (they still back something). */
  function releaseOwner(owner) {
    let n = 0;
    for (const [k, r] of txns) if (r.owner === owner && r.state === "building") { unlink(k); n++; }
    for (const [id, t] of txOf) if (t.owner === owner && !t.posted) txOf.delete(id);
    if (n) { persist(); log(n + " coin" + (n === 1 ? "" : "s") + " of " + owner + "'s unfinished transactions released (its engine stopped)"); }
    return n;
  }

  // ---- the sweeper ----
  function forget(k, why) {
    const r = txns.get(k) || holds.get(k);
    unlink(k); holds.delete(k);
    gone.set(k, now()); if (gone.size > 5000) gone.delete(gone.keys().next().value);
    if (r) log("released: coin " + r.coinid + " (" + describe(r) + ") " + why);
  }
  /**
   * Reconcile with the node (read(cmd) -> reply). Never lists the wallet: one read per reserved coin, at most
   * SWEEP_READS a call, in turn. A read the node does not answer releases nothing. Resolves with how many were released.
   */
  async function sweep(read) {
    if (opening) await opening;
    let freed = 0, dirty = false;
    const t = now();
    for (const [k, r] of txns) if (r.state === "building" && t - r.at > BUILD_MS) { unlink(k); freed++; dirty = true; log("released: coin " + r.coinid + " (" + describe(r) + "), named for transaction " + r.txn + " that was never posted or deleted"); }
    for (const [owner, fn] of sources) { try { const l = await fn(); if (l) setHolds(owner, l); } catch (e) {} }
    for (const [id, x] of txOf) if (!x.coins.size) txOf.delete(id);   // an id with no coin left says nothing (a later txninput notes it again)
    const keys = [...new Set([...txns.keys(), ...holds.keys()])];
    if (keys.length) {
      let block = 0;
      try { const b = await read("block"); block = Number(b && b.status === true && b.response && b.response.block) || 0; } catch (e) {}
      const n = block ? Math.min(SWEEP_READS, keys.length) : 0;   // no tip = no node: nothing is decided
      for (let i = 0; i < n; i++) {
        const k = keys[(cursor + i) % keys.length], rec = txns.get(k) || holds.get(k);
        if (!rec) continue;
        let found; try { found = rows(await read("coins coinid:" + rec.coinid)); } catch (e) { found = null; }
        if (!found) continue;
        const row = found.find(x => lc(x.coinid) === k && x.spent !== true);
        if (!row) { forget(k, "is spent"); freed++; dirty = true; continue; }
        for (const x of [txns.get(k), holds.get(k)]) if (x && x.tokenid == null) {
          x.tokenid = String(row.tokenid || "0x00"); x.address = String(row.address || "");
          x.amount = String(lc(x.tokenid) !== "0x00" && row.tokenamount != null ? row.tokenamount : row.amount); dirty = true;
        }
        const x = txns.get(k);
        if (!x || x.state === "building") continue;
        if (!x.postedBlock) { x.postedBlock = block; dirty = true; continue; }
        if (block - x.postedBlock < DEAD_BLOCKS || t - (x.postedAt || t) < DEAD_MS) continue;
        let free; try { free = rows(await read("coins coinid:" + rec.coinid + " checkmempool:true")); } catch (e) { free = null; }
        if (free && free.some(y => lc(y.coinid) === k && y.spent !== true)) {   // unspent, and nothing in the mempool spends it
          const id = x.txn; unlink(k); freed++; dirty = true;
          log("released: coin " + x.coinid + " (" + describe(x) + "): transaction " + id + " was posted " + (block - x.postedBlock) + " blocks ago, the coin is unspent and nothing in the mempool spends it");
        }
      }
      cursor = keys.length ? (cursor + n) % keys.length : 0;
    }
    if (dirty) persist();
    return freed;
  }

  /** Every reservation, for the screens: [{ coinid, owner, why, state, txn, tokenid, amount, address }] (ids whole). */
  function list() {
    const out = [];
    for (const r of txns.values()) out.push({ coinid: r.coinid, owner: r.owner, why: describe(r), state: r.state, txn: r.txn, tokenid: r.tokenid == null ? null : r.tokenid, amount: r.amount == null ? null : r.amount, address: r.address || "" });
    for (const [k, h] of holds) if (!txns.has(k)) out.push({ coinid: h.coinid, owner: h.owner, why: describe(h), state: "held", txn: "", tokenid: h.tokenid == null ? null : h.tokenid, amount: h.amount == null ? null : h.amount, address: h.address || "" });
    return out;
  }

  return Object.assign(api, { guard, open, close, invalidate, setHolds, setHoldSource, releaseOwner, sweep, list, foreign, others, describe,
    _file: () => file, _size: () => txns.size + holds.size });
}

module.exports = Object.assign(createRegistry(), { createRegistry, BUILD_MS, DEAD_MS, DEAD_BLOCKS, SWEEP_READS });
