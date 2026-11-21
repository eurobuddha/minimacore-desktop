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
    assert.equal(store.recordPayment(ref, "0xC0001", "0.000000001", "0x00"), "DUST", JSON.stringify(total) + ": 1 nano does not pay 2 x 1.5 + 0.2 (CHANGED on purpose, 0.19.200: it is dust, not counted)");
    assert.equal(store.recordPayment(ref, "0xC0002", "3.199999999", "0x00"), "UNDERPAID");
    assert.equal(store.recordPayment(ref, "0xC0001", "0.000000001", "0x00"), "PAID", "3.2 received = 3.2 due (the same coin, judged again: the remainder is never dust)");
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
  assert.deepEqual(store.order(ref).coins, ["0xb1", "0xb3"], "the ids of counted coins are kept on the order, so they survive a restart; a wrong coin is never counted, so never kept");
});
test("recordPayment: a stranger's tiny coin of another token never blocks the honest payment", () => {
  const ref = sellOrder("3.2");
  assert.equal(store.recordPayment(ref, "0xA1", "0.000000001", MXUSD), "WRONG_TOKEN");
  assert.equal(store.recordPayment(ref, "0xA2", "0.000000001", "0x00"), "DUST", "CHANGED on purpose (0.19.200): a right-token coin this small is dust");
  assert.equal(store.recordPayment(ref, "0xA4", "0.1", "0x00"), "UNDERPAID"); assert.equal(store.order(ref).status, "UNDERPAID", "a right-token coin moves WRONG_TOKEN on");
  assert.equal(store.recordPayment(ref, "0xA3", "3.1", "0x00"), "PAID"); assert.equal(store.order(ref).paid, true); assert.equal(store.order(ref).status, "PAID");
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
/** One scan in which the MINIMERCH channel carries `orders` (wire objects from BUYER, or a raw JSON text) and my address the `pays` coins ({ coinid, ref, amount, tokenid }). */
async function scan(orders, pays) {
  shop._setRunner(async (c) => {
    if (c === "getaddress") return { status: true, response: { miniaddress: VENDOR } };
    if (c.startsWith("coins address:" + shop.MINIMERCH)) return { status: true, response: orders.map((w, i) => ({ coinid: "0xM" + (++n) + "_" + i, state: { "99": hex(typeof w === "string" ? w : JSON.stringify(Object.assign({ from: BUYER, date: 1 }, w))) } })) };
    if (c.startsWith("coins address:" + VENDOR)) return { status: true, response: pays.map(p => ({ coinid: p.coinid, tokenid: p.tokenid, amount: p.amount, tokenamount: p.amount, created: p.created, state: { "1": hex(p.ref) } })) };
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
  assert.equal(o.paid, false, "the buyer's 0.000000001 total paid with 1 nano is not paid"); assert.equal(o.status, "PENDING", "CHANGED on purpose (0.19.200): 1 nano is dust, not counted");
  await scan([], [{ coinid: "0xD201", ref: "ORD-PHONE1", amount: "0.000000001", tokenid: "0x00" }, { coinid: "0xD202", ref: "ORD-PHONE1", amount: "3.199999999", tokenid: "0x00" }]);
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

// ---- 0.19.168: what a buyer sends reaches the store only as capped primitives; one bad coin never stops the batch ----
test("vendor: an order nested 12,000 arrays deep is stored as plain lines, the next order in the batch is read, and shop.json is still saved", async () => {
  const deep = "[".repeat(12000) + "]".repeat(12000);
  const evil = JSON.stringify({ type: "ORDER", ref: "ORD-DEEP", from: BUYER, date: 1, shopId: "tea", items: [{ product: "Tea", quantity: "@Q", unitPrice: "1.5", x: "@X" }, "@L"],
    amount: "@A", currency: "Minima", shipping: "Domestic", fromname: "@N", delivery: "x".repeat(5000), message: "@M" }).replace(/"@[QXLANM]"/g, deep);
  const later = { type: "ORDER", ref: "ORD-AFTER", shopId: "tea", items: [{ product: "Tea", quantity: 2, unitPrice: "1.5" }], amount: "3.2", currency: "Minima", shipping: "Domestic" };
  const said = []; store.setLog((m) => said.push(m));
  try { await scan([evil, later], []); } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
  const o = store.order("ORD-DEEP");
  assert.ok(o, "the order is stored"); assert.deepEqual(o.items, [{ product: "Tea", quantity: "", unitPrice: "1.5", lineTotal: "" }, null], "each line rebuilt from its own fields; a nested one is empty");
  assert.equal(o.amount, "0"); assert.equal(o.buyerName, ""); assert.equal(o.note, ""); assert.equal(o.delivery.length, 500); assert.equal(o.status, "UNCHECKED");
  assert.ok(store.order("ORD-AFTER"), "the next order in the same batch is read");
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, "shop.json"), "utf8"));
  assert.ok(disk.orders["ORD-DEEP"] && disk.orders["ORD-AFTER"], "and both are on disk"); assert.deepEqual(said, [], "nothing failed");
  const flat = (v, d) => v === null || typeof v !== "object" || (d < 3 && Object.values(v).every(x => flat(x, d + 1)));
  for (const k of Object.keys(disk.orders)) for (const it of disk.orders[k].items || []) assert.ok(flat(it, 0) && Object.values(it || {}).every(x => x === null || typeof x !== "object"), k + ": a stored line holds primitives only");
});
test("a coin whose message cannot be read is said in the log and the rest of the batch goes on; a store that cannot be saved says so once", async () => {
  const said = []; store.setLog((m) => said.push(m));
  try {
    const realOpen = require("../main/shopcrypto.js").open, sc = require("../main/shopcrypto.js");
    sc.open = async (id, blob) => { if (String(blob).includes(hex("BOOM").slice(2))) throw new Error("bad box"); return realOpen(id, blob); };
    try { await scan(["BOOM", { type: "ORDER", ref: "ORD-NEXT-ONE", shopId: "tea", items: [], amount: "1", currency: "Minima", shipping: "Domestic" }], []); } finally { sc.open = realOpen; }
    assert.ok(store.order("ORD-NEXT-ONE"), JSON.stringify(said)); assert.equal(said.length, 1); assert.match(said[0], /^miniMall: an order channel coin could not be read \(0xM\d+_0\): bad box$/);
    const o = store.order("ORD-NEXT-ONE"); o.self = o;   // a store that cannot be written
    store.flush(); store.flush();
    assert.equal(said.length, 2, "said once while the reason stays the same"); assert.match(said[1], /^miniMall: shop\.json could not be saved: /);
    delete o.self; store.flush(); store.flush(); o.self = o; store.flush(); delete o.self; store.flush();
    assert.equal(said.length, 3, "said again after a good save"); 
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
  assert.ok(/require\("\.\/shop-store"\)\.setLog\(\(m\) => node\.log\("\[app\] " \+ m\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8")), "main.js says it in the Logs view");
});

// ---- 0.19.170: the counted coins of an order are bounded; past the bound the order waits for a check by hand ----
// CHANGED on purpose (0.19.200): only coins that are not dust count toward the bound. A listing-checked order is paid by 100
// coins of 1% long before 500, so the bound is reached by an order that does not match the listing (only the 0.000001 floor).
test("recordPayment: at most MAX_PAY_COINS counted coins per order; more makes it UNCHECKED, never PAID, and the vendor may check it by hand", () => {
  const ref = sellOrder("3.2", "0x00", { shopId: "no-such-shop" }), N = store.MAX_PAY_COINS;
  assert.equal(N, 500);
  for (let i = 0; i < 1000; i++) assert.equal(store.recordPayment(ref, "0xDD" + i, "0.0000009", "0x00"), "DUST", "below 0.000001: never counted, never toward the bound");
  assert.deepEqual(store.order(ref).coins, []);
  for (let i = 0; i < N; i++) assert.equal(store.recordPayment(ref, "0xD" + i, "0.000001", "0x00"), "UNCHECKED");
  for (let i = 0; i < 50; i++) store.recordPayment(ref, "0xE" + i, "1", MXUSD);   // wrong coins: never kept
  assert.equal(store.order(ref).coins.length, N);
  assert.equal(store.recordPayment(ref, "0xF1", "3.2", "0x00"), "UNCHECKED", "the coin past the bound is not counted");
  const o = store.order(ref);
  assert.equal(o.paid, false); assert.equal(o.status, "UNCHECKED"); assert.equal(o.coins.length, N); assert.equal(o.paidAmount, "0.000500");
  assert.match(o.problems.join(), /more than 500 payment coins came for this order; check the payment by hand/);
  const tooMany = () => o.problems.filter(p => /more than 500 payment coins/.test(p));
  assert.equal(store.recordPayment(ref, "0xF2", "3.2", "0x00"), "UNCHECKED"); assert.equal(tooMany().length, 1, "said once");
  assert.equal(store.handCheck(ref), true, "the vendor may check it by hand");
  const I18N = require("../renderer/i18n.js"), MS = require("../renderer/mainsaid.js");
  try { for (const c of ["zh", "ru", "uk"]) { require("../renderer/i18n/" + c + ".js"); I18N.set(c); const s = MS.say(tooMany()[0]); assert.ok(s.includes("500") && !/payment coins/.test(s), c + ": " + s); } } finally { I18N.set("en"); }
});

// ---- 0.19.171: the vendor may set only the order's one legitimate next step ----
test("advanceStatus: only CONFIRMED, then SHIPPED, then DELIVERED, each in turn, and only for a paid (or hand-checked) order", async () => {
  const sent = []; shop._setRunner(async (c) => { if (c === "getaddress") return { status: true, response: { miniaddress: VENDOR } }; if (c.startsWith("send ")) sent.push(c); return { status: true, response: { txpowid: "0xT" } }; });
  await shop.init();
  const unpaid = sellOrder("3.2", "0x00", { counterparty: BUYER });
  for (const s of ["PAID", "CONFIRMED", "SHIPPED", "DELIVERED", "UNDERPAID", "WRONG_TOKEN", "PENDING", "anything", "", null, ["CONFIRMED"]])
    await assert.rejects(shop.advanceStatus(unpaid, s), /That is not this order's next step\./, "unpaid: " + JSON.stringify(s));
  assert.equal(store.order(unpaid).status, "PENDING", "PAID was never set by hand"); assert.deepEqual(sent, [], "and nothing was sent to the buyer");
  const paid = sellOrder("3.2", "0x00", { counterparty: BUYER }); assert.equal(store.recordPayment(paid, "0xP1", "3.2", "0x00"), "PAID");
  for (const s of ["SHIPPED", "DELIVERED", "PAID", "PENDING"]) await assert.rejects(shop.advanceStatus(paid, s), /next step/, "paid, not yet confirmed: " + s);
  for (const s of ["CONFIRMED", "SHIPPED", "DELIVERED"]) { assert.deepEqual(await shop.advanceStatus(paid, s), { ok: true }); assert.equal(store.order(paid).status, s); }
  for (const s of ["DELIVERED", "CONFIRMED", "SHIPPED"]) await assert.rejects(shop.advanceStatus(paid, s), /next step/, "delivered: " + s);
  assert.equal(sent.length, 3, "one STATUS_UPDATE per step");
  const enquiry = sellOrder("0", "0x00", { counterparty: BUYER, status: "INQUIRY" });
  await assert.rejects(shop.advanceStatus(enquiry, "CONFIRMED"), /next step/);
  const I18N = require("../renderer/i18n.js"), MS = require("../renderer/mainsaid.js"); assert.ok(MS.has("That is not this order's next step.", "SHOP_NOT_NEXT"));
});

// ---- 0.19.174 (as released 0.18.163): a payment mined before its order is counted once the order is in ----
test("vendor: a payment that arrives before its order is counted when the order comes, and once", async () => {
  const pay = [{ coinid: "0xEARLY1", ref: "ORD-LATE", amount: "3.2", tokenid: "0x00" }];
  await scan([], pay);
  assert.equal(store.order("ORD-LATE"), null, "no order yet");
  await scan([{ type: "ORDER", ref: "ORD-LATE", shopId: "tea", items: [{ product: "Tea", quantity: 2, unitPrice: "1.5" }], amount: "3.2", currency: "Minima", shipping: "Domestic" }], pay);
  const o = store.order("ORD-LATE"); assert.equal(o.paid, true); assert.equal(o.status, "PAID"); assert.equal(o.paidAmount, "3.2");
  await scan([], pay); assert.equal(store.order("ORD-LATE").paidAmount, "3.2", "and only once");
});

// ---- 0.19.199 (released 0.18.183): ids a peer writes read own entries only; a stored null line is not drawn ----
test("'__proto__' as a shop id, an order ref or a chat id finds nothing and writes nothing into the prototype", async () => {
  const base = { type: "ORDER", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" };
  await scan([Object.assign({}, base, { ref: "ORD-PROTO1", shopId: "__proto__" }), Object.assign({}, base, { ref: "__proto__", shopId: "tea" }), Object.assign({}, base, { ref: "ORD-PROTO3", shopId: "constructor" })],
    [{ coinid: "0xF1F1", ref: "__proto__", amount: "10", tokenid: "0x00" }]);
  assert.equal(store.shop("__proto__"), null); assert.equal(store.shop("toString"), null); assert.equal(store.shop("constructor"), null);
  assert.equal(store.order("__proto__"), null); assert.equal(store.order("hasOwnProperty"), null);
  const p1 = store.order("ORD-PROTO1"), p3 = store.order("ORD-PROTO3");
  assert.ok(!p1 || p1.problems.length, "an order for a shop named __proto__ is never checked against Object.prototype"); assert.ok(!p3 || p3.problems.length, "nor constructor");
  assert.equal(store.recordPayment("__proto__", "0xF1F2", "10", "0x00"), null);
  assert.equal(store.upsertOrder({ ref: "__proto__", role: "sell" }), false); assert.equal(store.upsertOrder({ ref: 7, role: "sell" }), false);
  assert.equal(store.addChat({ randomid: "__proto__", ref: "x" }), false);
  assert.throws(() => store.saveShop({ shopId: "__proto__" }), /Invalid shop id/);
  assert.equal({}.coins, undefined); assert.equal({}.paidAmount, undefined); assert.equal({}.status, undefined, "Object.prototype untouched");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"), line = app.match(/function shopItems\(o\) \{[^\n]*\}/)[0];
  const shopItems = new Function("esc", "th", line + "; return shopItems;")((s) => String(s), (s) => s);
  assert.ok(shopItems({ items: [null, { product: "Tea", quantity: 2, lineTotal: "3" }, undefined] }).includes("Tea"), "a stored null line is not drawn, and does not stop the rest");
});

// ---- 0.19.200 (released 0.18.181 / 0.18.185): dust is not counted, not kept, not saved, and judged again; payments read oldest first ----
test("dust (below 0.000001, or below the smaller of 1% of what is due and what is still due) is not counted and never blocks a real payment", () => {
  const ref = sellOrder("3.2"); let k = 0; const id = () => "0xD057" + (++k).toString(16);
  for (let i = 0; i < 1100; i++) assert.equal(store.recordPayment(ref, id(), i % 2 ? "0.0000001" : "0.0001", "0x00"), "DUST");
  assert.deepEqual(store.order(ref).coins, [], "no dust in the order's list"); assert.equal(store.order(ref).paidAmount || "0", "0", "and none counted");
  assert.equal(store.recordPayment(ref, id(), "0.032", "0x00"), "UNDERPAID", "1% of 3.2 is not dust");
  assert.equal(store.recordPayment(ref, id(), "3.15", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(ref, id(), "0.018", "0x00"), "PAID", "a top-up of what is still due is never dust, however small");
  assert.equal(store.order(ref).coins.length, 3);
  const u = sellOrder("1", "0x00", { shopId: "no-such-shop" });
  assert.equal(store.recordPayment(u, id(), "0.0000009", "0x00"), "DUST", "an order with nothing due by the listing: the 0.000001 floor");
  assert.equal(store.recordPayment(u, id(), "0.000001", "0x00"), "UNCHECKED");
  // a dust coin costs no disk write
  const real = fs.writeFileSync; let writes = 0; fs.writeFileSync = function () { writes++; return real.apply(this, arguments); };
  try { const r2 = sellOrder("3.2"); writes = 0; for (let i = 0; i < 2000; i++) store.recordPayment(r2, id(), "0.0000001", "0x00"); assert.equal(writes, 0, "no save for a dust coin"); }
  finally { fs.writeFileSync = real; }
});
test("a 9.95 payment and a 0.05 top-up pay a 10 order, in either order and in one scan or two", async () => {
  store.saveShop({ shopId: "topup", shopName: "T", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  const ord = (ref) => ({ type: "ORDER", ref, shopId: "topup", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" });
  for (const [ref, cs, what] of [["ORD-TU1", [["0x11", "0.05", 101], ["0x12", "9.95", 100]], "newest first, different blocks"],
    ["ORD-TU2", [["0x22", "9.95", 100], ["0x21", "0.05", 101]], "oldest first"], ["ORD-TU3", [["0x31", "0.05", 100], ["0x32", "9.95", 100]], "the same block, the top-up listed first"]]) {
    await scan([ord(ref)], cs.map(([coinid, amount, created]) => ({ coinid, ref, amount, tokenid: "0x00", created })));
    assert.equal(store.order(ref).paid, true, what); assert.equal(store.order(ref).paidAmount, "10.00", what);
  }
  await scan([ord("ORD-TU4")], [{ coinid: "0x41", ref: "ORD-TU4", amount: "0.05", tokenid: "0x00", created: 105 }]);   // the top-up first, alone: dust then
  assert.equal(store.order("ORD-TU4").paid, false);
  await scan([], [{ coinid: "0x41", ref: "ORD-TU4", amount: "0.05", tokenid: "0x00", created: 105 }, { coinid: "0x42", ref: "ORD-TU4", amount: "9.95", tokenid: "0x00", created: 106 }]);
  assert.equal(store.order("ORD-TU4").paid, true, "two scans: the top-up is judged again once the 9.95 is in");
});
