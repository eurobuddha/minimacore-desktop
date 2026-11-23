/*
 * pandapools-queue.test.cjs — a PandaPools fund-queue slot always settles (0.18.229, as Pandamonium Desktop 0.19.271): a throw
 * inside a callback the engine calls later rejects that slot, and the next action runs; amounts are checked before the queue.
 * The real glue (main/pandapools.js) over the real loader and SQLite shim; electron, config, the node and the network stood in.
 * Run: node --test scripts/pandapools-queue.test.cjs
 */
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), Module = require("node:module");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pp-queue-")), real = Module._load;
Module._load = function (r, parent) {
  if (parent && /[\\/]main[\\/]pandapools\.js$/.test(parent.filename)) {
    if (r === "electron") return { app: { getPath: () => DIR, getVersion: () => "test" } };
    if (r === "./config") return { rpcSecret: () => "" };
    if (r === "./node-manager") return { rpcPort: () => 0 };
    if (r === "./rpc") return { rpcCall: async () => { throw new Error("TEST LEAK: rpcCall"); } };
    if (r === "./netfetch") return { fetchJson: async () => null };
  }
  return real.apply(this, arguments);
};
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

test("PandaPools glue: a throw inside the engine's later callback settles the slot and the queue goes on; amounts are checked before the queue", async () => {
  const api = require("../main/pandapools.js"); api._setDataDir(DIR);
  api._setRunner((c) => Promise.resolve(c === "block" ? { status: true, response: { block: 0 } } : c === "checkmode" ? { status: true, response: { writemode: true, dblocked: false } } : { status: false }));
  const within = (p, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ": the slot never settled")), 1500); })]).finally(() => clearTimeout(t)); };
  try {
    await api.init();
    const ctx = api._ctx(), P = ctx.PoolMgr, S = ctx.Store, engine = [];
    const pool = { address: "0x" + "AA".repeat(32), opk: "0x" + "BB".repeat(32), oadr: "0x" + "CC".repeat(32) };
    api._setPools([pool]);
    for (const [x, y] of [["abc", "1"], ["100", ""], ["-1", "1"], ["0", "1"], [null, "1"], ["1", { a: 1 }]]) {
      await assert.rejects(api.migrate(pool.address, x, y), /plain numbers above zero/, JSON.stringify([x, y]));
      await assert.rejects(api.createPool("0x00", 8, x, y), /plain numbers above zero/, JSON.stringify([x, y]));
    }
    P.ensureOwnerKeys = (keys, cb) => setTimeout(() => cb([], []), 1);
    // the withdraw's answer comes after the engine's store went: the record throws, the slot is rejected, not left taken
    P.close = (p, cb) => { engine.push("close"); setTimeout(() => cb.ok("0xC"), 5); };
    S.setRetired = () => { throw new TypeError("Cannot read properties of null (reading 'Store')"); };
    await assert.rejects(within(api.close(pool.address), "close"), /WITHDRAW stopped \(Cannot read properties of null \(reading 'Store'\)\)\. It may have been posted: check Activity/);
    // a throw inside the owner-key check's answer (migrate: the engine throws on its call) rejects its slot too
    P.migrate = () => { engine.push("migrate"); throw new Error("[DecimalError] Invalid argument: 1x"); };
    await assert.rejects(within(api.migrate(pool.address, "10", "10"), "migrate"), /Migrate stopped \(\[DecimalError\] Invalid argument: 1x\)\. It may have been posted/);
    // the next action runs: the queue is not wedged
    S.actRecord = () => {}; P.deposit = (p, m, t, d) => { engine.push("deposit"); setTimeout(() => d.ok("0xD"), 5); };
    assert.equal((await within(api.deposit(pool.address, "1", "1"), "the next action")).txpowid, "0xD");
    assert.deepEqual(engine, ["close", "migrate", "deposit"]);
  } finally { try { api.stopLoop(); } catch (e) {} try { api.flush(); } catch (e) {} try { api._ctx().ActivityChain.stop(); } catch (e) {} }
});

