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
    assert.equal(store.recordPayment(ref, "0.000000001", "0x00", coin()), "UNDERPAID", JSON.stringify(total) + ": 1 nano does not pay 2 x 1.5 + 0.2");
    assert.equal(store.recordPayment(ref, "3.199999999", "0x00", coin()), "PAID", "3.2 received = 3.2 due");
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
  assert.match(P(tea({}), null, "USDT").join(), /currency \(USDT\) is not your shop's \(Minima\)/);
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
  assert.match(o.problems.join(), /currency \(Minima\) is not your shop's \(USDT\)/, "and since 0.18.159 the order is UNCHECKED against the listing");
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
  assert.equal(o.paid, false, "the buyer's 0.000000001 total paid with 1 nano is not paid"); assert.equal(o.status, "UNDERPAID");
  paid = "3.199999999"; await shop.scanOnce();
  o = store.order("ORD-PHONE1"); assert.equal(o.paid, true); assert.equal(o.status, "PAID");
});

// ---- 0.18.163: a coin counts once across restarts; a buyer's object is never stored as sent ----
const freshModules = () => { for (const k of Object.keys(require.cache)) if (k.includes(path.join(__dirname, "..", "main"))) delete require.cache[k];
  return { store: require("../main/shop-store"), shop: require("../main/shop"), sc: require("../main/shopcrypto") }; };
test("H1: after a restart the backfill does not count the same payment coin again (a half-paid order stays half paid)", async () => {
  let m = freshModules();
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
