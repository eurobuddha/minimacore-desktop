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
  const reg = createRegistry({ now: () => clock.t, log: (l) => lines.push(l), sends: o.sends || "enforce", openWait: o.openWait });   // the tests of 0.18.143 to 0.18.147 are of the ENFORCING guard; the default is "observe" (below)
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
    assert.equal(await reg.sweep(node.run), 0, "M4: one miss decides nothing");
    assert.equal(await reg.sweep(node.run), 1, "two sweeps running: spent");
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
    assert.equal(fs.statSync(again._file()).mode & 0o777, 0o600, "L4: the file is the owner's alone");
    assert.deepEqual(again.list().map(r => r.txn), ["d1"]);
  });
  await t.test("the wallet replaced: everything, and the file is moved aside, never deleted", async () => {
    const dir = tmp(), { node, as, reg } = rig(wallet3());
    await reg.open(dir, node.run);
    await build(as("dexicon"), "d1", [coinId(1)]);
    const file = reg._file(), kept = reg.invalidate();
    assert.equal(reg.list().length, 0);
    assert.equal(fs.existsSync(file), false);
    assert.match(path.basename(kept), /^coin-reservations-pk-0x[0-9a-f]{64}\.json-legacy-keys-\d{8}$/);
    assert.match(fs.readFileSync(kept, "utf8"), /"txn":"d1"/);
    reg.close(); reg.invalidate();   // closed first (the node is stopped when a wallet is replaced): nothing left to move, no throw
  });
});

test("a posted transaction that has not mined keeps its coins across an app restart", async () => {
  const dir = tmp(), node = makeNode(wallet3());
  const one = rig(null, { node }); await one.reg.open(dir, node.run);
  assert.match(path.basename(one.reg._file()), /^coin-reservations-pk-0x[0-9a-f]{64}\.json$/);
  assert.equal(one.reg._file().toLowerCase().includes("abab"), false, "the file name is a hash of the wallet's first public key, not the key");
  assert.equal(node.saw(/^seedrandom/).length, 0, "nothing is derived from the seed to name the file");
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
  node.mine(); await two.reg.sweep(node.run); await two.reg.sweep(node.run);
  assert.equal(two.reg.list().length, 0);
});

test("another wallet opens another file; a node that shows no key leaves the registry working in memory", async () => {
  const dir = tmp(), node = makeNode(wallet3()), a = rig(null, { node });
  await a.reg.open(dir, node.run);
  const b = rig(null, { node });
  await b.reg.open(dir, async (c) => (/^keys/.test(c) ? { status: true, response: { keys: [{ modifier: "0x00", publickey: "0x" + "CD".repeat(32) }] } } : node.run(c)));
  assert.notEqual(a.reg._file(), b.reg._file());
  const c = rig(null, { node });
  await c.reg.open(dir, async () => ({ status: false, error: "locked" }));
  assert.equal(c.reg._file(), null);
  assert.match(c.lines.join("\n"), /kept in memory only; it is tried again every minute/);
  await c.reg.open(dir, async () => ({ status: false, error: "locked" }));
  assert.equal(c.lines.length, 1, "the same failure is said once");
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
  while (!freed && sweeps < 8) { freed = await reg.sweep(node.run); sweeps++; assert.ok(node.saw(/^coins /).length <= SWEEP_READS * sweeps, "at most SWEEP_READS coin reads a sweep"); }
  assert.equal(freed, 1); assert.equal(sweeps, 4, "round robin: coin 40 is missed in the second turn and again in the fourth (M4: two misses running)");
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

test("M1: when the node cannot say what a coin is, every engine is let through (and it is logged); only the wallet is refused", async () => {
  const { node, reg } = rig(wallet3());
  await build((c) => reg.guard("dexicon", c, node.run), "d", [coinId(1)], { noPost: true });
  const deaf = async (c) => (/^coins /.test(c) ? { status: false, error: "busy" } : node.run(c));
  for (const [o, id] of [["atomix", "a"], ["pandapools", "p"], ["casino", "c"], ["wallet", "w"]]) await reg.guard(o, "txncreate id:" + id, deaf);
  assert.equal((await reg.guard("atomix", "txninput id:a coinid:" + coinId(1), deaf)).status, true);
  assert.equal((await reg.guard("pandapools", "txninput id:p coinid:" + coinId(1), deaf)).status, true, "a pool operation is not failed by an unanswered read");
  assert.equal((await reg.guard("casino", "txninput id:c coinid:" + coinId(1), deaf)).status, true);
  assert.equal((await reg.guard("wallet", "txninput id:w coinid:" + coinId(1), deaf)).reserved, true, "the wallet's own command fails closed");
  const thrown = async (c) => { if (/^coins /.test(c)) throw new Error("RPC timeout"); return node.run(c); };
  await reg.guard("dexicon", "txncreate id:d2", thrown);
  const d = createRegistry({ sends: "enforce" }); await build((c) => d.guard("atomix", c, node.run), "a9", [coinId(2)], { noPost: true });
  await d.guard("dexicon", "txncreate id:d3", node.run);
  assert.equal((await d.guard("dexicon", "txninput id:d3 coinid:" + coinId(2), thrown)).status, true, "a read that throws is the same: an engine goes through");
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

// ---- 0.18.144: send, consolidate, and what an engine is shown ----
const { MXUSD } = require("./reserve-model.cjs");
const { pinSend, pinMinimaSend, toUnits, fromUnits } = require("../main/sendpin");
const ORDER = "a live Dexicon order";
const hold = (reg, ...ids) => reg.setHolds("dexicon", ids.map(c => ({ coinid: c, why: ORDER })));

test("with nothing held by anyone else, a send, a consolidate and a coins read pass byte for byte and cost no extra read", async () => {
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));
  for (const c of ["send amount:60 address:" + ADDR(9), "send amount:1 address:" + ADDR(9) + " tokenid:" + MXUSD + ' state:{"0":"0x01"}', "consolidate tokenid:0x00", "coins relevant:true sendable:true tokenid:0x00"]) {
    node.seen.length = 0;
    await as("dexicon")(c);   // the holder itself
    assert.deepEqual(node.seen, [c]);
  }
  const lone = rig(wallet3());
  await lone.as("wallet")("send amount:60 address:" + ADDR(9));
  assert.deepEqual(lone.node.seen, ["send amount:60 address:" + ADDR(9)]);
});

test("a send that lets the node choose is pinned away from a held coin, or refused before signing with the reason", async () => {
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));   // 100 at address 1 backs a live order; free: 50 at address 2, 10 at address 3
  const r = await as("atomix")("send amount:40 mine:true address:" + ADDR(7) + ' state:{"0":"0x01"} tokenid:0x00');
  assert.equal(r.status, true);
  assert.deepEqual(r.response.inputs, [coinId(2)], "the node took the free coin");
  assert.match(node.seen[node.seen.length - 1], new RegExp(" tokenid:0x00 fromaddress:" + ADDR(2) + "$"));
  // 60 would need the held coin (the node alone would have taken coin 1: the only one that covers)
  node.dropMempool(); node.seen.length = 0;
  const no = await as("wallet")("send amount:60 address:" + ADDR(9));
  assert.equal(no.status, false); assert.equal(no.reserved, true);
  assert.equal(no.error, "Not enough free funds: 100 MINIMA is held for a live Dexicon order (a send takes its coins from one address, so coins at an address with a held coin count as held). Free: 60 MINIMA, and no single address holds the 60 this send needs. Nothing was signed.");
  assert.equal(node.saw(/^send /).length, 0, "the send never reached the node");
  assert.equal(node.mempool.size, 0);
  const all = await as("pandapools")("send amount:500 address:" + ADDR(9));
  assert.match(all.error, /Free: 60 MINIMA\. Nothing was signed\.$/);
});

