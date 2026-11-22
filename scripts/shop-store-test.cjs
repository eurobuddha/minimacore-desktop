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
    // CHANGED on purpose (0.19.248, as released 0.18.190): the dust gathered before is counted with the coin that leaves only it due
    assert.equal(store.recordPayment(ref, "0xC0002", "3.199999999", "0x00"), "PAID", "3.199999999 + the gathered 0.000000001 = 3.2 due");
    assert.equal(store.recordPayment(ref, "0xC0001", "0.000000001", "0x00"), "ALREADY", "and the dust coin is not counted again");
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
    && /const yes = await showConfirm\(t\("Checked by hand\?"\)[\s\S]{0,1800}if \(!yes\) return;\s*try \{ await api\.shopVendorCheck\(ref\);/.test(app), "the screen says so and asks before it");
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
// changed on purpose (0.19.344): the stand-in answers `block` (5000): a payment is judged only once the chain is more than PAY_BEFORE_ORDER
// blocks past it, and with no tip nothing is judged
async function scan(orders, pays) {
  shop._setRunner(async (c) => {
    if (c === "block") return { status: true, response: { block: "5000" } };
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
  // CHANGED on purpose (0.19.272): at most 256 dust coins are gathered (was 1000, past the order's 500-coin bound, so they never
  // counted); the 256 largest (0.0001 each, 0.0256) cover the 0.018 the 3.15 leaves, so the order is paid then
  assert.equal(store.recordPayment(ref, id(), "3.15", "0x00"), "PAID", "3.182 + the gathered 0.0256");
  assert.equal(store.order(ref).coins.length, 2 + store.PENDING_MAX);
  const t2 = sellOrder("3.2");
  assert.equal(store.recordPayment(t2, id(), "3.182", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(t2, id(), "0.018", "0x00"), "PAID", "a top-up of what is still due is never dust, however small");
  assert.equal(store.order(t2).coins.length, 2);
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

// ---- 0.19.232: the stored vendor address is kept; every shop's own payout address is read; a scan cursor survives a quit ----
test("vendor: the stored address is kept (getaddress only the first time), a shop's own payout address is scanned, and the gap since the last scan is read", async () => {
  const OTHER = "MxG0OTHERPAYOUT0000000000000000000000000000000000000000000000001", NEWADDR = "MxG0NEWGETADDRESS00000000000000000000000000000000000000000000002";
  store.saveShop({ shopId: "two", shopName: "Two", currency: "Minima", tokenid: "0x00", vendorAddress: OTHER, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  delete require.cache[require.resolve("../main/shop")]; shop = require("../main/shop");   // a fresh launch of the module, the same store
  let tip = 5000; const asked = [], notified = [];
  shop._setRunner(async (c) => {
    asked.push(c);
    if (c === "getaddress") return { status: true, response: { miniaddress: NEWADDR } };
    if (c === "block") return { status: true, response: { block: String(tip) } };
    if (c === "status") return { status: true, response: { chain: { length: 100000 } } };   // a block tree deeper than any read here (0.19.330)
    if (c.startsWith("coinnotify")) { notified.push(c); return { status: true }; }
    if (c.startsWith("coins address:" + shop.MINIMERCH)) return { status: true, response: [{ coinid: "0xM2W1", state: { "99": hex(JSON.stringify({ type: "ORDER", ref: "ORD-TWO1", from: BUYER, date: 1, shopId: "two", items: [{ product: "Cup", quantity: 1, unitPrice: "4" }], amount: "4", currency: "Minima", shipping: "" })) } }] };
    if (c.startsWith("coins address:" + OTHER)) return { status: true, response: [{ coinid: "0xP2W1", tokenid: "0x00", amount: "4", created: 4990, state: { "1": hex("ORD-TWO1") } }] };
    return { status: true, response: [] };
  });
  await shop.init();
  assert.equal(shop.myIdentity().vendorAddress, VENDOR, "the stored address, not a new getaddress");
  assert.ok(!asked.includes("getaddress"), "getaddress is not asked when one is stored");
  assert.ok(notified.some(c => c.endsWith(OTHER)), "the shop's own payout address is watched");
  await shop.scanOnce();
  assert.equal(store.order("ORD-TWO1").paid, true, "paid at the shop's own payout address");
  assert.equal(store.getMeta("scanned_tip_block"), 5000, "the cursor is saved");
  tip = 6500; asked.length = 0; await shop.scanOnce();
  assert.ok(asked.some(c => / depth:1024$/.test(c)), "the gap since the last scan (1500 blocks) is read up to one window, 1024 (0.19.338, changed on purpose: 1516 under the 4096 window): " + asked.filter(c => c.startsWith("coins")).join(" | "));
});

// ---- 0.19.241 (as released 0.18.208 / 0.18.218): the same reference from two buyers ----
test("two buyers' orders with the same reference are both kept, both Unchecked, and a payment with that reference pays neither", async () => {
  const B2 = "0x" + "33".repeat(32), sc = require.cache[require.resolve("../main/shopcrypto.js")].exports, open0 = sc.open;
  store.saveShop({ shopId: "dup", shopName: "D", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  const ord = (from) => JSON.stringify({ type: "ORDER", ref: "ORD-DUP", from, date: 1, shopId: "dup", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" });
  try {
    await scan([ord(BUYER)], []);
    assert.equal(store.order("ORD-DUP").status, "PENDING");
    sc.open = async (_id, blob) => { const t = Buffer.from(String(blob).slice(2), "hex"); return { valid: true, fromPublicId: JSON.parse(t).from, plaintext: t }; };   // the sender is whoever the message says (sealed, in life)
    await scan([ord(BUYER), ord(B2)], []);
    const first = store.order("ORD-DUP"), second = store.order("ORD-DUP~" + B2);
    assert.ok(second, "the second buyer's order is kept under the reference and the buyer's whole id"); assert.equal(second.counterparty, B2); assert.equal(second.wireRef, "ORD-DUP");
    for (const o of [first, second]) { assert.equal(o.status, "UNCHECKED"); assert.match(o.problems[0], /another buyer sent an order with the same reference ORD-DUP: /); assert.equal(o.due, ""); }
    await scan([ord(B2)], []); assert.equal(store.orders().filter(o => o.shopId === "dup").length, 2, "the second copy again is not a third order");
    await scan([], [{ coinid: "0xDA01", ref: "ORD-DUP", amount: "10", tokenid: "0x00", created: 9 }]);
    assert.equal(store.order("ORD-DUP").paid, false, "a payment with the shared reference pays neither"); assert.equal(store.order("ORD-DUP~" + B2).paid, false);
    const d = shop.orderDetail("ORD-DUP~" + B2); assert.deepEqual(d.sharedRef, { ref: "ORD-DUP", received: "10" }, "the copy says where its reference's payments are counted");
    assert.equal(store.handCheck("ORD-DUP~" + B2), true, "either can be checked by hand"); assert.equal(store.handCheck("ORD-DUP"), true);
    // what the vendor sends back to the second buyer carries the wire reference; the buyer's reply lands on their own copy
    const sent = []; shop._setRunner(async (c) => { sent.push(c); return { status: true, response: { txpowid: "0x1" } }; });
    const seal0 = sc.seal; let sealed = null; sc.seal = async (_me, _to, wire) => { sealed = JSON.parse(Buffer.from(wire).toString("utf8")); return "ab"; };
    try { await shop.reply("ORD-DUP~" + B2, "hello"); } finally { sc.seal = seal0; }
    assert.equal(sealed.ref, "ORD-DUP"); assert.equal(sealed.to, B2);
    await scan([JSON.stringify({ type: "BUYER_REPLY", ref: "ORD-DUP", from: B2, randomid: "rr1", message: "hi back", date: 2 })], []);
    assert.ok(store.chat("ORD-DUP~" + B2).some(m => m.message === "hi back")); assert.ok(!store.chat("ORD-DUP").some(m => m.message === "hi back"));
  } finally { sc.open = open0; }
  // changed on purpose (0.19.344, as released 0.18.289): an order marked PAID when the copy comes is held again (its payment may be the other
  // buyer's); one the vendor confirmed is left as it was
  store.saveShop({ shopId: "dup2", shopName: "D2", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  await scan([{ type: "ORDER", ref: "ORD-DUP2", shopId: "dup2", items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], amount: "10", currency: "Minima", shipping: "" }], [{ coinid: "0xDB01", ref: "ORD-DUP2", amount: "10", tokenid: "0x00", created: 9 }]);
  assert.equal(store.order("ORD-DUP2").paid, true);
  assert.equal(store.flagDuplicate("ORD-DUP2", "x"), true); assert.equal(store.order("ORD-DUP2").status, "UNCHECKED"); assert.equal(store.order("ORD-DUP2").paid, false); assert.equal(store.order("ORD-DUP2").paidAmount, "10");
  store.setStatus("ORD-DUP2", "CONFIRMED"); assert.equal(store.flagDuplicate("ORD-DUP2", "y"), false); assert.equal(store.order("ORD-DUP2").status, "CONFIRMED");
});

// ---- 0.19.248 (as released 0.18.190): an order's dust coins are counted together once their sum covers what is still due ----
test("dust coins count together once they cover what is still due: 9.9 + 0.05 + 0.05 pays 10, in any order; dust that never covers it writes nothing", () => {
  store.saveShop({ shopId: "dust10", shopName: "D", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "10", maxUnits: "5" }], shipping: [] });
  const ord = (ref) => { store.upsertOrder({ ref, role: "sell", shopId: "dust10", amount: "10", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" }); return ref; };
  let r = ord("ORD-DU1");
  assert.equal(store.recordPayment(r, "0xd101", "9.9", "0x00"), "UNDERPAID");
  assert.equal(store.recordPayment(r, "0xd102", "0.05", "0x00"), "DUST", "0.05 of 0.1 left is below 1% of 10");
  assert.equal(store.recordPayment(r, "0xd103", "0.05", "0x00"), "PAID", "together they cover the 0.1 left");
  assert.equal(store.order(r).paidAmount.replace(/0+$/, ""), "10."); assert.deepEqual(store.order(r).coins, ["0xd101", "0xd102", "0xd103"]);
  r = ord("ORD-DU2");
  assert.equal(store.recordPayment(r, "0xd201", "0.05", "0x00"), "DUST"); assert.equal(store.recordPayment(r, "0xd202", "0.05", "0x00"), "DUST");
  assert.equal(store.recordPayment(r, "0xd203", "9.9", "0x00"), "PAID", "the dust first, the payment after");
  r = ord("ORD-DU3");
  assert.equal(store.recordPayment(r, "0xd301", "9.9", "0x00"), "UNDERPAID");
  const real = fs.writeFileSync; let writes = 0; fs.writeFileSync = function () { writes++; return real.apply(this, arguments); };
  try { for (let i = 0; i < 50; i++) assert.equal(store.recordPayment(r, "0xd3" + (1000 + i), "0.001", "0x00"), "DUST"); } finally { fs.writeFileSync = real; }
  assert.equal(writes, 0, "dust that does not cover what is due writes nothing"); assert.equal(store.order(r).paid, false);
  assert.equal(store.recordPayment(r, "0xd3999", "0.05", "0x00"), "PAID", "0.05 + 0.05 of the gathered dust cover the 0.1 left");
  assert.ok(store.order(r).coins.length >= 3 && store.order(r).coins.length <= 52);
});

// ---- 0.19.249 (as released 0.18.213, this branch's one-pass scan): a failed read advances nothing, and the Inbox says what was not read ----
test("vendor: a payout address the node does not answer for leaves the scan cursor where it was; a long absence is said on the Inbox", async () => {
  // changed on purpose (0.19.346): a valid payout address (0x, 64 digits). A read that throws for an address whose checksum is wrong is now that
  // address's skip, as released (each read caught per address), so the old made-up Mx no longer holds the cursor
  const OTHER2 = "0x" + "99".repeat(32);
  store.saveShop({ shopId: "fail2", shopName: "F", currency: "Minima", tokenid: "0x00", vendorAddress: OTHER2, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  let tip = 9000, down = true; const before = Number(store.getMeta("scanned_tip_block")) || 0;
  shop._setRunner(async (c) => {
    if (c === "block") return { status: true, response: { block: String(tip) } };
    if (c === "status") return { status: true, response: { chain: { length: 100000 } } };   // a block tree deeper than any read here (0.19.330)
    if (c.startsWith("coins address:" + OTHER2)) { if (down) throw new Error("timed out"); return { status: true, response: [] }; }
    return { status: true, response: [] };
  });
  await shop.init(); await shop.scanOnce();
  assert.equal(Number(store.getMeta("scanned_tip_block")) || 0, before, "one address unread: the cursor does not move");
  assert.equal(shop.scanState().readFailed, true);
  down = false; await shop.scanOnce();
  assert.equal(store.getMeta("scanned_tip_block"), 9000); assert.equal(shop.scanState().readFailed, false);
  // changed on purpose (0.19.338, the released tree's tree model): an absence longer than the node's tree is said from the floor, with its cause
  tip = 20000; await shop.scanOnce();
  { const st = shop.scanState(); assert.deepEqual([st.catchingUpTo, st.unreadBelow, st.unreadWhy], [0, 20000 - 1024, "treeRoot"], "away longer than the tree: said from the floor"); }
  assert.equal(store.getMeta("scanned_tip_block"), 20000);
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes("scan = await api.shopScanState().catch(() => null)") && app.includes('tr("Reading orders and payments from while the app was closed (back to block {block}).", { block: esc(String(scan.catchingUpTo)) })')
    && app.includes('scan && scan.unreadShown ? tr(UNREAD_SAID[scan.unreadWhy] || UNREAD_SAID.tree, { block: esc(String(scan.unreadBelow)) })'));   // changed on purpose (0.19.346): no cause stored is the tree's sentence, as released   // said only where a shop exists and until dismissed (0.19.341), by its cause
});

// ---- 0.19.273 / 0.19.284: a payout address that can never be valid (its checksum) is skipped for a while, said whole on the Inbox;
// a node error about a valid one is never read as "invalid"; the save checks the checksum ----
test("vendor: a payout address with a wrong checksum is skipped for five minutes, logged and said whole; a node error about a valid one only holds the cursor; the save checks it", async () => {
  const GOOD = require("../main/keyuses.js").addressOf("0x3A985DA74FE225B2045C172D6BD390BD855F086E3E9D525B46BFE24511431532").mx;
  const BAD = GOOD.slice(0, -3) + (GOOD.slice(-3, -2) === "A" ? "B" : "A") + GOOD.slice(-2);
  store.saveShop({ shopId: "bad3", shopName: "B", currency: "Minima", tokenid: "0x00", vendorAddress: BAD, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  store.saveShop({ shopId: "good3", shopName: "G", currency: "Minima", tokenid: "0x00", vendorAddress: GOOD, products: [{ id: "p1", name: "Cup", price: "4", maxUnits: "5" }], shipping: [] });
  let tip = 30000, goodFails = true; const said = [], asked = [];
  shop._setRunner(async (c) => {
    if (c === "block") return { status: true, response: { block: String(tip) } };
    if (c === "status") return { status: true, response: { chain: { length: 100000 } } };   // a block tree deeper than any read here (0.19.330)
    if (c.startsWith("coins address:" + BAD)) { asked.push(c); return { status: false, error: "Invalid MxAddress - checksum wrong" }; }
    if (c.startsWith("coins address:" + GOOD)) return goodFails ? { status: false, error: "SQL Exception: the wallet database is closed" } : { status: true, response: [] };
    if (c.startsWith("checkaddress")) return { status: false, error: "SQL Exception: the wallet database is closed" };   // a restore under way: never read as "invalid"
    return { status: true, response: [] };
  });
  store.setLog((m) => said.push(m));
  const now0 = Date.now, at = (ms) => { Date.now = () => now0() + ms; };
  try {
    await shop.init(); await shop.scanOnce();
    assert.equal(shop.scanState().readFailed, true, "the valid address's coins could not be read: the cursor stays");
    assert.deepEqual(shop.scanState().skipped, [BAD], "only the one with a wrong checksum is skipped, named whole");
    assert.ok(said.some(l => l.includes("payout address " + BAD + " is not a valid Minima address")), said.join(" | "));
    goodFails = false; tip = 30001; asked.length = 0; await shop.scanOnce();
    assert.equal(shop.scanState().readFailed, false); assert.equal(store.getMeta("scanned_tip_block"), 30001); assert.deepEqual(asked, [], "a skipped address is not asked again");
    tip = 30002; await shop.scanOnce(); assert.equal(shop.scanState().readFailed, false, "a later pass reads everything since the one before");   // changed on purpose (0.19.338): the tree's notice is kept (0.19.331), so no clearing is asserted
    at(5 * 60000 + 1000); assert.deepEqual(shop.scanState().skipped, [], "the skip runs out"); tip = 30003; await shop.scanOnce(); assert.ok(asked.length > 0, "and the address is looked at again");
    Date.now = now0;
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.ok(app.includes("(scan && scan.skipped || []).map(a => tr(\"Payments to {address} are not read: it is not a valid Minima address.") && app.includes("{ address: esc(a) }"), "the Inbox says it, the address whole");
    // the Studio's save: the checksum decides, the node is not asked
    await assert.rejects(shop.saveShop({ shopId: "bad4", shopName: "C", vendorAddress: BAD, products: [] }), new RegExp("payout address " + BAD + " is not a valid Minima address\\. Nothing was saved"));
    assert.equal(store.shop("bad4"), null);
    await shop.saveShop({ shopId: "ok6", shopName: "E", vendorAddress: GOOD, products: [] }); assert.ok(store.shop("ok6"), "a valid address saves while the node errors");
    await shop.saveShop(Object.assign({}, store.shop("bad3"), { shopName: "B2" })); assert.equal(store.shop("bad3").shopName, "B2", "an unchanged address is not checked again");
  } finally { Date.now = now0; store.setLog((m) => { throw new Error("no log expected: " + m); }); for (const id of ["bad3", "good3", "ok6"]) store.deleteShop(id); }
});

// ---- 0.19.272: gathered dust is bounded with a running exact sum; past the bound a coin not larger than the smallest kept is not kept ----
test("dust past the bound: an order keeps PENDING_MAX coins, the smallest is replaced only by a larger one, the sum stays exact, and it still pays (also after a restart)", () => {
  const ord = (ref) => { store.upsertOrder({ ref, role: "sell", shopId: "dust10", amount: "10", currency: "Minima", tokenid: "0x00", status: "PENDING", paid: false, items: [{ product: "Tea", quantity: 1, unitPrice: "10" }], shipping: "" }); return ref; };
  const r = ord("ORD-DU9"), MAX = store.PENDING_MAX;
  assert.ok(MAX <= 256, "a lower bound than 1000");
  assert.equal(store.recordPayment(r, "0xe0", "9.9", "0x00"), "UNDERPAID");
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) assert.equal(store.recordPayment(r, "0xe1" + i, "0.00001", "0x00"), "DUST");
  for (let k = 0; k < 2; k++) for (let i = 0; i < 3000; i++) store.recordPayment(r, "0xe1" + i, "0.00001", "0x00");   // the same flood seen on two more scans
  assert.ok(Date.now() - t0 < 3000, "9000 looks at dust in " + (Date.now() - t0) + " ms (each was a sort of the whole map)");
  assert.deepEqual(store._pendingDust(r), { size: MAX, sum: M.decAdd("0", (MAX * 0.00001).toFixed(5)), min: "0.00001" }, "kept: the bound, summed exactly");
  assert.equal(store.recordPayment(r, "0xe2", "0.0001", "0x00"), "DUST");
  assert.equal(M.decCmp(store._pendingDust(r).sum, "0.00265"), 0, "a larger coin takes the smallest one's place: 0.00256 - 0.00001 + 0.0001");
  assert.equal(store._pendingDust(r).size, MAX);
  assert.equal(store.recordPayment(r, "0xe3", "0.05", "0x00"), "DUST");
  assert.equal(store.recordPayment(r, "0xe4", "0.05", "0x00"), "PAID", "each 0.05 took a smallest one's place: 0.00263 + 0.05 + 0.05 covers the 0.1 left");
  assert.equal(M.decCmp(store.order(r).paidAmount, "10.00263"), 0, "counted exactly: " + store.order(r).paidAmount);
  assert.equal(new Set(store.order(r).coins).size, store.order(r).coins.length, "each coin once"); assert.equal(store._pendingDust(r), null);
  // after a restart (nothing in memory) the scanner shows the same coins again, in any order: 9.9 + 0.05 + 0.05 pays 10
  const r2 = ord("ORD-DU10"); assert.equal(store.recordPayment(r2, "0xf1", "0.05", "0x00"), "DUST");
  const key = require.resolve("../main/shop-store"), kept = require.cache[key]; store.flush();
  delete require.cache[key]; const fresh = require("../main/shop-store");
  assert.equal(fresh._pendingDust(r2), null, "a restart forgets the gathered dust");
  assert.equal(fresh.recordPayment(r2, "0xf2", "0.05", "0x00"), "DUST"); assert.equal(fresh.recordPayment(r2, "0xf1", "0.05", "0x00"), "DUST");
  try { assert.equal(fresh.recordPayment(r2, "0xf3", "9.9", "0x00"), "PAID"); assert.equal(M.decCmp(fresh.order(r2).paidAmount, "10"), 0); }
  finally { fresh.flush(); require.cache[key] = kept; }
});

// ---- 0.19.332: a failed backfill step is said as OLDER orders; a tip not above the floor puts the step off; the cursor never goes down ----
test("vendor: a failed backfill step is not 'recent orders could not be read'; a tip below the backfill floor postpones it without a failure; the cursor follows a lower tip (0.19.336)", async () => {
  let tip = 500000, failDeep = false; const asked = []; store.setLog(() => {});
  let cut = 0;   // changed on purpose (0.19.338): the window is cut by the reply cap so that a step (not the tree read) follows, and the step fails
  shop._setRunner(async (c) => { if (c === "block") return { status: true, response: { block: String(tip) } };
    const m = / depth:(\d+)$/.exec(c); if (m) { asked.push(Number(m[1])); if (/MINIMERCH|0x4D494E494D45524348/.test(c) && cut > 0 && Number(m[1]) > 300) { cut--; return { status: true, response: { tooBig: true } }; } if (failDeep && /MINIMERCH|0x4D494E494D45524348/.test(c) && Number(m[1]) > 300) throw new Error("timed out"); } return { status: true, response: [] }; });
  store.setMeta("scanned_tip_block", 490000); store.setMeta("backfill_target_block", 0); store.setMeta("backfill_floor_block", 0); store.setMeta("unread_below_block", 0);
  cut = 2; failDeep = true; await shop.init(); await shop.scanOnce();
  { const st = shop.scanState(); assert.deepEqual([st.readFailed, st.stepFailed, st.catchingUpTo], [false, true, 490000], "the recent window was read; the step was not"); }
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes(': scan && scan.stepFailed ? th("Older orders could not be read yet: the node did not answer. They are read again on the next block.")'));
  failDeep = false; const floor = Number(store.getMeta("backfill_floor_block"));
  // a node resynced to a tip below the floor: the step waits, no failure, nothing asked past the window, the cursor stays
  tip = floor - 5000; asked.length = 0; await shop.scanOnce();
  { const st = shop.scanState(); assert.deepEqual([st.readFailed, st.stepFailed, st.catchingUpTo], [false, false, 490000], "put off, not failed"); }
  assert.ok(asked.every(d => d <= 64), "no step was read: " + asked.join(","));
  assert.equal(store.getMeta("scanned_tip_block"), floor - 5000, "the cursor follows the chain down (0.19.336, changed on purpose: 0.19.332 kept it up)");
  tip = 500001; await shop.scanOnce(); assert.equal(shop.scanState().stepFailed, false);
  store.setLog((m) => { throw new Error("no log expected: " + m); });
});

// ---- 0.19.334: a backfill step skips what an earlier pass read (the floor filter): a coin created above the floor is not opened again ----
test("vendor: a backfill step after a restart does not open again an order coin created above its floor (read by an earlier pass)", async () => {
  delete require.cache[require.resolve("../main/shop")]; shop = require("../main/shop");   // a fresh launch: nothing remembered in memory
  const sc = require.cache[require.resolve("../main/shopcrypto.js")].exports, open0 = sc.open, opened = [];
  sc.open = async (id, blob) => { opened.push(blob); return open0(id, blob); };
  const tip = 600000; store.setLog(() => {});
  const coin = (ref, created) => ({ coinid: "0xFL" + ref, created, state: { "99": hex(JSON.stringify({ type: "INQUIRY", ref, from: BUYER, date: 1, shopId: "tea", message: "x" })) } });
  const coins = [coin("ABOVE", tip - 500), coin("BELOW", tip - 1010)];   // changed on purpose (0.19.338): a step reads at most 1024 blocks
  shop._setRunner(async (c) => { if (c === "block") return { status: true, response: { block: String(tip) } };
    if (c === "getaddress") return { status: true, response: { miniaddress: VENDOR } };
    const m = / depth:(\d+)$/.exec(c); return { status: true, response: m && c.startsWith("coins address:" + shop.MINIMERCH) ? coins.filter(x => x.created > tip - Number(m[1])) : [] }; });
  store.setMeta("scanned_tip_block", tip); store.setMeta("backfill_target_block", tip - 4000); store.setMeta("backfill_floor_block", tip - 1000); store.setMeta("unread_below_block", 0);
  try {
    await shop.init(); await shop.scanOnce();
    const which = opened.map(b => JSON.parse(Buffer.from(String(b).slice(2), "hex")).ref);
    assert.ok(which.includes("BELOW"), "below the floor: read by the step"); assert.ok(!which.includes("ABOVE"), "above the floor: an earlier pass read it, the step skips it: " + which);
  } finally { sc.open = open0; store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});

// ---- a stand-in node shaped as core/minima-core e64600285be (as the 0.18 tree's javaNode): the tree grows by one block a block, is cut at
// 1124 back to 1024, a coins walk visits blocks tip..tip-min(depth, L-1), a spent coin or one above the tip is never returned, the root
// carries this wallet's unspent coins of any age (relevant:true), the channel's coins only inside the tree; coins of another branch unseen ----
function javaNode(st) {
  return async (c) => {
    if (c === "block") return { status: true, response: { block: String(st.tip) } };
    if (c === "getaddress") return { status: true, response: { miniaddress: VENDOR } };
    if (c === "status") return { status: true, response: { chain: { length: Math.min(st.L, st.tip) } } };
    const m = / depth:(\d+)$/.exec(c); if (!m || !c.startsWith("coins ")) return { status: true, response: [] };
    const d = Number(m[1]), L = Math.min(st.L, st.tip), low = st.tip - Math.min(d, L - 1), rootBlock = st.tip - (L - 1);
    const live = (x) => x.created <= st.tip && !x.spent && (!x.chain || x.chain === st.chain);
    if (c.startsWith("coins address:" + shop.MINIMERCH)) { if (st.hook) { const r = st.hook("M", d); if (r === "throw") throw new Error("RPC timed out"); if (r) return r; } return { status: true, response: st.msg.filter(x => live(x) && x.created >= low) }; }
    if (c.startsWith("coins address:" + VENDOR)) { if (st.hook) { const r = st.hook("V", d); if (r === "throw") throw new Error("RPC timed out"); if (r) return r; }
      return { status: true, response: st.pay.filter(x => live(x) && (x.created >= low || (/ relevant:true/.test(c) && d >= L - 1 && x.created < rootBlock))).map(x => Object.assign({}, x, { created: String(x.created) })) }; }
    return { status: true, response: [] };
  };
}
const jOrder = (ref, created, extra) => Object.assign({ coinid: "0xJO" + Buffer.from(ref).toString("hex"), created, state: { "99": hex(JSON.stringify({ type: "ORDER", ref, from: BUYER, date: 1, shopId: "tea", items: [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], amount: "1.5", currency: "Minima", shipping: "Digital" })) } }, extra || {});
const jPay = (ref, created, extra) => Object.assign({ coinid: "0xJP" + Buffer.from(ref + ":" + created).toString("hex"), tokenid: "0x00", amount: "1.5", created, state: { "1": hex(ref) } }, extra || {});
async function javaSetup(tip, L) {
  delete require.cache[require.resolve("../main/shop")]; shop = require("../main/shop");
  for (const k of ["scanned_tip_block", "backfill_target_block", "backfill_floor_block", "unread_below_block", "unread_why", "backfill_stall", "unread_dismissed"]) store.setMeta(k, 0);
  const st = { tip, L: L || 1100, chain: "a", msg: [], pay: [], hook: null };
  shop._setRunner(javaNode(st)); await shop.init(); store.setLog(() => {});
  return st;
}
const jTip = (st, t) => { for (let b = st.tip + 1; b <= t; b++) { st.L++; if (st.L >= 1124) st.L = 1024; } st.tip = t; };

// ---- 0.19.336 (as released 0.18.281): a reorganisation onto a lower branch, then a catch-up faster than the poll: the new branch is read ----
test("vendor: after a reorganisation onto a lower branch and a fast catch-up, the new branch's orders and payments below the old cursor are read", async () => {
  const st = await javaSetup(1000);
  try {
    await shop.scanOnce(); jTip(st, 1500); await shop.scanOnce(); assert.equal(store.getMeta("scanned_tip_block"), 1500);
    st.chain = "b"; st.tip = 1100;
    st.msg.push(jOrder("ORD-RB1", 1110, { chain: "b" }), jOrder("ORD-RB2", 1215, { chain: "b" }), jOrder("ORD-RB3", 1320, { chain: "b" })); st.pay.push(jPay("ORD-RB1", 1112, { chain: "b" }));
    for (const tip of [1100, 1200, 1300, 1400, 1500, 1501]) { jTip(st, tip); await shop.scanOnce(); assert.equal(shop.scanState().readFailed, false, "no failure at " + tip); }
    for (const r of ["ORD-RB1", "ORD-RB2", "ORD-RB3"]) assert.ok(store.order(r), r + " on the new branch is read");
    assert.equal(store.order("ORD-RB1").paid, true, "and its payment counted"); assert.equal(store.getMeta("scanned_tip_block"), 1501);
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});

// ---- 0.19.337 (as released 0.18.282): a payment read before its order (order below a window or step boundary) pays it once the order is read ----
test("vendor: a payment above a cut window's boundary, read before its order below it, pays the order when a step reads the order; judged once", async () => {
  const st = await javaSetup(3000);
  try {
    store.setMeta("scanned_tip_block", 2500);   // away for 500 blocks
    st.msg.push(jOrder("ORD-ST1", 2700)); st.pay.push(jPay("ORD-ST1", 2800));   // the order below what the cut window reads, the payment above it
    let cut = 1; st.hook = (addr, d) => addr === "M" && d > 300 && cut-- > 0 ? { status: true, response: { tooBig: true } } : null;   // the window's first channel answer cut
    await shop.scanOnce(); jTip(st, 3001); await shop.scanOnce(); jTip(st, 3002); await shop.scanOnce();
    assert.ok(store.order("ORD-ST1"), "the step read the order"); assert.equal(store.order("ORD-ST1").paid, true, "and the payment read before it pays it");
    assert.equal(store.order("ORD-ST1").coins.length, 1, "counted once");
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});

// ---- 0.19.338 (as released 0.18.277 / 0.18.283 / 0.18.286; these replace the 0.19.328, 0.19.330 and 0.19.331 tests, written for a tree read
// from status or for a node deeper than any node keeps: changed on purpose) ----
const CAPPED = { status: true, response: { tooBig: true } };
test("vendor: an order sent while the app was closed is read through the backfill after the first window was cut by the reply cap; a node whose reply is cut at every pass ends the backfill with that cause", async () => {
  const st = await javaSetup(1000); const logs = []; store.setLog((m) => logs.push(m));
  try {
    await shop.scanOnce(); st.msg.push(jOrder("ORD-GAP", 1100)); jTip(st, 1800);
    let first = true; st.hook = (addr, d) => { if (addr === "M" && first) { first = false; if (d > 404) return CAPPED; } return null; };
    await shop.scanOnce();
    assert.ok(store.order("ORD-GAP"), "read by the backfill step in the same pass"); assert.equal(Number(store.getMeta("backfill_target_block")), 0, "the backfill is done");
    st.msg.push(jOrder("ORD-DEEP", 1830)); jTip(st, 2600); st.hook = (addr, d) => (addr === "M" && d > 300 ? CAPPED : null);
    for (let i = 0; i < 4; i++) { await shop.scanOnce(); jTip(st, st.tip + 1); }
    assert.ok(logs.some(l => /older than block \d+ may not have been read: the node's answer for older blocks was too large/.test(l)), logs.join(" | ")); assert.equal(Number(store.getMeta("backfill_target_block")), 0);
    assert.match(shop.scanState().unreadText, /may not have been read: the node's answer for older blocks was too large\./);
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: a payment older than the node's tree is found at the tree's root and pays the order; only orders older than the floor, and payments already spent, are said as not read", async () => {
  const st = await javaSetup(1000);
  try {
    await shop.scanOnce(); st.msg.push(jOrder("ORD-RT", 995)); jTip(st, 1001); await shop.scanOnce(); assert.ok(store.order("ORD-RT"), "the order is read while open");
    st.pay.push(jPay("ORD-RT", 1010), jPay("ORD-RX", 1020, { spent: true }));   // paid while closed; another, already spent
    const asked = []; const run = javaNode(st); shop._setRunner(async (c) => { const m = / depth:(\d+)$/.exec(c); if (m) asked.push((c.includes(VENDOR) ? "V" : "M") + m[1]); return run(c); });
    jTip(st, 2500); await shop.scanOnce();
    assert.equal(store.order("ORD-RT").paid, true, "paid: the root carries the unspent coin");
    assert.ok(asked.includes("V1124"), "one payments read deep enough to reach the root: " + asked); assert.ok(asked.includes("M1123"), "orders read as deep as the tree may hold");
    assert.equal(Number(store.getMeta("unread_below_block")), 2500 - 1024);
    assert.equal(shop.scanState().unreadText, "Orders older than block 1476, and payments to your shops that were already spent, may not have been read: the node keeps only its recent blocks. Payments not yet spent were read.");
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: past the tree a cut orders read is retried and then said with the reply cap as cause; the stall count resets for a new gap; 'may not have been read'", async () => {
  const st = await javaSetup(1000); const logs = []; store.setLog((m) => logs.push(m));
  try {
    await shop.scanOnce(); st.msg.push(jOrder("ORD-TB", 2500 - 1060)); st.pay.push(jPay("ORD-TB", 2500 - 1058));
    st.hook = (addr, d) => (addr === "M" && d > 1024 ? CAPPED : null);
    jTip(st, 2500); await shop.scanOnce(); assert.equal(Number(store.getMeta("backfill_target_block")), 1000, "a cut orders read does not end the backfill at once");
    jTip(st, 2501); await shop.scanOnce(); assert.equal(Number(store.getMeta("backfill_target_block")), 1000);
    jTip(st, 2502); await shop.scanOnce();
    assert.equal(Number(store.getMeta("backfill_target_block")), 0, "ended after two more tries"); assert.equal(Number(store.getMeta("backfill_stall")), 0);
    assert.equal(shop.scanState().unreadWhy, "capRoot");
    assert.equal(shop.scanState().unreadText, "Orders older than block " + store.getMeta("unread_below_block") + ", and payments to your shops that were already spent, may not have been read: the node's answer for older blocks was too large. Payments not yet spent were read.");
    assert.ok(logs.some(l => /may not have been read: the node's answer for older blocks was too large/.test(l)), "the log says the same");
    // a stall left from an earlier backfill is not carried into a new gap
    store.setMeta("backfill_stall", 2); store.setMeta("backfill_target_block", 0); store.setMeta("backfill_floor_block", 0);
    let first = true; st.hook = (addr, d) => { if (addr !== "M") return null; if (first) { first = false; if (d > 512) return CAPPED; } return d > 64 ? CAPPED : null; };
    jTip(st, 3600); await shop.scanOnce();
    assert.ok(Number(store.getMeta("backfill_target_block")) > 0, "a new gap registers, and one capped step does not end it: " + store.getMeta("backfill_stall"));
    assert.equal(Number(store.getMeta("backfill_stall")), 1, "counted from 0 for the new gap");
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: past the tree with only the payments read cut by the reply cap, the notice names the reply cap for the payments (treePayCap)", async () => {
  const st = await javaSetup(1000);
  try {
    await shop.scanOnce(); st.hook = (addr, d) => (addr === "V" && d > 1024 ? CAPPED : null);
    for (let i = 0; i < 4; i++) { jTip(st, 2500 + i); await shop.scanOnce(); }
    assert.equal(store.getMeta("unread_why"), "treePayCap");
    assert.equal(shop.scanState().unreadText, "Orders older than block 1476 may not have been read: the node keeps only its recent blocks. Payments to your shops older than block 1476 may not have been read: the node's answer for them was too large.");
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    for (const [w, n] of [["cap", 7], ["capRoot", 7], ["treeRoot", 7], ["treePayCap", 7]]) assert.ok(app.includes(w + ': N_("' + require("../main/shop")._unreadText(n, w).replace(/\b7\b/g, "{block}") + '")'), "the Inbox says main's sentence for " + w);
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: the unread notice is kept over later passes and hidden by the vendor (main IPC and the Inbox's Hide)", async () => {
  const st = await javaSetup(1000);
  try {
    await shop.scanOnce(); jTip(st, 2500); await shop.scanOnce(); const below = shop.scanState().unreadBelow; assert.equal(below, 2500 - 1024);
    for (let i = 0; i < 3; i++) { jTip(st, st.tip + 1); await shop.scanOnce(); }
    assert.equal(shop.scanState().unreadBelow, below, "kept over later passes: it is still true");
    assert.deepEqual(await shop.dismissUnread(), { ok: true }); assert.equal(shop.scanState().unreadShown, false, "hidden (0.19.341, as released: the fact is kept)"); assert.equal(shop.scanState().unreadBelow, below);
    jTip(st, 4000); await shop.scanOnce(); assert.ok(shop.scanState().unreadBelow > below && shop.scanState().unreadShown, "a newer one is shown again");
    const keep = store.shops(); for (const sh of keep) store.deleteShop(sh.shopId); assert.equal(shop.scanState().unreadShown, false, "no shop: not shown"); for (const sh of keep) store.saveShop(sh);
    const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8"), pre = fs.readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8"), app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.ok(main.includes('ipcMain.handle("mcd:shopScanDismiss", () => shop.dismissUnread());') && pre.includes('shopScanDismiss: () => ipcRenderer.invoke("mcd:shopScanDismiss"),'));
    assert.ok(app.includes('<button class="mm-pill" id="mmScanHide">${th("Hide")}</button>') && app.includes('el("mmScanHide").onclick = () => api.shopScanDismiss()'));
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});

// ---- 0.19.339 (as released 0.18.285): a payment older than its order holds the order for a check by hand (a copied reference); a real buyer
// sends the order first, and 3 blocks allow the larger order coin to be mined after the payment ----
test("vendor: an order whose payment is older than the order is held for a check by hand, the coin id whole (a copied reference); a real order then payment still pays", async () => {
  const sc = require.cache[require.resolve("../main/shopcrypto.js")].exports, open0 = sc.open, ATK = "0x" + "66".repeat(32);
  sc.open = async (_id, blob) => { const t = Buffer.from(String(blob).slice(2), "hex"); return { valid: true, fromPublicId: JSON.parse(t).from, plaintext: t }; };   // the sender is whoever sealed it
  const atkOrder = (ref, created) => ({ coinid: "0xAT" + Buffer.from(ref + created).toString("hex"), created, state: { "99": hex(JSON.stringify({ type: "ORDER", ref, from: ATK, date: 1, shopId: "tea", items: [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], amount: "1.5", currency: "Minima", shipping: "Digital", delivery: "ATTACKER" })) } });
  const held = (payCoin, payBlock) => { const o = store.order("ORD-X"); assert.ok(o && o.delivery === "ATTACKER", "the copier's order is the one held");
    assert.equal(o.paid, false, "nobody is paid automatically"); assert.equal(o.status, "UNCHECKED");
    assert.ok(o.problems.some(p => p.startsWith("a payment with this order's reference is older than the order (payment coin " + payCoin.toLowerCase().replace(/^0x/, "0x") + " at block " + payBlock + ", the order at block ") || p.startsWith("a payment with this order's reference is older than the order (payment coin " + payCoin + " at block " + payBlock + ", the order at block ")), o.problems.join(" | ")); };
  try {
    // the real order older than the tree at reopen, its payment unspent (root); the copier's order inside the tree
    { const st = await javaSetup(1000); await shop.scanOnce(); st.msg.push(jOrder("ORD-X", 1003), atkOrder("ORD-X", 2490)); const p = jPay("ORD-X", 1005); st.pay.push(p);
      for (let i = 0; i < 6; i++) { jTip(st, 2500 + i); await shop.scanOnce(); } held(p.coinid, 1005); store.clear(); }
    // the copier's order lands during the backfill; the payment is a late one inside the first window
    { const st = await javaSetup(1000); store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }] });
      await shop.scanOnce(); st.msg.push(jOrder("ORD-X", 1003)); const p = jPay("ORD-X", 2400); st.pay.push(p);
      let first = true; st.hook = (addr, d) => { if (addr === "M" && first && d > 512) { first = false; return CAPPED; } return null; };
      jTip(st, 2500); await shop.scanOnce(); st.msg.push(atkOrder("ORD-X", 2501));
      for (let i = 1; i < 7; i++) { jTip(st, 2500 + i); await shop.scanOnce(); } held(p.coinid, 2400); store.clear(); }
    // the copier's order lands after the backfill, then the vendor closes again for long (the root read returns the old payment)
    { const st = await javaSetup(1000); store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }] });
      await shop.scanOnce(); st.msg.push(jOrder("ORD-X", 1003)); const p = jPay("ORD-X", 1500); st.pay.push(p);
      for (let i = 0; i < 6; i++) { jTip(st, 2500 + i); await shop.scanOnce(); }
      st.msg.push(atkOrder("ORD-X", st.tip)); for (let i = 0; i < 3; i++) { jTip(st, st.tip + 1); await shop.scanOnce(); }
      delete require.cache[require.resolve("../main/shop")]; shop = require("../main/shop"); shop._setRunner(javaNode(st)); await shop.init();
      for (let i = 0; i < 6; i++) { jTip(st, 4500 + i); await shop.scanOnce(); } held(p.coinid, 1500); store.clear(); }
    // a real order then its payment: the same block, 1 to 3 blocks earlier by mining order, or later, pays; 4 blocks earlier is held
    for (const [k, paid] of [[0, true], [1, true], [2, true], [3, true], [-5, true], [4, false]]) {
      const st = await javaSetup(1000); store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }] });
      await shop.scanOnce(); st.msg.push(jOrder("ORD-R", 1010)); st.pay.push(jPay("ORD-R", 1010 - k)); jTip(st, 1020); await shop.scanOnce();
      const o = store.order("ORD-R"); assert.equal(o.orderBlock, 1010, "the order coin's block is kept"); assert.equal(o.paid, paid, "payment " + k + " blocks before the order");
      if (!paid) assert.equal(o.status, "UNCHECKED");
      store.clear();
    }
    // an order stored before this version has no block: unknown, so no hold (as before)
    { const st = await javaSetup(1000); store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }] });
      await shop.scanOnce(); st.msg.push(jOrder("ORD-L", 1010)); jTip(st, 1011); await shop.scanOnce();
      delete store.order("ORD-L").orderBlock; store.flush(); st.pay.push(jPay("ORD-L", 1003)); jTip(st, 1012); await shop.scanOnce();
      assert.equal(store.order("ORD-L").orderBlock, undefined); assert.equal(store.order("ORD-L").paid, true, "no block: paid as before"); store.clear(); }
  } finally { sc.open = open0; store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});

// ---- 0.19.344 (as released 0.18.289): a payment is judged only once the chain is more than PAY_BEFORE_ORDER blocks past it; orders are read
// before payments in every pass, so a real order mined within the allowance is held by then; an order marked PAID (not moved on, not checked
// by hand) that meets a second buyer's order with its reference is held again ----
const ATK = "0x" + "66".repeat(32);
const atkOrder = (ref, created, delivery) => ({ coinid: "0xAT" + Buffer.from(ref + created).toString("hex"), created, state: { "99": hex(JSON.stringify({ type: "ORDER", ref, from: ATK, date: 1, shopId: "tea", items: [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], amount: "1.5", currency: "Minima", shipping: "Digital", delivery: delivery || "COPIER" })) } });
const teaShop = () => store.saveShop({ shopId: "tea", shopName: "Tea", currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [{ id: "digital", label: "Digital", fee: "0" }] });
async function copyRig(fn) {
  const sc = require.cache[require.resolve("../main/shopcrypto.js")].exports, open0 = sc.open;
  sc.open = async (_id, blob) => { const t = Buffer.from(String(blob).slice(2), "hex"); return { valid: true, fromPublicId: JSON.parse(t).from, plaintext: t }; };   // the sender is whoever sealed it
  try { store.clear(); teaShop(); const st = await javaSetup(1000); await shop.scanOnce(); await fn(st); }
  finally { sc.open = open0; store.clear(); teaShop(); store.setLog((m) => { throw new Error("no log expected: " + m); }); }
}
const walkTo = async (st, from, to) => { for (let t = from; t <= to; t++) { jTip(st, t); await shop.scanOnce(); } };
const DUPV = "another buyer sent an order with the same reference ORD-V: a payment with it cannot be told apart, so check both orders by hand";
// CHANGED on purpose (0.19.354, as released 0.18.300): a payment is counted the first time it is read, as released 0.18.286 (0.19.344 to 0.19.353
// left it unjudged until tip pb + 3, and a coin still waiting could be spent by the vendor's own wallet before it was ever counted). An order
// without a secret paid in full SETTLES until a good orders read is 3 blocks past its newest coin, so the real order meets the copier's first.
test("vendor: a copier's order mined the block after another buyer's payment, the real order two blocks later: the copier's order is paid but settling, then both are held for a check by hand", async () => {
  await copyRig(async (st) => {
    const p = jPay("ORD-V", 1010); st.pay.push(p); st.msg.push(atkOrder("ORD-V", 1011), jOrder("ORD-V", 1012, { coinid: "0xJOV" }));
    await walkTo(st, 1010, 1011);
    const o = store.order("ORD-V"); assert.equal(o.delivery, "COPIER");
    assert.equal(o.paid, true, "counted the first time it is read"); assert.equal(store.mayAdvance(o), false, "but settling");
    assert.deepEqual(shop.orderDetail("ORD-V").settling, { block: 1013 }, "said with the block it is held until");
    await assert.rejects(shop.advanceStatus("ORD-V", "CONFIRMED"), /^Error: This order's payment is held until block 1013 in case another order with the same reference arrives\. Check it by hand to move it on now\.$/);
    await walkTo(st, 1012, 1016);
    const copier = store.order("ORD-V"), victim = store.order("ORD-V~" + BUYER);
    assert.ok(victim, "the real order is kept as a second buyer's");
    for (const x of [copier, victim]) {
      assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(store.mayAdvance(x), false); assert.equal(x.problems[0], DUPV, x.problems.join(" | "));
      await assert.rejects(shop.advanceStatus(x.ref, "CONFIRMED"), /Check it by hand first/);
    }
    assert.equal(copier.paidAmount, "1.5", "counted once on the order held under the reference"); assert.equal(shop.orderDetail("ORD-V").settling, null);
  });
});
test("vendor: an order marked PAID meets a second buyer's order with its reference: unpaid and held for a check by hand; confirmed, shipped or hand-checked ones are left as they are", async () => {
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1010)); st.msg.push(atkOrder("ORD-V", 1011));
    await walkTo(st, 1010, 1015); assert.equal(store.order("ORD-V").paid, true); assert.equal(store.order("ORD-V").status, "PAID");
    st.msg.push(jOrder("ORD-V", 1020, { coinid: "0xJOV" })); await walkTo(st, 1016, 1021);
    const copier = store.order("ORD-V"), victim = store.order("ORD-V~" + BUYER);
    assert.equal(copier.paid, false); assert.equal(copier.status, "UNCHECKED"); assert.equal(copier.problems[0], DUPV); assert.equal(copier.paidAmount, "1.5", "what was received stays counted");
    assert.equal(store.mayAdvance(copier), false); assert.equal(store.mayAdvance(victim), false);
    assert.equal(store.handCheck("ORD-V"), true); assert.equal(store.mayAdvance(store.order("ORD-V")), true, "moves on once checked by hand");
    const base = { role: "sell", shopId: "tea", amount: "1.5", currency: "Minima", tokenid: "0x00", items: [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], shipping: "Digital", problems: [], due: "1.5" };
    store.upsertOrder(Object.assign({ ref: "ORD-C1", status: "CONFIRMED", paid: true }, base)); store.upsertOrder(Object.assign({ ref: "ORD-C2", status: "PAID", paid: true, handChecked: true }, base));
    store.upsertOrder(Object.assign({ ref: "ORD-C3", status: "SHIPPED", paid: true }, base));
    for (const r of ["ORD-C1", "ORD-C2", "ORD-C3"]) { const was = JSON.stringify(store.order(r)); assert.equal(store.flagDuplicate(r, "x"), false, r); assert.equal(JSON.stringify(store.order(r)), was, r + " unchanged"); }
  });
});
// changed on purpose (0.19.348, as released 0.18.293): judged at tip = block + 3 (0.19.344 waited to block + 4, and the wallet could spend the coin first)
// CHANGED on purpose (0.19.354): counted when first read; confirmable at tip = block + 3 with the orders read (0.19.348 counted it only then)
test("vendor: one buyer's order then payment, the same block, and an order 3 blocks after its payment: counted when first read, confirmable once a good pass is 3 blocks past the payment, counted once", async () => {
  for (const [ob, pb] of [[1009, 1010], [1010, 1010], [1013, 1010]]) {
    await copyRig(async (st) => {
      st.msg.push(jOrder("ORD-1", ob)); const p = jPay("ORD-1", pb); st.pay.push(p);
      await walkTo(st, 1001, pb + 2); const o = store.order("ORD-1");
      if (ob <= pb + 2) { assert.equal(o.paid, true, "counted at sight (order " + ob + ")"); assert.equal(store.mayAdvance(o), false, "tip " + (pb + 2) + ": settling"); assert.deepEqual(shop.orderDetail("ORD-1").settling, { block: pb + 3 }); }
      else assert.equal(o, null, "the order is not read yet");
      await walkTo(st, pb + 3, pb + 3); const q = store.order("ORD-1");
      assert.equal(q.paid, true); assert.equal(store.mayAdvance(q), true, "tip " + (pb + 3) + ": settled (order " + ob + ")"); assert.equal(q.paidAmount, "1.5"); assert.deepEqual(q.coins, [p.coinid.toLowerCase()]);
      await walkTo(st, pb + 4, pb + 8); assert.equal(store.order("ORD-1").paidAmount, "1.5", "counted once");
    });
  }
});
test("vendor: a payment is counted when first read and the order settles on a good pass after a restart; tip = block + 2 settling, block + 3 settled; the Inbox says it settles", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-W", 1009)); st.pay.push(jPay("ORD-W", 1010));
    jTip(st, 1010); await shop.scanOnce(); assert.equal(store.order("ORD-W").paid, true, "tip 1010: counted"); assert.equal(store.mayAdvance(store.order("ORD-W")), false);
    const reopen = async () => { store.flush(); delete require.cache[require.resolve("../main/shop")]; shop = require("../main/shop"); shop._setRunner(javaNode(st)); await shop.init(); };
    await reopen(); jTip(st, 1012); await shop.scanOnce(); assert.equal(store.mayAdvance(store.order("ORD-W")), false, "tip 1012 = 1010 + 2: settling");
    await reopen(); jTip(st, 1013); await shop.scanOnce(); assert.equal(store.mayAdvance(store.order("ORD-W")), true, "tip 1013 after a restart: settled");
    st.msg.push(jOrder("ORD-W2", 1013)); st.pay.push(jPay("ORD-W2", 1014)); jTip(st, 1014); await shop.scanOnce(); assert.equal(store.order("ORD-W2").paid, true);
    await reopen(); jTip(st, 1700); await shop.scanOnce(); assert.equal(store.mayAdvance(store.order("ORD-W2")), true, "after 700 blocks away");
  });
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes('tr("Paid. Held until block {block} in case another order with the same reference arrives.", { block: esc(String(settling.block)) })') && !app.includes("It is counted after block"), "the Inbox says the order settles");
});

// ---- 0.19.348 (as released 0.18.293): the node's send may spend a coin from tip pb + 3 (coin age 3) and `coins` lists unspent coins only: a
// payment judged only from tip pb + 4 could be spent by the vendor's own wallet in block pb + 4 before it was ever counted ----
test("vendor: the vendor's own send spends the payment at tip block + 3, mined in block + 4: the payment was counted by the pass at block + 3", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-S", 1009)); const p = jPay("ORD-S", 1010); st.pay.push(p);
    await walkTo(st, 1001, 1013); assert.equal(store.order("ORD-S").paid, true, "counted at tip 1013, before any spend of it can be mined");
    p.spent = true; await walkTo(st, 1014, 1030);   // spendable at 1013, mined in block 1014: the node no longer lists it
    const o = store.order("ORD-S"); assert.equal(o.paid, true); assert.equal(o.paidAmount, "1.5"); assert.equal(o.status, "PAID");
  });
});
// CHANGED on purpose (0.19.354): the waiting line is gone with the wait; what a failed read now does is settle nothing
test("vendor: while the orders read fails, a paid order without a secret stays settling (it can be checked by hand); the first good pass past its block + 3 settles it", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-WF", 1009)); st.pay.push(jPay("ORD-WF", 1010));
    await walkTo(st, 1009, 1010); st.hook = (addr) => (addr === "M" ? "throw" : null); await walkTo(st, 1011, 1016);
    const o = store.order("ORD-WF"); assert.equal(o.paid, true); assert.equal(store.mayAdvance(o), false, "no good orders read: not settled"); assert.deepEqual(shop.orderDetail("ORD-WF").settling, { block: 1013 });
    st.hook = null; await walkTo(st, 1017, 1017); assert.equal(store.mayAdvance(store.order("ORD-WF")), true);
  });
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-WH", 1009)); st.pay.push(jPay("ORD-WH", 1010)); await walkTo(st, 1009, 1010);
    assert.equal(store.handCheck("ORD-WH"), true, "a settling order can be checked by hand"); assert.equal(store.mayAdvance(store.order("ORD-WH")), true); assert.equal(shop.orderDetail("ORD-WH").settling, null);
  });
});

