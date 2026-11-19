/*
 * The shared coin reservation (main/reserve.js, docs/COIN_RESERVATION.md) in front of a model node
 * (scripts/reserve-model.cjs). Nothing here reaches a node, a socket or a child process.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRegistry, BUILD_MS, DEAD_MS, DEAD_BLOCKS, SWEEP_READS } = require("../main/reserve");
const { makeNode, build, coinId, ADDR } = require("./reserve-model.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reserve-test-"));
/** A registry in front of a node: as(owner) is that owner's runner (what main/rpc.js rpcCall is in the app). */
function rig(coins, o = {}) {
  const node = o.node || makeNode(coins), clock = o.clock || { t: 1e12 }, lines = [];
  const reg = createRegistry({ now: () => clock.t, log: (l) => lines.push(l) });
  const as = (owner) => (cmd) => reg.guard(owner, cmd, node.run);
  return { node, reg, as, clock, lines };
}
const wallet3 = () => [{ coinid: coinId(1), amount: "100", address: ADDR(1) }, { coinid: coinId(2), amount: "50", address: ADDR(2) }, { coinid: coinId(3), amount: "10", address: ADDR(3) }];
const HTLC = { coinid: coinId(77), amount: "5", address: ADDR(7), simple: false, state: [{ port: 0, data: "0x01" }] };

test("two engines never get the same coin into a transaction; the refused one sees the node's failure shape and deletes its transaction", async () => {
  const { node, as, reg } = rig(wallet3());
  const a = await build(as("atomix"), "axswap_1", [coinId(1)], { noPost: true });
  assert.equal(a.ok, true);
  const b = await build(as("pandapools"), "pp_1", [coinId(2), coinId(1)]);
  assert.equal(b.ok, false);
  assert.match(b.error, /^Coin 0x0{63}1 is held for an AtomiX swap\. Nothing was signed\.$/);
  assert.equal(node.saw(/^txninput id:pp_1 coinid:0x0{63}1$/).length, 0, "the refused input never reached the node");
  assert.equal(node.saw(/^txnsign id:pp_1/).length, 0, "nothing was signed");
  assert.equal(node.saw(/^txndelete id:pp_1$/).length, 1, "the builder's own txndelete ran: no half-built transaction");
  assert.equal(reg.foreign("wallet", coinId(2)), null, "the refused transaction's other coin is free again");
  assert.equal(reg.foreign("pandapools", coinId(1)).owner, "atomix");
  const raw = await as("dexicon")("txninput id:dx1 coinid:" + coinId(1) + " scriptmmr:true");
  assert.deepEqual(Object.keys(raw).sort(), ["command", "error", "pending", "reserved", "status"]);
  assert.equal(raw.status, false); assert.equal(raw.pending, false);
});

test("two callers in the same tick: exactly one gets the coin", async () => {
  const { node, as } = rig(wallet3());
  await as("atomix")("txncreate id:a"); await as("dexicon")("txncreate id:d");
  const [x, y] = await Promise.all([as("atomix")("txninput id:a coinid:" + coinId(3)), as("dexicon")("txninput id:d coinid:" + coinId(3))]);
  assert.deepEqual([x.status, y.status], [true, false]);
  assert.equal(node.saw(/^txninput /).length, 1);
});

test("the same owner may name its own coin again (a retry), and a wallet command is an owner like the others", async () => {
  const { as } = rig(wallet3());
  assert.equal((await build(as("atomix"), "a1", [coinId(1)], { noPost: true })).ok, true);
  assert.equal((await as("atomix")("txninput id:a2 coinid:" + coinId(1))).status, false, "the model node has no a2: its own answer, not a refusal");
  await as("atomix")("txncreate id:a2");
  assert.equal((await as("atomix")("txninput id:a2 coinid:" + coinId(1))).status, true);
  const w = await as("")("txninput id:t coinid:" + coinId(1));
  assert.equal(w.reserved, true); assert.match(w.error, /held for an AtomiX swap/);
});

