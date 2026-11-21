/*
 * engine-abort.test.cjs — 0.18.107: the AtomiX and PandaPools GLUE (main/atomix.js, main/pandapools.js) give every node
 * command of an engine an abort signal, and invalidate() (the wallet was replaced) aborts it: a signing command still
 * waiting in the process-wide queue (main/noderun.js) is then never sent. Mock runners only: scripts/dexicon-mock.cjs
 * poisons main/rpc.js and main/netfetch.js, so a real node or the real network throws. The Dexicon half of this is in
 * scripts/dexicon-host.test.cjs.
 *   node --test scripts/engine-abort.test.cjs
 */
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const M = require("./dexicon-mock.cjs");   // FIRST
const { createNodeRunner, SIGNING } = require("../main/noderun.js");
const dirs = [], tmp = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), n)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** One queue, a node whose first signer waits for release(): what is queued behind it is sent or dropped. */
function queue() {
  const atNode = []; let release; const gate = new Promise(r => { release = r; });
  const q = createNodeRunner(async (c) => { if (SIGNING.test(c)) { atNode.push(c); if (c.includes("first")) await gate; return { status: true, response: {} }; } return { status: false, error: "mock" }; });
  return { atNode, release, run: (c, o) => q.run(c, undefined, o), block: () => q.run("txnsign id:first publickey:auto") };
}

test("AtomiX glue: a signer of the old engine queued at invalidate() is never sent; the old engine reaches neither the node nor the new store", async () => {
  const atomix = require("../main/atomix.js"), Q = queue();
  atomix._setDataDir(tmp("ax-abort-")); atomix._setRunner(Q.run);
  try {
    const old = atomix._buildMds(), ask = (mds, c) => new Promise(res => mds.cmd(c, res));
    const first = Q.block();
    const queued = ask(old, "txnsign id:second publickey:auto");
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(Q.atNode, ["txnsign id:first publickey:auto"]);
    atomix.invalidate();
    Q.release(); await first;
    const r = await queued;
    assert.equal(r.status, false); assert.match(r.error, /not sent: `txnsign` was still queued/);
    const late = await ask(old, "txnsign id:late publickey:auto");
    assert.equal(late.status, false); assert.match(late.error, /wallet was replaced/);
    const wrote = await new Promise(res => old.sql("CREATE TABLE late_write (k int)", res));
    assert.equal(wrote.status, false, "the old engine does not write into the new engine's store");
    await new Promise(r => setTimeout(r, 40));
    assert.ok(!Q.atNode.some(c => /second|late/.test(c)), Q.atNode.join(" | "));
    // the engine built after it signs as before
    assert.equal((await ask(atomix._buildMds(), "txnsign id:new publickey:auto")).status, true);
  } finally { atomix.stopLoop(); atomix.flush(); }
});

test("PandaPools glue: a signer of the old engine queued at invalidate() is never sent", async () => {
  const dir = tmp("pp-abort-"), Q = queue(), contexts = [], stores = [], mdsSeen = [];
  const actualSql = require("../main/pandapools/sqlshim"), loader = require("../main/pandapools/loader");
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController, AbortSignal, require: (n) => {   // the harness of pandapools-consolidation.test.cjs
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("TEST LEAK: rpcCall"); } }; if (n === "./netfetch") return { fetchJson: async () => null };
    if (n === "./pandapools/loader") return { ...loader, createContext: (mds, ...rest) => { mdsSeen.push(mds); const c = loader.createContext(mds, ...rest); contexts.push(c); return c; } };
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(M.root, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner((c, o) => (SIGNING.test(c) ? Q.run(c, o) : Promise.resolve(c === "block" ? { status: true, response: { block: 0 } } : c === "checkmode" ? { status: true, response: { writemode: true, dblocked: false } } : { status: false })));
  try {
    await api.init();
    const old = mdsSeen[0], ask = (c) => new Promise(res => old.cmd(c, res));
    const first = Q.block();
    const queued = ask("txnsign id:second publickey:auto");
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(Q.atNode, ["txnsign id:first publickey:auto"]);
    await api.invalidate().catch(() => {});
    Q.release(); await first;
    assert.equal((await queued).status, false);
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(Q.atNode, ["txnsign id:first publickey:auto"], "the queued signer of the old pool engine was dropped");
  } finally { api.stopLoop(); for (const c of contexts) { try { c.ActivityChain.stop(); } catch (e) {} } for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } }
});

