/*
 * payverify-test.cjs — a payment MESSAGE is its sender's claim (0.19.7): the currency is named from the token id
 * only, and a received payment says "received" only after this node found it on chain paying this wallet.
 * The node here is a recorded one (a function); nothing outside the process is reached.
 * Run: node --test scripts/payverify-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const reach = require("./no-reach.cjs").install();
const L = require("../renderer/paylabel.js");
const V = require("../main/payverify.js");
test.after(() => assert.deepEqual(reach.reached, [], "nothing outside the process was reached"));

const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const FAKE = "0x" + "BADC0FFEE0".repeat(6) + "ABCD";                 // a token somebody made and NAMED "MxUSD"
const TXID = "0x0000" + "5E".repeat(30), MINE = "0x" + "A1".repeat(32), MINE2 = "0x" + "A2".repeat(32), THEIRS = "0x" + "B0".repeat(32);
const out = (address, tokenid, amount) => tokenid === "0x00" ? { address, tokenid, amount } : { address, tokenid, amount: "1", tokenamount: amount, token: { name: { name: "MxUSD" } } };
/** A recorded node: which txpows are on chain, their outputs, and which addresses are this wallet's. */
function nodeWith({ onchain = [TXID], outputs = [], mine = [MINE, MINE2], fail = "" } = {}) {
  const asked = [];
  const run = async (cmd) => {
    asked.push(cmd);
    if (fail && cmd.startsWith(fail)) throw new Error("node did not answer");
    const [c, arg] = cmd.split(" ");
    if (c === "txpow" && arg.startsWith("onchain:")) return onchain.includes(arg.slice(8)) ? { status: true, response: { found: true, block: "100" } } : { status: true, response: { found: false } };
    if (c === "txpow" && arg.startsWith("txpowid:")) return { status: true, response: { txpowid: arg.slice(8), body: { txn: { outputs } } } };
    if (c === "checkaddress") return { status: true, response: { relevant: mine.includes(arg.slice(8)), simple: true } };
    return { status: false, error: "unexpected: " + cmd };
  };
  return { run, asked };
}

test("the currency is named from the token id only; another token is never given the sender's name for it", () => {
  assert.deepEqual(L.token("0x00"), { known: true, name: "MINIMA", id: "0x00" });
  assert.deepEqual(L.token(MXUSD.toLowerCase()), { known: true, name: "MxUSD", id: MXUSD });
  for (const id of [FAKE, "", undefined, null, "0x0", "0x000", "MxUSD", MXUSD + "00", MXUSD.slice(0, -2)]) {
    const t = L.token(id); assert.equal(t.known, false, String(id)); assert.equal(t.name, "another token");
  }
  const d = L.describe({ incoming: true, who: "Mallory", amount: "5000", tokenid: FAKE });
  assert.equal(d.token, "another token"); assert.equal(d.tokenLine, "Token id: " + FAKE, "the whole id");
  assert.equal(L.describe({ incoming: true, who: "M", amount: "1" }).tokenLine, "No token id was given");
  assert.equal(L.describe({ incoming: true, who: "M", amount: "1", tokenid: MXUSD }).tokenLine, "");
});

test("a received payment is a claim until found: the words say so", () => {
  const claim = L.describe({ incoming: true, who: "Mallory", amount: "5000", tokenid: MXUSD });
  assert.equal(claim.head, "Mallory says they sent you"); assert.match(claim.state, /^Not verified: this node has not found this payment/); assert.equal(claim.verified, false);
  const found = L.describe({ incoming: true, who: "Mirela", amount: "12.5", tokenid: MXUSD, status: "received" });
  assert.equal(found.head, "Mirela sent you"); assert.match(found.state, /^Received: this node found the payment/); assert.equal(found.verified, true);
  const ours = L.describe({ incoming: false, amount: "3", tokenid: "0x00" });
  assert.equal(ours.head, "You sent"); assert.equal(ours.state, ""); assert.equal(ours.token, "MINIMA");
  assert.equal(L.preview({ incoming: true, amount: "5000", tokenid: MXUSD }), "Payment notice, not verified: 5000 MxUSD");
  assert.equal(L.preview({ incoming: true, amount: "5000", tokenid: MXUSD, status: "received" }), "5000 MxUSD");
  assert.equal(L.preview({ incoming: true, amount: "5000", tokenid: FAKE }), "Payment notice, not verified: 5000 of another token");
  assert.equal(L.preview({ incoming: false, amount: "2", tokenid: "0x00" }), "2 MINIMA");
});

