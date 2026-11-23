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
  // confirm: the main-process question for a page action with no recorded intent (0.19.231); these tests answer yes unless they say
  const host = makeHost({ runner: o.wrap ? o.wrap(node.run) : node.run, dataDir: dir, net, tickMs: o.tickMs || 40, quiet: true, netLimitMs: o.netLimitMs, confirm: o.confirm || (async () => true) });
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
  assert.match(out, /^PASS 39 Dexicon engine files match the committed manifest/);
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
  assert.ok(fs.existsSync(path.join(dir, "dexicon-" + s.publicId + ".sqlite")), "the store is named by this wallet's trading identity, whole, in the host's own folder");
  assert.equal(host.storePath(), path.join(dir, "dexicon-" + s.publicId + ".sqlite"));
  assert.ok(!fs.existsSync(path.join(dir, "dexicon.sqlite")));
});

test("0.19.382 BOOT FIRST: a new block during the resting engine's own key load does not hijack its boot (it reaches READY)", async () => {
  // A slow node: each key's address read (runscript SIGNEDBY) takes 600 ms, and the tip moves at every block read, so
  // the host fires NEWBLOCK while the boot is inside loadKeys. Before 0.19.382 that refresh started a second loadKeys
  // (retryKeysIfStale), the boot's own load ended silently and the engine never became ready.
  let tip = 1000;
  const on = async (c) => {
    if (c === "block") return { status: true, pending: false, response: { block: String(tip++) } };
    if (/^runscript script:"RETURN SIGNEDBY\(/.test(c)) await new Promise(r => setTimeout(r, 600));
    return null;
  };
  const node = M.mockNode({ on }), host = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), tickMs: 40, quiet: true, confirm: async () => true });
  node.attach(host); hosts.push(host);
  await host.start();
  await M.until(() => host.status().restingReady, 6000);
  assert.equal(node.seen.filter(c => /^runscript script:"RETURN SIGNEDBY\(/.test(c)).length >= 1, true);
  assert.ok(host._ctx().PDService.keysUsable(), "the boot's own key load completed");
  host.stop();
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
  assert.equal(node.seen.filter(c => c.startsWith("seedrandom")).length, 4, "(the host derives it to name the store, the service to sign: twice per start) the node that starts may hold another wallet: a start never reuses the identity the stopped node gave (0.18.106)");
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
    "tokencreate name:x amount:1", "consolidate tokenid:0x00", "sendpoll action:list", "quit", "sign data:0x01 publickey:0x02", "txnstate id:a port:1 value:2", "runscript script:\"RETURN TRUE\""])
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
    "txncheck", "txncreate", "txndelete", "txnexport", "txninput", "txnoutput", "txnpost", "txnsign", "txnview", "txpow"], "the allow-list, pinned (txnimport left it in 0.18.120)");
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
// a LIMIT reaches the engine only against the intent the native Trade screen records when the user confirms (0.19.231)
const limitVia = async (host, data) => { await host.command({ op: "intent", type: "LIMIT", buy: !!data.buy, price: String(data.price), amount: String(data.minima) }); return host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "LIMIT", data }) }); };

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
  const old = host.status().publicId, oldMds = ctx.AX.mds, file = host.storePath();
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
    assert.equal((await b.host.activeWork()).unknown, 1, "0.18.142: counted for the Quit and Shutdown warnings");
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

