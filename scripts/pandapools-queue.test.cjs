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