// ---- 0.19.349 (as released 0.18.294): orders are read before payments, and a payment is judged only when the orders that may go with it are
// known read: a pass whose orders read failed judges no payment, and a coin below what a cut orders read reached waits for the read of that range ----
const held2 = (copier, victim) => { for (const x of [copier, victim]) { assert.ok(x); assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); assert.equal(x.problems[0], DUPV, x.problems.join(" | ")); } };
// CHANGED on purpose (0.19.354; the rule was 0.19.349's): a pass whose orders read failed, or a cut one whose gap covers the coin's block, still
// counts every payment it lists, and settles none
test("vendor: the orders read fails at tip pb + 3: the copier's order, paid when first read, is not settled by that pass; the next good pass reads the real order and holds both", async () => {
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1010)); st.msg.push(atkOrder("ORD-V", 1011), jOrder("ORD-V", 1013, { coinid: "0xJOV" }));
    await walkTo(st, 1001, 1012);
    st.hook = (addr) => (addr === "M" ? "throw" : null); await walkTo(st, 1013, 1013);   // the real order is in block 1013, and the read of it fails
    const o = store.order("ORD-V"); assert.equal(o.delivery, "COPIER"); assert.equal(o.paid, true, "counted when first read"); assert.equal(store.mayAdvance(o), false, "not settled by a failed orders read");
    assert.equal(shop.scanState().readFailed, true);
    st.hook = null; await walkTo(st, 1014, 1014);
    held2(store.order("ORD-V"), store.order("ORD-V~" + BUYER)); assert.equal(store.order("ORD-V").paidAmount, "1.5", "counted once, on the order held under the reference");
  });
  // past the tree: the orders read as deep as the tree may hold fails; the root read counts the payment; nothing settles before the real order is read
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1474)); st.msg.push(jOrder("ORD-V", 1475, { coinid: "0xJOV" }), atkOrder("ORD-V", 1477));
    st.hook = (addr, d) => (addr === "M" && d > 1024 ? "throw" : null); jTip(st, 2500); await shop.scanOnce();
    const c = store.order("ORD-V"); assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, true); assert.equal(store.mayAdvance(c), false, "its block is below what the orders read reached");
    st.hook = null; jTip(st, 2501); await shop.scanOnce(); held2(store.order("ORD-V"), store.order("ORD-V~" + BUYER));
  });
});
test("vendor: a cut orders read (window, step or past the tree): a payment below what it reached is counted but its order is not settled until the orders of its range are read; neither order is then paid", async () => {
  // the window (608 blocks) cut to 304 reaches block 1296: the copier's order in it, the payment and the real order just under it; the step fails once
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1294)); st.msg.push(atkOrder("ORD-V", 1296), jOrder("ORD-V", 1293, { coinid: "0xJOV" }));
    let n = 0; st.hook = (addr) => { if (addr !== "M") return null; n++; return n === 1 ? CAPPED : n === 2 ? null : "throw"; };
    jTip(st, 1600); await shop.scanOnce();
    assert.equal(store.order("ORD-V").delivery, "COPIER"); assert.equal(Number(store.getMeta("backfill_floor_block")), 1296);
    assert.equal(store.order("ORD-V").paid, true, "counted when first read (CHANGED on purpose, 0.19.354)"); assert.equal(store.mayAdvance(store.order("ORD-V")), false, "not settled: the orders of its range are not read");
    st.hook = null; jTip(st, 1601); await shop.scanOnce(); held2(store.order("ORD-V"), store.order("ORD-V~" + BUYER));
  });
  // a backfill step whose orders read is cut above the gap's target: the window (1008) cut to 252 (floor 1748), the step (764) cut to 382: it reaches 1618
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1616)); st.msg.push(atkOrder("ORD-V", 1618), jOrder("ORD-V", 1615, { coinid: "0xJOV" }));
    let n = 0; st.hook = (addr, d) => { if (addr !== "M") return null; n++; return (n <= 3 && d > 256) || (n > 3 && d > 384) ? CAPPED : null; };
    jTip(st, 2000); await shop.scanOnce();
    assert.equal(Number(store.getMeta("backfill_floor_block")), 1618, "the step reached 1618"); assert.equal(store.order("ORD-V").delivery, "COPIER");
    assert.equal(store.order("ORD-V").paid, true, "counted (CHANGED on purpose, 0.19.354)"); assert.equal(store.mayAdvance(store.order("ORD-V")), false, "not settled: the orders below 1618 are not read");
    st.hook = null; jTip(st, 2001); await shop.scanOnce();
    const c = store.order("ORD-V"), v = store.order("ORD-V~" + BUYER); assert.ok(v); for (const x of [c, v]) { assert.equal(x.paid, false); assert.equal(x.status, "UNCHECKED"); }
  });
  // a step that reaches the gap's target judges what it lists below it: those blocks' orders were read before the gap
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-E", 997)); jTip(st, 1001); await shop.scanOnce(); assert.ok(store.order("ORD-E")); st.pay.push(jPay("ORD-E", 998));
    store.setMeta("scanned_tip_block", 1005); store.setMeta("backfill_target_block", 1000); store.setMeta("backfill_floor_block", 1004);
    st.hook = (addr, d) => (addr === "M" && d > 7 ? CAPPED : null);   // the window served 4 blocks, the step (14) 7: it reaches 999
    jTip(st, 1006); await shop.scanOnce();
    assert.equal(Number(store.getMeta("backfill_target_block")), 0, "the backfill reached its target"); assert.equal(store.order("ORD-E").paid, true, "the payment at 998 is judged");
  });
  // past the tree: the orders read as deep as the tree may hold is cut on the first try and whole on the second
  await copyRig(async (st) => {
    st.pay.push(jPay("ORD-V", 1474)); st.msg.push(jOrder("ORD-V", 1475, { coinid: "0xJOV" }), atkOrder("ORD-V", 1477));
    st.hook = (addr, d) => (addr === "M" && d > 1024 ? CAPPED : null); jTip(st, 2500); await shop.scanOnce();
    assert.equal(store.order("ORD-V").delivery, "COPIER"); assert.equal(store.order("ORD-V").paid, true, "counted (CHANGED on purpose, 0.19.354)"); assert.equal(store.mayAdvance(store.order("ORD-V")), false, "not settled while the cut read is tried again");
    assert.equal(Number(store.getMeta("backfill_stall")), 1);
    st.hook = null; jTip(st, 2501); await shop.scanOnce(); held2(store.order("ORD-V"), store.order("ORD-V~" + BUYER)); assert.equal(store.order("ORD-V").paidAmount, "1.5");
  });
});

