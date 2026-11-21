// miniMall, the main process (main/shop.js, 0.19.118): which token an order pays, what a .shop file may carry, and the
// one scan loop. The store, the keychain, the crypto and the node are stand-ins: nothing here reaches a node or a file.
"use strict";
const test = require("node:test"), assert = require("node:assert"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", VENDOR = "0x" + "AB".repeat(32), VID = "0x" + "5A".repeat(32);
const standIn = (rel, exports) => { const p = require.resolve(path.join(__dirname, "..", rel)); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports }; };
const db = { orders: {}, meta: {} };
standIn("main/config.js", { getSecret: () => "cached", setSecret() {}, deleteSecret() {}, rpcSecret: () => "" });
standIn("main/node-manager.js", { rpcPort: () => 0 });
standIn("main/rpc.js", { rpcCall: async () => { throw new Error("TEST LEAK: the real rpcCall"); } });
standIn("main/shopcrypto.js", { ready: async () => {}, loadIdentity: () => ({ publicId: "0x" + "11".repeat(32) }), isValidPublicId: (v) => /^0x[0-9A-F]{64}$/i.test(String(v)), seal: async () => "ab" });
standIn("main/shop-store.js", { upsertOrder: (o) => { db.orders[o.ref] = o; return true; }, order: (r) => db.orders[r] || null, shop: () => null, shops: () => [], getMeta: (k) => db.meta[k], setMeta: (k, v) => { db.meta[k] = v; }, setMetaSync: (k, v) => { db.meta[k] = v; } });
const shop = require("../main/shop");
const sent = [];
shop._setRunner(async (cmd) => { sent.push(cmd); if (cmd === "getaddress") return { status: true, response: { miniaddress: "MxG0ME" } }; if (cmd.startsWith("coins ")) return { status: true, response: [] }; return { status: true, response: { txpowid: "0xT" } }; });
const cfg = (patch) => Object.assign({ shopName: "Zebra", shopId: "zebra", vendorPublicId: VID, vendorAddress: VENDOR, currency: "USDT", tokenid: MXUSD, products: [{ id: "p1", name: "Mug", price: "12.5" }] }, patch);
const payments = () => sent.filter(c => c.startsWith("send ") && c.includes("address:" + VENDOR));

test("an order pays the token its currency names; a shop whose tokenid says otherwise is refused before anything is sent", async () => {
  for (const [patch, why] of [[{ currency: "Minima" }, /says it is paid in Minima but names another token/], [{ currency: "USDT", tokenid: "0x00" }, /says it is paid in MxUSD but names another token/], [{ currency: "MxUSD" }, /Minima or MxUSD only/], [{ currency: "Minima", tokenid: "0x" + "00".repeat(32) }, /names another token/]]) {
    sent.length = 0; db.orders = {};
    await assert.rejects(shop.placeOrder(cfg(patch), [], "12.500000", "", "x", ""), why);
    assert.deepEqual(sent, [], "no order message, no payment, not even a read"); assert.deepEqual(db.orders, {});
  }
  for (const [patch, token] of [[{}, MXUSD], [{ tokenid: MXUSD.toLowerCase() }, MXUSD], [{ tokenid: undefined }, MXUSD], [{ currency: "mxUSDT", tokenid: "" }, MXUSD], [{ currency: "Minima", tokenid: "0x00" }, "0x00"], [{ currency: "Minima", tokenid: undefined }, "0x00"]]) {
    sent.length = 0; db.orders = {};
    const r = await shop.placeOrder(cfg(patch), [], "12.500000", "", "x", "");
    assert.equal(r.payError, null);
    assert.equal(payments().length, 1); assert.ok(payments()[0].startsWith("send amount:12.500000 address:" + VENDOR + " tokenid:" + token + " state:"), payments()[0]);
    assert.equal(db.orders[r.ref].tokenid, token);
  }
});
test("the amount is a plain decimal above zero, checked before the order message goes", async () => {
  for (const bad of ["-1", "1e3", ".5", "0x10", "0", "0.000", "", "12.5 tokenid:0x00", 12.5e30]) {
    sent.length = 0;
    await assert.rejects(shop.placeOrder(cfg({}), [], bad, "", "x", ""), /Invalid amount/, String(bad));
    assert.deepEqual(sent, []);
  }
});
test("Retry payment refuses an order saved with a token that is not its currency's", async () => {
  db.orders["ORD-OLD"] = { ref: "ORD-OLD", role: "buy", currency: "Minima", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR }; sent.length = 0;
  await assert.rejects(shop.retryPayment("ORD-OLD"), /names another token/);
  assert.deepEqual(payments(), []);
  db.orders["ORD-OK"] = { ref: "ORD-OK", role: "buy", currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR };
  await shop.retryPayment("ORD-OK"); assert.equal(payments().length, 1); assert.ok(payments()[0].includes("tokenid:" + MXUSD));
});
test("a .shop file is checked as it is read: currency and token, plain prices, and a picture that is inline or nothing", () => {
  assert.throws(() => shop.checkImported(cfg({ currency: "Minima" })), /names another token \(0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90\)/);
  assert.throws(() => shop.checkImported(cfg({ products: [{ id: "p", name: "X", price: "1e3" }] })), /not a plain number/);
  assert.throws(() => shop.checkImported([]), /valid \.shop file/); assert.throws(() => shop.checkImported(null), /valid \.shop file/);
  const inline = "data:image/png;base64,iVBORw0KGgo=";
  const out = shop.checkImported(cfg({ products: [{ id: "a", name: "A", price: "1", image: "file://evil.example/share/a.png" }, { id: "b", name: "B", price: "2", image: inline }, { id: "c", name: "C", price: "3" }] }));
  assert.deepEqual(out.products.map(p => p.image), ["", inline, ""]);
  const mainJs = require("fs").readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.match(mainJs, /mcd:shopImport[\s\S]{0,500}return shop\.checkImported\(cfg\);/, "the import handler returns only a checked file");
});
