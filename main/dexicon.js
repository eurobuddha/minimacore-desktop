/*
 * dexicon.js — this app's host for the Dexicon engine (room 3, Exchange): the FAST book (signed orders over relays)
 * and the RESTING layer (on-chain orders + PandaPools routing). Ported from DexiconPro's host
 * (desktop/dexiconpro main/dexicon.js + the room.dex part of main/rooms.js) as the PUBLIC build.
 *
 * Same pattern as main/atomix.js: the engine (main/dexicon/, verbatim from mds/dexicon) runs in a vm behind an MDS
 * stand-in; this file builds the stand-in, drives the 10 s timer and the block watch, and gives the screens a read
 * model and a command bridge.
 *   cmd  -> the node, ONLY through rpcCall (main/rpc.js: every signing command passes the one process-wide queue)
 *   sql  -> its own SQLite file, userData/dexicon/dexicon.sqlite, through the H2->SQLite shim PandaPools uses
 *   net  -> https only: the engine's current relay list (kv 'relays': the user's list, which is where a relay found
 *           by DISCOVER lands once the user adds it; the MiniDapp's three defaults on a fresh install) and the
 *           MiniDapp's own price source, api.mexc.com (resting/price.js: depth, then bookTicker), with its one
 *           fallback when MEXC cannot be reached: MEXC's own MINIMA/USDT ticker as CoinGecko rebroadcasts it
 *           (lib/ladder.js GECKO_MEXC_URL: api.coingecko.com, that one path). Nothing else.
 *
 * NOT ported from DexiconPro (its private parts): the injected MEXC feed (PandaPrice) and the take gate (DX_GATE),
 * PAUSE ALL / NUKE (pauseAll, the room gates), the Mandate, the SQL refusals (maker_state, mm_*, mxusd_tokenid), the
 * MAKER_* packet refusal, the hard-coded RELAY_HOSTS, the cockpit's merged book / ladder editor / create / edit /
 * cancelOne / chain(). The engine's AtomiX doors are never loaded (main/dexicon/service.desktop.js).
 * ADDED: an epoch guard (a wallet replaced under a running engine: the old context's late callbacks reach neither
 * the node nor the new store), stop(), invalidate() (the store is moved aside, never deleted).
 * STOP DRAINS (0.18.117): stop() ends the timer and every new event at once, but the engine is dropped only when what
 * it had in flight has ended: a maker's co-signed take writes its fill, tells the taker and reduces the order AFTER
 * txnpost answers, and an engine dropped in between left a fill on the chain that nothing recorded. node-manager waits
 * for this before it sends `quit` (main.js onStopping). Bounded (15 s), except that an unanswered txnpost is waited
 * for: it ends by itself when the node answers or is gone. A txnpost that ends without an answer is reported to the
 * engine as UNANSWERED, and the service records the unknown outcome (service.desktop.js POST UNANSWERED).
 * OUTBOUND LANES (0.18.108): Dexicon's relay and price traffic takes NO slot of the app's shared four-slot pool
 * (main/netfetch.js), which the AtomiX Ethereum RPC needs for a claim or a refund. It has two bounded lanes of its
 * own: WORK (2 at a time: takes, replies, publishes, book reads, the price) and POLL (3: the long polls, which hold
 * a connection for many seconds by design: the service's inbox and the page's inbox and book). Refusals to takers
 * wait in the WORK lane at low priority, at most 32 of them: the oldest is dropped beyond that. Nothing else is ever
 * dropped: a take, a "taken" reply and an order all carry a signature or its result. Every request has a time limit.
 * WALLET SAFETY (0.18.106): the engine never outlives the node it derived its identity from (stop() drops the whole
 * context; every node start derives the identity again and the service checks the store against it); a store written
 * by another identity is moved aside before anything trades on it; while a move aside is owed and fails, the store is
 * not opened at all. The own-order refusal
 * on LIMIT of 0.18.99 is gone: since engine 0.0.91 the planners route past own orders (docs/DEXICON_ENGINE_NOTES.md (a)).
 */
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");
const { rpcCall } = require("./rpc");
const { createContext } = require("./dexicon/loader");
const { makeSqlShim } = require("./pandapools/sqlshim");

let app = null; try { app = require("electron").app; } catch (e) {}