// ---- 0.19.345 (as released 0.18.290): one "older than the order" problem per order and no write for a coin that changes nothing (2000 coins
// made 2001 problems and 3001 rewrites); the same buyer's order sent again: its block is its oldest coin's, never a copier's ----
test("vendor: 2000 old coins with an order's reference: one 'older than the order' problem, the first coin's id whole, and the writes bounded by the order's coin list", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-F", 1500));
    for (let i = 0; i < 2000; i++) st.pay.push(jPay("ORD-F", 1001 + (i ? 1 + (i % 400) : 0), { coinid: "0xFB" + (0x10000 + i).toString(16) }));
    let writes = 0; const real = fs.renameSync; fs.renameSync = function () { writes++; return real.apply(this, arguments); };
    try { jTip(st, 1510); await shop.scanOnce(); } finally { fs.renameSync = real; }
    const o = store.order("ORD-F"), older = o.problems.filter(p => p.startsWith("a payment with this order's reference is older than the order"));
    assert.equal(older.length, 1, o.problems.length + " problems");
    assert.equal(older[0], "a payment with this order's reference is older than the order (payment coin 0xFB10000 at block 1001, the order at block 1500): check by hand");
    assert.ok(writes <= store.MAX_PAY_COINS + 4, writes + " writes: the order, its problems, and each coin counted on its list (at most MAX_PAY_COINS)"); assert.equal(o.paid, false);
  });
});
test("vendor: the same buyer's order sent again: a payment between the two copies pays it (the order's block is its oldest copy's); a copier's lower coin never moves another buyer's order's block", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-R", 1010, { coinid: "0xJOR2" }), jOrder("ORD-R", 1000, { coinid: "0xJOR1" }));   // the node lists newest first
    st.pay.push(jPay("ORD-R", 1001)); jTip(st, 1020); await shop.scanOnce();
    const o = store.order("ORD-R"); assert.equal(o.orderBlock, 1000, "lowered to the oldest copy"); assert.equal(o.paid, true, o.problems.join(" | "));
  });
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-R", 1010), atkOrder("ORD-R", 1000));
    st.pay.push(jPay("ORD-R", 1003)); jTip(st, 1020); await shop.scanOnce();
    const o = store.order("ORD-R"), c = store.order("ORD-R~" + ATK);
    assert.equal(o.counterparty, BUYER); assert.equal(o.orderBlock, 1010, "not moved by another sender's coin"); assert.equal(c.orderBlock, 1000, "the copier's order is a second buyer's");
    assert.equal(o.paid, false); assert.equal(store.mayAdvance(o), false); assert.equal(store.mayAdvance(c), false);
  });
});