// ---- 0.18.241: the Minima dollar token is MxUSD by its id in what the desktop writes (it said "USDT", the Ethereum leg's name) ----
test("PandaPools glue: the activity labels and a swap's record name the Minima dollar token MxUSD by its id; another token keeps the engine's name", async () => {
  const api = require("../main/pandapools.js"), MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", OTHER = "0x" + "DD".repeat(32);
  await api.init(); const ctx = api._ctx(), P = ctx.PoolMgr, S = ctx.Store;
  try {
    api._setPools([]); assert.equal(api._activityLabels()[MXUSD.toLowerCase()], "MxUSD", "with no pool in the scan");
    api._setPools([{ address: "0x" + "A1".repeat(32), tok: MXUSD, tokName: "mxUSDT" }, { address: "0x" + "A2".repeat(32), tok: OTHER, tokName: "Panda" }]);
    const labels = api._activityLabels();
    assert.equal(labels[MXUSD.toLowerCase()], "MxUSD", "whatever name its creator wrote on the chain"); assert.equal(labels[OTHER.toLowerCase()], "Panda");
    assert.ok(!Object.values(labels).some(l => /USDT/.test(l)), JSON.stringify(labels));
    // a swap's record
    const recorded = []; S.actRecord = (kind, summary) => recorded.push(summary);
    ctx.Router.route = () => ({ ok: true, totalIn: ctx.PP.D(1), totalOut: ctx.PP.D(2), effPrice: ctx.PP.D(2), spotBefore: ctx.PP.D(2), poolsUsed: 1, poolsAvailable: 1 });
    P.swap = (route, m2t, cb) => setTimeout(() => cb.ok("0xS"), 1);
    const q = api.quoteSwap(MXUSD, true, "1"); assert.equal(q.ok, true, JSON.stringify(q));
    await api.swap(q.quoteId);
    assert.deepEqual(recorded, ["Sold 1 MINIMA for 2 MxUSD"]);
  } finally { try { api.stopLoop(); } catch (e) {} try { api.flush(); } catch (e) {} try { ctx.ActivityChain.stop(); } catch (e) {} }
});

// 0.18.324: a txnpost the node did not answer is pending (its inputs stay held), not a refusal that frees them; a post that never reached
// the node, and every other command's failure, stay a plain {status:false}
test("PandaPools glue: an unanswered txnpost is pending, never a refusal; a never-sent post and other commands are plain failures", async () => {
  const api = require("../main/pandapools.js"); api._setDataDir(DIR);
  let fail = null;
  api._setRunner((c) => c === "block" ? Promise.resolve({ status: true, response: { block: 0 } }) : c === "checkmode" ? Promise.resolve({ status: true, response: { writemode: true, dblocked: false } })
    : fail ? Promise.reject(fail()) : Promise.resolve({ status: true, response: {} }));
  await api.init();
  const mds = api._ctx().MDS, ask = (c) => new Promise((r) => mds.cmd(c, r));
  try {
    fail = () => new Error("RPC timeout");
    const r = await ask("txnpost id:pp1");
    assert.equal(r.status, false); assert.equal(r.pending, true, "kept held"); assert.match(r.error, /^the node did not answer txnpost/);
    fail = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); assert.equal((await ask("txnpost id:pp1 auto:true")).pending, true);
    fail = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", notSent: true }); assert.deepEqual(await ask("txnpost id:pp1"), { status: false }, "never reached the node");
    fail = () => new Error("RPC timeout"); assert.deepEqual(await ask("txnsign id:pp1 publickey:auto"), { status: false }, "not a post");
    // the engine reads it as pending, so poolmgr keeps the posted inputs claimed (it frees them only on status:false and not pending)
    assert.ok(/if \(rp && rp\.status === false && !isPending\(rp\)\) PoolInputClaims\.release/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "main", "pandapools", "poolmgr.js"), "utf8")));
  } finally { fail = null; api.stopLoop(); }
});

// 0.18.326: a txnpost that was sent and is answered only after the wallet identity changed (invalidate bumps the epoch) is pending, never a
// bare {status:false}: that freed the claims of a transaction that may have been broadcast
test("PandaPools glue: a txnpost answered after an identity change is pending; another command answered then is a plain failure", async () => {
  const api = require("../main/pandapools.js"); api._setDataDir(DIR);
  let release = null;
  api._setRunner((c) => c === "block" ? Promise.resolve({ status: true, response: { block: 0 } }) : c === "checkmode" ? Promise.resolve({ status: true, response: { writemode: true, dblocked: false } })
    : /^txn(post|sign)/.test(c) ? new Promise((r) => { const prev = release; release = () => { if (prev) prev(); r({ status: false, error: "late" }); }; }) : Promise.resolve({ status: true, response: {} }));
  await api.init();
  const mds = api._ctx().MDS, posted = new Promise((r) => mds.cmd("txnpost id:pp2", r)), signed = new Promise((r) => mds.cmd("txnsign id:pp2 publickey:auto", r));
  await new Promise((r) => setTimeout(r, 20));
  try {
    await api.invalidate(); release();
    const p = await posted; assert.equal(p.pending, true, "sent before the change: may be broadcast"); assert.match(p.error, /^the node did not answer txnpost/);
    assert.deepEqual(await signed, { status: false });
  } finally { api.stopLoop(); }
});
