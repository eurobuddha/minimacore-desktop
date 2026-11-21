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
    [{ atomix: IDLE.atomix, pools: null }, /PandaPools has not started/], [Object.assign({}, IDLE, { casinoOn: true }), /P2P Chance bets/]]) {
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
    const h = handler(n), g = h.indexOf("await mayStop()"), touch = Math.min(...["node.stop()", "node.restart()", "config.save(", "saveConfigPatch(", "pendingChatBackup = null"].map(x => h.indexOf(x)).filter(x => x >= 0));
    assert.ok(g > 0 && g < touch, n + ": the guard comes first");
  }
  assert.ok(/\{ label: "Restart node", click: \(\) => \{ mayStop\(\)\.then\(\(\) => node\.restart\(\)\)\.catch\(\(\) => \{\}\); \} \}/.test(main), "the tray asks too");
  assert.ok(/if \(require\("\.\/stopguard"\)\.stopsNode\(ready\)\) await mayStop\(\);\n  return /.test(main), "a Terminal command that stops the node asks before it is sent");
  assert.equal(main.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n").match(/node\.(stop|restart)\(\)/g).length, 8, "no other stop: the six handlers, the tray, and the quit (before-quit stops the node as the app goes)");
  // run mcd:nodeRestart with the guard refusing and allowing: the patch is saved only once the guard let it go
  const src = main.slice(main.indexOf('ipcMain.handle("mcd:nodeRestart"'), main.indexOf("\n", main.indexOf('ipcMain.handle("mcd:nodeRestart"')));
  for (const allow of [false, true]) {
    const hs = {}, did = [];
    new Function("ipcMain", "mayStop", "saveConfigPatch", "node", src)({ handle: (n, f) => { hs[n] = f; } }, async () => { did.push("guard"); if (!allow) throw new Error("The node keeps running: nothing was stopped."); },
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
  assert.ok(/shop: shop\.sendingCount\(\) \}\);/.test(rd("main/main.js")), "main hands the guard the count of payments at the node");
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
