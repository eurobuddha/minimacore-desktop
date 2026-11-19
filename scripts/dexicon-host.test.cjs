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
  const node = M.mockNode(o.node), net = o.net || M.mockNet(), dir = o.dir || tmp();
  const host = makeHost({ runner: o.wrap ? o.wrap(node.run) : node.run, dataDir: dir, net, tickMs: o.tickMs || 40, quiet: true, netLimitMs: o.netLimitMs });
  node.attach(host); hosts.push(host);
  await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  return { host, node, net, dir, ctx: host._ctx() };
}
// the tests' own way into the store (any statement); the screens' bridge takes an allow-list (0.18.110, tested below)
const sql = async (host, query) => { const r = host._sql(query); assert.equal(r.status, true, query + " → " + r.error); return r.rows || []; };
const dump = async (host, skip) => {
  const out = {};
  for (const t of (await sql(host, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.NAME))
    out[t] = (await sql(host, "SELECT * FROM `" + t + "`")).filter(r => !(t === "ax_kv" && skip.includes(r.K))).map(r => JSON.stringify(r)).sort();
  return out;
};
test.after(() => { for (const h of hosts) h.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("the parity manifest verifies, and the host loads only manifest files", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "dexicon-parity-manifest.cjs"), "--verify"], { encoding: "utf8" });
  assert.match(out, /^PASS 38 Dexicon engine files match the committed manifest/);
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
  await M.until(() => host.status().ready);
  assert.equal(node.seen.filter(c => c.startsWith("seedrandom")).length, 2, "the node that starts may hold another wallet: a start never reuses the identity the stopped node gave (0.18.106)");
  assert.notEqual(host._ctx(), null);
});

test("the net allow-list: https, the engine's own relay list and the MiniDapp's price source, nothing else", async () => {
  const { host } = await boot();
  const ok = (u, m) => host._netAllowed(u, m || "GET");
  assert.ok(ok("https://eurobuddha.com/dex-relay/dex/book?market=MINIMA%2FMxUSD&since=0&hold=0"));
  assert.ok(ok("https://minimammr.com/dex-relay/dex/publish", "POST"));
  assert.ok(ok("https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20"));
  assert.ok(!ok("https://api.mexc.com/api/v3/order", "POST"), "the price source is read, never written");
  // the one fallback (engine 0.0.90): MEXC's own ticker as CoinGecko rebroadcasts it. That host, that path, GET, nothing else
  const gecko = vm.runInContext("AX.ladder.GECKO_MEXC_URL", host._ctx());
  assert.equal(gecko, "https://api.coingecko.com/api/v3/coins/minima/tickers?exchange_ids=mxc");
  assert.ok(ok(gecko), "the engine's own fallback URL");
  assert.ok(!ok(gecko, "POST"));
  for (const u of ["https://api.coingecko.com/api/v3/coins/bitcoin/tickers", "https://api.coingecko.com/api/v3/coins/minima/tickers/../../../ping", "https://api.coingecko.com:8443/api/v3/coins/minima/tickers",
    "https://pro-api.coingecko.com/api/v3/coins/minima/tickers", "https://api.coingecko.com.evil.example/api/v3/coins/minima/tickers", "http://api.coingecko.com/api/v3/coins/minima/tickers", "https://api.binance.com/api/v3/depth", "https://api.xt.com/v4/public/ticker"])
    assert.ok(!ok(u), "refused: " + u);
  // the page asks no exchange for anything: neither price host through its relay transport
  for (const url of [gecko, "https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20"]) assert.deepEqual(await host.command({ op: "net", method: "GET", url }), { status: false, error: "host not allowed" });
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
  await refused("seedrandom modifier:other", /not read through this bridge/);
  await refused("seedrandom modifier:dexicon-identity-v1", /not read through this bridge/);
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

// engine 0.0.91 (lib/ownskip.js): an order routes PAST this node's own on-chain orders. The desktop's refusal rule is gone.
const BOOK = (rows) => `(function () {
    var mk = function (id, mine, sell, price) { return { coinid: id, orderId: id, ownerPk: mine ? PDService.identity.publickey : "0x" + new Array(65).join("9"), wantAddr: PDService.identity.address, sell: sell, price: PandaDEX.d(price), minima: PandaDEX.d("100"), locked: sell ? PandaDEX.d("100") : PandaDEX.d(price).mul(100), wantAmt: sell ? PandaDEX.d(price).mul(100) : PandaDEX.d("100"), minRem: PandaDEX.d("0"), created: PDService.block, fillable: true }; };
    PDService.book = ${JSON.stringify(rows)}.map(function (r) { return mk(r[0], r[1], r[2], r[3]); });
    if (!globalThis.__plans) { globalThis.__plans = []; var fill = PandaTxn.fill; PandaTxn.fill = function (cmd, id, plan) { __plans.push(plan.takes.map(function (t) { return t.order.coinid + ":" + PandaDEX.plain(t.minima); })); return fill.apply(PandaTxn, arguments); }; }
  })()`;
const limitVia = (host, data) => host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "LIMIT", data }) });

test("an own order at the best price, a third party's behind it: a LIMIT is not refused, and fills the third party", async () => {
  const { host, ctx, node } = await boot();
  const packets = []; host.emitter.on("comms", m => { const p = JSON.parse(m); if (p.origin === "service" && p.type !== "STATE") packets.push(p); });
  vm.runInContext(BOOK([["0xAA01", true, true, "0.0090"], ["0xBB02", false, true, "0.0095"], ["0xAA03", true, false, "0.0080"]]), ctx);
  assert.equal(host.book().book.filter(o => o.ours).length, 2, "the read model still marks the own orders");
  node.seen.length = 0;
  assert.deepEqual(await limitVia(host, { buy: true, minima: "10", price: "0.0100" }), { status: true }, "the bridge refuses nothing: own orders in the stack do not block an order");
  await M.until(() => vm.runInContext("__plans.length", ctx) > 0 || packets.length > 0);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(__plans)", ctx)), [["0xBB02:10"]], "the engine's plan takes the third party's order at 0.0095, past the own one at 0.0090");
  await M.until(() => packets.length > 0);   // the mock wallet holds no coins, so the build ends; what matters is which coin it named
  assert.ok(!node.seen.some(c => c.includes("0xAA01")), "the own order's coin is in no command");
  assert.ok(!packets.some(p => /own order/i.test(JSON.stringify(p))), JSON.stringify(packets));
  assert.equal(ctx.DX.selfTrade, undefined, "the desktop's own refusal rule is gone");
});

