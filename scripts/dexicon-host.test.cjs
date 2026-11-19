/*
 * dexicon-host.test.cjs — the Dexicon engine host (main/dexicon.js + main/dexicon/). Mock node, mock network:
 * scripts/dexicon-mock.cjs poisons main/rpc.js and main/netfetch.js, so reaching a real node or the real network
 * throws and is counted (the last test asserts the count is zero).
 *   node --test scripts/dexicon-host.test.cjs
 */
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const M = require("./dexicon-mock.cjs");                       // FIRST: before anything can load the real rpc / netfetch
const { makeHost, dexCommand, DEX_VERBS } = require("../main/dexicon.js");
const { createNodeRunner, SIGNING } = require("../main/noderun.js");
const restore = require("../main/restore.js");

const dirs = [], hosts = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dexicon-test-")); dirs.push(d); return d; };
/** A booted host on a mock node. o: { dir, node options, wrap(run) → runner } */
async function boot(o = {}) {
  const node = M.mockNode(o.node), net = M.mockNet(), dir = o.dir || tmp();
  const host = makeHost({ runner: o.wrap ? o.wrap(node.run) : node.run, dataDir: dir, net, tickMs: o.tickMs || 40, quiet: true });
  node.attach(host); hosts.push(host);
  await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  return { host, node, net, dir, ctx: host._ctx() };
}
const sql = async (host, query) => { const r = await host.command({ op: "sql", query }); assert.equal(r.status, true, query + " → " + r.error); return r.rows || []; };
const dump = async (host, skip) => {
  const out = {};
  for (const t of (await sql(host, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.NAME))
    out[t] = (await sql(host, "SELECT * FROM `" + t + "`")).filter(r => !(t === "ax_kv" && skip.includes(r.K))).map(r => JSON.stringify(r)).sort();
  return out;
};
test.after(() => { for (const h of hosts) h.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("the parity manifest verifies, and the host loads only manifest files", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "dexicon-parity-manifest.cjs"), "--verify"], { encoding: "utf8" });
  assert.match(out, /^PASS 37 Dexicon engine files match the committed manifest/);
  const { FILES } = require("./dexicon-parity-manifest.cjs");
  const loaded = [...fs.readFileSync(path.join(M.root, "main/dexicon/service.desktop.js"), "utf8").matchAll(/^MDS\.load\('([^']+)'\)|; MDS\.load\('([^']+)'\)/gm)].map(m => m[1] || m[2]);
  assert.deepEqual(loaded, FILES, "service.desktop.js loads exactly the manifest's files, in its order");
  assert.ok(!loaded.some(f => /^doors\/|lib\/door\.js$/.test(f)), "the AtomiX doors are never loaded");
  assert.ok(!fs.existsSync(path.join(M.root, "main/dexicon/doors")), "and are not in the app at all");
});

test("the engine boots in the vm and reaches its ready state, on the mock node only", async () => {
  const { host, node, net, dir, ctx } = await boot();
  const s = host.status();
  assert.equal(s.ready, true); assert.equal(s.restingReady, true); assert.equal(s.started, true);
  assert.match(s.publicId, /^0x[0-9a-f]{128}$/, "the trading identity, in full");
  assert.equal(s.block, 1000);
  assert.ok(node.seen.includes("seedrandom modifier:dexicon-identity-v1"), "the identity is the node's one-way derivation");
  assert.ok(!node.seen.some(c => /^vault\b/.test(c)), "the seed phrase is never read");
  assert.ok(!node.seen.some(c => /^checkmode\b/.test(c)), "checkmode is answered by the host");
  assert.deepEqual(s.relays, ["https://eurobuddha.com/dex-relay", "https://store.eurobuddha.com/dex-relay", "https://minimammr.com/dex-relay"], "a fresh install: the MiniDapp's own bootstrap list");
  assert.equal(typeof ctx.AX.autocross.run, "function", "lib/autocross.js is loaded, as in the MiniDapp");
  assert.equal(ctx.AXService, undefined, "no doors engine");
  assert.equal(ctx.require, undefined); assert.equal(ctx.process, undefined);
  await M.until(() => host.status().price.mid > 0);
  assert.equal(host.status().price.mid, (0.01 + 0.0102) / 2, "the price is resting/price.js over MEXC depth, as in the MiniDapp");
  assert.ok(net.calls.every(c => /^(GET|POST) https:\/\/(api\.mexc\.com|eurobuddha\.com|store\.eurobuddha\.com|minimammr\.com)\//.test(c)), net.calls.join("\n"));
  assert.deepEqual(host.book(), { fast: [], book: [], poolAsks: [], poolBids: [], pools: [] });
  assert.deepEqual(host.mine(), { orders: [], pending: [] });
  host.flush();
  assert.ok(fs.existsSync(path.join(dir, "dexicon.sqlite")), "the store is dexicon.sqlite in the host's own folder");
  assert.equal(host.storePath(), path.join(dir, "dexicon.sqlite"));
});

test("nothing is sent before start, and stop ends the timer and the block watch", async () => {
  const node = M.mockNode(), host = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), tickMs: 30, quiet: true });
  node.attach(host); hosts.push(host);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(node.seen.length, 0, "built, not started: no command");
  assert.equal(host.status().started, false);
  await host.start(); await M.until(() => host.status().ready && host.status().restingReady);
  host.stop();
  await new Promise(r => setTimeout(r, 150));   // let what was in flight end
  const n = node.seen.length;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(node.seen.length, n, "stopped: the timer sends nothing more");
  assert.equal(host.status().started, false);
  await host.start(); await M.until(() => node.seen.length > n);
  assert.equal(node.seen.filter(c => c.startsWith("seedrandom")).length, 1, "started again on the same engine: the identity is not derived twice");
});

