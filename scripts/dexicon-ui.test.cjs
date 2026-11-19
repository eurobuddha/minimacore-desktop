// Dexicon's screens (Phase 3b): the logic in renderer/dexicon-core.js, run here; nothing in this file reads source
// text to decide a result, except where a constant must equal a committed file.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const C = require("../renderer/dexicon-core.js");

test("rooms: three, in the phone's order; Exchange has the phone's six tabs", () => {
  assert.deepEqual(C.ROOMS.map(r => r.n + " " + r.label), ["① MxUSD", "② Pools", "③ Exchange"]);
  assert.deepEqual(C.ROOMS[2].tabs.map(t => C.TAB_LABEL[t]), ["Trade", "Orders", "History", "Activity", "Assets", "Settings"]);
  assert.deepEqual([C.ROOMS[0].view, C.ROOMS[1].view], ["atomix", "pandapools"]);
  assert.deepEqual(C.ROOMS[1].tabs, [], "room 2 is the existing panel until 3d and gets no Dexicon tab that would do nothing");   // room 1: scripts/dexicon-ax.test.cjs
});

test("each room remembers its last tab; Dexicon opens on room 1; the theme is remembered", () => {
  let mem = C.load(null);
  assert.equal(mem.room, 0); assert.equal(mem.theme, "ONYX"); assert.equal(mem.tabs.exchange, "trade");
  C.pickRoom(mem, 2); C.pickTab(mem, "history");
  assert.equal(C.tabOf(mem), "history");
  C.pickRoom(mem, 1); assert.equal(C.tabOf(mem), "", "Pools has no Dexicon tab yet");
  C.pickTab(mem, "orders"); assert.equal(mem.tabs.exchange, "history", "a tab of another room changes nothing");
  C.pickRoom(mem, 2); assert.equal(C.tabOf(mem), "history", "back in Exchange: the tab it was left on");
  C.toggleTheme(mem);
  const again = C.load(C.save(mem));
  assert.equal(again.room, 0, "a new start opens on room 1");
  assert.equal(again.tabs.exchange, "history"); assert.equal(again.theme, "DAYLIGHT");
  assert.equal(C.toggleTheme(again).theme, "ONYX");
  for (const junk of ["", "{", "null", '{"tabs":{"exchange":"nope"},"theme":7}', '{"tabs":"x"}']) {
    const m = C.load(junk); assert.equal(m.tabs.exchange, "trade", "junk: " + junk); assert.equal(m.theme, "ONYX");
  }
  C.pickRoom(mem, 9); assert.equal(mem.room, 2, "a room that does not exist is ignored");
});

test("every Dexicon room is a view the shell knows", () => {
  for (const v of ["atomix", "pandapools", "dexicon"]) assert.ok(C.roomOfView(v) >= 0, v + " is a Dexicon room");
  assert.equal(C.roomOfView("balances"), -1);   // full screen vs shell: scripts/shell-test.cjs runs the shell's own shellMode
});

test("the status strip says what is true: node, then engine", () => {
  assert.deepEqual(C.strip("stopped", null), { text: "NODE STOPPED", tone: "dim" });
  assert.deepEqual(C.strip("starting", null), { text: "NODE STARTING…", tone: "dim" });
  assert.equal(C.strip("running", null).text, "PAIRED · starting Dexicon");
  assert.equal(C.strip("running", { started: true, ready: false }).text, "PAIRED · starting Dexicon");
  assert.equal(C.strip("running", { started: true, ready: true, restingReady: false }).text, "PAIRED · reading the chain");
  assert.deepEqual(C.strip("running", { started: true, ready: true, restingReady: true }), { text: "PAIRED", tone: "ok" });
});

// 0.18.109: the hidden page (the taker's engine: it sends, hears and voids FAST takes) must not wait for a visit to Dexicon
test("the page frame: wanted whenever the engine is ready, remade for another engine, tried again when it never speaks", () => {
  const ready = { started: true, ready: true, epoch: 3 }, have = { epoch: 3, madeAt: 1000, heard: true };
  assert.equal(C.pageStep("running", ready, null, 0), "make");
  assert.equal(C.pageStep("running", { started: true, ready: false, epoch: 3 }, null, 0), "none");
  assert.equal(C.pageStep("running", ready, have, 5000), "keep");
  assert.equal(C.pageStep("running", { started: true, ready: true, epoch: 4 }, have, 5000), "remake", "a node restart or a replaced wallet: another engine, another identity");
  assert.equal(C.pageStep("running", { started: true, ready: false, epoch: 4 }, have, 5000), "drop");
  assert.equal(C.pageStep("stopped", ready, have, 5000), "drop");
  assert.equal(C.pageStep("running", null, have, 5000), "keep", "a status read that failed tears nothing down: a take may be in flight");
  assert.equal(C.pageStep("running", null, null, 5000), "none");
  const silent = { epoch: 3, madeAt: 1000, heard: false };
  assert.equal(C.pageStep("running", ready, silent, 1000 + C.PAGE_LOAD_MS), "keep");
  assert.equal(C.pageStep("running", ready, silent, 1001 + C.PAGE_LOAD_MS), "retry");
  assert.deepEqual(C.strip("running", { started: true, ready: true, restingReady: true }, true), { text: "PAIRED · trading page did not load", tone: "dim" });
  assert.deepEqual(C.strip("running", { started: true, ready: false, problem: "The old wallet's Dexicon store could not be moved aside" }), { text: "DEXICON IS NOT RUNNING", tone: "dim" });
  assert.match(C.PAGE_FAILED, /did not load, so a trade cannot be sent from here right now\. The app is trying again/);
});

