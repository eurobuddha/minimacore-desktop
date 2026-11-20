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