// 0.18.116 (M2): hold() around a wallet-replacing megammrsync. The engine and its store stay; nothing new is signed.
test("AtomiX glue: held, no signing command reaches the node, no action and no start; atomix.sqlite stays in place; release goes on", async () => {
  const atomix = require("../main/atomix.js"), dir = tmp("ax-hold-"), sent = [];
  atomix._setDataDir(dir); atomix._setRunner(async (c) => { sent.push(c); return { status: true, response: {} }; });
  fs.writeFileSync(path.join(dir, "atomix.sqlite"), "the claim secrets of swaps in flight");
  try {
    const mds = atomix._buildMds(), ask = (c) => new Promise(res => mds.cmd(c, res));
    let slow; atomix._setRunner((c) => { sent.push(c); return c === "txnpost id:inflight" ? new Promise(r => { slow = () => r({ status: true }); }) : Promise.resolve({ status: true, response: {} }); });
    const inflight = ask("txnpost id:inflight");
    let heldDone = false; const h = atomix.hold(3000).then(() => { heldDone = true; });
    await new Promise(r => setTimeout(r, 450));
    assert.equal(heldDone, false, "hold waits for what is at the node");
    slow(); assert.equal((await inflight).status, true, "a command in flight ends with its real answer"); await h;
    const r = await ask("txnsign id:held publickey:auto");
    assert.equal(r.status, false); assert.match(r.error, /stopped while the wallet is being replaced/);
    assert.equal((await ask("send amount:1 address:0xAA")).status, false);
    assert.equal((await ask("txndelete id:held")).status, true, "a chain in flight can still clean up");
    assert.ok(!sent.some(c => /^(txnsign|send)/.test(c)), sent.join(" | "));
    await assert.rejects(atomix.init(), /stopped while the wallet is being replaced/);
    await assert.rejects(atomix.swapExecute("q"), /stopped while the wallet is being replaced/);
    atomix.startLoop(); await new Promise(r => setTimeout(r, 30));
    assert.equal(atomix.status().booted === true, false, "startLoop while held starts nothing");
    assert.deepEqual(fs.readdirSync(dir), ["atomix.sqlite"], "not moved aside");
    assert.equal(fs.readFileSync(path.join(dir, "atomix.sqlite"), "utf8"), "the claim secrets of swaps in flight");
    atomix.release(); atomix.stopLoop();
    assert.equal((await ask("txnsign id:after publickey:auto")).status, true, "the SAME engine signs again");
  } finally { atomix.release(); atomix.stopLoop(); atomix.flush(); }
});