test("the screens' code makes the frame without any visit to Dexicon, keeps it across tabs, remakes it after an engine restart, and says so when it cannot load", async () => {
  const vm = require("node:vm");
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() { e.parent.children.splice(e.parent.children.indexOf(e), 1); e.removed = true; }, querySelectorAll: () => [], querySelector: () => null }; return e; };
  const els = {}, timers = [], listeners = {}; let clock = 1000000, status = { version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {} }, service = null, asked = 0;
  const win = { DexCore: C, DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false }, console, JSON, Promise, setInterval: (fn) => { timers.push(fn); }, setTimeout, localStorage: { getItem: () => null, setItem() {} },
    Date: class extends Date { static now() { return clock; } },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null },
    addEventListener: (t, f) => { listeners[t] = f; } };
  win.window = win; win.mcd = { dxStatus: async () => { asked++; if (!status) throw new Error("no answer"); return status; }, onDexicon: (f) => { service = f; }, clip: async () => true, dxCommand: async () => ({}) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const shell = win.document.getElementById("shell"); shell.dataset.mode = "tabs";   // the Wallet tab is on screen; Dexicon was never opened
  const frames = () => shell.children.filter(c => c.tag === "iframe"), tick = async () => { for (const t of timers) t(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  win.DexUI.init({ go() {}, leave() {}, start() {} });
  assert.equal(frames().length, 0);
  win.DexUI.node({ state: "running" });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(frames().length, 1, "made as soon as the node runs and the engine is ready: DexUI.paint was never called");
  const f1 = frames()[0];
  assert.deepEqual([f1.src, f1.attrs.sandbox, f1.hidden], ["dxroom://exchange/index.html", "allow-scripts", true]);
  assert.equal(shell.dataset.mode, "tabs");
  // the page speaks (its first report)
  listeners.message({ source: f1.contentWindow, data: { dxRoom: 1, page: { ready: true } } });
  // other tabs, many polls, a status read that fails: the same frame
  for (let i = 0; i < 5; i++) { clock += 60000; await tick(); }
  status = null; await tick(); status = { started: true, ready: true, epoch: 1 };
  assert.deepEqual(frames(), [f1], "kept across tab changes and time");
  // the engine was restarted (node restart, wallet replaced): told by the host's update event, another frame
  status = { started: true, ready: true, restingReady: true, epoch: 2 };
  service(null); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(frames().length, 1); assert.notEqual(frames()[0], f1, "remade for the new engine"); assert.equal(f1.removed, true);
  // a frame that never speaks: said in the status strip, and tried again
  const f2 = frames()[0];
  clock += C.PAGE_LOAD_MS + 1; await tick();
  assert.equal(els.dxPair.textContent, "PAIRED · trading page did not load");
  assert.equal(frames().length, 1); assert.notEqual(frames()[0], f2, "tried again");
  listeners.message({ source: frames()[0].contentWindow, data: { dxRoom: 1, page: { ready: true } } });
  assert.equal(els.dxPair.textContent, "PAIRED", "and the strip is true again once it speaks");
  // the node stops: no engine, no frame
  win.DexUI.node({ state: "stopped" });
  assert.equal(frames().length, 0); assert.match(els.dxPair.textContent, /^NODE STOPPED/);
  assert.ok(asked > 5);
});

test("the version pill is the vendored engine's version", () => {
  require("./dexicon-mock.cjs");   // main/rpc.js and main/netfetch.js replaced by versions that throw
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "dexicon-parity.manifest.json"), "utf8"));
  const dexicon = require("../main/dexicon.js");
  assert.equal(dexicon.ENGINE_VERSION, manifest.donor.mdsVersion);
  assert.equal(dexicon.makeHost({ quiet: true, dataDir: "/nonexistent" }).status().version, manifest.donor.mdsVersion);
});

// ---------------------------------------------------------------- Trade (0.18.101)
const d = (x) => C.dec(x);
const BOOK = {
  fast: [{ side: "sell", price: "0.0032", minima: "100", ours: false }, { side: "sell", price: "0.0033", minima: "50.5", ours: false }, { side: "sell", price: "0.0031", minima: "40", ours: true },
    { side: "buy", price: "0.003", minima: "200", ours: false }, { side: "buy", price: "0.0029", minima: "70", ours: true }],
  book: [{ side: "sell", price: "0.0033", minima: "25", ours: false }, { side: "buy", price: "0.0028", minima: "10", ours: true }],
  poolAsks: [{ price: "0.00335", minima: "812.4479" }], poolBids: [{ price: "0.00295", minima: "300.999" }], pools: [{ address: "0xAA", minima: "1", mxusd: "1", mine: true }]
};
const FUNDS = C.funds("1000", "10", [{ status: "live", side: "buy", remaining: "100", price: "0.01" }, { status: "cancelled", side: "sell", remaining: "999", price: "1" }],
  [{ status: "settling", side: "buy", role: "taker", filled: "5", got: "5" }, { status: "done", side: "buy", filled: "50" }]);

