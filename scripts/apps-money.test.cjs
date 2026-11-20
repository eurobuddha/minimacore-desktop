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
