/*
 * atomix.js — the desktop orchestrator for the AtomiX atomic-swap module (DESKTOP-ONLY glue; the engine under
 * main/atomix/ is a BYTE-IDENTICAL copy of ~/Projects/atomix-mds and runs VERBATIM in a vm — see loader.js).
 * Mirrors main/pandapools.js: build the MDS shim, init idempotently, drive the engine with the same three
 * events every peer uses (inited / NEWBLOCK / MDS_TIMER_60SECONDS), expose a JSON-safe read-model + promise-
 * wrapped actions to the renderer over IPC.
 *
 * THE GLUE RULE (the pandapools 752264c lesson, written in blood): every action here mirrors the donor's
 * app.js flow EXACTLY — frozen review data, makerLive re-check at lock time, raw-balance send validation,
 * review-then-broadcast. No desktop-side re-quoting, no improvised guards, no dropped displays.
 */
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");
const { rpcCall } = require("./rpc");
const { createContext } = require("./atomix/loader");
const { makeSqlShim } = require("./pandapools/sqlshim");   // the proven generic H2→SQLite shim (3rd instance)
const netfetch = require("./netfetch");
// electron/config/node-manager are lazy so the headless gate harness can drive this module bare-node
// via _setRunner/_setDataDir (one implementation for tests AND the app — no harness drift).
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();

// Outbound HTTP allowlist for the engine's MDS.net — the ETH JSON-RPC endpoints baked into the engine
// (lib/ethhtlc.js NET.rpcs) + the MEXC feed. Anything else is refused here regardless of what the vm asks for.
const NET_HOSTS = new Set([
  "ethereum-rpc.publicnode.com", "eth.drpc.org", "eth-mainnet.public.blastapi.io", "eth-pokt.nodies.app",
  "eth.api.onfinality.io", "api.zan.top", "eth.rpc.blxrbdn.com", "gateway.tenderly.co", "1rpc.io",
  "api.mexc.com"
]);
function allowedUrl(u) {
  try { return NET_HOSTS.has(new URL(String(u)).hostname); } catch (e) { return false; }
}

let ctx = null;               // the vm context (ctx.AX / ctx.READY / ctx.CTX)
let sqlShim = null;
let serviceHandler = null;    // captured by MDS.init — WE fire the events
let ready = false;            // orchestrator init done (engine boot is async + self-healing inside the vm)
let initPromise = null;
let pollTimer = null, minuteTimer = null, lastTip = null;
let dataDir = null;
let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
const LOG_RING = [];          // last engine log lines for the renderer/status
const SCAN_EVERY_MS = 12000;

function dir() { return dataDir || app.getPath("userData"); }
function log(line) {
  line = String(line).replace(/^\[atomix\]\s*/, "");   // the engine's own MDS.log lines carry the prefix already
  const entry = new Date().toISOString().slice(11, 19) + " " + line;
  LOG_RING.push(entry); if (LOG_RING.length > 200) LOG_RING.shift();
  console.log("[atomix]", line);
}

function buildMds() {
  return {
    minidappuid: "",
    cmd(command, cb) {
      // two-arg then (pandapools pattern): a throw inside the success cb must not double-fire the cb
      runner(String(command)).then(r => cb(r), () => cb({ status: false }));
    },
    sql(query, cb) {
      sqlShim.sql(query, cb);
      // FUND-SAFETY DURABILITY: the H2 peers persist synchronously; our sqlite image is debounced 400ms. A
      // crash in that window after a SECRET write (the preimage that claims a leg) would degrade an in-flight
      // swap to refund-only — so secret writes flush the image synchronously. Rare row class; cost is trivial.
      if (/INSERT INTO `secrets`/i.test(String(query))) { try { sqlShim.flush(); } catch (e) {} }
    },
    net: {
      GET(url, cb) {
        if (!allowedUrl(url)) return cb({});
        netfetch.fetchJson(String(url)).then(obj => cb(obj == null ? {} : { response: obj }), () => cb({}));
      },
      POST(url, data, cb) {
        if (!allowedUrl(url)) return cb({});
        netfetch.postText(String(url), String(data)).then(text => cb(text == null ? {} : { response: text }), () => cb({}));
      }
    },
    notify(msg) { log("notify: " + msg); emitter.emit("notify", String(msg)); },
    log(msg) { log(String(msg)); emitter.emit("update"); },
    init(cb) { serviceHandler = cb; }
    // .load is attached by loader.createContext (path-jailed file loader for service.js's own manifest)
  };
}

function fire(event) { if (serviceHandler) { try { serviceHandler({ event }); } catch (e) { log("handler error: " + e.message); } } }

async function init() {
  if (ready) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    sqlShim = await makeSqlShim(path.join(dir(), "atomix.sqlite"));
    ctx = createContext(buildMds());
    ready = true;
    fire("inited");            // service.js tryBoot: trust preflight → vault/seedrandom → engines → poll.
  })().catch(e => { initPromise = null; ready = false; log("init failed: " + e.message); throw e; });
  return initPromise;
}

function startLoop() {
  if (pollTimer) return;
  const tick = () => init().then(() => {
    runner("block").then(r => {
      const tip = r && r.response && (r.response.block || r.response);
      if (tip && tip !== lastTip) { lastTip = tip; fire("NEWBLOCK"); emitter.emit("update"); }
    }).catch(() => {});
  }).catch(() => {});
  tick();
  pollTimer = setInterval(tick, SCAN_EVERY_MS);
  minuteTimer = setInterval(() => { if (ready) { fire("MDS_TIMER_60SECONDS"); emitter.emit("update"); } }, 60000);
}
function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
}

function flush() { try { if (sqlShim) sqlShim.flush(); } catch (e) {} }

/** Wallet/seed restore: the engine identity + swap DB belong to the OLD seed — wipe and re-init (mirrors
 *  pandapools.invalidate / mailInvalidate). */
function invalidate() {
  stopLoop();
  flush();
  try { fs.unlinkSync(path.join(dir(), "atomix.sqlite")); } catch (e) {}
  ctx = null; sqlShim = null; serviceHandler = null; ready = false; initPromise = null; lastTip = null;
  emitter.emit("update");
  startLoop();
}

/** Engine status for the renderer header: booted?, identity, block, active currency, recent log lines. */
function status() {
  const booted = !!(ctx && ctx.READY);
  return {
    ready: booted,
    eth: booted && ctx.CTX && ctx.CTX.eth ? ctx.CTX.eth.address : null,
    minimaPk: booted && ctx.CTX && ctx.CTX.htlc ? ctx.CTX.htlc.publickey : null,
    currency: ctx && ctx.AX ? ctx.AX.trading.active().key : null,
    block: lastTip,
    log: LOG_RING.slice(-30)
  };
}

module.exports = {
  emitter, init, startLoop, stopLoop, flush, invalidate, status,
  _setRunner: (fn) => { runner = fn; }, _setDataDir: (d) => { dataDir = d; },
  _ctx: () => ctx, _fire: fire
};
