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
let n = 0, cn = 0;
const coin = () => "0xF00D" + (++cn).toString(16);   // a fresh payment coin id (0.18.163: every counted coin has one)
// An incoming order to the vendor's own shop "tea" (Tea 1.5 x up to 10, Domestic delivery 0.2). Since 0.18.159 what is
// due comes from that listing; the buyer's amount is kept only to be shown.
store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }, { id: "p2", name: "Free sample", price: "0", maxUnits: "1" }],
  shipping: [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0.2" }] });
const sellOrder = (amount, tokenid, more) => { const ref = "ORD-T" + (++n); store.upsertOrder(Object.assign({ ref, role: "sell", shopId: "tea", amount, currency: "Minima", tokenid: tokenid || "0x00", status: "PENDING", paid: false,
  items: [{ product: "Tea", quantity: 2, unitPrice: "1.5", lineTotal: "3.000000" }], shipping: "Domestic" }, more)); return ref; };

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

// 0.18.149's tests were on the buyer's total; since 0.18.159 the figure compared is the listing's (CHANGED on purpose).
test("recordPayment: whatever the buyer wrote as total (abc, 1e3, -5, 0, 0.000000001), the listing decides what is due", () => {
  for (const total of ["abc", "1e3", "-5", "0", "", "0x10", "0.000000001"]) {
    const ref = sellOrder(total);
    assert.equal(store.recordPayment(ref, "0.000000001", "0x00", coin()), "DUST", JSON.stringify(total) + ": 1 nano does not pay 2 x 1.5 + 0.2 (CHANGED on purpose, 0.18.181: it is dust, not counted)");
    assert.equal(store.recordPayment(ref, "3.199999999", "0x00", coin()), "PAID", "3.199999999 + the gathered 1 nano = 3.2 due (CHANGED on purpose, 0.18.190: dust counts once it covers what is left)");
    assert.equal(store.order(ref).due, "3.2");
  }
  const free = sellOrder("0", "0x00", { items: [{ product: "Free sample", quantity: 1, unitPrice: "0" }], shipping: "Digital" });
  assert.equal(store.recordPayment(free, "5", "0x00", coin()), "BAD_TOTAL", "nothing due by the listing: never paid"); assert.equal(store.order(free).paid, false);
});

test("recordPayment: exact, cumulative, and only in the order's token", () => {
  let ref = sellOrder("3.2");
  assert.equal(store.recordPayment(ref, "3.199999999999999999", "0x00", coin()), "UNDERPAID");
  assert.equal(store.recordPayment(ref, "0.000000000000000001", "0x00", coin()), "PAID");
  assert.equal(store.recordPayment(ref, "1", "0x00", coin()), "ALREADY");
  ref = sellOrder("3.2", MXUSD);
  assert.equal(store.recordPayment(ref, "100", "0x00", coin()), "WRONG_TOKEN");
});

// ---- 0.18.159: the vendor's own listing ----
const L = require("../main/shop-listing");
const TEA = store.shop("tea");
test("listing.check: due = listed price x quantity + the listed fee; both buyers' wire shapes match", () => {
  const desktop = { items: [{ product: "Tea", quantity: 3, unitPrice: "1.5", lineTotal: "4.500000" }], shipping: "Domestic", currency: "Minima" };
  assert.deepEqual(L.check(TEA, desktop), { due: "4.7", problems: [] }, "this desktop: items an array, shipping the LABEL");
  const phone = { items: JSON.stringify([{ product: "Tea", size: "", quantity: 3, unitPrice: "1.5", lineTotal: "4.5" }]), shipping: "domestic", currency: "Minima" };
  assert.deepEqual(L.check(TEA, phone), { due: "4.7", problems: [] }, "the phone: items a JSON array STRING, shipping the ID");
  assert.deepEqual(L.check(TEA, { items: [{ product: "Tea", quantity: 1, unitPrice: "1.50" }], shipping: "digital", currency: "minima" }), { due: "1.5", problems: [] }, "1.50 is the listed 1.5");
  assert.deepEqual(L.check({ shopId: "x", currency: "USDT", products: [{ name: "Pin", price: "0.00000001", maxUnits: "99" }], shipping: [] }, { items: [{ product: "Pin", quantity: 7, unitPrice: "0.00000001" }], shipping: "", currency: "USDT" }),
    { due: "0.00000007", problems: [] }, "no delivery methods listed: none chosen costs nothing; 8 decimals exact");
});
test("listing.check: every way an order departs from the listing is a problem", () => {
  const P = (items, shipping, currency, shopObj) => L.check(shopObj === undefined ? TEA : shopObj, { items, shipping: shipping == null ? "Domestic" : shipping, currency: currency || "Minima" }).problems;
  const tea = (o) => [Object.assign({ product: "Tea", quantity: 1, unitPrice: "1.5" }, o)];
  for (const [items, why] of [[tea({ product: "Tea " }), /not in your listing/], [tea({ product: "tea" }), /not in your listing/], [tea({ unitPrice: "0.000000001" }), /is not your price 1\.5/], [tea({ unitPrice: "1e0" }), /not your price/],
    [tea({ quantity: 0 }), /not a whole number above zero/], [tea({ quantity: 1.5 }), /not a whole number/], [tea({ quantity: "2x" }), /not a whole number/], [tea({ quantity: -1 }), /not a whole number/], [tea({ quantity: 11 }), /more than you list \(10\)/],
    [tea({ nftTokenId: "0x" + "AB".repeat(32) }), /not in your listing/], [tea({ nftStateIdx: 3 }), /not in your listing/], [[], /no items/], ["not json", /no items/], [[null], /cannot be read/]])
    assert.match(P(items).join(" | "), why, JSON.stringify(items));
  assert.match(P(tea({}), "Express").join(), /delivery method "Express" is not in your listing/);
  assert.match(P(tea({}), null, "USDT").join(), /currency \(MxUSD\) is not your shop's \(Minima\)/);
  assert.match(P(tea({}), null, null, null).join(), /not one of your shops/);
  assert.match(P(tea({}), null, null, Object.assign({}, TEA, { products: TEA.products.concat([{ name: "Tea", price: "9" }]) })).join(), /listed more than once/);
  const nft = { shopId: "n", currency: "Minima", shipping: [], products: [{ name: "Art", price: "5", nftTokenId: "0xAA", nftStateIdx: 2 }] };
  assert.deepEqual(P([{ product: "Art", quantity: 1, unitPrice: "5", nftTokenId: "0xaa", nftStateIdx: 2 }], "digital", null, nft), [], "an edition matches by name, token id and index");
  assert.match(P([{ product: "Art", quantity: 2, unitPrice: "5", nftTokenId: "0xAA", nftStateIdx: 2 }], "digital", null, nft).join(), /more than you list \(1\)/, "one of an edition");
});
test("an order that does not match is UNCHECKED, never paid by any amount, and can be confirmed only after the vendor checks it by hand", async () => {
  const ref = sellOrder("1000", "0x00", { items: [{ product: "Tea", quantity: 2, unitPrice: "0.000000001" }] });
  assert.equal(store.recordPayment(ref, "1000000", "0x00", coin()), "UNCHECKED");
  const o = store.order(ref); assert.equal(o.paid, false); assert.equal(o.status, "UNCHECKED"); assert.match(o.problems[0], /is not your price 1\.5/);
  assert.equal(store.mayAdvance(o), false);
  await assert.rejects(shop.advanceStatus(ref, "CONFIRMED"), /Check it by hand first/);
  assert.equal(store.handCheck(sellOrder("3.2")), false, "a matching order is not 'checked by hand'");
  shop.vendorCheck(ref); assert.equal(store.mayAdvance(store.order(ref)), true); assert.equal(store.order(ref).paid, false, "still not paid");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("Unchecked: the items or total do not match your shop; check by hand.") && /if \(!o\.paid && !o\.handChecked\) return/.test(app) && /await api\.shopVendorCheck\(ref\)/.test(app), "the screen says so and asks before it");
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

// ---- 0.18.151: the vendor's side takes the token from its own shop, not from the buyer's order ----
test("vendor: an order to an MxUSD shop that says Minima must still be paid in MxUSD", async () => {
  const me = shop.myIdentity(); assert.ok(me && me.publicId, "the identity of the placeOrder test above");
  const buyer = await sc.deriveIdentity("a buyer for the vendor test");
  store.saveShop({ shopId: "own-mxusd", shopName: "Mine", currency: "USDT", tokenid: MXUSD, products: [], shipping: [] });
  const order = { type: "ORDER", ref: "ORD-VEND1", randomid: "r1", from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "own-mxusd", shopName: "Mine",
    items: [{ product: "Tea", quantity: 1 }], amount: "5", currency: "Minima", tokenid: "0x00" };
  const blob = await sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify(order), "utf8"));
  const refHex = "0x" + Buffer.from("ORD-VEND1", "utf8").toString("hex");
  shop._setRunner(async (c) => {
    if (c.startsWith("coins address:" + shop.MINIMERCH)) return { status: true, response: [{ coinid: "0xC1", state: { "99": "0x" + blob } }] };
    if (c.startsWith("coins address:" + me.vendorAddress)) return { status: true, response: [{ coinid: "0xC2", tokenid: "0x00", amount: "5", state: { "1": refHex } }] };
    return { status: true, response: [] };
  });
  await shop.scanOnce();
  const o = store.order("ORD-VEND1");
  assert.ok(o, "the order was received"); assert.equal(o.tokenid, MXUSD); assert.equal(o.currency, "USDT");
  assert.equal(o.paid, false, "5 Minima does not pay a 5 MxUSD order"); assert.equal(o.paidTokenid, "0x00");
  assert.match(o.problems.join(), /currency \(Minima\) is not your shop's \(MxUSD\)/, "and since 0.18.159 the order is UNCHECKED against the listing");
});

// ---- 0.18.159: a phone-placed order (wire: items as a JSON string, shipping by id) is checked and paid end to end ----
test("vendor: a phone-placed order to my shop is checked against my listing and paid by what it says is due", async () => {
  const me = shop.myIdentity(), buyer = await sc.deriveIdentity("a phone buyer");
  const order = { type: "ORDER", ref: "ORD-PHONE1", randomid: "r2", from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "tea", shopName: "Tea",
    items: JSON.stringify([{ product: "Tea", size: "", quantity: 2, unitPrice: "1.5", lineTotal: "3.0" }]), product: "Tea x2", amount: "0.000000001", currency: "Minima", tokenid: "0x00",
    shipping: "domestic", delivery: "x", message: "", buyerPayaddr: "" };
  const blob = await sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify(order), "utf8"));
  const ref = "0x" + Buffer.from("ORD-PHONE1", "utf8").toString("hex");
  let paid = "0.000000001";
  shop._setRunner(async (c) => {
    if (c.startsWith("coins address:" + shop.MINIMERCH)) return { status: true, response: [{ coinid: "0xD1", state: { "99": "0x" + blob } }] };
    if (c.startsWith("coins address:" + me.vendorAddress)) return { status: true, response: [{ coinid: paid === "0.000000001" ? "0xD201" : "0xD202", tokenid: "0x00", amount: paid, state: { "1": ref } }] };
    return { status: true, response: [] };
  });
  await shop.scanOnce();
  let o = store.order("ORD-PHONE1");
  assert.equal(o.items.length, 1, "the JSON string is read as items"); assert.equal(o.due, "3.2"); assert.deepEqual(o.problems, []);
  assert.equal(o.paid, false, "the buyer's 0.000000001 total paid with 1 nano is not paid"); assert.equal(o.status, "PENDING", "1 nano is dust (0.18.181)");
  paid = "3.2"; await shop.scanOnce();
  o = store.order("ORD-PHONE1"); assert.equal(o.paid, true); assert.equal(o.status, "PAID");
});

// ---- 0.18.163: a coin counts once across restarts; a buyer's object is never stored as sent ----
const freshModules = () => { for (const k of Object.keys(require.cache)) if (k.includes(path.join(__dirname, "..", "main"))) delete require.cache[k];
  return { store: require("../main/shop-store"), shop: require("../main/shop"), sc: require("../main/shopcrypto") }; };
test("H1: after a restart the backfill does not count the same payment coin again (a half-paid order stays half paid)", async () => {
  let m = freshModules(); m.store.setMeta("vendorAddress", "");   // this test names its own vendor address (0.18.205 keeps a stored one)
  m.store.saveShop({ shopId: "half", shopName: "Half", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] }); m.store.flush();
  const VADDR = "MxG0" + "C".repeat(56); let pay = [], msg = [];
  const runner = async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } }
    : c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: msg } : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] };
  m.shop._setRunner(runner); await m.shop.init();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("h1 buyer");
  const order = { type: "ORDER", ref: "ORD-HALF", randomid: "r", from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "half", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" };
  msg = [{ coinid: "0xA1", state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify(order))) } }];
  pay = [{ coinid: "0xB1", tokenid: "0x00", amount: "5", state: { "1": "0x" + Buffer.from("ORD-HALF").toString("hex") } }];
  await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-HALF").paidAmount, "5"); m.store.flush();
  m = freshModules(); m.shop._setRunner(runner); await m.shop.init();   // the app restarts: the scanner's memory is gone
  await m.shop.scanOnce();
  const o = m.store.order("ORD-HALF");
  assert.equal(o.paidAmount, "5", "the same coin is not added twice"); assert.equal(o.paid, false); assert.equal(o.status, "UNDERPAID");
  assert.equal(m.store.recordPayment("ORD-HALF", "5", "0x00", "0xb1"), "ALREADY", "a counted coin in any letter case");
  assert.equal(m.store.recordPayment("ORD-HALF", "5", "0x00"), null, "no coin id: nothing is counted");
  m.store.upsertOrder({ ref: "ORD-OTHER", role: "sell", shopId: "half", amount: "5", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" });
  assert.equal(m.store.recordPayment("ORD-OTHER", "5", "0x00", "0xB1"), "ALREADY", "one coin never counts for two orders");
  pay = pay.concat([{ coinid: "0xB2", tokenid: "0x00", amount: "5", state: { "1": "0x" + Buffer.from("ORD-HALF").toString("hex") } }]);
  await m.shop.scanOnce(); assert.equal(m.store.order("ORD-HALF").paid, true, "a second, different coin completes it");
});

test("H2: an item nested 12,000 arrays deep, or a nested quantity, is never stored; the store still saves and the batch goes on", async () => {
  const m = freshModules(); m.shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: "MxG0" + "C".repeat(56) } } : { status: true, response: [] });
  await m.shop.init();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("h2 buyer"), deep = "[".repeat(12000) + "]".repeat(12000);
  const base = { type: "ORDER", randomid: "r", from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "half", amount: "10", currency: "Minima", shipping: "" };
  const wire = (o, raw) => JSON.stringify(o).split('"@@"').join(raw);
  const msgs = [
    wire(Object.assign({}, base, { ref: "ORD-EVIL", items: [{ product: "Tea", quantity: 1, unitPrice: "10", x: "@@" }] }), deep),
    wire(Object.assign({}, base, { ref: "ORD-QTY", items: [{ product: "Tea", quantity: "@@", unitPrice: "10" }], fromname: "@@" }), deep),
    wire(Object.assign({}, base, { ref: "ORD-STR", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "@@", delivery: "@@", amount: "@@", date: "@@" }), deep),
    JSON.stringify(Object.assign({}, base, { ref: "ORD-LATER", items: [{ product: "Tea", quantity: 1, unitPrice: "10", lineTotal: "10".repeat(500) }], amount: "9".repeat(5000), note: "x" }))];
  const coins = [];
  for (let i = 0; i < msgs.length; i++) coins.push({ coinid: "0xE" + i, state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(msgs[i])) } });
  m.shop._setRunner(async (c) => c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: coins } : { status: true, response: [] });
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try { await m.shop.scanOnce(); } finally { console.error = err; }
  for (const ref of ["ORD-EVIL", "ORD-QTY", "ORD-STR", "ORD-LATER"]) assert.ok(m.store.order(ref), ref + " was received (the batch was not stopped)");
  assert.deepEqual(m.store.order("ORD-EVIL").items, [{ product: "Tea", quantity: 1, unitPrice: "10" }], "a line is rebuilt from its capped primitive fields only");
  assert.deepEqual(m.store.order("ORD-QTY").items, [{ product: "Tea", unitPrice: "10" }]); assert.equal(m.store.order("ORD-QTY").buyerName, "");
  const st = m.store.order("ORD-STR"); assert.equal(st.shipping, ""); assert.equal(st.delivery, ""); assert.equal(st.amount, "0"); assert.equal(typeof st.date, "number");
  const later = m.store.order("ORD-LATER"); assert.equal(later.amount.length, 80, "the buyer's amount is cut to 80"); assert.equal(later.items[0].lineTotal.length, 80);
  m.store.flush();
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, "shop.json"), "utf8"));
  for (const ref of ["ORD-EVIL", "ORD-QTY", "ORD-STR", "ORD-LATER"]) assert.ok(disk.orders[ref], ref + " is on disk");
  for (const ref of Object.keys(disk.orders)) assert.ok(Buffer.byteLength(JSON.stringify(disk.orders[ref])) <= 48 * 1024, ref + " is bounded");
  assert.deepEqual(errs, [], "nothing failed");
});

test("H2: a save that fails is logged, not swallowed", () => {
  const m = freshModules(); m.store.order("x");
  const errs = [], err = console.error, real = fs.writeFileSync; console.error = (...a) => errs.push(a.join(" "));
  fs.writeFileSync = () => { throw new Error("disk full"); };
  try { m.store.setMetaSync("k", 1); } finally { fs.writeFileSync = real; console.error = err; }
  assert.match(errs.join(), /\[miniMall\] shop\.json could not be saved: disk full/);
});

// ---- 0.18.166: a vendor sets only the three statuses the screen offers ----
test("L1: advanceStatus accepts only CONFIRMED, SHIPPED, DELIVERED", async () => {
  const m = freshModules(); const ref = "ORD-L1";
  m.store.upsertOrder({ ref, role: "sell", shopId: "half", amount: "1", currency: "Minima", tokenid: "0x00", status: "PAID", paid: true, items: [], shipping: "", counterparty: "0x00" });
  for (const bad of ["PAID", "PENDING", "REFUNDED", "confirmed", "CONFIRMED ", "__proto__", "x".repeat(100), null, 5, ["CONFIRMED"]]) await assert.rejects(m.shop.advanceStatus(ref, bad), /Unknown order status/, JSON.stringify(bad));
  assert.equal(m.store.order(ref).status, "PAID");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(/const flow = \["CONFIRMED", "SHIPPED", "DELIVERED"\]/.test(app), "the screen offers exactly these");
});

test("L3: currencies in a listing problem read MxUSD, never USDT", () => {
  const p = L.check({ currency: "mxUSDT", products: [], shipping: [] }, { items: [], shipping: "", currency: "Minima" }).problems.join(" ");
  assert.match(p, /not your shop's \(MxUSD\)/); assert.ok(!/USDT/i.test(p), p);
});

// ---- 0.18.181: dust cannot fill an order's coin list ----
test("dust (below 0.000001, or below the smaller of 1% of what is due and what is still due) is not counted and never blocks a real payment", () => {
  const m = freshModules(); let k = 0; const id = () => "0xD057" + (++k).toString(16);
  const ref = "ORD-DUST";
  m.store.saveShop({ shopId: "dust", shopName: "D", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "domestic", label: "Domestic", fee: "0.2" }] });
  m.store.upsertOrder({ ref, role: "sell", shopId: "dust", amount: "3.2", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 2, unitPrice: "1.5" }], shipping: "Domestic" });
  for (let i = 0; i < 1100; i++) assert.equal(m.store.recordPayment(ref, i % 2 ? "0.0000001" : "0.0001", "0x00", id()), "DUST");
  const o = m.store.order(ref); assert.equal((o.coins || []).length, 0, "no dust in the order's list"); assert.equal(o.paidAmount || "0", "0", "and none counted");
  assert.equal(m.store.recordPayment(ref, "0.032", "0x00", id()), "UNDERPAID", "1% of 3.2 is not dust");
  // CHANGED on purpose (0.18.226): at most 256 dust coins are gathered (1000 never fit the order's 1000-coin list beside its other
  // coins, so they never counted); the 256 largest (0.0001 each, 0.0256) cover the 0.018 the 3.15 leaves, so the order is paid then
  assert.equal(m.store.recordPayment(ref, "3.15", "0x00", id()), "PAID", "3.182 + the gathered 0.0256");
  assert.equal(m.store.order(ref).coins.length, 2 + m.store.PENDING_MAX);
  const t2 = "ORD-DUST3"; m.store.upsertOrder({ ref: t2, role: "sell", shopId: "dust", amount: "3.2", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 2, unitPrice: "1.5" }], shipping: "Domestic" });
  assert.equal(m.store.recordPayment(t2, "3.182", "0x00", id()), "UNDERPAID");
  assert.equal(m.store.recordPayment(t2, "0.018", "0x00", id()), "PAID", "a top-up of what is still due is never dust, however small");
  assert.equal(m.store.order(t2).coins.length, 2);
  const u = "ORD-DUST2"; m.store.upsertOrder({ ref: u, role: "sell", shopId: "nope", amount: "1", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [], shipping: "" });
  assert.equal(m.store.recordPayment(u, "0.0000009", "0x00", id()), "DUST", "an order with nothing due by the listing: the 0.000001 floor");
  assert.equal(m.store.recordPayment(u, "0.000001", "0x00", id()), "UNCHECKED");
});