test("amounts are cut, never rounded", () => {
  assert.equal(C.fmtBal(d("13.404884999999")), "13.404884", "a balance: 6 decimals, cut");
  assert.equal(C.fmtBal(d("0.9999999")), "0.999999");
  assert.equal(C.fmt(C.down(d("1.999999999"), 8)), "1.99999999");
  assert.equal(C.fmtDown(d("812.4479"), 2), "812.44", "pool depth: two decimals, cut (not 812.45)");
  assert.equal(C.fmtDown(d("5"), 2), "5.00");
  assert.equal(C.fmt(C.div(d("2"), d("3"), 8)), "0.66666666", "a division is cut");
  assert.equal(C.fmtPrice(d("0.0034")), "0.003400", "a price is padded to 6 decimals");
  assert.equal(C.fmtPrice(d("0.00314999123")), "0.00314999123", "and never shortened");
  assert.equal(C.fmt(C.up(d("1.000000001"), 8)), "1.00000001", "up() exists only for 'you pay at most'");
  assert.equal(C.fmt(C.sub(d("1"), d("2"))), "0", "a subtraction never goes below zero");
  assert.equal(C.fmt(C.mul(d("0.1"), d("0.2"))), "0.02", "no float anywhere: 0.1 x 0.2 is 0.02");
  for (const bad of ["", "abc", "1e5", "-1", "1.2.3", " ", null, undefined, "0x10", "1,5"]) assert.equal(C.dec(bad), null, "not a number: " + bad);
});

test("the 1 MINIMA minimum remainder: a partial take leaves at least 1 MINIMA or takes the order whole", () => {
  assert.equal(C.fmt(C.floorTake(d("10"), d("10"))), "10");
  assert.equal(C.fmt(C.floorTake(d("10"), d("25"))), "10");
  assert.equal(C.fmt(C.floorTake(d("10"), d("5"))), "5");
  assert.equal(C.fmt(C.floorTake(d("10"), d("9.5"))), "9", "9.5 would leave 0.5: cut back so 1 stays");
  assert.equal(C.fmt(C.floorTake(d("0.8"), d("0.3"))), "0", "an order under 1 MINIMA can only be taken whole");
  const engine = require("fs").readFileSync(path.join(__dirname, "../main/dexicon/lib/fill.js"), "utf8");
  assert.ok(/var MIN_REM = '1';/.test(engine), "the engine's own constant is still 1 (the engine enforces the rule; the screen only shows it)");
});

test("the order book: FAST, BOOK and POOL at each price; the user's own level marked; grouping is of the view only", () => {
  const L = C.ladder(BOOK, 0);
  assert.deepEqual(L.asks.map(l => C.fmt(l.price)), ["0.0031", "0.0032", "0.0033", "0.00335"], "asks from the best price up");
  assert.deepEqual(L.bids.map(l => C.fmt(l.price)), ["0.003", "0.00295", "0.0029", "0.0028"], "bids from the best price down");
  assert.equal(L.asks[0].mine, true);
  assert.deepEqual(C.amountText(L.asks[2].fast, L.asks[2].book, L.asks[2].pool), ["FAST 50.5", "BOOK 25"]);
  assert.deepEqual(C.amountText(L.asks[3].fast, L.asks[3].book, L.asks[3].pool), ["POOL 812.44"]);
  assert.deepEqual(C.amountText(C.zero, d("25"), C.zero), ["25"], "BOOK alone carries no tag");
  assert.deepEqual(L.count, { fast: 5, book: 2, pools: 1 });
  assert.equal(C.fmt(L.mid), "0.00305"); assert.equal(C.fmt(L.spread), "0.0001");
  const G = C.ladder(BOOK, 2);   // 0.001
  assert.deepEqual(G.asks.map(l => C.fmt(l.price)), ["0.004"], "asks group up to the tick");
  assert.deepEqual(G.bids.map(l => C.fmt(l.price)), ["0.003", "0.002"], "bids group down");
  assert.equal(C.fmt(G.asks[0].exact), "0.0031", "the row still shows the exact best price in the group");
  const R = C.rows(L.asks);
  assert.equal(C.fmt(R[1].cum), "140", "the depth so far, which a click on the row fills in");
  assert.equal(C.ladder(null, 0).mid, null);
});

test("funds: free = sendable minus what live FAST orders already promise; settling shown apart", () => {
  assert.equal(C.fmt(C.freeFor(FUNDS, true)), "9", "10 MxUSD less the live bid's 1");
  assert.equal(C.fmt(C.freeFor(FUNDS, false)), "1000");
  assert.equal(C.fmt(FUNDS.minimaSettling), "5");
  assert.equal(C.funds(null, null, [], []).known, false, "an unread balance is not zero: it is unknown");
});

test("% buttons: of the exact MINIMA on offer when FAST orders cross, capped by free funds; else of the free funds", () => {
  assert.equal(C.fmt(C.percent(BOOK, true, "0.0033", 100, FUNDS)), "150.5", "100 % of the offer is the offer itself (own order left out)");
  assert.equal(C.fmt(C.percent(BOOK, true, "0.0033", 25, FUNDS)), "37.625");
  assert.equal(C.fmt(C.percent(BOOK, true, "0.001", 50, FUNDS)), "4500", "nothing crosses: half of what 9 MxUSD buys at 0.001");
  assert.equal(C.fmt(C.percent(BOOK, true, "0.0033", 100, C.funds("0", "0.1", [], []))), "30.3030303", "capped by 0.1 MxUSD at 0.0033, cut to 8 decimals");
  assert.equal(C.percent(BOOK, true, "", 100, FUNDS), null);
  assert.equal(C.percent(BOOK, true, "0.0033", 100, C.funds(null, null, [], [])), null);
});

