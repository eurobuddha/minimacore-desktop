// Dexicon's screens (Phase 3b): the logic in renderer/dexicon-core.js, run here; nothing in this file reads source
// text to decide a result, except where a constant must equal a committed file.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const C = require("../renderer/dexicon-core.js");

test("rooms: three, in the phone's order; Exchange has the phone's six tabs", () => {
  assert.deepEqual(C.ROOMS.map(r => r.n + " " + r.label), ["① MxUSD", "② Pools", "③ Exchange"]);
  assert.deepEqual(C.ROOMS[2].tabs.map(t => C.TAB_LABEL[t]), ["Trade", "Orders", "History", "Activity", "Assets", "Settings"]);
  assert.deepEqual([C.ROOMS[0].view, C.ROOMS[1].view], ["atomix", "pandapools"]);
  assert.deepEqual(C.ROOMS[1].tabs.map(t => C.TAB_LABEL[t]), ["Swap", "Pools", "My LP", "Wallet", "Activity"], "room 2 is PandaPools' five tabs");   // scripts/dexicon-pp.test.cjs; room 1: scripts/dexicon-ax.test.cjs
});

test("each room remembers its last tab; Dexicon opens on room 1, in the app's theme (0.19.379)", () => {
  assert.equal(C.load(null, true).theme, "DAYLIGHT", "the app is light: Dexicon starts light");
  assert.equal(C.load('{"theme":"ONYX"}', true).theme, "DAYLIGHT", "a theme Dexicon saved before is not read: the app's wins");
  assert.equal(C.load('{"theme":"DAYLIGHT"}', false).theme, "ONYX", "the app is dark: Dexicon starts dark");
  assert.equal(C.followApp(C.toggleTheme(C.load(null, false)), false).theme, "ONYX", "the sun's choice lasts until the app's theme changes");
  assert.equal(C.followApp(C.load(null, false), true).theme, "DAYLIGHT");
  assert.ok(!/theme/.test(C.save(C.load(null, true))), "no theme of its own is saved");
  let mem = C.load(null);
  assert.equal(mem.room, 0); assert.equal(mem.theme, "ONYX"); assert.equal(mem.tabs.exchange, "trade");
  C.pickRoom(mem, 2); C.pickTab(mem, "history");
  assert.equal(C.tabOf(mem), "history");
  C.pickRoom(mem, 1); assert.equal(C.tabOf(mem), "swap", "Pools opens on its own Swap");
  C.pickTab(mem, "orders"); assert.equal(mem.tabs.exchange, "history", "a tab of another room changes nothing");
  C.pickRoom(mem, 2); assert.equal(C.tabOf(mem), "history", "back in Exchange: the tab it was left on");
  C.toggleTheme(mem);
  const again = C.load(C.save(mem));
  assert.equal(again.room, 0, "a new start opens on room 1");
  assert.equal(again.tabs.exchange, "history"); assert.equal(again.theme, "ONYX", "a new start is in the app's theme, not the sun's last choice");
  assert.equal(C.toggleTheme(again).theme, "DAYLIGHT");
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
  assert.match(String(C.PAGE_FAILED), /did not load, so a trade cannot be sent from here right now\. The app is trying again/);   // a text fixed at load is a String that translates when shown
});

test("the screens' code makes the frame without any visit to Dexicon, keeps it across tabs, remakes it after an engine restart, and says so when it cannot load", async () => {
  const vm = require("node:vm");
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() { e.parent.children.splice(e.parent.children.indexOf(e), 1); e.removed = true; }, querySelectorAll: () => [], querySelector: () => null }; return e; };
  const els = {}, timers = [], listeners = {}; let clock = 1000000, status = { version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {} }, service = null, asked = 0;
  const win = { DexCore: C, DexPools: { tick() {}, render() {}, shared() {}, part: () => "" }, DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false }, console, JSON, Promise, setInterval: (fn) => { timers.push(fn); }, setTimeout, localStorage: { getItem: () => null, setItem() {} },
    Date: class extends Date { static now() { return clock; } },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null },
    addEventListener: (t, f) => { listeners[t] = f; } };
  win.window = win; win.mcd = { dxStatus: async () => { asked++; if (!status) throw new Error("no answer"); return status; }, onDexicon: (f) => { service = f; }, clip: async () => true, dxCommand: async () => ({}) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
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
  assert.deepEqual(C.ACTS, ["place", "cancelFast", "editFast", "cancelChain", "editChain", "addRelay", "removeRelay", "discover", "refresh", "makerOpen", "makerStop", "makerReview", "quote", "sweepFast", "sweepChain"]);
  for (const act of ["send", "consolidate", "eval", "txnsign", "__proto__", "constructor", ""]) assert.throws(() => C.driveCall(1, act, {}), /not an action of the Exchange screens/, act);
  assert.deepEqual(C.driveCall(7, "place", { buy: true }), { dxRoom: 1, drive: { id: 7, act: "place", args: { buy: true } } });
  // from the page's frame: only the four bridge ops, each rebuilt from its named fields (nothing else rides along)
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 1, name: "room.dex", args: { op: "cmd", command: "block", extra: "x", fn: "axSend" } }), { kind: "dx", args: { op: "cmd", command: "block" } });
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 2, name: "room.dex", args: { op: "net", method: "DELETE", url: "https://x/dex/book", body: null } }).args, { op: "net", method: "GET", url: "https://x/dex/book", body: null });
  for (const m of [{ dxRoom: 1, id: 1, name: "room.dex", args: { op: "invalidate" } }, { dxRoom: 1, id: 1, name: "room.ax", args: { op: "cmd", command: "block" } }, { dxRoom: 1, id: 1, name: "mcd.cmd", args: {} },
    { dxRoom: 2, id: 1, name: "room.dex", args: { op: "cmd" } }, { dxRoom: 1, id: "1", name: "room.dex", args: { op: "cmd" } }, { dxRoom: 1, id: 1, name: "room.dex" }, null, "x"]) assert.equal(C.bridgeCall(m), null);
  // 0.19.229: the page's copy is refused (it never reaches the clipboard), and answered so its promise ends
  assert.deepEqual(C.bridgeCall({ dxRoom: 1, id: 9, name: "clip", args: { text: "MxATTACKERADDRESS" } }), { kind: "noclip" });
  const uiSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "dexicon-ui.js"), "utf8");
  assert.ok(/if \(call\.kind === "noclip"\) \{ back\(null, "copying is done from the app's own screens"\); return; \}/.test(uiSrc) && !/api\.clip\(call\.text\)/.test(uiSrc), "no clipboard write for the frame");
  // and what does pass still meets the main process's own verb list (3a): a signing or wallet verb is refused there
  require("./dexicon-mock.cjs");
  const { dexCommand } = require("../main/dexicon.js");
  for (const c of ["send amount:1 address:0xAA", "consolidate tokenid:0x00", "vault action:seed", "backup file:x", "txnpost id:a auto:true", "block;send amount:1 address:0xAA", "keys action:list", "tokencreate name:x amount:1"])
    assert.throws(() => dexCommand(c), Error, c);
});

/** renderer/dexicon/mds.js on a stand-in page: the page's own globals the driver calls are recorded in `calls`. */
function bridge() {
  const vm = require("node:vm"), sent = [], calls = [];
  const els = {}, el = (id) => (els[id] = els[id] || { id, value: "", textContent: "", className: "", hidden: false, children: [], classList: { contains: () => false }, querySelector: () => null });
  const tradeBtn = { classList: { contains: () => false }, textContent: "" };
  el("trade").querySelector = () => tradeBtn;
  const listeners = {};
  const win = { console: { log() {}, error() {} }, document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, head: {}, createElement: () => ({}) }, navigator: {}, setInterval() {}, JSON, Object, Array, String, Number, Promise, Error,
    parent: { postMessage: (m) => sent.push(m) }, addEventListener: (t, f) => { listeners[t] = f; },
    // the page's own globals the driver calls (ui/pd_app.js, ui/app.js), recorded
    state: { ready: true, block: 100, book: [], pools: [] }, chooseSide: (b) => calls.push("side:" + b), preview: () => calls.push("preview"), place: () => { calls.push("place"); if (win.pageAsks) calls.push("confirmed:" + win.confirm(win.pageAsks)); },
    cancel: (id) => calls.push("cancel:" + id + ":" + win.confirm("?")), editOrder: (id) => calls.push("edit:" + id + ":" + win.prompt("?")), send: (t) => calls.push("send:" + t),
    DexiconFast: { setMode: (f) => calls.push("fast:" + f), refreshPreview() {}, cancelOrder: (id) => calls.push("cancelFast:" + id + ":" + win.confirm("?")), editOrder: (id) => calls.push("editFast:" + id + ":" + win.prompt("?")),
      addRelay: (u) => calls.push("addRelay:" + u), removeRelay() {}, discover() {}, refresh() {}, myId: () => "id", myIdError: () => "" },
    PandaComposite: { plan: () => ({}), isEmpty: () => !win.crosses, poolCount: () => (win.crosses ? 1 : 0) }, PandaBook: { plan: () => ({ takes: [] }) } };
  win.DexiconMaker = { open: () => calls.push("mmOpen"), stop: () => calls.push("mmStop:" + win.confirm("?")), review: () => calls.push("mmReview") };
  win.localStorage = { setItem: (k, v) => calls.push("ls:" + k + "=" + v), getItem: () => null }; win.applyTheme = () => {};
  win.document.createElement = () => ({}); win.document.head = { appendChild: (el_) => { win.pageStyle = el_.textContent; } };
  win.window = win; win.parent.window = win.parent;
  // the engine's own decimal and take rule (the page loads the same two files), and a FAST book the test sets
  Object.assign(win, require("./i18n-plain.cjs").globals()); vm.createContext(win);
  for (const f of ["vendor/decimal.js", "lib/fill.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../main/dexicon", f), "utf8"), win);
  win.fastOrders = [];   // { side, price, amount }: other makers' backed orders, as ui/app.js crossing() sees them
  win.DexiconFast.crossing = (isBuy, price) => win.fastOrders.filter(o => (isBuy ? o.side === "sell" && Number(o.price) <= Number(price) : o.side === "buy" && Number(o.price) >= Number(price)))
    .sort((x, y) => (isBuy ? Number(x.price) - Number(y.price) : Number(y.price) - Number(x.price)));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/mds.js"), "utf8"), win);
  const say = (data) => listeners.message({ source: win.parent, data });
  const reply = () => sent.filter(m => m.driven != null).pop();
  return { win, sent, calls, el, tradeBtn, listeners, say, reply };
}