// ---- 0.19.346: the released tree's assertions b5c9fbb dropped (a second gap keeps the oldest target, released scripts/shop-test.cjs), and the
// lines no test pinned: the stall reset when a step makes progress, "a failed read moves nothing" past the tree, the step's BACKFILL_CHUNK ----
const bfState = () => ["backfill_target_block", "backfill_floor_block", "backfill_stall", "unread_below_block"].map(k => Number(store.getMeta(k)) || 0);
test("vendor: a second gap while a backfill is pending keeps the oldest target, and the floor moves under the new window", async () => {
  const st = await javaSetup(3000);
  try {
    store.setMeta("scanned_tip_block", 1803); store.setMeta("backfill_target_block", 1000); store.setMeta("backfill_floor_block", 1700);
    let once = true; st.hook = (addr, d) => { if (addr === "M" && once) { once = false; if (d > 512) return CAPPED; } return null; };   // the window cut, so the new gap stays in the tree
    await shop.scanOnce();
    assert.equal(shop.scanState().catchingUpTo, 1000, "the oldest target is kept"); assert.ok(Number(store.getMeta("backfill_floor_block")) < 3000 - 512, "the floor moves under the new window");
    assert.equal(shop.scanState().readFailed, false);
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: a backfill step that reads below its floor resets the stall count; a step reaches BACKFILL_CHUNK (512) blocks below the floor", async () => {
  const st = await javaSetup(3000), asked = [], run = javaNode(st);
  shop._setRunner(async (c) => { const m = / depth:(\d+)$/.exec(c); if (m && c.startsWith("coins address:" + shop.MINIMERCH)) asked.push(Number(m[1])); return run(c); });
  try {
    store.setMeta("scanned_tip_block", 2999); store.setMeta("backfill_target_block", 1000); store.setMeta("backfill_floor_block", 2800); store.setMeta("backfill_stall", 2);
    await shop.scanOnce();
    assert.ok(asked.includes(712), "the step reads 3000 - 2800 + 512 = 712 blocks: " + asked.join(","));
    assert.deepEqual(bfState(), [1000, 3000 - 712, 0, 0], "the floor moved down and the stall count is reset");
    assert.match(fs.readFileSync(path.join(__dirname, "..", "main", "shop.js"), "utf8"), /const WINDOW_DEPTH = 1024, GAP_MARGIN = 8, BACKFILL_CHUNK = 512;/);
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: past the tree, a failed read moves nothing: target, floor, stall and the notice stay, said as an older read that failed", async () => {
  const st = await javaSetup(3000);
  try {
    store.setMeta("scanned_tip_block", 2999); store.setMeta("backfill_target_block", 1000); store.setMeta("backfill_floor_block", 1900); store.setMeta("backfill_stall", 1);
    st.hook = (addr, d) => (addr === "M" && d >= 1123 ? "throw" : null);   // the orders read as deep as the tree may hold throws
    await shop.scanOnce();
    assert.deepEqual(bfState(), [1000, 1900, 1, 0], "nothing moved"); assert.deepEqual([shop.scanState().readFailed, shop.scanState().stepFailed], [false, true]);
    st.hook = null; await shop.scanOnce(); assert.equal(Number(store.getMeta("backfill_target_block")), 0, "the next pass reads it and ends the backfill");
  } finally { store.setLog((m) => { throw new Error("no log expected: " + m); }); }
});
test("vendor: a notice stored with no cause says the tree's sentence (the node keeps only its recent blocks), as released", async () => {
  await javaSetup(3000); teaShop();
  store.setMeta("unread_below_block", 1476); store.setMeta("unread_why", 0);
  assert.equal(shop.scanState().unreadText, "Orders and payments older than block 1476 may not have been read: the node keeps only its recent blocks.");
  assert.equal(shop.scanState().unreadWhy, "tree");
  store.setMeta("unread_below_block", 0); store.setLog((m) => { throw new Error("no log expected: " + m); });
});
// changed on purpose (0.19.350, as released 0.18.295): the pass fails for that coin (the cursor stays) and the Inbox says so with its id whole, not
// as the node not answering
test("vendor: a payment coin whose judging threw is not kept as seen: the pass fails and the next one counts it", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-T", 1009)); const p = jPay("ORD-T", 1010); st.pay.push(p); const logs = []; store.setLog((m) => logs.push(m));
    const real = store.recordPayment; let once = true;
    store.recordPayment = function () { if (once) { once = false; throw new Error("disk full"); } return real.apply(this, arguments); };
    try {
      jTip(st, 1020); await shop.scanOnce(); assert.equal(store.order("ORD-T").paid, false);
      assert.deepEqual([shop.scanState().readFailed, shop.scanState().judgeFailed], [false, [p.coinid]], "the pass failed for that coin, not the node"); assert.equal(store.getMeta("scanned_tip_block"), 1000, "the cursor stays");
      jTip(st, 1021); await shop.scanOnce(); assert.equal(store.order("ORD-T").paid, true, "judged again, not skipped as seen");
      assert.deepEqual(shop.scanState().judgeFailed, []); assert.equal(store.getMeta("scanned_tip_block"), 1021);
    } finally { store.recordPayment = real; }
    assert.ok(logs.some(l => l.includes(p.coinid) && l.includes("disk full")), logs.join(" | "));
  });
});
// 0.19.350 (as released 0.18.295): one coin whose judging always throws stopped every newer coin for good (the loop rethrew, the cursor never moved,
// and the Inbox said the node did not answer); every coin is judged, and the coin is given up on after three passes that threw
test("vendor: a payment coin whose judging always throws: an unrelated payment is still paid in the same pass; after three passes the coin is left for a check by hand and the cursor moves", async () => {
  await copyRig(async (st) => {
    st.msg.push(jOrder("ORD-P1", 1001), jOrder("ORD-P2", 1005)); const p1 = jPay("ORD-P1", 1002); st.pay.push(p1, jPay("ORD-P2", 1006));
    const logs = []; store.setLog((m) => logs.push(m)); const real = store.recordPayment; let calls = 0;
    store.recordPayment = function (ref) { if (ref === "ORD-P1") { calls++; throw new Error("poison"); } return real.apply(this, arguments); };
    try {
      jTip(st, 1010); await shop.scanOnce();
      assert.equal(store.order("ORD-P2").paid, true, "the newer coin is judged in the same pass"); assert.equal(store.order("ORD-P1").paid, false);
      assert.deepEqual([shop.scanState().readFailed, shop.scanState().stepFailed, shop.scanState().judgeFailed], [false, false, [p1.coinid]], "not the node");
      assert.equal(store.getMeta("scanned_tip_block"), 1000, "the cursor stays");
      jTip(st, 1011); await shop.scanOnce(); assert.equal(store.getMeta("scanned_tip_block"), 1000);
      jTip(st, 1012); await shop.scanOnce();
      assert.equal(store.getMeta("scanned_tip_block"), 1012, "given up on after three passes: the cursor moves"); assert.equal(calls, 3);
      const o = store.order("ORD-P1"); assert.ok(o.problems.includes("payment coin " + p1.coinid + " could not be judged: check by hand"), o.problems.join(" | ")); assert.equal(o.status, "UNCHECKED");
      assert.deepEqual([shop.scanState().judgeFailed, shop.scanState().gaveUp], [[], [p1.coinid]]);
      assert.ok(logs.some(l => l.includes(p1.coinid) && l.includes("poison") && /after 3 tries/.test(l)), logs.join(" | "));
      jTip(st, 1013); await shop.scanOnce(); assert.equal(calls, 3, "not judged again this session"); assert.equal(store.getMeta("scanned_tip_block"), 1013);
      // 0.19.356: checked by hand, the coin is no longer said on the Inbox
      shop.vendorCheck("ORD-P1"); assert.deepEqual(shop.scanState().gaveUp, [], "said until the vendor checked the order");
    } finally { store.recordPayment = real; }
  });
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(app.includes('tr("Payment coin {coin} could not be judged. It is judged again on the next block.", { coin: esc(c) })') && app.includes('tr("Payment coin {coin} could not be judged: check by hand.", { coin: esc(c) })') && app.includes("${judgePay ? `<div class=\"mm-warn\""), "the Inbox says it");
});
test("vendor: one payout address whose read throws does not keep the other addresses' payments from being judged; the pass is still a failed one", async () => {
  await copyRig(async (st) => {
    const OTHER = "0x" + "77".repeat(32);
    store.saveShop({ shopId: "two", shopName: "Two", currency: "Minima", tokenid: "0x00", vendorAddress: OTHER, products: [{ id: "p1", name: "Tea", price: "1.5", maxUnits: "10" }], shipping: [] });
    st.msg.push(jOrder("ORD-P", 1009)); st.pay.push(jPay("ORD-P", 1010));
    const run = javaNode(st); shop._setRunner(async (c) => { if (c.startsWith("coins address:" + OTHER)) throw new Error("RPC timed out"); return run(c); });
    jTip(st, 1020); await shop.scanOnce();
    assert.equal(store.order("ORD-P").paid, true, "the vendor address's payment is judged"); assert.equal(shop.scanState().readFailed, true, "the other address was not read: the cursor stays");
  });
});

