// The tray apps (Phase 5a, 0.19.108+): their SCREENS were rebuilt to their originals in Pandamonium, their money was not.
// Each money action is run twice against a recording window.mcd: once as the screen it replaced made it (OLD below: the
// calls of renderer/app.js at 0.19.107, 4857309, copied out of their handlers) and once through the new screens' action
// (renderer/apps-act.js). The calls, their arguments and their order must be identical. Where a call was changed on
// purpose (the key export), the test says what changed. Nothing here reaches a node, Ethereum or the network.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const Act = require("../renderer/apps-act.js");
const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");

/** window.mcd as a recorder: a call with no planned answer throws, so nothing unplanned (and nothing real) is reached. */
function recorder(answers) {
  const log = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => {
    log.push([name, JSON.parse(JSON.stringify(args))]);
    if (!(name in answers)) return Promise.reject(new Error("unexpected call " + String(name)));
    const a = answers[name]; return Promise.resolve(typeof a === "function" ? a(...args) : a);
  } });
  return { api, log };
}
const both = async (answers, was, now) => { const a = recorder(answers), b = recorder(answers); await was(a.api); await now(b.api); assert.deepEqual(b.log, a.log); return b.log; };

// ---- ETH Wallet ----
const ME = "0xFA4E00000000000000000000000000000000FA4E", TO = "0xFA4E00000000000000000000000000000000BEEF", USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const FEES = { ok: true, sym: "ETH", fees: { low: { fee: "1", gwei: "1" }, med: { fee: "2", gwei: "2" }, high: { fee: "3", gwei: "3" } }, capped: false };
const OLD_ETH = {   // renderer/app.js 0.19.107: ewSendDialog, ewConfirmSend, ewAddTokenDialog, ewTokenMenu, ewRpcDialog
  max: (api, asset) => api.ewSendMax(asset).catch(() => null),
  review: (api, asset, toField, amtField) => api.ewSendReview(asset, toField.trim(), amtField.trim()).catch(e => ({ err: String(e.message || e) })),
  send: (api, asset, to, amt, tier) => api.ewSend(asset, to, amt, tier).catch(e => ({ err: String(e.message || e) })),
  addToken: (api, addr) => api.ewAddToken(String(addr).trim()).catch(e => ({ err: String(e.message || e) })),
  removeToken: (api, addr) => api.ewRemoveToken(addr).catch(() => {}),
  rpcDefault: (api) => api.ewSetRpc("").catch(e => ({ err: String(e.message || e) })),
  rpcSave: (api, field) => api.ewSetRpc(field.trim()).catch(e => ({ err: String(e.message || e) }))
};
for (const [asset, to, amt, tier] of [["eth", " " + TO + " ", " 0.01 ", "med"], [USDT, TO, "125.5", "high"], ["eth", TO, "0.000000000000000001", "low"]]) {
  test(`ETH Wallet send of ${amt.trim()} ${asset === "eth" ? "ETH" : "USDT"} (${tier}): review then send, the same calls as the old screen`, async () => {
    const log = await both({ ewSendReview: FEES, ewSend: { tx: "0xT" } },
      async (api) => { const r = await OLD_ETH.review(api, asset, to, amt); assert.ok(r.ok); await OLD_ETH.send(api, asset, to.trim(), amt.trim(), tier); },
      async (api) => { const r = await Act.eth.review(api, ME, asset, to, amt); assert.ok(r.ok); await Act.eth.send(api, asset, r.to, r.amt, tier); });
    assert.deepEqual(log, [["ewSendReview", [asset, TO, amt.trim()]], ["ewSend", [asset, TO, amt.trim(), tier]]], "the amount is the text typed, never a number");
  });
}
test("ETH Wallet: a refused review sends nothing; a send to the wallet's own address is refused before the main process is asked", async () => {
  const r = recorder({ ewSendReview: { err: "Not enough ETH for that amount plus network gas — try Max." } });
  assert.match((await Act.eth.review(r.api, ME, "eth", TO, "9")).err, /Not enough ETH/);
  assert.deepEqual(r.log.map(c => c[0]), ["ewSendReview"]);
  const own = recorder({});
  assert.equal((await Act.eth.review(own.api, ME, "eth", ME.toLowerCase(), "1")).err, "That's your own address");
  assert.deepEqual(own.log, []);
  const down = recorder({});   // the main process throws: an error to show, not a rejection that leaves the dialog dead
  assert.match((await Act.eth.review(down.api, ME, "eth", TO, "1")).err, /unexpected call/);
  assert.match((await Act.eth.send(down.api, "eth", TO, "1", "med")).err, /unexpected call/);
});
test("ETH Wallet: Max, add token, remove token and the RPC endpoint make the old screen's calls", async () => {
  await both({ ewSendMax: "0.04" }, (api) => OLD_ETH.max(api, "eth"), (api) => Act.eth.max(api, "eth"));
  await both({ ewSendMax: "125.5" }, (api) => OLD_ETH.max(api, USDT), (api) => Act.eth.max(api, USDT));
  await both({ ewAddToken: { token: { symbol: "X" } } }, (api) => OLD_ETH.addToken(api, " " + USDT + "\n"), (api) => Act.eth.addToken(api, " " + USDT + "\n"));
  await both({ ewRemoveToken: true }, (api) => OLD_ETH.removeToken(api, USDT), (api) => Act.eth.removeToken(api, USDT));
  await both({ ewSetRpc: { ok: true } }, (api) => OLD_ETH.rpcDefault(api), (api) => Act.eth.setRpc(api, ""));
  await both({ ewSetRpc: { ok: true } }, (api) => OLD_ETH.rpcSave(api, " https://rpc.example/ "), (api) => Act.eth.setRpc(api, " https://rpc.example/ "));
});
test("ETH Wallet: the key is asked for only with the typed phrase (CHANGED on purpose: the old screen asked with a click)", async () => {
  for (const typed of ["", "show key", "SHOW KEYS", "yes"]) { const r = recorder({ ewExportKey: "0xKEY" }); assert.ok((await Act.eth.exportKey(r.api, typed)).err); assert.deepEqual(r.log, [], JSON.stringify(typed) + " never reaches the main process"); }
  const r = recorder({ ewExportKey: "0xKEY" });
  assert.deepEqual(await Act.eth.exportKey(r.api, " SHOW KEY "), { key: "0xKEY" });
  assert.deepEqual(r.log, [["ewExportKey", ["SHOW KEY"]]]);
  const no = recorder({ ewExportKey: () => Promise.reject(new Error("Cancelled")) });
  assert.deepEqual(await Act.eth.exportKey(no.api, "SHOW KEY"), { err: "Cancelled" });
});
test("ETH Wallet, main process: no key without the phrase; the system's prompt is asked where there is one and its refusal ends it", async () => {
  const ethwallet = require("../main/ethwallet"), atomix = require("../main/atomix");
  const real = atomix.exportKey, realWork = atomix.activeWork; let asked = 0;
  atomix.exportKey = () => "0xKEY";
  try {
    await assert.rejects(ethwallet.exportKeyGated(undefined, null), /Type SHOW KEY/);
    await assert.rejects(ethwallet.exportKeyGated("show key", { can: () => true, prompt: async () => { asked++; } }), /Type SHOW KEY/);
    assert.equal(asked, 0, "the phrase is checked before anything is prompted");
    assert.equal(await ethwallet.exportKeyGated("SHOW KEY", { can: () => true, prompt: async () => { asked++; } }), "0xKEY");
    assert.equal(asked, 1);
    await assert.rejects(ethwallet.exportKeyGated("SHOW KEY", { can: () => true, prompt: async () => { throw new Error("user cancelled"); } }), /^Error: Cancelled$/);
    assert.equal(await ethwallet.exportKeyGated("SHOW KEY", { can: () => false, prompt: async () => { throw new Error("never"); } }), "0xKEY", "no system prompt on this machine: the typed phrase alone");
    assert.equal(await ethwallet.exportKeyGated("SHOW KEY", { can: () => { throw new Error("x"); }, prompt: async () => { throw new Error("never"); } }), "0xKEY");
    // swaps in flight on the same address, for the send review
    atomix.activeWork = async () => ({ ready: true, swaps: ["0xA", "0xB"] });
    assert.deepEqual(await ethwallet.swapsInFlight(), { known: true, swaps: ["0xA", "0xB"] });
    atomix.activeWork = async () => ({ ready: false, hasStore: true });
    assert.deepEqual(await ethwallet.swapsInFlight(), { known: false, swaps: [] }, "a store that cannot be read is never 'no swaps'");
    atomix.activeWork = async () => ({ ready: false, hasStore: true, swaps: ["0xC"] });
    assert.deepEqual(await ethwallet.swapsInFlight(), { known: true, swaps: ["0xC"] });
    atomix.activeWork = async () => ({ ready: false, hasStore: false });
    assert.deepEqual(await ethwallet.swapsInFlight(), { known: true, swaps: [] });
    atomix.activeWork = async () => { throw new Error("down"); };
    assert.deepEqual(await ethwallet.swapsInFlight(), { known: false, swaps: [] });
  } finally { atomix.exportKey = real; atomix.activeWork = realWork; }
  const mainJs = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(!/mcd:ewExportKey", \(\) => ethwallet\.exportKey\(\)/.test(mainJs) && /mcd:ewExportKey", \(_e, typed\) =>[^\n]*exportKeyGated\(typed/.test(mainJs), "the IPC handler is the gated one");
});
test("ETH Wallet screen: the original's settings, in its order; the swap warning; no import of another key; whole addresses", () => {
  const eth = app.slice(app.indexOf("// ============================ ETH Wallet"), app.indexOf("// ============================ miniMall"));
  assert.match(eth, /appPick\("Settings", \["Export private key", "RPC endpoint", "Add token", "View address on Etherscan", "View last transaction", "Switch wallet source"\]\)/);
  assert.ok(!/api\.ew(?:Send|SendReview|SendMax|ExportKey|AddToken|RemoveToken|SetRpc)\(/.test(eth), "every money and key call of the screen goes through AppsAct.eth");
  assert.ok(!/importKey|Import private key/.test(eth), "no key import on the desktop");
  assert.ok(!/shortAddr|\.slice\(0, ?6\) ?\+ ?"…"/.test(eth), "no shortened address");
  const warn = new Function("return " + eth.slice(eth.indexOf("function ewSwapWarning"), eth.indexOf("// Confirm: the three fee tiers")).replace("function ewSwapWarning", "function"))();
  assert.equal(warn({ known: true, swaps: [] }), "");
  assert.match(warn({ known: true, swaps: ["0xA"] }), /^⚠ 1 swap of Dexicon ① MxUSD is in flight\. It signs with this same address and needs ETH here for gas/);
  assert.match(warn({ known: true, swaps: ["0xA", "0xB"] }), /^⚠ 2 swaps of Dexicon ① MxUSD are in flight\. They sign/);
  assert.match(warn(null), /^⚠ Could not check/); assert.match(warn({ known: false, swaps: [] }), /^⚠ Could not check/);
});

// ---- Minima Vestr ----
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", COIN = "0x" + "A1".repeat(32), BEN = "0x" + "FA4E".repeat(16);
const OLD_VESTR = {   // renderer/app.js 0.19.107: vestrDoCreate and vestrDoCollect (their two checks, the confirm, the call)
  create: async (api, confirm, fld) => {
    const opts = { tokenid: fld.tokenid, amount: (fld.amount || "").trim(), beneficiary: (fld.beneficiary || "").trim(), startMs: fld.startMs, endMs: fld.endMs,
      graceHours: Number(fld.graceHours) || 0, burn: (fld.burn || "0").trim(), password: (fld.password || "") };
    if (!(Number(opts.amount) > 0)) return; if (!opts.beneficiary) return;
    if (!confirm) return;
    await api.vestrCreate(opts).catch(() => {});
  },
  collect: (api, coinid, feeField) => api.vestrCollect(coinid, feeField || "0").catch(() => {})
};
// The one argument changed on purpose (0.19.109): no fee is "" where the old screen sent "0", which the main process refuses.
const noFee = (log) => log.map(([n, a]) => (n === "vestrCreate" ? [n, [Object.assign({}, a[0], { burn: a[0].burn === "0" ? "" : a[0].burn })]] : n === "vestrCollect" ? [n, [a[0], a[1] === "0" ? "" : a[1]]] : [n, a]));
const bothV = async (answers, was, now) => { const a = recorder(answers), b = recorder(answers); await was(a.api); await now(b.api); assert.deepEqual(b.log, noFee(a.log)); return b.log; };
const T0 = 1800000000000, FORM = { tokenid: MXUSD, amount: " 250.5 ", beneficiary: " " + BEN + " ", startMs: T0 + 86400000, endMs: T0 + 90 * 86400000, graceHours: "168", burn: "", password: "" };
for (const [name, patch] of [["a token, weekly", {}], ["MINIMA with a burn and the vault password", { tokenid: "0x00", burn: "0.01", password: "pw" }], ["no grace", { graceHours: "0" }], ["an amount of 44 decimals, as typed", { amount: "0.00000000000000000000000000000000000000000001" }]]) {
  for (const confirm of [true, false]) test(`Vestr create, ${name}, review ${confirm ? "accepted" : "closed"}: the same call with the same arguments as the old screen`, async () => {
    const f = Object.assign({}, FORM, patch);
    assert.equal(Act.vestr.createProblem(f, T0), "");
    const log = await bothV({ vestrCreate: { ok: true, uid: "0xU" } }, (api) => OLD_VESTR.create(api, confirm, f),
      async (api) => { const r = await Act.vestr.create(api, { confirm: async () => confirm }, f, "MxUSD", "Weekly"); assert.deepEqual(r, confirm ? { ok: true } : { cancelled: true }); });
    assert.equal(log.length, confirm ? 1 : 0);
    if (confirm) assert.equal(typeof log[0][1][0].amount, "string", "the amount is the text typed");
  });
}
test("Vestr create: the review shows the withdrawal address whole; what the original refuses is refused before the node is asked", async () => {
  let said = null; const r = recorder({});
  await Act.vestr.create(r.api, { confirm: async (t, m) => { said = m; return false; } }, FORM, "MxUSD", "Weekly");
  assert.ok(said.includes("\n" + BEN + "\n") && said.includes("Lock 250.5 MxUSD") && /cannot be cancelled/.test(said));
  const p = (patch) => Act.vestr.createProblem(Object.assign({}, FORM, patch), T0);
  assert.equal(p({ beneficiary: " " }), "Enter a valid withdrawal address.");
  assert.equal(p({ amount: "1,5" }), "Enter a valid amount."); assert.equal(p({ amount: "1e3" }), "Enter a valid amount."); assert.equal(p({ amount: "" }), "Enter a valid amount.");
  assert.equal(p({ amount: "0.000" }), "Amount must be greater than zero.");
  assert.equal(p({ startMs: NaN }), "Pick a start date."); assert.equal(p({ endMs: NaN }), "Pick an end date.");
  assert.equal(p({ startMs: T0 - 1 }), "Start must be in the future."); assert.equal(p({ endMs: FORM.startMs }), "End must be after the start.");
  const down = recorder({});
  assert.match((await Act.vestr.create(down.api, { confirm: async () => true }, FORM, "MxUSD", "Weekly")).err, /unexpected call/);
});
test("Vestr collect: the same call as the old screen, with and without a fee", async () => {
  for (const fee of ["", "0", "0.01", "abc"]) await bothV({ vestrCollect: { ok: true, collected: "12.5", tokenid: "0x00" } }, (api) => OLD_VESTR.collect(api, COIN, fee), (api) => Act.vestr.collect(api, COIN, fee));
  assert.match((await Act.vestr.collect(recorder({}).api, COIN, "")).err, /unexpected call/);
});
test("Vestr, main process (untouched): the collect commands, in order; which of them wait in the signing queue; all pass the coin guard as they are", async () => {
  const vestr = require("../main/vestr"), { SIGNING } = require("../main/noderun"), { createRegistry } = require("../main/reserve");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "vestr.js"), "utf8");
  assert.equal(require("crypto").createHash("sha256").update(vestr.CLEAN_SCRIPT).digest("hex"), "ec2dfe508c24ea1c46431a3629ac391ffdeb03f8bcb7c107d52e004b48f6fb11", "the covenant text");
  assert.equal(vestr.CONTRACT, "0x3C432D5099AB27EA901079EF54D9A97AB4DB3BD1CFFF670296C31B7C83C1C8BE");
  assert.equal(require("crypto").createHash("sha256").update(src).digest("hex"), "97dd6d2f377ffe6af20f6dc04189087a452c1ddfca30848c4121283e94422b92", "main/vestr.js is the file of 0.19.107: this phase changed screens only");
  const state = [[0, BEN], [1, "1000"], [2, "2400000"], [3, "2555520"], [4, "1728"], [5, "1"], [6, "2"], [7, "24"], [8, "3"], [199, "0xUID"]].map(([port, data]) => ({ port, data }));
  const reg = createRegistry({ now: () => 1e12, log: () => {}, sends: "enforce" });
  // another owner holds an unrelated wallet coin: the guard is awake, and still passes every Vestr command unchanged
  await reg.guard("atomix", "txncreate id:ax1", async () => ({ status: true })); await reg.guard("atomix", "txninput id:ax1 coinid:0x" + "77".repeat(32), async () => ({ status: true, response: {} }));
  const run = async (burn) => {
    const sent = [];
    vestr._setRunner((cmd) => reg.guard("", cmd, async (c) => {
      sent.push(c);
      if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
      if (c.startsWith("coins coinid:")) return { status: true, response: [{ coinid: COIN, tokenid: "0x00", amount: "875.5", created: "2400100", address: vestr.CONTRACT, state }] };
      if (c === "block") return { status: true, response: { block: "2428094" } };
      if (c.startsWith("runscript")) return { status: true, response: { variables: { cancollect: "12.5", change: "863" } } };
      return { status: true, response: {} };
    }));
    const r = await vestr.collect(COIN, burn);
    assert.deepEqual(r, { ok: true, collected: "12.5", tokenid: "0x00" });
    return sent.filter(c => /^txn/.test(c));
  };
  const plain = await run(""), id = /^txncreate id:(vc\d+)$/.exec(plain[0])[1];
  await assert.rejects(vestr.collect(COIN, "0"), /Invalid burn amount/, "what the old screen sent when the fee was left alone: refused, so nothing was collected");
  assert.deepEqual(plain, ["txncreate id:" + id, "txninput id:" + id + " coinid:" + COIN + " scriptmmr:true",
    "txnoutput id:" + id + " address:" + BEN + " amount:12.5 tokenid:0x00 storestate:false", "txnoutput id:" + id + " address:" + vestr.CONTRACT + " amount:863 tokenid:0x00 storestate:true",
    ...state.map(s => "txnstate id:" + id + " port:" + s.port + " value:" + s.data), "txnpost id:" + id, "txndelete id:" + id]);
  assert.deepEqual(plain.filter(c => SIGNING.test(c)), [], "a collect with no fee signs nothing (the covenant needs no signature): nothing waits in the signing queue");
  const burned = await run("0.01");
  assert.deepEqual(burned.filter(c => SIGNING.test(c)).map(c => c.replace(/vc\d+/, "ID")), ["txnpost id:ID burn:0.01"], "a fee is a signed burn: that post is queued behind every other signer");
  assert.ok(burned[burned.length - 1].startsWith("txndelete id:"), "txndelete runs after the post, as on every path");
  vestr._setRunner(() => { throw new Error("no node in a test"); });
});

