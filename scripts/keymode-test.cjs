// The wallet's key mode (owner decision D1): recorded once, never changed, and the node is only ever started in
// it. Both capability states are covered by INJECTING the capability; the jars in resources/ are only read.
// Nothing here starts a node, and config lives in a temp folder behind a stand-in for electron.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const keymode = require("../main/keymode.js");
const PARAMS = require("../renderer/params.js");

// ---- a stand-in electron, so main/config.js and main/node-manager.js load without the app ----
let USERDATA = "";
const fakeElectron = { app: { getPath: () => USERDATA, isPackaged: false, getVersion: () => "0" }, safeStorage: null };
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : realLoad.call(this, request, ...rest); };
const config = require("../main/config.js");
config.rpcSecret = () => "test-secret";                    // never touch the real Keychain
const node = require("../main/node-manager.js");
test.after(() => { Module._load = realLoad; });

function freshInstall() { USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "keymode-test-")); return USERDATA; }
const dataDir = () => path.join(USERDATA, "node-data");
function makeNodeData() { fs.mkdirSync(path.join(dataDir(), "1.1"), { recursive: true }); fs.writeFileSync(path.join(dataDir(), "1.1", "wallet.db"), "x"); }
const stored = () => JSON.parse(fs.readFileSync(path.join(USERDATA, "config.json"), "utf8"));

/** A one-entry zip, built by hand (node has no zip writer): local header, central directory, end record. */
function zipWith(name, content, deflate) {
  const n = Buffer.from(name), raw = Buffer.from(content), data = deflate ? zlib.deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(deflate ? 8 : 0, 10);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + data.length, 16);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keymode-jar-")), "node.jar");
  fs.writeFileSync(file, Buffer.concat([local, n, data, cd, n, end]));
  return file;
}
const KEYS = "org/minima/system/params/ParamConfigurer$ParamKeys.class";

test("capability is read from the jar itself: the flag's name in the node's own parameter list", () => {
  assert.equal(keymode.jarSupportsBlock(zipWith(KEYS, "\0megammr\0blockaskeyuses\0lowram\0", true)), true, "a jar that knows the flag (deflated entry)");
  assert.equal(keymode.jarSupportsBlock(zipWith(KEYS, "\0megammr\0blockaskeyuses\0", false)), true, "stored entry");
  assert.equal(keymode.jarSupportsBlock(zipWith(KEYS, "\0megammr\0server\0isclient\0", true)), false, "a jar that does not");
  assert.equal(keymode.jarSupportsBlock(zipWith("some/Other.class", "blockaskeyuses", true)), false, "the word elsewhere in the jar does not count");
  assert.equal(keymode.jarSupportsBlock(path.join(os.tmpdir(), "no-such-node.jar")), false, "a missing jar");
  const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keymode-jar-")), "junk.jar"); fs.writeFileSync(junk, "not a zip");
  assert.equal(keymode.jarSupportsBlock(junk), false, "a file that is not a jar");
});

test("today's bundled jars do not support block mode (read only; skipped for a jar that is not in resources/)", () => {
  for (const name of ["minima.jar", "parlons-node.jar"]) {
    const jar = path.join(ROOT, "resources", name);
    if (fs.existsSync(jar)) assert.equal(keymode.jarSupportsBlock(jar), false, name);
  }
  assert.ok(/blockKeysSupported\(\) \{ return keymode\.jarSupportsBlock\(this\.jarPath\(\)\); \}/.test(fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8")),
    "one function, asked of whichever jar this node kind runs");
});

test("the start rule, both capability states: block flags only for a block wallet on a jar that knows them; never a silent classic start", () => {
  assert.deepEqual(keymode.startFlags("classic"), []);
  assert.deepEqual(keymode.startFlags("block"), ["-blockaskeyuses", "true", "-lowram", "true"], "each with its value, so no later token can be taken as one");
  for (const supported of [true, false]) {
    assert.equal(keymode.startProblem({ mode: "classic", supported, folderMode: "classic" }), "", "a classic wallet starts on either jar");
    assert.equal(keymode.startProblem({ mode: "classic", supported, folderMode: "" }), "");
    assert.ok(keymode.startProblem({ mode: "", supported }), "no recorded mode: no start");
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "block" }), "a classic install pointed at a block wallet's folder");
    assert.ok(keymode.startProblem({ mode: "block", supported, folderMode: "classic" }), "a block install pointed at a classic wallet's folder");
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "classic", extraArgs: "-txpowdbstore 3 -lowram" }));
    const conf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keymode-conf-")), "node.conf"); fs.writeFileSync(conf, "blockaskeyuses=true\n");
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "classic", confFile: conf }), "a -conf file may not set it either");
  }
  assert.equal(keymode.startProblem({ mode: "block", supported: true, folderMode: "block" }), "");
  const down = keymode.startProblem({ mode: "block", supported: false, folderMode: "block" });
  assert.ok(/cannot run it/.test(down) && /was not started/.test(down), "a downgrade is refused in plain words: " + down);
});

test("-blockaskeyuses and -lowram are refused as extra arguments and are not parameters", () => {
  for (const s of ["-lowram", "-blockaskeyuses", "-p2pnodes x:1 -LowRam", "--blockaskeyuses", '"-lowram"', "-blockaskeyuses=true", "-a b\n-lowram true"])
    assert.ok(PARAMS.keyModeArg(s), JSON.stringify(s) + " is caught");
  for (const s of ["", "-txpowdbstore 3", "-conf lowram.conf", "-lowrammode", "-p2pnodes blockaskeyuses.example:9001"]) assert.equal(PARAMS.keyModeArg(s), "", JSON.stringify(s) + " is not");
  const flags = [].concat(...PARAMS.GROUPS.map(g => g.items.map(i => i.flag))).concat(PARAMS.MANAGED);
  for (const f of PARAMS.KEY_MODE_FLAGS) assert.ok(!flags.includes(f), "-" + f + " is not in the parameter editor");
  freshInstall();
  assert.throws(() => config.save({ extraArgs: "-lowram" }), /cannot be set in the extra arguments/);
  assert.throws(() => config.save({ extraArgs: "-x 1 -blockaskeyuses" }), /-blockaskeyuses cannot be set/);
  const c = config.save({ params: { blockaskeyuses: true, lowram: true, megammr: true } });
  assert.ok(c.params.megammr === true && !("blockaskeyuses" in c.params) && !("lowram" in c.params) && !("blockaskeyuses" in stored().params));
});