test("a token send is pinned the same way (MxUSD), in token units", async () => {
  const usd = [{ coinid: coinId(11), amount: "30", address: ADDR(1), tokenid: MXUSD }, { coinid: coinId(12), amount: "7.5", address: ADDR(2), tokenid: MXUSD }];
  const { node, as, reg } = rig(wallet3().concat(usd));
  hold(reg, coinId(11));
  const ok = await as("atomix")("send amount:7.5 mine:true address:" + ADDR(7) + " tokenid:" + MXUSD);
  assert.deepEqual(ok.response.inputs, [coinId(12)]);
  node.dropMempool();
  const no = await as("atomix")("send amount:7.50000001 mine:true address:" + ADDR(7) + " tokenid:" + MXUSD);
  assert.match(no.error, /^Not enough free funds: 30 MxUSD is held for a live Dexicon order .* Free: 7\.5 MxUSD\. Nothing was signed\.$/);
  // MINIMA is untouched by an MxUSD hold: no MINIMA coin is held, so the send goes out as it came
  node.seen.length = 0;
  await as("wallet")("send amount:60 address:" + ADDR(9));
  assert.equal(node.seen[node.seen.length - 1], "send amount:60 address:" + ADDR(9));
});

test("a free coin that shares an address with a held coin is not sendable while it is held; a caller's own fromaddress: is checked", async () => {
  const { node, as, reg } = rig([{ coinid: coinId(1), amount: "100", address: ADDR(1) }, { coinid: coinId(2), amount: "50", address: ADDR(1) }, { coinid: coinId(3), amount: "10", address: ADDR(3) }]);
  hold(reg, coinId(1));
  const no = await as("wallet")("send amount:20 address:" + ADDR(9));
  assert.match(no.error, /^Not enough free funds: 150 MINIMA is held .* Free: 10 MINIMA\. Nothing was signed\.$/);
  const pinned = await as("wallet")("send amount:5 address:" + ADDR(9) + " fromaddress:" + ADDR(1));
  assert.equal(pinned.error, "Not sent: the address this send takes its coins from holds coin " + coinId(1) + ", held for a live Dexicon order. Nothing was signed.");
  assert.equal((await as("wallet")("send amount:5 address:" + ADDR(9) + " fromaddress:" + ADDR(3))).status, true);
  assert.equal(node.saw(/^send /).length, 1);
});

test("the pin every caller already uses leaves held addresses out too, and says nothing new when nothing is held", async () => {
  const node = makeNode(wallet3());
  const none = await pinMinimaSend(node.run, "send amount:60 address:" + ADDR(9), { held: () => null });
  assert.equal(none, "send amount:60 address:" + ADDR(9) + " fromaddress:" + ADDR(1));
  const heldOne = (id) => (id === coinId(1) ? { coinid: id, owner: "dexicon", why: ORDER } : null);
  assert.equal(await pinMinimaSend(node.run, "send amount:40 address:" + ADDR(9), { held: heldOne }), "send amount:40 address:" + ADDR(9) + " fromaddress:" + ADDR(2));
  assert.equal(await pinMinimaSend(node.run, "send amount:60 address:" + ADDR(9), { held: heldOne }), "send amount:60 address:" + ADDR(9), "no free address covers: left for the guard to refuse");
  const p = await pinSend(node.run, "send multi:[\"" + ADDR(8) + ":20\",\"" + ADDR(9) + ":25.5\"] burn:0.5", { held: heldOne });
  assert.equal(p.need, "46"); assert.equal(p.command.endsWith(" fromaddress:" + ADDR(2)), true);
  assert.equal(fromUnits(toUnits("0.00000000000000000000000000000000000000000001")), "0.00000000000000000000000000000000000000000001", "44 decimals, exact");
});

test("consolidate is refused while another owner holds a coin of that token, saying what holds it", async () => {
  const { node, as, reg } = rig(wallet3().concat([{ coinid: coinId(11), amount: "30", address: ADDR(1), tokenid: MXUSD }]));
  hold(reg, coinId(1));
  const no = await as("wallet")("consolidate tokenid:0x00");
  assert.equal(no.error, "Nothing consolidated: 1 coin is held for a live Dexicon order, and consolidating chooses its own coins and could take it. Try again when it is free. Nothing was signed.");
  assert.equal((await as("atomix")("consolidate tokenid:0x00 coinage:3 maxcoins:20 maxsigs:5")).reserved, true, "AtomiX's own tidy-up too");
  assert.equal(node.saw(/^consolidate /).length, 0);
  // M5: the held coin's token is asked of the node at the command, not left unknown until the next sweep
  const deaf = async (c) => (/^coins coinid:/.test(c) ? { status: false, error: "busy" } : node.run(c));
  const other = rig(wallet3()); hold(other.reg, coinId(1));
  assert.equal((await other.reg.guard("wallet", "consolidate tokenid:" + MXUSD, deaf)).reserved, true, "the node does not say what the held coin is: it counts");
  assert.equal(other.reg.list()[0].tokenid, null);
  assert.notEqual((await as("wallet")("consolidate tokenid:" + MXUSD)).reserved, true, "known to be MINIMA: MxUSD may be consolidated, with no sweep in between");
  assert.equal(reg.list()[0].tokenid, "0x00");
  assert.equal((await as("wallet")("consolidate tokenid:0x00 dryrun:true")).status, true);
  assert.equal((await as("dexicon")("consolidate tokenid:0x00")).status, true, "the holder itself");
  reg.setHolds("dexicon", []);
  node.dropMempool();
  assert.equal((await as("wallet")("consolidate tokenid:0x00")).status, true, "free again");
});

