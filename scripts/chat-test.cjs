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

// ---------------------------------------------------------------- 0.19.2: what the phone's chat has and the desktop lacked
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("an inbound file offer becomes a row named after the file; receipts and broken offers are consumed; nothing downloads", () => {
  const src = read("main/chat.js");
  const ctl = src.indexOf('m.state === "file-control"'), offer = src.indexOf('m.state === "file")'), unknown = src.indexOf("unknown states:");
  assert.ok(ctl > 0 && offer > ctl && unknown > offer, "file-control and file are handled before the unknown-state guard");
  assert.ok(/"", "image", "audio", "payment", "file"\]/.test(src), "file is a stored state");
  assert.ok(/inboundOffer\(m\.ref\);\s*if \(!offer\) \{ await nodeCmd\("keets action:ack id:" \+ msg\.id\); continue; \}/.test(src), "an offer that does not parse is acked and dropped");
  assert.ok(!/\.download\(/.test(src.slice(ctl, unknown)), "the drainer never downloads");
  const files = require("../main/chatfiles");
  assert.equal(files.inboundOffer("pf1:not-an-offer"), null);
});

test("a peer's file name cannot leave the folder the user chose", () => {
  const { safeName } = require("../main/chatfiles");
  for (const bad of ["../../etc/passwd", "..\\..\\boot.ini", "/abs/olute", ".hidden", "a\u0000b", "con\nsole", "", "   ", "....", "x".repeat(600)]) {
    const n = safeName(bad);
    assert.ok(n.length > 0 && n.length <= 255, "never empty, never too long: " + JSON.stringify(n).slice(0, 40));
    assert.ok(!/[\\/\u0000-\u001f]/.test(n) && n[0] !== ".", "no separators, control characters or leading dot: " + JSON.stringify(n).slice(0, 40));
  }
  const main = read("main/main.js");
  assert.ok(/mcd:chatFileSave[\s\S]{0,400}showSaveDialog\(win, \{ defaultPath: require\("\.\/chatfiles"\)\.safeName\(st\.name\) \}\)/.test(main), "saving goes through a save dialog with the safe name");
  assert.ok(!/shell\.openPath|shell\.showItemInFolder/.test(main.slice(main.indexOf("mcd:chatFileSend"), main.indexOf("mcd:chatSendImage"))), "a received file is never opened");
});

test("a voice note is the phone's message: published under /chat/vn-<ms><ext>, state audio, body M:SS|waveform", () => {
  const voice = require("../main/chatvoice");
  assert.equal(voice.MAX_SECONDS, 60);
  assert.equal(voice.buildBody(72, "4f8a"), "1:12|4f8a");
  assert.equal(voice.publishPath("audio/mp4", 1760000000000), "/chat/vn-1760000000000.m4a");
  assert.equal(voice.publishPath("audio/webm", 1760000000000), "/chat/vn-1760000000000.webm");
  assert.equal(voice.publishPath("audio/ogg", 1760000000000), "/chat/vn-1760000000000.ogg");
  assert.equal(voice.sendable(1000, 0), false, "under a second is not sent");
  const src = read("main/chat.js");
  assert.ok(/keets action:publish path:" \+ voice\.publishPath\(mime, now\) \+ " file:" \+ tmp/.test(src));
  assert.ok(/chatEncodeTyped\(store\.metaGet\("myname"\) \|\| "", body, \{ state: "audio", ref: pub\.url \}\)/.test(src));
  assert.ok(src.includes("(ogg|m4a|webm|wav|png|jpe?g)") && src.includes('ext === ".webm" ? "audio/webm"'), "a .webm note is fetched as audio, not as a picture");
  // the screen's own waveform is the phone's summarise + encode
  const ui = read("renderer/chat.js"), vm = require("vm");
  const fn = /function waveHex\(samples\) \{[\s\S]*?\n  \}/.exec(ui)[0];
  const waveHex = vm.runInNewContext("const VOICE = { BARS: 32 }; " + fn + "; waveHex");
  const samples = Array.from({ length: 100 }, (_, i) => (i * 331) % 32768);
  assert.equal(waveHex(samples), voice.encode(voice.summarise(samples)));
  assert.equal(waveHex([]), voice.encode(voice.summarise([])));
});

test("the microphone is asked for only by this window, and only on Voice note", () => {
  const main = read("main/main.js"), ui = read("renderer/chat.js");
  assert.ok(/wc === win\.webContents/.test(main) && /permission !== "media" \|\| !ownPage\(wc\)/.test(main), "media permission is this window's alone");
  assert.ok(/askForMediaAccess\("microphone"\)/.test(main));
  assert.equal((ui.match(/getUserMedia\(/g) || []).length, 1, "one place asks for the microphone");
  assert.ok(ui.indexOf("getUserMedia(") > ui.indexOf("async function doVoice()"), "and it is the Voice note action");
});

test("Delete chat keeps the contact, Delete contact removes both, and a failure is a dialog that can be copied", () => {
  const src = read("main/chat.js"), ui = read("renderer/chat.js");
  assert.ok(/function clearThread\(pubkey\) \{ store\.deleteThread\(pubkey\);/.test(src) && !/function clearThread[^\n]*removeContact/.test(src));
  assert.ok(/chatClearBtn[\s\S]{0,500}Clear this conversation\? The contact stays in your list/.test(ui));
  assert.ok(/Permanently remove this contact and the conversation\?/.test(ui));
  assert.ok(/function showFailure\(message\)[\s\S]{0,400}Copy details[\s\S]{0,200}return KEEP/.test(ui), "Copy details leaves the dialog open");
  for (const item of ["Photo", "Voice note", "Send payment", "Request their pay address", "File (up to 100 MB)", "File transfers"]) assert.ok(ui.includes(item), "attach: " + item);
});