// 0.18.120 (M4): the hidden page can ask for txncreate … txnsign … txnpost, so one unescaped relay string in it would
// have been full custody. The main process now checks what the NODE holds under the transaction id before it forwards
// a signature or a post (main/dexicon-signgate.js). The trades below are built by the engine's own lib/fill.js and
// lib/maker.js THROUGH the bridge, so the gate is tested against the commands the page really issues.
const ATTACKER = "0x" + "E7".repeat(32), MAKER = "0x" + "A1".repeat(32), MAKER_COIN_AT = "0x" + "A2".repeat(32), MC = "0x" + "C1".repeat(32), UC = "0x" + "C2".repeat(32), MINE2 = "0x" + "C3".repeat(32);
/** A node that keeps custom transactions as the real one does (txnlist shows what was built), and a host on it. */
async function frameRig(o = {}) {
  const txns = {}, ok = (response) => ({ status: true, pending: false, response });
  let F = null, n = 0;
  const coins = () => ({
    [MC]: { coinid: MC, address: MAKER_COIN_AT, amount: "300", tokenid: "0x00" },                                   // the maker's MINIMA, backing its order
    [UC]: { coinid: UC, address: M.ADDRESS, amount: "0.000005", tokenamount: "5", tokenid: F.MXUSD },                // this wallet's MxUSD
    [MINE2]: { coinid: MINE2, address: M.ADDRESS, amount: "7", tokenid: "0x00" } });                                 // this wallet's MINIMA
  const on = (c) => {
    let m;
    if ((m = /^txncreate id:(\w+)$/.exec(c))) { txns[m[1]] = { inputs: [], outputs: [], state: [] }; return null; }
    if ((m = /^txninput id:(\w+) coinid:(0x[0-9A-Fa-f]+)/.exec(c))) { txns[m[1]].inputs.push(coins()[m[2]]); return null; }
    if ((m = /^txnoutput id:(\w+) amount:(\S+) address:(\S+?)(?: tokenid:(\S+))?$/.exec(c))) { const tok = m[4] || "0x00"; txns[m[1]].outputs.push(Object.assign({ coinid: M.hex("out" + (++n), 64), address: m[3], tokenid: tok }, tok === "0x00" ? { amount: m[2] } : { amount: "0.000001", tokenamount: m[2] })); return null; }
    if ((m = /^txnlist id:(\w+)$/.exec(c))) return txns[m[1]] ? ok({ id: m[1], transaction: JSON.parse(JSON.stringify(txns[m[1]])) }) : { status: false, error: "Transaction not found : " + m[1] };
    if ((m = /^txnexport id:(\w+)$/.exec(c))) return ok({ data: "0xABCD" });
    if ((m = /^txndelete id:(\w+)$/.exec(c))) { delete txns[m[1]]; return null; }
    if (c === "scripts") return ok([{ address: M.ADDRESS, script: "RETURN SIGNEDBY(" + M.KEY + ")", publickey: M.KEY, simple: true },
      { address: MAKER, script: "RETURN SIGNEDBY(0x" + "B1".repeat(32) + ")", simple: true }, { address: ATTACKER, script: "RETURN SIGNEDBY(0x" + "B2".repeat(32) + ")", simple: true }]);   // makers' scripts a taker registered: in the list, not this wallet's
    return o.on ? o.on(c) : null;
  };
  const b = await boot({ node: { on } }); F = b.ctx.AX.fill;
  const order = Object.assign({ orderId: "0x" + "0F".repeat(16), side: "sell", price: "0.0031", amount: "250", coins: [MC], address: MAKER, scripts: [] }, o.order);
  b.ctx.__orders = [order]; vm.runInContext("RELAY.orders = function () { return __orders; }; RELAY.pollBook = function (h, cb) { cb(null, false, ''); };", b.ctx);
  const cmd = (command) => b.host.command({ op: "cmd", command });
  // the page's MDS, as renderer/dexicon/mds.js makes it: every command through the bridge
  // kvGet / kvSet (0.19.406: the 0.0.153 relock reads its backoff from kv): through the bridge's own SQL, as lib/mdsw.js does
  const sql = (q) => b.host.command({ op: "sql", query: q });
  const mds = { cmd: (c, cb) => { cmd(c).then(r => cb(r)); }, cmdR: (c, cb) => { cmd(c).then(r => (r && r.status ? cb(null, r.response, r) : cb(new Error((r && r.error) || "failed"), null, r))); },
    kvGet: (k, d, cb) => { sql("SELECT v FROM ax_kv WHERE k='" + k + "'").then(r => cb(r && r.status && r.rows.length ? String(r.rows[0].V) : d), () => cb(d)); },
    kvSet: (k, v, cb) => { sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '" + String(v).split("'").join("''") + "')").then(() => cb && cb(), () => cb && cb()); } };
  const take = (minima) => new Promise(res => { let p; try { p = F.plan(order, minima, [coins()[MC]], [coins()[UC]], M.ADDRESS); } catch (e) { return res({ err: e }); } F.build(mds, p, (err, hex) => res({ err, hex, plan: p })); });
  const signs = () => b.node.seen.filter(c => /^txnsign /.test(c)), posts = () => b.node.seen.filter(c => /^txnpost /.test(c));
  return Object.assign(b, { cmd, mds, take, signs, posts, order, review: (buy, price, amount) => b.host.command({ op: "reviewed", buy, price, amount }), txns });
}

test("M4: a take the page builds is signed only inside what the user reviewed: side, limit price and amount", async () => {
  const r = await frameRig();
  // nothing was reviewed: the engine's own, perfectly formed take is not signed
  let t = await r.take("100");
  assert.match(t.err.message, /Refused by the app's signing check: no FAST trade was reviewed on the Trade screen in the last ten minutes .*Nothing was signed/);
  assert.deepEqual(r.signs(), []);
  // reviewed: BUY up to 100 MINIMA, never above 0.0032
  assert.deepEqual(await r.review(true, "0.0032", "100"), { status: true });
  t = await r.take("60");
  assert.equal(t.err, null, String(t.err && t.err.message)); assert.equal(t.hex, "0xABCD");
  assert.equal(r.signs().length, 1); assert.match(r.signs()[0], new RegExp("^txnsign id:pgxdx\\w+ publickey:" + M.KEY + "$"), "the page's own command, under the page-only id prefix (CHANGED on purpose, 0.19.228)");
  assert.deepEqual(r.posts(), [], "a take is never posted by the page");
  // 40 are left of the review: 41 more is refused, 40 goes through, then nothing is left
  t = await r.take("41"); assert.match(t.err.message, /41 MINIMA is more than is left of the reviewed amount \(40\)/);
  t = await r.take("40"); assert.equal(t.err, null);
  t = await r.take("1"); assert.match(t.err.message, /more than is left of the reviewed amount \(0\)/);
  assert.equal(r.signs().length, 2);
  // a new review of the other side: a buy is no longer signed
  await r.review(false, "0.003", "100");
  t = await r.take("10"); assert.match(t.err.message, /not the coins of one live buy order the engine has read from the relays/);
  // the order's price is above the reviewed limit (an order at an absurd price is still "an order")
  const dear = await frameRig({ order: { price: "1000" } });
  await dear.review(true, "0.0032", "0.005");
  t = await dear.take("0.005"); assert.match(t.err.message, /at 1000 is outside the reviewed limit 0\.0032/);
  assert.deepEqual(dear.signs(), []);
  // a review that has lapsed
  const late = await frameRig(); await late.review(true, "0.0032", "100");
  const realNow = Date.now; Date.now = () => realNow() + 10 * 60000 + 1;
  try { t = await late.take("10"); } finally { Date.now = realNow; }
  assert.match(t.err.message, /no FAST trade was reviewed/);
});

test("M4: a script in the page cannot have a spend signed: not to an address of its choice, not above the order's price, not by posting, not on another transaction", async () => {
  const r = await frameRig(), F = r.ctx.AX.fill, USD = F.MXUSD;
  await r.review(true, "0.0032", "100");
  const refused = async (cmds, why) => { let last; for (const c of cmds) last = await r.cmd(c); assert.equal(last.status, false, cmds.join(" ; ")); assert.match(last.error, why, cmds.join(" ; ")); };
  // 1. this wallet's coin to an address of the attacker's choice
  await refused(["txncreate id:ev1", "txninput id:ev1 coinid:" + UC + " scriptmmr:true", "txnoutput id:ev1 amount:5 address:" + ATTACKER + " tokenid:" + USD, "txnsign id:ev1 publickey:auto"], /pays 0x(E7){32} and spends no coin of any order/i);
  // 2. dressed as a take of the real order, but the payment goes elsewhere
  await refused(["txncreate id:ev2", "txninput id:ev2 coinid:" + MC + " scriptmmr:true", "txninput id:ev2 coinid:" + UC + " scriptmmr:true", "txnoutput id:ev2 amount:100 address:" + M.ADDRESS, "txnoutput id:ev2 amount:200 address:" + MAKER_COIN_AT,
    "txnoutput id:ev2 amount:5 address:" + ATTACKER + " tokenid:" + USD, "txnsign id:ev2 publickey:" + M.KEY], /an output pays 0x(E7){32}, which is neither this wallet nor order/i);
  // 3. to the order's own address, but 5 MxUSD for 100 MINIMA at 0.0031 (0.31 is the price)
  await refused(["txncreate id:ev3", "txninput id:ev3 coinid:" + MC + " scriptmmr:true", "txninput id:ev3 coinid:" + UC + " scriptmmr:true", "txnoutput id:ev3 amount:100 address:" + M.ADDRESS, "txnoutput id:ev3 amount:200 address:" + MAKER_COIN_AT,
    "txnoutput id:ev3 amount:5 address:" + MAKER + " tokenid:" + USD, "txnsign id:ev3 publickey:" + M.KEY], /not at order 0x(0F){16}'s price 0\.0031: 100 MINIMA for 5 MxUSD/i);
  // 4. a third token, state, an address that is not a plain one
  await refused(["txncreate id:ev4", "txninput id:ev4 coinid:" + MINE2 + " scriptmmr:true", "txnoutput id:ev4 amount:7 address:" + M.ADDRESS + " tokenid:0x" + "99".repeat(32), "txnsign id:ev4 publickey:auto"], /neither MINIMA nor MxUSD/);
  // 5. a transaction the page did not create (another engine's, or one imported)
  await refused(["txnsign id:dmOther1 publickey:auto"], /transaction dmOther1 was not created by the page in this session/);
  await refused(["txnpost id:rlOther1"], /was not created by the page/);
  await assert.rejects(r.cmd("txnimport id:ev5 data:0xABCD"), /not available to Dexicon: txnimport/);
  // 6. any other spelling of a transaction command
  for (const c of ["txnoutput id:ev1 amount:1 address:" + M.ADDRESS + " storestate:false", "txninput id:ev1 coinid:" + UC + " scriptmmr:true address:" + ATTACKER, "txninput id:ev1 floating:true address:" + ATTACKER + " amount:1 tokenid:0x00",
    "txnoutput id:ev1 amount:1 address:MxG08ATTACKER", "txnsign id:ev1 publickey:auto mmrproofs:false", "txncreate id:../x"])
    await refused([c], /not one of the transaction commands the page builds a trade with/);
  // 7. posting a take; and a "void" that quietly burns
  const t = await r.take("10"); assert.equal(t.err, null);
  await refused(["txncreate id:ev7", "txninput id:ev7 coinid:" + MC + " scriptmmr:true", "txninput id:ev7 coinid:" + UC + " scriptmmr:true", "txnoutput id:ev7 amount:10 address:" + M.ADDRESS, "txnoutput id:ev7 amount:290 address:" + MAKER_COIN_AT,
    "txnoutput id:ev7 amount:0.031 address:" + MAKER + " tokenid:" + USD, "txnoutput id:ev7 amount:4.969 address:" + M.ADDRESS + " tokenid:" + USD, "txnpost id:ev7"], /the page posts only transactions that pay this wallet/);
  await refused(["txncreate id:ev8", "txninput id:ev8 coinid:" + MINE2 + " scriptmmr:true", "txnoutput id:ev8 amount:1 address:" + M.ADDRESS, "txnsign id:ev8 publickey:auto"], /not everything that goes in comes back to this wallet \(MINIMA: 7 in, 1 back\)/);
  assert.equal(r.signs().length, 1, "of all that, only the engine's own take was signed"); assert.deepEqual(r.posts(), []);
  // every refusal is in the log
  assert.ok(r.host.status().log.some(l => /REFUSED from the Dexicon page: `txnsign`/.test(l)));
});

test("M4: the page's void (the engine's own relock) is signed and posted without a review; a transaction cannot change between the check and the signature", async () => {
  const r = await frameRig(), F = r.ctx.AX.fill;
  const txpowid = await new Promise((res, rej) => r.ctx.AX.maker.relock(r.mds, [{ coinid: MINE2, address: M.ADDRESS, amount: "7", tokenid: "0x00" }], M.ADDRESS, (e, id) => (e ? rej(e) : res(id))));
  assert.match(txpowid, /^0x/); assert.equal(r.signs().length, 1); assert.equal(r.posts().length, 1);
  assert.match(r.signs()[0], /^txnsign id:pgxrl\w+ publickey:auto$/);   // under the page-only id prefix (CHANGED on purpose, 0.19.228)
  // an output added in the same breath as the signature waits for it: the node signs exactly what was checked
  await r.cmd("txncreate id:race1"); await r.cmd("txninput id:race1 coinid:" + MINE2 + " scriptmmr:true"); await r.cmd("txnoutput id:race1 amount:7 address:" + M.ADDRESS);
  r.node.seen.length = 0;
  const sign = r.cmd("txnsign id:race1 publickey:auto"), late = r.cmd("txnoutput id:race1 amount:1 address:" + ATTACKER);
  assert.equal((await sign).status, true); await late;
  const order = r.node.seen.filter(c => /^(txnlist|txnsign|txnoutput) /.test(c)).map(c => c.split(" ")[0]);
  assert.deepEqual(order, ["txnlist", "txnsign", "txnoutput"]);
  assert.match((await r.cmd("txnpost id:race1")).error, /the page posts only transactions that pay this wallet/, "and with the late output it is no longer posted");
});

test("M4: this wallet's addresses are its own keys' addresses; a maker's script the taker registered is not one", () => {
  const { ownAddresses, check } = require("../main/dexicon-signgate.js");
  const scripts = { status: true, response: [{ address: "0xAA" + "00".repeat(31), script: "RETURN SIGNEDBY(0x" + "11".repeat(32) + ")" }, { address: "0xBB" + "00".repeat(31), script: "RETURN SIGNEDBY(0x" + "22".repeat(32) + ")" },
    { address: "0xCC" + "00".repeat(31), script: "RETURN SIGNEDBY(0x" + "11".repeat(32) + ") AND TRUE" }] };
  const keys = { status: true, response: { keys: [{ publickey: "0x" + "11".repeat(32) }] } };
  assert.deepEqual([...ownAddresses(scripts, keys)], ["0xaa" + "00".repeat(31)]);
  assert.deepEqual([...ownAddresses(scripts, { status: false })], [], "no key list: nothing is this wallet's, so nothing is signed");
  assert.equal(check({ txn: { inputs: [], outputs: [] }, own: new Set(), orders: [], budget: null, now: 0, F: {} }).ok, false);
});

// 0.18.121: a call that names its engine is refused by any other engine (a page frame that outlived its engine)
test("a bridge call bound to an engine that has stopped is refused; the running engine's and an unbound one pass", async () => {
  const { host } = await boot(), e = host.status().epoch, q = "SELECT v FROM ax_kv WHERE k='relays'";
  assert.equal((await host.command({ op: "sql", query: q, epoch: e })).status, true);
  assert.equal((await host.command({ op: "sql", query: q })).status, true, "the native screens' reads carry no epoch");
  await assert.rejects(host.command({ op: "cmd", command: "txncreate id:old1", epoch: e - 1 }), /belongs to a Dexicon engine that has stopped\. Nothing was done\./);
  await assert.rejects(host.command({ op: "net", method: "POST", url: host.status().relays[0] + "/dex/msg", body: "{}", epoch: e + 5 }), /engine that has stopped/);
  assert.throws(() => host.checkEpoch({ op: "identity", epoch: e - 1 }), /engine that has stopped/, "the identity is not delivered to an old frame either (main.js)");
  await host.stop(); await host.start(); await M.until(() => host.status().ready);
  assert.notEqual(host.status().epoch, e);
  await assert.rejects(host.command({ op: "sql", query: q, epoch: e }), /engine that has stopped/, "after a restart the old frame's epoch is no longer the engine's");
  assert.match(fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), /dexicon\.checkEpoch\(a\); seed = await dexicon\.identitySeed\(\)/);
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
  return { id, file: a.host.storePath(), bytes: fs.readFileSync(a.host.storePath()) };
}
const legacy = (dir) => fs.readdirSync(dir).filter(f => /^dexicon(-0x[0-9a-f]{128})?\.sqlite-legacy-keys-\d{8}(-\d+)?$/.test(f));
/** The trading identity a seed gives (a host on a folder of its own). */
async function idOf(seed) { const x = await boot({ node: { seed } }), id = x.host.status().publicId; await x.host.stop(); return id; }
const storeOf = (dir, id) => path.join(dir, "dexicon-" + id + ".sqlite");

// 0.18.120 (M3): one store per wallet. Up to 0.18.119 there was one dexicon.sqlite, and a wallet that was not its
// owner had it moved aside: data folder A -> B -> A set A's store aside for good, and A's takes awaiting an answer
// were never voided.
test("M3: each wallet opens its own store and finds it again: A, then B, then A again holds A's orders and A's unanswered take", async () => {
  const dir = tmp();
  const a = await boot({ dir, node: { seed: "one" } }), idA = a.host.status().publicId;
  await sql(a.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([Object.assign(LIVE_ORDER(a.node.ADDRESS), { status: "cancelled" })]) + "')");
  await sql(a.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{\"0xAB\":{\"id\":\"0xAB\",\"sent\":" + Date.now() + "}}')");
  await a.host.stop();
  const bytesA = fs.readFileSync(storeOf(dir, idA));
  // the same app folder, a node on another data folder: wallet B
  const b = await boot({ dir, node: { seed: "two" } }), idB = b.host.status().publicId;
  assert.notEqual(idB, idA);
  assert.equal(b.host.storePath(), storeOf(dir, idB));
  assert.deepEqual(await sql(b.host, "SELECT k FROM ax_kv WHERE k IN ('myorders','pending_takes')"), [], "B starts on its own, empty store");
  assert.ok(fs.readFileSync(storeOf(dir, idA)).equals(bytesA), "A's store is where it was, byte for byte");
  assert.deepEqual(legacy(dir), [], "nothing is moved aside");
  assert.ok(!b.node.seen.some(c => c.includes("C0".repeat(32))), "nothing of A's reached B's node");
  await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('coin_max_age', '777')");
  await b.host.stop();
  // back to A
  const a2 = await boot({ dir, node: { seed: "one" } });
  assert.equal(a2.host.status().publicId, idA); assert.equal(a2.host.storePath(), storeOf(dir, idA));
  assert.equal(JSON.parse((await sql(a2.host, "SELECT v FROM ax_kv WHERE k='myorders'"))[0].V)[0].orderId, "0x" + "1".repeat(32), "A's orders are back");
  assert.equal((await a2.host.activeWork()).takes, 1, "A's take awaiting an answer is known again, so it can be voided");
  assert.deepEqual(await sql(a2.host, "SELECT v FROM ax_kv WHERE k='coin_max_age' AND v='777'"), [], "and nothing of B's is in it");
  assert.deepEqual(fs.readdirSync(dir).filter(f => /sqlite$/.test(f)).sort(), [path.basename(storeOf(dir, idA)), path.basename(storeOf(dir, idB))].sort());
  await a2.host.stop();
});

test("M3: a dexicon.sqlite from before is renamed once to its owner's name, whoever is running: another wallet does not open it, its own wallet finds it", async () => {
  const dir = tmp(), old = await oldWalletStore(dir);
  fs.renameSync(old.file, path.join(dir, "dexicon.sqlite"));   // an install from before 0.18.120, last used by wallet one
  const logs = [], node = M.mockNode({ seed: "two" }), net = M.mockNet();
  const host = makeHost({ runner: node.run, dataDir: dir, net, tickMs: 40, quiet: true }); node.attach(host); hosts.push(host);
  host.emitter.on("log", l => logs.push(l));
  await host.start(); await M.until(() => host.status().ready && host.status().restingReady);
  const idB = host.status().publicId;
  assert.ok(!fs.existsSync(path.join(dir, "dexicon.sqlite")), "the old name is gone");
  assert.ok(fs.readFileSync(storeOf(dir, old.id)).equals(old.bytes), "it is its owner's store now, byte for byte");
  assert.ok(logs.some(l => l.includes(storeOf(dir, old.id)) && l.includes(old.id) && l.includes(idB)), "said, both identities whole:\n" + logs.join("\n"));
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k IN ('myorders','mm_config')"), [], "wallet two does not trade wallet one's orders");
  await new Promise(r => setTimeout(r, 300));   // several ticks, a maker refresh among them
  assert.ok(!net.calls.some(c => /^POST .*\/dex\/publish/.test(c))); assert.ok(!node.seen.some(c => /^(txn|send)/.test(c) || c.includes("C0".repeat(32))), "no transaction over the old order's coins");
  await host.stop();
  const one = await boot({ dir, node: { seed: "one" } });
  assert.equal(JSON.parse((await sql(one.host, "SELECT v FROM ax_kv WHERE k='myorders'"))[0].V)[0].orderId, "0x" + "1".repeat(32), "wallet one finds its store");
  await one.host.stop();
  // its own wallet first: simply renamed. A store that records no identity (never READY) becomes this wallet's. Never over an existing store.
  const dir2 = tmp(), old2 = await oldWalletStore(dir2);
  fs.renameSync(old2.file, path.join(dir2, "dexicon.sqlite"));
  const same = await boot({ dir: dir2, node: { seed: "one" } });
  assert.equal(same.host.storePath(), storeOf(dir2, old2.id)); assert.equal((await sql(same.host, "SELECT v FROM ax_kv WHERE k='myorders'")).length, 1);
  await same.host.stop();
  fs.copyFileSync(storeOf(dir2, old2.id), path.join(dir2, "dexicon.sqlite"));   // an old file AND this wallet's store: the old one is kept aside, not written over
  const both = await boot({ dir: dir2, node: { seed: "one" } });
  assert.ok(!fs.existsSync(path.join(dir2, "dexicon.sqlite"))); assert.equal(fs.readdirSync(dir2).filter(f => /^dexicon\.sqlite-legacy-keys-\d{8}$/.test(f)).length, 1);
  await both.host.stop();
});

// 0.18.106 (HIGH), still held: a store that records ANOTHER identity than the wallet it is opened for (now: a file
// under this wallet's name with another wallet's records in it) is never traded on.
test("a store under this wallet's name that records another identity: the engine does not go READY on it; it is moved aside and starts clean", async () => {
  const dir = tmp(), old = await oldWalletStore(dir), idB = await idOf("two");
  fs.renameSync(old.file, storeOf(dir, idB));
  assert.deepEqual(legacy(dir), []);
  const node = M.mockNode({ seed: "two" }), net = M.mockNet(), logs = [];
  const host = makeHost({ runner: node.run, dataDir: dir, net, tickMs: 40, quiet: true }); node.attach(host); hosts.push(host);
  host.emitter.on("log", l => logs.push(l));
  await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  assert.equal(host.status().publicId, idB);
  const kept = legacy(dir);
  assert.equal(kept.length, 1, "moved aside under its dated name");
  assert.ok(fs.readFileSync(path.join(dir, kept[0])).equals(old.bytes), "byte for byte: never deleted, never written to by the new wallet");
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k IN ('myorders','mm_config')"), [], "the old store's orders and ladder are not carried over");
  assert.deepEqual((await sql(host, "SELECT v FROM ax_kv WHERE k='publicId'")).map(r => r.V), [idB]);
  assert.ok(logs.some(l => l.includes("NOT STARTING on this store") && l.includes(old.id) && l.includes(idB)), "said loudly, both identities in full:\n" + logs.join("\n"));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!net.calls.some(c => /^POST .*\/dex\/publish/.test(c)), "no order was published");
  assert.ok(!node.seen.some(c => /^(txn|send)/.test(c) || c.includes("C0".repeat(32))), "no transaction was built over the old order's coins");
  assert.equal(host.status().problem, "");
  await host.stop();
  const again = await boot({ dir, node: { seed: "two" } });
  assert.equal(again.host.status().publicId, idB); assert.equal(legacy(dir).length, 1, "a restart on the same wallet moves nothing aside");
});

test("the old store cannot be moved aside: the engine does not start on it, says why, and starts clean once it can", async () => {
  if (process.getuid && process.getuid() === 0) return;   // root ignores the folder permission this test uses
  // (1) found at boot by the identity check
  const dir = tmp(), old = await oldWalletStore(dir), idB = await idOf("two"), wrong = storeOf(dir, idB);
  fs.renameSync(old.file, wrong);   // wallet one's records under wallet two's name
  const node = M.mockNode({ seed: "two" }), net = M.mockNet();
  const host = makeHost({ runner: node.run, dataDir: dir, net, tickMs: 40, quiet: true }); node.attach(host); hosts.push(host);
  fs.chmodSync(dir, 0o555);   // rename out of this folder now fails
  try {
    await host.start();
    await M.until(() => host.status().problem !== "");
    assert.match(host.status().problem, /could not be moved aside .*so Dexicon is not running: it must not trade on another wallet's records/);
    assert.ok(host.status().problem.includes(wrong), "the file is named in full");
    const n = node.seen.length;
    await new Promise(r => setTimeout(r, 300));   // seven ticks of retrying
    assert.equal(host.status().ready, false); assert.equal(host._ctx(), null, "no engine exists on that store");
    assert.equal(node.seen.length, n, "and nothing more is asked of the node");
    assert.ok(!net.calls.some(c => /^POST/.test(c)));
    assert.ok(fs.readFileSync(wrong).equals(old.bytes), "the store itself is untouched");
  } finally { fs.chmodSync(dir, 0o755); }
  await M.until(() => host.status().ready && host.status().restingReady);   // by itself, at the next tick
  assert.equal(host.status().problem, ""); assert.equal(legacy(dir).length, 1);
  assert.deepEqual(await sql(host, "SELECT k FROM ax_kv WHERE k='myorders'"), []);
  // (2) the same when the main process's own invalidate() cannot move it: it throws, stays owed, and no later start opens the store
  const dir2 = tmp(), old2 = await oldWalletStore(dir2);
  fs.renameSync(old2.file, path.join(dir2, "dexicon.sqlite"));   // a host that has opened nothing yet knows only the old single name
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
  await first.host.stop();
  assert.ok(was.ax_kv.length >= 8 && was.pp_posted_inputs.length === 1 && was.my_coins.length === 1);
  // the COPY: another folder, another host, as after an app restart or a move to this app
  const dir2 = tmp();
  fs.copyFileSync(first.host.storePath(), path.join(dir2, path.basename(first.host.storePath())));
  const second = await boot({ dir: dir2 });
  await new Promise(r => setTimeout(r, 500));   // a dozen service ticks over it: ladder pass, void sweep, settle, block refresh
  assert.equal(second.host.status().relays[0], "https://relay.example/dex-relay", "the user's relay list is the one in use");
  assert.deepEqual(await dump(second.host, VOLATILE), was, "every table, every row, as it was");
  await second.host.stop();
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
  assert.deepEqual(await host.activeWork(), { ready: true, orders: [], pending: 0, takes: 0, unknown: 0 });
  assert.deepEqual(list(await host.activeWork()), []);
  assert.deepEqual(list(undefined), [], "a caller that does not ask Dexicon is unchanged");
  assert.match(list(null)[0], /^Dexicon could not be asked/);
  assert.match(list({ ready: false, hasStore: true })[0], /has not finished starting/);
  assert.deepEqual(list({ ready: false, hasStore: false }), [], "never used: nothing to lose");
  const coin = "0x" + "AB".repeat(32);
  vm.runInContext(`PDService.book = [{ coinid: "${coin}", orderId: "0x01", ownerPk: PDService.identity.publickey, wantAddr: PDService.identity.address, sell: true, price: PandaDEX.d("0.01"), minima: PandaDEX.d("5"), created: PDService.block, fillable: true }]`, ctx);
  await sql(host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{\"t1\":{\"sent\":1,\"mine\":[]}}')");
  const w = await host.activeWork();
  assert.deepEqual(w, { ready: true, orders: [coin], pending: 0, takes: 1, unknown: 0 });
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
    const self = { coinid: "0x" + "5E".repeat(32), address: M.ADDRESS, amount: "5", tokenid: "0x00" };   // a void: the page's own coin back to its own address
    const { host, ctx } = await boot({ wrap: queued, node: { on: (c) => (c === "txnlist id:pgxthird" ? { status: true, pending: false, response: { id: "pgxthird", transaction: { inputs: [self], outputs: [self], state: [] } } } : null) } });   // the page-only id at the node (0.19.228)
    assert.equal((await host.command({ op: "cmd", command: "txncreate id:third" })).status, true);
    const mds = ctx.AX.mds, ask = (c) => new Promise(res => mds.cmd(c, res));
    const first = ask("txnsign id:first publickey:auto");          // at the node, signing
    await M.until(() => atNode.length === 1);
    const second = ask("txnsign id:second publickey:auto");        // from the engine: waits its turn in the queue
    const third = host.command({ op: "cmd", command: "txnsign id:third publickey:auto" });   // from the page's bridge (it passed the signing check): queued too
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
  const base = M.mockNet(), held = [], sent = [], sentAt = [], opts = []; let most = 0;   // sentAt: when each POST reached the network (0.19.364)
  return { calls: base.calls, held, sent, sentAt, opts, most: () => most,
    fetchJson: (url, o) => { opts.push(o); return base.fetchJson(url, o); },
    postText: (url, body, o) => { opts.push(o); sent.push(body); sentAt.push(Date.now()); return new Promise(res => { const h = { url, body, done: () => { held.splice(held.indexOf(h), 1); res('{"ok":true}'); } }; held.push(h); most = Math.max(most, held.length); }); },
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
  // 0.19.363: the lanes' order is tested on a host whose own limit is the app's (30 s), and the limit itself on a second host with 400 ms. With
  // 400 ms for the whole test, a busy machine took longer than that between holding low0 and low1 and letting them go: the host's limit then
  // freed their places (as it should), the order and the take went out beside them, and the stand-in network counted 4 at once ("4 !== 2" at
  // net.most(), 3 of 30 runs with two copies of the suite at once). The lanes never had more than 2 of their own requests out.
  let net = slowNet();
  let { host, ctx } = await boot({ net });
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
  // changed on purpose (0.19.348): the engine's own periodic read may queue behind the two held posts (35 then); what matters is that the
  // order and the take wait and nothing more was dropped
  // bounded above too (0.19.357): 32 refusals + the order + the take, and at most the engine's one periodic read; never more
  const ww = host._lanes().workWaiting; assert.ok(ww >= 34 && ww <= 35, "not dropped although 32 refusals wait, and nothing else queued (" + ww + " waiting)"); assert.equal(host._lanes().dropped, 6, "no refusal dropped for them");
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
  // a request that never settles (netfetch gives up after 20 s by itself; the host's own limit is the backstop): a host whose limit is 400 ms
  net = slowNet(); ({ host, ctx } = await boot({ net, netLimitMs: 400 })); vm.runInContext("globalThis.__done = []", ctx);
  post("stuck1", false); post("stuck2", false); post("after", false);
  // 0.19.365: at least the two stuck ones (exactly 2 holds only until the limit frees a place and "after" goes out: a poll starved past those
  // 400 ms on a busy machine never saw 2, and timed out)
  await M.until(() => net.held.length >= 2 && net.sent.includes("stuck1") && net.sent.includes("stuck2"));
  await M.until(() => net.sent.includes("after"));
  // 0.19.364: timed by when each reached the network, not by when this test's 15 ms poll saw it (on a busy machine the poll saw the two held
  // ones late, and "after" seemed to follow them in less than 300 ms although the host's limit had run its full 400 ms)
  const at = (b) => net.sentAt[net.sent.indexOf(b)];
  assert.ok(at("after") - Math.min(at("stuck1"), at("stuck2")) >= 300, "after the limit, not before (" + (at("after") - at("stuck1")) + " ms)");
  assert.ok(done().some(d => d[0] === "stuck1" && d[1] === false), "and its caller is told it failed");
  net.held.slice().forEach(h => h.done());
});

// ---- 0.18.110: the LOW findings ----
test("the screens' SQL is an allow-list: the page's own statements on ax_kv and one read of fill_state, nothing else", async () => {
  const { host } = await boot();
  const logs = []; host.emitter.on("log", l => logs.push(l));
  const run = (query) => host.command({ op: "sql", query });
  // every statement the page and the native screens issue (lib/mdsw.js kvInit/kvGet/kvSet/kvDel, ui/app.js, ui/activity.js, renderer/dexicon-ui.js load)
  const mdsw = fs.readFileSync(path.join(M.root, "main/dexicon/lib/mdsw.js"), "utf8"), ui = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(M.root, "renderer/dexicon-ui.js"), "utf8"));
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
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(M.root, "renderer/app.js"), "utf8"));
  assert.ok(main.includes("if (!restore.onlyDexiconUnchecked(list)) throw new Error(") && main.includes("dexSkipUntil = Date.now() + 120000;") && main.includes("const list = await walletWork(false);"));
  assert.ok(/async function offerWithoutDexicon\(e, importing\) \{[\s\S]*?showConfirm\(dexOnly \? "Go on without checking Dexicon\?" : [^\n]*?, warning, dexOnly \? "Go on without the check" : [^\n]*?, true\)[\s\S]*?await api\.dxSkipCheck\(\)/.test(app), "the screen warns first, then asks main");
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
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), pre = fs.readFileSync(path.join(M.root, "main/preload.js"), "utf8"), app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(M.root, "renderer/app.js"), "utf8"));
  assert.ok(main.includes('node.on("status", (s) => { if (s.state === "running") dexicon.start(); else dexicon.stop(); });'), "only a running node (wallet made, key-mode gate passed) starts it");
  assert.ok(main.includes('ipcMain.handle("mcd:dxCommand", async (e, a) => {') && main.includes("  return dexicon.command(a);\n});"));
  assert.ok(/const inFlightWork = async \(\) => \{[\s\S]{0,900}one\(\(\) => dexicon\.activeWork\(\)\)/.test(main) && /api\.inFlight\("shutdown", action\)/.test(app), "the Shutdown and Quit warnings ask for takes awaiting an answer; a failed read is null (0.18.142: main/inflight.js)");   // the window widened to 900 on purpose (0.19.334: one() clears its timer, a longer line)
  // 0.18.106: the reset is the main process's, inside the resync itself; no window can ask for it, none is needed for it
  assert.ok(!/dxInvalidate/.test(main.replace(/\/\/.*$/gm, "")) && !/dxInvalidate/.test(pre) && !/dxInvalidate/.test(app), "no renderer IPC moves the store");
  const hook = main.slice(main.indexOf("node.onWalletReplaced = async () => {"), main.indexOf("// Restore from a backup FILE"));
  for (const call of ["mail.invalidateIdentity()", "pandapools.invalidate()", "atomix.invalidate()", "dexicon.invalidate({ hold: true })", "casino.invalidate()"]) assert.ok(hook.includes(call), "the main-process reset: " + call);
  assert.ok(!/api\.\w*Invalidate\(/.test(app), "the renderer's chain only clears the screen");
  assert.ok(main.includes("dexicon: await dexicon.activeWork().catch(() => null), skipDexicon });"), "a failed read is null, which refuses");
  assert.ok(/try \{ dexicon\.flush\(\); \} catch \(err\) \{\}/.test(main));
  for (const f of ["dxStatus", "dxBook", "dxMine", "dxCommand", "inFlight", "onDexicon"]) assert.ok(pre.includes("  " + f + ": "), "preload: " + f);
  const host = fs.readFileSync(path.join(M.root, "main/dexicon.js"), "utf8");
  assert.ok(!/require\("(http|https|net|child_process)"\)/.test(host), "the host opens no socket of its own");
  assert.equal((host.match(/rpcCall\(/g) || []).length, 1, "one way to the node: rpcCall");
  const code = host.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // comments name what was left behind; the code must not hold it
  // "MAKER_" and "mxusd_tokenid" are named since 0.19.231 by the guard that keeps the page from steering the engine, not ported
  for (const gone of ["DX_GATE", "RELAY_HOSTS", "pauseAll", "Mandate", "setPrice", "setGate"]) assert.ok(!code.includes(gone), "DexiconPro-only part not ported: " + gone);
});

test("coin holds: the coins of live FAST orders and of unanswered takes are mirrored into the shared reservation, from the engine's own records", async () => {
  const { createRegistry } = require("../main/reserve.js");
  const reg = createRegistry(), node = M.mockNode(), dir = tmp();
  const host = makeHost({ runner: node.run, dataDir: dir, net: M.mockNet(), tickMs: 40, quiet: true, reserve: reg });
  node.attach(host); hosts.push(host);
  assert.equal(host.coinHolds(), null, "no store yet: it cannot be said, and nothing is changed");
  await host.start();
  await M.until(() => host.status().ready && host.status().restingReady);
  const C = (n) => "0x" + String(n).repeat(64).slice(0, 64), soon = Math.floor(Date.now() / 1000) + 3600;
  const orders = [{ orderId: "o1", side: "sell", status: "live", coins: [C(1), C(2)], expiry: soon }, { orderId: "o2", side: "buy", status: "cancelled", coins: [C(3)], expiry: soon },
    { orderId: "o3", side: "buy", status: "live", coins: [C(4)], expiry: 1 }, { orderId: "o4", status: "live", coins: ["not a coin"], expiry: soon }];
  // the engine's own write (lib/mdsw.js kvSet), through the engine's MDS.sql
  await new Promise(res => host._ctx().MDS.sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify(orders) + "')", res));
  let held = reg.list();
  assert.deepEqual(held.map(h => [h.coinid, h.owner, h.why, h.state]), [[C(1), "dexicon", "a live Dexicon order", "held"], [C(2), "dexicon", "a live Dexicon order", "held"]], "live and not expired only; ids whole");
  assert.equal(reg.foreign("atomix", C(1)).why, "a live Dexicon order"); assert.equal(reg.foreign("dexicon", C(1)), null);
  // the page's take, through the screens' bridge (ui/app.js savePending)
  await host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '" + JSON.stringify({ o9: { sent: Date.now(), mine: [C(5)] } }) + "')" });
  assert.equal(reg.foreign("wallet", C(5)).why, "a Dexicon take that has not been answered yet");
  await host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('void_takes', '" + JSON.stringify({ o8: { mine: [C(6)], act: "" } }) + "')" });
  await host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('pending_takes', '{}')" });
  assert.equal(reg.foreign("wallet", C(5)), null, "answered: free");
  assert.equal(reg.foreign("wallet", C(6)).why, "a Dexicon take that is being voided");
  // cancelled: the engine rewrites the list, the coins are free at once
  orders[0].status = "cancelled";
  await new Promise(res => host._ctx().MDS.sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify(orders) + "')", res));
  assert.deepEqual(reg.list().map(h => h.coinid), [C(6)]);
  // the engine stopped: its holds stay (the order is still on the relays), and the source says "cannot say" rather than "none"
  orders[0].status = "live";
  await new Promise(res => host._ctx().MDS.sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify(orders) + "')", res));
  await host.stop();
  assert.equal(host.coinHolds(), null);
  assert.deepEqual(reg.list().map(h => h.coinid).sort(), [C(1), C(2), C(6)].sort());
  // no engine file was touched to do this
  const src = fs.readFileSync(path.join(M.root, "main/dexicon.js"), "utf8");
  assert.match(src, /const host = makeHost\(\{ appHost: true \}\)/, "the app's host mirrors into the app's registry");
  assert.match(fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), /reserve\.setHoldSource\("dexicon", \(\) => dexicon\.coinHolds\(\)\)/);
});