test("only own orders inside the limit: the engine's sentence, nothing built, nothing sent; an own pool is still routed to", async () => {
  const { host, ctx, node } = await boot();
  const packets = []; host.emitter.on("comms", m => { const p = JSON.parse(m); if (p.origin === "service" && p.type !== "STATE") packets.push(p); });
  vm.runInContext(BOOK([["0xAA01", true, true, "0.0090"], ["0xBB02", false, true, "0.0200"]]), ctx);
  node.seen.length = 0;
  assert.deepEqual(await limitVia(host, { buy: true, minima: "10", price: "0.0100" }), { status: true });
  await M.until(() => packets.length > 0);
  assert.deepEqual(packets, [{ origin: "service", type: "ERROR", data: { message: "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent." } }]);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!node.seen.some(c => /^(txn|send|newscript|consolidate)/.test(c)), "nothing was built, signed or posted: " + node.seen.join(" | "));
  assert.equal(vm.runInContext("__plans.length", ctx), 0);
  // pools are not part of the rule (owner, 19 Nov 2026): with an own pool inside the limit there is something to trade against
  vm.runInContext(`(function () {
    PDService.pools = [PandaPool.clean({ opk: PDService.identity.publickey.toLowerCase(), oadr: "0x01", tok: PandaDEX.USDT, kmin: "0", address: "0xC1", reserveM: "100000", reserveT: "900", coinidM: "0xC101", coinidT: "0xC102" })];
    PDService.poolHaveLive = true;
  })()`, ctx);
  assert.equal(vm.runInContext('AX.ownskip.onlyOwn(PDService.book, PDService.pools, true, "10", "0.0100", PDService.block)', ctx), "");
  assert.equal(host.book().pools.find(p => p.address === "0xC1").mine, true, "own pool, key matched whatever its letter case");
  // keys not read: own orders cannot be told apart, so the wrapped planner refuses to plan a non-empty book at all
  vm.runInContext("PDService.keysReady = false", ctx);
  assert.throws(() => vm.runInContext('PandaBook.plan(PDService.book, true, "10", "0.0100", PDService.block)', ctx), /Still reading this wallet's keys/);
});

test("MEXC unreachable: the price is MEXC's own ticker via CoinGecko, labelled; a MEXC answer needs no fallback", async () => {
  const calls = [], iso = new Date(Date.now() - 20000).toISOString().slice(0, 19) + "Z";
  const net = { calls, async fetchJson(url) {
      calls.push("GET " + url);
      if (/^https:\/\/api\.mexc\.com\//.test(url)) return null;   // as main/netfetch.js answers a failed read
      if (url === "https://api.coingecko.com/api/v3/coins/minima/tickers?exchange_ids=mxc") return { tickers: [{ market: { identifier: "binance" }, target: "USDT", last: 9 },
        { market: { identifier: "mxc" }, target: "USDT", last: 0.0101, bid_ask_spread_percentage: 1, last_fetch_at: iso, is_stale: false, is_anomaly: false }] };
      if (/\/dex\/inbox\?/.test(url)) return { cursor: 0, messages: [] };
      if (/\/dex\/book\?/.test(url)) return { cursor: 0, orders: [] };
      return null;
    }, async postText(url) { calls.push("POST " + url); return '{"ok":true}'; } };
  const { host } = await boot({ net });
  await M.until(() => host.status().price.mid > 0);
  const px = host.status().price;
  assert.ok(Math.abs(px.mid - 0.0101) < 1e-12, "MEXC's last trade, from the mxc row only: " + px.mid);
  assert.equal(px.source, "MEXC via CoinGecko", "the read model carries the engine's own label");
  assert.ok(px.ageMs >= 20000, "aged from CoinGecko's fetch time, not from now");
  const order = calls.filter(c => /mexc|coingecko/.test(c));
  assert.deepEqual(order.slice(0, 3), ["GET https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20", "GET https://api.mexc.com/api/v3/ticker/bookTicker?symbol=MINIMAUSDT", "GET https://api.coingecko.com/api/v3/coins/minima/tickers?exchange_ids=mxc"], "both MEXC calls first, then the fallback");
  assert.ok(calls.every(c => /^(GET|POST) https:\/\/(api\.mexc\.com\/|api\.coingecko\.com\/api\/v3\/coins\/minima\/tickers\?|eurobuddha\.com\/|store\.eurobuddha\.com\/|minimammr\.com\/)/.test(c)), "CoinGecko is the only non-MEXC host the price fetch reaches:\n" + calls.join("\n"));
  await M.until(async () => /MEXC via CoinGecko mid \(MEXC direct unreachable\)/.test(JSON.stringify(await sql(host, "SELECT v FROM ax_kv WHERE k='mm_feed'"))));   // the market maker's feed line says it too
  // MEXC answering: its answer stands and CoinGecko is never asked
  const up = await boot();
  await M.until(() => up.host.status().price.mid > 0);
  assert.equal(up.host.status().price.source, "MEXC");
  assert.ok(!up.net.calls.some(c => /coingecko/.test(c)));
  assert.equal(makeHost({ quiet: true, dataDir: tmp() }).status().price.source, "", "no price yet: no source claimed");
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

// 0.18.117 (H3): a maker's co-signed take is recorded AFTER txnpost answers. Dropping the engine at the node's
// "stopping" lost that record: the fill was on the chain, the taker was never told, the order was backed again in full.
// The engine's own verification is stood in for (a mock node cannot make a valid take); the host and the service are real.
const COIN = "0x" + "C0".repeat(32), OUT = "0x" + "0D".repeat(32), ORDER = "0x" + "1".repeat(32), POSTED = "0x" + "AB".repeat(32);
async function makerWithTake(onPost, more) {
  const b = await boot({ node: { on: (c) => (/^txnpost id:dmtest/.test(c) ? onPost() : more ? more(c) : null) } });
  await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([LIVE_ORDER(b.node.ADDRESS)]) + "')");
  vm.runInContext(`AX.maker.refresh = function (a, b, c, cb) { cb(null, 0, null); }; AX.maker.syncRelays = function (a, b, c, cb) { cb({ lines: [] }); };
    AX.fill.verifyAsMaker = function () { return { ok: true, filled: "40", received: "0.492", paid: "40" }; };
    AX.fill.cosign = function (mds, hex, keys, verifyFn, cb) { var v = verifyFn({ inputs: [{ coinid: "${COIN}" }], outputs: [{ coinid: "${OUT}" }] }, []);
      mds.cmdR("txnpost id:dmtest", function (e, post) { if (e) return cb(e, null, v); cb(null, post.txpowid, v, ["${OUT}"]); }); };
    var __takeDone = false;
    handleTake({ _from: AX.identity.fromSeed("0x" + new Array(33).join("a0"), "decks").publicId(), txn: "0xabcd", orderId: "${ORDER}" }, function () { __takeDone = true; });`, b.ctx);
  await M.until(() => b.node.seen.some(c => /^txnpost id:dmtest/.test(c)));
  return b;
}
const orderNow = async (host) => JSON.parse((await sql(host, "SELECT v FROM ax_kv WHERE k='myorders'"))[0].V)[0];
const fillsNow = async (host) => (await sql(host, "SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'")).map(r => Object.assign({ K: r.K }, JSON.parse(r.V)));
const msgs = (net) => net.calls.filter(c => /^POST .*\/dex\/msg$/.test(c)).length;

test("H3: the node is stopping while a co-signed take's txnpost is unanswered: the engine is not dropped until the fill is recorded, the taker told and the order reduced", async () => {
  let answer; const b = await makerWithTake(() => new Promise(r => { answer = () => r({ status: true, pending: false, response: { txpowid: POSTED } }); }));
  const told = msgs(b.net);
  const stopped = b.host.stop();                       // node status "stopping"
  assert.equal(b.host.status().started, false, "the timer ends at once"); assert.equal(b.host.status().ready, false, "and the screens see an engine that takes nothing new");
  await new Promise(r => setTimeout(r, 200));
  assert.ok(b.host._ctx(), "not dropped while txnpost is unanswered (far beyond three quiet looks)");
  b.node.seen.length = 0; b.host._fire("MDS_TIMER_10SECONDS"); await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(b.node.seen, [], "no new work is started while it drains");
  answer(); await stopped;
  assert.equal(b.host._ctx(), null, "then it is dropped");
  await b.host.start(); await M.until(() => b.host.status().ready);
  const f = (await fillsNow(b.host)).find(x => x.txpowid === POSTED);
  assert.ok(f, "the fill is recorded"); assert.equal(f.status, "settling"); assert.equal(f.filled, "40");
  assert.equal((await orderNow(b.host)).remaining, "60", "the order is not at full size again");
  assert.ok(msgs(b.net) > told, "the taker was told");
});

test("H3: a stop with nothing in flight drops the engine after three quiet looks; a stop that never goes quiet is bounded when no txnpost is out", async () => {
  const a = await boot(); const t0 = Date.now(); await a.host.stop();
  assert.equal(a.host._ctx(), null); assert.ok(Date.now() - t0 < 2000, "quick: " + (Date.now() - t0) + " ms");
  const node = M.mockNode({ on: (c) => (c === "coins never" ? new Promise(() => {}) : null) }), logs = [];
  const host = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), tickMs: 40, quiet: true, drainMs: 300 }); node.attach(host); hosts.push(host);
  host.emitter.on("log", l => logs.push(l));
  await host.start(); await M.until(() => host.status().ready && host.status().restingReady);
  host._ctx().AX.mds.cmd("coins never", () => {});     // a read that never answers
  const t1 = Date.now(); await host.stop();
  assert.ok(Date.now() - t1 >= 300 && Date.now() - t1 < 3000); assert.equal(host._ctx(), null);
  assert.ok(logs.some(l => /still working after/.test(l)));
});

