#!/usr/bin/env node
/*
 * e2e-pandapools-private-chain.cjs — MANUAL proof of PandaPools (and the Dexicon on-chain engine's start) against a
 * THROWAWAY PRIVATE test chain. NEVER in CI, never a test:* script, never against a node holding funds.
 *
 *   node scripts/e2e-pandapools-private-chain.cjs --rpc-port 29005 --rpc-password <pw> --node-data <the node's -data dir> --out <empty dir>
 *
 * It drives the REAL host shim (main/pandapools.js: its runtime-guard hook, the process-wide signing queue and coin
 * reservation inside main/rpc.js rpcCall, its serial action queue) over the REAL vendored engine (main/pandapools/), and
 * the REAL Dexicon host (main/dexicon.js + main/dexicon/service.desktop.js), on the node at 127.0.0.1:<port>. Nothing the
 * engines send is stubbed. Stand-ins only for what is not the node: electron (paths), config (the RPC password),
 * node-manager (the port and data folder) and netfetch (REFUSES every request: no other machine is ever contacted).
 *
 * It REFUSES to run unless: the port is 29000 or above; the node's `status` says a -TEST chain with 0 peers connected or
 * connecting; `network` says p2p disabled; and the chain's block 1 is less than a day old (a fresh private genesis).
 * MxUSD does not exist on a private chain: the pools are of a token this script mints (tokencreate, 8 decimals), given
 * to createPool through _setCreateTokenForPrivateChainProof (refused in a packaged app; see main/pandapools.js).
 */
"use strict";
const fs = require("fs"), path = require("path"), Module = require("module");
const root = path.resolve(__dirname, "..");
const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg("rpc-port")), PW = arg("rpc-password") || "", NODE_DATA = arg("node-data"), OUT = arg("out");
const IDLE_BLOCKS = Number(arg("idle-blocks") || 8);
function refuse(why) { console.error("REFUSED: " + why + ". Nothing was sent."); process.exit(2); }
if (!Number.isInteger(PORT) || PORT < 29000 || PORT > 65535) refuse("--rpc-port must be given and be 29000 or above (the owner's nodes live below)");
if (!NODE_DATA || !fs.existsSync(NODE_DATA)) refuse("--node-data must name the throwaway node's -data folder");
if (!OUT) refuse("--out must name an output folder");
fs.mkdirSync(OUT, { recursive: true });
if (fs.readdirSync(OUT).length) refuse("--out must be empty");

// ---- stand-ins for what is not the node (installed before anything of the app loads) ----
const netCalls = [];
const electronStub = { app: { getPath: () => OUT, getVersion: () => "e2e", isPackaged: false } };
const origLoad = Module._load;
Module._load = function (req) { if (req === "electron") return electronStub; return origLoad.apply(this, arguments); };
function stub(rel, exportsObj) { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj, children: [], paths: [] }; }
const nodeLog = [];
const nodeStub = { rpcPort: () => PORT, dataDir: () => NODE_DATA, health: { locked: false }, log: (l) => nodeLog.push(String(l)), state: "running", on() {} };
stub("main/config.js", { rpcSecret: () => PW, load: () => ({}) });
stub("main/node-manager.js", nodeStub);
stub("main/netfetch.js", { fetchJson: async (u) => { netCalls.push("GET " + u); return null; }, postText: async (u) => { netCalls.push("POST " + u); return null; } });

// ---- the real transport, observed (every command, its owner and its answer) ----
const rpc = require(path.join(root, "main/rpc.js"));
const t0 = Date.now(), cmdLog = fs.createWriteStream(path.join(OUT, "commands.log"));
const posts = [];   // every txnpost any engine sent: { t, owner, txid, txpowid, status, error }
const realRpcCall = rpc.rpcCall;
rpc.rpcCall = function (port, secret, command, opts) {
  const owner = (opts && opts.owner) || "wallet", at = Date.now() - t0;
  return realRpcCall(port, secret, command, opts).then((r) => {
    cmdLog.write(at + "ms " + owner + " " + command + " -> " + (r && r.status) + (r && r.error ? " ERROR " + r.error : "") + "\n");
    if (/^txnpost\b/.test(command)) { const m = /id:(\S+)/.exec(command); const resp = r && r.response; posts.push({ t: at, owner, txid: m && m[1], txpowid: resp && (resp.txpowid || (resp.txpow && resp.txpow.txpowid)) || "", status: r && r.status, error: r && r.error || "" }); }
    return r;
  }, (e) => { cmdLog.write(at + "ms " + owner + " " + command + " -> THREW " + e.message + "\n"); throw e; });
};
const node = (c) => rpc.rpcCall(PORT, PW, c, { owner: "harness" });
const read = (c) => rpc.rpcRead(PORT, PW, c);

