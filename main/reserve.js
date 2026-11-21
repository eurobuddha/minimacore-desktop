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
const HOLD_STALE_MS = 24 * 60 * 60 * 1000;   // a hold its source has not listed for this long is released: none leaks for good
const OPEN_WAIT_MS = 3000;         // a watched command waits this long for the store to open, then goes on as if nothing were held on disk
const MISSES = 2;                  // a coin is "gone" only when the node did not show it this many sweeps running
const PIN_COINAGE = 3;             // a pin never names a coin younger than this: the node will not spend it yet (main/sendpin.js minCoinage)
const SWEEP_READS = 25;            // coins asked of the node per sweep, round robin: a fragmented wallet is never listed
const SETTLES = new Set(["atomix", "casino"]);   // owners whose transactions settle against a deadline
const TXN_WHY = { atomix: "an AtomiX swap", pandapools: "a PandaPools transaction", dexicon: "a Dexicon trade", casino: "a P2P Chance transaction", wallet: "a transaction of the wallet", futurecash: "a Future Cash Next transaction" };
const HOLD_WHY = { dexicon: "Dexicon" };
HOLD_WHY.futurecash = "Future Cash Next";   // the coins Future Cash Next is about to sweep (main/futurecash.js coinHolds)
// Which command it is, and its parameters, are read the way the node reads them (main/cmdverb.js, 0.19.192): the node trims
// every character up to U+0020, takes a "quoted" first word as the verb, reads ":" as a token and drops quotes. A
// /^\s*(\w+)/ reading let `"txninput" id:a coinid:0x…`, a control character before it, or `coinid : 0x…` past the guard.
const V = require("./cmdverb");
const WATCHED = ["txninput", "send", "consolidate", "txnpost", "txndelete", "txncreate", "coins"];   // in this order when two readings differ
const WATCH = { test: (c) => V.parts(c).some(p => V.verbs(p).some(v => WATCHED.includes(v))) };
const MXUSD = "0x7d39745fbd29049be29850b55a18bf550e4d442f930f86266e34193d89042a90";
const tokenName = (t) => (lc(t) === "0x00" ? "MINIMA" : lc(t) === MXUSD ? "MxUSD" : "of token " + t);
/** An engine's own choice of inputs: its wallet coins of one token. Not a look at one coin or one address. */
const CHOICE_READ = (c) => verbOf(c) === "coins" && lc(param(c, "relevant")) === "true" && args(c).first.has("tokenid") && !args(c).first.has("coinid") && !args(c).first.has("address");

const lc = (s) => String(s == null ? "" : s).toLowerCase();
/** The verb the node runs for ONE command, lower-cased (CommandRunner.getCommand: SEND is send); where its two readings
 *  differ, a watched one wins (over-guarding, never under). */
const verbOf = (c) => { const vs = V.verbs(c); return WATCHED.find(w => vs.includes(w)) || vs[0] || ""; };
/**
 * One command's top-level parameters, split as the node splits them (CommandRunner.splitStringJSON): on white space,
 * with a {…}, […] or "…" value kept whole, so a name:value inside a state JSON is not a parameter. Names are compared
 * in lower case. first: name -> the first value; dup: the first name given twice ("" = none). The node keeps the LAST
 * value of a repeated name while a reader of the text finds the first, so a repeated name is refused, never guessed.
 */
function parse(c) {
  const first = new Map(); let dup = "", depth = 0, quote = false, tok = "";
  const end = () => { const i = tok.indexOf(":"); if (i > 0) { const k = lc(tok.slice(0, i)); if (first.has(k)) { if (!dup) dup = k; } else first.set(k, tok.slice(i + 1).replace(/^"/, "").replace(/"$/, "")); } tok = ""; };   // the node drops a value's own quotes
  for (const ch of String(c)) {
    if (ch === '"') quote = !quote;
    else if (!quote && (ch === "{" || ch === "[")) depth++;
    else if (!quote && (ch === "}" || ch === "]") && depth) depth--;
    if (!depth && !quote && /\s/.test(ch)) end(); else tok += ch;
  }
  end();
  return { first, dup };
}
let parsedOf = "", parsed = null;   // the last command parsed: every look at one command reads the same parse
const args = (c) => { if (c !== parsedOf || !parsed) { parsed = parse(V.paramsText(c)); parsedOf = c; } return parsed; };   // quotes dropped and " : " closed up first, as the node reads a name and its value
const param = (c, k) => args(c).first.get(k) || "";
const SEND_MODES = ["off", "observe", "enforce"];
const isCoin = (s) => /^0x[0-9a-f]{2,64}$/.test(s);
const refusal = (verb, why) => ({ command: verb, status: false, pending: false, error: why, reserved: true });
const rows = (r) => (r && r.status === true && Array.isArray(r.response) ? r.response : null);   // null: the node did not say