// ---- 0.19.352 (as released 0.18.297): the order's secret and its proof, as the phone Shop and Inbox (base-vestr-2.2.76 comms/MerchMessage.java:113-136) ----
const nodeCrypto = require("crypto");
const proofT = (s) => "0x" + nodeCrypto.createHash("sha256").update(Buffer.from(s.slice(2), "hex")).digest("hex").toUpperCase();
const newSecret = () => "0x" + nodeCrypto.randomBytes(32).toString("hex").toUpperCase();
const NOPROOF = (id) => "a payment with this order's reference does not carry this order's proof (payment coin " + id + "): check by hand";
const BADSECRET = "this order's secret cannot be read, so no payment can be proved to be its buyer's: check by hand";
// an order from `who` with `nonce` (undefined: no field, as an older Shop), and a payment coin with `proof` in port 2 (undefined: none)
const sOrder = (who, ref, created, delivery, nonce) => ({ coinid: "0xSO" + Buffer.from(who.slice(2, 8) + ref + created + delivery).toString("hex"), created,
  state: { "99": hex(JSON.stringify(Object.assign({ type: "ORDER", ref, from: who, date: 1, shopId: "tea", items: [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], amount: "1.5", currency: "Minima", shipping: "Digital", delivery }, nonce !== undefined ? { nonce } : {}))) } });