// ---- 0.18.183: ids a peer writes read own entries only; a stored null line is not drawn ----
test("'__proto__' as a shop id, an order ref or a chat id finds nothing and writes nothing into the prototype", async () => {
  const m = freshModules(); m.shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: "MxG0" + "C".repeat(56) } } : { status: true, response: [] });
  await m.shop.init();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("proto buyer");
  const base = { type: "ORDER", randomid: "r", from: buyer.publicId, to: me.publicId, date: Date.now(), items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" };
  const msgs = [Object.assign({}, base, { ref: "ORD-PROTO1", shopId: "__proto__" }), Object.assign({}, base, { ref: "__proto__", shopId: "half" }),
    Object.assign({}, base, { ref: "ORD-PROTO3", shopId: "constructor" })];
  const coins = []; for (let i = 0; i < msgs.length; i++) coins.push({ coinid: "0xF1" + i, state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify(msgs[i]))) } });
  m.shop._setRunner(async (c) => c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: coins } : { status: true, response: [] });
  await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-PROTO1"), null, "no order for a shop named __proto__"); assert.equal(m.store.order("ORD-PROTO3"), null, "nor constructor");
  assert.equal(m.store.order("__proto__"), null); assert.equal(m.store.shop("__proto__"), null); assert.equal(m.store.shop("toString"), null);
  assert.equal(m.store.recordPayment("__proto__", "10", "0x00", "0xF1F1"), null);
  assert.equal(m.store.upsertOrder({ ref: "__proto__", role: "sell" }), false);
  assert.equal(m.store.addChat({ randomid: "__proto__", ref: "x" }), false);
  assert.throws(() => m.store.saveShop({ shopId: "__proto__" }), /Invalid shop id/);
  assert.equal({}.coins, undefined); assert.equal({}.paidAmount, undefined); assert.equal({}.status, undefined, "Object.prototype untouched");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("const items = (o.items || []).filter(Boolean).map(i =>"), "a stored null line is not drawn");
});

// ---- 0.18.185: dust is judged again later; payments are read oldest first ----
// CHANGED on purpose (0.18.289): the stand-in nodes of this and the next tests answer `block` (5000): a payment is judged only once the
// chain is more than PAY_BEFORE_ORDER blocks past it, and with no tip nothing is judged
test("a 9.95 payment and a 0.05 top-up pay a 10 order, in either order and in one scan or two; 5000 dust coins write nothing", async () => {
  const m = freshModules(); const VADDR = "MxG0" + "F".repeat(56);
  m.store.setMeta("vendorAddress", "");   // this test names its own vendor address (0.18.205 keeps a stored one)
  m.store.saveShop({ shopId: "topup", shopName: "T", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  let pay = [], msg = [];
  m.shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } } : c === "block" ? { status: true, response: { block: 5000 } }
    : c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: msg } : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] });
  await m.shop.init();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("topup buyer");
  const order = async (ref) => { msg = [{ coinid: "0xE0" + Buffer.from(ref).toString("hex"), state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref, from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "topup", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" }))) } }]; await m.shop.scanOnce(); };
  const st = (ref) => ({ "1": "0x" + Buffer.from(ref).toString("hex") });
  const cases = [["ORD-TU1", [[0x11, "0.05", 101], [0x12, "9.95", 100]], "newest first, different blocks"],
    ["ORD-TU2", [[0x22, "9.95", 100], [0x21, "0.05", 101]], "oldest first"],
    ["ORD-TU3", [[0x31, "0.05", 100], [0x32, "9.95", 100]], "the same block, the top-up listed first"]];
  for (const [ref, cs, what] of cases) {
    await order(ref);
    pay = cs.map(([id, amount, created]) => ({ coinid: "0x" + id.toString(16), tokenid: "0x00", amount, created, state: st(ref) }));
    await m.shop.scanOnce();
    assert.equal(m.store.order(ref).paid, true, what); assert.equal(m.store.order(ref).paidAmount, "10.00");
  }
  await order("ORD-TU4");   // two scans: the top-up is seen first, alone (dust then), and is judged again once the 9.95 is in
  pay = [{ coinid: "0x41", tokenid: "0x00", amount: "0.05", created: 105, state: st("ORD-TU4") }];
  await m.shop.scanOnce(); assert.equal(m.store.order("ORD-TU4").paid, false);
  pay = [pay[0], { coinid: "0x42", tokenid: "0x00", amount: "9.95", created: 106, state: st("ORD-TU4") }];
  await m.shop.scanOnce(); assert.equal(m.store.order("ORD-TU4").paid, true, "two scans");
  m.store.flush();
  const file = path.join(DIR, "shop.json"), before = fs.readFileSync(file, "utf8");
  await order("ORD-TU5"); m.store.flush(); const withOrder = fs.readFileSync(file, "utf8");
  let writes = 0; const real = fs.writeFileSync; fs.writeFileSync = function () { writes++; return real.apply(this, arguments); };
  try { for (let i = 0; i < 5000; i++) assert.equal(m.store.recordPayment("ORD-TU5", "0.0000001", "0x00", "0x" + (0x100000 + i).toString(16)), "DUST"); }
  finally { fs.writeFileSync = real; }
  assert.equal(writes, 0, "no save for a dust coin"); m.store.flush();
  assert.equal(fs.readFileSync(file, "utf8").length, withOrder.length, "the store is the same size after 5000 dust coins");
  assert.ok(before.length > 0);
});

// ---- 0.18.190: an order's dust counts together once it covers what is still due ----
test("9.9 + 0.05 + 0.05 pays a 10 order in any order and across a restart; a flood of dust that never covers the remainder writes nothing", async () => {
  const VADDR = "MxG0" + "9".repeat(56);
  let m = freshModules(), pay = [], msg = []; m.store.setMeta("vendorAddress", "");   // this test names its own vendor address (0.18.205 keeps a stored one)
  const runner = () => async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } } : c === "block" ? { status: true, response: { block: 5000 } }
    : c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: msg } : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] };
  m.store.saveShop({ shopId: "dust3", shopName: "D", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  m.shop._setRunner(runner()); await m.shop.init();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("dust3 buyer");
  const order = async (ref) => { msg = [{ coinid: "0xE1" + Buffer.from(ref).toString("hex"), state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref, from: buyer.publicId, to: me.publicId, date: Date.now(), shopId: "dust3", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" }))) } }]; await m.shop.scanOnce(); };
  const coin = (ref, id, amount, created) => ({ coinid: id, tokenid: "0x00", amount, created, state: { "1": "0x" + Buffer.from(ref).toString("hex") } });
  const orders = [["ORD-DS1", [["0x91", "9.9", 1], ["0x92", "0.05", 2], ["0x93", "0.05", 3]]], ["ORD-DS2", [["0x94", "0.05", 1], ["0x95", "0.05", 2], ["0x96", "9.9", 3]]],
    ["ORD-DS3", [["0x97", "0.05", 1], ["0x98", "9.9", 2], ["0x99", "0.05", 3]]], ["ORD-DS4", [["0x9a", "0.05", 5], ["0x9b", "9.9", 5], ["0x9c", "0.05", 5]]]];
  for (const [ref, cs] of orders) {
    await order(ref); pay = cs.map(([id, a, cr]) => coin(ref, id, a, cr)); await m.shop.scanOnce();
    assert.equal(m.store.order(ref).paid, true, ref); assert.equal(m.store.order(ref).paidAmount.replace(/0+$/, ""), "10.");
  }
  for (const [id, a] of [["0x9d", "9.9"], ["0x9e", "0.05"], ["0x9f", "0.05"]]) {   // directly, newest first
    if (id === "0x9d") m.store.upsertOrder({ ref: "ORD-DS5", role: "sell", shopId: "dust3", amount: "10", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" });
  }
  assert.equal(m.store.recordPayment("ORD-DS5", "0.05", "0x00", "0x9e"), "DUST"); assert.equal(m.store.recordPayment("ORD-DS5", "0.05", "0x00", "0x9f"), "DUST");
  assert.equal(m.store.recordPayment("ORD-DS5", "9.9", "0x00", "0x9d"), "PAID", "the gathered dust covers what the 9.9 leaves");
  // across a restart: the 9.9 and one 0.05 were seen before; the memory of the dust is gone; the next scan gathers it again
  await order("ORD-DS6"); pay = [coin("ORD-DS6", "0xa1", "9.9", 1), coin("ORD-DS6", "0xa2", "0.05", 2)]; await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-DS6").paid, false); m.store.flush();
  m = freshModules(); m.shop._setRunner(runner()); await m.shop.init();
  pay = [coin("ORD-DS6", "0xa1", "9.9", 1), coin("ORD-DS6", "0xa2", "0.05", 2), coin("ORD-DS6", "0xa3", "0.05", 3)]; await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-DS6").paid, true, "after a restart"); m.store.flush();
  const file = path.join(DIR, "shop.json"), size = fs.readFileSync(file, "utf8").length;
  await order("ORD-DS7"); m.store.flush(); const withOrder = fs.readFileSync(file, "utf8").length; assert.ok(withOrder >= size);
  let writes = 0; const real = fs.writeFileSync; fs.writeFileSync = function () { writes++; return real.apply(this, arguments); };
  try { for (let i = 0; i < 5000; i++) assert.equal(m.store.recordPayment("ORD-DS7", "0.0000001", "0x00", "0x" + (0x200000 + i).toString(16)), "DUST"); } finally { fs.writeFileSync = real; }
  assert.equal(writes, 0, "5000 dust coins that do not cover 10 write nothing"); m.store.flush(); assert.equal(fs.readFileSync(file, "utf8").length, withOrder);
});

// ---- 0.18.202: one currency mapping; the order's own coin list is the authority; clear() forgets gathered dust ----
test("one currency mapping; a coin is never counted twice by its order even after the short global list moved on; clear() empties the dust", () => {
  const R2 = require("../renderer/shop-rules.js"), MXU = R2.MXUSD;
  for (const [c, t] of [["Minima", "0x00"], ["MINIMA", "0x00"], ["USDT", MXU], ["mxUSDT", MXU], ["BTC", ""], ["", ""]]) assert.equal(R2.tokenOfCurrency(c), t, c);
  const m = freshModules();
  assert.equal(m.shop.tokenFor("USDT"), MXU); assert.equal(m.shop.tokenFor("anything"), "0x00", "the vendor's own shop: unknown is Minima, as before");
  m.store.saveShop({ shopId: "own1", shopName: "O", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "1000000", maxUnits: "1" }], shipping: [] });
  m.store.upsertOrder({ ref: "ORD-OWN", role: "sell", shopId: "own1", amount: "1000000", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "1000000" }], shipping: "" });
  assert.equal(m.store.recordPayment("ORD-OWN", "20000", "0x00", "0xFEED01"), "UNDERPAID");
  m.store.upsertOrder({ ref: "ORD-FLOOD", role: "sell", shopId: "own1", amount: "1000000", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "1000000" }], shipping: "" });
  for (let i = 0; i < 999; i++) m.store.recordPayment("ORD-FLOOD", "10000", "0x00", "0x" + (0x500000 + i).toString(16));
  for (let j = 0; j < 6; j++) { const r = "ORD-FL" + j; m.store.upsertOrder({ ref: r, role: "sell", shopId: "own1", amount: "1000000", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "1000000" }], shipping: "" });
    for (let i = 0; i < 900; i++) m.store.recordPayment(r, "10000", "0x00", "0x" + (0x600000 + j * 1000 + i).toString(16)); }
  assert.equal(m.store.recordPayment("ORD-OWN", "20000", "0x00", "0xFEED01"), "ALREADY", "the global list no longer holds it; the order's own list does");
  m.store.upsertOrder({ ref: "ORD-CLR", role: "sell", shopId: "own1", amount: "1000000", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "1000000" }], shipping: "" });
  assert.equal(m.store.recordPayment("ORD-CLR", "0.0000001", "0x00", "0xD0D0"), "DUST");
  m.store.clear();
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "shop-store.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(/function clear\(\) \{[^\n]*PENDING_DUST\.clear\(\);/.test(src) && /const COUNTED_MAX = 5000,/.test(src));
});

// ---- 0.18.205: the vendor address stays; every published payout address is read ----
test("vendor: the address buyers pay stays the same across restarts, and payments to any shop's published address are seen", async () => {
  let m = freshModules(); m.store.clear(); m.store.flush();
  const A0 = "MxG0" + "0".repeat(56), A1 = "MxG0" + "1".repeat(56), A2 = "MxG0" + "2".repeat(56);
  let next = A1; const asked = [];
  const runner = () => async (c) => { asked.push(c); return c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: next } } : c === "block" ? { status: true, response: { block: 5000 } }
    : c.startsWith("coins address:" + A0) ? { status: true, response: [{ coinid: "0xAD01", tokenid: "0x00", amount: "10", created: 1, state: { "1": "0x" + Buffer.from("ORD-ADDR").toString("hex") } }] } : { status: true, response: [] }; };
  m.shop._setRunner(runner()); await m.shop.init();
  assert.equal(m.shop.myIdentity().vendorAddress, A1);
  m.store.saveShop({ shopId: "addr", shopName: "A", currency: "Minima", vendorAddress: A0, products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  m.store.upsertOrder({ ref: "ORD-ADDR", role: "sell", shopId: "addr", amount: "10", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" });
  m.store.flush();
  m = freshModules(); next = A2; asked.length = 0; m.shop._setRunner(runner()); await m.shop.init();
  assert.equal(m.shop.myIdentity().vendorAddress, A1, "not moved to a new random default address on restart");
  assert.ok(!asked.some(c => c.startsWith("getaddress")), "not even asked");
  assert.ok(asked.includes("coinnotify action:add address:" + A0), "the shop's published address is watched too");
  await m.shop.scanOnce();
  assert.ok(asked.some(c => c.startsWith("coins address:" + A0)) && asked.some(c => c.startsWith("coins address:" + A1)), "both read");
  assert.equal(m.store.order("ORD-ADDR").paid, true, "a payment to the published address is seen");
});

// ---- 0.18.206: what was read is remembered; a gap is walked by a paced backfill ----
// CHANGED on purpose (0.18.277, correcting 0.18.276): a stand-in node shaped as core/minima-core e64600285be serves `coins address:`:
// the walk visits blocks tip..tip-depth while the in-memory tree lasts (L blocks: cut at 1124, back to 1024, so 1024 to 1123), and the
// tree's ROOT carries every RELEVANT UNSPENT coin of the pruned history (copyParentRelevantCoins), so a payments read that reaches the
// root returns this wallet's unspent payment coins of any age; orders on the shared channel and spent payments are lost past the tree.
// A reply too large for the node (cap) comes back as a non-list, as the app sees the RPC's reply cap.
const javaNode = (m, st) => async (c) => {
  if (c.startsWith("vault")) return { status: true, response: { phrase: "vendor seed h1" } };
  if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: st.vaddr } };
  if (c === "block") return { status: true, response: { block: st.tip } };
  const d = Number((/depth:(\d+)/.exec(c) || [])[1] || 1e9), visits = Math.min(d, st.L - 1), inTree = (x) => st.tip - x.created <= visits;
  if (c.startsWith("coins address:" + m.shop.MINIMERCH)) {
    st.depths.push(d); if (st.hook) { const r = st.hook(d); if (r) return r; }
    if (st.mode === "refuse") return { status: false, error: "busy" }; if (st.mode === "throw") throw new Error("RPC timed out");
    return { status: true, response: st.msg.filter(x => x.created <= st.tip && inTree(x)) };
  }
  // a spent coin is never returned (the walk meets its spent marker first, 0.18.281: the stand-in returned it inside the tree)
  if (c.startsWith("coins address:" + st.vaddr)) { st.payDepths.push(d); return { status: true, response: st.pay.filter(x => x.created <= st.tip && !x.spent && (inTree(x) || d >= st.L - 1)) }; }
  return { status: true, response: [] };
};
const javaSetup = async (name, extra) => {
  let m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const st = Object.assign({ vaddr: "MxG0" + "7".repeat(56), tip: 1000, L: 1100, msg: [], pay: [], depths: [], payDepths: [], mode: "ok", hook: null }, extra || {});
  m.store.saveShop({ shopId: name, shopName: "G", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "1", maxUnits: "5" }], shipping: [] });
  m.shop._setRunner(javaNode(m, st)); await m.shop.init(); await m.shop.scanOnce();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity(name + " buyer");
  const seal = async (ref, created) => ({ coinid: "0x" + Buffer.from(ref).toString("hex"), created, state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref, from: buyer.publicId, to: me.publicId, date: 1, shopId: name, items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "" }))) } });
  const pay = (ref, created, spent) => ({ coinid: "0xFA" + Buffer.from(ref).toString("hex"), tokenid: "0x00", amount: "1", created, spent: !!spent, state: { "1": "0x" + Buffer.from(ref).toString("hex") } });
  const reopen = () => { m.store.flush(); m = freshModules(); m.shop._setRunner(javaNode(m, st)); return m.shop.init().then(() => m); };
  return { get m() { return m; }, st, seal, pay, reopen };
};