test("PandaPools glue: held, no signing command reaches the node and no action starts; release goes on with the same engine", async () => {
  const dir = tmp("pp-hold-"), contexts = [], stores = [], mdsSeen = [], sent = [];
  const actualSql = require("../main/pandapools/sqlshim"), loader = require("../main/pandapools/loader");
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController, AbortSignal, Promise, require: (n) => {
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("TEST LEAK: rpcCall"); } }; if (n === "./netfetch") return { fetchJson: async () => null };
    if (n === "./noderun") return require("../main/noderun.js");
    if (n === "./pandapools/loader") return { ...loader, createContext: (mds, ...rest) => { mdsSeen.push(mds); const c = loader.createContext(mds, ...rest); contexts.push(c); return c; } };
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(M.root, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner((c) => { sent.push(c); return Promise.resolve(c === "block" ? { status: true, response: { block: 0 } } : c === "checkmode" ? { status: true, response: { writemode: true, dblocked: false } } : SIGNING.test(c) ? { status: true, response: {} } : { status: false }); });
  try {
    await api.init();
    const mds = mdsSeen[0], ask = (c) => new Promise(res => mds.cmd(c, res));
    await api.hold(1000);
    assert.equal(await api.quiet(500), true, "quiet() says it went quiet (0.19.243)");
    assert.ok(/if \(await quiet\(maxMs \|\| 15000\)\) releaseBuilds\(\);/.test(fs.readFileSync(path.join(M.root, "main/pandapools.js"), "utf8")), "builds are released only once it went quiet");
    sent.length = 0;
    const r = await ask("txnsign id:held publickey:auto");
    assert.equal(r.status, false); assert.match(r.error, /stopped while the wallet is being replaced/);
    assert.deepEqual(sent.filter(c => SIGNING.test(c)), []);
    await assert.rejects(api.scanNow(), /stopped while the wallet is being replaced/, "every action starts with init()");
    api.startLoop();
    api.release(); api.stopLoop();
    assert.equal(mdsSeen.length, 1, "the same engine, not a new one");
    assert.equal((await ask("txnsign id:after publickey:auto")).status, true);
  } finally { api.release(); api.stopLoop(); for (const c of contexts) { try { c.ActivityChain.stop(); } catch (e) {} } for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } }
});