test("check: received only when the transaction is on chain and pays this wallet exactly that amount of that token id", async () => {
  const ok = async (p, n) => V.check(Object.assign({ txid: TXID, tokenid: MXUSD, amount: "12.5" }, p), n.run);
  let n = nodeWith({ outputs: [out(MINE, MXUSD, "12.5"), out(THEIRS, MXUSD, "87.5")] });
  assert.equal(await ok({}, n), "received");
  assert.deepEqual(n.asked, ["txpow onchain:" + TXID, "txpow txpowid:" + TXID, "checkaddress address:" + MINE, "checkaddress address:" + THEIRS], "reads only, and few");
  assert.equal(await ok({ amount: "12.50" }, n), "received", "the same amount written another way");
  assert.equal(await ok({}, nodeWith({ outputs: [out(MINE, MXUSD, "10"), out(MINE2, MXUSD, "2.5")] })), "received", "two outputs to this wallet add up");
  assert.equal(await ok({ tokenid: "0x00", amount: "3" }, nodeWith({ outputs: [out(MINE, "0x00", "3")] })), "received", "MINIMA");
  // every way it is NOT received
  assert.equal(await ok({}, nodeWith({ onchain: [], outputs: [out(MINE, MXUSD, "12.5")] })), "unverified", "known to the node but not on chain");
  assert.equal(await ok({}, nodeWith({ outputs: [out(THEIRS, MXUSD, "12.5")] })), "unverified", "pays somebody else");
  assert.equal(await ok({}, nodeWith({ outputs: [out(MINE, MXUSD, "12.4999")] })), "unverified", "less");
  assert.equal(await ok({}, nodeWith({ outputs: [out(MINE, MXUSD, "12.5000000000000000000000000000000000000000001")] })), "unverified", "not exactly: no rounding");
  assert.equal(await ok({}, nodeWith({ outputs: [out(MINE, FAKE, "12.5")] })), "unverified", "that amount of ANOTHER token (named MxUSD by its maker)");
  assert.equal(await ok({ tokenid: FAKE, amount: "5000" }, nodeWith({ outputs: [out(MINE, MXUSD, "5000")] })), "unverified");
  assert.equal(await ok({ tokenid: "0x00" }, nodeWith({ outputs: [out(MINE, MXUSD, "12.5")] })), "unverified", "MxUSD is not MINIMA");
  assert.equal(await ok({}, nodeWith({ outputs: [{ address: MINE, tokenid: MXUSD, amount: "12.5" }] })), "unverified", "a token output is read by its token amount, never the raw one");
  for (const fail of ["txpow onchain", "txpow txpowid", "checkaddress"])
    assert.equal(await ok({}, nodeWith({ outputs: [out(MINE, MXUSD, "12.5")], fail })), "unverified", "a read that fails: " + fail);
  // a claim that is not even well formed asks the node nothing
  for (const bad of [{ txid: "" }, { txid: "0x12 status" }, { txid: "abc" }, { tokenid: "" }, { tokenid: "MxUSD" }, { amount: "" }, { amount: "0" }, { amount: "1e3" }, { amount: "-1" }, { amount: "1,5" }]) {
    n = nodeWith({ outputs: [out(MINE, MXUSD, "12.5")] });
    assert.equal(await ok(bad, n), "unverified", JSON.stringify(bad)); assert.deepEqual(n.asked, []);
  }
  // bounded: a transaction with very many outputs to very many addresses is given up on
  n = nodeWith({ outputs: Array.from({ length: 500 }, (_, i) => out("0x" + i.toString(16).padStart(64, "0"), MXUSD, "1")) });
  assert.equal(await ok({}, n), "unverified"); assert.ok(n.asked.length <= 2 + 16, "at most 16 addresses asked: " + n.asked.length);
});

test("asked when first shown, then on new blocks until found, within a limit: no polling storm", async () => {
  const world = { outputs: [out(MINE, MXUSD, "12.5")], onchain: [] };
  const asked = [];
  const run = async (cmd) => { asked.push(cmd); return nodeWith(world).run(cmd); };
  let changes = 0;
  const v = V.create({ run, onChange: () => changes++ }), p = { txid: TXID, tokenid: MXUSD, amount: "12.5" };
  assert.equal(await v.ask(p), "unverified"); assert.equal(asked.length, 1, "first shown: looked for once (not on chain yet)");
  for (let i = 0; i < 5; i++) assert.equal(await v.ask(p), "unverified");
  assert.equal(asked.length, 1, "shown again and again (every redraw): the node is not asked again");
  assert.equal(await v.onBlock(), 0); assert.equal(asked.length, 2); assert.equal(changes, 0);
  world.onchain = [TXID];                                   // mined
  assert.equal(await v.onBlock(), 1); assert.equal(changes, 1, "the screens are told once");
  assert.equal(await v.ask(p), "received");
  const n = asked.length; await v.onBlock(); await v.ask(p); assert.equal(asked.length, n, "found: never asked again");
  // a payment that never arrives is given up on
  const never = { txid: "0x00" + "77".repeat(31), tokenid: MXUSD, amount: "1" }; asked.length = 0;
  await v.ask(never); for (let i = 0; i < 50; i++) await v.onBlock();
  assert.equal(asked.length, V.MAX_TRIES, "one read per try, " + V.MAX_TRIES + " tries, then no more"); assert.equal(await v.ask(never), "unverified");
  // many claims: only so many are followed
  for (let i = 0; i < V.MAX_TRACKED + 50; i++) await v.ask({ txid: "0x" + i.toString(16).padStart(64, "0"), tokenid: MXUSD, amount: "1" });
  assert.equal(v.size(), V.MAX_TRACKED);
  v.reset(); assert.equal(v.size(), 0); world.onchain = [];
  assert.equal(await v.ask(p), "unverified", "another node start: nothing is carried over");
});