// restored from v0.18.272 (shaped to the node): an order sent while the app was closed is read after a restart through the backfill; a node
// whose reply is cut at every pass ends the backfill and says why
test("an order sent while the app was closed is read through the backfill after the first window was cut by the reply cap; a node that serves no deeper ends the backfill", async () => {
  const t = await javaSetup("gap");
  assert.equal(t.st.depths[0], 256, "the very first pass"); assert.equal(Number(t.m.store.getMeta("scanTip")), 1000);
  t.st.msg = [await t.seal("ORD-GAP", 1100)];
  let m = await t.reopen(); t.st.tip = 1800; t.st.depths.length = 0; let first = true;
  t.st.hook = (d) => { if (first) { first = false; if (d > 404) return { status: true, response: { tooBig: true } }; } return null; };   // the first window comes back as no list
  await m.shop.scanOnce();
  assert.ok(m.store.order("ORD-GAP"), "read by the backfill step in the same pass"); assert.equal(Number(m.store.getMeta("bfTarget")), 0, "the backfill is done");
  assert.ok(t.st.depths.every(d => d <= 1024), "no step past what the tree surely holds: " + t.st.depths);
  // a node whose reply is cut at every pass: after two more tries the backfill ends, and the cause is said (not the app being closed)
  t.st.msg.push(await t.seal("ORD-DEEP", 1830)); m = await t.reopen(); t.st.tip = 2600; t.st.hook = (d) => (d > 300 ? { status: true, response: { tooBig: true } } : null);
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try { for (let i = 0; i < 4; i++, t.st.tip++) await m.shop.scanOnce(); } finally { console.error = err; }
  assert.match(errs.join(), /older than block \d+ may not have been read: the node's answer for older blocks was too large/); assert.equal(Number(m.store.getMeta("bfTarget")), 0);
  assert.match(m.shop.scanState().text, /may not have been read: the node's answer for older blocks was too large\./); assert.ok(!/closed longer/.test(m.shop.scanState().text));
});
// M1 (0.18.277): a payment made while the app was closed, older than the tree when it reopens, is found at the root and pays the order
test("a payment older than the node's tree is found at the tree's root and pays the order; only orders older than the floor, and payments already spent, are said as not read", async () => {
  const t = await javaSetup("root");
  t.st.msg = [await t.seal("ORD-A", 995)]; t.st.tip = 1001; await t.m.shop.scanOnce(); assert.ok(t.m.store.order("ORD-A"), "the order is read while open");
  t.st.pay = [t.pay("ORD-A", 1010), t.pay("ORD-X", 1020, true)];   // paid 15 blocks later while closed; another, already spent
  const m = await t.reopen(); t.st.tip = 2500; t.st.depths.length = 0; t.st.payDepths.length = 0;
  await m.shop.scanOnce();
  assert.equal((m.store.order("ORD-A") || {}).paid, true, "paid: the root carries the unspent coin");
  assert.ok(t.st.payDepths.includes(1124), "one payments read deep enough to reach the root: " + t.st.payDepths); assert.ok(t.st.depths.includes(1123), "orders read as deep as the tree may hold");
  assert.equal(Number(m.store.getMeta("unreadBelow")), 2500 - 1024);
  assert.equal(m.shop.scanState().text, "Orders older than block 1476, and payments to your shops that were already spent, may not have been read: the node keeps only its recent blocks. Payments not yet spent were read.");
});
// M2 (0.18.277): after the first window is cut and a step fails, the servable gap inside the tree is read, not dropped
test("after the first window is cut to 512 and one step fails, an order inside the tree is read; a gap is declared past the tree only from the floor", async () => {
  const t = await javaSetup("m2"); const T0 = 1000;
  t.st.msg = [await t.seal("ORD-B", T0 + 1500 - 700)];
  const m = await t.reopen(); t.st.tip = T0 + 1500; t.st.depths.length = 0;
  let pass = 0; t.st.hook = (d) => (pass === 0 && d > 512 ? { status: true, response: { tooBig: true } } : pass === 1 && d > 64 ? { status: false, error: "busy" } : null);
  for (; pass < 6; pass++, t.st.tip++) await m.shop.scanOnce();
  assert.ok(m.store.order("ORD-B"), "the order inside the tree is read: " + t.st.depths);
  assert.ok(Number(m.store.getMeta("unreadBelow")) >= T0 && Number(m.store.getMeta("unreadBelow")) <= t.st.tip - 1024, "said from the floor, which is never above what the tree surely holds");
});
// restored from the 0.18.213 test: a failed or thrown read moves nothing; the backfill state is said; a failed step moves nothing and is said as older;
// a second gap keeps the oldest target; a step reads only below what was read (floor); a chain below the cursor moves nothing
test("a failed read moves nothing and is said as recent; a failed backfill step moves nothing and is said as older; a second gap keeps the oldest target; a resync moves the cursor down and is no failure", async () => {
  const t = await javaSetup("fail"); let m = t.m;
  t.st.msg = [await t.seal("ORD-NEWEST", 1500)];
  for (const mo of ["refuse", "throw"]) {
    t.st.mode = mo; t.st.tip = 1800; await m.shop.scanOnce();
    assert.equal(Number(m.store.getMeta("scanTip")), 1000, mo + ": the scan tip does not advance"); assert.equal(Number(m.store.getMeta("bfTarget") || 0), 0, mo + ": no backfill invented");
    assert.match(m.shop.scanState().text, /Recent orders could not be read: the node did not answer/, mo);
  }
  // the first window cut by the reply cap, the step refused: the backfill state is kept and the failed step said as older
  t.st.mode = "ok"; t.st.tip = 1801; let calls = 0; t.st.hook = (d) => { calls++; if (calls === 1 && d > 404) return { status: true, response: { tooBig: true } }; if (calls >= 3) throw new Error("RPC timed out"); return null; };
  await m.shop.scanOnce();
  assert.ok(m.store.order("ORD-NEWEST"), "the newest part is read"); assert.equal(Number(m.store.getMeta("bfTarget")), 1000);
  assert.match(m.shop.scanState().text, /Older orders could not be read yet: the node did not answer/);
  const floor = Number(m.store.getMeta("bfFloor")); assert.equal(Number(m.store.getMeta("scanTip")), 1801);
  t.st.hook = (d) => { if (d > 64) throw new Error("RPC timed out"); return null; }; t.st.tip = 1802; await m.shop.scanOnce();
  assert.equal(Number(m.store.getMeta("bfFloor")), floor, "a backfill step that fails moves nothing"); assert.equal(Number(m.store.getMeta("bfTarget")), 1000);
  t.st.hook = (d) => (d > 64 ? { status: true, response: { tooBig: true } } : null); t.st.tip = 1803; await m.shop.scanOnce();   // a step cut short: the state is said
  assert.match(m.shop.scanState().text, /Reading orders and payments from while the app was closed \(back to block 1000\)\./);
  // a second gap while the first is pending: the target stays the oldest, the floor moves under the new window (window cut so the gap stays in the tree)
  let once = true; t.st.hook = (d) => { if (once) { once = false; if (d > 512) return { status: true, response: { tooBig: true } }; } return null; };
  t.st.tip = 3000; await m.shop.scanOnce();
  assert.equal(Number(m.store.getMeta("bfTarget")), 1000, "the oldest target is kept"); assert.ok(Number(m.store.getMeta("bfFloor")) < 3000 - 512, "the floor moves under the new window");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "shop.js"), "utf8").replace(/\r\n/g, "\n");
  // CHANGED on purpose (0.18.282): orders skip what an earlier pass read; payments never do (a payment seen before its order was not counted);
  // CHANGED on purpose (0.18.300): the payments read is given its depth only again, as released 0.18.286 (0.18.289 to 0.18.299 gave it the tip
  // it judged against, and 0.18.294 the block from which its orders were known read: a coin below it waited, and could be spent first)
  assert.ok(/scanOrders\(deep, floor\)/.test(src) && /scanPayments\(deep\)/.test(src) && /scanOrders\(NODE_TREE_MOST, floor\)/.test(src) && /scanPayments\(ROOT_DEPTH\)/.test(src) && !/scanPayments\([^)]*(floor|tip)/.test(src), "orders skip what an earlier pass read, payments do not");
  // CHANGED on purpose (0.18.281): a resync or a lower branch: the cursor follows the chain down, no failure is said, a pending backfill waits
  m.store.setMeta("bfTarget", 1900); m.store.setMeta("bfFloor", 1950); t.st.hook = null; const cur = Number(m.store.getMeta("scanTip")); t.st.tip = 300; t.st.depths.length = 0; await m.shop.scanOnce();
  assert.ok(cur > 300); assert.equal(Number(m.store.getMeta("scanTip")), 300, "the cursor follows the chain down"); assert.equal(m.shop.scanState().readFailed, false, "not a failure"); assert.equal(Number(m.store.getMeta("bfTarget")), 1900, "the backfill waits");
  assert.ok(/ipcMain\.handle\("mcd:shopScanState", \(\) => shop\.scanState\(\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8")));
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").includes("const scanLine = scan && scan.text ?"), "shown on the orders screen");
});
// 0.18.281: a reorganisation onto a lower branch, then a catch-up faster than the 64-block poll: the new branch's blocks below the old
// cursor are read (the cursor stayed at the old tip, so every block between passes was skipped; v0.18.272 read them)
test("after a reorganisation onto a lower branch and a fast catch-up, the new branch's orders and payments below the old cursor are read", async () => {
  const t = await javaSetup("reorg"); const m = t.m;
  t.st.tip = 1500; await m.shop.scanOnce(); assert.equal(Number(m.store.getMeta("scanTip")), 1500);
  t.st.msg = [await t.seal("ORD-B1", 1110), await t.seal("ORD-B2", 1215), await t.seal("ORD-B3", 1320)]; t.st.pay = [t.pay("ORD-B1", 1112)];
  for (const tip of [1100, 1200, 1300, 1400, 1500, 1501]) { t.st.tip = tip; await m.shop.scanOnce(); assert.equal(m.shop.scanState().readFailed, false, "no failure at " + tip); }
  for (const r of ["ORD-B1", "ORD-B2", "ORD-B3"]) assert.ok(m.store.order(r), r + " on the new branch is read");
  assert.equal(m.store.order("ORD-B1").paid, true, "and its payment counted"); assert.equal(Number(m.store.getMeta("scanTip")), 1501);
});
// 0.18.282: an order below a window or step boundary and its payment above it: the payment was seen while the order was unknown (so not
// counted, not marked seen) and then skipped for ever by the floor; it is counted once the order is read, and only once
test("a payment read before its order (the order below a window or step boundary, the payment above it) pays the order once", async () => {
  // the 1024-block window's boundary, the gap then past the tree
  for (const T of [2500, 2100]) {
    const t = await javaSetup("straddle" + T); t.st.msg = [await t.seal("ORD-ST", T - 1030)]; t.st.pay = [t.pay("ORD-ST", T - 1020)];
    const m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = T + i; await m.shop.scanOnce(); }
    assert.equal(m.store.order("ORD-ST").paid, true, "window boundary, closed until " + T); assert.equal(Number(m.store.order("ORD-ST").paidAmount), 1);
  }
  // a backfill step's boundary: the first window cut to 512 by the reply cap
  { const T = 2500, t = await javaSetup("straddlestep"); t.st.msg = [await t.seal("ORD-ST", T - 530)]; t.st.pay = [t.pay("ORD-ST", T - 500)];
    const m = await t.reopen(); let first = true; t.st.hook = (d) => { if (first) { first = false; if (d > 512) return { status: true, response: { tooBig: true } }; } return null; };
    for (let i = 0; i < 6; i++) { t.st.tip = T + i; await m.shop.scanOnce(); }
    assert.equal(m.store.order("ORD-ST").paid, true, "step boundary"); assert.equal(Number(m.store.order("ORD-ST").paidAmount), 1); }
  // gathered dust read again on every pass still totals once: 0.6 + 0.4 pay the 1 due, the later 0.4 is not added
  { const T = 2500, t = await javaSetup("straddledust"); t.st.msg = [await t.seal("ORD-D", T - 1030)];
    t.st.pay = [Object.assign(t.pay("ORD-D", T - 1020), { coinid: "0xFA01", amount: "0.6" }), Object.assign(t.pay("ORD-D", T - 1019), { coinid: "0xFA02", amount: "0.4" }), Object.assign(t.pay("ORD-D", T - 5), { coinid: "0xFA03", amount: "0.4" })];
    const m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = T + i; await m.shop.scanOnce(); }
    const o = m.store.order("ORD-D"); assert.equal(o.paid, true); assert.equal(Number(o.paidAmount), 1, "counted once: " + o.paidAmount); assert.equal(o.coins.length, 2); }
});
// 0.18.283: past the tree, the orders read and the payments read are judged each by its own depth: an orders read the reply cap cut is
// tried on two more passes and then said with that cause (it ended at once, as "the node keeps only its recent blocks"); a stall count is
// never carried into a new gap or past the end of a backfill; what is said is "may not have been read" (a longer tree read some of it)
test("past the tree: a cut orders read is retried and then said with the reply cap as cause; the stall count resets; 'may not have been read'", async () => {
  const t = await javaSetup("treecut"); const T = 2500;
  t.st.msg = [await t.seal("ORD-TB", T - 1060)]; t.st.pay = [t.pay("ORD-TB", T - 1058)];
  const m = await t.reopen(); t.st.hook = (d) => (d > 1024 ? { status: true, response: { tooBig: true } } : null);
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try {
    t.st.tip = T; await m.shop.scanOnce(); assert.equal(Number(m.store.getMeta("bfTarget")), 1000, "a cut orders read does not end the backfill at once");
    t.st.tip++; await m.shop.scanOnce(); assert.equal(Number(m.store.getMeta("bfTarget")), 1000);
    t.st.tip++; await m.shop.scanOnce();
  } finally { console.error = err; }
  assert.equal(Number(m.store.getMeta("bfTarget")), 0, "ended after two more tries"); assert.equal(Number(m.store.getMeta("bfStall")), 0);
  assert.equal(m.shop.scanState().text, "Orders older than block " + m.store.getMeta("unreadBelow") + ", and payments to your shops that were already spent, may not have been read: the node's answer for older blocks was too large. Payments not yet spent were read.");
  assert.ok(errs.some(e => /may not have been read: the node's answer for older blocks was too large/.test(e)), "the log says the same");
  // a stall left from an earlier backfill is not carried into a new gap
  m.store.setMeta("bfStall", 2); t.st.hook = null; m.store.setMeta("bfTarget", 0); m.store.setMeta("bfFloor", 0);
  let first = true; t.st.hook = (d) => { if (first) { first = false; if (d > 512) return { status: true, response: { tooBig: true } }; } return d > 64 ? { status: true, response: { tooBig: true } } : null; };
  t.st.tip = 3600; await m.shop.scanOnce();
  assert.ok(Number(m.store.getMeta("bfTarget")) > 0, "a new gap registers, and one capped step does not end it: " + m.store.getMeta("bfStall"));
  assert.equal(Number(m.store.getMeta("bfStall")), 1, "counted from 0 for the new gap");
});
// 0.18.285: a payment's reference is plain text on chain; someone who copies it into an order of their own, while the real order is not
// held here, must not have their order paid by another buyer's coin. A payment older than its order (beyond PAY_BEFORE_ORDER blocks)
// holds the order for a check by hand; a real buyer always sends the order first
test("an order whose payment is older than the order is held for a check by hand (a copied reference); a real order then payment still pays", async () => {
  const sealAs = async (t, who, ref, created) => { const me = t.m.shop.myIdentity(); return { coinid: "0xAA" + Buffer.from(who.publicId.slice(0, 6) + ref).toString("hex"), created,
    state: { "99": "0x" + await t.m.sc.seal(who, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref + "a", from: who.publicId, to: me.publicId, date: 1, shopId: t.shopId, items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "", delivery: "ATTACKER" }))) } }; };
  const held = (m, payBlock) => { const o = m.store.order("ORD-X"); assert.ok(o && o.delivery === "ATTACKER", "the copier's order is the one held");
    assert.equal(o.paid, false, "nobody is paid automatically"); assert.equal(o.status, "UNCHECKED");
    assert.ok(o.problems.some(p => p.startsWith("a payment with this order's reference is older than the order (payment coin 0xFA" + Buffer.from("ORD-X").toString("hex") + " at block " + payBlock + ", the order at block ")), o.problems.join(" | ")); };
  const run = async (name, fn) => { const t = await javaSetup(name); t.shopId = name; t.atk = await t.m.sc.deriveIdentity("attacker seed"); return fn(t); };
  // the real order older than the tree at reopen, its payment unspent (root); the copier's order inside the tree
  await run("atk1", async (t) => {
    t.st.msg = [await t.seal("ORD-X", 1003), await sealAs(t, t.atk, "ORD-X", 2490)]; t.st.pay = [t.pay("ORD-X", 1005)];
    const m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = 2500 + i; await m.shop.scanOnce(); } held(m, 1005); });
  // the copier's order lands during the backfill; the payment is a late one inside the first window
  await run("atk2", async (t) => {
    t.st.msg = [await t.seal("ORD-X", 1003)]; t.st.pay = [t.pay("ORD-X", 2400)];
    const m = await t.reopen(); let first = true; t.st.hook = (d) => { if (first && d > 512) { first = false; return { status: true, response: { tooBig: true } }; } return null; };
    t.st.tip = 2500; await m.shop.scanOnce(); t.st.msg.push(await sealAs(t, t.atk, "ORD-X", 2501));
    for (let i = 1; i < 7; i++) { t.st.tip = 2500 + i; await m.shop.scanOnce(); } held(m, 2400); });
  // the copier's order lands after the backfill, then the vendor closes again for long (the root read returns the old payment)
  await run("atk3", async (t) => {
    t.st.msg = [await t.seal("ORD-X", 1003)]; t.st.pay = [t.pay("ORD-X", 1500)];
    let m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = 2500 + i; await m.shop.scanOnce(); }
    t.st.msg.push(await sealAs(t, t.atk, "ORD-X", t.st.tip)); for (let i = 0; i < 3; i++) { t.st.tip++; await m.shop.scanOnce(); }
    m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = 4500 + i; await m.shop.scanOnce(); } held(m, 1500); });
  // a real order then its payment: same block, 1 to 3 blocks earlier by mining order, or later, pays; 4 blocks earlier is held
  for (const [k, paid] of [[0, true], [1, true], [2, true], [3, true], [-5, true], [4, false]]) {
    const t = await javaSetup("real" + (k + 10)); t.st.msg = [await t.seal("ORD-R", 1010)]; t.st.pay = [t.pay("ORD-R", 1010 - k)];
    t.st.tip = 1020; await t.m.shop.scanOnce(); const o = t.m.store.order("ORD-R");
    assert.equal(o.orderBlock, 1010, "the order coin's block is kept"); assert.equal(o.paid, paid, "payment " + k + " blocks before the order");
    if (!paid) assert.equal(o.status, "UNCHECKED");
  }
  // an order stored before 0.18.285 has no block: unknown, so no hold (as before)
  { const t = await javaSetup("legacy"); t.st.msg = [await t.seal("ORD-L", 1010)]; t.st.tip = 1011; await t.m.shop.scanOnce();
    delete t.m.store.order("ORD-L").orderBlock; t.m.store.setMeta("x", 1); t.st.pay = [t.pay("ORD-L", 1003)]; const m = await t.reopen(); t.st.tip = 1012; await m.shop.scanOnce();
    assert.equal(m.store.order("ORD-L").orderBlock, undefined);
    assert.equal(m.store.order("ORD-L").paid, true, "no block: paid as before"); }
});
// CHANGED on purpose (0.18.300): a payment is counted the first time it is read, as released 0.18.286 (0.18.289 to 0.18.299 left it unjudged
// until tip pb + 3, and a coin still waiting could be spent by the vendor's own wallet before it was ever counted). An order without a secret
// paid in full SETTLES: it cannot be confirmed until a pass whose orders read succeeded has reached the newest coin's block + 3, so a real
// order mined within the allowance meets the copier's as a second buyer's first; an order marked PAID (not moved on, not checked by hand)
// that meets a second buyer's order with its reference is held again for a check by hand (0.18.289)
const sealFrom = async (t, who, ref, created, delivery) => { const me = t.m.shop.myIdentity(); return { coinid: "0xAB" + Buffer.from(who.publicId.slice(0, 6) + ref + created).toString("hex"), created,
  state: { "99": "0x" + await t.m.sc.seal(who, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref + created, from: who.publicId, to: me.publicId, date: 1, shopId: t.shopId, items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "", delivery }))) } }; };
