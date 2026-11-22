/*
 * shop-migrate-test.cjs: a shop.json written before the listing check and the coin lists (released 0.18.69, and this branch
 * before 0.19.166 / 0.19.167) is read without a false PAID and without turning paid or shipped orders into Unchecked ones
 * (0.19.247, as released 0.18.195 and 0.18.218). Electron, the node and the crypto are stand-ins; nothing reaches a node.
 *   node --test scripts/shop-migrate-test.cjs
 */
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shop-migrate-"));
const load = Module._load; Module._load = function (request) { return request === "electron" ? { app: { getPath: () => DIR, getVersion: () => "test" } } : load.apply(this, arguments); };
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const standIn = (rel, exports) => { const p = require.resolve(path.join(__dirname, "..", rel)); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports }; };
standIn("main/config.js", { getSecret: () => "cached", setSecret() {}, deleteSecret() {}, rpcSecret: () => "" });
standIn("main/node-manager.js", { rpcPort: () => 0 });
standIn("main/rpc.js", { rpcCall: async () => { throw new Error("TEST LEAK: the real rpcCall"); } });
standIn("main/shopcrypto.js", { ready: async () => {}, loadIdentity: () => ({ publicId: "0x" + "11".repeat(32) }), isValidPublicId: (v) => /^0x[0-9A-F]{64}$/i.test(String(v)), seal: async () => "ab", open: async () => ({ valid: false }) });

const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", VADDR = "MxG0" + "C".repeat(56);
const shopCfg = { shopId: "tea", shopName: "Tea", currency: "USDT", tokenid: MX, vendorAddress: VADDR, products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "10" }], shipping: [{ id: "domestic", label: "Domestic", fee: "0" }] };
const base = { role: "sell", counterparty: "0x" + "22".repeat(32), shopId: "tea", shopName: "Tea", currency: "USDT", tokenid: MX, delivery: "", buyerPayaddr: "", unread: false, date: 1 };
const items = [{ product: "Tea", quantity: 1, unitPrice: "10", lineTotal: "10.000000" }];
const old = { version: 1, shops: { tea: shopCfg }, chat: {}, meta: { vendorAddress: VADDR }, orders: {
  "ORD-DESK": Object.assign({ ref: "ORD-DESK", items, amount: "10.000000", shipping: "Domestic", status: "PENDING", paid: false }, base),
  "ORD-PAID": Object.assign({ ref: "ORD-PAID", items: [], amount: "10", shipping: "domestic", status: "PAID", paid: true, paidAmount: "10" }, base),
  "ORD-SHIP": Object.assign({ ref: "ORD-SHIP", items: [], amount: "10", shipping: "domestic", status: "SHIPPED", paid: false }, base),
  "ORD-HALF": Object.assign({ ref: "ORD-HALF", items, amount: "10.000000", shipping: "Domestic", status: "UNDERPAID", paid: false, paidAmount: "5" }, base),
  "ORD-GONE": Object.assign({ ref: "ORD-GONE", items, amount: "10.000000", shipping: "Domestic", status: "UNDERPAID", paid: false, paidAmount: "5" }, base)
} };
fs.writeFileSync(path.join(DIR, "shop.json"), JSON.stringify(old));

test("an older shop.json: no coin counted twice, paid and shipped orders keep their verdict, both can still be checked by hand", async () => {
  const store = require("../main/shop-store"), shop = require("../main/shop");
  const st = (ref) => ({ "1": "0x" + Buffer.from(ref).toString("hex") });
  const pay = [
    { coinid: "0xC1", tokenid: MX, tokenamount: "10", amount: "0.0000001", created: "100", state: st("ORD-DESK") },
    { coinid: "0xC3", tokenid: MX, tokenamount: "5", amount: "0.0000001", created: "90", state: st("ORD-HALF") }   // the 5 the old version already counted
  ];
  // changed on purpose (0.19.344): the tip is 104, more than PAY_BEFORE_ORDER blocks past the coins (a payment is judged only then)
  shop._setRunner(async (c) => (c === "getaddress" ? { status: true, response: { miniaddress: VADDR } } : c === "block" ? { status: true, response: { block: 104 } }
    : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] }));
  await shop.init(); await shop.scanOnce();
  const o = (r) => store.order(r);
  assert.equal(o("ORD-DESK").paid, true, "a matching old order is paid by its coin");
  assert.equal(o("ORD-HALF").paid, false, "the old 5 and its coin are not counted twice (a false PAID)"); assert.equal(o("ORD-HALF").status, "UNDERPAID");
  assert.equal(o("ORD-HALF").legacyPaid, "5"); assert.deepEqual(o("ORD-HALF").coins, ["0xc3"]);
  assert.equal(o("ORD-GONE").paid, false, "the old figure without its coin (pruned) stays unpaid"); assert.equal(o("ORD-GONE").status, "PENDING");
  assert.equal(store.handCheck("ORD-GONE"), true, "and can be checked by hand");
  for (const r of ["ORD-PAID", "ORD-SHIP"]) {
    shop.orderDetail(r); const row = shop.ordersList().find(x => x.ref === r);
    assert.equal(row.unchecked, false, r + ": no Unchecked banner"); assert.equal(o(r).legacyVerdict, true); assert.equal(o(r).status, old.orders[r].status, r + " keeps its status");
  }
  assert.equal(o("ORD-PAID").paid, true); assert.equal(store.mayAdvance(o("ORD-PAID")), true);
  assert.equal(store.mayAdvance(o("ORD-SHIP")), false, "shipped by an older version without a payment this one sees: checked by hand first");
  assert.equal(store.handCheck("ORD-SHIP"), true); assert.equal(store.mayAdvance(o("ORD-SHIP")), true);
  assert.equal(store.handCheck("ORD-PAID"), false, "a paid order is not 'checked by hand'");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("if (o.legacyVerdict) {") && app.includes('tr("An older version of this app recorded {amount} {cur} received for this order.'), "the screen says what the older version recorded");
});
