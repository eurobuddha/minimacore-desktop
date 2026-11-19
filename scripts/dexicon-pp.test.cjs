// Dexicon room ② Pools (Phase 3d): PandaPools' screens were replaced, its behaviour was not. Each money action is run
// twice here, once through the panel it replaces (renderer/pools.js, executed on a stand-in page) and once through the
// new screens' action (renderer/dexicon-pp.js Act), against the same recording window.mcd; the calls, their arguments
// and their order must be identical, and a refused confirm must stop both before the same call.
// Nothing here reaches a node or the network: any call that is not a recorded stand-in throws.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const ROOT = path.join(__dirname, ".."), R = path.join(ROOT, "renderer");
const PP = require("../renderer/dexicon-pp.js"), C = require("../renderer/dexicon-core.js");
const src = (f) => fs.readFileSync(path.join(R, f), "utf8");

const PK = (n) => "0x" + (n + "FA4E".repeat(16)).slice(0, 64);
const MXUSD = PP.MXUSD;
const POOL = { address: PK("B1"), opk: PK("0B"), oadr: PK("0A"), tok: MXUSD, tokName: "USDT", tokDecimals: 8, reserveM: "40000", reserveT: "128.4", spot: "0.00321", feeGrowthPct: "0.07" };
const T = { tok: MXUSD, name: "MxUSD" };
const BAL = [{ tokenid: "0x00", sendable: "5000", token: "Minima" }, { tokenid: MXUSD, sendable: "300.5", token: { name: { name: "MxUSD" }, decimals: 8 } }];
const QUOTE = { ok: true, totalIn: "250", totalOut: "0.79832711", effPrice: "0.0031933084", priceImpact: "0.27", poolsUsed: 2, poolsAvailable: 3, capped: false, maxPools: 6, quoteId: 41 };

/** window.mcd as a recorder: every call is logged with its arguments; `answers` gives what each returns (a function
 *  is called; an Error is thrown). A call with no answer throws, so nothing unplanned (and nothing real) is reached. */
function recorder(answers) {
  const log = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => {
    log.push([name, JSON.parse(JSON.stringify(args))]);
    if (!(name in answers)) return Promise.reject(new Error("unexpected call " + String(name)));
    let a = answers[name]; if (typeof a === "function") a = a(...args);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  } });
  return { api, log, money: () => log.filter(([n]) => !READS.includes(n)) };
}
// reads the two screens make at different moments (drawing); the comparison is over everything else
const READS = ["ppStatus", "ppPools", "ppMyPools", "ppListRetired", "ppPendingCollect", "ppCompleteBackupRequired", "ppPairInfo", "ppMarketToken", "ppMarket", "ppActivity", "ppFeed", "ppAggregate", "ppWhy"];
const BASE = { ppPools: [POOL], ppPairInfo: { pools: 1, depth: "40000" }, ppMarketToken: { usdt: MXUSD }, ppMarket: { mid: 0.0032, fresh: true }, ppMyPools: [], ppListRetired: [], ppPendingCollect: [], ppCompleteBackupRequired: false, ppActivity: [], ppFeed: [], ppWhy: null };