test("every release path releases", async (t) => {
  await t.test("txndelete of a transaction that was not posted", async () => {
    const { as, reg } = rig(wallet3());
    await build(as("atomix"), "a", [coinId(1), coinId(2)], { noPost: true });
    assert.equal(reg.list().length, 2);
    await as("atomix")("txndelete id:a");
    assert.equal(reg.list().length, 0);
  });
  await t.test("a txninput the node refuses", async () => {
    const { as, reg } = rig(wallet3());
    await as("atomix")("txncreate id:a");
    assert.equal((await as("atomix")("txninput id:a coinid:" + coinId(999))).status, false);
    assert.equal(reg.list().length, 0);
  });
  await t.test("a txnpost the node rejects (status:false, not pending)", async () => {
    const { node, as, reg } = rig(wallet3());
    await build(as("atomix"), "a", [coinId(1)], { noPost: true });
    node.mempool.set(coinId(1).toLowerCase(), "elsewhere");   // spent in the mempool by something else
    assert.equal((await as("atomix")("txnpost id:a")).status, false);
    assert.equal(reg.list().length, 0);
  });
  await t.test("a txnpost that is pending, or never answers, keeps its coins", async () => {
    const { as, reg } = rig(wallet3());
    await build(as("atomix"), "a", [coinId(1)], { noPost: true });
    await reg.guard("atomix", "txnpost id:a", async () => ({ status: false, pending: true }));
    assert.equal(reg.list()[0].state, "posted");
    await build(as("atomix"), "b", [coinId(2)], { noPost: true });
    await assert.rejects(reg.guard("atomix", "txnpost id:b", async () => { throw new Error("RPC timeout"); }));
    assert.equal(reg.list().find(r => r.txn === "b").state, "posting");
    await as("atomix")("txndelete id:b");
    assert.equal(reg.list().length, 2, "a txndelete after a post releases nothing");
    assert.equal((await as("wallet")("txninput id:w coinid:" + coinId(2))).reserved, true);
  });
  await t.test("posted then mined: the sweep finds the coin spent", async () => {
    const { node, as, reg } = rig(wallet3());
    assert.equal((await build(as("pandapools"), "p", [coinId(1)])).ok, true);
    assert.equal(reg.list()[0].state, "posted");
    assert.equal(await reg.sweep(node.run), 0, "posted and in the mempool: kept");
    node.mine();
    assert.equal(await reg.sweep(node.run), 1);
    assert.equal(reg.list().length, 0);
  });
  await t.test("posted and known dead: unspent, out of the mempool, DEAD_BLOCKS and DEAD_MS later", async () => {
    const { node, as, reg, clock, lines } = rig(wallet3());
    await build(as("pandapools"), "p", [coinId(1)]);
    await reg.sweep(node.run);                      // the block of the post is noted
    node.dropMempool(); node.tick(DEAD_BLOCKS - 1); clock.t += DEAD_MS + 1;
    assert.equal(await reg.sweep(node.run), 0, "not enough blocks");
    node.tick(1); clock.t -= DEAD_MS;
    assert.equal(await reg.sweep(node.run), 0, "not enough time");
    clock.t += DEAD_MS;
    node.mempool.set(coinId(1).toLowerCase(), "p");
    assert.equal(await reg.sweep(node.run), 0, "still in the mempool: it may yet mine");
    node.dropMempool();
    assert.equal(await reg.sweep(node.run), 1);
    assert.match(lines.join("\n"), /transaction p was posted 12 blocks ago, the coin is unspent and nothing in the mempool spends it/);
  });
  await t.test("a build abandoned for BUILD_MS", async () => {
    const { node, as, reg, clock } = rig(wallet3());
    await build(as("dexicon"), "d", [coinId(1)], { noPost: true });
    clock.t += BUILD_MS; assert.equal(await reg.sweep(node.run), 0);
    clock.t += 1; assert.equal(await reg.sweep(node.run), 1);
  });
  await t.test("an engine stopped: its builds only, never its posted coins, never another owner's", async () => {
    const { as, reg } = rig(wallet3());
    await build(as("dexicon"), "d1", [coinId(1)]);
    await build(as("dexicon"), "d2", [coinId(2)], { noPost: true });
    await build(as("atomix"), "a", [coinId(3)], { noPost: true });
    assert.equal(reg.releaseOwner("dexicon"), 1);
    assert.deepEqual(reg.list().map(r => r.txn).sort(), ["a", "d1"]);
  });
  await t.test("the node stopped: every build", async () => {
    const dir = tmp(), { node, as, reg } = rig(wallet3());
    await reg.open(dir, node.run);
    await build(as("dexicon"), "d1", [coinId(1)]);
    await build(as("atomix"), "a", [coinId(3)], { noPost: true });
    reg.close();
    assert.equal(reg.list().length, 0);
    const again = createRegistry(); await again.open(dir, node.run);
    assert.deepEqual(again.list().map(r => r.txn), ["d1"]);
  });
  await t.test("the wallet replaced: everything, and the file is moved aside, never deleted", async () => {
    const dir = tmp(), { node, as, reg } = rig(wallet3());
    await reg.open(dir, node.run);
    await build(as("dexicon"), "d1", [coinId(1)]);
    const file = reg._file(), kept = reg.invalidate();
    assert.equal(reg.list().length, 0);
    assert.equal(fs.existsSync(file), false);
    assert.match(path.basename(kept), /^coin-reservations-0x[0-9a-f]{64}\.json-legacy-keys-\d{8}$/);
    assert.match(fs.readFileSync(kept, "utf8"), /"txn":"d1"/);
    reg.close(); reg.invalidate();   // closed first (the node is stopped when a wallet is replaced): nothing left to move, no throw
  });
});

