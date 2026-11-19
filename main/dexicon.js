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
  if (verb === "seedrandom") { if (c.trim() !== "seedrandom modifier:dexicon-identity-v1") throw new Error("only the Dexicon identity derivation"); return c.trim(); }
  if (!DEX_VERBS.has(verb)) throw new Error("not available to Dexicon: " + verb);
  if (/\b(file|keyuses|privatekey|password|txnpostauto|txnpostmine|txnpostburn)\s*:/i.test(c)) throw new Error("that parameter is not available to Dexicon");
  if (verb === "txnpost" && /\b(auto|burn|mine)\s*:/i.test(c)) throw new Error("that parameter is not available to Dexicon");   // the page posts plain `txnpost id:`
  return c;
}
/** The page's SQL runs on the engine's own store, as page and service share one database in the MiniDapp. */
function dexSql(q) {
  if (typeof q !== "string" || !q.trim() || q.length > 1000000) throw new Error("bad query");
  return q;
}

function makeHost(opts = {}) {
  const emitter = new EventEmitter();
  const net = () => opts.net || require("./netfetch");   // asked for at the first call, so a test's stand-in is all that ever loads
  const tickMs = opts.tickMs || TICK_MS;
  let dataDir = opts.dataDir || null;
  let ctx = null, sqlShim = null, serviceHandler = null, ready = false, initPromise = null, timer = null;
  let epoch = 0;   // bumped by drop(): everything built before it is disowned
  let asideOwed = false;   // the store on disk belongs to another wallet: it is moved aside before any store is opened
  let problem = "";        // why Dexicon is not running although the node is, in plain words (status().problem)
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
        Promise.resolve().then(() => runner(c, { signal })).then(r => cb(toVm(r && typeof r === "object" ? r : { status: false, error: "no reply" })),
                                                   e => cb(toVm({ status: false, error: (e && e.message) || String(e) })));
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
          net().fetchJson(String(url), { noRedirect: true }).then(obj => cb(toVm(obj == null ? { status: false, error: "no reply" } : { status: true, response: obj })),
                                                              e => cb(toVm({ status: false, error: (e && e.message) || "net failed" })));
        },
        POST(url, data, cb) {
          if (!live() || !netAllowed(url, "POST")) return cb(toVm({ status: false, error: "host not allowed" }));
          net().postText(String(url), String(data)).then(text => cb(toVm(text == null ? { status: false, error: "no reply" } : { status: true, response: text })),
                                                       e => cb(toVm({ status: false, error: (e && e.message) || "net failed" })));
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

  function fire(event, extra) { if (serviceHandler) { try { serviceHandler(toVm(Object.assign({ event }, extra))); } catch (e) { log("handler error: " + e.message); } } }

  async function init() {
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
  }

  // NEWBLOCK for the RESTING engine (the node pushes it to a MiniDapp; here the timer looks for a new tip)
  let lastTip = 0;
  function blockWatch() {
    Promise.resolve().then(() => runner("block")).then(r => { const t = Number(r && r.response && r.response.block) || 0; if (t > lastTip) { lastTip = t; fire("NEWBLOCK"); emitter.emit("update"); } }, () => {});
  }
  /** Start with the node (main.js calls this once the node is "running": after the wallet exists and the key-mode
   *  gate has passed). Nothing is sent to the node before that. */
  function start() {
    if (timer) return Promise.resolve();
    timer = setInterval(() => { if (!ready) { init().catch(() => {}); return; } fire("MDS_TIMER_10SECONDS"); blockWatch(); }, tickMs);   // a failed init is tried again
    if (timer.unref) timer.unref();
    return init().then(() => { if (timer) blockWatch(); }, () => {});
  }
  /** Stop with the node: no timer, no block watch, the store written out, and the engine itself dropped. The engine
   *  holds an identity derived from the node that just stopped; the node that starts next may hold another wallet (a
   *  restore, a resync, another data folder), so the next start() builds a new engine that derives it again and checks
   *  the store against it. */
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (ctx || initPromise) { drop(); emitter.emit("update"); } else flush();
  }
  function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) {} }

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
    const s = { version: ENGINE_VERSION, started: !!timer, problem, ready: false, restingReady: false, publicId: null, block: 0, relays: [],
      price: { mid: 0, ageMs: null, label: "", source: "" }, log: LOG.slice(-20) };
    try {
      if (!ctx || !ctx.DX) return s;
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
    if (!ctx || !ctx.DX || !ctx.DX.restingReady()) return { ready: false, hasStore: fs.existsSync(storePath()) };
    const m = mine(), kv = async (k) => { const r = sqlShim.sql("SELECT v FROM ax_kv WHERE k='" + k + "'"); if (!r.status) throw new Error(r.error); return r.rows.length ? JSON.parse(r.rows[0].V || "{}") || {} : {}; };
    return { ready: true, orders: m.orders.map(o => String(o.coinid)), pending: m.pending.length,
      takes: Object.keys(await kv("pending_takes")).length + Object.keys(await kv("void_takes")).length };
  }

  // ---- the command bridge: what a Dexicon screen (the MiniDapp page's MDS) may ask for ----
  function pageCmd(command) {
    const c = dexCommand(command);
    if (/^checkmode\b/.test(c)) return Promise.resolve({ status: true, response: { writemode: true, dblocked: false } });
    const signal = abort.signal;   // the page's take, queued behind another signer when the engine is dropped, is not sent either
    return Promise.resolve().then(() => runner(c, { signal })).then(r => (r && typeof r === "object" ? r : { status: false, error: "no reply" }), e => ({ status: false, error: (e && e.message) || String(e) }));
  }
  function pageSql(query) {
    const q = dexSql(query);
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
    const asked = method === "POST" ? net().postText(url, String(a.body == null ? "" : a.body)) : net().fetchJson(url, { noRedirect: true }).then(o => (o == null ? null : JSON.stringify(o)));
    return Promise.resolve(asked).then(text => (text == null ? { status: false, error: "no reply" } : { status: true, response: String(text) }), e => ({ status: false, error: (e && e.message) || "net failed" }));
  }
  /** The one entry for the screens: { op: "cmd", command } | { op: "sql", query } | { op: "comms", message } | { op: "net", method, url, body }. */
  async function command(a) {
    const op = a && a.op;
    if (op === "cmd") return pageCmd(a.command);
    if (op === "sql") return pageSql(a.query);
    if (op === "comms") return pageComms(a.message);
    if (op === "net") return pageNet(a);
    throw new Error("unknown Dexicon op");
  }

  return { emitter, init, start, stop, flush, invalidate, status, activeWork, book, mine, command, storePath,
    _setRunner: (fn) => { runner = fn; }, _setDataDir: (d) => { dataDir = d; }, _ctx: () => ctx, _fire: fire, _netAllowed: netAllowed };
}

const host = makeHost();   // the app's one Dexicon engine (main.js); tests build their own with makeHost(opts)
module.exports = Object.assign(host, { makeHost, dexCommand, dexSql, DEX_VERBS, ENGINE_VERSION });