test("no test reached a real node or the real network", () => {
  assert.deepEqual(M.leaks, []);
});

// 0.19.193: the bridge reads the verb and the parameter names as the node does (main/cmdverb.js)
test("the Dexicon bridge: a quoted or ':'-spaced forbidden parameter, a verb read two ways, or seedrandom in any spelling is refused", () => {
  for (const [c, re] of [['txnexport id:a "file":/tmp/x', /that parameter/], ["txnexport id:a file : /tmp/x", /that parameter/], ['txnsign id:a "privatekey":0x01', /that parameter/],
    ['txnpost id:a "burn":1', /that parameter/], ["txnpost id:a mine : true", /that parameter/], ['"seedrandom" modifier:x', /not read through this bridge/],
    ['se"edran"dom modifier:x', /not read through this bridge/], ['ba"lan"ce', /not available to Dexicon/], ['"vault"', /not available to Dexicon/], ["send amount:1 address:0x01", /not available to Dexicon/]])
    assert.throws(() => dexCommand(c), re, c);
  assert.equal(dexCommand('"balance"'), '"balance"', "a quoted allowed verb is the same command to the node");
  assert.equal(dexCommand("coins relevant:true"), "coins relevant:true");
});

// 0.19.228: the frame's transaction ids are page-only at the node, and registered only once the node created them
test("the page's transactions live under a page-only id: a refused txncreate registers nothing, and the page can never name another engine's transaction", async () => {
  let refuseCreate = true;
  const { host, node } = await boot({ node: { on: (c) => (c === "txncreate id:pgxdup1" && refuseCreate ? { status: false, error: "txn already exists" } : null) } });
  const cmd = (command) => host.command({ op: "cmd", command });
  assert.equal((await cmd("txncreate id:dup1")).status, false, "the node refused it");
  const r = await cmd("txninput id:dup1 coinid:0x" + "AB".repeat(32) + " scriptmmr:true");
  assert.equal(r.status, false); assert.match(r.error, /was not created by the page in this session/, "a refused id is not the page's");
  assert.match((await cmd("txndelete id:dup1")).error, /was not created by the page/);
  // the engine's ladder split, maker relock, Vestr collect: the page's same id goes to its own prefix, never to theirs
  for (const theirs of ["sp1k2j3", "rlabc123", "vc99zz"]) {
    refuseCreate = false;
    assert.equal((await cmd("txncreate id:" + theirs)).status, true);
    await cmd("txndelete id:" + theirs);
  }
  const atNode = node.seen.filter(c => /^txn(create|input|delete)/.test(c));
  assert.ok(atNode.length && atNode.every(c => / id:pgx/.test(c)), "every frame transaction at the node is pgx-prefixed: " + JSON.stringify(atNode));
  assert.ok(!node.seen.some(c => / id:(sp1k2j3|rlabc123|vc99zz)\b/.test(c)), "never the engine's own ids");
});