test("a new install has no mode until a wallet is made; the mode is then recorded once", () => {
  freshInstall();
  assert.equal(config.load().keyMode, "");
  assert.equal(config.save({ setupDone: true }).keyMode, "", "saving settings does not invent one");
  assert.equal(config.recordKeyMode("classic"), "classic");
  assert.equal(stored().keyMode, "classic");
  assert.equal(config.recordKeyMode("classic"), "classic", "asking again for the same mode is fine");
  assert.throws(() => config.recordKeyMode("block"), /classic and cannot be changed/);
  assert.throws(() => config.recordKeyMode("fast"), /Unknown key mode/);
  assert.equal(stored().keyMode, "classic");
});

test("an install that already has node data and no record is classic, and there is no path from classic to block", () => {
  freshInstall(); makeNodeData();
  assert.equal(config.load().keyMode, "classic");
  assert.throws(() => config.recordKeyMode("block"), /classic and cannot be changed/);
  assert.equal(keymode.folderKeyMode(dataDir()), "classic", "and the refused attempt left no block marker behind");
  assert.equal(config.save({ keyMode: "block" }).keyMode, "classic", "a patch cannot set it");
  assert.equal(stored().keyMode, "classic", "any save writes the classic record down");
  freshInstall(); fs.mkdirSync(USERDATA, { recursive: true }); fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify({ setupDone: true, walletDone: true }));
  assert.equal(config.load().keyMode, "classic", "a finished wallet with no record (every install before 0.18.88) is classic");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(main.includes("if (c.keyMode) config.recordKeyMode(c.keyMode);"), "and that is written down at launch");
});

test("every config save path preserves a recorded mode", () => {
  for (const mode of ["classic", "block"]) {
    freshInstall();
    config.recordKeyMode(mode);
    const other = mode === "block" ? "classic" : "block";
    const patches = [{}, { keyMode: other }, { keyMode: "" }, { keyMode: null }, { nodeKind: "minima" }, { walletDone: true, setupDone: true }, { walletMode: "restore" },
      { params: { megammr: true } }, { labels: { a: "b" } }, { heapMb: 2048, openAtLogin: true }, { network: "solo", contribute: false, extraArgs: "-txpowdbstore 3" },
      Object.assign({}, config.DEFAULTS, { keyMode: other }), Object.assign({}, config.load(), { keyMode: other })];
    for (const p of patches) {
      assert.equal(config.save(p).keyMode, mode, "after save(" + JSON.stringify(Object.keys(p)) + ")");
      assert.equal(stored().keyMode, mode); assert.equal(config.load().keyMode, mode);
    }
    assert.throws(() => config.recordKeyMode(other), /cannot be changed/);
    assert.equal(stored().keyMode, mode);
  }
});

test("only recordKeyMode writes the mode, and every renderer save goes through config.save", () => {
  const dir = path.join(ROOT, "main");
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const writes = (src.match(/\.keyMode\s*=[^=]/g) || []).length;
    assert.equal(writes, f === "config.js" ? 2 : 0, f + ": the mode is assigned in config.js only (the derivation in load, the record in recordKeyMode)");
    if (f !== "config.js") assert.ok(!/config\.json/.test(src) || f === "node-manager.js" || !/writeFileSync\([^)]*config\.json/.test(src), f + " does not write config.json itself");
  }
  const cfg = fs.readFileSync(path.join(dir, "config.js"), "utf8");
  assert.equal((cfg.match(/writeFileSync\(configPath\(\)/g) || []).length, 2, "config.json is written by save() and recordKeyMode() only");
  assert.ok(cfg.includes('if (k === "keyMode") continue;'), "save() drops the key from every patch");
  const main = fs.readFileSync(path.join(dir, "main.js"), "utf8");
  assert.ok(/"mcd:recordKeyMode", \(_e, mode\) => \{\s*if \(mode === "block" && !node\.blockKeysSupported\(\)\) throw/.test(main), "block is refused on a jar that cannot run it, before anything is recorded");
});

test("a block wallet marks its data folder, so a lost config cannot turn it classic", () => {
  freshInstall();
  config.recordKeyMode("block");
  assert.equal(keymode.folderKeyMode(dataDir()), "block");
  makeNodeData();
  fs.unlinkSync(path.join(USERDATA, "config.json"));
  assert.equal(config.load().keyMode, "block", "read back from the folder");
  assert.throws(() => config.recordKeyMode("classic"), /block and cannot be changed/);
});

// ---- the node manager, with the capability injected ----
function manager(supported) { node.blockKeysSupported = () => supported; return node; }
const flat = (args) => args.join(" ");

test("classic wallet: neither flag is passed, on either jar and either node kind", () => {
  for (const supported of [true, false]) for (const nodeKind of ["minima", "parlons"]) {
    freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind, setupDone: true });
    const m = manager(supported);
    assert.equal(m.keyModeProblem(), "");
    assert.ok(!/blockaskeyuses|lowram/.test(flat(m.buildArgs())), nodeKind + ", supported=" + supported);
  }
});

test("block wallet on a jar that supports it: -blockaskeyuses -lowram, for both node kinds", () => {
  for (const nodeKind of ["minima", "parlons"]) {
    freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind, setupDone: true });
    const m = manager(true), args = m.buildArgs();
    assert.equal(m.keyModeProblem(), "");
    if (nodeKind === "minima") assert.ok(flat(args).includes(" -blockaskeyuses true -lowram true"));
    else assert.ok(/^-Dparlons\.node\.args=.* -blockaskeyuses true -lowram true/.test(args.find(a => a.startsWith("-Dparlons.node.args="))), "inside the Parlons Node's one argument string");
    assert.equal(keymode.argvProblem(args, "block", dataDir()), "", "and the finished argv passes the gate");
    assert.equal((flat(args).match(/-blockaskeyuses/g) || []).length, 1);
  }
});

test("block wallet on a jar that does not support it: the node is REFUSED, never started classic", async () => {
  freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true });
  const m = manager(false);
  let reclaimed = false; const realReclaim = m.reclaimStaleNode; m.reclaimStaleNode = async () => { reclaimed = true; return "test: stop here"; };
  await m.start();
  assert.equal(m.state, "error");
  assert.ok(/block key uses/.test(m.lastError) && /was not started/.test(m.lastError), m.lastError);
  assert.equal(reclaimed, false, "refused before anything else ran: no stale-node reclaim, no java");
  assert.equal(m.proc, null);
  // the same install on a jar that supports it gets past the gate (and is stopped by this test before any java)
  manager(true); await m.start();
  assert.equal(reclaimed, true); assert.equal(m.lastError, "test: stop here"); assert.equal(m.proc, null);
  m.reclaimStaleNode = realReclaim;
});