test("H3: txnpost never answered (the node went away): recorded as unknown, the order reduced, the taker told nothing; the chain then says done, or never posted and the amount comes back", async () => {
  for (const mined of [true, false]) {
    let chain = false;   // what the chain says, once asked for below
    const b = await makerWithTake(() => { throw new Error("socket hang up"); },
      (c) => (!chain ? null : mined && c === "coins coinid:" + OUT ? { status: true, pending: false, response: [{ coinid: OUT, created: "1234" }] }
        : !mined && c === "coins coinid:" + COIN + " checkmempool:true" ? { status: true, pending: false, response: [{ coinid: COIN }] } : null));
    await M.until(() => vm.runInContext("__takeDone", b.ctx));
    let f = (await fillsNow(b.host))[0];
    assert.equal(f.status, "unknown"); assert.match(f.K, /^fill_unanswered_/); assert.deepEqual(f.spent, [COIN]); assert.deepEqual(f.coins, [OUT]);
    assert.equal((await orderNow(b.host)).remaining, "60", "not backed again at full size while the fill's fate is unknown");
    assert.equal(msgs(b.net), 0, "neither 'taken' nor 'refused' is claimed");
    await b.host.stop(); await b.host.start(); await M.until(() => b.host.status().ready);   // a restart in between: the record is on disk
    assert.equal((await orderNow(b.host)).remaining, "60");
    if (!mined) { f.ts -= 601; const K = f.K; delete f.K; await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + K + "', '" + JSON.stringify(f) + "')"); }
    chain = true; vm.runInContext("settleFills()", b.host._ctx());
    await M.until(async () => (await fillsNow(b.host))[0].status !== "unknown");
    f = (await fillsNow(b.host))[0];
    if (mined) { assert.equal(f.status, "done"); assert.equal(f.block, "1234"); assert.equal((await orderNow(b.host)).remaining, "60"); }
    else { assert.equal(f.status, "lost"); await M.until(async () => (await orderNow(b.host)).remaining === "100"); }
    await b.host.stop();
  }
});

test("H3: txnpost refused at the door (nothing listening): the node provably did not run it, so it is an ordinary refusal", async () => {
  const b = await makerWithTake(() => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }); });
  await M.until(() => vm.runInContext("__takeDone", b.ctx));
  assert.deepEqual(await fillsNow(b.host), []); assert.equal((await orderNow(b.host)).remaining, "100");
  await M.until(() => msgs(b.net) > 0);   // the refusal
});

// 0.18.119 (H4): netfetch capped every POST body at 64K characters. A sealed take is about eight times its
// transaction (hex in JSON, hex again in the signed payload, hex again as the sealed blob), so a take over about
// 7.8 KB of transaction never left: "no relay accepted the take", after the taker's key uses were spent.
test("H4: a take of realistic size, built by the engine's own envelope code, is inside the protocol's limit and is sent with that limit", async () => {
  const posts = [], inner = M.mockNet();
  const net = { calls: inner.calls, fetchJson: inner.fetchJson, async postText(url, body, opts) { posts.push({ url, len: body.length, opts }); return '{"ok":true}'; } };
  const { host, ctx } = await boot({ net });
  const relay = host.status().relays[0];
  // a two-input, two-signature take: 12,000 bytes of transaction (a Winternitz signature with its proof is several KB)
  const raw = vm.runInContext(`(function () {
    var to = AX.identity.fromSeed("0x" + new Array(33).join("a0"), "decks").publicId(), txn = "0x" + new Array(12001).join("ab");
    var blob = AX.identity.seal(ME, to, AX.hex.utf8(JSON.stringify({ k: "take", orderId: "0x" + new Array(33).join("1"), txn: txn })));
    return AX.envelope.msg(ME, to, blob, nowS() + 300);
  })()`, ctx);
  assert.ok(raw.length > 64 * 1024, "over the old cap: " + raw.length + " characters for a 12,000 byte transaction");
  assert.ok(raw.length <= ctx.AX.envelope.MAX_MSG_BYTES, "inside the protocol's limit");
  assert.equal(vm.runInContext("AX.envelope.verify", ctx)(raw, Math.floor(Date.now() / 1000)).ok, true, "a relay running the same rules accepts it");
  posts.length = 0;
  // the page's take (renderer/dexicon/mds.js XMLHttpRequest → { op: "net" }) and the service's own reply path
  assert.deepEqual(await host.command({ op: "net", method: "POST", url: relay + "/dex/msg", body: raw }), { status: true, response: '{"ok":true}' });
  await new Promise(res => ctx.MDS.net.POST(relay + "/dex/msg", raw, res));
  assert.equal(posts.length, 2);
  for (const p of posts) { assert.equal(p.len, raw.length); assert.equal(p.opts.maxBody, ctx.AX.envelope.MAX_MSG_BYTES, "the engine's own message limit, not netfetch's 64K default"); assert.equal(p.opts.ownCap, true); assert.equal(p.opts.noRedirect, true); }
  // only to a relay of the engine's list: the larger limit is not a way to post anywhere else
  assert.deepEqual(await host.command({ op: "net", method: "POST", url: "https://evil.example/dex/msg", body: raw }), { status: false, error: "host not allowed" });
  assert.equal(posts.length, 2);
});