const TICK_MS = 10000;
const DRAIN_MS = 15000;   // STOP DRAINS (header)
/** In the error of a txnpost the node never answered (it may have posted). service.desktop.js looks for this text. */
const UNANSWERED = "the node did not answer txnpost";
/** Did this failed node call end with the node provably NOT having run it? (nothing listening, or turned away) As main/rpc.js `lost`. */
const notRun = (e) => !!e && (e.code === "ECONNREFUSED" || /RPC authentication failed/.test(String(e.message)));
const WORK_LANE = 2, POLL_LANE = 3, LOW_MAX = 32, NET_LIMIT_MS = 30000;   // OUTBOUND LANES (header); netfetch's own limit is 15 s idle, 20 s in all

/** A lane: at most `size` requests in flight, the rest waiting in order, low-priority ones behind the others. Each
 *  request ends after limitMs at the latest (null), so one that never settles cannot hold its place for good.
 *  push(start, low) resolves with the request's value, or null (failed, timed out, or a low one dropped: onDrop). */
function makeLane(size, limitMs, onDrop) {
  let active = 0; const waiting = [];
  function pump() {
    while (active < size && waiting.length) {
      let i = waiting.findIndex(j => !j.low); if (i < 0) i = 0;   // a refusal never goes before a take, a reply that carries a result, or a read
      const j = waiting.splice(i, 1)[0]; active++;
      let done = false;
      const end = (v) => { if (done) return; done = true; clearTimeout(t); active--; j.resolve(v); pump(); };
      const t = setTimeout(() => end(null), limitMs); if (t.unref) t.unref();
      Promise.resolve().then(j.start).then(end, () => end(null));
    }
  }
  return {
    push(start, low) {
      return new Promise(resolve => {
        waiting.push({ start, resolve, low: !!low });
        if (low) { const lows = waiting.filter(j => j.low); if (lows.length > LOW_MAX) { waiting.splice(waiting.indexOf(lows[0]), 1); lows[0].resolve(null); onDrop(); } }
        pump();
      });
    },
    active: () => active, waiting: () => waiting.length
  };
}
const ENGINE_VERSION = "0.0.91";    // mds/dexicon's dapp.conf version of the vendored engine (the manifest's donor.mdsVersion; a test holds them equal)
const PRICE_HOST = "api.mexc.com";   // resting/price.js DEPTH_URL / BOOK_URL
const GECKO_HOST = "api.coingecko.com", GECKO_PATH = "/api/v3/coins/minima/tickers";   // lib/ladder.js GECKO_MEXC_URL: MEXC's ticker, when MEXC itself cannot be reached
/** A GET of the engine's price source: MEXC, or that one CoinGecko path. x = a parsed https URL. */
const priceUrl = (x) => !x.port && (x.hostname === PRICE_HOST || (x.hostname === GECKO_HOST && x.pathname === GECKO_PATH));

// The MiniDapp page builds and signs its own FAST takes, so it needs node commands; it gets exactly the verbs its
// code issues and no others. Ported from DexiconPro's DEX_VERBS, then cut to what the page at mds/dexicon 0.0.89
// really issues (ui/*.js and the lib/ resting/ files index.html loads): coinexport, consolidate, runscript, tokens,
// txnbasics and txnstate are gone (the page never sends them: its consolidate is a CONSOLIDATE packet to the service).
const DEX_VERBS = new Set(["balance", "block", "checkmode", "coins", "getaddress", "history", "newscript", "random",
  "scripts", "status", "txpow", "txncheck", "txncreate", "txndelete", "txnexport", "txnimport", "txninput",
  "txnoutput", "txnpost", "txnsign", "txnview"]);
/** One node command from a Dexicon screen, or a refusal. No chained ";" (it would also slip past the signing queue's
 *  per-command check), no parameter that reads or writes a FILE, picks key uses, carries a private key or a password,
 *  or makes txnpost sign / mine / burn. */