const sPay = (ref, created, proof, id, amount) => ({ coinid: id, tokenid: "0x00", amount: amount || "1.5", created, state: Object.assign({ "1": hex(ref) }, proof !== undefined ? { "2": proof } : {}) });
const VICTIM = BUYER;

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
  const paidByItsCoin = (o) => { assert.ok(o, "the real order is kept"); assert.equal(o.delivery, "VICTIM"); assert.equal(o.paid, true, o.problems.join(" | ")); assert.equal(o.status, "PAID"); assert.deepEqual(o.problems, []); assert.deepEqual(o.coins, [V.toLowerCase()]); assert.equal(store.mayAdvance(o), true); };
  const neverPaid = (o) => { assert.ok(o && o.delivery === "COPIER"); assert.equal(o.paid, false); assert.ok(!(o.coins || []).length, "nothing counted on the copier's order"); };
  for (const atkSecret of [undefined, newSecret()]) {
    const tag = atkSecret ? "the copier with a secret of their own" : "the copier with no secret";
    // copier first: the real payment at 1010, the copier's order the block after, the real order two blocks later
    await copyRig(async (st) => { st.pay.push(sPay("ORD-V", 1010, P, V)); st.msg.push(sOrder(ATK, "ORD-V", 1011, "COPIER", atkSecret), sOrder(VICTIM, "ORD-V", 1012, "VICTIM", S));
      await walkTo(st, 1010, 1016);
      const c = store.order("ORD-V"); neverPaid(c); paidByItsCoin(store.order("ORD-V~" + VICTIM));
      // an order with a secret is not held by another's order; this one is held by the real payment, read before the real order (0.19.354: at sight)
      if (atkSecret) assert.deepEqual(c.problems, [NOPROOF(V)], tag); else assert.equal(c.problems[0], DUPV, tag + ": an order without one is held as before");
      assert.equal(shop.orderDetail("ORD-V~" + VICTIM).sharedRef, null, "its payments are counted on it"); });
    // real first: the order, its payment, then the copier's order
    await copyRig(async (st) => { st.pay.push(sPay("ORD-V", 1010, P, V)); st.msg.push(sOrder(VICTIM, "ORD-V", 1009, "VICTIM", S), sOrder(ATK, "ORD-V", 1011, "COPIER", atkSecret));
      await walkTo(st, 1009, 1016); paidByItsCoin(store.order("ORD-V")); neverPaid(store.order("ORD-V~" + ATK)); });
    // the real order already PAID when the copier's order comes: not unpaid
    await copyRig(async (st) => { st.pay.push(sPay("ORD-V", 1010, P, V)); st.msg.push(sOrder(VICTIM, "ORD-V", 1009, "VICTIM", S));
      await walkTo(st, 1009, 1014); assert.equal(store.order("ORD-V").paid, true);
      st.msg.push(sOrder(ATK, "ORD-V", 1015, "COPIER", atkSecret)); await walkTo(st, 1015, 1018);
      paidByItsCoin(store.order("ORD-V")); neverPaid(store.order("ORD-V~" + ATK)); });
    // the same block: both orders and the payment in block 1010
    await copyRig(async (st) => { st.pay.push(sPay("ORD-V", 1010, P, V)); st.msg.push(sOrder(VICTIM, "ORD-V", 1010, "VICTIM", S), sOrder(ATK, "ORD-V", 1010, "COPIER", atkSecret));
      await walkTo(st, 1010, 1014);
      const os = [store.order("ORD-V"), store.order("ORD-V~" + ATK), store.order("ORD-V~" + VICTIM)].filter(Boolean);
      paidByItsCoin(os.find(o => o.delivery === "VICTIM")); neverPaid(os.find(o => o.delivery === "COPIER")); });
    // the real order's read fails on the pass that would judge the payment: the payment waits, and the next pass pays the real order
    await copyRig(async (st) => { st.pay.push(sPay("ORD-V", 1010, P, V)); st.msg.push(sOrder(ATK, "ORD-V", 1011, "COPIER", atkSecret), sOrder(VICTIM, "ORD-V", 1013, "VICTIM", S));
      await walkTo(st, 1010, 1012); st.hook = (addr) => (addr === "M" ? "throw" : null); jTip(st, 1013); await shop.scanOnce();
      neverPaid(store.order("ORD-V")); st.hook = null; await walkTo(st, 1014, 1016);
      neverPaid(store.order("ORD-V")); paidByItsCoin(store.order("ORD-V~" + VICTIM)); });
    // the real order past the node's tree (never read here), its payment unspent at the root: the copier's order inside the tree is not paid
    await copyRig(async (st) => { st.msg.push(sOrder(VICTIM, "ORD-V", 1003, "VICTIM", S), sOrder(ATK, "ORD-V", 2490, "COPIER", atkSecret)); st.pay.push(sPay("ORD-V", 1005, P, V));
      for (let i = 0; i < 6; i++) { jTip(st, 2500 + i); await shop.scanOnce(); }
      const c = store.order("ORD-V"); assert.ok(c && c.delivery === "COPIER"); assert.equal(c.paid, false); assert.ok(!(c.coins || []).length);
      if (atkSecret) assert.deepEqual(c.problems, [NOPROOF(V)], "the copier's order with a secret: the payment does not prove it");
      else assert.deepEqual(c.problems, [], "the copier's order with no secret: a proved coin never pays it, so nothing holds it"); });
  }
});