test("the net allow-list: https, the engine's own relay list and the MiniDapp's price source, nothing else", async () => {
  const { host } = await boot();
  const ok = (u, m) => host._netAllowed(u, m || "GET");
  assert.ok(ok("https://eurobuddha.com/dex-relay/dex/book?market=MINIMA%2FMxUSD&since=0&hold=0"));
  assert.ok(ok("https://minimammr.com/dex-relay/dex/publish", "POST"));
  assert.ok(ok("https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20"));
  assert.ok(!ok("https://api.mexc.com/api/v3/order", "POST"), "the price source is read, never written");
  for (const u of ["http://eurobuddha.com/dex-relay/dex/book", "https://eurobuddha.com/other", "https://eurobuddha.com/dex-relay/dex/../../other",
    "https://eurobuddha.com.evil.example/dex-relay/dex/book", "https://evil.example/dex/book", "https://user:pw@eurobuddha.com/dex-relay/dex/book",
    "http://localhost:9602/dex/book", "http://127.0.0.1:12005/dex/book", "https://api.coingecko.com/api/v3/simple/price", "file:///etc/passwd", "nonsense"])
    assert.ok(!ok(u) && !ok(u, "POST"), "refused: " + u);
  // the user's list is the allow-list: a relay the user adds is allowed, one removed is refused; http is never kept
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('relays', '[\"https://relay.example/dex-relay\",\"http://localhost:9602\",\"http://plain.example\"]')");
  await M.until(() => host.status().relays.length === 2);   // the engine's own okUrl keeps a local dev relay in ITS list…
  assert.ok(ok("https://relay.example/dex-relay/dex/inbox?pk=0x00"));
  assert.ok(!ok("http://localhost:9602/dex/book"), "…but this host sends nothing over http");
  assert.ok(!ok("https://eurobuddha.com/dex-relay/dex/book"), "a relay the user removed");
});

