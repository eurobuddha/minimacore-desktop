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

// ---- 0.18.158: token names in the Web Wallet and Vestr ----
test("a token not known by its id is shown with its whole id; a name imitating Minima or MxUSD (also with unseen characters) is not shown", () => {
  const i = app.indexOf("\nconst MXUSD_TOKENID");
  const F = new Function(app.slice(i, app.indexOf("\n}\n", app.indexOf("function tokLabel(", i)) + 3) + "\nreturn tokLabel;")();
  const T = "0x" + "C0FFEE".repeat(10) + "ABCD", MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  assert.equal(F("0x00", "anything"), "MINIMA"); assert.equal(F(MX.toLowerCase(), "x"), "MxUSD");
  assert.equal(F(T, "Gold"), "Gold (token " + T + ")", "its own name and the whole id");
  for (const fake of ["MINIMA", "Minima ", "MxUSD", "mxUSDT", "USDT", "Mi​nima", "Mx⁦USD⁩", "M­xUSD", "‮MINIMA"]) assert.equal(F(T, fake), T, JSON.stringify(fake) + " shows the id alone");
  assert.equal(F(T, T.slice(0, 12)), T, "a name that is only the start of the id (main cuts it to 12) shows the whole id");
  assert.equal(F(T, ""), T); assert.equal(F(T, null), T);
  const ww = app.slice(app.indexOf("function renderWwWallet("), app.indexOf("async function wwDoSend("));
  assert.ok(!/esc\(b\.name\)/.test(ww) && (ww.match(/tokLabel\(b\.tokenid, b\.name\)/g) || []).length === 2, "the Web Wallet's balances and token list");
  assert.ok(/function vTok\(tid\) \{ return tokLabel\(tid, vestrTokMap && vestrTokMap\[tid\]\); \}/.test(app) && /esc\(tokLabel\(t\.tokenid, t\.name\)\)/.test(app), "Vestr's cards and token list");
  assert.ok(/"Collect " \+ vFmt\(v\.cancollect\) \+ " " \+ esc\(vTok\(v\.tokenid\)\)/.test(app), "a token's name is escaped in the Collect button");
});

// ---- 0.18.170: Vestr amounts are never rounded; miniMall's vendor id is whole ----
test("Vestr vFmt shows the node's figure, never rounded; dp cuts, never rounds", () => {
  const vFmt = new Function(fnSrc("vFmt") + "\nreturn vFmt;")();
  assert.equal(vFmt("1234567.123456789123"), "1234567.123456789123", "every decimal the node wrote, no grouping");
  assert.equal(vFmt("0.999999999"), "0.999999999", "not 1"); assert.equal(vFmt("10.50000"), "10.5"); assert.equal(vFmt("7"), "7");
  assert.equal(vFmt(1e-9), "0.000000001"); assert.equal(vFmt("2.5E+3"), "2500"); assert.equal(vFmt(0.1 + 0.2, 6), "0.3", "dp cuts 0.30000000000000004");
  assert.equal(vFmt(0.6666666666, 6), "0.666666", "cut, not rounded to 0.666667"); assert.equal(vFmt("abc"), "0"); assert.equal(vFmt(null), "0"); assert.equal(vFmt(NaN), "0");
  assert.ok(!/toFixed\(/.test(app.slice(app.indexOf("const rerun = async () =>"), app.indexOf("const rerun = async () =>") + 1500).replace(/r\.weeks\.toFixed\(1\)/, "")), "the calculator's amounts are not rounded with toFixed");
});
test("miniMall Studio shows the vendor id and address whole and copyable", () => {
  assert.ok(app.includes('<div class="mono shop-card" style="overflow-wrap:anywhere">${idHtml(d.vendorPublicId || "")} | ${idHtml(d.vendorAddress || "")}</div>'));
  assert.ok(!/vendorPublicId \|\| ""\)\.slice\(/.test(app));
});

// ---- 0.18.178: the screens that put typed text into a node command refuse ";" (the node starts a second command there) ----
test("restore, resync, Web Wallet and backup screens refuse ';' in a seed, a file path or a password", () => {
  const BS = String.fromCharCode(92), count = (s) => app.split(s).length - 1;
  const checks = [
    ["if (/[\"" + BS + BS + ";]/.test(seed))", 2, "both restore screens"],
    ["if (/[\"" + BS + BS + ";" + BS + "n" + BS + "r" + BS + "t]/.test(seed))", 1, "Web Wallet unlock"],
    ["if (/[\"" + BS + BS + ";" + BS + "n" + BS + "r" + BS + "t]/.test(phrase))", 1, "Settings resync phrase"],
    ["if (/[" + BS + "s\"" + BS + BS + ";]/.test(file))", 1, "resync file"], ["if (/[" + BS + "s\"" + BS + BS + ";]/.test(password))", 1, "resync password"],
    ["if (/[\"" + BS + BS + ";]/.test(pw)", 1, "backup password"]];
  for (const [text, n, what] of checks) assert.equal(count(text), n, what + ": " + text);
  const seedRe = new RegExp("[\"" + BS + BS + ";]"); for (const s of ["apple; vault", 'a"b', "a" + BS + "b"]) assert.ok(seedRe.test(s)); assert.ok(!seedRe.test("apple banana cherry"));
});