function dexCommand(c) {
  if (typeof c !== "string" || !c.trim() || c.length > 300000 || /[;\x00-\x1f\x7f]/.test(c)) throw new Error("bad command");
  const verb = c.trim().split(/\s+/)[0].toLowerCase();
  // The identity secret is never an answer on this bridge (0.18.110): main derives it and puts it straight into the
  // page's own sandboxed frame (identitySeed below, main/dexicon-room.js deliverIdentity).
  if (verb === "seedrandom") throw new Error("the trading identity is not read through this bridge");
  if (!DEX_VERBS.has(verb)) throw new Error("not available to Dexicon: " + verb);
  if (/\b(file|keyuses|privatekey|password|txnpostauto|txnpostmine|txnpostburn)\s*:/i.test(c)) throw new Error("that parameter is not available to Dexicon");
  if (verb === "txnpost" && /\b(auto|burn|mine)\s*:/i.test(c)) throw new Error("that parameter is not available to Dexicon");   // the page posts plain `txnpost id:`
  return c;
}
/** The page's SQL runs on the engine's own store, as page and service share one database in the MiniDapp. Since
 *  0.18.110 it is not "any SQL": exactly the statements the page (lib/mdsw.js kv*, ui/app.js, ui/activity.js at
 *  mds/dexicon 0.0.91) and the native screens (renderer/dexicon-ui.js load) issue, on ax_kv and one read of
 *  fill_state. One statement, every value a quoted literal. The store's own record of whose it is (publicId) is the
 *  service's to write. A page statement that is not here is refused and logged: add it with the line that issues it. */