test("the review of a FAST take names exactly what the click signs", () => {
  const pl = C.plan(BOOK, true, "0.0033", "120", FUNDS), text = C.review(pl, 2).join("\n");
  assert.equal(pl.fast, true); assert.equal(pl.takes, 2);
  assert.equal(C.fmt(pl.take), "120"); assert.equal(C.fmt(pl.cost), "0.386", "100 at 0.0032 + 20 at 0.0033");
  assert.match(text, /One click signs and sends: BUY 120 MINIMA from 2 FAST asks, best price first, never above 0\.003300 MxUSD per MINIMA\./);
  assert.match(text, /You pay at most 0\.386 MxUSD and receive 120 MINIMA \(average 0\.00321666\)\./, "the average is cut, not rounded (0.003216666…)");
  assert.match(text, /leaves at least 1 MINIMA on the maker's order or takes it whole/);
  assert.match(text, /On-chain orders or pools also reach this price/, "the on-chain route is offered for review, never taken silently");
  const part = C.plan(BOOK, true, "0.0032", "99.5", FUNDS);
  assert.equal(C.fmt(part.take), "99", "99.5 of 100 would leave 0.5: the take is 99");
  assert.match(C.review(part, 2).join("\n"), /The other 0\.5 MINIMA is not traded and no order is placed for it\./);
  const sell = C.review(C.plan(BOOK, false, "0.003", "50", FUNDS), 2).join("\n");
  assert.match(sell, /SELL 50 MINIMA from 1 FAST bid, best price first, never below 0\.003000/);
  assert.match(sell, /You pay 50 MINIMA and receive at least 0\.15 MxUSD/);
});

test("the review of a limit order that rests says nothing trades and nothing is locked", () => {
  const pl = C.plan(BOOK, false, "0.0036", "500", FUNDS), text = C.review(pl, 2).join("\n");
  assert.equal(pl.fast, false); assert.equal(pl.chain, false);
  assert.match(text, /One click signs and publishes a FAST order: SELL 500 MINIMA at 0\.003600 MxUSD per MINIMA \(at least 1\.8 MxUSD in all\) on 2 relays\./);
  assert.match(text, /Nothing is traded now and no coin is locked/);
  assert.match(C.review(C.plan(BOOK, true, "0.001", "7", FUNDS), 1).join("\n"), /BUY 7 MINIMA at 0\.001000 MxUSD per MINIMA \(up to 0\.007 MxUSD in all\) on 1 relay\./);
  assert.deepEqual(C.review(C.plan(BOOK, true, "", "5", FUNDS), 2), [], "no price: no review");
  assert.equal(C.plan(BOOK, true, "0.123456789", "1", FUNDS).why, "At most 8 decimals.");
});

test("funds short: the plan says by how much, and the screen blocks the click", () => {
  const pl = C.plan(BOOK, true, "0.0033", "150.5", C.funds("0", "0.2", [], []));
  assert.equal(C.fmt(pl.need), "0.48665"); assert.equal(C.fmt(pl.short), "0.28665");
  assert.equal(C.plan(BOOK, false, "0.003", "50", FUNDS).short.v, 0n);
});

test("only the user's own orders at a price: ordinary plan feedback, no special flow", () => {
  const own = { fast: [{ side: "sell", price: "0.0031", minima: "40", ours: true }], book: [], poolAsks: [], poolBids: [] };
  const pl = C.plan(own, true, "0.0031", "10", FUNDS);
  assert.equal(pl.fast, false, "an own order is never counted as something to take");
  assert.equal(pl.ownOnly, true);
  assert.match(C.review(pl, 2)[0], /^Only your own orders are at this price\. Nothing would trade\.$/);
  assert.equal(C.plan(BOOK, true, "0.0031", "10", FUNDS).ownOnly, true);
  assert.equal(C.plan(BOOK, true, "0.0032", "10", FUNDS).ownOnly, false);
});

test("a refusal is shown in the words it came in, whoever refused", () => {
  const bridge = "Error invoking remote method 'mcd:dxCommand': Error: Order 0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8 is no longer on the book. Nothing was sent.";
  assert.equal(C.refusal(bridge), "Order 0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8 is no longer on the book. Nothing was sent.",
    "the bridge's wrapper is removed; the message and the identifier are whole");
  // the engine's sentence for "nothing but your own orders there" (lib/ownskip.js) is plan feedback, not an error
  const ownskip = {}; require("node:vm").runInNewContext(fs.readFileSync(path.join(__dirname, "../main/dexicon/lib/ownskip.js"), "utf8"), ownskip);
  assert.equal(C.feedbackKind(ownskip.AX.ownskip.ONLY_OWN), "note");
  assert.equal(C.feedbackKind(C.refusal("Error invoking remote method 'mcd:dxCommand': Error: " + ownskip.AX.ownskip.ONLY_OWN)), "note");
  assert.equal(C.feedbackKind("the maker refused: coin already spent"), "error"); assert.equal(C.feedbackKind(null), "error");
  // the one outside price, named from the engine's own field
  assert.equal(C.priceName("MEXC"), "MEXC price"); assert.equal(C.priceName("MEXC via CoinGecko"), "MEXC price via CoinGecko"); assert.equal(C.priceName(undefined), "MEXC price"); assert.equal(C.priceName("Binance"), "MEXC price");
  assert.equal(C.refusal("the maker refused: coin already spent"), "the maker refused: coin already spent");
  assert.match(C.refusal(""), /no reason was given/); assert.match(C.refusal(null), /Look at Activity before trying again/);
});

test("nothing outside the allow-list leaves the Exchange screens", () => {
  assert.deepEqual(C.ACTS, ["place", "cancelFast", "editFast", "cancelChain", "editChain", "addRelay", "removeRelay", "discover", "refresh", "makerOpen", "makerStop", "makerReview"]);
  for (const act of ["send", "consolidate", "eval", "txnsign", "__proto__", "constructor", ""]) assert.throws(() => C.driveCall(1, act, {}), /not an action of the Exchange screens/, act);
  assert.deepEqual(C.driveCall(7, "place", { buy: true }), { dxRoom: 1, drive: { id: 7, act: "place", args: { buy: true } } });
  // from the page's frame: only the four bridge ops, each rebuilt from its named fields (nothing else rides along)
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 1, name: "room.dex", args: { op: "cmd", command: "block", extra: "x", fn: "axSend" } }), { kind: "dx", args: { op: "cmd", command: "block" } });
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 2, name: "room.dex", args: { op: "net", method: "DELETE", url: "https://x/dex/book", body: null } }).args, { op: "net", method: "GET", url: "https://x/dex/book", body: null });
  for (const m of [{ dxRoom: 1, id: 1, name: "room.dex", args: { op: "invalidate" } }, { dxRoom: 1, id: 1, name: "room.ax", args: { op: "cmd", command: "block" } }, { dxRoom: 1, id: 1, name: "mcd.cmd", args: {} },
    { dxRoom: 2, id: 1, name: "room.dex", args: { op: "cmd" } }, { dxRoom: 1, id: "1", name: "room.dex", args: { op: "cmd" } }, { dxRoom: 1, id: 1, name: "room.dex" }, null, "x"]) assert.equal(C.bridgeCall(m), null);
  // and what does pass still meets the main process's own verb list (3a): a signing or wallet verb is refused there
  require("./dexicon-mock.cjs");
  const { dexCommand } = require("../main/dexicon.js");
  for (const c of ["send amount:1 address:0xAA", "consolidate tokenid:0x00", "vault action:seed", "backup file:x", "txnpost id:a auto:true", "block;send amount:1 address:0xAA", "keys action:list", "tokencreate name:x amount:1"])
    assert.throws(() => dexCommand(c), Error, c);
});