test("an engine's own read of its wallet coins leaves out what another owner holds; the wallet, and a look at one coin, see everything", async () => {
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));
  const ids = async (owner, c, o) => (await reg.guard(owner, c, node.run, o)).response.map(x => x.coinid);
  assert.deepEqual(await ids("atomix", "coins relevant:true sendable:true tokenid:0x00 coinage:1 checkmempool:true"), [coinId(2), coinId(3)]);
  assert.deepEqual(await ids("pandapools", "coins relevant:true sendable:true tokenid:0x00"), [coinId(2), coinId(3)]);
  assert.deepEqual(await ids("dexicon", "coins relevant:true checkmempool:true tokenid:0x00"), [coinId(1), coinId(2), coinId(3)], "the holder sees its own");
  assert.deepEqual(await ids("wallet", "coins relevant:true sendable:true tokenid:0x00"), [coinId(1), coinId(2), coinId(3)]);
  assert.deepEqual(await ids("atomix", "coins relevant:true sendable:true tokenid:0x00", { unfiltered: true }), [coinId(1), coinId(2), coinId(3)]);
  assert.deepEqual(await ids("atomix", "coins coinid:" + coinId(1)), [coinId(1)]);
  assert.deepEqual(await ids("atomix", "coins relevant:true"), [coinId(1), coinId(2), coinId(3)], "not a choice of inputs: untouched");
  void as;
});

test("nothing waits when every free coin is held: each command fails at once with the reason, and a claim still goes through", async () => {
  const { node, as, reg } = rig(wallet3().concat([HTLC]));
  hold(reg, coinId(1), coinId(2), coinId(3));
  const t0 = Date.now();
  const got = await Promise.all([
    build(as("atomix"), "lock", [coinId(1)]),
    build(as("pandapools"), "pp", [coinId(2), coinId(3)]),
    as("wallet")("send amount:1 address:" + ADDR(9)),
    as("atomix")("send amount:1 mine:true address:" + ADDR(7) + " tokenid:0x00"),
    as("wallet")("consolidate tokenid:0x00"),
    as("wallet")("txncreate id:t;txninput id:t coinid:" + coinId(1) + ";send amount:1 address:" + ADDR(9))
  ]);
  assert.ok(Date.now() - t0 < 1000);
  assert.match(got[0].error, /^Coin 0x0{63}1 is held for a live Dexicon order\. Nothing was signed\.$/);
  assert.match(got[1].error, /^Coin 0x0{63}2 is held/);
  assert.match(got[2].error, /^Not enough free funds: 160 MINIMA is held for a live Dexicon order .* Free: 0 MINIMA\. Nothing was signed\.$/);
  assert.match(got[3].error, /^Not enough free funds/);
  assert.match(got[4].error, /^Nothing consolidated: 3 coins are held/);
  assert.equal(got[5].reserved, true);
  assert.equal(node.saw(/^(send|consolidate|txnsign|txnpost) /).length, 0, "nothing was signed or sent");
  assert.equal((await build(as("atomix"), "axswap_claim", [HTLC.coinid])).ok, true, "the claim spends the HTLC coin itself");
  assert.equal((await build(as("atomix"), "axswap_refund", [HTLC.coinid], { noPost: true })).ok, true);
  assert.equal((await as("wallet")("txncreate id:u;send amount:1 address:" + ADDR(9))).error, "Not sent: coins are held for an AtomiX swap and a live Dexicon order, and a send or a consolidation inside a chain of commands cannot be kept away from them. Run it as one command. Nothing was signed.");
});

// ---- 0.18.145: standing collateral (the coins of a live Dexicon FAST order) ----
const { HOLD_STALE_MS } = require("../main/reserve");

test("a FAST order's backing coin cannot be spent by an AtomiX lock, a pool operation or a wallet send while the order is live; it is free when the order is cancelled, filled or expired", async () => {
  const { node, as, reg, clock } = rig(wallet3());
  const order = (coins, until) => reg.setHolds("dexicon", coins.map(c => ({ coinid: c, why: ORDER, until })));
  order([coinId(1)]);
  const tries = async () => [
    (await build(as("atomix"), "axswap_lock" + node.seen.length, [coinId(1)])).ok,                                   // lockFromCoins
    (await as("atomix")("send amount:100 mine:true address:" + ADDR(7) + ' state:{"0":"0x01"} tokenid:0x00')).status,  // lock by send
    (await build(as("pandapools"), "pp" + node.seen.length, [coinId(2), coinId(1)])).ok,                               // a pool operation funded from the wallet
    (await as("wallet")("send amount:100 address:" + ADDR(9))).status,                                                 // Wallet Send
    (await as("wallet")("send amount:100 address:" + ADDR(9) + " split:10")).status                                    // Wallet Split
  ];
  assert.deepEqual(await tries(), [false, false, false, false, false]);
  assert.equal(node.mempool.size, 0, "coin 1 was never spent, and nothing else was");
  assert.equal(node.saw(/^txninput id:\S+ coinid:0x0{63}1$/).length, 0);
  // the maker itself still uses it (its relock, the fill it co-signs)
  assert.equal((await build(as("dexicon"), "rl1", [coinId(1)], { noPost: true })).ok, true);
  await as("dexicon")("txndelete id:rl1");
  assert.equal(reg.foreign("atomix", coinId(1)).why, ORDER, "the maker's own transaction gone, the order's hold is still there");
  // cancelled: the engine's list no longer has the coin
  order([]);
  assert.equal((await build(as("atomix"), "axswap_after_cancel", [coinId(1)], { noPost: true })).ok, true);
  await as("atomix")("txndelete id:axswap_after_cancel");
  // filled: the order now names its change coin instead
  order([coinId(2)]);
  assert.equal((await build(as("pandapools"), "pp_after_fill", [coinId(1)], { noPost: true })).ok, true);
  assert.equal((await build(as("pandapools"), "pp_after_fill2", [coinId(2)], { noPost: true })).ok, false);
  await as("pandapools")("txndelete id:pp_after_fill");
  // expired: the order's own expiry, with no engine there to say so
  order([coinId(3)], clock.t + 60000);
  assert.equal((await as("wallet")("txninput id:w coinid:" + coinId(3))).reserved, true);
  clock.t += 60001;
  await reg.sweep(node.run);
  assert.equal(reg.foreign("wallet", coinId(3)), null);
});

test("a hold survives an app restart, lapses when its source stops listing it for a day, and a coin spent outside the app does not come back", async () => {
  const dir = tmp(), node = makeNode(wallet3()), clock = { t: 1e12 };
  const one = rig(null, { node, clock }); await one.reg.open(dir, node.run);
  hold(one.reg, coinId(1), coinId(2));
  const two = rig(null, { node, clock }); await two.reg.open(dir, node.run);   // the app died and started again; Dexicon is not up yet
  assert.equal((await build(two.as("atomix"), "a", [coinId(1)])).ok, false, "held from the file, before the Dexicon engine has said anything");
  two.reg.setHoldSource("dexicon", () => null);   // the engine cannot say (it never came up)
  clock.t += HOLD_STALE_MS; await two.reg.sweep(node.run);
  assert.equal(two.reg.list().length, 2, "not yet a day");
  clock.t += 1; await two.reg.sweep(node.run);
  assert.equal(two.reg.list().length, 0, "no hold outlives its source by more than a day");
  // spent by a phone on the same node while the engine's list still names it
  const three = rig(null, { node, clock });
  three.reg.setHoldSource("dexicon", () => [{ coinid: coinId(1), why: ORDER }]);
  await three.reg.sweep(node.run); assert.equal(three.reg.list().length, 1);
  node.spendOutside(coinId(1));
  await three.reg.sweep(node.run); await three.reg.sweep(node.run);
  assert.equal(three.reg.list().length, 0, "the source still lists it; the node says it is gone");
});