// 0.18.116 (M2): held around a wallet-replacing megammrsync. Nothing starts it, no screen reaches the node through it,
// and the store stays where it is: released on the same wallet, it goes on with every record.
test("hold: the engine is stopped and stays stopped (node status, timer, a screen), the store is not moved; release and start bring it back on the same records", async () => {
  const { host, node, dir } = await boot();
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{\"0xAB\":{\"id\":\"0xAB\"}}')");
  const id = host.status().publicId;
  host.hold();
  assert.equal(host.status().started, false); assert.equal(host.status().ready, false);
  await new Promise(r => setTimeout(r, 120)); node.seen.length = 0;
  await host.start();                                         // the node says "running" again
  await assert.rejects(host.init(), /stopped while the wallet is being replaced/);
  await assert.rejects(host.command({ op: "cmd", command: "txnsign id:x publickey:auto" }), /stopped while the wallet is being replaced/);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(host.status().started, false, "sticky"); assert.deepEqual(node.seen, [], "nothing reached the node while held");
  assert.deepEqual(fs.readdirSync(dir).filter(f => /legacy/.test(f)), [], "the store was not moved aside");
  host.release(); await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  assert.equal(host.status().publicId, id);
  assert.deepEqual((await sql(host, "SELECT v FROM ax_kv WHERE k='pending_takes'")).map(r => r.V), ['{"0xAB":{"id":"0xAB"}}'], "the take awaiting an answer is still known");
});