test("the command bridge: only the verbs the MiniDapp page issues, one command at a time", async () => {
  const { host, node } = await boot();
  const refused = async (command, why) => { const n = node.seen.length; await assert.rejects(host.command({ op: "cmd", command }), why, command); assert.equal(node.seen.length <= n + 40 && !node.seen.slice(n).includes(command), true, "never sent: " + command); };
  for (const c of ["send amount:1 address:0x00", "vault action:seed", "backup file:x.bak", "restore file:x.bak", "megammrsync action:resync", "keys action:list", "mds action:list",
    "tokencreate name:x amount:1", "consolidate tokenid:0x00", "sendpoll action:list", "quit", "sign data:0x01 publickey:0x02", "coinexport coinid:0x01", "txnstate id:a port:1 value:2", "runscript script:\"RETURN TRUE\""])
    await refused(c, /not available to Dexicon/);
  await refused("balance;send amount:1 address:0x00", /bad command/);
  await refused("balance\nsend amount:1 address:0x00", /bad command/);
  await refused("", /bad command/);
  await refused("txnpost id:a auto:true", /that parameter/);
  await refused("txnpost id:a burn:1", /that parameter/);
  await refused("txnsign id:a publickey:auto txnpostauto:true", /that parameter/);
  await refused("txnexport id:a file:/tmp/x", /that parameter/);
  await refused("seedrandom modifier:other", /only the Dexicon identity derivation/);
  await assert.rejects(host.command({ op: "cmd", command: 7 }), /bad command/);
  await assert.rejects(host.command({ op: "run" }), /unknown Dexicon op/);
  await assert.rejects(host.command(null), /unknown Dexicon op/);
  assert.equal((await host.command({ op: "cmd", command: "balance" })).status, true);
  assert.equal(node.seen[node.seen.length - 1], "balance", "an allowed verb reaches the node unchanged");
  assert.deepEqual(await host.command({ op: "cmd", command: "checkmode" }), { status: true, response: { writemode: true, dblocked: false } });
  assert.equal(dexCommand("txnsign id:a publickey:auto"), "txnsign id:a publickey:auto");
  assert.equal(dexCommand("txnpost id:a"), "txnpost id:a");
  assert.deepEqual([...DEX_VERBS].sort(), ["balance", "block", "checkmode", "coins", "getaddress", "history", "newscript", "random", "scripts", "status",
    "txncheck", "txncreate", "txndelete", "txnexport", "txnimport", "txninput", "txnoutput", "txnpost", "txnsign", "txnview", "txpow"], "the allow-list, pinned");
  // packets: only the page's two origins
  for (const m of [JSON.stringify({ origin: "service", type: "STATE", data: {} }), JSON.stringify({ type: "LIMIT" }), "not json", JSON.stringify({ origin: "ui" })])
    await assert.rejects(host.command({ op: "comms", message: m }), /bad message/);
  await assert.rejects(host.command({ op: "comms", message: 5 }), /bad message/);
  const got = []; host.emitter.on("comms", m => got.push(JSON.parse(m)));
  assert.deepEqual(await host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "REFRESH", data: {} }) }), { status: true });
  await M.until(() => got.some(p => p.origin === "service" && p.type === "STATE"));
  await assert.rejects(host.command({ op: "sql", query: "" }), /bad query/);
});

test("signing commands from the engine pass the one queue: never two at the node at once, in the order asked", async () => {
  // the raw node: a signing command takes 40 ms, and counts how many are inside it at once
  let inside = 0, most = 0; const signed = [];
  const slow = (run) => async (c) => { if (!SIGNING.test(c)) return run(c); inside++; most = Math.max(most, inside); signed.push(c); await new Promise(r => setTimeout(r, 40)); inside--; return run(c); };
  const three = async (ctx, host) => {
    const coin = (n) => ({ coinid: M.hex("coin" + n, 64), tokenid: "0x00", amount: "5", address: M.hex("mock address", 64) });
    const relock = (n) => new Promise(res => ctx.AX.maker.relock(ctx.AX.mds, [coin(n)], M.hex("mock address", 64), (e) => res(e ? e.message : null)));
    const posted = new Promise(res => host.emitter.on("comms", m => { const p = JSON.parse(m); if (p.type === "POSTED" || p.type === "ERROR") res(p.type); }));
    const a = relock(1), b = relock(2);   // FAST layer: txnsign publickey:auto (nothing in the engine gates these two against each other here)
    await host.command({ op: "comms", message: JSON.stringify({ origin: "dexicon", type: "CONSOLIDATE", data: { tokenid: "0x00" } }) });   // RESTING layer: consolidate
    assert.deepEqual([await a, await b, await posted], [null, null, "POSTED"]);
  };
  // control: with no queue under the engine, the same three overlap (so the test below can fail)
  const c0 = await boot({ wrap: (run) => slow(run) });
  await three(c0.ctx, c0.host);
  assert.ok(most >= 2, "control: without the queue the engine's signers overlap (" + most + ")");
  // the app's arrangement: main/noderun.js under the runner, as main/rpc.js puts it under rpcCall
  inside = 0; most = 0; signed.length = 0;
  const asked = [];
  const queued = (run) => { const raw = slow(run), q = createNodeRunner(raw); return (c) => { if (SIGNING.test(c)) asked.push(c); return q.run(c); }; };
  const c1 = await boot({ wrap: queued });
  await three(c1.ctx, c1.host);
  assert.equal(most, 1, "never two signing commands at the node at once");
  assert.deepEqual(signed, asked, "and they reach the node in the order the engine asked");
  assert.equal(signed.length, 3);
  assert.equal(signed.filter(c => /^txnsign id:\S+ publickey:auto$/.test(c)).length, 2);
  assert.equal(signed.filter(c => c === "consolidate tokenid:0x00").length, 1);
  // every error-free chain still ended in txndelete
  const made = c1.node.seen.filter(c => c.startsWith("txncreate id:")).map(c => c.split("id:")[1]);
  assert.equal(made.length, 2);
  for (const id of made) assert.ok(c1.node.seen.includes("txndelete id:" + id), "txndelete for " + id);
});

