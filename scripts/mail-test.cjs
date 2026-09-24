/*
 * mail-test.cjs — the invariants minimaMail had no test for. Three are interop- or funds-critical: the backup
 * container is byte-shared with the Android app, the thread key must agree between two peers who each compute
 * it from their own side, and the pay-address validator is the only guard between a mail key and a `send`.
 * The fourth is the 2026-09 history bug: `coins depth:` counts BLOCKS, and a fixed window silently lost every
 * message that arrived while the app was shut.
 *
 * These assert pure functions only — main/mail-store.js needs Electron's app.getPath, and a funds-critical
 * module does not get test seams bolted into it just to be observed.
 *
 * Run: node --test scripts/mail-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");

const backup = require("../main/mailbackup");
const mail = require("../main/mail");
const L = mail._limits;

// ---------------------------------------------------------------- backup container (Android interop)
test("backup round-trips, in the container layout Android reads", () => {
  const plain = JSON.stringify({ messages: { "a|b": { message: "hello" } }, contacts: {}, meta: { myname: "Barry" } });
  const o = JSON.parse(backup.encrypt("correct horse battery", plain));
  assert.equal(o.v, 1, "version 1");
  for (const k of ["salt", "iv", "ct"]) assert.ok(typeof o[k] === "string" && o[k].length, k + " present");
  // 16-byte salt, 12-byte IV, and ct = ciphertext‖tag: Java's AES/GCM/NoPadding appends the 16-byte tag, so ct
  // is exactly 16 bytes longer than the plaintext. Ship the tag separately and every Android restore fails.
  assert.equal(Buffer.from(o.salt, "hex").length, 16, "16-byte salt");
  assert.equal(Buffer.from(o.iv, "hex").length, 12, "12-byte IV");
  assert.equal(Buffer.from(o.ct, "hex").length, Buffer.byteLength(plain) + 16, "ciphertext carries the tag");
  assert.equal(backup.decrypt("correct horse battery", JSON.stringify(o)).toString("utf8"), plain, "round-trip");
});

test("a wrong passphrase fails closed, never with partial plaintext", () => {
  const blob = backup.encrypt("right", "secret payload");
  assert.throws(() => backup.decrypt("wrong", blob));
});

// ---------------------------------------------------------------- thread key (both peers must agree)
test("threadKey is symmetric, and a subject makes its own thread", () => {
  const a = "0x" + "11".repeat(65), b = "0x" + "22".repeat(65);
  assert.equal(mail.threadKey(a, b, ""), mail.threadKey(b, a, ""), "each side computes the same key");
  assert.notEqual(mail.threadKey(a, b, "Pool payment"), mail.threadKey(a, b, ""), "a subject splits the thread");
  assert.equal(mail.threadKey(a, b, "Pool payment"), mail.threadKey(b, a, "Pool payment"), "…and stays symmetric");
});

// ---------------------------------------------------------------- pay-address validator (funds guard)
test("looksLikeMinimaAddress refuses a mail key and anything that could inject a send parameter", () => {
  assert.ok(mail.looksLikeMinimaAddress("Mx" + "A".repeat(60)), "an Mx address passes");
  assert.ok(mail.looksLikeMinimaAddress("0x" + "ab".repeat(32)), "0x + 64 hex passes");
  // A mail key is 0x + 130 hex. Accepting one would let an identity be used as a payout address.
  assert.equal(mail.looksLikeMinimaAddress("0x" + "cd".repeat(65)), false, "a 130-hex mail key is refused");
  // The node tokenises `send` on spaces and takes the LAST value of a repeated key, so a space inside an
  // address is a funds redirect. Every one of these must be refused.
  for (const bad of ["Mx" + "A".repeat(50) + " address:0x" + "ff".repeat(32), "Mx AAA", " ", "0x", "Mx",
    "0x" + "zz".repeat(32), "Mx" + "A".repeat(20), "Mx" + "A".repeat(90), null, undefined]) {
    assert.equal(mail.looksLikeMinimaAddress(bad), false, "refused: " + JSON.stringify(String(bad).slice(0, 40)));
  }
});

// ---------------------------------------------------------------- the history bug
test("the live pass sizes its depth to the gap, not to a fixed window", () => {
  const tip = 2319722;
  // Steady state: a couple of blocks behind → the floor of POLL_DEPTH, as before.
  assert.equal(mail._depthForGap(tip, tip - 2), L.POLL_DEPTH, "a fresh app still asks for the small window");
  // The regression that lost mail: a four-hour shutdown is ~290 blocks. The old code asked for 32.
  const gap4h = 290;
  assert.ok(mail._depthForGap(tip, tip - gap4h) >= gap4h,
    `a ${gap4h}-block gap must be covered, asked ${mail._depthForGap(tip, tip - gap4h)}`);
  assert.ok(mail._depthForGap(tip, tip - gap4h) > gap4h, "…with margin, so a boundary coin can't fall between passes");
  // Never past the one-pass ceiling — beyond ~1024 the tree cascades and the node stops serving.
  assert.equal(mail._depthForGap(tip, tip - 5184), L.WINDOW_DEPTH, "a three-day gap caps at the window");
  assert.equal(mail._depthForGap(tip, 0), L.POLL_DEPTH, "no cursor yet → the steady-state window");
  assert.equal(mail._depthForGap(tip, tip + 5), L.POLL_DEPTH, "a tip that went backwards can't produce a negative depth");
});

test("the window is wide enough to be worth having, and the old one was not", () => {
  // ~50s a block: the old 256-block backfill covered 3h33m, which is why quitting overnight lost everything.
  assert.ok(L.WINDOW_DEPTH >= 1024, "one pass reaches ~14 hours");
  assert.ok(L.WINDOW_DEPTH * 50 / 3600 > 12, "…more than half a day");
  assert.ok(L.BACKFILL_CHUNK > 0 && L.BACKFILL_CHUNK <= L.WINDOW_DEPTH, "a sweep step is a sane bite");
});

test("the backfill walks down a chunk at a time and stops at genesis", () => {
  const floor = 2319722 - L.WINDOW_DEPTH;
  const next = mail._nextFloorTarget(floor);
  assert.equal(next, floor - L.BACKFILL_CHUNK, "one chunk lower");
  assert.ok(next < floor, "strictly downward — a sweep that stands still never finishes");
  assert.equal(mail._nextFloorTarget(3), 1, "clamps at the first block");
  assert.equal(mail._nextFloorTarget(1), 1, "and stays there rather than going negative");
});

// ---------------------------------------------------------------- the panel loads, and its icons all exist
test("the Mail panel and its icon set load, and every icon it asks for is defined", () => {
  const fs = require("fs"), vm = require("vm"), path = require("path");
  const dir = path.join(__dirname, "..", "renderer");
  // A DOM-less shim: enough for both files to evaluate. A typo in a template or an icon name fails here
  // rather than in front of the user, and an unknown icon name renders an empty <svg> that is easy to miss.
  const sandbox = {
    document: { getElementById: () => null, createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => "" }) },
    setTimeout, clearTimeout, Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Promise, console
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, "mailicons.js"), "utf8"), ctx, { filename: "mailicons.js" });
  vm.runInContext(fs.readFileSync(path.join(dir, "mail.js"), "utf8"), ctx, { filename: "mail.js" });

  assert.equal(typeof sandbox.micon, "function", "micon is exported");
  assert.ok(sandbox.MailPanel && typeof sandbox.MailPanel.render === "function", "MailPanel is exported");
  const src = fs.readFileSync(path.join(dir, "mail.js"), "utf8");
  const used = [...new Set([...src.matchAll(/micon\("([a-z]+)"/g)].map((m) => m[1]))];
  assert.ok(used.length > 10, "the panel actually uses the icon set");
  assert.deepEqual(used.filter((n) => !sandbox.micon.names.includes(n)), [], "no icon is referenced without being defined");
  assert.ok(sandbox.micon("inbox").startsWith('<svg class="mm-ic" viewBox="0 0 24 24"'), "24-grid SVG markup");
  assert.equal(sandbox.micon("nope"), "", "an unknown name is empty, never broken markup");
});

test("the panel's palette cannot leak into the rest of the app", () => {
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "mail.css"), "utf8");
  // Every selector that paints must sit inside .mailapp (or the #view-mail host it lives in). The APK's orange
  // escaping into Balances/AtomiX/Pools is exactly what scoping this file prevents.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")
    .map((b) => b.split("{")[0].trim()).filter(Boolean)
    .flatMap((s) => s.split(",").map((x) => x.trim())).filter(Boolean);
  const loose = selectors.filter((s) => !/(^|\s|\()\.mailapp\b/.test(s) && !/^#view-mail\b/.test(s) && !/^:root\[data-theme/.test(s));
  assert.deepEqual(loose, [], "unscoped selectors would leak: " + loose.join(" | "));
  // and the old classes must be gone from the shared sheet, except the ones other panels wear
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.css"), "utf8");
  for (const dead of [".mail-bubble", ".mail-conv", ".mail-compose", ".mail-daychip", ".mail-av", ".emoji-grid"]) {
    assert.ok(!app.includes(dead + " "), dead + " should have moved out of app.css");
  }
  assert.ok(app.includes(".mail-ver"), ".mail-ver stays — the AtomiX and Parlons headers wear it");
  assert.ok(app.includes("#view-minimall .mail-thread"), "miniMall keeps its own .mail-thread");
});
