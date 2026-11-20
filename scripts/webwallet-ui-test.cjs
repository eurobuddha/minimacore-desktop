/*
 * webwallet-ui-test.cjs — the Web Wallet screen's safety rules (renderer/app.js), run against stand-ins: no node, no network.
 * Run: node --test scripts/webwallet-ui-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const fnSrc = (name) => { const i = app.indexOf("\nfunction " + name + "("); assert.ok(i >= 0, name); return app.slice(i + 1, app.indexOf("\n}", i) + 2); };
const ww = app.slice(app.indexOf("// ===================== Web Wallet"), app.indexOf("function renderActive() {"));

// ---- 0.18.155 ----
test("the UNKNOWN lock belongs to the wallet address and outlives Lock and leaving the screen; only \"I've checked\" clears it", () => {
  const W = new Function("let wwSeed = 's', wwAddr = { address: 'MxA' }, wwBal = [1], wwKu = {}, wwArmed = true, wwKuSuggest = 3;\nconst WW_UNKNOWN = new Set();\n"
    + fnSrc("wwUnknown") + "\n" + app.match(/function wwLock\(\) \{[^\n]*\}/)[0] + "\nreturn { wwUnknown, wwLock, seed: () => wwSeed };")();
  const A = "MxG0" + "A".repeat(56), B = "MxG0" + "B".repeat(56);
  assert.equal(W.wwUnknown(A), false);
  assert.equal(W.wwUnknown(A, true), true, "an ambiguous send from A");
  W.wwLock(); assert.equal(W.seed(), null, "Lock (and leaving the screen) clears the seed");
  assert.equal(W.wwUnknown(A), true, "and NOT the lock: unlocking again does not offer Send");
  assert.equal(W.wwUnknown(A.toLowerCase()), true, "the same address in another case"); assert.equal(W.wwUnknown(B), false, "another wallet is not locked by it");
  assert.equal(W.wwUnknown(null, true), false, "no address: nothing is recorded");
  assert.equal(W.wwUnknown(A, false), false, "I've checked");
  assert.ok(!/wwAmbiguous/.test(ww), "the per-session flag that Lock reset is gone");
  assert.equal((ww.match(/wwUnknown\([^)]*, false\)/g) || []).length, 1, "cleared in exactly one place");
  assert.ok(/ambigBtn\.addEventListener\("click", \(\) => \{ wwUnknown\(wwAddr && wwAddr\.address, false\);/.test(ww), "and that place is the \"I've checked\" button");
  assert.ok(/const from = wwAddr\.address;[^\n]*\n\s*let r;\n\s*try \{ r = await api\.wwSend\(/.test(ww) && /wwUnknown\(from, true\);/.test(ww), "recorded for the wallet the send left, even if the screen was locked before the answer");
  assert.ok(/if \(wwUnknown\(wwAddr && wwAddr\.address\)\) \{ toast\("The last send's status is UNKNOWN\./.test(ww) && /const sendDisabled = \(\(a\.isNodeSeed \|\| ku\.ack\) && !unknown\) \? "" : "disabled";/.test(ww), "Send is off, and refuses, while it stands");
});

// ---- 0.18.156 ----
test("the public key is read against the chain only on a click; an unread figure is never taken as 0", () => {
  const F = new Function(fnSrc("wwOnchainUses") + "\n" + fnSrc("wwConfirmUses") + "\nreturn { wwOnchainUses, wwConfirmUses };")();
  const PK = "0x" + "AB".repeat(32);
  assert.equal(F.wwOnchainUses({ keys: [{ publickey: PK.toLowerCase(), spend_blocks: 7, spent_coins: "9" }] }, PK), 9);
  assert.equal(F.wwOnchainUses({ keys: [{ publickey: PK, spend_blocks: 0, spent_coins: 0 }] }, PK), 0, "a real 0 is a figure");
  for (const r of [null, {}, { keys: [] }, { keys: [{ publickey: "0x" + "CD".repeat(32), spend_blocks: 3, spent_coins: 3 }] }, { keys: [{ publickey: PK, spend_blocks: "x", spent_coins: 1 }] }, { keys: [{ publickey: PK, spend_blocks: 1 }] }, { keys: [{ publickey: PK, spend_blocks: -1, spent_coins: 1 }] }])
    assert.equal(F.wwOnchainUses(r, PK), null, JSON.stringify(r));
  assert.equal(F.wwConfirmUses("5", null), null, "unread: refuse"); assert.equal(F.wwConfirmUses("5", undefined), null);
  assert.equal(F.wwConfirmUses("5", 9), 9, "never below the chain"); assert.equal(F.wwConfirmUses("12", 9), 12); assert.equal(F.wwConfirmUses("", 0), 0); assert.equal(F.wwConfirmUses("-4", 2), 2);
  const unlock = ww.slice(ww.indexOf("function renderWwUnlock("), ww.indexOf("function renderWwWallet("));
  assert.ok(!/keyAudit/.test(unlock), "nothing is sent at unlock");
  assert.equal((ww.match(/api\.keyAudit\(/g) || []).length, 1, "one place asks"); assert.ok(/const readOnchain = async \(\) => \{ let r = null; try \{ r = await api\.keyAudit\(\[a\.publickey\]\);/.test(ww), "and it is the click's readOnchain");
  assert.ok(/const n = wwConfirmUses\(typed, wwKuSuggest != null \? wwKuSuggest : await readOnchain\(\)\);[\s\S]{0,200}if \(n == null\) \{/.test(ww), "Confirm reads the chain and refuses while unread");
  assert.ok(/only this wallet's public key is sent to eurobuddha\.com/.test(ww), "the screen says what leaves");
});

// ---- 0.18.157: Settings' deep key audit ----
test("Settings: the node's public keys go to the audit service only when the button is pressed, never on opening Settings", () => {
  const calls = [...app.matchAll(/runKeyAudit\(([^)]*)\)/g)].map(m => m[1]).filter(a => a !== "force");
  assert.deepEqual(calls, ["true"], "one call, from the button");
  assert.ok(/el\("kuAudit"\)\.onclick = \(\) => runKeyAudit\(true\);/.test(app));
  assert.ok(/It runs only when you press the button\./.test(app) && !/automatically when you open this panel/.test(app), "the screen says so");
});
