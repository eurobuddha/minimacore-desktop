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
  db.orders["ORD-OLD"] = { ref: "ORD-OLD", role: "buy", currency: "Minima", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR }; sent.length = 0; db.meta["unpaid:ORD-OLD"] = true;
  await assert.rejects(shop.retryPayment("ORD-OLD"), /names another token/);
  assert.deepEqual(payments(), []);
  db.orders["ORD-OK"] = { ref: "ORD-OK", role: "buy", currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR }; db.meta["unpaid:ORD-OK"] = true;   // a refused payment (0.19.241)
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

// ---- 0.19.241 (as released 0.18.208 / 0.18.217): a retry needs a refused payment and nothing in flight ----
test("buyer: a retry pays only after a refused payment, never while one may be in flight or may have been sent", async () => {
  let mode = "refuse"; const paid = [];
  shop._setRunner(async (c) => {
    if (c === "getaddress") return { status: true, response: { miniaddress: "MxG0ME" } };
    if (c.startsWith("coins ")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + VENDOR)) { paid.push(c); if (mode === "refuse") return { status: false, error: "Insufficient funds" }; if (mode === "timeout") throw new Error("timed out"); }
    return { status: true, response: { txpowid: "0xT" } };
  });
  db.orders = {}; db.meta = {};
  const r1 = await shop.placeOrder(cfg({}), [], "1.5", "", "home", ""); assert.match(r1.payError, /Insufficient/);
  assert.equal(db.meta["inflight:" + r1.ref], false, "a refused payment is not in flight"); assert.equal(db.meta["unpaid:" + r1.ref], true);
  mode = "ok"; await shop.retryPayment(r1.ref); assert.equal(paid.length, 2, "retried once after the refusal");
  assert.equal(db.meta["inflight:" + r1.ref], false);
  await assert.rejects(shop.retryPayment(r1.ref), /no refused payment to retry/, "and not again");
  const r2 = await shop.placeOrder(cfg({}), [], "1.5", "", "home", ""); assert.equal(r2.payError, null);
  await assert.rejects(shop.retryPayment(r2.ref), /no refused payment to retry/, "an order whose payment went is never paid again by a retry");
  mode = "timeout"; const r3 = await shop.placeOrder(cfg({}), [], "1.5", "", "home", "");
  assert.equal(db.meta["inflight:" + r3.ref], true, "an unanswered payment stays in flight"); await assert.rejects(shop.retryPayment(r3.ref), /may already have been sent/);
  // a quit during the send: the in-flight mark is still on disk, so nothing is sent
  mode = "refuse"; const r4 = await shop.placeOrder(cfg({}), [], "1.5", "", "home", ""); db.meta["inflight:" + r4.ref] = true;
  const before = paid.length; await assert.rejects(shop.retryPayment(r4.ref), /may already have been sent/); assert.equal(paid.length, before, "nothing sent");
  // "I checked my History: it was not sent" offers Retry again, and only for an order with an uncertain payment
  assert.throws(() => shop.paymentNotSent(r1.ref), /no payment that may have gone through/);
  shop.paymentNotSent(r3.ref); assert.equal(db.meta["ambiguous:" + r3.ref], false); assert.equal(db.meta["inflight:" + r3.ref], false); assert.equal(db.meta["unpaid:" + r3.ref], true);
  mode = "ok"; await shop.retryPayment(r3.ref); assert.equal(paid.length, before + 1);
  // the mark is on disk before each payment reaches the node (0.19.265: checked as the node sees the send, not by the source's text)
  const marks = []; shop._setRunner(async (c) => { if (c.startsWith("coins ")) return { status: true, response: [] }; if (c.startsWith("send ") && c.includes("address:" + VENDOR)) { const ref = Object.keys(db.orders).find(k => c.includes("0x" + Buffer.from(k, "utf8").toString("hex"))); marks.push(db.meta["inflight:" + ref]); return { status: false, error: "Insufficient funds" }; } return { status: true, response: { txpowid: "0xT" } }; });
  const r5 = await shop.placeOrder(cfg({}), [], "1.5", "", "home", ""); await assert.rejects(shop.retryPayment(r5.ref), /Insufficient/);
  assert.deepEqual(marks, [true, true], "in flight on disk when the node got the order's payment and the retry");
  const main = require("fs").readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8"), pre = require("fs").readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8");
  assert.ok(main.includes('ipcMain.handle("mcd:shopNotSent", (_e, ref) => shop.paymentNotSent(ref));') && pre.includes('shopNotSent: (ref) => ipcRenderer.invoke("mcd:shopNotSent", ref),'));
  const app = require("fs").readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(/const r = await SHOP\.retryPay\(api, ui, o\);/.test(app) && /const r = await SHOP\.notSent\(api, ui, o\);/.test(app) && !/api\.shopNotSent/.test(app), "the screen asks through AppsAct.shop");
});

