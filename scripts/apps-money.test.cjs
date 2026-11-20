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