test("the page's bridge (renderer/dexicon/mds.js): every call is a message to the shell; unknown actions and unreviewed on-chain trades go nowhere", async () => {
  const vm = require("node:vm"), sent = [], calls = [];
  const els = {}, el = (id) => (els[id] = els[id] || { id, value: "", textContent: "", className: "", hidden: false, children: [], classList: { contains: () => false }, querySelector: () => null });
  const tradeBtn = { classList: { contains: () => false }, textContent: "" };
  el("trade").querySelector = () => tradeBtn;
  const listeners = {};
  const win = { console: { log() {}, error() {} }, document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, head: {}, createElement: () => ({}) }, navigator: {}, setInterval() {}, JSON, Object, Array, String, Number, Promise, Error,
    parent: { postMessage: (m) => sent.push(m) }, addEventListener: (t, f) => { listeners[t] = f; },
    // the page's own globals the driver calls (ui/pd_app.js, ui/app.js), recorded
    state: { block: 100, book: [], pools: [] }, chooseSide: (b) => calls.push("side:" + b), preview: () => calls.push("preview"), place: () => { calls.push("place"); if (win.pageAsks) calls.push("confirmed:" + win.confirm(win.pageAsks)); },
    cancel: (id) => calls.push("cancel:" + id + ":" + win.confirm("?")), editOrder: (id) => calls.push("edit:" + id + ":" + win.prompt("?")), send: (t) => calls.push("send:" + t),
    DexiconFast: { setMode: (f) => calls.push("fast:" + f), refreshPreview() {}, cancelOrder: (id) => calls.push("cancelFast:" + id + ":" + win.confirm("?")), editOrder: (id) => calls.push("editFast:" + id + ":" + win.prompt("?")),
      addRelay: (u) => calls.push("addRelay:" + u), removeRelay() {}, discover() {}, refresh() {}, myId: () => "id", myIdError: () => "" },
    PandaComposite: { plan: () => ({}), isEmpty: () => !win.crosses, poolCount: () => (win.crosses ? 1 : 0) }, PandaBook: { plan: () => ({ takes: [] }) } };
  win.DexiconMaker = { open: () => calls.push("mmOpen"), stop: () => calls.push("mmStop:" + win.confirm("?")), review: () => calls.push("mmReview") };
  win.localStorage = { setItem: (k, v) => calls.push("ls:" + k + "=" + v), getItem: () => null }; win.applyTheme = () => {};
  win.document.createElement = () => ({}); win.document.head = { appendChild: (el_) => { win.pageStyle = el_.textContent; } };
  win.window = win; win.parent.window = win.parent;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/mds.js"), "utf8"), win);
  const say = (data) => listeners.message({ source: win.parent, data });
  const reply = () => sent.filter(m => m.driven != null).pop();

  win.MDS.cmd("balance", () => {}); win.MDS.sql("SELECT 1", () => {}); win.MDS.comms.solo("{}", () => {});
  const x = new win.XMLHttpRequest(); x.open("GET", "https://relay.example/dex-relay/dex/book?market=x"); x.send(null);
  assert.deepEqual(sent.map(m => m.name + ":" + m.args.op), ["room.dex:cmd", "room.dex:sql", "room.dex:comms", "room.dex:net"], "node, store, service and relay traffic all go through the one bridge");
  await assert.rejects(win.fetch("https://example.com"), /no network/);
  assert.equal(win.confirm("anything"), false, "outside a driven action the page's confirm is always No");
  assert.equal(win.prompt("anything"), null);

  say({ dxRoom: 1, drive: { id: 1, act: "eval", args: {} } });
  assert.match(reply().error, /not an action of the Exchange screens: eval/); assert.deepEqual(calls, []);
  listeners.message({ source: {}, data: { dxRoom: 1, drive: { id: 2, act: "refresh", args: {} } } });
  assert.deepEqual(calls, [], "a message that is not from the shell is ignored");

  say({ dxRoom: 1, drive: { id: 3, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "fast" } } });
  assert.deepEqual(calls, ["side:true", "fast:true", "preview", "place"]); assert.equal(reply().error, null);
  assert.deepEqual([el("price").value, el("amount").value], ["0.0032", "10"], "the amounts reach the page as typed");
  calls.length = 0;
  for (const bad of [{ price: "1e3", amount: "1", layer: "fast" }, { price: "0.1", amount: "-1", layer: "fast" }, { price: "0.1", amount: "1", layer: "both" }]) { say({ dxRoom: 1, drive: { id: 4, act: "place", args: bad } }); assert.ok(reply().error, JSON.stringify(bad)); }
  assert.deepEqual(calls, [], "a bad price, amount or layer never reaches place()");

  // on-chain: no rounding, nothing that crosses nothing, and the page's own review word for word
  say({ dxRoom: 1, drive: { id: 5, act: "place", args: { buy: true, price: "0.0032001", amount: "10", layer: "chain" } } });
  assert.match(reply().error, /at most 6 decimals\. Nothing was sent\./);
  say({ dxRoom: 1, drive: { id: 6, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain" } } });
  assert.match(reply().error, /Nothing on the chain crosses this price now\. Nothing was sent\./);
  assert.ok(!calls.includes("place"));
  win.AX = { ownskip: { onlyOwn: (book, pools, buy, minima, price, block) => (calls.push("onlyOwn:" + [buy, minima, price, block].join(",")), "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.") } };
  say({ dxRoom: 1, drive: { id: 61, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain" } } });
  assert.equal(reply().error, "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.", "only own orders inside the limit: the engine's own sentence");
  assert.deepEqual(calls.splice(calls.indexOf("onlyOwn:true,10,0.0032,100")), ["onlyOwn:true,10,0.0032,100"]); assert.ok(!calls.includes("place"));
  win.AX = undefined;
  win.crosses = true; win.pageAsks = "Buying 10 MINIMA now\nEffective 0.003200";
  say({ dxRoom: 1, drive: { id: 7, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain" } } });
  assert.equal(calls.pop(), "confirmed:false", "first call: the page asks, the answer is No, nothing is sent");
  assert.equal(reply().asked, win.pageAsks, "and its review text comes back for the native dialog");
  say({ dxRoom: 1, drive: { id: 8, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain", reviewed: "Buying 9 MINIMA now" } } });
  assert.equal(calls.pop(), "confirmed:false", "a review of a different trade (the book moved) confirms nothing");
  say({ dxRoom: 1, drive: { id: 9, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain", reviewed: win.pageAsks } } });
  assert.equal(calls.pop(), "confirmed:true", "the same text back: confirmed");
  assert.equal(win.confirm(win.pageAsks), false, "and the answer does not outlive the call");

  calls.length = 0;
  say({ dxRoom: 1, drive: { id: 10, act: "cancelFast", args: { orderId: "f3a91c07d2b84e65" } } });
  say({ dxRoom: 1, drive: { id: 11, act: "editChain", args: { coinid: "0xAB12", price: "0.0035" } } });
  say({ dxRoom: 1, drive: { id: 12, act: "cancelChain", args: { coinid: "0xAB12'); alert(1); ('" } } });
  assert.deepEqual(calls, ["cancelFast:f3a91c07d2b84e65:true", "edit:0xAB12:0.0035"], "an id that is not an id is refused");
  // the market maker's own dialogs are the only part of the page ever shown: everything else is hidden by the bridge's style
  assert.match(win.pageStyle, /main>:not\(dialog\)\{display:none!important\}/);
  calls.length = 0;
  say({ dxRoom: 1, drive: { id: 13, act: "makerOpen", args: { light: true } } }); say({ dxRoom: 1, drive: { id: 14, act: "makerStop", args: {} } });
  assert.deepEqual(calls, ["ls:dexicon_theme=DAYLIGHT", "mmOpen", "mmStop:true"], "the dialog opens in Dexicon's current theme; Stop was confirmed on the native screen");
  // a packet the host refuses comes back to the page as the service's own ERROR, not as silence
  let told = null; win.MDS.init((m) => { told = m; });
  const comms = sent.filter(m => m.name === "room.dex" && m.args.op === "comms").pop();
  say({ dxRoom: 1, id: comms.id, error: "bad message" });
  await new Promise(r => setImmediate(r));
  assert.equal(JSON.parse(told.data.message).data.message, "bad message");
  assert.equal(JSON.parse(told.data.message).type, "ERROR");
});

test("the page is served from two pinned folders and nowhere else; its frame has no network", () => {
  const { roomFile, CSP } = require("../main/dexicon-room.js");
  const rel = (f) => f && path.relative(path.join(__dirname, ".."), f);
  assert.equal(rel(roomFile("exchange", "/index.html")), path.join("renderer", "dexicon", "index.html"));
  assert.equal(rel(roomFile("exchange", "/mds.js")), path.join("renderer", "dexicon", "mds.js"));
  assert.equal(rel(roomFile("exchange", "/ui/app.js")), path.join("renderer", "dexicon", "ui", "app.js"));
  assert.equal(rel(roomFile("exchange", "/lib/fill.js")), path.join("main", "dexicon", "lib", "fill.js"), "engine files come from the vendored engine");
  assert.equal(rel(roomFile("exchange", "/lib/calm.js")), path.join("renderer", "dexicon", "lib", "calm.js"));
  for (const no of ["/doors/engine.js", "/lib/door.js", "/../app.js", "/..%2Fapp.js", "/%2e%2e/app.js", "/service.desktop.js", "/loader.js", "/lib/../loader.js", "/ui/", "/", "/ui/app.js%00.html", "/lib/fill.js.map", "//etc/passwd", "/ui\\app.js"])
    assert.equal(roomFile("exchange", no), null, no);
  assert.equal(roomFile("rooms", "/index.html"), null, "one host only");
  assert.match(CSP, /default-src 'none'/); assert.match(CSP, /connect-src 'none'/); assert.ok(!/https:|wss:|http:/.test(CSP), "no network source at all");
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), /frame-src dxroom:;/);
  require("node:child_process").execFileSync(process.execPath, [path.join(__dirname, "dexicon-page-manifest.cjs"), "--verify"]);   // throws on a changed, missing or stray page file
});

test("the page's relay traffic passes the host's allow-list: the engine's relays, https, and never the price host", async () => {
  const M = require("./dexicon-mock.cjs"), os = require("node:os");
  const dexicon = require("../main/dexicon.js"), net = M.mockNet(), node = M.mockNode();
  const host = dexicon.makeHost({ quiet: true, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "dx-ui-")), runner: node.run, net, tickMs: 3600000 });
  node.attach(host);
  assert.deepEqual(await host.command({ op: "net", method: "GET", url: "https://eurobuddha.com/dex-relay/dex/book?market=x&since=0&hold=0" }), { status: false, error: "host not allowed" }, "before the engine is up: nothing");
  await host.start(); await M.until(() => host.status().ready);
  const relay = host.status().relays[0];
  const ok = await host.command({ op: "net", method: "GET", url: relay + "/dex/book?market=MINIMA&since=0&hold=0" });
  assert.equal(ok.status, true); assert.equal(typeof ok.response, "string", "text, as an XMLHttpRequest gives it");
  assert.equal((await host.command({ op: "net", method: "POST", url: relay + "/dex/msg", body: "{}" })).status, true);
  const before = net.calls.length;
  for (const url of ["https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT", "https://evil.example/dex/book", relay.replace("https:", "http:") + "/dex/book", relay + "/../admin", relay + ".evil.example/dex/book", "file:///etc/passwd", "http://127.0.0.1:9005/status", ""])
    assert.deepEqual(await host.command({ op: "net", method: "GET", url }), { status: false, error: "host not allowed" }, url);
  assert.equal(net.calls.length, before, "a refused URL never reaches the network");
  host.stop();
  assert.deepEqual(M.leaks, [], "the real rpcCall and the real network were never reached");
});

// ---------------------------------------------------------------- Orders and History (0.18.102)
const FILLS = [
  { role: "taker", orderId: "0xa81b", side: "buy", price: "0.00316983", filled: "1200", gave: "3.803796", got: "1200", txpowid: "0x7A", coins: ["0xC8", "0xC9"], maker: "0xD7", ts: 1763560000, status: "settling" },
  { role: "maker", orderId: "0xf3a9", side: "buy", price: "0.0029", filled: "749.5", received: "749.5", paid: "2.17355", txpowid: "0x7B", coins: ["0xCA"], taker: "0xD8", ts: 1763550000, block: 2428031, status: "done" },
  { role: "taker", orderId: "0xc2d4", side: "sell", price: "0.0031", filled: "300", gave: "300", got: "0.93", txpowid: "0x7C", coins: [], maker: "0xD9", ts: 1763470000, status: "lost" },
  { role: "taker", orderId: "0xe5f6", side: "sell", price: "0.0032", filled: "1000", gave: "1000", got: "3.2", txpowid: "0x7D", coins: ["0xCB"], maker: "=HYPERLINK(1)", ts: 1763460000, block: 2427000, status: "done" }];

test("a fill that is posted and waiting for a block is not done", () => {
  assert.deepEqual(C.fillState(FILLS[0]), { chip: "WAITING", tone: "live", text: "co-signed and posted, waiting for a block: not final yet" });
  assert.deepEqual(C.fillState(FILLS[1]), { chip: "DONE", tone: "ok", text: "in block 2428031" });
  assert.equal(C.fillState(FILLS[2]).chip, "LOST"); assert.match(C.fillState(FILLS[2]).text, /the coins were not spent/);
  assert.equal(C.fillState({ status: "" }).chip, "WAITING", "an unknown state is never shown as done");
  assert.equal(C.fillState({ status: "unknown" }).chip, "UNKNOWN"); assert.match(C.fillState({ status: "unknown" }).text, /not known yet/);
  assert.match(C.fillState({ status: "lost", reason: "this node's coin in it is unspent and not in the mempool" }).text, /never posted/);
});

test("History: the net counts settled fills only, with the exact MxUSD leg of each", () => {
  const n = C.netSettled(FILLS);
  assert.deepEqual([n.count, n.done], [4, 2]);
  assert.deepEqual(n.minima, { sign: -1, text: "−250.5" }, "+749.5 bought, 1000 sold; the waiting and the lost fill are not counted");
  assert.deepEqual(n.mxusd, { sign: 1, text: "+1.02645" }, "-2.17355 paid, +3.2 received");
  assert.equal(C.fmt(C.fillUsd(FILLS[0])), "3.803796", "the taker's record: what it gave");
  assert.equal(C.fmt(C.fillUsd({ side: "sell", role: "maker", filled: "10", price: "0.003" })), "0.03", "no recorded leg: amount x price, exact");
  assert.deepEqual(C.netSettled([]).minima, { sign: 0, text: "0" });
});

test("the CSV is the Android export column for column, values whole", () => {
  const lines = C.csv(FILLS).trim().split("\n");
  assert.equal(lines[0], "timestamp_utc,block,side,role,minima_delta,mxusd_delta,minima_amount,price,mxusd_notional,order_id,txpowid,proceeds_coinids,counterparty,status");
  assert.equal(C.CSV_HEADER, lines[0]);
  const android = path.join(__dirname, "../../../apks/dexicon/app/src/main/java/com/eurobuddha/dexicon/TradeExport.java");   // beside this repo on the owner's machine; not in CI
  if (fs.existsSync(android)) assert.ok(fs.readFileSync(android, "utf8").replace(/"\s*\+\s*"/g, "").includes(C.CSV_HEADER), "the same header as TradeExport.java");
  assert.equal(lines[1], "2025-11-19T13:46:40Z,,BUY,TAKER,1200,-3.803796,1200,0.00316983,3.803796,0xa81b,0x7A,0xC8 0xC9,0xD7,settling");
  assert.equal(lines[2], "2025-11-19T11:00:00Z,2428031,BUY,MAKER,749.5,-2.17355,749.5,0.0029,2.17355,0xf3a9,0x7B,0xCA,0xD8,done");
  assert.equal(lines[3].split(",").slice(2, 6).join(","), "SELL,TAKER,-300,0.93");
  assert.match(lines[4], /,'=HYPERLINK\(1\),done$/, "a cell a spreadsheet would run is defused; a negative number is left a number");
});

test("day headers and ages", () => {
  const now = new Date(2026, 10, 19, 15, 0).getTime();
  assert.equal(C.dayLabel(new Date(2026, 10, 19, 0, 5).getTime(), now), "TODAY · 19 NOV");
  assert.equal(C.dayLabel(new Date(2026, 10, 18, 23, 59).getTime(), now), "18 NOV");
  assert.equal(C.dayLabel(new Date(2025, 11, 31).getTime(), now), "31 DEC 2025");
  assert.deepEqual([C.ago(59999), C.ago(60000), C.ago(7199999), C.ago(86400000 * 2)], ["59s ago", "1 minute ago", "1 hour ago", "2 days ago"], "cut down, never rounded up");
});

// ---------------------------------------------------------------- Activity, Assets, Settings (0.18.103)
test("Activity uses the engine's own stage machine: posted, co-signed or in a shallow block is never DONE", () => {
  require("../renderer/dexicon/lib/activity.js");   // the verbatim, pure file the shell loads (pinned by the page manifest)
  const A = globalThis.AX.activity, tip = 1000;
  assert.equal(A.chip({ route: "FAST", stage: "SENT" }, tip), "SENT");
  assert.equal(A.chip({ route: "FAST", stage: "COSIGNED" }, tip), "CO-SIGNED", "co-signed and posted: not done");
  assert.match(A.status({ route: "FAST", stage: "COSIGNED", cosignMs: 2300, postBlock: 999 }, tip, 0), /waiting for a block/);
  assert.equal(A.chip({ route: "FAST", stage: "COSIGNED", block: 999 }, tip), "SETTLING", "one confirmation: still not done");
  assert.equal(A.chip({ route: "FAST", stage: "COSIGNED", block: 997 }, tip), "DONE", "three confirmations");
  assert.equal(A.chip({ route: "POOL", stage: "POSTED" }, tip), "POSTED"); assert.equal(A.chip({ route: "POOL", stage: "POSTED", block: 990 }, tip), "CONFIRMED");
  assert.equal(A.status({ stage: "REFUSED", reason: "coin 0xAB is already spent" }, tip, 0), "Refused by the maker — coin 0xAB is already spent", "the engine's real reason, whole");
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), /<script src="dexicon\/lib\/activity\.js"><\/script>/);
});

test("Settings: a relay the desktop cannot reach is refused before anything is saved", () => {
  assert.equal(C.relayProblem("https://relay.example/dex-relay"), "");
  assert.equal(C.relayProblem("https://relay.example:9602"), "");
  assert.match(C.relayProblem("http://relay.example:19702"), /must be an https address\. Nothing was added\./);
  for (const local of ["https://localhost:9602", "https://127.0.0.1/dex", "https://192.168.1.5/dex", "https://10.0.0.2/dex"]) assert.match(C.relayProblem(local), /this machine or the local network/, local);
  assert.match(C.relayProblem("https://user:pw@relay.example/dex"), /no user name/);
  assert.match(C.relayProblem("relay.example"), /Enter a relay address/); assert.match(C.relayProblem(""), /Enter a relay address/);
});