// 0.19.231: what the page may make the engine sign, and the keys that steer it, need the user's confirmation in the app's own window
test("the page cannot make the engine sign or steer it without the native window: LIMIT / EDIT need a recorded intent, the rest a main-process question; cancels pass", async () => {
  const asked = []; let answer = false;
  const { host } = await boot({ confirm: async (title, detail) => { asked.push(title + " | " + detail); return answer; } });
  const comms = (origin, type, data) => host.command({ op: "comms", message: JSON.stringify({ origin, type, data }) });
  const limit = { buy: true, minima: "100", price: "0.003", minRem: "0" };
  await assert.rejects(comms("ui", "LIMIT", limit), /not confirmed in the app's own window/, "no intent: refused");
  await host.command({ op: "intent", type: "LIMIT", buy: true, price: "0.0030", amount: "100" });
  await assert.rejects(comms("ui", "LIMIT", Object.assign({}, limit, { minima: "1000" })), /not confirmed/, "another amount than the one confirmed");
  await assert.rejects(comms("ui", "LIMIT", Object.assign({}, limit, { buy: false })), /not confirmed/, "the other side");
  assert.deepEqual(await comms("ui", "LIMIT", limit), { status: true }, "the confirmed one, once");
  await assert.rejects(comms("ui", "LIMIT", limit), /not confirmed/, "an intent is used once");
  const coin = "0x" + "AB".repeat(32);
  await host.command({ op: "intent", type: "EDIT", coinid: coin, price: "0.004" });
  await assert.rejects(comms("ui", "EDIT", { coinid: coin, price: "0.005" }), /not confirmed/);
  for (const [o, t, d] of [["ui", "SPLIT", { tokenid: "0x00", amount: "5" }], ["ui", "MAKER_PUBLISH", {}], ["dexicon", "CONSOLIDATE", { tokenid: "0x00" }], ["dexicon", "LADDER", {}], ["dexicon", "CROSS_REVIEW", { release: "cross" }]])
    await assert.rejects(comms(o, t, d), /not confirmed/, t + ": the question was answered no");
  assert.equal(asked.length, 5, "each was asked about, by name"); assert.ok(asked[0].includes("SPLIT"));
  for (const [o, t, d] of [["ui", "CANCEL", { coinid: coin }], ["ui", "CANCEL_ALL", {}], ["ui", "MAKER_WITHDRAW", {}], ["ui", "REFRESH", {}], ["dexicon", "CROSS_REVIEW", {}]])
    assert.deepEqual(await comms(o, t, d), { status: true }, t + " moves nothing to anyone else");
  // writes that steer the engine
  const merge = (k, v) => host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '" + v + "')" });
  asked.length = 0;
  await assert.rejects(merge("mm_config", JSON.stringify({ enabled: true, levels: 6 })), /not confirmed/);
  await assert.rejects(merge("relays", JSON.stringify(["https://evil.example"])), /not confirmed/);
  await assert.rejects(merge("mxusd_tokenid", "0x" + "EE".repeat(32)), /not confirmed/);
  assert.equal(asked.length, 3); assert.ok(asked[1].includes("https://evil.example"), "the question shows the value whole");
  await merge("mm_config", JSON.stringify({ enabled: false }));   // a stopped maker signs nothing: no question
  await host.command({ op: "intent", type: "KV", key: "relays" });
  await merge("relays", JSON.stringify(["https://relay.example"]));   // the native Settings screen's own change
  answer = true; await merge("mm_config", JSON.stringify({ enabled: true, levels: 6 })); assert.deepEqual(await comms("dexicon", "LADDER", {}), { status: true }, "its wake-up goes with it");
  await assert.rejects(host.command({ op: "intent", type: "LIMIT", buy: true, price: "1", amount: "1", epoch: host.status().epoch }), /bad intent/, "the frame's calls (they carry an epoch) cannot record one");
});

