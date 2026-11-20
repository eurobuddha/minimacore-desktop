/*
 * shop-test.cjs — miniMall money rules (main/shop-store.js, main/shop.js).
 * Electron is stubbed with a throw-away userData folder; nothing reaches a node.
 * Run: node --test scripts/shop-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shop-test-"));
const realLoad = Module._load;
// config and node-manager are stood in for main/shop.js: the real config reads the macOS Keychain, and no node is run.
const SECRETS = {};
const configStub = { getSecret: (a) => SECRETS[a] || null, setSecret: (v, a) => { SECRETS[a] = v; }, deleteSecret: (a) => { delete SECRETS[a]; }, rpcSecret: () => "", load: () => ({}) };
Module._load = function (request, parent) {
  if (request === "electron") return { app: { getPath: () => DIR, getVersion: () => "test" } };
  if (parent && /[\\/]main[\\/]shop\.js$/.test(parent.filename) && request === "./config") return configStub;
  if (parent && /[\\/]main[\\/]shop\.js$/.test(parent.filename) && request === "./node-manager") return { rpcPort: () => 0 };
  return realLoad.apply(this, arguments);
};
const store = require("../main/shop-store");
const M = store._money;
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
let n = 0;
const sellOrder = (amount, tokenid) => { const ref = "ORD-T" + (++n); store.upsertOrder({ ref, role: "sell", amount, tokenid: tokenid || "0x00", status: "PENDING", paid: false }); return ref; };

// ---- 0.18.149: decCmp never calls an unreadable figure "equal" ----
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

// ---- 0.18.150: the buyer pays the token the shop's currency names ----
const R = require("../renderer/shop-rules.js");
const shop = require("../main/shop");
const sc = require("../main/shopcrypto");
const ADDR = "0x" + "AB".repeat(32);
const shopOf = (o) => Object.assign({ shopName: "S", shopId: "s1", currency: "Minima", vendorAddress: ADDR, shipping: [], products: [{ id: "p1", name: "Tea", price: "1.5" }] }, o);

test("ShopRules.token: from the currency alone; a token id that is not the currency's is refused", () => {
  assert.deepEqual(R.token(shopOf({})), { tokenid: "0x00", name: "Minima" });
  assert.deepEqual(R.token(shopOf({ tokenid: "0x00" })), { tokenid: "0x00", name: "Minima" });
  assert.deepEqual(R.token(shopOf({ currency: "USDT" })), { tokenid: MXUSD, name: "MxUSD" });
  assert.deepEqual(R.token(shopOf({ currency: "USDT", tokenid: MXUSD.toLowerCase() })), { tokenid: MXUSD, name: "MxUSD" });
  assert.match(R.token(shopOf({ tokenid: MXUSD })).err, /says it is paid in Minima but names another token \(0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90\)/, "Minima label, MxUSD id: refused, the id whole");
  assert.match(R.token(shopOf({ currency: "USDT", tokenid: "0x00" })).err, /says it is paid in MxUSD but names another token/);
  assert.match(R.token(shopOf({ currency: "BTC" })).err, /Minima or MxUSD only/);
});

test("ShopRules: plain prices, exact BigInt totals, inline pictures only", () => {
  const s = shopOf({ products: [{ id: "a", name: "A", price: "0.1" }, { id: "b", name: "B", price: "0.00000001" }], shipping: [{ id: "d", label: "D", fee: "0.2" }] });
  const t = R.totals(s, { a: 3, b: 7 }, "d");
  assert.equal(t.itemsTotal, "0.30000007"); assert.equal(t.fee, "0.20000000"); assert.equal(t.total, "0.50000007", "0.1 x 3 + 0.00000001 x 7 + 0.2, exact (a float gives 0.30000000000000004 and rounds the 8th decimal away)");
  assert.equal(R.totals(shopOf({}), { p1: 2 }, "none").total, "3.000000", "six decimals as before");
  assert.equal(R.totals(shopOf({ products: [{ id: "z", name: "Z", price: "0" }] }), { z: 1 }, "none").zero, true);
  for (const price of ["1e3", "-1", "0x10", "1.2.3", "", " 1", "Infinity"]) assert.match(R.problem(shopOf({ products: [{ id: "x", name: "X", price }] })), /not a plain number/, JSON.stringify(price));
  assert.match(R.problem(shopOf({ shipping: [{ id: "d", label: "D", fee: "-5" }] })), /fee of the delivery method/);
  assert.equal(R.image("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  for (const bad of ["file://attacker.example/share/x.png", "https://example.com/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "javascript:alert(1)", null]) assert.equal(R.image(bad), "", String(bad));
  assert.equal(R.payable("0.000000"), false); assert.equal(R.payable("-1"), false); assert.equal(R.payable("1e3"), false); assert.equal(R.payable("0.000001"), true);
});

test("main: a .shop file is checked on import (token, prices) and its pictures are inline or nothing", () => {
  assert.throws(() => shop.checkImported(shopOf({ tokenid: MXUSD })), /names another token/);
  assert.throws(() => shop.checkImported(shopOf({ products: [{ id: "x", name: "X", price: "1e9" }] })), /not a plain number/);
  const ok = shop.checkImported(shopOf({ products: [{ id: "x", name: "X", price: "2", image: "file://host/share/p.png" }, { id: "y", name: "Y", price: "3", image: "data:image/jpeg;base64,/9j/4AAQ" }] }));
  assert.equal(ok.products[0].image, ""); assert.equal(ok.products[1].image, "data:image/jpeg;base64,/9j/4AAQ");
  const mainJs = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/return shop\.checkImported\(cfg\);/.test(mainJs), "mcd:shopImport hands the screen only a checked shop");
});

test("main: placeOrder refuses a mismatched shop before anything is sent, and pays the currency's token", async () => {
  const vendor = await sc.deriveIdentity("vendor seed for the test");
  const cmds = [];
  shop._setRunner(async (c) => {
    cmds.push(c);
    if (c.startsWith("vault")) return { status: true, response: { phrase: "buyer seed for the test" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: "MxG0" + "B".repeat(56) } };
    if (c.startsWith("checkaddress")) return { status: true, response: { simple: true } };
    if (c.startsWith("coins")) return { status: true, response: [] };
    return { status: true, response: { txpowid: "0x01" } };
  });
  const bad = shopOf({ vendorPublicId: vendor.publicId, tokenid: MXUSD });
  await assert.rejects(shop.placeOrder(bad, [], "1.500000", "", "home", ""), /names another token/);
  assert.deepEqual(cmds, [], "no order message and no payment");
  for (const [cfg, tid] of [[shopOf({ vendorPublicId: vendor.publicId }), "0x00"], [shopOf({ vendorPublicId: vendor.publicId, currency: "USDT", tokenid: MXUSD }), MXUSD]]) {
    cmds.length = 0;
    const r = await shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.500000", "", "home", "");
    assert.equal(r.payError, null);
    const pay = cmds.filter(c => c.startsWith("send ") && c.includes("address:" + ADDR));
    assert.equal(pay.length, 1); assert.ok(pay[0].includes(" amount:1.500000 ") && pay[0].includes(" tokenid:" + tid + " "), pay[0]);
  }
  for (const total of ["0", "0.000000", "-1", "1e3", "abc"]) await assert.rejects(shop.placeOrder(shopOf({ vendorPublicId: vendor.publicId }), [], total, "", "home", ""), /Invalid amount/, total);
});

test("screen: Pay asks first, with the amount sent, the token id and the vendor's address whole, and pays nothing on Back", async () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  const i = app.indexOf("\nasync function shopDoPay()"), src = app.slice(i, app.indexOf("\n}\n", i) + 3);
  const run = async (s, answer) => {
    const E = { asked: [], placed: [], toasts: [] }, btn = { disabled: false, textContent: "", isConnected: true };
    const fn = new Function("ShopRules", "el", "toast", "showConfirm", "api", "renderMiniMall", "S",
      "let shopLoaded = S.shop, shopCart = S.cart, shopShipId = null, shopView = '', shopOrderRef = null; const shopSelectedShipping = () => null;" + src + "\nreturn shopDoPay();");
    await fn(R, (id) => (id === "shopPay" ? btn : { value: "home" }), (t) => E.toasts.push(t), async (title, text) => { E.asked.push([title, text]); return answer; },
      { shopPlaceOrder: async (...a) => { E.placed.push(a); return { ref: "ORD-1" }; } }, () => {}, { shop: s, cart: { p1: 2 } });
    return E;
  };
  const s = shopOf({ currency: "USDT", vendorAddress: ADDR, vendorPublicId: "x" });
  let E = await run(s, false);
  assert.equal(E.asked.length, 1); assert.equal(E.placed.length, 0, "Back: nothing placed");
  assert.equal(E.asked[0][0], "Pay 3.000000 MxUSD?");
  assert.ok(E.asked[0][1].includes("\nAmount sent\n3.000000\n") && E.asked[0][1].includes("\n" + MXUSD + "\n") && E.asked[0][1].endsWith("\n" + ADDR), E.asked[0][1]);
  E = await run(s, true);
  assert.deepEqual(E.placed[0].slice(1, 3), [[{ product: "Tea", quantity: 2, unitPrice: "1.5", lineTotal: "3.000000" }], "3.000000"]);
  E = await run(shopOf({ tokenid: MXUSD }), true);
  assert.equal(E.asked.length, 0); assert.equal(E.placed.length, 0); assert.match(E.toasts[0], /names another token/);
});
