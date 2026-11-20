// The History tab (0.18.84): the phone's screen over the desktop's own store. The pieces that decide what a
// user is told (is it on the chain, whose address is it, what an imported file may put in the store) are
// lifted out of renderer/app.js and run.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const R = path.join(__dirname, "..");
const app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "renderer", "app.js"), "utf8"));
const html = fs.readFileSync(path.join(R, "renderer", "index.html"), "utf8");
const mainJs = fs.readFileSync(path.join(R, "main", "main.js"), "utf8");

function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  return /\{$/.test(m[1].replace(/\s+\/\/.*$/, "")) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
function lift(names, prelude) {
  return new Function((prelude || "") + names.map(source).join("\n") + "; return { " + names.join(", ") + " };")();
}
const ID = "0x" + "AB".repeat(32), BLOCKID = "0x" + "1F".repeat(32);

test("chain inclusion: only a consistent found / block / tip / confirmations reply is called confirmed", () => {
  const { chainStatus } = lift(["chainStatus"]);
  const ok = (over) => ({ status: true, response: Object.assign({ found: true, blockid: BLOCKID, block: "2428076", tip: "2428089", confirmations: "13" }, over) });
  assert.equal(chainStatus(ok()), "Confirmed #2428076 · 13 confirmations");
  assert.equal(chainStatus(ok({ block: "2428088", confirmations: "1" })), "In block #2428088 · 1 confirmations", "fewer than three deep is not called confirmed");
  assert.equal(chainStatus(ok({ block: "2428086", confirmations: "3" })), "Confirmed #2428086 · 3 confirmations");
  assert.equal(chainStatus({ status: true, response: { found: false } }), "Not found on this node, unverified");
  for (const bad of [null, undefined, {}, { status: false }, { status: true }, { status: true, pending: true, response: ok().response },
    ok({ found: "true" }), ok({ blockid: "0x" + "00".repeat(32) }), ok({ blockid: "0x12" }), ok({ blockid: 5 }),
    ok({ confirmations: "12" }), ok({ block: "0", tip: "13" }), ok({ block: 2428076 }), ok({ tip: "-1" }), ok({ confirmations: "1e1" }), ok({ block: undefined })])
    assert.equal(chainStatus(bad), "Unverified", JSON.stringify(bad));
  const detail = app.slice(app.indexOf("function showHistoryDetail(r)"), app.indexOf("function relTime"));
  assert.ok(detail.includes("Checking chain inclusion…") && detail.includes("Created at height (not confirmation)"));
  assert.ok(/\/\^0x\[0-9a-f\]\{64\}\$\/i\.test\(String\(r\.txpowid \|\| ""\)\) \|\| !running\) said\("Unverified"\)/.test(detail), "the id is checked before it goes into the command");
  assert.ok(detail.includes('api.cmd("txpow onchain:" + r.txpowid)'), "a read-only question to the node");
  assert.ok(!/tip - r\.block/.test(app), "no confirmations worked out from the header height");
  assert.ok(app.includes('<div class="hrow__r">Unverified</div>'), "a list row never claims more than the phone's does");
});

test("whose address: YOURS, CONTRACT, EXTERNAL, and nothing while the wallet's addresses are unknown", () => {
  const mk = (own, contracts) => lift(["ownAddr", "histOwnership", "histInvolvesWallet"],
    "let HIST_OWN = " + (own ? "new Set(" + JSON.stringify(own) + ")" : "null") + "; let HIST_CONTRACT = new Set(" + JSON.stringify(contracts || []) + ");\n");
  const f = mk(["MxMINE", "0xaa01"], ["MxPOOL", "0xbb02"]);
  assert.equal(f.histOwnership("MxMINE"), "YOURS"); assert.equal(f.histOwnership("0xAA01"), "YOURS", "0x addresses match in either case");
  assert.equal(f.histOwnership("MxPOOL"), "CONTRACT"); assert.equal(f.histOwnership("0xBB02"), "CONTRACT");
  assert.equal(f.histOwnership("MxSOMEONE"), "EXTERNAL"); assert.equal(f.histOwnership(""), "");
  assert.equal(mk(null).histOwnership("MxMINE"), "", "not known yet: no label, never a wrong one");
  assert.equal(f.histInvolvesWallet({ counterparty: "MxPOOL", inputs: [{ address: "MxPOOL" }], outputs: [{ address: "MxPOOL" }] }), false, "foreign: no wallet address anywhere");
  assert.equal(f.histInvolvesWallet({ counterparty: "MxPOOL", inputs: [{ address: "MxPOOL" }], outputs: [{ address: "MxMINE" }] }), true);
  assert.equal(f.histInvolvesWallet({ counterparty: "MxMINE", inputs: [], outputs: [] }), true);
  assert.ok(/histHideForeign\(\) && HIST_OWN && HIST_OWN\.size\) \? stored\.filter\(histInvolvesWallet\) : stored/.test(app), "hiding does nothing until the wallet's addresses are known");
});

