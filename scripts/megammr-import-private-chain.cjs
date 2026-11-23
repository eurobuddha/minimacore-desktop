#!/usr/bin/env node
/*
 * megammr-import-private-chain.cjs — MANUAL proof of Backup & Recovery's "Resync from a MegaMMR file" (main/megammrfile.js) against
 * THROWAWAY PRIVATE test chains. NEVER in CI, never a test:* script, never against a node holding funds.
 *
 *   node scripts/megammr-import-private-chain.cjs --jar <minima jar> --out <empty dir> [--base 29900]
 *
 * It starts every node it talks to itself, in fresh folders under --out, all with -test -nop2p:
 *   G   a genesis -megammr node (port base)        the chain the wallet lives on; exports the MegaMMR files
 *   G2  a second genesis -megammr node (base + 20) ANOTHER chain: a file from it must never be taken for G's
 *   L   the app's REAL NodeManager (main/node-manager.js, the plain "minima" kind; base + 40), a light node connected only to G, with a wallet
 * The flow is the app's own module, given the real node manager, the real importfile picker (the dialog answered with the file), the real
 * rpc transport. Stand-ins: electron (paths), config (a JSON file under --out, so the import's marker really is on disk), the stop guard
 * (always yes), the engines and the other loops (recorded), the open work (none).
 *
 * Cases (the third review's): older file + timeout   a file older than the node's tip, its RPC cut at 300 ms: followed, not restarted,
 *                                                  released once the node's tip is fresh, no verdict
 *        crash, balance intact      the app dies at "IBD blocks processed..": the next launch's check clears the marker by itself, no banner
 *        crash, balance changed     MINIMA arrive while the app is down: the banner; "My balance is correct" releases; again, and Resync node
 *        behind                     L cut off from G while G goes on 40 blocks (a lone -test node mines its own fork meanwhile); a NEWER file
 *                                   from G is imported (no refusal); the check says the two blocks differ, and Keep the imported chain releases
 *        mismatch                   a file exported by G2 (another genesis): a recorded height shows another block id; Keep releases
 *
 * It REFUSES to run unless: --out is empty; every port it would use (base .. base + 64) is free (it never talks to a node it did not
 * start); base >= 29900; each node says -TEST in its version; L's block 1 is G's genesis; G2's genesis differs from G's. It contacts
 * 127.0.0.1 only. Everything it started is killed at the end, and on any error or Ctrl-C.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), net = require("net"), Module = require("module"), { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
function refuse(why) { console.error("REFUSED: " + why + ". Nothing was started."); process.exit(2); }
const JAR = arg("jar"), OUT = arg("out") && path.resolve(arg("out")), BASE = Number(arg("base") || 29900);
if (!JAR || !fs.existsSync(JAR)) refuse("--jar must name the minima jar to run");
if (!OUT) refuse("--out must name an output folder");
if (!Number.isInteger(BASE) || BASE < 29900 || BASE > 65000) refuse("--base must be 29900 or above (the owner's nodes and other agents' live below)");
fs.mkdirSync(OUT, { recursive: true });
if (fs.readdirSync(OUT).length) refuse("--out must be empty");
const GP = BASE, G2P = BASE + 20, LP = BASE + 40, LPW = "proof" + Date.now().toString(36);
const T0 = Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (...a) => { const l = "[" + ((Date.now() - T0) / 1000).toFixed(1) + "s] " + a.join(" "); console.log(l); fs.appendFileSync(path.join(OUT, "transcript.txt"), l + "\n"); };
const portFree = (p) => new Promise(r => { const s = net.connect({ host: "127.0.0.1", port: p }); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); });

// ---- stand-ins before anything of the app loads ----
const USER = path.join(OUT, "userData"), CFG_FILE = path.join(OUT, "config.json");
const electronStub = { app: { getPath: () => USER, getVersion: () => "proof", isPackaged: false } };
const origLoad = Module._load;
Module._load = function (req) { if (req === "electron") return electronStub; return origLoad.apply(this, arguments); };
const PARAMS = require(path.join(ROOT, "renderer/params.js"));
const readCfg = () => JSON.parse(fs.readFileSync(CFG_FILE, "utf8")), writeCfg = (c) => fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
const configStub = { load: () => readCfg(), rpcSecret: () => LPW, defaultDataFolder: () => path.join(OUT, "L"), effectiveParams: () => Object.assign({}, readCfg().params),
  save: (p) => { const c = readCfg(); p = JSON.parse(JSON.stringify(p)); if (p.params) p.params = Object.assign({}, c.params, p.params); writeCfg(Object.assign(c, p)); return readCfg(); },
  setMegammrImport: (v) => { const c = readCfg(); if (v) c.megammrImport = JSON.parse(JSON.stringify(v)); else delete c.megammrImport; writeCfg(c); } };
const stubMod = (rel, exp) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp, children: [], paths: [] }; };
stubMod("main/config.js", configStub);
const rpc = require(path.join(ROOT, "main/rpc.js")), importfile = require(path.join(ROOT, "main/importfile.js")), MF = require(path.join(ROOT, "main/megammrfile.js"));
const NodeManager = require(path.join(ROOT, "main/node-manager.js")).constructor;

// ---- the nodes this script starts (and only those) ----
const procs = [];
function raw(port, cmd, o = {}) {
  if (port < 29900) throw new Error("port refused");
  return new Promise((res, rej) => {
    const headers = o.pw ? { Authorization: "Basic " + Buffer.from("minima:" + o.pw).toString("base64") } : {};
    const rq = http.get({ host: "127.0.0.1", port, path: "/" + encodeURIComponent(cmd), headers, timeout: o.timeout || 600000, insecureHTTPParser: true, agent: false },
      (r) => { let b = ""; r.on("data", d => b += d); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res({ status: false, raw: b }); } }); });
    rq.on("error", rej); rq.on("timeout", () => rq.destroy(new Error("RPC timeout")));
  });
}
async function genesisNode(name, port) {
  const dir = path.join(OUT, name); fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, "log.txt"), "a");
  const p = spawn("java", ["-Xmx1024m", "-jar", JAR, "-data", path.join(dir, "data"), "-port", String(port), "-rpcenable", "-test", "-nop2p", "-megammr", "-genesis"], { stdio: ["ignore", out, out] });
  procs.push(p);
  const call = (c) => raw(port + 4, c);
  await waitFor(async () => ((await call("status")).status ? true : null), name + " up", 120000, 1000);
  await sleep(2000);
  const m = /Genesis block created : (0x[0-9A-F]+)/.exec(fs.readFileSync(path.join(dir, "log.txt"), "utf8"));
  const st = (await call("status")).response;
  if (!/-TEST/.test(st.version) || !m) throw new Error(name + " is not a -TEST genesis node");
  say("NODE", name, st.version, "port", port, "genesis", m[1]);
  return { call, port, genesis: m[1] };
}
async function waitFor(fn, label, ms = 600000, every = 2000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } throw new Error("timeout: " + label); }
const block = async (call) => Number((await call("block")).response.block);
async function sendRetry(call, cmd) { return waitFor(async () => { const r = await call(cmd); return r.status ? r : null; }, cmd, 600000, 5000); }

// ---- L: the app's node manager, and the flow wired as main.js wires it ----
const events = [];
let node, L;
function newApp(label) {
  node = new NodeManager(); node.jarPath = () => JAR; onStatus = null;
  L = (c) => rpc.rpcCall(LP + 4, LPW, c);
  // what main.js does with it (main.js: onEnginesHold/onEnginesRelease with the marker guard; the loops); recorded, not run
  node.onEnginesHold = async () => { events.push("engines held"); };
  node.onEnginesRelease = () => { if (MF.holds(configStub.load().megammrImport)) { events.push("release REFUSED (marker set)"); return; } events.push("engines released"); };
  say("APP", label, "started; marker on disk:", JSON.stringify(configStub.load().megammrImport || null));
  return node;
}
let picked = "", steps = [], onStatus = null; const banners = [];
function flow(o = {}) {
  const imports = importfile.create({ fs, platform: process.platform, showOpen: async () => ({ canceled: false, filePaths: [picked] }), dataDir: () => node.dataDir() });
  const d = { node, config: o.config || configStub, status: () => L("status"), call: (c) => L(c), imports, mayStop: async () => {}, held: (op) => op(), runResync: o.runResync || ((c) => node.runResync(c)),
    work: async () => [], holdEngines: async () => { events.push("loops stopped"); return node.onEnginesHold(); }, releaseEngines: () => node.releaseEngines(), fs, totalmem: () => os.totalmem(),
    platform: process.platform, log: (l) => node.log(l), sleep, upMs: 5 * 60 * 1000 };
  const mf = MF.create(d);
  if (onStatus) node.removeListener("status", onStatus);   // one flow at a time, as main.js has one
  onStatus = (s) => { if (s.megafileStep && steps[steps.length - 1] !== s.megafileStep) steps.push(s.megafileStep);
    if (s.megafileBanner && JSON.stringify(banners[banners.length - 1]) !== JSON.stringify(s.megafileBanner)) banners.push(s.megafileBanner);
    if (s.state === "running") mf.verify().catch(() => {}); };   // main.js: at every status
  node.on("status", onStatus);
  return { mf, imports };
}
async function lBalance() { const b = (await L("balance")).response || []; const m = b.find(x => x.tokenid === "0x00") || {}; return m.confirmed + " (sendable " + m.sendable + ", coins " + m.coins + ")"; }
async function lState(label) {
  const st = (await L("status").catch(() => null)) || {}, r = st.response || {};
  say("L", label, "| state", node.state, "| megammr", r.megammr, "| block", r.chain && r.chain.block, "| balance", node.state === "running" ? await lBalance().catch(e => e.message) : "-",
    "| marker", JSON.stringify((configStub.load().megammrImport || {}).stage || null), "| status says", JSON.stringify(node.snapshot().megammrImport));
}
async function lUp() { return waitFor(async () => (node.state === "running" ? true : null), "L running", 600000, 1000); }
async function runImport(file, o) {
  picked = file; events.length = 0; steps = [];
  const { mf, imports } = flow(o);
  await imports.pick("megammr");
  const t = Date.now(); let out;
  try { out = { ok: await mf.importMegammr(file) }; } catch (e) { out = { refused: e.message }; }
  say("FLOW importMegammr ->", JSON.stringify(out), "in", ((Date.now() - t) / 1000).toFixed(1) + "s | engines:", events.join(", "));
  say("  steps shown on the import's screen:", steps.join(" > "));
  return { out, mf };
}
async function exportFrom(n, name) {
  const f = path.join(OUT, name), r = await n.call("megammr action:export file:" + f);
  say("export", name, JSON.stringify(r.response || r.error)); return f;
}

async function main() {
  for (let p = BASE; p <= BASE + 64; p++) if (!(await portFree(p))) refuse("port " + p + " is in use: this script talks only to nodes it started");
  writeCfg({ nodeKind: "minima", basePort: LP, rpcPortManual: "", dataFolder: path.join(OUT, "L"), keyMode: "classic", heapMb: 0, extraArgs: "", contribute: false, megammrHost: "127.0.0.1:" + GP,
    params: Object.assign({}, PARAMS.ROLE_LIGHT, { test: true, nop2p: true, connect: "127.0.0.1:" + GP, megammr: false, keets: false }) });
  const G = await genesisNode("G", GP), G2 = await genesisNode("G2", G2P);
  if (G.genesis === G2.genesis) throw new Error("the two chains share a genesis");
  newApp("first launch"); await node.start(); await lUp(); await waitFor(async () => (await block(L)) > 1, "L synced");
  const b1 = (await L("txpow block:1")).response; if (!b1 || b1.txpowid !== G.genesis) throw new Error("L is not on G's chain"); say("GUARD L block 1 =", b1.txpowid, "= G's genesis");
  const la = (await L("getaddress")).response.address;
  // each payment is sent again when it has not arrived within 4 minutes (a -test chain drops one now and then: "Failed block check")
  const lMinima = async () => Number(((await L("balance")).response || []).find(x => x.tokenid === "0x00").confirmed);
  for (const [amount, total] of [[1000, 1000], [234, 1234]]) {
    for (let i = 0; i < 6 && (await lMinima().catch(() => 0)) < total; i++) {
      await sendRetry(G.call, "send address:" + la + " amount:" + amount);
      await waitFor(async () => ((await lMinima()) >= total ? true : null), "L funded " + total, 240000, 5000).catch(() => say("  payment of " + amount + " not seen in 4 minutes: sent again"));
    }
  }
  if ((await lMinima()) < 1234) throw new Error("L could not be funded");
  const lc = (await L("coins relevant:true")).response.map(c => Number(c.created));
  await waitFor(async () => { const st = (await G.call("status")).response; return Number(st.chain.block) - Number(st.chain.length) + 1 > Math.max(...lc) + 2 ? true : null; }, "L's coins below G's root", 1800000, 15000);
  await lState("funded");
  await node.stop(); say("L stopped; 110 s so G's block cache (IBDStore, 100 s) is not reused by the export");
  await sleep(110000);
  const fresh = await exportFrom(G, "fresh.megammr");
  // G2's file must be a whole one (a chain too short to have a cascade is refused by the node's own check, which proves nothing here)
  await waitFor(async () => { const c = (await G2.call("status")).response.chain; return Number(c.cascade && c.cascade.length) > 0 && Number(c.block) >= 40 ? true : null; }, "G2 long enough to have a cascade", 1800000, 5000);
  say("G at block", await block(G.call), "| G2 at block", await block(G2.call));
  const foreign = await exportFrom(G2, "other-chain.megammr");
  await node.start(); await lUp(); await waitFor(async () => (await block(L)) >= (await block(G.call)) - 1, "L caught up");
  await lState("before the cases");

  // ---- older file (the normal case), its RPC cut at 300 ms: followed, never restarted, released once the tip is fresh; no verdict ----
  say("=== CASE older file + timeout: a file older than this node's tip; the import's RPC gives up after 300 ms while the node imports");
  await runImport(fresh, { runResync: (c) => { events.push("import sent, its RPC cut at 300 ms"); return raw(LP + 4, c, { pw: LPW, timeout: 300 }); } });
  await waitFor(async () => (configStub.load().megammrImport ? null : true), "released", 600000, 3000).catch(e => say(e.message));
  say("  banners shown meanwhile:", JSON.stringify(banners), "| engines:", events.join(", ")); await lState("after the older file");
  await sleep(60000); say("  a minute later: L at block", await block(L), "| G at block", await block(G.call)); await recover();

  // ---- crashes mid-import: the app dies when the node prints "IBD blocks processed.." ----
  // L back on G's tip before the next case: it catches up by itself, or (seen on this private chain after importing a file whose last block
  // G then orphaned: "Invalid TxPoW Super Parents" for every next block) a Resync node from G puts it back
  async function recover() {
    const ok = await waitFor(async () => ((await block(L)) >= (await block(G.call)) - 1 ? true : null), "L caught up", 120000, 3000).catch(() => false);
    if (ok) return;
    say("  L did not catch up in 2 minutes (L at block " + await block(L) + ", G at " + await block(G.call) + "): Resync node from G to go on");
    const r = await node.runResync("megammrsync action:resync host:127.0.0.1:" + GP).catch(e => ({ status: false, error: e.message }));
    await lUp(); await waitFor(async () => ((await block(L)) >= (await block(G.call)) - 1 ? true : null), "L caught up after resync", 600000, 3000);
    say("  recovered:", JSON.stringify(r.response || r.error));
  }
  async function crash(label, beforeRelaunch) {
    say("=== CASE " + label);
    await recover();
    picked = fresh; events.length = 0;
    let dead = false;   // a dead app writes nothing more
    const deadable = Object.assign({}, configStub, { setMegammrImport: (v) => { if (!dead) configStub.setMegammrImport(v); }, save: (p) => (dead ? configStub.load() : configStub.save(p)) });
    const victim = node, { mf, imports } = flow({ config: deadable }); await imports.pick("megammr");
    victim.on("line", (l) => {
      if (/ : IBD blocks processed\.\./.test(l) && victim.proc && !dead) {
        dead = true; say("  node printed:", l, "| KILL: SIGKILL the node (pid " + victim.proc.pid + ") and abandon the flow, as a crash of the app would");
        for (const k of ["start", "restart", "stop"]) victim[k] = () => new Promise(() => {});
        victim.proc.kill("SIGKILL");
      }
    });
    mf.importMegammr(fresh).catch(() => {});
    await waitFor(async () => (victim.proc ? null : true), "node killed", 600000, 500);
    const m = configStub.load().megammrImport; say("  marker on disk after the kill: stage", m && m.stage, "| balance recorded before the import:", JSON.stringify(m && m.before));
    victim.removeAllListeners(); victim.stopHealth && victim.stopHealth();
    if (beforeRelaunch) await beforeRelaunch();
    newApp("relaunch after the crash"); banners.length = 0;
    if (MF.holds(configStub.load().megammrImport)) { await node.onEnginesHold(); say("  main.js at launch: the marker holds, so the trading engines are held before the node starts"); }
    const f2 = flow(); await node.start(); await lUp();
    await waitFor(async () => (!configStub.load().megammrImport || node.megafileBanner ? true : null), "checked after the relaunch", 300000, 2000).catch(e => say(e.message));
    await lState("relaunched"); say("  banner:", JSON.stringify(node.megafileBanner || null), "| engines:", events.join(", "));
    return f2.mf;
  }
  await crash("crash, balance intact: the marker must clear itself, no banner");
  // 5 MINIMA arrive just BEFORE the import, so the balance recorded holds them; after the crash the node restarts at the file's last block,
  // which is older than that payment: it shows less until it has caught up (verify keeps asking), and the user may dismiss meanwhile
  await sendRetry(G.call, "send address:" + la + " amount:5");
  await waitFor(async () => ((await L("balance")).response.find(x => x.tokenid === "0x00").confirmed === "1239" ? true : null), "5 arrived", 600000, 3000);
  say("  5 MINIMA arrived at L before the import (L at block " + await block(L) + ")");
  let mf2 = await crash("crash after a payment newer than the file -> banner (less) -> My balance is correct");
  if (node.megafileBanner) { say("  the user reads the balance again (" + await lBalance() + ") and presses My balance is correct: dismiss"); await mf2.keep(); await sleep(2000); }
  else say("  no banner: the node had caught up before it was checked");
  await lState("after dismiss"); say("  engines:", events.join(", "));
  mf2 = await crash("crash, balance changed meanwhile (3 MINIMA arrive) -> banner -> Resync node",
    async () => { await sendRetry(G.call, "send address:" + la + " amount:3"); say("  G sent 3 to L while the app was down"); });
  const rs = await node.runResync("megammrsync action:resync host:" + configStub.load().megammrHost).catch(e => ({ status: false, error: e.message }));
  say("  Resync node ->", JSON.stringify(rs.response || rs.error)); if (rs.status === true) await mf2.resynced();   // main.js runResync
  await lUp(); await sleep(8000); await lState("after Resync node"); say("  engines:", events.join(", "));
  await recover();

  // ---- a node that is behind imports a newer file: allowed (the old refusals are gone) ----
  say("=== CASE behind: L cut off from G (connect to a closed port) while G goes on; then a NEWER file from G is imported");
  configStub.save({ params: { connect: "127.0.0.1:" + (BASE + 63) } }); await node.restart(); await lUp();
  const lTip = await block(L); say("  L stuck at block", lTip);
  await waitFor(async () => ((await block(G.call)) >= lTip + 40 ? true : null), "G 40 blocks ahead of L", 1800000, 10000);
  const newer = await exportFrom(G, "newer.megammr"); say("  G at block", await block(G.call), "| L at block", await block(L));
  banners.length = 0; const rb = await runImport(newer);
  // cut off, a lone -test node mines its own blocks: L is then on ITS OWN fork, and G's file holds other blocks at the same heights. The
  // check says exactly that (not "the file is wrong": here the node is), and Keep the imported chain is the right exit
  const verdict = await waitFor(async () => { const m = configStub.load().megammrImport; return !m ? "released" : m.stage === "mismatch" ? "mismatch" : null; }, "released or mismatch", 600000, 3000).catch(e => e.message);
  await lState("after the newer file"); say("  outcome:", verdict, "| banners:", JSON.stringify(banners), "| engines:", events.join(", "));
  if (verdict === "mismatch") { say("  the node had mined its own fork while cut off; the user presses Keep the imported chain"); await rb.mf.keep(); await sleep(1000); say("  engines:", events.join(", ")); }
  configStub.save({ params: { connect: "127.0.0.1:" + GP } }); await node.restart(); await lUp();
  await sleep(30000); say("  reconnected to G: L at block", await block(L), "| G at block", await block(G.call)); await recover();

  // ---- a different block id at a recorded height: the fork said as such, Keep releases ----
  say("=== CASE mismatch: a MegaMMR file exported by ANOTHER chain (G2, genesis " + G2.genesis + ")");
  banners.length = 0; const r = await runImport(foreign);
  if (r.out.ok) {
    // a lone -test node mines on by itself, so it grows towards the old tip until a recorded height shows another block
    // released already when the file's own last block is under 30 minutes old (the freshness rule): then no block of this node's was compared
    const outcome = await waitFor(async () => { const m = configStub.load().megammrImport; return !m ? "released" : m.stage === "mismatch" ? "mismatch" : null; }, "mismatch or released", 1800000, 3000).catch(e => e.message);
    say("  outcome:", outcome);
    if (outcome === "released") { say("  RELEASED WITHOUT A COMPARISON: the other chain's file ended at a block under 30 minutes old, so the tip counted as fresh before any recorded height was reached"); }
    await lState("after the other chain's file"); say("  banner:", JSON.stringify(node.megafileBanner || null)); say("  banners on the way:", JSON.stringify(banners.map(b => b.kind + (b.block ? ":" + b.block : "")))); say("  engines:", events.join(", "));
    if (outcome === "mismatch") say("  the user presses Keep the imported chain"); await r.mf.keep(); await sleep(1000); say("  engines:", events.join(", ")); await lState("after Keep");
    say("  (proof cleanup: Turn MegaMMR off, then Resync node, back to G's chain)");
    await r.mf.megammrOff(); await lUp();
    const rs2 = await node.runResync("megammrsync action:resync host:127.0.0.1:" + GP).catch(e => ({ status: false, error: e.message }));
    if (rs2.status === true) await r.mf.resynced();
    await lUp(); await sleep(8000); await lState("after Turn MegaMMR off + Resync node");
  }
}

function cleanup() { try { node && node.killNow && node.killNow(); } catch (e) {} for (const p of procs) try { p.kill("SIGKILL"); } catch (e) {} try { if (node && node.proc) node.proc.kill("SIGKILL"); } catch (e) {} }
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });
main().then(() => { say("DONE"); cleanup(); setTimeout(() => process.exit(0), 1500); })
  .catch((e) => { say("PROOF ERROR", e.stack || e.message); cleanup(); setTimeout(() => process.exit(1), 1500); });