test("no wallet yet, or a key-mode flag smuggled into a saved config: no start", async () => {
  freshInstall();
  const m = manager(true); const realReclaim = m.reclaimStaleNode; m.reclaimStaleNode = async () => "test: stop here";
  await m.start();
  assert.ok(/No wallet has been set up yet/.test(m.lastError));
  config.recordKeyMode("classic");
  fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify(Object.assign(stored(), { extraArgs: "-blockaskeyuses" })));   // written behind the app's back
  await m.start();
  assert.ok(/-blockaskeyuses is in the extra arguments/.test(m.lastError), m.lastError);
  assert.ok(!flat(m.buildArgs()).includes("blockaskeyuses"), "and buildArgs would drop it even so");
  config.save({ nodeKind: "parlons" });
  assert.ok(!flat(m.buildArgs()).includes("blockaskeyuses"));
  m.reclaimStaleNode = realReclaim;
});

// ---- 0.18.93: the gate on the finished argv (audit H1, H2, M3) ----
const { EventEmitter } = require("events");
/** A start that runs every step but java: a stand-in child, no stale-node search, no RPC polling. Returns the spawn calls. */
function fakeJava(m) {
  const calls = [], real = { spawnFn: m.spawnFn, startHealth: m.startHealth, reclaimStaleNode: m.reclaimStaleNode, rpc: m.rpc };
  m.rpc = async () => { throw new Error("test: no RPC"); };   // never a real node's port
  m.spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 0; p.kill = (sig) => { calls.killed = sig; }; calls.proc = p; return p; };
  m.startHealth = () => {}; m.reclaimStaleNode = async () => "";
  calls.realHealth = () => { m.startHealth = real.startHealth; };
  calls.restore = () => { m.stopHealth(); Object.assign(m, real); m.proc = null; m.state = "stopped"; m.keyModeAlert = ""; m.keyModeChecked = false; };
  return calls;
}
const KINDS = ["minima", "parlons"];

test("H1: a key-mode flag given as a parameter VALUE is refused, by the value rule and by the gate on the finished argv, for both node kinds", async () => {
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind, setupDone: true, params: { host: "-blockaskeyuses" } });
    const m = manager(true), args = m.buildArgs();
    assert.ok(/blockaskeyuses/.test(flat(args)), "the flag is in the argv the old code would have run (" + nodeKind + ")");
    assert.ok(/value of -host starts with a dash/.test(m.keyModeProblem()), m.keyModeProblem());
    const why = keymode.argvProblem(args, "classic", dataDir());
    assert.ok(/was not started/.test(why) && /-blockaskeyuses/.test(why), "the gate alone catches it: " + why);
    // even with the first check out of the way, start() runs no java
    const calls = fakeJava(m), realProblem = m.keyModeProblem; m.keyModeProblem = () => "";
    await m.start();
    assert.equal(calls.length, 0); assert.equal(m.state, "error"); assert.ok(/-blockaskeyuses/.test(m.lastError), m.lastError);
    m.keyModeProblem = realProblem; calls.restore();
  }
});

test("the gate reads the argv as the node will: every form of the flag, wrong values, repeats and a missing flag", () => {
  const D = "/data/folder", base = ["-jar", "/x/minima.jar", "-data", D, "-basefolder", D, "-port", "12001"];
  const parlons = (flags) => ["-Xmx1536m", "-Dparlons.node.data=" + D, "-Dparlons.node.args=-basefolder \"" + D + "\" " + flags, "-jar", "/x/parlons-node.jar"];
  assert.equal(keymode.argvProblem(base, "classic", D), "");
  assert.equal(keymode.argvProblem(base.concat("-blockaskeyuses", "true", "-lowram", "true"), "block", D), "");
  assert.equal(keymode.argvProblem(parlons("-keets"), "classic", D), "");
  assert.equal(keymode.argvProblem(parlons("-blockaskeyuses true -lowram true -keets"), "block", D), "");
  for (const extra of [["-blockaskeyuses"], ["-lowram"], ["--blockaskeyuses"], ["-BlockAsKeyUses"], ["-lowram=true"], ["-host", "-lowram"], ["-lowram", "false"]]) {
    assert.ok(keymode.argvProblem(base.concat(extra), "classic", D), "classic + " + extra.join(" "));
    assert.ok(keymode.argvProblem(parlons(extra.join(" ")), "classic", D), "classic, Parlons + " + extra.join(" "));
    assert.ok(keymode.argvProblem(parlons('-host "' + extra[extra.length > 1 && extra[0] === "-host" ? 1 : 0] + '"'), "classic", D), "quoted as a value inside the Parlons string");
  }
  for (const flags of [["-blockaskeyuses", "-lowram"], ["-blockaskeyuses", "true", "-lowram", "false"], ["-blockaskeyuses", "true"], ["-lowram", "true", "-blockaskeyuses", "true"],
    ["-blockaskeyuses", "true", "-lowram", "true", "-lowram", "false"], ["-blockaskeyuses", "true", "-lowram", "true", "-blockaskeyuses", "false"], []]) {
    assert.ok(keymode.argvProblem(base.concat(flags), "block", D), "block + [" + flags.join(" ") + "]");
    assert.ok(keymode.argvProblem(parlons(flags.join(" ")), "block", D), "block, Parlons + [" + flags.join(" ") + "]");
  }
  assert.deepEqual(keymode.nodeTokens(["-Dparlons.node.args=-a \"b c\" 'd e' f\\ g \"h\\\"i\" x\"-lowram\""]), ["-a", "b c", "d e", "f g", 'h"i', "x-lowram"], "the Parlons Node's own tokeniser, ported");
});

test("M3: -lowram cannot be switched off by the token after it", async () => {
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind, setupDone: true, extraArgs: "false" });
    const m = manager(true), calls = fakeJava(m);
    await m.start();
    assert.equal(calls.length, 1, m.lastError || "");
    const toks = keymode.nodeTokens(calls[0].args), i = toks.indexOf("-lowram"), j = toks.indexOf("-blockaskeyuses");
    assert.equal(toks[i + 1], "true", nodeKind + ": -lowram keeps its own value"); assert.equal(toks[j + 1], "true");
    calls.restore();
  }
});

