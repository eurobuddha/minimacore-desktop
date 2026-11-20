// Minima Explorer (0.19.129): the reads it may send (main/explorer.js), how chain data is read for the screen
// (renderer/apps-act.js) and the list walker and pages (renderer/apps-tools.js), executed against a stand-in node.
// Nothing here reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const M = require("../main/explorer.js"), X = require("../renderer/apps-act.js").explorer;
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tools = R("renderer/apps-tools.js"), src = tools.slice(tools.indexOf("// ---- Minima Explorer"), tools.indexOf("// ---- Entropy") > 0 ? tools.indexOf("// ---- Entropy") : tools.length);
const ID = (n) => "0x" + String(n).padStart(64, "0"), ADDR = "0x" + "AB".repeat(32), MX = "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6";

test("the node is sent one of seven reads, each built in the main process from a checked value", async () => {
  assert.deepEqual(M.KINDS, ["tip", "status", "info", "block", "txpow", "onchain", "address"]);
  assert.equal(M.command("tip"), "block"); assert.equal(M.command("status", "anything"), "status"); assert.equal(M.command("info"), "txpow action:info");
  assert.equal(M.command("block", "2428092"), "txpow block:2428092"); assert.equal(M.command("txpow", ID(7)), "txpow txpowid:" + ID(7));
  assert.equal(M.command("onchain", ID(7)), "txpow onchain:" + ID(7)); assert.equal(M.command("address", ADDR), "txpow address:" + ADDR); assert.equal(M.command("address", MX), "txpow address:" + MX);
  for (const [kind, arg] of [["block", "12 relevant:true"], ["block", "12;quit"], ["block", "-1"], ["block", "0x10"], ["block", ""], ["block", 12], ["block", "1".repeat(16)], ["txpow", ID(7) + " action:delete"], ["txpow", "0x"], ["txpow", MX], ["txpow", ID(7) + ";send amount:1 address:0xFF"],
    ["address", "Mx short"], ["address", MX + "\n"], ["address", "0xZZ"], ["address", null], ["onchain", "abc"], ["send", "amount:1"], ["coins", ""], ["constructor", ""], ["__proto__", ""], ["cmd", "status"]])
    assert.equal(M.command(kind, arg), null, kind + " " + JSON.stringify(arg));
  const sent = []; const run = async (c) => { sent.push(c); return { status: true, response: { block: "5" } }; };
  await assert.rejects(M.ask("block", "1;quit", run), /Not a block number, a TxPoW ID or an address\./); await assert.rejects(M.ask("send", "x", run));
  assert.deepEqual(sent, [], "a refused read sends nothing");
  await M.ask("tip", undefined, run); assert.deepEqual(sent, ["block"]);
  const verbs = new Set(Object.keys({ block: 1, status: 1, txpow: 1 })); for (const k of M.KINDS) for (const a of ["1", ID(1), MX]) { const c = M.command(k, a); if (c) assert.ok(verbs.has(c.split(/[ :]/)[0]), c); }
  const mainJs = R("main/main.js");
  assert.ok(/ipcMain\.handle\("mcd:explorer", \(_e, kind, arg\) => \{ requireRunning\(\); return explorer\.ask\(kind, arg, \(c\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\)\); \}\);/.test(mainJs), "main: through rpcCall, nothing else");
  assert.ok(!/api\.cmd\(|\bcmd\(|tryCmd\(/.test(src), "the screen never uses the free command channel");
});

test("an address with any number of records is answered with at most 200 of them, and the total is said", async () => {
  const many = []; for (let i = 0; i < 950; i++) many.push({ txpowid: ID(i) });
  const cut = await M.ask("address", ADDR, async () => ({ status: true, response: many }));
  assert.equal(cut.response.length, 200); assert.equal(cut.total, 950); assert.equal(cut.response[199].txpowid, ID(199)); assert.equal(many.length, 950, "the node's reply is not changed in place");
  const few = await M.ask("address", ADDR, async () => ({ status: true, response: many.slice(0, 3) })); assert.equal(few.response.length, 3); assert.equal(few.total, undefined);
  const refused = { status: false, error: "x" }; assert.equal(await M.ask("address", ADDR, async () => refused), refused);
});

test("the search box: a number is a block, 0x hex is an id tried first and then an address, Mx is an address", () => {
  assert.deepEqual(X.classify(" 0012 "), { kind: "block", arg: "12" }); assert.deepEqual(X.classify("2428092"), { kind: "block", arg: "2428092" });
  assert.deepEqual(X.classify(ID(5)), { kind: "txpow", arg: ID(5) }); assert.deepEqual(X.classify(MX), { kind: "address", arg: MX });
  assert.equal(X.classify(""), null); assert.equal(X.classify("   "), null);
  for (const bad of ["hello", "12 34", "0x", "0xZZ", "Mx with space", "1".repeat(16), "12;quit", "-5", "1.5"]) assert.deepEqual(X.classify(bad), { kind: "bad" }, bad);
  for (const q of ["12", ID(5), MX]) { const c = X.classify(q); assert.ok(M.command(c.kind, c.arg), "what the screen accepts, the main process accepts: " + q); }
});

test("figures are the node's own digits: grouped or tidied as text, never made into a number", () => {
  assert.equal(X.groupNum("2428092"), "2,428,092"); assert.equal(X.groupNum(4093), "4,093"); assert.equal(X.groupNum("999"), "999"); assert.equal(X.groupNum("123456789012345678"), "123,456,789,012,345,678");
  for (const bad of [null, undefined, "", "12a", "-4", "1.5", {}, NaN]) assert.equal(X.groupNum(bad), "", String(bad));
  assert.equal(X.tidyAmount("10.500000"), "10.5"); assert.equal(X.tidyAmount("100"), "100"); assert.equal(X.tidyAmount("0.000"), "0"); assert.equal(X.tidyAmount(""), "0"); assert.equal(X.tidyAmount(null), "0");
  assert.equal(X.tidyAmount("123456789012345678901234567890.123456789012345678901234567890123456789012340"), "123456789012345678901234567890.12345678901234567890123456789012345678901234", "44 decimals survive");
  assert.equal(X.coinAmount({ tokenid: "0x00", amount: "1.50", tokenamount: "9" }), "1.5"); assert.equal(X.coinAmount({ tokenid: "0xAB", amount: "0.0000001", tokenamount: "12.250000" }), "12.25", "a token shows its own figure");
  assert.equal(X.coinAmount({ tokenid: "0xAB", amount: "0.5" }), "0.5"); assert.equal(X.coinAmount({}), "0");
  assert.equal(X.tokenName({ token: { name: { name: "Gold" } } }), "Gold"); assert.equal(X.tokenName({ token: { name: "Silver" } }), "Silver"); assert.equal(X.tokenName({ token: { name: "{\"name\":\"x\"}" } }), ""); assert.equal(X.tokenName({}), ""); assert.equal(X.tokenName({ token: { name: { name: 5 } } }), "");
  assert.equal(X.height({ header: { block: "2428092" } }), "2428092"); assert.equal(X.height({}), ""); assert.equal(X.timeMilli({ header: { timemilli: "1795096654000" } }), 1795096654000); assert.equal(X.timeMilli({ header: { timemilli: "soon" } }), 0);
  assert.equal(X.txCount({ body: { txnlist: ["a", "b"] }, istransaction: true }), 3); assert.equal(X.txCount({ body: { txnlist: [] } }), 0); assert.equal(X.txCount({}), 0);
  assert.equal(X.blockTime("0.019920318"), "50.2 s"); assert.equal(X.blockTime("0.02"), "50.0 s"); assert.equal(X.blockTime("0.0101"), "99.0 s", "cut, not rounded (99.0099)"); assert.equal(X.blockTime("0"), ""); assert.equal(X.blockTime(undefined), ""); assert.equal(X.blockTime("fast"), "");
  assert.equal(X.pageOf({ isblock: true }), "block"); assert.equal(X.pageOf({ isblock: "true" }), "txn"); assert.equal(X.pageOf({}), "txn");
  assert.deepEqual(X.onchain({ status: true, response: { found: true, block: "2428086", confirmations: "6" } }), { ok: true, text: "✓ on chain · block 2428086 · confirmations: 6" });
  for (const no of [null, { status: false }, { status: true, response: { found: false } }, { status: true, response: { found: "true", block: "1" } }]) assert.deepEqual(X.onchain(no), { ok: false, text: "not found on chain (mempool or pruned)" });
});

/** The screen's own code, run against a stand-in node (heights `floor` < h <= `tip` exist) and a stand-in page. */
function screen(o) {
  o = Object.assign({ tip: 100, floor: 0 }, o);
  const asked = [], els = {}, toasts = []; let inFlight = 0, most = 0;
  const node = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "", hidden: false, value: "", scrollTop: 0, dataset: {}, classList: { contains: () => false, toggle() {} }, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, focus() {} });
  const block = (h) => ({ txpowid: ID(h), isblock: true, istransaction: false, header: { block: String(h), timemilli: "1795096654000" }, body: { txnlist: h % 10 === 0 ? [ID(900000 + h)] : [] } });
  const api = { explorer: async (kind, arg) => {
    asked.push(kind + (arg == null ? "" : ":" + arg)); inFlight++; most = Math.max(most, inFlight); await new Promise(r => setImmediate(r)); inFlight--;
    if (o.fail) throw new Error("node not running");
    if (kind === "tip") return { status: true, response: { block: String(o.tip) } };
    if (kind === "status") return { status: true, response: { chain: { speed: "0.02" } } };
    if (kind === "info") return { status: true, response: { txpowdb: { size: 4093 } } };
    if (kind === "block") { const h = Number(arg); return h > o.floor && h <= o.tip ? { status: true, response: block(h) } : { status: false, error: "TxPoW not found @ height " + arg }; }
    if (kind === "txpow") return o.txpow ? o.txpow(arg) : { status: false, error: "TxPoW not found" };
    if (kind === "address") return o.address ? o.address(arg) : { status: true, response: [] };
    if (kind === "onchain") return { status: true, response: { found: true, block: "90", confirmations: "10" } };
    throw new Error("unknown read " + kind); } };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const env = { api, el: node, esc, toast: (m, k, c) => toasts.push([m, c]), running: true, AppsAct: { explorer: X }, store: () => null, histWhen: () => "now", nameWithId: (tid, n) => (n ? n + " (token " + tid + ")" : tid),
    document: { activeElement: null }, setTimeout: (f) => setImmediate(f), clearTimeout() {} };
  const names = ["explorerReset", "explorerRefresh", "explorerOlder", "explorerSearch", "explorerBlockAt", "explorerFind", "explorerTxn", "explorerAddress", "explorerPush", "explorerPaint", "explorerAct", "explorerTip", "exTokenLabel"];
  const fns = new Function(...Object.keys(env), src.replace(/^"use strict";$/mg, "") + "\nreturn { " + names.join(", ") + ", state: () => EX };")(...Object.values(env));
  node("exContent"); node("main"); node("exSearch"); node("explorerBody");
  const settle = async () => { for (let i = 0; i < 400; i++) await new Promise(r => setImmediate(r)); };
  return Object.assign(fns, { asked, els, toasts, settle, most: () => most, block, env, opts: o });
}

test("the list: the tip, then one page of 16 blocks, one read at a time, newest first; Load older reads the next 16", async () => {
  const s = screen({ tip: 100 }); await s.explorerRefresh(); await s.settle();
  const E = s.state();
  assert.deepEqual(E.blocks.map(b => b.header.block), Array.from({ length: 16 }, (_, i) => String(100 - i)));
  assert.deepEqual(s.asked.filter(a => a.startsWith("block:")), Array.from({ length: 16 }, (_, i) => "block:" + (100 - i)), "sixteen single-block reads, downwards");
  assert.deepEqual(s.asked.filter(a => !a.startsWith("block:")).sort(), ["info", "status", "tip"]);
  assert.equal(E.loading, false); assert.equal(E.end, false); assert.equal(E.lowest, 85); assert.equal(s.most(), 1 + 2, "block reads never overlap (only the two tile reads run beside one)");
  const before = s.asked.length; s.explorerOlder(); s.explorerOlder(); await s.settle();
  assert.equal(s.asked.length - before, 16, "a second click while loading starts nothing"); assert.equal(E.blocks.length, 32); assert.equal(E.blocks[31].header.block, "69");
  const list = s.els.exContent.innerHTML;
  assert.ok(list.includes("#100") && list.includes(ID(100)) && !/…/.test(list.replace("Load older blocks", "")), "every TxPoW id is whole in the list");
  assert.ok(list.includes('data-copy="' + ID(100) + '"'), "and one click copies it whole");
  assert.ok(list.includes("Transactions: 1") && list.includes("EMPTY") && list.includes("Load older blocks"));
  assert.ok(list.includes("2,4") === false && list.includes("50.0 s") && list.includes("4,093 txns") && list.includes("TIP HEIGHT"));
});

test("the list ends where the node's records end, and never reads below it again", async () => {
  const s = screen({ tip: 100, floor: 95 }); await s.explorerRefresh(); await s.settle();
  const E = s.state();
  assert.deepEqual(E.blocks.map(b => b.header.block), ["100", "99", "98", "97", "96"]); assert.equal(E.end, true); assert.equal(E.status, "end of retained chain");
  assert.deepEqual(s.asked.filter(a => a.startsWith("block:")), ["block:100", "block:99", "block:98", "block:97", "block:96", "block:95"]);
  const n = s.asked.length; s.explorerOlder(); await s.settle(); assert.equal(s.asked.length, n);
  assert.ok(s.els.exContent.innerHTML.includes("· end of retained chain ·") && !s.els.exContent.innerHTML.includes("Load older blocks"));
});

test("a new block: a small gap is read above the list in the right order; a large gap starts the list again", async () => {
  const s = screen({ tip: 100 }), o = s.opts; await s.explorerRefresh(); await s.settle();
  o.tip = 103; await s.explorerRefresh(); await s.settle();
  assert.deepEqual(s.state().blocks.slice(0, 5).map(b => b.header.block), ["103", "102", "101", "100", "99"]); assert.equal(s.state().blocks.length, 19);
  assert.deepEqual(s.asked.filter(a => a.startsWith("block:")).slice(-3), ["block:103", "block:102", "block:101"]);
  o.tip = 200; await s.explorerRefresh(); await s.settle();
  assert.deepEqual(s.state().blocks.map(b => b.header.block), Array.from({ length: 16 }, (_, i) => String(200 - i)));
  const n = s.asked.length; await s.explorerRefresh(); await s.settle(); assert.deepEqual(s.asked.slice(n).filter(a => a.startsWith("block:")), [], "the same tip reads no block");
});

test("a node that goes away: the walk is abandoned, nothing of the old chain is drawn into the new state", async () => {
  const s = screen({ tip: 100 }); const p = s.explorerRefresh();
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  s.explorerReset(); await p; await s.settle();
  assert.deepEqual(s.state().blocks, []); assert.equal(s.state().tip, "");
  const f = screen({ fail: true }); await f.explorerRefresh(); await f.settle();
  assert.equal(f.state().status, "node unreachable"); assert.ok(f.els.exContent.innerHTML.includes("node unreachable") && f.els.exContent.innerHTML.includes("Not read yet"), "no figure is shown that was not read");
});

test("search: a block by number, an id that is a transaction, an id that is an address; what is not found is said with the whole value", async () => {
  const txn = { txpowid: ID(7), isblock: false, istransaction: true, size: 900, burn: "0.010000", header: { block: "90", timemilli: "1795096654000" },
    body: { txn: { inputs: [{ amount: "10.50", tokenid: "0x00", miniaddress: MX }], outputs: [{ amount: "0.0000001", tokenamount: "3.250", tokenid: "0x7d39745fbd29049be29850b55a18bf550e4d442f930f86266e34193d89042a90", token: { name: "MxUSD" }, address: ADDR },
      { amount: "1", tokenamount: "7", tokenid: "0xBEEF", token: { name: { name: "<img src=x onerror=alert(1)>" } }, address: ADDR }], state: [{ port: 0, data: "<b>peer text</b>" }] } } };
  const s = screen({ tip: 100, txpow: (id) => (id === ID(7) ? { status: true, response: txn } : { status: false, error: "TxPoW not found" }), address: (a) => (a === ADDR ? { status: true, response: [txn, s.block(90)], total: 950 } : { status: true, response: [] }) });
  s.els.exSearch.value = "90"; await s.explorerSearch(); await s.settle();
  assert.ok(s.asked.includes("block:90")); assert.ok(s.els.exContent.innerHTML.includes("Block detail") && s.els.exContent.innerHTML.includes("#90") && s.els.exContent.innerHTML.includes(ID(900090)));
  s.els.exSearch.value = ID(7); await s.explorerSearch(); await s.settle();
  let h = s.els.exContent.innerHTML;
  assert.ok(h.includes("✓ on chain · block 90 · confirmations: 10") && s.asked.includes("onchain:" + ID(7)));
  assert.ok(h.includes("−10.5  MINIMA") && h.includes("+3.25  MxUSD") && h.includes(MX) && h.includes('data-copy="' + ADDR + '"'), "amounts as the node wrote them, MxUSD named by its id, addresses whole");
  assert.ok(h.includes("+7  &lt;img src=x onerror=alert(1)&gt; (token 0xBEEF)") && h.includes("&lt;b&gt;peer text&lt;/b&gt;") && !h.includes("<img") && !h.includes("<b>peer"), "a token's name and a state value are text, never markup");
  assert.ok(h.includes("0.01 MINIMA") && h.includes("900 bytes"));
  s.els.exSearch.value = ADDR; await s.explorerSearch(); await s.settle();
  assert.deepEqual(s.asked.slice(-2), ["txpow:" + ADDR, "address:" + ADDR], "the id is tried first, then the address");
  h = s.els.exContent.innerHTML; assert.ok(h.includes("TxPoW records on this node: 950 (the first 2 are listed)") && h.includes(">TXN<") && h.includes(">BLK<") && h.includes(ADDR));
  s.els.exSearch.value = ID(8); await s.explorerSearch(); await s.settle();
  assert.deepEqual(s.toasts.pop(), [ID(8) + " not found on this node", ID(8)], "the whole value, and a click on the message copies it");
  s.els.exSearch.value = "what"; await s.explorerSearch(); assert.equal(s.toasts.pop()[0], "Enter a block number, TxPoW ID or address");
  const n = s.asked.length; s.els.exSearch.value = "12;quit"; await s.explorerSearch(); assert.equal(s.asked.length, n, "nothing is sent for text that is not a number, an id or an address");
  assert.equal(s.state().pages.length, 3); s.explorerAct({ dataset: { ex: "back" } }); s.explorerAct({ dataset: { ex: "back" } }); s.explorerAct({ dataset: { ex: "back" } });
  assert.equal(s.state().pages.length, 0); assert.ok(s.els.exContent.innerHTML.includes("LATEST BLOCKS"), "Back pops to the list");
});

test("the screen: the original's wording and palette, its icon unchanged, keyboard reachable, nothing cut", () => {
  const css = R("renderer/apps.css"), part = css.slice(css.indexOf("/* ---- Minima Explorer"));
  for (const said of ["Minima Explorer", "Block № · TxPoW ID · 0x / Mx address", "Search", "TIP HEIGHT", "BLOCK TIME", "TXPOW DB", "LATEST BLOCKS", "Load older blocks  ▾", "‹ Back", "Block detail", "Superblock level", "Cascade levels", "Parent block", "TRANSACTIONS",
    "No transactions in this block", "⛏ carried in this TxPoW", "INPUTS", "OUTPUTS", "STATE VARIABLES", "View raw JSON  ▾", "Hide raw JSON  ▴", "confirmations: …", "loading…", "end of retained chain", "Is block"]) assert.ok(src.includes(said), said);
  for (const c of ["#0A0A0F", "#15151F", "#1F1F2B", "#F7931A", "#2A1E0E", "#9A9AA8", "#6A6A78", "#2A2A38", "#2ECC71", "#E74C3C", "#5B8DEF", "#F5F5F7", "#EDEDF2", "#E07E00", "#FDEBD2", "#1C1C22", "#5F5F6B", "#8A8A96", "#E2E2EA", "#178F4C", "#C22B20", "#2F5FD0"]) assert.ok(part.includes(c), "Design.java's " + c);
  assert.ok(/\.ex :focus-visible \{ outline: 2px solid var\(--x-accent\)/.test(part)); assert.ok(/role="button" tabindex="0" data-ex="block"/.test(src) && /e\.key === "Enter" \|\| e\.key === " "/.test(src), "a block row opens from the keyboard");
  assert.ok(!/—/.test(src.replace(/\/\/[^\n]*/g, "")), "no em dash"); assert.ok(!/shorten|substring\(0, 10\)|slice\(0, 10\)/.test(src), "the original's 10…8 cut is not ported");
  const svg = R("renderer/icons/explorer.svg");
  for (const d of ["M34,62 h40 v14 a3,3 0 0 1 -3,3 h-34 a3,3 0 0 1 -3,-3 z", "M31,44 a3,3 0 0 1 3,-3 h40 a3,3 0 0 1 3,3 v14 h-46 z", "M42,26 a3,3 0 0 1 3,-3 h30 a3,3 0 0 1 3,3 v11 h-36 z", "M52,49.5 a2.5,2.5 0 1 0 5,0 a2.5,2.5 0 1 0 -5,0 z", "M52,68 a2.5,2.5 0 1 0 5,0 a2.5,2.5 0 1 0 -5,0 z"]) assert.ok(svg.includes('d="' + d + '"'), "the launcher icon's path data");
  assert.ok(R("renderer/index.html").includes('id="view-explorer"') && require("../main/freeze.js").FREEZABLE.includes("explorer"));
  assert.deepEqual([X.PAGE, X.FETCH_GAP_MS, X.MAX_LIVE_GAP], [16, 60, 5], "MainActivity's constants");
});