const walk = async (t, from, to) => { for (let tip = from; tip <= to; tip++) { t.st.tip = tip; await t.m.shop.scanOnce(); } };
const both = (t, buyer) => [t.m.store.order("ORD-V"), t.m.store.order("ORD-V~" + buyer.publicId)];
const DUPV = "another buyer sent an order with the same reference ORD-V: a payment with it cannot be told apart, so check both orders by hand";
test("a copier's order mined the block after another buyer's payment, the real order two blocks later: the copier's order is paid but settling, then both are held for a check by hand", async () => {
  const t = await javaSetup("copy1"); t.shopId = "copy1"; const atk = await t.m.sc.deriveIdentity("copier copy1"), buyer = await t.m.sc.deriveIdentity("copy1 buyer");
  t.st.pay = [t.pay("ORD-V", 1010)];   // the victim's payment
  t.st.msg = [await sealFrom(t, atk, "ORD-V", 1011, "COPIER"), await sealFrom(t, buyer, "ORD-V", 1012, "VICTIM")];
  await walk(t, 1010, 1011);
  const o = t.m.store.order("ORD-V"); assert.equal(o.delivery, "COPIER");
  assert.equal(o.paid, true, "counted the first time it is read"); assert.equal(t.m.store.mayAdvance(o), false, "but settling");
  assert.deepEqual(t.m.shop.orderDetail("ORD-V").settling, { block: 1013 }, "said with the block it is held until");
  await assert.rejects(t.m.shop.advanceStatus("ORD-V", "CONFIRMED"), /^Error: This order's payment is held until block 1013 in case another order with the same reference arrives\. Check it by hand to move it on now\.$/);
  await walk(t, 1012, 1016);
  const [copier, victim] = both(t, buyer);
  assert.ok(victim && victim.delivery === "VICTIM", "the real order is kept as a second buyer's");
  for (const x of [copier, victim]) {
    assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(t.m.store.mayAdvance(x), false, x.delivery + " may not advance");
    assert.equal(x.problems[0], DUPV, x.delivery + ": " + x.problems.join(" | "));
    await assert.rejects(t.m.shop.advanceStatus(x.ref, "CONFIRMED"), /Check it by hand first/);
  }
  assert.equal(copier.paidAmount, "1", "the payment is counted on the order held under the reference, once"); assert.equal(t.m.shop.orderDetail("ORD-V").settling, null);
});
test("an order marked PAID meets a second buyer's order with its reference: it is unpaid and held for a check by hand; a confirmed one, or one checked by hand, is left as it is", async () => {
  const t = await javaSetup("copy2"); t.shopId = "copy2"; const atk = await t.m.sc.deriveIdentity("copier copy2"), buyer = await t.m.sc.deriveIdentity("copy2 buyer");
  t.st.pay = [t.pay("ORD-V", 1010)]; t.st.msg = [await sealFrom(t, atk, "ORD-V", 1011, "COPIER")];
  await walk(t, 1010, 1015);
  assert.equal(t.m.store.order("ORD-V").paid, true, "paid past the allowance"); assert.equal(t.m.store.order("ORD-V").status, "PAID");
  t.st.msg.push(await sealFrom(t, buyer, "ORD-V", 1020, "VICTIM")); await walk(t, 1020, 1021);
  const [copier, victim] = both(t, buyer);
  assert.equal(copier.paid, false); assert.equal(copier.status, "UNCHECKED"); assert.equal(copier.problems[0], DUPV); assert.equal(copier.paidAmount, "1", "what was received stays counted");
  assert.equal(t.m.store.mayAdvance(copier), false); assert.equal(t.m.store.mayAdvance(victim), false);
  assert.equal(t.m.store.handCheck("ORD-V"), true); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-V")), true, "moves on once checked by hand");
  // a confirmed order, and a PAID one the vendor checked by hand, are not disturbed
  const S = t.m.store, base = { role: "sell", shopId: "copy2", amount: "1", currency: "Minima", tokenid: "0x00", items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], shipping: "", problems: [], due: "1" };
  S.upsertOrder(Object.assign({ ref: "ORD-C1", status: "CONFIRMED", paid: true }, base)); S.upsertOrder(Object.assign({ ref: "ORD-C2", status: "PAID", paid: true, handChecked: true }, base));
  S.upsertOrder(Object.assign({ ref: "ORD-C3", status: "SHIPPED", paid: true }, base));
  for (const r of ["ORD-C1", "ORD-C2", "ORD-C3"]) { const was = JSON.stringify(S.order(r)); assert.equal(S.flagDuplicate(r, "x"), false, r); assert.equal(JSON.stringify(S.order(r)), was, r + " unchanged"); }
});
// CHANGED on purpose (0.18.300): counted when first read; confirmable at tip = block + 3 with the orders read (0.18.293 counted it only then)
test("one buyer: order then payment, the same block, and an order 3 blocks after its payment: counted when first read, confirmable once a good pass is 3 blocks past the payment, counted once", async () => {
  for (const [ob, pb] of [[1009, 1010], [1010, 1010], [1013, 1010]]) {
    const t = await javaSetup("one" + ob); t.st.msg = [await t.seal("ORD-1", ob)]; t.st.pay = [t.pay("ORD-1", pb)];
    await walk(t, 1009, pb + 2); const o = t.m.store.order("ORD-1");
    if (ob <= pb + 2) { assert.equal(o.paid, true, "counted at sight (order " + ob + ")"); assert.equal(t.m.store.mayAdvance(o), false, "tip " + (pb + 2) + ": settling"); assert.deepEqual(t.m.shop.orderDetail("ORD-1").settling, { block: pb + 3 }); }
    else assert.equal(o, null, "the order is not read yet");
    await walk(t, pb + 3, pb + 3); const p = t.m.store.order("ORD-1");
    assert.equal(p.paid, true); assert.equal(t.m.store.mayAdvance(p), true, "tip " + (pb + 3) + ": settled (order " + ob + ")"); assert.equal(p.paidAmount, "1"); assert.deepEqual(p.coins, ["0xfa" + Buffer.from("ORD-1").toString("hex")]);
    await walk(t, pb + 4, pb + 8); assert.equal(t.m.store.order("ORD-1").paidAmount, "1", "counted once");
  }
});
test("a payment is counted when first read and the order settles on a good pass after a restart; tip = block + 2 settling, block + 3 settled", async () => {
  const t = await javaSetup("wait"); t.st.msg = [await t.seal("ORD-W", 1009)]; t.st.pay = [t.pay("ORD-W", 1010)];
  t.st.tip = 1010; await t.m.shop.scanOnce(); assert.equal(t.m.store.order("ORD-W").paid, true, "tip 1010: counted"); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-W")), false);
  let m = await t.reopen(); assert.equal(m.store.mayAdvance(m.store.order("ORD-W")), false, "after a restart, before any pass: settling");
  t.st.tip = 1012; await m.shop.scanOnce(); assert.equal(m.store.mayAdvance(m.store.order("ORD-W")), false, "tip 1012 = 1010 + 2: settling");
  m = await t.reopen(); t.st.tip = 1013; await m.shop.scanOnce(); assert.equal(m.store.mayAdvance(m.store.order("ORD-W")), true, "tip 1013 after a restart: settled");
  // the app away for long right after counting it: settled by the first good pass
  const t2 = await javaSetup("wait2"); t2.st.msg = [await t2.seal("ORD-W2", 1009)]; t2.st.pay = [t2.pay("ORD-W2", 1011)];
  t2.st.tip = 1011; await t2.m.shop.scanOnce(); assert.equal(t2.m.store.order("ORD-W2").paid, true);
  const m2 = await t2.reopen(); t2.st.tip = 1700; await m2.shop.scanOnce();
  assert.equal(m2.store.mayAdvance(m2.store.order("ORD-W2")), true, "after 700 blocks away");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("Paid. Held until block ${esc(String(d.settling.block))} in case another order with the same reference arrives.") && !app.includes("It is counted after block"), "the vendor is told the order settles");
});
// 0.18.293: the node's send may spend a coin from tip pb + 3 (coin age 3) and `coins` lists unspent coins only: a payment judged only from
// tip pb + 4 could be spent by the vendor's own wallet (a reply, chat, Web Wallet, a Vestr lock, an AtomiX publish) in block pb + 4 before it
// was ever counted. Order 1009, payment 1010, the wallet's send at tip 1013 mined in 1014: the pass at 1013 has counted it already.
test("the vendor's own send spends the payment at tip block + 3, mined in block + 4: the payment was counted by the pass at block + 3", async () => {
  const t = await javaSetup("spend"); t.st.msg = [await t.seal("ORD-S", 1009)]; const p = t.pay("ORD-S", 1010); t.st.pay = [p];
  await walk(t, 1009, 1013);
  assert.equal(t.m.store.order("ORD-S").paid, true, "counted at tip 1013, before any spend of it can be mined");
  p.spent = true; await walk(t, 1014, 1030);   // spendable at 1013, mined in block 1014: the node no longer lists it
  const o = t.m.store.order("ORD-S"); assert.equal(o.paid, true); assert.equal(o.paidAmount, "1"); assert.equal(o.status, "PAID");
});
// CHANGED on purpose (0.18.300): the waiting line is gone with the wait; what a failed read now does is settle nothing
test("while the orders read fails, a paid order without a secret stays settling (it can be checked by hand); the first good pass past its block + 3 settles it", async () => {
  const t = await javaSetup("waitfail", { vaddr: "0x" + "77".repeat(32) }); t.st.msg = [await t.seal("ORD-WF", 1009)]; t.st.pay = [t.pay("ORD-WF", 1010)];
  await walk(t, 1009, 1010); t.st.mode = "throw"; await walk(t, 1011, 1016);
  const o = t.m.store.order("ORD-WF"); assert.equal(o.paid, true); assert.equal(t.m.store.mayAdvance(o), false, "no good orders read: not settled");
  assert.deepEqual(t.m.shop.orderDetail("ORD-WF").settling, { block: 1013 });
  t.st.mode = "ok"; await walk(t, 1017, 1017); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-WF")), true);
  // checked by hand while settling
  const t2 = await javaSetup("waitfail2", { vaddr: "0x" + "77".repeat(32) }); t2.st.msg = [await t2.seal("ORD-WH", 1009)]; t2.st.pay = [t2.pay("ORD-WH", 1010)];
  await walk(t2, 1009, 1010); assert.equal(t2.m.store.handCheck("ORD-WH"), true, "a settling order can be checked by hand"); assert.equal(t2.m.store.mayAdvance(t2.m.store.order("ORD-WH")), true);
  assert.equal(t2.m.shop.orderDetail("ORD-WH").settling, null);
});
// CHANGED on purpose (0.18.300; the rule was 0.18.294's): a pass whose orders read failed, or a cut one whose gap covers the coin's block, still
// counts every payment it lists, and settles none: the order paid is not confirmable until the orders that may go with it are read
test("the orders read fails at tip pb + 3: the copier's order, paid when first read, is not settled by that pass; the next good pass reads the real order and holds both", async () => {
  const t = await javaSetup("ofail"); t.shopId = "ofail"; const atk = await t.m.sc.deriveIdentity("copier ofail"), buyer = await t.m.sc.deriveIdentity("ofail buyer");
  t.st.pay = [t.pay("ORD-V", 1010)];
  t.st.msg = [await sealFrom(t, atk, "ORD-V", 1011, "COPIER"), await sealFrom(t, buyer, "ORD-V", 1013, "VICTIM")];
  await walk(t, 1010, 1012);
  t.st.mode = "throw"; t.st.tip = 1013; await t.m.shop.scanOnce();   // the real order is in block 1013, and the read of it fails
  const o = t.m.store.order("ORD-V");
  assert.equal(o.delivery, "COPIER"); assert.equal(o.paid, true, "counted when first read"); assert.equal(t.m.store.mayAdvance(o), false, "not settled by a failed orders read");
  assert.match(t.m.shop.scanState().text, /Recent orders could not be read: the node did not answer/);
  t.st.mode = "ok"; t.st.tip = 1014; await t.m.shop.scanOnce();
  const [copier, victim] = both(t, buyer);
  for (const x of [copier, victim]) { assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(x.problems[0], DUPV); assert.equal(t.m.store.mayAdvance(x), false); }
  assert.equal(copier.paidAmount, "1", "counted once, on the order held under the reference");
  // past the tree: the orders read as deep as the tree may hold fails; the root read counts the payment; nothing settles before the real order is read
  { const t = await javaSetup("ofailroot"); t.shopId = "ofailroot"; const atk = await t.m.sc.deriveIdentity("copier ofailroot"), buyer = await t.m.sc.deriveIdentity("ofailroot buyer");
    t.st.pay = [t.pay("ORD-V", 1474)]; t.st.msg = [await sealFrom(t, buyer, "ORD-V", 1475, "VICTIM"), await sealFrom(t, atk, "ORD-V", 1477, "COPIER")];
    const m = await t.reopen(); t.st.tip = 2500; t.st.hook = (d) => { if (d > 1024) throw new Error("RPC timed out"); return null; };
    await m.shop.scanOnce(); const c = m.store.order("ORD-V"); assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, true); assert.equal(m.store.mayAdvance(c), false, "its block is below what the orders read reached");
    t.st.hook = null; t.st.tip = 2501; await m.shop.scanOnce();
    for (const x of [m.store.order("ORD-V"), m.store.order("ORD-V~" + buyer.publicId)]) { assert.ok(x); assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(m.store.mayAdvance(x), false); } }
});
test("a cut orders read (window or past the tree): a payment below what it reached is counted but its order is not settled until the orders of its range are read; neither order is then paid", async () => {
  // the recent window cut by the reply cap opens a gap; the payment's real order is in the gap, the copier's above the cut; the step fails once
  { const t = await javaSetup("ocut"); t.shopId = "ocut"; const atk = await t.m.sc.deriveIdentity("copier ocut"), buyer = await t.m.sc.deriveIdentity("ocut buyer");
    // the window (608 blocks) is cut to 304, so it reaches block 1296: the copier's order in it, the payment and the real order just under it
    t.st.pay = [t.pay("ORD-V", 1294)]; t.st.msg = [await sealFrom(t, atk, "ORD-V", 1296, "COPIER"), await sealFrom(t, buyer, "ORD-V", 1293, "VICTIM")];
    const m = await t.reopen(); t.st.tip = 1600; let n = 0;
    t.st.hook = () => { n++; if (n === 1) return { status: true, response: { tooBig: true } }; if (n === 2) return null; throw new Error("RPC timed out"); };   // window cut, the step fails
    await m.shop.scanOnce();
    const o = m.store.order("ORD-V"); assert.equal(o.delivery, "COPIER"); assert.equal(Number(m.store.getMeta("bfFloor")), 1296);
    assert.equal(o.paid, true, "counted when first read (CHANGED on purpose, 0.18.300)"); assert.equal(m.store.mayAdvance(o), false, "not settled: the orders of its range are not read");
    t.st.hook = null; t.st.tip = 1601; await m.shop.scanOnce();
    const c = m.store.order("ORD-V"), v = m.store.order("ORD-V~" + buyer.publicId);
    assert.ok(v && v.delivery === "VICTIM", "the step read the real order"); for (const x of [c, v]) { assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(x.problems[0], DUPV); }
    assert.equal(c.paidAmount, "1"); }
  // a backfill step whose orders read is cut above the gap's target: the payment it lists below what that read reached waits for the next step
  { const t = await javaSetup("ocutstep"); t.shopId = "ocutstep"; const atk = await t.m.sc.deriveIdentity("copier ocutstep"), buyer = await t.m.sc.deriveIdentity("ocutstep buyer");
    t.st.pay = [t.pay("ORD-V", 1616)]; t.st.msg = [await sealFrom(t, atk, "ORD-V", 1618, "COPIER"), await sealFrom(t, buyer, "ORD-V", 1615, "VICTIM")];
    const m = await t.reopen(); t.st.tip = 2000; let n = 0;   // the window (1008) cut to 252 (floor 1748), the step (764) cut to 382: it reaches 1618
    t.st.hook = (d) => { n++; return (n <= 3 && d > 256) || (n > 3 && d > 384) ? { status: true, response: { tooBig: true } } : null; };
    await m.shop.scanOnce();
    assert.equal(Number(m.store.getMeta("bfFloor")), 1618, "the step reached 1618"); assert.equal(m.store.order("ORD-V").delivery, "COPIER");
    assert.equal(m.store.order("ORD-V").paid, true, "counted (CHANGED on purpose, 0.18.300)"); assert.equal(m.store.mayAdvance(m.store.order("ORD-V")), false, "not settled: the orders below 1618 are not read");
    t.st.hook = null; t.st.tip = 2001; await m.shop.scanOnce();
    const c = m.store.order("ORD-V"), v = m.store.order("ORD-V~" + buyer.publicId);
    assert.ok(v && v.delivery === "VICTIM"); for (const x of [c, v]) { assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); } }
  // a step that reaches the gap's target judges what it lists below it: those blocks' orders were read before the gap
  { const t = await javaSetup("ocutend"); t.st.msg = [await t.seal("ORD-E", 997)]; t.st.tip = 997; await t.m.shop.scanOnce(); assert.ok(t.m.store.order("ORD-E"));
    t.st.pay = [t.pay("ORD-E", 998)]; const m = await t.reopen();
    m.store.setMeta("scanTip", 1005); m.store.setMeta("bfTarget", 1000); m.store.setMeta("bfFloor", 1004); t.st.tip = 1006;
    t.st.hook = (d) => (d > 7 ? { status: true, response: { tooBig: true } } : null);   // the window served 4 blocks, the step (14) 7: it reaches 999
    await m.shop.scanOnce();
    assert.equal(Number(m.store.getMeta("bfTarget")), 0, "the backfill reached its target"); assert.equal(m.store.order("ORD-E").paid, true, "the payment at 998 is judged"); }
  // past the tree: the orders read as deep as the tree may hold is cut on the first try and whole on the second
  { const t = await javaSetup("ocutroot"); t.shopId = "ocutroot"; const atk = await t.m.sc.deriveIdentity("copier ocutroot"), buyer = await t.m.sc.deriveIdentity("ocutroot buyer");
    t.st.pay = [t.pay("ORD-V", 1474)]; t.st.msg = [await sealFrom(t, buyer, "ORD-V", 1475, "VICTIM"), await sealFrom(t, atk, "ORD-V", 1477, "COPIER")];
    const m = await t.reopen(); t.st.tip = 2500; t.st.hook = (d) => (d > 1024 ? { status: true, response: { tooBig: true } } : null);
    await m.shop.scanOnce();
    assert.equal(m.store.order("ORD-V").delivery, "COPIER"); assert.equal(m.store.order("ORD-V").paid, true, "counted (CHANGED on purpose, 0.18.300)"); assert.equal(m.store.mayAdvance(m.store.order("ORD-V")), false, "not settled while the cut read is tried again");
    assert.equal(Number(m.store.getMeta("bfStall")), 1);
    t.st.hook = null; t.st.tip = 2501; await m.shop.scanOnce();
    const c = m.store.order("ORD-V"), v = m.store.order("ORD-V~" + buyer.publicId);
    assert.ok(v && v.delivery === "VICTIM", "the real order is read"); for (const x of [c, v]) { assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(x.problems[0], DUPV); }
    assert.equal(c.paidAmount, "1"); }
});
// CHANGED on purpose (0.18.295): the pass fails for that coin (the cursor stays) and says so with its id whole, not as the node not answering
test("a payment coin whose judging threw is read again on the next pass, and the pass that threw is a failed one", async () => {
  const t = await javaSetup("threw"); t.st.msg = [await t.seal("ORD-T", 1009)]; t.st.pay = [t.pay("ORD-T", 1010)];
  const real = t.m.store.recordPayment; let once = true, errs = []; const err = console.error; console.error = (...a) => errs.push(a.join(" "));
  t.m.store.recordPayment = function () { if (once) { once = false; throw new Error("disk full"); } return real.apply(this, arguments); };
  const id = "0xFA" + Buffer.from("ORD-T").toString("hex");
  try {
    t.st.tip = 1020; await t.m.shop.scanOnce(); assert.equal(t.m.store.order("ORD-T").paid, false); assert.deepEqual(t.m.shop.scanState().judgeFailed, [id], "the pass failed for that coin");
    assert.equal(Number(t.m.store.getMeta("scanTip")), 1000, "the cursor stays"); assert.equal(t.m.shop.scanState().text, "Payment coin " + id + " could not be judged. It is judged again on the next block.");
    t.st.tip = 1021; await t.m.shop.scanOnce(); assert.equal(t.m.store.order("ORD-T").paid, true, "judged again, not skipped as seen");
    assert.equal(t.m.shop.scanState().text, ""); assert.equal(Number(t.m.store.getMeta("scanTip")), 1021);
  } finally { t.m.store.recordPayment = real; console.error = err; }
  assert.ok(errs.some(e => e.includes(id) && e.includes("disk full")), errs.join(" | "));
});
// 0.18.295: one coin whose judging always throws stopped every newer coin for good (the loop rethrew, the cursor never moved, and the line
// said the node did not answer); every coin is judged, and the coin is given up on after three passes that threw
test("a payment coin whose judging always throws: an unrelated payment is still paid in the same pass; after three passes the coin is left for a check by hand and the cursor moves", async () => {
  const t = await javaSetup("pois"); t.st.msg = [await t.seal("ORD-P1", 1001), await t.seal("ORD-P2", 1005)]; t.st.pay = [t.pay("ORD-P1", 1002), t.pay("ORD-P2", 1006)];
  const P1 = "0xFA" + Buffer.from("ORD-P1").toString("hex"), real = t.m.store.recordPayment; let calls = 0;
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  t.m.store.recordPayment = function (ref) { if (ref === "ORD-P1") { calls++; throw new Error("poison"); } return real.apply(this, arguments); };
  try {
    t.st.tip = 1010; await t.m.shop.scanOnce();
    assert.equal(t.m.store.order("ORD-P2").paid, true, "the newer coin is judged in the same pass"); assert.equal(t.m.store.order("ORD-P1").paid, false);
    const st = t.m.shop.scanState(); assert.equal(st.readFailed, false, "not the node"); assert.ok(!/did not answer/.test(st.text), st.text);
    assert.equal(st.text, "Payment coin " + P1 + " could not be judged. It is judged again on the next block."); assert.equal(Number(t.m.store.getMeta("scanTip")), 1000, "the cursor stays");
    t.st.tip = 1011; await t.m.shop.scanOnce(); assert.equal(Number(t.m.store.getMeta("scanTip")), 1000);
    t.st.tip = 1012; await t.m.shop.scanOnce();
    assert.equal(Number(t.m.store.getMeta("scanTip")), 1012, "given up on after three passes: the cursor moves"); assert.equal(calls, 3);
    const o = t.m.store.order("ORD-P1"); assert.ok(o.problems.includes("payment coin " + P1 + " could not be judged: check by hand"), o.problems.join(" | ")); assert.equal(o.status, "UNCHECKED");
    assert.equal(t.m.shop.scanState().text, "Payment coin " + P1 + " could not be judged: check by hand."); assert.deepEqual(t.m.shop.scanState().gaveUp, [P1]);
    assert.ok(errs.some(e => e.includes(P1) && e.includes("poison") && /after 3 tries/.test(e)), errs.join(" | "));
    t.st.tip = 1013; await t.m.shop.scanOnce(); assert.equal(calls, 3, "not judged again this session"); assert.equal(Number(t.m.store.getMeta("scanTip")), 1013);
    // 0.18.302: checked by hand, the coin is no longer said on the status line
    t.m.shop.vendorCheck("ORD-P1"); assert.deepEqual(t.m.shop.scanState().gaveUp, []); assert.equal(t.m.shop.scanState().text, "", "said until the vendor checked the order");
  } finally { t.m.store.recordPayment = real; console.error = err; }
});
// 0.18.290: one "older than the order" problem per order, and no write of shop.json for a coin that changes nothing (2000 coins made
// 2001 problems and 3001 rewrites); the same buyer's order sent again: the order's block is its oldest coin's, never a copier's
test("2000 old coins with an order's reference: one 'older than the order' problem, the first coin's id whole, and the writes bounded by the order's coin list", async () => {
  const t = await javaSetup("flood"); t.st.msg = [await t.seal("ORD-F", 1500)];
  t.st.pay = Array.from({ length: 2000 }, (_, i) => Object.assign(t.pay("ORD-F", 1001 + (i ? 1 + (i % 400) : 0)), { coinid: "0xFB" + (0x10000 + i).toString(16) }));
  let writes = 0; const real = fs.renameSync; fs.renameSync = function () { writes++; return real.apply(this, arguments); };
  try { t.st.tip = 1510; await t.m.shop.scanOnce(); } finally { fs.renameSync = real; }
  const o = t.m.store.order("ORD-F"), older = o.problems.filter(p => p.startsWith("a payment with this order's reference is older than the order"));
  assert.equal(older.length, 1, o.problems.length + " problems"); assert.equal(o.problems.length, 1);
  assert.equal(older[0], "a payment with this order's reference is older than the order (payment coin 0xFB10000 at block 1001, the order at block 1500): check by hand");
  assert.ok(writes <= 1002, writes + " writes: the order, its one problem, and each coin counted on its list (at most 1000)"); assert.equal(o.paid, false);
});
test("the same buyer's order sent again: a payment between the two copies pays it (the order's block is its oldest copy's); a copier's lower coin never moves another buyer's order's block", async () => {
  { const t = await javaSetup("resend"); t.shopId = "resend"; const buyer = await t.m.sc.deriveIdentity("resend buyer");
    t.st.msg = [await sealFrom(t, buyer, "ORD-R", 1010, "B"), await sealFrom(t, buyer, "ORD-R", 1000, "B")];   // the node lists newest first
    t.st.pay = [t.pay("ORD-R", 1001)]; t.st.tip = 1020; await t.m.shop.scanOnce();
    const o = t.m.store.order("ORD-R"); assert.equal(o.orderBlock, 1000, "lowered to the oldest copy"); assert.equal(o.paid, true, o.problems.join(" | ")); }
  { const t = await javaSetup("resend2"); t.shopId = "resend2"; const buyer = await t.m.sc.deriveIdentity("resend2 buyer"), atk = await t.m.sc.deriveIdentity("copier resend2");
    t.st.msg = [await sealFrom(t, buyer, "ORD-R", 1010, "B"), await sealFrom(t, atk, "ORD-R", 1000, "COPIER")];
    t.st.pay = [t.pay("ORD-R", 1003)]; t.st.tip = 1020; await t.m.shop.scanOnce();
    const o = t.m.store.order("ORD-R"), c = t.m.store.order("ORD-R~" + atk.publicId);
    assert.equal(o.delivery, "B"); assert.equal(o.orderBlock, 1010, "not moved by another sender's coin"); assert.equal(c.orderBlock, 1000, "the copier's order is a second buyer's");
    assert.equal(o.paid, false); assert.equal(t.m.store.mayAdvance(o), false); assert.equal(t.m.store.mayAdvance(c), false); }
});
// 0.18.286: past the tree, orders read whole but the payments read cut by the reply cap: the payments' cause is the reply cap
test("past the tree with only the payments read cut by the reply cap, the notice names the reply cap for the payments", async () => {
  const t = await javaSetup("paycut"); const m = await t.reopen();
  const run = javaNode(m, t.st); m.shop._setRunner(async (c) => c.startsWith("coins address:" + t.st.vaddr) && /depth:(\d+)/.exec(c) && Number(/depth:(\d+)/.exec(c)[1]) > 1024 ? { status: true, response: { tooBig: true } } : run(c));
  for (let i = 0; i < 4; i++) { t.st.tip = 2500 + i; await m.shop.scanOnce(); }
  assert.equal(m.store.getMeta("unreadWhy"), "treePayCap");
  assert.equal(m.shop.scanState().text, "Orders older than block 1476 may not have been read: the node keeps only its recent blocks. Payments to your shops older than block 1476 may not have been read: the node's answer for them was too large.");
});
// (5) 0.18.277: the unread notice is shown only with a shop, and can be dismissed (the fact stays in the log)
test("the unread notice: only for someone with a shop, dismissable, shown again for a newer one", async () => {
  const t = await javaSetup("notice"); const m = t.m;
  m.store.setMeta("unreadBelow", 1476); m.store.setMeta("unreadWhy", "treeRoot");
  assert.match(m.shop.scanState().text, /Orders older than block 1476/); assert.equal(m.shop.scanState().unreadShown, true);
  m.shop.dismissUnread(); assert.equal(m.shop.scanState().text, "", "dismissed"); m.store.setMeta("unreadBelow", 3000); assert.match(m.shop.scanState().text, /older than block 3000/, "a newer one is shown");
  m.store.deleteShop("notice"); assert.equal(m.shop.scanState().text, "", "no shop: not shown");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"), main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(app.includes('id="shopUnreadOk">Dismiss</button>') && app.includes("await api.shopDismissUnread()") && main.includes('ipcMain.handle("mcd:shopDismissUnread", () => shop.dismissUnread());'));
});