test("every form of command the engine signs with is in the signing pattern; its other commands are not", () => {
  const src = (f) => fs.readFileSync(path.join(M.root, "main/dexicon", f), "utf8");
  // the engine's signing verbs, found in its source rather than assumed
  const all = ["lib/maker.js", "lib/ladder.js", "lib/fill.js", "lib/autocross.js", "resting/txn.js", "resting/split.js", "resting/pd_service.js", "service.desktop.js"].map(src).join("\n");
  for (const lit of ["'txnsign id:' + id + ' publickey:auto'", "'txnsign id:' + id + ' publickey:' + k", "\"txnsign id:\"+id+\" publickey:\"+keys[k]", "\"send address:\" + address + \" amount:\"", "\"send amount:\"+P.plain(lock)+\" address:\"", "'consolidate tokenid:' + tok"])
    assert.ok(all.includes(lit), "the engine still builds: " + lit);
  for (const c of ["txnsign id:rl1 publickey:auto", "txnsign id:dm1 publickey:0xAB", "send address:0xAB amount:10 split:10", "send amount:5 address:0xAB tokenid:0x7D state:{\"0\":\"0x01\"}", "consolidate tokenid:0x00"])
    assert.ok(SIGNING.test(c), "queued: " + c);
  for (const c of ["txnpost id:dm1", "txncheck id:dm1", "txnimport id:dm1 data:0x00", "txnexport id:dx1", "txnview data:0x00", "txncreate id:a", "txninput id:a coinid:0x01 scriptmmr:true", "txnoutput id:a amount:1 address:0x02",
    "txnstate id:a port:0 value:0x01", "txnbasics id:a", "txndelete id:a", "newscript trackall:false script:\"RETURN SIGNEDBY(0x01)\"", "seedrandom modifier:dexicon-identity-v1", "coins relevant:true", "keys action:list"])
    assert.ok(!SIGNING.test(c), "not queued (it signs nothing): " + c);
  // no other signing verb anywhere in the engine: a new one must be added to main/noderun.js and to this table
  for (const v of ["sendpoll", "sendsign", "txnauto", "tokencreate", "multisig", "signfrom", "txnpostauto", "auto:true", "burn:"])
    assert.ok(!new RegExp("['\"]" + v.replace(":", "\\:") + "\\b").test(all) && !all.includes(" " + v), "the engine does not use " + v);
});

test("auto-cross runs as in the MiniDapp, and plans over pools only: it can never fill an order, the user's own included", async () => {
  const { host, ctx, net } = await boot();
  let runs = 0; const real = ctx.AX.autocross.run; ctx.AX.autocross.run = function (c, cb) { runs++; return real(c, cb); };
  const polls = () => net.calls.filter(c => /\/dex\/inbox\?/.test(c)).length, before = polls();
  await M.until(() => polls() >= before + 3);
  assert.ok(runs >= 2, "the service asks it after each ladder pass");
  assert.deepEqual(await sql(host, "SELECT v FROM ax_kv WHERE k='mm_cross_pending'"), [], "not switched on by the user: nothing crossed");
  // decide(): what it hands the router as the order book
  const books = vm.runInContext(`(function () {
    var seen = [], plan = PandaComposite.plan;
    PandaComposite.plan = function (book) { seen.push(book.length); return plan.apply(PandaComposite, arguments); };
    var pool = PandaPool.clean({ opk: PDService.identity.publickey, oadr: "0x01", tok: PandaDEX.USDT, kmin: "0", address: "0xC1", reserveM: "100000", reserveT: "2000", coinidM: "0xC101", coinidT: "0xC102" });
    var d = AX.autocross.decide([pool], [{ status: "live", side: "sell", price: "0.012", remaining: "500", coins: ["0x01"] }], 0.011);
    PandaComposite.plan = plan;
    return JSON.stringify({ seen: seen, crossed: !!d, orderTakes: d ? d.plan.orderTakes.length : -1 });
  })()`, ctx);
  assert.deepEqual(JSON.parse(books), { seen: [0], crossed: true, orderTakes: 0 }, "an empty book goes to the router: a cross takes from pools (the user's own included, by the owner's decision) and from no order");
  assert.ok(fs.readFileSync(path.join(M.root, "main/dexicon/lib/autocross.js"), "utf8").includes("g.PandaComposite.plan([], pools, !sell, want, limit, 0)"));
});

