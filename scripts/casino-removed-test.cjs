// 0.18.318: P2P Chance (Zero Edge Casino) is removed: a stranger's coin state could become a node command (23 Nov 2026), so it waits
// for an audit and a rebuild. Nothing of it is loaded, listed, reachable or packaged; a wallet that ever switched it on is told once,
// and nothing it stored is deleted. Restore: see CHANGELOG 0.18.318.
// 0.18.330 (CHANGED on purpose): the removal left a wallet's open offers and bets with nothing to cancel, reveal or collect them. One
// settle-only module (main/casino-settle.js, its own suite scripts/casino-settle-test.cjs) and one plain dialog are allowed back, and
// nothing else: still no tab, view, bet, offer or take.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), Module = require("node:module");
const D = path.resolve(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(D, f), "utf8");
const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";

test("no app-list tab, view, script or sheet of the casino", () => {
  const html = rd("renderer/index.html");
  assert.doesNotMatch(html, /data-view="casino"|id="view-casino"|casino(art)?\.js|casino\.css|P2P Chance/i);
  const app = rd("renderer/app.js");
  assert.doesNotMatch(app, /CasinoPanel|casinoAgeGate|"casino"|id="setCasino"/);
  // the only casino calls of the window: the removal notice and the settle-only dialog (0.18.330)
  assert.deepEqual([...new Set([...app.matchAll(/api\.(\w*[cC]asino\w*)/g)].map((m) => m[1]))].sort(), ["casinoNotice", "casinoNoticeSeen", "casinoSettleCancelAll", "casinoSettleList", "casinoSettleOne", "onCasinoSettle"]);
});

test("no casino IPC channel, preload method or engine wiring", () => {
  const main = rd("main/main.js"), pre = rd("main/preload.js");
  assert.doesNotMatch(main, /require\("\.\/casino"\)|startCasinoIfEnabled|casino\.startLoop/);
  const SETTLE = /^mcd:casino(Notice|NoticeSeen|Settle|SettleList|SettleOne|SettleCancelAll)$/;   // 0.18.330: list, cancel, settle; no bet, offer or take
  for (const src of [main, pre]) for (const m of src.matchAll(/"(mcd:casino\w*)"/g)) assert.match(m[1], SETTLE, "an unexpected casino channel: " + m[1]);
  assert.doesNotMatch(main + pre, /casino(Create|Take|OpenBets|MyBets|Reveal|Resolve|Stakeable|SetCurrency|Balance)/i);
  assert.doesNotMatch(rd("main/stopguard.js"), /casino|P2P Chance/i);
});

test("main/casino* is not in the packaged file list", () => {
  const pkg = JSON.parse(rd("package.json"));
  assert.ok(!pkg.build.files.some((f) => /casino/i.test(f)), "no build.files entry names the casino");
  assert.ok(!Object.keys(pkg.scripts).some((k) => /casino/i.test(k) && k !== "test:casino-removed" && k !== "test:casino-settle"), "no casino suite left in scripts");
  // every packaged app file comes from main/** or renderer/**: walk both
  for (const f of pkg.build.files.filter((f) => !f.startsWith("node_modules/"))) assert.ok(["main/**", "renderer/**", "package.json"].includes(f), "unexpected build.files entry " + f);
  const walk = (d) => fs.readdirSync(path.join(D, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const hits = walk("main").concat(walk("renderer")).filter((f) => /casino/i.test(f));
  assert.deepEqual(hits, ["main/casino-settle.js"], "only the settle-only module is packaged (0.18.330); no engine, view or art");
  assert.match(rd(".github/workflows/desktop-build.yml"), /run: npm run test:casino-settle\n/, "the settle-only suite runs in CI");
  assert.doesNotMatch(rd(".github/workflows/desktop-build.yml"), /casino-glue|casino-parity|test:casino\s/);
  assert.match(rd(".github/workflows/desktop-build.yml"), /run: npm run test:casino-removed\n/, "this suite runs in CI");
});

test("the removal is said once to a wallet that switched it on, and only to it", () => {
  const main = rd("main/main.js"), a = main.indexOf("const CASINO_CONTRACT"), src = main.slice(a, main.indexOf("\n}\n", main.indexOf("function casinoRemovedNotice")) + 3);
  const notice = new Function(src + "\nreturn casinoRemovedNotice;")();
  assert.equal(notice({}), null, "a fresh install is not told");
  assert.equal(notice({ casinoEnabled: false, casinoAgeCertified: false }), null);
  assert.equal(notice({ casinoEnabled: true, casinoRemovedNoticeShown: true }), null, "said once");
  for (const cfg of [{ casinoEnabled: true }, { casinoAgeCertified: true }]) {
    const n = notice(cfg);
    assert.match(n.message, /P2P Chance has been removed/);
    assert.equal(n.command, "coins relevant:true address:" + CONTRACT, "the contract in full, in a command that lists the wallet's coins there");
    assert.equal(n.contract, CONTRACT);
    // 0.18.330: what the app still does, said truthfully
    assert.match(n.detail, /It reveals for an offer of yours that someone took, collects a bet you won, and claims a pot when the other side let the timeout pass/);
    assert.match(n.detail, /It does NOT cancel an open offer by itself, and it no longer renews one/);
    assert.match(n.detail, /only while it is open and the node is running/);
    assert.match(n.detail, /Cancel your open offers now: Settings, "P2P Chance was removed: your open offers and bets"/);
    assert.doesNotMatch(n.detail, /no longer cancels, renews, reveals, settles or claims/);
    assert.match(n.detail, /Nothing was moved or deleted/);
    assert.match(n.detail, /other side can take the whole pot/);
  }
  // 0.18.330: a dialog of the window (a native message box's text cannot be copied): asked for by the window, marked only when dismissed
  assert.ok(main.includes('ipcMain.handle("mcd:casinoNotice", () => casinoRemovedNotice(config.load()));'), "the window asks for it");
  assert.ok(main.includes('ipcMain.handle("mcd:casinoNoticeSeen", () => { config.setCasinoRemovedNoticeShown(); return true; });'));
  const app = rd("renderer/app.js");
  assert.ok(/api\.casinoNotice\(\)\.then\(n => \{ if \(n\) showCasinoNotice\(n\); \}\)/.test(app), "shown when the window is up");
  assert.equal(app.split("api.casinoNoticeSeen()").length - 1, 1, "marked in one place");
  assert.ok(/const done = \(open\) => \{[^\n]*api\.casinoNoticeSeen\(\)/.test(app), "marked only when it is dismissed");
});

test("nothing the casino stored is deleted: its config keys survive a save and the notice mark", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "casino-removed-")), real = Module._load;
  Module._load = function (req, ...rest) { return req === "electron" ? { app: { getPath: () => dir }, safeStorage: null } : real.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve("../main/config")];
    const config = require("../main/config");
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ casinoEnabled: true, casinoAgeCertified: true, casinoDollar: true, theme: "current" }));
    config.save({ theme: "original-dark", casinoEnabled: false });   // a patch can no longer change it either (not in DEFAULTS)
    config.setCasinoRemovedNoticeShown();
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual([j.casinoEnabled, j.casinoAgeCertified, j.casinoDollar, j.theme, j.casinoRemovedNoticeShown], [true, true, true, "original-dark", true]);
    assert.ok(!("casinoRemovedNoticeShown" in config.DEFAULTS), "the window cannot set or clear the mark");
  } finally { Module._load = real; delete require.cache[require.resolve("../main/config")]; fs.rmSync(dir, { recursive: true, force: true }); }
});