// ---- 0.18.208: the same reference from two buyers; a retry needs a refused payment and nothing in flight ----
test("two buyers' orders with the same reference are both kept and neither is paid automatically", async () => {
  const m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const VADDR = "MxG0" + "5".repeat(56); let msg = [], pay = [];
  m.store.saveShop({ shopId: "dup", shopName: "D", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  m.shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed dup" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } }
    : c === "block" ? { status: true, response: { block: 50 } }
    : c.startsWith("coins address:" + m.shop.MINIMERCH) ? { status: true, response: msg } : c.startsWith("coins address:" + VADDR) ? { status: true, response: pay } : { status: true, response: [] });
  await m.shop.init();
  const me = m.shop.myIdentity(), b1 = await m.sc.deriveIdentity("dup buyer one"), b2 = await m.sc.deriveIdentity("dup buyer two");
  const coin = async (b, id) => ({ coinid: id, created: 49, state: { "99": "0x" + await m.sc.seal(b, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref: "ORD-DUP", randomid: id, from: b.publicId, to: me.publicId, date: 1, shopId: "dup", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" }))) } });
  msg = [await coin(b1, "0xD1")]; await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-DUP").status, "PENDING");
  msg = [await coin(b1, "0xD1"), await coin(b2, "0xD2")]; await m.shop.scanOnce();
  const first = m.store.order("ORD-DUP"), second = m.store.order("ORD-DUP~" + b2.publicId);
  assert.ok(second, "the second buyer's order is kept"); assert.equal(second.counterparty, b2.publicId); assert.equal(second.wireRef, "ORD-DUP");
  for (const o of [first, second]) { assert.equal(o.status, "UNCHECKED"); assert.match(o.problems[0], /another buyer sent an order with the same reference ORD-DUP/); assert.equal(o.due, ""); }
  pay = [{ coinid: "0xAA10", tokenid: "0x00", amount: "10", created: 49, state: { "1": "0x" + Buffer.from("ORD-DUP").toString("hex") } }];
  await m.shop.scanOnce();
  assert.equal(m.store.order("ORD-DUP").paid, false, "a payment with the shared reference pays neither");
  assert.equal(m.store.handCheck("ORD-DUP~" + b2.publicId), true, "the vendor can check either by hand");
  const dd = m.shop.orderDetail("ORD-DUP~" + b2.publicId);   // 0.18.218: says where the payments with the reference are shown, and the total
  assert.deepEqual(dd.sharedRef, { ref: "ORD-DUP", received: m.store.order("ORD-DUP").paidAmount || "0" }); assert.equal(m.shop.orderDetail("ORD-DUP").sharedRef, null);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").includes("Payments with the reference ${esc(o.wireRef)} are shown on order ${esc(d.sharedRef.ref)}"));
});

test("buyer: a retry pays only after a refused payment, never while one may be in flight or may have been sent", async () => {
  const m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const vendor = await m.sc.deriveIdentity("retry vendor"); let mode = "refuse"; const paid = [];
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "retry buyer" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: "MxG0" + "B".repeat(56) } };
    if (c.startsWith("checkaddress")) return { status: true, response: { simple: true } };
    if (c.startsWith("coins")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + ADDR)) { paid.push(c); if (mode === "refuse") return { status: false, error: "Insufficient funds" }; if (mode === "timeout") throw new Error("timed out"); }
    return { status: true, response: { txpowid: "0x01" } };
  });
  const cfg = shopOf({ vendorPublicId: vendor.publicId });
  const r1 = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", ""); assert.match(r1.payError, /Insufficient/);
  assert.equal(m.store.getMeta("inflight:" + r1.ref), false, "a refused payment is not in flight");
  mode = "ok"; await m.shop.retryPayment(r1.ref); assert.equal(paid.length, 2, "retried once after the refusal");
  await assert.rejects(m.shop.retryPayment(r1.ref), /no refused payment to retry/, "and not again");
  const r2 = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", ""); assert.equal(r2.payError, null);
  await assert.rejects(m.shop.retryPayment(r2.ref), /no refused payment to retry/, "a paid order is never paid again by a retry");
  mode = "timeout"; const r3 = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", "");
  assert.equal(m.store.getMeta("inflight:" + r3.ref), true); await assert.rejects(m.shop.retryPayment(r3.ref), /may already have been sent/);
  // a quit during the send: the in-flight mark is still on disk
  mode = "refuse"; const r4 = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", ""); m.store.setMetaSync("inflight:" + r4.ref, true);
  const before = paid.length; await assert.rejects(m.shop.retryPayment(r4.ref), /may already have been sent/); assert.equal(paid.length, before, "nothing sent");
  // the mark is on disk before each payment reaches the node (CHANGED on purpose, 0.18.224: checked as the node sees the send, not by the source's text)
  const marks = []; m.shop._setRunner(async (c) => {
    if (c.startsWith("coins")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + ADDR)) { const o = m.shop.ordersList().find(x => x.role === "buy" && c.includes("0x" + Buffer.from(x.ref, "utf8").toString("hex"))); marks.push(o ? m.store.getMeta("inflight:" + o.ref) : "no order"); return { status: false, error: "Insufficient funds" }; }
    return { status: true, response: { txpowid: "0x01" } };
  });
  const r5 = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", ""); await assert.rejects(m.shop.retryPayment(r5.ref), /Insufficient/);
  assert.deepEqual(marks, [true, true], "in flight on disk when the node got the order's payment and the retry");
});


// ---- 0.18.217: an uncertain payment is shown as such, and the buyer can say it was not sent ----
test("buyer: an in-flight or timed-out payment shows as 'may already have gone through'; 'it was not sent' clears it and offers Retry", async () => {
  const m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const vendor = await m.sc.deriveIdentity("notsent vendor"); let mode = "timeout";
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "notsent buyer" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: "MxG0" + "B".repeat(56) } };
    if (c.startsWith("checkaddress")) return { status: true, response: { simple: true } };
    if (c.startsWith("coins")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + ADDR)) { if (mode === "timeout") throw new Error("timed out"); }
    return { status: true, response: { txpowid: "0x01" } };
  });
  const cfg = shopOf({ vendorPublicId: vendor.publicId });
  const r = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", "");
  assert.equal(m.shop.orderDetail(r.ref).ambiguous, true); assert.equal(m.shop.ordersList().find(o => o.ref === r.ref).ambiguous, true);
  const q = await m.shop.placeOrder(cfg, [{ product: "Tea", quantity: 1 }], "1.5", "", "home", "");
  m.store.setMetaSync("ambiguous:" + q.ref, false);   // only the in-flight mark is left (a quit during the send)
  assert.equal(m.shop.orderDetail(q.ref).ambiguous, true, "in flight shows the same warning");
  assert.throws(() => m.shop.paymentNotSent("ORD-NONE"), /Order not found/);
  m.shop.paymentNotSent(r.ref);
  const d = m.shop.orderDetail(r.ref); assert.equal(d.ambiguous, false); assert.equal(d.unpaid, true);
  assert.throws(() => m.shop.paymentNotSent(r.ref), /no payment that may have gone through/, "only once");
  mode = "ok"; await m.shop.retryPayment(r.ref); assert.equal(m.shop.orderDetail(r.ref).unpaid, false);
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes('id="shopNotSent"') && app.includes('"\\n\\nToken id\\n" + o.tokenid + "\\n\\nVendor\'s payment address\\n" + String(o.vendorAddress || "")'), "the confirmation shows the amount, the token id and the vendor address whole");
  assert.ok(/ipcMain\.handle\("mcd:shopNotSent", \(_e, ref\) => shop\.paymentNotSent\(ref\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8")));
});

// ---- 0.18.224 (as Pandamonium Desktop 0.19.265): no "not sent" and no Retry while the payment is still at the node; none once the vendor acknowledged it ----
test("buyer: while a payment is at the node, 'not sent' and Retry are refused and the screen is told it is being sent; a payment that went clears unpaid", async () => {
  const m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const vendor = await m.sc.deriveIdentity("sending vendor"); let release = null; const paid = [];
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "sending buyer" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: "MxG0" + "B".repeat(56) } };
    if (c.startsWith("checkaddress")) return { status: true, response: { simple: true } };
    if (c.startsWith("coins")) return { status: true, response: [] };
    if (c.startsWith("send ") && c.includes("address:" + ADDR)) { paid.push(c); return new Promise(r => { release = r; }); }
    return { status: true, response: { txpowid: "0x01" } };
  });
  const placing = m.shop.placeOrder(shopOf({ vendorPublicId: vendor.publicId }), [{ product: "Tea", quantity: 1 }], "1.5", "", "home", "");
  while (!release) await new Promise(r => setImmediate(r));
  const ref = m.shop.ordersList().find(o => o.role === "buy").ref;
  const d = m.shop.orderDetail(ref); assert.equal(d.sending, true); assert.equal(d.ambiguous, false, "no 'may have gone through' warning and no 'not sent' button while it is sent");
  assert.equal(m.shop.ordersList().find(o => o.ref === ref).sending, true);
  assert.throws(() => m.shop.paymentNotSent(ref), /being sent to the node now/); assert.equal(m.store.getMeta("inflight:" + ref), true, "the in-flight mark stays");
  m.store.setMetaSync("unpaid:" + ref, true); await assert.rejects(m.shop.retryPayment(ref), /being sent to the node now/); assert.equal(paid.length, 1, "no second payment");
  release({ status: true, response: { txpowid: "0xP" } }); const r = await placing;
  assert.equal(r.payError, null); assert.equal(m.store.getMeta("unpaid:" + ref), false, "a payment that went clears unpaid"); assert.equal(m.shop.orderDetail(ref).sending, false);
  await assert.rejects(m.shop.retryPayment(ref), /no refused payment to retry/);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").includes("${(!isSell && d.sending) ?"), "the order screen says it is being sent");
});
test("buyer: once the vendor moved the order to PAID or on, the warning, 'not sent' and Retry are gone", async () => {
  const m = freshModules(); m.store.clear(); const paid = [];
  m.shop._setRunner(async (c) => { if (c.startsWith("send ")) paid.push(c); return { status: true, response: [] }; });
  for (const status of ["PAID", "CONFIRMED", "SHIPPED", "DELIVERED"]) {
    m.store.upsertOrder({ ref: "ORD-A", role: "buy", status, currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: ADDR, paid: false });
    m.store.setMetaSync("ambiguous:ORD-A", true); m.store.setMetaSync("inflight:ORD-A", true); m.store.setMetaSync("unpaid:ORD-A", false);
    const d = m.shop.orderDetail("ORD-A"); assert.equal(d.ambiguous, false, status); assert.equal(d.unpaid, false); assert.equal(m.shop.ordersList().find(o => o.ref === "ORD-A").ambiguous, false);
    assert.throws(() => m.shop.paymentNotSent("ORD-A"), /already paid/, status); assert.equal(m.store.getMeta("unpaid:ORD-A"), false);
    m.store.setMetaSync("ambiguous:ORD-A", false); m.store.setMetaSync("inflight:ORD-A", false); m.store.setMetaSync("unpaid:ORD-A", true);
    await assert.rejects(m.shop.retryPayment("ORD-A"), /already paid/, status);
  }
  assert.deepEqual(paid, []);
  m.store.upsertOrder({ ref: "ORD-B", role: "buy", status: "PENDING", currency: "USDT", tokenid: MXUSD, amount: "5", vendorAddress: ADDR, paid: false }); m.store.setMetaSync("ambiguous:ORD-B", true);
  assert.equal(m.shop.orderDetail("ORD-B").ambiguous, true, "a pending order still says it may have gone through");
});