// ---- miniMall ----
const SHOPCFG = { shopName: "Zebra", shopId: "zebra", vendorPublicId: "0x" + "5A".repeat(32), vendorAddress: "MxG0VENDOR", currency: "USDT", tokenid: MXUSD,
  shipping: [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "2.5" }, { id: "international", label: "International", fee: "6" }],
  products: [{ id: "p1", name: "Mug", price: "12.5", maxUnits: "5" }, { id: "p2", name: "Print", price: "0.1", maxUnits: "9" }, { id: "p3", name: "Pin", price: "0.0000004", maxUnits: "9" }, { id: "p4", name: "Card", price: "0.000004", maxUnits: "9" }] };
const OLD_SHOP = {   // renderer/app.js 0.19.107: shopCartTotal, shopSelectedShipping, shopDoPay, the order screen's three handlers, the Studio's save
  ship: (s, shipId) => { if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(x => x.id === shipId) || s.shipping[0]; },
  total: (s, cart, shipId) => { let t = 0; for (const p of (s.products || [])) { const q = cart[p.id] || 0; if (q) t += q * Number(p.price); } const ship = OLD_SHOP.ship(s, shipId); if (ship) t += Number(ship.fee) || 0; return t; },
  pay: async (api, s, cart, shipId, deliveryField, noteField) => {
    const items = (s.products || []).filter(p => cart[p.id]).map(p => ({ product: p.name, quantity: cart[p.id], unitPrice: String(p.price), lineTotal: (cart[p.id] * Number(p.price)).toFixed(6) }));
    if (!items.length) return;
    const ship = OLD_SHOP.ship(s, shipId), total = OLD_SHOP.total(s, cart, shipId).toFixed(6);
    await api.shopPlaceOrder(s, items, total, ship ? ship.label : "", deliveryField.trim() || "", noteField.trim() || "").catch(() => {});
  },
  advanceRow: (o) => { if (o.status === "INQUIRY") return null; if (!o.paid) return null; const flow = ["CONFIRMED", "SHIPPED", "DELIVERED"], rank = { PAID: -1, CONFIRMED: 0, SHIPPED: 1, DELIVERED: 2 }; const cur = rank[o.status] != null ? rank[o.status] : -1; return flow[cur + 1] || null; },
  slug: (s) => String(s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop",
  std: () => [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0" }, { id: "international", label: "International", fee: "0" }],
  norm: (list) => { const by = {}; (list || []).forEach(s => { if (s && s.id) by[s.id] = s; }); return OLD_SHOP.std().map(std => ({ id: std.id, label: std.label, fee: std.id === "digital" ? "0" : String((by[std.id] && by[std.id].fee) || "0") })); },
  save: async (api, d) => {
    if (!d.shopName) return; if (!d.products.length) return;
    const cfg = { shopName: d.shopName, shopId: d.shopId || OLD_SHOP.slug(d.shopName), vendorPublicId: d.vendorPublicId, vendorAddress: d.vendorAddress,
      currency: d.currency, tokenid: d.currency === "Minima" ? "0x00" : "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", shipping: OLD_SHOP.norm(d.shipping),
      products: d.products.filter(p => p.name && Number(p.price) > 0).map(p => ({ id: p.id, name: p.name, description: p.description || "", mode: "units", price: String(p.price), maxUnits: String(Number(p.maxUnits) || 10), image: p.image || "" })) };
    await api.shopSave(cfg);
    if (!d.shopId) await api.shopExport(JSON.stringify(cfg, null, 2), cfg.shopId);
  }
};
for (const [name, cart, shipId] of [["one item, the first delivery method", { p1: 1 }, null], ["three lines, international", { p1: 2, p2: 3, p4: 7 }, "international"], ["a method the shop does not have", { p2: 1 }, "moon"], ["an empty cart", {}, null]]) {
  test(`miniMall checkout, ${name}: the order, its lines and its total are the old screen's, to the last digit`, async () => {
    const log = await both({ shopPlaceOrder: { ref: "ORD-1", payError: null } }, (api) => OLD_SHOP.pay(api, SHOPCFG, cart, shipId, " 1 Street ", " hello "),
      async (api) => { await Act.shop.place(api, { confirm: async () => true }, SHOPCFG, cart, shipId, " 1 Street ", " hello "); });
    if (Object.keys(cart).length) { assert.equal(log.length, 1); assert.equal(typeof log[0][1][2], "string", "the total is text"); assert.equal(log[0][1][0].currency, "USDT", "the wire value of the currency is untouched"); }
    else assert.deepEqual(log, []);
  });
}
test("miniMall checkout: the original's question comes first and names MxUSD; Back sends nothing; no delivery address, no order", async () => {
  let asked = null; const r = recorder({ shopPlaceOrder: { ref: "ORD-1" } });
  assert.deepEqual(await Act.shop.place(r.api, { confirm: async (t, m) => { asked = [t, m]; return false; } }, SHOPCFG, { p1: 2 }, "domestic", "1 Street", ""), { cancelled: true });
  assert.deepEqual(asked, ["Pay 27.500000 MxUSD?", "This sends your encrypted order to Zebra and pays 27.500000 MxUSD. Payment is final."
    + "\n\nAmount sent\n27.500000\n\nToken: MxUSD\n0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90\n\nVendor's payment address\nMxG0VENDOR"]);   // 0.19.118: what is sent, in which token and to whom, each whole on its own line
  assert.deepEqual(r.log, []);
  const none = await Act.shop.place(r.api, { confirm: async () => { throw new Error("never asked"); } }, SHOPCFG, { p1: 2 }, null, "  ", "");
  assert.deepEqual(none, { err: "Add a delivery address.", refused: true });   // the original refuses this; the old desktop screen sent it
  assert.deepEqual(r.log, []);
  assert.match((await Act.shop.place(recorder({}).api, { confirm: async () => true }, SHOPCFG, { p1: 1 }, null, "x", "")).err, /unexpected call/);
  assert.equal(Act.shop.cur("USDT"), "MxUSD"); assert.equal(Act.shop.cur("mxUSDT"), "MxUSD"); assert.equal(Act.shop.cur("Minima"), "Minima");
});
test("miniMall orders: a vendor may set exactly the status the old screen offered; retry, reply and advance make its calls", async () => {
  for (const status of ["INQUIRY", "PENDING", "PAID", "CONFIRMED", "SHIPPED", "DELIVERED", "UNDERPAID"]) for (const paid of [true, false])
    assert.equal(Act.shop.nextStatus({ status, paid }), OLD_SHOP.advanceRow({ status, paid }), status + (paid ? " paid" : " unpaid"));
  await both({ shopAdvance: { ok: true } }, (api) => api.shopAdvance("ORD-1", "CONFIRMED"), (api) => Act.shop.advance(api, "ORD-1", "CONFIRMED"));
  await both({ shopRetryPay: {} }, (api) => api.shopRetryPay("ORD-1"), (api) => Act.shop.retryPay(api, "ORD-1"));
  await both({ shopReply: { ok: true } }, async (api) => { const t = " hi ".trim(); if (t) await api.shopReply("ORD-1", t); }, (api) => Act.shop.reply(api, "ORD-1", " hi "));
  const r = recorder({}); assert.equal(await Act.shop.reply(r.api, "ORD-1", "   "), null); assert.deepEqual(r.log, []);
  assert.match((await Act.shop.retryPay(recorder({ shopRetryPay: () => Promise.reject(new Error("That payment may already have been sent")) }).api, "ORD-1")).err, /may already have been sent/);
});
test("miniMall Studio: the .shop saved and exported is the old screen's, byte for byte", async () => {
  const draft = (patch) => Object.assign({ shopName: "Zebra Gallery!", currency: "USDT", vendorPublicId: "0x5A", vendorAddress: "MxV", shipping: [{ id: "domestic", label: "x", fee: "2.5" }, { id: "digital", label: "Digital", fee: "9" }],
    products: [{ id: "p1", name: "Mug", description: "", price: "12.5", maxUnits: "", image: "" }, { id: "p2", name: "", price: "3", maxUnits: "2" }, { id: "p3", name: "Free", price: "0", maxUnits: "2" }] }, patch);
  for (const patch of [{}, { shopId: "zebra", currency: "Minima" }, { shopName: "" }, { products: [] }])
    await both({ shopSave: (c) => c, shopExport: "/tmp/x.shop" }, (api) => OLD_SHOP.save(api, draft(patch)), (api) => Act.shop.save(api, draft(patch)));
  assert.equal(Act.shop.cfgOf(draft({})).tokenid, MXUSD); assert.equal(Act.shop.cfgOf(draft({})).currency, "USDT");
});
test("miniMall screens: MxUSD on every label, the vendor's key whole, every money call through AppsAct.shop; the store file is not the screens' to change", () => {
  const mall = app.slice(app.indexOf("// ============================ miniMall"), app.indexOf("function shopResizeImage"));
  assert.ok(!/api\.shop(?:PlaceOrder|RetryPay|Advance|Reply|Save)\(/.test(mall), "no direct money call in the screens");
  assert.ok(!/>\s*(?:mx)?USDT\s*</i.test(mall) && !/mxUSDT/.test(mall), "no USDT label");
  assert.ok(/data-cur="USDT"[^>]*>MxUSD</.test(mall), "Studio's 'Pays in' offers MxUSD and keeps the wire value");
  assert.ok(!/vendorPublicId \|\| ""\)\.slice/.test(mall), "the vendor card is whole (it was cut to 18 characters)");
  assert.match(mall, /idHtml\(shopIdentity\.publicId\)/);
  const sha = (f) => require("crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", f))).digest("hex");
  // main/shop.js was CHANGED ON PURPOSE in 0.19.118 (the token paid follows the currency; a mismatching tokenid is refused; plain amounts): the pin is the new file's
  for (const [f, want] of [["main/shop.js","d90041499905001e1565c0bd60ed86b5042770cfadf5fc5eff7b2f81d832123c"],["main/shop-store.js","75b6697ef20a1f340638900bed90421e612b8c0f733a7d3719344b58d3cb50d0"],["main/shopcrypto.js","a486120e618622ba75f4d6360428badb4a95504329bef0a031f9805c0cd72aec"]]) assert.equal(sha(f), want, f + (f === "main/shop.js" ? " is the file of 0.19.118" : " is the file of 0.19.107"));
});