test("a LIMIT that would fill one of this node's own orders is refused before the engine sees it", async () => {
  const { host, ctx, node } = await boot();
  const limit = (data) => host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "LIMIT", data }) });
  const self = (data) => String(ctx.DX.selfTrade(vm.runInContext("(" + JSON.stringify(data) + ")", ctx)));
  // an own offer at 0.0100 and someone else's at 0.0090, a bid of ours at 0.0080
  vm.runInContext(`(function () {
    var mk = function (id, pk, sell, price) { return { coinid: id, orderId: id, ownerPk: pk, wantAddr: PDService.identity.address, sell: sell, price: PandaDEX.d(price), minima: PandaDEX.d("100"), locked: sell ? PandaDEX.d("100") : PandaDEX.d(price).mul(100), wantAmt: sell ? PandaDEX.d(price).mul(100) : PandaDEX.d("100"), minRem: PandaDEX.d("0"), created: PDService.block, fillable: true }; };
    PDService.book = [mk("0xAA01", PDService.identity.publickey, true, "0.0100"), mk("0xBB02", "0x" + new Array(65).join("9"), true, "0.0090"), mk("0xAA03", PDService.identity.publickey, false, "0.0080")];
  })()`, ctx);
  assert.equal(self({ buy: true, minima: "10", price: "0.0095" }), "", "a buy that stops below our own offer may go");
  assert.match(self({ buy: true, minima: "10", price: "0.0100" }), /^This would trade with your own order at 0\.01 \(coin 0xAA01\)/);
  assert.match(self({ buy: true, minima: "10", price: "" }), /your own order/, "no limit price: any own offer could be reached");
  assert.match(self({ buy: false, minima: "10", price: "0.0080" }), /your own order at 0\.008 \(coin 0xAA03\)/);
  assert.equal(self({ buy: false, minima: "10", price: "0.0085" }), "");
  const n = node.seen.length;
  await assert.rejects(limit({ buy: true, minima: "10", price: "0.0100" }), /your own order/);
  assert.ok(!node.seen.slice(n).some(c => /^(txn|send)/.test(c)), "nothing was built or signed");
  // pools are not part of this rule (owner, 19 Nov 2026): an own pool refuses nothing, and the read model marks it
  vm.runInContext(`(function () {
    PDService.book = [];
    PDService.pools = [PandaPool.clean({ opk: PDService.identity.publickey.toLowerCase(), oadr: "0x01", tok: PandaDEX.USDT, kmin: "0", address: "0xC1", reserveM: "100000", reserveT: "1000", coinidM: "0xC101", coinidT: "0xC102" })];
    PDService.poolHaveLive = true;
  })()`, ctx);
  assert.equal(self({ buy: true, minima: "10", price: "0.02" }), "");
  assert.equal(host.book().pools.find(p => p.address === "0xC1").mine, true, "own pool, key matched whatever its letter case");
  // keys not read yet: nothing can be told apart, so nothing is sent
  vm.runInContext("PDService.keysReady = false", ctx);
  assert.match(self({ buy: true, minima: "10", price: "0.02" }), /Still reading this wallet's keys/);
});