function createRegistry(o = {}) {
  const now = o.now || Date.now;
  const txns = new Map(), holds = new Map();
  const txOf = new Map();       // txn id -> { owner, posted, coins:Set }
  const sources = new Map();    // owner -> () => [{ coinid, why }]: where that owner's holds are read from
  const gone = new Map();       // coin ids the node no longer shows (a source that still lists one does not bring it back)
  const misses = new Map();     // coin id -> sweeps running in which the node did not show it
  const relisted = new Set();   // coins in `gone` that a source still lists: looked at again by the sweep
  let file = null, lastFile = null, opening = null, cursor = 0, openFailed = "", reader = null, looking = false;
  const api = { onLog: o.log || null };
  const log = (line) => { try { if (api.onLog) api.onLog(String(line)); } catch (e) {} };
  const openWait = o.openWait >= 0 ? o.openWait : OPEN_WAIT_MS;
  /** At most openWait for a store that is being opened; never longer (a locked or slow node must not hold a command). */
  const opened = () => { if (!opening) return null; let t; return Promise.race([opening, new Promise(r => { t = setTimeout(r, openWait); })]).finally(() => clearTimeout(t)); };

  // ---- the setting (config: coinGuard, coinGuardSends; main.js passes every change) ----
  // on:false = the whole guard is a passthrough (nothing read, nothing recorded, nothing refused).
  // sends: what `send` pinning / refusal and `consolidate` refusal do. "observe" (the default) changes nothing: the
  // command goes out byte for byte and the log says what would have been pinned or refused, and why. `txninput` and
  // the engines' coin reads are enforced whenever the guard is on.
  const mode = { on: o.on !== false, sends: SEND_MODES.includes(o.sends) ? o.sends : "observe" };
  function setMode(m) {
    const on = !(m && m.on === false), sends = m && SEND_MODES.includes(m.sends) ? m.sends : "observe";
    if (on === mode.on && sends === mode.sends) return;
    mode.on = on; mode.sends = sends;
    log("setting: the coin guard is " + (on ? "ON; sends and consolidate: " + sends : "OFF (every command passes untouched)"));
  }

  // ---- the store ----
  function save() {
    if (!file) return;
    const tmp = file + ".tmp", body = JSON.stringify({ v: 1, txns: [...txns.values()], holds: [...holds.values()] });
    const fd = fs.openSync(tmp, "w", 0o600);   // what the wallet's coins are committed to is the owner's to read, nobody else's
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
  function clear() { txns.clear(); holds.clear(); txOf.clear(); gone.clear(); misses.clear(); relisted.clear(); cursor = 0; }
  /**
   * Which wallet this is, from PUBLIC data only: the wallet's FIRST key, the one made with modifier 0x00 (core's
   * Wallet.createNewKey numbers its keys; the same seed in the same key mode always gives the same first key). A
   * locked node still lists its public keys, and nothing is derived from the seed for this. Throws when the node does
   * not show that key (not answering yet, or no key made yet): asked again a minute later.
   */
  async function walletKey(read) {
    const first = (r) => { const l = r && r.status === true && r.response && Array.isArray(r.response.keys) ? r.response.keys : []; const k = l.find(x => x && lc(x.modifier) === "0x00"); return k && /^0x[0-9a-f]{64}$/.test(lc(k.publickey)) ? lc(k.publickey) : ""; };
    let r = null, pk = "";
    try { r = await read("keys modifier:0x00"); pk = first(r); } catch (e) {}   // one row where the node knows `modifier:`
    if (!pk) { r = await read("keys"); pk = first(r); }                         // else the list
    if (!pk) throw new Error((r && (r.error || r.message)) || "the node did not show the wallet's first key yet");
    return pk;
  }
  /**
   * Open this wallet's file (the node is running). read(cmd) -> the node's reply; kept for the token look-ups. If the
   * wallet cannot be identified the registry works in memory and says so; it is asked again at the next open.
   * ONE-TIME RENAME (0.19.100): up to 0.19.0 the file was named after a seed derivation
   * (coin-reservations-0x….json). That name cannot be computed without the seed read, so: when this wallet has no
   * file yet and the folder holds exactly ONE file of the old name, it is renamed. With several, none is touched
   * (they stay where they are) and an empty file is started. A file of another wallet taken this way holds coins this
   * node does not show: the sweep releases them.
   */
  function open(dir, read) {
    if (opening) return opening;
    reader = read;
    opening = (async () => {
      try {
        const pk = await walletKey(read);
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, "coin-reservations-pk-0x" + crypto.createHash("sha256").update("coin-reservation|first-key|" + pk).digest("hex") + ".json");
        if (!fs.existsSync(f)) {
          const old = fs.readdirSync(dir).filter(n => /^coin-reservations-0x[0-9a-f]{64}\.json$/.test(n));
          if (old.length === 1) { fs.renameSync(path.join(dir, old[0]), f); log("the reservation file " + old[0] + " was renamed to " + path.basename(f) + " (it is now named after the wallet's first public key)"); }
          else if (old.length > 1) log(old.length + " reservation files of the old name are in " + dir + ": none was taken over, an empty one is started");
        }
        try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch (e) {}
        file = lastFile = f; openFailed = "";
        load();
        // nothing survives a restart as `building` for long: what was being built then is aged out by sweep (BUILD_MS from its own time)
        const n = txns.size + holds.size; if (n) log(n + " coin reservation" + (n === 1 ? "" : "s") + " read back from " + file);
      } catch (e) { file = null; const why = (e && e.message) || String(e); if (why !== openFailed) { openFailed = why; log("this wallet's reservation file could not be opened (" + why + "): reservations are kept in memory only; it is tried again every minute"); } }
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
    // ONLY A PLAIN WALLET COIN IS EVER REFUSED (header). When the node cannot say, EVERY engine is let through (a pool
    // operation or a Dexicon settlement must not fail on an unanswered read; the node's own mempool check still stops a
    // double spend). Only the wallet's own commands, which a person can simply repeat, are refused.
    let plain; try { plain = await isPlain(coin, read); } catch (e) { plain = owner === "wallet"; if (!plain) log("let through: the node did not say what coin " + coin + " is, and `txninput` of " + owner + " (transaction " + id + ") is not held up for that"); }
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
    const dup = args(c).dup;
    if (dup) { const why = "The parameter " + dup + ": is given twice. Nothing was signed."; log("refused: `txninput` of " + owner + ": " + why); return refusal("txninput", why); }
    if (!id || !isCoin(coin)) return send(c);
    // Free coin: nothing is awaited between the look and the record, so two callers in one tick cannot both pass.
    if (foreign(owner, coin)) {
      const why = await blocked(owner, id, coin, send);
      if (why) { log("refused: `txninput` of " + owner + " (transaction " + id + "): " + why); return refusal("txninput", why); }
    }
    const had = txns.get(coin), t = tx(id, owner);
    // A contract coin another owner named first keeps its first record. So does a coin this owner has already POSTED in
    // another transaction: deleting the new one must not free a coin the posted one may still spend.
    const mine = !had || (had.owner === owner && had.state === "building");
    if (mine) { if (had) unlink(coin); txns.set(coin, { coinid: given, owner, txn: id, state: "building", at: now() }); t.coins.add(coin); persist(); }
    const back = () => { const r = txns.get(coin); if (mine && r && r.txn === id && r.state === "building") { unlink(coin); persist(); } };
    let r; try { r = await send(c); } catch (e) { back(); throw e; }
    if (!r || r.status !== true) back();
    return r;
  }
  async function post(owner, c, send) {
    const id = param(c, "id"), t = txOf.get(id);
    if (args(c).dup === "id") { const why = "The parameter id: is given twice. Nothing was posted."; log("refused: `txnpost` of " + owner + ": " + why); return refusal("txnpost", why); }
    if (!t || !t.coins.size) return send(c);
    const at = now(), again = t.posted;   // again: an earlier post of this transaction may be in the mempool
    t.posted = true;
    for (const k of t.coins) { const r = txns.get(k); if (r && r.state === "building") { r.state = "posting"; r.postedAt = at; } }
    persist();   // a crash from here on finds them posted: only the chain can say otherwise
    let r; try { r = await send(c); } catch (e) { throw e; }   // no answer: it may have been posted, so the coins stay
    if (r && r.status === false && r.pending !== true && again) {
      // A RETRY the node rejects says nothing about the first post ("already in the mempool" is such a rejection): the
      // coins stay as they were, and the sweep releases them when the chain or the mempool says so.
      for (const k of t.coins) { const x = txns.get(k); if (x && x.state === "posting") x.state = "posted"; }
      persist();
    } else if (r && r.status === false && r.pending !== true) {   // a definite rejection of the FIRST post: nothing was broadcast
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
  /** What is read of a coin once: its token, address and amount (a token coin's amount in token units). */
  function learn(rec, row) { rec.tokenid = String(row.tokenid || "0x00"); rec.address = String(row.address || ""); rec.amount = String(lc(rec.tokenid) !== "0x00" && row.tokenamount != null ? row.tokenamount : row.amount); }
  /** Ask the node for the token of each record that does not know it yet (at most SWEEP_READS reads). True when any was learnt. */
  async function lookUp(recs, read) {
    let n = 0, learnt = false;
    for (const r of recs) if (r.tokenid == null && n++ < SWEEP_READS) {
      try { const row = (rows(await read("coins coinid:" + r.coinid)) || []).find(x => lc(x.coinid) === lc(r.coinid)); if (row) { learn(r, row); learnt = true; } } catch (e) {}
    }
    return learnt;
  }
  /** A hold was set: its token is looked up at once (not a minute later by the sweep), so `consolidate` of another token is not held up by it. */
  function lookUpSoon() {
    if (looking || !reader) return;
    looking = true;
    lookUp([...holds.values()], reader).then(l => { if (l) persist(); }, () => {}).then(() => { looking = false; });
  }

  /**
   * What the reservation makes of a `send`: { command } to forward (pinned with fromaddress: when it has to be kept
   * off a held coin), or { refuse: why }. Reads only. `fromaddress:` is the only coin choice `send` has (main/sendpin.js).
   */
  async function sendVerdict(owner, c, send) {
    const held = (id) => foreign(owner, id);
    const dup = args(c).dup;
    if (dup) return { refuse: "Not sent: the parameter " + dup + ": is given twice. Nothing was signed." };
    const from = param(c, "fromaddress");
    if (from) {   // the caller pinned it: the node may take any coin at that address
      const tok = param(c, "tokenid") || "0x00";
      let at = null; try { at = rows(await send("coins relevant:true tokenid:" + tok + " address:" + from)); } catch (e) {}
      const by = (at || []).map(x => held(x.coinid)).filter(Boolean);
      if (by.length) return { refuse: "Not sent: the address this send takes its coins from holds coin " + by[0].coinid + ", held for " + whys(by) + ". Nothing was signed." };
      return { command: c };
    }
    const { pinSend, fromUnits, toUnits } = require("./sendpin");
    const p = await pinSend(send, c, { held, tokens: true, minCoinage: PIN_COINAGE });
    if (!p.blocked) return { command: c };   // no coin of this token is held: exactly as it came
    if (p.pinned) return { command: p.command, pinned: true, by: whys(p.held) };
    const name = tokenName(p.token);
    return { refuse: "Not enough free funds: " + fromUnits(p.heldUnits) + " " + name + " is held for " + whys(p.held)
      + " (a send takes its coins from one address, so coins at an address with a held coin count as held). Free: " + fromUnits(p.freeUnits) + " " + name
      + (p.freeUnits >= toUnits(p.need) ? ", and no single address holds the " + p.need + " this send needs" : "") + ". Nothing was signed." };
  }
  /**
   * `send`. Setting "off", or nothing held by anyone else: forwarded exactly as it came, nothing read. "observe": the
   * verdict is worked out and LOGGED, and the command still goes out byte for byte. "enforce": pinned or refused.
   */
  async function sendCmd(owner, c, send) {
    if (mode.sends === "off" || !others(owner)) return send(c);
    if (mode.sends !== "enforce") {
      try {
        const v = await sendVerdict(owner, c, send);
        if (v.refuse) log("observe: `send` of " + owner + " WOULD HAVE BEEN REFUSED: " + v.refuse + " (sent unchanged: sends are observed, not enforced)");
        else if (v.pinned) log("observe: `send` of " + owner + " WOULD HAVE BEEN PINNED with" + v.command.slice(c.length) + " to keep it off coins held for " + v.by + " (sent unchanged)");
      } catch (e) {}
      return send(c);
    }
    const v = await sendVerdict(owner, c, send);
    if (v.refuse) { log("refused: `send` of " + owner + ": " + v.refuse); return refusal("send", v.refuse); }
    return send(v.command);
  }
  /**
   * `consolidate`: core picks its own coins (the largest, by address) and cannot leave one out. While another owner
   * holds a coin OF THAT TOKEN it is refused ("enforce") or the refusal is logged and the command sent ("observe").
   * A held coin whose token is not known yet is asked of the node first; one the node does not answer for counts.
   */
  async function consolidateCmd(owner, c, send) {
    if (mode.sends === "off" || lc(param(c, "dryrun")) === "true") return send(c);
    const mine = [...txns.values(), ...holds.values()].filter(r => r.owner !== owner);
    if (!mine.length) return send(c);
    const enforce = mode.sends === "enforce", dup = args(c).dup;
    let why = dup ? "Nothing consolidated: the parameter " + dup + ": is given twice. Nothing was signed." : "";
    if (!why) {
      try { if (await lookUp(mine, send)) persist(); } catch (e) {}
      const tok = lc(param(c, "tokenid")), by = mine.filter(r => (txns.get(lc(r.coinid)) === r || holds.get(lc(r.coinid)) === r) && (r.tokenid == null || lc(r.tokenid) === tok));
      if (!by.length) return send(c);
      why = "Nothing consolidated: " + by.length + " coin" + (by.length === 1 ? " is" : "s are") + " held for " + whys(by) + ", and consolidating chooses its own coins and could take " + (by.length === 1 ? "it" : "one of them") + ". Try again when " + (by.length === 1 ? "it is" : "they are") + " free. Nothing was signed.";
    }
    if (!enforce) { log("observe: `consolidate` of " + owner + " WOULD HAVE BEEN REFUSED: " + why + " (sent unchanged: consolidate is observed, not enforced)"); return send(c); }
    log("refused: `consolidate` of " + owner + ": " + why);
    return refusal("consolidate", why);
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
    if (!mode.on || !WATCH.test(c)) return send(c);   // the guard switched off, and nearly everything: one test, nothing else
    if (opening) await opened();   // bounded: after OPEN_WAIT_MS the command goes on with what memory holds
    owner = owner || "wallet";
    // A `;` ends a command for the node WHEREVER it stands, inside a state JSON too (CommandRunner.runMultiCommand is a
    // StringTokenizer on ";"). The chain is split here exactly as the node splits it: read any other way, a txninput
    // written after a ; inside a JSON value would be run by the node and never seen here.
    if (c.indexOf(";") < 0) return one(owner, c.trim(), send, opts);
    // a `;` chain (the terminal): refused whole when one of its inputs is held; then recorded part by part from its reply
    const ps = c.split(";").map(s => s.trim()).filter(Boolean);
    for (const p of ps) if (verbOf(p) === "txninput") {
      if (args(p).dup) { const why = "The parameter " + args(p).dup + ": is given twice in a chained `txninput`. Nothing was signed."; log("refused: a chained command of " + owner + ": " + why); return refusal("txninput", why); }
      if (!isCoin(lc(param(p, "coinid")))) continue;
      const why = await blocked(owner, param(p, "id"), lc(param(p, "coinid")), send);
      if (why) { log("refused: a chained command of " + owner + ": " + why); return refusal("txninput", why); }
    }
    const picks = (p) => /^(?:send|consolidate)$/.test(verbOf(p)) && !(verbOf(p) === "consolidate" && lc(param(p, "dryrun")) === "true");
    if (mode.sends !== "off" && ps.some(picks) && others(owner)) {
      const why = "Not sent: coins are held for " + whys([...txns.values(), ...holds.values()].filter(r => r.owner !== owner)) + ", and a send or a consolidation inside a chain of commands cannot be kept away from them. Run it as one command. Nothing was signed.";
      if (mode.sends === "enforce") { log("refused: a chained command of " + owner + ": " + why); return refusal(verbOf(ps.find(picks)), why); }
      log("observe: a chained command of " + owner + " WOULD HAVE BEEN REFUSED: " + why + " (sent unchanged)");
    }
    const reply = await send(c), each = Array.isArray(reply) ? reply : [];
    ps.forEach((p, i) => { const r = each[i]; if (r && /^txn/.test(verbOf(p))) one(owner, p, async () => r).catch(() => {}); });   // the same bookkeeping, fed the node's own answers
    return reply;
  }

  // ---- holds ----
  /**
   * Replace `owner`'s holds with this list ([{ coinid, why, until }]; until: unix ms after which the hold lapses by
   * itself, e.g. a FAST order's expiry). A coin already in a transaction of another owner is still noted: it counts
   * once that transaction is gone.
   */
  function setHolds(owner, list) {
    const want = new Map(), t = now();
    for (const h of (list || [])) {
      const k = lc(h && h.coinid);
      if (isCoin(k) && gone.has(k)) relisted.add(k);   // the sweep looks at it again: a coin the node shows once more leaves `gone`
      if (isCoin(k) && !gone.has(k) && !want.has(k) && !(h.until > 0 && h.until <= t)) want.set(k, h);
    }
    let changed = false;
    for (const [k, h] of holds) if (h.owner === owner && !want.has(k)) { holds.delete(k); changed = true; }
    for (const [k, h] of want) {
      const had = holds.get(k), why = String(h.why || ""), until = h.until > 0 ? Number(h.until) : 0;
      if (had && had.owner !== owner) continue;   // first come: two owners never hold one coin
      if (!had) { const rec = { coinid: String(h.coinid), owner, why, at: t, seen: t, until }; if (h.tokenid) rec.tokenid = String(h.tokenid); holds.set(k, rec); changed = true; continue; }
      if (had.why !== why || (had.until || 0) !== until || t - (had.seen || 0) > 3600000) changed = true;   // `seen` reaches the disk at least hourly
      had.why = why; had.until = until; had.seen = t;
    }
    if (changed) { persist(); lookUpSoon(); }
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
    if (opening) await opened();
    let freed = 0, dirty = false;
    const t = now();
    // A record with no time, or a time in the future (a clock set back, a damaged file), would never lapse: its clock starts now.
    for (const r of txns.values()) { if (!(r.at <= t)) { r.at = t; dirty = true; } if (r.state !== "building" && !(r.postedAt <= t)) { r.postedAt = t; dirty = true; } }
    for (const h of holds.values()) if (!((h.seen || h.at) <= t)) { h.seen = h.at = t; dirty = true; }
    for (const [k, r] of txns) if (r.state === "building" && t - r.at > BUILD_MS) { unlink(k); freed++; dirty = true; log("released: coin " + r.coinid + " (" + describe(r) + "), named for transaction " + r.txn + " that was never posted or deleted"); }
    for (const [owner, fn] of sources) { try { const l = await fn(); if (l) setHolds(owner, l); } catch (e) {} }   // null: the source cannot say now (its engine is down): nothing changes
    for (const [k, h] of holds) {
      const lapsed = h.until > 0 && h.until <= t, stale = t - (h.seen || h.at || 0) > HOLD_STALE_MS;
      if (lapsed || stale) { holds.delete(k); freed++; dirty = true; log("released: coin " + h.coinid + " (" + describe(h) + ") " + (lapsed ? "is past its time" : "has not been listed by " + h.owner + " for a day")); }
    }
    for (const [id, x] of txOf) if (!x.coins.size) txOf.delete(id);   // an id with no coin left says nothing (a later txninput notes it again)
    let block = 0;
    if (txns.size || holds.size || relisted.size) { try { const b = await read("block"); block = Number(b && b.status === true && b.response && b.response.block) || 0; } catch (e) {} }
    // A coin called gone that its source still lists is asked for again: shown unspent, it leaves `gone` and is held again.
    let back = false;
    for (const k of block ? [...relisted].slice(0, SWEEP_READS) : []) {
      relisted.delete(k);
      let f; try { f = rows(await read("coins coinid:" + k)); } catch (e) { f = null; }
      if (f && f.some(x => lc(x.coinid) === k && x.spent !== true)) { gone.delete(k); back = true; log("coin " + k + " is shown by the node again: it can be held again"); }
    }
    if (back) for (const [owner, fn] of sources) { try { const l = await fn(); if (l) setHolds(owner, l); } catch (e) {} }
    const keys = [...new Set([...txns.keys(), ...holds.keys()])];
    if (keys.length) {
      const n = block ? Math.min(SWEEP_READS, keys.length) : 0;   // no tip = no node: nothing is decided
      for (let i = 0; i < n; i++) {
        const k = keys[(cursor + i) % keys.length], rec = txns.get(k) || holds.get(k);
        if (!rec) continue;
        let found; try { found = rows(await read("coins coinid:" + rec.coinid)); } catch (e) { found = null; }
        if (!found) continue;
        const row = found.find(x => lc(x.coinid) === k && x.spent !== true);
        if (!row) {   // one miss decides nothing (a node mid-sync, a reorg): MISSES sweeps running do
          const m = (misses.get(k) || 0) + 1;
          if (m < MISSES) { misses.set(k, m); continue; }
          misses.delete(k); forget(k, "is spent"); freed++; dirty = true; continue;
        }
        misses.delete(k);
        for (const x of [txns.get(k), holds.get(k)]) if (x && x.tokenid == null) { learn(x, row); dirty = true; }
        const x = txns.get(k);
        if (!x || x.state === "building") continue;
        if (!x.postedBlock) { x.postedBlock = block; dirty = true; continue; }
        if (block - x.postedBlock < DEAD_BLOCKS || t - x.postedAt < DEAD_MS) continue;
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

  /**
   * For the Wallet: per token, what `owner` cannot send because another part of the app holds it, and what it can.
   * The same sum the send pin makes (main/sendpin.js): a coin at an address with a held coin counts as held, because a
   * send takes its coins from one address. One coins read per token that has a held coin; a held coin whose token is
   * not known yet is asked for first (at most SWEEP_READS of them). [{ tokenid, held, free, why }], amounts exact.
   */
  async function funds(owner, read) {
    const { toUnits, fromUnits } = require("./sendpin");
    const recs = () => [...txns.values(), ...holds.values()].filter(r => r.owner !== owner);
    await lookUp(recs(), read);
    const out = [];
    for (const tok of new Set(recs().filter(r => r.tokenid != null).map(r => lc(r.tokenid)))) {
      let mine; try { mine = rows(await read("coins relevant:true sendable:true checkmempool:true tokenid:" + tok)); } catch (e) { mine = null; }
      if (!mine) continue;   // not known: nothing is claimed for this token
      const amountOf = (x) => toUnits(tok !== "0x00" && x.tokenamount != null ? x.tokenamount : x.amount);
      const by = [], poisoned = new Set();
      for (const x of mine) { const h = foreign(owner, x.coinid); if (h) { poisoned.add(lc(x.address)); if (by.indexOf(h) < 0) by.push(h); } }
      if (!by.length) continue;   // held coins of this token are all in posted transactions: the node's own figures already leave them out
      let held = 0n, free = 0n;
      for (const x of mine) { if (poisoned.has(lc(x.address))) held += amountOf(x); else free += amountOf(x); }
      out.push({ tokenid: tok, held: fromUnits(held), free: fromUnits(free), why: whys(by) });
    }
    return out;
  }

  /** Every reservation, for the screens: [{ coinid, owner, why, state, txn, tokenid, amount, address }] (ids whole). */
  function list() {
    const out = [];
    for (const r of txns.values()) out.push({ coinid: r.coinid, owner: r.owner, why: describe(r), state: r.state, txn: r.txn, tokenid: r.tokenid == null ? null : r.tokenid, amount: r.amount == null ? null : r.amount, address: r.address || "" });
    for (const [k, h] of holds) if (!txns.has(k)) out.push({ coinid: h.coinid, owner: h.owner, why: describe(h), state: "held", txn: "", tokenid: h.tokenid == null ? null : h.tokenid, amount: h.amount == null ? null : h.amount, address: h.address || "" });
    return out;
  }

  /** For the send pin of a caller (main/sendpin.js): the record that keeps a coin from `owner`, ONLY while sends are enforced. */
  const sendHeld = (owner, coin) => (mode.on && mode.sends === "enforce" ? foreign(owner, coin) : null);
  return Object.assign(api, { guard, open, close, invalidate, setHolds, setHoldSource, releaseOwner, sweep, list, funds, foreign, others, describe, setMode, sendHeld,
    mode: () => ({ on: mode.on, sends: mode.sends }),
    _file: () => file, _size: () => txns.size + holds.size });
}

module.exports = Object.assign(createRegistry(), { createRegistry, parse, HOLD_STALE_MS, BUILD_MS, DEAD_MS, DEAD_BLOCKS, SWEEP_READS, OPEN_WAIT_MS, MISSES, PIN_COINAGE, SEND_MODES });