test("a posted transaction that has not mined keeps its coins across an app restart", async () => {
  const dir = tmp(), node = makeNode(wallet3());
  const one = rig(null, { node }); await one.reg.open(dir, node.run);
  assert.match(path.basename(one.reg._file()), /^coin-reservations-0x[0-9a-f]{64}\.json$/);
  assert.equal(one.reg._file().includes("ABAB"), false, "the file name is a hash of the derived seed, never the seed");
  // written BEFORE the command is forwarded: the node, asked for the input, already finds it on disk
  let onDisk = null;
  await one.as("atomix")("txncreate id:a");
  await one.reg.guard("atomix", "txninput id:a coinid:" + coinId(1), async (c) => { onDisk = fs.readFileSync(one.reg._file(), "utf8"); return node.run(c); });
  assert.match(onDisk, /"state":"building"/);
  let atPost = null;
  await one.reg.guard("atomix", "txnpost id:a", async (c) => { atPost = fs.readFileSync(one.reg._file(), "utf8"); return node.run(c); });
  assert.match(atPost, /"state":"posting"/, "a crash during the post finds the coin held");
  // the app dies here (no close)
  const two = rig(null, { node }); await two.reg.open(dir, node.run);
  assert.equal(two.reg.list()[0].state, "posted");
  const r = await build(two.as("pandapools"), "p", [coinId(1)]);
  assert.match(r.error, /held for an AtomiX swap/);
  node.mine(); await two.reg.sweep(node.run);
  assert.equal(two.reg.list().length, 0);
});

test("another wallet opens another file; a node that gives no seed leaves the registry working in memory", async () => {
  const dir = tmp(), node = makeNode(wallet3()), a = rig(null, { node });
  await a.reg.open(dir, node.run);
  const b = rig(null, { node });
  await b.reg.open(dir, async (c) => (/^seedrandom/.test(c) ? { status: true, response: { seedrandom: "0x" + "CD".repeat(32) } } : node.run(c)));
  assert.notEqual(a.reg._file(), b.reg._file());
  const c = rig(null, { node });
  await c.reg.open(dir, async () => ({ status: false, error: "locked" }));
  assert.equal(c.reg._file(), null);
  assert.match(c.lines.join("\n"), /kept in memory only/);
  await build(c.as("atomix"), "a", [coinId(1)], { noPost: true });
  assert.equal((await c.as("wallet")("txninput id:w coinid:" + coinId(1))).reserved, true);
});

test("a damaged reservation file is kept aside and an empty one started", async () => {
  const dir = tmp(), node = makeNode(wallet3()), a = rig(null, { node });
  await a.reg.open(dir, node.run); const f = a.reg._file(); a.reg.close();
  fs.writeFileSync(f, "{not json");
  const b = rig(null, { node }); await b.reg.open(dir, node.run);
  assert.equal(b.reg.list().length, 0);
  assert.equal(fs.readdirSync(dir).filter(n => /legacy-keys/.test(n)).length, 1);
});