// ---- 0.19.242: a cycle the watchdog gave up on that ends late does not clear the guard of the cycle running now ----
test("the tick guard: a stuck cycle's late end leaves the new cycle's guard set; only the current cycle clears it", () => {
  const vm = require("vm"), src = fs.readFileSync(path.join(M.root, "main/dexicon/service.desktop.js"), "utf8");
  const at = src.indexOf("function tick(done) {"); let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  const held = [], ctx = { READY: true, ticks: 0, now: 1000, logged: [], RELAY: { relays: [] }, held,
    loadRelays: (cb) => held.push(cb), log: (m) => ctx.logged.push(m), logOnce() {}, voidSweep() {}, Date: { now: () => ctx.now } };
  vm.createContext(ctx);
  vm.runInContext(src.match(/^var TICKING = .*$/m)[0] + "\n" + src.slice(at, i + 1) + "\nthis.tick = tick; this.guard = () => TICKING;", ctx);
  let dones = 0; const done = () => dones++;
  ctx.tick(done); assert.equal(ctx.guard(), true); assert.equal(held.length, 1);
  ctx.tick(done); assert.equal(held.length, 1, "a second tick inside the watchdog window does not start"); assert.equal(dones, 1);
  ctx.now += 120001; ctx.tick(done); assert.equal(held.length, 2, "past the watchdog a new cycle starts"); assert.match(ctx.logged.join(), /tick watchdog/);
  held[0](); assert.equal(ctx.guard(), true, "the stuck cycle ending late does not clear the running cycle's guard");
  ctx.tick(done); assert.equal(held.length, 2, "so no third cycle overlaps the second");
  held[1](); assert.equal(ctx.guard(), false, "the running cycle clears it"); assert.equal(dones, 4, "done once per call on every path");
});

