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

test("no test reached a real node or the real network", () => { assert.deepEqual(M.leaks, []); });