// ---- 0.18.226 (as Pandamonium Desktop 0.19.272): gathered dust is bounded with a running exact sum; past the bound a coin not larger than the smallest kept is not kept ----
test("dust past the bound: an order keeps PENDING_MAX coins, the smallest is replaced only by a larger one, the sum stays exact, and it still pays (also after a restart)", () => {
  const m = freshModules(), M2 = m.store._money;
  m.store.saveShop({ shopId: "dust10", shopName: "D", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  const ord = (ref) => { m.store.upsertOrder({ ref, role: "sell", shopId: "dust10", amount: "10", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" }); return ref; };
  const r = ord("ORD-DU9"), MAX = m.store.PENDING_MAX;
  assert.ok(MAX <= 256, "a lower bound than 1000");
  assert.equal(m.store.recordPayment(r, "9.9", "0x00", "0xe0"), "UNDERPAID");
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) assert.equal(m.store.recordPayment(r, "0.00001", "0x00", "0xe1" + i), "DUST");
  for (let k = 0; k < 2; k++) for (let i = 0; i < 3000; i++) m.store.recordPayment(r, "0.00001", "0x00", "0xe1" + i);   // the same flood seen on two more scans
  assert.ok(Date.now() - t0 < 3000, "9000 looks at dust in " + (Date.now() - t0) + " ms (each was a sort of the whole map)");
  assert.deepEqual(m.store._pendingDust(r), { size: MAX, sum: M2.decAdd("0", (MAX * 0.00001).toFixed(5)), min: "0.00001" }, "kept: the bound, summed exactly");
  assert.equal(m.store.recordPayment(r, "0.0001", "0x00", "0xe2"), "DUST");
  assert.equal(M2.decCmp(m.store._pendingDust(r).sum, "0.00265"), 0, "a larger coin takes the smallest one's place: 0.00256 - 0.00001 + 0.0001");
  assert.equal(m.store._pendingDust(r).size, MAX);
  assert.equal(m.store.recordPayment(r, "0.05", "0x00", "0xe3"), "DUST");
  assert.equal(m.store.recordPayment(r, "0.05", "0x00", "0xe4"), "PAID", "each 0.05 took a smallest one's place: 0.00263 + 0.05 + 0.05 covers the 0.1 left");
  assert.equal(M2.decCmp(m.store.order(r).paidAmount, "10.00263"), 0, "counted exactly: " + m.store.order(r).paidAmount);
  assert.equal(new Set(m.store.order(r).coins).size, m.store.order(r).coins.length, "each coin once"); assert.equal(m.store._pendingDust(r), null);
  // after a restart (nothing in memory) the scanner shows the same coins again, in any order: 9.9 + 0.05 + 0.05 pays 10
  const r2 = ord("ORD-DU10"); assert.equal(m.store.recordPayment(r2, "0.05", "0x00", "0xf1"), "DUST"); m.store.flush();
  const fresh = freshModules().store;
  assert.equal(fresh._pendingDust(r2), null, "a restart forgets the gathered dust");
  assert.equal(fresh.recordPayment(r2, "0.05", "0x00", "0xf2"), "DUST"); assert.equal(fresh.recordPayment(r2, "0.05", "0x00", "0xf1"), "DUST");
  assert.equal(fresh.recordPayment(r2, "9.9", "0x00", "0xf3"), "PAID"); assert.equal(M2.decCmp(fresh.order(r2).paidAmount, "10"), 0);
});

// ---- 0.18.227 (as Pandamonium Desktop 0.19.273 / 0.19.284): a payout address that can never be valid (its checksum) is skipped for a while and said
// whole; a node error about a valid one only holds the scan; the save checks the checksum ----
const mxOf = (hex) => {   // the node's Mx encoding of a 32-byte address: [1, 0, 32] + address + the first 4 bytes of its SHA3, in base 32
  const a = Buffer.from(hex.slice(2), "hex"), b = Buffer.concat([Buffer.from([1, 0, 32]), a, require("crypto").createHash("sha3-256").update(a).digest().subarray(0, 4)]);
  let n = BigInt("0x" + b.toString("hex")), s = ""; while (n > 0n) { s = "0123456789ABCDEFGHIJKLMNOPQRSTUV"[Number(n % 32n)] + s; n /= 32n; } return "Mx" + s.replace(/I/g, "W").replace(/L/g, "Y").replace(/O/g, "Z");   // the node's alphabet writes I, L, O as W, Y, Z
};
test("vendor: a payout address with a wrong checksum is skipped for five minutes and said whole; a node error about a valid one holds the scan; the save checks it", async () => {
  const m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const VADDR = "MxG0" + "7".repeat(56), GOOD = mxOf("0x3A985DA74FE225B2045C172D6BD390BD855F086E3E9D525B46BFE24511431532");
  const BAD = GOOD.slice(0, -3) + (GOOD.slice(-3, -2) === "A" ? "B" : "A") + GOOD.slice(-2);
  let tip = 30000, goodFails = true; const asked = [], logs = [];
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "vendor seed pay" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: VADDR } };
    if (c === "block") return { status: true, response: { block: tip } };
    if (c.startsWith("coins address:" + BAD)) { asked.push(c); return { status: false, error: "Invalid MxAddress - checksum wrong" }; }
    if (c.startsWith("coins address:" + GOOD)) return goodFails ? { status: false, error: "SQL Exception: the wallet database is closed" } : { status: true, response: [] };
    return { status: true, response: [] };
  });
  m.store.saveShop({ shopId: "bad3", shopName: "B", currency: "Minima", tokenid: "0x00", vendorAddress: BAD, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  m.store.saveShop({ shopId: "good3", shopName: "G", currency: "Minima", tokenid: "0x00", vendorAddress: GOOD, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  const err = console.error, now0 = Date.now; console.error = (l) => logs.push(String(l));
  try {
    await m.shop.init(); await m.shop.scanOnce(); m.store.setMeta("scanTip", 30000);
    tip = 30001; await m.shop.scanOnce();
    assert.equal(m.shop.scanState().readFailed, true, "the valid address's coins could not be read: the scan stays"); assert.equal(Number(m.store.getMeta("scanTip")), 30000);
    assert.deepEqual(m.shop.scanState().skipped, [BAD], "only the one with a wrong checksum is skipped, named whole");
    assert.ok(m.shop.scanState().text.includes("Payments to " + BAD + " are not read: it is not a valid Minima address."), m.shop.scanState().text);
    assert.ok(logs.some(l => l.includes("payout address " + BAD + " is not a valid Minima address")), logs.join(" | "));
    goodFails = false; tip = 30002; asked.length = 0; await m.shop.scanOnce();
    assert.equal(m.shop.scanState().readFailed, false); assert.equal(Number(m.store.getMeta("scanTip")), 30002, "the bad address no longer holds the scan"); assert.deepEqual(asked, [], "a skipped address is not asked again");
    Date.now = () => now0() + 5 * 60000 + 1000; assert.deepEqual(m.shop.scanState().skipped, [], "the skip runs out");
    tip = 30003; await m.shop.scanOnce(); assert.ok(asked.length > 0, "and the address is looked at again"); assert.equal(Number(m.store.getMeta("scanTip")), 30003, "still not holding the scan");
    Date.now = now0;
    // the Studio's save: the checksum decides, the node is not asked
    assert.throws(() => m.shop.saveShop({ shopId: "bad4", shopName: "C", vendorAddress: BAD, products: [] }), new RegExp("payout address " + BAD + " is not a valid Minima address\\. Nothing was saved"));
    assert.equal(m.store.shop("bad4"), null);
    m.shop.saveShop({ shopId: "ok6", shopName: "E", vendorAddress: GOOD, products: [] }); assert.ok(m.store.shop("ok6"), "a valid address saves");
    m.shop.saveShop(Object.assign({}, m.store.shop("bad3"), { shopName: "B2" })); assert.equal(m.store.shop("bad3").shopName, "B2", "an unchanged address is not checked again");
    assert.throws(() => m.shop.saveShop({ shopId: "bad7", shopName: "H", vendorAddress: "0x" + "AB".repeat(31), products: [] }), /payout address is invalid/);
  } finally { console.error = err; Date.now = now0; }
});

// ---- 0.18.247: SHA-3 from main/sha3.js, never Node's crypto (Electron's BoringSSL has none: the payout check read every address as valid) ----
test("SHA3-256 comes from main/sha3.js: the known vectors, the Mx address both ways, and the payout check works with a crypto that has no SHA-3", async () => {
  const S3 = require("../main/sha3");
  assert.equal(S3.sha3_256(Buffer.alloc(0)).toString("hex"), "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
  assert.equal(S3.sha3_256("abc").toString("hex"), "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
  for (const n of [0, 1, 135, 136, 137, 271, 272, 273, 1000]) { const b = require("crypto").randomBytes(n); assert.equal(S3.sha3_256(b).toString("hex"), require("crypto").createHash("sha3-256").update(b).digest("hex"), "block edge " + n); }
  // shop.js loaded with a crypto whose SHA-3 throws, as Electron's does
  const realCrypto = require("crypto"), noSha3 = Object.assign({}, realCrypto, { createHash: (alg, ...r) => { if (/sha3/i.test(alg)) throw new Error("Digest method not supported"); return realCrypto.createHash(alg, ...r); } });
  const prev = Module._load; Module._load = function (r, parent) { if (r === "crypto" && parent && /[\\/]main[\\/](shop|sha3)\.js$/.test(parent.filename)) return noSha3; return prev.apply(this, arguments); };
  try {
    const m = freshModules();
    assert.equal(m.shop._mxToHex("MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G"), "0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A");
    assert.equal(mxOf("0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A"), "MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G", "and back");
    const GOOD = "MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G", BAD = GOOD.slice(0, -3) + (GOOD.slice(-3, -2) === "A" ? "B" : "A") + GOOD.slice(-2);
    assert.equal(m.shop._mxToHex(BAD), null);
    assert.throws(() => m.shop.saveShop({ shopId: "s3bad", shopName: "X", vendorAddress: BAD, products: [] }), /is not a valid Minima address/, "refused where the runtime has no SHA-3");
    m.shop.saveShop({ shopId: "s3ok", shopName: "Y", vendorAddress: GOOD, products: [] }); assert.ok(m.store.shop("s3ok"));
  } finally { Module._load = prev; freshModules(); }
});

// ---- 0.18.261: main/sha3.js says what it is: the same code as Pandamonium Desktop's, its comment apart ----
test("main/sha3.js's header says the same code (not the same file) as Pandamonium Desktop's", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "sha3.js"), "utf8");
  assert.ok(src.includes("the same code as Pandamonium Desktop 0.19.312's main/sha3.js, this comment apart") && !src.includes("the same file as"));
});

// ---- 0.18.297: the order's secret and its proof, as the phone Shop and Inbox (base-vestr-2.2.76 comms/MerchMessage.java:113-136) ----
const nodeCrypto = require("crypto");
const proofT = (s) => "0x" + nodeCrypto.createHash("sha256").update(Buffer.from(s.slice(2), "hex")).digest("hex").toUpperCase();
const newSecret = () => "0x" + nodeCrypto.randomBytes(32).toString("hex").toUpperCase();
// CHANGED on purpose (0.18.311): the note names the coin's amount as the node gave it and its token id whole (or Minima)
const NOPROOF = (id, amount, token) => "a payment with this order's reference does not carry this order's proof (payment coin " + id + ", amount " + (amount || "1") + ", token " + (token || "Minima") + "): check by hand";
const BADSECRET = "this order's secret cannot be read, so no payment can be proved to be its buyer's: check by hand";
// an order from `who` with `nonce` (undefined: no field, as an older Shop), and a payment coin with `proof` in port 2 (undefined: none)
const sealS = async (t, who, ref, created, delivery, nonce) => { const me = t.m.shop.myIdentity();
  const w = { type: "ORDER", ref, randomid: ref + created + delivery, from: who.publicId, to: me.publicId, date: 1, shopId: t.shopId, items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "", delivery };
  if (nonce !== undefined) w.nonce = nonce;
  return { coinid: "0xAC" + Buffer.from(who.publicId.slice(0, 6) + ref + created).toString("hex"), created, state: { "99": "0x" + await t.m.sc.seal(who, me.publicId, Buffer.from(JSON.stringify(w))) } }; };
const payS = (ref, created, proof, id, amount) => ({ coinid: id, tokenid: "0x00", amount: amount || "1", created, state: Object.assign({ "1": "0x" + Buffer.from(ref).toString("hex") }, proof !== undefined ? { "2": proof } : {}) });
const setupS = async (name) => { const t = await javaSetup(name, { vaddr: "0x" + "7B".repeat(32) });   // a valid address: one read that fails is not skipped as not valid
  t.shopId = name; t.victim = await t.m.sc.deriveIdentity(name + " victim"); t.atk = await t.m.sc.deriveIdentity(name + " copier"); return t; };
const copyOf = (t, who) => t.m.store.order("ORD-V~" + who.publicId);

test("the proof of an order's secret is the phone's: 0x + SHA-256 of its 32 bytes in capital hexadecimal digits; anything but 0x and 64 hexadecimal digits has none", () => {
  // computed by the phone's own MerchMessage.commitment (its Java, run as it is) for these secrets
  assert.equal(shop._proofOf("0x000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F"), "0x630DCD2966C4336691125448BBB25B4FF412A49C732DB2C8ABC1B8581BD710DD");
  assert.equal(shop._proofOf("0x" + "00".repeat(32)), "0x66687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925");
  assert.equal(shop._proofOf("0x" + "ff".repeat(32)), "0xAF9613760F72635FBDB44A5A0A63C39F12AF30F950A6EE5C971BE188E89C4051");
  assert.equal(shop._proofOf("0x" + "FF".repeat(32)), "0xAF9613760F72635FBDB44A5A0A63C39F12AF30F950A6EE5C971BE188E89C4051", "the bytes are hashed, not the text");
  for (const bad of ["", "0x", "0x" + "A".repeat(63), "0x" + "A".repeat(65), "0X" + "A".repeat(64), "0x" + "G".repeat(64), " 0x" + "A".repeat(64), "A".repeat(66), "0x" + "A".repeat(1e5), null, undefined, 7, {}, ["0x" + "A".repeat(64)]])
    assert.equal(shop._proofOf(bad), "", JSON.stringify(bad && bad.length > 80 ? bad.length : bad));
});

test("a copier's order with a copied reference is never paid by the real buyer's proved coin, and the real order with a secret is paid by it with no check by hand, in every arrival order", async () => {
  const S = newSecret(), P = proofT(S), V = "0xFE01";
  const paidByItsCoin = (t, o) => { assert.ok(o, "the real order is kept"); assert.equal(o.delivery, "VICTIM"); assert.equal(o.paid, true, o.problems.join(" | ")); assert.equal(o.status, "PAID"); assert.deepEqual(o.problems, []); assert.deepEqual(o.coins, [V.toLowerCase()]); assert.equal(t.m.store.mayAdvance(o), true); };
  const neverPaid = (o) => { assert.ok(o && o.delivery === "COPIER"); assert.equal(o.paid, false); assert.ok(!(o.coins || []).length, "nothing counted on the copier's order"); };
  for (const atkSecret of [undefined, newSecret()]) {
    const tag = atkSecret ? "the copier with a secret of their own" : "the copier with no secret";
    // copier first: the real payment at 1010, the copier's order the block after, the real order two blocks later
    { const t = await setupS("cs1" + !!atkSecret); t.st.pay = [payS("ORD-V", 1010, P, V)];
      t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER", atkSecret), await sealS(t, t.victim, "ORD-V", 1012, "VICTIM", S)];
      await walk(t, 1010, 1016);
      const c = t.m.store.order("ORD-V"); neverPaid(c); paidByItsCoin(t, copyOf(t, t.victim));
      // an order with a secret is not held by another's order; this one is held by the real payment, read before the real order (0.18.300: at sight)
      // CHANGED on purpose (0.18.304): the coin that does not prove it is a note on it, never a problem
      if (atkSecret) { assert.deepEqual(c.problems, [], tag); assert.deepEqual(c.notes, [NOPROOF(V)], tag); } else assert.equal(c.problems[0], DUPV, tag + ": an order without one is held as before");
      assert.equal(t.m.shop.orderDetail("ORD-V~" + t.victim.publicId).sharedRef, null, "its payments are counted on it"); }
    // real first: the order, its payment, then the copier's order
    { const t = await setupS("cs2" + !!atkSecret); t.st.pay = [payS("ORD-V", 1010, P, V)];
      t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", S), await sealS(t, t.atk, "ORD-V", 1011, "COPIER", atkSecret)];
      await walk(t, 1009, 1016); paidByItsCoin(t, t.m.store.order("ORD-V")); neverPaid(copyOf(t, t.atk)); }
    // the real order already PAID when the copier's order comes: not unpaid
    { const t = await setupS("cs3" + !!atkSecret); t.st.pay = [payS("ORD-V", 1010, P, V)]; t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", S)];
      await walk(t, 1009, 1014); assert.equal(t.m.store.order("ORD-V").paid, true);
      t.st.msg.push(await sealS(t, t.atk, "ORD-V", 1015, "COPIER", atkSecret)); await walk(t, 1015, 1018);
      paidByItsCoin(t, t.m.store.order("ORD-V")); neverPaid(copyOf(t, t.atk)); }
    // the same block: both orders and the payment in block 1010, the copier's order listed first
    { const t = await setupS("cs4" + !!atkSecret); t.st.pay = [payS("ORD-V", 1010, P, V)];
      t.st.msg = [await sealS(t, t.victim, "ORD-V", 1010, "VICTIM", S), await sealS(t, t.atk, "ORD-V", 1010, "COPIER", atkSecret)];
      await walk(t, 1010, 1014);
      const os = [t.m.store.order("ORD-V"), copyOf(t, t.atk), copyOf(t, t.victim)].filter(Boolean);
      paidByItsCoin(t, os.find(o => o.delivery === "VICTIM")); neverPaid(os.find(o => o.delivery === "COPIER")); }
    // the real order's read fails on the pass that would judge the payment: the payment waits, and the next pass pays the real order
    { const t = await setupS("cs5" + !!atkSecret); t.st.pay = [payS("ORD-V", 1010, P, V)];
      t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER", atkSecret), await sealS(t, t.victim, "ORD-V", 1013, "VICTIM", S)];
      await walk(t, 1010, 1012); t.st.mode = "throw"; t.st.tip = 1013; await t.m.shop.scanOnce();
      neverPaid(t.m.store.order("ORD-V")); t.st.mode = "ok"; await walk(t, 1014, 1016);
      neverPaid(t.m.store.order("ORD-V")); paidByItsCoin(t, copyOf(t, t.victim)); }
    // the real order past the node's tree (never read here), its payment unspent at the root: the copier's order inside the tree is not paid
    { const t = await setupS("cs6" + !!atkSecret);
      t.st.msg = [await sealS(t, t.victim, "ORD-V", 1003, "VICTIM", S), await sealS(t, t.atk, "ORD-V", 2490, "COPIER", atkSecret)]; t.st.pay = [payS("ORD-V", 1005, P, V)];
      const m = await t.reopen(); for (let i = 0; i < 6; i++) { t.st.tip = 2500 + i; await m.shop.scanOnce(); }
      const c = m.store.order("ORD-V"); assert.ok(c && c.delivery === "COPIER"); assert.equal(c.paid, false); assert.ok(!(c.coins || []).length);
      if (atkSecret) { assert.deepEqual(c.problems, []); assert.deepEqual(c.notes, [NOPROOF(V)], "the copier's order with a secret: the payment does not prove it (a note, 0.18.304)"); }
      else assert.deepEqual(c.problems, [], "the copier's order with no secret: a proved coin never pays it, so nothing holds it"); }
  }
});

test("a copier who copies the reference AND the proof from the real coin: their coin pays the real order, and their order (with the proof as its 'secret', or with no secret) is never paid", async () => {
  const S = newSecret(), P = proofT(S);
  for (const atkNonce of [P, undefined]) {
    const t = await setupS("cboth" + !!atkNonce);
    t.st.msg = [await sealS(t, t.atk, "ORD-V", 1009, "COPIER", atkNonce), await sealS(t, t.victim, "ORD-V", 1010, "VICTIM", S)];
    t.st.pay = [payS("ORD-V", 1011, P, "0xFE02", "0.5"), payS("ORD-V", 1012, P, "0xFE03", "0.5")];   // the copier's coin, then the buyer's: both with the buyer's proof
    await walk(t, 1009, 1016);
    const c = t.m.store.order("ORD-V"), v = copyOf(t, t.victim);
    assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, false); assert.ok(!(c.coins || []).length, "nothing counted for the copier");
    if (atkNonce) assert.equal(c.commit, proofT(P), "the proof used as a secret proves something else");
    assert.equal(v.paid, true); assert.deepEqual(v.coins, ["0xfe02", "0xfe03"], "both coins prove the buyer's secret: the buyer's order");
  }
});

test("orders with no secret keep every rule of before; a coin with a proof never pays one; an order stored before 0.18.297 is paid as before", async () => {
  // an older Shop's order: paid by a coin without a proof, not by one with a proof (or with anything else in port 2)
  for (const port2 of [proofT(newSecret()), "0x01", "[x]"]) {
    const t = await setupS("leg" + port2.length); t.st.msg = [await sealS(t, t.victim, "ORD-L", 1009, "VICTIM")]; t.st.pay = [payS("ORD-L", 1010, port2, "0xFE10")];
    await walk(t, 1009, 1014); const o = t.m.store.order("ORD-L");
    assert.equal(o.noSecret, true); assert.equal(o.paid, false, port2); assert.ok(!(o.coins || []).length); assert.deepEqual(o.problems, [], "and nothing to check: it is not this order's");
    t.st.pay.push(payS("ORD-L", 1015, undefined, "0xFE11")); await walk(t, 1015, 1018);
    assert.equal(t.m.store.order("ORD-L").paid, true, "a coin without a proof pays it, as before");
  }
  // stored by 0.18.296 (it may have come with a secret this version did not read): a coin with a proof still pays it
  { const t = await setupS("pre297"); t.st.msg = [await sealS(t, t.victim, "ORD-P", 1009, "VICTIM", newSecret())]; t.st.tip = 1009; await t.m.shop.scanOnce();
    const o = t.m.store.order("ORD-P"); delete o.commit; delete o.noSecret; t.m.store.flush();
    t.st.pay = [payS("ORD-P", 1010, proofT(newSecret()), "0xFE12")]; const m = await t.reopen(); for (let tip = 1010; tip <= 1014; tip++) { t.st.tip = tip; await m.shop.scanOnce(); }
    assert.equal(m.store.order("ORD-P").paid, true); }
});

test("a secret that is not 0x and 64 hexadecimal digits: the order is held for a check by hand (never taken as an older Shop's), and no coin pays it automatically", async () => {
  const bads = [null, 7, "0x12", "0x" + "G".repeat(64), "0x" + "A".repeat(65), "0X" + "A".repeat(64), { a: 1 }, ["0x" + "A".repeat(64)], "x".repeat(20000)];
  const t = await setupS("badsec"); let i = 0;
  t.st.msg = await Promise.all(bads.map(b => sealS(t, t.victim, "ORD-B" + (i++), 1009, "VICTIM", b)));
  t.st.pay = bads.flatMap((b, k) => [payS("ORD-B" + k, 1010, undefined, "0xFE2" + k), payS("ORD-B" + k, 1010, proofT(newSecret()), "0xFE3" + k)]);
  await walk(t, 1009, 1014);
  bads.forEach((b, k) => { const o = t.m.store.order("ORD-B" + k), what = typeof b === "string" ? b.slice(0, 70) : JSON.stringify(b);
    assert.ok(o, what); assert.equal(o.problems[0], BADSECRET, what); assert.equal(o.commit, undefined); assert.equal(o.paid, false, what); assert.equal(o.status, "UNCHECKED", what);
    assert.deepEqual(o.coins, ["0xfe2" + k], "the coin without a proof is counted on it, as on an older Shop's held order: " + what);
    assert.equal(t.m.store.handCheck(o.ref), true, "and it can be checked by hand"); });
});

test("a secret is never stored or logged; a valid one keeps only its proof on the order", async () => {
  const S = newSecret(), errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try {
    const t = await setupS("nolog"); t.st.msg = [await sealS(t, t.victim, "ORD-N", 1009, "VICTIM", S)]; t.st.pay = [payS("ORD-N", 1010, proofT(S), "0xFE40")];
    await walk(t, 1009, 1014); t.m.store.flush();
    assert.equal(t.m.store.order("ORD-N").commit, proofT(S)); assert.equal(t.m.store.order("ORD-N").paid, true);
    const disk = fs.readFileSync(path.join(DIR, "shop.json"), "utf8");
    for (const v of [S, S.toLowerCase(), S.slice(2), S.slice(2).toLowerCase()]) { assert.ok(!disk.includes(v), "not in shop.json"); assert.ok(!errs.join("\n").includes(v), "not logged"); }
    assert.ok(!JSON.stringify(t.m.shop.orderDetail("ORD-N")).includes(S.slice(2)), "not given to the screen");
  } finally { console.error = err; }
});

test("two orders with one reference: different secrets are paid each by its own coins; the same buyer's order sent again is one order; the same proof from another buyer holds both; one without a secret is held, the other not", async () => {
  // different secrets: no holds, each paid by its own coin, a coin proving neither is noted once on each, never counted
  { const A = newSecret(), B = newSecret(), t = await setupS("two1");
    t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", A), await sealS(t, t.atk, "ORD-V", 1010, "COPIER", B)];
    t.st.pay = [payS("ORD-V", 1011, proofT(B), "0xFE50"), payS("ORD-V", 1012, proofT(newSecret()), "0xFE51", "0.0002"), payS("ORD-V", 1012, undefined, "0xFE52", "0.0001"), payS("ORD-V", 1013, proofT(A), "0xFE53")];
    await walk(t, 1009, 1011);   // each coin is counted in the pass at its block (0.18.300): B's at 1011, the stray ones at 1012, A's at 1013
    const a = t.m.store.order("ORD-V"), b = copyOf(t, t.atk);
    assert.deepEqual(a.problems, []); assert.deepEqual(b.problems, [], "neither is held by the other");
    assert.equal(b.paid, true, "B paid by its own coin"); assert.equal(t.m.store.mayAdvance(b), true, "and confirmable at once: its payment proves its secret");
    await walk(t, 1012, 1012);
    // CHANGED on purpose (0.18.304): a note, never a problem (it held the order, so its own proved coin then could not pay it)
    assert.deepEqual(t.m.store.order("ORD-V").notes, [NOPROOF("0xFE51", "0.0002")], "one note on the unpaid order, the first coin's id whole, not one per coin"); assert.deepEqual(t.m.store.order("ORD-V").problems, []);
    assert.deepEqual(copyOf(t, t.atk).problems, [], "an order already paid by its proof is not disturbed"); assert.equal(copyOf(t, t.atk).notes, undefined); assert.equal(copyOf(t, t.atk).paid, true);
    await walk(t, 1013, 1016);
    const a2 = t.m.store.order("ORD-V"); assert.deepEqual(a2.coins, ["0xfe53"], "A's own coin counted on it, the stray ones on nothing"); assert.equal(a2.status, "PAID", "and paid by it: the note holds nothing");
    // CHANGED on purpose (0.18.311): paid in full by its proved coin, the note (which says "check by hand") is dropped
    assert.equal(t.m.store.mayAdvance(a2), true); assert.equal(a2.notes, undefined, "the note goes once it is paid");
    for (const id of ["0xfe51", "0xfe52"]) assert.ok(!(copyOf(t, t.atk).coins || []).includes(id) && !a2.coins.includes(id)); }
  // the same buyer's order sent again (the same secret): one order, paid once
  { const A = newSecret(), t = await setupS("two2");
    t.st.msg = [await sealS(t, t.victim, "ORD-V", 1011, "VICTIM", A), await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", A)]; t.st.pay = [payS("ORD-V", 1010, proofT(A), "0xFE60")];
    await walk(t, 1011, 1016); const o = t.m.store.order("ORD-V");
    assert.equal(o.paid, true); assert.deepEqual(o.problems, []); assert.equal(copyOf(t, t.victim), null); assert.equal(o.orderBlock, 1009); }
  // the same proof from another buyer (the secret is known to someone else): both held, as orders that cannot be told apart
  { const A = newSecret(), t = await setupS("two3");
    t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", A), await sealS(t, t.atk, "ORD-V", 1010, "COPIER", A)]; t.st.pay = [payS("ORD-V", 1011, proofT(A), "0xFE70")];
    await walk(t, 1009, 1016);
    for (const o of [t.m.store.order("ORD-V"), copyOf(t, t.atk)]) { assert.equal(o.problems[0], DUPV); assert.equal(o.paid, false); assert.equal(t.m.store.mayAdvance(o), false); } }
  // one without a secret (either first): it is held, the order with a secret is not, and each is paid only by its own kind of coin
  for (const first of ["secret", "none"]) {
    const A = newSecret(), t = await setupS("two4" + first), sec = await sealS(t, t.victim, "ORD-V", first === "secret" ? 1009 : 1010, "VICTIM", A), none = await sealS(t, t.atk, "ORD-V", first === "secret" ? 1010 : 1009, "COPIER");
    t.st.msg = [sec, none]; t.st.pay = [payS("ORD-V", 1011, proofT(A), "0xFE80"), payS("ORD-V", 1011, undefined, "0xFE81")];
    await walk(t, 1009, 1015);
    const os = [t.m.store.order("ORD-V"), copyOf(t, t.atk), copyOf(t, t.victim)].filter(Boolean), v = os.find(o => o.delivery === "VICTIM"), c = os.find(o => o.delivery === "COPIER");
    assert.equal(v.paid, true, first + ": " + v.problems.join(" | ")); assert.deepEqual(v.coins, ["0xfe80"]);
    assert.equal(c.problems[0], DUPV, first); assert.equal(c.paid, false); assert.deepEqual(c.coins, ["0xfe81"], first + ": the coin without a proof is counted on the held order");
  }
});

// ---- 0.18.298: the desktop buyer sends the order's secret and proves it on every payment, as the phone Shop ----
test("buyer: the sealed order carries a fresh secret, both the payment and its Retry carry its proof in port 2, the secret is kept nowhere; a desktop vendor pays the order by that coin", async () => {
  const vendorId = await sc.deriveIdentity("vendor seed h1"), VADDR = "0x" + "5A".repeat(32);
  let m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", ""); delete SECRETS["shop-identity"];
  const sends = []; let refuse = true;
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "round trip buyer" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: "MxG0" + "D".repeat(56) } };
    if (c.startsWith("checkaddress")) return { status: true, response: { simple: true } };
    if (c.startsWith("coins")) return { status: true, response: [] };
    if (c.startsWith("send ")) { sends.push(c); if (refuse && c.includes("address:" + VADDR)) return { status: false, error: "refused" }; }
    return { status: true, response: { txpowid: "0x01" } };
  });
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  let r; try {
    r = await m.shop.placeOrder(shopOf({ shopId: "rt", vendorPublicId: vendorId.publicId, vendorAddress: VADDR }), [{ product: "Tea", quantity: 1, unitPrice: "1", lineTotal: "1" }], "1", "", "home", "");
    assert.equal(r.payError, "refused"); refuse = false; await m.shop.retryPayment(r.ref);
  } finally { console.error = err; }
  const stateOf = (c) => JSON.parse(/ state:(\{[^ ]*\})/.exec(c)[1]);
  const orderSend = sends.find(c => c.includes("address:" + m.shop.MINIMERCH)), pays = sends.filter(c => c.includes("address:" + VADDR));
  const opened = await sc.open(vendorId, stateOf(orderSend)["99"]), w = JSON.parse(Buffer.from(opened.plaintext).toString("utf8"));
  assert.match(w.nonce, /^0x[0-9A-F]{64}$/, "0x and 64 capital hexadecimal digits, as the phone's newNonce");
  assert.equal(pays.length, 2, "the refused payment and its Retry");
  for (const p of pays) assert.deepEqual(stateOf(p), { "1": "0x" + Buffer.from(r.ref).toString("hex"), "2": proofT(w.nonce) }, "port 1 the reference, port 2 the proof: " + p);
  const buy = m.store.order(r.ref); assert.equal(buy.commit, proofT(w.nonce)); m.store.flush();
  const disk = fs.readFileSync(path.join(DIR, "shop.json"), "utf8");
  for (const v of [w.nonce, w.nonce.slice(2), w.nonce.slice(2).toLowerCase()]) { assert.ok(!disk.includes(v), "the secret is not stored"); assert.ok(!errs.join("\n").includes(v), "nor logged"); assert.ok(!JSON.stringify(m.shop.orderDetail(r.ref)).includes(v), "nor given to the screen"); }
  // a second order: another secret
  await m.shop.placeOrder(shopOf({ shopId: "rt", vendorPublicId: vendorId.publicId, vendorAddress: VADDR }), [{ product: "Tea", quantity: 1, unitPrice: "1" }], "1", "", "home", "");
  const w2 = JSON.parse(Buffer.from((await sc.open(vendorId, stateOf(sends.filter(c => c.includes("address:" + m.shop.MINIMERCH))[1])["99"])).plaintext).toString("utf8"));
  assert.notEqual(w2.nonce, w.nonce);
  // the same coins at a desktop vendor
  delete SECRETS["shop-identity"]; const t = await javaSetup("rt");
  t.st.msg = [{ coinid: "0xAD01", created: 1009, state: stateOf(orderSend) }];
  t.st.pay = [{ coinid: "0xAD02", tokenid: "0x00", amount: "1", created: 1010, state: stateOf(pays[1]) }];
  await walk(t, 1009, 1014);
  const o = t.m.store.order(r.ref); assert.ok(o, "the vendor holds the order"); assert.equal(o.commit, proofT(w.nonce)); assert.equal(o.paid, true, o.problems.join(" | ")); assert.equal(o.status, "PAID");
  // an order placed before 0.18.298 (no proof kept): its Retry carries none, as its order carried no secret
  delete buy.commit; m.store.setMetaSync("unpaid:" + r.ref, true); sends.length = 0; await m.shop.retryPayment(r.ref);
  assert.deepEqual(stateOf(sends.find(c => c.includes("address:" + VADDR))), { "1": "0x" + Buffer.from(r.ref).toString("hex") });
  buy.commit = "0x12 tokenid:0xFF"; m.store.setMetaSync("unpaid:" + r.ref, true); sends.length = 0;
  await assert.rejects(m.shop.retryPayment(r.ref), /Invalid order proof/); assert.equal(sends.filter(c => c.includes("address:" + VADDR)).length, 0, "nothing sent");
});