test("settlement wins: a settlement transaction takes a coin that is only collateral; an AtomiX lock does not", async () => {
  const { node, as, reg, lines } = rig(wallet3().concat([HTLC]));
  hold(reg, coinId(1));
  // a lock: plain coins only. Refused.
  assert.equal((await build(as("atomix"), "axswap_lock", [coinId(2), coinId(1)])).ok, false);
  // a settlement that carries its contract coin and then needs a plain coin that is collateral: it goes through
  await as("casino")("txncreate id:svc_reveal_1");
  assert.equal((await as("casino")("txninput id:svc_reveal_1 coinid:" + HTLC.coinid)).status, true);
  assert.equal((await as("casino")("txninput id:svc_reveal_1 coinid:" + coinId(1))).status, true);
  assert.match(lines.join("\n"), /settlement first: coin 0x0{63}1 was held for a live Dexicon order and goes into a P2P Chance transaction svc_reveal_1/);
  assert.equal(reg.foreign("dexicon", coinId(1)).owner, "casino", "the maker now finds its coin taken: its own pre-sign check and refresh deal with it");
  // but never a coin that is in another owner's TRANSACTION (that would be a double spend)
  await build(as("pandapools"), "pp", [coinId(3)], { noPost: true });
  assert.equal((await as("casino")("txninput id:svc_reveal_1 coinid:" + coinId(3))).reserved, true);
  // and PandaPools, which has no deadline of that kind, does not get this
  hold(reg, coinId(2));
  await as("pandapools")("txncreate id:pp2"); await as("pandapools")("txninput id:pp2 coinid:" + HTLC.coinid);
  assert.equal((await as("pandapools")("txninput id:pp2 coinid:" + coinId(2))).reserved, true);
  void node;
});