test("import: a record is rebuilt field by field; the phone's export and the desktop's both read", () => {
  const { histImportRow } = lift(["histImportRow"], 'const MINIMA = "0x00"; const TOK = { tokenName: (t, id) => id === "0x00" ? "Minima" : id };\n');
  const desk = histImportRow({ txpowid: ID, block: 2428000, time: 1800000000000, direction: "out", kind: "sell", tokenid: "0x00", tokenName: "Minima", amount: "5", counterparty: "MxTHEM",
    inCount: 1, outCount: 2, difference: { "0x00": "-5" }, inputs: [{ address: "MxMINE", amount: "9", tokenid: "0x00", coinid: "0x01", state: [] }], outputs: [], state: [], burn: "0", size: 1400, raw: { evil: 1 }, extra: "x" });
  assert.equal(desk.direction, "out"); assert.equal(desk.kind, "sell"); assert.equal(desk.time, 1800000000000); assert.equal(desk.inputs[0].address, "MxMINE");
  assert.ok(!("raw" in desk) && !("extra" in desk), "nothing is passed through from the file as is");
  const phone = histImportRow({ txpowid: ID, block: 2428000, timemilli: 1800000000000, direction: "received", incoming: true, tokenid: "0xFF", tokenName: "Gold", amount: "2.5",
    deltas: '{"0xFF":"2.5"}', counterparty: "MxTHEM", inputs: '[{"addr":"MxTHEM","amount":"2.5","tokenid":"0xFF"}]', outputs: '[{"addr":"MxMINE","amount":"2.5","tokenid":"0xFF","mine":true}]', syncedAt: 1 });
  assert.equal(phone.direction, "in"); assert.equal(phone.time, 1800000000000); assert.equal(phone.kind, "normal");
  assert.deepEqual(phone.difference, { "0xFF": "2.5" }); assert.equal(phone.outputs[0].address, "MxMINE"); assert.equal(phone.inCount, 1); assert.equal(phone.outCount, 1);
  assert.equal(histImportRow({ txpowid: ID, direction: "sent", amount: "-3" }).amount, "3");
  for (const bad of [null, 5, "x", {}, { txpowid: 5 }, { txpowid: "" }, { txpowid: "B1C4" }, { txpowid: ID + " x" }, { txpowid: "0x" + "A".repeat(129) }]) assert.equal(histImportRow(bad), null);
  assert.ok(/ipcMain\.handle\("mcd:importJson", async \(\) =>/.test(mainJs) && /showOpenDialog/.test(mainJs.slice(mainJs.indexOf("mcd:importJson"), mainJs.indexOf("mcd:importJson") + 500)), "the file is chosen in a dialog; the renderer names no path");
});

test("the screen: the phone's header, its four options in its order, then the desktop's two", () => {
  const view = html.slice(html.indexOf('id="view-history"'), html.indexOf('id="view-terminal"'));
  assert.ok(view.includes(">Minima History<") && view.includes(">⟳ Sync<") && view.includes('placeholder="Search address, id, token, amount…"'));
  assert.deepEqual([...view.matchAll(/data-hact="([a-z]+)">([^<]+)</g)].map(m => m[1] + "=" + m[2]),
    ["json=Export as JSON (backup)", "csv=Export as CSV (spreadsheet)", "import=Import history (restore / merge)", "foreign=Hide foreign contract activity",
      "filter=Filter by direction and token", "copy=Copy the listed rows"]);
  for (const a of ["json", "csv", "import", "foreign", "filter", "copy"]) assert.ok(new RegExp('act === "' + a + '"').test(app), a + " has a handler");
  assert.ok(!/id="histActions"|histRefresh|histCsv/.test(html + app), "the old button row is gone");
  assert.ok(!view.includes("—"), "no long dash on the screen");
});

test("the row shows the other party's address whole, and the time as the phone words it", () => {
  const f = lift(["since", "histWhen"]);
  const now = Date.now();
  assert.equal(f.histWhen(now - 20000), "now"); assert.equal(f.histWhen(now - 31 * 60000), "31 minutes ago"); assert.equal(f.histWhen(now - 61 * 60000), "1 hour ago");
  assert.equal(f.histWhen(now - 3 * 86400000), "3 days ago"); assert.equal(f.histWhen(0), "");
  assert.ok(!/ago$/.test(f.histWhen(now - 8 * 86400000)), "older than a week: the date");
  const row = app.slice(app.indexOf("function histRowHtml(r)"), app.indexOf("function histWhen"));
  assert.ok(!/slice\(|substring|…/.test(row.replace(/\/\/[^\n]*/g, "")), "nothing in the row shortens an identifier");
});

// ---- 0.18.90: the import review (a file must not evict, duplicate or outrank what the node gave) ----
const IMPORT_PRELUDE = 'const MINIMA = "0x00"; const TOK = { tokenName: (t, id) => id === "0x00" ? "Minima" : id };\n';
const hexId = (n) => "0x" + n.toString(16).toUpperCase().padStart(64, "0");

test("import: a transaction id is 0x and 64 hex digits, held in the store's case", () => {
  const { histImportRow } = lift(["histImportRow"], IMPORT_PRELUDE);
  for (const id of ["0x1", "0x" + "AB".repeat(31), "0x" + "AB".repeat(33), "0x" + "AB".repeat(64), "0X" + "AB".repeat(32), "0x" + "G".repeat(64)])
    assert.equal(histImportRow({ txpowid: id }), null, id);
  assert.equal(histImportRow({ txpowid: "0x" + "ab".repeat(32) }).txpowid, ID, "a lower-case id is the same transaction as the stored upper-case one");
  const row = histImportRow({ txpowid: ID, tokenid: "0xff", deltas: { "0xff": "1" }, inputs: [{ addr: "MxA", amount: "1", tokenid: "0xff", coinid: "0xabc" }] });
  assert.deepEqual([row.tokenid, Object.keys(row.difference), row.inputs[0].tokenid, row.inputs[0].coinid], ["0xFF", ["0xFF"], "0xFF", "0xABC"]);
});

test("import: every field is rebuilt from checked values; a record with a wrong field is dropped", () => {
  const { histImportRow } = lift(["histImportRow"], IMPORT_PRELUDE);
  const good = { txpowid: ID, block: 5, time: 6, direction: "self", amount: "1.5", burn: "0.1", state: [{ port: 0, type: 1, data: "0xAA", extra: "x" }],
    inputs: [{ address: "MxMINE", amount: "2", tokenid: "0xFF", coinid: "0x01", token: { name: { name: "Gold", url: "javascript:x" }, decimals: 8, icon: "x" }, state: [{ port: 3, type: 2, data: "hello" }] }],
    outputs: [{ addr: "0xBEEF", amount: "2", tokenid: "0xFF", name: "Gold" }] };
  const r = histImportRow(good);
  assert.deepEqual(r.inputs[0].token, { name: "Gold", decimals: 8 }, "the token is a name and a decimals count, nothing else from the file");
  assert.deepEqual(r.outputs[0].token, { name: "Gold" }, "the phone's coin name");
  assert.deepEqual(r.inputs[0].state, [{ port: 3, type: 2, data: "hello" }]); assert.deepEqual(r.state, [{ port: 0, type: 1, data: "0xAA" }]);
  const wrong = [{ state: [null] }, { state: [{ port: 0 }] }, { state: [{ port: "x", data: "1" }] }, { state: "not json" }, { state: {} },
    { inputs: [null] }, { inputs: [{ amount: "1", state: [null] }] }, { inputs: [{ amount: "1e5" }] }, { inputs: [{ amount: "1", address: "Mx<b>" }] },
    { inputs: [{ amount: "1", tokenid: "0x00 x" }] }, { inputs: [{ amount: "1", coinid: "abc" }] }, { inputs: [{ amount: "1", token: { decimals: "x" } }] }, { inputs: "not json" }, { inputs: 7 },
    { block: "abc" }, { block: -1 }, { block: 1.5 }, { block: "9".repeat(16) }, { time: {} }, { size: "1e3" },
    { amount: "abc" }, { amount: { a: 1 } }, { burn: "1,5" }, { tokenid: "0x00 x" }, { tokenid: 7 }, { counterparty: "someone" }, { counterparty: { a: 1 } },
    { direction: "sideways" }, { kind: "DROP TABLE" }, { deltas: 7 }, { deltas: [] }, { deltas: { "0xFF": "x" } }, { deltas: { "nope": "1" } }];
  for (const w of wrong) assert.equal(histImportRow(Object.assign({}, good, w)), null, JSON.stringify(w));
  // the detail screen reads these rows: none of what it walks can be null
  const all = histImportRow(Object.assign({}, good, { state: undefined, inputs: undefined, outputs: undefined }));
  assert.deepEqual([all.state, all.inputs, all.outputs, all.difference], [[], [], [], {}]);
});

test("import: worked out before anything is written; a file that would not fit is refused whole, with the numbers", () => {
  const { histImportPlan } = lift(["histImportRow", "histImportPlan"], IMPORT_PRELUDE);
  const known = new Set([hexId(1), hexId(2)]);
  const file = [{ txpowid: hexId(1) }, { txpowid: hexId(2).toLowerCase().replace("0X", "0x") }, { txpowid: hexId(3) }, { txpowid: hexId(3) }, { txpowid: hexId(4), block: "abc" }, { txpowid: "0x12" }, null];
  let plan = histImportPlan(file, known, 200000);
  assert.deepEqual([plan.fresh.map(r => r.txpowid), plan.same, plan.invalid, plan.refuse], [[hexId(3)], 3, 3, ""], "a stored id in either case, or twice in the file, is not added again");
  plan = histImportPlan([{ txpowid: hexId(3) }, { txpowid: hexId(4) }], known, 3);
  assert.equal(plan.refuse, "Nothing was imported. The file would add 2 transactions to the 2 already stored, and the store holds 3 at most.");
  assert.equal(histImportPlan([{ txpowid: hexId(3) }], known, 3).refuse, "", "exactly at the cap fits");
  const imp = app.slice(app.indexOf("async function importHistory()"), app.indexOf("async function exportHistory()"));
  assert.ok(imp.indexOf("if (plan.refuse)") < imp.indexOf("api.histImport(") && imp.indexOf("if (plan.refuse)") > 0, "refused before the store is asked to write");
  assert.equal((imp.match(/api\.histImport\(/g) || []).length, 1); assert.ok(!/histAdd|for \(let i/.test(imp), "one write, not one per 500 rows");
});

// The store itself (main/history-db.js), run on a throwaway folder with sql.js; electron is a stand-in.
const Module = require("module"), os = require("os");
let USERDATA = "";
function loadDb() {
  USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "hist-test-"));
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? { app: { getPath: () => USERDATA } } : realLoad.call(this, request, ...rest); };
  delete require.cache[require.resolve("../main/history-db.js")];
  try { return require("../main/history-db.js"); } finally { Module._load = realLoad; }
}
const real = (n, block) => ({ txpowid: hexId(n), block, time: block * 1000, direction: "in", kind: "normal", tokenid: "0x00", tokenName: "Minima", amount: "1", counterparty: "MxNODE" });

test("store: an import adds only, marks its rows, and never replaces or trims a row the node gave", async () => {
  const db = loadDb();
  await db.merge([real(1, 100), real(2, 200)]);
  let r = await db.importRows([Object.assign(real(1, 999), { counterparty: "MxFILE" }), real(3, 300), real(3, 300), { txpowid: "0x" + "ab".repeat(32) }, { txpowid: "0x12" }, null]);
  assert.deepEqual([r.added, r.refused, r.existing], [1, false, 2], "only the row it did not have; ids not in the store's form never reach it");
  let rows = await db.all();
  assert.deepEqual(rows.map(x => [x.txpowid, x.counterparty, x.imported]), [[hexId(3), "MxNODE", true], [hexId(2), "MxNODE", false], [hexId(1), "MxNODE", false]]);
  assert.equal((await db.importRows([real(3, 300)])).added, 0, "the same file twice adds nothing");
  // the node later reports transaction 3: its row replaces the imported one
  await db.merge([Object.assign(real(3, 301), { counterparty: "MxCHAIN" })]);
  rows = await db.all();
  assert.deepEqual([rows[0].txpowid, rows[0].block, rows[0].counterparty, rows[0].imported], [hexId(3), 301, "MxCHAIN", false]);
  assert.equal((await db.stats()).cap, 200000);
  await db.clear(); db.flush();
  fs.rmSync(USERDATA, { recursive: true, force: true });
});

test("store: a file past the cap writes nothing; at the cap, later node rows push out imported rows, not real ones", async () => {
  const db = loadDb();
  await db.merge([real(1, 1), real(2, 2)]);                                   // the oldest real rows: the first to go under the old trim
  const many = []; for (let i = 0; i < 199999; i++) many.push({ txpowid: hexId(1000 + i), block: 5000000 + i, time: 1, amount: "1" });
  let r = await db.importRows(many);
  assert.deepEqual([r.added, r.refused, r.existing, r.fresh, r.cap], [0, true, 2, 199999, 200000]);
  assert.equal(await db.count(), 2, "nothing written, nothing trimmed");
  r = await db.importRows(many.slice(0, 199998));
  assert.deepEqual([r.added, r.refused], [199998, false]); assert.equal(await db.count(), 200000);
  await db.merge([real(3, 3), real(4, 4), real(5, 5)]);                       // the node syncs three more
  assert.equal(await db.count(), 200000);
  const kept = (await db.query({ limit: 10, search: "MxNODE" })).map(x => x.txpowid).sort();
  assert.deepEqual(kept, [hexId(1), hexId(2), hexId(3), hexId(4), hexId(5)], "every row the node gave is still there, whatever block a file claimed");
  await db.clear(); db.flush();
  fs.rmSync(USERDATA, { recursive: true, force: true });
});

test("sync: an imported row does not stop the walk, so the node's own row is written over it", async () => {
  const added = [];
  const page = { status: true, response: { txpows: [{ txpowid: hexId(9) }, { txpowid: hexId(8) }, { txpowid: hexId(7) }, { txpowid: hexId(6) }], details: [] } };
  const env = {
    api: { cmd: async (c) => (/offset:0$/.test(c) ? page : { status: true, response: { txpows: [] } }),
      histGet: async () => [{ txpowid: hexId(8), imported: true }, { txpowid: hexId(7), imported: false }, { txpowid: hexId(6), imported: false }],
      histAdd: async (rows) => { added.push(...rows.map(r => r.txpowid)); } },
    normalize: (t) => ({ txpowid: t.txpowid }), loadOwnAddresses: async () => {}, renderHistoryList: async () => {}
  };
  const syncHistory = new Function(...Object.keys(env), "let HIST_SYNCING = false, HIST_OWN = new Set(['x']), histOldestOffset = 0; const HIST_PAGE = 100, HIST_OLDER_BUDGET = 2000;\n" + source("syncHistory") + "; return syncHistory;")(...Object.values(env));
  const r = await syncHistory({ older: false });
  assert.deepEqual(added, [hexId(9), hexId(8)], "the new one and the imported one are written from the node; the walk stops at the first row the node gave before");
  assert.equal(r.completed, true);
});