// 0.19.243: hold() releases the engine's coin holds only once it went quiet; a store that cannot be moved aside is owed
test("AtomiX glue: a hold that runs out with a command still at the node keeps the coin holds; quiet() says whether it went quiet", async () => {
  const atomix = require("../main/atomix.js"), reserve = require("../main/reserve.js"), dir = tmp("ax-quiet-"), released = [];
  atomix._setDataDir(dir); const real = reserve.releaseOwner; reserve.releaseOwner = (o) => { released.push(o); };
  try {
    let slow; atomix._setRunner((c) => (c === "txnpost id:slow" ? new Promise(r => { slow = () => r({ status: true }); }) : Promise.resolve({ status: true, response: {} })));
    const mds = atomix._buildMds(), inflight = new Promise(res => mds.cmd("txnpost id:slow", res));
    await atomix.hold(350);
    assert.deepEqual(released, [], "still busy at the node: nothing released");
    assert.equal(await atomix.quiet(250), false);
    slow(); await inflight;
    assert.equal(await atomix.quiet(2000), true, "quiet once the command ended");
    atomix.release(); await atomix.hold(2000); assert.deepEqual(released, ["atomix"], "a hold that went quiet releases them");
  } finally { reserve.releaseOwner = real; atomix.release(); atomix.stopLoop(); atomix.flush(); }
});
test("AtomiX glue: a store that cannot be moved aside on a wallet replacement is owed: invalidate says so and the engine does not start until it is moved", async () => {
  const atomix = require("../main/atomix.js"), dir = tmp("ax-owed-"), db = path.join(dir, "atomix.sqlite");
  atomix._setDataDir(dir); atomix._setRunner(async () => ({ status: false, error: "mock" }));
  fs.writeFileSync(db, "the old wallet's claim secrets");
  fs.chmodSync(dir, 0o500);   // the folder cannot be written: the rename fails
  try {
    assert.throws(() => atomix.invalidate(), /old swap database could not be moved aside .*AtomiX does not start until it is/);
    await assert.rejects(atomix.init(), /AtomiX does not start: the replaced wallet's swap database could not be moved aside yet/);
    await assert.rejects(atomix.init(), /could not be moved aside yet/, "and again, until it is");
    assert.equal(fs.readFileSync(db, "utf8"), "the old wallet's claim secrets", "never opened, never changed");
    fs.chmodSync(dir, 0o700);
    const now0 = Date.now; Date.now = () => now0() + 13000;   // the next try waits out its pause (0.19.314)
    try { await atomix.init().catch(() => {}); } finally { Date.now = now0; }
    assert.ok(fs.readdirSync(dir).some(f => /^atomix\.sqlite-legacy-keys-\d{8}$/.test(f)), "moved aside at the next try: " + fs.readdirSync(dir).join(", "));
    const kept = fs.readdirSync(dir).find(f => /legacy-keys/.test(f)); assert.equal(fs.readFileSync(path.join(dir, kept), "utf8"), "the old wallet's claim secrets");
  } finally { try { fs.chmodSync(dir, 0o700); } catch (e) {} atomix.stopLoop(); atomix.flush(); }
});

// 0.19.246: PandaPools swap and createPool go through the serial queue; a pool is only of the market-fed token, with the node's decimals
test("PandaPools glue: createPool only for MxUSD with the node's decimals, swap and createPool one at a time through the queue, a quote posted once", async () => {
  const dir = tmp("pp-queue-"), contexts = [], stores = [], sent = [];
  const actualSql = require("../main/pandapools/sqlshim"), loader = require("../main/pandapools/loader");
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController, AbortSignal, Promise, require: (n) => {
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("TEST LEAK: rpcCall"); } }; if (n === "./netfetch") return { fetchJson: async () => null };
    if (n === "./noderun") return require("../main/noderun.js");
    if (n === "./pandapools/loader") return { ...loader, createContext: (mds, ...rest) => { const c = loader.createContext(mds, ...rest); contexts.push(c); return c; } };
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(M.root, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90"; let decimals = "8";
  api._setRunner((c) => { sent.push(c); return Promise.resolve(c === "block" ? { status: true, response: { block: 0 } } : c === "checkmode" ? { status: true, response: { writemode: true, dblocked: false } }
    : c === "tokens tokenid:" + MXUSD ? (decimals == null ? { status: false, error: "no" } : { status: true, response: { tokenid: MXUSD, decimals } }) : { status: false }); });
  try {
    await api.init();
    const P = contexts[0].PoolMgr, engine = [], held = [];
    P.createPool = (tok, dec, x, y, cb) => { engine.push(["create", tok, dec, x, y]); held.push(() => cb.created({ address: "0xP" + engine.length, reserveM: "1", reserveT: "1" }, "0xT" + engine.length)); };
    P.swap = (route, m2t, cb) => { engine.push(["swap", route.id]); held.push(() => cb.ok("0xS" + engine.length)); };
    contexts[0].Store.ownRecord = () => {}; contexts[0].Store.lpRecord = () => {}; contexts[0].Store.actRecord = () => {};
    await assert.rejects(api.createPool("0x" + "AB".repeat(32), 8, "100", "1"), /MINIMA \/ MxUSD pools only/); assert.deepEqual(engine, [], "another token: the engine is never entered");
    decimals = null; await assert.rejects(api.createPool(MXUSD, 8, "100", "1"), /decimals could not be read from the node/); assert.deepEqual(engine, []);
    decimals = "8"; await assert.rejects(api.createPool(MXUSD, 4, "100", "1"), /node says this token has 8 decimals, not 4/); assert.deepEqual(engine, []);
    const c1 = api.createPool(MXUSD.toLowerCase(), "8", "100", "1");
    const q = api._stashQuote({ route: { ok: true, id: "R1", totalIn: 1, totalOut: 2 }, minimaToToken: true, tokenLabel: "MxUSD" });
    const s1 = api.swap(q), s2 = api.swap(q);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(engine, [["create", MXUSD, 8, "100", "1"]], "one action at a time: the node's decimals, the token's own id; the swaps wait");
    held.shift()(); assert.equal((await c1).txpowid, "0xT1");
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(engine.map(e => e[0]), ["create", "swap"], "the swap goes after the create");
    held.shift()(); assert.equal((await s1).txpowid, "0xS2");
    await assert.rejects(s2, /This quote expired/, "the same quote queued twice is posted once"); assert.equal(engine.length, 2);
    assert.ok(sent.includes("tokens tokenid:" + MXUSD));
  } finally { api.stopLoop(); for (const c of contexts) { try { c.ActivityChain.stop(); } catch (e) {} } for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } }
});

