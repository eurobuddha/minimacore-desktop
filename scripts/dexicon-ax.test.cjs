// Dexicon room ① MxUSD (Phase 3c): AtomiX's screens were replaced, its behaviour was not. Each money action is run
// twice here, once through the panel it replaces (renderer/atomix-ui.js, executed on a stand-in page) and once
// through the new screens' action (renderer/dexicon-ax.js Act), against the same recording window.mcd; the calls,
// their arguments and their order must be identical, and a refused confirm must stop both before the same call.
// Nothing here reaches a node, Ethereum or the network: any call that is not a recorded stand-in throws.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), vm = require("vm");
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
  assert.match(AX.takeResult({ ok: 0, of: 1, hashes: [] }).text, /Nothing was locked and nothing was spent/);
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
  assert.match(AX.HIDE_ASK(false), /hiding doesn't touch them.*Check now and Refund now/);
});
test("the launch rule: MxUSD mode says nothing; MINIMA mode stays, with the reason, while something of the user's is live there", () => {
  assert.equal(AX.launch("mxusdt", [], false, false), null);
  assert.equal(AX.launch("minima", null, null, false), null, "not read yet: nothing is claimed");
  assert.match(AX.launch("minima", [{ status: "LOCKED" }], false, false).text, /^Opened in MINIMA mode: a USDT ⇄ MINIMA swap or OTC deal is in flight\. Dexicon never switches a live market by itself/);
  assert.match(AX.launch("minima", [{ status: "COMPLETE" }], true, false).text, /your MINIMA market is live\./);
  assert.match(AX.launch("minima", [{ status: "STARTED" }], true, false).text, /is in flight and your MINIMA market is live/);
  const idle = AX.launch("minima", [{ status: "REFUNDED" }], false, false);
  assert.equal(idle.idle, true); assert.match(idle.text, /Nothing of yours is live there\. Use the ⇄ pill/);
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
  for (const [act, args, re] of [["makerPublish", [], /^Your market was NOT published: publish timed out\. What was on the book before is unchanged\.$/], ["makerWithdraw", [], /^Your market was NOT withdrawn: .* It may still be on the book\.$/],
    ["makerSave", [{ cfg: {}, manual: {} }], /^Your order was NOT published: /], ["makerSave", [{ withdraw: true }], /^Your market was NOT withdrawn: /]]) {
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
  assert.match(AX.offerState({ cfg: {}, manual: { bids: [], asks: [] }, state: {} }, { bids: [], asks: [] }, "MEXC").text, /^Off: edit your order, then Publish\.$/);
  assert.equal(AX.offerState(null, null, "MEXC").text, "…");
});
test("the 'buys declined' warning uses the engine's own read limits", () => {
  const htlc = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "htlc.js"), "utf8");
  assert.ok(htlc.includes(`=== '0x00' ? ${AX.COIN_CAP.minima} : ${AX.COIN_CAP.mxusdt};`), "COIN_CAP equals guardedCoins' cap");
  assert.equal(AX.coinWarn("mxusdt", 53), ""); assert.equal(AX.coinWarn("mxusdt", 54), "54 MxUSD coins: AtomiX buys are being declined. Consolidate.");
  assert.equal(AX.coinWarn("minima", 200), ""); assert.match(AX.coinWarn("minima", 201), /^201 MINIMA coins/); assert.equal(AX.coinWarn("mxusdt", undefined), "");
});
