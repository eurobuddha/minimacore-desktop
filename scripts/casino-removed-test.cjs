// 0.18.318: P2P Chance (Zero Edge Casino) is removed: a stranger's coin state could become a node command (23 Nov 2026), so it waits
// for an audit and a rebuild. Nothing of it is loaded, listed, reachable or packaged; a wallet that ever switched it on is told once,
// and nothing it stored is deleted. Restore: see CHANGELOG 0.18.318.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), Module = require("node:module");
const D = path.resolve(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(D, f), "utf8");
const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";

test("no app-list tab, view, script or sheet of the casino", () => {
  const html = rd("renderer/index.html");
  assert.doesNotMatch(html, /data-view="casino"|id="view-casino"|casino(art)?\.js|casino\.css|P2P Chance/i);
  const app = rd("renderer/app.js");
  assert.doesNotMatch(app, /CasinoPanel|api\.casino|setCasino|"casino"/);
});

test("no casino IPC channel, preload method or engine wiring", () => {
  const main = rd("main/main.js"), pre = rd("main/preload.js");
  assert.doesNotMatch(main, /mcd:casino|require\("\.\/casino"\)|startCasinoIfEnabled|casino\.startLoop/);
  assert.doesNotMatch(pre, /casino/i);
  assert.doesNotMatch(rd("main/stopguard.js"), /casino|P2P Chance/i);
});

test("main/casino* is not in the packaged file list", () => {
  const pkg = JSON.parse(rd("package.json"));
  assert.ok(!pkg.build.files.some((f) => /casino/i.test(f)), "no build.files entry names the casino");
  assert.ok(!Object.keys(pkg.scripts).some((k) => /casino/i.test(k) && k !== "test:casino-removed"), "no casino suite left in scripts");
  // every packaged app file comes from main/** or renderer/**: walk both
  for (const f of pkg.build.files.filter((f) => !f.startsWith("node_modules/"))) assert.ok(["main/**", "renderer/**", "package.json"].includes(f), "unexpected build.files entry " + f);
  const walk = (d) => fs.readdirSync(path.join(D, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const hits = walk("main").concat(walk("renderer")).filter((f) => /casino/i.test(f));
  assert.deepEqual(hits, [], "casino files would be packaged");
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
    assert.ok(n.detail.includes("coins relevant:true address:" + CONTRACT), "the contract in full, in a command that lists the wallet's coins there");
    assert.match(n.detail, /Nothing was moved or deleted/);
    assert.match(n.detail, /other side can take the whole pot/);
  }
  assert.ok(/win\.webContents\.once\("did-finish-load", sayCasinoRemoved\)/.test(main), "shown when the window has loaded");
  assert.ok(/\.then\(\(\) => config\.setCasinoRemovedNoticeShown\(\)\)/.test(main), "marked only after it was dismissed");
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