// 0.19.271: a queue slot always settles: a throw in a callback the engine calls later rejects that slot, and the next action runs
test("PandaPools glue: a throw inside the engine's later callback (a malformed amount, a record written while the engine is gone) settles the slot; amounts are checked before the queue", async () => {
  const dir = tmp("pp-wedge-"), contexts = [], stores = [];
  const actualSql = require("../main/pandapools/sqlshim"), loader = require("../main/pandapools/loader");
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController, AbortSignal, Promise, require: (n) => {
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("TEST LEAK: rpcCall"); } }; if (n === "./netfetch") return { fetchJson: async () => null };
    if (n === "./noderun") return require("../main/noderun.js");
    if (n === "./pandapools/loader") return { ...loader, createContext: (mds, ...rest) => { const c = loader.createContext(mds, ...rest); contexts.push(c); return c; } };
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(M.root, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  api._setRunner((c) => Promise.resolve(c === "block" ? { status: true, response: { block: 0 } } : c === "checkmode" ? { status: true, response: { writemode: true, dblocked: false } }
    : c === "tokens tokenid:" + MXUSD ? { status: true, response: { tokenid: MXUSD, decimals: "8" } } : { status: false }));
  const within = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ": the slot never settled")), 1500))]);
  try {
    await api.init();
    const P = contexts[0].PoolMgr, S = contexts[0].Store, engine = [];
    S.ownRecord = () => {}; S.lpRecord = () => {}; S.actRecord = () => {};
    for (const [x, y] of [["abc", "1"], ["100", ""], ["-1", "1"], ["0", "1"], [null, "1"], ["1", { a: 1 }]]) {
      await assert.rejects(api.createPool(MXUSD, 8, x, y), /plain numbers above zero/, JSON.stringify([x, y]));
    }
    // the engine throws on its first call (inside the node's decimals reply): the slot is rejected, not left taken
    P.createPool = () => { engine.push("create"); throw new Error("[DecimalError] Invalid argument: 1x"); };
    await assert.rejects(within(api.createPool(MXUSD, 8, "100", "1"), "createPool"), /Creating the pool stopped \(\[DecimalError\] Invalid argument: 1x\)\. It may have been posted/);
    // the swap's answer comes after the engine went (its store gone): the record throws, the slot is rejected, the queue goes on
    P.swap = (route, m2t, cb) => { engine.push("swap"); setTimeout(() => cb.ok("0xS"), 5); };
    S.actRecord = () => { throw new TypeError("Cannot read properties of null (reading 'Store')"); };
    const q = api._stashQuote({ route: { ok: true, id: "R1", totalIn: 1, totalOut: 2 }, minimaToToken: true, tokenLabel: "MxUSD" });
    await assert.rejects(within(api.swap(q), "swap"), /Swap stopped .*It may have been posted: check Activity/);
    S.actRecord = () => {}; P.createPool = (tok, dec, x, y, cb) => { engine.push("create2"); setTimeout(() => cb.created({ address: "0xP", reserveM: "1", reserveT: "1" }, "0xT"), 5); };
    assert.equal((await within(api.createPool(MXUSD, 8, ".5", "1"), "the next action")).txpowid, "0xT", "the queue is not wedged");
    assert.deepEqual(engine, ["create", "swap", "create2"]);
  } finally { api.stopLoop(); for (const c of contexts) { try { c.ActivityChain.stop(); } catch (e) {} } for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } }
});