test("a copier who copies the reference AND the proof from the real coin: their coin pays the real order, and their order (with the proof as its 'secret', or with no secret) is never paid", async () => {
  const S = newSecret(), P = proofT(S);
  for (const atkNonce of [P, undefined]) await copyRig(async (st) => {
    st.msg.push(sOrder(ATK, "ORD-V", 1009, "COPIER", atkNonce), sOrder(VICTIM, "ORD-V", 1010, "VICTIM", S));
    st.pay.push(sPay("ORD-V", 1011, P, "0xFE02", "0.75"), sPay("ORD-V", 1012, P, "0xFE03", "0.75"));   // the copier's coin, then the buyer's: both with the buyer's proof
    await walkTo(st, 1009, 1016);
    const c = store.order("ORD-V"), v = store.order("ORD-V~" + VICTIM);
    assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, false); assert.ok(!(c.coins || []).length, "nothing counted for the copier");
    if (atkNonce) assert.equal(c.commit, proofT(P), "the proof used as a secret proves something else");
    assert.equal(v.paid, true); assert.deepEqual(v.coins, ["0xfe02", "0xfe03"], "both coins prove the buyer's secret: the buyer's order");
  });
});

test("orders with no secret keep every rule of before; a coin with a proof never pays one; an order stored before 0.19.352 is paid as before", async () => {
  for (const port2 of [proofT(newSecret()), "0x01", "[x]"]) await copyRig(async (st) => {
    st.msg.push(sOrder(VICTIM, "ORD-L", 1009, "VICTIM")); st.pay.push(sPay("ORD-L", 1010, port2, "0xFE10"));
    await walkTo(st, 1009, 1014); const o = store.order("ORD-L");
    assert.equal(o.noSecret, true); assert.equal(o.paid, false, port2); assert.ok(!(o.coins || []).length); assert.deepEqual(o.problems, [], "and nothing to check: it is not this order's");
    st.pay.push(sPay("ORD-L", 1015, undefined, "0xFE11")); await walkTo(st, 1015, 1018);
    assert.equal(store.order("ORD-L").paid, true, "a coin without a proof pays it, as before");
  });
  // stored by 0.19.351 (it may have come with a secret this version did not read): a coin with a proof still pays it
  await copyRig(async (st) => { st.msg.push(sOrder(VICTIM, "ORD-P", 1009, "VICTIM", newSecret())); jTip(st, 1009); await shop.scanOnce();
    const o = store.order("ORD-P"); delete o.commit; delete o.noSecret; store.flush();
    st.pay.push(sPay("ORD-P", 1010, proofT(newSecret()), "0xFE12")); await walkTo(st, 1010, 1014);
    assert.equal(store.order("ORD-P").paid, true); });
});

test("a secret that is not 0x and 64 hexadecimal digits: the order is held for a check by hand (never taken as an older Shop's), and no coin pays it automatically", async () => {
  const bads = [null, 7, "0x12", "0x" + "G".repeat(64), "0x" + "A".repeat(65), "0X" + "A".repeat(64), { a: 1 }, ["0x" + "A".repeat(64)], "x".repeat(20000)];
  await copyRig(async (st) => {
    bads.forEach((b, k) => { st.msg.push(sOrder(VICTIM, "ORD-B" + k, 1009, "VICTIM", b)); st.pay.push(sPay("ORD-B" + k, 1010, undefined, "0xFE2" + k), sPay("ORD-B" + k, 1010, proofT(newSecret()), "0xFE3" + k)); });
    await walkTo(st, 1009, 1014);
    bads.forEach((b, k) => { const o = store.order("ORD-B" + k), what = typeof b === "string" ? b.slice(0, 70) : JSON.stringify(b);
      assert.ok(o, what); assert.equal(o.problems[0], BADSECRET, what); assert.equal(o.commit, undefined); assert.equal(o.paid, false, what); assert.equal(o.status, "UNCHECKED", what);
      assert.deepEqual(o.coins, ["0xfe2" + k], "the coin without a proof is counted on it, as on an older Shop's held order: " + what);
      assert.equal(store.handCheck(o.ref), true, "and it can be checked by hand"); });
  });
});

test("a secret is never stored or logged; a valid one keeps only its proof on the order", async () => {
  const S = newSecret(), logs = [];
  await copyRig(async (st) => { store.setLog((m) => logs.push(m));
    st.msg.push(sOrder(VICTIM, "ORD-N", 1009, "VICTIM", S)); st.pay.push(sPay("ORD-N", 1010, proofT(S), "0xFE40"));
    await walkTo(st, 1009, 1014); store.flush();
    assert.equal(store.order("ORD-N").commit, proofT(S)); assert.equal(store.order("ORD-N").paid, true);
    const disk = fs.readFileSync(path.join(DIR, "shop.json"), "utf8");
    for (const v of [S, S.toLowerCase(), S.slice(2), S.slice(2).toLowerCase()]) { assert.ok(!disk.includes(v), "not in shop.json"); assert.ok(!logs.join("\n").includes(v), "not logged"); }
    assert.ok(!JSON.stringify(shop.orderDetail("ORD-N")).includes(S.slice(2)), "not given to the screen"); });
});

test("two orders with one reference: different secrets are paid each by its own coins; the same buyer's order sent again is one order; the same proof from another buyer holds both; one without a secret is held, the other not", async () => {
  // different secrets: no holds, each paid by its own coin, a coin proving neither is noted once on the unpaid one, never counted
  await copyRig(async (st) => { const A = newSecret(), B = newSecret();
    st.msg.push(sOrder(VICTIM, "ORD-V", 1009, "VICTIM", A), sOrder(ATK, "ORD-V", 1010, "COPIER", B));
    st.pay.push(sPay("ORD-V", 1011, proofT(B), "0xFE50"), sPay("ORD-V", 1012, proofT(newSecret()), "0xFE51", "0.0002"), sPay("ORD-V", 1012, undefined, "0xFE52", "0.0001"), sPay("ORD-V", 1013, proofT(A), "0xFE53"));
    await walkTo(st, 1009, 1011);   // each coin is counted in the pass at its block (0.19.354): B's at 1011, the stray ones at 1012, A's at 1013
    assert.deepEqual(store.order("ORD-V").problems, []); assert.deepEqual(store.order("ORD-V~" + ATK).problems, [], "neither is held by the other");
    assert.equal(store.order("ORD-V~" + ATK).paid, true, "B paid by its own coin"); assert.equal(store.mayAdvance(store.order("ORD-V~" + ATK)), true, "and confirmable at once: its payment proves its secret");
    await walkTo(st, 1012, 1012);
    assert.deepEqual(store.order("ORD-V").problems, [NOPROOF("0xFE51")], "one problem on the unpaid order, the first coin's id whole, not one per coin");
    assert.deepEqual(store.order("ORD-V~" + ATK).problems, [], "an order already paid by its proof is not disturbed"); assert.equal(store.order("ORD-V~" + ATK).paid, true);
    await walkTo(st, 1013, 1016);
    const a2 = store.order("ORD-V"); assert.deepEqual(a2.coins, ["0xfe53"], "A's own coin counted on it, the stray ones on nothing"); assert.equal(a2.status, "UNCHECKED", "and held by the one problem");
    assert.equal(store.handCheck("ORD-V"), true); });
  // the same buyer's order sent again (the same secret): one order, paid once
  await copyRig(async (st) => { const A = newSecret();
    st.msg.push(sOrder(VICTIM, "ORD-V", 1011, "VICTIM", A), sOrder(VICTIM, "ORD-V", 1009, "VICTIM", A)); st.pay.push(sPay("ORD-V", 1010, proofT(A), "0xFE60"));
    await walkTo(st, 1011, 1016); const o = store.order("ORD-V");
    assert.equal(o.paid, true); assert.deepEqual(o.problems, []); assert.equal(store.order("ORD-V~" + VICTIM), null); assert.equal(o.orderBlock, 1009); });
  // the same proof from another buyer (the secret is known to someone else): both held, as orders that cannot be told apart
  await copyRig(async (st) => { const A = newSecret();
    st.msg.push(sOrder(VICTIM, "ORD-V", 1009, "VICTIM", A), sOrder(ATK, "ORD-V", 1010, "COPIER", A)); st.pay.push(sPay("ORD-V", 1011, proofT(A), "0xFE70"));
    await walkTo(st, 1009, 1016);
    for (const o of [store.order("ORD-V"), store.order("ORD-V~" + ATK)]) { assert.equal(o.problems[0], DUPV); assert.equal(o.paid, false); assert.equal(store.mayAdvance(o), false); } });
  // one without a secret (either first): it is held, the order with a secret is not, and each is paid only by its own kind of coin
  for (const first of ["secret", "none"]) await copyRig(async (st) => { const A = newSecret();
    st.msg.push(sOrder(VICTIM, "ORD-V", first === "secret" ? 1009 : 1010, "VICTIM", A), sOrder(ATK, "ORD-V", first === "secret" ? 1010 : 1009, "COPIER"));
    st.pay.push(sPay("ORD-V", 1011, proofT(A), "0xFE80"), sPay("ORD-V", 1011, undefined, "0xFE81"));
    await walkTo(st, 1009, 1015);
    const os = [store.order("ORD-V"), store.order("ORD-V~" + ATK), store.order("ORD-V~" + VICTIM)].filter(Boolean), v = os.find(o => o.delivery === "VICTIM"), c = os.find(o => o.delivery === "COPIER");
    assert.equal(v.paid, true, first + ": " + v.problems.join(" | ")); assert.deepEqual(v.coins, ["0xfe80"]);
    assert.equal(c.problems[0], DUPV, first); assert.equal(c.paid, false); assert.deepEqual(c.coins, ["0xfe81"], first + ": the coin without a proof is counted on the held order"); });
  // the sentences are read back in every language
  const MS = require("../renderer/mainsaid.js");
  assert.equal(MS.read(NOPROOF("0xFE51")).code, "SHOP_NO_PROOF"); assert.equal(MS.read(BADSECRET).code, "SHOP_BAD_SECRET");
});