// 0.18.106 (HIGH): the wallet was replaced and nothing invalidated the store (the window was closed, runResync threw,
// the app crashed, or the move aside failed). The engine must not trade the old wallet's orders on the new wallet.
const LIVE_ORDER = (address) => ({ orderId: "0x" + "1".repeat(32), side: "sell", price: "0.0123", amount: "100", remaining: "100", coins: ["0x" + "C0".repeat(32)], scripts: [], address, seq: Date.now(), expiry: Math.floor(Date.now() / 1000) + 3600, status: "live" });
async function oldWalletStore(dir) {
  const a = await boot({ dir, node: { seed: "one" } }), id = a.host.status().publicId;
  await sql(a.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([LIVE_ORDER(a.node.ADDRESS)]) + "')");
  await sql(a.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('mm_config', '{\"enabled\":true,\"peg\":true}')");
  await a.host.stop();   // as the node stopping does: the store is on disk
  return { id, bytes: fs.readFileSync(path.join(dir, "dexicon.sqlite")) };
}
const legacy = (dir) => fs.readdirSync(dir).filter(f => /^dexicon\.sqlite-legacy-keys-\d{8}(-\d+)?$/.test(f));

test("another wallet under an un-invalidated store: the engine does not go READY on it; the store is moved aside and it starts clean", async () => {
  const dir = tmp(), old = await oldWalletStore(dir);
  assert.deepEqual(legacy(dir), []);
  // the SAME folder, a node that now holds another wallet (seed two): what a missed dxInvalidate used to leave behind
  const node = M.mockNode({ seed: "two" }), net = M.mockNet(), logs = [];
  const host = makeHost({ runner: node.run, dataDir: dir, net, tickMs: 40, quiet: true }); node.attach(host); hosts.push(host);
  host.emitter.on("log", l => logs.push(l));
  const readyOnOld = []; host.emitter.on("update", () => { const s = host.status(); if (s.ready && s.publicId !== null) readyOnOld.push(s.publicId); });
  await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  const idB = host.status().publicId;
  assert.notEqual(idB, old.id, "a different seed gives a different identity");
  const kept = legacy(dir);
  assert.equal(kept.length, 1, "the old wallet's store is moved aside under its dated name");
  assert.ok(fs.readFileSync(path.join(dir, kept[0])).equals(old.bytes), "byte for byte: never deleted, never written to by the new wallet");
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k IN ('myorders','mm_config')"), [], "the old store's orders and ladder are not carried over");
  assert.deepEqual((await sql(host, "SELECT v FROM ax_kv WHERE k='publicId'")).map(r => r.V), [idB]);
  assert.ok(logs.some(l => l.includes("NOT STARTING on this store") && l.includes(old.id) && l.includes(idB)), "said loudly, both identities in full:\n" + logs.join("\n"));
  // nothing of the old wallet's order reached a relay or the node from the new wallet
  await new Promise(r => setTimeout(r, 300));   // several ticks, a maker refresh among them at this tick length
  assert.ok(!net.calls.some(c => /^POST .*\/dex\/publish/.test(c)), "no order was published:\n" + net.calls.filter(c => /^POST/.test(c)).join("\n"));
  assert.ok(!node.seen.some(c => /^(txn|send)/.test(c) || c.includes("C0".repeat(32))), "no transaction was built over the old order's coins");
  assert.equal(host.status().problem, "");
  // the same wallet again (an ordinary restart): nothing is moved
  host.stop();
  const again = await boot({ dir, node: { seed: "two" } });
  assert.equal(again.host.status().publicId, idB); assert.equal(legacy(dir).length, 1, "a restart on the same wallet moves nothing aside");
});

test("the old store cannot be moved aside: the engine does not start on it, says why, and starts clean once it can", async () => {
  if (process.getuid && process.getuid() === 0) return;   // root ignores the folder permission this test uses
  // (1) found at boot by the identity check
  const dir = tmp(), old = await oldWalletStore(dir);
  const node = M.mockNode({ seed: "two" }), net = M.mockNet();
  const host = makeHost({ runner: node.run, dataDir: dir, net, tickMs: 40, quiet: true }); node.attach(host); hosts.push(host);
  fs.chmodSync(dir, 0o555);   // rename out of this folder now fails
  try {
    await host.start();
    await M.until(() => host.status().problem !== "");
    assert.match(host.status().problem, /could not be moved aside .*so Dexicon is not running: it must not trade on another wallet's records/);
    assert.ok(host.status().problem.includes(path.join(dir, "dexicon.sqlite")), "the file is named in full");
    const n = node.seen.length;
    await new Promise(r => setTimeout(r, 300));   // seven ticks of retrying
    assert.equal(host.status().ready, false); assert.equal(host._ctx(), null, "no engine exists on that store");
    assert.equal(node.seen.length, n, "and nothing more is asked of the node");
    assert.ok(!net.calls.some(c => /^POST/.test(c)));
    assert.ok(fs.readFileSync(path.join(dir, "dexicon.sqlite")).equals(old.bytes), "the store itself is untouched");
  } finally { fs.chmodSync(dir, 0o755); }
  await M.until(() => host.status().ready && host.status().restingReady);   // by itself, at the next tick
  assert.equal(host.status().problem, ""); assert.equal(legacy(dir).length, 1);
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k='myorders'"), []);
  // (2) the same when the main process's own invalidate() cannot move it: it throws, stays owed, and no later start opens the store
  const dir2 = tmp(); await oldWalletStore(dir2);
  const node2 = M.mockNode({ seed: "two" });
  const host2 = makeHost({ runner: node2.run, dataDir: dir2, net: M.mockNet(), tickMs: 40, quiet: true }); node2.attach(host2); hosts.push(host2);
  fs.chmodSync(dir2, 0o555);
  try {
    assert.throws(() => host2.invalidate({ hold: true }), /could not be moved aside/);
    assert.equal(host2.status().started, false, "held: it starts with the node, not before");
    await host2.start();   // the node is "running" again
    await new Promise(r => setTimeout(r, 200));
    assert.equal(host2.status().ready, false); assert.equal(node2.seen.length, 0, "not even the identity is asked for while the old store is in the way");
  } finally { fs.chmodSync(dir2, 0o755); }
  await M.until(() => host2.status().ready);
  assert.equal(legacy(dir2).length, 1);
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
  const was = await dump(first.host, VOLATILE);
  first.host.stop();
  assert.ok(was.ax_kv.length >= 8 && was.pp_posted_inputs.length === 1 && was.my_coins.length === 1);
  // the COPY: another folder, another host, as after an app restart or a move to this app
  const dir2 = tmp();
  fs.copyFileSync(path.join(first.dir, "dexicon.sqlite"), path.join(dir2, "dexicon.sqlite"));
  const second = await boot({ dir: dir2 });
  await new Promise(r => setTimeout(r, 500));   // a dozen service ticks over it: ladder pass, void sweep, settle, block refresh
  assert.equal(second.host.status().relays[0], "https://relay.example/dex-relay", "the user's relay list is the one in use");
  assert.deepEqual(await dump(second.host, VOLATILE), was, "every table, every row, as it was");
  second.host.stop();
  // and it is on disk, not only in memory
  const third = await boot({ dir: dir2 });
  assert.deepEqual(await dump(third.host, VOLATILE), was);
  third.host.stop();
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
  assert.deepEqual(await cold.activeWork(), { ready: false, hasStore: false, waitedMs: 0 });
  // 0.18.109: takes awaiting an answer are counted from the store, with no screen open, and also while the chain is
  // still being read (the FAST half is up, the on-chain half is not); a take being voided counts too
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('void_takes', '{\"t2\":{\"mine\":[]},\"t3\":{\"mine\":[]}}')");
  assert.equal((await host.activeWork()).takes, 3);
  vm.runInContext("PDService.ready = false", ctx);
  const half = await host.activeWork();
  assert.deepEqual([half.ready, half.hasStore, half.takes], [false, true, 3]); assert.ok(half.waitedMs > 0);
  assert.match(list(await host.activeWork())[0], /has not finished starting/, "the restore gate still refuses");
  // the engine's instance number: the screens remake their page frame when it changes
  const e1 = host.status().epoch; host.stop(); await host.start(); await M.until(() => host.status().ready);
  assert.ok(host.status().epoch > e1, "a node restart is another engine");
});

// 0.18.107 (MEDIUM): the epoch guard is at entry only. A signing command already waiting in the process-wide queue
// when the engine is stopped or invalidated must not be sent afterwards.
test("a signing command still queued when the engine is stopped or its wallet replaced never reaches the node", async () => {
  for (const how of ["stop", "invalidate"]) {
    const atNode = []; let release;
    const gate = new Promise(r => { release = r; });
    // the app's arrangement: one queue under every signer (main/noderun.js), as main/rpc.js puts it under rpcCall
    const queued = (run) => { const q = createNodeRunner(async (c) => { if (SIGNING.test(c)) { atNode.push(c); if (c.includes("first")) await gate; } return run(c); }); return (c, o) => q.run(c, undefined, o); };
    const { host, ctx } = await boot({ wrap: queued });
    const mds = ctx.AX.mds, ask = (c) => new Promise(res => mds.cmd(c, res));
    const first = ask("txnsign id:first publickey:auto");          // at the node, signing
    await M.until(() => atNode.length === 1);
    const second = ask("txnsign id:second publickey:auto");        // from the engine: waits its turn in the queue
    const third = host.command({ op: "cmd", command: "txnsign id:third publickey:0xAB" });   // from the page's bridge: queued too
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(atNode, ["txnsign id:first publickey:auto"], "queued, not sent");
    if (how === "stop") host.stop(); else host.invalidate({ hold: true });
    release();
    const [, r2, r3] = [await first, await second, await third];
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(atNode, ["txnsign id:first publickey:auto"], how + ": neither queued signer reached the node");
    assert.equal(r2.status, false); assert.match(r2.error, /not sent: `txnsign` was still queued when its caller gave up/);
    assert.equal(r3.status, false); assert.match(r3.error, /not sent: `txnsign` was still queued/);
  }
});

// 0.18.108 (MEDIUM): refusals to takers fanned out unthrottled into the app's shared four-slot net pool, which the
// AtomiX Ethereum RPC uses for a claim or a refund.
/** A network whose POSTs wait until the test lets them through. held: the POSTs at the network now. */
function slowNet() {
  const base = M.mockNet(), held = [], sent = [], opts = []; let most = 0;
  return { calls: base.calls, held, sent, opts, most: () => most,
    fetchJson: (url, o) => { opts.push(o); return base.fetchJson(url, o); },
    postText: (url, body, o) => { opts.push(o); sent.push(body); return new Promise(res => { const h = { url, body, done: () => { held.splice(held.indexOf(h), 1); res('{"ok":true}'); } }; held.push(h); most = Math.max(most, held.length); }); },
    drain: async function (until) { while (!until()) { while (held.length) held[0].done(); await new Promise(r => setTimeout(r, 5)); } } };
}

test("16 refused takes in one cycle: two refusals at the network at a time, never 16; nothing of Dexicon takes a slot of the shared pool", async () => {
  const net = slowNet(); let inbox = null;
  const fetchJson = net.fetchJson; net.fetchJson = (url, o) => { if (inbox && /\/dex\/inbox\?/.test(url)) { net.opts.push(o); const m = inbox; inbox = null; return Promise.resolve({ cursor: 1, messages: m }); } return fetchJson(url, o); };
  const { host, ctx } = await boot({ net });
  // 16 takes from 8 senders (the engine's own flood limits: 2 a sender, 16 a cycle), each for an order that is not live
  inbox = JSON.parse(vm.runInContext(`(function () {
    var out = [], s, i, T;
    for (s = 0; s < 8; s++) { T = AX.identity.fromSeed("0x" + new Array(33).join("a" + s), "decks");
      for (i = 0; i < 2; i++) out.push(AX.envelope.msg(T, ME.publicId(), AX.identity.seal(T, ME.publicId(), AX.hex.utf8(JSON.stringify({ k: "take", orderId: "0x" + s + i, txn: "0xAB" + s + i }))), nowS() + 300)); }
    globalThis.__low = []; globalThis.__body = []; var P = MDS.net.POST; MDS.net.POST = function (u, d, cb, low) { __low.push(low === true); __body.push(String(d)); return P(u, d, cb, low); };
    return JSON.stringify(out);
  })()`, ctx));
  await M.until(() => vm.runInContext("__low.length", ctx) >= 16);   // the service has answered all 16
  await new Promise(r => setTimeout(r, 60));
  assert.equal(net.most(), 2, "at the network at once: " + net.most());
  assert.equal(host._lanes().work, 2); assert.ok(host._lanes().workWaiting >= 14, "the other 14 wait their turn inside Dexicon's own lane (" + host._lanes().workWaiting + " waiting, the service's own reads among them)");
  assert.ok(JSON.parse(vm.runInContext("JSON.stringify(__low)", ctx)).every(Boolean), "each of them marked as a refusal by the service");
  // a reply that carries a result is sent before every refusal still waiting, and is never dropped
  vm.runInContext(`reply(AX.identity.fromSeed("0x" + new Array(33).join("a0"), "decks").publicId(), { k: "taken", orderId: "0x00", txpowid: "0x01", filled: "1", coins: [] })`, ctx);
  const before = net.sent.length, at = vm.runInContext("__low.length - 1", ctx);
  net.held[0].done();
  await M.until(() => net.sent.length === before + 1);
  assert.equal(vm.runInContext("__low[" + at + "]", ctx), false, "the 'taken' reply is not low priority");
  assert.equal(net.sent[before], vm.runInContext("__body[" + at + "]", ctx), "and it is the next POST at the network, ahead of the 14 refusals still waiting");
  await net.drain(() => host._lanes().work === 0 && host._lanes().workWaiting === 0);
  assert.equal(net.most(), 2);
  assert.ok(net.opts.length > 20 && net.opts.every(o => o && o.ownCap === true && o.noRedirect === true), "every Dexicon request tells netfetch it bounds itself: no shared slot");
});

test("Dexicon's lanes: refusals beyond 32 waiting drop oldest first; a take, an order or a read is never dropped; long polls do not block work; a request that never settles frees its place", async () => {
  const net = slowNet();
  const { host, ctx } = await boot({ net, netLimitMs: 400 });
  const post = (n, low) => vm.runInContext(`MDS.net.POST("https://eurobuddha.com/dex-relay/dex/msg", ${JSON.stringify(n)}, function (r) { __done.push([${JSON.stringify(n)}, r.status]); }, ${low})`, ctx);
  vm.runInContext("globalThis.__done = []", ctx);
  for (let i = 0; i < 40; i++) post("low" + i, true);
  const done = () => JSON.parse(vm.runInContext("JSON.stringify(__done)", ctx));
  await M.until(() => done().length === 6);
  assert.deepEqual(done(), [["low2", false], ["low3", false], ["low4", false], ["low5", false], ["low6", false], ["low7", false]], "2 at the network, 32 waiting, the 6 oldest waiting ones dropped and told so");
  assert.equal(host._lanes().dropped, 6); assert.deepEqual(net.sent, ["low0", "low1"]);
  // what carries a signature: from the engine (an order, a 'taken' reply) and from the page (a take)
  post("order", false);
  const take = host.command({ op: "net", method: "POST", url: "https://eurobuddha.com/dex-relay/dex/msg", body: "take" });
  assert.equal(host._lanes().workWaiting, 34, "not dropped although 32 refusals wait");
  // both WORK places are held: a long poll still goes out (its own lane), a plain read waits
  const n = net.calls.length;
  vm.runInContext(`MDS.net.GET("https://eurobuddha.com/dex-relay/dex/inbox?pk=0x00&since=0&hold=8", function (r) { __done.push(["poll", r.status]); }); MDS.net.GET("https://eurobuddha.com/dex-relay/dex/book?market=x&since=0&hold=0", function (r) { __done.push(["read", r.status]); })`, ctx);
  await M.until(() => done().some(d => d[0] === "poll"));
  assert.ok(!done().some(d => d[0] === "read"), "the read is WORK: it waits behind the two held places");
  assert.equal(net.calls.slice(n).filter(c => /pk=0x00/.test(c)).length, 1);
  net.held[0].done(); net.held[0].done();
  await M.until(() => net.sent.length === 4);
  assert.deepEqual(net.sent.slice(2), ["order", "take"], "signed work goes before every waiting refusal, in the order asked");
  await net.drain(() => host._lanes().work === 0 && host._lanes().workWaiting === 0);
  assert.deepEqual(await take, { status: true, response: '{"ok":true}' });
  assert.equal(net.sent.length, 2 + 2 + 32, "every refusal that was not dropped was sent in the end");
  assert.ok(done().some(d => d[0] === "read" && d[1] === true));
  assert.equal(net.most(), 2);
  // a request that never settles (netfetch gives up after 20 s by itself; the host's own limit is the backstop)
  post("stuck1", false); post("stuck2", false); post("after", false);
  await M.until(() => net.held.length === 2);
  const t0 = Date.now();
  await M.until(() => net.sent.includes("after"));
  assert.ok(Date.now() - t0 >= 300, "after the limit, not before");
  assert.ok(done().some(d => d[0] === "stuck1" && d[1] === false), "and its caller is told it failed");
  net.held.slice().forEach(h => h.done());
});

// ---- 0.18.110: the LOW findings ----
test("the screens' SQL is an allow-list: the page's own statements on ax_kv and one read of fill_state, nothing else", async () => {
  const { host } = await boot();
  const logs = []; host.emitter.on("log", l => logs.push(l));
  const run = (query) => host.command({ op: "sql", query });
  // every statement the page and the native screens issue (lib/mdsw.js kvInit/kvGet/kvSet/kvDel, ui/app.js, ui/activity.js, renderer/dexicon-ui.js load)
  const mdsw = fs.readFileSync(path.join(M.root, "main/dexicon/lib/mdsw.js"), "utf8"), ui = fs.readFileSync(path.join(M.root, "renderer/dexicon-ui.js"), "utf8");
  for (const lit of ["CREATE TABLE IF NOT EXISTS `ax_kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text NOT NULL)", "SELECT v FROM ax_kv WHERE k='", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('", "DELETE FROM ax_kv WHERE k='"]) assert.ok(mdsw.includes(lit), "the engine still writes: " + lit);
  assert.ok(ui.includes("SELECT k, v FROM ax_kv WHERE k IN ('myorders','pending_takes','mm_config','mm_status','mm_feed','mm_pool','mm_review','activity')"));
  for (const q of ["CREATE TABLE IF NOT EXISTS `ax_kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text NOT NULL)", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{\"o1\":{\"sent\":1,\"note\":\"it''s; DROP TABLE ax_kv; --\"}}')",
    "SELECT v FROM ax_kv WHERE k='pending_takes'", "SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", "SELECT k, v FROM ax_kv WHERE k IN ('myorders','pending_takes','mm_config','mm_status','mm_feed','mm_pool','mm_review','activity')",
    "DELETE FROM ax_kv WHERE k='ui_alive'", "SELECT `json` FROM `fill_state` WHERE `id`=1"])
    assert.equal((await run(q)).status, true, q);
  assert.match((await run("SELECT v FROM ax_kv WHERE k='pending_takes'")).rows[0].V, /it's; DROP TABLE ax_kv; --/, "a quote inside a value is data");
  const n = logs.length;
  for (const q of ["SELECT * FROM ax_kv", "SELECT k, v FROM ax_kv", "SELECT name FROM sqlite_master", "DROP TABLE ax_kv", "DELETE FROM ax_kv", "DELETE FROM ax_kv WHERE k='a' OR 1=1", "UPDATE ax_kv SET v='x'",
    "SELECT v FROM ax_kv WHERE k='a'; DROP TABLE ax_kv", "SELECT v FROM ax_kv WHERE k='a' UNION SELECT orderid FROM my_orders", "MERGE INTO my_orders (`orderid`) KEY(`orderid`) VALUES ('x')", "MERGE INTO maker_state (id, json) KEY(id) VALUES (1, '{}')",
    "SELECT * FROM my_orders", "INSERT INTO pp_posted_inputs (coinid,handle) VALUES ('0x01','x')", "DELETE FROM pp_posted_inputs", "CREATE TABLE x (a int)", "ATTACH DATABASE '/tmp/x' AS y", "PRAGMA table_info(ax_kv)", "select v from ax_kv where k='a'"])
    await assert.rejects(run(q), /not available to Dexicon's screens/, q);
  await assert.rejects(run("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('publicId', '0x00')"), /the engine's own/, "whose store this is: the service's record");
  await assert.rejects(run("DELETE FROM ax_kv WHERE k='publicId'"), /the engine's own/);
  assert.ok(logs.length >= n + 20 && logs.slice(n).every(l => /refused SQL from a screen/.test(l)), "each refusal is in Dexicon's log, so a statement a later page needs is seen");
  assert.equal((await sql(host, "SELECT COUNT(*) AS N FROM ax_kv WHERE k='publicId'"))[0].N, 1, "the record is intact");
});

test("the trading identity never crosses IPC: the bridge refuses it, the main process puts it into the page's own frame", async () => {
  const { host, node } = await boot();
  await assert.rejects(host.command({ op: "cmd", command: "seedrandom modifier:dexicon-identity-v1" }), /not read through this bridge/);
  await assert.rejects(host.command({ op: "identity" }), /unknown Dexicon op/, "the host itself has no frame to give it to: main.js answers that op");
  const seed = await host.identitySeed();
  assert.match(seed, /^0x[0-9a-f]{64}$/);
  const { deliverIdentity } = require("../main/dexicon-room.js");
  const ran = [], frame = (url, takes) => ({ url, executeJavaScript: async (code) => { ran.push([url, code]); return takes; } });
  const sender = (...frames) => ({ mainFrame: { framesInSubtree: frames } });
  const page = frame("dxroom://exchange/index.html", true);
  const answer = await deliverIdentity(sender(frame("file:///app/renderer/index.html", true), frame("http://127.0.0.1:9005/panel", true), frame("dxroom://other/index.html", true), page), seed);
  assert.deepEqual(answer, { status: true }, "the IPC answer says delivered, and carries nothing else");
  assert.equal(ran.length, 1); assert.equal(ran[0][0], "dxroom://exchange/index.html", "only the page's own frame: not the window, not a webview, not another dxroom host");
  assert.ok(ran[0][1].includes(JSON.stringify(seed)) && /window\.__dxIdentity\(/.test(ran[0][1]));
  for (const [s, why] of [[sender(), /is not open/], [sender(frame("file:///x", true)), /is not open/], [sender(page, frame("dxroom://exchange/index.html", true)), /more than one/], [sender(frame("dxroom://exchange/index.html", false)), /did not take/],
    [sender({ url: "dxroom://exchange/index.html", executeJavaScript: async () => { throw new Error("frame gone " + seed); } }), /could not be put into/], [{}, /is not open/]]) {
    const r = await deliverIdentity(s, seed); assert.equal(r.status, false); assert.match(r.error, why); assert.ok(!JSON.stringify(r).includes(seed.slice(2, 20)), "never the secret in an answer");
  }
  assert.deepEqual(await deliverIdentity(sender(page), "not a seed"), { status: false, error: "no trading identity to deliver" });
  // the page's side (renderer/dexicon/mds.js): it asks { op: "identity" } and is answered inside its own frame
  const sent = [], listeners = {}, win = { console: { log() {}, error() {} }, document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) }, navigator: {}, setInterval() {}, JSON, Object, Array, String, Number, Promise, Error,
    parent: { postMessage: (m) => sent.push(m) }, addEventListener: (t, f) => { listeners[t] = f; } };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(M.root, "renderer/dexicon/mds.js"), "utf8"), win);
  let got = null; win.MDS.cmd("seedrandom modifier:dexicon-identity-v1", (r) => { got = r; });
  assert.equal(JSON.stringify(sent.map(m => [m.name, m.args])), '[["room.dex",{"op":"identity"}]]', "no seedrandom command leaves the frame");
  listeners.message({ source: win.parent, data: { dxRoom: 1, id: sent[0].id, value: { status: true } } });   // what the window hears: delivered
  await new Promise(r => setImmediate(r));
  assert.equal(got, null, "the window's answer carries no seed");
  assert.equal(win.__dxIdentity(seed), true);
  assert.equal(got.status, true); assert.equal(got.response.seedrandom, seed);
  let failed = null; win.MDS.cmd("seedrandom modifier:dexicon-identity-v1", (r) => { failed = r; });
  listeners.message({ source: win.parent, data: { dxRoom: 1, id: sent[1].id, value: { status: false, error: "the Dexicon page is not open" } } });
  await new Promise(r => setImmediate(r));
  assert.deepEqual([failed.status, failed.error], [false, "the Dexicon page is not open"]);
  const C = require("../renderer/dexicon-core.js");
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 1, name: "room.dex", args: { op: "identity", command: "x" } }), { kind: "dx", args: { op: "identity" } });
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8");
  assert.ok(/if \(a && a\.op === "identity"\) \{[^\n]*dexicon\.identitySeed\(\)[^\n]*return dexiconRoom\.deliverIdentity\(e\.sender, seed\); \}/.test(main), "main.js: derived in main, delivered into the frame, not returned");
  assert.ok(node.seen.filter(c => c.startsWith("seedrandom")).length >= 2);
});

test("a Dexicon that cannot be checked does not block a wallet restore for ever: named, then skippable, and the damaged store is kept aside", async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, "dexicon.sqlite"), "this is not a database, it is a damaged file");
  const damaged = fs.readFileSync(path.join(dir, "dexicon.sqlite"));
  const node = M.mockNode(), host = makeHost({ runner: node.run, dataDir: dir, net: M.mockNet(), tickMs: 30, quiet: true }); node.attach(host); hosts.push(host);
  await host.start(); await new Promise(r => setTimeout(r, 150));
  const w = await host.activeWork();
  assert.equal(w.ready, false); assert.equal(w.hasStore, true); assert.ok(w.waitedMs >= 100 && w.waitedMs < 5000, "how long it has been trying: " + w.waitedMs);
  assert.equal(node.seen.length, 0, "an engine without a store asks the node for nothing");
  const quiet = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], casino: null };
  const list = (dexicon, more) => restore.activeWorkList(Object.assign({}, quiet, { dexicon }, more));
  // the first two minutes: wait
  assert.match(list(w)[0], /has not finished starting, so its orders could not be checked\. Wait a moment and try again\.$/);
  assert.equal(restore.onlyDexiconUnchecked(list(w)), false, "no way round it yet");
  // after two minutes of it: what cannot be checked is named, and the way on is offered
  const stuck = Object.assign({}, w, { waitedMs: 3 * 60000 + 5 });
  assert.match(list(stuck)[0], /^Dexicon has not finished starting after 3 minutes, so its on-chain orders and its trades waiting for an answer cannot be checked\. If it stays like this, you can go on without this check\.$/);
  assert.equal(restore.onlyDexiconUnchecked(list(stuck)), true);
  assert.equal(restore.onlyDexiconUnchecked(list(null)), true, "an engine that could not be asked at all");
  assert.match(list(null)[0], /its store may be damaged/);
  assert.deepEqual(list(stuck, { skipDexicon: true }), [], "the user chose to go on: the Dexicon check is left out");
  assert.deepEqual(list(null, { skipDexicon: true }), []);
  // never a way round work that IS known
  const swap = { atomix: { ready: true, swaps: ["0x" + "5A".repeat(32)], maker: false, otcOffer: false, otcDeals: 0 } };
  assert.equal(restore.onlyDexiconUnchecked(list(stuck, swap)), false, "an AtomiX swap in flight still blocks");
  assert.equal(list(stuck, Object.assign({ skipDexicon: true }, swap)).length, 1);
  assert.equal(list({ ready: true, orders: ["0x" + "AB".repeat(32)], pending: 0, takes: 0 }, { skipDexicon: true }).length, 1, "a Dexicon that CAN be checked is checked: skip leaves out only the unknown");
  assert.equal(restore.onlyDexiconUnchecked([]), false);
  assert.match(restore.DEX_SKIP_WARNING, /kept beside the new one under a dated name\. Nothing is deleted\./);
  // the replacement itself: the damaged file is moved aside as it is, and Dexicon starts clean
  host.stop();
  const kept = host.invalidate({ hold: true });
  assert.ok(fs.readFileSync(kept).equals(damaged));
  await host.start(); await M.until(() => host.status().ready && host.status().restingReady);
  // main.js: the skip is checked again in the main process, lasts two minutes, and is logged
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), app = fs.readFileSync(path.join(M.root, "renderer/app.js"), "utf8");
  assert.ok(main.includes("if (!restore.onlyDexiconUnchecked(list)) throw new Error(") && main.includes("dexSkipUntil = Date.now() + 120000;") && main.includes("const list = await walletWork(false);"));
  assert.ok(/async function offerWithoutDexicon\(e\) \{[\s\S]*?showConfirm\("Go on without checking Dexicon\?", warning, "Go on without the check", true\)[\s\S]*?await api\.dxSkipCheck\(\)/.test(app), "the screen warns first, then asks main");
});

