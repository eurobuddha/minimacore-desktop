/*
 * stopguard-test.cjs — every node stop or restart asks main's own question first when anything is in flight or could not be
 * checked (main/stopguard.js, 0.18.223). No node, no network, no electron.
 * Run: node --test scripts/stopguard-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const S = require("../main/stopguard");
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const IDLE = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], casinoOn: false };

test("inFlight says what a stop would interrupt; an engine that could not be asked is said, never read as idle", () => {
  const now = new Date(2026, 10, 21, 12, 0).getTime();
  assert.equal(S.inFlight(IDLE, now).any, false, "nothing in flight, everything checked");
  assert.equal(S.inFlight(Object.assign({}, IDLE, { atomix: { ready: false, hasStore: false } }), now).any, false, "AtomiX never used here");
  const w = S.inFlight(Object.assign({}, IDLE, { atomix: { ready: true, swaps: ["0x01", "0x02"], nearestMs: now + 3600000, nearestApprox: true, maker: true, otcOffer: true, otcDeals: 1 } }), now);
  assert.equal(w.busy.length, 4); assert.match(w.busy[0], /^2 AtomiX swaps are not finished\. .* can time out at about 13:00 \(the first of them\)\./);
  assert.equal(w.title, "Stop the node with work in flight?");
  for (const [work, re] of [[{ atomix: null, pools: [] }, /AtomiX could not be asked/], [{ atomix: { ready: false, hasStore: true }, pools: [] }, /AtomiX has not started/],
    [{ atomix: IDLE.atomix, pools: null }, /PandaPools could not be asked/], [Object.assign({}, IDLE, { casinoOn: true }), /P2P Chance bets/]]) {
    const u = S.inFlight(work, now); assert.equal(u.any, true); assert.match(u.message, re); assert.equal(u.title, "Stop the node without the check?");
  }
  const pools = [{ type: "Pool transaction", ts: now - 60000 }, { type: "Pool transaction", ts: now - 60000, confirmed: true }, { type: "Pool transaction", ts: now - 2 * 3600000 }, { type: "STATUS" }];
  assert.match(S.inFlight(Object.assign({}, IDLE, { pools }), now).busy[0], /^1 pool transaction sent in the last hour is not confirmed yet/);
  assert.match(S.inFlight(Object.assign({}, IDLE, { atomix: { ready: true, swaps: ["0x01"], nearestMs: now - 1 } }), now).busy[0], /time limit of its lock has already passed/);
});

test("the guard: not running or nothing in flight goes on without a question; otherwise main asks, and the answer decides and is logged", async () => {
  const run = async (o) => { const asked = [], log = []; const g = S.stopGuard(Object.assign({ running: () => true, gather: async () => IDLE, ask: async (w) => { asked.push(w); return o.yes; }, log: (l) => log.push(l) }, o)); return { go: await g.pass(), asked, log }; };
  let r = await run({ running: () => false, gather: async () => { throw new Error("not asked"); } }); assert.deepEqual([r.go, r.asked.length], [true, 0]);
  r = await run({}); assert.deepEqual([r.go, r.asked.length], [true, 0]);
  r = await run({ gather: async () => Object.assign({}, IDLE, { atomix: { ready: true, swaps: ["0xAB"] } }), yes: false });
  assert.deepEqual([r.go, r.asked.length], [false, 1]); assert.match(r.log[0], /the user chose to keep it running$/);
  r = await run({ gather: async () => Object.assign({}, IDLE, { atomix: { ready: true, swaps: ["0xAB"] } }), yes: true }); assert.equal(r.go, true); assert.match(r.log[0], /chose to stop it$/);
  r = await run({ gather: async () => { throw new Error("boom"); }, yes: false }); assert.deepEqual([r.go, r.asked.length], [false, 1], "a failed read is not checked: asked");
  r = await run({ gather: () => new Promise(() => {}), waitMs: 10, yes: false }); assert.deepEqual([r.go, r.asked.length], [false, 1], "a read that never answers is not checked: asked");
});

test("the Terminal commands that end by stopping the node are read as the node reads them", () => {
  for (const c of ["quit", "QUIT compact:true", "archive action:resync host:h:9001", "archive action:import file:/x", "reset action:chainsync archivefile:/x", "mysql action:reset file:/x", "megammr action:import file:/x",
    "megammrsync action:resync host:h:9001", '"megammrsync" action : resync', "restore file:/x", "restoresync file:/x", "vault action:resetkeys", "status;quit"]) assert.equal(S.stopsNode(c), true, c);
  for (const c of ["status", "archive action:inspect file:/x", "megammrsync action:mydetails", "mysql action:info", "vault", "megammr action:export file:/x", "send amount:1 address:0xA"]) assert.equal(S.stopsNode(c), false, c);
});

test("AtomiX activeWork: unfinished swaps (and ERROR ones still inside their timelock), the nearest lock limit, a live market, OTC", async () => {
  const ax = require("../main/atomix");
  const A = (swaps, o = {}) => ({ swapdb: { allSwaps: (cb) => cb(null, swaps) }, trading: { isTerminalSwap: (s) => s.status === "COMPLETE" || s.status === "ERROR", withinWindow: (s) => s.inside === true },
    maker: { currentOrder: () => o.order || null }, otc: { allDeals: (cb) => cb(null, o.deals || []), myOffer: () => o.offer || null } });
  const now = 1e12;
  const w = await ax._activeWorkFrom(A([{ hash: "0x01", status: "LOCKED", mytimelock: 200, mylegminima: 1 }, { hash: "0x02", status: "COMPLETE" }, { hash: "0x03", status: "ERROR", inside: true, myTimelock: now / 1000 + 60 }, { hash: "0x04", status: "ERROR" }],
    { order: { pairs: { a: { en: true, bids: [1] } } }, deals: [{ status: "PROPOSED" }, { status: "COMPLETE" }], offer: { enable: true } }), 100, now);
  assert.deepEqual(w.swaps, ["0x01", "0x03"]); assert.equal(w.nearestMs, now + 60000); assert.equal(w.nearestApprox, false);
  assert.deepEqual([w.maker, w.otcOffer, w.otcDeals], [true, true, 1]);
  const idle = await ax._activeWorkFrom(A([]), 100, now); assert.deepEqual([idle.swaps.length, idle.maker, idle.otcOffer, idle.otcDeals], [0, false, false, 0]);
});

test("main: every stop or restart handler asks the guard before the node is touched; a refused restart saves nothing", async () => {
  const main = rd("main/main.js");
  const handler = (name) => { const i = main.indexOf('ipcMain.handle("' + name + '"'); assert.ok(i > 0, name); return main.slice(i, main.indexOf("\nipcMain.handle(", i + 1)); };   // up to the next handler
  for (const n of ["mcd:nodeReclaim", "mcd:nodeStop", "mcd:nodeRestart", "mcd:setNodeKind", "mcd:chatApplyBackup", "mcd:wwEnableMegammr"]) {
    const h = handler(n), g = h.indexOf("stopping(async () => {"), touch = Math.min(...["node.stop()", "node.restart()", "config.save(", "saveConfigPatch(", "pendingChatBackup = null"].map(x => h.indexOf(x)).filter(x => x >= 0));
    assert.ok(g > 0 && g < touch, n + ": the guard comes first (CHANGED on purpose, 0.18.257: through stopping(), which releases the hold if the operation fails)");
  }
  assert.ok(/\{ label: "Restart node", click: \(\) => \{ stopping\(\(\) => node\.restart\(\)\)\.catch\(\(\) => \{\}\); \} \}/.test(main), "the tray asks too");
  assert.ok(/const reply = require\("\.\/stopguard"\)\.stopsNode\(ready\) \? await stopping\(\(\) => run\(ready\), quits\) : await run\(ready\);/.test(main), "a Terminal command that stops the node asks before it is sent");
  assert.equal(main.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n").match(/node\.(stop|restart)\(\)/g).length, 8, "no other stop: the six handlers, the tray, and the quit (before-quit stops the node as the app goes)");
  // run mcd:nodeRestart with the guard refusing and allowing: the patch is saved only once the guard let it go
  const src = main.slice(main.indexOf('ipcMain.handle("mcd:nodeRestart"'), main.indexOf("\n", main.indexOf('ipcMain.handle("mcd:nodeRestart"')));
  for (const allow of [false, true]) {
    const hs = {}, did = [];
    const mayStop = async () => { did.push("guard"); if (!allow) throw new Error("The node keeps running: nothing was stopped."); };
    const stopping = async (fn) => { await mayStop(); return fn(); };
    new Function("ipcMain", "stopping", "saveConfigPatch", "node", src)({ handle: (n, f) => { hs[n] = f; } }, stopping,
      (p) => did.push("save " + JSON.stringify(p)), { restart: async () => did.push("restart"), snapshot: () => ({}) });
    const p = hs["mcd:nodeRestart"](null, { contribute: true });
    if (allow) { await p; assert.deepEqual(did, ["guard", 'save {"contribute":true}', "restart"]); }
    else { await assert.rejects(p, /nothing was stopped/); assert.deepEqual(did, ["guard"], "nothing saved, nothing restarted"); }
  }
  const app = rd("renderer/app.js");
  assert.ok(!/api\.saveConfig\(\{ contribute: turnOn, params \}\)/.test(app) && /api\.nodeRestart\(\{ contribute: turnOn, params \}\)/.test(app), "Contribute hands its config to the guarded restart");
  assert.ok(!/api\.saveConfig\(\{ heapMb \}\)/.test(app) && /api\.setNodeKind\(want, heapMb\)/.test(app), "the heap size goes with the guarded kind switch");
  assert.ok(/await api\.nodeRestart\(patch\);/.test(app), "the setup screen's restart carries its config");
});

// ---- 0.18.225 (as Pandamonium Desktop 0.19.288): a miniMall payment at the node is part of what the guard sees ----
test("a miniMall payment being sent is in flight: the guard asks, and says to wait for its answer", async () => {
  const w = S.inFlight(Object.assign({}, IDLE, { shop: 1 }), Date.now());
  assert.equal(w.any, true); assert.match(w.busy[0], /^A miniMall payment is being sent to the node\. Stopped now, it may or may not go through: wait for its answer, then look at the order\.$/);
  assert.ok(/shop: shop\.sendingCount\(\) \};/.test(rd("main/main.js")), "main hands the guard the count of payments at the node");
  // the count is the shop's own: one while a payment is at the node, none after
  const Module = require("module"), os = require("os"), real = Module._load, DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sg-shop-"));
  Module._load = function (r, parent) { if (r === "electron") return { app: { getPath: () => DIR, getVersion: () => "t" } }; if (parent && /[\\/]main[\\/]shop\.js$/.test(parent.filename) && r === "./config") return { getSecret: () => null, setSecret: () => {}, deleteSecret: () => {}, rpcSecret: () => "", load: () => ({}) }; if (parent && /[\\/]main[\\/]shop\.js$/.test(parent.filename) && r === "./node-manager") return { rpcPort: () => 0 }; return real.apply(this, arguments); };
  try {
    const shop = require("../main/shop"), sc = require("../main/shopcrypto"), vendor = await sc.deriveIdentity("sg vendor"); let release = null;
    shop._setRunner(async (c) => { if (c.startsWith("vault")) return { status: true, response: { phrase: "sg buyer" } }; if (c.startsWith("coins")) return { status: true, response: [] };
      if (c.startsWith("send ") && c.includes("address:0x" + "AB".repeat(32))) return new Promise(r => { release = r; }); return { status: true, response: { txpowid: "0x01" } }; });
    const placing = shop.placeOrder({ shopName: "S", shopId: "s1", currency: "Minima", vendorAddress: "0x" + "AB".repeat(32), vendorPublicId: vendor.publicId, shipping: [], products: [{ id: "p1", name: "Tea", price: "1.5" }] }, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", "");
    while (!release) await new Promise(r => setImmediate(r));
    assert.equal(shop.sendingCount(), 1); release({ status: true, response: { txpowid: "0xP" } }); await placing; assert.equal(shop.sendingCount(), 0);
  } finally { Module._load = real; fs.rmSync(DIR, { recursive: true, force: true }); }
});

// ---- 0.18.249: P2P Chance open bets are counted; "could not be checked" only when that read fails ----
test("P2P Chance: open offers and bets are counted from this wallet's coins at the contract; none open asks nothing; a failed read is not checked", async () => {
  const now = Date.now();
  assert.equal(S.inFlight(Object.assign({}, IDLE, { casinoOn: true, casino: { offers: 0, bets: 0 } }), now).any, false, "none open: no question (it asked on every stop)");
  const w = S.inFlight(Object.assign({}, IDLE, { casinoOn: true, casino: { offers: 1, bets: 2 } }), now);
  assert.match(w.busy[0], /^P2P Chance: 2 bets and 1 offer still open\./); assert.equal(w.title, "Stop the node with work in flight?");
  assert.match(S.inFlight(Object.assign({}, IDLE, { casinoOn: true, casino: null }), now).message, /Could not be checked: P2P Chance bets/);
  assert.equal(S.inFlight(Object.assign({}, IDLE, { casinoOn: false, casino: null }), now).any, false, "the loop off: not asked about");
  // main's count: every coin of this wallet at the contract is open; an offer is its own, untaken (phase 0)
  const main = rd("main/main.js"), src = main.slice(main.indexOf("async function casinoOpen() {"), main.indexOf("\n}\n", main.indexOf("async function casinoOpen() {")) + 3);
  const make = (enabled, bets) => new Function("config", "casino", src + "\nreturn casinoOpen;")({ load: () => ({ casinoEnabled: enabled }) }, { myBets: async () => { if (bets instanceof Error) throw bets; return bets; } });
  assert.deepEqual(await make(true, [{ amHouse: true, phase: 0 }, { amHouse: true, phase: 1 }, { amPlayer: true, phase: 2 }])(), { offers: 1, bets: 2 });
  await assert.rejects(make(true, new Error("P2PChance engine not ready yet"))(), /not ready/);
  assert.equal(await make(false, [])(), null, "not read while the loop is off");
  assert.ok(/readWithin\(\(\) => casinoOpen\(\)\)/.test(main), "a failed read is null: said as not checked (CHANGED on purpose, 0.18.259: read side by side)");
});

// ---- 0.18.250: a restart the guard refused from the setup screen keeps the user's edits on screen ----
test("setup screen: the form stays until the node really stops; a refused restart keeps the edits and says so", () => {
  const app = rd("renderer/app.js"), i = app.indexOf("    if (running) {   // reconfigure = restart to apply"), branch = app.slice(i, app.indexOf("\n      return;\n    }", i));
  assert.ok(i > 0 && branch.indexOf("await api.nodeRestart(patch);") > 0);
  assert.ok(!/showStarting\(\)|hideSetup\(\)|innerHTML/.test(branch), "nothing replaces or hides the form before main has decided");
  // CHANGED on purpose (0.18.258): the config is read again, and the edits are said to be kept only while the form is on screen
  assert.ok(/try \{ CFG = await api\.getConfig\(\); \} catch \(x\) \{ CFG = before; \}/.test(branch) && /const kept = btn\.isConnected; if \(kept\) \{ btn\.disabled = false;/.test(branch)
    && /toast\(ipcMsg\(e\) \+ \(kept \? " Your changes are still on this screen\." : ""\), "err"\);/.test(branch), "a refusal gives the button back and says the edits are kept");
  assert.ok(/finally \{ setupRestarting = false; \}/.test(branch));
  assert.ok(/if \(setupRestarting && s\.state !== "running" && !el\("startStat"\)\) showStarting\(\);/.test(app), "the progress replaces the form once the node is really stopping");
});

// ---- 0.18.253: one question, one stop: a second request while the first is asked about, or let go and not stopped yet, is refused ----
test("stopGuard is single-flight: two requests at once show one question and give one stop; a stop that happened ends the hold", async () => {
  let t = 1000, asks = 0, answer = null, running = true;
  const busy = { atomix: { ready: true, swaps: ["0xAB"] }, pools: [] };
  const waitAsk = async () => { for (let k = 0; k < 300 && !answer; k++) await new Promise(r => setTimeout(r, 1)); assert.ok(answer, "a question was asked"); };
  const g = S.stopGuard({ running: () => running, gather: async () => busy, log: () => {}, now: () => t, ask: () => { asks++; return new Promise(r => { answer = r; }); } });
  const p1 = g.pass(), p2 = g.pass();
  assert.equal(await p2, "busy", "the second while the first question is open"); await waitAsk();
  answer(true); assert.ok(Number.isInteger(await p1), "go on, with this call's stamp (0.18.266)"); assert.equal(asks, 1, "one question");
  assert.equal(await g.pass(), "busy", "let go, the node not stopped yet: no second stop");
  g.seen("stopping"); running = true; answer = null;
  const p3 = g.pass(); await waitAsk(); answer(false); assert.equal(await p3, false, "after the stop happened a new request is asked again"); assert.equal(asks, 2);
  t += 31000; answer = null; const p4 = g.pass(); await waitAsk(); answer(true); assert.ok(Number.isInteger(await p4));
  t += 31000; answer = null; const p5 = g.pass(); await waitAsk(); answer(false); await p5; assert.equal(asks, 4, "the hold runs out");
  running = false; assert.equal(await g.pass(), true, "a node that is not running is never held");
  const main = rd("main/main.js");
  assert.ok(/if \(r === "busy"\) throw new Error\("The node is already being stopped or restarted, or the question about it is still open\. Nothing more was done\."\);/.test(main) && /node\.on\("status", \(s\) => stopGuard\.seen\(s && s\.state\)\);/.test(main), "main says it, and tells the guard when the node stopped");
});

// ---- 0.18.257: when what the yes was for fails without stopping the node, the hold ends: a retry is asked again, not refused ----
test("a stop let go whose operation then fails releases the hold: the retry is asked again", async () => {
  let asks = 0;
  const g = S.stopGuard({ running: () => true, gather: async () => ({ atomix: { ready: true, swaps: ["0xAB"] }, pools: [] }), log: () => {}, ask: async () => { asks++; return true; } });
  const stamp = await g.pass(); assert.ok(Number.isInteger(stamp) && stamp > 0); assert.equal(await g.pass(), "busy", "held after a yes");
  g.release(); g.release(stamp + 1); assert.equal(await g.pass(), "busy", "CHANGED on purpose (0.18.266): no stamp, or another, releases nothing");
  g.release(stamp); assert.ok(Number.isInteger(await g.pass()), "released by its own stamp: asked again"); assert.equal(asks, 2);
  const main = rd("main/main.js"), src = main.slice(main.indexOf("async function stopping(fn, keepOnThrow)"), main.indexOf("\n}\n", main.indexOf("async function stopping(fn, keepOnThrow)")) + 3);
  const released = [], node = { state: "running" }, run = (passOk) => new Function("mayStop", "stopGuard", "node", src + "\nreturn stopping;")(async () => { if (!passOk) throw new Error("kept running"); return 7; }, { release: (st) => released.push(st) }, node);
  await assert.rejects(run(true)(async () => { throw new Error("Wrong password"); }), /Wrong password/); assert.equal(released.length, 1, "the operation failed: released");
  await assert.rejects(run(false)(async () => 1), /kept running/); assert.equal(released.length, 1, "a refused or busy guard releases nothing (another request's hold stays)");
  assert.equal(await run(true)(async () => 7), 7); assert.equal(released.length, 1);
});

// ---- 0.18.258: a restart that failed after the guard let it go: the config is read again, and "your changes are still on this screen" only while they are ----
test("setup screen: a failure after the restart began re-reads the config and does not claim the form is still there", async () => {
  const app = rd("renderer/app.js"), i = app.indexOf("    if (running) {   // reconfigure = restart to apply"), j = app.indexOf("\n      return;\n    }", i);
  const body = app.slice(app.indexOf("      const before = CFG", i), j);
  const runIt = async ({ formStays, failWith }) => {
    const toasts = [], btn = { isConnected: formStays, disabled: false, textContent: "" }, saved = { walletDone: true, contribute: true };
    const api = { nodeRestart: async () => { throw new Error(failWith); }, getConfig: async () => saved };
    const env = { CFG: { walletDone: true, contribute: false } };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("env", "api", "el", "toast", "ipcMsg", "patch", "let CFG = env.CFG, postBootStarted = false, setupRestarting = false;\n" + body + "\nenv.CFG = CFG;")(env, api, () => btn, (m) => toasts.push(m), (e) => e.message, { contribute: true });
    return { toasts, env, btn };
  };
  let r = await runIt({ formStays: true, failWith: "The node keeps running: nothing was stopped." });
  assert.deepEqual(r.toasts, ["The node keeps running: nothing was stopped. Your changes are still on this screen."]); assert.equal(r.btn.disabled, false);
  r = await runIt({ formStays: false, failWith: "node start failed" });
  assert.deepEqual(r.toasts, ["node start failed"], "the form is gone: not said to be there"); assert.equal(r.env.CFG.contribute, true, "the config main saved is read again");
});

// ---- 0.18.259: the in-flight reads run side by side, each with its own limit: a slow casino read loses nothing else ----
test("inFlightWork: AtomiX, pools and P2P Chance are read side by side; a late or failing one is null, the others are kept; casinoOn from the config", async () => {
  const main = rd("main/main.js"), a = main.indexOf("const READ_MS = 4000;"), src = main.slice(a, main.indexOf("\n};\n", a) + 3).replace("const READ_MS = 4000;", "const READ_MS = 60;");
  const make = (o) => new Function("atomix", "pandapools", "casinoOpen", "config", "shop", src + "\nreturn inFlightWork;")(o.atomix, o.pandapools, o.casinoOpen, { load: () => ({ casinoEnabled: true }) }, { sendingCount: () => 0 });
  const AX = { ready: true, swaps: ["0xAB"] }, never = () => new Promise(() => {});
  const t0 = Date.now();
  let w = await make({ atomix: { activeWork: async () => AX }, pandapools: { activeWork: () => Promise.resolve([]) }, casinoOpen: never })();
  assert.deepEqual(w.atomix, AX); assert.deepEqual(w.pools, []); assert.equal(w.casino, null); assert.equal(w.casinoOn, true, "from the config, so P2P Chance is said as not checked");
  assert.ok(Date.now() - t0 < 1000, "the late read does not hold the others");
  w = await make({ atomix: { activeWork: never }, pandapools: { activeWork: () => { throw new Error("sync throw"); } }, casinoOpen: async () => ({ offers: 0, bets: 1 }) })();
  assert.deepEqual([w.atomix, w.pools, w.casino], [null, null, { offers: 0, bets: 1 }]);
  assert.match(S.inFlight(w, Date.now()).message, /P2P Chance: 1 bet[\s\S]*AtomiX could not be asked/);
});

// ---- 0.18.264 (as Pandamonium Desktop 0.19.319's held()): a status:false reply with the node still running ends the hold too ----
test("stopping(): a refused restore (status:false) or a throw with the node still running releases the hold; with the node stopped it does not", async () => {
  const main = rd("main/main.js"), src = main.slice(main.indexOf("async function stopping(fn, keepOnThrow)"), main.indexOf("\n}\n", main.indexOf("async function stopping(fn, keepOnThrow)")) + 3);
  const released = [], node = { state: "running" };
  const stopping = new Function("mayStop", "stopGuard", "node", src + "\nreturn stopping;")(async () => 7, { release: (st) => released.push(st) }, node);
  assert.deepEqual(await stopping(async () => ({ status: false, error: "Wrong password" })), { status: false, error: "Wrong password" }); assert.equal(released.length, 1, "a refused restore, the node running: released");
  await stopping(async () => ({ status: true })); assert.equal(released.length, 1, "a reply that went through: held until the node stops");
  node.state = "stopping"; await stopping(async () => ({ status: false })); await assert.rejects(stopping(async () => { throw new Error("socket closed"); }));
  assert.equal(released.length, 1, "the node is stopping: its status ends the hold, not this");
});

// ---- 0.18.266: only the stop that took the hold can release it; a cut connection on quit keeps it ----
test("stopping() releases only its own hold, with its stamp; a refused, busy or holdless pass releases nothing; quit keeps the hold when the connection is cut", async () => {
  const main = rd("main/main.js"), src = main.slice(main.indexOf("async function stopping(fn, keepOnThrow)"), main.indexOf("\n}\n", main.indexOf("async function stopping(fn, keepOnThrow)")) + 3);
  const released = [], node = { state: "running" }, make = (passes) => new Function("mayStop", "stopGuard", "node", src + "\nreturn stopping;")(async () => passes, { release: (st) => released.push(st) }, node);
  await assert.rejects(make(5)(async () => { throw new Error("Wrong password"); })); assert.deepEqual(released, [5], "its own stamp");
  await make(true)(async () => ({ status: false })); assert.deepEqual(released, [5, 0], "no hold taken (the node was not running): stamp 0, which releases nothing");
  await assert.rejects(make(6)(async () => { throw new Error("socket hang up"); }, true)); assert.deepEqual(released, [5, 0], "quit: a cut connection keeps the hold");
  assert.ok(/const quits = require\("\.\/cmdverb"\)\.parts\(ready\)\.some\(p => require\("\.\/cmdverb"\)\.is\(p, "quit"\)\);/.test(main) && main.includes("await stopping(() => run(ready), quits)"), "the Terminal's quit keeps it");
  // the real guard: another request's hold is never ended by a stale stamp
  const g = S.stopGuard({ running: () => true, gather: async () => ({ atomix: { ready: true, swaps: ["0x1"] }, pools: [] }), log: () => {}, ask: async () => true });
  const a = await g.pass(); g.release(a); const b = await g.pass(); g.release(a); assert.equal(await g.pass(), "busy", "a's stamp does not end b's hold"); g.release(b); assert.ok(Number.isInteger(await g.pass()));
});

// ---- 0.18.268: a pool read that failed or was late is said as "could not be asked", not "has not started" ----
test("a pool read that timed out or failed is said as PandaPools could not be asked", () => {
  const m = S.inFlight({ atomix: IDLE.atomix, pools: null }, Date.now()).message;
  assert.match(m, /pool operations \(PandaPools could not be asked\)/); assert.ok(!/has not started/.test(m));
});