// ---- 0.19.265: no "not sent" and no Retry while the payment is still at the node; none once the vendor acknowledged it ----
test("buyer: while a payment is at the node, 'not sent' and Retry are refused and the screen is told it is being sent", async () => {
  const st = require("../main/shop-store.js"); st.markOrderRead = () => false; st.chat = () => []; st.orders = () => Object.values(db.orders);
  let release = null; const paid = [];
  shop._setRunner(async (c) => {
    if (c.startsWith("coins ")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + VENDOR)) { paid.push(c); return new Promise(r => { release = r; }); }
    return { status: true, response: { txpowid: "0xT" } };
  });
  db.orders = {}; db.meta = {};
  const placing = shop.placeOrder(cfg({}), [], "1.5", "", "home", "");
  while (!release) await new Promise(r => setImmediate(r));
  const ref = Object.keys(db.orders)[0];
  assert.equal(shop.sendingCount(), 1, "counted for the Quit and Shutdown warnings (0.19.288)");
  const d = shop.orderDetail(ref); assert.equal(d.sending, true); assert.equal(d.ambiguous, false, "no 'may have gone through' warning and no 'not sent' button while it is sent");
  assert.equal(shop.ordersList()[0].sending, true);
  assert.throws(() => shop.paymentNotSent(ref), /being sent to the node now/); assert.equal(db.meta["inflight:" + ref], true, "the in-flight mark stays");
  db.meta["unpaid:" + ref] = true; await assert.rejects(shop.retryPayment(ref), /being sent to the node now/); assert.equal(paid.length, 1, "no second payment");
  release({ status: true, response: { txpowid: "0xP" } }); const r = await placing; assert.equal(shop.sendingCount(), 0);
  assert.equal(r.payError, null); assert.equal(db.meta["unpaid:" + ref], false, "a payment that went clears unpaid"); assert.equal(shop.orderDetail(ref).sending, false);
  await assert.rejects(shop.retryPayment(ref), /no refused payment to retry/);
});
test("buyer: once the vendor moved the order to PAID or on, the warning, 'not sent' and Retry are gone", async () => {
  const st = require("../main/shop-store.js"); st.markOrderRead = () => false; st.chat = () => []; st.orders = () => Object.values(db.orders);
  const paid = []; shop._setRunner(async (c) => { if (c.startsWith("send ")) paid.push(c); return { status: true, response: [] }; });
  for (const status of ["PAID", "CONFIRMED", "SHIPPED", "DELIVERED"]) {
    db.orders = { "ORD-A": { ref: "ORD-A", role: "buy", status, currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR } }; db.meta = { "ambiguous:ORD-A": true, "inflight:ORD-A": true };
    const d = shop.orderDetail("ORD-A"); assert.equal(d.ambiguous, false, status); assert.equal(d.unpaid, false); assert.equal(shop.ordersList()[0].ambiguous, false);
    assert.throws(() => shop.paymentNotSent("ORD-A"), /already paid/, status); assert.equal(db.meta["unpaid:ORD-A"], undefined);
    db.meta = { "unpaid:ORD-A": true }; await assert.rejects(shop.retryPayment("ORD-A"), /already paid/, status);
  }
  assert.deepEqual(paid, []);
  db.orders = { "ORD-B": { ref: "ORD-B", role: "buy", status: "PENDING", currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: VENDOR } }; db.meta = { "ambiguous:ORD-B": true };
  assert.equal(shop.orderDetail("ORD-B").ambiguous, true, "a pending order still says it may have gone through");
});
