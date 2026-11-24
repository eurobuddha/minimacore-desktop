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

// ---- 0.18.327: a peer's inbox sender or id, a recipient or a media ref is never pasted into a command unless it is plain ----
test("an inbox entry whose sender or id is not plain sends nothing with it; a bad recipient, media ref or file path is refused before any command", async () => {
  const PEER = "c3".repeat(32), sent = [];
  const ok = JSON.stringify({ application: "maxima_chat_v1", id: "m9", body: "hi", name: "Ann", ts: 2 });
  let inbox = [{ id: "i9 to:0x" + "ee".repeat(32), from: PEER, message: ok, ts: "1" }, { id: "i10", from: PEER + " datahex:0x00", message: ok, ts: "1" }, { id: "i11", from: PEER, message: ok, ts: "1" }];
  chat._setRunner(async (c) => { sent.push(c);
    if (c.startsWith("keets action:info")) return { status: true, response: { pubkey: "cd".repeat(32), drive: "" } };
    if (c.startsWith("keets action:inbox")) { const r = inbox; inbox = []; return { status: true, response: r }; }
    return { status: true, response: {} }; });
  await chat.pollOnce();
  assert.deepEqual(sent.filter(c => /ee{8}|datahex:0x00\b| to:0x(ee)+/.test(c) && !c.startsWith("keets action:inbox")), [], "nothing from the bad entries reached a command");
  assert.ok(sent.includes("keets action:ack id:i11"), "the plain entry is handled");
  sent.length = 0;
  await assert.rejects(chat.fetchMedia("keets://x;quit"), /bad media ref/);
  await assert.rejects(chat.sendImageFile("0x" + "ab".repeat(32), "/tmp/a\u007fb.png"), /control character/);
  await assert.rejects(chat.sendImageFile("0x" + "ab".repeat(32) + " datahex:0x00", "/tmp/a.png"), /recipient/);
  assert.deepEqual(sent, [], "nothing sent");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/ipcMain\.handle\("mcd:chatMedia", \(_e, ref, force, sender\) => \{ if \(typeof ref !== "string" \|\| ref\.length > 620/.test(main), "the IPC checks the ref too");
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const mediaRef = (drive, name) => "keets://" + drive.repeat(32) + "/chat/" + name + ".jpg";
const senderA = "aa".repeat(32), senderB = "bb".repeat(32);
function backgroundRunner() {
  const commands = [];
  chat._setRunner(cmd => new Promise(resolve => {
    commands.push({
      cmd,
      file: (cmd.match(/ file:"([^"]+)"$/) || [])[1],
      ok: () => resolve({ status: true, response: {} }),
      fail: (error = "media unavailable — no reachable peer completed the request in time") => resolve({ status: false, error })
    });
  }));
  return commands;
}
function writePhoto(command, contents = "photo") {
  fs.writeFileSync(command.file, contents);
  command.ok();
}

test("redraws share a fetch and never see a partially written photo", async () => {
  const calls = backgroundRunner(), ref = mediaRef("aa", "partial");
  const first = chat.fetchMedia(ref, false, senderA);
  await turn();
  fs.writeFileSync(calls[0].file, "partial");
  const redraw = chat.fetchMedia(ref, false, senderA);
  writePhoto(calls[0], "complete");
  const expected = "data:image/jpeg;base64," + Buffer.from("complete").toString("base64");
  assert.deepEqual(await Promise.all([first, redraw]), [expected, expected]);
  const pending = chat.fetchMedia(mediaRef("bb", "slow"), false, senderB);
  await turn();
  assert.equal(await chat.fetchMedia(ref, false, senderA), expected);
  assert.equal(calls.length, 2);
  writePhoto(calls[1]); await pending;
});

test("an offline sender costs one fetch across redraws and drives while other contacts can load and clicks can retry", async t => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const calls = backgroundRunner();
  const first = mediaRef("c1", "first"), next = mediaRef("d1", "second"), other = mediaRef("c1", "other");
  const ask = (ref, sender, force = false) => chat.fetchMedia(ref, force, sender).catch(e => e.message);
  const results = [ask(first, senderA), ask(first, senderA), ask(next, senderA), ask(other, senderB)];
  await turn();
  assert.equal(calls.length, 1);
  calls[0].fail(); await turn();
  assert.equal(calls.length, 2); assert.ok(calls[1].cmd.includes(other));
  writePhoto(calls[1]);
  const [a, duplicate, skipped, online] = await Promise.all(results);
  assert.match(a, /media unavailable/); assert.equal(a, duplicate);
  assert.match(skipped, /tried again later/); assert.match(online, /^data:image/);
  const click = ask(next, senderA, true); await turn(); writePhoto(calls[2]); await click;
  assert.match(await ask(first, senderA), /tried again later/);
  now += 120001;
  const retry = ask(first, senderA); await turn(); calls[3].fail(); await retry;
  now += 120001; assert.match(await ask(first, senderA), /tried again later/);
  now += 120001;
  const final = ask(first, senderA); await turn(); writePhoto(calls[4]); assert.match(await final, /^data:image/);
});

test("a stop invalidates queued media and a late failure cannot throttle the new node", async () => {
  const calls = backgroundRunner(), ref = mediaRef("eb", "restart");
  const old = chat.fetchMedia(ref, false, senderA).catch(e => e.message);
  const queued = chat.fetchMedia(mediaRef("ec", "stale"), false, senderA).catch(e => e.message);
  await turn(); chat.stopLoop();
  const fresh = chat.fetchMedia(ref, false, senderA).catch(e => e.message);
  calls[0].fail(); await turn();
  assert.equal(calls.length, 2); assert.ok(calls[1].cmd.includes(ref));
  calls[1].fail("connect ECONNREFUSED"); await Promise.all([old, queued, fresh]);
  const retry = chat.fetchMedia(ref, false, senderA);
  await turn(); writePhoto(calls[2]); assert.match(await retry, /^data:image/);
});

test("a slow photo and a thread's delivered and read receipts share one RPC slot", async () => {
  const peer = "ef".repeat(32), ref = mediaRef("ef", "with-receipts");
  const calls = backgroundRunner(), photo = chat.fetchMedia(ref, false, peer);
  await turn();
  const receipts = [];
  chat._setRunner(async cmd => {
    if (cmd === "keets action:inbox") {
      return { status: true, response: [1, 2].map(n => ({
        id: "receipt-in-" + n, from: peer, message: "hello " + n, ts: String(n)
      })) };
    }
    if (cmd.startsWith("keets action:send ")) {
      return new Promise(resolve => receipts.push({ cmd, release: () => resolve({ status: true, response: {} }) }));
    }
    return { status: true, response: {} };
  });
  await chat.pollOnce(); chat.thread(peer); await turn();
  assert.equal(receipts.length, 0, "incoming messages were stored and acknowledged while the photo held one slot");
  writePhoto(calls[0]); await photo;
  for (const [i, state] of ["delivered", "delivered", "read"].entries()) {
    await turn(); assert.equal(receipts.length, i + 1);
    const payload = JSON.parse(Buffer.from(receipts[i].cmd.split("datahex:0x")[1], "hex"));
    assert.equal(payload.state, state); receipts[i].release();
  }
  await turn();
});

test("a complete oversized file is refused locally on the next redraw", async () => {
  const calls = backgroundRunner(), ref = mediaRef("fa", "oversize");
  const first = chat.fetchMedia(ref).catch(e => e.message);
  await turn(); fs.writeFileSync(calls[0].file, ""); fs.truncateSync(calls[0].file, 8 * 1024 * 1024 + 1);
  calls[0].ok(); assert.match(await first, /too large to inline/);
  const second = chat.fetchMedia(ref).catch(e => e.message);
  await turn(); assert.equal(calls.length, 1); assert.match(await second, /too large to inline/);
});

test("a click promotes an already queued photo ahead of automatic downloads", async () => {
  const calls = backgroundRunner();
  const refs = ["first", "automatic", "clicked"].map(name => mediaRef("fb", name));
  const results = refs.map(ref => chat.fetchMedia(ref));
  results.push(chat.fetchMedia(refs[2], true));
  await turn(); writePhoto(calls[0]); await turn();
  assert.ok(calls[1].cmd.includes(refs[2])); writePhoto(calls[1]); await turn();
  assert.ok(calls[2].cmd.includes(refs[1])); writePhoto(calls[2]);
  await Promise.all(results);
});

test("an automatic pay-address reply waits for the active photo", async () => {
  const peer = "ac".repeat(32);
  store.addContact(peer, "Alice");
  const calls = backgroundRunner(), photo = chat.fetchMedia(mediaRef("fc", "address"));
  await turn();
  const replyTimeouts = [];
  chat._setRunner(async (cmd, timeout) => {
    if (cmd === "keets action:inbox") return { status: true, response: [{
      id: "address-1", from: peer, message: JSON.stringify({ state: "payaddr-req", body: "" })
    }] };
    if (cmd.startsWith("keets action:send ")) replyTimeouts.push(timeout);
    return { status: true, response: { miniaddress: "MxTest" } };
  });
  const poll = chat.pollOnce(); await turn();
  assert.deepEqual(replyTimeouts, []); writePhoto(calls[0]); await photo; await poll; await turn();
  assert.equal(replyTimeouts.length, 1); assert.ok(replyTimeouts[0] > 125000);
});

test("a node leaving running state discards an outstanding inbox reply", async () => {
  const appMain = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  assert.ok(appMain.includes('node.on("status", chat.onNodeStatus)'), "production node status drives this handler");
  const peer = "ad".repeat(32), cmds = [];
  let finishInbox;
  chat._setRunner(async cmd => {
    cmds.push(cmd);
    if (cmd === "keets action:inbox") return new Promise(resolve => { finishInbox = resolve; });
    return { status: true, response: {} };
  });
  try {
    chat.onNodeStatus({ state: "running" }); await turn();
    chat.onNodeStatus({ state: "stopping" });
    finishInbox({ status: true, response: [{ id: "stale-inbox", from: peer, message: "stale" }] });
    await turn(); assert.equal(chat.status().running, false);
    assert.ok(!cmds.some(c => c.startsWith("keets action:send") || c.startsWith("keets action:ack")));
    assert.equal(store.thread(peer).length, 0);
  } finally { chat.stopLoop(); }
});

test("a full delivery queue and a pay-address request let the inbox finish while a peer dial is pending", async () => {
  const peer = "bd".repeat(32);
  store.addContact(peer, "Bea");
  const notes = Array.from({ length: 150 }, (_, i) => ({ id: "burst-" + i, from: peer, message: "note" }));
  notes.splice(1, 0, { id: "burst-address", from: peer, message: JSON.stringify({ state: "payaddr-req", body: "" }) });
  const acks = [], sent = [], incoming = [];
  let release;
  const notice = value => incoming.push(value.count);
  chat.emitter.on("incoming", notice);
  chat._setRunner(async cmd => {
    if (cmd === "keets action:inbox") return { status: true, response: notes };
    if (cmd.startsWith("keets action:ack ")) acks.push(cmd);
    if (cmd.startsWith("keets action:send ")) {
      sent.push(JSON.parse(Buffer.from(cmd.split("datahex:0x")[1], "hex")).state);
      if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    }
    return { status: true, response: { miniaddress: "MxTest" } };
  });
  const poll = chat.pollOnce();
  try {
    await turn();
    assert.deepEqual(incoming, [150]);
    assert.equal(acks.length, 151);
    assert.equal(store.thread(peer).length, 150);
    assert.deepEqual(sent, ["delivered"]);
  } finally {
    if (release) release();
    await poll; await turn();
    chat.emitter.off("incoming", notice);
  }
  assert.ok(sent.includes("payaddr"));
  assert.equal(sent.filter(kind => kind === "delivered").length, 128);
});