test("H2a: a -conf file is refused wherever it is named, and is read when it is the app's own parameter", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keymode-conf-")), file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const bad = file("block.conf", "txpowdbstore=3\nblockaskeyuses=true\n"), low = file("low.conf", "LowRam=true\n"), moved = file("moved.conf", "data=/somewhere/else\n"), fine = file("fine.conf", "txpowdbstore=3\n");
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind, setupDone: true });
    const m = manager(true);
    assert.throws(() => config.save({ extraArgs: "-conf " + bad }), /-conf cannot be set in the extra arguments/);
    fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify(Object.assign(stored(), { extraArgs: "-conf " + bad })));   // behind the app's back
    assert.ok(/-conf is in the extra arguments/.test(m.keyModeProblem()), m.keyModeProblem());
    assert.ok(/-conf sets -blockaskeyuses or -lowram/.test(keymode.argvProblem(m.buildArgs(), "classic", dataDir())), "and the gate reads the file the argv names");
    fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify(Object.assign(stored(), { extraArgs: "" })));
    for (const [f, re] of [[bad, /sets -blockaskeyuses or -lowram/], [low, /sets -blockaskeyuses or -lowram/], [moved, /sets data, which the app sets itself/], [path.join(dir, "missing.conf"), /could not be read/]]) {
      config.save({ params: { conf: f } });
      assert.ok(re.test(m.keyModeProblem()), nodeKind + " " + path.basename(f) + ": " + m.keyModeProblem());
      assert.ok(re.test(keymode.argvProblem(m.buildArgs(), "classic", dataDir())), "the gate too");
      const calls = fakeJava(m); await m.start(); assert.equal(calls.length, 0); calls.restore();
    }
    config.save({ params: { conf: fine } });
    assert.equal(m.keyModeProblem(), ""); assert.equal(keymode.argvProblem(m.buildArgs(), "classic", dataDir()), "");
  }
  assert.ok(keymode.argvProblem(["-Dparlons.node.conf=" + fine, "-jar", "x.jar"], "classic", "/d"), "the Parlons Node's own conf property is never passed");
});

test("H2b: the extra arguments cannot name a parameter the app sets itself, so the node cannot be pointed at another folder", async () => {
  for (const s of ["-data /other", "-basefolder /other", "-x 1 -Data /other", '"-data" /other', "--basefolder=/other", "-port 9001", "-rpcpassword x", "-daemon", "-conf a.conf", "-seed a"])
    assert.ok(PARAMS.reservedArg(s), JSON.stringify(s) + " is caught");
  for (const s of ["", "-txpowdbstore 3", "-p2pnodes data.example:9001", "-database x"]) assert.equal(PARAMS.reservedArg(s), "", JSON.stringify(s) + " is not");
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind, setupDone: true });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "keymode-other-")); fs.mkdirSync(path.join(other, "1.1")); fs.writeFileSync(path.join(other, "1.1", "wallet.db"), "classic wallet");
    assert.throws(() => config.save({ extraArgs: "-data " + other }), /-data cannot be set in the extra arguments/);
    fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify(Object.assign(stored(), { extraArgs: "-data " + other + " -basefolder " + other })));
    const m = manager(true);
    assert.ok(/-data is in the extra arguments/.test(m.keyModeProblem()), m.keyModeProblem());
    assert.ok(/folder other than this install's data folder/.test(keymode.argvProblem(m.buildArgs(), "block", dataDir())), "the gate alone: " + keymode.argvProblem(m.buildArgs(), "block", dataDir()));
    const calls = fakeJava(m); await m.start(); assert.equal(calls.length, 0); assert.equal(m.state, "error"); calls.restore();
  }
  assert.ok(keymode.argvProblem(["-Dparlons.node.data=/other", "-Dparlons.node.args=-basefolder /d", "-jar", "x.jar"], "classic", "/d"));
});

test("H2c: the node is started without MINIMA_*, PARLONS_* and JVM option variables", async () => {
  const env = keymode.childEnv({ PATH: "/bin", HOME: "/h", MINIMA_BLOCKASKEYUSES: "true", minima_lowram: "true", Minima_Data: "/x", PARLONS_NODE_ARGS: "-blockaskeyuses", JAVA_TOOL_OPTIONS: "-Dparlons.node.conf=/x", _JAVA_OPTIONS: "-Dx=1", JDK_JAVA_OPTIONS: "-Dx=1", MINIMALIST: "kept" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", MINIMALIST: "kept" });
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true });
  const m = manager(true), calls = fakeJava(m);
  process.env.MINIMA_BLOCKASKEYUSES = "true"; process.env.PARLONS_NODE_ARGS = "-blockaskeyuses"; process.env.JAVA_TOOL_OPTIONS = "-Dparlons.node.conf=/x";
  try { await m.start(); } finally { delete process.env.MINIMA_BLOCKASKEYUSES; delete process.env.PARLONS_NODE_ARGS; delete process.env.JAVA_TOOL_OPTIONS; }
  assert.equal(calls.length, 1, m.lastError || "");
  const passed = calls[0].opts.env;
  assert.ok(passed && passed.PATH === process.env.PATH, "an explicit environment, with the ordinary variables");
  assert.ok(!Object.keys(passed).some(k => /^(minima_|parlons_)/i.test(k) || /java_tool_options/i.test(k)), Object.keys(passed).filter(k => /minima|parlons|java/i.test(k)).join(","));
  calls.restore();
});

// ---- 0.18.94: the folder marker in both directions (H4) and the running node's real mode (M5) ----
const marker = (dir) => path.join(dir, keymode.MARKER);
const writeConfig = (o) => fs.writeFileSync(path.join(USERDATA, "config.json"), JSON.stringify(o));

test("H4: a block wallet whose data folder is changed to an empty one is marked at start, before java, and is not locked out on the next start", async () => {
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("block");
    const moved = path.join(USERDATA, "moved"); fs.mkdirSync(moved);
    config.save({ nodeKind, setupDone: true, walletDone: true, dataFolder: moved });
    const m = manager(true), calls = fakeJava(m);
    let markedAtSpawn = null; const spawnFn = m.spawnFn; m.spawnFn = (...a) => { markedAtSpawn = fs.existsSync(marker(moved)); return spawnFn(...a); };
    assert.equal(fs.existsSync(marker(moved)), false);
    await m.start();
    assert.equal(calls.length, 1, m.lastError || ""); assert.equal(markedAtSpawn, true, "the folder says block before the node touches it");
    calls.restore();
    fs.mkdirSync(path.join(moved, "1.1")); fs.writeFileSync(path.join(moved, "1.1", "wallet.db"), "x");   // what the first run leaves
    assert.equal(m.keyModeProblem(), "", "second start: not refused as classic");
    // the config is lost: the folder still says block, so the wallet cannot start classic
    writeConfig({ dataFolder: moved, walletDone: true, setupDone: true, nodeKind });
    assert.equal(config.load().keyMode, "block");
    assert.ok(/-blockaskeyuses true -lowram true/.test(flat(m.buildArgs())));
  }
});

