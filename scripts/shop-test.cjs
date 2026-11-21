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
test("a 9.95 payment and a 0.05 top-up pay a 10 order, in either order and in one scan or two; 5000 dust coins write nothing", async () => {
  const m = freshModules(); const VADDR = "MxG0" + "F".repeat(56);
  m.store.setMeta("vendorAddress", "");   // this test names its own vendor address (0.18.205 keeps a stored one)
  m.store.saveShop({ shopId: "topup", shopName: "T", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  let pay = [], msg = [];
  m.shop._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } }
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
  const runner = () => async (c) => c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: VADDR } }
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
  const runner = () => async (c) => { asked.push(c); return c.startsWith("vault") ? { status: true, response: { phrase: "vendor seed h1" } } : c.startsWith("getaddress") ? { status: true, response: { miniaddress: next } }
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
test("an order sent while the app was closed for long is read after the restart (scan tip kept, gap backfilled); a node that serves no deeper ends the backfill", async () => {
  let m = freshModules(); m.store.setMeta("vendorAddress", ""); m.store.setMeta("scanTip", 0); m.store.setMeta("bfTarget", 0); m.store.setMeta("bfFloor", 0);
  const VADDR = "MxG0" + "7".repeat(56); let tip = 1000, maxServe = 100000, msg = []; const depths = [];
  const runner = () => async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "vendor seed h1" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: VADDR } };
    if (c === "block") return { status: true, response: { block: tip } };
    const d = Number((/depth:(\d+)/.exec(c) || [])[1] || 0);
    if (c.startsWith("coins address:" + m.shop.MINIMERCH)) { depths.push(d); if (d > maxServe) return { status: false }; return { status: true, response: msg.filter(x => tip - x.created <= d) }; }
    return { status: true, response: [] };
  };
  m.store.saveShop({ shopId: "gap", shopName: "G", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "1", maxUnits: "5" }], shipping: [] });
  m.shop._setRunner(runner()); await m.shop.init(); await m.shop.scanOnce();
  assert.equal(depths[0], 256, "the very first pass"); assert.equal(Number(m.store.getMeta("scanTip")), 1000); m.store.flush();
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("gap buyer");
  const sealed = "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref: "ORD-GAP", randomid: "g", from: buyer.publicId, to: me.publicId, date: 1, shopId: "gap", items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "" })));
  msg = [{ coinid: "0xGA1".replace("G", "6"), created: 1200, state: { "99": sealed } }];   // sent while closed: 1800 blocks before the next start
  m = freshModules(); tip = 3000; depths.length = 0; m.shop._setRunner(runner()); await m.shop.init(); await m.shop.scanOnce();
  assert.deepEqual(depths, [1024, 1536], "the window, then one backfill step of 512 more");
  assert.equal(m.store.order("ORD-GAP"), null, "not reached yet"); assert.equal(Number(m.store.getMeta("bfTarget")), 1000);
  tip = 3001; depths.length = 0; await m.shop.scanOnce();
  assert.deepEqual(depths, [64, 2009], "the next pass reaches the old tip"); assert.ok(m.store.order("ORD-GAP"), "the order sent while closed is read");
  assert.equal(Number(m.store.getMeta("bfTarget")), 0, "the backfill is done");
  // a node that serves no deeper ends the backfill and says so
  m.store.flush(); m = freshModules(); tip = 9000; maxServe = 1100; depths.length = 0; m.shop._setRunner(runner()); await m.shop.init();
  const errs = [], err = console.error; console.error = (...a) => errs.push(a.join(" "));
  try { await m.shop.scanOnce(); } finally { console.error = err; }
  assert.match(errs.join(), /older than block \d+ could not be read: the node serves no deeper history/); assert.equal(Number(m.store.getMeta("bfTarget")), 0);
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