// ---- 0.18.146: what the Wallet is told ----
test("the Wallet's figures: per token, what is held (with the coins that share an address) and what is free, exact; a posted transaction is the node's to count", async () => {
  const usd = [{ coinid: coinId(11), amount: "30.000001", address: ADDR(1), tokenid: MXUSD }, { coinid: coinId(12), amount: "7.5", address: ADDR(2), tokenid: MXUSD }];
  const { node, as, reg } = rig([{ coinid: coinId(1), amount: "100", address: ADDR(1) }, { coinid: coinId(2), amount: "0.00000001", address: ADDR(1) }, { coinid: coinId(3), amount: "10", address: ADDR(3) }].concat(usd));
  assert.deepEqual(await reg.funds("wallet", node.run), []);
  hold(reg, coinId(1));
  await build(as("atomix"), "axswap_1", [coinId(11)], { noPost: true });
  node.seen.length = 0;
  const f = await reg.funds("wallet", node.run);
  assert.deepEqual(f.sort((a, b) => a.tokenid.localeCompare(b.tokenid)), [
    { tokenid: "0x00", held: "100.00000001", free: "10", why: "a live Dexicon order" },
    { tokenid: MXUSD.toLowerCase(), held: "30.000001", free: "7.5", why: "an AtomiX swap" }]);
  assert.equal(node.saw(/^coins relevant:true sendable:true checkmempool:true tokenid:/).length, 2, "one wallet read per token that has a held coin");
  assert.deepEqual(await reg.funds("dexicon", node.run), [{ tokenid: MXUSD.toLowerCase(), held: "30.000001", free: "7.5", why: "an AtomiX swap" }], "the holder's own coins are not held from itself");
  await as("atomix")("txnpost id:axswap_1");
  assert.deepEqual((await reg.funds("wallet", node.run)).map(x => x.tokenid), ["0x00"], "posted: the coin is in the mempool and the node's own sendable already leaves it out");
  assert.deepEqual(reg.list().map(r => [r.coinid, r.owner, r.state]).sort(), [[coinId(1), "dexicon", "held"], [coinId(11), "atomix", "posted"]]);
  const fs2 = require("node:fs"), root = require("node:path").join(__dirname, "..");
  assert.match(fs2.readFileSync(root + "/main/main.js", "utf8"), /ipcMain\.handle\("mcd:reserved", async \(\) => \{\s+if \(node\.state !== "running"\) return \{ coins: \[\], funds: \[\] \};[\s\S]{0,400}return \{ coins: reserve\.list\(\)\.filter\(r => r\.owner !== "wallet"\), funds: m\.sends === "enforce" \? await reserve\.funds\("wallet", reserveRead\) : \[\], mode: m \};/);
  assert.match(fs2.readFileSync(root + "/main/preload.js", "utf8"), /reserved: \(\) => ipcRenderer\.invoke\("mcd:reserved"\)/);
});

// ---- 0.18.147 ----
test("a coin its owner has posted stays held when the same owner builds and deletes a second transaction with it; a late open keeps what memory holds", async () => {
  const dir = tmp(), { node, as, reg } = rig(wallet3());
  await build(as("pandapools"), "p1", [coinId(1)]);                       // posted, not mined
  await build(as("pandapools"), "p2", [coinId(1)], { noPost: true });     // its own retry names the coin again
  await as("pandapools")("txndelete id:p2");
  assert.equal(reg.list().length, 1); assert.equal(reg.list()[0].txn, "p1");
  assert.equal((await as("atomix")("txninput id:a coinid:" + coinId(1))).reserved, true);
  // the file could not be opened at start and is opened a minute later: nothing held in memory is lost, and it is written
  await reg.open(dir, node.run);
  assert.equal(reg.list().length, 1);
  hold(reg, coinId(2));
  assert.match(fs.readFileSync(reg._file(), "utf8"), /"txn":"p1"[\s\S]*"why":"a live Dexicon order"/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8"), /reserve\._file\(\) \? Promise\.resolve\(\) : reserve\.open\(app\.getPath\("userData"\), reserveRead\)/);
});

// ---- 0.19.100: the review of the reservation ("do not ship fully enabled") ----
const { parse, OPEN_WAIT_MS, PIN_COINAGE } = require("../main/reserve");
const SRC = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("the default setting: sends and consolidate are OBSERVED (logged, byte-identical); txninput and the engines' coin reads are enforced", async () => {
  const node = makeNode(wallet3()), lines = [];
  const reg = createRegistry({ log: (l) => lines.push(l) });   // no setting given: the default
  assert.deepEqual(reg.mode(), { on: true, sends: "observe" });
  const as = (owner) => (cmd) => reg.guard(owner, cmd, node.run);
  hold(reg, coinId(1));
  // would be pinned
  const pin = "send amount:40 address:" + ADDR(7);
  assert.equal((await as("wallet")(pin)).status, true);
  assert.equal(node.saw(/^send /).pop(), pin, "the send went out byte for byte");
  assert.match(lines.pop(), new RegExp("^observe: `send` of wallet WOULD HAVE BEEN PINNED with fromaddress:" + ADDR(2) + " to keep it off coins held for a live Dexicon order \\(sent unchanged\\)$"));
  node.dropMempool();
  // would be refused
  const big = "send amount:60 address:" + ADDR(7);
  assert.equal((await as("wallet")(big)).status, true, "not refused");
  assert.equal(node.saw(/^send /).pop(), big);
  assert.match(lines.pop(), /^observe: `send` of wallet WOULD HAVE BEEN REFUSED: Not enough free funds: 100 MINIMA is held for a live Dexicon order .* \(sent unchanged: sends are observed, not enforced\)$/);
  node.dropMempool();
  // a caller's own fromaddress:
  const from = "send amount:5 address:" + ADDR(7) + " fromaddress:" + ADDR(1);
  await as("wallet")(from); assert.equal(node.saw(/^send /).pop(), from);
  assert.match(lines.pop(), /WOULD HAVE BEEN REFUSED: Not sent: the address this send takes its coins from holds coin/);
  node.dropMempool();
  // consolidate
  assert.equal((await as("wallet")("consolidate tokenid:0x00")).status, true);
  assert.match(lines.pop(), /^observe: `consolidate` of wallet WOULD HAVE BEEN REFUSED: Nothing consolidated: 1 coin is held for a live Dexicon order/);
  node.dropMempool();
  // a chain
  await as("wallet")("send amount:1 address:" + ADDR(7) + ";balance");
  assert.match(lines.pop(), /^observe: a chained command of wallet WOULD HAVE BEEN REFUSED/);
  assert.equal(node.seen[node.seen.length - 1], "send amount:1 address:" + ADDR(7) + ";balance");
  // still enforced
  await as("atomix")("txncreate id:a");
  assert.equal((await as("atomix")("txninput id:a coinid:" + coinId(1))).reserved, true, "txninput is refused as before");
  const mine = await as("atomix")("coins relevant:true sendable:true tokenid:0x00");
  assert.deepEqual(mine.response.map(x => x.coinid), [coinId(2), coinId(3)], "an engine's own coin read leaves the held coin out");
  // the callers' own pin (main/sendpin.js) avoids held coins only while sends are enforced
  assert.equal(reg.sendHeld("wallet", coinId(1)), null);
  reg.setMode({ on: true, sends: "enforce" }); assert.equal(reg.sendHeld("wallet", coinId(1)).owner, "dexicon");
  assert.match(lines.pop(), /^setting: the coin guard is ON; sends and consolidate: enforce$/);
  assert.equal((await as("wallet")(big)).reserved, true);
});

test("sends 'off': a send and a consolidate cost no read and say nothing; the master switch off: the whole guard is a passthrough", async () => {
  const off = rig(wallet3(), { sends: "off" }); hold(off.reg, coinId(1));
  off.node.seen.length = 0; off.lines.length = 0;
  for (const c of ["send amount:60 address:" + ADDR(9), "consolidate tokenid:0x00"]) { await off.as("wallet")(c); off.node.dropMempool(); }
  assert.deepEqual(off.node.seen, ["send amount:60 address:" + ADDR(9), "consolidate tokenid:0x00"]);
  assert.deepEqual(off.lines, []);
  await off.as("atomix")("txncreate id:a");
  assert.equal((await off.as("atomix")("txninput id:a coinid:" + coinId(1))).reserved, true, "txninput stays enforced with sends off");

  const node = makeNode(wallet3()), reg = createRegistry({ on: false, sends: "enforce" });
  reg.setHolds("dexicon", [{ coinid: coinId(1), why: ORDER }]);
  const as = (o) => (c) => reg.guard(o, c, node.run);
  assert.equal((await build(as("atomix"), "a", [coinId(1)], { noPost: true })).ok, true, "a held coin goes into a transaction");
  assert.equal(reg.list().filter(r => r.txn).length, 0, "and nothing was recorded");
  assert.equal((await as("atomix")("coins relevant:true sendable:true tokenid:0x00")).response.length, 3, "nothing is left out of a read");
  node.seen.length = 0; await as("wallet")("send amount:60 address:" + ADDR(9));
  assert.deepEqual(node.seen, ["send amount:60 address:" + ADDR(9)]);
  assert.equal(reg.sendHeld("wallet", coinId(1)), null);
  // wiring: config -> registry, at start and at every save; the Wallet's figures only while sends are enforced
  const main = SRC("main/main.js"), cfg = SRC("main/config.js");
  assert.match(main, /const reserveMode = \(c\) => reserve\.setMode\(\{ on: c\.coinGuard !== false, sends: c\.coinGuardSends \}\);\s+reserveMode\(config\.load\(\)\);/);
  assert.match(main, /const c = config\.save\(patch \|\| \{\}\);\s+reserveMode\(c\);/);
  assert.match(cfg, /coinGuard: true,/); assert.match(cfg, /coinGuardSends: "observe",/);
  assert.match(cfg, /if \(k === "coinGuardSends"\) \{ if \(v === "off" \|\| v === "observe" \|\| v === "enforce"\) out\[k\] = v; continue; \}/);
});

test("Release all holds: Settings asks plainly, the main process invalidates (file kept aside) and opens a new file", async () => {
  const main = SRC("main/main.js"), app = require("./i18n-plain.cjs").plain(SRC("renderer/app.js")), pre = SRC("main/preload.js");
  assert.match(main, /ipcMain\.handle\("mcd:reserveReleaseAll", async \(\) => \{\s+const n = reserve\.list\(\)\.length, kept = reserve\.invalidate\(\);/);
  assert.match(main, /if \(node\.state === "running"\) await reserve\.open\(app\.getPath\("userData"\), reserveRead\)/);
  assert.match(pre, /reserveReleaseAll: \(\) => ipcRenderer\.invoke\("mcd:reserveReleaseAll"\)/);
  assert.match(app, /if \(!await showConfirm\("Release all holds\?", [^\n]*the node itself refuses a second spend[^\n]*"Release all", true\)\) return;\s+try \{ const r = await api\.reserveReleaseAll\(\);/);
  const dir = tmp(), { node, as, reg } = rig(wallet3()); await reg.open(dir, node.run);
  hold(reg, coinId(1)); await build(as("atomix"), "a", [coinId(2)]);
  const kept = reg.invalidate(); await reg.open(dir, node.run);
  assert.equal(reg.list().length, 0); assert.ok(fs.existsSync(kept)); assert.ok(reg._file());
  assert.equal((await build(as("pandapools"), "p", [coinId(1)], { noPost: true })).ok, true, "free at once");
});

test("the wallet id is public: the first key (modifier 0x00); a locked node opens the same file; seedrandom is never asked; an old file is renamed once", async () => {
  const dir = tmp(), node = makeNode(wallet3()), a = rig(null, { node });
  await a.reg.open(dir, node.run); const f = a.reg._file(); a.reg.close();
  assert.deepEqual(node.saw(/^(keys|seedrandom)/), ["keys modifier:0x00"]);
  node.wallet.locked = true;
  const b = rig(null, { node }); await b.reg.open(dir, node.run);
  assert.equal(b.reg._file(), f, "locked: the same file"); b.reg.close();
  // a node line whose `keys` does not know modifier: (the whole list is read, and the 0x00 row found in any position)
  const old = async (c) => (c === "keys modifier:0x00" ? { status: false, error: "Invalid parameter : modifier" } : c === "keys" ? { status: true, response: { keys: [{ modifier: "0x05", publickey: "0x" + "11".repeat(32) }, { modifier: "0x00", publickey: node.wallet.pk }] } } : node.run(c));
  const c = rig(null, { node }); await c.reg.open(dir, old); assert.equal(c.reg._file(), f); c.reg.close();
  // a short list without the first key: nothing is guessed
  const d = rig(null, { node }); await d.reg.open(dir, async () => ({ status: true, response: { keys: [{ modifier: "0x07", publickey: "0x" + "22".repeat(32) }] } }));
  assert.equal(d.reg._file(), null);
  assert.ok(!/seedrandom/.test(SRC("main/reserve.js").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), "main/reserve.js sends no seedrandom");
  // the one-time rename
  const dir2 = tmp(), legacy = "coin-reservations-0x" + "ab".repeat(32) + ".json";
  fs.writeFileSync(path.join(dir2, legacy), JSON.stringify({ v: 1, txns: [{ coinid: coinId(1), owner: "atomix", txn: "old", state: "posted", at: 1, postedAt: 1 }], holds: [] }), { mode: 0o644 });
  const e = rig(null, { node }); await e.reg.open(dir2, node.run);
  assert.deepEqual(fs.readdirSync(dir2), [path.basename(f)]); assert.equal(e.reg.list()[0].txn, "old");
  assert.equal(fs.statSync(e.reg._file()).mode & 0o777, 0o600, "and it is the owner's alone now");
  assert.match(e.lines.join("\n"), /was renamed to coin-reservations-pk-0x/);
  // two old files: which is this wallet's cannot be known, so neither is touched
  const dir3 = tmp(); for (const x of ["ab", "cd"]) fs.writeFileSync(path.join(dir3, "coin-reservations-0x" + x.repeat(32) + ".json"), '{"v":1,"txns":[],"holds":[]}');
  const g = rig(null, { node }); await g.reg.open(dir3, node.run); await build(g.as("atomix"), "a", [coinId(1)], { noPost: true });
  assert.equal(fs.readdirSync(dir3).length, 3); assert.match(g.lines.join("\n"), /2 reservation files of the old name/);
});

test("M2: a watched command never waits on the store for more than the bound, and then goes on as if nothing were held on disk", async () => {
  assert.equal(OPEN_WAIT_MS, 3000);
  const dir = tmp(), { node, as, reg } = rig(wallet3(), { openWait: 30 });
  let answer; reg.open(dir, (c) => (/^keys/.test(c) ? new Promise(r => { answer = r; }) : node.run(c)));   // the node never answers the id read
  const t0 = Date.now();
  assert.equal((await build(as("atomix"), "a", [coinId(1)], { noPost: true })).ok, true);
  assert.ok(Date.now() - t0 < 1500, "four watched commands, each bounded");
  assert.equal((await as("pandapools")("txninput id:p coinid:" + coinId(1))).reserved, true, "memory still keeps the engines apart");
  await as("wallet")("balance");   // an unwatched command does not wait at all
  answer({ status: true, response: { keys: [{ modifier: "0x00", publickey: node.wallet.pk }] } });
  await reg.open(dir, node.run);
  assert.equal(reg.list().length, 1, "the late open keeps what memory holds");
});

test("M3: wherever a pin can still happen it is given minCoinage 3, so it never names a coin too young to spend", async () => {
  assert.equal(PIN_COINAGE, 3);
  const { node, as, reg } = rig(wallet3().concat([{ coinid: coinId(4), amount: "45", address: ADDR(4), created: "999" }]));   // coin 4 is one block old
  hold(reg, coinId(1));
  node.run = ((run) => async (c) => { if (/^coins /.test(c) && /\bcoinage:3\b/.test(c)) { const r = await run(c); r.response = r.response.filter(x => node.block() - Number(x.created) >= 3); return r; } return run(c); })(node.run);
  const r = await reg.guard("wallet", "send amount:40 address:" + ADDR(7), node.run);
  assert.equal(r.status, true);
  assert.match(node.seen[node.seen.length - 1], new RegExp(" fromaddress:" + ADDR(2) + "$"), "the 50 at address 2, not the younger 45 that is the smaller cover");
  assert.equal(node.saw(/^coins relevant:true sendable:true checkmempool:true tokenid:0x00 coinage:3$/).length, 1);
  for (const [f, n] of [["main/main.js", 1], ["main/webwallet.js", 1], ["main/vestr.js", 1], ["main/shop.js", 2], ["main/mail.js", 3], ["main/atomix.js", 1]]) {
    const calls = [...SRC(f).matchAll(/await pinMinimaSend\([^\n;]*?\)(?=[;)\s])/g)].map(m => m[0]);
    assert.equal(calls.length, n, f + ": " + calls.join(" | "));
    for (const c of calls) assert.match(c, /minCoinage: (3|MAIL_MIN_COINAGE|AX_PUBLISH_MIN_COINAGE)/, f + ": " + c);
  }
});

test("M4: a coin is gone only after two misses running with a tip; a coin seen again is not gone, and leaves `gone` when its source still lists it", async () => {
  const { node, reg, lines } = rig(wallet3());
  reg.setHoldSource("dexicon", () => [{ coinid: coinId(1), why: ORDER }]);
  await reg.sweep(node.run); assert.equal(reg.list().length, 1);
  const hide = { on: true }, flaky = async (c) => (hide.on && /^coins coinid:/.test(c) ? { status: true, response: [] } : node.run(c));
  assert.equal(await reg.sweep(flaky), 0, "one miss (a node mid-sync): still held");
  hide.on = false; await reg.sweep(flaky);
  hide.on = true; assert.equal(await reg.sweep(flaky), 0, "the misses did not run: the count started again");
  assert.equal(reg.list().length, 1);
  const noTip = async (c) => (/^block/.test(c) ? { status: true, response: { block: "0" } } : flaky(c));
  for (let i = 0; i < 3; i++) assert.equal(await reg.sweep(noTip), 0, "no tip: nothing is decided, however often");
  assert.equal(await reg.sweep(flaky), 1, "the second miss running");
  assert.equal(reg.list().length, 0);
  await reg.sweep(flaky); assert.equal(reg.list().length, 0, "listed by its source, not shown by the node: stays gone");
  hide.on = false;
  await reg.sweep(flaky);   // the source lists it, the sweep asks the node again, the node shows it
  assert.equal(reg.list().length, 1, "seen again: held again");
  assert.match(lines.join("\n"), /is shown by the node again: it can be held again/);
});

test("M5: a hold's token is looked up when it is set, and consolidate is refused only for that token", async () => {
  const dir = tmp(), { node, as, reg } = rig(wallet3().concat([{ coinid: coinId(11), amount: "30", address: ADDR(5), tokenid: MXUSD }]));
  await reg.open(dir, node.run);
  hold(reg, coinId(11));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(reg.list()[0].tokenid, MXUSD, "known without a sweep");
  node.seen.length = 0;
  assert.equal((await as("wallet")("consolidate tokenid:0x00")).status, true, "MINIMA is not held up by an MxUSD hold");
  assert.deepEqual(node.seen, ["consolidate tokenid:0x00"], "and no look-up was needed");
  assert.equal((await as("wallet")("consolidate tokenid:" + MXUSD)).reserved, true);
  reg.setHolds("dexicon", [{ coinid: coinId(2), why: ORDER, tokenid: "0x00" }]);
  assert.equal(reg.list()[0].tokenid, "0x00", "a source that names the token is believed at once");
});

test("L1: the verb in any case, a repeated parameter and a quoted value are all read as the node reads them", async () => {
  assert.deepEqual([...parse('send amount:1 address:0xAA state:{"0":"x amount:9 coinid:0x01","1":"[a b]"} TokenID:"0x00"').first], [["amount", "1"], ["address", "0xAA"], ["state", '{"0":"x amount:9 coinid:0x01","1":"[a b]"}'], ["tokenid", "0x00"]]);
  assert.equal(parse("txninput id:a coinid:0x01 coinid:0x02").dup, "coinid");
  assert.equal(parse('send amount:1 state:{"0":"amount:2"}').dup, "", "a name inside a JSON value is not a parameter");
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));
  await as("atomix")("txncreate id:a");
  for (const c of ["TXNINPUT id:a coinid:" + coinId(1), "TxnInput ID:a CoinID:" + coinId(1), 'txninput id:a coinid:"' + coinId(1) + '"', "txninput id:a coinid:" + coinId(2) + " coinid:" + coinId(1), "txninput id:a id:b coinid:" + coinId(2)])
    assert.equal((await as("atomix")(c)).reserved, true, c);
  assert.equal(node.saw(/^txninput/i).length, 0);
  const up = await as("wallet")("SEND amount:40 address:" + ADDR(7));
  assert.equal(up.status, true); assert.match(node.seen[node.seen.length - 1], new RegExp("^SEND amount:40 address:" + ADDR(7) + " fromaddress:" + ADDR(2) + "$"), "SEND is pinned as send is");
  node.dropMempool();
  assert.match((await as("wallet")("send amount:1 address:" + ADDR(7) + " amount:60")).error, /the parameter amount: is given twice/);
  assert.match((await as("wallet")("Consolidate tokenid:" + MXUSD + " tokenid:0x00")).error, /the parameter tokenid: is given twice/);
  assert.equal((await as("wallet")("CONSOLIDATE tokenid:0x00")).reserved, true);
  assert.equal((await as("atomix")("COINS relevant:true sendable:true tokenid:0x00")).response.length, 2, "an engine's read in capitals is filtered too");
  assert.equal((await pinSend(node.run, "Send amount:40 address:" + ADDR(7), { held: (id) => reg.foreign("wallet", id) })).pinned, true);
  // CHANGED on purpose (0.19.190): the verb is read by main/cmdverb.js (any case, quoted, control characters), not /^send\s/i
  for (const f of ["main/sendpin.js"]) assert.ok(SRC(f).includes('V.is(c, "send")'), f + " reads the verb as the node does");
  assert.ok(!/\/\^send\\s\/\.test\(/.test(SRC("main/sendpin.js") + SRC("main/main.js") + SRC("main/reserve.js")));
  // a repeated id: on txnpost is refused (the node would post the LAST one named)
  await as("atomix")("txninput id:a coinid:" + coinId(3));
  assert.equal((await as("atomix")("txnpost id:a id:b")).reserved, true);
});

// 0.19.192: the coin guard reads a command as the node does (main/cmdverb.js): each of these is run by the node as the
// command named, and slipped past /^\s*(\w+)/ or a parameter read that kept quotes and " : ".
test("the coin guard reads txninput, send and consolidate the way the node does: quoted, control-character and ':'-spaced forms are guarded", async () => {
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));
  await as("atomix")("txncreate id:a");
  for (const c of ['"txninput" id:a coinid:' + coinId(1), "\u0001txninput id:a coinid:" + coinId(1), 'tx"ninp"ut id:a coinid:' + coinId(1), '"txninput"id:a coinid:' + coinId(1),
    "txninput id:a coinid : " + coinId(1), "txninput id : a coinid:" + coinId(1), 'txninput id:a "coinid":' + coinId(1), 'txninput "id":"a" "coinid":"' + coinId(1) + '"',
    "status;\u0002txninput id:a coinid:" + coinId(1), 'status; "txninput" id:a coinid : ' + coinId(1)])
    assert.equal((await as("atomix")(c)).reserved, true, JSON.stringify(c));
  assert.equal(node.seen.filter(c => /txninput/i.test(c)).length, 0, "none reached the node");
  assert.equal((await as("atomix")('"txninput" id:a coinid:' + coinId(1) + " coinid : " + coinId(2))).reserved, true, "a repeated coinid, however spaced, is refused");
  for (const c of ['"consolidate" tokenid:0x00', "\u0001consolidate tokenid:0x00", "consolidate tokenid : 0x00", 'con"solid"ate tokenid:0x00'])
    assert.equal((await as("wallet")(c)).reserved, true, JSON.stringify(c));
  assert.equal((await as("wallet")('"consolidate" tokenid:0x00 dryrun : true')).reserved, undefined, "a dry run is still let through");
  for (const c of ['"send" amount:40 address:' + ADDR(7), "\u0001send amount:40 address:" + ADDR(7), "send amount : 40 address:" + ADDR(7)]) {
    node.dropMempool();
    const before = node.seen.length, r = await as("wallet")(c);
    const sent = node.seen.slice(before).filter(x => !/^(coins|checkaddress)/.test(x));
    assert.ok(r.reserved === true || (sent.length === 1 && sent[0].endsWith(" fromaddress:" + ADDR(2))), JSON.stringify(c) + " is pinned away from the held coin or refused: " + JSON.stringify(sent));
  }
  assert.equal((await as("wallet")('send amount:1 address:' + ADDR(7) + ' "amount":60')).reserved, true, "a repeated amount, one of them quoted, is refused");
});

test("L2: a retried txnpost the node rejects does not release the coins the first post put in the mempool", async () => {
  const { node, as, reg } = rig(wallet3());
  await build(as("atomix"), "a", [coinId(1)], { noPost: true });
  assert.equal((await as("atomix")("txnpost id:a")).status, true);
  const again = await as("atomix")("txnpost id:a");
  assert.equal(again.status, false, "the model node: input already in the mempool");
  assert.deepEqual(reg.list().map(r => r.state), ["posted"], "still held");
  assert.equal((await build(as("pandapools"), "p", [coinId(1)])).ok, false);
  // and with no answer to the first post
  const b = rig(wallet3()); await build(b.as("atomix"), "a", [coinId(1)], { noPost: true });
  await assert.rejects(b.reg.guard("atomix", "txnpost id:a", async (c) => { await b.node.run(c); throw new Error("RPC timeout"); }));
  assert.equal((await b.as("atomix")("txnpost id:a")).status, false);
  assert.deepEqual(b.reg.list().map(r => r.state), ["posted"]);
  // a FIRST post that is rejected still releases
  const c = rig(wallet3()); await build(c.as("atomix"), "a", [coinId(1)], { noPost: true });
  c.node.mempool.set(coinId(1).toLowerCase(), "x"); await c.as("atomix")("txnpost id:a");
  assert.equal(c.reg.list().length, 0);
});

test("L3: AtomiX and PandaPools release their unfinished builds when they are stopped (held, or the wallet replaced)", () => {
  const ax = SRC("main/atomix.js"), pp = SRC("main/pandapools.js");
  // CHANGED on purpose (0.19.243): released only once the engine went quiet (scripts/engine-abort.test.cjs drives it)
  assert.match(ax, /async function hold\(maxMs = 15000\) \{[\s\S]{0,400}if \(await quiet\(maxMs\)\) require\("\.\/reserve"\)\.releaseOwner\("atomix"\);/);
  assert.match(ax, /function invalidate\(\) \{[\s\S]{0,400}stopLoop\(\);\s+require\("\.\/reserve"\)\.releaseOwner\("atomix"\);/);
  assert.match(pp, /function releaseBuilds\(\) \{ try \{ require\("\.\/reserve"\)\.releaseOwner\("pandapools"\); \} catch \(e\) \{\} \}/);
  assert.match(pp, /if \(await quiet\(maxMs \|\| 15000\)\) releaseBuilds\(\);/);
  assert.match(pp, /async function invalidate\(\) \{\s+quarantineRequired=true;stopLoop\(\);[^\n]*\n\s+releaseBuilds\(\);/);
});

test("L4: a record with no postedAt, or with a time in the future, still lapses", async () => {
  const dir = tmp(), node = makeNode(wallet3()), clock = { t: 1e12 };
  const a = rig(null, { node, clock }); await a.reg.open(dir, node.run); const f = a.reg._file(); a.reg.close();
  fs.writeFileSync(f, JSON.stringify({ v: 1,
    txns: [{ coinid: coinId(1), owner: "atomix", txn: "old", state: "posted", at: clock.t + 9e9 }, { coinid: coinId(2), owner: "atomix", txn: "b", state: "building", at: clock.t + 9e9 }],
    holds: [{ coinid: coinId(3), owner: "dexicon", why: ORDER, at: clock.t + 9e9, seen: clock.t + 9e9 }] }));
  const b = rig(null, { node, clock }); await b.reg.open(dir, node.run);
  b.reg.setHoldSource("dexicon", () => null);
  await b.reg.sweep(node.run);                         // every clock starts now; the post's block is noted
  assert.equal(b.reg.list().length, 3);
  clock.t += BUILD_MS + 1; await b.reg.sweep(node.run);
  assert.deepEqual(b.reg.list().map(r => r.txn || "hold").sort(), ["hold", "old"], "the build is aged out");
  node.tick(DEAD_BLOCKS); clock.t += DEAD_MS; await b.reg.sweep(node.run);
  assert.deepEqual(b.reg.list().map(r => r.txn || "hold"), ["hold"], "the post with no time is known dead like any other");
  clock.t += HOLD_STALE_MS + 1; await b.reg.sweep(node.run);
  assert.equal(b.reg.list().length, 0, "and the hold lapses a day after");
});

test("L5: a `;` ends a command for the node wherever it stands, so the guard splits exactly there: an input after a `;` inside a JSON value is still checked", async () => {
  const { node, as, reg } = rig(wallet3());
  hold(reg, coinId(1));
  const c = "send amount:1 address:" + ADDR(7) + ' state:{"0":"a;txninput id:t coinid:' + coinId(1) + ' ;b"}';
  const r = await as("wallet")(c);
  assert.equal(r.reserved, true); assert.match(r.error, /is held for a live Dexicon order/);
  assert.equal(node.seen.length, 1, "only the look at the coin (is it a plain coin?) reached the node");
  assert.match(node.seen[0], /^coins coinid:/);
});

// 0.19.192: a "quoted" first word ends at its closing quote for the parameter readers too (main/cmdverb.js paramsText; the
// released file read `"vault"action:seed` as one word, so its action: was not seen)
test("cmdverb: the parameters after a quoted verb with no space are read, as the node's fast path reads them", async () => {
  const V = require("../main/cmdverb");
  assert.deepEqual(V.read('"txninput"id:a coinid : 0x01').params, [["id", "a"], ["coinid", "0x01"]]);
  assert.deepEqual(V.paramNames('"vault"action:seed action:wipekeys'), ["action", "action"]);
  assert.deepEqual(V.repeated('"send"amount:1 amount:9 address:0xA', ["amount", "tokenid", "address", "fromaddress"]), ["amount"]);
  const G = require("../main/seedgate.js"), g = G.create({ check: async () => ({ biometric: false }) });
  await assert.rejects(g.open('"keys" action:list action:genkey', "SHOW KEY"), /names action more than once/);
  // glued to its quoted verb, the slow path (any { or [ in the text) reads `keysaction:list`: refused as unclear (0.19.266)
  await assert.rejects(g.open('"keys"action:list action:genkey', "SHOW KEY"), /differently from how it is written/);
});

// 0.19.226: one command is forwarded exactly as written, not JS-trimmed
test("the guard forwards a single command as written (no trim of its own)", async () => {
  const { node, as } = rig(wallet3());
  await as("wallet")("  txncreate id:fw  ");
  assert.equal(node.seen[node.seen.length - 1], "  txncreate id:fw  ");
  const main = SRC("main/main.js");
  assert.ok(main.includes("P2P Chance, Future Cash Next and the coin reservations were reset in the main process"), "the log line names all seven");
});