// ---- the real engine loader, observed (to read the context the host builds) ----
const loader = require(path.join(root, "main/pandapools/loader.js"));
let ppCtx = null; const realCreate = loader.createContext;
loader.createContext = function () { const c = realCreate.apply(this, arguments); ppCtx = c; return c; };
const reserve = require(path.join(root, "main/reserve.js"));
const reserveLog = []; reserve.onLog = (l) => reserveLog.push(l);
const pp = require(path.join(root, "main/pandapools.js"));

// ---- helpers ----
const transcript = [];
function say(step, detail) { const line = { t: Date.now() - t0, step, ...detail }; transcript.push(line); console.log(JSON.stringify(line)); fs.writeFileSync(path.join(OUT, "transcript.json"), JSON.stringify(transcript, null, 1)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, ms = 300000, every = 2000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting for " + label); await sleep(every); } }
const ok = (r, what) => { if (!r || r.status !== true) throw new Error(what + ": " + JSON.stringify(r && (r.error || r.response))); return r.response; };
let D = null;
const dec = (v) => new D(String(v));
async function tip() { return Number(ok(await read("block"), "block").block); }
async function balanceOf(tokenid) { const rows = ok(await read("balance"), "balance"); return rows.find((b) => String(b.tokenid).toLowerCase() === tokenid.toLowerCase()) || null; }
const sqlRows = (q) => new Promise((r) => ppCtx.MDS.sql(q, (res) => r(res && res.rows || [])));
const scan = () => new Promise((r) => ppCtx.Book.scan((ps) => r(ps || [])));
const poolsOf = (ps, tok) => ps.filter((p) => p.tok && p.tok.toLowerCase() === tok.toLowerCase() && p.reserveM && p.reserveT);
const plain = (d) => ppCtx.PP.plain(d);

async function guardChain() {
  const st = ok(await read("status"), "status"), net = ok(await read("network"), "network");
  const g = ok(await read("txpow block:1"), "txpow block:1"), born = Number(g.header && g.header.timemilli);
  const why = !/-TEST/.test(String(st.version)) ? "not a -test chain (" + st.version + ")"
    : (Number(st.network.connected) !== 0 || Number(st.network.connecting) !== 0) ? "the node has peers (" + st.network.connected + " connected, " + st.network.connecting + " connecting)"
    : (net.details && net.details.p2p) !== "disabled" ? "p2p is not disabled (" + (net.details && net.details.p2p) + ")"
    : !(born > 0 && Date.now() - born < 86400000) ? "block 1 is not less than a day old (" + new Date(born).toISOString() + ")" : "";
  if (why) refuse(why);
  return { version: st.version, block: st.chain.block, genesisTime: new Date(born).toISOString(), peers: 0, p2p: net.details.p2p };
}

async function checkSwap(label, before, route, minimaToToken, res, tok, trader) {
  const txpowid = res.txpowid;
  if (!/^0x[0-9A-F]{64}$/i.test(String(txpowid))) throw new Error(label + ": no txpowid: " + JSON.stringify(res));
  const expect = route.allocs.map((a) => ({ address: a.pool.address, oldM: a.pool.coinidM, oldT: a.pool.coinidT, beforeM: plain(a.pool.reserveM), beforeT: plain(a.pool.reserveT), newX: plain(a.quote.newX), newY: plain(a.quote.newY) }));
  // mined: every pool input spent and the pool re-created with exactly the quoted reserves
  const after = await waitFor(label + " mined", async () => {
    for (const e of expect) for (const id of [e.oldM, e.oldT]) { const c = ok(await read("coins coinid:" + id), "coins coinid"); if (c.length) return null; }
    const ps = poolsOf(await scan(), tok);
    for (const e of expect) { const p = ps.find((x) => x.address === e.address); if (!p || p.coinidM === e.oldM) return null; }
    return ps;
  }, 300000, 3000);
  const pools = expect.map((e) => { const p = after.find((x) => x.address === e.address); return { ...e, afterM: plain(p.reserveM), afterT: plain(p.reserveT), coinidM: p.coinidM, coinidT: p.coinidT,
    exact: dec(p.reserveM).eq(dec(e.newX)) && dec(p.reserveT).eq(dec(e.newY)) }; });
  if (!pools.every((p) => p.exact)) throw new Error(label + ": reserves differ from the quote: " + JSON.stringify(pools));
  // the trader's output: in the mined transaction, at a wallet address, of the quoted amount, and an unspent coin of the wallet
  // txnpost answers the txpowid BEFORE the node mines it (mining changes the id): the mined transaction is found in the
  // block that created the new pool coins, by its inputs (the old pool coins); the engine's own ActivityChain maps the
  // posted id to it by transaction id (pp_submissions), which is checked against it below
  const created = Number(ok(await read("coins coinid:" + pools[0].coinidM), "coins coinid")[0].created);
  const blk = ok(await read("txpow block:" + created), "txpow block");
  const cands = (blk.istransaction ? [blk.txpowid] : []).concat(blk.body.txnlist || []);
  let tx = null;
  for (const id of cands) { const t = id === blk.txpowid ? blk : ok(await read("txpow txpowid:" + id), "txpow"); const ins = (t.body.txn.inputs || []).map((c) => c.coinid); if (expect.every((e) => ins.includes(e.oldM) && ins.includes(e.oldT))) { tx = t; break; } }
  if (!tx) throw new Error(label + ": no transaction in block " + created + " spends the pool coins");
  const sub = await sqlRows("SELECT postedid, transactionid FROM pp_submissions WHERE LOWER(postedid)='" + txpowid.toLowerCase() + "'");
  const outs = (tx.body && tx.body.txn && tx.body.txn.outputs) || [];
  const outTok = minimaToToken ? tok : "0x00", want = dec(plain(route.totalOut));
  const mine = outs.filter((o) => !expect.some((e) => e.address === o.address) && String(o.tokenid).toLowerCase() === outTok.toLowerCase()
    && dec(outTok === "0x00" ? o.amount : (o.tokenamount || o.amount)).eq(want));
  if (mine.length !== 1) throw new Error(label + ": the trader's output of " + plain(route.totalOut) + " is not in the transaction: " + JSON.stringify(outs));
  const coin = await waitFor(label + " output coin", async () => { const cs = ok(await read("coins relevant:true address:" + mine[0].address), "coins"); return cs.find((c) => String(c.tokenid).toLowerCase() === outTok.toLowerCase() && dec(outTok === "0x00" ? c.amount : (c.tokenamount || c.amount)).eq(want)); }, 120000);
  const act = await sqlRows("SELECT type, summary, txpowid, status FROM pp_activity WHERE txpowid='" + txpowid + "'");
  const tl = ok(await read("txnlist"), "txnlist");
  const locks = await sqlRows("SELECT coinid, ts FROM pp_coinlocks"), signlock = await sqlRows("SELECT * FROM pp_signlock"), claims = await sqlRows("SELECT coinid FROM pp_posted_inputs");
  const held = reserve.list ? reserve.list() : null;
  say(label, { txpowid, minedTxpowid: tx.txpowid, inBlock: created, transactionid: tx.body.txn.transactionid, engineSubmission: sub, minimaToToken, totalIn: plain(route.totalIn), totalOut: plain(route.totalOut), poolsUsed: route.poolsUsed, pools,
    traderOutput: { address: mine[0].address, coinid: coin.coinid, amount: outTok === "0x00" ? coin.amount : (coin.tokenamount || coin.amount), tokenid: coin.tokenid },
    activity: act, txnlist: tl.map((t) => t.id), coinlocks: locks, signlock, postedInputClaims: claims.map((c) => c.COINID || c.coinid), reservations: held });
  if (act.length !== 1) throw new Error(label + ": pp_activity has " + act.length + " rows for " + txpowid);
  return after;
}

async function swapStep(label, tok, minimaToToken, amount) {
  const ps = poolsOf(await scan(), tok);
  const route = ppCtx.Router.route(ps, minimaToToken, amount);   // the same pure function quoteSwap runs, on the same pools
  await pp.scanNow();
  const q = pp.quoteSwap(tok, minimaToToken, amount);
  if (!q.ok) throw new Error(label + ": no quote " + JSON.stringify(q));
  if (q.totalOut !== plain(route.totalOut) || q.totalIn !== plain(route.totalIn)) throw new Error(label + ": the host's quote " + JSON.stringify(q) + " is not the route " + plain(route.totalIn) + " -> " + plain(route.totalOut));
  say(label + " quote", { quote: q, allocs: route.allocs.map((a) => ({ pool: a.pool.address, in: plain(a.quote.dx || a.quote.amountIn || a.quote.in || 0), newX: plain(a.quote.newX), newY: plain(a.quote.newY) })) });
  const res = await pp.swap(q.quoteId);
  say(label + " posted", res);
  return checkSwap(label, ps, route, minimaToToken, res, tok);
}

(async () => {
  const chain = await guardChain();
  say("chain", chain);
  const me = ok(await node("getaddress"), "getaddress");
  // 1. mined MINIMA, then a few coins to fund several transactions without waiting for change each time
  await waitFor("sendable MINIMA", async () => { const b = await balanceOf("0x00"); return b && Number(b.sendable) >= 100000000; });
  const split = ok(await node("send amount:400000000 address:" + me.address + " split:8"), "send split");
  say("split wallet", { txpowid: split.txpowid });
  await waitFor("split confirmed", async () => { const b = await balanceOf("0x00"); return b && Number(b.coins) >= 8 && Number(b.unconfirmed) === 0 && Number(b.sendable) > 0; });
  // 2. a test token, 8 decimals
  const had = ok(await read("balance"), "balance").map((b) => b.tokenid);
  const tc = ok(await node("tokencreate name:E2ETOKEN amount:1000000 decimals:8"), "tokencreate");
  const tok = await waitFor("token confirmed", async () => { const rows = ok(await read("balance"), "balance"); const t = rows.find((b) => !had.includes(b.tokenid) && Number(b.sendable) > 0); return t && t.tokenid; });
  const tk = ok(await read("tokens tokenid:" + tok), "tokens");
  say("token", { tokenid: tok, txpowid: tc.txpowid, decimals: tk.decimals, name: tk.name });

  // 3. the host, as the app starts it
  await reserve.open(OUT, read);
  const sweep = setInterval(() => { reserve.sweep(read).catch(() => {}); }, 60000);
  await pp.init(); D = ppCtx.Decimal;
  pp.startLoop();
  pp._setCreateTokenForPrivateChainProof(tok);
  say("host started", { status: pp.status() });

  // 4. two pools of different prices through the host's create path
  const A = await pp.createPool(tok, 8, "1000", "5000");
  say("pool A posted", A);
  await waitFor("pool A on chain", async () => poolsOf(await scan(), tok).some((p) => p.address === A.address));
  await waitFor("token change sendable", async () => { const b = await balanceOf(tok); return b && Number(b.sendable) >= 8000 && Number(b.unconfirmed) === 0; });
  const bk = await pp.completeBackup("e2e-backup-password-0001", async (buf) => { const f = path.join(OUT, "pools-backup.bin"); fs.writeFileSync(f, buf); return { path: f }; });
  say("complete backup (required before a second pool)", bk);
  const B = await pp.createPool(tok, 8, "2000", "8000");
  say("pool B posted", B);
  let ps = await waitFor("pool B on chain", async () => { const x = poolsOf(await scan(), tok); return x.some((p) => p.address === B.address) && x.length >= 2 && x; });
  say("pools", { pools: ps.map((p) => ({ address: p.address, reserveM: plain(p.reserveM), reserveT: plain(p.reserveT), coinidM: p.coinidM, coinidT: p.coinidT, opk: p.opk, oadr: p.oadr, kmin: p.kmin })) });
  await waitFor("wallet settled", async () => { const b = await balanceOf("0x00"); return b && Number(b.unconfirmed) === 0; });

  // 5. swaps: MINIMA -> token small (one pool) and large (both), then token -> MINIMA small and large
  await swapStep("swap 1: sell 10 MINIMA", tok, true, "10");
  await swapStep("swap 2: sell 400 MINIMA", tok, true, "400");
  await waitFor("token from the swaps sendable", async () => { const b = await balanceOf(tok); return b && Number(b.unconfirmed) === 0; });
  await swapStep("swap 3: sell 20 E2ETOKEN", tok, false, "20");
  await swapStep("swap 4: sell 1500 E2ETOKEN", tok, false, "1500");

  // 6. what the background service does by itself over several blocks
  const from = await tip(), n0 = posts.length;
  await waitFor(IDLE_BLOCKS + " idle blocks", async () => (await tip()) >= from + IDLE_BLOCKS, 600000, 5000);
  say("idle blocks", { from, to: await tip(), postsDuringIdle: posts.slice(n0) });

  // 6b. pools whose coins have left the node's tree: a -test chain keeps 32 blocks before the cascade (the owner's light
  // node about 1100), so swap again once every pool coin is more than 40 blocks old
  if (!process.argv.includes("--no-cascade")) {
    const created = Math.max(...await Promise.all(poolsOf(await scan(), tok).map(async (p) => Number(ok(await read("coins coinid:" + p.coinidM), "coins")[0].created))));
    await waitFor("pool coins 40 blocks deep", async () => (await tip()) > created + 40, 1500000, 10000);
    say("pool coins past the tree", { newestPoolCoinBlock: created, tip: await tip(), cascade: ok(await read("status"), "status").chain.cascade });
    await swapStep("swap 5 (old pool coins): sell 5 MINIMA", tok, true, "5");
    await waitFor("wallet settled", async () => { const b = await balanceOf(tok); return b && Number(b.unconfirmed) === 0; });
    await swapStep("swap 6 (old pool coins): sell 30 E2ETOKEN", tok, false, "30");
  }

  // 7. the Dexicon host on the same node: does its on-chain engine reach READY, and what took the time
  const dexicon = require(path.join(root, "main/dexicon.js"));
  const dxDir = path.join(OUT, "dexicon"); fs.mkdirSync(dxDir);
  const dxStart = Date.now(), mark = cmdLogLines();
  const host = dexicon.makeHost({ dataDir: dxDir, net: { fetchJson: async (u) => { netCalls.push("GET " + u); return null; }, postText: async (u) => { netCalls.push("POST " + u); return null; } }, appHost: true, confirm: async () => false });
  await host.start();
  await waitFor("Dexicon on-chain engine READY", async () => host.status().restingReady, 900000, 1000).catch((e) => say("Dexicon", { error: e.message, status: host.status() }));
  say("Dexicon", { restingReady: host.status().restingReady, fastReady: host.status().ready, ms: Date.now() - dxStart, restingWhy: host.status().restingWhy || "", steps: dexiconSteps(mark) });
  host.stop();

  clearInterval(sweep); pp.stopLoop();
  const final = { txnlist: ok(await read("txnlist"), "txnlist").map((t) => t.id), coinlocks: await sqlRows("SELECT coinid, ts FROM pp_coinlocks"), postedInputClaims: await sqlRows("SELECT coinid FROM pp_posted_inputs"), reservations: reserve.list ? reserve.list() : null,
    allPosts: posts, netCallsRefused: netCalls, chainAtEnd: await guardChain() };
  say("end", final);
  pp.flush(); cmdLog.end();
  console.log("PROOF COMPLETE");
  setTimeout(() => process.exit(0), 500);
})().catch((e) => { say("FAILED", { error: e.message, stack: String(e.stack).split("\n").slice(0, 6), lastNodeFailure: pp.lastNodeFailure && pp.lastNodeFailure(), status: pp.status && pp.status() }); cmdLog.end(); setTimeout(() => process.exit(1), 500); });

// the Dexicon start, step by step: the time between the first and last command of each kind it sent (from commands.log)
function cmdLogLines() { return fs.existsSync(path.join(OUT, "commands.log")) ? fs.readFileSync(path.join(OUT, "commands.log"), "utf8").split("\n").length : 0; }
function dexiconSteps(from) {
  const lines = fs.readFileSync(path.join(OUT, "commands.log"), "utf8").split("\n").slice(from).filter((l) => / dexicon /.test(l));
  const by = {};
  for (const l of lines) { const m = /^(\d+)ms dexicon (\S+)(?: (\S+))?/.exec(l); if (!m) continue; const k = m[2] === "runscript" && /SIGNEDBY/.test(l) ? "runscript SIGNEDBY (loadKeys)" : m[2]; const t = Number(m[1]); (by[k] = by[k] || { n: 0, first: t, last: t }).n++; by[k].last = t; }
  return by;
}