// ---- 0.18.300: the review's scenarios (review-desktop-r3 R1, R2, R2b, R4): a payment the vendor's own wallet spends after tip pb + 3, with no
// pass at pb + 3, a failed orders read there, a long failure, or a gap above it, was never counted on 0.18.289 to 0.18.299 (released 0.18.286
// counted it). It is counted when first read, the order settles, and ends PAID and confirmable; at once for an order whose payment proves its secret ----
const rScen = async (name, kind, ob, steps) => {
  const S = newSecret(), t = await setupS(name + kind), ref = "ORD-" + name.toUpperCase();
  t.st.msg = [await sealS(t, t.victim, ref, ob, "VICTIM", kind === "secret" ? S : undefined)]; const p = payS(ref, 1010, kind === "secret" ? proofT(S) : undefined, "0xFD" + Buffer.from(name).toString("hex")); t.st.pay = [p];
  await steps(t, p, ref);
  const o = t.m.store.order(ref); assert.equal(o.paid, true, name + " " + kind + ": " + o.problems.join(" | ")); assert.equal(o.status, "PAID"); assert.equal(o.paidAmount, "1"); assert.equal(t.m.store.mayAdvance(o), true, name + " " + kind + ": settled");
  return t;
};
test("R1, R2, R2b, R4: a payment spent by the vendor's wallet after tip pb + 3 was counted when first read; the order ends PAID and confirmable", async () => {
  for (const kind of ["none", "secret"]) {
    // R1: no pass at tip pb + 3 (1012 -> 1014); the wallet's send posted at 1013 is mined in 1014
    await rScen("r1", kind, 1009, async (t, p) => { await walk(t, 1001, 1012); p.spent = true; t.st.tip = 1014; await t.m.shop.scanOnce(); await walk(t, 1015, 1030); });
    // R2: the orders read fails at tip pb + 3 only
    await rScen("r2", kind, 1009, async (t, p) => { await walk(t, 1001, 1012); t.st.mode = "throw"; t.st.tip = 1013; await t.m.shop.scanOnce(); t.st.mode = "ok"; p.spent = true; await walk(t, 1014, 1030); });
    // R2b: the orders read fails from 1008 to 1020; the spend is mined in 1016
    await rScen("r2b", kind, 1005, async (t, p, ref) => { await walk(t, 1001, 1007); t.st.mode = "throw"; await walk(t, 1008, 1015);
      const o = t.m.store.order(ref); assert.equal(o.paid, true, "counted during the failure"); assert.equal(t.m.store.mayAdvance(o), kind === "secret", kind === "secret" ? "proved: confirmable at once" : "not settled while no orders read succeeds");
      p.spent = true; await walk(t, 1016, 1020); t.st.mode = "ok"; await walk(t, 1021, 1030); });
    // R4: counted, then a catch-up to 1100 whose orders read is cut to 32 blocks opens a gap above the coin; the wallet spends it
    await rScen("r4", kind, 1009, async (t, p, ref) => { await walk(t, 1001, 1011);
      t.st.hook = (d) => (d > 32 ? { status: true, response: { tooBig: true } } : null); t.st.tip = 1100; await t.m.shop.scanOnce();
      assert.equal(t.m.store.mayAdvance(t.m.store.order(ref)), kind === "secret", "a gap of unread orders above the coin: not settled (none: " + kind + ")");
      t.st.hook = null; p.spent = true; await walk(t, 1101, 1110); });
  }
});
// R3a (review-desktop-r3): away more than 1016 blocks, the real order just under the window's reach, the payment and a copier's order above it,
// the same pass's root orders read failing. For orders without a secret it is as released 0.18.286 (the copier's order is paid before the real
// one can be read). With a secret it is closed: the payment proves only the real order.
test("R3a with a secret: the real order under the window's reach is paid by its proved coin once read; the copier's order above it never is", async () => {
  for (const atkSecret of [undefined, newSecret()]) {
    const S = newSecret(), t = await setupS("r3a" + !!atkSecret), V = "0xFD3A";
    t.st.pay = [payS("ORD-V", 1077, proofT(S), V)]; t.st.msg = [await sealS(t, t.victim, "ORD-V", 1075, "VICTIM", S), await sealS(t, t.atk, "ORD-V", 1078, "COPIER", atkSecret)];
    const m = await t.reopen(); t.st.tip = 2100; t.st.hook = (d) => { if (d > 1024) throw new Error("RPC timed out"); return null; };
    await m.shop.scanOnce();
    const c = m.store.order("ORD-V"); assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, false); assert.equal(m.store.mayAdvance(c), false, "the copier's order cannot be confirmed");
    t.st.hook = null; t.st.tip = 2101; await m.shop.scanOnce();
    const v = m.store.order("ORD-V~" + t.victim.publicId);
    assert.ok(v, "the real order is read"); assert.equal(v.paid, true); assert.equal(m.store.mayAdvance(v), true); assert.deepEqual(v.coins, [V.toLowerCase()]);
    assert.equal(m.store.order("ORD-V").paid, false); assert.ok(!(m.store.order("ORD-V").coins || []).length);
  }
});

// ---- 0.18.301: a tip that comes while a pass is running gets a pass of its own on the next poll ----
test("the poll: a new tip seen while a pass is running is not taken as scanned; the next poll scans it", async () => {
  const t = await javaSetup("tick"); const base = javaNode(t.m, t.st); let release, hold = null;
  t.m.shop._setRunner(async (c) => { if (hold && c.startsWith("coins address:" + t.m.shop.MINIMERCH)) await hold; return base(c); });
  t.st.tip = 1001; hold = new Promise(r => { release = r; }); const running = t.m.shop._tick();
  await new Promise(r => setImmediate(r));   // the pass at 1001 is reading its orders
  t.st.tip = 1002; await t.m.shop._tick();   // a poll during it
  hold = null; release(); await running;
  assert.equal(Number(t.m.store.getMeta("scanTip")), 1001, "the pass at 1001 finished");
  await t.m.shop._tick(); assert.equal(Number(t.m.store.getMeta("scanTip")), 1002, "the tip seen during it gets its pass");
});

// ---- 0.18.304: settled is latched on the order (review-desktop-r4 S1a, S1b, S1c, R4). The settling of 0.18.300 looked only at the last pass's
// orders read, kept in memory: a paid, settled order went back to settling after one failed orders read, after a restart, or after a cut
// catch-up, and a CONFIRMED order could not be shipped. Released 0.18.286 (no settling) confirmed, shipped and delivered in every one of them ----
test("S1a, S1b, S1c, R4: a settled order stays settled through a failed orders read, a restart and a cut catch-up; a confirmed one is never held; an order paid before 0.18.304 is settled", async () => {
  const paidSettled = async (name) => { const t = await setupS(name); t.st.msg = [await sealS(t, t.victim, "ORD-S1", 1009, "VICTIM")]; t.st.pay = [payS("ORD-S1", 1010, undefined, "0xF1")];
    await walk(t, 1001, 1012); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-S1")), false, "tip 1012: a fresh order without a secret still settles");
    await walk(t, 1013, 1020); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-S1")), true, "settled by the good pass at 1013"); return t; };
  // S1a: the orders read fails at 1021
  { const t = await paidSettled("s1a"); t.st.mode = "throw"; t.st.tip = 1021; await t.m.shop.scanOnce();
    assert.equal(t.m.shop.orderDetail("ORD-S1").settling, null, "S1a: not held again by a failed read"); await t.m.shop.advanceStatus("ORD-S1", "CONFIRMED"); assert.equal(t.m.store.order("ORD-S1").status, "CONFIRMED"); }
  // S1b: confirmed, then a restart whose first pass's orders read fails: shipped before any pass, after the failed one, delivered after a good one
  { const t = await paidSettled("s1b"); await t.m.shop.advanceStatus("ORD-S1", "CONFIRMED");
    const m = await t.reopen(); assert.equal(m.store.mayAdvance(m.store.order("ORD-S1")), true, "S1b: after a restart, before any pass");
    await m.shop.advanceStatus("ORD-S1", "SHIPPED"); t.st.mode = "throw"; t.st.tip = 1021; await m.shop.scanOnce();
    assert.equal(m.store.mayAdvance(m.store.order("ORD-S1")), true, "S1b: after a failed first pass"); t.st.mode = "ok"; t.st.tip = 1022; await m.shop.scanOnce();
    await m.shop.advanceStatus("ORD-S1", "DELIVERED"); assert.equal(m.store.order("ORD-S1").status, "DELIVERED"); }
  // S1c: a catch-up to 1200 whose orders read is cut to 32 blocks opens a gap above the coin; every later pass too
  { const t = await paidSettled("s1c"); t.st.hook = (d) => (d > 32 ? { status: true, response: { tooBig: true } } : null);
    for (const x of [1200, 1201, 1202, 1203, 1210]) { t.st.tip = x; await t.m.shop.scanOnce(); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-S1")), true, "S1c: tip " + x); }
    await t.m.shop.advanceStatus("ORD-S1", "CONFIRMED"); }
  // R4 settled before the gap opened (its coin counted at 1010, a good pass at 1013, then the cut catch-up to 1100): confirmable throughout
  { const t = await javaSetup("r4s"); t.st.msg = [await t.seal("ORD-R4", 1009)]; const p = t.pay("ORD-R4", 1010); t.st.pay = [p]; await walk(t, 1001, 1013);
    t.st.hook = (d) => (d > 32 ? { status: true, response: { tooBig: true } } : null); t.st.tip = 1100; await t.m.shop.scanOnce();
    assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-R4")), true, "R4: settled before the gap"); t.st.hook = null; p.spent = true; await walk(t, 1101, 1110);
    assert.equal(t.m.store.order("ORD-R4").paid, true); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-R4")), true); }
  // a confirmed or moved-on order is never held, whatever its latch; an order paid before 0.18.304 (no `settled`) is settled; not after a restart either
  { const t = await javaSetup("latch"), S = t.m.store, base = { role: "sell", shopId: "latch", amount: "1", currency: "Minima", tokenid: "0x00", items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], shipping: "", problems: [], due: "1", paid: true, coinBlock: 5000 };
    S.upsertOrder(Object.assign({ ref: "ORD-L1", status: "CONFIRMED", settled: false }, base)); S.upsertOrder(Object.assign({ ref: "ORD-L2", status: "SHIPPED", settled: false }, base));
    S.upsertOrder(Object.assign({ ref: "ORD-L3", status: "PAID" }, base)); S.upsertOrder(Object.assign({ ref: "ORD-L4", status: "PAID", settled: false }, base));
    const m = await t.reopen();
    for (const r of ["ORD-L1", "ORD-L2", "ORD-L3"]) { assert.equal(m.store.settleBlock(m.store.order(r)), 0, r); assert.equal(m.store.mayAdvance(m.store.order(r)), true, r); }
    assert.equal(m.store.settleBlock(m.store.order("ORD-L4")), 5003, "a payment of this version still settles"); }
  // a latched PAID order that meets a second buyer's order with its reference is unpaid and held as before, and the latch goes with the payment
  { const t = await setupS("s1m"); t.st.pay = [payS("ORD-V", 1010, undefined, "0xF2")]; t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER")];
    await walk(t, 1010, 1015); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-V")), true, "settled");
    t.st.msg.push(await sealS(t, t.victim, "ORD-V", 1020, "VICTIM")); await walk(t, 1020, 1021);
    const c = t.m.store.order("ORD-V"); assert.equal(c.paid, false); assert.equal(c.status, "UNCHECKED"); assert.equal(c.settled, false); assert.equal(c.problems[0], DUPV);
    assert.equal(t.m.store.mayAdvance(c), false); assert.equal(t.m.store.mayAdvance(copyOf(t, t.victim)), false); }
});

// ---- 0.18.304: a coin without an order's proof is a note on it, never a hold (review-desktop-r4 S2a, S2b, S2c, S2d, S4). It went through
// flagDuplicate (due cleared, UNCHECKED), so a stranger's coin with the reference stopped the proved payment from paying the order; released
// 0.18.286 paid all three. Within one block coins are judged by coin id, never by Number() of amounts (of different tokens, rounded) ----
test("S2a, S2b, S2c, S2d: a coin with the reference and without the order's proof is a note, never a hold: the proved payment pays the order; S4: a copier's order is never paid", async () => {
  const run = async (name, fn) => { const S = newSecret(), P = proofT(S), t = await setupS(name); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", S)]; await fn(t, P);
    return t.m.store.order("ORD-V"); };
  const paid = (t, o, coins, note) => { assert.equal(o.paid, true, o.problems.join(" | ")); assert.equal(o.status, "PAID"); assert.deepEqual(o.problems, []); assert.deepEqual(o.coins, coins); assert.equal(o.due, "1");
    // CHANGED on purpose (0.18.311): an order paid in full by its proved coins carries no note (it said "check by hand"); `note` is the coin that left one
    assert.equal(o.notes, undefined, "no note on the paid order (" + note + ")"); };
  // S2a: a worthless token's coin with the reference and no proof, the same block as the proved payment
  { let t; const o = await run("s2a", async (x, P) => { t = x; x.st.pay = [payS("ORD-V", 1010, P, "0xFE01"), Object.assign(payS("ORD-V", 1010, undefined, "0xBAD1", "0.000000001"), { tokenid: "0x" + "AB".repeat(32), tokenamount: "1000000" })]; await walk(x, 1001, 1020); });
    // released 0.18.286 kept the worthless coin on the order as WRONG_TOKEN's; here it pays no order: it proves nothing
    paid(t, o, ["0xfe01"], "0xBAD1"); assert.equal(t.m.store.mayAdvance(o), true); await t.m.shop.advanceStatus("ORD-V", "CONFIRMED"); }
  // S2b: a dust coin with no proof between a half payment and its top-up
  { let t; const o = await run("s2b", async (x, P) => { t = x; x.st.pay = [payS("ORD-V", 1010, P, "0xFE01", "0.5")]; await walk(x, 1001, 1012);
      assert.equal(x.m.store.order("ORD-V").status, "UNDERPAID");
      x.st.pay.push(payS("ORD-V", 1013, undefined, "0xBAD2", "0.0000001")); await walk(x, 1013, 1014);
      assert.equal(x.m.store.order("ORD-V").status, "UNDERPAID", "the note changes nothing"); assert.equal(x.m.store.order("ORD-V").due, "1");
      x.st.pay.push(payS("ORD-V", 1015, P, "0xFE02", "0.5")); await walk(x, 1015, 1020); });
    paid(t, o, ["0xfe01", "0xfe02"], "0xBAD2"); assert.equal(t.m.store.mayAdvance(o), true); }
  // S2c: the dust coin after the proved payment: paid, nothing noted on a paid order
  { let t; const o = await run("s2c", async (x, P) => { t = x; x.st.pay = [payS("ORD-V", 1010, P, "0xFE01"), payS("ORD-V", 1012, undefined, "0xBAD3", "0.0000001")]; await walk(x, 1001, 1020); });
    paid(t, o, ["0xfe01"], null); }
  // S2d: a coin with another proof before the real payment
  { let t; const o = await run("s2d", async (x, P) => { t = x; x.st.pay = [payS("ORD-V", 1010, proofT(newSecret()), "0xBAD4", "0.0000001")]; await walk(x, 1001, 1012);
      x.st.pay.push(payS("ORD-V", 1013, P, "0xFE01")); await walk(x, 1013, 1020); });
    paid(t, o, ["0xfe01"], "0xBAD4"); }
  // an unpaid order with a note can be checked by hand (a buyer who paid by hand without the proof); the screen shows the note
  { let t; const o = await run("s2h", async (x) => { t = x; x.st.pay = [payS("ORD-V", 1010, undefined, "0xBAD5", "1")]; await walk(x, 1001, 1014); });
    assert.equal(o.paid, false); assert.equal(o.status, "PENDING"); assert.deepEqual(o.notes, [NOPROOF("0xBAD5")]); assert.equal(t.m.store.mayAdvance(o), false);
    t.m.shop.vendorCheck("ORD-V"); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-V")), true, "checked by hand");
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.ok(app.includes("o.notes.map(p => \"• \" + esc(p))") && app.includes("\"This order is not paid yet:\\n\" + o.notes.map"), "the note is shown, and said in the check-by-hand question"); }
  // S4: copier first (no secret, their own, malformed, the victim's proof as their secret in either case), then the payment, then the real order
  const S = newSecret(), P = proofT(S);
  for (const [tag, n] of [["none", undefined], ["own", newSecret()], ["malformed", "0x1234"], ["proof", P], ["proof lower", P.toLowerCase()]]) {
    const t = await setupS("s4" + tag.replace(" ", "")); t.st.pay = [payS("ORD-V", 1010, P, "0xFE01")];
    t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER", n), await sealS(t, t.victim, "ORD-V", 1012, "VICTIM", S)]; await walk(t, 1009, 1016);
    const c = t.m.store.order("ORD-V"), v = copyOf(t, t.victim);
    assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, false, tag); assert.ok(!(c.coins || []).length, tag); assert.equal(t.m.store.mayAdvance(c), false, tag);
    assert.equal(v.paid, true, tag); assert.deepEqual(v.coins, ["0xfe01"], tag); assert.equal(t.m.store.mayAdvance(v), true, tag);
  }
  { const t = await setupS("s4two"), atk2 = await t.m.sc.deriveIdentity("s4two copier2"); t.st.pay = [payS("ORD-V", 1010, P, "0xFE01")];
    t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER"), await sealS(t, atk2, "ORD-V", 1011, "COPIER2", newSecret()), await sealS(t, t.victim, "ORD-V", 1012, "VICTIM", S)]; await walk(t, 1009, 1016);
    const v = copyOf(t, t.victim); assert.equal(v.paid, true); assert.equal(t.m.store.mayAdvance(v), true);
    for (const o of t.m.store.orders().filter(x => x.delivery !== "VICTIM")) { assert.equal(o.paid, false, o.delivery); assert.ok(!(o.coins || []).length); } }
  // one block: coins judged by coin id, whatever their amounts say as floats
  { const t = await setupS("order"), seen = []; t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")];
    t.st.pay = [payS("ORD-V", 1010, undefined, "0xC2", "0.30000000000000000001"), payS("ORD-V", 1010, undefined, "0xC1", "0.3"), payS("ORD-V", 1010, undefined, "0xC3", "0.4")];
    const real = t.m.store.recordPayment; t.m.store.recordPayment = function (ref, amount, tok, id) { seen.push(id); return real.apply(this, arguments); };
    await walk(t, 1010, 1010); assert.deepEqual(seen.slice(0, 3), ["0xC1", "0xC2", "0xC3"]); }
});

// ---- 0.18.306: an order arriving WITH a secret does not unpay a PAID order without one (review-desktop-r4 S5): the paid order is paid by a coin
// without a proof, which an honest buyer with a secret never sends. Released 0.18.286 kept the paid order PAID ----
test("S5: a PAID order without a secret stays paid when another buyer's order with a secret and its reference comes; one without a secret, or with one that cannot be read, still holds it", async () => {
  const run = async (name, nonce, legacy) => { const t = await setupS(name); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")]; t.st.pay = [payS("ORD-V", 1010, undefined, "0xFE01")];
    await walk(t, 1009, 1010); assert.equal(t.m.store.order("ORD-V").paid, true);
    if (legacy) { const o = t.m.store.order("ORD-V"); delete o.noSecret; t.m.store.flush(); }
    t.st.msg.push(await sealS(t, t.atk, "ORD-V", 1011, "COPIER", nonce)); await walk(t, 1011, 1016); return [t, t.m.store.order("ORD-V"), copyOf(t, t.atk)]; };
  { const [t, v, c] = await run("s5", newSecret());
    assert.equal(v.paid, true, v.problems.join(" | ")); assert.equal(v.status, "PAID"); assert.deepEqual(v.problems, []); assert.equal(t.m.store.mayAdvance(v), true, "settled at 1013");
    assert.equal(c.paid, false); assert.ok(!(c.coins || []).length); assert.deepEqual(c.problems, [], "it waits for its own proved coin"); assert.equal(c.status, "PENDING");
    // CHANGED on purpose (0.18.309, review-desktop-r5 N1): it says the clash in one note (it was silent)
    assert.deepEqual(c.notes, [DUPV]);
    await t.m.shop.advanceStatus("ORD-V", "CONFIRMED"); }
  for (const [tag, nonce, legacy] of [["none", undefined], ["unreadable", "0x1234"], ["legacy", newSecret(), true]]) {
    const [t, v, c] = await run("s5" + tag, nonce, legacy);
    assert.equal(v.paid, false, tag); assert.equal(v.status, "UNCHECKED", tag); assert.equal(v.problems[0], DUPV, tag); assert.equal(t.m.store.mayAdvance(v), false, tag);
    assert.equal(c.paid, false, tag); assert.equal(t.m.store.mayAdvance(c), false, tag);
  }
});

// ---- 0.18.306: a check by hand made while an order settles (only to move it on early) does not make it immune to a second order with its
// reference mined before its hold would have run out (review-desktop-r4 S3: the vendor checked the copier's settling order, the real order
// came 2 blocks later, and the copier's order stayed PAID and confirmable) ----
test("S3: an order checked by hand while settling is still held by a second order without a secret mined up to the block its hold ran to; not after it, nor once confirmed", async () => {
  const run = async (name, realAt, confirm) => { const t = await setupS(name); t.st.pay = [payS("ORD-V", 1010, undefined, "0xFE01")]; t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER")];
    await walk(t, 1001, 1011); assert.deepEqual(t.m.shop.orderDetail("ORD-V").settling, { block: 1013 });
    t.m.shop.vendorCheck("ORD-V"); assert.equal(t.m.store.mayAdvance(t.m.store.order("ORD-V")), true, "checked by hand: it may move on");
    if (confirm) await t.m.shop.advanceStatus("ORD-V", "CONFIRMED");
    t.st.msg.push(await sealS(t, t.victim, "ORD-V", realAt, "VICTIM")); await walk(t, 1012, realAt + 4); return [t, t.m.store.order("ORD-V"), copyOf(t, t.victim)]; };
  for (const at of [1012, 1013]) {
    const [t, c, v] = await run("s3" + at, at);
    assert.equal(c.paid, false, "real order at " + at); assert.equal(c.status, "UNCHECKED"); assert.equal(c.handChecked, undefined, "the check made while settling goes"); assert.equal(c.problems[0], DUPV);
    assert.equal(t.m.store.mayAdvance(c), false); assert.equal(t.m.store.mayAdvance(v), false); await assert.rejects(t.m.shop.advanceStatus("ORD-V", "CONFIRMED"), /Check it by hand first/);
    assert.equal(t.m.store.handCheck("ORD-V"), true, "and it can be checked by hand again");
  }
  { const [t, c] = await run("s3late", 1014); assert.equal(c.paid, true, "mined after the hold would have run out: the check stands"); assert.equal(t.m.store.mayAdvance(c), true); }
  { const [t, c] = await run("s3conf", 1012, true); assert.equal(c.status, "CONFIRMED", "moved on: left as it is"); assert.equal(t.m.store.mayAdvance(c), true); }
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("\\n\\nAnother order with this reference can still arrive until block \" + d.settling.block + \"; it will put both orders back on a check by hand.\""), "the question says so");
});

