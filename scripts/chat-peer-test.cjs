/*
 * chat-peer-test.cjs — every string of a peer's chat message is cut to its length before it is used or stored
 * (0.18.172). Electron, config and the node manager are stood in for; the keets sidecar is a stand-in runner.
 * Run: node --test scripts/chat-peer-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chat-peer-"));
const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === "electron") return { app: { getPath: () => DIR, getVersion: () => "t" } };
  const from = parent && parent.filename || "";
  if (/[\\/]main[\\/]chat\.js$/.test(from) && request === "./config") return { rpcSecret: () => "", load: () => ({}) };
  if (/[\\/]main[\\/]chat\.js$/.test(from) && request === "./node-manager") return { rpcPort: () => 0, log: () => {}, on: () => {} };
  return realLoad.apply(this, arguments);
};
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const chat = require("../main/chat"), store = require("../main/chat-store");

test("an oversized chat message is stored cut to its caps; a real one whole", async () => {
  const PEER = "ab".repeat(32);
  const big = JSON.stringify({ application: "maxima_chat_v1", id: "m1", body: "b".repeat(300000), name: "n".repeat(500), ref: "r".repeat(5000), ts: 1, state: "payment", amt: "9".repeat(200), tok: "0x" + "A".repeat(100), tokname: "t".repeat(500), txid: "x".repeat(500) });
  const ok = JSON.stringify({ application: "maxima_chat_v1", id: "m2", body: "hello", name: "Ann", ts: 2 });
  let inbox = [{ id: "i1", from: PEER, message: big, ts: "1", via: "direct" }, { id: "i2", from: PEER, message: ok, ts: "2", via: "direct" }];
  chat._setRunner(async (c) => {
    if (c.startsWith("keets action:info")) return { status: true, response: { pubkey: "cd".repeat(32), drive: "" } };
    if (c.startsWith("keets action:inbox")) { const r = inbox; inbox = []; return { status: true, response: r }; }
    return { status: true, response: {} };
  });
  await chat.pollOnce();
  const t = store.thread(PEER), m1 = t.find(m => m.msgid === "m1"), m2 = t.find(m => m.msgid === "m2");
  assert.ok(m1 && m2, "both stored");
  assert.equal(m1.body.length, 262144); assert.equal(m1.name.length, 200); assert.equal(m1.ref.length, 2048);
  assert.equal(m1.amt.length, 80); assert.equal(m1.tokname.length, 200); assert.equal(m1.txid.length, 130);
  assert.equal(m2.body, "hello"); assert.equal(m2.name, "Ann");
  const legacy = chat._capDecoded(require("../main/chatschema").chatDecode("x".repeat(300000)));
  assert.equal(legacy.body.length, 262144, "a legacy plain-text body too");
});

// ---- 0.18.207: a "delivered" receipt touches only my message to that peer; a chat payment is checked like Mail's ----
test("a delivered receipt with ref __proto__ or another peer's ref changes nothing; a long ref is ignored", async () => {
  const PEER = "a1".repeat(32), OTHER = "b1".repeat(32);
  store.addContact(PEER, "P"); store.addContact(OTHER, "O");
  store.addMessage({ msgid: "mine-to-peer", pubkey: PEER, incoming: false, body: "hi", ts: 5, status: "mailboxed" });
  store.addMessage({ msgid: "mine-to-other", pubkey: OTHER, incoming: false, body: "hi", ts: 6, status: "mailboxed" });
  const rec = (ref, id) => ({ id, from: PEER, message: JSON.stringify({ application: "maxima_chat_v1", id: "d" + id, body: "", state: "delivered", ref, ts: 7 }), ts: "7", via: "direct" });
  let inbox = [rec("__proto__", "x1"), rec("mine-to-other", "x2"), rec("m".repeat(5000), "x3"), rec("mine-to-peer", "x4")];
  chat._setRunner(async (c) => c.startsWith("keets action:info") ? { status: true, response: { pubkey: "cd".repeat(32), drive: "" } }
    : c.startsWith("keets action:inbox") ? (() => { const r = inbox; inbox = []; return { status: true, response: r }; })() : { status: true, response: {} });
  await chat.pollOnce();
  assert.equal(({}).status, undefined, "Object.prototype untouched"); assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "status"), false);
  assert.equal(store.thread(OTHER).find(m => m.msgid === "mine-to-other").status, "mailboxed", "another peer's message is not marked by this peer");
  assert.equal(store.thread(PEER).find(m => m.msgid === "mine-to-peer").status, "delivered");
  assert.equal(store.setStatus("__proto__", { evil: 1 }), false); assert.equal(({}).evil, undefined);
});

test("chat payment: amount above zero, a valid checked address, pinned, ambiguous when the node does not answer, a failed receipt is not a failed payment", async () => {
  const PEER = "c1".repeat(32), ADDR = "MxG0" + "9".repeat(56);
  store.addContact(PEER, "Pay"); store.metaSet("payaddr:" + PEER, ADDR);
  let mode = "ok"; const sent = [];
  chat._setRunner(async (c) => { sent.push(c);
    if (c.startsWith("checkaddress")) return mode === "badaddr" ? { status: false, error: "Invalid address" } : { status: true, response: { simple: true } };
    if (c.startsWith("coins ")) return { status: true, response: [] };
    if (c.startsWith("send ")) { if (mode === "timeout") throw new Error("RPC timed out"); if (mode === "refused") return { status: false, error: "Insufficient funds" }; return { status: true, response: { txpowid: "0xT1" } }; }
    if (c.startsWith("keets action:send")) { if (mode === "noreceipt") throw new Error("peer offline"); return { status: true, response: { delivered: "direct" } }; }
    return { status: true, response: {} }; });
  for (const a of ["0", "0.000", "-1", "1e3", "", "1 address:Mx"]) await assert.rejects(chat.sendPayment(PEER, a, "minima"), /Invalid amount/, a);
  assert.ok(!sent.some(c => c.startsWith("send ")));
  mode = "badaddr"; await assert.rejects(chat.sendPayment(PEER, "1", "minima"), /Couldn't validate[\s\S]*Nothing was sent/);
  store.metaSet("payaddr:" + PEER, "Mx bad"); mode = "ok"; await assert.rejects(chat.sendPayment(PEER, "1", "minima"), /not a valid address/); store.metaSet("payaddr:" + PEER, ADDR);
  assert.ok(!sent.some(c => c.startsWith("send ")), "nothing sent so far");
  mode = "timeout"; await assert.rejects(chat.sendPayment(PEER, "1", "minima"), /may have been sent[\s\S]*pay twice/);
  mode = "refused"; await assert.rejects(chat.sendPayment(PEER, "1", "minima"), /Insufficient funds\. Nothing was sent/);
  mode = "noreceipt"; const r = await chat.sendPayment(PEER, "1.5", "mxusd");
  assert.equal(r.receiptFailed, true); assert.equal(r.txid, "0xT1"); assert.match(r.error, /peer offline/);
  mode = "ok"; const ok = await chat.sendPayment(PEER, "2", "minima"); assert.equal(ok.status, "delivered");
  assert.ok(sent.some(c => c.startsWith("coins relevant:true sendable:true")), "the Minima send went through the pin");
});
