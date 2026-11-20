// What the main process says, in the app's language (0.19.157+, renderer/mainsaid.js). The REAL main functions are run
// here and what they say is read back: every sentence (and every sentence inside a list) must be a listed one, said in
// English exactly as main said it, and in zh / ru / uk with no English sentence left. Main itself is not changed by any
// of this; its English (and so its log) is what the other suites pin.
"use strict";
const test = require("node:test"), assert = require("node:assert");
const I18N = require("../renderer/i18n.js"); for (const c of ["en", "zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
const MS = require("../renderer/mainsaid.js");
const LANGS = ["zh", "ru", "uk"];

/** Every sentence of a reading, nested ones included, was read (none left unknown). → the codes met. */
function codesOf(r, where) {
  assert.ok(r, "not a listed sentence of main: " + JSON.stringify(where).slice(0, 300));
  const out = [r.code];
  for (const p of Object.keys(r.parts)) for (const b of r.parts[p]) if (b.said || !b.value) out.push(...codesOf(b.said, b.text));   // a value that is not a sentence is kept as it came
  return out;
}
const seen = new Set();
/** One message of main: read whole; English unchanged; each other language says it, with no English sentence of it left. */
function check(msg) {
  assert.equal(typeof msg, "string"); assert.ok(msg.length, "an empty message");
  I18N.set("en"); for (const c of codesOf(MS.read(msg), msg)) seen.add(c);
  assert.equal(MS.say(msg), msg, "English is said exactly as main said it");
  try {
    for (const code of LANGS) {
      I18N.set(code);
      const said = MS.say(msg);
      assert.notEqual(said, msg, code + ": translated: " + msg.slice(0, 120));
      for (const line of msg.split(/\n+/)) if (line.length > 24 && !/^[•\s]*[0-9A-Fa-fx, ]+$/.test(line)) assert.ok(!said.includes(line.replace(/^• /, "")), code + ": an English line left: " + line.slice(0, 120));
      assert.ok(!/\{\w+\}/.test(said), code + ": a placeholder left: " + said.slice(0, 200));
    }
  } finally { I18N.set("en"); }
}
const rejected = async (p) => { try { await p; } catch (e) { return e.message; } assert.fail("expected a refusal"); };

test("Freeze: every refusal and every reason in its list", async () => {
  const freeze = require("../main/freeze.js"), now = Date.now();
  const make = (o) => freeze.create(Object.assign({ load: () => [], save() {}, engines: { dexicon: { gate() {}, stop() {}, start() {} }, mail: { stop() { throw new Error("EBUSY"); }, start() {} } }, replacing: () => false, readMs: 30 }, o));
  check(await rejected(make().set("core", true))); check(await rejected(make().set("parlons", true))); check(await rejected(make().set("nope", true)));
  check(await rejected(make({ replacing: () => true }).set("dexicon", true)));
  check(await rejected(make().set("mail", true)));   // could not be stopped
  check(await rejected(make({ dexiconWork: async () => { throw new Error("x"); } }).set("dexicon", true)));
  check(await rejected(make({ dexiconWork: () => new Promise(() => {}) }).set("dexicon", true)));
  for (const w of [
    { atomix: null, pools: null, ownPools: null, dexicon: null, holds: null },
    { atomix: { ready: false, hasStore: true, swaps: ["a", "b"] }, pools: [], ownPools: [], dexicon: { ready: false, hasStore: true, takes: 0 }, holds: [] },
    { atomix: { ready: true, swaps: ["a"], maker: true, otcOffer: true, otcDeals: 1 }, pools: [{ type: "SWAP", ts: now }], ownPools: [{}], dexicon: { ready: true, takes: 1, unknown: 1, pending: 1 }, holds: [{}], now },
    { atomix: { ready: false, hasStore: true }, pools: [{ type: "SWAP", ts: now }, { type: "ADD", ts: now }], ownPools: [{}, {}], dexicon: { ready: false, hasStore: true, takes: 3, unknown: 2, pending: 5 }, holds: [{}, {}], now },
    { atomix: { ready: true, swaps: [], otcDeals: 4 }, pools: [], ownPools: [], dexicon: { ready: false, hasStore: true }, holds: null }
  ]) check(await rejected(make({ dexiconWork: async () => w }).set("dexicon", true)));
  for (const c of MS.codes().filter(c => /^(FREEZE|FZ)_/.test(c))) assert.ok(seen.has(c), "never said by main/freeze.js: " + c);
});

test("Restoring a backup and replacing the wallet: every refusal, every line of what stands in the way, and what going on means", async () => {
  const r = require("../main/restore.js");
  for (const [p, rec, sup] of [["", "classic", true], ["classic", "", true], ["block", "classic", false], ["block", "classic", true], ["classic", "block", true]]) check(r.backupModeProblem(p, rec, sup));
  for (const o of [{ host: "x" }, { host: "h:1" }, { host: "h:1", file: "a b" }, { host: "h:1", file: "a", password: "p q" }, { host: "h:1", file: "a;b" }, { host: "h:1", file: "a", password: "p;q" }]) check(r.restoreFileCommand(o).error);
  check(r.backupCommandProblem("backup password:a\"b"));
  check(await rejected(r.restoreBackup({ mode: "classic", host: "h:1", file: "f" }, { keyMode: "classic", supported: true, running: false })));
  const P = "MxG0" + "A".repeat(59), TX = "0x" + "AB".repeat(32), M = 3 * 60000;
  const worlds = [
    { atomix: null, pools: null, poolsState: {}, dexicon: null },
    { atomix: { ready: false, swaps: [TX, TX] }, pools: null, poolsState: { error: "SQLITE_CORRUPT: database disk image is malformed" }, dexicon: { ready: false, hasStore: true, waitedMs: M } },
    { atomix: { ready: false, swaps: [TX] }, pools: null, poolsState: { waitedMs: M }, dexicon: { ready: false, hasStore: true, waitedMs: 1000 } },
    { atomix: { ready: false, hasStore: true, error: "file is not a database" }, pools: [], dexicon: { ready: true, orders: [TX], pending: 1, takes: 1 }, ownPools: [{ address: P, reserveM: null }] },
    { atomix: { ready: false, hasStore: true, waitedMs: M }, pools: [{ txpowid: TX, confirmed: false }], dexicon: { ready: true, orders: [TX, TX], pending: 2, takes: 3 }, ownPools: [{ address: P, reserveM: "100.5", reserveT: "7", token: "MxUSD" }, { address: P, reserveM: "1", reserveT: "2", token: "Some Token" }] },
    { atomix: { ready: false, hasStore: true }, pools: [{ txpowid: TX, confirmed: false }, { txpowid: TX, confirmed: false }], casino: { offers: 1, bets: 2 } },
    { atomix: { ready: true, swaps: [TX], maker: true, otcOffer: true, otcDeals: 1 }, pools: [], casino: { offers: 0, bets: 1 } },
    { atomix: { ready: true, swaps: [TX, TX], otcDeals: 2 }, pools: [], dexicon: undefined, ownPools: [{ address: P, reserveM: null }] }
  ];
  for (const w of worlds) {
    const list = r.activeWorkList(w); assert.ok(list.length);
    check(r.activeWorkProblem(list)); check(r.skipWarning(list));
    const skipped = r.activeWorkList(Object.assign({ skipDexicon: true }, w)); if (skipped.length) check(r.activeWorkProblem(skipped));
  }
  check(r.skipWarning(r.activeWorkList({ atomix: { ready: true }, pools: [], dexicon: null })));   // Dexicon alone: its own text
  for (const c of MS.codes().filter(c => /^(RESTORE|REPLACE|RP|NO_WALLET|BACKUP|COUNT)_/.test(c))) assert.ok(seen.has(c), "never said by main/restore.js: " + c);
});

test("a message that is not listed is shown as it came, in every language; a value is never read as a sentence of its own", () => {
  for (const code of ["en", ...LANGS]) {
    I18N.set(code);
    for (const s of ["node says no", "", "Error: ENOENT", "• Something else."]) assert.equal(MS.say(s), s);
    assert.equal(MS.read("Unknown app. And more"), null, "a whole match only");
  }
  I18N.set("en");
  I18N.set("ru"); assert.equal(MS.say("It could not be stopped, so it is not frozen (EBUSY: resource busy). It is running as before."), I18N.t("It could not be stopped, so it is not frozen ({error}). It is running as before.", { error: "EBUSY: resource busy" }), "a value (the system's own error) is kept as it came");
  I18N.set("en");
});

test("the window: what main says reaches the screen through ipcError, and the restore screen decides by codes", () => {
  const fs = require("fs"), path = require("path"), app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"), html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(/function ipcError\(e\) \{ return MainSaid\.say\(ipcRaw\(e\)\); \}/.test(app));
  assert.ok(/warning = MainSaid\.say\(await api\.dxSkipWarning\(\)\)/.test(app) && !/you can go on without this check\\\./.test(app));
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(order.indexOf("mainsaid.js") > order.indexOf("i18n/en.js") && order.indexOf("mainsaid.js") < order.indexOf("app.js"), "after the English plural forms it reads, before the screens");
});

test("Key mode: every reason the node is not started, run from main/keymode.js", () => {
  const km = require("../main/keymode.js"), fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-km-")), conf = (text) => { const f = path.join(dir, "c" + Math.random().toString(36).slice(2) + ".conf"); fs.writeFileSync(f, text); return f; };
  try {
    for (const o of [{ mode: "" }, { mode: "block", folderMode: "classic" }, { mode: "classic", folderMode: "block" }, { mode: "block", supported: false },
      { mode: "classic", supported: true, extraArgs: "-blockaskeyuses true" }, { mode: "classic", supported: true, extraArgs: "-rpc 9005" },
      { mode: "classic", supported: true, params: { host: "-x" } }, { mode: "classic", supported: true, confFile: path.join(dir, "missing.conf") },
      { mode: "classic", supported: true, confFile: conf("lowram=true") }, { mode: "classic", supported: true, confFile: conf("data=/tmp/x") }]) check(km.startProblem(o));
    const D = path.join(dir, "data");
    for (const [argv, mode] of [[["-data", "/elsewhere"], "classic"], [["-Dparlons.node.data=/elsewhere"], "classic"], [["-Dparlons.node.conf=/x"], "classic"],
      [[], "block"], [["-blockaskeyuses", "true"], "block"], [["-lowram", "true"], "classic"]]) check(km.argvProblem(argv, mode, D));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// What node-manager, config and main.js say cannot all be run here (java, ports, Electron). Those templates are held to
// the source instead: every fixed piece of each one (the text between its values) is in the file that says it, in order.
test("node start, node kind, wallet replacement, config: each listed sentence is still in the file that says it", () => {
  const fs = require("fs"), path = require("path"), read = (f) => fs.readFileSync(path.join(__dirname, "..", "main", f), "utf8");
  const SRC = { NODE_: "node-manager.js", PORT_: "node-manager.js", ANOTHER_PROGRAM: "node-manager.js", PARLONS_: "node-manager.js", WR_: "node-manager.js", KM_ALERT_: "node-manager.js", KM_WHAT_: "node-manager.js",
    KM_MARK_FAILED: "node-manager.js", KM_CFG_: "config.js", KM_RECORD_UNSUPPORTED: "main.js", KM_KIND_UNSUPPORTED: "main.js", TERMINAL_RESTORE: "main.js" };
  const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  let n = 0;
  for (const code of MS.codes()) {
    const pre = Object.keys(SRC).find(p => code === p || (p.endsWith("_") && code.startsWith(p))); if (!pre) continue;
    const src = unescape(read(SRC[pre])), tpl = MS.template(code); n++;
    if (/^KM_(ALERT|CFG_FIXED|WHAT)_/.test(code)) continue;   // built around a mode word ("classic" / "block"): checked below as the builder main has
    let at = 0;
    for (const piece of tpl.split(/\{\w+\}/).map(x => x.trim()).filter(x => x.length >= 8)) {
      const i = src.indexOf(piece, at); assert.ok(i >= 0, code + ": not in main/" + SRC[pre] + " (in this order): " + piece.slice(0, 100)); at = i + piece.length;
    }
  }
  assert.ok(n >= 25, "the node-side templates are all checked (" + n + ")");
  // the variants built from a mode word, as main builds them
  const nm = read("node-manager.js"), cfg = read("config.js");
  assert.ok(nm.includes('"The wallet in this node holds keys of both kinds, classic and block" : "The node is running with " + seen + " keys"') && nm.includes('"The node started in block key mode"'));
  assert.ok(nm.includes('what + ", but this wallet is recorded as a " + mode + " key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. "'));
  assert.ok(cfg.includes('"This wallet\'s key mode is " + cur.keyMode + " and cannot be changed."'));
  // and they read back, in each language
  for (const seen of ["classic", "block"]) for (const mode of ["classic", "block"]) if (seen !== mode) check(("The node is running with " + seen + " keys") + ", but this wallet is recorded as a " + mode + " key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on.");
  check("The wallet in this node holds keys of both kinds, classic and block, but this wallet is recorded as a block key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on.");
  check("The node started in block key mode, but this wallet is recorded as a classic key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on.");
  for (const m of ["classic", "block"]) check("This wallet's key mode is " + m + " and cannot be changed.");
  check("Port 9001 (the node's RPC) is in use by another program (pid 77). minimaCore did not start its node and did not touch that program. Stop that program, or choose another base port in Startup Params.");
  for (const w of ["the node's P2P port", "the keets sidecar", "the Parlons wallet gateway", "the Parlons panel"]) check("Port 9001 (" + w + ") is in use by /usr/bin/java -jar x.jar (pid 77). minimaCore did not start its node and did not touch that program. Stop that program, or choose another base port in Startup Params.");
  for (const s of ["could not stop this app's node left running by an earlier launch (pid 12)", "could not launch java: ENOENT", "node exited unexpectedly (1)", "a port this node needs is already in use (base port 9001). Start again: this app's own earlier node is stopped first; any other program is named and left alone",
    "another node still holds this data folder's databases. Start again: if it is this app's own earlier node it is stopped first", "The data folder could not be marked as a block key wallet (EACCES). The node was not started.",
    "The Parlons Node is a mainnet node: a solo/private network needs the plain Minima node.", "The Parlons Node cannot take -dbpassword (a wallet DB password): keep the plain Minima node, or set up again without one.", "parlons-node.jar is not bundled in this build.",
    "The trading engines could not be stopped (busy), so the wallet was not replaced. Nothing was changed.", "timeout. The node did not answer, and it may still be resyncing: watch the Logs, and restart the node when it says it has finished.",
    "The node stopped before it answered, so the result is not known. It was started again: check the wallet and the chain before going on.", "-blockaskeyuses cannot be set in the extra arguments. The wallet's key mode sets it.", "-rpc cannot be set in the extra arguments. The app sets it itself.", "Unknown key mode.",
    "The node in this version of the app cannot run a block key wallet.", "This wallet uses block key uses, and that node cannot run it.", "Restoring a backup file replaces this wallet's keys. Use Backup & Recovery, Restore from file: it checks the backup's key mode first."]) check(s);
  // the program on the port is a value: kept as it came
  I18N.set("ru"); assert.ok(MS.say("Port 9001 (the node's RPC) is in use by /usr/bin/java -jar x.jar (pid 77). minimaCore did not start its node and did not touch that program. Stop that program, or choose another base port in Startup Params.").includes("/usr/bin/java -jar x.jar")); I18N.set("en");
});