test("the sweep clears a coin spent outside the app, decides nothing without the node, and never lists the wallet", async () => {
  const many = []; for (let i = 1; i <= 60; i++) many.push({ coinid: coinId(i), amount: "1", address: ADDR(i) });
  const { node, as, reg } = rig(many);
  for (let i = 1; i <= 60; i++) await build(as("dexicon"), "d" + i, [coinId(i)], { noPost: true });
  node.spendOutside(coinId(40));   // a phone on the same node spent it
  node.setDown(true);
  assert.equal(await reg.sweep(node.run), 0, "no node: nothing is released");
  node.setDown(false); node.seen.length = 0;
  let freed = 0, sweeps = 0;
  while (!freed && sweeps < 4) { freed = await reg.sweep(node.run); sweeps++; assert.ok(node.saw(/^coins /).length <= SWEEP_READS * sweeps, "at most SWEEP_READS coin reads a sweep"); }
  assert.equal(freed, 1); assert.equal(sweeps, 2, "round robin: coin 40 is in the second turn");
  assert.equal(node.saw(/^coins (?!coinid:)/).length, 0, "only single-coin reads");
  assert.equal(reg.foreign("wallet", coinId(40)), null);
  assert.equal(reg.list().find(r => r.coinid === coinId(1)).amount, "1", "the read also fills in amount and token for the screens");
});

test("settlement is never starved: a contract coin is never refused, whoever named it first", async () => {
  const { node, as, reg } = rig(wallet3().concat([HTLC]));
  // a counterparty's order names MY HTLC coin as its backing: my own Dexicon take reserves it
  await build(as("dexicon"), "dx1", [HTLC.coinid], { noPost: true });
  const claim = await build(as("atomix"), "axswap_c", [HTLC.coinid]);
  assert.equal(claim.ok, true, "the claim went through");
  assert.equal(node.saw(/^txnpost id:axswap_c$/).length, 1);
  // PandaPools' pool reserves likewise
  assert.equal((await build(as("pandapools"), "pp", [HTLC.coinid], { noPost: true })).ok, true);
  void reg;
});

test("when the node cannot say what a coin is, a settling owner is let through and the others are refused", async () => {
  const { node, reg } = rig(wallet3());
  await build((c) => reg.guard("dexicon", c, node.run), "d", [coinId(1)], { noPost: true });
  const deaf = async (c) => (/^coins /.test(c) ? { status: false, error: "busy" } : node.run(c));
  await reg.guard("atomix", "txncreate id:a", deaf); await reg.guard("pandapools", "txncreate id:p", deaf);
  assert.equal((await reg.guard("atomix", "txninput id:a coinid:" + coinId(1), deaf)).status, true);
  assert.equal((await reg.guard("pandapools", "txninput id:p coinid:" + coinId(1), deaf)).reserved, true);
});

test("a `;` chain is refused whole when one of its inputs is held, and recorded when it runs", async () => {
  const { node, as, reg } = rig(wallet3());
  await build(as("atomix"), "a", [coinId(1)], { noPost: true });
  const chain = (id, n) => "txncreate id:" + id + ";txninput id:" + id + " coinid:" + coinId(n) + ";txnoutput id:" + id + " amount:1 address:" + ADDR(9);
  assert.equal((await as("wallet")(chain("t1", 1))).reserved, true);
  assert.equal(node.saw(/t1/).length, 0, "no part of a refused chain reached the node");
  const answers = [{ status: true }, { status: true }, { status: true }];
  await reg.guard("wallet", chain("t2", 2), async () => answers);
  assert.equal(reg.foreign("atomix", coinId(2)).txn, "t2");
});

test("thousands of coins: commands stay quick and nothing is listed", async () => {
  const many = []; for (let i = 1; i <= 4000; i++) many.push({ coinid: coinId(i), amount: "1", address: ADDR(i % 64) });
  const dir = tmp(), { node, as, reg } = rig(many);
  await reg.open(dir, node.run);
  reg.setHolds("dexicon", many.slice(0, 3000).map(c => ({ coinid: c.coinid, why: "a live Dexicon order" })));
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) await as("atomix")("balance tokenid:0x00");
  await as("atomix")("txncreate id:a");
  for (let i = 3001; i <= 3040; i++) assert.equal((await as("atomix")("txninput id:a coinid:" + coinId(i))).status, true);   // each one a durable write of 3000+ records
  for (let i = 1; i <= 40; i++) assert.equal((await as("atomix")("txninput id:a coinid:" + coinId(i))).reserved, true);
  await reg.sweep(node.run);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, "took " + ms + " ms");
  assert.equal(node.saw(/^coins (?!coinid:)/).length, 0);
});
