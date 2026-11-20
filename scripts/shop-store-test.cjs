// miniMall, the vendor's money rules in the REAL store (main/shop-store.js): what an order is due and when it is paid.
// Electron is a stand-in whose userData is a throw-away folder; nothing reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shop-store-test-"));
const Module = require("module"), load = Module._load, electron = { app: { getPath: () => DIR, getVersion: () => "test" } };
Module._load = function (request) { return request === "electron" ? electron : load.apply(this, arguments); };
const store = require("../main/shop-store");
const M = store._money;
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
let n = 0;
const sellOrder = (amount, tokenid) => { const ref = "ORD-T" + (++n); store.upsertOrder({ ref, role: "sell", amount, tokenid: tokenid || "0x00", status: "PENDING", paid: false }); return ref; };

// ---- 0.19.164 (released 0.18.149): decCmp never calls an unreadable figure "equal" ----
test("decCmp: exact decimal compare; an unreadable figure is null, never 0", () => {
  assert.equal(M.decCmp("1", "1.000000"), 0);
  assert.equal(M.decCmp("0.1", "0.10000000000000000000000000000000000000000001"), -1, "past a double's precision");
  assert.equal(M.decCmp("12.5", "12.49999999"), 1);
  assert.equal(M.decCmp("007", "7"), 0);
  for (const bad of ["abc", "", " 1", "1 ", "1e3", "-5", "+1", "0x10", "1.2.3", ".5", "5.", "NaN", "Infinity", null, undefined, {}, [], "１"]) {
    assert.equal(M.decCmp(bad, "1"), null, JSON.stringify(bad)); assert.equal(M.decCmp("1", bad), null, JSON.stringify(bad));
    assert.equal(M.decGte(bad, "1"), false); assert.equal(M.decGte("1", bad), false, "nothing is >= an unreadable total: " + JSON.stringify(bad));
  }
});

test("recordPayment: a malformed, zero or negative buyer total is never paid (BAD_TOTAL), whatever is received", () => {
  for (const total of ["abc", "1e3", "-5", "0", "0.000", "", "0x10", "1.2.3", " 10"]) {
    const ref = sellOrder(total);
    assert.equal(store.recordPayment(ref, "1000000", "0x00"), "BAD_TOTAL", JSON.stringify(total));
    const o = store.order(ref); assert.equal(o.paid, false); assert.equal(o.status, "BAD_TOTAL"); assert.equal(o.paidAmount, "1000000", "what arrived is still recorded");
    assert.equal(store.recordPayment(ref, "5", "0x00"), "BAD_TOTAL", "and a second coin does not change it");
  }
});

test("recordPayment: a readable total is paid exactly at its figure, cumulatively, and only in its token", () => {
  let ref = sellOrder("10.5");
  assert.equal(store.recordPayment(ref, "10.499999999999999999", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(ref, "0.000000000000000001", "0x00"), "PAID", "10.499999999999999999 + 0.000000000000000001 = 10.5");
  assert.equal(store.recordPayment(ref, "1", "0x00"), "ALREADY");
  ref = sellOrder("3", MXUSD);
  assert.equal(store.recordPayment(ref, "100", "0x00"), "WRONG_TOKEN");
  assert.equal(store.recordPayment(ref, "3", MXUSD.toLowerCase()), "PAID");
  ref = sellOrder("0.000000001");
  assert.equal(store.recordPayment(ref, "0.000000001", "0x00"), "PAID", "a tiny but real total is still payable");
});

test("the Inbox: a BAD_TOTAL order is red and says why it is never paid, in each language", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes('WRONG_TOKEN: "#E74C3C", BAD_TOTAL: "#E74C3C" };'));
  assert.ok(app.includes(`o.status === "BAD_TOTAL" ? tr("The buyer's total is not an amount above zero, so this order is never marked paid. Received so far: {amount} {cur}", { amount: esc(o.paidAmount || "0"), cur: esc(cur) })`));
});