// 0.19.118: the token paid, the pictures and the figures of a vendor's .shop
const shopOf = (patch) => Object.assign(JSON.parse(JSON.stringify(SHOPCFG)), patch);
test("miniMall: a shop labelled Minima that carries the MxUSD token id is refused before the question, and never reaches the main process", async () => {
  for (const [patch, why] of [[{ currency: "Minima" }, /says it is paid in Minima but names another token \(0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90\)/],
    [{ currency: "USDT", tokenid: "0x00" }, /says it is paid in MxUSD but names another token \(0x00\)/], [{ currency: "MxUSD" }, /pays shops in Minima or MxUSD only/], [{ currency: "DOGE", tokenid: "0x00" }, /Minima or MxUSD only/], [{ currency: undefined }, /Minima or MxUSD only/]]) {
    const r = recorder({ shopPlaceOrder: { ref: "ORD-1" } });
    const out = await Act.shop.place(r.api, { confirm: async () => { throw new Error("the question must not be asked"); } }, shopOf(patch), { p1: 1 }, null, "1 Street", "");
    assert.match(out.err, why); assert.equal(out.refused, true); assert.deepEqual(r.log, []);
    assert.match(Act.shop.problem(shopOf(patch)), why, "and the same reason when the file is added or the shop opened");
  }
  // the id is compared as hex, whatever its case; no tokenid at all is the currency's token
  assert.deepEqual(Act.shop.token(shopOf({ tokenid: MXUSD.toLowerCase() })), { tokenid: MXUSD, name: "MxUSD" });
  assert.deepEqual(Act.shop.token(shopOf({ currency: "mxUSDT", tokenid: "" })), { tokenid: MXUSD, name: "MxUSD" });
  assert.deepEqual(Act.shop.token({ currency: "Minima" }), { tokenid: "0x00", name: "Minima" });
  let asked = null; await Act.shop.place(recorder({}).api, { confirm: async (t, m) => { asked = m; return false; } }, shopOf({ currency: "Minima", tokenid: "0x00", vendorAddress: "MxG0" + "A".repeat(56) }), { p1: 1 }, null, "x", "");
  assert.ok(asked.endsWith("\n\nAmount sent\n12.500000\n\nToken: Minima\n0x00\n\nVendor's payment address\nMxG0" + "A".repeat(56)), "the address whole, on its own line");
});
test("miniMall: prices, fees and quantities are plain figures; totals are exact (BigInt), six decimals as before and never rounded", async () => {
  for (const bad of ["-1", "1e3", "0x10", "1,5", " 1", "1.", ".5", "", null, 1e21, "1." + "0".repeat(45)]) assert.match(Act.shop.problem(shopOf({ products: [{ id: "p1", name: "Mug", price: bad }] })), /not a plain number/, String(bad));
  assert.match(Act.shop.problem(shopOf({ shipping: [{ id: "d", label: "Post", fee: "-2" }] })), /fee of the delivery method "Post" is not a plain number/);
  assert.match(Act.shop.problem(shopOf({ products: [{ id: "p1", name: "Mug", price: "1", maxUnits: "2.5" }] })), /stock/);
  for (const q of [-1, 1.5, "2", 2 ** 60]) assert.match(Act.shop.totals(SHOPCFG, { p1: q }, null).err || "", /quantity of "Mug" is not a whole number above zero/, String(q));
  // the old screen rounded through a floating-point number: 7 x 0.0000004 = 0.0000028 was sent as 0.000003
  let sent = null; const r = recorder({ shopPlaceOrder: (...a) => { sent = a; return { ref: "ORD-1" }; } }); let asked = null;
  await Act.shop.place(r.api, { confirm: async (t) => { asked = t; return true; } }, SHOPCFG, { p1: 2, p3: 7 }, "international", "x", "");
  assert.equal(sent[2], "31.0000028"); assert.equal(asked, "Pay 31.0000028 MxUSD?", "the figure in the question is the figure sent");
  assert.deepEqual(sent[1].map(i => i.lineTotal), ["25.0000000", "0.0000028"]);
  // exact where a double is not: 3 x 0.1, and a figure past 2^53
  assert.equal(Act.shop.totals(SHOPCFG, { p2: 3 }, null).total, "0.300000");
  assert.equal(Act.shop.totals(shopOf({ shipping: [], products: [{ id: "a", name: "A", price: "9007199254740993.000001" }] }), { a: 3 }, null).total, "27021597764222979.000003");
  assert.equal(Act.shop.totals(shopOf({ shipping: [], products: [{ id: "a", name: "A", price: "0" }] }), { a: 1 }, null).zero, true);
  assert.deepEqual(await Act.shop.place(recorder({}).api, { confirm: async () => true }, shopOf({ shipping: [], products: [{ id: "a", name: "A", price: "0" }] }), { a: 1 }, null, "x", ""), { err: "The total is zero. Nothing was sent.", refused: true });
  // Studio refuses to write what a buyer's side would refuse
  const d = { shopName: "S", currency: "USDT", vendorPublicId: "0x5A", vendorAddress: "MxV", shipping: [{ id: "domestic", label: "Domestic", fee: "abc" }], products: [{ id: "p1", name: "Mug", price: "1" }] }, st = recorder({ shopSave: (c) => c });
  assert.match((await Act.shop.save(st.api, d)).err, /fee of the delivery method/); assert.deepEqual(st.log, []);
  assert.match((await Act.shop.save(st.api, Object.assign({}, d, { shipping: [], products: [{ id: "p1", name: "Mug", price: "1e3" }] }))).err, /not a plain number/); assert.deepEqual(st.log, []);
});
test("miniMall: a product picture is an inline picture or nothing, in the file and on every screen", () => {
  const ok = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(Act.shop.image(ok), ok); assert.equal(Act.shop.image("data:image/webp;base64,UklGRg"), "data:image/webp;base64,UklGRg");
  for (const bad of ["file://evil.example/share/x.png", "\\\\evil\\share\\x.png", "https://example.com/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "data:image/png;base64,AAAA\" onerror=\"x", "data:image/png,AAAA", "/9j/4AAQ", "", null, 5, {}])
    assert.equal(Act.shop.image(bad), "", String(bad));
  const mall = app.slice(app.indexOf("// ============================ miniMall"), app.indexOf("function shopResizeImage"));
  assert.ok(!/src="\$\{esc\(p\.image\)\}"/.test(mall), "no screen puts a file's picture URL into the page as it came");
  assert.equal((mall.match(/src="\$\{esc\(SHOP\.image\(p\.image\)\)\}"/g) || []).length, 4);
  assert.match(mall, /const why = SHOP\.problem\(cfg\); if \(why\)/, "an added file is checked");
  assert.match(mall, /const open = \(s\) => \{ const why = SHOP\.problem\(s\); if \(why\)/, "and so is every shop that is opened");
  assert.match(mall, /class="mm-payq"/); assert.match(fs.readFileSync(path.join(__dirname, "..", "renderer", "apps.css"), "utf8"), /\.mm-payq \{ white-space: pre-line; overflow-wrap: anywhere;/);
});

// ---- Web Wallet ----
const OLD_WW = {   // renderer/app.js 0.19.107: wwDoSend (its two checks, then the one call; the two-click arming is the screen's)
  send: async (api, seed, toField, amtField, tokenid) => {
    const to = String(toField || "").trim(), amount = String(amtField || "").trim();
    if (!to) return; if (!(Number(amount) > 0)) return;
    await api.wwSend({ seed, to, amount, tokenid }).catch(() => {});
  }
};
test("Web Wallet send: the same call with the same arguments as the old screen; nothing is sent for an empty address or amount", async () => {
  for (const [to, amt, tok] of [[" MxG0ABC ", " 12.5 ", "0x00"], ["0xAB", "0.00000001", MXUSD], ["", "1", "0x00"], ["MxG0ABC", "0", "0x00"], ["MxG0ABC", "abc", "0x00"]]) {
    await both({ wwSend: { ok: true, txnid: "0xT" } }, (api) => OLD_WW.send(api, "my Phrase - Exactly", to, amt, tok),
      async (api) => { const f = { seed: "my Phrase - Exactly", to, amount: amt, tokenid: tok }; if (!Act.ww.problem(f)) await Act.ww.send(api, f); });
  }
  const r = recorder({ wwSend: { ok: true } }); await Act.ww.send(r.api, { seed: " Keep  My Spaces ", to: "MxA", amount: "1", tokenid: "0x00" });
  assert.equal(r.log[0][1][0].seed, " Keep  My Spaces ", "the phrase goes to the main process exactly as it is held");
  assert.deepEqual(await Act.ww.send(recorder({ wwSend: () => Promise.reject(new Error("Confirm this wallet's key-uses count before sending")) }).api, { seed: "s", to: "MxA", amount: "1", tokenid: "0x00" }), { message: "Confirm this wallet's key-uses count before sending" });
});
test("Web Wallet screen: the original's look with every desktop safeguard, and nothing that keeps a seed", () => {
  const ww = app.slice(app.indexOf("// ===================== Web Wallet"), app.indexOf("function renderActive() {"));
  for (const must of ["Never type your secret key into a website Web Wallet", "A -megammr node is required to use this Wallet.", "Confirm the secret key uses before sending.", "Check on-chain", "wwArmed = true", "The last send's status is UNKNOWN", "I've checked",
    "Search tokens", "No results found", "Log out of this session", "Enter recipient address (Mx or 0x)", ">Balance<" , "Secret key uses"]) assert.ok(ww.includes(must) || ww.includes(must.replace(/[<>]/g, "")), "kept or added: " + must);
  assert.ok(!/Remember me|rememberme|Generate secret key/i.test(ww.replace(/\/\/[^\n]*/g, "")), "no Remember me, no key generation");
  assert.ok(!/localStorage|sessionStorage|store\(|document\.cookie|api\.saveConfig/.test(ww), "the screen stores nothing: the seed lives in memory until Logout");
  assert.ok(/function wwLock\(\) \{ wwSeed = null;/.test(ww), "Logout clears the seed");
  assert.ok(!/api\.wwSend\(/.test(ww), "the send goes through AppsAct.ww");
  assert.equal(require("crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "main", "webwallet.js"))).digest("hex"), "e8957bd3b8cdbd8f7d0c7653e4addb45f8ed1da0a04cb32acda873c0d0023252", "main/webwallet.js is the file of 0.19.107");
});

// ---- Minima Faucet ----
test("Faucet screen: the original's one screen; the request is still main/faucet.js's, to its one pinned host, with a checked address", () => {
  const fc = app.slice(app.indexOf("// ---- Minima Faucet"), app.indexOf("// Settings: what is the desktop's own"));
  for (const must of ["MINIMA FAUCET", "Get Free Minima", "Receive 0.0001 Minima to try out the blockchain.", "Minima Address", "Paste or fetch an address…", "Get My Address", "Request Minima",
    "The faucet sends a tiny amount of Minima to your node so you can try creating custom tokens and testing transactions.", "eurobuddha · Minima Ecosystem", "Please enter a Minima address."]) assert.ok(fc.includes(must), must);
  assert.ok(fc.indexOf("validAddr(addr)") < fc.indexOf("api.faucet(addr)") && fc.indexOf("validAddr(addr)") > 0, "the address is checked before the request");
  assert.equal((fc.match(/api\.faucet\(/g) || []).length, 1);
  assert.equal(require("crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "main", "faucet.js"))).digest("hex"), "5b5e03a513e99a5743c0efa159dccb0a7763af8cfea989c3105fae061f9549ce", "main/faucet.js is the file of 0.19.107");
});