test("a wallet reset moves the store aside (never deleted) and starts empty; the old engine can no longer reach the node or the store", async () => {
  const { host, node, dir, ctx } = await boot();
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('fill_0xF1', '{\"status\":\"done\",\"txpowid\":\"0xF1\"}')");
  const old = host.status().publicId, oldMds = ctx.AX.mds, file = path.join(dir, "dexicon.sqlite");
  host.flush();
  const before = fs.readFileSync(file);
  node.seen.length = 0;
  const kept = host.invalidate();
  const d = new Date(), ymd = "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  assert.equal(kept, file + "-legacy-keys-" + ymd);
  assert.ok(fs.readFileSync(kept).equals(before), "the old store, byte for byte, under its dated name");
  assert.equal(host.status().ready, false);
  // a late callback of the old engine: refused, nothing sent, nothing written
  const late = await new Promise(res => oldMds.cmd("txnsign id:late publickey:auto", res));
  assert.equal(late.status, false); assert.match(late.error, /wallet was replaced/);
  assert.equal((await new Promise(res => oldMds.sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('late', '1')", res))).status, false);
  assert.ok(!node.seen.includes("txnsign id:late publickey:auto"));
  // the engine comes back by itself (the node is still running), empty, on the node's identity
  await M.until(() => host.status().ready && host.status().restingReady);
  assert.equal(host.status().publicId, old, "same mock seed, same identity: derived again, not read from the old store");
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k LIKE 'fill_%' OR k='late'"), [], "the new store holds none of the old wallet's records");
  assert.ok(fs.readFileSync(kept).equals(before), "and the old one is still untouched");
  // a second reset on the same day gets -2; a reset with no store returns ""
  host.flush();
  assert.equal(host.invalidate(), file + "-legacy-keys-" + ymd + "-2");
  const cold = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), quiet: true }); hosts.push(cold);
  assert.equal(cold.invalidate(), "");
  assert.equal(cold.status().started, false, "a reset does not start an engine the node has not started");
});

test("a different seed gives a different identity; the old store's orders are not carried over", async () => {
  const dir = tmp();
  const a = await boot({ dir, node: { seed: "one" } }); const idA = a.host.status().publicId; a.host.stop();
  const b = await boot({ dir: tmp(), node: { seed: "two" } });
  assert.notEqual(b.host.status().publicId, idA);
});

test("a populated copy of the store survives a restart unchanged", async () => {
  const first = await boot();
  const order = { orderId: "0x" + "1".repeat(32), side: "sell", price: "0.0123", amount: "100", remaining: "40", coins: [], address: first.node.ADDRESS, seq: 1, expiry: 1, status: "cancelled" };
  const rows = { myorders: JSON.stringify([order]), "fill_0xF1": JSON.stringify({ role: "maker", orderId: order.orderId, filled: "60", txpowid: "0xF1", status: "done", ts: 1 }),
    relays: JSON.stringify(["https://relay.example/dex-relay"]), coin_max_age: "900", pending_takes: "{}", void_takes: "{}" };
  for (const k of Object.keys(rows)) await sql(first.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '" + rows[k].replace(/'/g, "''") + "')");
  await sql(first.host, "MERGE INTO `my_coins` (`coinid`) KEY (`coinid`) VALUES ('0xC01N')");
  await sql(first.host, "CREATE TABLE IF NOT EXISTS pp_posted_inputs (coinid varchar(160) primary key, handle varchar(160))");   // the engine's own DDL (resting/input-claims.js)
  await sql(first.host, "INSERT INTO pp_posted_inputs (coinid,handle) VALUES ('0x" + "ab".repeat(32) + "','dex_1')");
  const VOLATILE = ["mm_feed"];   // the feed line carries the time it was written
  first.host.stop();
  const was = await dump(first.host, VOLATILE);
  assert.ok(was.ax_kv.length >= 8 && was.pp_posted_inputs.length === 1 && was.my_coins.length === 1);
  // the COPY: another folder, another host, as after an app restart or a move to this app
  const dir2 = tmp();
  fs.copyFileSync(path.join(first.dir, "dexicon.sqlite"), path.join(dir2, "dexicon.sqlite"));
  const second = await boot({ dir: dir2 });
  await new Promise(r => setTimeout(r, 500));   // a dozen service ticks over it: ladder pass, void sweep, settle, block refresh
  second.host.stop();
  assert.deepEqual(await dump(second.host, VOLATILE), was, "every table, every row, as it was");
  assert.equal(second.host.status().relays[0], "https://relay.example/dex-relay", "the user's relay list is the one in use");
  // and it is on disk, not only in memory
  const third = await boot({ dir: dir2 });
  third.host.stop();
  assert.deepEqual(await dump(third.host, VOLATILE), was);
  assert.ok(!fs.readdirSync(dir2).some(f => /legacy-keys/.test(f)), "a restart moves nothing aside");
});