// 0.19.286: the debt names its file: when clearing it failed after the move, the NEW wallet's store is never moved aside
test("AtomiX glue: an owed move whose clearing failed after the rename never moves the new wallet's store (the debt names the file)", async () => {
  const cfgPath = require.resolve("../main/config.js"), axPath = require.resolve("../main/atomix.js"), before = require.cache[cfgPath], disk = {};
  let clearFails = true;
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, children: [], paths: [], exports: { rpcSecret: () => "", load: () => JSON.parse(JSON.stringify(disk)),
    setAtomixStoreMoveOwed: (v) => { if (v) disk.atomixStoreMoveOwed = v; else if (clearFails) throw new Error("EACCES: config.json"); else delete disk.atomixStoreMoveOwed; } } };
  const dir = tmp("ax-owed-id-"), db = path.join(dir, "atomix.sqlite"), mock = async () => ({ status: false, error: "mock" });
  delete require.cache[axPath]; let atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);
  fs.writeFileSync(db, "the old wallet's claim secrets");
  try {
    atomix.invalidate();   // moved aside; the debt could not be cleared
    assert.ok(disk.atomixStoreMoveOwed, "the debt stayed in config.json"); atomix.stopLoop(); atomix.flush();
    fs.writeFileSync(db, "the NEW wallet's swaps");   // the new wallet's engine made its own store
    delete require.cache[axPath]; atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);   // a restart
    await atomix.init().catch(() => {});
    assert.equal(fs.readdirSync(dir).filter(f => /legacy-keys/.test(f)).length, 1, "only the old store was ever moved: " + fs.readdirSync(dir).join(", "));
    assert.equal(fs.existsSync(db), true, "the new wallet's store is where it was");
  } finally { atomix.stopLoop(); atomix.flush(); if (before) require.cache[cfgPath] = before; else delete require.cache[cfgPath]; }
});

// 0.19.295: a debt written by 0.19.267 (true, no file named) met with no store left is cleared, so the new wallet's store is never moved later
test("AtomiX glue: a legacy owed-move debt with no store to move is cleared at the next start; the store made after it is left in place", async () => {
  const cfgPath = require.resolve("../main/config.js"), axPath = require.resolve("../main/atomix.js"), before = require.cache[cfgPath], disk = { atomixStoreMoveOwed: true };
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, children: [], paths: [], exports: { rpcSecret: () => "", load: () => JSON.parse(JSON.stringify(disk)),
    setAtomixStoreMoveOwed: (v) => { if (v) disk.atomixStoreMoveOwed = v; else delete disk.atomixStoreMoveOwed; } } };
  const dir = tmp("ax-owed-legacy-"), db = path.join(dir, "atomix.sqlite"), mock = async () => ({ status: false, error: "mock" });
  delete require.cache[axPath]; let atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);
  try {
    await atomix.init().catch(() => {}); atomix.stopLoop(); atomix.flush();
    assert.equal(disk.atomixStoreMoveOwed, undefined, "nothing to move: the debt is cleared");
    fs.writeFileSync(db, "the NEW wallet's swaps");
    delete require.cache[axPath]; atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);
    await atomix.init().catch(() => {});
    assert.deepEqual(fs.readdirSync(dir).filter(f => /legacy-keys/.test(f)), [], "the new store is never moved aside");
  } finally { atomix.stopLoop(); atomix.flush(); if (before) require.cache[cfgPath] = before; else delete require.cache[cfgPath]; }
});