test("H4: config lost, config restored from an older copy, marker deleted: the folder and the record never disagree silently", async () => {
  // an older config (before the mode existed: no keyMode, wallet done) put back over a block wallet
  freshInstall(); config.recordKeyMode("block"); makeNodeData();
  writeConfig({ setupDone: true, walletDone: true });
  assert.equal(config.load().keyMode, "block", "the marker outranks 'a finished wallet with no record is classic'");
  // an older config that says classic, put back over a block wallet: refused
  writeConfig({ setupDone: true, walletDone: true, keyMode: "classic", nodeKind: "minima" });
  const m = manager(true); let calls = fakeJava(m);
  await m.start();
  assert.equal(calls.length, 0); assert.ok(/holds a block key wallet, but this install is set up for classic keys/.test(m.lastError), m.lastError);
  calls.restore();
  // an older config that says block, put back over a classic wallet's folder: refused, and the folder is NOT marked
  freshInstall(); makeNodeData(); writeConfig({ setupDone: true, walletDone: true, keyMode: "block", nodeKind: "minima" });
  calls = fakeJava(m); await m.start();
  assert.equal(calls.length, 0); assert.ok(/not marked as a block key wallet/.test(m.lastError), m.lastError);
  assert.equal(fs.existsSync(marker(dataDir())), false, "a refused start writes no marker");
  calls.restore();
  // the marker deleted from a block wallet that has data: the app cannot tell it from a classic folder, so it refuses and does not re-mark
  freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true }); makeNodeData();
  fs.unlinkSync(marker(dataDir()));
  calls = fakeJava(m); await m.start();
  assert.equal(calls.length, 0); assert.ok(/will not guess/.test(m.lastError), m.lastError);
  assert.equal(fs.existsSync(marker(dataDir())), false);
  calls.restore();
  // the marker deleted before the node ever made data (an empty folder): put back at start
  freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind: "minima", setupDone: true }); fs.unlinkSync(marker(dataDir()));
  calls = fakeJava(m); await m.start();
  assert.equal(calls.length, 1, m.lastError || ""); assert.equal(fs.existsSync(marker(dataDir())), true);
  calls.restore();
  // the other direction: a classic wallet's start never writes a marker
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true });
  calls = fakeJava(m); await m.start();
  assert.equal(calls.length, 1, m.lastError || ""); assert.equal(fs.existsSync(marker(dataDir())), false);
  calls.restore();
});

const keysReply = (...shapes) => ({ status: true, response: { keys: shapes.map(([size, depth]) => ({ size, depth, uses: 1, maxuses: size ** depth, publickey: "0x00" })), total: shapes.length } });
test("M5: the key shapes in the node's own reply say which mode it runs in", () => {
  assert.equal(keymode.keysMode(keysReply([64, 3], [64, 3])), "classic");
  assert.equal(keymode.keysMode(keysReply([128, 4])), "block");
  assert.equal(keymode.keysMode(keysReply([64, 3], [128, 4])), "mixed");
  assert.equal(keymode.keysMode(keysReply(["64", "3"])), "classic", "numbers sent as text");
  for (const r of [keysReply(), keysReply([32, 2]), null, {}, { status: false, error: "x" }, { response: { keys: "no" } }]) assert.equal(keymode.keysMode(r), "", JSON.stringify(r));
});

test("M5: a node found running in the other key mode is stopped at once, is never called running, and is not started again", async () => {
  const cases = [["classic", [[128, 4]], /running with block keys/], ["block", [[64, 3], [64, 3]], /running with classic keys/], ["classic", [[64, 3], [128, 4]], /keys of both kinds/]];
  for (const nodeKind of KINDS) for (const [mode, shapes, re] of cases) {
    freshInstall(); config.recordKeyMode(mode); config.save({ nodeKind, setupDone: true, walletDone: true });
    const m = manager(true), calls = fakeJava(m), sent = [], states = [];
    m.rpc = async (c) => { sent.push(c); if (c === "quit") { setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true }; } return c === "keys" ? keysReply(...shapes) : { status: true, response: { chain: { block: 5 } } }; };
    const onStatus = (s) => states.push(s.state); m.on("status", onStatus);
    calls.realHealth();
    await m.start();
    for (let i = 0; i < 200 && !(m.state === "error" && !m.proc); i++) await new Promise(r => setTimeout(r, 10));
    m.off("status", onStatus);
    assert.equal(m.state, "error", nodeKind + " " + mode); assert.equal(m.proc, null, "the node is gone");
    assert.ok(!states.includes("running"), "never called running, so no module started on it: " + states.join(","));
    assert.ok(re.test(m.lastError) && /stopped at once/.test(m.lastError), m.lastError);
    assert.equal(m.snapshot().keyModeAlert, m.lastError, "the window is told");
    assert.deepEqual([...new Set(sent)].sort(), ["keys", "quit", "status"], "the check only lists keys: nothing signs, nothing creates a key");
    const before = calls.length; await m.start();
    assert.equal(calls.length, before, "and it is not started again in this run"); assert.equal(m.state, "error");
    calls.restore();
  }
});

test("M5: a node in the recorded mode runs; no keys yet or no answer is asked again, never guessed", async () => {
  for (const [mode, shape] of [["classic", [64, 3]], ["block", [128, 4]]]) {
    freshInstall(); config.recordKeyMode(mode); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
    const m = manager(true), calls = fakeJava(m), sent = [];
    let reply = () => { throw new Error("not up yet"); };
    m.rpc = async (c) => { sent.push(c); if (c === "keys") return reply(); return { status: true, response: {} }; };
    await m.start();
    assert.equal(await m.verifyKeyMode(), true); assert.equal(m.keyModeChecked, false, "no answer: not verified, not stopped");
    reply = () => keysReply();
    assert.equal(await m.verifyKeyMode(), true); assert.equal(m.keyModeChecked, false, "no keys yet: asked again");
    reply = () => keysReply(shape, shape);
    assert.equal(await m.verifyKeyMode(), true); assert.equal(m.keyModeChecked, true);
    const n = sent.length; await m.verifyKeyMode(); assert.equal(sent.length, n, "once verified it is not asked again in this run");
    assert.ok(m.proc && !m.keyModeAlert && !sent.includes("quit"));
    calls.restore();
  }
});

// The node's own line, as MinimaLogger.log prints MinimaDB.loadAllDB's words.
const BOOT = "Minima @ 20/11/2026 09:14:02 [112.4 MB] : Using NEW Block number as key uses keys!";
const HEX324 = "0x" + "30819F300D06092A864886F70D010101050003818D0030818902818100".padEnd(324, "C4");
test("M5: the node's own boot line 'block mode is on' stops a classic wallet's node before any RPC", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m);
  await m.start();
  calls.proc.stdout.emit("data", BOOT + "\n");
  assert.equal(calls.killed, "SIGKILL"); assert.ok(/started in block key mode/.test(m.keyModeAlert), m.keyModeAlert);
  calls.restore();
  freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const c2 = fakeJava(m); await m.start();
  c2.proc.stdout.emit("data", BOOT + "\n");
  assert.equal(c2.killed, undefined, "a block wallet's node says the same line and runs on"); assert.equal(m.keyModeAlert, "");
  c2.restore();
});