/** The old panel on a stand-in page: elements exist when asked for, hold a value and their handlers. */
const MINE = { address: PK("B1"), opk: PK("0B"), tok: MXUSD, tokName: "USDT", tokDecimals: 8, reserveM: "40000", reserveT: "128.4", value: "80000", poolPrice: "0.00321", feesMinima: 30.42569, feesPct: 0.07169, kratio: 1.2, priceMove: -2.3199, il: -0.01399, ageBlocks: 5120, signingStateUnverified: true, unresolved: false };
const LOST = { address: PK("B9"), opk: PK("09"), tok: MXUSD, signingStateUnverified: false, unresolved: true };
const RETIRED = [{ address: PK("B7"), opk: PK("07") }, { address: PK("B8"), opk: PK("08") }];
// what the old panel's card buttons carry (pools.js wirePpMineActions): the stand-in page hands them back so they can be pressed
const CARD = { ppadd: MINE.address, ppmig: MINE.address, ppwd: MINE.address, ppcalc: MINE.address, ppconfirm: MINE.opk, pprecover: LOST.address, ppretire: LOST.address, ppunretire: "all", ppcollect: "1" };
function oldPanel(api, confirm) {
  const els = {}, said = [], btn = {};
  const mk = (id) => ({ id, value: "", checked: false, textContent: "", innerHTML: "", innerText: "", disabled: false, dataset: {}, style: {}, scrollTop: 0, type: "",
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, insertAdjacentHTML() {}, appendChild() {}, contains: () => false, remove() {},
    querySelectorAll: (sel) => { const m = /^\[data-([a-z]+)\]$/.exec(sel); if (!m || !(m[1] in CARD)) return []; return [btn[m[1]] = { dataset: { [m[1]]: CARD[m[1]] } }]; } });
  // an overlay exists only between the insertAdjacentHTML that makes it and its remove(): the old panel asks "is it open?"
  const open = new Set(), el = (id) => (/Ov$/.test(id) && !open.has(id) ? null : els[id] || (els[id] = Object.assign(mk(id), /Ov$/.test(id) ? { remove() { open.delete(id); } } : {})));
  const bodyEl = Object.assign(mk("body"), { insertAdjacentHTML(_p, html) { for (const m of String(html).matchAll(/id="(\w+Ov)"/g)) open.add(m[1]); } });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, body: bodyEl, documentElement: mk("html"), createElement: () => mk("new"), activeElement: null };
  const ctx = vm.createContext({ window: null, document, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, console, Date, Math, Number, String, JSON, Promise, isFinite, parseFloat, parseInt, TextEncoder, Array,
    getComputedStyle: () => ({ getPropertyValue: () => "" }) });
  ctx.window = ctx;
  vm.runInContext(src("pools.js"), ctx, { filename: "pools.js" });
  const TOK = { shortId: (x) => x, tidyAmount: (x) => String(x), tokenName: (t, tid) => (t && t.name && t.name.name) || tid };
  ctx.PoolsPanel.init({ api, el, esc: (s) => String(s == null ? "" : s), toast: (m, k) => said.push([m, k || ""]), copy() {}, short: (x) => x, TOK, MINIMA: "0x00", PoolCalc: {},
    showConfirm: async (title, msg, ok) => { said.push(["confirm", title, ok]); return confirm; }, showProgress: () => ({ close() {} }),
    tryCmd: async (c) => (c === "balance" ? BAL : c === "block" ? { block: "2428089" } : null), running: () => true, activeView: () => "pandapools" });
  return { el, said, btn, P: ctx.PoolsPanel, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
/** the old panel opened on My LP, with one live pool, one saved pool whose reserves are not found, and two closed ones */
async function oldMylp(answers, confirm) {
  const r = recorder(Object.assign({}, BASE, { ppMyPools: [MINE, LOST], ppListRetired: RETIRED }, answers)), p = oldPanel(r.api, confirm);
  p.P._setView("mylp"); await p.P.render(); await p.settle();
  return { r, p, press: async (h) => { await h(); await p.settle(); return r.money(); } };
}
const ui = (confirm) => { const said = []; return { said, confirm: async (title, text, ok) => { said.push(["confirm", title, ok]); return confirm; }, say: (text, kind) => said.push([text, kind]) }; };

// ---- swap: ppQuote at the click (frozen) → confirm → ppSwap(quoteId) ----
const SWAPS = [
  { name: "sell MINIMA for MxUSD", dir: true, text: "250", quote: QUOTE },
  { name: "buy MINIMA with MxUSD", dir: false, text: "1.5", quote: Object.assign({}, QUOTE, { quoteId: 42, totalOut: "465.11" }) },
  { name: "nothing typed", dir: true, text: "", quote: QUOTE },
  { name: "letters in the amount", dir: true, text: "25o", quote: QUOTE },
  { name: "a comma in the amount", dir: true, text: "1,5", quote: QUOTE },
  { name: "zero", dir: true, text: "0", quote: QUOTE },
  { name: "too large for the pools", dir: true, text: "900000", quote: { ok: false } },
  { name: "the engine has not started", dir: true, text: "250", quote: { ok: false, notReady: true } }
];
async function oldSwap(c, confirm, swapAnswer) {
  const r = recorder(Object.assign({}, BASE, { ppQuote: c.quote, ppSwap: swapAnswer || { txpowid: PK("71"), totalIn: "250", totalOut: "0.79832711" } })), p = oldPanel(r.api, confirm);
  p.P._setView("swap"); await p.P.render(); await p.settle();
  if (!c.dir) { p.el("ppFlip").onclick(); await p.settle(); }   // the old panel opens on "pay MINIMA"
  p.el("ppSwapAmt").value = c.text;
  await p.el("ppSwapGo").onclick(); await p.settle();
  return { calls: r.money(), said: p.said };
}
async function newSwap(c, confirm, swapAnswer) {
  const r = recorder({ ppQuote: c.quote, ppSwap: swapAnswer || { txpowid: PK("71"), totalIn: "250", totalOut: "0.79832711" }, ppWhy: null }), u = ui(confirm);
  const res = await PP.Act.swap(r.api, u, T, c.dir, c.text);
  return { calls: r.money(), said: u.said, res };
}
for (const c of SWAPS) for (const confirm of [true, false]) {
  test(`swap, ${c.name}, review ${confirm ? "accepted" : "closed"}: the same calls with the same arguments as the old panel`, async () => {
    const was = await oldSwap(c, confirm), now = await newSwap(c, confirm);
    assert.deepEqual(now.calls, was.calls);
    const swapped = now.calls.some(([n]) => n === "ppSwap");
    assert.equal(swapped, confirm && !!c.quote.ok && PP.amountOk(c.text), "ppSwap only after an accepted review of a quote that was given");
    if (swapped) assert.deepEqual(now.calls, [["ppQuote", [MXUSD, c.dir, c.text]], ["ppSwap", [c.quote.quoteId]]], "a fresh quote at the click, then that quote's id and nothing else");
    if (!PP.amountOk(c.text)) assert.deepEqual(now.calls, [], "an amount that is not a number asks the engine nothing");
  });
}
test("swap: a failure makes the same calls as the old panel and says what happened, whether funds moved and what to do", async () => {
  const boom = new Error("Error invoking remote method 'mcd:ppSwap': Error: Could not identify the input signing key.");
  const was = await oldSwap(SWAPS[0], true, boom), now = await newSwap(SWAPS[0], true, boom);
  assert.deepEqual(now.calls, was.calls);
  const [text, kind] = now.said[now.said.length - 1];
  assert.equal(kind, "error"); assert.match(text, /^The swap was not done and nothing was signed/); assert.match(text, /try again\.$/);
  assert.ok(!/remote method|mcd:/.test(text), "no bridge words");
  const ok = await newSwap(SWAPS[0], true);
  assert.match(ok.said[ok.said.length - 1][0], /^Swap submitted: you pay 250 MINIMA and receive 0\.79832711 MxUSD when a block confirms it\. It is not final yet/);
  assert.ok(ok.said[ok.said.length - 1][0].endsWith(PK("71")), "the transaction id whole");
});
test("the review is the old panel's question and names exactly what is posted; there is no slippage setting, as on the phone", async () => {
  const was = await oldSwap(SWAPS[0], false), now = await newSwap(SWAPS[0], false);
  assert.deepEqual(now.said[0], was.said.find((x) => x[0] === "confirm"), "the same title and the same button");
  const rv = PP.swapReview(QUOTE, "250", T, true);
  assert.match(rv.text, /^Pay {2}250 MINIMA\nReceive {2}0\.79832711 MxUSD\n/); assert.match(rv.text, /Routed across 2 pools in one transaction/);
  assert.match(rv.text, /if a pool moves before it confirms, the swap is rejected and you keep your funds/);
  assert.ok(!/slip/i.test(src("dexicon-pp.js").replace(/no slippage setting|There is no slippage setting/g, "")), "no slippage control was invented");
});

// ---- one money action at a time, in every room ----
test("one gate for rooms ①, ② and ③: while a money action runs, a second one from any room does nothing", async () => {
  let runs = 0, release;
  const first = C.money(() => new Promise((r) => { runs++; release = r; }));
  assert.equal(C.gate.on, true);
  await C.money(async () => { runs++; }); await C.money(async () => { runs++; });
  assert.equal(runs, 1, "the double click, and the other room's button, started nothing");
  release(); await first; assert.equal(C.gate.on, false);
  await assert.rejects(C.money(async () => { throw new Error("x"); })); assert.equal(C.gate.on, false, "free again after a failure");
  const ui_ = src("dexicon-ui.js"), ax = src("dexicon-ax.js"), pp = src("dexicon-pp.js");
  assert.match(ui_, /const money = \(fn\) => C\.money\(fn, draw\)/, "room 3 uses DexCore's gate");
  assert.ok(!/X\.busy/.test(ui_), "no second gate of room 3's own");
  for (const re of [/\$\("axReview"\)\.onclick = \(\) => D\.money\(/, /\$\("mkSave"\)\.onclick = \(\) => D\.money\(/, /\$\("mkWithdraw"\)\.onclick = \(\) => D\.money\(/, /return D\.money\(async \(\) => \{\n\s+await busyWhile\(what, /,
    /return D\.money\(\(\) => otcAct\(ds\)\)/, /const one = \(fn\) => D\.money\(fn\)/, /await D\.money\(async \(\) => \{ S\.switching = true/]) assert.match(ax, re, "room 1: " + re);
  assert.match(pp, /\$\("ppGo"\)\.onclick = \(\) => D\.money\(/, "room 2: the swap");
  assert.match(src("app.js"), /DexPools\.init\(\{[^}]*money: DexUI\.money/); assert.match(src("app.js"), /DexAx\.init\(\{[^}]*money: DexUI\.money/);
});

// ---- words and numbers ----
test("amounts are cut, never rounded; the balance line is cut to 6 decimals, the estimate to 8", () => {
  assert.equal(PP.cut("0.79832719", 6), "0.798327"); assert.equal(PP.cut("1.999999999", 8), "1.99999999"); assert.equal(PP.cut("13.40488406682", 6), "13.404884");
  assert.equal(PP.whole("3940.42615914218000"), "3940.42615914218");
  assert.equal(PP.balanceLine(BAL, T), "Your balance: 5000 MINIMA  ·  300.5 MxUSD");
  assert.equal(PP.quoteRows(QUOTE, T, true).out, "0.79832711");
  assert.deepEqual(PP.quoteRows(QUOTE, T, true).rows.map((r) => r[0]), ["Rate", "Price impact", "Routed across", "Pool fee (0.50%)", "You receive"]);
  assert.equal(PP.quoteRows({ ok: false }, T, true).note, "This trade is too large for the pools' depth. Try a smaller amount.");
});
test("the dollar token is MxUSD by its token id; a token that only calls itself USDT is said to be another token", () => {
  assert.equal(PP.tokLabel(MXUSD, "USDT"), "MxUSD"); assert.equal(PP.tokLabel(MXUSD.toLowerCase(), ""), "MxUSD");
  assert.equal(PP.tokLabel(PK("EE"), "USDT"), "USDT (not MxUSD)"); assert.equal(PP.tokLabel(PK("EE"), "mxUSDT"), "mxUSDT (not MxUSD)");
  assert.equal(PP.tokLabel(PK("EE"), ""), "unnamed token (not MxUSD)"); assert.equal(PP.pairName({ tok: PK("EE"), name: PP.tokLabel(PK("EE"), "") }), "MINIMA / unnamed token (not MxUSD)  ·  token " + PK("EE"), "an unnamed token is named by its whole id");
  assert.equal(PP.mx("12 mxUSDT"), "12 MxUSD");
  assert.deepEqual(PP.pairs([POOL, Object.assign({}, POOL, { address: PK("B2") })]), [T]);
  const pp = src("dexicon-pp.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/USDT\/MINIMA \(MEXC\)/g, "").replace(/usdt\?|m\?x\?USDT|not MxUSD/g, "");
  assert.ok(!/USDT/.test(pp), "the screens write MxUSD; USDT is only the MEXC market's unit");
});
// ---- 0.18.135: a token is its ID. A look-alike name can never be shown as MxUSD, be the default pair, or become the selection ----
test("a look-alike token is never MxUSD: marked, its whole id in the pair name and the review, MxUSD first, the selection held by token id", async () => {
  const FAKE = PK("EE"), ZW = "\u200b", names = ["MxUSD ", "MxUSD" + ZW, "\u041cxUSD", "Mx\u0055\u0405D", "ＭｘＵＳＤ", "USDT", "mxusdt", "M x U S D", "Tether USDT"];
  for (const n of names) {
    const label = PP.tokLabel(FAKE, n);
    assert.notEqual(label, "MxUSD", JSON.stringify(n)); assert.ok(label.endsWith(" (not MxUSD)"), JSON.stringify(n) + " is marked: " + label);
    assert.ok(!/[\u200b\u202e]/.test(label), "no zero-width or direction character reaches the screen");
    assert.equal(PP.imitates(FAKE, n), true, JSON.stringify(n) + " imitates the dollar token");
  }
  assert.equal(PP.tokLabel(FAKE, "\u202eDSUxM"), "DSUxM (not MxUSD)", "a direction override is removed: the name is shown as its letters are, and the mark stays after it");
  assert.equal(PP.imitates(FAKE, "PANDA"), false); assert.equal(PP.imitates(MXUSD, "USDT"), false, "the real one imitates nothing");
  assert.equal(PP.tokLabel(FAKE, "PANDA"), "PANDA (not MxUSD)", "EVERY other token is marked, whatever its name");
  // a fake pool deeper than the real one, so the scan lists it first: the real MxUSD is still first and the default
  const fakePool = { address: PK("F1"), tok: FAKE, tokName: "MxUSD ", reserveM: "900000", reserveT: "1" }, panda = { address: PK("F2"), tok: PK("AB"), tokName: "PANDA", reserveM: "5", reserveT: "5" };
  const list = PP.pairs([fakePool, panda, POOL]);
  assert.deepEqual(list.map((t) => t.tok), [MXUSD, FAKE, PK("AB")]); assert.deepEqual(list[0], T); assert.equal(list[1].fake, true); assert.equal(list[2].fake, undefined);
  assert.equal(PP.chosen(list, "").t.tok, MXUSD, "nothing chosen: MxUSD");
  assert.equal(PP.chosen(PP.pairs([fakePool, panda]), "").t.tok, FAKE, "with no MxUSD pool the first pair is another token, and it is marked");
  assert.equal(PP.pairName(list[1]), "MINIMA / MxUSD (not MxUSD)  ·  token " + FAKE, "the pair name carries the whole token id");
  assert.equal(PP.poolLine(list[1], { pools: 1, depth: "900000" }), "MINIMA / MxUSD (not MxUSD)  ·  token " + FAKE + "   ·   1 pool   ·   depth 900000 MINIMA");
  assert.equal(PP.poolLine(T, { pools: 1, depth: "40000" }), "MINIMA / MxUSD   ·   1 pool   ·   depth 40000 MINIMA");
  // the selection is a token id: a rescan that reorders or drops pools never moves it to another token
  assert.equal(PP.chosen(PP.pairs([POOL, panda, fakePool]), PK("AB")).t.tok, PK("AB")); assert.equal(PP.chosen(PP.pairs([panda, fakePool, POOL]), PK("AB").toLowerCase()).t.tok, PK("AB"));
  assert.deepEqual(PP.chosen(PP.pairs([POOL, fakePool]), PK("AB")), { t: null, lost: true }, "the selected token left the registry: nothing is selected");
  assert.deepEqual(PP.chosen(PP.pairs([POOL, fakePool]), PP.NONE), { t: null, lost: false }, "and it stays so until the user picks");
  assert.ok(PP.lostLine(PK("AB")).includes("(token " + PK("AB") + ")")); assert.match(PP.lostLine(PK("AB")), /no other pair was selected for you/);
  // the review: the pair with the whole id, and the warning in its own line for a name that imitates
  const rv = PP.swapReview(QUOTE, "250", list[1], true).text;
  assert.match(rv, /\nReceive {2}0\.79832711 MxUSD \(not MxUSD\)\n/); assert.ok(rv.includes("\nPool pair  MINIMA / MxUSD (not MxUSD)  ·  token " + FAKE + "\n\nThis token is not MxUSD. Its name imitates it.\n"));
  const rp = PP.swapReview(QUOTE, "250", list[2], true).text; assert.ok(rp.includes("token " + PK("AB"))); assert.ok(!rp.includes("imitates"));
  const rm = PP.swapReview(QUOTE, "250", T, true).text; assert.ok(rm.includes("\nPool pair  MINIMA / MxUSD\n")); assert.ok(!rm.includes("imitates") && !rm.includes("not MxUSD"));
  // the click: the engine is asked about the token id that was selected, nothing else
  const r = recorder({ ppQuote: QUOTE, ppSwap: { txpowid: PK("71"), totalOut: "0.79832711" }, ppWhy: null }), u = ui(true);
  await PP.Act.swap(r.api, u, list[1], true, "250");
  assert.deepEqual(r.money()[0], ["ppQuote", [FAKE, true, "250"]]); assert.match(u.said.at(-1)[0], /receive 0\.79832711 MxUSD \(not MxUSD\) when/, "the result marks it too");
  // every screen that names a token: Pools, combined, My LP, Wallet, Activity
  assert.equal(PP.poolCard(fakePool).title, "MINIMA / MxUSD (not MxUSD)  ·  token " + FAKE); assert.equal(PP.combinedCard({ tok: FAKE, name: "MxUSD ", count: 1, totalMinima: "1", totalToken: "1", price: "1", depth: "1" }).title, "MINIMA / MxUSD (not MxUSD)  ·  token " + FAKE + "  ·  combined");
  assert.match(PP.lpRows(Object.assign({}, MINE, { tok: FAKE, tokName: "USDT" }))[0][1], /USDT \(not MxUSD\)$/);
  // records are labelled by the glue, by token id: the screen rewrites no word of them
  assert.equal(PP.actItem({ type: "SWAP", summary: "Sold 5 MINIMA for 3 Tether USDT (not MxUSD, token " + FAKE + ")", ts: 1 }, 2).summary, "Sold 5 MINIMA for 3 Tether USDT (not MxUSD, token " + FAKE + ")");
  assert.equal(PP.feedItem({ kind: "SWAP", minimaIn: true, minimaAmt: "1", tokenAmt: "2", tokenLabel: "Tether USDT (not MxUSD, token " + FAKE + ")", ts: 1 }, 2).title, "MINIMA sale · 1 MINIMA / 2 Tether USDT (not MxUSD, token " + FAKE + ")");
  const pp = src("dexicon-pp.js");
  assert.match(pp, /if \(S\.pools && chosen\(toks\(\), S\.sel\)\.lost\) \{ S\.lost = S\.sel; S\.sel = NONE;/, "a rescan that loses the selected token clears the selection");
  assert.match(pp, /<option value="\$\{esc\(x\.tok\)\}"/, "the pair list is keyed by token id, not by position"); assert.ok(!/S\.sel = Number|toks\(\)\[S\.sel\]/.test(pp));
  assert.ok(!/mx\((swapSummary|f\.tokenLabel)|const recentRow[^\n]*mx\(/.test(pp), "no record is reworded");
});
test("the glue labels a token in a record by its id: MxUSD only for the real id, every other token by its own name and whole id", async () => {
  const h = await glue();
  try {
    const L = h.api._labelById, FAKE = PK("EE");
    assert.equal(L(MXUSD, "USDT"), "MxUSD"); assert.equal(L(MXUSD.toLowerCase(), "anything"), "MxUSD");
    assert.equal(L(FAKE, "MxUSD"), "MxUSD (not MxUSD, token " + FAKE + ")"); assert.equal(L(FAKE, "Tether USDT"), "Tether USDT (not MxUSD, token " + FAKE + ")");
    assert.equal(L(FAKE, "MxUSD\u200b "), "MxUSD (not MxUSD, token " + FAKE + ")"); assert.equal(L(FAKE, ""), "unnamed token (not MxUSD, token " + FAKE + ")");
    const R2 = h.api._relabelSwap, hist = (tok) => ({ history: { deltas: JSON.stringify({ "0x00": "-5", [tok]: "3" }) } });
    assert.equal(R2({ type: "SWAP", summary: "Sold 5 MINIMA for 3 USDT" }, hist(MXUSD)).summary, "Sold 5 MINIMA for 3 MxUSD", "an old record of the real token");
    assert.equal(R2({ type: "SWAP", summary: "Sold 5 MINIMA for 3 USDT" }, hist(FAKE)).summary, "Sold 5 MINIMA for 3 USDT (not MxUSD, token " + FAKE + ")", "an old record of a token that called itself USDT");
    assert.equal(R2({ type: "SWAP", summary: "Sold 5 MINIMA for 3 Tether USDT" }, {}).summary, "Sold 5 MINIMA for 3 Tether USDT", "no history: left exactly as recorded, no word rewritten");
    assert.equal(R2({ type: "CREATE", summary: "Created a pool with 5 MINIMA" }, hist(MXUSD)).summary, "Created a pool with 5 MINIMA");
    const g = fs.readFileSync(path.join(ROOT, "main/pandapools.js"), "utf8");
    assert.match(g, /var tokenLabel = labelById\(tok, pl\[0\] && pl\[0\]\.tokName\)/, "a new swap's record"); assert.match(g, /labels\[USDT_TOKENID\.toLowerCase\(\)\] = "MxUSD"/);
  } finally { h.close(); }
});
test("the MEXC line: only for the MxUSD pair; the pool price and the gap are cut, not rounded", () => {
  const pools = [Object.assign({}, POOL, { reserveM: "1000", reserveT: "3.21199" })];
  assert.equal(PP.marketLine(T, { mid: 0.003178, fresh: true }, pools), "Market ≈ 0.003178 USDT/MINIMA (MEXC)  ·  Pool 0.003211  ·  1% above market");
  assert.equal(PP.marketLine(T, { mid: 0.0032119, fresh: true }, pools), "Market ≈ 0.003211 USDT/MINIMA (MEXC)  ·  Pool 0.003211  ·  at market");
  assert.equal(PP.marketLine(T, { mid: 0, fresh: false }, pools), "Market price unavailable (MEXC)");
  assert.equal(PP.marketLine({ tok: PK("EE"), name: "X" }, { mid: 1, fresh: true }, pools), "");
});
test("a failed action: the engine's fixed sentences are said in plain words, with the node's own answer when it came during the action", () => {
  const node = { verb: "txnsign", error: "No keys found for the coin's address.", at: 2000 };
  const key = PP.failText("The swap", "Could not identify the input signing key.", node, 1000);
  assert.match(key, /nothing was signed/); assert.match(key, /The node's last answer while this ran \(its "txnsign" command\): No keys found for the coin's address\./);
  assert.ok(!/The node's last answer/.test(PP.failText("The swap", "Could not identify the input signing key.", node, 3000)), "an older answer is not this action's reason");
  const mint = PP.failText("Creating the pool", "could not mint an owner key (grant this app write access to create pools)", null, 0);
  assert.match(mint, /^Creating the pool was not done and no funds moved: the node did not make the new key/); assert.ok(!/grant this app/.test(mint), "the phone's permission hint is not shown on the desktop");
  const bk = PP.failText("Creating the pool", "Error invoking remote method 'mcd:ppCreate': Error: BACKUP_REQUIRED: save and verify the encrypted pool + node backup before creating another pool.");
  assert.match(bk, /was not done and no funds moved/); assert.match(bk, /Back up \/ restore pools/); assert.ok(!/BACKUP_REQUIRED|mcd:/.test(bk), "no internal words");
  assert.match(PP.failText("The swap", "The swap timed out — check Activity and your balance before retrying."), /^It is not known whether this was sent/);
  assert.match(PP.failText("The swap", "This quote expired — re-enter the amount to get a fresh quote."), /was not sent and no funds moved/);
  assert.match(PP.failText("The swap", "txncheck failed"), /^The swap did not go through: txncheck failed\. Look at Activity: if no new line is there, nothing was sent and no funds moved\.$/);
  assert.match(PP.failText("The swap", ""), /no reason was given/);
});

// ---- 0.18.136: what is reviewed is what is sent ----
test("Add liquidity: one MINIMA amount, the review states both sides as the engine will take them, and the result says what the engine took", async () => {
  // the engine's rule (poolmgr.js deposit): MINIMA × token reserve ÷ MINIMA reserve, cut to the token's decimals
  assert.equal(PP.depositToken(MINE, "100"), "0.321"); assert.equal(PP.depositToken({ reserveM: "3", reserveT: "1", tokDecimals: 8 }, "1"), "0.33333333", "cut, never rounded");
  assert.equal(PP.depositToken({ reserveM: "3", reserveT: "2", tokDecimals: 2 }, "1"), "0.66"); assert.equal(PP.depositToken({ reserveM: "0", reserveT: "2" }, "1"), null); assert.equal(PP.depositToken(LOST, "1"), null);
  const h = await glue();
  try { await h.api.init(); for (const [pool, m] of [[{ reserveM: "3", reserveT: "1", tokDecimals: 8, tok: MXUSD }, "1"], [MINE, "100"], [{ reserveM: "815250.75", reserveT: "2617.77115575", tokDecimals: 8, tok: MXUSD }, "0.37"]]) {
    const used = h.api._depositUsed(pool, m); assert.equal(used.token, PP.depositToken(pool, m), "the screen's estimate is the engine's own arithmetic"); assert.equal(used.label, "MxUSD"); }
    assert.match(fs.readFileSync(path.join(ROOT, "main/pandapools/poolmgr.js"), "utf8"), /var addTc = addM\.times\(PP\.dec\(p\.reserveT\)\)\.div\(PP\.dec\(p\.reserveM\)\)\.toDP\(p\.tokDecimals, D\.ROUND_DOWN\);/, "the engine still works the token side out itself");
  } finally { h.close(); }
  // an empty or zero MINIMA amount is refused BEFORE the question; the old two-field form asked first and the engine then refused
  for (const bad of ["", "0", "0.0", "abc", "-1"]) { const r = recorder({}), u = ui(true); assert.equal(await PP.Act.deposit(r.api, u, MINE, bad), null); assert.deepEqual(r.log, []); assert.ok(!u.said.some((x) => x[0] === "confirm"), JSON.stringify(bad) + ": no question"); assert.match(u.said[0][0], /above zero\. Nothing was sent\.$/); }
  const r = recorder({ ppDeposit: { txpowid: PK("72"), minima: "100", token: "0.32099999" }, ppWhy: null }), u = ui(true), texts = []; u.confirm = async (title, text) => { texts.push(text); return true; };
  await PP.Act.deposit(r.api, u, MINE, "100");
  assert.match(texts[0], /^Add 100 MINIMA and about 0\.321 MxUSD to the pool\.\n\nMxUSD is taken at the pool's ratio when the transaction is posted, so this figure can change slightly\.\n\n/); assert.ok(texts[0].includes("Pool: " + MINE.address));
  assert.deepEqual(r.money(), [["ppDeposit", [MINE.address, "100", "0.321"]]], "the engine's own call: the pool, the MINIMA, and the token side that was reviewed");
  assert.match(u.said.at(-1)[0], /^Liquidity sent to the pool: 100 MINIMA and 0\.32099999 MxUSD, the amounts the pool took at its ratio\./, "what the engine took, not the estimate and not what was typed");
  const r2 = recorder({ ppDeposit: { txpowid: PK("72") }, ppWhy: null }), u2 = ui(true); await PP.Act.deposit(r2.api, u2, MINE, "100");
  assert.match(u2.said.at(-1)[0], /100 MINIMA and the MxUSD that goes with it at the pool's ratio \(the exact figure is in Activity\)/, "no figure is invented when the engine's is not known");
  assert.ok(!/0 MxUSD/.test(texts[0] + u.said.at(-1)[0] + u2.said.at(-1)[0]), "never '100 MINIMA and 0 MxUSD'");
  const pp = src("dexicon-pp.js"), sheet = pp.slice(pp.indexOf("async function addSheet"), pp.indexOf("function calc("));
  assert.equal((sheet.match(/fld\(/g) || []).length, 1, "one field"); assert.ok(!/name="b"|"b"\)/.test(sheet));
});
test("swap: the review and the result print the amount the pools take (the route's totalIn), not the typed one", async () => {
  const q = Object.assign({}, QUOTE, { totalIn: "249.99999999" });
  assert.match(PP.swapReview(q, "250", T, true).text, /^Pay {2}249\.99999999 MINIMA {2}\(you typed 250; this is the amount the pools take\)\nReceive/);
  assert.match(PP.swapReview(QUOTE, "250.0", T, true).text, /^Pay {2}250 MINIMA\nReceive/, "the same amount written another way is not a difference");
  const r = recorder({ ppQuote: q, ppSwap: { txpowid: PK("71"), totalIn: "249.99999999", totalOut: "0.79832711" }, ppWhy: null }), u = ui(true);
  await PP.Act.swap(r.api, u, T, true, "250");
  assert.match(u.said.at(-1)[0], /^Swap submitted: you pay 249\.99999999 MINIMA and receive 0\.79832711 MxUSD/);
});

// ---- My LP: add, close, collect, recover, put away, bring back, confirm signing, statement ----
const LP = [
  { name: "add liquidity, both sides", answers: { ppDeposit: { txpowid: PK("72") } }, old: (o) => { o.p.btn.ppadd.onclick(); o.p.el("pp2A").value = "500"; o.p.el("pp2B").value = "1.605"; return o.p.el("pp2Go").onclick(); }, now: (api, u) => PP.Act.deposit(api, u, MINE, "500"), want: [["ppDeposit", [MINE.address, "500", "1.605"]]] },
  { name: "add liquidity, nothing typed", answers: {}, old: (o) => { o.p.btn.ppadd.onclick(); return o.p.el("pp2Go").onclick(); }, now: (api, u) => PP.Act.deposit(api, u, MINE, ""), want: [], never: true },
  { name: "add liquidity, letters", answers: {}, old: (o) => { o.p.btn.ppadd.onclick(); o.p.el("pp2A").value = "5oo"; return o.p.el("pp2Go").onclick(); }, now: (api, u) => PP.Act.deposit(api, u, MINE, "5oo"), want: [], never: true },
  { name: "close the pool", answers: { ppClose: { txpowid: PK("73") } }, old: (o) => o.p.btn.ppwd.onclick(), now: (api, u) => PP.Act.withdraw(api, u, MINE), want: [["ppClose", [MINE.address]]] },
  { name: "collect to wallet", answers: { ppCollect: { coins: 2, foreign: 0 } }, old: (o) => o.p.el("ppCollectBtn").onclick(), now: (api, u) => PP.Act.collect(api, u), want: [["ppCollect", []]] },
  { name: "collect now (a withdrawn-funds card)", answers: { ppCollect: { cleared: true }, ppPendingCollect: [{ oadr: PK("0A"), status: "PENDING" }] }, old: (o) => o.p.btn.ppcollect.onclick(), now: (api, u) => PP.Act.collectNow(api, u), want: [["ppCollect", []]], noConfirm: true },
  { name: "check for reserves", answers: { ppRecoverSaved: { restored: 0, total: 1, details: ["not found"], warn: "" } }, old: (o) => o.p.btn.pprecover.onclick(), now: (api, u) => PP.Act.recover(api, u, LOST.address), want: [["ppRecoverSaved", [LOST.address]]], noConfirm: true },
  { name: "put a closed pool away", answers: { ppRetirePool: true }, old: (o) => o.p.btn.ppretire.onclick(), now: (api, u) => PP.Act.retire(api, u, LOST.address), want: [["ppRetirePool", [LOST.address, true]]], noConfirm: true },
  { name: "bring the closed pools back", answers: { ppRetirePool: true }, old: (o) => o.p.btn.ppunretire.onclick(), now: (api, u) => PP.Act.unretire(api, u, RETIRED), want: RETIRED.map((x) => ["ppRetirePool", [x.address, false]]), noConfirm: true },
  { name: "confirm the wallet signing state", answers: { ppConfirmSigning: true }, old: (o) => o.p.btn.ppconfirm.onclick(), now: (api, u) => PP.Act.confirmSigning(api, u, MINE.opk), want: [["ppConfirmSigning", [MINE.opk, true]]] },
  { name: "export the statement", answers: { ppStatement: { csv: "a,b\n1,2\n", rows: 1, pools: 1, backfilled: true }, exportCsv: "/tmp/x.csv" }, old: (o) => o.p.el("ppStatementBtn").onclick(), now: (api, u) => PP.Act.statement(api, u), want: [["ppStatement", []], ["exportCsv", ["a,b\n1,2\n", "pandapools-statement.csv"]]], noConfirm: true },
  { name: "export the statement, no pools", answers: { ppStatement: { csv: "", rows: 0, pools: 0, backfilled: true } }, old: (o) => o.p.el("ppStatementBtn").onclick(), now: (api, u) => PP.Act.statement(api, u), want: [["ppStatement", []]], noConfirm: true }
];
for (const c of LP) for (const confirm of c.noConfirm || c.never ? [true] : [true, false]) {
  test(`My LP, ${c.name}${c.noConfirm || c.never ? "" : confirm ? ", confirmed" : ", closed at the question"}: the same calls with the same arguments as the old panel`, async () => {
    const o = await oldMylp(c.answers, confirm), was = await o.press(() => c.old(o));
    const r = recorder(Object.assign({ ppWhy: null }, c.answers)), u = ui(confirm); u.show = async (title, text) => { u.said.push(["show", title, text]); };
    await c.now(r.api, u);
    assert.deepEqual(r.money(), was);
    assert.deepEqual(r.money(), confirm ? c.want : [], confirm ? "exactly these calls" : "a closed question sends nothing");
    if (!c.noConfirm && !c.never) assert.ok(u.said.some((x) => x[0] === "confirm") && o.p.said.some((x) => x[0] === "confirm"), "both ask first");
  });
}
test("My LP: every outcome says what happened, whether funds moved and what to do; identifiers are whole; figures are cut", async () => {
  const run = async (answers, fn) => { const r = recorder(Object.assign({ ppWhy: null }, answers)), u = ui(true); u.show = async (t, x) => { u.said.push(["show", t, x]); }; await fn(r.api, u); return u.said; };
  const boom = new Error("Error invoking remote method 'mcd:ppClose': Error: The close timed out — check Activity before retrying.");
  let said = await run({ ppClose: boom }, (a, u) => PP.Act.withdraw(a, u, MINE));
  assert.ok(said[0][2] === "Withdraw" && said[0][1] === "Withdraw all liquidity?");
  assert.match(said[1][0], /^It is not known whether this was sent/); assert.equal(said[1][1], "error");
  said = await run({ ppCollect: { coins: 0, foreign: 2 } }, (a, u) => PP.Act.collect(a, u));
  assert.match(said[1][0], /^There was nothing to collect right now\. No funds moved\. 2 owner keys are paused or not in this wallet/); assert.equal(said[1][1], "error");
  said = await run({ ppCollect: { stranded: true } }, (a, u) => PP.Act.collectNow(a, u));
  assert.match(said[0][0], /^The funds were not moved: this wallet cannot sign for that payout address/);
  said = await run({ ppConfirmSigning: false }, (a, u) => PP.Act.confirmSigning(a, u, MINE.opk));
  assert.ok(said[0][0] === "confirm" && said[1][0].startsWith("Not confirmed: signing stays paused"));
  said = await run({ ppRecoverSaved: { restored: 0, total: 1, details: ["Pool " + LOST.address + ": 3 USDT reserve not found."], warn: "No transaction was signed." } }, (a, u) => PP.Act.recover(a, u, LOST.address));
  assert.deepEqual(said[0].slice(0, 2), ["show", "Recovery result"]); assert.ok(said[0][2].includes(LOST.address) && said[0][2].includes("3 MxUSD reserve"));
  said = await run({ ppStatement: { csv: "x", rows: 7, pools: 1, backfilled: false }, exportCsv: "/tmp/x.csv" }, (a, u) => PP.Act.statement(a, u));
  assert.match(said[0][0], /still being read from the node \(7 transactions so far\): the file says so/);
  assert.equal(PP.poolIds(MINE), "Pool: " + MINE.address + "\nOwner key: " + MINE.opk);
  assert.equal(PP.cutNum(30.42569), "30.4256"); assert.equal(PP.cutNum(0.07169), "0.0716"); assert.equal(PP.cutNum(-2.3199), "-2.3199"); assert.equal(PP.cutNum(-0.01399), "-0.0139"); assert.equal(PP.cutNum(-0.00001), "0");
  const rows = PP.lpRows(MINE);
  assert.deepEqual(rows.map((x) => x[0]), ["Your liquidity", "Value now", "Pool price", "Fees earned", "Price since open", "Impermanent loss", "Age"]);
  assert.equal(rows[3][1], "≈ 30.4256 MINIMA  (+0.0716%)"); assert.equal(rows[4][1], "-2.3199%"); assert.equal(rows[5][2], "warn");
  assert.deepEqual(PP.lpSummary([MINE, LOST]), { value: "40000 MINIMA reserves", sub: "1 visible pool · token reserves shown below · 1 unavailable" });
  assert.deepEqual(PP.lpSummary([LOST]), { value: "Reserves unavailable", sub: "1 saved pool needs a live reserve check." });
  assert.deepEqual(PP.lpSummary([]), { value: "No pools yet", sub: "Create a pool to start earning the swap fee." });
  assert.equal(PP.needsMigrate({ kratio: 1.85 }), true); assert.equal(PP.needsMigrate({ kratio: 1.84 }), false);
  const pp = src("dexicon-pp.js");
  assert.match(pp, /const act = \(fn\) => D\.money\(/, "every My LP action passes Dexicon's one gate");
  assert.match(pp, /if \(choice === "collect"\) return Act\.collect\(api\(\), ui\);/, "Collect is in the recovery tools, as on the phone, and runs inside the gate the tools were opened under");
  assert.match(pp, /if \(ds\.pptool === "recovery"\) return act\(recoveryTools\);/);
  assert.match(pp, /ppMyPools\(\)\.then\(\(m\) => \{ S\.mine = m \|\| \[\]; S\.mineErr = ""; \}, \(e\) => \{ S\.mineErr = bare\(e\); \}\)/, "saved pools that cannot be read are said, never shown as none");
});

// ---- Wallet ----
test("Wallet: balances whole, locked = confirmed minus sendable (never negative), and Consolidate is the wallet's own with the pool owner-key check", async () => {
  const card = PP.walletCard({ confirmed: "1262.750000123456", sendable: "1250.750000123456", unconfirmed: "0", coins: "5" }, "MINIMA", "0s ago");
  assert.equal(card.amount, "1250.750000123456", "not shortened"); assert.equal(card.coins, "5 COINS");
  assert.equal(card.line, "confirmed 1262.750000123456  ·  locked ≈ 12  ·  unconfirmed 0  ·  5 coins  ·  updated 0s ago  ·  click for coins");
  assert.match(PP.walletCard({ confirmed: "1", sendable: "2", unconfirmed: "0", coins: 1 }, "X", "now").line, /locked ≈ 0  ·.*1 coin  ·/);
  assert.match(PP.nodeCheck(true, "2428089", { ready: true }), /^The node answers: block 2428089\. PandaPools is running/); assert.match(PP.nodeCheck(true, 0, null), /did not answer/); assert.match(PP.nodeCheck(false, 0, null), /not running/);
  const pp = src("dexicon-pp.js"), app = src("app.js");
  assert.match(pp, /return act\(async \(\) => \{ await D\.consolidateToken\(what === "minima" \? MINIMA : MXUSD, what === "minima" \? "MINIMA" : "MxUSD"\); \}\);/, "behind Dexicon's one gate");
  assert.match(pp, /return row \? D\.showCoins\(row\) : null;/, "a balance opens the wallet's own coins dialog (Split, Consolidate, Send)");
  // the wallet's Consolidate, lifted from app.js and run: the question, then the owner-key check, then the node's command; a refusal sends nothing
  const body = /async function consolidateToken\(tid, name\) \{[\s\S]*?\n\}/.exec(app)[0];
  for (const [confirm, why, want] of [[true, null, ["confirm", "check", "cmd consolidate tokenid:" + MXUSD]], [true, "Nothing consolidated: your wallet holds a pool owner key that cannot sign.", ["confirm", "check", "confirm"]], [false, null, ["confirm"]]]) {
    const log = [], ctx = { validTok: () => true, toast() {}, showConfirm: async () => { log.push("confirm"); return confirm; }, api: { ppConsolidationCheck: async () => { log.push("check"); return why; } }, cmd: async (c) => { log.push("cmd " + c); } };
    const fn = new Function(...Object.keys(ctx), body + "; return consolidateToken;")(...Object.values(ctx));
    assert.equal(await fn(MXUSD, "MxUSD"), want.length === 3 && want[2].startsWith("cmd")); assert.deepEqual(log, want);
  }
});

// ---- create a pool (four steps) and migrate ----
const newCreate = async (answers, confirm, fn) => { const r = recorder(Object.assign({ ppWhy: null, ppMarketToken: { usdt: MXUSD } }, answers)), u = ui(confirm); const o = await PP.Act.createOpen(r.api, async (c) => (c === "balance" ? BAL : null)); const res = o.none ? null : await fn(r.api, u, o); return { calls: r.money(), said: u.said, o, res }; };
for (const c of [{ name: "1.90 MxUSD at the market price", u: "1.90" }, { name: "more MxUSD than the wallet holds", u: "301" }, { name: "more than the MINIMA covers", u: "20" , bal: "100" }, { name: "nothing typed", u: "" }, { name: "letters", u: "1.9o" }]) for (const confirm of [true, false]) {
  test(`create, priced, ${c.name}, ${confirm ? "confirmed" : "closed at the question"}: the same calls with the same arguments as the old panel`, async () => {
    const answers = { ppCreateAnchor: { price: "0.0032", source: "MEXC market" }, ppCreate: { txpowid: PK("75") }, ppSaveBackup: { canceled: true } };
    const o = await oldMylp(answers, confirm);
    const was = await o.press(async () => { await o.p.el("ppCreateBtn").onclick(); await o.p.settle(); o.p.el("ppcU").value = c.u; return o.p.el("ppcGo").onclick(); });
    const now = await newCreate(answers, confirm, (api, u, op) => PP.Act.createPriced(api, u, op.t, op.minimaAvail, op.anchor.price, op.anchor.source, c.u));
    assert.deepEqual(now.calls, was);
    const sent = c.u === "1.90" && confirm;
    assert.deepEqual(now.calls, sent ? [["ppCreateAnchor", []], ["ppCreate", [MXUSD, 8, "593.75", "1.90"]]] : [["ppCreateAnchor", []]], sent ? "MINIMA derived from the price, rounded up to the 6-decimal grain as before; the amount as typed" : "nothing is created");
  });
}
for (const c of [{ name: "both amounts and the box ticked", x: "100", y: "0.56", ack: true }, { name: "the box not ticked", x: "100", y: "0.56", ack: false }, { name: "one amount missing", x: "100", y: "", ack: true }]) for (const confirm of [true, false]) {
  test(`create, no market price, ${c.name}, ${confirm ? "confirmed" : "closed at the question"}: the same calls with the same arguments as the old panel`, async () => {
    const answers = { ppCreateAnchor: null, ppCreatePreview: { ok: true, price: "0.0056", kmin: "56" }, ppCreate: { txpowid: PK("75") }, ppSaveBackup: { canceled: true } };
    const o = await oldMylp(answers, confirm);
    const was = await o.press(async () => { await o.p.el("ppCreateBtn").onclick(); await o.p.settle(); o.p.el("ppcX").value = c.x; o.p.el("ppcY").value = c.y; o.p.el("ppcAck").checked = c.ack; return o.p.el("ppcGo").onclick(); });
    const now = await newCreate(answers, confirm, (api, u, op) => { assert.equal(op.anchor, null); return PP.Act.createManual(api, u, op.t, c.x, c.y, c.ack); });
    assert.deepEqual(now.calls, was);
    const ok = c.ack && c.y;
    assert.deepEqual(now.calls, !ok ? [["ppCreateAnchor", []]] : [["ppCreateAnchor", []], ["ppCreatePreview", [8, "100", "0.56"]]].concat(confirm ? [["ppCreate", [MXUSD, 8, "100", "0.56"]]] : []));
  });
}
test("create: without MxUSD nothing is asked of the engine beyond the old panel's reads; the engine's backup rule and a key that was not made are said in plain words", async () => {
  const noUsd = recorder({ ppMarketToken: { usdt: MXUSD } }), o = await PP.Act.createOpen(noUsd.api, async () => [{ tokenid: "0x00", sendable: "5000" }, { tokenid: MXUSD, sendable: "0" }, { tokenid: PK("EE"), sendable: "9", token: { name: { name: "USDT" } } }]);
  assert.deepEqual(o, { none: true }, "a token that only calls itself USDT cannot be pooled as MxUSD"); assert.deepEqual(noUsd.money(), []);
  for (const [msg, re] of [["BACKUP_REQUIRED: save and verify the encrypted pool + node backup before creating another pool.", /^Creating the pool was not done and no funds moved\. Before another pool can be created/], ["could not mint an owner key (grant this app write access to create pools)", /^Creating the pool was not done and no funds moved: the node did not make the new key/]]) {
    const n = await newCreate({ ppCreateAnchor: { price: "0.0032", source: "MEXC market" }, ppCreate: new Error("Error invoking remote method 'mcd:ppCreate': Error: " + msg) }, true, (api, u, op) => PP.Act.createPriced(api, u, op.t, op.minimaAvail, op.anchor.price, op.anchor.source, "1.90"));
    assert.match(n.said[n.said.length - 1][0], re); assert.equal(n.said[n.said.length - 1][1], "error"); assert.match(n.res.err, /BACKUP_REQUIRED|mint/);
  }
  const ok = await newCreate({ ppCreateAnchor: { price: "0.0032", source: "MEXC market" }, ppCreate: { txpowid: PK("75") } }, true, (api, u, op) => PP.Act.createPriced(api, u, op.t, op.minimaAvail, op.anchor.price, op.anchor.source, "1.90"));
  assert.match(ok.said[ok.said.length - 1][0], /^Pool submitted: 593\.75 MINIMA \+ 1\.90 MxUSD\..*do not submit it again\. Now save the backup\.$/);
});
test("create is four steps, and the fourth is the forced backup; the old panel opened the same backup after a create and after a migrate", () => {
  assert.deepEqual(PP.STEPS, ["Before you start", "Amounts", "Review", "Back up"]);
  const pp = src("dexicon-pp.js"), old = src("pools.js");
  assert.match(old, /await api\.ppCreate\(t\.tokenid, t\.dec, String\(minima\), uStr\); prog\.close\(\); toast\("Pool created ✓", "ok"\); renderPandapools\(\); showPpBackup\(\);/);
  assert.match(old, /await api\.ppMigrate\(addr, a, b\); prog\.close\(\); toast\("Migrated ✓", "ok"\); renderPandapools\(\); showPpBackup\(\);/);
  assert.match(pp, /c\.step = 4; paint\(\);\n\s+await backupDialog\(true\); leaveCreate\(\);/, "after a create that was sent: step 4, the backup");
  assert.match(pp, /if \(r && !r\.err\) await backupDialog\(true\);/, "after a migrate that was sent: the backup");
  assert.match(pp, /c\.step = \/BACKUP_REQUIRED\/\.test\(\(r && r\.err\) \|\| ""\) \? 1 : 2; if \(c\.step === 1\) S\.backupDue = true;/, "the engine's refusal sends the flow back to the owed backup, never past it");
  assert.match(pp, /if \(!\$\("ppcAck1"\) \|\| !\$\("ppcAck1"\)\.checked\) return say\(/, "step 1 is acknowledged before the amounts");
  assert.equal(PP.derive(1.9, 0.0032), 593.75); assert.equal(PP.derive(1, 3), 0.333334, "up to the grain, as the engine's create rule");
  const info = PP.createInfo({ name: "MxUSD", avail: 300.5 }, 100, "0.0032", "MEXC market", "20");
  assert.equal(info.ok, false); assert.ok(info.lines.some((l) => /^⚠ Not enough MINIMA: reduce MxUSD to 0\.32 or less\.$/.test(l)));
  assert.equal(PP.createInfo({ name: "MxUSD", avail: 300.5 }, 5000, "0.0032", "MEXC market", "1.90").ok, true);
});
for (const c of [{ name: "both reserves", a: "50000", b: "160" }, { name: "one missing", a: "50000", b: "" }, { name: "zero", a: "0", b: "160" }]) for (const confirm of [true, false]) {
  test(`migrate, ${c.name}, ${confirm ? "confirmed" : "closed at the question"}: the same calls with the same arguments as the old panel`, async () => {
    const answers = { ppMigrate: { txpowid: PK("76") }, ppSaveBackup: { canceled: true } }, o = await oldMylp(answers, confirm);
    const was = await o.press(() => { o.p.btn.ppmig.onclick(); o.p.el("pp2A").value = c.a; o.p.el("pp2B").value = c.b; return o.p.el("pp2Go").onclick(); });
    const r = recorder(Object.assign({ ppWhy: null }, answers)), u = ui(confirm); await PP.Act.migrate(r.api, u, MINE, c.a, c.b);
    assert.deepEqual(r.money(), was);
    assert.deepEqual(r.money(), c.name === "both reserves" && confirm ? [["ppMigrate", [MINE.address, "50000", "160"]]] : []);
  });
}

// ---- backup, restore, recovery ----
const PASS = "correct horse battery staple";
test("backup: the old panel's password rule, then ppSaveBackup(password) and nothing else", async () => {
  for (const [p1, p2] of [[PASS, PASS], ["short", "short"], [PASS, PASS + "x"], ["", ""], ["x".repeat(1025), "x".repeat(1025)], ["ééééééééééé", "ééééééééééé"], ["éééééééééééé", "éééééééééééé"]]) {
    const o = await oldMylp({ ppSaveBackup: { canceled: false, path: "/tmp/b.ppbackup" } }, true);
    const was = await o.press(async () => { await o.p.el("ppBackupBtn").onclick(); o.p.el("ppbPass").value = p1; o.p.el("ppbAgain").value = p2; return o.p.el("ppbSave").onclick(); });
    const r = recorder({ ppSaveBackup: { canceled: false, path: "/tmp/b.ppbackup" } }), res = await PP.Act.backup(r.api, p1, p2);
    assert.deepEqual(r.money(), was, JSON.stringify([p1.length, p2.length]));
    assert.equal(!!res.bad, !was.length, "refused exactly when the old panel refused");
    if (was.length) assert.deepEqual(was, [["ppSaveBackup", [p1]]]);
  }
  const cancelled = await PP.Act.backup(recorder({ ppSaveBackup: { canceled: true } }).api, PASS, PASS);
  assert.match(cancelled.bad, /^Save cancelled\. No file was written, and the backup is still required\.$/);
  const failed = await PP.Act.backup(recorder({ ppSaveBackup: new Error("Error invoking remote method 'mcd:ppSaveBackup': Error: BACKUP_NOT_VERIFIED: saved bytes differ. Choose another location.") }).api, PASS, PASS);
  assert.match(failed.bad, /^The backup was not saved: The file that was written is not the same/); assert.ok(!/BACKUP_NOT_VERIFIED|mcd:/.test(failed.bad));
  assert.equal(PP.plainCode("MODE_UNAVAILABLE: Cannot verify node permission and wallet lock state. Retry when the node is ready."), "Cannot verify node permission and wallet lock state. Retry when the node is ready.");
  assert.equal(PP.plainCode("BACKUP_TOO_LARGE"), "That file is too large to be a PandaPools backup. Nothing was read from it.");
});
test("restore: Load file, Extract node backup and Restore make the old panel's calls with the same arguments", async () => {
  const json = '{"pandapools_backup":3,"pools":[]}', answers = { ppLoadBackup: (pw, node) => (node ? { canceled: false, nodePassword: "np", path: "/tmp/n.bak" } : { canceled: false, json }), ppRestore: { restored: 1, total: 2, details: ["a 3 USDT", "b"], warn: "w" } };
  const o = await oldMylp(answers, true);
  const was = await o.press(async () => { await o.p.el("ppRestoreBtn").onclick(); o.p.el("pprPass").value = PASS; await o.p.el("pprFile").onclick(); await o.p.el("pprGo").onclick(); o.p.el("pprPass").value = PASS; await o.p.el("pprNode").onclick(); });
  const r = recorder(answers), f = await PP.Act.loadFile(r.api, PASS), res = await PP.Act.restore(r.api, f.json), node = await PP.Act.extractNode(r.api, PASS);
  assert.deepEqual(r.money(), was);
  assert.deepEqual(was, [["ppLoadBackup", [PASS]], ["ppRestore", [json]], ["ppLoadBackup", [PASS, true]]]);
  assert.equal(res.text, "Verified reserves for 1 of 2 pools.\na 3 MxUSD\n\nb\nw"); assert.equal(res.all, false);
  assert.deepEqual(node, { nodePassword: "np", path: "/tmp/n.bak" });
  const none = recorder({}); assert.match((await PP.Act.restore(none.api, "  ")).bad, /^Paste a backup, or load a file\. Nothing was restored\.$/); assert.deepEqual(none.log, [], "nothing typed asks the engine nothing");
  assert.equal(await PP.Act.loadFile(recorder({ ppLoadBackup: { canceled: true } }).api, ""), null);
  assert.match((await PP.Act.loadFile(recorder({ ppLoadBackup: new Error("This is a legacy pool-only file; no node backup is included.") }).api, "")).bad, /Nothing was restored\.$/);
});
test("recovery archive: read with no argument, saved with the address as typed, as the old panel; a refusal says nothing was saved", async () => {
  const answers = { ppArchiveSettings: (url) => (url === undefined ? "https://old.example" : true) }, o = await oldMylp(answers, true);
  const was = await o.press(async () => { await o.p.el("ppArchiveBtn").onclick(); o.p.el("ppaUrl").value = "https://archive.example"; return o.p.el("ppaSave").onclick(); });
  const r = recorder(answers); assert.equal(await PP.Act.archiveGet(r.api), "https://old.example"); assert.deepEqual(await PP.Act.archiveSave(r.api, "https://archive.example"), {});
  assert.deepEqual(r.money(), was); assert.deepEqual(was, [["ppArchiveSettings", []], ["ppArchiveSettings", ["https://archive.example"]]]);
  assert.match((await PP.Act.archiveSave(recorder({ ppArchiveSettings: false }).api, "http://x")).bad, /^Not saved\. Use a public HTTPS hostname/);
});
test("the backup-required rule is the engine's: the screen reads it, says it, and never works around it", () => {
  const pp = src("dexicon-pp.js");
  assert.match(pp, /want\.backupDue = \(\) => api\(\)\.ppCompleteBackupRequired\(\)\.catch\(\(\) => true\)/, "a read that fails counts as due, as in the old panel");
  assert.match(pp, /Complete encrypted backup required/); assert.match(pp, /p1\.value = p2\.value = ""/, "the typed password leaves the fields before the save starts");
  assert.ok(!/localStorage[^;]*pass/i.test(pp), "no password is kept");
});

// ---- Pools ----
test("Pools: every pool with its address whole, the depth added exactly, and the combined view from the engine's own aggregates", async () => {
  const pools = [POOL, Object.assign({}, POOL, { address: PK("B2"), reserveM: "0.000000000001", reserveT: "3" }), { address: PK("B3"), tok: PK("EE"), tokName: "USDT", reserveM: "10", reserveT: "5", spot: "0.5", feeGrowthPct: "0" }];
  assert.equal(PP.poolsSummary(pools), "3 pools · 40010.000000000001 MINIMA aggregate depth"); assert.equal(PP.poolsSummary([POOL]), "1 pool · 40000 MINIMA aggregate depth"); assert.equal(PP.poolsSummary([]), "no active pools");
  const card = PP.poolCard(POOL);
  assert.equal(card.title, "MINIMA / MxUSD"); assert.deepEqual(card.rows.map((r) => r[0]), ["reserves", "spot price", "fees accrued (K/KMIN−1)", "pool"]);
  assert.deepEqual(card.rows[3], ["pool", PK("B1") + "  (click to copy)", PK("B1")], "the address whole on the screen, and whole on the clipboard");
  const other = PP.poolCard(pools[2]);
  assert.equal(other.title, "MINIMA / USDT (not MxUSD)  ·  token " + PK("EE")); assert.deepEqual(other.rows[3], ["token", PK("EE"), PK("EE")], "another token's id is shown whole");
  const comb = PP.combinedCard({ tok: MXUSD, name: "USDT", count: 2, totalMinima: "866751.25", totalToken: "2783.56526575", price: "0.003211499999", depth: "866751.25" });
  assert.equal(comb.title, "MINIMA / MxUSD  ·  combined"); assert.deepEqual(comb.rows.map((r) => r[1]), ["2", "866751.25 MINIMA  ·  2783.56526575 MxUSD", "0.00321149 MxUSD / MINIMA", "866751.25 MINIMA"]);
  // the old panel's Pools tab makes reads only (ppPools, and ppAggregate for Combined): nothing there to carry over as a money call
  const r = recorder(Object.assign({}, BASE, { ppAggregate: [] })), p = oldPanel(r.api, true);
  p.P._setView("pools"); await p.P.render(); await p.settle();
  assert.deepEqual(r.money(), []); assert.deepEqual(r.log.map((x) => x[0]), ["ppPools"]);
  const pp = src("dexicon-pp.js");
  assert.match(pp, /if \(tab === "pools" && S\.combined\) want\.agg = \(\) => api\(\)\.ppAggregate\(\)/); assert.match(pp, /await api\(\)\.ppScan\(\)/);
});

// ---- the room ----
test("the room: PandaPools' five tabs in its order, each remembered; the old panel stays in the tree and is no longer drawn", () => {
  assert.deepEqual(C.ROOMS[1].tabs, ["swap", "pools", "mylp", "wallet", "activity"]);
  const mem = C.load(""); C.pickRoom(mem, 1); assert.equal(C.tabOf(mem), "swap");
  C.pickTab(mem, "mylp"); C.pickRoom(mem, 2); C.pickRoom(mem, 1); assert.equal(C.tabOf(mem), "mylp", "the room remembers its tab");
  assert.equal(C.tabOf(C.load(C.save(mem)) && C.pickRoom(C.load(C.save(mem)), 1)), "mylp");
  const html = src("index.html"), app = src("app.js");
  assert.match(html, /<div class="dxapp" id="dxPpBody"><\/div>/); assert.match(html, /<div class="ppapp" id="ppBody" hidden><\/div>/);
  assert.ok(html.indexOf('src="dexicon-core.js"') < html.indexOf('src="dexicon-pp.js"') && html.indexOf('src="dexicon-pp.js"') < html.indexOf('src="dexicon-ui.js"'));
  assert.ok(fs.existsSync(path.join(R, "pools.js")) && app.includes("PoolsPanel.init({"), "kept until the 3e parity audit");
  assert.ok(!/renderActive[\s\S]{0,2500}renderPandapools\(\)/.test(app.slice(app.indexOf("function renderActive"))), "nothing draws the old panel");
  assert.match(app, /function onPandapoolsUpdate\(\) \{ DexPools\.onUpdate\(\); \}/);
  for (const f of ["pools.js", "pools.css", "poolcalc.js"]) assert.ok(fs.existsSync(path.join(R, f)), f + " is untouched in the tree");
});

// ---- the glue: read-only additions ----
async function glue(dir0) {
  const actualSql = require(path.join(ROOT, "main/pandapools/sqlshim")), loader = require(path.join(ROOT, "main/pandapools/loader"));
  const dir = dir0 || fs.mkdtempSync(path.join(os.tmpdir(), "pp-room-")), contexts = [], stores = [], exports = {}, answers = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Date, require: (n) => {
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./restore") return require(path.join(ROOT, "main/restore.js"));
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("a real rpcCall in a test"); } }; if (n === "./netfetch") return { fetchJson: async () => { throw new Error("a real fetch in a test"); } };
    if (n === "./pandapools/loader") return Object.assign({}, loader, { createContext: (...a) => { const c = loader.createContext(...a); contexts.push(c); return c; } });
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner(async (q) => { const verb = q.split(" ")[0]; if (verb in answers) { if (answers[verb] instanceof Error) throw answers[verb]; return answers[verb]; } return q === "block" ? { status: true, response: { block: 0 } } : { status: false }; });
  return { api, dir, contexts, answers, close: () => { api.stopLoop(); for (const c of contexts) c.ActivityChain.stop(); for (const sql of stores) { try { sql.flush(); sql._db.close(); } catch (e) {} } if (!dir0) fs.rmSync(dir, { recursive: true, force: true }); } };
}
test("the glue says whether the engine has started, and keeps the node's last refusal by command name only", async () => {
  const h = await glue();
  try {
    assert.equal(h.api.status().ready, false, "not started: the screens say so instead of looking idle");
    assert.equal(h.api.lastNodeFailure(), null);
    await h.api.init(); assert.equal(h.api.status().ready, true);
    const c = h.contexts.at(-1);
    h.answers.coins = { status: false, error: "No keys found for the coin's address" };
    await new Promise((r) => c.MDS.cmd("coins coinid:secret-id address:0xABCDEF", r));
    const f = h.api.lastNodeFailure();
    assert.equal(f.verb, "coins"); assert.equal(f.error, "No keys found for the coin's address"); assert.ok(!JSON.stringify(f).includes("secret-id"), "never the command's arguments");
    h.answers.txpow = new Error("socket hang up");
    await new Promise((r) => c.MDS.cmd("txpow txpowid:0x00", r));
    assert.equal(h.api.lastNodeFailure().verb, "txpow"); assert.equal(h.api.lastNodeFailure().error, "socket hang up");
    h.answers.balance = { status: true, response: [] };
    await new Promise((r) => c.MDS.cmd("balance", r));
    assert.equal(h.api.lastNodeFailure().verb, "txpow", "a command that worked changes nothing");
  } finally { h.close(); }
});

// ---- Activity, and pool operations in the shared screens, the Shutdown warning and the restore gate ----
test("Activity: every pool operation with its state, its transaction id whole, the time, and a failure in plain words", () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0);
  const ok = PP.actItem({ type: "SWAP", summary: "Sold 3000 MINIMA for 10.01511937 MxUSD", txpowid: PK("71"), ts: Date.UTC(2026, 10, 17, 10, 13, 13), timeLabel: "Transaction", statusText: "3723 confirmations · on-chain", confirmed: true, failed: false, verifiedAt: now - 5000 }, now);
  assert.deepEqual(ok, { title: "Swap", chip: "3723 confirmations · on-chain", tone: "ok", summary: "Sold 3000 MINIMA for 10.01511937 MxUSD", lines: ["Transaction 17 Nov 2026 10:13:13 GMT", "Checked just now"], ids: [["transaction", PK("71")]], done: true });
  const wait = PP.actItem({ type: "CREATE", summary: "x", txpowid: PK("72"), originalTxpowid: PK("73"), ts: now - 60000, statusText: "Confirming 1/3", confirmed: false, failed: false }, now);
  assert.equal(wait.tone, "live"); assert.equal(wait.done, false); assert.deepEqual(wait.ids, [["transaction", PK("72")], ["original submission", PK("73")]]); assert.equal(wait.lines[0], "Submitted 19 Nov 2026 11:59:00 GMT");
  const bad = PP.actItem({ type: "ADD", summary: "Add to MINIMA / USDT", txpowid: "", ts: 0, failed: true, failMsg: "Could not identify the input signing key." }, now);
  assert.equal(bad.chip, "FAILED"); assert.equal(bad.lines[0], "Submitted Time unknown"); assert.match(bad.lines[1], /^This was not done and nothing was signed/); assert.equal(bad.done, true);
  assert.equal(PP.actItem({ type: "Pool transaction", summary: "+1 MINIMA", ts: 1 }, now).title, "Pool transaction");
  assert.equal(PP.swapSummary({ type: "SWAP", summary: "Bought 12 for 3000" }), "Sold 3000 MINIMA for 12", "an old row is said from MINIMA's side, as the old panel did");
  assert.equal(PP.swapSummary({ type: "SWAP", summary: "Sold 3000 for 12" }), "Bought 3000 MINIMA for 12");
  assert.equal(PP.since(now - 59000, now), "just now"); assert.equal(PP.since(now - 3 * 3600000 - 5, now), "3h ago");
  const f = PP.feedItem({ pool: PK("B1"), kind: "SWAP", minimaIn: true, minimaAmt: "1200.0", tokenAmt: "3.84020", tokenLabel: "MxUSD", txpowid: PK("74"), ts: now, statusText: "12 confirmations · on-chain", confirmed: true, verifiedAt: now }, now);
  assert.equal(f.title, "MINIMA sale · 1200 MINIMA / 3.8402 MxUSD"); assert.deepEqual(f.ids, [["pool", PK("B1")], ["transaction", PK("74")]]);
  assert.match(PP.feedItem({ pool: PK("B1"), kind: "SWAP", minimaAmt: "40", tokenAmt: "0.128", tokenLabel: "USDT", ts: now, observed: true }, now).title, /observation \(unverified\)/);
  const pp = src("dexicon-pp.js"), ui_ = src("dexicon-ui.js");
  assert.match(ui_, /DexAx\.part\("activity", X\.asub\) \+ \(X\.asub === 0 \? DexPools\.part\("activity"\) : ""\)/, "pool operations are in the shared Activity");
  assert.match(ui_, /DexAx\.part\("history"\) \+ DexPools\.part\("history"\)/, "and the finished ones in History");
  assert.match(pp, /PandaPools has not started yet, so your pool operations could not be checked/, "an engine that has not started is said, not shown as nothing");
});
test("the Shutdown warning and the restore gate count pool operations truthfully: 'could not be checked' when the engine has not started", async () => {
  const first = await glue();
  try {
    assert.deepEqual(await first.api.activeWork(), [], "a data folder that never had a pool store: nothing can be waiting");
    await first.api.init(); assert.ok(Array.isArray(await first.api.activeWork()), "started: its own activity rows");
    first.api.flush();
    const second = await glue(first.dir);
    try { assert.equal(await second.api.activeWork(), null, "a store, and an engine that has not started: could not be checked"); assert.deepEqual(await second.api.activity(), [], "activity() itself would have looked idle"); } finally { second.close(); }
  } finally { first.close(); }
  const restore = require("../main/restore.js"), ax = { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 };
  assert.ok(restore.activeWorkList({ atomix: ax, pools: null }).some((l) => /^PandaPools could not be asked whether a pool transaction is still waiting/.test(l)));
  const list = restore.activeWorkList({ atomix: ax, pools: [{ type: "SWAP", txpowid: PK("71"), confirmed: false, failed: false }, { type: "SWAP", txpowid: PK("72"), confirmed: true }] });
  assert.ok(list.some((l) => l.includes("1 PandaPools transaction still waiting to confirm: " + PK("71"))), "the id whole");
  const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8"), app = src("app.js");
  assert.match(main, /pools: await pandapools\.activeWork\(\)\.catch\(\(\) => null\)/); assert.match(main, /ipcMain\.handle\("mcd:ppWork", \(\) => pandapools\.activeWork\(\)\.catch\(\(\) => null\)\)/);
  assert.match(app, /read\(api\.axMakerCfg\(\)\), read\(api\.ppWork\(\)\), read\(api\.dxWork\(\)\)/);
  // the Shutdown warning itself, lifted from app.js: null = could not be checked; a recent unconfirmed row is counted
  const sw = new Function(/const SWAP_DONE = [^\n]*\n/.exec(app)[0] + /function shutdownWarning\(swaps, maker, pool, nowMs, dex\) \{[\s\S]*?\n\}/.exec(app)[0] + "; return shutdownWarning;")();
  assert.match(sw([], { cfg: {}, state: {} }, null, Date.now(), { ready: true, takes: 0 }).message, /Could not be checked: pool operations\./);
  assert.match(sw([], { cfg: {}, state: {} }, [{ type: "SWAP", confirmed: false, failed: false, ts: Date.now() - 1000 }], Date.now(), { ready: true, takes: 0 }).message, /^1 pool transaction sent in the last hour is not confirmed yet/);
  assert.equal(sw([], { cfg: {}, state: {} }, [], Date.now(), { ready: true, takes: 0 }).title, "Shut down the node?");
});

// ---- 0.18.137: the wallet-restore gate and pools ----
const AXQ = { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, HINT = /If it stays like this, you can go on without this check\.$/;
test("a pool store that cannot be opened: the error is carried and said, the restore gate names it and can be passed by a confirm, and the file is moved aside, never deleted", async () => {
  const restore = require("../main/restore.js"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-bad-")), file = path.join(dir, "pandapools.sqlite"), junk = Buffer.from("this is not a database ".repeat(64));
  fs.writeFileSync(file, junk);
  const h = await glue(dir);
  try {
    await assert.rejects(h.api.init()); await assert.rejects(h.api.init(), "and again on every start");
    const st = h.api.status();
    assert.equal(st.ready, false); assert.ok(st.error && st.error.length > 3, "status() carries why: " + st.error); assert.ok(st.waitedMs >= 0);
    assert.equal(await h.api.activeWork(), null); assert.equal(await h.api.ownPools(), null, "its own pools could not be read either");
    // the gate: named exactly, with the way on; before 0.18.137 this was 'wait a moment' for ever
    const list = restore.activeWorkList({ atomix: AXQ, pools: null, poolsState: st, ownPools: null });
    assert.equal(list.length, 1); assert.ok(list[0].startsWith("PandaPools could not open its pool store (" + st.error + "), so whether a pool transaction is still waiting, and which pools this wallet owns, cannot be checked. ")); assert.match(list[0], HINT);
    assert.equal(restore.onlyDexiconUnchecked(list), true); assert.deepEqual(restore.activeWorkList({ atomix: AXQ, pools: null, poolsState: st, skipDexicon: true }), [], "after the deliberate confirm");
    const warn = restore.skipWarning(list); assert.ok(warn.includes(st.error)); assert.match(warn, /kept beside the new one under a dated name\. Nothing is deleted\./); assert.match(warn, /Go on only if you have this wallet's 24 words\.$/);
    // an engine that merely has not started yet still says wait; after two minutes it may be passed
    assert.match(restore.activeWorkList({ atomix: AXQ, pools: null, poolsState: { error: "", waitedMs: 5000 } })[0], /^PandaPools could not be asked whether a pool transaction is still waiting\. Wait a moment and try again\.$/);
    assert.match(restore.activeWorkList({ atomix: AXQ, pools: null, poolsState: { error: "", waitedMs: 190000 } })[0], /^PandaPools has not finished starting after 3 minutes, so .* cannot be checked\. If it stays like this, you can go on without this check\.$/);
    // never a way round work that IS known
    assert.equal(restore.onlyDexiconUnchecked(restore.activeWorkList({ atomix: Object.assign({}, AXQ, { swaps: [PK("5A")] }), pools: null, poolsState: st })), false);
    // the room: the error in plain words with what to do, and the store set aside on request
    const said = C.storeError("PandaPools", "pool store", st.error, "Then restore your pools.");
    assert.ok(said.startsWith("PandaPools cannot start: its pool store could not be opened (")); assert.match(said, /quit the app and open it again/); assert.match(said, /kept under a dated name, never deleted/);
    const kept = h.api.setAsideStore();
    assert.match(kept, /pandapools\.sqlite-legacy-keys-\d{8}$/); assert.ok(fs.readFileSync(kept).equals(junk), "moved as it was"); assert.equal(fs.existsSync(file), false);
    await h.api.init(); assert.equal(h.api.status().ready, true); assert.equal(h.api.status().error, "");
    assert.throws(() => h.api.setAsideStore(), /is open, so nothing was moved/, "a store that opens is never moved");
    assert.deepEqual(await h.api.ownPools(), [], "started, no pools");
  } finally { h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  // a wallet replacement over a damaged store: moved aside by invalidate(), and the engine starts
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pp-bad2-")); fs.writeFileSync(path.join(dir2, "pandapools.sqlite"), junk);
  const h2 = await glue(dir2);
  try {
    await assert.rejects(h2.api.init()); await h2.api.invalidate();
    assert.equal(h2.api.status().ready, true); assert.equal(fs.readdirSync(dir2).filter((f) => /^pandapools\.sqlite-legacy-keys-\d{8}$/.test(f)).length, 1);
  } finally { h2.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
  const pp = src("dexicon-pp.js"), main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8"), app = src("app.js");
  assert.match(pp, /else if \(!S\.st\.ready && S\.st\.error\) out\.push\(/); assert.match(pp, /data-ppaside="1"/); assert.match(pp, /api\(\)\.engineSetAside\("pandapools"\)/);
  assert.match(main, /poolsState: pandapools\.status\(\), ownPools: await pandapools\.ownPools\(\)\.catch\(\(\) => null\)/); assert.match(main, /ipcMain\.handle\("mcd:engineSetAside"/); assert.match(main, /restore\.skipWarning\(await walletWork\(false\)\)/);
  assert.match(app, /unchecked = \/you can go on without this check\\\.\/\.test\(why\), pools = \/You can go on after confirming this\\\.\/\.test\(why\)/);
});
test("AtomiX's store gets the same treatment: an init that never succeeds is named, can be passed by a confirm, and the file is only ever moved aside", async () => {
  const restore = require("../main/restore.js"), atomix = require("../main/atomix"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-bad-")), file = path.join(dir, "atomix.sqlite"), junk = Buffer.from("not a swap database ".repeat(64));
  fs.writeFileSync(file, junk); atomix._setDataDir(dir); atomix._setRunner(async () => { throw new Error("a real rpcCall in a test"); });
  try {
    await assert.rejects(atomix.init());
    const st = atomix.status(), w = await atomix.activeWork();
    assert.equal(st.ready, false); assert.ok(st.error); assert.deepEqual([w.ready, w.hasStore, w.error], [false, true, st.error]);
    const list = restore.activeWorkList({ atomix: w, pools: [] });
    assert.equal(list.length, 1); assert.ok(list[0].startsWith("AtomiX could not open its swap store (" + st.error + "), so whether a swap is in flight")); assert.match(list[0], HINT);
    assert.equal(restore.onlyDexiconUnchecked(list), true); assert.deepEqual(restore.activeWorkList({ atomix: w, pools: [], skipDexicon: true }), []);
    assert.match(restore.activeWorkList({ atomix: { ready: false, hasStore: true, error: "", waitedMs: 1000 }, pools: [] })[0], /Wait a moment and try again\.$/, "the first two minutes: wait");
    assert.match(restore.activeWorkList({ atomix: { ready: false, hasStore: true, error: "", waitedMs: 121000 }, pools: [] })[0], /^AtomiX has not finished starting after 2 minutes.*you can go on without this check\.$/);
    assert.match(restore.activeWorkList({ atomix: null, pools: [] })[0], /Wait a moment and try again\.$/, "a read that failed once is not a dead end: still refused");
    const kept = atomix.setAsideStore();
    assert.match(kept, /atomix\.sqlite-legacy-keys-\d{8}$/); assert.ok(fs.readFileSync(kept).equals(junk)); assert.equal(fs.existsSync(file), false); assert.equal(atomix.status().error, "");
    assert.throws(() => atomix.setAsideStore(), /is open, so nothing was moved/, "only after a start that failed");
    assert.match(src("dexicon-ax.js"), /else if \(!S\.st\.ready && S\.st\.error\) out\.push\(/); assert.match(src("dexicon-ax.js"), /engineSetAside\("atomix"\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("a live pool of this wallet: the restore gate lists it whole with its reserves as a warning to confirm, and says a same-wallet restore changes nothing", async () => {
  const restore = require("../main/restore.js"), own = [{ address: PK("B1"), token: "MxUSD", reserveM: "40000", reserveT: "128.4" }, { address: PK("B9"), token: "MxUSD", reserveM: null, reserveT: null }];
  const list = restore.activeWorkList({ atomix: AXQ, pools: [], ownPools: own });
  assert.equal(list.length, 1, "before 0.18.137 a live pool was neither refused nor warned of");
  assert.ok(list[0].startsWith("2 PandaPools pools of this wallet are still open: " + PK("B1") + " (40000 MINIMA and 128.4 MxUSD), " + PK("B9") + " (its reserves are not visible to this node just now). "));
  assert.ok(list[0].includes("These pools belong to the wallet you are replacing. Their funds can only be withdrawn by that wallet. Close them first, or make sure you have its 24 words and a pool backup."));
  assert.ok(list[0].includes("If it is this same wallet (the same 24 words), nothing changes for your pools")); assert.ok(list[0].endsWith(restore.CONFIRM_HINT));
  assert.equal(restore.onlyDexiconUnchecked(list), true, "a warning: it can be confirmed"); assert.ok(restore.activeWorkProblem(list).includes(PK("B1")));
  const warn = restore.skipWarning(list); assert.ok(warn.includes(PK("B1")) && warn.includes(PK("B9")) && warn.includes(restore.OWN_POOLS_WARNING)); assert.ok(!warn.includes(restore.CONFIRM_HINT));
  assert.deepEqual(restore.activeWorkList({ atomix: AXQ, pools: [], ownPools: own, skipDexicon: true }), [], "confirmed: the restore goes on");
  assert.equal(restore.onlyDexiconUnchecked(restore.activeWorkList({ atomix: AXQ, pools: [{ txpowid: PK("71"), confirmed: false }], ownPools: own })), false, "a transaction still waiting is a refusal, pools or not");
  assert.deepEqual(restore.activeWorkList({ atomix: AXQ, pools: [], ownPools: [] }), [], "no pools: no scare"); assert.equal(restore.replacesWalletFromPhrase("megammrsync action:resync host:h:1"), false, "a chain resync of the same wallet does not pass the gate at all");
  // the glue's list: this wallet's saved pools that are not put away, by token id
  const h = await glue();
  try {
    assert.deepEqual(await h.api.ownPools(), [], "no store: none");
    await h.api.init(); const c = h.contexts.at(-1);
    await new Promise((r) => { c.Store.ownRecord({ address: PK("B1"), mxaddress: "", opk: PK("0B"), oadr: PK("0A"), tok: MXUSD, tokName: "USDT", tokDecimals: 8, kmin: "1", reserveM: c.PP.dec("40000"), reserveT: c.PP.dec("128.4") }); setTimeout(r, 50); });
    const mine = await h.api.ownPools();
    assert.deepEqual(JSON.parse(JSON.stringify(mine)), [{ address: PK("B1").toLowerCase(), token: "MxUSD", reserveM: null, reserveT: null }], "a saved pool the scan does not show is still listed, its reserves said to be unknown");
  } finally { h.close(); }
});

// ---- 0.18.138: the mediums ----
test("create: the opening price and the balances are read again at Review; a price that moved is shown old and new and must be reviewed again", async () => {
  const now = Date.UTC(2026, 10, 19, 12), had = { anchor: { price: "0.0032", source: "MEXC market", at: now - 3 * 3600000 } };
  const bal = async (c) => (c === "balance" ? BAL : null), read = (anchor) => recorder({ ppMarketToken: { usdt: MXUSD }, ppCreateAnchor: anchor });
  let r = read({ price: "0.0041", source: "MEXC market", at: now });
  const moved = await PP.Act.createRefresh(r.api, bal, had, now);
  assert.equal(moved.moved, true); assert.equal(moved.fresh.anchor.price, "0.0041", "what is reviewed next is the new read");
  assert.equal(moved.text, "The price changed since it was read 3h ago: it was 0.0032 MxUSD per MINIMA (MEXC market), it is now 0.0041 MxUSD per MINIMA (MEXC market). The MINIMA needed was worked out again at the new price. Check the figures and press Review again. Nothing was sent.");
  assert.deepEqual(r.log.map((x) => x[0]), ["ppMarketToken", "ppCreateAnchor"], "reads only: nothing is created by the refresh");
  const same = await PP.Act.createRefresh(read({ price: "0.00320", source: "MEXC market", at: now }).api, bal, had, now);
  assert.equal(same.moved, false, "the same price written another way is not a move"); assert.equal(same.fresh.minimaAvail, 5000, "the balances are fresh too");
  const src2 = await PP.Act.createRefresh(read({ price: "0.0032", source: "live pools" }).api, bal, had, now);
  assert.equal(src2.moved, true, "MEXC gone, the pools' own price in its place: never 'matches MEXC market' from the old read"); assert.match(src2.text, /it is now 0\.0032 MxUSD per MINIMA \(live pools\)/);
  const gone = await PP.Act.createRefresh(read(null).api, bal, had, now);
  assert.match(gone.bad, /could not be read again just now, so the opening price of 0\.0032 MxUSD per MINIMA \(MEXC market\), read 3h ago, cannot be checked\. Nothing was sent/);
  const appeared = await PP.Act.createRefresh(read({ price: "0.0033", source: "MEXC market" }).api, bal, { anchor: null }, now);
  assert.equal(appeared.moved, true); assert.match(appeared.text, /^A market price can be read now: 0\.0033 MxUSD per MINIMA \(MEXC market\)\. The pool opens at that price/);
  assert.equal((await PP.Act.createRefresh(read(null).api, bal, { anchor: null }, now)).moved, false, "still no market: the manual form goes on");
  assert.match((await PP.Act.createRefresh(read({ price: "0.0032", source: "MEXC market" }).api, async () => [{ tokenid: "0x00", sendable: "5" }], had, now)).bad, /no longer holds sendable MxUSD/);
  const pp = src("dexicon-pp.js"), go = pp.slice(pp.indexOf('if (what === "go") {'), pp.indexOf("async function migrateSheet"));
  assert.ok(go.indexOf("await Act.createRefresh(api(), D.tryCmd, c)") > 0 && go.indexOf("await Act.createRefresh(api(), D.tryCmd, c)") < go.indexOf("c.step = 3"), "read again before the review step");
  assert.ok(go.indexOf("if (f.moved)") < go.indexOf("Act.createPriced("), "a moved price returns to the form before any question");
  assert.match(fs.readFileSync(path.join(ROOT, "main/pandapools.js"), "utf8"), /return \{ price: fmtMid\(\), source: "MEXC market", at: mktAt \}/);
});
test("a glue call the engine never answers ends with 'no answer', so Dexicon's one gate cannot stay closed; read-only actions do not hold it; the coins dialog does not open under a money action", async () => {
  const h = await glue(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), ended = (p) => Promise.race([p.then(() => "answered", (e) => e.message), wait(1500).then(() => "STILL WAITING")]);
  try {
    await h.api.init(); const c = h.contexts.at(-1); h.api._setWaits({ statement: 40, recover: 40, retire: 40, confirm: 40 });
    c.Store.setRetired = () => {}; c.ReserveRecovery.confirmKey = () => {}; c.History.sync = () => {}; c.ReserveRecovery.configuredArchive = () => {};   // the engine drops every callback
    assert.equal(await ended(h.api.retirePool(PK("B1"), true)), h.api.NO_ANSWER); assert.equal(await ended(h.api.confirmSigning(PK("0B"), true)), h.api.NO_ANSWER);
    assert.match(h.api.NO_ANSWER, /^PandaPools gave no answer in time, so it is not known whether this was done\. Check Activity before trying again\.$/); assert.ok(!/fail/i.test(h.api.NO_ANSWER), "never 'failed'");
    assert.match(await ended(h.api.statement()), /gave no answer in time, so the statement was not built and no file was written/);
    const backup = JSON.stringify({ pandapools_backup: 3, pools: [] });
    assert.match(await ended(h.api.restore(backup)), /gave no answer in time, so it is not known which reserves were found\. Nothing was signed/);
    assert.match(await ended(h.api.restore(backup)), /gave no answer in time/, "and the next check is not refused as 'already running'");
  } finally { h.close(); }
  // the screen says those words as they are, never 'was not' or 'could not'
  for (const [fn, name] of [[(api, u) => PP.Act.retire(api, u, PK("B1")), "ppRetirePool"], [(api, u) => PP.Act.confirmSigning(api, u, PK("0B")), "ppConfirmSigning"], [(api, u) => PP.Act.recover(api, u, PK("B1")), "ppRecoverSaved"], [(api, u) => PP.Act.statement(api, u), "ppStatement"]]) {
    const msg = "PandaPools gave no answer in time, so it is not known whether this was done. Check Activity before trying again.";
    const r = recorder({ [name]: new Error("Error invoking remote method 'mcd:" + name + "': Error: " + msg) }), u = ui(true); u.show = async () => {};
    await fn(r.api, u); assert.equal(u.said.at(-1)[0], msg, name);
  }
  assert.equal(PP.noAnswer(new Error("Pool not found.")), "");
  const pp = src("dexicon-pp.js");
  assert.match(pp, /if \(ds\.pptool === "statement"\) return reading\(\(\) => Act\.statement\(api\(\), ui\)\)/, "the statement does not hold the money gate"); assert.match(pp, /if \(ds\.pprecover\) return reading\(async \(\) => \{/, "nor does a reserve check");
  assert.ok(!/const reading = [^\n]*D\.money/.test(pp)); assert.match(pp, /if \(ds\.ppbal != null\) \{ if \(C\.gate\.on\) return say\(GATE_BUSY, "note"\);/, "the coins dialog (Split, Consolidate) is not opened while a money action runs");
});

// ---- 0.18.139: the lows ----
test("a message never sends the reader to a menu entry that does not exist; a backup dialog closed while it works does not say 'not saved'", async () => {
  const h = await glue(), g = fs.readFileSync(path.join(ROOT, "main/pandapools.js"), "utf8"), pp = src("dexicon-pp.js");
  try {
    assert.ok(!/Open Pool recovery and confirm/.test(g.replace(/\/\/.*$/gm, "")), "the glue's own sentence names the button where it is");
    assert.match(g, /In My LP, on this pool's card, press Confirm wallet signing state/);
    // the engine's own (vendored) sentences, as they reach the consolidation refusal and the screens
    await h.api.init(); const c = h.contexts.at(-1);
    c.Store.ownAll = (cb) => cb([{ opk: PK("0B") }]); c.ReserveRecovery.classifyKeys = (keys, cb) => cb([{ message: "The hold still stands. Free some space and confirm it again in Pool recovery." }]);
    const refused = await h.api.consolidationCheck();
    assert.match(refused, /confirm it again with Confirm wallet signing state on the pool's card in My LP\.$/); assert.ok(!/in Pool recovery/.test(refused));
  } finally { h.close(); }
  const eng = fs.readFileSync(path.join(ROOT, "main/pandapools/reserve-recovery.js"), "utf8");
  assert.ok(/confirm it again in Pool recovery\./.test(eng) && /and confirm it in Pool recovery\./.test(eng), "the engine's sentences are as translated (vendored, not edited)");
  assert.equal(PP.whereConfirm("Restore the backup and confirm it in Pool recovery. A seed is NOT enough."), "Restore the backup and confirm it with Confirm wallet signing state on the pool's card in My LP. A seed is NOT enough.");
  assert.match(PP.failText("Closing the pool", "Owner signing is paused or its current key state could not be verified. Open Pool recovery and confirm the latest complete wallet signing state."), /In My LP, on the pool's card, press Confirm wallet signing state to confirm the latest/);
  assert.match(pp, /lpBtn\("Confirm wallet signing state", "ppconfirm", p\.opk\)/, "that button is on the pool's card"); assert.ok(!/\["confirm"|data-pick="confirm"/.test(pp), "and the Pool recovery menu has no such entry");
  // Esc or Close while "Create and save" is still working
  const closed = PP.backupEnd({ pending: true }, true);
  assert.match(closed.text, /^The backup dialog was closed while the backup was still being made, so it is not known yet whether it was saved\./); assert.ok(!/was not saved/.test(closed.text));
  assert.match(PP.backupEnd(null, true).text, /^The backup was not saved\./, "closed before anything was started: nothing was saved, and that is said"); assert.equal(PP.backupEnd(null, false), null);
  assert.match(PP.backupEnd({ path: "/x/y.ppbackup" }, true).text, /saved and checked.* Saved as \/x\/y\.ppbackup$/);
  assert.match(pp, /d\.addEventListener\("cancel", \(\) => \{ if \(gone\) return; gone = true; d\.remove\(\); resolve\(working \? \{ pending: true \} : null\); \}\);/, "Esc while the action works resolves 'pending', not 'nothing'");
  assert.match(pp, /if \(b\.dataset\.x === "0"\) return end\(working \? \{ pending: true \} : null\);/); assert.match(pp, /return !!got && !got\.pending;/);
});