test("0.19.373: a start of the on-chain engine that ends in its ERROR is logged (node log too) with the engine's words, is the reason in status() and on STATE, and is retried until it works", async () => {
  let refuse = true;
  const node = M.mockNode({ on: (c) => (refuse && /^newscript trackall:false/.test(c) ? { status: false, error: "mock: newscript refused" } : null) });
  const host = makeHost({ runner: node.run, dataDir: tmp(), net: M.mockNet(), tickMs: 40, quiet: true, confirm: async () => true });
  node.attach(host); hosts.push(host);
  const nodeLog = [], states = [];
  host.emitter.on("nodelog", l => nodeLog.push(l));
  host.emitter.on("comms", m => { const p = JSON.parse(m); if (p.type === "STATE") states.push(p.data); });
  await host.start();
  await M.until(() => host.status().ready && host.status().restingWhy);
  const s = host.status();
  assert.equal(s.restingReady, false); assert.equal(s.restingWhy, "mock: newscript refused", "the engine's own message");
  assert.deepEqual(nodeLog, ["on-chain engine not ready: mock: newscript refused (its start is tried again every minute; FAST trading is not affected)"]);
  await M.until(() => states.some(d => d.restingWhy === "mock: newscript refused" && d.ready === false));
  assert.ok(host.status().log.some(l => /on-chain engine not ready: mock: newscript refused/.test(l)));
  // the next try (once a minute; the test does not wait the minute) succeeds: ready, and no reason any more
  refuse = false; vm.runInContext("lastPdBootMs = 0", host._ctx());
  await M.until(() => host.status().restingReady);
  assert.equal(host.status().restingWhy, "");
  await M.until(() => states.length && states[states.length - 1].ready === true && states[states.length - 1].restingWhy === "");
  assert.equal(nodeLog.length, 1, "logged once, not once a minute");
  assert.match(fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), /\ndexicon\.emitter\.on\("nodelog", \(line\) => node\.log\("\[dexicon\] " \+ line\)\);/, "main.js writes those lines to the node log");
  host.stop();
});

// ---- 0.19.406: Dexicon engine 0.0.153 (cefb6caf9fc6ac15e87ef39bb8597096d39d556f) ----
const { dexSql } = require("../main/dexicon.js");
test("0.19.406 allow-lists: the proof hand-over's three commands in their exact shapes, MegaMMR lookups, the store lock's and the fenced save's eight SQL shapes; nothing near them", () => {
  const H = "0x" + "AB".repeat(32), PROOF = "0x" + "0".repeat(144), TOK = "w" + "mfx3k2a1".repeat(2) + ".12";
  for (const c of ["coinexport coinid:" + H, "coinimport data:" + PROOF + " track:false", "coinimport data:0x" + "a".repeat(15998) + " track:false",
    "verify publickey:" + H + " data:" + H + " signature:0x" + "cd".repeat(100), "coins coinid:" + H + " megammr:true checkmempool:true", "coins coinid:" + H + " megammr:true"]) assert.equal(dexCommand(c), c, c);
  for (const [c, why] of [["coinexport coinid:" + H + " file:x.bin", /only exporting one coin's proof/], ["coinexport coinid:0x01", /only exporting/],
    ["coinimport data:" + PROOF + " track:true", /only an untracked coin proof import/], ["coinimport data:" + PROOF, /untracked/], ["coinimport data:0x" + "a".repeat(15999) + " track:false", /untracked/],
    ["coinimport data:0x" + "a".repeat(142) + " track:false", /untracked/], ["verify publickey:" + H + " data:" + H + " signature:0x" + "a".repeat(16000), /only checking one coin-key attestation/],
    ["sign data:" + H + " publickey:" + H, /not available to Dexicon: sign/], ["cointrack enable:false coinid:" + H, /not available to Dexicon: cointrack/], ["cointrack enable:true coinid:" + H, /cointrack/]])
    assert.throws(() => dexCommand(c), why, c);
  const ok = ["CREATE TABLE IF NOT EXISTS `dx_lock` (`id` varchar(32) NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)",
    "INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT 'myorders','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='myorders')",
    "INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT 'coinimport','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='coinimport')",
    "UPDATE `dx_lock` SET `owner`='" + TOK + "', `ts`=1763900000000 WHERE `id`='myorders' AND (`owner`='' OR `owner` IS NULL OR `owner`='')",
    "UPDATE `dx_lock` SET `owner`='" + TOK + "', `ts`=1763900000000 WHERE `id`='coinimport' AND (`owner`='' OR `owner` IS NULL OR `owner`='w1.2')",
    "UPDATE `dx_lock` SET `owner`='' WHERE `id`='myorders' AND `owner`='" + TOK + "'",
    "SELECT `owner` FROM `dx_lock` WHERE `id`='coinimport'",
    "INSERT INTO ax_kv (k, v) SELECT 'myorders', '[]' WHERE NOT EXISTS (SELECT 1 FROM ax_kv WHERE k='myorders')",
    "UPDATE ax_kv SET v='[{\"note\":\"it''s\"}]' WHERE k='myorders' AND EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='myorders' AND `owner`='" + TOK + "')",
    "SELECT v FROM ax_kv WHERE k='myorders'", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('fill_" + H + "', '{\"role\":\"taker\",\"filled\":\"5\"}')"];
  for (const q of ok) assert.equal(dexSql(q), q, q);
  const no = ["DELETE FROM `dx_lock`", "DROP TABLE `dx_lock`", "UPDATE `dx_lock` SET `owner`='' WHERE `id`='myorders'",
    "INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT 'other','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='other')",
    "INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT 'myorders','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='coinimport')",
    "UPDATE `dx_lock` SET `owner`='bad token!', `ts`=1 WHERE `id`='myorders' AND (`owner`='' OR `owner` IS NULL OR `owner`='')",
    "UPDATE `dx_lock` SET `owner`='" + TOK + "', `ts`=1 WHERE `id`='myorders' AND `ts` < 5",
    "UPDATE ax_kv SET v='[]' WHERE k='relays' AND EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='myorders' AND `owner`='" + TOK + "')",
    "UPDATE ax_kv SET v='[]' WHERE k='myorders'",
    "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '[]')", "DELETE FROM ax_kv WHERE k='myorders'",
    "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('fill_" + H + "', '{\"role\":\"maker\",\"filled\":\"-50\",\"txpowid\":\"" + H + "\"}')", "DELETE FROM ax_kv WHERE k='fill_" + H + "'",
    "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('attest_sign', '1')", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('require_attest', '1')", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('coinlock_held', '{}')",
    "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('legacy_fresh', '0')", "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('coin_max_age', '5')"];
  for (const q of no) assert.throws(() => dexSql(q), /not available|engine's own|fenced save|maker's fill records/, q);
});

test("0.19.407 (gate review MAJOR-1): a fill record is every key the engine's LIKE 'fill_%' reads (any case, any 5th character); through the page bridge none of them can carry a maker fill, and a live order is never raised", async () => {
  const { dexSql } = require("../main/dexicon.js"), H = "0x" + "AB".repeat(32), MAKER = '{"role":"maker","filled":"-50","txpowid":"' + H + '"}';
  for (const k of ["fill_" + H, "fillZ" + H, "FILL_" + H, "Fill_" + H, "fIlL." + H, "fill%" + H, "fillx"]) {
    assert.throws(() => dexSql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '" + MAKER + "')"), /maker's fill records/, k);
    assert.throws(() => dexSql("DELETE FROM ax_kv WHERE k='" + k + "'"), /maker's fill records/, "no DELETE of " + k);
    const taker = "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '{\"role\":\"taker\",\"filled\":\"5\"}')"; assert.equal(dexSql(taker), taker);
  }
  for (const k of ["fill", "fil_x", "xfill_" + H, "pending_takes"]) { const q = "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + k + "', '" + MAKER + "')"; assert.equal(dexSql(q), q, k + " is not read as a fill record"); }
  // the reviewer's harness (fill-forge.cjs), end to end: the page bridge, then the service's own reconcileFills
  const b = await boot(), ORDER = "0x" + "1".repeat(32), now = Math.floor(Date.now() / 1000);
  await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([{ orderId: ORDER, side: "sell", price: "0.0123", amount: "100", remaining: "60", coins: ["0x" + "C0".repeat(32)], scripts: [], address: b.node.ADDRESS, seq: now, expiry: now + 3600, status: "live", fillsFrom: now - 100, fills: [] }]) + "')");
  for (const key of ["fill_0x" + "AA".repeat(32), "fillZ0x" + "BB".repeat(32), "FILL_0x" + "CC".repeat(32)]) {
    const rec = JSON.stringify({ role: "maker", orderId: ORDER, filled: "-50", txpowid: "0x" + key.slice(-64), ts: now, status: "settling" });
    await assert.rejects(b.host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + key + "', '" + rec + "')" }), /maker's fill records/, key);
  }
  b.ctx.__out = null;
  vm.runInContext("AX.maker.load(AX.mds, function (e, l) { AX.maker.reconcileFills(AX.mds, l, function (ch) { __out = { changed: ch.length, remaining: AX.maker.find(l, '" + ORDER + "').remaining }; }); });", b.ctx);
  await M.until(() => b.ctx.__out);
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctx.__out)), { changed: 0, remaining: "60" });
});

test("0.19.408: engine 0.0.156 (1993840dd774dda5734ac19f3e22d94f418a8a6f) — the refresh ignores a maker record with no positive plain fill or a junk `verified`, whoever wrote it; a good one still applies once", async () => {
  const b = await boot(), ORDER = "0x" + "2".repeat(32), now = Math.floor(Date.now() / 1000), T = (c) => "0x" + c.repeat(64);
  await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([{ orderId: ORDER, side: "sell", price: "0.0123", amount: "100", remaining: "60", coins: ["0x" + "C1".repeat(32)], scripts: [], address: b.node.ADDRESS, seq: now, expiry: now + 3600, status: "live", fillsFrom: now - 100, fills: [] }]) + "')");
  const rec = (t, filled, extra) => sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('fill_" + t + "', '" + JSON.stringify(Object.assign({ role: "maker", orderId: ORDER, filled, txpowid: t, ts: now, status: "settling" }, extra || {})) + "')");
  await rec(T("1"), "-50"); await rec(T("2"), "0"); await rec(T("3"), "1e1"); await rec(T("4"), "5", { verified: "-1" }); await rec(T("5"), "5", { verified: "junk" });
  const reconcile = async () => { b.ctx.__out = null; vm.runInContext("AX.maker.load(AX.mds, function (e, l) { AX.maker.reconcileFills(AX.mds, l, function (ch) { __out = { changed: ch.length, remaining: AX.maker.find(l, '" + ORDER + "').remaining }; }); });", b.ctx); await M.until(() => b.ctx.__out); return JSON.parse(JSON.stringify(b.ctx.__out)); };
  assert.deepEqual(await reconcile(), { changed: 0, remaining: "60" }, "no junk record moves the order (0.0.153 put 50 back: 110)");
  await rec(T("6"), "10", { verified: "60" });
  assert.deepEqual(await reconcile(), { changed: 1, remaining: "50" }, "a good record is applied");
  assert.equal(require("../main/dexicon.js").ENGINE_VERSION, "0.0.156");
});