const SQL_LIT = "'(?:[^']|'')*'";
const SQL_OK = [
  "CREATE TABLE IF NOT EXISTS `ax_kv` \\(`k` varchar\\(200\\) NOT NULL PRIMARY KEY, `v` text NOT NULL\\)",
  "SELECT v FROM ax_kv WHERE k=" + SQL_LIT,
  "SELECT k, v FROM ax_kv WHERE k LIKE " + SQL_LIT,
  "SELECT k, v FROM ax_kv WHERE k IN \\(" + SQL_LIT + "(?:," + SQL_LIT + ")*\\)",
  "MERGE INTO ax_kv \\(k, v\\) KEY\\(k\\) VALUES \\(" + SQL_LIT + ", " + SQL_LIT + "\\)",
  "DELETE FROM ax_kv WHERE k=" + SQL_LIT,
  "SELECT `json` FROM `fill_state` WHERE `id`=1"
].map(p => new RegExp("^" + p + "$"));
function dexSql(q) {
  if (typeof q !== "string" || !q.trim() || q.length > 1000000) throw new Error("bad query");
  if (!SQL_OK.some(re => re.test(q))) throw new Error("that statement is not available to Dexicon's screens");
  if (/^(MERGE INTO ax_kv \(k, v\) KEY\(k\) VALUES \(|DELETE FROM ax_kv WHERE k=)'publicId'/i.test(q)) throw new Error("that record is the engine's own");
  return q;
}

function makeHost(opts = {}) {
  const emitter = new EventEmitter();
  const net = () => opts.net || require("./netfetch");   // asked for at the first call, so a test's stand-in is all that ever loads
  const tickMs = opts.tickMs || TICK_MS;
  let dropped = 0;
  const netLimit = opts.netLimitMs || NET_LIMIT_MS;
  const work = makeLane(WORK_LANE, netLimit, () => { if (dropped++ % LOW_MAX === 0) log("more than " + LOW_MAX + " refusals to takers were waiting to be sent: the oldest are dropped (a refusal carries no signature; the taker voids an unanswered take by itself)"); });
  const polls = makeLane(POLL_LANE, netLimit, () => {});
  const OWN = { noRedirect: true, ownCap: true };   // netfetch: no redirects, and none of the shared four slots (this host bounds itself)
  // A message to a relay may be as large as the protocol allows (lib/envelope.js MAX_MSG_BYTES = 256K characters): a
  // sealed take is about eight times its transaction, so netfetch's 64K default refused every take over about 7.8 KB
  // of transaction ("no relay accepted the take", after the key uses were spent). Reached only past netAllowed().
  const OWN_POST = Object.assign({ maxBody: 256 * 1024 }, OWN);
  /** One relay or price request, in its lane. A GET that asks the relay to hold (a long poll) is a POLL; all else WORK. */
  const netGet = (url, alive) => (/[?&]hold=[1-9]/.test(url) ? polls : work).push(() => (alive() ? net().fetchJson(url, OWN) : null));
  const netPost = (url, body, alive, low) => work.push(() => (alive() ? net().postText(url, body, OWN_POST) : null), low);
  let dataDir = opts.dataDir || null;
  let ctx = null, sqlShim = null, serviceHandler = null, ready = false, initPromise = null, timer = null;
  let epoch = 0;   // bumped by drop(): everything built before it is disowned
  let asideOwed = false;   // the store on disk belongs to another wallet: it is moved aside before any store is opened
  let problem = "";        // why Dexicon is not running although the node is, in plain words (status().problem)
  let busy = 0, posts = 0;  // engine commands at the node, and the txnposts among them (STOP DRAINS)
  let draining = null;     // the promise of a stop() that is waiting for the engine to finish
  let held = false;        // HOLD (0.18.116): a command that may replace the wallet is running in the node; no engine, no bridge, until release()
  const HELD = "Dexicon is stopped while the wallet is being replaced. It starts again by itself.";
  // opts.signal: a SIGNING command still waiting in the process-wide queue (main/noderun.js) when its engine is
  // dropped is rejected there and never reaches the node (0.18.107)
  let runner = opts.runner || ((cmd, o) => {
    const config = require("./config"), node = require("./node-manager");
    return rpcCall(node.rpcPort(), config.rpcSecret(), cmd, o);
  });
  let abort = new AbortController();   // one per engine epoch: aborted by drop() (stop, invalidate, a foreign store)
  const LOG = [];

  function dir() { return dataDir || path.join(app.getPath("userData"), "dexicon"); }
  function storePath() { return path.join(dir(), "dexicon.sqlite"); }
  function log(line) {
    const s = new Date().toISOString().slice(11, 19) + " " + String(line).replace(/^\[dexicon\]\s*/, "");
    LOG.push(s); if (LOG.length > 300) LOG.shift();
    if (!opts.quiet) console.log("[dexicon]", s.slice(9));
    emitter.emit("log", s);
  }
  let vmJsonParse = null;
  /** Replies cross into the engine's realm as its own objects (Array.isArray, instanceof inside the vm). */
  function toVm(obj) {
    try {
      if (!ctx) return obj;
      if (!vmJsonParse) vmJsonParse = require("vm").runInContext("JSON.parse", ctx);
      return vmJsonParse(JSON.stringify(obj));
    } catch (e) { return obj; }
  }

  /** https only, and only a URL under one of the engine's current relays, or the MiniDapp's price source. */
  function netAllowed(u, method, noPrice) {
    let x; try { x = new URL(String(u)); } catch (e) { return false; }
    if (x.protocol !== "https:" || x.username || x.password) return false;
    if (priceUrl(x)) return method === "GET" && !noPrice;   // read, never written; never for the page
    let relays = []; try { relays = (ctx && ctx.DX && ctx.DX.relays()) || []; } catch (e) {}
    return relays.some(r => typeof r === "string" && /^https:\/\//.test(r) && x.href.startsWith(r + "/dex/"));   // x.href: dot segments already resolved
  }
  // Written to disk at once, not after the shim's 400 ms pause: the records a crash must not lose (takes sent, fills,
  // input claims, and the resting engine's own order / pending / ladder state).
  const WRITES_NOW = /fill_|pending_takes|void_takes|mm_cross_pending|pp_posted_inputs|pending_state|maker_state|my_orders|my_coins|cancelled_coins|processor_inflight/;

  function buildMds() {
    const mine = epoch, storage = sqlShim, live = () => mine === epoch, signal = abort.signal;
    return {
      minidappuid: "",
      cmd(command, cb) {
        const c = String(command);
        if (!live()) return cb(toVm({ status: false, error: "this wallet was replaced: the engine is restarting" }));
        // checkmode: the node RPC is the node's own admin interface, so the engine's WRITE-trust preflight always passes.
        if (/^checkmode\b/.test(c)) return cb(toVm({ status: true, response: { writemode: true, dblocked: false } }));
        // two-arg then(): one reply = exactly one cb call (the engine's signing lock is freed by that call and by nothing else)
        // The epoch is checked here, at entry; the signal covers what entry cannot: a signing command that is still
        // QUEUED behind another signer when the engine is dropped is never sent.
        const post = /^\s*txnpost\b/i.test(c); busy++; if (post) posts++;
        const end = (r) => { if (live()) { busy--; if (post) posts--; } cb(toVm(r)); };
        Promise.resolve().then(() => runner(c, { signal })).then(r => end(r && typeof r === "object" ? r : { status: false, error: "no reply" }),
          e => end({ status: false, error: (post && !notRun(e) ? UNANSWERED + ": " : "") + ((e && e.message) || String(e)) }));
      },
      sql(query, cb) {
        if (!live()) { if (cb) cb(toVm({ status: false, error: "this wallet was replaced" })); return; }
        const r = storage.sql(String(query));
        if (/^\s*(INSERT|UPDATE|MERGE|DELETE)/i.test(String(query)) && WRITES_NOW.test(String(query))) { try { storage.flush(); } catch (e) {} }
        if (cb) cb(toVm(r));
      },
      net: {
        GET(url, cb) {
          if (!live() || !netAllowed(url, "GET")) return cb(toVm({ status: false, error: "host not allowed" }));
          netGet(String(url), live).then(obj => cb(toVm(obj == null ? { status: false, error: "no reply" } : { status: true, response: obj })));
        },
        /** low (service.desktop.js reply): a refusal to a taker. It waits behind everything else and may be dropped. */
        POST(url, data, cb, low) {
          if (!live() || !netAllowed(url, "POST")) return cb(toVm({ status: false, error: "host not allowed" }));
          netPost(String(url), String(data), live, low === true).then(text => cb(toVm(text == null ? { status: false, error: "no reply" } : { status: true, response: text })));
        }
      },
      // the service's packets (STATE / ERROR / POSTED, fill, ladder) go to the screens, as MDS.comms does in the MiniDapp
      comms: { solo(message, cb) { if (live()) emitter.emit("comms", String(message)); if (cb) cb(toVm({ status: true })); } },
      notify(msg) { if (live()) emitter.emit("notify", String(msg)); },
      /** The service found that this store was written by another trading identity (service.desktop.js
       *  retireOldIdentity): it has not gone READY. The store is moved aside and an empty engine starts. */
      foreignStore(old, now) {
        if (!live()) return;
        log("WALLET CHANGED under Dexicon: the store belongs to trading identity " + old + ", this wallet is " + now + ". The store is being moved aside (never deleted); nothing was traded on it.");
        const again = !!timer;
        asideOwed = true; drop(); emitter.emit("update");
        if (again) init().catch(() => {});   // a failed move is tried again by the timer; the store is not opened before it worked
      },
      persistRecovery(cb) { cb(live() && !!storage.flushChecked()); },
      log(msg) { log(String(msg)); },
      init(cb) { serviceHandler = cb; }
    };
  }

  function fire(event, extra) { if (serviceHandler && !draining) { try { serviceHandler(toVm(Object.assign({ event }, extra))); } catch (e) { log("handler error: " + e.message); } } }

  async function init() {
    if (held) throw new Error(HELD);
    if (ready) return;
    if (initPromise) return initPromise;
    const mine = epoch;
    initPromise = (async () => {
      fs.mkdirSync(dir(), { recursive: true });
      if (asideOwed) aside();   // throws while it cannot be moved: the engine does not start on another wallet's store
      const shim = await makeSqlShim(storePath());
      if (mine !== epoch) return;   // the wallet was replaced while the store was opening: drop it, write nothing
      sqlShim = shim;
      ctx = createContext(buildMds());
      ready = true;
      fire("inited");
    })().catch(e => { if (mine === epoch) { initPromise = null; ready = false; ctx = null; sqlShim = null; serviceHandler = null; } if (lastInitError !== e.message) { lastInitError = e.message; log("init failed: " + e.message); } throw e; });
    return initPromise;
  }
  let lastInitError = "";
  /** Move the store aside under its dated name (main/restore.js moveAside; never deleted). Returns the kept path, ""
   *  when there was no file. Throws, with `problem` set, while the move fails: asideOwed stays, so nothing opens it. */
  function aside() {
    try {
      const kept = require("./restore").moveAside(storePath());
      asideOwed = false; problem = "";
      if (kept) log("the old wallet's Dexicon store is kept as " + kept);
      return kept;
    } catch (e) {
      problem = "The old wallet's Dexicon store could not be moved aside (" + e.message + "), so Dexicon is not running: it must not trade on another wallet's records. Free the file " + storePath() + " (close what holds it, or check the folder's permissions); Dexicon tries again by itself.";
      throw new Error(problem);
    }
  }
  /** Disown the engine: its late callbacks reach neither the node nor a store (epoch), what it wrote is on disk. */
  function drop() {
    epoch++;
    abort.abort(); abort = new AbortController();   // queued signers of the dropped engine are never sent
    flush();
    ctx = null; sqlShim = null; serviceHandler = null; ready = false; initPromise = null; vmJsonParse = null; lastTip = 0;
    busy = 0; posts = 0;   // the dropped engine's late answers are counted by nobody (its `end` still runs: see below)
  }

  // NEWBLOCK for the RESTING engine (the node pushes it to a MiniDapp; here the timer looks for a new tip)
  let lastTip = 0;
  function blockWatch() {
    Promise.resolve().then(() => runner("block")).then(r => { const t = Number(r && r.response && r.response.block) || 0; if (t > lastTip) { lastTip = t; fire("NEWBLOCK"); emitter.emit("update"); } }, () => {});
  }
  /** The trading identity's seed for the page, derived here in the main process (the node's one-way derivation, as
   *  the service's own). It is returned to main.js only, which puts it into the page's sandboxed frame and nowhere
   *  else: it never travels as an IPC answer, so the app's own window never holds it. Throws when it cannot be read. */
  async function identitySeed() {
    if (!ready) throw new Error("Dexicon is still starting");
    const r = await runner("seedrandom modifier:dexicon-identity-v1", { signal: abort.signal });
    const v = r && r.status === true && r.pending !== true && r.response ? String(r.response.seedrandom || "") : "";
    if (!/^0x[0-9A-Fa-f]{64}$/.test(v)) throw new Error((r && (r.error || r.message)) || "the node gave no derived seed (is it locked?)");
    return v;
  }

  let startedAt = 0;
  /** Start with the node (main.js calls this once the node is "running": after the wallet exists and the key-mode
   *  gate has passed). Nothing is sent to the node before that. */
  function start() {
    if (held || timer) return Promise.resolve();
    if (draining) return draining.then(start);   // the node is back before the last engine had finished
    startedAt = Date.now();
    timer = setInterval(() => { if (!ready) { init().catch(() => {}); return; } fire("MDS_TIMER_10SECONDS"); blockWatch(); }, tickMs);   // a failed init is tried again
    if (timer.unref) timer.unref();
    return init().then(() => { if (timer) blockWatch(); }, () => {});
  }
  /** Stop with the node: no timer, no block watch and no new event at once; the store written out; and the engine
   *  itself dropped once what it had in flight has ended (STOP DRAINS, header). The engine holds an identity derived
   *  from the node that just stopped; the node that starts next may hold another wallet (a restore, a resync, another
   *  data folder), so the next start() builds a new engine that derives it again and checks the store against it.
   *  Returns a promise: resolved when the engine is dropped. */
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (draining) return draining;
    if (!(ctx || initPromise)) { flush(); return Promise.resolve(); }
    flush();
    abort.abort();   // 0.18.107 still holds: a signer of this engine that is only QUEUED is never sent. What is AT the node ends, with what follows it.
    const mine = epoch, t0 = Date.now(), bound = opts.drainMs || DRAIN_MS;
    draining = (async () => {
      // quiet: nothing at the node and nothing in the WORK lane (the reply to the taker, the republished order), three looks running
      for (let quiet = 0; quiet < 3 && mine === epoch;) {
        await new Promise(r => setTimeout(r, 40));
        quiet = busy || work.active() || work.waiting() ? 0 : quiet + 1;
        if (Date.now() - t0 > bound && !posts) { if (quiet < 3) log("stopping: the engine was still working after " + Math.round(bound / 1000) + " s; no txnpost is unanswered, so it is dropped now"); break; }
      }
      draining = null;
      if (mine === epoch) { drop(); emitter.emit("update"); }
    })();
    emitter.emit("update");
    return draining;
  }
  function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) {} }
  /** HOLD: stopped, and not started again by a node status, the timer or a screen until release(). The store stays. */
  function hold() { if (!held) { held = true; log("held: a command that may replace the wallet is about to run"); } return stop(); }
  function release() { held = false; }   // main.js starts it again when the node is running

  /**
   * The wallet under the app was replaced (main/restore.js): the identity (seedrandom of the OLD seed), the orders it
   * signed and the fills it recorded belong to the old wallet. The store is MOVED ASIDE as
   * dexicon.sqlite-legacy-keys-YYYYMMDD, never deleted, and the engine starts again empty for the new wallet.
   * Returns the kept file's path ("" when there was none). Called by the MAIN process (main.js walletReplaced, from
   * node-manager's runResync) while the node is stopped, with hold: the engine then starts with the node, not before.
   * If the move fails this throws, and the move stays owed: no later start opens the store until it has worked.
   */
  function invalidate(o) {
    const again = !!timer && !(o && o.hold);
    if (timer) { clearInterval(timer); timer = null; }
    drop();                        // disown the old context and any init still opening the old store, BEFORE the move
    asideOwed = true;
    emitter.emit("update");
    let kept = "";
    try { kept = aside(); }
    catch (e) { log("wallet replaced: " + e.message); if (again) start(); throw e; }
    if (again) start();
    return kept;
  }

  const DX = () => { if (!ctx || !ctx.DX) throw new Error("Dexicon is still starting"); return ctx.DX; };
  const plain = (v) => JSON.parse(JSON.stringify(v));   // out of the engine's vm realm

  function status() {
    // epoch: which engine this is. The screens' hidden page frame belongs to one engine and is remade when it changes.
    const s = { version: ENGINE_VERSION, started: !!timer, problem, epoch, ready: false, restingReady: false, publicId: null, block: 0, relays: [],
      price: { mid: 0, ageMs: null, label: "", source: "" }, log: LOG.slice(-20) };
    try {
      if (!ctx || !ctx.DX || draining) return s;   // draining: this engine takes nothing new and is about to go
      s.ready = !!ctx.DX.ready(); s.restingReady = !!ctx.DX.restingReady(); s.publicId = s.ready ? String(ctx.DX.publicId()) : null;
      s.block = ctx.DX.block(); s.relays = plain(ctx.DX.relays());
      const P = ctx.PandaPrice, age = P.ageMs();
      // source: the engine's own field (lib/ladder.js feed): "MEXC", or "MEXC via CoinGecko" when the last read was the fallback
      s.price = { mid: P.mid(), ageMs: age >= Number.MAX_SAFE_INTEGER ? null : age, label: String(P.stateLabel()), source: P.mid() > 0 ? String(P.source || "MEXC") : "" };
    } catch (e) {}
    return s;
  }
  /** FAST + on-chain + pool levels, each source apart, `ours` / `mine` marked (service.desktop.js mergedBook). */
  function book() { try { return ctx && ctx.DX && ctx.DX.ready() ? JSON.parse(ctx.DX.book()) : null; } catch (e) { return null; } }
  /** this node's own on-chain orders + those waiting for a block */
  function mine() { try { return ctx && ctx.DX ? JSON.parse(ctx.DX.mine()) : { orders: [], pending: [] }; } catch (e) { return { orders: [], pending: [] }; } }

  /**
   * What a wallet replacement would strand (main/restore.js activeWorkList): this node's on-chain orders (only the old
   * wallet's keys can cancel or collect them), placements still waiting for a block, and takes sent but not yet
   * answered (voiding one spends a coin of the old wallet). FAST orders are not listed: they are signed offers with no
   * coin locked, and they lapse on the relays by themselves. Not booted: { ready:false, hasStore }.
   */
  async function activeWork() {
    // Takes awaiting an answer (signed and sent, not yet co-signed; or being voided): the page's own records, which it
    // writes BEFORE it sends. Read from the store, so they are counted whether or not any screen is open.
    const kv = (k) => { const r = sqlShim.sql("SELECT v FROM ax_kv WHERE k='" + k + "'"); if (!r.status) throw new Error(r.error); return r.rows.length ? JSON.parse(r.rows[0].V || "{}") || {} : {}; };
    const takes = () => Object.keys(kv("pending_takes")).length + Object.keys(kv("void_takes")).length;
    if (!ctx || !ctx.DX || !ctx.DX.restingReady()) {
      const w = { ready: false, hasStore: fs.existsSync(storePath()), waitedMs: timer && startedAt ? Date.now() - startedAt : 0 };   // waitedMs: main/restore.js lets the user go on after two minutes of this
      if (sqlShim && ctx && ctx.DX && ctx.DX.ready()) { try { w.takes = takes(); } catch (e) {} }   // the FAST half is up: its takes are known even while the chain is still being read
      return w;
    }
    const m = mine();
    return { ready: true, orders: m.orders.map(o => String(o.coinid)), pending: m.pending.length, takes: takes() };
  }

  // ---- the command bridge: what a Dexicon screen (the MiniDapp page's MDS) may ask for ----
  function pageCmd(command) {
    const c = dexCommand(command);
    if (/^checkmode\b/.test(c)) return Promise.resolve({ status: true, response: { writemode: true, dblocked: false } });
    const signal = abort.signal;   // the page's take, queued behind another signer when the engine is dropped, is not sent either
    return Promise.resolve().then(() => runner(c, { signal })).then(r => (r && typeof r === "object" ? r : { status: false, error: "no reply" }), e => ({ status: false, error: (e && e.message) || String(e) }));
  }
  function pageSql(query) {
    let q; try { q = dexSql(query); } catch (e) { log("refused SQL from a screen (" + e.message + "): " + String(query).slice(0, 80)); throw e; }
    if (!sqlShim) return Promise.reject(new Error("Dexicon is still starting"));
    const r = sqlShim.sql(q);
    if (/^\s*(INSERT|UPDATE|MERGE|DELETE)/i.test(q) && WRITES_NOW.test(q)) { try { sqlShim.flush(); } catch (e) {} }
    return Promise.resolve(r);
  }
  /** a page MDS.comms.solo → the service's MDSCOMMS event. Only the page's own two origins. */
  function pageComms(message) {
    if (typeof message !== "string" || message.length > 100000) throw new Error("bad message");
    let p = null; try { p = JSON.parse(message); } catch (e) { p = null; }
    if (!p || (p.origin !== "ui" && p.origin !== "dexicon") || typeof p.type !== "string") throw new Error("bad message");
    DX();   // not booted: say so instead of dropping the packet
    fire("MDSCOMMS", { data: { public: false, message } });
    return { status: true };
  }
  /** The page's relay transport (its XMLHttpRequest, renderer/dexicon/mds.js): only a URL under one of the engine's
   *  current relays, https, no redirects. Not the price host: the page asks no exchange for anything. The reply is
   *  text, as an XMLHttpRequest gives it. */
  function pageNet(a) {
    const method = a && a.method === "POST" ? "POST" : "GET", url = String((a && a.url) || "");
    if (!ready || !netAllowed(url, method, true)) return Promise.resolve({ status: false, error: "host not allowed" });
    const mine = epoch, alive = () => mine === epoch;   // the page's take carries a signature: WORK lane, never low, never dropped
    const asked = method === "POST" ? netPost(url, String(a.body == null ? "" : a.body), alive, false) : netGet(url, alive).then(o => (o == null ? null : JSON.stringify(o)));
    return asked.then(text => (text == null ? { status: false, error: "no reply" } : { status: true, response: String(text) }));
  }
  /** The one entry for the screens: { op: "cmd", command } | { op: "sql", query } | { op: "comms", message } | { op: "net", method, url, body }. */
  async function command(a) {
    if (held) throw new Error(HELD);   // the page's own txnsign / txnpost included
    const op = a && a.op;
    if (op === "cmd") return pageCmd(a.command);
    if (op === "sql") return pageSql(a.query);
    if (op === "comms") return pageComms(a.message);
    if (op === "net") return pageNet(a);
    throw new Error("unknown Dexicon op");
  }

  return { emitter, init, start, stop, hold, release, flush, invalidate, status, activeWork, book, mine, command, storePath,
    identitySeed,
    _sql: (q) => { const r = sqlShim.sql(String(q)); try { sqlShim.flush(); } catch (e) {} return r; },   // tests only: any statement, on the open store
    _lanes: () => ({ work: work.active(), workWaiting: work.waiting(), polls: polls.active(), pollsWaiting: polls.waiting(), dropped }),
    _setRunner: (fn) => { runner = fn; }, _setDataDir: (d) => { dataDir = d; }, _ctx: () => ctx, _fire: fire, _netAllowed: netAllowed };
}

const host = makeHost();   // the app's one Dexicon engine (main.js); tests build their own with makeHost(opts)
module.exports = Object.assign(host, { makeHost, dexCommand, dexSql, DEX_VERBS, ENGINE_VERSION, UNANSWERED });
