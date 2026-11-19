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
  assert.deepEqual(keymode.startFlags("block"), ["-blockaskeyuses", "-lowram"]);
  for (const supported of [true, false]) {
    assert.equal(keymode.startProblem({ mode: "classic", supported, folderMode: "classic" }), "", "a classic wallet starts on either jar");
    assert.equal(keymode.startProblem({ mode: "classic", supported, folderMode: "" }), "");
    assert.ok(keymode.startProblem({ mode: "", supported }), "no recorded mode: no start");
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "block" }), "a classic install pointed at a block wallet's folder");
    assert.ok(keymode.startProblem({ mode: "block", supported, folderMode: "classic" }), "a block install pointed at a classic wallet's folder");
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "classic", extraArgs: "-txpowdbstore 3 -lowram" }));
    assert.ok(keymode.startProblem({ mode: "classic", supported, folderMode: "classic", confText: "blockaskeyuses=true" }), "a -conf file may not set it either");
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
    if (nodeKind === "minima") assert.ok(args.includes("-blockaskeyuses") && args.includes("-lowram"));
    else assert.ok(/^-Dparlons\.node\.args=.* -blockaskeyuses -lowram/.test(args.find(a => a.startsWith("-Dparlons.node.args="))), "inside the Parlons Node's one argument string");
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