test("0.19.406: the service answers a coin proof request with coinexport only (no attestation signed: kv attest_sign is '0'), loads lib/proofs.js and mirrors the resting coin locks; it adds no MegaMMR walk of its own", async () => {
  const H = (c) => "0x" + c.repeat(32), BACK = H("C1"), ADDR = H("A1"), proof = "0x00000020" + BACK.slice(2) + "00000020" + ADDR.slice(2);
  const b = await boot({ node: { on: (c) => (c === "coinexport coinid:" + BACK ? { status: true, pending: false, response: { data: proof } } : null) } });
  assert.equal((await sql(b.host, "SELECT v FROM ax_kv WHERE k='attest_sign'"))[0].V, "0");
  await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([Object.assign(LIVE_ORDER(b.node.ADDRESS), { coins: [BACK], scripts: ["RETURN SIGNEDBY(" + b.node.KEY + ")"] })]) + "')");
  const asker = vm.runInContext('AX.identity.fromSeed("0x' + "b2".repeat(32) + '", "decks").publicId()', b.ctx), logs = [];
  b.host.emitter.on("log", (l) => logs.push(l));
  const posts = () => b.net.calls.filter(c => /^POST .*\/dex\/msg$/.test(c)).length, before = posts();
  b.ctx.__ask = [{ from: asker, coins: [BACK], attest: [ADDR], seen: {} }];
  vm.runInContext("var __proofsDone = false; answerProofs(__ask, function () { __proofsDone = true; });", b.ctx);
  await M.until(() => vm.runInContext("__proofsDone", b.ctx));
  assert.ok(b.node.seen.includes("coinexport coinid:" + BACK), "the coin's proof was exported");
  assert.ok(!b.node.seen.some(c => /^sign\b/.test(c)), "nothing signed");
  await M.until(() => posts() > before); assert.ok(logs.some(l => /coin proofs sent to .*: 1 coin\(s\), 0 attestation\(s\)/.test(l)), logs.join("\n"));
  assert.equal(typeof vm.runInContext("PandaCoinLock.reserve", b.ctx), "function");
  const svc = fs.readFileSync(path.join(M.root, "main/dexicon/service.desktop.js"), "utf8");
  assert.ok(!/megammr/i.test(svc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")) && !/lib\/takeable\.js|doors\/sha3/.test(svc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), "the service does no MegaMMR lookup and loads no takeable rule (the page does: its 16 a height)");
  assert.ok(/mirrorCoinLock\(PandaCoinLock\);/.test(svc) && /MDS\.load\('lib\/proofs\.js'\);/.test(svc));
});

test("0.19.406: a co-signed take is applied ONCE (afterFill with its txpowid, the fill_ record with `verified`); a refresh does not deduct it again", async () => {
  const b = await makerWithTake(() => ({ status: true, pending: false, response: { txpowid: POSTED } }));
  await M.until(() => vm.runInContext("__takeDone", b.ctx));
  let o = await orderNow(b.host); assert.equal(o.remaining, "60"); assert.deepEqual(o.fills, [POSTED]);
  const f = (await fillsNow(b.host)).find(x => x.txpowid === POSTED); assert.equal(f.verified, "100"); assert.deepEqual(f.spent, [COIN]);
  b.ctx.__l = null; vm.runInContext("AX.maker.load(AX.mds, function (e, l) { AX.maker.reconcileFills(AX.mds, l, function (ch) { __l = { changed: ch.length, rem: AX.maker.find(l, '" + ORDER + "').remaining }; }); });", b.ctx);
  await M.until(() => b.ctx.__l); assert.deepEqual(JSON.parse(JSON.stringify(b.ctx.__l)), { changed: 0, rem: "60" }, "the refresh's reconcile finds it applied");
});

test("0.19.406 FILL PENDING: a fill whose save failed keeps its coins locked and refuses every further take of that order, said; the retry applies it; and a take is refused while a recorded fill is not applied (true remaining)", async () => {
  const b = await makerWithTake(() => ({ status: true, pending: false, response: { txpowid: POSTED } }), null);
  await M.until(() => vm.runInContext("__takeDone", b.ctx));
  // a second engine with afterFill failing (the store lock held by a stalled page)
  const c = await boot({ node: { on: (cmd) => (/^txnpost id:dmtest/.test(cmd) ? { status: true, pending: false, response: { txpowid: POSTED } } : null) } });
  await sql(c.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify([LIVE_ORDER(c.node.ADDRESS)]) + "')");
  const said = []; c.host.emitter.on("comms", (m) => said.push(JSON.parse(m)));
  vm.runInContext(`AX.maker.refresh = function (a, b, c, cb) { cb(null, 0, null); }; AX.maker.syncRelays = function (a, b, c, cb) { cb({ lines: [] }); };
    var __realAfter = AX.maker.afterFill, __fail = true;
    AX.maker.afterFill = function (mds, relay, me, id, filled, spent, cb, tx, ver) { if (__fail) return cb(new Error("the fill of " + filled + " MINIMA (txpow " + tx + ") was NOT applied to order " + id + ": another writer changed it three times")); __realAfter.apply(AX.maker, arguments); };
    AX.fill.verifyAsMaker = function () { return { ok: true, filled: "40", received: "0.492", paid: "40" }; };
    AX.fill.cosign = function (mds, hex, keys, verifyFn, cb) { var v = verifyFn({ inputs: [{ coinid: "${COIN}" }], outputs: [{ coinid: "${OUT}" }] }, []);
      mds.cmdR("txnpost id:dmtest", function (e, post) { if (e) return cb(e, null, v); cb(null, post.txpowid, v, ["${OUT}"]); }); };
    var __from = AX.identity.fromSeed("0x" + new Array(33).join("a0"), "decks").publicId(), __n = 0;
    function __take(done) { handleTake({ _from: __from, txn: "0xabcd", orderId: "${ORDER}" }, done); }
    __take(function () { __n = 1; });`, c.ctx);
  await M.until(() => vm.runInContext("__n", c.ctx) === 1);
  assert.ok(said.some(p => p.type === "save_failed" && /was NOT applied/.test(p.message)), "said to the screens");
  assert.equal((await orderNow(c.host)).remaining, "100", "not applied yet");
  const posts = c.node.seen.filter(x => /^txnpost id:dmtest/.test(x)).length;
  vm.runInContext("__take(function () { __n = 2; });", c.ctx); await M.until(() => vm.runInContext("__n", c.ctx) === 2);
  assert.equal(c.node.seen.filter(x => /^txnpost id:dmtest/.test(x)).length, posts, "the second take was not co-signed");
  assert.ok(said.some(p => p.type === "take_refused" && /still being saved/.test(p.reason)));
  vm.runInContext("__fail = false; var __r = false; retryFills(function () { __r = true; });", c.ctx); await M.until(() => vm.runInContext("__r", c.ctx));
  const o = await orderNow(c.host); assert.equal(o.remaining, "60"); assert.deepEqual(o.fills, [POSTED]);
  assert.equal(vm.runInContext("Object.keys(FILL_PENDING).length", c.ctx), 0);
  // true remaining: a maker fill_ record of this order not yet on its fills → the next take is refused as busy, not checked against 60
  const T2 = "0x" + "EE".repeat(32), ts = Math.floor(Date.now() / 1000) + 5;
  await sql(c.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('fill_" + T2 + "', '" + JSON.stringify({ role: "maker", orderId: ORDER, filled: "20", txpowid: T2, ts, verified: "60", status: "settling" }) + "')");
  const p2 = c.node.seen.filter(x => /^txnpost id:dmtest/.test(x)).length;
  vm.runInContext("__take(function () { __n = 3; });", c.ctx); await M.until(() => vm.runInContext("__n", c.ctx) === 3);
  assert.equal(c.node.seen.filter(x => /^txnpost id:dmtest/.test(x)).length, p2, "not co-signed");
  assert.ok(said.some(p => p.type === "take_refused" && /earlier fill of this order is still being applied/.test(p.reason)));
  assert.equal(vm.runInContext("rebackDue", c.ctx), true, "the refresh at the end of the tick applies it");
});

test("0.19.406 NEWBLOCK RE-BACK: an order waiting coinless for its relock is re-backed on the next block, never beside a running tick; one refresh at a time", async () => {
  const b = await boot();
  vm.runInContext(`var __refreshes = 0, __hold = null; AX.maker.refresh = function (a, b, c, cb) { __refreshes++; __hold = function () { cb(null, 0, null, ["relock: coin 0x01 failed: no funds"]); }; };
    AX.maker.awaitingBacking = function () { return true; };`, b.ctx);
  const said = []; b.host.emitter.on("comms", (m) => said.push(JSON.parse(m)));
  vm.runInContext("TICKING = true; tickStartedMs = Date.now(); rebackOnBlock();", b.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(vm.runInContext("__refreshes", b.ctx), 0); assert.equal(vm.runInContext("rebackDue", b.ctx), true, "marked due for the tick's end");
  vm.runInContext("TICKING = false; rebackOnBlock(); rebackOnBlock();", b.ctx);
  await M.until(() => vm.runInContext("__refreshes", b.ctx) === 1);
  await new Promise(r => setTimeout(r, 30)); assert.equal(vm.runInContext("__refreshes", b.ctx), 1, "one refresh at a time");
  vm.runInContext("__hold()", b.ctx);
  assert.ok(said.some(p => p.type === "relock_failed" && /no funds/.test(p.message)), "a failed relock is said");
  const svc = fs.readFileSync(path.join(M.root, "main/dexicon/service.desktop.js"), "utf8");
  assert.ok(/else if \(msg\.event === 'NEWBLOCK' && READY\) rebackOnBlock\(\);/.test(svc));
});

test("0.19.406: page SQL and service SQL are ONE database: a page cancel of Y (the vendored lib through this app's bridge, dexSql + pageSql) and a service fill of X both land, at every offset", async () => {
  const b = await boot(), X = "0x" + "1".repeat(32), Y = "0x" + "2".repeat(32);
  const LIB = ["lib/rhino_shim.js", "vendor/nacl.js", "vendor/blake.js", "vendor/sha256.js", "vendor/sha512.js", "vendor/decimal.js", "lib/hex.js", "lib/flow.js", "crypto/ax_sodium.js", "lib/identity.js", "lib/mdsw.js", "lib/prng.js", "lib/envelope.js", "lib/relay.js", "lib/fill.js", "lib/maker.js"];
  const refused = []; b.host.emitter.on("log", (l) => { if (/refused SQL/.test(l)) refused.push(l); });
  const pageMds = { log() {}, comms: { solo() {} },
    sql: (q, cb) => { b.host.command({ op: "sql", query: q }).then((r) => cb && cb(r), (e) => cb && cb({ status: false, error: e.message })); },
    cmd: (c, cb) => { b.host.command({ op: "cmd", command: c }).then((r) => cb && cb(r), (e) => cb && cb({ status: false, error: e.message })); } };
  const page = vm.createContext({ MDS: pageMds, console, setTimeout, clearTimeout, setInterval, clearInterval }); page.global = page;
  for (const f of LIB) vm.runInContext(fs.readFileSync(path.join(M.root, "main/dexicon", f), "utf8"), page, { filename: "page/" + f });
  vm.runInContext("var __me = AX.identity.fromSeed('0x" + "c3".repeat(32) + "', 'decks'), __relay = { relays: ['https://relay.example'], publish: function (r, cb) { cb([{ url: 'https://relay.example', ok: true }]); }, publishTo: function (u, r, cb) { cb({ ok: true }); } };", page);
  for (const off of [0, 5, 15, 30]) {
    const orders = [Object.assign(LIVE_ORDER(b.node.ADDRESS), { orderId: X, coins: [] }), Object.assign(LIVE_ORDER(b.node.ADDRESS), { orderId: Y, coins: [], seq: Date.now() })];
    await sql(b.host, "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('myorders', '" + JSON.stringify(orders) + "')");
    const TX = "0x" + String(off + 10).padStart(2, "0").repeat(32);
    const fill = new Promise((res) => { b.ctx.__res = res; vm.runInContext("AX.maker.afterFill(AX.mds, RELAY, ME, '" + X + "', '40', [], function (e) { __res(e ? e.message : ''); }, '" + TX + "', '100');", b.ctx); });
    const cancel = new Promise((res) => setTimeout(() => { page.__res = res; vm.runInContext("AX.maker.cancel(AX.mds, __relay, __me, '" + Y + "', function (e) { __res(e ? e.message : ''); });", page); }, off));
    const [ef, ec] = await Promise.all([fill, cancel]);
    assert.equal(ef, "", "fill at offset " + off); assert.equal(ec, "", "cancel at offset " + off);
    const now = JSON.parse((await sql(b.host, "SELECT v FROM ax_kv WHERE k='myorders'"))[0].V), x = now.find(o => o.orderId === X), y = now.find(o => o.orderId === Y);
    assert.equal(x.remaining, "60", "X sold 40 stays sold at offset " + off); assert.equal(x.status, "live"); assert.equal(y.status, "cancelled", "Y cancelled at offset " + off);
  }
  assert.deepEqual(refused, [], "every page statement of the lock and the fenced save passed the allow-list");
});

test("0.19.409 (gate review MINOR-1): the page's FAST create reads the resting engine's input claims (exactly `SELECT coinid FROM pp_posted_inputs`) and never backs an order with a claimed coin", async () => {
  const { dexSql } = require("../main/dexicon.js"), q = "SELECT coinid FROM pp_posted_inputs";
  assert.equal(dexSql(q), q);
  for (const no of ["SELECT * FROM pp_posted_inputs", "SELECT coinid FROM pp_posted_inputs WHERE 1", "select coinid from pp_posted_inputs", "DELETE FROM pp_posted_inputs", "SELECT coinid FROM pp_posted_inputs;"]) assert.throws(() => dexSql(no), /not available/, no);
  const COIN = (n) => "0x" + String(n).repeat(64), wallet = [1, 2, 3].map(i => ({ coinid: COIN(i), amount: "100", tokenamount: "100", tokenid: "0x00", address: M.ADDRESS, created: "990", state: [], spent: false, storestate: false }));
  const ok = (r) => ({ status: true, pending: false, response: r });
  const b = await boot({ node: { on: (c) => {
    if (/^coins relevant:true checkmempool:true tokenid:0x00$/.test(c)) return ok(wallet);
    if (/^coins relevant:true checkmempool:true tokenid:0x/.test(c)) return ok([]);
    const m = /coinid:(0x[0-9A-Fa-f]+)/.exec(c); if (/^coins\b/.test(c) && m) { const w = wallet.find(x => x.coinid === m[1].toUpperCase()); return ok(w ? [w] : []); }
    if (c === "status") return ok({ megammr: true, version: "1.1.2.31" });
    return null; } } });
  await sql(b.host, "CREATE TABLE IF NOT EXISTS pp_posted_inputs (coinid varchar(160) primary key, handle varchar(160))");   // the engine's own DDL (resting/input-claims.js)
  await sql(b.host, "INSERT INTO pp_posted_inputs (coinid,handle) VALUES ('" + COIN(1) + "','dex_1')");   // coin 1 is an input of a posted on-chain trade
  const refused = []; b.host.emitter.on("log", (l) => { if (/refused SQL/.test(l)) refused.push(l); });
  const LIB = ["lib/rhino_shim.js", "vendor/nacl.js", "vendor/blake.js", "vendor/sha256.js", "vendor/sha512.js", "vendor/decimal.js", "lib/hex.js", "lib/flow.js", "crypto/ax_sodium.js", "lib/identity.js", "lib/mdsw.js", "lib/prng.js", "lib/envelope.js", "lib/relay.js", "lib/fill.js", "lib/maker.js"];
  const pageMds = { log() {}, comms: { solo() {} },
    sql: (s, cb) => { b.host.command({ op: "sql", query: s }).then((r) => cb && cb(r), (e) => cb && cb({ status: false, error: e.message })); },
    cmd: (c, cb) => { b.host.command({ op: "cmd", command: c }).then((r) => cb && cb(r), (e) => cb && cb({ status: false, error: e.message })); } };
  const page = vm.createContext({ MDS: pageMds, console, setTimeout, clearTimeout, setInterval, clearInterval }); page.global = page;
  for (const f of LIB) vm.runInContext(fs.readFileSync(path.join(M.root, "main/dexicon", f), "utf8"), page, { filename: "page/" + f });
  vm.runInContext("var __me = AX.identity.fromSeed('0x" + "c3".repeat(32) + "', 'decks'), __relay = { relays: ['https://relay.example'], publish: function (r, cb) { cb([{ url: 'https://relay.example', ok: true }]); }, publishTo: function (u, r, cb) { cb({ ok: true }); } };", page);
  const made = await new Promise((res) => { page.__res = res; vm.runInContext("AX.maker.create(AX.mds, __relay, __me, { side: 'sell', price: '0.0123', amount: '150' }, function (e, o) { __res({ err: e ? e.message : '', coins: o && o.coins }); });", page); });
  assert.equal(made.err, ""); assert.deepEqual([...made.coins].sort(), [COIN(2), COIN(3)], "the claimed coin 1 is not a backing coin");
  assert.deepEqual(refused, []);
});

test("0.19.411 (gate review MINOR-4): the service's POSTED / ERROR for a page LIMIT carries that LIMIT's ref — told at once, after the pool refresh, or from the transaction's own callback — and no other packet does", async () => {
  const b = await boot(), packets = [];
  b.host.emitter.on("comms", (m) => { try { const p = JSON.parse(m); if (p.origin === "service" && (p.type === "POSTED" || p.type === "ERROR")) packets.push(p); } catch (e) {} });
  const limit = async (data) => { await b.host.command({ op: "intent", type: "LIMIT", buy: !!data.buy, price: data.price, amount: data.minima }); await b.host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "LIMIT", data }) }); };
  const answer = async (n) => { await M.until(() => packets.length >= n); return packets[n - 1].data; };
  // nothing crosses (told after the pool refresh, through limitWithPools)
  await limit({ buy: false, minima: "10", price: "0.004413", takeOnly: true, ref: "swTEST000001" });
  let d = await answer(1); assert.match(d.message, /Nothing on-chain crosses 0\.004413/); assert.equal(d.ref, "swTEST000001");
  // the same without a ref: no ref on its answer; a malformed ref is never echoed
  await limit({ buy: false, minima: "10", price: "0.004413", takeOnly: true }); d = await answer(2); assert.equal(d.ref, undefined);
  await limit({ buy: false, minima: "10", price: "0.004413", takeOnly: true, ref: "bad ref!" }); d = await answer(3); assert.equal(d.ref, undefined);
  // a book take: the ERROR comes from inside the transaction's build (PandaTxn.fill → the funding read), long after the packet
  vm.runInContext("PandaBook.plan = function () { return { takes: [{ order: { sell: true, coinid: '0x" + "D1".repeat(32) + "' }, pay: PandaDEX.d('1'), lockedTake: PandaDEX.d('10') }], totalMinima: PandaDEX.d('10'), average: PandaDEX.d('0.0045'), totalUsdt: PandaDEX.d('0.045') }; };", b.ctx);
  await limit({ buy: false, minima: "10", price: "0.004413", takeOnly: true, ref: "swTEST000004" });
  d = await answer(4); assert.match(d.message, /Could not select 1 from at most 8/, d.message); assert.equal(d.ref, "swTEST000004", "the transaction callback's answer carries the LIMIT's ref");
  // another action meanwhile (a cancel of an order that is not mine): its ERROR has no ref
  await b.host.command({ op: "comms", message: JSON.stringify({ origin: "ui", type: "CANCEL", data: { coinid: "0x" + "E1".repeat(32) } }) });
  d = await answer(5); assert.match(d.message, /not one of your active orders/); assert.equal(d.ref, undefined);
});

