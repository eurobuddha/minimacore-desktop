// Dexicon room ① MxUSD (Phase 3c): AtomiX's screens were replaced, its behaviour was not. Each money action is run
// twice here, once through the panel it replaces (renderer/atomix-ui.js, executed on a stand-in page) and once
// through the new screens' action (renderer/dexicon-ax.js Act), against the same recording window.mcd; the calls,
// their arguments and their order must be identical, and a refused confirm must stop both before the same call.
// Nothing here reaches a node, Ethereum or the network: any call that is not a recorded stand-in throws.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), vm = require("vm");
require("./dexicon-mock.cjs");   // FIRST: the real rpcCall and the real network throw from here on
const os = require("os");
const R = path.join(__dirname, "..", "renderer");
const AX = require("../renderer/dexicon-ax.js"), C = require("../renderer/dexicon-core.js");

const PK = (n) => "0x" + (n + "FA4E".repeat(16)).slice(0, 64);
const QUOTE = { quoteId: "q7", mode: "sweep", sell: false, single: null, label: "mxUSDT", meta: {},
  plan: { legs: [{ maker: PK("D1"), price: 1.01, minima: "100", usdt: "101" }, { maker: PK("D2"), price: 1.02, minima: "18.811881", usdt: "19.188118" }], filledMinima: 118.811881, totalUsdt: 120.188118, avgPrice: 1.011583, worstPrice: 1.02, target: 118.811881, partial: false, stopReason: "", slippagePct: 4.2 } };
const SINGLE = { quoteId: "q8", mode: "single", sell: true, single: { minima: "50", usdt: "49.5", price: 0.99, maker: PK("D1") }, plan: null, label: "mxUSDT", meta: {} };
const BOOK = { scanned: 2, makers: 2, bestBid: 0.99, bestAsk: 1.01, bidCap: 100, askCap: 100, bids: [], asks: [], currency: "mxusdt", label: "mxUSDT", pricingParity: true };

/** window.mcd as a recorder: every call is logged with its arguments; `answers` gives what each returns. A call with
 *  no answer throws, so nothing unplanned (and nothing real) can be reached. */
function recorder(answers) {
  const log = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => {
    log.push([name, JSON.parse(JSON.stringify(args))]);
    if (!(name in answers)) return Promise.reject(new Error("unexpected call " + String(name)));
    const a = answers[name]; return Promise.resolve(typeof a === "function" ? a(...args) : a);
  } });
  return { api, log, money: () => log.filter(([n]) => !READS.includes(n)) };
}
// reads the two screens make at different moments (drawing); the comparison is over everything else
const READS = ["axStatus", "axBook", "axSwaps", "axWallet", "axSwapPreview", "axMakerCfg", "axMarketHistory", "axOtc", "axCoins"];

/** The old panel on a stand-in page: elements exist when asked for, hold a value and their handlers. */
function oldPanel(api, confirm, prompts) {
  const els = {}, said = [];
  const mk = (id) => { const set = new Set(); return { id, value: "", textContent: "", innerHTML: "", disabled: false, dataset: {}, style: {}, _l: {},
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }, fire(t) { (this._l[t] || []).forEach((f) => f({ stopPropagation() {} })); },
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {}, contains: () => false, remove() {}, getContext: () => null }; };
  const el = (id) => els[id] || (els[id] = mk(id));
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, body: mk("body"), documentElement: mk("html"), activeElement: null };
  const ctx = vm.createContext({ window: null, document, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, Math, Number, String, JSON, Promise, isFinite, parseFloat, parseInt, getComputedStyle: () => ({ getPropertyValue: () => "" }) });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(R, "atomix-ui.js"), "utf8"), ctx, { filename: "atomix-ui.js" });
  const queue = (prompts || []).slice();
  ctx.AtomixPanel.init({ api, el, esc: (s) => String(s == null ? "" : s), toast: (m, k) => said.push([m, k || ""]), copy() {}, TOK: { shortId: (x) => x }, relTime: () => "", idHtml: (x) => String(x),
    showConfirm: async (title, msg, ok) => { said.push(["confirm", title, ok]); return confirm; }, showPrompt: async () => queue.shift(), running: () => true, activeView: () => "atomix" });
  return { el, said, P: ctx.AtomixPanel, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
const ui = (confirm) => { const said = []; return { said, confirm: async (title, text, ok) => { said.push(["confirm", title, ok]); return confirm; }, say: (text, kind) => said.push([text, kind]) }; };

// ---- take: axQuote (frozen) → review → axSwap(quoteId) ----
const TAKES = [
  { name: "buy, the coin typed", sell: false, typedCoin: true, text: "118.811881", quote: QUOTE },
  { name: "buy, the USDT typed (the coin amount comes from the best price)", sell: false, typedCoin: false, text: "120", quote: QUOTE },
  { name: "sell, the coin typed, a single part", sell: true, typedCoin: true, text: "50", quote: SINGLE },
  { name: "sell, the USDT typed", sell: true, typedCoin: false, text: "49.5", quote: SINGLE },
  { name: "letters and a second dot in the amount", sell: true, typedCoin: true, text: "5x0", quote: SINGLE },
  { name: "nothing typed", sell: true, typedCoin: true, text: "", quote: SINGLE },
  { name: "the quote is refused (not enough USDT)", sell: false, typedCoin: true, text: "9000", quote: { err: "Need ≈ 9090.000000 USDT for that — you have 217.912562 USDT." } }
];
async function oldTake(c, confirm) {
  const r = recorder({ axStatus: { ready: true, currency: "mxusdt" }, axBook: BOOK, axSwaps: [], axWallet: null, axSwapPreview: null, axQuote: c.quote, axSwap: { ok: 1, of: 1, hashes: [PK("B1")] } });
  const p = oldPanel(r.api, confirm);
  p.P._setView("swap"); await p.P.render(); await p.settle();
  if (!c.sell) { p.el("axDirBuy").onclick(); await p.settle(); }   // the old panel opens on Sell
  const input = p.el((c.typedCoin ? "axInCcy" : "axInUsdt")); input.value = c.text; input.fire("input");
  await p.el("axReview").onclick(); await p.settle();
  return r.money();
}
async function newTake(c, confirm) {
  const r = recorder({ axQuote: c.quote, axSwap: { ok: 1, of: 1, hashes: [PK("B1")] } }), u = ui(confirm);
  const price = c.sell ? BOOK.bestBid : BOOK.bestAsk;
  await AX.Act.take(r.api, u, c.sell, AX.coinAmount(c.typedCoin, c.text, price), 4.2, "MxUSD");
  return { calls: r.money(), said: u.said };
}
for (const c of TAKES) for (const confirm of [true, false]) {
  test(`take, ${c.name}, review ${confirm ? "accepted" : "closed"}: the same calls with the same arguments as the old panel`, async () => {
    const was = await oldTake(c, confirm), now = await newTake(c, confirm);
    assert.deepEqual(now.calls, was);
    const swapped = now.calls.some(([n]) => n === "axSwap");
    assert.equal(swapped, confirm && !c.quote.err && !!AX.cleanNum(c.text), "axSwap only after an accepted review of a quote that was given");
    if (swapped) assert.deepEqual(now.calls[now.calls.length - 1], ["axSwap", [c.quote.quoteId]], "the frozen quote's id, nothing else");
  });
}
test("take: the slippage the user chose is the third argument of axQuote, and a custom entry is kept as the old panel kept it", async () => {
  for (const [text, want] of [["2", 2], ["4.2", 4.2], ["1.55", 1.6], ["0.1", 0.1], ["50", 50], ["0.05", null], ["51", null], ["abc", null]]) assert.equal(AX.slipOf(text), want, text);
  const r = recorder({ axQuote: { err: "x" } });
  await AX.Act.take(r.api, ui(true), false, "10", AX.slipOf("1.55"), "MxUSD");
  assert.deepEqual(r.log, [["axQuote", [false, "10", 1.6]]]);
});
test("take: every outcome says what happened, whether anything was locked, and what to do", () => {
  const all = AX.takeResult({ ok: 2, of: 2, hashes: [] }), part = AX.takeResult({ ok: 1, of: 3, hashes: [], stopped: "Sweep stopped at part 2: maker vanished from the reviewed book" });
  assert.match(all.text, /^2 of 2 parts locked\. Nothing is swapped yet/); assert.equal(all.kind, "note");
  assert.match(part.text, /^1 of 3 parts locked\. Sweep stopped at part 2/); assert.equal(part.kind, "error");
  assert.equal(AX.takeResult({ ok: 0, of: 1, hashes: [] }).text, "0 of 1 part locked. No lock was confirmed. Look at In progress before trying again.");
  assert.match(AX.takeResult({ err: "That quote has expired — review the swap again." }).text, /Nothing was locked\.$/);
  assert.match(AX.takeResult(null).text, /Look at Activity before trying again/);
});

// ---- the ⇄ pill ----
for (const cur of ["mxusdt", "minima"]) for (const confirm of [true, false]) {
  test(`currency switch from ${cur}, ${confirm ? "confirmed" : "closed"}: the old panel's confirm, then the same axSwitchCurrency`, async () => {
    const ro = recorder({ axStatus: { ready: true, currency: cur }, axBook: BOOK, axSwaps: [], axWallet: null, axSwitchCurrency: { ok: true } }), p = oldPanel(ro.api, confirm);
    p.P._setStatus({ ready: true, currency: cur }); p.P._setView("swap"); await p.P.render(); await p.settle();
    await p.el("axCcy").onclick(); await p.settle();
    const rn = recorder({ axSwitchCurrency: { ok: true } }), u = ui(confirm);
    await AX.Act.switchCurrency(rn.api, u, cur);
    assert.deepEqual(rn.money(), ro.money());
    assert.deepEqual(rn.money(), confirm ? [["axSwitchCurrency", [cur === "minima" ? "mxusdt" : "minima"]]] : []);
    assert.equal(u.said[0][1], p.said.find((x) => x[0] === "confirm")[1], "the same question");
  });
}

// ---- settlement is never frozen: Refund now and Check now make the old panel's calls ----
test("Refund now and Check now: axRefundNow(hash) and axInspect(hash), as the old panel; the engine's words with the token named MxUSD", async () => {
  const r = recorder({ axRefundNow: { msg: "Refund opens at block 2428200 for your mxUSDT lock.", opened: false }, axInspect: ["Your mxUSDT lock is confirmed.", "USDT side: not locked yet."] });
  assert.equal(await AX.Act.refundNow(r.api, ui(true), PK("90")), "Refund opens at block 2428200 for your MxUSD lock.");
  assert.deepEqual(await AX.Act.inspect(r.api, PK("90")), ["Your MxUSD lock is confirmed.", "USDT side: not locked yet."]);
  assert.deepEqual(r.log, [["axRefundNow", [PK("90")]], ["axInspect", [PK("90")]]]);
  const bad = recorder({});
  assert.match(await AX.Act.refundNow(bad.api, ui(true), PK("90")), /^Refund check failed: /);
});
test("there is no way to cancel a swap: no action, no button, no call", () => {
  assert.deepEqual(Object.keys(AX.Act).filter((k) => /cancel|abort/i.test(k)), []);
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/data-ax(cancel|abort)|>\s*Cancel (swap|lock)/i.test(src), "no cancel control is drawn");
  assert.ok(!/api\(\)\.ax[A-Za-z]*(Cancel|Abort)/.test(src));
});