// ---- 0.18.308: the review's nits (review-desktop-r4 G5) ----
test("a coin given up on flags the order it would pay (another buyer's copy too); one that names no order is cleared by Dismiss; at most 64 are said", async () => {
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try {
    // the victim's copy ORD-V~victim (with a secret) is the order the coin proves; the copier's ORD-V is held under the reference
    { const S = newSecret(), t = await setupS("gv"); t.st.msg = [await sealS(t, t.atk, "ORD-V", 1009, "COPIER"), await sealS(t, t.victim, "ORD-V", 1010, "VICTIM", S)]; await walk(t, 1009, 1010);
      t.st.pay = [payS("ORD-V", 1011, proofT(S), "0xFE01")]; const real = t.m.store.recordPayment; t.m.store.recordPayment = function () { throw new Error("poison"); };
      try { await walk(t, 1011, 1013); } finally { t.m.store.recordPayment = real; }
      const v = copyOf(t, t.victim), c = t.m.store.order("ORD-V"), P = "payment coin 0xFE01 could not be judged: check by hand";
      assert.ok(v.problems.includes(P), "on the order the coin would pay: " + v.problems.join(" | ")); assert.ok(!c.problems.includes(P), "not on the copier's");
      t.m.shop.vendorCheck(v.ref); assert.deepEqual(t.m.shop.scanState().gaveUp, [], "checking that order clears it"); }
    // a coin whose reference cannot be read throws before it names an order: said, and cleared by Dismiss; 70 of them: the newest 64 said
    { const t = await setupS("gn"); const bad = (i) => { const c = { coinid: "0xBB" + (100 + i), tokenid: "0x00", amount: "1", created: 1011 }; Object.defineProperty(c, "state", { get() { throw new Error("unreadable"); } }); return c; };
      t.st.pay = Array.from({ length: 70 }, (_, i) => bad(i)); await walk(t, 1011, 1013);
      const st = t.m.shop.scanState(); assert.equal(st.gaveUp.length, 64); assert.ok(!st.gaveUp.includes("0xBB100") && st.gaveUp.includes("0xBB169"), "the oldest go first");
      assert.equal(st.gaveUpNoOrder, true); assert.ok(st.text.includes("Payment coin 0xBB169 could not be judged: check by hand."));
      t.m.shop.dismissUnread(); assert.deepEqual(t.m.shop.scanState().gaveUp, []); assert.equal(t.m.shop.scanState().text, "");
      const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"); assert.ok(app.includes("|| scan.gaveUpNoOrder ? ` <button"), "the Dismiss button is offered for them"); }
  } finally { console.error = err; }
});
test("the order list says a settling order is held; a stale waiting list of the never-released 0.18.299 is dropped on load", async () => {
  const t = await setupS("held"); t.st.msg = [await sealS(t, t.victim, "ORD-H", 1009, "VICTIM")]; t.st.pay = [payS("ORD-H", 1010, undefined, "0xFE01")];
  await walk(t, 1009, 1011); assert.equal(t.m.shop.ordersList().find(o => o.ref === "ORD-H").held, true, "settling: held in the list");
  await walk(t, 1012, 1013); assert.equal(t.m.shop.ordersList().find(o => o.ref === "ORD-H").held, false);
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"); assert.ok(app.includes("${o.held ? ` <span class=\"shop-pill warn\">held</span>` : \"\"}"), "the list row shows it");
  t.m.store.setMeta("payWait", [{ coin: "0xFE09", block: 1010, ref: "ORD-H" }]); const m = await t.reopen();
  assert.equal(m.store.getMeta("payWait"), undefined, "ignored"); m.store.flush();
  assert.ok(!fs.readFileSync(path.join(DIR, "shop.json"), "utf8").includes("payWait"), "and not written back");
});

// ---- 0.18.309: a newcomer with a secret that leaves a PAID order without one as it is says so in one note (review-desktop-r5 N1). It was kept
// silent: PENDING, nothing said, and a check by hand refused, so when its buyer paid outside the app without the proof (that coin paid the other
// order) the vendor could neither see the clash nor act on the real order ----
test("N1: the real order with a secret, after a copier's order without one was paid by a coin without a proof, carries the duplicate sentence as a note and can be checked by hand; N1b: paid by its own proved coin, nothing changes", async () => {
  { const S = newSecret(), t = await setupS("n1"); t.st.pay = [payS("ORD-V", 1010, undefined, "0xFE01")]; t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER")];
    await walk(t, 1001, 1011); t.st.msg.push(await sealS(t, t.victim, "ORD-V", 1012, "VICTIM", S)); await walk(t, 1012, 1016);
    const c = t.m.store.order("ORD-V"), v = copyOf(t, t.victim);
    assert.equal(c.paid, true, "the paid order without a secret stays paid (0.18.306)"); assert.deepEqual(c.problems, []);
    assert.equal(v.paid, false); assert.equal(v.status, "PENDING"); assert.deepEqual(v.problems, [], "a note holds nothing"); assert.deepEqual(v.notes, [DUPV], "one note: the clash is said");
    assert.equal(t.m.store.mayAdvance(v), false); assert.deepEqual(t.m.shop.vendorCheck(v.ref), { ok: true }, "and it can be checked by hand"); assert.equal(t.m.store.mayAdvance(t.m.store.order(v.ref)), true);
    t.st.pay.push(payS("ORD-V", 1017, proofT(S), "0xFE02")); await walk(t, 1017, 1018);
    assert.equal(copyOf(t, t.victim).paid, true, "its own proved coin still pays it"); assert.deepEqual(copyOf(t, t.victim).coins, ["0xfe02"]);
    assert.equal(copyOf(t, t.victim).notes, undefined, "paid in full by its proved coin: the note goes (0.18.311)"); }
  { const S = newSecret(), t = await setupS("n1b"); t.st.pay = [payS("ORD-V", 1010, proofT(S), "0xFE01")]; t.st.msg = [await sealS(t, t.atk, "ORD-V", 1011, "COPIER")];
    await walk(t, 1001, 1011); t.st.msg.push(await sealS(t, t.victim, "ORD-V", 1012, "VICTIM", S)); await walk(t, 1012, 1016);
    const c = t.m.store.order("ORD-V"), v = copyOf(t, t.victim);
    assert.equal(c.paid, false); assert.equal(c.problems[0], DUPV, "the copier's unpaid order is held as before");
    assert.equal(v.paid, true, "paid by its own proved coin"); assert.deepEqual(v.coins, ["0xfe01"]); assert.deepEqual(v.problems, []); assert.equal(v.notes, undefined, "no note: no paid order without a secret was left as it is"); }
});

// ---- 0.18.309: a coin given up on and counted after all (review-desktop-r5 R6): after 3 passes that threw, its problem held the order; after a
// restart the coin was judged and counted, and the problem still held it (UNCHECKED, never PAID). Released 0.18.286 paid it ----
test("R6: a coin given up on that is counted after a restart takes its own problem away: the order is paid; a second problem, or a listing that no longer matches, still holds it", async () => {
  const run = async (name, between) => { const t = await setupS(name); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1001, "VICTIM")]; t.st.pay = [payS("ORD-V", 1002, undefined, "0xFEab06")];
    const real = t.m.store.recordPayment; let bad = true; t.m.store.recordPayment = function () { if (bad) throw new Error("transient"); return real.apply(this, arguments); };
    const err = console.error; console.error = () => {};
    try { await walk(t, 1005, 1007); bad = false; await walk(t, 1008, 1010); } finally { console.error = err; t.m.store.recordPayment = real; }
    const o = t.m.store.order("ORD-V"); assert.deepEqual(o.problems, ["payment coin 0xFEab06 could not be judged: check by hand"], name); assert.equal(o.paid, false); assert.equal(o.status, "UNCHECKED");
    if (between) await between(t);
    const m = await t.reopen(); for (let x = 1011; x <= 1016; x++) { t.st.tip = x; await m.shop.scanOnce(); }
    return [m, m.store.order("ORD-V")]; };
  { const [m, o] = await run("r6");
    assert.equal(o.paid, true, JSON.stringify(o.problems)); assert.equal(o.status, "PAID"); assert.deepEqual(o.problems, []); assert.equal(o.due, "1", "what is due, from the listing as for a fresh order"); assert.equal(o.paidAmount, "1");
    assert.deepEqual(o.coins, ["0xfeab06"]); assert.equal(m.store.mayAdvance(o), true); }
  { const [m, o] = await run("r6dup", async (t) => { t.st.msg.push(await sealS(t, t.atk, "ORD-V", 1010, "COPIER")); await walk(t, 1010, 1010); });
    assert.equal(o.paid, false, "a second, unrelated problem still holds it"); assert.equal(o.status, "UNCHECKED"); assert.deepEqual(o.problems, [DUPV]); assert.equal(o.paidAmount, "1", "the coin is counted");
    assert.equal(m.store.mayAdvance(o), false); }
  { const [m, o] = await run("r6list", async (t) => { const s = t.m.store.shop("r6list"); s.products[0].price = "2"; t.m.store.saveShop(s); });
    assert.equal(o.paid, false, "checked again against the listing as it is now: it no longer matches"); assert.equal(o.status, "UNCHECKED"); assert.equal(o.due, "");
    assert.deepEqual(o.problems, ["\"Tea\": the order's price 1 is not your price 2"]); assert.equal(m.store.mayAdvance(o), false); }
});

// ---- 0.18.311: the note of a coin without the order's proof names its amount (as the node gave it, never rounded) and its token id whole, or
// Minima, so a stranger's dust or worthless token is told apart from a buyer's real payment made without the proof (review-desktop-r5); once the
// order is paid in full by its proved coins the note, which says "check by hand", is dropped; an unpaid order keeps it ----
test("the no-proof note names the coin's amount exactly and its token id whole (or Minima), every id uncut; paid in full by its proved coin, the note goes; an unpaid order keeps it", async () => {
  const TOK = "0x" + "AB".repeat(32), BIG = "0x" + "CD".repeat(32), AMT = "123456789012345678.12345678901234567890123456789012345678901234";
  { const S = newSecret(), t = await setupS("nt1"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", S)];
    t.st.pay = [Object.assign(payS("ORD-V", 1010, undefined, BIG, "0.000000001"), { tokenid: TOK, tokenamount: AMT })]; await walk(t, 1001, 1012);
    const o = t.m.store.order("ORD-V"), n = NOPROOF(BIG, AMT, TOK); assert.ok(n.length > 300, "longer than the old 300-character cut: " + n.length);
    assert.deepEqual(o.notes, [n], "the coin's id, amount and token id whole"); assert.equal(o.paid, false); assert.equal(o.status, "PENDING");
    assert.deepEqual(t.m.store.order("ORD-V").notes, [n], "an unpaid order keeps it");
    t.st.pay.push(payS("ORD-V", 1013, proofT(S), "0xFE01")); await walk(t, 1013, 1016);
    const p = t.m.store.order("ORD-V"); assert.equal(p.paid, true); assert.equal(p.status, "PAID"); assert.deepEqual(p.coins, ["0xfe01"]); assert.equal(p.notes, undefined, "paid in full by its proved coin: no note"); }
  { const S = newSecret(), t = await setupS("nt2"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM", S)];
    t.st.pay = [payS("ORD-V", 1010, undefined, "0xBAD7", "0.00000010")]; await walk(t, 1001, 1012);
    assert.deepEqual(t.m.store.order("ORD-V").notes, [NOPROOF("0xBAD7", "0.00000010", "Minima")], "Minima, the amount as the node wrote it (its trailing zero kept)");
    t.st.pay.push(payS("ORD-V", 1013, proofT(S), "0xFE01", "0.4")); await walk(t, 1013, 1016);
    assert.equal(t.m.store.order("ORD-V").status, "UNDERPAID"); assert.deepEqual(t.m.store.order("ORD-V").notes, [NOPROOF("0xBAD7", "0.00000010", "Minima")], "part paid: the note stays"); }
});

// ---- 0.18.312: coins of another token never fill an order's coin list (review-desktop-r5 N2c2, as Pandamonium Desktop). On an order without a
// secret, 2000 worthless-token coins with its reference in the block of the real payment filled ORDER_COINS_MAX (1000), and the real payment
// was never counted ----
test("N2c2: 2000 worthless-token coins with the reference in the real payment's block do not stop it: the order is paid; WRONG_TOKEN is said once, and nothing is written for a wrong coin seen again", async () => {
  const TOK = "0x" + "AB".repeat(32), id = (s) => "0x" + nodeCrypto.createHash("sha256").update(s).digest("hex").toUpperCase();
  const junk = (i) => Object.assign(payS("ORD-V", 1010, undefined, id("junk " + i), "0.000000001"), { tokenid: TOK, tokenamount: "1000000" });
  { const t = await setupS("n2c2"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")];
    t.st.pay = [payS("ORD-V", 1010, undefined, id("real"))].concat(Array.from({ length: 2000 }, (_, i) => junk(i)));
    await walk(t, 1001, 1016); const o = t.m.store.order("ORD-V");
    assert.equal(o.paid, true, o.status); assert.equal(o.status, "PAID"); assert.deepEqual(o.coins, [id("real").toLowerCase()], "only the real payment is on the order's list"); }
  // only wrong coins: WRONG_TOKEN with the token paid, as before; seen again (a restart) nothing changes and nothing is written
  { const t = await setupS("n2wt"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")]; t.st.pay = [junk(1), junk(2)];
    await walk(t, 1001, 1012); const o = t.m.store.order("ORD-V");
    assert.equal(o.status, "WRONG_TOKEN"); assert.equal(o.paidTokenid, TOK); assert.deepEqual(o.coins || [], [], "never counted");
    const m = await t.reopen(); const f = m.store.flush; let writes = 0; m.store.flush = function () { writes++; return f.apply(this, arguments); };
    assert.equal(m.store.recordPayment("ORD-V", "1000000", TOK, id("junk 1"), 1010), "WRONG_TOKEN"); assert.equal(writes, 0, "a wrong coin seen again writes nothing");
    t.st.pay.push(payS("ORD-V", 1013, undefined, id("real"))); for (let x = 1013; x <= 1017; x++) { t.st.tip = x; await m.shop.scanOnce(); }
    assert.equal(m.store.order("ORD-V").status, "PAID", "the right token still pays it"); }
});

// ---- 0.18.314: coins of two worthless tokens taking turns (review-desktop-r6 H5d) wrote shop.json once per coin, since a write was made whenever
// the token paid or the status changed; and again after every restart, as such coins are not remembered. A write is now made only when the order's
// status changes. H5c: a right-token coin that pays part of the order after a wrong-token coin said WRONG_TOKEN; it now says UNDERPAID ----
test("H5d: 2000 coins of two worthless tokens taking turns write shop.json at most twice, and at most twice after a restart; WRONG_TOKEN, and the real payment still pays it; H5c: part paid in the right token after a wrong coin is UNDERPAID", async () => {
  const T1 = "0x" + "AB".repeat(32), T2 = "0x" + "CD".repeat(32), id = (s) => "0x" + nodeCrypto.createHash("sha256").update(s).digest("hex").toUpperCase();
  { const t = await setupS("h5d"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")]; await walk(t, 1001, 1009);
    t.st.pay = Array.from({ length: 2000 }, (_, i) => Object.assign(payS("ORD-V", 1010, undefined, id("junk " + i), "0.000000001"), { tokenid: i % 2 ? T1 : T2, tokenamount: "1000" }));
    let w = 0; const wf = fs.writeFileSync; fs.writeFileSync = function (p) { if (/shop\.json/.test(String(p))) w++; return wf.apply(this, arguments); };
    try {
      await walk(t, 1010, 1010); assert.ok(w <= 2, "first sight: " + w + " writes"); assert.equal(t.m.store.order("ORD-V").status, "WRONG_TOKEN");
      const m = await t.reopen(); w = 0; t.st.tip = 1011; await m.shop.scanOnce(); assert.ok(w <= 2, "after a restart: " + w + " writes"); assert.equal(m.store.order("ORD-V").status, "WRONG_TOKEN");
      t.st.pay.push(payS("ORD-V", 1012, undefined, id("real"))); for (let x = 1012; x <= 1016; x++) { t.st.tip = x; await m.shop.scanOnce(); }
      assert.equal(m.store.order("ORD-V").status, "PAID", "the right token still pays it"); assert.equal(m.store.order("ORD-V").paid, true);
    } finally { fs.writeFileSync = wf; } }
  { const t = await setupS("h5c"); t.st.msg = [await sealS(t, t.victim, "ORD-V", 1009, "VICTIM")];
    t.st.pay = [Object.assign(payS("ORD-V", 1010, undefined, "0xBAD1", "0.000000001"), { tokenid: T1, tokenamount: "5" })]; await walk(t, 1001, 1012);
    assert.equal(t.m.store.order("ORD-V").status, "WRONG_TOKEN");
    t.st.pay.push(payS("ORD-V", 1013, undefined, "0xFE01", "0.6")); await walk(t, 1013, 1016); assert.equal(t.m.store.order("ORD-V").status, "UNDERPAID", "part paid in the right token");
    t.st.pay.push(Object.assign(payS("ORD-V", 1017, undefined, "0xBAD2", "0.000000001"), { tokenid: T2, tokenamount: "5" })); await walk(t, 1017, 1018);
    assert.equal(t.m.store.order("ORD-V").status, "UNDERPAID", "a wrong coin after it changes nothing");
    t.st.pay.push(payS("ORD-V", 1019, undefined, "0xFE02", "0.4")); await walk(t, 1019, 1024); assert.equal(t.m.store.order("ORD-V").status, "PAID"); }
});