// ---- 0.19.353 (as released 0.18.298): the desktop buyer sends the order's secret and proves it on every payment, as the phone Shop ----
test("buyer: the sealed order carries a fresh secret, both the payment and its Retry carry its proof in port 2, the secret is kept nowhere; a desktop vendor pays the order by that coin", async () => {
  const scx = require.cache[require.resolve("../main/shopcrypto.js")].exports, seal0 = scx.seal, logs = [];
  scx.seal = async (_id, _to, pt) => Buffer.from(pt).toString("hex");   // what was sealed, readable by the stand-in open
  try { await copyRig(async (st) => {
    store.setLog((m) => logs.push(m));
    const PAYTO = "0x" + "5A".repeat(32), VID = "0x" + "33".repeat(32), sends = []; let refuse = true; const run = javaNode(st);
    shop._setRunner(async (c) => { if (c.startsWith("send ")) { sends.push(c); if (refuse && c.includes("address:" + PAYTO)) return { status: false, error: "refused" }; } return run(c); });
    const cfg = { shopName: "Tea", shopId: "tea", vendorPublicId: VID, vendorAddress: PAYTO, currency: "Minima", tokenid: "0x00", products: [{ id: "p1", name: "Tea", price: "1.5" }], shipping: [] };
    const r = await shop.placeOrder(cfg, [{ product: "Tea", quantity: 1, unitPrice: "1.5", lineTotal: "1.5" }], "1.5", "Digital", "home", "");
    assert.equal(r.payError, "refused"); refuse = false; await shop.retryPayment(r.ref);
    const stateOf = (c) => JSON.parse(/ state:(\{[^ ]*\})/.exec(c)[1]);
    const orderSend = sends.find(c => c.includes("address:" + shop.MINIMERCH)), pays = sends.filter(c => c.includes("address:" + PAYTO));
    const w = JSON.parse(Buffer.from(stateOf(orderSend)["99"].slice(2), "hex").toString("utf8"));
    assert.match(w.nonce, /^0x[0-9A-F]{64}$/, "0x and 64 capital hexadecimal digits, as the phone's newNonce");
    assert.equal(pays.length, 2, "the refused payment and its Retry");
    for (const p of pays) assert.deepEqual(stateOf(p), { "1": hex(r.ref), "2": proofT(w.nonce) }, "port 1 the reference, port 2 the proof: " + p);
    const buy = store.order(r.ref); assert.equal(buy.commit, proofT(w.nonce)); store.flush();
    const disk = fs.readFileSync(path.join(DIR, "shop.json"), "utf8");
    for (const v of [w.nonce, w.nonce.slice(2), w.nonce.slice(2).toLowerCase()]) { assert.ok(!disk.includes(v), "the secret is not stored"); assert.ok(!logs.join("\n").includes(v), "nor logged"); assert.ok(!JSON.stringify(shop.orderDetail(r.ref)).includes(v), "nor given to the screen"); }
    await shop.placeOrder(cfg, [{ product: "Tea", quantity: 1, unitPrice: "1.5" }], "1.5", "Digital", "home", "");
    const w2 = JSON.parse(Buffer.from(stateOf(sends.filter(c => c.includes("address:" + shop.MINIMERCH))[1])["99"].slice(2), "hex").toString("utf8"));
    assert.notEqual(w2.nonce, w.nonce, "a second order: another secret");
    // an order placed before 0.19.353 (no proof kept): its Retry carries none, as its order carried no secret; a tampered proof sends nothing
    delete buy.commit; store.setMetaSync("unpaid:" + r.ref, true); sends.length = 0; await shop.retryPayment(r.ref);
    assert.deepEqual(stateOf(sends.find(c => c.includes("address:" + PAYTO))), { "1": hex(r.ref) });
    buy.commit = "0x12 tokenid:0xFF"; store.setMetaSync("unpaid:" + r.ref, true); sends.length = 0;
    await assert.rejects(shop.retryPayment(r.ref), /Invalid order proof/); assert.equal(sends.filter(c => c.includes("address:" + PAYTO)).length, 0, "nothing sent");
    // the same coins at a desktop vendor
    store.clear(); teaShop(); shop._setRunner(run);
    st.msg.push({ coinid: "0xAD01", created: 1009, state: stateOf(orderSend) }); st.pay.push({ coinid: "0xAD02", tokenid: "0x00", amount: "1.5", created: 1010, state: stateOf(pays[1]) });
    await walkTo(st, 1009, 1014);
    const o = store.order(r.ref); assert.ok(o, "the vendor holds the order"); assert.equal(o.commit, proofT(w.nonce)); assert.equal(o.paid, true, o.problems.join(" | ")); assert.equal(o.status, "PAID");
  }); } finally { scx.seal = seal0; }
  assert.equal(require("../renderer/mainsaid.js").read("Invalid order proof.").code, "SHOP_BAD_PROOF");
});

// ---- 0.19.354 (as released 0.18.300): the review's scenarios (review-desktop-r3 R1, R2, R2b, R4): a payment the vendor's own wallet spends after
// tip pb + 3 was never counted on 0.19.344 to 0.19.353. It is counted when first read, the order settles, and ends PAID and confirmable; at once
// for an order whose payment proves its secret ----
const rScen = async (name, kind, ob, steps) => copyRig(async (st) => {
  const S = newSecret(), ref = "ORD-" + name.toUpperCase();
  st.msg.push(sOrder(VICTIM, ref, ob, "VICTIM", kind === "secret" ? S : undefined)); const p = sPay(ref, 1010, kind === "secret" ? proofT(S) : undefined, "0xFD" + Buffer.from(name).toString("hex")); st.pay.push(p);
  await steps(st, p, ref);
  const o = store.order(ref); assert.equal(o.paid, true, name + " " + kind + ": " + o.problems.join(" | ")); assert.equal(o.status, "PAID"); assert.equal(o.paidAmount, "1.5"); assert.equal(store.mayAdvance(o), true, name + " " + kind + ": settled");
});
test("R1, R2, R2b, R4: a payment spent by the vendor's wallet after tip pb + 3 was counted when first read; the order ends PAID and confirmable", async () => {
  for (const kind of ["none", "secret"]) {
    await rScen("r1", kind, 1009, async (st, p) => { await walkTo(st, 1001, 1012); p.spent = true; jTip(st, 1014); await shop.scanOnce(); await walkTo(st, 1015, 1030); });
    await rScen("r2", kind, 1009, async (st, p) => { await walkTo(st, 1001, 1012); st.hook = (a) => (a === "M" ? "throw" : null); jTip(st, 1013); await shop.scanOnce(); st.hook = null; p.spent = true; await walkTo(st, 1014, 1030); });
    await rScen("r2b", kind, 1005, async (st, p, ref) => { await walkTo(st, 1001, 1007); st.hook = (a) => (a === "M" ? "throw" : null); await walkTo(st, 1008, 1015);
      const o = store.order(ref); assert.equal(o.paid, true, "counted during the failure"); assert.equal(store.mayAdvance(o), kind === "secret", kind === "secret" ? "proved: confirmable at once" : "not settled while no orders read succeeds");
      p.spent = true; await walkTo(st, 1016, 1020); st.hook = null; await walkTo(st, 1021, 1030); });
    await rScen("r4", kind, 1009, async (st, p, ref) => { await walkTo(st, 1001, 1011);
      st.hook = (a, d) => (a === "M" && d > 32 ? CAPPED : null); jTip(st, 1100); await shop.scanOnce();
      assert.equal(store.mayAdvance(store.order(ref)), kind === "secret", "a gap of unread orders above the coin: not settled (" + kind + ")");
      st.hook = null; p.spent = true; await walkTo(st, 1101, 1110); });
  }
});
// R3a (review-desktop-r3): away more than 1016 blocks, the real order just under the window's reach, the payment and a copier's order above it,
// the same pass's root orders read failing. Without a secret it is as released 0.18.286; with one it is closed.
test("R3a with a secret: the real order under the window's reach is paid by its proved coin once read; the copier's order above it never is", async () => {
  for (const atkSecret of [undefined, newSecret()]) await copyRig(async (st) => {
    const S = newSecret(), V = "0xFD3A";
    st.pay.push(sPay("ORD-V", 1077, proofT(S), V)); st.msg.push(sOrder(VICTIM, "ORD-V", 1075, "VICTIM", S), sOrder(ATK, "ORD-V", 1078, "COPIER", atkSecret));
    st.hook = (a, d) => (a === "M" && d > 1024 ? "throw" : null); jTip(st, 2100); await shop.scanOnce();
    const c = store.order("ORD-V"); assert.equal(c.delivery, "COPIER"); assert.equal(c.paid, false); assert.equal(store.mayAdvance(c), false, "the copier's order cannot be confirmed");
    st.hook = null; jTip(st, 2101); await shop.scanOnce();
    const v = store.order("ORD-V~" + VICTIM); assert.ok(v, "the real order is read"); assert.equal(v.paid, true); assert.equal(store.mayAdvance(v), true); assert.deepEqual(v.coins, [V.toLowerCase()]);
    assert.equal(store.order("ORD-V").paid, false); assert.ok(!(store.order("ORD-V").coins || []).length);
  });
});

// ---- 0.19.355 (as released 0.18.301): a tip that comes while a pass is running gets a pass of its own on the next poll ----
test("vendor: the poll: a new tip seen while a pass is running is not taken as scanned; the next poll scans it", async () => {
  await copyRig(async (st) => {
    const base = javaNode(st); let release, hold = null;
    shop._setRunner(async (c) => { if (hold && c.startsWith("coins address:" + shop.MINIMERCH)) await hold; return base(c); });
    jTip(st, 1001); hold = new Promise(r => { release = r; }); const running = shop._tick();
    await new Promise(r => setImmediate(r));   // the pass at 1001 is reading its orders
    jTip(st, 1002); await shop._tick();          // a poll during it
    hold = null; release(); await running;
    assert.equal(Number(store.getMeta("scanned_tip_block")), 1001, "the pass at 1001 finished");
    await shop._tick(); assert.equal(Number(store.getMeta("scanned_tip_block")), 1002, "the tip seen during it gets its pass");
  });
});