// ---- the screens' words and numbers ----
test("amounts are cut, never rounded; prices keep six significant figures; sizes abbreviate by cutting", () => {
  assert.equal(AX.cut(118.8118819, 6), "118.811881"); assert.equal(AX.cut(4.2, 6), "4.2"); assert.equal(AX.cut(0.9999999, 6), "0.999999"); assert.equal(AX.cut(1000, 6), "1000");
  assert.equal(AX.ax6(49.9999999), "49.999999"); assert.equal(AX.ax6(0), "");
  assert.equal(AX.fmtPx(1.011583), "1.01158"); assert.equal(AX.fmtPx(0.99), "0.99"); assert.equal(AX.fmtPx(0), "0");
  assert.equal(AX.abbrev(10199.9), "10.1k"); assert.equal(AX.abbrev(9.999), "9.99"); assert.equal(AX.abbrev(0), "—");
});
test("the token is MxUSD wherever a user reads it; USDT names only the Ethereum leg", () => {
  assert.equal(AX.ccyName("mxUSDT"), "MxUSD"); assert.equal(AX.ccyName("mxusdt"), "MxUSD"); assert.equal(AX.ccyName("Minima"), "MINIMA"); assert.equal(AX.ccyName("USDT"), "USDT");
  assert.equal(AX.tok(AX.MXUSD), "MxUSD"); assert.equal(AX.tok("0x00"), "MINIMA"); assert.equal(AX.tok("USDT"), "USDT");
  assert.equal(AX.mx("You locked 100 mxUSDT for USDT"), "You locked 100 MxUSD for USDT");
  assert.equal(AX.MXUSD, "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const shown = [...src.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] || m[2] || "").filter((t) => /mxusdt/i.test(t));
  assert.deepEqual(shown.filter((t) => !/^(mxusdt|\^mxusdt\?\$)$/i.test(t) && !/data-axccy|=== "mxusdt"/.test(t)), [], "mxUSDT appears only as the engine's key");
});
test("the review names every part with its maker key whole", () => {
  const r = AX.review(QUOTE, false);
  assert.equal(r.title, "Buy ≈ 118.811881 MxUSD for ≈ 120.188118 USDT in 2 parts"); assert.equal(r.ok, "Start sweep");
  for (const l of QUOTE.plan.legs) assert.ok(r.text.includes(l.maker), "the maker key in full");
  assert.match(r.text, /you pay ETH gas 2 times/);
  const s = AX.review(SINGLE, true);
  assert.equal(s.title, "Review: Sell MxUSD"); assert.ok(s.text.includes(PK("D1"))); assert.equal(s.ok, "Start swap");
  assert.ok(!/…|\.\.\./.test(r.text + s.text), "nothing is shortened");
});
test("YOUR SWAP: the newest swap in flight, or one that finished in the last 30 s; a refund and a failure are said", () => {
  const now = 1e12, sw = (hash, status, created, updated) => ({ hash, status, role: "INITIATOR", selltoken: "USDT", sellamount: "25", buytoken: AX.MXUSD, buyamount: "24.75", created, updated });
  const bals = { minima: "1", usdt: "0", eth: "0.01" };
  let s = AX.stages(false, "MxUSD", true, bals, [], now);
  assert.deepEqual(s.rows.map((r) => r.state + " " + r.text), ["done Node connected", "warn USDT ready to spend", "done ETH for gas", "pending Enter an amount and tap Review to begin"]);
  s = AX.stages(false, "MxUSD", true, bals, [sw("a", "STARTED", now - 9e5, now - 9e5), sw("b", "LOCKED", now - 1e5, now - 1e5), sw("c", "COMPLETE", now - 5e6, now - 1000)], now);
  assert.equal(s.check, "b"); assert.equal(s.more, 1); assert.equal(s.which, "25 USDT  →  24.75 MxUSD   ·   taker");
  assert.deepEqual(s.rows.slice(3).map((r) => r.state), ["done", "done", "active", "pending"]);
  s = AX.stages(false, "MxUSD", true, bals, [sw("c", "REFUNDED", now - 5e6, now - 1000)], now);
  assert.equal(s.rows[3].text, "Timed out: 25 USDT refunded"); assert.equal(s.check, "", "a finished swap has nothing to check from here");
  assert.equal(AX.stages(false, "MxUSD", true, bals, [sw("c", "REFUNDED", now - 5e6, now - 31000)], now).rows.length, 4, "after 30 s it is gone from the tracker");
  assert.equal(AX.stages(true, "MxUSD", false, bals, [], now).rows[0].state, "warn", "node not connected");
});
test("a swap's card: maker-side swaps are named as such, a swap waiting for its deadline says when the refund opens, ids are whole", () => {
  const base = { hash: PK("92"), role: "INITIATOR", direction: "ERC20_TO_MINIMA", status: "STARTED", selltoken: "USDT", sellamount: "40", buytoken: AX.MXUSD, buyamount: "39.6", created: 1, counterparty: PK("D1"), contractId: PK("F9"), detail: "Waiting for the maker to lock mxUSDT." };
  const wait = AX.swapItem(Object.assign({}, base, { vis: { blocks: true, steps: ["Locked"], respondBy: 100, refundAt: 150, cur: 120, refundOpen: false, canRefund: true, timedOut: true, notice: { state: "declined", reason: "too many coins" } } }));
  assert.equal(wait.title, "AtomiX entry"); assert.equal(wait.chip, "LIVE");
  assert.deepEqual(wait.refund, { label: "Refund now (opens in 31 blocks)", enabled: false });
  assert.ok(wait.lines.includes("Maker declined: too many coins")); assert.ok(wait.lines.includes("Refund opens block 151: automatic, app open or not"));
  assert.equal(wait.lines[0], "Waiting for the maker to lock MxUSD.");
  assert.deepEqual(wait.ids, [["swap", PK("92")], ["counterparty", PK("D1")], ["swap id on Ethereum", PK("F9")]]);
  const open = AX.swapItem(Object.assign({}, base, { vis: { blocks: true, respondBy: 100, refundAt: 150, cur: 151, refundOpen: true, canRefund: true, timedOut: true } }));
  assert.deepEqual(open.refund, { label: "Refund now", enabled: true });
  const maker = AX.swapItem(Object.assign({}, base, { role: "RESPONDER", status: "LOCKED", direction: "MINIMA_TO_ERC20", selltoken: AX.MXUSD, buytoken: "USDT", vis: null }));
  assert.equal(maker.title, "AtomiX · your market filled"); assert.equal(maker.sub, "maker · you locked · waiting for the taker to claim"); assert.equal(maker.refund, null);
  assert.equal(AX.swapItem(Object.assign({}, base, { status: "ERROR", vis: null })).chip, "FAILED");
  assert.match(AX.HIDE_ASK(false), /hiding doesn't touch them.*Check now, Refund now and Unhide/);
});
test("the launch rule: MxUSD mode says nothing; MINIMA mode stays, with the reason, while something of the user's is live there", () => {
  assert.equal(AX.launch("mxusdt", [], false, false), null);
  assert.equal(AX.launch("minima", null, null, false), null, "not read yet: nothing is claimed");
  assert.match(AX.launch("minima", [{ status: "LOCKED" }], false, false).text, /^Opened in MINIMA mode: a USDT ⇄ MINIMA swap or OTC deal is in flight\. Dexicon never switches a live market by itself/);
  assert.match(AX.launch("minima", [{ status: "COMPLETE" }], true, false).text, /your MINIMA market is live\./);
  assert.match(AX.launch("minima", [{ status: "STARTED" }], true, false).text, /is in flight and your MINIMA market is live/);
  const idle = AX.launch("minima", [{ status: "REFUNDED" }], false, false);
  assert.equal(idle.idle, true); assert.match(idle.text, /None of your swaps there is unfinished, your MINIMA market is not on the book and your OTC availability is off\. Use the ⇄ pill/);
  assert.equal(AX.makerLive({ state: { withdrawn: false } }, { bids: [{ mine: true }], asks: [] }), true);
  assert.equal(AX.makerLive({ state: { withdrawn: true } }, { bids: [{ mine: true }], asks: [] }), false);
  assert.equal(AX.makerLive(null, null), null);
});
test("the room: the phone's six tabs, opened on Swap at every start; Activity, Assets and Settings are the shared screens", () => {
  assert.deepEqual(C.ROOMS[0].tabs.map((t) => C.TAB_LABEL[t]), ["Swap", "Market", "OTC", "Activity", "Assets", "Settings"]);
  assert.deepEqual(C.SHARED, ["activity", "assets", "settings"]);
  const mem = C.load(JSON.stringify({ tabs: { mxusd: "otc", exchange: "orders" } }));
  assert.equal(mem.room, 0); assert.equal(mem.tabs.mxusd, "swap", "a new start opens room 1 on Swap"); assert.equal(mem.tabs.exchange, "orders");
  C.pickTab(mem, "market"); assert.equal(C.tabOf(mem), "market", "and the tab is kept while the app runs");
});
test("the old panel is still in the tree, untouched by room ①, and is no longer drawn", () => {
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  assert.ok(fs.existsSync(path.join(R, "atomix-ui.js")));
  assert.match(html, /<div class="axapp" id="axBody" hidden><\/div>/); assert.match(html, /<div class="dxapp" id="dxAxBody"><\/div>/);
  assert.ok(!/AtomixPanel\.render\(/.test(app), "nothing asks the old panel to draw");
  assert.ok(html.indexOf('src="dexicon-ax.js"') < html.indexOf('src="dexicon-ui.js"'));
});

// ---- Market: the maker's order ----
const MC = { cfg: { pegEnable: false, step: 1, levels: 3, size: 100, bias: 0, reprice: 1, min: 5 }, manual: { bids: [], asks: [] }, state: { withdrawn: false }, lastPublishMs: 0 };
const MAKER_ANSWERS = () => ({ axStatus: { ready: true, currency: "mxusdt" }, axBook: BOOK, axSwaps: [], axWallet: null, axMarketHistory: { chart: [], recent: [] }, axMakerCfg: MC,
  axMakerPreview: { ok: true, mid: 0, source: "Parity" }, axMakerSave: { ok: true }, axMakerPublish: { ok: true }, axMakerWithdraw: { ok: true } });
async function oldEditor(confirm) {
  const r = recorder(MAKER_ANSWERS()), p = oldPanel(r.api, confirm);
  p.P._setView("market"); await p.P.render(); await p.settle();
  p.el("axEdit").onclick(); await p.settle();
  return { r, p };
}
const FORMS = [
  { name: "a manual ladder, two rungs a side", on: { enabled: true, peg: false }, f: { step: "1", size: "100", bias: "0", reprice: "1", levels: "2", min: "5", bidP0: "0.99", bidA0: "100", bidP1: "0.98", bidA1: "250.5", askP0: "1.01", askA0: "100", askP1: "1.02", askA1: "80" } },
  { name: "pegged, size and step set", on: { enabled: true, peg: true }, f: { step: "0.5", size: "40", bias: "-2", reprice: "", levels: "9", min: "", bidP0: "0.995", bidA0: "40", askP0: "1.005", askA0: "40" } },
  { name: "pegged but no size: the peg is not armed", on: { enabled: true, peg: true }, f: { step: "1", size: "", bias: "", reprice: "2", levels: "0", min: "1", bidP0: "0.9", bidA0: "10" } },
  { name: "rungs with a price and no amount, or text, are left out", on: { enabled: true, peg: false }, f: { step: "1", size: "5", levels: "3", bidP0: "0.99", bidA0: "", bidP1: "abc", bidA1: "5", askP0: "1.01", askA0: "7" } },
  { name: "Enabled is off: the market is withdrawn, nothing is saved", on: { enabled: false, peg: true }, f: { step: "1", size: "100", levels: "3", bidP0: "0.99", bidA0: "100" } }
];
const OLD_ID = (n) => ({ step: "axStep", size: "axSize", bias: "axBias", reprice: "axReprice", levels: "axLevels", min: "axMin" }[n] || "ax" + n[0].toUpperCase() + n.slice(1));   // bidP0 → axBidP0
for (const c of FORMS) test(`Save & publish, ${c.name}: the same call and the same cfg and ladder as the old editor`, async () => {
  const { r, p } = await oldEditor(true);
  for (const [k, v] of Object.entries(c.f)) p.el(OLD_ID(k)).value = v;
  for (const [id, on] of [["axEnabled", c.on.enabled], ["axPegToggle", c.on.peg]]) p.el(id).classList.toggle("on", on);
  await p.el("axSave").onclick(); await p.settle();
  const rn = recorder(MAKER_ANSWERS());
  await AX.Act.makerSave(rn.api, ui(true), AX.makerForm((n) => c.f[n] || "", (n) => c.on[n]));
  assert.deepEqual(rn.money(), r.money());
  assert.equal(rn.money().length, 1); assert.equal(rn.money()[0][0], c.on.enabled ? "axMakerSave" : "axMakerWithdraw");
});
test("the editor's prices from mid, step and skew are the old editor's, rung for rung", async () => {
  for (const [mid, step, bias, levels] of [["1", "1", "0", "3"], ["0.00332683", "0.5", "-2", "6"], ["1.0004", "2.5", "35", "2"], ["1", "1", "0", "0"], ["", "1", "0", "3"], ["1", "0", "0", "3"]]) {
    const { p } = await oldEditor(true);
    for (let i = 0; i < 6; i++) for (const k of ["axBidP", "axAskP", "axBidA", "axAskA"]) p.el(k + i).value = "";
    p.el("axStep").value = step; p.el("axBias").value = bias; p.el("axLevels").value = levels; p.el("axSize").value = ""; p.el("axMid").value = mid; p.el("axMid").fire("input");
    const old = []; for (let i = 0; i < 6; i++) if (p.el("axBidP" + i).value) old.push({ bid: p.el("axBidP" + i).value, ask: p.el("axAskP" + i).value });
    assert.deepEqual(AX.ladderPrices(mid, step, bias, levels), old, [mid, step, bias, levels].join(" / "));
  }
});
for (const confirm of [true, false]) test(`Publish and Withdraw (${confirm ? "confirmed" : "closed"}): axMakerPublish at once, axMakerWithdraw only after the old confirm`, async () => {
  const { r, p } = await oldEditor(confirm);
  await p.el("axWithdraw").onclick(); await p.settle();
  const old = r.money();
  const rn = recorder(MAKER_ANSWERS()), u = ui(confirm);
  await AX.Act.makerWithdraw(rn.api, u);
  assert.deepEqual(rn.money(), old); assert.deepEqual(rn.money(), confirm ? [["axMakerWithdraw", []]] : []);
  assert.equal(u.said[0][1], p.said.find((x) => x[0] === "confirm")[1], "the same question");
  const ro = recorder(MAKER_ANSWERS()), po = oldPanel(ro.api, confirm);
  po.P._setView("market"); await po.P.render(); await po.settle(); await po.el("axPublish").onclick(); await po.settle();
  const rp = recorder(MAKER_ANSWERS()); await AX.Act.makerPublish(rp.api, ui(confirm));
  assert.deepEqual(rp.money(), ro.money()); assert.deepEqual(rp.money(), [["axMakerPublish", []]]);
});
test("a publish, save or withdrawal that fails says it was NOT done, and what stands", async () => {
  for (const [act, args, re] of [["makerPublish", [], /^Your market is NOT on the book yet: publish timed out\. What was on the book before is unchanged\. While it runs, AtomiX publishes the saved order again by itself/], ["makerWithdraw", [], /^Your market was NOT withdrawn: .* It may still be on the book\.$/],
    ["makerSave", [{ cfg: {}, manual: {} }], /^Your order was SAVED but is not on the book yet: publish timed out\. While it runs, AtomiX publishes the saved order again by itself: at the next reprice, or within 30 minutes\. To stop that, withdraw the market\.$/], ["makerSave", [{ withdraw: true }], /^Your market was NOT withdrawn: /]]) {
    const u = ui(true); const boom = async () => { throw new Error("publish timed out"); }; await AX.Act[act]({ axMakerPublish: boom, axMakerWithdraw: boom, axMakerSave: boom }, u, ...args);
    const last = u.said[u.said.length - 1]; assert.match(last[0], re); assert.equal(last[1], "error");
  }
});
test("the editor's summary: the spread, and a crossed ladder is said before anything is published", () => {
  const ok = AX.ladderSummary({ bids: [{ p: 0.99, a: 100 }, { p: 0.98, a: 50 }], asks: [{ p: 1.01, a: 100 }] }, "MxUSD");
  assert.equal(ok.crossed, false); assert.equal(ok.spread, "spread 0.02 · 2%"); assert.equal(ok.bids, "2 lvl · best 0.99 · 150 MxUSD"); assert.equal(ok.asks, "1 lvl · best 1.01 · 100 MxUSD");
  const x = AX.ladderSummary({ bids: [{ p: 1.02, a: 1 }], asks: [{ p: 1.01, a: 1 }] }, "MxUSD");
  assert.equal(x.crossed, true); assert.match(x.warn, /^Crossed: best bid 1\.02 is at or above best ask 1\.01\./);
  assert.equal(AX.ladderSummary({ bids: [], asks: [] }, "MxUSD").spread, "—");
});
test("YOUR OFFER: live only with my own levels on the book and not withdrawn; saved, off and withdrawn are told apart", () => {
  const book = { bids: [{ p: 0.985, cap: 100, mine: true }, { p: 0.99, cap: 5, mine: false }], asks: [{ p: 1.015, cap: 1200, mine: true }] };
  const live = AX.offerState({ cfg: { step: 1, pegEnable: true }, state: {}, lastPublishMs: 5 }, book, "Parity");
  assert.equal(live.live, true); assert.match(live.text, /^Live · pegged to Parity · /); assert.deepEqual(live.rows, ["ASK  1.015   1.2k", "BID  0.985   100"]);
  assert.match(AX.offerState({ cfg: { step: 1 }, state: { withdrawn: true } }, book, "MEXC").text, /^Withdrawn: /);
  assert.match(AX.offerState({ cfg: { step: 1 }, state: {} }, { bids: [], asks: [] }, "MEXC").text, /^Saved, not on the book/);
  assert.match(AX.offerState({ cfg: {}, manual: { bids: [], asks: [] }, state: {} }, { bids: [], asks: [] }, "MEXC").text, /^Off — edit your order, then Publish\.$/);
  assert.equal(AX.offerState(null, null, "MEXC").text, "…");
});
test("the 'buys declined' warning uses the engine's own read limits", () => {
  const htlc = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "htlc.js"), "utf8");
  assert.ok(htlc.includes(`=== '0x00' ? ${AX.COIN_CAP.minima} : ${AX.COIN_CAP.mxusdt};`), "COIN_CAP equals guardedCoins' cap");
  assert.equal(AX.coinWarn("mxusdt", 53), ""); assert.equal(AX.coinWarn("mxusdt", 54), "54 MxUSD coins: AtomiX buys are being declined. Consolidate.");
  assert.equal(AX.coinWarn("minima", 200), ""); assert.match(AX.coinWarn("minima", 201), /^201 MINIMA coins/); assert.equal(AX.coinWarn("mxusdt", undefined), "");
});

// ---- OTC ----
const LP = { cid: PK("C1"), mpk: PK("C2"), eth: "0xFA4E0000FA4E0000FA4E0000FA4E0000FA4E0002", sell: 2000, buy: 750 };
const OTC = { board: [LP], deals: [{ ref: "d1", side: "SELL", amount: "300", price: "1.004", status: "PROPOSED", whoseTurn: "ME" }], myOffer: { enable: false, sellSize: 500, buySize: 250 } };
const OTC_ANSWERS = () => ({ axStatus: { ready: true, currency: "mxusdt" }, axOtc: OTC, axOtcGoLive: { ok: true }, axOtcWithdraw: { ok: true }, axOtcPropose: { ok: true }, axOtcDeal: { ok: true } });
async function oldOtc(prompts) { const r = recorder(OTC_ANSWERS()), p = oldPanel(r.api, true, prompts); p.P._setView("otc"); await p.P.render(); await p.settle(); return { r, p }; }
test("OTC availability: Go live sends the two sizes as typed, Withdraw sends nothing else, as the old panel", async () => {
  for (const [sell, buy] of [["500", "250"], ["", "1000.5"], ["", ""]]) {
    const { r, p } = await oldOtc(); p.el("axOtcSell").value = sell; p.el("axOtcBuy").value = buy;
    await p.el("axOtcLive").onclick(); await p.el("axOtcWithdraw").onclick(); await p.settle();
    const rn = recorder(OTC_ANSWERS()); await AX.Act.otcGoLive(rn.api, ui(true), sell, buy); await AX.Act.otcWithdraw(rn.api, ui(true));
    assert.deepEqual(rn.money(), r.money()); assert.deepEqual(rn.money(), [["axOtcGoLive", [sell, buy]], ["axOtcWithdraw", []]]);
  }
});
// the old panel wired its LP and deal buttons through querySelectorAll, which the stand-in page does not parse: its
// propose is reached through the prompts, and its accept / reject calls are the two-argument axOtcDeal read below
for (const [side, amount, price] of [["SELL", "300", "1.004"], ["BUY", "120.5", "0.997"], ["buy", "5", "1"], ["HOLD", "5", "1"], ["SELL", "", "1"]]) test(`OTC propose ${side} ${amount || "(no amount)"} @ ${price}: axOtcPropose with the LP's three ids, the side, the amount and the price as text`, async () => {
  const rn = recorder(OTC_ANSWERS()); await AX.Act.otcPropose(rn.api, ui(true), LP, side, amount, price);
  const good = /^(sell|buy)$/i.test(side) && !!amount;
  assert.deepEqual(rn.money(), good ? [["axOtcPropose", [{ cid: LP.cid, mpk: LP.mpk, eth: LP.eth }, side.toUpperCase(), amount, price]]] : []);
  // the old panel's own function, lifted out of its file and run with the same answers to its three prompts
  const src = fs.readFileSync(path.join(R, "atomix-ui.js"), "utf8"), from = src.indexOf("async function axOtcPropose(lp)"), to = src.indexOf("// ---- Wallet (ETH) ----");
  const ro = recorder(OTC_ANSWERS()), queue = [side, amount, price];
  const old = new Function("api", "showPrompt", "toast", "renderAxOtc", "axCcyOf", "axStatusCache", src.slice(from, to) + "; return axOtcPropose;")(ro.api, async () => queue.shift(), () => {}, () => {}, () => "MxUSD", {});
  await old(LP);
  assert.deepEqual(rn.money(), ro.money(), "the same call as the old panel's axOtcPropose");
});
test("OTC deals: accept and reject are axOtcDeal(ref, action) as the old panel wrote them; a counter adds the amount and price", async () => {
  const src = fs.readFileSync(path.join(R, "atomix-ui.js"), "utf8");
  assert.ok(src.includes('api.axOtcDeal(btn.dataset.axaccept, "accept")') && src.includes('api.axOtcDeal(btn.dataset.axreject, "reject")'), "the old panel's two calls");
  const rn = recorder(OTC_ANSWERS());
  await AX.Act.otcDeal(rn.api, ui(true), "d1", "accept"); await AX.Act.otcDeal(rn.api, ui(true), "d1", "reject"); await AX.Act.otcDeal(rn.api, ui(true), "d1", "counter", "250", "1.002");
  assert.deepEqual(rn.log, [["axOtcDeal", ["d1", "accept"]], ["axOtcDeal", ["d1", "reject"]], ["axOtcDeal", ["d1", "counter", "250", "1.002"]]]);
  const u = ui(true); await AX.Act.otcDeal({ axOtcDeal: async () => { throw new Error("deal not found"); } }, u, "d9", "accept");
  assert.deepEqual(u.said[0], ["The deal was NOT accepted: deal not found", "error"]);
});
test("OTC: terms are checked before anything is sent; a deal says whose move it is", () => {
  assert.equal(AX.termsProblem("300", "1.004", 2000), ""); assert.match(AX.termsProblem("2000.01", "1", 2000), /^Above the LP's max size \(2000\)/);
  for (const [a, p] of [["", "1"], ["5", ""], ["0", "1"], ["5", "-1"], ["1e3", "1"], ["5", "abc"]]) assert.match(AX.termsProblem(a, p, 100), /^Enter an amount and a price/, a + " @ " + p);
  assert.equal(AX.dealStatus({ status: "PROPOSED", whoseTurn: "ME" }), "Your move: accept, counter or reject"); assert.equal(AX.dealStatus({ status: "COUNTERED", whoseTurn: "THEM" }), "Waiting for the counterparty…");
  assert.equal(AX.dealStatus({ status: "EXECUTING" }), "Executing: the swap's two sides are locking");
  assert.equal(AX.dealCanAct({ status: "PROPOSED", whoseTurn: "ME" }), true); assert.equal(AX.dealCanAct({ status: "AGREED", whoseTurn: "ME" }), false); assert.equal(AX.dealCanAct({ status: "COUNTERED", whoseTurn: "THEM" }), false);
});

// ---- the Ethereum wallet, the key and the CSV (shared screens: Assets and Activity) ----
const ETH = "0xFA4E0000FA4E0000FA4E0000FA4E0000FA4E0001", TO = "0xFA4E0000FA4E0000FA4E0000FA4E0000FA4E0002", TX = "0x" + "FA4E00".repeat(10) + "0001";
const WALLET = { addr: ETH, label: "mxUSDT", currency: "mxusdt", bals: { minima: "1.2", usdt: "217.912562", eth: "0.0425", ethErr: null, meta: { confirmed: "1.2", unconfirmed: "0", sendable: "1.2", coins: 2 } } };
const SENDS = [
  { name: "ETH", asset: "eth", to: TO, amt: "0.01", review: { fee: "0.000412" } },
  { name: "USDT", asset: "usdt", to: " " + TO + " ", amt: " 25.5 ", review: { fee: "0.0011" } },
  { name: "ETH refused by the engine's check (not an address)", asset: "eth", to: "0x123", amt: "1", review: { err: "Enter a valid Ethereum address" } },
  { name: "USDT refused (more than the balance)", asset: "usdt", to: TO, amt: "9999", review: { err: "Not enough USDT" } }
];
for (const c of SENDS) for (const confirm of [true, false]) test(`wallet send ${c.name}, review ${confirm ? "accepted" : "closed"}: axSendReview then axSend with the same asset, address and amount as the old panel`, async () => {
  const answers = () => ({ axStatus: { ready: true, currency: "mxusdt", eth: ETH }, axWallet: WALLET, axSendReview: c.review, axSend: { tx: TX } });
  const ro = recorder(answers()), p = oldPanel(ro.api, confirm);
  p.P._setView("wallet"); await p.P.render(); await p.settle();
  await p.el("axSend").onclick(); if (c.asset === "usdt") p.el("axSendUsdt").onclick();
  p.el("axSendTo").value = c.to; p.el("axSendAmt").value = c.amt;
  await p.el("axSendReview").onclick(); await p.settle();
  const rn = recorder(answers()), u = ui(confirm), to = c.to.trim(), amt = c.amt.trim();   // the dialog trims both, as the old one did
  const chk = await AX.Act.sendCheck(rn.api, c.asset, to, amt);
  if (!chk.err) await AX.Act.sendGo(rn.api, u, c.asset, ETH, to, amt, chk.fee);
  assert.deepEqual(rn.money(), ro.money());
  const want = [["axSendReview", [c.asset, to, amt]]]; if (!c.review.err && confirm) want.push(["axSend", [c.asset, to, amt]]);
  assert.deepEqual(rn.money(), want);
  if (!c.review.err && confirm) assert.ok(u.said[u.said.length - 1][0].endsWith("Transaction " + TX), "the transaction hash whole");
});
test("wallet send: the review shows both addresses whole, and a send that fails says a transaction may have gone out", async () => {
  const r = AX.sendReview("usdt", ETH, TO, "25.5", "0.0011");
  assert.equal(r.title, "Review: Send USDT"); assert.ok(r.text.includes("From  " + ETH) && r.text.includes("To  " + TO) && r.text.includes("Send  25.5 USDT") && r.text.includes("≈ 0.0011 ETH"));
  const u = ui(true); await AX.Act.sendGo({ axSend: async () => { throw new Error("nonce too low"); } }, u, "eth", ETH, TO, "1", "0.0004");
  assert.match(u.said[u.said.length - 1][0], /^The send of 1 ETH was not confirmed as sent: nonce too low\. Look at this address on an Ethereum explorer before sending again/);
});
for (const confirm of [true, false]) test(`Export key, warning ${confirm ? "accepted" : "closed"}: the old warning first, axExportKey only after it`, async () => {
  const ro = recorder({ axStatus: { ready: true, currency: "mxusdt" }, axWallet: WALLET, axExportKey: "0xKEY" }), p = oldPanel(ro.api, confirm);
  p.P._setView("wallet"); await p.P.render(); await p.settle(); await p.el("axExport").onclick(); await p.settle();
  const rn = recorder({ axExportKey: "0xKEY" }), u = ui(confirm), pk = await AX.Act.exportKey(rn.api, u);
  assert.deepEqual(rn.money(), ro.money()); assert.deepEqual(rn.money(), confirm ? [["axExportKey", []]] : []);
  assert.equal(pk, confirm ? "0xKEY" : null);
  assert.equal(u.said[0][1], "Export ETH private key"); assert.equal(AX.KEY_WARN, "This key controls your ETH funds. Anyone who sees it can take them. It is derived from your Minima node seed. Never share it or type it into a website.");
});
test("the CSV is the old panel's file, byte for byte: the same column names in the same order (another tool parses them)", async () => {
  const rows = [
    { hash: PK("91"), role: "INITIATOR", direction: "MINIMA_TO_ERC20", sellToken: "0x00", sellAmount: "3050", buyToken: "USDT", buyAmount: "9.722789", counterparty: PK("D1"), status: "COMPLETE", contractId: PK("F1"), created: 1795000000000, minimaTx: PK("A1"), ethTx: TX + ";" + TX },
    { hash: PK("92"), role: "RESPONDER", direction: "ERC20_TO_MINIMA", sellToken: "USDT", sellAmount: "2.2", buyToken: AX.MXUSD, buyAmount: "2.2", counterparty: '=cmd|"x"', status: "REFUNDED", contractId: "", created: 0, minimaTx: "", ethTx: "" },
    { hash: PK("93"), role: "", direction: "ODD", sellToken: "mxUSDT", sellAmount: "0", buyToken: "USDT", buyAmount: "1", counterparty: null, status: null, contractId: "-1", created: "x", minimaTx: "+a", ethTx: "@b" }];
  let oldFile = null, newFile = null;
  const ro = recorder({ axStatus: { ready: true, currency: "mxusdt" }, axSwaps: [{ hash: PK("91"), status: "COMPLETE", role: "INITIATOR" }], axExportSwaps: rows, exportCsv: (text, name) => { oldFile = [text, name]; return "/tmp/x.csv"; } }), p = oldPanel(ro.api, true);
  p.P._setView("activity"); await p.P.render(); await p.settle(); await p.el("axExportBtn").onclick(); await p.settle();
  const rn = recorder({ axExportSwaps: rows, exportCsv: (text, name) => { newFile = [text, name]; return "/tmp/x.csv"; } });
  await AX.Act.exportCsv(rn.api, ui(true));
  assert.deepEqual(newFile, oldFile); assert.equal(newFile[1], "atomix-trades.csv");
  assert.equal(newFile[0].split("\r\n")[0], "Date,Role,Direction,Sold Amount,Sold Token,Bought Amount,Bought Token,Price (USDT/MINIMA),Counterparty,Status,Contract Id,Minima Tx,Eth Tx");
  assert.deepEqual(AX.CSV_COLS.length, 13);
  const none = recorder({ axExportSwaps: [] }), u = ui(true); await AX.Act.exportCsv(none.api, u);
  assert.deepEqual(none.log.map((x) => x[0]), ["axExportSwaps"], "no file is asked for when there is nothing to write");
});

// ---- halted, and market offline ----
/** The engine's own identity watch (main/atomix/lib/identitywatch.js, verbatim) with a stand-in node. */
function watchWith(keyReads, ethReads) {
  const g = { AX: { htlc: { normKey: (k) => String(k).toLowerCase(), loadKeys: (cb) => { const r = keyReads.shift(); if (!r) return cb(new Error("no read")); const keys = r.keys.map((k) => k.toLowerCase()); keys.complete = r.complete; keys.total = r.keys.length; cb(null, keys); } },
    mds: { cmdR: (_c, cb) => { const a = ethReads.shift(); cb(a ? null : new Error("busy"), a ? { seedrandom: a } : null); } }, eth: { addressFromPriv: (p) => "0xaddr-of-" + p.replace(/^0x/, "") }, ethops: {} }, console };
  g.globalThis = g; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "identitywatch.js"), "utf8"), g);
  return g.AX.identitywatch;
}
const check = (w, ctx) => new Promise((res) => { w.forceNext(); w.check(ctx, res); });
test("halt: the glue reports the engine's verdict whole, only after two complete reads agree; one short read halts nothing", async () => {
  const { _haltFrom } = require("../main/atomix"), MINE = PK("A1"), ctx = { htlc: { publickey: MINE }, eth: { address: "0xaddr-of-old" } };
  let w = watchWith([{ keys: [MINE, PK("A2")], complete: true }], ["0xold"]); await check(w, ctx);
  assert.equal(_haltFrom(w), null, "a healthy install");
  w = watchWith([{ keys: [PK("A2")], complete: false }], ["0xold"]); await check(w, ctx);
  assert.equal(_haltFrom(w), null, "an incomplete key list proves nothing");
  w = watchWith([{ keys: [PK("A2")], complete: true }, { keys: [MINE], complete: true }], ["0xold"]); await check(w, ctx);
  assert.equal(_haltFrom(w), null, "the second read owned the key: no halt on a single read");
  w = watchWith([{ keys: [PK("A2")], complete: true }, { keys: [PK("A2")], complete: true }], ["0xnew", "0xnew"]); await check(w, ctx);
  assert.deepEqual(_haltFrom(w), { summary: "Your Minima key AND your ETH wallet no longer match this node.", minimaMismatch: true, ethMismatch: true, orphanedPk: MINE, staleEth: "0xaddr-of-old", nodeEth: "0xaddr-of-new" });
  w = watchWith([{ keys: [MINE], complete: true }], ["0xnew", "0xother"]); await check(w, ctx);
  assert.equal(_haltFrom(w), null, "two derivations that disagree with each other halt nothing");
  assert.equal(_haltFrom(null), null); assert.equal(_haltFrom({ halted() { throw new Error("x"); } }), null);
});
// 0.18.132 (M3, M4, M5): what the screens say about a hidden swap, a halt and a stopped node is true
const SW = (o) => Object.assign({ hash: PK("51"), role: "INITIATOR", direction: "MINIMA_TO_ERC20", selltoken: "mxUSDT", sellamount: "50", buytoken: "USDT", buyamount: "49.5", status: "STARTED", created: 1, timelock: 2417900, legIsMinima: true }, o);
test("M3: a hidden swap is always reachable: History lists every finished swap and every hidden one, with Unhide", () => {
  const live = SW({ hash: PK("51") }), hiddenLive = SW({ hash: PK("52"), created: 2 }), done = SW({ hash: PK("53"), status: "COMPLETE", created: 3 });
  const list = AX.historyList([live, hiddenLive, done], new Set([PK("52")]));
  assert.deepEqual(list.map((x) => x.hash), [PK("52"), PK("53")], "the hidden swap in flight first, then the finished one; a visible swap in flight stays in Activity");
  assert.match(AX.HIDE_ASK(false), /It stays in History, with Check now, Refund now and Unhide\.$/); assert.match(AX.HIDE_ASK(true), /Check now and Unhide/);
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.match(src, /historyList\(swaps, S\.hidden\)[^\n]*swapCard\(x, false, S\.hidden\.has\(x\.hash\)\)/, "History draws them with the Unhide button");
  assert.match(src, /data-axunhide="\$\{esc\(it\.hash\)\}"/); assert.match(src, /if \(ds\.axunhide\) \{ S\.hidden\.delete\(ds\.axunhide\)/);
});
test("M4: the halt card is written from the facts: which key, what still settles, which swaps cannot and their deadlines, and no instruction without a tool", () => {
  const takerSell = SW({}), takerBuy = SW({ hash: PK("54"), direction: "ERC20_TO_MINIMA", selltoken: "USDT", sellamount: "101", buytoken: "mxUSDT", buyamount: "100", timelock: 1795000000, legIsMinima: false });
  const makerBuys = SW({ hash: PK("55"), role: "RESPONDER", selltoken: "USDT", sellamount: "20", buytoken: "mxUSDT", buyamount: "20", timelock: 1795003600, legIsMinima: false }), done = SW({ hash: PK("56"), status: "REFUNDED" });
  const m = AX.haltCard({ minimaMismatch: true, ethMismatch: false, orphanedPk: PK("A1") }, [takerSell, takerBuy, makerBuys, done]);
  assert.equal(m.title, "⛔  Wallet mismatch: AtomiX is halted"); assert.match(m.which, /^The Minima key AtomiX saved is not one this node owns\. The Ethereum wallet still matches\.$/);
  assert.ok(!/keep settling: that part is safe/.test(JSON.stringify(m)), "the false reassurance is gone");
  assert.match(m.settles, /Does NOT settle until this node owns the key again: any Minima-side step under the orphaned key/);
  assert.equal(m.count, "3 unfinished swaps:"); assert.deepEqual(m.stuck.map((x) => x.hash), [PK("51"), PK("54"), PK("55")], "every hash whole, the finished swap left out");
  assert.match(m.stuck[0].text, /^Your 50 MxUSD lock CANNOT be refunded under the orphaned key\..* Your lock's deadline: block 2417900\.$/);
  assert.match(m.stuck[1].text, /^The 100 MxUSD locked to you CANNOT be claimed by this node\. Your USDT is refunded on Ethereum at its deadline, by itself\. Your lock's deadline: 2026-11-18 \d\d:\d\d:\d\d UTC\.$/);
  assert.match(m.stuck[2].text, /^The taker's 20 MxUSD CANNOT be claimed by this node\. If the taker claims your USDT, that MxUSD is forfeited at the taker's timelock\./);
  assert.deepEqual(m.tools, [["axgo", "activity", "Open Activity"]], "a Minima-only halt has a tool, and it is the one the text names");
  assert.ok(!/Rescue what you need FIRST/.test(JSON.stringify(m))); assert.match(m.todo.join(" "), /Follow each swap listed here in Activity \(Check now, Refund now\)\. Ask for help before you restore or reset anything/);
  assert.equal(m.details, "Minima identity: ORPHANED\n  in use    " + PK("A1") + "\n  your node does not own it");
  const e = AX.haltCard({ minimaMismatch: false, ethMismatch: true, staleEth: ETH, nodeEth: TO }, [takerBuy]);
  assert.match(e.settles, /^Still settles: every Minima-side step, by itself\. The Ethereum side of each swap settles only while this app keeps running/);
  assert.equal(e.todo[0], "Do NOT quit or restart the app."); assert.deepEqual(e.tools.map((t) => t[1]), ["key", "sweep", "activity"]);
  assert.equal(e.details, "ETH wallet: STALE\n  in use    " + ETH + "\n  node now  " + TO);
  const b = AX.haltCard({ minimaMismatch: true, ethMismatch: true, orphanedPk: PK("A1"), staleEth: ETH, nodeEth: TO }, []);
  assert.match(b.which, /^Both /); assert.equal(b.count, "No unfinished swap."); assert.deepEqual(b.tools.map((t) => t[1]), ["key", "sweep"]);
  assert.equal(AX.haltCard({ minimaMismatch: true }, null).count, "Your swaps have not been read yet.");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.ok(!/axInvalidate/.test(src), "the screens never reset the AtomiX store");
  assert.match(src, /if \(halted\(\)\) return say\("Halted: this node no longer owns the keys AtomiX uses here\. Nothing was sent\./, "no take while halted");
  assert.ok(!/halted\(\)[^\n]*ax(refund|check)/.test(src), "Refund now and Check now are never gated: settlement is not frozen");
  // the deadline comes from the engine's own row
  const row = require("../main/atomix")._projectRow({ inspect: { statusDetail: () => "" }, settle: { visibility: () => null } }, { hash: PK("51"), status: "STARTED", myTimelock: 2417900, myLegIsMinima: true }, [], 0, 0);
  assert.equal(row.timelock, 2417900); assert.equal(row.legIsMinima, true);
});
test("M5: a stopped node: the unfinished swaps are counted from the list and the user is told to start the node now, with the nearest deadline", () => {
  assert.equal(AX.offline(true, true, []), ""); assert.equal(AX.offline(false, false, []), "");
  const a = SW({}), b = SW({ hash: PK("57"), timelock: 2417800 }), c = SW({ hash: PK("58"), timelock: 1795000000, legIsMinima: false }), done = SW({ hash: PK("59"), status: "COMPLETE", timelock: 5 });
  const t = AX.offline(false, true, [a, b, c, done]);
  assert.match(t, /^Market offline: your Minima node isn't running.* You were not filled by this\. 3 swaps are not finished\..* LOSES that claim if the node stays off past its deadline\. Start the node now\. Nearest deadline of your own locks: block 2417800 \(Minima\) and 2026-11-18 \d\d:\d\d:\d\d UTC \(Ethereum\)\./);
  assert.ok(!/are refunded at their deadline once the node runs/.test(t), "the false promise is gone");
  assert.match(AX.offline(false, true, []), /None of your swaps is unfinished\./); assert.match(AX.offline(false, true, null), /have not been read yet: if one is not finished, start the node now/);
  assert.match(AX.stoppedNote([SW({ status: "ERROR" })]), /^1 swap is not finished/, "a swap in ERROR may still hold a lock");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.match(src, /if \(!D\.running\(\)\) \{ const sw = await api\(\)\.axSwaps\(\)/, "the list is read from the engine's store with the node off");
  assert.match(src, /offline\(D\.running\(\), pref\("dexicon_ax_market_live"\) === "1", S\.swaps\)/);
});

// 0.18.118 (H2): the room's money actions that had no in-flight state of their own
test("Refund now and the wallet actions run one at a time: a second click while one runs does nothing", async () => {
  const one = AX.oneAtATime(); let runs = 0, release;
  const first = one(() => new Promise(r => { runs++; release = r; }));
  await one(async () => { runs++; }); await one(async () => { runs++; });
  assert.equal(runs, 1, "the double click started nothing");
  release(); await first;
  await one(async () => { runs++; }); assert.equal(runs, 2, "free again afterwards");
  await assert.rejects(one(async () => { throw new Error("x"); })); await one(async () => { runs++; }); assert.equal(runs, 3, "also after a failure");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.match(src, /if \(ds\.axrefund\) return one\(/); assert.match(src, /if \(ds\.axw\) return one\(/);
});

// ---- 0.18.130 (H1): the halt is enforced by the glue and at the engine's own leg-1 lock, not by the screen ----
/** A stand-in engine for the glue: `halted` is read live; every other thing the glue touches is recorded. */
function fakeEngine(o = {}) {
  const st = { halted: !!o.halted, touched: [] }, t = (n, v) => (...a) => { st.touched.push(n); return typeof v === "function" ? v(...a) : v; };
  const cbOk = (n, val) => t(n, (...a) => a[a.length - 1](null, val));
  const AXE = { identitywatch: { halted: () => st.halted },
    book: { scan: cbOk("book.scan", {}), makerLive: () => true }, boot: { activeIdentity: () => ({ publicId: () => "me" }) },
    engine: { startLeg: t("engine.startLeg", (maker, sym, sell, minima, usdt, hooks, cb) => { if (o.onLeg) o.onLeg(st); cb(null, "0xhash" + st.touched.length); }), confirmMyLock: (h, leg, cb) => cb(true) },
    maker: { saveConfig: t("maker.saveConfig", (c, m, cb) => cb()), refreshPeg: t("maker.refreshPeg", (cb) => cb()), publish: t("maker.publish", (av, cb) => cb()), tombstone: t("maker.tombstone", (av, cb) => cb()) },
    otc: { setMyOffer: t("otc.setMyOffer"), publishOffer: t("otc.publishOffer", (cb) => cb()), propose: t("otc.propose", (...a) => a[a.length - 1]()), getDeal: (ref, cb) => cb(null, { ref }),
      accept: t("otc.accept", (d, cb) => cb()), counter: t("otc.counter", (d, a, p, cb) => cb()), reject: t("otc.reject", (d, cb) => cb()) },
    settle: { refundNow: t("settle.refundNow", (h, cb) => cb("asked", true)) } };
  return { st, ctx: { READY: true, AX: AXE, CTX: {} } };
}
test("H1: while halted the glue refuses every action that creates a new liability, reading the engine's verdict at the call; settlement, withdrawals and a reject are never refused", async () => {
  const atomix = require("../main/atomix"), F = fakeEngine({ halted: true }), LP = { cid: "c", mpk: PK("B1"), eth: ETH };
  atomix._setCtx(F.ctx);
  try {
    atomix._lastQuotes().q1 = { model: { mode: "single", sell: true, minima: "1", usdt: "1", maker: PK("D1") }, book: { [PK("D1")]: {} }, at: Date.now() };
    for (const [name, call] of [["swapExecute", () => atomix.swapExecute("q1")], ["makerSave", () => atomix.makerSave({}, {})], ["makerPublish", () => atomix.makerPublish()],
      ["otcGoLive", () => atomix.otcGoLive(1, 1)], ["otcPropose", () => atomix.otcPropose(LP, "SELL", "1", "1")], ["otc accept", () => atomix.otcDealAction("r", "accept")], ["otc counter", () => atomix.otcDealAction("r", "counter", "1", "1")]])
      await assert.rejects(call(), { message: atomix.HALTED }, name + " is refused while halted");
    assert.deepEqual(F.st.touched, [], "and nothing of the engine was touched: no quote consumed, no config saved, no offer armed");
    assert.ok(atomix._lastQuotes().q1, "the frozen quote is not consumed by a refusal");
    assert.match(atomix.HALTED, /^AtomiX is halted: .* Nothing was sent, published or locked\.$/);
    // never gated (owner rule: a halt never freezes settlement)
    assert.deepEqual(await atomix.refundNow("0x" + "ab".repeat(32)), { msg: "asked", opened: true });
    assert.deepEqual(await atomix.otcDealAction("r", "reject"), { ok: true });
    await atomix.otcWithdraw();
    assert.deepEqual(F.st.touched, ["settle.refundNow", "otc.reject", "otc.setMyOffer", "otc.publishOffer"]);
    // the verdict is live: the moment the engine says it is no longer halted, the same call goes through
    F.st.halted = false; F.st.touched.length = 0;
    assert.deepEqual(await atomix.swapExecute("q1"), { ok: 1, of: 1, hashes: ["0xhash2"] });
    // a halt raised between two parts of a sweep stops the next part
    const G = fakeEngine({ onLeg: (st) => { st.halted = true; } }); atomix._setCtx(G.ctx);
    const leg = (n) => ({ maker: { signerPk: PK("D" + n) }, minima: "1", usdt: "1" });
    atomix._lastQuotes().q2 = { model: { mode: "sweep", sell: true, plan: { legs: [leg(1), leg(2)] } }, book: { [PK("D1")]: {}, [PK("D2")]: {} }, at: Date.now() };
    const r = await atomix.swapExecute("q2");
    assert.equal(r.ok, 1); assert.equal(r.of, 2); assert.match(r.stopped, /Sweep stopped at part 2: AtomiX is halted/);
    assert.equal(G.st.touched.filter((x) => x === "engine.startLeg").length, 1, "part 2 never reached the engine");
  } finally { atomix._setCtx(null); }
});
test("H1: an LP's ACCEPT arriving in the service poll locks nothing while halted: the engine's own executeDeal is refused at its leg-1 lock, and (0.18.139) the deal is ENDED, so a cleared halt cannot run it at its old price", async () => {
  const atomix = require("../main/atomix"), { createContext } = require("../main/atomix/loader"), { makeSqlShim } = require("../main/pandapools/sqlshim");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-halt-")), seen = [], notes = [];
  try {
    const shim = await makeSqlShim(path.join(dir, "atomix.sqlite"));
    const mds = { minidappuid: "", cmd: (c, cb) => { seen.push(String(c)); cb(/^random /.test(c) ? { status: true, response: { random: "0x" + "AB".repeat(12) } } : { status: false, error: "mock node: nothing may be sent in this test" }); }, sql: (q, cb) => shim.sql(q, cb),
      net: { GET() { throw new Error("TEST LEAK: network"); }, POST() { throw new Error("TEST LEAK: network"); } }, notify: (m) => notes.push(String(m)), log() {}, init() {} };
    const run = async (gated) => {
      const c = createContext(mds), A = c.AX; if (gated) atomix._gateEngine(c);
      // service.js wires the execute exactly so (asserted below); the engine is configured as after a boot
      A.engine.configure({ rpc: {}, ethPriv: "0x01", ethAddr: ETH, myMinimaPk: PK("A1") });
      A.otc.configure({ identity: { publicId: () => "me" }, myMinimaPk: PK("A1"), ethAddr: ETH, notify: (t, b) => notes.push(t + ": " + b), onExecute: (deal, cb) => A.engine.executeOtc(deal, cb) });
      A.otc._setExecToken("tok" + gated); A.identitywatch._setMismatch(true, false);
      const P = (fn) => new Promise((res) => fn((e, v) => res(v)));
      await P((cb) => A.otc.initDb(cb));
      const ref = "ref" + gated;
      await P((cb) => A.otc.upsertDeal({ ref, role: "INSTIGATOR", peerCommsId: "lp", peerMinimaPk: PK("B1"), peerEthAddr: TO, side: "BUY", amount: "10", price: "1", status: "AGREED", whoseTurn: "ME", currency: "mxusdt" }, cb));
      seen.length = 0; notes.length = 0;
      await new Promise((res) => A.otc.executeDeal({ ref, role: "INSTIGATOR" }, res));
      await new Promise((r) => setTimeout(r, 50));
      const first = { deal: await P((cb) => A.otc.getDeal(ref, cb)), seen: seen.slice(), notes: notes.slice() };
      // the halt clears, and the engine's own 10-minute retry comes round (lib/otc.js expireStale: AGREED + INSTIGATOR → executeDeal)
      A.identitywatch._setMismatch(false, false); seen.length = 0;
      await new Promise((res) => A.otc.expireStale(Date.now() + 11 * 60000, null, res)); await new Promise((r) => setTimeout(r, 50));
      return Object.assign(first, { later: seen.slice(), dealLater: await P((cb) => A.otc.getDeal(ref, cb)), msgs: await P((cb) => A.otc.msgs(ref, cb)) });
    };
    const open = await run(0);
    assert.ok(open.seen.length > 0, "without the gate the engine starts the lock while halted (the finding): " + open.seen.join(" | "));
    const shut = await run(1);
    // without the gate (the 0.18.129 state) the lock is started while halted; nothing more is asserted of it
    assert.equal(shut.seen.filter((x) => !/^(random|send amount:0\.000000001 )/.test(x)).length, 0, "with the gate no lock reaches the node, only the REJECT message to the counterparty: " + shut.seen.join(" | "));
    assert.deepEqual(shut.msgs.map((m) => m.type), ["REJECT"], "the engine's own reject path made the REJECT message for the counterparty (this test's stand-in identity cannot seal it, so nothing is sent here)");
    assert.equal(shut.deal.status, "REJECTED", "ended for good through the engine's own reject, not left AGREED to be retried every 10 minutes"); assert.equal(shut.deal.hash, "", "the deal is not left half-recorded");
    assert.ok(shut.notes.some((n) => /^OTC execute failed: AtomiX is halted.*The agreed OTC deal was ended, so it cannot run later at its old price\.$/.test(n)), shut.notes.join(" | "));
    assert.deepEqual(shut.later, [], "the halt cleared and the retry came round: nothing is executed, at the old price or any other"); assert.equal(shut.dealLater.status, "REJECTED");
    shim.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const glue = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8"), svc = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "service.js"), "utf8");
  assert.match(glue, /ctx = createContext\(buildMds\(\)\);\n    gateEngine\(ctx\);/, "every engine the glue builds is gated before it is started");
  assert.match(svc, /onExecute: function \(deal, cb\) \{ AX\.engine\.executeOtc\(deal, cb\); \}/, "the engine looks executeOtc up at call time: the gate depends on it");
});
test("H1: a halt redraws the screens at once: the engine's notice raises an update, not only a notification", () => {
  const atomix = require("../main/atomix"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-note-")); let n = 0; const on = () => n++;
  atomix._setDataDir(dir); atomix.emitter.on("update", on);
  try { atomix._buildMds().notify("AtomiX halted — wallet mismatch. Rescue funds and reinstall."); assert.equal(n, 1); }
  finally { atomix.emitter.off("update", on); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 0.18.131 (M2): "Nothing was locked" only for a refusal known to come before any lock ----
test("M2: only a known pre-lock refusal says nothing was locked; every other outcome says no lock was confirmed, with the real reasons, and never that nothing was spent", async () => {
  const atomix = require("../main/atomix"), UNSURE = /No lock was confirmed\. Look at In progress before trying again\.$/;
  // the glue's and the engine's own refusals, as they arrive over IPC
  const engine = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "engine.js"), "utf8"), glue = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8");
  for (const known of ["That quote has expired — review the swap again.", "maker vanished from the reviewed book", "that market was just withdrawn — refreshing the book, try again in a moment", "Not ready", "AtomiX engine not booted yet"]) {
    assert.ok(engine.includes(known) || glue.includes(known), "still the source's words: " + known);
    assert.match(AX.takeResult({ err: "Error invoking remote method 'mcd:axSwap': Error: " + known }).text, /Nothing was locked\.$/, known);
  }
  assert.match(AX.takeResult({ err: atomix.HALTED }).text, /Nothing was locked\.$/);
  assert.match(AX.takeResult({ err: "AtomiX is stopped while the wallet is being replaced. It starts again by itself." }).text, /Nothing was locked\.$/);
  // not known: a send that timed out may still post; a broadcast may have gone out
  for (const unsure of ["cmd failed: send amount:5 … — timed out after 180000ms", "eth_sendRawTransaction failed on all rpcs", "book scan timed out"]) {
    const t = AX.takeResult({ err: unsure }).text; assert.match(t, UNSURE, unsure); assert.ok(!/Nothing was locked/.test(t));
  }
  // a buy sweep: the reasons the glue now carries, and no claim that nothing was spent
  const F = fakeEngine(); let n = 0;
  F.ctx.AX.engine.startLeg = (maker, sym, sell, minima, usdt, hooks, cb) => (++n === 1 ? cb(new Error("Approving USDT spend — try the buy again in ~30s")) : cb(new Error("eth_sendRawTransaction failed on all rpcs")));
  atomix._setCtx(F.ctx);
  try {
    const leg = (k) => ({ maker: { signerPk: PK("D" + k) }, minima: "1", usdt: "1" });
    atomix._lastQuotes().q3 = { model: { mode: "sweep", sell: false, plan: { legs: [leg(1), leg(2)] } }, book: { [PK("D1")]: {}, [PK("D2")]: {} }, at: Date.now() };
    const r = await atomix.swapExecute("q3");
    assert.deepEqual(r, { ok: 0, of: 2, hashes: [], reasons: ["part 1: Approving USDT spend — try the buy again in ~30s", "part 2: eth_sendRawTransaction failed on all rpcs"] });
    const t = AX.takeResult(r).text;
    assert.match(t, /^0 of 2 parts locked\. part 1: Approving USDT spend .*\. part 2: eth_sendRawTransaction failed on all rpcs\. An approval of USDT was sent to Ethereum and costs gas\. No lock was confirmed/);
  } finally { atomix._setCtx(null); }
  assert.match(AX.takeResult({ ok: 0, of: 2, hashes: [], reasons: ["part 1: that market was just withdrawn — refreshing the book, try again in a moment", "part 2: maker vanished from the reviewed book"] }).text, /Nothing was locked\.$/);
  assert.match(AX.takeResult({ ok: 0, of: 2, hashes: [], stopped: "Sweep stopped at part 1: cmd failed: send — timed out" }).text, UNSURE);
  assert.match(AX.takeResult({ ok: 1, of: 2, hashes: [], reasons: ["part 2: socket hang up"] }).text, /^1 of 2 parts locked\. part 2: socket hang up\. Nothing is swapped yet.* For the rest: No lock was confirmed/);
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.ok(!/nothing was spent/i.test(src), "the screens never claim nothing was spent");
});

// ---- 0.18.133 (M6 and the lows) ----
test("M6: an OTC LP's button names the LP by its id and its sizes; a row that moved, changed or left sends nothing", () => {
  const A = { cid: "lp-A", mpk: PK("B1"), eth: ETH, sell: 500, buy: 0 }, B = { cid: "lp-B", mpk: PK("B2"), eth: TO, sell: 900, buy: 100 };
  // drawn as [A, B]; the engine replaced the list with [B, A] while a field had the focus: the button of row 0 is still A's
  assert.equal(AX.lpPick([B, A], "lp-A", "500", "0"), A, "found by id, wherever it now is (an index would have named B)");
  assert.equal(AX.lpPick([B], "lp-A", "500", "0"), null, "the LP left: nothing");
  assert.equal(AX.lpPick([{ ...A, sell: 50 }], "lp-A", "500", "0"), null, "the same LP with other sizes: nothing");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.ok(!/data-axlp="\$\{i\}"/.test(src) && !/o\.board\[Number\(ds\.axlp\)\]/.test(src), "no row is named by its position");
  assert.match(src, /data-axlp="\$\{esc\(lp\.cid\)\}" data-sell="\$\{esc\(lp\.sell\)\}" data-buy="\$\{esc\(lp\.buy\)\}" data-side="SELL"/);
  assert.equal((src.match(/lpPick\(/g) || []).length, 2, "checked at the click and again after the terms dialog");
});
test("lows: an OTC withdrawal while halted says nothing was posted; a failed save says the order is saved and will be published again; a refusal says nothing was saved", async () => {
  const u = ui(true); await AX.Act.otcWithdraw({ axOtcWithdraw: async () => ({ ok: true, posted: false }) }, u);
  assert.match(u.said[0][0], /^Your availability is switched off in this app\. Nothing was posted to the board, because AtomiX is halted/); assert.equal(u.said[0][1], "error");
  const v = ui(true); await AX.Act.otcWithdraw({ axOtcWithdraw: async () => ({ ok: true, posted: true }) }, v); assert.match(v.said[0][0], /^Availability withdrawn\./);
  const atomix = require("../main/atomix"), F = fakeEngine({ halted: true }); atomix._setCtx(F.ctx);
  try { assert.deepEqual(await atomix.otcWithdraw(), { ok: true, posted: false }); F.st.halted = false; assert.deepEqual(await atomix.otcWithdraw(), { ok: true, posted: true }); } finally { atomix._setCtx(null); }
  const w = ui(true); await AX.Act.makerSave({ axMakerSave: async () => { throw new Error(atomix.HALTED); } }, w, { cfg: {}, manual: {} });
  assert.match(w.said[0][0], /^Your order was NOT saved and NOT published: AtomiX is halted/);
});
test("lows: a swap in ERROR whose window is open is not finished: it stays In progress with Refund now, and the banners count it", () => {
  const open = SW({ status: "ERROR", inWindow: true, vis: { blocks: true, cur: 10, refundAt: 5, respondBy: 3, canRefund: true, refundOpen: true, steps: [] } }), shut = SW({ status: "ERROR", inWindow: false });
  assert.equal(AX.terminal(open), false); assert.equal(AX.terminal(shut), true);
  const it = AX.swapItem(open); assert.equal(it.terminal, false); assert.deepEqual(it.refund, { label: "Refund now", enabled: true });
  assert.ok(it.lines.some((l) => /^Stopped with an error\. If a lock was made it can still be refunded/.test(l)));
  const st = AX.stages(true, "MxUSD", true, { minima: "1" }, [open], Date.now());
  assert.equal(st.check, open.hash, "Check now is offered for it"); assert.ok(st.rows.some((r) => /^Stopped with an error: see it under In progress/.test(r.text)));
  assert.ok(!/see the swap below/.test(fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8")));
  assert.equal(AX.launch("minima", [open], false, false).idle, false, "MINIMA mode is not called idle over it");
  assert.match(AX.launch("minima", [], false, null).text, /OTC was not checked: look at the OTC tab/, "what was not read is not asserted");
  assert.equal(AX.launch("minima", [], false, true).idle, false, "a live OTC availability keeps the room in MINIMA mode");
  const A = { inspect: { statusDetail: () => "" }, settle: { visibility: () => null }, trading: { withinWindow: (s, tip, now) => tip < s.myTimelock } };
  assert.equal(require("../main/atomix")._projectRow(A, { status: "ERROR", myTimelock: 100 }, [], 0, 50).inWindow, true);
  assert.equal(require("../main/atomix")._projectRow(A, { status: "ERROR", myTimelock: 100 }, [], 0, 150).inWindow, false);
});
test("lows: a rung's size is the number as typed: not six significant figures, not an exponent (the old panel's fmtPx(size) did both; parity ends here on purpose)", () => {
  assert.equal(AX.rungSize("1234567.89"), "1234567.89"); assert.equal(AX.fmtPx(1234567.89), "1.23457e+6", "what the old editor wrote");
  assert.equal(AX.rungSize("0.000000123"), "0.000000123"); assert.equal(AX.rungSize("250"), "250"); assert.equal(AX.rungSize("abc"), ""); assert.equal(AX.rungSize("0"), "");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.ok(!/fmtPx\(size\)/.test(src), "no size passes through the price format");
});
test("lows: no private busy gate: the label is set and cleared in one place (try/finally) and closing the editor does not clear it; a switch clears OTC and the offline flag", () => {
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8");
  assert.ok(!/if \(S\.busy\) return/.test(src), "DexCore.money is the gate");
  assert.equal((src.match(/S\.busy = /g) || []).length, 2, "only busyWhile writes it");
  assert.match(src, /const busyWhile = async \(label, fn\) => \{ S\.busy = label; try \{ return await fn\(\); \} finally \{ S\.busy = false; \} \};/);
  assert.match(src, /if \(r && !r\.err\) \{ S\.otc = null; S\.otcDraft = null; pref\("dexicon_ax_market_live", "0"\); \}/);
});

// ---- 0.18.134: Market and OTC beside the wide (Fold) captures of 19 Nov ----
test("wide layout: the phone's own words and order on Market and OTC (its long dashes kept), the explainers open until folded, keys at the outer edges", () => {
  assert.equal(AX.midLine("Parity", 1, 1000, 17000), "Parity mid 1  (bid 1 / ask 1)  ·  16s ago");
  assert.equal(AX.midLine("MEXC", 0.004321, 0, 5), "MEXC mid 0.004321", "no bid or ask is invented for MEXC, and no age without a stamp");
  assert.equal(AX.offerState({ cfg: {}, manual: { bids: [], asks: [] }, state: {} }, { bids: [], asks: [] }, "Parity").text, "Off — edit your order, then Publish.");
  const src = fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8"), css = fs.readFileSync(path.join(R, "dexicon.css"), "utf8");
  assert.match(src, /order book\. Tap a level to take it, use the Swap page, or publish your own offer\./);
  assert.match(src, /why\("otc", "OTC — A PRIVATE DEAL", WHY_OTC\)/); assert.match(src, /why\("market", "YOUR AtomiX MARKET", WHY_MARKET\)/);
  assert.match(src, /return v === "1" \|\| \(v == null && key !== "swap"\);/, "Market's and OTC's explainers are open until folded");
  const order = ["YOUR AtomiX MARKET", "The live USDT ⇄", "midLine(src()", "YOUR OFFER · USDT ⇄", "Order book  ·  ", "data-axrefresh", "ax-spread", "ax-legend", "data-axmk=\"edit\"", "data-axmk=\"publish\"", "data-axmk=\"withdraw\""].map((t) => src.indexOf(t, src.indexOf("function marketHtml")));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), "Market in the phone's order"); assert.ok(order.every((i) => i > 0));
  const otc = ["OTC — A PRIVATE DEAL", "MY AVAILABILITY", "I SELL up to", "I BUY up to", "○ Off", "Go live", "LIQUIDITY PROVIDERS", "MY DEALS"].map((t) => src.indexOf(t, src.indexOf("function otcHtml")));
  assert.deepEqual(otc, otc.slice().sort((a, b) => a - b), "OTC in the phone's order"); assert.ok(otc.every((i) => i > 0));
  assert.match(src, /placeholder="max \$\{esc\(c\)\} \(blank = off\)"/);
  assert.match(css, /\.ax-half--bid \.ax-tag \{ align-self: flex-start; text-align: left; \} \.ax-half:not\(\.ax-half--bid\) \.ax-tag \{ align-self: flex-end; text-align: right; \}/);
  assert.match(css, /\.ax-in--line \{[^}]*border-width: 0 0 1px;/);
});