// 0.19.314: an owed move that keeps failing is logged once and tried again with a growing pause, not rewritten and logged every 12 s
test("AtomiX glue: an owed move that keeps failing writes config.json once, logs its reason once and backs off between tries", async () => {
  const cfgPath = require.resolve("../main/config.js"), axPath = require.resolve("../main/atomix.js"), before = require.cache[cfgPath], disk = {}; let writes = 0;
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, children: [], paths: [], exports: { rpcSecret: () => "", load: () => JSON.parse(JSON.stringify(disk)),
    setAtomixStoreMoveOwed: (v) => { writes++; if (v) disk.atomixStoreMoveOwed = v; else delete disk.atomixStoreMoveOwed; } } };
  const dir = tmp("ax-owed-backoff-"), db = path.join(dir, "atomix.sqlite"), mock = async () => ({ status: false, error: "mock" }), said = [], log0 = console.log;
  delete require.cache[axPath]; const atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);
  fs.writeFileSync(db, "old"); fs.chmodSync(dir, 0o500); console.log = (...a) => said.push(a.join(" "));
  const now0 = Date.now;
  try {
    assert.throws(() => atomix.invalidate(), /could not be moved aside/);
    for (let i = 0; i < 5; i++) await assert.rejects(atomix.init(), /could not be moved aside yet/);   // the start loop, every 12 s
    assert.equal(writes, 1, "config.json written once");
    assert.equal(said.filter(l => /could not be moved aside \(/.test(l)).length, 1, "the reason logged once");
    Date.now = () => now0() + 13000; await assert.rejects(atomix.init(), /could not be moved aside yet/);   // after the pause it tries again
    assert.equal(writes, 1, "still the same debt: not written again"); assert.equal(said.filter(l => /could not be moved aside \(/.test(l)).length, 1, "the same reason: not logged again");
    fs.chmodSync(dir, 0o700); Date.now = () => now0() + 13000 + 25000;
    await atomix.init().catch(() => {});
    assert.ok(fs.readdirSync(dir).some(f => /legacy-keys/.test(f)), "moved at the next try after the longer pause"); assert.equal(disk.atomixStoreMoveOwed, undefined);
  } finally { Date.now = now0; console.log = log0; try { fs.chmodSync(dir, 0o700); } catch (e) {} atomix.stopLoop(); atomix.flush(); if (before) require.cache[cfgPath] = before; else delete require.cache[cfgPath]; }
});

test("no test reached a real node or the real network", () => { assert.deepEqual(M.leaks, []); });

// 0.19.267: the owed move aside is on disk (config.json), so a restart does not open the old wallet's store under the new one
test("AtomiX glue: a store owed a move aside is still owed after a restart (a fresh load of the glue), and is moved once it can be", async () => {
  const cfgPath = require.resolve("../main/config.js"), axPath = require.resolve("../main/atomix.js"), before = require.cache[cfgPath], disk = {};   // disk: config.json
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, children: [], paths: [], exports: { rpcSecret: () => "", load: () => JSON.parse(JSON.stringify(disk)),
    setAtomixStoreMoveOwed: (v) => { if (v) disk.atomixStoreMoveOwed = v; else delete disk.atomixStoreMoveOwed; } } };
  const dir = tmp("ax-owed-restart-"), db = path.join(dir, "atomix.sqlite"), mock = async () => ({ status: false, error: "mock" });
  let atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);
  fs.writeFileSync(db, "the old wallet's claim secrets"); fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => atomix.invalidate(), /could not be moved aside/);
    assert.ok(disk.atomixStoreMoveOwed && disk.atomixStoreMoveOwed.ino === fs.statSync(db).ino, "the debt is in config.json, naming that file");
    atomix.stopLoop(); atomix.flush();
    delete require.cache[axPath]; atomix = require("../main/atomix.js"); atomix._setDataDir(dir); atomix._setRunner(mock);   // the app restarted: nothing in memory
    await assert.rejects(atomix.init(), /could not be moved aside yet/, "the new wallet's engine does not open the old store");
    assert.equal(fs.readFileSync(db, "utf8"), "the old wallet's claim secrets", "never opened, never changed");
    fs.chmodSync(dir, 0o700);
    const now0 = Date.now; Date.now = () => now0() + 13000;   // the next try waits out its pause (0.19.314)
    try { await atomix.init().catch(() => {}); } finally { Date.now = now0; }
    const kept = fs.readdirSync(dir).find(f => /^atomix\.sqlite-legacy-keys-\d{8}$/.test(f)); assert.ok(kept, fs.readdirSync(dir).join(", "));
    assert.equal(fs.readFileSync(path.join(dir, kept), "utf8"), "the old wallet's claim secrets");
    assert.equal(disk.atomixStoreMoveOwed, undefined, "cleared once moved");
  } finally { try { fs.chmodSync(dir, 0o700); } catch (e) {} atomix.stopLoop(); atomix.flush(); if (before) require.cache[cfgPath] = before; else delete require.cache[cfgPath]; }
});
