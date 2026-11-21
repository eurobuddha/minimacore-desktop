/*
 * shop-migrate-test.cjs — a shop.json written by the released 0.18.69 (no coin lists, no listing check) is read without
 * a false PAID, without turning paid orders into Unchecked ones, and with phone orders that kept no items explained
 * (0.18.195). The fixture is the release review's probe2.
 * Run: node --test scripts/shop-migrate-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shop-migrate-"));
const SECRETS = {}, realLoad = Module._load;
Module._load = function (req, parent) {
  if (req === "electron") return { app: { getPath: () => DIR } };
  if (parent && /main[\\/]shop\.js$/.test(parent.filename) && req === "./config") return { getSecret: a => SECRETS[a] || null, setSecret: (v, a) => { SECRETS[a] = v; }, deleteSecret() {}, rpcSecret: () => "" };
  if (parent && /main[\\/]shop\.js$/.test(parent.filename) && req === "./node-manager") return { rpcPort: () => 0 };
  return realLoad.apply(this, arguments);
};
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const shopCfg = { shopId: "tea", shopName: "Tea", currency: "USDT", tokenid: MX, vendorPublicId: "x", vendorAddress: "y",
  products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0" }] };
const base = { role: "sell", counterparty: "0xBUYER", shopId: "tea", shopName: "Tea", currency: "USDT", tokenid: MX, delivery: "", buyerPayaddr: "", unread: false, date: 1 };
const items = [{ product: "Tea", quantity: 1, unitPrice: "10", lineTotal: "10.000000" }];
const old = { version: 1, shops: { tea: shopCfg }, chat: {}, meta: {}, orders: {
  "ORD-DESK": Object.assign({ ref: "ORD-DESK", items, amount: "10.000000", shipping: "Domestic", status: "PENDING", paid: false }, base),
  "ORD-PHONE": Object.assign({ ref: "ORD-PHONE", items: [], amount: "10", shipping: "domestic", status: "PENDING", paid: false }, base),
  "ORD-PAID": Object.assign({ ref: "ORD-PAID", items: [], amount: "10", shipping: "domestic", status: "PAID", paid: true, paidAmount: "10" }, base),
  "ORD-SHIP": Object.assign({ ref: "ORD-SHIP", items: [], amount: "10", shipping: "domestic", status: "SHIPPED", paid: false }, base),
  "ORD-HALF": Object.assign({ ref: "ORD-HALF", items, amount: "10.000000", shipping: "Domestic", status: "UNDERPAID", paid: false, paidAmount: "5" }, base),
  "ORD-GONE": Object.assign({ ref: "ORD-GONE", items, amount: "10.000000", shipping: "Domestic", status: "UNDERPAID", paid: false, paidAmount: "5" }, base),
} };
fs.writeFileSync(path.join(DIR, "shop.json"), JSON.stringify(old));

test("a 0.18.69 shop.json: no coin counted twice, paid and shipped orders keep their verdict, a phone order without items says why", async () => {
  const store = require("../main/shop-store"), shop = require("../main/shop");
  const VADDR = "MxG0" + "C".repeat(56), st = (ref) => ({ "1": "0x" + Buffer.from(ref).toString("hex") });
  const pay = [
    { coinid: "0xC1", tokenid: MX, tokenamount: "10", amount: "0.0000001", created: "100", state: st("ORD-DESK") },
    { coinid: "0xC2", tokenid: MX, tokenamount: "10", amount: "0.0000001", created: "100", state: st("ORD-PHONE") },
    { coinid: "0xC3", tokenid: MX, tokenamount: "5", amount: "0.0000001", created: "90", state: st("ORD-HALF") },   // the 5 the old version already counted
  ];
  shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "v" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } }
    : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] });
  await shop.init(); await shop.scanOnce();
  const o = (r) => store.order(r);
  assert.equal(o("ORD-DESK").paid, true, "a matching old order is paid by its coin");
  assert.equal(o("ORD-HALF").paid, false, "the old 5 and its coin are not counted twice (a false PAID)"); assert.equal(o("ORD-HALF").status, "UNDERPAID");
  assert.equal(o("ORD-HALF").paidAmount.replace(/0+$/, "").replace(/\.$/, ""), "5"); assert.equal(o("ORD-HALF").legacyPaid, "5");
  assert.equal(o("ORD-GONE").paid, false, "the old figure without its coin (pruned) stays unpaid"); assert.equal(o("ORD-GONE").status, "PENDING");
  assert.equal(store.handCheck("ORD-GONE"), true, "and can be checked by hand");
  assert.equal(o("ORD-PHONE").paid, false); assert.deepEqual(o("ORD-PHONE").problems, ["the items were not kept by an older version of this app"]);
  assert.equal(store.handCheck("ORD-PHONE"), true);
  for (const r of ["ORD-PAID", "ORD-SHIP"]) {
    shop.orderDetail(r); const row = shop.ordersList().find(x => x.ref === r);
    assert.equal(row.unchecked, false, r + ": no Unchecked banner"); assert.equal(o(r).legacyVerdict, true); assert.equal(o(r).status, old.orders[r].status, r + " keeps its status");
  }
  assert.equal(o("ORD-PAID").paid, true);
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").replace(/\r\n/g, "\n");
  // CHANGED on purpose (0.18.218): a kept verdict on an order that is not paid offers a hand check instead of nothing
  assert.ok(app.includes('if (o.status === "INQUIRY") return "";') && app.includes("if (o.legacyVerdict) {") && app.includes("An older version of this app recorded ${esc(o.legacyPaid)}"));
  assert.equal(store.mayAdvance(o("ORD-SHIP")), false, "shipped by an older version without a payment: stuck until checked");
  assert.equal(store.handCheck("ORD-SHIP"), true, "a kept verdict without a payment can be checked by hand (0.18.218)");
  assert.equal(store.mayAdvance(o("ORD-SHIP")), true);
  assert.equal(store.handCheck("ORD-PAID"), false, "a paid one needs no hand check");
});