// ---- 0.18.213: a read the node did not answer advances nothing ----
test("a failed or thrown read is not covered: nothing advances, the status says so, and the next pass reads the newest part of the gap; a gap that opens during a backfill is kept", async () => {
  let m = freshModules(); m.store.clear(); m.store.setMeta("vendorAddress", "");
  const VADDR = "MxG0" + "6".repeat(56); let tip = 1000, mode = "ok", msg = []; const depths = [];
  m.shop._setRunner(async (c) => {
    if (c.startsWith("vault")) return { status: true, response: { phrase: "vendor seed h1" } };
    if (c.startsWith("getaddress")) return { status: true, response: { miniaddress: VADDR } };
    if (c === "block") return { status: true, response: { block: tip } };
    if (c.startsWith("coins address:" + m.shop.MINIMERCH)) { const d = Number(/depth:(\d+)/.exec(c)[1]); depths.push(d);
      if (mode === "refuse") return { status: false, error: "busy" }; if (mode === "throw") throw new Error("RPC timed out");
      return { status: true, response: msg.filter(x => tip - x.created <= d) }; }
    return { status: true, response: [] };
  });
  m.store.saveShop({ shopId: "fail", shopName: "F", currency: "Minima", products: [{ id: "p1", name: "Tea", price: "1", maxUnits: "5" }], shipping: [] });
  await m.shop.init(); await m.shop.scanOnce(); assert.equal(Number(m.store.getMeta("scanTip")), 1000);
  const me = m.shop.myIdentity(), buyer = await m.sc.deriveIdentity("fail buyer");
  const seal = async (ref, created) => ({ coinid: "0x" + Buffer.from(ref).toString("hex"), created, state: { "99": "0x" + await m.sc.seal(buyer, me.publicId, Buffer.from(JSON.stringify({ type: "ORDER", ref, randomid: ref, from: buyer.publicId, to: me.publicId, date: 1, shopId: "fail", items: [{ product: "Tea", quantity: 1, unitPrice: "1" }], amount: "1", currency: "Minima", shipping: "" }))) } });
  msg = [await seal("ORD-NEWEST", 2990)];
  for (const mo of ["refuse", "throw"]) {
    mode = mo; tip = 3000; await m.shop.scanOnce();
    assert.equal(Number(m.store.getMeta("scanTip")), 1000, mo + ": the scan tip does not advance"); assert.equal(Number(m.store.getMeta("bfTarget") || 0), 0, mo + ": no backfill invented");
    assert.match(m.shop.scanState().text, /Older orders could not be read yet/, mo);
  }
  mode = "ok"; tip = 3001; depths.length = 0; await m.shop.scanOnce();
  assert.ok(m.store.order("ORD-NEWEST"), "the newest part of the gap is read once the node answers");
  assert.equal(Number(m.store.getMeta("scanTip")), 3001); assert.equal(Number(m.store.getMeta("bfTarget")), 1000);
  assert.match(m.shop.scanState().text, /Reading orders and payments from while the app was closed \(back to block 1000\)/);
  // a backfill step that fails moves nothing
  const floor = Number(m.store.getMeta("bfFloor")); mode = "refuse"; tip = 3002; await m.shop.scanOnce();
  assert.equal(Number(m.store.getMeta("bfFloor")), floor); assert.equal(Number(m.store.getMeta("scanTip")), 3001);
  // a second gap while the first backfill is pending: the target stays the oldest, the floor moves under the new window
  mode = "ok"; tip = 9000; await m.shop.scanOnce();
  assert.equal(Number(m.store.getMeta("bfTarget")), 1000); assert.ok(Number(m.store.getMeta("bfFloor")) > 7000, "the new gap is read too");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "shop.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(/scanOrders\(deep, floor\)/.test(src) && /scanPayments\(deep, floor\)/.test(src), "a backfill step skips what an earlier pass read");
  assert.ok(/ipcMain\.handle\("mcd:shopScanState", \(\) => shop\.scanState\(\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8")));
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").includes("const scanLine = scan && scan.text ?"), "shown on the orders screen");
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
  let n = BigInt("0x" + b.toString("hex")), s = ""; while (n > 0n) { s = "0123456789ABCDEFGHIJKLMNOPQRSTUV"[Number(n % 32n)] + s; n /= 32n; } return "Mx" + s;
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
