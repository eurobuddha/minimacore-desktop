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
 * Cases: timeout   the import's RPC is cut after 300 ms while the node goes on importing: followed, not restarted, finishes;
 *                  the engines wait for the chain check (M4) and are released by it
 *        kill      the "app" dies when the node prints "Streaming IBD.." (its node SIGKILLed, the flow abandoned): the marker is on
 *                  disk; a new launch finds it (engines held, banner stage); Resync node brings the balance back and clears it
 *        foreign   a file exported by G2 is refused by its tip, or found out after the import with the engines never released (its
 *                  "no growth" bound is shortened from the app's 30 minutes to 2 for this proof, and the transcript says so)
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
  node.onEnginesRelease = () => { if (configStub.load().megammrImport) { events.push("release REFUSED (marker set)"); return; } events.push("engines released"); };
  say("APP", label, "started; marker on disk:", JSON.stringify(configStub.load().megammrImport || null));
  return node;
}
let picked = "", steps = [], onStatus = null;
function flow(o = {}) {
  const imports = importfile.create({ fs, platform: process.platform, showOpen: async () => ({ canceled: false, filePaths: [picked] }), dataDir: () => node.dataDir() });
  const d = { stuckMs: o.stuckMs, node, config: o.config || configStub, status: () => L("status"), call: (c) => L(c), imports, mayStop: async () => {}, held: (op) => op(), runResync: o.runResync || ((c) => node.runResync(c)),
    work: async () => [], holdEngines: async () => { events.push("loops stopped"); return node.onEnginesHold(); }, releaseEngines: () => node.releaseEngines(), fs, totalmem: () => os.totalmem(),
    platform: process.platform, log: (l) => node.log(l), sleep, upMs: 5 * 60 * 1000 };
  const mf = MF.create(d);
  if (onStatus) node.removeListener("status", onStatus);   // one flow at a time, as main.js has one
  onStatus = (s) => { if (s.megafileStep && steps[steps.length - 1] !== s.megafileStep) steps.push(s.megafileStep); if (s.state === "running") mf.verify().catch(() => {}); };   // main.js: at every status
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
  await sendRetry(G.call, "send address:" + la + " amount:1000"); await sendRetry(G.call, "send address:" + la + " amount:234");
  await waitFor(async () => (Number(((await L("balance")).response || []).find(x => x.tokenid === "0x00").confirmed) >= 1234 ? true : null), "L funded", 1800000, 5000);
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

  // ---- timeout: the import's RPC cut at 300 ms; the node goes on ----
  say("=== CASE timeout: the RPC gives up after 300 ms while the node imports");
  let r = await runImport(fresh, { runResync: (c) => { events.push("import sent, its RPC cut at 300 ms"); return raw(LP + 4, c, { pw: LPW, timeout: 300 }); } });
  await waitFor(async () => (configStub.load().megammrImport ? null : true), "chain confirmed (M4)", 600000, 3000).catch(e => say(e.message));
  say("  engines after the check:", events.join(", ")); await lState("after timeout case");

  // ---- kill: the app dies mid-import ----
  say("=== CASE kill: the app dies when the node prints \"IBD blocks processed..\" (after it reset its chain, before it saved)");
  picked = fresh; events.length = 0;
  let dead = false;   // a dead app writes nothing more
  const deadable = Object.assign({}, configStub, { setMegammrImport: (v) => { if (!dead) configStub.setMegammrImport(v); }, save: (p) => (dead ? configStub.load() : configStub.save(p)) });
  const victim = node, { mf, imports } = flow({ config: deadable }); await imports.pick("megammr");
  victim.on("line", (l) => {
    if (/ : IBD blocks processed\.\./.test(l) && victim.proc && !dead) {
      dead = true;
      say("  node printed:", l); say("  KILL: SIGKILL the node (pid " + victim.proc.pid + ") and abandon the flow, as a crash of the app would");
      for (const k of ["start", "restart", "stop"]) victim[k] = () => new Promise(() => {});   // the dead app does nothing more
      victim.proc.kill("SIGKILL");
    }
  });
  mf.importMegammr(fresh).then(v => say("  (abandoned flow answered", JSON.stringify(v) + ")"), e => say("  (abandoned flow said", e.message + ")"));
  await waitFor(async () => (victim.proc ? null : true), "node killed", 600000, 500);
  say("  marker on disk after the kill:", JSON.stringify(configStub.load().megammrImport));
  victim.removeAllListeners(); victim.stopHealth && victim.stopHealth();
  newApp("second launch (after the crash)");
  const c0 = configStub.load(); if (c0.megammrImport) { await node.onEnginesHold(); say("  main.js at launch: the marker is set, so the trading engines are held before the node starts"); }
  await node.start(); await lUp(); await sleep(8000);
  await lState("relaunched");
  const mf2 = flow().mf; node.releaseEngines(); say("  someone asks to release the engines:", events.at(-1));
  say("  Resync node (the banner's one press: megammrsync from config megammrHost " + c0.megammrHost + ")");
  const rs = await node.runResync("megammrsync action:resync host:" + c0.megammrHost).catch(e => ({ status: false, error: e.message }));
  say("  megammrsync ->", JSON.stringify(rs.response || rs.error));
  if (rs.status === true) await mf2.resynced();   // main.js runResync: a Resync node that ended well
  await lUp(); await sleep(8000); await lState("after Resync node"); say("  engines:", events.join(", "));

  // ---- foreign: a file from G2 ----
  say("=== CASE foreign: a MegaMMR file exported by ANOTHER chain (G2, genesis " + G2.genesis + ")");
  await waitFor(async () => (await block(L)) >= (await block(G.call)) - 1, "L caught up", 600000, 3000);
  // the "no growth towards its old tip" bound is 30 minutes in the app (main/megammrfile.js STUCK_MS); shortened HERE to 2 minutes, and said so
  r = await runImport(foreign, { stuckMs: 2 * 60 * 1000 }); say("  (this case's stuck bound: 2 minutes instead of the app's 30, for the proof's length)");
  if (r.out.ok) {
    await waitFor(async () => { const m = configStub.load().megammrImport; return m && m.stage !== "catchup" ? m.stage : null; }, "verdict", 1200000, 3000)   // a lone -test node mines on by itself, so it grows towards the old tip until a recorded height shows another block.catch(e => say(e.message));
    await lState("after the other chain's file"); say("  engines (never released):", events.join(", "));
    say("  the way out: Turn MegaMMR off, then Resync node");
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