test("the page's bridge (renderer/dexicon/mds.js): every call is a message to the shell; unknown actions and unreviewed on-chain trades go nowhere", async () => {
  const { win, sent, calls, el, listeners, say, reply } = bridge();

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

  say({ dxRoom: 1, drive: { id: 3, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "fast", expect: "rest" } } });
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
  const realAX = win.AX; win.AX = { ownskip: { onlyOwn: (book, pools, buy, minima, price, block) => (calls.push("onlyOwn:" + [buy, minima, price, block].join(",")), "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.") } };
  say({ dxRoom: 1, drive: { id: 61, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain" } } });
  assert.equal(reply().error, "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.", "only own orders inside the limit: the engine's own sentence");
  assert.deepEqual(calls.splice(calls.indexOf("onlyOwn:true,10,0.0032,100")), ["onlyOwn:true,10,0.0032,100"]); assert.ok(!calls.includes("place"));
  win.AX = realAX;
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

// 0.18.118 (H1): the native review and the page's book were two books. "BUY 100 from 1 FAST ask, no order is placed"
// could publish a RESTING order when that ask had gone from the page's book, and "nothing is traded now" could take.
test("H1: place signs only what was reviewed: the page's own crossing() is asked again at the click, and a reviewed take can never become a resting order", () => {
  const { win, calls, say, reply, tradeBtn } = bridge();
  const fast = (o) => say({ dxRoom: 1, drive: { id: 1, act: "place", args: Object.assign({ buy: true, price: "0.0032", amount: "100", layer: "fast" }, o) } });
  const CHANGED = "The book changed since you reviewed this. Review it again. Nothing was signed.";
  // reviewed: BUY 100 from one ask of 250 @ 0.0031. The ask is gone from the page's book at the click.
  win.fastOrders = [];
  fast({ expect: "take", take: "100", worst: "0.0031" });
  assert.equal(reply().error, CHANGED); assert.ok(!calls.includes("place"), "nothing was signed: no resting order instead of the take");
  // reviewed: nothing crosses, the order rests. An ask has arrived at the click: it would be an immediate take.
  win.fastOrders = [{ side: "sell", price: "0.0031", amount: "250" }];
  fast({ expect: "rest" });
  assert.equal(reply().error, CHANGED); assert.ok(!calls.includes("place"));
  // no statement of what was reviewed: refused (an older screen, or anything else that drives the page)
  fast({}); assert.equal(reply().error, CHANGED);
  // the book still says what was reviewed: it goes through
  fast({ expect: "take", take: "100", worst: "0.0031" });
  assert.equal(reply().error, null); assert.equal(calls.filter(c => c === "place").length, 1);
  const done = () => { tradeBtn.classList.contains = () => true; say({ dxRoom: 1, drive: { id: 9, act: "refresh", args: {} } }); tradeBtn.classList.contains = () => false; say({ dxRoom: 1, drive: { id: 9, act: "refresh", args: {} } }); };
  done();   // the sweep ran (the page locked its button) and ended
  // another amount or another worst price than reviewed: refused. (two asks: 60 @ 0.0031 and 250 @ 0.0032)
  calls.length = 0; win.fastOrders = [{ side: "sell", price: "0.0031", amount: "60" }, { side: "sell", price: "0.0032", amount: "250" }];
  for (const o of [{ expect: "take", take: "100", worst: "0.0031" }, { expect: "take", take: "60", worst: "0.0031" }, { expect: "take", take: "100", worst: "0.00320001" }, { expect: "take", take: "1e2", worst: "0.0032" }, { expect: "rest" }]) {
    fast(o); assert.equal(reply().error, CHANGED, JSON.stringify(o));
  }
  assert.ok(!calls.includes("place"));
  // the same two asks, reviewed as they are: 60 whole, then 40 of the 250
  fast({ expect: "take", take: "100", worst: "0.0032" }); assert.equal(reply().error, null); done();
  // the minimum remainder is the engine's own rule (lib/fill.js floorTake): 250.5 wanted of 60 + 191 takes 60 + 190
  win.fastOrders[1].amount = "191";
  fast({ amount: "250.5", expect: "take", take: "250.5", worst: "0.0032" }); assert.equal(reply().error, CHANGED);
  fast({ amount: "250.5", expect: "take", take: "250", worst: "0.0032" }); assert.equal(reply().error, null);
});

test("H1/H2: a reviewed take cannot rest, one money action at a time, and the page reports its book and its own amount", async () => {
  const { win, calls, say, reply, tradeBtn, listeners, sent, el } = bridge();
  let created = 0;
  win.AX.maker = { create: (mds, client, me, spec, cb) => { created++; win.pendingCreate = () => cb(null, { orderId: "x" }, []); } };
  win.MDS.init(() => {}); listeners.load();                       // the page has loaded: the guard is on AX.maker.create
  const fast = (o) => say({ dxRoom: 1, drive: { id: 1, act: "place", args: Object.assign({ buy: true, price: "0.0032", amount: "100", layer: "fast" }, o) } });
  // a take is running (the stand-in place() starts a sweep that then finds nothing and wants to rest the full amount)
  win.fastOrders = [{ side: "sell", price: "0.0031", amount: "250" }];
  let err = "unset"; win.place = () => { calls.push("place"); win.AX.maker.create(null, null, null, { side: "buy", price: "0.0032", amount: "100" }, (e) => { err = e && e.message; }); };
  fast({ expect: "take", take: "100", worst: "0.0031" });
  assert.equal(created, 0, "no order was published in place of the reviewed take"); assert.match(err, /book changed.*No order was placed and nothing was signed/);
  // H2: while it runs, a second click (place, cancel, edit, stop) starts nothing
  const page = () => sent.filter(m => m.page).pop().page;
  assert.equal(page().trading, true, "said to the screens at once, before the page has locked its own button");
  calls.length = 0;
  for (const d of [{ act: "place", args: { buy: true, price: "0.0032", amount: "100", layer: "fast", expect: "take", take: "100", worst: "0.0031" } }, { act: "cancelFast", args: { orderId: "ab12" } }, { act: "editFast", args: { orderId: "ab12", price: "0.1" } }, { act: "makerStop", args: {} }]) {
    say({ dxRoom: 1, drive: Object.assign({ id: 2 }, d) }); assert.match(reply().error, /still running\. Wait for it to finish\. Nothing was signed\./, d.act);
  }
  assert.deepEqual(calls, []);
  // the page locks its button for the sweep, then unlocks: free again
  tradeBtn.classList.contains = () => true; say({ dxRoom: 1, drive: { id: 3, act: "refresh", args: {} } });
  tradeBtn.classList.contains = () => false; say({ dxRoom: 1, drive: { id: 3, act: "refresh", args: {} } });
  assert.equal(page().trading, false);
  // a reviewed RESTING order: published, and "running" until the engine has answered
  win.fastOrders = []; win.place = () => { calls.push("place"); win.AX.maker.create(null, null, null, {}, () => { calls.push("published"); }); };
  fast({ expect: "rest" }); assert.equal(reply().error, null); assert.equal(created, 1);
  fast({ expect: "rest" }); assert.match(reply().error, /still running/, "a double click does not publish the order twice");
  assert.equal(created, 1);
  win.pendingCreate(); assert.ok(calls.includes("published"));
  fast({ expect: "rest" }); assert.equal(reply().error, null); assert.equal(created, 2, "free again once it is published");
  win.pendingCreate();
  // the report carries the page's own FAST book (what a click will act on) and its own amount field
  win.fastOrders = [{ side: "sell", price: "0.0031", amount: "250" }, { side: "buy", price: "0.003", amount: "40" }];
  el("amount").value = "37.5"; say({ dxRoom: 1, drive: { id: 4, act: "refresh", args: {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(page().fast)), [{ side: "sell", price: "0.0031", minima: "250" }, { side: "buy", price: "0.003", minima: "40" }]);
  assert.equal(page().amount, "37.5");
});

// 0.18.119 (M1): the page asks for a 25 s hold; netfetch ends a request after 15 s without a byte. Every quiet poll
// failed, the relay was marked down, and the screens said "no relay answers" on a quiet book.
test("M1: a long poll's hold is cut below the app's idle limit, so a quiet relay answers in time", () => {
  const { win, sent } = bridge();
  const get = (url, method) => { const x = new win.XMLHttpRequest(); x.open(method || "GET", url); x.send(method ? "{}" : null); return sent.filter(m => m.name === "room.dex" && m.args.op === "net").pop().args.url; };
  const R = "https://relay.example/dex-relay";
  assert.equal(get(R + "/dex/inbox?pk=ab&since=7&hold=25"), R + "/dex/inbox?pk=ab&since=7&hold=10");
  assert.equal(get(R + "/dex/book?market=MINIMA%2FMxUSD&since=0&hold=25"), R + "/dex/book?market=MINIMA%2FMxUSD&since=0&hold=10");
  assert.equal(get(R + "/dex/book?market=x&since=0&hold=0"), R + "/dex/book?market=x&since=0&hold=0", "a plain read is left alone");
  assert.equal(get(R + "/dex/inbox?pk=ab&since=7&hold=8"), R + "/dex/inbox?pk=ab&since=7&hold=8");
  assert.equal(get(R + "/dex/msg?hold=25", "POST"), R + "/dex/msg?hold=25", "only a GET is a poll");
  // the two numbers this rests on: the hold (plus the relay's answer on its way) is under netfetch's idle limit, and
  // the request is still sorted into the host's POLL lane (main/dexicon.js netGet: hold=[1-9])
  const hold = Number(/var HOLD_MAX = (\d+);/.exec(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/mds.js"), "utf8"))[1]);
  const idle = Number(/const READ_TIMEOUT_MS = (\d+);/.exec(fs.readFileSync(path.join(__dirname, "../main/netfetch.js"), "utf8"))[1]);
  assert.ok(hold * 1000 + 4000 <= idle, hold + " s hold against a " + idle + " ms idle limit");
  assert.match("x?since=1&hold=" + hold, /[?&]hold=[1-9]/);
  // and the page's own 25 s is what is being cut (if the page ever asks for less, this guard is no longer needed)
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/ui/app.js"), "utf8"), /client\.pollInbox\(me\.publicId\(\), 25,/);
});

// ---------------------------------------------------------------- the low findings (0.18.121)
test("lows: 'pay at most' is the sum of the engine's per-take round-ups; a ladder Total is cut; a comma is never a number; the page's words reach Orders", () => {
  // two takes of 0.3 MINIMA at 0.00000005: each costs 0.000000015, which the engine rounds UP to 0.00000002 per transaction
  const book = C.tradeBook(null, [{ side: "sell", price: "0.00000005", minima: "0.3" }, { side: "sell", price: "0.00000005", minima: "0.3" }]);
  const buy = C.plan(book, true, "0.00000005", "0.6", C.funds("0", "1", [], []));
  assert.equal(C.fmt(buy.pay), "0.00000004", "0.00000002 twice, not the round-up of the sum (0.00000003)"); assert.equal(C.fmt(C.up(buy.cost, 8)), "0.00000003");
  assert.match(C.review(buy, 1).join(" "), /You pay at most 0\.00000004 MxUSD and receive 0\.6 MINIMA/);
  assert.equal(C.fmt(buy.need), "0.00000004", "and that is what the funds check asks for");
  const bids = C.tradeBook(null, [{ side: "buy", price: "0.00000005", minima: "0.3" }, { side: "buy", price: "0.00000005", minima: "0.3" }]);
  const sell = C.plan(bids, false, "0.00000005", "0.6", C.funds("1", "0", [], []));
  assert.match(C.review(sell, 1).join(" "), /receive at least 0\.00000002 MxUSD/, "0.00000001 twice (each rounded DOWN), not 0.00000003");
  // the ladder's Total column
  assert.equal(C.fmt(C.levelTotal({ price: d("0.0031"), total: d("33.3333") })), "0.1033", "0.10333323 cut, not 0.1034");
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8"), /class="dx-lt">\$\{C\.fmt\(C\.levelTotal\(lv\)\)\}</);
  // number entry
  for (const t of ["1,234.5", "1,5", ",", "1.234.5", "1..2"]) assert.match(C.entryProblem(t), /Nothing was changed\.$/, t);
  for (const t of ["", "1234.5", "0.00000001", "."]) assert.equal(C.entryProblem(t), "", t);
  const AX = require("../renderer/dexicon-ax.js");
  assert.deepEqual(["1,5", "1,234.5", "1.2.3", "12.5", "12a"].map(AX.cleanNum), ["", "", "", "12.5", "12"], "room 1: a comma was stripped, so 1,5 was fifteen");
  // what the page said, for Orders as for Trade
  assert.deepEqual(C.pageSays({ log: ["BUY 10"], notice: "Ladder not saved: no MEXC price", kind: "error" }, { stage: "Publishing fast order…" }), { lines: ["BUY 10", "Publishing fast order…", "Ladder not saved: no MEXC price"], error: true });
  assert.deepEqual(C.pageSays({ notice: "Welcome", kind: "" }, {}), { lines: [], error: false }, "idle chatter is not shown");
  assert.equal(C.pageSays({ notice: "Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.", kind: "error" }, null).error, false);
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8"), /const says = tab === "orders" \? C\.pageSays\(Page\.state, X\.svc\)/);
});

test("lows: changing an on-chain order's price takes at most 6 decimals, as placing one does", () => {
  const { calls, say, reply } = bridge();
  say({ dxRoom: 1, drive: { id: 1, act: "editChain", args: { coinid: "0xAB12", price: "0.0035001" } } });
  assert.equal(reply().error, "An on-chain order takes a price of at most 6 decimals. Nothing was changed."); assert.deepEqual(calls, []);
  say({ dxRoom: 1, drive: { id: 2, act: "editChain", args: { coinid: "0xAB12", price: "0.003501" } } });
  assert.equal(reply().error, null); assert.deepEqual(calls, ["edit:0xAB12:0.003501"]);
});

test("M4: what the user reviewed is told to the main process by the app's own window; the frame cannot say it", () => {
  assert.equal(C.bridgeCall({ dxRoom: 1, id: 1, name: "room.dex", args: { op: "reviewed", buy: true, price: "1000", amount: "1000000" } }), null, "the frame's bridge forwards its five ops and nothing else");
  assert.deepEqual(C.OPS, ["cmd", "sql", "comms", "net", "identity"]);
  const ui = fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8");
  assert.ok(ui.indexOf('api.dxCommand({ op: "reviewed", buy: X.buy, price, amount })') > 0 && ui.indexOf('api.dxCommand({ op: "reviewed"') < ui.indexOf('let r = await drive("place", args);'), "recorded before the page is driven");
});

test("H1: the Trade ticket plans on the page's book, and says what the click must still find", () => {
  const pageFast = [{ side: "sell", price: "0.0031", minima: "250" }];
  const b = C.tradeBook(BOOK, pageFast);
  assert.deepEqual(b.fast.map(o => o.price + (o.ours ? "*" : "")), ["0.0031", "0.0031*", "0.0029*"], "the page's orders, plus this node's own from the read model");
  assert.equal(C.tradeBook(BOOK, undefined), BOOK, "until the page has spoken: the read model");
  const take = C.plan(b, true, "0.0032", "100", FUNDS);
  assert.deepEqual(C.expectOf(take), { expect: "take", take: "100", worst: "0.0031" });
  // the service's book (BOOK) says 100 @ 0.0032 is on offer; the page's book has nothing: the plan is a resting order
  const rest = C.plan(C.tradeBook(BOOK, []), true, "0.0032", "100", FUNDS);
  assert.equal(rest.fast, false); assert.deepEqual(C.expectOf(rest), { expect: "rest" });
  // a crossing order that cannot be taken in this amount: the page would sweep and trade nothing, so no "rests as your order"
  const stuck = C.plan(C.tradeBook(null, [{ side: "sell", price: "0.0031", minima: "1" }]), true, "0.0032", "0.5", FUNDS);
  assert.equal(stuck.fast, true); assert.equal(stuck.stuck, true);
  assert.match(C.review(stuck, 3)[0], /none can be taken in this amount.*no order would be placed/);
  // the minimum remainder, as the engine's own floorTake: 250.5 wanted of 60 + 191 is 60 + 190 (the page's test above says the same)
  assert.equal(C.expectOf(C.plan(C.tradeBook(null, [{ side: "sell", price: "0.0031", minima: "60" }, { side: "sell", price: "0.0032", minima: "191" }]), true, "0.0032", "250.5", C.funds("1", "1000", [], []))).take, "250");
});

test("H2: the Trade button takes one click at a time, sends what was reviewed, and afterwards holds the page's own remaining amount", async () => {
  const vm = require("node:vm"), posted = [];
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage: (m) => posted.push(m) }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
  const els = {}, listeners = {};
  const status = { version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: ["https://relay.example/dex-relay"], price: {} };
  const win = { DexCore: C, DexPools: { tick() {}, render() {}, shared() {}, part: () => "" }, DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false }, console, JSON, Promise, setInterval() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, Date,
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener: (t, f) => { listeners[t] = f; } };
  win.window = win;
  win.mcd = { dxStatus: async () => status, onDexicon() {}, clip: async () => true, dxMine: async () => ({ orders: [], pending: [] }), dxCommand: async () => ({ status: true, rows: [] }),
    dxBook: async () => ({ fast: [{ side: "sell", price: "0.0032", minima: "999", ours: false }], book: [], poolAsks: [], poolBids: [], pools: [] }),   // the SERVICE's book: not what the page will act on
    cmd: async () => ({ status: true, response: [{ tokenid: "0x00", sendable: "1000" }, { tokenid: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", sendable: "10" }] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const shell = win.document.getElementById("shell"); shell.dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  win.DexUI.paint("dexicon"); win.DexUI.render(); await settle();
  const frame = shell.children.find(c => c.tag === "iframe"), page = (p) => listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, page: Object.assign({ ready: true, relays: [{ url: "https://relay.example/dex-relay", state: "ok" }], log: [], view: { ready: true, rev: 1, asks: [], bids: [], hidden: "" } }, p) } });
  page({ fast: [{ side: "sell", price: "0.0031", minima: "250" }], amount: "", trading: false });
  els.dxPrice.value = "0.0032"; els.dxAmount.value = "100"; els.dxPrice.oninput();
  assert.match(els.dxReview.innerHTML, /BUY 100 MINIMA from 1 FAST ask/); assert.equal(els.dxCta.disabled, false);
  const drives = () => posted.filter(m => m.drive);
  els.dxCta.onclick(); els.dxCta.onclick(); els.dxCta2.onclick();   // a double click, and the other button
  await settle();
  assert.equal(drives().length, 1, "one action, not two");
  assert.deepEqual(JSON.parse(JSON.stringify(drives()[0].drive.args)), { buy: true, price: "0.0032", amount: "100", layer: "fast", expect: "take", take: "100", worst: "0.0031" }, "what was reviewed, from the PAGE's book (the service's book said 0.0032)");
  assert.equal(els.dxCta.disabled, true); assert.equal(els.dxCta.innerHTML, "TRADING…");
  listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, driven: drives()[0].drive.id, error: null } });
  page({ fast: [], amount: "100", trading: true }); await settle();
  els.dxCta.onclick(); await settle();
  assert.equal(drives().length, 1, "still running: a click does nothing"); assert.equal(els.dxCta.disabled, true);
  // the sweep ends: 60 were co-signed, the page keeps only the surely-untraded 40
  page({ fast: [], amount: "40", trading: false }); await settle();
  assert.equal(els.dxAmount.value, "40", "the amount is the page's own remainder, not the full 100 again");
  // the page refuses (the book changed): said plainly, the amount is left, the button is free again
  els.dxAmount.value = "40"; els.dxPrice.oninput(); els.dxCta.onclick(); await settle();
  assert.equal(drives().length, 2); assert.equal(drives()[1].drive.args.expect, "rest", "nothing crosses on the page's book now: reviewed as a resting order");
  listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, driven: drives()[1].drive.id, error: "The book changed since you reviewed this. Review it again. Nothing was signed." } });
  await settle();
  assert.match(els.dxLog.innerHTML, /The book changed since you reviewed this/); assert.equal(els.dxAmount.value, "40"); assert.equal(els.dxCta.disabled, false);
  // 0.18.121: "1,234.5" used to be turned into 1.2345 as it was typed. It is left as typed, said, and nothing can be sent.
  for (const typed of ["1,234.5", "1,5", "1.234.5"]) {
    els.dxAmount.value = typed; els.dxAmount.oninput();
    assert.equal(els.dxAmount.value, typed, "not rewritten into another number"); assert.match(els.dxWarn.textContent, /for example 1234\.5\. Nothing was changed\./); assert.equal(els.dxCta.disabled, true);
    els.dxCta.onclick(); await settle(); assert.equal(drives().length, 2, "nothing is sent: " + typed);
  }
  els.dxAmount.value = "12a.5"; els.dxAmount.oninput(); assert.equal(els.dxAmount.value, "12.5", "letters are still dropped");
  let prevented = false; els.dxAmount.onkeydown({ key: "Enter", preventDefault() { prevented = true; } }); assert.equal(prevented, true, "Enter in a field never trades");
  // 0.18.121: a call from the frame says which engine it is for
  const seen = []; win.mcd.dxCommand = async (a) => { seen.push(a); return { status: true, rows: [] }; };
  listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, id: 77, name: "room.dex", args: { op: "cmd", command: "block" } } }); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(seen.filter(a => a.op === "cmd"))), [{ op: "cmd", command: "block", epoch: 1 }]);
});