test("the engine's vm is not a confinement, and the loader says so", async () => {
  const { ctx } = await boot();
  assert.equal(vm.runInContext("typeof process + typeof require", ctx), "undefinedundefined", "no such NAMES in the engine's scope");
  assert.equal(vm.runInContext("MDS.log.constructor('return typeof process')()", ctx), "object", "but a host function is one step from the host's Function: the vm confines nothing");
  const head = fs.readFileSync(path.join(M.root, "main/dexicon/loader.js"), "utf8").split("*/")[0];
  assert.match(head, /THIS IS NOT A SECURITY BOUNDARY/);
  assert.ok(!/no require, no process, no fs, no network of its own/.test(head), "the old claim is gone");
});

test("the on-chain engine's start is not tried again while a start is still running; a failed one is, a minute later", async () => {
  let hold = true, fail = false; const waiting = [];
  const node = M.mockNode({ on: (c) => { if (!/^newscript /.test(c)) return null;   /* the start's second node command: nothing else registers a script while idle */ if (fail) return { status: false, error: "node busy" }; if (hold) return new Promise(res => waiting.push(res)); return null; } });
  const host = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), tickMs: 25, quiet: true }); node.attach(host); hosts.push(host);
  await host.start(); await M.until(() => host.status().ready && waiting.length >= 1);   // the first start is at its first node command, and stays there
  assert.equal(waiting.length, 1);
  const ctx = host._ctx();
  vm.runInContext("globalThis.__boots = 0; (function () { var b = PDService.boot; PDService.boot = function () { __boots++; return b.apply(PDService, arguments); }; })()", ctx);
  const minuteLater = () => vm.runInContext("lastPdBootMs = Date.now() - 61000", ctx);
  minuteLater(); await new Promise(r => setTimeout(r, 150));   // six timer events, each a minute "later"
  assert.equal(vm.runInContext("__boots", ctx), 0, "no second start beside the one still running");
  assert.equal(waiting.length, 1);
  // that start fails (the engine says so with an ERROR): the next minute's retry runs, once
  vm.runInContext("lastPdBootMs = Date.now()", ctx);   // that start began "just now"
  fail = true; hold = false; waiting.shift()({ status: false, error: "node busy" });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(vm.runInContext("__boots", ctx), 0, "not before a minute has passed");
  fail = false; minuteLater();
  await M.until(() => host.status().restingReady);
  assert.equal(vm.runInContext("__boots", ctx), 1);
  // a start that never ends at all is given up on after five minutes, and said
  const logs = []; host.emitter.on("log", l => logs.push(l));
  vm.runInContext("PDService.ready = false; pdBootingSince = Date.now() - 301000; lastPdBootMs = Date.now() - 61000", ctx);
  await M.until(() => vm.runInContext("__boots", ctx) === 2);
  assert.ok(logs.some(l => /start has not finished after 5 minutes; starting it again/.test(l)));
});

