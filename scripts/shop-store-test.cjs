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
// An incoming order to the vendor's own shop "tea" (Tea 1.5 x up to 10, Domestic delivery 0.2). Since 0.19.166 what is
// due comes from that listing; the buyer's amount is kept only to be shown.
store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }, { id: "p2", name: "Free sample", price: "0", maxUnits: "1" }],
  shipping: [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0.2" }] });
const sellOrder = (amount, tokenid, more) => { const ref = "ORD-T" + (++n); store.upsertOrder(Object.assign({ ref, role: "sell", shopId: "tea", amount, currency: "Minima", tokenid: tokenid || "0x00", status: "PENDING", paid: false,
  items: [{ product: "Tea", quantity: 2, unitPrice: "1.5", lineTotal: "3.000000" }], shipping: "Domestic" }, more)); return ref; };

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

// 0.19.164's tests were on the buyer's total; since 0.19.166 the figure compared is the listing's (CHANGED on purpose, as released 0.18.159).
test("recordPayment: whatever the buyer wrote as total (abc, 1e3, -5, 0, 0.000000001), the listing decides what is due", () => {
  for (const total of ["abc", "1e3", "-5", "0", "", "0x10", "0.000000001"]) {
    const ref = sellOrder(total);
    assert.equal(store.recordPayment(ref, "0xC0001", "0.000000001", "0x00"), "UNDERPAID", JSON.stringify(total) + ": 1 nano does not pay 2 x 1.5 + 0.2");
    assert.equal(store.recordPayment(ref, "0xC0002", "3.199999999", "0x00"), "PAID", "3.2 received = 3.2 due");
    assert.equal(store.order(ref).due, "3.2");
  }
  const free = sellOrder("0", "0x00", { items: [{ product: "Free sample", quantity: 1, unitPrice: "0" }], shipping: "Digital" });
  assert.equal(store.recordPayment(free, "0xC0003", "5", "0x00"), "BAD_TOTAL", "nothing due by the listing: never paid"); assert.equal(store.order(free).paid, false);
  assert.equal(store.recordPayment(free, "0xC0004", "5", "0x00"), "BAD_TOTAL", "and a second coin does not change it"); assert.equal(store.order(free).paidAmount, "10", "what arrived is still recorded");
});

// ---- 0.19.167 (the phone Inbox 0.5.15): each coin id counted once, for good; a wrong coin never pays and never blocks ----
test("recordPayment: the same coin id (any letter case) counts once; coins of the right token add up; a coin with no id counts nothing", () => {
  const ref = sellOrder("3.2");
  assert.equal(store.recordPayment(ref, "0xB1", "1.6", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(ref, "0xb1", "1.6", "0x00"), null, "the same coin again: nothing counted");
  assert.equal(store.recordPayment(ref, "0xB1", "1.6", "0x00"), null);
  assert.equal(store.order(ref).paidAmount, "1.6"); assert.equal(store.order(ref).status, "UNDERPAID");
  for (const none of ["", null, undefined]) assert.equal(store.recordPayment(ref, none, "9", "0x00"), null, "no coin id: " + none);
  assert.equal(store.recordPayment(ref, "0xB2", "9", MXUSD), "WRONG_TOKEN");
  assert.equal(store.order(ref).status, "UNDERPAID", "a wrong coin does not undo a partial payment"); assert.equal(store.order(ref).paidTokenid, "0x00");
  assert.equal(store.recordPayment(ref, "0xB3", "1.6", "0x00"), "PAID"); assert.equal(store.order(ref).paidAmount, "3.2"); assert.equal(store.order(ref).paid, true);
  assert.equal(store.recordPayment(ref, "0xB4", "5", "0x00"), "ALREADY", "PAID locks");
  assert.deepEqual(store.order(ref).coins, ["0xb1", "0xb2", "0xb3"], "the ids are kept on the order, so they survive a restart");
});
test("recordPayment: a stranger's tiny coin of another token never blocks the honest payment", () => {
  const ref = sellOrder("3.2");
  assert.equal(store.recordPayment(ref, "0xA1", "0.000000001", MXUSD), "WRONG_TOKEN");
  assert.equal(store.recordPayment(ref, "0xA2", "0.000000001", "0x00"), "UNDERPAID"); assert.equal(store.order(ref).status, "UNDERPAID", "a right-token coin moves WRONG_TOKEN on");
  assert.equal(store.recordPayment(ref, "0xA3", "3.2", "0x00"), "PAID"); assert.equal(store.order(ref).paid, true); assert.equal(store.order(ref).status, "PAID");
});

test("recordPayment: exact, cumulative, and only in the order's token", () => {
  let ref = sellOrder("3.2");
  assert.equal(store.recordPayment(ref, "0xC0005", "3.199999999999999999", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(ref, "0xC0006", "0.000000000000000001", "0x00"), "PAID");
  assert.equal(store.recordPayment(ref, "0xC0007", "1", "0x00"), "ALREADY");
  ref = sellOrder("3.2", MXUSD);
  assert.equal(store.recordPayment(ref, "0xC0008", "100", "0x00"), "WRONG_TOKEN");
});

// ---- 0.19.166 (released 0.18.159, the phone Inbox 0.5.18 Listing.check): the vendor's own listing ----
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
test("listing.check: every way an order departs from the listing is a problem, each one a sentence the Inbox says in every language", () => {
  const P = (items, shipping, currency, shopObj) => L.check(shopObj === undefined ? TEA : shopObj, { items, shipping: shipping == null ? "Domestic" : shipping, currency: currency || "Minima" }).problems;
  const tea = (o) => [Object.assign({ product: "Tea", quantity: 1, unitPrice: "1.5" }, o)], all = [];
  const got = (p) => { all.push(...p); return p.join(" | "); };
  for (const [items, why] of [[tea({ product: "Tea " }), /not in your listing/], [tea({ product: "tea" }), /not in your listing/], [tea({ unitPrice: "0.000000001" }), /is not your price 1\.5/], [tea({ unitPrice: "1e0" }), /not your price/],
    [tea({ quantity: 0 }), /not a whole number above zero/], [tea({ quantity: 1.5 }), /not a whole number/], [tea({ quantity: "2x" }), /not a whole number/], [tea({ quantity: -1 }), /not a whole number/], [tea({ quantity: 11 }), /more than you list \(10\)/],
    [tea({ nftTokenId: "0x" + "AB".repeat(32) }), /not in your listing/], [tea({ nftStateIdx: 3 }), /not in your listing/], [[], /no items/], ["not json", /no items/], [[null], /cannot be read/]])
    assert.match(got(P(items)), why, JSON.stringify(items));
  assert.match(got(P(tea({}), "Express")), /delivery method "Express" is not in your listing/);
  assert.match(got(P(tea({}), null, "USDT")), /currency \(MxUSD\) is not your shop's \(Minima\)/, "the Minima dollar token is named MxUSD, never USDT");
  assert.match(got(P(tea({}), null, "MxUSD")), /currency \("MxUSD"\) is not your shop's \(Minima\)/, "a currency the wire does not know is shown as it came, in quotes");
  assert.match(got(P(tea({}), null, null, null)), /not one of your shops/);
  assert.match(got(P(tea({}), null, null, Object.assign({}, TEA, { products: TEA.products.concat([{ name: "Tea", price: "9" }]) }))), /listed more than once/);
  assert.match(got(P(tea({}), null, null, Object.assign({}, TEA, { products: [{ name: "Tea", price: "1,5" }] }))), /your own price 1,5 is not a plain number/);
  const nft = { shopId: "n", currency: "Minima", shipping: [], products: [{ name: "Art", price: "5", nftTokenId: "0xAA", nftStateIdx: 2 }] };
  assert.deepEqual(P([{ product: "Art", quantity: 1, unitPrice: "5", nftTokenId: "0xaa", nftStateIdx: 2 }], "digital", null, nft), [], "an edition matches by name, token id and index");
  assert.match(got(P([{ product: "Art", quantity: 2, unitPrice: "5", nftTokenId: "0xAA", nftStateIdx: 2 }], "digital", null, nft)), /more than you list \(1\)/, "one of an edition");
  // every problem main gives is a listed sentence (renderer/mainsaid.js SL_*), said whole in each language
  const I18N = require("../renderer/i18n.js"); for (const c of ["zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const MS = require("../renderer/mainsaid.js"), codes = new Set();
  try {
    for (const p of all) {
      I18N.set("en"); const r = MS.read(p); assert.ok(r && /^SL_/.test(r.code), "not a listed sentence: " + p); codes.add(r.code); assert.equal(MS.say(p), p);
      for (const c of ["zh", "ru", "uk"]) { I18N.set(c); const s = MS.say(p); assert.notEqual(s, p, c + ": " + p); assert.ok(!/is not in your listing|is not your price|whole number|more than you list|not one of your shops|can be read|cannot be read|listed more than once|plain number/.test(s), c + ": " + s); }
    }
  } finally { I18N.set("en"); }
  assert.deepEqual([...codes].sort(), MS.codes().filter(c => /^SL_/.test(c)).sort(), "each listed sentence is one main gives");
});
test("an order that does not match is UNCHECKED, never paid by any amount, and can be confirmed only after the vendor checks it by hand", async () => {
  const ref = sellOrder("1000", "0x00", { items: [{ product: "Tea", quantity: 2, unitPrice: "0.000000001" }] });
  assert.equal(store.recordPayment(ref, "0xC0009", "1000000", "0x00"), "UNCHECKED");
  const o = store.order(ref); assert.equal(o.paid, false); assert.equal(o.status, "UNCHECKED"); assert.match(o.problems[0], /is not your price 1\.5/);
  assert.equal(store.mayAdvance(o), false);
  await assert.rejects(shop.advanceStatus(ref, "CONFIRMED"), /Check it by hand first/);
  for (const s of ["SHIPPED", "DELIVERED"]) await assert.rejects(shop.advanceStatus(ref, s), /Check it by hand first/);
  assert.equal(store.handCheck(sellOrder("3.2")), false, "a matching order is not 'checked by hand'");
  assert.throws(() => shop.vendorCheck(sellOrder("3.2")), /Only an order that does not match your shop is checked by hand\./);
  shop.vendorCheck(ref); assert.equal(store.mayAdvance(store.order(ref)), true); assert.equal(store.order(ref).paid, false, "still not paid");
  const Act = require("../renderer/apps-act.js");
  assert.equal(Act.shop.nextStatus({ status: "UNCHECKED", paid: false }), null); assert.equal(Act.shop.nextStatus({ status: "UNCHECKED", paid: false, handChecked: true }), "CONFIRMED");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes('th("Unchecked: the items or total do not match your shop; check by hand.")') && app.includes("!o.paid && !o.handChecked ? ((o.problems || []).length ? th(\"Check this order by hand before you can confirm it.\")")
    && /const yes = await showConfirm\(t\("Checked by hand\?"\)[\s\S]{0,700}if \(!yes\) return;\s*try \{ await api\.shopVendorCheck\(ref\);/.test(app), "the screen says so and asks before it");
  assert.ok(app.includes("${shopKv(t(\"Buyer's total\"), o.amount + \" \" + cur)}${shopCheckBlock(o, cur)}") && app.includes('shopKv(t("Due by your listing"), o.due + " " + cur)'), "the buyer's figure is named as theirs; what is due is the listing's");
  assert.ok(/ipcMain\.handle\("mcd:shopVendorCheck", \(_e, ref\) => shop\.vendorCheck\(ref\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8")));
});

// ---- the vendor's side of main/shop.js over the real store: orders are opened by a stand-in shopcrypto ----
const standIn = (rel, exports) => { const p = require.resolve(path.join(__dirname, "..", rel)); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports }; };
const ME = "0x" + "11".repeat(32), BUYER = "0x" + "22".repeat(32), VENDOR = "MxG0VENDORADDRESS0000000000000000000000000000";
standIn("main/config.js", { getSecret: () => "cached", setSecret() {}, deleteSecret() {}, rpcSecret: () => "" });
standIn("main/node-manager.js", { rpcPort: () => 0 });
standIn("main/rpc.js", { rpcCall: async () => { throw new Error("TEST LEAK: the real rpcCall"); } });
standIn("main/shopcrypto.js", { ready: async () => {}, loadIdentity: () => ({ publicId: ME }), isValidPublicId: (v) => /^0x[0-9A-F]{64}$/i.test(String(v)), seal: async () => "ab",
  open: async (_id, blob) => ({ valid: true, fromPublicId: BUYER, plaintext: Buffer.from(String(blob).slice(2), "hex") }) });
let shop = require("../main/shop");
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
  assert.equal(o.paid, false, "5 Minima does not pay a 5 MxUSD order"); assert.equal(o.paidTokenid, "0x00");
  assert.match(o.problems.join(), /currency \(Minima\) is not your shop's \(MxUSD\)/, "and since 0.19.166 the order is UNCHECKED against the listing"); assert.equal(o.status, "UNCHECKED");
});

// ---- 0.19.166: a phone-placed order (wire: items as a JSON string, shipping by id) is checked and paid end to end ----
test("vendor: a phone-placed order to my shop is checked against my listing and paid by what it says is due", async () => {
  const order = { type: "ORDER", ref: "ORD-PHONE1", shopId: "tea", shopName: "Tea", items: JSON.stringify([{ product: "Tea", size: "", quantity: 2, unitPrice: "1.5", lineTotal: "3.0" }]), product: "Tea x2",
    amount: "0.000000001", currency: "Minima", tokenid: "0x00", shipping: "domestic", delivery: "x", message: "", buyerPayaddr: "" };
  await scan([order], [{ coinid: "0xD201", ref: "ORD-PHONE1", amount: "0.000000001", tokenid: "0x00" }]);
  let o = store.order("ORD-PHONE1");
  assert.equal(o.items.length, 1, "the JSON string is read as items"); assert.equal(o.due, "3.2"); assert.deepEqual(o.problems, []);
  assert.equal(o.paid, false, "the buyer's 0.000000001 total paid with 1 nano is not paid"); assert.equal(o.status, "UNDERPAID");
  await scan([], [{ coinid: "0xD202", ref: "ORD-PHONE1", amount: "3.199999999", tokenid: "0x00" }]);
  o = store.order("ORD-PHONE1"); assert.equal(o.paid, true); assert.equal(o.status, "PAID");
  const listed = shop.ordersList().find(x => x.ref === "ORD-PHONE1"); assert.equal(listed.due, "3.2"); assert.equal(listed.unchecked, false);
});

// ---- 0.19.167: a restart forgets which coins the scan has seen; the store does not ----
test("vendor: after a restart the same payment coin is seen again and is not counted twice", async () => {
  const order = { type: "ORDER", ref: "ORD-AGAIN", shopId: "tea", shopName: "Tea", items: [{ product: "Tea", quantity: 2, unitPrice: "1.5" }], amount: "3.2", currency: "Minima", tokenid: "0x00", shipping: "Domestic" };
  const half = [{ coinid: "0xE1", ref: "ORD-AGAIN", amount: "1.6", tokenid: "0x00" }];
  await scan([order], half);
  assert.equal(store.order("ORD-AGAIN").status, "UNDERPAID"); assert.equal(store.order("ORD-AGAIN").paidAmount, "1.6");
  const p = require.resolve("../main/shop"); delete require.cache[p];
  const before = shop; shop = require("../main/shop"); assert.notEqual(shop, before, "a fresh main/shop.js: its seen-coin set is empty");
  await scan([], half);
  const o = store.order("ORD-AGAIN");
  assert.equal(o.paidAmount, "1.6", "the same 1.6 coin did not count again"); assert.equal(o.paid, false); assert.equal(o.status, "UNDERPAID");
});