test("wallet replacement is refused while Dexicon work needs the old keys (main/restore.js)", async () => {
  const { host, ctx } = await boot();
  const quiet = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], casino: null };
  const list = (dx) => restore.activeWorkList(Object.assign({}, quiet, dx === undefined ? {} : { dexicon: dx }));
  assert.deepEqual(await host.activeWork(), { ready: true, orders: [], pending: 0, takes: 0 });
  assert.deepEqual(list(await host.activeWork()), []);
  assert.deepEqual(list(undefined), [], "a caller that does not ask Dexicon is unchanged");
  assert.match(list(null)[0], /^Dexicon could not be asked/);
  assert.match(list({ ready: false, hasStore: true })[0], /has not finished starting/);
  assert.deepEqual(list({ ready: false, hasStore: false }), [], "never used: nothing to lose");
  const coin = "0x" + "AB".repeat(32);
  vm.runInContext(`PDService.book = [{ coinid: "${coin}", orderId: "0x01", ownerPk: PDService.identity.publickey, wantAddr: PDService.identity.address, sell: true, price: PandaDEX.d("0.01"), minima: PandaDEX.d("5"), created: PDService.block, fillable: true }]`, ctx);
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{\"t1\":{\"sent\":1,\"mine\":[]}}')");
  const w = await host.activeWork();
  assert.deepEqual(w, { ready: true, orders: [coin], pending: 0, takes: 1 });
  const l = list(w);
  assert.equal(l.length, 2);
  assert.ok(l[0].includes(coin), "the order's coin id in full");
  assert.match(l[1], /^1 Dexicon trade sent and not yet answered/);
  const cold = makeHost({ runner: async () => ({ status: false }), dataDir: tmp(), net: M.mockNet(), quiet: true });
  assert.deepEqual(await cold.activeWork(), { ready: false, hasStore: false });
});

test("the app wiring: started and stopped with the node, in the reset chain, flushed on quit, one bridge", () => {
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), pre = fs.readFileSync(path.join(M.root, "main/preload.js"), "utf8"), app = fs.readFileSync(path.join(M.root, "renderer/app.js"), "utf8");
  assert.ok(main.includes('node.on("status", (s) => { if (s.state === "running") dexicon.start(); else dexicon.stop(); });'), "only a running node (wallet made, key-mode gate passed) starts it");
  assert.ok(main.includes('ipcMain.handle("mcd:dxCommand", (_e, a) => dexicon.command(a));'));
  assert.ok(main.includes('ipcMain.handle("mcd:dxInvalidate", () => { dexicon.invalidate(); return true; });'));
  assert.ok(main.includes("dexicon: await dexicon.activeWork().catch(() => null) });"), "a failed read is null, which refuses");
  assert.ok(/try \{ dexicon\.flush\(\); \} catch \(err\) \{\}/.test(main));
  for (const f of ["dxStatus", "dxBook", "dxMine", "dxCommand", "dxInvalidate", "onDexicon"]) assert.ok(pre.includes("  " + f + ": "), "preload: " + f);
  assert.ok(/async function walletReplaced\(\) \{[\s\S]*?api\.dxInvalidate\(\)[\s\S]*?\n\}/.test(app), "the renderer's reset chain calls it");
  const host = fs.readFileSync(path.join(M.root, "main/dexicon.js"), "utf8");
  assert.ok(!/require\("(http|https|net|child_process)"\)/.test(host), "the host opens no socket of its own");
  assert.equal((host.match(/rpcCall\(/g) || []).length, 1, "one way to the node: rpcCall");
  const code = host.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // comments name what was left behind; the code must not hold it
  for (const gone of ["DX_GATE", "RELAY_HOSTS", "pauseAll", "Mandate", "MAKER_", "setPrice", "setGate", "mxusd_tokenid"]) assert.ok(!code.includes(gone), "DexiconPro-only part not ported: " + gone);
});

test("no test reached a real node or the real network", () => {
  assert.deepEqual(M.leaks, []);
});