// ---- the screens' own code, run ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tidyAmount = (s) => { s = String(s == null ? "" : s); return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, ""); };
function mailPanel(api) {
  const win = { PayLabel: L, micon: () => "" };
  new Function("window", fs.readFileSync(path.join(__dirname, "..", "renderer", "mail.js"), "utf8"))(win);
  return win.MailPanel._test({ api, esc, TOK: { tidyAmount } });
}
function chatPanel(api) {
  const win = {};
  new Function("window", "PayLabel", "document", fs.readFileSync(path.join(__dirname, "..", "renderer", "chat.js"), "utf8"))(win, L, {});
  return win.ChatPanel._test({ api, esc });
}
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

test("Mail: a payment message with nothing behind it, or in a token NAMED MxUSD, never reads as MxUSD received", async () => {
  const world = nodeWith({ outputs: [out(MINE, MXUSD, "12.5")] });
  const v = V.create({ run: world.run });
  const mail = mailPanel({ payCheck: (txid, tokenid, amount) => v.ask({ txid, tokenid, amount }) });
  const from = "0x" + "C7".repeat(32);
  const fake = { type: "payment", incoming: true, frompublickey: from, fromname: "Mallory", amount: "5000", tokenid: FAKE, tokenname: "MxUSD", txpowid: "0x" + "99".repeat(32), date: 1 };
  const empty = Object.assign({}, fake, { tokenid: MXUSD, txpowid: "0x" + "98".repeat(32) });           // real id, no payment behind it
  const real = Object.assign({}, fake, { fromname: "Mirela", amount: "12.5", tokenid: MXUSD, txpowid: TXID });
  let t = text(mail.bubble(fake, false, false));
  assert.ok(!/MxUSD/.test(t), "the sender's name for the token is not shown: " + t);
  assert.ok(t.includes("5000 another token") && t.includes("Token id: " + FAKE) && /says they sent you/.test(t) && /Not verified/.test(t), t);
  assert.equal(mail.previewText(fake), "Payment notice, not verified: 5000 of another token");
  t = text(mail.bubble(empty, false, false)); assert.ok(/says they sent you 5000 MxUSD/.test(t) && /Not verified/.test(t) && !/Received/.test(t), t);
  t = text(mail.bubble(real, false, false)); assert.ok(/Not verified/.test(t), "not stated as fact before it is checked: " + t);
  let redraws = 0;
  await mail.verifyShown([fake, empty, real], () => redraws++);
  assert.equal(redraws, 1);
  t = text(mail.bubble(real, false, false)); assert.ok(/sent you 12\.5 MxUSD/.test(t) && /Received: this node found/.test(t) && !/says they/.test(t), t);
  assert.equal(mail.previewText(real), "12.5 MxUSD");
  for (const m of [fake, empty]) assert.ok(/Not verified/.test(text(mail.bubble(m, false, false))), "the other two stay not verified");
  const mine = text(mail.bubble({ type: "payment", incoming: false, amount: "2", tokenid: "0x00", tokenname: "anything", status: "sent", date: 1 }, false, false));
  assert.ok(/You sent 2 MINIMA/.test(mine) && !/verified/i.test(mine), mine);
});

test("Chat: the same rule", async () => {
  const world = nodeWith({ outputs: [out(MINE, "0x00", "3")] });
  const v = V.create({ run: world.run });
  const chat = chatPanel({ payCheck: (txid, tokenid, amount) => v.ask({ txid, tokenid, amount }) });
  const fake = { state: "payment", incoming: true, amt: "5000", tok: FAKE, tokname: "MxUSD", txid: "0x" + "99".repeat(32) };
  const old = { state: "payment", incoming: true, amt: "7", tokname: "MxUSD", txid: "0x" + "97".repeat(32) };   // stored before 0.19.7: no token id kept
  const real = { state: "payment", incoming: true, amt: "3", tok: "0x00", tokname: "Minima", txid: TXID };
  let t = text(chat.payHtml(fake));
  assert.ok(!/MxUSD/.test(t) && t.includes("Payment notice 5000 another token") && t.includes("Token id: " + FAKE) && /Not verified/.test(t), t);
  assert.equal(chat.preview(fake), "💸 Payment notice, not verified: 5000 of another token");
  t = text(chat.payHtml(old)); assert.ok(!/MxUSD/.test(t) && /No token id was given/.test(t), t);
  assert.ok(/Payment notice 3 MINIMA/.test(text(chat.payHtml(real))));
  let redraws = 0;
  for (const m of [fake, old, real]) await chat.verifyPayment(m, () => redraws++);
  assert.equal(redraws, 1);
  t = text(chat.payHtml(real)); assert.ok(/Payment received 3 MINIMA/.test(t) && /Received: this node found/.test(t), t);
  assert.ok(/Payment notice/.test(text(chat.payHtml(fake))));
  assert.ok(/Payment sent 2 MxUSD/.test(text(chat.payHtml({ state: "payment", incoming: false, amt: "2", tok: MXUSD, txid: TXID }))));
});
