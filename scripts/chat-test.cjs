/*
 * chat-test.cjs — KeetChat wire-schema invariants. The schema is the interop contract:
 * the SAME payload must parse in the MDS dapp (mds/keetchat), this desktop app, the
 * Android app, and — field-for-field — Parlons native (maxima_chat_v1). So the tests
 * pin the round-trip, the legacy fallback, and that the desktop twin of chatschema.js
 * has not drifted from the canonical copy in mds/keetchat.
 *
 * Pure functions only (the mail-test rule): main/chat.js and chat-store.js need
 * Electron and get exercised by the live two-node rig instead.
 *
 * Run: node --test scripts/chat-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const schema = require("../main/chatschema");

test("encode/decode round-trips every field", () => {
  const enc = schema.chatEncode("barry", "hello world", "keets://" + "ab".repeat(32) + "/pic.png?hash=" + "cd".repeat(32));
  const m = JSON.parse(enc);
  assert.equal(m.application, "maxima_chat_v1", "Parlons-native application string");
  const d = schema.chatDecode(enc);
  assert.equal(d.body, "hello world");
  assert.equal(d.name, "barry");
  assert.ok(d.ref.startsWith("keets://"), "ref carried");
  assert.ok(/^kc-\d+-\d+$/.test(d.id), "dedupe id shape");
  assert.ok(typeof d.ts === "number" && d.ts > 0, "sender timestamp");
  assert.equal(d.legacy, false);
});

test("legacy plain text (0.1.0 payloads) still decodes", () => {
  const d = schema.chatDecode("just some text");
  assert.equal(d.body, "just some text");
  assert.equal(d.legacy, true);
  assert.equal(d.id, null, "no wire id — receiver falls back to the inbox id");
});

test("non-chat JSON is treated as legacy text, never crashes", () => {
  const d = schema.chatDecode('{"x":1}');
  assert.equal(d.legacy, true);
  assert.equal(d.body, '{"x":1}');
});

test("hostile fields are bounded: oversized id is dropped, non-string name/ref ignored", () => {
  const d = schema.chatDecode(JSON.stringify({ body: "b", id: "x".repeat(200), name: 7, ref: {}, ts: "later" }));
  assert.equal(d.id, null, "id over 80 chars rejected (dedupe key stays bounded)");
  assert.equal(d.name, "");
  assert.equal(d.ref, "");
  assert.equal(d.ts, null);
});

test("desktop chatschema has not drifted from the canonical mds/keetchat copy", () => {
  const grab = (src, fn) => {
    const m = src.match(new RegExp("function " + fn + "\\s*\\([\\s\\S]*?\\n}", "m"));
    assert.ok(m, fn + " found");
    return m[0];
  };
  const here = fs.readFileSync(path.join(__dirname, "..", "main", "chatschema.js"), "utf8");
  const canonPath = path.join(__dirname, "..", "..", "..", "mds", "keetchat", "chatschema.js");
  let canon = null;
  try { canon = fs.readFileSync(canonPath, "utf8"); }
  catch (e) { return; }   // repo checked out alone (CI) — sync check only runs in the family workspace
  for (const fn of ["chatEncode", "chatDecode"]) {
    assert.equal(grab(here, fn), grab(canon, fn), fn + " identical in both copies");
  }
});