// ---- 0.19.4: the node's log carries peers' text; only the node's own whole lines are believed ----
test("0.19.4: a line that only HOLDS the block-mode words (a peer's greeting version, a message, a cut line) does not stop a classic wallet's node", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m);
  await m.start();
  const P = "Using NEW Block number as key uses";
  for (const line of [
    "Minima @ 20/11/2026 09:14:02 [112.4 MB] : Greeting with Incompatible Version! " + P + " keys! .. we are 1.0.45 from 203.0.113.9:9001 incoming:true",   // core NIOMessage: the peer's version, verbatim
    P + " keys!", "x " + BOOT, BOOT + " ", BOOT + " from Mallory → pushing to devices", "Minima @ 19/11/2026 : " + P + " keys!",
    "[parlons-node] message from " + HEX324 + ": " + BOOT, "[parlons-node] node: call " + BOOT + " from Mallory → pushing to devices",
    "[parlons-node] heartbeat: " + BOOT])
    calls.proc.stdout.emit("data", line + "\n");
  assert.equal(calls.killed, undefined); assert.equal(m.keyModeAlert, "");
  // a line end INSIDE the peer's text: what follows the cut line is the peer's, up to the node's own ending
  calls.proc.stdout.emit("data", "Minima @ 20/11/2026 09:14:02 [112.4 MB] : Greeting with Incompatible Version! 1.0\n" + BOOT + "\n .. we are 1.0.45 from 203.0.113.9:9001 incoming:true\n");
  calls.proc.stdout.emit("data", "[parlons-node] node: call x\r" + BOOT + "\r\n from Mallory → pushing to devices\n");
  assert.equal(calls.killed, undefined, "a forged whole line inside a cut line"); assert.equal(m.keyModeAlert, "");
  assert.ok(m.logs.some(l => l === "(continued) " + BOOT), "it is logged, marked as a continuation");
  calls.proc.stdout.emit("data", "\u0007" + BOOT.slice(0, 20) + "\u0000" + BOOT.slice(20) + "\n");
  assert.equal(calls.killed, "SIGKILL", "the run ended with the node's own ending: its own line (control characters removed) is believed again");
  calls.restore();
});

test("0.19.4: the boot line is believed only before this start's first health poll; after 'running' it is ignored", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m);
  m.rpc = async (c) => c === "keys" ? keysReply([64, 3]) : { status: true, response: { chain: { block: 5 } } };
  calls.realHealth();
  await m.start();
  for (let i = 0; i < 200 && m.state !== "running"; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(m.state, "running");
  calls.proc.stdout.emit("data", BOOT + "\n");
  assert.equal(calls.killed, undefined); assert.equal(m.keyModeAlert, ""); assert.equal(m.state, "running");
  calls.restore();
  // ...and the next start believes it again
  const c2 = fakeJava(m); await m.start();
  c2.proc.stdout.emit("data", BOOT + "\n");
  assert.equal(c2.killed, "SIGKILL");
  c2.restore();
});

test("0.19.4: the Parlons flags are read from the jar's own line starts, only until the account is up; a forged line sets none and raises no notification", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m), events = [];
  const onEv = (e) => events.push(e); m.on("parlons-event", onEv);
  await m.start();
  const out = (t) => calls.proc.stdout.emit("data", t + "\n");
  // phrases inside other lines: nothing
  for (const l of ["Minima @ 20/11/2026 09:14:02 [112.4 MB] : [parlons-node] account layer FAILED to start: x", "[parlons-node] heartbeat: account up: Maxima cape up on port 1 REFUSING to start: x Parlons Node 9.9.9 ",
    "[parlons-node]account up: x", " [parlons-node] account up: x", "[parlons-node] P2P rootnode: account layer FAILED to start: x"]) out(l);
  assert.deepEqual(m.parlons, { ready: false, error: "", version: "", cape: false });
  // the jar's own lines
  out("[parlons-node] Parlons Node 0.2.152 — booting embedded Minima node 1.0.45 at /x");
  out("[parlons-node] Maxima cape up on port 9001 — identity MAX#0x");
  out("[parlons-node] account layer FAILED to start: java.lang.IllegalStateException: boom");
  assert.deepEqual(m.parlons, { ready: false, error: "account layer FAILED to start: java.lang.IllegalStateException: boom", version: "0.2.152", cape: true });
  out("[parlons-node] account up: attached to 3 relay(s), ");
  assert.equal(m.parlons.ready, true); assert.equal(m.parlons.error, "");
  // a contact's call signal whose state holds a line end (ParlonsControl prints it as it came), with forged lines after it
  const FAKE_MSG = "[parlons-node] message from " + HEX324 + ": your wallet is at risk, open http://evil.example";
  calls.proc.stdout.emit("data", "[parlons-node] node: call x\n[parlons-node] account layer FAILED to start: call 555-0100\n" + FAKE_MSG + "\n[parlons-node] node: call offer from Your Bank → pushing to devices\n");
  calls.proc.stdout.emit("data", "[parlons-node] node: call x\r[parlons-node] Maxima cape FAILED to start: y\r from Mallory → pushing to devices\n");
  assert.equal(m.parlons.error, "", "no forged account error"); assert.equal(m.parlons.ready, true);
  assert.deepEqual(events, [], "and no notification from a forged message or call line");
  // even a forged line the app cannot tell from the jar's own changes nothing once the account is up
  out("[parlons-node] account layer FAILED to start: forged");
  out("[parlons-node] REFUSING to start: forged");
  assert.equal(m.parlons.error, "");
  // the real ones still arrive
  out("[parlons-node] message from 0x" + "FA4E".repeat(16) + ": hello");
  out("[parlons-node] node: call offer from Mirela Okafor → pushing to devices");
  assert.deepEqual(events.map(e => e.type), ["message", "call"]);
  assert.ok(!m.logs.some(l => /hello|your wallet is at risk/.test(l) && !l.startsWith("(continued) ")), "message text stays out of the log");
  m.off("parlons-event", onEv); calls.restore();
});

