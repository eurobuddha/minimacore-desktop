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
function oldPanel(api, confirm) {
  const els = {}, said = [];
  const mk = (id) => ({ id, value: "", checked: false, textContent: "", innerHTML: "", innerText: "", disabled: false, dataset: {}, style: {}, scrollTop: 0, type: "",
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {}, appendChild() {}, contains: () => false, remove() {} });
  const el = (id) => els[id] || (els[id] = mk(id));
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, body: mk("body"), documentElement: mk("html"), createElement: () => mk("new"), activeElement: null };
  const ctx = vm.createContext({ window: null, document, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, console, Date, Math, Number, String, JSON, Promise, isFinite, parseFloat, parseInt, TextEncoder, Array,
    getComputedStyle: () => ({ getPropertyValue: () => "" }) });
  ctx.window = ctx;
  vm.runInContext(src("pools.js"), ctx, { filename: "pools.js" });
  const TOK = { shortId: (x) => x, tidyAmount: (x) => String(x), tokenName: (t, tid) => (t && t.name && t.name.name) || tid };
  ctx.PoolsPanel.init({ api, el, esc: (s) => String(s == null ? "" : s), toast: (m, k) => said.push([m, k || ""]), copy() {}, short: (x) => x, TOK, MINIMA: "0x00", PoolCalc: {},
    showConfirm: async (title, msg, ok) => { said.push(["confirm", title, ok]); return confirm; }, showProgress: () => ({ close() {} }),
    tryCmd: async (c) => (c === "balance" ? BAL : c === "block" ? { block: "2428089" } : null), running: () => true, activeView: () => "pandapools" });
  return { el, said, P: ctx.PoolsPanel, settle: () => new Promise((r) => setTimeout(r, 20)) };
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
  for (const re of [/\$\("axReview"\)\.onclick = \(\) => D\.money\(/, /\$\("mkSave"\)\.onclick = \(\) => D\.money\(/, /\$\("mkWithdraw"\)\.onclick = \(\) => D\.money\(/, /return D\.money\(async \(\) => \{\n\s+if \(S\.busy\) return;\n\s+S\.busy = what/,
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
  assert.equal(PP.tokLabel(PK("EE"), "USDT"), "USDT (another token, not MxUSD)"); assert.equal(PP.tokLabel(PK("EE"), "mxUSDT"), "mxUSDT (another token, not MxUSD)");
  assert.equal(PP.tokLabel(PK("EE"), ""), PK("EE"), "an unnamed token is its whole id");
  assert.equal(PP.mx("Sold 3000 MINIMA for 10.01 USDT"), "Sold 3000 MINIMA for 10.01 MxUSD"); assert.equal(PP.mx("12 mxUSDT"), "12 MxUSD");
  assert.deepEqual(PP.pairs([POOL, Object.assign({}, POOL, { address: PK("B2") })]), [T]);
  const pp = src("dexicon-pp.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/USDT\/MINIMA \(MEXC\)/g, "").replace(/usdt\?|m\?x\?USDT|not MxUSD/g, "");
  assert.ok(!/USDT/.test(pp), "the screens write MxUSD; USDT is only the MEXC market's unit");
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

// ---- Pools ----
test("Pools: every pool with its address whole, the depth added exactly, and the combined view from the engine's own aggregates", async () => {
  const pools = [POOL, Object.assign({}, POOL, { address: PK("B2"), reserveM: "0.000000000001", reserveT: "3" }), { address: PK("B3"), tok: PK("EE"), tokName: "USDT", reserveM: "10", reserveT: "5", spot: "0.5", feeGrowthPct: "0" }];
  assert.equal(PP.poolsSummary(pools), "3 pools · 40010.000000000001 MINIMA aggregate depth"); assert.equal(PP.poolsSummary([POOL]), "1 pool · 40000 MINIMA aggregate depth"); assert.equal(PP.poolsSummary([]), "no active pools");
  const card = PP.poolCard(POOL);
  assert.equal(card.title, "MINIMA / MxUSD"); assert.deepEqual(card.rows.map((r) => r[0]), ["reserves", "spot price", "fees accrued (K/KMIN−1)", "pool"]);
  assert.deepEqual(card.rows[3], ["pool", PK("B1") + "  (click to copy)", PK("B1")], "the address whole on the screen, and whole on the clipboard");
  const other = PP.poolCard(pools[2]);
  assert.equal(other.title, "MINIMA / USDT (another token, not MxUSD)"); assert.deepEqual(other.rows[3], ["token", PK("EE"), PK("EE")], "another token's id is shown whole");
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
async function glue() {
  const actualSql = require(path.join(ROOT, "main/pandapools/sqlshim")), loader = require(path.join(ROOT, "main/pandapools/loader"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-room-")), contexts = [], stores = [], exports = {}, answers = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Date, require: (n) => {
    if (n === "electron") return { app: { getPath: () => dir, getVersion: () => "test" } };
    if (n === "./config") return { rpcSecret: () => "" }; if (n === "./node-manager") return { rpcPort: () => 0 };
    if (n === "./rpc") return { rpcCall: async () => { throw new Error("a real rpcCall in a test"); } }; if (n === "./netfetch") return { fetchJson: async () => { throw new Error("a real fetch in a test"); } };
    if (n === "./pandapools/loader") return Object.assign({}, loader, { createContext: (...a) => { const c = loader.createContext(...a); contexts.push(c); return c; } });
    if (n === "./pandapools/sqlshim") return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "main/pandapools.js"), "utf8"), sandbox, { filename: "main/pandapools.js" });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner(async (q) => { const verb = q.split(" ")[0]; if (verb in answers) { if (answers[verb] instanceof Error) throw answers[verb]; return answers[verb]; } return q === "block" ? { status: true, response: { block: 0 } } : { status: false }; });
  return { api, dir, contexts, answers, close: () => { api.stopLoop(); for (const c of contexts) c.ActivityChain.stop(); for (const sql of stores) { try { sql.flush(); sql._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); } };
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
