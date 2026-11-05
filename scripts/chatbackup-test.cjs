/*
 * chatbackup-test.cjs — the .kbak chat backup shared with the bears (apks/base ChatBackup.java).
 * Run: node --test scripts/chatbackup-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const cb = require("../main/chatbackup");
const pools = require("../main/pandapools/combined-backup");

const PEER = "0x" + "a1".repeat(32);
const state = {
  keypair: Buffer.alloc(32, 7), keetsPubkey: "0x" + "b2".repeat(32), chatName: "barry",
  contacts: [{ pubkey: PEER, name: "Alice", auto: false }],
  messages: [{ msgid: "m1", pubkey: PEER, incoming: true, body: "hi", name: "Alice", ref: "", ts: 5, via: "direct", read: true,
    state: "", amt: "", tokname: "", txid: "", peerread: false }],
  payaddr: { [PEER]: "MxG0" + "1".repeat(20) },
};

test("round trip keeps the keypair, rows and addresses", () => {
  const file = cb.exportBackup("correct horse", state);
  const b = cb.openBackup("correct horse", file);
  assert.deepEqual(b.keypair, state.keypair);
  assert.equal(b.manifest.keetsPubkey, state.keetsPubkey);
  assert.equal(b.contacts[0].payaddr, state.payaddr[PEER]);
  assert.deepEqual(b.messages[0], state.messages[0]);
  assert.equal(b.hasMax, false);
});

test("a wrong password is refused", () => {
  const file = cb.exportBackup("correct horse", state);
  assert.throws(() => cb.openBackup("wrong horse", file), /BAD_PASSWORD/);
});

test("the container is the MVLT format an independent reader accepts", async () => {
  const sealed = cb.seal("correct horse", Buffer.from("payload"));
  assert.equal(Buffer.from(await pools.unseal("correct horse", sealed)).toString(), "payload");
});

test("entries round-trip; path escapes and unknown names are rejected", () => {
  const data = Buffer.from(JSON.stringify([]));
  const ok = cb.zip([["chat/contacts.json", data]]);
  assert.deepEqual(cb.unzip(ok).get("chat/contacts.json"), data);
  assert.throws(() => cb.unzip(cb.zip([["maxchat/node/../../evil", Buffer.from("x")]])), /unexpected entry/);
  assert.throws(() => cb.unzip(cb.zip([["somewhere/else", Buffer.from("x")]])), /unexpected entry/);
});