// ---- 0.18.97: M2, the restart after megammrsync goes through the guarded start ----
test("M2: megammrsync ends with the node shutting down; that is not an error, and the node is started again through every start check", async () => {
  for (const nodeKind of KINDS) {
    freshInstall(); config.recordKeyMode("block"); config.save({ nodeKind, setupDone: true, walletDone: true });
    const m = manager(true), calls = fakeJava(m), states = [], seenResyncing = [];
    const onStatus = (s) => { states.push(s.state); seenResyncing.push(s.resyncing); }; m.on("status", onStatus);
    await m.start();
    const first = calls.proc;
    m.rpc = async (c) => { if (c === "quit") { setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true }; }
      first.emit("exit", 0, null);   // the node exits by itself as it answers
      return { status: true, response: { message: "MegaMMR sync fininshed.. please restart" } }; };
    const j = await m.runResync("megammrsync action:resync host:megammr.example:9001");
    m.off("status", onStatus);
    assert.equal(j.status, true);
    assert.ok(!states.includes("error"), "no 'node exited unexpectedly' after a resync that worked: " + states.join(","));
    assert.equal(calls.length, 2, "started again"); assert.ok(m.proc && m.proc !== first);
    assert.equal(keymode.argvProblem(calls[1].args, "block", dataDir()), "", "by the ordinary start: the gate passed on this argv");
    assert.ok(seenResyncing.includes(true) && m.snapshot().resyncing === false, "the window is told while it lasts");
    assert.equal(m.lastError, null);
    calls.restore();
  }
});

// ---- 0.18.106: a megammrsync that replaces the wallet resets the identity-bound stores in the MAIN process, node stopped ----
test("a wallet-replacing megammrsync calls onWalletReplaced after the old node is gone and before the new one is spawned; a chain-only resync does not", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true });
  const m = manager(true); let calls = fakeJava(m);
  const seen = []; m.onWalletReplaced = async () => { await new Promise(r => setImmediate(r)); seen.push({ proc: !!m.proc, state: m.state, javas: calls.length }); };
  const answers = () => { m.rpc = async (c) => { if (c === "quit") { setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true }; } return { status: true, response: {} }; }; };
  try {
    await m.start(); answers();
    await m.runResync("megammrsync action:resync host:megammr.example:9001");
    assert.deepEqual(seen, [], "the wallet stays: nothing is reset"); assert.equal(calls.length, 2);
    for (const cmd of ['megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE" keyuses:1000', "megammrsync action:resync host:megammr.example:9001 file:wallet.bak password:abc"]) {
      seen.length = 0; const before = calls.length; answers();
      await m.runResync(cmd);
      assert.deepEqual(seen, [{ proc: false, state: "stopped", javas: before }], "reset once, with the node stopped and no new java yet: " + cmd);
      assert.equal(calls.length, before + 1, "then the node is started");
    }
    // refused by the node: the wallet is as it was, nothing is reset
    seen.length = 0; m.rpc = async () => ({ status: false, error: "Could not connect to host" });
    await m.runResync('megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE"');
    assert.deepEqual(seen, []);
    // no answer (the result is not known), node still there: reset all the same, and nothing is restarted
    let n = calls.length; m.rpc = async () => { throw new Error("RPC timeout"); };
    await assert.rejects(m.runResync('megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE"'), /may still be resyncing/);
    assert.equal(seen.length, 1); assert.equal(calls.length, n);
    // no answer and the node gone: reset BEFORE it is started again
    seen.length = 0; n = calls.length; m.rpc = async () => { calls.proc.emit("exit", 1, null); throw new Error("socket hang up"); };
    await assert.rejects(m.runResync('megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE"'), /result is not known/);
    assert.deepEqual(seen.map(x => [x.proc, x.javas]), [[false, n]]); assert.equal(calls.length, n + 1);
    // a reset that fails does not stop the node from coming back, and is said in the log
    answers(); m.onWalletReplaced = async () => { throw new Error("Dexicon: store busy"); }; n = calls.length;
    assert.equal((await m.runResync('megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE"')).status, true);
    assert.equal(calls.length, n + 1); assert.ok(m.logs.some(l => /WALLET REPLACED, but not every old store could be set aside: Dexicon: store busy/.test(l)));
  } finally { m.onWalletReplaced = null; calls.restore(); }
});