test("0.19.406: the FAST backing-coin settings: read and written by the app's own Settings (only what is given), never by the page", async () => {
  const b = await boot();
  assert.deepEqual(b.host.fastCoins(), { legacyFresh: true, coinMaxAge: "", maxAgeLimit: 900 }, "unset: refresh ON, 900 blocks");
  assert.deepEqual(b.host.fastCoinsSave({ legacyFresh: false }), { legacyFresh: false, coinMaxAge: "", maxAgeLimit: 900 });
  assert.deepEqual(b.host.fastCoinsSave({ coinMaxAge: "120" }), { legacyFresh: false, coinMaxAge: "120", maxAgeLimit: 900 });
  for (const bad of [{ coinMaxAge: "0" }, { coinMaxAge: "901" }, { coinMaxAge: "1.5" }, { legacyFresh: "no" }, {}]) assert.throws(() => b.host.fastCoinsSave(bad), /coin max age|true or false|nothing to save/, JSON.stringify(bad));
  await assert.rejects(b.host.command({ op: "sql", query: "MERGE INTO ax_kv (k, v) KEY(k) VALUES ('legacy_fresh', '1')" }), /engine's own/);
  const main = fs.readFileSync(path.join(M.root, "main/main.js"), "utf8"), pre = fs.readFileSync(path.join(M.root, "main/preload.js"), "utf8");
  assert.ok(/ipcMain\.handle\("mcd:dxFastCoins", \(_e, patch\) => \(patch && typeof patch === "object" \? dexicon\.fastCoinsSave\(patch\) : dexicon\.fastCoins\(\)\)\);/.test(main) && /dxFastCoins: \(patch\) => ipcRenderer\.invoke\("mcd:dxFastCoins", patch\),/.test(pre));
});
