// The History tab (0.18.84): the phone's screen over the desktop's own store. The pieces that decide what a
// user is told (is it on the chain, whose address is it, what an imported file may put in the store) are
// lifted out of renderer/app.js and run.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(R, "renderer", "app.js"), "utf8");
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
  const { histImportRow } = lift(["validTok", "histImportRow"], 'const MINIMA = "0x00"; const TOK = { tokenName: (t, id) => id === "0x00" ? "Minima" : id };\n');
  const desk = histImportRow({ txpowid: ID, block: 2428000, time: 1800000000000, direction: "out", kind: "sell", tokenid: "0x00", tokenName: "Minima", amount: "5", counterparty: "MxTHEM",
    inCount: 1, outCount: 2, difference: { "0x00": "-5" }, inputs: [{ address: "MxMINE", amount: "9", tokenid: "0x00", coinid: "0x01", state: [] }], outputs: [], state: [], burn: "0", size: 1400, raw: { evil: 1 }, extra: "x" });
  assert.equal(desk.direction, "out"); assert.equal(desk.kind, "sell"); assert.equal(desk.time, 1800000000000); assert.equal(desk.inputs[0].address, "MxMINE");
  assert.ok(!("raw" in desk) && !("extra" in desk), "nothing is passed through from the file as is");
  const phone = histImportRow({ txpowid: ID, block: 2428000, timemilli: 1800000000000, direction: "received", incoming: true, tokenid: "0xFF", tokenName: "Gold", amount: "2.5",
    deltas: '{"0xFF":"2.5"}', counterparty: "MxTHEM", inputs: '[{"addr":"MxTHEM","amount":"2.5","tokenid":"0xFF"}]', outputs: '[{"addr":"MxMINE","amount":"2.5","tokenid":"0xFF","mine":true}]', syncedAt: 1 });
  assert.equal(phone.direction, "in"); assert.equal(phone.time, 1800000000000); assert.equal(phone.kind, "normal");
  assert.deepEqual(phone.difference, { "0xFF": "2.5" }); assert.equal(phone.outputs[0].address, "MxMINE"); assert.equal(phone.inCount, 1); assert.equal(phone.outCount, 1);
  assert.equal(histImportRow({ txpowid: ID, direction: "sent", amount: "-3" }).amount, "3");
  assert.equal(histImportRow({ txpowid: ID, direction: "sideways", kind: "DROP TABLE", tokenid: "0x00 x", tokenName: { a: 1 }, inputs: "not json", deltas: 7 }).direction, "self");
  const odd = histImportRow({ txpowid: ID, direction: "sideways", kind: "DROP TABLE", tokenid: "0x00 x", tokenName: { a: 1 }, inputs: "not json", deltas: 7, block: "abc" });
  assert.deepEqual([odd.kind, odd.tokenid, odd.tokenName, odd.inputs, odd.difference, odd.block], ["normal", "0x00", "Minima", [], {}, 0]);
  for (const bad of [null, 5, "x", {}, { txpowid: 5 }, { txpowid: "" }, { txpowid: "B1C4" }, { txpowid: ID + " x" }, { txpowid: "0x" + "A".repeat(129) }]) assert.equal(histImportRow(bad), null);
  const imp = app.slice(app.indexOf("async function importHistory()"), app.indexOf("async function exportHistory()"));
  assert.ok(/if \(!known\.has\(row\.txpowid\)\)/.test(imp), "a row the store already has is never overwritten by a file");
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