// ---- 0.18.116: the stores are set aside only when the wallet IS another one; the engines are held meanwhile ----
const PHRASE = 'megammrsync action:resync host:megammr.example:9001 phrase:"ONE TWO THREE"';
/** A node whose wallet is w.seed (null: it cannot be read), an event list, and the three hooks. sync(w, ev) answers megammrsync. */
function walletNode(m, calls, sync) {
  const w = { seed: "A" }, ev = [];
  m.rpc = async (c) => {
    if (c === "quit") { setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true }; }
    if (/^seedrandom /.test(c)) { if (w.seed === null) return { status: false, error: "locked" }; return { status: true, response: { seedrandom: "0x" + require("crypto").createHash("sha256").update(w.seed).digest("hex") } }; }
    if (/^megammrsync/.test(c)) { ev.push("sent"); return sync(w, ev); }
    return { status: true, response: {} };
  };
  m.onEnginesHold = async () => { ev.push("hold"); }; m.onEnginesRelease = () => { ev.push("release"); };
  m.onWalletReplaced = async () => { ev.push("replaced:" + m.state); };
  return { w, ev };
}
async function resyncCase(sync, body) {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m);
  try { await m.start(); m.state = "running"; await body(m, calls, walletNode(m, calls, sync)); }
  finally { m.onWalletReplaced = m.onEnginesHold = m.onEnginesRelease = null; m.walletCheck = null; calls.restore(); }
}
test("0.18.116: the same wallet restored again keeps every store; the engines are stopped before the command and released after the restart", async () => {
  await resyncCase(() => ({ status: true, response: {} }), async (m, calls, { ev }) => {
    assert.equal((await m.runResync(PHRASE)).status, true);
    assert.deepEqual(ev, ["hold", "sent"], "held before the command; nothing decided while the node is down"); assert.equal(calls.length, 2);
    calls.realHealth(); m.startHealth(); await new Promise(r => setTimeout(r, 50));   // the health poll, as the app runs it
    assert.deepEqual(ev, ["hold", "sent", "release"], "no store set aside"); assert.equal(m.walletCheck, null); assert.equal(m.state, "running");
  });
});
test("0.18.116: another wallet after a restore: the stores are set aside before the node is called running, with the engines held", async () => {
  await resyncCase((w) => { w.seed = "B"; return { status: true, response: {} }; }, async (m, calls, { ev }) => {
    await m.runResync(PHRASE);
    calls.realHealth(); m.startHealth(); await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(ev, ["hold", "sent", "replaced:starting", "release"]); assert.equal(m.state, "running");
  });
});
test("0.18.116: RPC timed out, wallet unchanged: nothing is set aside, the engines go on; when the node swaps later they are held and the stores set aside", async () => {
  await resyncCase(() => { throw new Error("RPC timeout"); }, async (m, calls, { w, ev }) => {
    await assert.rejects(m.runResync(PHRASE), /may still be resyncing/);
    assert.deepEqual(ev, ["hold", "sent", "release"]); assert.ok(m.walletCheck, "the check stays owed: the node may still swap");
    assert.equal(await m.walletSettle(), true); assert.deepEqual(ev, ["hold", "sent", "release"], "asked again, still the same wallet");
    w.seed = "B";
    await m.walletSettle();
    assert.deepEqual(ev.slice(3), ["hold", "replaced:running", "release"]); assert.equal(m.walletCheck, null);
  });
});
test("0.18.116: RPC failed after the swap (node still there): the stores are set aside, the engines never released in between", async () => {
  await resyncCase((w) => { w.seed = "B"; throw new Error("socket hang up"); }, async (m, calls, { ev }) => {
    await assert.rejects(m.runResync(PHRASE), /may still be resyncing/);
    assert.deepEqual(ev, ["hold", "sent", "replaced:running", "release"]);
  });
});
test("0.18.116: the node died before it answered: started again, and decided from the wallet it then holds (same: untouched; another: set aside; unreadable: held, nothing moved)", async () => {
  for (const [after, want] of [["A", ["release"]], ["B", ["replaced:starting", "release"]]]) {
    await resyncCase((w) => { w.seed = after; calls0.proc.emit("exit", 1, null); throw new Error("socket hang up"); }, async (m, calls, { ev }) => {
      calls0 = calls;
      await assert.rejects(m.runResync(PHRASE), /result is not known/);
      assert.deepEqual(ev, ["hold", "sent"]); assert.equal(calls.length, 2);
      assert.equal(await m.walletSettle(), true);
      assert.deepEqual(ev.slice(2), want);
    });
  }
  await resyncCase((w) => { w.seed = null; calls0.proc.emit("exit", 1, null); throw new Error("socket hang up"); }, async (m, calls, { w, ev }) => {
    calls0 = calls;
    await assert.rejects(m.runResync(PHRASE), /result is not known/);
    assert.equal(await m.walletSettle(), false, "not readable: the node is not called running yet");
    assert.deepEqual(ev, ["hold", "sent"], "nothing guessed: no store moved, no engine started");
    for (let i = 0; i < 6; i++) await m.walletSettle();
    assert.equal(await m.walletSettle(), true, "the node is not held back for ever"); assert.deepEqual(ev, ["hold", "sent"], "but the engines stay stopped");
    assert.ok(m.logs.some(l => /cannot be identified after the restore/.test(l)));
    w.seed = "A"; await m.walletSettle();
    assert.deepEqual(ev, ["hold", "sent", "release"]);
  });
});
let calls0 = null;
test("0.18.116: a refused command on an unchanged wallet moves nothing and releases the engines; engines that cannot be stopped mean the command is not sent", async () => {
  await resyncCase(() => ({ status: false, error: "Could not connect to host" }), async (m, calls, { ev }) => {
    assert.equal((await m.runResync(PHRASE)).status, false);
    assert.deepEqual(ev, ["hold", "sent", "release"]); assert.equal(m.walletCheck, null);
    ev.length = 0; m.onEnginesHold = async () => { throw new Error("AtomiX busy"); };
    await assert.rejects(m.runResync(PHRASE), /could not be stopped \(AtomiX busy\).*Nothing was changed/);
    assert.deepEqual(ev, ["release"], "never sent");
    // a chain-only resync holds nothing
    ev.length = 0; m.onEnginesHold = async () => { ev.push("hold"); };
    await m.runResync("megammrsync action:resync host:megammr.example:9001");
    assert.deepEqual(ev, ["sent"]);
  });
});

test("0.18.116: main.js holds and releases all three trading engines", () => {
  const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8");
  const hold = /node\.onEnginesHold = [^\n]+/.exec(main)[0], rel = /node\.onEnginesRelease = [^\n]+/.exec(main)[0];
  for (const e of ["atomix", "pandapools", "dexicon"]) { assert.ok(hold.includes(e + ".hold()"), e + " held"); assert.ok(rel.includes(e + ".release()"), e + " released"); }
});

test("0.18.117: the engines finish what they have at the node before the node is told to quit", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true });
  const m = manager(true), calls = fakeJava(m), ev = [];
  try {
    await m.start(); m.state = "running";
    m.rpc = async (c) => { ev.push(c); if (c === "quit") setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true }; };
    m.onStopping = async () => { ev.push("draining:" + m.state); await new Promise(r => setTimeout(r, 60)); ev.push("drained"); };
    await m.stop();
    assert.deepEqual(ev, ["draining:stopping", "drained", "quit"]);
    const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8"), line = /node\.onStopping = [^\n]+/.exec(main)[0];
    for (const e of ["dexicon.stop()", "atomix.quiet(", "pandapools.quiet("]) assert.ok(line.includes(e), e);
  } finally { m.onStopping = null; calls.restore(); }
});

test("M2: the restart is refused like any start when the start command is wrong; a refused or unanswered megammrsync restarts nothing", async () => {
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "parlons", setupDone: true, walletDone: true });
  const m = manager(true); let calls = fakeJava(m);
  await m.start();
  writeConfig(Object.assign(stored(), { extraArgs: "-blockaskeyuses" }));   // behind the app's back, while the node runs
  m.rpc = async (c) => { setImmediate(() => calls.proc.emit("exit", 0, null)); return { status: true, response: {} }; };
  await m.runResync("megammrsync action:resync host:megammr.example:9001");
  assert.equal(calls.length, 1, "no second java"); assert.equal(m.state, "error"); assert.ok(/-blockaskeyuses/.test(m.lastError), m.lastError);
  calls.restore();
  // the node says no: it is left running
  freshInstall(); config.recordKeyMode("classic"); config.save({ nodeKind: "minima", setupDone: true, walletDone: true });
  calls = fakeJava(m); await m.start();
  m.rpc = async () => ({ status: false, error: "Could not connect to host" });
  assert.equal((await m.runResync("megammrsync action:resync host:megammr.example:9001")).status, false);
  assert.equal(calls.length, 1); assert.ok(m.proc, "still the same node"); assert.equal(m.snapshot().resyncing, false);
  // no answer and the node still there: nothing is restarted over a resync that may still be running
  m.rpc = async () => { throw new Error("RPC timeout"); };
  await assert.rejects(m.runResync("megammrsync action:resync host:megammr.example:9001"), /may still be resyncing/);
  assert.equal(calls.length, 1); assert.ok(m.proc);
  // no answer and the node gone: started again, and the unknown result is said
  m.rpc = async () => { calls.proc.emit("exit", 1, null); throw new Error("socket hang up"); };
  await assert.rejects(m.runResync("megammrsync action:resync host:megammr.example:9001"), /result is not known\. It was started again/);
  assert.equal(calls.length, 2);
  calls.restore();
});
