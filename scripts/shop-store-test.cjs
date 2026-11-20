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

// ---- the vendor's side of main/shop.js over the real store: orders are opened by a stand-in shopcrypto ----
const standIn = (rel, exports) => { const p = require.resolve(path.join(__dirname, "..", rel)); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports }; };
const ME = "0x" + "11".repeat(32), BUYER = "0x" + "22".repeat(32), VENDOR = "MxG0VENDORADDRESS0000000000000000000000000000";
standIn("main/config.js", { getSecret: () => "cached", setSecret() {}, deleteSecret() {}, rpcSecret: () => "" });
standIn("main/node-manager.js", { rpcPort: () => 0 });
standIn("main/rpc.js", { rpcCall: async () => { throw new Error("TEST LEAK: the real rpcCall"); } });
standIn("main/shopcrypto.js", { ready: async () => {}, loadIdentity: () => ({ publicId: ME }), isValidPublicId: (v) => /^0x[0-9A-F]{64}$/i.test(String(v)), seal: async () => "ab",
  open: async (_id, blob) => ({ valid: true, fromPublicId: BUYER, plaintext: Buffer.from(String(blob).slice(2), "hex") }) });
const shop = require("../main/shop");
const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
/** One scan in which the MINIMERCH channel carries `orders` (wire objects from BUYER) and my address the `pays` coins ({ coinid, ref, amount, tokenid }). */
async function scan(orders, pays) {
  shop._setRunner(async (c) => {
    if (c === "getaddress") return { status: true, response: { miniaddress: VENDOR } };
    if (c.startsWith("coins address:" + shop.MINIMERCH)) return { status: true, response: orders.map((w, i) => ({ coinid: "0xM" + (++n) + "_" + i, state: { "99": hex(JSON.stringify(Object.assign({ from: BUYER, date: 1 }, w))) } })) };
    if (c.startsWith("coins address:" + VENDOR)) return { status: true, response: pays.map(p => ({ coinid: p.coinid, tokenid: p.tokenid, amount: p.amount, tokenamount: p.amount, state: { "1": hex(p.ref) } })) };
    return { status: true, response: [] };
  });
  await shop.init(); await shop.scanOnce();
}

// ---- 0.19.165 (released 0.18.151): the token an order is paid in is the vendor's own shop's ----
test("vendor: an order to an MxUSD shop that says Minima must still be paid in MxUSD", async () => {
  store.saveShop({ shopId: "own-mxusd", shopName: "Mine", currency: "USDT", tokenid: MXUSD, products: [], shipping: [] });
  await scan([{ type: "ORDER", ref: "ORD-VEND1", shopId: "own-mxusd", shopName: "Not mine", items: [{ product: "Tea", quantity: 1 }], amount: "5", currency: "Minima", tokenid: "0x00" }],
    [{ coinid: "0xC2", ref: "ORD-VEND1", amount: "5", tokenid: "0x00" }]);
  const o = store.order("ORD-VEND1");
  assert.ok(o, "the order was received"); assert.equal(o.tokenid, MXUSD); assert.equal(o.currency, "USDT"); assert.equal(o.shopName, "Mine", "the shop's name is mine, not the buyer's");
  assert.equal(o.paid, false, "5 Minima does not pay a 5 MxUSD order"); assert.equal(o.status, "WRONG_TOKEN");
});