// 0.19.145: whether the buttons are live is decided from what the blocker IS, never from its (translated) text. In 0.19.142 to
// 0.19.144 the test was /No relay answers/ on the sentence shown: in zh, ru and uk BUY, SELL and BOOK / POOL went dead whenever no relay answered.
test("Trade buttons: no relay answering leaves BUY / SELL and BOOK / POOL live in every language; no relay set at all stops them", async () => {
  const vm = require("node:vm"), I18N = require("../renderer/i18n.js");
  for (const c of ["zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const run = async (code, relays) => {
    const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
      appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
    const els = {}, listeners = {}, status = { version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays, price: {} };
    const win = { DexCore: C, DexPools: { tick() {}, render() {}, shared() {}, part: () => "" }, DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false }, console, JSON, Promise, setInterval() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, Date,
      document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener: (t, f) => { listeners[t] = f; } };
    win.window = win;
    win.mcd = { dxStatus: async () => status, onDexicon() {}, clip: async () => true, dxMine: async () => ({ orders: [], pending: [] }), dxCommand: async () => ({ status: true, rows: [] }),
      dxBook: async () => ({ fast: [], book: [{ side: "sell", price: "0.0031", minima: "500" }], poolAsks: [], poolBids: [], pools: [] }),
      cmd: async () => ({ status: true, response: [{ tokenid: "0x00", sendable: "1000" }, { tokenid: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", sendable: "10" }] }) };
    Object.assign(win, require("./i18n-plain.cjs").globals());
    I18N.set(code);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
    const shell = win.document.getElementById("shell"); shell.dataset.mode = "dex";
    win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
    win.DexUI.paint("dexicon"); win.DexUI.render(); await settle();
    const frame = shell.children.find(c => c.tag === "iframe");
    listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, page: { ready: true, relays: relays.map(url => ({ url, state: "bad" })), log: [], fast: [], amount: "", trading: false } } });
    els.dxPrice.value = "0.0032"; els.dxAmount.value = "100"; els.dxPrice.oninput(); await settle();
    return els;
  };
  try {
    for (const code of ["en", "zh", "ru", "uk"]) {
      let els = await run(code, ["https://relay.example/dex-relay"]);
      assert.equal(els.dxState.hidden, false); assert.equal(els.dxState.textContent, I18N.t("No relay answers right now, so the FAST book may be out of date and a FAST order may not be heard. On-chain orders and pools still work."), code + ": the warning is said, in " + code);
      assert.equal(els.dxCta.disabled, false, code + ": BUY / SELL stays live when no relay answers");
      assert.equal(els.dxCta2.disabled, false, code + ": BOOK / POOL (on-chain) stays live when no relay answers");
      els = await run(code, []);
      assert.equal(els.dxState.textContent, I18N.t("No relay is set, so there is no FAST book and a FAST order cannot be published. Add a relay in Settings."), code);
      assert.equal(els.dxCta.disabled, true, code + ": no relay set: stopped"); assert.equal(els.dxCta2.disabled, true, code);
    }
  } finally { I18N.set("en"); }
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
  // the resting engine refreshes once when its boot ends (0.19.382 BOOT FIRST) and reads the price then: let that settle,
  // so the count below is the page's refused traffic only
  await host.start(); await M.until(() => host.status().ready && host.status().restingReady && host.status().price.mid > 0);
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

// 0.19.384, owner: "They should all be together in chronological order, mixed." (a FAST fill could not be found among
// the separate AtomiX, pool and Exchange sections of Activity)
test("0.19.384: Activity is one list: block order where a block holds the row, else its time; the runs interleaved by time; nothing dropped", () => {
  const T = 1763800000000, row = (kind, key, ts, block) => ({ kind, key, ts, block });
  const pool = row("pool", "pp:0", T, 2417290), fast = row("fast", "dx:t1", T + 60000, 2417300), ax = row("atomix", "ax:h", T + 30000, 0), chain = row("chain", "dx:s1", T + 120000, 0);
  const input = [pool, ax, fast, chain], copy = input.slice();
  assert.deepEqual(C.activityMix(input).map(r => r.key), ["dx:s1", "dx:t1", "ax:h", "pp:0"], "the pending on-chain fill (newest), the FAST fill (its block), the AtomiX swap (its time), the pool swap (its block)");
  assert.deepEqual(input, copy, "the rows given are not reordered");
  assert.deepEqual(C.activityMix([row("pool", "a", T + 5000, 10), row("fast", "b", T, 11)]).map(r => r.key), ["a", "b"], "0.19.385: two rows in blocks whose times disagree: by time (one order, so the day headers never repeat)");
  assert.deepEqual(C.activityMix([row("pool", "a", T, 10), row("fast", "b", T, 11)]).map(r => r.key), ["b", "a"], "two rows in blocks at one time: the later block first");
  assert.deepEqual(C.activityMix([row("fast", "a", T, 10), row("pool", "b", T + 1, 10)]).map(r => r.key), ["b", "a"], "in one block: the later time first");
  assert.deepEqual(C.activityMix([row("pool", "z", T, 10), row("fast", "y", T, 10)]).map(r => r.key), ["y", "z"], "same block, same time: by kind, so two draws never swap them");
  assert.deepEqual(C.activityMix([row("atomix", "p", T, 0), row("pool", "m", T, 10)]).map(r => r.key), ["m", "p"], "a row in a block and a row without one at the same time: the one in a block first");
  assert.deepEqual(C.activityMix([row("chain", "x", "junk", "junk"), row("fast", "w", T, -4)]).map(r => r.key), ["w", "x"], "no number: placed last, still listed");
  assert.deepEqual(C.activityMix([]), []);
});

test("0.19.384: the Activity screen draws the Exchange's rows (with the maker's FAST fill), AtomiX's swaps and pool operations as one list, each marked with its kind", async () => {
  const vm = require("node:vm"), T = 1763800000000, H = (c) => "0x" + c.repeat(64);
  const TAKER = { id: "t1", route: "FAST", role: "taker", side: "buy", amount: "500", price: "0.0031", txpowid: H("A"), orderId: H("B"), counterparty: H("C"), stage: "COSIGNED", block: 2417300, ts: T + 60000, outs: [H("D")] };
  const MAKER_FILL = { txpowid: H("E"), role: "maker", side: "sell", filled: "200", price: "0.0032", received: "0.64", taker: H("F"), orderId: H("1"), coins: [H("2")], status: "posted", ts: (T + 120000) / 1000 };
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, showModal() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
  const els = {}, item = (kind, key, ts, block, pending, tag, html) => ({ kind, key, ts, block, pending, tag, html });
  const win = { DexCore: C, console, JSON, Promise, setInterval() {}, setTimeout, localStorage: { getItem: () => null, setItem() {} }, Date: class extends Date { static now() { return T + 180000; } },
    DexPools: { tick() {}, render() {}, shared() {}, part: () => "", activityItems: () => [item("pool", "pp:0", T, 2417290, false, "POOL", '<div class="pp-act" id="PPROW"></div>')] },
    DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false, activityItems: () => [item("atomix", "ax:h", T + 30000, 0, true, "ATOMIX · USDT ⇄ MxUSD", '<div class="ax-swap" id="AXROW"></div>')] },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener() {} };
  win.window = win;
  win.mcd = { dxStatus: async () => ({ version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {}, block: 2417310 }), onDexicon() {}, clip: async () => true,
    dxBook: async () => ({ fast: [], book: [], poolAsks: [], poolBids: [], pools: [] }), dxMine: async () => ({ orders: [], pending: [] }), cmd: async () => ({ status: true, response: [] }),
    dxCommand: async (a) => ({ status: true, rows: /fill_%/.test(a.query) ? [{ K: "fill_" + MAKER_FILL.txpowid, V: JSON.stringify(MAKER_FILL) }] : [{ K: "activity", V: JSON.stringify([TAKER]) }] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/lib/activity.js"), "utf8"), win);   // window.AX.activity, as index.html loads it
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  win.document.getElementById("shell").dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  win.DexUI.paint("dexicon"); win.DexUI.pickTab("activity"); await settle();
  const html = els.dxBody.innerHTML, at = (s) => html.indexOf(s);
  const where = ['data-act="0"', 'data-act="1"', 'id="AXROW"', 'id="PPROW"'].map(at);
  assert.ok(where.every(i => i >= 0), "every row is drawn: the maker's FAST fill, the taker's FAST fill, the AtomiX swap, the pool swap " + JSON.stringify(where));
  assert.deepEqual(where.slice().sort((a, b) => a - b), where, "newest first, all kinds mixed: maker fill (pending, newest), taker fill (block 2417300), AtomiX (its time), pool (block 2417290)");
  const kinds = [...html.matchAll(/<div class="dx-mix" data-kind="(\w+)"><div class="dx-mix__k"( data-pending)?(?: aria-hidden="true")?>([^<]*)<\/div>/g)].map(m => [m[1], m[3], !!m[2]]);
  assert.deepEqual(kinds, [["fast", "fast book · PENDING", true], ["fast", "fast book", false], ["atomix", "ATOMIX · USDT ⇄ MxUSD · PENDING", true], ["pool", "POOL", false]], "each row marked with its kind; not in a block yet: PENDING");
  assert.ok(!/ATOMIX SWAPS|POOL OPERATIONS/.test(html), "no separate sections");
  let shown = null; els.shell.appendChild = (d) => { shown = d; };
  await els.dxBody.onclick({ target: { closest: (sel) => (sel === "button" ? { dataset: { act: "0" } } : null) } });
  assert.ok(shown && shown.innerHTML.includes(MAKER_FILL.txpowid) && shown.innerHTML.includes(MAKER_FILL.taker) && shown.innerHTML.includes(MAKER_FILL.coins[0]), "the maker's row opens its facts with every identifier whole");
});

// 0.19.385 (review of 0.19.384): block order and time could disagree, so a day header was drawn twice, and a row in a
// block with no time was drawn under "1 JAN 1970" and dragged the rows after it down with it
test("0.19.385: Activity's one order is by time: a day header never repeats, a row in a block with no time sits by its block neighbour, a row with no time at all goes last", () => {
  const D2 = new Date(2026, 10, 20, 12).getTime(), D1 = D2 - 86400000, row = (kind, key, ts, block) => ({ kind, key, ts, block });
  const days = (rows) => rows.map(r => (r.ts ? C.dayLabel(r.ts, D2) : "UNDATED"));
  const once = (labels) => labels.every((d, i) => i === 0 || d === labels[i - 1] || !labels.slice(0, i).includes(d));
  // probe 1: blocks 12 > 11 > 10 but times D2, D1, D2 (a later block can carry an earlier time: a slow post, another device)
  const p1 = C.activityMix([row("pool", "p", D2, 12), row("fast", "q", D1, 11), row("chain", "r", D2 - 1000, 10)]);
  assert.deepEqual(p1.map(r => r.key), ["p", "r", "q"]);
  assert.ok(once(days(p1)), "no day header twice: " + days(p1).join(" | "));
  // probe 2: a row in block 11 with ts 0 between rows in blocks 12 and 10, and an AtomiX swap (no block) between them in time
  const p2 = C.activityMix([row("pool", "a", D2, 12), row("pool", "z", 0, 11), row("chain", "c", D2 - 5000, 10), row("atomix", "x", D2 - 1000, 0)]);
  assert.deepEqual(p2.map(r => r.key), ["a", "z", "x", "c"], "the row with no time takes its nearest block neighbour's time; nothing is dragged");
  assert.equal(p2[1].ts, D2);
  assert.ok(!days(p2).some(d => /1970/.test(d)) && once(days(p2)), days(p2).join(" | "));
  // a row with no time and no block: last, with ts 0 (drawn under UNDATED); a time before 2001 is no time
  const p3 = C.activityMix([row("pool", "u", 0, 0), row("atomix", "s", 500, 0), row("fast", "f", D1, 0)]);
  assert.deepEqual(p3.map(r => [r.key, r.ts]), [["f", D1], ["s", 0], ["u", 0]]);
});

/** The Activity screen of the real dexicon-ui.js over a mock window: the Exchange's rows come from acts/fills, AtomiX's and
 *  PandaPools' from the items given. Returns { html(), click(dataset) }. */
async function drawActivity({ acts = [], fills = [], axItems = [], ppItems = [], now }) {
  const vm = require("node:vm");
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, showModal() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
  const els = {}, win = { DexCore: C, console, JSON, Promise, setInterval() {}, setTimeout, localStorage: { getItem: () => null, setItem() {} }, Date: class extends Date { static now() { return now; } },
    DexPools: { tick() {}, render() {}, shared() {}, part: () => "", activityItems: () => ppItems },
    DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false, activityItems: () => axItems },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener() {} };
  win.window = win;
  win.mcd = { dxStatus: async () => ({ version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {}, block: 2417310 }), onDexicon() {}, clip: async () => true,
    dxBook: async () => ({ fast: [], book: [], poolAsks: [], poolBids: [], pools: [] }), dxMine: async () => ({ orders: [], pending: [] }), cmd: async () => ({ status: true, response: [] }),
    dxCommand: async (a) => ({ status: true, rows: /fill_%/.test(a.query) ? fills.map((f) => ({ K: "fill_" + f.txpowid, V: JSON.stringify(f) })) : [{ K: "activity", V: JSON.stringify(acts) }] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/lib/activity.js"), "utf8"), win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  win.document.getElementById("shell").dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  win.DexUI.paint("dexicon"); win.DexUI.pickTab("activity"); await settle();
  return { html: () => els.dxBody.innerHTML, click: async (dataset) => { await els.dxBody.onclick({ target: { closest: (sel) => (sel === "button" ? { dataset } : null) } }); await settle(); } };
}

test("0.19.385: the drawn Activity: day headers in one run each, never 1970, UNDATED last; one line counts the unfinished rows and shows only them, in the same order", async () => {
  const H = (c) => "0x" + c.repeat(64), now = new Date(2026, 10, 22, 12).getTime(), DAY = 86400000;
  const item = (kind, key, ts, block, pending, tag, id, unfinished) => ({ kind, key, ts, block, pending, unfinished, tag, html: `<div id="${id}"></div>` });
  const TAKER = { id: "t1", route: "FAST", role: "taker", side: "buy", amount: "500", price: "0.0031", txpowid: H("A"), orderId: H("B"), counterparty: H("C"), stage: "COSIGNED", block: 2417300, ts: now - 2 * DAY, outs: [H("D")] };
  const v = await drawActivity({ now, acts: [TAKER],
    axItems: [item("atomix", "ax:" + H("E"), now - 3 * DAY, 0, true, "ATOMIX · USDT ⇄ MxUSD", "AXOPEN"), item("atomix", "ax:" + H("F"), now - 1000, 0, false, "ATOMIX · USDT ⇄ MINIMA", "AXDONE")],
    ppItems: [item("pool", "pp:" + H("1"), now - DAY, 2417310, false, "POOL", "PPNEW"), item("pool", "pp:" + H("2"), 0, 2417305, false, "POOL", "PPNOTIME"), item("pool", "pp:" + H("3"), 0, 0, false, "POOL · Not found on this node", "PPNOTFOUND", true)] });
  let html = v.html();
  const heads = [...html.matchAll(/<div class="dx-day">([^<]*)<\/div>/g)].map(m => m[1]);
  assert.ok(heads.every((d, i) => heads.indexOf(d) === i), "each day header once: " + heads.join(" | "));
  assert.ok(!heads.some(d => /1970/.test(d)) && heads[heads.length - 1] === "UNDATED", heads.join(" | "));
  const where = ["AXDONE", "PPNEW", "PPNOTIME", 'data-act="0"', "AXOPEN", "PPNOTFOUND"].map(s => html.indexOf(s));
  assert.ok(where.every(i => i >= 0) && where.every((x, i) => i === 0 || x > where[i - 1]), "newest first by time; the pool row with no time beside its block neighbour; the one with no time at all last " + JSON.stringify(where));
  assert.match(html, /<button class="pp-link pp-link--row" data-aopen="1" aria-pressed="false">2 unfinished — show<\/button>/, "the pending AtomiX swap far down, and the pool operation the node did not find");
  assert.ok(html.indexOf('data-aopen="1"') < html.indexOf("AXDONE"), "the line sits above the list");
  await v.click({ aopen: "1" }); html = v.html();
  assert.match(html, /aria-pressed="true">Showing only the 2 unfinished — show all<\/button>/);
  assert.ok(html.includes("AXOPEN") && html.includes("PPNOTFOUND") && html.indexOf("AXOPEN") < html.indexOf("PPNOTFOUND"), "only the unfinished, in the same order");
  assert.ok(!/AXDONE|PPNEW|PPNOTIME|data-act=/.test(html), "the finished rows are not shown");
  await v.click({ aopen: "1" }); assert.ok(v.html().includes("AXDONE") && v.html().includes("2 unfinished — show"), "and back to the whole list");
});

test("0.19.385: a FAST or on-chain row's button says its kind and PENDING to a screen reader; no unfinished line when nothing is unfinished", async () => {
  const H = (c) => "0x" + c.repeat(64), now = new Date(2026, 10, 22, 12).getTime();
  const POSTED = { id: "s1", route: "CHAIN", side: "sell", amount: "100", price: "0.0032", txpowid: H("A"), stage: "POSTED", ts: now - 60000 };
  let html = (await drawActivity({ now, acts: [POSTED] })).html();
  assert.match(html, /<div class="dx-mix__k" data-pending aria-hidden="true">on-chain · PENDING<\/div><button class="dx-card dx-led" data-act="0"><span class="dx-sr">on-chain · PENDING: <\/span>/);
  assert.match(html, /1 unfinished — show/);
  html = (await drawActivity({ now, axItems: [{ kind: "atomix", key: "ax:x", ts: now, block: 0, pending: false, tag: "ATOMIX · USDT ⇄ MxUSD", html: "<div></div>" }] })).html();
  assert.ok(!/data-aopen/.test(html), "nothing unfinished: no line");
  assert.match(html, /<div class="dx-mix__k">ATOMIX · USDT ⇄ MxUSD<\/div>/, "a card without a row button keeps its kind line readable");
});

test("Settings: a relay the desktop cannot reach is refused before anything is saved", () => {
  assert.equal(C.relayProblem("https://relay.example/dex-relay"), "");
  assert.equal(C.relayProblem("https://relay.example:9602"), "");
  assert.match(C.relayProblem("http://relay.example:19702"), /must be an https address\. Nothing was added\./);
  for (const local of ["https://localhost:9602", "https://127.0.0.1/dex", "https://192.168.1.5/dex", "https://10.0.0.2/dex"]) assert.match(C.relayProblem(local), /this machine or the local network/, local);
  assert.match(C.relayProblem("https://user:pw@relay.example/dex"), /no user name/);
  assert.match(C.relayProblem("relay.example"), /Enter a relay address/); assert.match(C.relayProblem(""), /Enter a relay address/);
});

// 0.19.231: the native screens record what the user confirmed; the main process asks about anything else the page wants
test("the native Exchange screens record the confirmed on-chain trade, edit and relay change as intents; main.js answers the rest with its own question", () => {
  const ui = fs.readFileSync(path.join(__dirname, "..", "renderer", "dexicon-ui.js"), "utf8"), main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/args\.reviewed = r\.asked;\s*\n[^\n]*\n\s*try \{ await api\.dxCommand\(\{ op: "intent", type: "LIMIT", buy: X\.buy, price: args\.price, amount \}\); \}/.test(ui), "after the on-chain review, before the page is driven");
  assert.ok(/if \(!fast\) \{ try \{ await api\.dxCommand\(\{ op: "intent", type: "EDIT", coinid: id, price: next \}\);/.test(ui));
  assert.ok(/api\.dxCommand\(\{ op: "intent", type: "KV", key: "relays" \}\)/.test(ui));
  assert.ok(/dexicon\.setConfirm\(async \(title, detail\) => \{/.test(main) && /buttons: \[lang\.t\("Refuse"\), lang\.t\("Allow"\)\], defaultId: 0, cancelId: 0/.test(main), "a main-process question, Refuse the default");
  const C = require("../renderer/dexicon-core.js");
  assert.equal(C.bridgeCall({ dxRoom: 1, id: 1, name: "room.dex", args: { op: "intent", type: "LIMIT" } }), null, "the frame cannot record an intent");
});

// ---------------------------------------------------------------- the on-chain engine not ready (0.19.373)
/** The Trade screen over a stand-in engine: status, the service's book and the page's FAST book are the test's. */
/** 0.19.406: the page's takeable view (renderer/dexicon/mds.js viewNow, DexiconFast.bookView rows) of a FAST list. */
function pageView(fast, ready) {
  const rows = (side) => (fast || []).filter(x => x.side === side).map(x => ({ price: x.price, exact: x.price, size: x.minima, cumulative: x.minima, own: !!x.ours }));
  return { ready: ready !== false, rev: 1, asks: rows("sell"), bids: rows("buy"), hidden: "" };
}
async function tradeUi(o) {
  const vm = require("node:vm"), posted = [], cmds = [];
  let answerLate = null;
  const toPage = (m) => { posted.push(m); if (m.drive && m.drive.act === "quote" && o.quote) setImmediate(() => answerLate(m.drive.id, { value: o.quote(m.drive.args) })); };
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage: toPage }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false, showModal() { o.dialogs.push(e); setImmediate(() => e.onclick({ target: { closest: () => ({ dataset: { x: o.answer === false ? "0" : "1" } }) } })); }, close() {} }; return e; };
  o.dialogs = o.dialogs || [];
  const els = {}, listeners = {}, status = Object.assign({ version: "0.0.91", started: true, ready: true, restingReady: true, epoch: 1, relays: ["https://relay.example/dex-relay"], price: {} }, o.status || {});
  const win = { DexCore: C, DexPools: { tick() {}, render() {}, shared() {}, part: () => "" }, DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false }, console, JSON, Promise, setInterval() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, Date: o.Date || Date,
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener: (t, f) => { listeners[t] = f; } };
  win.window = win;
  win.mcd = { dxStatus: async () => status, onDexicon() {}, clip: async () => true, dxMine: async () => ({ orders: [], pending: [] }), dxCommand: async (a) => { cmds.push(a); return { status: true, rows: a.op === "sql" && /fill_%/.test(a.query || "") ? (o.fills ? o.fills() : []).map(f => ({ K: "fill_" + f.txpowid, V: JSON.stringify(f) })) : [] }; },
    dxBook: async () => o.book, cmd: async () => ({ status: true, response: [{ tokenid: "0x00", sendable: "100000" }, { tokenid: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", sendable: "1000" }] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const shell = win.document.getElementById("shell"); shell.dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  win.DexUI.paint("dexicon"); win.DexUI.render(); await settle();
  const frame = shell.children.find(c => c.tag === "iframe");
  const page = (p) => listeners.message({ source: frame.contentWindow, data: { dxRoom: 1, page: Object.assign({ ready: true, relays: [{ url: "https://relay.example/dex-relay", state: "ok" }], log: [], fast: o.book.fast.filter(x => !x.ours), view: pageView(o.book.fast), amount: "", trading: false }, p) } });
  page({});
  const answer = (id, r) => listeners.message({ source: frame.contentWindow, data: Object.assign({ dxRoom: 1, driven: id, error: null }, r) });
  answerLate = answer;
  return { win, els, posted, cmds, status, page, answer, settle, dialogs: o.dialogs, drives: () => posted.filter(m => m.drive && m.drive.act !== "quote"), quotes: () => posted.filter(m => m.drive && m.drive.act === "quote") };
}
const CHAIN_BOOK = { fast: [], book: [{ side: "sell", price: "0.0031", minima: "500", ours: false }], poolAsks: [], poolBids: [], pools: [] };

test("0.19.373: the on-chain engine not ready: the reason (or 'still starting') is said, BOOK / POOL is off, and a click shows no review and drives nothing", async () => {
  assert.equal(C.chainWhy({ restingReady: true, restingWhy: "x" }), "");
  assert.equal(C.chainWhy({ restingReady: false }), "The on-chain order book is still starting. Nothing can be sent to it yet.");
  assert.equal(C.chainWhy(null), "The on-chain order book is still starting. Nothing can be sent to it yet.");
  assert.equal(C.chainWhy({ restingReady: false, restingWhy: "PandaDEX order covenant mismatch; trading disabled" }),
    "The on-chain order book could not start: PandaDEX order covenant mismatch; trading disabled. It is tried again every minute. FAST orders are not affected.");
  assert.equal(C.chainWhy({ restingReady: false, restingWhy: "Could not read wallet identity." }), "The on-chain order book could not start: Could not read wallet identity. It is tried again every minute. FAST orders are not affected.", "no double full stop");
  for (const [restingWhy, said] of [["", /The on-chain order book is still starting\. Nothing can be sent to it yet\./], ["Could not register the V5 covenant", /could not start: Could not register the V5 covenant\. It is tried again every minute\./]]) {
    const u = await tradeUi({ book: CHAIN_BOOK, status: { restingReady: false, restingWhy } });
    u.els.dxPrice.value = "0.0032"; u.els.dxAmount.value = "100"; u.els.dxPrice.oninput(); await u.settle();
    assert.equal(u.els.dxCta2.hidden, false, "the on-chain button is shown (on-chain liquidity crosses)"); assert.equal(u.els.dxCta2.disabled, true, "but off");
    assert.match(u.els.dxReview.innerHTML, said);
    u.els.dxCta2.disabled = false; u.els.dxCta2.onclick(); await u.settle();   // even a click that gets through
    assert.equal(u.drives().length, 0, "the page is not driven"); assert.equal(u.dialogs.length, 0, "no review dialog");
    assert.ok(!u.cmds.some(c => c.op === "intent"), "no intent recorded");
    assert.match(u.els.dxLog.innerHTML, said); assert.match(u.els.dxLog.innerHTML, /Nothing was signed or sent\./);
  }
  const ok = await tradeUi({ book: CHAIN_BOOK, status: { restingReady: true } });
  ok.els.dxPrice.value = "0.0032"; ok.els.dxAmount.value = "100"; ok.els.dxPrice.oninput(); await ok.settle();
  assert.equal(ok.els.dxCta2.disabled, false, "ready: on"); assert.ok(!/order book (could not start|is still starting)/.test(ok.els.dxReview.innerHTML));
});

test("0.19.373: the page refuses an on-chain place before its review while the engine's STATE is not ready or busy, with the wrapper's reason", () => {
  const { win, calls, say, reply } = bridge();
  win.crosses = true; win.pageAsks = "Buying 10 MINIMA now";
  const go = (id) => say({ dxRoom: 1, drive: { id, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "chain" } } });
  win.state = { block: 100, book: [], pools: [] };   // no STATE heard yet
  go(1); assert.equal(reply().error, "The on-chain order book is still starting. Nothing can be sent to it yet. Nothing was sent."); assert.equal(reply().asked, null, "nothing to review");
  win.state = { ready: false, restingWhy: "Could not read wallet identity", block: 100, book: [], pools: [] };
  go(2); assert.equal(reply().error, "The on-chain order book could not start: Could not read wallet identity. It is tried again every minute. FAST orders are not affected. Nothing was sent.");
  win.state = { ready: true, busy: true, block: 100, book: [], pools: [] };
  go(3); assert.match(reply().error, /still building another on-chain transaction\. Wait for it to finish\. Nothing was sent\./);
  assert.deepEqual(calls, [], "place() never ran, so the page asked nothing and sent nothing");
  win.state = { ready: true, block: 100, book: [], pools: [] };
  go(4); assert.equal(reply().asked, win.pageAsks, "ready: the page's own review, as before");
  say({ dxRoom: 1, drive: { id: 5, act: "place", args: { buy: true, price: "0.0032", amount: "10", layer: "fast", expect: "rest" } } });
  assert.equal(reply().error, null, "a FAST order does not wait for the on-chain engine");
});

// ---------------------------------------------------------------- the on-chain limit on the 6-decimal grid (0.19.374)
test("0.19.374: the on-chain limit admits exactly the 6-decimal levels the typed limit admits, and never one it does not", () => {
  const lv = (n) => ({ v: BigInt(n), s: 6 });   // a 6-decimal on-chain level
  let checked = 0;
  for (let t8 = 440000; t8 <= 443000; t8++) {   // every 8-decimal limit from 0.00440000 to 0.00443000
    const typed = { v: BigInt(t8), s: 8 }, text = C.str(typed), sell = C.chainLimit(false, text), buy = C.chainLimit(true, text);
    assert.ok(C.cmp(sell, typed) >= 0 && C.cmp(buy, typed) <= 0, "the sent limit is never worse for the user than the typed one: " + text);
    assert.ok(sell.s <= 6 && buy.s <= 6);
    for (let l = 4398; l <= 4432; l++) {
      const L = lv(l);
      assert.equal(C.cmp(L, typed) >= 0, C.cmp(L, sell) >= 0, "SELL " + text + ": bid level " + C.str(L));
      assert.equal(C.cmp(L, typed) <= 0, C.cmp(L, buy) <= 0, "BUY " + text + ": ask level " + C.str(L));
      checked++;
    }
  }
  assert.equal(checked, 3001 * 35);
  assert.equal(C.str(C.chainLimit(false, "0.00441234")), "0.004413"); assert.equal(C.str(C.chainLimit(true, "0.00441234")), "0.004412");
  assert.equal(C.str(C.chainLimit(false, "0.004413")), "0.004413", "a 6-decimal limit is sent as it is"); assert.equal(C.str(C.chainLimit(true, "0.0032000")), "0.0032");
  assert.equal(C.chainLimit(true, "0.0000009"), null, "a BUY below the smallest on-chain price cannot be sent");
  assert.equal(C.str(C.chainLimit(false, "0.0000009")), "0.000001");
  assert.equal(C.chainLimit(true, "abc"), null); assert.equal(C.chainLimit(false, "0"), null);
});

test("0.19.374: the owner's case: a POOL bid above a FAST bid, the FAST row clicked, BOOK / POOL sends 0.004413 (not refused), the review says so, the intent is the sent price, the amount untouched", async () => {
  const book = { fast: [{ side: "buy", price: "0.00441234", minima: "500", ours: false }], book: [], poolAsks: [], poolBids: [{ price: "0.0045", minima: "1234.56789012" }], pools: [] };
  const u = await tradeUi({ book });
  const rows = [...u.els.dxBids.innerHTML.matchAll(/data-side="(\w+)" data-price="([0-9.]+)" data-cum="([0-9.]+)"/g)].map(m => ({ side: m[1], price: m[2], cum: m[3] }));
  assert.deepEqual(rows, [{ side: "bid", price: "0.0045", cum: "1234.56789012" }, { side: "bid", price: "0.00441234", cum: "1734.56789012" }]);
  u.els.dxBids.onclick({ target: { closest: () => ({ dataset: rows[1] }) } }); await u.settle();
  assert.deepEqual([u.els.dxPrice.value, u.els.dxAmount.value], ["0.00441234", "1734.56789012"], "the FAST order's exact price and the cumulative amount");
  assert.equal(u.els.dxCta2.hidden, false); assert.equal(u.els.dxCta2.disabled, false);
  u.els.dxCta2.onclick(); await u.settle();
  const d1 = u.drives()[0].drive;
  assert.deepEqual(JSON.parse(JSON.stringify(d1.args)), { buy: false, price: "0.004413", amount: "1734.56789012", layer: "chain" }, "a SELL is sent at the typed limit cut up to 6 decimals; the amount as typed");
  const asked = "Selling 1234.56789012 MINIMA now\nEffective 0.0045\n\nRest 500 MINIMA @ 0.004413 as a limit order after the trade confirms.";
  u.answer(d1.id, { asked }); await u.settle(); await u.settle();
  assert.equal(u.dialogs.length, 1);
  assert.match(u.dialogs[0].innerHTML, /^<h2>Review this on-chain trade<\/h2><pre>On-chain prices have 6 decimals: your limit 0\.00441234 is sent as 0\.004413\. The same on-chain orders qualify; a pool may fill very slightly less, never at a worse price\.\n\nSelling 1234\.56789012 MINIMA now/);
  assert.match(u.dialogs[0].innerHTML, /Rest 500 MINIMA @ 0\.004413 as a limit order/, "a remainder rests at the price sent, and the page's review says that price");
  const intent = u.cmds.find(c => c.op === "intent");
  assert.deepEqual(JSON.parse(JSON.stringify(intent)), { op: "intent", type: "LIMIT", buy: false, price: "0.004413", amount: "1734.56789012" }, "the confirmed intent is what the page will send, so main/dexicon.js matches it");
  const d2 = u.drives()[1].drive;
  assert.equal(d2.args.price, "0.004413"); assert.equal(d2.args.reviewed, asked);
  u.answer(d2.id, {}); await u.settle();   // the page sent it: the one money action ends
  // a 6-decimal limit: no note
  const v = await tradeUi({ book });
  v.els.dxBids.onclick({ target: { closest: () => ({ dataset: { side: "bid", price: "0.0045", cum: "1234.56789012" } }) } }); await v.settle();
  v.els.dxCta2.onclick(); await v.settle(); v.answer(v.drives()[0].drive.id, { asked: "Selling 1234.56789012 MINIMA now" }); await v.settle();
  assert.equal(v.drives()[0].drive.args.price, "0.0045"); assert.ok(!/6 decimals/.test(v.dialogs[0].innerHTML));
  v.answer(v.drives()[1].drive.id, {}); await v.settle();
  // the page's guard stays the last line of defence
  const { say, reply } = bridge();
  say({ dxRoom: 1, drive: { id: 1, act: "place", args: { buy: false, price: "0.00441234", amount: "10", layer: "chain" } } });
  assert.equal(reply().error, "An on-chain order takes a price of at most 6 decimals. Nothing was sent.");
});

// ---------------------------------------------------------------- SWEEP across FAST and on-chain (0.19.375)
// SweepBothSplitTest.java (apks/base integrated/dexicon, Pandamonium 2.2.109), case for case, same inputs, same splits.
test("0.19.375: SweepBothSplitTest, ported: cheap on-chain, then FAST, then the overflow on-chain", () => {
  const q = C.sweepSplit(d("3000"), d("500"), d("1000"), d("4000"));
  assert.equal(C.cmp(q.chainQ, d("2000")), 0); assert.equal(C.cmp(q.fastQ, d("1000")), 0);   // 500 cheap + 1500 overflow on-chain, FAST takes all it offers
});
test("0.19.375: SweepBothSplitTest, ported: never more than asked or held", () => {
  for (const c of [["100", "0", "1000", "0"], ["100", "500", "1000", "500"], ["3000", "0", "1000", "200"], ["10", "3", "4", "5"]]) {
    const q = C.sweepSplit(d(c[0]), d(c[1]), d(c[2]), d(c[3]));
    assert.ok(C.cmp(C.add(q.chainQ, q.fastQ), d(c[0])) <= 0, c.join());
    assert.ok(C.cmp(q.chainQ, d(c[3])) <= 0, c.join());
    assert.ok(C.cmp(q.fastQ, d(c[2])) <= 0, c.join());
    assert.ok(q.chainQ.v >= 0n && q.fastQ.v >= 0n);
  }
  const fastCovers = C.sweepSplit(d("100"), d("0"), d("1000"), d("0"));
  assert.equal(C.cmp(fastCovers.chainQ, d("0")), 0); assert.equal(C.cmp(fastCovers.fastQ, d("100")), 0);   // nothing on-chain: no sweep
});
test("0.19.375: SweepBothSplitTest, ported: the average weighs both parts (cut to 8 decimals here; the phone rounds half up to 0.00316303)", () => {
  // 7604 on-chain for 23.96 MxUSD, then 2479 FAST @ 0.0032: (23.96 + 7.9328) / 10083 = 0.0031630268…
  assert.equal(C.str(C.sweepAvg(d("7604"), d("23.96"), d("2479"), C.mul(d("2479"), d("0.0032")))), "0.00316302");
  assert.equal(C.sweepAvg(d("0"), d("0"), d("0"), d("0")), null);
});

const OWNER_BOOK = { fast: [{ side: "buy", price: "0.00441234", minima: "500", ours: false }], book: [], poolAsks: [], poolBids: [{ price: "0.0045", minima: "1234.56789012" }], pools: [] };
/** A stand-in for the page's PandaComposite.plan: one pool bid band of 1234.56789012 MINIMA at 0.0045. */
const OWNER_QUOTE = (args) => {
  const p = d(args.price), a = d(args.amount);
  if (C.cmp(p, d("0.0045")) > 0) return { totalMinima: "0", totalUsdt: "0", orderMinima: "0", poolMinima: "0" };
  const m = C.min(a, d("1234.56789012"));
  return { totalMinima: C.str(m), totalUsdt: C.str(C.down(C.mul(m, d("0.0045")), 8)), orderMinima: "0", poolMinima: C.str(m) };
};
test("0.19.375: decideBoth over the page's quotes: the owner's case (POOL bid above a FAST bid) splits 500 FAST + 1234.56789012 on-chain; the quotes use the 6-decimal limit; the FAST list is an input", async () => {
  const asked = [];
  const quote = async (limit, amount) => { asked.push([limit, amount]); return OWNER_QUOTE({ price: limit, amount }); };
  const r = await C.decideBoth(OWNER_BOOK, false, "0.00441234", "1734.56789012", quote);
  assert.equal(C.str(r.fastQ), "500"); assert.equal(C.str(r.chainQ), "1234.56789012"); assert.equal(r.route, "POOL");
  assert.equal(C.str(r.limit), "0.004413");
  assert.deepEqual(asked, [["0.004413", "1734.56789012"], ["0.004413", "1734.56789012"], ["0.004413", "1234.56789012"]], "at the best FAST price, at the limit, then the on-chain share at the limit");
  assert.equal(C.str(r.avg), "0.00447473", "(5.55555550 + 500 × 0.00441234) / 1734.56789012, cut");
  // both parts must be more than zero
  assert.equal(await C.decideBoth(OWNER_BOOK, false, "0.00441234", "400", quote), null, "FAST alone would do? no: on-chain takes the cheap part first, so 400 is all on-chain → no sweep");
  assert.equal(await C.decideBoth(Object.assign({}, OWNER_BOOK, { poolBids: [] }), false, "0.00441234", "1734.56789012", async () => ({ totalMinima: "0", totalUsdt: "0" })), null, "nothing on-chain: no sweep");
  assert.equal(await C.decideBoth(Object.assign({}, OWNER_BOOK, { fast: [] }), false, "0.00441234", "1734.56789012", quote), null, "the FAST list passed in is the one counted: none, no sweep");
  assert.equal(C.ladder(OWNER_BOOK, 0, []).bids.length, 1, "the ladder counts the FAST list it is given (a later change can filter it)");
  assert.equal(C.str(C.rows(C.ladder(OWNER_BOOK, 0).bids)[1].cum), "1734.56789012");
});

test("0.19.375: the page's quote action is read only: the page's own plan as totals, no dialog, nothing placed, refused while not ready", () => {
  const { win, calls, say, reply } = bridge();
  win.PandaComposite = { plan: (book, pools, buy, amount, price, block) => (calls.push("plan:" + [buy, amount, price, block].join(",")), { totalMinima: "1234.56789012", totalUsdt: "5.5555555", orderMinima: "0", poolMinima: "1234.56789012" }), isEmpty: () => false, poolCount: () => 1 };
  let confirmed = 0; const realConfirm = win.confirm; win.confirm = (m) => { confirmed++; return realConfirm(m); };
  say({ dxRoom: 1, drive: { id: 1, act: "quote", args: { buy: false, price: "0.004413", amount: "1734.56789012" } } });
  assert.equal(reply().error, null); assert.deepEqual(JSON.parse(JSON.stringify(reply().value)), { totalMinima: "1234.56789012", totalUsdt: "5.5555555", orderMinima: "0", poolMinima: "1234.56789012" });
  assert.deepEqual(calls, ["plan:false,1734.56789012,0.004413,100"], "only the page's planner ran: no side chosen, no field written, no place()");
  assert.equal(confirmed, 0);
  say({ dxRoom: 1, drive: { id: 2, act: "quote", args: { buy: false, price: "0.00441234", amount: "1" } } }); assert.match(reply().error, /at most 6 decimals/);
  win.state = { ready: false, block: 100, book: [], pools: [] };
  say({ dxRoom: 1, drive: { id: 3, act: "quote", args: { buy: false, price: "0.004413", amount: "1" } } }); assert.equal(reply().error, "The on-chain order book is not ready."); assert.equal(reply().value, null);
  say({ dxRoom: 1, drive: { id: 4, act: "refresh", args: {} } }); assert.equal(reply().value, null, "only a quote carries a value");
});

test("0.19.375: the investigator's repro on the Trade screen: the FAST row under a POOL row → SWEEP offered (FAST 500 + on-chain 1234.56789012, average cut), sendable since 0.19.406 (both parts take-only); BOOK / POOL alone sends the 6-decimal limit", async () => {
  const u = await tradeUi({ book: OWNER_BOOK, quote: OWNER_QUOTE });
  const rows = [...u.els.dxBids.innerHTML.matchAll(/data-side="(\w+)" data-price="([0-9.]+)" data-cum="([0-9.]+)"/g)].map(m => ({ side: m[1], price: m[2], cum: m[3] }));
  u.els.dxBids.onclick({ target: { closest: () => ({ dataset: rows[1] }) } }); await u.settle(); await u.settle();
  assert.deepEqual([u.els.dxPrice.value, u.els.dxAmount.value], ["0.00441234", "1734.56789012"]);
  assert.equal(u.quotes().length, 3, "the page was asked three quotes, nothing else"); assert.equal(u.drives().length, 0);
  const sw = u.els.dxCtaSweep;
  assert.equal(sw.hidden, false); assert.equal(sw.disabled, false);
  assert.equal(sw.innerHTML, "SWEEP SELL 1734.56789012 · POOL + FAST · avg 0.00447473<small>up to 500 instant, then 1234.56789012 on-chain</small>");
  assert.match(u.els.dxReview.innerHTML, /SWEEP takes the FAST part first, then what is left of your amount on-chain \(BOOK \/ POOL\) inside your limit\. Both parts only take: nothing is left resting\./);
  assert.match(u.els.dxCta.innerHTML, /SELL 500 NOW · FAST/, "the single-source buttons stay below");
  assert.equal(u.els.dxCta2.hidden, false);
  // no second round of quotes while nothing changes
  u.els.dxPrice.oninput(); await u.settle(); assert.equal(u.quotes().length, 3);
  u.els.dxCta2.onclick(); await u.settle();
  assert.equal(u.drives()[0].drive.args.price, "0.004413", "BOOK / POOL alone: the 6-decimal limit");
  u.answer(u.drives()[0].drive.id, { error: "stop here" }); await u.settle();
  // an amount FAST covers alone after the cheap on-chain part: no sweep
  u.els.dxAmount.value = "1000"; u.els.dxAmount.oninput(); await u.settle(); await u.settle();
  assert.equal(sw.hidden, true);
});

// 0.19.404: History is ONE list by time (the owner asked whether to merge it, as Activity is): FAST fills, on-chain trades
// (the engine's my_trades), finished AtomiX swaps and finished pool operations, paged together by date
test("0.19.404: History is one chronological list of every kind; NET counts FAST fills only; Show more pages every kind by date, no pool row dropped", async () => {
  const vm = require("node:vm"), H = (c) => "0x" + c.repeat(64), now = new Date(2026, 10, 22, 12).getTime(), MIN = 60000;
  const FILL = { txpowid: H("A"), role: "taker", side: "buy", filled: "500", price: "0.0031", maker: H("B"), orderId: H("C"), coins: [H("D")], status: "done", block: 2417300, ts: (now - 3 * MIN) / 1000 };
  const TRADE = { spentcoin: H("E"), timems: now - 2 * MIN, block: 2417301, price: "0.0032", size: "100", buy: 0, maker: 1, orderid: H("F"), txpowid: H("1"), verification_status: "verified" };
  const item = (kind, key, ts, id) => ({ kind, key, ts, block: 0, pending: false, tag: kind.toUpperCase(), html: `<div id="${id}"></div>` });
  // 70 finished pool rows older than everything else: the first page holds the newest 60 rows of ALL kinds; none is lost
  const pools = Array.from({ length: 70 }, (_, i) => item("pool", "pp:" + i, now - (10 + i) * MIN, "PP" + i));
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, showModal() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
  const els = {}, win = { DexCore: C, console, JSON, Promise, setInterval() {}, setTimeout, localStorage: { getItem: () => null, setItem() {} }, Date: class extends Date { static now() { return now; } },
    DexPools: { tick() {}, render() {}, shared() {}, part: () => "", activityItems: () => [], historyItems: () => pools },
    DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false, activityItems: () => [], historyItems: () => [item("atomix", "ax:" + H("9"), now - MIN, "AXDONE")] },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener() {} };
  win.window = win;
  win.mcd = { dxStatus: async () => ({ version: "0.0.153", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {}, block: 2417310 }), onDexicon() {}, clip: async () => true,
    dxBook: async () => ({ fast: [], book: [], poolAsks: [], poolBids: [], pools: [] }), dxMine: async () => ({ orders: [], pending: [] }), cmd: async () => ({ status: true, response: [] }),
    dxCommand: async (a) => ({ status: true, rows: /fill_%/.test(a.query) ? [{ K: "fill_" + FILL.txpowid, V: JSON.stringify(FILL) }] : [{ K: "activity", V: "[]" }] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/lib/activity.js"), "utf8"), win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  win.document.getElementById("shell").dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  win.DexUI._service(JSON.stringify({ origin: "service", type: "STATE", data: { myTrades: [TRADE, Object.assign({}, TRADE, { fast: true, spentcoin: H("7") })] } }));
  win.DexUI.paint("dexicon"); win.DexUI.pickTab("history"); await settle();
  let html = els.dxBody.innerHTML;
  assert.ok(html.includes("NET · SETTLED FAST-BOOK FILLS"), "the net says it counts FAST fills only");
  const where = ["AXDONE", TRADE.txpowid, 'data-fill="0"', "PP0"].map(s => html.indexOf(s));
  assert.ok(where.every((x, i) => x > 0 && (i === 0 || x > where[i - 1])), "newest first, every kind mixed: AtomiX, on-chain trade, FAST fill, pool " + JSON.stringify(where));
  assert.ok(html.includes(TRADE.spentcoin) && html.includes(TRADE.orderid) && !html.includes(H("7")), "the on-chain trade with its identifiers whole; a FAST row of my_trades is not drawn twice");
  const kinds = [...html.matchAll(/<div class="dx-mix" data-kind="(\w+)">/g)].map(m => m[1]);
  assert.equal(kinds.length, 60, "one page of 60 rows"); assert.deepEqual(kinds.slice(0, 4), ["atomix", "chain", "fast", "pool"]);
  assert.ok(!/ATOMIX SWAPS|POOL OPERATIONS/.test(html), "no separate sections");
  assert.match(html, /data-hmore="1">Show more \(13 remaining\) ▾<\/button>/);
  assert.ok(html.includes("PP56") && !html.includes("PP57"));
  await els.dxBody.onclick({ target: { closest: (sel) => (sel === "button" ? { dataset: { hmore: "1" } } : null) } }); await settle();
  html = els.dxBody.innerHTML;
  assert.ok(html.includes("PP69") && !/data-hmore/.test(html), "the older pool rows are there after Show more, none dropped by a 60 cap");
  const heads = [...html.matchAll(/<div class="dx-day">([^<]*)<\/div>/g)].map(m => m[1]); assert.ok(heads.every((d, i) => heads.indexOf(d) === i), "each day header once");
});

test("0.19.416 (gate review NIT): History says that older on-chain trades are not listed once the engine's list of 200 is full", async () => {
  const vm = require("node:vm"), H = (c) => "0x" + c.repeat(64), now = new Date(2026, 10, 22, 12).getTime();
  const trade = (i) => ({ spentcoin: "0x" + String(i).padStart(64, "0"), timems: now - i * 60000, block: 2417301 - i, price: "0.0032", size: "1", buy: 0, maker: 1, orderid: H("F"), txpowid: H("1"), verification_status: "verified" });
  const mk = (tag) => { const e = { tag, dataset: {}, style: {}, children: [], attrs: {}, hidden: false, value: "", innerHTML: "", textContent: "", classList: { toggle() {} }, contentWindow: { postMessage() {} }, setAttribute(k, v) { e.attrs[k] = v; }, addEventListener() {},
    appendChild(c) { e.children.push(c); c.parent = e; }, remove() {}, showModal() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false }; return e; };
  const els = {}, win = { DexCore: C, console, JSON, Promise, setInterval() {}, setTimeout, localStorage: { getItem: () => null, setItem() {} }, Date,
    DexPools: { tick() {}, render() {}, shared() {}, part: () => "", activityItems: () => [], historyItems: () => [] },
    DexAx: { pill: () => ({ text: "", currency: "", busy: false, label: "" }), tick() {}, switchCurrency() {}, shared() {}, part: () => "", click: async () => false, activityItems: () => [], historyItems: () => [] },
    document: { getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: mk, querySelectorAll: () => [], activeElement: null }, addEventListener() {} };
  win.window = win;
  win.mcd = { dxStatus: async () => ({ version: "0.0.156", started: true, ready: true, restingReady: true, epoch: 1, relays: [], price: {}, block: 2417310 }), onDexicon() {}, clip: async () => true,
    dxBook: async () => ({ fast: [], book: [], poolAsks: [], poolBids: [], pools: [] }), dxMine: async () => ({ orders: [], pending: [] }), cmd: async () => ({ status: true, response: [] }), dxCommand: async () => ({ status: true, rows: [] }) };
  Object.assign(win, require("./i18n-plain.cjs").globals());
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon/lib/activity.js"), "utf8"), win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/dexicon-ui.js"), "utf8") + ";globalThis.DexUI = DexUI;", win);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  win.document.getElementById("shell").dataset.mode = "dex";
  win.DexUI.init({ go() {}, leave() {}, start() {} }); win.DexUI.node({ state: "running" }); await settle();
  const NOTE = "Older on-chain trades are not listed: only your newest 200 are kept here.";
  win.DexUI._service(JSON.stringify({ origin: "service", type: "STATE", data: { myTrades: Array.from({ length: 199 }, (_, i) => trade(i)) } }));
  win.DexUI.paint("dexicon"); win.DexUI.pickTab("history"); await settle();
  assert.ok(!els.dxBody.innerHTML.includes(NOTE), "199: the whole list is there, nothing said");
  win.DexUI._service(JSON.stringify({ origin: "service", type: "STATE", data: { myTrades: Array.from({ length: 200 }, (_, i) => trade(i)) } }));
  win.DexUI.pickTab("history"); await settle();
  assert.ok(els.dxBody.innerHTML.includes(NOTE), "200: the engine's cap is reached and said");
  assert.match(els.dxBody.innerHTML, /data-hmore="1">Show more \(140 remaining\) ▾<\/button><div class="dx-fsmall">Older on-chain trades are not listed/);
});

// ---- 0.19.406: engine 0.0.153 on the native screen ----
test("0.19.406: SWEEP sends: one confirmation with both parts and the worst price; the FAST part take-only through the page's run, then the on-chain remainder as a take-only LIMIT; results with every transaction id whole", async () => {
  const H = (c) => "0x" + c.repeat(32), ORDER = H("0A"), FILLTX = H("1B"), CHAINTX = H("2C");
  let fills = [];
  const u = await tradeUi({ book: OWNER_BOOK, quote: OWNER_QUOTE, fills: () => fills });
  const rows = [...u.els.dxBids.innerHTML.matchAll(/data-side="(\w+)" data-price="([0-9.]+)" data-cum="([0-9.]+)"/g)].map(m => ({ side: m[1], price: m[2], cum: m[3] }));
  u.els.dxBids.onclick({ target: { closest: () => ({ dataset: rows[1] }) } }); await u.settle(); await u.settle();
  const sw = u.els.dxCtaSweep; assert.equal(sw.disabled, false);
  sw.onclick(); await u.settle();
  assert.equal(u.dialogs.length, 1);
  const q = u.dialogs[0].innerHTML;
  assert.match(q, /Sweep SELL 1734\.56789012 MINIMA\?/);
  assert.match(q, /1\. FAST, now: up to 500 MINIMA from the fast book, at 0\.00441234 at worst\./);
  assert.match(q, /2\. Then on-chain \(BOOK \/ POOL\): what is left of your 1734\.56789012 MINIMA, at your limit 0\.004413 at worst/);
  assert.match(q, /Worst price of either part: 0\.00441234 MxUSD per MINIMA\./, "a SELL: the lower of the two");
  assert.match(q, /nothing is left resting/);
  const rev = u.cmds.find(c => c.op === "reviewed");
  assert.deepEqual(JSON.parse(JSON.stringify(rev)), { op: "reviewed", buy: false, price: "0.00441234", amount: "500" }, "the FAST part is signed only inside what was confirmed");
  const d1 = u.drives()[0].drive;
  assert.equal(d1.act, "sweepFast"); assert.deepEqual(JSON.parse(JSON.stringify(d1.args)), { buy: false, limit: "0.00441234", amount: "500" });
  fills = [{ role: "taker", orderId: ORDER, txpowid: FILLTX, side: "sell", filled: "500", price: "0.00441234", ts: Math.floor(Date.now() / 1000) + 1, status: "posted" }];
  u.answer(d1.id, { value: { ok: true, got: "500", unanswered: "0", tried: [ORDER], reason: "" } }); await u.settle(); await u.settle();
  const intent = u.cmds.filter(c => c.op === "intent").pop();
  assert.deepEqual(JSON.parse(JSON.stringify(intent)), { op: "intent", type: "LIMIT", buy: false, price: "0.004413", amount: "1234.56789012" }, "the remainder, at the 6-decimal limit (SELL up)");
  const d2 = u.drives()[1].drive;
  assert.equal(d2.act, "sweepChain"); const ref = d2.args.ref;
  assert.match(ref, /^[A-Za-z0-9]{8,40}$/, "0.19.411: the on-chain part carries its own reference");
  assert.deepEqual(JSON.parse(JSON.stringify(d2.args)), { buy: false, price: "0.004413", amount: "1234.56789012", ref });
  u.answer(d2.id, {}); await u.settle();
  // 0.19.411 (gate review MINOR-4): another action's answer is not this sweep's, however soon it comes
  u.win.DexUI._service(JSON.stringify({ origin: "service", type: "ERROR", data: { message: "That is not one of your active orders" } }));
  u.win.DexUI._service(JSON.stringify({ origin: "service", type: "POSTED", data: { message: "Consolidation submitted", tx: H("3D"), ref: "swOTHER00001" } })); await u.settle(); await u.settle();
  assert.ok(!u.els.dxLog.innerHTML.includes("On-chain:"), "still waiting for its own answer: " + u.els.dxLog.innerHTML);
  u.win.DexUI._service(JSON.stringify({ origin: "service", type: "POSTED", data: { message: "Blended trade submitted — waiting for confirmation", tx: CHAINTX, ref } })); await u.settle(); await u.settle();
  const log = u.els.dxLog.innerHTML;
  assert.ok(log.includes("FAST: 500 MINIMA co-signed and sent.") && log.includes("FAST transaction " + FILLTX), log);
  assert.ok(log.includes("On-chain: Blended trade submitted") && log.includes("On-chain transaction " + CHAINTX), "every id whole");
});

test("0.19.410 (gate review MINOR-3): the SWEEP's FAST part is limited to the worst FAST price the confirmation showed, not the looser typed price", async () => {
  const u = await tradeUi({ book: OWNER_BOOK, quote: OWNER_QUOTE });
  const rows = [...u.els.dxBids.innerHTML.matchAll(/data-side="(\w+)" data-price="([0-9.]+)" data-cum="([0-9.]+)"/g)].map(m => ({ side: m[1], price: m[2], cum: m[3] }));
  u.els.dxBids.onclick({ target: { closest: () => ({ dataset: rows[1] }) } }); await u.settle(); await u.settle();
  u.els.dxPrice.value = "0.0044"; u.els.dxPrice.oninput(); await u.settle(); await u.settle();   // a SELL typed below the FAST bid of 0.00441234
  assert.equal(u.els.dxCtaSweep.hidden, false); u.els.dxCtaSweep.onclick(); await u.settle();
  assert.match(u.dialogs[0].innerHTML, /1\. FAST, now: up to 500 MINIMA from the fast book, at 0\.00441234 at worst\./);
  assert.deepEqual(JSON.parse(JSON.stringify(u.cmds.find(c => c.op === "reviewed"))), { op: "reviewed", buy: false, price: "0.00441234", amount: "500" }, "the signing check's limit is the shown worst");
  const d1 = u.drives()[0].drive;
  assert.deepEqual(JSON.parse(JSON.stringify(d1.args)), { buy: false, limit: "0.00441234", amount: "500" }, "the FAST run never sells below what was shown");
  u.answer(d1.id, { error: "stop here" }); await u.settle();   // ends the money action (the gate is shared)
});

test("0.19.412 (gate review MINOR-5): a FAST click is refused, said and nothing sent, while the page has not checked which FAST orders this node can take; it goes once the check is ready", async () => {
  const book = { fast: [{ side: "sell", price: "0.0031", minima: "250", ours: false }], book: [], poolAsks: [], poolBids: [], pools: [] };
  const u = await tradeUi({ book });
  u.page({ view: pageView(book.fast, false) }); await u.settle();
  u.els.dxPrice.value = "0.0032"; u.els.dxAmount.value = "100"; u.els.dxPrice.oninput(); await u.settle();
  u.els.dxCta.onclick(); await u.settle();
  assert.equal(u.drives().length, 0, "nothing placed: a crossing click never silently rests");
  assert.ok(!u.cmds.some(c => c.op === "reviewed"), "no review recorded");
  assert.match(u.els.dxLog.innerHTML, /Still checking which FAST orders this node can take: try again in a moment\. Nothing was signed or sent\./);
  u.page({ view: pageView(book.fast) }); await u.settle();
  u.els.dxCta.onclick(); await u.settle();
  assert.equal(u.drives().length, 1); assert.equal(u.drives()[0].drive.args.expect, "take");
  u.answer(u.drives()[0].drive.id, { error: "stop here" }); await u.settle();
});

test("0.19.413 (gate review MINOR-7): the FAST ladder never says 'checking…' for ever: after 60 s the reason (the page's error, or no relay answered); my own FAST orders stay on the ladder even with no view", async () => {
  let now = Date.UTC(2026, 10, 23, 12); const RealDate = Date;
  class Clock extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const book = { fast: [{ side: "sell", price: "0.0040", minima: "100", ours: false }, { side: "sell", price: "0.0041", minima: "50", ours: true }], book: [], poolAsks: [], poolBids: [], pools: [] };
  const u = await tradeUi({ book, Date: Clock });
  const kind = () => u.els.dxKind.textContent, asks = () => [...u.els.dxAsks.innerHTML.matchAll(/data-price="([0-9.]+)"/g)].map(m => m[1]);
  const cur = {}, pg = async (p) => { u.page(Object.assign(cur, p)); await u.settle(); };   // the stand-in fills in a ready view unless one is given
  await pg({ view: pageView([book.fast[1]], false), relays: [{ url: "https://relay.example/dex-relay", state: "" }] });
  assert.match(kind(), /checking which FAST orders this node can take…/);
  now += 59000; await pg({ log: ["a"] }); assert.match(kind(), /checking which FAST orders this node can take…/, "still within the minute");
  now += 2000; await pg({ log: ["b"] });
  assert.match(kind(), /the FAST book is not checked: no relay has answered yet/); assert.ok(!/checking…/.test(kind()));
  await pg({ relays: [{ url: "https://relay.example/dex-relay", state: "ok" }] });
  assert.match(kind(), /the FAST book is still not checked after a minute; only your own FAST orders are shown/);
  await pg({ kind: "error", notice: "Relay book unreadable: https://relay.example/dex-relay answered 502" });
  assert.match(kind(), /the FAST book could not be checked: Relay book unreadable: https:\/\/relay\.example\/dex-relay answered 502/);
  assert.deepEqual(asks(), ["0.0041"], "my own order is on the ladder while the view is not ready");
  await pg({ view: null, kind: "", notice: "" });
  assert.deepEqual(asks(), ["0.0041"], "and with no view at all: my own order, never the stranger's unchecked one");
  await pg({ view: pageView(book.fast) });
  assert.ok(!/not checked|checking/.test(kind()), "ready: no line"); assert.deepEqual(asks().sort(), ["0.004", "0.0041"]);
  now += 120000; await pg({ view: pageView(book.fast, false) });
  assert.match(kind(), /checking which FAST orders this node can take…/, "a new wait starts its own minute");
});

test("0.19.406: SWEEP is refused, with the reason and nothing sent, while the on-chain engine or the page's takeable check is not ready", async () => {
  let u = await tradeUi({ book: OWNER_BOOK, quote: OWNER_QUOTE });
  const rows = [...u.els.dxBids.innerHTML.matchAll(/data-side="(\w+)" data-price="([0-9.]+)" data-cum="([0-9.]+)"/g)].map(m => ({ side: m[1], price: m[2], cum: m[3] }));
  u.els.dxBids.onclick({ target: { closest: () => ({ dataset: rows[1] }) } }); await u.settle(); await u.settle();
  u.page({ view: pageView(OWNER_BOOK.fast, false) }); await u.settle();
  u.els.dxCtaSweep.onclick(); await u.settle();
  assert.equal(u.drives().length, 0); assert.equal(u.dialogs.length, 0);
  assert.match(u.els.dxLog.innerHTML, /The FAST book is still being checked for orders this node can take\. Nothing was signed or sent\./);
  Object.assign(u.status, { restingReady: false, restingWhy: "" }); u.page({}); await u.settle();
  assert.equal(u.els.dxCtaSweep.hidden || u.els.dxCtaSweep.disabled, true, "off while the on-chain engine is not ready");
});

test("0.19.406: the ladder shows only the FAST orders the page's takeable view shows (an order this node cannot take is no market); before the page has checked, only my own", async () => {
  const book = { fast: [{ side: "sell", price: "0.0040", minima: "100", ours: false }, { side: "sell", price: "0.0041", minima: "50", ours: true }], book: [], poolAsks: [], poolBids: [], pools: [] };
  const u = await tradeUi({ book });
  const asks = () => [...u.els.dxAsks.innerHTML.matchAll(/data-price="([0-9.]+)"/g)].map(m => m[1]);
  assert.deepEqual(asks().sort(), ["0.004", "0.0041"].sort());
  u.page({ view: pageView([book.fast[1]]) }); await u.settle();   // the takeable rule hid the stranger's order
  assert.deepEqual(asks(), ["0.0041"], "the relay's raw list (dxBook) is not what is drawn");
  u.page({ view: Object.assign(pageView([book.fast[1]], false)) }); await u.settle();
  assert.match(u.els.dxKind.textContent, /checking which FAST orders this node can take…/);
  u.page({ view: Object.assign(pageView([book.fast[1]]), { hidden: "1 order hidden: its coins could not be found" }) }); await u.settle();
  assert.match(u.els.dxKind.textContent, /1 order hidden: its coins could not be found/);
  const ui = fs.readFileSync(path.join(__dirname, "..", "renderer", "dexicon-ui.js"), "utf8"), bridge = fs.readFileSync(path.join(__dirname, "..", "renderer", "dexicon", "mds.js"), "utf8");
  assert.ok(/const lad = \(\) => C\.ladder\(X\.book, X\.group, takeable\(\)\);/.test(ui));
  assert.ok(/asks: DexiconFast\.bookView\(true, ""\), bids: DexiconFast\.bookView\(false, ""\), hidden: String\(h\.summary \|\| ""\)/.test(bridge) && /ready: !!DexiconFast\.ready\(\), rev: Number\(DexiconFast\.rev\(\)\)/.test(bridge));
});

test("0.19.406: an order placed on old coins: the engine's notice is said; a coinless order is 'waiting for its coins'; the service's alerts are said", async () => {
  const says = C.pageSays({ notice: "Fast sell 10 MINIMA @ 0.004 placed; goes live to takers after the next block (refreshing your coins) — on 2/2 relays — order 0xAB", kind: "posted", log: [] }, {});
  assert.deepEqual(says.lines, ["Fast sell 10 MINIMA @ 0.004 placed; goes live to takers after the next block (refreshing your coins) — on 2/2 relays — order 0xAB"]);
  const u = await tradeUi({ book: CHAIN_BOOK });
  u.win.DexUI._service(JSON.stringify({ type: "save_failed", where: "fill", message: "the fill of 5 MINIMA on order 0x01 was NOT applied" })); await u.settle();
  assert.match(u.els.dxLog.innerHTML, /A save of your orders did not land: the fill of 5 MINIMA on order 0x01 was NOT applied\. Nothing was placed, cancelled or published by it\./);
  const ui = fs.readFileSync(path.join(__dirname, "..", "renderer", "dexicon-ui.js"), "utf8");
  assert.ok(ui.includes('I18N.t("waiting for its coins: goes live to takers after the next block")'));
});