test("the app wiring: started and stopped with the node, reset by the MAIN process before the node restarts, flushed on quit, one bridge", () => {
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), pre = fs.readFileSync(path.join(M.root, "main/preload.js"), "utf8"), app = fs.readFileSync(path.join(M.root, "renderer/app.js"), "utf8");
  assert.ok(main.includes('node.on("status", (s) => { if (s.state === "running") dexicon.start(); else dexicon.stop(); });'), "only a running node (wallet made, key-mode gate passed) starts it");
  assert.ok(main.includes('ipcMain.handle("mcd:dxCommand", async (e, a) => {') && main.includes("  return dexicon.command(a);\n});"));
  assert.ok(main.includes('ipcMain.handle("mcd:dxWork", () => dexicon.activeWork().catch(() => null));') && /read\(api\.dxWork\(\)\)/.test(app), "the Shutdown warning asks for takes awaiting an answer; a failed read is null");
  // 0.18.106: the reset is the main process's, inside the resync itself; no window can ask for it, none is needed for it
  assert.ok(!/dxInvalidate/.test(main.replace(/\/\/.*$/gm, "")) && !/dxInvalidate/.test(pre) && !/dxInvalidate/.test(app), "no renderer IPC moves the store");
  const hook = main.slice(main.indexOf("node.onWalletReplaced = async () => {"), main.indexOf("// Restore from a backup FILE"));
  for (const call of ["mail.invalidateIdentity()", "pandapools.invalidate()", "atomix.invalidate()", "dexicon.invalidate({ hold: true })", "casino.invalidate()"]) assert.ok(hook.includes(call), "the main-process reset: " + call);
  assert.ok(!/api\.\w*Invalidate\(/.test(app), "the renderer's chain only clears the screen");
  assert.ok(main.includes("dexicon: await dexicon.activeWork().catch(() => null), skipDexicon });"), "a failed read is null, which refuses");
  assert.ok(/try \{ dexicon\.flush\(\); \} catch \(err\) \{\}/.test(main));
  for (const f of ["dxStatus", "dxBook", "dxMine", "dxCommand", "dxWork", "onDexicon"]) assert.ok(pre.includes("  " + f + ": "), "preload: " + f);
  const host = fs.readFileSync(path.join(M.root, "main/dexicon.js"), "utf8");
  assert.ok(!/require\("(http|https|net|child_process)"\)/.test(host), "the host opens no socket of its own");
  assert.equal((host.match(/rpcCall\(/g) || []).length, 1, "one way to the node: rpcCall");
  const code = host.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // comments name what was left behind; the code must not hold it
  for (const gone of ["DX_GATE", "RELAY_HOSTS", "pauseAll", "Mandate", "MAKER_", "setPrice", "setGate", "mxusd_tokenid"]) assert.ok(!code.includes(gone), "DexiconPro-only part not ported: " + gone);
});

test("no test reached a real node or the real network", () => {
  assert.deepEqual(M.leaks, []);
});
